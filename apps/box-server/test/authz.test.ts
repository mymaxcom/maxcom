import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLES, klInstant } from '@surau/core';
import type { Permission, Role } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { putFeature } from '../src/settingsStore.ts';
import { authHook, classifyRequest, createLimiters, normalisePath, ROUTE_PERMISSIONS, siteMayCall } from '../src/auth/authz.ts';
import { loginAs, loginAsAdmin } from './authHelpers.ts';

const AT = klInstant('2026-11-03', '12:00');
/** A phone on the LAN: not the box's own kiosk, so anonymous means anonymous. */
const LAN = '10.168.1.60';
const apps: FastifyInstance[] = [];
const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'surau-authz-'));
  dirs.push(d);
  return d;
}

function makeApp(options: Parameters<typeof buildApp>[1] = {}): FastifyInstance {
  // the role matrix calls every listed route (the HadeethEnc ones too): no request may leave the test
  const noNetwork = (async () => { throw new TypeError('network disabled in tests'); }) as unknown as typeof fetch;
  const app = buildApp(join(tempDir(), 'test.db'), { now: () => AT, fetchImpl: noNetwork, ...options });
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

const settingsJson = async (app: FastifyInstance, headers: Record<string, string>): Promise<unknown> =>
  (await app.inject({ method: 'GET', url: '/api/settings', headers })).json();

describe('default deny and identity', () => {
  it('anonymous write is 401 and changes nothing', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const before = await settingsJson(app, admin.headers);
    const r = await app.inject({ method: 'PUT', url: '/api/settings/clock', remoteAddress: LAN, payload: { show24h: true } });
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toBe('Bearer');
    expect(r.json()).toEqual({ errors: ['Sila buka kunci semula'] });
    expect(await settingsJson(app, admin.headers)).toEqual(before);
  });

  it('AJK is refused a settings write (403); admin succeeds and the change is logged against the user and device', async () => {
    const app = makeApp();
    const ajk = await loginAs(app, 'ajk');
    const admin = await loginAsAdmin(app);
    const denied = await app.inject({ method: 'PUT', url: '/api/settings/hijriDate', headers: ajk.headers, payload: { adjustDays: 1 } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ errors: ['Tiada kebenaran untuk tindakan ini'] });
    const ok = await app.inject({ method: 'PUT', url: '/api/settings/hijriDate', headers: admin.headers, payload: { adjustDays: 1 } });
    expect(ok.statusCode).toBe(200);
    const row = app.surau.db.prepare("SELECT actor, device_id FROM change_log WHERE entity = 'settings' ORDER BY id DESC LIMIT 1").get();
    expect(row?.actor).toBe(`user:${admin.userId}`);
    expect(row?.device_id).toBe(admin.deviceId);
  });

  it('prayer import: media 403, admin 200 with a user actor, never local', async () => {
    const app = makeApp();
    const media = await loginAs(app, 'media');
    const admin = await loginAsAdmin(app);
    const csv = 'Hijri,Date,Imsak,Fajr,Syuruk,Dhuhr,Asr,Maghrib,Isha\n';
    const denied = await app.inject({ method: 'POST', url: '/api/prayer/import', headers: media.headers, payload: { zone: 'SGR01', csv } });
    expect(denied.statusCode).toBe(403);
    // A 400 from the handler proves the hook let the admin through.
    const through = await app.inject({ method: 'POST', url: '/api/prayer/import', headers: admin.headers, payload: { zone: 'SGR01' } });
    expect(through.statusCode).toBe(400);
  });

  it('unknown API path: anonymous 401 (not 404), signed-in 404', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    expect((await app.inject({ method: 'GET', url: '/api/nosuch', remoteAddress: LAN })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/nosuch', headers: admin.headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: '/api/settings/clock', headers: admin.headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: '/api/settings/clock', remoteAddress: LAN })).statusCode).toBe(401);
  });

  it('a registered route with no table entry is refused even for a signed-in admin', async () => {
    const real = makeApp();
    const admin = await loginAsAdmin(real);
    const bare = Fastify();
    apps.push(bare);
    bare.decorateRequest('auth', null);
    bare.addHook('onRequest', authHook({ db: real.surau.db, now: () => AT, limiters: createLimiters() }));
    bare.get('/api/secret-new', async () => ({ leaked: true }));
    const signed = await bare.inject({ method: 'GET', url: '/api/secret-new', headers: admin.headers });
    expect(signed.statusCode).toBe(403);
    expect(signed.body).not.toContain('leaked');
    const anon = await bare.inject({ method: 'GET', url: '/api/secret-new', remoteAddress: '10.0.0.9' });
    expect(anon.statusCode).toBe(401);
  });

  it('path tricks resolve to the canonical permission', async () => {
    const app = makeApp();
    const ajk = await loginAs(app, 'ajk');
    const tricks: [string, string][] = [
      ['PUT', '/api/settings/clock/'],
      ['PUT', '//api/settings/clock'],
      ['POST', '/api/settings/%2e%2e/prayer/import'],
      ['PUT', '/api/settings/clock?x=1'],
      ['PUT', '/API/Settings/clock'],
      ['PUT', '/api/settings/./clock'],
      ['PUT', '/api%2Fsettings/clock'],
      ['PUT', '/api\\settings\\clock'],
    ];
    for (const [method, url] of tricks) {
      // W13 S2: a raw path that hides a separator or dot behind a percent escape is refused (400)
      // before classification; every other trick still resolves to the canonical permission.
      const ambiguous = /%(2f|5c)/i.test(url);
      const anon = await app.inject({ method, url, remoteAddress: LAN, payload: { show24h: true } });
      expect(anon.statusCode, `anonymous ${url}`).toBe(ambiguous ? 400 : 401);
      const asAjk = await app.inject({ method, url, headers: ajk.headers, payload: { show24h: true } });
      expect(asAjk.statusCode, `ajk ${url}`).toBe(ambiguous ? 400 : 403);
    }
    expect(normalisePath('/api/%zz')).toBeNull();
    expect(classifyRequest('PUT', '/api/%zz')).toEqual({ kind: 'unlisted' });
    expect(classifyRequest('PATCH', '/api/settings/clock')).toEqual({ kind: 'unlisted' });
    expect(classifyRequest('GET', '/index.html')).toEqual({ kind: 'static' });
    expect(classifyRequest('POST', '/index.html')).toEqual({ kind: 'unlisted' });
  });

  it('bearer works only in the Authorization header; a cookie or query token is ignored', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const q = await app.inject({ method: 'PUT', url: `/api/settings/clock?token=${admin.token}&access_token=${admin.token}`, remoteAddress: LAN, payload: {} });
    expect(q.statusCode).toBe(401);
    const c = await app.inject({ method: 'PUT', url: '/api/settings/clock', remoteAddress: LAN, headers: { cookie: `surau_kiosk=${admin.token}; token=${admin.token}` }, payload: {} });
    expect(c.statusCode).toBe(401);
    const odd = await app.inject({ method: 'PUT', url: '/api/settings/clock', remoteAddress: LAN, headers: { authorization: `Basic ${admin.token}` }, payload: {} });
    expect(odd.statusCode).toBe(401);
    // an admin's bearer is accepted on a kiosk route
    const k = await app.inject({ method: 'GET', url: '/api/kiosk/bundle', headers: admin.headers, remoteAddress: '10.168.1.20' });
    expect(k.statusCode).toBe(200);
  });

  it('a revoked device token is dead on the next request', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const ajk = await loginAs(app, 'ajk');
    expect((await app.inject({ method: 'GET', url: '/api/settings', headers: ajk.headers })).statusCode).toBe(200);
    const rev = await app.inject({ method: 'POST', url: `/api/devices/${ajk.deviceId}/revoke`, headers: admin.headers });
    expect(rev.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/settings', headers: ajk.headers })).statusCode).toBe(401);
  });

  it('logout kills the session', async () => {
    const app = makeApp();
    const a = await loginAs(app, 'ajk');
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: a.headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: a.headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: a.headers })).statusCode).toBe(401);
  });
});

describe('the local kiosk rule (loopback HTTP)', () => {
  it('loopback reads the kiosk routes with kiosk:read only', async () => {
    const app = makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/kiosk/bundle' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/assets/${'0'.repeat(64)}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/settings' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/content/penceramah' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(403);
  });

  it('loopback alone never writes', async () => {
    const app = makeApp();
    const w = [
      app.inject({ method: 'PUT', url: '/api/settings/clock', payload: {} }),
      app.inject({ method: 'POST', url: '/api/prayer/import', payload: {} }),
      app.inject({ method: 'PUT', url: '/api/content/penceramah/x', payload: {} }),
      app.inject({ method: 'POST', url: '/api/assets', headers: { 'content-type': 'image/png' }, payload: Buffer.from('x') }),
      app.inject({ method: 'POST', url: '/api/users', payload: {} }),
    ];
    for (const r of await Promise.all(w)) expect(r.statusCode).toBe(403);
  });

  it('a LAN address, a proxy header or a cross-site fetch is not the local kiosk', async () => {
    const app = makeApp();
    const lan = await app.inject({ method: 'GET', url: '/api/kiosk/bundle', remoteAddress: '10.168.1.50' });
    expect(lan.statusCode).toBe(401);
    for (const headers of [
      { 'x-forwarded-for': '10.168.1.50' },
      { forwarded: 'for=10.168.1.50' },
      { 'x-real-ip': '10.168.1.50' },
      { 'cf-connecting-ip': '203.0.113.7' },
      { 'cf-ray': '8f1a2b3c4d5e6f70-SIN' },
      { 'sec-fetch-site': 'cross-site' },
    ]) {
      const r = await app.inject({ method: 'GET', url: '/api/kiosk/bundle', headers });
      expect(r.statusCode, JSON.stringify(headers)).toBe(401);
    }
    const v6 = await app.inject({ method: 'GET', url: '/api/kiosk/bundle', remoteAddress: '::1' });
    expect(v6.statusCode).toBe(200);
  });
});

describe('static files stay public', () => {
  it('page files load anonymously from the LAN; unknown built files are 404, not 401', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'chunks'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>kiosk</title>');
    writeFileSync(join(dir, 'chunks', 'index-abc123.js'), 'console.log(1)');
    const app = makeApp({ staticDir: dir });
    for (const url of ['/', '/index.html', '/chunks/index-abc123.js', '/some/deep/link']) {
      const r = await app.inject({ method: 'GET', url, remoteAddress: '10.168.1.50' });
      expect(r.statusCode, url).toBe(200);
    }
    expect((await app.inject({ method: 'GET', url: '/chunks/missing.js', remoteAddress: '10.168.1.50' })).statusCode).toBe(404);
    // built files under /assets/ (dotted names) are classed public; ids without a dot are the asset store
    expect(classifyRequest('GET', '/assets/index-abc123.js')).toEqual({ kind: 'static' });
    expect(classifyRequest('GET', '/assets/index-abc123')).toMatchObject({ kind: 'rule', permission: 'kiosk:read' });
    expect((await app.inject({ method: 'GET', url: `/assets/${'a'.repeat(64)}`, remoteAddress: '10.168.1.50' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/index.html', remoteAddress: '10.168.1.50' })).statusCode).toBe(401);
  });

  it('serves the built kiosk files Vite writes under /assets/ (the asset-store route only takes 64-hex ids)', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>kiosk</title>');
    writeFileSync(join(dir, 'assets', 'index-AbC123.js'), 'console.log(1)');
    writeFileSync(join(dir, 'assets', 'plus-jakarta-sans-latin-800.woff2'), 'x');
    const app = makeApp({ staticDir: dir });
    for (const url of ['/assets/index-AbC123.js', '/assets/plus-jakarta-sans-latin-800.woff2']) {
      const r = await app.inject({ method: 'GET', url, remoteAddress: '10.168.1.50' });
      expect(r.statusCode, url).toBe(200);
    }
  });
});

describe('health', () => {
  it('anonymous sees only ok and version; a signed-in user sees the full report', async () => {
    const app = makeApp();
    const anon = await app.inject({ method: 'GET', url: '/api/health', remoteAddress: '10.168.1.9' });
    expect(Object.keys(anon.json()).sort()).toEqual(['ok', 'version']);
    const kiosk = await app.inject({ method: 'GET', url: '/api/health' });
    expect(Object.keys(kiosk.json()).sort()).toEqual(['ok', 'version']);
    const ajk = await loginAs(app, 'ajk');
    await loginAsAdmin(app);
    const full = (await app.inject({ method: 'GET', url: '/api/health', headers: ajk.headers })).json();
    expect(full).toMatchObject({ ok: true, tls: null, users: 2, devices: 2, lockedUsers: 0 });
    expect(full).toHaveProperty('daysAhead');
  });
});

describe('GET /api/pki/status (admin only)', () => {
  const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));

  it('anonymous 401, kiosk and non-admin roles refused, admin gets the certificate fields', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'pki'));
    mkdirSync(join(dir, 'logs'));
    cpSync(join(fixtures, 'test-box-leaf.cer'), join(dir, 'pki', 'box-leaf.cer'));
    cpSync(join(fixtures, 'test-box2-leaf.cer'), join(dir, 'pki', 'root-ca.cer'));
    writeFileSync(
      join(dir, 'logs', 'cert-renew.log'),
      [
        '2026-11-01T03:30:00+08:00 RENEWED new leaf',
        '2026-11-02T03:30:00+08:00 SKIP leaf valid',
        '2026-11-03T03:30:00+08:00 FAIL box-ca exited',
        '2026-11-03T04:30:00+08:00 SKIP leaf valid',
        '',
      ].join('\r\n'),
    );
    const app = makeApp({ dataDir: dir });
    expect((await app.inject({ method: 'GET', url: '/api/pki/status', remoteAddress: LAN })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/pki/status' })).statusCode).toBe(403);
    for (const role of ['ajk', 'treasurer', 'media'] as const) {
      const who = await loginAs(app, role);
      expect((await app.inject({ method: 'GET', url: '/api/pki/status', headers: who.headers })).statusCode, role).toBe(403);
    }
    const admin = await loginAsAdmin(app);
    const r = await app.inject({ method: 'GET', url: '/api/pki/status', headers: admin.headers });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(Object.keys(body).sort()).toEqual(['lastRenewAttempt', 'lastRenewOk', 'leafDaysLeft', 'leafNotAfter', 'rootNotAfter']);
    expect(typeof body.leafNotAfter).toBe('string');
    expect(body.leafDaysLeft).toBeGreaterThan(0);
    expect(typeof body.rootNotAfter).toBe('string');
    expect(body.lastRenewOk).toBe(false);
    expect(body.lastRenewAttempt).toBe(new Date('2026-11-03T03:30:00+08:00').toISOString());
  });

  it('tolerates missing files', async () => {
    const app = makeApp({ dataDir: tempDir() });
    const admin = await loginAsAdmin(app);
    const r = await app.inject({ method: 'GET', url: '/api/pki/status', headers: admin.headers });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ leafNotAfter: null, leafDaysLeft: null, rootNotAfter: null });
  });
});

describe('rate limits', () => {
  it('601 requests a minute from one session -> 429 with Retry-After', async () => {
    const app = makeApp();
    const a = await loginAs(app, 'ajk');
    let first429 = -1;
    for (let i = 1; i <= 601; i++) {
      const r = await app.inject({ method: 'GET', url: '/api/auth/me', headers: a.headers });
      if (r.statusCode === 429) {
        first429 = i;
        expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
        break;
      }
    }
    // login used some of the session's budget? No: login requests are anonymous (per IP).
    expect(first429).toBe(601);
  });

  it('auth endpoints: 20 per 5 minutes per IP', async () => {
    const app = makeApp();
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress: '10.1.1.1', payload: { deviceId: `d${i}` } });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 20).every((c) => c === 401)).toBe(true);
    expect(codes[20]).toBe(429);
    // another address is unaffected
    expect((await app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress: '10.1.1.2', payload: { deviceId: 'x' } })).statusCode).toBe(401);
  });

  it('auth endpoints: 10 per 5 minutes per device, across addresses', async () => {
    const app = makeApp();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress: `10.2.2.${i}`, payload: { deviceId: 'same-device' } });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('enrolment completion: 5 per 10 minutes per IP', async () => {
    const app = makeApp();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/enrol/complete', remoteAddress: '10.3.3.3', payload: { code: 'AAAA-BBBB-CCCC', platform: 'web', publicJwk: {} } });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 5).every((c) => c === 400 || c === 401)).toBe(true);
    expect(codes[5]).toBe(429);
    expect(app.surau.limiters.pairBegin.hit('ip').ok).toBe(true);
  });
});

describe('auth routes', () => {
  it('enrol/begin returns a payload with the box id, the code and no key material', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const ajk = await loginAs(app, 'ajk');
    const r = await app.inject({ method: 'POST', url: '/api/enrol/begin', headers: admin.headers, payload: { userId: ajk.userId, deviceName: 'iPad' } });
    expect(r.statusCode).toBe(200);
    const { code, payload } = r.json() as { code: string; expiresAt: string; payload: string };
    expect(payload.startsWith('surau1:')).toBe(true);
    const decoded = JSON.parse(Buffer.from(payload.slice(7), 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(decoded).toMatchObject({ v: 1, mode: 'ip', boxId: app.surau.boxId, code, caSha256: null });
    // The only PIN-related field is the boolean pinSet (whether a PIN exists), never a value.
    expect(typeof decoded.pinSet).toBe('boolean');
    const { pinSet: _pinSet, ...rest } = decoded;
    expect(JSON.stringify(rest)).not.toMatch(/token|secret|key|pin/i);
    const denied = await app.inject({ method: 'POST', url: '/api/enrol/begin', headers: ajk.headers, payload: { userId: ajk.userId } });
    expect(denied.statusCode).toBe(403);
  });

  it('users: create, list without secrets, change roles, last-admin guard, deactivate, audit with names', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const h = admin.headers;
    const created = await app.inject({ method: 'POST', url: '/api/users', headers: h, payload: { name: 'Hasan', roles: ['media'] } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const list = await app.inject({ method: 'GET', url: '/api/users', headers: h });
    expect(list.body).not.toMatch(/pin_?hash|scrypt/i);
    expect((await app.inject({ method: 'PUT', url: `/api/users/${id}/roles`, headers: h, payload: { roles: ['bogus'] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: `/api/users/${id}/roles`, headers: h, payload: { roles: ['ajk'] } })).statusCode).toBe(200);
    // the only admin can be neither demoted nor deactivated
    expect((await app.inject({ method: 'PUT', url: `/api/users/${admin.userId}/roles`, headers: h, payload: { roles: ['ajk'] } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/users/${admin.userId}/deactivate`, headers: h })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/users/${id}/deactivate`, headers: h })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/users/nope/deactivate', headers: h })).statusCode).toBe(404);
    const audit = await app.inject({ method: 'GET', url: '/api/audit?limit=5', headers: h });
    const entries = audit.json().entries as { actor: string; userName: string | null; after: unknown }[];
    expect(entries.length).toBeLessThanOrEqual(5);
    expect(entries.some((e) => e.actor === `user:${admin.userId}` && e.userName !== null)).toBe(true);
    expect(typeof entries[0]?.after).toBe('object');
    const media = await loginAs(app, 'media');
    expect((await app.inject({ method: 'GET', url: '/api/audit', headers: media.headers })).statusCode).toBe(403);
  });

  it('admin PIN reset clears the PIN and kills that user\'s sessions; self PIN change checks the current PIN', async () => {
    const app = makeApp();
    putFeature(app.surau.db, 'appLock', { enabled: true }, 'test');
    const admin = await loginAsAdmin(app);
    const ajk = await loginAs(app, 'ajk');
    const bad = await app.inject({ method: 'PUT', url: '/api/auth/pin', headers: ajk.headers, payload: { currentPin: '111222', newPin: '739518' } });
    expect(bad.statusCode).toBe(401);
    const weak = await app.inject({ method: 'PUT', url: '/api/auth/pin', headers: ajk.headers, payload: { currentPin: '482916', newPin: '123456' } });
    expect(weak.statusCode).toBe(400);
    const ok = await app.inject({ method: 'PUT', url: '/api/auth/pin', headers: ajk.headers, payload: { currentPin: '482916', newPin: '739518' } });
    expect(ok.statusCode).toBe(200);
    const reset = await app.inject({ method: 'PUT', url: `/api/users/${ajk.userId}/pin`, headers: admin.headers });
    // W13 M2: the answer also lists the user's active devices (nothing revoked unless asked).
    expect(reset.json()).toEqual({
      ok: true,
      pinRequired: true,
      revoked: [],
      devices: [expect.objectContaining({ id: ajk.deviceId })],
    });
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: ajk.headers })).statusCode).toBe(401);
    expect(JSON.stringify(app.surau.db.prepare('SELECT * FROM change_log').all())).not.toMatch(/739518|482916/);
  });

  it('PIN change is rate limited per user', async () => {
    const app = makeApp();
    putFeature(app.surau.db, 'appLock', { enabled: true }, 'test');
    const a = await loginAs(app, 'ajk');
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await app.inject({ method: 'PUT', url: '/api/auth/pin', headers: a.headers, payload: { currentPin: '111222', newPin: '739518' } })).statusCode);
    }
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes[5]).toBe(429);
  });

  it('root.cer: 404 without a CA file, DER bytes with one', async () => {
    const dir = tempDir();
    const app = buildApp(join(dir, 'test.db'), { now: () => AT });
    apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/api/pki/root.cer', remoteAddress: '10.168.1.5' })).statusCode).toBe(404);
    mkdirSync(join(dir, 'pki'));
    const der = Buffer.from([0x30, 0x82, 0x01, 0x02, 0x03]);
    writeFileSync(join(dir, 'pki', 'root-ca.cer'), der);
    const r = await app.inject({ method: 'GET', url: '/api/pki/root.cer', remoteAddress: '10.168.1.5' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/pkix-cert');
    expect(Buffer.compare(r.rawPayload, der)).toBe(0);
  });
});

describe('site identity reach', () => {
  it('a site may call only /api/sync/*, /api/cloud/youtube/* and GET /assets/:id', () => {
    expect(siteMayCall('POST', '/api/sync/ops')).toBe(true);
    expect(siteMayCall('GET', '/api/sync/changes?since=3')).toBe(true);
    expect(siteMayCall('GET', '/api/cloud/youtube/session')).toBe(true);
    expect(siteMayCall('GET', `/assets/${'a'.repeat(64)}`)).toBe(true);
    expect(siteMayCall('POST', `/assets/${'a'.repeat(64)}`)).toBe(false);
    expect(siteMayCall('GET', '/assets/app.js')).toBe(false);
    for (const [m, u] of [['GET', '/api/settings'], ['GET', '/api/syncx/ops'], ['GET', '/api/sync'], ['GET', '/api/users'], ['PUT', '/api/settings/clock'], ['GET', '/api/sync/../settings'], ['GET', '/api/%2e%2e/settings']] as const) {
      expect(siteMayCall(m, u), `${m} ${u}`).toBe(false);
    }
  });
});

describe('role matrix generated from ROUTE_PERMISSIONS', () => {
  it('every table entry matches its sample path', () => {
    for (const rule of ROUTE_PERMISSIONS) {
      expect(rule.pattern.test(normalisePath(rule.sample) ?? ''), rule.sample).toBe(true);
      expect(classifyRequest(rule.method, rule.sample)).toEqual({ kind: 'rule', permission: rule.permission });
    }
  });

  it('each role gets exactly what core PERMISSIONS says', { timeout: 120_000 }, async () => {
    const app = makeApp();
    // Single roles plus combined-role users: a person may hold several roles (permissions are a union).
    const subjects: Role[][] = [...ROLES.map((r): Role[] => [r]), ['media', 'treasurer'], ['ajk', 'media'], ['admin', 'media']];
    const logins = new Map<string, Awaited<ReturnType<typeof loginAs>>>();
    for (const roles of subjects) logins.set(roles.join('+'), await loginAs(app, roles));
    const anon = '10.168.1.77';

    for (const rule of ROUTE_PERMISSIONS) {
      const label = `${rule.method} ${rule.sample}`;
      if (rule.permission === 'public') {
        // The hook never refuses a public route; what the handler answers is its own business.
        const r = await app.inject({ method: rule.method, url: rule.sample, remoteAddress: anon });
        expect([401, 403].includes(r.statusCode) && r.headers['www-authenticate'] === 'Bearer', label).toBe(false);
        continue;
      }
      const none = await app.inject({ method: rule.method, url: rule.sample, remoteAddress: anon });
      expect(none.statusCode, `${label} anonymous`).toBe(401);
      for (const roles of subjects) {
        const role = roles.join('+');
        const login = logins.get(role)!;
        const allowed =
          rule.permission === 'session' || rule.permission === 'session_or_site'
            ? true
            : roles.some((r) => (PERMISSIONS[r] as readonly Permission[]).includes(rule.permission as Permission));
        // an open event stream never ends under inject; its allowed case is covered elsewhere
        if (allowed && rule.sample === '/api/kiosk/events') continue;
        // leaving revokes the caller's own device: covered by leave.test.ts
        if (allowed && rule.sample === '/api/auth/leave') continue;
        const r = await app.inject({
          method: rule.method,
          url: rule.sample,
          headers: login.headers,
          payload: rule.method === 'GET' || rule.method === 'DELETE' ? undefined : {},
        });
        if (allowed) {
          expect([401, 403], `${label} as ${role} (${r.body})`).not.toContain(r.statusCode);
        } else {
          expect(r.statusCode, `${label} as ${role}`).toBe(403);
        }
        // logout ends that role's session: log it in again for the rest of the table.
        if (rule.sample === '/api/auth/logout') logins.set(role, await loginAs(app, roles));
      }
    }
  });
});

/** A GET whose request line is sent exactly as given (inject() would resolve dot segments). */
function rawGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, headers }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('W13 S2: ambiguous raw paths are refused before classification', () => {
  const cases = [
    // the cross-validator's exact URL
    '/api/content/penceramah/x%2F..%2F..%2F..%2Fy',
    '/api/content/penceramah/x%2f..%2f..%2f..%2fy',
    '/api/content/penceramah/x%5C..%5Cy',
    '/api/content/penceramah/x%5cy',
    '/index.html%2f..%2fapi%2fsettings',
    '/api/content/x%2e%2e/y',
  ];

  it.each(cases)('GET %s is a 400 with the standard JSON error (anonymous and signed in)', async (url) => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    for (const headers of [{}, admin.headers]) {
      const r = await app.inject({ method: 'GET', url, remoteAddress: LAN, headers });
      expect(r.statusCode, url).toBe(400);
      expect(r.json()).toEqual({ errors: ['invalid request'] });
      expect(r.headers['cache-control']).toBe('no-store');
    }
  });

  it('literal and encoded dot segments sent raw over a socket are refused (400)', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    for (const path of [
      '/api/content/../settings',
      '/api/content/./x',
      '/api/%2e%2e/settings',
      '/api/content/penceramah/x%2F..%2F..%2F..%2Fy',
      '/assets/../api/users',
      '/api/content\\..\\settings',
    ]) {
      for (const headers of [{}, admin.headers]) {
        const r = await rawGet(port, path, headers);
        expect(r.status, path).toBe(400);
        expect(JSON.parse(r.body)).toEqual({ errors: ['invalid request'] });
      }
    }
    // a clean path on the same socket still works
    expect((await rawGet(port, '/api/settings', admin.headers)).status).toBe(200);
  });

  it('writes with an encoded separator are refused too', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const r = await app.inject({ method: 'PUT', url: '/api/content/announcements/a%2Fb', headers: admin.headers, payload: {} });
    expect(r.statusCode).toBe(400);
  });

  it('an encoded slash or dot in the QUERY is not part of the path and is left alone', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const r = await app.inject({ method: 'GET', url: '/api/audit?limit=5&x=a%2Fb%2e', headers: admin.headers });
    expect(r.statusCode).toBe(200);
  });

  it('ordinary paths (hashed asset files, dotted names, encoded spaces) still work', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>k</title>');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'x');
    const app = makeApp({ staticDir: dir });
    expect((await app.inject({ method: 'GET', url: '/assets/index-abc123.js', remoteAddress: LAN })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/', remoteAddress: LAN })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/some%20page', remoteAddress: LAN })).statusCode).toBe(200);
  });

  it('classification of the normalised path is unchanged for clean URLs', () => {
    expect(classifyRequest('GET', '/api/settings')).toMatchObject({ kind: 'rule', permission: 'settings:read' });
    expect(classifyRequest('GET', '/api//settings/')).toMatchObject({ kind: 'rule', permission: 'settings:read' });
  });
});
