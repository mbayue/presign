import { describe, expect, test } from 'bun:test';
import { TtlLruCache } from '../../src/fetch/lru.ts';
import {
  ActionMetadataSchema,
  ActionPostResponseSchema,
  ActionsJsonSchema,
  TransactionRequestGetSchema,
} from '../../src/fetch/schemas.ts';
import { createFakeClock } from '../helpers/fake-clock.ts';
import metadataLinked from '../fixtures/actions/metadata-linked.json';
import metadataMissingIcon from '../fixtures/actions/metadata-missing-icon.json';
import postBad from '../fixtures/actions/post-bad-base64.json';
import postEmpty from '../fixtures/actions/post-empty.json';
import postOk from '../fixtures/actions/post-ok.json';

describe('TtlLruCache', () => {
  test('expires entries at ttl', async () => {
    const fc = createFakeClock();
    const cache = new TtlLruCache<string, number>({ maxEntries: 10, ttlMs: 100, clock: fc.clock });
    cache.set('a', 1);
    await fc.advance(99);
    expect(cache.get('a')).toBe(1);
    await fc.advance(1);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test('evicts the least recently used entry; get refreshes recency', () => {
    const fc = createFakeClock();
    const cache = new TtlLruCache<string, number>({ maxEntries: 2, ttlMs: 1_000, clock: fc.clock });
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1); // b is now least recent
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });
});

describe('schemas', () => {
  test('ActionsJsonSchema caps rules at 100', () => {
    const rule = { pathPattern: '/a', apiPath: '/b' };
    expect(ActionsJsonSchema.safeParse({ rules: Array(100).fill(rule) }).success).toBe(true);
    expect(ActionsJsonSchema.safeParse({ rules: Array(101).fill(rule) }).success).toBe(false);
  });

  test('ActionMetadataSchema requires all four strings and keeps linked actions', () => {
    const linked = ActionMetadataSchema.safeParse(metadataLinked);
    expect(linked.success && linked.data.links?.actions?.length).toBe(3);
    expect(ActionMetadataSchema.safeParse(metadataMissingIcon).success).toBe(false);
  });

  test('ActionPostResponseSchema requires non-empty decodable base64', () => {
    expect(ActionPostResponseSchema.safeParse(postOk).success).toBe(true);
    expect(ActionPostResponseSchema.safeParse(postBad).success).toBe(false);
    expect(ActionPostResponseSchema.safeParse(postEmpty).success).toBe(false);
    expect(ActionPostResponseSchema.safeParse({ transaction: 'AQI' }).success).toBe(false);
    expect(ActionPostResponseSchema.safeParse({ transaction: 5 }).success).toBe(false);
  });

  test('TransactionRequestGetSchema drops non-string fields one by one', () => {
    expect(TransactionRequestGetSchema.parse({ label: 7, icon: 'https://x.test/i.png' })).toEqual({
      label: undefined,
      icon: 'https://x.test/i.png',
    });
  });
});
