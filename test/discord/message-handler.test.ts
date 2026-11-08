import { describe, expect, test } from 'bun:test';
import { handleMessage, Semaphore, timeoutResult, type HandlerContext } from '../../src/discord/message-handler.ts';
import type { ActionsJsonResolver } from '../../src/fetch/types.ts';
import type { ScannableLink, ScanResult } from '../../src/scan/types.ts';
import { createMemorySettingsStore } from '../../src/settings/store.ts';
import { defaultSettings } from '../../src/settings/types.ts';
import { scanResult } from '../arbitraries/risk.ts';
import { createFakeClock } from '../helpers/fake-clock.ts';
import { captureLog, discordError, fakeMessage, flush } from './helpers.ts';

const NO_MENTIONS = { parse: [], repliedUser: false };
const resolver: ActionsJsonResolver = { resolve: async () => ({ kind: 'not-blink' }) };

function ctx(scanLink: (link: ScannableLink, signal: AbortSignal) => Promise<ScanResult>, store = createMemorySettingsStore()) {
  const scanned: ScannableLink[] = [];
  const c: HandlerContext = {
    store,
    scanner: {
      resolver,
      scanLink: (link, signal) => {
        scanned.push(link);
        return scanLink(link, signal);
      },
    },
    shuttingDown: false,
    config: { defaultCluster: 'devnet' },
  };
  return { ctx: c, scanned };
}

const okScan = async (link: ScannableLink): Promise<ScanResult> =>
  scanResult({ link: { raw: link.raw, kind: link.kind, host: 'actions.example.com' } });

describe('handleMessage', () => {
  test('no links → no reply', async () => {
    const { message, calls } = fakeMessage({ content: 'gm, solana is cool' });
    const { ctx: c, scanned } = ctx(okScan);
    expect(await handleMessage(message, c, { semaphore: new Semaphore(6), log: captureLog().log })).toEqual({
      status: 'no-links',
    });
    expect(calls.replies).toHaveLength(0);
    expect(scanned).toHaveLength(0);
  });

  test('bot author, DM, unwatched channel, and shutdown are ignored', async () => {
    const store = createMemorySettingsStore({ initial: [{ ...defaultSettings('100'), watchedChannelIds: ['999'] }] });
    const deps = { semaphore: new Semaphore(6), log: captureLog().log };
    for (const over of [{ authorIsBot: true }, { guildId: null }, {}]) {
      const { message, calls } = fakeMessage(over);
      await handleMessage(message, ctx(okScan, store).ctx, deps);
      expect(calls.replies).toHaveLength(0);
    }
    const { message, calls } = fakeMessage();
    const c = ctx(okScan).ctx;
    c.shuttingDown = true;
    expect((await handleMessage(message, c, deps)).status).toBe('shutting-down');
    expect(calls.replies).toHaveLength(0);
  });

  test('one link → exactly one reply with mentions disabled and failIfNotExists false', async () => {
    const { message, calls } = fakeMessage();
    const out = await handleMessage(message, ctx(okScan).ctx, { semaphore: new Semaphore(6), log: captureLog().log });
    expect(out).toMatchObject({ status: 'posted', links: 1, timedOut: 0 });
    expect(calls.replies).toHaveLength(1);
    expect(calls.replies[0]!.allowedMentions).toEqual(NO_MENTIONS);
    expect(calls.replies[0]!.failIfNotExists).toBe(false);
    expect(calls.replies[0]!.embeds).toHaveLength(1);
  });

  test('cards keep link order even when scans finish out of order', async () => {
    const { message, calls } = fakeMessage({
      content: 'solana-action:https://a.example/one then solana-action:https://b.example/two',
    });
    const scan = async (link: ScannableLink): Promise<ScanResult> => {
      if (link.raw.includes('one')) await flush();
      return scanResult({ link: { raw: link.raw, kind: link.kind, host: link.raw.includes('one') ? 'a.example' : 'b.example' } });
    };
    await handleMessage(message, ctx(scan).ctx, { semaphore: new Semaphore(6), log: captureLog().log });
    const embeds = calls.replies[0]!.embeds as { data: { fields?: { name: string; value: string }[] } }[];
    const subjects = embeds.map((e) => e.data.fields?.find((f) => f.name === 'Link host · Cluster')?.value.split(' · ')[0]);
    expect(subjects).toEqual(['a.example', 'b.example']);
  });

  test('hanging scan → timeout card at 20 s, nothing more when it finishes later', async () => {
    const fake = createFakeClock(1_000);
    const { message, calls } = fakeMessage({
      content: 'solana-action:https://fast.example/a and solana-action:https://slow.example/b',
    });
    let finishSlow: (r: ScanResult) => void = () => {};
    let slowSignal: AbortSignal | undefined;
    const scan = (link: ScannableLink, signal: AbortSignal): Promise<ScanResult> => {
      if (link.raw.includes('slow')) {
        slowSignal = signal;
        return new Promise((resolve) => {
          finishSlow = resolve;
        });
      }
      return okScan(link);
    };
    const logs = captureLog();
    const done = handleMessage(message, ctx(scan).ctx, {
      clock: fake.clock,
      sleep: fake.sleep,
      semaphore: new Semaphore(6),
      log: logs.log,
    });
    await flush();
    expect(calls.replies).toHaveLength(0);
    await fake.advance(19_999);
    await flush();
    expect(calls.replies).toHaveLength(0);
    await fake.advance(1);
    const out = await done;
    expect(fake.sleeps).toEqual([20_000]);
    expect(out).toMatchObject({ status: 'posted', links: 2, timedOut: 1, verdicts: ['safe', 'caution'] });
    expect(calls.replies).toHaveLength(1);
    const embeds = calls.replies[0]!.embeds as { data: { title?: string; fields?: { name: string; value: string }[] } }[];
    expect(embeds).toHaveLength(2);
    expect(embeds[1]!.data.title).toContain('Caution');
    expect(embeds[1]!.data.fields?.find((f) => f.name === 'Flags')?.value).toContain('SCAN_TIMEOUT');
    expect(slowSignal?.aborted).toBe(true);
    expect(logs.codes()).toContain('SCAN_TIMEOUT');

    finishSlow(scanResult({ verdict: 'danger' }));
    await flush();
    expect(calls.replies).toHaveLength(1);
    expect(calls.channelSends).toHaveLength(0);
  });

  test('missing permission (50013) is logged with IDs and not retried', async () => {
    const logs = captureLog();
    const { message, calls } = fakeMessage({ failReply: discordError(50013) });
    await handleMessage(message, ctx(okScan).ctx, { semaphore: new Semaphore(6), log: logs.log });
    expect(calls.replies).toHaveLength(1);
    expect(calls.channelSends).toHaveLength(0);
    const entry = logs.entries.find((e) => e.fields.code === 'DISCORD_NO_PERMISSION');
    expect(entry?.fields).toMatchObject({ guildId: '100', channelId: '200', discordCode: 50013 });
  });

  test('a rejected scan becomes a caution card and never crashes', async () => {
    const { message, calls } = fakeMessage();
    const out = await handleMessage(message, ctx(() => Promise.reject(new Error('boom'))).ctx, {
      semaphore: new Semaphore(6),
      log: captureLog().log,
    });
    expect(out).toMatchObject({ status: 'posted', verdicts: ['caution'] });
    expect(calls.replies).toHaveLength(1);
  });

  test('red verdict with delete action deletes and posts standalone', async () => {
    const store = createMemorySettingsStore({ initial: [{ ...defaultSettings('100'), moderationAction: 'delete' }] });
    const { message, calls } = fakeMessage();
    await handleMessage(message, ctx(async () => scanResult({ verdict: 'danger' }), store).ctx, {
      semaphore: new Semaphore(6),
      log: captureLog().log,
    });
    expect(calls.deletes).toBe(1);
    expect(calls.replies).toHaveLength(0);
    expect(calls.channelSends[0]!.content).toBe('Posted by <@300>');
  });
});

describe('Semaphore', () => {
  test('caps concurrency and releases waiters in order', async () => {
    const sem = new Semaphore(2);
    const releases: (() => void)[] = [];
    let running = 0;
    let peak = 0;
    const job = () =>
      sem.run(
        () =>
          new Promise<void>((resolve) => {
            running++;
            peak = Math.max(peak, running);
            releases.push(() => {
              running--;
              resolve();
            });
          }),
      );
    const all = Promise.all([job(), job(), job(), job()]);
    await flush();
    expect(sem.active).toBe(2);
    expect(sem.waiting).toBe(2);
    while (releases.length > 0) {
      releases.shift()!();
      await flush();
    }
    await all;
    expect(peak).toBe(2);
  });

  test('an aborted waiter never runs', async () => {
    const sem = new Semaphore(1);
    let release: () => void = () => {};
    const first = sem.run(() => new Promise<void>((r) => (release = r)));
    const controller = new AbortController();
    let ran = false;
    const second = sem.run(async () => {
      ran = true;
    }, controller.signal);
    controller.abort();
    await expect(second).rejects.toThrow('aborted');
    release();
    await first;
    expect(ran).toBe(false);
    expect(sem.active).toBe(0);
  });
});

test('timeoutResult builds the 🟡 timeout card', () => {
  const r = timeoutResult({ kind: 'blink', raw: 'solana-action:https://x.example/a', via: 'solana-action', actionUrl: 'https://x.example/a' }, 'mainnet');
  expect(r).toMatchObject({
    verdict: 'caution',
    timedOut: true,
    simulation: { status: 'skipped' },
    explorer: { none: true },
    link: { host: 'x.example' },
  });
  expect(r.flags.map((f) => f.ruleId)).toEqual(['SCAN_TIMEOUT']);
});
