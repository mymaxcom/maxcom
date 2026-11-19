// Screenshots of the kiosk Video screen: an uploaded file (a synthetic ffmpeg test clip) and a YouTube item (the
// player is replaced by a placeholder page, no network), in the default and the Arabic Art themes, from the Vite dev
// server and a seeded offline cache (the method of template-shots.mjs; no box needed). Uses the installed Chrome (the
// bundled Chromium has no H.264 decoder).
//
//   node scripts/video-shots.mjs <outDir> <clip.mp4> [template,template...]
//
// SHOT_SIZE=<w>x<h>@<dsf> (default 960x540@2). Files: <outDir>/<template>-video-upload.png and <template>-video-youtube.png.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const appDir = resolve(repo, 'apps/kiosk-display');
const SIZE = /^(\d+)x(\d+)@(\d+(?:\.\d+)?)$/.exec(process.env.SHOT_SIZE ?? '960x540@2');
if (!SIZE) throw new Error(`SHOT_SIZE must look like 960x540@2, got ${process.env.SHOT_SIZE}`);
const viewport = { width: Number(SIZE[1]), height: Number(SIZE[2]) };
const deviceScaleFactor = Number(SIZE[3]);
const outDir = resolve(process.argv[2] ?? resolve(repo, 'ui-preview/video'));
const clipPath = process.argv[3] ? resolve(process.argv[3]) : null;
if (!clipPath) throw new Error('give the test clip (an H.264 MP4) as the second argument');
const templates = process.argv[4] ? process.argv[4].split(',') : ['default', 'arabic'];
const PORT = Number(process.env.SHOT_PORT ?? 5183);
mkdirSync(outDir, { recursive: true });

const core = await import(pathToFileURL(resolve(repo, 'packages/core/src/index.ts')).href);
const baseDays = core.parseJakimCsv(readFileSync(resolve(repo, 'packages/core/test/fixtures/SGR01-2026.csv'), 'utf8'));
const clip = readFileSync(clipPath);
const clipId = createHash('sha256').update(clip).digest('hex');
const logoBody = readFileSync(resolve(repo, 'ui-preview/fixtures/logo-1.png'));

const DAY = '2026-11-03';
const base = { updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'shots' };
const emptyContent = {
  date: DAY, kuliah: [], pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [], hadisToday: [], worldTimes: [], tugasan: [],
  ayat: { today: null, tomorrow: null }, zikir: [], tilawah: { slots: [], available: {} }, credits: { translation: '', font: '', audio: '' },
};
const VIDEOS = {
  upload: [{ ...base, id: 'v1', title: 'Selamat datang', source: 'upload', assetId: clipId, durationSec: 4, days: ['umum'], order: 1 }],
  youtube: [{ ...base, id: 'v2', title: 'Tazkirah', source: 'youtube', youtubeId: 'dQw4w9WgXcQ', days: ['umum'], order: 1 }],
};
const PLACEHOLDER = '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#101418;color:#cfd6dc;font:700 3vw system-ui;display:grid;place-items:center;height:100vh">YouTube player (placeholder)</body>';

const server = await createServer({
  root: appDir,
  configFile: resolve(appDir, 'vite.config.ts'),
  logLevel: 'error',
  server: { port: PORT, strictPort: true, host: '127.0.0.1' },
});
await server.listen();
const base_ = `http://127.0.0.1:${PORT}`;
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
} catch {
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
}
let failed = false;
try {
  for (const template of templates) {
    for (const kind of ['upload', 'youtube']) {
      const settings = core.resolveSettings({ surauInfo: { name: 'Surau Al-Hidayah' }, kioskTemplate: { templateId: template } });
      const days = baseDays.map((d) => ({ ...d, source: 'official', emergency: false, corrected: [], footerMs: 'Sumber: JAKIM e-Solat SGR01', footerEn: 'Source: JAKIM e-Solat SGR01' }));
      const bundle = { version: 1, zone: 'SGR01', days, settings, serverTime: new Date().toISOString(), logo: '/surau-logo?v=abc123' };
      const content = { ...emptyContent, videos: VIDEOS[kind] };
      const ctx = await browser.newContext({ viewport, deviceScaleFactor, reducedMotion: 'reduce' });
      await ctx.addInitScript(({ b, c }) => {
        localStorage.setItem('surau.bundle', b);
        localStorage.setItem('surau.content', c);
      }, { b: JSON.stringify({ bundle, fetchedAt: Date.now() }), c: JSON.stringify({ content, fetchedAt: Date.now() }) });
      await ctx.route('**/api/**', (route) => route.abort());
      await ctx.route('**/surau-logo*', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: logoBody }));
      await ctx.route('**/assets/*', (route) => {
        const id = new URL(route.request().url()).pathname.split('/').pop() ?? '';
        return id === clipId ? route.fulfill({ status: 200, contentType: 'video/mp4', headers: { 'accept-ranges': 'bytes' }, body: clip }) : route.fulfill({ status: 404, body: '' });
      });
      await ctx.route('https://www.youtube-nocookie.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PLACEHOLDER }));
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(`${base_}/?now=${encodeURIComponent(`${DAY}T15:52:00+08:00`)}&card=videos`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.stage[data-phase]');
      await page.evaluate(() => document.fonts.ready);
      await page.waitForSelector('[data-card="videos"]', { timeout: 10000 });
      if (kind === 'upload') {
        await page.waitForFunction(() => {
          const v = document.querySelector('video');
          return v && v.readyState >= 2 && v.currentTime > 0.3;
        }, null, { timeout: 15000 });
      } else {
        await page.waitForFunction(() => document.querySelector('iframe'), null, { timeout: 5000 });
        await page.waitForTimeout(800);
      }
      await page.waitForTimeout(500);
      const file = resolve(outDir, `${template}-video-${kind}.png`);
      await page.screenshot({ path: file });
      const seen = await page.evaluate(() => ({
        screen: document.querySelector('.stage')?.getAttribute('data-screen'),
        phase: document.querySelector('.stage')?.getAttribute('data-phase'),
        muted: document.querySelector('video')?.muted ?? null,
        playing: document.querySelector('video') ? !document.querySelector('video').paused : null,
        frame: document.querySelector('iframe')?.getAttribute('src') ?? null,
      }));
      const ok = seen.screen === 'video' && seen.phase === 'normal' && errors.length === 0 && (kind === 'upload' ? seen.muted === true && seen.playing === true : (seen.frame ?? '').includes('youtube-nocookie.com/embed/dQw4w9WgXcQ'));
      if (!ok) failed = true;
      console.log(`${ok ? 'OK  ' : 'FAIL'} ${template}-video-${kind}.png ${JSON.stringify(seen)}${errors.length ? ` ERRORS ${errors.join(' | ')}` : ''}`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
if (failed) process.exit(1);
