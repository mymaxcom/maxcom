import { dateOf, instantOf, klDateOf, klInstant, klWeekday, tzOf } from '../time.ts';
import { DAY_KEYS } from '../features/registry.ts';
import type { FeatureSettings, Settings } from '../features/registry.ts';
import type { PrayerDay } from '../prayer/types.ts';
import { buildDayIntervals } from '../kiosk/state.ts';
import type { PhaseInterval, SolatName } from '../kiosk/state.ts';
import { hadisPlan } from './hadisDisplay.ts';
import type { KioskContent, KioskHadis, TilawahSlot } from './types.ts';

export type SlotFeature =
  | 'kuliahCard' | 'pengumuman' | 'posters' | 'programKhas' | 'takwim'
  | 'hadis' | 'worldTimes' | 'tugasan' | 'ayatCard' | 'tabungCard';

export interface Slot {
  feature: SlotFeature;
  itemId: string | null;
  durationSeconds: number;
  /** Part of a long hadis (0-based); absent for every other slot. */
  page?: number;
}

const MIN = 60_000;
const SEC = 1_000;
const DAY_MS = 24 * 60 * MIN;
const DEFAULT_SECONDS = 15;
const FEATURES: readonly SlotFeature[] = [
  'kuliahCard', 'pengumuman', 'posters', 'programKhas', 'takwim', 'hadis', 'worldTimes', 'tugasan', 'ayatCard', 'tabungCard',
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
  const expand = (item: KioskHadis | undefined): Slot[] => {
    const out: Slot[] = [];
    for (const l of layout) {
      if (l !== HADIS_MARK) out.push(l);
      else if (item) {
        const p = hadisPartCount(item, settings);
        for (let k = 0; k < p; k++) out.push({ feature: 'hadis', itemId: item.id, durationSeconds: d, ...(p > 1 ? { page: k } : {}) });
      }
    }
    return out;
  };
  const n = pool.length;
  if (n === 0) return { slots: expand(undefined), cycleStartSec: 0 };

  const others = layout.reduce<number>((a, l) => (l === HADIS_MARK ? a : a + l.durationSeconds), 0);
  const lens = pool.map((item) => others + d * hadisPartCount(item, settings));
  const period = lens.reduce((a, b) => a + b, 0);
  const tz = tzOf(settings);
  const midnight = instantOf(dateOf(now, tz), '00:00', tz).getTime();
  const sec = Math.floor((now.getTime() - midnight) / SEC);
  const pos = ((sec % period) + period) % period;
  let start = 0;
  let j = 0;
  for (; j < n - 1; j++) {
    if (pos < start + lens[j]!) break;
    start += lens[j]!;
  }
  return { slots: expand(pool[j]), cycleStartSec: sec - (pos - start) };
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
      // A cancelled (batal) kuliah/programKhas still takes its slot so the card can show the DIBATALKAN ribbon.
      case 'kuliahCard': {
        const last = addDays(today, Math.max(0, num(f.daysAhead, 7)));
        const any = content.kuliah.some((k) => k.date >= today && k.date <= last);
        return any ? [one(null)] : [];
      }
      case 'pengumuman': {
        const max = Math.max(0, Math.floor(num(f.maxItems, 5)));
        const visible = content.pengumuman
          .filter((p) => p.from <= today && today <= p.to)
          .sort((a, b) => a.priority - b.priority || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
        return many(visible.slice(0, max).map((p) => p.id));
      }
      case 'posters': {
        const visible = content.posters
          .filter((p) => p.days.includes('umum') || p.days.includes(dayKey))
          .filter((p) => (p.from === undefined || p.from <= today) && (p.to === undefined || today <= p.to))
          .sort((a, b) => a.order - b.order);
        return many(visible.map((p) => p.id));
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
      case 'tabungCard':
        return content.tabung && content.tabung.rows.length > 0 ? [one(null)] : [];
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

/** Zikir shows from the end of a prayer's `solat` phase for `minutesAfterSolat`, only while no prayer phase is running. */
export function zikirWindow(
  now: Date, days: PrayerDay[], settings: Settings, hijriMonth?: number,
): { prayer: SolatName; endsAt: Date } | null {
  const z = feat(settings, 'zikirSelepasSolat');
  if (!z || !on(z)) return null;
  const mins = num(z.minutesAfterSolat, 10);
  if (mins <= 0) return null;
  const t = now.getTime();
  const intervals = intervalsAround(now, days, settings, hijriMonth);
  if (intervals.some((i) => i.start.getTime() <= t && t < i.end.getTime())) return null;
  for (const i of intervals) {
    if (i.phase !== 'solat' || i.prayer === 'syuruk') continue;
    const end = i.end.getTime();
    if (end <= t && t < end + mins * MIN) return { prayer: i.prayer, endsAt: new Date(end + mins * MIN) };
  }
  return null;
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

  for (const slot of slots) {
    if (!slot.enabled) continue;
    if (!slot.days.includes('daily') && !slot.days.includes(dayKey)) continue;
    const prayerTime = instantOf(date, day.times[slot.before], tz);
    const startsAt = new Date(prayerTime.getTime() - slot.minutesBefore * MIN);
    let endMs = prayerTime.getTime();
    for (const i of intervals) {
      if (i.phase === 'azanCountdown' && i.end.getTime() === prayerTime.getTime()) endMs = Math.min(endMs, i.start.getTime());
    }
    const endsAt = new Date(endMs);
    if (endsAt.getTime() <= startsAt.getTime()) continue;
    if (startsAt.getTime() <= t && t < endsAt.getTime()) return { slot, startsAt, endsAt };
  }
  return null;
}
