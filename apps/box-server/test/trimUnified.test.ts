import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { deleteItem, putItem } from '../src/content/store.ts';
import { putFeature } from '../src/settingsStore.ts';
import { snapshot } from '../src/sync/feed.ts';
import { retentionDays, trimChangeLog } from '../src/sync/trim.ts';

const NOW = new Date('2026-11-09T00:00:00.000Z');
const ago = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const ALL = { users: true, devices: true };

const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function newDb(): DatabaseSync {
  const db = openDb(':memory:');
  dbs.push(db);
  return db;
}

/** A penceramah created 400 days ago and deleted `days` ago: a tombstone of that age with its last log row. */
function tombstone(db: DatabaseSync, id: string, days: number): void {
  putItem(db, 'penceramah', { id, name: id }, 'local', { editedAt: ago(400), syncedAt: ago(400) });
  deleteItem(db, 'penceramah', id, 'local', { editedAt: ago(days), syncedAt: ago(days) });
  // history rows carry the age of the edit
  db.exec("UPDATE change_log SET at = edited_at WHERE entity LIKE 'content:%'");
}

/** Everything written so far has been pushed (a box never trims what it has not yet sent up). */
const allPushed = (db: DatabaseSync): void => {
  db.prepare("INSERT INTO sync_state (key, value) VALUES ('last_push_seq', '1000000') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
};

const inSnapshot = (db: DatabaseSync, id: string, role: 'box' | 'cloud'): boolean =>
  (snapshot(db, ALL, { boxId: 'b', now: NOW, role }).content.penceramah as { id: string }[]).some((x) => x.id === id);

const lastRow = (db: DatabaseSync, id: string): boolean =>
  db.prepare("SELECT 1 AS x FROM change_log WHERE entity = 'content:penceramah' AND entity_id = ? AND after_json IS NULL").get(id) !== undefined;

describe('one retention window from system.syncHistoryDays', () => {
  it('reads 180 by default, 365 when set, always 365 on the cloud', () => {
    const db = newDb();
    expect(retentionDays(db, 'box')).toBe(180);
    putFeature(db, 'system', { syncHistoryDays: 365 }, 'test');
    expect(retentionDays(db, 'box')).toBe(365);
    expect(retentionDays(db, 'cloud')).toBe(365);
    putFeature(db, 'system', { syncHistoryDays: 180 }, 'test');
    expect(retentionDays(db, 'box')).toBe(180);
    expect(retentionDays(db, 'cloud')).toBe(365);
  });

  it('180 days: a tombstone 179 days old is in the snapshot and its last log row survives the trim; 181 days, neither', () => {
    const db = newDb();
    tombstone(db, 'young', 179);
    tombstone(db, 'old', 181);
    expect(inSnapshot(db, 'young', 'box')).toBe(true);
    expect(inSnapshot(db, 'old', 'box')).toBe(false);
    allPushed(db);
    trimChangeLog(db, 'box', NOW);
    expect(lastRow(db, 'young')).toBe(true);
    expect(lastRow(db, 'old')).toBe(false);
  });

  it('365 days: both survive at 300 days, and a tombstone past 365 goes', () => {
    const db = newDb();
    putFeature(db, 'system', { syncHistoryDays: 365 }, 'test');
    tombstone(db, 'mid', 300);
    tombstone(db, 'ancient', 366);
    expect(inSnapshot(db, 'mid', 'box')).toBe(true);
    expect(inSnapshot(db, 'ancient', 'box')).toBe(false);
    allPushed(db);
    trimChangeLog(db, 'box', NOW);
    expect(lastRow(db, 'mid')).toBe(true);
    expect(lastRow(db, 'ancient')).toBe(false);
  });

  it('the cloud keeps a 300-day tombstone whatever the setting says', () => {
    const db = newDb();
    putFeature(db, 'system', { syncHistoryDays: 180 }, 'test');
    tombstone(db, 'mid', 300);
    expect(inSnapshot(db, 'mid', 'cloud')).toBe(true);
    trimChangeLog(db, 'cloud', NOW);
    expect(lastRow(db, 'mid')).toBe(true);
  });

  it('ordinary history is trimmed by the same window: a 200-day-old older version goes on a box at 180, stays at 365', () => {
    const at180 = newDb();
    putItem(at180, 'penceramah', { id: 'p', name: 'v1' }, 'local', { editedAt: ago(200), syncedAt: ago(200) });
    putItem(at180, 'penceramah', { id: 'p', name: 'v2' }, 'local', { editedAt: ago(5), syncedAt: ago(5) });
    at180.exec("UPDATE change_log SET at = edited_at WHERE entity LIKE 'content:%'");
    allPushed(at180);
    expect(trimChangeLog(at180, 'box', NOW).removed).toBe(1);

    const at365 = newDb();
    putFeature(at365, 'system', { syncHistoryDays: 365 }, 'test');
    putItem(at365, 'penceramah', { id: 'p', name: 'v1' }, 'local', { editedAt: ago(200), syncedAt: ago(200) });
    putItem(at365, 'penceramah', { id: 'p', name: 'v2' }, 'local', { editedAt: ago(5), syncedAt: ago(5) });
    at365.exec("UPDATE change_log SET at = edited_at WHERE entity LIKE 'content:%'");
    allPushed(at365);
    expect(trimChangeLog(at365, 'box', NOW).removed).toBe(0);
  });
});
