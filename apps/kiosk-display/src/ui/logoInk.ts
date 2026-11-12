/**
 * Whether a logo needs a light plate behind it on the dark screen (mirror of the app's logo_ink.dart).
 *
 * Ink = pixels with alpha >= 128. A logo with under 5 % see-through pixels is opaque and carries its own
 * background: no plate. Otherwise, when at least 40 % of the ink (alpha-weighted) is dark (luma, Rec. 709
 * on sRGB, at or below 0.35) the plate is drawn. A share rather than a mean, so black letters with a green
 * dome and an orange X still count as dark; a white or gold wordmark with a small dark shadow does not.
 * At most about 64 000 pixels are looked at.
 */
export const DARK_INK_LUMA = 0.35;
export const DARK_SHARE = 0.4;
export const TRANSPARENT_SHARE = 0.05;
const MAX_SAMPLES = 64000;

export function rgbaWantsLightPlate(rgba: ArrayLike<number>, width: number, height: number): boolean {
  if (!(width > 0) || !(height > 0) || rgba.length < width * height * 4) return false;
  const stride = Math.max(1, Math.ceil(Math.sqrt((width * height) / MAX_SAMPLES)));
  const hist = new Float64Array(256);
  let sampled = 0;
  let clear = 0;
  let total = 0;
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 4;
      const a = rgba[i + 3]!;
      sampled++;
      if (a < 128) {
        clear++;
        continue;
      }
      const luma = Math.min(255, Math.max(0, Math.round(0.2126 * rgba[i]! + 0.7152 * rgba[i + 1]! + 0.0722 * rgba[i + 2]!)));
      hist[luma]! += a;
      total += a;
    }
  }
  if (sampled === 0 || total === 0) return false;
  if (clear / sampled < TRANSPARENT_SHARE) return false;
  let dark = 0;
  for (let l = 0; l < 256 && l / 255 <= DARK_INK_LUMA; l++) dark += hist[l]!;
  return dark / total >= DARK_SHARE;
}

/** Draws [img] on a small canvas (long side at most 256 px) and decides; false when canvas is unavailable. */
export function imageWantsLightPlate(img: HTMLImageElement): boolean {
  try {
    const w0 = img.naturalWidth;
    const h0 = img.naturalHeight;
    if (!(w0 > 0) || !(h0 > 0)) return false;
    const k = Math.min(1, 256 / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * k));
    const h = Math.max(1, Math.round(h0 * k));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.drawImage(img, 0, 0, w, h);
    return rgbaWantsLightPlate(ctx.getImageData(0, 0, w, h).data, w, h);
  } catch {
    return false;
  }
}
