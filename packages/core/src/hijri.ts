import type { HijriDate, PrayerDay } from './prayer/types.ts';
import { dateOf, instantOf } from './time.ts';

export const HIJRI_MONTHS_MS = [
  'Muharram',
  'Safar',
  'Rabiulawal',
  'Rabiulakhir',
  'Jamadilawal',
  'Jamadilakhir',
  'Rejab',
  'Syaaban',
  'Ramadan',
  'Syawal',
  'Zulkaedah',
  'Zulhijjah',
] as const;

export const HIJRI_MONTHS_EN = [
  'Muharram',
  'Safar',
  'Rabi al-Awwal',
  'Rabi al-Thani',
  'Jumada al-Ula',
  'Jumada al-Akhirah',
  'Rajab',
  'Shaban',
  'Ramadan',
  'Shawwal',
  'Dhu al-Qadah',
  'Dhu al-Hijjah',
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Date string plus n days (pure calendar arithmetic, no zone). */
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return `${String(t.getUTCFullYear()).padStart(4, '0')}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

const UMM_AL_QURA = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', {
  timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric',
});

/** Umm al-Qura Hijri date of a Gregorian calendar date (YYYY-MM-DD), by Intl on that date's UTC noon. */
export function hijriOf(date: string): HijriDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  if (Number.isNaN(noon.getTime())) throw new Error(`Invalid date "${date}"`);
  const out = { y: 0, m: 0, d: 0 };
  for (const p of UMM_AL_QURA.formatToParts(noon)) {
    const type: string = p.type;
    if (type === 'year' || type === 'relatedYear') out.y = Number(p.value);
    else if (type === 'month') out.m = Number(p.value);
    else if (type === 'day') out.d = Number(p.value);
  }
  if (!out.y || !out.m || !out.d) throw new Error(`No Hijri date for "${date}"`);
  return out;
}

export function hijriForDisplay(
  now: Date,
  days: PrayerDay[],
  adjustDays: number,
  switchAt: 'maghrib' | 'midnight',
  tz: string = 'Asia/Kuala_Lumpur',
): HijriDate | null {
  const today = dateOf(now, tz);
  const byDate = new Map(days.map((d) => [d.date, d]));
  const todayRow = byDate.get(today);
  if (!todayRow) return null;

  let offset = 0;
  if (switchAt === 'maghrib' && now >= instantOf(today, todayRow.times.maghrib, tz)) {
    offset += 1;
  }

  const targetRow = byDate.get(addDays(today, offset + adjustDays));
  if (!targetRow) return null;
  return targetRow.hijri;
}
