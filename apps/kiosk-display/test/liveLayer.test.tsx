import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { instantOf } from '@surau/core';
import type { KioskState } from '@surau/core';
import { makeView } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';
import type { LiveView } from '../src/data/live.ts';

const holder = vi.hoisted(() => ({
  view: null as unknown as KioskView,
  live: null as unknown as LiveView,
  beeps: [] as Array<string | null>,
}));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...a: any[]) => any;
const whep = vi.hoisted(() => ({
  open: null as unknown as import('vitest').Mock<AnyFn>,
  close: null as unknown as import('vitest').Mock<AnyFn>,
}));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));
vi.mock('../src/data/live.ts', () => ({ useLive: () => holder.live }));
vi.mock('../src/data/whep.ts', () => ({ openWhep: (...a: unknown[]) => whep.open(...a) }));
vi.mock('../src/ui/Beep.ts', () => ({
  useBeep: (s: KioskState) => {
    holder.beeps.push(s.beep);
  },
}));

import { App } from '../src/app.tsx';

/** Renders and lets the video report its first picture: the live shows only once frames flow (2026-11-15). */
function renderLive(ui: Parameters<typeof render>[0]) {
  const r = render(ui);
  const video = r.container.querySelector('video');
  if (video) {
    act(() => {
      fireEvent(video, new Event('playing'));
    });
  }
  return r;
}

// Fixture day 2026-11-05 (Khamis): Asar 16:20 (azan countdown from 16:10, masuk waktu to 16:21, iqamah time
// 16:30, solat screen to 16:45), Maghrib 18:58. A Maghrib kuliah is on air.
const ON_AIR: LiveView = {
  live: true,
  since: '2026-11-05T07:40:00.000Z',
  kuliah: { label: 'Kuliah Maghrib', penceramah: 'Ustaz Ahmad Fauzi', topic: 'Bab Ikhlas dan Niat' },
  audio: false,
  volume: 50,
  playable: true,
};
const OFF_AIR: LiveView = { live: false, since: null, kuliah: null, audio: false, volume: 50, playable: true };
const LIVE_SETTINGS = { liveOnKiosk: { enabled: true } };
const NORMAL = () => makeView('2026-11-05', '15:50', { settings: LIVE_SETTINGS });
/** The view on the fixture day at hh:mm plus `sec` seconds. */
const AT = (hhmm: string, sec = 0) =>
  makeView('2026-11-05', hhmm, {
    settings: LIVE_SETTINGS,
    at: new Date(instantOf('2026-11-05', hhmm, 'Asia/Kuala_Lumpur').getTime() + sec * 1000),
  });

beforeEach(() => {
  whep.close = vi.fn(async () => {});
  whep.open = vi.fn(() => ({ close: whep.close, location: () => null }));
  holder.live = ON_AIR;
  holder.view = NORMAL();
  holder.beeps = [];
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

const stageOf = (r: ReturnType<typeof render>) => r.container.querySelector('.stage')!;
/** jsdom has no media pipeline: stand in for the intrinsic size the decoder would report. */
const setDims = (video: HTMLVideoElement, w: number, h: number): void => {
  Object.defineProperty(video, 'videoWidth', { configurable: true, get: () => w });
  Object.defineProperty(video, 'videoHeight', { configurable: true, get: () => h });
};

describe('the live screen (the live takes priority)', () => {
  it('shows the video, the kuliah strip, the clock and the next prayer chip; no prayer table, no cards', () => {
    const r = renderLive(<App />);
    expect(stageOf(r).getAttribute('data-phase')).toBe('normal');
    expect(stageOf(r).getAttribute('data-screen')).toBe('live');
    expect(stageOf(r).getAttribute('data-live')).toBe('clear');
    expect(r.container.querySelector('.screen--live[data-screen="live"]')).toBeTruthy();
    const video = r.getByTestId('live-video') as HTMLVideoElement;
    expect(video.tagName).toBe('VIDEO');
    const strip = r.getByTestId('live-strip');
    expect(strip.textContent).toContain('SIARAN LANGSUNG');
    expect(strip.textContent).toContain('Kuliah Maghrib');
    expect(strip.textContent).toContain('Ustaz Ahmad Fauzi');
    act(() => {
      fireEvent(video, new Event('playing'));
    });
    expect(r.getByTestId('live-strip').textContent).toContain('Bab Ikhlas dan Niat');
    expect(r.getByTestId('live-next').textContent).toMatch(/Asar.*4:20.*00:30/);
    expect(r.container.querySelector('[data-role="clock"]')).toBeTruthy();
    expect(r.container.querySelectorAll('[data-prayer]').length).toBe(0);
    expect(r.container.querySelector('.pbar')).toBeNull();
    expect(r.container.querySelector('[data-layer="content"]')).toBeNull();
    expect(r.queryByTestId('poster-strip')).toBeNull();
    expect(whep.open).toHaveBeenCalledTimes(1);
    expect(whep.open.mock.calls[0]![0]).toBe(video);
    expect(whep.open.mock.calls[0]![1]).toMatchObject({ audio: false, volume: 50 });
  });

  it('the video sits outside the live screen (owned by the app, above the phase switch), in clear mode', () => {
    const r = renderLive(<App />);
    const layer = r.container.querySelector('.live')!;
    expect(layer.parentElement!.classList.contains('stage')).toBe(true);
    expect(layer.classList.contains('live--clear')).toBe(true);
    expect(layer.getAttribute('data-mode')).toBe('clear');
    expect(r.container.querySelector('.screen--live')!.contains(layer)).toBe(false);
  });

  it('the live shows only once the video plays; before that the normal screen stays', () => {
    const r = render(<App />);
    const video = r.getByTestId('live-video');
    const layer = r.container.querySelector('.live')!;
    expect(layer.getAttribute('data-playing')).toBe('false');
    expect(stageOf(r).getAttribute('data-live')).toBe('none');
    expect(stageOf(r).getAttribute('data-screen')).not.toBe('live');
    expect(r.container.querySelector('.screen--live')).toBeNull();
    act(() => {
      fireEvent(video, new Event('playing'));
    });
    expect(layer.getAttribute('data-playing')).toBe('true');
    expect(stageOf(r).getAttribute('data-live')).toBe('clear');
    expect(r.container.querySelector('.screen--live')!.getAttribute('data-playing')).toBe('true');
    expect(r.getByTestId('live-strip').textContent).not.toContain('Siaran langsung sedang berjalan');
  });

  describe('frames stop and resume', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    it('while waiting the last picture and the live screen stay past stale frames; when waiting clears, stale frames drop it', () => {
      const r = render(<App />);
      const video = r.getByTestId('live-video');
      act(() => {
        fireEvent(video, new Event('playing'));
      });
      expect(stageOf(r).getAttribute('data-live')).toBe('clear');
      holder.live = { ...ON_AIR, waiting: true };
      r.rerender(<App />);
      act(() => {
        vi.advanceTimersByTime(30000);
      });
      expect(stageOf(r).getAttribute('data-live')).toBe('clear');
      expect(r.getByTestId('live-video')).toBe(video);
      expect(r.getByTestId('live-lost').textContent).toBe('Siaran akan bersambung sebentar lagi');
      holder.live = { ...ON_AIR, waiting: false };
      r.rerender(<App />);
      expect(stageOf(r).getAttribute('data-live')).toBe('none');
      expect(r.container.querySelector('[data-testid="live-lost"]')).toBeNull();
      expect(whep.open).toHaveBeenCalledTimes(1);
    });
    it('waiting without a picture that was ever on air does not take the screen', () => {
      holder.live = { ...ON_AIR, waiting: true };
      const r = render(<App />);
      expect(stageOf(r).getAttribute('data-live')).toBe('none');
    });
    it('live true with no frames: normal screen, beeps follow; frames: clear; 10 s of none: normal; resume: clear, same video', () => {
      const r = render(<App />);
      const video = r.getByTestId('live-video');
      expect(stageOf(r).getAttribute('data-live')).toBe('none');
      expect(r.container.querySelector('.screen--live')).toBeNull();
      act(() => {
        fireEvent(video, new Event('playing'));
      });
      expect(stageOf(r).getAttribute('data-live')).toBe('clear');
      expect(holder.beeps[holder.beeps.length - 1]).toBeNull();
      act(() => {
        vi.advanceTimersByTime(9000);
      });
      expect(stageOf(r).getAttribute('data-live')).toBe('clear');
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(stageOf(r).getAttribute('data-live')).toBe('none');
      expect(r.container.querySelector('.screen--live')).toBeNull();
      expect(r.getByTestId('live-video')).toBe(video);
      act(() => {
        fireEvent(video, new Event('timeupdate'));
      });
      expect(stageOf(r).getAttribute('data-live')).toBe('clear');
      expect(r.getByTestId('live-video')).toBe(video);
      expect(whep.open).toHaveBeenCalledTimes(1);
    });
  });

  it('a WHEP that cannot run at all (unsupported) leaves the normal screen, no video box', () => {
    whep.open = vi.fn((_v: unknown, opts: { onState?: (s: string) => void }) => {
      opts.onState?.('unsupported');
      return { close: whep.close, location: () => null };
    });
    const r = renderLive(<App />);
    expect(r.queryByTestId('live-video')).toBeNull();
    expect(stageOf(r).getAttribute('data-live')).toBe('none');
    expect(r.container.querySelector('.screen--live')).toBeNull();
  });
  it('a throwing openWhep is swallowed and the live screen survives', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    whep.open = vi.fn(() => {
      throw new Error('webrtc exploded');
    });
    const r = renderLive(<App />);
    expect(r.queryByTestId('safe-screen')).toBeNull();
    expect(r.queryByTestId('live-video')).toBeNull();
    expect(stageOf(r).getAttribute('data-live')).toBe('none');
    expect(r.container.querySelector('.screen--main')).toBeTruthy();
  });

  it('a strip that throws while rendering leaves the rest of the live screen untouched', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    holder.live = { ...ON_AIR, kuliah: { get label(): string { throw new Error('bad'); }, penceramah: 'x', topic: null } } as LiveView;
    const r = renderLive(<App />);
    expect(r.queryByTestId('safe-screen')).toBeNull();
    expect(r.getByTestId('live-next').textContent).toMatch(/Asar.*4:20.*00:30/);
    expect(r.container.querySelector('[data-role="clock"]')).toBeTruthy();
  });
});

describe('preview mode', () => {
  it('shows the strip and the waiting card, never the video', () => {
    window.history.replaceState(null, '', '/?preview=1');
    holder.live = { ...ON_AIR, playable: false };
    const r = renderLive(<App />);
    expect(r.queryByTestId('live-video')).toBeNull();
    const strip = r.getByTestId('live-strip');
    expect(strip.textContent).toContain('SIARAN LANGSUNG');
    expect(strip.textContent).toContain('Siaran langsung sedang berjalan');
    expect(r.getByTestId('live-waiting')).toBeTruthy();
    expect(whep.open).not.toHaveBeenCalled();
  });

  it('inside a prayer window shows the plain prayer screen (no video to blur)', () => {
    window.history.replaceState(null, '', '/?preview=1');
    holder.live = { ...ON_AIR, playable: false };
    holder.view = AT('16:19', 30);
    const r = renderLive(<App />);
    expect(stageOf(r).getAttribute('data-live')).toBe('blurred');
    expect(r.container.querySelector('.screen--phase')).toBeTruthy();
    expect(r.queryByTestId('live-video')).toBeNull();
    expect(r.queryByTestId('live-strip')).toBeNull();
  });
});
