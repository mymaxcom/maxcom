import { MAX_PACKS, SCREEN_IDS } from '@surau/core';
import type { InstalledPacks, ScreenId, ThemeStyleEntry } from '@surau/core';
import { readImageHeader } from '../assets/imageHeader.ts';
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE } from '../assets/store.ts';
import { decodeImage, encodeJpeg, encodePng } from '../imageResize.ts';
import { checkCss } from './cssCheck.ts';
import { issue, readPack, ThemeError } from './packFormat.ts';
import type { ImageExt, PackFiles, ThemeIssue } from './packFormat.ts';


export interface PackReport {
  ok: boolean;
  name: string | null;
  title: string | null;
  version: number | null;
  base: string | null;
  contract: number | null;
  fileCount: number;
  bytes: number;
  screens: ScreenId[];
  /** Always empty: a pack holds no font (v1). Kept so the report keeps its shape. */
  fonts: string[];
  images: Partial<Record<ScreenId | 'semua', ImageExt>>;
  /** The menu values the pack ships (theme.json defaults), so the app can preview the staged pack before it is installed. */
  defaults: Partial<ThemeStyleEntry>;
  isUpdate: boolean;
  installedVersion: number | null;
  errors: ThemeIssue[];
  warnings: ThemeIssue[];
}

export interface ValidateContext {
  installed: InstalledPacks;
  /** The highest theme contract this box supports. */
  contract: number;
  /** False when re-checking a pack that arrived by sync (the version rule was applied where it was uploaded). */
  enforceVersion: boolean;
  /** Test hook: smaller limits. */
  limits?: { pixels?: number; cleanBytes?: number };
}

/** All pictures of one pack together, in decoded pixels (read from their headers before anything is decoded). */
export const MAX_PACK_PIXELS = 40_000_000;
/** All pictures of one pack together once drawn again (what is written to the box's disk and served). */
export const MAX_PACK_CLEAN_BYTES = 24 * 1024 * 1024;

const IMAGE_MIME: Record<ImageExt, string> = { jpg: 'image/jpeg', png: 'image/png' };
const JPEG_QUALITY = 88;

export function emptyReport(errors: ThemeIssue[]): PackReport {
  return {
    ok: false, name: null, title: null, version: null, base: null, contract: null, fileCount: 0, bytes: 0,
    screens: [], fonts: [], images: {}, defaults: {}, isUpdate: false, installedVersion: null, errors, warnings: [],
  };
}

/**
 * The picture as the kiosk may receive it: decoded and drawn again as a plain PNG or JPEG of the same size, so nothing
 * but pixels survives (no metadata, no extra chunks, no trailing bytes, no second image format hidden in the file).
 * Null when it is not a valid picture of its kind, or too big.
 */
export function cleanPackImage(ext: ImageExt, data: Buffer): Buffer | null {
  if (data.length > MAX_IMAGE_BYTES) return null;
  const h = readImageHeader(data);
  if (h === null || h.mime !== IMAGE_MIME[ext]) return null;
  if (h.width > MAX_IMAGE_SIDE || h.height > MAX_IMAGE_SIDE || h.width * h.height > MAX_IMAGE_PIXELS) return null;
  try {
    const img = decodeImage(data);
    if (img.width !== h.width || img.height !== h.height) return null;
    const out = ext === 'png' ? encodePng(img) : encodeJpeg(img, JPEG_QUALITY);
    return out.length > 0 && out.length <= MAX_IMAGE_BYTES ? out : null;
  } catch {
    return null;
  }
}

export interface ValidateResult { report: PackReport; files: PackFiles | null }

/**
 * Everything a pack must satisfy before this box stores it. All issues of all files are collected. The work is a
 * generator that yields between files, so the caller may let the event loop breathe (validatePackAsync) or run it
 * straight through (validatePack). `files` holds the pictures as re-encoded by cleanPackImage, never the uploaded bytes.
 */
function* validateSteps(buf: Buffer, ctx: ValidateContext): Generator<void, ValidateResult> {
  let files: PackFiles;
  try {
    files = readPack(buf);
  } catch (e) {
    if (e instanceof ThemeError) return { report: emptyReport(e.issues), files: null };
    throw e;
  }
  const m = files.manifest;
  const errors: ThemeIssue[] = [];
  const warnings: ThemeIssue[] = [];
  const installed = Object.prototype.hasOwnProperty.call(ctx.installed, m.name) ? ctx.installed[m.name]! : null;

  if (m.contract > ctx.contract) {
    errors.push(issue('needs_newer', 'theme.json', null,
      `Tema ini memerlukan MAXCOM yang lebih baharu. Tema dibuat untuk kontrak ${m.contract}; MAXCOM di surau ini menyokong kontrak ${ctx.contract}.`,
      `This theme needs a newer MAXCOM. It was made for contract ${m.contract}; this MAXCOM supports contract ${ctx.contract}.`));
  }
  if (installed !== null && ctx.enforceVersion && m.version <= installed.version) {
    errors.push(issue('version_not_higher', 'theme.json', null,
      `Versi sama atau lebih rendah. ${m.title} versi ${installed.version} sudah dipasang. Naikkan nombor versi dalam theme.json.`,
      `Same or lower version. ${m.title} version ${installed.version} is already installed. Raise the version number in theme.json.`));
  }
  if (installed === null && Object.keys(ctx.installed).length >= MAX_PACKS) {
    errors.push(issue('too_many_themes', null, null,
      `Had ${MAX_PACKS} tema dimuat naik telah dicapai. Padam tema yang tidak digunakan.`,
      `The limit of ${MAX_PACKS} uploaded themes is reached. Delete a theme that is not used.`));
  }

  const imageNames = new Set<string>();
  const imagesOut: PackReport['images'] = {};
  const cleaned: PackFiles['images'] = new Map();
  const maxPixels = ctx.limits?.pixels ?? MAX_PACK_PIXELS;
  const maxClean = ctx.limits?.cleanBytes ?? MAX_PACK_CLEAN_BYTES;
  let pixels = 0;
  let cleanBytes = 0;
  let overBudget = false;
  for (const [key, img] of files.images) {
    yield;
    const path = `images/${key}.${img.ext}`;
    imageNames.add(`${key}.${img.ext}`);
    imagesOut[key] = img.ext;
    // the budget is read from the header, so a pack that is over it costs no decoding at all
    const head = readImageHeader(img.data);
    pixels += head === null ? 0 : head.width * head.height;
    if (pixels > maxPixels) {
      if (!overBudget) {
        overBudget = true;
        errors.push(issue('bad_image', path, null,
          `Gambar dalam tema ini terlalu besar bersama: lebih ${Math.round(maxPixels / 1_000_000)} megapiksel semuanya.`,
          `The pictures of this theme are too large together: more than ${Math.round(maxPixels / 1_000_000)} megapixels in all.`));
      }
      continue;
    }
    const clean = cleanPackImage(img.ext, img.data);
    if (clean !== null) {
      cleanBytes += clean.length;
      if (cleanBytes > maxClean) {
        if (!overBudget) {
          overBudget = true;
          errors.push(issue('bad_image', path, null,
            'Gambar dalam tema ini terlalu besar bersama selepas disimpan semula.', 'The pictures of this theme are too large together once saved again.'));
        }
        continue;
      }
    }
    if (clean === null) {
      errors.push(issue('bad_image', path, null,
        `Gambar ${path} tidak sah atau terlalu besar.`, `The picture ${path} is not valid or too large.`));
    } else {
      cleaned.set(key, { ext: img.ext, data: clean });
    }
  }
  const screens: ScreenId[] = [];
  const order = ['theme.css', ...SCREEN_IDS.map((id) => `screens/${id}.css`), 'arabic.css'];
  for (const path of order) {
    const css = files.css.get(path);
    if (css === undefined) continue;
    if (path.startsWith('screens/')) screens.push(path.slice(8, -4) as ScreenId);
    yield;
    const r = checkCss(css, { file: path, images: imageNames });
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }

  const report: PackReport = {
    ok: errors.length === 0,
    name: m.name, title: m.title, version: m.version, base: m.base, contract: m.contract,
    fileCount: files.fileCount, bytes: files.bytes,
    screens, fonts: [], images: imagesOut, defaults: m.defaults,
    isUpdate: installed !== null, installedVersion: installed === null ? null : installed.version,
    errors, warnings,
  };
  return { report, files: report.ok ? { ...files, images: cleaned } : null };
}

/** The same check, run straight through. */
export function validatePack(buf: Buffer, ctx: ValidateContext): ValidateResult {
  const run = validateSteps(buf, ctx);
  for (;;) {
    const step = run.next();
    if (step.done === true) return step.value;
  }
}

/** The same check, letting the event loop run between files (the upload route and the install use this). */
export async function validatePackAsync(buf: Buffer, ctx: ValidateContext): Promise<ValidateResult> {
  const run = validateSteps(buf, ctx);
  for (;;) {
    const step = run.next();
    if (step.done === true) return step.value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
