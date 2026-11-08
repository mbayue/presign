/**
 * RPC_Client (Req 7.7, 7.8, 14.5). A JSON-RPC-over-HTTP transport for Kit with
 * a per-attempt timeout and a fixed 429 retry schedule. Errors carry a code and
 * a fixed message; they never contain the endpoint URL (which may hold an API
 * key) and never wrap the underlying fetch error, whose text may include it.
 *
 * Read-only: callers use getMultipleAccounts, getAccountInfo and
 * simulateTransaction only. Any future getTransaction/getBlock call must pass
 * `maxSupportedTransactionVersion: 1` as a number (Req 5.5).
 */
import { createSolanaRpcFromTransport, type RpcResponse, type RpcTransport } from '@solana/kit';
// Direct dependency of @solana/kit (same version); Kit's own HTTP transport uses
// these so that u64 values above 2^53 survive JSON parsing.
import { parseJsonWithBigInts, stringifyJsonWithBigInts } from '@solana/rpc-spec-types';
import { type Cluster, realSleep, type Sleep } from '../scan/types.ts';
import type { ClusterRpcs, ScannerRpc } from './types.ts';

export const RPC_ATTEMPT_TIMEOUT_MS = 10_000;
/** Waits before retry 1 and retry 2 after HTTP 429 (Req 7.7). */
export const RPC_RETRY_DELAYS_MS: readonly number[] = [500, 1_500];

export type RpcErrorCode =
  | 'RPC_TIMEOUT'
  | 'RPC_RATE_LIMITED'
  | 'RPC_HTTP_ERROR'
  | 'RPC_NETWORK'
  | 'RPC_INVALID_RESPONSE';

const MESSAGES: Record<RpcErrorCode, string> = {
  RPC_TIMEOUT: 'RPC request timed out',
  RPC_RATE_LIMITED: 'RPC rate limit: HTTP 429 after 2 retries',
  RPC_HTTP_ERROR: 'RPC returned an HTTP error',
  RPC_NETWORK: 'RPC endpoint could not be reached',
  RPC_INVALID_RESPONSE: 'RPC returned a response that is not JSON',
};

export class ScannerRpcError extends Error {
  readonly code: RpcErrorCode;
  readonly status: number | undefined;
  constructor(code: RpcErrorCode, status?: number) {
    super(status === undefined ? MESSAGES[code] : `${MESSAGES[code]} (status ${status})`);
    this.name = 'ScannerRpcError';
    this.code = code;
    this.status = status;
  }
}

export const isScannerRpcError = (e: unknown): e is ScannerRpcError => e instanceof ScannerRpcError;

export interface TransportDeps {
  fetch: typeof globalThis.fetch;
  sleep: Sleep;
}

const defaultDeps = (): TransportDeps => ({
  // Resolved per call so a replaced globalThis.fetch (test preload) is honoured.
  fetch: ((input, init) => globalThis.fetch(input, init)) as typeof globalThis.fetch,
  sleep: realSleep,
});

type Attempt = { kind: 'ok'; value: unknown } | { kind: 'rate-limited' };

const NEVER = new Promise<never>(() => {});

const discardBody = (res: Response): void => {
  res.body?.cancel().catch(() => {});
};

export function createScannerTransport(url: string, deps?: TransportDeps): RpcTransport {
  const { fetch: fetchFn, sleep } = deps ?? defaultDeps();

  const attemptOnce = async (body: string, outer: AbortSignal | undefined): Promise<Attempt> => {
    const request = new AbortController();
    const timer = new AbortController();
    let timedOut = false;
    const onOuterAbort = () => request.abort(outer?.reason);
    if (outer?.aborted) throw outer.reason ?? new Error('aborted');
    outer?.addEventListener('abort', onOuterAbort, { once: true });

    const timeout = sleep(RPC_ATTEMPT_TIMEOUT_MS, timer.signal).then(
      () => {
        timedOut = true;
        request.abort();
        throw new ScannerRpcError('RPC_TIMEOUT');
      },
      () => NEVER,
    );

    const mapFailure = (): unknown => {
      if (timedOut) return new ScannerRpcError('RPC_TIMEOUT');
      if (outer?.aborted) return outer.reason ?? new Error('aborted');
      return new ScannerRpcError('RPC_NETWORK');
    };

    const work = (async (): Promise<Attempt> => {
      let res: Response;
      try {
        res = await fetchFn(url, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json; charset=utf-8' },
          body,
          signal: request.signal,
        });
      } catch {
        throw mapFailure();
      }
      if (res.status === 429) {
        discardBody(res);
        return { kind: 'rate-limited' };
      }
      if (!res.ok) {
        discardBody(res);
        throw new ScannerRpcError('RPC_HTTP_ERROR', res.status);
      }
      let text: string;
      try {
        text = await res.text();
      } catch {
        throw mapFailure();
      }
      try {
        return { kind: 'ok', value: parseJsonWithBigInts(text) };
      } catch {
        throw new ScannerRpcError('RPC_INVALID_RESPONSE');
      }
    })();

    try {
      return await Promise.race([work, timeout]);
    } finally {
      timer.abort();
      outer?.removeEventListener('abort', onOuterAbort);
    }
  };

  const transport = async ({ payload, signal }: { payload: unknown; signal?: AbortSignal }): Promise<unknown> => {
    const body = stringifyJsonWithBigInts(payload);
    for (let attempt = 0; ; attempt++) {
      const result = await attemptOnce(body, signal);
      if (result.kind === 'ok') return result.value;
      const delay = RPC_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw new ScannerRpcError('RPC_RATE_LIMITED', 429);
      await sleep(delay, signal);
    }
  };

  return transport as <TResponse>(config: { payload: unknown; signal?: AbortSignal }) => Promise<
    RpcResponse<TResponse>
  >;
}

export function createScannerRpc(url: string, deps?: TransportDeps): ScannerRpc {
  return createSolanaRpcFromTransport(createScannerTransport(url, deps));
}

export function createClusterRpcs(urls: Record<Cluster, string>, deps?: TransportDeps): ClusterRpcs {
  return {
    mainnet: createScannerRpc(urls.mainnet, deps),
    devnet: createScannerRpc(urls.devnet, deps),
  };
}
