import { describe, expect, test } from 'bun:test';
import { getAddressDecoder, type Address } from '@solana/kit';
import { collectMints, enrichMints } from '../../src/scan/enrich.ts';
import { PROGRAM_IDS, type InstructionRecord, type ParsedInstruction, type TokenAccountView } from '../../src/solana/types.ts';
import type { BalanceChange } from '../../src/scan/types.ts';
import { createFakeClusterRpcs, fakeAccount, withContext } from '../helpers/fake-rpc.ts';

const addr = (n: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const TOKEN = PROGRAM_IDS.splToken as Address;

const rec = (parsed: ParsedInstruction, i = 0): InstructionRecord => ({
  programAddress: TOKEN,
  topLevelIndex: i,
  inner: false,
  stackHeight: 1,
  parsed,
});

const view = (a: Address, mint: Address): TokenAccountView => ({
  address: a,
  program: 'spl-token',
  mint,
  owner: addr(1),
  amount: 0n,
});

describe('collectMints', () => {
  const [M1, M2, M3, M4, M5] = [addr(41), addr(42), addr(43), addr(44), addr(45)] as const;
  const [T1, T2, T3] = [addr(51), addr(52), addr(53)] as const;
  const W = addr(1);

  test('instruction mints, then referenced token account mints, then balance-change mints; deduped in order', () => {
    const preTokens = new Map([
      [T1, view(T1, M2)],
      [T2, view(T2, M3)],
      [T3, view(T3, M1)],
    ]);
    const records = [
      rec({ kind: 'ata-create', wallet: W, ata: T1, mint: M1, tokenProgram: TOKEN }),
      rec({ kind: 'token-transfer', program: 'spl-token', source: T1, destination: T2, authority: W, amount: 1n, variant: 'transfer' }),
      rec({ kind: 'token-approve', program: 'spl-token', source: T2, delegate: W, owner: W, amount: 1n }),
      rec({ kind: 'token-close', program: 'spl-token', account: T3, destination: W, authority: W }),
      rec({ kind: 'token-mint-to', program: 'spl-token', mint: M1, account: T1, amount: 1n }),
      rec({ kind: 'system-transfer', source: W, destination: W, lamports: 1n }),
      rec({ kind: 'token-set-authority', program: 'spl-token', target: addr(99), currentAuthority: W, authorityType: 'mint', newAuthority: null }),
      rec({ kind: 'token-burn', program: 'spl-token', mint: M4, account: T1, amount: 1n }),
    ];
    const changes: BalanceChange[] = [
      { asset: { kind: 'sol' }, rawDelta: -1n, decimals: 9, pre: 1n, post: 0n },
      { asset: { kind: 'token', mint: M2 }, rawDelta: -1n, decimals: 6, pre: 1n, post: 0n },
      { asset: { kind: 'token', mint: M5 }, rawDelta: 1n, decimals: 'unknown', pre: 0n, post: 1n },
    ];
    expect(collectMints(records, preTokens, changes)).toEqual([M1, M2, M3, M4, M5]);
  });

  test('explicit mint field wins over the token account lookup; unknown accounts are skipped', () => {
    const preTokens = new Map([[T1, view(T1, M2)]]);
    const records = [
      rec({ kind: 'token-transfer', program: 'spl-token', source: T1, destination: T2, authority: W, amount: 1n, mint: M3, variant: 'checked' }),
      rec({ kind: 'token-approve', program: 'spl-token', source: T3, delegate: W, owner: W, amount: 1n }),
      rec({ kind: 'token-transfer', program: 'spl-token', source: T3, destination: T1, authority: W, amount: 1n, variant: 'transfer' }),
    ];
    expect(collectMints(records, preTokens, [])).toEqual([M3, M2]);
  });
});

describe('enrichMints', () => {
  const mintData = (decimals: number) => {
    const d = new Uint8Array(82);
    d[44] = decimals;
    d[45] = 1;
    return d;
  };

  test('one getMultipleAccounts call (base64); decodes ok and unreadable mints', async () => {
    const [M1, M2, M3] = [addr(41), addr(42), addr(43)];
    const { rpcs, calls } = createFakeClusterRpcs({
      devnet: [
        {
          method: 'getMultipleAccounts',
          reply: {
            result: withContext([
              fakeAccount({ owner: TOKEN, data: mintData(6) }),
              null,
              fakeAccount({ owner: PROGRAM_IDS.system, data: mintData(6) }),
            ]),
          },
        },
      ],
    });
    const out = await enrichMints([M1, M2, M3], 'devnet', { rpcs });
    expect(calls.devnet).toHaveLength(1);
    expect(calls.devnet[0]?.params[0]).toEqual([M1, M2, M3]);
    expect(calls.devnet[0]?.params[1]).toMatchObject({ encoding: 'base64' });
    expect(out).toEqual(
      new Map([
        [M1, { status: 'ok', address: M1, program: 'spl-token', decimals: 6, permanentDelegate: null }],
        [M2, { status: 'unreadable', address: M2 }],
        [M3, { status: 'unreadable', address: M3 }],
      ]),
    );
  });

  test('RPC error → every mint unreadable', async () => {
    const mints = [addr(41), addr(42)];
    const { rpcs } = createFakeClusterRpcs([{ method: 'getMultipleAccounts', reply: { status: 500 } }]);
    const out = await enrichMints(mints, 'mainnet', { rpcs });
    expect([...out.values()]).toEqual(mints.map((m) => ({ status: 'unreadable', address: m })));
  });

  test('schema failure → every mint unreadable', async () => {
    const mints = [addr(41), addr(42)];
    const { rpcs } = createFakeClusterRpcs([{ method: 'getMultipleAccounts', reply: { result: withContext([null]) } }]);
    const out = await enrichMints(mints, 'mainnet', { rpcs });
    expect([...out.values()]).toEqual(mints.map((m) => ({ status: 'unreadable', address: m })));
  });

  test('no mints → no RPC call', async () => {
    const { rpcs, calls } = createFakeClusterRpcs([]);
    expect((await enrichMints([], 'mainnet', { rpcs })).size).toBe(0);
    expect(calls.mainnet).toHaveLength(0);
  });

  test('more than 100 mints are read in chunks of 100', async () => {
    const mints = Array.from({ length: 130 }, (_, i) => addr(i + 2));
    const { rpcs, calls } = createFakeClusterRpcs([
      {
        method: 'getMultipleAccounts',
        match: (p) => (p[0] as unknown[]).length === 100,
        reply: { result: withContext(Array(100).fill(null)) },
      },
      { method: 'getMultipleAccounts', reply: { result: withContext(Array(30).fill(null)) } },
    ]);
    const out = await enrichMints(mints, 'mainnet', { rpcs });
    expect(out.size).toBe(130);
    expect(calls.mainnet.map((c) => (c.params[0] as unknown[]).length)).toEqual([100, 30]);
  });
});
