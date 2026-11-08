/**
 * Message handler (Req 1.6–1.11, 11.1, 11.9, 11.11, 11.12, 12). Gates the
 * message, detects links, scans them under a global semaphore against a 20 s
 * deadline from receipt, and posts exactly one reply through the
 * Moderation_Handler. Late scan results are dropped.
 */
import { PermissionFlagsBits, type Message } from 'discord.js';
import type { Config } from '../config.ts';
import { detectLinks, shouldScanMessage } from '../links/detector.ts';
import { hostOf, log as defaultLog, type Logger } from '../log.ts';
import { toCardModel } from '../render/card-model.ts';
import { flagTemplates } from '../risk/flags.ts';
import {
  realSleep,
  systemClock,
  type Clock,
  type Cluster,
  type Flag,
  type ScannableLink,
  type ScanResult,
  type Sleep,
  type Verdict,
} from '../scan/types.ts';
import { renderEmbed } from './embed.ts';
import {
  executeModeration,
  planModeration,
  type AlertChannel,
  type ModerationTarget,
} from './moderation.ts';
import type { BotContext } from './types.ts';

export const MESSAGE_DEADLINE_MS = 20_000;
export const MAX_CONCURRENT_SCANS = 6;

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

export class Semaphore {
  #active = 0;
  readonly #queue: (() => void)[] = [];

  constructor(readonly max: number) {}

  get active(): number {
    return this.#active;
  }

  get waiting(): number {
    return this.#queue.length;
  }

  /** Runs `fn` when a slot is free. Rejects without running if `signal` aborts while waiting. */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.#acquire(signal);
    try {
      return await fn();
    } finally {
      this.#release();
    }
  }

  #acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    if (this.#active < this.max) {
      this.#active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = this.#queue.indexOf(entry);
        if (i >= 0) this.#queue.splice(i, 1);
        reject(new Error('aborted'));
      };
      const entry = () => {
        signal?.removeEventListener('abort', onAbort);
        this.#active++;
        resolve();
      };
      this.#queue.push(entry);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  #release(): void {
    this.#active--;
    this.#queue.shift()?.();
  }
}

/** Shared by every message (Req 14.x: at most 6 scans at once). */
export const scanSemaphore = new Semaphore(MAX_CONCURRENT_SCANS);

// ---------------------------------------------------------------------------
// Placeholder results
// ---------------------------------------------------------------------------

function placeholderResult(link: ScannableLink, cluster: Cluster, flag: Flag, timedOut: boolean): ScanResult {
  const base: ScanResult['link'] = { raw: link.raw, kind: link.kind };
  if (link.kind === 'blink') {
    const host = hostOf(link.actionUrl);
    if (host !== undefined) base.host = host;
  } else if (link.kind === 'transaction-request') {
    const host = hostOf(link.request.link);
    if (host !== undefined) base.host = host;
  } else {
    base.recipient = link.request.recipient;
  }
  return {
    link: base,
    cluster,
    clusterInfo: { source: 'default' },
    verdict: 'caution',
    flags: [flag],
    balanceChanges: [],
    transfers: [],
    simulation: { status: 'skipped' },
    explorer: { none: true },
    timedOut,
    extensions: {},
  };
}

/** 🟡 card for a link whose scan did not finish by the deadline (Req 11.9). */
export const timeoutResult = (link: ScannableLink, cluster: Cluster): ScanResult =>
  placeholderResult(link, cluster, flagTemplates.SCAN_TIMEOUT(), true);

/** 🟡 card for a scan that rejected; the pipeline is expected never to reject. */
export const failedResult = (link: ScannableLink, cluster: Cluster): ScanResult =>
  placeholderResult(link, cluster, flagTemplates.SCAN_FAILED(), false);

// ---------------------------------------------------------------------------
// Message adapter
// ---------------------------------------------------------------------------

/** What the handler needs from a message; built from discord.js by `adaptMessage`, or faked in tests. */
export interface HandlerMessage extends Omit<ModerationTarget, 'guildId'> {
  guildId: string | null;
  content: string;
  authorIsBot: boolean;
  botCanViewChannel(): boolean;
  botCanManageMessages(): boolean;
  fetchLogChannel(channelId: string): Promise<AlertChannel | null>;
}

export function adaptMessage(message: Message<true>): HandlerMessage {
  const has = (perm: bigint): boolean => {
    const me = message.guild.members.me;
    if (me === null) return false;
    return message.channel.permissionsFor(me)?.has(perm) ?? false;
  };
  return {
    id: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    url: message.url,
    authorId: message.author.id,
    authorIsBot: message.author.bot,
    content: message.content,
    botCanViewChannel: () => has(PermissionFlagsBits.ViewChannel),
    botCanManageMessages: () => has(PermissionFlagsBits.ManageMessages),
    reply: (o) => message.reply(o),
    suppressEmbeds: (s) => message.suppressEmbeds(s),
    delete: () => message.delete(),
    sendToChannel: (o) => message.channel.send(o),
    fetchLogChannel: async (channelId) => {
      const ch = await message.guild.channels.fetch(channelId).catch(() => null);
      return ch !== null && ch.isSendable() ? ch : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export type HandlerContext = Pick<BotContext, 'store' | 'scanner' | 'shuttingDown'> & {
  config: Pick<Config, 'defaultCluster'>;
};

export interface MessageHandlerDeps {
  clock: Clock;
  sleep: Sleep;
  deadlineMs: number;
  semaphore: Semaphore;
  detect: typeof detectLinks;
  log: Logger;
}

export type HandleOutcome =
  | { status: 'ignored' | 'no-links' | 'shutting-down' | 'error' }
  | { status: 'posted'; links: number; timedOut: number; verdicts: Verdict[] };

export async function handleMessage(
  message: HandlerMessage,
  ctx: HandlerContext,
  deps: Partial<MessageHandlerDeps> = {},
): Promise<HandleOutcome> {
  const clock = deps.clock ?? systemClock;
  const sleep = deps.sleep ?? realSleep;
  const deadlineMs = deps.deadlineMs ?? MESSAGE_DEADLINE_MS;
  const semaphore = deps.semaphore ?? scanSemaphore;
  const detect = deps.detect ?? detectLinks;
  const logger = deps.log ?? defaultLog;

  const receivedAt = clock.now();
  if (ctx.shuttingDown) return { status: 'shutting-down' };

  const guildId = message.guildId;
  try {
    if (guildId === null || message.authorIsBot) return { status: 'ignored' };
    const settings = ctx.store.get(guildId);
    const scan = shouldScanMessage({
      inGuild: true,
      authorIsBot: message.authorIsBot,
      channelId: message.channelId,
      watched: settings.watchedChannelIds,
      botCanViewChannel: message.botCanViewChannel(),
    });
    if (!scan) return { status: 'ignored' };

    const links = await detect(message.content, { actions: ctx.scanner.resolver });
    if (links.length === 0) return { status: 'no-links' };
    if (ctx.shuttingDown) return { status: 'shutting-down' };

    const cluster = ctx.config.defaultCluster;
    const controller = new AbortController();
    const results: (ScanResult | undefined)[] = links.map(() => undefined);
    let settled = false;

    const all = Promise.all(
      links.map(async (link, i) => {
        try {
          const r = await semaphore.run(() => ctx.scanner.scanLink(link, controller.signal), controller.signal);
          if (!settled) results[i] = r;
        } catch {
          if (!settled) results[i] = failedResult(link, cluster);
        }
      }),
    );
    const remaining = Math.max(0, receivedAt + deadlineMs - clock.now());
    const deadline = sleep(remaining, controller.signal).catch(() => undefined);
    await Promise.race([all, deadline]);
    settled = true;
    controller.abort();

    let timedOut = 0;
    const final = links.map((link, i) => {
      const r = results[i];
      if (r !== undefined) return r;
      timedOut++;
      return timeoutResult(link, cluster);
    });
    if (timedOut > 0) logger('warn', { code: 'SCAN_TIMEOUT', guildId, channelId: message.channelId, count: timedOut });

    const embeds = final.map((r) => renderEmbed(toCardModel(r)));
    const plan = planModeration({
      results: final,
      settings,
      canManageMessages: message.botCanManageMessages(),
      hasLogChannel: settings.logChannelId !== null,
    });
    const target: ModerationTarget = {
      id: message.id,
      guildId,
      channelId: message.channelId,
      url: message.url,
      authorId: message.authorId,
      reply: (o) => message.reply(o),
      suppressEmbeds: (s) => message.suppressEmbeds(s),
      delete: () => message.delete(),
      sendToChannel: (o) => message.sendToChannel(o),
    };
    await executeModeration({
      plan,
      message: target,
      embeds,
      results: final,
      logChannelId: settings.logChannelId,
      fetchLogChannel: (id) => message.fetchLogChannel(id),
      log: logger,
    });

    const verdicts = final.map((r) => r.verdict);
    logger('info', {
      code: 'SCAN_DONE',
      guildId,
      channelId: message.channelId,
      count: links.length,
      durationMs: clock.now() - receivedAt,
      verdict: verdicts.includes('danger') ? 'danger' : verdicts.includes('caution') ? 'caution' : 'safe',
    });
    return { status: 'posted', links: links.length, timedOut, verdicts };
  } catch {
    logger('error', { code: 'SCAN_FAILED', ...(guildId === null ? {} : { guildId }), channelId: message.channelId });
    return { status: 'error' };
  }
}
