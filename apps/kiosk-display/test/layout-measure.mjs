// Measured layout proof for the main kiosk screen (Plan 4 layout fix). jsdom lays nothing out, so this runs
// the real page in Chromium (Playwright, same set-up as scripts/ui-preview.mjs: Vite dev server, offline
// bundle cache, no box server) with a WIDE surau wordmark (test/fixtures/maxcom-logo.png, 500x126) and
// checks, at 1920x1080, 1366x768, 1280x720 and the admin app's preview frame (690x390):
//   - the content band's top clears the date/Hijri line by a steady gap (seconds on/off, long name, logo);
//   - the prayer bar is thin (about 70 % of the old 7.6rem) and low (2-4 % of the height above the edge);
//   - the logo is sized by height (about 4.2rem), keeps its aspect, and a tiny bitmap is capped at 2x.
// Screenshots land in ui-preview/layout/ (git-ignored). Exit code 1 when a check fails.
//
//   node apps/kiosk-display/test/layout-measure.mjs [filter]
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const repo = resolve(appDir, '../..');
const outDir = resolve(repo, 'ui-preview/layout');
const PORT = 5183;
const filter = process.argv[2] ?? '';

const core = await import(pathToFileURL(resolve(repo, 'packages/core/src/index.ts')).href);
const days = core.parseJakimCsv(readFileSync(resolve(repo, 'packages/core/test/fixtures/SGR01-2026.csv'), 'utf8'));
const fixturesDir = resolve(repo, 'ui-preview/fixtures');
const { IMAGES, makeContent } = await import(pathToFileURL(resolve(fixturesDir, 'content.mjs')).href);
const assets = new Map();
const assetIds = {};
for (const [key, file] of Object.entries(IMAGES)) {
  const body = readFileSync(resolve(fixturesDir, file));
  const id = createHash('sha256').update(body).digest('hex');
  assets.set(id, { body, contentType: file.endsWith('.svg') ? 'image/svg+xml' : 'image/png' });
  assetIds[key] = id;
}

const WIDE_PNG = readFileSync(resolve(here, 'fixtures/maxcom-logo.png'));
/** The same wordmark as the box serves it after "Buang latar putih" (rendered by the box's own imageAdjust.ts). */
const WIDE_REMOVED_PNG = readFileSync(resolve(here, 'fixtures/maxcom-logo-removed.png'));
const SQUARE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="18" fill="#0b4f47"/><circle cx="48" cy="50" r="30" fill="#f0c97a"/><circle cx="58" cy="44" r="24" fill="#0b4f47"/></svg>';
/** A solid 24x24 PNG: the 2x cap must stop it at 48 CSS px. */
function tinyPng(w, h) {
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = 240; raw[o + 1] = 201; raw[o + 2] = 122; raw[o + 3] = 255; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const TINY_PNG = tinyPng(24, 24);
const LOGOS = {
  wide: { body: WIDE_PNG, type: 'image/png' },
  wideRemoved: { body: WIDE_REMOVED_PNG, type: 'image/png' },
  square: { body: Buffer.from(SQUARE_SVG), type: 'image/svg+xml' },
  tiny: { body: TINY_PNG, type: 'image/png' },
};

const NAME = { surauInfo: { name: 'Surau D\'Waqaf' } };
/** The wordmark carries the name: the text name is left out of the header (Plan 4 add-on C). */
const NONAME = { surauInfo: { name: 'Surau D\'Waqaf', showName: false } };
const LONG = { surauInfo: { name: 'Masjid Jamek Kampung Baru Seksyen Tujuh Shah Alam' } };
const SEC12 = { clock: { showSeconds: true } };
const SEC24 = { prayerBar: { timeFormat: '24h' }, clock: { showSeconds: true } };
const T = '2026-11-03T15:52:00+08:00';
const T7 = '2026-11-03T15:52:07+08:00';
const SIZES = { 1920: [1920, 1080], 1366: [1366, 768], 1280: [1280, 720], preview: [690, 390] };

/** @type {{ name: string; now: string; size: keyof typeof SIZES; settings?: object; content?: string; card?: string; logo?: keyof typeof LOGOS | null; noName?: boolean }[]} */
const SHOTS = [];
for (const size of Object.keys(SIZES)) {
  SHOTS.push({ name: `band-hadis-ticker-${size}`, now: T, size, settings: NAME, content: 'islamic', card: 'hadis', logo: 'wide' });
  SHOTS.push({ name: `band-sec12-${size}`, now: T7, size, settings: { ...NAME, ...SEC12 }, content: 'islamic', card: 'hadis', logo: 'wide' });
  SHOTS.push({ name: `band-sec24-longname-${size}`, now: T7, size, settings: { ...LONG, ...SEC24 }, content: 'islamic', card: 'kuliahCard', logo: 'wide' });
  SHOTS.push({ name: `band-nologo-${size}`, now: T, size, settings: NAME, content: 'default', card: 'pengumuman', logo: null });
}
SHOTS.push({ name: 'logo-wide-removed-noname-1920', now: T, size: '1920', settings: NONAME, content: 'islamic', card: 'hadis', logo: 'wideRemoved', noName: true });
SHOTS.push({ name: 'logo-wide-removed-noname-preview', now: T, size: 'preview', settings: NONAME, content: 'islamic', card: 'hadis', logo: 'wideRemoved', noName: true });
SHOTS.push({ name: 'logo-square-1920', now: T, size: '1920', settings: NAME, content: 'default', card: 'takwim', logo: 'square' });
SHOTS.push({ name: 'logo-tiny-1920', now: T, size: '1920', settings: NAME, logo: 'tiny' });
SHOTS.push({ name: 'zikir-ticker-1920', now: '2026-11-03T16:50:00+08:00', size: '1920', settings: NAME, content: 'islamic', logo: 'wide' });
SHOTS.push({ name: 'poster-strip-1920', now: T, size: '1920', settings: NAME, content: 'default', card: 'posters', logo: 'wide' });
SHOTS.push({ name: 'iqamah-1366', now: '2026-11-03T16:25:00+08:00', size: '1366', settings: NAME, logo: 'wide' });

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
const results = [];
let failures = 0;
try {
  for (const shot of SHOTS) {
    if (filter && !shot.name.includes(filter)) continue;
    const [w, h] = SIZES[shot.size];
    const settings = core.resolveSettings(shot.settings ?? {});
    const bundle = { version: 1, zone: 'SGR01', days, settings, logo: shot.logo ? '/surau-logo?v=0123456789abcdef' : null, serverTime: new Date().toISOString() };
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const contentCache = shot.content ? JSON.stringify({ content: makeContent(assetIds, shot.content), fetchedAt: Date.now() }) : null;
    await ctx.addInitScript(({ bundle, content }) => {
      localStorage.setItem('surau.bundle', bundle);
      if (content) localStorage.setItem('surau.content', content); else localStorage.removeItem('surau.content');
    }, { bundle: JSON.stringify({ bundle, fetchedAt: Date.now() }), content: contentCache });
    await ctx.route('**/api/**', (route) => route.abort());
    await ctx.route('**/surau-logo*', (route) => {
      const logo = LOGOS[shot.logo ?? 'wide'];
      return route.fulfill({ status: 200, contentType: logo.type, body: logo.body });
    });
    await ctx.route('**/assets/*', (route) => {
      const id = new URL(route.request().url()).pathname.split('/').pop() ?? '';
      const hit = assets.get(id);
      return hit ? route.fulfill({ status: 200, contentType: hit.contentType, body: hit.body }) : route.fulfill({ status: 404, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !(m.location()?.url ?? '').includes('/api/')) errors.push(m.text()); });
    const card = shot.card ? `&card=${encodeURIComponent(shot.card)}` : '';
    await page.goto(`${base}/?now=${encodeURIComponent(shot.now)}${card}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.stage[data-phase]');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => { const img = document.querySelector('.bg__img'); return !img || img.classList.contains('is-ready'); });
    if (shot.card && shot.card !== 'posters') await page.waitForSelector('[data-layer="content"] [data-card]');
    if (shot.card === 'posters') await page.waitForSelector('[data-testid="poster-strip"]');
    if (shot.name.startsWith('zikir')) await page.waitForSelector('[data-layer="zikir"]');
    await page.waitForFunction(() => [...document.images].every((i) => i.complete));
    await page.waitForTimeout(1200);
    await page.screenshot({ path: resolve(outDir, `${shot.name}.png`) });

    const m = await page.evaluate(() => {
      const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height }; };
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const vh = window.innerHeight;
      const dates = r('.ident__dates');
      const band = r('[data-layer="content"]') ?? r('[data-layer="zikir"]');
      const pbar = r('.pbar');
      const ticker = r('.ticker');
      const logo = r('img[data-role="logo"]');
      const logoEl = document.querySelector('img[data-role="logo"]');
      const name = r('.ident__name');
      const head = r('.ident__head');
      const next = r('.next');
      const strip = r('.poster-strip');
      const stripLogo = r('.poster-strip img[data-role="logo"]');
      return {
        phase: document.querySelector('.stage')?.getAttribute('data-phase'),
        rem,
        gapRem: dates && band ? (band.top - dates.bottom) / rem : null,
        bandHRem: band ? band.h / rem : null,
        tickerGapRem: ticker && pbar ? (pbar.top - ticker.bottom) / rem : null,
        barHRem: pbar ? pbar.h / rem : null,
        barBottomPct: pbar ? ((vh - pbar.bottom) / vh) * 100 : null,
        logoHRem: logo ? logo.h / rem : null,
        logoAspect: logo && logo.h > 0 ? logo.w / logo.h : null,
        logoNatural: logoEl ? [logoEl.naturalWidth, logoEl.naturalHeight] : null,
        logoShape: logoEl?.getAttribute('data-shape') ?? null,
        logoCap: logoEl?.style.getPropertyValue('--logo-cap') || null,
        nameHRem: name ? name.h / rem : null,
        headNextOverlap: head && next ? head.right > next.left : false,
        stripLogoHRem: strip && stripLogo ? stripLogo.h / rem : null,
        stripLogoInside: strip && stripLogo ? stripLogo.top >= strip.top && stripLogo.bottom <= strip.bottom : null,
      };
    });
    const fails = [];
    if (errors.length) fails.push(`errors: ${errors.join(' | ')}`);
    if (m.phase === 'normal' && !shot.card?.startsWith('poster')) {
      if (m.gapRem === null || m.gapRem < 1) fails.push(`band top only ${m.gapRem?.toFixed(2)}rem below the date line (want >= 1rem)`);
      if (m.bandHRem === null || m.bandHRem < 15) fails.push(`band only ${m.bandHRem?.toFixed(2)}rem tall`);
      if (m.tickerGapRem !== null && (m.tickerGapRem < 0.4 || m.tickerGapRem > 1.2)) fails.push(`ticker-bar gap ${m.tickerGapRem.toFixed(2)}rem`);
    }
    if (m.barHRem !== null && (m.barHRem > 5.5 || m.barHRem < 5)) fails.push(`bar ${m.barHRem.toFixed(2)}rem tall (want 5-5.5rem, about 70 % of 7.6rem)`);
    if (m.barBottomPct !== null && (m.barBottomPct < 2 || m.barBottomPct > 4)) fails.push(`bar bottom margin ${m.barBottomPct.toFixed(2)} % of the height (want 2-4 %)`);
    if (m.headNextOverlap) fails.push('identity head runs into the next-prayer box');
    if (shot.logo && m.logoHRem === null) fails.push('logo missing');
    if (shot.noName && m.nameHRem !== null) fails.push('text name drawn although showName is off');
    if (!shot.noName && m.nameHRem === null) fails.push('text name missing');
    if (shot.logo === 'wide' || shot.logo === 'wideRemoved' || shot.logo === 'square') {
      if (m.logoHRem !== null && Math.abs(m.logoHRem - 4.2) > 0.05) fails.push(`logo ${m.logoHRem.toFixed(2)}rem tall (want 4.2rem)`);
      if (shot.card === 'posters' && (m.stripLogoHRem === null || Math.abs(m.stripLogoHRem - 3.2) > 0.05)) fails.push(`poster-strip logo ${m.stripLogoHRem?.toFixed(2)}rem tall (want 3.2rem)`);
      if (m.logoAspect !== null && m.logoNatural && Math.abs(m.logoAspect - m.logoNatural[0] / m.logoNatural[1]) > 0.05) fails.push(`logo aspect ${m.logoAspect.toFixed(2)} vs natural ${(m.logoNatural[0] / m.logoNatural[1]).toFixed(2)}`);
      if (m.logoShape !== (shot.logo === 'square' ? 'compact' : 'wide')) fails.push(`logo shape ${m.logoShape}`);
    }
    if (shot.logo === 'tiny' && m.logoHRem !== null && Math.abs(m.logoHRem * m.rem - 48) > 1) fails.push(`tiny logo ${(m.logoHRem * m.rem).toFixed(1)}px tall (want 48px = 2x its bitmap)`);
    if (shot.card === 'posters' && m.stripLogoInside === false) fails.push('poster-strip logo outside the strip');
    if (fails.length) failures += 1;
    results.push({ shot: shot.name, ...m, fails });
    const nums = `gap=${m.gapRem?.toFixed(2) ?? '-'}rem band=${m.bandHRem?.toFixed(1) ?? '-'}rem bar=${m.barHRem?.toFixed(2) ?? '-'}rem bottom=${m.barBottomPct?.toFixed(2) ?? '-'}% logo=${m.logoHRem?.toFixed(2) ?? '-'}rem${m.logoShape ? `/${m.logoShape}` : ''}`;
    console.log(`${shot.name.padEnd(30)} ${nums}${fails.length ? `  FAIL: ${fails.join('; ')}` : '  ok'}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.close();
}
writeFileSync(resolve(outDir, 'measure.json'), JSON.stringify(results, null, 2));
if (failures) {
  console.error(`${failures} shot(s) failed`);
  process.exitCode = 1;
}
