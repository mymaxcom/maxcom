import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import type { KioskContent, KioskVideo, TilawahSlot } from '@surau/core';
import { VIDEO_LIMITS } from '@surau/core';
import { days, makeView } from './helpers.tsx';
import type { ViewOpts } from './helpers.tsx';
import { VideoScreen, VIDEO_STALL_MS, VIDEO_START_MS, YT_HANDSHAKE_TRIES } from '../src/screens/content/VideoScreen.tsx';
import type { CardProps } from '../src/content/ContentLayer.tsx';
import { videoRoomSeconds } from '../src/video/room.ts';
import { readPlayerMessage, youtubeEmbedUrl, YT_ORIGIN } from '../src/video/youtube.ts';
import { screenBodyFor } from '../src/screens/content/index.ts';
import { screenIdOf } from '../src/screens/screenId.ts';
import { tickerGivesWay } from '../src/screens/Main.tsx';

const ASSET = 'd'.repeat(64);
const base = { updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'test' };
const upload: KioskVideo = { ...base, id: 'v-up', title: 'Salam', source: 'upload', assetId: ASSET, days: ['umum'], order: 1, durationSec: 60 };
const yt: KioskVideo = { ...base, id: 'v-yt', title: 'Kuliah', source: 'youtube', youtubeId: 'dQw4w9WgXcQ', days: ['umum'], order: 2 };

function content(videos: KioskVideo[], slots: TilawahSlot[] = [], available: KioskContent['tilawah']['available'] = {}): KioskContent {
  return {
    date: '2026-11-06', kuliah: [], pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [], hadisToday: [], worldTimes: [], tugasan: [],
    ayat: { today: null, tomorrow: null }, zikir: [], tilawah: { slots, available }, credits: { translation: '', font: '', audio: '' }, videos,
  };
}

function props(id: string, c: KioskContent, opts: ViewOpts = {}, at = '12:00'): CardProps & { onFinished: ReturnType<typeof vi.fn>; onRendered: ReturnType<typeof vi.fn> } {
  const view = makeView('2026-11-06', at, opts);
  return { view, lang: 'ms', content: c, itemId: id, startedAt: view.now, durationSeconds: 60, onFinished: vi.fn(), onRendered: vi.fn() };
}

let play: ReturnType<typeof vi.spyOn>;
let pause: ReturnType<typeof vi.spyOn>;
let online: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(() => {
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  online = null;
  void play; void pause; void online;
});

const setOnline = (v: boolean) => {
  online = vi.spyOn(globalThis.navigator, 'onLine', 'get').mockReturnValue(v);
};

describe('VideoScreen: an uploaded file', () => {
  it('plays the box file, muted by default, inline and automatically', () => {
    const p = props('v-up', content([upload]));
    const { container } = render(<VideoScreen {...p} />);
    const v = container.querySelector('video')!;
    expect(v.getAttribute('src')).toBe(`/assets/${ASSET}`);
    expect(v.muted).toBe(true);
    expect(v.autoplay).toBe(true);
    expect(v.hasAttribute('playsinline')).toBe(true);
    expect(container.querySelector('[data-card="videos"]')?.getAttribute('data-sound')).toBe('off');
    expect(p.onRendered).toHaveBeenLastCalledWith(true);
    expect(p.onFinished).not.toHaveBeenCalled();
  });

  it('is unmuted only when the item says so', () => {
    const p = props('v-up', content([{ ...upload, sound: true }]));
    const { container } = render(<VideoScreen {...p} />);
    expect(container.querySelector('video')!.muted).toBe(false);
    expect(container.querySelector('[data-card="videos"]')?.getAttribute('data-sound')).toBe('on');
  });

  it('hands the screen on when the video ends', () => {
    const p = props('v-up', content([upload]));
    const { container } = render(<VideoScreen {...p} />);
    fireEvent.ended(container.querySelector('video')!);
    expect(p.onFinished).toHaveBeenCalledTimes(1);
  });

  it('hands the screen on at an error and drops the card', () => {
    const p = props('v-up', content([upload]));
    const { container } = render(<VideoScreen {...p} />);
    fireEvent.error(container.querySelector('video')!);
    expect(p.onFinished).toHaveBeenCalledTimes(1);
    expect(p.onRendered).toHaveBeenLastCalledWith(false);
    expect(container.querySelector('video')).toBeNull();
  });

  it('gives up after a stall of more than 10 seconds, but not when it keeps playing', () => {
    vi.useFakeTimers();
    const p = props('v-up', content([upload]));
    const { container } = render(<VideoScreen {...p} />);
    const v = container.querySelector('video')!;
    act(() => { vi.advanceTimersByTime(VIDEO_STALL_MS - 100); });
    expect(p.onFinished).not.toHaveBeenCalled();
    fireEvent.playing(v); // it started: the watch is off
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(p.onFinished).not.toHaveBeenCalled();
    fireEvent.waiting(v); // it stops to load, and stays so
    act(() => { vi.advanceTimersByTime(VIDEO_STALL_MS + 100); });
    expect(p.onFinished).toHaveBeenCalledTimes(1);
  });

  it.each(['waiting', 'stalled'] as const)('a %s event does not fail the video at once, only after the stall time', (name) => {
    vi.useFakeTimers();
    const p = props('v-up', content([upload]));
    const { container } = render(<VideoScreen {...p} />);
    const v = container.querySelector('video')!;
    fireEvent.playing(v);
    fireEvent[name](v);
    act(() => { vi.advanceTimersByTime(50); });
    expect(p.onFinished).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(VIDEO_STALL_MS - 1000); });
    expect(p.onFinished).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1100); });
    expect(p.onFinished).toHaveBeenCalledTimes(1);
  });

  it('playing after waiting cancels the stall watch', () => {
    vi.useFakeTimers();
    const p = props('v-up', content([upload]));
    const { container } = render(<VideoScreen {...p} />);
    const v = container.querySelector('video')!;
    fireEvent.playing(v);
    fireEvent.waiting(v);
    act(() => { vi.advanceTimersByTime(VIDEO_STALL_MS - 1000); });
    fireEvent.playing(v);
    act(() => { vi.advanceTimersByTime(VIDEO_STALL_MS * 3); });
    expect(p.onFinished).not.toHaveBeenCalled();
  });

  it('gives up on a file that never starts', () => {
    vi.useFakeTimers();
    const p = props('v-up', content([upload]));
    render(<VideoScreen {...p} />);
    act(() => { vi.advanceTimersByTime(VIDEO_STALL_MS + 100); });
    expect(p.onFinished).toHaveBeenCalledTimes(1);
  });

  it('stops at the 10-minute cap', () => {
    vi.useFakeTimers();
    const p = props('v-up', content([upload]));
    const { container } = render(<VideoScreen {...p} />);
    fireEvent.playing(container.querySelector('video')!);
    act(() => { vi.advanceTimersByTime(VIDEO_LIMITS.maxSeconds * 1000 - 1000); });
    expect(p.onFinished).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1500); });
    expect(p.onFinished).toHaveBeenCalledTimes(1);
  });

  it('shows nothing for an item that is gone, and for a bad asset id', () => {
    const gone = props('missing', content([upload]));
    expect(render(<VideoScreen {...gone} />).container.innerHTML).toBe('');
    const bad = props('v-up', content([{ ...upload, assetId: '../etc/passwd' }]));
    const r = render(<VideoScreen {...bad} />);
    expect(r.container.querySelector('video')).toBeNull();
    expect(bad.onFinished).toHaveBeenCalled();
  });

  it('is removed with its element stopped (not just paused) when it leaves', () => {
    const p = props('v-up', content([upload]));
    const r = render(<VideoScreen {...p} />);
    const v = r.container.querySelector('video')!;
    const stop = vi.spyOn(v, 'removeAttribute');
    act(() => r.unmount());
    expect(pause).toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith('src');
    expect(document.querySelector('video')).toBeNull();
  });
});

describe('VideoScreen: volume (videos.volume)', () => {
  const withVolume = (volume: number): ViewOpts => ({ settings: { videos: { volume } } });

  it('defaults to 40 and sets the file volume only as a level (sound still follows the item switch)', () => {
    const { container } = render(<VideoScreen {...props('v-up', content([{ ...upload, sound: true }]))} />);
    const v = container.querySelector('video')!;
    expect(v.muted).toBe(false);
    expect(v.volume).toBeCloseTo(0.4, 5);
  });

  it('sets the file volume from the setting, and follows a change', () => {
    const c = content([{ ...upload, sound: true }]);
    const { container, rerender } = render(<VideoScreen {...props('v-up', c, withVolume(75))} />);
    expect(container.querySelector('video')!.volume).toBeCloseTo(0.75, 5);
    rerender(<VideoScreen {...props('v-up', c, withVolume(10))} />);
    expect(container.querySelector('video')!.volume).toBeCloseTo(0.1, 5);
  });

  it('keeps a file without the item sound switch muted, whatever the volume', () => {
    const { container } = render(<VideoScreen {...props('v-up', content([upload]), withVolume(90))} />);
    expect(container.querySelector('video')!.muted).toBe(true);
  });

  const commands = (post: ReturnType<typeof vi.fn>) =>
    post.mock.calls.map((c) => JSON.parse(String(c[0])) as { event: string; func?: string; args?: unknown[] }).filter((m) => m.func === 'setVolume');
  const hear = (f: HTMLIFrameElement, info = 1) =>
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ event: 'onStateChange', info }), origin: YT_ORIGIN, source: f.contentWindow })); });

  it('sends setVolume to a YouTube player once it answers, and again when the setting changes', () => {
    setOnline(true);
    const c = content([{ ...yt, sound: true }]);
    const { container, rerender } = render(<VideoScreen {...props('v-yt', c, withVolume(55))} />);
    const f = container.querySelector('iframe')!;
    const post = vi.fn();
    Object.defineProperty(f, 'contentWindow', { value: { postMessage: post }, configurable: true });
    expect(commands(post)).toEqual([]);
    hear(f);
    expect(commands(post)).toEqual([{ event: 'command', func: 'setVolume', args: [55], id: 1, channel: 'widget' }]);
    hear(f);
    expect(commands(post)).toHaveLength(1);
    rerender(<VideoScreen {...props('v-yt', c, withVolume(20))} />);
    expect(commands(post).map((m) => m.args)).toEqual([[55], [20]]);
  });

  it('sends no volume to a YouTube item without sound', () => {
    setOnline(true);
    const { container } = render(<VideoScreen {...props('v-yt', content([yt]), withVolume(55))} />);
    const f = container.querySelector('iframe')!;
    const post = vi.fn();
    Object.defineProperty(f, 'contentWindow', { value: { postMessage: post }, configurable: true });
    hear(f);
    expect(commands(post)).toEqual([]);
  });
});

describe('VideoScreen: YouTube sound commands', () => {
  const withVolume = (volume: number): ViewOpts => ({ settings: { videos: { volume } } });
  const funcs = (post: ReturnType<typeof vi.fn>) =>
    post.mock.calls.map((c) => JSON.parse(String(c[0])) as { event: string; func?: string; args?: unknown[] })
      .filter((m) => m.event === 'command' && ['setVolume', 'unMute', 'mute'].includes(String(m.func)))
      .map((m) => (m.func === 'setVolume' ? `setVolume:${String(m.args?.[0])}` : String(m.func)));
  const setup = (item: KioskVideo, volume = 55) => {
    setOnline(true);
    const c = content([item]);
    const r = render(<VideoScreen {...props('v-yt', c, withVolume(volume))} />);
    const f = r.container.querySelector('iframe')!;
    const post = vi.fn();
    Object.defineProperty(f, 'contentWindow', { value: { postMessage: post }, configurable: true });
    const hear = (info = 1) =>
      act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ event: 'onStateChange', info }), origin: YT_ORIGIN, source: f.contentWindow })); });
    return { ...r, c, f, post, hear };
  };

  it('a sound-on item: setVolume first, then unMute, once the player answers', () => {
    const { post, hear } = setup({ ...yt, sound: true });
    expect(funcs(post)).toEqual([]);
    hear();
    expect(funcs(post)).toEqual(['setVolume:55', 'unMute']);
    hear();
    expect(funcs(post)).toEqual(['setVolume:55', 'unMute']);
  });

  it('a sound-off item stays muted and gets no unMute and no volume', () => {
    const { post, hear } = setup(yt);
    hear();
    expect(funcs(post)).toEqual([]);
  });

  it('switching the sound on while it plays posts the commands in order and does not reload the frame', () => {
    const { container, rerender, c, f, post, hear } = setup(yt);
    const src = f.getAttribute('src');
    hear();
    rerender(<VideoScreen {...props('v-yt', content([{ ...yt, sound: true }]), withVolume(55))} />);
    expect(container.querySelector('iframe')).toBe(f);
    expect(f.getAttribute('src')).toBe(src);
    expect(funcs(post)).toEqual(['setVolume:55', 'unMute']);
    rerender(<VideoScreen {...props('v-yt', c, withVolume(55))} />);
    expect(funcs(post)).toEqual(['setVolume:55', 'unMute', 'mute']);
    expect(f.getAttribute('src')).toBe(src);
  });

  it('a volume change while it plays sends setVolume only', () => {
    const { rerender, f, post, hear } = setup({ ...yt, sound: true });
    hear();
    rerender(<VideoScreen {...props('v-yt', content([{ ...yt, sound: true }]), withVolume(20))} />);
    expect(funcs(post)).toEqual(['setVolume:55', 'unMute', 'setVolume:20']);
    expect(f.isConnected).toBe(true);
  });

  it('the first answer uses the switch and level as they are then, not as they were when it mounted', () => {
    const { rerender, post, hear } = setup(yt, 30);
    rerender(<VideoScreen {...props('v-yt', content([{ ...yt, sound: true }]), withVolume(70))} />);
    expect(funcs(post)).toEqual([]); // not heard yet: nothing to command
    hear();
    expect(funcs(post)).toEqual(['setVolume:70', 'unMute']);
  });

  it('a real reload of the frame starts the handshake again and re-applies the sound to the new player', () => {
    vi.useFakeTimers();
    const { f, post, hear } = setup({ ...yt, sound: true });
    const listening = () => post.mock.calls.filter((c) => String(c[0]).includes('"listening"')).length;
    fireEvent.load(f);
    hear();
    expect(listening()).toBe(1);
    expect(funcs(post)).toEqual(['setVolume:55', 'unMute']);
    fireEvent.load(f); // the frame loaded again: a new player, muted, deaf to us
    expect(listening()).toBe(2);
    hear();
    expect(funcs(post)).toEqual(['setVolume:55', 'unMute', 'setVolume:55', 'unMute']);
  });

  it('a reloaded frame that never answers is given up (the watch starts again)', () => {
    vi.useFakeTimers();
    const p = props('v-yt', content([yt]));
    setOnline(true);
    const { container } = render(<VideoScreen {...p} />);
    const f = container.querySelector('iframe')!;
    fireEvent.load(f);
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ event: 'onStateChange', info: 1 }), origin: YT_ORIGIN, source: f.contentWindow })); });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(p.onFinished).not.toHaveBeenCalled();
    fireEvent.load(f);
    act(() => { vi.advanceTimersByTime(VIDEO_START_MS + 500); });
    expect(p.onFinished).toHaveBeenCalledTimes(1);
  });
});

describe('VideoScreen: YouTube', () => {
  it('frames only the nocookie player with autoplay, no controls and mute by default', () => {
    setOnline(true);
    const p = props('v-yt', content([yt]));
    const { container } = render(<VideoScreen {...p} />);
    const f = container.querySelector('iframe')!;
    const u = new URL(f.getAttribute('src')!);
    expect(u.origin).toBe(YT_ORIGIN);
    expect(u.pathname).toBe('/embed/dQw4w9WgXcQ');
    expect(u.searchParams.get('autoplay')).toBe('1');
    expect(u.searchParams.get('mute')).toBe('1');
    expect(u.searchParams.get('controls')).toBe('0');
    expect(u.searchParams.get('rel')).toBe('0');
    expect(u.searchParams.get('playsinline')).toBe('1');
    expect(u.searchParams.get('modestbranding')).toBe('1');
  });

  it('always starts muted, even when the item has sound (the sound is switched on by commands)', () => {
    setOnline(true);
    const { container } = render(<VideoScreen {...props('v-yt', content([{ ...yt, sound: true }]))} />);
    expect(new URL(container.querySelector('iframe')!.getAttribute('src')!).searchParams.get('mute')).toBe('1');
  });

  it('plays a recording clip between its start and end', () => {
    setOnline(true);
    const clip: KioskVideo = { ...yt, source: 'rakaman', startSec: 120, endSec: 420 };
    const u = new URL(render(<VideoScreen {...props('v-yt', content([clip]))} />).container.querySelector('iframe')!.getAttribute('src')!);
    expect([u.searchParams.get('start'), u.searchParams.get('end')]).toEqual(['120', '420']);
  });

  it('is skipped when there is no internet, with no frame at all', () => {
    setOnline(false);
    const p = props('v-yt', content([yt]));
    const { container } = render(<VideoScreen {...p} />);
    expect(container.querySelector('iframe')).toBeNull();
    expect(p.onFinished).toHaveBeenCalledTimes(1);
    expect(p.onRendered).toHaveBeenLastCalledWith(false);
  });

  it('hands the screen on when the player says it ended or failed, and removes the frame', () => {
    setOnline(true);
    const p = props('v-yt', content([yt]));
    const { container } = render(<VideoScreen {...p} />);
    const f = container.querySelector('iframe')!;
    const send = (data: unknown, origin = YT_ORIGIN) =>
      act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data), origin, source: f.contentWindow })); });
    send({ event: 'onStateChange', info: 1 });
    expect(p.onFinished).not.toHaveBeenCalled();
    send({ event: 'onStateChange', info: 0 }, 'https://evil.example');
    expect(p.onFinished).not.toHaveBeenCalled();
    send({ event: 'onStateChange', info: 0 });
    expect(p.onFinished).toHaveBeenCalledTimes(1);
  });

  it('a player error code (embedding refused, video gone) hands the screen on AT ONCE and removes the frame', () => {
    setOnline(true);
    vi.useFakeTimers();
    for (const code of [2, 5, 100, 101, 150]) {
      const p = props('v-yt', content([yt]));
      const { container, unmount } = render(<VideoScreen {...p} />);
      const f = container.querySelector('iframe')!;
      act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ event: 'onError', info: code }), origin: YT_ORIGIN, source: f.contentWindow })); });
      // no timer has run: the report is immediate, and the frame (with its error page) is gone
      expect(p.onFinished).toHaveBeenCalledTimes(1);
      expect(container.querySelector('iframe')).toBeNull();
      expect(p.onRendered).toHaveBeenLastCalledWith(false);
      unmount();
    }
  });

  it('the player that ended hands the screen on at once and its frame is removed', () => {
    setOnline(true);
    const p = props('v-yt', content([yt]));
    const { container } = render(<VideoScreen {...p} />);
    const f = container.querySelector('iframe')!;
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ event: 'onStateChange', info: 0 }), origin: YT_ORIGIN, source: f.contentWindow })); });
    expect(p.onFinished).toHaveBeenCalledTimes(1);
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('a page rule that blocks the player frame (CSP frame-src) gives the item up at once, not after the watchdog', () => {
    setOnline(true);
    vi.useFakeTimers();
    const p = props('v-yt', content([yt]));
    const { container } = render(<VideoScreen {...p} />);
    expect(container.querySelector('iframe')).not.toBeNull();
    const violation = (blocked: string, directive: string) => {
      const e = new Event('securitypolicyviolation') as Event & Record<string, unknown>;
      Object.assign(e, { blockedURI: blocked, effectiveDirective: directive });
      act(() => { document.dispatchEvent(e); });
    };
    // an unrelated block (an image, or another host's frame) does not touch the video
    violation('https://img.example/x.png', 'img-src');
    violation('https://other.example/embed', 'frame-src');
    expect(p.onFinished).not.toHaveBeenCalled();
    violation(`${YT_ORIGIN}/embed/dQw4w9WgXcQ?autoplay=1`, 'frame-src');
    expect(p.onFinished).toHaveBeenCalledTimes(1);
    expect(container.querySelector('iframe')).toBeNull();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(p.onFinished).toHaveBeenCalledTimes(1);
  });

  it('a new showing of the same item after a failure is tried afresh and can fail again at once', () => {
    setOnline(true);
    const p = props('v-yt', content([yt]));
    const { container, rerender } = render(<VideoScreen {...p} />);
    const err = () => act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ event: 'onError', info: 150 }), origin: YT_ORIGIN, source: container.querySelector('iframe')!.contentWindow })); });
    err();
    expect(p.onFinished).toHaveBeenCalledTimes(1);
    rerender(<VideoScreen {...p} startedAt={new Date(p.startedAt!.getTime() + 600_000)} />);
    expect(container.querySelector('iframe')).not.toBeNull();
    err();
    expect(p.onFinished).toHaveBeenCalledTimes(2);
  });

  it('gives up when the player keeps buffering for more than 10 seconds', () => {
    setOnline(true);
    vi.useFakeTimers();
    const p = props('v-yt', content([yt]));
    const { container } = render(<VideoScreen {...p} />);
    const f = container.querySelector('iframe')!;
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ event: 'onStateChange', info: 3 }), origin: YT_ORIGIN, source: f.contentWindow })); });
    act(() => { vi.advanceTimersByTime(VIDEO_STALL_MS + 100); });
    expect(p.onFinished).toHaveBeenCalledTimes(1);
  });

  it('gives up on a frame that loads but never answers (LAN up, internet down) within 16 seconds', () => {
    setOnline(true); // the browser still says online
    vi.useFakeTimers();
    const p = props('v-yt', content([yt]));
    const { container } = render(<VideoScreen {...p} />);
    fireEvent.load(container.querySelector('iframe')!);
    act(() => { vi.advanceTimersByTime(VIDEO_START_MS - 500); });
    expect(p.onFinished).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1500); });
    expect(p.onFinished).toHaveBeenCalledTimes(1);
    expect(p.onRendered).toHaveBeenLastCalledWith(false);
    expect(VIDEO_START_MS).toBeLessThan(16_000);
  });

  it('gives up on a frame that never even loads', () => {
    setOnline(true);
    vi.useFakeTimers();
    const p = props('v-yt', content([yt]));
    render(<VideoScreen {...p} />);
    act(() => { vi.advanceTimersByTime(16_000); });
    expect(p.onFinished).toHaveBeenCalledTimes(1);
  });

  it('keeps a frame that reaches the playing state, whatever the time', () => {
    setOnline(true);
    vi.useFakeTimers();
    const p = props('v-yt', content([yt]));
    const { container } = render(<VideoScreen {...p} />);
    const f = container.querySelector('iframe')!;
    fireEvent.load(f);
    act(() => { vi.advanceTimersByTime(5000); });
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ event: 'onStateChange', info: 1 }), origin: YT_ORIGIN, source: f.contentWindow })); });
    act(() => { vi.advanceTimersByTime(120_000); });
    expect(p.onFinished).not.toHaveBeenCalled();
  });

  it('repeats the listening handshake every second until the player answers, at most 10 times', () => {
    setOnline(true);
    vi.useFakeTimers();
    const p = props('v-yt', content([yt]));
    const { container } = render(<VideoScreen {...p} />);
    const f = container.querySelector('iframe')!;
    const post = vi.spyOn(f.contentWindow as Window, 'postMessage').mockImplementation(() => undefined);
    const listening = () => post.mock.calls.filter((c) => String(c[0]).includes('"listening"')).length;
    fireEvent.load(f);
    expect(listening()).toBe(1);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(listening()).toBe(4);
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ event: 'onStateChange', info: 3 }), origin: YT_ORIGIN, source: f.contentWindow })); });
    act(() => { vi.advanceTimersByTime(5000); });
    expect(listening()).toBe(4); // answered: no more tries
  });

  it('stops the handshake after 10 tries when nobody answers', () => {
    setOnline(true);
    vi.useFakeTimers();
    const p = props('v-yt', content([yt]));
    const { container } = render(<VideoScreen {...p} />);
    const f = container.querySelector('iframe')!;
    const post = vi.spyOn(f.contentWindow as Window, 'postMessage').mockImplementation(() => undefined);
    fireEvent.load(f);
    act(() => { vi.advanceTimersByTime(14_000); });
    expect(post.mock.calls.filter((c) => String(c[0]).includes('"listening"')).length).toBe(YT_HANDSHAKE_TRIES);
  });

  it('reads player messages', () => {
    expect(readPlayerMessage('{"event":"onStateChange","info":0}')).toEqual({ state: 0 });
    expect(readPlayerMessage({ event: 'infoDelivery', info: { playerState: 1 } })).toEqual({ state: 1 });
    expect(readPlayerMessage('{"event":"onError","info":150}')).toEqual({ error: true });
    expect(readPlayerMessage('nonsense')).toBeNull();
    expect(readPlayerMessage(42)).toBeNull();
  });

  it('builds the embed address only for a real id', () => {
    expect(youtubeEmbedUrl('dQw4w9WgXcQ', { muted: true })).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&mute=1');
    expect(youtubeEmbedUrl('../../x', { muted: true })).toBeNull();
    expect(youtubeEmbedUrl('short', { muted: true })).toBeNull();
  });
});

describe('never over a recitation or a prayer phase', () => {
  const tslot: TilawahSlot = { ...base, id: 'ts', days: ['jumaat'], before: 'subuh', minutesBefore: 15, surah: 18, enabled: true };
  const avail = { 18: { reciter: 'Husary_64kbps', reciterName: 'Husary', ayatCount: 110 } };
  const subuh = days.find((d) => d.date === '2026-11-06')!.times.subuh;
  const minus = (hhmm: string, m: number): string => {
    const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
    const t = hh * 60 + mm - m;
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };
  const opts: ViewOpts = { settings: { tilawah: { enabled: true } } };

  it('does not play, and says so, while a recitation is due', () => {
    const c = content([upload], [tslot], avail);
    const p = props('v-up', c, opts, minus(subuh, 13));
    const { container } = render(<VideoScreen {...p} />);
    expect(container.querySelector('video')).toBeNull();
    expect(p.onFinished).toHaveBeenCalled();
  });

  it('plays when no recitation is due', () => {
    const c = content([upload], [tslot], avail);
    const { container } = render(<VideoScreen {...props('v-up', c, opts, '12:00')} />);
    expect(container.querySelector('video')).not.toBeNull();
  });

  it('removes a playing video within a second of a recitation beginning (the clock ticks into the window)', () => {
    const c = content([upload], [tslot], avail);
    const before = props('v-up', c, opts, minus(subuh, 16));
    const r = render(<VideoScreen {...before} />);
    expect(r.container.querySelector('video')).not.toBeNull();
    const after = props('v-up', c, opts, minus(subuh, 13));
    r.rerender(<VideoScreen {...after} />);
    expect(r.container.querySelector('video')).toBeNull();
    expect(pause).toHaveBeenCalled();
  });

  it('the main screen exists only in the normal phase, so every prayer phase removes the video', () => {
    // azan countdown, iqamah and solat have their own screens, and none of them is the one that renders the rotation
    const t = days.find((d) => d.date === '2026-11-06')!.times;
    for (const at of [minus(t.zohor, 5), t.zohor, minus(t.asar, 2)]) {
      const view = makeView('2026-11-06', at);
      if (view.state.phase !== 'normal') expect(screenIdOf(view.state, false, 'videos')).not.toBe('video');
    }
    expect(screenIdOf(makeView('2026-11-06', '12:00').state, false, 'videos')).toBe('video');
    expect(screenIdOf(makeView('2026-11-06', '12:00').state, true, 'videos')).toBe('live');
  });
});

describe('wiring', () => {
  it('the video card has a body of its own and gives the ticker way', () => {
    expect(screenBodyFor('videos')).toBe(VideoScreen);
    expect(tickerGivesWay('videos', { content: null, rotation: [], current: null, zikir: null, override: null })).toBe(true);
  });
});

describe('videoRoomSeconds (a video that cannot finish is not started)', () => {
  const settings = makeView('2026-11-06', '12:00').settings;
  const day = days.find((d) => d.date === '2026-11-06')!;
  it('counts to the next prayer phase', () => {
    const v = makeView('2026-11-06', '12:00');
    const room = videoRoomSeconds(v.now, day, settings, [], undefined);
    expect(room).toBeGreaterThan(0);
    expect(room).toBeLessThan(6 * 3600);
  });
  it('is shorter with a recitation due before the prayer', () => {
    const v = makeView('2026-11-06', '12:00');
    const plain = videoRoomSeconds(v.now, day, settings, [], undefined);
    const slot: TilawahSlot = { ...base, id: 't', days: ['daily'], before: 'zohor', minutesBefore: 119, surah: 1, enabled: true };
    const withSlot = videoRoomSeconds(v.now, day, settings, [slot], undefined);
    expect(withSlot).toBeLessThanOrEqual(plain);
  });
  it('is unlimited with no prayer day', () => {
    expect(videoRoomSeconds(new Date(), null, settings, [])).toBe(Number.POSITIVE_INFINITY);
  });
});
