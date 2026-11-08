/**
 * Pay_Link_Parser and Pay_Link_Printer (Requirement 3).
 *
 * `solana:<recipient>?amount=..&spl-token=..&reference=..&label=..&message=..&memo=..`
 * is a Transfer_Request; `solana:<percent-encoded https URL>` is a Transaction_Request.
 */
import { address, isAddress } from '@solana/kit';
import type { Address } from '@solana/kit';
import { isDevOrigin } from '../fetch/dev-origin.ts';
import { U64_MAX, formatDecimal, parseDecimal, toBaseUnits } from './decimal.ts';
import type { Decimal, TransactionRequest, TransferRequest } from '../scan/types.ts';

export type PayLinkPart =
  | 'url'
  | 'path'
  | 'recipient'
  | 'amount'
  | 'spl-token'
  | 'reference'
  | 'label'
  | 'message'
  | 'memo'
  | 'link';

export type PayLinkError = { part: PayLinkPart; reason: string };

export type PayLinkValue = TransferRequest | TransactionRequest;

export type ParsePayLinkResult = { ok: true; value: PayLinkValue } | { ok: false; error: PayLinkError };
export type PrintPayLinkResult = { ok: true; url: string } | { ok: false; error: PayLinkError };

export type ParsePayLinkOptions = {
  /** Mint decimals for an spl-token amount. Unknown → decimal-place and u64 checks are skipped. */
  decimals?: number;
};

export const MAX_PAY_URL_LENGTH = 4_096;
export const MAX_REFERENCES = 10;
export const SOL_DECIMALS = 9;

const SCHEME = 'solana:';
const AMOUNT_RE = /^\d+(\.\d+)?$/;
const SINGLE_PARAMS = ['amount', 'spl-token', 'label', 'message', 'memo'] as const;
type SingleParam = (typeof SINGLE_PARAMS)[number];

const fail = (part: PayLinkPart, reason: string): { ok: false; error: PayLinkError } => ({
  ok: false,
  error: { part, reason },
});

const isSingleParam = (key: string): key is SingleParam => (SINGLE_PARAMS as readonly string[]).includes(key);

/** decodeURIComponent that also maps `+` to a space (form encoding); null on malformed escapes. */
function decodeQueryComponent(s: string): string | null {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

function decodePathComponent(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** Req 3.2, 3.6: absolute https URL with a host, or an allowlisted http dev origin. */
function validateLink(link: string): PayLinkError | null {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return { part: 'link', reason: 'invalid Transaction_Request link: not an absolute URL' };
  }
  if (u.protocol === 'https:') {
    if (u.hostname === '') return { part: 'link', reason: 'invalid Transaction_Request link: missing host' };
    return null;
  }
  if (u.protocol === 'http:' && isDevOrigin(u)) return null;
  return { part: 'link', reason: 'invalid Transaction_Request link: scheme must be https' };
}

function validateAddress(part: PayLinkPart, value: string): PayLinkError | null {
  return isAddress(value) ? null : { part, reason: 'not a base58 string that decodes to 32 bytes' };
}

/** Req 3.3 amount rules on an already-parsed decimal. `decimals` undefined → skip scale and u64 checks. */
function validateAmount(amount: Decimal, decimals: number | undefined): PayLinkError | null {
  if (decimals === undefined) return null;
  const base = toBaseUnits(amount, decimals);
  if (base === null) return { part: 'amount', reason: `more than ${decimals} decimal places` };
  if (base > U64_MAX) return { part: 'amount', reason: 'base-unit value exceeds u64 maximum' };
  return null;
}

export function parsePayLink(url: string, opts?: ParsePayLinkOptions): ParsePayLinkResult {
  if (url.length > MAX_PAY_URL_LENGTH) return fail('url', `longer than ${MAX_PAY_URL_LENGTH} characters`);
  if (url.slice(0, SCHEME.length).toLowerCase() !== SCHEME) return fail('url', 'scheme is not solana:');

  const rest = url.slice(SCHEME.length);
  const q = rest.indexOf('?');
  const rawPath = q === -1 ? rest : rest.slice(0, q);
  const rawQuery = q === -1 ? '' : rest.slice(q + 1);

  if (rawPath === '') return fail('path', 'empty path');
  const path = decodePathComponent(rawPath);
  if (path === null) return fail('path', 'malformed percent-encoding');
  if (path === '') return fail('path', 'empty path');

  // Base58 never contains ':', so any scheme-like path is a Transaction_Request attempt (Req 3.6).
  if (path.includes(':')) {
    const err = validateLink(path);
    if (err) return { ok: false, error: err };
    return { ok: true, value: { type: 'transaction', link: path } };
  }

  const recipientErr = validateAddress('recipient', path);
  if (recipientErr) return { ok: false, error: recipientErr };

  const single = new Map<SingleParam, string>();
  const references: Address[] = [];

  for (const piece of rawQuery === '' ? [] : rawQuery.split('&')) {
    if (piece === '') continue;
    const eq = piece.indexOf('=');
    const key = decodeQueryComponent(eq === -1 ? piece : piece.slice(0, eq));
    if (key === null) continue; // unknown/garbled key: ignored
    const isKnown = key === 'reference' || isSingleParam(key);
    if (!isKnown) continue;
    const part: PayLinkPart = key as PayLinkPart;
    const value = decodeQueryComponent(eq === -1 ? '' : piece.slice(eq + 1));
    if (value === null) return fail(part, 'malformed percent-encoding');

    if (key === 'reference') {
      if (references.length >= MAX_REFERENCES) return fail('reference', `more than ${MAX_REFERENCES} reference parameters`);
      const err = validateAddress('reference', value);
      if (err) return { ok: false, error: err };
      references.push(address(value));
      continue;
    }
    if (isSingleParam(key)) {
      if (single.has(key)) return fail(key, 'parameter repeated');
      single.set(key, value);
    }
  }

  const request: TransferRequest = { type: 'transfer', recipient: address(path), references };

  const splToken = single.get('spl-token');
  if (splToken !== undefined) {
    const err = validateAddress('spl-token', splToken);
    if (err) return { ok: false, error: err };
    request.splToken = address(splToken);
  }

  const amountText = single.get('amount');
  if (amountText !== undefined) {
    if (!AMOUNT_RE.test(amountText)) return fail('amount', 'not a plain decimal number');
    const amount = parseDecimal(amountText);
    if (amount === null) return fail('amount', 'not a plain decimal number');
    const decimals = splToken === undefined ? SOL_DECIMALS : opts?.decimals;
    const err = validateAmount(amount, decimals);
    if (err) return { ok: false, error: err };
    request.amount = amount;
  }

  const label = single.get('label');
  if (label !== undefined) request.label = label;
  const message = single.get('message');
  if (message !== undefined) request.message = message;
  const memo = single.get('memo');
  if (memo !== undefined) request.memo = memo;

  return { ok: true, value: request };
}

function validateText(part: 'label' | 'message' | 'memo', value: string | undefined): PayLinkError | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') return { part, reason: 'not a string' };
  if (!value.isWellFormed()) return { part, reason: 'not well-formed Unicode' };
  return null;
}

function validateDecimalShape(d: Decimal): PayLinkError | null {
  if (typeof d.digits !== 'bigint' || d.digits < 0n) return { part: 'amount', reason: 'not a non-negative decimal' };
  if (!Number.isSafeInteger(d.scale) || d.scale < 0) return { part: 'amount', reason: 'invalid scale' };
  return null;
}

/** Runs the parser's validators on the structure (Req 3.7), then prints it (Req 3.4). */
export function printPayLink(value: PayLinkValue): PrintPayLinkResult {
  if (value.type === 'transaction') {
    if (typeof value.link !== 'string' || !value.link.isWellFormed()) return fail('link', 'not well-formed Unicode');
    if (value.link === '') return fail('link', 'empty link');
    const err = validateLink(value.link);
    if (err) return { ok: false, error: err };
    return finish(`${SCHEME}${encodeURIComponent(value.link)}`);
  }

  const recipientErr = validateAddress('recipient', value.recipient);
  if (recipientErr) return { ok: false, error: recipientErr };

  if (value.splToken !== undefined) {
    const err = validateAddress('spl-token', value.splToken);
    if (err) return { ok: false, error: err };
  }
  if (value.amount !== undefined) {
    const err =
      validateDecimalShape(value.amount) ??
      validateAmount(value.amount, value.splToken === undefined ? SOL_DECIMALS : undefined);
    if (err) return { ok: false, error: err };
  }
  if (value.references.length > MAX_REFERENCES) {
    return fail('reference', `more than ${MAX_REFERENCES} reference parameters`);
  }
  for (const ref of value.references) {
    const err = validateAddress('reference', ref);
    if (err) return { ok: false, error: err };
  }
  const textErr =
    validateText('label', value.label) ?? validateText('message', value.message) ?? validateText('memo', value.memo);
  if (textErr) return { ok: false, error: textErr };

  const params: string[] = [];
  if (value.amount !== undefined) params.push(`amount=${formatDecimal(value.amount)}`);
  if (value.splToken !== undefined) params.push(`spl-token=${value.splToken}`);
  for (const ref of value.references) params.push(`reference=${ref}`);
  if (value.label !== undefined) params.push(`label=${encodeURIComponent(value.label)}`);
  if (value.message !== undefined) params.push(`message=${encodeURIComponent(value.message)}`);
  if (value.memo !== undefined) params.push(`memo=${encodeURIComponent(value.memo)}`);

  return finish(`${SCHEME}${value.recipient}${params.length > 0 ? `?${params.join('&')}` : ''}`);
}

function finish(url: string): PrintPayLinkResult {
  if (url.length > MAX_PAY_URL_LENGTH) return fail('url', `printed URL longer than ${MAX_PAY_URL_LENGTH} characters`);
  return { ok: true, url };
}
