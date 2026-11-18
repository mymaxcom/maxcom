import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { THEME_BUNDLE_FORMAT } from '@surau/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { putAsset } from '../src/assets/store.ts';
import { getSettings, putFeature } from '../src/settingsStore.ts';
import { PACK_MIME } from '../src/themes/packFormat.ts';
import { createThemeStore } from '../src/themes/store.ts';
import { loginAs, TEST_PIN } from './authHelpers.ts';
import { ensureSurau } from './support/surauRow.ts';
import { jpeg, manifestJson as json, zip } from './support/themePacks.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function cloud(): { app: FastifyInstance; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'surau-cloudtheme-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'cloud.db'), { dataDir: dir, role: 'cloud', boxId: 'c'.repeat(16) });
  apps.push(app);
  return { app, dir };
}

const pack = (marker = 'a'): Buffer => zip({
  'theme.json': json({ version: 3 }),
  'theme.css': `.stage{background:url(images/kuliah.jpg)} /* ${marker} */`,
  'images/kuliah.jpg': jpeg(64, 36),
});
const hashOfZip = (z: Buffer): string => `${createHash('sha256').update(z).digest('hex').slice(0, 16)}-${THEME_BUNDLE_FORMAT}`;

/** Gives a surau an installed pack record whose file the cloud holds (as a sync from a box leaves it). */
function syncPack(app: FastifyInstance, dir: string, surauId: string, z: Buffer, name = 'hijau-siti'): void {
  const db = app.surau.db;
  ensureSurau(db, surauId, `Surau ${surauId}`);
  const meta = putAsset(db, dir, z, PACK_MIME, 'sync');
  db.prepare("INSERT OR IGNORE INTO surau_assets (surau_id, asset_id, bytes, created_at) VALUES (?, ?, ?, '2026-11-01T00:00:00.000Z')").run(surauId, meta.id, z.length);
  putFeature(db, 'themeStyle', { packs: { [name]: { assetId: meta.id, version: 3, title: 'Hijau Siti', base: 'creative', contract: 1, bytes: z.length, fonts: [], screens: [], images: { kuliah: 'jpg' }, defaults: {} } } }, 'sync', undefined, surauId);
}

describe('cloud theme preview is per surau', () => {
  it('Q1: a pack synced into a surau other than sdm is served', async () => {
    const { app, dir } = cloud();
    const z = pack();
    syncPack(app, dir, 'sdm-b', z);
    const r = await app.inject({ method: 'GET', url: `/themes/hijau-siti/${hashOfZip(z)}/bundle.css` });
    expect(r.statusCode, r.body).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/themes/hijau-siti/${hashOfZip(z)}/images/kuliah.jpg` })).statusCode).toBe(200);
  });

  it('Q2: the same name in more than 20 suraus: the one holding this exact hash is served, whichever it is', async () => {
    const { app, dir } = cloud();
    for (let i = 0; i < 25; i++) syncPack(app, dir, `s-${String(i).padStart(2, '0')}`, pack(`m${i}`));
    const z = pack('m24');
    const r = await app.inject({ method: 'GET', url: `/themes/hijau-siti/${hashOfZip(z)}/bundle.css` });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain('hijau-siti');
    // a hash nobody holds is 404
    expect((await app.inject({ method: 'GET', url: `/themes/hijau-siti/${hashOfZip(pack('none'))}/bundle.css` })).statusCode).toBe(404);
  });

  it('S3: a broken pack of another surau does not stop this one and is not read on the way', async () => {
    const { app, dir } = cloud();
    ensureSurau(app.surau.db, 'a-bad', 'A');
    putFeature(app.surau.db, 'themeStyle', { packs: { 'hijau-siti': { assetId: 'f'.repeat(64), version: 3, title: 'X', base: 'creative', contract: 1, bytes: 10, fonts: [], screens: [], images: {}, defaults: {} } } }, 'sync', undefined, 'a-bad');
    const z = pack();
    syncPack(app, dir, 'z-good', z);
    expect((await app.inject({ method: 'GET', url: `/themes/hijau-siti/${hashOfZip(z)}/bundle.css` })).statusCode).toBe(200);
  });
});

describe('cloud: pictures a surau names must be held by that surau (S1)', () => {
  it('surau A cannot name a picture only surau B holds, as a menu background or a logo', async () => {
    const { app, dir } = cloud();
    ensureSurau(app.surau.db, 'sdm-a', 'A');
    ensureSurau(app.surau.db, 'sdm-b', 'B');
    const img = putAsset(app.surau.db, dir, jpeg(16, 16), 'image/jpeg', 'u');
    app.surau.db.prepare("INSERT INTO surau_assets (surau_id, asset_id, bytes, created_at) VALUES ('sdm-b', ?, 100, '2026-11-01T00:00:00.000Z')").run(img.id);
    const a = await loginAs(app, 'admin', TEST_PIN, 'sdm-a');
    const bg = await app.inject({ method: 'PUT', url: '/api/settings/themeStyle', headers: a.headers, payload: { styles: { creative: { semua: { bgImage: img.id }, skrin: {} } } } });
    expect(bg.statusCode, bg.body).toBe(400);
    const logo = await app.inject({ method: 'PUT', url: '/api/settings/surauInfo', headers: a.headers, payload: { logo: img.id } });
    expect(logo.statusCode, logo.body).toBe(400);
    const packRec = { assetId: img.id, version: 3, title: 'Hijau Siti', base: 'creative', contract: 1, bytes: 10, fonts: [], screens: [], images: {}, defaults: {} };
    const pk = await app.inject({ method: 'PUT', url: '/api/settings/themeStyle', headers: a.headers, payload: { packs: { 'hijau-siti': packRec } } });
    expect(pk.statusCode, pk.body).toBe(400);
    expect(getSettings(app.surau.db, 'sdm-a').themeStyle.packs['hijau-siti']).toBeUndefined();
    // the surau that holds it may use it
    const b = await loginAs(app, 'admin', TEST_PIN, 'sdm-b');
    const ok = await app.inject({ method: 'PUT', url: '/api/settings/themeStyle', headers: b.headers, payload: { styles: { creative: { semua: { bgImage: img.id }, skrin: {} } } } });
    expect(ok.statusCode, ok.body).toBe(200);
  });
});

describe('health theme state (S2, Q3)', () => {
  it('S2: on a box, an anonymous caller behind a proxy (x-forwarded-for) gets no themeOk; a plain loopback caller does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-healthproxy-'));
    dirs.push(dir);
    const app = buildApp(join(dir, 'box.db'));
    apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json().themeOk).toBe(true);
    const proxied = await app.inject({ method: 'GET', url: '/api/health', headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(proxied.json().themeOk).toBeUndefined();
    const cf = await app.inject({ method: 'GET', url: '/api/health', headers: { 'cf-connecting-ip': '203.0.113.9' } });
    expect(cf.json().themeOk).toBeUndefined();
  });

  it('S2: on the cloud an anonymous caller never gets themeOk, even from loopback', async () => {
    const { app } = cloud();
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json().themeOk).toBeUndefined();
  });

  it('Q3: an admin of a cloud surau sees no theme fields of the local surau', async () => {
    const { app } = cloud();
    ensureSurau(app.surau.db, 'sdm-b', 'B');
    const a = await loginAs(app, 'admin', TEST_PIN, 'sdm-b');
    const h = (await app.inject({ method: 'GET', url: '/api/health', headers: a.headers })).json();
    expect(h.themeOk).toBeUndefined();
    expect(h.themeHealth).toBeUndefined();
  });
});

describe('cloud theme store (store level)', () => {
  const mk = (extra: Partial<Parameters<typeof createThemeStore>[0]> = {}) => {
    const { app, dir } = cloud();
    return { app, dir, store: createThemeStore({ db: app.surau.db, dataDir: dir, now: () => new Date(), role: 'cloud', ...extra }) };
  };

  it('N1: a pack that fails validation on the cloud is checked once, not on every request', async () => {
    let n = 0;
    const { app, dir, store } = mk({ onValidate: () => { n++; } });
    const bad = zip({ 'theme.json': json({ version: 3 }), 'theme.css': '@import "https://x.example/a.css";' });
    syncPack(app, dir, 'sdm-b', bad);
    expect(await store.ensureExtracted('hijau-siti', 'sdm-b')).toBeNull();
    expect(await store.ensureExtracted('hijau-siti', 'sdm-b')).toBeNull();
    expect(await store.ensureExtracted('hijau-siti', 'sdm-b')).toBeNull();
    expect(n).toBe(1);
    // another surau with the same name is not hidden by it
    const good = pack();
    syncPack(app, dir, 'sdm-c', good);
    expect(await store.ensureExtracted('hijau-siti', 'sdm-c')).not.toBeNull();
  });

  it('startUpClean: a cloud store started again keeps the extracted folders of every surau', async () => {
    const { app, dir, store } = mk();
    const z = pack();
    syncPack(app, dir, 'sdm-b', z);
    const f = await store.ensureExtracted('hijau-siti', 'sdm-b');
    expect(f).not.toBeNull();
    createThemeStore({ db: app.surau.db, dataDir: dir, now: () => new Date(), role: 'cloud' });
    expect(existsSync(join(f!.dir, 'bundle.css'))).toBe(true);
  });

  it('N3: two suraus holding the same pack extract it once (the in-flight key is the folder)', async () => {
    let n = 0;
    const { app, dir, store } = mk({ onValidate: () => { n++; } });
    const z = pack();
    syncPack(app, dir, 'sdm-b', z);
    syncPack(app, dir, 'sdm-c', z);
    const [x, y] = await Promise.all([store.ensureExtracted('hijau-siti', 'sdm-b'), store.ensureExtracted('hijau-siti', 'sdm-c')]);
    expect(x).not.toBeNull();
    expect(y).toEqual(x);
    expect(n).toBe(1);
  });
});
