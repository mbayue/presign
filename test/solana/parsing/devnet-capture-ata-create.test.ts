/**
 * Task 11.4: parse the real devnet `simulateTransaction` capture written by
 * `scripts/capture-devnet-simulation.ts`. The fee payer had no devnet-USDC ATA,
 * so `CreateIdempotent` made four CPI calls and devnet returned them as
 * jsonParsed inner instructions.
 */
import { describe, expect, test } from 'bun:test';
import {
  address,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Address,
} from '@solana/kit';
import fixture from '../../fixtures/rpc/devnet-capture-ata-create.json' with { type: 'json' };
import { parseInner } from '../../../src/solana/inner-instructions.ts';
import { parseCompiled } from '../../../src/solana/instruction-parser.ts';
import { decodeTokenAccount } from '../../../src/solana/token-accounts.ts';
import { PROGRAM_IDS, type AccountRef, type AccountSnapshot, type CompiledIx } from '../../../src/solana/types.ts';

const FIXTURE = 'devnet-capture-ata-create.json';

type CompiledShape = {
  header: { numSignerAccounts: number; numReadonlySignerAccounts: number; numReadonlyNonSignerAccounts: number };
  staticAccounts: Address[];
  instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[];
};

function decodeFixtureTransaction(): { accountList: AccountRef[]; instructions: CompiledIx[] } {
  const wire = getBase64Encoder().encode(fixture.transactionBase64);
  const tx = getTransactionDecoder().decode(wire);
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as CompiledShape;
  const { numSignerAccounts, numReadonlySignerAccounts, numReadonlyNonSignerAccounts } = msg.header;
  const n = msg.staticAccounts.length;
  const accountList: AccountRef[] = msg.staticAccounts.map((a, i) => {
    const signer = i < numSignerAccounts;
    const writable = signer ? i < numSignerAccounts - numReadonlySignerAccounts : i < n - numReadonlyNonSignerAccounts;
    return { kind: 'resolved', address: a, writable, signer };
  });
  const instructions = msg.instructions.map((ix): CompiledIx => {
    const program = accountList[ix.programAddressIndex];
    if (program?.kind !== 'resolved') throw new Error('bad program index');
    return {
      programAddress: program.address,
      accounts: (ix.accountIndices ?? []).map((i) => {
        const ref = accountList[i];
        if (!ref) throw new Error('bad account index');
        return ref;
      }),
      data: new Uint8Array(ix.data ?? []),
    };
  });
  return { accountList, instructions };
}

function snapshotOf(entry: { data: string[]; owner: string; lamports: number }): AccountSnapshot {
  const [b64] = entry.data;
  return {
    exists: true,
    owner: address(entry.owner),
    lamports: BigInt(entry.lamports),
    data: new Uint8Array(getBase64Encoder().encode(b64 ?? '')),
  };
}

describe(FIXTURE, () => {
  const { payer, recipient, mint, ata, tokenProgram } = fixture.addresses;
  const value = fixture.response.result.value;

  test(`${FIXTURE}: simulation succeeded on devnet`, () => {
    expect(value.err).toBeNull();
    expect(Array.isArray(value.innerInstructions)).toBe(true);
  });

  test(`${FIXTURE}: top-level instructions parse into System transfer and ATA create`, () => {
    const { instructions } = decodeFixtureTransaction();
    const records = instructions.map((ix, i) => parseCompiled(ix, i));
    expect(records).toEqual([
      {
        programAddress: address(PROGRAM_IDS.system),
        topLevelIndex: 0,
        inner: false,
        stackHeight: 1,
        parsed: {
          kind: 'system-transfer',
          source: address(payer),
          destination: address(recipient),
          lamports: BigInt(fixture.transferLamports),
        },
      },
      {
        programAddress: address(PROGRAM_IDS.ata),
        topLevelIndex: 1,
        inner: false,
        stackHeight: 1,
        parsed: {
          kind: 'ata-create',
          wallet: address(payer),
          ata: address(ata),
          mint: address(mint),
          tokenProgram: address(tokenProgram),
        },
      },
    ]);
  });

  test(`${FIXTURE}: inner instructions normalize to the ATA program's four CPI calls`, () => {
    const { accountList } = decodeFixtureTransaction();
    const inner = parseInner(value.innerInstructions, accountList);
    if (!Array.isArray(inner)) throw new Error('parseInner rejected the devnet shape');
    // Devnet returns jsonParsed inner instructions: getAccountDataSize,
    // createAccount, initializeImmutableOwner, initializeAccount3.
    expect(inner.map((r) => r.programAddress)).toEqual([
      address(PROGRAM_IDS.splToken),
      address(PROGRAM_IDS.system),
      address(PROGRAM_IDS.splToken),
      address(PROGRAM_IDS.splToken),
    ]);
    for (const r of inner) {
      expect(r.inner).toBe(true);
      expect(r.topLevelIndex).toBe(1);
      expect(r.stackHeight).toBe(2);
      // None of these are risk-relevant token instructions.
      expect(['other', 'unparseable']).toContain(r.parsed.kind);
    }
    expect(value.logs.some((l) => l.includes('invoke [2]'))).toBe(true);
  });

  test(`${FIXTURE}: returned accounts decode (payer is not a token account; new ATA is)`, () => {
    const [payerEntry, ataEntry] = value.accounts;
    if (!payerEntry || !ataEntry) throw new Error('fixture accounts missing');
    expect(decodeTokenAccount(address(payer), snapshotOf(payerEntry))).toBeNull();
    const view = decodeTokenAccount(address(ata), snapshotOf(ataEntry));
    expect(view).toEqual({
      address: address(ata),
      program: 'spl-token',
      mint: address(mint),
      owner: address(payer),
      amount: 0n,
    });
  });
});
