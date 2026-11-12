// NOTE: these shots are drawn by the current Chromium that Playwright ships, not by the T95's Chrome 91 WebView.
// They show layout and content; they are not proof of how Chrome 91 renders (outlines, `gap`, newer CSS).
//
// UI/UX review matrix: every kiosk template x many data/config scenarios, at the viewport a TV box really gives
// the WebView (T95: 960x540 CSS px at DPR 2), plus one contact sheet per scenario (all templates side by side).
// Same offline method as ui-preview.mjs / template-shots.mjs: Vite dev server + seeded cache, /api aborted.
//
//   node scripts/uiux-matrix.mjs <outDir> [scenarioFilter] [templates] [WxH@dpr]
//
// Files: <outDir>/<scenario>/<template>.png and <outDir>/sheet-<scenario>.png. Prints one line per shot plus
// layout warnings (text clipped by its box, elements outside the stage, overlaps of key boxes).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const appDir = resolve(repo, 'apps/kiosk-display');
const outDir = resolve(process.argv[2] ?? resolve(repo, 'ui-preview/matrix'));
const filter = process.argv[3] && process.argv[3] !== '-' ? process.argv[3] : '';
const ALL = ['default', 'colourful', 'creative', 'oldschool', 'minimal'];
const templates = process.argv[4] && process.argv[4] !== '-' ? process.argv[4].split(',') : ALL;
const vp = /^(\d+)x(\d+)@(\d+(?:\.\d+)?)$/.exec(process.argv[5] ?? '960x540@2');
const W = Number(vp[1]);
const H = Number(vp[2]);
const DPR = Number(vp[3]);
const PORT = Number(process.env.MATRIX_PORT ?? 5183);

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
function daysFor(emergency) {
  return baseDays.map((d) => (emergency && d.date === '2026-11-03'
    ? { ...d, source: 'calc', emergency: true, corrected: [], footerMs: 'Kiraan JAKIM 18/18, Shah Alam', footerEn: 'JAKIM 18/18 calculation, Shah Alam' }
    : { ...d, source: 'official', emergency: false, corrected: [], footerMs: 'Sumber: JAKIM e-Solat SGR01', footerEn: 'Source: JAKIM e-Solat SGR01' }));
}

const T = '2026-11-03T15:52:00+08:00';
const LONG_NAME = { surauInfo: { name: 'Masjid Jamek Sultan Hisamuddin Alam Shah Kampung Baru' } };
/** @type {{ name: string; now: string; content?: string; card?: string; settings?: object; emergency?: boolean; noCache?: boolean; pair?: boolean; wait?: string }[]} */
const SCEN = [
  { name: '01-kuliah', now: T, content: 'islamic', card: 'kuliahCard', wait: '[data-card]' },
  { name: '02-kuliah-long', now: T, content: 'long', card: 'kuliahCard', wait: '[data-card]', settings: LONG_NAME },
  { name: '03-pengumuman', now: T, content: 'default', card: 'pengumuman', wait: '[data-card]' },
  { name: '04-poster', now: T, content: 'default', card: 'posters', wait: '[data-card]' },
  { name: '05-programkhas', now: T, content: 'default', card: 'programKhas', wait: '[data-card]' },
  { name: '06-takwim-long', now: T, content: 'long', card: 'takwim', wait: '[data-card]' },
  { name: '07-hadis', now: T, content: 'islamic-he', card: 'hadis', wait: '[data-card]' },
  { name: '08-ayat', now: T, content: 'islamic', card: 'ayatCard', wait: '[data-card]' },
  { name: '09-worldtimes', now: T, content: 'islamic-long', card: 'worldTimes', wait: '[data-card]' },
  { name: '10-tugasan', now: T, content: 'islamic', card: 'tugasan', wait: '[data-card]' },
  { name: '11-empty-no-content', now: T },
  { name: '12-ticker-only', now: '2026-11-03T11:00:00+08:00', content: 'islamic-long', card: 'none' },
  { name: '13-en-24h-seconds', now: '2026-11-03T15:52:07+08:00', content: 'islamic', card: 'kuliahCard', wait: '[data-card]', settings: { language: { lang: 'en' }, prayerBar: { timeFormat: '24h' }, clock: { showSeconds: true } } },
  { name: '14-12h-seconds', now: '2026-11-03T10:58:07+08:00', content: 'islamic', card: 'kuliahCard', wait: '[data-card]', settings: { clock: { showSeconds: true } } },
  { name: '15-azan', now: '2026-11-03T16:12:00+08:00' },
  { name: '16-masuk', now: '2026-11-03T16:20:10+08:00' },
  { name: '17-iqamah', now: '2026-11-03T16:25:00+08:00' },
  { name: '18-solat', now: '2026-11-03T16:35:00+08:00' },
  { name: '19-khutbah', now: '2026-11-06T13:05:00+08:00' },
  { name: '20-tarawih', now: '2026-11-04T20:50:00+08:00', settings: { tarawih: { hijriMonth: 5 } } },
  { name: '21-zikir', now: '2026-11-03T16:50:00+08:00', content: 'islamic', wait: '[data-layer="zikir"]' },
  { name: '22-emergency', now: T, content: 'islamic', card: 'pengumuman', emergency: true, wait: '[data-testid="emergency-band"]' },
  { name: '22b-emergency-idle', now: T, emergency: true, wait: '[data-testid="emergency-band"]' },
  { name: '22c-emergency-idle-5', now: T, emergency: true, settings: { prayerBar: { showImsak: false, showSyuruk: false } }, wait: '[data-testid="emergency-band"]' },
  { name: '22d-emergency-syuruk', now: '2026-11-03T06:52:00+08:00', emergency: true, settings: { syurukWarning: { enabled: true } }, wait: '[data-testid="emergency-band"]' },
  { name: '23-night', now: '2026-11-04T21:30:00+08:00', content: 'default', card: 'kuliahCard', wait: '[data-card]' },
  { name: '24-nodata', now: '2027-01-01T09:00:00+08:00' },
  // Live on the kiosk (Plan 5 Task 6): /api/kiosk/live says on air, the WHEP offer is left pending (no media in
  // a headless run), the <video> shows LIVE_FRAME as its poster and gets a `playing` event, the same event a real
  // stream fires, so LiveLayer goes on air through its own code path (video and scrim visible, .has-live).
  { name: '25-live', now: T, content: 'islamic', live: true, wait: '[data-testid="live-video"]' },
  { name: '25b-live-emergency', now: T, content: 'islamic', live: true, emergency: true, wait: '[data-testid="live-video"]' },
];

const LIVE = { live: true, since: '2026-11-03T15:30:00+08:00', kuliah: { label: 'Kuliah Maghrib', penceramah: 'Ustaz Ahmad Fauzi bin Hassan', topic: 'Adab menuntut ilmu' }, audio: false, volume: 50 };
// A stand-in camera frame: a lit hall with windows, a speaker in white at a dark lectern. Mixed light and dark
// on purpose, so text that relies on the template's own background shows up as unreadable here.
const LIVE_FRAME = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 900'>
<defs><linearGradient id='w' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#d9c9a8'/><stop offset='1' stop-color='#9c8160'/></linearGradient>
<linearGradient id='f' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#6d5236'/><stop offset='1' stop-color='#3b2a1a'/></linearGradient></defs>
<rect width='1600' height='900' fill='url(#w)'/>
<g fill='#f6f1e4'><path d='M120 120h170v330H120z'/><path d='M1310 120h170v330h-170z'/><path d='M120 120a85 85 0 0 1 170 0z'/><path d='M1310 120a85 85 0 0 1 170 0z'/></g>
<rect y='640' width='1600' height='260' fill='url(#f)'/>
<rect x='560' y='60' width='480' height='420' fill='#2f5a4a'/><path d='M560 60h480v40H560z' fill='#c9a24a'/>
<ellipse cx='800' cy='300' rx='70' ry='86' fill='#b98a64'/><path d='M720 250q80-90 160 0v-40q-80-70-160 0z' fill='#fafafa'/>
<path d='M610 900q10-420 190-470 180 50 190 470z' fill='#f2f2ee'/>
<path d='M660 560h280l40 340H620z' fill='#3a2614'/><rect x='640' y='545' width='320' height='30' fill='#5a3d22'/>
</svg>`)}`;

/** In-page layout audit: text overflowing its own box, boxes leaving the stage, key boxes overlapping. */
const AUDIT = () => {
  const out = [];
  const vw = innerWidth;
  const vh = innerHeight;
  const vis = (el) => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05 && el.getClientRects().length > 0; };
  const name = (el) => `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 2).join('.')}`;
  for (const el of document.querySelectorAll('.stage *')) {
    if (!vis(el)) continue;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (el.closest('.ticker__strip, .bg, [data-layer="live"]')) continue;
    const clips = s.overflow !== 'visible' || s.overflowX !== 'visible' || s.overflowY !== 'visible';
    if (clips && (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2) && el.textContent.trim()) {
      out.push(`clip ${name(el)} ${el.scrollWidth}x${el.scrollHeight}>${el.clientWidth}x${el.clientHeight} "${el.textContent.trim().slice(0, 40)}"`);
    }
    if (r.right > vw + 1 || r.bottom > vh + 1 || r.left < -1 || r.top < -1) {
      if (!el.closest('.ticker')) out.push(`offstage ${name(el)} ${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}`);
    }
  }
  const boxes = ['.ident', '.clock', '.next', '[data-layer="content"] [data-card]', '.ticker', '.pbar', '.source-footer', '.emergency-band', '.zikir', '.phase__centre', '.poster-strip']
    .flatMap((q) => [...document.querySelectorAll(q)].filter(vis).map((el) => ({ q, r: el.getBoundingClientRect() })));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].r;
      const b = boxes[j].r;
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 2 && oy > 2 && !(boxes[i].q === '.ident' && boxes[j].q === '.clock')) out.push(`overlap ${boxes[i].q} x ${boxes[j].q} ${Math.round(ox)}x${Math.round(oy)}`);
    }
  }
  // Current prayer cell: the countdown chip must not cover the time digits (or the label). Templates put the chip
  // under, beside or in front of the time, so the check is a real rectangle intersection, not "is it below".
  const cur = document.querySelector('.pcell.is-current');
  if (cur) {
    const c = cur.querySelector('.pcell__cd');
    if (c && vis(c)) {
      const cr = c.getBoundingClientRect();
      for (const sel of ['.pcell__time', '.pcell__label']) {
        const t = cur.querySelector(sel);
        if (!t) continue;
        const tr = t.getBoundingClientRect();
        const ox = Math.min(cr.right, tr.right) - Math.max(cr.left, tr.left);
        const oy = Math.min(cr.bottom, tr.bottom) - Math.max(cr.top, tr.top);
        if (ox > 0.5 && oy > 0.5) out.push(`chip-overlaps-${sel === '.pcell__time' ? 'time' : 'label'} ${ox.toFixed(1)}x${oy.toFixed(1)}px`);
      }
    }
  }
  return [...new Set(out)].slice(0, 12);
};

mkdirSync(outDir, { recursive: true });
const server = await createServer({ configFile: resolve(appDir, 'vite.config.ts'), root: appDir, logLevel: 'warn', server: { port: PORT, strictPort: true, host: '127.0.0.1' } });
await server.listen();
const base = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch();
const done = [];
try {
  for (const sc of SCEN) {
    if (filter && !sc.name.includes(filter)) continue;
    mkdirSync(resolve(outDir, sc.name), { recursive: true });
    for (const template of templates) {
      const settings = core.resolveSettings({ surauInfo: { name: 'Surau Al-Hidayah' }, ...(sc.live ? { liveOnKiosk: { enabled: true } } : {}), ...(sc.settings ?? {}), kioskTemplate: { templateId: template } });
      const bundle = { version: 1, zone: 'SGR01', days: daysFor(sc.emergency === true), settings, serverTime: new Date().toISOString() };
      const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
      const content = sc.content ? JSON.stringify({ content: makeContent(assetIds, sc.content), fetchedAt: Date.now() }) : null;
      await ctx.addInitScript(({ b, c }) => {
        if (b) localStorage.setItem('surau.bundle', b); else localStorage.removeItem('surau.bundle');
        if (c) localStorage.setItem('surau.content', c); else localStorage.removeItem('surau.content');
      }, { b: sc.noCache ? null : JSON.stringify({ bundle, fetchedAt: Date.now() }), c: content });
      await ctx.route('**/api/**', (route) => route.abort());
      if (sc.live) {
        // Registered after the catch-all, so these win for their own paths.
        await ctx.route('**/api/kiosk/live', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LIVE) }));
        // The WHEP offer never gets an answer here: the player stays 'connecting' (no retry inside its 8 s
        // POST timeout) while the shot is taken. The pending request dies with the context.
        await ctx.route('**/api/kiosk/live/whep**', () => undefined);
      }
      await ctx.route('**/assets/*', (route) => {
        const id = new URL(route.request().url()).pathname.split('/').pop() ?? '';
        const hit = assets.get(id);
        return hit ? route.fulfill({ status: 200, contentType: hit.contentType, body: hit.body }) : route.fulfill({ status: 404, body: '' });
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      const card = sc.card ? `&card=${sc.card}` : '';
      await page.goto(`${base}/?now=${encodeURIComponent(sc.now)}${card}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.stage[data-phase]');
      await page.evaluate(() => document.fonts.ready);
      if (sc.wait) await page.waitForSelector(sc.wait, { timeout: 8000 }).catch(() => errors.push(`wait ${sc.wait} timed out`));
      if (sc.live) {
        // Let the player reach its pending POST (ICE gathering is capped at 2 s), then go on air.
        await page.waitForTimeout(2500);
        const ok = await page.evaluate((frame) => {
          const v = document.querySelector('[data-testid="live-video"]');
          if (!v) return false;
          v.setAttribute('poster', frame);
          v.dispatchEvent(new Event('playing'));
          return true;
        }, LIVE_FRAME);
        if (!ok) errors.push('live video missing');
        await page.waitForSelector('.live[data-playing="true"]', { timeout: 3000 }).catch(() => errors.push('live never on air'));
      }
      await page.waitForFunction(() => [...document.images].every((i) => i.complete));
      await page.waitForTimeout(1300);
      const file = resolve(outDir, sc.name, `${template}.png`);
      await page.screenshot({ path: file });
      const warn = await page.evaluate(AUDIT);
      const phase = await page.getAttribute('.stage', 'data-phase');
      console.log(`${sc.name}/${template} phase=${phase}${errors.length ? ` ERRORS ${errors.join(' | ')}` : ''}${warn.length ? `\n    ${warn.join('\n    ')}` : ''}`);
      await ctx.close();
    }
    done.push(sc.name);
  }
  // Contact sheets: 3 x 2 grid of 640x360 tiles with a label.
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 760 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  for (const name of done) {
    const tiles = templates.map((t) => {
      const b64 = readFileSync(resolve(outDir, name, `${t}.png`)).toString('base64');
      return `<figure><img src="data:image/png;base64,${b64}"><figcaption>${t}</figcaption></figure>`;
    }).join('');
    await page.setContent(`<style>body{margin:0;background:#222;font:600 16px system-ui;color:#fff}main{display:grid;grid-template-columns:repeat(3,640px)}figure{margin:0;position:relative}img{width:640px;height:360px;display:block}figcaption{position:absolute;left:6px;top:6px;background:#000c;padding:2px 8px;border-radius:4px}h1{position:absolute;right:16px;bottom:8px;margin:0;font-size:22px}</style><main>${tiles}</main><h1>${name} @ ${W}x${H}@${DPR}</h1>`);
    await page.waitForFunction(() => [...document.images].every((i) => i.complete));
    await page.screenshot({ path: resolve(outDir, `sheet-${name}.png`) });
  }
  await ctx.close();
} finally {
  await browser.close();
  await server.close();
}
