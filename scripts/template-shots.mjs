// Screenshots of every kiosk presentation template (kioskTemplate.templateId) at 1920x1080 with realistic BM
// content, from the Vite dev server and the seeded offline cache (same method as ui-preview.mjs; no box needed).
//
//   node scripts/template-shots.mjs <outDir> [template,template...] [state,state...]
//
// States: normal (kuliah card, ticker, source footer), iqamah (countdown), emergency (calculated-times band),
// solat (the dimmed calm screen), poster (poster takeover strip). Files: <outDir>/<template>-<state>.png.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const appDir = resolve(repo, 'apps/kiosk-display');
const outDir = resolve(process.argv[2] ?? resolve(repo, 'ui-preview/templates'));
const ALL_TEMPLATES = ['default', 'colourful', 'creative', 'oldschool', 'minimal'];
const templates = process.argv[3] ? process.argv[3].split(',') : ALL_TEMPLATES;
const PORT = 5181;

const core = await import(pathToFileURL(resolve(repo, 'packages/core/src/index.ts')).href);
const baseDays = core.parseJakimCsv(readFileSync(resolve(repo, 'packages/core/test/fixtures/SGR01-2026.csv'), 'utf8'));
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

const STATES = {
  normal: { now: `${DAY}T15:52:00+08:00`, content: 'islamic', card: 'kuliahCard', wait: '[data-layer="content"] [data-card]' },
  iqamah: { now: `${DAY}T16:25:00+08:00` },
  emergency: { now: `${DAY}T15:52:00+08:00`, content: 'islamic', card: 'pengumuman', emergency: true, wait: '[data-testid="emergency-band"]' },
  solat: { now: `${DAY}T16:35:00+08:00` },
  poster: { now: `${DAY}T15:52:00+08:00`, content: 'default', card: 'posters', wait: '[data-testid="poster-strip"]' },
};
const states = process.argv[4] ? process.argv[4].split(',') : Object.keys(STATES);

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
let failed = false;
try {
  for (const template of templates) {
    for (const stateName of states) {
      const st = STATES[stateName];
      const settings = core.resolveSettings({
        surauInfo: { name: 'Surau Al-Hidayah' },
        kioskTemplate: { templateId: template },
      });
      const bundle = { version: 1, zone: 'SGR01', days: daysFor(st.emergency === true), settings, serverTime: new Date().toISOString() };
      const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
      const content = st.content ? JSON.stringify({ content: makeContent(assetIds, st.content), fetchedAt: Date.now() }) : null;
      await ctx.addInitScript(({ b, c }) => {
        localStorage.setItem('surau.bundle', b);
        if (c) localStorage.setItem('surau.content', c);
        else localStorage.removeItem('surau.content');
      }, { b: JSON.stringify({ bundle, fetchedAt: Date.now() }), c: content });
      await ctx.route('**/api/**', (route) => route.abort());
      await ctx.route('**/assets/*', (route) => {
        const id = new URL(route.request().url()).pathname.split('/').pop() ?? '';
        const hit = assets.get(id);
        return hit ? route.fulfill({ status: 200, contentType: hit.contentType, body: hit.body }) : route.fulfill({ status: 404, body: '' });
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      const card = st.card ? `&card=${st.card}` : '';
      await page.goto(`${base}/?now=${encodeURIComponent(st.now)}${card}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.stage[data-phase]');
      await page.evaluate(() => document.fonts.ready);
      if (st.wait) await page.waitForSelector(st.wait);
      await page.waitForFunction(() => [...document.images].every((i) => i.complete));
      await page.waitForTimeout(1300);
      const file = resolve(outDir, `${template}-${stateName}.png`);
      await page.screenshot({ path: file });
      const seen = await page.evaluate(() => ({
        phase: document.querySelector('.stage')?.getAttribute('data-phase'),
        template: document.querySelector('.stage')?.getAttribute('data-template'),
      }));
      const ok = (seen.template ?? 'default') === template && errors.length === 0;
      if (!ok) failed = true;
      console.log(`${ok ? 'OK  ' : 'FAIL'} ${template}-${stateName}.png phase=${seen.phase} template=${seen.template}${errors.length ? ` ERRORS ${errors.join(' | ')}` : ''}`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
if (failed) process.exit(1);
