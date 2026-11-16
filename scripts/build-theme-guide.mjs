// Builds the theme author guide (BM and EN) as self-contained web pages, and as PDF with --pdf.
//
//   node scripts/build-theme-guide.mjs [--shots <dir>] [--pdf] [--out <dir>]
//
// The prose lives in docs/guide/tema/panduan-tema.ms.html and theme-guide.en.html, with slots written as
// <!--slot:NAME-->. Every table that states the contract (screen ids, hooks, variables, limits, refusal sentences,
// Chrome 91 warnings, the protected rule) is generated here from the code itself, so the guide cannot drift:
// a constant that moved or a hook that vanished stops the build instead of printing a stale table.
//
// --shots names a folder of scripts/template-shots.mjs output taken with SHOT_SIZE=960x540@1 (creative: every state,
// plus creative-normal-regions.png; every theme: biasa). Without it the build takes them itself into ui-preview/guide-shots.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { ACCENT_SWATCHES, KIOSK_TEMPLATE_IDS, PROTECTED, SCALE_FACTOR, SCREEN_GROUP, SCREEN_IDS, SCREEN_STYLE_KEYS, THEME_CONTRACT, THEME_NAME_RE, THEME_TITLES } from '../packages/core/src/index.ts';
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE } from '../apps/box-server/src/assets/store.ts';
import { writeStoredZip } from '../apps/box-server/src/files/zipWrite.ts';
import { BOX_SCREEN_IDS, checkCss, MAX_PACK_Z_INDEX } from '../apps/box-server/src/themes/cssCheck.ts';
import {
  MAX_CSS_BYTES, MAX_PACK_BYTES, MAX_PACK_FILES, MAX_PACK_INFLATED_BYTES, MAX_THEME_JSON_BYTES, MAX_TOTAL_CSS_BYTES, RESERVED_NAMES, ThemeError, readPack,
} from '../apps/box-server/src/themes/packFormat.ts';
import { INSTALL_WINDOW_MS, MAX_INSTALLS_PER_HOUR } from '../apps/box-server/src/themes/store.ts';
import { validatePack } from '../apps/box-server/src/themes/validate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const GUIDE_DIR = resolve(repo, 'docs/guide/tema');
export const MS_SRC = join(GUIDE_DIR, 'panduan-tema.ms.html');
export const EN_SRC = join(GUIDE_DIR, 'theme-guide.en.html');
export const CSS_SRC = join(GUIDE_DIR, 'guide.css');
export const SAMPLE_DIR = join(GUIDE_DIR, 'sample/hijau-siti');
export const SHOT_SIZE = '960x540@1';
export const OUT_NAMES = { ms: 'panduan-tema', en: 'theme-guide' };
export const SLOT_NAMES = ['screens', 'themes', 'regions', 'attributes', 'variables', 'arabic', 'files', 'refused', 'warnings', 'protected', 'sample'];

export const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const code = (s) => `<code>${escapeHtml(s)}</code>`;
const text = (p) => readFileSync(resolve(repo, p), 'utf8');

// ---------------------------------------------------------------------------------------------------------------
// Reading the code. Every value the guide prints is taken from here; a thing that cannot be found stops the build.

function need(cond, what) { if (!cond) throw new Error(`theme guide: ${what}`); }

/** Fails the build when a source file no longer holds a token the guide documents. */
function assertTokens(path, tokens) {
  const src = text(path);
  for (const t of tokens) need(src.includes(t), `${path} no longer holds ${t}`);
}

/** The number a `const NAME = <digits and *>;` line holds. */
function numberConst(path, name) {
  const m = new RegExp(`const ${name}\\s*=\\s*([0-9_*\\s.]+);`).exec(text(path));
  need(m !== null, `${path}: constant ${name} not found`);
  return Function(`return (${m[1].replace(/_/g, '')})`)();
}

/** The quoted words of `export type NAME = | 'a' | 'b';`. */
function unionOf(path, name) {
  const m = new RegExp(`export type ${name}\\s*=([^;]+);`).exec(text(path));
  need(m !== null, `${path}: type ${name} not found`);
  const words = [...m[1].matchAll(/'([A-Za-z_-]+)'/g)].map((x) => x[1]);
  need(words.length > 0, `${path}: type ${name} is empty`);
  return words;
}

const mb = (n) => (n >= 1024 * 1024 ? `${+(n / (1024 * 1024)).toFixed(1)} MB` : n >= 1024 ? `${+(n / 1024).toFixed(1)} KB` : `${n} bytes`);

let kioskSrcCache = null;
function kioskSource() {
  if (kioskSrcCache !== null) return kioskSrcCache;
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx|ts)$/.test(n)) out.push(readFileSync(p, 'utf8'));
    }
  };
  walk(resolve(repo, 'apps/kiosk-display/src'));
  kioskSrcCache = out.join('\n');
  return kioskSrcCache;
}

// ---------------------------------------------------------------------------------------------------------------
// Words per language.

const GROUP = { ms: { prayer: 'Solat', content: 'Kandungan', arabic: 'Arab' }, en: { prayer: 'Prayer', content: 'Content', arabic: 'Arabic' } };
const ROLE = {
  clock: { ms: 'jam', en: 'the clock' },
  prayers: { ms: 'waktu solat', en: 'the prayer times' },
  countdown: { ms: 'kiraan detik', en: 'the countdown' },
  next: { ms: 'cip waktu solat seterusnya', en: 'the next-prayer chip' },
  logo: { ms: 'logo surau (apabila surau menetapkannya)', en: 'the surau logo (when the surau has set one)' },
};
const FALLBACK_SCREEN_NAME = {
  ms: { 'tiada-data': 'Tiada data', tilawah: 'Tilawah', 'arab-ayat': 'Ayat Arab', 'arab-hadis': 'Hadis Arab', 'arab-zikir': 'Zikir Arab' },
  en: { 'tiada-data': 'No data', tilawah: 'Recitation', 'arab-ayat': 'Arabic verse', 'arab-hadis': 'Arabic hadith', 'arab-zikir': 'Arabic zikir' },
};

/** The app's own names for the screens (its l10n files), else the fallbacks above. */
function screenNames(lang) {
  let arb = {};
  try { arb = JSON.parse(text(`apps/surau-app/lib/l10n/app_${lang}.arb`)); } catch { arb = {}; }
  const out = {};
  for (const id of SCREEN_IDS) {
    const key = `themeScreen${id.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('')}`;
    out[id] = typeof arb[key] === 'string' ? arb[key] : (FALLBACK_SCREEN_NAME[lang][id] ?? id);
  }
  return out;
}

/** The harness state that shows each screen in the Creative theme (null: the harness has no picture of it yet). */
const SHOT_STATE = {
  biasa: 'biasa', azan: 'azan', 'masuk-waktu': 'masuk-waktu', iqamah: 'iqamah', solat: 'solat', jumaat: 'jumaat', 'tiada-data': 'tiada-data',
  live: null, poster: 'poster', kuliah: 'normal', program: 'program', hadis: 'hadis', zikir: null, tilawah: null,
  pengumuman: 'pengumuman', takwim: 'takwim', tabung: 'tabung', ayat: 'ayat', 'arab-ayat': null, 'arab-hadis': null, 'arab-zikir': null,
};
const SHOT_THEME = 'creative';
const THEME_IDS = RESERVED_NAMES;
const themeTitle = (id) => THEME_TITLES[id] ?? (id === 'arabic' ? 'Arabic Art' : id);

const th = (cells) => `<tr>${cells.map((c) => `<th>${c}</th>`).join('')}</tr>`;
const td = (cells) => `<tr>${cells.map((c) => (c && typeof c === 'object' ? `<td class="${c.cls}">${c.html}</td>` : `<td>${c}</td>`)).join('')}</tr>`;
const table = (head, rows) => `<div class="wrap"><table><thead>${th(head)}</thead><tbody>${rows.map(td).join('')}</tbody></table></div>`;

function picture(shots, name, alt, lang) {
  if (shots !== undefined && !existsSync(join(shots, name))) {
    return `<span class="shot-missing">${lang === 'ms' ? 'Gambar belum ada.' : 'No picture yet.'}</span>`;
  }
  return `<img src="shots/${name}" alt="${escapeHtml(alt)}" width="960" height="540">`;
}

// ---------------------------------------------------------------------------------------------------------------
// Probes: real messages from the real validator, so the refusal table is the validator's own words.

const manifest = (o = {}) => JSON.stringify({ name: 'hijau-siti', title: 'Hijau Siti', version: 3, contract: 1, base: 'creative', ...o });
const zip = (files) => writeStoredZip(Object.entries(files).map(([name, data]) => ({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(data) })));
const OK = { 'theme.json': manifest(), 'theme.css': '.stage { --accent: #0a0; }' };
const CTX = { installed: {}, contract: THEME_CONTRACT, enforceVersion: true };
const cssCtx = { file: 'theme.css', images: new Set() };

const fromRead = (buf) => { try { readPack(buf); return []; } catch (e) { if (e instanceof ThemeError) return e.issues; throw e; } };
const fromValidate = (buf, ctx = CTX) => validatePack(buf, ctx).report.errors;
const fromCss = (css) => checkCss(css, cssCtx).errors;

/** Every error code of the validator, with a way to provoke it. A code with no probe stops the build. */
const PROBES = {
  too_big: () => fromRead(Buffer.alloc(MAX_PACK_BYTES + 1)),
  not_zip: () => fromRead(Buffer.from('this is not a zip file')),
  too_many_files: () => fromRead(zip(Object.fromEntries(Array.from({ length: MAX_PACK_FILES + 1 }, (_, i) => [`images/f${i}.png`, 'x'])))),
  bad_path: () => fromRead(zip({ ...OK, 'notes.txt': 'x' })),
  missing_file: () => fromRead(zip({ 'theme.css': OK['theme.css'] })),
  bad_theme_json: () => fromRead(zip({ ...OK, 'theme.json': '{ not json' })),
  reserved_name: () => fromRead(zip({ ...OK, 'theme.json': manifest({ name: 'creative' }) })),
  needs_newer: () => fromValidate(zip({ ...OK, 'theme.json': manifest({ contract: THEME_CONTRACT + 1 }) })),
  version_not_higher: () => fromValidate(zip(OK), { ...CTX, installed: { 'hijau-siti': { version: 3 } } }),
  css_parse: () => fromCss('.region-main { color: red'),
  css_import: () => fromCss("@import 'x.css';"),
  css_url: () => fromCss(".region-main { background: url('https://example.org/a.png'); }"),
  css_script: () => fromCss('.region-main { behavior: url(x.htc); }'),
  css_box_screen: () => fromCss(".stage[data-screen='setup'] { color: red; }"),
  bad_image: () => fromValidate(zip({ ...OK, 'images/kuliah.png': 'not a picture' })),
  bad_font: () => fromRead(zip({ ...OK, 'fonts/naskh.ttf': 'a font' })),
  css_font: () => fromCss('@font-face { font-family: x; }'),
  css_property: () => fromCss('.region-clock { animation: x 1s; }'),
  css_selector: () => fromCss('.region-main::before { color: red; }'),
  css_scope: () => fromCss('body { margin: 0; }'),
  css_string: () => fromCss(".region-main { --texts: 'x'; }"),
  too_many_themes: () => fromValidate(zip(OK), { ...CTX, installed: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`t${i}`, { version: 1 }])) }),
};
/** Codes raised inside the store (not the validator): the sentences are checked against the store's source. */
const STORE_CODES = {
  too_many_installs: [
    { ms: `Terlalu banyak pemasangan tema. Had ${MAX_INSTALLS_PER_HOUR} sejam. Cuba lagi dalam sejam.`, en: `Too many theme installs. The limit is ${MAX_INSTALLS_PER_HOUR} an hour. Try again in an hour.`, find: ['Terlalu banyak pemasangan tema.', 'Too many theme installs.'] },
  ],
  storage_full: [
    { ms: 'Ruang simpanan penuh. Padam fail yang tidak digunakan.', en: 'Storage is full. Delete files that are not used.' },
    { ms: 'Ruang tema penuh. Padam tema yang tidak digunakan.', en: 'The theme space is full. Delete a theme that is not used.' },
  ],
};
const WHEN = {
  too_big: { ms: 'Fail lebih besar daripada had saiz.', en: 'The file is larger than the size limit.' },
  not_zip: { ms: 'Fail bukan zip.', en: 'The file is not a zip.' },
  too_many_files: { ms: 'Lebih banyak fail daripada had.', en: 'More files than the limit.' },
  bad_path: { ms: 'Fail di luar laluan tetap, zip dalam zip, pautan, atau dua gambar untuk satu skrin.', en: 'A file outside the fixed paths, a zip inside a zip, a link, or two pictures for one screen.' },
  missing_file: { ms: 'theme.json atau theme.css tiada.', en: 'theme.json or theme.css is missing.' },
  bad_theme_json: { ms: 'theme.json rosak atau ada medan yang salah, termasuk kunci defaults yang tidak dikenali.', en: 'theme.json is broken or a field is wrong, including an unknown defaults key.' },
  reserved_name: { ms: 'Nama tema ialah nama tema bawaan, atau nama peranti Windows (con, prn, aux, nul, com1 hingga com9, lpt1 hingga lpt9).', en: 'The theme name is a built-in theme name, or a Windows device name (con, prn, aux, nul, com1 to com9, lpt1 to lpt9).' },
  needs_newer: { ms: 'Nombor kontrak lebih tinggi daripada yang disokong kotak.', en: 'The contract number is higher than the box supports.' },
  version_not_higher: { ms: 'Nama sudah dipasang dan versi tidak lebih tinggi.', en: 'The name is installed and the version is not higher.' },
  css_parse: { ms: 'CSS tidak dapat dibaca, atau ada blok, rentetan atau komen yang tidak ditutup.', en: 'The CSS cannot be read, or a block, string or comment is not closed.' },
  css_import: { ms: '@import atau @namespace.', en: '@import or @namespace.' },
  css_url: { ms: 'url() atau image-set() yang menuju ke luar images/ dalam tema, ke fail yang tiada, atau ke pemboleh ubah (var()) di dalam image-set(), src() atau cross-fade().', en: 'A url() or image-set() that points outside images/ of the theme, to a file that is not there, or to a variable (var()) inside image-set(), src() or cross-fade().' },
  css_font: { ms: '@font-face (tema tidak membawa fon dalam versi ini).', en: '@font-face (a theme carries no fonts in this version).' },
  css_property: { ms: 'Sifat CSS di luar senarai yang dibenarkan (hanya warna, gambar dan kecerunan tema, sempadan, jejari, bayang terhad, jarak dan ketebalan fon dibenarkan), nilai di luar had (var() dan calc() ditolak dalam sifat berhad), pemboleh ubah tema selain --pack-* dan warna asas, !important, atau at-rule yang tidak dibenarkan.', en: 'A CSS property outside the allowed list (only colours, the pack pictures and gradients, borders, radii, bounded shadows, spacing and font weight are allowed), a value outside its range (var() and calc() are refused in a bounded property), a theme variable other than --pack-* and the base colours, !important, or an at-rule that is not allowed.' },
  css_selector: { ms: 'Pemilih di luar yang dibenarkan: hanya kelas, atribut data-* dalam kontrak, dan :first-child, :last-child, :nth-child() serta :not(). Pemilih jenis, *, #id, pseudo-elemen dan :has() ditolak.', en: 'A selector outside what is allowed: only classes, the contract data-* attributes, and :first-child, :last-child, :nth-child() and :not(). Type selectors, *, #id, pseudo-elements and :has() are refused.' },
  css_scope: { ms: 'Gaya di luar pentas tema: html, body, #root, :root (selain pemboleh ubah --nama), atau .stage + x / .stage ~ x.', en: 'A style outside the theme stage: html, body, #root, :root (other than --name variables), or .stage + x / .stage ~ x.' },
  css_string: { ms: 'Teks (rentetan) dalam nilai pemboleh ubah --nama.', en: 'Text (a string) inside a --name variable value.' },
  too_many_installs: { ms: `Lebih ${MAX_INSTALLS_PER_HOUR} pemasangan tema dalam sejam pada satu kotak.`, en: `More than ${MAX_INSTALLS_PER_HOUR} theme installs in an hour on one box.` },
  css_script: { ms: 'expression(), behavior, -moz-binding, atau alamat javascript: atau vbscript:.', en: 'expression(), behavior, -moz-binding, or a javascript: or vbscript: address.' },
  css_box_screen: { ms: 'Pemilih yang sampai ke skrin tetapan kotak, atau pemilih atribut [class] selain [class~="nama"].', en: 'A selector that reaches the box\'s own setup screens, or an attribute selector on [class] other than [class~="name"].' },
  bad_image: { ms: 'Gambar tidak dapat dibaca (PNG atau JPEG sahaja; WebP ditolak), jenis tidak sepadan dengan nama, atau terlalu besar.', en: 'The picture cannot be read (PNG or JPEG only; WebP is refused), its type does not match its name, or it is too large.' },
  bad_font: { ms: 'Fail di bawah fonts/ (tema tidak membawa fon dalam versi ini).', en: 'A file under fonts/ (a theme carries no fonts in this version).' },
  too_many_themes: { ms: 'Sudah ada 30 tema dimuat naik.', en: '30 uploaded themes are already installed.' },
  storage_full: { ms: 'Simpanan surau atau ruang tema penuh.', en: 'The surau storage or the theme space is full.' },
};

/** The error codes the validator can raise, read from its type. */
function errorCodes() { return unionOf('apps/box-server/src/themes/packFormat.ts', 'ThemeErrorCode'); }

function refusedTable(lang) {
  const codes = errorCodes();
  const rows = [];
  for (const c of codes) {
    if (Object.prototype.hasOwnProperty.call(STORE_CODES, c)) {
      const storeSrc = text('apps/box-server/src/themes/store.ts');
      for (const s of STORE_CODES[c]) {
        need((s.find ?? [s.ms, s.en]).every((t) => storeSrc.includes(t)), `store.ts no longer holds the ${c} sentence`);
        rows.push([code(c), WHEN[c][lang], escapeHtml(s.ms), escapeHtml(s.en)]);
      }
      continue;
    }
    need(Object.prototype.hasOwnProperty.call(PROBES, c) && WHEN[c] !== undefined, `the validator raises ${c} and the guide has no probe or wording for it`);
    const i = PROBES[c]().find((x) => x.code === c);
    need(i !== undefined, `probe for ${c} did not raise ${c}`);
    rows.push([code(c), WHEN[c][lang], escapeHtml(i.messageMs), escapeHtml(i.messageEn)]);
  }
  const boxList = BOX_SCREEN_IDS.map((x) => code(x)).join(', ');
  const note = lang === 'ms'
    ? `<p>Skrin tetapan kotak yang tidak boleh digayakan ialah ${boxList}. Pemilih yang boleh sampai kepadanya (kelas <code>.box-screen</code>, <code>.screen--&lt;id&gt;</code>, atau <code>[data-screen]</code> dengan nilai itu) ditolak, termasuk di dalam <code>:not()</code>. Memilih <code>[data-screen]</code> tanpa nilai dibenarkan.</p>`
    : `<p>The box screens that cannot be styled are ${boxList}. A selector that could reach them (the class <code>.box-screen</code>, <code>.screen--&lt;id&gt;</code>, or <code>[data-screen]</code> with those values) is refused, also inside <code>:not()</code>. A bare <code>[data-screen]</code> is allowed.</p>`;
  const head = lang === 'ms' ? ['Kod', 'Bila', 'Ayat dalam BM', 'Ayat dalam Inggeris'] : ['Code', 'When', 'Sentence in Malay', 'Sentence in English'];
  return table(head, rows) + note;
}

const NEWER = [
  { what: '@container', css: '@container (min-width: 10px) { .region-main { color: red; } }' },
  { what: '@layer', css: '@layer base { .region-main { color: red; } }' },
  { what: 'color-mix()', css: '.region-main { color: color-mix(in srgb, red, blue); }' },
  { what: 'CSS nesting', css: '.region-main { &:first-child { color: red; } }' },
];

function warningsTable(lang) {
  const rows = NEWER.map((n) => {
    const w = checkCss(n.css, cssCtx).warnings.find((x) => x.code === 'css_newer');
    need(w !== undefined, `the validator no longer warns about ${n.what}`);
    return [code(n.what), code(n.css), escapeHtml(lang === 'ms' ? w.messageMs : w.messageEn)];
  });
  const head = lang === 'ms' ? ['Ciri', 'Contoh', 'Mesej amaran'] : ['Feature', 'Example', 'Warning message'];
  return table(head, rows);
}

// ---------------------------------------------------------------------------------------------------------------
// The other tables.

function screensTable(lang, shots) {
  const names = screenNames(lang);
  const head = lang === 'ms' ? ['Id', 'Kumpulan', 'Nama dalam aplikasi', 'Mesti kekal kelihatan', 'Gambar (Creative)'] : ['Id', 'Group', 'Name in the app', 'Must stay visible', 'Picture (Creative)'];
  const rows = SCREEN_IDS.map((id) => {
    const need2 = PROTECTED[id].map((r) => ROLE[r][lang]).join(lang === 'ms' ? ', ' : ', ');
    const logo = ROLE.logo[lang];
    const st = SHOT_STATE[id];
    const pic = st === null || st === undefined
      ? `<span class="shot-missing">${lang === 'ms' ? 'Gambar belum ada.' : 'No picture yet.'}</span>`
      : picture(shots, `${SHOT_THEME}-${st}.png`, `${names[id]}`, lang);
    return [`<code class="sid">${id}</code>`, GROUP[lang][SCREEN_GROUP[id]], escapeHtml(names[id]), `${escapeHtml(need2)}; ${escapeHtml(logo)}`, { cls: 'shot-cell', html: pic }];
  });
  return table(head, rows);
}

function themesTable(lang, shots) {
  const figs = THEME_IDS.map((id) => {
    const title = themeTitle(id);
    return `<figure>${picture(shots, `${id}-biasa.png`, title, lang)}<figcaption><strong>${escapeHtml(title)}</strong> (${code(id)})</figcaption></figure>`;
  });
  const note = lang === 'ms'
    ? '<p>Nama tema sama dalam semua bahasa. Tema yang dimuat naik dipaparkan dengan <code>title</code> seperti yang ditulis dalam <code>theme.json</code>.</p>'
    : '<p>The theme name is the same in every language. An uploaded theme is shown with its <code>title</code> exactly as written in <code>theme.json</code>.</p>';
  return `<div class="grid">${figs.join('')}</div>${note}`;
}

const REGIONS = [
  { cls: '.region-main', ms: 'Isi utama skrin: kad kandungan, poster, zikir, bahagian tengah skrin fasa, atau bingkai siaran langsung.', en: 'The main body of the screen: the content card, poster, zikir, the centre of a phase screen, or the live frame.' },
  { cls: '.region-prayers', ms: 'Bar waktu solat. Pembawa <code>data-role="prayers"</code>.', en: 'The prayer times bar. Carries <code>data-role="prayers"</code>.' },
  { cls: '.region-clock', ms: 'Jam. Pembawa <code>data-role="clock"</code>.', en: 'The clock. Carries <code>data-role="clock"</code>.' },
  { cls: '.region-brand', ms: 'Nama surau dan logonya. Logo pembawa <code>data-role="logo"</code>.', en: 'The surau name and its logo. The logo carries <code>data-role="logo"</code>.' },
  { cls: '.region-ticker', ms: 'Teks berjalan di tepi bawah.', en: 'The ticker along the bottom.' },
  { cls: '.region-live-strip', ms: 'Jalur kecil yang menunjukkan siaran langsung sedang menunggu atau sedang berjalan.', en: 'The small strip that shows a live broadcast is waiting or on air.' },
  { cls: '.region-next', ms: 'Cip waktu solat seterusnya. Pembawa <code>data-role="next"</code>.', en: 'The next-prayer chip. Carries <code>data-role="next"</code>.' },
];

function regionsTable(lang, shots) {
  for (const r of REGIONS) need(kioskSource().includes(r.cls.slice(1)), `the kiosk no longer uses ${r.cls}`);
  need(kioskSource().includes('screen--shell') && kioskSource().includes('shell-top') && kioskSource().includes('screen--main'), 'the kiosk no longer uses .screen--shell, .shell-top and .screen--main');
  const head = lang === 'ms' ? ['Kelas', 'Apa yang ada di dalamnya'] : ['Class', 'What is in it'];
  const pic = picture(shots, `${SHOT_THEME}-normal-regions.png`, lang === 'ms' ? 'Skrin kuliah dengan kawasan bertanda' : 'The lecture screen with the regions marked', lang);
  const cap = lang === 'ms' ? 'Skrin kuliah dalam tema Creative, dengan setiap kawasan ditanda mengikut nama kelasnya.' : 'The lecture screen in the Creative theme, with each region marked by its class name.';
  return table(head, REGIONS.map((r) => [code(r.cls), r[lang]])) + `<figure>${pic}<figcaption>${cap}</figcaption></figure>`;
}

function attributesTable(lang) {
  assertTokens('apps/kiosk-display/src/app.tsx', ['data-screen=', 'data-phase=', 'data-live=', 'data-lang=', 'data-kind=', 'data-live-layout=', 'data-harakat=']);
  assertTokens('apps/kiosk-display/src/screens/kind.ts', ["'full'", "'hero'", "'content'", "'live'"]);
  need(kioskSource().includes("data-card="), 'the kiosk no longer sets data-card');
  assertTokens('apps/kiosk-display/src/themes/styleVars.ts', ["'data-align'"]);
  assertTokens('apps/kiosk-display/src/app.tsx', ["'clear'", "'none'"]);
  const phases = unionOf('packages/core/src/kiosk/state.ts', 'Phase');
  const cards = unionOf('packages/core/src/content/rotation.ts', 'SlotFeature');
  const list = (a) => a.map(code).join(' ');
  const extraScreens = ['syuruk', 'isyraq', 'tarawih'];
  const head = lang === 'ms' ? ['Atribut', 'Nilai', 'Terletak pada', 'Maksud'] : ['Attribute', 'Values', 'On', 'Meaning'];
  const rows = [
    [code('data-screen'), `${list(SCREEN_IDS)}<br>${lang === 'ms' ? 'Tiga fasa tanpa skrin katalog sendiri:' : 'Three phases without a catalog screen of their own:'} ${list(extraScreens)}`, '.stage',
      lang === 'ms' ? 'Skrin yang sedang dipaparkan. Id tetap dan tidak ditukar nama.' : 'The screen on show. The ids are fixed and never renamed.'],
    [code('data-phase'), list(phases), '.stage', lang === 'ms' ? 'Fasa waktu solat.' : 'The prayer-time phase.'],
    [code('data-card'), list(cards), lang === 'ms' ? 'kad dalam kawasan utama' : 'a card inside the main region', lang === 'ms' ? 'Kad kandungan yang sedang dipaparkan. Nama kad bukan nama skrin.' : 'The content card on show. A card name is not a screen id.'],
    [code('data-live'), list(['none', 'blur', 'clear']), '.stage', lang === 'ms' ? 'Keadaan siaran langsung: tiada, kabur (waktu solat dengan video dikaburkan), atau jelas (skrin siaran langsung).' : 'The live state: none, blur (the prayer screen with the video blurred), or clear (the live screen).'],
    [code('data-align'), list(['left', 'center', 'right']), '.stage', lang === 'ms' ? 'Susunan kandungan pilihan surau. Dalam menu: kiri, tengah, kanan.' : 'The content alignment of the surau choice. In the menu: kiri, tengah, kanan.'],
    [code('data-lang'), list(['ms', 'en']), '.stage', lang === 'ms' ? 'Bahasa paparan.' : 'The display language.'],
    [code('data-kind'), list(['full', 'hero', 'content', 'live']), '.stage', lang === 'ms' ? 'Berapa banyak pentas yang diambil oleh skrin: susun atur utama (full), keadaan solat (hero), cangkerang kandungan (content), atau siaran langsung (live).' : 'How much of the stage the screen takes: the main layout (full), a prayer state (hero), the content shell (content), or the live broadcast (live).'],
    [code('data-live-layout'), list(['full', 'framed']), '.stage', lang === 'ms' ? 'Bagaimana skrin siaran langsung dilukis: video penuh dengan jenama, jam, cip dan jalur di atasnya (full), atau video berbingkai dengan lajur sisi (framed).' : 'How the live screen is drawn: full-screen video with brand, clock, chip and strip over it (full), or a framed video with the side column (framed).'],
    [code('data-harakat'), list(['on']), '.stage', lang === 'ms' ? 'Ada hanya apabila warna baris (harakat) surau dihidupkan untuk teks Arab.' : 'Present only when the mark colour (harakat) of the surau is on for Arabic text.'],
  ];
  const boxNote = lang === 'ms'
    ? `<p>Skrin kotak (${BOX_SCREEN_IDS.map(code).join(', ')}) memakai <code>data-screen</code> juga, tetapi tidak boleh digayakan oleh tema.</p>`
    : `<p>The box's own screens (${BOX_SCREEN_IDS.map(code).join(', ')}) also use <code>data-screen</code>, but a theme cannot style them.</p>`;
  return table(head, rows) + boxNote;
}

function variablesTable(lang) {
  assertTokens('apps/kiosk-display/src/themes/styleVars.ts', ["'--bg-image'", "'--bg-fit'", "'--bg-size'", "'--bg-pos'", "'--shade'", "'--accent'", "'--accent-rgb'", "'--text'", "'--font'", "'--scale'", "'70% auto'", "'45% auto'", "'100% 100%'"]);
  const fallbackShade = numberConst('apps/kiosk-display/src/themes/styleVars.ts', 'FALLBACK_SHADE');
  const minShade = numberConst('apps/kiosk-display/src/themes/styleVars.ts', 'MIN_SHADE_DEFAULT');
  const scale = Object.entries(SCALE_FACTOR).map(([k, v]) => `${k} = ${v}`).join(', ');
  const sw = ACCENT_SWATCHES.join(' ');
  const ms = lang === 'ms';
  const head = ms ? ['Kawalan menu', 'Kunci dalam defaults', 'Nilai', 'Pemboleh ubah atau atribut', 'Lalai'] : ['Menu control', 'Key in defaults', 'Values', 'Variable or attribute', 'Default'];
  const rows = [
    [ms ? 'Latar belakang' : 'Background', code('bgImage') + (ms ? ' (tidak dibenarkan dalam defaults)' : ' (not allowed in defaults)'), ms ? 'satu gambar, atau ikut tema' : 'one picture, or follow the theme', `${code('--bg-image')} ${ms ? 'dan' : 'and'} ${code('data-bg="image"')}`, ms ? 'gambar tema, kemudian senarai latar surau' : 'the theme picture, then the surau background list'],
    [ms ? 'Paparan gambar' : 'Picture fit', code('bgFit'), code('penuh') + ' ' + code('regang') + ' ' + code('sederhana') + ' ' + code('kecil'),
      `${code('--bg-fit')}: cover, fill, contain, contain<br>${code('--bg-size')}: cover, 100% 100%, 70% auto, 45% auto`, code('penuh')],
    [ms ? 'Kedudukan gambar' : 'Picture position', code('bgPos'), code('kiri') + ' ' + code('tengah') + ' ' + code('kanan'), `${code('--bg-pos')}: left center, center, right center`, code('tengah')],
    [ms ? 'Kegelapan lapisan' : 'Layer darkness', code('shade'), ms ? 'nombor bulat 0 hingga 80 (peratus)' : 'a whole number 0 to 80 (percent)', `${code('--shade')}: 0 ${ms ? 'hingga' : 'to'} 0.8`, ms ? `nilai tema, jika tiada ${fallbackShade}; pada tema Default dengan gambar, tidak kurang daripada ${minShade}` : `the theme's value, else ${fallbackShade}; on the Default theme with a picture, never below ${minShade}`],
    [ms ? 'Warna utama' : 'Main colour', code('accent'), ms ? `warna #rrggbb; pilihan menu: ${sw}` : `a colour #rrggbb; menu swatches: ${sw}`, `${code('--accent')} ${ms ? 'dan' : 'and'} ${code('--accent-rgb')} (${ms ? 'warna yang sama sebagai tiga nombor' : 'the same colour as three numbers'})`, ms ? 'warna tema' : 'the theme colour'],
    [ms ? 'Warna teks' : 'Text colour', code('text'), ms ? 'warna #rrggbb, atau auto (diukur daripada gambar)' : 'a colour #rrggbb, or auto (measured from the picture)', code('--text'), 'auto'],
    [ms ? 'Fon' : 'Font', code('font'), `${code('jakarta')} ${ms ? 'atau' : 'or'} ${code('amiri')}`, `${code('--font')} (${ms ? 'dan' : 'and'} ${code('--serif')} ${ms ? 'pada Old School' : 'on Old School'})`, ms ? 'fon tema' : 'the theme font'],
    [ms ? 'Saiz teks' : 'Text size', code('scale'), code('S') + ' ' + code('M') + ' ' + code('L') + ' ' + code('XL'), `${code('--scale')}: ${scale}`, ms ? 'S, iaitu saiz sedia ada; tiada saiz lebih kecil' : 'S, today\'s size; there is no smaller size'],
    [ms ? 'Susunan kandungan' : 'Content alignment', code('align'), code('kiri') + ' ' + code('tengah') + ' ' + code('kanan'), `${code('data-align')}: left, center, right`, ms ? 'susunan tema' : 'the theme alignment'],
  ];
  const note = ms
    ? '<p>Setiap kawalan boleh dibiarkan kosong, dan kosong bermaksud ikut tema. Pilihan surau mengatasi <code>defaults</code>, dan pilihan untuk satu skrin mengatasi pilihan untuk semua skrin. Tetapan surau yang lain (contohnya sama ada terjemahan dipaparkan) sentiasa menang.</p>'
    : '<p>Any control can be left out, and out means follow the theme. A surau choice overrides <code>defaults</code>, and a choice for one screen overrides a choice for all screens. Other surau settings (for example whether a translation shows) always win.</p>';
  return table(head, rows) + note;
}

function arabicTable(lang) {
  assertTokens('apps/kiosk-display/src/themes/styleVars.ts', ["'data-arfont'", "'--ar-scale'", "'--harakat'", "'--ar-lh'", "'data-tarjamah'"]);
  need(kioskSource().includes('arab-tarjamah') && /class="[^"]*\barab\b/.test(kioskSource()), 'the kiosk no longer uses .arab and .arab-tarjamah');
  assertTokens('apps/kiosk-display/src/styles.css', ['--font-arabic']);
  const ms = lang === 'ms';
  const classHead = ms ? ['Kelas', 'Apa'] : ['Class', 'What'];
  const classes = table(classHead, [
    [code('.arab'), ms ? 'Blok teks Arab (<code>dir="rtl"</code>, <code>lang="ar"</code>).' : 'An Arabic text block (<code>dir="rtl"</code>, <code>lang="ar"</code>).'],
    [code('.arab-tarjamah'), ms ? 'Terjemahan di bawah atau di sisi teks Arab.' : 'The translation below or beside the Arabic text.'],
  ]);
  const head = ms ? ['Kawalan menu', 'Kunci dalam defaults', 'Nilai', 'Pemboleh ubah atau atribut'] : ['Menu control', 'Key in defaults', 'Values', 'Variable or attribute'];
  const rows = [
    [ms ? 'Fon Arab' : 'Arabic font', code('arFont'), `${code('hafs')} ${code('amiri-quran')} ${code('amiri')}`, `${code('data-arfont')} ${ms ? 'dan' : 'and'} ${code('--font-arabic')}`],
    [ms ? 'Saiz' : 'Size', code('arScale'), ms ? 'nombor bulat 100 hingga 160 (peratus)' : 'a whole number 100 to 160 (percent)', `${code('--ar-scale')}: 1 ${ms ? 'hingga' : 'to'} 1.6`],
    [ms ? 'Warna baris (harakat)' : 'Mark colour (harakat)', code('harakat'), ms ? 'warna #rrggbb' : 'a colour #rrggbb', code('--harakat')],
    [ms ? 'Jarak baris' : 'Line spacing', code('arLineHeight'), ms ? 'nombor bulat 16 hingga 24 (persepuluh)' : 'a whole number 16 to 24 (tenths)', `${code('--ar-lh')}: 1.6 ${ms ? 'hingga' : 'to'} 2.4`],
    [ms ? 'Terjemahan' : 'Translation', code('tarjamah'), `${code('bawah')} ${code('sisi')} ${code('sembunyi')}`, `${code('data-tarjamah')}: below, beside, hidden`],
  ];
  const rule = ms
    ? `<p>Peraturan harakat: warna baris hanya berfungsi dengan fon Amiri dan Amiri Quran. Dengan fon Uthmani Hafs kawalan itu dimatikan dalam aplikasi, kerana lesen fon itu melarang pengubahsuaian. Terjemahan <code>sembunyi</code> hanya dipakai pada skrin <code>arab-ayat</code>, <code>arab-hadis</code> dan <code>arab-zikir</code>. Jika Tetapan sudah menentukan sama ada terjemahan dipaparkan, Tetapan yang menang.</p>
<p>Pentas membawa atribut dan pemboleh ubah di atas apabila surau memilihnya. Fail <code>arabic.css</code> anda yang menentukan bagaimana ia dipakai.</p>`
    : `<p>The harakat rule: the mark colour works only with the Amiri and Amiri Quran fonts. With the Uthmani Hafs font the control is switched off in the app, because the licence of that font forbids modification. The translation value <code>sembunyi</code> (hidden) applies only to the screens <code>arab-ayat</code>, <code>arab-hadis</code> and <code>arab-zikir</code>. Where Tetapan already decides whether a translation shows, Tetapan wins.</p>
<p>The stage carries the attributes and variables above when the surau picks them. Your <code>arabic.css</code> decides how they are used.</p>`;
  return classes + table(head, rows) + rule;
}

function filesTable(lang) {
  const ms = lang === 'ms';
  const tree = `<pre><code>${[
    `${ms ? 'nama-tema' : 'theme-name'}.maxtheme            ${ms ? '(zip)' : '(zip)'}`,
    `  theme.json             ${ms ? 'wajib' : 'required'}`,
    `  theme.css              ${ms ? 'wajib, untuk semua skrin' : 'required, for every screen'}`,
    `  arabic.css             ${ms ? 'pilihan, tulisan Arab' : 'optional, Arabic text'}`,
    `  screens/&lt;id&gt;.css       ${ms ? 'pilihan, satu skrin; id daripada senarai skrin' : 'optional, one screen; id from the screens list'}`,
    `  images/&lt;id&gt;.jpg        ${ms ? 'pilihan, latar satu skrin (jpg atau png)' : 'optional, background of one screen (jpg or png)'}`,
    `  images/semua.jpg       ${ms ? 'pilihan, latar semua skrin tanpa gambar sendiri' : 'optional, background of every screen without its own picture'}`,
    ms ? '  (tiada fonts/ dalam versi ini: fon dipilih dalam menu Ubah suai)' : '  (no fonts/ in this version: the font is chosen in the Ubah suai menu)',
  ].join('\n')}</code></pre>`;
  const limitsHead = ms ? ['Had', 'Nilai'] : ['Limit', 'Value'];
  const limits = table(limitsHead, [
    [ms ? 'Saiz fail .maxtheme' : 'Size of the .maxtheme file', mb(MAX_PACK_BYTES)],
    [ms ? 'Bilangan fail dalam zip' : 'Number of files in the zip', String(MAX_PACK_FILES)],
    [ms ? 'Jumlah saiz selepas dibuka' : 'Total size once unpacked', mb(MAX_PACK_INFLATED_BYTES)],
    [ms ? 'Setiap fail CSS' : 'Each CSS file', mb(MAX_CSS_BYTES)],
    [ms ? 'Semua fail CSS bersama' : 'All CSS files together', mb(MAX_TOTAL_CSS_BYTES)],
    [ms ? 'z-index tertinggi dalam CSS tema' : 'Highest z-index in theme CSS', String(MAX_PACK_Z_INDEX)],
    [ms ? 'Pemasangan tema sejam pada satu kotak' : 'Theme installs an hour on one box', `${MAX_INSTALLS_PER_HOUR} (${INSTALL_WINDOW_MS / 3_600_000} ${ms ? 'jam' : 'hour'})`],
    ['theme.json', mb(MAX_THEME_JSON_BYTES)],
    [ms ? 'Setiap gambar' : 'Each picture', `${mb(MAX_IMAGE_BYTES)}, ${ms ? 'sisi paling panjang' : 'longest side'} ${MAX_IMAGE_SIDE} px, ${MAX_IMAGE_PIXELS / 1_000_000} ${ms ? 'juta piksel' : 'million pixels'}`],
    [ms ? 'Nama tema' : 'Theme name', `${code(THEME_NAME_RE.source)}, ${ms ? 'paling panjang 32' : 'at most 32'}`],
    [ms ? 'Nama yang dikhaskan (tema bawaan)' : 'Reserved names (built-in themes)', RESERVED_NAMES.map(code).join(' ')],
  ]);
  const keys = SCREEN_STYLE_KEYS.filter((k) => k !== 'bgImage');
  const fieldHead = ms ? ['Medan theme.json', 'Peraturan'] : ['theme.json field', 'Rule'];
  const fields = table(fieldHead, [
    [code('name'), ms ? 'Sama dengan nama fail; lihat peraturan nama di atas.' : 'The same as the file name; see the name rule above.'],
    [code('title'), ms ? '1 hingga 60 aksara biasa, tanpa &lt; atau &gt;.' : '1 to 60 plain characters, without &lt; or &gt;.'],
    [code('version'), ms ? 'Nombor bulat 1 hingga 999999. Naikkan setiap kali memuat naik semula.' : 'A whole number 1 to 999999. Raise it each time you upload again.'],
    [code('contract'), ms ? `Nombor bulat, sekurang-kurangnya 1. Kotak ini menyokong sehingga ${THEME_CONTRACT}.` : `A whole number, at least 1. This MAXCOM supports up to ${THEME_CONTRACT}.`],
    [code('base'), `${ms ? 'Salah satu tema bawaan:' : 'One of the built-in themes:'} ${RESERVED_NAMES.map(code).join(' ')}`],
    [code('defaults'), `${ms ? 'Pilihan, objek dengan' : 'Optional, an object with'} ${code('semua')} ${ms ? 'dan' : 'and'} ${code('skrin')}. ${ms ? 'Kunci yang dikenali:' : 'Known keys:'} ${keys.map(code).join(' ')}.`],
  ]);
  return tree + limits + fields;
}

function protectedTable(lang) {
  const ms = lang === 'ms';
  const hp = 'apps/kiosk-display/src/themes/health.ts';
  const delay = numberConst(hp, 'HEALTH_DELAY_MS');
  const minOpacity = numberConst(hp, 'MIN_OPACITY');
  const minSize = numberConst(hp, 'MIN_SIZE_FACTOR');
  const interval = numberConst(hp, 'HEALTH_INTERVAL_MS');
  const minContrast = numberConst(hp, 'MIN_CONTRAST');
  const minTextRem = numberConst(hp, 'MIN_TEXT_REM');
  const quiet = numberConst('apps/kiosk-display/src/themes/useThemeHealth.ts', 'MOTION_QUIET_MS');
  const recheck = numberConst('apps/kiosk-display/src/themes/useThemeHealth.ts', 'HEALTH_RECHECK_MS');
  const rejectClear = numberConst('apps/kiosk-display/src/themes/packLoader.ts', 'PACK_REJECT_CLEAR_MS');
  const mustMin = numberConst(hp, 'MUST_MIN_REM');
  const protCss = text('apps/kiosk-display/src/themes/protected.css');
  const protZ = /z-index: (\d+) !important/.exec(protCss)?.[1];
  need(protZ !== undefined, 'protected.css no longer sets a z-index');
  assertTokens('apps/kiosk-display/src/themes/protected.css', ["[data-role='clock']", "[data-role='prayers']", "[data-role='countdown']", "[data-role='next']", "[data-role='logo']", 'visibility: visible !important', 'opacity: 1 !important', 'filter: none !important', 'mix-blend-mode: normal !important', 'transform: none !important', 'animation: none !important', 'transition: none !important', 'clip-path: none !important', 'mask-image: none !important', '-webkit-text-fill-color: currentColor !important', 'content: none !important', ':where(']);
  const screensOf = (role) => SCREEN_IDS.filter((id) => PROTECTED[id].includes(role)).map(code).join(' ');
  const head = ms ? ['Elemen', 'Atribut', 'Skrin yang memerlukannya'] : ['Element', 'Attribute', 'Screens that require it'];
  const rows = ['clock', 'prayers', 'countdown', 'next'].map((r) => [escapeHtml(ROLE[r][lang]), code(`data-role="${r}"`), screensOf(r)]);
  rows.push([escapeHtml(ROLE.logo[lang]), code('data-role="logo"'), ms ? 'semua skrin' : 'every screen']);
  const pct = (x) => Math.round(x * 100);
  const rules = ms
    ? `<h3>Peraturan terlindung</h3>
<p>Selagi tema yang dimuat naik berada di pentas, setiap elemen di atas, dan semua yang ada di dalamnya (termasuk <code>::before</code>, <code>::after</code> dan <code>::marker</code>), sentiasa mendapat <code>visibility: visible</code>, <code>opacity: 1</code>, <code>filter: none</code>, <code>mix-blend-mode: normal</code>, <code>transform: none</code>, <code>zoom: 1</code>, <code>animation: none</code>, <code>transition: none</code>, <code>clip-path: none</code>, <code>mask-image: none</code>, <code>-webkit-text-fill-color: currentColor</code>, <code>-webkit-text-security: none</code>, <code>-webkit-text-stroke: 0</code>, <code>text-decoration: none</code> dan <code>unicode-bidi: normal</code>, semuanya dengan <code>!important</code>, serta <code>content: none</code> pada <code>::before</code>, <code>::after</code> dan <code>::marker</code>. Elemen itu mendapat <code>z-index: ${protZ}</code> (peraturan tema tidak boleh melebihi ${MAX_PACK_Z_INDEX}), dan <code>position: relative</code> jika ia tidak diletakkan. Bahagian teks yang mesti kelihatan (jam dan minit, nama dan waktu setiap solat, kiraan detik, nama solat seterusnya) membawa <code>data-must</code> dan sentiasa dibaca dari kiri ke kanan. Lapisan kotak sendiri (jalan keluar ke kotak, ribbon pratonton, semakan rangkaian) dikunci dengan <code>!important</code> supaya tidak boleh digerakkan, diubah saiz, diwarnakan semula atau disembunyikan. Selain itu CSS tema disemak dengan senarai yang dibenarkan (bahagian 3 di atas), jadi kebanyakan sifat di atas tidak boleh ditulis langsung.</p>
<h3>Semakan kesihatan</h3>
<p>Selepas tema dimuat, dan selepas setiap perubahan skrin, paparan menunggu ${delay} milisaat supaya susun atur tenang, kemudian melihat setiap elemen yang diperlukan oleh skrin itu seperti yang sebenarnya dilukis oleh pelayar. Semakan diulang setiap ${interval / 1000} saat selagi tema ada di pentas, apabila sesuatu atribut <code>data-*</code> pada pentas berubah (fasa, redup, siaran langsung), dan sekali lagi apabila sesuatu animasi atau peralihan tamat dan keadaan sudah tenang ${quiet} milisaat. Satu kegagalan sahaja tidak menolak tema: ia ditolak hanya jika semakan gagal sekali lagi sekurang-kurangnya ${recheck / 1000} saat kemudian. Tema yang ditolak dicuba semula selepas ${rejectClear / 60000} minit. Satu elemen lulus apabila semua yang berikut benar:</p>
<ul>
<li>ia dipaparkan (bukan <code>display: none</code>, dan tiada induknya yang begitu) dan <code>visibility</code> ialah visible;</li>
<li>kelegapan terkumpulnya sekurang-kurangnya ${minOpacity};</li>
<li>kotaknya mempunyai tinggi dan lebar, dan berada di dalam skrin;</li>
<li>setiap bahagian <code>data-must</code> di dalamnya ada, mempunyai teks, dilukis tanpa cermin, putaran atau pengecilan (tidak oleh <code>transform</code> atau <code>zoom</code> pada dirinya atau induknya), sekurang-kurangnya ${mustMin} rem, seluruhnya di dalam skrin, dan tiada apa-apa lapisan lain dilukis di atas tengahnya atau di atas empat sudutnya (diuji dengan menanyakan pelayar elemen mana yang berada di setiap titik, walaupun lapisan itu tidak menerima klik; bayang dan garis luar yang menjangkau lebih 1 rem juga dikira);</li>
<li>bilangan sel waktu solat yang dilukis sama dengan bilangan yang diisytiharkan oleh skrin;</li>
<li>setiap teks yang kelihatan di dalamnya mempunyai saiz sekurang-kurangnya ${minTextRem} rem, kelegapan sekurang-kurangnya ${minOpacity}, warna yang kelihatan, dan dilukis di dalam kotaknya sendiri (bukan ditolak keluar, contohnya dengan <code>text-indent</code>), tanpa garis lorek atau penutup yang menyembunyikannya;</li>
<li>warna teks berbanding setiap warna di belakangnya mempunyai nisbah sekurang-kurangnya ${minContrast} kepada 1. Lapisan sebenar di titik itu dibaca, dan sebuah kecerunan diukur terhadap setiap warna hentiannya. Jika sebuah gambar tema anda berada di belakang bahagian <code>data-must</code>, bahagian itu diberi plat penuh yang jelas (warna gelap dengan teks cerah) dan nisbah diukur terhadap plat itu;</li>
<li>saiz tulisannya sekurang-kurangnya ${pct(minSize)} peratus daripada saiz tema bawaan yang menjadi <code>base</code>.</li>
</ul>
<p>Jika satu elemen gagal dua kali, paparan bertukar kepada tema <code>base</code>, dan melaporkan Tema tidak sah kepada aplikasi dan kepada Semak MAXCOM. Jika ada paparan lain yang melaporkan masalah dalam 24 jam, tema dikira bermasalah walaupun paparan lain baik. Cara selamat: ubah warna, sempadan, bayang terhad, gambar dan jarak, tetapi jangan sembunyikan, jangan gelapkan, dan jangan cuba menutup elemen ini dengan lapisan lain.</p>`
    : `<h3>The protected rule</h3>
<p>While an uploaded theme is on the stage, each element above, and everything inside it (including <code>::before</code>, <code>::after</code> and <code>::marker</code>), always gets <code>visibility: visible</code>, <code>opacity: 1</code>, <code>filter: none</code>, <code>mix-blend-mode: normal</code>, <code>transform: none</code>, <code>zoom: 1</code>, <code>animation: none</code>, <code>transition: none</code>, <code>clip-path: none</code>, <code>mask-image: none</code>, <code>-webkit-text-fill-color: currentColor</code>, <code>-webkit-text-security: none</code>, <code>-webkit-text-stroke: 0</code>, <code>text-decoration: none</code> and <code>unicode-bidi: normal</code>, all with <code>!important</code>, and <code>content: none</code> on <code>::before</code>, <code>::after</code> and <code>::marker</code>. The element gets <code>z-index: ${protZ}</code> (a theme may not go above ${MAX_PACK_Z_INDEX}), and <code>position: relative</code> when it is not positioned. The text parts that must show (the hour and minute, the name and time of each prayer, the countdown digits, the next prayer's name) carry <code>data-must</code> and always read left to right. The box's own overlays (the way out to the box, the preview ribbon, the network check) are pinned with <code>!important</code> so they cannot be moved, resized, recoloured or hidden. On top of this the CSS of a theme is checked against an allow-list (section 3 above), so most of the properties above cannot be written at all.</p>
<h3>The health check</h3>
<p>After a theme loads, and after every screen change, the display waits ${delay} milliseconds so that the layout settles, then looks at every element the screen requires as the browser really draws it. The check repeats every ${interval / 1000} seconds while the theme is on the stage, when a <code>data-*</code> attribute of the stage changes (phase, dim, live), and again when an animation or a transition ends and things have been quiet for ${quiet} milliseconds. One failure alone does not reject a theme: it is rejected only when the check fails again at least ${recheck / 1000} seconds later. A rejected theme is tried again after ${rejectClear / 60000} minutes. An element passes when all of these are true:</p>
<ul>
<li>it is displayed (not <code>display: none</code>, and no parent is) and <code>visibility</code> is visible;</li>
<li>its combined opacity is at least ${minOpacity};</li>
<li>its box has height and width, and sits inside the screen;</li>
<li>every <code>data-must</code> part inside it is there, has text, is drawn without a mirror, a turn or a shrink (no <code>transform</code> or <code>zoom</code> on it or on a parent), is at least ${mustMin} rem, lies wholly inside the screen, and has nothing else drawn over its centre or over its four corners (the browser is asked which element is at each point, even when the layer over it does not take clicks; a shadow or an outline that reaches more than 1 rem past its box counts too);</li>
<li>the number of prayer cells drawn equals the number the screen declared;</li>
<li>every piece of visible text inside it is at least ${minTextRem} rem in size, at least ${minOpacity} opaque, in a colour that can be seen, and drawn inside its own box (not pushed out, for example with <code>text-indent</code>), with no strike-through or cover over it;</li>
<li>the colour of its text against every colour behind it has a contrast ratio of at least ${minContrast} to 1. The real layers at that point are read, and a gradient is measured against each of its colour stops. When a picture of your theme is behind a <code>data-must</code> part, that part is given a solid plate (dark with light text) and the ratio is measured against the plate;</li>
<li>its text size is at least ${pct(minSize)} percent of the size in the built-in theme named as <code>base</code>.</li>
</ul>
<p>If one element fails twice, the display switches to the <code>base</code> theme and reports Tema tidak sah to the app and to Semak MAXCOM. When any display reports a problem in the last 24 hours, the theme counts as bad even when another display is fine. The safe way: change colours, borders, bounded shadows, pictures and spacing, but do not hide these elements, do not fade them, and do not try to cover them with another layer.</p>`;
  return table(head, rows) + rules;
}

function sampleTable() {
  const files = ['theme.json', 'theme.css', 'screens/kuliah.css', 'screens/poster.css'];
  return files.map((f) => {
    const body = readFileSync(join(SAMPLE_DIR, f), 'utf8').replace(/\r\n/g, '\n').trim();
    return `<p class="file-name"><code>${f}</code></p><pre><code>${escapeHtml(body)}</code></pre>`;
  }).join('\n');
}

/** The generated tables of one language. `opts.shots` (a folder) turns a missing picture into a note instead of an image. */
export function guideTables(lang, opts = {}) {
  need(lang === 'ms' || lang === 'en', `unknown language ${lang}`);
  const shots = opts.shots;
  return {
    screens: screensTable(lang, shots),
    themes: themesTable(lang, shots),
    regions: regionsTable(lang, shots),
    attributes: attributesTable(lang),
    variables: variablesTable(lang),
    arabic: arabicTable(lang),
    files: filesTable(lang),
    refused: refusedTable(lang),
    warnings: warningsTable(lang),
    protected: protectedTable(lang),
    sample: sampleTable(),
  };
}

/** Fills the slots of a source. Throws on a slot with no table, and on a table with no slot. */
export function fillSlots(source, tables) {
  const slots = [...source.matchAll(/<!--slot:([A-Za-z-]+)-->/g)].map((m) => m[1]);
  for (const s of slots) if (!Object.prototype.hasOwnProperty.call(tables, s)) throw new Error(`theme guide: the source has the slot ${s} and there is no table for it`);
  for (const k of Object.keys(tables)) if (!slots.includes(k)) throw new Error(`theme guide: there is a table for ${k} and the source has no slot for it`);
  return source
    .replace(/<!--slot:([A-Za-z-]+)-->/g, (_m, name) => tables[name])
    .replace(/\{\{contract\}\}/g, String(THEME_CONTRACT));
}

// ---------------------------------------------------------------------------------------------------------------
// Pictures and the page.

const jpegCache = new Map();
/** A harness PNG as a small JPEG data URI (the PDF stays well under 10 MB). */
function dataUri(file) {
  if (jpegCache.has(file)) return jpegCache.get(file);
  need(existsSync(file), `picture missing: ${file}`);
  const png = PNG.sync.read(readFileSync(file));
  const jpg = jpeg.encode({ data: png.data, width: png.width, height: png.height }, 78);
  const uri = `data:image/jpeg;base64,${jpg.data.toString('base64')}`;
  jpegCache.set(file, uri);
  return uri;
}

function inlineImages(html, shotsDir) {
  return html.replace(/src="shots\/([A-Za-z0-9._-]+)"/g, (_m, name) => `src="${dataUri(join(shotsDir, name))}"`);
}

/** The finished page: sources filled, CSS and pictures inlined. Throws when anything points outside the file. */
export function renderPage(lang, shotsDir) {
  const src = readFileSync(lang === 'ms' ? MS_SRC : EN_SRC, 'utf8');
  let html = fillSlots(src, guideTables(lang, { shots: shotsDir }));
  const css = readFileSync(CSS_SRC, 'utf8');
  html = html.replace(/<link rel="stylesheet" href="guide\.css">/, () => `<style>\n${css}\n</style>`);
  html = inlineImages(html, shotsDir);
  need(!/<link\b/i.test(html) && !/<script\b/i.test(html), 'the page links or runs something outside itself');
  need(!/(?:src|href)\s*=\s*["'](?!#|data:)/i.test(html), 'the page has a src or href that is not inside the file');
  need(!/url\(\s*["']?https?:/i.test(html), 'the page loads a url from outside');
  return html;
}

const FOOTER = {
  ms: `MAXCOM, panduan pembuat tema, kontrak ${THEME_CONTRACT}`,
  en: `MAXCOM, theme author guide, contract ${THEME_CONTRACT}`,
};

/** Counts the /Type /Page objects of a PDF. */
export function pdfInfo(buf) {
  const s = buf.toString('latin1');
  return { pages: (s.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length };
}

async function printPdf(htmlFile, pdfFile, lang) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(htmlFile).href, { waitUntil: 'load' });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((i) => (i.complete ? Promise.resolve() : i.decode().catch(() => {}))));
    });
    const footer = `<div style="width:100%;font-size:8px;color:#555;text-align:center;font-family:Segoe UI,Arial,sans-serif"><span>${escapeHtml(FOOTER[lang])}</span>, <span class="pageNumber"></span> / <span class="totalPages"></span></div>`;
    await page.pdf({
      path: pdfFile, format: 'A4', printBackground: true, displayHeaderFooter: true,
      headerTemplate: '<div></div>', footerTemplate: footer,
      margin: { top: '18mm', right: '18mm', bottom: '18mm', left: '18mm' },
    });
  } finally {
    await browser.close();
  }
}

/** Takes the guide's pictures with the golden harness (creative: every state and the marked-up regions; each theme: biasa). */
export function makeShots(dir) {
  mkdirSync(dir, { recursive: true });
  const run = (templates, states, extra = {}) => {
    // The harness listens on one fixed port; when another run holds it, wait and try again.
    let status = 1;
    for (let attempt = 0; attempt < 8 && status !== 0; attempt++) {
      if (attempt > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
      status = spawnSync(process.execPath, [join(here, 'template-shots.mjs'), dir, templates.join(','), states.join(',')], {
        cwd: repo, stdio: 'inherit', env: { ...process.env, SHOT_SIZE, ...extra },
      }).status ?? 1;
    }
    need(status === 0, `template-shots.mjs failed for ${templates.join(',')}`);
  };
  const states = [...new Set(Object.values(SHOT_STATE).filter((s) => s !== null))];
  run([SHOT_THEME], states, { SHOT_REGIONS: '1' });
  const others = KIOSK_TEMPLATE_IDS.filter((t) => t !== SHOT_THEME);
  run(others, ['biasa']);
}

/** Builds the pages (and the PDFs). Returns the files written. */
export async function buildGuide({ shots, pdf = false, outDir = resolve(repo, 'dist/theme-guide') } = {}) {
  const shotsDir = shots === undefined ? resolve(repo, 'ui-preview/guide-shots') : resolve(shots);
  if (shots === undefined) makeShots(shotsDir);
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const lang of ['ms', 'en']) {
    const html = renderPage(lang, shotsDir);
    const htmlFile = join(outDir, `${OUT_NAMES[lang]}.html`);
    writeFileSync(htmlFile, html);
    written.push(htmlFile);
    if (pdf) {
      const pdfFile = join(outDir, `${OUT_NAMES[lang]}.pdf`);
      await printPdf(htmlFile, pdfFile, lang);
      written.push(pdfFile);
    }
  }
  return written;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  buildGuide({ shots: opt('--shots'), pdf: args.includes('--pdf'), outDir: opt('--out') === undefined ? undefined : resolve(opt('--out')) })
    .then((files) => { for (const f of files) console.log(f); })
    .catch((e) => { console.error(String(e instanceof Error ? e.message : e)); process.exit(1); });
}
