// Installed theme pack records (themeStyle.packs). Plan C fills them; they are validated from now on.
// Browser-safe: no Node or kiosk-only imports.

import { SCREEN_IDS, isBuiltInTheme, isScreenId, isThemeName } from './catalog.ts';
import type { ScreenId } from './catalog.ts';
import type { KioskTemplateId } from '../features/registry.ts';
import { themeStyleEntryError } from './style.ts';
import type { ThemeStyleEntry } from './style.ts';

export const MAX_PACKS = 30;
export const PACKS_MAX_BYTES = 64 * 1024;
const PACK_KEYS = ['assetId', 'version', 'title', 'base', 'contract', 'bytes', 'fonts', 'screens', 'images', 'defaults'];

export interface InstalledPack {
  assetId: string;
  version: number;
  title: string;
  base: KioskTemplateId;
  contract: number;
  bytes: number;
  fonts: string[];
  screens: ScreenId[];
  images: Partial<Record<ScreenId | 'semua', 'jpg' | 'png' | 'webp'>>;
  defaults: Partial<ThemeStyleEntry>;
}
export type InstalledPacks = Record<string, InstalledPack>;

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const ASSET64 = /^[0-9a-f]{64}$/;
const FONT_ID = /^[a-z0-9-]{1,32}$/;
const TITLE_BAD = /[<>\u0000-\u001f\u007f]/;
const IMAGE_KINDS = ['jpg', 'png', 'webp'];

function packError(path: string, p: unknown): string | null {
  if (!isPlain(p)) return `${path} must be an object`;
  for (const k of Object.keys(p)) {
    if (!PACK_KEYS.includes(k)) return `${path}.${k} is not a known pack key`;
  }
  if (typeof p.assetId !== 'string' || !ASSET64.test(p.assetId)) return `${path}.assetId must be a pack id`;
  if (typeof p.version !== 'number' || !Number.isInteger(p.version) || p.version < 1 || p.version > 999999) return `${path}.version must be an integer 1..999999`;
  if (typeof p.title !== 'string' || p.title.length < 1 || p.title.length > 60 || TITLE_BAD.test(p.title)) return `${path}.title must be 1..60 plain characters`;
  if (!isBuiltInTheme(p.base)) return `${path}.base must be a built-in theme`;
  if (typeof p.contract !== 'number' || !Number.isInteger(p.contract) || p.contract < 1) return `${path}.contract must be an integer >= 1`;
  if (typeof p.bytes !== 'number' || !Number.isInteger(p.bytes) || p.bytes < 0) return `${path}.bytes must be a whole number`;
  if (!Array.isArray(p.fonts) || p.fonts.length > 10 || !p.fonts.every((f) => typeof f === 'string' && FONT_ID.test(f))) return `${path}.fonts must be at most 10 font ids`;
  if (!Array.isArray(p.screens) || p.screens.length > SCREEN_IDS.length || !p.screens.every(isScreenId) || new Set(p.screens).size !== p.screens.length) {
    return `${path}.screens must be distinct screen ids of the catalog`;
  }
  if (!isPlain(p.images)) return `${path}.images must be an object`;
  for (const k of Object.keys(p.images)) {
    if (k !== 'semua' && !isScreenId(k)) return `${path}.images.${k} is not a screen`;
    if (typeof p.images[k] !== 'string' || !IMAGE_KINDS.includes(p.images[k])) return `${path}.images.${k} must be jpg, png or webp`;
  }
  if (!isPlain(p.defaults)) return `${path}.defaults must be an object`;
  const de = themeStyleEntryError(`${path}.defaults`, p.defaults);
  if (de) return de;
  const d = p.defaults;
  if (isPlain(d.semua) && has(d.semua, 'bgImage')) return `${path}.defaults must not hold bgImage`;
  if (isPlain(d.skrin)) {
    for (const id of Object.keys(d.skrin)) {
      const s = d.skrin[id];
      if (isPlain(s) && has(s, 'bgImage')) return `${path}.defaults must not hold bgImage`;
    }
  }
  return null;
}

/**
 * A removed pack. The stored row keeps `{ removed: true }` in place of the record so the removal travels to the other
 * boxes and the cloud (a settings merge never deletes a key); a read (`sanitizePacks`) never shows it.
 */
export const isPackTombstone = (p: unknown): boolean =>
  isPlain(p) && Object.keys(p).length === 1 && p.removed === true;

/** Null when `raw` is a valid packs map: at most 64 KB serialized, known keys and screens only. */
export function packsError(raw: unknown): string | null {
  if (!isPlain(raw)) return 'packs must be an object';
  let bytes: number;
  try { bytes = new TextEncoder().encode(JSON.stringify(raw)).length; } catch { return 'packs must be plain data'; }
  if (bytes > PACKS_MAX_BYTES) return 'packs must be at most 64 KB';
  const names = Object.keys(raw);
  if (names.length > MAX_PACKS) return `packs may hold at most ${MAX_PACKS} themes`;
  for (const name of names) {
    if (!isThemeName(name) || isBuiltInTheme(name)) return `packs.${name} is not an uploaded theme name`;
    if (isPackTombstone(raw[name])) continue;
    const e = packError(`packs.${name}`, raw[name]);
    if (e) return e;
  }
  return null;
}

/** Read-side: keeps the records that pass the write check, at most MAX_PACKS. Never throws. */
export function sanitizePacks(raw: unknown): InstalledPacks {
  const out: InstalledPacks = {};
  if (!isPlain(raw)) return out;
  let n = 0;
  for (const name of Object.keys(raw)) {
    if (n >= MAX_PACKS) break;
    if (!isThemeName(name) || isBuiltInTheme(name)) continue;
    if (packError(name, raw[name]) !== null) continue;
    out[name] = JSON.parse(JSON.stringify(raw[name])) as InstalledPack;
    n++;
  }
  return out;
}

export interface ThemeSupportBox { contract: number | null; builtIn: readonly string[] }

/**
 * May the app offer a theme (an uploaded pack of `need.contract`, or a built-in that older boxes may not have)? Only
 * when the list of the surau's boxes is complete and every box has the contract (and lists the built-in theme).
 * A box that never reported its contract counts as not supporting it.
 */
export function themeOfferable(
  support: { boxes: readonly ThemeSupportBox[]; complete: boolean },
  need: { contract: number; builtIn?: string },
): boolean {
  if (!support.complete) return false;
  return support.boxes.every((b) =>
    b.contract !== null && b.contract >= need.contract && (need.builtIn === undefined || b.builtIn.includes(need.builtIn)));
}
