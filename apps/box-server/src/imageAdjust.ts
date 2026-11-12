import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { IMAGE_SLOTS, MIN_CROP_SPAN } from '@surau/core';
import type { AdjustedImage, ImageRect, ImageRef, ImageSlotKey } from '@surau/core';
import { getAssetPath, putAsset } from './assets/store.ts';
import { decodeImage, encodeJpeg, encodePng, premulToRgba, resamplePremul, scaleToBox } from './imageResize.ts';
import type { Rgba } from './imageResize.ts';

/** change_log / created_by name for derived pictures. */
export const IMAGE_ADJUST_ACTOR = 'system:image-adjust';

/** Fill of the rounded plate behind a logo set to `card` (a warm white). */
export const PLATE_COLOUR: [number, number, number] = [248, 246, 240];

/** Largest distance (any colour channel) at which a pixel still counts as the plain background. */
const BG_TOLERANCE = 24;
/** Background removal ramp: fully transparent up to LOW, fully opaque from HIGH, soft in between. */
const REMOVE_LOW = 16;
const REMOVE_HIGH = 80;
const PLAIN_CONFIDENCE = 0.9;
const NEAR_WHITE = 235;

/** Why a picture could not be adjusted. `missing`: the source asset is not there (the save answers 409). */
export class ImageAdjustError extends Error {
  readonly missing: boolean;

  constructor(message: string, missing = false) {
    super(message);
    this.name = 'ImageAdjustError';
    this.missing = missing;
  }
}

export interface ImageAnalysis {
  width: number;
  height: number;
  /** Tight box around the content (not the empty or uniform margin), normalised 0..1. The whole picture when there is nothing to trim. */
  trim: ImageRect;
  background: {
    /** True when the four corners and most of the border are one plain colour. */
    plain: boolean;
    /** `#rrggbb` of that colour, or null when the picture is not plain (or already transparent). */
    colour: string | null;
    /** Share of the border pixels that match the colour, 0..1. */
    confidence: number;
    /** The picture already has a transparent background. */
    transparent: boolean;
    /** What the app should offer first: `remove` for a plain light background, else `keep`. */
    suggested: 'remove' | 'keep';
  };
}

const FULL: ImageRect = { x: 0, y: 0, w: 1, h: 1 };
const hex2 = (n: number): string => Math.round(n).toString(16).padStart(2, '0');

function dist(d: Uint8Array, i: number, c: readonly [number, number, number]): number {
  return Math.max(Math.abs(d[i]! - c[0]), Math.abs(d[i + 1]! - c[1]), Math.abs(d[i + 2]! - c[2]));
}

/** Mean colour and alpha of the up to 3x3 block at a corner. */
function cornerOf(img: Rgba, cx: number, cy: number): { c: [number, number, number]; a: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let n = 0;
  for (let dy = 0; dy < 3; dy += 1) {
    for (let dx = 0; dx < 3; dx += 1) {
      const x = cx === 0 ? dx : img.width - 1 - dx;
      const y = cy === 0 ? dy : img.height - 1 - dy;
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const i = (y * img.width + x) * 4;
      r += img.data[i]!;
      g += img.data[i + 1]!;
      b += img.data[i + 2]!;
      a += img.data[i + 3]!;
      n += 1;
    }
  }
  return { c: [r / n, g / n, b / n], a: a / n };
}

/** Keeps a normalised box at least MIN_CROP_SPAN wide and inside 0..1. */
function clampRect(x: number, y: number, w: number, h: number): ImageRect {
  const ww = Math.min(1, Math.max(MIN_CROP_SPAN, w));
  const hh = Math.min(1, Math.max(MIN_CROP_SPAN, h));
  return { x: Math.min(Math.max(0, x), 1 - ww), y: Math.min(Math.max(0, y), 1 - hh), w: ww, h: hh };
}

/**
 * Reads the picture: size, the tight content box, and whether it sits on a plain background.
 * The background is the mean of the four corners; it is plain when the corners agree and most
 * of the border matches. A photo (busy border) is never trimmed.
 */
export function analyzeImage(img: Rgba): ImageAnalysis {
  const { width: W, height: H, data } = img;
  const corners = [cornerOf(img, 0, 0), cornerOf(img, 1, 0), cornerOf(img, 0, 1), cornerOf(img, 1, 1)];
  const transparentCorners = corners.filter((c) => c.a < 16).length;
  const transparent = transparentCorners >= 3;

  const bg: [number, number, number] = [0, 0, 0];
  const opaque = corners.filter((c) => c.a >= 16);
  for (const c of opaque) for (let k = 0; k < 3; k += 1) bg[k] = bg[k]! + c.c[k]! / Math.max(1, opaque.length);

  // Border statistics: how much of the outer ring is the corner colour (or empty, if transparent).
  const onRing = (x: number, y: number): boolean => {
    const i = (y * W + x) * 4;
    return transparent ? data[i + 3]! < 16 : data[i + 3]! >= 16 && dist(data, i, bg) <= BG_TOLERANCE;
  };
  let ringTotal = 0;
  let ringHit = 0;
  for (let x = 0; x < W; x += 1) {
    ringTotal += 2;
    ringHit += (onRing(x, 0) ? 1 : 0) + (onRing(x, H - 1) ? 1 : 0);
  }
  for (let y = 1; y < H - 1; y += 1) {
    ringTotal += 2;
    ringHit += (onRing(0, y) ? 1 : 0) + (onRing(W - 1, y) ? 1 : 0);
  }
  const confidence = ringTotal > 0 ? ringHit / ringTotal : 0;

  const cornersAgree = transparent || opaque.length === 4 && opaque.every((c) => Math.max(Math.abs(c.c[0] - bg[0]), Math.abs(c.c[1] - bg[1]), Math.abs(c.c[2] - bg[2])) <= BG_TOLERANCE);
  const plain = !transparent && cornersAgree && confidence >= PLAIN_CONFIDENCE;

  // Content box: pixels that are neither empty (transparent) nor the plain background.
  let trim = FULL;
  if (plain || transparent) {
    let minX = W;
    let minY = H;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const i = (y * W + x) * 4;
        const content = transparent ? data[i + 3]! >= 16 : data[i + 3]! >= 16 && dist(data, i, bg) > BG_TOLERANCE;
        if (!content) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX >= 0) trim = clampRect(minX / W, minY / H, (maxX - minX + 1) / W, (maxY - minY + 1) / H);
  }

  const nearWhite = plain && Math.min(bg[0], bg[1], bg[2]) >= NEAR_WHITE;
  // A uniform picture (nothing but background) has no content to keep: leave it alone.
  const contentFound = (() => {
    if (!(plain || transparent)) return false;
    for (let i = 0; i < data.length; i += 4) {
      if (transparent ? data[i + 3]! >= 16 : data[i + 3]! >= 16 && dist(data, i, bg) > BG_TOLERANCE) return true;
    }
    return false;
  })();

  return {
    width: W,
    height: H,
    trim,
    background: {
      plain,
      colour: plain ? `#${hex2(bg[0])}${hex2(bg[1])}${hex2(bg[2])}` : null,
      confidence: Math.round(confidence * 1000) / 1000,
      transparent,
      suggested: nearWhite && contentFound ? 'remove' : 'keep',
    },
  };
}

// ---- rendering -----------------------------------------------------------------------------

function rotateImage(img: Rgba, deg: 0 | 90 | 180 | 270): Rgba {
  if (deg === 0) return img;
  const { width: w, height: h } = img;
  const swap = deg === 90 || deg === 270;
  const out = new Uint8Array(img.data.length);
  const ow = swap ? h : w;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let nx: number;
      let ny: number;
      if (deg === 90) {
        nx = h - 1 - y;
        ny = x;
      } else if (deg === 180) {
        nx = w - 1 - x;
        ny = h - 1 - y;
      } else {
        nx = y;
        ny = w - 1 - x;
      }
      const s = (y * w + x) * 4;
      const d = (ny * ow + nx) * 4;
      out[d] = img.data[s]!;
      out[d + 1] = img.data[s + 1]!;
      out[d + 2] = img.data[s + 2]!;
      out[d + 3] = img.data[s + 3]!;
    }
  }
  return { width: ow, height: swap ? w : h, data: out };
}

function cropImage(img: Rgba, r: ImageRect): Rgba {
  const x0 = Math.min(img.width - 1, Math.max(0, Math.round(r.x * img.width)));
  const y0 = Math.min(img.height - 1, Math.max(0, Math.round(r.y * img.height)));
  const x1 = Math.min(img.width, Math.max(x0 + 1, Math.round((r.x + r.w) * img.width)));
  const y1 = Math.min(img.height, Math.max(y0 + 1, Math.round((r.y + r.h) * img.height)));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w === img.width && h === img.height) return img;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const s = ((y0 + y) * img.width + x0) * 4;
    out.set(img.data.subarray(s, s + w * 4), y * w * 4);
  }
  return { width: w, height: h, data: out };
}

/** Makes the plain background transparent; edge pixels get partial alpha and their colour is un-blended from the background. */
function removeBackground(img: Rgba, bgHex: string): Rgba {
  const bg: [number, number, number] = [
    parseInt(bgHex.slice(1, 3), 16),
    parseInt(bgHex.slice(3, 5), 16),
    parseInt(bgHex.slice(5, 7), 16),
  ];
  const out = new Uint8Array(img.data);
  for (let i = 0; i < out.length; i += 4) {
    const d = dist(out, i, bg);
    const t = d <= REMOVE_LOW ? 0 : d >= REMOVE_HIGH ? 1 : (d - REMOVE_LOW) / (REMOVE_HIGH - REMOVE_LOW);
    if (t >= 1) continue;
    const a = t * (out[i + 3]! / 255);
    if (a <= 0) {
      out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
      continue;
    }
    for (let k = 0; k < 3; k += 1) {
      out[i + k] = Math.max(0, Math.min(255, Math.round((out[i + k]! - bg[k]! * (1 - t)) / t)));
    }
    out[i + 3] = Math.round(a * 255);
  }
  return { width: img.width, height: img.height, data: out };
}

/** The picture on a rounded light plate with padding. Outside the rounded corners stays transparent. */
function onPlate(img: Rgba): Rgba {
  const pad = Math.max(2, Math.round(Math.min(img.width, img.height) * 0.1));
  const W = img.width + pad * 2;
  const H = img.height + pad * 2;
  const radius = Math.min(Math.round(Math.min(W, H) * 0.18), Math.floor(Math.min(W, H) / 2));
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      // Coverage of the rounded rectangle at this pixel centre (about one pixel of soft edge).
      const px = x + 0.5;
      const py = y + 0.5;
      const dx = Math.max(radius - px, px - (W - radius), 0);
      const dy = Math.max(radius - py, py - (H - radius), 0);
      const cover = Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(dx, dy)));
      const o = (y * W + x) * 4;
      let r = PLATE_COLOUR[0];
      let g = PLATE_COLOUR[1];
      let b = PLATE_COLOUR[2];
      const ix = x - pad;
      const iy = y - pad;
      if (ix >= 0 && iy >= 0 && ix < img.width && iy < img.height) {
        const s = (iy * img.width + ix) * 4;
        const a = img.data[s + 3]! / 255;
        r = img.data[s]! * a + r * (1 - a);
        g = img.data[s + 1]! * a + g * (1 - a);
        b = img.data[s + 2]! * a + b * (1 - a);
      }
      out[o] = Math.round(r);
      out[o + 1] = Math.round(g);
      out[o + 2] = Math.round(b);
      out[o + 3] = Math.round(cover * 255);
    }
  }
  return { width: W, height: H, data: out };
}

/** Centres `img` (shrunk or enlarged to fit) on a transparent `size` x `size` canvas. */
function centreOnSquare(img: Rgba, size: number): Rgba {
  const fit = resamplePremul(img, ...fitDims(img, size, size));
  const out = new Uint8Array(size * size * 4);
  const offX = Math.floor((size - fit.w) / 2);
  const offY = Math.floor((size - fit.h) / 2);
  const rgba = premulToRgba(fit);
  for (let y = 0; y < rgba.height; y += 1) {
    out.set(rgba.data.subarray(y * rgba.width * 4, (y + 1) * rgba.width * 4), ((y + offY) * size + offX) * 4);
  }
  return { width: size, height: size, data: out };
}

function fitDims(img: Rgba, maxW: number, maxH: number): [number, number] {
  const s = Math.min(maxW / img.width, maxH / img.height);
  return [Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s))];
}

/** Centre-crops to `aspect` (width / height) then resamples to exactly `w` x `h`. */
function coverTo(img: Rgba, w: number, h: number): Rgba {
  const aspect = w / h;
  const cur = img.width / img.height;
  let r: ImageRect = FULL;
  if (cur > aspect) {
    const keep = aspect / cur;
    r = { x: (1 - keep) / 2, y: 0, w: keep, h: 1 };
  } else if (cur < aspect) {
    const keep = cur / aspect;
    r = { x: 0, y: (1 - keep) / 2, w: 1, h: keep };
  }
  return premulToRgba(resamplePremul(cropImage(img, r), w, h));
}

const hasAlpha = (img: Rgba): boolean => {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! < 255) return true;
  return false;
};

/**
 * Renders one derivative of `src` for `slot` from the adjustment. Order: rotate, crop (the slot
 * `square` area for the square logo), background (`remove` / `card`), then fit the slot's fixed
 * output size. The output size comes from the slot table, never from the request.
 */
export function renderSlot(src: Rgba, slot: ImageSlotKey, ref: AdjustedImage): { data: Buffer; mime: 'image/png' | 'image/jpeg' } {
  const spec = IMAGE_SLOTS[slot];
  const rotated = rotateImage(src, ref.rotate ?? 0);
  const rect = slot === 'logoSquare' ? (ref.square ?? ref.crop ?? FULL) : (ref.crop ?? FULL);
  let img = cropImage(rotated, rect);

  const bg = ref.bg ?? 'keep';
  if (bg === 'remove' || bg === 'card') {
    const a = analyzeImage(rotated);
    if (a.background.plain && a.background.colour !== null) img = removeBackground(img, a.background.colour);
    if (bg === 'card') img = onPlate(img);
  }

  let out: Rgba;
  if (slot === 'logoSquare') out = centreOnSquare(img, spec.maxW);
  else if (spec.aspect === 'free' || spec.fit === 'contain') out = scaleToBox(img, spec.maxW, spec.maxH, false);
  else out = coverTo(img, spec.maxW, spec.maxH);

  // Logos keep PNG (they usually have transparency); opaque photos are smaller as JPEG.
  if (slot === 'logo' || slot === 'logoSquare' || hasAlpha(out)) return { data: encodePng(out), mime: 'image/png' };
  return { data: encodeJpeg(out, 90), mime: 'image/jpeg' };
}

// ---- derived assets ------------------------------------------------------------------------

const rectKey = (r: ImageRect | undefined): number[] | null => (r === undefined ? null : [r.x, r.y, r.w, r.h]);

/** The adjustment that matters for `slot` (the square area counts for the square logo only). */
function relevant(slot: ImageSlotKey, ref: AdjustedImage): boolean {
  return ref.crop !== undefined || ref.bg !== undefined || ref.rotate !== undefined || (slot === 'logoSquare' && ref.square !== undefined);
}

function keyOf(slot: ImageSlotKey, ref: AdjustedImage): string {
  const payload = ['v1', slot, ref.asset, rectKey(ref.crop), ref.bg ?? null, ref.rotate ?? null, slot === 'logoSquare' ? rectKey(ref.square) : null];
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function loadSource(db: DatabaseSync, dataDir: string, id: string): Rgba {
  const found = getAssetPath(db, dataDir, id);
  if (found === null) throw new ImageAdjustError('the picture refers to an asset that does not exist', true);
  if (found.mime !== 'image/png' && found.mime !== 'image/jpeg') {
    throw new ImageAdjustError('only a PNG or JPEG picture can be adjusted');
  }
  try {
    return decodeImage(readFileSync(found.path));
  } catch {
    throw new ImageAdjustError('the picture could not be read');
  }
}

/**
 * The asset id to show for an image field. A plain id, or an object with nothing to apply, is the
 * original asset. Otherwise the derivative for `slot` is rendered once and stored as an ordinary
 * asset; the same adjustment finds it again by its key, so no copy is ever made twice.
 * Throws ImageAdjustError when the source is missing or cannot be adjusted.
 */
export function deriveImage(db: DatabaseSync, dataDir: string, slot: ImageSlotKey, ref: ImageRef, actor: string = IMAGE_ADJUST_ACTOR): string {
  if (typeof ref === 'string') return ref;
  if (!relevant(slot, ref)) return ref.asset;
  const key = keyOf(slot, ref);
  const row = db.prepare('SELECT derived_id FROM asset_derivatives WHERE key = ?').get(key);
  if (row !== undefined && typeof row.derived_id === 'string') {
    if (db.prepare('SELECT 1 AS ok FROM assets WHERE id = ?').get(row.derived_id) !== undefined) return row.derived_id;
  }
  const out = renderSlot(loadSource(db, dataDir, ref.asset), slot, ref);
  const meta = putAsset(db, dataDir, out.data, out.mime, actor);
  db.prepare(
    'INSERT INTO asset_derivatives (key, source_id, slot, derived_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET derived_id = excluded.derived_id',
  ).run(key, ref.asset, slot, meta.id, new Date().toISOString());
  db.prepare('DELETE FROM asset_derivative_failures WHERE key = ?').run(key);
  return meta.id;
}

/**
 * Like deriveImage but for reads: any failure falls back to the original asset id, never throws.
 * A source that cannot be decoded is remembered (keyed by source + params) so a public read does
 * not decode it again on every request; a different source or different params is a new key.
 * A missing source is not remembered: the asset may still arrive.
 */
export function resolveImageId(db: DatabaseSync, dataDir: string, slot: ImageSlotKey, ref: ImageRef): string {
  const original = typeof ref === 'string' ? ref : ref.asset;
  if (typeof ref === 'string' || !relevant(slot, ref)) return original;
  const key = keyOf(slot, ref);
  try {
    if (db.prepare('SELECT 1 AS ok FROM asset_derivative_failures WHERE key = ?').get(key) !== undefined) return original;
    return deriveImage(db, dataDir, slot, ref);
  } catch (error) {
    if (!(error instanceof ImageAdjustError && error.missing)) {
      try {
        db.prepare('INSERT OR IGNORE INTO asset_derivative_failures (key, source_id, slot, failed_at) VALUES (?, ?, ?, ?)').run(
          key,
          ref.asset,
          slot,
          new Date().toISOString(),
        );
      } catch {
        // a read must never fail on bookkeeping
      }
    }
    return original;
  }
}

/**
 * The first-boot adjustment for a logo file: trim the empty margin and, for a plain light
 * background, make it transparent. A picture with nothing to trim or remove stays a plain id.
 */
export function initialLogoRef(img: Rgba, assetId: string): ImageRef {
  const a = analyzeImage(img);
  const trimmed = a.trim.w < 0.999 || a.trim.h < 0.999;
  const out: AdjustedImage = { asset: assetId };
  if (trimmed) out.crop = a.trim;
  if (a.background.suggested === 'remove') out.bg = 'remove';
  return out.crop === undefined && out.bg === undefined ? assetId : out;
}
