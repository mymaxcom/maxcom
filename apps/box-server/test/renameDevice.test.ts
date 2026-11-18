import { webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeedEntry } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { renameDevice } from '../src/auth/devices.ts';
import { createUser } from '../src/auth/users.ts';
import { openDb } from '../src/db.ts';
import { applyFeedEntry } from '../src/sync/apply.ts';
import { loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeApp(): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-rendev-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'), { dataDir: dir });
  apps.push(app);
  return app;
}

const adminRename = (app: FastifyInstance, l: Login, deviceId: string, name: unknown) =>
  app.inject({ method: 'PUT', url: `/api/devices/${deviceId}/name`, headers: l.headers, payload: { name } });
const ownRename = (app: FastifyInstance, l: Login, name: unknown, extra: Record<string, unknown> = {}) =>
  app.inject({ method: 'PUT', url: '/api/auth/device/name', headers: l.headers, payload: { name, ...extra } });
const devName = (db: DatabaseSync, id: string): string => String(db.prepare('SELECT name FROM devices WHERE id = ?').get(id)?.name);
const devLog = (db: DatabaseSync, id: string): Array<Record<string, unknown>> =>
  db.prepare("SELECT before_json, after_json FROM change_log WHERE entity = 'devices' AND entity_id = ? ORDER BY id").all(id) as Array<Record<string, unknown>>;

describe('[PP-S3] rename a device (routes)', () => {
  it('[PP-S3] a Pentadbir renames a phone; the list and one audit row show both names', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const oldName = devName(app.surau.db, ajk.deviceId);
    const n = devLog(app.surau.db, ajk.deviceId).length;
    const r = await adminRename(app, admin, ajk.deviceId, '  Telefon   Kak Siti ');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().ok).toBe(true);
    expect(r.json().device).toMatchObject({ id: ajk.deviceId, name: 'Telefon Kak Siti' });
    expect(JSON.stringify(r.json())).not.toContain('publicJwk');
    const list = (await app.inject({ method: 'GET', url: '/api/devices', headers: admin.headers })).json().devices as Array<{ id: string; name: string }>;
    expect(list.find((d) => d.id === ajk.deviceId)?.name).toBe('Telefon Kak Siti');
    const rows = devLog(app.surau.db, ajk.deviceId);
    expect(rows.length).toBe(n + 1);
    const last = rows[rows.length - 1]!;
    expect(JSON.parse(String(last.before_json)).name).toBe(oldName);
    expect(JSON.parse(String(last.after_json)).name).toBe('Telefon Kak Siti');
    expect(String(last.after_json)).not.toContain('publicJwk');
  });

  it('[PP-S3] the owner renames their own device; a body naming another device changes nothing else', async () => {
    const app = makeApp();
    const ajk = await loginAs(app, 'ajk');
    const other = await loginAs(app, 'treasurer');
    const otherName = devName(app.surau.db, other.deviceId);
    const r = await ownRename(app, ajk, 'Telefon Ustaz Ahmad', { deviceId: other.deviceId, id: other.deviceId });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().device).toMatchObject({ id: ajk.deviceId, name: 'Telefon Ustaz Ahmad' });
    expect(devName(app.surau.db, ajk.deviceId)).toBe('Telefon Ustaz Ahmad');
    expect(devName(app.surau.db, other.deviceId)).toBe(otherName);
  });

  it('[PP-S3] a TV screen is renamed and its kiosk cookie still resolves', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const b = (await app.inject({ method: 'POST', url: '/api/kiosk/pair/begin', remoteAddress: '10.168.1.77' })).json() as { code: string; pollToken: string };
    const a = await app.inject({ method: 'POST', url: '/api/kiosk/pair/approve', remoteAddress: '10.9.9.9', headers: admin.headers, payload: { code: b.code, deviceName: 'TV surau' } });
    expect(a.statusCode, a.body).toBe(200);
    const tvId = String(a.json().deviceId);
    const p = await app.inject({ method: 'POST', url: '/api/kiosk/pair/poll', remoteAddress: '10.168.1.77', payload: { pollToken: b.pollToken } });
    const raw = p.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? String(raw[0]) : String(raw)).split(';')[0]!;
    const bundle = () => app.inject({ method: 'GET', url: '/api/kiosk/bundle', remoteAddress: '10.168.1.77', headers: { cookie } });
    expect((await bundle()).statusCode).toBe(200);
    const r = await adminRename(app, admin, tvId, 'TV dewan solat');
    expect(r.statusCode, r.body).toBe(200);
    expect(devName(app.surau.db, tvId)).toBe('TV dewan solat');
    expect((await bundle()).statusCode).toBe(200);
    // a TV has no session of its own: it cannot rename itself
    const self = await app.inject({ method: 'PUT', url: '/api/auth/device/name', remoteAddress: '10.168.1.77', headers: { cookie }, payload: { name: 'X' } });
    expect([401, 403]).toContain(self.statusCode);
    expect(devName(app.surau.db, tvId)).toBe('TV dewan solat');
  });

  it('[PP-S3] another surau, a Pentadbir MAXCOM device and an unknown id answer 404; the star one is logged', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const star = await loginAs(app, 'superadmin');
    const db = app.surau.db;
    db.prepare("INSERT OR IGNORE INTO suraus (id, name, created_at, created_by) VALUES ('lain', 'Surau Lain', '2026-11-01T00:00:00.000Z', 'test')").run();
    const u = createUser(db, { name: 'Orang Lain', roles: ['ajk'] }, 'test', 'lain');
    db.prepare("INSERT INTO devices (id, user_id, name, platform, public_jwk, enrolled_at, surau_id) VALUES ('dx', ?, 'Telefon Lain', 'android', '{}', ?, 'lain')").run(u.id, '2026-11-01T00:00:00.000Z');
    const logged = (): number => Number(db.prepare("SELECT COUNT(*) AS n FROM auth_log WHERE event = 'star_target_refused'").get()?.n);
    const starName = devName(db, star.deviceId);
    expect((await adminRename(app, admin, 'no-such-device', 'X')).statusCode).toBe(404);
    expect((await adminRename(app, admin, 'dx', 'X')).statusCode).toBe(404);
    expect(devName(db, 'dx')).toBe('Telefon Lain');
    const n0 = logged();
    const s = await adminRename(app, admin, star.deviceId, 'X');
    expect(s.statusCode).toBe(404);
    expect(s.json().code).toBe('not_found');
    expect(logged() - n0).toBe(1);
    expect(devName(db, star.deviceId)).toBe(starName);
  });

  it('[PP-S3] a revoked device answers 409 device_revoked and keeps its name', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const name = devName(app.surau.db, ajk.deviceId);
    expect((await app.inject({ method: 'POST', url: `/api/devices/${ajk.deviceId}/revoke`, headers: admin.headers })).statusCode).toBe(200);
    const r = await adminRename(app, admin, ajk.deviceId, 'Baru');
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('device_revoked');
    expect(devName(app.surau.db, ajk.deviceId)).toBe(name);
  });

  it('[PP-S3] the name rule applies to both routes', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    for (const bad of ['', '  ', 'x'.repeat(81), 'A\u0000B', 'A‮B', 'A⁩B', 7, null]) {
      const a = await adminRename(app, admin, ajk.deviceId, bad);
      expect(a.statusCode, JSON.stringify(bad)).toBe(400);
      expect(a.json().code).toBe('bad_name');
    }
    const owner = await loginAs(app, 'ajk');
    for (const bad of ['', 'x'.repeat(81), 'A‮B']) {
      const o = await ownRename(app, owner, bad);
      expect(o.statusCode, JSON.stringify(bad)).toBe(400);
      expect(o.json().code).toBe('bad_name');
    }
    expect((await adminRename(app, admin, ajk.deviceId, 'x'.repeat(80))).statusCode).toBe(200);
  });

  it('[PP-S3] the same name writes no row; a Bendahari cannot use the admin route but can rename their own', async () => {
    const app = makeApp();
    const treasurer = await loginAs(app, 'treasurer');
    const ajk = await loginAs(app, 'ajk');
    const n = devLog(app.surau.db, treasurer.deviceId).length;
    expect((await ownRename(app, treasurer, devName(app.surau.db, treasurer.deviceId))).statusCode).toBe(200);
    expect(devLog(app.surau.db, treasurer.deviceId).length).toBe(n);
    expect((await adminRename(app, treasurer, ajk.deviceId, 'X')).statusCode).toBe(403);
    expect((await ownRename(app, treasurer, 'Telefon Bendahari')).statusCode).toBe(200);
  });

  it('[PP-S3] the owner route is rate limited (its own limiter, 20 per 15 minutes)', async () => {
    const app = makeApp();
    const ajk = await loginAs(app, 'ajk');
    let last = 200;
    for (let i = 0; i < 22; i++) last = (await ownRename(app, ajk, `Telefon ${i}`)).statusCode;
    expect(last).toBe(429);
  });

  it('[PP-S3] renameDevice is a no-op for the same name and refuses an unknown id', () => {
    const db = openDb(':memory:');
    dbs.push(db);
    const u = createUser(db, { name: 'Encik Rahman', roles: ['ajk'] }, 'test', 'sdm');
    db.prepare("INSERT INTO devices (id, user_id, name, platform, public_jwk, enrolled_at, surau_id) VALUES ('d1', ?, 'Telefon', 'android', '{}', '2026-11-01T00:00:00.000Z', 'sdm')").run(u.id);
    expect(renameDevice(db, 'd1', ' Telefon ', 'user:x').name).toBe('Telefon');
    expect(devLog(db, 'd1').length).toBe(0);
    expect(() => renameDevice(db, 'nope', 'Y', 'user:x')).toThrowError(/tidak dijumpai/i);
  });
});

describe('[PP-S3] rename a device (feed)', () => {
  const T0 = '2026-11-09T09:00:00.000Z';
  const T1 = '2026-11-09T09:30:00.000Z';
  const T2 = '2026-11-09T09:45:00.000Z';
  const NOW = new Date('2026-11-09T10:00:00.000Z');
  let n = 0;
  const entry = (after: unknown, editedAt: string): FeedEntry => ({
    seq: ++n, entity: 'device', entityId: 'd1', rev: `${editedAt}|dev-${n}`, editedAt, syncedAt: editedAt, actor: 'user:x', deviceId: null, origin: 'local', opId: null, after,
  });
  async function key(): Promise<{ kty: string; crv: string; x: string; y: string }> {
    const k = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const j = await webcrypto.subtle.exportKey('jwk', k.publicKey);
    return { kty: String(j.kty), crv: String(j.crv), x: String(j.x), y: String(j.y) };
  }
  async function rig() {
    const dir = mkdtempSync(join(tmpdir(), 'surau-rendevf-'));
    dirs.push(dir);
    const db = openDb(join(dir, 't.db'));
    dbs.push(db);
    const u = createUser(db, { name: 'Ajk', roles: ['ajk'] }, 'test', 'sdm');
    const jwk = await key();
    const ctx = { surauId: 'sdm', now: NOW, origin: 'box:b1', actor: 'user:x', dataDir: dir, acceptDeviceEnrolment: true };
    const enrol = { id: 'd1', userId: u.id, name: 'Telefon', platform: 'android', revoked: false, publicJwk: jwk, enrolledAt: T0 };
    expect(applyFeedEntry(db, entry(enrol, T0), ctx).status).toBe('applied');
    const plain = (name: string, extra: Record<string, unknown> = {}) => ({ id: 'd1', userId: u.id, name, platform: 'android', revoked: false, ...extra });
    return { db, ctx, u, jwk, enrol, plain };
  }

  it('[PP-S3] a rename entry renames the device on the other side', async () => {
    const { db, ctx, plain } = await rig();
    expect(applyFeedEntry(db, entry(plain('Telefon Baru'), T1), ctx).status).toBe('applied');
    expect(devName(db, 'd1')).toBe('Telefon Baru');
  });

  it('[PP-S3] an older rename arriving after a newer one is a duplicate', async () => {
    const { db, ctx, plain } = await rig();
    expect(applyFeedEntry(db, entry(plain('Nama Dua'), T2), ctx).status).toBe('applied');
    expect(applyFeedEntry(db, entry(plain('Nama Satu'), T1), ctx)).toEqual({ status: 'duplicate', reason: null });
    expect(devName(db, 'd1')).toBe('Nama Dua');
  });

  it('[PP-S3] a rename entry with a bad name changes nothing', async () => {
    const { db, ctx, plain } = await rig();
    expect(applyFeedEntry(db, entry(plain('A‮B'), T1), ctx).status).toBe('duplicate');
    expect(devName(db, 'd1')).toBe('Telefon');
  });

  it('[PP-S3] an entry with revoked true still revokes and none ever un-revokes', async () => {
    const { db, ctx, plain } = await rig();
    expect(applyFeedEntry(db, entry(plain('Telefon', { revoked: true }), T1), ctx).status).toBe('applied');
    expect(db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get('d1')?.revoked_at).not.toBeNull();
    expect(applyFeedEntry(db, entry(plain('Telefon Lagi', { revoked: false }), T2), ctx).status).toBe('duplicate');
    expect(db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get('d1')?.revoked_at).not.toBeNull();
    expect(devName(db, 'd1')).toBe('Telefon');
  });

  it('[PP-S3] an entry with a different key is still device_key_mismatch, even with a new name', async () => {
    const { db, ctx, plain } = await rig();
    const other = await key();
    expect(applyFeedEntry(db, entry(plain('Telefon Baru', { publicJwk: other, enrolledAt: T0 }), T1), ctx)).toEqual({ status: 'refused', reason: 'device_key_mismatch' });
    expect(devName(db, 'd1')).toBe('Telefon');
  });
});
