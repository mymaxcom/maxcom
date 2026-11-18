import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isBuiltInTheme, isScreenId, isThemeName, THEME_CONTRACT, THEME_TITLES } from '@surau/core';
import type { KioskTemplateId, ScreenStyle, ThemeStyleEntry } from '@surau/core';
import { getAssetPath } from '../assets/store.ts';
import { writeStoredZip } from '../files/zipWrite.ts';
import type { ZipEntry } from '../files/zipWrite.ts';
import { getSettings } from '../settingsStore.ts';
import { LOCAL_SURAU_ID } from '../tenant.ts';
import { isReservedName, MAX_PACK_BYTES, MAX_PACK_FILES, readPack } from './packFormat.ts';
import type { ImageExt, PackFiles } from './packFormat.ts';
import { validatePack } from './validate.ts';

export interface DownloadDeps { db: DatabaseSync; dataDir: string; staticDir: string | null }

/** A refusal with the HTTP status the route answers with. `errors` are BM sentences. */
export class DownloadError extends Error {
  readonly status: number;
  readonly errors: string[];
  constructor(status: number, errors: string[]) {
    super(errors.join('; '));
    this.name = 'DownloadError';
    this.status = status;
    this.errors = errors;
  }
}

const MIME_EXT: Record<string, ImageExt> = { 'image/jpeg': 'jpg', 'image/png': 'png' };
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The hooks a theme author can rely on, as the comment of a starting pack's theme.css. */
export const STARTER_CSS = `/* MAXCOM theme file, contract 1.
   This theme extends its base theme: anything not styled here keeps the base look.
   Edit this file, raise "version" in theme.json, zip the folder as <name>.maxtheme and upload it again.

   Screens (data-screen on the stage): biasa, azan, masuk-waktu, iqamah, solat, jumaat, tiada-data, live, poster, kuliah,
   program, hadis, zikir, tilawah, pengumuman, takwim, tabung, ayat, arab-ayat, arab-hadis, arab-zikir.
   Other hooks: data-phase, data-card, data-kind, data-live, data-live-layout, data-harakat, data-align, data-lang,
   data-picture (a background picture is under the text), data-gold (the gold outline on large text: on or off).
   Regions: .region-main, .region-prayers, .region-clock, .region-brand, .region-ticker, .region-live-strip.
   Arabic text: .arab, .arab-tarjamah.
   Variables the menu sets: --bg-image, --bg-fit, --bg-size, --bg-pos, --shade, --accent, --text, --font, --scale.
   Pictures (PNG or JPEG) come from the folder images/ of this file only; no @import, no outside addresses, no fonts
   (the font is chosen in the Customise menu).
   A theme re-skins its base theme; it does not re-layout it. Allowed: classes, the data-* hooks above, :first-child,
   :last-child, :nth-child() and :not(); color, background (your pictures and gradients), border, border-radius, outline,
   box-shadow and text-shadow (bounded), padding, margin, gap, font-weight, font-style, text-transform, letter-spacing,
   line-height, text-align, width and height (never on the clock, the prayer times, the next-prayer chip or the logo),
   and --variables (your own, named --pack-something, or the base colours --accent, --accent-2, --text, --ink, --muted, --paper, --hair,
   --rule, --mint, --green, --sunset, --harakat, --accent-rgb and --glass-rgb; every other theme variable is refused). Not allowed: position, top and the other offsets, transform, scale, zoom, opacity, visibility, display,
   z-index, overflow, filter, mask, clip-path, mix-blend-mode, font-family, font-size, content, animation, transition,
   pseudo-elements (::before, ::after), !important, and html, body and :root rules.
   Prayer times, the clock, the countdowns and the next-prayer chip always stay visible: MAXCOM falls back to the
   base theme when a theme hides them.

   Example (remove the comment marks to use it):
   .stage[data-screen='kuliah'] .region-main { border: 0.3rem solid #f9b544; border-radius: 1rem; }
*/
`;

/** The `defaults` of a built-in theme, from the kiosk build's copy of its theme.json. */
function builtInDefaults(deps: DownloadDeps, id: KioskTemplateId): Partial<ThemeStyleEntry> {
  if (deps.staticDir === null) throw new DownloadError(500, ['Fail tema bawaan tidak tersedia pada kotak ini.']);
  try {
    const raw: unknown = JSON.parse(readFileSync(join(deps.staticDir, 'builtin-themes', id, 'theme.json'), 'utf8'));
    return isPlain(raw) && isPlain(raw.defaults) ? (JSON.parse(JSON.stringify(raw.defaults)) as Partial<ThemeStyleEntry>) : {};
  } catch {
    throw new DownloadError(500, ['Fail tema bawaan tidak tersedia pada kotak ini.']);
  }
}

const withoutBg = (s: ScreenStyle): ScreenStyle => {
  const { bgImage: _gone, ...rest } = s;
  return rest;
};

/** Pack defaults overlaid with the surau's menu values; the menu pictures come out as separate files. */
function bake(
  deps: DownloadDeps, base: Partial<ThemeStyleEntry>, own: ThemeStyleEntry | undefined,
): { defaults: Partial<ThemeStyleEntry>; images: Map<string, { ext: ImageExt; data: Buffer }> } {
  const images = new Map<string, { ext: ImageExt; data: Buffer }>();
  const semua: ScreenStyle = { ...(base.semua ?? {}) };
  const skrin: Record<string, ScreenStyle> = {};
  for (const [id, s] of Object.entries(base.skrin ?? {})) if (isScreenId(id) && s !== undefined) skrin[id] = { ...s };
  const take = (key: string, ref: string | undefined): void => {
    if (ref === undefined) return;
    const found = getAssetPath(deps.db, deps.dataDir, ref);
    const ext = found === null ? undefined : MIME_EXT[found.mime];
    if (found === null || ext === undefined) return; // the picture is gone from this box: nothing to carry
    images.set(key, { ext, data: readFileSync(found.path) });
  };
  if (own !== undefined) {
    take('semua', own.semua.bgImage);
    Object.assign(semua, withoutBg(own.semua));
    for (const [id, s] of Object.entries(own.skrin)) {
      if (!isScreenId(id) || s === undefined) continue;
      take(id, s.bgImage);
      skrin[id] = { ...(skrin[id] ?? {}), ...withoutBg(s) };
    }
  }
  const defaults: Partial<ThemeStyleEntry> = {};
  if (Object.keys(semua).length > 0) defaults.semua = semua;
  if (Object.keys(skrin).length > 0) defaults.skrin = skrin;
  return { defaults, images };
}

const tooBigAfterBake = new DownloadError(400, ['Fail tema melebihi had selepas ubah suai disertakan. Muat turun tanpa ubah suai.']);

function titleFor(deps: DownloadDeps, id: KioskTemplateId): string {
  // eslint-disable-next-line no-control-regex
  const surau = getSettings(deps.db, LOCAL_SURAU_ID).surauInfo.name.replace(/[<>\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  return (surau === '' ? THEME_TITLES[id] : `${THEME_TITLES[id]} (${surau})`).slice(0, 60);
}

function assemble(files: PackFiles, manifest: Record<string, unknown>, images: Map<string, { ext: ImageExt; data: Buffer }>): Buffer {
  const entries: ZipEntry[] = [{ name: 'theme.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') }];
  for (const [path, text] of files.css) entries.push({ name: path, data: Buffer.from(text) });
  for (const [key, img] of images) entries.push({ name: `images/${key}.${img.ext}`, data: img.data });
  if (entries.length > MAX_PACK_FILES) throw tooBigAfterBake;
  const out = writeStoredZip(entries);
  if (out.length > MAX_PACK_BYTES) throw tooBigAfterBake;
  return out;
}

export function buildDownload(deps: DownloadDeps, name: string, opts: { bake: boolean; as?: string }): { fileName: string; data: Buffer } {
  const styles = getSettings(deps.db, LOCAL_SURAU_ID).themeStyle.styles;
  const own = Object.prototype.hasOwnProperty.call(styles, name) ? styles[name] : undefined;
  let fileName: string;
  let data: Buffer;

  if (isBuiltInTheme(name)) {
    const as = opts.as;
    if (typeof as !== 'string' || !isThemeName(as)) {
      throw new DownloadError(400, ['Nama fail tema tidak sah. Guna huruf kecil, nombor dan sempang (paling panjang 32 aksara).']);
    }
    if (isReservedName(as)) {
      throw new DownloadError(400, [`Nama tema ${as} dikhaskan untuk tema bawaan MAXCOM. Pilih nama lain.`]);
    }
    const { defaults, images } = bake(deps, builtInDefaults(deps, name), opts.bake ? own : undefined);
    const files: PackFiles = { manifest: { name: as, title: '', version: 1, contract: 1, base: name, defaults }, css: new Map([['theme.css', STARTER_CSS]]), images: new Map(), fileCount: 0, bytes: 0 };
    data = assemble(files, { name: as, title: titleFor(deps, name), version: 1, contract: THEME_CONTRACT, base: name, defaults }, images);
    fileName = `${as}.maxtheme`;
  } else {
    const rec = Object.prototype.hasOwnProperty.call(getSettings(deps.db, LOCAL_SURAU_ID).themeStyle.packs, name) ? getSettings(deps.db, LOCAL_SURAU_ID).themeStyle.packs[name] : undefined;
    const asset = rec === undefined ? null : getAssetPath(deps.db, deps.dataDir, rec.assetId);
    if (rec === undefined || asset === null) throw new DownloadError(404, ['not found']);
    const stored = readFileSync(asset.path);
    fileName = `${name}.maxtheme`;
    if (!opts.bake) {
      data = stored;
    } else {
      const files = readPack(stored);
      const { defaults, images } = bake(deps, files.manifest.defaults, own);
      const merged = new Map<string, { ext: ImageExt; data: Buffer }>(files.images);
      for (const [k, v] of images) merged.set(k, v); // a baked picture replaces the pack's picture of the same key
      const m = files.manifest;
      data = assemble(files, { name: m.name, title: m.title, version: m.version, contract: m.contract, base: m.base, defaults }, merged);
    }
  }

  // The box never hands out a file it would refuse itself.
  const check = validatePack(data, { installed: {}, contract: THEME_CONTRACT, enforceVersion: false });
  if (!check.report.ok) {
    console.error(`theme download refused by the validator: ${check.report.errors.map((e) => e.messageEn).join(' | ')}`);
    throw new DownloadError(500, ['Fail tema tidak dapat disediakan.']);
  }
  return { fileName, data };
}
