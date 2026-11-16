// Opens the kiosk display in a normal desktop Chrome window with the preview fixture content (ui-preview/fixtures),
// for looking at a screen by hand: the Vite dev server of apps/kiosk-display (hot reload), the offline bundle and content
// cache seeded the way scripts/template-shots.mjs seeds them, every /api call blocked, fixture pictures served at
// /assets/<sha256>. Closing the window stops the dev server.
//
//   node scripts/kiosk-preview-window.mjs [template] [card] [variant] [settings.json]
//
//   template  default | minimal | colourful | creative | oldschool | arabic   (default: default)
//   card      a rotation card to hold on screen, e.g. kuliahCard, hadis, posters (default: kuliahCard)
//   variant   fixture content variant of ui-preview/fixtures/content.mjs, e.g. islamic, long (default: islamic)
//   settings  optional JSON of settings features merged over the defaults, e.g. {"kitabCover":{"enabled":false}}
//
// Env PREVIEW_CHANNEL=chrome (default) uses the installed Google Chrome; set it to "" for Playwright's own Chromium.
// The page is frozen at 2026-11-03 15:52 (Kuala Lumpur), as in the goldens.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const appDir = resolve(repo, 'apps/kiosk-display');
// PREVIEW_PORT moves the dev server off 5183 (another preview or a dev server of the operator may hold it).
const PORT = Number(process.env.PREVIEW_PORT ?? 5183);
const [template = 'default', card = 'kuliahCard', variant = 'islamic', settingsFile] = process.argv.slice(2);

const core = await import(pathToFileURL(resolve(repo, 'packages/core/src/index.ts')).href);
const days = core.parseJakimCsv(readFileSync(resolve(repo, 'packages/core/test/fixtures/SGR01-2026.csv'), 'utf8'))
  .map((d) => ({ ...d, source: 'official', emergency: false, corrected: [], footerMs: 'Sumber: JAKIM e-Solat SGR01', footerEn: 'Source: JAKIM e-Solat SGR01' }));
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

const stored = { surauInfo: { name: 'Surau Al-Hidayah' }, kioskTemplate: { templateId: template } };
if (settingsFile) {
  for (const [feature, value] of Object.entries(JSON.parse(readFileSync(resolve(settingsFile), 'utf8')))) {
    stored[feature] = { ...(stored[feature] ?? {}), ...(value && typeof value === 'object' ? value : {}) };
  }
}
const settings = core.resolveSettings(stored);
const bundle = { version: 1, zone: 'SGR01', days, settings, serverTime: new Date().toISOString() };
const content = { content: makeContent(assetIds, variant), fetchedAt: Date.now() };

const server = await createServer({ configFile: resolve(appDir, 'vite.config.ts'), root: appDir, logLevel: 'warn', server: { port: PORT, strictPort: true, host: '127.0.0.1' } });
await server.listen();
const channel = process.env.PREVIEW_CHANNEL ?? 'chrome';
const browser = await chromium.launch({ headless: false, ...(channel ? { channel } : {}), args: ['--window-size=1920,1080'] });
const ctx = await browser.newContext({ viewport: null });
await ctx.addInitScript(({ b, c }) => {
  localStorage.setItem('surau.bundle', b);
  localStorage.setItem('surau.content', c);
}, { b: JSON.stringify({ bundle, fetchedAt: Date.now() }), c: JSON.stringify(content) });
await ctx.route('**/api/**', (route) => route.abort());
await ctx.route('**/assets/*', (route) => {
  const hit = assets.get(new URL(route.request().url()).pathname.split('/').pop() ?? '');
  return hit ? route.fulfill({ status: 200, contentType: hit.contentType, body: hit.body }) : route.fulfill({ status: 404, body: '' });
});
const page = await ctx.newPage();
const url = `http://127.0.0.1:${PORT}/?now=${encodeURIComponent('2026-11-03T15:52:00+08:00')}&card=${encodeURIComponent(card)}`;
await page.goto(url);
console.log(`Kiosk preview open: ${url} (template ${template}, card ${card}, content ${variant}). Close the window to stop.`);
if (process.env.PREVIEW_SHOT) {
  // Self-check: wait for the screen, save one picture of the window and close.
  await page.waitForSelector('[data-layer="content"] [data-card]', { timeout: 30_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: resolve(process.env.PREVIEW_SHOT) });
  await browser.close();
}
await new Promise((done) => (browser.isConnected() ? browser.on('disconnected', done) : done()));
await server.close();
