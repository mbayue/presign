/**
 * Link_Detector (Requirement 1). Syntactic classification is pure; HTTPS URLs that match no
 * syntactic form are resolved through the injected `ActionsJsonResolver` (Req 1.5, 1.13).
 */
import { isDevOrigin } from '../fetch/dev-origin.ts';
import type { ActionsJsonResolver } from '../fetch/types.ts';
import type { ScannableLink, TransactionRequest, TransferRequest } from '../scan/types.ts';
import { extractCandidates } from './candidates.ts';
import { parsePayLink } from './pay-link.ts';

export type SyntacticClass =
  | { kind: 'blink'; via: 'solana-action' | 'dial.to'; actionUrl: string }
  | { kind: 'transfer-request'; request: TransferRequest }
  | { kind: 'transaction-request'; request: TransactionRequest }
  /** https URL (or allowlisted http) to check through actions.json / direct GET. */
  | { kind: 'probe'; url: string }
  | { kind: 'none' };

export interface DetectorDeps {
  actions: ActionsJsonResolver;
}

const NONE: SyntacticClass = { kind: 'none' };
const SOLANA_ACTION = 'solana-action:';
const ABSOLUTE_HTTP_RE = /^https?:\/\//i;

const startsWithCI = (s: string, prefix: string): boolean => s.slice(0, prefix.length).toLowerCase() === prefix;

/** Absolute https URL with a host, or an http URL on the Dev_Origin_Allowlist (Req 1.1, 1.14). */
function parseAllowedUrl(s: string): URL | null {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol === 'https:' && u.hostname !== '') return u;
  if (u.protocol === 'http:' && isDevOrigin(u)) return u;
  return null;
}

/**
 * The inner Action URL may be given literally (`https://…`) or percent-encoded (`https%3A%2F%2F…`).
 * A literal URL is kept as-is so its own escapes survive; otherwise it is decoded once.
 */
function resolveInnerActionUrl(inner: string): string | null {
  let candidate = inner;
  if (!ABSOLUTE_HTTP_RE.test(candidate)) {
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      return null;
    }
  }
  return parseAllowedUrl(candidate) ? candidate : null;
}

/** Pure. Criteria 1.1–1.4, 1.14, 1.15. */
export function classifySyntactic(candidate: string): SyntacticClass {
  if (startsWithCI(candidate, SOLANA_ACTION)) {
    const actionUrl = resolveInnerActionUrl(candidate.slice(SOLANA_ACTION.length));
    return actionUrl === null ? NONE : { kind: 'blink', via: 'solana-action', actionUrl };
  }

  if (startsWithCI(candidate, 'solana:')) {
    const parsed = parsePayLink(candidate);
    if (!parsed.ok) return NONE;
    return parsed.value.type === 'transfer'
      ? { kind: 'transfer-request', request: parsed.value }
      : { kind: 'transaction-request', request: parsed.value };
  }

  if (!ABSOLUTE_HTTP_RE.test(candidate)) return NONE;
  const u = parseAllowedUrl(candidate);
  if (u === null) return NONE; // includes non-allowlisted http (Req 1.14)

  if (u.protocol === 'https:' && u.hostname === 'dial.to') {
    const action = u.searchParams.get('action');
    if (action !== null && action !== '') {
      const inner = startsWithCI(action, SOLANA_ACTION) ? action.slice(SOLANA_ACTION.length) : action;
      const actionUrl = resolveInnerActionUrl(inner);
      return actionUrl === null ? NONE : { kind: 'blink', via: 'dial.to', actionUrl };
    }
  }

  return { kind: 'probe', url: candidate };
}

/**
 * Finds Scannable_Links in message text, in message order. A resolver error or `not-blink` drops only
 * that candidate (Req 1.13).
 */
export async function detectLinks(text: string, deps: DetectorDeps): Promise<ScannableLink[]> {
  const candidates = extractCandidates(text);
  const resolved = await Promise.all(
    candidates.map(async (c): Promise<ScannableLink | null> => {
      const cls = classifySyntactic(c.text);
      switch (cls.kind) {
        case 'blink':
          return { kind: 'blink', raw: c.text, via: cls.via, actionUrl: cls.actionUrl };
        case 'transfer-request':
          return { kind: 'transfer-request', raw: c.text, request: cls.request };
        case 'transaction-request':
          return { kind: 'transaction-request', raw: c.text, request: cls.request };
        case 'none':
          return null;
        case 'probe': {
          try {
            const res = await deps.actions.resolve(cls.url);
            if (res.kind !== 'blink') return null;
            return { kind: 'blink', raw: c.text, via: res.via, actionUrl: res.actionUrl };
          } catch {
            return null;
          }
        }
      }
    }),
  );
  return resolved.filter((l): l is ScannableLink => l !== null);
}

/** Pure gate for Req 1.6–1.8, 1.11. An empty watched list means every viewable channel is watched. */
export function shouldScanMessage(m: {
  inGuild: boolean;
  authorIsBot: boolean;
  channelId: string;
  watched: readonly string[];
  botCanViewChannel: boolean;
}): boolean {
  if (!m.inGuild || m.authorIsBot || !m.botCanViewChannel) return false;
  return m.watched.length === 0 || m.watched.includes(m.channelId);
}
