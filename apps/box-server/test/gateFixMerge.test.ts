import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeedEntry } from '@surau/core';
import { createUser } from '../src/auth/users.ts';
import { getItem } from '../src/content/store.ts';
import { openDb } from '../src/db.ts';
import { runMigrations } from '../src/migrations/index.ts';
import { getSettings, putFeature } from '../src/settingsStore.ts';
import { applyFeedEntry, applyOp } from '../src/sync/apply.ts';
import type { ApplyCtx, VerifiedOp } from '../src/sync/apply.ts';
import { readFeed, snapshot } from '../src/sync/feed.ts';
import { verifySiteEntry } from '../src/sync/verify.ts';

const openDbs: DatabaseSync[] = [];
const tempDirs: string[] = [];

function newDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'surau-gatefix-'));
  tempDirs.push(dir);
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
const T1 = '2026-11-05T09:00:00.000Z';
const T2 = '2026-11-05T09:10:00.000Z';
const T3 = '2026-11-05T09:20:00.000Z';

let counter = 0;
function op(over: Partial<VerifiedOp>): VerifiedOp {
  counter += 1;
  return {
    v: 1, opId: `GF${String(counter).padStart(24, '0')}`, surauId: 'sdm', boxId: 'box1', deviceId: 'dev-a', userId: 'u1',
    kind: 'content.put', entity: 'content:penceramah', entityId: 'p1', baseRev: null, editedAt: T1,
    payload: { name: 'Ustaz A' }, sig: 'x', userName: 'Ali', ...over,
  };
}
const ctx = (dir: string, over: Partial<ApplyCtx> = {}): ApplyCtx => ({ now: NOW, origin: 'app', actor: 'user:u1', dataDir: dir, ...over });
const put = (editedAt: string, name: string, deviceId = 'dev-a'): VerifiedOp => op({ editedAt, deviceId, payload: { name } });
const del = (editedAt: string, deviceId = 'dev-a'): VerifiedOp => op({ kind: 'content.delete', payload: null, editedAt, deviceId });

function entry(over: Partial<FeedEntry>): FeedEntry {
  return {
    seq: 1, entity: 'content:penceramah', entityId: 'p1', rev: `${T1}|dev-a`, editedAt: T1, syncedAt: T1, actor: 'user:u1',
    deviceId: 'dev-a', origin: 'app', opId: null, after: { id: 'p1', name: 'Dari awan' }, ...over,
  };
}

const row = (db: DatabaseSync) =>
  db.prepare("SELECT deleted_at, edited_at, rev FROM content_items WHERE kind = 'penceramah' AND id = 'p1'").get();

describe('M1/Q4: put and delete compete by edit time, in either order', () => {
  const editsList: [string, VerifiedOp][] = [
    ['put T1', put(T1, 'A')], ['put T3', put(T3, 'C')], ['delete T2', del(T2)], ['delete T1', del(T1)],
    ['delete T3 other device', del(T3, 'dev-z')], ['put T2', put(T2, 'B', 'dev-m')],
  ];

  it('any two edits end in the same row in both orders (ops)', () => {
    for (const [na, a] of editsList) {
      for (const [nb, b] of editsList) {
        const x = newDb();
        const y = newDb();
        applyOp(x.db, { ...a, opId: 'X'.repeat(26) }, ctx(x.dir));
        applyOp(x.db, { ...b, opId: 'Y'.repeat(26) }, ctx(x.dir));
        applyOp(y.db, { ...b, opId: 'Y'.repeat(26) }, ctx(y.dir));
        applyOp(y.db, { ...a, opId: 'X'.repeat(26) }, ctx(y.dir));
        expect(row(x.db), `${na} then ${nb}`).toEqual(row(y.db));
        expect(getItem(x.db, 'penceramah', 'p1'), `${na} then ${nb}`).toEqual(getItem(y.db, 'penceramah', 'p1'));
      }
    }
  });

  it('a delete older than the live row loses and is reported as superseded', () => {
    const { db, dir } = newDb();
    applyOp(db, put(T3, 'Baru'), ctx(dir));
    const r = applyOp(db, del(T1), ctx(dir));
    expect(r.status).toBe('superseded');
    expect(getItem(db, 'penceramah', 'p1')).toMatchObject({ name: 'Baru' });
  });

  it('a newer delete wins over a put; a put newer than the delete undeletes', () => {
    const { db, dir } = newDb();
    applyOp(db, put(T1, 'A'), ctx(dir));
    expect(applyOp(db, del(T2), ctx(dir)).status).toBe('applied');
    expect(getItem(db, 'penceramah', 'p1')).toBeNull();
    expect(applyOp(db, put(T3, 'C'), ctx(dir)).status).toBe('applied');
    expect(getItem(db, 'penceramah', 'p1')).toMatchObject({ name: 'C' });
  });

  it('a newer delete moves an older tombstone; an older put then stays out, as in the other order', () => {
    const a = newDb();
    applyOp(a.db, del(T1), ctx(a.dir));
    applyOp(a.db, del(T3), ctx(a.dir));
    expect(applyOp(a.db, put(T2, 'B'), ctx(a.dir)).status).toBe('superseded');
    const b = newDb();
    applyOp(b.db, del(T1), ctx(b.dir));
    applyOp(b.db, put(T2, 'B'), ctx(b.dir));
    applyOp(b.db, del(T3), ctx(b.dir));
    expect(row(a.db)).toEqual(row(b.db));
    expect(getItem(b.db, 'penceramah', 'p1')).toBeNull();
  });

  it('feed entries agree with ops: a delete entry older than the live row loses', () => {
    const { db, dir } = newDb();
    applyOp(db, put(T3, 'Baru'), ctx(dir));
    const r = applyFeedEntry(db, entry({ after: null, editedAt: T1, rev: `${T1}|dev-a` }), ctx(dir));
    expect(r.status).toBe('superseded');
    expect(getItem(db, 'penceramah', 'p1')).toMatchObject({ name: 'Baru' });
  });
});

describe('Q10: a delete of an entity never seen still leaves a tombstone', () => {
  it('device op: delete first, then an older put does not resurrect', () => {
    const { db, dir } = newDb();
    expect(applyOp(db, del(T2), ctx(dir)).status).toBe('applied');
    expect(db.prepare("SELECT deleted_at, rev, edited_at FROM content_items WHERE id = 'p1'").get()).toEqual({ deleted_at: T2, rev: `${T2}|dev-a`, edited_at: T2 });
    expect(applyOp(db, put(T1, 'Lama'), ctx(dir)).status).toBe('superseded');
    expect(getItem(db, 'penceramah', 'p1')).toBeNull();
  });

  it('device op: put first, then the delete (the other order) ends the same', () => {
    const { db, dir } = newDb();
    applyOp(db, put(T1, 'Lama'), ctx(dir));
    applyOp(db, del(T2), ctx(dir));
    expect(getItem(db, 'penceramah', 'p1')).toBeNull();
    expect(row(db)).toMatchObject({ deleted_at: T2 });
  });

  it('feed entry: tombstone first, then an older put stays out; the tombstone is in the feed and the snapshot', () => {
    const { db, dir } = newDb();
    expect(applyFeedEntry(db, entry({ after: null, editedAt: T2, rev: `${T2}|dev-a` }), ctx(dir)).status).toBe('applied');
    expect(applyFeedEntry(db, entry({ editedAt: T1, rev: `${T1}|dev-a` }), ctx(dir)).status).toBe('superseded');
    expect(getItem(db, 'penceramah', 'p1')).toBeNull();
    expect(readFeed(db, 0, 500, ALL).entries.some((e) => e.entityId === 'p1' && e.after === null)).toBe(true);
    expect(snapshot(db, ALL, { boxId: 'box1', now: NOW }).content.penceramah).toContainEqual({ id: 'p1', deletedAt: T2 });
  });
});

describe('Q2: a replay answers what the first answer was', () => {
  it('a superseded op replayed is superseded again with the same winner', () => {
    const { db, dir } = newDb();
    const user = createUser(db, { name: 'Siti', roles: ['admin'] }, 'local');
    applyOp(db, put(T3, 'Baru', 'dev-b'), ctx(dir, { actor: `user:${user.id}` }));
    const lost = put(T1, 'Lama');
    const first = applyOp(db, lost, ctx(dir));
    expect(first.status).toBe('superseded');
    const again = applyOp(db, lost, ctx(dir));
    expect(again).toEqual(first);
    expect(again.winner).toMatchObject({ userName: 'Siti', editedAt: T3 });
  });

  it('an applied op replayed is still a duplicate', () => {
    const { db, dir } = newDb();
    const o = put(T1, 'A');
    applyOp(db, o, ctx(dir));
    expect(applyOp(db, o, ctx(dir)).status).toBe('duplicate');
    expect(db.prepare('SELECT result_status FROM applied_ops WHERE op_id = ?').get(o.opId)).toEqual({ result_status: 'applied' });
  });

  it('a superseded settings op replayed is superseded again', () => {
    const { db, dir } = newDb();
    applyOp(db, op({ kind: 'settings.put', entity: 'settings', entityId: 'cloudSync', editedAt: T3, deviceId: 'dev-b', payload: { dirtyCheckSeconds: 300 } }), ctx(dir));
    const lost = op({ kind: 'settings.put', entity: 'settings', entityId: 'cloudSync', editedAt: T1, payload: { dirtyCheckSeconds: 100 } });
    expect(applyOp(db, lost, ctx(dir)).status).toBe('superseded');
    expect(applyOp(db, lost, ctx(dir)).status).toBe('superseded');
    expect(getSettings(db).cloudSync.dirtyCheckSeconds).toBe(300);
  });
});

describe('Q9/S3: feed times are held to the device-op rule', () => {
  it('applyFeedEntry refuses a time that is not an ISO instant', () => {
    const { db, dir } = newDb();
    for (const bad of ['zzzz', '9999', 'Nov 5 2026', '2026-11-05']) {
      expect(applyFeedEntry(db, entry({ editedAt: bad, rev: `${bad}|dev-a` }), ctx(dir))).toEqual({ status: 'refused', reason: 'invalid' });
    }
    expect(getItem(db, 'penceramah', 'p1')).toBeNull();
  });

  it('a "zzzz" entry can no longer pin a row against every real edit', () => {
    const { db, dir } = newDb();
    applyFeedEntry(db, entry({ editedAt: 'zzzz', rev: 'zzzz|dev-a' }), ctx(dir));
    expect(applyOp(db, put(T1, 'Sebenar'), ctx(dir)).status).toBe('applied');
  });

  it('a year-2036 entry is clamped to now exactly as a device op is, and its rev follows', () => {
    const { db, dir } = newDb();
    const far = '2036-01-01T00:00:00.000Z';
    expect(applyFeedEntry(db, entry({ editedAt: far, rev: `${far}|dev-a` }), ctx(dir)).status).toBe('applied');
    expect(db.prepare("SELECT edited_at, rev FROM content_items WHERE id = 'p1'").get()).toEqual({
      edited_at: NOW.toISOString(), rev: `${NOW.toISOString()}|dev-a`,
    });
    // a real edit after now still beats it
    expect(applyOp(db, put('2026-11-05T10:03:00.000Z', 'Lagi baru'), ctx(dir)).status).toBe('applied');
  });

  it('verifySiteEntry refuses a non-ISO editedAt and bad stamps', () => {
    const site = { boxId: 'box1', surauId: 'sdm' };
    const good = { ...entry({}), origin: 'box:box1' };
    expect(verifySiteEntry(site, {}, good).ok).toBe(true);
    expect(verifySiteEntry(site, {}, { ...good, editedAt: 'zzzz' })).toEqual({ ok: false, detail: 'bad_time' });
    const settings = { ...good, entity: 'settings', entityId: 'cloudSync', after: { dirtyCheckSeconds: 100 } };
    expect(verifySiteEntry(site, {}, { ...settings, stamps: { dirtyCheckSeconds: { editedAt: T1, deviceId: 'dev-a' } } }).ok).toBe(true);
    expect(verifySiteEntry(site, {}, { ...settings, stamps: { dirtyCheckSeconds: { editedAt: 'zzzz', deviceId: 'dev-a' } } })).toEqual({ ok: false, detail: 'bad_stamps' });
    expect(verifySiteEntry(site, {}, { ...good, stamps: {} })).toEqual({ ok: false, detail: 'bad_stamps' });
  });

  it('applyFeedEntry refuses bad stamps', () => {
    const { db, dir } = newDb();
    const e = entry({ entity: 'settings', entityId: 'cloudSync', after: { dirtyCheckSeconds: 100 }, stamps: { dirtyCheckSeconds: { editedAt: 'zzzz', deviceId: 'dev-a' } } });
    expect(applyFeedEntry(db, e, ctx(dir))).toEqual({ status: 'refused', reason: 'invalid' });
  });
});

describe('Q5: settings merge per field', () => {
  const sop = (editedAt: string, payload: unknown, deviceId = 'dev-a'): VerifiedOp =>
    op({ kind: 'settings.put', entity: 'settings', entityId: 'cloudSync', editedAt, deviceId, payload });

  it('edits to different fields both survive, in either order', () => {
    for (const order of [0, 1]) {
      const { db, dir } = newDb();
      const a = sop(T1, { dirtyCheckSeconds: 100 });
      const b = sop(T2, { cloudUrl: 'https://awan.example.my' }, 'dev-b');
      for (const o of order === 0 ? [a, b] : [b, a]) expect(applyOp(db, o, ctx(dir)).status).toBe('applied');
      expect(getSettings(db).cloudSync).toMatchObject({ dirtyCheckSeconds: 100, cloudUrl: 'https://awan.example.my' });
    }
  });

  it('an OLDER edit to a different field still lands (whole-row last-writer-wins would have refused it)', () => {
    const { db, dir } = newDb();
    applyOp(db, sop(T3, { cloudUrl: 'https://baru.example.my' }), ctx(dir));
    expect(applyOp(db, sop(T1, { dirtyCheckSeconds: 200 }, 'dev-b'), ctx(dir)).status).toBe('applied');
    expect(getSettings(db).cloudSync).toMatchObject({ dirtyCheckSeconds: 200, cloudUrl: 'https://baru.example.my' });
  });

  it('edits to the same field: the newer wins in either order; the loser is superseded with a winner', () => {
    for (const order of [0, 1]) {
      const { db, dir } = newDb();
      const older = sop(T1, { dirtyCheckSeconds: 100 });
      const newer = sop(T2, { dirtyCheckSeconds: 500 }, 'dev-b');
      const results = (order === 0 ? [older, newer] : [newer, older]).map((o) => applyOp(db, o, ctx(dir)));
      expect(getSettings(db).cloudSync.dirtyCheckSeconds).toBe(500);
      const lost = results[order === 0 ? 0 : 1]!;
      if (order === 1) {
        expect(lost.status).toBe('superseded');
        expect(lost.winner).not.toBeNull();
      }
    }
  });

  it('same field, same instant: the greater device id wins in either order', () => {
    for (const order of [0, 1]) {
      const { db, dir } = newDb();
      const a = sop(T1, { dirtyCheckSeconds: 100 }, 'dev-a');
      const z = sop(T1, { dirtyCheckSeconds: 900 }, 'dev-z');
      for (const o of order === 0 ? [a, z] : [z, a]) applyOp(db, o, ctx(dir));
      expect(getSettings(db).cloudSync.dirtyCheckSeconds).toBe(900);
    }
  });

  it('a mixed patch takes only the fields that are newer', () => {
    const { db, dir } = newDb();
    applyOp(db, sop(T3, { dirtyCheckSeconds: 700 }, 'dev-b'), ctx(dir));
    const r = applyOp(db, sop(T2, { dirtyCheckSeconds: 100, cloudUrl: 'https://x.example.my' }), ctx(dir));
    expect(r.status).toBe('applied');
    expect(getSettings(db).cloudSync).toMatchObject({ dirtyCheckSeconds: 700, cloudUrl: 'https://x.example.my' });
  });

  it('a local write (the settings page) always lands and then beats the stamps it replaced', () => {
    const { db, dir } = newDb();
    applyOp(db, sop('2026-11-05T10:04:00.000Z', { dirtyCheckSeconds: 100 }, 'dev-b'), ctx(dir));
    putFeature(db, 'cloudSync', { dirtyCheckSeconds: 250 }, 'user:u1');
    expect(getSettings(db).cloudSync.dirtyCheckSeconds).toBe(250);
    const feed = readFeed(db, 0, 500, ALL).entries.filter((e) => e.entity === 'settings');
    const last = feed[feed.length - 1]!;
    expect(Date.parse(last.stamps!.dirtyCheckSeconds!.editedAt)).toBeGreaterThan(Date.parse('2026-11-05T10:04:00.000Z'));
  });

  it('feed entries carry per-field stamps and two sides converge field by field', () => {
    const box = newDb();
    const cloud = newDb();
    applyOp(box.db, sop(T1, { dirtyCheckSeconds: 100 }), ctx(box.dir));
    applyOp(cloud.db, sop(T2, { cloudUrl: 'https://awan.example.my' }, 'dev-b'), ctx(cloud.dir, { origin: 'cloud' }));
    const fromBox = readFeed(box.db, 0, 500, ALL).entries.filter((e) => e.entity === 'settings');
    const fromCloud = readFeed(cloud.db, 0, 500, ALL).entries.filter((e) => e.entity === 'settings');
    expect(fromBox[0]!.stamps).toBeDefined();
    for (const e of fromBox) applyFeedEntry(cloud.db, e, ctx(cloud.dir, { origin: 'cloud' }));
    for (const e of fromCloud) applyFeedEntry(box.db, e, ctx(box.dir, { origin: 'cloud' }));
    for (const s of [box.db, cloud.db]) {
      expect(getSettings(s).cloudSync).toMatchObject({ dirtyCheckSeconds: 100, cloudUrl: 'https://awan.example.my' });
    }
  });

  it('a feed entry with older stamps for a field is superseded when none of its fields is newer', () => {
    const { db, dir } = newDb();
    applyOp(db, sop(T3, { dirtyCheckSeconds: 700 }, 'dev-b'), ctx(dir));
    const e = entry({
      entity: 'settings', entityId: 'cloudSync', after: { dirtyCheckSeconds: 100 }, editedAt: T1, rev: `${T1}|dev-a`,
      stamps: { dirtyCheckSeconds: { editedAt: T1, deviceId: 'dev-a' } },
    });
    expect(applyFeedEntry(db, e, ctx(dir)).status).toBe('superseded');
    expect(getSettings(db).cloudSync.dirtyCheckSeconds).toBe(700);
  });

  it('migration 010 stamps existing settings rows from the row edit stamp', () => {
    const { db } = newDb();
    // newDb is fully migrated: rebuild the pre-010 state for one row.
    db.prepare("INSERT INTO settings (feature, json, updated_at, updated_by, rev, edited_at, origin) VALUES ('zone', '{\"zone\":\"SGR01\"}', ?, 'local', ?, ?, 'local')").run(T1, `${T1}|dev-a`, T1);
    db.prepare('UPDATE settings SET field_stamps = NULL').run();
    db.prepare("DELETE FROM schema_migrations WHERE name = '010-gate-fixes'").run();
    for (const stmt of ['applied_ops DROP COLUMN result_status', 'applied_ops DROP COLUMN winner_json', 'settings DROP COLUMN field_stamps', 'change_log DROP COLUMN stamps_json']) {
      db.exec(`ALTER TABLE ${stmt}`);
    }
    expect(runMigrations(db)).toEqual(['010-gate-fixes']);
    expect(JSON.parse(String(db.prepare("SELECT field_stamps FROM settings WHERE feature = 'zone'").get()!.field_stamps))).toEqual({
      zone: { editedAt: T1, deviceId: 'dev-a' },
    });
  });
});

describe('S4: the last active admin cannot be removed by a synced edit', () => {
  const userOp = (id: string, payload: unknown, editedAt = T3): VerifiedOp => op({ kind: 'user.put', entity: 'user', entityId: id, editedAt, payload });

  it('a device op that demotes or deactivates the only active admin is refused last_admin and changes nothing', () => {
    const { db, dir } = newDb();
    const u = createUser(db, { name: 'Ali', roles: ['admin'] }, 'local');
    db.prepare("UPDATE users SET edited_at = ? WHERE id = ?").run(T1, u.id);
    expect(applyOp(db, userOp(u.id, { name: 'Ali', roles: ['ajk'], active: true }), ctx(dir))).toMatchObject({ status: 'refused', reason: 'last_admin' });
    expect(applyOp(db, userOp(u.id, { name: 'Ali', roles: ['admin'], active: false }), ctx(dir))).toMatchObject({ status: 'refused', reason: 'last_admin' });
    expect(db.prepare('SELECT roles_json, active FROM users WHERE id = ?').get(u.id)).toEqual({ roles_json: '["admin"]', active: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM auth_log WHERE event = 'sync_refused' AND detail = 'last_admin'").get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM applied_ops').get()).toEqual({ n: 0 });
  });

  it('it is allowed while another active admin remains', () => {
    const { db, dir } = newDb();
    const u = createUser(db, { name: 'Ali', roles: ['admin'] }, 'local');
    createUser(db, { name: 'Siti', roles: ['admin'] }, 'local');
    db.prepare("UPDATE users SET edited_at = ?").run(T1);
    expect(applyOp(db, userOp(u.id, { name: 'Ali', roles: ['ajk'], active: true }), ctx(dir)).status).toBe('applied');
  });

  it('a replicated user entry is held to the same guard, refused and recorded', () => {
    const { db, dir } = newDb();
    const u = createUser(db, { name: 'Ali', roles: ['admin'] }, 'local');
    db.prepare("UPDATE users SET edited_at = ?").run(T1);
    const e = entry({ entity: 'user', entityId: u.id, after: { name: 'Ali', roles: ['admin'], active: false }, editedAt: T3, rev: `${T3}|cloud`, deviceId: null, origin: 'cloud', actor: 'cloud' });
    expect(applyFeedEntry(db, e, ctx(dir, { origin: 'cloud' }))).toEqual({ status: 'refused', reason: 'last_admin' });
    expect(db.prepare('SELECT active FROM users WHERE id = ?').get(u.id)).toEqual({ active: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM auth_log WHERE event = 'sync_refused' AND detail = 'last_admin'").get()).toEqual({ n: 1 });
  });

  it('a non-admin or an inactive admin may be changed freely', () => {
    const { db, dir } = newDb();
    createUser(db, { name: 'Ali', roles: ['admin'] }, 'local');
    const n = createUser(db, { name: 'Ahmad', roles: ['ajk'] }, 'local');
    db.prepare("UPDATE users SET edited_at = ?").run(T1);
    expect(applyOp(db, userOp(n.id, { name: 'Ahmad', roles: ['ajk'], active: false }), ctx(dir)).status).toBe('applied');
  });
});

describe('Q6: the snapshot', () => {
  it('carries real edit stamps for settings and users, and tombstones for 180 days', () => {
    const { db, dir } = newDb();
    const u = createUser(db, { name: 'Ali', roles: ['admin'] }, 'local');
    db.prepare('UPDATE users SET edited_at = ?, rev = ? WHERE id = ?').run(T1, `${T1}|dev-a`, u.id);
    applyOp(db, op({ kind: 'settings.put', entity: 'settings', entityId: 'cloudSync', editedAt: T2, payload: { dirtyCheckSeconds: 100 } }), ctx(dir));
    applyOp(db, del(T1), ctx(dir));
    db.prepare("UPDATE content_items SET deleted_at = '2026-05-20T00:00:00.000Z' WHERE id = 'p1'").run();
    const snap = snapshot(db, ALL, { boxId: 'box1', now: NOW });
    expect(snap.settingsMeta!.cloudSync).toEqual({
      editedAt: T2, rev: `${T2}|dev-a`, stamps: { dirtyCheckSeconds: { editedAt: T2, deviceId: 'dev-a' } },
    });
    expect(snap.users![0]).toMatchObject({ id: u.id, editedAt: T1, rev: `${T1}|dev-a` });
    expect(snap.content.penceramah).toContainEqual({ id: 'p1', deletedAt: '2026-05-20T00:00:00.000Z' });
  });
});
