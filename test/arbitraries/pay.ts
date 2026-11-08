import fc from 'fast-check';
import type { Decimal, TransactionRequest, TransferRequest } from '../../src/scan/types.ts';
import { U64_MAX } from '../../src/links/decimal.ts';
import { arbAddress, arbDecimal, arbHttpsUrl, arbUntrustedString } from './common.ts';

/** SOL amounts: at most 9 decimal places and at most u64::MAX lamports. */
const arbSolAmount: fc.Arbitrary<Decimal> = fc
  .integer({ min: 0, max: 9 })
  .chain((scale) =>
    fc.bigInt({ min: 0n, max: U64_MAX / 10n ** BigInt(9 - scale) }).map((digits) => ({ digits, scale })),
  );

const opt = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined });

/** Valid Transfer_Requests; optional fields are absent (not `undefined`) when not generated. */
export const arbTransferRequest: fc.Arbitrary<TransferRequest> = opt(arbAddress).chain((splToken) =>
  fc
    .record({
      recipient: arbAddress,
      // Parsed without mint decimals, so spl-token amounts skip the scale and u64 checks.
      amount: opt(splToken === undefined ? arbSolAmount : arbDecimal),
      references: fc.array(arbAddress, { maxLength: 10 }),
      label: opt(arbUntrustedString),
      message: opt(arbUntrustedString),
      memo: opt(arbUntrustedString),
    })
    .map(({ recipient, amount, references, label, message, memo }) => {
      const r: TransferRequest = { type: 'transfer', recipient, references };
      if (amount !== undefined) r.amount = amount;
      if (splToken !== undefined) r.splToken = splToken;
      if (label !== undefined) r.label = label;
      if (message !== undefined) r.message = message;
      if (memo !== undefined) r.memo = memo;
      return r;
    }),
);

export const arbTransactionRequest: fc.Arbitrary<TransactionRequest> = arbHttpsUrl.map((link) => ({
  type: 'transaction',
  link,
}));
