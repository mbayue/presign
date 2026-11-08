import { Events } from 'discord.js';
import { log } from '../../log.ts';
import { registerInGuilds } from '../register-commands.ts';
import type { BotEvent } from '../types.ts';

/** Registers the loaded commands in every guild, then logs the counts (Req 18.1, 18.6). */
export const event: BotEvent<typeof Events.ClientReady> = {
  name: Events.ClientReady,
  once: true,
  async execute(ctx, client) {
    log('info', { code: 'READY', count: client.guilds.cache.size });
    const commands = [...ctx.commands.values()];
    const { succeeded } = await registerInGuilds(client.guilds.cache.values(), commands);
    log('info', { code: 'COMMANDS_REGISTERED', commandCount: commands.length, guildCount: succeeded });
  },
};
