/**
 * Simulator (Req 7.2–7.10). Reads pre-state, then makes exactly one
 * `simulateTransaction` call with `sigVerify: false`. The transaction is never
 * signed or sent; this module has no signing or sending code paths.
 */
import { type Address, type Base64EncodedWireTransaction, getBase64Encoder } from '@solana/kit';
import type { BalanceSnapshot } from '../risk/types.ts';
import { type BalanceChange, type Cluster, type SimError, type Untrusted, untrusted } from '../scan/types.ts';
import { parseInner } from './inner-instructions.ts';
import { isScannerRpcError } from './rpc.ts';
import { type AccountInfo, MultipleAccountsResultSchema, SimulateResultSchema } from './schemas.ts';
import { decodeTokenAccount } from './token-accounts.ts';
import type {
  AccountSnapshot,
  ClusterRpcs,
  DecodedTransaction,
  ScannerRpc,
  SimulationOutcome,
  TokenAccountView,
} from './types.ts';

/** getMultipleAccounts accepts at most 100 addresses per call. */
export const ACCOUNTS_CHUNK_SIZE = 100;
const SOL_DECIMALS = 9;
const IDENTIFIER_RE = /^[A-Za-z]{1,64}$/;
const U32_MAX = 2 ** 32 - 1;

type UnavailableReason = Extract<SimulationOutcome, { status: 'unavailable' }>['reason'];

/** Internal: a response that failed schema or shape checks. */
class InvalidResponse extends Error {}

const dedupe = <T>(items: T[]): T[] => [...new Set(items)];

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function toSnapshot(info: AccountInfo | null): AccountSnapshot {
  if (info === null) return { exists: false };
  let data: Uint8Array;
  try {
    data = new Uint8Array(getBase64Encoder().encode(info.data[0]));
  } catch {
    throw new InvalidResponse();
  }
  return { exists: true, owner: info.owner, lamports: BigInt(info.lamports), data };
}

function reasonOf(e: unknown): UnavailableReason {
  if (e instanceof InvalidResponse) return 'invalid-response';
  if (isScannerRpcError(e)) {
    switch (e.code) {
      case 'RPC_TIMEOUT':
        return 'timeout';
      case 'RPC_RATE_LIMITED':
        return 'rate-limited';
      case 'RPC_INVALID_RESPONSE':
        return 'invalid-response';
      default:
        return 'rpc-error';
    }
  }
  // JSON-RPC error objects (SolanaError), aborts, anything else.
  return 'rpc-error';
}

/**
 * `getMultipleAccounts` (base64, confirmed) in chunks of 100. Throws
 * ScannerRpcError / InvalidResponse; the result preserves `addresses` order.
 */
export async function readAccounts(rpc: ScannerRpc, addresses: Address[]): Promise<Map<Address, AccountSnapshot>> {
  const unique = dedupe(addresses);
  const out = new Map<Address, AccountSnapshot>();
  const parts = chunk(unique, ACCOUNTS_CHUNK_SIZE);
  const results = await Promise.all(
    parts.map((part) => rpc.getMultipleAccounts(part, { encoding: 'base64', commitment: 'confirmed' }).send()),
  );
  results.forEach((raw, p) => {
    const part = parts[p] ?? [];
    const parsed = MultipleAccountsResultSchema.safeParse(raw);
    if (!parsed.success || parsed.data.value.length !== part.length) throw new InvalidResponse();
    part.forEach((a, i) => out.set(a, toSnapshot(parsed.data.value[i] ?? null)));
  });
  return out;
}

/** Token accounts in pre-state, keyed by token account address (Req 7.3). */
export function preTokenAccounts(pre: Map<Address, AccountSnapshot>): Map<Address, TokenAccountView> {
  const out = new Map<Address, TokenAccountView>();
  for (const [a, snap] of pre) {
    const view = decodeTokenAccount(a, snap);
    if (view !== null) out.set(a, view);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Error normalization (Req 7.10)
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Kit upcasts most response integers to bigint; accept both. */
function smallInt(v: unknown, max: number): number | undefined {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max) return v;
  if (typeof v === 'bigint' && v >= 0n && v <= BigInt(max)) return Number(v);
  return undefined;
}

const identifier = (v: unknown): string | undefined =>
  typeof v === 'string' && IDENTIFIER_RE.test(v) ? v : undefined;

/** Single-key object → [key, value]; anything else → undefined. */
function soleEntry(v: unknown): [string, unknown] | undefined {
  if (!isObj(v)) return undefined;
  const keys = Object.keys(v);
  if (keys.length !== 1) return undefined;
  const k = keys[0] as string;
  return [k, v[k]];
}

const PROGRAM_NOT_FOUND_NAMES = new Set(['ProgramAccountNotFound', 'InvalidProgramForExecution']);
/**
 * Log lines the runtime prints when an invoked program does not exist:
 * "Program X is not deployed", "... program not found", and the
 * ProgramAccountNotFound message "Attempt to load a program that does not exist".
 */
const PROGRAM_NOT_FOUND_LOGS = [
  /\bProgram \S+ is not deployed\b/,
  /\bprogram not found\b/i,
  /\bAttempt to load a program that does not exist\b/i,
];

/**
 * Keeps only an identifier, a numeric instruction index and a numeric custom
 * code; every other part of the error value is dropped.
 *
 * - `"AccountNotFound"` → name AccountNotFound
 * - `{ InstructionError: [1, { Custom: 6001 }] }` → name InstructionError, index 1, code 6001
 * - `{ InstructionError: [0, "InvalidAccountData"] }` → name InvalidAccountData, index 0
 * - `{ InstructionError: [0, { BorshIoError: "…" }] }` → name BorshIoError, index 0
 * - `{ InsufficientFundsForRent: { account_index: 2 } }` → name InsufficientFundsForRent
 * - anything else → UnknownError
 */
export function normalizeSimError(err: unknown, logs: readonly string[] = []): SimError {
  let name: string | undefined;
  let instructionIndex: number | undefined;
  let customCode: number | undefined;

  if (typeof err === 'string') {
    name = identifier(err);
  } else {
    const entry = soleEntry(err);
    if (entry !== undefined) {
      const [key, value] = entry;
      name = identifier(key);
      if (key === 'InstructionError' && Array.isArray(value) && value.length === 2) {
        instructionIndex = smallInt(value[0], U32_MAX);
        const inner = value[1];
        if (typeof inner === 'string') {
          name = identifier(inner) ?? name;
        } else {
          const innerEntry = soleEntry(inner);
          if (innerEntry !== undefined) {
            const [innerKey, innerValue] = innerEntry;
            if (innerKey === 'Custom') customCode = smallInt(innerValue, U32_MAX);
            else name = identifier(innerKey) ?? name;
          }
        }
      }
    }
  }

  const finalName = name ?? 'UnknownError';
  const programNotFound =
    PROGRAM_NOT_FOUND_NAMES.has(finalName) || logs.some((l) => PROGRAM_NOT_FOUND_LOGS.some((re) => re.test(l)));
  return {
    name: finalName,
    ...(instructionIndex !== undefined ? { instructionIndex } : {}),
    ...(customCode !== undefined ? { customCode } : {}),
    programNotFound,
  };
}

// ---------------------------------------------------------------------------
// simulate
// ---------------------------------------------------------------------------

export async function simulate(
  tx: DecodedTransaction,
  cluster: Cluster,
  subject: Address,
  deps: { rpcs: ClusterRpcs },
): Promise<SimulationOutcome> {
  const rpc = deps.rpcs[cluster];
  const programs = new Set<Address>(tx.instructions.map((ix) => ix.programAddress));
  const resolved = tx.accountList.flatMap((r) => (r.kind === 'resolved' ? [r] : []));

  // 1. Pre-state (Req 7.2).
  let pre: Map<Address, AccountSnapshot>;
  try {
    pre = await readAccounts(rpc, [subject, ...resolved.filter((r) => !programs.has(r.address)).map((r) => r.address)]);
  } catch (e) {
    return { status: 'unavailable', reason: reasonOf(e) };
  }

  // 2. One simulateTransaction call (Req 7.3).
  const tokenAccounts = [...preTokenAccounts(pre).keys()];
  const absentWritable = resolved
    .filter((r) => r.writable && pre.get(r.address)?.exists === false)
    .map((r) => r.address);
  const addresses = dedupe([subject, ...tokenAccounts, ...absentWritable]);

  let raw: unknown;
  try {
    raw = await rpc
      .simulateTransaction(tx.wireBase64 as Base64EncodedWireTransaction, {
        encoding: 'base64',
        sigVerify: false,
        replaceRecentBlockhash: true,
        innerInstructions: true,
        commitment: 'confirmed',
        accounts: { encoding: 'base64', addresses },
      })
      .send();
  } catch (e) {
    return { status: 'unavailable', reason: reasonOf(e), pre };
  }

  const parsed = SimulateResultSchema.safeParse(raw);
  if (!parsed.success) return { status: 'unavailable', reason: 'invalid-response', pre };
  const value = parsed.data.value;
  const rawLogs = value.logs ?? [];
  const logs: Untrusted[] = rawLogs.map(untrusted);

  // 4. Failure: sanitized error, logs kept as Untrusted, inner dropped (Req 7.10).
  if (value.err !== null && value.err !== undefined) {
    return { status: 'failed', pre, error: normalizeSimError(value.err, rawLogs), logs };
  }

  // 3. Success.
  const returned = value.accounts;
  if (returned === null || returned.length !== addresses.length) {
    return { status: 'unavailable', reason: 'invalid-response', pre };
  }
  const post = new Map<Address, AccountSnapshot>();
  try {
    addresses.forEach((a, i) => post.set(a, toSnapshot(returned[i] ?? null)));
  } catch {
    return { status: 'unavailable', reason: 'invalid-response', pre };
  }

  const inner = parseInner(value.innerInstructions ?? [], tx.accountList);
  if (!Array.isArray(inner)) return { status: 'unavailable', reason: 'invalid-response', pre };

  return {
    status: 'ok',
    pre,
    post,
    inner,
    logs,
    ...(value.unitsConsumed !== undefined ? { unitsConsumed: BigInt(value.unitsConsumed) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Balances (Req 7.4, 7.9)
// ---------------------------------------------------------------------------

type MintTotals = { mint: Address; pre: bigint; post: bigint };

const lamportsOf = (s: AccountSnapshot | undefined): bigint => (s?.exists ? s.lamports : 0n);

/**
 * Per-mint totals of the subject's token accounts. Each side counts an account
 * only if it decodes as a token account owned by the subject on that side, so a
 * closed account (post `exists: false`) or an owner change counts as 0 after.
 * An account missing from `post` entirely was not observed and is treated as
 * unchanged.
 */
function tokenTotals(
  pre: Map<Address, AccountSnapshot>,
  post: Map<Address, AccountSnapshot>,
  subject: Address,
): MintTotals[] {
  const totals = new Map<Address, MintTotals>();
  const entry = (mint: Address): MintTotals => {
    let t = totals.get(mint);
    if (t === undefined) {
      t = { mint, pre: 0n, post: 0n };
      totals.set(mint, t);
    }
    return t;
  };
  const keys = dedupe([...pre.keys(), ...post.keys()]);
  for (const a of keys) {
    const preSnap = pre.get(a);
    const postSnap = post.has(a) ? post.get(a) : preSnap;
    const before = preSnap === undefined ? null : decodeTokenAccount(a, preSnap);
    const after = postSnap === undefined ? null : decodeTokenAccount(a, postSnap);
    if (before !== null && before.owner === subject) entry(before.mint).pre += before.amount;
    if (after !== null && after.owner === subject) entry(after.mint).post += after.amount;
  }
  return [...totals.values()];
}

function solTotals(pre: Map<Address, AccountSnapshot>, post: Map<Address, AccountSnapshot>, subject: Address) {
  const before = lamportsOf(pre.get(subject));
  const after = post.has(subject) ? lamportsOf(post.get(subject)) : before;
  return { pre: before, post: after };
}

/** Pure. SOL first, then mints in first-seen order; zero deltas omitted. */
export function computeBalanceChanges(
  pre: Map<Address, AccountSnapshot>,
  post: Map<Address, AccountSnapshot>,
  subject: Address,
  mintDecimals: Map<Address, number>,
): BalanceChange[] {
  const out: BalanceChange[] = [];
  const sol = solTotals(pre, post, subject);
  if (sol.post !== sol.pre) {
    out.push({ asset: { kind: 'sol' }, rawDelta: sol.post - sol.pre, decimals: SOL_DECIMALS, ...sol });
  }
  for (const t of tokenTotals(pre, post, subject)) {
    if (t.post === t.pre) continue;
    out.push({
      asset: { kind: 'token', mint: t.mint },
      rawDelta: t.post - t.pre,
      decimals: mintDecimals.get(t.mint) ?? 'unknown',
      pre: t.pre,
      post: t.post,
    });
  }
  return out;
}

/** Risk_Engine input for the drain rule; includes zero-delta mints. */
export function toBalanceSnapshot(
  pre: Map<Address, AccountSnapshot>,
  post: Map<Address, AccountSnapshot>,
  subject: Address,
  mintDecimals: Map<Address, number>,
): BalanceSnapshot {
  return {
    sol: solTotals(pre, post, subject),
    tokens: tokenTotals(pre, post, subject).map((t) => {
      const decimals = mintDecimals.get(t.mint);
      return decimals === undefined ? t : { ...t, decimals };
    }),
  };
}
