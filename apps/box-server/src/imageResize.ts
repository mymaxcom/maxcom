import { createRequire } from 'node:module';
import type { PNG as PngClass } from 'pngjs';

// pngjs is CommonJS; loading it through require keeps named imports out of the ESM loader.
const require = createRequire(import.meta.url);
const { PNG } = require('pngjs') as { PNG: typeof PngClass };
const jpeg = require('jpeg-js') as {
  decode(
    data: Buffer,
    opts: { useTArray: boolean; formatAsRGBA: boolean; maxMemoryUsageInMB: number; maxResolutionInMP: number },
  ): { width: number; height: number; data: Uint8Array };
  encode(img: { width: number; height: number; data: Uint8Array }, quality: number): { data: Buffer };
};

/** Straight (non-premultiplied) 8-bit RGBA. */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

/** What an app icon is for: `any` keeps the logo's transparency, `maskable` fills the whole square. */
export type IconKind = 'any' | 'maskable';

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_PIXELS = 16_000_000;
const MAX_SIDE = 8192;
/** Same cap the asset store applies to an uploaded image (8 MB). */
const MAX_BYTES = 8 * 1024 * 1024;

/** Reads width/height from the IHDR chunk and refuses an absurd size before any inflate work. */
function checkPngHeader(buf: Buffer): void {
  if (buf.length > MAX_BYTES) throw new Error('image is too large');
  if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') throw new Error('damaged PNG header');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width === 0 || height === 0) throw new Error('image has no size');
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) throw new Error('image is too large');
}

/** Decodes a PNG or JPEG (chosen by its magic bytes). Throws on anything else or on a damaged file. */
export function decodeImage(buf: Buffer): Rgba {
  if (buf.length >= 8 && PNG_SIG.every((b, i) => buf[i] === b)) {
    checkPngHeader(buf);
    const png = PNG.sync.read(buf);
    if (png.width * png.height > MAX_PIXELS) throw new Error('image is too large');
    return { width: png.width, height: png.height, data: png.data };
  }
  if (buf.length > MAX_BYTES) throw new Error('image is too large');
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 256, maxResolutionInMP: 17 });
    return { width: img.width, height: img.height, data: img.data };
  }
  throw new Error('not a PNG or JPEG image');
}

/** `#rrggbb` to bytes; anything else is the box's dark green. */
function parseColour(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : [0x06, 0x30, 0x2b];
}

/** Premultiplied float RGBA: colour channels already multiplied by alpha (0..255 scale), alpha 0..255. */
export interface PremulImage {
  w: number;
  h: number;
  px: Float32Array;
}

/**
 * `src` resampled to exactly `outW` x `outH` as premultiplied float RGBA. Shrinking averages
 * every source pixel the destination pixel covers (area average); enlarging both ways
 * interpolates bilinearly. Premultiplied maths keeps transparent edges free of dark fringes.
 */
export function resamplePremul(src: Rgba, outW: number, outH: number): PremulImage {
  const w = Math.max(1, Math.round(outW));
  const h = Math.max(1, Math.round(outH));
  const sxs = w / src.width;
  const sys = h / src.height;
  const px = new Float32Array(w * h * 4);
  const s = src.data;
  const sw = src.width;
  const sh = src.height;

  const fetch = (x: number, y: number, weight: number, acc: Float32Array): void => {
    const i = (y * sw + x) * 4;
    const a = (s[i + 3]! / 255) * weight;
    acc[0]! += s[i]! * a;
    acc[1]! += s[i + 1]! * a;
    acc[2]! += s[i + 2]! * a;
    acc[3]! += a;
  };
  const acc = new Float32Array(4);
  const area = sxs < 1 || sys < 1;

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      acc.fill(0);
      let total = 0;
      if (area) {
        const x0 = x / sxs;
        const x1 = (x + 1) / sxs;
        const y0 = y / sys;
        const y1 = (y + 1) / sys;
        for (let sy = Math.floor(y0); sy < Math.min(sh, Math.ceil(y1)); sy += 1) {
          const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
          for (let sx = Math.floor(x0); sx < Math.min(sw, Math.ceil(x1)); sx += 1) {
            const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
            fetch(sx, sy, wx * wy, acc);
            total += wx * wy;
          }
        }
      } else {
        const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / sxs - 0.5));
        const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / sys - 0.5));
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const tx = fx - ix;
        const ty = fy - iy;
        const nx = Math.min(sw - 1, ix + 1);
        const ny = Math.min(sh - 1, iy + 1);
        fetch(ix, iy, (1 - tx) * (1 - ty), acc);
        fetch(nx, iy, tx * (1 - ty), acc);
        fetch(ix, ny, (1 - tx) * ty, acc);
        fetch(nx, ny, tx * ty, acc);
        total = 1;
      }
      const o = (y * w + x) * 4;
      if (total > 0) {
        px[o] = acc[0]! / total;
        px[o + 1] = acc[1]! / total;
        px[o + 2] = acc[2]! / total;
        px[o + 3] = (acc[3]! / total) * 255;
      }
    }
  }
  return { w, h, px };
}

/** Premultiplied float RGBA back to straight 8-bit RGBA. */
export function premulToRgba(img: PremulImage): Rgba {
  const data = new Uint8Array(img.w * img.h * 4);
  for (let i = 0; i < img.w * img.h; i += 1) {
    const a = img.px[i * 4 + 3]! / 255;
    if (a > 0) {
      data[i * 4] = Math.min(255, Math.round(img.px[i * 4]! / a));
      data[i * 4 + 1] = Math.min(255, Math.round(img.px[i * 4 + 1]! / a));
      data[i * 4 + 2] = Math.min(255, Math.round(img.px[i * 4 + 2]! / a));
      data[i * 4 + 3] = Math.round(a * 255);
    }
  }
  return { width: img.w, height: img.h, data };
}

/** The picture scaled to fit inside `maxW` x `maxH` (aspect kept). Never enlarged unless `upscale`. */
export function scaleToBox(src: Rgba, maxW: number, maxH: number, upscale: boolean): Rgba {
  let scale = Math.min(maxW / src.width, maxH / src.height);
  if (!upscale) scale = Math.min(1, scale);
  if (scale === 1) return src;
  return premulToRgba(resamplePremul(src, src.width * scale, src.height * scale));
}

/** The logo scaled to fit inside a `box` x `box` area (aspect kept, enlarged if small). */
function scaleToFit(src: Rgba, box: number): PremulImage {
  const scale = Math.min(box / src.width, box / src.height);
  return resamplePremul(src, src.width * scale, src.height * scale);
}

/** PNG bytes of a straight RGBA image. */
export function encodePng(img: Rgba): Buffer {
  const out = new PNG({ width: img.width, height: img.height });
  out.data.set(img.data);
  return PNG.sync.write(out);
}

/** Baseline JPEG bytes of an opaque RGBA image. */
export function encodeJpeg(img: Rgba, quality = 90): Buffer {
  return jpeg.encode({ width: img.width, height: img.height, data: img.data }, quality).data;
}

/**
 * One square PNG icon of `size` pixels. `any`: the logo fills about 92% of the square, rest
 * transparent. `maskable`: an opaque `background` square with the logo inside the central 60%
 * (the platform may crop the outer ring into a circle or rounded square).
 */
export function renderIcon(src: Rgba, size: number, kind: IconKind, background = '#06302b'): Buffer {
  const inner = Math.max(1, Math.round(size * (kind === 'maskable' ? 0.6 : 0.92)));
  const fit = scaleToFit(src, inner);
  const offX = Math.floor((size - fit.w) / 2);
  const offY = Math.floor((size - fit.h) / 2);
  const [br, bg, bb] = parseColour(background);

  const out = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const o = (y * size + x) * 4;
      const fx = x - offX;
      const fy = y - offY;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0; // 0..255, premultiplied colour in r,g,b
      if (fx >= 0 && fy >= 0 && fx < fit.w && fy < fit.h) {
        const i = (fy * fit.w + fx) * 4;
        r = fit.px[i]!;
        g = fit.px[i + 1]!;
        b = fit.px[i + 2]!;
        a = fit.px[i + 3]! / 255;
      }
      if (kind === 'maskable') {
        // Source over the opaque background.
        out.data[o] = Math.round(r + br * (1 - a));
        out.data[o + 1] = Math.round(g + bg * (1 - a));
        out.data[o + 2] = Math.round(b + bb * (1 - a));
        out.data[o + 3] = 255;
      } else if (a > 0) {
        out.data[o] = Math.min(255, Math.round(r / a));
        out.data[o + 1] = Math.min(255, Math.round(g / a));
        out.data[o + 2] = Math.min(255, Math.round(b / a));
        out.data[o + 3] = Math.round(a * 255);
      }
    }
  }
  return PNG.sync.write(out);
}
