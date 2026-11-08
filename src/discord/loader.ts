/**
 * Recursive command and event loader (Req 18.1, 18.5). Every `.ts` file under
 * the directory must export `command` (commands) or `event` (events). A module
 * that throws on import or lacks the export fails the whole load with a
 * LoaderError naming the file.
 */
import type { Client } from 'discord.js';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { log as defaultLog, type Logger } from '../log.ts';
import type { BotContext, BotEvent, SlashCommand } from './types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const COMMANDS_DIR = path.join(here, 'commands');
export const EVENTS_DIR = path.join(here, 'events');

export class LoaderError extends Error {
  /** Repo-relative path with forward slashes. */
  readonly file: string;
  constructor(file: string, problem: string, cause?: unknown) {
    super(`Failed to load ${file}: ${problem}`, cause === undefined ? undefined : { cause });
    this.name = 'LoaderError';
    this.file = file;
  }
}

const displayPath = (file: string): string => path.relative(process.cwd(), file).split(path.sep).join('/');

const isLoadable = (name: string): boolean =>
  name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.endsWith('.test.ts');

/** Every loadable file under `dir`, recursively, sorted for a stable order. */
export async function listModuleFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return listModuleFiles(full);
      return e.isFile() && isLoadable(e.name) ? [full] : [];
    }),
  );
  return nested.flat().sort((a, b) => a.localeCompare(b));
}

async function loadExports(dir: string, exportName: 'command' | 'event'): Promise<{ file: string; value: unknown }[]> {
  const files = await listModuleFiles(dir);
  const out: { file: string; value: unknown }[] = [];
  for (const file of files) {
    const shown = displayPath(file);
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    } catch (err) {
      throw new LoaderError(shown, 'the module threw while loading', err);
    }
    if (!(exportName in mod) || mod[exportName] === undefined) {
      throw new LoaderError(shown, `missing export "${exportName}"`);
    }
    out.push({ file: shown, value: mod[exportName] });
  }
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function isSlashCommand(v: unknown): v is SlashCommand {
  if (!isObject(v) || typeof v.execute !== 'function' || !isObject(v.data)) return false;
  return typeof v.data.name === 'string' && typeof v.data.toJSON === 'function';
}

function isBotEvent(v: unknown): v is BotEvent {
  return isObject(v) && typeof v.name === 'string' && typeof v.execute === 'function';
}

export async function loadCommands(dir: string = COMMANDS_DIR): Promise<Map<string, SlashCommand>> {
  const commands = new Map<string, SlashCommand>();
  for (const { file, value } of await loadExports(dir, 'command')) {
    if (!isSlashCommand(value)) throw new LoaderError(file, 'export "command" is not a slash command');
    if (commands.has(value.data.name)) throw new LoaderError(file, `duplicate command name "${value.data.name}"`);
    commands.set(value.data.name, value);
  }
  return commands;
}

export async function loadEvents(dir: string = EVENTS_DIR): Promise<BotEvent[]> {
  const events: BotEvent[] = [];
  for (const { file, value } of await loadExports(dir, 'event')) {
    if (!isBotEvent(value)) throw new LoaderError(file, 'export "event" is not an event');
    events.push(value);
  }
  return events;
}

/** Subscribes each event; a rejected handler is logged and never crashes the process. */
export function bindEvents(client: Client, events: readonly BotEvent[], ctx: BotContext, logger: Logger = defaultLog): void {
  for (const event of events) {
    const run = (...args: unknown[]) => {
      try {
        const done = (event.execute as (ctx: BotContext, ...a: unknown[]) => Promise<void> | void)(ctx, ...args);
        if (done instanceof Promise) done.catch(() => logger('error', { code: 'EVENT_FAILED' }));
      } catch {
        logger('error', { code: 'EVENT_FAILED' });
      }
    };
    if (event.once) client.once(event.name, run);
    else client.on(event.name, run);
  }
}
