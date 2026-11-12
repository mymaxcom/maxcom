import type { DatabaseSync } from 'node:sqlite';
import { checkPrayerDay, hasOfficialSource, hijriOf } from '@surau/core';
import type { PrayerDay, PrayerName, PrayerSource, ResolvedDay, Settings } from '@surau/core';
import { calcLabelEn, calcLabelMs, computeDay } from './calc.ts';

export const PRAYER_NAMES: readonly PrayerName[] = ['imsak', 'subuh', 'syuruk', 'zohor', 'asar', 'maghrib', 'isyak'];
const ZONE = /^[A-Z]{3}\d{2}$/;
const DAY_MS = 86_400_000;
/** A difference above this many minutes is flagged by the cross-check. */
export const CROSS_CHECK_MINUTES = 2;

export function addDays(date: string, n: number): string {
  const t = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) + n * DAY_MS);
  return `${String(t.getUTCFullYear()).padStart(4, '0')}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/** Whole days from `a` to `b` (both YYYY-MM-DD). */
export function daysBetween(a: string, b: string): number {
  const ms = (d: string): number => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((ms(b) - ms(a)) / DAY_MS);
}

export interface CorrectionRow {
  date: string;
  prayer: PrayerName;
  time: string;
  reason: string;
  officialAtCorrection: string | null;
}

/** How far from an official day its Hijri date is still carried to a day without one. */
const HIJRI_NEAR_DAYS = 30;
/** The most days the official Hijri date may differ from Umm al-Qura for the difference to be carried over. */
const HIJRI_MAX_SHIFT = 2;

interface Loaded {
  official: Map<string, PrayerDay>;
  /** Official days up to HIJRI_NEAR_DAYS either side of the range, for the Hijri continuity of other sources. */
  officialNear: Map<string, PrayerDay>;
  file: Map<string, PrayerDay>;
  corrections: Map<string, CorrectionRow[]>;
}

function parseDay(json: unknown): PrayerDay | null {
  try {
    const v = JSON.parse(String(json)) as PrayerDay;
    return v && typeof v.date === 'string' && v.times ? v : null;
  } catch {
    return null;
  }
}

function load(db: DatabaseSync, settings: Settings, from: string, to: string): Loaded {
  const official = new Map<string, PrayerDay>();
  const officialNear = new Map<string, PrayerDay>();
  const zone = String(settings.zone.zone);
  if (hasOfficialSource(settings.location.country) && ZONE.test(zone)) {
    for (const r of db.prepare('SELECT json FROM prayer_days WHERE zone = ? AND date >= ? AND date <= ?')
      .all(zone, addDays(from, -HIJRI_NEAR_DAYS), addDays(to, HIJRI_NEAR_DAYS))) {
      const d = parseDay(r.json);
      if (!d) continue;
      officialNear.set(d.date, d);
      if (d.date >= from && d.date <= to) official.set(d.date, d);
    }
  }
  const file = new Map<string, PrayerDay>();
  for (const r of db
    .prepare(
      `SELECT f.json AS json FROM prayer_file_days f JOIN prayer_imports i ON i.id = f.import_id
       WHERE i.undone_at IS NULL AND f.date >= ? AND f.date <= ?`,
    )
    .all(from, to)) {
    const d = parseDay(r.json);
    if (d) file.set(d.date, d);
  }
  const corrections = new Map<string, CorrectionRow[]>();
  for (const r of db
    .prepare('SELECT date, prayer, time, reason, official_at_correction FROM prayer_corrections WHERE date >= ? AND date <= ? ORDER BY date, prayer')
    .all(from, to)) {
    const row: CorrectionRow = {
      date: String(r.date), prayer: String(r.prayer) as PrayerName, time: String(r.time), reason: String(r.reason),
      officialAtCorrection: typeof r.official_at_correction === 'string' ? r.official_at_correction : null,
    };
    const list = corrections.get(row.date);
    if (list) list.push(row); else corrections.set(row.date, [row]);
  }
  return { official, officialNear, file, corrections };
}

const sameHijri = (a: { y: number; m: number; d: number }, b: { y: number; m: number; d: number }): boolean => a.y === b.y && a.m === b.m && a.d === b.d;

/**
 * Days to add before reading Umm al-Qura so a calculated or file day's Hijri date continues the official one: the
 * difference measured on the nearest official day (within HIJRI_NEAR_DAYS, a difference of at most HIJRI_MAX_SHIFT
 * days). 0 when there is no official day near, or the two calendars differ by more than that (a data error, not a
 * month-start disagreement).
 */
function hijriShift(l: Loaded, date: string, cache: Map<string, number>): number {
  if (l.officialNear.size === 0) return 0;
  for (let k = 0; k <= HIJRI_NEAR_DAYS; k++) {
    for (const near of k === 0 ? [date] : [addDays(date, -k), addDays(date, k)]) {
      const o = l.officialNear.get(near);
      if (!o) continue;
      let shift = cache.get(near);
      if (shift === undefined) {
        shift = 0;
        for (const s of [0, 1, -1, 2, -2]) {
          if (Math.abs(s) <= HIJRI_MAX_SHIFT && sameHijri(o.hijri, hijriOf(addDays(near, s)))) { shift = s; break; }
        }
        cache.set(near, shift);
      }
      return shift;
    }
  }
  return 0;
}

/** The first source in the surau's order that has this date (corrections not yet applied). */
function pick(l: Loaded, settings: Settings, date: string): { day: PrayerDay; source: PrayerSource } | null {
  for (const source of settings.prayerSources.sourceOrder as PrayerSource[]) {
    if (source === 'official') {
      const d = l.official.get(date);
      if (d) return { day: d, source };
    } else if (source === 'file') {
      const d = l.file.get(date);
      if (d) return { day: d, source };
    } else {
      const d = computeDay(date, settings);
      if (d) return { day: d, source };
    }
  }
  return null;
}

function officialFirst(settings: Settings): boolean {
  const order = settings.prayerSources.sourceOrder as string[];
  const official = order.indexOf('official');
  const calc = order.indexOf('calc');
  return official >= 0 && (calc < 0 || official < calc);
}

function finish(l: Loaded, settings: Settings, date: string, shifts: Map<string, number> = new Map()): ResolvedDay | null {
  const hit = pick(l, settings, date);
  if (!hit) return null;
  if (hit.source !== 'official') {
    const shift = hijriShift(l, date, shifts);
    if (shift !== 0) hit.day = { ...hit.day, hijri: hijriOf(addDays(date, shift)) };
  }
  const times = { ...hit.day.times };
  const corrected: PrayerName[] = [];
  const ignored: PrayerName[] = [];
  const rows = (l.corrections.get(date) ?? []).filter((c) => PRAYER_NAMES.includes(c.prayer));
  const inOrder = (t: Record<PrayerName, string>): boolean => checkPrayerDay({ ...hit.day, times: t }) === null;
  if (rows.length > 0 && inOrder(times)) {
    // A correction that would break the order of the day (the source behind it changed later) is left out for that day
    // and flagged, never shown as a day the kiosk cannot use.
    const all = { ...times };
    for (const c of rows) all[c.prayer] = c.time;
    if (inOrder(all)) {
      Object.assign(times, all);
      for (const c of rows) corrected.push(c.prayer);
    } else {
      for (const c of rows) {
        const trial = { ...times, [c.prayer]: c.time };
        if (inOrder(trial)) { times[c.prayer] = c.time; corrected.push(c.prayer); } else ignored.push(c.prayer);
      }
    }
  } else {
    for (const c of rows) { times[c.prayer] = c.time; corrected.push(c.prayer); }
  }
  return {
    ...hit.day,
    times,
    source: hit.source,
    corrected,
    ...(ignored.length > 0 ? { correctionIgnored: ignored } : {}),
    // A calculated day is an emergency only where the official source is tried first; a surau that put its own
    // calculation above the official data chose it.
    emergency: hit.source === 'calc' && hasOfficialSource(settings.location.country) && officialFirst(settings),
    hijriSource: hit.source,
  };
}

/** Every date from `from` to `to` (inclusive) that has a day in some source; a date with none is left out. */
export function resolveDays(db: DatabaseSync, settings: Settings, from: string, to: string): ResolvedDay[] {
  const l = load(db, settings, from, to);
  const out: ResolvedDay[] = [];
  const n = daysBetween(from, to);
  const shifts = new Map<string, number>();
  for (let i = 0; i <= n; i++) {
    const day = finish(l, settings, addDays(from, i), shifts);
    if (day) out.push(day);
  }
  return out;
}

/**
 * Per date, the corrected prayers whose official time now differs from the one stored when the correction was made.
 * The correction still wins; this only lets the app say so. A correction with no stored official time is never flagged.
 */
export function officialChangedDays(db: DatabaseSync, settings: Settings, from: string, to: string): Map<string, PrayerName[]> {
  const l = load(db, settings, from, to);
  const out = new Map<string, PrayerName[]>();
  for (const [date, rows] of l.corrections) {
    const now = l.official.get(date);
    if (!now) continue;
    const moved = rows
      .filter((c) => PRAYER_NAMES.includes(c.prayer) && c.officialAtCorrection !== null && now.times[c.prayer] !== undefined && now.times[c.prayer] !== c.officialAtCorrection)
      .map((c) => c.prayer);
    if (moved.length > 0) out.set(date, moved);
  }
  return out;
}

export function resolveDay(db: DatabaseSync, settings: Settings, date: string): ResolvedDay | null {
  return finish(load(db, settings, date, date), settings, date);
}

export interface CrossCheck {
  flagged: { date: string; source: PrayerSource; diffs: Record<PrayerName, number> }[];
  maxDiff: Record<PrayerName, number>;
  medianDiff: Record<PrayerName, number>;
  compared: number;
}

const toMin = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const zeroes = (): Record<PrayerName, number> => ({ imsak: 0, subuh: 0, syuruk: 0, zohor: 0, asar: 0, maghrib: 0, isyak: 0 });

function median(list: number[]): number {
  if (list.length === 0) return 0;
  const s = [...list].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return Math.round(s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2);
}

/**
 * How far the official or file times are from the local calculation: source minus calculation, in whole
 * minutes, after the calculation's own adjustments (so a positive number is what to ADD to the current
 * adjustment to make the calculation agree). Corrections are deliberate and left out; a calc day has
 * nothing to compare. Needs a located surau.
 */
export function crossCheck(db: DatabaseSync, settings: Settings, from: string, to: string): CrossCheck {
  const l = load(db, settings, from, to);
  const out: CrossCheck = { flagged: [], maxDiff: zeroes(), medianDiff: zeroes(), compared: 0 };
  const per: Record<PrayerName, number[]> = { imsak: [], subuh: [], syuruk: [], zohor: [], asar: [], maghrib: [], isyak: [] };
  const n = daysBetween(from, to);
  for (let i = 0; i <= n; i++) {
    const date = addDays(from, i);
    const hit = pick(l, settings, date);
    if (!hit || hit.source === 'calc') continue;
    const calc = computeDay(date, settings);
    if (!calc) continue;
    out.compared++;
    const diffs = zeroes();
    let over = false;
    for (const p of PRAYER_NAMES) {
      const diff = toMin(hit.day.times[p]) - toMin(calc.times[p]);
      diffs[p] = diff;
      per[p].push(diff);
      if (Math.abs(diff) > out.maxDiff[p]) out.maxDiff[p] = Math.abs(diff);
      if (Math.abs(diff) > CROSS_CHECK_MINUTES) over = true;
    }
    if (over) out.flagged.push({ date, source: hit.source, diffs });
  }
  for (const p of PRAYER_NAMES) out.medianDiff[p] = median(per[p]);
  return out;
}

function methodLabel(settings: Settings, lang: 'ms' | 'en'): string {
  return lang === 'en' ? calcLabelEn(settings) : calcLabelMs(settings);
}

/** The footer line under the prayer bar: where today's times come from (Plan 13 #31). */
export function sourceLine(settings: Settings, day: ResolvedDay, lang: 'ms' | 'en'): string {
  const ms = lang === 'ms';
  let line: string;
  if (day.source === 'official') {
    line = `${ms ? 'Sumber' : 'Source'}: JAKIM e-Solat ${String(settings.zone.zone)}`;
  } else if (day.source === 'calc') {
    const city = settings.location.city.trim();
    line = `${methodLabel(settings, lang)}${city !== '' ? `, ${city}` : ''}`;
  } else {
    const masjid = settings.surauInfo.kind === 'masjid';
    line = ms ? `Jadual ${masjid ? 'masjid' : 'surau'} (fail)` : `${masjid ? 'Mosque' : 'Surau'} timetable (file)`;
  }
  if (day.corrected.length > 0) line += ms ? ' dan pembetulan' : ' and corrections';
  return line;
}
