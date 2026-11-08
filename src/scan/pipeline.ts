/**
 * Scan_Pipeline: the one function both the Discord handler and the CLI call
 * (Req 15.5). Stages: cluster selection → cache → fetch or build → decode →
 * simulate → mint enrichment → risk rules → Explorer link → AI summary.
 *
 * The Verdict and Flags are final before the AI step runs, and the AI output is
 * only attached as `aiSummary` (Req 9.6, 10.5). Nothing here signs or sends.
 */
import type { Address } from '@solana/kit';
import type { Config } from '../config.ts';
import { explain, type AiDeps } from '../ai/explainer.ts';
import type { AiContext } from '../ai/prompt.ts';
import { fetchBlinkTransaction, fetchTransactionRequest } from '../fetch/action-fetcher.ts';
import { createActionsJsonResolver } from '../fetch/actions-json.ts';
import { defaultSafeFetchDeps } from '../fetch/safe-fetch.ts';
import type { ActionsJsonResolver, SafeFetchDeps } from '../fetch/types.ts';
import { hostOf, log } from '../log.ts';
import { evaluate } from '../risk/engine.ts';
import { flagFrom, flagTemplates, type FlagRequest } from '../risk/flags.ts';
import type { RiskInput } from '../risk/types.ts';
import { computeVerdict } from '../risk/verdict.ts';
import { decodeTransaction } from '../solana/decoder.ts';
import { selectExplorerLink } from '../solana/explorer.ts';
import { parseCompiled } from '../solana/instruction-parser.ts';
import { knownProgramSet } from '../solana/known-programs.ts';
import { createClusterRpcs } from '../solana/rpc.ts';
import { computeBalanceChanges, preTokenAccounts, simulate, toBalanceSnapshot } from '../solana/simulator.ts';
import { buildTransferTransaction } from '../solana/transfer-builder.ts';
import type { AccountSnapshot, ClusterRpcs, InstructionRecord, MintView } from '../solana/types.ts';
import { selectCluster } from './cluster.ts';
import { collectMints, enrichMints } from './enrich.ts';
import { createResultCache, type ResultCache } from './result-cache.ts';
import {
  untrusted,
  type ActionMetadataView,
  type BalanceChange,
  type Cluster,
  type Flag,
  type ScanInput,
  type ScannableLink,
  type ScanResult,
  type Untrusted,
} from './types.ts';

export interface PipelineDeps {
  config: Config;
  rpcs: ClusterRpcs;
  http: SafeFetchDeps;
  /** null → no AI requests. */
  ai: AiDeps | null;
  cache: ResultCache;
}

export interface ScanOptions {
  clusterOverride?: Cluster;
  signal?: AbortSignal;
}

const otherCluster = (c: Cluster): Cluster => (c === 'mainnet' ? 'devnet' : 'mainnet');

/** The parts of a result that do not depend on how far the scan got. */
function linkInfo(input: ScanInput): ScanResult['link'] {
  if (input.kind === 'raw-transaction') return { raw: null, kind: 'raw-transaction' };
  const { link } = input;
  switch (link.kind) {
    case 'blink': {
      const host = hostOf(link.actionUrl);
      return host === undefined ? { raw: link.raw, kind: 'blink' } : { raw: link.raw, kind: 'blink', host };
    }
    case 'transaction-request': {
      const host = hostOf(link.request.link);
      return host === undefined
        ? { raw: link.raw, kind: 'transaction-request' }
        : { raw: link.raw, kind: 'transaction-request', host };
    }
    case 'transfer-request':
      return { raw: link.raw, kind: 'transfer-request', recipient: link.request.recipient };
  }
}

function baseResult(input: ScanInput, cluster: Cluster, clusterInfo: ScanResult['clusterInfo']): ScanResult {
  return {
    link: linkInfo(input),
    cluster,
    clusterInfo,
    verdict: 'safe',
    flags: [],
    balanceChanges: [],
    transfers: [],
    simulation: { status: 'skipped' },
    explorer: { none: true },
    timedOut: false,
    extensions: {},
  };
}

/** A result that stopped early with pipeline-level Flags (fetch, build, decode). */
function earlyResult(base: ScanResult, flags: Flag[], extra: Partial<ScanResult> = {}): ScanResult {
  return { ...base, ...extra, flags, verdict: computeVerdict(flags) };
}

type Obtained =
  | {
      ok: true;
      base64: string;
      metadata?: ActionMetadataView;
      linkedActionsNotScanned?: number;
      amountUnspecified: boolean;
    }
  | { ok: false; flag: FlagRequest; metadata?: ActionMetadataView };

async function obtainTransaction(input: ScanInput, cluster: Cluster, deps: PipelineDeps): Promise<Obtained> {
  const subject = deps.config.placeholderAccount;
  if (input.kind === 'raw-transaction') return { ok: true, base64: input.base64, amountUnspecified: false };
  const link: ScannableLink = input.link;
  switch (link.kind) {
    case 'blink':
    case 'transaction-request': {
      const fetched =
        link.kind === 'blink'
          ? await fetchBlinkTransaction(link.actionUrl, subject, deps.http)
          : await fetchTransactionRequest(link.request.link, subject, deps.http);
      if (!fetched.ok) return { ok: false, flag: fetched.flag };
      const out: Obtained = { ok: true, base64: fetched.base64, amountUnspecified: false };
      if (fetched.metadata !== undefined) out.metadata = fetched.metadata;
      if (fetched.linkedActionsNotScanned !== undefined) out.linkedActionsNotScanned = fetched.linkedActionsNotScanned;
      return out;
    }
    case 'transfer-request': {
      const built = await buildTransferTransaction(link.request, subject, cluster, { rpcs: deps.rpcs });
      if (!built.ok) return { ok: false, flag: built.flag };
      return { ok: true, base64: built.base64, amountUnspecified: built.amountUnspecified };
    }
  }
}

function describeInstruction(r: InstructionRecord): string {
  const p = r.parsed;
  switch (p.kind) {
    case 'system-transfer':
      return `System transfer of ${p.lamports} lamports from ${p.source} to ${p.destination}`;
    case 'system-transfer-with-seed':
      return `System transfer (with seed) of ${p.lamports} lamports to ${p.destination}`;
    case 'token-approve':
      return `Token approve: owner ${p.owner} lets ${p.delegate} spend ${p.amount} base units from ${p.source}`;
    case 'token-set-authority':
      return `Token set-authority (${p.authorityType}) on ${p.target} to ${p.newAuthority ?? 'none'}`;
    case 'token-close':
      return `Token close of ${p.account}, rent to ${p.destination}`;
    case 'token-transfer':
      return `Token transfer of ${p.amount} base units from ${p.source} to ${p.destination}`;
    case 'token-mint-to':
      return `Token mint of ${p.amount} base units to ${p.account}`;
    case 'token-burn':
      return `Token burn of ${p.amount} base units from ${p.account}`;
    case 'ata-create':
      return `Create token account ${p.ata} for ${p.wallet}`;
    case 'other':
      return `Instruction to program ${r.programAddress}`;
    case 'unparseable':
      return `Unreadable instruction to program ${r.programAddress}`;
  }
}

/** Collects Untrusted strings for the AI data block (Blink metadata, first 10 logs). */
function untrustedItems(result: ScanResult): { label: string; value: Untrusted }[] {
  const items: { label: string; value: Untrusted }[] = [];
  const m = result.metadata;
  if (m?.title) items.push({ label: 'link title', value: m.title });
  if (m?.description) items.push({ label: 'link description', value: m.description });
  if (m?.label) items.push({ label: 'button label', value: m.label });
  for (const [i, l] of (result.simulation.logs ?? []).slice(0, 10).entries()) {
    items.push({ label: `program log ${i + 1}`, value: l });
  }
  return items;
}

type Attempt = { result: ScanResult; programNotFound: boolean; topLevel: InstructionRecord[] };

async function runOnce(
  input: ScanInput,
  cluster: Cluster,
  clusterInfo: ScanResult['clusterInfo'],
  deps: PipelineDeps,
): Promise<Attempt> {
  const subject: Address = deps.config.placeholderAccount;
  const base = baseResult(input, cluster, clusterInfo);

  // 1. Fetch or build the transaction.
  const obtained = await obtainTransaction(input, cluster, deps);
  if (!obtained.ok) {
    return { result: earlyResult(base, [flagFrom(obtained.flag)]), programNotFound: false, topLevel: [] };
  }
  const extra: Partial<ScanResult> = {};
  if (obtained.metadata !== undefined) extra.metadata = obtained.metadata;
  if (obtained.linkedActionsNotScanned !== undefined) extra.linkedActionsNotScanned = obtained.linkedActionsNotScanned;

  // 2. Decode.
  const decoded = await decodeTransaction(obtained.base64, cluster, { rpcs: deps.rpcs });
  if (!decoded.ok) {
    const { error } = decoded;
    const flag =
      error.code === 'TX_TOO_LARGE'
        ? flagTemplates.TX_TOO_LARGE({ version: error.version ?? 'legacy' })
        : error.code === 'UNSUPPORTED_VERSION'
          ? flagTemplates.UNSUPPORTED_VERSION()
          : flagTemplates.DECODE_FAILED();
    return { result: earlyResult(base, [flag], extra), programNotFound: false, topLevel: [] };
  }
  const tx = decoded.tx;
  const topLevel = tx.instructions.map((ix, i) => parseCompiled(ix, i));
  const knownPrograms = knownProgramSet(deps.config.extraKnownPrograms);

  // 3. Simulate (read-only).
  const sim = await simulate(tx, cluster, subject, { rpcs: deps.rpcs });
  const pre: Map<Address, AccountSnapshot> = sim.status === 'unavailable' ? (sim.pre ?? new Map()) : sim.pre;
  const preTokens = preTokenAccounts(pre);
  const inner = sim.status === 'ok' ? sim.inner : [];

  // 4. Mint enrichment and balance changes.
  let mintViews = new Map<Address, MintView>();
  let balanceChanges: BalanceChange[] = [];
  let simulation: RiskInput['simulation'];
  if (sim.status === 'ok') {
    const firstPass = computeBalanceChanges(pre, sim.post, subject, new Map());
    const mints = collectMints([...topLevel, ...inner], preTokens, firstPass);
    mintViews = await enrichMints(mints, cluster, { rpcs: deps.rpcs });
    const decimals = new Map<Address, number>();
    for (const [mint, view] of mintViews) if (view.status === 'ok') decimals.set(mint, view.decimals);
    balanceChanges = computeBalanceChanges(pre, sim.post, subject, decimals);
    simulation = { status: 'ok', balances: toBalanceSnapshot(pre, sim.post, subject, decimals) };
  } else {
    const mints = collectMints(topLevel, preTokens, []);
    mintViews = await enrichMints(mints, cluster, { rpcs: deps.rpcs });
    simulation = sim.status === 'failed' ? { status: 'failed', error: sim.error } : { status: 'unavailable' };
  }

  // 5. Deterministic risk rules. RiskInput has no Untrusted field.
  const risk = evaluate({
    subject,
    knownPrograms,
    topLevel,
    inner,
    simulation,
    preTokenAccounts: preTokens,
    mints: mintViews,
    context: {
      unresolvedAccounts: tx.unresolvedCount > 0,
      amountUnspecified: obtained.amountUnspecified,
      invalidResponses: sim.status === 'unavailable' && sim.reason === 'invalid-response' ? ['rpc'] : [],
    },
  });

  const firstRecipient = risk.transfers[0]?.recipient;
  const explorer = selectExplorerLink(
    firstRecipient === undefined
      ? { cluster, messageBase64: tx.messageBase64, topLevel, knownPrograms }
      : { cluster, messageBase64: tx.messageBase64, topLevel, knownPrograms, firstTransferRecipient: firstRecipient },
  );

  const simField: ScanResult['simulation'] =
    sim.status === 'ok'
      ? { status: 'ok', logs: sim.logs }
      : sim.status === 'failed'
        ? { status: 'failed', error: sim.error, logs: sim.logs }
        : { status: 'unavailable' };

  return {
    result: {
      ...base,
      ...extra,
      verdict: risk.verdict,
      flags: risk.flags,
      balanceChanges,
      transfers: risk.transfers,
      simulation: simField,
      explorer,
    },
    programNotFound: sim.status === 'failed' && sim.error.programNotFound,
    topLevel,
  };
}

async function attachAiSummary(result: ScanResult, topLevel: InstructionRecord[], ai: AiDeps | null): Promise<ScanResult> {
  if (ai === null || ai.apiKey === '') return result;
  const ctx: AiContext = {
    verdict: result.verdict,
    flags: result.flags,
    balanceChanges: result.balanceChanges,
    transfers: result.transfers,
    instructionSummary: topLevel.map(describeInstruction),
    cluster: result.cluster,
    untrusted: untrustedItems(result),
  };
  const summary = await explain(ctx, ai);
  if (summary === null || summary === '') {
    log('warn', { code: 'AI_UNAVAILABLE', ...(result.link.host ? { host: result.link.host } : {}) });
    return result;
  }
  // Only the summary is attached; verdict and flags are copied unchanged.
  return { ...result, aiSummary: summary };
}

/** Runs the full pipeline for one input. Never rejects. */
export async function scanLink(input: ScanInput, options: ScanOptions, deps: PipelineDeps): Promise<ScanResult> {
  const link = input.kind === 'link' ? input.link : null;
  const selection = selectCluster(link, deps.config.defaultCluster, options.clusterOverride);
  const clusterInfo: ScanResult['clusterInfo'] =
    selection.unsupportedValue === undefined
      ? { source: selection.source }
      : { source: selection.source, unsupportedValue: untrusted(selection.unsupportedValue) };

  const cacheKey = link?.raw;
  if (cacheKey !== undefined) {
    const cached = deps.cache.get(cacheKey, selection.cluster);
    if (cached) return cached;
  }

  const started = Date.now();
  let final: ScanResult;
  try {
    let attempt = await runOnce(input, selection.cluster, clusterInfo, deps);
    if (attempt.programNotFound && selection.source === 'default') {
      // Req 6.3/6.4: retry once on the other cluster, only when the cluster was the default.
      const other = otherCluster(selection.cluster);
      log('info', { code: 'CLUSTER_FALLBACK' });
      const second = await runOnce(input, other, { ...clusterInfo, fallbackFrom: selection.cluster }, deps);
      if (second.programNotFound) {
        const tried: [Cluster, Cluster] = [selection.cluster, other];
        const flags = [...second.result.flags, flagTemplates.CLUSTER_FALLBACK_FAILED({ tried })];
        second.result = {
          ...second.result,
          clusterInfo: { ...second.result.clusterInfo, triedBoth: tried },
          flags,
          verdict: computeVerdict(flags),
        };
      }
      attempt = second;
    }
    final = await attachAiSummary(attempt.result, attempt.topLevel, deps.ai);
  } catch {
    // Req 14.7: any unhandled stage error becomes a 🟡 SCAN_FAILED result.
    log('error', { code: 'SCAN_FAILED' });
    const flags = [flagTemplates.SCAN_FAILED()];
    final = { ...baseResult(input, selection.cluster, clusterInfo), flags, verdict: computeVerdict(flags) };
  }

  log('info', {
    code: 'SCAN_DONE',
    verdict: final.verdict,
    ruleIds: final.flags.map((f) => f.ruleId),
    durationMs: Date.now() - started,
    ...(final.link.host ? { host: final.link.host } : {}),
  });

  if (cacheKey !== undefined && !final.flags.some((f) => f.ruleId === 'SCAN_FAILED')) {
    deps.cache.set(cacheKey, final.cluster, final);
  }
  return final;
}

/** AI deps from config, or null when no key is configured (Req 17.8). */
export function aiDepsFromConfig(config: Config): AiDeps | null {
  if (config.aiApiKey === '') return null;
  return {
    apiKey: config.aiApiKey,
    baseUrl: config.aiBaseUrl,
    model: config.aiModel,
    fallbackModel: config.aiFallbackModel,
  };
}

export function createPipelineDeps(config: Config, overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    config,
    rpcs: overrides.rpcs ?? createClusterRpcs(config.rpcUrls),
    http: overrides.http ?? defaultSafeFetchDeps,
    ai: overrides.ai === undefined ? aiDepsFromConfig(config) : overrides.ai,
    cache: overrides.cache ?? createResultCache(),
  };
}

/** Factory used by the Discord bot (src/index.ts). */
export function createScanner(
  config: Config,
  overrides: Partial<PipelineDeps> = {},
): { scanLink(link: ScannableLink, signal: AbortSignal): Promise<ScanResult>; resolver: ActionsJsonResolver; deps: PipelineDeps } {
  const deps = createPipelineDeps(config, overrides);
  const resolver = createActionsJsonResolver(deps.http);
  return {
    deps,
    resolver,
    scanLink: (link, signal) => scanLink({ kind: 'link', link }, { signal }, deps),
  };
}
