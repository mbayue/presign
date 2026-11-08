/**
 * Settings_Store (Req 13.8, 13.9, 13.12, 18.3). One SQLite row per guild,
 * mirrored in a Map that is loaded at open and updated only after a commit.
 * If the database cannot be opened, the store runs memory-only with defaults
 * and every save fails.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { log as defaultLog, type Logger } from '../log.ts';
import { defaultSettings, MAX_WATCHED_CHANNELS, MODERATION_ACTIONS, type GuildSettings } from './types.ts';

export type SaveResult = { ok: true } | { ok: false; code: 'STORE_WRITE_FAILED' };

export interface SettingsStore {
  /** Saved settings, or defaults when absent or unreadable. Returns a copy. */
  get(guildId: string): GuildSettings;
  /** Atomic. The in-memory copy changes only after the commit succeeds. */
  save(next: GuildSettings): SaveResult;
  /** Checkpoints the WAL and closes the database. Safe to call twice. */
  close(): void;
  /** True when the store could not open its database. */
  readonly degraded: boolean;
}

export const DEFAULT_SETTINGS_PATH = 'data/settings.sqlite';

const SNOWFLAKE = z.string().regex(/^\d{1,20}$/);

const StoredSettingsSchema = z.object({
  moderationAction: z.enum(MODERATION_ACTIONS as [GuildSettings['moderationAction'], ...GuildSettings['moderationAction'][]]),
  logChannelId: SNOWFLAKE.nullable(),
  watchedChannelIds: z.array(SNOWFLAKE).max(MAX_WATCHED_CHANNELS),
  editRescan: z.boolean().optional(),
});

/** Validates stored or incoming data; null when invalid. Removes duplicate channel IDs. */
export function parseSettings(guildId: string, data: unknown): GuildSettings | null {
  const parsed = StoredSettingsSchema.safeParse(data);
  if (!parsed.success) return null;
  const v = parsed.data;
  const settings: GuildSettings = {
    guildId,
    moderationAction: v.moderationAction,
    logChannelId: v.logChannelId,
    watchedChannelIds: [...new Set(v.watchedChannelIds)],
  };
  if (v.editRescan !== undefined) settings.editRescan = v.editRescan;
  return settings;
}

const copy = (s: GuildSettings): GuildSettings => ({ ...s, watchedChannelIds: [...s.watchedChannelIds] });

const serialize = (s: GuildSettings): string =>
  JSON.stringify({
    moderationAction: s.moderationAction,
    logChannelId: s.logChannelId,
    watchedChannelIds: s.watchedChannelIds,
    ...(s.editRescan === undefined ? {} : { editRescan: s.editRescan }),
  });

const WRITE_FAILED: SaveResult = { ok: false, code: 'STORE_WRITE_FAILED' };

/** In-memory store for tests. `failWrites` makes every save fail. */
export function createMemorySettingsStore(opts: { failWrites?: boolean; initial?: GuildSettings[] } = {}): SettingsStore {
  const map = new Map<string, GuildSettings>();
  for (const s of opts.initial ?? []) map.set(s.guildId, copy(s));
  return {
    degraded: false,
    get: (guildId) => copy(map.get(guildId) ?? defaultSettings(guildId)),
    save: (next) => {
      if (opts.failWrites) return WRITE_FAILED;
      const valid = parseSettings(next.guildId, next);
      if (valid === null) return WRITE_FAILED;
      map.set(next.guildId, valid);
      return { ok: true };
    },
    close: () => {},
  };
}

/** Memory-only fallback when the database cannot be opened (Req 13.9). */
function degradedStore(): SettingsStore {
  return {
    degraded: true,
    get: (guildId) => defaultSettings(guildId),
    save: () => WRITE_FAILED,
    close: () => {},
  };
}

export function openSettingsStore(path: string = DEFAULT_SETTINGS_PATH, logger: Logger = defaultLog): SettingsStore {
  let db: Database;
  const map = new Map<string, GuildSettings>();
  try {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    db = new Database(path, { create: true });
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(
      'CREATE TABLE IF NOT EXISTS guild_settings (guild_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)',
    );
    const select = db.prepare<{ guild_id: string; data: string }, []>('SELECT guild_id, data FROM guild_settings');
    const rows = select.all();
    select.finalize();
    for (const row of rows) {
      let data: unknown;
      try {
        data = JSON.parse(row.data);
      } catch {
        continue; // unreadable row → defaults for that guild
      }
      const settings = parseSettings(row.guild_id, data);
      if (settings !== null) map.set(row.guild_id, settings);
    }
  } catch {
    logger('error', { code: 'STORE_OPEN_FAILED' });
    return degradedStore();
  }

  const upsert = db.prepare<unknown, [string, string, number]>(
    'INSERT INTO guild_settings (guild_id, data, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(guild_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
  );
  const write = db.transaction((s: GuildSettings) => {
    upsert.run(s.guildId, serialize(s), Date.now());
  });
  let closed = false;

  return {
    degraded: false,
    get: (guildId) => copy(map.get(guildId) ?? defaultSettings(guildId)),
    save: (next) => {
      const valid = parseSettings(next.guildId, next);
      if (closed || valid === null) {
        logger('error', { code: 'STORE_WRITE_FAILED', guildId: next.guildId });
        return WRITE_FAILED;
      }
      try {
        write(valid);
      } catch {
        logger('error', { code: 'STORE_WRITE_FAILED', guildId: next.guildId });
        return WRITE_FAILED;
      }
      map.set(valid.guildId, valid);
      return { ok: true };
    },
    close: () => {
      if (closed) return;
      closed = true;
      try {
        upsert.finalize();
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally {
        // Statements are finalized, so this closes now rather than lazily.
        db.close();
      }
    },
  };
}
