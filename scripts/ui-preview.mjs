// Visual self-check for the kiosk screens. Starts the Vite dev server for
// apps/kiosk-display, seeds the offline bundle cache (the box server is not
// needed: every /api call is blocked so the page takes the cache path), and
// screenshots each phase into ui-preview/.
//
//   node scripts/ui-preview.mjs            all shots
//   node scripts/ui-preview.mjs normal     only shots whose name contains "normal"

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const appDir = resolve(repo, 'apps/kiosk-display');
const outDir = resolve(repo, 'ui-preview');
const PORT = 5179;

// Node 24 strips types, so the core package can be imported straight from source.
const core = await import(pathToFileURL(resolve(repo, 'packages/core/src/index.ts')).href);
const days = core.parseJakimCsv(readFileSync(resolve(repo, 'packages/core/test/fixtures/SGR01-2026.csv'), 'utf8'));

const filter = process.argv[2] ?? '';

// Content layer (Plan 2): sample content seeded into the `surau.content` cache (same format loadContent
// writes); its images are the abstract placeholders in ui-preview/fixtures, served at /assets/<sha256>
// like real box assets. Shots without `content` keep the Plan 1 no-content state.
const fixturesDir = resolve(outDir, 'fixtures');
const { IMAGES, makeContent } = await import(pathToFileURL(resolve(fixturesDir, 'content.mjs')).href);
/** @type {Map<string, { body: Buffer; contentType: string }>} sha256 -> file */
const assets = new Map();
/** @type {Record<string, string>} logical name -> sha256 */
const assetIds = {};
for (const [key, file] of Object.entries(IMAGES)) {
  const body = readFileSync(resolve(fixturesDir, file));
  const id = createHash('sha256').update(body).digest('hex');
  assets.set(id, { body, contentType: file.endsWith('.svg') ? 'image/svg+xml' : 'image/png' });
  assetIds[key] = id;
}

/**
 * @typedef {{ card?: boolean; ticker?: boolean; zikir?: boolean; pair?: boolean; badge?: boolean }} Expect  what must (true) or must not (false) be on screen
 * @typedef {'ok'|'error'} PairMode  'ok' = the box hands out a code and keeps answering pending; 'error' = pair calls fail
 * @type {{ name: string; now: string; w?: number; h?: number; settings?: Record<string, unknown>; content?: 'default'|'long'|'batal'|'islamic'|'islamic-long'|'islamic-range'; card?: string; expectContent?: boolean; expect?: Expect; reducedMotion?: boolean; noCache?: boolean; unauthorised?: boolean; pair?: PairMode }[]}
 */
const SHOTS = [
  { name: '01-normal-1920', now: '2026-11-03T15:52:00+08:00' },
  { name: '02-normal-1366', now: '2026-11-03T15:52:00+08:00', w: 1366, h: 768 },
  { name: '03-azan-1612', now: '2026-11-03T16:12:00+08:00' },
  { name: '04-masuk-162010', now: '2026-11-03T16:20:10+08:00' },
  { name: '05-iqamah-1625', now: '2026-11-03T16:25:00+08:00' },
  { name: '06-iqamah-end-162945', now: '2026-11-03T16:29:45+08:00' },
  { name: '07-solat-1635', now: '2026-11-03T16:35:00+08:00' },
  { name: '08-syuruk-0652', now: '2026-11-03T06:52:00+08:00' },
  { name: '09-khutbah-1106-1305', now: '2026-11-06T13:05:00+08:00' },
  { name: '10-nodata-2027', now: '2027-01-01T09:00:00+08:00' },
  { name: '11-normal-en', now: '2026-11-03T15:52:00+08:00', settings: { language: { lang: 'en' } } },
  // Night background (day rotation lands on default-2) and the Isyak -> tomorrow Imsak path.
  { name: '12-normal-night-2130', now: '2026-11-04T21:30:00+08:00' },
  { name: '13-isyraq-0712', now: '2026-11-04T07:12:00+08:00' },
  { name: '14-tarawih-2050', now: '2026-11-04T20:50:00+08:00', settings: { tarawih: { hijriMonth: 5 } } },
  { name: '15-normal-24h-seconds', now: '2026-11-03T15:52:07+08:00', settings: { prayerBar: { timeFormat: '24h' }, clock: { showSeconds: true } } },
  // Narrow panel: the widest bar pill ("Iqamah hh:mm:ss") must still fit one cell.
  { name: '16-iqamah-1366', now: '2026-11-03T16:25:00+08:00', w: 1366, h: 768 },
  // Content cards (Plan 2 Task 9): `?card=` forces the feature; expectContent checks the card is on screen.
  { name: '17-content-kuliah-1920', now: '2026-11-03T15:52:00+08:00', content: 'default', card: 'kuliahCard', expectContent: true },
  { name: '18-content-pengumuman', now: '2026-11-03T15:52:00+08:00', content: 'default', card: 'pengumuman', expectContent: true },
  { name: '19-content-poster', now: '2026-11-03T15:52:00+08:00', content: 'default', card: 'posters', expectContent: true },
  { name: '20-content-programkhas', now: '2026-11-03T15:52:00+08:00', content: 'default', card: 'programKhas', expectContent: true },
  { name: '21-content-takwim', now: '2026-11-03T15:52:00+08:00', content: 'default', card: 'takwim', expectContent: true },
  // Stress: long names, topics and bodies must clamp inside the glass.
  { name: '22-content-kuliah-long', now: '2026-11-03T15:52:00+08:00', content: 'long', card: 'kuliahCard', expectContent: true },
  { name: '23-content-pengumuman-long', now: '2026-11-03T15:52:00+08:00', content: 'long', card: 'pengumuman', expectContent: true },
  { name: '24-content-kuliah-batal', now: '2026-11-03T15:52:00+08:00', content: 'batal', card: 'kuliahCard', expectContent: true },
  { name: '25-content-kuliah-1366', now: '2026-11-03T15:52:00+08:00', w: 1366, h: 768, content: 'default', card: 'kuliahCard', expectContent: true },
  { name: '26-content-kuliah-square-night', now: '2026-11-04T21:30:00+08:00', content: 'default', card: 'kuliahCard', expectContent: true, settings: { penceramahPhoto: { shape: 'square' } } },
  { name: '27-content-programkhas-long', now: '2026-11-03T15:52:00+08:00', content: 'long', card: 'programKhas', expectContent: true },
  { name: '28-content-takwim-long-1366', now: '2026-11-03T15:52:00+08:00', w: 1366, h: 768, content: 'long', card: 'takwim', expectContent: true },
  // Prayer layer wins: content seeded and forced, yet nothing from it may show during iqamah.
  { name: '29-content-iqamah-1625', now: '2026-11-03T16:25:00+08:00', content: 'default', card: 'kuliahCard', expectContent: false },
  // Plan 2 Task 10: hadis, world times, tugasan, ayat (QPC Hafs), ticker, zikir. The ticker is on in every
  // `islamic*` variant, so these shots also show the content region lifted above the strip.
  { name: '30-t10-hadis', now: '2026-11-03T15:52:00+08:00', content: 'islamic', card: 'hadis', expect: { card: true, ticker: true } },
  { name: '31-t10-hadis-long-1366', now: '2026-11-03T15:52:00+08:00', w: 1366, h: 768, content: 'islamic-long', card: 'hadis', expect: { card: true, ticker: true } },
  { name: '30b-t10-hadis-hadeethenc', now: '2026-11-03T15:52:00+08:00', content: 'islamic-he', card: 'hadis', expect: { card: true, ticker: true } },
  { name: '31b-t10-hadis-hadeethenc-parts-1366', now: '2026-11-03T15:52:00+08:00', w: 1366, h: 768, content: 'islamic-he-long', card: 'hadis', expect: { card: true, ticker: true } },
  { name: '32-t10-worldtimes-4', now: '2026-11-03T15:52:00+08:00', content: 'islamic', card: 'worldTimes', expect: { card: true } },
  { name: '33-t10-worldtimes-6-night', now: '2026-11-04T21:30:00+08:00', content: 'islamic-long', card: 'worldTimes', expect: { card: true } },
  { name: '34-t10-tugasan', now: '2026-11-03T15:52:00+08:00', content: 'islamic', card: 'tugasan', expect: { card: true } },
  { name: '35-t10-tugasan-3days-1366', now: '2026-11-03T15:52:00+08:00', w: 1366, h: 768, content: 'islamic-long', card: 'tugasan', expect: { card: true } },
  { name: '36-t10-ayat-short', now: '2026-11-03T15:52:00+08:00', content: 'islamic', card: 'ayatCard', expect: { card: true } },
  { name: '37-t10-ayat-short-size-l-no-tr', now: '2026-11-03T15:52:00+08:00', content: 'islamic', card: 'ayatCard', expect: { card: true }, settings: { ayatCard: { textSize: 'l', showTranslation: false } } },
  // Ayat al-Kursi pages: 20 s / 2 pages = 10 s each, counted from the live slot start when the rotation is on
  // the ayat card (145 s cycle: the ayat slot runs 125-145 s). 15:51:50 is 57110 s = slot start -> Arabic page;
  // 15:52:10 is outside the slot, so the KL clock drives it: 57130 / 10 odd -> translation page.
  { name: '38-t10-ayat-kursi-arabic', now: '2026-11-03T15:51:50+08:00', content: 'islamic-long', card: 'ayatCard', expect: { card: true } },
  { name: '39-t10-ayat-kursi-terjemahan', now: '2026-11-03T15:52:10+08:00', content: 'islamic-long', card: 'ayatCard', expect: { card: true } },
  { name: '40-t10-ayat-range-1366', now: '2026-11-03T15:52:00+08:00', w: 1366, h: 768, content: 'islamic-range', card: 'ayatCard', expect: { card: true } },
  { name: '41-t10-ticker-long', now: '2026-11-03T15:52:00+08:00', content: 'islamic-long', card: 'kuliahCard', expect: { card: true, ticker: true } },
  { name: '42-t10-ticker-reduced-motion', now: '2026-11-03T15:52:00+08:00', content: 'islamic-long', card: 'kuliahCard', expect: { card: true, ticker: true }, reducedMotion: true },
  // Zikir after Asar (solat ends 16:45, window 10 min): 16:50:00 -> first zikir; 16:45:20 -> second (long doa).
  { name: '43-t10-zikir-asar-1650', now: '2026-11-03T16:50:00+08:00', content: 'islamic', expect: { zikir: true, card: false, ticker: true } },
  { name: '44-t10-zikir-long-1366', now: '2026-11-03T16:45:20+08:00', w: 1366, h: 768, content: 'islamic', expect: { zikir: true, card: false } },
  // Prayer layer wins: Islamic content, ticker and zikir are all seeded, none may show during iqamah.
  { name: '45-t10-iqamah-1625', now: '2026-11-03T16:25:00+08:00', content: 'islamic-long', card: 'ayatCard', expect: { card: false, ticker: false, zikir: false } },
  // Plan 3 Task 6: pairing. `unauthorised` makes /api/kiosk/bundle answer 401; with `noCache` nothing is seeded, so
  // the full pairing screen shows; with the cache seeded the kiosk keeps running and only the corner badge appears.
  { name: '46-pair-1920', now: '2026-11-03T15:52:00+08:00', noCache: true, unauthorised: true, pair: 'ok', expect: { pair: true, badge: false } },
  { name: '47-pair-1366', now: '2026-11-04T21:30:00+08:00', w: 1366, h: 768, noCache: true, unauthorised: true, pair: 'ok', expect: { pair: true, badge: false } },
  { name: '48-pair-error', now: '2026-11-03T15:52:00+08:00', noCache: true, unauthorised: true, pair: 'error', expect: { pair: true, badge: false } },
  { name: '49-badge-normal', now: '2026-11-03T15:52:00+08:00', unauthorised: true, pair: 'ok', content: 'islamic', card: 'kuliahCard', expect: { badge: true, pair: false, card: true, ticker: true } },
  { name: '50-badge-iqamah-dim', now: '2026-11-03T16:25:00+08:00', unauthorised: true, pair: 'ok', expect: { badge: true, pair: false } },
  { name: '51-badge-solat-hidden', now: '2026-11-03T16:35:00+08:00', unauthorised: true, pair: 'ok', expect: { badge: false, pair: false } },
];

/** Pairing replies for the preview: a fixed code that stays pending, 9 min 41 s from the page load. */
const PAIR_CODE = '482913';

mkdirSync(outDir, { recursive: true });

const server = await createServer({
  configFile: resolve(appDir, 'vite.config.ts'),
  root: appDir,
  logLevel: 'warn',
  server: { port: PORT, strictPort: true, host: '127.0.0.1' },
});
await server.listen();
const base = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch();
try {
  for (const shot of SHOTS) {
    if (filter && !shot.name.includes(filter)) continue;
    const settings = core.resolveSettings(shot.settings ?? {});
    const cache = {
      bundle: { version: 1, zone: 'SGR01', days, settings, serverTime: new Date().toISOString() },
      fetchedAt: Date.now(),
    };
    const ctx = await browser.newContext({
      viewport: { width: shot.w ?? 1920, height: shot.h ?? 1080 },
      deviceScaleFactor: 1,
      reducedMotion: shot.reducedMotion ? 'reduce' : 'no-preference',
    });
    const contentCache = shot.content
      ? JSON.stringify({ content: makeContent(assetIds, shot.content), fetchedAt: Date.now() })
      : null;
    await ctx.addInitScript(({ bundle, content }) => {
      if (bundle) localStorage.setItem('surau.bundle', bundle);
      else localStorage.removeItem('surau.bundle');
      if (content) localStorage.setItem('surau.content', content);
      else localStorage.removeItem('surau.content');
    }, { bundle: shot.noCache ? null : JSON.stringify(cache), content: contentCache });
    await ctx.route('**/api/**', (route) => route.abort());
    // Later routes win: the box refuses this display, and (pair 'ok') hands out a code that stays pending.
    if (shot.unauthorised) {
      await ctx.route('**/api/kiosk/bundle', (route) =>
        route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ errors: ['Sila buka kunci semula'] }) }));
    }
    if (shot.pair === 'ok') {
      await ctx.route('**/api/kiosk/pair/begin', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ code: PAIR_CODE, pollToken: 'preview', expiresAt: new Date(Date.now() + 581_000).toISOString() }),
        }));
      await ctx.route('**/api/kiosk/pair/poll', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'pending' }) }));
    }
    await ctx.route('**/assets/*', (route) => {
      const id = new URL(route.request().url()).pathname.split('/').pop() ?? '';
      const hit = assets.get(id);
      if (hit) return route.fulfill({ status: 200, contentType: hit.contentType, body: hit.body });
      return route.fulfill({ status: 404, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      // /api requests are aborted on purpose (offline path); anything else is a real error.
      if (m.type() === 'error' && !(m.location()?.url ?? '').includes('/api/')) errors.push(m.text());
    });
    const card = shot.card ? `&card=${encodeURIComponent(shot.card)}` : '';
    await page.goto(`${base}/?now=${encodeURIComponent(shot.now)}${card}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.stage[data-phase]');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => {
      const img = document.querySelector('.bg__img');
      return !img || img.classList.contains('is-ready');
    });
    /** @type {Expect} */
    const expect = { ...(shot.expectContent !== undefined ? { card: shot.expectContent } : {}), ...(shot.expect ?? {}) };
    if (expect.card) await page.waitForSelector('[data-layer="content"] [data-card]');
    if (expect.zikir) await page.waitForSelector('[data-layer="zikir"]');
    if (expect.ticker) await page.waitForSelector('[data-layer="ticker"]');
    if (expect.pair) await page.waitForSelector(shot.pair === 'error' ? '.screen--pair[data-state="error"]' : '.screen--pair [data-code]');
    if (expect.badge) await page.waitForSelector('[data-testid="pair-badge"]');
    if (expect.card || expect.zikir) await page.waitForFunction(() => [...document.images].every((i) => i.complete));
    await page.waitForTimeout(1200); // fade-in and image transition
    const file = resolve(outDir, `${shot.name}.png`);
    await page.screenshot({ path: file });
    const phase = await page.getAttribute('.stage', 'data-phase');
    let contentNote = '';
    if (Object.keys(expect).length > 0) {
      const seen = await page.evaluate(() => ({
        card: document.querySelector('[data-layer="content"] [data-card]')?.getAttribute('data-card') ?? null,
        ticker: document.querySelector('[data-layer="ticker"]')?.getAttribute('data-motion') ?? null,
        zikir: document.querySelector('[data-layer="zikir"]')?.getAttribute('data-item') ?? null,
        qpc: document.fonts.check('2rem "QPC Hafs"'),
        pair: document.querySelector('.screen--pair')?.getAttribute('data-state') ?? null,
        badge: document.querySelector('[data-testid="pair-badge"]')?.getAttribute('data-dim') ?? null,
      }));
      const failed = Object.entries(expect).filter(([k, want]) => want !== (seen[k] !== null)).map(([k]) => k);
      contentNote = `  card=${seen.card ?? 'none'} ticker=${seen.ticker ?? 'none'} zikir=${seen.zikir ?? 'none'} qpc=${seen.qpc}`
        + (seen.pair !== null || seen.badge !== null ? ` pair=${seen.pair ?? 'none'} badge=${seen.badge === null ? 'none' : seen.badge === 'true' ? 'dim' : 'on'}` : '')
        + (failed.length ? `  CONTENT CHECK FAILED (${failed.join(', ')})` : '');
      if (failed.length) process.exitCode = 1;
    }
    console.log(`${shot.name}.png  phase=${phase}${contentNote}${errors.length ? `  ERRORS: ${errors.join(' | ')}` : ''}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.close();
}
