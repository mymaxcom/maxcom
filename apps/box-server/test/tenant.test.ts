/**
 * Plan 14 Task 3 (tests first, security scope): tenant resolution and the acting-surau header.
 *
 * Assumptions for the implementer (the plan fixes behaviour, not these names; change the test, not the
 * plan, if a choice here is wrong, and say so):
 *  - `src/tenant.ts` exports `LOCAL_SURAU_ID` (= 'sdm', today's DEFAULT_SURAU_ID) and
 *    `tenantOf(identity, headers, db, role): Tenant | TenantRefusal`, with `Tenant = { surauId: string }`.
 *  - `TenantRefusal` is an object with a numeric `status` (400 | 403 | 404) and a string `code`. The codes
 *    the plan names are `surau_required` (400) and `ops_device_required` (403); other refusals are asserted
 *    by status only. A tenant is told from a refusal by `'status' in result`.
 *  - `tenantOf` writes the `auth_log` rows itself (it gets `db`): ONE row per refused call, none otherwise.
 *    A foreign header from a surau user: event `cross_surau_refused`. A `*` user on a public device with a
 *    header: a row whose event OR detail is `ops_device_required` (section 3.1 says detail).
 *  - The header is `x-maxcom-surau` (lower case in the `headers` object, as Fastify delivers it); a header
 *    given twice (array) is malformed (400).
 *  - A user identity is `AuthContext` plus `ops: boolean` (Task 23). `tenantOf` decides "acting as `*`" from
 *    `identity.ops === true` AND the user row `users.surau_id = '*'`; a non-ops identity is a user of
 *    `devices.surau_id` of its device, whatever the user row says.
 *  - A `support` user (ops role, `users.surau_id = '*'`) never gets a tenant: 403 with or without a header.
 *  - A site identity's tenant is `identity.surauId`; the header is ignored for a site.
 *  - Over HTTP a refusal is the plan's status; the 400 body mentions `surau_required` (reason field).
 *  - Identities, users, devices, sites and sessions are built by SQL here, not through test/authHelpers.ts.
 *  - The 'every authz row declares tenant' table test lives in test/authz.test.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { klInstant } from '@surau/core';
import type { Role } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { sha256hex } from '../src/auth/crypto.ts';
import { openDb } from '../src/db.ts';
import { LOCAL_SURAU_ID, tenantOf } from '../src/tenant.ts';
import { loginAsAdmin } from './authHelpers.ts';

const AT = klInstant('2026-11-03', '12:00');
const A = 'surau-a';
const B = 'surau-b';
const HDR = 'x-maxcom-surau';
const apps: FastifyInstance[] = [];
const dirs: string[] = [];
const dbs: DatabaseSync[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dbs.splice(0)) {
    try {
      d.close();
    } catch {
      /* closed */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ISO = AT.toISOString();
let n = 0;

function seed(db: DatabaseSync): void {
  for (const id of [A, B]) {
    db.prepare('INSERT INTO suraus (id, name, created_at, created_by) VALUES (?, ?, ?, ?)').run(id, `Surau ${id}`, ISO, 'test');
  }
}

function freshDb(): DatabaseSync {
  const db = openDb(':memory:');
  dbs.push(db);
  seed(db);
  return db;
}

interface Who {
  userId: string;
  deviceId: string;
}

/** A user row and a device row; `userSurau` / `deviceSurau` are `surau_id`, `ops` the device flag. */
function addUser(db: DatabaseSync, o: { roles: Role[]; userSurau: string; deviceSurau: string; ops: boolean }): Who {
  const i = ++n;
  const userId = `u${i}`;
  const deviceId = `d${i}`;
  db.prepare('INSERT INTO users (id, name, roles_json, surau_id, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(
    userId,
    `Orang ${i}`,
    JSON.stringify(o.roles),
    o.userSurau,
    ISO,
    'test',
  );
  db.prepare('INSERT INTO devices (id, user_id, name, platform, enrolled_at, surau_id, ops) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    deviceId,
    userId,
    `Telefon ${i}`,
    'android',
    ISO,
    o.deviceSurau,
    o.ops ? 1 : 0,
  );
  return { userId, deviceId };
}

/** The identity `resolveSession` would give (Task 23 adds `ops`). */
const identityOf = (w: Who, roles: Role[], ops: boolean) =>
  ({ kind: 'user', userId: w.userId, deviceId: w.deviceId, roles, sessionId: `s${w.userId}`, ops }) as never;

const refusal = (r: unknown): { status: number; code?: string } => {
  expect(r, 'expected a TenantRefusal').toHaveProperty('status');
  return r as { status: number; code?: string };
};
const isRefusal = (r: unknown): boolean => typeof r === 'object' && r !== null && 'status' in r;
const authRows = (db: DatabaseSync): Array<{ event: string; detail: string | null }> =>
  db.prepare('SELECT event, detail FROM auth_log ORDER BY id').all() as Array<{ event: string; detail: string | null }>;

describe('tenantOf: box role', () => {
  it('is always the local constant and the header is ignored (foreign, unknown, malformed, even none)', () => {
    const db = freshDb();
    expect(LOCAL_SURAU_ID).toBe('sdm');
    const w = addUser(db, { roles: ['admin'], userSurau: 'sdm', deviceSurau: 'sdm', ops: false });
    const id = identityOf(w, ['admin'], false);
    for (const h of [undefined, B, 'nope-not-there', 'A b', '*', ['x', 'y']]) {
      const headers = h === undefined ? {} : { [HDR]: h };
      expect(tenantOf(id, headers, db, 'box')).toEqual({ surauId: LOCAL_SURAU_ID });
    }
    expect(authRows(db)).toEqual([]);
  });

  it('a `*` user on a box also gets the constant, never a refusal', () => {
    const db = freshDb();
    const w = addUser(db, { roles: ['superadmin'], userSurau: '*', deviceSurau: 'sdm', ops: false });
    expect(tenantOf(identityOf(w, ['superadmin'], false), { [HDR]: A }, db, 'box')).toEqual({ surauId: LOCAL_SURAU_ID });
    expect(authRows(db)).toEqual([]);
  });
});

describe('tenantOf: cloud, site and device session', () => {
  it('a site resolves to its own surau and ignores the header', () => {
    const db = freshDb();
    const site = { kind: 'site', boxId: 'box-1', surauId: A } as never;
    expect(tenantOf(site, {}, db, 'cloud')).toEqual({ surauId: A });
    expect(tenantOf(site, { [HDR]: B }, db, 'cloud')).toEqual({ surauId: A });
    expect(authRows(db)).toEqual([]);
  });

  it('a device session resolves to the device surau, not to the user row', () => {
    const db = freshDb();
    // user row left at the column default ('sdm'); the device row says A
    const w = addUser(db, { roles: ['admin'], userSurau: 'sdm', deviceSurau: A, ops: false });
    const id = identityOf(w, ['admin'], false);
    expect(tenantOf(id, {}, db, 'cloud')).toEqual({ surauId: A });
    expect(tenantOf(id, { [HDR]: A }, db, 'cloud')).toEqual({ surauId: A });
    expect(authRows(db)).toEqual([]);
  });

  it('a surau user with a foreign header: 403 and exactly one cross_surau_refused row, no tenant', () => {
    const db = freshDb();
    const w = addUser(db, { roles: ['admin'], userSurau: A, deviceSurau: A, ops: false });
    const r = tenantOf(identityOf(w, ['admin'], false), { [HDR]: B }, db, 'cloud');
    expect(isRefusal(r)).toBe(true);
    expect(refusal(r).status).toBe(403);
    const rows = authRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toBe('cross_surau_refused');
  });

  it('a surau user naming a surau that does not exist is refused 403 too, not 404 (no probing of ids)', () => {
    const db = freshDb();
    const w = addUser(db, { roles: ['admin'], userSurau: A, deviceSurau: A, ops: false });
    const r = tenantOf(identityOf(w, ['admin'], false), { [HDR]: 'surau-zzz' }, db, 'cloud');
    expect(refusal(r).status).toBe(403);
    expect(authRows(db)).toHaveLength(1);
  });

  it('a `support` user never gets a tenant: 403 with or without a header, on an ops device', () => {
    const db = freshDb();
    const w = addUser(db, { roles: ['support'], userSurau: '*', deviceSurau: '*', ops: true });
    const id = identityOf(w, ['support'], true);
    expect(refusal(tenantOf(id, {}, db, 'cloud')).status).toBe(403);
    expect(refusal(tenantOf(id, { [HDR]: A }, db, 'cloud')).status).toBe(403);
  });
});

describe('tenantOf: `*` user on an ops device (the acting header)', () => {
  const ops = (db: DatabaseSync) => {
    const w = addUser(db, { roles: ['superadmin'], userSurau: '*', deviceSurau: '*', ops: true });
    return identityOf(w, ['superadmin'], true);
  };

  it('no header: 400 surau_required', () => {
    const db = freshDb();
    const r = refusal(tenantOf(ops(db), {}, db, 'cloud'));
    expect(r.status).toBe(400);
    expect(r.code).toBe('surau_required');
  });

  it('known id: the tenant is that surau (success path), with no refusal row', () => {
    const db = freshDb();
    const id = ops(db);
    expect(tenantOf(id, { [HDR]: A }, db, 'cloud')).toEqual({ surauId: A });
    expect(tenantOf(id, { [HDR]: B }, db, 'cloud')).toEqual({ surauId: B });
    expect(authRows(db)).toEqual([]);
  });

  it('a superadmin whose user row still has a surau id (promoted after migration 019) acts the same on an ops device', () => {
    const db = freshDb();
    const w = addUser(db, { roles: ['superadmin'], userSurau: 'sdm', deviceSurau: '*', ops: true });
    const id = identityOf(w, ['superadmin'], true);
    expect(tenantOf(id, { [HDR]: B }, db, 'cloud')).toEqual({ surauId: B });
    expect(refusal(tenantOf(id, {}, db, 'cloud')).code).toBe('surau_required');
  });

  it('unknown id (well formed, not in suraus): 404', () => {
    const db = freshDb();
    expect(refusal(tenantOf(ops(db), { [HDR]: 'surau-zzz' }, db, 'cloud')).status).toBe(404);
  });

  it.each(['A', '*', 'x'.repeat(41), 'a b', 'a_b', 'a', '../x', ''])('malformed id %j: 400', (bad) => {
    const db = freshDb();
    const r = tenantOf(ops(db), { [HDR]: bad }, db, 'cloud');
    // an empty header is "not given" for some servers: both readings are 400
    expect(refusal(r).status).toBe(400);
  });

  it('a header given twice is malformed: 400', () => {
    const db = freshDb();
    expect(refusal(tenantOf(ops(db), { [HDR]: [A, B] }, db, 'cloud')).status).toBe(400);
  });

  it('a header never selects a surau for the lookup of a suspended-looking id by a different case', () => {
    const db = freshDb();
    expect(refusal(tenantOf(ops(db), { [HDR]: A.toUpperCase() }, db, 'cloud')).status).toBe(400);
  });
});

describe('tenantOf: ops rule (a `*` user on a PUBLIC device)', () => {
  const pub = (db: DatabaseSync, deviceSurau = A) => {
    const w = addUser(db, { roles: ['superadmin', 'admin'], userSurau: '*', deviceSurau, ops: false });
    return identityOf(w, ['admin'], false);
  };

  it('no header: the tenant of devices.surau_id, never 400 surau_required', () => {
    const db = freshDb();
    const r = tenantOf(pub(db), {}, db, 'cloud');
    expect(isRefusal(r)).toBe(false);
    expect(r).toEqual({ surauId: A });
    expect(authRows(db)).toEqual([]);
  });

  it('the device surau is what counts', () => {
    const db = freshDb();
    expect(tenantOf(pub(db, B), {}, db, 'cloud')).toEqual({ surauId: B });
  });

  it.each([['own surau', A], ['another surau', B]])('header for %s: 403 and one ops_device_required row', (_n, h) => {
    const db = freshDb();
    const r = refusal(tenantOf(pub(db, A), { [HDR]: h }, db, 'cloud'));
    expect(r.status).toBe(403);
    expect(r.code).not.toBe('surau_required');
    const rows = authRows(db);
    expect(rows).toHaveLength(1);
    expect([rows[0]!.event, rows[0]!.detail]).toContain('ops_device_required');
  });

  it('identity.ops is what decides: the user row `*` alone does not make an acting user', () => {
    const db = freshDb();
    const w = addUser(db, { roles: ['superadmin'], userSurau: '*', deviceSurau: A, ops: false });
    const r = tenantOf(identityOf(w, ['superadmin'], false), { [HDR]: B }, db, 'cloud');
    expect(refusal(r).status).toBe(403);
  });
});

describe('tenantOf: an unmarked ops device (surau `*`, ops = 0)', () => {
  it('never gets tenant `*` and never acts: 403 ops_device_required with one auth_log row, header or not', () => {
    for (const roles of [['superadmin'], ['superadmin', 'admin'], ['admin']] as Role[][]) {
      for (const h of [undefined, A, '*']) {
        const db = freshDb();
        const w = addUser(db, { roles, userSurau: '*', deviceSurau: '*', ops: false });
        const r = refusal(tenantOf(identityOf(w, roles, false), h === undefined ? {} : { [HDR]: h }, db, 'cloud'));
        expect(r.status).toBe(403);
        expect(r.code).toBe('ops_device_required');
        const rows = authRows(db);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.detail).toBe('ops_device_required');
      }
    }
  });

  it('a session that claims ops while the row says 0 is not acting either', () => {
    const db = freshDb();
    const w = addUser(db, { roles: ['superadmin'], userSurau: '*', deviceSurau: '*', ops: false });
    const r = refusal(tenantOf(identityOf(w, ['superadmin'], true), { [HDR]: A }, db, 'cloud'));
    expect(r.status).toBe(403);
    expect(authRows(db)).toHaveLength(1);
  });
});

describe('refusal rows are throttled (qs-gate)', () => {
  it('one row per (user and device, code) a minute; another code, another device or the next minute gets its own', () => {
    const db = freshDb();
    const w = addUser(db, { roles: ['admin'], userSurau: A, deviceSurau: A, ops: false });
    const v = addUser(db, { roles: ['admin'], userSurau: A, deviceSurau: A, ops: false });
    const t0 = new Date('2026-11-12T08:00:00.000Z');
    const at = (ms: number) => ({ now: new Date(t0.getTime() + ms) });
    for (let i = 0; i < 50; i += 1) {
      expect(refusal(tenantOf(identityOf(w, ['admin'], false), { [HDR]: B }, db, 'cloud', at(i * 100))).status).toBe(403);
    }
    expect(authRows(db)).toHaveLength(1);
    // another code from the same device
    expect(refusal(tenantOf(identityOf(w, ['admin'], false), { [HDR]: 'BAD!' }, db, 'cloud', at(6_000))).status).toBe(400);
    // another device, same code
    expect(refusal(tenantOf(identityOf(v, ['admin'], false), { [HDR]: B }, db, 'cloud', at(6_000))).status).toBe(403);
    expect(authRows(db).map((r) => r.event)).toEqual(['cross_surau_refused', 'surau_malformed', 'cross_surau_refused']);
    // a minute later the first gets a row again
    tenantOf(identityOf(w, ['admin'], false), { [HDR]: B }, db, 'cloud', at(61_000));
    expect(authRows(db)).toHaveLength(4);
    // the success path writes nothing
    expect(isRefusal(tenantOf(identityOf(w, ['admin'], false), { [HDR]: A }, db, 'cloud', at(62_000)))).toBe(false);
    expect(authRows(db)).toHaveLength(4);
  });
});

describe('HTTP statuses (route level)', () => {
  function cloudApp(): FastifyInstance {
    const dir = mkdtempSync(join(tmpdir(), 'surau-tenant-'));
    dirs.push(dir);
    const noNetwork = (async () => { throw new TypeError('network disabled in tests'); }) as unknown as typeof fetch;
    const app = buildApp(join(dir, 'c.db'), { dataDir: dir, role: 'cloud', boxId: 'a1b2c3d4e5f60718', now: () => AT, fetchImpl: noNetwork });
    apps.push(app);
    seed(app.surau.db);
    return app;
  }

  /** A signed-in session for a fresh user/device made by SQL; returns the Authorization header. */
  function session(app: FastifyInstance, o: { roles: Role[]; userSurau: string; deviceSurau: string; ops: boolean }): { authorization: string } {
    const db = app.surau.db;
    const w = addUser(db, o);
    const token = `tok${w.userId}${'x'.repeat(30)}`;
    const later = new Date(AT.getTime() + 8 * 3600_000).toISOString();
    db.prepare(
      'INSERT INTO sessions (id, token_hash, device_id, user_id, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(`sess${w.userId}`, sha256hex(token), w.deviceId, w.userId, ISO, later, ISO);
    return { authorization: `Bearer ${token}` };
  }

  const get = (app: FastifyInstance, headers: Record<string, string>, h?: string) =>
    app.inject({ method: 'GET', url: '/api/settings', headers: { ...headers, ...(h === undefined ? {} : { 'x-maxcom-surau': h }) } });

  it('cloud, `*` user on an ops device: none 400 surau_required, known 200, unknown 404, malformed 400', async () => {
    const app = cloudApp();
    const s = session(app, { roles: ['superadmin'], userSurau: '*', deviceSurau: '*', ops: true });
    const none = await get(app, s);
    expect(none.statusCode).toBe(400);
    expect(none.body).toContain('surau_required');
    expect((await get(app, s, A)).statusCode).toBe(200);
    expect((await get(app, s, 'surau-zzz')).statusCode).toBe(404);
    expect((await get(app, s, 'A b')).statusCode).toBe(400);
  });

  it('cloud, surau admin: own surau 200, no header 200, foreign header 403 with one auth_log row', async () => {
    const app = cloudApp();
    const s = session(app, { roles: ['admin'], userSurau: A, deviceSurau: A, ops: false });
    expect((await get(app, s)).statusCode).toBe(200);
    expect((await get(app, s, A)).statusCode).toBe(200);
    expect(authRows(app.surau.db).filter((r) => r.event === 'cross_surau_refused')).toHaveLength(0);
    expect((await get(app, s, B)).statusCode).toBe(403);
    expect(authRows(app.surau.db).filter((r) => r.event === 'cross_surau_refused')).toHaveLength(1);
  });

  it('cloud, `*` user on a public device: no header 200 (never 400), any header 403 + one ops_device_required row', async () => {
    const app = cloudApp();
    const s = session(app, { roles: ['superadmin', 'admin'], userSurau: '*', deviceSurau: A, ops: false });
    expect((await get(app, s)).statusCode).toBe(200);
    expect((await get(app, s, A)).statusCode).toBe(403);
    expect((await get(app, s, B)).statusCode).toBe(403);
    // two refusals of the same device and code inside a minute: one row (qs-gate: no log flood)
    const rows = authRows(app.surau.db).filter((r) => r.event === 'ops_device_required' || r.detail === 'ops_device_required');
    expect(rows).toHaveLength(1);
  });

  it('cloud, `support` user on a tenant route: 403 (with or without a header, on an ops device)', async () => {
    const app = cloudApp();
    const s = session(app, { roles: ['support'], userSurau: '*', deviceSurau: '*', ops: true });
    expect((await get(app, s)).statusCode).toBe(403);
    expect((await get(app, s, A)).statusCode).toBe(403);
  });

  it('cloud, unmarked ops device (surau `*`, ops = 0): 403 ops_device_required before the handler, one row each', async () => {
    const app = cloudApp();
    // superadmin + admin: the permission check passes on admin, so the tenant step is what refuses
    const s = session(app, { roles: ['superadmin', 'admin'], userSurau: '*', deviceSurau: '*', ops: false });
    const none = await get(app, s);
    expect(none.statusCode).toBe(403);
    expect(none.json()).toMatchObject({ reason: 'ops_device_required' });
    expect((await get(app, s, A)).statusCode).toBe(403);
    const rows = authRows(app.surau.db).filter((r) => r.detail === 'ops_device_required');
    expect(rows).toHaveLength(1);
    // tenant 'none' routes (own session) still answer
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: s })).statusCode).toBe(200);
  });

  it('box role: the header is ignored (200, no auth_log row)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-tenant-box-'));
    dirs.push(dir);
    const app = buildApp(join(dir, 'b.db'), { dataDir: dir, now: () => AT });
    apps.push(app);
    const admin = await loginAsAdmin(app);
    const before = authRows(app.surau.db).length;
    for (const h of [A, 'A b', 'surau-zzz']) {
      expect((await get(app, admin.headers, h)).statusCode).toBe(200);
    }
    expect(authRows(app.surau.db).filter((r) => r.event === 'cross_surau_refused' || r.detail === 'ops_device_required')).toHaveLength(0);
    expect(authRows(app.surau.db).length).toBe(before);
  });
});
