import { describe, expect, test } from 'bun:test';
import { address, type Address } from '@solana/kit';
import { getTransferSolInstructionDataEncoder, getTransferSolWithSeedInstructionDataEncoder } from '@solana-program/system';
import {
  AuthorityType,
  getApproveCheckedInstructionDataEncoder,
  getApproveInstructionDataEncoder,
  getBurnInstructionDataEncoder,
  getCloseAccountInstructionDataEncoder,
  getMintToInstructionDataEncoder,
  getSetAuthorityInstructionDataEncoder,
  getTransferCheckedInstructionDataEncoder,
  getTransferInstructionDataEncoder,
} from '@solana-program/token';
import {
  AuthorityType as AuthorityType2022,
  getSetAuthorityInstructionDataEncoder as getSetAuthority2022Encoder,
  getTransferCheckedWithFeeInstructionDataEncoder,
} from '@solana-program/token-2022';
import { parseCompiled } from '../../../src/solana/instruction-parser.ts';
import { PROGRAM_IDS, type AccountRef, type CompiledIx, type ParsedInstruction } from '../../../src/solana/types.ts';

const A = address('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
const B = address('So11111111111111111111111111111111111111112');
const C = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const D = address('Vote111111111111111111111111111111111111111');
const E = address('SysvarRent111111111111111111111111111111111');
const TABLE = address('AddressLookupTab1e1111111111111111111111111');

const r = (a: Address): AccountRef => ({ kind: 'resolved', address: a, writable: true, signer: false });
const ix = (program: string, accounts: AccountRef[], data: ArrayLike<number>): CompiledIx => ({
  programAddress: address(program),
  accounts,
  data: new Uint8Array(data),
});
const parsed = (i: CompiledIx) => parseCompiled(i, 3).parsed;

describe('parseCompiled', () => {
  test('record envelope for top-level', () => {
    const rec = parseCompiled(ix(PROGRAM_IDS.memoV2, [], [1, 2]), 5);
    expect(rec).toEqual({
      programAddress: address(PROGRAM_IDS.memoV2),
      topLevelIndex: 5,
      inner: false,
      stackHeight: 1,
      parsed: { kind: 'other' },
    });
  });

  test('System Transfer', () => {
    const data = getTransferSolInstructionDataEncoder().encode({ amount: 1_000_000n });
    expect(parsed(ix(PROGRAM_IDS.system, [r(A), r(B)], data))).toEqual({
      kind: 'system-transfer',
      source: A,
      destination: B,
      lamports: 1_000_000n,
    });
  });

  test('System TransferWithSeed', () => {
    const data = getTransferSolWithSeedInstructionDataEncoder().encode({ amount: 7n, fromSeed: 'seed', fromOwner: D });
    expect(parsed(ix(PROGRAM_IDS.system, [r(A), r(B), r(C)], data))).toEqual({
      kind: 'system-transfer-with-seed',
      source: A,
      base: B,
      destination: C,
      lamports: 7n,
    });
  });

  test('SPL Token Transfer', () => {
    const data = getTransferInstructionDataEncoder().encode({ amount: 5n });
    expect(parsed(ix(PROGRAM_IDS.splToken, [r(A), r(B), r(C)], data))).toEqual({
      kind: 'token-transfer',
      program: 'spl-token',
      source: A,
      destination: B,
      authority: C,
      amount: 5n,
      variant: 'transfer',
    });
  });

  test('Approve: source, delegate, owner, amount', () => {
    const data = getApproveInstructionDataEncoder().encode({ amount: 2n ** 64n - 1n });
    expect(parsed(ix(PROGRAM_IDS.splToken, [r(A), r(B), r(C)], data))).toEqual({
      kind: 'token-approve',
      program: 'spl-token',
      source: A,
      delegate: B,
      owner: C,
      amount: 2n ** 64n - 1n,
    });
  });

  test('ApproveChecked on Token-2022: source, mint, delegate, owner', () => {
    const data = getApproveCheckedInstructionDataEncoder().encode({ amount: 42n, decimals: 6 });
    expect(parsed(ix(PROGRAM_IDS.token2022, [r(A), r(B), r(C), r(D)], data))).toEqual({
      kind: 'token-approve',
      program: 'token-2022',
      source: A,
      mint: B,
      delegate: C,
      owner: D,
      amount: 42n,
      decimals: 6,
    });
  });

  test('SetAuthority with new authority', () => {
    const data = getSetAuthorityInstructionDataEncoder().encode({
      authorityType: AuthorityType.AccountOwner,
      newAuthority: E,
    });
    expect(parsed(ix(PROGRAM_IDS.splToken, [r(A), r(B)], data))).toEqual({
      kind: 'token-set-authority',
      program: 'spl-token',
      target: A,
      currentAuthority: B,
      authorityType: 'account owner',
      newAuthority: E,
    });
  });

  test('SetAuthority without new authority (revoke)', () => {
    const data = getSetAuthorityInstructionDataEncoder().encode({
      authorityType: AuthorityType.MintTokens,
      newAuthority: null,
    });
    expect(parsed(ix(PROGRAM_IDS.splToken, [r(A), r(B)], data))).toEqual({
      kind: 'token-set-authority',
      program: 'spl-token',
      target: A,
      currentAuthority: B,
      authorityType: 'mint',
      newAuthority: null,
    });
  });

  test('SetAuthority Token-2022 extension types map by enum order; unknown values map to unknown', () => {
    const data = getSetAuthority2022Encoder().encode({
      authorityType: AuthorityType2022.PermanentDelegate,
      newAuthority: E,
    });
    const p = parsed(ix(PROGRAM_IDS.token2022, [r(A), r(B)], data));
    expect(p).toMatchObject({ kind: 'token-set-authority', authorityType: 'permanent delegate' });
    // PermanentDelegate (8) is not an SPL Token authority type.
    const legacy = parsed(ix(PROGRAM_IDS.splToken, [r(A), r(B)], data));
    expect(legacy).toMatchObject({ kind: 'token-set-authority', authorityType: 'unknown' });
    const raw = parsed(ix(PROGRAM_IDS.token2022, [r(A), r(B)], [6, 200, 0]));
    expect(raw).toMatchObject({ kind: 'token-set-authority', authorityType: 'unknown', newAuthority: null });
  });

  test('CloseAccount: account, destination, authority', () => {
    const data = getCloseAccountInstructionDataEncoder().encode({});
    expect(parsed(ix(PROGRAM_IDS.splToken, [r(A), r(B), r(C)], data))).toEqual({
      kind: 'token-close',
      program: 'spl-token',
      account: A,
      destination: B,
      authority: C,
    });
  });

  test('TransferChecked: source, mint, destination, owner', () => {
    const data = getTransferCheckedInstructionDataEncoder().encode({ amount: 1_500_000n, decimals: 6 });
    expect(parsed(ix(PROGRAM_IDS.splToken, [r(A), r(B), r(C), r(D)], data))).toEqual({
      kind: 'token-transfer',
      program: 'spl-token',
      source: A,
      mint: B,
      destination: C,
      authority: D,
      amount: 1_500_000n,
      decimals: 6,
      variant: 'checked',
    });
  });

  test('Token-2022 TransferCheckedWithFee', () => {
    const data = getTransferCheckedWithFeeInstructionDataEncoder().encode({ amount: 100n, decimals: 2, fee: 1n });
    expect(parsed(ix(PROGRAM_IDS.token2022, [r(A), r(B), r(C), r(D)], data))).toEqual({
      kind: 'token-transfer',
      program: 'token-2022',
      source: A,
      mint: B,
      destination: C,
      authority: D,
      amount: 100n,
      decimals: 2,
      variant: 'checked-with-fee',
    });
  });

  test('MintTo and Burn', () => {
    const mintData = getMintToInstructionDataEncoder().encode({ amount: 9n });
    expect(parsed(ix(PROGRAM_IDS.splToken, [r(A), r(B), r(C)], mintData))).toEqual({
      kind: 'token-mint-to',
      program: 'spl-token',
      mint: A,
      account: B,
      amount: 9n,
    });
    const burnData = getBurnInstructionDataEncoder().encode({ amount: 4n });
    expect(parsed(ix(PROGRAM_IDS.splToken, [r(A), r(B), r(C)], burnData))).toEqual({
      kind: 'token-burn',
      program: 'spl-token',
      account: A,
      mint: B,
      amount: 4n,
    });
  });

  test('ATA Create (empty data) and CreateIdempotent', () => {
    const accounts = [r(A), r(B), r(C), r(D), r(address(PROGRAM_IDS.system)), r(address(PROGRAM_IDS.splToken))];
    const expected: ParsedInstruction = { kind: 'ata-create', wallet: C, ata: B, mint: D, tokenProgram: address(PROGRAM_IDS.splToken) };
    expect(parsed(ix(PROGRAM_IDS.ata, accounts, []))).toEqual(expected);
    expect(parsed(ix(PROGRAM_IDS.ata, accounts, [0]))).toEqual(expected);
    expect(parsed(ix(PROGRAM_IDS.ata, accounts, [1]))).toEqual(expected);
    expect(parsed(ix(PROGRAM_IDS.ata, accounts, [2]))).toEqual({ kind: 'other' });
  });

  test('unresolved needed account → unparseable/unresolved-account', () => {
    const data = getApproveInstructionDataEncoder().encode({ amount: 1n });
    const unresolved: AccountRef = { kind: 'unresolved', table: TABLE, index: 4, writable: false };
    expect(parsed(ix(PROGRAM_IDS.splToken, [r(A), unresolved, r(C)], data))).toEqual({
      kind: 'unparseable',
      reason: 'unresolved-account',
    });
  });

  test('short or garbled data → unparseable/bad-data', () => {
    expect(parsed(ix(PROGRAM_IDS.splToken, [r(A), r(B), r(C)], [4, 1, 2]))).toEqual({
      kind: 'unparseable',
      reason: 'bad-data',
    });
    expect(parsed(ix(PROGRAM_IDS.splToken, [r(A), r(B), r(C)], []))).toEqual({ kind: 'unparseable', reason: 'bad-data' });
    expect(parsed(ix(PROGRAM_IDS.system, [r(A), r(B)], [2, 0]))).toEqual({ kind: 'unparseable', reason: 'bad-data' });
    // SetAuthority with an invalid COption flag
    expect(parsed(ix(PROGRAM_IDS.splToken, [r(A), r(B)], [6, 0, 7]))).toEqual({ kind: 'unparseable', reason: 'bad-data' });
    // Missing positional account
    const data = getTransferCheckedInstructionDataEncoder().encode({ amount: 1n, decimals: 0 });
    expect(parsed(ix(PROGRAM_IDS.splToken, [r(A), r(B)], data))).toEqual({ kind: 'unparseable', reason: 'bad-data' });
  });

  test('unknown discriminators and programs → other', () => {
    expect(parsed(ix(PROGRAM_IDS.splToken, [r(A)], [18, 0]))).toEqual({ kind: 'other' });
    expect(parsed(ix(PROGRAM_IDS.system, [r(A), r(B)], [0, 0, 0, 0]))).toEqual({ kind: 'other' });
    expect(parsed(ix(PROGRAM_IDS.splToken, [r(A)], [26, 1]))).toEqual({ kind: 'other' });
    expect(parsed(ix(PROGRAM_IDS.computeBudget, [], [2, 0, 0, 0, 0]))).toEqual({ kind: 'other' });
  });
});
