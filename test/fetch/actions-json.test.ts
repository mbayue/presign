import { describe, expect, test } from 'bun:test';
import { createActionsJsonResolver, matchRule } from '../../src/fetch/actions-json.ts';
import type { ActionsJson } from '../../src/fetch/schemas.ts';
import { createFakeClock } from '../helpers/fake-clock.ts';
import { createFakeFetch, createFakeResolve } from '../helpers/fake-http.ts';
import invalidJson from '../fixtures/actions-json/invalid.json';
import noCatchAll from '../fixtures/actions-json/no-catch-all.json';
import shopJson from '../fixtures/actions-json/shop.json';
import metadataSimple from '../fixtures/actions/metadata-simple.json';

const shop: ActionsJson = shopJson;

describe('matchRule (fixture shop.json)', () => {
  test.each([
    ['https://shop.test/buy', 'https://shop.test/api/buy'],
    ['https://shop.test/buy?item=7', 'https://shop.test/api/buy?item=7'],
    ['https://shop.test/actions/a/b', 'https://shop.test/api/actions/a/b'],
    ['https://shop.test/actions/a?x=1&y=2', 'https://shop.test/api/actions/a?x=1&y=2'],
    ['https://shop.test/donate/alice', 'https://api.shop.test/v1/donate/alice'],
    ['https://shop.test/full/one', 'https://shop.test/api/full/one'],
    ['https://shop.test/donate/alice/extra', 'https://api.shop.test/v1/donate/alice/extra'],
    ['https://shop.test/', 'https://api.shop.test/v1/'],
  ])('%s → %s', (input, expected) => {
    expect(matchRule(shop, input)).toBe(expected);
  });

  test('accepts a bare rules array and returns null without a match', () => {
    expect(matchRule(noCatchAll.rules, 'https://shop.test/blink/x')).toBe('https://shop.test/api/blink/x');
    expect(matchRule(noCatchAll.rules, 'https://shop.test/blink')).toBeNull();
    expect(matchRule(noCatchAll.rules, 'https://shop.test/blink/x/y')).toBeNull();
  });

  test('a full-URL pattern on another origin does not match', () => {
    expect(matchRule([{ pathPattern: 'https://other.test/full/*', apiPath: '/x' }], 'https://shop.test/full/a')).toBeNull();
  });

  test('apiPath query is merged with the original query', () => {
    expect(matchRule([{ pathPattern: '/a', apiPath: '/api?v=1' }], 'https://shop.test/a?x=2')).toBe(
      'https://shop.test/api?v=1&x=2',
    );
  });
});

const PAGE = 'https://shop.test/blink/donate';

describe('createActionsJsonResolver', () => {
  test('resolves via actions.json', async () => {
    const fake = createFakeFetch({ 'GET https://shop.test/actions.json': { body: noCatchAll } });
    const resolver = createActionsJsonResolver({ fetch: fake.fetch, resolve: createFakeResolve() });
    expect(await resolver.resolve(PAGE)).toEqual({
      kind: 'blink',
      via: 'actions-json',
      actionUrl: 'https://shop.test/api/blink/donate',
    });
  });

  test('second call for the same origin is served from cache', async () => {
    const fake = createFakeFetch({ 'GET https://shop.test/actions.json': { body: noCatchAll } });
    const resolver = createActionsJsonResolver({ fetch: fake.fetch, resolve: createFakeResolve() });
    await resolver.resolve(PAGE);
    await resolver.resolve('https://shop.test/blink/other');
    expect(fake.requests.filter((r) => r.url.endsWith('/actions.json'))).toHaveLength(1);
  });

  test('cache entries expire after 10 minutes', async () => {
    const fc = createFakeClock();
    const fake = createFakeFetch({ 'GET https://shop.test/actions.json': { body: noCatchAll } });
    const resolver = createActionsJsonResolver({ fetch: fake.fetch, resolve: createFakeResolve(), clock: fc.clock });
    await resolver.resolve(PAGE);
    await fc.advance(10 * 60 * 1000);
    await resolver.resolve(PAGE);
    expect(fake.requests.filter((r) => r.url.endsWith('/actions.json'))).toHaveLength(2);
  });

  test('not-found (404) is cached; direct GET decides', async () => {
    const fake = createFakeFetch({
      'GET https://shop.test/actions.json': { status: 404, body: 'nope' },
      [`GET ${PAGE}`]: { body: metadataSimple },
    });
    const resolver = createActionsJsonResolver({ fetch: fake.fetch, resolve: createFakeResolve() });
    expect(await resolver.resolve(PAGE)).toEqual({ kind: 'blink', via: 'direct', actionUrl: PAGE });
    expect(await resolver.resolve(PAGE)).toEqual({ kind: 'blink', via: 'direct', actionUrl: PAGE });
    expect(fake.requests.filter((r) => r.url.endsWith('/actions.json'))).toHaveLength(1);
    expect(fake.requests.filter((r) => r.url === PAGE)).toHaveLength(2);
  });

  test('invalid actions.json is cached as not found', async () => {
    const fake = createFakeFetch({ 'GET https://shop.test/actions.json': { body: invalidJson } });
    const resolver = createActionsJsonResolver({ fetch: fake.fetch, resolve: createFakeResolve() });
    expect(await resolver.resolve(PAGE)).toEqual({ kind: 'not-blink' });
    expect(await resolver.resolve(PAGE)).toEqual({ kind: 'not-blink' });
    expect(fake.requests.filter((r) => r.url.endsWith('/actions.json'))).toHaveLength(1);
  });

  test('network errors are not cached', async () => {
    const fake = createFakeFetch({
      'GET https://shop.test/actions.json': [{ networkError: true }, { body: noCatchAll }],
    });
    const resolver = createActionsJsonResolver({ fetch: fake.fetch, resolve: createFakeResolve() });
    expect(await resolver.resolve(PAGE)).toEqual({ kind: 'not-blink' });
    expect(await resolver.resolve(PAGE)).toEqual({
      kind: 'blink',
      via: 'actions-json',
      actionUrl: 'https://shop.test/api/blink/donate',
    });
    expect(fake.requests.filter((r) => r.url.endsWith('/actions.json'))).toHaveLength(2);
  });

  test('direct GET with a non-metadata body is not a Blink', async () => {
    const fake = createFakeFetch({ [`GET ${PAGE}`]: { body: '<html></html>' } });
    const resolver = createActionsJsonResolver({ fetch: fake.fetch, resolve: createFakeResolve() });
    expect(await resolver.resolve(PAGE)).toEqual({ kind: 'not-blink' });
  });

  test('blocked origins send no request', async () => {
    const fake = createFakeFetch({});
    const resolver = createActionsJsonResolver({
      fetch: fake.fetch,
      resolve: createFakeResolve({ 'shop.test': ['10.0.0.1'] }),
    });
    expect(await resolver.resolve(PAGE)).toEqual({ kind: 'not-blink' });
    expect(await resolver.resolve('http://plain.test/x')).toEqual({ kind: 'not-blink' });
    expect(fake.requests).toHaveLength(0);
  });
});
