// End-to-end proof on the laptop: the real box server (temp database and data folder, port 8799),
// the built kiosk, seeded demo content and Chromium. Everything that writes goes through the real HTTP
// API as a signed-in admin (device client: enrol, unlock, authedFetch), exactly as the app does.
//
//   node scripts/proof-screens.mjs             build the kiosk, then run everything
//   node scripts/proof-screens.mjs --no-build  reuse apps/kiosk-display/dist
//
// Writes screenshots to proof/ and proof/content/ (gitignored). Every step asserts text on screen.
// Exits 1 on any failure. Needs the run date to be in 2026 (the prayer fixture is SGR01-2026).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { bootstrapAdmin, klToday, seedContent, signInAdmin, weekdayOf } from './seed-content.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const distDir = resolve(repo, 'apps/kiosk-display/dist');
const outDir = resolve(repo, 'proof');
const PORT = 8799;
const HOST = '127.0.0.1';
const base = `http://${HOST}:${PORT}`;
const noBuild = process.argv.includes('--no-build');

/** @type {{ name: string; file: string; ok: boolean; detail: string }[]} */
const results = [];
function record(name, file, ok, detail = '') {
  results.push({ name, file, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (now, extra = '') => `${base}/?now=${encodeURIComponent(now)}&proof=1${extra}`;

// ---- the day under test: today in Kuala Lumpur (the box filters content by its own clock) -------------
const TODAY = klToday();
if (!TODAY.startsWith('2026')) {
  console.error(`FAIL run: the prayer fixture covers 2026 only and today (KL) is ${TODAY}`);
  process.exit(1);
}
const core = await import(pathToFileURL(resolve(repo, 'packages/core/src/index.ts')).href);
const fixtureCsv = readFileSync(resolve(repo, 'packages/core/test/fixtures/SGR01-2026.csv'), 'utf8');
const fixtureDays = core.parseJakimCsv(fixtureCsv);
const dayRow = (date) => fixtureDays.find((d) => d.date === date);
const todayRow = dayRow(TODAY);
if (!todayRow) {
  console.error(`FAIL run: no prayer times for ${TODAY} in the fixture`);
  process.exit(1);
}

/** 'HH:mm' (+ seconds) shifted by whole minutes, as an ISO instant string with +08:00. */
function at(date, hhmm, plusMinutes = 0, plusSeconds = 0) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 3600 + m * 60 + plusMinutes * 60 + plusSeconds;
  const p = (n) => String(n).padStart(2, '0');
  return `${date}T${p(Math.floor(total / 3600))}:${p(Math.floor((total % 3600) / 60))}:${p(total % 60)}+08:00`;
}
// Friday on or after today, for the khutbah screen (within the 40 day window the bundle carries).
let friday = TODAY;
for (let i = 0; i < 7 && weekdayOf(friday) !== 5; i++) {
  const [y, mo, d] = friday.split('-').map(Number);
  friday = new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10);
}
const fridayRow = dayRow(friday);
if (!fridayRow) {
  console.error(`FAIL run: no prayer times for Friday ${friday} in the fixture`);
  process.exit(1);
}
const asar = todayRow.times.asar;
const NORMAL = at(TODAY, asar, -28); // like 15:52 when Asar is 16:20
const T = {
  normal: NORMAL,
  azan: at(TODAY, asar, -8),
  masuk: at(TODAY, asar, 0, 10),
  iqamah: at(TODAY, asar, 5),
  solat: at(TODAY, asar, 15),
  zikirFirst: at(TODAY, asar, 25, 10), // the solat ends at Asar + 10 + 15; zikir window opens then
  syuruk: at(TODAY, todayRow.times.syuruk, -3),
  khutbah: at(friday, fridayRow.times.zohor, 5),
};

const SHOTS = [
  { name: 'normal', now: T.normal, has: ['Asar dalam'] },
  { name: 'azanCountdown', now: T.azan, has: ['Azan Asar dalam'], noContent: true },
  { name: 'masukWaktu', now: T.masuk, has: ['Telah masuk waktu Asar'], noContent: true },
  { name: 'iqamah', now: T.iqamah, has: ['Iqamah dalam'], noContent: true },
  { name: 'solat', now: T.solat, has: ['Solat sedang didirikan'], noContent: true },
  { name: 'syuruk', now: T.syuruk, has: ['Syuruk dalam'], noContent: true },
  { name: 'khutbah', now: T.khutbah, has: ['Khutbah Jumaat'], noContent: true },
  { name: 'noData', now: '2027-01-01T09:00:00+08:00', has: ['Data waktu solat tiada'], noClock: true },
  { name: 'normal-1366', now: T.normal, has: ['Asar dalam'], w: 1366, h: 768 },
];

// ---- live layer (Plan 5 Task 6) -------------------------------------------------------------------
const LIVE = {
  live: true,
  since: `${TODAY}T11:35:00.000Z`,
  kuliah: { label: 'Kuliah Maghrib', penceramah: 'Ustaz Ahmad Fauzi', topic: 'Bab Ikhlas dan Niat' },
  audio: false,
  volume: 50,
};
const LIVE_SHOTS = [
  { name: 'live', now: T.normal, has: ['Siaran langsung', 'Ustaz Ahmad Fauzi', 'Kuliah Maghrib', 'Asar dalam'] },
  { name: 'live-portrait', now: T.normal, w: 1080, h: 1920, has: ['Siaran langsung', 'Ustaz Ahmad Fauzi'] },
  { name: 'live-azan', now: T.azan, has: ['Azan Asar dalam'], prayer: true },
];

/** In the page: RTCPeerConnection that answers with a moving canvas (a stand-in speaker at a lectern). */
function fakeLiveRtc() {
  const draw = (ctx, w, h, t) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#f1ead8');
    g.addColorStop(1, '#c9b48c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 4; i++) {
      const x = 140 + i * 460;
      ctx.fillStyle = '#fffdf5';
      ctx.beginPath();
      ctx.moveTo(x, 520);
      ctx.lineTo(x, 200);
      ctx.arc(x + 90, 200, 90, Math.PI, 0);
      ctx.lineTo(x + 180, 520);
      ctx.fill();
    }
    ctx.fillStyle = '#8f2f2a';
    ctx.fillRect(0, 820, w, h - 820);
    const cx = w / 2 + Math.sin(t / 900) * 12;
    ctx.fillStyle = '#f5f5f0';
    ctx.beginPath();
    ctx.ellipse(cx, 700, 190, 260, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#b98a62';
    ctx.beginPath();
    ctx.arc(cx, 400, 85, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(cx - 80, 300, 160, 55);
    ctx.fillStyle = '#6b4423';
    ctx.fillRect(cx - 230, 760, 460, 320);
  };
  class FakePC {
    constructor() {
      this.iceGatheringState = 'complete';
      this.connectionState = 'new';
      this.localDescription = null;
    }
    addTransceiver() {}
    async createOffer() {
      return { type: 'offer', sdp: 'v=0' };
    }
    async setLocalDescription(d) {
      this.localDescription = d;
    }
    addEventListener() {}
    removeEventListener() {}
    async setRemoteDescription() {
      const c = document.createElement('canvas');
      c.width = 1920;
      c.height = 1080;
      const ctx = c.getContext('2d');
      const loop = () => {
        draw(ctx, c.width, c.height, performance.now());
        requestAnimationFrame(loop);
      };
      loop();
      const s = c.captureStream(25);
      setTimeout(() => {
        this.ontrack?.({ track: s.getVideoTracks()[0], streams: [s] });
        this.connectionState = 'connected';
        this.onconnectionstatechange?.();
      }, 50);
    }
    close() {}
  }
  window.RTCPeerConnection = FakePC;
}

/** Context set-up for a live shot: the fake peer connection, the live state, the event stream, the WHEP answer. */
async function prepareLive(ctx) {
  await ctx.addInitScript(fakeLiveRtc);
  await ctx.route('**/api/kiosk/live', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LIVE) }),
  );
  await ctx.route('**/api/kiosk/events', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: live\ndata: ${JSON.stringify(LIVE)}\n\n` }),
  );
  await ctx.route('**/api/kiosk/live/whep', (route) =>
    route.fulfill({ status: 201, contentType: 'application/sdp', headers: { Location: '/api/kiosk/live/whep/proof1' }, body: 'v=0' }),
  );
  await ctx.route('**/api/kiosk/live/whep/*', (route) => route.fulfill({ status: 204, body: '' }));
}

// ---- content cards against the real box -----------------------------------------------------
const lower = (s) => s.toLowerCase();
const HADIS_STARTS = ['Sesungguhnya setiap amalan', 'Sesiapa yang beriman kepada Allah', 'Tidak beriman seseorang', 'Sebaik-baik kamu', 'Senyumanmu di hadapan'];
const CARDS = [
  { card: 'kuliahCard', all: ['Ustaz Hanafi Bakar', 'Bab Ikhlas dan Niat'] },
  { card: 'pengumuman', any: ['Gotong-royong perdana surau', 'Kelas mengaji dewasa'] },
  { card: 'posters', images: 1 },
  { card: 'programKhas', all: ['Majlis Khatam Al-Quran'] },
  { card: 'takwim', all: ['Mesyuarat AJK bulanan'] },
  { card: 'hadis', any: HADIS_STARTS },
  { card: 'worldTimes', all: ['Makkah', 'Tokyo'] },
  { card: 'tugasan', all: ['Haji Rosli Hamid'] },
  { card: 'ayatCard', all: ['Al-Baqarah'], arabicMin: 20 },
];
const TICKERS = ['Kutipan derma ruang wuduk baharu', 'Sumbangan untuk tabung anak yatim'];

// ---- server + browser plumbing ----------------------------------------------------------------
async function waitHealth(timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return await r.json();
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('box server did not become healthy');
}

async function waitDown(timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      await fetch(`${base}/api/health`);
    } catch {
      return true;
    }
    await sleep(200);
  }
  return false;
}

/** Box requests per minute are limited per address (600), so the proof paces itself. */
const requestTimes = [];
async function throttle() {
  for (;;) {
    const cutoff = Date.now() - 60000;
    while (requestTimes.length && requestTimes[0] < cutoff) requestTimes.shift();
    if (requestTimes.length < 300) return;
    await sleep(1500);
  }
}
/** Watch a page: count its box requests, remember the ones still open and any 429. */
function watch(page) {
  const open = new Map();
  const limited = [];
  page.on('request', (r) => {
    if (!r.url().startsWith(base)) return;
    requestTimes.push(Date.now());
    open.set(r, r.url().replace(base, ''));
  });
  page.on('requestfinished', (r) => open.delete(r));
  page.on('requestfailed', (r) => open.delete(r));
  page.on('response', (r) => {
    if (r.status() === 429) limited.push(r.url().replace(base, ''));
  });
  return { open: () => [...open.values()].slice(0, 6), limited };
}

async function openReady(page, now, extra = '') {
  await throttle();
  await page.goto(url(now, extra), { waitUntil: 'load' });
  await page.waitForSelector('.stage[data-phase]', { timeout: 15000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => {
    const img = document.querySelector('.bg__img');
    return !img || img.classList.contains('is-ready');
  });
  await page.waitForTimeout(1500);
}

let serverProc = null;
let serverLog = '';
function startServer(dbPath, dataDir) {
  serverProc = spawn(process.execPath, ['apps/box-server/src/main.ts'], {
    cwd: repo,
    env: { ...process.env, SURAU_DB: dbPath, SURAU_DATA_DIR: dataDir, SURAU_HOST: HOST, SURAU_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', (d) => (serverLog += d));
  serverProc.stderr.on('data', (d) => (serverLog += d));
}
async function stopServer() {
  if (!serverProc) return;
  const p = serverProc;
  serverProc = null;
  if (p.exitCode === null) {
    await new Promise((res) => {
      p.once('exit', res);
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F']);
      else p.kill('SIGTERM');
      setTimeout(res, 5000);
    });
  }
}

/** One screenshot in a fresh browser context; `check(page)` returns a list of problems. */
async function runShot(browser, { name, file, now, w = 1920, h = 1080, extra = '', ctxOptions = {}, prepare, check }) {
  // No service worker here: a fresh context would precache the whole shell again (about 50 requests) and
  // use up the box's per-address request budget. The offline step below keeps the worker on.
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
    ...ctxOptions,
  });
  try {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const seen = watch(page);
    try {
      if (prepare) await prepare(page, ctx);
      await openReady(page, now, extra);
      const problems = (await check(page, { w, h })) ?? [];
      await page.screenshot({ path: resolve(repo, file) });
      if (errors.length) problems.push(`pageerror ${errors.join(' | ')}`);
      if (seen.limited.length) problems.push(`rate limited (429): ${seen.limited.slice(0, 3).join(', ')}`);
      record(name, file, problems.length === 0, problems.join('; '));
    } catch (e) {
      record(name, file, false, `${String(e).split('\n')[0]} [open requests: ${seen.open().join(', ') || 'none'}]`);
    }
  } catch (e) {
    record(name, file, false, String(e).split('\n')[0]);
  } finally {
    await ctx.close();
  }
}

/** Problems for text that must (all/any) be on screen; comparison ignores case (the kiosk uppercases labels). */
function textProblems(text, { all = [], any = [] }) {
  const t = lower(text);
  const problems = [];
  const missing = all.filter((s) => !t.includes(lower(s)));
  if (missing.length) problems.push(`missing ${JSON.stringify(missing)}`);
  if (any.length && !any.some((s) => t.includes(lower(s)))) problems.push(`none of ${JSON.stringify(any)}`);
  return problems;
}

/** Wait for the forced card, then for its images; returns problems measured on it. */
async function checkCard(page, spec, { w, h }) {
  const sel = `[data-card="${spec.card}"]`;
  try {
    await page.waitForSelector(sel, { state: 'attached', timeout: 15000 });
  } catch {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 200).replace(/\s+/g, ' '));
    return [`card ${spec.card} never appeared (page text: ${body})`];
  }
  await page
    .waitForFunction(
      (s) => [...document.querySelectorAll(`${s} img`)].every((i) => i.complete && i.naturalWidth > 0),
      sel,
      { timeout: 10000 },
    )
    .catch(() => {});
  await page.waitForTimeout(900); // the 400 ms cross-fade
  const info = await page.evaluate((s) => {
    const el = document.querySelector(s);
    const r = el.getBoundingClientRect();
    const imgs = [...el.querySelectorAll('img')];
    return {
      text: el.innerText,
      rect: { x: r.x, y: r.y, r: r.right, b: r.bottom },
      imgs: imgs.length,
      imgsBad: imgs.filter((i) => !(i.complete && i.naturalWidth > 0)).length,
      arabic: (el.innerText.match(/[\u0600-\u06FF]/g) ?? []).length,
    };
  }, sel);
  const problems = textProblems(info.text, spec);
  if (spec.images && info.imgs < spec.images) problems.push(`expected ${spec.images} image(s), found ${info.imgs}`);
  if (info.imgsBad) problems.push(`${info.imgsBad} image(s) failed to load`);
  if (spec.arabicMin && info.arabic < spec.arabicMin) problems.push(`only ${info.arabic} Arabic letters (need ${spec.arabicMin})`);
  if (info.rect.x < -1 || info.rect.y < -1 || info.rect.r > w + 1 || info.rect.b > h + 1) {
    problems.push(`card overflows the screen ${JSON.stringify(info.rect)}`);
  }
  return problems;
}

/** Prayer-layer rule: no content card, ticker or zikir during any prayer phase. */
async function noContentProblems(page) {
  const n = await page.evaluate(
    () => document.querySelectorAll('[data-card], [data-layer="ticker"], [data-layer="zikir"], [data-layer="content"] > *').length,
  );
  return n === 0 ? [] : [`${n} content element(s) on a prayer screen`];
}

// ---------------------------------------------------------------------------------------------
const tmpRoot = mkdtempSync(join(tmpdir(), 'surau-proof-'));
const dataDir = join(tmpRoot, 'data');
const dbPath = join(dataDir, 'proof.db');
let browser = null;
try {
  mkdirSync(join(outDir, 'content'), { recursive: true });
  mkdirSync(join(dataDir, 'islamic', 'quran'), { recursive: true });

  if (!noBuild) {
    const b = spawnSync('npm run build -w apps/kiosk-display', { cwd: repo, shell: true, stdio: 'inherit' });
    if (b.status !== 0) throw new Error('kiosk build failed');
  }
  if (!existsSync(distDir)) throw new Error('apps/kiosk-display/dist missing (build first)');

  // The Quran text normally comes from `cli/fetchIslamic.ts --quran` (needs the internet once). The proof
  // writes surah 2 from the committed QuranEnc test fixture into the temp data folder instead.
  const qe = JSON.parse(readFileSync(resolve(repo, 'apps/box-server/test/fixtures/quranenc-sura-2.json'), 'utf8'));
  writeFileSync(
    join(dataDir, 'islamic', 'quran', 'malay_basumayyah.json'),
    JSON.stringify({
      key: 'malay_basumayyah',
      title: 'Terjemahan Abdullah Basmeih (QuranEnc)',
      version: 'unlisted',
      fetchedAt: new Date().toISOString(),
      surahs: {
        2: {
          nameAr: 'البقرة',
          nameMs: 'Al-Baqarah',
          ayat: qe.result.map((r) => ({ aya: Number(r.aya), arabic: r.arabic_text, translation: r.translation })),
        },
      },
    }),
  );

  // First admin through the box's own CLI (before the server starts), then the server.
  const enrolText = bootstrapAdmin({ dbPath, dataDir, box: base, name: 'Pentadbir Proof' });
  startServer(dbPath, dataDir);
  await waitHealth();

  // ---- sign in as admin with the device client; anonymous writes must be refused --------------------
  const admin = await signInAdmin(enrolText);
  record('sign-in admin', '', admin.roles.includes('admin'), `roles=${admin.roles.join(',')}`);
  const anon = await fetch(`${base}/api/settings/language`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lang: 'en' }),
  });
  record('anonymous write refused', '', anon.status === 401 || anon.status === 403, `status ${anon.status}`);

  const imp = await admin.json('POST', '/api/prayer/import', { zone: 'SGR01', csv: fixtureCsv });
  record('import', '', imp.ok && imp.data?.inserted === 365, JSON.stringify(imp.data));

  // The anonymous health answer is only { ok, version }; the report with daysAhead needs a signed-in role.
  const health = (await admin.json('GET', '/api/health')).data ?? {};
  record('health daysAhead', '', health.daysAhead > 0, `daysAhead=${health.daysAhead}`);

  const seeded = await seedContent(admin, { today: TODAY });
  const total = Object.values(seeded.counts).reduce((a, b) => a + b, 0);
  record('seed content', '', total === 50, `${total} items, ${Object.keys(seeded.assets).length} pictures, day ${TODAY}`);
  const ayatSet = await admin.json('PUT', '/api/settings/ayatCard', { pick: 'manual', surah: 2, ayatFrom: 255, ayatTo: 255 });
  record('ayat settings', '', ayatSet.ok, `status ${ayatSet.status}`);
  const kc = await (await fetch(`${base}/api/kiosk/content`)).json();
  record(
    'kiosk content API',
    '',
    kc.content.kuliah.length >= 4 && kc.content.ayat.today !== null && kc.content.zikir.length === 8 && kc.content.ticker.length === 2,
    `kuliah ${kc.content.kuliah.length}, ayat ${kc.content.ayat.today ? 'yes' : 'no'}, zikir ${kc.content.zikir.length}, ticker ${kc.content.ticker.length}`,
  );

  browser = await chromium.launch();

  // ---- prayer screens (content is seeded: prayer phases must still show none of it) -----------
  for (const shot of SHOTS) {
    await runShot(browser, {
      name: shot.name,
      file: `proof/${shot.name}.png`,
      now: shot.now,
      w: shot.w ?? 1920,
      h: shot.h ?? 1080,
      check: async (page) => {
        const text = await page.evaluate(() => document.body.innerText);
        const problems = [];
        const missing = shot.has.filter((s) => !text.includes(s));
        if (missing.length) problems.push(`missing ${JSON.stringify(missing)}`);
        if (shot.noClock) {
          // noData shows the wall clock (data-role="clock") but never a prayer time.
          const outside = await page.evaluate(() => {
            const clone = document.body.cloneNode(true);
            clone.querySelectorAll('[data-role="clock"]').forEach((n) => n.remove());
            return clone.innerText ?? clone.textContent ?? '';
          });
          if (/\d:\d\d/.test(outside)) problems.push('contains a prayer time (\\d:\\d\\d outside the clock)');
          const clocks = await page.locator('[data-role="clock"]').count();
          if (clocks !== 1) problems.push(`expected exactly 1 clock, found ${clocks}`);
        }
        if (shot.noContent) problems.push(...(await noContentProblems(page)));
        return problems;
      },
    });
  }

  // ---- live layer (Plan 5 Task 6): the box's live state and the WHEP answer are faked in the browser --------
  // (a real live needs MediaMTX and a publisher; Task 12 proves that end to end). The kiosk itself is the real
  // build against the real box; only /api/kiosk/live, the event stream and the WHEP POST are answered here, and
  // RTCPeerConnection hands the page a canvas stream as the "camera".
  const liveOn = await admin.json('PUT', '/api/settings/liveOnKiosk', { enabled: true });
  record('live settings', '', liveOn.ok, `status ${liveOn.status}`);
  for (const shot of LIVE_SHOTS) {
    await runShot(browser, {
      name: shot.name,
      file: `proof/${shot.name}.png`,
      now: shot.now,
      w: shot.w ?? 1920,
      h: shot.h ?? 1080,
      prepare: (page, ctx) => prepareLive(ctx),
      check: async (page) => {
        await page.waitForTimeout(2500); // WHEP answer, first frames, 900 ms fade in
        const m = await page.evaluate(() => {
          const box = (sel) => {
            const e = document.querySelector(sel);
            return e ? e.getBoundingClientRect().toJSON() : null;
          };
          return {
            text: document.body.innerText,
            video: document.querySelector('[data-testid="live-video"]') !== null,
            playing: document.querySelector('.live')?.getAttribute('data-playing') ?? null,
            strip: box('[data-testid="live-strip"]'),
            below: box('.ticker') ?? box('.pbar'),
          };
        });
        const problems = shot.has.filter((s) => !lower(m.text).includes(lower(s))).map((s) => `missing "${s}"`);
        if (shot.prayer) {
          if (m.video || m.strip) problems.push('live shown during a prayer phase');
          problems.push(...(await noContentProblems(page)));
        } else {
          if (!m.video || m.playing !== 'true') problems.push('live video not playing');
          if (!m.strip) problems.push('no kuliah strip');
          else if (m.below && m.strip.bottom > m.below.top + 0.5) problems.push('kuliah strip overlaps the ticker or the prayer bar');
        }
        return problems;
      },
    });
  }
  const liveOff = await admin.json('PUT', '/api/settings/liveOnKiosk', { enabled: false });
  record('live settings off', '', liveOff.ok, `status ${liveOff.status}`);

  // ---- content cards from the real box, both screen sizes --------------------------------------
  for (const spec of CARDS) {
    for (const [w, h] of [[1920, 1080], [1366, 768]]) {
      await runShot(browser, {
        name: `content ${spec.card} ${w}`,
        file: `proof/content/${spec.card}-${w}.png`,
        now: T.normal,
        w,
        h,
        extra: `&card=${spec.card}`,
        check: (page, size) => checkCard(page, spec, size),
      });
    }
  }

  // Ayat with a long range (two long ayat: the card pages them).
  const range = await admin.json('PUT', '/api/settings/ayatCard', { pick: 'manual', surah: 2, ayatFrom: 255, ayatTo: 256 });
  record('ayat range settings', '', range.ok, `status ${range.status}`);
  await runShot(browser, {
    name: 'content ayat long range 1366',
    file: 'proof/content/ayat-range-1366.png',
    now: T.normal,
    w: 1366,
    h: 768,
    extra: '&card=ayatCard',
    check: (page, size) => checkCard(page, { card: 'ayatCard', all: ['Al-Baqarah'], arabicMin: 60 }, size),
  });
  await admin.json('PUT', '/api/settings/ayatCard', { pick: 'manual', surah: 2, ayatFrom: 255, ayatTo: 255 });

  // Ticker strip above the prayer bar (shown with any card).
  for (const [w, h] of [[1920, 1080], [1366, 768]]) {
    await runShot(browser, {
      name: `content ticker ${w}`,
      file: `proof/content/ticker-${w}.png`,
      now: T.normal,
      w,
      h,
      extra: '&card=kuliahCard',
      check: async (page) => {
        try {
          await page.waitForSelector('[data-layer="ticker"]', { timeout: 15000 });
        } catch {
          return ['ticker strip never appeared'];
        }
        await page.waitForTimeout(800);
        const text = await page.evaluate(() => document.querySelector('[data-layer="ticker"]').textContent);
        return textProblems(text, { any: TICKERS });
      },
    });
  }

  // Zikir after Asar: the first zikir of the eight, with its counter.
  for (const [w, h] of [[1920, 1080], [1366, 768]]) {
    await runShot(browser, {
      name: `content zikir ${w}`,
      file: `proof/content/zikir-${w}.png`,
      now: T.zikirFirst,
      w,
      h,
      check: async (page) => {
        try {
          await page.waitForSelector('[data-layer="zikir"]', { timeout: 15000 });
        } catch {
          return ['zikir overlay never appeared'];
        }
        await page.waitForTimeout(800);
        const text = await page.evaluate(() => document.querySelector('[data-layer="zikir"]').innerText);
        const problems = textProblems(text, { all: ['Zikir selepas solat Asar', 'Aku memohon keampunan', '1 / 8'] });
        if (!text.includes('أَسْتَغْفِرُ')) problems.push('first zikir Arabic missing');
        return problems;
      },
    });
  }

  // During solat nothing from the content layer may show, even with everything seeded.
  await runShot(browser, {
    name: 'content none during solat',
    file: 'proof/content/solat-no-content.png',
    now: T.solat,
    extra: '&card=kuliahCard',
    check: async (page) => {
      const text = await page.evaluate(() => document.body.innerText);
      return [...(text.includes('Solat sedang didirikan') ? [] : ['solat screen text missing']), ...(await noContentProblems(page))];
    },
  });

  // ---- pairing a kiosk on a client that does not look like the box's own display ------------------
  // The loopback kiosk rule excludes requests that carry proxy headers, so adding X-Forwarded-For makes
  // the same Chromium look like a display elsewhere on the network: the box refuses it and the kiosk shows
  // the pairing screen. (A real LAN client would need HTTPS and a certificate; ui-preview covers the
  // screen states, and tests/sec-probe cover the HTTPS side.)
  {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    const pairProblems = [];
    let step = 'start';
    try {
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.route('**/*', (route) =>
        route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': '203.0.113.9' } }),
      );
      step = 'pairing screen';
      await openReady(page, T.normal);
      await page.waitForSelector('[data-screen="pair"]', { timeout: 15000 });
      const code = await page.getAttribute('[data-code]', 'data-code');
      const shown = await page.evaluate(() => document.body.innerText);
      if (!/^\d{6}$/.test(code ?? '')) pairProblems.push('no 6-digit code on the pairing screen');
      for (const s of ['Pasang skrin ini', 'Kod tamat dalam']) if (!shown.includes(s)) pairProblems.push(`missing "${s}"`);
      await page.screenshot({ path: resolve(repo, 'proof/pair.png') });
      record('pairing screen', 'proof/pair.png', pairProblems.length === 0, pairProblems.join('; '));

      step = 'approve';
      const ok = await admin.json('POST', '/api/kiosk/pair/approve', { code, deviceName: 'Paparan proof' });
      const kioskDeviceId = ok.data?.deviceId;
      if (!ok.ok || !kioskDeviceId) throw new Error(`approve -> ${ok.status}`);

      step = 'paired kiosk loads';
      await page.waitForFunction(
        () => document.querySelector('.stage') && document.querySelector('.stage').dataset.phase !== 'pair' && document.body.innerText.includes('Asar dalam'),
        null,
        { timeout: 20000 },
      );
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(1500);
      const badge = await page.locator('[data-testid="pair-badge"]').count();
      await page.screenshot({ path: resolve(repo, 'proof/paired.png') });
      record('paired kiosk loads', 'proof/paired.png', badge === 0, badge ? 'not-paired badge still shown' : '');

      step = 'live setting reaches the paired kiosk';
      const before = await page.locator('.ident__hijri').first().innerText();
      const t0 = Date.now();
      const put = await admin.json('PUT', '/api/settings/hijriDate', { adjustDays: 1 });
      if (!put.ok) throw new Error(`PUT hijriDate -> ${put.status}`);
      let ms = -1;
      while (Date.now() - t0 < 6000) {
        if ((await page.locator('.ident__hijri').first().innerText()) !== before) {
          ms = Date.now() - t0;
          break;
        }
        await sleep(100);
      }
      await admin.json('PUT', '/api/settings/hijriDate', { adjustDays: 0 });
      record('paired kiosk updates live', '', ms >= 0 && ms <= 3000, ms < 0 ? 'hijri date never changed' : `${ms} ms`);

      step = 'audit trail';
      const audit = await admin.json('GET', '/api/audit?limit=200');
      const entries = audit.data?.entries ?? [];
      const mine = entries.find((e) => e.entity === 'settings' && e.actor === `user:${admin.session.user.id}` && e.deviceId === admin.deviceId);
      const pairRow = entries.find((e) => e.entity === 'devices' && e.entityId === kioskDeviceId);
      record(
        'audit shows user and device',
        '',
        Boolean(mine && pairRow),
        `settings change by user+device: ${mine ? 'yes' : 'NO'}; kiosk device row: ${pairRow ? 'yes' : 'NO'}`,
      );

      step = 'revoke';
      const rv = await admin.json('POST', `/api/devices/${kioskDeviceId}/revoke`);
      if (!rv.ok) throw new Error(`revoke -> ${rv.status}`);
      await openReady(page, T.normal);
      await page.waitForSelector('[data-testid="pair-badge"]', { timeout: 15000 });
      const after = await page.evaluate(() => document.body.innerText);
      const revokedProblems = [];
      if (!after.includes('Belum dipasangkan')) revokedProblems.push('badge text missing');
      if (!after.includes('Asar dalam')) revokedProblems.push('cached prayer screen lost');
      await page.screenshot({ path: resolve(repo, 'proof/revoked.png') });
      record('revoked kiosk shows badge, keeps cached prayer screen', 'proof/revoked.png', revokedProblems.length === 0, revokedProblems.join('; '));
      if (errors.length) record('pairing flow page errors', '', false, errors.join(' | '));
    } catch (e) {
      record(`pairing flow (${step})`, '', false, String(e).split('\n')[0]);
    } finally {
      await ctx.close();
    }
  }

  // ---- live change (SSE) and offline proofs share one page, as the box's own loopback kiosk -------------
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  try {
    const page = await ctx.newPage();
    await openReady(page, T.normal, '&card=kuliahCard');

    const put = (lang) => admin.json('PUT', '/api/settings/language', { lang });
    let liveOk = false;
    let liveDetail = '';
    try {
      const r = await put('en');
      if (!r.ok) throw new Error(`PUT en -> ${r.status}`);
      // Today's weekday and date in English, from the page's own clock override.
      const [y, mo, d] = TODAY.split('-').map(Number);
      const words = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
        .format(new Date(Date.UTC(y, mo - 1, d)))
        .replace(/,/g, '');
      await page.waitForFunction(
        (w) => document.body.innerText.replace(/,/g, '').includes(w),
        words,
        { timeout: 10000 },
      );
      await page.waitForTimeout(800);
      await page.screenshot({ path: resolve(repo, 'proof/live-change-en.png') });
      liveOk = true;
    } catch (e) {
      liveDetail = String(e);
    } finally {
      const r = await put('ms');
      if (!r.ok) liveDetail += ` (restore ms failed ${r.status})`;
    }
    record('live-change-en', 'proof/live-change-en.png', liveOk, liveDetail);

    // Let the page pick the restored language and refresh its cache.
    await page
      .waitForFunction(() => document.body.innerText.includes('Asar dalam'), null, { timeout: 10000 })
      .catch(() => {});
    await page.waitForTimeout(1000);

    // Offline, for real: the service worker must already control the page, then the box
    // server is stopped and the page is reloaded with no routing at all. The document, JS,
    // CSS, fonts and images come from the worker's cache; every /api call really fails.
    let offOk = false;
    let offDetail = '';
    const offErrors = [];
    page.on('pageerror', (e) => offErrors.push(String(e)));
    try {
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
      await page.waitForSelector('.stage[data-phase]', { timeout: 15000 });
      await page.waitForSelector('[data-card="kuliahCard"]', { timeout: 15000 }); // content cached from the network
      // The kiosk fetches every picture once so the worker keeps them (9 in the demo content).
      await page.waitForFunction(
        () => caches.open('surau-media-v1').then((c) => c.keys()).then((k) => k.length >= 9),
        null,
        { timeout: 20000 },
      );
      await stopServer();
      if (!(await waitDown())) throw new Error('server still answering');
      await page.goto(url(T.normal), { waitUntil: 'load' });
      await page.waitForSelector('.stage[data-phase]', { timeout: 15000 });
      await page.waitForFunction(() => document.body.innerText.includes('Asar dalam'), null, { timeout: 10000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: resolve(repo, 'proof/offline.png') });
      if (offErrors.length) throw new Error(`pageerror ${offErrors.join(' | ')}`);
      offOk = true;
    } catch (e) {
      offDetail = String(e);
    }
    record('offline', 'proof/offline.png', offOk, offDetail);

    // Content still renders from the cache with the box down.
    let offContentOk = false;
    let offContentDetail = '';
    try {
      if (!offOk) throw new Error('skipped: offline step failed');
      await page.goto(url(T.normal, '&card=kuliahCard'), { waitUntil: 'load' });
      await page.waitForSelector('.stage[data-phase]', { timeout: 15000 });
      await page.waitForSelector('[data-card="kuliahCard"]', { timeout: 15000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(1500);
      const text = await page.evaluate(() => document.querySelector('[data-card="kuliahCard"]').innerText);
      const problems = textProblems(text, { all: ['Ustaz Hanafi Bakar'] });
      const photo = await page.evaluate(() => {
        const i = [...document.querySelectorAll('[data-card="kuliahCard"] img')];
        return { n: i.length, bad: i.filter((x) => !(x.complete && x.naturalWidth > 0)).length };
      });
      if (photo.bad) problems.push(`${photo.bad}/${photo.n} card image(s) did not load offline`);
      await page.screenshot({ path: resolve(repo, 'proof/content/offline.png') });
      // A poster that was never on screen before the box went down must still load (kept by the worker).
      await page.goto(url(T.normal, '&card=posters'), { waitUntil: 'load' });
      await page.waitForSelector('[data-card="posters"] img.poster__img', { timeout: 15000 });
      await page.waitForTimeout(1500);
      const poster = await page.evaluate(() => {
        const i = document.querySelector('[data-card="posters"] img.poster__img');
        return i.complete && i.naturalWidth > 0;
      });
      if (!poster) problems.push('poster picture did not load offline');
      await page.screenshot({ path: resolve(repo, 'proof/content/offline-poster.png') });
      if (problems.length) throw new Error(problems.join('; '));
      offContentOk = true;
    } catch (e) {
      offContentDetail = String(e);
    }
    record('content offline', 'proof/content/offline.png', offContentOk, offContentDetail);
  } finally {
    await ctx.close();
  }
} catch (e) {
  record('run', '', false, String(e).split('\n')[0]);
  if (serverLog) console.error('--- box server log ---\n' + serverLog.replace(/surau1:\S+/g, 'surau1:<hidden>'));
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopServer();
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* temp db may be locked briefly; harmless */
  }
}

console.log('\nSTEP'.padEnd(52) + 'RESULT  FILE');
for (const r of results) {
  console.log(`${r.name.padEnd(51)} ${(r.ok ? 'OK' : 'FAIL').padEnd(7)} ${r.file}${r.ok ? '' : '  ' + r.detail}`);
}
const allOk = results.length > 0 && results.every((r) => r.ok);
console.log(allOk ? '\nALL PASSED' : '\nFAILURES PRESENT');
process.exit(allOk ? 0 : 1);
