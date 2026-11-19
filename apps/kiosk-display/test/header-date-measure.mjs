// Measured proof for the content-screen header (2026.11.13): the date line under the surau name must never cross the
// card region's top line, whatever the name's length and the template. jsdom lays nothing out, so this runs the real
// page in Chromium (Playwright, Vite dev server, offline bundle cache, same set-up as scripts/template-shots.mjs) at
// 960x540 CSS px, device scale factor 2 (the T95 TV box). For every template x name x screen it checks:
//   - the date line's bottom is at or above the card region's top (and the card panel's top);
//   - the name and the date are fully inside the stage (no clip) and the date does not run under the clock chip;
//   - the date sits below the name (no overlap between the two).
// Screenshots land in HEADER_OUT (default ui-preview/header-date/, git-ignored). Exit code 1 when a check fails.
//
//   node apps/kiosk-display/test/header-date-measure.mjs [templates] [names]     e.g. default,arabic twenty,long
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const repo = resolve(appDir, '../..');
const outDir = resolve(process.env.HEADER_OUT ?? resolve(repo, 'ui-preview/header-date'));
const PORT = Number(process.env.HEADER_PORT ?? 5187);
const ALL_TEMPLATES = ['default', 'colourful', 'creative', 'oldschool', 'minimal', 'arabic'];
const templates = process.argv[2] ? process.argv[2].split(',') : ALL_TEMPLATES;
const NAMES = {
  short: 'Surau Al-Ikhlas',
  twenty: 'Surau Darul Hikmahan',
  long: 'Masjid Jamek Sultan Abdul Samad Kuala Lumpur',
  arabic: 'مسجد دار الحكمة الكبير',
};
const names = process.argv[3] ? process.argv[3].split(',') : Object.keys(NAMES);
const DAY = '2026-11-03';
const SCREENS = {
  hadis: { now: `${DAY}T15:52:00+08:00`, card: 'hadis', wait: '[data-layer="content"] [data-card]' },
  zikir: { now: `${DAY}T16:50:00+08:00`, card: null, wait: '[data-layer="zikir"]' },
};

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
const days = baseDays.map((d) => ({ ...d, source: 'official', emergency: false, corrected: [], footerMs: 'Sumber: JAKIM e-Solat SGR01', footerEn: 'Source: JAKIM e-Solat SGR01' }));

mkdirSync(outDir, { recursive: true });
const server = await createServer({
  configFile: resolve(appDir, 'vite.config.ts'),
  root: appDir,
  logLevel: 'warn',
  ...(process.env.HEADER_VITE_CACHE ? { cacheDir: resolve(process.env.HEADER_VITE_CACHE) } : {}),
  server: { port: PORT, strictPort: true, host: '127.0.0.1' },
});
await server.listen();
const base = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch();
let failed = false;
try {
  for (const template of templates) {
    for (const nameKey of names) {
      for (const [screenKey, sc] of Object.entries(SCREENS)) {
        const settings = core.resolveSettings({ surauInfo: { name: NAMES[nameKey] }, kioskTemplate: { templateId: template } });
        const bundle = { version: 1, zone: 'SGR01', days, settings, serverTime: new Date().toISOString(), logo: '/surau-logo?v=abc123' };
        const made = makeContent(assetIds, 'islamic');
        const ctx = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
        await ctx.addInitScript(({ b, c }) => {
          localStorage.setItem('surau.bundle', b);
          localStorage.setItem('surau.content', c);
        }, { b: JSON.stringify({ bundle, fetchedAt: Date.now() }), c: JSON.stringify({ content: made, fetchedAt: Date.now() }) });
        await ctx.route('**/api/**', (route) => route.abort());
        await ctx.route('**/surau-logo*', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: logoBody }));
        await ctx.route('**/assets/*', (route) => {
          const id = new URL(route.request().url()).pathname.split('/').pop() ?? '';
          const hit = assets.get(id);
          return hit ? route.fulfill({ status: 200, contentType: hit.contentType, body: hit.body }) : route.fulfill({ status: 404, body: '' });
        });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
        await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
        await page.goto(`${base}/?now=${encodeURIComponent(sc.now)}${sc.card ? `&card=${sc.card}` : ''}`, { waitUntil: 'networkidle' });
        await page.clock.runFor(1000);
        await page.waitForSelector('.stage[data-phase]');
        await page.evaluate(() => document.fonts.ready);
        for (let i = 0; i < 40 && !(await page.$(sc.wait)); i++) { await page.clock.runFor(250); await page.waitForTimeout(50); }
        await page.waitForSelector(sc.wait);
        await page.waitForFunction(() => [...document.images].every((i) => i.complete));
        await page.clock.runFor(1300);
        await page.waitForTimeout(100);
        const tag = `${template}-${nameKey}-${screenKey}`;
        await page.screenshot({ path: resolve(outDir, `${tag}.png`) });
        const m = await page.evaluate(() => {
          const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height }; };
          const shell = document.querySelector('.screen--shell');
          const name = document.querySelector('.region-brand .brand-name');
          const date = document.querySelector('.region-brand .shell-date');
          const chip = document.querySelector('.shell-top');
          const main = shell && shell.querySelector('.region-main, .zikir, [data-layer="zikir"], [data-layer="content"]');
          const card = main && main.firstElementChild;
          return {
            kind: document.querySelector('.stage')?.getAttribute('data-kind'),
            name: r(name), date: r(date), chip: r(chip), main: r(main), card: r(card),
            nameClipped: name ? name.scrollWidth > name.clientWidth + 1 : null,
            dateRight: date ? date.getBoundingClientRect().left + date.scrollWidth : null,
            nameLines: name ? Math.round(name.getBoundingClientRect().height / parseFloat(getComputedStyle(name).lineHeight)) : null,
            fs: ['.shell-date', '.shell-greg', '.shell-hijri', '.brand-name'].map((q) => { const e = document.querySelector('.region-brand ' + q); return e ? parseFloat(getComputedStyle(e).fontSize) : null; }),
            w: innerWidth, h: innerHeight,
          };
        });
        const vOverlap0 = (q) => q.date.bottom > q.chip.top && q.date.top < q.chip.bottom;
        const why = [];
        if (m.kind !== 'content' || !m.name || !m.date) why.push(`kind=${m.kind} name=${!!m.name} date=${!!m.date}`);
        else {
          // a layer that spans the whole stage (the Arabic-led zikir) has no top line of its own: its first child is the panel
          const lim = (m.main?.top ?? 1e9) < 1 ? (m.card?.top ?? 1e9) : Math.min(m.main?.top ?? 1e9, m.card?.top ?? 1e9);
          if (m.date.bottom > lim + 0.5) why.push(`date bottom ${m.date.bottom.toFixed(1)} > region top ${lim.toFixed(1)}`);
          if (m.date.top < m.name.bottom - 0.5) why.push('date overlaps name');
          for (const [k, b] of [['name', m.name], ['date', m.date]]) {
            if (b.left < 0 || b.top < 0 || b.right > m.w + 0.5 || b.bottom > m.h) why.push(`${k} outside the stage`);
          }
          if (m.nameClipped) why.push('name clipped (scrollWidth)');
          if (m.dateRight > m.w - 1 || (vOverlap0(m) && m.dateRight > m.chip.left)) why.push(`date runs past ${m.dateRight.toFixed(1)} (chip left ${m.chip.left.toFixed(1)}, stage ${m.w})`);
        }
        if (errors.length) why.push(`errors ${errors.join(' | ')}`);
        const ok = why.length === 0;
        if (!ok) failed = true;
        console.log(`${ok ? 'OK  ' : 'FAIL'} ${tag} nameLines=${m.nameLines} dateBottom=${m.date?.bottom.toFixed(1)} regionTop=${m.main?.top.toFixed(1)} cardTop=${m.card?.top.toFixed(1)} fs(date,greg,hijri,name)=${m.fs.join('/')}${ok ? '' : ' :: ' + why.join('; ')}`);
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
  await server.close();
}
if (failed) process.exit(1);
