/**
 * Risk_Engine contracts (design "Risk_Engine" section). RiskInput contains no
 * Untrusted field, so untrusted text cannot influence Flags or the Verdict.
 */
import type { Address } from '@solana/kit';
import type { InstructionRecord, MintView, TokenAccountView } from '../solana/types.ts';
import type { Flag, RuleId, SimError, TransferEntry, Verdict } from '../scan/types.ts';

export type BalanceSnapshot = {
  sol: { pre: bigint; post: bigint };
  /** Summed per mint across the subject's token accounts. */
  tokens: { mint: Address; pre: bigint; post: bigint; decimals?: number }[];
};

export interface RiskInput {
  /** Placeholder_Account (or fee payer for Optional Req 21). */
  subject: Address;
  knownPrograms: ReadonlySet<Address>;
  topLevel: InstructionRecord[];
  /** Empty unless simulation status is 'ok'. */
  inner: InstructionRecord[];
  simulation: { status: 'ok'; balances: BalanceSnapshot } | { status: 'failed'; error: SimError } | { status: 'unavailable' };
  /** Token accounts read before simulation, keyed by token account address. */
  preTokenAccounts: Map<Address, TokenAccountView>;
  mints: Map<Address, MintView>;
  context: {
    /** Req 5.3 */
    unresolvedAccounts: boolean;
    /** Req 4.6 */
    amountUnspecified: boolean;
    /** Req 14.10 */
    invalidResponses: ('rpc' | 'link-server')[];
  };
}

export interface RiskOutput {
  flags: Flag[];
  verdict: Verdict;
  transfers: TransferEntry[];
}

/** Thrown (or signalled) by a rule that lacks the input it needs → RULE_UNEVALUATED. */
export class CannotEvaluate extends Error {
  constructor() {
    super('cannot evaluate');
    this.name = 'CannotEvaluate';
  }
}

export interface FlagSink {
  add(flag: Flag): void;
  transfer(entry: TransferEntry): void;
}

export type RiskRule = { id: RuleId; run(input: RiskInput, out: FlagSink): void };
