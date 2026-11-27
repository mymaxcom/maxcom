import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/preact';
import type { KioskContent, KioskVideo, TilawahSlot } from '@surau/core';
import { klInstant, zikirWindow } from '@surau/core';
import { days, makeView } from './helpers.tsx';
import { useContent } from '../src/data/content.ts';

/**
 * Videos tied to a prayer (afterPrayer, 2026.11.14): outside the rotation, played once a day right after the prayer's
 * zikir screen (after the solat phase when there is no zikir screen). 2026-11-03 is a Tuesday: Asar solat ends 16:45
 * (zikir 16:45 for 20 s per item, ceiling 10 minutes), Maghrib countdown 18:48. 2026-11-06 is a Friday.
 */
const DATE = '2026-11-03';
const FRI = '2026-11-06';

const off = { enabled: false };
const othersOff = {
  kuliahCard: off, pengumuman: off, posters: off, programKhas: off, takwim: off, hadis: off, worldTimes: off, tugasan: off, ayatCard: off,
};
const videoOn = { videos: { enabled: true, order: 11 }, tilawah: { enabled: false } };

const tied = (id: string, afterPrayer: KioskVideo['afterPrayer'], extra: Partial<KioskVideo> = {}): KioskVideo => ({
  id, updatedAt: '2026-11-01T10:30:00Z', updatedBy: 'test', title: id, source: 'youtube', youtubeId: 'lEN-CpMv4GI',
  durationSec: 120, days: ['umum'], order: 200, afterPrayer, ...extra,
});
const plain = (id: string, extra: Partial<KioskVideo> = {}): KioskVideo => ({
  id, updatedAt: '2026-11-01T10:30:00Z', updatedBy: 'test', title: id, source: 'youtube', youtubeId: 'lEN-CpMv4GI', durationSec: 60,
  days: ['umum'], order: 100, ...extra,
});
const ZIKIR = [{ id: 'z1', updatedAt: 'x', updatedBy: 't', title: 'Zikir', text: 'x', order: 1 }];

function content(videos: KioskVideo[], opts: { zikir?: boolean; zikirCount?: number; slots?: TilawahSlot[] } = {}): KioskContent {
  return {
    date: DATE, kuliah: [], pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [], hadisToday: [], worldTimes: [], tugasan: [],
    ayat: { today: null, tomorrow: null }, zikir: opts.zikir === false ? [] : (Array.from({ length: opts.zikirCount ?? 1 }, (_, i) => ({ ...ZIKIR[0]!, id: `z${i}`, order: i })) as unknown as KioskContent['zikir']),
    tilawah: { slots: opts.slots ?? [], available: { 36: { reciter: 'Husary_64kbps', reciterName: 'Husary', ayatCount: 83 } } },
    credits: { translation: '', font: '', audio: '' }, videos,
  };
}

afterEach(() => {
  cleanup();
  localStorage.removeItem('surau.content');
  localStorage.removeItem('surau.afterPrayerDone');
});

type Hook = ReturnType<typeof renderHook<ReturnType<typeof useContent>, ReturnType<typeof makeView>>>;

function open(c: KioskContent, date: string, settings: Record<string, object> = {}) {
  localStorage.setItem('surau.content', JSON.stringify({ content: c, fetchedAt: Date.now() }));
  const all = { ...othersOff, ...videoOn, ...settings };
  const viewAt = (hhmm: string, sec = 0) => {
    const v = makeView(date, hhmm, { settings: all });
    return { ...v, now: new Date(v.now.getTime() + sec * 1000) };
  };
  const hook: Hook = renderHook((v) => useContent(v), { initialProps: viewAt('06:00') });
  const shown = (hhmm: string, sec = 0): string | null => {
    hook.rerender(viewAt(hhmm, sec));
    return hook.result.current.current?.slot.itemId ?? null;
  };
  return { hook, shown, viewAt };
}

describe('a video with afterPrayer', () => {
  it('is not in the normal rotation (every other card off: nothing at any time but its own)', () => {
    const { shown } = open(content([tied('t', 'asar')]), DATE);
    for (const at of ['06:00', '10:00', '15:30', '16:30', '17:30', '18:30', '20:00', '21:00']) expect(shown(at)).toBeNull();
  });

  it('a video without it still rotates beside it', () => {
    const { shown } = open(content([plain('r'), tied('t', 'asar')]), DATE);
    expect(shown('10:00')).toBe('r');
    expect(shown('10:00', 90)).toBe('r');
  });

  it('plays right after the zikir screen of that prayer, for its own length, and not before or after', () => {
    const { shown } = open(content([tied('t', 'asar')]), DATE);
    // one zikir item x 20 s after the solat end (16:45): the zikir screen holds the stage until 16:45:20, not 10 minutes
    expect(shown('16:45', 19)).toBeNull();
    expect(shown('16:45', 20)).toBe('t');
    expect(shown('16:46', 19)).toBe('t');
    expect(shown('16:47', 20)).toBeNull(); // 120 s later: over
  });

  it('with the zikir off, plays right after the solat phase', () => {
    const { shown } = open(content([tied('t', 'asar')]), DATE, { zikirSelepasSolat: { enabled: false } });
    expect(shown('16:44', 59)).toBeNull();
    expect(shown('16:45')).toBe('t');
    expect(shown('16:46', 59)).toBe('t');
    expect(shown('16:47')).toBeNull();
  });

  it('the video starts at the solat end + the zikir length: 3 items x 20 s = 60 s, a long list is cut at the ceiling', () => {
    const three = open(content([tied('t', 'asar')], { zikirCount: 3 }), DATE);
    expect(three.shown('16:45', 59)).toBeNull();
    expect(three.shown('16:46')).toBe('t');
    cleanup();
    const long = open(content([tied('t', 'asar')], { zikirCount: 100 }), DATE);
    expect(long.shown('16:54', 59)).toBeNull();
    expect(long.shown('16:55')).toBe('t');
  });

  it('with the zikir on but no zikir items (no screen), plays right after the solat phase', () => {
    const { shown } = open(content([tied('t', 'asar')], { zikir: false }), DATE);
    expect(shown('16:45')).toBe('t');
  });

  it('Friday zohor means after Jumaat (and its zikir), not at the zohor time of the other days', () => {
    const end = zikirWindow(klInstant(FRI, '13:50'), days, makeView(FRI, '13:50').settings)!;
    expect(end.prayer).toBe('jumaat');
    const hhmm = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    const { shown } = open(content([tied('t', 'zohor')]), FRI);
    expect(shown('12:50')).toBeNull();
    expect(shown('13:26')).toBeNull(); // where an ordinary day's zohor ends
    expect(shown(hhmm(end.startsAt), 20)).toBe('t'); // the Jumaat solat end + 1 zikir x 20 s
  });

  it('is never shown during a prayer phase (countdown, iqamah, solat) and starts only when that prayer is over', () => {
    const { shown } = open(content([tied('t', 'asar', { durationSec: 600 }), tied('u', 'maghrib', { durationSec: 60 })]), DATE);
    expect(shown('18:49')).toBeNull(); // the countdown
    expect(shown('18:58', 30)).toBeNull(); // masuk waktu / iqamah
    expect(shown('19:09')).toBeNull(); // solat
    expect(shown('19:23', 19)).toBeNull(); // Maghrib solat ends 19:23, its one zikir item runs to 19:23:20
    expect(shown('19:23', 20)).toBe('u');
  });

  it('does not start when the next recitation or phase would cut it short', () => {
    // a recitation 60 minutes before... starts at 16:48: a 300 s video at 16:45:20 has 160 s, a 120 s one fits
    const slot: TilawahSlot = {
      id: 'ts', updatedAt: 'x', updatedBy: 't', days: ['daily'], before: 'maghrib', minutesBefore: 130, surah: 36, enabled: true,
    };
    const long = open(content([tied('t', 'asar', { durationSec: 300 })], { slots: [slot] }), DATE, { tilawah: { enabled: true } });
    expect(long.shown('16:45', 20)).toBeNull();
    expect(long.shown('16:45', 50)).toBeNull();
    cleanup();
    const short = open(content([tied('t', 'asar', { durationSec: 120 })], { slots: [slot] }), DATE, { tilawah: { enabled: true } });
    expect(short.shown('16:45', 20)).toBe('t');
  });

  it('respects days, from and to', () => {
    expect(open(content([tied('t', 'asar', { days: ['sabtu'] })]), DATE).shown('16:45', 20)).toBeNull();
    cleanup();
    expect(open(content([tied('t', 'asar', { days: ['selasa'] })]), DATE).shown('16:45', 20)).toBe('t');
    cleanup();
    expect(open(content([tied('t', 'asar', { from: '2026-11-04' })]), DATE).shown('16:45', 20)).toBeNull();
    cleanup();
    expect(open(content([tied('t', 'asar', { to: '2026-11-02' })]), DATE).shown('16:45', 20)).toBeNull();
    cleanup();
    expect(open(content([tied('t', 'asar', { from: DATE, to: DATE })]), DATE).shown('16:45', 20)).toBe('t');
  });

  it('plays once a day: after it ends or fails it does not come back, even on a reload of the page', () => {
    const c = content([tied('t', 'asar')]);
    const first = open(c, DATE);
    expect(first.shown('16:45', 20)).toBe('t');
    first.shown('16:45', 40);
    act(() => first.hook.result.current.skip!(first.hook.result.current.current!.startedAt));
    expect(first.shown('16:45', 41)).toBeNull();
    expect(first.shown('16:46')).toBeNull();
    expect(JSON.parse(localStorage.getItem('surau.afterPrayerDone') ?? '[]')).toEqual([`${DATE}|t`]);
    first.hook.unmount();
    // the page is reloaded within the same window: it is not shown again
    const again = open(c, DATE);
    expect(again.shown('16:46')).toBeNull();
    // yesterday's mark does not hold today
    cleanup();
    localStorage.setItem('surau.afterPrayerDone', JSON.stringify(['2026-11-02|t']));
    expect(open(c, DATE).shown('16:45', 20)).toBe('t');
  });

  it('while it plays its start stays fixed as the clock runs', () => {
    const { hook, shown } = open(content([tied('t', 'asar')]), DATE);
    shown('16:45', 20);
    const started = hook.result.current.current!.startedAt.getTime();
    shown('16:45', 60);
    expect(hook.result.current.current!.startedAt.getTime()).toBe(started);
    expect(hook.result.current.current!.slot).toMatchObject({ feature: 'videos', itemId: 't', durationSeconds: 120 });
  });
});
