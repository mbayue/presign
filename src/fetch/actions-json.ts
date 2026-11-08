/**
 * actions.json resolver (Req 1.5, 1.12, 1.13, 1.16, 1.17, 14.8).
 */
import type { Clock } from '../scan/types.ts';
import { TtlLruCache } from './lru.ts';
import { defaultSafeFetchDeps, isDevOrigin, safeFetch } from './safe-fetch.ts';
import { ActionMetadataSchema, ActionsJsonSchema, type ActionsJson, type ActionsJsonRule } from './schemas.ts';
import { DETECTION_LIMITS, type ActionsJsonResolution, type ActionsJsonResolver, type SafeFetchDeps } from './types.ts';

export const ACTIONS_JSON_CACHE_TTL_MS = 10 * 60 * 1000;
export const ACTIONS_JSON_CACHE_MAX_ORIGINS = 1_000;

const isHttpUrl = (s: string): boolean => /^https?:\/\//i.test(s);

/**
 * Matches one rule's pathPattern against `url`. Returns the `*` captures and
 * the `/**` remainder, or null. A full-URL pattern must also match the origin.
 */
function matchPattern(pattern: string, url: URL): { stars: string[]; rest: string | undefined } | null {
  let patternPath: string;
  try {
    if (isHttpUrl(pattern)) {
      const p = new URL(pattern);
      if (p.origin !== url.origin) return null;
      patternPath = p.pathname;
    } else {
      if (!pattern.startsWith('/')) return null;
      patternPath = new URL(pattern, url.origin).pathname;
    }
  } catch {
    return null;
  }

  const pat = patternPath.split('/');
  const segs = url.pathname.split('/');
  const globTail = pat[pat.length - 1] === '**';
  const fixed = globTail ? pat.length - 1 : pat.length;

  if (globTail ? segs.length < pat.length : segs.length !== pat.length) return null;

  const stars: string[] = [];
  for (let i = 0; i < fixed; i++) {
    const p = pat[i];
    const s = segs[i];
    if (p === undefined || s === undefined) return null;
    if (p === '*') {
      if (s === '') return null;
      stars.push(s);
    } else if (p !== s) {
      return null;
    }
  }
  return { stars, rest: globTail ? segs.slice(fixed).join('/') : undefined };
}

/** Substitutes captures into apiPath: a trailing `**` segment takes the remainder, `*` segments take captures in order. */
function substitute(apiPath: string, stars: string[], rest: string | undefined): string {
  const cut = apiPath.search(/[?#]/);
  const pathPart = cut >= 0 ? apiPath.slice(0, cut) : apiPath;
  const suffix = cut >= 0 ? apiPath.slice(cut) : '';
  const parts = pathPart.split('/');
  let star = 0;
  const out = parts.map((seg, i) => {
    if (seg === '**' && i === parts.length - 1 && rest !== undefined) return rest;
    if (seg === '*' && star < stars.length) return stars[star++] ?? seg;
    return seg;
  });
  return out.join('/') + suffix;
}

/**
 * Pure. Maps `url` to its Action API URL using the first matching rule, or
 * returns null. Relative apiPaths resolve against the URL's origin, and the
 * original query string is preserved.
 */
export function matchRule(rules: ActionsJson | readonly ActionsJsonRule[], url: string | URL): string | null {
  let u: URL;
  try {
    u = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return null;
  }
  const list = Array.isArray(rules) ? (rules as readonly ActionsJsonRule[]) : (rules as ActionsJson).rules;

  for (const rule of list) {
    const m = matchPattern(rule.pathPattern, u);
    if (m === null) continue;
    try {
      const target = new URL(substitute(rule.apiPath, m.stars, m.rest), u.origin);
      if (target.protocol !== 'https:' && target.protocol !== 'http:') return null;
      if (u.search.length > 1) {
        target.search = target.search.length > 1 ? `${target.search}&${u.search.slice(1)}` : u.search;
      }
      return target.href;
    } catch {
      return null;
    }
  }
  return null;
}

type CacheEntry = { found: true; rules: ActionsJsonRule[] } | { found: false };

export type ActionsJsonResolverDeps = SafeFetchDeps & { cacheMaxEntries?: number; cacheTtlMs?: number };

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const is2xx = (status: number) => status >= 200 && status <= 299;

export function createActionsJsonResolver(deps: ActionsJsonResolverDeps = defaultSafeFetchDeps): ActionsJsonResolver {
  const clock: Clock = deps.clock ?? { now: () => Date.now() };
  const cache = new TtlLruCache<string, CacheEntry>({
    maxEntries: deps.cacheMaxEntries ?? ACTIONS_JSON_CACHE_MAX_ORIGINS,
    ttlMs: deps.cacheTtlMs ?? ACTIONS_JSON_CACHE_TTL_MS,
    clock,
  });
  const fetchDeps: SafeFetchDeps = { fetch: deps.fetch, resolve: deps.resolve, clock };

  /** Returns the cached or fetched entry, or 'blocked' when the origin may not be contacted. */
  const loadActionsJson = async (origin: string): Promise<CacheEntry | 'blocked'> => {
    const cached = cache.get(origin);
    if (cached !== undefined) return cached;

    const res = await safeFetch({ method: 'GET', url: `${origin}/actions.json`, limits: DETECTION_LIMITS }, fetchDeps);
    if (!res.ok) {
      if (res.kind === 'blocked') return 'blocked';
      // Timeouts and network/DNS errors are transient: treat as not found but do not cache (Req 1.12).
      if (res.kind === 'timeout' || res.kind === 'network') return { found: false };
      cache.set(origin, { found: false });
      return { found: false };
    }

    let entry: CacheEntry = { found: false };
    if (is2xx(res.status)) {
      const parsed = ActionsJsonSchema.safeParse(parseJson(res.bodyText));
      if (parsed.success) entry = { found: true, rules: parsed.data.rules };
    }
    cache.set(origin, entry);
    return entry;
  };

  const directDetect = async (href: string): Promise<boolean> => {
    const res = await safeFetch({ method: 'GET', url: href, limits: DETECTION_LIMITS }, fetchDeps);
    if (!res.ok || !is2xx(res.status)) return false;
    return ActionMetadataSchema.safeParse(parseJson(res.bodyText)).success;
  };

  return {
    async resolve(url: string): Promise<ActionsJsonResolution> {
      try {
        const u = new URL(url);
        if (u.protocol !== 'https:' && !isDevOrigin(u)) return { kind: 'not-blink' };

        const entry = await loadActionsJson(u.origin);
        if (entry === 'blocked') return { kind: 'not-blink' };
        if (entry.found) {
          const actionUrl = matchRule(entry.rules, u);
          if (actionUrl !== null) return { kind: 'blink', via: 'actions-json', actionUrl };
        }

        if (await directDetect(u.href)) return { kind: 'blink', via: 'direct', actionUrl: url };
        return { kind: 'not-blink' };
      } catch {
        return { kind: 'not-blink' };
      }
    },
  };
}
