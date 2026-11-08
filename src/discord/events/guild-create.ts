import { Events } from 'discord.js';
import { log } from '../../log.ts';
import { GUILD_JOIN_REGISTER_TIMEOUT_MS, registerCommands } from '../register-commands.ts';
import type { BotEvent } from '../types.ts';

/** Registers the same command set in a newly joined guild within 10 s (Req 18.2). */
export const event: BotEvent<typeof Events.GuildCreate> = {
  name: Events.GuildCreate,
  async execute(ctx, guild) {
    log('info', { code: 'GUILD_JOIN', guildId: guild.id });
    await registerCommands(guild, ctx.commands.values(), { timeoutMs: GUILD_JOIN_REGISTER_TIMEOUT_MS });
  },
};
