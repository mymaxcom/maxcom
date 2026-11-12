import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { makeView } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';
import type { LiveView } from '../src/data/live.ts';

const holder = vi.hoisted(() => ({
  view: null as unknown as KioskView,
  live: null as unknown as LiveView,
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

import { App } from '../src/app.tsx';

// Fixture day 2026-11-05 (Khamis): Asar 16:20, Maghrib 18:58. A Maghrib kuliah is on air.
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
const AZAN = () => makeView('2026-11-05', '16:12', { settings: LIVE_SETTINGS });

beforeEach(() => {
  whep.close = vi.fn(async () => {});
  whep.open = vi.fn(() => ({ close: whep.close, location: () => null }));
  holder.live = ON_AIR;
  holder.view = NORMAL();
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

describe('live layer in the normal phase', () => {
  it('shows the video and the kuliah strip, and keeps the countdown and the prayer bar', () => {
    const r = render(<App />);
    expect(stageOf(r).getAttribute('data-phase')).toBe('normal');
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
    expect(r.getByText('Asar dalam')).toBeTruthy();
    expect(r.container.querySelectorAll('[data-prayer]').length).toBe(7);
    expect(whep.open).toHaveBeenCalledTimes(1);
    expect(whep.open.mock.calls[0]![0]).toBe(video);
    expect(whep.open.mock.calls[0]![1]).toMatchObject({ audio: false, volume: 50 });
  });

  it('replaces the rotating cards (live wins over the rotation)', () => {
    const r = render(<App />);
    expect(r.container.querySelector('[data-layer="content"]')).toBeNull();
    expect(r.queryByTestId('poster-strip')).toBeNull();
  });

  it('the video stays hidden until it plays, then shows', () => {
    const r = render(<App />);
    const video = r.getByTestId('live-video');
    const layer = r.container.querySelector('.live')!;
    expect(layer.getAttribute('data-playing')).toBe('false');
    expect(r.getByTestId('live-strip').textContent).toContain('Siaran langsung sedang berjalan');
    act(() => {
      fireEvent(video, new Event('playing'));
    });
    expect(layer.getAttribute('data-playing')).toBe('true');
    expect(r.getByTestId('live-strip').textContent).not.toContain('Siaran langsung sedang berjalan');
  });

  it('a WHEP that cannot run at all (unsupported) leaves the strip on the normal background, no video box', () => {
    whep.open = vi.fn((_v: unknown, opts: { onState?: (s: string) => void }) => {
      opts.onState?.('unsupported');
      return { close: whep.close, location: () => null };
    });
    const r = render(<App />);
    expect(r.queryByTestId('live-video')).toBeNull();
    expect(r.getByTestId('live-strip').textContent).toContain('Siaran langsung sedang berjalan');
    expect(r.container.querySelectorAll('[data-prayer]').length).toBe(7);
  });

  it('no stream is not terminal: the video box stays mounted for the retries', () => {
    whep.open = vi.fn((_v: unknown, opts: { onState?: (s: string) => void }) => {
      opts.onState?.('nostream');
      return { close: whep.close, location: () => null };
    });
    const r = render(<App />);
    expect(r.queryByTestId('live-video')).not.toBeNull();
    expect(whep.open).toHaveBeenCalledTimes(1);
  });

  it('a change of the path field reconnects, and the video comes back after a give-up', () => {
    whep.open = vi.fn((_v: unknown, opts: { onState?: (s: string) => void }) => {
      opts.onState?.('unsupported');
      return { close: whep.close, location: () => null };
    });
    holder.live = { ...ON_AIR, path: 'surau' };
    const r = render(<App />);
    expect(r.queryByTestId('live-video')).toBeNull();
    whep.open = vi.fn(() => ({ close: whep.close, location: () => null }));
    holder.live = { ...ON_AIR, path: 'surau-kiosk' };
    r.rerender(<App />);
    expect(whep.close).toHaveBeenCalled();
    expect(whep.open).toHaveBeenCalledTimes(1);
    expect(r.queryByTestId('live-video')).not.toBeNull();
  });

  it('a volume change sets the video volume in place, with no new player', () => {
    const r = render(<App />);
    expect(whep.open).toHaveBeenCalledTimes(1);
    holder.live = { ...ON_AIR, volume: 20 };
    r.rerender(<App />);
    expect(whep.open).toHaveBeenCalledTimes(1);
    expect(whep.close).not.toHaveBeenCalled();
    expect((r.getByTestId('live-video') as HTMLVideoElement).volume).toBeCloseTo(0.2);
  });

  it('showStrip off hides the strip once the video plays', () => {
    holder.view = makeView('2026-11-05', '15:50', { settings: { liveOnKiosk: { enabled: true, showStrip: false } } });
    const r = render(<App />);
    act(() => {
      fireEvent(r.getByTestId('live-video'), new Event('playing'));
    });
    expect(r.queryByTestId('live-strip')).toBeNull();
  });

  it('uses the fit setting for the video', () => {
    holder.view = makeView('2026-11-05', '15:50', { settings: { liveOnKiosk: { enabled: true, fit: 'contain' } } });
    const r = render(<App />);
    expect(r.getByTestId('live-video').getAttribute('data-fit')).toBe('contain');
  });

  it('a portrait video (taller than wide) is shown whole: contain, whatever the fit setting', () => {
    const r = render(<App />);
    const video = r.getByTestId('live-video') as HTMLVideoElement;
    expect(video.getAttribute('data-fit')).toBe('cover');
    setDims(video, 720, 1280);
    act(() => {
      fireEvent(video, new Event('loadedmetadata'));
    });
    expect(video.getAttribute('data-fit')).toBe('contain');
    expect(video.getAttribute('data-orientation')).toBe('portrait');
  });

  it('a landscape video keeps the configured fit', () => {
    holder.view = makeView('2026-11-05', '15:50', { settings: { liveOnKiosk: { enabled: true, fit: 'cover' } } });
    const r = render(<App />);
    const video = r.getByTestId('live-video') as HTMLVideoElement;
    setDims(video, 1280, 720);
    act(() => {
      fireEvent(video, new Event('loadedmetadata'));
    });
    expect(video.getAttribute('data-fit')).toBe('cover');
    expect(video.getAttribute('data-orientation')).toBe('landscape');
  });

  it('a landscape video with the contain setting stays contain', () => {
    holder.view = makeView('2026-11-05', '15:50', { settings: { liveOnKiosk: { enabled: true, fit: 'contain' } } });
    const r = render(<App />);
    const video = r.getByTestId('live-video') as HTMLVideoElement;
    setDims(video, 1280, 720);
    act(() => {
      fireEvent(video, new Event('loadedmetadata'));
    });
    expect(video.getAttribute('data-fit')).toBe('contain');
  });

  it('a resize from landscape to portrait mid-live switches to contain at once, and back', () => {
    const r = render(<App />);
    const video = r.getByTestId('live-video') as HTMLVideoElement;
    setDims(video, 1280, 720);
    act(() => {
      fireEvent(video, new Event('loadedmetadata'));
    });
    expect(video.getAttribute('data-fit')).toBe('cover');
    setDims(video, 720, 1280);
    act(() => {
      fireEvent(video, new Event('resize'));
    });
    expect(video.getAttribute('data-fit')).toBe('contain');
    expect(video.getAttribute('data-orientation')).toBe('portrait');
    setDims(video, 1280, 720);
    act(() => {
      fireEvent(video, new Event('resize'));
    });
    expect(video.getAttribute('data-fit')).toBe('cover');
    expect(whep.open).toHaveBeenCalledTimes(1);
  });

  it('passes the audio and volume settings of the live', () => {
    holder.live = { ...ON_AIR, audio: true, volume: 70 };
    render(<App />);
    expect(whep.open.mock.calls[0]![1]).toMatchObject({ audio: true, volume: 70 });
  });

  it('a kuliah without a topic shows the label and the penceramah only', () => {
    holder.live = { ...ON_AIR, kuliah: { label: 'Kuliah Subuh', penceramah: 'Ustaz Ali', topic: null } };
    const r = render(<App />);
    const strip = r.getByTestId('live-strip');
    expect(strip.textContent).toContain('Kuliah Subuh');
    expect(strip.textContent).toContain('Ustaz Ali');
  });

  it('nothing live: no video, no strip, the cards rotate as before', () => {
    holder.live = OFF_AIR;
    const r = render(<App />);
    expect(r.queryByTestId('live-video')).toBeNull();
    expect(r.queryByTestId('live-strip')).toBeNull();
    expect(whep.open).not.toHaveBeenCalled();
  });

  it('marks the main screen live-mode (has-live) only while live, so the compact strip and the smaller clock apply', () => {
    const r = render(<App />);
    const screen = r.container.querySelector('.screen--main')!;
    expect(screen.classList.contains('has-live')).toBe(true);
    // The strip lives inside the live-mode screen, and the hero clock is still the same element.
    expect(screen.contains(r.getByTestId('live-strip'))).toBe(true);
    expect(screen.querySelector('.clock .clock__hm')).toBeTruthy();
    cleanup();
    holder.live = OFF_AIR;
    const off = render(<App />);
    expect(off.container.querySelector('.screen--main')!.classList.contains('has-live')).toBe(false);
  });
});

describe('the prayer layer wins', () => {
  it('inside the azan countdown there is no video (Phase rendered); back to normal the video is back', () => {
    const r = render(<App />);
    expect(r.getByTestId('live-video')).toBeTruthy();
    holder.view = AZAN();
    r.rerender(<App />);
    expect(stageOf(r).getAttribute('data-phase')).toBe('azanCountdown');
    expect(r.queryByTestId('live-video')).toBeNull();
    expect(r.queryByTestId('live-strip')).toBeNull();
    expect(r.getByText('Azan Asar dalam')).toBeTruthy();
    expect(whep.close).toHaveBeenCalledTimes(1);
    holder.view = NORMAL();
    r.rerender(<App />);
    expect(r.getByTestId('live-video')).toBeTruthy();
    expect(whep.open).toHaveBeenCalledTimes(2);
  });

  it('a throwing openWhep is swallowed and the prayer bar survives', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    whep.open = vi.fn(() => {
      throw new Error('webrtc exploded');
    });
    const r = render(<App />);
    expect(r.queryByTestId('safe-screen')).toBeNull();
    expect(r.container.querySelectorAll('[data-prayer]').length).toBe(7);
    expect(r.getByText('Asar dalam')).toBeTruthy();
    expect(r.queryByTestId('live-video')).toBeNull();
  });

  it('a live layer that throws while rendering leaves the prayer screen untouched', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    holder.live = { ...ON_AIR, kuliah: { get label(): string { throw new Error('bad'); }, penceramah: 'x', topic: null } } as LiveView;
    const r = render(<App />);
    expect(r.queryByTestId('safe-screen')).toBeNull();
    expect(r.container.querySelectorAll('[data-prayer]').length).toBe(7);
  });
});

describe('preview mode', () => {
  it('shows the strip and no video', () => {
    window.history.replaceState(null, '', '/?preview=1');
    holder.live = { ...ON_AIR, playable: false };
    const r = render(<App />);
    expect(r.queryByTestId('live-video')).toBeNull();
    const strip = r.getByTestId('live-strip');
    expect(strip.textContent).toContain('SIARAN LANGSUNG');
    expect(strip.textContent).toContain('Siaran langsung sedang berjalan');
    expect(whep.open).not.toHaveBeenCalled();
  });
});
