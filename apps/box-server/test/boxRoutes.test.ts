import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { boxQrMessage, parseBoxQr } from '@surau/core';
import type { BoxInfo, BoxStateView, NetCheckView } from '@surau/core';
import { buildApp } from '../src/app.ts';
import type { TlsMaterial } from '../src/tls.ts';
import { issueRecoveryCode } from '../src/setup/codes.ts';
import { readBoxJson } from '../src/setup/state.ts';
import { loginAs } from './authHelpers.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
const LOOP = '127.0.0.1';
const LAN = '10.168.1.60';
const TLS = { mode: 'ip', pfx: Buffer.alloc(0), passphrase: '', notAfter: new Date('2030-01-01'), ipSan: ['10.168.0.20', '127.0.0.1'], dnsSan: [] } as TlsMaterial;

function make(opts: Parameters<typeof buildApp>[1] = {}): { app: FastifyInstance; dir: string; clock: { t: number } } {
  const dir = mkdtempSync(join(tmpdir(), 'surau-box-'));
  dirs.push(dir);
  const clock = { t: Date.parse('2026-11-09T10:00:00Z') };
  const app = buildApp(join(dir, 'surau.db'), { now: () => new Date(clock.t), dataDir: dir, tls: TLS, httpsPort: 8443, ...opts });
  apps.push(app);
  return { app, dir, clock };
}
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const get = (app: FastifyInstance, url: string, remoteAddress = LOOP, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, remoteAddress, headers });

describe('GET /api/box/info', () => {
  it('is anonymous, carries the fingerprint and no nonce or payload', async () => {
    const { app } = make();
    const r = await get(app, '/api/box/info', LAN);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toContain('no-store');
    const i = r.json() as BoxInfo;
    expect(i.keyFp).toMatch(/^[0-9a-f]{16}$/);
    expect(i.boxId).toBe(app.surau.boxId);
    expect(i.state).toBe('setup');
    expect(i.https).toBe(true);
    expect(i.name).toBe(`MAXCOM ${i.boxId.slice(0, 4).toUpperCase()}`);
    expect(r.body).not.toMatch(/nonce|payload|"qr"/);
    expect(i.pub.kty).toBe('EC');
    // the server reports its own product version (a checkout: the package version; a release: release.json)
    expect(i.version).toMatch(/^20\d\d\.(0[1-9]|1[0-2])\.\d{1,2}$/);
  });
});

describe('GET /api/box/state', () => {
  it('loopback in setup gets a QR the core parser accepts and the box key verifies', async () => {
    const { app } = make();
    const v = (await get(app, '/api/box/state')).json() as BoxStateView;
    expect(v.state).toBe('setup');
    expect(v.qr?.payload.startsWith('maxcom1:')).toBe(true);
    const p = parseBoxQr(v.qr!.payload);
    expect(p.type).toBe('setup');
    expect(p.boxId).toBe(v.boxId);
    expect(p.keyFp).toBe(v.keyFp);
    expect(p.box).toBe('https://10.168.0.20:8443');
    const { sig, ...rest } = p;
    const info = (await get(app, '/api/box/info', LAN)).json() as BoxInfo;
    expect(
      verify('sha256', boxQrMessage(rest), { key: createPublicKey({ key: { ...info.pub }, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')),
    ).toBe(true);
    expect(new Date(v.qr!.expiresAt).getTime() - Date.parse('2026-11-09T10:00:00Z')).toBe(10 * 60_000);
    expect(p.exp - p.iat).toBe(600);
  });

  it('a paired display gets the state and no QR', async () => {
    const { app } = make();
    const admin = await loginAs(app, 'admin'); // makes the box active; use a fresh setup box below for the setup case
    issueRecoveryCode(app.surau.db); // a QR is only shown when a recovery code exists
    const begin = (await app.inject({ method: 'POST', url: '/api/kiosk/pair/begin', remoteAddress: LAN })).json();
    await app.inject({ method: 'POST', url: '/api/kiosk/pair/approve', headers: admin.headers, payload: { code: begin.code } });
    const poll = await app.inject({ method: 'POST', url: '/api/kiosk/pair/poll', remoteAddress: LAN, payload: { pollToken: begin.pollToken } });
    const cookie = String(poll.headers['set-cookie']).split(';')[0]!;
    // back to recovery: revoke the admin's device so a QR would be due
    app.surau.db.prepare("UPDATE devices SET revoked_at = '2026-11-09T09:00:00Z' WHERE platform <> 'kiosk'").run();
    const viaCookie = await get(app, '/api/box/state', LAN, { cookie });
    expect(viaCookie.statusCode).toBe(200);
    const v = viaCookie.json() as BoxStateView;
    expect(v.state).toBe('recovery');
    expect(v.reason).toBe('no_admin');
    expect(v.qr).toBeUndefined();
    expect(viaCookie.body).not.toContain('maxcom1:');
    const loop = (await get(app, '/api/box/state')).json() as BoxStateView;
    expect(loop.qr).toBeDefined();
    expect(parseBoxQr(loop.qr!.payload).type).toBe('recovery');
  });

  it('anonymous LAN and a bearer session see no QR; anonymous is 401', async () => {
    const { app } = make();
    expect((await get(app, '/api/box/state', LAN)).statusCode).toBe(401);
    const ajk = await loginAs(app, 'ajk');
    const r = await get(app, '/api/box/state', LAN, ajk.headers);
    expect(r.statusCode).toBe(200);
    expect((r.json() as BoxStateView).qr).toBeUndefined();
  });

  it('active and locked states carry no QR', async () => {
    const { app } = make();
    await loginAs(app, 'admin');
    const a = (await get(app, '/api/box/state')).json() as BoxStateView;
    expect(a.state).toBe('active');
    expect(a.qr).toBeUndefined();
    app.surau.db.prepare("INSERT INTO sync_state (key, value) VALUES ('suspended', '1')").run();
    const l = (await get(app, '/api/box/state')).json() as BoxStateView;
    expect(l.state).toBe('locked');
    expect(l.qr).toBeUndefined();
  });

  it('two polls a second apart return the same payload; after ten minutes a new nonce', async () => {
    const { app, clock } = make();
    const a = (await get(app, '/api/box/state')).json() as BoxStateView;
    clock.t += 1000;
    const b = (await get(app, '/api/box/state')).json() as BoxStateView;
    expect(b.qr!.payload).toBe(a.qr!.payload);
    clock.t += 10 * 60_000;
    const c = (await get(app, '/api/box/state')).json() as BoxStateView;
    expect(c.qr!.payload).not.toBe(a.qr!.payload);
    expect(parseBoxQr(c.qr!.payload).nonce).not.toBe(parseBoxQr(a.qr!.payload).nonce);
  });

  it('a spent nonce is replaced on the next poll', async () => {
    const { app } = make();
    const a = (await get(app, '/api/box/state')).json() as BoxStateView;
    app.surau.db.prepare("UPDATE box_codes SET used_at = '2026-11-09T10:00:01Z'").run();
    const b = (await get(app, '/api/box/state')).json() as BoxStateView;
    expect(b.qr!.payload).not.toBe(a.qr!.payload);
  });

  it('shows the surau name only after surauInfo was saved', async () => {
    const { app } = make();
    expect(((await get(app, '/api/box/state')).json() as BoxStateView).surauName).toBeNull();
    const admin = await loginAs(app, 'admin');
    const put = await app.inject({ method: 'PUT', url: '/api/settings/surauInfo', headers: admin.headers, payload: { name: 'Surau Al-Hidayah' } });
    expect(put.statusCode).toBe(200);
    expect(((await get(app, '/api/box/state')).json() as BoxStateView).surauName).toBe('Surau Al-Hidayah');
  });
});

describe('GET /api/box/netcheck', () => {
  it('loopback lists interfaces and https; a bearer session and a paired cookie are 404', async () => {
    const { app } = make();
    const admin = await loginAs(app, 'admin');
    const r = await get(app, '/api/box/netcheck');
    expect(r.statusCode).toBe(200);
    const v = r.json() as NetCheckView;
    expect(v.https).toEqual({ listening: true, port: 8443 });
    expect(Array.isArray(v.interfaces)).toBe(true);
    expect(parseBoxQr(v.probe!.payload).type).toBe('probe');
    expect((await get(app, '/api/box/netcheck', LAN, admin.headers)).statusCode).toBe(404);
    const begin = (await app.inject({ method: 'POST', url: '/api/kiosk/pair/begin', remoteAddress: LAN })).json();
    await app.inject({ method: 'POST', url: '/api/kiosk/pair/approve', headers: admin.headers, payload: { code: begin.code } });
    const poll = await app.inject({ method: 'POST', url: '/api/kiosk/pair/poll', remoteAddress: LAN, payload: { pollToken: begin.pollToken } });
    const cookie = String(poll.headers['set-cookie']).split(';')[0]!;
    expect((await get(app, '/api/box/netcheck', LAN, { cookie })).statusCode).toBe(404);
  });

  it('lastPhoneSeenAt follows a non-loopback event in the last 10 minutes', async () => {
    const { app, clock } = make();
    expect(((await get(app, '/api/box/netcheck')).json() as NetCheckView).lastPhoneSeenAt).toBeNull();
    const at = new Date(clock.t - 60_000).toISOString();
    app.surau.db.prepare("INSERT INTO auth_log (at, event, ip, ok) VALUES (?, 'net_probe', ?, 1)").run(at, LAN);
    app.surau.db.prepare("INSERT INTO auth_log (at, event, ip, ok) VALUES (?, 'challenge', '127.0.0.1', 1)").run(new Date(clock.t).toISOString());
    expect(((await get(app, '/api/box/netcheck')).json() as NetCheckView).lastPhoneSeenAt).toBe(at);
    clock.t += 11 * 60_000;
    expect(((await get(app, '/api/box/netcheck')).json() as NetCheckView).lastPhoneSeenAt).toBeNull();
  });

  it('shows no address of any phone', async () => {
    const { app, clock } = make();
    app.surau.db.prepare("INSERT INTO auth_log (at, event, ip, ok) VALUES (?, 'net_probe', ?, 1)").run(new Date(clock.t).toISOString(), '10.99.88.77');
    expect((await get(app, '/api/box/netcheck')).body).not.toContain('10.99.88.77');
  });
});

describe('GET /api/kiosk/cloud and PUT /api/box/name', () => {
  it('cloud status reads sync_state and the cloudSync switch', async () => {
    const { app } = make();
    expect((await get(app, '/api/kiosk/cloud')).json()).toEqual({ linked: false, lastOkAt: null, cloudSyncEnabled: true });
    app.surau.db.prepare("INSERT INTO sync_state (key, value) VALUES ('linked', '1'), ('last_pull', '2026-11-09T09:55:00.000Z')").run();
    const j = (await get(app, '/api/kiosk/cloud')).json() as { linked: boolean; lastOkAt: string };
    expect(j.linked).toBe(true);
    expect(j.lastOkAt).toBe('2026-11-09T09:55:00.000Z');
  });

  it('rename: 61 chars is 400, AJK is 403, admin succeeds and box.json follows', async () => {
    const { app, dir } = make();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const put = (headers: Record<string, string>, name: unknown) =>
      app.inject({ method: 'PUT', url: '/api/box/name', headers, remoteAddress: LAN, payload: { name } });
    expect((await put(admin.headers, 'x'.repeat(61))).statusCode).toBe(400);
    expect((await put(ajk.headers, 'MAXCOM Baru')).statusCode).toBe(403);
    const ok = await put(admin.headers, ' MAXCOM Dewan Utama ');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ name: 'MAXCOM Dewan Utama' });
    expect(((await get(app, '/api/box/info', LAN)).json() as BoxInfo).name).toBe('MAXCOM Dewan Utama');
    expect(readBoxJson(dir)?.boxName).toBe('MAXCOM Dewan Utama');
    expect(readFileSync(join(dir, 'box.json'), 'utf8')).not.toMatch(/key|secret|token/i);
  });
});

describe('cloud role', () => {
  it('answers 404 on every box-screen route, even anonymous', async () => {
    const { app } = make({ role: 'cloud', tls: null });
    for (const url of ['/api/box/info', '/api/box/state', '/api/box/netcheck']) {
      expect((await get(app, url, LAN)).statusCode, url).toBe(404);
    }
    expect((await app.inject({ method: 'PUT', url: '/api/box/name', remoteAddress: LAN, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/setup/complete', remoteAddress: LAN, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/recovery/complete', remoteAddress: LAN, payload: {} })).statusCode).toBe(404);
  });
});
