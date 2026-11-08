/**
 * Explorer_Link selection (Req 11.8, 11.13, 11.14).
 * Prefers the inspector URL; falls back to the address page of the first
 * non-known top-level program, then the first transfer recipient.
 */
import type { Address } from '@solana/kit';
import type { Cluster } from '../scan/types.ts';
import type { InstructionRecord } from './types.ts';

export const EXPLORER_BASE = 'https://explorer.solana.com';
export const MAX_INSPECTOR_URL_LENGTH = 512;

export type ExplorerLink = { url: string } | { none: true };

/** Explorer's name for each Cluster; always passed explicitly for consistency. */
const explorerCluster = (cluster: Cluster): string => (cluster === 'mainnet' ? 'mainnet-beta' : 'devnet');

export function inspectorUrl(cluster: Cluster, messageBase64: string): string {
  return `${EXPLORER_BASE}/tx/inspector?cluster=${explorerCluster(cluster)}&message=${encodeURIComponent(messageBase64)}`;
}

export function addressUrl(cluster: Cluster, addr: Address): string {
  return `${EXPLORER_BASE}/address/${addr}?cluster=${explorerCluster(cluster)}`;
}

export function selectExplorerLink(input: {
  cluster: Cluster;
  messageBase64?: string;
  topLevel: InstructionRecord[];
  knownPrograms: ReadonlySet<Address>;
  firstTransferRecipient?: Address;
}): ExplorerLink {
  if (input.messageBase64 !== undefined && input.messageBase64 !== '') {
    const url = inspectorUrl(input.cluster, input.messageBase64);
    if (url.length <= MAX_INSPECTOR_URL_LENGTH) return { url };
  }
  const unknown = input.topLevel.find((ix) => !ix.inner && !input.knownPrograms.has(ix.programAddress));
  if (unknown !== undefined) return { url: addressUrl(input.cluster, unknown.programAddress) };
  if (input.firstTransferRecipient !== undefined) return { url: addressUrl(input.cluster, input.firstTransferRecipient) };
  return { none: true };
}
