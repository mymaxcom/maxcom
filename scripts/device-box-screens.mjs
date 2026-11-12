// Device test for the box's own screens on a real TV box (WebView), without touching the box's data:
// the kiosk's fetch of /api/box/state is answered in-page with a simulated setup/recovery/locked view, then the
// language switch is clicked with real CDP mouse events and each result is captured with adb screencap.
//
//   node scripts/device-box-screens.mjs <cdpPort> <adbSerial> <outDir>
//
// Before: adb -s <adbSerial> forward tcp:<cdpPort> localabstract:webview_devtools_remote_<pid>
// After:  adb -s <adbSerial> forward --remove tcp:<cdpPort>   (the script does not remove the forward itself)
//
// Defaults: cdpPort 9333; adbSerial 10.168.1.26:5555 is a placeholder, pass your own
// box's serial (`adb devices`). The box id, box URL and names inside the simulated views are fake on purpose
// (documentation address 192.0.2.10, an all-f0 id); nothing is sent to the box's own API.
//
// Undo, always (normal end, any error, Ctrl+C / SIGTERM): the box-screen language the page had before
// (localStorage 'mx-box-lang', restored or removed as it was) and a reload of the page, which drops the in-page
// fetch override. If the reload cannot be sent, the script says so and how to reset the page by hand.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [port = '9333', serial = '10.168.1.26:5555', outDir = resolve(repo, 'ui-preview/device-box-screens')] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const core = await import(pathToFileURL(resolve(repo, 'packages/core/src/index.ts')).href);

const SEND_TIMEOUT_MS = 15000;
const LANG_KEY = 'mx-box-lang';
const APP_ID = 'my.maxcom.box';

const pub = { kty: 'EC', crv: 'P-256', x: 'a'.repeat(43), y: 'b'.repeat(43) };
const KEY_FP = core.keyFingerprint(pub);
const BOX_ID = 'f0f0f0f0f0f0f0f0';
const BOX_URL = 'https://192.0.2.10:8443';
const iat = Math.floor(Date.now() / 1000);
const qr = (type, over = {}) => core.encodeBoxQr({ v: 1, type, boxId: BOX_ID, keyFp: KEY_FP, name: 'MAXCOM F0F0', box: BOX_URL, caSha256: 'c'.repeat(64), linked: false, nonce: 'n'.repeat(43), iat, exp: iat + 600, pub, sig: 's'.repeat(86), ...over });
const exp = new Date(Date.now() + 540_000).toISOString();
const view = (over) => ({ boxId: BOX_ID, keyFp: KEY_FP, pub, name: 'MAXCOM F0F0', state: 'setup', reason: 'none', linked: false, https: true, caSha256: 'c'.repeat(64), serverTime: new Date().toISOString(), surauName: null, appDownloadUrl: '', ...over });
const VIEWS = {
  setup: view({ qr: { payload: qr('setup'), expiresAt: exp } }),
  recovery: view({ state: 'recovery', reason: 'no_admin', linked: true, surauName: 'Surau Ujian', name: 'MAXCOM TEST', recoveryCodeSet: true, qr: { payload: qr('recovery', { linked: true }), expiresAt: exp } }),
  locked: view({ state: 'locked' }),
};

const log = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The kiosk page: the WebView loads the box's own kiosk from loopback. Prefer that page over any other target
// (a second WebView, an about:blank); fall back to the first page only with a warning in the log.
const isLoopback = (url) => {
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
  } catch {
    return false;
  }
};
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
const target = pages.find((t) => isLoopback(t.url)) ?? pages[0];
if (!target) throw new Error(`no debuggable page on CDP port ${port}`);
if (!isLoopback(target.url)) log.push(`WARNING: no loopback kiosk page found; using ${target.url}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('CDP websocket failed to open')); });
let id = 0;
let wsDead = false;
/** id -> { resolve, reject, timer } */
const waiting = new Map();
const failAll = (why) => {
  wsDead = true;
  for (const [, w] of waiting) { clearTimeout(w.timer); w.reject(new Error(why)); }
  waiting.clear();
};
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  const w = waiting.get(d.id);
  if (!w) return;
  waiting.delete(d.id);
  clearTimeout(w.timer);
  if (d.error) w.reject(new Error(`${d.error.message ?? 'CDP error'} (${d.error.code ?? '?'})`));
  else w.resolve(d);
};
ws.onclose = () => failAll('CDP websocket closed');
ws.onerror = () => failAll('CDP websocket error');
const send = (method, params = {}, ms = SEND_TIMEOUT_MS) => new Promise((resolveSend, rejectSend) => {
  if (wsDead || ws.readyState !== WebSocket.OPEN) { rejectSend(new Error(`CDP not open (${method})`)); return; }
  const i = ++id;
  const timer = setTimeout(() => {
    if (!waiting.has(i)) return;
    waiting.delete(i);
    rejectSend(new Error(`CDP ${method} timed out after ${ms} ms`));
  }, ms);
  waiting.set(i, { resolve: resolveSend, reject: rejectSend, timer });
  try {
    ws.send(JSON.stringify({ id: i, method, params }));
  } catch (e) {
    waiting.delete(i);
    clearTimeout(timer);
    rejectSend(e);
  }
});
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const shot = (name) => {
  const png = execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 });
  writeFileSync(resolve(outDir, `${name}.png`), png);
};
const mouseAt = async (c) => {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
  }
};
const centreOf = (findExpr) => ev(`(()=>{const e=${findExpr};if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
const click = async (selector) => {
  const c = await centreOf(`document.querySelector(${JSON.stringify(selector)})`);
  if (!c) return false;
  await mouseAt(c);
  return true;
};
const clickLabel = async (re) => {
  const c = await centreOf(`[...document.querySelectorAll('.langswitch button, .langswitch [role=radio]')].find(x=>${re}.test(x.textContent.trim()))`);
  if (!c) return false;
  await mouseAt(c);
  return true;
};
const install = async (v) => {
  await ev(`(()=>{window.__mxView=${JSON.stringify(JSON.stringify(v))};if(!window.__mxFetch){window.__mxFetch=window.fetch;window.fetch=function(u,o){const s=String(u&&u.url||u);if(window.__mxView&&s.indexOf('/api/box/state')>=0){return Promise.resolve(new Response(window.__mxView,{status:200,headers:{'content-type':'application/json'}}))}return window.__mxFetch.apply(this,arguments)}}return 'ok'})()`);
};
const waitFor = async (selector, ms = 40000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ev(`!!document.querySelector(${JSON.stringify(selector)})`)) return true; await sleep(1000); }
  return false;
};
const probe = () => ev(`JSON.stringify({lang:document.querySelector('[data-box-lang]')?.getAttribute('data-box-lang')??document.documentElement.lang,dir:document.querySelector('[dir=rtl]')?'rtl':'ltr',amiri:document.fonts.check('24px Amiri','عربي'),switch:!!document.querySelector('.langswitch'),logo:!!document.querySelector('.screen img[src*=maxcom], .box-brand img, [class*=logo] img, img[alt*=MAXCOM]'),stored:(()=>{try{return localStorage.getItem(${JSON.stringify(LANG_KEY)})}catch(e){return 'ERR'}})()})`);

// What the page had before the run: { ok: true, value: string | null } or { ok: false } when it cannot be read.
let before = { ok: false };
let cleaned = false;
async function cleanup(reason) {
  if (cleaned) return;
  cleaned = true;
  log.push(`cleanup (${reason})`);
  try {
    if (before.ok) {
      const expr = before.value === null
        ? `(()=>{try{localStorage.removeItem(${JSON.stringify(LANG_KEY)});return 'removed'}catch(e){return 'ERR '+e}})()`
        : `(()=>{try{localStorage.setItem(${JSON.stringify(LANG_KEY)},${JSON.stringify(before.value)});return 'restored'}catch(e){return 'ERR '+e}})()`;
      log.push(`language: ${await ev(expr)} (${before.value === null ? 'none set before' : `was ${before.value}`})`);
    } else {
      log.push(`language: NOT restored, the value before the run could not be read; check '${LANG_KEY}' on the box screens`);
    }
  } catch (e) {
    log.push(`language: NOT restored (${e.message}); before the run it was ${before.ok ? JSON.stringify(before.value) : 'unknown'}`);
  }
  try {
    await send('Page.reload', {}, 5000);
    await sleep(1500);
    log.push('page reloaded (simulated box state removed)');
  } catch (e) {
    log.push(`RELOAD FAILED (${e.message}): the kiosk page on ${serial} may still show the SIMULATED box state.`);
    log.push(`  Reset it by hand: open chrome://inspect on this PC and reload the page, or restart the app:`);
    log.push(`  adb -s ${serial} shell am force-stop ${APP_ID}   then start MAXCOM again on the box`);
    log.push(`  (am start alone brings the running page to the front and does not reload it).`);
  }
  try { ws.close(); } catch { /* closed */ }
  try {
    writeFileSync(resolve(outDir, 'log.txt'), log.join('\n') + '\n');
  } catch (e) {
    console.error(`could not write log.txt: ${e.message}`);
  }
  console.log(log.join('\n'));
  console.log(`\nRemember: adb -s ${serial} forward --remove tcp:${port}`);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    void cleanup(sig).finally(() => process.exit(130));
  });
}

let failed = null;
try {
  const read = await ev(`(()=>{try{return {ok:true,value:localStorage.getItem(${JSON.stringify(LANG_KEY)})}}catch(e){return {ok:false}}})()`);
  if (read && read.ok === true && (read.value === null || typeof read.value === 'string')) before = { ok: true, value: read.value };
  log.push(`language before the run: ${before.ok ? JSON.stringify(before.value) : 'unreadable'}`);
  await ev(`(()=>{try{localStorage.removeItem(${JSON.stringify(LANG_KEY)})}catch(e){}return 1})()`);
  await install(VIEWS.setup);
  const ok = await waitFor('.langswitch');
  log.push(`setup screen appeared: ${ok}`);
  await sleep(2500);
  shot('setup-ms'); log.push(`setup-ms ${await probe()}`);
  for (const [lang, label] of [['en', 'EN'], ['ar', 'عربي']]) {
    let clicked = await click(`.langswitch [data-lang='${lang}'], .langswitch button[lang='${lang}']`);
    if (!clicked) clicked = await clickLabel(`new RegExp(${JSON.stringify(`^${label}$`)})`);
    await sleep(2500);
    shot(`setup-${lang}-clicked`); log.push(`click ${lang}: ${clicked} ${await probe()}`);
  }
  // Persistence across a reload of the page (override re-installed after reload).
  await send('Page.reload', {});
  await sleep(6000);
  await install(VIEWS.setup);
  await waitFor('.langswitch');
  await sleep(2500);
  shot('setup-after-reload'); log.push(`after reload ${await probe()}`);
  for (const name of ['recovery', 'locked']) {
    await ev(`window.__mxView=${JSON.stringify(JSON.stringify(VIEWS[name]))}`);
    await sleep(16000);
    shot(`${name}-ar`); log.push(`${name} ${await probe()}`);
  }
  // Back to BM by click, then capture setup in BM.
  await ev(`window.__mxView=${JSON.stringify(JSON.stringify(VIEWS.setup))}`);
  await waitFor('.langswitch');
  await sleep(1500);
  await clickLabel('/^BM$/');
  await sleep(2500);
  shot('setup-back-ms'); log.push(`back to ms ${await probe()}`);
} catch (e) {
  failed = e;
  log.push(`ERROR: ${e && e.stack ? e.stack : e}`);
} finally {
  await cleanup(failed ? 'error' : 'done');
}
if (failed) process.exitCode = 1;
