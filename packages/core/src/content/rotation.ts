import { dateOf, instantOf, klDateOf, klInstant, klWeekday, offsetMinutes, tzOf } from '../time.ts';
import { DAY_KEYS } from '../features/registry.ts';
import type { FeatureSettings, Settings } from '../features/registry.ts';
import type { PrayerDay } from '../prayer/types.ts';
import { buildDayIntervals, firstAzanPlan } from '../kiosk/state.ts';
import type { PhaseInterval, SolatName } from '../kiosk/state.ts';
import { hadisPlan } from './hadisDisplay.ts';
import { TABUNG_SHOWING_MAX_PAGES, tabungFeatured, tabungPageCount, tabungPages } from './tabungPages.ts';
import type { KioskContent, KioskHadis, TilawahSlot } from './types.ts';
import { AFTER_PRAYERS, videoSlotSeconds } from './video.ts';
import type { AfterPrayer } from './video.ts';

export type SlotFeature =
  | 'kuliahCard' | 'pengumuman' | 'posters' | 'videos' | 'programKhas' | 'takwim'
  | 'hadis' | 'worldTimes' | 'tugasan' | 'ayatCard' | 'tabungCard';

export interface Slot {
  feature: SlotFeature;
  itemId: string | null;
  durationSeconds: number;
  /**
   * Part of a long hadis (0-based). On a tabung screen of more pages than one showing turns through: the showing number
   * (cycles since midnight), so each showing continues where the last stopped. Absent for every other slot.
   */
  page?: number;
}

const MIN = 60_000;
const SEC = 1_000;
const DAY_MS = 24 * 60 * MIN;
const DEFAULT_SECONDS = 15;
const FEATURES: readonly SlotFeature[] = [
  'kuliahCard', 'pengumuman', 'posters', 'videos', 'programKhas', 'takwim', 'hadis', 'worldTimes', 'tugasan', 'ayatCard', 'tabungCard',
];

type Raw = Partial<FeatureSettings> | undefined;
const feat = (s: Settings, k: string): Raw => (s as unknown as Record<string, Raw>)?.[k];
const on = (f: Raw): boolean => f?.enabled !== false;
const num = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb);

function addDays(date: string, n: number): string {
  return klDateOf(new Date(klInstant(date, '12:00').getTime() + n * DAY_MS));
}

/** Instant of a 'YYYY-MM-DDTHH:mm' wall-clock string in the surau's zone, or null when malformed. */
function dateTimeInstant(v: string, tz: string): Date | null {
  try {
    const [d, t] = v.split('T') as [string, string];
    return instantOf(d, t, tz);
  } catch {
    return null;
  }
}

/** A kuliah stays on the TV for this long after its start before the screen moves on to the next one. */
export const KULIAH_GRACE_MIN = 90;

const minutesOfDay = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (Number.isFinite(h) ? h! : 0) * 60 + (Number.isFinite(m) ? m! : 0);
};

/**
 * The last day of kuliah the TV shows: today plus Tetapan kuliahCard.daysAhead ("Hari ke hadapan"). 'YYYY-MM-DD'.
 */
export function kuliahLastDate(settings: Settings, today: string): string {
  const f = feat(settings, 'kuliahCard');
  return addDays(today, Math.max(0, Math.floor(num(f?.daysAhead, 7))));
}

/**
 * The kuliah that get a screen of their own, in the order they rotate: today's (still within its grace after the start)
 * or the nearest first, then every one after it up to kuliahLastDate. When none is left, today's latest one alone (the
 * screen holds it until the day ends). A cancelled kuliah keeps its place. Pure function of (list, settings, now).
 */
export function kuliahOnScreen<K extends { id: string; date: string; time: string }>(list: readonly K[], settings: Settings, now: Date): K[] {
  const tz = tzOf(settings);
  const today = dateOf(now, tz);
  const last = kuliahLastDate(settings, today);
  const wall = new Date(now.getTime() + offsetMinutes(now, tz) * MIN);
  const nowMin = wall.getUTCHours() * 60 + wall.getUTCMinutes();
  const window = list
    .filter((k) => k.date >= today && k.date <= last)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time) || a.id.localeCompare(b.id));
  const upcoming = window.filter((k) => k.date !== today || minutesOfDay(k.time) + KULIAH_GRACE_MIN > nowMin);
  if (upcoming.length > 0) return upcoming;
  const todays = window.filter((k) => k.date === today);
  return todays.length > 0 ? [todays[todays.length - 1]!] : [];
}

const HADIS_MARK = Symbol('hadis');
type Layout = Slot | typeof HADIS_MARK;

/** The hadis pool of the day. A snapshot cached by an older box has none: no hadis card until the next load. */
function hadisPoolOf(content: KioskContent): KioskHadis[] {
  return content.hadisToday ?? [];
}

const partsCache = new WeakMap<object, { key: string; parts: number }>();
/** Cards the hadis takes: 1, or the number of parts of a long one. Cached per item and display settings. */
function hadisPartCount(item: KioskHadis, settings: Settings): number {
  const hs = feat(settings, 'hadis');
  const key = `${hs?.showArabic !== false}|${String(hs?.fontSize ?? 'auto')}`;
  const hit = partsCache.get(item);
  if (hit && hit.key === key) return hit.parts;
  const plan = hadisPlan(item, { showArabic: hs?.showArabic !== false, fontSize: hs?.fontSize as 'auto' | 's' | 'm' | 'l' | undefined });
  const parts = plan.mode === 'parts' ? plan.parts.length : 1;
  partsCache.set(item, { key, parts });
  return parts;
}

/** One entry per visible item, features ordered by their `order` setting. Pure function of (content, settings, now). */
export function buildRotation(content: KioskContent, settings: Settings, now: Date): Slot[] {
  return buildCycle(content, settings, now).slots;
}

/**
 * The cycle showing at `now`: the other features' slots plus the hadis slots of this cycle (one hadis per cycle,
 * advancing every cycle; a long hadis takes one slot per part). `cycleStartSec` is the seconds-since-midnight (in the surau's zone, KL by default)
 * at which this cycle began, for `currentSlot`. Pure: the hadis schedule repeats with period T = n cycles.
 */
export function buildCycle(content: KioskContent, settings: Settings, now: Date): { slots: Slot[]; cycleStartSec: number } {
  const layout = buildLayout(content, settings, now);
  const pool = layout.includes(HADIS_MARK) ? hadisPoolOf(content) : [];
  const f = feat(settings, 'hadis');
  const rawDur = num(f?.durationSeconds, DEFAULT_SECONDS);
  const d = rawDur > 0 ? rawDur : DEFAULT_SECONDS;
  // `showing` numbers the cycles since midnight: a windowed tabung slot (page set) carries it.
  const expand = (item: KioskHadis | undefined, showing: number): Slot[] => {
    const out: Slot[] = [];
    for (const l of layout) {
      if (l !== HADIS_MARK) out.push(l.feature === 'tabungCard' && l.page !== undefined ? { ...l, page: showing } : l);
      else if (item) {
        const p = hadisPartCount(item, settings);
        for (let k = 0; k < p; k++) out.push({ feature: 'hadis', itemId: item.id, durationSeconds: d, ...(p > 1 ? { page: k } : {}) });
      }
    }
    return out;
  };
  const n = pool.length;
  const others = layout.reduce<number>((a, l) => (l === HADIS_MARK ? a : a + l.durationSeconds), 0);
  const tz = tzOf(settings);
  const midnight = instantOf(dateOf(now, tz), '00:00', tz).getTime();
  const sec = Math.floor((now.getTime() - midnight) / SEC);
  // No hadis: the cycle is the same every time and starts at midnight (currentSlot with cycleStartSec 0).
  if (n === 0) return { slots: expand(undefined, others > 0 ? Math.max(0, Math.floor(sec / others)) : 0), cycleStartSec: 0 };

  const lens = pool.map((item) => others + d * hadisPartCount(item, settings));
  const period = lens.reduce((a, b) => a + b, 0);
  const pos = ((sec % period) + period) % period;
  let start = 0;
  let j = 0;
  for (; j < n - 1; j++) {
    if (pos < start + lens[j]!) break;
    start += lens[j]!;
  }
  return { slots: expand(pool[j], Math.floor(sec / period) * n + j), cycleStartSec: sec - (pos - start) };
}

function buildLayout(content: KioskContent, settings: Settings, now: Date): Layout[] {
  const tz = tzOf(settings);
  const today = dateOf(now, tz);
  const dayKey = DAY_KEYS[klWeekday(today)] ?? 'ahad';
  const nowMs = now.getTime();

  const perFeature = (feature: SlotFeature): Layout[] => {
    const f = feat(settings, feature);
    if (!f || !on(f)) return [];
    const rawDur = num(f.durationSeconds, DEFAULT_SECONDS);
    const durationSeconds = rawDur > 0 ? rawDur : DEFAULT_SECONDS;
    const one = (itemId: string | null): Slot => ({ feature, itemId, durationSeconds });
    const many = (ids: string[]): Slot[] => ids.map((id) => one(id));
    if (feature === 'hadis') return hadisPoolOf(content).length > 0 ? [HADIS_MARK] : [];

    switch (feature) {
      // One screen per kuliah (theme round 2, rule 11). A cancelled (batal) kuliah/programKhas still takes its slot so
      // the card can show the DIBATALKAN ribbon.
      case 'kuliahCard':
        return many(kuliahOnScreen(content.kuliah, settings, now).map((k) => k.id));
      case 'pengumuman': {
        const max = Math.max(0, Math.floor(num(f.maxItems, 5)));
        const visible = content.pengumuman
          .filter((p) => p.from <= today && today <= p.to)
          // Segera (3) first, then Penting (2), then Biasa (1): the cut at `maxItems` drops the ordinary ones.
          .sort((a, b) => b.priority - a.priority || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
        return many(visible.slice(0, max).map((p) => p.id));
      }
      case 'posters': {
        const visible = content.posters
          .filter((p) => p.days.includes('umum') || p.days.includes(dayKey))
          .filter((p) => (p.from === undefined || p.from <= today) && (p.to === undefined || today <= p.to))
          .sort((a, b) => a.order - b.order);
        return many(visible.map((p) => p.id));
      }
      // A video's slot is as long as the video (capped at 10 minutes), not the feature's durationSeconds: it plays to the end.
      case 'videos': {
        const visible = (content.videos ?? [])
          .filter((v) => v.days.includes('umum') || v.days.includes(dayKey))
          .filter((v) => (v.from === undefined || v.from <= today) && (v.to === undefined || today <= v.to))
          // an item tied to a prayer (afterPrayer) is never in the rotation: videoAfterPrayerSlots plays it
          .filter((v) => v.afterPrayer === undefined)
          .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        return visible.map((v): Slot => ({ feature, itemId: v.id, durationSeconds: videoSlotSeconds(v) }));
      }
      case 'programKhas': {
        const hide = num(f.hideAfterMinutes, 5) * MIN;
        const visible = content.programKhas.filter((p) => {
          if (p.showFrom > today || today > p.showTo) return false;
          const at = dateTimeInstant(p.at, tz);
          return at !== null && nowMs < at.getTime() + hide;
        });
        return many(visible.map((p) => p.id));
      }
      case 'takwim':
        return content.takwim.some((t) => t.date >= today) && num(f.count, 3) > 0 ? [one(null)] : [];
      case 'worldTimes':
        return content.worldTimes.length > 0 ? [one(null)] : [];
      case 'tugasan': {
        const last = addDays(today, Math.max(0, num(f.daysAhead, 14)));
        return content.tugasan.some((t) => t.date >= today && t.date <= last) ? [one(null)] : [];
      }
      case 'ayatCard':
        return content.ayat.today ? [one(null)] : [];
      // durationSeconds is the time of one page: a screen of several pages (more than 4 funds, or the featured fund's
      // tiles, plus the summary page) takes that many times it. One page is the card's time as before.
      // At most TABUNG_SHOWING_MAX_PAGES pages a showing; a screen with more carries `page` (the showing number, set by
      // buildCycle), and the card shows the next run of pages each time (tabungWindowPage).
      case 'tabungCard': {
        const pages = tabungPageCount(content.tabung, settings);
        if (pages === 0) return [];
        const windowed = tabungPages(content.tabung, tabungFeatured(settings)).length > TABUNG_SHOWING_MAX_PAGES;
        return [{ feature, itemId: null, durationSeconds: durationSeconds * pages, ...(windowed ? { page: 0 } : {}) }];
      }
    }
  };

  const ordered = FEATURES.map((feature, i) => ({
    feature, i, order: num(feat(settings, feature)?.order, i + 1),
  })).sort((a, b) => a.order - b.order || a.i - b.i);

  const out: Layout[] = [];
  for (const o of ordered) out.push(...perFeature(o.feature));
  return out;
}

/**
 * Slot showing at `now`: position in the cycle = whole seconds since midnight in `tz` (KL by default), minus the cycle's start
 * (`cycleStartSec` from `buildCycle`, 0 when there is no hadis), mod cycle length. Pure.
 */
export function currentSlot(
  rotation: Slot[], now: Date, cycleStartSec = 0, tz: string = 'Asia/Kuala_Lumpur',
): { slot: Slot; index: number; startedAt: Date } | null {
  const slots = rotation.filter((s) => Number.isFinite(s.durationSeconds) && s.durationSeconds > 0);
  const cycle = slots.reduce((a, s) => a + s.durationSeconds, 0);
  if (slots.length === 0 || cycle <= 0) return null;
  const midnight = instantOf(dateOf(now, tz), '00:00', tz).getTime();
  const secs = Math.floor((now.getTime() - midnight) / SEC);
  const pos = (((secs - cycleStartSec) % cycle) + cycle) % cycle;
  let start = 0;
  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index]!;
    if (pos < start + slot.durationSeconds) {
      const startedAt = new Date(now.getTime() - (pos - start) * SEC - (now.getTime() - midnight - secs * SEC));
      return { slot, index, startedAt };
    }
    start += slot.durationSeconds;
  }
  return null;
}

function usableDay(days: PrayerDay[], date: string): PrayerDay | undefined {
  const d = days.find((x) => x.date === date);
  if (!d) return undefined;
  try {
    for (const t of Object.values(d.times)) klInstant(d.date, t);
    return d;
  } catch {
    return undefined;
  }
}

function intervalsAround(now: Date, days: PrayerDay[], settings: Settings, hijriMonth?: number): PhaseInterval[] {
  const date = dateOf(now, tzOf(settings));
  const out: PhaseInterval[] = [];
  for (const d of [usableDay(days, addDays(date, -1)), usableDay(days, date)]) {
    if (d) out.push(...buildDayIntervals(d, settings, hijriMonth));
  }
  return out;
}

/**
 * How long the zikir stretch after a prayer lasts, in seconds: every item once at `durationSeconds` each, cut at the
 * `minutesAfterSolat` ceiling (never wrapped). 0 = no zikir (feature off, no items, or a ceiling of 0 or less).
 * The ONE length the window, the kiosk overlay and the after-zikir video anchor all use.
 */
export function zikirSpanSeconds(itemCount: number, durationSeconds: unknown, minutesAfterSolat: unknown): number {
  const cap = num(minutesAfterSolat, 10) * 60;
  if (!(cap > 0) || !(itemCount > 0)) return 0;
  const d = num(durationSeconds, 20);
  const dur = d > 0 ? d : 20;
  return Math.min(itemCount * dur, cap);
}

/** The zikir span for the current settings, 0 when the feature is off. `itemCount` undefined = unknown: the full ceiling. */
function zikirSpanMs(settings: Settings, itemCount: number | undefined): number {
  const z = feat(settings, 'zikirSelepasSolat');
  if (!z || !on(z)) return 0;
  const mins = num(z.minutesAfterSolat, 10);
  if (mins <= 0) return 0;
  return itemCount === undefined ? mins * MIN : zikirSpanSeconds(itemCount, z.durationSeconds, mins) * SEC;
}

/** How long after the end of the solat phase the zikir starts (`startAfterMinutes`, 0 to 30; 0 when unset or invalid). */
export function zikirStartOffsetMs(settings: Settings): number {
  const z = feat(settings, 'zikirSelepasSolat');
  const m = num(z?.startAfterMinutes, 0);
  return m > 0 ? Math.min(m, 30) * MIN : 0;
}

/**
 * Zikir shows from `startAfterMinutes` after the end of a prayer's `solat` phase for `zikirSpanSeconds` (each item once,
 * at most `minutesAfterSolat`, counted from the zikir's own start), only while no prayer phase is running. `itemCount`
 * is the number of zikir items; left out, the window is the full `minutesAfterSolat` (the old behaviour).
 */
export function zikirWindow(
  now: Date, days: PrayerDay[], settings: Settings, hijriMonth?: number, itemCount?: number,
): { prayer: SolatName; startsAt: Date; endsAt: Date } | null {
  const span = zikirSpanMs(settings, itemCount);
  if (span <= 0) return null;
  const offset = zikirStartOffsetMs(settings);
  const t = now.getTime();
  const intervals = intervalsAround(now, days, settings, hijriMonth);
  if (intervals.some((i) => i.start.getTime() <= t && t < i.end.getTime())) return null;
  for (const i of intervals) {
    if (i.phase !== 'solat' || i.prayer === 'syuruk') continue;
    const start = i.end.getTime() + offset;
    // The window ends at its span or where the next prayer phase starts, whichever is first (F33: the time-left
    // countdown must not run past the moment the zikir leaves the screen).
    let end = start + span;
    for (const j of intervals) {
      const js = j.start.getTime();
      if (js > start && js < end) end = js;
    }
    if (start <= t && t < end) return { prayer: i.prayer, startsAt: new Date(start), endsAt: new Date(end) };
  }
  return null;
}

/**
 * F16: the instants the zikir after each of the day's prayers takes the screen (the solat end plus `startAfterMinutes`),
 * empty when the zikir would not show (feature off, a ceiling of 0, no items). A video must not start if it would be
 * cut there. `itemCount` undefined = unknown: counted as having items.
 */
export function zikirStarts(day: PrayerDay, settings: Settings, hijriMonth?: number, itemCount?: number): Date[] {
  if (zikirSpanMs(settings, itemCount) <= 0) return [];
  const offset = zikirStartOffsetMs(settings);
  return buildDayIntervals(day, settings, hijriMonth)
    .filter((i) => i.phase === 'solat' && i.prayer !== 'syuruk')
    .map((i) => new Date(i.end.getTime() + offset));
}

/** Tilawah plays from `prayer - minutesBefore` and stops at the prayer's azanCountdown start (or the prayer time). */
export function tilawahWindow(
  now: Date, days: PrayerDay[], settings: Settings, slots: TilawahSlot[], hijriMonth?: number,
): { slot: TilawahSlot; startsAt: Date; endsAt: Date } | null {
  const tl = feat(settings, 'tilawah');
  if (!tl || !on(tl)) return null;
  const tz = tzOf(settings);
  const date = dateOf(now, tz);
  const day = usableDay(days, date);
  if (!day) return null;
  const dayKey = DAY_KEYS[klWeekday(date)] ?? 'ahad';
  const t = now.getTime();
  const intervals = buildDayIntervals(day, settings, hijriMonth);
  // The first Subuh azan (an audio file) must never sound over a recitation: a Subuh slot ends when it starts.
  const firstAzan = firstAzanPlan(day, settings);

  for (const slot of slots) {
    if (!slot.enabled) continue;
    if (!slot.days.includes('daily') && !slot.days.includes(dayKey)) continue;
    const prayerTime = instantOf(date, day.times[slot.before], tz);
    const startsAt = new Date(prayerTime.getTime() - slot.minutesBefore * MIN);
    let endMs = prayerTime.getTime();
    for (const i of intervals) {
      if (i.phase === 'azanCountdown' && i.end.getTime() === prayerTime.getTime()) endMs = Math.min(endMs, i.start.getTime());
    }
    if (slot.before === 'subuh' && firstAzan) endMs = Math.min(endMs, firstAzan.startsAt.getTime());
    const endsAt = new Date(endMs);
    if (endsAt.getTime() <= startsAt.getTime()) continue;
    if (startsAt.getTime() <= t && t < endsAt.getTime()) return { slot, startsAt, endsAt };
  }
  return null;
}

/** One showing of a video tied to a prayer: it plays from `startsAt` for `durationSeconds`, once. */
export interface AfterPrayerSlot {
  itemId: string;
  prayer: AfterPrayer;
  startsAt: Date;
  durationSeconds: number;
}

/**
 * Where each video with `afterPrayer` plays today (2026.11.14). The anchor of a prayer is the end of its `solat`
 * phase (a Friday zohor is the Jumaat solat); with the zikir screen on for it (`zikirSelepasSolat` on, its minutes above
 * 0 and zikir items in the content) the video starts when the zikir screen ends (after its start offset and its span),
 * else right at the end of the solat
 * phase. A prayer with no solat phase falls back to the end of its last phase, or its own time. Videos of one prayer
 * follow each other in order. Each item appears once, so it plays once a day; it respects `days`, `from` and `to`, and
 * the videos feature. A showing that would start inside a prayer phase (the zikir screen cut short by the next prayer's
 * countdown, say) is left out. Whether it still fits before the next phase or recitation is the caller's room rule.
 */
export function videoAfterPrayerSlots(
  content: KioskContent, settings: Settings, now: Date, day: PrayerDay | null | undefined, hijriMonth?: number,
): AfterPrayerSlot[] {
  const vf = feat(settings, 'videos');
  if (!vf || !on(vf) || !day) return [];
  const tz = tzOf(settings);
  const today = dateOf(now, tz);
  if (day.date !== today) return [];
  const tied = (content.videos ?? []).filter((v) => v.afterPrayer !== undefined);
  if (tied.length === 0) return [];
  const dayKey = DAY_KEYS[klWeekday(today)] ?? 'ahad';
  const visible = tied
    .filter((v) => v.days.includes('umum') || v.days.includes(dayKey))
    .filter((v) => (v.from === undefined || v.from <= today) && (v.to === undefined || today <= v.to))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  if (visible.length === 0) return [];
  let intervals: PhaseInterval[];
  try {
    for (const t of Object.values(day.times)) klInstant(day.date, t);
    intervals = buildDayIntervals(day, settings, hijriMonth);
  } catch {
    return [];
  }
  const zikirMs = zikirSpanMs(settings, content.zikir.length);
  const out: AfterPrayerSlot[] = [];
  for (const prayer of AFTER_PRAYERS) {
    const mine = visible.filter((v) => v.afterPrayer === prayer);
    if (mine.length === 0) continue;
    const of = intervals.filter((i) => i.prayer === prayer || (prayer === 'zohor' && i.prayer === 'jumaat'));
    const solat = of.find((i) => i.phase === 'solat');
    let anchor: number;
    if (solat) {
      anchor = solat.end.getTime() + (zikirMs > 0 ? zikirStartOffsetMs(settings) + zikirMs : 0);
    } else {
      anchor = instantOf(today, day.times[prayer], tz).getTime();
      for (const i of of) if (i.phase !== 'tarawih') anchor = Math.max(anchor, i.end.getTime());
    }
    let at = anchor;
    for (const v of mine) {
      const durationSeconds = videoSlotSeconds(v);
      if (!intervals.some((i) => i.start.getTime() <= at && at < i.end.getTime())) {
        out.push({ itemId: v.id, prayer, startsAt: new Date(at), durationSeconds });
      }
      at += durationSeconds * SEC;
    }
  }
  return out;
}
