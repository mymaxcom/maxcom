import { isBuiltInTheme, isScreenId, isThemeName, KIOSK_TEMPLATE_IDS, themeStyleEntryError } from '@surau/core';
import type { KioskTemplateId, ScreenId, ThemeManifest, ThemeStyleEntry } from '@surau/core';
import { readZipEntries, ZipError } from '../files/zipRead.ts';

export const PACK_MIME = 'application/vnd.maxcom.theme+zip';
export const MAX_PACK_BYTES = 15 * 1024 * 1024;
export const MAX_PACK_FILES = 60;
export const MAX_PACK_INFLATED_BYTES = 40 * 1024 * 1024;
export const MAX_CSS_BYTES = 512 * 1024;
export const MAX_THEME_JSON_BYTES = 64 * 1024;
/** All pack stylesheets together (a pack of many screens cannot keep the box busy parsing). */
export const MAX_TOTAL_CSS_BYTES = 1024 * 1024;
/** Names of the built-in themes (KIOSK_TEMPLATE_IDS holds all six, `arabic` included): an uploaded theme may not take one. */
export const RESERVED_NAMES: readonly string[] = [...KIOSK_TEMPLATE_IDS];
/** Names Windows treats as devices (con, nul, com1 ...): a folder of that name on the box's disk is never safe. */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export const isReservedName = (name: string): boolean => RESERVED_NAMES.includes(name) || WINDOWS_DEVICE_NAME.test(name);

export type ThemeErrorCode =
  | 'too_big' | 'not_zip' | 'too_many_files' | 'bad_path' | 'missing_file' | 'bad_theme_json' | 'reserved_name'
  | 'needs_newer' | 'version_not_higher' | 'css_parse' | 'css_import' | 'css_url' | 'css_script' | 'css_box_screen'
  | 'css_font' | 'css_property' | 'css_scope' | 'css_string' | 'css_selector'
  | 'bad_image' | 'bad_font' | 'too_many_themes' | 'storage_full' | 'too_many_installs';

export interface ThemeIssue {
  code: ThemeErrorCode | 'css_newer';
  file: string | null;
  line: number | null;
  messageMs: string;
  messageEn: string;
}

export class ThemeError extends Error {
  readonly issues: ThemeIssue[];
  constructor(issues: ThemeIssue[]) {
    super(issues.map((i) => i.messageEn).join('; '));
    this.name = 'ThemeError';
    this.issues = issues;
  }
}

export interface PackManifest extends ThemeManifest { defaults: Partial<ThemeStyleEntry> }
export type ImageExt = 'jpg' | 'png';
export interface PackFiles {
  manifest: PackManifest;
  /** Keyed by pack path: 'theme.css', 'arabic.css', 'screens/<id>.css'. */
  css: Map<string, string>;
  images: Map<ScreenId | 'semua', { ext: ImageExt; data: Buffer }>;
  fileCount: number;
  /** Size of the .maxtheme file itself. */
  bytes: number;
}

export const issue = (code: ThemeIssue['code'], file: string | null, line: number | null, messageMs: string, messageEn: string): ThemeIssue =>
  ({ code, file, line, messageMs, messageEn });

/** Printable ASCII only, short: a name from an archive is never echoed raw into a message. */
export function safeName(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, '?').slice(0, 60);
}

const IMAGE_RE = /^images\/([a-z-]{1,12})\.(jpg|png)$/;
const WEBP_RE = /^images\/[a-z-]{1,12}\.webp$/i;
const FONT_PATH_RE = /^fonts\//i;
const SCREEN_CSS_RE = /^screens\/([a-z-]{1,12})\.css$/;

/** Why a path is not one of the fixed paths, or null. */
export function packPathError(path: string): string | null {
  if (path === 'theme.json' || path === 'theme.css' || path === 'arabic.css') return null;
  let m = SCREEN_CSS_RE.exec(path);
  if (m !== null) return isScreenId(m[1]) ? null : 'not a screen of the catalog';
  m = IMAGE_RE.exec(path);
  if (m !== null) return m[1] === 'semua' || isScreenId(m[1]) ? null : 'not a screen of the catalog';
  return 'not one of the fixed theme paths';
}

const badPath = (path: string): ThemeIssue => issue('bad_path', null, null,
  `Fail tidak dibenarkan dalam tema: ${safeName(path)}.`, `A file that is not allowed in a theme: ${safeName(path)}.`);
const missing = (path: string): ThemeIssue => issue('missing_file', path, null,
  `${path} tiada dalam fail tema.`, `${path} is missing from the theme file.`);
const badJson = (ms: string, en: string): ThemeIssue => issue('bad_theme_json', 'theme.json', null,
  `theme.json tidak sah: ${ms}.`, `theme.json is not valid: ${en}.`);

const fail = (i: ThemeIssue): never => { throw new ThemeError([i]); };

const TITLE_BAD = /[<>\u0000-\u001f\u007f]/;
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function decodeUtf8(buf: Buffer): string | null {
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return s.includes('\u0000') ? null : s;
  } catch {
    return null;
  }
}

function noBgImage(d: Record<string, unknown>): boolean {
  const has = (o: unknown): boolean => isPlain(o) && Object.prototype.hasOwnProperty.call(o, 'bgImage');
  if (has(d.semua)) return false;
  if (isPlain(d.skrin)) for (const k of Object.keys(d.skrin)) if (has(d.skrin[k])) return false;
  return true;
}

function parseManifest(text: string): PackManifest {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return fail(badJson('bukan JSON yang sah', 'not valid JSON')); }
  if (!isPlain(raw)) return fail(badJson('mesti objek', 'it must be an object'));
  const { name, title, version, contract, base } = raw;
  if (!isThemeName(name)) return fail(badJson('name mesti huruf kecil, nombor dan sempang (paling panjang 32)', 'name must be lowercase letters, digits and hyphens (at most 32)'));
  if (isReservedName(name)) {
    return fail(issue('reserved_name', 'theme.json', null,
      `Nama tema ${name} dikhaskan untuk tema bawaan MAXCOM. Pilih nama lain.`,
      `The theme name ${name} is reserved for a built-in theme. Choose another name.`));
  }
  if (typeof title !== 'string' || title.length < 1 || title.length > 60 || TITLE_BAD.test(title)) {
    return fail(badJson('title mesti 1 hingga 60 aksara biasa', 'title must be 1 to 60 plain characters'));
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > 999999) {
    return fail(badJson('version mesti nombor bulat 1 hingga 999999', 'version must be a whole number 1 to 999999'));
  }
  if (typeof contract !== 'number' || !Number.isInteger(contract) || contract < 1) {
    return fail(badJson('contract mesti nombor bulat sekurang-kurangnya 1', 'contract must be a whole number, at least 1'));
  }
  if (!isBuiltInTheme(base)) return fail(badJson('base mesti salah satu tema bawaan', 'base must be one of the built-in themes'));
  let defaults: Partial<ThemeStyleEntry> = {};
  if (Object.prototype.hasOwnProperty.call(raw, 'defaults')) {
    const d = raw.defaults;
    const e = themeStyleEntryError('defaults', d);
    if (e !== null) return fail(badJson(`defaults tidak sah (${e})`, `defaults is not valid (${e})`));
    if (!noBgImage(d as Record<string, unknown>)) return fail(badJson('defaults tidak boleh mengandungi bgImage', 'defaults must not hold bgImage'));
    defaults = JSON.parse(JSON.stringify(d)) as Partial<ThemeStyleEntry>;
  }
  return { name, title, version, contract, base: base as KioskTemplateId, defaults };
}

/** Bounds and shape only (no CSS, image or font content checks). Throws ThemeError. */
export function readPack(buf: Buffer): PackFiles {
  if (buf.length > MAX_PACK_BYTES) {
    return fail(issue('too_big', null, null, 'Fail tema melebihi 15 MB.', 'The theme file is larger than 15 MB.'));
  }
  const skipped: ThemeIssue[] = [];
  let entries: Map<string, Buffer>;
  try {
    entries = readZipEntries(buf, () => true, {
      maxEntries: MAX_PACK_FILES, maxEntryBytes: 8 * 1024 * 1024, maxTotalBytes: MAX_PACK_INFLATED_BYTES,
    }, {
      lenient: true,
      backslashAsSlash: true,
      onSkip: (d) => skipped.push(badPath(d.slice(d.indexOf(': ') + 2))),
    });
  } catch (e) {
    const m = e instanceof ZipError ? e.message : '';
    if (m.includes('too many entries')) {
      return fail(issue('too_many_files', null, null, 'Fail tema mengandungi lebih daripada 60 fail.', 'The theme file holds more than 60 files.'));
    }
    if (m.includes('too large')) {
      return fail(issue('too_big', null, null, 'Fail tema melebihi had saiz.', 'The theme file passes the size limit once unpacked.'));
    }
    if (m.includes('a link is not allowed') || m.includes('duplicate entry name')) {
      return fail(badPath(m.includes('link') ? '(pautan)' : '(nama berganda)'));
    }
    return fail(issue('not_zip', null, null, 'Fail ini bukan fail .maxtheme yang sah.', 'This is not a valid .maxtheme file.'));
  }
  const problems: ThemeIssue[] = [...skipped];
  for (const [path, data] of entries) {
    if (FONT_PATH_RE.test(path)) {
      problems.push(issue('bad_font', path, null,
        `Fon tidak dibenarkan dalam tema (MAXCOM versi ini): ${safeName(path)}. Fon dipilih dalam menu Ubah suai.`,
        `Fonts are not allowed in a theme (this MAXCOM version): ${safeName(path)}. The font is chosen in the Customise menu.`));
      continue;
    }
    if (WEBP_RE.test(path)) {
      problems.push(issue('bad_image', path, null,
        `Gambar WebP tidak dibenarkan dalam tema: ${safeName(path)}. Guna PNG atau JPEG.`,
        `WebP pictures are not allowed in a theme: ${safeName(path)}. Use PNG or JPEG.`));
      continue;
    }
    if (packPathError(path) !== null) { problems.push(badPath(path)); continue; }
    if (data.length >= 4 && data.readUInt32LE(0) === 0x04034b50) {
      problems.push(issue('bad_path', path, null, `Zip di dalam zip tidak dibenarkan: ${safeName(path)}.`, `A zip inside a zip is not allowed: ${safeName(path)}.`));
    }
  }
  if (problems.length > 0) throw new ThemeError(problems);
  if (entries.size > MAX_PACK_FILES) {
    return fail(issue('too_many_files', null, null, 'Fail tema mengandungi lebih daripada 60 fail.', 'The theme file holds more than 60 files.'));
  }
  const json = entries.get('theme.json');
  if (json === undefined) return fail(missing('theme.json'));
  if (!entries.has('theme.css')) return fail(missing('theme.css'));
  if (json.length > MAX_THEME_JSON_BYTES) return fail(badJson('terlalu besar (paling banyak 64 KB)', 'too large (at most 64 KB)'));
  const jsonText = decodeUtf8(json);
  if (jsonText === null) return fail(badJson('bukan teks UTF-8', 'not UTF-8 text'));
  const manifest = parseManifest(jsonText);

  const css = new Map<string, string>();
  const images: PackFiles['images'] = new Map();
  let cssTotal = 0;
  for (const [path, data] of entries) {
    if (path === 'theme.json') continue;
    if (path.endsWith('.css')) {
      if (data.length > MAX_CSS_BYTES) {
        return fail(issue('too_big', path, null, `${path} melebihi 512 KB.`, `${path} is larger than 512 KB.`));
      }
      const text = decodeUtf8(data);
      if (text === null) {
        return fail(issue('css_parse', path, null, `${path}: CSS tidak dapat dibaca (bukan teks UTF-8).`, `${path}: the CSS cannot be read (not UTF-8 text).`));
      }
      cssTotal += data.length;
      if (cssTotal > MAX_TOTAL_CSS_BYTES) {
        return fail(issue('too_big', path, null, 'Semua fail CSS tema melebihi 1 MB.', 'All the CSS files of the theme together are larger than 1 MB.'));
      }
      css.set(path, text);
      continue;
    }
    const m = IMAGE_RE.exec(path);
    if (m !== null) images.set(m[1] as ScreenId | 'semua', { ext: m[2] as ImageExt, data });
  }
  if (images.size > 0) {
    // Two pictures for one screen (kuliah.jpg and kuliah.png) cannot both be right.
    const keys = [...entries.keys()].filter((p) => IMAGE_RE.test(p)).map((p) => IMAGE_RE.exec(p)![1]);
    if (new Set(keys).size !== keys.length) return fail(badPath('images/ (dua gambar untuk satu skrin)'));
  }
  return { manifest, css, images, fileCount: entries.size, bytes: buf.length };
}
