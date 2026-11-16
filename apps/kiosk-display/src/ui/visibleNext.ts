import { instantOf } from '@surau/core';
import type { KioskState, PrayerName, Settings } from '@surau/core';

/** The prayer times of the day in bar order. */
export const PRAYER_ORDER: readonly PrayerName[] = ['imsak', 'subuh', 'syuruk', 'zohor', 'asar', 'maghrib', 'isyak'];

/** The prayers the bar shows: Imsak and Syuruk follow prayerBar.showImsak / showSyuruk. */
export function visiblePrayers(settings: Pick<Settings, 'prayerBar'>): PrayerName[] {
  const pb = settings.prayerBar;
  return PRAYER_ORDER.filter((p) => {
    if (p === 'imsak' && pb.showImsak === false) return false;
    if (p === 'syuruk' && pb.showSyuruk === false) return false;
    return true;
  });
}

/** The bar cell a state prayer name lands on: Friday 'jumaat' is the Zohor cell. */
export function cellOf(name: string | null | undefined): PrayerName | null {
  if (!name) return null;
  return (name === 'jumaat' ? 'zohor' : name) as PrayerName;
}

/** How long the chip says "Masuk waktu" after a prayer time (theme round 2, rule 6). */
export const JUST_IN_MS = 3 * 60_000;
/** The prayers whose time "comes in": Imsak and Syuruk mark times, not prayers. */
const ENTERS: readonly PrayerName[] = ['subuh', 'zohor', 'asar', 'maghrib', 'isyak'];

/**
 * The prayer whose time came in less than three minutes ago (Friday's Zohor named Jumaat), with its time, else null.
 * The chip names it with "Masuk waktu" for those minutes, then moves on to the next prayer.
 */
export function justInOf(
  state: Pick<KioskState, 'today' | 'isJumaat'>,
  settings: Pick<Settings, 'jumaat'>,
  now: Date,
  tz: string = 'Asia/Kuala_Lumpur',
): NonNullable<KioskState['next']> | null {
  const day = state.today;
  if (!day) return null;
  const t = now.getTime();
  for (const p of ENTERS) {
    let at: Date;
    try {
      at = instantOf(day.date, day.times[p], tz);
    } catch {
      continue;
    }
    const since = t - at.getTime();
    if (since >= 0 && since < JUST_IN_MS) {
      const name = p === 'zohor' && state.isJumaat && settings.jumaat?.enabled ? 'jumaat' : p;
      return { name: name as NonNullable<KioskState['next']>['name'], at };
    }
  }
  return null;
}

/**
 * The prayer that comes next among those the bar shows. The state's next prayer when it is shown; when it is hidden
 * (Imsak or Syuruk switched off), the next VISIBLE prayer after it, at its time today, or the same wall-clock time a day
 * later once today's has passed (tomorrow's Imsak is next after Isyak). Only what is named "next" changes: the phases
 * (azan, iqamah, syuruk warning) still run on the state's own times. Null when there is no next prayer or no row.
 */
export function visibleNextOf(
  state: Pick<KioskState, 'next' | 'today' | 'isJumaat'>,
  settings: Pick<Settings, 'prayerBar' | 'jumaat'>,
  now: Date,
  tz: string = 'Asia/Kuala_Lumpur',
): NonNullable<KioskState['next']> | null {
  const next = state.next;
  if (!next) return null;
  const cells = visiblePrayers(settings);
  const cell = cellOf(next.name);
  if (cell === null || cells.includes(cell)) return next;
  const day = state.today;
  if (!day) return next;
  const after = PRAYER_ORDER.slice(PRAYER_ORDER.indexOf(cell) + 1).find((p) => cells.includes(p));
  if (!after) return null;
  try {
    let at = instantOf(day.date, day.times[after], tz);
    if (at.getTime() <= now.getTime()) at = new Date(at.getTime() + 86_400_000);
    // Friday's Zohor is named Jumaat, as the state names it when it is the next prayer itself.
    const name = after === 'zohor' && state.isJumaat && settings.jumaat?.enabled ? 'jumaat' : after;
    return { name: name as NonNullable<KioskState['next']>['name'], at };
  } catch {
    return null;
  }
}
