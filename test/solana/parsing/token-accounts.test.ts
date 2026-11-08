import { describe, expect, test } from 'bun:test';
import { address, some, type Address } from '@solana/kit';
import { AccountState, getTokenEncoder, getMintEncoder as getSplMintEncoder } from '@solana-program/token';
import { getMintEncoder, getTokenEncoder as getToken2022Encoder } from '@solana-program/token-2022';
import { BUILTIN_KNOWN_PROGRAMS, isKnownProgram, knownProgramSet } from '../../../src/solana/known-programs.ts';
import { decodeMint, decodeTokenAccount, tokenProgramOf } from '../../../src/solana/token-accounts.ts';
import { PROGRAM_IDS, type AccountSnapshot, type MintView } from '../../../src/solana/types.ts';

const MINT = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const OWNER = address('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
const ACCT = address('BCbrryfVtpmWMg5nDRrgwYH25NPDdchpCbDtYV3Mh1VY');
const DELEGATE = address('Vote111111111111111111111111111111111111111');
const SPL = address(PROGRAM_IDS.splToken);
const T22 = address(PROGRAM_IDS.token2022);

const snap = (owner: Address, data: ArrayLike<number>): AccountSnapshot => ({
  exists: true,
  owner,
  lamports: 2_039_280n,
  data: new Uint8Array(data),
});

const tokenArgs = {
  mint: MINT,
  owner: OWNER,
  amount: 4_300_000n,
  delegate: null,
  state: AccountState.Initialized,
  isNative: null,
  delegatedAmount: 0n,
  closeAuthority: null,
};

describe('known programs', () => {
  test('built-ins plus extras', () => {
    expect(BUILTIN_KNOWN_PROGRAMS).toHaveLength(8);
    const set = knownProgramSet([DELEGATE]);
    expect(isKnownProgram(address(PROGRAM_IDS.memoV1), set)).toBe(true);
    expect(isKnownProgram(DELEGATE, set)).toBe(true);
    expect(isKnownProgram(OWNER, set)).toBe(false);
  });
});

describe('decodeTokenAccount', () => {
  test('tokenProgramOf', () => {
    expect(tokenProgramOf(SPL)).toBe('spl-token');
    expect(tokenProgramOf(T22)).toBe('token-2022');
    expect(tokenProgramOf(address(PROGRAM_IDS.system))).toBeNull();
  });

  test('SPL Token base layout', () => {
    const data = getTokenEncoder().encode(tokenArgs);
    expect(data.length).toBe(165);
    expect(decodeTokenAccount(ACCT, snap(SPL, data))).toEqual({
      address: ACCT,
      program: 'spl-token',
      mint: MINT,
      owner: OWNER,
      amount: 4_300_000n,
    });
  });

  test('program owner is checked before bytes', () => {
    const data = getTokenEncoder().encode(tokenArgs);
    expect(decodeTokenAccount(ACCT, snap(address(PROGRAM_IDS.system), data))).toBeNull();
    expect(decodeTokenAccount(ACCT, { exists: false })).toBeNull();
  });

  test('wrong length or uninitialized → null', () => {
    const data = getTokenEncoder().encode(tokenArgs);
    expect(decodeTokenAccount(ACCT, snap(SPL, data.slice(0, 100)))).toBeNull();
    const uninit = getTokenEncoder().encode({ ...tokenArgs, state: AccountState.Uninitialized });
    expect(decodeTokenAccount(ACCT, snap(SPL, uninit))).toBeNull();
  });

  test('Token-2022 extended account (account type byte 2 at 165)', () => {
    const data = getToken2022Encoder().encode({
      ...tokenArgs,
      extensions: some([{ __kind: 'ImmutableOwner' }]),
    });
    expect(data.length).toBeGreaterThan(165);
    expect(data[165]).toBe(2);
    expect(decodeTokenAccount(ACCT, snap(T22, data))).toMatchObject({ program: 'token-2022', mint: MINT, owner: OWNER });
    // Same bytes under SPL Token are rejected (SPL accounts are exactly 165 bytes).
    expect(decodeTokenAccount(ACCT, snap(SPL, data))).toBeNull();
    const mutated = new Uint8Array(data);
    mutated[165] = 1;
    expect(decodeTokenAccount(ACCT, snap(T22, mutated))).toBeNull();
  });
});

describe('decodeMint', () => {
  const mintBase = {
    mintAuthority: OWNER,
    supply: 1_000n,
    decimals: 6,
    isInitialized: true,
    freezeAuthority: null,
  };

  test('SPL Token mint: decimals at byte 44, no permanent delegate', () => {
    const data = getSplMintEncoder().encode(mintBase);
    expect(data[44]).toBe(6);
    expect(decodeMint(MINT, snap(SPL, data))).toEqual({
      status: 'ok',
      address: MINT,
      program: 'spl-token',
      decimals: 6,
      permanentDelegate: null,
    });
  });

  test('Token-2022 mint with PermanentDelegate extension', () => {
    const data = getMintEncoder().encode({
      ...mintBase,
      decimals: 9,
      extensions: some([{ __kind: 'PermanentDelegate', delegate: DELEGATE }]),
    });
    expect(decodeMint(MINT, snap(T22, data))).toEqual({
      status: 'ok',
      address: MINT,
      program: 'token-2022',
      decimals: 9,
      permanentDelegate: DELEGATE,
    });
  });

  test('Token-2022 mint with zeroed PermanentDelegate means none', () => {
    const data = getMintEncoder().encode({
      ...mintBase,
      extensions: some([{ __kind: 'PermanentDelegate', delegate: address(PROGRAM_IDS.system) }]),
    });
    expect(decodeMint(MINT, snap(T22, data))).toMatchObject({ status: 'ok', permanentDelegate: null });
  });

  test('Token-2022 mint without extensions', () => {
    const data = getMintEncoder().encode({ ...mintBase, extensions: null });
    expect(decodeMint(MINT, snap(T22, data))).toMatchObject({ status: 'ok', decimals: 6, permanentDelegate: null });
  });

  test('unreadable cases', () => {
    const data = getSplMintEncoder().encode(mintBase);
    const unreadable: MintView = { status: 'unreadable', address: MINT };
    expect(decodeMint(MINT, { exists: false })).toEqual(unreadable);
    expect(decodeMint(MINT, snap(address(PROGRAM_IDS.system), data))).toEqual(unreadable);
    expect(decodeMint(MINT, snap(SPL, data.slice(0, 40)))).toEqual(unreadable);
    expect(decodeMint(MINT, snap(SPL, getTokenEncoder().encode(tokenArgs)))).toEqual(unreadable);
    expect(decodeMint(MINT, snap(T22, new Uint8Array(200).fill(0xff)))).toEqual(unreadable);
    expect(decodeMint(MINT, snap(SPL, getSplMintEncoder().encode({ ...mintBase, isInitialized: false })))).toEqual(
      unreadable,
    );
  });
});
