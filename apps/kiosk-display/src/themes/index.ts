// The five built-in themes as packs (theme.json + theme.css in the pack layout) and how the stage picks one.
// Serif headings of the Old School theme (Latin only; Arabic keeps Amiri Quran / QPC Hafs).
import '@fontsource/amiri/latin-400.css';
import '@fontsource/amiri/latin-700.css';
// The thin wall clock of the Minimal theme (Latin digits only).
import '@fontsource/plus-jakarta-sans/latin-300.css';
import { isThemeName, KIOSK_TEMPLATE_IDS, sanitizePacks, THEME_BUNDLE_FORMAT, THEME_CONTRACT } from '@surau/core';
import type { FeatureSettings, InstalledPack, KioskTemplateId, Settings, ThemeManifest } from '@surau/core';
import colourful from './colourful/theme.json';
import creative from './creative/theme.json';
import defaultTheme from './default/theme.json';
import arabic from './arabic/theme.json';
import minimal from './minimal/theme.json';
import oldschool from './oldschool/theme.json';

export const BUILT_IN_THEMES: Readonly<Record<KioskTemplateId, ThemeManifest>> = {
  default: defaultTheme as ThemeManifest,
  colourful: colourful as ThemeManifest,
  creative: creative as ThemeManifest,
  oldschool: oldschool as ThemeManifest,
  minimal: minimal as ThemeManifest,
  arabic: arabic as ThemeManifest,
};

const KNOWN: ReadonlySet<string> = new Set(KIOSK_TEMPLATE_IDS);

/**
 * The live screen's layout (`data-live-layout` on the stage): full-screen video with brand, clock, chip and strip on
 * pills over it (Default, Creative), or a framed video with the side column beside it (the others). Spec 6.12.6.
 * One place to change; a pack wears its base theme's layout and may restyle it.
 */
const FULL_SCREEN_LIVE: ReadonlySet<string> = new Set(['default', 'creative']);
export const liveLayoutOf = (theme: { base: string }): 'full' | 'framed' => (FULL_SCREEN_LIVE.has(theme.base) ? 'full' : 'framed');

/**
 * The presentation template the stage wears (`data-template`). Anything unknown, missing (an older box sends
 * no kioskTemplate feature) or switched off is 'default', the original single-colour look.
 */
export function templateOf(s: FeatureSettings | null | undefined): KioskTemplateId {
  if (!s || typeof s !== 'object' || s.enabled === false) return 'default';
  const id = (s as { templateId?: unknown }).templateId;
  return typeof id === 'string' && KNOWN.has(id) ? (id as KioskTemplateId) : 'default';
}

/**
 * Which Arabic-led looks a built-in turns on (spec 6.8): ONE place to change when the operator decides per theme. Arabic
 * Art turns all three on; the other five keep today's looks of ayat, hadis and zikir (their mockups exist, the choice is
 * the operator's).
 */
export const ARAB_LOOKS: Readonly<Record<KioskTemplateId, readonly ('arab-ayat' | 'arab-hadis' | 'arab-zikir')[]>> = {
  default: [],
  colourful: [],
  creative: [],
  oldschool: [],
  minimal: [],
  arabic: ['arab-ayat', 'arab-hadis', 'arab-zikir'],
};

export interface ResolvedTheme {
  name: string;
  base: KioskTemplateId;
  builtIn: boolean;
  /** The installed pack record of an uploaded theme, else null. */
  pack: InstalledPack | null;
  /** Same-origin address of the pack's one stylesheet, else null. */
  cssUrl: string | null;
}

export const builtInTheme = (id: KioskTemplateId): ResolvedTheme => ({ name: id, base: id, builtIn: true, pack: null, cssUrl: null });

/** The installed pack called `name` that this display understands (contract at most ours), else null. */
export function installedPack(settings: Pick<Settings, 'themeStyle'> | null | undefined, name: string): InstalledPack | null {
  const raw = (settings?.themeStyle as { packs?: unknown } | undefined)?.packs;
  if (typeof raw !== 'object' || raw === null || !Object.prototype.hasOwnProperty.call(raw, name)) return null;
  const one = sanitizePacks({ [name]: (raw as Record<string, unknown>)[name] })[name];
  return one !== undefined && one.contract <= THEME_CONTRACT ? one : null;
}

/** An uploaded theme as the stage wears it (`name` need not be the key of an installed record: the preview's staged pack). */
/** The address segment of an installed pack's files: the first 16 hex of its file's sha-256 and the bundle format (the box serves nothing under another one). */
export const packHash = (pack: Pick<InstalledPack, 'assetId'>): string => `${pack.assetId.slice(0, 16)}-${THEME_BUNDLE_FORMAT}`;

export function packTheme(name: string, pack: InstalledPack, cssUrl: string): ResolvedTheme {
  return { name, base: pack.base, builtIn: false, pack, cssUrl };
}

/**
 * The theme the stage wears: a built-in id as itself, the name of an installed pack this display understands as that
 * pack (over its base theme), anything else (unknown name, a newer contract, switched off, no data) as `default`.
 */
export function resolveTheme(settings: Pick<Settings, 'kioskTemplate' | 'themeStyle'> | null | undefined): ResolvedTheme {
  const k = settings?.kioskTemplate;
  const id = k && typeof k === 'object' && k.enabled !== false ? (k as { templateId?: unknown }).templateId : undefined;
  if (typeof id === 'string' && KNOWN.has(id)) return builtInTheme(id as KioskTemplateId);
  if (isThemeName(id)) {
    const pack = installedPack(settings, id);
    if (pack !== null) return packTheme(id, pack, `/themes/${id}/${packHash(pack)}/bundle.css`);
  }
  return builtInTheme('default');
}

/**
 * The theme the preview page wears: the one the host asked for (a built-in; an installed pack; the staged pack the host
 * describes), else the display's own. An unknown name keeps its name over the default look.
 */
export function resolvePreviewTheme(
  req: { theme: string; staged: string | null; pack: InstalledPack | null } | null,
  settings: Pick<Settings, 'kioskTemplate' | 'themeStyle'> | null | undefined,
): ResolvedTheme {
  if (req === null) return resolveTheme(settings);
  if (KNOWN.has(req.theme)) return builtInTheme(req.theme as KioskTemplateId);
  if (req.staged !== null && req.pack !== null) return packTheme(req.theme, req.pack, `/api/themes/staged/${req.staged}/bundle.css`);
  const installed = installedPack(settings, req.theme);
  if (installed !== null) return packTheme(req.theme, installed, `/themes/${req.theme}/${packHash(installed)}/bundle.css`);
  return { name: req.theme, base: 'default', builtIn: false, pack: null, cssUrl: null };
}

/** The Arabic-led screens the theme shows: its base's looks plus every `arab-*` screen file a pack ships (a pack opts in that way). */
export function arabLooksOf(theme: ResolvedTheme): ReadonlySet<string> {
  const out = new Set<string>(ARAB_LOOKS[theme.base] ?? []);
  for (const s of theme.pack?.screens ?? []) if (/^arab-(ayat|hadis|zikir)$/.test(s)) out.add(s);
  return out;
}

/** Which of the pack's pictures belongs to the screen on stage: its own, else the all-screens picture, else none. */
export function packPictureKey(pack: InstalledPack, screen: string): string | null {
  if (Object.prototype.hasOwnProperty.call(pack.images, screen)) return screen;
  return pack.images.semua !== undefined ? 'semua' : null;
}
