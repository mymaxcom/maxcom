import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeedEntry } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { beginEnrolment } from '../src/auth/devices.ts';
import { createUser } from '../src/auth/users.ts';
import { putFeature } from '../src/settingsStore.ts';
import { applyFeedEntry } from '../src/sync/apply.ts';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';
import { loginAs, TEST_PIN } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeApp(): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-s4-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'), { dataDir: dir });
  apps.push(app);
  return app;
}

let ipN = 0;
/** One unlock attempt with a chosen PIN (the real challenge and signature), from a fresh client address. */
async function unlockWith(app: FastifyInstance, l: Login, pin: string): Promise<{ status: number; code?: string }> {
  const remoteAddress = `10.77.${(++ipN >> 8) & 255}.${ipN & 255}`;
  const ch = await app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress, payload: { deviceId: l.deviceId } });
  const nonce = String(ch.json().nonce);
  const message = new TextEncoder().encode(`surau-unlock\n${app.surau.boxId}\n${l.deviceId}\n${nonce}`);
  const signature = await l.sign(message);
  const r = await app.inject({ method: 'POST', url: '/api/auth/unlock', remoteAddress, payload: { deviceId: l.deviceId, nonce, signature, pin } });
  return { status: r.statusCode, code: r.json().code as string | undefined };
}

const unlockRoute = (app: FastifyInstance, by: Login, id: string) => app.inject({ method: 'POST', url: `/api/users/${id}/unlock`, headers: by.headers, payload: {} });
const activateRoute = (app: FastifyInstance, by: Login, id: string) => app.inject({ method: 'POST', url: `/api/users/${id}/activate`, headers: by.headers, payload: {} });
const revokeRoute = (app: FastifyInstance, by: Login, deviceId: string) => app.inject({ method: 'POST', url: `/api/devices/${deviceId}/revoke`, headers: by.headers });
const pinReset = (app: FastifyInstance, by: Login, id: string, revokeDeviceIds: string[]) =>
  app.inject({ method: 'PUT', url: `/api/users/${id}/pin`, headers: by.headers, payload: { revokeDeviceIds } });
const deactivateRoute = (app: FastifyInstance, by: Login, id: string) => app.inject({ method: 'POST', url: `/api/users/${id}/deactivate`, headers: by.headers, payload: {} });

const revokedAt = (db: DatabaseSync, deviceId: string): unknown => db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(deviceId)?.revoked_at;
const userRow = (db: DatabaseSync, id: string): Record<string, unknown> => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown>;
const usersLogCount = (db: DatabaseSync, id: string): number =>
  Number(db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'users' AND entity_id = ?").get(id)?.n);

describe('[PP-S4] Buka kunci', () => {
  it('[PP-S4] a locked user is unlocked; unlock clears the lock and the SAME PIN works', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const db = app.surau.db;
    putFeature(db, 'appLock', { enabled: true }, 'test', undefined, LOCAL_SURAU_ID);
    const hashBefore = userRow(db, ajk.userId).pin_hash;
    expect((await unlockWith(app, ajk, '135790')).status).toBe(401);
    // the state five wrong PINs leave behind (the unlock limiter would answer 429 before a fifth real attempt)
    db.prepare('UPDATE users SET pin_fail_count = 5, pin_locked_until = ?, lock_round = 1 WHERE id = ?').run(new Date(Date.now() + 900_000).toISOString(), ajk.userId);
    expect((await unlockWith(app, ajk, TEST_PIN)).status).toBe(423);
    expect(userRow(db, ajk.userId).pin_locked_until).not.toBeNull();
    const n = usersLogCount(db, ajk.userId);

    const r = await unlockRoute(app, admin, ajk.userId);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(userRow(db, ajk.userId)).toMatchObject({ pin_fail_count: 0, pin_locked_until: null, lock_round: 0, pin_hash: hashBefore });
    expect(usersLogCount(db, ajk.userId)).toBe(n + 1);
    const last = db.prepare("SELECT after_json FROM change_log WHERE entity = 'users' AND entity_id = ? ORDER BY id DESC LIMIT 1").get(ajk.userId);
    expect(JSON.parse(String(last?.after_json)).pinUnlocked).toBe(true);
    expect(JSON.stringify(last)).not.toContain(String(hashBefore));
    expect(db.prepare("SELECT ok FROM auth_log WHERE event = 'pin_unlock' AND user_id = ?").get(ajk.userId)).toBeDefined();
    // the PIN did not change: the same one unlocks, and the user still needs a PIN
    expect((await unlockWith(app, ajk, TEST_PIN)).status).toBe(200);
    const list = (await app.inject({ method: 'GET', url: '/api/users', headers: admin.headers })).json().users as Array<{ id: string; pinRequired: boolean }>;
    expect(list.find((u) => u.id === ajk.userId)?.pinRequired).toBe(false);
  });

  it('[PP-S4] unlocking a user who is not locked answers 200 and writes no log row', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const n = usersLogCount(app.surau.db, ajk.userId);
    expect((await unlockRoute(app, admin, ajk.userId)).json()).toEqual({ ok: true });
    expect(usersLogCount(app.surau.db, ajk.userId)).toBe(n);
  });

  it('[PP-S4] unlock of a Pentadbir MAXCOM or an unknown id is 404 (star logged); a Bendahari gets 403', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const treasurer = await loginAs(app, 'treasurer');
    const star = await loginAs(app, 'superadmin');
    const db = app.surau.db;
    db.prepare('UPDATE users SET pin_fail_count = 3 WHERE id = ?').run(star.userId);
    const logged = (): number => Number(db.prepare("SELECT COUNT(*) AS n FROM auth_log WHERE event = 'star_target_refused'").get()?.n);
    const n0 = logged();
    expect((await unlockRoute(app, admin, star.userId)).statusCode).toBe(404);
    expect(logged() - n0).toBe(1);
    expect(userRow(db, star.userId).pin_fail_count).toBe(3);
    expect((await unlockRoute(app, admin, 'nope')).statusCode).toBe(404);
    expect((await unlockRoute(app, treasurer, star.userId)).statusCode).toBe(403);
  });
});

describe('[PP-S4] Aktifkan semula', () => {
  it('[PP-S4] brings a deactivated user back with zero live devices, clears deactivated_at, and a new code can be made', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const db = app.surau.db;
    expect((await deactivateRoute(app, admin, ajk.userId)).statusCode).toBe(200);
    db.prepare('UPDATE users SET deactivated_at = ? WHERE id = ?').run('2026-10-01T00:00:00.000Z', ajk.userId);
    expect(revokedAt(db, ajk.deviceId)).not.toBeNull();
    const r = await activateRoute(app, admin, ajk.userId);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ id: ajk.userId, active: true });
    expect(userRow(db, ajk.userId)).toMatchObject({ active: 1, deactivated_at: null });
    expect(revokedAt(db, ajk.deviceId)).not.toBeNull();
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND revoked_at IS NULL').get(ajk.userId)?.n)).toBe(0);
    const code = beginEnrolment(db, { userId: ajk.userId, deviceName: 'Telefon Baru' }, `user:${admin.userId}`, { canManageSuperadmin: false });
    expect(code.code).toBeTruthy();
    const row = db.prepare("SELECT after_json FROM change_log WHERE entity = 'users' AND entity_id = ? ORDER BY id DESC LIMIT 1").get(ajk.userId);
    expect(JSON.parse(String(row?.after_json))).toMatchObject({ id: ajk.userId, active: true });
  });

  it('[PP-S4] activating an active user is a no-op with no log row', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const n = usersLogCount(app.surau.db, ajk.userId);
    const r = await activateRoute(app, admin, ajk.userId);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: ajk.userId, active: true });
    expect(usersLogCount(app.surau.db, ajk.userId)).toBe(n);
  });

  it('[PP-S4] a Pentadbir MAXCOM or an unknown id is 404; a Bendahari gets 403', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const treasurer = await loginAs(app, 'treasurer');
    const star = await loginAs(app, 'superadmin');
    const db = app.surau.db;
    const logged = (): number => Number(db.prepare("SELECT COUNT(*) AS n FROM auth_log WHERE event = 'star_target_refused'").get()?.n);
    const n0 = logged();
    expect((await activateRoute(app, admin, star.userId)).statusCode).toBe(404);
    expect(logged() - n0).toBe(1);
    expect((await activateRoute(app, admin, 'nope')).statusCode).toBe(404);
    expect((await activateRoute(app, treasurer, star.userId)).statusCode).toBe(403);
  });

  it('[PP-S4] a reactivation that arrives through sync also clears deactivated_at', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const db = app.surau.db;
    await deactivateRoute(app, admin, ajk.userId);
    db.prepare('UPDATE users SET deactivated_at = ? WHERE id = ?').run('2026-10-01T00:00:00.000Z', ajk.userId);
    const at = new Date(Date.now() + 60_000).toISOString();
    const entry: FeedEntry = {
      seq: 1, entity: 'user', entityId: ajk.userId, rev: `${at}|dev-x`, editedAt: at, syncedAt: at, actor: 'user:x', deviceId: null, origin: 'local', opId: null,
      after: { id: ajk.userId, name: String(userRow(db, ajk.userId).name), roles: ['ajk'], active: true },
    };
    expect(applyFeedEntry(db, entry, { surauId: LOCAL_SURAU_ID, now: new Date(Date.now() + 3600_000), origin: 'box:b1', actor: 'user:x', dataDir: tmpdir() }).status).toBe('applied');
    expect(userRow(db, ajk.userId)).toMatchObject({ active: 1, deactivated_at: null });
  });
});

describe('[PP-S4] the last Pentadbir phone can never be removed', () => {
  it('[PP-S4] revoking the only Pentadbir phone answers 409 last_admin_device and the device stays live', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const r = await revokeRoute(app, admin, admin.deviceId);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('last_admin_device');
    expect(revokedAt(app.surau.db, admin.deviceId)).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: admin.headers })).statusCode).toBe(200);
    expect(Number(app.surau.db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'devices' AND entity_id = ? AND after_json LIKE '%\"revoked\":true%'").get(admin.deviceId)?.n)).toBe(0);
  });

  it('[PP-S4] with two Pentadbir phones the first revoke works and the second is refused', async () => {
    const app = makeApp();
    const a = await loginAs(app, 'admin');
    const b = await loginAs(app, 'admin');
    expect((await revokeRoute(app, a, b.deviceId)).statusCode).toBe(200);
    expect(revokedAt(app.surau.db, b.deviceId)).not.toBeNull();
    const r = await revokeRoute(app, a, a.deviceId);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('last_admin_device');
    expect(revokedAt(app.surau.db, a.deviceId)).toBeNull();
  });

  it('[PP-S4] a Pentadbir with no phone does not count: removing the other Pentadbir phone is refused', async () => {
    const app = makeApp();
    const a = await loginAs(app, 'admin');
    createUser(app.surau.db, { name: 'Haji Osman', roles: ['admin'] }, 'test', LOCAL_SURAU_ID);
    expect((await revokeRoute(app, a, a.deviceId)).statusCode).toBe(409);
    expect(revokedAt(app.surau.db, a.deviceId)).toBeNull();
  });

  it('[PP-S4] a TV or a Bendahari phone is never refused', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const treasurer = await loginAs(app, 'treasurer');
    expect((await revokeRoute(app, admin, treasurer.deviceId)).statusCode).toBe(200);
    const b = (await app.inject({ method: 'POST', url: '/api/kiosk/pair/begin', remoteAddress: '10.168.1.77' })).json() as { code: string };
    const ap = await app.inject({ method: 'POST', url: '/api/kiosk/pair/approve', remoteAddress: '10.9.9.9', headers: admin.headers, payload: { code: b.code, deviceName: 'TV surau' } });
    expect(ap.statusCode, ap.body).toBe(200);
    expect((await revokeRoute(app, admin, String(ap.json().deviceId))).statusCode).toBe(200);
    expect(revokedAt(app.surau.db, admin.deviceId)).toBeNull();
  });

  it('[PP-S4] a surau that already has no Pentadbir phone is not blocked from removing other devices', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const db = app.surau.db;
    // the recovery state: the Pentadbir phone is gone (revoked directly), a Pentadbir session is still held by the test
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), admin.deviceId);
    const other = await loginAs(app, 'superadmin');
    expect((await revokeRoute(app, other, ajk.deviceId)).statusCode).toBe(200);
    expect(revokedAt(db, ajk.deviceId)).not.toBeNull();
  });

  it('[PP-S4] a PIN reset naming the last Pentadbir phone in revokeDeviceIds answers 409 and resets nothing', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const db = app.surau.db;
    const before = userRow(db, admin.userId);
    const r = await pinReset(app, admin, admin.userId, [admin.deviceId]);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('last_admin_device');
    expect(revokedAt(db, admin.deviceId)).toBeNull();
    expect(userRow(db, admin.userId).pin_hash).toBe(before.pin_hash);
    expect(db.prepare('SELECT revoked_at FROM sessions WHERE user_id = ?').all(admin.userId).every((s) => s.revoked_at === null)).toBe(true);
  });

  it('[PP-S4] a PIN reset that revokes a phone while another Pentadbir phone remains still works', async () => {
    const app = makeApp();
    const a = await loginAs(app, 'admin');
    const b = await loginAs(app, 'admin');
    const r = await pinReset(app, a, b.userId, [b.deviceId]);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().revoked).toEqual([b.deviceId]);
    expect(userRow(app.surau.db, b.userId).pin_hash).toBeNull();
  });

  it('[PP-S4] deactivating the only Pentadbir who has a phone, while another Pentadbir has none, answers 409 and changes nothing', async () => {
    const app = makeApp();
    const a = await loginAs(app, 'admin');
    const db = app.surau.db;
    createUser(db, { name: 'Haji Osman', roles: ['admin'] }, 'test', LOCAL_SURAU_ID);
    const r = await deactivateRoute(app, a, a.userId);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('last_admin_device');
    expect(userRow(db, a.userId).active).toBe(1);
    expect(revokedAt(db, a.deviceId)).toBeNull();
  });

  it('[PP-S4] deactivating a Pentadbir while another Pentadbir phone remains still works', async () => {
    const app = makeApp();
    const a = await loginAs(app, 'admin');
    const b = await loginAs(app, 'admin');
    expect((await deactivateRoute(app, a, b.userId)).statusCode).toBe(200);
    expect(userRow(app.surau.db, b.userId).active).toBe(0);
  });

  it('[PP-S4] the sync paths are not guarded: a replicated revoke of the last Pentadbir phone lands', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const db = app.surau.db;
    const at = new Date(Date.now() + 60_000).toISOString();
    const entry: FeedEntry = {
      seq: 1, entity: 'device', entityId: admin.deviceId, rev: `${at}|dev-x`, editedAt: at, syncedAt: at, actor: 'user:x', deviceId: null, origin: 'local', opId: null,
      after: { id: admin.deviceId, userId: admin.userId, name: 'x', platform: 'web', revoked: true },
    };
    expect(applyFeedEntry(db, entry, { surauId: LOCAL_SURAU_ID, now: new Date(Date.now() + 3600_000), origin: 'box:b1', actor: 'user:x', dataDir: tmpdir() }).status).toBe('applied');
    expect(revokedAt(db, admin.deviceId)).not.toBeNull();
  });
});
