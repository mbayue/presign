import type { MessageCreateOptions, MessageReplyOptions } from 'discord.js';
import type { LogFields, Logger, LogLevel } from '../../src/log.ts';
import type { HandlerMessage } from '../../src/discord/message-handler.ts';
import type { AlertChannel } from '../../src/discord/moderation.ts';

export type Captured = { level: LogLevel; fields: LogFields }[];

export function captureLog(): { log: Logger; entries: Captured; codes(): string[] } {
  const entries: Captured = [];
  return {
    log: (level, fields) => entries.push({ level, fields }),
    entries,
    codes: () => entries.map((e) => e.fields.code),
  };
}

export interface FakeMessageCalls {
  replies: MessageReplyOptions[];
  channelSends: MessageCreateOptions[];
  suppress: boolean[];
  deletes: number;
  alerts: MessageCreateOptions[];
}

export function fakeAlertChannel(calls: FakeMessageCalls, fail?: unknown): AlertChannel {
  return {
    send: async (o) => {
      if (fail !== undefined) throw fail;
      calls.alerts.push(o);
    },
  };
}

export function fakeMessage(
  over: Partial<HandlerMessage> & { failReply?: unknown; failSuppress?: unknown; failDelete?: unknown; logChannel?: AlertChannel | null } = {},
): { message: HandlerMessage; calls: FakeMessageCalls } {
  const calls: FakeMessageCalls = { replies: [], channelSends: [], suppress: [], deletes: 0, alerts: [] };
  const { failReply, failSuppress, failDelete, logChannel, ...rest } = over;
  const message: HandlerMessage = {
    id: 'm1',
    guildId: '100',
    channelId: '200',
    url: 'https://discord.com/channels/100/200/m1',
    authorId: '300',
    authorIsBot: false,
    content: 'look solana-action:https://actions.example.com/api/mint',
    botCanViewChannel: () => true,
    botCanManageMessages: () => true,
    reply: async (o) => {
      calls.replies.push(o);
      if (failReply !== undefined) throw failReply;
    },
    suppressEmbeds: async (s) => {
      calls.suppress.push(s);
      if (failSuppress !== undefined) throw failSuppress;
    },
    delete: async () => {
      calls.deletes++;
      if (failDelete !== undefined) throw failDelete;
    },
    sendToChannel: async (o) => {
      calls.channelSends.push(o);
    },
    fetchLogChannel: async () => (logChannel === undefined ? fakeAlertChannel(calls) : logChannel),
    ...rest,
  };
  return { message, calls };
}

export const discordError = (code: number): Error & { code: number } => Object.assign(new Error(`discord ${code}`), { code });

/** Lets queued promise continuations and a 0 ms macrotask run. */
export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
