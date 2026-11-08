/**
 * Live Discord test restricted to ONE guild and ONE channel.
 *
 *   bun scripts/live-test.ts <guildId> <channelId> [minutes=15]
 *
 * Unlike `bun run dev`, this script:
 * - does not register or change any slash commands;
 * - ignores every message outside the given channel;
 * - posts one message with the three demo links and runs the real message
 *   handler on it (bypassing only the "author is a bot" gate), then keeps
 *   listening so people can paste links in that channel;
 * - uses an in-memory settings store (moderation action: warn).
 *
 * The demo links point at 127.0.0.1:8787, so run `bun run demo:server` first.
 */
import { Events, type Message, type TextChannel } from 'discord.js';
import { loadConfig } from '../src/config.ts';
import { createClient } from '../src/discord/client.ts';
import { adaptMessage, handleMessage, type HandlerContext } from '../src/discord/message-handler.ts';
import { createScanner } from '../src/scan/pipeline.ts';
import { createMemorySettingsStore } from '../src/settings/store.ts';
import { defaultSettings } from '../src/settings/types.ts';

const [guildId, channelId, minutesArg] = process.argv.slice(2);
if (!guildId || !channelId) {
  process.stderr.write('Usage: bun scripts/live-test.ts <guildId> <channelId> [minutes]\n');
  process.exit(2);
}
const minutes = Number(minutesArg ?? '15');

const config = loadConfig();
if (config.discordToken === '') {
  process.stderr.write('Missing DISCORD_TOKEN\n');
  process.exit(1);
}

const store = createMemorySettingsStore({
  initial: [{ ...defaultSettings(guildId), watchedChannelIds: [channelId] }],
});
const ctx: HandlerContext = {
  store,
  scanner: createScanner(config),
  shuttingDown: false,
  config: { defaultCluster: config.defaultCluster },
};

const client = createClient();
client.on(Events.Error, () => process.stderr.write('discord client error\n'));

const report = (label: string, outcome: unknown) => process.stdout.write(`${label}: ${JSON.stringify(outcome)}\n`);

client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot) return;
  if (message.guildId !== guildId || message.channelId !== channelId || !message.inGuild()) return;
  report('user message', await handleMessage(adaptMessage(message), ctx));
});

client.once(Events.ClientReady, async () => {
  process.stdout.write(`logged in as ${client.user?.tag}; guilds: ${client.guilds.cache.size}\n`);
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    process.stderr.write(`Bot is not in guild ${guildId}\n`);
    await client.destroy();
    process.exit(1);
  }
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    process.stderr.write(`Channel ${channelId} not found or not a text channel\n`);
    await client.destroy();
    process.exit(1);
  }
  process.stdout.write(`guild: ${guild.name}; channel: #${(channel as TextChannel).name}\n`);

  const demo = [
    'Presign live test (devnet demo links):',
    'solana-action:http://127.0.0.1:8787/api/actions/drainer?cluster=devnet',
    'solana-action:http://127.0.0.1:8787/api/actions/safe?cluster=devnet',
    'solana-action:http://127.0.0.1:8787/api/actions/injection?cluster=devnet',
  ].join('\n');
  const sent = await (channel as TextChannel).send({ content: demo, allowedMentions: { parse: [] } });
  // The bot's own post would be ignored by the bot-author gate; run the real handler on it anyway.
  const adapted = { ...adaptMessage(sent as Message<true>), authorIsBot: false };
  report('demo message', await handleMessage(adapted, ctx));
  process.stdout.write(`listening in #${(channel as TextChannel).name} for ${minutes} min\n`);
});

setTimeout(async () => {
  ctx.shuttingDown = true;
  await client.destroy();
  process.exit(0);
}, minutes * 60_000);

await client.login(config.discordToken);
