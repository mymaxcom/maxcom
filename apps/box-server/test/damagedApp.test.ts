import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoxStateView } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { loadBoxKey } from '../src/auth/secrets.ts';
import { buildDamagedApp, isDatabaseDamage, setDamagedAllowedHosts } from '../src/setup/damaged.ts';
import { loadTls } from '../src/tls.ts';
import { startListeners } from '../src/main.ts';
import { writeBoxJson } from '../src/setup/state.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'surau-damaged-'));
  dirs.push(d);
  return d;
}
function staticDir(dir: string): string {
  const s = join(dir, 'dist');
  mkdirSync(s, { recursive: true });
  writeFileSync(join(s, 'index.html'), '<!doctype html><html><body>kiosk</body></html>');
  return s;
}

describe('damaged-database server', () => {
  it('serves the page and a db_damaged recovery state with the names from box.json; everything else is 503', async () => {
    const dir = tmp();
    loadBoxKey(dir);
    writeBoxJson(dir, { boxName: 'MAXCOM Dewan Utama', surauName: 'Surau Al-Hidayah' });
    const app = buildDamagedApp({ dataDir: dir, staticDir: staticDir(dir) });
    apps.push(app);
    const page = await app.inject({ method: 'GET', url: '/', remoteAddress: '127.0.0.1' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('kiosk');
    const st = await app.inject({ method: 'GET', url: '/api/box/state', remoteAddress: '127.0.0.1' });
    const v = st.json() as BoxStateView;
    expect(v.state).toBe('recovery');
    expect(v.reason).toBe('db_damaged');
    expect(v.name).toBe('MAXCOM Dewan Utama');
    expect(v.surauName).toBe('Surau Al-Hidayah');
    expect(v.qr).toBeUndefined();
    expect(v.boxId).toMatch(/^[0-9a-f]{16}$/);
    const info = await app.inject({ method: 'GET', url: '/api/box/info', remoteAddress: '127.0.0.1' });
    expect(info.statusCode).toBe(200);
    for (const url of ['/api/kiosk/bundle', '/api/settings', '/api/users']) {
      const r = await app.inject({ method: 'GET', url, remoteAddress: '127.0.0.1' });
      expect(r.statusCode, url).toBe(503);
      expect(r.json()).toEqual({ errors: ['Pangkalan data rosak'] });
    }
    expect((await app.inject({ method: 'POST', url: '/api/setup/complete', remoteAddress: '127.0.0.1', payload: {} })).statusCode).toBe(503);
  });

  it('works without box.json (default name, no surau name) and refuses a foreign Host', async () => {
    const dir = tmp();
    const app = buildDamagedApp({ dataDir: dir, staticDir: null });
    apps.push(app);
    const v = (await app.inject({ method: 'GET', url: '/api/box/state', remoteAddress: '127.0.0.1' })).json() as BoxStateView;
    expect(v.name).toMatch(/^MAXCOM [0-9A-F]{4}$/);
    expect(v.surauName).toBeNull();
    const evil = await app.inject({ method: 'GET', url: '/api/box/state', headers: { host: 'evil.example' } });
    expect(evil.statusCode).toBe(421);
  });

  it('isDatabaseDamage recognises corrupt and not-a-database errors only', () => {
    expect(isDatabaseDamage(Object.assign(new Error('x'), { errcode: 11 }))).toBe(true);
    expect(isDatabaseDamage(new Error('file is not a database'))).toBe(true);
    expect(isDatabaseDamage(new Error('database disk image is malformed'))).toBe(true);
    expect(isDatabaseDamage(new Error('database is locked'))).toBe(false);
    expect(isDatabaseDamage('boom')).toBe(false);
  });

  it('main starts it when the database file is garbage, so the TV is not blank', async () => {
    const dir = tmp();
    const dbPath = join(dir, 'surau.db');
    // a healthy box first, to have box.json and keys; then wreck the database
    const good = buildApp(dbPath, { dataDir: dir });
    await good.ready();
    await good.close();
    writeBoxJson(dir, { boxName: 'MAXCOM Rosak', surauName: null });
    writeFileSync(dbPath, Buffer.from('this is definitely not a sqlite database file '.repeat(200)));
    for (const ext of ['-wal', '-shm']) rmSync(dbPath + ext, { force: true });
    const l = await startListeners({
      dbPath,
      staticDir: staticDir(dir),
      tls: null,
      plan: { http: { host: '127.0.0.1', port: 0 }, https: null, warnings: [] },
      env: {},
      dataDir: dir,
      autoPrayerFetch: false,
    });
    apps.push(l.app);
    const r = await fetch(`http://127.0.0.1:${l.httpPort}/api/box/state`);
    expect(r.status).toBe(200);
    const v = (await r.json()) as BoxStateView;
    expect(v.reason).toBe('db_damaged');
    expect(v.name).toBe('MAXCOM Rosak');
    expect((await fetch(`http://127.0.0.1:${l.httpPort}/api/kiosk/bundle`)).status).toBe(503);
  });

  it('setDamagedAllowedHosts swaps the Host allowlist; it is false for any other app', async () => {
    const dir = tmp();
    const app = buildDamagedApp({ dataDir: dir, staticDir: null });
    apps.push(app);
    const at = (host: string) => app.inject({ method: 'GET', url: '/api/box/info', headers: { host } });
    expect((await at('10.168.1.60')).statusCode).toBe(421);
    expect(setDamagedAllowedHosts(app, ['10.168.1.60'])).toBe(true);
    expect((await at('10.168.1.60')).statusCode).toBe(200);
    expect((await at('evil.example')).statusCode).toBe(421);
    expect((await app.inject({ method: 'GET', url: '/api/box/info', remoteAddress: '127.0.0.1' })).statusCode).toBe(200);
    const healthy = buildApp(join(dir, 'ok.db'), { dataDir: dir });
    apps.push(healthy);
    expect(setDamagedAllowedHosts(healthy, ['x'])).toBe(false);
  });

  it('a certificate renewal on a damaged box does not crash and refreshes the allowlist', async () => {
    const dir = tmp();
    const fx = fileURLToPath(new URL('./fixtures/', import.meta.url));
    mkdirSync(join(dir, 'secret'), { recursive: true });
    mkdirSync(join(dir, 'pki'), { recursive: true });
    cpSync(join(fx, 'test-box.pfx'), join(dir, 'secret', 'box.pfx'));
    writeFileSync(join(dir, 'secret', 'pfx.pass'), 'test');
    cpSync(join(fx, 'test-box-leaf.cer'), join(dir, 'pki', 'box-leaf.cer'));
    const dbPath = join(dir, 'surau.db');
    const good = buildApp(dbPath, { dataDir: dir });
    await good.ready();
    await good.close();
    writeFileSync(dbPath, Buffer.from('this is definitely not a sqlite database file '.repeat(200)));
    for (const ext of ['-wal', '-shm']) rmSync(dbPath + ext, { force: true });
    const l = await startListeners({
      dbPath,
      staticDir: staticDir(dir),
      tls: loadTls(dir)!,
      plan: { http: { host: '127.0.0.1', port: 0 }, https: { host: '127.0.0.1', port: 0 }, warnings: [] },
      env: {},
      dataDir: dir,
      autoPrayerFetch: false,
      certReloadMs: 3_600_000,
    });
    apps.push(l.app);
    expect(l.httpsPort).not.toBeNull();
    const at = (host: string) => l.app.inject({ method: 'GET', url: '/api/box/info', headers: { host } });
    expect((await at('10.168.1.60')).statusCode).toBe(421);
    cpSync(join(fx, 'test-box2.pfx'), join(dir, 'secret', 'box.pfx'));
    cpSync(join(fx, 'test-box2-leaf.cer'), join(dir, 'pki', 'box-leaf.cer'));
    expect(l.certReload!.check()).toBe('reloaded');
    expect((await at('10.168.1.60')).statusCode).toBe(200);
    expect((await at('evil.example')).statusCode).toBe(421);
    l.certReload!.stop();
  });
});
