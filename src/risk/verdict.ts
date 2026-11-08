import type { Flag, Verdict } from '../scan/types.ts';

const RANK: Record<Verdict, number> = { safe: 0, caution: 1, danger: 2 };

export const verdictRank = (v: Verdict): number => RANK[v];

/** Pure (Req 9.1–9.5): depends only on Flag severities. */
export function computeVerdict(flags: readonly Pick<Flag, 'severity'>[]): Verdict {
  let verdict: Verdict = 'safe';
  for (const f of flags) {
    if (f.severity === 'danger') return 'danger';
    verdict = 'caution';
  }
  return verdict;
}
