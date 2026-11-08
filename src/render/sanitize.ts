/**
 * Sanitizers for Untrusted strings (Req 11.6, 15.1).
 *
 * discordSanitizer: single line, Discord markdown escaped, mentions broken
 * with a zero-width space, URL-like tokens shown as inline code (backticks
 * removed) so Discord does not linkify them, at most 100 characters
 * including a trailing '…' when cut.
 *
 * terminalSanitizer: removes ANSI/ESC sequences and every C0/C1 control
 * character, giving a single line.
 */
import type { Untrusted } from '../scan/types.ts';

export type SanitizeFn = ((s: Untrusted | string) => string) & { clean(s: Untrusted | string): string };

export const UNTRUSTED_MAX_LENGTH = 100;
const ELLIPSIS = '…';
const ZWSP = '\u200B';

/** Every Discord markdown control character; each occurrence is backslash-escaped. */
const MARKDOWN_CHARS = new Set(['\\', '*', '_', '~', '`', '|', '>', '#', '-', '[', ']', '(', ')']);
const URL_TOKEN = /(?:https?:\/\/|www\.|solana-action:|solana:)\S*/giu;
// C0, DEL, C1, and bidi override/isolate controls (terminal spoofing).
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/gu;
const ESC_SEQUENCE =
  /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|\u001B[PX^_][^\u001B]*(?:\u001B\\)?|\u001B[ -/]*[0-~]?|\u009B[0-?]*[ -/]*[@-~]/gu;

/** One rendered unit: never split when truncating, except code spans. */
type Unit = { kind: 'text'; out: string } | { kind: 'code'; body: string };

const unitLength = (u: Unit): number => (u.kind === 'text' ? u.out.length : u.body.length + 2);

function escapeTextChar(ch: string, atStart: boolean): string {
  if (MARKDOWN_CHARS.has(ch)) return `\\${ch}`;
  if (ch === '@' || ch === '<') return `${ch}${ZWSP}`;
  if (atStart && ch === '+') return '\\+';
  return ch;
}

function toUnits(input: string): Unit[] {
  const s = input.replace(ESC_SEQUENCE, '').replace(CONTROL, ' ');
  const units: Unit[] = [];
  let last = 0;
  // "At start" = only spaces so far, where list markers would apply.
  let atStart = true;
  const pushText = (text: string) => {
    for (const ch of text) {
      units.push({ kind: 'text', out: escapeTextChar(ch, atStart) });
      if (ch !== ' ') atStart = false;
    }
  };
  for (const m of s.matchAll(URL_TOKEN)) {
    pushText(s.slice(last, m.index));
    const body = m[0].replaceAll('`', '');
    if (body.length > 0) units.push({ kind: 'code', body });
    atStart = false;
    last = m.index + m[0].length;
  }
  pushText(s.slice(last));
  // Ordered-list marker at the start ("1. "): escape the dot.
  // Leading characters are single-code-unit text units, so indexes line up.
  const lead = /^ *\d+\./u.exec(s);
  const dot = lead ? units[lead[0].length - 1] : undefined;
  if (dot?.kind === 'text' && dot.out === '.') dot.out = '\\.';
  return units;
}

function render(units: readonly Unit[]): string {
  return units.map((u) => (u.kind === 'text' ? u.out : `\`${u.body}\``)).join('');
}

/** Sanitizes for Discord with a length cap (default 100, including '…'). */
export function discordEscape(s: Untrusted | string, maxLength: number = UNTRUSTED_MAX_LENGTH): string {
  const units = toUnits(s);
  const total = units.reduce((n, u) => n + unitLength(u), 0);
  if (total <= maxLength) return render(units);
  const budget = maxLength - ELLIPSIS.length;
  const kept: Unit[] = [];
  let used = 0;
  for (const u of units) {
    const len = unitLength(u);
    if (used + len <= budget) {
      kept.push(u);
      used += len;
      continue;
    }
    if (u.kind === 'code' && budget - used >= 3) {
      // Cut inside the code span on a code-point boundary; keep it closed.
      let body = '';
      for (const ch of u.body) {
        if (body.length + ch.length + 2 > budget - used) break;
        body += ch;
      }
      if (body.length > 0) kept.push({ kind: 'code', body });
    }
    break;
  }
  return render(kept) + ELLIPSIS;
}

const withClean = (fn: (s: Untrusted | string) => string): SanitizeFn => Object.assign(fn, { clean: fn });

export const discordSanitizer: SanitizeFn = withClean((s) => discordEscape(s));

export const terminalSanitizer: SanitizeFn = withClean((s) =>
  s.replace(ESC_SEQUENCE, '').replace(/[\t\n\r]/gu, ' ').replace(CONTROL, ''),
);
