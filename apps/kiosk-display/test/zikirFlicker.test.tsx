import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/preact';
import type { KioskContent } from '@surau/core';
import { makeView } from './helpers.tsx';
import type { ViewOpts } from './helpers.tsx';
import { Main } from '../src/screens/Main.tsx';

/**
 * F32 (O11): the zikir flicker. The zikir screen was first put into the page while Main still had its normal layout
 * (the idle header, or the band of a card, with the content band closed); Main only switched to the zikir layout one
 * render later, when ContentRegion's layout effect reported the zikir. The zikir text measured its fit in the wrong
 * (closed) box and shrank to the smallest size or split into pages, and the stage changed layout around it: on the TV
 * the zikir showed small or cut for a frame, then jumped to its real size when the box was measured again. It happens
 * every time the zikir arrives in a mounted Main: content that arrives after the clock is already inside the window, a
 * delayed zikir start (startAfterMinutes) taking over from a card, and the mount after the solat.
 * The rule tested here: when the zikir enters the page, the stage around it is already the zikir layout.
 */
const base = { updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'test' };
const content: KioskContent = {
  date: '2026-11-03',
  kuliah: [{
    ...base, id: 'k1', date: '2026-11-03', slot: 'maghrib', time: '19:15', label: 'Kuliah Maghrib',
    penceramahId: 'p1', status: 'aktif', penceramah: { name: 'Ustaz Abu Bakar Ahmad' },
  }] as never,
  pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [],
  hadisToday: [], worldTimes: [], tugasan: [], ayat: { today: null, tomorrow: null },
  zikir: [1, 2, 3].map((i) => ({ ...base, id: `z${i}`, order: i, textAr: 'سُبْحَانَ اللهِ', textMs: 'Maha Suci Allah' })) as never,
  tilawah: { slots: [], available: {} }, credits: { translation: '', font: '', audio: '' },
};

afterEach(() => {
  cleanup();
  localStorage.removeItem('surau.content');
  vi.unstubAllGlobals();
});

/**
 * Watches the page and tells, for the moment the zikir layer was inserted, the class and data-idle the screen had
 * then (read back from the attribute changes that came after it).
 */
function watch(container: Element) {
  const records: MutationRecord[] = [];
  const mo = new MutationObserver((rs) => records.push(...rs));
  mo.observe(container, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'data-idle'] });
  return {
    stageAtZikirEntry(): { cls: string; idle: string } | null {
      records.push(...mo.takeRecords());
      const screen = container.querySelector('.screen') as HTMLElement;
      const at = records.findIndex((r) => [...r.addedNodes].some((n) => n instanceof Element && (n.matches('[data-layer="zikir"]') || n.querySelector('[data-layer="zikir"]'))));
      if (at < 0) return null;
      // the value an attribute had at the insert is the old value of its first change after it (else its value now)
      const later = (name: string) => records.slice(at + 1).find((r) => r.target === screen && r.attributeName === name)?.oldValue;
      return { cls: later('class') ?? screen.className, idle: later('data-idle') ?? screen.getAttribute('data-idle') ?? '' };
    },
    stop: () => mo.disconnect(),
  };
}

const tick = (r: ReturnType<typeof render>, hhmm: string, opts: ViewOpts = {}) => r.rerender(<Main view={makeView('2026-11-03', hhmm, opts)} lang="ms" />);

describe('F32: the zikir enters an already zikir-shaped stage', () => {
  it('content that arrives after the clock is inside the window', async () => {
    let resolve!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => { resolve = res; })));
    const r = render(<Main view={makeView('2026-11-03', '16:45:00')} lang="ms" />);
    const w = watch(r.container);
    tick(r, '16:45:01');
    expect(r.container.querySelector('[data-layer="zikir"]')).toBeNull();
    await act(async () => {
      resolve(new Response(JSON.stringify({ content }), { status: 200 }));
      await new Promise((x) => setTimeout(x, 0));
    });
    expect(r.container.querySelector('[data-layer="zikir"]')).toBeTruthy();
    const stage = w.stageAtZikirEntry();
    w.stop();
    expect(stage).not.toBeNull();
    expect(stage!.cls).toContain('screen--shell');
    expect(stage!.idle).toBe('false');
  });

  it('a delayed zikir start takes over from the card on screen', async () => {
    localStorage.setItem('surau.content', JSON.stringify({ content, fetchedAt: Date.now() }));
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    const opts = { settings: { zikirSelepasSolat: { startAfterMinutes: 5 } } };
    const r = render(<Main view={makeView('2026-11-03', '16:49:59', opts)} lang="ms" />);
    expect(r.container.querySelector('[data-card="kuliahCard"]')).toBeTruthy();
    const w = watch(r.container);
    await act(async () => {
      tick(r, '16:50:00', opts);
    });
    expect(r.container.querySelector('[data-layer="zikir"]')).toBeTruthy();
    const stage = w.stageAtZikirEntry();
    w.stop();
    expect(stage!.cls).toContain('screen--shell');
    expect(stage!.idle).toBe('false');
  });

  it('once on, the zikir stays the same element across the clock and a content reload (no remount)', async () => {
    localStorage.setItem('surau.content', JSON.stringify({ content, fetchedAt: Date.now() }));
    let resolve!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => { resolve = res; })));
    const r = render(<Main view={makeView('2026-11-03', '16:45:00')} lang="ms" />);
    const first = r.container.querySelector('[data-layer="zikir"]');
    expect(first).toBeTruthy();
    tick(r, '16:45:01');
    await act(async () => {
      resolve(new Response(JSON.stringify({ content: { ...content } }), { status: 200 }));
      await new Promise((x) => setTimeout(x, 0));
    });
    tick(r, '16:45:02');
    expect(r.container.querySelector('[data-layer="zikir"]')).toBe(first);
    expect(r.container.querySelector('.screen')!.className).toContain('screen--shell');
  });
});
