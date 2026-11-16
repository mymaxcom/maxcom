import { screenOfCard } from '@surau/core';
import type { KioskState, ScreenId, SlotFeature } from '@surau/core';

/**
 * The stable, short screen id the stage wears as `data-screen` (the theme contract's screen catalog, plus the three
 * phases that have no catalog screen of their own: syuruk, isyraq and tarawih keep their phase names).
 */
export type StageScreenId = ScreenId | 'syuruk' | 'isyraq' | 'tarawih';

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
        return base ?? 'biasa';
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
