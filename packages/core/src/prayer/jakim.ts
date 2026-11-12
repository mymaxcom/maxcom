import type { HijriDate, PrayerDay, PrayerName } from './types.ts';

const CSV_HEADER = 'Tarikh Miladi,Tarikh Hijri,Hari,Imsak,Subuh,Syuruk,Zohor,Asar,Maghrib,Isyak';
const GREG_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HIJRI_MONTHS = ['Muh', 'Saf', 'Raw', 'Rak', 'Jaw', 'Jak', 'Rej', 'Syb', 'Ram', 'Syw', 'Zkh', 'Zhj'];
const PRAYERS: PrayerName[] = ['imsak', 'subuh', 'syuruk', 'zohor', 'asar', 'maghrib', 'isyak'];
const API_KEYS: Record<PrayerName, string> = {
  imsak: 'imsak',
  subuh: 'fajr',
  syuruk: 'syuruk',
  zohor: 'dhuhr',
  asar: 'asr',
  maghrib: 'maghrib',
  isyak: 'isha',
};

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function gregorian(day: number, month: number, year: number): string {
  const t = new Date(Date.UTC(year, month - 1, day));
  if (t.getUTCFullYear() !== year || t.getUTCMonth() !== month - 1 || t.getUTCDate() !== day) {
    throw new Error(`not a real calendar date (${day}/${month}/${year})`);
  }
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

// e-Solat writes Malay month abbreviations (measured 2026-11-03: Jan Feb Mac Apr Mei Jun Jul Ogos Sep Okt Nov Dis).
const GREG_MONTHS_MS = ['jan', 'feb', 'mac', 'apr', 'mei', 'jun', 'jul', 'ogos', 'sep', 'okt', 'nov', 'dis'];

function parseGregorianText(s: string): string {
  const m = /^(\d{1,2})-([A-Za-z]{3,4})-(\d{4})$/.exec(s);
  if (!m) throw new Error(`bad date "${s}"`);
  const name = m[2]!.toLowerCase();
  let mi = GREG_MONTHS.findIndex((x) => x.toLowerCase() === name);
  if (mi < 0) mi = GREG_MONTHS_MS.indexOf(name);
  if (mi < 0) throw new Error(`unknown month in date "${s}"`);
  return gregorian(Number(m[1]), mi + 1, Number(m[3]));
}

function hijri(y: number, m: number, d: number, raw: string): HijriDate {
  if (!Number.isInteger(y) || y < 1 || y > 9999) throw new Error(`bad Hijri year in "${raw}"`);
  if (!Number.isInteger(m) || m < 1 || m > 12) throw new Error(`bad Hijri month in "${raw}"`);
  if (!Number.isInteger(d) || d < 1 || d > 30) throw new Error(`Hijri day must be 1..30 in "${raw}"`);
  return { y, m, d };
}

function parseHijriText(s: string): HijriDate {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (!m) throw new Error(`bad Hijri date "${s}"`);
  const mi = HIJRI_MONTHS.findIndex((x) => x.toLowerCase() === m[2]!.toLowerCase());
  if (mi < 0) throw new Error(`unknown Hijri month in "${s}"`);
  return hijri(Number(m[3]), mi + 1, Number(m[1]), s);
}

function parse12h(s: string): string {
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(s);
  if (!m) throw new Error(`bad time "${s}"`);
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 1 || h > 12 || min > 59) throw new Error(`bad time "${s}"`);
  const pm = m[3]!.toLowerCase() === 'pm';
  if (h === 12) h = pm ? 12 : 0;
  else if (pm) h += 12;
  return `${pad(h)}:${pad(min)}`;
}

function parse24h(s: unknown): string {
  if (typeof s !== 'string') throw new Error(`bad time ${JSON.stringify(s)}`);
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) throw new Error(`bad time "${s}"`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] === undefined ? 0 : Number(m[3]);
  if (h > 23 || min > 59 || sec > 59) throw new Error(`bad time "${s}"`);
  return `${pad(h)}:${pad(min)}`;
}

/** Null if the day's seven times are strictly increasing (HH:mm compare), else a message naming the pair. */
export function checkPrayerDay(day: PrayerDay): string | null {
  for (let i = 1; i < PRAYERS.length; i++) {
    const a = PRAYERS[i - 1]!;
    const b = PRAYERS[i]!;
    const ta = day.times?.[a];
    const tb = day.times?.[b];
    if (typeof ta !== 'string' || typeof tb !== 'string') return `${a}/${b} time missing`;
    if (!(ta < tb)) return `prayer times out of order: ${a} ${ta} is not before ${b} ${tb}`;
  }
  return null;
}

export function parseJakimCsv(text: string): PrayerDay[] {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0 || lines[first]!.trim() !== CSV_HEADER) {
    throw new Error(`Missing or wrong CSV header, expected "${CSV_HEADER}"`);
  }
  const out: PrayerDay[] = [];
  const seen = new Set<string>();
  let n = 0;
  for (const line of lines.slice(first + 1)) {
    if (line.trim() === '') continue;
    n++;
    try {
      const cells = line.split(',').map((c) => c.trim());
      if (cells.length !== 10) throw new Error(`expected 10 columns, got ${cells.length}`);
      const times = {} as Record<PrayerName, string>;
      PRAYERS.forEach((p, i) => {
        times[p] = parse12h(cells[3 + i]!);
      });
      const day: PrayerDay = { date: parseGregorianText(cells[0]!), hijri: parseHijriText(cells[1]!), times };
      const bad = checkPrayerDay(day);
      if (bad) throw new Error(bad);
      if (seen.has(day.date)) throw new Error('duplicate date');
      seen.add(day.date);
      out.push(day);
    } catch (e) {
      throw new Error(`row ${n}: ${(e as Error).message}`);
    }
  }
  return out;
}

export function parseJakimApi(json: unknown): PrayerDay[] {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('e-Solat JSON must be an object');
  }
  const list = (json as { prayerTime?: unknown }).prayerTime;
  if (!Array.isArray(list)) throw new Error('e-Solat JSON has no prayerTime array');
  const seen = new Set<string>();
  return list.map((entry: unknown, i): PrayerDay => {
    try {
      if (typeof entry !== 'object' || entry === null) throw new Error('entry is not an object');
      const e = entry as Record<string, unknown>;
      if (typeof e.date !== 'string') throw new Error('missing date');
      if (typeof e.hijri !== 'string') throw new Error('missing hijri');
      const hm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(e.hijri);
      if (!hm) throw new Error(`bad hijri "${e.hijri}"`);
      const times = {} as Record<PrayerName, string>;
      for (const p of PRAYERS) times[p] = parse24h(e[API_KEYS[p]]);
      const day: PrayerDay = {
        date: parseGregorianText(e.date),
        hijri: hijri(Number(hm[1]), Number(hm[2]), Number(hm[3]), e.hijri),
        times,
      };
      // The API now returns dhuha too (checked 2026-11-09); kept only when it is a valid time.
      // A bad dhuha never fails the fetch: the pilot's seven times matter more.
      try { if (typeof e.dhuha === 'string' && e.dhuha !== '') day.dhuha = parse24h(e.dhuha); } catch { /* ignore */ }
      const bad = checkPrayerDay(day);
      if (bad) throw new Error(bad);
      if (seen.has(day.date)) throw new Error('duplicate date');
      seen.add(day.date);
      return day;
    } catch (err) {
      throw new Error(`prayerTime[${i}]: ${(err as Error).message}`);
    }
  });
}
