/**
 * `/scanner settings` (Req 13). Guild-only, Manage Guild by default. The
 * update is computed by the pure `applySettingsUpdate`, then written in one
 * store call; the ephemeral reply is sent directly without deferring.
 */
import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
} from 'discord.js';
import type { SettingsStore } from '../../settings/store.ts';
import {
  MAX_WATCHED_CHANNELS,
  MODERATION_ACTIONS,
  type GuildSettings,
  type ModerationAction,
} from '../../settings/types.ts';
import { NO_MENTIONS, type BotContext, type SlashCommand } from '../types.ts';

// ---------------------------------------------------------------------------
// Pure update logic
// ---------------------------------------------------------------------------

export interface ChannelRef {
  id: string;
  /** Guild the channel belongs to; null when unknown. */
  guildId: string | null;
  /** True only for a guild text channel. */
  isText: boolean;
}

export interface BotChannelPermissions {
  view: boolean;
  send: boolean;
  embedLinks: boolean;
}

export interface ChannelChecks {
  guildId: string;
  botPermissions(channelId: string): BotChannelPermissions;
}

export interface SettingsOptions {
  moderationAction?: ModerationAction;
  logChannel?: ChannelRef;
  watchAdd?: ChannelRef;
  watchRemove?: ChannelRef;
}

export type SettingsUpdate =
  | { ok: true; next: GuildSettings; changes: string[]; noops: string[] }
  | { ok: false; error: string };

const mention = (id: string): string => `<#${id}>`;

export const hasAnyOption = (o: SettingsOptions): boolean =>
  o.moderationAction !== undefined || o.logChannel !== undefined || o.watchAdd !== undefined || o.watchRemove !== undefined;

function channelProblem(ch: ChannelRef, checks: ChannelChecks, needEmbedLinks: boolean): string | null {
  if (!ch.isText || ch.guildId !== checks.guildId) return 'is not a text channel in this server';
  const p = checks.botPermissions(ch.id);
  const missing: string[] = [];
  if (!p.view) missing.push('View Channel');
  if (!p.send) missing.push('Send Messages');
  if (needEmbedLinks && !p.embedLinks) missing.push('Embed Links');
  return missing.length === 0 ? null : `is missing bot permissions: ${missing.join(', ')}`;
}

/**
 * Applies one invocation (Req 13.2–13.5, 13.10, 13.11, 13.14). Any error saves
 * nothing. An already-watched add or a not-watched remove is reported as a
 * no-op while the other valid options still apply.
 */
export function applySettingsUpdate(current: GuildSettings, options: SettingsOptions, checks: ChannelChecks): SettingsUpdate {
  if (options.logChannel !== undefined) {
    const problem = channelProblem(options.logChannel, checks, true);
    if (problem !== null) return { ok: false, error: `Log channel ${mention(options.logChannel.id)} ${problem}.` };
  }
  if (options.watchAdd !== undefined) {
    const problem = channelProblem(options.watchAdd, checks, false);
    if (problem !== null) return { ok: false, error: `Channel ${mention(options.watchAdd.id)} ${problem}.` };
  }

  const next: GuildSettings = { ...current, watchedChannelIds: [...current.watchedChannelIds] };
  const changes: string[] = [];
  const noops: string[] = [];

  if (options.moderationAction !== undefined) {
    next.moderationAction = options.moderationAction;
    changes.push(`Moderation action: ${options.moderationAction}`);
  }
  if (options.logChannel !== undefined) {
    next.logChannelId = options.logChannel.id;
    changes.push(`Log channel: ${mention(options.logChannel.id)}`);
  }
  if (options.watchAdd !== undefined) {
    const id = options.watchAdd.id;
    if (next.watchedChannelIds.includes(id)) {
      noops.push(`${mention(id)} was already watched.`);
    } else if (next.watchedChannelIds.length >= MAX_WATCHED_CHANNELS) {
      return {
        ok: false,
        error: `The watched channel limit of ${MAX_WATCHED_CHANNELS} has been reached. Remove a channel before adding another.`,
      };
    } else {
      next.watchedChannelIds.push(id);
      changes.push(`Watching: ${mention(id)}`);
    }
  }
  if (options.watchRemove !== undefined) {
    const id = options.watchRemove.id;
    if (!next.watchedChannelIds.includes(id)) {
      noops.push(`${mention(id)} was not watched.`);
    } else {
      next.watchedChannelIds = next.watchedChannelIds.filter((c) => c !== id);
      changes.push(`No longer watching: ${mention(id)}`);
    }
  }

  return { ok: true, next, changes, noops };
}

export function formatSettings(s: GuildSettings): string {
  const watched =
    s.watchedChannelIds.length === 0
      ? 'none (every channel the bot can view is scanned)'
      : s.watchedChannelIds.map(mention).join(', ');
  return [
    '**Scanner settings**',
    `Moderation action: ${s.moderationAction}`,
    `Log channel: ${s.logChannelId === null ? 'not set' : mention(s.logChannelId)}`,
    `Watched channels: ${watched}`,
  ].join('\n');
}

export const NOT_SAVED = 'Settings were not saved.';

/** Computes the update, writes it once, and returns the ephemeral reply text. */
export function runSettingsCommand(input: {
  guildId: string;
  options: SettingsOptions;
  checks: ChannelChecks;
  store: SettingsStore;
}): string {
  const current = input.store.get(input.guildId);
  if (!hasAnyOption(input.options)) return formatSettings(current);

  const update = applySettingsUpdate(current, input.options, input.checks);
  if (!update.ok) return `${update.error}\nNo settings were saved.`;

  const lines: string[] = [];
  if (update.changes.length > 0) {
    if (!input.store.save(update.next).ok) return NOT_SAVED;
    lines.push('Settings saved:', ...update.changes.map((c) => `- ${c}`));
  } else {
    lines.push('No settings changed.');
  }
  if (update.noops.length > 0) lines.push('Unchanged:', ...update.noops.map((n) => `- ${n}`));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Slash command
// ---------------------------------------------------------------------------

export const data = new SlashCommandBuilder()
  .setName('scanner')
  .setDescription('Solana link scanner')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('settings')
      .setDescription('Show or change the scanner settings for this server')
      .addStringOption((o) =>
        o
          .setName('moderation_action')
          .setDescription('What to do with a message that gets a 🔴 verdict')
          .addChoices(...MODERATION_ACTIONS.map((a) => ({ name: a, value: a }))),
      )
      .addChannelOption((o) =>
        o.setName('log_channel').setDescription('Channel for moderator alerts').addChannelTypes(ChannelType.GuildText),
      )
      .addChannelOption((o) =>
        o.setName('watch_add').setDescription('Add a channel to scan').addChannelTypes(ChannelType.GuildText),
      )
      .addChannelOption((o) =>
        o.setName('watch_remove').setDescription('Stop scanning a channel').addChannelTypes(ChannelType.GuildText),
      ),
  );

const isModerationAction = (v: string): v is ModerationAction => (MODERATION_ACTIONS as readonly string[]).includes(v);

function guildChecks(guild: Guild): ChannelChecks {
  return {
    guildId: guild.id,
    botPermissions: (channelId) => {
      const me = guild.members.me;
      const channel = guild.channels.cache.get(channelId);
      const perms = me === null || channel === undefined ? null : channel.permissionsFor(me);
      return {
        view: perms?.has(PermissionFlagsBits.ViewChannel) ?? false,
        send: perms?.has(PermissionFlagsBits.SendMessages) ?? false,
        embedLinks: perms?.has(PermissionFlagsBits.EmbedLinks) ?? false,
      };
    },
  };
}

function readOptions(interaction: ChatInputCommandInteraction<'cached'>): SettingsOptions {
  const options: SettingsOptions = {};
  const ref = (name: string): ChannelRef | undefined => {
    const ch = interaction.options.getChannel(name);
    if (ch === null) return undefined;
    return { id: ch.id, guildId: ch.guildId, isText: ch.type === ChannelType.GuildText };
  };
  const action = interaction.options.getString('moderation_action');
  if (action !== null && isModerationAction(action)) options.moderationAction = action;
  const logChannel = ref('log_channel');
  if (logChannel !== undefined) options.logChannel = logChannel;
  const watchAdd = ref('watch_add');
  if (watchAdd !== undefined) options.watchAdd = watchAdd;
  const watchRemove = ref('watch_remove');
  if (watchRemove !== undefined) options.watchRemove = watchRemove;
  return options;
}

export const command: SlashCommand = {
  data,
  async execute(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
    if (!interaction.inCachedGuild()) {
      await interaction.reply({
        content: 'This command only works in a server.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }
    const content = runSettingsCommand({
      guildId: interaction.guildId,
      options: readOptions(interaction),
      checks: guildChecks(interaction.guild),
      store: ctx.store,
    });
    await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS });
  },
};
