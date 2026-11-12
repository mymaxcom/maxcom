import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { klInstant } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { beginPairing, buildKioskCookie, cookieToken, newPairCode } from '../src/auth/pairing.ts';
import { purgeExpired } from '../src/auth/sessions.ts';
import { sha256hex } from '../src/auth/crypto.ts';
import { loginAs, loginAsAdmin } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';

const AT = klInstant('2026-11-03', '12:00');
/** A tablet on the LAN: not the box's own loopback kiosk. */
const KIOSK_IP = '10.168.1.77';
const apps: FastifyInstance[] = [];
const dirs: string[] = [];

function makeApp(clock: { t: number } = { t: AT.getTime() }): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-pair-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'), { now: () => new Date(clock.t) });
  apps.push(app);
  return app;
}

afterEach(async () => {
  for (const a of apps.splice(0)) {
    try {
      await a.close();
    } catch {
      /* closed */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const begin = (app: FastifyInstance, ip = KIOSK_IP) =>
  app.inject({ method: 'POST', url: '/api/kiosk/pair/begin', remoteAddress: ip });
const poll = (app: FastifyInstance, pollToken: string, ip = KIOSK_IP) =>
  app.inject({ method: 'POST', url: '/api/kiosk/pair/poll', remoteAddress: ip, payload: { pollToken } });
const approve = (app: FastifyInstance, login: Login, code: string, payload: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/kiosk/pair/approve',
    remoteAddress: '10.9.9.9',
    headers: login.headers,
    payload: { code, ...payload },
  });
const cookieOf = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers['set-cookie'];
  const line = Array.isArray(raw) ? String(raw[0]) : String(raw);
  return line.split(';')[0]!;
};

/** Full flow; returns the cookie header value and ids. */
async function pairKiosk(app: FastifyInstance, admin: Login) {
  const b = (await begin(app)).json() as { code: string; pollToken: string };
  const a = await approve(app, admin, b.code, { deviceName: 'TV surau' });
  expect(a.statusCode).toBe(200);
  const p = await poll(app, b.pollToken);
  expect(p.statusCode).toBe(200);
  return { cookie: cookieOf(p), deviceId: String(a.json().deviceId), setCookie: String(p.headers['set-cookie']), code: b.code, pollToken: b.pollToken };
}

describe('pairing codes', () => {
  it('codes are 6 digits, random, with short expiry', async () => {
    const app = makeApp();
    const r = await begin(app);
    expect(r.statusCode).toBe(200);
    const j = r.json() as { code: string; pollToken: string; expiresAt: string };
    expect(j.code).toMatch(/^[0-9]{6}$/);
    expect(j.pollToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(j.expiresAt) - AT.getTime()).toBe(10 * 60_000);
    expect(r.headers['cache-control']).toBe('no-store');
    const set = new Set(Array.from({ length: 200 }, () => newPairCode()));
    expect(set.size).toBeGreaterThan(190);
    for (const c of set) expect(c).toMatch(/^[0-9]{6}$/);
  });

  it('stores only hashes of the code and the poll token', async () => {
    const app = makeApp();
    const j = (await begin(app)).json() as { code: string; pollToken: string };
    const row = app.surau.db.prepare('SELECT * FROM kiosk_pairings').get()!;
    expect(row.code_hash).toBe(sha256hex(j.code));
    expect(row.poll_token_hash).toBe(sha256hex(j.pollToken));
    expect(JSON.stringify(row)).not.toContain(j.pollToken);
  });

  it('begin is limited to 3 per 10 minutes per IP', async () => {
    const app = makeApp();
    for (let i = 0; i < 3; i++) expect((await begin(app)).statusCode).toBe(200);
    const r = await begin(app);
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBeDefined();
    expect((await begin(app, '10.168.1.78')).statusCode).toBe(200);
  });

  it('approve needs devices:manage: anonymous 401, AJK 403', async () => {
    const app = makeApp();
    const b = (await begin(app)).json() as { code: string };
    const anon = await app.inject({ method: 'POST', url: '/api/kiosk/pair/approve', remoteAddress: '10.9.9.9', payload: { code: b.code } });
    expect(anon.statusCode).toBe(401);
    const ajk = await loginAs(app, 'ajk');
    expect((await approve(app, ajk, b.code)).statusCode).toBe(403);
  });

  it('a wrong, malformed or reused code is refused with the same 404', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const b = (await begin(app)).json() as { code: string };
    const wrong = b.code === '000000' ? '000001' : '000000';
    for (const code of [wrong, 'abc', '12345', '1234567', '']) {
      const r = await approve(app, admin, code);
      expect(r.statusCode).toBe(404);
    }
    expect((await approve(app, admin, b.code)).statusCode).toBe(200);
    expect((await approve(app, admin, b.code)).statusCode).toBe(404);
  });

  it('an expired code cannot be approved', async () => {
    const clock = { t: AT.getTime() };
    const app = makeApp(clock);
    const admin = await loginAsAdmin(app);
    const b = (await begin(app)).json() as { code: string };
    clock.t += 10 * 60_000 + 1000;
    expect((await approve(app, admin, b.code)).statusCode).toBe(404);
  });

  it('approve attempts are rate limited per admin', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await approve(app, admin, '000000')).statusCode;
    expect(last).toBe(429);
  });
});

describe('poll and the kiosk cookie', () => {
  it('pending until approved, then one cookie: HttpOnly, SameSite=Strict, 10 years, no Secure over plain HTTP', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const b = (await begin(app)).json() as { code: string; pollToken: string };
    const pending = await poll(app, b.pollToken);
    expect(pending.statusCode).toBe(200);
    expect(pending.json().status).toBe('pending');
    expect(pending.headers['set-cookie']).toBeUndefined();
    expect((await approve(app, admin, b.code)).statusCode).toBe(200);
    const done = await poll(app, b.pollToken);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ status: 'approved' });
    const set = String(done.headers['set-cookie']);
    expect(set).toMatch(/^surau_kiosk=[A-Za-z0-9_-]{43};/);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Strict');
    expect(set).toContain('Path=/');
    expect(set).toContain('Max-Age=315360000');
    expect(set).not.toContain('Secure');
    expect(done.headers['cache-control']).toBe('no-store');
  });

  it('Secure is added when the request is HTTPS', () => {
    expect(buildKioskCookie('t'.repeat(43), true)).toContain('; Secure');
    expect(buildKioskCookie('t'.repeat(43), false)).not.toContain('Secure');
  });

  it('single use: the second poll gets nothing and no second cookie', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const p = await pairKiosk(app, admin);
    const again = await poll(app, p.pollToken);
    expect(again.statusCode).toBe(404);
    expect(again.headers['set-cookie']).toBeUndefined();
    expect(app.surau.db.prepare('SELECT COUNT(*) AS n FROM kiosk_cookies').get()?.n).toBe(1);
  });

  it('only the hash of the cookie token is stored', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const p = await pairKiosk(app, admin);
    const token = p.cookie.split('=')[1]!;
    const row = app.surau.db.prepare('SELECT * FROM kiosk_cookies').get()!;
    expect(row.token_hash).toBe(sha256hex(token));
    const dump = JSON.stringify([
      app.surau.db.prepare('SELECT * FROM kiosk_cookies').all(),
      app.surau.db.prepare('SELECT * FROM kiosk_pairings').all(),
      app.surau.db.prepare('SELECT * FROM devices').all(),
      app.surau.db.prepare('SELECT * FROM auth_log').all(),
      app.surau.db.prepare('SELECT * FROM change_log').all(),
    ]);
    expect(dump).not.toContain(token);
  });

  it('bad, unknown or expired poll tokens get 404', async () => {
    const clock = { t: AT.getTime() };
    const app = makeApp(clock);
    for (const t of ['', 'x', 'a'.repeat(43), 123 as unknown as string]) {
      expect((await poll(app, t)).statusCode).toBe(404);
    }
    const b = (await begin(app)).json() as { pollToken: string };
    clock.t += 10 * 60_000 + 1000;
    expect((await poll(app, b.pollToken)).statusCode).toBe(404);
  });

  it('the paired kiosk reads the bundle from a LAN address and nothing else', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const p = await pairKiosk(app, admin);
    const h = { cookie: p.cookie };
    expect((await app.inject({ method: 'GET', url: '/api/kiosk/bundle', remoteAddress: KIOSK_IP, headers: h })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/kiosk/bundle', remoteAddress: KIOSK_IP })).statusCode).toBe(401);
    for (const [method, url] of [
      ['GET', '/api/settings'],
      ['GET', '/api/users'],
      ['GET', '/api/devices'],
      ['GET', '/api/audit'],
      ['PUT', '/api/settings/clock'],
      ['POST', '/api/kiosk/pair/approve'],
    ] as const) {
      const r = await app.inject({ method, url, remoteAddress: KIOSK_IP, headers: h, payload: method === 'GET' ? undefined : {} });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('a forged, truncated or foreign-format cookie is not a kiosk', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const p = await pairKiosk(app, admin);
    const good = p.cookie.split('=')[1]!;
    for (const cookie of [
      `surau_kiosk=${'a'.repeat(43)}`,
      `surau_kiosk=${good.slice(0, 40)}`,
      `surau_kiosk=${good}x`,
      `other=${good}`,
      `surau_kiosk=`,
    ]) {
      const r = await app.inject({ method: 'GET', url: '/api/kiosk/bundle', remoteAddress: KIOSK_IP, headers: { cookie } });
      expect(r.statusCode, cookie).toBe(401);
    }
    // surrounded by other cookies is fine
    const ok = await app.inject({
      method: 'GET',
      url: '/api/kiosk/bundle',
      remoteAddress: KIOSK_IP,
      headers: { cookie: `a=b; surau_kiosk=${good}; c=d` },
    });
    expect(ok.statusCode).toBe(200);
    expect(cookieToken(`surau_kiosk=${good}`)).toBe(good);
  });

  it('a revoked pairing loses access on its very next request, and the device list stops showing it', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const p = await pairKiosk(app, admin);
    const h = { cookie: p.cookie };
    const get = () => app.inject({ method: 'GET', url: '/api/kiosk/bundle', remoteAddress: KIOSK_IP, headers: h });
    expect((await get()).statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/devices', remoteAddress: '10.9.9.9', headers: admin.headers });
    const dev = (list.json().devices as { id: string; platform: string; name: string }[]).find((d) => d.id === p.deviceId);
    expect(dev).toMatchObject({ platform: 'kiosk', name: 'TV surau' });
    const rev = await app.inject({ method: 'POST', url: `/api/devices/${p.deviceId}/revoke`, remoteAddress: '10.9.9.9', headers: admin.headers });
    expect(rev.statusCode).toBe(200);
    expect((await get()).statusCode).toBe(401);
    const after = await app.inject({ method: 'GET', url: '/api/devices', remoteAddress: '10.9.9.9', headers: admin.headers });
    expect((after.json().devices as { id: string }[]).some((d) => d.id === p.deviceId)).toBe(false);
  });

  it('the cookie stops working after its 10-year expiry', async () => {
    const clock = { t: AT.getTime() };
    const app = makeApp(clock);
    const admin = await loginAsAdmin(app);
    const p = await pairKiosk(app, admin);
    const get = () => app.inject({ method: 'GET', url: '/api/kiosk/bundle', remoteAddress: KIOSK_IP, headers: { cookie: p.cookie } });
    clock.t += 3649 * 24 * 3600_000;
    expect((await get()).statusCode).toBe(200);
    clock.t += 2 * 24 * 3600_000;
    expect((await get()).statusCode).toBe(401);
  });

  it('approval is recorded in the audit log against the admin', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const p = await pairKiosk(app, admin);
    const row = app.surau.db.prepare("SELECT actor, entity, entity_id FROM change_log WHERE entity = 'devices' AND entity_id = ?").get(p.deviceId);
    expect(row).toMatchObject({ actor: `user:${admin.userId}`, entity: 'devices' });
  });

  it('the box\'s own loopback kiosk still works unpaired', async () => {
    const app = makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/kiosk/bundle', remoteAddress: '127.0.0.1' })).statusCode).toBe(200);
  });

  it('a stale cookie on loopback still falls back to the loopback kiosk rule', async () => {
    const app = makeApp();
    const r = await app.inject({
      method: 'GET',
      url: '/api/kiosk/bundle',
      remoteAddress: '127.0.0.1',
      headers: { cookie: `surau_kiosk=${'a'.repeat(43)}` },
    });
    expect(r.statusCode).toBe(200);
  });

  it('W13 Q5: deactivating the approving admin does NOT revoke the kiosk (it belongs to the box)', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const second = await loginAsAdmin(app);
    const p = await pairKiosk(app, second);
    const get = () => app.inject({ method: 'GET', url: '/api/kiosk/bundle', remoteAddress: KIOSK_IP, headers: { cookie: p.cookie } });
    expect((await get()).statusCode).toBe(200);
    const d = await app.inject({ method: 'POST', url: `/api/users/${second.userId}/deactivate`, remoteAddress: '10.9.9.9', headers: admin.headers });
    expect(d.statusCode).toBe(200);
    // the approver's own phone is revoked, the kiosk display keeps working
    expect((await get()).statusCode).toBe(200);
    const devices = (await app.inject({ method: 'GET', url: '/api/devices', headers: admin.headers })).json().devices as { id: string; revokedAt: string | null; platform: string }[];
    expect(devices.find((x) => x.id === p.deviceId)?.revokedAt).toBeNull();
    // the revoked phone is no longer listed at all (operator rule 2026-11-06), the row is kept
    expect(devices.find((x) => x.id === second.deviceId)).toBeUndefined();
    expect(app.surau.db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(second.deviceId)?.revoked_at).not.toBeNull();
    // an admin can still revoke the kiosk explicitly
    expect((await app.inject({ method: 'POST', url: `/api/devices/${p.deviceId}/revoke`, headers: admin.headers })).statusCode).toBe(200);
    expect((await get()).statusCode).toBe(401);
  });
});

describe('W13 S9: per-address cap and what the approver sees', () => {
  it('one address cannot hold more than 3 open pairings, whatever the rate limiter says', () => {
    const app = makeApp();
    const db = app.surau.db;
    const now = new Date(AT.getTime());
    for (let i = 0; i < 3; i++) beginPairing(db, '10.168.1.90', now);
    let e: unknown;
    try {
      beginPairing(db, '10.168.1.90', now);
    } catch (err) {
      e = err;
    }
    expect(e).toMatchObject({ status: 429, code: 'too_many_pairings' });
    // another address is unaffected, so is the same address once its codes are used or expired
    expect(() => beginPairing(db, '10.168.1.91', now)).not.toThrow();
    expect(() => beginPairing(db, '10.168.1.90', new Date(now.getTime() + 11 * 60_000))).not.toThrow();
  });

  it('GET /api/kiosk/pair/pending shows requester address and age (devices:manage only, no codes)', async () => {
    const clock = { t: AT.getTime() };
    const app = makeApp(clock);
    const admin = await loginAsAdmin(app);
    const ajk = await loginAs(app, 'ajk');
    const b = (await begin(app, '10.168.1.55')).json() as { code: string };
    clock.t += 42_000;
    expect((await app.inject({ method: 'GET', url: '/api/kiosk/pair/pending', remoteAddress: '10.9.9.9' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/kiosk/pair/pending', remoteAddress: '10.9.9.9', headers: ajk.headers })).statusCode).toBe(403);
    const r = await app.inject({ method: 'GET', url: '/api/kiosk/pair/pending', remoteAddress: '10.9.9.9', headers: admin.headers });
    expect(r.statusCode).toBe(200);
    const list = r.json().pairings as { requesterIp: string; codeAgeSeconds: number }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ requesterIp: '10.168.1.55', codeAgeSeconds: 42 });
    expect(JSON.stringify(r.json())).not.toContain(b.code);
    // once approved it is no longer pending
    await approve(app, admin, b.code);
    const after = await app.inject({ method: 'GET', url: '/api/kiosk/pair/pending', remoteAddress: '10.9.9.9', headers: admin.headers });
    expect(after.json().pairings).toEqual([]);
  });

  it('the approve answer carries the requester address and the code age', async () => {
    const clock = { t: AT.getTime() };
    const app = makeApp(clock);
    const admin = await loginAsAdmin(app);
    const b = (await begin(app, '10.168.1.56')).json() as { code: string };
    clock.t += 95_000;
    const a = await approve(app, admin, b.code);
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ ok: true, requesterIp: '10.168.1.56', codeAgeSeconds: 95 });
  });
});

describe('W13 Q14: an approved pairing nobody claimed leaves no live device', () => {
  it('purgeExpired revokes the device once the pairing expired unclaimed; the kiosk cannot claim it', async () => {
    const clock = { t: AT.getTime() };
    const app = makeApp(clock);
    const admin = await loginAsAdmin(app);
    const b = (await begin(app)).json() as { code: string; pollToken: string };
    const a = await approve(app, admin, b.code, { deviceName: 'TV' });
    const deviceId = String(a.json().deviceId);
    const dev = () => app.surau.db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(deviceId)!.revoked_at;
    clock.t += 11 * 60_000;
    purgeExpired(app.surau.db, new Date(clock.t));
    expect(dev()).not.toBeNull();
    expect((await poll(app, b.pollToken)).statusCode).toBe(404);
    // a claimed pairing's device is left alone
    const ok = await pairKiosk(app, admin);
    clock.t += 11 * 60_000;
    purgeExpired(app.surau.db, new Date(clock.t));
    expect(app.surau.db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(ok.deviceId)!.revoked_at).toBeNull();
  });
});
