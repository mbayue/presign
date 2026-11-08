/**
 * Bot entry point (Req 17.3, 18.1–18.6).
 */
import { Events } from 'discord.js';
import { loadConfig } from './config.ts';
import { createClient, createShutdownHandler } from './discord/client.ts';
import { bindEvents, loadCommands, loadEvents, LoaderError } from './discord/loader.ts';
import type { BotContext, BotEvent, SlashCommand } from './discord/types.ts';
import { log } from './log.ts';
import { createScanner } from './scan/pipeline.ts';
import { openSettingsStore } from './settings/store.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.discordToken === '') {
    process.stderr.write('Missing DISCORD_TOKEN\n');
    process.exit(1);
  }
  log('info', { code: 'STARTUP' });

  const store = openSettingsStore();
  const scanner = createScanner(config);

  let commands: Map<string, SlashCommand>;
  let events: BotEvent[];
  try {
    commands = await loadCommands();
    events = await loadEvents();
  } catch (err) {
    const file = err instanceof LoaderError ? err.file : undefined;
    log('error', { code: 'LOADER_FAILED', ...(file === undefined ? {} : { file }) });
    process.stderr.write(`Failed to load module${file === undefined ? '' : `: ${file}`}\n`);
    store.close();
    process.exit(1);
  }
  log('info', { code: 'STARTUP', count: commands.size });

  const client = createClient();
  const ctx: BotContext = { client, store, scanner, config, commands, shuttingDown: false };
  bindEvents(client, events, ctx);
  // An unhandled 'error' event would crash the process.
  client.on(Events.Error, () => log('error', { code: 'DISCORD_SEND_FAILED' }));

  const shutdown = createShutdownHandler({
    markShuttingDown: () => {
      ctx.shuttingDown = true;
    },
    destroyClient: () => client.destroy(),
    closeStore: () => store.close(),
    exit: (code) => process.exit(code),
  });
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  try {
    await client.login(config.discordToken);
  } catch {
    log('error', { code: 'LOGIN_REJECTED' });
    await client.destroy().catch(() => undefined);
    store.close();
    process.exit(1);
  }
}

void main();
