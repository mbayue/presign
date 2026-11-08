/**
 * Structured logger with a field allowlist (Req 14.6, 17.9). There is no
 * free-text message field: message content, full URLs, AI prompts and
 * responses, and secrets cannot be logged.
 */
import type { Verdict } from './scan/types.ts';

export type ErrorCode =
  | 'ACTIONS_JSON_UNAVAILABLE'
  | 'URL_BLOCKED'
  | 'FETCH_FAILED'
  | 'INPUT_REQUIRED'
  | 'BUILD_FAILED'
  | 'DECODE_FAILED'
  | 'ALT_UNRESOLVED'
  | 'SIM_FAILED'
  | 'SIM_UNAVAILABLE'
  | 'CLUSTER_FALLBACK'
  | 'MINT_UNREADABLE'
  | 'RULE_UNEVALUATED'
  | 'AI_UNAVAILABLE'
  | 'SCAN_TIMEOUT'
  | 'SCAN_FAILED'
  | 'DISCORD_NO_PERMISSION'
  | 'DISCORD_SEND_FAILED'
  | 'MOD_MISSING_PERMISSION'
  | 'MOD_ACTION_FAILED'
  | 'LOG_CHANNEL_FAILED'
  | 'STORE_OPEN_FAILED'
  | 'STORE_WRITE_FAILED'
  | 'LOADER_FAILED'
  | 'LOGIN_REJECTED'
  | 'REGISTER_FAILED'
  | 'FLUSH_INCOMPLETE';

export type EventCode = 'STARTUP' | 'READY' | 'SCAN_DONE' | 'SHUTDOWN' | 'GUILD_JOIN' | 'COMMANDS_REGISTERED';

export type LogFields = {
  code: ErrorCode | EventCode;
  guildId?: string;
  channelId?: string;
  logChannelId?: string;
  /** Hostname only — use hostOf(url). */
  host?: string;
  verdict?: Verdict;
  ruleIds?: string[];
  durationMs?: number;
  /** Counts only (e.g. commands loaded, guilds registered, links scanned). */
  count?: number;
  /** Module file name for loader errors (a repo path, never user data). */
  file?: string;
  /** Discord API numeric error code. */
  discordCode?: number;
};

export type LogLevel = 'info' | 'warn' | 'error';
export type Logger = (level: LogLevel, fields: LogFields) => void;

export const log: Logger = (level, fields) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, ...fields });
  if (level === 'info') process.stdout.write(`${line}\n`);
  else process.stderr.write(`${line}\n`);
};

/** Returns only the hostname of a URL, or undefined when it does not parse. */
export const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
};
