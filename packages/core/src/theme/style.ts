// Theme menu values (themeStyle.styles): what a Pentadbir Surau changes per theme and per screen.
// Browser-safe: no Node or kiosk-only imports.

import { isScreenId, isThemeName } from './catalog.ts';
import type { ScreenId } from './catalog.ts';

export const THEME_STYLE_MAX_BYTES = 32 * 1024;
export const SCALE_FACTOR = { S: 1, M: 1.1, L: 1.2, XL: 1.3 } as const;
export const ACCENT_SWATCHES = ['#2fd1b0', '#f9b544', '#ff7a98', '#f0c97a', '#7fdc9a', '#5aa7ff', '#ffffff'] as const;

export interface ScreenStyle {
  /** 64-hex asset id; absent = ikut tema. */
  bgImage?: string;
  bgFit?: 'penuh' | 'regang' | 'sederhana' | 'kecil';
  bgPos?: 'kiri' | 'tengah' | 'kanan';
  /** Integer 0..80 (percent). */
  shade?: number;
  /** #rrggbb */
  accent?: string;
  /** #rrggbb; absent = auto. */
  text?: string;
  /** /^[a-z0-9-]{1,32}$/: 'jakarta', 'amiri' or a pack font id. */
  font?: string;
  scale?: 'S' | 'M' | 'L' | 'XL';
  align?: 'kiri' | 'tengah' | 'kanan';
  /** 'hafs' | 'amiri-quran' | 'amiri' | pack font id (plan D). */
  arFont?: string;
  /** Integer 100..160, percent (plan D). */
  arScale?: number;
  /** #rrggbb (plan D). */
  harakat?: string;
  /** Integer 16..24, tenths (plan D). */
  arLineHeight?: number;
  tarjamah?: 'bawah' | 'sisi' | 'sembunyi';
}

export const SCREEN_STYLE_KEYS: readonly (keyof ScreenStyle)[] = [
  'bgImage', 'bgFit', 'bgPos', 'shade', 'accent', 'text', 'font', 'scale', 'align',
  'arFont', 'arScale', 'harakat', 'arLineHeight', 'tarjamah',
];

export interface ThemeStyleEntry { semua: ScreenStyle; skrin: Partial<Record<ScreenId, ScreenStyle>> }
export type ThemeStyles = Record<string, ThemeStyleEntry>;

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const HEX6 = /^#[0-9A-Fa-f]{6}$/;
const ASSET64 = /^[0-9a-f]{64}$/;
const FONT_ID = /^[a-z0-9-]{1,32}$/;
const oneOf = (v: unknown, vals: readonly string[]): boolean => typeof v === 'string' && vals.includes(v);
const intIn = (v: unknown, min: number, max: number): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Null when `v` is a valid value for `key`; else an English reason. */
export function styleValueError(key: string, v: unknown): string | null {
  switch (key) {
    case 'bgImage': return typeof v === 'string' && ASSET64.test(v) ? null : `${key} must be a picture id`;
    case 'bgFit': return oneOf(v, ['penuh', 'regang', 'sederhana', 'kecil']) ? null : `${key} must be penuh, regang, sederhana or kecil`;
    case 'bgPos': return oneOf(v, ['kiri', 'tengah', 'kanan']) ? null : `${key} must be kiri, tengah or kanan`;
    case 'shade': return intIn(v, 0, 80) ? null : `${key} must be an integer 0..80`;
    case 'accent': case 'text': case 'harakat':
      return typeof v === 'string' && HEX6.test(v) ? null : `${key} must be a colour like #12AB34`;
    case 'font': case 'arFont': return typeof v === 'string' && FONT_ID.test(v) ? null : `${key} must be a font id (a-z, 0-9, hyphen)`;
    case 'scale': return oneOf(v, ['S', 'M', 'L', 'XL']) ? null : `${key} must be S, M, L or XL`;
    case 'align': return oneOf(v, ['kiri', 'tengah', 'kanan']) ? null : `${key} must be kiri, tengah or kanan`;
    case 'arScale': return intIn(v, 100, 160) ? null : `${key} must be an integer 100..160`;
    case 'arLineHeight': return intIn(v, 16, 24) ? null : `${key} must be an integer 16..24`;
    case 'tarjamah': return oneOf(v, ['bawah', 'sisi', 'sembunyi']) ? null : `${key} must be bawah, sisi or sembunyi`;
    default: return `${key} is not a known style value`;
  }
}

/** Error for one ScreenStyle object: an unknown key is refused (named), a present known key must be valid. */
function screenStyleError(path: string, raw: unknown): string | null {
  if (!isPlain(raw)) return `${path} must be an object`;
  for (const k of Object.keys(raw)) {
    if (!(SCREEN_STYLE_KEYS as readonly string[]).includes(k)) return `${path}.${k} is not a known style value`;
  }
  for (const k of SCREEN_STYLE_KEYS) {
    if (!has(raw, k)) continue;
    const e = styleValueError(k, raw[k]);
    if (e) return `${path}.${e}`;
  }
  return null;
}

/** Error for one ThemeStyleEntry-shaped object. */
export function themeStyleEntryError(path: string, raw: unknown): string | null {
  if (!isPlain(raw)) return `${path} must be an object`;
  for (const k of Object.keys(raw)) {
    if (k !== 'semua' && k !== 'skrin') return `${path}.${k} is not a known key (semua or skrin)`;
  }
  if (has(raw, 'semua')) {
    const e = screenStyleError(`${path}.semua`, raw.semua);
    if (e) return e;
  }
  if (has(raw, 'skrin')) {
    const sk = raw.skrin;
    if (!isPlain(sk)) return `${path}.skrin must be an object`;
    for (const id of Object.keys(sk)) {
      if (!isScreenId(id)) return `${path}.skrin.${id} is not a screen`;
      const e = screenStyleError(`${path}.skrin.${id}`, sk[id]);
      if (e) return e;
    }
  }
  return null;
}

/** Write-side check: an object, at most 32 KB, theme names valid, every present value valid; unknown keys and screens are refused. */
export function themeStylesError(raw: unknown): string | null {
  if (!isPlain(raw)) return 'styles must be an object';
  let bytes: number;
  try { bytes = new TextEncoder().encode(JSON.stringify(raw)).length; } catch { return 'styles must be plain data'; }
  if (bytes > THEME_STYLE_MAX_BYTES) return 'styles must be at most 32 KB';
  for (const name of Object.keys(raw)) {
    if (!isThemeName(name)) return `styles.${name} is not a theme name`;
    const e = themeStyleEntryError(`styles.${name}`, raw[name]);
    if (e) return e;
  }
  return null;
}

function sanitizeScreenStyle(raw: unknown): ScreenStyle {
  const out: Record<string, unknown> = {};
  if (!isPlain(raw)) return out as ScreenStyle;
  for (const k of SCREEN_STYLE_KEYS) {
    if (has(raw, k) && styleValueError(k, raw[k]) === null) out[k] = raw[k];
  }
  return out as ScreenStyle;
}

/** Read-side: keeps only known themes-shaped entries, known screens, known keys with valid values. Never throws. */
export function sanitizeThemeStyles(raw: unknown): ThemeStyles {
  const out: ThemeStyles = {};
  if (!isPlain(raw)) return out;
  for (const name of Object.keys(raw)) {
    if (!isThemeName(name)) continue;
    const e = raw[name];
    if (!isPlain(e)) continue;
    const skrin: Partial<Record<ScreenId, ScreenStyle>> = {};
    if (isPlain(e.skrin)) {
      for (const id of Object.keys(e.skrin)) {
        if (isScreenId(id)) skrin[id] = sanitizeScreenStyle(e.skrin[id]);
      }
    }
    out[name] = { semua: sanitizeScreenStyle(e.semua), skrin };
  }
  return out;
}

/** Layers 4, 5, 6 of spec 6.2: defaults.semua, defaults.skrin[screen], styles[theme].semua, styles[theme].skrin[screen]; later wins per key. */
export function resolveScreenStyle(
  styles: ThemeStyles, theme: string, screen: ScreenId, defaults?: Partial<ThemeStyleEntry>,
): ScreenStyle {
  const own = has(styles, theme) ? styles[theme] : undefined;
  return {
    ...(defaults?.semua ?? {}),
    ...(defaults?.skrin?.[screen] ?? {}),
    ...(own?.semua ?? {}),
    ...(own?.skrin?.[screen] ?? {}),
  };
}
