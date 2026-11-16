// Theme contract v1: the screen catalog and theme constants shared by the kiosk, the box server and the admin app.
// Browser-safe: no Node or kiosk-only imports.

import type { SlotFeature } from '../content/rotation.ts';
import { KIOSK_TEMPLATE_IDS } from '../features/registry.ts';
import type { KioskTemplateId } from '../features/registry.ts';

export const THEME_CONTRACT = 1;
/**
 * The format of the bundle a box builds from a pack (validator, scoper and url rewriter). It is part of the address of a pack's
 * files (`/themes/<name>/<16 hex>-<format>/...`) and of the folder they are extracted to, so a box that upgrades (and a changed
 * validator) checks every installed pack again and the kiosks fetch the new bundle. Raise it whenever any of their output changes.
 * 2: the allow-list validator of round 2.
 */
export const THEME_BUNDLE_FORMAT = 2;

export const SCREEN_IDS = [
  'biasa', 'azan', 'masuk-waktu', 'iqamah', 'solat', 'jumaat', 'tiada-data',
  'live', 'poster', 'kuliah', 'program', 'hadis', 'zikir', 'tilawah',
  'pengumuman', 'takwim', 'tabung', 'ayat', 'arab-ayat', 'arab-hadis', 'arab-zikir',
] as const;
export type ScreenId = (typeof SCREEN_IDS)[number];

export type ScreenGroup = 'prayer' | 'content' | 'arabic';
export const SCREEN_GROUP: Readonly<Record<ScreenId, ScreenGroup>> = {
  biasa: 'prayer', azan: 'prayer', 'masuk-waktu': 'prayer', iqamah: 'prayer', solat: 'prayer', jumaat: 'prayer', 'tiada-data': 'prayer',
  live: 'content', poster: 'content', kuliah: 'content', program: 'content', hadis: 'content', zikir: 'content', tilawah: 'content',
  pengumuman: 'content', takwim: 'content', tabung: 'content', ayat: 'content',
  'arab-ayat': 'arabic', 'arab-hadis': 'arabic', 'arab-zikir': 'arabic',
};

export type ProtectedEl = 'clock' | 'prayers' | 'countdown' | 'next' | 'logo';

const CP = ['clock', 'prayers'] as const;
/**
 * The content screens (theme round 2, rule 2): the clock and the next-prayer chip in the top row. The prayer strip is
 * not required there: the poster, pengumuman, programme and tabung screens have none (rule 1), and where a content
 * screen shows it, it is not a protected element.
 */
const CN = ['clock', 'next'] as const;
/** Elements the health check (plan C) requires per screen. 'logo' is added at run time when the surau has one. */
export const PROTECTED: Readonly<Record<ScreenId, readonly ProtectedEl[]>> = {
  biasa: ['clock', 'prayers', 'next'],
  azan: ['clock', 'prayers', 'countdown'],
  iqamah: ['clock', 'prayers', 'countdown'],
  'masuk-waktu': CP, solat: CP, jumaat: CP,
  'tiada-data': ['clock'],
  live: CN,
  poster: CN, kuliah: CN, program: CN, hadis: CN, zikir: CN, tilawah: CN, pengumuman: CN, takwim: CN, tabung: CN, ayat: CN,
  'arab-ayat': CN, 'arab-hadis': CN, 'arab-zikir': CN,
};

export function isScreenId(s: unknown): s is ScreenId {
  return typeof s === 'string' && (SCREEN_IDS as readonly string[]).includes(s);
}

const CARD_SCREEN: Readonly<Record<SlotFeature, ScreenId | null>> = {
  kuliahCard: 'kuliah', pengumuman: 'pengumuman', posters: 'poster', programKhas: 'program', takwim: 'takwim',
  hadis: 'hadis', ayatCard: 'ayat', tabungCard: 'tabung', worldTimes: null, tugasan: null,
};
/** The catalog screen a rotation card belongs to; null for a card with no screen of its own. */
export function screenOfCard(feature: SlotFeature): ScreenId | null {
  return CARD_SCREEN[feature] ?? null;
}

export const THEME_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export function isThemeName(s: unknown): s is string {
  return typeof s === 'string' && THEME_NAME_RE.test(s);
}
export function isBuiltInTheme(s: unknown): s is KioskTemplateId {
  return typeof s === 'string' && (KIOSK_TEMPLATE_IDS as readonly string[]).includes(s);
}

export const THEME_TITLES: Readonly<Record<KioskTemplateId, string>> = {
  default: 'Default', colourful: 'Colourful', creative: 'Creative', oldschool: 'Old School', minimal: 'Minimal', arabic: 'Arabic Art',
};

export interface ThemeManifest { name: string; title: string; version: number; contract: number; base: KioskTemplateId; defaults: Record<string, unknown> }
