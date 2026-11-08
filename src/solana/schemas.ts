/**
 * Zod schemas for every RPC response the bot reads (Req 14.5). Kit's RPC
 * client upcasts integers to bigint, so numeric fields accept bigint | number.
 *
 * The bot only calls `getMultipleAccounts`, `getAccountInfo` and
 * `simulateTransaction`. Any future `getTransaction` / `getBlock` call MUST
 * pass `maxSupportedTransactionVersion: 1` as a JSON number (not a string,
 * not 0), or v1 transactions fail to load (Req 5.5).
 */
import { type Address, isAddress } from '@solana/kit';
import { z } from 'zod';

export const AddressSchema = z.custom<Address>((v) => typeof v === 'string' && isAddress(v), {
  message: 'invalid address',
});

const IntegerSchema = z.union([z.bigint(), z.number().int()]);

/** `[data, 'base64']` as returned for `encoding: 'base64'`. */
export const Base64DataSchema = z.tuple([z.string(), z.literal('base64')]);

export const AccountInfoSchema = z.object({
  owner: AddressSchema,
  lamports: IntegerSchema,
  data: Base64DataSchema,
});
export type AccountInfo = z.infer<typeof AccountInfoSchema>;

/** `getAccountInfo(..., { encoding: 'base64' }).send()` result. */
export const AccountInfoResultSchema = z.object({ value: AccountInfoSchema.nullable() });

/** `getMultipleAccounts(..., { encoding: 'base64' }).send()` result. */
export const MultipleAccountsResultSchema = z.object({ value: z.array(AccountInfoSchema.nullable()) });

/** The `value` of a `simulateTransaction` result. */
export const SimulateResponseSchema = z.object({
  err: z.unknown().nullable(),
  logs: z.array(z.string()).nullable(),
  accounts: z.array(AccountInfoSchema.nullable()).nullable(),
  innerInstructions: z.array(z.unknown()).nullable(),
  unitsConsumed: IntegerSchema.optional(),
});
export type SimulateResponse = z.infer<typeof SimulateResponseSchema>;

/** `simulateTransaction(...).send()` result (`{ context, value }`). */
export const SimulateResultSchema = z.object({ value: SimulateResponseSchema });
