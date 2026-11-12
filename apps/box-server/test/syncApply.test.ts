import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeedEntry, SyncOp } from '@surau/core';
import { createUser } from '../src/auth/users.ts';
import { getItem, putItem } from '../src/content/store.ts';
import { openDb } from '../src/db.ts';
import { getSettings } from '../src/settingsStore.ts';
import { applyFeedEntry, applyOp } from '../src/sync/apply.ts';
import type { ApplyCtx, VerifiedOp } from '../src/sync/apply.ts';
import { readFeed } from '../src/sync/feed.ts';

const openDbs: DatabaseSync[] = [];
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'surau-apply-'));
  tempDirs.push(dir);
  return dir;
}

function newDb(): { db: DatabaseSync; dir: string } {
  const dir = tempDir();
  const db = openDb(join(dir, 'test.db'));
  openDbs.push(db);
  return { db, dir };
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

const NOW = new Date('2026-11-05T10:00:00.000Z');
const ALL = { users: true, devices: true };

let counter = 0;
function op(over: Partial<VerifiedOp>): VerifiedOp {
  counter += 1;
  return {
    v: 1,
    opId: `OP${String(counter).padStart(24, '0')}`,
    surauId: 'sdm',
    boxId: 'box1',
    deviceId: 'dev-a',
    userId: 'u1',
    kind: 'content.put',
    entity: 'content:penceramah',
    entityId: 'p1',
    baseRev: null,
    editedAt: '2026-11-05T09:00:00.000Z',
    payload: { name: 'Ustaz A' },
    sig: 'x',
    userName: 'Ali',
    ...over,
  };
}

function ctx(dir: string, over: Partial<ApplyCtx> = {}): ApplyCtx {
  return { now: NOW, origin: 'app', actor: 'user:u1', dataDir: dir, ...over };
}

// A valid 1x1 PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('applyOp', () => {
  it('content.put on a fresh id creates the item with the op editedAt and rev, logged as an app write', () => {
    const { db, dir } = newDb();
    const o = op({});
    const r = applyOp(db, o, ctx(dir));
    expect(r).toEqual({ opId: o.opId, status: 'applied', rev: '2026-11-05T09:00:00.000Z|dev-a', reason: null, winner: null });
    expect(getItem(db, 'penceramah', 'p1')).toMatchObject({ id: 'p1', name: 'Ustaz A', updatedAt: '2026-11-05T09:00:00.000Z', updatedBy: 'user:u1' });
    expect(db.prepare("SELECT rev, edited_at, origin FROM content_items WHERE id = 'p1'").get()).toMatchObject({
      rev: '2026-11-05T09:00:00.000Z|dev-a', edited_at: '2026-11-05T09:00:00.000Z', origin: 'app',
    });
    expect(db.prepare('SELECT * FROM change_log ORDER BY id DESC').get()).toMatchObject({
      op_id: o.opId, edited_at: '2026-11-05T09:00:00.000Z', synced_at: NOW.toISOString(), origin: 'app',
      device_id: 'dev-a', rev: '2026-11-05T09:00:00.000Z|dev-a', actor: 'user:u1', entity: 'content:penceramah',
    });
  });

  it('an older op on a newer row is superseded and names the winner', () => {
    const { db, dir } = newDb();
    const user = createUser(db, { name: 'Siti', roles: ['admin'] }, 'local');
    applyOp(db, op({ editedAt: '2026-11-05T09:30:00.000Z', deviceId: 'dev-b', payload: { name: 'Baru' } }), ctx(dir, { actor: `user:${user.id}` }));
    const r = applyOp(db, op({ editedAt: '2026-11-05T09:00:00.000Z', payload: { name: 'Lama' } }), ctx(dir));
    expect(r.status).toBe('superseded');
    expect(r.rev).toBe('2026-11-05T09:30:00.000Z|dev-b');
    expect(r.winner).toEqual({ actor: `user:${user.id}`, userName: 'Siti', editedAt: '2026-11-05T09:30:00.000Z' });
    expect(getItem(db, 'penceramah', 'p1')).toMatchObject({ name: 'Baru' });
  });

  it('a newer op replaces the row', () => {
    const { db, dir } = newDb();
    applyOp(db, op({}), ctx(dir));
    const r = applyOp(db, op({ editedAt: '2026-11-05T09:10:00.000Z', payload: { name: 'Kemas kini' } }), ctx(dir));
    expect(r.status).toBe('applied');
    expect(getItem(db, 'penceramah', 'p1')).toMatchObject({ name: 'Kemas kini' });
  });

  it('the same op twice is applied then duplicate and the row is unchanged', () => {
    const { db, dir } = newDb();
    const o = op({});
    const first = applyOp(db, o, ctx(dir));
    const logs = db.prepare('SELECT COUNT(*) AS n FROM change_log').get();
    const second = applyOp(db, o, ctx(dir));
    expect(first.status).toBe('applied');
    expect(second).toEqual({ opId: o.opId, status: 'duplicate', rev: first.rev, reason: null, winner: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM change_log').get()).toEqual(logs);
    expect(getItem(db, 'penceramah', 'p1')).toMatchObject({ name: 'Ustaz A' });
  });

  it('a tie is won by the greater device id', () => {
    const { db, dir } = newDb();
    applyOp(db, op({ deviceId: 'dev-m', payload: { name: 'M' } }), ctx(dir));
    expect(applyOp(db, op({ deviceId: 'dev-a', payload: { name: 'A' } }), ctx(dir)).status).toBe('superseded');
    expect(getItem(db, 'penceramah', 'p1')).toMatchObject({ name: 'M' });
    expect(applyOp(db, op({ deviceId: 'dev-z', payload: { name: 'Z' } }), ctx(dir)).status).toBe('applied');
    expect(getItem(db, 'penceramah', 'p1')).toMatchObject({ name: 'Z' });
  });

  it('an editedAt later than now plus 5 minutes is clamped to now', () => {
    const { db, dir } = newDb();
    const r = applyOp(db, op({ editedAt: '2026-11-05T12:00:00.000Z' }), ctx(dir));
    expect(r.rev).toBe(`${NOW.toISOString()}|dev-a`);
    const near = applyOp(db, op({ entityId: 'p2', editedAt: '2026-11-05T10:03:00.000Z' }), ctx(dir));
    expect(near.rev).toBe('2026-11-05T10:03:00.000Z|dev-a');
  });

  it('refuses an invalid item, a mismatched entity and a bad time', () => {
    const { db, dir } = newDb();
    expect(applyOp(db, op({ payload: { name: '' } }), ctx(dir))).toMatchObject({ status: 'refused', reason: 'invalid' });
    expect(applyOp(db, op({ entity: 'settings' }), ctx(dir))).toMatchObject({ status: 'refused', reason: 'invalid' });
    expect(applyOp(db, op({ editedAt: 'yesterday' }), ctx(dir))).toMatchObject({ status: 'refused', reason: 'invalid' });
    expect(applyOp(db, op({ entity: 'content:nope' }), ctx(dir))).toMatchObject({ status: 'refused', reason: 'invalid' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM content_items').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM applied_ops').get()).toEqual({ n: 0 });
  });

  it('content.delete tombstones; a repeat is applied without a second log; an older put stays deleted', () => {
    const { db, dir } = newDb();
    applyOp(db, op({}), ctx(dir));
    const del = applyOp(db, op({ kind: 'content.delete', payload: null, editedAt: '2026-11-05T09:20:00.000Z' }), ctx(dir));
    expect(del.status).toBe('applied');
    expect(getItem(db, 'penceramah', 'p1')).toBeNull();
    const logs = db.prepare('SELECT COUNT(*) AS n FROM change_log').get();
    // an older delete of an already deleted row changes nothing; a newer one only moves the tombstone's stamp
    expect(applyOp(db, op({ kind: 'content.delete', payload: null, editedAt: '2026-11-05T09:10:00.000Z' }), ctx(dir)).status).toBe('applied');
    expect(db.prepare('SELECT COUNT(*) AS n FROM change_log').get()).toEqual(logs);
    const old = applyOp(db, op({ editedAt: '2026-11-05T09:15:00.000Z' }), ctx(dir));
    expect(old.status).toBe('superseded');
    expect(getItem(db, 'penceramah', 'p1')).toBeNull();
    // a deliberately later put undeletes
    expect(applyOp(db, op({ editedAt: '2026-11-05T09:40:00.000Z' }), ctx(dir)).status).toBe('applied');
    expect(getItem(db, 'penceramah', 'p1')).not.toBeNull();
  });

  it('settings.put merges a patch; appLock is refused live_only', () => {
    const { db, dir } = newDb();
    const r = applyOp(db, op({ kind: 'settings.put', entity: 'settings', entityId: 'zone', payload: { zone: 'SGR01' } }), ctx(dir));
    expect(r.status).toBe('applied');
    expect(getSettings(db).zone.zone).toBe('SGR01');
    expect(db.prepare("SELECT rev, origin FROM settings WHERE feature = 'zone'").get()).toMatchObject({ rev: '2026-11-05T09:00:00.000Z|dev-a', origin: 'app' });
    const lock = applyOp(db, op({ kind: 'settings.put', entity: 'settings', entityId: 'appLock', payload: { enabled: true } }), ctx(dir));
    expect(lock).toMatchObject({ status: 'refused', reason: 'live_only' });
    expect(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE feature = 'appLock'").get()).toEqual({ n: 0 });
    expect(applyOp(db, op({ kind: 'settings.put', entity: 'settings', entityId: 'nope', payload: {} }), ctx(dir)).reason).toBe('invalid');
  });

  it('asset.put stores a small image once; a 9 MB payload is too_large', () => {
    const { db, dir } = newDb();
    const first = applyOp(db, op({ kind: 'asset.put', entity: 'asset', entityId: 'x', payload: { mime: 'image/png', bytesBase64: PNG_B64 } }), ctx(dir));
    expect(first.status).toBe('applied');
    expect(first.rev).toMatch(/^[0-9a-f]{64}$/);
    expect(db.prepare('SELECT mime, created_by FROM assets WHERE id = ?').get(first.rev!)).toEqual({ mime: 'image/png', created_by: 'user:u1' });
    const again = applyOp(db, op({ kind: 'asset.put', entity: 'asset', entityId: 'x', payload: { mime: 'image/png', bytesBase64: PNG_B64 } }), ctx(dir));
    expect(again).toMatchObject({ status: 'duplicate', rev: first.rev });
    const big = Buffer.alloc(9 * 1024 * 1024, 1).toString('base64');
    expect(applyOp(db, op({ kind: 'asset.put', entity: 'asset', entityId: 'x', payload: { mime: 'image/png', bytesBase64: big } }), ctx(dir))).toMatchObject({ status: 'refused', reason: 'too_large' });
    expect(applyOp(db, op({ kind: 'asset.put', entity: 'asset', entityId: 'x', payload: { mime: 'image/png', bytesBase64: 'AAAA' } }), ctx(dir))).toMatchObject({ status: 'refused', reason: 'invalid' });
  });

  it('user.put creates and updates a user but never touches PIN fields', () => {
    const { db, dir } = newDb();
    const u = createUser(db, { name: 'Ali', roles: ['admin'] }, 'local');
    db.prepare("UPDATE users SET pin_hash = 'H', pin_fail_count = 2, edited_at = '2026-11-01T00:00:00.000Z' WHERE id = ?").run(u.id);
    const r = applyOp(db, op({ kind: 'user.put', entity: 'user', entityId: u.id, payload: { name: 'Ali bin Abu', roles: ['admin'], active: true, pin_hash: 'EVIL', pinHash: 'EVIL' } }), ctx(dir));
    expect(r.status).toBe('applied');
    expect(db.prepare('SELECT name, pin_hash, pin_fail_count, origin, rev FROM users WHERE id = ?').get(u.id)).toMatchObject({
      name: 'Ali bin Abu', pin_hash: 'H', pin_fail_count: 2, origin: 'app', rev: '2026-11-05T09:00:00.000Z|dev-a',
    });
    const fresh = applyOp(db, op({ kind: 'user.put', entity: 'user', entityId: 'new-user', payload: { name: 'Baru', roles: ['ajk'], active: true } }), ctx(dir));
    expect(fresh.status).toBe('applied');
    expect(db.prepare("SELECT name, pin_hash FROM users WHERE id = 'new-user'").get()).toEqual({ name: 'Baru', pin_hash: null });
  });

  it('user.put with active false revokes the user devices', () => {
    const { db, dir } = newDb();
    const u = createUser(db, { name: 'Ali', roles: ['admin'] }, 'local');
    createUser(db, { name: 'Siti', roles: ['admin'] }, 'local'); // the surau keeps another active admin
    db.prepare("UPDATE users SET edited_at = '2026-11-01T00:00:00.000Z' WHERE id = ?").run(u.id);
    db.prepare("INSERT INTO devices (id, user_id, name, platform, enrolled_at) VALUES ('d1', ?, 'T', 'android', '2026-11-01T00:00:00.000Z')").run(u.id);
    const o = op({ kind: 'user.put', entity: 'user', entityId: u.id, payload: { name: 'Ali', roles: ['admin'], active: false } });
    expect(applyOp(db, o, ctx(dir)).status).toBe('applied');
    expect(db.prepare('SELECT active FROM users WHERE id = ?').get(u.id)).toEqual({ active: 0 });
    expect(db.prepare("SELECT revoked_at FROM devices WHERE id = 'd1'").get()!.revoked_at).not.toBeNull();
    // the op id is on one change_log row only
    expect(db.prepare('SELECT COUNT(*) AS n FROM change_log WHERE op_id = ?').get(o.opId)).toEqual({ n: 1 });
  });

  it('device.revoke revokes once; a second revoke is applied with no second revoked_at', () => {
    const { db, dir } = newDb();
    const u = createUser(db, { name: 'Ali', roles: ['admin'] }, 'local');
    db.prepare("INSERT INTO devices (id, user_id, name, platform, enrolled_at) VALUES ('d1', ?, 'T', 'android', '2026-11-01T00:00:00.000Z')").run(u.id);
    const rev = (id: string, at: string) => op({ kind: 'device.revoke', entity: 'device', entityId: id, payload: null, editedAt: at });
    const first = applyOp(db, rev('d1', '2026-11-05T09:00:00.000Z'), ctx(dir));
    expect(first.status).toBe('applied');
    const revokedAt = db.prepare("SELECT revoked_at FROM devices WHERE id = 'd1'").get()!.revoked_at;
    expect(revokedAt).toBe(NOW.toISOString());
    const logs = db.prepare('SELECT COUNT(*) AS n FROM change_log').get();
    const second = op({ kind: 'device.revoke', entity: 'device', entityId: 'd1', payload: null, editedAt: '2026-11-05T09:30:00.000Z' });
    const r2 = applyOp(db, second, { ...ctx(dir), now: new Date('2026-11-05T10:30:00.000Z') });
    expect(r2.status).toBe('applied');
    expect(db.prepare("SELECT revoked_at FROM devices WHERE id = 'd1'").get()!.revoked_at).toBe(revokedAt);
    expect(db.prepare('SELECT COUNT(*) AS n FROM change_log').get()).toEqual(logs);
    expect(db.prepare('SELECT status FROM applied_ops WHERE op_id = ?').get(second.opId)).toEqual({ status: 'already_revoked' });
    expect(applyOp(db, rev('ghost', '2026-11-05T09:00:00.000Z'), ctx(dir)).reason).toBe('invalid');
  });

  it('a local edit still works as before, with the new columns filled', () => {
    const { db } = newDb();
    putItem(db, 'penceramah', { id: 'p1', name: 'A' }, 'local');
    const second = putItem(db, 'penceramah', { id: 'p1', name: 'B' }, 'user:u9');
    expect(second.created).toBe(false);
    expect(db.prepare("SELECT rev, origin FROM content_items WHERE id = 'p1'").get()).toMatchObject({ origin: 'local' });
  });
});

describe('applyFeedEntry', () => {
  function entry(over: Partial<FeedEntry>): FeedEntry {
    return {
      seq: 1, entity: 'content:penceramah', entityId: 'p1', rev: '2026-11-05T08:00:00.000Z|dev-a',
      editedAt: '2026-11-05T08:00:00.000Z', syncedAt: '2026-11-05T08:00:01.000Z', actor: 'user:u1',
      deviceId: 'dev-a', origin: 'app', opId: null, after: { id: 'p1', name: 'Dari awan' }, ...over,
    };
  }

  it('writes the entry rev, editedAt and origin as they are', () => {
    const { db, dir } = newDb();
    const r = applyFeedEntry(db, entry({}), ctx(dir, { origin: 'cloud' }));
    expect(r).toEqual({ status: 'applied', reason: null });
    expect(db.prepare("SELECT rev, edited_at, origin, updated_by FROM content_items WHERE id = 'p1'").get()).toEqual({
      rev: '2026-11-05T08:00:00.000Z|dev-a', edited_at: '2026-11-05T08:00:00.000Z', origin: 'app', updated_by: 'user:u1',
    });
    // redelivery of the same revision is a no-op
    expect(applyFeedEntry(db, entry({}), ctx(dir)).status).toBe('superseded');
  });

  it('a local entry from the other side takes the replication origin', () => {
    const { db, dir } = newDb();
    applyFeedEntry(db, entry({ origin: 'local', deviceId: null, rev: '2026-11-05T08:00:00.000Z|local' }), ctx(dir, { origin: 'box:b1' }));
    expect(db.prepare("SELECT origin FROM content_items WHERE id = 'p1'").get()).toEqual({ origin: 'box:b1' });
  });

  it('an entry opId applied first makes a later applyOp with that opId a duplicate, and the reverse', () => {
    const { db, dir } = newDb();
    const X = 'X'.repeat(26);
    expect(applyFeedEntry(db, entry({ opId: X }), ctx(dir)).status).toBe('applied');
    const o = op({ opId: X, editedAt: '2026-11-05T09:59:00.000Z', payload: { name: 'Lagi' } });
    expect(applyOp(db, o, ctx(dir))).toMatchObject({ status: 'duplicate', rev: '2026-11-05T08:00:00.000Z|dev-a' });
    expect(getItem(db, 'penceramah', 'p1')).toMatchObject({ name: 'Dari awan' });

    const Y = 'Y'.repeat(26);
    const o2 = op({ opId: Y, entityId: 'p2', payload: { name: 'P2' } });
    expect(applyOp(db, o2, ctx(dir)).status).toBe('applied');
    const back = applyFeedEntry(db, entry({ opId: Y, entityId: 'p2', rev: '2026-11-05T09:00:00.000Z|dev-a', editedAt: '2026-11-05T09:00:00.000Z', after: { id: 'p2', name: 'P2' } }), ctx(dir));
    expect(back.status).toBe('duplicate');
    expect(db.prepare('SELECT COUNT(*) AS n FROM change_log WHERE op_id = ?').get(Y)).toEqual({ n: 1 });
  });

  it('applies the merge rule: an older entry loses, a tombstone entry deletes', () => {
    const { db, dir } = newDb();
    applyOp(db, op({ editedAt: '2026-11-05T09:00:00.000Z', payload: { name: 'Baru' } }), ctx(dir));
    expect(applyFeedEntry(db, entry({}), ctx(dir)).status).toBe('superseded');
    expect(getItem(db, 'penceramah', 'p1')).toMatchObject({ name: 'Baru' });
    const del = applyFeedEntry(db, entry({ after: null, rev: '2026-11-05T09:30:00.000Z|dev-a', editedAt: '2026-11-05T09:30:00.000Z' }), ctx(dir));
    expect(del.status).toBe('applied');
    expect(getItem(db, 'penceramah', 'p1')).toBeNull();
  });

  it('does not check references: an item may arrive before its asset', () => {
    const { db, dir } = newDb();
    const r = applyFeedEntry(db, entry({ after: { id: 'p1', name: 'Foto', photoAssetId: 'a'.repeat(64) } }), ctx(dir));
    expect(r.status).toBe('applied');
  });

  it('replicates settings and refuses appLock', () => {
    const { db, dir } = newDb();
    const s = applyFeedEntry(db, entry({ entity: 'settings', entityId: 'zone', after: { zone: 'SGR02' } }), ctx(dir));
    expect(s.status).toBe('applied');
    expect(getSettings(db).zone.zone).toBe('SGR02');
    expect(applyFeedEntry(db, entry({ entity: 'settings', entityId: 'appLock', after: { enabled: true } }), ctx(dir))).toEqual({ status: 'refused', reason: 'live_only' });
  });

  it('the feed of one database replays into another and they converge', () => {
    const a = newDb();
    const b = newDb();
    putItem(a.db, 'penceramah', { id: 'p1', name: 'A' }, 'local');
    applyOp(a.db, op({ entityId: 'p2', payload: { name: 'Dua' } }), ctx(a.dir));
    for (const e of readFeed(a.db, 0, 500, ALL).entries) applyFeedEntry(b.db, e, ctx(b.dir, { origin: 'box:a' }));
    expect(getItem(b.db, 'penceramah', 'p1')).toMatchObject({ name: 'A' });
    expect(getItem(b.db, 'penceramah', 'p2')).toMatchObject({ name: 'Dua' });
    // replaying the whole feed again changes nothing
    const before = b.db.prepare('SELECT COUNT(*) AS n FROM change_log').get();
    for (const e of readFeed(a.db, 0, 500, ALL).entries) applyFeedEntry(b.db, e, ctx(b.dir, { origin: 'box:a' }));
    expect(b.db.prepare('SELECT COUNT(*) AS n FROM change_log').get()).toEqual(before);
  });
});

// Type check only: SyncOp stays assignable from VerifiedOp.
const _typeCheck: SyncOp = op({});
void _typeCheck;
