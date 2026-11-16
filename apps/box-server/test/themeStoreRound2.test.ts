import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { THEME_BUNDLE_FORMAT } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { putAsset } from '../src/assets/store.ts';
import { getSettings, putFeature } from '../src/settingsStore.ts';
import { PACK_MIME } from '../src/themes/packFormat.ts';
import { createThemeStore, hashOf, MAX_CHECKS_PER_HOUR } from '../src/themes/store.ts';
import { validatePack } from '../src/themes/validate.ts';
import { fakePng, jpeg, manifestJson as json, png, zip } from './support/themePacks.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

function setup(extra: Partial<Parameters<typeof createThemeStore>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'surau-themes2-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'));
  apps.push(app);
  const db = app.surau.db;
  const clock = { t: Date.parse('2026-11-15T10:00:00Z') };
  const make = (more: Partial<Parameters<typeof createThemeStore>[0]> = {}) => createThemeStore({ db, dataDir: dir, now: () => new Date(clock.t), ...extra, ...more });
  return { app, db, dir, clock, make };
}
const pack = (over: Record<string, unknown> = {}, files: Record<string, string | Buffer> = {}): Buffer => zip({
  'theme.json': json(over), 'theme.css': '.region-next{margin-top:1rem}', 'images/kuliah.jpg': jpeg(64, 36), ...files,
});
const record = (assetId: string, bytes: number) => ({ assetId, version: 3, title: 'Hijau Siti', base: 'creative', contract: 1, bytes, fonts: [], screens: [], images: { kuliah: 'jpg' }, defaults: {} });

describe('Q6/S11: the folder and the address carry the bundle format', () => {
  it('hashOf is the first 16 hex of the file plus the bundle format', () => {
    expect(hashOf('ab'.repeat(32))).toBe(`abababababababab-${THEME_BUNDLE_FORMAT}`);
  });

  it('a folder from an older bundle format is dropped at start and the pack is checked and extracted again under the new name', async () => {
    const { db, dir, make } = setup();
    const z = pack();
    const meta = putAsset(db, dir, z, PACK_MIME, 'sync');
    putFeature(db, 'themeStyle', { packs: { 'hijau-siti': record(meta.id, z.length) } }, 'sync');
    // what an older box left: <16 hex>/bundle.css with the output of the old scoper
    const legacy = join(dir, 'themes', 'hijau-siti', meta.id.slice(0, 16));
    mkdirSync(join(legacy, 'images'), { recursive: true });
    writeFileSync(join(legacy, 'bundle.css'), '/* old output */');
    const store = make();
    expect(existsSync(legacy)).toBe(false);
    const got = await store.ensureExtracted('hijau-siti');
    expect(got).not.toBeNull();
    expect(got!.hash).toBe(`${meta.id.slice(0, 16)}-${THEME_BUNDLE_FORMAT}`);
    expect(existsSync(join(got!.dir, 'bundle.css'))).toBe(true);
  });

  it('a pack that the validator of this box version refuses is reported, not served', async () => {
    const { db, dir, make } = setup();
    // allowed by the old validator: `top` is no longer an allowed property
    const z = zip({ 'theme.json': json(), 'theme.css': '.region-next{top:136px}' });
    const meta = putAsset(db, dir, z, PACK_MIME, 'sync');
    putFeature(db, 'themeStyle', { packs: { 'hijau-siti': record(meta.id, z.length) } }, 'sync');
    const store = make();
    expect(await store.ensureExtracted('hijau-siti')).toBeNull();
    expect((await store.problemOf('hijau-siti'))!.code).toBe('css_property');
  });
});

describe('S7: extraction is asynchronous, shared and remembered', () => {
  it('the event loop runs while a synced pack is checked, and two requests share one check', async () => {
    const { db, dir, make } = setup();
    const files: Record<string, Buffer> = {};
    for (let i = 0; i < 6; i++) files[`images/${['kuliah', 'poster', 'azan', 'iqamah', 'solat', 'semua'][i]}.png`] = png(300, 200, i);
    const z = zip({ 'theme.json': json(), 'theme.css': '.a{color:red}', ...files });
    const meta = putAsset(db, dir, z, PACK_MIME, 'sync');
    putFeature(db, 'themeStyle', { packs: { 'hijau-siti': { ...record(meta.id, z.length), images: { kuliah: 'png', poster: 'png', azan: 'png', iqamah: 'png', solat: 'png', semua: 'png' } } } }, 'sync');
    const store = make();
    const p1 = store.ensureExtracted('hijau-siti');
    const p2 = store.ensureExtracted('hijau-siti');
    expect(p1).toBe(p2);
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 0);
    const got = await p1;
    clearInterval(timer);
    expect(got).not.toBeNull();
    expect(ticks).toBeGreaterThan(0);
  });

  it('a failed pack is checked once, however often it is asked for', async () => {
    const { db, dir, make } = setup();
    const z = zip({ 'theme.json': json(), 'theme.css': '@import "https://x.example/a.css";' });
    const meta = putAsset(db, dir, z, PACK_MIME, 'sync');
    putFeature(db, 'themeStyle', { packs: { 'hijau-siti': record(meta.id, z.length) } }, 'sync');
    let runs = 0;
    const store = make({ onValidate: () => { runs++; } });
    for (let i = 0; i < 5; i++) expect(await store.ensureExtracted('hijau-siti')).toBeNull();
    expect(runs).toBe(1);
  });
});

describe('S7: limits on pictures and extracted bytes', () => {
  it('a pack whose pictures add up to more than 40 megapixels is refused before any decoding', () => {
    const files: Record<string, Buffer> = {};
    for (const key of ['kuliah', 'poster', 'azan', 'iqamah']) files[`images/${key}.png`] = fakePng(4000, 3000); // 12 MP each: 48 MP
    const { report } = validatePack(zip({ 'theme.json': json(), 'theme.css': '.a{color:red}', ...files }), { installed: {}, contract: 1, enforceVersion: false });
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.code === 'bad_image' && /megapiksel|megapixel/i.test(e.messageEn))).toBe(true);
  });

  it('a pack whose re-encoded pictures are larger than the allowance is refused', () => {
    const z = zip({ 'theme.json': json(), 'theme.css': '.a{color:red}', 'images/kuliah.png': png(120, 80), 'images/poster.png': png(120, 80, 1) });
    const small = validatePack(z, { installed: {}, contract: 1, enforceVersion: false, limits: { cleanBytes: 1000 } });
    expect(small.report.ok).toBe(false);
    expect(small.report.errors.some((e) => e.code === 'bad_image')).toBe(true);
    expect(validatePack(z, { installed: {}, contract: 1, enforceVersion: false }).report.ok).toBe(true);
  });

  it('all extracted packs together may not pass the allowance', async () => {
    const { make } = setup();
    const store = make({ extractedMaxBytes: 500 });
    const s = await store.stage(pack());
    await expect(store.install(s.stagedId!, 'u1')).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'storage_full' })] });
  });

  it('checks are limited per hour per box', async () => {
    const { make, clock } = setup();
    const store = make();
    const junk = Buffer.from('not a zip');
    for (let i = 0; i < MAX_CHECKS_PER_HOUR; i++) await store.stage(junk);
    await expect(store.stage(junk)).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'too_many_installs' })] });
    clock.t += 61 * 60_000;
    await expect(store.stage(junk)).resolves.toBeDefined();
  });
});

describe('S8 keeps its place: the installed theme file is unchanged', () => {
  it('stage and install still work with the new folder name', async () => {
    const { db, dir, make } = setup();
    const store = make();
    const z = pack();
    const s = await store.stage(z);
    await store.install(s.stagedId!, 'u1');
    expect(existsSync(join(dir, 'themes', 'hijau-siti', hashOf(sha(z)), 'bundle.css'))).toBe(true);
    expect(getSettings(db).themeStyle.packs['hijau-siti']!.assetId).toBe(sha(z));
  });
});
