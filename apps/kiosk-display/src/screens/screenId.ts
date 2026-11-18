import { screenOfCard } from '@surau/core';
import type { KioskState, PhaseOnlyScreenId, ScreenId, ShellOnlyScreenId, SlotFeature } from '@surau/core';

export type { ShellOnlyScreenId } from '@surau/core';

/**
 * The stable, short screen id the stage wears as `data-screen` (the theme contract's screen catalog, plus the three
 * phases that have no catalog screen of their own: syuruk, isyraq and tarawih keep their phase names, and the two
 * full-stage content screens that are not in the catalog: tugasan and waktu-dunia).
 */
export type StageScreenId = ScreenId | PhaseOnlyScreenId | ShellOnlyScreenId;

/**
 * The content screens with no catalog screen of their own (operator 2026-11-17, "use the whole screen"): the duty roster
 * and the world clocks show in the content shell like the kuliah or takwim screen, under these stage ids. A theme pack
 * cannot address them by name, so they take its all-screens rules; the health check asks them for the clock and the
 * prayer strip (the phases-without-an-entry rule), which the shell always shows on them. The ids are core's
 * SHELL_ONLY_SCREEN_IDS, which the box server's health endpoint accepts too.
 */
const SHELL_ONLY: Partial<Record<SlotFeature, ShellOnlyScreenId>> = { tugasan: 'tugasan', worldTimes: 'waktu-dunia' };

/** The stage id of a rotation card that takes the content shell without a catalog screen; null for every other card. */
export function shellOnlyScreenOf(feature: SlotFeature): ShellOnlyScreenId | null {
  return SHELL_ONLY[feature] ?? null;
}

/** What Main reports as on screen: the rotation card, the zikir overlay, the Arabic-led look of one of them, or nothing. */
export type Shown = SlotFeature | 'zikir' | 'arab-ayat' | 'arab-hadis' | 'arab-zikir' | null;

const ARAB_OF: Readonly<Record<'ayat' | 'hadis' | 'zikir', 'arab-ayat' | 'arab-hadis' | 'arab-zikir'>> = {
  ayat: 'arab-ayat', hadis: 'arab-hadis', zikir: 'arab-zikir',
};

/**
 * The stage's screen id. `arab` names the bases whose Arabic-led look is on screen now (ayat, hadis, zikir): a plain
 * ayat, hadis or zikir becomes arab-ayat, arab-hadis or arab-zikir. A `shown` that already is an arab-* id stays.
 */
export function screenIdOf(
  state: Pick<KioskState, 'phase' | 'prayer'>,
  liveClear: boolean,
  shown: Shown = null,
  arab?: ReadonlySet<'ayat' | 'hadis' | 'zikir'>,
): StageScreenId {
  if (liveClear) return 'live';
  switch (state.phase) {
    case 'normal':
      if (shown === 'arab-ayat' || shown === 'arab-hadis' || shown === 'arab-zikir') return shown;
      if (shown === 'zikir') return arab?.has('zikir') ? ARAB_OF.zikir : 'zikir';
      {
        const base = shown ? screenOfCard(shown) : null;
        if (base === 'ayat' || base === 'hadis') return arab?.has(base) ? ARAB_OF[base] : base;
        return base ?? (shown ? shellOnlyScreenOf(shown) : null) ?? 'biasa';
      }
    case 'azanCountdown':
      return 'azan';
    case 'masukWaktu':
      return 'masuk-waktu';
    case 'iqamah':
      return 'iqamah';
    case 'solat':
      return state.prayer === 'jumaat' ? 'jumaat' : 'solat';
    case 'khutbah':
      return 'jumaat';
    case 'noData':
      return 'tiada-data';
    default:
      return state.phase;
  }
}
