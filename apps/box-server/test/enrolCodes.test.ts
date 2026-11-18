import { webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { beginEnrolment } from '../src/auth/devices.ts';
import { createUser } from '../src/auth/users.ts';
import type { TlsMaterial } from '../src/tls.ts';
import { loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';

const mat = (ipSan: string[], dnsSan: string[]): TlsMaterial =>
  ({ mode: 'ip', pfx: Buffer.alloc(0), passphrase: '', notAfter: new Date('2030-01-01'), ipSan, dnsSan }) as TlsMaterial;
const LEGACY = mat(['192.0.2.20', '127.0.0.1'], ['localhost', 'box.surau.local']);
const NAMED = mat(['192.0.2.20', '127.0.0.1'], ['localhost', 'box1-surau.local']);

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function make(opts: Parameters<typeof buildApp>[1] = {}): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-s5-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'surau.db'), { dataDir: dir, httpsPort: 8443, tls: NAMED, ...opts });
  apps.push(app);
  return app;
}

const decode = (p: string): Record<string, unknown> => JSON.parse(Buffer.from(p.slice(7), 'base64url').toString('utf8')) as Record<string, unknown>;

interface Begin { id: number; code: string; expiresAt: string; payload: string; sharePayload?: string }
const begin = async (app: FastifyInstance, by: Login, userId: string, extra: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: '/api/enrol/begin', headers: by.headers, payload: { userId, deviceName: 'Telefon Kak Siti', ...extra } });
const beginOk = async (app: FastifyInstance, by: Login, userId: string, extra: Record<string, unknown> = {}): Promise<Begin> => {
  const r = await begin(app, by, userId, extra);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Begin;
};

let ipN = 0;
async function redeem(app: FastifyInstance, code: string, ip?: string) {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
  return app.inject({
    method: 'POST',
    url: '/api/enrol/complete',
    remoteAddress: ip ?? `10.88.${(++ipN >> 8) & 255}.${ipN & 255}`,
    payload: { code, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, platform: 'android' },
  });
}

const recent = async (app: FastifyInstance, by: Login) =>
  (await app.inject({ method: 'GET', url: '/api/enrol/recent', headers: by.headers })).json().codes as Array<Record<string, unknown>>;
const open = (app: FastifyInstance, by: Login) => app.inject({ method: 'GET', url: '/api/enrol/open', headers: by.headers });
const cancel = (app: FastifyInstance, by: Login, id: unknown, userId: unknown) =>
  app.inject({ method: 'POST', url: '/api/enrol/cancel', headers: by.headers, payload: { id, userId } });

describe('[PP-S5] share payload', () => {
  it('[PP-S5] sharePayload has exactly the reduced keys, no LAN address, and the normal payload is unchanged', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const b = await beginOk(app, admin, ajk.userId);
    expect(typeof b.id).toBe('number');
    expect(b.sharePayload).toBeDefined();
    expect(b.sharePayload!.startsWith('surau1:')).toBe(true);
    const s = decode(b.sharePayload!);
    expect(Object.keys(s).sort()).toEqual(['appLock', 'box', 'boxId', 'caSha256', 'code', 'exp', 'mode', 'name', 'pinSet', 'surau', 'user', 'v']);
    for (const k of ['ips', 'roles', 'invitedBy', 'help', 'cloud']) expect(s, k).not.toHaveProperty(k);
    expect(JSON.stringify(s)).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    expect(s.box).toBe('https://box1-surau.local:8443');
    expect(s.name).toBe('box1-surau.local');
    expect(Object.keys(s.surau as object).sort()).toEqual(['kind', 'name']);
    // the app-side parser rules: the same fields as the QR payload
    expect(s).toMatchObject({ v: 1, boxId: app.surau.boxId, code: b.code, pinSet: true });
    expect(typeof s.mode).toBe('string');
    expect(s.caSha256).toEqual(decode(b.payload).caSha256);
    expect(typeof s.user).toBe('string');
    expect(s.exp).toBe(Date.parse(b.expiresAt));
    const p = decode(b.payload);
    expect(p.box).toBe('https://192.0.2.20:8443');
    expect(p.ips).toEqual(['192.0.2.20']);
    expect(p).toHaveProperty('roles');
    expect(p).toHaveProperty('invitedBy');
  });

  it('[PP-S5] there is no sharePayload without a numbered box name', async () => {
    for (const tls of [LEGACY, null]) {
      const app = make({ tls });
      const admin = await loginAs(app, 'admin');
      const ajk = await loginAs(app, 'ajk');
      const b = await beginOk(app, admin, ajk.userId);
      expect(b, String(tls)).not.toHaveProperty('sharePayload');
      expect(b.payload.startsWith('surau1:')).toBe(true);
    }
  });

  it('[PP-S5] the cloud still answers 409 box_only', async () => {
    const app = make({ role: 'cloud' });
    const admin = await loginAs(app, 'admin');
    const u = createUser(app.surau.db, { name: 'Kak Siti', roles: ['ajk'] }, 'test', 'sdm');
    const r = await begin(app, admin, u.id);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('box_only');
  });

  it('[PP-S5] the limits are unchanged with the new fields: 3 open codes, ttl 10/30/60 only, single use, redeem limiter', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    for (const ttl of [10, 30, 60]) {
      const b = await beginOk(app, admin, ajk.userId, { ttlMinutes: ttl });
      expect(Date.parse(b.expiresAt) - Date.now()).toBeGreaterThan((ttl - 1) * 60_000);
      expect(Date.parse(b.expiresAt) - Date.now()).toBeLessThanOrEqual(ttl * 60_000);
    }
    const fourth = await begin(app, admin, ajk.userId);
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json().code).toBe('too_many_codes');
    const other = createUser(app.surau.db, { name: 'Haji Osman', roles: ['ajk'] }, 'test', 'sdm');
    const bad = await begin(app, admin, other.id, { ttlMinutes: 20 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('bad_ttl');
    // single use
    const one = await beginOk(app, admin, other.id);
    expect((await redeem(app, one.code)).statusCode).toBe(200);
    const again = await redeem(app, one.code);
    expect(again.statusCode).toBe(401);
    expect(again.json().code).toBe('enrol_code_used');
    // the redeem limiter: 5 per address, the 6th is 429 even for a code that exists
    const limiterApp = make();
    const a2 = await loginAs(limiterApp, 'admin');
    const u2 = createUser(limiterApp.surau.db, { name: 'Encik Rahman', roles: ['ajk'] }, 'test', 'sdm');
    const c2 = await beginOk(limiterApp, a2, u2.id);
    const ip = '10.99.0.9';
    for (let i = 0; i < 5; i++) expect((await redeem(limiterApp, 'AAAA-BBBB-CCCC', ip)).statusCode).toBe(401);
    expect((await redeem(limiterApp, c2.code, ip)).statusCode).toBe(429);
  });
});

describe('[PP-S5] cancel, open list, enrolled device', () => {
  it('[PP-S5] a cancelled code cannot be redeemed and recent shows cancelledAt with no device', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const b = await beginOk(app, admin, ajk.userId);
    const c = await cancel(app, admin, b.id, ajk.userId);
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json()).toEqual({ ok: true, cancelled: true });
    const r = await redeem(app, b.code);
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe('enrol_code_used');
    const row = (await recent(app, admin)).find((x) => x.id === b.id)!;
    expect(row.cancelledAt).toEqual(expect.any(String));
    expect(row.device).toBeNull();
    expect(app.surau.db.prepare("SELECT ok FROM auth_log WHERE event = 'enrol_cancel' AND user_id = ?").get(ajk.userId)).toBeDefined();
    // cancelling again changes nothing
    expect((await cancel(app, admin, b.id, ajk.userId)).json()).toEqual({ ok: true, cancelled: false });
  });

  it('[PP-S5] cancel with a wrong userId for the id cancels nothing; a used code is not cancelled', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const other = createUser(app.surau.db, { name: 'Haji Osman', roles: ['ajk'] }, 'test', 'sdm');
    const b = await beginOk(app, admin, ajk.userId);
    const wrong = await cancel(app, admin, b.id, other.id);
    expect(wrong.statusCode).toBe(200);
    expect(wrong.json()).toEqual({ ok: true, cancelled: false });
    expect((await redeem(app, b.code)).statusCode).toBe(200);
    const used = await beginOk(app, admin, other.id);
    expect((await redeem(app, used.code)).statusCode).toBe(200);
    expect((await cancel(app, admin, used.id, other.id)).json()).toEqual({ ok: true, cancelled: false });
    expect((await cancel(app, admin, 'x', other.id)).statusCode).toBe(400);
    expect((await cancel(app, admin, 1.5, other.id)).statusCode).toBe(400);
  });

  it('[PP-S5] a Bendahari gets 403 on open and cancel; a Pentadbir MAXCOM or unknown user is 404 on cancel', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const treasurer = await loginAs(app, 'treasurer');
    const star = await loginAs(app, 'superadmin');
    expect((await open(app, treasurer)).statusCode).toBe(403);
    expect((await cancel(app, treasurer, 1, treasurer.userId)).statusCode).toBe(403);
    const starCode = beginEnrolment(app.surau.db, { userId: star.userId, deviceName: 'X' }, 'test', { canManageSuperadmin: true });
    expect(starCode.code).toBeTruthy();
    const id = Number(app.surau.db.prepare('SELECT rowid AS id FROM enrolments WHERE user_id = ? AND used_at IS NULL').get(star.userId)?.id);
    const r = await cancel(app, admin, id, star.userId);
    expect(r.statusCode).toBe(404);
    expect(app.surau.db.prepare('SELECT used_at FROM enrolments WHERE rowid = ?').get(id)?.used_at).toBeNull();
    expect((await cancel(app, admin, 1, 'nope')).statusCode).toBe(404);
  });

  it('[PP-S5] open lists unused codes of the surau (also another Pentadbir\'s), never another surau\'s, a star user\'s, the code or its hash', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const admin2 = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const db = app.surau.db;
    const mine = await beginOk(app, admin, ajk.userId);
    const theirs = await beginOk(app, admin2, ajk.userId);
    const used = await beginOk(app, admin, admin2.userId);
    await redeem(app, used.code);
    const cancelled = await beginOk(app, admin, admin2.userId);
    await cancel(app, admin, cancelled.id, admin2.userId);
    const expired = await beginOk(app, admin, admin2.userId);
    db.prepare('UPDATE enrolments SET expires_at = ? WHERE rowid = ?').run('2020-01-01T00:00:00.000Z', expired.id);
    // another surau and a star user
    db.prepare("INSERT OR IGNORE INTO suraus (id, name, created_at, created_by) VALUES ('lain', 'Surau Lain', '2026-11-01T00:00:00.000Z', 'test')").run();
    const foreign = createUser(db, { name: 'Orang Lain', roles: ['ajk'] }, 'test', 'lain');
    beginEnrolment(db, { userId: foreign.id, deviceName: 'X' }, 'test');
    const star = await loginAs(app, 'superadmin');
    beginEnrolment(db, { userId: star.userId, deviceName: 'X' }, 'test', { canManageSuperadmin: true });

    const r = await open(app, admin);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const codes = r.json().codes as Array<Record<string, unknown>>;
    expect(codes.map((c) => c.id).sort()).toEqual([mine.id, theirs.id].sort());
    for (const c of codes) {
      expect(Object.keys(c).sort()).toEqual(['createdByName', 'deviceName', 'expiresAt', 'id', 'userId', 'userName', 'userRef']);
      expect(c.userId).toBe(ajk.userId);
      expect(c.deviceName).toBe('Telefon Kak Siti');
    }
    expect(codes.find((c) => c.id === theirs.id)?.createdByName).toBe(String(db.prepare('SELECT name FROM users WHERE id = ?').get(admin2.userId)?.name));
    expect(r.body).not.toContain(mine.code);
    expect(r.body).not.toContain(theirs.code);
    expect(r.body).not.toMatch(/code_?hash/i);
  });

  it('[PP-S5] recent names the device that used the code, with its platform and time, and counts a second attempt', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const b = await beginOk(app, admin, ajk.userId);
    const ok = await redeem(app, b.code);
    expect(ok.statusCode, ok.body).toBe(200);
    const deviceId = String(ok.json().deviceId);
    expect((await redeem(app, b.code)).statusCode).toBe(401);
    const row = (await recent(app, admin)).find((x) => x.id === b.id)!;
    expect(row.cancelledAt).toBeNull();
    expect(row.usedAt).toEqual(expect.any(String));
    expect(row.device).toEqual({ id: deviceId, name: 'Telefon Kak Siti', platform: 'android', enrolledAt: expect.any(String), ref: expect.stringMatching(/^D-[0-9]{4}$/) });
    expect(row.reuseAttempts).toBe(1);
    expect(JSON.stringify(row)).not.toContain('publicJwk');
  });

  it('[PP-S5] an unused code in recent has no device and no cancelledAt', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const b = await beginOk(app, admin, ajk.userId);
    const row = (await recent(app, admin)).find((x) => x.id === b.id)!;
    expect(row).toMatchObject({ cancelledAt: null, device: null, usedAt: null });
  });
});

describe('[A10] distinct refusal codes for an enrolment code', () => {
  const setExpiry = (db: DatabaseSync, id: number, at: string): void => {
    db.prepare('UPDATE enrolments SET expires_at = ? WHERE rowid = ?').run(at, id);
  };

  it('[A10] unknown, expired and used each answer 401 with their own code', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const unknown = await redeem(app, 'ZZZZ-ZZZZ-ZZZZ');
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().code).toBe('enrol_code_unknown');

    const e = await beginOk(app, admin, ajk.userId);
    setExpiry(app.surau.db, e.id, '2020-01-01T00:00:00.000Z');
    const expired = await redeem(app, e.code);
    expect(expired.statusCode).toBe(401);
    expect(expired.json().code).toBe('enrol_code_expired');

    const u = await beginOk(app, admin, ajk.userId);
    expect((await redeem(app, u.code)).statusCode).toBe(200);
    const used = await redeem(app, u.code);
    expect(used.statusCode).toBe(401);
    expect(used.json().code).toBe('enrol_code_used');
    // each carries its own sentence, none the old shared one
    expect(new Set([unknown.json().errors[0], expired.json().errors[0], used.json().errors[0]]).size).toBe(3);
  });

  it('[A10] a used code that is also past its time says used; a code of a deactivated person says unknown', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const u = await beginOk(app, admin, ajk.userId);
    expect((await redeem(app, u.code)).statusCode).toBe(200);
    setExpiry(app.surau.db, u.id, '2020-01-01T00:00:00.000Z');
    expect((await redeem(app, u.code)).json().code).toBe('enrol_code_used');

    const other = createUser(app.surau.db, { name: 'Haji Osman', roles: ['ajk'] }, 'test', 'sdm');
    const c = await beginOk(app, admin, other.id);
    app.surau.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(other.id);
    const r = await redeem(app, c.code);
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe('enrol_code_unknown');
  });

  it('[A10] the redeem writes the device id of the enrolled device on the code row', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const b = await beginOk(app, admin, ajk.userId);
    const ok = await redeem(app, b.code);
    expect(app.surau.db.prepare('SELECT device_id FROM enrolments WHERE rowid = ?').get(b.id)?.device_id).toBe(String(ok.json().deviceId));
  });
});
