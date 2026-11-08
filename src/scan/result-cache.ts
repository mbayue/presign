/**
 * Scan result cache keyed by (link raw text, Cluster), 300 s TTL (Req 11.10).
 * Timed-out results are never stored.
 */
import { TtlLruCache } from '../fetch/lru.ts';
import { type Cluster, type Clock, type ScanResult, systemClock } from './types.ts';

export interface ResultCache {
  get(raw: string, cluster: Cluster): ScanResult | undefined;
  /** Returns false when the result was refused (timed out). */
  set(raw: string, cluster: Cluster, result: ScanResult): boolean;
  readonly size: number;
}

export const RESULT_CACHE_TTL_MS = 300_000;
export const RESULT_CACHE_MAX_ENTRIES = 500;

/** Cluster names contain no NUL, so the composite key cannot collide. */
const keyOf = (raw: string, cluster: Cluster): string => `${cluster}\u0000${raw}`;

export function createResultCache(
  opts: { clock?: Clock; ttlMs?: number; maxEntries?: number } = {},
): ResultCache {
  const lru = new TtlLruCache<string, ScanResult>({
    clock: opts.clock ?? systemClock,
    ttlMs: opts.ttlMs ?? RESULT_CACHE_TTL_MS,
    maxEntries: opts.maxEntries ?? RESULT_CACHE_MAX_ENTRIES,
  });
  return {
    get: (raw, cluster) => lru.get(keyOf(raw, cluster)),
    set(raw, cluster, result) {
      if (result.timedOut) return false;
      lru.set(keyOf(raw, cluster), result);
      return true;
    },
    get size() {
      return lru.size;
    },
  };
}
