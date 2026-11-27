import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/preact';
import { klInstant } from '@surau/core';
import type { KioskContent } from '@surau/core';
import { makeView } from './helpers.tsx';
import { useContent } from '../src/data/content.ts';

/**
 * O11 (Q14): the zikir window is never computed with an unknown item count. Before the content is there the window
 * is null (it used to be the full 10 minute ceiling, then shrank to the list's own length once the content arrived: a
 * flicker on a box that remounts the page after a prayer). 2026-11-03: Asar solat ends 16:45.
 */
const base = { updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'test' };
const content: KioskContent = {
  date: '2026-11-03', kuliah: [], pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [],
  hadisToday: [], worldTimes: [], tugasan: [], ayat: { today: null, tomorrow: null },
  zikir: [1, 2, 3].map((i) => ({ ...base, id: `z${i}`, order: i, textAr: 'سُبْحَانَ اللهِ', textMs: 'Maha Suci Allah' })) as never,
  tilawah: { slots: [], available: {} }, credits: { translation: '', font: '', audio: '' },
};

afterEach(() => {
  cleanup();
  localStorage.removeItem('surau.content');
  vi.unstubAllGlobals();
});

describe('zikir window while the content loads', () => {
  it('no content yet: no window at all (not the full ceiling)', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    const hook = renderHook((v) => useContent(v), { initialProps: makeView('2026-11-03', '16:45:05') });
    expect(hook.result.current.content).toBeNull();
    expect(hook.result.current.zikir).toBeNull();
    hook.rerender(makeView('2026-11-03', '16:50:00'));
    expect(hook.result.current.zikir).toBeNull();
  });

  it('with the content: the window is the list length (3 x 20 s), from the first render', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    localStorage.setItem('surau.content', JSON.stringify({ content, fetchedAt: Date.now() }));
    const hook = renderHook((v) => useContent(v), { initialProps: makeView('2026-11-03', '16:45:05') });
    expect(hook.result.current.zikir).toMatchObject({
      prayer: 'asar', startsAt: klInstant('2026-11-03', '16:45'), endsAt: klInstant('2026-11-03', '16:46'),
    });
    hook.rerender(makeView('2026-11-03', '16:46:01'));
    expect(hook.result.current.zikir).toBeNull();
  });
});
