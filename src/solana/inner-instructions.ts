/**
 * Pure normalizer for `simulateTransaction` inner instructions (Req 7.5, 14.5,
 * 14.10). Accepts the three shapes RPC nodes return:
 *
 *  (a) jsonParsed:          { program, programId, parsed: { type, info }, stackHeight }
 *  (b) partially decoded:   { programId, accounts: string[], data: base58, stackHeight }
 *  (c) compiled:            { programIdIndex, accounts: number[], data: base58|base64, stackHeight }
 *
 * Agave's simulateTransaction returns (a) for programs it knows and (b) for the
 * rest. Every record keeps the parent's top-level index and the order returned.
 * Any envelope that does not match one of these shapes makes the whole result
 * `INVALID_RESPONSE_RPC`.
 */
import { getBase58Encoder, getBase64Encoder, isAddress, type Address } from '@solana/kit';
import { authorityTypeName, parseInstruction } from './instruction-parser.ts';
import {
  PROGRAM_IDS,
  type AccountRef,
  type AuthorityTypeName,
  type CompiledIx,
  type InstructionRecord,
  type ParsedInstruction,
  type TokenProgram,
} from './types.ts';

export type InnerParseError = { error: 'INVALID_RESPONSE_RPC' };

const INVALID: InnerParseError = { error: 'INVALID_RESPONSE_RPC' };
const DEFAULT_INNER_STACK_HEIGHT = 2;
const BAD_DATA: ParsedInstruction = { kind: 'unparseable', reason: 'bad-data' };
const OTHER: ParsedInstruction = { kind: 'other' };

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]*$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const DIGITS_RE = /^\d{1,20}$/;
const U64_MAX = 2n ** 64n - 1n;

/** Agave `UiAuthorityType` strings (camelCase) → flag names. */
const JSON_AUTHORITY_TYPES: Readonly<Record<string, AuthorityTypeName>> = {
  mintTokens: 'mint',
  freezeAccount: 'freeze',
  accountOwner: 'account owner',
  closeAccount: 'close',
  transferFeeConfig: 'transfer fee config',
  withheldWithdraw: 'withheld withdraw',
  closeMint: 'close mint',
  interestRate: 'interest rate',
  permanentDelegate: 'permanent delegate',
  confidentialTransferMint: 'confidential transfer mint',
  transferHookProgramId: 'transfer hook program id',
  confidentialTransferFeeConfig: 'confidential transfer fee config',
  metadataPointer: 'metadata pointer',
  groupPointer: 'group pointer',
  groupMemberPointer: 'group member pointer',
  scaledUiAmount: 'scaled ui amount',
  scaledUiAmountConfig: 'scaled ui amount',
  pause: 'pause',
};

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Thrown inside info readers; becomes `unparseable/bad-data` for that record only. */
class BadInfo extends Error {}

function addr(info: Obj, ...keys: string[]): Address {
  for (const k of keys) {
    const v = info[k];
    if (typeof v === 'string' && isAddress(v)) return v;
  }
  throw new BadInfo(keys.join('|'));
}

function u64(v: unknown): bigint {
  let n: bigint;
  if (typeof v === 'string' && DIGITS_RE.test(v)) n = BigInt(v);
  else if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) n = BigInt(v);
  else throw new BadInfo('amount');
  if (n > U64_MAX) throw new BadInfo('amount');
  return n;
}

/** `amount` field or `tokenAmount.amount` (checked variants). */
function tokenAmount(info: Obj): { amount: bigint; decimals?: number } {
  const ta = info.tokenAmount;
  if (isObj(ta)) {
    const amount = u64(ta.amount);
    const d = ta.decimals;
    if (typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 255) return { amount, decimals: d };
    return { amount };
  }
  return { amount: u64(info.amount) };
}

function tokenProgramOfId(programId: Address): TokenProgram | null {
  if (programId === PROGRAM_IDS.splToken) return 'spl-token';
  if (programId === PROGRAM_IDS.token2022) return 'token-2022';
  return null;
}

function mapSystemParsed(type: string, info: Obj): ParsedInstruction {
  switch (type) {
    case 'transfer':
      return {
        kind: 'system-transfer',
        source: addr(info, 'source'),
        destination: addr(info, 'destination'),
        lamports: u64(info.lamports),
      };
    case 'transferWithSeed':
      return {
        kind: 'system-transfer-with-seed',
        source: addr(info, 'source'),
        base: addr(info, 'sourceBase'),
        destination: addr(info, 'destination'),
        lamports: u64(info.lamports),
      };
    default:
      return OTHER;
  }
}

function mapTokenParsed(program: TokenProgram, type: string, info: Obj): ParsedInstruction {
  switch (type) {
    case 'transfer':
    case 'transferChecked':
    case 'transferCheckedWithFee': {
      const { amount, decimals } = tokenAmount(info);
      const base = {
        kind: 'token-transfer' as const,
        program,
        source: addr(info, 'source'),
        destination: addr(info, 'destination'),
        authority: addr(info, 'authority', 'multisigAuthority'),
        amount,
      };
      if (type === 'transfer') return { ...base, variant: 'transfer' };
      const withMint = { ...base, mint: addr(info, 'mint'), ...(decimals !== undefined ? { decimals } : {}) };
      return { ...withMint, variant: type === 'transferChecked' ? 'checked' : 'checked-with-fee' };
    }
    case 'approve':
    case 'approveChecked': {
      const { amount, decimals } = tokenAmount(info);
      const base = {
        kind: 'token-approve' as const,
        program,
        source: addr(info, 'source'),
        delegate: addr(info, 'delegate'),
        owner: addr(info, 'owner', 'multisigOwner'),
        amount,
      };
      if (type === 'approve') return base;
      return { ...base, mint: addr(info, 'mint'), ...(decimals !== undefined ? { decimals } : {}) };
    }
    case 'setAuthority': {
      const rawType = info.authorityType;
      const authorityType: AuthorityTypeName =
        typeof rawType === 'string'
          ? (Object.hasOwn(JSON_AUTHORITY_TYPES, rawType) ? JSON_AUTHORITY_TYPES[rawType] : undefined) ?? 'unknown'
          : typeof rawType === 'number'
            ? authorityTypeName(program, rawType)
            : 'unknown';
      const na = info.newAuthority;
      let newAuthority: Address | null;
      if (na === null || na === undefined) newAuthority = null;
      else if (typeof na === 'string' && isAddress(na)) newAuthority = na;
      else throw new BadInfo('newAuthority');
      return {
        kind: 'token-set-authority',
        program,
        target: addr(info, 'account', 'mint'),
        currentAuthority: addr(info, 'authority', 'multisigAuthority'),
        authorityType,
        newAuthority,
      };
    }
    case 'closeAccount':
      return {
        kind: 'token-close',
        program,
        account: addr(info, 'account'),
        destination: addr(info, 'destination'),
        authority: addr(info, 'owner', 'multisigOwner', 'authority', 'multisigAuthority'),
      };
    case 'mintTo':
    case 'mintToChecked':
      return {
        kind: 'token-mint-to',
        program,
        mint: addr(info, 'mint'),
        account: addr(info, 'account'),
        amount: tokenAmount(info).amount,
      };
    case 'burn':
    case 'burnChecked':
      return {
        kind: 'token-burn',
        program,
        mint: addr(info, 'mint'),
        account: addr(info, 'account'),
        amount: tokenAmount(info).amount,
      };
    default:
      return OTHER;
  }
}

function mapAtaParsed(type: string, info: Obj): ParsedInstruction {
  if (type !== 'create' && type !== 'createIdempotent') return OTHER;
  return {
    kind: 'ata-create',
    wallet: addr(info, 'wallet'),
    ata: addr(info, 'account'),
    mint: addr(info, 'mint'),
    tokenProgram: addr(info, 'tokenProgram'),
  };
}

function mapParsed(programId: Address, parsed: unknown): ParsedInstruction {
  // Some programs (e.g. Memo) return `parsed` as a plain string.
  if (!isObj(parsed)) return OTHER;
  const { type, info } = parsed;
  if (typeof type !== 'string') return OTHER;
  if (!isObj(info)) return BAD_DATA;
  try {
    if (programId === PROGRAM_IDS.system) return mapSystemParsed(type, info);
    if (programId === PROGRAM_IDS.ata) return mapAtaParsed(type, info);
    const program = tokenProgramOfId(programId);
    if (program !== null) return mapTokenParsed(program, type, info);
    return OTHER;
  } catch (e) {
    if (e instanceof BadInfo) return BAD_DATA;
    throw e;
  }
}

/** base58 first (the RPC default for instruction data), base64 as fallback. */
function decodeData(data: string, allowBase64: boolean): Uint8Array | null {
  if (BASE58_RE.test(data)) {
    try {
      return new Uint8Array(getBase58Encoder().encode(data));
    } catch {
      /* fall through */
    }
  }
  if (allowBase64 && data.length % 4 === 0 && BASE64_RE.test(data)) {
    try {
      return new Uint8Array(getBase64Encoder().encode(data));
    } catch {
      return null;
    }
  }
  return null;
}

function readStackHeight(v: unknown): number | null {
  if (v === undefined || v === null) return DEFAULT_INNER_STACK_HEIGHT;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1) return v;
  return null;
}

function normalizeOne(ix: unknown, parentIndex: number, accountList: AccountRef[]): InstructionRecord | null {
  if (!isObj(ix)) return null;
  const stackHeight = readStackHeight(ix.stackHeight);
  if (stackHeight === null) return null;
  const base = { topLevelIndex: parentIndex, inner: true, stackHeight };

  // (a) jsonParsed
  if ('parsed' in ix) {
    const programId = ix.programId;
    if (typeof programId !== 'string' || !isAddress(programId)) return null;
    return { ...base, programAddress: programId, parsed: mapParsed(programId, ix.parsed) };
  }

  // (b) partially decoded
  if (typeof ix.programId === 'string') {
    const programId = ix.programId;
    const accounts = ix.accounts;
    if (!isAddress(programId) || !Array.isArray(accounts) || typeof ix.data !== 'string') return null;
    const refs: AccountRef[] = [];
    for (const a of accounts) {
      if (typeof a !== 'string' || !isAddress(a)) return null;
      refs.push({ kind: 'resolved', address: a, writable: false, signer: false });
    }
    const data = decodeData(ix.data, false);
    if (data === null) return null;
    const compiled: CompiledIx = { programAddress: programId, accounts: refs, data };
    return { ...base, programAddress: programId, parsed: parseInstruction(compiled) };
  }

  // (c) compiled
  if (isIndex(ix.programIdIndex)) {
    const programRef = accountList[ix.programIdIndex];
    const accounts = ix.accounts;
    if (programRef === undefined || programRef.kind !== 'resolved') return null;
    if (!Array.isArray(accounts) || typeof ix.data !== 'string') return null;
    const refs: AccountRef[] = [];
    for (const i of accounts) {
      if (!isIndex(i)) return null;
      const ref = accountList[i];
      if (ref === undefined) return null;
      refs.push(ref);
    }
    const data = decodeData(ix.data, true);
    if (data === null) return null;
    const compiled: CompiledIx = { programAddress: programRef.address, accounts: refs, data };
    return { ...base, programAddress: programRef.address, parsed: parseInstruction(compiled) };
  }

  return null;
}

/** Pure. `raw` is the `innerInstructions` array from simulateTransaction. */
export function parseInner(raw: unknown, accountList: AccountRef[]): InstructionRecord[] | InnerParseError {
  if (!Array.isArray(raw)) return INVALID;
  const out: InstructionRecord[] = [];
  for (const group of raw) {
    if (!isObj(group) || !isIndex(group.index) || !Array.isArray(group.instructions)) return INVALID;
    for (const ix of group.instructions) {
      const record = normalizeOne(ix, group.index, accountList);
      if (record === null) return INVALID;
      out.push(record);
    }
  }
  return out;
}
