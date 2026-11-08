import type { Address } from '@solana/kit';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type Cluster = 'mainnet' | 'devnet';
export type Severity = 'caution' | 'danger';
export type Verdict = 'safe' | 'caution' | 'danger';

/**
 * Branded string for any Untrusted_Data (link-server metadata, memos, program
 * logs, token names). Flag templates never accept this type, so untrusted text
 * cannot reach a Flag description (Req 8.9).
 */
export type Untrusted = string & { readonly __brand: 'Untrusted' };
export const untrusted = (s: string): Untrusted => s as Untrusted;

export type Clock = { now(): number };
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const systemClock: Clock = { now: () => Date.now() };

export const realSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

// ---------------------------------------------------------------------------
// Solana Pay
// ---------------------------------------------------------------------------

/** Exact decimal: value = digits / 10^scale. */
export type Decimal = { digits: bigint; scale: number };

export interface TransferRequest {
  type: 'transfer';
  recipient: Address;
  amount?: Decimal;
  splToken?: Address;
  /** 0..10 keys, URL order. */
  references: Address[];
  label?: string;
  message?: string;
  memo?: string;
}

/** Absolute https link (or an allowlisted http dev origin). */
export interface TransactionRequest {
  type: 'transaction';
  link: string;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export type ScannableLink =
  | { kind: 'blink'; raw: string; via: 'solana-action' | 'dial.to' | 'actions-json' | 'direct'; actionUrl: string }
  | { kind: 'transfer-request'; raw: string; request: TransferRequest }
  | { kind: 'transaction-request'; raw: string; request: TransactionRequest };

export type ScanInput =
  | { kind: 'link'; link: ScannableLink }
  | { kind: 'raw-transaction'; base64: string };

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export type RuleId =
  | 'TOKEN_APPROVE'
  | 'TOKEN_SET_AUTHORITY'
  | 'TOKEN_CLOSE_TO_OTHER'
  | 'MINT_PERMANENT_DELEGATE'
  | 'BALANCE_DRAINED'
  | 'UNKNOWN_PROGRAM'
  | 'SIMULATION_FAILED'
  | 'SIMULATION_UNAVAILABLE'
  | 'PERMANENT_DELEGATE_UNCHECKED'
  | 'ACCOUNTS_UNRESOLVED'
  | 'AMOUNT_USER_CHOSEN'
  | 'INVALID_RESPONSE_RPC'
  | 'INVALID_RESPONSE_LINK_SERVER'
  | 'RULE_UNEVALUATED'
  | 'INPUT_REQUIRED'
  | 'FETCH_FAILED'
  | 'DISALLOWED_URL'
  | 'TRANSFER_BUILD_FAILED'
  | 'DECODE_FAILED'
  | 'TX_TOO_LARGE'
  | 'UNSUPPORTED_VERSION'
  | 'CLUSTER_FALLBACK_FAILED'
  | 'SCAN_FAILED'
  | 'SCAN_TIMEOUT';

export interface Flag {
  ruleId: RuleId;
  severity: Severity;
  /** Built only by `flagTemplates` in src/risk/flags.ts from trusted parameters. */
  description: string;
}

// ---------------------------------------------------------------------------
// Balances and transfers
// ---------------------------------------------------------------------------

export type Asset = { kind: 'sol' } | { kind: 'token'; mint: Address };

export interface BalanceChange {
  asset: Asset;
  /** post − pre; negative = sent. */
  rawDelta: bigint;
  /** 9 for SOL; mint decimals; 'unknown' → show raw (Req 7.9). */
  decimals: number | 'unknown';
  pre: bigint;
  post: bigint;
}

export interface TransferEntry {
  asset: Asset;
  instruction:
    | 'system-transfer'
    | 'system-transfer-with-seed'
    | 'token-transfer'
    | 'token-transfer-checked'
    | 'token-transfer-checked-with-fee';
  /** SOL destination or destination token account. */
  recipient: Address;
  /** Owner of the destination token account, when readable. */
  recipientOwner?: Address;
  raw: bigint;
  decimals?: number;
  inner: boolean;
}

// ---------------------------------------------------------------------------
// Simulation and metadata views
// ---------------------------------------------------------------------------

export type SimError = {
  /** Identifier matching /^[A-Za-z]{1,64}$/ only. */
  name: string;
  instructionIndex?: number;
  customCode?: number;
  programNotFound: boolean;
};

export type ActionMetadataView = {
  title?: Untrusted;
  description?: Untrusted;
  label?: Untrusted;
  icon?: Untrusted;
};

// ---------------------------------------------------------------------------
// Scan result
// ---------------------------------------------------------------------------

export type ClusterSource = 'override' | 'outer' | 'embedded' | 'default';

export interface ScanResult {
  link: {
    raw: string | null;
    kind: ScannableLink['kind'] | 'raw-transaction';
    host?: string;
    recipient?: Address;
  };
  cluster: Cluster;
  clusterInfo: {
    source: ClusterSource;
    fallbackFrom?: Cluster;
    triedBoth?: [Cluster, Cluster];
    unsupportedValue?: Untrusted;
  };
  verdict: Verdict;
  flags: Flag[];
  balanceChanges: BalanceChange[];
  transfers: TransferEntry[];
  simulation: {
    status: 'ok' | 'failed' | 'unavailable' | 'skipped';
    error?: SimError;
    logs?: Untrusted[];
  };
  /** Untrusted fields. */
  metadata?: ActionMetadataView;
  linkedActionsNotScanned?: number;
  /** Post-processed AI summary; never read back by the Risk_Engine. */
  aiSummary?: string;
  explorer: { url: string } | { none: true };
  timedOut: boolean;
  /** Optional requirements 22–24 write here; the Risk_Engine never reads it. */
  extensions: Record<string, unknown>;
}
