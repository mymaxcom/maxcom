/**
 * Operator decisions 2026-11-04: poster titles (migration), first-boot surau.ini, the surau logo
 * (/surau-logo, dynamic manifest and app icons).
 */
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { runMigrations } from '../src/migrations/index.ts';
import { applySurauIni, parseSurauIni, SURAU_INI_ACTOR } from '../src/surauIni.ts';
import { getSettings, putFeature } from '../src/settingsStore.ts';
import { loginAsAdmin } from './authHelpers.ts';

const req = createRequire(import.meta.url);
const { PNG } = req('pngjs') as typeof import('pngjs');
const jpegjs = req('jpeg-js') as { encode(img: { width: number; height: number; data: Uint8Array }, q: number): { data: Buffer } };

function png(width: number, height: number, rgba: [number, number, number, number] = [200, 30, 30, 255]): Buffer {
  const p = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) p.data.set(rgba, i * 4);
  return PNG.sync.write(p);
}
function jpg(width: number, height: number): Buffer {
  const data = new Uint8Array(width * height * 4).fill(180);
  return jpegjs.encode({ width, height, data }, 80).data;
}
const pngSize = (b: Buffer): [number, number] => [b.readUInt32BE(16), b.readUInt32BE(20)];

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'surau-identity-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function collect(): { logger: { info(m: string): void; warn(m: string): void }; infos: string[]; warns: string[] } {
  const infos: string[] = [];
  const warns: string[] = [];
  return { logger: { info: (m) => infos.push(m), warn: (m) => warns.push(m) }, infos, warns };
}

describe('migration 005: poster titles', () => {
  const ASSET = 'a'.repeat(64);
  function seed(d: string): ReturnType<typeof openDb> {
    const db = openDb(join(d, 'x.db'));
    const ins = (id: string, item: Record<string, unknown>, deleted: string | null = null): void => {
      db.prepare(
        "INSERT INTO content_items (kind, id, json, updated_at, updated_by, deleted_at) VALUES ('poster', ?, ?, 't', 'u', ?)",
      ).run(id, JSON.stringify({ id, assetId: ASSET, days: ['umum'], ...item }), deleted);
    };
    ins('c', { order: 30 });
    ins('a', { order: 10 });
    ins('b', { order: 20, title: 'Maulidur Rasul' });
    ins('gone', { order: 5 }, '2026-01-01');
    db.prepare("DELETE FROM schema_migrations WHERE name = '005-poster-titles'").run();
    return db;
  }
  const titles = (db: ReturnType<typeof openDb>): Record<string, unknown> =>
    Object.fromEntries(
      (db.prepare("SELECT id, json FROM content_items WHERE kind = 'poster' ORDER BY id").all() as { id: string; json: string }[]).map((r) => [
        r.id,
        (JSON.parse(r.json) as { title?: string }).title,
      ]),
    );

  it('names untitled live posters by position among live posters, skips deleted, and is idempotent', () => {
    const db = seed(tmp());
    expect(runMigrations(db)).toEqual(['005-poster-titles']);
    // live by order: a(10)=1, b(20)=2 keeps its own title, c(30)=3; the deleted one is not renamed
    expect(titles(db)).toEqual({ a: 'Poster 1', b: 'Maulidur Rasul', c: 'Poster 3', gone: undefined });
    const before = JSON.stringify(titles(db));
    const version = db.prepare("SELECT value FROM meta WHERE key = 'version'").get();
    db.prepare("DELETE FROM schema_migrations WHERE name = '005-poster-titles'").run();
    runMigrations(db);
    expect(JSON.stringify(titles(db))).toBe(before);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'version'").get()).toEqual(version);
    db.close();
  });
});

describe('surau.ini parsing', () => {
  it('reads key = value, comments, quotes, case-insensitive keys, and reports the rest', () => {
    const { values, warnings } = parseSurauIni(
      '﻿# comment\n; also\n[surau]\nName = "Surau Al-Hidayah"\nKIND=masjid\nshortaddress = Taman Seri\nbogus = 1\nno equals here\nname = Surau B\n',
    );
    expect(values.get('name')).toBe('Surau B');
    expect(values.get('kind')).toBe('masjid');
    expect(values.get('shortAddress')).toBe('Taman Seri');
    expect(warnings.length).toBe(3);
  });
});

describe('first-boot surau.ini', () => {
  const INI = [
    'name = Masjid Al-Falah',
    'kind = masjid',
    'shortAddress = Taman Seri, Shah Alam',
    'helpName = Encik Ahmad',
    'helpPhone = 012-345 6789',
    'helpEmail = ahmad@example.my',
    'zone = SGR01',
  ].join('\n');

  it('applies every key as the first surauInfo, with the system actor, and logs it', () => {
    const d = tmp();
    writeFileSync(join(d, 'surau.ini'), INI);
    const db = openDb(join(d, 'a.db'));
    const log = collect();
    const r = applySurauIni(db, d, log.logger);
    expect(r.refused).toEqual([]);
    const s = getSettings(db);
    expect(s.surauInfo).toMatchObject({ name: 'Masjid Al-Falah', kind: 'masjid', shortAddress: 'Taman Seri, Shah Alam', helpPhone: '012-345 6789' });
    expect(s.zone.zone).toBe('SGR01');
    const actors = (db.prepare("SELECT actor FROM change_log WHERE entity = 'settings'").all() as { actor: string }[]).map((x) => x.actor);
    expect(actors).toEqual([SURAU_INI_ACTOR, SURAU_INI_ACTOR]);
    expect(log.warns).toEqual([]);
    db.close();
  });

  it('is ignored once surauInfo was saved (one info line), and zone is kept when already saved', () => {
    const d = tmp();
    writeFileSync(join(d, 'surau.ini'), INI);
    const db = openDb(join(d, 'b.db'));
    putFeature(db, 'surauInfo', { name: 'Dipilih Admin' }, 'user:1');
    const log = collect();
    const r = applySurauIni(db, d, log.logger);
    expect(r.skipped).toBe('already-saved');
    expect(getSettings(db).surauInfo.name).toBe('Dipilih Admin');
    expect(log.infos).toHaveLength(1);
    // never applies on a second start either
    expect(applySurauIni(db, d, collect().logger).skipped).toBe('already-saved');
    db.close();
  });

  it('refuses a bad key with a warning naming it, applies the others, never throws', () => {
    const d = tmp();
    writeFileSync(join(d, 'surau.ini'), 'name = Surau Baik\nhelpPhone = call me\nkind = dewan\nzone = xyz\n');
    const db = openDb(join(d, 'c.db'));
    const log = collect();
    const r = applySurauIni(db, d, log.logger);
    expect(r.applied).toEqual(['name']);
    expect(r.refused.sort()).toEqual(['helpPhone', 'kind', 'zone']);
    expect(log.warns.some((w) => w.includes('"helpPhone"'))).toBe(true);
    expect(log.warns.some((w) => w.includes('"zone"'))).toBe(true);
    const s = getSettings(db);
    expect(s.surauInfo.name).toBe('Surau Baik');
    expect(s.surauInfo.helpPhone).toBe('');
    expect(s.surauInfo.kind).toBe('surau');
    db.close();
  });

  it('does nothing without a file and leaves the database untouched when every key is bad', () => {
    const d = tmp();
    const db = openDb(join(d, 'd.db'));
    expect(applySurauIni(db, d, collect().logger).skipped).toBe('no-file');
    writeFileSync(join(d, 'surau.ini'), 'name =\nkind = x\n');
    const r = applySurauIni(db, d, collect().logger);
    expect(r.applied).toEqual([]);
    expect(db.prepare("SELECT 1 FROM settings WHERE feature = 'surauInfo'").get()).toBeUndefined();
    db.close();
  });

  it('imports logo.png through the asset pipeline as the logo', () => {
    const d = tmp();
    writeFileSync(join(d, 'surau.ini'), 'name = Surau Logo\n');
    const file = png(64, 48);
    writeFileSync(join(d, 'logo.png'), file);
    const db = openDb(join(d, 'e.db'));
    const log = collect();
    applySurauIni(db, d, log.logger);
    const logo = getSettings(db).surauInfo.logo as string;
    expect(logo).toMatch(/^[0-9a-f]{64}$/);
    expect(db.prepare('SELECT mime, created_by FROM assets WHERE id = ?').get(logo)).toEqual({ mime: 'image/png', created_by: SURAU_INI_ACTOR });
    expect(log.warns).toEqual([]);
    db.close();
  });

  it('accepts logo.jpg, refuses a fake .png (wrong magic) and a damaged one, still applies the name', () => {
    const d = tmp();
    writeFileSync(join(d, 'surau.ini'), 'name = Surau Palsu\n');
    writeFileSync(join(d, 'logo.png'), jpg(40, 40)); // JPEG bytes named .png
    const db = openDb(join(d, 'f.db'));
    const log = collect();
    applySurauIni(db, d, log.logger);
    expect(getSettings(db).surauInfo.logo).toBe('');
    expect(getSettings(db).surauInfo.name).toBe('Surau Palsu');
    expect(log.warns.some((w) => w.includes('logo.png'))).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM assets').get()).toEqual({ n: 0 });
    db.close();

    const d2 = tmp();
    writeFileSync(join(d2, 'surau.ini'), 'name = Surau Rosak\n');
    writeFileSync(join(d2, 'logo.png'), Buffer.from('not an image at all, just text'));
    const db2 = openDb(join(d2, 'g.db'));
    const log2 = collect();
    applySurauIni(db2, d2, log2.logger);
    expect(getSettings(db2).surauInfo.logo).toBe('');
    expect(log2.warns.some((w) => w.includes('logo.png'))).toBe(true);
    db2.close();

    const d3 = tmp();
    writeFileSync(join(d3, 'surau.ini'), 'name = Surau JPG\n');
    writeFileSync(join(d3, 'logo.jpg'), jpg(40, 40));
    const db3 = openDb(join(d3, 'h.db'));
    applySurauIni(db3, d3, collect().logger);
    expect(getSettings(db3).surauInfo.logo).toMatch(/^[0-9a-f]{64}$/);
    db3.close();
  });

  it('buildApp applies it at start and /api/surau/info + the bundle carry the logo URL', async () => {
    const d = tmp();
    writeFileSync(join(d, 'surau.ini'), 'name = Surau Bina\nkind = surau\n');
    writeFileSync(join(d, 'logo.png'), png(32, 32));
    const app = buildApp(join(d, 'app.db'), { dataDir: d });
    apps.push(app);
    const info = (await app.inject({ method: 'GET', url: '/api/surau/info', remoteAddress: '10.168.1.60' })).json();
    expect(info.name).toBe('Surau Bina');
    expect(info.logo).toMatch(/^\/surau-logo\?v=[0-9a-f]{16}$/);
    const bundle = (await app.inject({ method: 'GET', url: '/api/kiosk/bundle' })).json();
    expect(bundle.logo).toBe(info.logo);
  });
});

describe('GET /surau-logo and the app icons', () => {
  function appDirWithBundled(d: string): string {
    const a = join(d, 'app');
    mkdirSync(join(a, 'icons'), { recursive: true });
    writeFileSync(join(a, 'index.html'), '<title>app</title>');
    writeFileSync(
      join(a, 'manifest.json'),
      JSON.stringify({ name: 'Surau', short_name: 'Surau', start_url: '.', icons: [{ src: 'icons/Icon-192.png', sizes: '192x192', type: 'image/png' }] }),
    );
    writeFileSync(join(a, 'favicon.png'), png(32, 32, [1, 2, 3, 255]));
    writeFileSync(join(a, 'icons', 'Icon-192.png'), png(192, 192, [1, 2, 3, 255]));
    writeFileSync(join(a, 'icons', 'Icon-512.png'), png(512, 512, [1, 2, 3, 255]));
    writeFileSync(join(a, 'icons', 'Icon-maskable-192.png'), png(192, 192, [1, 2, 3, 255]));
    writeFileSync(join(a, 'icons', 'Icon-maskable-512.png'), png(512, 512, [1, 2, 3, 255]));
    return a;
  }

  it('404 without a logo, 200 with correct type and cache headers once set; works anonymously', async () => {
    const d = tmp();
    const app = buildApp(join(d, 'l.db'), { dataDir: d });
    apps.push(app);
    const none = await app.inject({ method: 'GET', url: '/surau-logo', remoteAddress: '10.168.1.60' });
    expect(none.statusCode).toBe(404);

    const admin = await loginAsAdmin(app);
    const file = png(120, 60);
    const up = await app.inject({ method: 'POST', url: '/api/assets', headers: { ...admin.headers, 'content-type': 'image/png' }, payload: file });
    expect(up.statusCode).toBe(201);
    const id = up.json().id as string;
    const put = await app.inject({ method: 'PUT', url: '/api/settings/surauInfo', headers: admin.headers, payload: { logo: id } });
    expect(put.statusCode).toBe(200);

    const ok = await app.inject({ method: 'GET', url: '/surau-logo', remoteAddress: '10.168.1.60' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/png');
    expect(ok.headers['cache-control']).toBe('no-cache');
    expect(ok.headers.etag).toBeTruthy();
    expect(Buffer.compare(ok.rawPayload, file)).toBe(0);
    const again = await app.inject({ method: 'GET', url: '/surau-logo', headers: { 'if-none-match': String(ok.headers.etag) } });
    expect(again.statusCode).toBe(304);
    const versioned = await app.inject({ method: 'GET', url: `/surau-logo?v=${id.slice(0, 16)}` });
    expect(versioned.headers['cache-control']).toContain('immutable');
  });

  it('refuses a logo setting that points at a missing asset or a webp', async () => {
    const d = tmp();
    const app = buildApp(join(d, 'm.db'), { dataDir: d });
    apps.push(app);
    const admin = await loginAsAdmin(app);
    const missing = await app.inject({ method: 'PUT', url: '/api/settings/surauInfo', headers: admin.headers, payload: { logo: 'c'.repeat(64) } });
    expect(missing.statusCode).toBe(400);
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'ascii');
    webp.writeUInt32LE(22, 4);
    webp.write('WEBPVP8X', 8, 'ascii');
    webp.writeUInt32LE(10, 16);
    webp.writeUIntLE(9, 24, 3);
    webp.writeUIntLE(9, 27, 3);
    const up = await app.inject({ method: 'POST', url: '/api/assets', headers: { ...admin.headers, 'content-type': 'image/webp' }, payload: webp });
    expect(up.statusCode).toBe(201);
    const bad = await app.inject({ method: 'PUT', url: '/api/settings/surauInfo', headers: admin.headers, payload: { logo: up.json().id } });
    expect(bad.statusCode).toBe(400);
  });

  it('serves the bundled icons and a name-only manifest when no logo is set', async () => {
    const d = tmp();
    const appDir = appDirWithBundled(d);
    const app = buildApp(join(d, 'n.db'), { dataDir: d, appDir });
    apps.push(app);
    const admin = await loginAsAdmin(app);
    await app.inject({ method: 'PUT', url: '/api/settings/surauInfo', headers: admin.headers, payload: { name: 'Masjid Al-Falah Shah Alam' } });
    const icon = await app.inject({ method: 'GET', url: '/app/icons/Icon-192.png' });
    expect(icon.statusCode).toBe(200);
    expect(Buffer.compare(icon.rawPayload, png(192, 192, [1, 2, 3, 255]))).toBe(0);
    expect(icon.headers['cache-control']).toBe('no-cache');
    expect((await app.inject({ method: 'GET', url: '/app/favicon.png' })).statusCode).toBe(200);
    const m = (await app.inject({ method: 'GET', url: '/app/manifest.json' })).json();
    expect(m.name).toBe('Masjid Al-Falah Shah Alam');
    expect(m.short_name).toBe('Masjid');
    expect(m.icons).toHaveLength(1);
  });

  it('serves resized icons and the manifest name from the logo; falls back when the logo is removed', async () => {
    const d = tmp();
    const appDir = appDirWithBundled(d);
    const app = buildApp(join(d, 'o.db'), { dataDir: d, appDir });
    apps.push(app);
    const admin = await loginAsAdmin(app);
    const up = await app.inject({ method: 'POST', url: '/api/assets', headers: { ...admin.headers, 'content-type': 'image/png' }, payload: png(300, 150, [10, 200, 10, 255]) });
    await app.inject({ method: 'PUT', url: '/api/settings/surauInfo', headers: admin.headers, payload: { name: 'Surau Bina', logo: up.json().id } });

    const sizes: Record<string, [number, number]> = {
      '/app/favicon.png': [32, 32],
      '/app/icons/Icon-192.png': [192, 192],
      '/app/icons/Icon-512.png': [512, 512],
      '/app/icons/Icon-maskable-192.png': [192, 192],
      '/app/icons/Icon-maskable-512.png': [512, 512],
    };
    for (const [url, size] of Object.entries(sizes)) {
      const r = await app.inject({ method: 'GET', url, remoteAddress: '10.168.1.60' });
      expect(r.statusCode, url).toBe(200);
      expect(r.headers['content-type']).toBe('image/png');
      expect(pngSize(r.rawPayload), url).toEqual(size);
    }
    // maskable is fully opaque with the logo in the middle; "any" keeps transparent corners
    const mask = PNG.sync.read((await app.inject({ method: 'GET', url: '/app/icons/Icon-maskable-192.png' })).rawPayload);
    expect(mask.data[3]).toBe(255);
    expect([mask.data[0], mask.data[1], mask.data[2]]).toEqual([0x06, 0x30, 0x2b]);
    const mid = (96 * 192 + 96) * 4;
    expect(mask.data[mid + 1]).toBeGreaterThan(150);
    const any = PNG.sync.read((await app.inject({ method: 'GET', url: '/app/icons/Icon-192.png' })).rawPayload);
    expect(any.data[3]).toBe(0);
    expect(any.data[(96 * 192 + 96) * 4 + 3]).toBe(255);

    const m = (await app.inject({ method: 'GET', url: '/app/manifest.json' })).json();
    expect(m.name).toBe('Surau Bina');
    expect(m.short_name).toBe('Surau Bina');
    const mr = await app.inject({ method: 'GET', url: '/app/manifest.json' });
    expect(mr.headers['content-type']).toContain('application/manifest+json');
    expect(mr.headers['cache-control']).toBe('no-cache');
    // one CSP only, the /app/ one
    expect(String(mr.headers['content-security-policy'])).toContain('wasm-unsafe-eval');

    await app.inject({ method: 'PUT', url: '/api/settings/surauInfo', headers: admin.headers, payload: { logo: '' } });
    const back = await app.inject({ method: 'GET', url: '/app/icons/Icon-192.png' });
    expect(Buffer.compare(back.rawPayload, png(192, 192, [1, 2, 3, 255]))).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/surau-logo' })).statusCode).toBe(404);
  });
});
