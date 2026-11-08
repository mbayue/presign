/**
 * Pure top-level instruction parser (Req 5.3, 8.1–8.3, 8.8). Identifies System,
 * SPL Token, Token-2022 and ATA instructions by discriminator and reads the
 * positional accounts from the design's layout table. Bytes are decoded by
 * hand so the parser never throws on hostile input.
 */
import { getAddressDecoder, type Address } from '@solana/kit';
import {
  PROGRAM_IDS,
  type AuthorityTypeName,
  type CompiledIx,
  type InstructionRecord,
  type ParsedInstruction,
  type TokenProgram,
} from './types.ts';

const addressDecoder = getAddressDecoder();

/** Index = on-chain AuthorityType value (spl-token-2022 enum order). */
const TOKEN_2022_AUTHORITY_TYPES: readonly AuthorityTypeName[] = [
  'mint',
  'freeze',
  'account owner',
  'close',
  'transfer fee config',
  'withheld withdraw',
  'close mint',
  'interest rate',
  'permanent delegate',
  'confidential transfer mint',
  'transfer hook program id',
  'confidential transfer fee config',
  'metadata pointer',
  'group pointer',
  'group member pointer',
  'scaled ui amount',
  'pause',
  'permissioned burn',
];
const SPL_TOKEN_AUTHORITY_TYPE_COUNT = 4;

export function authorityTypeName(program: TokenProgram, value: number): AuthorityTypeName {
  if (program === 'spl-token' && value >= SPL_TOKEN_AUTHORITY_TYPE_COUNT) return 'unknown';
  return TOKEN_2022_AUTHORITY_TYPES[value] ?? 'unknown';
}

const BAD_DATA: ParsedInstruction = { kind: 'unparseable', reason: 'bad-data' };
const UNRESOLVED: ParsedInstruction = { kind: 'unparseable', reason: 'unresolved-account' };
const OTHER: ParsedInstruction = { kind: 'other' };

class ParseFailure extends Error {
  constructor(readonly parsed: ParsedInstruction) {
    super(parsed.kind);
  }
}

function readU64(data: Uint8Array, offset: number): bigint {
  if (data.length < offset + 8) throw new ParseFailure(BAD_DATA);
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
}

function readU32(data: Uint8Array, offset: number): number {
  if (data.length < offset + 4) throw new ParseFailure(BAD_DATA);
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

function readU8(data: Uint8Array, offset: number): number {
  const v = data[offset];
  if (v === undefined) throw new ParseFailure(BAD_DATA);
  return v;
}

function readAddress(data: Uint8Array, offset: number): Address {
  if (data.length < offset + 32) throw new ParseFailure(BAD_DATA);
  return addressDecoder.decode(data.subarray(offset, offset + 32));
}

/** Positional account; missing → bad-data, lookup-table-unresolved → unresolved-account. */
function account(ix: CompiledIx, position: number): Address {
  const ref = ix.accounts[position];
  if (ref === undefined) throw new ParseFailure(BAD_DATA);
  if (ref.kind === 'unresolved') throw new ParseFailure(UNRESOLVED);
  return ref.address;
}

/** Resolve all positions; any unresolved wins over missing so lookups are reported first. */
function accounts(ix: CompiledIx, positions: readonly number[]): Address[] {
  for (const p of positions) {
    if (ix.accounts[p]?.kind === 'unresolved') throw new ParseFailure(UNRESOLVED);
  }
  return positions.map((p) => account(ix, p));
}

function parseSystem(ix: CompiledIx): ParsedInstruction {
  const { data } = ix;
  if (data.length < 4) return BAD_DATA;
  const disc = readU32(data, 0);
  if (disc === 2) {
    const lamports = readU64(data, 4);
    const [source, destination] = accounts(ix, [0, 1]) as [Address, Address];
    return { kind: 'system-transfer', source, destination, lamports };
  }
  if (disc === 11) {
    const lamports = readU64(data, 4);
    const [source, base, destination] = accounts(ix, [0, 1, 2]) as [Address, Address, Address];
    return { kind: 'system-transfer-with-seed', source, base, destination, lamports };
  }
  return OTHER;
}

function parseToken(ix: CompiledIx, program: TokenProgram): ParsedInstruction {
  const { data } = ix;
  const disc = readU8(data, 0);
  switch (disc) {
    case 3: {
      const amount = readU64(data, 1);
      const [source, destination, authority] = accounts(ix, [0, 1, 2]) as [Address, Address, Address];
      return { kind: 'token-transfer', program, source, destination, authority, amount, variant: 'transfer' };
    }
    case 4: {
      const amount = readU64(data, 1);
      const [source, delegate, owner] = accounts(ix, [0, 1, 2]) as [Address, Address, Address];
      return { kind: 'token-approve', program, source, delegate, owner, amount };
    }
    case 6: {
      const authorityType = authorityTypeName(program, readU8(data, 1));
      const flag = readU8(data, 2);
      let newAuthority: Address | null;
      if (flag === 0) newAuthority = null;
      else if (flag === 1) newAuthority = readAddress(data, 3);
      else return BAD_DATA;
      const [target, currentAuthority] = accounts(ix, [0, 1]) as [Address, Address];
      return { kind: 'token-set-authority', program, target, currentAuthority, authorityType, newAuthority };
    }
    case 7:
    case 14: {
      const amount = readU64(data, 1);
      if (disc === 14) readU8(data, 9);
      const [mint, acct] = accounts(ix, [0, 1, 2]) as [Address, Address, Address];
      return { kind: 'token-mint-to', program, mint, account: acct, amount };
    }
    case 8:
    case 15: {
      const amount = readU64(data, 1);
      if (disc === 15) readU8(data, 9);
      const [acct, mint] = accounts(ix, [0, 1, 2]) as [Address, Address, Address];
      return { kind: 'token-burn', program, mint, account: acct, amount };
    }
    case 9: {
      const [acct, destination, authority] = accounts(ix, [0, 1, 2]) as [Address, Address, Address];
      return { kind: 'token-close', program, account: acct, destination, authority };
    }
    case 12: {
      const amount = readU64(data, 1);
      const decimals = readU8(data, 9);
      const [source, mint, destination, authority] = accounts(ix, [0, 1, 2, 3]) as [Address, Address, Address, Address];
      return { kind: 'token-transfer', program, source, destination, authority, amount, mint, decimals, variant: 'checked' };
    }
    case 13: {
      const amount = readU64(data, 1);
      const decimals = readU8(data, 9);
      const [source, mint, delegate, owner] = accounts(ix, [0, 1, 2, 3]) as [Address, Address, Address, Address];
      return { kind: 'token-approve', program, source, delegate, owner, amount, mint, decimals };
    }
    case 26: {
      if (program !== 'token-2022') return OTHER;
      const sub = readU8(data, 1);
      if (sub !== 1) return OTHER;
      const amount = readU64(data, 2);
      const decimals = readU8(data, 10);
      readU64(data, 11); // fee
      const [source, mint, destination, authority] = accounts(ix, [0, 1, 2, 3]) as [Address, Address, Address, Address];
      return {
        kind: 'token-transfer',
        program,
        source,
        destination,
        authority,
        amount,
        mint,
        decimals,
        variant: 'checked-with-fee',
      };
    }
    default:
      return OTHER;
  }
}

function parseAta(ix: CompiledIx): ParsedInstruction {
  const { data } = ix;
  const disc = data.length === 0 ? 0 : readU8(data, 0);
  if (disc !== 0 && disc !== 1) return OTHER;
  const [, ata, wallet, mint, , tokenProgram] = accounts(ix, [0, 1, 2, 3, 4, 5]) as [
    Address,
    Address,
    Address,
    Address,
    Address,
    Address,
  ];
  return { kind: 'ata-create', wallet, ata, mint, tokenProgram };
}

/** Parses an instruction's data and accounts; never throws. */
export function parseInstruction(ix: CompiledIx): ParsedInstruction {
  try {
    switch (ix.programAddress) {
      case PROGRAM_IDS.system:
        return parseSystem(ix);
      case PROGRAM_IDS.splToken:
        return parseToken(ix, 'spl-token');
      case PROGRAM_IDS.token2022:
        return parseToken(ix, 'token-2022');
      case PROGRAM_IDS.ata:
        return parseAta(ix);
      default:
        return OTHER;
    }
  } catch (e) {
    if (e instanceof ParseFailure) return e.parsed;
    return BAD_DATA;
  }
}

/** Pure. Top-level record: own index, stack height 1. */
export function parseCompiled(ix: CompiledIx, index: number): InstructionRecord {
  return {
    programAddress: ix.programAddress,
    topLevelIndex: index,
    inner: false,
    stackHeight: 1,
    parsed: parseInstruction(ix),
  };
}
