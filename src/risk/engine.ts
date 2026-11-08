import type { Flag, TransferEntry } from '../scan/types.ts';
import { flagTemplates } from './flags.ts';
import { RULES } from './rules.ts';
import type { RiskInput, RiskOutput, RiskRule } from './types.ts';
import { computeVerdict } from './verdict.ts';

/**
 * Pure. Runs `rules` in order. A rule that throws (including CannotEvaluate)
 * contributes exactly one RULE_UNEVALUATED Flag and none of its partial
 * Flags or transfers (Req 9.7). Same input → same Flags in the same order.
 */
export function evaluate(input: RiskInput, rules: readonly RiskRule[] = RULES): RiskOutput {
  const flags: Flag[] = [];
  const transfers: TransferEntry[] = [];
  for (const rule of rules) {
    const ruleFlags: Flag[] = [];
    const ruleTransfers: TransferEntry[] = [];
    try {
      rule.run(input, {
        add: (flag) => void ruleFlags.push(flag),
        transfer: (entry) => void ruleTransfers.push(entry),
      });
    } catch {
      flags.push(flagTemplates.RULE_UNEVALUATED({ ruleId: rule.id }));
      continue;
    }
    flags.push(...ruleFlags);
    transfers.push(...ruleTransfers);
  }
  return { flags, verdict: computeVerdict(flags), transfers };
}
