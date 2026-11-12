// NOTE: these shots are drawn by the current Chromium that Playwright ships, not by the T95's Chrome 91 WebView.
// They show layout and content; they are not proof of how Chrome 91 renders (outlines, `gap`, newer CSS).
//
// Proof shots for the box's own screens in their three languages (BM, English, Arabic): setup, recovery (no
// Pentadbir, damaged database), stopped, pairing (code, unreachable) and the network check, at the T95's real
// WebView viewport (960x540 CSS px at DPR 2) and at 1920x1080. Then the switch itself: a click on عربي, a reload
// (the choice must persist), and the remote (arrows + Enter) choosing English.
//
//   node scripts/box-screens-shots.mjs [outDir] [filter]
//
// Same method as ui-preview.mjs / uiux-matrix.mjs: Vite dev server (port 5184), Playwright, seeded bundle cache,
// every /api route mocked or aborted. Prints one line per shot with layout warnings and fails on a wrong state.

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const appDir = resolve(repo, 'apps/kiosk-display');
const outDir = resolve(process.argv[2] ?? resolve(repo, 'ui-preview/box-screens'));
const filter = process.argv[3] ?? '';
const PORT = 5184;

const core = await import(pathToFileURL(resolve(repo, 'packages/core/src/index.ts')).href);
const days = core.parseJakimCsv(readFileSync(resolve(repo, 'packages/core/test/fixtures/SGR01-2026.csv'), 'utf8'));

const NOW = '2026-11-03T15:52:00+08:00';
const pub = { kty: 'EC', crv: 'P-256', x: 'a'.repeat(43), y: 'b'.repeat(43) };
const KEY_FP = core.keyFingerprint(pub);
const BOX_ID = '0d2b30446ad1add2';

/** A payload the kiosk's strict parser accepts (the kiosk never checks the signature). */
function qrPayload(type, over = {}) {
  const iat = Math.floor(Date.now() / 1000);
  return core.encodeBoxQr({
    v: 1, type, boxId: BOX_ID, keyFp: KEY_FP, name: 'MAXCOM 0D2B', box: 'https://10.168.1.20:8443', caSha256: 'c'.repeat(64),
    linked: false, nonce: 'n'.repeat(43), iat, exp: iat + 600, pub, sig: 's'.repeat(86), ...over,
  });
}
function boxView(over = {}) {
  return {
    boxId: BOX_ID, keyFp: KEY_FP, pub, name: 'MAXCOM 0D2B', state: 'setup', reason: 'none', linked: false, https: true,
    caSha256: 'c'.repeat(64), serverTime: new Date().toISOString(), surauName: null, appDownloadUrl: '', ...over,
  };
}
const expiresAt = () => new Date(Date.now() + 537_000).toISOString();
const NET = (probe) => ({
  interfaces: [{ name: 'Ethernet', address: '10.168.1.20', up: true }, { name: 'vEthernet (WSL)', address: '172.20.0.1', up: true }],
  https: { listening: true, port: 8443 },
  linked: false,
  lastPull: null,
  lastPhoneSeenAt: null,
  probe: { payload: probe, expiresAt: expiresAt() },
});

/** @type {{ name: string; box?: () => object; pair?: 'ok' | 'error'; netcheck?: boolean; settings?: object }[]} */
const SCREENS = [
  { name: 'setup', box: () => boxView({ qr: { payload: qrPayload('setup'), expiresAt: expiresAt() } }) },
  { name: 'setup-nocert', box: () => boxView({ https: false, appDownloadUrl: 'https://mymaxcom.my/app', qr: { payload: qrPayload('setup', { box: '', caSha256: null }), expiresAt: expiresAt() } }) },
  { name: 'recovery', settings: { surauInfo: { name: 'Surau D\'Waqaf' } }, box: () => boxView({ state: 'recovery', reason: 'no_admin', linked: true, surauName: 'Surau D\'Waqaf', name: 'MAXCOM Dewan Utama', recoveryCodeSet: true, qr: { payload: qrPayload('recovery', { linked: true }), expiresAt: expiresAt() } }) },
  { name: 'recovery-damaged', box: () => boxView({ state: 'recovery', reason: 'db_damaged', linked: false, surauName: 'Surau D\'Waqaf' }) },
  { name: 'locked', box: () => boxView({ state: 'locked' }) },
  { name: 'pair', pair: 'ok', settings: { surauInfo: { name: 'Surau Al-Hidayah' } } },
  { name: 'pair-error', pair: 'error' },
  { name: 'netcheck', netcheck: true, box: () => boxView({ qr: { payload: qrPayload('setup'), expiresAt: expiresAt() } }) },
];
const LANGS = ['ms', 'en', 'ar'];
const VIEWPORTS = [
  { tag: '960x540@2', width: 960, height: 540, dpr: 2 },
  { tag: '1920x1080@1', width: 1920, height: 1080, dpr: 1 },
];

/** Text clipped by its own box, boxes off the stage, and the header crowding the QR card or itself. */
const AUDIT = () => {
  const out = [];
  const vw = innerWidth;
  const vh = innerHeight;
  const vis = (el) => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05 && el.getClientRects().length > 0; };
  const name = (el) => `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 2).join('.')}`;
  // With the network check open, only the check is on screen: audit it alone.
  const root = document.querySelector('.netcheck') ?? document.querySelector('.stage');
  for (const el of root.querySelectorAll('*')) {
    if (!vis(el) || el.closest('.bg, .pbar')) continue;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const clips = s.overflow !== 'visible' || s.overflowX !== 'visible' || s.overflowY !== 'visible';
    if (clips && (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2) && el.textContent.trim()) {
      out.push(`clip ${name(el)} "${el.textContent.trim().slice(0, 40)}"`);
    }
    if (r.right > vw + 1 || r.bottom > vh + 1 || r.left < -1 || r.top < -1) out.push(`offstage ${name(el)} ${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}`);
  }
  const boxes = ['.box-brandrow', '.langswitch', '[data-role="clock"]', '.qrcard', '.box-body', '.box-foot', '.pair__centre .pair__title', '.ident', '.box-corner', '.netcheck__keys', '.netcheck__body', '.pbar']
    .flatMap((q) => [...root.querySelectorAll(q)].filter(vis).map((el) => ({ q, el, r: el.getBoundingClientRect() })));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].r;
      const b = boxes[j].r;
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (boxes[i].el.contains(boxes[j].el) || boxes[j].el.contains(boxes[i].el)) continue;
      if (ox > 1 && oy > 1) out.push(`overlap ${boxes[i].q} x ${boxes[j].q} ${Math.round(ox)}x${Math.round(oy)}`);
    }
  }
  // The language switch must keep clear air from the clock and the QR card.
  const sw = root.querySelector('.langswitch');
  for (const q of ['[data-role="clock"]', '.qrcard', '.box-brandrow']) {
    const o = root.querySelector(q);
    if (!sw || !o || !vis(o)) continue;
    const a = sw.getBoundingClientRect();
    const b = o.getBoundingClientRect();
    const gapX = Math.max(b.left - a.right, a.left - b.right);
    const gapY = Math.max(b.top - a.bottom, a.top - b.bottom);
    if (Math.max(gapX, gapY) < 8) out.push(`crowded switch~${q} gap ${Math.round(Math.max(gapX, gapY))}px`);
  }
  return [...new Set(out)].slice(0, 12);
};

async function stageContext(browser, vp, sc, initLang) {
  const settings = core.resolveSettings(sc.settings ?? {});
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr });
  const bundle = sc.pair ? null : JSON.stringify({ bundle: { version: 1, zone: 'SGR01', days, settings, serverTime: new Date().toISOString() }, fetchedAt: Date.now() });
  await ctx.addInitScript(({ b, lang }) => {
    if (b) localStorage.setItem('surau.bundle', b); else localStorage.removeItem('surau.bundle');
    localStorage.removeItem('surau.content');
    if (lang) localStorage.setItem('mx-box-lang', lang);
  }, { b: bundle, lang: initLang });
  await ctx.route('**/api/**', (route) => route.abort());
  if (sc.box) {
    const view = sc.box();
    await ctx.route('**/api/box/state', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(view) }));
  }
  if (sc.netcheck) {
    const net = NET(qrPayload('probe'));
    await ctx.route('**/api/box/netcheck', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(net) }));
  }
  if (sc.pair) {
    await ctx.route('**/api/kiosk/bundle', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"errors":["unpaired"]}' }));
    await ctx.route('**/api/box/info', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"name":"MAXCOM Dewan Utama"}' }));
    if (sc.pair === 'ok') {
      await ctx.route('**/api/kiosk/pair/begin', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: '482913', pollToken: 'p', expiresAt: new Date(Date.now() + 581_000).toISOString() }) }));
      await ctx.route('**/api/kiosk/pair/poll', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"pending"}' }));
    }
  }
  return ctx;
}

async function settle(page, sc) {
  await page.waitForSelector('.stage[data-phase]');
  const want = sc.pair ? '.screen--pair' : sc.name.startsWith('locked') ? '.screen--locked' : sc.name.startsWith('recovery') ? '.screen--recovery' : '.screen--setup';
  await page.waitForSelector(want, { timeout: 10_000 });
  if (sc.pair === 'ok') await page.waitForSelector('.screen--pair [data-code]', { timeout: 10_000 });
  if (sc.pair === 'error') await page.waitForSelector('.screen--pair[data-state="error"]', { timeout: 15_000 });
  if (sc.netcheck) {
    // A mouse click on the button: proves the pointer path, not just the remote.
    await page.click('.box-foot .tvbtn');
    await page.waitForSelector('.netcheck .netcheck__rows', { timeout: 10_000 });
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await page.waitForTimeout(900);
}

const report = (file, warn, extra = '') => console.log(`${file}${extra}${warn.length ? `\n    ${warn.join('\n    ')}` : ''}`);

mkdirSync(outDir, { recursive: true });
const server = await createServer({ configFile: resolve(appDir, 'vite.config.ts'), root: appDir, logLevel: 'warn', server: { port: PORT, strictPort: true, host: '127.0.0.1' } });
await server.listen();
const base = `http://127.0.0.1:${PORT}`;
const url = `${base}/?now=${encodeURIComponent(NOW)}`;
const browser = await chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    for (const sc of SCREENS) {
      if (filter && !sc.name.includes(filter)) continue;
      for (const lang of LANGS) {
        const ctx = await stageContext(browser, vp, sc, lang);
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        try {
          await settle(page, sc);
        } catch (e) {
          errors.push(String(e).split('\n')[0]);
          process.exitCode = 1;
        }
        const file = `${sc.name}-${lang}-${vp.tag}.png`;
        await page.screenshot({ path: resolve(outDir, file) });
        const seen = await page.evaluate(() => ({
          pressed: document.querySelector('.langswitch__opt[aria-pressed="true"]')?.getAttribute('data-lang') ?? null,
          amiri: document.fonts.check('700 20px Amiri', 'عربي'),
        }));
        if (seen.pressed !== lang) process.exitCode = 1;
        report(file, await page.evaluate(AUDIT), `  switch=${seen.pressed} amiri=${seen.amiri}${errors.length ? `  ERRORS ${errors.join(' | ')}` : ''}`);
        await ctx.close();
      }
    }
  }

  // The switch: nothing stored, a click on عربي, a reload, then the remote picks English.
  // Same rule as the screen shots (the name contains the filter), plus a filter that names one of the switch shots.
  if (!filter || 'switch'.includes(filter) || filter.startsWith('switch')) {
    const vp = VIEWPORTS[0];
    const sc = SCREENS[0];
    const ctx = await stageContext(browser, vp, sc, null);
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await settle(page, sc);
    const steps = [];
    const lang = () => page.evaluate(() => ({
      pressed: document.querySelector('.langswitch__opt[aria-pressed="true"]')?.getAttribute('data-lang'),
      dir: document.querySelector('.box-body')?.getAttribute('dir'),
      title: document.querySelector('.box-title')?.textContent,
      stored: (() => { try { return localStorage.getItem('mx-box-lang'); } catch { return 'n/a'; } })(),
      focus: document.querySelector('.is-focused')?.textContent,
    }));
    steps.push(['start', await lang()]);
    await page.mouse.move(700, 40);
    await page.click('.langswitch__opt[data-lang="ar"]');
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(outDir, 'switch-1-after-click-ar.png') });
    steps.push(['click ar', await lang()]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page, sc);
    await page.screenshot({ path: resolve(outDir, 'switch-2-after-reload.png') });
    steps.push(['reload', await lang()]);
    // Remote: up to the switch (lands on عربي), left to EN, OK.
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(200);
    await page.screenshot({ path: resolve(outDir, 'switch-3-remote-focus-en.png') });
    steps.push(['remote focus', await lang()]);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(outDir, 'switch-4-remote-ok-en.png') });
    steps.push(['remote ok', await lang()]);
    // Down back to the button; OK opens the network check as before.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const opened = await page.waitForSelector('.netcheck', { timeout: 5000 }).then(() => true, () => false);
    steps.push(['down + ok', { netcheck: opened }]);
    for (const [k, v] of steps) console.log(`switch ${k}: ${JSON.stringify(v)}`);
    const ok = steps[1][1].pressed === 'ar' && steps[1][1].stored === 'ar' && steps[2][1].pressed === 'ar' && steps[2][1].dir === 'rtl'
      && steps[3][1].focus === 'EN' && steps[4][1].pressed === 'en' && opened;
    console.log(ok ? 'switch proof: OK' : 'switch proof: FAILED');
    if (!ok) process.exitCode = 1;
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.close();
}
