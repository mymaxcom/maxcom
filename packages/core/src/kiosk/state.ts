import { dateOf, instantOf, klDateOf, klInstant, klWeekday, tzOf } from '../time.ts';
import type { PrayerDay } from '../prayer/types.ts';
import { checkPrayerDay } from '../prayer/jakim.ts';
import { DAY_KEYS, minutesFor } from '../features/registry.ts';
import type { FeatureSettings, Settings, SolatKey, WeekTable } from '../features/registry.ts';

export type Phase =
  | 'normal' | 'azanCountdown' | 'masukWaktu' | 'iqamah' | 'solat' | 'khutbah'
  | 'syuruk' | 'isyraq' | 'tarawih' | 'noData';
export type SolatName = 'subuh' | 'zohor' | 'jumaat' | 'asar' | 'maghrib' | 'isyak';

export interface KioskState {
  phase: Phase;
  prayer: SolatName | 'syuruk' | null;
  phaseEndsAt: Date | null;
  next: { name: SolatName | 'imsak' | 'syuruk'; at: Date } | null;
  isJumaat: boolean;
  today: PrayerDay | null;
  beep: 'azanCountdown' | 'masukWaktu' | 'iqamahEnd' | 'imsak' | 'syuruk' | null;
  /**
   * The first Subuh azan: set for 30 s from `minutesBefore` minutes before Subuh when an audio file is chosen, else null.
   * `stopsAt` is the latest moment it may still sound (see `firstAzanPlan`).
   */
  firstAzan: { audioFile: string; startsAt: Date; stopsAt: Date } | null;
}

export interface PhaseInterval {
  start: Date;
  end: Date;
  phase: Exclude<Phase, 'normal' | 'noData'>;
  prayer: SolatName | 'syuruk';
}

interface Stage extends PhaseInterval {
  beepAt?: Date;
  beepKind?: 'azanCountdown' | 'masukWaktu' | 'iqamahEnd' | 'syuruk';
}

const MIN = 60_000;
const SEC = 1_000;
const BEEP_WINDOW_MS = 3 * SEC;
/** How long the first-azan start stays set: long enough for a one-second tick to see it, short enough that a late start never plays it. */
const FIRST_AZAN_WINDOW_MS = 30 * SEC;
const ASSET_ID = /^[0-9a-f]{64}$/;
const SOLAT: readonly SolatKey[] = ['subuh', 'zohor', 'asar', 'maghrib', 'isyak'];

type Raw = Partial<FeatureSettings> | undefined;
const feat = (s: Settings, k: keyof Settings): Raw => (s as unknown as Record<string, Raw>)?.[k];
const on = (f: Raw): boolean => f?.enabled !== false;
const num = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
const bool = (v: unknown, fb: boolean): boolean => (typeof v === 'boolean' ? v : fb);
const table = (v: unknown): WeekTable => (v && typeof v === 'object' ? (v as WeekTable) : ({} as WeekTable));

function addDays(date: string, n: number): string {
  return klDateOf(new Date(klInstant(date, '12:00').getTime() + n * 24 * 60 * MIN));
}

function iqamahBeep(iq: Raw, end: Date, start: Date): Partial<Stage> {
  if (!on(iq) || !bool(iq?.beep, true)) return {};
  const w = num(iq?.endWarningSeconds, 30);
  if (w <= 0) return {};
  const at = new Date(end.getTime() - w * SEC);
  if (at.getTime() < start.getTime()) return {};
  return { beepAt: at, beepKind: 'iqamahEnd' };
}

function buildStages(day: PrayerDay, settings: Settings, hijriMonth?: number): Stage[] {
  const out: Stage[] = [];
  const tz = tzOf(settings);
  const wd = klWeekday(day.date);
  const dayKey = DAY_KEYS[wd] ?? 'ahad';
  const fridayOn = wd === 5 && on(feat(settings, 'jumaat'));

  const az = feat(settings, 'azanCountdown');
  const mw = feat(settings, 'masukWaktu');
  const iq = feat(settings, 'iqamahCountdown');
  const ss = feat(settings, 'solatScreen');
  const jm = feat(settings, 'jumaat');
  const sw = feat(settings, 'syurukWarning');
  const isy = feat(settings, 'isyraq');
  const tw = feat(settings, 'tarawih');

  let isyakEnd: Date | null = null;

  for (const key of SOLAT) {
    const T = instantOf(day.date, day.times[key], tz);
    const prayer: SolatName = key === 'zohor' && fridayOn ? 'jumaat' : key;
    const push = (start: Date, end: Date, phase: PhaseInterval['phase'], extra: Partial<Stage> = {}) => {
      out.push({ start, end, phase, prayer, ...extra });
    };

    if (on(az)) {
      const before = (az as { minutesBefore?: Record<string, unknown> })?.minutesBefore;
      const m = num(before?.[key], 10);
      if (m > 0) {
        const start = new Date(T.getTime() - m * MIN);
        push(start, T, 'azanCountdown', bool(az?.beep, true) ? { beepAt: start, beepKind: 'azanCountdown' } : {});
      }
    }

    let cursor = T;
    if (on(mw)) {
      const s = num(mw?.screenSeconds, 60);
      if (s > 0) {
        const end = new Date(T.getTime() + s * SEC);
        push(T, end, 'masukWaktu', bool(mw?.beep, true) ? { beepAt: T, beepKind: 'masukWaktu' } : {});
        cursor = end;
      }
    }

    if (prayer === 'jumaat') {
      const kh = num(day.overrides?.khutbahMinutes ?? jm?.khutbahMinutes, 20);
      if (kh > 0) {
        const end = new Date(cursor.getTime() + kh * MIN);
        push(cursor, end, 'khutbah');
        cursor = end;
      }
      const iqm = num(jm?.iqamahMinutes, 7);
      if (iqm > 0) {
        const end = new Date(cursor.getTime() + iqm * MIN);
        push(cursor, end, 'iqamah', iqamahBeep(iq, end, cursor));
        cursor = end;
      }
      const sm = num(jm?.solatMinutes, 15);
      if (sm > 0) push(cursor, new Date(cursor.getTime() + sm * MIN), 'solat');
      continue;
    }

    if (on(iq)) {
      // A masjid file may set this prayer's iqamah minutes for this one date; it beats the weekly table.
      const ov = day.overrides?.iqamahMinutes?.[key];
      const m = typeof ov === 'number' ? ov : minutesFor(table(iq?.minutes), dayKey, key, 10);
      const end = new Date(T.getTime() + m * MIN);
      if (end.getTime() > cursor.getTime()) {
        push(cursor, end, 'iqamah', iqamahBeep(iq, end, cursor));
        cursor = end;
      }
    }
    if (on(ss)) {
      const m = minutesFor(table(ss?.minutes), dayKey, key, 15);
      if (m > 0) {
        const end = new Date(cursor.getTime() + m * MIN);
        push(cursor, end, 'solat');
        cursor = end;
      }
    }
    if (key === 'isyak') isyakEnd = cursor;
  }

  if (on(sw)) {
    const m = num(sw?.minutesBefore, 5);
    if (m > 0) {
      const sy = instantOf(day.date, day.times.syuruk, tz);
      const start = new Date(sy.getTime() - m * MIN);
      // syurukWarning.beep (off by default): one short tone when the warning screen starts, like the countdown beep.
      const beep: Partial<Stage> = bool(sw?.beep, false) ? { beepAt: start, beepKind: 'syuruk' } : {};
      out.push({ start, end: sy, phase: 'syuruk', prayer: 'syuruk', ...beep });
    }
  }
  if (on(isy)) {
    const d = num(isy?.durationMinutes, 5);
    if (d > 0) {
      const sy = instantOf(day.date, day.times.syuruk, tz);
      const start = new Date(sy.getTime() + num(isy?.minutesAfterSyuruk, 15) * MIN);
      out.push({ start, end: new Date(start.getTime() + d * MIN), phase: 'isyraq', prayer: 'syuruk' });
    }
  }
  if (on(tw) && hijriMonth !== undefined && hijriMonth === num(tw?.hijriMonth, 9) && isyakEnd) {
    const m = num(tw?.minutes, 45);
    if (m > 0) {
      const start = new Date(isyakEnd.getTime() + num(tw?.gapMinutes, 10) * MIN);
      out.push({ start, end: new Date(start.getTime() + m * MIN), phase: 'tarawih', prayer: 'isyak' });
    }
  }
  return out;
}

export function buildDayIntervals(day: PrayerDay, settings: Settings, hijriMonth?: number): PhaseInterval[] {
  return buildStages(day, settings, hijriMonth).map(({ start, end, phase, prayer }) => ({ start, end, phase, prayer }));
}

function nextFrom(day: PrayerDay, settings: Settings, now: Date): KioskState['next'] {
  const tz = tzOf(settings);
  const fridayOn = klWeekday(day.date) === 5 && on(feat(settings, 'jumaat'));
  const list: Array<[SolatName | 'imsak' | 'syuruk', string]> = [
    ['imsak', day.times.imsak], ['subuh', day.times.subuh], ['syuruk', day.times.syuruk],
    [fridayOn ? 'jumaat' : 'zohor', day.times.zohor], ['asar', day.times.asar],
    ['maghrib', day.times.maghrib], ['isyak', day.times.isyak],
  ];
  for (const [name, t] of list) {
    const at = instantOf(day.date, t, tz);
    if (at.getTime() > now.getTime()) return { name, at };
  }
  return null;
}

/** A day is usable only if its times are in order and every time is a real HH:mm; never throws. */
function usable(day: PrayerDay | undefined): day is PrayerDay {
  if (!day) return false;
  try {
    if (checkPrayerDay(day) !== null) return false;
    for (const t of Object.values(day.times)) klInstant(day.date, t);
    return true;
  } catch {
    return false;
  }
}

/** The imsak beep is a time of the day, not a phase: set for three seconds from the imsak time when the feature is switched on. */
function imsakBeepNow(today: PrayerDay, settings: Settings, now: Date): boolean {
  if (feat(settings, 'imsakBeep')?.enabled !== true) return false;
  const at = instantOf(today.date, today.times.imsak, tzOf(settings)).getTime();
  const t = now.getTime();
  return at <= t && t < at + BEEP_WINDOW_MS;
}

/**
 * The first Subuh azan of a day: off by default; nothing without a chosen audio file. It starts `minutesBefore` minutes
 * before Subuh and must be silent again by `stopsAt`: the start of the Subuh azan countdown when that comes after the
 * first azan's start, else the Subuh time itself (the real azan). Exported so the tilawah window can end where it starts.
 */
export function firstAzanPlan(day: PrayerDay, settings: Settings): { audioFile: string; startsAt: Date; stopsAt: Date } | null {
  const f = feat(settings, 'firstAzanSubuh');
  if (f?.enabled !== true) return null;
  const file = f.audioFile;
  if (typeof file !== 'string' || !ASSET_ID.test(file)) return null;
  const m = num(f.minutesBefore, 10);
  if (m <= 0) return null;
  const subuh = instantOf(day.date, day.times.subuh, tzOf(settings)).getTime();
  const startsAt = subuh - m * MIN;
  let stopsAt = subuh;
  const az = feat(settings, 'azanCountdown');
  if (on(az)) {
    const before = (az as { minutesBefore?: Record<string, unknown> })?.minutesBefore;
    const cd = num(before?.subuh, 10);
    if (cd > 0 && subuh - cd * MIN > startsAt) stopsAt = subuh - cd * MIN;
  }
  return { audioFile: file, startsAt: new Date(startsAt), stopsAt: new Date(stopsAt) };
}

/** The first-azan start stays set for 30 s from its start (a one-second tick must see it; a late start never plays it). */
function firstAzanNow(today: PrayerDay, settings: Settings, now: Date): KioskState['firstAzan'] {
  const p = firstAzanPlan(today, settings);
  if (!p) return null;
  const t = now.getTime();
  return p.startsAt.getTime() <= t && t < p.startsAt.getTime() + FIRST_AZAN_WINDOW_MS ? p : null;
}

export function computeKioskState(now: Date, days: PrayerDay[], settings: Settings, hijriMonth?: number): KioskState {
  const date = dateOf(now, tzOf(settings));
  const isJumaat = klWeekday(date) === 5;
  const found = days.find((d) => d.date === date);
  const today = usable(found) ? found : null;
  if (!today) {
    return { phase: 'noData', prayer: null, phaseEndsAt: null, next: null, isJumaat, today: null, beep: null, firstAzan: null };
  }
  const y = days.find((d) => d.date === addDays(date, -1));
  const yesterday = usable(y) ? y : undefined;
  const tm = days.find((d) => d.date === addDays(date, 1));
  const tomorrow = usable(tm) ? tm : undefined;

  const stages = [
    ...(yesterday ? buildStages(yesterday, settings, hijriMonth) : []),
    ...buildStages(today, settings, hijriMonth),
  ];
  const t = now.getTime();
  let hit: Stage | null = null;
  for (const s of stages) {
    if (s.start.getTime() <= t && t < s.end.getTime() && (!hit || s.start.getTime() >= hit.start.getTime())) hit = s;
  }

  let next = nextFrom(today, settings, now);
  if (!next && tomorrow) next = nextFrom(tomorrow, settings, now);

  const firstAzan = firstAzanNow(today, settings, now);
  const imsak: KioskState['beep'] = imsakBeepNow(today, settings, now) ? 'imsak' : null;
  if (!hit) {
    return { phase: 'normal', prayer: null, phaseEndsAt: null, next, isJumaat, today, beep: imsak, firstAzan };
  }
  let beep: KioskState['beep'] = null;
  if (hit.beepAt && hit.beepKind) {
    const b = hit.beepAt.getTime();
    if (b <= t && t < b + BEEP_WINDOW_MS) beep = hit.beepKind;
  }
  return { phase: hit.phase, prayer: hit.prayer, phaseEndsAt: hit.end, next, isJumaat, today, beep: beep ?? imsak, firstAzan };
}
