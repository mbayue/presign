/**
 * Shared harness for the end-to-end pipeline fixture tests (task 16.5) and the
 * CLI tests (task 18.3). Nothing here touches the network:
 *
 * - RPC: an account-table transport. `getMultipleAccounts` answers each
 *   requested address from the fixture's `preAccounts`; `simulateTransaction`
 *   answers `accounts.addresses` from the fixture's post-state, in request
 *   order, as the real RPC does. Any other method, or any mainnet call, throws.
 * - HTTP: `demo/server.ts`'s `handleDemoRequest` wrapped as `fetch` (the
 *   127.0.0.1:8787 origin is on the dev allowlist, so no DNS lookup), or a
 *   route table from test/helpers/fake-http.ts.
 *
 * Fixture JSON names accounts symbolically: `$subject`, `$subjectAta`,
 * `$attacker`, `$safeRecipient`, `$usdcMint`. Owners may be `system` or `spl-token`.
 */
import { getAddMemoInstruction } from '@solana-program/memo';
import { getTransferSolInstruction } from '@solana-program/system';
import {
  AccountState,
  findAssociatedTokenPda,
  getApproveInstruction,
  getMintEncoder,
  getTokenEncoder,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createSolanaRpcFromTransport,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  type Instruction,
  pipe,
  type RpcTransport,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { handleDemoRequest } from '../../../demo/server.ts';
import { DEMO } from '../../../demo/transactions.ts';
import type { AiDeps } from '../../../src/ai/explainer.ts';
import { classifyCliInput } from '../../../src/cli/scan.ts';
import { type Config, parseConfig } from '../../../src/config.ts';
import type { ActionsJsonResolver, SafeFetchDeps } from '../../../src/fetch/types.ts';
import { createPipelineDeps, type PipelineDeps } from '../../../src/scan/pipeline.ts';
import type { Cluster, ScanInput } from '../../../src/scan/types.ts';
import { PROGRAM_IDS } from '../../../src/solana/types.ts';
import type { RecordedRequest } from '../../helpers/fake-http.ts';
import { createFakeResolve } from '../../helpers/fake-http.ts';
import { fakeAccount, type FakeRpcCall, withContext } from '../../helpers/fake-rpc.ts';

// ---------------------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------------------

type DataSpec =
  | {
      kind: 'token-account';
      mint: string;
      owner: string;
      amount: string;
      delegate?: string;
      delegatedAmount?: string;
    }
  | { kind: 'mint'; decimals: number; supply: string };

export type AccountSpec = { owner: string; lamports: number; data?: DataSpec };

export interface RpcFixture {
  description: string;
  preAccounts: Record<string, AccountSpec>;
  simulateTransaction: {
    err: unknown;
    logs: string[];
    fee: number | null;
    unitsConsumed: number;
    /** null → the RPC returns `accounts: null` (failed simulation). */
    accounts: Record<string, AccountSpec> | null;
  };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export function defaultConfig(): Config {
  const parsed = parseConfig({});
  if ('errors' in parsed) throw new Error('parseConfig({}) failed');
  return parsed.config;
}

/** The default placeholder, `Hzhu1o57ZuQaPJdHMqbG2aKWHcuJNWARvQMzydsFWKK7`. */
export const SUBJECT: Address = defaultConfig().placeholderAccount;

export type Names = {
  subject: Address;
  subjectAta: Address;
  attacker: Address;
  safeRecipient: Address;
  usdcMint: Address;
};

export async function fixtureNames(subject: Address = SUBJECT): Promise<Names> {
  const [subjectAta] = await findAssociatedTokenPda({ owner: subject, mint: DEMO.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return { subject, subjectAta, attacker: DEMO.attacker, safeRecipient: DEMO.safeRecipient, usdcMint: DEMO.mint };
}

function resolveName(name: string, names: Names): Address {
  if (!name.startsWith('$')) return address(name);
  const key = name.slice(1) as keyof Names;
  const a = names[key];
  if (a === undefined) throw new Error(`pipeline fixture: unknown name ${name}`);
  return a;
}

function resolveOwner(owner: string, names: Names): Address {
  if (owner === 'system') return PROGRAM_IDS.system as Address;
  if (owner === 'spl-token') return TOKEN_PROGRAM_ADDRESS;
  return resolveName(owner, names);
}

function encodeData(spec: DataSpec | undefined, names: Names): Uint8Array {
  if (spec === undefined) return new Uint8Array(0);
  if (spec.kind === 'mint') {
    return new Uint8Array(
      getMintEncoder().encode({
        mintAuthority: null,
        supply: BigInt(spec.supply),
        decimals: spec.decimals,
        isInitialized: true,
        freezeAuthority: null,
      }),
    );
  }
  return new Uint8Array(
    getTokenEncoder().encode({
      mint: resolveName(spec.mint, names),
      owner: resolveName(spec.owner, names),
      amount: BigInt(spec.amount),
      delegate: spec.delegate === undefined ? null : resolveName(spec.delegate, names),
      state: AccountState.Initialized,
      isNative: null,
      delegatedAmount: BigInt(spec.delegatedAmount ?? '0'),
      closeAuthority: null,
    }),
  );
}

type RpcAccount = ReturnType<typeof fakeAccount>;

function accountTable(specs: Record<string, AccountSpec>, names: Names): Map<string, RpcAccount> {
  const out = new Map<string, RpcAccount>();
  for (const [name, spec] of Object.entries(specs)) {
    out.set(
      resolveName(name, names),
      fakeAccount({ owner: resolveOwner(spec.owner, names), lamports: spec.lamports, data: encodeData(spec.data, names) }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

export type TableRpcs = { rpcs: PipelineDeps['rpcs']; calls: Record<Cluster, FakeRpcCall[]> };

/**
 * Devnet answers from `fixture`; mainnet throws on any call. `extraLogs` are
 * appended to the simulated program logs (used for injected log lines).
 */
export function createTableRpcs(fixture: RpcFixture, names: Names, extraLogs: readonly string[] = []): TableRpcs {
  const pre = accountTable(fixture.preAccounts, names);
  const sim = fixture.simulateTransaction;
  const post = sim.accounts === null ? null : accountTable(sim.accounts, names);
  const calls: Record<Cluster, FakeRpcCall[]> = { mainnet: [], devnet: [] };

  const transport = (cluster: Cluster): RpcTransport =>
    (async ({ payload }: { payload: unknown }) => {
      const p = payload as { id?: unknown; method: string; params?: unknown[] };
      const params = p.params ?? [];
      calls[cluster].push({ method: p.method, params });
      if (cluster === 'mainnet') throw new Error(`pipeline harness: unexpected mainnet call ${p.method}`);
      const reply = (result: unknown) => ({ jsonrpc: '2.0', id: p.id ?? null, result });

      if (p.method === 'getMultipleAccounts') {
        const requested = params[0] as string[];
        return reply(withContext(requested.map((a) => pre.get(a) ?? null)));
      }
      if (p.method === 'simulateTransaction') {
        const cfg = params[1] as { accounts?: { addresses?: string[] } } | undefined;
        const requested = cfg?.accounts?.addresses ?? [];
        return reply(
          withContext({
            err: sim.err,
            logs: [...sim.logs, ...extraLogs],
            accounts: post === null ? null : requested.map((a) => post.get(a) ?? null),
            innerInstructions: sim.err === null ? [] : null,
            unitsConsumed: sim.unitsConsumed,
            fee: sim.fee,
            returnData: null,
            loadedAccountsDataSize: 0,
          }),
        );
      }
      throw new Error(`pipeline harness: unexpected RPC method ${p.method}`);
    }) as RpcTransport;

  return {
    rpcs: {
      mainnet: createSolanaRpcFromTransport(transport('mainnet')),
      devnet: createSolanaRpcFromTransport(transport('devnet')),
    },
    calls,
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** `handleDemoRequest` as the pipeline's `http.fetch`; records every request. */
export function createDemoHttp(): { http: SafeFetchDeps; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    requests.push({
      method: req.method,
      url: req.url,
      headers: Object.fromEntries(req.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return handleDemoRequest(req);
  }) as typeof fetch;
  return { http: { fetch: fetchFn, resolve: createFakeResolve() }, requests };
}

/** Demo links, as printed by the Demo_Server (`demoLinks()` order). */
export const DEMO_LINKS = {
  drainer: 'solana-action:http://127.0.0.1:8787/api/actions/drainer?cluster=devnet',
  safe: 'solana-action:http://127.0.0.1:8787/api/actions/safe?cluster=devnet',
  injection: 'solana-action:http://127.0.0.1:8787/api/actions/injection?cluster=devnet',
} as const;

/** A resolver that fails the test if link detection tries to probe a URL. */
export const noProbeResolver: ActionsJsonResolver = {
  resolve: async (url) => {
    throw new Error(`unexpected actions.json probe: ${url}`);
  },
};

export async function scanInputFor(link: string): Promise<ScanInput> {
  const c = await classifyCliInput(link, noProbeResolver);
  if (c.kind !== 'scan') throw new Error(`not scannable: ${link}`);
  return c.input;
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export function fixtureDeps(
  fixture: RpcFixture,
  names: Names,
  opts: { http?: SafeFetchDeps; ai?: AiDeps | null; extraLogs?: readonly string[] } = {},
): { deps: PipelineDeps; calls: TableRpcs['calls'] } {
  const { rpcs, calls } = createTableRpcs(fixture, names, opts.extraLogs);
  const http = opts.http ?? createDemoHttp().http;
  return { deps: createPipelineDeps(defaultConfig(), { rpcs, http, ai: opts.ai ?? null }), calls };
}

// ---------------------------------------------------------------------------
// Transactions with a memo (Req 19.8)
// ---------------------------------------------------------------------------

const DUMMY_LIFETIME = { blockhash: blockhash('11111111111111111111111111111111'), lastValidBlockHeight: 0n };

function toUnsignedBase64(account: Address, instructions: Instruction[]): string {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(createNoopSigner(account), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(DUMMY_LIFETIME, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

/** The demo drainer's Approve followed by a memo. */
export async function drainerWithMemo(account: Address, memo: string): Promise<string> {
  const [source] = await findAssociatedTokenPda({ owner: account, mint: DEMO.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return toUnsignedBase64(account, [
    getApproveInstruction({ source, delegate: DEMO.attacker, owner: createNoopSigner(account), amount: DEMO.approveAmount }),
    getAddMemoInstruction({ memo }),
  ]);
}

/** The demo safe tip followed by a memo. */
export function safeWithMemo(account: Address, memo: string): string {
  return toUnsignedBase64(account, [
    getTransferSolInstruction({ source: createNoopSigner(account), destination: DEMO.safeRecipient, amount: DEMO.safeLamports }),
    getAddMemoInstruction({ memo }),
  ]);
}
