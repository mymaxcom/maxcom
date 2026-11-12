/**
 * Plan 4 add-on C: non-destructive image adjustment on the box (analyze, render, derived assets,
 * kiosk bundle, /surau-logo, first-boot logo).
 */
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { decodeImage } from '../src/imageResize.ts';
import type { Rgba } from '../src/imageResize.ts';
import { analyzeImage, deriveImage, PLATE_COLOUR, renderSlot, resolveImageId } from '../src/imageAdjust.ts';
import { applySurauIni } from '../src/surauIni.ts';
import { openDb } from '../src/db.ts';
import { getSettings } from '../src/settingsStore.ts';
import { getAssetPath, putAsset } from '../src/assets/store.ts';
import { loginAsAdmin } from './authHelpers.ts';

const req = createRequire(import.meta.url);
const { PNG } = req('pngjs') as typeof import('pngjs');

const MAXCOM = readFileSync(fileURLToPath(new URL('./fixtures/maxcom-logo.png', import.meta.url)));
const SRC = decodeImage(MAXCOM);

const px = (img: Rgba, x: number, y: number): [number, number, number, number] => {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!];
};

/** The darkest opaque pixel of the fixture: a letter pixel. */
function darkest(img: Rgba): { x: number; y: number; rgba: [number, number, number, number] } {
  let best = { x: 0, y: 0, v: 1e9 };
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const p = px(img, x, y);
      const v = p[0] + p[1] + p[2];
      if (v < best.v) best = { x, y, v };
    }
  }
  return { x: best.x, y: best.y, rgba: px(img, best.x, best.y) };
}

const dirs: string[] = [];
const dbs: ReturnType<typeof openDb>[] = [];
const track = (db: ReturnType<typeof openDb>): ReturnType<typeof openDb> => {
  dbs.push(db);
  return db;
};
const apps: FastifyInstance[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'surau-adjust-'));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function solid(w: number, h: number, rgba: [number, number, number, number], mark?: (set: (x: number, y: number, c: [number, number, number, number]) => void) => void): Buffer {
  const p = new PNG({ width: w, height: h });
  const set = (x: number, y: number, c: [number, number, number, number]): void => p.data.set(c, (y * w + x) * 4);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) set(x, y, rgba);
  mark?.(set);
  return PNG.sync.write(p);
}

const asset = (db: ReturnType<typeof openDb>, dir: string, buf: Buffer): string => putAsset(db, dir, buf, 'image/png', 'test').id;
const ID = /^[0-9a-f]{64}$/;

describe('analyzeImage', () => {
  it('finds the plain white background and a tight trim box on the maxcom logo', () => {
    const a = analyzeImage(SRC);
    expect(a.width).toBe(500);
    expect(a.height).toBe(126);
    expect(a.background.plain).toBe(true);
    expect(a.background.colour).toBe('#ffffff');
    expect(a.background.confidence).toBeGreaterThan(0.9);
    expect(a.background.suggested).toBe('remove');
    expect(a.trim.x * 500).toBeGreaterThan(14);
    expect(a.trim.x * 500).toBeLessThan(23);
    expect(a.trim.y * 126).toBeGreaterThan(3);
    expect(a.trim.y * 126).toBeLessThan(11);
    expect((a.trim.x + a.trim.w) * 500).toBeGreaterThan(478);
    expect((a.trim.x + a.trim.w) * 500).toBeLessThanOrEqual(500);
    expect((a.trim.y + a.trim.h) * 126).toBeGreaterThan(120);
  });

  it('a photo-like image has no plain background and keeps the whole frame', () => {
    const noisy = decodeImage(
      solid(40, 30, [0, 0, 0, 255], (set) => {
        for (let y = 0; y < 30; y += 1) for (let x = 0; x < 40; x += 1) set(x, y, [(x * 37) % 256, (y * 91) % 256, (x * y) % 256, 255]);
      }),
    );
    const a = analyzeImage(noisy);
    expect(a.background.plain).toBe(false);
    expect(a.trim).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('a single-colour image is not trimmed (nothing to find)', () => {
    const a = analyzeImage(decodeImage(solid(32, 32, [200, 30, 30, 255])));
    expect(a.trim).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe('renderSlot', () => {
  const ref = (extra: object = {}) => ({ asset: 'a'.repeat(64), ...extra }) as never;

  it('bg remove: corners become transparent, the letters stay as they were', () => {
    const out = decodeImage(renderSlot(SRC, 'logo', ref({ bg: 'remove' })).data);
    expect([out.width, out.height]).toEqual([500, 126]); // never enlarged
    for (const [x, y] of [[0, 0], [499, 0], [0, 125], [499, 125]] as const) expect(px(out, x, y)[3]).toBe(0);
    const d = darkest(SRC);
    const after = px(out, d.x, d.y);
    expect(after[3]).toBe(255);
    expect(Math.abs(after[0] - d.rgba[0]) + Math.abs(after[1] - d.rgba[1]) + Math.abs(after[2] - d.rgba[2])).toBeLessThan(12);
  });

  it('bg card: the plate colour shows around the picture, inside the rounded corners', () => {
    const crop = { x: 0.03, y: 0.05, w: 0.94, h: 0.94 };
    const out = decodeImage(renderSlot(SRC, 'logo', ref({ crop, bg: 'card' })).data);
    expect(out.width).toBeGreaterThan(Math.round(500 * 0.94) - 1); // plate adds padding
    expect(px(out, 0, 0)[3]).toBe(0); // the plate is rounded: the very corner is empty
    const inside = px(out, 6, Math.floor(out.height / 2));
    expect(inside.slice(0, 3)).toEqual(PLATE_COLOUR);
    expect(inside[3]).toBe(255);
  });

  it('crop and rotate: output size follows the crop (and 90 degrees swaps the sides)', () => {
    const crop = { x: 0, y: 0, w: 0.5, h: 0.5 };
    const a = decodeImage(renderSlot(SRC, 'logo', ref({ crop })).data);
    expect([a.width, a.height]).toEqual([250, 63]);
    const r = decodeImage(renderSlot(SRC, 'logo', ref({ rotate: 90 })).data);
    expect(r.width).toBeLessThan(r.height); // 126 x 500 turned, shrunk to fit 1024x192: 48 x 192
    expect(r.height).toBe(192);
  });

  it('logoSquare is a 512 square; an explicit square area is honoured', () => {
    const def = decodeImage(renderSlot(SRC, 'logoSquare', ref({ bg: 'remove' })).data);
    expect([def.width, def.height]).toEqual([512, 512]);
    expect(px(def, 0, 0)[3]).toBe(0);
    let inkInMiddleRow = 0;
    for (let x = 0; x < 512; x += 1) if (px(def, x, 256)[3] > 0) inkInMiddleRow += 1;
    expect(inkInMiddleRow).toBeGreaterThan(100); // the logo sits in the middle
    const sq = decodeImage(renderSlot(SRC, 'logoSquare', ref({ square: { x: 0.05, y: 0, w: 0.25, h: 1 } })).data);
    expect([sq.width, sq.height]).toEqual([512, 512]);
  });

  it('other slots come out at their fixed sizes (poster contain, photo and cover cropped to the frame)', () => {
    const big = decodeImage(solid(3000, 1000, [10, 120, 60, 255]));
    const poster = renderSlot(big, 'poster', ref({ rotate: 0 }));
    const p = decodeImage(poster.data);
    expect(p.width).toBeLessThanOrEqual(1920);
    expect(p.height).toBeLessThanOrEqual(1080);
    expect(p.width / p.height).toBeCloseTo(3, 1); // contain keeps the picture's own shape
    const photo = decodeImage(renderSlot(big, 'penceramah', ref({ rotate: 0 })).data);
    expect([photo.width, photo.height]).toEqual([512, 512]);
    const cover = decodeImage(renderSlot(big, 'kitab', ref({ rotate: 0 })).data);
    expect([cover.width, cover.height]).toEqual([400, 600]);
  });
});

describe('deriveImage (derived assets)', () => {
  function setup() {
    const d = tmp();
    const db = track(openDb(join(d, 'x.db')));
    const id = asset(db, d, MAXCOM);
    const count = (): number => Number(db.prepare('SELECT COUNT(*) AS n FROM assets').get()!.n);
    return { d, db, id, count };
  }

  it('a legacy plain id is returned as it is: no derivative, nothing stored', () => {
    const { d, db, id, count } = setup();
    const before = count();
    expect(deriveImage(db, d, 'logo', id)).toBe(id);
    expect(count()).toBe(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM asset_derivatives').get()!.n).toBe(0);
  });

  it('an object with no adjustment is the original asset too', () => {
    const { d, db, id } = setup();
    expect(deriveImage(db, d, 'logo', { asset: id })).toBe(id);
  });

  it('the same params twice give the same derived id and no duplicate', () => {
    const { d, db, id, count } = setup();
    const ref = { asset: id, bg: 'remove' as const, crop: { x: 0.03, y: 0.05, w: 0.94, h: 0.94 } };
    const a = deriveImage(db, d, 'logo', ref);
    const afterFirst = count();
    const b = deriveImage(db, d, 'logo', { ...ref });
    expect(a).toMatch(ID);
    expect(a).not.toBe(id);
    expect(b).toBe(a);
    expect(count()).toBe(afterFirst);
    expect(db.prepare('SELECT COUNT(*) AS n FROM asset_derivatives').get()!.n).toBe(1);
    // different params: a different derivative
    const c = deriveImage(db, d, 'logo', { ...ref, bg: 'card' });
    expect(c).not.toBe(a);
  });

  it('refuses a source that is not a PNG/JPEG on the box or is missing', () => {
    const { d, db } = setup();
    expect(() => deriveImage(db, d, 'logo', { asset: 'e'.repeat(64), bg: 'remove' })).toThrow(/does not exist/);
  });
});

describe('through the API', () => {
  async function boot(opts: { logoFile?: Buffer } = {}) {
    const d = tmp();
    if (opts.logoFile) writeFileSync(join(d, 'logo.png'), opts.logoFile);
    const app = buildApp(join(d, 'a.db'), { dataDir: d });
    apps.push(app);
    const admin = await loginAsAdmin(app);
    const upload = async (buf: Buffer): Promise<string> => {
      const r = await app.inject({ method: 'POST', url: '/api/assets', headers: { ...admin.headers, 'content-type': 'image/png' }, payload: buf });
      expect([200, 201]).toContain(r.statusCode);
      return r.json().id as string;
    };
    return { d, app, admin, upload };
  }
  const poster = (assetId: unknown) => ({ title: 'Poster satu', assetId, days: ['umum'], order: 1 });

  it('GET /api/assets/:id/analyze needs sign-in, answers the analysis, 404 for an unknown id', async () => {
    const { app, admin, upload } = await boot();
    const id = await upload(MAXCOM);
    const anon = await app.inject({ method: 'GET', url: `/api/assets/${id}/analyze`, remoteAddress: '10.168.1.80' });
    expect(anon.statusCode).toBe(401);
    const ok = await app.inject({ method: 'GET', url: `/api/assets/${id}/analyze`, headers: admin.headers });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.width).toBe(500);
    expect(body.background.plain).toBe(true);
    expect(body.trim.w).toBeGreaterThan(0.5);
    const missing = await app.inject({ method: 'GET', url: `/api/assets/${'e'.repeat(64)}/analyze`, headers: admin.headers });
    expect(missing.statusCode).toBe(404);
  });

  it('kiosk content carries the derived id, the app read keeps the adjustment, a legacy id stays', async () => {
    const { app, admin, upload } = await boot();
    const id = await upload(MAXCOM);
    const ref = { asset: id, bg: 'remove', crop: { x: 0.03, y: 0.05, w: 0.94, h: 0.94 } };
    const put = await app.inject({ method: 'PUT', url: '/api/content/poster/p1', headers: admin.headers, payload: poster(ref) });
    expect(put.statusCode).toBe(201);
    expect(put.json().item.assetId).toEqual(ref);
    const legacy = await app.inject({ method: 'PUT', url: '/api/content/poster/p2', headers: admin.headers, payload: { ...poster(id), title: 'Poster dua', order: 2 } });
    expect(legacy.statusCode).toBe(201);

    const kiosk = (await app.inject({ method: 'GET', url: '/api/kiosk/content' })).json().content.posters as { id: string; assetId: string }[];
    const p1 = kiosk.find((p) => p.id === 'p1')!;
    const p2 = kiosk.find((p) => p.id === 'p2')!;
    expect(p1.assetId).toMatch(ID);
    expect(p1.assetId).not.toBe(id);
    expect(p2.assetId).toBe(id);
    const file = await app.inject({ method: 'GET', url: `/assets/${p1.assetId}` });
    expect(file.statusCode).toBe(200);
    const stored = (await app.inject({ method: 'GET', url: '/api/content/poster/p1', headers: admin.headers })).json().item;
    expect(stored.assetId).toEqual(ref);
  });

  it('refuses huge or wrong adjustments and a missing source (400 / 409)', async () => {
    const { app, admin, upload } = await boot();
    const id = await upload(MAXCOM);
    for (const crop of [{ x: 0, y: 0, w: 1e9, h: 1e9 }, { x: 0, y: 0, w: 0.5 }, { x: -1, y: 0, w: 1, h: 1 }]) {
      const r = await app.inject({ method: 'PUT', url: '/api/content/poster/p1', headers: admin.headers, payload: poster({ asset: id, crop }) });
      expect(r.statusCode, JSON.stringify(crop)).toBe(400);
    }
    const bad = await app.inject({ method: 'PUT', url: '/api/settings/surauInfo', headers: admin.headers, payload: { logo: { asset: id, crop: { x: 0, y: 0, w: 1e9, h: 1e9 } } } });
    expect(bad.statusCode).toBe(400);
    const none = await app.inject({ method: 'PUT', url: '/api/content/poster/p1', headers: admin.headers, payload: poster({ asset: 'e'.repeat(64), bg: 'remove' }) });
    expect([400, 409]).toContain(none.statusCode);
  });

  it('GET /surau-logo serves the derived logo; the app icons are made from the square', async () => {
    const { app, admin, upload } = await boot();
    const id = await upload(MAXCOM);
    const put = await app.inject({ method: 'PUT', url: '/api/settings/surauInfo', headers: admin.headers, payload: { logo: { asset: id, bg: 'remove' } } });
    expect(put.statusCode).toBe(200);
    expect(put.json().surauInfo.logo).toEqual({ asset: id, bg: 'remove' });
    const logo = await app.inject({ method: 'GET', url: '/surau-logo', remoteAddress: '10.168.1.80' });
    expect(logo.statusCode).toBe(200);
    expect(logo.headers['content-type']).toBe('image/png');
    const img = decodeImage(logo.rawPayload);
    expect(px(img, 0, 0)[3]).toBe(0);
    const bundle = (await app.inject({ method: 'GET', url: '/api/kiosk/bundle' })).json();
    expect(bundle.logo).toMatch(/^\/surau-logo\?v=[0-9a-f]{16}$/);
    // the bundle's own settings show the derived id (a plain string) for the kiosk
    expect(bundle.settings.surauInfo.logo).toMatch(ID);
    expect(bundle.settings.surauInfo.logo).not.toBe(id);
    // a second save with the same params does not change the logo URL
    await app.inject({ method: 'PUT', url: '/api/settings/surauInfo', headers: admin.headers, payload: { logo: { asset: id, bg: 'remove' } } });
    const again = (await app.inject({ method: 'GET', url: '/api/kiosk/bundle' })).json();
    expect(again.logo).toBe(bundle.logo);
    // setting the logo again replaces the object (no key from the old one lingers)
    const replaced = await app.inject({ method: 'PUT', url: '/api/settings/surauInfo', headers: admin.headers, payload: { logo: { asset: id, bg: 'card' } } });
    expect(replaced.json().surauInfo.logo).toEqual({ asset: id, bg: 'card' });
  });

  it('showName is a setting, true by default, and is in the public info', async () => {
    const { app, admin } = await boot();
    expect(getSettings(app.surau.db).surauInfo.showName).toBe(true);
    const off = await app.inject({ method: 'PUT', url: '/api/settings/surauInfo', headers: admin.headers, payload: { showName: false } });
    expect(off.statusCode).toBe(200);
    const info = (await app.inject({ method: 'GET', url: '/api/surau/info' })).json();
    expect(info.showName).toBe(false);
  });
});

describe('resolveImageId remembers a failing source', () => {
  it('decodes a failing source once across repeated reads', () => {
    const d = tmp();
    const db = track(openDb(join(d, 'x.db')));
    // Stored as a PNG, then damaged on disk so the decoder refuses it.
    const id = asset(db, d, solid(16, 16, [10, 10, 10, 255]));
    writeFileSync(getAssetPath(db, d, id)!.path, Buffer.from('not really a png at all'));
    const ref = { asset: id, bg: 'remove' as const };
    expect(resolveImageId(db, d, 'logo', ref)).toBe(id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM asset_derivative_failures').get()!.n).toBe(1);
    // Make the stored file decodable: only a repeated decode attempt could now succeed.
    writeFileSync(getAssetPath(db, d, id)!.path, MAXCOM);
    expect(resolveImageId(db, d, 'logo', ref)).toBe(id);
    expect(resolveImageId(db, d, 'logo', ref)).toBe(id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM asset_derivatives').get()!.n).toBe(0);
    // Changed params are a new key and are tried again.
    expect(resolveImageId(db, d, 'logo', { asset: id, bg: 'card' })).not.toBe(id);
  });

  it('does not remember a missing source (it may still arrive)', () => {
    const d = tmp();
    const db = track(openDb(join(d, 'x.db')));
    const missing = 'e'.repeat(64);
    expect(resolveImageId(db, d, 'logo', { asset: missing, bg: 'remove' })).toBe(missing);
    expect(db.prepare('SELECT COUNT(*) AS n FROM asset_derivative_failures').get()!.n).toBe(0);
  });
});

describe('first-boot logo.png gets an initial adjustment', () => {
  it('trim + the detected white background become the stored ImageRef', () => {
    const d = tmp();
    writeFileSync(join(d, 'surau.ini'), 'name = Surau Maxcom\n');
    writeFileSync(join(d, 'logo.png'), MAXCOM);
    const db = track(openDb(join(d, 'x.db')));
    const warns: string[] = [];
    applySurauIni(db, d, { info: () => undefined, warn: (m) => warns.push(m) });
    expect(warns).toEqual([]);
    const logo = getSettings(db).surauInfo.logo;
    expect(typeof logo).toBe('object');
    const ref = logo as { asset: string; crop?: { x: number; y: number; w: number; h: number }; bg?: string };
    expect(ref.asset).toMatch(ID);
    expect(ref.bg).toBe('remove');
    expect(ref.crop).toBeDefined();
    expect(ref.crop!.w).toBeLessThan(1);
    expect(ref.crop!.x).toBeGreaterThan(0);
  });

  it('a logo with nothing to trim or remove stays a plain asset id', () => {
    const d = tmp();
    writeFileSync(join(d, 'surau.ini'), 'name = Surau Merah\n');
    writeFileSync(join(d, 'logo.png'), solid(32, 32, [200, 30, 30, 255]));
    const db = track(openDb(join(d, 'x.db')));
    applySurauIni(db, d, { info: () => undefined, warn: () => undefined });
    expect(getSettings(db).surauInfo.logo).toMatch(ID);
  });
});
