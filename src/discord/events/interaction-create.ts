import { Events, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { log } from '../../log.ts';
import { discordErrorCode } from '../moderation.ts';
import { NO_MENTIONS, type BotEvent, type SlashCommand } from '../types.ts';

export const COMMAND_ERROR_REPLY = 'Something went wrong while running this command.';

/** Runs `command`; on error, replies (or follows up) ephemerally and logs. Never throws. */
export async function runCommand(
  interaction: ChatInputCommandInteraction,
  command: SlashCommand,
  ctx: Parameters<SlashCommand['execute']>[1],
): Promise<void> {
  try {
    await command.execute(interaction, ctx);
  } catch (err) {
    const discordCode = discordErrorCode(err);
    log('error', {
      code: 'DISCORD_SEND_FAILED',
      ...(interaction.guildId === null ? {} : { guildId: interaction.guildId }),
      ...(interaction.channelId === null ? {} : { channelId: interaction.channelId }),
      ...(discordCode === undefined ? {} : { discordCode }),
    });
    const reply = { content: COMMAND_ERROR_REPLY, flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS } as const;
    try {
      if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
      else await interaction.reply(reply);
    } catch {
      // The interaction may have expired; nothing more to do.
    }
  }
}

export const event: BotEvent<typeof Events.InteractionCreate> = {
  name: Events.InteractionCreate,
  async execute(ctx, interaction) {
    if (!interaction.isChatInputCommand()) return;
    const command = ctx.commands.get(interaction.commandName);
    if (command === undefined) return;
    await runCommand(interaction, command, ctx);
  },
};
