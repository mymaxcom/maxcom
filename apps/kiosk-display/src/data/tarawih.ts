import { hijriForDisplay } from '@surau/core';
import type { PrayerDay, Settings } from '@surau/core';

/**
 * Hijri month used for tarawih. The Islamic day starts at Maghrib and the moon-sighting
 * adjustment applies, whether or not the hijriDate display feature is switched on.
 */
export function tarawihMonthFor(now: Date, days: PrayerDay[], settings: Settings): number | undefined {
  return hijriForDisplay(now, days, settings.hijriDate.adjustDays, 'maghrib')?.m;
}
