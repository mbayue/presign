/**
 * Guarded HTTP client for link servers (Req 2.7–2.9, 14.1–14.4, 14.11).
 *
 * Every hop (the initial URL and each redirect target) passes the URL guard
 * before any connection: the scheme must be https unless the origin is on the
 * Dev_Origin_Allowlist, and the host must not be or resolve to a blocked IP.
 * One deadline covers DNS, all redirects and the body.
 *
 * Known limitation: the guard's DNS lookup and fetch's own lookup are separate,
 * so DNS rebinding can pass the check (Bun's fetch cannot pin an IP).
 */
import dns from 'node:dns';
import { isDevOrigin } from './dev-origin.ts';
import { isBlockedIp, isIpLiteral } from './ip-ranges.ts';
import type { Resolve, SafeFetchDeps, SafeFetchFailure, SafeFetchRequest, SafeFetchResult } from './types.ts';

export { DEV_ORIGIN_ALLOWLIST, isDevOrigin } from './dev-origin.ts';
export { isBlockedIp } from './ip-ranges.ts';

export const defaultSafeFetchDeps: SafeFetchDeps = {
  // Looked up at call time so a replaced globalThis.fetch is honored.
  fetch: ((input, init) => globalThis.fetch(input, init)) as typeof globalThis.fetch,
  resolve: async (host) => (await dns.promises.lookup(host, { all: true })).map((a) => a.address),
};

const fail = (kind: SafeFetchFailure['kind']): SafeFetchFailure => ({ ok: false, kind });

class DeadlineError extends Error {
  constructor() {
    super('deadline exceeded');
    this.name = 'DeadlineError';
  }
}

/** Rejects when `signal` aborts, so hung DNS lookups and stream reads cannot outlive the deadline. */
function withSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

export type GuardResult = 'allowed' | 'blocked' | 'unresolved';

/**
 * URL guard for one hop (Req 14.1, 14.2). Dev origins skip the IP check.
 * `unresolved` means DNS failed or returned nothing.
 */
export async function checkUrl(url: string | URL, resolve: Resolve, signal?: AbortSignal): Promise<GuardResult> {
  let u: URL;
  try {
    u = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return 'blocked';
  }
  if (isDevOrigin(u)) return 'allowed';
  if (u.protocol !== 'https:') return 'blocked';

  const host = u.hostname;
  if (host === '') return 'blocked';
  if (isIpLiteral(host)) return isBlockedIp(host) ? 'blocked' : 'allowed';

  let addresses: string[];
  try {
    const lookup = resolve(host);
    addresses = signal ? await withSignal(lookup, signal) : await lookup;
  } catch (e) {
    if (signal?.aborted) throw e;
    return 'unresolved';
  }
  if (addresses.length === 0) return 'unresolved';
  return addresses.some((a) => isBlockedIp(a)) ? 'blocked' : 'allowed';
}

async function readBody(res: Response, maxBytes: number, signal: AbortSignal): Promise<{ text: string } | null> {
  const declared = res.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (res.body === null) return { text: '' };

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await withSignal(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { text: new TextDecoder().decode(bytes) };
}

const isRedirect = (status: number) => status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

export async function safeFetch(req: SafeFetchRequest, deps: SafeFetchDeps = defaultSafeFetchDeps): Promise<SafeFetchResult> {
  const { limits } = req;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DeadlineError()), limits.timeoutMs);
  const { signal } = controller;
  const timedOut = () => signal.aborted && signal.reason instanceof DeadlineError;

  let url = req.url;
  let method: 'GET' | 'POST' = req.method;
  let body: string | undefined = req.method === 'POST' && req.json !== undefined ? JSON.stringify(req.json) : undefined;
  let redirects = 0;

  try {
    for (;;) {
      let guard: GuardResult;
      try {
        guard = await checkUrl(url, deps.resolve, signal);
      } catch {
        return fail(timedOut() ? 'timeout' : 'network');
      }
      if (guard === 'blocked') return fail('blocked');
      if (guard === 'unresolved') return fail('network');

      const headers: Record<string, string> = { Accept: 'application/json' };
      if (method === 'POST') headers['Content-Type'] = 'application/json';
      const init: RequestInit = { method, headers, redirect: 'manual', signal };
      if (body !== undefined) init.body = body;

      let res: Response;
      try {
        res = await withSignal(deps.fetch(url, init), signal);
      } catch {
        return fail(timedOut() ? 'timeout' : 'network');
      }

      const location = res.headers.get('location');
      if (isRedirect(res.status) && location !== null) {
        await res.body?.cancel().catch(() => {});
        if (redirects >= limits.maxRedirects) return fail('too-many-redirects');
        redirects += 1;
        try {
          url = new URL(location, url).href;
        } catch {
          return fail('blocked');
        }
        // Fetch-standard method rewrite: 303 always, 301/302 for POST, become GET without a body.
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }

      let read: { text: string } | null;
      try {
        read = await readBody(res, limits.maxBytes, signal);
      } catch {
        return fail(timedOut() ? 'timeout' : 'network');
      }
      if (read === null) return fail('too-large');
      return { ok: true, status: res.status, headers: res.headers, bodyText: read.text, finalUrl: url };
    }
  } finally {
    clearTimeout(timer);
  }
}
