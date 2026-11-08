/**
 * Renderer-neutral Safety_Card model (Req 11.2–11.5, 15.1). Pure.
 *
 * Fields typed `Untrusted` (and `subject`, which comes from the link) are
 * left raw here; each renderer passes them through its own sanitizer.
 */
import { formatUnits } from '../links/decimal.ts';
import type {
  Asset,
  BalanceChange,
  Cluster,
  Flag,
  RuleId,
  ScanResult,
  Severity,
  TransferEntry,
  Untrusted,
  Verdict,
} from '../scan/types.ts';

export type CardEmoji = '🟢' | '🟡' | '🔴';
export type CardLabel = 'No risky actions found' | 'Caution' | 'Danger: do not sign';

/** Plain-language names for rule IDs, shown on Discord cards. The CLI keeps the rule IDs. */
export const RULE_LABELS: Record<RuleId, string> = {
  TOKEN_APPROVE: 'Token spending approval',
  TOKEN_SET_AUTHORITY: 'Ownership change',
  TOKEN_CLOSE_TO_OTHER: 'Account closed to someone else',
  MINT_PERMANENT_DELEGATE: 'Token issuer can take balances',
  BALANCE_DRAINED: 'Whole balance moved',
  UNKNOWN_PROGRAM: 'Unverified program',
  SIMULATION_FAILED: 'Simulation failed',
  SIMULATION_UNAVAILABLE: 'Simulation unavailable',
  PERMANENT_DELEGATE_UNCHECKED: 'Token check incomplete',
  ACCOUNTS_UNRESOLVED: 'Accounts not resolved',
  AMOUNT_USER_CHOSEN: 'Amount not set',
  INVALID_RESPONSE_RPC: 'Invalid RPC response',
  INVALID_RESPONSE_LINK_SERVER: 'Invalid link response',
  RULE_UNEVALUATED: 'Check could not run',
  INPUT_REQUIRED: 'Needs input',
  FETCH_FAILED: 'Transaction not retrieved',
  DISALLOWED_URL: 'Blocked URL',
  TRANSFER_BUILD_FAILED: 'Transfer not built',
  DECODE_FAILED: 'Unreadable transaction',
  TX_TOO_LARGE: 'Transaction too large',
  UNSUPPORTED_VERSION: 'Unsupported transaction',
  CLUSTER_FALLBACK_FAILED: 'Program not found',
  SCAN_FAILED: 'Scan failed',
  SCAN_TIMEOUT: 'Scan timed out',
  TRANSFER_RECORDING: 'Transfer check',
};

export type FlagLine =
  | { severity: Severity; ruleId: RuleId; text: string }
  | { severity: 'none'; text: typeof NO_FLAGS_LINE };

export interface CardModel {
  verdict: Verdict;
  emoji: CardEmoji;
  label: CardLabel;
  color: number;
  /** Raw link text (Untrusted) or null for a raw transaction. Sanitize before display. */
  source: string | null;
  /** Field label for `subject`: "Link host", "Recipient", or "Input". */
  subjectLabel: SubjectLabel;
  /** Hostname, recipient, or "Raw transaction". Sanitize before display. */
  subject: string;
  cluster: Cluster;
  /** Trusted notes about cluster selection. */
  clusterNotes: string[];
  /** Ignored `cluster` value from the link; sanitize before display. */
  unsupportedClusterValue?: Untrusted;
  /** One line per Balance_Change, or [NO_BALANCE_LINE]. */
  balanceLines: string[];
  /** Danger first, then caution, engine order within each group; or one NO_FLAGS_LINE entry. */
  flagLines: FlagLine[];
  transferLines: string[];
  linkedActionsNote?: string;
  aiSummary?: { label: typeof AI_SUMMARY_LABEL; text: string };
  explorer: { url: string } | { none: true; text: typeof NO_EXPLORER_LINE };
  /** Blink metadata title; sanitize before display. */
  title?: Untrusted;
  footer: typeof FOOTER;
}

export const NO_BALANCE_LINE = 'No balance changes found';
/** Shown when a TOKEN_APPROVE flag is raised: an approval moves nothing now, which can look harmless. */
export const APPROVE_NO_BALANCE_LINE = 'No tokens move now, but the approval lets the spender take them later.';
export const APPROVE_NOTE_LINE = 'The approval lets the spender take your tokens later.';
export const NO_FLAGS_LINE = 'No flags raised';
export const NO_EXPLORER_LINE = 'No Explorer link available';
export const AI_SUMMARY_LABEL = 'AI summary (AI-generated)';
export const FOOTER = 'Presign · Simulated with a placeholder account. This scan does not guarantee safety.';
export const RAW_TRANSACTION_SUBJECT = 'Raw transaction';

export type SubjectLabel = 'Link host' | 'Recipient' | 'Input';

export const VERDICT_STYLE: Record<Verdict, { emoji: CardEmoji; label: CardLabel; color: number }> = {
  safe: { emoji: '🟢', label: 'No risky actions found', color: 0x2ecc71 },
  caution: { emoji: '🟡', label: 'Caution', color: 0xf1c40f },
  danger: { emoji: '🔴', label: 'Danger: do not sign', color: 0xe74c3c },
};

const assetName = (asset: Asset): string => (asset.kind === 'sol' ? 'SOL' : asset.mint);

function amount(raw: bigint, decimals: number | 'unknown' | undefined, asset: Asset): string {
  return decimals === 'unknown' || decimals === undefined
    ? `${raw} base units of ${assetName(asset)}`
    : `${formatUnits(raw, decimals)} ${assetName(asset)}`;
}

export function balanceLine(c: BalanceChange): string {
  const abs = c.rawDelta < 0n ? -c.rawDelta : c.rawDelta;
  return `${c.rawDelta < 0n ? 'Sends' : 'Receives'} ${amount(abs, c.decimals, c.asset)}`;
}

export function transferLine(t: TransferEntry): string {
  const owner = t.recipientOwner === undefined ? '' : ` (owner ${t.recipientOwner})`;
  const inner = t.inner ? ' (inner instruction)' : '';
  return `Transfers ${amount(t.raw, t.decimals, t.asset)} to ${t.recipient}${owner}${inner}`;
}

function flagLines(flags: readonly Flag[]): FlagLine[] {
  if (flags.length === 0) return [{ severity: 'none', text: NO_FLAGS_LINE }];
  const line = (f: Flag): FlagLine => ({ severity: f.severity, ruleId: f.ruleId, text: f.description });
  return [...flags.filter((f) => f.severity === 'danger'), ...flags.filter((f) => f.severity !== 'danger')].map(line);
}

function subjectOf(link: ScanResult['link']): { label: SubjectLabel; value: string } {
  switch (link.kind) {
    case 'blink':
    case 'transaction-request':
      return { label: 'Link host', value: link.host ?? 'Unknown host' };
    case 'transfer-request':
      return { label: 'Recipient', value: link.recipient ?? 'Unknown recipient' };
    case 'raw-transaction':
      return { label: 'Input', value: RAW_TRANSACTION_SUBJECT };
  }
}

function balanceLinesOf(result: ScanResult): string[] {
  const approves = result.flags.some((f) => f.ruleId === 'TOKEN_APPROVE');
  if (result.balanceChanges.length === 0) return [approves ? APPROVE_NO_BALANCE_LINE : NO_BALANCE_LINE];
  const only = result.balanceChanges[0];
  // An approve moves nothing; a lone small SOL decrease with no transfers is just the network fee.
  if (
    approves &&
    result.balanceChanges.length === 1 &&
    only !== undefined &&
    only.asset.kind === 'sol' &&
    only.rawDelta < 0n &&
    result.transfers.length === 0
  ) {
    return [`Network fee only: ${formatUnits(-only.rawDelta, 9)} SOL`, APPROVE_NOTE_LINE];
  }
  const lines = result.balanceChanges.map(balanceLine);
  return approves ? [...lines, APPROVE_NOTE_LINE] : lines;
}

function clusterNotes(info: ScanResult['clusterInfo']): string[] {
  const notes: string[] = [];
  if (info.fallbackFrom !== undefined) notes.push(`Fell back from ${info.fallbackFrom}`);
  if (info.triedBoth !== undefined) notes.push(`Tried both ${info.triedBoth[0]} and ${info.triedBoth[1]}`);
  if (info.unsupportedValue !== undefined) notes.push('Unsupported cluster value ignored');
  return notes;
}

export function toCardModel(result: ScanResult): CardModel {
  const style = VERDICT_STYLE[result.verdict];
  const subject = subjectOf(result.link);
  const model: CardModel = {
    verdict: result.verdict,
    ...style,
    source: result.link.raw,
    subjectLabel: subject.label,
    subject: subject.value,
    cluster: result.cluster,
    clusterNotes: clusterNotes(result.clusterInfo),
    balanceLines: balanceLinesOf(result),
    flagLines: flagLines(result.flags),
    transferLines: result.transfers.map(transferLine),
    explorer: 'url' in result.explorer ? { url: result.explorer.url } : { none: true, text: NO_EXPLORER_LINE },
    footer: FOOTER,
  };
  if (result.clusterInfo.unsupportedValue !== undefined) {
    model.unsupportedClusterValue = result.clusterInfo.unsupportedValue;
  }
  const n = result.linkedActionsNotScanned ?? 0;
  if (n > 0) model.linkedActionsNote = `${n} linked action${n === 1 ? ' was' : 's were'} not scanned.`;
  if (result.aiSummary !== undefined && result.aiSummary.length > 0) {
    model.aiSummary = { label: AI_SUMMARY_LABEL, text: result.aiSummary };
  }
  if (result.metadata?.title !== undefined) model.title = result.metadata.title;
  return model;
}
