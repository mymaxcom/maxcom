import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createUser } from '../src/auth/users.ts';
import { deleteItem, putItem } from '../src/content/store.ts';
import { openDb } from '../src/db.ts';
import { MIGRATIONS, runMigrations } from '../src/migrations/index.ts';
import { putFeature } from '../src/settingsStore.ts';
import { readFeed, snapshot } from '../src/sync/feed.ts';

const { DatabaseSync: Ctor } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const openDbs: DatabaseSync[] = [];
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'surau-feed-'));
  tempDirs.push(dir);
  return dir;
}

function newDb(): DatabaseSync {
  const db = openDb(join(tempDir(), 'test.db'));
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ALL = { users: true, devices: true };
const NONE = { users: false, devices: false };

describe('migration 008', () => {
  it('on a copy of a Plan 5 database backfills rev and keeps every existing row', () => {
    const db = new Ctor(join(tempDir(), 'plan5.db'));
    openDbs.push(db);
    // The base tables as db.ts makes them, then migrations 002 to 007 only: a Plan 5 database.
    db.exec(`
      CREATE TABLE settings (surau_id TEXT NOT NULL DEFAULT 'sdm', feature TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL);
      CREATE TABLE change_log (surau_id TEXT NOT NULL DEFAULT 'sdm', id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT, before_json TEXT, after_json TEXT);
      CREATE TABLE meta (surau_id TEXT NOT NULL DEFAULT 'sdm', key TEXT PRIMARY KEY, value TEXT);
    `);
    const upTo7 = MIGRATIONS.filter((m) => m.name < '008');
    expect(runMigrations(db, upTo7)).toHaveLength(upTo7.length);

    db.prepare("INSERT INTO content_items (kind, id, json, updated_at, updated_by) VALUES ('penceramah', 'p1', '{\"id\":\"p1\",\"name\":\"A\"}', '2026-10-01T01:00:00.000Z', 'local')").run();
    db.prepare("INSERT INTO settings (feature, json, updated_at, updated_by) VALUES ('zone', '{\"zone\":\"SGR01\"}', '2026-10-02T01:00:00.000Z', 'local')").run();
    db.prepare("INSERT INTO users (id, name, roles_json, active, created_at, created_by) VALUES ('u1', 'Ali', '[\"admin\"]', 1, '2026-10-03T01:00:00.000Z', 'local')").run();
    db.prepare("INSERT INTO devices (id, user_id, name, platform, enrolled_at) VALUES ('d1', 'u1', 'Telefon', 'android', '2026-10-04T01:00:00.000Z')").run();
    db.prepare("INSERT INTO change_log (at, actor, entity, entity_id, after_json) VALUES ('2026-10-01T01:00:00.000Z', 'local', 'content:penceramah', 'p1', '{}')").run();

    expect(runMigrations(db)).toEqual(['008-sync', '009-worker-outbox', '010-gate-fixes', '011-upload-replace', '012-youtube-pending-complete', '013-box-codes', '014-hadis-sources', '015-prayer-sources', '016-finance', '017-site-approvals', '018-user-feed-repair']);

    expect(db.prepare('SELECT rev, edited_at, origin FROM content_items WHERE id = ?').get('p1')).toMatchObject({
      rev: '2026-10-01T01:00:00.000Z|local', edited_at: '2026-10-01T01:00:00.000Z', origin: 'local',
    });
    expect(db.prepare('SELECT rev, edited_at FROM settings WHERE feature = ?').get('zone')).toMatchObject({
      rev: '2026-10-02T01:00:00.000Z|local', edited_at: '2026-10-02T01:00:00.000Z',
    });
    expect(db.prepare('SELECT rev, edited_at FROM users WHERE id = ?').get('u1')).toMatchObject({
      rev: '2026-10-03T01:00:00.000Z|local', edited_at: '2026-10-03T01:00:00.000Z',
    });
    expect(db.prepare('SELECT rev, edited_at FROM devices WHERE id = ?').get('d1')).toMatchObject({
      rev: '2026-10-04T01:00:00.000Z|local', edited_at: '2026-10-04T01:00:00.000Z',
    });
    expect(db.prepare('SELECT origin, rev, op_id, synced_at FROM change_log').get()).toMatchObject({
      origin: 'local', rev: '2026-10-01T01:00:00.000Z|local', op_id: null, synced_at: null,
    });
    for (const t of ['applied_ops', 'sync_state', 'sites', 'uploads']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
    }
  });

  it('a local putItem writes origin local and rev <updated_at>|local', () => {
    const db = newDb();
    const { item } = putItem(db, 'penceramah', { name: 'Ustaz Ahmad' }, 'local');
    const row = db.prepare('SELECT rev, edited_at, origin, updated_at FROM content_items WHERE id = ?').get(item.id)!;
    expect(row.origin).toBe('local');
    expect(row.rev).toBe(`${String(row.updated_at)}|local`);
    expect(row.edited_at).toBe(row.updated_at);
    const log = db.prepare('SELECT origin, rev, edited_at, op_id, synced_at FROM change_log ORDER BY id DESC').get()!;
    expect(log).toMatchObject({ origin: 'local', rev: row.rev, edited_at: row.updated_at, op_id: null, synced_at: null });
  });
});

describe('readFeed', () => {
  it('lists content and settings changes in id order with after and tombstones', () => {
    const db = newDb();
    const a = putItem(db, 'penceramah', { name: 'A' }, 'local').item;
    putFeature(db, 'zone', { zone: 'SGR01' }, 'local');
    deleteItem(db, 'penceramah', a.id, 'local');
    const feed = readFeed(db, 0, 500, NONE);
    expect(feed.entries.map((e) => [e.entity, e.entityId])).toEqual([
      ['content:penceramah', a.id], ['settings', 'zone'], ['content:penceramah', a.id],
    ]);
    expect(feed.entries.map((e) => e.seq)).toEqual([...feed.entries.map((e) => e.seq)].sort((x, y) => x - y));
    expect(feed.entries[0]!.after).toMatchObject({ id: a.id, name: 'A' });
    expect(feed.entries[1]!.after).toMatchObject({ zone: 'SGR01' });
    expect(feed.entries[2]!.after).toBeNull();
    expect(feed.entries[0]).toMatchObject({ origin: 'local', opId: null, actor: 'local', deviceId: null });
    expect(feed.entries[0]!.rev).toMatch(/\|local$/);
    expect(feed.next).toBeNull();
  });

  it('never lists live, islamic, youtube or auth entities', () => {
    const db = newDb();
    putItem(db, 'penceramah', { name: 'A' }, 'local');
    for (const entity of ['live', 'islamic', 'youtube/token', 'auth']) {
      db.prepare("INSERT INTO change_log (at, actor, entity, entity_id, after_json) VALUES ('2026-11-05T00:00:00.000Z', 'local', ?, 'x', '{}')").run(entity);
    }
    expect(readFeed(db, 0, 500, ALL).entries.map((e) => e.entity)).toEqual(['content:penceramah']);
  });

  it('hides user entries unless the scope allows them, and devices likewise', () => {
    const db = newDb();
    const u = createUser(db, { name: 'Ali', roles: ['admin'] }, 'local');
    db.prepare("INSERT INTO devices (id, user_id, name, platform, enrolled_at) VALUES ('d1', ?, 'T', 'android', '2026-11-05T00:00:00.000Z')").run(u.id);
    db.prepare("INSERT INTO change_log (at, actor, entity, entity_id, after_json) VALUES ('2026-11-05T00:00:00.000Z', 'local', 'devices', 'd1', '{}')").run();
    expect(readFeed(db, 0, 500, NONE).entries).toEqual([]);
    expect(readFeed(db, 0, 500, { users: true, devices: false }).entries.map((e) => e.entity)).toEqual(['user']);
    expect(readFeed(db, 0, 500, { users: false, devices: true }).entries.map((e) => e.entity)).toEqual(['device']);
    expect(readFeed(db, 0, 500, ALL).entries.map((e) => e.entity)).toEqual(['user', 'device']);
  });

  it('pages by since and next, and head is the highest visible id in the same read', () => {
    const db = newDb();
    for (let i = 0; i < 5; i += 1) putItem(db, 'penceramah', { name: `P${i}` }, 'local');
    db.prepare("INSERT INTO change_log (at, actor, entity, entity_id) VALUES ('2026-11-05T00:00:00.000Z', 'local', 'live', 'x')").run();
    const first = readFeed(db, 0, 2, NONE);
    expect(first.entries).toHaveLength(2);
    expect(first.next).toBe(first.entries[1]!.seq);
    expect(first.head).toBe(5); // the live row (id 6) is not visible, so it does not move the head
    const second = readFeed(db, first.next!, 2, NONE);
    expect(second.entries.map((e) => e.seq)).toEqual([3, 4]);
    const third = readFeed(db, second.next!, 2, NONE);
    expect(third.entries.map((e) => e.seq)).toEqual([5]);
    expect(third.next).toBeNull();
    expect(third.head).toBe(5);
    expect(readFeed(db, 5, 2, NONE)).toEqual({ entries: [], next: null, head: 5 });
  });

  it('head of an empty history is 0', () => {
    expect(readFeed(newDb(), 0, 500, ALL).head).toBe(0);
  });

  it('a change committed after the read does not appear in its entries or its head', () => {
    const db = newDb();
    putItem(db, 'penceramah', { name: 'A' }, 'local');
    const feed = readFeed(db, 0, 500, NONE);
    putItem(db, 'penceramah', { name: 'B' }, 'local');
    expect(feed.head).toBe(1);
    expect(feed.entries).toHaveLength(1);
    expect(readFeed(db, feed.head, 500, NONE).entries).toHaveLength(1);
  });
});

describe('snapshot', () => {
  it('includes a tombstone deleted yesterday and one 100 days ago, not one 190 days ago; seq is the feed head', () => {
    const db = newDb();
    const now = new Date('2026-11-05T02:00:00.000Z');
    const keep = putItem(db, 'penceramah', { name: 'Live' }, 'local').item;
    const recent = putItem(db, 'penceramah', { name: 'Recent' }, 'local').item;
    const old = putItem(db, 'penceramah', { name: 'Old' }, 'local').item;
    const mid = putItem(db, 'penceramah', { name: 'Mid' }, 'local').item;
    deleteItem(db, 'penceramah', mid.id, 'local');
    db.prepare('UPDATE content_items SET deleted_at = ? WHERE id = ?').run('2026-07-27T02:00:00.000Z', mid.id);
    deleteItem(db, 'penceramah', recent.id, 'local');
    deleteItem(db, 'penceramah', old.id, 'local');
    db.prepare('UPDATE content_items SET deleted_at = ? WHERE id = ?').run('2026-11-04T02:00:00.000Z', recent.id);
    db.prepare('UPDATE content_items SET deleted_at = ? WHERE id = ?').run('2026-04-28T02:00:00.000Z', old.id);

    const snap = snapshot(db, NONE, { boxId: 'box1', now });
    const list = snap.content.penceramah!;
    expect(list).toContainEqual(expect.objectContaining({ id: keep.id, name: 'Live' }));
    expect(list).toContainEqual({ id: recent.id, deletedAt: '2026-11-04T02:00:00.000Z' });
    expect(list).toContainEqual({ id: mid.id, deletedAt: '2026-07-27T02:00:00.000Z' });
    expect(list.some((i) => (i as { id: string }).id === old.id)).toBe(false);
    expect(snap.seq).toBe(readFeed(db, 0, 500, NONE).head);
    expect(snap).toMatchObject({ surauId: 'sdm', boxId: 'box1', serverTime: now.toISOString() });
    expect(snap.users).toBeUndefined();
    expect(snap.devices).toBeUndefined();
  });

  it('carries settings and, in scope, users and devices without secrets', () => {
    const db = newDb();
    putFeature(db, 'zone', { zone: 'SGR01' }, 'local');
    const u = createUser(db, { name: 'Ali', roles: ['admin'] }, 'local');
    db.prepare("UPDATE users SET pin_hash = 'SECRET-HASH' WHERE id = ?").run(u.id);
    db.prepare("INSERT INTO devices (id, user_id, name, platform, public_jwk, enrolled_at) VALUES ('d1', ?, 'T', 'android', 'SECRET-KEY', '2026-11-05T00:00:00.000Z')").run(u.id);
    const snap = snapshot(db, ALL, { boxId: 'b' });
    expect(snap.settings.zone).toMatchObject({ zone: 'SGR01' });
    expect(snap.users).toEqual([expect.objectContaining({ id: u.id, name: 'Ali', active: true })]);
    expect(snap.devices).toEqual([expect.objectContaining({ id: 'd1', revokedAt: null })]);
    expect(JSON.stringify(snap)).not.toMatch(/SECRET/);
    expect(snapshot(db, NONE, { boxId: 'b' }).users).toBeUndefined();
  });
});
