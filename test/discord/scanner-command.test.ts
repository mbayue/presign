import { describe, expect, test } from 'bun:test';
import { ApplicationCommandOptionType, ChannelType, InteractionContextType, PermissionFlagsBits } from 'discord.js';
import {
  applySettingsUpdate,
  command,
  NOT_SAVED,
  runSettingsCommand,
  type BotChannelPermissions,
  type ChannelChecks,
  type ChannelRef,
} from '../../src/discord/commands/scanner.ts';
import { createMemorySettingsStore } from '../../src/settings/store.ts';
import { defaultSettings, type GuildSettings } from '../../src/settings/types.ts';

const GUILD = '100';
const text = (id: string, guildId: string | null = GUILD): ChannelRef => ({ id, guildId, isText: true });
const ALL: BotChannelPermissions = { view: true, send: true, embedLinks: true };
const checks = (perms: Record<string, Partial<BotChannelPermissions>> = {}): ChannelChecks => ({
  guildId: GUILD,
  botPermissions: (id) => ({ ...ALL, ...perms[id] }),
});
const base = (over: Partial<GuildSettings> = {}): GuildSettings => ({ ...defaultSettings(GUILD), ...over });

describe('applySettingsUpdate', () => {
  test('applies every option and lists changes', () => {
    const r = applySettingsUpdate(base(), { moderationAction: 'hide', logChannel: text('1'), watchAdd: text('2') }, checks());
    expect(r).toEqual({
      ok: true,
      next: base({ moderationAction: 'hide', logChannelId: '1', watchedChannelIds: ['2'] }),
      changes: ['Moderation action: hide', 'Log channel: <#1>', 'Watching: <#2>'],
      noops: [],
    });
  });

  test('no-op add and remove are reported while other valid options still apply', () => {
    const add = applySettingsUpdate(base({ watchedChannelIds: ['2'] }), { moderationAction: 'delete', watchAdd: text('2') }, checks());
    expect(add.ok && add.next.moderationAction).toBe('delete');
    expect(add.ok && add.noops).toEqual(['<#2> was already watched.']);
    expect(add.ok && add.next.watchedChannelIds).toEqual(['2']);

    const remove = applySettingsUpdate(base(), { watchRemove: text('3') }, checks());
    expect(remove).toMatchObject({ ok: true, changes: [], noops: ['<#3> was not watched.'] });
  });

  test('removes a watched channel', () => {
    const r = applySettingsUpdate(base({ watchedChannelIds: ['2', '3'] }), { watchRemove: text('2') }, checks());
    expect(r.ok && r.next.watchedChannelIds).toEqual(['3']);
  });

  test('the 50-channel limit rejects the whole invocation', () => {
    const full = base({ watchedChannelIds: Array.from({ length: 50 }, (_, i) => String(1000 + i)) });
    const r = applySettingsUpdate(full, { moderationAction: 'hide', watchAdd: text('5') }, checks());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('50');
  });

  test('invalid channels name the channel and the problem', () => {
    const cases: [Parameters<typeof applySettingsUpdate>[1], ChannelChecks, string][] = [
      [{ logChannel: { id: '7', guildId: GUILD, isText: false } }, checks(), 'not a text channel'],
      [{ watchAdd: text('7', '555') }, checks(), 'not a text channel'],
      [{ watchAdd: text('7') }, checks({ '7': { view: false } }), 'View Channel'],
      [{ watchAdd: text('7') }, checks({ '7': { send: false } }), 'Send Messages'],
      [{ logChannel: text('7') }, checks({ '7': { embedLinks: false } }), 'Embed Links'],
    ];
    for (const [options, c, problem] of cases) {
      const r = applySettingsUpdate(base(), { moderationAction: 'delete', ...options }, c);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain('<#7>');
      expect(!r.ok && r.error).toContain(problem);
    }
    // Embed Links is not required for a watched channel.
    expect(applySettingsUpdate(base(), { watchAdd: text('7') }, checks({ '7': { embedLinks: false } })).ok).toBe(true);
  });
});

describe('runSettingsCommand', () => {
  test('no options shows defaults', () => {
    const reply = runSettingsCommand({ guildId: GUILD, options: {}, checks: checks(), store: createMemorySettingsStore() });
    expect(reply).toContain('Moderation action: warn');
    expect(reply).toContain('Log channel: not set');
    expect(reply).toContain('Watched channels: none');
  });

  test('saves once and an invalid channel saves nothing', () => {
    const store = createMemorySettingsStore();
    runSettingsCommand({ guildId: GUILD, options: { moderationAction: 'hide', watchAdd: text('2') }, checks: checks(), store });
    expect(store.get(GUILD)).toEqual(base({ moderationAction: 'hide', watchedChannelIds: ['2'] }));

    const reply = runSettingsCommand({
      guildId: GUILD,
      options: { moderationAction: 'delete', logChannel: text('9', '555') },
      checks: checks(),
      store,
    });
    expect(reply).toContain('No settings were saved');
    expect(store.get(GUILD).moderationAction).toBe('hide');
  });

  test('store failure replies "Settings were not saved."', () => {
    const store = createMemorySettingsStore({ failWrites: true });
    expect(runSettingsCommand({ guildId: GUILD, options: { moderationAction: 'delete' }, checks: checks(), store })).toBe(
      NOT_SAVED,
    );
    expect(store.get(GUILD).moderationAction).toBe('warn');
  });
});

describe('command JSON', () => {
  const json = command.data.toJSON();

  test('guild-only with Manage Guild default permission', () => {
    expect(json.name).toBe('scanner');
    expect(json.contexts).toEqual([InteractionContextType.Guild]);
    expect(json.default_member_permissions).toBe(PermissionFlagsBits.ManageGuild.toString());
  });

  test('settings subcommand options; moderation_action has exactly warn/hide/delete', () => {
    const sub = json.options?.[0];
    expect(sub?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(sub?.name).toBe('settings');
    const options = (sub as { options?: { name: string; type: number; choices?: { value: string }[]; channel_types?: number[] }[] })
      .options!;
    expect(options.map((o) => o.name)).toEqual(['moderation_action', 'log_channel', 'watch_add', 'watch_remove']);
    expect(options[0]!.choices!.map((c) => c.value)).toEqual(['warn', 'hide', 'delete']);
    for (const o of options.slice(1)) {
      expect(o.type).toBe(ApplicationCommandOptionType.Channel);
      expect(o.channel_types).toEqual([ChannelType.GuildText]);
    }
  });
});
