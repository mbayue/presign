/**
 * Cleans model output before it reaches a card (Req 10.3, 10.4; Property 33).
 * Pure. Removes reasoning blocks, Discord mentions, @everyone/@here and URLs,
 * keeps at most two sentences and caps the text at 300 characters.
 */

export const MAX_SUMMARY_CHARS = 300;
const MAX_SENTENCES = 2;

const THINK_CLOSED = /<think\b[^>]*>[\s\S]*?<\/think\s*>/gi;
const THINK_UNCLOSED = /<think\b[^>]*>[\s\S]*$/i;
const THINK_STRAY_CLOSE = /<\/think\s*>/gi;
/** `[text](target)` → `text`. */
const MASKED_LINK = /\[([^[\]]*)\]\([^)]*\)/g;
const MENTION = /<(?:@[!&]?|#)\d+>/g;
const MASS_MENTION = /@(?:everyone|here)/gi;
/** http(s)://, www. — removed up to the next whitespace. */
const WEB_URL = /(?:https?:\/\/|www\.)\S*/gi;
/** solana-action: always; solana: only when something follows, so "Solana: …" prose survives. */
const SOLANA_URL = /solana-action:\S*|solana:\S+/gi;
const SENTENCE_END = /[.!?](?=\s|$)/g;

function stripOnce(text: string): string {
  return text
    .replace(THINK_CLOSED, ' ')
    .replace(THINK_UNCLOSED, ' ')
    .replace(THINK_STRAY_CLOSE, ' ')
    .replace(MASKED_LINK, '$1')
    .replace(MENTION, ' ')
    .replace(MASS_MENTION, ' ')
    .replace(SOLANA_URL, ' ')
    .replace(WEB_URL, ' ');
}

/** End offsets (exclusive) of every sentence end in `text`. */
function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  for (const m of text.matchAll(SENTENCE_END)) ends.push(m.index + 1);
  return ends;
}

export function postprocess(text: string): string {
  // Removing one construct can splice the pieces around it into another, so repeat to a
  // fixpoint. Every replacement is shorter than its match, so this terminates.
  let out = text;
  for (let next = stripOnce(out); next !== out; next = stripOnce(out)) out = next;
  out = out.replace(/\s+/g, ' ').trim();
  if (out === '') return '';

  const ends = sentenceEnds(out);
  const second = ends[MAX_SENTENCES - 1];
  if (second !== undefined) out = out.slice(0, second).trim();

  if (out.length > MAX_SUMMARY_CHARS) {
    const within = sentenceEnds(out).filter((e) => e <= MAX_SUMMARY_CHARS);
    const lastEnd = within[within.length - 1];
    if (lastEnd !== undefined) {
      out = out.slice(0, lastEnd).trim();
    } else {
      const head = out.slice(0, MAX_SUMMARY_CHARS - 1);
      const ws = head.lastIndexOf(' ');
      let cut = ws > 0 ? head.slice(0, ws) : head;
      // Never leave half of a surrogate pair before the ellipsis.
      if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
      cut = cut.trimEnd();
      out = cut === '' ? '' : `${cut}…`;
    }
  }
  return out;
}
