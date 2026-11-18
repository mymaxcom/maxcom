import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { isIdleDevice, peopleActivity } from '../src/auth/activity.ts';
import { createUser } from '../src/auth/users.ts';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';
import { loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeApp(opts: Parameters<typeof buildApp>[1] = {}): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-s6-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'), { dataDir: dir, ...opts });
  apps.push(app);
  return app;
}

const NOW = new Date('2026-11-18T08:00:00.000Z');
const daysAgo = (n: number, from: Date = NOW): string => new Date(from.getTime() - n * 86_400_000).toISOString();
const DAY = 86_400_000;

const setSeen = (db: DatabaseSync, deviceId: string, seen: string | null, enrolled?: string): void => {
  db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(seen, deviceId);
  if (enrolled !== undefined) db.prepare('UPDATE devices SET enrolled_at = ? WHERE id = ?').run(enrolled, deviceId);
};
const setCreated = (db: DatabaseSync, userId: string, at: string): void => {
  db.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(at, userId);
};
const revokedAt = (db: DatabaseSync, deviceId: string): unknown => db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(deviceId)?.revoked_at;
/** Test users have no phone number, which is its own need (`phone`); the other needs are what these rows check. */
const act = (db: DatabaseSync, role: 'box' | 'cloud' = 'box', star = false) => {
  const r = peopleActivity(db, LOCAL_SURAU_ID, NOW, role, star);
  return { ...r, users: r.users.map((u) => ({ ...u, needs: u.needs.filter((n) => n !== 'phone') })) };
};
const revokeInactive = (app: FastifyInstance, by: Login, ids: unknown) =>
  app.inject({ method: 'POST', url: '/api/devices/revoke-inactive', headers: by.headers, payload: { ids } });

async function addTv(app: FastifyInstance, admin: Login, name = 'TV surau'): Promise<string> {
  const b = (await app.inject({ method: 'POST', url: '/api/kiosk/pair/begin', remoteAddress: '10.168.1.77' })).json() as { code: string };
  const ap = await app.inject({ method: 'POST', url: '/api/kiosk/pair/approve', remoteAddress: '10.9.9.9', headers: admin.headers, payload: { code: b.code, deviceName: name } });
  expect(ap.statusCode, ap.body).toBe(200);
  return String(ap.json().deviceId);
}

describe('[PP-S6b] activity flags are computed on the server', () => {
  it('[PP-S6b] a phone seen 59 days ago is not inactive, 60 days is', async () => {
    const app = makeApp();
    const a = await loginAs(app, 'ajk');
    const db = app.surau.db;
    setSeen(db, a.deviceId, daysAgo(59, NOW));
    expect(act(db).devices.find((d) => d.id === a.deviceId)).toMatchObject({ kind: 'device', idleDays: 59, inactive: false });
    setSeen(db, a.deviceId, daysAgo(60, NOW));
    expect(act(db).devices.find((d) => d.id === a.deviceId)).toMatchObject({ idleDays: 60, inactive: true });
  });

  it('[PP-S6b] a TV is inactive at 30 days, not at 29', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const tv = await addTv(app, admin);
    const db = app.surau.db;
    setSeen(db, tv, daysAgo(29, NOW));
    expect(act(db).devices.find((d) => d.id === tv)).toMatchObject({ kind: 'tv', idleDays: 29, inactive: false });
    setSeen(db, tv, daysAgo(30, NOW));
    expect(act(db).devices.find((d) => d.id === tv)).toMatchObject({ kind: 'tv', idleDays: 30, inactive: true });
  });

  it('[PP-S6b] a phone never seen counts from its enrolment date', async () => {
    const app = makeApp();
    const a = await loginAs(app, 'ajk');
    setSeen(app.surau.db, a.deviceId, null, daysAgo(61, NOW));
    expect(act(app.surau.db).devices.find((d) => d.id === a.deviceId)).toMatchObject({ lastSeenAt: null, idleDays: 61, inactive: true });
    expect(isIdleDevice({ platform: 'android', enrolledAt: daysAgo(61, NOW), lastSeenAt: null }, NOW)).toBe(true);
    expect(isIdleDevice({ platform: 'android', enrolledAt: daysAgo(59, NOW), lastSeenAt: null }, NOW)).toBe(false);
  });

  it('[PP-S6b] a user added 2 days ago with no phone has no need, at 3 days has no_device', async () => {
    const app = makeApp();
    const db = app.surau.db;
    const u = createUser(db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', LOCAL_SURAU_ID);
    setCreated(db, u.id, daysAgo(2, NOW));
    expect(act(db).users.find((x) => x.id === u.id)).toMatchObject({ deviceCount: 0, needs: [] });
    setCreated(db, u.id, daysAgo(3, NOW));
    expect(act(db).users.find((x) => x.id === u.id)?.needs).toEqual(['no_device']);
  });

  it('[PP-S6b] a locked user has locked; an expired lock does not', async () => {
    const app = makeApp();
    const a = await loginAs(app, 'ajk');
    const db = app.surau.db;
    db.prepare('UPDATE users SET pin_locked_until = ? WHERE id = ?').run(new Date(NOW.getTime() + 900_000).toISOString(), a.userId);
    const row = act(db).users.find((x) => x.id === a.userId);
    expect(row).toMatchObject({ locked: true, needs: ['locked'] });
    expect(row?.pinLockedUntil).not.toBeNull();
    db.prepare('UPDATE users SET pin_locked_until = ? WHERE id = ?').run(new Date(NOW.getTime() - 1000).toISOString(), a.userId);
    expect(act(db).users.find((x) => x.id === a.userId)).toMatchObject({ locked: false, needs: [], pinLockedUntil: null });
  });

  it('[PP-S6b] suggestDeactivate only when every phone is idle 90 days, and never for the last Pentadbir', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const db = app.surau.db;
    setSeen(db, ajk.deviceId, daysAgo(89, NOW));
    expect(act(db).users.find((x) => x.id === ajk.userId)?.suggestDeactivate).toBe(false);
    setSeen(db, ajk.deviceId, daysAgo(90, NOW));
    expect(act(db).users.find((x) => x.id === ajk.userId)?.suggestDeactivate).toBe(true);
    // a second phone used today ends the suggestion
    const second = await loginAs(app, 'ajk');
    db.prepare('UPDATE devices SET user_id = ? WHERE id = ?').run(ajk.userId, second.deviceId);
    setSeen(db, second.deviceId, daysAgo(1, NOW));
    expect(act(db).users.find((x) => x.id === ajk.userId)?.suggestDeactivate).toBe(false);
    // the last Pentadbir is never suggested
    setSeen(db, admin.deviceId, daysAgo(400, NOW));
    expect(act(db).users.find((x) => x.id === admin.userId)?.suggestDeactivate).toBe(false);
    // a TV never counts as the person's phone
    expect(act(db).users.find((x) => x.id === admin.userId)?.deviceCount).toBe(1);
  });

  it('[PP-S6b] the cloud role blanks every flag and lastSeenAt but still fills needs', async () => {
    const app = makeApp({ role: 'cloud' });
    const a = await loginAs(app, 'ajk');
    const db = app.surau.db;
    setSeen(db, a.deviceId, daysAgo(500, NOW));
    const u = createUser(db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', LOCAL_SURAU_ID);
    setCreated(db, u.id, daysAgo(10, NOW));
    const r = act(db, 'cloud');
    expect(r.authority).toBe('cloud');
    expect(r.devices.find((d) => d.id === a.deviceId)).toMatchObject({ lastSeenAt: null, inactive: false });
    expect(r.users.every((x) => x.suggestDeactivate === false && x.lastActiveAt === null)).toBe(true);
    expect(r.users.find((x) => x.id === u.id)?.needs).toEqual(['no_device']);
  });

  it('[PP-S6b] GET /api/people/activity answers the server clock, no-store, to a Pentadbir only', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const treasurer = await loginAs(app, 'treasurer');
    const r = await app.inject({ method: 'GET', url: '/api/people/activity', headers: admin.headers });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const j = r.json();
    expect(j.authority).toBe('box');
    expect(j.limits).toEqual({ deviceDays: 60, tvDays: 30, noDeviceDays: 3, userDays: 90, deactivatedDays: 365 });
    expect(Math.abs(Date.parse(j.now) - Date.now())).toBeLessThan(60_000);
    expect(j.devices.some((d: { id: string }) => d.id === admin.deviceId)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/people/activity', headers: treasurer.headers })).statusCode).toBe(403);
  });

  it('[PP-S6b] a Pentadbir MAXCOM user and device are absent for a surau session, present for the ops view; other suraus never appear', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const star = await loginAs(app, 'superadmin');
    const db = app.surau.db;
    const other = createUser(db, { name: 'Encik Rahman', roles: ['ajk'] }, 'test', 'surau-lain');
    const surau = (await app.inject({ method: 'GET', url: '/api/people/activity', headers: admin.headers })).json();
    expect(surau.users.some((u: { id: string }) => u.id === star.userId)).toBe(false);
    expect(surau.devices.some((d: { id: string }) => d.id === star.deviceId)).toBe(false);
    expect(surau.users.some((u: { id: string }) => u.id === other.id)).toBe(false);
    expect(act(db, 'box', true).users.some((u) => u.id === star.userId)).toBe(true);
    expect(act(db, 'box', true).users.some((u) => u.id === other.id)).toBe(false);
  });

  it('[PP-S6b] revoked devices and deactivated users are left out; createdByName names the creator', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const db = app.surau.db;
    const made = createUser(db, { name: 'Haji Osman', roles: ['ajk'] }, `user:${admin.userId}`, LOCAL_SURAU_ID);
    const adminName = String(db.prepare('SELECT name FROM users WHERE id = ?').get(admin.userId)?.name);
    expect(act(db).users.find((x) => x.id === made.id)?.createdByName).toBe(adminName);
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(NOW.toISOString(), ajk.deviceId);
    expect(act(db).devices.some((d) => d.id === ajk.deviceId)).toBe(false);
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(ajk.userId);
    expect(act(db).users.some((x) => x.id === ajk.userId)).toBe(false);
  });
});

describe('[PP-S6] one-tap removal re-checks every device', () => {
  it('[PP-S6] one idle phone is revoked; a phone seen today and the caller own idle phone are skipped with reasons', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const idle = await loginAs(app, 'ajk');
    const busy = await loginAs(app, 'treasurer');
    const db = app.surau.db;
    const real = Date.now();
    setSeen(db, idle.deviceId, new Date(real - 61 * DAY).toISOString());
    setSeen(db, busy.deviceId, new Date(real - 1000).toISOString());
    setSeen(db, admin.deviceId, new Date(real - 400 * DAY).toISOString());
    const r = await revokeInactive(app, admin, [idle.deviceId, busy.deviceId, admin.deviceId]);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().revoked).toEqual([idle.deviceId]);
    expect(r.json().skipped).toEqual([
      { id: busy.deviceId, reason: 'in_use' },
      { id: admin.deviceId, reason: 'own_device' },
    ]);
    expect(revokedAt(db, idle.deviceId)).not.toBeNull();
    expect(revokedAt(db, busy.deviceId)).toBeNull();
    expect(revokedAt(db, admin.deviceId)).toBeNull();
    const row = db.prepare("SELECT actor FROM change_log WHERE entity = 'devices' AND entity_id = ? AND after_json LIKE '%\"revoked\":true%'").get(idle.deviceId);
    expect(row?.actor).toBe(`user:${admin.userId}`);
  });

  it('[PP-S6] a TV is skipped even when it is idle', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const tv = await addTv(app, admin);
    setSeen(app.surau.db, tv, new Date(Date.now() - 400 * DAY).toISOString());
    const r = await revokeInactive(app, admin, [tv]);
    expect(r.json()).toEqual({ revoked: [], skipped: [{ id: tv, reason: 'is_tv' }] });
    expect(revokedAt(app.surau.db, tv)).toBeNull();
  });

  it('[PP-S6] the last Pentadbir phone is skipped even when idle', async () => {
    const app = makeApp();
    const caller = await loginAs(app, 'admin');
    const only = await loginAs(app, 'admin');
    const db = app.surau.db;
    // with two Pentadbir phones the idle one goes
    const spare = await loginAs(app, 'admin');
    setSeen(db, spare.deviceId, new Date(Date.now() - 300 * DAY).toISOString());
    expect((await revokeInactive(app, caller, [spare.deviceId])).json().revoked).toEqual([spare.deviceId]);
    // the caller's phone is moved out of the surau (the live session still works): `only` is the last Pentadbir phone counted
    db.prepare('UPDATE devices SET surau_id = ? WHERE id = ?').run('surau-lain', caller.deviceId);
    setSeen(db, only.deviceId, new Date(Date.now() - 300 * DAY).toISOString());
    const r = await revokeInactive(app, caller, [only.deviceId]);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ revoked: [], skipped: [{ id: only.deviceId, reason: 'last_admin_device' }] });
    expect(revokedAt(db, only.deviceId)).toBeNull();
  });

  it('[PP-S6] an unknown id and a Pentadbir MAXCOM device are not_found, the star one logged', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const star = await loginAs(app, 'superadmin');
    const db = app.surau.db;
    setSeen(db, star.deviceId, new Date(Date.now() - 400 * DAY).toISOString());
    const n0 = Number(db.prepare("SELECT COUNT(*) AS n FROM auth_log WHERE event = 'star_target_refused'").get()?.n);
    const r = await revokeInactive(app, admin, ['nope', star.deviceId]);
    expect(r.json()).toEqual({ revoked: [], skipped: [{ id: 'nope', reason: 'not_found' }, { id: star.deviceId, reason: 'not_found' }] });
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM auth_log WHERE event = 'star_target_refused'").get()?.n) - n0).toBe(1);
    expect(revokedAt(db, star.deviceId)).toBeNull();
  });

  it('[PP-S6] 51 ids, no ids, a non-array and a non-string id answer 400; a Bendahari gets 403', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const treasurer = await loginAs(app, 'treasurer');
    expect((await revokeInactive(app, admin, Array.from({ length: 51 }, (_, i) => `d${i}`))).statusCode).toBe(400);
    expect((await revokeInactive(app, admin, Array.from({ length: 50 }, (_, i) => `d${i}`))).statusCode).toBe(200);
    expect((await revokeInactive(app, admin, [])).statusCode).toBe(400);
    expect((await revokeInactive(app, admin, 'x')).statusCode).toBe(400);
    expect((await revokeInactive(app, admin, [7])).statusCode).toBe(400);
    expect((await revokeInactive(app, treasurer, ['x'])).statusCode).toBe(403);
  });

  it('[PP-S6] the cloud answers 409 box_only', async () => {
    const app = makeApp({ role: 'cloud' });
    const admin = await loginAs(app, 'admin');
    const a = await loginAs(app, 'ajk');
    setSeen(app.surau.db, a.deviceId, daysAgo(500, new Date()));
    const r = await revokeInactive(app, admin, [a.deviceId]);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('box_only');
    expect(revokedAt(app.surau.db, a.deviceId)).toBeNull();
  });

  it('[PP-GC] a Pentadbir MAXCOM id answers like an unknown id on the activity and removal routes', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const star = await loginAs(app, 'superadmin');
    const act2 = (await app.inject({ method: 'GET', url: '/api/people/activity', headers: admin.headers })).json();
    expect(JSON.stringify(act2)).not.toContain(star.userId);
    expect(JSON.stringify(act2)).not.toContain(star.deviceId);
  });
});

describe('[CL-2] server fields for the people screens', () => {
  it('[CL-2] /api/users carries deactivatedAt: null while active, the instant once deactivated, null again after Aktifkan semula', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const list = async (): Promise<Array<{ id: string; deactivatedAt?: string | null }>> =>
      (await app.inject({ method: 'GET', url: '/api/users', headers: admin.headers })).json().users;
    expect((await list()).find((u) => u.id === ajk.userId)?.deactivatedAt).toBeNull();
    const at = '2026-10-01T03:00:00.000Z';
    app.surau.db.prepare('UPDATE users SET active = 0, deactivated_at = ? WHERE id = ?').run(at, ajk.userId);
    expect((await list()).find((u) => u.id === ajk.userId)?.deactivatedAt).toBe(at);
    app.surau.db.prepare('UPDATE users SET active = 1, deactivated_at = NULL WHERE id = ?').run(ajk.userId);
    expect((await list()).find((u) => u.id === ajk.userId)?.deactivatedAt).toBeNull();
  });

  it('[CL-2] the activity user row carries createdByRef (the adder ID), null for system, and the limits state the 365 days', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const db = app.surau.db;
    const made = createUser(db, { name: 'Haji Osman', roles: ['ajk'] }, `user:${admin.userId}`, LOCAL_SURAU_ID);
    const sys = createUser(db, { name: 'Encik Rahman', roles: ['ajk'] }, 'system', LOCAL_SURAU_ID);
    const adminRef = db.prepare('SELECT no FROM users WHERE id = ?').get(admin.userId)?.no;
    const r = act(db);
    expect(r.users.find((x) => x.id === made.id)?.createdByRef).toBe(`U-${String(adminRef).padStart(4, '0')}`);
    expect(r.users.find((x) => x.id === sys.id)?.createdByRef).toBeNull();
    expect(r.limits.deactivatedDays).toBe(365);
  });
});
