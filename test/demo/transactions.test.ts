import { describe, expect, test } from 'bun:test';
import { getTransferSolInstructionDataDecoder } from '@solana-program/system';
import { findAssociatedTokenPda, getApproveInstructionDataDecoder } from '@solana-program/token';
import {
  type Address,
  getAddressDecoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  isAddress,
} from '@solana/kit';
import { DEMO, drainerTransaction, safeTransaction } from '../../demo/transactions.ts';
import { PROGRAM_IDS } from '../../src/solana/types.ts';

const ACCOUNT: Address = getAddressDecoder().decode(new Uint8Array(32).fill(9));

function decode(base64: string) {
  const bytes = new Uint8Array(getBase64Encoder().encode(base64));
  const tx = getTransactionDecoder().decode(bytes);
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (message.version !== 0) throw new Error(`expected a v0 message, got ${String(message.version)}`);
  return { bytes, tx, message };
}

function expectUnsigned(bytes: Uint8Array, signatures: Record<string, unknown>) {
  const count = bytes[0]!;
  expect(count).toBe(1);
  expect(bytes.subarray(1, 1 + 64 * count).every((b) => b === 0)).toBe(true);
  expect(Object.values(signatures).every((s) => s === null)).toBe(true);
}

describe('DEMO constants', () => {
  test('attacker and recipient are the fixed System Program PDAs, distinct and valid', async () => {
    expect(isAddress(DEMO.attacker)).toBe(true);
    expect(isAddress(DEMO.safeRecipient)).toBe(true);
    expect(DEMO.attacker).not.toBe(DEMO.safeRecipient);
    const system = PROGRAM_IDS.system as Address;
    expect((await getProgramDerivedAddress({ programAddress: system, seeds: ['demo-attacker'] }))[0]).toBe(DEMO.attacker);
    expect((await getProgramDerivedAddress({ programAddress: system, seeds: ['demo-recipient'] }))[0]).toBe(DEMO.safeRecipient);
  });
});

describe('drainerTransaction', () => {
  test('one SPL Token Approve of u64::MAX from the ATA to the attacker, account pays', async () => {
    const { bytes, tx, message } = decode(await drainerTransaction(ACCOUNT));
    expectUnsigned(bytes, tx.signatures);
    expect(message.version).toBe(0);
    expect(message.staticAccounts[0]).toBe(ACCOUNT);
    expect(message.lifetimeToken).toBe('11111111111111111111111111111111');
    expect(message.instructions).toHaveLength(1);
    const ix = message.instructions[0]!;
    expect(message.staticAccounts[ix.programAddressIndex]).toBe(PROGRAM_IDS.splToken as Address);
    expect(ix.data?.[0]).toBe(4);
    const accounts = (ix.accountIndices ?? []).map((i) => message.staticAccounts[i]);
    const [ata] = await findAssociatedTokenPda({ owner: ACCOUNT, mint: DEMO.mint, tokenProgram: PROGRAM_IDS.splToken as Address });
    expect(accounts).toEqual([ata, DEMO.attacker, ACCOUNT]);
    expect(getApproveInstructionDataDecoder().decode(ix.data!).amount).toBe(18_446_744_073_709_551_615n);
  });
});

describe('safeTransaction', () => {
  test('one System transfer of 1,000,000 lamports to the safe recipient', async () => {
    const { bytes, tx, message } = decode(await safeTransaction(ACCOUNT));
    expectUnsigned(bytes, tx.signatures);
    expect(message.staticAccounts[0]).toBe(ACCOUNT);
    expect(message.instructions).toHaveLength(1);
    const ix = message.instructions[0]!;
    expect(message.staticAccounts[ix.programAddressIndex]).toBe(PROGRAM_IDS.system as Address);
    const accounts = (ix.accountIndices ?? []).map((i) => message.staticAccounts[i]);
    expect(accounts).toEqual([ACCOUNT, DEMO.safeRecipient]);
    expect(getTransferSolInstructionDataDecoder().decode(ix.data!).amount).toBe(1_000_000n);
  });
});
