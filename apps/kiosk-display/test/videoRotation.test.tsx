import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, renderHook } from '@testing-library/preact';
import type { KioskContent, KioskVideo, TilawahSlot } from '@surau/core';
import { days, makeView } from './helpers.tsx';
import { useContent } from '../src/data/content.ts';
import { videoRoomSeconds } from '../src/video/room.ts';
import { Main } from '../src/screens/Main.tsx';

/**
 * A YouTube item on a box where every other rotation card is off, at the times it was reported missing on the TV
 * (17-20 minutes before Maghrib) and mid-afternoon: the rotation must show the video, and the main screen must not
 * be idle while it can play.
 */
const DATE = '2026-11-19';
const maghrib = days.find((d) => d.date === DATE)!.times.maghrib;
const minus = (hhmm: string, m: number): string => {
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  const t = hh * 60 + mm - m;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

const off = { enabled: false };
const othersOff = {
  kuliahCard: off, pengumuman: off, posters: off, programKhas: off, takwim: off, hadis: off, worldTimes: off, tugasan: off, ayatCard: off,
};
const videoOn = { videos: { enabled: true, order: 11 }, tilawah: { enabled: false } };

const video = (durationSec: number): KioskVideo => ({
  id: 'v-yt', updatedAt: '2026-11-19T10:30:00Z', updatedBy: 'test', title: 'Bacaan', source: 'youtube', youtubeId: 'lEN-CpMv4GI',
  durationSec, sound: true, days: ['umum'], order: 200,
});

// A recitation slot the surau keeps but does not use: the tilawah feature itself is switched off.
const unusedRecitation: TilawahSlot = {
  id: 'ts-maghrib', updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'test', days: ['daily'], before: 'maghrib', minutesBefore: 18, surah: 36, enabled: true,
};

function content(v: KioskVideo, slots: TilawahSlot[] = []): KioskContent {
  return {
    date: DATE, kuliah: [], pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [], hadisToday: [], worldTimes: [], tugasan: [],
    ayat: { today: null, tomorrow: null }, zikir: [], tilawah: { slots, available: { 36: { reciter: 'Husary_64kbps', reciterName: 'Husary', ayatCount: 83 } } },
    credits: { translation: '', font: '', audio: '' }, videos: [v],
  };
}

afterEach(() => {
  cleanup();
  localStorage.removeItem('surau.content');
});

/** Every second of `seconds` from `at`: what useContent puts on screen. */
function walk(c: KioskContent, at: string, seconds: number, settings: Record<string, object>): Array<string | null> {
  localStorage.setItem('surau.content', JSON.stringify({ content: c, fetchedAt: Date.now() }));
  const base = makeView(DATE, at, { settings });
  const view = (s: number) => ({ ...base, now: new Date(base.now.getTime() + s * 1000) });
  const hook = renderHook((v) => useContent(v), { initialProps: view(0) });
  const out: Array<string | null> = [];
  for (let s = 0; s < seconds; s++) {
    hook.rerender(view(s));
    out.push(hook.result.current.current?.slot.itemId ?? null);
  }
  hook.unmount();
  return out;
}

describe('a YouTube video with every other card off', () => {
  for (const [label, at] of [
    ['20 minutes before Maghrib', minus(maghrib, 20)],
    ['18 minutes before Maghrib', minus(maghrib, 18)],
    ['17 minutes before Maghrib', minus(maghrib, 17)],
    ['mid-afternoon', '15:30'],
  ] as const) {
    it(`is on screen every second for 3 minutes from ${label} (120 s item)`, () => {
      const shown = walk(content(video(120)), at, 180, { ...othersOff, ...videoOn });
      expect(shown.filter((x) => x !== 'v-yt')).toEqual([]);
    });

    it(`is on screen from ${label} although a recitation slot is kept while the tilawah feature is off`, () => {
      const shown = walk(content(video(120), [unusedRecitation]), at, 180, { ...othersOff, ...videoOn });
      expect(shown.filter((x) => x !== 'v-yt')).toEqual([]);
    });
  }

  it('the main screen is not idle while the video can play', async () => {
    localStorage.setItem('surau.content', JSON.stringify({ content: content(video(120), [unusedRecitation]), fetchedAt: Date.now() }));
    const base = makeView(DATE, minus(maghrib, 19), { settings: { ...othersOff, ...videoOn } });
    const r = render(<Main view={base} lang="ms" />);
    for (let s = 1; s <= 90; s++) {
      r.rerender(<Main view={{ ...base, now: new Date(base.now.getTime() + s * 1000) }} lang="ms" />);
      await act(async () => undefined);
      expect(r.container.querySelector('[data-idle]')?.getAttribute('data-idle')).toBe('false');
      expect(r.container.querySelector('iframe.video-frame')).not.toBeNull();
    }
  });

  it('a 300 s item that cannot finish before the azan countdown is held back (soft rule), a 120 s one is not', () => {
    // the countdown begins 10 minutes before Maghrib: a showing that starts 4 minutes before it has no room for 300 s
    expect(walk(content(video(300)), minus(maghrib, 14), 60, { ...othersOff, ...videoOn }).every((x) => x === null)).toBe(true);
    expect(walk(content(video(120)), minus(maghrib, 15), 60, { ...othersOff, ...videoOn }).every((x) => x === 'v-yt')).toBe(true);
  });
});

describe('videoRoomSeconds and the tilawah switch', () => {
  const day = days.find((d) => d.date === DATE)!;
  it('a recitation slot counts only while the tilawah feature is on', () => {
    const at = makeView(DATE, minus(maghrib, 20), { settings: { tilawah: { enabled: true } } });
    const offView = makeView(DATE, minus(maghrib, 20), { settings: { tilawah: { enabled: false } } });
    // on: the recitation starts 18 minutes before Maghrib, 2 minutes from now
    expect(videoRoomSeconds(at.now, day, at.settings, [unusedRecitation])).toBe(120);
    // off: nothing will recite, so the next thing is the azan countdown 10 minutes before Maghrib
    expect(videoRoomSeconds(offView.now, day, offView.settings, [unusedRecitation])).toBe(600);
    expect(videoRoomSeconds(offView.now, day, offView.settings, [])).toBe(600);
  });
});
