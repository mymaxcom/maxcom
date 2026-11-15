import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoxStateView } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { boxNameOf, isBoxName, lanIpv4Of, preferredOrigin } from '../src/boxName.ts';
import type { TlsMaterial } from '../src/tls.ts';
import { loginAs, loginAsAdmin } from './authHelpers.ts';

const mat = (ipSan: string[], dnsSan: string[]): TlsMaterial =>
  ({ mode: 'ip', pfx: Buffer.alloc(0), passphrase: '', notAfter: new Date('2030-01-01'), ipSan, dnsSan }) as TlsMaterial;

const LEGACY = mat(['10.168.0.20', '127.0.0.1'], ['localhost', 'box.surau.local']);
const NAMED = mat(['10.168.0.20', '127.0.0.1'], ['localhost', 'box1-surau.local']);

describe('boxName helpers', () => {
  it('accepts exactly box1..box99 single-label names', () => {
    for (const ok of ['box1-surau.local', 'box9-surau.local', 'box10-surau.local', 'box99-surau.local']) expect(isBoxName(ok), ok).toBe(true);
    for (const bad of ['box0-surau.local', 'box100-surau.local', 'box01-surau.local', 'box.surau.local', 'box1.surau.local', 'evilbox1-surau.local', 'box1-surau.local.evil.com', 'box1-surau.localx', '']) {
      expect(isBoxName(bad), bad).toBe(false);
    }
  });

  it('the numbered name is preferred; legacy box.surau.local is ignored; null without a cert', () => {
    expect(boxNameOf(NAMED)).toBe('box1-surau.local');
    expect(boxNameOf(mat([], ['box.surau.local', 'box3-surau.local']))).toBe('box3-surau.local');
    expect(boxNameOf(LEGACY)).toBeNull();
    expect(boxNameOf(mat(['10.0.0.2'], ['localhost']))).toBeNull();
    expect(boxNameOf(null)).toBeNull();
  });

  it('lanIpv4Of keeps LAN IPv4 only', () => {
    expect(lanIpv4Of(mat(['10.168.0.20', '127.0.0.1', '::1', 'fe80::1', '10.0.0.5'], []))).toEqual(['10.168.0.20', '10.0.0.5']);
    expect(lanIpv4Of(null)).toEqual([]);
  });

  it('preferredOrigin: name first, IP fallback, legacy root keeps the IP', () => {
    expect(preferredOrigin(NAMED, 8443)).toBe('https://box1-surau.local:8443');
    expect(preferredOrigin(NAMED, 443)).toBe('https://box1-surau.local');
    expect(preferredOrigin(LEGACY, 8443)).toBe('https://10.168.0.20:8443');
    expect(preferredOrigin(mat(['::2'], []), 8443)).toBe('https://[::2]:8443');
    expect(preferredOrigin(mat(['127.0.0.1'], ['localhost']), 8443)).toBe('');
    expect(preferredOrigin(null, 8443)).toBe('');
  });
});

describe('payloads carry the name', () => {
  const apps: FastifyInstance[] = [];
  const dirs: string[] = [];
  const make = (opts: Parameters<typeof buildApp>[1]): FastifyInstance => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-bname-'));
    dirs.push(dir);
    const app = buildApp(join(dir, 'surau.db'), { dataDir: dir, httpsPort: 8443, ...opts });
    apps.push(app);
    return app;
  };
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close().catch(() => undefined);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const decode = (p: string): Record<string, unknown> => JSON.parse(Buffer.from(p.slice(7), 'base64url').toString('utf8')) as Record<string, unknown>;
  const healthName = async (app: FastifyInstance): Promise<unknown> =>
    ((await app.inject({ method: 'GET', url: '/api/health', remoteAddress: '10.168.0.60' })).json() as { name: unknown }).name;

  it('/api/health carries name (anonymous too); null on a legacy root or without TLS', async () => {
    expect(await healthName(make({ tls: NAMED }))).toBe('box1-surau.local');
    expect(await healthName(make({ tls: LEGACY }))).toBeNull();
    expect(await healthName(make({ tls: null }))).toBeNull();
  });

  it('/api/box/info keeps boxId and the display name, and adds localName', async () => {
    const app = make({ tls: NAMED });
    const i = (await app.inject({ method: 'GET', url: '/api/box/info', remoteAddress: '10.168.0.60' })).json() as BoxStateView;
    expect(i.boxId).toBe(app.surau.boxId);
    expect(i.name).toBe(`MAXCOM ${i.boxId.slice(0, 4).toUpperCase()}`);
    expect(i.localName).toBe('box1-surau.local');
    const legacy = make({ tls: LEGACY });
    const l = (await legacy.inject({ method: 'GET', url: '/api/box/info', remoteAddress: '10.168.0.60' })).json() as BoxStateView;
    expect(l.localName).toBeNull();
  });

  it('the state view carries the name while the signed QR keeps the IP origin', async () => {
    const app = make({ tls: NAMED });
    const v = (await app.inject({ method: 'GET', url: '/api/box/state', remoteAddress: '127.0.0.1' })).json() as BoxStateView;
    expect(v.localName).toBe('box1-surau.local');
    expect(Buffer.from(v.qr!.payload.slice(8), 'base64url').toString('utf8')).toContain('"box":"https://10.168.0.20:8443"');
  });

  it('enrolment payload: IP box, plus name and ips on a new root; ips only on a legacy root', async () => {
    for (const [tls, named] of [[NAMED, true], [LEGACY, false]] as const) {
      const app = make({ tls });
      const admin = await loginAsAdmin(app);
      const ajk = await loginAs(app, 'ajk');
      const r = await app.inject({ method: 'POST', url: '/api/enrol/begin', headers: admin.headers, payload: { userId: ajk.userId, deviceName: 'Telefon' } });
      const d = decode((r.json() as { payload: string }).payload);
      expect(d.box).toBe('https://10.168.0.20:8443');
      if (named) {
        expect(d.name).toBe('box1-surau.local');
        expect(d.ips).toEqual(['10.168.0.20']);
      } else {
        expect(d).not.toHaveProperty('name');
        expect(d.ips).toEqual(['10.168.0.20']);
      }
    }
  });

  it('name, ips and health follow a certificate reload (live getter)', async () => {
    let current: TlsMaterial = LEGACY;
    const app = make({ tls: LEGACY, tlsNow: () => current });
    expect(await healthName(app)).toBeNull();
    current = mat(['10.168.0.77', '127.0.0.1'], ['localhost', 'box2-surau.local']);
    expect(await healthName(app)).toBe('box2-surau.local');
    const info = (await app.inject({ method: 'GET', url: '/api/box/info', remoteAddress: '10.168.0.60' })).json() as BoxStateView;
    expect(info.localName).toBe('box2-surau.local');
    const admin = await loginAsAdmin(app);
    const ajk = await loginAs(app, 'ajk');
    const r = await app.inject({ method: 'POST', url: '/api/enrol/begin', headers: admin.headers, payload: { userId: ajk.userId, deviceName: 'Telefon' } });
    const d = decode((r.json() as { payload: string }).payload);
    expect(d.box).toBe('https://10.168.0.77:8443');
    expect(d.name).toBe('box2-surau.local');
    expect(d.ips).toEqual(['10.168.0.77']);
  });

  it('Host allowlist is exact: the claimed name passes; box9, evil and the legacy name are refused', async () => {
    const app = make({ tls: NAMED, allowedHosts: ['10.168.0.20', 'localhost', 'box1-surau.local'] });
    const hit = async (host: string): Promise<number> =>
      (await app.inject({ method: 'GET', url: '/api/health', remoteAddress: '10.168.0.60', headers: { host } })).statusCode;
    expect(await hit('box1-surau.local:8443')).toBe(200);
    expect(await hit('box9-surau.local:8443')).toBe(421);
    expect(await hit('evil-surau.local')).toBe(421);
    expect(await hit('box.surau.local')).toBe(421);
    expect(await hit('box1-surau.local.evil.com')).toBe(421);
  });
});
