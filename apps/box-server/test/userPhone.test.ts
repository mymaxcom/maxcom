import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeedEntry } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { peopleActivity } from '../src/auth/activity.ts';
import { createUser, setUserPhone } from '../src/auth/users.ts';
import { run as runUsersCli } from '../src/cli/users.ts';
import { applyFeedEntry } from '../src/sync/apply.ts';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';
import { loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { makeIdsPair } from './support/idsPair.ts';
import type { IdsPair } from './support/idsPair.ts';
import { insertSite } from './support/sites.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
const pairs: IdsPair[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const p of pairs.splice(0)) await p.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeApp(opts: Parameters<typeof buildApp>[1] = {}): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-s10-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'), { dataDir: dir, ...opts });
  apps.push(app);
  return app;
}

const P1 = '012-000 0010';
const E1 = '+60120000010';
/** What a number looks like in any text: with or without the country code. */
const hasNumber = (text: string, e164 = E1): boolean => text.includes(e164.slice(1)) || text.includes(e164) || text.includes(e164.slice(3));
const create = (app: FastifyInstance, by: Login, name: string, phone: unknown, roles: string[] = ['ajk']) =>
  app.inject({ method: 'POST', url: '/api/users', headers: by.headers, payload: { name, roles, ...(phone === undefined ? {} : { phone }) } });
const setPhone = (app: FastifyInstance, by: Login, id: string, phone: unknown) =>
  app.inject({ method: 'PUT', url: `/api/users/${id}/phone`, headers: by.headers, payload: { phone } });
const phoneOf = (db: DatabaseSync, id: string): unknown => db.prepare('SELECT phone FROM users WHERE id = ?').get(id)?.phone;

describe('[PP-S10] create, edit, duplicate', () => {
  it('[PP-S10] a person cannot be added without a number; with 012-000 0010 it is stored once as E.164', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const none = await create(app, admin, 'Kak Siti', undefined);
    expect(none.statusCode).toBe(400);
    expect(none.json().code).toBe('phone_required');
    expect((await create(app, admin, 'Kak Siti', '   ')).json().code).toBe('phone_required');
    const bad = await create(app, admin, 'Kak Siti', 'abc 123');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('bad_phone');
    expect(JSON.stringify(bad.json())).not.toContain('123');
    const ok = await create(app, admin, 'Kak Siti', P1);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().phone).toBe(E1);
    expect(phoneOf(app.surau.db, ok.json().id)).toBe(E1);
    const list = (await app.inject({ method: 'GET', url: '/api/users', headers: admin.headers })).json().users as Array<{ id: string; phone: string | null }>;
    expect(list.find((u) => u.id === ok.json().id)?.phone).toBe(E1);
  });

  it('[PP-S10] edit stores the normalised number; the same number again writes no row; a bad one is refused without echo', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const u = (await create(app, admin, 'Kak Siti', P1)).json();
    const db = app.surau.db;
    const log = (): number => Number(db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'users' AND entity_id = ?").get(u.id)?.n);
    const n = log();
    expect((await setPhone(app, admin, u.id, '+60 12-000 0011')).json().phone).toBe('+60120000011');
    expect(log()).toBe(n + 1);
    expect((await setPhone(app, admin, u.id, '0120000011')).statusCode).toBe(200);
    expect(log()).toBe(n + 1);
    const bad = await setPhone(app, admin, u.id, '12-3');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('bad_phone');
    expect(JSON.stringify(bad.json())).not.toContain('12-3');
    expect((await setPhone(app, admin, u.id, undefined)).json().code).toBe('phone_required');
    expect(phoneOf(db, u.id)).toBe('+60120000011');
  });

  it('[PP-S10] a number another person of the surau holds is refused with that person ID only; a deleted person frees it, a deactivated one does not', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const a = (await create(app, admin, 'Kak Siti', P1)).json();
    const b = (await create(app, admin, 'Encik Rahman', '012-000 0012')).json();
    const taken = await setPhone(app, admin, b.id, '+60 12-000 0010');
    expect(taken.statusCode).toBe(409);
    expect(taken.json().code).toBe('phone_taken');
    expect(taken.json().ref).toBe(a.ref);
    expect(JSON.stringify(taken.json())).not.toContain('Kak Siti');
    expect(hasNumber(JSON.stringify(taken.json()))).toBe(false);
    const dup = await create(app, admin, 'Puan Aminah', P1);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().ref).toBe(a.ref);
    // deactivated: the number still blocks
    await app.inject({ method: 'POST', url: `/api/users/${a.id}/deactivate`, headers: admin.headers, payload: {} });
    expect((await setPhone(app, admin, b.id, P1)).statusCode).toBe(409);
    // deleted: the number is free again
    await app.inject({ method: 'POST', url: `/api/users/${a.id}/delete`, headers: admin.headers, payload: { ref: a.ref } });
    expect((await setPhone(app, admin, b.id, P1)).statusCode).toBe(200);
    // another surau never conflicts
    const other = createUser(app.surau.db, { name: 'Haji Osman', roles: ['ajk'], phone: '012-000 0013' }, 'test', 'surau-lain');
    expect(other.phone).toBe('+60120000013');
    expect(setUserPhone(app.surau.db, b.id, '012-000 0013', 'test').phone).toBe('+60120000013');
  });

  it('[PP-S10][PP-GC] a Pentadbir MAXCOM id is 404 with a star_target_refused row; a Bendahari gets 403', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const treasurer = await loginAs(app, 'treasurer');
    const star = await loginAs(app, 'superadmin');
    const db = app.surau.db;
    const n0 = Number(db.prepare("SELECT COUNT(*) AS n FROM auth_log WHERE event = 'star_target_refused'").get()?.n);
    expect((await setPhone(app, admin, star.userId, P1)).statusCode).toBe(404);
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM auth_log WHERE event = 'star_target_refused'").get()?.n) - n0).toBe(1);
    expect(phoneOf(db, star.userId)).toBeNull();
    expect((await setPhone(app, admin, 'nope', P1)).statusCode).toBe(404);
    expect((await setPhone(app, treasurer, star.userId, P1)).statusCode).toBe(403);
  });

  it('[PP-S10] an existing person with no number still unlocks and works, and shows needs phone; a duplicate that arrived by sync is flagged, not refused', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const old = await loginAs(app, 'ajk'); // made with no number, as before this version
    const db = app.surau.db;
    expect(phoneOf(db, old.userId)).toBeNull();
    expect((await old.relogin()).length).toBeGreaterThan(10);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: old.headers })).json().user.phone).toBeNull();
    const act = peopleActivity(db, LOCAL_SURAU_ID, new Date(), 'box', false);
    expect(act.users.find((u) => u.id === old.userId)?.needs).toContain('phone');
    const a = (await create(app, admin, 'Kak Siti', P1)).json();
    const b = (await create(app, admin, 'Encik Rahman', '012-000 0012')).json();
    const at = new Date(Date.now() + 5000).toISOString();
    const entry: FeedEntry = { seq: 1, entity: 'user', entityId: b.id, rev: `${at}|dev-x`, editedAt: at, syncedAt: at, actor: 'user:x', deviceId: null, origin: 'local', opId: null, after: { id: b.id, name: 'Encik Rahman', roles: ['ajk'], active: true, phone: E1 } };
    expect(applyFeedEntry(db, entry, { surauId: LOCAL_SURAU_ID, now: new Date(Date.now() + 3600_000), origin: 'box:b1', actor: 'user:x', dataDir: tmpdir() }).status).toBe('applied');
    const after = peopleActivity(db, LOCAL_SURAU_ID, new Date(), 'box', false);
    expect(after.users.find((u) => u.id === a.id)?.needs).toContain('phone_duplicate');
    expect(after.users.find((u) => u.id === b.id)?.needs).toContain('phone_duplicate');
    expect(hasNumber(JSON.stringify(after))).toBe(false);
  });
});

describe('[PP-S10] the number is private', () => {
  it('[PP-S10] Bendahari, Media, Siaran Langsung and AJK sessions find no number in snapshot, changes, audit, finance audit, activity or users', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const made = (await create(app, admin, 'Kak Siti', P1)).json();
    await setPhone(app, admin, made.id, '012-000 0011');
    await app.inject({ method: 'POST', url: `/api/users/${made.id}/deactivate`, headers: admin.headers, payload: {} });
    for (const role of ['treasurer', 'media', 'live', 'ajk'] as const) {
      const who = await loginAs(app, role);
      for (const url of ['/api/sync/snapshot', '/api/sync/changes?since=0', '/api/audit', '/api/finance/audit', '/api/people/activity', '/api/users', '/api/auth/me']) {
        const r = await app.inject({ method: 'GET', url, headers: who.headers });
        expect(hasNumber(r.body, '+60120000010'), `${role} ${url}`).toBe(false);
        expect(hasNumber(r.body, '+60120000011'), `${role} ${url}`).toBe(false);
      }
    }
  });

  it('[PP-S10] the Pentadbir sees the number in the list, the snapshot and the feed, and in the audit only as phoneChanged', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const made = (await create(app, admin, 'Kak Siti', P1)).json();
    await setPhone(app, admin, made.id, '012-000 0011');
    const snap = (await app.inject({ method: 'GET', url: '/api/sync/snapshot', headers: admin.headers })).json();
    expect((snap.users as Array<{ id: string; phone?: string }>).find((u) => u.id === made.id)?.phone).toBe('+60120000011');
    expect(hasNumber((await app.inject({ method: 'GET', url: '/api/sync/changes?since=0', headers: admin.headers })).body, '+60120000011')).toBe(true);
    const audit = await app.inject({ method: 'GET', url: '/api/audit', headers: admin.headers });
    expect(hasNumber(audit.body, '+60120000010')).toBe(false);
    expect(hasNumber(audit.body, '+60120000011')).toBe(false);
    const rows = audit.json().entries as Array<{ entityId: string | null; entity: string; phoneChanged?: boolean }>;
    expect(rows.filter((e) => e.entity === 'users' && e.entityId === made.id && e.phoneChanged === true).length).toBeGreaterThanOrEqual(2);
    // the person sees their own number only
    const own = await loginAs(app, 'ajk');
    await setPhone(app, admin, own.userId, '012-000 0014');
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: own.headers })).json().user.phone).toBe('+60120000014');
  });

  it('[PP-S10] auth_log and captured console output hold no number after a create, an edit and a refused edit', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const made = (await create(app, admin, 'Kak Siti', P1)).json();
    await setPhone(app, admin, made.id, '012-000 0011');
    const other = (await create(app, admin, 'Encik Rahman', '012-000 0012')).json();
    expect((await setPhone(app, admin, other.id, '012-000 0011')).statusCode).toBe(409);
    expect((await setPhone(app, admin, other.id, 'tidak sah 0120000019')).statusCode).toBe(400);
    const authLog = JSON.stringify(app.surau.db.prepare('SELECT * FROM auth_log').all());
    for (const e of ['+60120000010', '+60120000011', '+60120000012', '+60120000019']) {
      expect(hasNumber(authLog, e), e).toBe(false);
      expect(hasNumber(logs.join('\n'), e), e).toBe(false);
    }
    // the actor name column and finance names never carry it either
    expect(hasNumber(JSON.stringify(app.surau.db.prepare('SELECT actor_name FROM change_log').all()))).toBe(false);
  });

  it('[PP-S10] a Pentadbir MAXCOM phone number is absent from a site feed and snapshot', async () => {
    const app = makeApp({ role: 'cloud' });
    app.surau.db.prepare("INSERT OR IGNORE INTO suraus (id, name, created_at, created_by) VALUES ('sdm', 'Surau Perintis Contoh', '2026-11-01T00:00:00.000Z', 'test')").run();
    const star = await loginAs(app, 'superadmin');
    setUserPhone(app.surau.db, star.userId, '012-000 0015', 'test'); // the CLI may hold one
    createUser(app.surau.db, { name: 'Kak Siti', roles: ['ajk'], phone: '012-000 0016' }, 'test', 'sdm');
    const site = insertSite(app.surau.db, { boxId: 'cd'.repeat(8), surauId: 'sdm' });
    const snap = await app.inject({ method: 'GET', url: '/api/sync/snapshot', headers: site.headers });
    const feed = await app.inject({ method: 'GET', url: '/api/sync/changes?since=0', headers: site.headers });
    expect(hasNumber(snap.body, '+60120000015')).toBe(false);
    expect(hasNumber(feed.body, '+60120000015')).toBe(false);
    // an ordinary person's number does travel to their own surau's box
    expect(hasNumber(snap.body, '+60120000016')).toBe(true);
    expect(hasNumber(feed.body, '+60120000016')).toBe(true);
  });
});

describe('[PP-S10] sync', () => {
  const ctx = (): Parameters<typeof applyFeedEntry>[2] => ({ surauId: LOCAL_SURAU_ID, now: new Date(Date.now() + 3600_000), origin: 'box:b1', actor: 'user:x', dataDir: tmpdir() });
  const entry = (id: string, after: Record<string, unknown>, ms: number): FeedEntry => {
    const at = new Date(Date.now() + ms).toISOString();
    return { seq: 1, entity: 'user', entityId: id, rev: `${at}|dev-x`, editedAt: at, syncedAt: at, actor: 'user:x', deviceId: null, origin: 'local', opId: null, after };
  };

  it('[PP-S10] the number reaches a second server; an entry without the key leaves it; a bad one is ignored', async () => {
    const one = makeApp();
    const two = makeApp();
    const admin = await loginAs(one, 'admin');
    const made = (await create(one, admin, 'Kak Siti', P1)).json();
    const last = one.surau.db.prepare("SELECT after_json FROM change_log WHERE entity = 'users' AND entity_id = ? ORDER BY id DESC LIMIT 1").get(made.id);
    const after = JSON.parse(String(last?.after_json)) as Record<string, unknown>;
    expect(after.phone).toBe(E1);
    expect(applyFeedEntry(two.surau.db, entry(made.id, after, 1000), ctx()).status).toBe('applied');
    expect(phoneOf(two.surau.db, made.id)).toBe(E1);
    const { phone: _drop, ...bare } = after;
    expect(applyFeedEntry(two.surau.db, entry(made.id, { ...bare, name: 'Kak Siti binti Ali' }, 2000), ctx()).status).toBe('applied');
    expect(phoneOf(two.surau.db, made.id)).toBe(E1);
    expect(applyFeedEntry(two.surau.db, entry(made.id, { ...bare, name: 'Kak Siti binti Ali', phone: 'bukan nombor' }, 3000), ctx()).status).toBe('applied');
    expect(phoneOf(two.surau.db, made.id)).toBe(E1);
  });

  it('[PP-S10] a user.put op from a phone never sets a number', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const { signOp } = await import('./support/signOp.ts');
    const op = await signOp(admin, app.surau.boxId, { kind: 'user.put', entity: 'user', entityId: ajk.userId, payload: { name: 'Kak Siti Baru', phone: P1 }, editedAt: new Date(Date.now() + 60_000).toISOString() });
    const r = await app.inject({ method: 'POST', url: '/api/sync/ops', headers: admin.headers, payload: { ops: [op] } });
    expect(r.json().results[0].status, r.body).toBe('applied');
    expect(phoneOf(app.surau.db, ajk.userId)).toBeNull();
  });

  it('[PP-S10] people_resync fills a missing number from the cloud once and clears the flag', async () => {
    const p = await makeIdsPair();
    pairs.push(p);
    const raw = (db: DatabaseSync, phone: string | null): void =>
      void db.prepare("INSERT INTO users (id, name, roles_json, active, created_at, created_by, surau_id, phone) VALUES ('same-user', 'Kak Siti', '[\"ajk\"]', 1, '2026-01-01T00:00:00.000Z', 'test', 'sdm', ?)").run(phone);
    raw(p.cloud.app.surau.db, E1);
    raw(p.box.surau.db, null);
    expect(p.box.surau.db.prepare("SELECT value FROM sync_state WHERE key = 'people_resync'").get()?.value).toBe('1');
    await p.round();
    expect(phoneOf(p.box.surau.db, 'same-user')).toBe(E1);
    expect(p.box.surau.db.prepare("SELECT value FROM sync_state WHERE key = 'people_resync'").get()).toBeUndefined();
    // it ran once: a number removed locally later is not refilled
    p.box.surau.db.prepare("UPDATE users SET phone = NULL WHERE id = 'same-user'").run();
    await p.round();
    expect(phoneOf(p.box.surau.db, 'same-user')).toBeNull();
  });
});

describe('[PP-S10] CLI', () => {
  it('[PP-S10] set-phone --ref stores the number without echoing it; list --phones shows it to the operator; a duplicate is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-s10cli-'));
    dirs.push(dir);
    const dbPath = join(dir, 'cli.db');
    const app = buildApp(dbPath, { dataDir: dir });
    createUser(app.surau.db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', LOCAL_SURAU_ID);
    createUser(app.surau.db, { name: 'Encik Rahman', roles: ['ajk'] }, 'test', LOCAL_SURAU_ID);
    await app.close();
    const lines: string[] = [];
    const run = (args: string[]) => runUsersCli(['--db', dbPath, ...args], { out: (l) => lines.push(l), err: (l) => lines.push(l) });
    expect(await run(['set-phone', '--ref', 'U-0001', '--phone', P1])).toBe(0);
    expect(hasNumber(lines.join('\n'))).toBe(false);
    lines.length = 0;
    expect(await run(['set-phone', '--ref', 'U-0002', '--phone', P1])).not.toBe(0);
    expect(hasNumber(lines.join('\n'))).toBe(false);
    lines.length = 0;
    expect(await run(['list'])).toBe(0);
    expect(hasNumber(lines.join('\n'))).toBe(false);
    lines.length = 0;
    expect(await run(['list', '--phones'])).toBe(0);
    expect(lines.join('\n')).toContain('+60 12-000 0010');
    expect(await run(['set-phone', '--ref', 'U-0002'])).toBe(1);
  });
});
