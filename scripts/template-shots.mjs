// Screenshots of every kiosk presentation template (kioskTemplate.templateId) at 1920x1080 with realistic BM
// content, from the Vite dev server and the seeded offline cache (same method as ui-preview.mjs; no box needed).
//
//   node scripts/template-shots.mjs <outDir> [template,template...] [state,state...] [settings.json]
//
// The optional JSON file is an object of settings features merged over the ones the script builds (one level deep);
// a string "@asset:<key>" inside it becomes the id of that fixture picture (IMAGES in ui-preview/fixtures/content.mjs).
//
// States: normal (kuliah card, ticker, source footer), iqamah (countdown), emergency (calculated-times band),
// solat (the dimmed calm screen), poster (full-height poster screen), poster-light (pale poster), poster-wide (16:9 picture, 1600x900), poster-xwide (3:1 banner), and the same three with -nostretch (Regangkan off), azan, masuk-waktu, jumaat, tiada-data, hadis, ayat,
// cloud-online, cloud-offline (the cloud icon), pengumuman, pengumuman-pic, pengumuman-pic-tall, pengumuman-pic-missing, takwim, tabung, tabung-1, tabung-3, tabung-6, tabung-15,
// tabung-15-summary, tabung-hot, tabung-over, tabung-noqr, tabung-manual, tabung-featured, tabung-40-summary1..3, tabung-month-neg, program, logo, logo-poster, logo-iqamah, arab-ayat, arab-hadis, arab-zikir, live, live-nologo (the live screen's waiting panel
// through the preview mechanism). Files: <outDir>/<template>-<state>.png.
// Env SHOT_SIZE=<w>x<h>@<dsf> (default 1920x1080@1). Reduced motion is emulated so two runs are pixel-equal, and every
// state declares the data-phase it expects (the run fails when the stage differs).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const appDir = resolve(repo, 'apps/kiosk-display');
const SIZE = /^(\d+)x(\d+)@(\d+(?:\.\d+)?)$/.exec(process.env.SHOT_SIZE ?? '1920x1080@1');
if (!SIZE) throw new Error(`SHOT_SIZE must look like 1920x1080@1, got ${process.env.SHOT_SIZE}`);
const viewport = { width: Number(SIZE[1]), height: Number(SIZE[2]) };
const deviceScaleFactor = Number(SIZE[3]);
const outDir = resolve(process.argv[2] ?? resolve(repo, 'ui-preview/templates'));
const ALL_TEMPLATES = ['default', 'colourful', 'creative', 'oldschool', 'minimal', 'arabic'];
const templates = process.argv[3] ? process.argv[3].split(',') : ALL_TEMPLATES;
// SHOT_PORT moves the script's own dev server off 5181 (two runs side by side); SHOT_VITE_CACHE gives it its own
// optimiser cache, so it never rewrites the cache a dev server of the operator is using from the same checkout.
const PORT = Number(process.env.SHOT_PORT ?? 5181);

const core = await import(pathToFileURL(resolve(repo, 'packages/core/src/index.ts')).href);
const baseDays = core.parseJakimCsv(readFileSync(resolve(repo, 'packages/core/test/fixtures/SGR01-2026.csv'), 'utf8'));
const fixturesDir = resolve(repo, 'ui-preview/fixtures');
const { IMAGES, makeContent } = await import(pathToFileURL(resolve(fixturesDir, 'content.mjs')).href);
const logoBody = readFileSync(resolve(fixturesDir, IMAGES.logo));
const assets = new Map();
const assetIds = {};
for (const [key, file] of Object.entries(IMAGES)) {
  const body = readFileSync(resolve(fixturesDir, file));
  const id = createHash('sha256').update(body).digest('hex');
  assets.set(id, { body, contentType: file.endsWith('.svg') ? 'image/svg+xml' : 'image/png' });
  assetIds[key] = id;
}

const DAY = '2026-11-03';
/** The day's rows with the box's source line; `emergency` makes today a calculated day with the band. */
function daysFor(emergency) {
  return baseDays.map((d) => {
    if (emergency && d.date === DAY) {
      return { ...d, source: 'calc', emergency: true, corrected: [], footerMs: 'Kiraan JAKIM 18/18, Shah Alam', footerEn: 'JAKIM 18/18 calculation, Shah Alam' };
    }
    return { ...d, source: 'official', emergency: false, corrected: [], footerMs: 'Sumber: JAKIM e-Solat SGR01', footerEn: 'Source: JAKIM e-Solat SGR01' };
  });
}

/** `HH:MM` plus whole minutes/seconds on a fixture row, as an ISO instant (never typed by hand). */
function at(date, hhmm, addSeconds = 0) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 3600 + m * 60 + addSeconds;
  const p = (n) => String(n).padStart(2, '0');
  return `${date}T${p(Math.floor(total / 3600))}:${p(Math.floor((total % 3600) / 60))}:${p(total % 60)}+08:00`;
}
const rowOf = (date) => baseDays.find((d) => d.date === date);
const row = rowOf(DAY).times;
const friday = '2026-11-06';
const LOGO = '/surau-logo?v=abc123';
const card = (name, wait) => ({ now: `${DAY}T15:52:00+08:00`, content: 'islamic', card: name, wait: wait ?? '[data-layer="content"] [data-card]', expectPhase: 'normal' });

const STATES = {
  biasa: { now: `${DAY}T15:52:00+08:00`, expectPhase: 'normal' },
  normal: { now: `${DAY}T15:52:00+08:00`, content: 'islamic', card: 'kuliahCard', wait: '[data-layer="content"] [data-card]', expectPhase: 'normal' },
  iqamah: { now: `${DAY}T16:25:00+08:00`, expectPhase: 'iqamah' },
  emergency: { now: `${DAY}T15:52:00+08:00`, content: 'islamic', card: 'pengumuman', emergency: true, wait: '[data-testid="emergency-band"]', expectPhase: 'normal' },
  solat: { now: `${DAY}T16:35:00+08:00`, expectPhase: 'solat' },
  poster: { now: `${DAY}T15:52:00+08:00`, content: 'default', card: 'posters', wait: '[data-layer="content"] [data-card="posters"]', expectPhase: 'normal' },
  'poster-light': { now: `${DAY}T15:52:00+08:00`, content: 'poster-light', card: 'posters', wait: '[data-layer="content"] [data-card="posters"]', expectPhase: 'normal' },
  'poster-wide': { now: `${DAY}T15:52:00+08:00`, content: 'poster-wide', card: 'posters', wait: '[data-layer="content"] [data-card="posters"]', expectPhase: 'normal' },
  'poster-xwide': { now: `${DAY}T15:52:00+08:00`, content: 'poster-xwide', card: 'posters', wait: '[data-layer="content"] [data-card="posters"]', expectPhase: 'normal' },
  'poster-nostretch': { now: `${DAY}T15:52:00+08:00`, content: 'poster-nostretch', card: 'posters', wait: '[data-layer="content"] [data-card="posters"]', expectPhase: 'normal' },
  'poster-wide-nostretch': { now: `${DAY}T15:52:00+08:00`, content: 'poster-wide-nostretch', card: 'posters', wait: '[data-layer="content"] [data-card="posters"]', expectPhase: 'normal' },
  'poster-xwide-nostretch': { now: `${DAY}T15:52:00+08:00`, content: 'poster-xwide-nostretch', card: 'posters', wait: '[data-layer="content"] [data-card="posters"]', expectPhase: 'normal' },
  azan: { now: at(DAY, row.asar, -60), expectPhase: 'azanCountdown' },
  'masuk-waktu': { now: at(DAY, row.asar, 5), expectPhase: 'masukWaktu' },
  jumaat: { now: at(friday, rowOf(friday).times.zohor, 120), expectPhase: 'khutbah' },
  'tiada-data': { now: `${DAY}T15:52:00+08:00`, noDays: true, expectPhase: 'noData' },
  // The cloud icon beside the bottom-right logo (a linked box, cloudSync on): the box answers /api/kiosk/cloud fresh or stale.
  'cloud-online': { ...card('kuliahCard'), cloud: 'online' },
  'cloud-offline': { ...card('kuliahCard'), cloud: 'offline' },
  hadis: card('hadis'),
  // 06:30, between Syuruk and Zohor's day half: with Syuruk hidden the bar, the headline and the chip name Zohor.
  standin: { now: `${DAY}T06:30:00+08:00`, expectPhase: 'normal' },
  'standin-kuliah': { now: `${DAY}T06:30:00+08:00`, content: 'islamic', card: 'kuliahCard', wait: '[data-layer="content"] [data-card]', expectPhase: 'normal' },
  ayat: card('ayatCard'),
  pengumuman: card('pengumuman'),
  // A notice with its picture (landscape, portrait): the picture whole beside the text, no ticker (rule 13).
  'pengumuman-pic': { ...card('pengumuman'), content: 'islamic-pic' },
  'pengumuman-pic-tall': { ...card('pengumuman'), content: 'islamic-pic-tall' },
  // The picture is missing on the box (404): the text-only notice and its ticker.
  'pengumuman-pic-missing': { ...card('pengumuman'), content: 'islamic-pic-missing' },
  takwim: card('takwim'),
  // The duty roster and the world clocks on the content shell (operator 2026-11-17); -long: 3 duty days, a long name, 6 cities.
  tugasan: card('tugasan'),
  'waktu-dunia': card('worldTimes'),
  'tugasan-long': { ...card('tugasan'), content: 'islamic-long' },
  'waktu-dunia-long': { ...card('worldTimes'), content: 'islamic-long' },
  tabung: { ...card('tabungCard'), needs: 'tabung' },
  // The tabung screen (mockup tabung-r1). `?card=` with no slot start pages by the KL clock (15 s a page): 15:52:30 is
  // page 1 of a 3- or 5-page screen, 15:53:30 the 5th (the summary of 15 funds). `settings` merge over the stored ones.
  'tabung-1': { ...card('tabungCard'), content: 'tabung-1' },
  'tabung-3': { ...card('tabungCard'), content: 'tabung-3' },
  'tabung-6': { ...card('tabungCard'), now: `${DAY}T15:52:30+08:00`, content: 'tabung-6' },
  'tabung-15': { ...card('tabungCard'), now: `${DAY}T15:52:30+08:00`, content: 'tabung-15' },
  'tabung-15-summary': { ...card('tabungCard'), now: `${DAY}T15:53:30+08:00`, content: 'tabung-15' },
  'tabung-hot': { ...card('tabungCard'), content: 'tabung-hot' },
  'tabung-over': { ...card('tabungCard'), content: 'tabung-over' },
  'tabung-noqr': { ...card('tabungCard'), content: 'tabung-noqr' },
  'tabung-manual': { ...card('tabungCard'), content: 'tabung-manual' },
  'tabung-featured': { ...card('tabungCard'), now: `${DAY}T15:52:30+08:00`, content: 'tabung-6', settings: { tabungCard: { featured: true } } },
  // 40 funds = 13 pages by the KL clock (15 s each): 15:54:45, 15:55:00 and 15:55:15 are the three summary pages.
  'tabung-40-summary1': { ...card('tabungCard'), now: `${DAY}T15:54:45+08:00`, content: 'tabung-40' },
  'tabung-40-summary2': { ...card('tabungCard'), now: `${DAY}T15:55:00+08:00`, content: 'tabung-40' },
  'tabung-40-summary3': { ...card('tabungCard'), now: `${DAY}T15:55:15+08:00`, content: 'tabung-40' },
  // 5 funds = 3 pages: 15:53:00 is the summary.
  'tabung-month-neg': { ...card('tabungCard'), now: `${DAY}T15:53:00+08:00`, content: 'tabung-month-neg' },
  program: card('programKhas'),
  logo: { now: `${DAY}T15:52:00+08:00`, content: 'islamic', card: 'kuliahCard', wait: '[data-layer="content"] [data-card]', logo: true, expectPhase: 'normal' },
  'logo-poster': { now: `${DAY}T15:52:00+08:00`, content: 'default', card: 'posters', wait: '[data-layer="content"] [data-card="posters"]', logo: true, expectPhase: 'normal' },
  'logo-iqamah': { now: `${DAY}T16:25:00+08:00`, logo: true, expectPhase: 'iqamah' },
  // The Arabic-led looks (Arabic Art turns them on; any other theme shows the normal ayat, hadis and zikir screens).
  'arab-ayat': card('ayatCard', '.arab-ayat, [data-layer="content"] [data-card]'),
  'arab-hadis': card('hadis', '.arab-hadis, [data-layer="content"] [data-card]'),
  'arab-zikir': { now: `${DAY}T16:50:00+08:00`, content: 'islamic', wait: '.arab-zikir, [data-layer="zikir"]', expectPhase: 'normal' },
  // Long content on the full-stage screens (review focus of plan D: shrink or page, never under the strip or the clock).
  // Use with a settings file that sets the text size to XL (themeStyle styles per theme, semua.scale 'XL').
  'kuliah-long': { now: `${DAY}T15:52:00+08:00`, content: 'long', card: 'kuliahCard', wait: '[data-layer="content"] [data-card]', expectPhase: 'normal' },
  'hadis-long': card('hadis'),
  'arab-ayat-range': { now: `${DAY}T15:52:00+08:00`, content: 'islamic-range', card: 'ayatCard', wait: '.arab-ayat, [data-layer="content"] [data-card]', expectPhase: 'normal' },
  'arab-hadis-long': { now: `${DAY}T15:52:00+08:00`, content: 'islamic-long', card: 'hadis', wait: '[data-layer="content"] [data-card]', expectPhase: 'normal' },
  // The live screen as the admin app's preview draws it (no player: the waiting panel in the frame). Preview mode: the
  // page is handed a token and a theme request by postMessage and reads the bundle and the live status from routes.
  live: { now: `${DAY}T15:52:00+08:00`, previewScreen: 'live', logo: true, wait: '.screen--live', expectPhase: 'normal' },
  'live-nologo': { now: `${DAY}T15:52:00+08:00`, previewScreen: 'live', wait: '.screen--live', expectPhase: 'normal' },
};
const states = process.argv[4] ? process.argv[4].split(',') : Object.keys(STATES);
const withAssetIds = (v) => {
  if (typeof v === 'string' && v.startsWith('@asset:')) {
    const id = assetIds[v.slice('@asset:'.length)];
    if (!id) throw new Error(`unknown fixture picture ${v}`);
    return id;
  }
  if (Array.isArray(v)) return v.map(withAssetIds);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withAssetIds(x)]));
  return v;
};
const extraSettings = process.argv[5] ? withAssetIds(JSON.parse(readFileSync(resolve(process.argv[5]), 'utf8'))) : {};

// Optional: MEASURE_MODULE names a module whose default export is called after each screenshot with { page, template,
// stateName } (scripts/measure-theme-sizes.mjs reads the protected elements' sizes this way). Unset, nothing changes.
const measureHook = process.env.MEASURE_MODULE ? (await import(pathToFileURL(resolve(process.env.MEASURE_MODULE)).href)).default : null;

// Env SHOT_REGIONS=1: the 'normal' state also writes <template>-normal-regions.png with every region-* element outlined and
// named (the theme author guide's marked-up picture).
const REGION_COLOURS = { 'region-main': '#ff3b30', 'region-prayers': '#007aff', 'region-clock': '#34c759', 'region-brand': '#ff9500', 'region-ticker': '#af52de', 'region-live-strip': '#00c7be', 'region-next': '#ff2d92' };
async function markRegions(page, file) {
  await page.evaluate((colours) => {
    const layer = document.createElement('div');
    layer.id = 'shot-regions';
    layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    for (const [cls, colour] of Object.entries(colours)) {
      for (const el of document.querySelectorAll('.' + cls)) {
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        const box = document.createElement('div');
        box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border:3px solid ${colour};box-sizing:border-box`;
        const tag = document.createElement('span');
        tag.textContent = '.' + cls;
        tag.style.cssText = `position:absolute;left:0;top:0;padding:1px 6px;font:700 16px/20px Consolas,monospace;color:#fff;background:${colour}`;
        box.appendChild(tag);
        layer.appendChild(box);
      }
    }
    document.body.appendChild(layer);
  }, REGION_COLOURS);
  await page.screenshot({ path: file });
  await page.evaluate(() => document.getElementById('shot-regions')?.remove());
}

mkdirSync(outDir, { recursive: true });
const server = await createServer({
  configFile: resolve(appDir, 'vite.config.ts'),
  root: appDir,
  logLevel: 'warn',
  ...(process.env.SHOT_VITE_CACHE ? { cacheDir: resolve(process.env.SHOT_VITE_CACHE) } : {}),
  server: { port: PORT, strictPort: true, host: '127.0.0.1' },
});
await server.listen();
const base = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch();
let failed = false;
try {
  for (const template of templates) {
    for (const stateName of states) {
      const st = STATES[stateName];
      const stored = {
        surauInfo: { name: 'Surau Al-Hidayah' },
        kioskTemplate: { templateId: template },
      };
      for (const [feature, value] of Object.entries({ ...extraSettings, ...(st.settings ?? {}) })) {
        stored[feature] = { ...(stored[feature] ?? {}), ...(value && typeof value === 'object' ? value : {}) };
      }
      const settings = core.resolveSettings(stored);
      const bundle = { version: 1, zone: 'SGR01', days: st.noDays ? [] : daysFor(st.emergency === true), settings, serverTime: new Date().toISOString() };
      if (st.logo) bundle.logo = LOGO;
      const made = st.content ? makeContent(assetIds, st.content) : null;
      if (st.needs && !(made && made[st.needs])) {
        console.log(`SKIP ${template}-${stateName}.png (no fixture content for ${st.needs})`);
        continue;
      }
      const ctx = await browser.newContext({ viewport, deviceScaleFactor, reducedMotion: 'reduce' });
      const content = made ? JSON.stringify({ content: made, fetchedAt: Date.now() }) : null;
      await ctx.addInitScript(({ b, c }) => {
        localStorage.setItem('surau.bundle', b);
        if (c) localStorage.setItem('surau.content', c);
        else localStorage.removeItem('surau.content');
      }, { b: JSON.stringify({ bundle, fetchedAt: Date.now() }), c: content });
      await ctx.route('**/api/**', (route) => route.abort());
      if (st.cloud) {
        // the page clock starts at 2026-01-01T00:00:01Z, so "fresh" and "stale" are measured from there
        const lastOkAt = st.cloud === 'online' ? '2026-01-01T00:00:00.000Z' : '2025-12-31T20:00:00.000Z';
        await ctx.route('**/api/kiosk/cloud', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ linked: true, lastOkAt, cloudSyncEnabled: true }) }));
      }
      await ctx.route('**/surau-logo*', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: logoBody }));
      await ctx.route('**/assets/*', (route) => {
        const id = new URL(route.request().url()).pathname.split('/').pop() ?? '';
        const hit = assets.get(id);
        return hit ? route.fulfill({ status: 200, contentType: hit.contentType, body: hit.body }) : route.fulfill({ status: 404, body: '' });
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      const card = st.card ? `&card=${st.card}` : '';
      if (st.previewScreen) {
        await ctx.route('**/api/kiosk/bundle', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(bundle) }));
        await ctx.route('**/api/kiosk/live', (route) => route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ live: true, since: '2026-11-03T07:40:00.000Z', kuliah: { label: 'Kuliah Maghrib', penceramah: 'Ustaz Abu Bakar Ahmad', topic: 'Tafsir Surah Al-Kahfi (siri 4)' }, audio: false, volume: 50 }),
        }));
      }
      // The page clock is frozen and only moves by the explicit steps below, so two runs are pixel-equal (the kiosk
      // clock and countdowns would otherwise tick with the real load time).
      await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
      await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
      await page.goto(`${base}/?now=${encodeURIComponent(st.now)}${card}${st.previewScreen ? '&preview=1' : ''}`, { waitUntil: 'networkidle' });
      if (st.previewScreen) {
        await page.evaluate(({ theme, screen }) => {
          window.postMessage({ type: 'surau-preview', token: 'shots' }, location.origin);
          window.postMessage({ type: 'surau-preview-theme', theme, screen, entry: { semua: {}, skrin: {} } }, location.origin);
        }, { theme: template, screen: st.previewScreen });
      }
      await page.clock.runFor(1000);
      await page.waitForSelector('.stage[data-phase]');
      await page.evaluate(() => document.fonts.ready);
      if (st.wait) {
        for (let i = 0; i < 40 && !(await page.$(st.wait)); i++) { await page.clock.runFor(250); await page.waitForTimeout(50); }
        await page.waitForSelector(st.wait);
      }
      await page.waitForFunction(() => [...document.images].every((i) => i.complete));
      await page.clock.runFor(1300);
      await page.waitForTimeout(100);
      const file = resolve(outDir, `${template}-${stateName}.png`);
      await page.screenshot({ path: file });
      if (measureHook) await measureHook({ page, template, stateName });
      if (process.env.SHOT_REGIONS === '1' && stateName === 'normal') await markRegions(page, resolve(outDir, `${template}-${stateName}-regions.png`));
      const seen = await page.evaluate(() => ({
        phase: document.querySelector('.stage')?.getAttribute('data-phase'),
        template: document.querySelector('.stage')?.getAttribute('data-template'),
      }));
      const ok = (seen.template ?? 'default') === template && seen.phase === st.expectPhase && errors.length === 0;
      if (!ok) failed = true;
      console.log(`${ok ? 'OK  ' : 'FAIL'} ${template}-${stateName}.png phase=${seen.phase} (want ${st.expectPhase}) template=${seen.template}${errors.length ? ` ERRORS ${errors.join(' | ')}` : ''}`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
if (failed) process.exit(1);
