/**
 * Guild command registration (Req 18.1, 18.2, 18.6). `commands.set` replaces
 * the guild's whole command list, so no duplicates remain.
 */
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import { log as defaultLog, type Logger } from '../log.ts';
import { discordErrorCode as discordCodeOf } from './moderation.ts';
import type { SlashCommand } from './types.ts';

export interface CommandGuild {
  id: string;
  commands: { set(payload: RESTPostAPIChatInputApplicationCommandsJSONBody[]): Promise<unknown> };
}

export const GUILD_JOIN_REGISTER_TIMEOUT_MS = 10_000;

export const commandPayload = (commands: Iterable<SlashCommand>): RESTPostAPIChatInputApplicationCommandsJSONBody[] =>
  [...commands].map((c) => c.data.toJSON());

/** Registers in one guild. Failure or timeout logs REGISTER_FAILED with the guild ID and returns false. */
export async function registerCommands(
  guild: CommandGuild,
  commands: Iterable<SlashCommand>,
  opts: { timeoutMs?: number; log?: Logger } = {},
): Promise<boolean> {
  const logger = opts.log ?? defaultLog;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const set = guild.commands.set(commandPayload(commands));
    if (opts.timeoutMs === undefined) {
      await set;
    } else {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('registration timed out')), opts.timeoutMs);
      });
      await Promise.race([set, timeout]);
    }
    return true;
  } catch (err) {
    const discordCode = discordCodeOf(err);
    logger('error', { code: 'REGISTER_FAILED', guildId: guild.id, ...(discordCode === undefined ? {} : { discordCode }) });
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Registers in every guild in turn and returns how many succeeded. */
export async function registerInGuilds(
  guilds: Iterable<CommandGuild>,
  commands: readonly SlashCommand[],
  opts: { log?: Logger } = {},
): Promise<{ succeeded: number; failed: number }> {
  let succeeded = 0;
  let failed = 0;
  for (const guild of guilds) {
    if (await registerCommands(guild, commands, opts)) succeeded++;
    else failed++;
  }
  return { succeeded, failed };
}
