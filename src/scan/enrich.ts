/**
 * Account enrichment (Req 8.4, 8.11): find every mint a scan touches and read
 * them with one getMultipleAccounts pass (chunks of 100).
 */
import type { Address } from '@solana/kit';
import { readAccounts } from '../solana/simulator.ts';
import { decodeMint } from '../solana/token-accounts.ts';
import type { ClusterRpcs, InstructionRecord, MintView, TokenAccountView } from '../solana/types.ts';
import type { BalanceChange, Cluster } from './types.ts';

/**
 * Pure, deduped, discovery order: instruction mint fields (or, for token
 * instructions without one, the mint of the referenced token account from
 * `preTokens`), then mints with a Balance_Change.
 */
export function collectMints(
  records: InstructionRecord[],
  preTokens: Map<Address, TokenAccountView>,
  changes: BalanceChange[],
): Address[] {
  const seen = new Set<Address>();
  const add = (m: Address | undefined) => {
    if (m !== undefined) seen.add(m);
  };
  const mintOf = (...accounts: Address[]): Address | undefined => {
    for (const a of accounts) {
      const m = preTokens.get(a)?.mint;
      if (m !== undefined) return m;
    }
    return undefined;
  };

  for (const { parsed: p } of records) {
    switch (p.kind) {
      case 'token-approve':
        add(p.mint ?? mintOf(p.source));
        break;
      case 'token-transfer':
        add(p.mint ?? mintOf(p.source, p.destination));
        break;
      case 'token-set-authority':
        // Only token-account targets resolve here; a mint target is not in preTokens.
        add(mintOf(p.target));
        break;
      case 'token-close':
        add(mintOf(p.account));
        break;
      case 'token-mint-to':
      case 'token-burn':
      case 'ata-create':
        add(p.mint);
        break;
      default:
        break;
    }
  }
  for (const c of changes) if (c.asset.kind === 'token') add(c.asset.mint);
  return [...seen];
}

/** Any RPC or schema failure marks every mint `unreadable`. */
export async function enrichMints(
  mints: Address[],
  cluster: Cluster,
  deps: { rpcs: ClusterRpcs },
): Promise<Map<Address, MintView>> {
  const out = new Map<Address, MintView>();
  if (mints.length === 0) return out;
  try {
    const snapshots = await readAccounts(deps.rpcs[cluster], mints);
    for (const m of mints) out.set(m, decodeMint(m, snapshots.get(m) ?? { exists: false }));
  } catch {
    for (const m of mints) out.set(m, { status: 'unreadable', address: m });
  }
  return out;
}
