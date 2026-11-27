import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import type { KioskContent, KioskVideo } from '@surau/core';
import { makeView } from './helpers.tsx';
import { VideoScreen } from '../src/screens/content/VideoScreen.tsx';
import type { CardProps } from '../src/content/ContentLayer.tsx';
import { LiveDecoderContext, liveMaxHeight } from '../src/video/decoder.ts';

/**
 * O31 (2026.11.15): TV live memory on weak boxes. One video decoder at a time on the page: while the live player is
 * mounted (connecting, playing, or waiting for frames) a rotation video never starts its own <video> or YouTube frame,
 * it hands the slot on. A display that says it has little memory asks the box for a 720-line live picture.
 */
const ASSET = 'd'.repeat(64);
const base = { updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'test' };
const upload: KioskVideo = { ...base, id: 'v-up', title: 'Salam', source: 'upload', assetId: ASSET, days: ['umum'], order: 1, durationSec: 60 };
const yt: KioskVideo = { ...base, id: 'v-yt', title: 'Kuliah', source: 'youtube', youtubeId: 'dQw4w9WgXcQ', days: ['umum'], order: 2 };
const content: KioskContent = {
  date: '2026-11-06', kuliah: [], pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [], hadisToday: [], worldTimes: [], tugasan: [],
  ayat: { today: null, tomorrow: null }, zikir: [], tilawah: { slots: [], available: {} }, credits: { translation: '', font: '', audio: '' }, videos: [upload, yt],
};

function props(id: string): CardProps {
  const view = makeView('2026-11-06', '12:00');
  return { view, lang: 'ms', content, itemId: id, startedAt: view.now, durationSeconds: 60, onFinished: vi.fn() as () => void, onRendered: vi.fn() as (r: boolean) => void };
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('one video decoder at a time', () => {
  it('no live player: the rotation video plays as before', () => {
    const p = props('v-up');
    const r = render(<VideoScreen {...p} />);
    expect(r.container.querySelector('video')).toBeTruthy();
    expect(p.onFinished).not.toHaveBeenCalled();
  });

  it('while the live player holds the decoder, an uploaded video opens no <video> and hands the slot on', () => {
    const p = props('v-up');
    const r = render(
      <LiveDecoderContext.Provider value={true}>
        <VideoScreen {...p} />
      </LiveDecoderContext.Provider>,
    );
    expect(r.container.querySelector('video')).toBeNull();
    expect(p.onFinished).toHaveBeenCalledTimes(1);
  });

  it('the same for a YouTube item: no frame is put up', () => {
    const p = props('v-yt');
    const r = render(
      <LiveDecoderContext.Provider value={true}>
        <VideoScreen {...p} />
      </LiveDecoderContext.Provider>,
    );
    expect(r.container.querySelector('iframe')).toBeNull();
    expect(p.onFinished).toHaveBeenCalledTimes(1);
  });

  it('a video already playing when the live comes is stopped (its element removed)', () => {
    const p = props('v-up');
    const r = render(
      <LiveDecoderContext.Provider value={false}>
        <VideoScreen {...p} />
      </LiveDecoderContext.Provider>,
    );
    expect(r.container.querySelector('video')).toBeTruthy();
    r.rerender(
      <LiveDecoderContext.Provider value={true}>
        <VideoScreen {...p} />
      </LiveDecoderContext.Provider>,
    );
    expect(r.container.querySelector('video')).toBeNull();
    expect(p.onFinished).toHaveBeenCalledTimes(1);
  });
});

describe('live height for a display with little memory', () => {
  it('2 GB or less asks for 720 lines; more, or unknown, asks for nothing', () => {
    expect(liveMaxHeight({ deviceMemory: 2 })).toBe(720);
    expect(liveMaxHeight({ deviceMemory: 1 })).toBe(720);
    expect(liveMaxHeight({ deviceMemory: 0.5 })).toBe(720);
    expect(liveMaxHeight({ deviceMemory: 4 })).toBeUndefined();
    expect(liveMaxHeight({ deviceMemory: 8 })).toBeUndefined();
    expect(liveMaxHeight({})).toBeUndefined();
    expect(liveMaxHeight({ deviceMemory: Number.NaN })).toBeUndefined();
    expect(liveMaxHeight({ deviceMemory: 0 })).toBeUndefined();
    expect(liveMaxHeight(undefined)).toBeUndefined();
  });
});
