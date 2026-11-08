/**
 * Moderation_Handler (Req 12): a pure planner and a thin executor that posts
 * the Safety_Cards, applies hide/delete on 🔴, and sends one Log_Channel alert.
 */
import type { EmbedBuilder, MessageCreateOptions, MessageReplyOptions } from 'discord.js';
import { log as defaultLog, type LogFields, type Logger } from '../log.ts';
import type { ScanResult, Severity, Verdict } from '../scan/types.ts';
import type { GuildSettings, ModerationAction } from '../settings/types.ts';
import { fitLines } from './embed.ts';
import { NO_MENTIONS } from './types.ts';

// ---------------------------------------------------------------------------
// Discord error helpers
// ---------------------------------------------------------------------------

export const DISCORD_MISSING_ACCESS = 50001;
export const DISCORD_MISSING_PERMISSIONS = 50013;
export const DISCORD_UNKNOWN_MESSAGE = 10008;

/** Numeric Discord API error code, when the error carries one. */
export const discordErrorCode = (err: unknown): number | undefined =>
  typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'number' ? err.code : undefined;

export const isPermissionError = (err: unknown): boolean => {
  const code = discordErrorCode(err);
  return code === DISCORD_MISSING_ACCESS || code === DISCORD_MISSING_PERMISSIONS;
};

/** Logs a failed send: DISCORD_NO_PERMISSION for 50001/50013, else DISCORD_SEND_FAILED. Never retried (Req 11.12). */
export function logSendError(err: unknown, ids: { guildId: string; channelId: string }, logger: Logger): void {
  const discordCode = discordErrorCode(err);
  const fields: LogFields = {
    code: isPermissionError(err) ? 'DISCORD_NO_PERMISSION' : 'DISCORD_SEND_FAILED',
    guildId: ids.guildId,
    channelId: ids.channelId,
  };
  if (discordCode !== undefined) fields.discordCode = discordCode;
  logger('warn', fields);
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

export interface ModerationPlan {
  /** True iff at least one result is 🔴 (Req 12.8). */
  red: boolean;
  /** The guild's configured action. */
  configured: ModerationAction;
  /** The action actually applied; 'warn' (reply only) when not red. */
  action: ModerationAction;
  /** hide/delete downgraded to warn for missing Manage Messages (Req 12.5). */
  downgraded: boolean;
  /** Send a Log_Channel alert: red and a Log_Channel is configured (Req 12.4, 12.9). */
  alert: boolean;
}

export function planModeration(input: {
  results: readonly ScanResult[];
  settings: GuildSettings;
  canManageMessages: boolean;
  hasLogChannel: boolean;
}): ModerationPlan {
  const red = input.results.some((r) => r.verdict === 'danger');
  const configured = input.settings.moderationAction;
  if (!red) return { red, configured, action: 'warn', downgraded: false, alert: false };
  const downgraded = configured !== 'warn' && !input.canManageMessages;
  return { red, configured, action: downgraded ? 'warn' : configured, downgraded, alert: input.hasLogChannel };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/** The parts of a guild message the executor touches. */
export interface ModerationTarget {
  id: string;
  guildId: string;
  channelId: string;
  /** Jump link. */
  url: string;
  authorId: string;
  reply(options: MessageReplyOptions): Promise<unknown>;
  suppressEmbeds(suppress: boolean): Promise<unknown>;
  delete(): Promise<unknown>;
  /** Standalone message in the same channel. */
  sendToChannel(options: MessageCreateOptions): Promise<unknown>;
}

export interface AlertChannel {
  send(options: MessageCreateOptions): Promise<unknown>;
}

export interface ModerationOutcome {
  /** Which action failed for a reason other than the planned downgrade. */
  actionFailed: 'hide' | 'delete' | null;
  deleted: boolean;
  cardsPosted: boolean;
  alertSent: boolean;
}

export async function executeModeration(input: {
  plan: ModerationPlan;
  message: ModerationTarget;
  embeds: readonly EmbedBuilder[];
  results: readonly ScanResult[];
  logChannelId: string | null;
  fetchLogChannel: (channelId: string) => Promise<AlertChannel | null>;
  log?: Logger;
}): Promise<ModerationOutcome> {
  const { plan, message } = input;
  const logger = input.log ?? defaultLog;
  const ids = { guildId: message.guildId, channelId: message.channelId };
  const embeds = [...input.embeds];

  let actionFailed: ModerationOutcome['actionFailed'] = null;
  let deleted = false;
  let messageGone = false;

  const onActionError = (action: 'hide' | 'delete', err: unknown) => {
    actionFailed = action;
    const discordCode = discordErrorCode(err);
    if (discordCode === DISCORD_UNKNOWN_MESSAGE) messageGone = true;
    logger('warn', { code: 'MOD_ACTION_FAILED', ...ids, ...(discordCode === undefined ? {} : { discordCode }) });
  };

  if (plan.red && plan.action === 'hide') {
    try {
      await message.suppressEmbeds(true);
    } catch (err) {
      onActionError('hide', err);
    }
  } else if (plan.red && plan.action === 'delete') {
    try {
      await message.delete();
      deleted = true;
    } catch (err) {
      onActionError('delete', err);
    }
  }

  if (plan.downgraded && !plan.alert) logger('warn', { code: 'MOD_MISSING_PERMISSION', ...ids });

  let cardsPosted = false;
  try {
    if (deleted || messageGone) {
      await message.sendToChannel({ content: postedByLine(message.authorId), embeds, allowedMentions: NO_MENTIONS });
    } else {
      await message.reply({ embeds, allowedMentions: NO_MENTIONS, failIfNotExists: false });
    }
    cardsPosted = true;
  } catch (err) {
    logSendError(err, ids, logger);
  }

  let alertSent = false;
  if (plan.alert && input.logChannelId !== null) {
    const logChannelId = input.logChannelId;
    const channel = await input.fetchLogChannel(logChannelId).catch(() => null);
    if (channel === null) {
      logger('warn', { code: 'LOG_CHANNEL_FAILED', guildId: message.guildId, logChannelId });
    } else {
      try {
        await channel.send({
          content: buildAlert({
            plan,
            results: input.results,
            channelId: message.channelId,
            authorId: message.authorId,
            jumpUrl: deleted || messageGone ? null : message.url,
            actionFailed,
          }),
          allowedMentions: NO_MENTIONS,
        });
        alertSent = true;
      } catch (err) {
        const discordCode = discordErrorCode(err);
        logger('warn', {
          code: 'LOG_CHANNEL_FAILED',
          guildId: message.guildId,
          logChannelId,
          ...(discordCode === undefined ? {} : { discordCode }),
        });
      }
    }
  }

  return { actionFailed, deleted, cardsPosted, alertSent };
}

export const postedByLine = (authorId: string): string => `Posted by <@${authorId}>`;

// ---------------------------------------------------------------------------
// Alert text
// ---------------------------------------------------------------------------

const ALERT_MAX = 2_000;
const LINK_MAX = 300;
const VERDICT_TEXT: Record<Verdict, string> = { safe: '🟢 No risky actions found', caution: '🟡 Caution', danger: '🔴 Danger' };
const SEVERITY_ICON: Record<Severity, string> = { danger: '🔴', caution: '🟡' };

/** Untrusted link text as inline code: backticks and line breaks removed, length capped. */
export function inlineCodeLink(raw: string): string {
  const cleaned = raw.replace(/[`\r\n]/g, '');
  const cut = cleaned.length > LINK_MAX ? `${cleaned.slice(0, LINK_MAX - 1)}…` : cleaned;
  return `\`${cut === '' ? '(empty)' : cut}\``;
}

const ACTION_TEXT: Record<ModerationAction, string> = {
  warn: 'warn (cards posted, message left in place)',
  hide: 'hide (embeds suppressed)',
  delete: 'delete (message deleted)',
};

/** Alert for the Log_Channel (Req 12.4, 12.5, 12.10). Every 🔴 link is inline code; the jump link only when not deleted. */
export function buildAlert(a: {
  plan: ModerationPlan;
  results: readonly ScanResult[];
  channelId: string;
  authorId: string;
  jumpUrl: string | null;
  actionFailed: 'hide' | 'delete' | null;
}): string {
  const applied =
    a.actionFailed === null ? ACTION_TEXT[a.plan.action] : `warn (the "${a.actionFailed}" action failed; cards posted)`;
  const lines: string[] = [
    '**Scanner alert: 🔴 Danger**',
    `Action applied: ${applied}`,
    `Channel: <#${a.channelId}>`,
    `Author ID: ${a.authorId}`,
  ];
  if (a.jumpUrl !== null) lines.push(`Message: ${a.jumpUrl}`);
  if (a.plan.downgraded) {
    lines.push(
      `Note: the configured action "${a.plan.configured}" was not applied because the bot lacks the Manage Messages permission in this channel; "warn" was applied instead.`,
    );
  }
  if (a.actionFailed === 'hide') lines.push('Note: hiding the message embeds failed; the cards were posted anyway.');
  if (a.actionFailed === 'delete') lines.push('Note: deleting the message failed; the cards were posted anyway.');

  a.results.forEach((r, i) => {
    if (r.verdict !== 'danger') return;
    lines.push(`Link ${i + 1}: ${inlineCodeLink(r.link.raw ?? '')} ${VERDICT_TEXT[r.verdict]}`);
    for (const f of r.flags) lines.push(`- ${SEVERITY_ICON[f.severity]} ${f.ruleId}: ${f.description}`);
  });

  return fitLines(lines, ALERT_MAX, (n) => `…and ${n} more lines`);
}
