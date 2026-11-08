/**
 * Token account and mint decoding (Req 7.3, 8.4, 8.11). The owning program is
 * checked before any byte is read, so data owned by another program is never
 * interpreted as a token account or mint.
 */
import { getAddressDecoder, getU64Decoder, type Address } from '@solana/kit';
import { getMintDecoder } from '@solana-program/token-2022';
import { PROGRAM_IDS, type AccountSnapshot, type MintView, type TokenAccountView, type TokenProgram } from './types.ts';

const TOKEN_ACCOUNT_LEN = 165;
const MINT_LEN = 82;
const ACCOUNT_TYPE_OFFSET = 165;
const ACCOUNT_TYPE_MINT = 1;
const ACCOUNT_TYPE_ACCOUNT = 2;
const STATE_OFFSET = 108;
const DECIMALS_OFFSET = 44;
const MINT_INITIALIZED_OFFSET = 45;

/** OptionalNonZeroPubkey: all-zero bytes mean "none". */
const ZERO_ADDRESS = PROGRAM_IDS.system as Address;

const addressDecoder = getAddressDecoder();
const u64Decoder = getU64Decoder();

export function tokenProgramOf(owner: Address): TokenProgram | null {
  if (owner === PROGRAM_IDS.splToken) return 'spl-token';
  if (owner === PROGRAM_IDS.token2022) return 'token-2022';
  return null;
}

/** Returns null unless the snapshot is an initialized token account owned by a token program. */
export function decodeTokenAccount(address: Address, snapshot: AccountSnapshot): TokenAccountView | null {
  if (!snapshot.exists) return null;
  const program = tokenProgramOf(snapshot.owner);
  if (program === null) return null;
  const data = snapshot.data;
  if (program === 'spl-token') {
    if (data.length !== TOKEN_ACCOUNT_LEN) return null;
  } else if (data.length !== TOKEN_ACCOUNT_LEN) {
    if (data.length <= ACCOUNT_TYPE_OFFSET || data[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_ACCOUNT) return null;
  }
  const state = data[STATE_OFFSET];
  if (state !== 1 && state !== 2) return null;
  try {
    return {
      address,
      program,
      mint: addressDecoder.decode(data.subarray(0, 32)),
      owner: addressDecoder.decode(data.subarray(32, 64)),
      amount: u64Decoder.decode(data.subarray(64, 72)),
    };
  } catch {
    return null;
  }
}

/** Anything missing, owned by another program, or undecodable is `unreadable`. */
export function decodeMint(address: Address, snapshot: AccountSnapshot): MintView {
  const unreadable: MintView = { status: 'unreadable', address };
  if (!snapshot.exists) return unreadable;
  const program = tokenProgramOf(snapshot.owner);
  if (program === null) return unreadable;
  const data = snapshot.data;

  if (program === 'spl-token') {
    if (data.length !== MINT_LEN || data[MINT_INITIALIZED_OFFSET] !== 1) return unreadable;
    const decimals = data[DECIMALS_OFFSET];
    if (decimals === undefined) return unreadable;
    return { status: 'ok', address, program, decimals, permanentDelegate: null };
  }

  if (data.length !== MINT_LEN && (data.length <= ACCOUNT_TYPE_OFFSET || data[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT)) {
    return unreadable;
  }
  try {
    const mint = getMintDecoder().decode(data);
    if (!mint.isInitialized) return unreadable;
    let permanentDelegate: Address | null = null;
    if (mint.extensions.__option === 'Some') {
      for (const ext of mint.extensions.value) {
        if (ext.__kind === 'PermanentDelegate') {
          permanentDelegate = ext.delegate === ZERO_ADDRESS ? null : ext.delegate;
          break;
        }
      }
    }
    return { status: 'ok', address, program, decimals: mint.decimals, permanentDelegate };
  } catch {
    return unreadable;
  }
}
