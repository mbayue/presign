import { Events } from 'discord.js';
import { adaptMessage, handleMessage } from '../message-handler.ts';
import type { BotEvent } from '../types.ts';

/** Direct messages end here (Req 1.8); everything else goes through the handler. */
export const event: BotEvent<typeof Events.MessageCreate> = {
  name: Events.MessageCreate,
  async execute(ctx, message) {
    if (!message.inGuild()) return;
    await handleMessage(adaptMessage(message), ctx);
  },
};
