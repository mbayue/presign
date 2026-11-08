/**
 * Shared contracts for the fetch layer. Implementations: safe-fetch.ts,
 * actions-json.ts, action-fetcher.ts. The Link_Detector depends only on
 * `ActionsJsonResolver`.
 */
import type { ActionMetadataView } from '../scan/types.ts';
import type { FlagRequest } from '../risk/flags.ts';
import type { Clock } from '../scan/types.ts';

export type RequestLimits = { timeoutMs: number; maxBytes: number; maxRedirects: number };

/** Req 14.3(a): actions.json GETs and the direct Blink-detection GET. */
export const DETECTION_LIMITS: RequestLimits = { timeoutMs: 5_000, maxBytes: 65_536, maxRedirects: 3 };
/** Req 14.3(b): metadata GET, Action POST, Transaction_Request GET/POST. */
export const FETCH_LIMITS: RequestLimits = { timeoutMs: 10_000, maxBytes: 1_048_576, maxRedirects: 3 };

/** Resolves a hostname to IP address strings (production: node:dns lookup with all: true). */
export type Resolve = (hostname: string) => Promise<string[]>;

export interface SafeFetchDeps {
  fetch: typeof globalThis.fetch;
  resolve: Resolve;
  clock?: Clock;
}

export type SafeFetchFailure =
  | { ok: false; kind: 'blocked' } // scheme or IP guard (before any connection)
  | { ok: false; kind: 'timeout' }
  | { ok: false; kind: 'too-large' }
  | { ok: false; kind: 'too-many-redirects' }
  | { ok: false; kind: 'network' };

export type SafeFetchResult =
  | { ok: true; status: number; headers: Headers; bodyText: string; finalUrl: string }
  | SafeFetchFailure;

export type SafeFetchRequest = {
  method: 'GET' | 'POST';
  url: string;
  /** JSON body for POST. */
  json?: unknown;
  limits: RequestLimits;
};

export type SafeFetch = (req: SafeFetchRequest, deps?: SafeFetchDeps) => Promise<SafeFetchResult>;

/** Result of resolving an HTTPS candidate URL during detection (Req 1.5, 1.13). */
export type ActionsJsonResolution =
  | { kind: 'blink'; via: 'actions-json' | 'direct'; actionUrl: string }
  | { kind: 'not-blink' };

export interface ActionsJsonResolver {
  resolve(url: string): Promise<ActionsJsonResolution>;
}

export type FetchedTransaction = {
  ok: true;
  /** Validated, non-empty base64. */
  base64: string;
  metadata?: ActionMetadataView;
  linkedActionsNotScanned?: number;
};

export type FetchFailure = { ok: false; flag: FlagRequest };
