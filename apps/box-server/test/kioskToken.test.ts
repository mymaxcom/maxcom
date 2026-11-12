import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoxStateView } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { loginAs } from './authHelpers.ts';
import type { TlsMaterial } from '../src/tls.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
const LOOP = '127.0.0.1';
const LAN = '10.168.1.60';
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const WRONG = 'f'.repeat(64);
const TLS = { mode: 'ip', pfx: Buffer.alloc(0), passphrase: '', notAfter: new Date('2030-01-01'), ipSan: ['10.168.0.20', '127.0.0.1'], dnsSan: [] } as TlsMaterial;

function make(kioskToken?: string): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-kt-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'surau.db'), {
    now: () => new Date('2026-11-09T10:00:00Z'),
    dataDir: dir,
    tls: TLS,
    httpsPort: 8443,
    ...(kioskToken !== undefined ? { kioskToken } : {}),
  });
  apps.push(app);
  return app;
}
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.SURAU_KIOSK_TOKEN;
});
const get = (app: FastifyInstance, url: string, headers: Record<string, string> = {}, remoteAddress = LOOP) =>
  app.inject({ method: 'GET', url, remoteAddress, headers });

describe('without a kiosk token (Windows, development)', () => {
  it('loopback keeps the setup QR, netcheck and the anonymous kiosk read', async () => {
    const app = make();
    expect(((await get(app, '/api/box/state')).json() as BoxStateView).qr?.payload).toMatch(/^maxcom1:/);
    expect((await get(app, '/api/box/netcheck')).statusCode).toBe(200);
    expect((await get(app, '/api/kiosk/bundle')).statusCode).toBe(200);
  });
});

describe('with SURAU_KIOSK_TOKEN', () => {
  it('loopback without the cookie is no kiosk: state, netcheck and the kiosk read are refused', async () => {
    const app = make(TOKEN);
    expect((await get(app, '/api/box/state')).statusCode).toBe(401);
    expect((await get(app, '/api/box/netcheck')).statusCode).toBe(401);
    expect((await get(app, '/api/kiosk/bundle')).statusCode).toBe(401);
  });

  it('an admin session on loopback without the cookie still gets no QR and no netcheck', async () => {
    const app = make(TOKEN);
    const admin = await loginAs(app, 'admin');
    const state = await get(app, '/api/box/state', admin.headers);
    expect(state.statusCode).toBe(200);
    expect((state.json() as BoxStateView).qr).toBeUndefined();
    expect((await get(app, '/api/box/netcheck', admin.headers)).statusCode).toBe(404);
  });

  it('the right cookie restores all three', async () => {
    const app = make(TOKEN);
    const h = { cookie: `other=1; mxk=${TOKEN}` };
    expect(((await get(app, '/api/box/state', h)).json() as BoxStateView).qr?.payload).toMatch(/^maxcom1:/);
    expect((await get(app, '/api/box/netcheck', h)).statusCode).toBe(200);
    expect((await get(app, '/api/kiosk/bundle', h)).statusCode).toBe(200);
  });

  it('a wrong value, a wrong length and a malformed header are refused', async () => {
    const app = make(TOKEN);
    for (const cookie of [`mxk=${WRONG}`, `mxk=${TOKEN.slice(0, 63)}`, `mxk=${TOKEN}0`, 'mxk', '=;;mxk=', `xmxk=${TOKEN}`]) {
      expect((await get(app, '/api/box/netcheck', { cookie })).statusCode).toBe(401);
      expect((await get(app, '/api/kiosk/bundle', { cookie })).statusCode).toBe(401);
    }
  });

  it('the right cookie from a LAN address is still no kiosk', async () => {
    const app = make(TOKEN);
    const h = { cookie: `mxk=${TOKEN}` };
    expect((await get(app, '/api/box/netcheck', h, LAN)).statusCode).toBe(401);
    expect((await get(app, '/api/kiosk/bundle', h, LAN)).statusCode).toBe(401);
  });

  it('the token comes from the environment too', async () => {
    process.env.SURAU_KIOSK_TOKEN = TOKEN;
    const app = make();
    expect((await get(app, '/api/box/netcheck')).statusCode).toBe(401);
    expect((await get(app, '/api/box/netcheck', { cookie: `mxk=${TOKEN}` })).statusCode).toBe(200);
  });

  it('a token that is not 64 hex characters fails the start without echoing it', () => {
    for (const bad of ['0123456789', 'z'.repeat(64), TOKEN + 'a']) {
      let message = '';
      try {
        make(bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/SURAU_KIOSK_TOKEN/);
      expect(message).not.toContain(bad);
    }
  });

  it('no response body or header contains the token', async () => {
    const app = make(TOKEN);
    const h = { cookie: `mxk=${TOKEN}` };
    for (const url of ['/api/box/state', '/api/box/info', '/api/box/netcheck', '/api/kiosk/bundle', '/api/nosuch']) {
      for (const headers of [h, {}]) {
        const r = await get(app, url, headers);
        expect(r.body).not.toContain(TOKEN);
        expect(JSON.stringify(r.headers)).not.toContain(TOKEN);
      }
    }
  });
});
