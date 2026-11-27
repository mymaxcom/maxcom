import { DAY_KEYS, buildDayIntervals, firstAzanPlan, instantOf, klWeekday, dateOf, tzOf, zikirStarts } from '@surau/core';
import type { PrayerDay, Settings, TilawahSlot } from '@surau/core';

const MIN = 60_000;

/**
 * How many whole seconds a video that starts at `now` has before the next thing that must have the screen to itself:
 * the start of the next prayer phase (the countdown before the azan, the azan, iqamah, solat ...), the next tilawah
 * window, the first Subuh azan, or the next zikir after a prayer (it may start some minutes after the solat, F16;
 * `zikirCount` is the number of zikir items: 0 = no zikir, left out = counted as some). Infinity when none is left
 * today. This is the SOFT rule (a video that cannot finish is not started); the hard rule (stop at once when one
 * begins) is the unmounting in VideoScreen and Main.
 */
export function videoRoomSeconds(
  now: Date, day: PrayerDay | null, settings: Settings, slots: readonly TilawahSlot[], hijriMonth?: number, zikirCount?: number,
): number {
  if (!day) return Number.POSITIVE_INFINITY;
  const t = now.getTime();
  let next = Number.POSITIVE_INFINITY;
  for (const i of buildDayIntervals(day, settings, hijriMonth)) {
    const s = i.start.getTime();
    if (s > t && s < next) next = s;
  }
  for (const z of zikirStarts(day, settings, hijriMonth, zikirCount)) {
    const s = z.getTime();
    if (s > t && s < next) next = s;
  }
  const fa = firstAzanPlan(day, settings);
  if (fa && fa.startsAt.getTime() > t) next = Math.min(next, fa.startsAt.getTime());
  // A recitation slot only matters while the tilawah feature is on (the same switch tilawahWindow reads): with it off
  // nothing recites, and a kept slot must not hold a video back.
  const tl = (settings as unknown as { tilawah?: { enabled?: unknown } }).tilawah;
  const recitations = !tl || tl.enabled === false ? [] : slots;
  const tz = tzOf(settings);
  const date = dateOf(now, tz);
  const dayKey = DAY_KEYS[klWeekday(date)] ?? 'ahad';
  for (const slot of recitations) {
    if (!slot.enabled) continue;
    if (!slot.days.includes('daily') && !slot.days.includes(dayKey)) continue;
    const hhmm = day.times[slot.before];
    if (!hhmm) continue;
    let start: number;
    try {
      start = instantOf(date, hhmm, tz).getTime() - slot.minutesBefore * MIN;
    } catch {
      continue;
    }
    if (start > t && start < next) next = start;
  }
  return next === Number.POSITIVE_INFINITY ? next : Math.max(0, Math.floor((next - t) / 1000));
}
