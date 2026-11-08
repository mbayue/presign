import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMemorySettingsStore, openSettingsStore } from '../../src/settings/store.ts';
import { defaultSettings, type GuildSettings } from '../../src/settings/types.ts';
import { captureLog } from '../discord/helpers.ts';

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'scanner-store-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const saved: GuildSettings = {
  guildId: '100',
  moderationAction: 'delete',
  logChannelId: '900',
  watchedChannelIds: ['1', '2'],
};

describe('memory store', () => {
  test('get returns defaults, save then get returns the saved copy', () => {
    const store = createMemorySettingsStore();
    expect(store.get('100')).toEqual(defaultSettings('100'));
    expect(store.save(saved)).toEqual({ ok: true });
    const got = store.get('100');
    expect(got).toEqual(saved);
    got.watchedChannelIds.push('3');
    expect(store.get('100').watchedChannelIds).toEqual(['1', '2']);
  });

  test('failWrites keeps prior values', () => {
    const store = createMemorySettingsStore({ failWrites: true });
    expect(store.save(saved)).toEqual({ ok: false, code: 'STORE_WRITE_FAILED' });
    expect(store.get('100')).toEqual(defaultSettings('100'));
  });
});

describe('sqlite store', () => {
  test('round trip: reopening returns saved values; others get defaults', () => {
    const file = path.join(tempDir(), 'nested', 'settings.sqlite');
    const a = openSettingsStore(file);
    expect(a.degraded).toBe(false);
    expect(a.get('100')).toEqual(defaultSettings('100'));
    expect(a.save(saved)).toEqual({ ok: true });
    expect(a.save({ ...saved, guildId: '101', moderationAction: 'hide' })).toEqual({ ok: true });
    expect(a.save({ ...saved, moderationAction: 'hide' })).toEqual({ ok: true });
    a.close();
    a.close();

    const b = openSettingsStore(file);
    expect(b.get('100')).toEqual({ ...saved, moderationAction: 'hide' });
    expect(b.get('101').moderationAction).toBe('hide');
    expect(b.get('102')).toEqual(defaultSettings('102'));
    b.close();
  });

  test('an invalid row loads as defaults', () => {
    const file = path.join(tempDir(), 'settings.sqlite');
    openSettingsStore(file).close();
    const db = new Database(file);
    db.run('INSERT INTO guild_settings (guild_id, data) VALUES (?, ?)', ['100', '{"moderationAction":"nuke"}']);
    db.run('INSERT INTO guild_settings (guild_id, data) VALUES (?, ?)', ['101', 'not json']);
    db.close();
    const store = openSettingsStore(file);
    expect(store.get('100')).toEqual(defaultSettings('100'));
    expect(store.get('101')).toEqual(defaultSettings('101'));
    store.close();
  });

  test('invalid settings are not saved and the map keeps the old value', () => {
    const logs = captureLog();
    const store = openSettingsStore(path.join(tempDir(), 's.sqlite'), logs.log);
    store.save(saved);
    const bad = { ...saved, moderationAction: 'nuke' } as unknown as GuildSettings;
    expect(store.save(bad).ok).toBe(false);
    expect(store.get('100')).toEqual(saved);
    expect(logs.codes()).toEqual(['STORE_WRITE_FAILED']);
    store.close();
  });

  test('unopenable path → degraded memory-only store with defaults; STORE_OPEN_FAILED logged', () => {
    const dir = tempDir();
    const blocker = path.join(dir, 'file');
    writeFileSync(blocker, 'x');
    const logs = captureLog();
    const store = openSettingsStore(path.join(blocker, 'settings.sqlite'), logs.log);
    expect(store.degraded).toBe(true);
    expect(logs.codes()).toEqual(['STORE_OPEN_FAILED']);
    expect(store.get('100')).toEqual(defaultSettings('100'));
    expect(store.save(saved).ok).toBe(false);
    store.close();
  });
});
