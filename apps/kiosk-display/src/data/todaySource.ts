import type { PrayerDay, PrayerSource, ResolvedDay } from '@surau/core';
import type { PrayerInfo } from './bundle.ts';

/** Where today's times come from (Plan 13): the day's source, whether it is an emergency calculation, and the footer line per language. */
export interface TodaySource {
  source: PrayerSource;
  emergency: boolean;
  footer: { ms: string; en: string } | null;
}

const FOOTER_MAX = 300;
const SOURCES: readonly PrayerSource[] = ['official', 'calc', 'file'];

/**
 * Today's source from the bundle. An old bundle has no `prayer` block and rows without source fields:
 * that reads as an official day, no emergency and no footer (the kiosk looks exactly as before).
 */
export function todaySourceOf(days: readonly PrayerDay[], today: string, prayer: PrayerInfo | undefined): TodaySource {
  const row = days.find((d) => d.date === today) as Partial<ResolvedDay> | undefined;
  const source = row?.source !== undefined && SOURCES.includes(row.source) ? row.source : 'official';
  // The row of the day itself carries its footer (right across midnight); an older bundle only has today's in `prayer`.
  const own = typeof row?.footerMs === 'string' && typeof row.footerEn === 'string'
    ? { ms: row.footerMs.slice(0, FOOTER_MAX), en: row.footerEn.slice(0, FOOTER_MAX) }
    : null;
  return {
    source,
    emergency: row?.emergency === true,
    footer: own ?? (prayer ? { ms: prayer.footerMs, en: prayer.footerEn } : null),
  };
}
