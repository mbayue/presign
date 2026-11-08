/**
 * Cluster selection (Req 6.1, 6.2, 6.6, 6.7). Pure.
 *
 * "Outer" is the `cluster` parameter of the text the user posted; "embedded" is
 * the `cluster` parameter of the Action URL or Transaction_Request link inside
 * it. For `solana-action:` and `solana:` links whose inner URL is written
 * literally, every `?` belongs to the inner URL, so there is no outer query.
 */
import type { Cluster, ClusterSource, ScannableLink } from './types.ts';

export type ClusterSelection = { cluster: Cluster; source: ClusterSource; unsupportedValue?: string };

const LITERAL_HTTP_RE = /^https?:\/\//i;

type ParamRead = { kind: 'absent' } | { kind: 'recognized'; cluster: Cluster } | { kind: 'unsupported'; value: string };

/** Query string after the first `?`, without the fragment; null when there is none. */
function queryOf(text: string): string | null {
  const q = text.indexOf('?');
  if (q < 0) return null;
  const rest = text.slice(q + 1);
  const hash = rest.indexOf('#');
  return hash < 0 ? rest : rest.slice(0, hash);
}

function readClusterParam(query: string | null): ParamRead {
  if (query === null) return { kind: 'absent' };
  let value: string | null;
  try {
    value = new URLSearchParams(query).get('cluster');
  } catch {
    return { kind: 'absent' };
  }
  if (value === null) return { kind: 'absent' };
  const lower = value.toLowerCase();
  if (lower === 'devnet') return { kind: 'recognized', cluster: 'devnet' };
  if (lower === 'mainnet-beta') return { kind: 'recognized', cluster: 'mainnet' };
  return { kind: 'unsupported', value };
}

/** Outer query for `<scheme>:<inner>` links: only present when the inner URL is percent-encoded. */
function outerQueryOfWrapped(raw: string): string | null {
  const colon = raw.indexOf(':');
  const inner = colon < 0 ? raw : raw.slice(colon + 1);
  if (LITERAL_HTTP_RE.test(inner)) return null;
  return queryOf(inner);
}

function outerQuery(link: ScannableLink): string | null {
  switch (link.kind) {
    case 'blink':
      return link.via === 'solana-action' ? outerQueryOfWrapped(link.raw) : queryOf(link.raw);
    case 'transaction-request':
      return outerQueryOfWrapped(link.raw);
    case 'transfer-request':
      return queryOf(link.raw);
  }
}

function embeddedQuery(link: ScannableLink): string | null {
  switch (link.kind) {
    case 'blink':
      return queryOf(link.actionUrl);
    case 'transaction-request':
      return queryOf(link.request.link);
    case 'transfer-request':
      return null;
  }
}

export function selectCluster(link: ScannableLink | null, defaultCluster: Cluster, override?: Cluster): ClusterSelection {
  if (override !== undefined) return { cluster: override, source: 'override' };
  if (link === null) return { cluster: defaultCluster, source: 'default' };

  const outer = readClusterParam(outerQuery(link));
  const embedded = readClusterParam(embeddedQuery(link));

  // An unrecognized value is ignored but still reported, even when the other parameter decides.
  const unsupported = outer.kind === 'unsupported' ? outer.value : embedded.kind === 'unsupported' ? embedded.value : undefined;
  const pick = (cluster: Cluster, source: ClusterSource): ClusterSelection =>
    unsupported === undefined ? { cluster, source } : { cluster, source, unsupportedValue: unsupported };

  if (outer.kind === 'recognized') return pick(outer.cluster, 'outer');
  if (embedded.kind === 'recognized') return pick(embedded.cluster, 'embedded');
  return pick(defaultCluster, 'default');
}
