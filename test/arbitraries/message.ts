/**
 * fast-check arbitraries for compiled transaction messages (legacy, v0, v1)
 * and address lookup table accounts. Generated messages are structurally
 * valid (header counts, program indexes on static keys, account indexes in
 * range) and shaped exactly like Kit's decoder output, so decoded values can
 * be compared with `toEqual`.
 */
import {
  type Address,
  type CompiledTransactionMessage,
  type CompiledTransactionMessageWithLifetime,
  getAddressDecoder,
  getBase58Decoder,
} from '@solana/kit';
import fc from 'fast-check';

export type ArbMessage = CompiledTransactionMessage & CompiledTransactionMessageWithLifetime;
type Lifetime = CompiledTransactionMessageWithLifetime['lifetimeToken'];

const bytes32 = fc.uint8Array({ minLength: 32, maxLength: 32 });
export const arbAddress: fc.Arbitrary<Address> = bytes32.map((b) => getAddressDecoder().decode(b));
const arbLifetime: fc.Arbitrary<Lifetime> = bytes32.map((b) => getBase58Decoder().decode(b) as Lifetime);

const arbUniqueAddresses = (min: number, max: number) =>
  fc.uniqueArray(bytes32, { minLength: min, maxLength: max, selector: (b) => Buffer.from(b).toString('hex') }).map(
    (list) => list.map((b) => getAddressDecoder().decode(b)),
  );

const arbHeader = (n: number) =>
  fc.integer({ min: 1, max: Math.min(n, 4) }).chain((s) =>
    fc.record({
      numSignerAccounts: fc.constant(s),
      numReadonlySignerAccounts: fc.integer({ min: 0, max: s - 1 }),
      numReadonlyNonSignerAccounts: fc.integer({ min: 0, max: n - s }),
    }),
  );

type RawIx = { program: number; accounts: number[]; data: Uint8Array };
const arbRawIxs = (numStatic: number, total: number) =>
  fc.array(
    fc.record({
      program: fc.integer({ min: 0, max: numStatic - 1 }),
      accounts: fc.array(fc.integer({ min: 0, max: total - 1 }), { maxLength: 6 }),
      data: fc.uint8Array({ maxLength: 40 }),
    }),
    { maxLength: 4 },
  );

/** Legacy/v0 compiled instruction, omitting empty fields the way Kit's decoder does. */
const toLegacyIx = (ix: RawIx) => ({
  programAddressIndex: ix.program,
  ...(ix.accounts.length ? { accountIndices: ix.accounts } : {}),
  ...(ix.data.byteLength ? { data: ix.data } : {}),
});

const arbLookups = fc.array(
  fc.record({
    lookupTableAddress: arbAddress,
    writableIndexes: fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 3 }),
    readonlyIndexes: fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 3 }),
  }),
  { maxLength: 2 },
);

// Config mask bits and value kinds, in the positional order Kit encodes them.
const CONFIG_FIELDS = [
  { bits: 3, kind: 'u64' as const },
  { bits: 4, kind: 'u32' as const },
  { bits: 8, kind: 'u32' as const },
  { bits: 16, kind: 'u32' as const },
];
const arbConfig = fc
  .tuple(
    fc.option(fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), { nil: undefined }),
    fc.option(fc.nat({ max: 0xffff_ffff }), { nil: undefined }),
    fc.option(fc.nat({ max: 0xffff_ffff }), { nil: undefined }),
    fc.option(fc.nat({ max: 0xffff_ffff }), { nil: undefined }),
  )
  .map((fields) => {
    let configMask = 0;
    const configValues: ({ kind: 'u32'; value: number } | { kind: 'u64'; value: bigint })[] = [];
    fields.forEach((value, i) => {
      const f = CONFIG_FIELDS[i]!;
      if (value === undefined) return;
      configMask |= f.bits;
      configValues.push(f.kind === 'u64' ? { kind: 'u64', value: value as bigint } : { kind: 'u32', value: value as number });
    });
    return { configMask, configValues };
  });

export function arbCompiledMessage(version: 'legacy' | 0 | 1): fc.Arbitrary<ArbMessage> {
  return arbUniqueAddresses(1, 10).chain((staticAccounts) => {
    const n = staticAccounts.length;
    const header = arbHeader(n);
    if (version === 1) {
      return fc
        .record({ header, lifetimeToken: arbLifetime, ixs: arbRawIxs(n, n), config: arbConfig })
        .map(
          ({ header, lifetimeToken, ixs, config }): ArbMessage => ({
            version: 1,
            header,
            staticAccounts,
            lifetimeToken,
            configMask: config.configMask,
            configValues: config.configValues,
            numInstructions: ixs.length,
            numStaticAccounts: n,
            instructionHeaders: ixs.map((ix) => ({
              programAccountIndex: ix.program,
              numInstructionAccounts: ix.accounts.length,
              numInstructionDataBytes: ix.data.byteLength,
            })),
            instructionPayloads: ixs.map((ix) => ({ instructionAccountIndices: ix.accounts, instructionData: ix.data })),
          }),
        );
    }
    if (version === 'legacy') {
      return fc
        .record({ header, lifetimeToken: arbLifetime, ixs: arbRawIxs(n, n) })
        .map(
          ({ header, lifetimeToken, ixs }): ArbMessage => ({
            version: 'legacy',
            header,
            staticAccounts,
            lifetimeToken,
            instructions: ixs.map(toLegacyIx),
          }),
        );
    }
    return arbLookups.chain((lookups) => {
      const total = n + lookups.reduce((acc, l) => acc + l.writableIndexes.length + l.readonlyIndexes.length, 0);
      return fc.record({ header, lifetimeToken: arbLifetime, ixs: arbRawIxs(n, total) }).map(
        ({ header, lifetimeToken, ixs }): ArbMessage => ({
          version: 0,
          header,
          staticAccounts,
          lifetimeToken,
          instructions: ixs.map(toLegacyIx),
          ...(lookups.length ? { addressTableLookups: lookups } : {}),
        }),
      );
    });
  });
}

/** An address lookup table account: its address, its entries, and the raw account data (56-byte header + keys). */
export const arbLookupTable: fc.Arbitrary<{ address: Address; addresses: Address[]; data: Uint8Array }> = fc
  .record({ address: arbAddress, entries: fc.array(bytes32, { maxLength: 8 }), meta: fc.uint8Array({ minLength: 56, maxLength: 56 }) })
  .map(({ address, entries, meta }) => {
    const data = new Uint8Array(56 + entries.length * 32);
    data.set(meta, 0);
    entries.forEach((e, i) => data.set(e, 56 + i * 32));
    return { address, addresses: entries.map((e) => getAddressDecoder().decode(e)), data };
  });
