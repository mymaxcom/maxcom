import { createHash } from 'node:crypto';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { putAsset } from '../src/assets/store.ts';
import { getSettings, putFeature } from '../src/settingsStore.ts';
import { PACK_MIME, ThemeError, readPack } from '../src/themes/packFormat.ts';
import { buildBundleCss, createThemeStore, hashOf, INSTALL_WINDOW_MS, MAX_INSTALLS_PER_HOUR, MAX_STAGED, STAGED_TTL_MS, ThemeStoreError } from '../src/themes/store.ts';
import { jpeg, manifestJson as json, png, zip } from './support/themePacks.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(): { app: FastifyInstance; db: ReturnType<typeof dbOf>; dir: string; clock: { t: number }; make: () => ReturnType<typeof createThemeStore> } {
  const dir = mkdtempSync(join(tmpdir(), 'surau-themes-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'));
  apps.push(app);
  const db = dbOf(app);
  const clock = { t: Date.parse('2026-11-15T10:00:00Z') };
  const make = (): ReturnType<typeof createThemeStore> => createThemeStore({ db, dataDir: dir, now: () => new Date(clock.t) });
  return { app, db, dir, clock, make };
}
const dbOf = (app: FastifyInstance) => app.surau.db;

const pack = (over: Record<string, unknown> = {}, extra: Record<string, string | Buffer> = {}): Buffer => zip({
  'theme.json': json(over),
  'theme.css': '.stage{--accent:#0a0} /* theme-marker */ .a{color:red}',
  'screens/poster.css': '.region-next{margin-top:1rem} /* screen-marker */',
  'arabic.css': '.arab{color:gold} /* arabic-marker */',
  'images/kuliah.jpg': jpeg(64, 36),
  ...extra,
});
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const rowOf = (db: ReturnType<typeof dbOf>, id: string): unknown => db.prepare('SELECT id FROM assets WHERE id = ?').get(id);
type Store = ReturnType<typeof createThemeStore>;
const installV = async (store: Store, version: number, over: Record<string, unknown> = {}): Promise<void> => {
  await store.install((await store.stage(pack({ version, ...over }))).stagedId!, 'u1');
};

describe('theme store', () => {
  it('stage then install: asset stored, folder extracted under its hash, record written', async () => {
    const { db, dir, make } = setup();
    const store = make();
    const z = pack();
    const s = await store.stage(z);
    expect(s.report.ok).toBe(true);
    expect(s.stagedId).toMatch(/^[0-9a-f]{32}$/);
    const p = await store.install(s.stagedId!, 'u1');
    expect(p.name).toBe('hijau-siti');
    expect(getSettings(db, LOCAL_SURAU_ID).themeStyle.packs['hijau-siti']).toMatchObject({ version: 3, base: 'creative', contract: 1, assetId: sha(z), fonts: [], screens: ['poster'], images: { kuliah: 'jpg' } });
    const folder = join(dir, 'themes', 'hijau-siti', hashOf(sha(z)));
    expect(existsSync(join(folder, 'bundle.css'))).toBe(true);
    expect(readdirSync(folder).sort()).toEqual(['bundle.css', 'images']);
    expect(readdirSync(join(folder, 'images'))).toEqual(['kuliah.jpg']);
    expect(existsSync(join(dir, 'assets', `${sha(z)}.maxtheme`))).toBe(true);
    // the raw files and theme.json are not extracted
    expect(readdirSync(folder).includes('theme.json')).toBe(false);
  });

  it('the picture the kiosk receives is the re-encoded one, not the uploaded bytes', async () => {
    const { dir, make } = setup();
    const store = make();
    const original = jpeg(64, 36, 7);
    const z = pack({}, { 'images/kuliah.jpg': original });
    await store.install((await store.stage(z)).stagedId!, 'u1');
    const served = readFileSync(join(dir, 'themes', 'hijau-siti', hashOf(sha(z)), 'images', 'kuliah.jpg'));
    expect(served.equals(original)).toBe(false);
    expect(served[0]).toBe(0xff);
    expect(served[1]).toBe(0xd8);
    // the staged preview copy is re-encoded too
    const staged = await store.stage(pack({ name: 'other-one' }, { 'images/kuliah.jpg': original }));
    expect(readFileSync(join(store.stagedDir(staged.stagedId!)!, 'images', 'kuliah.jpg')).equals(original)).toBe(false);
  });

  it('the bundle is ordered, scoped under the theme and absolute', async () => {
    const files = readPack(pack({}, { 'screens/kuliah.css': '.x{margin-top:1px}', 'theme.css': '.stage{background:url(images/kuliah.jpg)} /* theme-marker */' }));
    const css = buildBundleCss(files, '/themes/hijau-siti/0123456789abcdef/');
    expect(css).not.toContain('@font-face');
    expect(css).toContain(".stage[data-theme='hijau-siti'][data-screen='poster'] .region-next");
    expect(css).toContain(".stage[data-theme='hijau-siti']{background:url(\"/themes/hijau-siti/0123456789abcdef/images/kuliah.jpg\")}");
    expect(css).toContain(".stage[data-theme='hijau-siti'] .arab");
    expect(css.indexOf('theme-marker')).toBeLessThan(css.indexOf('screen-marker'));
    expect(css.indexOf('screen-marker')).toBeLessThan(css.indexOf('arabic-marker'));
    expect(css.indexOf("[data-screen='poster']")).toBeLessThan(css.indexOf("[data-screen='kuliah']"));
    expect(css).not.toMatch(/https?:|\/\//);
  });

  it('every rule of a bundle starts with the theme\'s own stage (nothing bare)', async () => {
    const files = readPack(zip({
      'theme.json': json(),
      'theme.css': ':root{--a:1} .a,.b{color:red} @media (min-width:1px){.c{color:red}} * {margin:0}',
      'arabic.css': '.arab{color:red}', 'screens/poster.css': '.p{color:red}',
    }));
    const css = buildBundleCss(files, '/themes/hijau-siti/0123456789abcdef/');
    const selectors = [...css.matchAll(/(?:^|[{}])\s*([^{}@]+)\{/gm)].flatMap((m) => m[1]!.split(','));
    expect(selectors.length).toBeGreaterThan(5);
    for (const sel of selectors) expect(sel.trim().startsWith(".stage[data-theme='hijau-siti']"), sel).toBe(true);
  });

  it('an invalid pack is not staged', async () => {
    const { dir, make } = setup();
    const store = make();
    const r = await store.stage(zip({ 'theme.json': json(), 'theme.css': '@import "x.css";' }));
    expect(r).toMatchObject({ stagedId: null, report: { ok: false } });
    expect(existsSync(join(dir, 'themes', '.staged')) ? readdirSync(join(dir, 'themes', '.staged')) : []).toEqual([]);
  });

  it('install after expiry or with an unknown id is "gone"; only 3 packs stay staged', async () => {
    const { dir, clock, make } = setup();
    const store = make();
    await expect(store.install('f'.repeat(32), 'u1')).rejects.toThrow(ThemeStoreError);
    await expect(store.install('../../x', 'u1')).rejects.toThrow(/expired/);
    const a = await store.stage(pack({ name: 'a-one' }));
    clock.t += STAGED_TTL_MS + 1;
    await expect(store.install(a.stagedId!, 'u1')).rejects.toThrow(expect.objectContaining({ code: 'gone' }));
    expect(store.stagedDir(a.stagedId!)).toBeNull();
    expect(existsSync(join(dir, 'themes', '.staged', a.stagedId!))).toBe(false);
    const ids: string[] = [];
    for (let i = 0; i < MAX_STAGED + 2; i++) { clock.t += 1000; ids.push((await store.stage(pack({ name: `p-${i}` }))).stagedId!); }
    expect(readdirSync(join(dir, 'themes', '.staged')).sort()).toEqual(ids.slice(-MAX_STAGED).sort());
    expect(store.stagedDir(ids[0]!)).toBeNull();
    expect(store.stagedDir(ids[ids.length - 1]!)).not.toBeNull();
    expect(store.stagedDir('not-an-id')).toBeNull();
  });

  it('an update keeps the surau styles and the old folder until the next start', async () => {
    const { db, dir, make } = setup();
    const store = make();
    const v3 = pack({ version: 3 });
    const v4 = pack({ version: 4 });
    await store.install((await store.stage(v3)).stagedId!, 'u1');
    putFeature(db, 'themeStyle', { styles: { 'hijau-siti': { semua: { shade: 40 }, skrin: { kuliah: { accent: '#112233' } } } } }, 'u1', undefined, LOCAL_SURAU_ID);
    const stylesBefore = getSettings(db, LOCAL_SURAU_ID).themeStyle.styles;
    await store.install((await store.stage(v4)).stagedId!, 'u1');
    expect(getSettings(db, LOCAL_SURAU_ID).themeStyle.styles).toEqual(stylesBefore);
    expect(getSettings(db, LOCAL_SURAU_ID).themeStyle.packs['hijau-siti']!.version).toBe(4);
    expect(existsSync(join(dir, 'themes', 'hijau-siti', hashOf(sha(v3))))).toBe(true);
    expect(existsSync(join(dir, 'themes', 'hijau-siti', hashOf(sha(v4))))).toBe(true);
    createThemeStore({ db, dataDir: dir, now: () => new Date() });
    expect(existsSync(join(dir, 'themes', 'hijau-siti', hashOf(sha(v3))))).toBe(false);
    expect(existsSync(join(dir, 'themes', 'hijau-siti', hashOf(sha(v4))))).toBe(true);
  });

  it('the next install of the same theme removes the folders older than the one it replaces', async () => {
    const { dir, make } = setup();
    const store = make();
    for (const v of [3, 4, 5]) await installV(store, v);
    expect(readdirSync(join(dir, 'themes', 'hijau-siti')).sort()).toEqual([hashOf(sha(pack({ version: 4 }))), hashOf(sha(pack({ version: 5 })))].sort());
  });

  it('a second install of the same staged id after the version was raised is refused as version_not_higher', async () => {
    const { make } = setup();
    const store = make();
    const a = await store.stage(pack({ version: 3 }));
    const b = await store.stage(pack({ version: 4 }));
    await store.install(b.stagedId!, 'u1');
    await expect(store.install(a.stagedId!, 'u1')).rejects.toSatisfy((e: unknown) => e instanceof ThemeError && e.issues[0]!.code === 'version_not_higher');
    await expect(store.install(b.stagedId!, 'u1')).rejects.toThrow(ThemeError);
  });

  it('remove: refused while in use, refused for a built-in, removes record and folder otherwise, keeps styles', async () => {
    const { db, dir, make } = setup();
    const store = make();
    await installV(store, 3);
    putFeature(db, 'themeStyle', { styles: { 'hijau-siti': { semua: { shade: 40 }, skrin: {} } } }, 'u1', undefined, LOCAL_SURAU_ID);
    putFeature(db, 'kioskTemplate', { templateId: 'hijau-siti' }, 'u1', undefined, LOCAL_SURAU_ID);
    expect(() => store.remove('hijau-siti', 'u1')).toThrow(expect.objectContaining({ code: 'in_use' }));
    expect(() => store.remove('creative', 'u1')).toThrow(expect.objectContaining({ code: 'built_in' }));
    expect(() => store.remove('arabic', 'u1')).toThrow(expect.objectContaining({ code: 'built_in' }));
    expect(() => store.remove('con', 'u1')).toThrow(expect.objectContaining({ code: 'built_in' }));
    expect(() => store.remove('tiada-tema', 'u1')).toThrow(expect.objectContaining({ code: 'not_found' }));
    putFeature(db, 'kioskTemplate', { templateId: 'creative' }, 'u1', undefined, LOCAL_SURAU_ID);
    store.remove('hijau-siti', 'u1');
    const s = getSettings(db, LOCAL_SURAU_ID).themeStyle;
    expect(s.packs['hijau-siti']).toBeUndefined();
    expect(s.styles['hijau-siti']).toMatchObject({ semua: { shade: 40 } });
    expect(existsSync(join(dir, 'themes', 'hijau-siti'))).toBe(false);
    expect(await store.ensureExtracted('hijau-siti')).toBeNull();
    // the same name can be uploaded again afterwards
    await installV(store, 1);
    expect(getSettings(db, LOCAL_SURAU_ID).themeStyle.packs['hijau-siti']!.version).toBe(1);
  });

  it('ensureExtracted rebuilds a missing folder from the asset', async () => {
    const { dir, make } = setup();
    const store = make();
    const z = pack();
    await store.install((await store.stage(z)).stagedId!, 'u1');
    rmSync(join(dir, 'themes', 'hijau-siti'), { recursive: true, force: true });
    const got = await store.ensureExtracted('hijau-siti');
    expect(got).toEqual({ dir: join(dir, 'themes', 'hijau-siti', hashOf(sha(z))), version: 3, hash: hashOf(sha(z)) });
    expect(readFileSync(join(got!.dir, 'bundle.css'), 'utf8')).toContain("[data-theme='hijau-siti']");
    expect(existsSync(join(got!.dir, 'images', 'kuliah.jpg'))).toBe(true);
    expect(await store.problemOf('hijau-siti')).toBeNull();
  });

  it('ensureExtracted refuses a pack this box finds invalid (as if synced from elsewhere)', async () => {
    const { db, dir, make } = setup();
    const store = make();
    const bad = zip({ 'theme.json': json(), 'theme.css': '@import "https://x.example/a.css";' });
    const meta = putAsset(db, dir, bad, PACK_MIME, 'sync');
    putFeature(db, 'themeStyle', { packs: { 'hijau-siti': { assetId: meta.id, version: 3, title: 'Hijau Siti', base: 'creative', contract: 1, bytes: bad.length, fonts: [], screens: [], images: {}, defaults: {} } } }, 'sync', undefined, LOCAL_SURAU_ID);
    expect(await store.ensureExtracted('hijau-siti')).toBeNull();
    expect((await store.problemOf('hijau-siti'))!.code).toBe('css_import');
    expect(existsSync(join(dir, 'themes', 'hijau-siti'))).toBe(false);
  });

  it('a synced pack that carries what v1 refuses (a font, an animation, a web picture) is not served', async () => {
    const { db, dir, make } = setup();
    const store = make();
    const cases: Array<[string, Record<string, string | Buffer>, string]> = [
      ['a font', { 'fonts/a.woff2': 'x' }, 'bad_font'],
      ['an animation', { 'theme.css': '.a{animation:x 1s}' }, 'css_property'],
      ['@font-face', { 'theme.css': '@font-face{font-family:x}' }, 'css_font'],
      ['a picture that is not one', { 'images/kuliah.jpg': Buffer.concat([jpeg(8, 8).subarray(0, 40), Buffer.alloc(30)]) }, 'bad_image'],
    ];
    for (const [i, [why, extra, code]] of cases.entries()) {
      const name = `sync-${i}`;
      const zz = pack({ name }, extra);
      const meta = putAsset(db, dir, zz, PACK_MIME, 'sync');
      putFeature(db, 'themeStyle', { packs: { [name]: { assetId: meta.id, version: 3, title: 'Hijau Siti', base: 'creative', contract: 1, bytes: zz.length, fonts: [], screens: [], images: {}, defaults: {} } } }, 'sync', undefined, LOCAL_SURAU_ID);
      expect(await store.ensureExtracted(name), why).toBeNull();
      expect((await store.problemOf(name))!.code, why).toBe(code);
      expect(existsSync(join(dir, 'themes', name)), why).toBe(false);
    }
  });

  it('a synced record that disagrees with its file (name or version) is not served', async () => {
    const { db, dir, make } = setup();
    const store = make();
    const z = pack({ version: 2 });
    const meta = putAsset(db, dir, z, PACK_MIME, 'sync');
    putFeature(db, 'themeStyle', { packs: { 'hijau-siti': { assetId: meta.id, version: 9, title: 'Hijau Siti', base: 'creative', contract: 1, bytes: z.length, fonts: [], screens: [], images: {}, defaults: {} } } }, 'sync', undefined, LOCAL_SURAU_ID);
    expect(await store.ensureExtracted('hijau-siti')).toBeNull();
    expect((await store.problemOf('hijau-siti'))!.code).toBe('bad_theme_json');
    putFeature(db, 'themeStyle', { packs: { 'other-name': { assetId: meta.id, version: 2, title: 'Hijau Siti', base: 'creative', contract: 1, bytes: z.length, fonts: [], screens: [], images: {}, defaults: {} } } }, 'sync', undefined, LOCAL_SURAU_ID);
    expect(await store.ensureExtracted('other-name')).toBeNull();
    expect(existsSync(join(dir, 'themes', 'other-name'))).toBe(false);
  });

  it('ensureExtracted is null when the asset has not arrived, and works once it has', async () => {
    const { db, dir, make } = setup();
    const store = make();
    const z = pack();
    putFeature(db, 'themeStyle', { packs: { 'hijau-siti': { assetId: sha(z), version: 3, title: 'Hijau Siti', base: 'creative', contract: 1, bytes: z.length, fonts: [], screens: ['poster'], images: { kuliah: 'jpg' }, defaults: {} } } }, 'sync', undefined, LOCAL_SURAU_ID);
    expect(await store.ensureExtracted('hijau-siti')).toBeNull();
    expect(await store.problemOf('hijau-siti')).toBeNull();
    putAsset(db, dir, z, PACK_MIME, 'sync');
    expect(await store.ensureExtracted('hijau-siti')).not.toBeNull();
  });

  it('a pack for a newer contract that arrived by sync is not served', async () => {
    const { db, dir, make } = setup();
    const store = make();
    const z = pack({ contract: 2 });
    const meta = putAsset(db, dir, z, PACK_MIME, 'sync');
    putFeature(db, 'themeStyle', { packs: { 'hijau-siti': { assetId: meta.id, version: 3, title: 'Hijau Siti', base: 'creative', contract: 2, bytes: z.length, fonts: [], screens: [], images: {}, defaults: {} } } }, 'sync', undefined, LOCAL_SURAU_ID);
    expect(await store.ensureExtracted('hijau-siti')).toBeNull();
    expect((await store.problemOf('hijau-siti'))!.code).toBe('needs_newer');
  });

  it('start-up removes staged leftovers, temporary folders and the folders of themes that are gone', async () => {
    const { dir, db, make } = setup();
    mkdirSync(join(dir, 'themes', '.staged', 'x'), { recursive: true });
    mkdirSync(join(dir, 'themes', '.tmp-abc'), { recursive: true });
    mkdirSync(join(dir, 'themes', 'old-theme', '1'), { recursive: true });
    writeFileSync(join(dir, 'themes', 'old-theme', '1', 'bundle.css'), 'x');
    mkdirSync(join(dir, 'themes', 'new-theme', '0123456789abcdef'), { recursive: true });
    writeFileSync(join(dir, 'themes', 'new-theme', '0123456789abcdef', 'bundle.css'), 'x');
    make();
    expect(readdirSync(join(dir, 'themes'))).toEqual([]);
    expect(db).toBeDefined();
  });

  it('never writes a file name that came from the zip', async () => {
    const { dir, make } = setup();
    const store = make();
    const z = pack();
    await store.install((await store.stage(z)).stagedId!, 'u1');
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)).map((n) => `${e.name}/${n}`) : [e.name]));
    expect(walk(join(dir, 'themes', 'hijau-siti', hashOf(sha(z)))).sort()).toEqual(['bundle.css', 'images/kuliah.jpg']);
  });
});

describe('item 4: storage', () => {
  it('replacing a pack deletes the old stored file (row and disk) and keeps the new one', async () => {
    const { db, dir, make } = setup();
    const store = make();
    const v3 = pack({ version: 3 });
    const v4 = pack({ version: 4 });
    await store.install((await store.stage(v3)).stagedId!, 'u1');
    expect(existsSync(join(dir, 'assets', `${sha(v3)}.maxtheme`))).toBe(true);
    await store.install((await store.stage(v4)).stagedId!, 'u1');
    expect(rowOf(db, sha(v3))).toBeUndefined();
    expect(existsSync(join(dir, 'assets', `${sha(v3)}.maxtheme`))).toBe(false);
    expect(rowOf(db, sha(v4))).toBeDefined();
    expect(existsSync(join(dir, 'assets', `${sha(v4)}.maxtheme`))).toBe(true);
  });

  it('removing a pack deletes its stored file', async () => {
    const { db, dir, make } = setup();
    const store = make();
    const v3 = pack({ version: 3 });
    await store.install((await store.stage(v3)).stagedId!, 'u1');
    store.remove('hijau-siti', 'u1');
    expect(rowOf(db, sha(v3))).toBeUndefined();
    expect(existsSync(join(dir, 'assets', `${sha(v3)}.maxtheme`))).toBe(false);
  });

  it('a stored file another theme still points at is kept', async () => {
    const { db, dir, make } = setup();
    const store = make();
    const v3 = pack({ version: 3 });
    await store.install((await store.stage(v3)).stagedId!, 'u1');
    putFeature(db, 'themeStyle', { packs: { 'twin-one': { ...getSettings(db, LOCAL_SURAU_ID).themeStyle.packs['hijau-siti']! } } }, 'u1', undefined, LOCAL_SURAU_ID);
    await installV(store, 4);
    expect(rowOf(db, sha(v3))).toBeDefined();
    expect(existsSync(join(dir, 'assets', `${sha(v3)}.maxtheme`))).toBe(true);
    store.remove('twin-one', 'u1');
    expect(rowOf(db, sha(v3))).toBeUndefined();
  });

  it('an install that fails after the file was stored removes the file again, and leaves no folder', async () => {
    const { db, dir, make } = setup();
    const store = make();
    const z = pack();
    const staged = await store.stage(z);
    // a plain file where the theme's folder must go: the extraction fails after putAsset
    mkdirSync(join(dir, 'themes'), { recursive: true });
    writeFileSync(join(dir, 'themes', 'hijau-siti'), 'in the way');
    await expect(store.install(staged.stagedId!, 'u1')).rejects.toThrow();
    expect(rowOf(db, sha(z))).toBeUndefined();
    expect(existsSync(join(dir, 'assets', `${sha(z)}.maxtheme`))).toBe(false);
    expect(getSettings(db, LOCAL_SURAU_ID).themeStyle.packs['hijau-siti']).toBeUndefined();
    expect(readdirSync(join(dir, 'themes')).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  it('an install that fails keeps a file that was already stored before it (the same bytes uploaded earlier)', async () => {
    const { db, dir, make } = setup();
    const store = make();
    const z = pack();
    const earlier = putAsset(db, dir, z, PACK_MIME, 'u0');
    expect(earlier.created).toBe(true);
    const staged = await store.stage(z);
    mkdirSync(join(dir, 'themes'), { recursive: true });
    writeFileSync(join(dir, 'themes', 'hijau-siti'), 'in the way');
    await expect(store.install(staged.stagedId!, 'u1')).rejects.toThrow();
    expect(rowOf(db, sha(z))).toBeDefined();
  });

  it(`at most ${MAX_INSTALLS_PER_HOUR} installs an hour per box`, async () => {
    const { clock, make } = setup();
    const store = make();
    for (let v = 1; v <= MAX_INSTALLS_PER_HOUR; v++) await installV(store, v);
    const next = await store.stage(pack({ version: MAX_INSTALLS_PER_HOUR + 1 }));
    await expect(store.install(next.stagedId!, 'u1')).rejects.toSatisfy((e: unknown) => e instanceof ThemeError && e.issues[0]!.code === 'too_many_installs');
    // a refused install changes nothing, and the hour passing lets the next one in
    clock.t += INSTALL_WINDOW_MS + 1;
    const again = await store.stage(pack({ version: MAX_INSTALLS_PER_HOUR + 1 }));
    await expect(store.install(again.stagedId!, 'u1')).resolves.toMatchObject({ version: MAX_INSTALLS_PER_HOUR + 1 });
  });

  it('a failed install does not use up the hourly allowance', async () => {
    const { make } = setup();
    const store = make();
    for (let i = 0; i < MAX_INSTALLS_PER_HOUR + 2; i++) {
      const bad = await store.stage(zip({ 'theme.json': json(), 'theme.css': '@import "x";' }));
      expect(bad.stagedId).toBeNull();
    }
    await installV(store, 1);
  });

  it('stage lets the event loop run while it checks a pack', async () => {
    const { make } = setup();
    const store = make();
    let turns = 0;
    let live = true;
    const spin = (): void => { turns++; if (live) setImmediate(spin); };
    setImmediate(spin);
    const r = await store.stage(pack({}, { 'images/semua.png': png(60, 40), 'screens/kuliah.css': '.x{margin-top:1px}' }));
    live = false;
    expect(r.report.ok).toBe(true);
    expect(turns).toBeGreaterThanOrEqual(4);
  });
});
