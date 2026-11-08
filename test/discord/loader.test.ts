import { describe, expect, test } from 'bun:test';
import { GatewayIntentBits } from 'discord.js';
import path from 'node:path';
import { createClient, createShutdownHandler, INTENTS } from '../../src/discord/client.ts';
import { listModuleFiles, loadCommands, loadEvents, LoaderError } from '../../src/discord/loader.ts';
import { registerCommands, registerInGuilds, type CommandGuild } from '../../src/discord/register-commands.ts';
import { captureLog, discordError } from './helpers.ts';

const fixtures = path.join(import.meta.dir, 'fixtures');

describe('loader', () => {
  test('loads the real command and event directories', async () => {
    const commands = await loadCommands();
    expect([...commands.keys()]).toEqual(['scanner']);
    const events = await loadEvents();
    expect(events.map((e) => e.name).sort()).toEqual(['clientReady', 'guildCreate', 'interactionCreate', 'messageCreate']);
  });

  test('a module that throws names its file', async () => {
    const err = await loadCommands(path.join(fixtures, 'broken-loader')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoaderError);
    expect((err as LoaderError).file).toBe('test/discord/fixtures/broken-loader/broken.ts');
    expect((err as Error).message).toContain('test/discord/fixtures/broken-loader/broken.ts');
  });

  test('a module without the export names its file (recursive)', async () => {
    const err = await loadCommands(path.join(fixtures, 'missing-export')).catch((e: unknown) => e);
    expect((err as Error).message).toContain('missing-export/nested/no-export.ts');
    expect((err as Error).message).toContain('"command"');
  });

  test('lists only .ts modules, skipping .d.ts and .test.ts', async () => {
    const files = await listModuleFiles(path.join(import.meta.dir));
    expect(files.some((f) => f.endsWith('.test.ts'))).toBe(false);
    expect(files.some((f) => f.endsWith('helpers.ts'))).toBe(true);
  });
});

describe('client', () => {
  test('exactly Guilds, GuildMessages, MessageContent and no default mentions', () => {
    expect([...INTENTS]).toEqual([GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]);
    const client = createClient();
    expect(client.options.intents.bitfield).toBe(
      GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent,
    );
    expect(client.options.allowedMentions).toEqual({ parse: [], repliedUser: false });
  });

  test('shutdown marks, destroys, closes, exits 0', async () => {
    const steps: string[] = [];
    const run = createShutdownHandler({
      markShuttingDown: () => steps.push('mark'),
      destroyClient: async () => void steps.push('destroy'),
      closeStore: () => void steps.push('close'),
      exit: (code) => void steps.push(`exit ${code}`),
      log: captureLog().log,
    });
    await run();
    await run();
    expect(steps).toEqual(['mark', 'destroy', 'close', 'exit 0']);
  });

  test('shutdown that does not finish in time logs FLUSH_INCOMPLETE and exits 1', async () => {
    const logs = captureLog();
    const exits: number[] = [];
    const run = createShutdownHandler({
      markShuttingDown: () => {},
      destroyClient: () => new Promise<void>((r) => setTimeout(r, 50)),
      closeStore: () => {},
      exit: (code) => void exits.push(code),
      timeoutMs: 5,
      log: logs.log,
    });
    await run();
    expect(exits).toEqual([1]);
    expect(logs.codes()).toContain('FLUSH_INCOMPLETE');
  });
});

describe('registerCommands', () => {
  const commands = [{ data: { name: 'scanner', toJSON: () => ({ name: 'scanner', description: 'x' }) }, execute: async () => {} }];

  test('sets the whole payload; a failing guild is logged and the rest continue', async () => {
    const logs = captureLog();
    const payloads: unknown[] = [];
    const ok = (id: string): CommandGuild => ({ id, commands: { set: async (p) => void payloads.push(p) } });
    const bad: CommandGuild = { id: '666', commands: { set: async () => Promise.reject(discordError(50001)) } };
    const result = await registerInGuilds([ok('1'), bad, ok('2')], commands, { log: logs.log });
    expect(result).toEqual({ succeeded: 2, failed: 1 });
    expect(payloads).toEqual([[{ name: 'scanner', description: 'x' }], [{ name: 'scanner', description: 'x' }]]);
    expect(logs.entries).toEqual([{ level: 'error', fields: { code: 'REGISTER_FAILED', guildId: '666', discordCode: 50001 } }]);
  });

  test('times out', async () => {
    const logs = captureLog();
    const hang: CommandGuild = { id: '7', commands: { set: () => new Promise(() => {}) } };
    expect(await registerCommands(hang, commands, { timeoutMs: 5, log: logs.log })).toBe(false);
    expect(logs.codes()).toEqual(['REGISTER_FAILED']);
  });
});
