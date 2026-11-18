import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { allocateNo, allocatorFor, backfillIds, checkIds, raiseCounters, settleIncomingNo } from '../src/auth/ids.ts';
import { createUser, listUsers, setRoles } from '../src/auth/users.ts';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';
import { run as runUsersCli } from '../src/cli/users.ts';
import { loginAs } from './authHelpers.ts';
import { ensureSurau } from './support/surauRow.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeApp(opts: Parameters<typeof buildApp>[1] = {}): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-s8-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'), { dataDir: dir, ...opts });
  apps.push(app);
  return app;
}

const noOf = (db: DatabaseSync, table: 'users' | 'devices', id: string): { no: unknown; no_src: unknown } =>
  db.prepare(`SELECT no, no_src FROM ${table} WHERE id = ?`).get(id) as { no: unknown; no_src: unknown };

function rawUser(db: DatabaseSync, id: string, name: string, createdAt: string, surau = LOCAL_SURAU_ID, active = 1): void {
  db.prepare("INSERT INTO users (id, name, roles_json, active, created_at, created_by, surau_id) VALUES (?, ?, '[\"ajk\"]', ?, ?, 'test', ?)").run(id, name, active, createdAt, surau);
}
function rawDevice(db: DatabaseSync, id: string, userId: string, enrolledAt: string, surau = LOCAL_SURAU_ID, revoked: string | null = null): void {
  db.prepare("INSERT INTO devices (id, user_id, name, platform, enrolled_at, revoked_at, surau_id) VALUES (?, ?, ?, 'android', ?, ?, ?)").run(id, userId, `Telefon ${id}`, enrolledAt, revoked, surau);
}

describe('[PP-S8] backfill numbers existing records in creation order', () => {
  it('[PP-S8] 3 users and 4 devices created out of id order are numbered by creation time, deactivated and revoked included; a second run changes nothing', () => {
    const app = makeApp();
    const db = app.surau.db;
    rawUser(db, 'zz', 'Encik Rahman', '2026-01-01T00:00:00.000Z');
    rawUser(db, 'aa', 'Puan Aminah', '2026-03-01T00:00:00.000Z', LOCAL_SURAU_ID, 0);
    rawUser(db, 'mm', 'Kak Siti', '2026-02-01T00:00:00.000Z');
    rawDevice(db, 'd4', 'zz', '2026-05-01T00:00:00.000Z');
    rawDevice(db, 'd1', 'zz', '2026-01-02T00:00:00.000Z', LOCAL_SURAU_ID, '2026-06-01T00:00:00.000Z');
    rawDevice(db, 'd3', 'mm', '2026-04-01T00:00:00.000Z');
    rawDevice(db, 'd2', 'mm', '2026-03-02T00:00:00.000Z');
    expect(backfillIds(db, 'box')).toEqual({ users: 3, devices: 4 });
    expect(['zz', 'mm', 'aa'].map((i) => Number(noOf(db, 'users', i).no))).toEqual([1, 2, 3]);
    expect(['d1', 'd2', 'd3', 'd4'].map((i) => Number(noOf(db, 'devices', i).no))).toEqual([1, 2, 3, 4]);
    expect(noOf(db, 'users', 'aa').no_src).toBe('b');
    const snapshot = JSON.stringify(db.prepare('SELECT id, no, no_src FROM users ORDER BY id').all());
    expect(backfillIds(db, 'box')).toEqual({ users: 0, devices: 0 });
    expect(JSON.stringify(db.prepare('SELECT id, no, no_src FROM users ORDER BY id').all())).toBe(snapshot);
    // the next record continues the series
    expect(Number(noOf(db, 'users', createUser(db, { name: 'Haji Osman', roles: ['ajk'] }, 'test', LOCAL_SURAU_ID).id).no)).toBe(4);
  });

  it('[PP-S8] the cloud numbers only the rows of * and of suraus with no primary box; a surau with a primary box waits for it', () => {
    const app = makeApp({ role: 'cloud' });
    const db = app.surau.db;
    ensureSurau(db, 'sdm');
    ensureSurau(db, 'surau-lain', 'Surau Lain Contoh');
    db.prepare("INSERT INTO sites (surau_id, box_id, name, token_hash, linked_at, role) VALUES ('sdm', ?, 'Kotak', 'h', '2026-11-05T00:00:00.000Z', 'primary')").run('ab'.repeat(8));
    rawUser(db, 'u1', 'Kak Siti', '2026-01-01T00:00:00.000Z', 'sdm');
    rawUser(db, 'u2', 'Encik Rahman', '2026-01-02T00:00:00.000Z', 'surau-lain');
    rawUser(db, 'u3', 'Puan Aminah', '2026-01-03T00:00:00.000Z', 'surau-lain');
    rawUser(db, 'u4', 'Haji Osman', '2026-01-04T00:00:00.000Z', '*');
    expect(backfillIds(db, 'cloud')).toEqual({ users: 3, devices: 0 });
    expect(noOf(db, 'users', 'u1').no).toBeNull();
    expect([noOf(db, 'users', 'u2'), noOf(db, 'users', 'u3'), noOf(db, 'users', 'u4')]).toEqual([
      { no: 1, no_src: 'c' }, { no: 2, no_src: 'c' }, { no: 1, no_src: 'c' },
    ]);
  });
});

describe('[PP-S8] allocation', () => {
  it('[PP-S8] a new user on a box gets the next b number, on the cloud a c number; a device the same', async () => {
    const box = makeApp();
    const u = createUser(box.surau.db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', LOCAL_SURAU_ID);
    expect(u.ref).toBe('U-0001');
    expect(u.noSrc).toBe('b');
    const cloud = makeApp({ role: 'cloud' });
    const c = createUser(cloud.surau.db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', 'sdm');
    expect(c.ref).toBe('U-C0001');
    const login = await loginAs(box, 'ajk');
    const dev = box.surau.db.prepare('SELECT no, no_src FROM devices WHERE id = ?').get(login.deviceId);
    expect(dev).toMatchObject({ no_src: 'b' });
    expect(Number(dev?.no)).toBeGreaterThanOrEqual(1);
  });

  it('[PP-S8] the number of a removed record is never issued again; a lowered counter cannot reissue a number a row holds', () => {
    const app = makeApp();
    const db = app.surau.db;
    const a = createUser(db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', LOCAL_SURAU_ID);
    const b = createUser(db, { name: 'Encik Rahman', roles: ['ajk'] }, 'test', LOCAL_SURAU_ID);
    expect([a.no, b.no]).toEqual([1, 2]);
    db.prepare('DELETE FROM users WHERE id = ?').run(b.id); // raw removal: only to prove the counter
    expect(createUser(db, { name: 'Puan Aminah', roles: ['ajk'] }, 'test', LOCAL_SURAU_ID).no).toBe(3);
    db.prepare("UPDATE id_counters SET next = 1 WHERE kind = 'user'").run(); // a counter restored from an old backup
    expect(createUser(db, { name: 'Haji Osman', roles: ['ajk'] }, 'test', LOCAL_SURAU_ID).no).toBe(4);
  });

  it('[PP-S8] rename, role change and deactivation leave the number alone', () => {
    const app = makeApp();
    const db = app.surau.db;
    const u = createUser(db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', LOCAL_SURAU_ID);
    createUser(db, { name: 'Pentadbir Contoh', roles: ['admin'] }, 'test', LOCAL_SURAU_ID);
    db.prepare("UPDATE users SET name = 'Kak Siti binti Ali' WHERE id = ?").run(u.id);
    setRoles(db, u.id, ['ajk', 'media'], 'test');
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(u.id);
    expect(noOf(db, 'users', u.id)).toEqual({ no: 1, no_src: 'b' });
    expect(listUsers(db, LOCAL_SURAU_ID).find((x) => x.id === u.id)?.ref).toBe('U-0001');
  });

  it('[PP-S8] a raw UPDATE to a number another row holds fails on the unique index', () => {
    const app = makeApp();
    const db = app.surau.db;
    const a = createUser(db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', LOCAL_SURAU_ID);
    const b = createUser(db, { name: 'Encik Rahman', roles: ['ajk'] }, 'test', LOCAL_SURAU_ID);
    expect(() => db.prepare('UPDATE users SET no = ? WHERE id = ?').run(a.no, b.id)).toThrow(/UNIQUE/);
  });

  it('[PP-S8] an insert that rolls back leaves no number on a row, and the next number is still above every number on a row', () => {
    const app = makeApp();
    const db = app.surau.db;
    createUser(db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', LOCAL_SURAU_ID);
    db.exec('BEGIN');
    allocateNo(db, LOCAL_SURAU_ID, 'user');
    db.exec('ROLLBACK');
    expect(createUser(db, { name: 'Encik Rahman', roles: ['ajk'] }, 'test', LOCAL_SURAU_ID).no).toBe(2);
  });

  it('[PP-S8] a secondary box (told so by the cloud) creates a user with no number; the cloud issues the C series for any surau', () => {
    const app = makeApp();
    const db = app.surau.db;
    db.prepare("INSERT INTO sync_state (key, value) VALUES ('site_role', 'secondary')").run();
    expect(allocatorFor(db, LOCAL_SURAU_ID)).toBeNull();
    expect(createUser(db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', LOCAL_SURAU_ID).ref).toBeNull();
    db.prepare("UPDATE sync_state SET value = 'primary' WHERE key = 'site_role'").run();
    expect(allocatorFor(db, LOCAL_SURAU_ID)).toBe('b');
    expect(allocatorFor(db, '*')).toBeNull();
    expect(allocatorFor(makeApp({ role: 'cloud' }).surau.db, 'surau-lain')).toBe('c');
  });

  it('[PP-S8] raiseCounters lifts the next number above the cloud maxNo', () => {
    const app = makeApp();
    const db = app.surau.db;
    raiseCounters(db, LOCAL_SURAU_ID, { user: 40, device: 0 });
    expect(createUser(db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', LOCAL_SURAU_ID).no).toBe(41);
  });
});

describe('[PP-S8] settleIncomingNo on the cloud', () => {
  it('[PP-S8] keeps a number a row has, takes a b number only from the primary site, refuses a taken one, gives a c number otherwise', () => {
    const app = makeApp({ role: 'cloud' });
    const db = app.surau.db;
    ensureSurau(db, 'sdm');
    rawUser(db, 'x', 'Kak Siti', '2026-01-01T00:00:00.000Z', 'sdm');
    rawUser(db, 'y', 'Encik Rahman', '2026-01-02T00:00:00.000Z', 'sdm');
    rawUser(db, 'z', 'Puan Aminah', '2026-01-03T00:00:00.000Z', 'sdm');
    const row = (id: string) => ({ kind: 'user' as const, id, surauId: 'sdm' });
    expect(settleIncomingNo(db, row('x'), { no: 7, src: 'b' }, true)).toBe('kept');
    expect(noOf(db, 'users', 'x')).toEqual({ no: 7, no_src: 'b' });
    expect(settleIncomingNo(db, row('x'), { no: 9, src: 'b' }, true)).toBe('kept'); // an ID never changes
    expect(noOf(db, 'users', 'x').no).toBe(7);
    expect(settleIncomingNo(db, row('y'), { no: 7, src: 'b' }, true)).toBe('id_taken');
    expect(noOf(db, 'users', 'y').no).toBeNull();
    expect(settleIncomingNo(db, row('y'), { no: 8, src: 'b' }, false)).toBe('assigned'); // not the primary site
    expect(noOf(db, 'users', 'y')).toEqual({ no: 1, no_src: 'c' });
    expect(settleIncomingNo(db, row('z'), { no: 3, src: 'c' }, true)).toBe('assigned'); // a site never sets a c number
    expect(noOf(db, 'users', 'z')).toEqual({ no: 2, no_src: 'c' });
  });
});

describe('[PP-S8] the ID is a label, never a credential', () => {
  it('[PP-S8] an ID in place of an id answers 404; as an enrolment code or a bearer token it is refused like any wrong value', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const ref = String(listUsers(app.surau.db, LOCAL_SURAU_ID).find((u) => u.id === ajk.userId)?.ref);
    expect(ref).toMatch(/^U-\d{4}$/);
    expect((await app.inject({ method: 'PUT', url: `/api/users/${ref}/name`, headers: admin.headers, payload: { name: 'Kak Siti' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/users/${ref}/unlock`, headers: admin.headers, payload: {} })).statusCode).toBe(404);
    const devRef = String(app.surau.db.prepare('SELECT no FROM devices WHERE id = ?').get(ajk.deviceId)?.no);
    expect((await app.inject({ method: 'POST', url: `/api/devices/D-${devRef.padStart(4, '0')}/revoke`, headers: admin.headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${ref}` } })).statusCode).toBe(401);
    const enrol = await app.inject({ method: 'POST', url: '/api/enrol/complete', remoteAddress: '10.99.1.1', payload: { code: ref, publicJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' }, platform: 'web', pin: '482916' } });
    expect(enrol.statusCode).toBeGreaterThanOrEqual(400);
    expect(enrol.statusCode).toBeLessThan(500);
  });
});

describe('[PP-S8] the ID on every answer', () => {
  it('[PP-S8][PP-GC] users, devices, me, activity, enrol and audit carry ref; audit carries actorRef and entityRef; a star record never reaches a surau session', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const star = await loginAs(app, 'superadmin');
    const db = app.surau.db;
    const userRef = (id: string): string => String(listUsers(db, LOCAL_SURAU_ID, true).find((u) => u.id === id)?.ref);
    const users = (await app.inject({ method: 'GET', url: '/api/users', headers: admin.headers })).json().users as Array<{ id: string; ref: string }>;
    expect(users.find((u) => u.id === ajk.userId)?.ref).toBe(userRef(ajk.userId));
    const devices = (await app.inject({ method: 'GET', url: '/api/devices', headers: admin.headers })).json().devices as Array<{ id: string; ref: string }>;
    expect(devices.find((d) => d.id === ajk.deviceId)?.ref).toMatch(/^D-\d{4}$/);
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: ajk.headers })).json();
    expect(me.user.ref).toBe(userRef(ajk.userId));
    expect(me.device.ref).toMatch(/^D-\d{4}$/);
    const act = (await app.inject({ method: 'GET', url: '/api/people/activity', headers: admin.headers })).json();
    expect(act.users.find((u: { id: string }) => u.id === ajk.userId).ref).toBe(userRef(ajk.userId));
    // an audit row about the ajk user, made by the admin
    await app.inject({ method: 'PUT', url: `/api/users/${ajk.userId}/name`, headers: admin.headers, payload: { name: 'Kak Siti binti Ali' } });
    const audit = (await app.inject({ method: 'GET', url: '/api/audit?entity=users', headers: admin.headers })).json().entries as Array<{ actor: string; entityId: string; actorRef: string | null; entityRef: string | null }>;
    const row = audit.find((e) => e.entityId === ajk.userId && e.actor === `user:${admin.userId}`);
    expect(row?.actorRef).toBe(userRef(admin.userId));
    expect(row?.entityRef).toBe(userRef(ajk.userId));
    // the star user's ID never reaches a surau session
    const starRef = userRef(star.userId);
    for (const url of ['/api/users', '/api/devices', '/api/people/activity', '/api/audit', '/api/finance/audit']) {
      const text = (await app.inject({ method: 'GET', url, headers: admin.headers })).body;
      expect(text, url).not.toContain(`"${starRef}"`);
      expect(text, url).not.toContain('globalRef');
    }
  });

  it('[PP-S8] an ops session gets the long form on the cloud: <surau>/U-C0001, maxcom/U-C0002', async () => {
    const app = makeApp({ role: 'cloud' });
    ensureSurau(app.surau.db, 'sdm');
    const star = await loginAs(app, 'superadmin');
    const ajk = createUser(app.surau.db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', 'sdm');
    backfillIds(app.surau.db, 'cloud'); // the test login filed the account under * by hand: the cloud numbers it at start
    const users = (await app.inject({ method: 'GET', url: '/api/users', headers: star.headers })).json().users as Array<{ id: string; globalRef: string | null }>;
    expect(users.find((u) => u.id === ajk.id)?.globalRef).toMatch(/^sdm\/U-C\d{4}$/);
    expect(users.find((u) => u.id === star.userId)?.globalRef).toMatch(/^maxcom\/U-C\d{4}$/);
    const devs = (await app.inject({ method: 'GET', url: '/api/devices', headers: star.headers })).json().devices as Array<{ id: string; globalRef: string | null }>;
    expect(devs.find((d) => d.id === star.deviceId)?.globalRef).toMatch(/^maxcom\/D-C\d{4}$/);
  });

  it('[PP-S8] finance history keeps the ID beside each name, even for an entry stored before IDs existed', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'treasurer');
    const db = app.surau.db;
    db.prepare("UPDATE users SET no = NULL, no_src = NULL WHERE id = ?").run(admin.userId);
    const { entryNamesOf } = await import('../src/finance/store.ts');
    // with no number yet the names carry a null ref, then the number arrives and the read fills it
    expect(entryNamesOf(db, admin.userId, admin.deviceId, null).createdByRef).toBeNull();
    backfillIds(db, 'box');
    const names = entryNamesOf(db, admin.userId, admin.deviceId, null);
    expect(names.createdByRef).toMatch(/^U-\d{4}$/);
    expect(names.deviceRef).toMatch(/^D-\d{4}$/);
  });
});

describe('[PP-S8] CLI', () => {
  it('[PP-S8] list prints the long form, --ref selects exactly one record, check-ids passes then fails on a planted duplicate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-s8cli-'));
    dirs.push(dir);
    const db = join(dir, 'cli.db');
    const app = buildApp(db, { dataDir: dir });
    createUser(app.surau.db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', LOCAL_SURAU_ID);
    createUser(app.surau.db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', LOCAL_SURAU_ID);
    createUser(app.surau.db, { name: 'Encik Rahman', roles: ['ajk'] }, 'test', LOCAL_SURAU_ID);
    await app.close();
    const lines: string[] = [];
    const run = (args: string[]) => runUsersCli(['--db', db, ...args], { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) });
    expect(await run(['list'])).toBe(0);
    expect(lines.join('\n')).toMatch(new RegExp(`${LOCAL_SURAU_ID}/U-0001`));
    expect(lines.join('\n')).toMatch(new RegExp(`${LOCAL_SURAU_ID}/U-0002`));
    lines.length = 0;
    expect(await run(['check-ids'])).toBe(0);
    // two people with the same name are told apart by --ref (promote-superadmin refuses a name that matches two)
    lines.length = 0;
    expect(await run(['promote-superadmin', '--name', 'Kak Siti'])).not.toBe(0);
    lines.length = 0;
    expect(await run(['promote-superadmin', '--ref', 'U-0002'])).toBe(0);
    expect(lines.join('\n')).toContain('kini Pentadbir MAXCOM');
    // plant a duplicate: drop the index, copy a number
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(db);
    raw.exec('DROP INDEX ux_users_no');
    raw.exec("UPDATE users SET no = 1, no_src = 'b' WHERE name = 'Encik Rahman'");
    raw.close();
    lines.length = 0;
    expect(await run(['check-ids'])).toBe(1);
    expect(lines.join('\n')).toContain('dipegang 2 rekod');
    expect(checkIds).toBeTypeOf('function');
  });
});
