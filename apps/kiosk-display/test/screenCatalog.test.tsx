import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/preact';
import { buildRotation, currentSlot } from '@surau/core';
import type { KioskContent, SlotFeature } from '@surau/core';
import { makeView } from './helpers.tsx';
import type { ViewOpts } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';
import type { ContentView } from '../src/data/content.ts';

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
import { screenIdOf } from '../src/screens/screenId.ts';

const base = { updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'test' };
const POSTER = 'a'.repeat(64);

function fixture(): KioskContent {
  return {
    date: '2026-11-03',
    kuliah: [{
      ...base, id: 'k1', date: '2026-11-03', slot: 'maghrib', time: '19:15', label: 'Kuliah Maghrib',
      penceramahId: 'p1', status: 'aktif', penceramah: { name: 'Ustaz Abu Bakar Ahmad' },
    }],
    pengumuman: [], ticker: [],
    posters: [{ ...base, id: 'po1', title: 'Poster 1', assetId: POSTER, days: ['umum'], order: 1 }],
    programKhas: [], takwim: [], hadisToday: [],
    worldTimes: [{ ...base, id: 'w1', city: 'Makkah', tz: 'Asia/Riyadh', order: 1 }],
    tugasan: [{ ...base, id: 'g1', date: '2026-11-03', role: 'imam', petugasId: 'x1', petugas: { name: 'Haji Rosli Hamid' } }],
    ayat: { today: null, tomorrow: null }, zikir: [],
    tilawah: { slots: [], available: {} },
    credits: { translation: 't', font: 'f', audio: 'a' },
  } as unknown as KioskContent;
}

function showApp(override: SlotFeature | null, opts: ViewOpts = {}) {
  const view = makeView('2026-11-03', '15:52', opts);
  const content = fixture();
  const rotation = buildRotation(content, view.settings, view.now);
  holder.view = view;
  holder.cv = { content, rotation, current: currentSlot(rotation, view.now), zikir: null, override };
  return render(<App />);
}
const stage = (r: ReturnType<typeof render>) => r.container.querySelector('.stage') as HTMLElement;

afterEach(() => cleanup());

const normal = { phase: 'normal', prayer: null } as const;

describe('screenIdOf with the shown card', () => {
  it('a card decides the screen in the normal phase', () => {
    expect(screenIdOf(normal, false, 'kuliahCard')).toBe('kuliah');
    expect(screenIdOf(normal, false, 'posters')).toBe('poster');
    expect(screenIdOf(normal, false, 'programKhas')).toBe('program');
    expect(screenIdOf(normal, false, 'zikir')).toBe('zikir');
    expect(screenIdOf(normal, false, null)).toBe('biasa');
    expect(screenIdOf(normal, false)).toBe('biasa');
  });
  it('the two shell cards without a catalog screen take their own stage ids', () => {
    expect(screenIdOf(normal, false, 'worldTimes')).toBe('waktu-dunia');
    expect(screenIdOf(normal, false, 'tugasan')).toBe('tugasan');
    expect(screenIdOf(normal, false, null)).toBe('biasa');
  });
  it('live and prayer phases ignore the card', () => {
    expect(screenIdOf(normal, true, 'posters')).toBe('live');
    expect(screenIdOf({ phase: 'iqamah', prayer: 'asar' }, false, 'posters')).toBe('iqamah');
    expect(screenIdOf({ phase: 'solat', prayer: 'jumaat' }, false, null)).toBe('jumaat');
  });
});

describe('the stage', () => {
  it('carries data-theme and data-lang', () => {
    const r = showApp(null, { settings: { kioskTemplate: { templateId: 'creative' }, language: { lang: 'en' } } });
    expect(stage(r).getAttribute('data-theme')).toBe('creative');
    expect(stage(r).getAttribute('data-template')).toBe('creative');
    expect(stage(r).getAttribute('data-lang')).toBe('en');
  });

  it('says kuliah while the kuliah card is on screen, poster for a poster', async () => {
    const r = showApp('kuliahCard');
    await act(async () => { await Promise.resolve(); });
    expect(stage(r).getAttribute('data-screen')).toBe('kuliah');
    cleanup();
    const p = showApp('posters');
    await act(async () => { await Promise.resolve(); });
    expect(stage(p).getAttribute('data-screen')).toBe('poster');
  });

  it('a card with no catalog id (worldTimes, tugasan) puts the stage on its shell id and nothing throws', async () => {
    for (const [f, id] of [['worldTimes', 'waktu-dunia'], ['tugasan', 'tugasan']] as const) {
      const r = showApp(f);
      await act(async () => { await Promise.resolve(); });
      expect(r.container.querySelector(`[data-card="${f}"]`), f).toBeTruthy();
      expect(stage(r).getAttribute('data-screen'), f).toBe(id);
      expect(stage(r).getAttribute('data-kind'), f).toBe('content');
      cleanup();
    }
  });

  it('a poster that fails to load leaves the stage on biasa', async () => {
    const r = showApp('posters');
    await act(async () => { await Promise.resolve(); });
    expect(stage(r).getAttribute('data-screen')).toBe('poster');
    await act(async () => {
      r.container.querySelector('.poster__img')!.dispatchEvent(new Event('error'));
      await Promise.resolve();
    });
    expect(r.container.querySelector('[data-card="posters"]')).toBeNull();
    expect(stage(r).getAttribute('data-screen')).toBe('biasa');
  });

  it('a prayer phase shows its own screen id', () => {
    holder.view = makeView('2026-11-03', '16:25');
    const r = render(<App />);
    expect(stage(r).getAttribute('data-screen')).toBe('iqamah');
  });
});
