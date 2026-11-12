/**
 * Plan 4 Task 11: the Flutter web build is served by the box at /app/ (same origin), with its own
 * cache policy and a CSP that lets it run (wasm) without ever sending two CSP headers.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { CSP, KIOSK_CSP } from '../src/securityHeaders.ts';

let dir: string;
let appDir: string;
let kioskDir: string;
let app: FastifyInstance;
let noAppDir: FastifyInstance;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'surau-appstatic-'));
  appDir = join(dir, 'app');
  kioskDir = join(dir, 'kiosk');
  mkdirSync(join(appDir, 'assets'), { recursive: true });
  mkdirSync(join(appDir, 'canvaskit'), { recursive: true });
  mkdirSync(kioskDir, { recursive: true });
  writeFileSync(join(appDir, 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(join(appDir, 'flutter_bootstrap.js'), '// boot');
  writeFileSync(join(appDir, 'flutter_service_worker.js'), '// sw');
  writeFileSync(join(appDir, 'version.json'), '{"version":"1"}');
  writeFileSync(join(appDir, 'main.dart.js'), '// main');
  writeFileSync(join(appDir, 'assets', 'x.bin'), 'bin');
  writeFileSync(join(appDir, 'canvaskit', 'canvaskit.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]));
  writeFileSync(join(kioskDir, 'index.html'), '<!doctype html><title>kiosk</title>');
  app = buildApp(':memory:', { appDir, staticDir: kioskDir });
  noAppDir = buildApp(':memory:', { staticDir: kioskDir });
  await app.ready();
  await noAppDir.ready();
});

afterAll(async () => {
  await app.close();
  await noAppDir.close();
  rmSync(dir, { recursive: true, force: true });
});

const cspHeaders = (headers: Record<string, unknown>): string[] => {
  const v = headers['content-security-policy'];
  return Array.isArray(v) ? (v as string[]) : v === undefined ? [] : [String(v)];
};

describe('GET /app/ (web build served by the box)', () => {
  it('serves index.html anonymously with no-cache and one CSP that allows wasm', async () => {
    const res = await app.inject({ method: 'GET', url: '/app/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>app</title>');
    expect(res.headers['cache-control']).toBe('no-cache');
    const csp = cspHeaders(res.headers);
    expect(csp).toHaveLength(1);
    expect(csp[0]).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp[0]).toContain("default-src 'self'");
    expect(csp[0]).toContain("connect-src 'self' blob:; ");
    expect(csp[0]).not.toMatch(/connect-src[^;]*(data:|\*|https?:)/);
    // The kiosk page CSP keeps its own connect-src: blob: is for /app/ only; the loopback port is the kiosk page's only.
    expect(KIOSK_CSP).toContain("connect-src 'self' http://127.0.0.1:*;");
    expect(CSP).toContain("connect-src 'self';");
    expect(KIOSK_CSP).not.toMatch(/connect-src[^;]*blob:/);
    expect(CSP).not.toMatch(/connect-src[^;]*blob:/);
    expect(csp[0]).toContain("frame-src 'self'");
    expect(csp[0]).not.toContain('frame-ancestors *');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('revalidates every file (names are not content-hashed) and answers a matching ETag with 304', async () => {
    const names = [
      'index.html', 'flutter_bootstrap.js', 'flutter_service_worker.js', 'version.json',
      'assets/x.bin', 'main.dart.js', 'canvaskit/canvaskit.wasm',
    ];
    for (const name of names) {
      const res = await app.inject({ method: 'GET', url: `/app/${name}` });
      expect(res.statusCode, name).toBe(200);
      expect(res.headers['cache-control'], name).toBe('no-cache');
      expect(cspHeaders(res.headers), name).toHaveLength(1);
      const etag = res.headers.etag;
      expect(typeof etag, name).toBe('string');
      expect(res.headers['last-modified'], name).toBeDefined();
      const again = await app.inject({ method: 'GET', url: `/app/${name}`, headers: { 'if-none-match': String(etag) } });
      expect(again.statusCode, name).toBe(304);
      expect(again.headers['cache-control'], name).toBe('no-cache');
    }
    const wasm = await app.inject({ method: 'GET', url: '/app/canvaskit/canvaskit.wasm' });
    expect(String(wasm.headers['content-type'])).toContain('application/wasm');
  });

  it('redirects /app to /app/', async () => {
    const res = await app.inject({ method: 'GET', url: '/app' });
    expect([301, 302, 308]).toContain(res.statusCode);
    expect(res.headers.location).toBe('/app/');
  });

  it('does not let a path climb out of the app folder', async () => {
    for (const url of ['/app/assets/../../data/secret/box.key', '/app/%2e%2e/%2e%2e/data/secret/box.key', '/app/..%2f..%2fapp.db']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, url).toBeLessThan(500);
      expect(res.body, url).not.toContain('BEGIN');
    }
    const traversal = await app.inject({ method: 'GET', url: '/app/assets/../../data/secret/box.key' });
    expect(traversal.statusCode).toBe(404);
  });

  it('answers an unknown /app/ path with 404, not the kiosk page', async () => {
    const res = await app.inject({ method: 'GET', url: '/app/nope/page' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('kiosk');
  });

  it('is public while the API still needs a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/app/' })).statusCode).toBe(200);
    // A caller on the LAN (not the laptop itself) has no identity until it unlocks.
    const lan = { remoteAddress: '10.168.1.50' };
    expect((await app.inject({ method: 'GET', url: '/app/', ...lan })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/settings', ...lan })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/assets/${'a'.repeat(64)}`, ...lan })).statusCode).toBe(401);
  });

  it('leaves the kiosk page on the original CSP', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>kiosk</title>');
    expect(cspHeaders(res.headers)).toEqual([KIOSK_CSP]);
    expect(KIOSK_CSP).not.toContain('wasm-unsafe-eval');
  });

  it('without appDir /app/ falls to the kiosk page as before', async () => {
    const res = await noAppDir.inject({ method: 'GET', url: '/app/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>kiosk</title>');
    // served under /app/, it is not where the kiosk runs (that is /): no loopback port there
    expect(cspHeaders(res.headers)).toEqual([CSP]);
  });
});

describe('scripts/build-app.ps1 (static checks)', () => {
  const script = readFileSync(fileURLToPath(new URL('../../../scripts/build-app.ps1', import.meta.url)));
  const text = script.toString('latin1');

  it('is plain ASCII (PowerShell 5.1 reads BOM-less files as ANSI)', () => {
    expect([...script].every((b) => b < 0x80)).toBe(true);
  });

  it('builds the web app for /app/ offline and the APK per ABI', () => {
    expect(text).toContain('--no-web-resources-cdn');
    expect(text).toContain('--base-href /app/');
    expect(text).toContain('--pwa-strategy offline-first');
    expect(text).toContain('split-per-abi');
    expect(text).toContain('5173');
    expect(text).toContain('8787');
    expect(text).toContain('sha256sums.txt');
  });

  it('assigns no variable that shadows a parameter (PowerShell names are case-insensitive)', () => {
    const block = /param\(([\s\S]*?)\r?\n\)/.exec(text);
    expect(block).not.toBeNull();
    const params = [...block![1]!.matchAll(/\$(\w+)/g)].map((m) => m[1]!.toLowerCase());
    expect(params).toEqual(expect.arrayContaining(['web', 'apk']));
    const assigned = [...text.matchAll(/^\s*\$(\w+)\s*(?:=|\+=)/gm)].map((m) => m[1]!.toLowerCase());
    expect(assigned.filter((v) => params.includes(v))).toEqual([]);
  });

  it('holds no password or keystore secret', () => {
    expect(text).not.toMatch(/(storePassword|keyPassword)\s*=\s*['"]?\w/i);
    expect(text).not.toMatch(/-storepass|-keypass/i);
  });
});
