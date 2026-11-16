// The surau's menu values (themeStyle) turned into stage variables and attributes (spec 6.3 table).
import { SCALE_FACTOR, resolveScreenStyle, sanitizeThemeStyles } from '@surau/core';
import type { ScreenId, ScreenStyle, Settings, ThemeStyleEntry } from '@surau/core';
import type { StageScreenId } from '../screens/screenId.ts';
import type { ResolvedTheme } from './index.ts';
import { BUILT_IN_THEMES } from './index.ts';

export interface StageStyle { vars: Record<string, string>; attrs: Record<string, string>; bgAssetId: string | null; /** The pack's own picture of this screen, when it shows (the surau set none). */ packImageUrl: string | null }

const FIT: Record<NonNullable<ScreenStyle['bgFit']>, { fit: string; size: string }> = {
  penuh: { fit: 'cover', size: 'cover' },
  regang: { fit: 'fill', size: '100% 100%' },
  sederhana: { fit: 'contain', size: '70% auto' },
  kecil: { fit: 'contain', size: '45% auto' },
};
const POS: Record<NonNullable<ScreenStyle['bgPos']>, string> = { kiri: 'left center', tengah: 'center', kanan: 'right center' };
const ALIGN: Record<NonNullable<ScreenStyle['align']>, string> = { kiri: 'left', tengah: 'center', kanan: 'right' };
// An old stored 'sembunyi' (the removed hide option) places the translation below: Tetapan alone hides it.
const TARJAMAH: Record<string, string> = { bawah: 'below', sisi: 'beside', sembunyi: 'below' };

const rgb = (hex: string): string =>
  `${parseInt(hex.slice(1, 3), 16)} ${parseInt(hex.slice(3, 5), 16)} ${parseInt(hex.slice(5, 7), 16)}`;

function fontStack(id: string): string {
  if (id === 'jakarta') return "'Plus Jakarta Sans', 'Segoe UI', system-ui, sans-serif";
  if (id === 'amiri') return "'Amiri', serif";
  return `'mxf-${id}', 'Plus Jakarta Sans', sans-serif`;
}

/**
 * Menu values to stage variables and attributes. `assetUrl` returns null when the picture is not available.
 * `packImage` is the pack's picture for the screen (precedence 3 of spec 6.10.1): used only when the surau's own
 * menu picture is absent or cannot show.
 */
export function styleVars(style: ScreenStyle, assetUrl: (id: string) => string | null, packImage: string | null = null): StageStyle {
  const vars: Record<string, string> = {};
  const attrs: Record<string, string> = {};
  let bgAssetId: string | null = null;
  let packImageUrl: string | null = null;
  const picture = (url: string): void => {
    vars['--bg-image'] = `url("${url}")`;
    attrs['data-bg'] = 'image';
    if (style.bgFit !== undefined) {
      vars['--bg-fit'] = FIT[style.bgFit].fit;
      vars['--bg-size'] = FIT[style.bgFit].size;
    }
    if (style.bgPos !== undefined) vars['--bg-pos'] = POS[style.bgPos];
  };
  const menuUrl = style.bgImage !== undefined ? assetUrl(style.bgImage) : null;
  if (style.bgImage !== undefined && menuUrl !== null) {
    bgAssetId = style.bgImage;
    picture(menuUrl);
  } else if (packImage !== null) {
    packImageUrl = packImage;
    picture(packImage);
  }
  if (style.shade !== undefined) vars['--shade'] = String(style.shade / 100);
  if (style.accent !== undefined) {
    vars['--accent'] = style.accent;
    vars['--accent-rgb'] = rgb(style.accent);
  }
  if (style.text !== undefined) vars['--text'] = style.text;
  if (style.font !== undefined) {
    vars['--font'] = fontStack(style.font);
    // Old School sets its Latin text in --serif: the menu font replaces that too.
    vars['--serif'] = fontStack(style.font);
  }
  if (style.scale !== undefined) vars['--scale'] = String(SCALE_FACTOR[style.scale]);
  if (style.align !== undefined) attrs['data-align'] = ALIGN[style.align];
  if (style.arFont !== undefined) attrs['data-arfont'] = style.arFont;
  if (style.arScale !== undefined) vars['--ar-scale'] = String(style.arScale / 100);
  if (style.harakat !== undefined) vars['--harakat'] = style.harakat;
  if (style.arLineHeight !== undefined) vars['--ar-lh'] = String(style.arLineHeight / 10);
  if (style.tarjamah !== undefined) attrs['data-tarjamah'] = TARJAMAH[style.tarjamah] ?? 'below';
  if (style.goldOutline !== undefined) attrs['data-gold'] = style.goldOutline;
  return { vars, attrs, bgAssetId, packImageUrl };
}

/**
 * The style of the screen on stage: theme defaults, then the surau's values. Screens with no catalog entry of
 * their own (syuruk, isyraq, tarawih) use the all-screens layers only. `override` replaces the stored map of this
 * theme (the preview page's unsaved values).
 */
export function stageStyleFor(
  settings: Partial<Pick<Settings, 'themeStyle'>>,
  theme: ResolvedTheme,
  screen: StageScreenId,
  themeDefaults?: Partial<ThemeStyleEntry>,
  override?: ThemeStyleEntry | null,
): ScreenStyle {
  const stored = sanitizeThemeStyles(settings.themeStyle?.styles);
  const styles = override ? { ...stored, [theme.name]: override } : stored;
  const defaults = themeDefaults ?? (theme.builtIn ? (BUILT_IN_THEMES[theme.base].defaults as Partial<ThemeStyleEntry>) : undefined);
  return resolveScreenStyle(styles, theme.name, screen as ScreenId, defaults);
}

/**
 * Whether the harakat colour is drawn: the surau (or the theme) set a colour AND the Arabic face is Amiri or Amiri
 * Quran. With Uthmani Hafs (the default face) the colour is kept but not drawn: that font's licence forbids deriving a
 * marks-only copy of it (spec 6.12.2).
 */
export function harakatOn(style: Pick<ScreenStyle, 'harakat' | 'arFont'>): boolean {
  const face = style.arFont ?? 'hafs';
  return style.harakat !== undefined && (face === 'amiri' || face === 'amiri-quran');
}

/** Lowest layer darkness (percent) on the default look when a menu picture shows: its text sits straight on the picture. */
export const MIN_SHADE_DEFAULT = 25;
/** Layer darkness (percent) a built-in theme without a value of its own wears over a picture (spec 6.3). */
export const FALLBACK_SHADE = 35;

/**
 * The effective layer darkness (percent) of the stage: the value of the surau or the theme, else the measured tone's
 * (default look) or 35 (every other theme); on the default look not below 25 while a picture shows.
 */
export function effectiveShade(style: number | undefined, base: string, toneShade: number, hasPicture: boolean): number {
  const fallback = base === 'default' ? Math.round(toneShade * 100) : FALLBACK_SHADE;
  const v = style ?? fallback;
  return hasPicture && base === 'default' ? Math.max(MIN_SHADE_DEFAULT, v) : v;
}
