import type { KioskState } from '@surau/core';

/**
 * The stable, short screen id the stage wears as `data-screen` (for the theme packs that will style screens by
 * name). The live screen is 'live'; the khutbah (and the Jumaat solat) screen is 'jumaat'. Syuruk, isyraq and
 * tarawih keep their own phase names.
 */
export type ScreenId =
  | 'biasa'
  | 'azan'
  | 'masuk-waktu'
  | 'iqamah'
  | 'solat'
  | 'jumaat'
  | 'tiada-data'
  | 'live'
  | 'syuruk'
  | 'isyraq'
  | 'tarawih';

export function screenIdOf(state: Pick<KioskState, 'phase' | 'prayer'>, liveClear: boolean): ScreenId {
  if (liveClear) return 'live';
  switch (state.phase) {
    case 'normal':
      return 'biasa';
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
