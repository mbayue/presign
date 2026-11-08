import type {
  ChatInputCommandInteraction,
  Client,
  ClientEvents,
  MessageMentionOptions,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { Config } from '../config.ts';
import type { ActionsJsonResolver } from '../fetch/types.ts';
import type { ScannableLink, ScanResult } from '../scan/types.ts';
import type { SettingsStore } from '../settings/store.ts';

/** What the Discord adapter needs from the scan pipeline (`createScanner(config)`). */
export interface Scanner {
  /** Must resolve (never reject) for every link; `signal` aborts at the 20 s message deadline. */
  scanLink(link: ScannableLink, signal: AbortSignal): Promise<ScanResult>;
  resolver: ActionsJsonResolver;
}

export interface BotContext {
  client: Client;
  store: SettingsStore;
  scanner: Scanner;
  config: Config;
  /** Loaded slash commands by name. */
  commands: ReadonlyMap<string, SlashCommand>;
  /** Set on SIGINT/SIGTERM; no new scans start after this. */
  shuttingDown: boolean;
}

export interface SlashCommand {
  data: { name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  execute(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void>;
}

export interface BotEvent<K extends keyof ClientEvents = keyof ClientEvents> {
  name: K;
  once?: boolean;
  execute(ctx: BotContext, ...args: ClientEvents[K]): Promise<void> | void;
}

/** Every message the bot sends uses this (Req 11.7). */
export const NO_MENTIONS: MessageMentionOptions = Object.freeze({ parse: [], repliedUser: false });
