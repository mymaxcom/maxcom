#!/usr/bin/env node
// Seeds a realistic demo surau through the REAL box HTTP API, signed in as an admin.
// All names are invented and every picture is generated here (own work, no third-party images).
//
//   Against a running box that already has an admin (the enrolment text comes from
//   cli/bootstrap.ts, or from "Add device" in the app; it is single use):
//     node scripts/seed-content.mjs --payload "surau1:..." [--today 2026-11-04]
//     SURAU_ENROL_PAYLOAD="surau1:..." node scripts/seed-content.mjs
//
//   Against a fresh database with no admin yet (creates the first admin with the box's own CLI):
//     node scripts/seed-content.mjs --bootstrap --db <surau.db> --data <data folder> --box http://127.0.0.1:8787
//
// The script enrols a throw-away device for that admin with the device client (a Node WebCrypto key
// that is discarded when the script ends), unlocks it, and writes through authedFetch. A random PIN
// is used for that device and is never printed. Re-running is safe: every item has a fixed id, so
// it is replaced, not duplicated.
//
// Module use (scripts/proof-screens.mjs): import { bootstrapAdmin, signInAdmin, seedContent }.

import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

// ---------------------------------------------------------------------------------------------
// Pictures: tiny PNGs drawn pixel by pixel (no dependencies).
// ---------------------------------------------------------------------------------------------

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body) >>> 0, 4 + body.length);
  return out;
}

/** Encode an RGB image; `pixel(x, y)` returns [r, g, b]. */
export function encodePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Abstract portrait: gradient wall, head and shoulders in a lighter tone. */
function portrait(size, top, bottom, skin) {
  const cx = size / 2;
  return encodePng(size, size, (x, y) => {
    const base = mix(top, bottom, y / size);
    const head = Math.hypot(x - cx, y - size * 0.4) < size * 0.17;
    const shoulders = Math.hypot((x - cx) / 1.0, (y - size * 1.02) / 0.62) < size * 0.42;
    if (head) return skin;
    if (shoulders) return mix(skin, bottom, 0.45);
    return base;
  });
}

/** Eight-point star (two squares turned 45 degrees) with rings, on a gradient. */
function starPoster(w, h, top, bottom, gold) {
  const cx = w / 2;
  const cy = h * 0.42;
  const r = Math.min(w, h) * 0.36;
  return encodePng(w, h, (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    const sq1 = Math.max(Math.abs(dx), Math.abs(dy)) < r * 0.72;
    const sq2 = (Math.abs(dx) + Math.abs(dy)) / Math.SQRT2 < r * 0.72;
    const dist = Math.hypot(dx, dy);
    const ring = Math.abs(dist - r * 1.05) < 3 || Math.abs(dist - r * 1.18) < 2;
    if (sq1 || sq2) return mix(gold, bottom, 0.15 + 0.5 * clamp01(dist / r));
    if (ring) return gold;
    const band = y > h * 0.82 && y < h * 0.84;
    if (band) return gold;
    return mix(top, bottom, y / h);
  });
}

/** Wide banner: overlapping circles on a gradient. */
function bannerImage(w, h, top, bottom, gold) {
  return encodePng(w, h, (x, y) => {
    const base = mix(top, bottom, x / w);
    const a = Math.hypot(x - w * 0.78, y - h * 0.5) < h * 0.34;
    const b = Math.hypot(x - w * 0.66, y - h * 0.5) < h * 0.34;
    if (a && !b) return gold;
    if (Math.abs(Math.hypot(x - w * 0.72, y - h * 0.5) - h * 0.47) < 2) return gold;
    return base;
  });
}

/** Book cover: a field with a border and a small star. */
function coverImage(w, h, field, gold) {
  return encodePng(w, h, (x, y) => {
    const edge = Math.min(x, y, w - 1 - x, h - 1 - y);
    if (edge < 6) return gold;
    if (edge < 12) return field;
    const dx = x - w / 2;
    const dy = y - h * 0.4;
    const star = Math.max(Math.abs(dx), Math.abs(dy)) < w * 0.16 || (Math.abs(dx) + Math.abs(dy)) / Math.SQRT2 < w * 0.16;
    return star ? gold : mix(field, [10, 40, 38], y / h);
  });
}

const GOLD = [214, 178, 94];

/** The generated pictures, by logical name. */
export function makeImages() {
  return {
    penceramah1: portrait(480, [20, 74, 70], [10, 40, 44], [222, 190, 150]),
    penceramah2: portrait(480, [88, 60, 40], [40, 28, 24], [200, 160, 122]),
    penceramah3: portrait(480, [36, 66, 100], [16, 30, 52], [232, 200, 164]),
    kitab1: coverImage(360, 480, [24, 92, 84], GOLD),
    kitab2: coverImage(360, 480, [92, 52, 40], GOLD),
    poster1: starPoster(900, 1200, [18, 70, 66], [8, 32, 36], GOLD),
    poster2: starPoster(900, 1200, [70, 40, 90], [30, 16, 44], GOLD),
    poster3: starPoster(900, 1200, [90, 56, 24], [40, 22, 12], GOLD),
    program1: bannerImage(1200, 675, [18, 70, 66], [8, 32, 50], GOLD),
  };
}

// ---------------------------------------------------------------------------------------------
// Sign in with the device client.
// ---------------------------------------------------------------------------------------------

/** Create the first admin with the box's own CLI. Returns the enrolment text (a secret: never print it). */
export function bootstrapAdmin({ dbPath, dataDir, box, name = 'Pentadbir Demo' }) {
  const r = spawnSync(
    process.execPath,
    ['apps/box-server/src/cli/bootstrap.ts', '--db', dbPath, '--name', name, '--box', box, '--data', dataDir],
    { cwd: repo, encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`bootstrap failed (exit ${r.status}): ${(r.stderr || '').split('\n')[0]}`);
  const m = /(surau1:[A-Za-z0-9_-]+)/.exec(r.stdout);
  if (!m) throw new Error('bootstrap printed no enrolment text');
  return m[1];
}

/** A PIN the box accepts (6 digits, not all equal, not a run), never printed. */
function randomPin() {
  for (;;) {
    const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const d = [...pin].map(Number);
    const steps = d.slice(1).map((v, i) => v - d[i]);
    if (/^(\d)\1{5}$/.test(pin) || steps.every((s) => s === 1) || steps.every((s) => s === -1)) continue;
    return pin;
  }
}

/**
 * Enrol a throw-away device from the enrolment text, unlock it and return { api, session, deviceId }.
 * `api(path, init)` is authedFetch bound to the session; `json(method, path, body)` is the common case.
 */
export async function signInAdmin(payloadText, { pin = randomPin() } = {}) {
  const client = await import(pathToFileURL(resolve(repo, 'packages/device-client/src/index.ts')).href);
  const payload = client.parseEnrolPayload(payloadText);
  const keys = client.memoryKeyStore();
  const enrolled = await client.enrol(payload, { deviceName: 'Skrip seed', platform: 'web', pin, keys });
  const session = await client.unlock(payload.box, enrolled.deviceId, pin, { boxId: payload.boxId, keys });
  const api = (path, init) => client.authedFetch(session, path, init);
  const json = async (method, path, body) => {
    const res = await api(path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, ok: res.ok, data };
  };
  return { api, json, session, deviceId: enrolled.deviceId, roles: session.user.roles };
}

// ---------------------------------------------------------------------------------------------
// The demo data.
// ---------------------------------------------------------------------------------------------

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function klToday(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
}

export const weekdayOf = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/** Arabic texts the kiosk shows (hadis and zikir). */
const HADIS = [
  {
    id: 'demo-hadis-1',
    textAr: 'إِنَّمَا الْأَعْمَالُ بِالنِّيَّاتِ، وَإِنَّمَا لِكُلِّ امْرِئٍ مَا نَوَى',
    textMs: 'Sesungguhnya setiap amalan itu bergantung kepada niat, dan setiap orang hanya mendapat apa yang diniatkannya.',
    source: 'Riwayat al-Bukhari dan Muslim',
  },
  {
    id: 'demo-hadis-2',
    textAr: 'مَنْ كَانَ يُؤْمِنُ بِاللَّهِ وَالْيَوْمِ الْآخِرِ فَلْيَقُلْ خَيْرًا أَوْ لِيَصْمُتْ',
    textMs: 'Sesiapa yang beriman kepada Allah dan hari akhirat, hendaklah dia berkata baik atau diam.',
    source: 'Riwayat al-Bukhari dan Muslim',
  },
  {
    id: 'demo-hadis-3',
    textAr: 'لَا يُؤْمِنُ أَحَدُكُمْ حَتَّى يُحِبَّ لِأَخِيهِ مَا يُحِبُّ لِنَفْسِهِ',
    textMs: 'Tidak beriman seseorang daripada kamu sehingga dia mengasihi saudaranya sebagaimana dia mengasihi dirinya sendiri.',
    source: 'Riwayat al-Bukhari dan Muslim',
  },
  {
    id: 'demo-hadis-4',
    textAr: 'خَيْرُكُمْ مَنْ تَعَلَّمَ الْقُرْآنَ وَعَلَّمَهُ',
    textMs: 'Sebaik-baik kamu ialah orang yang mempelajari Al-Quran dan mengajarkannya.',
    source: 'Riwayat al-Bukhari',
  },
  {
    id: 'demo-hadis-5',
    textAr: 'تَبَسُّمُكَ فِي وَجْهِ أَخِيكَ لَكَ صَدَقَةٌ',
    textMs: 'Senyumanmu di hadapan saudaramu adalah sedekah.',
    source: 'Riwayat at-Tirmidzi',
  },
];

const ZIKIR = [
  ['أَسْتَغْفِرُ اللهَ الْعَظِيمَ', 'Aku memohon keampunan daripada Allah Yang Maha Agung', 3],
  ['اللَّهُمَّ أَنْتَ السَّلَامُ وَمِنْكَ السَّلَامُ تَبَارَكْتَ يَا ذَا الْجَلَالِ وَالْإِكْرَامِ', 'Ya Allah, Engkaulah As-Salam dan daripada-Mu kesejahteraan; Maha Berkat Engkau, wahai Tuhan yang memiliki keagungan dan kemuliaan'],
  ['سُبْحَانَ اللهِ', 'Maha Suci Allah', 33],
  ['الْحَمْدُ لِلَّهِ', 'Segala puji bagi Allah', 33],
  ['اللهُ أَكْبَرُ', 'Allah Maha Besar', 33],
  ['لَا إِلَهَ إِلَّا اللهُ وَحْدَهُ لَا شَرِيكَ لَهُ، لَهُ الْمُلْكُ وَلَهُ الْحَمْدُ وَهُوَ عَلَى كُلِّ شَيْءٍ قَدِيرٌ', 'Tiada tuhan selain Allah Yang Esa, tiada sekutu bagi-Nya. Bagi-Nya kerajaan dan segala pujian, dan Dia Maha Berkuasa atas segala sesuatu'],
  ['اللَّهُمَّ أَعِنِّي عَلَى ذِكْرِكَ وَشُكْرِكَ وَحُسْنِ عِبَادَتِكَ', 'Ya Allah, bantulah aku untuk mengingati-Mu, bersyukur kepada-Mu dan beribadah kepada-Mu dengan baik'],
  ['رَبَّنَا آتِنَا فِي الدُّنْيَا حَسَنَةً وَفِي الْآخِرَةِ حَسَنَةً وَقِنَا عَذَابَ النَّارِ', 'Ya Tuhan kami, berilah kami kebaikan di dunia dan kebaikan di akhirat, dan peliharalah kami daripada azab neraka'],
];

/**
 * What the seed writes, for a KL date `today`. Pure data: ids are fixed so a re-run replaces.
 * `assets` maps the logical picture names to the asset ids the box returned.
 */
export function demoContent(today, assets) {
  const d = (n) => addDays(today, n);
  const content = {
    penceramah: [
      { id: 'demo-penceramah-1', name: 'Ustaz Hanafi Bakar', title: 'Ustaz', photoAssetId: assets.penceramah1 },
      { id: 'demo-penceramah-2', name: 'Ustazah Salmah Rosli', title: 'Ustazah', photoAssetId: assets.penceramah2 },
      { id: 'demo-penceramah-3', name: 'Ustaz Irfan Mahmud', title: 'Ustaz', photoAssetId: assets.penceramah3 },
    ],
    kitab: [
      { id: 'demo-kitab-1', title: 'Riyadhus Solihin', author: 'Imam An-Nawawi', coverAssetId: assets.kitab1 },
      { id: 'demo-kitab-2', title: 'Tafsir Ibnu Kathir', author: 'Ibnu Kathir', coverAssetId: assets.kitab2 },
    ],
    kuliah: [
      { id: 'demo-kuliah-1', date: d(0), slot: 'maghrib', time: '19:30', label: 'Kuliah Maghrib', penceramahId: 'demo-penceramah-1', kitabId: 'demo-kitab-1', topic: 'Bab Ikhlas dan Niat (siri 12)', status: 'aktif' },
      { id: 'demo-kuliah-2', date: d(1), slot: 'subuh', time: '06:15', label: 'Kuliah Subuh', penceramahId: 'demo-penceramah-2', kitabId: 'demo-kitab-2', topic: 'Tafsir Surah Al-Kahfi (siri 4)', status: 'aktif' },
      { id: 'demo-kuliah-3', date: d(2), slot: 'maghrib', time: '19:30', label: 'Kuliah Maghrib', penceramahId: 'demo-penceramah-3', topic: 'Fiqh Solat Musafir', status: 'aktif' },
      { id: 'demo-kuliah-4', date: d(3), slot: 'isyak', time: '21:00', label: 'Kuliah Isyak', penceramahId: 'demo-penceramah-1', kitabId: 'demo-kitab-1', topic: 'Bab Sabar (siri 13)', status: 'aktif' },
      { id: 'demo-kuliah-5', date: d(5), slot: 'subuh', time: '06:15', label: 'Kuliah Subuh', penceramahId: 'demo-penceramah-2', topic: 'Adab Bermasyarakat', status: 'batal' },
      { id: 'demo-kuliah-6', date: d(6), slot: 'maghrib', time: '19:30', label: 'Kuliah Maghrib', penceramahId: 'demo-penceramah-3', topic: 'Sirah Nabawiyah: Hijrah ke Madinah', status: 'aktif' },
    ],
    pengumuman: [
      { id: 'demo-pengumuman-1', title: 'Gotong-royong perdana surau', body: 'Semua jemaah dijemput hadir pada hari Sabtu ini selepas Subuh. Sarapan disediakan. Sila bawa sarung tangan sendiri.', from: d(-1), to: d(10), priority: 1 },
      { id: 'demo-pengumuman-2', title: 'Kelas mengaji dewasa', body: 'Kelas mengaji dewasa diadakan setiap malam Selasa dan Khamis selepas Isyak di ruang legar tingkat bawah.', from: d(-1), to: d(30), priority: 2 },
    ],
    ticker: [
      { id: 'demo-ticker-1', text: 'Kutipan derma ruang wuduk baharu dibuka setiap hari selepas solat Maghrib.', from: d(-1), to: d(30) },
      { id: 'demo-ticker-2', text: 'Sumbangan untuk tabung anak yatim boleh disalurkan melalui tabung di pintu masuk utama.', from: d(-1), to: d(30) },
    ],
    poster: [
      { id: 'demo-poster-1', title: 'Poster 1', assetId: assets.poster1, days: ['umum'], order: 1 },
      { id: 'demo-poster-2', title: 'Poster 2', assetId: assets.poster2, days: ['umum'], order: 2 },
      { id: 'demo-poster-3', title: 'Poster Jumaat', assetId: assets.poster3, days: ['jumaat'], order: 3 },
    ],
    programKhas: [
      { id: 'demo-program-1', title: 'Majlis Khatam Al-Quran dan Jamuan Kesyukuran', at: `${d(3)}T20:30`, showFrom: d(-1), showTo: d(3), assetId: assets.program1, note: 'Jamuan ringan disediakan selepas majlis.', status: 'aktif' },
    ],
    takwim: [
      { id: 'demo-takwim-1', date: d(4), title: 'Mesyuarat AJK bulanan' },
      { id: 'demo-takwim-2', date: d(11), title: 'Kelas Fardu Ain untuk jemaah dewasa' },
      { id: 'demo-takwim-3', date: d(20), title: 'Kursus pengurusan jenazah' },
    ],
    hadis: HADIS.map(({ id, ...rest }, n) => ({ id, ...rest, shown: true, order: n * 1000 })),
    worldTime: [
      { id: 'demo-world-1', city: 'Makkah', tz: 'Asia/Riyadh', order: 1 },
      { id: 'demo-world-2', city: 'Jakarta', tz: 'Asia/Jakarta', order: 2 },
      { id: 'demo-world-3', city: 'London', tz: 'Europe/London', order: 3 },
      { id: 'demo-world-4', city: 'Tokyo', tz: 'Asia/Tokyo', order: 4 },
    ],
    petugas: [
      { id: 'demo-petugas-1', name: 'Haji Rosli Hamid', photoAssetId: assets.penceramah1 },
      { id: 'demo-petugas-2', name: 'Encik Faizal Karim', photoAssetId: assets.penceramah3 },
      { id: 'demo-petugas-3', name: 'Ustaz Zaidi Musa' },
      { id: 'demo-petugas-4', name: 'Encik Azman Idris' },
    ],
    tugasan: [
      { id: 'demo-tugasan-1', date: d(0), role: 'imam', petugasId: 'demo-petugas-1' },
      { id: 'demo-tugasan-2', date: d(0), role: 'bilal', petugasId: 'demo-petugas-2' },
      { id: 'demo-tugasan-3', date: d(0), role: 'ajk', petugasId: 'demo-petugas-4' },
      { id: 'demo-tugasan-4', date: d(2), role: 'imam', petugasId: 'demo-petugas-3' },
      { id: 'demo-tugasan-5', date: d(2), role: 'bilal', petugasId: 'demo-petugas-2' },
      { id: 'demo-tugasan-6', date: d(2), role: 'khatib', petugasId: 'demo-petugas-3', note: 'Khutbah Jumaat' },
    ],
    zikir: ZIKIR.map(([textAr, textMs, repeat], i) => ({
      id: `demo-zikir-${i + 1}`,
      order: i + 1,
      textAr,
      textMs,
      ...(repeat ? { repeat } : {}),
    })),
    tilawahSlot: [
      { id: 'demo-tilawah-1', days: ['jumaat'], before: 'subuh', minutesBefore: 30, surah: 18, enabled: true },
    ],
  };
  return content;
}

/** Order matters: referenced kinds (penceramah, kitab, petugas) go before the kinds that point at them. */
const KIND_ORDER = [
  'penceramah', 'kitab', 'kuliah', 'pengumuman', 'ticker', 'poster', 'programKhas', 'takwim',
  'hadis', 'worldTime', 'petugas', 'tugasan', 'zikir', 'tilawahSlot',
];
const IMAGE_MIME = 'image/png';

/**
 * Upload the pictures and write all demo content through the API. `box` is { api, json } from signInAdmin.
 * Returns { assets, counts }. Throws on the first API refusal (status and the box's message only).
 */
export async function seedContent(box, { today = klToday() } = {}) {
  // Surau identity + help contact (invented; shown on enrolment/unlock screens and the kiosk).
  const info = await box.json('PUT', '/api/settings/surauInfo', {
    name: 'Surau D\'Waqaf',
    kind: 'surau',
    shortAddress: 'Taman Seri Murni, Shah Alam',
    helpName: 'Encik Ahmad (Setiausaha)',
    helpPhone: '012-345 6789',
    helpEmail: 'setiausaha@example.my',
  });
  if (!info.ok) throw new Error(`PUT settings/surauInfo -> ${info.status} ${JSON.stringify(info.data?.errors ?? info.data)}`);
  const images = makeImages();
  const assets = {};
  for (const [name, png] of Object.entries(images)) {
    const res = await box.api('/api/assets', { method: 'POST', headers: { 'content-type': IMAGE_MIME }, body: png });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`upload ${name} -> ${res.status} ${JSON.stringify(body.errors ?? body)}`);
    assets[name] = body.id;
  }
  const content = demoContent(today, assets);
  const counts = {};
  for (const kind of KIND_ORDER) {
    for (const item of content[kind]) {
      const { id, ...rest } = item;
      const r = await box.json('PUT', `/api/content/${kind}/${id}`, rest);
      if (!r.ok) throw new Error(`PUT ${kind}/${id} -> ${r.status} ${JSON.stringify(r.data?.errors ?? r.data)}`);
    }
    counts[kind] = content[kind].length;
  }
  return { assets, counts, today };
}

// ---------------------------------------------------------------------------------------------
// Command line.
// ---------------------------------------------------------------------------------------------

function parseCli(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (key === 'bootstrap') {
      out.bootstrap = true;
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`a value is needed for ${a}`);
    out[key] = v;
    i++;
  }
  return out;
}

async function main() {
  const args = parseCli(process.argv.slice(2));
  let payload = args.payload ?? process.env.SURAU_ENROL_PAYLOAD;
  if (args.bootstrap) {
    if (!args.db || !args.data || !args.box) throw new Error('--bootstrap needs --db, --data and --box');
    payload = bootstrapAdmin({ dbPath: resolve(args.db), dataDir: resolve(args.data), box: args.box });
  }
  if (!payload) {
    throw new Error('give --payload "surau1:..." (or SURAU_ENROL_PAYLOAD), or use --bootstrap --db --data --box');
  }
  const box = await signInAdmin(payload);
  if (!box.roles.includes('admin')) throw new Error('the enrolling user is not an admin');
  const today = args.today ?? klToday();
  const { counts } = await seedContent(box, { today });
  console.log(`Seeded the demo surau for ${today} as ${box.session.user.name}:`);
  for (const [kind, n] of Object.entries(counts)) console.log(`  ${kind.padEnd(12)} ${n}`);
  console.log('  pictures     9 generated PNG assets');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(`seed failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
