import { describe, expect, test } from 'bun:test';
import { getTransferSolInstructionDataDecoder } from '@solana-program/system';
import { findAssociatedTokenPda, getTransferCheckedInstructionDataDecoder } from '@solana-program/token';
import { type Address, getAddressDecoder } from '@solana/kit';
import { decodeTransaction } from '../../src/solana/decoder.ts';
import { buildTransferTransaction } from '../../src/solana/transfer-builder.ts';
import { PROGRAM_IDS } from '../../src/solana/types.ts';
import type { Sleep, TransferRequest } from '../../src/scan/types.ts';
import { createFakeClusterRpcs, type FakeRoute, fakeAccount, withContext } from '../helpers/fake-rpc.ts';

const addr = (k: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(k));
const SUBJECT = addr(1);
const RECIPIENT = addr(2);
const MINT = addr(3);
const REF_A = addr(4);
const REF_B = addr(5);

const mintData = (decimals: number) => {
  const data = new Uint8Array(82);
  data[44] = decimals;
  data[45] = 1;
  return data;
};
const mintRoute = (owner: string, decimals = 6): FakeRoute => ({
  method: 'getAccountInfo',
  reply: { result: withContext(fakeAccount({ owner, data: mintData(decimals) })) },
});
const noTimeout: Sleep = (_ms, signal) =>
  new Promise<void>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));

const transfer = (p: Partial<TransferRequest>): TransferRequest => ({ type: 'transfer', recipient: RECIPIENT, references: [], ...p });

async function decodeBuilt(base64: string) {
  const { rpcs, calls } = createFakeClusterRpcs([]);
  const r = await decodeTransaction(base64, 'mainnet', { rpcs });
  if (!r.ok) throw new Error(r.error.detail);
  expect(calls.mainnet).toEqual([]);
  // Unsigned: every signature slot is 64 zero bytes.
  const wire = Buffer.from(base64, 'base64');
  expect(wire[0]).toBe(1);
  expect(wire.subarray(1, 65).every((b) => b === 0)).toBe(true);
  return r.tx;
}

const addresses = (refs: { kind: string; address?: Address }[]) => refs.map((a) => a.address);

describe('buildTransferTransaction: SOL', () => {
  test('builds a System transfer of amount x 10^9 lamports with the subject as fee payer', async () => {
    const { rpcs, calls } = createFakeClusterRpcs([]);
    const r = await buildTransferTransaction(transfer({ amount: { digits: 15n, scale: 1 } }), SUBJECT, 'mainnet', { rpcs });
    if (!r.ok) throw new Error(r.flag.ruleId);
    expect(r.amountUnspecified).toBe(false);
    expect(calls.mainnet).toEqual([]);
    const tx = await decodeBuilt(r.base64);
    expect(tx.version).toBe(0);
    expect(tx.feePayer).toBe(SUBJECT);
    expect(tx.instructions).toHaveLength(1);
    const ix = tx.instructions[0]!;
    expect(ix.programAddress).toBe(PROGRAM_IDS.system as Address);
    expect(addresses(ix.accounts)).toEqual([SUBJECT, RECIPIENT]);
    expect(getTransferSolInstructionDataDecoder().decode(ix.data).amount).toBe(1_500_000_000n);
  });

  test('memo goes directly before the transfer and references follow the required accounts', async () => {
    const { rpcs } = createFakeClusterRpcs([]);
    const memo = 'order #42 – café';
    const r = await buildTransferTransaction(transfer({ amount: { digits: 1n, scale: 0 }, memo, references: [REF_A, REF_B] }), SUBJECT, 'mainnet', { rpcs });
    if (!r.ok) throw new Error(r.flag.ruleId);
    const tx = await decodeBuilt(r.base64);
    const [memoIx, transferIx] = tx.instructions;
    expect(memoIx?.programAddress).toBe(PROGRAM_IDS.memoV2 as Address);
    expect(memoIx?.data).toEqual(new TextEncoder().encode(memo));
    expect(memoIx?.accounts).toEqual([]);
    expect(transferIx?.accounts).toEqual([
      { kind: 'resolved', address: SUBJECT, writable: true, signer: true },
      { kind: 'resolved', address: RECIPIENT, writable: true, signer: false },
      { kind: 'resolved', address: REF_A, writable: false, signer: false },
      { kind: 'resolved', address: REF_B, writable: false, signer: false },
    ]);
  });

  test('no amount builds a 0 lamport transfer marked amountUnspecified', async () => {
    const { rpcs } = createFakeClusterRpcs([]);
    const r = await buildTransferTransaction(transfer({}), SUBJECT, 'mainnet', { rpcs });
    if (!r.ok) throw new Error(r.flag.ruleId);
    expect(r.amountUnspecified).toBe(true);
    const tx = await decodeBuilt(r.base64);
    expect(getTransferSolInstructionDataDecoder().decode(tx.instructions[0]!.data).amount).toBe(0n);
  });

  test('amount above u64 is amount-overflow', async () => {
    const { rpcs } = createFakeClusterRpcs([]);
    const r = await buildTransferTransaction(transfer({ amount: { digits: 18_446_744_074n, scale: 0 } }), SUBJECT, 'mainnet', { rpcs });
    expect(r).toEqual({ ok: false, flag: { ruleId: 'TRANSFER_BUILD_FAILED', reason: 'amount-overflow' } });
  });

  test('oversized transaction is transaction-too-large', async () => {
    const { rpcs } = createFakeClusterRpcs([]);
    const r = await buildTransferTransaction(transfer({ memo: 'x'.repeat(1_100) }), SUBJECT, 'mainnet', { rpcs });
    expect(r).toEqual({ ok: false, flag: { ruleId: 'TRANSFER_BUILD_FAILED', reason: 'transaction-too-large' } });
  });
});

describe('buildTransferTransaction: SPL', () => {
  test('SPL Token mint with 6 decimals gives one TransferChecked between the derived ATAs', async () => {
    const { rpcs, calls } = createFakeClusterRpcs({ devnet: [mintRoute(PROGRAM_IDS.splToken, 6)] });
    const r = await buildTransferTransaction(
      transfer({ splToken: MINT, amount: { digits: 25n, scale: 1 }, references: [REF_A] }),
      SUBJECT,
      'devnet',
      { rpcs, sleep: noTimeout },
    );
    if (!r.ok) throw new Error(r.flag.ruleId);
    expect(calls.devnet.map((c) => c.method)).toEqual(['getAccountInfo']);
    expect(calls.devnet[0]?.params[0]).toBe(MINT);
    const tx = await decodeBuilt(r.base64);
    expect(tx.feePayer).toBe(SUBJECT);
    expect(tx.instructions).toHaveLength(1);
    const ix = tx.instructions[0]!;
    expect(ix.programAddress).toBe(PROGRAM_IDS.splToken as Address);
    const tokenProgram = PROGRAM_IDS.splToken as Address;
    const [source] = await findAssociatedTokenPda({ owner: SUBJECT, mint: MINT, tokenProgram });
    const [destination] = await findAssociatedTokenPda({ owner: RECIPIENT, mint: MINT, tokenProgram });
    expect(addresses(ix.accounts)).toEqual([source, MINT, destination, SUBJECT, REF_A]);
    expect(ix.accounts[3]).toMatchObject({ signer: true });
    expect(ix.accounts[4]).toEqual({ kind: 'resolved', address: REF_A, writable: false, signer: false });
    const data = getTransferCheckedInstructionDataDecoder().decode(ix.data);
    expect(data.amount).toBe(2_500_000n);
    expect(data.decimals).toBe(6);
  });

  test('Token-2022 mint uses the Token-2022 program and its ATAs', async () => {
    const { rpcs } = createFakeClusterRpcs([mintRoute(PROGRAM_IDS.token2022, 2)]);
    const r = await buildTransferTransaction(transfer({ splToken: MINT, amount: { digits: 1n, scale: 0 } }), SUBJECT, 'mainnet', { rpcs, sleep: noTimeout });
    if (!r.ok) throw new Error(r.flag.ruleId);
    const tx = await decodeBuilt(r.base64);
    const ix = tx.instructions[0]!;
    expect(ix.programAddress).toBe(PROGRAM_IDS.token2022 as Address);
    const [source] = await findAssociatedTokenPda({ owner: SUBJECT, mint: MINT, tokenProgram: PROGRAM_IDS.token2022 as Address });
    expect(ix.accounts[0]).toMatchObject({ address: source });
    expect(getTransferCheckedInstructionDataDecoder().decode(ix.data).amount).toBe(100n);
  });

  test('missing mint is mint-missing', async () => {
    const { rpcs } = createFakeClusterRpcs([{ method: 'getAccountInfo', reply: { result: withContext(null) } }]);
    const r = await buildTransferTransaction(transfer({ splToken: MINT }), SUBJECT, 'mainnet', { rpcs, sleep: noTimeout });
    expect(r).toEqual({ ok: false, flag: { ruleId: 'TRANSFER_BUILD_FAILED', reason: 'mint-missing', mint: MINT } });
  });

  test('mint owned by another program is mint-wrong-owner', async () => {
    const { rpcs } = createFakeClusterRpcs([mintRoute(PROGRAM_IDS.system)]);
    const r = await buildTransferTransaction(transfer({ splToken: MINT }), SUBJECT, 'mainnet', { rpcs, sleep: noTimeout });
    expect(r).toEqual({ ok: false, flag: { ruleId: 'TRANSFER_BUILD_FAILED', reason: 'mint-wrong-owner', mint: MINT } });
  });

  test('RPC error or timeout is mint-read-failed', async () => {
    const cases: [FakeRoute, Sleep][] = [
      [{ method: 'getAccountInfo', reply: { rpcError: { code: -32000, message: 'x' } } }, noTimeout],
      [{ method: 'getAccountInfo', reply: { hang: true } }, () => Promise.resolve()],
    ];
    for (const [route, sleep] of cases) {
      const { rpcs } = createFakeClusterRpcs([route]);
      const r = await buildTransferTransaction(transfer({ splToken: MINT }), SUBJECT, 'mainnet', { rpcs, sleep });
      expect(r).toEqual({ ok: false, flag: { ruleId: 'TRANSFER_BUILD_FAILED', reason: 'mint-read-failed', mint: MINT } });
    }
  });
});
