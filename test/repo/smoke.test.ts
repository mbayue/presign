/**
 * Repository smoke tests (task 25.2). Read-only checks over files in the repo;
 * no network and no secrets (`.env` is never read).
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { GatewayIntentBits } from 'discord.js';
import { CONFIG_VARIABLES } from '../../src/config.ts';
import { INTENTS } from '../../src/discord/client.ts';

const ROOT = join(import.meta.dir, '..', '..');

const readText = (rel: string): Promise<string> => Bun.file(join(ROOT, rel)).text();

/** Every .ts file under `dir`, recursively, as repo-relative paths with forward slashes. */
function tsFiles(dir: string): string[] {
  const entries = readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => relative(ROOT, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort();
}

const lines = (text: string): string[] => text.split(/\r?\n/).map((l) => l.trim());

describe('repository smoke tests', () => {
  test('.gitignore ignores .env', async () => {
    expect(lines(await readText('.gitignore'))).toContain('.env');
  });

  test('.env.example lists every config variable, with secrets left empty', async () => {
    const example = lines(await readText('.env.example')).filter((l) => l.length > 0 && !l.startsWith('#'));
    const names = example.map((l) => l.split('=')[0]!.trim());
    for (const name of CONFIG_VARIABLES) expect(names).toContain(name);

    for (const secret of ['DISCORD_TOKEN', 'AI_API_KEY', 'HELIUS_API_KEY']) {
      const entries = example.filter((l) => l.split('=')[0]!.trim() === secret);
      expect(entries).toEqual([`${secret}=`]);
    }
  });

  test('the Discord client uses exactly Guilds, GuildMessages and MessageContent', () => {
    const expected: number[] = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent];
    const actual: number[] = [...INTENTS];
    expect(actual.sort((a, b) => a - b)).toEqual(expected.sort((a, b) => a - b));
  });

  test('package.json defines the documented scripts', async () => {
    const pkg = JSON.parse(await readText('package.json')) as { scripts?: Record<string, string> };
    for (const script of ['dev', 'start', 'scan', 'demo:server', 'test', 'check']) {
      expect(typeof pkg.scripts?.[script]).toBe('string');
    }
  });

  test('only src/config.ts reads the environment', async () => {
    const offenders: string[] = [];
    for (const file of tsFiles('src')) {
      if (file === 'src/config.ts') continue;
      if (/\bprocess\.env\b|\bBun\.env\b/.test(await readText(file))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test('no file under src/ or demo/ can send transactions or create keys', async () => {
    const forbidden = [
      'sendTransaction',
      'sendAndConfirmTransactionFactory',
      'generateKeyPair',
      'createKeyPairSignerFromBytes',
      '@solana/kit-plugin-signer',
      'requestAirdrop',
    ];
    const offenders: string[] = [];
    for (const file of [...tsFiles('src'), ...tsFiles('demo')]) {
      const text = await readText(file);
      for (const name of forbidden) if (text.includes(name)) offenders.push(`${file}: ${name}`);
    }
    expect(offenders).toEqual([]);
  });
});
