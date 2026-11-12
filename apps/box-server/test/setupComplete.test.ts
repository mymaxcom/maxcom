import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoxInfo, NetCheckView } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { createUser } from '../src/auth/users.ts';
import { getSettings, putFeature } from '../src/settingsStore.ts';
import { readFeed } from '../src/sync/feed.ts';
import { issueNonce, verifyRecoveryCode } from '../src/setup/codes.ts';
import { readBoxJson } from '../src/setup/state.ts';
import { TEST_PIN, dbBytes, makeDevice, screenNonce, unlockWith } from './support/joinHelpers.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
const clock = { t: Date.parse('2026-11-09T10:00:00Z') };
function make(): { app: FastifyInstance; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'surau-setup-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'surau.db'), { now: () => new Date(clock.t), dataDir: dir });
  apps.push(app);
  return { app, dir };
}
afterEach(async () => {
  clock.t = Date.parse('2026-11-09T10:00:00Z');
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let ip = 0;
const lan = (): string => `10.168.7.${++ip}`;

async function form(nonce: string, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const d = await makeDevice();
  return {
    nonce,
    surauName: 'Surau Al-Hidayah',
    boxName: 'MAXCOM Dewan Utama',
    adminName: 'Haji Ali',
    deviceName: 'vivo Y36',
    publicJwk: d.publicJwk,
    platform: 'android',
    pin: TEST_PIN,
    ...over,
    __dev: d,
  };
}
const post = (app: FastifyInstance, f: Record<string, unknown>, remoteAddress = lan()) => {
  const { __dev: _d, ...payload } = f;
  return app.inject({ method: 'POST', url: '/api/setup/complete', remoteAddress, payload });
};

describe('first setup', () => {
  it('creates the first Pentadbir, surau, box name, ids and a recovery code', async () => {
    const { app, dir } = make();
    const f = await form(await screenNonce(app));
    const r = await post(app, f);
    expect(r.statusCode).toBe(201);
    expect(r.headers['cache-control']).toContain('no-store');
    const j = r.json();
    expect(j.roles).toEqual(['admin']);
    expect(j.recoveryCode).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    expect(j.recoveryCode).toHaveLength(19);
    expect(j.surauId).toMatch(/^[a-z2-7]{12}$/);
    expect(j.boxName).toBe('MAXCOM Dewan Utama');
    expect(r.body).not.toContain(TEST_PIN);
    const db = app.surau.db;
    expect(getSettings(db).surauInfo.name).toBe('Surau Al-Hidayah');
    expect(db.prepare("SELECT value FROM meta WHERE key = 'box_name'").get()?.value).toBe('MAXCOM Dewan Utama');
    expect(db.prepare("SELECT value FROM meta WHERE key = 'surau_id'").get()?.value).toBe(j.surauId);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n).toBe(1);
    const dev = db.prepare('SELECT platform, name FROM devices').all();
    expect(dev).toHaveLength(1);
    expect(dev[0]).toMatchObject({ platform: 'android', name: 'vivo Y36' });
    expect(verifyRecoveryCode(db, j.recoveryCode)).toBe(true);
    expect(readBoxJson(dir)).toEqual({ boxName: 'MAXCOM Dewan Utama', surauName: 'Surau Al-Hidayah' });
    // the box is now active, the PIN unlocks, and the surau name is public
    expect(((await app.inject({ method: 'GET', url: '/api/box/info' })).json() as BoxInfo).state).toBe('active');
    // the PIN only matters while the surau's app lock is on (off by default in this code base)
    putFeature(db, 'appLock', { enabled: true }, 'test');
    const un = await unlockWith(app, j.deviceId, f.__dev as never, TEST_PIN);
    expect(un.status).toBe(200);
    expect((await unlockWith(app, j.deviceId, f.__dev as never, '111222')).status).not.toBe(200);
    expect(db.prepare("SELECT ok, detail FROM auth_log WHERE event = 'setup'").get()).toMatchObject({ ok: 1 });
  });

  it('a second setup with a fresh nonce is 409 already_set_up and writes nothing', async () => {
    const { app } = make();
    expect((await post(app, await form(await screenNonce(app)))).statusCode).toBe(201);
    const fresh = issueNonce(app.surau.db, 'setup', new Date(clock.t)).nonce;
    const r = await post(app, await form(fresh, { adminName: 'Orang Lain' }));
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('already_set_up');
    expect(app.surau.db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n).toBe(1);
    expect(app.surau.db.prepare('SELECT COUNT(*) AS n FROM devices').get()?.n).toBe(1);
  });

  it('two phones on one nonce: exactly one winner, the other is 401 and writes nothing', async () => {
    const { app } = make();
    const nonce = await screenNonce(app);
    const [a, b] = await Promise.all([post(app, await form(nonce)), post(app, await form(nonce, { adminName: 'Kedua' }))]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(app.surau.db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n).toBe(1);
    expect(app.surau.db.prepare('SELECT COUNT(*) AS n FROM devices').get()?.n).toBe(1);
  });

  it('two phones on two different nonces: one 201, one 409', async () => {
    const { app } = make();
    const n1 = await screenNonce(app);
    const f1 = await form(n1);
    // a second nonce issued behind the screen's back (an older QR still on a phone is a different nonce)
    const n2 = issueNonce(app.surau.db, 'setup', new Date(clock.t)).nonce;
    const f2 = await form(n2, { adminName: 'Kedua' });
    const r1 = await post(app, f1);
    const r2 = await post(app, f2);
    // issuing n2 expired n1 (one live nonce per type): the first is stale, the second wins
    expect([r1.statusCode, r2.statusCode]).toEqual([401, 201]);
    const r3 = await post(app, await form(issueNonce(app.surau.db, 'setup', new Date(clock.t)).nonce, { adminName: 'Ketiga' }));
    expect(r3.statusCode).toBe(409);
    expect(app.surau.db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n).toBe(1);
  });

  it('after a CLI-made user exists the setup route is 409 even with a fresh nonce', async () => {
    const { app } = make();
    const nonce = await screenNonce(app);
    createUser(app.surau.db, { name: 'Dari CLI', roles: ['admin'] }, 'cli');
    const r = await post(app, await form(nonce));
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('already_set_up');
    expect(app.surau.db.prepare('SELECT COUNT(*) AS n FROM devices').get()?.n).toBe(0);
    // and the screen shows no setup QR any more
    const st = (await app.inject({ method: 'GET', url: '/api/box/state', remoteAddress: '127.0.0.1' })).json();
    expect(st.state).toBe('recovery');
  });

  it('refuses a kiosk platform, a weak PIN, a missing surau name, a bad key; the nonce survives those', async () => {
    const { app } = make();
    const nonce = await screenNonce(app);
    expect((await post(app, await form(nonce, { platform: 'kiosk' }))).statusCode).toBe(400);
    const weak = await post(app, await form(nonce, { pin: '123456' }));
    expect(weak.statusCode).toBe(400);
    expect(weak.json().code).toBe('pin_policy');
    expect((await post(app, await form(nonce, { surauName: '   ' }))).statusCode).toBe(400);
    expect((await post(app, await form(nonce, { boxName: '' }))).statusCode).toBe(400);
    expect((await post(app, await form(nonce, { adminName: '' }))).statusCode).toBe(400);
    expect((await post(app, await form(nonce, { publicJwk: { kty: 'EC' } }))).statusCode).toBe(400);
    expect((await post(app, await form(nonce, { pin: undefined }))).statusCode).toBe(400);
    expect(app.surau.db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n).toBe(0);
    // the same nonce still works for a correct form
    expect((await post(app, await form(nonce))).statusCode).toBe(201);
  });

  it('a wrong, malformed, expired or reused nonce is 401 bad_code', async () => {
    const { app } = make();
    for (const n of ['x'.repeat(43), 'short', '', 'A'.repeat(43)]) {
      const r = await post(app, await form(n));
      expect(r.statusCode, n).toBe(401);
      expect(r.json().code).toBe('bad_code');
    }
    const nonce = await screenNonce(app);
    clock.t += 11 * 60_000;
    const late = await post(app, await form(nonce));
    expect(late.statusCode).toBe(401);
    expect(app.surau.db.prepare("SELECT detail FROM auth_log WHERE event = 'setup' ORDER BY id DESC LIMIT 1").get()?.detail).toBe('expired');
    expect(app.surau.db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n).toBe(0);
  });

  it('is limited to 5 per 10 minutes per address', async () => {
    const { app } = make();
    const addr = '10.168.9.9';
    for (let i = 0; i < 5; i++) expect((await post(app, await form('x'.repeat(43)), addr)).statusCode).toBe(401);
    expect((await post(app, await form('x'.repeat(43)), addr)).statusCode).toBe(429);
  });

  it('neither the database nor the feed holds the recovery code, the nonce or the PIN; the feed carries only users, devices and settings', async () => {
    const { app, dir } = make();
    const nonce = await screenNonce(app);
    const r = await post(app, await form(nonce));
    const code = r.json().recoveryCode as string;
    app.surau.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    for (const bytes of dbBytes(dir)) {
      expect(bytes.includes(Buffer.from(code)), 'recovery code with dashes').toBe(false);
      expect(bytes.includes(Buffer.from(code.replaceAll('-', ''))), 'recovery code').toBe(false);
      expect(bytes.includes(Buffer.from(nonce)), 'nonce').toBe(false);
      expect(bytes.includes(Buffer.from(TEST_PIN)), 'pin').toBe(false);
    }
    const feed = readFeed(app.surau.db, 0, 500, { users: true, devices: true });
    expect([...new Set(feed.entries.map((e) => e.entity))].sort()).toEqual(['device', 'settings', 'user']);
    expect(new Set(feed.entries.filter((e) => e.entity === 'user').map((e) => e.entityId)).size).toBe(1);
    const dump = JSON.stringify(feed);
    for (const secret of [code, code.replaceAll('-', ''), nonce, TEST_PIN, 'pin_hash', 'recovery']) {
      expect(dump.includes(secret), secret).toBe(false);
    }
    const log = JSON.stringify(app.surau.db.prepare('SELECT detail FROM auth_log').all());
    expect(log).not.toContain(nonce);
    expect(log).not.toContain(code);
  });
});

describe('probe', () => {
  it('spends its nonce and moves lastPhoneSeenAt', async () => {
    const { app } = make();
    const before = (await app.inject({ method: 'GET', url: '/api/box/netcheck', remoteAddress: '127.0.0.1' })).json() as NetCheckView;
    expect(before.lastPhoneSeenAt).toBeNull();
    const { parseBoxQr } = await import('@surau/core');
    const nonce = parseBoxQr(before.probe!.payload).nonce;
    const ok = await app.inject({ method: 'POST', url: '/api/setup/probe', remoteAddress: '10.168.1.44', payload: { nonce } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    const again = await app.inject({ method: 'POST', url: '/api/setup/probe', remoteAddress: '10.168.1.44', payload: { nonce } });
    expect(again.statusCode).toBe(404);
    const after = (await app.inject({ method: 'GET', url: '/api/box/netcheck', remoteAddress: '127.0.0.1' })).json() as NetCheckView;
    expect(after.lastPhoneSeenAt).toBe(new Date(clock.t).toISOString());
    // a setup nonce does not work as a probe
    const setupNonce = await screenNonce(app);
    expect((await app.inject({ method: 'POST', url: '/api/setup/probe', remoteAddress: '10.168.1.45', payload: { nonce: setupNonce } })).statusCode).toBe(404);
  });
});
