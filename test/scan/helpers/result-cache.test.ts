import { describe, expect, test } from 'bun:test';
import { createResultCache } from '../../../src/scan/result-cache.ts';
import type { ScanResult } from '../../../src/scan/types.ts';
import { createFakeClock } from '../../helpers/fake-clock.ts';

const result = (timedOut = false): ScanResult => ({
  link: { raw: 'https://x.example/a', kind: 'blink' },
  cluster: 'devnet',
  clusterInfo: { source: 'default' },
  verdict: 'safe',
  flags: [],
  balanceChanges: [],
  transfers: [],
  simulation: { status: 'ok' },
  explorer: { none: true },
  timedOut,
  extensions: {},
});

describe('createResultCache', () => {
  test('returns a stored result until the TTL passes', async () => {
    const fake = createFakeClock(1_000);
    const cache = createResultCache({ clock: fake.clock });
    const r = result();
    expect(cache.set('raw', 'devnet', r)).toBe(true);
    expect(cache.get('raw', 'devnet')).toBe(r);
    await fake.advance(299_999);
    expect(cache.get('raw', 'devnet')).toBe(r);
    await fake.advance(1);
    expect(cache.get('raw', 'devnet')).toBeUndefined();
  });

  test('keys by link and cluster', () => {
    const cache = createResultCache({ clock: createFakeClock().clock });
    cache.set('raw', 'devnet', result());
    expect(cache.get('raw', 'mainnet')).toBeUndefined();
    expect(cache.get('other', 'devnet')).toBeUndefined();
  });

  test('refuses timed-out results', () => {
    const cache = createResultCache({ clock: createFakeClock().clock });
    expect(cache.set('raw', 'devnet', result(true))).toBe(false);
    expect(cache.get('raw', 'devnet')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test('evicts the least recently used entry past maxEntries', () => {
    const cache = createResultCache({ clock: createFakeClock().clock, maxEntries: 2 });
    cache.set('a', 'devnet', result());
    cache.set('b', 'devnet', result());
    cache.get('a', 'devnet');
    cache.set('c', 'devnet', result());
    expect(cache.get('b', 'devnet')).toBeUndefined();
    expect(cache.get('a', 'devnet')).toBeDefined();
  });
});
