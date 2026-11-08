/**
 * Size-bounded LRU cache with a per-entry TTL (Req 1.12, 1.16, 1.17).
 * Relies on Map insertion order: the first key is the least recently used.
 */
import type { Clock } from '../scan/types.ts';

export class TtlLruCache<K, V> {
  readonly #entries = new Map<K, { value: V; storedAt: number }>();
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #clock: Clock;

  constructor(opts: { maxEntries: number; ttlMs: number; clock: Clock }) {
    if (!Number.isInteger(opts.maxEntries) || opts.maxEntries < 1) throw new RangeError('maxEntries must be >= 1');
    this.#maxEntries = opts.maxEntries;
    this.#ttlMs = opts.ttlMs;
    this.#clock = opts.clock;
  }

  /** Returns a fresh entry and marks it most recently used; expired entries are removed. */
  get(key: K): V | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    this.#entries.delete(key);
    if (this.#clock.now() - entry.storedAt >= this.#ttlMs) return undefined;
    this.#entries.set(key, entry);
    return entry.value;
  }

  /** Stores `value` as most recently used, evicting the least recently used entry when full. */
  set(key: K, value: V): void {
    this.#entries.delete(key);
    while (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, { value, storedAt: this.#clock.now() });
  }

  get size(): number {
    return this.#entries.size;
  }
}
