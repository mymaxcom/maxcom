import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { buildRotation, currentSlot, zikirWindow } from '@surau/core';
import type { KioskContent } from '@surau/core';
import { days, makeView } from './helpers.tsx';
import type { ViewOpts } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';
import type { ContentView } from '../src/data/content.ts';
import { tarawihMonthFor } from '../src/data/tarawih.ts';

const holder = vi.hoisted(() => ({
  view: null as unknown as KioskView,
  cv: null as unknown as ContentView,
}));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));
vi.mock('../src/data/content.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/data/content.ts')>();
  return { ...orig, useContent: () => holder.cv };
});

import { App } from '../src/app.tsx';
import { Main } from '../src/screens/Main.tsx';
import { zikirAt } from '../src/content/ZikirOverlay.tsx';
import { previewZikirWindow } from '../src/data/content.ts';

const base = { updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'test' };
const ZIKIR = [
  { ...base, id: 'z2', order: 2, textAr: 'سُبْحَانَ اللهِ', textMs: 'Maha Suci Allah', repeat: 33 },
  { ...base, id: 'z1', order: 1, textAr: 'أَسْتَغْفِرُ اللهَ', textMs: 'Aku memohon keampunan Allah', repeat: 3 },
  { ...base, id: 'z3', order: 3, textAr: 'ٱلْحَمْدُ لِلَّٰهِ', textMs: 'Segala puji bagi Allah', repeat: 33 },
];

function fixture(over: Partial<KioskContent> = {}): KioskContent {
  return {
    date: '2026-11-03',
    kuliah: [{
      ...base, id: 'k1', date: '2026-11-03', slot: 'maghrib', time: '19:15', label: 'Kuliah Maghrib',
      penceramahId: 'p1', status: 'aktif', penceramah: { name: 'Ustaz Abu Bakar Ahmad' },
    }],
    pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [],
    hadisToday: [], worldTimes: [], tugasan: [], ayat: { today: null, tomorrow: null }, zikir: ZIKIR,
    tilawah: { slots: [], available: {} },
    credits: { translation: 't', font: 'f', audio: 'a' },
    ...over,
  };
}

/** The ContentView exactly as useContent computes it (real zikirWindow on the fixture year). */
function viewAt(content: KioskContent, date: string, hhmm: string, opts: ViewOpts = {}) {
  const view = makeView(date, hhmm, opts);
  const rotation = buildRotation(content, view.settings, view.now);
  const today = view.state.today;
  const month = tarawihMonthFor(view.now, today ? [today] : [], view.settings) ?? view.hijri?.m;
  const zikir = zikirWindow(view.now, days, view.settings, month, content.zikir.length);
  holder.view = view;
  holder.cv = { content, rotation, current: currentSlot(rotation, view.now), zikir, override: null };
  return view;
}

let play: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
});
afterEach(() => {
  cleanup();
  play.mockRestore();
});

describe('ZikirOverlay', () => {
  it('replaces the rotation after Asar (16:45:05) with the zikir for the moment', () => {
    const view = viewAt(fixture(), '2026-11-03', '16:45:05');
    expect(holder.cv.zikir?.prayer).toBe('asar');
    const r = render(<Main view={view} lang="ms" />);
    expect(r.getByText('Zikir selepas solat Asar')).toBeTruthy();
    expect(r.container.querySelector('[data-card]')).toBeNull();
    expect(r.container.querySelector('[data-layer="content"]')).toBeNull();
    const z = r.container.querySelector('[data-layer="zikir"]')!;
    expect(z).toBeTruthy();
    expect(z.getAttribute('data-prayer')).toBe('asar');
    // Solat ends 16:45; 20 s per zikir -> 5 s in is the first zikir by order.
    expect(z.getAttribute('data-item')).toBe('z1');
    const ar = z.querySelector('[dir="rtl"]')!;
    expect(ar.textContent).toContain('أَسْتَغْفِرُ');
    expect(r.getByText('Aku memohon keampunan Allah')).toBeTruthy();
    expect(r.getByText('×3')).toBeTruthy();
    expect(r.getByText('1 / 3')).toBeTruthy();
  });

  it('pages every durationSeconds in order: 16:45:20 shows the second zikir, 16:45:40 the third', () => {
    const v1 = viewAt(fixture(), '2026-11-03', '16:45:20');
    const r1 = render(<Main view={v1} lang="ms" />);
    const z1 = r1.container.querySelector('[data-layer="zikir"]')!;
    expect(z1.getAttribute('data-item')).toBe('z2');
    expect(r1.getByText('Maha Suci Allah')).toBeTruthy();
    expect(r1.getByText('×33')).toBeTruthy();
    cleanup();
    const v2 = viewAt(fixture(), '2026-11-03', '16:45:40');
    const r2 = render(<Main view={v2} lang="ms" />);
    expect(r2.container.querySelector('[data-layer="zikir"]')!.getAttribute('data-item')).toBe('z3');
  });

  it('shows each zikir once: at 16:45:59 the last one, at 16:46:01 the rotation is back (not after 10 minutes)', () => {
    const last = viewAt(fixture(), '2026-11-03', '16:45:59');
    const r1 = render(<Main view={last} lang="ms" />);
    expect(r1.container.querySelector('[data-layer="zikir"]')!.getAttribute('data-item')).toBe('z3');
    cleanup();
    const view = viewAt(fixture(), '2026-11-03', '16:46:01');
    expect(holder.cv.zikir).toBeNull();
    const r = render(<Main view={view} lang="ms" />);
    expect(r.container.querySelector('[data-layer="zikir"]')).toBeNull();
    expect(r.container.querySelector('[data-layer="content"] [data-card="kuliahCard"]')).toBeTruthy();
  });

  it('a list longer than the ceiling never wraps: past the ceiling nothing of the zikir shows', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...base, id: `m${i}`, order: i, textAr: 'سُبْحَانَ اللهِ', textMs: 'Maha Suci Allah', repeat: 1 }));
    const view = viewAt(fixture({ zikir: many as never }), '2026-11-03', '16:50');
    expect(holder.cv.zikir).not.toBeNull();
    const r = render(<Main view={view} lang="ms" />);
    expect(r.container.querySelector('[data-layer="zikir"]')!.getAttribute('data-item')).toBe('m15'); // 300 s / 20 s
    cleanup();
    viewAt(fixture({ zikir: many as never }), '2026-11-03', '16:55:01');
    expect(holder.cv.zikir).toBeNull(); // cut at the 10 minute ceiling, no wrap
  });

  it('gives the rotation back once the window ends (16:56)', () => {
    const view = viewAt(fixture(), '2026-11-03', '16:56');
    expect(holder.cv.zikir).toBeNull();
    const r = render(<Main view={view} lang="ms" />);
    expect(r.queryByText(/Zikir selepas solat/)).toBeNull();
    expect(r.container.querySelector('[data-layer="zikir"]')).toBeNull();
    expect(r.container.querySelector('[data-layer="content"] [data-card="kuliahCard"]')).toBeTruthy();
  });

  it('keeps the rotation when the window is open but the surau has no zikir text', () => {
    const view = viewAt(fixture({ zikir: [] }), '2026-11-03', '16:50');
    expect(holder.cv.zikir).toBeNull();
    const r = render(<Main view={view} lang="ms" />);
    expect(r.container.querySelector('[data-layer="zikir"]')).toBeNull();
    expect(r.container.querySelector('[data-layer="content"] [data-card="kuliahCard"]')).toBeTruthy();
  });

  it('never shows in a prayer phase: App at solat 16:35 has no zikir and no ticker', () => {
    const c = fixture({ ticker: [{ ...base, id: 'tk1', text: 'Teks bergerak', from: '2026-11-01', to: '2026-11-30' }] });
    viewAt(c, '2026-11-03', '16:35');
    expect(holder.cv.zikir).toBeNull();
    const r = render(<App />);
    expect(r.container.querySelector('.stage')!.getAttribute('data-phase')).toBe('solat');
    expect(r.container.querySelector('[data-layer="zikir"]')).toBeNull();
    expect(r.container.querySelector('[data-layer="ticker"]')).toBeNull();
    expect(r.queryByText(/Zikir selepas solat/)).toBeNull();
    expect(r.queryByText('Teks bergerak')).toBeNull();
  });
});

describe('the editor preview of the zikir screen', () => {
  const items = ZIKIR as never;
  const zikirOf = (itemCount: number, at: Date, minutes: number) => {
    // the preview window ignores minutesAfterSolat entirely
    void minutes;
    return previewZikirWindow(at, itemCount, 20);
  };

  it('with minutesAfterSolat 0 and 2 items it shows the first item, then the second', () => {
    const view = viewAt(fixture(), '2026-11-03', '12:00:00', { settings: { zikirSelepasSolat: { minutesAfterSolat: 0 } } });
    expect(view.settings.zikirSelepasSolat.minutesAfterSolat).toBe(0);
    const two = (ZIKIR as { order: number }[]).slice(0, 2) as never;
    const start = Math.floor(view.now.getTime() / 40_000) * 40_000;
    const win = previewZikirWindow(new Date(start + 5_000), 2, view.settings.zikirSelepasSolat.durationSeconds)!;
    expect(win.endsAt.getTime() - win.startsAt.getTime()).toBe(40_000);
    const first = zikirAt(two, new Date(start + 5_000), win, 20, 0);
    expect(first?.item.id).toBe('z1');
    const later = zikirAt(two, new Date(start + 25_000), win, 20, 0);
    expect(later?.item.id).toBe('z2');
  });

  it('the window repeats: one full pass later it shows the first item again', () => {
    const t0 = new Date('2026-11-03T04:00:00Z');
    const win = previewZikirWindow(new Date(t0.getTime() + 41_000), 2, 20)!;
    expect(zikirAt(items, new Date(t0.getTime() + 41_000), win, 20, 0)?.item.id).toBe('z1');
  });

  it('with no zikir items there is no window and nothing shows', () => {
    expect(zikirOf(0, new Date('2026-11-03T04:00:00Z'), 0)).toBeNull();
    const win = previewZikirWindow(new Date('2026-11-03T04:00:00Z'), 1, 20)!;
    expect(zikirAt([], new Date('2026-11-03T04:00:00Z'), win, 20, 10)).toBeNull();
  });

  it('the live path is unchanged: 0 minutes means no zikir window, and the passed minutes never change zikirAt', () => {
    const view = viewAt(fixture(), '2026-11-03', '16:45:05', { settings: { zikirSelepasSolat: { minutesAfterSolat: 0 } } });
    expect(holder.cv.zikir).toBeNull();
    const r = render(<Main view={view} lang="ms" />);
    expect(r.container.querySelector('[data-layer="zikir"]')).toBeNull();
    cleanup();
    const ok = viewAt(fixture(), '2026-11-03', '16:45:05');
    const w = holder.cv.zikir!;
    expect(zikirAt(ZIKIR as never, ok.now, w, 20, 10)?.item.id).toBe('z1');
    expect(zikirAt(ZIKIR as never, ok.now, w, 20, 0)?.item.id).toBe('z1');
    expect(zikirAt(ZIKIR as never, new Date(w.startsAt.getTime() + 60_000), w, 20, 10)).toBeNull();
  });
});
