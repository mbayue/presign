import { describe, expect, test } from 'bun:test';
import { address } from '@solana/kit';
import { createClusterRpcs, createScannerTransport, isScannerRpcError, ScannerRpcError } from '../../src/solana/rpc.ts';
import { AccountInfoResultSchema, SimulateResponseSchema } from '../../src/solana/schemas.ts';
import type { Sleep } from '../../src/scan/types.ts';
import { createFakeRpcFetch, type FakeRoute } from '../helpers/fake-rpc.ts';

const URL_WITH_KEY = 'https://rpc.example.invalid/?api-key=SECRET123';
const MINT = address('So11111111111111111111111111111111111111112');

/** Records every sleep; the 10 s attempt timeout never fires unless `fireTimeout` is set. */
function recordingSleep(opts: { fireTimeout?: boolean } = {}): { sleep: Sleep; sleeps: number[] } {
  const sleeps: number[] = [];
  const sleep: Sleep = (ms, signal) => {
    sleeps.push(ms);
    if (ms === 10_000 && !opts.fireTimeout) {
      return new Promise<void>((_, reject) =>
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true }),
      );
    }
    return Promise.resolve();
  };
  return { sleep, sleeps };
}

const accountInfoRoute = (reply: FakeRoute['reply']): FakeRoute[] => [{ method: 'getAccountInfo', reply }];
const okAccount = { result: { context: { slot: 1 }, value: null } };

function rpcWith(routes: FakeRoute[], opts: { fireTimeout?: boolean } = {}) {
  const { sleep, sleeps } = recordingSleep(opts);
  const fake = createFakeRpcFetch(routes, { sleep: () => Promise.resolve() });
  const { mainnet } = createClusterRpcs({ mainnet: URL_WITH_KEY, devnet: URL_WITH_KEY }, { fetch: fake.fetch, sleep });
  return { rpc: mainnet, sleeps, calls: fake.calls };
}

const retrySleeps = (sleeps: number[]) => sleeps.filter((ms) => ms !== 10_000);

async function captureError(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected rejection');
}

describe('createScannerTransport', () => {
  test('429, 429, 200 succeeds after waiting 500 ms then 1,500 ms', async () => {
    const { rpc, sleeps, calls } = rpcWith(accountInfoRoute([{ status: 429 }, { status: 429 }, okAccount]));
    const res = await rpc.getAccountInfo(MINT, { encoding: 'base64' }).send();
    expect(res.value).toBeNull();
    expect(retrySleeps(sleeps)).toEqual([500, 1_500]);
    expect(calls.map((c) => c.method)).toEqual(['getAccountInfo', 'getAccountInfo', 'getAccountInfo']);
  });

  test('three 429s fail with RPC_RATE_LIMITED after exactly 2 retries', async () => {
    const { rpc, sleeps, calls } = rpcWith(accountInfoRoute({ status: 429 }));
    const err = await captureError(rpc.getAccountInfo(MINT).send());
    expect(isScannerRpcError(err)).toBe(true);
    expect((err as ScannerRpcError).code).toBe('RPC_RATE_LIMITED');
    expect(calls).toHaveLength(3);
    expect(retrySleeps(sleeps)).toEqual([500, 1_500]);
  });

  test('non-429 HTTP errors fail at once with RPC_HTTP_ERROR', async () => {
    const { rpc, calls } = rpcWith(accountInfoRoute({ status: 503 }));
    const err = await captureError(rpc.getAccountInfo(MINT).send());
    expect((err as ScannerRpcError).code).toBe('RPC_HTTP_ERROR');
    expect((err as ScannerRpcError).status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  test('a hung request times out after 10 s with RPC_TIMEOUT', async () => {
    const { rpc, sleeps } = rpcWith(accountInfoRoute({ hang: true }), { fireTimeout: true });
    const err = await captureError(rpc.getAccountInfo(MINT).send());
    expect((err as ScannerRpcError).code).toBe('RPC_TIMEOUT');
    expect(sleeps).toEqual([10_000]);
  });

  test('network failures map to RPC_NETWORK', async () => {
    const { rpc } = rpcWith(accountInfoRoute({ throw: new TypeError(`fetch failed: ${URL_WITH_KEY}`) }));
    const err = await captureError(rpc.getAccountInfo(MINT).send());
    expect((err as ScannerRpcError).code).toBe('RPC_NETWORK');
  });

  test('error messages and properties never contain the URL', async () => {
    for (const reply of [{ status: 429 }, { status: 500 }, { throw: new Error(URL_WITH_KEY) }]) {
      const { rpc } = rpcWith(accountInfoRoute(reply));
      const err = (await captureError(rpc.getAccountInfo(MINT).send())) as ScannerRpcError;
      const dump = `${err.message} ${err.stack ?? ''} ${JSON.stringify(err)} ${String(err.cause ?? '')}`;
      expect(dump).not.toContain('SECRET123');
      expect(dump).not.toContain('rpc.example.invalid');
    }
  });

  test('integers above 2^53 survive parsing', async () => {
    const big = 18_446_744_073_709_551_615n;
    const routes: FakeRoute[] = [
      {
        method: 'getAccountInfo',
        reply: {
          result: {
            context: { slot: 1 },
            value: { owner: MINT, lamports: big, data: ['', 'base64'], executable: false, rentEpoch: big, space: 0 },
          },
        },
      },
    ];
    const { rpc } = rpcWith(routes);
    const res = await rpc.getAccountInfo(MINT, { encoding: 'base64' }).send();
    expect(res.value?.lamports).toBe(big as never);
    expect(AccountInfoResultSchema.safeParse(res).success).toBe(true);
  });

  test('sends a JSON-RPC POST', async () => {
    const seen: RequestInit[] = [];
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response('{"jsonrpc":"2.0","id":"0","result":1}', { status: 200 });
    }) as typeof fetch;
    const transport = createScannerTransport(URL_WITH_KEY, { fetch: fetchFn, sleep: recordingSleep().sleep });
    const result = await transport({ payload: { jsonrpc: '2.0', id: '0', method: 'getSlot', params: [] } });
    expect(result).toEqual({ jsonrpc: '2.0', id: '0', result: 1n });
    expect(seen[0]?.method).toBe('POST');
    expect(JSON.parse(String(seen[0]?.body)).method).toBe('getSlot');
  });
});

describe('schemas', () => {
  test('SimulateResponseSchema accepts a typical simulate value', () => {
    const value = { err: null, logs: ['Program log: hi'], accounts: [null], innerInstructions: [], unitsConsumed: 150n };
    expect(SimulateResponseSchema.safeParse(value).success).toBe(true);
    expect(SimulateResponseSchema.safeParse({ ...value, logs: 'x' }).success).toBe(false);
  });
});
