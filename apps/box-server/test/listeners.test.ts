import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { connect } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { hostsFromTls, loadTlsOrWarn, planListeners, startListeners } from '../src/main.ts';
import type { Listeners } from '../src/main.ts';
import { loadTls } from '../src/tls.ts';
import type { TlsMaterial } from '../src/tls.ts';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));

const dirs: string[] = [];
const started: Listeners[] = [];
afterEach(async () => {
  for (const l of started.splice(0)) await l.app.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixtureTls(): TlsMaterial {
  const d = mkdtempSync(join(tmpdir(), 'surau-lst-'));
  dirs.push(d);
  mkdirSync(join(d, 'secret'));
  mkdirSync(join(d, 'pki'));
  cpSync(join(fixtures, 'test-box.pfx'), join(d, 'secret', 'box.pfx'));
  writeFileSync(join(d, 'secret', 'pfx.pass'), 'test');
  cpSync(join(fixtures, 'test-box-leaf.cer'), join(d, 'pki', 'box-leaf.cer'));
  const tls = loadTls(d, new Date('2026-11-03T00:00:00Z'));
  if (!tls) throw new Error('fixture tls missing');
  return tls;
}

function get(url: string, opts: https.RequestOptions = {}, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const mod = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { ...opts, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });
}

describe('planListeners', () => {
  it('without TLS: loopback HTTP only, one warning', () => {
    const plan = planListeners({}, null);
    expect(plan.https).toBeNull();
    expect(plan.http).toEqual({ host: '127.0.0.1', port: 8787 });
    expect(plan.warnings).toEqual([
      'TLS certificate missing: run scripts/box-ca.ps1; the box is reachable from this PC only',
    ]);
  });

  it('with TLS: both, default and overridden HTTPS port', () => {
    const tls = fixtureTls();
    const plan = planListeners({}, tls);
    expect(plan.https).toEqual({ host: '0.0.0.0', port: 8443 });
    expect(plan.warnings).toEqual([]);
    expect(planListeners({ SURAU_HTTPS_PORT: '9443', SURAU_PORT: '9000' }, tls)).toMatchObject({
      https: { port: 9443 },
      http: { port: 9000 },
    });
  });

  it('rejects an invalid port and ignores SURAU_HTTP_LAN / SURAU_HOST', () => {
    const tls = fixtureTls();
    expect(() => planListeners({ SURAU_HTTPS_PORT: '99999' }, tls)).toThrow(/SURAU_HTTPS_PORT/);
    expect(() => planListeners({ SURAU_PORT: 'x' }, tls)).toThrow(/SURAU_PORT/);
    const plan = planListeners({ SURAU_HTTP_LAN: '1', SURAU_HOST: '0.0.0.0' }, null);
    expect(plan.http.host).toBe('127.0.0.1');
  });
});

describe('hostsFromTls', () => {
  it('collects SAN IPs and DNS names plus SURAU_ALLOWED_HOSTS', () => {
    const tls = fixtureTls();
    const hosts = hostsFromTls(tls, { SURAU_ALLOWED_HOSTS: ' Box.Local , ' });
    for (const ip of tls.ipSan) expect(hosts).toContain(ip);
    expect(hosts).toContain('box.local');
    expect(hostsFromTls(null, {})).toEqual([]);
  });
});

describe('certificate reload on the real HTTPS listener', () => {
  it('serves a renewed leaf to new connections after the files change, keeps the old one on a bad file', async () => {
    const d = mkdtempSync(join(tmpdir(), 'surau-rel-'));
    dirs.push(d);
    mkdirSync(join(d, 'secret'));
    mkdirSync(join(d, 'pki'));
    cpSync(join(fixtures, 'test-box.pfx'), join(d, 'secret', 'box.pfx'));
    writeFileSync(join(d, 'secret', 'pfx.pass'), 'test');
    cpSync(join(fixtures, 'test-box-leaf.cer'), join(d, 'pki', 'box-leaf.cer'));
    const tls = loadTls(d);
    expect(tls).not.toBeNull();
    const l = await startListeners({
      dbPath: ':memory:',
      staticDir: null,
      tls,
      plan: { http: { host: '127.0.0.1', port: 0 }, https: { host: '127.0.0.1', port: 0 }, warnings: [] },
      env: {},
      dataDir: d,
    });
    started.push(l);
    expect(l.certReload).not.toBeNull();
    const fingerprint = (): Promise<string> =>
      new Promise((resolve, reject) => {
        const s = connect({ host: '127.0.0.1', port: l.httpsPort ?? 0, rejectUnauthorized: false }, () => {
          const fp = s.getPeerCertificate().fingerprint256;
          s.end();
          resolve(fp);
        });
        s.on('error', reject);
      });
    const before = await fingerprint();
    expect(l.certReload!.check()).toBe('unchanged');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      writeFileSync(join(d, 'secret', 'box.pfx'), 'garbage');
      expect(l.certReload!.check()).toBe('invalid');
      expect(await fingerprint()).toBe(before);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }

    cpSync(join(fixtures, 'test-box2.pfx'), join(d, 'secret', 'box.pfx'));
    cpSync(join(fixtures, 'test-box2-leaf.cer'), join(d, 'pki', 'box-leaf.cer'));
    expect(l.certReload!.check()).toBe('reloaded');
    expect(await fingerprint()).not.toBe(before);
  });
});

describe('Host allowlist follows a renewed certificate (S7)', () => {
  it('a new SAN IP is accepted after the reload, without a restart', async () => {
    const d = mkdtempSync(join(tmpdir(), 'surau-host-'));
    dirs.push(d);
    mkdirSync(join(d, 'secret'));
    mkdirSync(join(d, 'pki'));
    cpSync(join(fixtures, 'test-box.pfx'), join(d, 'secret', 'box.pfx'));
    writeFileSync(join(d, 'secret', 'pfx.pass'), 'test');
    cpSync(join(fixtures, 'test-box-leaf.cer'), join(d, 'pki', 'box-leaf.cer'));
    const tls = loadTls(d);
    const l = await startListeners({
      dbPath: ':memory:',
      staticDir: null,
      tls,
      plan: { http: { host: '127.0.0.1', port: 0 }, https: { host: '127.0.0.1', port: 0 }, warnings: [] },
      env: {},
      dataDir: d,
    });
    started.push(l);
    const withHost = (host: string) => get(`http://127.0.0.1:${l.httpPort}/api/health`, {}, { Host: host });
    expect((await withHost('10.168.1.60')).status).toBe(421);
    cpSync(join(fixtures, 'test-box2.pfx'), join(d, 'secret', 'box.pfx'));
    cpSync(join(fixtures, 'test-box2-leaf.cer'), join(d, 'pki', 'box-leaf.cer'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(l.certReload!.check()).toBe('reloaded');
    } finally {
      log.mockRestore();
    }
    expect((await withHost('10.168.1.60')).status).toBe(200);
    expect((await withHost('evil.example')).status).toBe(421);
  });
});

describe('real listeners', () => {
  it('serves HTTPS and loopback HTTP; close shuts both', async () => {
    const tls = fixtureTls();
    const l = await startListeners({
      dbPath: ':memory:',
      staticDir: null,
      tls,
      plan: {
        http: { host: '127.0.0.1', port: 0 },
        https: { host: '127.0.0.1', port: 0 },
        warnings: [],
      },
      env: {},
    });
    started.push(l);
    expect(l.httpsPort).toBeGreaterThan(0);

    const secure = await get(`https://127.0.0.1:${l.httpsPort}/api/health`, { rejectUnauthorized: false });
    expect(secure.status).toBe(200);

    const san = await new Promise<string>((resolve, reject) => {
      const s = connect({ host: '127.0.0.1', port: l.httpsPort ?? 0, rejectUnauthorized: false }, () => {
        const cert = s.getPeerCertificate();
        s.end();
        resolve(cert.subjectaltname ?? '');
      });
      s.on('error', reject);
    });
    expect(san).toContain('IP Address:127.0.0.1');

    // Host allowlist still applies on HTTPS.
    const bad = await get(`https://127.0.0.1:${l.httpsPort}/api/health`, { rejectUnauthorized: false }, { Host: 'evil.example' });
    expect(bad.status).toBe(421);

    // TLS 1.0 / 1.1 refused.
    await expect(
      new Promise((resolve, reject) => {
        const s = connect(
          { host: '127.0.0.1', port: l.httpsPort ?? 0, rejectUnauthorized: false, minVersion: 'TLSv1', maxVersion: 'TLSv1.1' },
          () => {
            s.destroy();
            resolve('connected');
          },
        );
        s.on('error', reject);
      }),
    ).rejects.toBeDefined();

    const plain = await get(`http://127.0.0.1:${l.httpPort}/api/health`);
    expect(plain.status).toBe(200);

    await l.app.close();
    await expect(get(`http://127.0.0.1:${l.httpPort}/api/health`)).rejects.toBeDefined();
    await expect(get(`https://127.0.0.1:${l.httpsPort}/api/health`, { rejectUnauthorized: false })).rejects.toBeDefined();
  });

  it('without TLS only HTTP is started', async () => {
    const l = await startListeners({
      dbPath: ':memory:',
      staticDir: null,
      tls: null,
      plan: { http: { host: '127.0.0.1', port: 0 }, https: null, warnings: [] },
      env: {},
    });
    started.push(l);
    expect(l.httpsPort).toBeNull();
    expect((await get(`http://127.0.0.1:${l.httpPort}/api/health`)).status).toBe(200);
  });
});

describe('TLS failures keep the loopback kiosk up (Q1, M1)', () => {
  function fixtureDataDir(pass = 'test'): string {
    const d = mkdtempSync(join(tmpdir(), 'surau-lst-'));
    dirs.push(d);
    mkdirSync(join(d, 'secret'));
    mkdirSync(join(d, 'pki'));
    cpSync(join(fixtures, 'test-box.pfx'), join(d, 'secret', 'box.pfx'));
    writeFileSync(join(d, 'secret', 'pfx.pass'), pass);
    cpSync(join(fixtures, 'test-box-leaf.cer'), join(d, 'pki', 'box-leaf.cer'));
    return d;
  }

  it('an expired certificate becomes tls=null plus a loud warning, not a throw', () => {
    const r = loadTlsOrWarn(fixtureDataDir(), new Date('2099-01-01T00:00:00Z'));
    expect(r.tls).toBeNull();
    expect(r.warning).toMatch(/expired/);
    expect(r.warning).toMatch(/loopback|this PC/i);
  });

  it('a wrong passphrase becomes tls=null and the warning never echoes the passphrase', () => {
    const r = loadTlsOrWarn(fixtureDataDir('not-the-passphrase'), new Date('2026-11-03T00:00:00Z'));
    expect(r.tls).toBeNull();
    expect(r.warning).toMatch(/passphrase/);
    expect(r.warning).not.toContain('not-the-passphrase');
  });

  it('a good certificate loads without a warning', () => {
    const r = loadTlsOrWarn(fixtureDataDir(), new Date('2026-11-03T00:00:00Z'));
    expect(r.tls).not.toBeNull();
    expect(r.warning).toBeNull();
  });

  it('the loopback server still starts with the plan a failed TLS load yields', async () => {
    const r = loadTlsOrWarn(fixtureDataDir(), new Date('2099-01-01T00:00:00Z'));
    const plan = planListeners({}, r.tls);
    expect(plan.https).toBeNull();
    expect(plan.http.host).toBe('127.0.0.1');
    const l = await startListeners({
      dbPath: ':memory:', staticDir: null, tls: r.tls,
      plan: { ...plan, http: { host: '127.0.0.1', port: 0 } }, env: {},
    });
    started.push(l);
    expect((await get(`http://127.0.0.1:${l.httpPort}/api/health`)).status).toBe(200);
  });

  it('HTTPS port already in use: process stays up on loopback HTTP, no LAN HTTP', async () => {
    const blocker = net.createServer();
    await new Promise<void>((done) => blocker.listen({ host: '127.0.0.1', port: 0 }, done));
    const busy = (blocker.address() as net.AddressInfo).port;
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
    try {
      const l = await startListeners({
        dbPath: ':memory:', staticDir: null, tls: fixtureTls(),
        plan: { http: { host: '127.0.0.1', port: 0 }, https: { host: '127.0.0.1', port: busy }, warnings: [] },
        env: {},
      });
      started.push(l);
      expect(l.httpsPort).toBeNull();
      expect(l.httpPort).toBeGreaterThan(0);
      expect((await get(`http://127.0.0.1:${l.httpPort}/api/health`)).status).toBe(200);
      expect(warnings.join(' ')).toMatch(/HTTPS/);
      const addr = l.app.server.address() as net.AddressInfo;
      expect(addr.address).toBe('127.0.0.1');
    } finally {
      console.warn = warn;
      await new Promise<void>((done) => blocker.close(() => done()));
    }
  });
});
