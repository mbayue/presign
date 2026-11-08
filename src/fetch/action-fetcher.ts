/**
 * Action_Fetcher (Req 2.1–2.9, 14.5, 14.9). Obtains the base64 transaction a
 * Blink or Transaction_Request would ask a wallet to sign. Every failure
 * returns at once, so no further requests are sent for that link.
 */
import type { Address } from '@solana/kit';
import type { FetchFailureReason } from '../risk/flags.ts';
import { untrusted, type ActionMetadataView } from '../scan/types.ts';
import { defaultSafeFetchDeps, safeFetch } from './safe-fetch.ts';
import { ActionMetadataSchema, ActionPostResponseSchema, TransactionRequestGetSchema } from './schemas.ts';
import { FETCH_LIMITS, type FetchedTransaction, type FetchFailure, type SafeFetchDeps, type SafeFetchFailure } from './types.ts';

const TEMPLATE_PLACEHOLDER = /\{[^}]+\}/;

const fetchFailed = (reason: FetchFailureReason): FetchFailure => ({
  ok: false,
  flag: { ruleId: 'FETCH_FAILED', reason },
});
const disallowed = (): FetchFailure => ({ ok: false, flag: { ruleId: 'DISALLOWED_URL' } });
const inputRequired = (): FetchFailure => ({ ok: false, flag: { ruleId: 'INPUT_REQUIRED' } });

function fromSafeFetchFailure(f: SafeFetchFailure): FetchFailure {
  return f.kind === 'blocked' ? disallowed() : fetchFailed(f.kind);
}

const is2xx = (status: number) => status >= 200 && status <= 299;

type JsonOutcome = { ok: true; json: unknown } | FetchFailure;

/** One guarded request; returns parsed JSON or the matching failure. */
async function requestJson(
  method: 'GET' | 'POST',
  url: string,
  account: Address | undefined,
  deps: SafeFetchDeps,
): Promise<JsonOutcome> {
  const res = await safeFetch(
    method === 'POST' ? { method, url, json: { account }, limits: FETCH_LIMITS } : { method, url, limits: FETCH_LIMITS },
    deps,
  );
  if (!res.ok) return fromSafeFetchFailure(res);
  if (!is2xx(res.status)) return fetchFailed('bad-status');
  try {
    return { ok: true, json: JSON.parse(res.bodyText) as unknown };
  } catch {
    return fetchFailed('invalid-json');
  }
}

async function postForTransaction(
  url: string,
  account: Address,
  deps: SafeFetchDeps,
): Promise<{ ok: true; base64: string } | FetchFailure> {
  const res = await requestJson('POST', url, account, deps);
  if (!res.ok) return res;
  const parsed = ActionPostResponseSchema.safeParse(res.json);
  if (!parsed.success) return fetchFailed('invalid-transaction');
  return { ok: true, base64: parsed.data.transaction };
}

export async function fetchBlinkTransaction(
  actionUrl: string,
  account: Address,
  deps: SafeFetchDeps = defaultSafeFetchDeps,
): Promise<FetchedTransaction | FetchFailure> {
  // 1. Metadata GET (the URL guard runs inside safeFetch before any connection).
  const got = await requestJson('GET', actionUrl, undefined, deps);
  if (!got.ok) return got;
  const meta = ActionMetadataSchema.safeParse(got.json);
  if (!meta.success) return fetchFailed('missing-fields');

  const metadata: ActionMetadataView = {
    title: untrusted(meta.data.title),
    description: untrusted(meta.data.description),
    label: untrusted(meta.data.label),
    icon: untrusted(meta.data.icon),
  };

  // 2–4. Choose the POST target.
  const linked = meta.data.links?.actions ?? [];
  let postUrl = actionUrl;
  let linkedActionsNotScanned: number | undefined;
  if (linked.length > 0) {
    const chosen = linked.find((a) => !TEMPLATE_PLACEHOLDER.test(a.href));
    if (chosen === undefined) return inputRequired();
    try {
      postUrl = new URL(chosen.href, actionUrl).href;
    } catch {
      return disallowed();
    }
    linkedActionsNotScanned = linked.length - 1;
  }

  // 5. POST and validate the transaction.
  const posted = await postForTransaction(postUrl, account, deps);
  if (!posted.ok) return posted;

  const result: FetchedTransaction = { ok: true, base64: posted.base64, metadata };
  if (linkedActionsNotScanned !== undefined) result.linkedActionsNotScanned = linkedActionsNotScanned;
  return result;
}

export async function fetchTransactionRequest(
  link: string,
  account: Address,
  deps: SafeFetchDeps = defaultSafeFetchDeps,
): Promise<FetchedTransaction | FetchFailure> {
  // GET for label/icon; any failure is ignored except a guard refusal, which the POST would repeat.
  const got = await requestJson('GET', link, undefined, deps);
  if (!got.ok && got.flag.ruleId === 'DISALLOWED_URL') return got;

  const metadata: ActionMetadataView = {};
  if (got.ok) {
    const parsed = TransactionRequestGetSchema.safeParse(got.json);
    if (parsed.success) {
      if (parsed.data.label !== undefined) metadata.label = untrusted(parsed.data.label);
      if (parsed.data.icon !== undefined) metadata.icon = untrusted(parsed.data.icon);
    }
  }

  const posted = await postForTransaction(link, account, deps);
  if (!posted.ok) return posted;

  const result: FetchedTransaction = { ok: true, base64: posted.base64 };
  if (metadata.label !== undefined || metadata.icon !== undefined) result.metadata = metadata;
  return result;
}
