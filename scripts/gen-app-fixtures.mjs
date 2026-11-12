// Generates fixtures for apps/surau-app from the box's own code and Node crypto.
// Usage (from the worktree root):
//   node scripts/gen-app-fixtures.mjs             registry.g.dart + settings-cases.json (deterministic)
//   node scripts/gen-app-fixtures.mjs --registry  registry.g.dart + settings-cases.json only
//   node scripts/gen-app-fixtures.mjs --content   content-cases.json only (deterministic)
//   node scripts/gen-app-fixtures.mjs --vectors   unlock vectors (random key, differs every run)
import { generateKeyPairSync, sign, createPrivateKey, randomBytes, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vectorsDir = join(root, 'apps', 'surau-app', 'test', 'fixtures', 'vectors');

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function pickJwks() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const priv = privateKey.export({ format: 'jwk' });
  const publicJwk = { kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y };
  const privateJwk = { ...publicJwk, d: priv.d };
  return { privateKey, publicJwk, privateJwk };
}

/** Find a signature whose r or s satisfies `want` (leading zero byte / high bit) for the DER edge cases. */
function findDerCase(privateKey, want) {
  for (let i = 0; i < 200000; i++) {
    const msg = randomBytes(24);
    const p1363 = sign('sha256', msg, { key: privateKey, dsaEncoding: 'ieee-p1363' });
    const r = p1363.subarray(0, 32);
    const s = p1363.subarray(32);
    if (!want(r, s)) continue;
    // Encode the P1363 (r, s) to DER by hand so both forms describe the same signature.
    return { derHex: encodeDer(r, s).toString('hex'), p1363Hex: p1363.toString('hex') };
  }
  throw new Error('no signature found for edge case');
}

function derInt(bytes) {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  let v = bytes.subarray(i);
  if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
  return Buffer.concat([Buffer.from([0x02, v.length]), v]);
}

function encodeDer(r, s) {
  const body = Buffer.concat([derInt(r), derInt(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

function writeVectors() {
  mkdirSync(vectorsDir, { recursive: true });
  const { privateKey, publicJwk, privateJwk } = pickJwks();
  const boxId = 'a1b2c3d4e5f60718';
  const deviceId = 'dev1';
  const nonce = 'nonce';
  const message = Buffer.from(`surau-unlock\n${boxId}\n${deviceId}\n${nonce}`, 'utf8');
  const sig = sign('sha256', message, { key: createPrivateKey({ key: privateJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  if (sig.length !== 64) throw new Error('unexpected signature length');

  const derCases = [
    { name: 'plain', ...findDerCase(privateKey, (r, s) => r[0] < 0x80 && r[0] !== 0 && s[0] < 0x80 && s[0] !== 0) },
    { name: 'high-bit-r', ...findDerCase(privateKey, (r, s) => r[0] >= 0x80 && s[0] < 0x80 && s[0] !== 0) },
    { name: 'high-bit-s', ...findDerCase(privateKey, (r, s) => s[0] >= 0x80 && r[0] < 0x80 && r[0] !== 0) },
    { name: 'high-bit-both', ...findDerCase(privateKey, (r, s) => r[0] >= 0x80 && s[0] >= 0x80) },
    { name: 'leading-zero-r', ...findDerCase(privateKey, (r, s) => r[0] === 0 && s[0] < 0x80 && s[0] !== 0) },
    { name: 'leading-zero-s', ...findDerCase(privateKey, (r, s) => s[0] === 0 && r[0] < 0x80 && r[0] !== 0) },
  ];

  const out = {
    boxId,
    deviceId,
    nonce,
    messageHex: message.toString('hex'),
    publicJwk,
    privateJwk, // throwaway test key, never used anywhere else
    signatureB64url: b64url(sig),
    derCases, // (r, s) from Node P1363 signatures re-encoded to DER, with the expected 64-byte form
  };
  writeFileSync(join(vectorsDir, 'node-signed.json'), JSON.stringify(out, null, 2) + '\n');
  console.log('wrote', join(vectorsDir, 'node-signed.json'));
}

// ---- registry + settings cases (deterministic: running twice changes nothing) ----

const appDir = join(root, 'apps', 'surau-app');
const coreSources = ['features/registry.ts', 'features/settings.ts', 'auth/permissions.ts', 'features/meta.ts', 'features/lists.ts'].map((f) =>
  join(root, 'packages', 'core', 'src', f),
);

/** sha256 over the five core sources (CRLF normalised); the Dart test recomputes it. */
function coreSourceHash() {
  const h = createHash('sha256');
  for (const f of coreSources) h.update(readFileSync(f, 'utf8').replace(/\r\n/g, '\n'));
  return h.digest('hex');
}

const dartStr = (s) =>
  "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$').replace(/\n/g, '\\n') + "'";

function dartValue(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return dartStr(v);
  if (Array.isArray(v)) return '[' + v.map(dartValue).join(', ') + ']';
  return '{' + Object.entries(v).map(([k, x]) => `${dartStr(k)}: ${dartValue(x)}`).join(', ') + '}';
}

async function writeRegistry() {
  const core = await import('@surau/core');
  const {
    FEATURES, PERMISSIONS, ROLES, ROLE_LABELS_MS, ROLE_LABELS_EN, validateFeatureSettings,
    FIELD_META, FEATURE_DESC, SURAHS, HIJRI_MONTHS, RECITERS, SYSTEM_FEATURES, ORDERED_FEATURES, LANJUTAN_ROWS,
  } = core;
  const hash = coreSourceHash();

  const feats = FEATURES.map(
    (f) =>
      `  FeatureDef(\n    key: ${dartStr(f.key)},\n    group: ${dartStr(f.group)},\n    locked: ${f.locked},\n` +
      `    defaultEnabled: ${f.defaultEnabled},\n    labelMs: ${dartStr(f.labelMs)},\n    labelEn: ${dartStr(f.labelEn)},\n` +
      `    defaults: <String, Object?>${dartValue(f.defaults)},\n  ),`,
  );
  const perms = ROLES.map(
    (r) => `  ${dartStr(r)}: [\n${PERMISSIONS[r].map((p) => `    ${dartStr(p)},`).join('\n')}\n  ],`,
  );
  const labels = ROLES.map((r) => `  ${dartStr(r)}: ${dartStr(ROLE_LABELS_MS[r])},`);
  const dart = [
    '// GENERATED by scripts/gen-app-fixtures.mjs from packages/core. Do not edit.',
    '// Regenerate with: node scripts/gen-app-fixtures.mjs (from the repo root).',
    '// test/features/registry_test.dart fails when core sources no longer match',
    '// [coreSourceHash].',
    '// ignore_for_file: type=lint',
    '',
    '/// One switchable feature, as core FEATURES has it.',
    'class FeatureDef {',
    '  const FeatureDef({',
    '    required this.key,',
    '    required this.group,',
    '    required this.locked,',
    '    required this.defaultEnabled,',
    '    required this.labelMs,',
    '    required this.labelEn,',
    '    required this.defaults,',
    '  });',
    '',
    '  final String key;',
    '  final String group;',
    '  final bool locked;',
    '  final bool defaultEnabled;',
    '  final String labelMs;',
    '  final String labelEn;',
    '',
    '  /// Default values of every setting (JSON shapes: bool, int, String, null,',
    '  /// List, Map). Does not include enabled.',
    '  final Map<String, Object?> defaults;',
    '}',
    '',
    '/// sha256 of core registry.ts, settings.ts and permissions.ts (CRLF as LF).',
    `const String coreSourceHash = ${dartStr(hash)};`,
    '',
    'const List<FeatureDef> features = [',
    feats.join('\n'),
    '];',
    '',
    '/// PERMISSIONS from core: every permission each role holds.',
    'const Map<String, List<String>> permissions = {',
    perms.join('\n'),
    '};',
    '',
    '/// ROLE_LABELS_EN from core.',
    'const Map<String, String> roleLabelsEn = {',
    ROLES.map((r) => `  ${dartStr(r)}: ${dartStr(ROLE_LABELS_EN[r])},`).join('\n'),
    '};',
    '',
    '/// FIELD_META from core: feature key -> leaf path -> metadata (ui, step, min, max, choices, ...).',
    `const Map<String, Map<String, Map<String, Object?>>> fieldMetaTable = ${dartValue(FIELD_META)};`,
    '',
    '/// FEATURE_DESC from core: feature key -> {ms, en, keywords}.',
    `const Map<String, Map<String, Object?>> featureDescTable = ${dartValue(FEATURE_DESC)};`,
    '',
    '/// SURAHS from core: [number, name, verse count].',
    `const List<List<Object>> surahs = ${dartValue(SURAHS.map((x) => [x.n, x.nameMs, x.ayat]))};`,
    '',
    '/// HIJRI_MONTHS from core.',
    `const List<String> hijriMonthsMs = ${dartValue(HIJRI_MONTHS.ms)};`,
    `const List<String> hijriMonthsEn = ${dartValue(HIJRI_MONTHS.en)};`,
    '',
    '/// RECITERS from core: [folder, name, style].',
    `const List<List<String>> reciters = ${dartValue(RECITERS.map((x) => [x.folder, x.name, x.styleMs]))};`,
    '',
    `const List<String> systemFeatures = ${dartValue(SYSTEM_FEATURES)};`,
    `const List<String> orderedFeatures = ${dartValue(ORDERED_FEATURES)};`,
    '',
    '/// LANJUTAN_ROWS from core.',
    `const List<Map<String, Object?>> lanjutanRows = ${dartValue(LANJUTAN_ROWS)};`,
    '',
    '/// ROLE_LABELS_MS from core.',
    'const Map<String, String> roleLabelsMs = {',
    labels.join('\n'),
    '};',
    '',
  ].join('\n');
  const libDir = join(appDir, 'lib', 'features');
  mkdirSync(libDir, { recursive: true });
  writeFileSync(join(libDir, 'registry.g.dart'), dart);
  console.log('wrote', join(libDir, 'registry.g.dart'));

  // ---- cases; `ok` always comes from core's own validator ----
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const isPlain = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
  const leaves = (obj, path = []) => {
    const out = [];
    for (const [k, v] of Object.entries(obj)) {
      if (isPlain(v)) out.push(...leaves(v, [...path, k]));
      else out.push({ path: [...path, k], value: v });
    }
    return out;
  };
  const build = (path, value) => {
    const top = {};
    let cur = top;
    path.forEach((k, i) => {
      if (i === path.length - 1) cur[k] = value;
      else cur = cur[k] = {};
    });
    return top;
  };

  const cases = [];
  for (const f of FEATURES) {
    const add = (note, patch) => {
      const p = clone(patch);
      cases.push({ key: f.key, note, patch: p, ok: validateFeatureSettings(f.key, p).ok });
    };
    const okAt = (path, v) => validateFeatureSettings(f.key, build(path, v)).ok;
    add('defaults', f.defaults);
    add('reset', { enabled: f.defaultEnabled, ...f.defaults });
    add('enabled true', { enabled: true });
    add('enabled false', { enabled: false });
    add('enabled not bool', { enabled: 'yes' });
    add('unknown key', { zzUnknown: 1 });
    for (const [k, v] of Object.entries(f.defaults)) {
      if (isPlain(v)) {
        add(`unknown nested key under ${k}`, { [k]: { zzUnknown: 1 } });
        add(`${k} not an object`, { [k]: 5 });
      }
    }
    for (const { path, value } of leaves(f.defaults)) {
      const name = path.join('.');
      if (typeof value === 'number') {
        // Find the accepted interval by probing core itself (its rules are not exported).
        let ok = value;
        let step = 1;
        while (okAt(path, ok - step) && step < 1e8) { ok -= step; step *= 2; }
        let bad = ok - step;
        while (ok - bad > 1) { const mid = Math.floor((ok + bad) / 2); if (okAt(path, mid)) ok = mid; else bad = mid; }
        const min = ok;
        ok = value; step = 1;
        while (okAt(path, ok + step) && step < 1e8) { ok += step; step *= 2; }
        bad = ok + step;
        while (bad - ok > 1) { const mid = Math.floor((ok + bad) / 2); if (okAt(path, mid)) ok = mid; else bad = mid; }
        const max = ok;
        add(`${name} min`, build(path, min));
        add(`${name} max`, build(path, max));
        add(`${name} min-1`, build(path, min - 1));
        add(`${name} max+1`, build(path, max + 1));
        add(`${name} fraction`, build(path, min + 0.5));
        add(`${name} as text`, build(path, String(value)));
        add(`${name} null`, build(path, null));
      } else if (typeof value === 'boolean') {
        add(`${name} flipped`, build(path, !value));
        add(`${name} as text`, build(path, 'true'));
      } else if (typeof value === 'string' || value === null) {
        add(`${name} wrong value`, build(path, 'zzz-wrong'));
        add(`${name} empty`, build(path, ''));
        add(`${name} 501 chars`, build(path, 'a'.repeat(501)));
        add(`${name} 500 chars`, build(path, 'a'.repeat(500)));
        add(`${name} number`, build(path, 123));
        if (value !== null) add(`${name} null`, build(path, null));
      } else if (Array.isArray(value)) {
        add(`${name} dot dot`, build(path, ['../x']));
        add(`${name} upper case`, build(path, ['Upper']));
        add(`${name} upload`, build(path, ['/uploads/photo-1.jpg']));
        add(`${name} upload bad`, build(path, ['/uploads/a/b.jpg']));
        add(`${name} box id`, build(path, ['a1b2c3d4'.repeat(8)]));
        add(`${name} box id too long`, build(path, ['a1b2c3d4'.repeat(8) + '0']));
        add(`${name} box id upper case`, build(path, ['A1B2C3D4'.repeat(8)]));
        add(`${name} 21 items`, build(path, Array.from({ length: 21 }, (_, i) => `img-${i}`)));
        add(`${name} 20 items`, build(path, Array.from({ length: 20 }, (_, i) => `img-${i}`)));
        add(`${name} empty list`, build(path, []));
        add(`${name} not a list`, build(path, 'default-1'));
        add(`${name} item not text`, build(path, [1]));
      }
    }
    if (f.key === 'surauInfo') {
      // The logo is the one setting that may hold an adjusted image (image.ts).
      const A = 'a'.repeat(64);
      const rect = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 };
      const logoCases = [
        ['asset only', { asset: A }],
        ['crop', { asset: A, crop: rect }],
        ['every adjustment', { asset: A, crop: rect, bg: 'card', rotate: 270, square: rect }],
        ['bg remove', { asset: A, bg: 'remove' }],
        ['bad bg', { asset: A, bg: 'blue' }],
        ['bad rotate', { asset: A, rotate: 45 }],
        ['rotate as text', { asset: A, rotate: '90' }],
        ['crop out of range', { asset: A, crop: { x: 0.6, y: 0, w: 0.5, h: 0.5 } }],
        ['crop empty', { asset: A, crop: { x: 0, y: 0, w: 0, h: 0.5 } }],
        ['crop too small', { asset: A, crop: { x: 0, y: 0, w: 0.001, h: 0.5 } }],
        ['crop huge', { asset: A, crop: { x: 0, y: 0, w: 1e9, h: 1e9 } }],
        ['crop extra key', { asset: A, crop: { ...rect, z: 1 } }],
        ['crop missing h', { asset: A, crop: { x: 0, y: 0, w: 0.5 } }],
        ['square out of range', { asset: A, square: { x: 0.9, y: 0, w: 0.5, h: 0.5 } }],
        ['extra key', { asset: A, extra: 1 }],
        ['bad asset', { asset: 'xyz' }],
        ['no asset', { crop: rect }],
        ['list', [A]],
      ];
      for (const [note, logo] of logoCases) add(`logo image: ${note}`, { logo });
    }
  }
  // Cross-field cases: the patch is checked against a stored copy (`current`). The Dart twin reads them from A5 on.
  const crossCases = [];
  const cross = (note, key, patch, current) =>
    crossCases.push({ key, note, patch, current, ok: validateFeatureSettings(key, patch, current).ok });
  cross('ayat range too long', 'ayatCard', { ayatFrom: 10, ayatTo: 20 }, { surah: 2 });
  cross('ayat range 5 verses', 'ayatCard', { ayatFrom: 252, ayatTo: 256 }, { surah: 2 });
  cross('ayat range 6 verses', 'ayatCard', { ayatFrom: 251, ayatTo: 256 }, { surah: 2 });
  cross('ayat inside the stored surah', 'ayatCard', { ayatFrom: 255, ayatTo: 256 }, { surah: 2 });
  cross('ayat beyond the surah', 'ayatCard', { surah: 1, ayatTo: 8 }, { ayatFrom: 1 });
  cross('ayat whole short surah', 'ayatCard', { surah: 1, ayatFrom: 3, ayatTo: 7 }, {});
  cross('ayat from after to', 'ayatCard', { ayatFrom: 5, ayatTo: 3 }, { surah: 2 });
  const fixDir = join(appDir, 'test', 'fixtures');
  mkdirSync(fixDir, { recursive: true });
  writeFileSync(join(fixDir, 'settings-cases.json'), JSON.stringify({ coreSourceHash: hash, cases, crossCases }, null, 1) + '\n');
  console.log('wrote', join(fixDir, 'settings-cases.json'), cases.length, 'cases');
}

// ---- content cases (deterministic): every answer comes from core's validateContent ----

const contentSources = ['content/schema.ts', 'content/types.ts'].map((f) => join(root, 'packages', 'core', 'src', f));

/** sha256 over core's content schema and types (CRLF normalised); kinds_test.dart recomputes it. */
function contentSourceHash() {
  const h = createHash('sha256');
  for (const f of contentSources) h.update(readFileSync(f, 'utf8').replace(/\r\n/g, '\n'));
  return h.digest('hex');
}

const ASSET_ID = 'a'.repeat(64);

/** One complete, valid item per kind (every optional field filled). */
const VALID_ITEMS = {
  penceramah: { name: 'Ustaz Ahmad Fauzi', title: 'Ustaz', phone: '012-345 6789', photoAssetId: ASSET_ID },
  kitab: { title: 'Riyadhus Salihin', author: 'Imam an-Nawawi', coverAssetId: ASSET_ID },
  kuliah: {
    date: '2026-11-05',
    slot: 'maghrib',
    time: '19:15',
    label: 'Kuliah Maghrib',
    penceramahId: 'p1',
    kitabId: 'k1',
    topic: 'Bab sabar',
    status: 'aktif',
    seriesId: 's1',
  },
  pengumuman: { title: 'Gotong-royong', body: 'Sabtu ini selepas Subuh.', from: '2026-11-01', to: '2026-11-07', priority: 2 },
  ticker: { text: 'Selamat datang ke surau kami', from: '2026-11-01', to: '2026-11-30' },
  poster: { title: 'Poster Maulidur Rasul', assetId: ASSET_ID, days: ['umum', 'jumaat'], from: '2026-11-01', to: '2026-11-30', order: 1 },
  programKhas: {
    title: 'Majlis Maulidur Rasul',
    at: '2026-11-20T20:30',
    showFrom: '2026-11-10',
    showTo: '2026-11-20',
    assetId: ASSET_ID,
    note: 'Jamuan disediakan',
    status: 'aktif',
  },
  takwim: { date: '2026-12-25', hijriLabel: '14 Rejab 1448', title: 'Hari Keputeraan Sultan', assetId: ASSET_ID },
  hadis: { textMs: 'Sesungguhnya amalan itu dengan niat.', textAr: 'إنما الأعمال بالنيات', source: 'Riwayat al-Bukhari' },
  worldTime: { city: 'Makkah', tz: 'Asia/Riyadh', order: 1 },
  petugas: { name: 'Encik Hafiz', photoAssetId: ASSET_ID },
  tugasan: { date: '2026-11-06', role: 'imam', petugasId: 'g1', note: 'Solat Jumaat' },
  zikir: { order: 1, textAr: 'سبحان الله', textMs: 'Maha Suci Allah', repeat: 33 },
  tilawahSlot: { days: ['daily'], before: 'subuh', minutesBefore: 20, surah: 18, enabled: true },
};

/** Fields the Dart side treats as optional: a sibling case drops each one. */
const OPTIONAL = {
  penceramah: ['title', 'phone', 'photoAssetId'],
  kitab: ['author', 'coverAssetId'],
  kuliah: ['kitabId', 'topic', 'seriesId'],
  pengumuman: [],
  ticker: [],
  poster: ['from', 'to'],
  programKhas: ['assetId', 'note'],
  takwim: ['hijriLabel', 'assetId'],
  hadis: ['textAr'],
  worldTime: [],
  petugas: ['photoAssetId'],
  tugasan: ['note'],
  zikir: ['repeat'],
  tilawahSlot: [],
};

/** Extra values worth trying per kind, on top of the generic mutations. */
const IMG_RECT = { x: 0.1, y: 0.2, w: 0.5, h: 0.5 };
/** Image-field cases (image.ts) added to every kind that has a picture field. */
const imageCases = (field) => [
  [field, { asset: ASSET_ID }],
  [field, { asset: ASSET_ID, crop: IMG_RECT, bg: 'remove', rotate: 90 }],
  [field, { asset: ASSET_ID, square: IMG_RECT }],
  [field, { asset: ASSET_ID, crop: { x: 0.6, y: 0, w: 0.5, h: 0.5 } }],
  [field, { asset: ASSET_ID, crop: { x: 0, y: 0, w: 1e9, h: 1e9 } }],
  [field, { asset: ASSET_ID, extra: 1 }],
  [field, { asset: ASSET_ID, bg: 'blue' }],
  [field, { asset: ASSET_ID, rotate: 45 }],
  [field, { asset: 'xyz' }],
];

const EXTRA = {
  kuliah: [
    ['slot', 'lain'], ['slot', 'subuh'], ['slot', 'jumaat'], ['status', 'batal'], ['status', 'cancelled'],
    ['date', '2026-02-30'], ['date', '2026-2-3'], ['date', '2026-11-05T00:00'], ['time', '24:00'], ['time', '7:15'], ['time', '23:59'],
  ],
  pengumuman: [
    ['from', '2026-11-08'], ['to', '2026-10-31'], ['priority', 1], ['priority', 3], ['priority', 0], ['priority', 4], ['priority', 1.5], ['priority', '2'],
    ['body', 'a'.repeat(2000)], ['body', 'a'.repeat(2001)], ['title', '   '],
  ],
  ticker: [['text', 'a'.repeat(300)], ['text', 'a'.repeat(301)], ['from', '2026-12-01']],
  poster: [
    ['title', 'a'.repeat(80)], ['title', 'a'.repeat(81)],
    ['days', []], ['days', ['daily']], ['days', ['umum']], ['days', ['ahad', 'isnin', 'selasa', 'rabu', 'khamis', 'jumaat', 'sabtu']],
    ['days', ['sunday']], ['days', 'umum'], ['assetId', 'A'.repeat(64)], ['assetId', 'a'.repeat(63)], ['order', 0], ['order', -1],
    ['order', 1000000], ['order', 1000001], ['from', '2026-12-01'],
  ],
  programKhas: [
    ['at', '2026-11-20T24:00'], ['at', '2026-11-20 20:30'], ['at', '2026-11-20T20:30:00'], ['showFrom', '2026-11-21'], ['status', 'batal'],
  ],
  takwim: [['date', '2026-13-01']],
  hadis: [['textMs', 'a'.repeat(2001)]],
  worldTime: [
    ['tz', 'UTC'], ['tz', 'Asia/Kuala_Lumpur'], ['tz', 'Europe/London'], ['tz', 'America/New_York'], ['tz', 'Not/AZone'],
    ['tz', 'asia/riyadh'], ['tz', 'Asia'], ['tz', 'Asia/Kuala Lumpur'], ['order', 0],
  ],
  tugasan: [['role', 'bilal'], ['role', 'khatib'], ['role', 'ajk'], ['role', 'muazzin']],
  zikir: [['repeat', 1], ['repeat', 0], ['repeat', 10000], ['repeat', 10001], ['order', 0]],
  tilawahSlot: [
    ['days', ['umum']], ['days', ['jumaat', 'sabtu']], ['days', ['weekly']], ['days', []], ['before', 'lain'], ['before', 'isyak'],
    ['minutesBefore', 1], ['minutesBefore', 0], ['minutesBefore', 120], ['minutesBefore', 121], ['surah', 1], ['surah', 114], ['surah', 115],
    ['surah', 0], ['enabled', false], ['enabled', 'true'], ['enabled', 1],
  ],
};

EXTRA.penceramah = imageCases('photoAssetId');
EXTRA.kitab = imageCases('coverAssetId');
EXTRA.petugas = imageCases('photoAssetId');
EXTRA.poster.push(...imageCases('assetId'));
EXTRA.programKhas.push(...imageCases('assetId'));
EXTRA.takwim.push(...imageCases('assetId'));

async function writeContentCases() {
  const core = await import('@surau/core');
  const { CONTENT_KINDS, validateContent } = core;
  const hash = contentSourceHash();
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const cases = [];
  const add = (kind, note, item) => {
    const it = clone(item);
    cases.push({ kind, note, item: it, ok: validateContent(kind, it).ok });
  };

  for (const kind of CONTENT_KINDS) {
    const valid = VALID_ITEMS[kind];
    if (!valid) throw new Error(`no valid sample for ${kind}`);
    add(kind, 'full', valid);
    const minimal = Object.fromEntries(Object.entries(valid).filter(([k]) => !OPTIONAL[kind].includes(k)));
    add(kind, 'minimal', minimal);
    add(kind, 'with meta keys', { ...valid, id: 'x1', updatedAt: '2026-11-04T14:30:00.000Z', updatedBy: 'user:u1' });
    add(kind, 'unknown key', { ...valid, zzUnknown: 1 });
    add(kind, 'empty object', {});
    for (const [k, v] of Object.entries(valid)) {
      const without = { ...valid };
      delete without[k];
      add(kind, `${k} missing`, without);
      const set = (note, value) => add(kind, `${k} ${note}`, { ...valid, [k]: value });
      set('null', null);
      set('number', 123);
      set('text', 'zzz-wrong');
      set('empty text', '');
      set('spaces', '   ');
      set('bool', true);
      set('list', []);
      set('object', {});
      if (typeof v === 'string') {
        set('2001 chars', 'a'.repeat(2001));
        set('trailing space', `${v} `);
      }
      if (typeof v === 'number') {
        set('fraction', v + 0.5);
        set('negative', -1);
        set('whole float', v + 0.0);
      }
    }
    for (const [k, v] of EXTRA[kind] ?? []) {
      add(kind, `${k} = ${JSON.stringify(v)}`, { ...valid, [k]: v });
    }
  }
  // Shapes that are not items at all, and a kind that does not exist.
  for (const [note, item] of [['list', []], ['text', 'kuliah'], ['null', null], ['number', 1]]) {
    const r = validateContent('kuliah', item);
    cases.push({ kind: 'kuliah', note: `item is a ${note}`, item, ok: r.ok });
  }
  cases.push({ kind: 'zzz', note: 'unknown kind', item: VALID_ITEMS.kuliah, ok: validateContent('zzz', VALID_ITEMS.kuliah).ok });

  const fixDir = join(appDir, 'test', 'fixtures');
  mkdirSync(fixDir, { recursive: true });
  writeFileSync(join(fixDir, 'content-cases.json'), JSON.stringify({ contentSourceHash: hash, kinds: CONTENT_KINDS, cases }, null, 1) + '\n');
  console.log('wrote', join(fixDir, 'content-cases.json'), cases.length, 'cases');
}

// ---- hadis parity vectors (deterministic): the app's hadis_rules.dart must give the same answers ----

async function writeHadisCases() {
  const core = await import('@surau/core');
  const { hadisLength, gradeOf, attributionOf, providerItemId, hadisParts } = core;
  const sentence = (n) => `${'Kata'.repeat(n)}.`;
  const partsA = [sentence(30), sentence(30), sentence(30), sentence(30)].join(' ');
  const partsB = `${'a'.repeat(450)} ${'b'.repeat(100)}.`;
  const cases = [
    { fn: 'hadisLength', input: 'a'.repeat(220), expect: hadisLength('a'.repeat(220)) },
    { fn: 'hadisLength', input: 'a'.repeat(221), expect: hadisLength('a'.repeat(221)) },
    { fn: 'hadisLength', input: 'a'.repeat(520), expect: hadisLength('a'.repeat(520)) },
    { fn: 'hadisLength', input: 'a'.repeat(521), expect: hadisLength('a'.repeat(521)) },
    { fn: 'gradeOf', input: 'صحيح', expect: gradeOf('صحيح') },
    { fn: 'gradeOf', input: 'صحيح لغيره', expect: gradeOf('صحيح لغيره') },
    { fn: 'gradeOf', input: 'ضعيف جدا', expect: gradeOf('ضعيف جدا') },
    { fn: 'attributionOf', input: 'رواه البخاري ومسلم', expect: attributionOf('رواه البخاري ومسلم') },
    { fn: 'attributionOf', input: 'رواه أبو داود والترمذي', expect: attributionOf('رواه أبو داود والترمذي') },
    { fn: 'attributionOf', input: 'رواه فلان', expect: attributionOf('رواه فلان') },
    { fn: 'providerItemId', input: '66512', expect: providerItemId('hadeethenc', '66512') },
    { fn: 'hadisParts', input: partsA, max: 400, expect: hadisParts(partsA, 400) },
    { fn: 'hadisParts', input: partsB, max: 400, expect: hadisParts(partsB, 400) },
  ];
  // What the TV does with a hadis: the app's hadis_tv_rules.dart must give the same answers.
  const { hadisTier, hadisPlan, hadisPool } = core;
  const ar = 'إِنَّمَا الْأَعْمَالُ بِالنِّيَّاتِ، وَإِنَّمَا لِكُلِّ امْرِئٍ مَا نَوَى';
  const texts = {
    short: 'Senyumanmu di hadapan saudaramu adalah sedekah.',
    medium: `${'Sesungguhnya setiap amalan itu bergantung kepada niat. '.repeat(3).trim()}`,
    long: `${'Daripada Abu Hurairah, beliau berkata: Rasulullah bersabda dengan panjang lebar tentang amalan. '.repeat(14).trim()}`,
  };
  const intro = 'Daripada Abu Hurairah, beliau berkata:';
  const planInputs = [
    { textMs: texts.short },
    { textMs: texts.short, textAr: ar },
    { textMs: texts.medium, textAr: ar },
    { textMs: texts.long, textAr: ar, intro },
    { textMs: texts.long },
  ];
  const planSettings = [{}, { showArabic: false }, { fontSize: 's' }, { fontSize: 'm' }, { fontSize: 'l' }];
  const tierCases = [];
  for (const h of planInputs) {
    for (const from of ['l', 'm', 's']) tierCases.push({ textMs: h.textMs, textAr: h.textAr ?? null, from, expect: hadisTier(h.textMs, h.textAr, from) });
  }
  const planCases = [];
  for (const h of planInputs) for (const s of planSettings) planCases.push({ item: h, settings: s, expect: hadisPlan(h, s) });
  const t = '2026-11-09T01:00:00.000Z';
  const own = (id, order, extra = {}) => ({ id, updatedAt: t, updatedBy: 'user:u1', textMs: `Teks ${id}.`, source: 'Riwayat Muslim', ...(order === null ? {} : { order }), ...extra });
  const prov = (id, order, grade = 'sahih', extra = {}) => ({
    id: `hadeethenc-${id}`, updatedAt: t, updatedBy: 'user:u1', textMs: `Teks ${id}.`, source: 'Muttafaq alaih', grade, order,
    ext: { provider: 'hadeethenc', id: String(id), attributionAr: 'رواه مسلم', gradeAr: 'صحيح', categories: [], fetchedAt: t, digest: 'a'.repeat(64) }, ...extra,
  });
  const poolItems = [
    own('s1', 1000), prov(1, 2000), own('s2', 3000), prov(2, 4000, 'hasan'), own('s3', 5000, { shown: false }), prov(3, 6000, 'hasan_lighairihi'),
    prov(4, 7000), own('s4', null), own('s5', 8000), prov(5, 9000, 'dhaif'), prov(6, 10000, 'sahih', { shown: false }),
    // a newer blocked grade found by the update check: out of the pool though shown stays on
    prov(7, 11000, 'sahih', { ext: { provider: 'hadeethenc', id: '7', attributionAr: 'رواه مسلم', gradeAr: 'صحيح', categories: [], fetchedAt: t, digest: 'a'.repeat(64), blocked: true } }),
  ];
  const grades = { sahih: true, hasan: true, sahih_lighairihi: false, hasan_lighairihi: false };
  const poolSettings = [
    { source: 'both', mix: 'list', changeEvery: 'card', allowedGrades: grades },
    { source: 'own', mix: 'list', changeEvery: 'card', allowedGrades: grades },
    { source: 'hadeethenc', mix: 'list', changeEvery: 'card', allowedGrades: { ...grades, hasan_lighairihi: true } },
    { source: 'both', mix: 'alternate', changeEvery: 'card', allowedGrades: grades },
    { source: 'own', mix: 'alternate', changeEvery: 'card', allowedGrades: grades },
    { source: 'both', mix: 'random', changeEvery: 'card', allowedGrades: grades },
    { source: 'both', mix: 'list', changeEvery: 'day', perDay: 3, allowedGrades: grades },
    { source: 'both', mix: 'random', changeEvery: 'day', perDay: 2, allowedGrades: grades },
    { source: 'both', mix: 'list', changeEvery: 'day', perDay: 10, allowedGrades: grades },
  ];
  const poolCases = [];
  for (const settings of poolSettings) {
    for (const today of ['2026-11-09', '2026-11-10', '2027-03-01']) {
      poolCases.push({ settings, today, expect: hadisPool(poolItems, settings, today).map((h) => h.id) });
    }
  }
  // A list bigger than the card cap (50): the TV is shipped a window of it, a new window each day.
  const poolBigItems = Array.from({ length: 120 }, (_, i) => (i % 3 === 0 ? prov(1000 + i, (i + 1) * 1000) : own(`b${String(i).padStart(3, '0')}`, (i + 1) * 1000)));
  const poolBigCases = [];
  for (const settings of [
    { source: 'both', mix: 'list', changeEvery: 'card', allowedGrades: grades },
    { source: 'both', mix: 'random', changeEvery: 'card', allowedGrades: grades },
    { source: 'both', mix: 'alternate', changeEvery: 'card', allowedGrades: grades },
    { source: 'own', mix: 'list', changeEvery: 'card', allowedGrades: grades },
    { source: 'both', mix: 'list', changeEvery: 'day', perDay: 3, allowedGrades: grades },
  ]) {
    for (const today of ['2026-11-09', '2026-11-10', '2026-11-11', '2027-03-01']) {
      poolBigCases.push({ settings, today, expect: hadisPool(poolBigItems, settings, today).map((h) => h.id) });
    }
  }
  const text = JSON.stringify({ cases, tv: { tierCases, planCases, poolItems, poolCases, poolBigItems, poolBigCases } }, null, 1) + '\n';
  for (const dir of [join(root, 'packages', 'core', 'test', 'fixtures'), join(appDir, 'test', 'fixtures')]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hadis-cases.json'), text);
    console.log('wrote', join(dir, 'hadis-cases.json'), cases.length, 'cases');
  }
}

const args = new Set(process.argv.slice(2));
const known = new Set(['--vectors', '--registry', '--content', '--hadis']);
if ([...args].some((a) => !known.has(a))) {
  console.error('usage: node scripts/gen-app-fixtures.mjs [--registry] [--content] [--hadis] [--vectors]');
  process.exit(2);
}
if (args.has('--vectors')) writeVectors();
if (args.has('--registry') || args.size === 0) {
  await writeRegistry();
  // Plan 7: the finance ledger vectors core and the app both test against.
  copyFileSync(join(root, 'packages', 'core', 'test', 'fixtures', 'finance-vectors.json'), join(appDir, 'test', 'fixtures', 'finance-vectors.json'));
}
if (args.has('--content') || args.size === 0) await writeContentCases();
if (args.has('--hadis') || args.size === 0) await writeHadisCases();
