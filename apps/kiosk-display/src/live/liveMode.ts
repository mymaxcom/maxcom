import { useMemo } from 'preact/hooks';
import { buildDayIntervals, instantOf, tzOf } from '@surau/core';
import type { KioskState, Settings, SolatName } from '@surau/core';

/**
 * How the live shows on the kiosk at one instant (operator decision 2026-11-14, replaces Plan 5 decision 12):
 *  - 'none'    no live (or the feature is off): the kiosk is exactly as before;
 *  - 'blurred' inside a prayer window, 1 minute either side of the AZAN time or of the IQAMAH time, while the
 *              phase machine has a prayer screen up: that screen shows on top, the live keeps playing blurred
 *              behind it (same video element, no WHEP reconnect);
 *  - 'clear'   every other moment of a live: the live takes the main area, over the rest of the azan and iqamah
 *              countdowns, the solat screen after iqamah + 1 min, the cards, the ticker and the zikir.
 */
export type LiveDisplayMode = 'clear' | 'blurred' | 'none';

/** Half the width of a window around the azan or the iqamah time. */
export const LIVE_WINDOW_MS = 60_000;

/** The prayer screens that may come up on top of a blurred live (never syuruk, isyraq or tarawih). */
const PRAYER_SCREENS: ReadonlySet<KioskState['phase']> = new Set([
  'azanCountdown',
  'masukWaktu',
  'iqamah',
  'solat',
  'khutbah',
]);

const SOLAT_KEYS = ['subuh', 'zohor', 'asar', 'maghrib', 'isyak'] as const;
type SolatKey = (typeof SOLAT_KEYS)[number];
const keyOf = (p: SolatName | 'syuruk'): SolatKey | null =>
  p === 'jumaat' ? 'zohor' : p === 'syuruk' ? null : p;

/**
 * The instants the live gives way around: each prayer's azan time (the day's own time) and, when the prayer has an
 * iqamah countdown, the iqamah time. The iqamah time is the end of the phase machine's own iqamah interval
 * (buildDayIntervals), so the weekly iqamah table, a masjid file's per-date override and the Friday rules
 * (khutbah, then the Jumaat iqamah) all come from the one computation; nothing here repeats that maths.
 */
export function liveAnchors(state: KioskState, settings: Settings): Date[] {
  const day = state.today;
  if (!day) return [];
  const out: Date[] = [];
  try {
    const tz = tzOf(settings);
    for (const key of SOLAT_KEYS) out.push(instantOf(day.date, day.times[key], tz));
    for (const iv of buildDayIntervals(day, settings)) {
      if (iv.phase === 'iqamah' && keyOf(iv.prayer) !== null) out.push(iv.end);
    }
  } catch {
    // A day the phase machine could not read has no windows: the live stays clear.
    return [];
  }
  return out;
}

/** Whether `now` is within 1 minute before to 1 minute after one of the anchors (the end is exclusive). */
export function inLiveWindow(now: Date, anchors: readonly Date[]): boolean {
  const t = now.getTime();
  return anchors.some((a) => t >= a.getTime() - LIVE_WINDOW_MS && t < a.getTime() + LIVE_WINDOW_MS);
}

/**
 * The live's display mode. `onAir` is the box's word (useLive: live and liveOnKiosk enabled). Blurred needs both a
 * window and a prayer screen from the phase machine: a window with no prayer screen (say the azan countdown is
 * switched off) has nothing to put on top, so the live stays clear.
 */
export function liveDisplayMode(
  now: Date,
  state: KioskState,
  settings: Settings,
  onAir: boolean,
  anchors?: readonly Date[],
): LiveDisplayMode {
  if (!onAir) return 'none';
  if (!PRAYER_SCREENS.has(state.phase)) return 'clear';
  return inLiveWindow(now, anchors ?? liveAnchors(state, settings)) ? 'blurred' : 'clear';
}

/**
 * The anchors of the day, built once per day and settings and kept across the per-second ticks (the comparison
 * with `now` is all that runs every second). `build` is injectable for tests.
 */
export function useLiveAnchors(state: KioskState, settings: Settings, build: typeof liveAnchors = liveAnchors): Date[] {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => build(state, settings), [state.today, settings]);
}
