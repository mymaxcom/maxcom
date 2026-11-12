import { HIJRI_MONTHS_EN, HIJRI_MONTHS_MS, dateOf, klWeekday, offsetMinutes } from '@surau/core';
import type { HijriDate } from '@surau/core';
import type { Lang } from './i18n.ts';

const KL = 'Asia/Kuala_Lumpur';

const DAYS_MS = ['Ahad', 'Isnin', 'Selasa', 'Rabu', 'Khamis', 'Jumaat', 'Sabtu'];
const DAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_MS = ['Januari', 'Februari', 'Mac', 'April', 'Mei', 'Jun', 'Julai', 'Ogos', 'September', 'Oktober', 'November', 'Disember'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const p2 = (n: number): string => String(n).padStart(2, '0');

/** Wall-clock hours/minutes/seconds of an instant in the surau's zone. */
function wallHms(now: Date, tz: string): { h: number; m: number; s: number } {
  const t = new Date(now.getTime() + offsetMinutes(now, tz) * 60_000);
  return { h: t.getUTCHours(), m: t.getUTCMinutes(), s: t.getUTCSeconds() };
}

/** An instant as clock text in KL ('2:10 PTG' or '14:10'); null when there is none or it is unreadable. */
export function fmtAt(iso: string | null, timeFormat: '12h' | '24h', lang: Lang = 'ms'): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const c = fmtClock(d, timeFormat, false, lang);
  return c.ampm ? `${c.hm} ${c.ampm}` : c.hm;
}

export function fmtClock(
  now: Date,
  timeFormat: '12h' | '24h',
  showSeconds: boolean,
  lang: Lang = 'ms',
  tz: string = KL,
): { hm: string; s: string; ampm: string } {
  const { h, m, s } = wallHms(now, tz);
  // seconds are always returned; the caller decides whether to render them (showSeconds)
  void showSeconds;
  const sec = p2(s);
  if (timeFormat === '24h') return { hm: `${p2(h)}:${p2(m)}`, s: sec, ampm: '' };
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const pm = h >= 12;
  const ampm = lang === 'ms' ? (pm ? 'PTG' : 'PG') : pm ? 'PM' : 'AM';
  return { hm: `${h12}:${p2(m)}`, s: sec, ampm };
}

export function fmtPrayerTime(hhmm: string, timeFormat: '12h' | '24h'): string {
  if (timeFormat === '24h') return hhmm;
  const [hs, ms] = hhmm.split(':');
  const h = Number(hs);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${ms}`;
}

export function fmtCountdown(ms: number): string {
  const total = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${p2(h)}:${p2(m)}:${p2(s)}`;
}

export function fmtGregorian(now: Date, lang: Lang, tz: string = KL): string {
  const date = dateOf(now, tz);
  const wd = klWeekday(date);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const days = lang === 'ms' ? DAYS_MS : DAYS_EN;
  const months = lang === 'ms' ? MONTHS_MS : MONTHS_EN;
  return `${days[wd]}, ${d} ${months[m - 1]} ${y}`;
}

export function fmtHijri(h: HijriDate, lang: Lang): string {
  const names = lang === 'ms' ? HIJRI_MONTHS_MS : HIJRI_MONTHS_EN;
  const name = names[h.m - 1] ?? '';
  return lang === 'ms' ? `${h.d} ${name} ${h.y}H` : `${h.d} ${name} ${h.y} AH`;
}

const LABELS: Record<string, string> = {
  imsak: 'Imsak',
  subuh: 'Subuh',
  syuruk: 'Syuruk',
  zohor: 'Zohor',
  jumaat: 'Jumaat',
  asar: 'Asar',
  maghrib: 'Maghrib',
  isyak: 'Isyak',
};

/** Prayer names stay Malay in every language. */
export function prayerLabel(name: string, _lang: Lang): string {
  return LABELS[name] ?? name;
}
