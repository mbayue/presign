import { describe, expect, test } from 'bun:test';
import {
  type Address,
  getAddressDecoder,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionEncoder,
  type SignatureBytes,
  type Transaction,
  type TransactionMessageBytes,
} from '@solana/kit';
import fc from 'fast-check';
import { ADDRESS_LOOKUP_TABLE_PROGRAM, decodeTransaction, decodeWire } from '../../src/solana/decoder.ts';
import type { Sleep } from '../../src/scan/types.ts';
import { type ArbMessage, arbCompiledMessage, arbLookupTable } from '../arbitraries/message.ts';
import { createFakeClusterRpcs, type FakeRoute, fakeAccount, withContext } from '../helpers/fake-rpc.ts';
import legacyFixture from '../fixtures/transactions/legacy.json';
import v0Fixture from '../fixtures/transactions/v0.json';
import v1Fixture from '../fixtures/transactions/v1.json';

const addr = (k: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(k));
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** Wire transaction for a compiled message with zero signatures for every signer. */
function wireOf(message: ArbMessage): Uint8Array {
  const messageBytes = getCompiledTransactionMessageEncoder().encode(message) as TransactionMessageBytes;
  const signers = message.staticAccounts.slice(0, message.header.numSignerAccounts);
  const signatures = Object.fromEntries(signers.map((a) => [a, new Uint8Array(64) as SignatureBytes]));
  const tx: Transaction = { messageBytes, signatures };
  return new Uint8Array(getTransactionEncoder().encode(tx));
}

/** Lookup table account data: 56-byte metadata header, then 32-byte addresses. */
const lookupTableData = (addresses: Address[]): Uint8Array => {
  const data = new Uint8Array(56 + addresses.length * 32);
  addresses.forEach((a, i) => data.set(getAddressEncoder().encode(a), 56 + i * 32));
  return data;
};

const altRoute = (tables: Record<string, Address[]>): FakeRoute => ({
  method: 'getMultipleAccounts',
  reply: {
    result: withContext(
      Object.values(tables).map((list) => fakeAccount({ owner: ADDRESS_LOOKUP_TABLE_PROGRAM, data: lookupTableData(list) })),
    ),
  },
});

const noTimeoutSleep: Sleep = (_ms, signal) =>
  new Promise<void>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));

describe('decodeWire rejections', () => {
  test('empty payload', () => {
    const r = decodeWire('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('DECODE_FAILED');
  });

  test.each(['not base64!', 'AAAA AAAA', 'AA=A', 'A'])('non-base64 %p', (s) => {
    const r = decodeWire(s);
    expect(r.ok ? null : r.error.code).toBe('DECODE_FAILED');
  });

  test('more than 64 KiB is DECODE_FAILED', () => {
    const r = decodeWire(b64(new Uint8Array(64 * 1024 + 1).fill(1)));
    expect(r.ok ? null : r.error.code).toBe('DECODE_FAILED');
  });

  test('legacy/v0 over 1,232 bytes and v1 over 4,096 bytes are TX_TOO_LARGE', () => {
    const legacy = new Uint8Array(1_233);
    legacy[0] = 1; // one signature, then a legacy header byte (high bit clear)
    expect(decodeWire(b64(legacy))).toEqual({ ok: false, error: { code: 'TX_TOO_LARGE', detail: expect.any(String), version: 'legacy' } });
    const v0 = new Uint8Array(1_233);
    v0[0] = 1;
    v0[65] = 0x80;
    expect(decodeWire(b64(v0))).toMatchObject({ ok: false, error: { code: 'TX_TOO_LARGE', version: 'v0' } });
    const v1 = new Uint8Array(4_097);
    v1[0] = 0x81;
    expect(decodeWire(b64(v1))).toMatchObject({ ok: false, error: { code: 'TX_TOO_LARGE', version: 'v1' } });
    const v1Ok = new Uint8Array(2_000);
    v1Ok[0] = 0x81;
    expect(decodeWire(b64(v1Ok))).toMatchObject({ ok: false, error: { code: 'DECODE_FAILED' } });
  });

  test('unknown version prefixes are UNSUPPORTED_VERSION', () => {
    for (const b0 of [0x82, 0x80, 0xff]) {
      const bytes = new Uint8Array(200);
      bytes[0] = b0;
      expect(decodeWire(b64(bytes))).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_VERSION' } });
    }
    const v2Message = new Uint8Array(200);
    v2Message[0] = 1;
    v2Message[65] = 0x82;
    expect(decodeWire(b64(v2Message))).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_VERSION' } });
  });

  test('garbage that passes the prefix checks is DECODE_FAILED', () => {
    const bytes = new Uint8Array(100);
    bytes[0] = 1;
    expect(decodeWire(b64(bytes))).toMatchObject({ ok: false, error: { code: 'DECODE_FAILED' } });
  });
});

describe('decodeTransaction', () => {
  test('v0 lookup tables resolve in validator order with one getMultipleAccounts call', async () => {
    const table = Object.keys(v0Fixture.lookupTables)[0] as Address;
    const entries = (v0Fixture.lookupTables as Record<string, string[]>)[table] as Address[];
    const { rpcs, calls } = createFakeClusterRpcs({ devnet: [altRoute({ [table]: entries })] });
    const r = await decodeTransaction(v0Fixture.base64, 'devnet', { rpcs, sleep: noTimeoutSleep });
    if (!r.ok) throw new Error(r.error.detail);
    expect(calls.devnet.map((c) => c.method)).toEqual(['getMultipleAccounts']);
    expect(calls.mainnet).toEqual([]);
    expect(calls.devnet[0]?.params[0]).toEqual([table]);
    expect(r.tx.version).toBe(0);
    expect(r.tx.unresolvedCount).toBe(0);
    expect(r.tx.accountList.map((a): unknown => (a.kind === 'resolved' ? [a.address, a.writable, a.signer] : null))).toEqual([
      [addr(1), true, true],
      ['11111111111111111111111111111111', false, false],
      ['MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', false, false],
      [entries[2], true, false],
      [entries[0], false, false],
    ]);
    const [transfer, memo] = r.tx.instructions;
    expect(transfer?.programAddress).toBe('11111111111111111111111111111111' as Address);
    expect(transfer?.accounts.map((a) => (a.kind === 'resolved' ? a.address : null))).toEqual([addr(1), entries[2]!]);
    expect(memo?.accounts[0]).toEqual({ kind: 'resolved', address: entries[0]!, writable: false, signer: false });
    expect(r.tx.wireBase64).toBe(v0Fixture.base64);
    expect(r.tx.feePayer).toBe(addr(1));
  });

  test('v0 table fetch failure or timeout leaves accounts unresolved', async () => {
    const table = Object.keys(v0Fixture.lookupTables)[0] as Address;
    for (const route of [
      { method: 'getMultipleAccounts', reply: { rpcError: { code: -32000, message: 'boom' } } },
      { method: 'getMultipleAccounts', reply: { result: withContext([null]) } },
      { method: 'getMultipleAccounts', reply: { hang: true } },
    ] satisfies FakeRoute[]) {
      const { rpcs } = createFakeClusterRpcs([route]);
      const immediateTimeout: Sleep = () => Promise.resolve();
      const r = await decodeTransaction(v0Fixture.base64, 'mainnet', { rpcs, sleep: immediateTimeout });
      if (!r.ok) throw new Error(r.error.detail);
      expect(r.tx.unresolvedCount).toBe(2);
      expect(r.tx.accountList.slice(3)).toEqual([
        { kind: 'unresolved', table, index: 2, writable: true },
        { kind: 'unresolved', table, index: 0, writable: false },
      ]);
    }
  });

  test('out-of-range lookup index is unresolved', async () => {
    const table = Object.keys(v0Fixture.lookupTables)[0] as Address;
    const { rpcs } = createFakeClusterRpcs([altRoute({ [table]: [addr(10)] })]);
    const r = await decodeTransaction(v0Fixture.base64, 'mainnet', { rpcs, sleep: noTimeoutSleep });
    if (!r.ok) throw new Error(r.error.detail);
    expect(r.tx.accountList[3]).toEqual({ kind: 'unresolved', table, index: 2, writable: true });
    expect(r.tx.accountList[4]).toEqual({ kind: 'resolved', address: addr(10), writable: false, signer: false });
    expect(r.tx.unresolvedCount).toBe(1);
  });

  test.each([
    ['legacy', legacyFixture.base64, 'legacy'],
    ['v1', v1Fixture.base64, 1],
  ] as const)('%s decodes from static keys only and makes no RPC call', async (_name, base64, version) => {
    const { rpcs, calls } = createFakeClusterRpcs([]);
    const r = await decodeTransaction(base64, 'mainnet', { rpcs });
    if (!r.ok) throw new Error(r.error.detail);
    expect(calls.mainnet).toEqual([]);
    expect(calls.devnet).toEqual([]);
    expect(r.tx.version).toBe(version);
    expect(r.tx.lookups).toEqual([]);
    expect(r.tx.unresolvedCount).toBe(0);
    expect(r.tx.feePayer).toBe(addr(1));
    const transfer = r.tx.instructions.at(-1);
    expect(transfer?.programAddress).toBe('11111111111111111111111111111111' as Address);
    expect(transfer?.accounts.map((a) => (a.kind === 'resolved' ? a.address : null))).toEqual([addr(1), addr(2)]);
    expect(Buffer.from(r.tx.messageBase64, 'base64')[0]).toBe(version === 1 ? 0x81 : 1);
  });
});

describe('round trip', () => {
  const roundTrip = (messageBytes: Uint8Array) => {
    const decoded = getCompiledTransactionMessageDecoder().decode(messageBytes);
    const reencoded = new Uint8Array(getCompiledTransactionMessageEncoder().encode(decoded));
    expect<Uint8Array>(reencoded).toEqual(messageBytes);
    expect(getCompiledTransactionMessageDecoder().decode(reencoded)).toEqual(decoded);
    return decoded;
  };

  test.each([
    ['legacy', legacyFixture.base64],
    ['v0', v0Fixture.base64],
    ['v1', v1Fixture.base64],
  ])('fixture %s round-trips', (_name, base64) => {
    const wire = decodeWire(base64);
    if (!wire.ok) throw new Error(wire.error.detail);
    expect(roundTrip(wire.messageBytes)).toEqual(wire.compiled);
  });

  for (const version of ['legacy', 0, 1] as const) {
    // Feature: solana-scanner-bot, Property 15: Transaction message round trip
    test(`Property 15: ${version} message round trip`, () => {
      fc.assert(
        fc.property(arbCompiledMessage(version), (message) => {
          const wire = wireOf(message);
          const result = decodeWire(b64(wire));
          if (!result.ok) throw new Error(`${result.error.code}: ${result.error.detail}`);
          expect(result.compiled).toEqual(message);
          const decoded = roundTrip(result.messageBytes);
          expect(decoded.version).toBe(message.version);
          expect(decoded.staticAccounts[0]).toBe(message.staticAccounts[0]!);
        }),
        { numRuns: 200 },
      );
    });
  }

  test('arbLookupTable data resolves through the decoder', async () => {
    await fc.assert(
      fc.asyncProperty(arbLookupTable, async (table) => {
        const message: ArbMessage = {
          version: 0,
          header: { numSignerAccounts: 1, numReadonlySignerAccounts: 0, numReadonlyNonSignerAccounts: 1 },
          staticAccounts: [addr(1), addr(3)],
          lifetimeToken: addr(4) as unknown as ArbMessage['lifetimeToken'],
          instructions: [{ programAddressIndex: 1, accountIndices: [2] }],
          addressTableLookups: [{ lookupTableAddress: table.address, writableIndexes: [], readonlyIndexes: [0] }],
        };
        const { rpcs } = createFakeClusterRpcs([
          {
            method: 'getMultipleAccounts',
            reply: { result: withContext([fakeAccount({ owner: ADDRESS_LOOKUP_TABLE_PROGRAM, data: table.data })]) },
          },
        ]);
        const r = await decodeTransaction(b64(wireOf(message)), 'mainnet', { rpcs, sleep: noTimeoutSleep });
        if (!r.ok) throw new Error(r.error.detail);
        const ref = r.tx.accountList[2];
        if (table.addresses.length === 0) expect(ref?.kind).toBe('unresolved');
        else expect(ref).toEqual({ kind: 'resolved', address: table.addresses[0]!, writable: false, signer: false });
      }),
      { numRuns: 50 },
    );
  });
});
