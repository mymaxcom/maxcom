import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveScreenStyle } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { putAsset } from '../src/assets/store.ts';
import { getSettings, putFeature } from '../src/settingsStore.ts';
import { PACK_MIME, readPack } from '../src/themes/packFormat.ts';
import { validatePack } from '../src/themes/validate.ts';
import { loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { jpeg, manifestJson as json, noisePng, png, zip } from './support/themePacks.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const KIOSK_THEMES = resolve(here, '..', '..', 'kiosk-display', 'src', 'themes');
const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A box whose kiosk build folder holds builtin-themes/ (as the real build writes it). */
async function setup(): Promise<{ app: FastifyInstance; dir: string; admin: Login['headers'] }> {
  const dir = mkdtempSync(join(tmpdir(), 'surau-themedl-'));
  dirs.push(dir);
  const staticDir = join(dir, 'kiosk-dist');
  for (const id of ['default', 'colourful', 'creative', 'oldschool', 'minimal']) {
    mkdirSync(join(staticDir, 'builtin-themes', id), { recursive: true });
    cpSync(join(KIOSK_THEMES, id, 'theme.json'), join(staticDir, 'builtin-themes', id, 'theme.json'));
    cpSync(join(KIOSK_THEMES, id, 'theme.css'), join(staticDir, 'builtin-themes', id, 'theme.css'));
  }
  const app = buildApp(join(dir, 'test.db'), { staticDir });
  apps.push(app);
  const login = await loginAs(app, 'admin');
  return { app, dir, admin: login.headers };
}

const get = (app: FastifyInstance, admin: Login['headers'], url: string) => app.inject({ method: 'GET', url, headers: admin });
const ctx = { installed: {}, contract: 1, enforceVersion: true };

async function installPack(app: FastifyInstance, admin: Login['headers'], payload: Buffer): Promise<void> {
  const c = await app.inject({ method: 'POST', url: '/api/themes/check', headers: { ...admin, 'content-type': PACK_MIME }, payload });
  const i = await app.inject({ method: 'POST', url: '/api/themes/install', headers: admin, payload: { stagedId: c.json().stagedId } });
  if (i.statusCode !== 201) throw new Error(`install failed ${i.statusCode} ${i.body}`);
}

const uploadedPack = (): Buffer => zip({
  'theme.json': json({ defaults: { semua: { accent: '#0a8f4e', shade: 30 } } }),
  'theme.css': '.stage{--accent:#0a0}',
  'arabic.css': '.arab{color:gold}',
  'screens/poster.css': '.region-next{margin-top:1rem}',
  'images/kuliah.png': png(64, 36),
});

describe('theme download', () => {
  it('a built-in downloads as a starting pack this box accepts', async () => {
    const { app, admin } = await setup();
    putFeature(app.surau.db, 'surauInfo', { name: 'Surau Contoh' }, 'test', undefined, LOCAL_SURAU_ID);
    const r = await get(app, admin, '/api/themes/creative/pack?bake=0&as=creative-surau-contoh');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe(PACK_MIME);
    expect(r.headers['content-disposition']).toBe('attachment; filename="creative-surau-contoh.maxtheme"');
    const p = readPack(r.rawPayload);
    expect(p.manifest).toMatchObject({ name: 'creative-surau-contoh', title: 'Creative (Surau Contoh)', version: 1, contract: 1, base: 'creative', defaults: { semua: { shade: 35 } } });
    expect(p.css.get('theme.css')).toContain('data-screen');
    expect(p.css.get('theme.css')!.trim().startsWith('/*')).toBe(true);
    expect([...p.css.keys()]).toEqual(['theme.css']);
    expect(validatePack(r.rawPayload, ctx).report.ok).toBe(true);
  });

  it('a built-in without "as", or with a reserved or bad name, is 400', async () => {
    const { app, admin } = await setup();
    for (const q of ['', '?as=', '?as=creative', '?as=arabic', '?as=Bad', '?as=../x', '?as=' + 'a'.repeat(33), '?as=a_b', '?as=con', '?as=nul', '?as=aux', '?as=prn', '?as=com1', '?as=com9', '?as=lpt1', '?as=lpt9']) {
      expect((await get(app, admin, `/api/themes/creative/pack${q}`)).statusCode, q).toBe(400);
    }
    expect((await get(app, admin, '/api/themes/creative/pack?as=ok-name&bake=2')).statusCode).toBe(400);
    expect((await get(app, admin, '/api/themes/tiada/pack?as=ok-name')).statusCode).toBe(404);
  });

  it('only settings:write may download', async () => {
    const { app } = await setup();
    const ajk = await loginAs(app, 'ajk');
    expect((await app.inject({ method: 'GET', url: '/api/themes/creative/pack?as=x-y' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/themes/creative/pack?as=x-y', headers: ajk.headers })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/themes/creative/pack?as=x-y', remoteAddress: '10.8.8.8' })).statusCode).toBe(401);
  });

  it('bake puts the menu values into defaults and the menu pictures into images/', async () => {
    const { app, dir, admin } = await setup();
    const a = putAsset(app.surau.db, dir, png(100, 60, 1), 'image/png', 'u');
    const b = putAsset(app.surau.db, dir, jpeg(100, 60, 1), 'image/jpeg', 'u');
    putFeature(app.surau.db, 'themeStyle', { styles: { creative: { semua: { accent: '#111111', bgImage: a.id }, skrin: { kuliah: { shade: 40, bgImage: b.id } } } } }, 'u', undefined, LOCAL_SURAU_ID);
    const r = await get(app, admin, '/api/themes/creative/pack?as=creative-saya');
    expect(r.statusCode).toBe(200);
    const p = readPack(r.rawPayload);
    expect(p.manifest.defaults).toEqual({ semua: { shade: 35, accent: '#111111' }, skrin: { kuliah: { shade: 40 } } });
    expect(p.images.get('semua')).toMatchObject({ ext: 'png' });
    expect(p.images.get('kuliah')).toMatchObject({ ext: 'jpg' });
    expect(p.images.get('semua')!.data.equals(png(100, 60, 1))).toBe(true);
    // and without the changes the file is the plain starting pack
    const plain = readPack((await get(app, admin, '/api/themes/creative/pack?bake=0&as=creative-saya')).rawPayload);
    expect(plain.manifest.defaults).toEqual({ semua: { shade: 35 } });
    expect(plain.images.size).toBe(0);
  });

  it('an installed pack without bake is byte-identical to what was uploaded', async () => {
    const { app, admin } = await setup();
    const z = uploadedPack();
    await installPack(app, admin, z);
    const r = await get(app, admin, '/api/themes/hijau-siti/pack?bake=0');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toContain('hijau-siti.maxtheme');
    expect(r.rawPayload.equals(z)).toBe(true);
    expect((await get(app, admin, '/api/themes/nope-nope/pack?bake=0')).statusCode).toBe(404);
  });

  it('an installed pack with bake keeps its css and its version', async () => {
    const { app, dir, admin } = await setup();
    await installPack(app, admin, uploadedPack());
    const pic = putAsset(app.surau.db, dir, jpeg(100, 60, 2), 'image/jpeg', 'u');
    putFeature(app.surau.db, 'themeStyle', { styles: { 'hijau-siti': { semua: { shade: 50 }, skrin: { kuliah: { bgImage: pic.id, accent: '#222222' } } } } }, 'u', undefined, LOCAL_SURAU_ID);
    const r = await get(app, admin, '/api/themes/hijau-siti/pack?bake=1');
    expect(r.statusCode).toBe(200);
    const p = readPack(r.rawPayload);
    expect(p.manifest).toMatchObject({ name: 'hijau-siti', version: 3, base: 'creative' });
    expect(p.manifest.defaults).toEqual({ semua: { accent: '#0a8f4e', shade: 50 }, skrin: { kuliah: { accent: '#222222' } } });
    expect([...p.css.keys()].sort()).toEqual(['arabic.css', 'screens/poster.css', 'theme.css']);
    expect(p.css.get('theme.css')).toBe('.stage{--accent:#0a0}');
    expect(p.css.has('fonts')).toBe(false);
    // the surau's picture replaces the pack's picture of the same screen, whatever its type
    expect(p.images.get('kuliah')).toMatchObject({ ext: 'jpg' });
    expect(p.images.has('kuliah') && p.images.size).toBe(1);
  });

  it('upload of a baked download on a fresh box shows the same stage variables', async () => {
    const first = await setup();
    const second = await setup();
    const pic = putAsset(first.app.surau.db, first.dir, jpeg(100, 60, 3), 'image/jpeg', 'u');
    const sem = putAsset(first.app.surau.db, first.dir, png(100, 60, 3), 'image/png', 'u');
    putFeature(first.app.surau.db, 'themeStyle', { styles: { creative: { semua: { accent: '#111111', bgImage: sem.id, scale: 'L' }, skrin: { kuliah: { shade: 40, bgImage: pic.id, align: 'tengah' } } } } }, 'u', undefined, LOCAL_SURAU_ID);
    const baked = await get(first.app, first.admin, '/api/themes/creative/pack?as=creative-surau');
    await installPack(second.app, second.admin, baked.rawPayload);
    const record = getSettings(second.app.surau.db, LOCAL_SURAU_ID).themeStyle.packs['creative-surau']!;
    const mine = resolveScreenStyle(getSettings(first.app.surau.db, LOCAL_SURAU_ID).themeStyle.styles, 'creative', 'kuliah', { semua: { shade: 35 } });
    const { bgImage: _a, ...expected } = mine;
    expect(resolveScreenStyle({}, 'creative-surau', 'kuliah', record.defaults)).toEqual(expected);
    const other = resolveScreenStyle(getSettings(first.app.surau.db, LOCAL_SURAU_ID).themeStyle.styles, 'creative', 'poster', { semua: { shade: 35 } });
    const { bgImage: _b, ...expectedOther } = other;
    expect(resolveScreenStyle({}, 'creative-surau', 'poster', record.defaults)).toEqual(expectedOther);
    expect(record.images).toEqual({ kuliah: 'jpg', semua: 'png' });
    expect(record.base).toBe('creative');
  });

  it('over the limit after baking: 400 with the sentence', async () => {
    const { app, dir, admin } = await setup();
    // two pictures of about 4.4 MB each are a legal pack; two menu pictures of 4.3 MB each push the baked file past 15 MB
    await installPack(app, admin, zip({ 'theme.json': json(), 'theme.css': '', 'images/hadis.png': noisePng(1600, 900, 1), 'images/zikir.png': noisePng(1600, 900, 2) }));
    const a = putAsset(app.surau.db, dir, png(100, 100, 4_300_000), 'image/png', 'u');
    const b = putAsset(app.surau.db, dir, png(100, 101, 4_300_000), 'image/png', 'u');
    putFeature(app.surau.db, 'themeStyle', { styles: { 'hijau-siti': { semua: { bgImage: a.id }, skrin: { kuliah: { bgImage: b.id } } } } }, 'u', undefined, LOCAL_SURAU_ID);
    const r = await get(app, admin, '/api/themes/hijau-siti/pack?bake=1');
    expect(r.statusCode).toBe(400);
    expect(r.json().errors[0]).toBe('Fail tema melebihi had selepas ubah suai disertakan. Muat turun tanpa ubah suai.');
    expect((await get(app, admin, '/api/themes/hijau-siti/pack?bake=0')).statusCode).toBe(200);
  });

  it('a missing built-in folder is a clear 500, never a wrong file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-themedl-'));
    dirs.push(dir);
    const app = buildApp(join(dir, 'test.db'));
    apps.push(app);
    const login = await loginAs(app, 'admin');
    const r = await get(app, login.headers, '/api/themes/creative/pack?as=x-y');
    expect(r.statusCode).toBe(500);
  });
});
