/**
 * Route-table fake for `fetch` and DNS resolution. Production modules accept
 * `fetch` and `resolve` through their `deps` parameter; tests pass these.
 */

export type FakeRoute = {
  status?: number;
  headers?: Record<string, string>;
  /** String, or an object serialized as JSON. */
  body?: string | object;
  /** Serve the body in these chunks instead of one piece (for size limits). */
  chunks?: string[];
  /** Delay before responding, in ms of real time (keep small) — or never respond. */
  delayMs?: number;
  hang?: boolean;
  /** Shorthand for a 302 with a Location header. */
  redirectTo?: string;
  /** Throw a network error instead of responding. */
  networkError?: boolean;
};

export type RecordedRequest = { method: string; url: string; headers: Record<string, string>; body: string | null };

/** Keys are `METHOD url` (e.g. `GET https://x.test/a`) or just `url` for any method. */
export function createFakeFetch(routes: Record<string, FakeRoute | FakeRoute[]>): {
  fetch: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const counters = new Map<string, number>();

  const pick = (key: string): FakeRoute | undefined => {
    const entry = routes[key];
    if (entry === undefined) return undefined;
    if (!Array.isArray(entry)) return entry;
    const n = counters.get(key) ?? 0;
    counters.set(key, n + 1);
    return entry[Math.min(n, entry.length - 1)];
  };

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const body = typeof init?.body === 'string' ? init.body : null;
    requests.push({ method, url, headers, body });

    const route = pick(`${method} ${url}`) ?? pick(url);
    if (!route) return new Response('not found', { status: 404 });

    const signal = init?.signal ?? undefined;
    if (route.hang) {
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
      });
    }
    if (route.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, route.delayMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(signal.reason ?? new Error('aborted'));
          },
          { once: true },
        );
      });
    }
    if (route.networkError) throw new TypeError('fetch failed');

    if (route.redirectTo) {
      return new Response(null, { status: 302, headers: { location: route.redirectTo } });
    }

    const resHeaders = new Headers(route.headers ?? {});
    let payload: string | undefined;
    if (route.body !== undefined) {
      payload = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
      if (!resHeaders.has('content-type')) {
        resHeaders.set('content-type', typeof route.body === 'string' ? 'text/plain' : 'application/json');
      }
    }

    if (route.chunks) {
      const encoder = new TextEncoder();
      const parts = route.chunks;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of parts) controller.enqueue(encoder.encode(c));
          controller.close();
        },
      });
      return new Response(stream, { status: route.status ?? 200, headers: resHeaders });
    }

    return new Response(payload ?? null, { status: route.status ?? 200, headers: resHeaders });
  }) as typeof fetch;

  return { fetch: fakeFetch, requests };
}

/** Fake DNS: map hostname → addresses. Unknown hosts resolve to a public test IP. */
export function createFakeResolve(table: Record<string, string[]> = {}): (host: string) => Promise<string[]> {
  return async (host: string) => table[host] ?? ['93.184.216.34'];
}
