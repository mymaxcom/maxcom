import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/preact';
import type { KioskContent, KioskVideo } from '@surau/core';
import { makeView } from './helpers.tsx';
import { resetSharedStream } from '../src/data/bundle.ts';
import { useContent } from '../src/data/content.ts';

/**
 * "Main sekarang" (2026.11.14): the box says `play-now { itemId }` on its event stream and the TV shows that video item at
 * once, then goes back to the rotation. 2026-11-03 is a Tuesday; 10:00 is a quiet time (no prayer phase).
 */
const DATE = '2026-11-03';

class FakeES {
  static instances: FakeES[] = [];
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeES.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
  emit(type: string, data: string) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data } as MessageEvent);
  }
}

const off = { enabled: false };
const settings = {
  kuliahCard: off, pengumuman: off, posters: off, programKhas: off, takwim: off, hadis: off, worldTimes: off, tugasan: off, ayatCard: off,
  videos: { enabled: true, order: 11 }, tilawah: { enabled: false },
};
const vid = (id: string, extra: Partial<KioskVideo> = {}): KioskVideo => ({
  id, updatedAt: '2026-11-01T10:30:00Z', updatedBy: 'test', title: id, source: 'youtube', youtubeId: 'lEN-CpMv4GI',
  durationSec: 60, days: ['umum'], order: 100, ...extra,
});
const content = (videos: KioskVideo[]): KioskContent => ({
  date: DATE, kuliah: [], pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [], hadisToday: [], worldTimes: [], tugasan: [],
  ayat: { today: null, tomorrow: null }, zikir: [], tilawah: { slots: [], available: {} }, credits: { translation: '', font: '', audio: '' }, videos,
});

beforeEach(() => {
  FakeES.instances = [];
  resetSharedStream();
  (globalThis as { EventSource?: unknown }).EventSource = FakeES;
});
afterEach(() => {
  cleanup();
  resetSharedStream();
  delete (globalThis as { EventSource?: unknown }).EventSource;
  localStorage.removeItem('surau.content');
});

function open(videos: KioskVideo[]) {
  localStorage.setItem('surau.content', JSON.stringify({ content: content(videos), fetchedAt: Date.now() }));
  const viewAt = (hhmm: string, sec = 0) => {
    const v = makeView(DATE, hhmm, { settings });
    return { ...v, now: new Date(v.now.getTime() + sec * 1000) };
  };
  const hook = renderHook((v) => useContent(v), { initialProps: viewAt('10:00') });
  const at = (hhmm: string, sec = 0) => {
    hook.rerender(viewAt(hhmm, sec));
    return hook.result.current.current;
  };
  const press = (itemId: string) =>
    act(() => {
      for (const es of FakeES.instances) es.emit('play-now', JSON.stringify({ itemId }));
    });
  return { hook, at, press };
}

describe('play now on the TV', () => {
  it('shows the item at once, whatever the rotation was on, and says where it started', () => {
    const { at, press, hook } = open([vid('a', { order: 1 }), vid('b', { order: 2 }), vid('x', { order: 3, durationSec: 120 })]);
    expect(at('10:00')?.slot.itemId).toBe('a');
    press('x');
    const cur = hook.result.current.current;
    expect(cur?.slot).toMatchObject({ feature: 'videos', itemId: 'x', durationSeconds: 120 });
    expect(cur?.startedAt).toBeInstanceOf(Date);
  });

  it('a second press replaces the first', () => {
    const { press, hook } = open([vid('a', { order: 1 }), vid('x', { order: 2 }), vid('y', { order: 3 })]);
    press('x');
    expect(hook.result.current.current?.slot.itemId).toBe('x');
    press('y');
    expect(hook.result.current.current?.slot.itemId).toBe('y');
  });

  it('goes back to the rotation when the video ends (onFinished), at the place the rotation is in then', () => {
    const { at, press, hook } = open([vid('a', { order: 1 }), vid('b', { order: 2 }), vid('x', { order: 3 })]);
    const before = at('10:00', 70); // second slot of the cycle
    expect(before?.slot.itemId).toBe('b');
    press('x');
    const pn = hook.result.current.current!;
    expect(pn.slot.itemId).toBe('x');
    act(() => hook.result.current.skip?.(pn.startedAt));
    expect(hook.result.current.current?.slot.itemId).toBe('b');
    expect(hook.result.current.current?.index).toBe(before?.index);
  });

  it('goes back to the rotation when its own time is over (a video that never reports)', () => {
    // A fixed clock: the press instant (new Date() in the hook) and the view time are the same fixed moment, so the
    // rotation slot the TV falls back to does not depend on the time of day the test runs.
    const base = makeView(DATE, '10:00', { settings }).now;
    vi.useFakeTimers({ toFake: ['Date'], now: base });
    try {
      const { at, press, hook } = open([vid('a', { order: 1 }), vid('x', { order: 2, durationSec: 30 })]);
      at('10:00');
      press('x');
      expect(hook.result.current.current?.slot.itemId).toBe('x');
      // the TV's clock a little over 30 s on: the item is over
      expect(at('10:00', 31)?.slot.itemId).toBe('a');
    } finally {
      vi.useRealTimers();
    }
  });

  it('plays an afterPrayer item too (it is outside the rotation) and an item the TV does not have is dropped', () => {
    const { press, hook, at } = open([vid('a', { order: 1 }), vid('ap', { order: 2, afterPrayer: 'zohor' })]);
    expect(at('10:00')?.slot.itemId).toBe('a');
    press('ap');
    expect(hook.result.current.current?.slot.itemId).toBe('ap');
    act(() => hook.result.current.skip?.(hook.result.current.current!.startedAt));
    expect(hook.result.current.current?.slot.itemId).toBe('a');
    press('gone');
    expect(hook.result.current.current?.slot.itemId).toBe('a');
  });

  it('ignores a malformed event', () => {
    const { press, hook, at } = open([vid('a')]);
    at('10:00');
    act(() => {
      for (const es of FakeES.instances) es.emit('play-now', '{"nope":1}');
    });
    expect(hook.result.current.current?.slot.itemId).toBe('a');
    press('a');
    expect(hook.result.current.current?.slot.itemId).toBe('a');
  });
});
