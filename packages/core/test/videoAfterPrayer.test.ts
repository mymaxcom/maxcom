import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  resolveSettings, validateContent, SERVER_FEATURES, klInstant, parseJakimCsv, videoAfterPrayerSlots, zikirWindow,
} from '../src/index.ts';
import type { KioskContent, KioskVideo } from '../src/index.ts';
import { buildRotation } from '../src/content/rotation.ts';

const ASSET = 'a'.repeat(64);
const good = { title: 'Salam', source: 'upload', assetId: ASSET, days: ['umum'], order: 1, durationSec: 90 };
const base = { updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'local' };

describe('afterPrayer schema (2026.11.14)', () => {
  it('accepts each prayer on every source and keeps the field', () => {
    for (const p of ['subuh', 'zohor', 'asar', 'maghrib', 'isyak']) {
      for (const body of [
        { ...good, afterPrayer: p },
        { title: 'Y', source: 'youtube', youtubeId: 'dQw4w9WgXcQ', days: ['umum'], order: 2, afterPrayer: p },
        { title: 'R', source: 'rakaman', youtubeId: 'dQw4w9WgXcQ', startSec: 10, endSec: 70, days: ['umum'], order: 3, afterPrayer: p },
      ]) {
        const r = validateContent('video', body);
        expect(r.ok).toBe(true);
        expect(r.ok && (r.value as { afterPrayer?: string }).afterPrayer).toBe(p);
      }
    }
  });
  it('leaves it absent when absent', () => {
    const r = validateContent('video', good);
    expect(r.ok && 'afterPrayer' in r.value).toBe(false);
  });
  it('refuses an unknown value, jumaat, an empty string and a non-string', () => {
    for (const bad of ['jumaat', 'dhuha', '', 'ZOHOR', 3, null, true, ['asar']]) {
      expect(validateContent('video', { ...good, afterPrayer: bad }).ok).toBe(false);
    }
  });
  it('is listed as a server feature so the app can hide the option on an older box', () => {
    expect(SERVER_FEATURES).toContain('videoAfterPrayer');
  });
});

describe('afterPrayer: out of the rotation, and where it plays', () => {
  const days = parseJakimCsv(readFileSync(fileURLToPath(new URL('./fixtures/SGR01-2026.csv', import.meta.url)), 'utf8'));
  const dayOf = (date: string) => days.find((d) => d.date === date)!;
  const v = (id: string, order: number, extra: Partial<KioskVideo> = {}): KioskVideo => ({
    ...base, id, title: id, source: 'upload', assetId: ASSET, days: ['umum'], order, durationSec: 60, ...extra,
  });
  const content = (videos: KioskVideo[], zikir: unknown[] = []): KioskContent => ({
    date: '2026-11-03', kuliah: [], pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [], hadisToday: [], worldTimes: [], tugasan: [],
    ayat: { today: null, tomorrow: null }, zikir: zikir as KioskContent['zikir'], tilawah: { slots: [], available: {} },
    credits: { translation: '', font: '', audio: '' }, videos,
  });
  const Z = [{ id: 'z1' }];
  const DATE = '2026-11-03'; // a Tuesday
  const hhmm = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const plan = (c: KioskContent, over: Record<string, object> = {}, date = DATE) =>
    videoAfterPrayerSlots(c, resolveSettings(over), klInstant(date, '06:00'), dayOf(date));

  it('an item with afterPrayer is not in the rotation; one without still is', () => {
    const slots = buildRotation(content([v('a', 1), v('t', 2, { afterPrayer: 'asar' })]), resolveSettings({}), klInstant(DATE, '10:00'));
    expect(slots.filter((s) => s.feature === 'videos').map((s) => s.itemId)).toEqual(['a']);
  });
  it('plays right after the solat phase when the zikir feature is off', () => {
    const [s] = plan(content([v('t', 1, { afterPrayer: 'asar' })], Z), { zikirSelepasSolat: { enabled: false } });
    expect(hhmm(s!.startsAt)).toBe('16:45'); // asar solat ends 16:45 on this day (see the zikirWindow test)
    expect(s).toMatchObject({ itemId: 't', prayer: 'asar', durationSeconds: 60 });
  });
  it('plays right after the zikir screen when the zikir feature is on and has items', () => {
    const [s] = plan(content([v('t', 1, { afterPrayer: 'asar' })], Z));
    expect(hhmm(s!.startsAt)).toBe('16:55'); // solat end 16:45 + 10 minutes of zikir
  });
  it('plays right after the solat phase when the zikir is on but has no screen (no items, or 0 minutes)', () => {
    expect(hhmm(plan(content([v('t', 1, { afterPrayer: 'asar' })], []))[0]!.startsAt)).toBe('16:45');
    expect(hhmm(plan(content([v('t', 1, { afterPrayer: 'asar' })], Z), { zikirSelepasSolat: { minutesAfterSolat: 0 } })[0]!.startsAt)).toBe('16:45');
    expect(hhmm(plan(content([v('t', 1, { afterPrayer: 'asar' })], Z), { zikirSelepasSolat: { minutesAfterSolat: 3 } })[0]!.startsAt)).toBe('16:48');
  });
  it('Friday zohor means after Jumaat (khutbah, iqamah and the Jumaat solat), then the zikir screen', () => {
    const fri = '2026-11-06';
    const win = zikirWindow(klInstant(fri, '13:50'), days, resolveSettings({}));
    expect(win?.prayer).toBe('jumaat');
    const [s] = plan(content([v('t', 1, { afterPrayer: 'zohor' })], Z), {}, fri);
    expect(s!.startsAt.getTime()).toBe(win!.endsAt.getTime());
    const [n] = plan(content([v('t', 1, { afterPrayer: 'zohor' })], Z), { zikirSelepasSolat: { enabled: false } }, fri);
    expect(n!.startsAt.getTime()).toBe(win!.endsAt.getTime() - 10 * 60_000);
    // an ordinary day's zohor is not that time
    expect(plan(content([v('t', 1, { afterPrayer: 'zohor' })], Z))[0]!.startsAt.getTime()).not.toBe(win!.endsAt.getTime());
  });
  it('each of the five prayers has its own start, in order', () => {
    const all = (['subuh', 'zohor', 'asar', 'maghrib', 'isyak'] as const).map((p, i) => v(p, i, { afterPrayer: p }));
    const slots = plan(content(all, Z));
    expect(slots.map((s) => s.prayer)).toEqual(['subuh', 'zohor', 'asar', 'maghrib', 'isyak']);
    for (let i = 1; i < slots.length; i++) expect(slots[i]!.startsAt.getTime()).toBeGreaterThan(slots[i - 1]!.startsAt.getTime());
  });
  it('respects days, from and to, and the videos switch', () => {
    const t = (extra: Partial<KioskVideo>) => content([v('t', 1, { afterPrayer: 'asar', ...extra })], Z);
    expect(plan(t({ days: ['sabtu'] }))).toHaveLength(0); // the date is a Tuesday
    expect(plan(t({ days: ['selasa'] }))).toHaveLength(1);
    expect(plan(t({ from: '2026-11-04' }))).toHaveLength(0);
    expect(plan(t({ to: '2026-11-02' }))).toHaveLength(0);
    expect(plan(t({ from: DATE, to: DATE }))).toHaveLength(1);
    expect(plan(t({}), { videos: { enabled: false } })).toHaveLength(0);
  });
  it('two videos of one prayer follow each other; the second never starts inside the first', () => {
    const [a, b] = plan(content([v('a', 1, { afterPrayer: 'asar', durationSec: 90 }), v('b', 2, { afterPrayer: 'asar', durationSec: 30 })], Z));
    expect(b!.startsAt.getTime()).toBe(a!.startsAt.getTime() + 90_000);
  });
  it('a showing that would start inside a prayer phase is left out (a long chain runs into the Maghrib countdown at 18:48)', () => {
    // 600 s each from 16:55: the 12th starts 18:45, the 13th would start 18:55, inside the countdown (18:48 to 18:58)
    const chain = Array.from({ length: 13 }, (_, k) => v(`c${k}`, k, { afterPrayer: 'asar', durationSec: 600 }));
    const slots = plan(content(chain, Z));
    expect(slots).toHaveLength(12);
    expect(hhmm(slots[11]!.startsAt)).toBe('18:45');
  });
  it('no day, another date, or no afterPrayer item gives nothing', () => {
    const c = content([v('t', 1, { afterPrayer: 'asar' })], Z);
    expect(videoAfterPrayerSlots(c, resolveSettings({}), klInstant(DATE, '06:00'), null)).toEqual([]);
    expect(videoAfterPrayerSlots(c, resolveSettings({}), klInstant('2026-11-04', '06:00'), dayOf(DATE))).toEqual([]);
    expect(plan(content([v('a', 1)], Z))).toEqual([]);
  });
});
