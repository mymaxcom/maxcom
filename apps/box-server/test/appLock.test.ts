import { webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { klInstant } from '@surau/core';
import type { Role } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { beginEnrolment } from '../src/auth/devices.ts';
import { appLockEnabled } from '../src/auth/appLock.ts';
import { createUser, getAuthUser } from '../src/auth/users.ts';
import { loginAsAdmin } from './authHelpers.ts';

const AT = klInstant('2026-11-03', '12:00');
const PIN = '482916';
const apps: FastifyInstance[] = [];
const dirs: string[] = [];
let ipCounter = 0;
const nextIp = (): string => `10.77.${(++ipCounter >> 8) & 255}.${ipCounter & 255}`;

function makeApp(): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-applock-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'), { now: () => AT });
  apps.push(app);
  return app;
}

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Dev {
  userId: string;
  deviceId: string;
  ip: string;
  keys: webcrypto.CryptoKeyPair;
  enrol: Record<string, unknown>;
  sign: (nonce: string) => Promise<string>;
  challenge: () => Promise<string>;
  unlock: (extra?: Record<string, unknown>, opts?: { nonce?: string; signature?: string }) => Promise<{ status: number; body: Record<string, any> }>;
}

async function makeDevice(app: FastifyInstance, role: Role, pin: string | undefined): Promise<Dev> {
  const { db, boxId } = app.surau;
  const ip = nextIp();
  const user = createUser(db, { name: `U ${ipCounter}`, roles: [role] }, 'test');
  const { code } = beginEnrolment(db, { userId: user.id, deviceName: 'Tel' }, 'test');
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
  const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  const res = await app.inject({
    method: 'POST', url: '/api/enrol/complete', remoteAddress: ip,
    payload: { code, publicJwk, platform: 'web', ...(pin !== undefined ? { pin } : {}) },
  });
  if (res.statusCode !== 200) throw new Error(`enrol ${res.statusCode} ${res.body}`);
  const enrol = res.json() as Record<string, unknown>;
  const deviceId = String(enrol.deviceId);
  const sign = async (nonce: string): Promise<string> => {
    const msg = new TextEncoder().encode(`surau-unlock\n${boxId}\n${deviceId}\n${nonce}`);
    const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, msg);
    return Buffer.from(sig).toString('base64url');
  };
  const challenge = async (): Promise<string> => {
    const ch = await app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress: ip, payload: { deviceId } });
    if (ch.statusCode !== 200) throw new Error(`challenge ${ch.statusCode} ${ch.body}`);
    return String(ch.json().nonce);
  };
  const unlock: Dev['unlock'] = async (extra = {}, opts = {}) => {
    const nonce = opts.nonce ?? (await challenge());
    const signature = opts.signature ?? (await sign(nonce));
    const r = await app.inject({
      method: 'POST', url: '/api/auth/unlock', remoteAddress: ip,
      payload: { deviceId, nonce, signature, ...extra },
    });
    return { status: r.statusCode, body: r.json() as Record<string, any> };
  };
  return { userId: user.id, deviceId, ip, keys, enrol, sign, challenge, unlock };
}

const pinState = (app: FastifyInstance, userId: string): { fails: number; lockedUntil: string | null; hash: string | null } => {
  const r = app.surau.db.prepare('SELECT pin_fail_count, pin_locked_until, pin_hash FROM users WHERE id = ?').get(userId)!;
  return { fails: Number(r.pin_fail_count), lockedUntil: (r.pin_locked_until as string | null) ?? null, hash: (r.pin_hash as string | null) ?? null };
};

const lastAuthLog = (app: FastifyInstance, deviceId: string): { ok: number; detail: string | null; event: string } =>
  app.surau.db.prepare('SELECT ok, detail, event FROM auth_log WHERE device_id = ? AND event = ? ORDER BY id DESC LIMIT 1').get(deviceId, 'unlock') as never;

async function setLock(app: FastifyInstance, enabled: boolean): Promise<void> {
  const admin = await loginAsAdmin(app);
  const r = await app.inject({ method: 'PUT', url: '/api/settings/appLock', headers: admin.headers, payload: { enabled } });
  if (r.statusCode !== 200) throw new Error(`setLock ${r.statusCode} ${r.body}`);
}

describe('app lock off (the default)', () => {
  it('is off on a new box', () => {
    const app = makeApp();
    expect(appLockEnabled(app.surau.db)).toBe(false);
  });

  it('unlocks with no pin field and the token works; /me reports appLock false', async () => {
    const app = makeApp();
    const d = await makeDevice(app, 'ajk', PIN);
    const r = await d.unlock();
    expect(r.status).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${r.body.token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().appLock).toBe(false);
    const log = lastAuthLog(app, d.deviceId);
    expect(log.ok).toBe(1);
    expect(log.detail).toBe('no_pin');
  });

  it('ignores a wrong pin and counts nothing', async () => {
    const app = makeApp();
    const d = await makeDevice(app, 'ajk', PIN);
    const r = await d.unlock({ pin: '000000' });
    expect(r.status).toBe(200);
    expect(pinState(app, d.userId).fails).toBe(0);
  });

  it('ignores newPin and does not change the stored hash', async () => {
    const app = makeApp();
    const d = await makeDevice(app, 'ajk', PIN);
    const before = pinState(app, d.userId).hash;
    const r = await d.unlock({ newPin: '739518' });
    expect(r.status).toBe(200);
    expect(pinState(app, d.userId).hash).toBe(before);
  });

  it('a user with no PIN at all unlocks', async () => {
    const app = makeApp();
    const d = await makeDevice(app, 'media', undefined);
    expect(pinState(app, d.userId).hash).toBeNull();
    expect((await d.unlock()).status).toBe(200);
    expect(pinState(app, d.userId).hash).toBeNull();
  });

  it('still refuses a replayed nonce', async () => {
    const app = makeApp();
    const d = await makeDevice(app, 'ajk', PIN);
    const nonce = await d.challenge();
    expect((await d.unlock({}, { nonce })).status).toBe(200);
    const again = await d.unlock({}, { nonce });
    expect(again.status).toBe(401);
    expect(again.body.code ?? again.body.errors).toBeDefined();
    expect(lastAuthLog(app, d.deviceId).detail).toBe('bad_nonce');
  });

  it('still refuses a nonce that was never issued', async () => {
    const app = makeApp();
    const d = await makeDevice(app, 'ajk', PIN);
    const fake = 'x'.repeat(43);
    const r = await d.unlock({}, { nonce: fake, signature: await d.sign(fake) });
    expect(r.status).toBe(401);
    expect(lastAuthLog(app, d.deviceId).detail).toBe('bad_nonce');
  });

  it('still refuses a forged signature (flipped byte) and spends the nonce', async () => {
    const app = makeApp();
    const d = await makeDevice(app, 'ajk', PIN);
    const nonce = await d.challenge();
    const good = Buffer.from(await d.sign(nonce), 'base64url');
    good[10] = good[10]! ^ 0xff;
    const r = await d.unlock({}, { nonce, signature: good.toString('base64url') });
    expect(r.status).toBe(401);
    expect(lastAuthLog(app, d.deviceId).detail).toBe('bad_signature');
    // the nonce is spent: the right signature on it no longer works
    const retry = await d.unlock({}, { nonce });
    expect(retry.status).toBe(401);
  });

  it('refuses a signature made by another device key', async () => {
    const app = makeApp();
    const a = await makeDevice(app, 'ajk', PIN);
    const b = await makeDevice(app, 'ajk', PIN);
    const nonce = await a.challenge();
    const r = await a.unlock({}, { nonce, signature: await b.sign(nonce) });
    expect(r.status).toBe(401);
    expect(lastAuthLog(app, a.deviceId).detail).toBe('bad_signature');
  });

  it('refuses a revoked device', async () => {
    const app = makeApp();
    const d = await makeDevice(app, 'ajk', PIN);
    const nonce = await d.challenge();
    const signature = await d.sign(nonce);
    const admin = await loginAsAdmin(app);
    const rev = await app.inject({ method: 'POST', url: `/api/devices/${d.deviceId}/revoke`, headers: admin.headers, payload: {} });
    expect(rev.statusCode).toBe(200);
    const r = await d.unlock({}, { nonce, signature });
    expect(r.status).toBe(401);
    expect(lastAuthLog(app, d.deviceId).detail).toBe('device_revoked');
  });

  it('refuses a deactivated user', async () => {
    const app = makeApp();
    const d = await makeDevice(app, 'ajk', PIN);
    const nonce = await d.challenge();
    const signature = await d.sign(nonce);
    const admin = await loginAsAdmin(app);
    const off = await app.inject({ method: 'POST', url: `/api/users/${d.userId}/deactivate`, headers: admin.headers, payload: {} });
    expect(off.statusCode).toBe(200);
    const r = await d.unlock({}, { nonce, signature });
    expect(r.status).toBe(401);
    expect(getAuthUser(app.surau.db, d.userId)?.active).toBe(false);
  });

  it('lets in a user whose PIN lockout is in the future and leaves the lockout state alone', async () => {
    const app = makeApp();
    const d = await makeDevice(app, 'ajk', PIN);
    const until = new Date(AT.getTime() + 3_600_000).toISOString();
    app.surau.db.prepare('UPDATE users SET pin_locked_until = ?, pin_fail_count = 3, lock_round = 2 WHERE id = ?').run(until, d.userId);
    const r = await d.unlock();
    expect(r.status).toBe(200);
    const s = app.surau.db.prepare('SELECT pin_fail_count, pin_locked_until, lock_round FROM users WHERE id = ?').get(d.userId)!;
    expect(Number(s.pin_fail_count)).toBe(3);
    expect(s.pin_locked_until).toBe(until);
    expect(Number(s.lock_round)).toBe(2);
  });

  it('PUT /api/auth/pin gives 409 app_lock_off before any rate-limit hit', async () => {
    const app = makeApp();
    const d = await makeDevice(app, 'ajk', PIN);
    const tok = (await d.unlock()).body.token as string;
    for (let i = 0; i < 8; i++) {
      const r = await app.inject({
        method: 'PUT', url: '/api/auth/pin', headers: { authorization: `Bearer ${tok}` },
        payload: { currentPin: PIN, newPin: '739518' },
      });
      expect(r.statusCode).toBe(409);
      expect(r.json().code ?? r.json().errors).toBeDefined();
    }
    expect(pinState(app, d.userId).hash).not.toBeNull();
  });

  it('enrol/complete without pin reports pinRequired false and appLock false', async () => {
    const app = makeApp();
    const d = await makeDevice(app, 'media', undefined);
    expect(d.enrol.pinRequired).toBe(false);
    expect(d.enrol.appLock).toBe(false);
  });

  it('enrol/complete still stores a pin sent by an older app build when the user has none', async () => {
    const app = makeApp();
    const d = await makeDevice(app, 'media', PIN);
    expect(pinState(app, d.userId).hash).not.toBeNull();
    expect(d.enrol.appLock).toBe(false);
  });

  it('challenge answer carries appLock; the enrol payload decodes with appLock false', async () => {
    const app = makeApp();
    const d = await makeDevice(app, 'ajk', PIN);
    const ch = await app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress: d.ip, payload: { deviceId: d.deviceId } });
    expect(ch.json().appLock).toBe(false);
    const admin = await loginAsAdmin(app);
    const u = createUser(app.surau.db, { name: 'Baru', roles: ['ajk'] }, 'test');
    const begin = await app.inject({
      method: 'POST', url: '/api/enrol/begin', headers: admin.headers, payload: { userId: u.id, deviceName: 'X' },
    });
    expect(begin.statusCode).toBe(200);
    const payload = JSON.parse(Buffer.from(String(begin.json().payload).replace(/^surau1:/, ''), 'base64url').toString('utf8'));
    expect(payload.appLock).toBe(false);
  });

  it('a revoked or unknown device still gets no challenge answer', async () => {
    const app = makeApp();
    const r = await app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress: nextIp(), payload: { deviceId: 'nope' } });
    expect(r.statusCode).toBe(401);
    expect(r.json().appLock).toBeUndefined();
  });

  it('GET /api/health reports appLock to admin and AJK but not to anonymous', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const ok = await app.inject({ method: 'GET', url: '/api/health', headers: admin.headers });
    expect(ok.json().appLock).toBe(false);
    const d = await makeDevice(app, 'ajk', PIN);
    const tok = (await d.unlock()).body.token as string;
    const ajk = await app.inject({ method: 'GET', url: '/api/health', headers: { authorization: `Bearer ${tok}` } });
    expect(ajk.json().appLock).toBe(false);
    const anon = await app.inject({ method: 'GET', url: '/api/health', remoteAddress: '10.168.1.9' });
    expect(anon.json().appLock).toBeUndefined();
  });
});

describe('switching the lock', () => {
  it('off to on: PIN user needs the PIN, uncounted pin_missing; no-PIN user is asked to set one; sessions survive; on to off keeps hashes', async () => {
    const app = makeApp();
    const withPin = await makeDevice(app, 'ajk', PIN);
    const noPin = await makeDevice(app, 'media', undefined);
    const offSession = (await withPin.unlock()).body.token as string;
    const hashBefore = pinState(app, withPin.userId).hash;

    await setLock(app, true);
    expect(appLockEnabled(app.surau.db)).toBe(true);

    // session issued while off still resolves
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${offSession}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().appLock).toBe(true);

    // no pin field: 401 pin_missing, uncounted
    const missing = await withPin.unlock();
    expect(missing.status).toBe(401);
    expect(missing.body.code ?? '').toBe('pin_missing');
    expect(String(missing.body.errors?.[0] ?? '')).toContain('PIN diperlukan');
    expect(pinState(app, withPin.userId).fails).toBe(0);
    expect(lastAuthLog(app, withPin.deviceId).detail).toBe('pin_missing');

    // wrong pin IS counted
    expect((await withPin.unlock({ pin: '000000' })).status).toBe(401);
    expect(pinState(app, withPin.userId).fails).toBe(1);

    // right pin works and clears the counter
    expect((await withPin.unlock({ pin: PIN })).status).toBe(200);
    expect(pinState(app, withPin.userId).fails).toBe(0);

    // user without a PIN: 409 pinRequired, then set one with newPin
    const need = await noPin.unlock();
    expect(need.status).toBe(409);
    expect(need.body.pinRequired).toBe(true);
    const set = await noPin.unlock({ newPin: '739518' });
    expect(set.status).toBe(200);
    expect(pinState(app, noPin.userId).hash).not.toBeNull();

    // back off: both unlock without a PIN; hashes untouched
    const hashMid = pinState(app, withPin.userId).hash;
    const noPinHash = pinState(app, noPin.userId).hash;
    expect(hashMid).toBe(hashBefore);
    await setLock(app, false);
    expect((await withPin.unlock()).status).toBe(200);
    expect((await noPin.unlock()).status).toBe(200);
    expect(pinState(app, withPin.userId).hash).toBe(hashBefore);
    expect(pinState(app, noPin.userId).hash).toBe(noPinHash);
  });

  it('with the lock on, a pin_missing request still spends its nonce', async () => {
    const app = makeApp();
    const d = await makeDevice(app, 'ajk', PIN);
    await setLock(app, true);
    const nonce = await d.challenge();
    expect((await d.unlock({}, { nonce })).status).toBe(401);
    // same nonce with the right PIN: replay refused
    expect((await d.unlock({ pin: PIN }, { nonce })).status).toBe(401);
    expect(lastAuthLog(app, d.deviceId).detail).toBe('bad_nonce');
    // an explicit empty pin is the same as a missing one: uncounted
    expect((await d.unlock({ pin: '' })).status).toBe(401);
    expect(pinState(app, d.userId).fails).toBe(0);
  });

  it('with the lock on, the existing lockout still guards a locked user', async () => {
    const app = makeApp();
    const d = await makeDevice(app, 'ajk', PIN);
    await setLock(app, true);
    const until = new Date(AT.getTime() + 3_600_000).toISOString();
    app.surau.db.prepare('UPDATE users SET pin_locked_until = ? WHERE id = ?').run(until, d.userId);
    const r = await d.unlock({ pin: PIN });
    expect(r.status).toBe(423);
  });

  it('with the lock on, PUT /api/auth/pin works as before', async () => {
    const app = makeApp();
    const d = await makeDevice(app, 'ajk', PIN);
    await setLock(app, true);
    const tok = (await d.unlock({ pin: PIN })).body.token as string;
    const r = await app.inject({
      method: 'PUT', url: '/api/auth/pin', headers: { authorization: `Bearer ${tok}` },
      payload: { currentPin: PIN, newPin: '739518' },
    });
    expect(r.statusCode).toBe(200);
  });
});
