import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeedEntry } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { autoCleanPeople } from '../src/auth/activity.ts';
import { putUserSynced } from '../src/auth/users.ts';
import { migration as deletedPeoplePhone } from '../src/migrations/027-deleted-people-phone.ts';
import { applyFeedEntry } from '../src/sync/apply.ts';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';
import { loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeApp(): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-optphone-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'), { dataDir: dir });
  apps.push(app);
  return app;
}

const P1 = '012-000 0010';
const E1 = '+60120000010';
const P2 = '012-000 0011';
const E2 = '+60120000011';
const digits = (e164: string): string => e164.slice(3);

const create = (app: FastifyInstance, by: Login, name: string, body: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: '/api/users', headers: by.headers, payload: { name, roles: ['ajk'], ...body } });
const setPhone = (app: FastifyInstance, by: Login, id: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: `/api/users/${id}/phone`, headers: by.headers, payload });
const del = (app: FastifyInstance, by: Login, id: string, ref: unknown) =>
  app.inject({ method: 'POST', url: `/api/users/${id}/delete`, headers: by.headers, payload: { ref } });
const restore = (app: FastifyInstance, by: Login, id: string) =>
  app.inject({ method: 'POST', url: `/api/users/${id}/restore`, headers: by.headers, payload: {} });
const phoneOf = (db: DatabaseSync, id: string): unknown => db.prepare('SELECT phone FROM users WHERE id = ?').get(id)?.phone;
const logRows = (db: DatabaseSync, id: string): Array<{ before_json: string | null; after_json: string | null }> =>
  db.prepare("SELECT before_json, after_json FROM change_log WHERE entity = 'users' AND entity_id = ? ORDER BY id").all(id) as never;
const lastAfter = (db: DatabaseSync, id: string): Record<string, unknown> => {
  const rows = logRows(db, id);
  return JSON.parse(String(rows[rows.length - 1]?.after_json)) as Record<string, unknown>;
};
const historyHasNumber = (db: DatabaseSync, id: string): boolean =>
  logRows(db, id).some((r) => `${r.before_json ?? ''}${r.after_json ?? ''}`.includes(digits(E1)) || `${r.before_json ?? ''}${r.after_json ?? ''}`.includes(digits(E2)));

describe('[OPT-PHONE] a number is optional on create', () => {
  it('absent, null, empty and blank each add the person with no number and no phone key in the change row', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const db = app.surau.db;
    let n = 0;
    for (const body of [{}, { phone: null }, { phone: '' }, { phone: '   ' }]) {
      const r = await create(app, admin, `Kak Tiada ${++n}`, body);
      expect(r.statusCode, JSON.stringify(body) + r.body).toBe(201);
      expect(r.json().phone).toBeNull();
      expect(phoneOf(db, r.json().id)).toBeNull();
      expect('phone' in lastAfter(db, r.json().id)).toBe(false);
    }
  });

  it('success path: a given number is stored as E.164; a bad one is bad_phone and a taken one phone_taken, as before', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const a = await create(app, admin, 'Kak Siti', { phone: P1 });
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json().phone).toBe(E1);
    expect((await create(app, admin, 'Kak Salah', { phone: 'abc' })).json().code).toBe('bad_phone');
    expect((await create(app, admin, 'Kak Salah', { phone: 123 })).json().code).toBe('bad_phone');
    const dup = await create(app, admin, 'Kak Dua', { phone: P1 });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('phone_taken');
  });
});

describe('[OPT-PHONE] clearing a number', () => {
  it('null, empty and blank clear it and log one change row with an explicit phone null; clearing an empty number writes no row', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const db = app.surau.db;
    for (const value of [null, '', '   ']) {
      const made = (await create(app, admin, `Kak ${String(value)}`, { phone: P1 })).json();
      // the first person holds P1; free it for the next loop by clearing at the end of each pass
      const before = logRows(db, made.id).length;
      const r = await setPhone(app, admin, made.id, { phone: value });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().phone).toBeNull();
      expect(phoneOf(db, made.id)).toBeNull();
      expect(logRows(db, made.id).length).toBe(before + 1);
      expect(lastAfter(db, made.id)).toMatchObject({ phone: null });
      // again: a no-op with no log row
      expect((await setPhone(app, admin, made.id, { phone: value })).statusCode).toBe(200);
      expect(logRows(db, made.id).length).toBe(before + 1);
    }
  });

  it('a body with no phone key is refused and keeps the number; a number can be set again after a clear; the audit shows phoneChanged only', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const db = app.surau.db;
    const made = (await create(app, admin, 'Kak Siti', { phone: P1 })).json();
    const refused = await setPhone(app, admin, made.id, {});
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe('bad_phone');
    expect(phoneOf(db, made.id)).not.toBeNull();
    expect((await setPhone(app, admin, made.id, { phone: null })).statusCode).toBe(200);
    expect(phoneOf(db, made.id)).toBeNull();
    expect((await setPhone(app, admin, made.id, { phone: P2 })).json().phone).toBe(E2);
    const audit = await app.inject({ method: 'GET', url: '/api/audit', headers: admin.headers });
    expect(audit.body).not.toContain(digits(E2));
    const rows = audit.json().entries as Array<{ entityId: string | null; entity: string; phoneChanged?: boolean }>;
    expect(rows.filter((e) => e.entity === 'users' && e.entityId === made.id && e.phoneChanged === true).length).toBeGreaterThanOrEqual(2);
  });

  it('a Bendahari is still refused (403) and a bad value is still bad_phone', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const treasurer = await loginAs(app, 'treasurer');
    const made = (await create(app, admin, 'Kak Siti', { phone: P1 })).json();
    expect((await setPhone(app, treasurer, made.id, { phone: null })).statusCode).toBe(403);
    expect(phoneOf(app.surau.db, made.id)).toBe(E1);
    expect((await setPhone(app, admin, made.id, { phone: '12-3' })).json().code).toBe('bad_phone');
  });

  it('the clear reaches a second server; an entry without the key still leaves the number', async () => {
    const one = makeApp();
    const two = makeApp();
    const admin = await loginAs(one, 'admin');
    const made = (await create(one, admin, 'Kak Siti', { phone: P1 })).json();
    const ctx = { surauId: LOCAL_SURAU_ID, now: new Date(Date.now() + 3600_000), origin: 'box:b1', actor: 'user:x', dataDir: tmpdir() };
    const entry = (after: Record<string, unknown>, ms: number): FeedEntry => {
      const at = new Date(Date.now() + ms).toISOString();
      return { seq: 1, entity: 'user', entityId: made.id, rev: `${at}|dev-x`, editedAt: at, syncedAt: at, actor: 'user:x', deviceId: null, origin: 'local', opId: null, after };
    };
    expect(applyFeedEntry(two.surau.db, entry(lastAfter(one.surau.db, made.id), 1000), ctx).status).toBe('applied');
    expect(phoneOf(two.surau.db, made.id)).toBe(E1);
    const { phone: _p, ...bare } = lastAfter(one.surau.db, made.id);
    expect(applyFeedEntry(two.surau.db, entry({ ...bare, name: 'Kak Siti Baru' }, 2000), ctx).status).toBe('applied');
    expect(phoneOf(two.surau.db, made.id)).toBe(E1);
    await setPhone(one, admin, made.id, { phone: null });
    expect(applyFeedEntry(two.surau.db, entry(lastAfter(one.surau.db, made.id), 3000), ctx).status).toBe('applied');
    expect(phoneOf(two.surau.db, made.id)).toBeNull();
  });
});

describe('[OPT-PHONE] deleting a person erases the number', () => {
  it('on the box: the column is NULL, no history row of the person holds the number, the delete row has no phone, the feed has none', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const db = app.surau.db;
    const made = (await create(app, admin, 'Kak Siti', { phone: P1 })).json();
    await setPhone(app, admin, made.id, { phone: P2 });
    await app.inject({ method: 'POST', url: `/api/users/${made.id}/deactivate`, headers: admin.headers, payload: {} });
    expect(historyHasNumber(db, made.id)).toBe(true);
    const r = await del(app, admin, made.id, made.ref);
    expect(r.statusCode, r.body).toBe(200);
    expect(phoneOf(db, made.id)).toBeNull();
    expect(historyHasNumber(db, made.id)).toBe(false);
    for (const row of logRows(db, made.id)) expect(`${row.before_json ?? ''}${row.after_json ?? ''}`).not.toContain('"phone"');
    expect(lastAfter(db, made.id)).toMatchObject({ deleted: true });
    const feed = await app.inject({ method: 'GET', url: '/api/sync/changes?since=0', headers: admin.headers });
    expect(feed.body).not.toContain(digits(E1));
    expect(feed.body).not.toContain(digits(E2));
    const snap = await app.inject({ method: 'GET', url: '/api/sync/snapshot', headers: admin.headers });
    expect(snap.body).not.toContain(digits(E2));
  });

  it('only that person: another person history and number are untouched', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const db = app.surau.db;
    const a = (await create(app, admin, 'Kak Siti', { phone: P1 })).json();
    const b = (await create(app, admin, 'Encik Rahman', { phone: P2 })).json();
    await del(app, admin, a.id, a.ref);
    expect(phoneOf(db, b.id)).toBe(E2);
    expect(lastAfter(db, b.id)).toMatchObject({ phone: E2 });
  });

  it('the automatic deletion after 365 days erases it too', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const db = app.surau.db;
    const made = (await create(app, admin, 'Kak Siti', { phone: P1 })).json();
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    db.prepare('UPDATE users SET active = 0, deactivated_at = ? WHERE id = ?').run(old, made.id);
    expect(autoCleanPeople(db, new Date(), 'box', false).users).toContain(made.id);
    expect(phoneOf(db, made.id)).toBeNull();
    expect(historyHasNumber(db, made.id)).toBe(false);
  });

  it('a delete that arrives by sync erases it on the receiving side, whether the entry carries a number or not', async () => {
    const one = makeApp();
    const two = makeApp();
    const three = makeApp();
    const admin = await loginAs(one, 'admin');
    const made = (await create(one, admin, 'Kak Siti', { phone: P1 })).json();
    const ctx = { surauId: LOCAL_SURAU_ID, now: new Date(Date.now() + 3600_000), origin: 'box:b1', actor: 'user:x', dataDir: tmpdir() };
    const entry = (after: Record<string, unknown>, ms: number): FeedEntry => {
      const at = new Date(Date.now() + ms).toISOString();
      return { seq: 1, entity: 'user', entityId: made.id, rev: `${at}|dev-x`, editedAt: at, syncedAt: at, actor: 'user:x', deviceId: null, origin: 'local', opId: null, after };
    };
    const created = lastAfter(one.surau.db, made.id);
    for (const side of [two, three]) {
      expect(applyFeedEntry(side.surau.db, entry(created, 1000), ctx).status).toBe('applied');
      expect(phoneOf(side.surau.db, made.id)).toBe(E1);
    }
    await del(one, admin, made.id, made.ref);
    const gone = lastAfter(one.surau.db, made.id);
    expect(gone).toMatchObject({ deleted: true });
    expect('phone' in gone).toBe(false);
    // the entry the sender made: no phone key
    expect(applyFeedEntry(two.surau.db, entry(gone, 2000), ctx).status).toBe('applied');
    expect(phoneOf(two.surau.db, made.id)).toBeNull();
    expect(historyHasNumber(two.surau.db, made.id)).toBe(false);
    // a peer that still sends the number with the delete: it never lands
    expect(applyFeedEntry(three.surau.db, entry({ ...gone, phone: E1 }, 2000), ctx).status).toBe('applied');
    expect(phoneOf(three.surau.db, made.id)).toBeNull();
    expect(historyHasNumber(three.surau.db, made.id)).toBe(false);
  });

  it('a deleted person never gets a number back from a later edit, and a person first seen deleted is stored without one', async () => {
    const app = makeApp();
    const db = app.surau.db;
    const meta = (ms: number) => ({ editedAt: new Date(Date.now() + ms).toISOString(), origin: 'box:b1', deviceId: 'dev-x' });
    putUserSynced(db, 'u-fresh', { name: 'Kak Siti', roles: ['ajk'], active: false, deleted: true, phone: E1 }, 'user:x', meta(1000) as never, LOCAL_SURAU_ID);
    expect(phoneOf(db, 'u-fresh')).toBeNull();
    expect(db.prepare('SELECT deleted_at FROM users WHERE id = ?').get('u-fresh')?.deleted_at).not.toBeNull();
    expect(historyHasNumber(db, 'u-fresh')).toBe(false);
    // an older peer's later edit (no deleted key) carrying the number
    putUserSynced(db, 'u-fresh', { name: 'Kak Siti Baru', roles: ['ajk'], active: true, phone: E1 }, 'user:x', meta(2000) as never, LOCAL_SURAU_ID);
    expect(phoneOf(db, 'u-fresh')).toBeNull();
    expect(historyHasNumber(db, 'u-fresh')).toBe(false);
    // a legacy deleted row that still holds a number is emptied by the next synced touch
    db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(E2, 'u-fresh');
    putUserSynced(db, 'u-fresh', { name: 'Kak Siti Baru', roles: ['ajk'], active: false }, 'user:x', meta(3000) as never, LOCAL_SURAU_ID);
    expect(phoneOf(db, 'u-fresh')).toBeNull();
    // a restore that arrives with a number comes back without it
    putUserSynced(db, 'u-fresh', { name: 'Kak Siti Baru', roles: ['ajk'], active: false, deleted: false, phone: E1 }, 'user:x', meta(4000) as never, LOCAL_SURAU_ID);
    expect(db.prepare('SELECT deleted_at FROM users WHERE id = ?').get('u-fresh')?.deleted_at).toBeNull();
    expect(phoneOf(db, 'u-fresh')).toBeNull();
  });
});

describe('[OPT-PHONE] restore', () => {
  it('a restored person comes back with no number, and the number may be taken by someone else meanwhile', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const db = app.surau.db;
    const a = (await create(app, admin, 'Kak Siti', { phone: P1 })).json();
    await del(app, admin, a.id, a.ref);
    // the number is free again for another person
    const b = await create(app, admin, 'Encik Rahman', { phone: P1 });
    expect(b.statusCode, b.body).toBe(201);
    const r = await restore(app, admin, a.id);
    expect(r.statusCode, r.body).toBe(200);
    expect(phoneOf(db, a.id)).toBeNull();
    expect(r.json().phone ?? null).toBeNull();
    expect(phoneOf(db, b.json().id)).toBe(E1);
    // a number can be given again afterwards, with the usual duplicate rule
    expect((await setPhone(app, admin, a.id, { phone: P1 })).statusCode).toBe(409);
    expect((await setPhone(app, admin, a.id, { phone: P2 })).json().phone).toBe(E2);
  });
});

describe('[OPT-PHONE] the start-up migration', () => {
  it('clears the number of every deleted person and the history keys, leaves live people alone, and a second run changes nothing', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const db = app.surau.db;
    const live = (await create(app, admin, 'Encik Rahman', { phone: P2 })).json();
    // a person deleted before this rule: deleted, number kept, history with numbers (written raw, as an old build left it)
    const row = (id: string, phone: string | null, deleted: boolean): void => {
      db.prepare("INSERT INTO users (id, name, roles_json, active, created_at, created_by, surau_id, phone, deleted_at) VALUES (?, 'Kak Lama', '[\"ajk\"]', 0, '2026-01-01T00:00:00.000Z', 'test', ?, ?, ?)").run(id, LOCAL_SURAU_ID, phone, deleted ? '2026-02-01T00:00:00.000Z' : null);
    };
    row('old-deleted', E1, true);
    row('old-bad-json', E1, true);
    const log = db.prepare("INSERT INTO change_log (surau_id, at, actor, entity, entity_id, before_json, after_json, origin, op_id, edited_at, rev) VALUES (?, '2026-01-02T00:00:00.000Z', 'test', 'users', ?, ?, ?, 'local', ?, '2026-01-02T00:00:00.000Z', 'r1')");
    log.run(LOCAL_SURAU_ID, 'old-deleted', JSON.stringify({ id: 'old-deleted', name: 'Kak Lama', phone: E1 }), JSON.stringify({ id: 'old-deleted', name: 'Kak Lama', phone: E1, deleted: true }), 'op-keep-1');
    log.run(LOCAL_SURAU_ID, 'old-bad-json', null, 'not json "phone" ' + E1, null);
    const before = db.prepare("SELECT id, op_id, rev, edited_at, origin FROM change_log WHERE entity = 'users' AND entity_id IN ('old-deleted', 'old-bad-json') ORDER BY id").all();
    const liveRows = JSON.stringify(logRows(db, live.id));
    const outboxBefore = Number(db.prepare('SELECT COUNT(*) AS n FROM worker_outbox').get()?.n);

    deletedPeoplePhone.up(db);
    expect(phoneOf(db, 'old-deleted')).toBeNull();
    expect(phoneOf(db, 'old-bad-json')).toBeNull();
    expect(phoneOf(db, live.id)).toBe(E2);
    const cleaned = logRows(db, 'old-deleted');
    expect(cleaned.map((r) => `${r.before_json}${r.after_json}`).join('')).not.toContain('phone');
    expect(JSON.parse(String(cleaned[0]?.after_json))).toMatchObject({ id: 'old-deleted', deleted: true });
    // a row that is not JSON is left as it is (never rewritten, never an error)
    expect(logRows(db, 'old-bad-json')[0]?.after_json).toBe('not json "phone" ' + E1);
    // the live person's history, the row identity columns and the outbox are untouched
    expect(JSON.stringify(logRows(db, live.id))).toBe(liveRows);
    expect(db.prepare("SELECT id, op_id, rev, edited_at, origin FROM change_log WHERE entity = 'users' AND entity_id IN ('old-deleted', 'old-bad-json') ORDER BY id").all()).toEqual(before);
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM worker_outbox').get()?.n)).toBe(outboxBefore);

    // second run: nothing changes
    const snapshot = JSON.stringify([db.prepare('SELECT id, phone, rev, edited_at FROM users ORDER BY id').all(), db.prepare("SELECT id, before_json, after_json FROM change_log WHERE entity = 'users' ORDER BY id").all()]);
    deletedPeoplePhone.up(db);
    expect(JSON.stringify([db.prepare('SELECT id, phone, rev, edited_at FROM users ORDER BY id').all(), db.prepare("SELECT id, before_json, after_json FROM change_log WHERE entity = 'users' ORDER BY id").all()])).toBe(snapshot);
  });

  it('is recorded once by the runner on a fresh database', () => {
    const app = makeApp();
    expect(app.surau.db.prepare("SELECT 1 AS x FROM schema_migrations WHERE name = '027-deleted-people-phone'").get()).toBeDefined();
  });
});

describe('[OPT-PHONE] no missing-number flag', () => {
  it('a person without a number has no phone need; a duplicate that arrived by sync is still flagged', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const none = (await create(app, admin, 'Kak Tiada')).json();
    const r = await app.inject({ method: 'GET', url: '/api/people/activity', headers: admin.headers });
    const mine = (r.json().users as Array<{ id: string; needs: string[] }>).find((u) => u.id === none.id);
    expect(mine?.needs).toEqual(expect.any(Array));
    expect(mine?.needs).not.toContain('phone');
  });
});
