import { describe, expect, test } from 'bun:test';
import { safeFetch } from '../../src/fetch/safe-fetch.ts';
import type { RequestLimits } from '../../src/fetch/types.ts';
import { createFakeFetch, createFakeResolve } from '../helpers/fake-http.ts';

const LIMITS: RequestLimits = { timeoutMs: 1_000, maxBytes: 1_024, maxRedirects: 3 };

describe('safeFetch URL guard', () => {
  test('refuses a host that resolves to a private IP without calling fetch', async () => {
    const fake = createFakeFetch({ 'https://internal.test/a': { body: { ok: true } } });
    const resolve = createFakeResolve({ 'internal.test': ['93.184.216.34', '10.0.0.5'] });
    const res = await safeFetch({ method: 'GET', url: 'https://internal.test/a', limits: LIMITS }, { fetch: fake.fetch, resolve });
    expect(res).toEqual({ ok: false, kind: 'blocked' });
    expect(fake.requests).toHaveLength(0);
  });

  test.each(['https://127.0.0.1/a', 'https://[::1]/a', 'https://[::ffff:127.0.0.1]/a', 'https://169.254.169.254/latest'])(
    'refuses IP literal %s without DNS or fetch',
    async (url) => {
      const fake = createFakeFetch({});
      const resolve = async () => {
        throw new Error('resolve must not be called for IP literals');
      };
      expect(await safeFetch({ method: 'GET', url, limits: LIMITS }, { fetch: fake.fetch, resolve })).toEqual({
        ok: false,
        kind: 'blocked',
      });
      expect(fake.requests).toHaveLength(0);
    },
  );

  test('refuses plain http outside the dev allowlist', async () => {
    const fake = createFakeFetch({});
    const res = await safeFetch(
      { method: 'GET', url: 'http://shop.test/a', limits: LIMITS },
      { fetch: fake.fetch, resolve: createFakeResolve() },
    );
    expect(res).toEqual({ ok: false, kind: 'blocked' });
    expect(fake.requests).toHaveLength(0);
  });

  test('allows a dev origin over http without resolving it', async () => {
    const fake = createFakeFetch({ 'http://localhost:8787/a': { body: { hi: 1 } } });
    const resolve = async () => {
      throw new Error('dev origins skip DNS');
    };
    const res = await safeFetch({ method: 'GET', url: 'http://localhost:8787/a', limits: LIMITS }, { fetch: fake.fetch, resolve });
    expect(res.ok).toBe(true);
  });

  test('DNS failure is a network error', async () => {
    const fake = createFakeFetch({});
    const resolve = async (): Promise<string[]> => {
      throw new Error('ENOTFOUND');
    };
    expect(await safeFetch({ method: 'GET', url: 'https://gone.test/', limits: LIMITS }, { fetch: fake.fetch, resolve })).toEqual({
      ok: false,
      kind: 'network',
    });
    expect(fake.requests).toHaveLength(0);
  });
});

describe('safeFetch redirects', () => {
  test('refuses a redirect to a private IP before following it', async () => {
    const fake = createFakeFetch({
      'https://a.test/start': { redirectTo: 'https://internal.test/secret' },
      'https://internal.test/secret': { body: { leaked: true } },
    });
    const resolve = createFakeResolve({ 'internal.test': ['192.168.1.10'] });
    const res = await safeFetch({ method: 'GET', url: 'https://a.test/start', limits: LIMITS }, { fetch: fake.fetch, resolve });
    expect(res).toEqual({ ok: false, kind: 'blocked' });
    expect(fake.requests.map((r) => r.url)).toEqual(['https://a.test/start']);
  });

  test('refuses a redirect to http', async () => {
    const fake = createFakeFetch({ 'https://a.test/start': { redirectTo: 'http://a.test/plain' } });
    const res = await safeFetch(
      { method: 'GET', url: 'https://a.test/start', limits: LIMITS },
      { fetch: fake.fetch, resolve: createFakeResolve() },
    );
    expect(res).toEqual({ ok: false, kind: 'blocked' });
    expect(fake.requests).toHaveLength(1);
  });

  test('follows 3 redirects (relative Location included) and fails on the 4th', async () => {
    const three = createFakeFetch({
      'https://a.test/0': { redirectTo: '/1' },
      'https://a.test/1': { redirectTo: 'https://b.test/2' },
      'https://b.test/2': { redirectTo: '3' },
      'https://b.test/3': { body: { done: true } },
    });
    const ok = await safeFetch(
      { method: 'GET', url: 'https://a.test/0', limits: LIMITS },
      { fetch: three.fetch, resolve: createFakeResolve() },
    );
    expect(ok.ok && ok.finalUrl).toBe('https://b.test/3');
    expect(ok.ok && JSON.parse(ok.bodyText)).toEqual({ done: true });

    const four = createFakeFetch({
      'https://a.test/0': { redirectTo: '/1' },
      'https://a.test/1': { redirectTo: '/2' },
      'https://a.test/2': { redirectTo: '/3' },
      'https://a.test/3': { redirectTo: '/4' },
      'https://a.test/4': { body: { done: true } },
    });
    const res = await safeFetch(
      { method: 'GET', url: 'https://a.test/0', limits: LIMITS },
      { fetch: four.fetch, resolve: createFakeResolve() },
    );
    expect(res).toEqual({ ok: false, kind: 'too-many-redirects' });
    expect(four.requests).toHaveLength(4);
  });
});

describe('safeFetch limits and headers', () => {
  test('aborts a streamed body over maxBytes', async () => {
    const fake = createFakeFetch({ 'https://a.test/big': { chunks: ['x'.repeat(600), 'y'.repeat(600)] } });
    const res = await safeFetch(
      { method: 'GET', url: 'https://a.test/big', limits: LIMITS },
      { fetch: fake.fetch, resolve: createFakeResolve() },
    );
    expect(res).toEqual({ ok: false, kind: 'too-large' });
  });

  test('accepts a body exactly at maxBytes', async () => {
    const fake = createFakeFetch({ 'https://a.test/edge': { chunks: ['x'.repeat(512), 'y'.repeat(512)] } });
    const res = await safeFetch(
      { method: 'GET', url: 'https://a.test/edge', limits: LIMITS },
      { fetch: fake.fetch, resolve: createFakeResolve() },
    );
    expect(res.ok && res.bodyText.length).toBe(1_024);
  });

  test('times out a hanging response', async () => {
    const fake = createFakeFetch({ 'https://a.test/slow': { hang: true } });
    const res = await safeFetch(
      { method: 'GET', url: 'https://a.test/slow', limits: { ...LIMITS, timeoutMs: 30 } },
      { fetch: fake.fetch, resolve: createFakeResolve() },
    );
    expect(res).toEqual({ ok: false, kind: 'timeout' });
  });

  test('a thrown fetch error is a network failure', async () => {
    const fake = createFakeFetch({ 'https://a.test/x': { networkError: true } });
    const res = await safeFetch(
      { method: 'GET', url: 'https://a.test/x', limits: LIMITS },
      { fetch: fake.fetch, resolve: createFakeResolve() },
    );
    expect(res).toEqual({ ok: false, kind: 'network' });
  });

  test('sends Accept on GET and Content-Type plus JSON body on POST', async () => {
    const fake = createFakeFetch({ 'https://a.test/x': { body: {} } });
    const deps = { fetch: fake.fetch, resolve: createFakeResolve() };
    await safeFetch({ method: 'GET', url: 'https://a.test/x', limits: LIMITS }, deps);
    await safeFetch({ method: 'POST', url: 'https://a.test/x', json: { account: 'abc' }, limits: LIMITS }, deps);
    const [get, post] = fake.requests;
    expect(get?.headers['accept']).toBe('application/json');
    expect(get?.headers['content-type']).toBeUndefined();
    expect(post?.method).toBe('POST');
    expect(post?.headers['accept']).toBe('application/json');
    expect(post?.headers['content-type']).toBe('application/json');
    expect(post?.body).toBe('{"account":"abc"}');
  });
});
