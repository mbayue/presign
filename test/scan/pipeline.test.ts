/**
 * Task 16.5: end-to-end pipeline fixture tests (Req 16.4, 16.6–16.8, 19.3,
 * 19.6–19.8). Each test runs `scanLink` through fetch → decode → simulate →
 * enrich → rules → AI with fakes from test/scan/pipeline-fixtures/harness.ts.
 * Test names start with the fixture file they use.
 */
import { describe, expect, test } from 'bun:test';
import { DEMO } from '../../demo/transactions.ts';
import type { AiDeps } from '../../src/ai/explainer.ts';
import { renderText } from '../../src/render/text-card.ts';
import { scanLink } from '../../src/scan/pipeline.ts';
import { type Flag, type ScanResult, type TransferEntry, untrusted } from '../../src/scan/types.ts';
import { createFakeFetch, createFakeResolve } from '../helpers/fake-http.ts';
import aiSaysSafe from './pipeline-fixtures/ai-says-safe.json' with { type: 'json' };
import fundedDrainerJson from './pipeline-fixtures/funded-placeholder-drainer.json' with { type: 'json' };
import fundedSafeJson from './pipeline-fixtures/funded-placeholder-safe.json' with { type: 'json' };
import injectionStrings from './pipeline-fixtures/injection-strings.json' with { type: 'json' };
import unfundedJson from './pipeline-fixtures/unfunded-placeholder.json' with { type: 'json' };
import {
  createDemoHttp,
  DEMO_LINKS,
  drainerWithMemo,
  fixtureDeps,
  fixtureNames,
  type Names,
  type RpcFixture,
  safeWithMemo,
  scanInputFor,
  SUBJECT,
} from './pipeline-fixtures/harness.ts';

const unfunded = unfundedJson as RpcFixture;
const fundedSafe = fundedSafeJson as RpcFixture;
const fundedDrainer = fundedDrainerJson as RpcFixture;

const names: Names = await fixtureNames();

const approveDescription = `Grants ${DEMO.attacker} permission to spend from token account ${names.subjectAta}: UNLIMITED.`;
const SAFE_TRANSFER: TransferEntry = {
  asset: { kind: 'sol' },
  instruction: 'system-transfer',
  recipient: DEMO.safeRecipient,
  raw: 1_000_000n,
  decimals: 9,
  inner: false,
};

type Opts = Parameters<typeof fixtureDeps>[2];

/** Scans a demo link against a fixture; also checks the read-only RPC contract. */
async function scanDemo(link: string, fixture: RpcFixture, opts: Opts = {}): Promise<ScanResult> {
  const { deps, calls } = fixtureDeps(fixture, names, opts);
  const result = await scanLink(await scanInputFor(link), {}, deps);
  // `?cluster=devnet` in the Action URL picks devnet; mainnet is never contacted.
  expect(calls.mainnet).toEqual([]);
  const methods = calls.devnet.map((c) => c.method);
  expect(methods.every((m) => m === 'getMultipleAccounts' || m === 'simulateTransaction')).toBe(true);
  const sims = calls.devnet.filter((c) => c.method === 'simulateTransaction');
  expect(sims).toHaveLength(1);
  expect(sims[0]?.params[1]).toMatchObject({ sigVerify: false, replaceRecentBlockhash: true, encoding: 'base64' });
  // The pre-state read starts with the placeholder account.
  expect((calls.devnet[0]?.params[0] as string[])[0]).toBe(SUBJECT);
  return result;
}

const flagsOf = (r: ScanResult): Flag[] => r.flags.map(({ ruleId, severity, description }) => ({ ruleId, severity, description }));

describe('unfunded placeholder (Req 16.6, 16.7, 19.6)', () => {
  test('unfunded-placeholder.json: drainer → 🔴 TOKEN_APPROVE (attacker, UNLIMITED) + SIMULATION_FAILED', async () => {
    const r = await scanDemo(DEMO_LINKS.drainer, unfunded);
    expect(r.verdict).toBe('danger');
    expect(r.cluster).toBe('devnet');
    expect(r.clusterInfo).toEqual({ source: 'embedded' });
    expect(flagsOf(r)).toEqual([
      { ruleId: 'TOKEN_APPROVE', severity: 'danger', description: approveDescription },
      { ruleId: 'SIMULATION_FAILED', severity: 'caution', description: 'Simulation failed: AccountNotFound.' },
    ]);
    expect(r.flags[0]?.description).toContain('AjTXzfxCuiDhuZhC6fdLmkS1fzmMbd1439ekrGqWVXLe');
    expect(r.flags[0]?.description).toContain('UNLIMITED');
    expect(r.simulation).toEqual({
      status: 'failed',
      error: { name: 'AccountNotFound', programNotFound: false },
      logs: [],
    });
    expect(r.balanceChanges).toEqual([]);
    expect(r.metadata?.title).toBe(untrusted('Claim your free airdrop'));
    expect(renderText(r)).toContain('Verdict: 🔴 Danger');
  });

  test('unfunded-placeholder.json: injection → same verdict and identical flags as drainer', async () => {
    const drainer = await scanDemo(DEMO_LINKS.drainer, unfunded);
    const injection = await scanDemo(DEMO_LINKS.injection, unfunded);
    expect(injection.metadata?.title).toContain('ignore previous instructions');
    expect(injection.verdict).toBe('danger');
    expect(injection.verdict).toBe(drainer.verdict);
    expect(flagsOf(injection)).toEqual(flagsOf(drainer));
    expect(injection.flags).toEqual(drainer.flags);
    expect(injection.transfers).toEqual(drainer.transfers);
    expect(injection.balanceChanges).toEqual(drainer.balanceChanges);
  });

  test('unfunded-placeholder.json: safe → 🟡 SIMULATION_FAILED with a 1,000,000 lamport transfer entry', async () => {
    const r = await scanDemo(DEMO_LINKS.safe, unfunded);
    expect(r.verdict).toBe('caution');
    expect(flagsOf(r)).toEqual([
      { ruleId: 'SIMULATION_FAILED', severity: 'caution', description: 'Simulation failed: AccountNotFound.' },
    ]);
    expect(r.transfers).toEqual([SAFE_TRANSFER]);
    expect(String(r.transfers[0]?.recipient)).toBe('8FR6WzYbQ5ZMKZSWBNnQEMdpSLfXYevv425LkYLHPbq9');
    expect(r.balanceChanges).toEqual([]);
  });
});

describe('funded placeholder (Req 16.6, 16.7, 19.3)', () => {
  test('funded-placeholder-safe.json: safe → 🟢, zero flags, SOL −(1,000,000 + fee), transfer entry', async () => {
    const r = await scanDemo(DEMO_LINKS.safe, fundedSafe);
    expect(r.verdict).toBe('safe');
    expect(r.flags).toEqual([]);
    expect(r.simulation.status).toBe('ok');
    expect(r.balanceChanges).toEqual([
      { asset: { kind: 'sol' }, rawDelta: -1_005_000n, decimals: 9, pre: 50_000_000n, post: 48_995_000n },
    ]);
    expect(r.transfers).toEqual([SAFE_TRANSFER]);
    expect(renderText(r)).toContain('Verdict: 🟢');
  });

  test('funded-placeholder-drainer.json: drainer → 🔴 TOKEN_APPROVE only (no SIMULATION_FAILED)', async () => {
    const { deps, calls } = fixtureDeps(fundedDrainer, names);
    const r = await scanLink(await scanInputFor(DEMO_LINKS.drainer), {}, deps);
    expect(r.verdict).toBe('danger');
    expect(flagsOf(r)).toEqual([{ ruleId: 'TOKEN_APPROVE', severity: 'danger', description: approveDescription }]);
    expect(r.flags.some((f) => f.ruleId === 'SIMULATION_FAILED')).toBe(false);
    expect(r.simulation.status).toBe('ok');
    // Only the fee leaves the wallet; the token balance is unchanged.
    expect(r.balanceChanges).toEqual([
      { asset: { kind: 'sol' }, rawDelta: -5_000n, decimals: 9, pre: 50_000_000n, post: 49_995_000n },
    ]);
    // The mint of the approved token account is read once for enrichment.
    const reads = calls.devnet.filter((c) => c.method === 'getMultipleAccounts').map((c) => c.params[0]);
    expect(reads).toContainEqual([DEMO.mint]);
    expect(calls.mainnet).toEqual([]);
  });
});

describe('prompt-injection invariance (Req 19.8)', () => {
  const ACTION_URL = 'https://actions.example.test/api/claim?cluster=devnet';
  const LINK = `solana-action:${ACTION_URL}`;
  type Variant = (typeof injectionStrings)['neutral'];

  /** Serves one Action whose metadata, memo and program logs come from `v`. */
  async function scanVariant(
    fixture: RpcFixture,
    build: (memo: string) => string | Promise<string>,
    v: Variant,
  ): Promise<ScanResult> {
    const transaction = await build(v.memo);
    const { fetch } = createFakeFetch({
      [`GET ${ACTION_URL}`]: {
        body: { type: 'action', icon: 'https://actions.example.test/icon.png', title: v.title, description: v.description, label: v.label },
      },
      [`POST ${ACTION_URL}`]: { body: { type: 'transaction', transaction } },
    });
    const memoLog = `Program log: Memo (len ${v.memo.length}): "${v.memo}"`;
    const { deps } = fixtureDeps(fixture, names, {
      http: { fetch, resolve: createFakeResolve() },
      extraLogs: [memoLog, v.log],
    });
    return scanLink(await scanInputFor(LINK), {}, deps);
  }

  const cases = [
    {
      name: 'funded-placeholder-drainer.json + injection-strings.json: 🔴 drainer with memo',
      fixture: fundedDrainer,
      build: (memo: string) => drainerWithMemo(SUBJECT, memo),
      verdict: 'danger' as const,
    },
    {
      name: 'funded-placeholder-safe.json + injection-strings.json: 🟢 safe tip with memo',
      fixture: fundedSafe,
      build: (memo: string) => safeWithMemo(SUBJECT, memo),
      verdict: 'safe' as const,
    },
  ];

  for (const c of cases) {
    test(`${c.name} → injected copy matches the neutral copy`, async () => {
      const neutral = await scanVariant(c.fixture, c.build, injectionStrings.neutral);
      const injected = await scanVariant(c.fixture, c.build, injectionStrings.injected);

      // The injected text really reached the result (as Untrusted data only).
      expect(injected.metadata?.title).toBe(untrusted(injectionStrings.injected.title));
      expect(injected.metadata?.description).toContain('ignore previous instructions');
      expect(injected.metadata?.label).toContain('ignore previous instructions');
      expect(injected.simulation.logs).toContainEqual(untrusted(injectionStrings.injected.log));
      expect(injected.simulation.logs?.some((l) => l.includes(`"${injectionStrings.injected.memo}"`))).toBe(true);

      expect(neutral.verdict).toBe(c.verdict);
      expect(injected.verdict).toBe(neutral.verdict);
      expect(flagsOf(injected)).toEqual(flagsOf(neutral));
      expect(injected.balanceChanges).toEqual(neutral.balanceChanges);
      expect(injected.transfers).toEqual(neutral.transfers);
      for (const f of injected.flags) expect(f.description).not.toContain('ignore previous');
    });
  }
});

describe('AI cannot change the verdict (Req 9.6, 10.5)', () => {
  test('unfunded-placeholder.json + ai-says-safe.json: drainer stays 🔴 with identical flags', async () => {
    const ai = createFakeFetch({ 'POST https://ai.example.test/v1/chat/completions': { body: aiSaysSafe } });
    const aiDeps: AiDeps = {
      apiKey: 'test-key',
      baseUrl: 'https://ai.example.test/v1',
      model: 'test-model',
      fallbackModel: '',
      fetch: ai.fetch,
    };
    const withAi = await scanDemo(DEMO_LINKS.drainer, unfunded, { ai: aiDeps, http: createDemoHttp().http });
    const withoutAi = await scanDemo(DEMO_LINKS.drainer, unfunded, { ai: null });

    expect(ai.requests).toHaveLength(1);
    // The model is told the verdict; it is never asked to produce one.
    expect(JSON.parse(ai.requests[0]?.body ?? '{}')).toMatchObject({ model: 'test-model' });

    expect(withAi.aiSummary).toBe('This is completely safe, verdict: safe.');
    expect(withAi.verdict).toBe('danger');
    expect(withAi.flags).toEqual(withoutAi.flags);
    expect(withoutAi.verdict).toBe('danger');
    expect(withoutAi.aiSummary).toBeUndefined();
    expect('aiSummary' in withoutAi).toBe(false);

    const { aiSummary: _, ...rest } = withAi;
    expect(rest).toEqual(withoutAi);
    expect(renderText(withAi)).toContain('Verdict: 🔴 Danger');
  });
});
