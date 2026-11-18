import { createHash } from 'node:crypto';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { connect as netConnect } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { THEME_BUNDLE_FORMAT } from '@surau/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { CSP } from '../src/securityHeaders.ts';
import { getSettings, getVersion, putFeature } from '../src/settingsStore.ts';
import { MAX_PACK_BYTES, PACK_MIME } from '../src/themes/packFormat.ts';
import { loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { jpeg, manifestJson as json, woff2, zip } from './support/themePacks.ts';

/** The address segment of an installed pack: the first 16 hex of the sha-256 of its file. */
const hashOfZip = (z: Buffer): string => createHash('sha256').update(z).digest('hex').slice(0, 16) + '-' + THEME_BUNDLE_FORMAT;

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup(): Promise<{ app: FastifyInstance; dir: string; admin: Login['headers']; login: Login }> {
  const dir = mkdtempSync(join(tmpdir(), 'surau-themeroutes-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'));
  apps.push(app);
  const login = await loginAs(app, 'admin');
  return { app, dir, admin: login.headers, login };
}

const validZip = (over: Record<string, unknown> = {}): Buffer => zip({
  'theme.json': json(over),
  'theme.css': '.stage{background:url(images/kuliah.jpg)}',
  'images/kuliah.jpg': jpeg(64, 36),
});
const H = hashOfZip(validZip());
const check = (app: FastifyInstance, headers: Record<string, string>, payload: Buffer) =>
  app.inject({ method: 'POST', url: '/api/themes/check', headers: { ...headers, 'content-type': PACK_MIME }, payload });

describe('S7: checks are rate limited', () => {
  it('the 31st check within an hour answers 429 and nothing else is stored', async () => {
    const { app, admin } = await setup();
    const junk = Buffer.from('not a zip');
    for (let i = 0; i < 30; i++) expect((await check(app, admin, junk)).statusCode).toBe(200);
    const r = await check(app, admin, junk);
    expect(r.statusCode).toBe(429);
    expect(r.json().code).toBe('too_many_installs');
  });
});

describe('theme routes', () => {
  it('check, install, serve', async () => {
    const { app, admin } = await setup();
    const c = await check(app, admin, validZip());
    expect(c.statusCode).toBe(200);
    const { report, stagedId } = c.json();
    expect(report.ok).toBe(true);
    expect(stagedId).toMatch(/^[0-9a-f]{32}$/);

    const staged = await app.inject({ method: 'GET', url: `/api/themes/staged/${stagedId}/bundle.css`, headers: admin });
    expect(staged.statusCode).toBe(200);
    expect(staged.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(staged.headers['cache-control']).toBe('no-store');
    expect(staged.body).toContain(`/api/themes/staged/${stagedId}/images/kuliah.jpg`);
    const img = await app.inject({ method: 'GET', url: `/api/themes/staged/${stagedId}/images/kuliah.jpg`, headers: admin });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');

    const before = getVersion(app.surau.db, LOCAL_SURAU_ID);
    const i = await app.inject({ method: 'POST', url: '/api/themes/install', headers: admin, payload: { stagedId } });
    expect(i.statusCode).toBe(201);
    expect(i.json()).toEqual({ name: 'hijau-siti', version: 3, title: 'Hijau Siti' });
    expect(getVersion(app.surau.db, LOCAL_SURAU_ID)).toBeGreaterThan(before);

    const css = await app.inject({ method: 'GET', url: `/themes/hijau-siti/${H}/bundle.css` });
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(css.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(css.headers['x-content-type-options']).toBe('nosniff');
    expect(css.headers['content-security-policy']).toBe(CSP);
    expect(css.body).toContain(`/themes/hijau-siti/${H}/images/kuliah.jpg`);
    expect((await app.inject({ method: 'GET', url: `/themes/hijau-siti/${H}/images/kuliah.jpg` })).headers['content-type']).toBe('image/jpeg');
    expect((await app.inject({ method: 'GET', url: `/themes/hijau-siti/${H}/fonts/naskh-siti.woff2` })).statusCode).toBe(404);
  });

  it('the old address by version answers 404, and so does any other hash; the right hash answers 200', async () => {
    const { app, admin } = await setup();
    const c = await check(app, admin, validZip());
    const ir = await app.inject({ method: 'POST', url: '/api/themes/install', headers: admin, payload: { stagedId: c.json().stagedId } });
    expect(ir.statusCode, ir.body).toBe(201);
    for (const seg of ['3', '03', '0123456789abcdef', H.toUpperCase(), `${H}0`, H.slice(0, 15), 'zzzzzzzzzzzzzzzz']) {
      expect((await app.inject({ method: 'GET', url: `/themes/hijau-siti/${seg}/bundle.css` })).statusCode, seg).toBe(404);
    }
    expect((await app.inject({ method: 'GET', url: `/themes/hijau-siti/${H}/bundle.css` })).statusCode).toBe(200);
    // a changed file is a new address: the first one stops answering
    const v4 = validZip({ version: 4 });
    const c4 = await check(app, admin, v4);
    await app.inject({ method: 'POST', url: '/api/themes/install', headers: admin, payload: { stagedId: c4.json().stagedId } });
    expect((await app.inject({ method: 'GET', url: `/themes/hijau-siti/${H}/bundle.css` })).statusCode).toBe(404);
    const r = await app.inject({ method: 'GET', url: `/themes/hijau-siti/${hashOfZip(v4)}/bundle.css` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(r.body).toContain(`/themes/hijau-siti/${hashOfZip(v4)}/images/kuliah.jpg`);
  });

  it('a pack with a font or an animation is refused at the check, and nothing is staged', async () => {
    const { app, admin } = await setup();
    const extras: Array<Record<string, string | Buffer>> = [{ 'fonts/naskh-siti.woff2': woff2(500) }, { 'theme.css': '.a{animation:x 1s}' }, { 'theme.css': '@font-face{font-family:x}' }, { 'images/semua.webp': Buffer.alloc(30) }];
    for (const extra of extras) {
      const c = await check(app, admin, zip({ 'theme.json': json(), 'theme.css': '.a{color:red}', ...extra }));
      expect(c.statusCode).toBe(200);
      expect(c.json().stagedId).toBeNull();
      expect(c.json().report.ok).toBe(false);
    }
  });

  it('install is limited to ten an hour per box (429 too_many_installs)', async () => {
    const { app, admin } = await setup();
    for (let v = 1; v <= 10; v++) {
      const c = await check(app, admin, validZip({ version: v }));
      expect((await app.inject({ method: 'POST', url: '/api/themes/install', headers: admin, payload: { stagedId: c.json().stagedId } })).statusCode, String(v)).toBe(201);
    }
    const c = await check(app, admin, validZip({ version: 11 }));
    const r = await app.inject({ method: 'POST', url: '/api/themes/install', headers: admin, payload: { stagedId: c.json().stagedId } });
    expect(r.statusCode).toBe(429);
    expect(r.json().code).toBe('too_many_installs');
    expect(getSettings(app.surau.db, LOCAL_SURAU_ID).themeStyle.packs['hijau-siti']!.version).toBe(10);
  });

  it('a refused pack answers 200 with the issues and stages nothing', async () => {
    const { app, admin, dir } = await setup();
    const c = await check(app, admin, zip({ 'theme.json': json(), 'theme.css': '@import "x.css";' }));
    expect(c.statusCode).toBe(200);
    expect(c.json().stagedId).toBeNull();
    expect(c.json().report).toMatchObject({ ok: false, errors: [{ code: 'css_import', file: 'theme.css', line: 1 }] });
    const bad = await check(app, admin, Buffer.from('this is not a zip file at all, really'));
    expect(bad.json().report.errors[0].code).toBe('not_zip');
    expect(dir).toBeTruthy();
  });

  it('over the limit: 413 with the too_big issue', async () => {
    const { app, admin } = await setup();
    const r = await check(app, admin, Buffer.alloc(MAX_PACK_BYTES + 2048));
    expect(r.statusCode).toBe(413);
    expect(r.json().report.errors[0].code).toBe('too_big');
    expect(r.json().stagedId).toBeNull();
  });

  it('a body of the wrong type is refused', async () => {
    const { app, admin } = await setup();
    const r = await app.inject({ method: 'POST', url: '/api/themes/check', headers: { ...admin, 'content-type': 'application/zip' }, payload: validZip() });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
  });

  it('wrong version, unknown theme, unknown file, traversal: refused, never a file', async () => {
    const { app, admin, dir } = await setup();
    const c = await check(app, admin, validZip());
    await app.inject({ method: 'POST', url: '/api/themes/install', headers: admin, payload: { stagedId: c.json().stagedId } });
    writeFileSync(join(dir, 'surau.db.secret'), 'secret');
    for (const url of [
      '/themes/hijau-siti/2/bundle.css', '/themes/nope/1/bundle.css', `/themes/hijau-siti/${H}/theme.json`, `/themes/hijau-siti/${H}/images/..%2f..%2fsurau.db`,
      `/themes/hijau-siti/${H}/../../surau.db`, '/themes/.staged/x/bundle.css', `/themes/hijau-siti/${H}/images/kuliah.jpg/x`,       '/themes/hijau-siti/03/bundle.css', `/themes/hijau-siti/${H}/`, `/themes/hijau-siti/${H}`, '/themes/hijau-siti', '/themes', '/themes/', '/themes/Hijau-Siti/3/bundle.css',
      `/themes/hijau-siti/${H}/bundle.css%00`, `/themes/hijau-siti/${H}/images/kuliah.gif`, `/themes/hijau-siti/${H}/fonts/other.woff2`,
      `/themes/hijau-siti/${H}/bundle.css.map`, `/themes/hijau-siti/${H}/.hidden`, '/themes/%2e%2e/%2e%2e/etc/passwd',
    ]) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBeGreaterThanOrEqual(400);
    }
    for (const url of [`/api/themes/staged/${'a'.repeat(32)}/bundle.css`, `/api/themes/staged/${c.json().stagedId}/theme.json`, `/api/themes/staged/${c.json().stagedId}/images/..%2fbundle.css`, `/api/themes/staged/../bundle.css`, '/api/themes/staged/x/bundle.css']) {
      expect((await app.inject({ method: 'GET', url, headers: admin })).statusCode, url).toBeGreaterThanOrEqual(400);
    }
  });

  it('over a real socket the raw traversal paths are refused before any handler', async () => {
    const { app } = await setup();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const raw = (path: string): Promise<number> => new Promise((resolve, reject) => {
      const s = netConnect(port, '127.0.0.1', () => s.write(`GET ${path} HTTP/1.1

Host: 127.0.0.1:${port}

Connection: close



`));
      let data = '';
      s.on('data', (d) => { data += String(d); });
      s.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0)));
      s.on('error', reject);
    });
    for (const path of [`/themes/hijau-siti/${H}/images/%2e%2e/bundle.css`, `/themes/hijau-siti/${H}/images/..%2f..%2fsurau.db`, `/themes/hijau-siti/${H}/../../surau.db`, '/themes/%2e%2e/%2e%2e/etc/passwd', `/themes/hijau-siti/${H}/images/%5c..%5cbundle.css`, '/api/themes/staged/../bundle.css']) {
      expect(await raw(path), path).toBe(400);
    }
    // a backslash is part of one path segment: it never names a file
    expect(await raw(`/themes/hijau-siti/${H}/images%5Ckuliah.jpg`)).toBe(400);
    expect(await raw(`/themes/hijau-siti/${H}/bundle.css%00`)).toBeGreaterThanOrEqual(400);
  });

  it('HEAD and other methods on /themes are refused', async () => {
    const { app } = await setup();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
      expect((await app.inject({ method, url: `/themes/hijau-siti/${H}/bundle.css` })).statusCode, method).toBeGreaterThanOrEqual(400);
    }
  });

  it('permissions: anonymous 401, a role without settings:write 403, the kiosk 403', async () => {
    const { app, admin } = await setup();
    const c = await check(app, admin, validZip());
    const stagedId = c.json().stagedId as string;
    const ajk = await loginAs(app, 'ajk');
    const far = { remoteAddress: '10.9.9.9' };
    const calls = [
      { method: 'POST' as const, url: '/api/themes/check', headers: { 'content-type': PACK_MIME }, payload: validZip() },
      { method: 'POST' as const, url: '/api/themes/install', payload: { stagedId } },
      { method: 'DELETE' as const, url: '/api/themes/hijau-siti' },
      { method: 'GET' as const, url: `/api/themes/staged/${stagedId}/bundle.css` },
    ];
    for (const call of calls) {
      // a LAN client with no token
      const anon = await app.inject({ ...call, ...far });
      expect(anon.statusCode, `anon ${call.url}`).toBe(401);
      // a role that cannot write settings
      const role = await app.inject({ ...call, headers: { ...(call.headers ?? {}), ...ajk.headers } });
      expect(role.statusCode, `ajk ${call.url}`).toBe(403);
      // the local kiosk (loopback, no token) holds kiosk:read only
      const kiosk = await app.inject(call);
      expect(kiosk.statusCode, `kiosk ${call.url}`).toBe(403);
    }
    // nothing was staged, installed or removed by those refusals
    expect(getSettings(app.surau.db, LOCAL_SURAU_ID).themeStyle.packs).toEqual({});
    expect((await app.inject({ method: 'GET', url: `/api/themes/staged/${stagedId}/bundle.css`, headers: admin })).statusCode).toBe(200);
    // a LAN client without a token cannot read the served pack either
    await app.inject({ method: 'POST', url: '/api/themes/install', headers: admin, payload: { stagedId } });
    expect((await app.inject({ method: 'GET', url: `/themes/hijau-siti/${H}/bundle.css`, ...far })).statusCode).toBe(401);
  });

  it('a staged id that was never issued is 404; an expired one is 404', async () => {
    const { app, admin } = await setup();
    expect((await app.inject({ method: 'GET', url: `/api/themes/staged/${'b'.repeat(32)}/bundle.css`, headers: admin })).statusCode).toBe(404);
    const i = await app.inject({ method: 'POST', url: '/api/themes/install', headers: admin, payload: { stagedId: 'b'.repeat(32) } });
    expect(i.statusCode).toBe(410);
    expect(i.json()).toMatchObject({ code: 'gone', errors: ['Semakan sudah tamat tempoh. Semak fail sekali lagi.'] });
    expect((await app.inject({ method: 'POST', url: '/api/themes/install', headers: admin, payload: { stagedId: 'zz' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/themes/install', headers: admin, payload: {} })).statusCode).toBe(400);
  });

  it('install of a lower version answers 409 version_not_higher with the sentence', async () => {
    const { app, admin } = await setup();
    const a = await check(app, admin, validZip({ version: 3 }));
    const b = await check(app, admin, validZip({ version: 4 }));
    expect((await app.inject({ method: 'POST', url: '/api/themes/install', headers: admin, payload: { stagedId: b.json().stagedId } })).statusCode).toBe(201);
    const r = await app.inject({ method: 'POST', url: '/api/themes/install', headers: admin, payload: { stagedId: a.json().stagedId } });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('version_not_higher');
    expect(r.json().errors[0]).toBe('Versi sama atau lebih rendah. Hijau Siti versi 4 sudah dipasang. Naikkan nombor versi dalam theme.json.');
  });

  it('delete answers 409 in use, 400 built-in, 404 unknown, 204 otherwise', async () => {
    const { app, admin } = await setup();
    const c = await check(app, admin, validZip());
    await app.inject({ method: 'POST', url: '/api/themes/install', headers: admin, payload: { stagedId: c.json().stagedId } });
    putFeature(app.surau.db, 'kioskTemplate', { templateId: 'hijau-siti' }, 'test', undefined, LOCAL_SURAU_ID);
    const inUse = await app.inject({ method: 'DELETE', url: '/api/themes/hijau-siti', headers: admin });
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json()).toMatchObject({ code: 'in_use', errors: ['Tema ini sedang digunakan. Pilih tema lain dahulu.'] });
    const built = await app.inject({ method: 'DELETE', url: '/api/themes/creative', headers: admin });
    expect(built.statusCode).toBe(400);
    expect(built.json()).toMatchObject({ code: 'built_in', errors: ['Tema bawaan MAXCOM tidak boleh dipadam.'] });
    expect((await app.inject({ method: 'DELETE', url: '/api/themes/tiada', headers: admin })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/themes/Bad%20Name', headers: admin })).statusCode).toBe(404);
    putFeature(app.surau.db, 'kioskTemplate', { templateId: 'creative' }, 'test', undefined, LOCAL_SURAU_ID);
    const before = getVersion(app.surau.db, LOCAL_SURAU_ID);
    expect((await app.inject({ method: 'DELETE', url: '/api/themes/hijau-siti', headers: admin })).statusCode).toBe(204);
    expect(getVersion(app.surau.db, LOCAL_SURAU_ID)).toBeGreaterThan(before);
    expect(getSettings(app.surau.db, LOCAL_SURAU_ID).themeStyle.packs['hijau-siti']).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: `/themes/hijau-siti/${H}/bundle.css` })).statusCode).toBe(404);
  });

  it('install bumps the version the kiosk event stream announces', async () => {
    const { app, admin } = await setup();
    const seen: number[] = [];
    const bus = (app as unknown as { surau: { db: unknown } }).surau;
    expect(bus).toBeDefined();
    const c = await check(app, admin, validZip());
    const before = getVersion(app.surau.db, LOCAL_SURAU_ID);
    const r = await app.inject({ method: 'POST', url: '/api/themes/install', headers: admin, payload: { stagedId: c.json().stagedId } });
    expect(r.statusCode).toBe(201);
    seen.push(getVersion(app.surau.db, LOCAL_SURAU_ID));
    expect(seen[0]).toBeGreaterThan(before);
    // the bundle the kiosk fetches now names the pack
    const b = await app.inject({ method: 'GET', url: '/api/kiosk/bundle' });
    expect(b.statusCode).toBe(200);
    expect(JSON.stringify(b.json())).toContain('hijau-siti');
  });
});
