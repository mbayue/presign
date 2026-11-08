/**
 * Transaction_Decoder (Req 5.1-5.4, 5.7-5.9). Decodes legacy, v0 and v1 wire
 * transactions with Kit's codecs and resolves v0 address lookup tables with a
 * single `getMultipleAccounts` call. Legacy and v1 never touch the RPC.
 */
import {
  type Address,
  type CompiledTransactionMessage,
  type CompiledTransactionMessageWithLifetime,
  getAddressDecoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getShortU16Decoder,
  getTransactionDecoder,
  LEGACY_TRANSACTION_SIZE_LIMIT,
  V1_TRANSACTION_SIZE_LIMIT,
} from '@solana/kit';
import { type Cluster, realSleep, type Sleep } from '../scan/types.ts';
import { MultipleAccountsResultSchema } from './schemas.ts';
import type { AccountRef, ClusterRpcs, CompiledIx, DecodedTransaction, DecodeError, ScannerRpc } from './types.ts';

export const MAX_PAYLOAD_BYTES = 64 * 1024;
export const LOOKUP_TABLE_TIMEOUT_MS = 5_000;
export const ADDRESS_LOOKUP_TABLE_PROGRAM = 'AddressLookupTab1e1111111111111111111111111' as Address;
/** Lookup table account layout: 56-byte metadata header, then 32-byte addresses. */
const LOOKUP_TABLE_META_SIZE = 56;

type WireVersion = 'legacy' | 'v0' | 'v1';
type Compiled = CompiledTransactionMessage & CompiledTransactionMessageWithLifetime;

export type DecodeWireResult =
  | { ok: true; compiled: Compiled; messageBytes: Uint8Array; wireBytes: Uint8Array; version: WireVersion }
  | { ok: false; error: DecodeError };

const fail = (code: DecodeError['code'], detail: string, version?: WireVersion): { ok: false; error: DecodeError } =>
  ({ ok: false, error: version === undefined ? { code, detail } : { code, detail, version } });

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeBase64(s: string): Uint8Array | null {
  if (!BASE64_RE.test(s)) return null;
  const pad = s.length - s.replace(/=+$/, '').length;
  if (pad > 0 && s.length % 4 !== 0) return null;
  if (s.length % 4 === 1) return null;
  return new Uint8Array(Buffer.from(s, 'base64'));
}

/** Structural version read: the v1 envelope starts with 0x81; legacy/v0 start with the signature short-vec. */
function readVersion(bytes: Uint8Array): WireVersion | 'unsupported' | 'malformed' {
  const b0 = bytes[0];
  if (b0 === undefined) return 'malformed';
  if (b0 === 0x81) return 'v1';
  if ((b0 & 0x80) !== 0) return 'unsupported';
  let sigCount: number;
  let offset: number;
  try {
    [sigCount, offset] = getShortU16Decoder().read(bytes, 0);
  } catch {
    return 'malformed';
  }
  const messageStart = offset + sigCount * 64;
  const m0 = bytes[messageStart];
  if (m0 === undefined) return 'malformed';
  if ((m0 & 0x80) === 0) return 'legacy';
  if (m0 === 0x80) return 'v0';
  return 'unsupported';
}

type CompiledIxIndexes = { program: number; accounts: number[]; data: Uint8Array };

function compiledInstructions(m: Compiled): CompiledIxIndexes[] {
  if (m.version === 1) {
    return m.instructionHeaders.map((h, i) => {
      const payload = m.instructionPayloads[i];
      return {
        program: h.programAccountIndex,
        accounts: payload ? [...payload.instructionAccountIndices] : [],
        data: new Uint8Array(payload?.instructionData ?? new Uint8Array()),
      };
    });
  }
  return m.instructions.map((ix) => ({
    program: ix.programAddressIndex,
    accounts: [...(ix.accountIndices ?? [])],
    data: new Uint8Array(ix.data ?? new Uint8Array()),
  }));
}

const lookupsOf = (m: Compiled) => (m.version === 0 ? (m.addressTableLookups ?? []) : []);

/** Structural sanity a validator would also enforce; anything else is a decode error. */
function validateCompiled(m: Compiled): string | null {
  const { numSignerAccounts: s, numReadonlySignerAccounts: rs, numReadonlyNonSignerAccounts: ru } = m.header;
  const n = m.staticAccounts.length;
  if (n === 0) return 'no static accounts';
  if (s < 1 || s > n) return 'invalid signer count';
  if (rs >= s) return 'invalid readonly signer count';
  if (ru > n - s) return 'invalid readonly unsigned count';
  if (m.version === 1) {
    if (m.numStaticAccounts !== n || m.numInstructions !== m.instructionHeaders.length) return 'invalid v1 counts';
    if (m.instructionPayloads.length !== m.instructionHeaders.length) return 'invalid v1 payloads';
  }
  const total = n + lookupsOf(m).reduce((acc, l) => acc + l.writableIndexes.length + l.readonlyIndexes.length, 0);
  for (const ix of compiledInstructions(m)) {
    if (ix.program >= n) return 'program index out of range';
    if (ix.accounts.some((a) => a >= total)) return 'account index out of range';
  }
  return null;
}

/** Pure: bytes → compiled message. Size and version checks happen here. */
export function decodeWire(base64: string): DecodeWireResult {
  if (base64.length === 0) return fail('DECODE_FAILED', 'empty payload');
  // Cheap bound before decoding: 64 KiB of bytes is at most this many base64 characters.
  if (base64.length > Math.ceil(MAX_PAYLOAD_BYTES / 3) * 4 + 4) return fail('DECODE_FAILED', 'payload too large');
  const wireBytes = decodeBase64(base64);
  if (wireBytes === null) return fail('DECODE_FAILED', 'not base64');
  if (wireBytes.length === 0) return fail('DECODE_FAILED', 'empty payload');
  if (wireBytes.length > MAX_PAYLOAD_BYTES) return fail('DECODE_FAILED', 'payload too large');

  const version = readVersion(wireBytes);
  if (version === 'malformed') return fail('DECODE_FAILED', 'truncated transaction');
  if (version === 'unsupported') return fail('UNSUPPORTED_VERSION', 'unsupported transaction version');

  const limit = version === 'v1' ? V1_TRANSACTION_SIZE_LIMIT : LEGACY_TRANSACTION_SIZE_LIMIT;
  if (wireBytes.length > limit) {
    return fail('TX_TOO_LARGE', `${wireBytes.length} bytes exceeds ${limit}`, version);
  }

  let compiled: Compiled;
  let messageBytes: Uint8Array;
  try {
    const tx = getTransactionDecoder().decode(wireBytes);
    messageBytes = new Uint8Array(tx.messageBytes);
    const [message, end] = getCompiledTransactionMessageDecoder().read(messageBytes, 0);
    if (end !== messageBytes.length) return fail('DECODE_FAILED', 'trailing bytes after message', version);
    compiled = message;
  } catch {
    return fail('DECODE_FAILED', 'malformed transaction', version);
  }
  const expected = version === 'legacy' ? 'legacy' : version === 'v0' ? 0 : 1;
  if (compiled.version !== expected) return fail('DECODE_FAILED', 'version mismatch', version);
  const invalid = validateCompiled(compiled);
  if (invalid !== null) return fail('DECODE_FAILED', invalid, version);

  return { ok: true, compiled, messageBytes, wireBytes, version };
}

type Sleeper = { sleep: Sleep };

/** One getMultipleAccounts for all tables; any failure leaves tables out of the map. */
async function fetchLookupTables(rpc: ScannerRpc, tables: Address[], deps: Sleeper): Promise<Map<Address, Address[]>> {
  const out = new Map<Address, Address[]>();
  const request = new AbortController();
  const timer = new AbortController();
  const TIMEOUT = Symbol('timeout');
  const timeout = deps.sleep(LOOKUP_TABLE_TIMEOUT_MS, timer.signal).then(
    () => {
      request.abort();
      return TIMEOUT;
    },
    () => new Promise<never>(() => {}),
  );
  let raw: unknown;
  try {
    const pending = rpc.getMultipleAccounts(tables, { encoding: 'base64' }).send({ abortSignal: request.signal });
    raw = await Promise.race([pending, timeout]);
  } catch {
    return out;
  } finally {
    timer.abort();
  }
  if (raw === TIMEOUT) return out;
  const parsed = MultipleAccountsResultSchema.safeParse(raw);
  if (!parsed.success || parsed.data.value.length !== tables.length) return out;

  const addressDecoder = getAddressDecoder();
  const base64 = getBase64Encoder();
  parsed.data.value.forEach((account, i) => {
    const table = tables[i];
    if (!account || table === undefined || account.owner !== ADDRESS_LOOKUP_TABLE_PROGRAM) return;
    let data: Uint8Array;
    try {
      data = new Uint8Array(base64.encode(account.data[0]));
    } catch {
      return;
    }
    if (data.length < LOOKUP_TABLE_META_SIZE) return;
    const count = Math.floor((data.length - LOOKUP_TABLE_META_SIZE) / 32);
    const addresses: Address[] = [];
    for (let k = 0; k < count; k++) {
      const start = LOOKUP_TABLE_META_SIZE + k * 32;
      addresses.push(addressDecoder.decode(data.subarray(start, start + 32)));
    }
    out.set(table, addresses);
  });
  return out;
}

function staticRefs(m: Compiled): AccountRef[] {
  const { numSignerAccounts: s, numReadonlySignerAccounts: rs, numReadonlyNonSignerAccounts: ru } = m.header;
  const n = m.staticAccounts.length;
  return m.staticAccounts.map((address, i) => {
    const signer = i < s;
    const writable = signer ? i < s - rs : i < n - ru;
    return { kind: 'resolved', address, writable, signer };
  });
}

export async function decodeTransaction(
  base64: string,
  cluster: Cluster,
  deps: { rpcs: ClusterRpcs; sleep?: Sleep },
): Promise<{ ok: true; tx: DecodedTransaction } | { ok: false; error: DecodeError }> {
  const wire = decodeWire(base64);
  if (!wire.ok) return wire;
  const { compiled } = wire;

  const lookups = lookupsOf(compiled).map((l) => ({
    table: l.lookupTableAddress,
    writableIndexes: [...l.writableIndexes],
    readonlyIndexes: [...l.readonlyIndexes],
  }));

  let tables = new Map<Address, Address[]>();
  if (compiled.version === 0 && lookups.length > 0) {
    const unique = [...new Set(lookups.map((l) => l.table))];
    tables = await fetchLookupTables(deps.rpcs[cluster], unique, { sleep: deps.sleep ?? realSleep });
  }

  const resolveLookup = (table: Address, index: number, writable: boolean): AccountRef => {
    const address = tables.get(table)?.[index];
    return address === undefined
      ? { kind: 'unresolved', table, index, writable }
      : { kind: 'resolved', address, writable, signer: false };
  };

  const accountList: AccountRef[] = [
    ...staticRefs(compiled),
    ...lookups.flatMap((l) => l.writableIndexes.map((i) => resolveLookup(l.table, i, true))),
    ...lookups.flatMap((l) => l.readonlyIndexes.map((i) => resolveLookup(l.table, i, false))),
  ];

  const instructions: CompiledIx[] = compiledInstructions(compiled).map((ix) => ({
    // validateCompiled guarantees program indexes point at static accounts.
    programAddress: compiled.staticAccounts[ix.program] as Address,
    accounts: ix.accounts.map((i) => accountList[i] as AccountRef),
    data: ix.data,
  }));

  const feePayer = compiled.staticAccounts[0] as Address;
  return {
    ok: true,
    tx: {
      version: compiled.version,
      feePayer,
      staticAccounts: [...compiled.staticAccounts],
      lookups,
      accountList,
      instructions,
      messageBase64: Buffer.from(wire.messageBytes).toString('base64'),
      wireBase64: Buffer.from(wire.wireBytes).toString('base64'),
      unresolvedCount: accountList.filter((a) => a.kind === 'unresolved').length,
    },
  };
}
