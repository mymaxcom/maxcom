import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/preact';
import type { KioskContent } from '@surau/core';
import { PosterScreen } from '../src/screens/content/PosterScreen.tsx';
import { makeView } from './helpers.tsx';

const ASSET = 'e'.repeat(64);
const content = {
  date: '2026-11-06', kuliah: [], pengumuman: [], ticker: [], programKhas: [], takwim: [], hadisToday: [], worldTimes: [], tugasan: [],
  posters: [{ id: 'p1', title: 'P', assetId: ASSET, days: ['umum'], order: 1, updatedAt: 'x', updatedBy: 't' }],
  ayat: { today: null, tomorrow: null }, zikir: [], tilawah: { slots: [], available: {} }, credits: { translation: '', font: '', audio: '' },
} as unknown as KioskContent;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

describe('PosterScreen header observer', () => {
  it('does not measure on the seconds clock, and measures once, 200 ms later, after the name or date changes', async () => {
    vi.useFakeTimers();
    const stage = document.createElement('div');
    stage.className = 'stage';
    stage.innerHTML = '<div class="region-brand"><span id="name">Surau</span></div><div class="shell-top"><span id="clock">12:00:00</span></div><div id="mount"></div>';
    document.body.appendChild(stage);
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect');
    const view = makeView('2026-11-06', '12:00');
    render(<PosterScreen view={view} lang="ms" content={content} itemId="p1" startedAt={view.now} durationSeconds={15} />, { container: stage.querySelector('#mount')! });
    act(() => { vi.advanceTimersByTime(800); }); // the first measures (mount and the 700 ms settle)
    rect.mockClear();

    // the clock ticks every second for a minute: nothing is measured
    for (let i = 0; i < 60; i++) {
      stage.querySelector('#clock')!.textContent = `12:00:${String(i).padStart(2, '0')}`;
      await flush();
      act(() => { vi.advanceTimersByTime(1000); });
    }
    expect(rect).not.toHaveBeenCalled();

    // the name changes twice at once: one measure, after the 200 ms debounce
    stage.querySelector('#name')!.textContent = 'Surau Al-Hidayah';
    await flush();
    stage.querySelector('#name')!.textContent = 'Surau Al-Hidayah Taman Seri';
    await flush();
    act(() => { vi.advanceTimersByTime(150); });
    expect(rect).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(100); });
    expect(rect.mock.calls.length).toBeGreaterThan(0);
    const once = rect.mock.calls.length;
    act(() => { vi.advanceTimersByTime(1000); });
    expect(rect.mock.calls.length).toBe(once);
    stage.remove();
  });
});
