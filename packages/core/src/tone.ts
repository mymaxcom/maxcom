export interface ImageStats {
  meanLuma: number; // 0..1 relative luminance
  palette: string[]; // hex, most frequent first
}

export interface Tone {
  shadeAlpha: number;
  glass: string; // hex #rrggbb
  accent: string; // hex
  text: '#ffffff';
}

const TARGET_GLASS = '#06302b';
const FALLBACK_ACCENT = '#f0c97a';
const SHADE_ALPHA_MIN = 35; // 0.35
const SHADE_ALPHA_MAX = 92; // 0.92
const CONTRAST_THRESHOLD = 4.5;

interface RGB {
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: string): RGB | null {
  const s = hex.trim();
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s)) return null;
  if (s.length === 4) {
    return {
      r: parseInt(s.slice(1, 2) + s.slice(1, 2), 16),
      g: parseInt(s.slice(2, 3) + s.slice(2, 3), 16),
      b: parseInt(s.slice(3, 4) + s.slice(3, 4), 16),
    };
  }
  return {
    r: parseInt(s.slice(1, 3), 16),
    g: parseInt(s.slice(3, 5), 16),
    b: parseInt(s.slice(5, 7), 16),
  };
}

function hexFromRgb({ r, g, b }: RGB): string {
  const toHex = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function toLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  const c = parseHex(hex);
  if (!c) throw new Error(`Invalid hex color "${hex}"`);
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
}

function luminanceContrast(lA: number, lB: number): number {
  const L1 = Math.max(lA, lB);
  const L2 = Math.min(lA, lB);
  return (L1 + 0.05) / (L2 + 0.05);
}

export function contrastRatio(hexA: string, hexB: string): number {
  return luminanceContrast(relativeLuminance(hexA), relativeLuminance(hexB));
}

function mixColor(a: RGB, b: RGB, t: number): string {
  return hexFromRgb({
    r: Math.round((1 - t) * a.r + t * b.r),
    g: Math.round((1 - t) * a.g + t * b.g),
    b: Math.round((1 - t) * a.b + t * b.b),
  });
}

function saturation({ r, g, b }: RGB): number {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const delta = max - min;
  if (delta === 0) return 0;
  const lightness = (max + min) / 2;
  return delta / (1 - Math.abs(2 * lightness - 1));
}

function computeShadeAlpha(meanLuma: number, glassLuma: number): number {
  const whiteLuma = 1;
  for (let a = SHADE_ALPHA_MIN; a <= SHADE_ALPHA_MAX; a += 1) {
    const L = meanLuma * (1 - a / 100) + glassLuma * (a / 100);
    if (luminanceContrast(L, whiteLuma) >= CONTRAST_THRESHOLD) {
      return a / 100;
    }
  }
  return SHADE_ALPHA_MAX / 100;
}

function chooseAccent(colors: RGB[], glass: string): string {
  if (colors.length === 0) return FALLBACK_ACCENT;
  const ranked = colors
    .map((c) => ({ c, s: saturation(c) }))
    .sort((a, b) => b.s - a.s);
  for (const { c } of ranked) {
    const h = hexFromRgb(c);
    if (contrastRatio(h, glass) >= CONTRAST_THRESHOLD) return h;
  }
  return FALLBACK_ACCENT;
}

export function autoTone(stats: ImageStats): Tone {
  const meanLuma = Math.min(1, Math.max(0, stats.meanLuma));
  const colors = stats.palette.map(parseHex).filter((c): c is RGB => c !== null);

  const targetGlass = parseHex(TARGET_GLASS)!;
  const glass =
    colors.length > 0 ? mixColor(darkest(colors), targetGlass, 0.7) : TARGET_GLASS;
  const glassLuma = relativeLuminance(glass);
  const shadeAlpha = computeShadeAlpha(meanLuma, glassLuma);
  const accent = chooseAccent(colors, glass);

  return { shadeAlpha, glass, accent, text: '#ffffff' };
}

function darkest(colors: RGB[]): RGB {
  let best = colors[0]!;
  let bestLuma = relativeLuminance(hexFromRgb(best));
  for (let i = 1; i < colors.length; i++) {
    const c = colors[i]!;
    const luma = relativeLuminance(hexFromRgb(c));
    if (luma < bestLuma) {
      best = c;
      bestLuma = luma;
    }
  }
  return best;
}
