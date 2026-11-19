// Arabic TV screen proof (W14): every template x the main phases and the content screens with the TV language set to
// Arabic, in real Chromium (Playwright, Vite dev server, offline bundle cache, /api blocked: the same set-up as
// scripts/uiux-matrix.mjs). jsdom lays nothing out, so clipping, overflow and the right-to-left order are checked
// here. Per shot it checks:
//   - the stage is dir="rtl" lang="ar" and the phase title / card is on screen;
//   - no text is clipped by its own box by more than 4 px (a descender's overshoot), nothing leaves the stage
//     (the ticker excepted);
//   - every glyph of the Arabic text is drawn by Amiri ('MX Arabic' or 'Amiri'), never by a system fallback;
//   - in the prayer bar the first prayer sits at the right (right to left).
// Screenshots: <outDir>/<WxH@dpr>/<scenario>/<template>.png and a contact sheet per scenario. Exit code 1 on a
// failed check.
//
//   node apps/kiosk-display/test/tv-ar-shots.mjs <outDir> [scenarioFilter|-] [templates|-] [WxH@dpr,...]

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const repo = resolve(appDir, '../..');
const outRoot = resolve(process.argv[2] ?? resolve(repo, 'ui-preview/tv-ar'));
const filter = process.argv[3] && process.argv[3] !== '-' ? process.argv[3] : '';
const ALL = ['default', 'colourful', 'creative', 'oldschool', 'minimal', 'arabic'];
/** `pack-arabic` (name it in the templates argument) is an uploaded theme built on Arabic Art: it must pass the health check on an Arabic screen. */
const PACK_NAME = 'pack-arabic';
const PACK_BASE = 'arabic';
const PACKS = { [PACK_NAME]: { assetId: 'a'.repeat(64), version: 1, title: 'Pack Arabic', base: PACK_BASE, contract: 1, bytes: 1, fonts: [], screens: [], images: {}, defaults: {} } };
const templates = process.argv[4] && process.argv[4] !== '-' ? process.argv[4].split(',') : ALL;
const viewports = (process.argv[5] ?? '1920x1080@1,960x540@2').split(',').map((v) => {
  const m = /^(\d+)x(\d+)@(\d+(?:\.\d+)?)$/.exec(v);
  if (!m) throw new Error(`bad viewport ${v}`);
  return { name: v, w: Number(m[1]), h: Number(m[2]), dpr: Number(m[3]) };
});
const PORT = Number(process.env.SHOTS_PORT ?? 5187);
/** SHOTS_LANG=ms runs the same shots in Malay, to tell a problem of the Arabic screen from one the screen already had. */
const LANG = process.env.SHOTS_LANG ?? 'ar';

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
/** `main`: the selector that must be on screen (the phase title or the card). */
const SCEN = [
  { name: '01-idle', now: T, main: '.screen--main, .screen--shell' },
  { name: '02-kuliah', now: T, content: 'islamic', card: 'kuliahCard', main: '[data-card]' },
  { name: '03-pengumuman', now: T, content: 'default', card: 'pengumuman', main: '[data-card]' },
  { name: '04-hadis', now: T, content: 'islamic', card: 'hadis', main: '[data-card]' },
  { name: '05-ayat', now: T, content: 'islamic', card: 'ayatCard', main: '[data-card]' },
  { name: '06-takwim', now: T, content: 'long', card: 'takwim', main: '[data-card]' },
  { name: '07-worldtimes', now: T, content: 'islamic-long', card: 'worldTimes', main: '[data-card]' },
  { name: '08-tugasan', now: T, content: 'islamic', card: 'tugasan', main: '[data-card]' },
  { name: '09-tabung', now: T, content: 'tabung', card: 'tabungCard', main: '[data-card]' },
  { name: '10-tabung-hot', now: T, content: 'tabung-hot', card: 'tabungCard', main: '[data-card]' },
  { name: '11-programkhas', now: T, content: 'default', card: 'programKhas', main: '[data-card]' },
  { name: '12-ticker', now: '2026-11-03T11:00:00+08:00', content: 'islamic-long', card: 'none', main: '.ticker' },
  { name: '13-azan', now: '2026-11-03T16:12:00+08:00', main: '.phase__title' },
  { name: '14-azan-strip', now: '2026-11-03T16:12:00+08:00', settings: { azanCountdown: { fullScreen: false } }, main: '.phase__title' },
  { name: '15-masuk', now: '2026-11-03T16:20:10+08:00', main: '.phase__title' },
  { name: '16-iqamah', now: '2026-11-03T16:25:00+08:00', main: '.phase__title' },
  { name: '17-solat', now: '2026-11-03T16:35:00+08:00', main: '.phase__title' },
  { name: '18-khutbah', now: '2026-11-06T13:05:00+08:00', main: '.phase__title' },
  { name: '19-syuruk', now: '2026-11-03T06:52:00+08:00', settings: { syurukWarning: { enabled: true } }, main: '.phase__title' },
  { name: '20-zikir', now: '2026-11-03T16:50:00+08:00', content: 'islamic', main: '[data-layer="zikir"], .arab-zikir, [data-screen="arab-zikir"]' },
  { name: '21-emergency', now: T, content: 'islamic', card: 'pengumuman', emergency: true, main: '[data-testid="emergency-band"]' },
  { name: '22-24h-seconds', now: '2026-11-03T15:52:07+08:00', settings: { prayerBar: { timeFormat: '24h' }, clock: { showSeconds: true } }, main: '.screen--main, .screen--shell' },
  { name: '23-live', now: T, content: 'islamic', live: true, main: '[data-testid="live-video"]' },
  { name: '24-nodata', now: '2027-01-01T09:00:00+08:00', main: '.phase__title' },
];

const LIVE = { live: true, since: '2026-11-03T15:30:00+08:00', kuliah: { label: 'Kuliah Maghrib', penceramah: 'Ustaz Ahmad Fauzi bin Hassan', topic: 'Adab menuntut ilmu' }, audio: false, volume: 50 };
const LIVE_FRAME = `data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 900'><rect width='1600' height='900' fill='#a99070'/><rect y='640' width='1600' height='260' fill='#4a3420'/><rect x='560' y='60' width='480' height='420' fill='#2f5a4a'/><ellipse cx='800' cy='300' rx='70' ry='86' fill='#b98a64'/><path d='M610 900q10-420 190-470 180 50 190 470z' fill='#f2f2ee'/></svg>")}`;

/** In-page checks; returns a list of problems. */
const AUDIT = ({ mainSel, lang }) => {
  const out = [];
  const stage = document.querySelector('.stage');
  if (!stage) return ['no stage'];
  if (lang === 'ar' && (stage.getAttribute('dir') !== 'rtl' || stage.getAttribute('lang') !== 'ar')) out.push(`stage dir=${stage.getAttribute('dir')} lang=${stage.getAttribute('lang')}`);
  const vw = innerWidth;
  const vh = innerHeight;
  const vis = (el) => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05 && el.getClientRects().length > 0; };
  const name = (el) => `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 2).join('.')}`;
  const main = [...document.querySelectorAll(mainSel)].filter(vis);
  if (main.length === 0) out.push(`missing ${mainSel}`);
  for (const el of document.querySelectorAll('.stage *')) {
    if (!vis(el)) continue;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (el.closest('.ticker__strip, .bg, [data-layer="live"], .deco')) continue;
    const clips = s.overflow !== 'visible' || s.overflowX !== 'visible' || s.overflowY !== 'visible';
    if (clips && s.textOverflow !== 'ellipsis' && (el.scrollWidth > el.clientWidth + 4 || el.scrollHeight > el.clientHeight + 4) && el.textContent.trim() && el.children.length === 0) {
      out.push(`clip ${name(el)} ${el.scrollWidth}x${el.scrollHeight}>${el.clientWidth}x${el.clientHeight} "${el.textContent.trim().slice(0, 30)}"`);
    }
    if (r.right > vw + 1 || r.bottom > vh + 1 || r.left < -1 || r.top < -1) {
      if (!el.closest('.ticker')) out.push(`offstage ${name(el)} ${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}`);
    }
  }
  // Prayer bar order: the first cell is to the right of the last one.
  const cells = [...document.querySelectorAll('.pbar .pcell, .strip .pcell')].filter(vis);
  // (a bar laid out as one row; a column of bars, Creative's and Old School's, reads top to bottom)
  const r0 = cells[0]?.getBoundingClientRect();
  const rN = cells[cells.length - 1]?.getBoundingClientRect();
  if (cells.length > 1 && Math.abs(r0.top - rN.top) < r0.height / 2 && r0.left < rN.left) out.push('prayer bar left to right');
  return [...new Set(out)].slice(0, 14);
};

/** The fonts that drew the Arabic letters (CDP: platform fonts per text node). */
async function arabicFonts(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: false });
  const bad = new Set();
  const seen = new Set();
  const walk = async (n) => {
    const texts = (n.children ?? []).filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join('');
    if (n.nodeType === 1 && /[؀-ۿ]/.test(texts)) {
      // A node with Arabic letters only (no Latin letters or digits) must be drawn by an Arabic face we bundle; a
      // mixed node may also use the theme's Latin font, but never a system font standing in for Arabic.
      // The Latin font may draw what is not an Arabic letter (spaces, Latin letters, digits, punctuation).
      // The font list covers the text of the whole subtree, so the count does too.
      const deep = (m) => (m.nodeType === 3 ? m.nodeValue : (m.children ?? []).map(deep).join(''));
      const others = [...deep(n)].filter((c) => !/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/.test(c)).length;
      try {
        const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: n.nodeId });
        let latinGlyphs = 0;
        for (const f of fonts) {
          seen.add(f.familyName);
          const bundled = /amiri|qpc|hafs|harakat/i.test(f.familyName);
          const latin = /^plus jakarta sans|^mxf-/i.test(f.familyName);
          if (latin) latinGlyphs += f.glyphCount;
          else if (!bundled) bad.add(`${f.familyName} ("${texts.trim().slice(0, 20)}")`);
        }
        if (latinGlyphs > others) bad.add(`Latin font for Arabic letters ("${texts.trim().slice(0, 20)}")`);
      } catch { /* node gone */ }
    }
    for (const c of n.children ?? []) await walk(c);
  };
  await walk(root);
  await cdp.detach();
  return { seen: [...seen], bad: [...bad] };
}

let failed = 0;
const server = await createServer({ configFile: resolve(appDir, 'vite.config.ts'), root: appDir, logLevel: 'warn', server: { port: PORT, strictPort: true, host: '127.0.0.1' } });
await server.listen();
const base = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch();
try {
  for (const vp of viewports) {
    const outDir = resolve(outRoot, vp.name.replace('@', '_'));
    const done = [];
    for (const sc of SCEN) {
      if (filter && !sc.name.includes(filter)) continue;
      mkdirSync(resolve(outDir, sc.name), { recursive: true });
      for (const template of templates) {
        const settings = core.resolveSettings({
          surauInfo: { name: 'Surau Al-Hidayah' },
          language: { lang: LANG },
          ...(sc.live ? { liveOnKiosk: { enabled: true } } : {}),
          ...(sc.settings ?? {}),
          kioskTemplate: { templateId: template },
          ...(template === PACK_NAME ? { themeStyle: { styles: {}, packs: PACKS } } : {}),
        });
        const bundle = { version: 1, zone: 'SGR01', days: daysFor(sc.emergency === true), settings, serverTime: new Date().toISOString() };
        const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: vp.dpr });
        const content = sc.content ? JSON.stringify({ content: makeContent(assetIds, sc.content), fetchedAt: Date.now() }) : null;
        await ctx.addInitScript(({ b, c }) => {
          localStorage.setItem('surau.bundle', b);
          if (c) localStorage.setItem('surau.content', c); else localStorage.removeItem('surau.content');
        }, { b: JSON.stringify({ bundle, fetchedAt: Date.now() }), c: content });
        await ctx.route('**/api/**', (route) => route.abort());
        if (sc.live) {
          await ctx.route('**/api/kiosk/live', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LIVE) }));
          await ctx.route('**/api/kiosk/live/whep**', () => undefined);
        }
        if (template === PACK_NAME) await ctx.route(`**/themes/${PACK_NAME}/**/bundle.css`, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '/* a pack that restyles nothing */' }));
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
        await page.waitForSelector(sc.main, { timeout: 8000 }).catch(() => errors.push(`wait ${sc.main} timed out`));
        if (sc.live) {
          await page.waitForTimeout(2500);
          await page.evaluate((frame) => {
            const v = document.querySelector('[data-testid="live-video"]');
            if (!v) return;
            v.setAttribute('poster', frame);
            v.dispatchEvent(new Event('playing'));
          }, LIVE_FRAME);
          await page.waitForSelector('.live[data-playing="true"]', { timeout: 3000 }).catch(() => errors.push('live never on air'));
        }
        await page.waitForFunction(() => [...document.images].every((i) => i.complete));
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(1300);
        await page.screenshot({ path: resolve(outDir, sc.name, `${template}.png`) });
        const warn = await page.evaluate(AUDIT, { mainSel: sc.main, lang: LANG });
        if (template === PACK_NAME) {
          await page.waitForTimeout(3500); // past the health check's recheck
          const st = await page.evaluate(() => {
            const stage = document.querySelector('.stage');
            const shown = [...document.querySelectorAll('.pcell__label, .chip-k')].filter((e) => getComputedStyle(e).display === 'none').length;
            return { pack: stage?.getAttribute('data-pack'), theme: stage?.getAttribute('data-theme'), hiddenMust: shown };
          });
          if (st.pack !== 'ready' || st.theme !== PACK_NAME) warn.push(`the pack was dropped (data-pack=${st.pack} data-theme=${st.theme})`);
          if (st.hiddenMust > 0) warn.push(`${st.hiddenMust} data-must part(s) hidden with display:none on the pack`);
        }
        const fonts = await arabicFonts(page);
        if (fonts.bad.length) warn.push(`arabic drawn by ${fonts.bad.join(', ')}`);
        const phase = await page.getAttribute('.stage', 'data-phase');
        const problems = [...errors, ...warn];
        if (problems.length) failed++;
        console.log(`${vp.name} ${sc.name}/${template} phase=${phase} fonts=${fonts.seen.join('|')}${problems.length ? `\n    ${problems.join('\n    ')}` : ''}`);
        await ctx.close();
      }
      done.push(sc.name);
    }
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 760 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    for (const name of done) {
      const tiles = templates.map((t) => {
        const b64 = readFileSync(resolve(outDir, name, `${t}.png`)).toString('base64');
        return `<figure><img src="data:image/png;base64,${b64}"><figcaption>${t}</figcaption></figure>`;
      }).join('');
      await page.setContent(`<style>body{margin:0;background:#222;font:600 16px system-ui;color:#fff}main{display:grid;grid-template-columns:repeat(3,640px)}figure{margin:0;position:relative}img{width:640px;height:360px;display:block}figcaption{position:absolute;left:6px;top:6px;background:#000c;padding:2px 8px;border-radius:4px}h1{position:absolute;right:16px;bottom:8px;margin:0;font-size:22px}</style><main>${tiles}</main><h1>${name} ar @ ${vp.name}</h1>`);
      await page.waitForFunction(() => [...document.images].every((i) => i.complete));
      await page.screenshot({ path: resolve(outDir, `sheet-${name}.png`) });
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(failed ? `${failed} shot(s) with problems` : 'all shots clean');
process.exit(failed ? 1 : 0);
