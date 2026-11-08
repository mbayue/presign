/**
 * Fake Solana RPC for tests. Routes are keyed by JSON-RPC method (optionally
 * narrowed by a predicate on params) and answer with saved `result` values.
 *
 * Two entry points share one router:
 * - `createFakeTransport` is a Kit `RpcTransport` (use with
 *   `createSolanaRpcFromTransport`, or `createFakeClusterRpcs`).
 * - `createFakeRpcFetch` is a `fetch` replacement that speaks JSON-RPC over
 *   HTTP, for exercising `createScannerTransport` (HTTP 429 sequences, etc.).
 *
 * Every call is recorded as `{ method, params }`.
 */
import { createSolanaRpcFromTransport, type RpcTransport } from '@solana/kit';
import { parseJsonWithBigInts, stringifyJsonWithBigInts } from '@solana/rpc-spec-types';
import { ScannerRpcError } from '../../src/solana/rpc.ts';
import type { ClusterRpcs } from '../../src/solana/types.ts';
import { type Cluster, realSleep, type Sleep } from '../../src/scan/types.ts';

export type FakeRpcCall = { method: string; params: unknown[] };

export type FakeReply = (
  | { result: unknown }
  | { rpcError: { code: number; message: string; data?: unknown } }
  /** HTTP status without a JSON body. Transport mode throws the matching ScannerRpcError. */
  | { status: number }
  /** Throw this value from the transport / fetch. */
  | { throw: unknown }
  /** Never answer; settles only when the request is aborted. */
  | { hang: true }
) & { delayMs?: number };

export interface FakeRoute {
  method: string;
  match?: (params: unknown[]) => boolean;
  /** One reply, or a sequence consumed in order whose last entry repeats. */
  reply: FakeReply | FakeReply[];
}

export interface FakeRpcOptions {
  /** Used for `delayMs`. Defaults to real timers. */
  sleep?: Sleep;
}

export class FakeRpcUnhandledError extends Error {
  constructor(method: string) {
    super(`fake-rpc: no route for ${method}`);
    this.name = 'FakeRpcUnhandledError';
  }
}

type Router = {
  calls: FakeRpcCall[];
  next(method: string, params: unknown[]): FakeReply;
};

function createRouter(routes: FakeRoute[]): Router {
  const calls: FakeRpcCall[] = [];
  const cursors = new Map<FakeRoute, number>();
  return {
    calls,
    next(method, params) {
      calls.push({ method, params });
      const route = routes.find((r) => r.method === method && (r.match === undefined || r.match(params)));
      if (!route) throw new FakeRpcUnhandledError(method);
      if (!Array.isArray(route.reply)) return route.reply;
      const i = cursors.get(route) ?? 0;
      cursors.set(route, i + 1);
      const reply = route.reply[Math.min(i, route.reply.length - 1)];
      if (reply === undefined) throw new Error(`fake-rpc: empty reply list for ${method}`);
      return reply;
    },
  };
}

const waitForAbort = (signal: AbortSignal | undefined): Promise<never> =>
  new Promise<never>((_, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
  });

const readPayload = (payload: unknown): { id: unknown; method: string; params: unknown[] } => {
  const p = payload as { id?: unknown; method?: unknown; params?: unknown };
  return {
    id: p.id ?? null,
    method: typeof p.method === 'string' ? p.method : '<unknown>',
    params: Array.isArray(p.params) ? p.params : [],
  };
};

const statusError = (status: number) =>
  new ScannerRpcError(status === 429 ? 'RPC_RATE_LIMITED' : 'RPC_HTTP_ERROR', status);

export function createFakeTransport(
  routes: FakeRoute[],
  options: FakeRpcOptions = {},
): { transport: RpcTransport; calls: FakeRpcCall[] } {
  const router = createRouter(routes);
  const sleep = options.sleep ?? realSleep;
  const transport = async ({ payload, signal }: { payload: unknown; signal?: AbortSignal }): Promise<unknown> => {
    const { id, method, params } = readPayload(payload);
    const reply = router.next(method, params);
    if (reply.delayMs !== undefined) await sleep(reply.delayMs, signal);
    if ('hang' in reply) return waitForAbort(signal);
    if ('throw' in reply) throw reply.throw;
    if ('status' in reply) throw statusError(reply.status);
    if ('rpcError' in reply) return { jsonrpc: '2.0', id, error: reply.rpcError };
    return { jsonrpc: '2.0', id, result: reply.result };
  };
  return { transport: transport as RpcTransport, calls: router.calls };
}

export function createFakeRpcFetch(
  routes: FakeRoute[],
  options: FakeRpcOptions = {},
): { fetch: typeof globalThis.fetch; calls: FakeRpcCall[]; urls: string[] } {
  const router = createRouter(routes);
  const sleep = options.sleep ?? realSleep;
  const urls: string[] = [];
  const fetchFn = async (input: unknown, init?: RequestInit): Promise<Response> => {
    urls.push(String(input));
    const signal = init?.signal ?? undefined;
    const { id, method, params } = readPayload(parseJsonWithBigInts(String(init?.body ?? '{}')));
    const reply = router.next(method, params);
    if (reply.delayMs !== undefined) await sleep(reply.delayMs, signal);
    if ('hang' in reply) return waitForAbort(signal);
    if ('throw' in reply) throw reply.throw;
    if ('status' in reply) return new Response(`status ${reply.status}`, { status: reply.status });
    const body =
      'rpcError' in reply
        ? { jsonrpc: '2.0', id, error: reply.rpcError }
        : { jsonrpc: '2.0', id, result: reply.result };
    return new Response(stringifyJsonWithBigInts(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fetchFn as typeof globalThis.fetch, calls: router.calls, urls };
}

export function createFakeClusterRpcs(
  routes: Partial<Record<Cluster, FakeRoute[]>> | FakeRoute[],
  options: FakeRpcOptions = {},
): { rpcs: ClusterRpcs; calls: Record<Cluster, FakeRpcCall[]> } {
  const byCluster = Array.isArray(routes) ? { mainnet: routes, devnet: routes } : routes;
  const mainnet = createFakeTransport(byCluster.mainnet ?? [], options);
  const devnet = createFakeTransport(byCluster.devnet ?? [], options);
  return {
    rpcs: {
      mainnet: createSolanaRpcFromTransport(mainnet.transport),
      devnet: createSolanaRpcFromTransport(devnet.transport),
    },
    calls: { mainnet: mainnet.calls, devnet: devnet.calls },
  };
}

/** `getAccountInfo` / `getMultipleAccounts` account entry in base64 encoding. */
export const fakeAccount = (p: {
  owner: string;
  data: Uint8Array;
  lamports?: number | bigint;
  executable?: boolean;
}) => ({
  owner: p.owner,
  lamports: p.lamports ?? 1_000_000,
  data: [Buffer.from(p.data).toString('base64'), 'base64'] as [string, 'base64'],
  executable: p.executable ?? false,
  rentEpoch: 0,
  space: p.data.length,
});

/** Wraps a value in the `{ context, value }` envelope Solana RPC returns. */
export const withContext = <T>(value: T, slot = 1) => ({ context: { slot }, value });
