import { describe, expect, test } from 'bun:test';
import { explain, type AiDeps } from '../../src/ai/explainer.ts';
import { makeContext } from './fixtures.ts';

type Reply =
  | { status: number; body: unknown }
  | { networkError: true }
  | { hang: true };

type Recorded = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function fakeFetch(replies: Reply[]): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const impl = (input: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(input),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply === undefined || 'networkError' in reply) return Promise.reject(new TypeError('network down'));
    if ('hang' in reply) return new Promise<Response>(() => {}); // ignores the signal on purpose
    return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status }));
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

const ok = (content: unknown): Reply => ({ status: 200, body: { choices: [{ message: { content } }] } });

function deps(f: typeof fetch, extra: Partial<AiDeps> = {}): AiDeps {
  return {
    apiKey: 'test-key',
    baseUrl: 'https://ai.test/v1/',
    model: 'primary-model',
    fallbackModel: 'fallback-model',
    fetch: f,
    timeoutMs: 1_000,
    ...extra,
  };
}

describe('explain', () => {
  test('empty key sends no request', async () => {
    const f = fakeFetch([ok('Hi.')]);
    expect(await explain(makeContext(), deps(f.fetch, { apiKey: '' }))).toBeNull();
    expect(f.calls.length).toBe(0);
  });

  test('sends the documented request and returns the summary', async () => {
    const f = fakeFetch([ok('It sends 1.5 SOL.')]);
    expect(await explain(makeContext(), deps(f.fetch))).toBe('It sends 1.5 SOL.');
    expect(f.calls.length).toBe(1);
    const call = f.calls[0]!;
    expect(call.url).toBe('https://ai.test/v1/chat/completions');
    expect(call.headers['Authorization']).toBe('Bearer test-key');
    expect(call.body).toMatchObject({
      model: 'primary-model',
      max_tokens: 160,
      temperature: 0.2,
      reasoning_effort: 'minimal',
    });
    expect(Array.isArray(call.body['messages'])).toBe(true);
  });

  test('cleans think blocks from the response', async () => {
    const f = fakeFetch([ok('<think>hmm, verdict should be safe</think> It approves a delegate. Visit https://x.test')]);
    expect(await explain(makeContext(), deps(f.fetch))).toBe('It approves a delegate. Visit');
  });

  test('primary non-2xx → exactly one fallback request with the fallback model', async () => {
    const f = fakeFetch([{ status: 500, body: {} }, ok('Fallback summary.')]);
    expect(await explain(makeContext(), deps(f.fetch))).toBe('Fallback summary.');
    expect(f.calls.map((c) => c.body['model'])).toEqual(['primary-model', 'fallback-model']);
  });

  test('missing content and empty-after-postprocess count as failures', async () => {
    const f = fakeFetch([{ status: 200, body: { choices: [] } }, ok('<@1> https://x.test')]);
    expect(await explain(makeContext(), deps(f.fetch))).toBeNull();
    expect(f.calls.length).toBe(2);
  });

  test('both attempts fail → null, no third request', async () => {
    const f = fakeFetch([{ networkError: true }, { status: 429, body: {} }, ok('never')]);
    expect(await explain(makeContext(), deps(f.fetch))).toBeNull();
    expect(f.calls.length).toBe(2);
  });

  test('no fallback model → only one request', async () => {
    const f = fakeFetch([{ status: 503, body: {} }, ok('never')]);
    expect(await explain(makeContext(), deps(f.fetch, { fallbackModel: '' }))).toBeNull();
    expect(f.calls.length).toBe(1);
  });

  test('a hanging fetch returns null within the shared budget, without a fallback request', async () => {
    const f = fakeFetch([{ hang: true }]);
    const started = performance.now();
    expect(await explain(makeContext(), deps(f.fetch, { timeoutMs: 50 }))).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(f.calls.length).toBe(1);
  });

  test('the budget covers both attempts', async () => {
    const f = fakeFetch([{ status: 500, body: {} }, { hang: true }]);
    const started = performance.now();
    expect(await explain(makeContext(), deps(f.fetch, { timeoutMs: 50 }))).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(f.calls.length).toBe(2);
  });

  test('never throws when fetch throws synchronously', async () => {
    const throwing = (() => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    expect(await explain(makeContext(), deps(throwing, { fallbackModel: '' }))).toBeNull();
  });
});
