/**
 * Pure candidate extraction for the Link_Detector (Req 1.9, 1.10).
 */

export type Candidate = { text: string; position: number };

export const MAX_CANDIDATES = 3;

const PREFIXES = ['https://', 'http://', 'solana-action:', 'solana:'] as const;

/** Tokens are separated by whitespace and by `<`, `>`, `(`, `"` (so `[x](https://…)` yields the URL). */
const TOKEN_RE = /[^\s<>("]+/g;
const TRAILING_RE = /[.,)!?]+$/;

function matchesPrefix(token: string): boolean {
  const lower = token.toLowerCase();
  return PREFIXES.some((p) => lower.startsWith(p) && token.length > p.length);
}

/**
 * Finds URL-like tokens (`https://`, `http://`, `solana:`, `solana-action:`), strips `<` `>` and trailing
 * `.,)!?`, dedupes by stripped text and keeps the first 3 in order of first appearance. Every URL-like
 * token counts toward the limit, including HTTPS URLs that will only be probed.
 */
export function extractCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(TOKEN_RE)) {
    const stripped = m[0].replace(/[<>]/g, '').replace(TRAILING_RE, '');
    if (!matchesPrefix(stripped)) continue;
    if (seen.has(stripped)) continue;
    seen.add(stripped);
    out.push({ text: stripped, position: m.index });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}
