import { describe, expect, test } from 'bun:test';
import { EmbedBuilder } from 'discord.js';
import { buildAlert, executeModeration, planModeration, type ModerationPlan } from '../../src/discord/moderation.ts';
import { flagTemplates } from '../../src/risk/flags.ts';
import type { ScanResult } from '../../src/scan/types.ts';
import { defaultSettings, type ModerationAction } from '../../src/settings/types.ts';
import { DELEGATE, scanResult, TOKEN_ACCOUNT } from '../arbitraries/risk.ts';
import { captureLog, discordError, fakeAlertChannel, fakeMessage } from './helpers.ts';

const NO_MENTIONS = { parse: [], repliedUser: false };

const red = (raw = 'https://evil.example/api/drain'): ScanResult =>
  scanResult({
    link: { raw, kind: 'blink', host: 'evil.example' },
    verdict: 'danger',
    flags: [flagTemplates.TOKEN_APPROVE({ delegate: DELEGATE, tokenAccount: TOKEN_ACCOUNT, raw: 5n })],
  });
const green = (): ScanResult => scanResult();
const yellow = (): ScanResult => scanResult({ verdict: 'caution', flags: [flagTemplates.SCAN_TIMEOUT()], timedOut: true });

const settings = (moderationAction: ModerationAction, logChannelId: string | null = '900') => ({
  ...defaultSettings('100'),
  moderationAction,
  logChannelId,
});

describe('planModeration', () => {
  const cases: [string, ScanResult[], ModerationAction, boolean, boolean, Omit<ModerationPlan, 'configured'>][] = [
    ['all green', [green()], 'delete', true, true, { red: false, action: 'warn', downgraded: false, alert: false }],
    ['timeout card only', [yellow()], 'hide', true, true, { red: false, action: 'warn', downgraded: false, alert: false }],
    ['red warn', [green(), red()], 'warn', true, true, { red: true, action: 'warn', downgraded: false, alert: true }],
    ['red hide', [red()], 'hide', true, true, { red: true, action: 'hide', downgraded: false, alert: true }],
    ['red delete', [red()], 'delete', true, false, { red: true, action: 'delete', downgraded: false, alert: false }],
    ['hide downgraded', [red()], 'hide', false, true, { red: true, action: 'warn', downgraded: true, alert: true }],
    ['delete downgraded', [red()], 'delete', false, false, { red: true, action: 'warn', downgraded: true, alert: false }],
    ['warn never downgraded', [red()], 'warn', false, true, { red: true, action: 'warn', downgraded: false, alert: true }],
  ];
  for (const [name, results, action, canManageMessages, hasLogChannel, expected] of cases) {
    test(name, () => {
      expect(planModeration({ results, settings: settings(action), canManageMessages, hasLogChannel })).toEqual({
        ...expected,
        configured: action,
      });
    });
  }
});

const embeds = [new EmbedBuilder().setTitle('card')];
const plan = (action: ModerationAction, extra: Partial<ModerationPlan> = {}): ModerationPlan => ({
  red: true,
  configured: action,
  action,
  downgraded: false,
  alert: true,
  ...extra,
});

describe('executeModeration', () => {
  test('warn: replies with cards, no ping, message untouched, one alert', async () => {
    const { message, calls } = fakeMessage();
    const out = await executeModeration({
      plan: plan('warn'),
      message: { ...message, guildId: '100' },
      embeds,
      results: [red()],
      logChannelId: '900',
      fetchLogChannel: message.fetchLogChannel,
      log: captureLog().log,
    });
    expect(calls.replies).toHaveLength(1);
    expect(calls.replies[0]).toMatchObject({ allowedMentions: NO_MENTIONS, failIfNotExists: false });
    expect(calls.suppress).toEqual([]);
    expect(calls.deletes).toBe(0);
    expect(calls.alerts).toHaveLength(1);
    expect(calls.alerts[0]!.allowedMentions).toEqual(NO_MENTIONS);
    expect(out.alertSent).toBe(true);
  });

  test('hide: suppresses embeds then replies', async () => {
    const { message, calls } = fakeMessage();
    await executeModeration({
      plan: plan('hide', { alert: false }),
      message: { ...message, guildId: '100' },
      embeds,
      results: [red()],
      logChannelId: null,
      fetchLogChannel: message.fetchLogChannel,
    });
    expect(calls.suppress).toEqual([true]);
    expect(calls.replies).toHaveLength(1);
    expect(calls.alerts).toHaveLength(0);
  });

  test('delete: deletes then posts one standalone message with "Posted by" and no jump link in the alert', async () => {
    const { message, calls } = fakeMessage();
    const out = await executeModeration({
      plan: plan('delete'),
      message: { ...message, guildId: '100' },
      embeds,
      results: [red()],
      logChannelId: '900',
      fetchLogChannel: message.fetchLogChannel,
    });
    expect(calls.deletes).toBe(1);
    expect(calls.replies).toHaveLength(0);
    expect(calls.channelSends).toHaveLength(1);
    expect(calls.channelSends[0]!.content).toBe('Posted by <@300>');
    expect(calls.channelSends[0]!.embeds).toHaveLength(1);
    expect(calls.channelSends[0]!.allowedMentions).toEqual(NO_MENTIONS);
    expect(out.deleted).toBe(true);
    const alert = String(calls.alerts[0]!.content);
    expect(alert).not.toContain(message.url);
    expect(alert).toContain('delete');
  });

  test('suppress failure still replies with cards, logs MOD_ACTION_FAILED, notes it in the alert', async () => {
    const logs = captureLog();
    const { message, calls } = fakeMessage({ failSuppress: discordError(50035) });
    const out = await executeModeration({
      plan: plan('hide'),
      message: { ...message, guildId: '100' },
      embeds,
      results: [red()],
      logChannelId: '900',
      fetchLogChannel: message.fetchLogChannel,
      log: logs.log,
    });
    expect(out.actionFailed).toBe('hide');
    expect(calls.replies).toHaveLength(1);
    expect(logs.codes()).toContain('MOD_ACTION_FAILED');
    expect(String(calls.alerts[0]!.content)).toContain('hiding the message embeds failed');
  });

  test('delete failure on an already-deleted message posts standalone', async () => {
    const { message, calls } = fakeMessage({ failDelete: discordError(10008) });
    await executeModeration({
      plan: plan('delete', { alert: false }),
      message: { ...message, guildId: '100' },
      embeds,
      results: [red()],
      logChannelId: null,
      fetchLogChannel: message.fetchLogChannel,
      log: captureLog().log,
    });
    expect(calls.replies).toHaveLength(0);
    expect(calls.channelSends).toHaveLength(1);
  });

  test('alert failure logs LOG_CHANNEL_FAILED once and keeps the action', async () => {
    const logs = captureLog();
    const { message, calls } = fakeMessage();
    const failing = fakeAlertChannel(calls, discordError(50013));
    const out = await executeModeration({
      plan: plan('delete'),
      message: { ...message, guildId: '100' },
      embeds,
      results: [red()],
      logChannelId: '900',
      fetchLogChannel: async () => failing,
      log: logs.log,
    });
    expect(out.deleted).toBe(true);
    expect(out.alertSent).toBe(false);
    expect(logs.entries.filter((e) => e.fields.code === 'LOG_CHANNEL_FAILED')).toHaveLength(1);
    expect(logs.entries[0]!.fields).toMatchObject({ guildId: '100', logChannelId: '900' });
  });

  test('downgrade without a log channel logs MOD_MISSING_PERMISSION', async () => {
    const logs = captureLog();
    const { message } = fakeMessage();
    await executeModeration({
      plan: plan('warn', { configured: 'delete', downgraded: true, alert: false }),
      message: { ...message, guildId: '100' },
      embeds,
      results: [red()],
      logChannelId: null,
      fetchLogChannel: message.fetchLogChannel,
      log: logs.log,
    });
    expect(logs.entries).toEqual([{ level: 'warn', fields: { code: 'MOD_MISSING_PERMISSION', guildId: '100', channelId: '200' } }]);
  });
});

describe('buildAlert', () => {
  test('contains action, verdict, flags, channel, author ID, inline-code links, jump link, downgrade note', () => {
    const text = buildAlert({
      plan: plan('warn', { configured: 'hide', downgraded: true }),
      results: [green(), red('https://ev`il.example/x')],
      channelId: '200',
      authorId: '300',
      jumpUrl: 'https://discord.com/channels/100/200/m1',
      actionFailed: null,
    });
    expect(text).toContain('Action applied: warn');
    expect(text).toContain('🔴 Danger');
    expect(text).toContain('TOKEN_APPROVE');
    expect(text).toContain('<#200>');
    expect(text).toContain('300');
    expect(text).toContain('`https://evil.example/x`');
    expect(text).toContain('https://discord.com/channels/100/200/m1');
    expect(text).toContain('"hide"');
    expect(text).toContain('Manage Messages');
    expect(text).not.toContain('Link 1');
    expect(text.length).toBeLessThanOrEqual(2000);
  });
});
