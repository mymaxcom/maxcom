import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, render, waitFor } from '@testing-library/preact';
import type { KioskContent, TilawahSlot } from '@surau/core';
import { createTilawahPlayer, useTilawah } from '../src/audio/tilawah.ts';
import type { Player } from '../src/audio/tilawah.ts';
import type { KioskView } from '../src/data/kiosk.ts';
import { days, makeView } from './helpers.tsx';

const date = '2026-11-06'; // Friday
const subuh = days.find((d) => d.date === date)!.times.subuh;
const minus = (hhmm: string, m: number): string => {
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  const t = hh * 60 + mm - m;
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
};
const slot: TilawahSlot = {
  id: 'ts', updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'local',
  days: ['jumaat'], before: 'subuh', minutesBefore: 15, surah: 18, enabled: true,
};
const content = (available: KioskContent['tilawah']['available']): KioskContent => ({
  date, kuliah: [], pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [],
  hadisToday: [], worldTimes: [], tugasan: [], ayat: { today: null, tomorrow: null }, zikir: [],
  tilawah: { slots: [slot], available }, credits: { translation: '', font: '', audio: '' },
});
const avail = { 18: { reciter: 'Husary_64kbps', reciterName: 'Husary', ayatCount: 110 } };
// offset = minutes before subuh
const view = (offsetMin: number): KioskView =>
  makeView(date, minus(subuh, offsetMin), { settings: { tilawah: { enabled: true } } });

function fakePlayer() {
  return { start: vi.fn(), stop: vi.fn(), playing: () => false } satisfies Player;
}
interface P { view: KioskView; content: KioskContent | null; impl: Player }
function Probe(p: P) {
  useTilawah(p.view, p.content, p.impl);
  return null;
}
const el = (p: P) => h(Probe, p);

afterEach(() => cleanup());

describe('useTilawah', () => {
  it('starts once inside the window, stops once after it, no extra stop on unmount', async () => {
    const impl = fakePlayer();
    const c = content(avail);
    // window: subuh-15 .. subuh-10 (azanCountdown starts at subuh-10)
    const { rerender, unmount } = render(el({ view: view(16), content: c, impl }));
    expect(impl.start).not.toHaveBeenCalled();
    rerender(el({ view: view(15), content: c, impl }));
    rerender(el({ view: view(14), content: c, impl }));
    rerender(el({ view: view(13), content: c, impl }));
    expect(impl.start).toHaveBeenCalledTimes(1);
    expect(impl.start).toHaveBeenCalledWith('Husary_64kbps', 18, 110);
    expect(impl.stop).not.toHaveBeenCalled();
    rerender(el({ view: view(9), content: c, impl }));
    rerender(el({ view: view(5), content: c, impl }));
    expect(impl.stop).toHaveBeenCalledTimes(1);
    unmount();
    await new Promise((r) => setTimeout(r, 20));
    expect(impl.stop).toHaveBeenCalledTimes(1);
  });

  it('stops on unmount while playing', async () => {
    const impl = fakePlayer();
    const { unmount } = render(el({ view: view(13), content: content(avail), impl }));
    expect(impl.start).toHaveBeenCalledTimes(1);
    unmount();
    await waitFor(() => expect(impl.stop).toHaveBeenCalledTimes(1));
  });

  it('never starts when the surah is not cached', () => {
    const impl = fakePlayer();
    render(el({ view: view(13), content: content({}), impl }));
    expect(impl.start).not.toHaveBeenCalled();
  });

  it('never starts without content or with tilawah off', () => {
    const impl = fakePlayer();
    render(el({ view: view(13), content: null, impl }));
    const off = makeView(date, minus(subuh, 13));
    render(el({ view: off, content: content(avail), impl }));
    expect(impl.start).not.toHaveBeenCalled();
  });
});

describe('createTilawahPlayer', () => {
  class FakeAudio {
    static all: FakeAudio[] = [];
    src = '';
    volume = 1;
    preload = '';
    paused = false;
    listeners: Record<string, Array<() => void>> = {};
    constructor(src?: string) {
      if (src) this.src = src;
      FakeAudio.all.push(this);
    }
    addEventListener(n: string, f: () => void) { (this.listeners[n] ??= []).push(f); }
    removeEventListener() {}
    play() { return Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute() { this.src = ''; }
    load() {}
    fire(n: string) { (this.listeners[n] ?? []).forEach((f) => f()); }
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeAudio.all = [];
  });

  it('plays ayat in order with 3-digit names, preloads next, stops at the end', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const p = createTilawahPlayer({ base: '/islamic/audio', volume: 60 });
    p.start('Husary_64kbps', 18, 2);
    const main = FakeAudio.all[0]!;
    expect(main.src).toBe('/islamic/audio/Husary_64kbps/18/001.mp3');
    expect(main.volume).toBeCloseTo(0.6);
    expect(p.playing()).toBe(true);
    expect(FakeAudio.all.some((a) => a.src.endsWith('/002.mp3'))).toBe(true);
    main.fire('ended');
    expect(main.src).toBe('/islamic/audio/Husary_64kbps/18/002.mp3');
    main.fire('ended');
    expect(p.playing()).toBe(false);
  });

  it('stop() pauses playback', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const p = createTilawahPlayer({ base: '/islamic/audio', volume: 60 });
    p.start('r', 1, 3);
    p.stop();
    expect(p.playing()).toBe(false);
    expect(FakeAudio.all[0]!.paused).toBe(true);
  });

  it('skips one failed ayat and carries on', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = createTilawahPlayer({ base: '/islamic/audio', volume: 60 });
    p.start('r', 1, 4);
    const main = FakeAudio.all[0]!;
    main.fire('error');
    expect(p.playing()).toBe(true);
    expect(main.src).toBe('/islamic/audio/r/1/002.mp3');
    main.fire('ended'); // a good ayat resets the count
    main.fire('error'); // ayat 3 fails: skipped again
    expect(p.playing()).toBe(true);
    expect(main.src).toBe('/islamic/audio/r/1/004.mp3');
    main.fire('ended');
    expect(p.playing()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('two failed ayat in a row end playback silently and log once', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = createTilawahPlayer({ base: '/islamic/audio', volume: 60 });
    p.start('r', 1, 5);
    FakeAudio.all[0]!.fire('error');
    FakeAudio.all[0]!.fire('error');
    expect(p.playing()).toBe(false);
    p.start('r', 1, 5);
    FakeAudio.all[0]!.fire('error');
    FakeAudio.all[0]!.fire('error');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a failure on the last ayat ends playback', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = createTilawahPlayer({ base: '/islamic/audio', volume: 60 });
    p.start('r', 1, 1);
    FakeAudio.all[0]!.fire('error');
    expect(p.playing()).toBe(false);
    warn.mockRestore();
  });

  it('play() rejection (autoplay blocked) ends playback without throwing', async () => {
    class Rej extends FakeAudio {
      play() { return Promise.reject(new Error('NotAllowed')); }
    }
    vi.stubGlobal('Audio', Rej);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = createTilawahPlayer({ base: '/islamic/audio', volume: 60 });
    p.start('r', 1, 3);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(p.playing()).toBe(false);
    warn.mockRestore();
  });

  it('ignores bad arguments', () => {
    vi.stubGlobal('Audio', FakeAudio);
    const p = createTilawahPlayer({ base: '/islamic/audio', volume: 60 });
    p.start('../x', 1, 3);
    p.start('r', 0, 3);
    p.start('r', 1, 0);
    expect(p.playing()).toBe(false);
  });
});
