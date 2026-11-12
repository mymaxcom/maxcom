import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { beginEnrolment } from '../src/auth/devices.ts';
import { createUser } from '../src/auth/users.ts';
import { loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { signOp } from './support/signOp.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeApp(): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-sat-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'), { dataDir: dir });
  apps.push(app);
  return app;
}

const logCount = (db: DatabaseSync, detail: string): number =>
  Number(db.prepare('SELECT COUNT(*) AS n FROM auth_log WHERE detail = ?').get(detail)?.n ?? 0);

describe('acting on a Pentadbir MAXCOM needs superadmin:manage (routes)', () => {
  it('an admin is refused on every route that touches a superadmin; a superadmin is allowed', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const sup = await loginAs(app, 'superadmin');
    const target = await loginAs(app, 'superadmin');
    const hdr = admin.headers;
    const forbidden = (r: { statusCode: number; json: () => { errors?: string[] } }, what: string): void => {
      expect(r.statusCode, what).toBe(403);
    };

    // 1. PIN reset: the first step of the takeover chain
    forbidden(await app.inject({ method: 'PUT', url: `/api/users/${target.userId}/pin`, headers: hdr, payload: {} }), 'pin');
    // 2. enrolment code for the superadmin: the second step
    forbidden(await app.inject({ method: 'POST', url: '/api/enrol/begin', headers: hdr, payload: { userId: target.userId, deviceName: 'X' } }), 'enrol');
    // 3. roles, even an identical set
    forbidden(await app.inject({ method: 'PUT', url: `/api/users/${target.userId}/roles`, headers: hdr, payload: { roles: ['superadmin', 'admin'] } }), 'roles');
    forbidden(await app.inject({ method: 'PUT', url: `/api/users/${target.userId}/roles`, headers: hdr, payload: { roles: ['admin'] } }), 'roles demote');
    // 4. deactivate
    forbidden(await app.inject({ method: 'POST', url: `/api/users/${target.userId}/deactivate`, headers: hdr }), 'deactivate');
    // 5. revoke the superadmin's device
    forbidden(await app.inject({ method: 'POST', url: `/api/devices/${target.deviceId}/revoke`, headers: hdr }), 'revoke');

    // nothing changed
    const row = app.surau.db.prepare('SELECT active, pin_hash FROM users WHERE id = ?').get(target.userId);
    expect(row?.active).toBe(1);
    expect(row?.pin_hash).not.toBeNull();
    expect(app.surau.db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(target.deviceId)?.revoked_at).toBeNull();
    expect(app.surau.db.prepare('SELECT COUNT(*) AS n FROM enrolments WHERE user_id = ? AND used_at IS NULL').get(target.userId)?.n).toBe(0);

    // the superadmin may do all of it
    const sh = sup.headers;
    expect((await app.inject({ method: 'PUT', url: `/api/users/${target.userId}/roles`, headers: sh, payload: { roles: ['superadmin', 'admin'] } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/enrol/begin', headers: sh, payload: { userId: target.userId, deviceName: 'X' } })).statusCode).toBe(200);
    const pin = await app.inject({ method: 'PUT', url: `/api/users/${target.userId}/pin`, headers: sh, payload: {} });
    expect(pin.statusCode, pin.body).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/devices/${target.deviceId}/revoke`, headers: sh })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/users/${target.userId}/deactivate`, headers: sh })).statusCode).toBe(200);
  });

  it('an admin still manages an ordinary user', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const media = await loginAs(app, 'media');
    const hdr = admin.headers;
    expect((await app.inject({ method: 'PUT', url: `/api/users/${media.userId}/roles`, headers: hdr, payload: { roles: ['media', 'ajk'] } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/enrol/begin', headers: hdr, payload: { userId: media.userId, deviceName: 'X' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: `/api/users/${media.userId}/pin`, headers: hdr, payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/devices/${media.deviceId}/revoke`, headers: hdr })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/users/${media.userId}/deactivate`, headers: hdr })).statusCode).toBe(200);
  });

  it('beginEnrolment itself refuses a superadmin target unless the caller may manage it', () => {
    const app = makeApp();
    const db = app.surau.db;
    const u = createUser(db, { name: 'Sasaran', roles: ['ajk'] }, 'test');
    db.prepare('UPDATE users SET roles_json = ? WHERE id = ?').run(JSON.stringify(['superadmin', 'admin']), u.id);
    expect(() => beginEnrolment(db, { userId: u.id, deviceName: 'X' }, 'test')).toThrowError(/Tiada kebenaran/);
    expect(() => beginEnrolment(db, { userId: u.id, deviceName: 'X' }, 'test', { canManageSuperadmin: false })).toThrowError(/Tiada kebenaran/);
    expect(beginEnrolment(db, { userId: u.id, deviceName: 'X' }, 'test', { canManageSuperadmin: true }).code).toMatch(/^[A-Z2-7]{4}-/);
    const plain = createUser(db, { name: 'Biasa', roles: ['ajk'] }, 'test');
    expect(beginEnrolment(db, { userId: plain.id, deviceName: 'X' }, 'test', { canManageSuperadmin: false }).code).toBeTruthy();
  });
});

describe('acting on a Pentadbir MAXCOM needs superadmin:manage (signed ops)', () => {
  const send = async (app: FastifyInstance, login: Login, op: Parameters<typeof signOp>[2]) => {
    const signed = await signOp(login, app.surau.boxId, op);
    const r = await app.inject({ method: 'POST', url: '/api/sync/ops', headers: login.headers, payload: { ops: [signed] } });
    return r.json().results[0] as { status: string; reason: string | null };
  };
  const put = (id: string, name: string, roles: string[]) => ({
    kind: 'user.put' as const, entity: 'user', entityId: id, payload: { name, roles, active: true }, editedAt: new Date().toISOString(),
  });

  it('user.put on a superadmin (a rename, same roles) is refused for an admin and applied for a superadmin', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const sup = await loginAs(app, 'superadmin');
    const target = await loginAs(app, 'superadmin');
    expect(await send(app, admin, put(target.userId, 'Nama Baru', ['superadmin', 'admin']))).toMatchObject({ status: 'refused', reason: 'forbidden' });
    expect(await send(app, admin, { ...put(target.userId, 'Nama Baru', ['superadmin', 'admin']), payload: { active: false } })).toMatchObject({ status: 'refused', reason: 'forbidden' });
    expect(logCount(app.surau.db, 'superadmin_manage')).toBe(2);
    expect(app.surau.db.prepare('SELECT name, active FROM users WHERE id = ?').get(target.userId)).toMatchObject({ active: 1 });
    expect(app.surau.db.prepare('SELECT name FROM users WHERE id = ?').get(target.userId)?.name).not.toBe('Nama Baru');
    expect((await send(app, sup, put(target.userId, 'Nama Baru', ['superadmin', 'admin']))).status).toBe('applied');
    expect(app.surau.db.prepare('SELECT name FROM users WHERE id = ?').get(target.userId)?.name).toBe('Nama Baru');
  });

  it('user.put on an ordinary user still works for an admin', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const media = await loginAs(app, 'media');
    expect((await send(app, admin, put(media.userId, 'Media Baru', ['media']))).status).toBe('applied');
  });

  it('device.revoke of a superadmin device is refused for an admin, applied for a superadmin, and works on an ordinary device', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const sup = await loginAs(app, 'superadmin');
    const target = await loginAs(app, 'superadmin');
    const media = await loginAs(app, 'media');
    const revoke = (deviceId: string) => ({ kind: 'device.revoke' as const, entity: 'device', entityId: deviceId, payload: {}, editedAt: new Date().toISOString() });
    expect(await send(app, admin, revoke(target.deviceId))).toMatchObject({ status: 'refused', reason: 'forbidden' });
    expect(app.surau.db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(target.deviceId)?.revoked_at).toBeNull();
    expect(logCount(app.surau.db, 'superadmin_manage')).toBe(1);
    expect((await send(app, admin, revoke(media.deviceId))).status).toBe('applied');
    expect((await send(app, sup, revoke(target.deviceId))).status).toBe('applied');
  });
});
