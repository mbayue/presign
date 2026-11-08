/**
 * Flag factory. Every Flag description in the system is built here from
 * trusted parameters only (Address, bigint, number, and closed enums). No
 * template accepts `Untrusted` or free strings, so token names, memos, logs
 * and link-server text can never reach a Flag (Req 8.9).
 */
import type { Address } from '@solana/kit';
import { formatUnits, U64_MAX } from '../links/decimal.ts';
import type { Cluster, Flag, RuleId, Severity } from '../scan/types.ts';

export type TokenProgram = 'spl-token' | 'token-2022';

export type AuthorityTypeName =
  | 'mint'
  | 'freeze'
  | 'account owner'
  | 'close'
  | 'transfer fee config'
  | 'withheld withdraw'
  | 'close mint'
  | 'interest rate'
  | 'permanent delegate'
  | 'confidential transfer mint'
  | 'transfer hook program id'
  | 'confidential transfer fee config'
  | 'metadata pointer'
  | 'group pointer'
  | 'group member pointer'
  | 'scaled ui amount'
  | 'pause'
  | 'unknown';

/** Closed set of fetch-failure reasons safe to show to users. */
export type FetchFailureReason =
  | 'bad-status'
  | 'invalid-json'
  | 'missing-fields'
  | 'invalid-transaction'
  | 'timeout'
  | 'too-large'
  | 'too-many-redirects'
  | 'network';

export type TransferBuildReason =
  | 'mint-missing'
  | 'mint-wrong-owner'
  | 'mint-read-failed'
  | 'amount-overflow'
  | 'transaction-too-large';

export type DecodeVersion = 'legacy' | 'v0' | 'v1';

const amountText = (raw: bigint, decimals?: number): string => {
  if (raw === U64_MAX) return 'UNLIMITED';
  return decimals === undefined ? `${raw} base units` : `${raw} base units (${formatUnits(raw, decimals)})`;
};

const FETCH_REASON_TEXT: Record<FetchFailureReason, string> = {
  'bad-status': 'the server returned an error status',
  'invalid-json': 'the server did not return valid JSON',
  'missing-fields': 'the response is missing required fields',
  'invalid-transaction': 'the response has no valid transaction',
  timeout: 'the request timed out',
  'too-large': 'the response was too large',
  'too-many-redirects': 'the request was redirected too many times',
  network: 'the server could not be reached',
};

const BUILD_REASON_TEXT: Record<TransferBuildReason, string> = {
  'mint-missing': 'the token mint does not exist on this cluster',
  'mint-wrong-owner': 'the token mint is not owned by SPL Token or Token-2022',
  'mint-read-failed': 'the token mint could not be read',
  'amount-overflow': 'the amount is too large',
  'transaction-too-large': 'the transaction would exceed 1,232 bytes',
};

const mk = (ruleId: RuleId, severity: Severity, description: string): Flag => ({ ruleId, severity, description });

export const flagTemplates = {
  TOKEN_APPROVE: (p: { delegate: Address; tokenAccount: Address; raw: bigint; decimals?: number }): Flag =>
    mk(
      'TOKEN_APPROVE',
      'danger',
      `Grants ${p.delegate} permission to spend from token account ${p.tokenAccount}: ${amountText(p.raw, p.decimals)}.`,
    ),

  TOKEN_SET_AUTHORITY: (p: { authorityType: AuthorityTypeName; target: Address; newAuthority: Address | null }): Flag =>
    mk(
      'TOKEN_SET_AUTHORITY',
      'danger',
      p.newAuthority === null
        ? `Removes the ${p.authorityType} authority of ${p.target}.`
        : `Changes the ${p.authorityType} authority of ${p.target} to ${p.newAuthority}.`,
    ),

  TOKEN_CLOSE_TO_OTHER: (p: { account: Address; destination: Address }): Flag =>
    mk('TOKEN_CLOSE_TO_OTHER', 'danger', `Closes token account ${p.account} and sends its rent to ${p.destination}.`),

  MINT_PERMANENT_DELEGATE: (p: { mint: Address; delegate: Address }): Flag =>
    mk(
      'MINT_PERMANENT_DELEGATE',
      'danger',
      `Mint ${p.mint} has permanent delegate ${p.delegate}, which can move or burn any holder's balance without the holder's signature.`,
    ),

  BALANCE_DRAINED: (p: { asset: 'SOL' | Address; pre: bigint; post: bigint; decimals?: number }): Flag => {
    const fmt = (v: bigint) => (p.decimals === undefined ? `${v} base units` : formatUnits(v, p.decimals));
    return mk('BALANCE_DRAINED', 'danger', `Moves the whole ${p.asset} balance: ${fmt(p.pre)} → ${fmt(p.post)}.`);
  },

  UNKNOWN_PROGRAM: (p: { program: Address }): Flag =>
    mk('UNKNOWN_PROGRAM', 'caution', `Calls unverified program ${p.program}.`),

  SIMULATION_FAILED: (p: { name: string; instructionIndex?: number; customCode?: number }): Flag => {
    // `name` is pre-validated by the Simulator against /^[A-Za-z]{1,64}$/.
    const safeName = /^[A-Za-z]{1,64}$/.test(p.name) ? p.name : 'UnknownError';
    const at = p.instructionIndex === undefined ? '' : ` at instruction ${p.instructionIndex}`;
    const code = p.customCode === undefined ? '' : ` custom error code ${p.customCode}`;
    return mk('SIMULATION_FAILED', 'caution', `Simulation failed: ${safeName}${at}${code}.`);
  },

  SIMULATION_UNAVAILABLE: (): Flag => mk('SIMULATION_UNAVAILABLE', 'caution', 'Simulation could not be performed.'),

  PERMANENT_DELEGATE_UNCHECKED: (p: { mint: Address }): Flag =>
    mk('PERMANENT_DELEGATE_UNCHECKED', 'caution', `Could not complete the permanent delegate check for mint ${p.mint}.`),

  ACCOUNTS_UNRESOLVED: (): Flag =>
    mk('ACCOUNTS_UNRESOLVED', 'caution', 'Some accounts could not be resolved from address lookup tables.'),

  AMOUNT_USER_CHOSEN: (): Flag =>
    mk('AMOUNT_USER_CHOSEN', 'caution', 'The link has no amount; the wallet would ask you to choose it.'),

  INVALID_RESPONSE_RPC: (): Flag => mk('INVALID_RESPONSE_RPC', 'caution', 'The RPC returned an invalid response.'),

  INVALID_RESPONSE_LINK_SERVER: (): Flag =>
    mk('INVALID_RESPONSE_LINK_SERVER', 'caution', 'The link server returned an invalid response.'),

  RULE_UNEVALUATED: (p: { ruleId: RuleId }): Flag =>
    mk('RULE_UNEVALUATED', 'caution', `Risk rule ${p.ruleId} could not be evaluated.`),

  INPUT_REQUIRED: (): Flag =>
    mk('INPUT_REQUIRED', 'caution', 'The link requires input the scanner cannot supply, so it was not simulated.'),

  FETCH_FAILED: (p: { reason: FetchFailureReason }): Flag =>
    mk('FETCH_FAILED', 'caution', `The transaction could not be retrieved: ${FETCH_REASON_TEXT[p.reason]}.`),

  DISALLOWED_URL: (): Flag =>
    mk('DISALLOWED_URL', 'caution', 'The link points to a disallowed URL (non-HTTPS or a private network address).'),

  TRANSFER_BUILD_FAILED: (p: { reason: TransferBuildReason; mint?: Address }): Flag =>
    mk(
      'TRANSFER_BUILD_FAILED',
      'caution',
      `The transfer could not be built: ${BUILD_REASON_TEXT[p.reason]}${p.mint ? ` (mint ${p.mint})` : ''}.`,
    ),

  DECODE_FAILED: (): Flag => mk('DECODE_FAILED', 'caution', 'The transaction could not be read.'),

  TX_TOO_LARGE: (p: { version: DecodeVersion }): Flag =>
    mk('TX_TOO_LARGE', 'caution', `The transaction exceeds the size limit for ${p.version} transactions.`),

  UNSUPPORTED_VERSION: (): Flag =>
    mk('UNSUPPORTED_VERSION', 'caution', 'The transaction version is not supported.'),

  CLUSTER_FALLBACK_FAILED: (p: { tried: [Cluster, Cluster] }): Flag =>
    mk(
      'CLUSTER_FALLBACK_FAILED',
      'caution',
      `A program in the transaction was not found on ${p.tried[0]} or ${p.tried[1]}.`,
    ),

  SCAN_FAILED: (): Flag => mk('SCAN_FAILED', 'caution', 'The scan failed because of an internal error.'),

  SCAN_TIMEOUT: (): Flag => mk('SCAN_TIMEOUT', 'caution', 'The scan timed out before it finished.'),
} as const;

/**
 * A pipeline-level Flag request from the fetch, build, and decode stages.
 * Resolved into a Flag with `flagFrom`.
 */
export type FlagRequest =
  | { ruleId: 'INPUT_REQUIRED' }
  | { ruleId: 'FETCH_FAILED'; reason: FetchFailureReason }
  | { ruleId: 'DISALLOWED_URL' }
  | { ruleId: 'INVALID_RESPONSE_LINK_SERVER' }
  | { ruleId: 'INVALID_RESPONSE_RPC' }
  | { ruleId: 'TRANSFER_BUILD_FAILED'; reason: TransferBuildReason; mint?: Address }
  | { ruleId: 'DECODE_FAILED' }
  | { ruleId: 'TX_TOO_LARGE'; version: DecodeVersion }
  | { ruleId: 'UNSUPPORTED_VERSION' };

export function flagFrom(req: FlagRequest): Flag {
  switch (req.ruleId) {
    case 'INPUT_REQUIRED':
      return flagTemplates.INPUT_REQUIRED();
    case 'FETCH_FAILED':
      return flagTemplates.FETCH_FAILED({ reason: req.reason });
    case 'DISALLOWED_URL':
      return flagTemplates.DISALLOWED_URL();
    case 'INVALID_RESPONSE_LINK_SERVER':
      return flagTemplates.INVALID_RESPONSE_LINK_SERVER();
    case 'INVALID_RESPONSE_RPC':
      return flagTemplates.INVALID_RESPONSE_RPC();
    case 'TRANSFER_BUILD_FAILED':
      return flagTemplates.TRANSFER_BUILD_FAILED(
        req.mint === undefined ? { reason: req.reason } : { reason: req.reason, mint: req.mint },
      );
    case 'DECODE_FAILED':
      return flagTemplates.DECODE_FAILED();
    case 'TX_TOO_LARGE':
      return flagTemplates.TX_TOO_LARGE({ version: req.version });
    case 'UNSUPPORTED_VERSION':
      return flagTemplates.UNSUPPORTED_VERSION();
  }
}
