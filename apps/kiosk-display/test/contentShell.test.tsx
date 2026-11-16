import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { buildCycle, currentSlot } from '@surau/core';
import type { KioskContent, SlotFeature } from '@surau/core';
import { makeView } from './helpers.tsx';
import type { ViewOpts } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';
import type { ContentView } from '../src/data/content.ts';

const holder = vi.hoisted(() => ({ view: null as unknown as KioskView, cv: null as unknown as ContentView }));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));
vi.mock('../src/data/content.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/data/content.ts')>();
  return { ...orig, useContent: () => holder.cv };
});

import { App } from '../src/app.tsx';
import { kindOf } from '../src/screens/kind.ts';
import { chipRelative } from '../src/ui/NextChip.tsx';
import { fmtHijriAr, PRAYER_AR } from '../src/i18n.ts';

const PHOTO = 'a'.repeat(64);
const POSTER = 'c'.repeat(64);
const base = { updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'test' };

function content(): KioskContent {
  return {
    date: '2026-11-03',
    kuliah: [{
      ...base, id: 'k1', date: '2026-11-03', slot: 'maghrib', time: '19:15', label: 'Kuliah Maghrib', penceramahId: 'p1',
      topic: 'Tafsir Surah Al-Kahfi (siri 4)', status: 'aktif', penceramah: { name: 'Ustaz Abu Bakar Ahmad', title: 'Ustaz', photoAssetId: PHOTO },
    }],
    pengumuman: [], ticker: [],
    posters: [{ ...base, id: 'po1', title: 'Poster 1', assetId: POSTER, days: ['umum'], order: 1 }],
    programKhas: [], takwim: [], hadisToday: [],
    worldTimes: [{ ...base, id: 'w1', city: 'Makkah', tz: 'Asia/Riyadh' } as never],
    tugasan: [], ayat: { today: null, tomorrow: null }, zikir: [], tilawah: { slots: [], available: {} },
    credits: { translation: 't', font: 'f', audio: 'a' },
  } as KioskContent;
}

function showWithCard(card: SlotFeature | null, opts: ViewOpts = {}, date = '2026-11-03', hhmm = '15:52') {
  const c = content();
  const view = makeView(date, hhmm, opts);
  const cycle = buildCycle(c, view.settings, view.now);
  holder.view = view;
  // No card named: nothing to rotate, the main screen is idle.
  holder.cv = card === null
    ? { content: c, rotation: [], current: null, zikir: null, override: null }
    : { content: c, rotation: cycle.slots, current: currentSlot(cycle.slots, view.now, cycle.cycleStartSec), zikir: null, override: card };
  return render(<App />);
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((res) => setTimeout(res, 10)); };
const stage = (r: ReturnType<typeof render>) => r.container.querySelector('.stage') as HTMLElement;

let play: ReturnType<typeof vi.spyOn>;
beforeEach(() => { play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve()); });
afterEach(() => { cleanup(); play.mockRestore(); });

describe('stage kinds and the content shell', () => {
  it('kindOf', () => {
    expect(kindOf('biasa')).toBe('full');
    expect(kindOf('live')).toBe('live');
    for (const s of ['poster', 'kuliah', 'program', 'hadis', 'zikir', 'pengumuman', 'takwim', 'tabung', 'ayat', 'arab-ayat', 'arab-hadis', 'arab-zikir'] as const) expect(kindOf(s), s).toBe('content');
    for (const s of ['azan', 'masuk-waktu', 'iqamah', 'solat', 'jumaat', 'tiada-data', 'syuruk', 'isyraq', 'tarawih'] as const) expect(kindOf(s), s).toBe('hero');
  });

  it('a kuliah card shows inside the shell: brand, compact clock, chip, main, compact strip', async () => {
    const r = showWithCard('kuliahCard');
    await flush();
    expect(stage(r).getAttribute('data-kind')).toBe('content');
    expect(stage(r).getAttribute('data-screen')).toBe('kuliah');
    for (const sel of ['.region-brand', '.region-clock.clock--compact[data-role="clock"]', '.region-next.next--chip[data-role="next"]', '.region-main [data-card="kuliahCard"]', '.region-prayers.strip--compact[data-role="prayers"]']) {
      expect(r.container.querySelectorAll(sel).length, sel).toBe(1);
    }
    expect(r.container.querySelector('.ident')).toBeNull();
    expect(r.container.querySelector('.poster-strip')).toBeNull();
    expect(r.container.querySelector('.deco')).toBeTruthy();
  });

  it('worldTimes keeps the full layout; no content is the full layout too', async () => {
    const r = showWithCard('worldTimes');
    await flush();
    expect(stage(r).getAttribute('data-kind')).toBe('full');
    expect(r.container.querySelector('.ident')).toBeTruthy();
    cleanup();
    const idle = showWithCard(null);
    await flush();
    expect(stage(idle).getAttribute('data-kind')).toBe('full');
  });

  it('a poster that fails goes back to full in the same render', async () => {
    const r = showWithCard('posters');
    await flush();
    expect(stage(r).getAttribute('data-kind')).toBe('content');
    r.container.querySelector('img[data-item="po1"]')!.dispatchEvent(new Event('error'));
    await flush();
    expect(stage(r).getAttribute('data-kind')).toBe('full');
    expect(stage(r).getAttribute('data-screen')).toBe('biasa');
    expect(r.container.querySelector('.region-brand')).toBeTruthy();
    expect(r.container.querySelector('.ident')).toBeTruthy();
    expect(r.container.querySelector('.strip--compact')).toBeNull();
    expect(r.container.querySelector('.shell-top')).toBeNull();
  });

  it('the logo is in the shell brand when set', async () => {
    const r = showWithCard('kuliahCard', { logo: '/surau-logo?v=1' });
    await flush();
    expect(r.container.querySelector('.region-brand [data-role="logo"]')).toBeTruthy();
  });

  it('the in-cell countdown shows on biasa only', async () => {
    const r = showWithCard(null);
    await flush();
    expect(r.container.querySelector('.pcell__cd')).toBeTruthy();
    cleanup();
    const iq = showWithCard(null, {}, '2026-11-03', '16:25');
    await flush();
    expect(stage(iq).getAttribute('data-phase')).toBe('iqamah');
    expect(iq.container.querySelector('.pcell__cd')).toBeNull();
    cleanup();
    const k = showWithCard('kuliahCard');
    await flush();
    expect(k.container.querySelector('.pcell__cd')).toBeNull();
  });

  it('Arabic prayer names are in every cell, and the Arabic date reads right', async () => {
    const r = showWithCard(null);
    await flush();
    expect(r.container.querySelectorAll('.pcell-ar.arab').length).toBe(7);
    expect(PRAYER_AR.subuh).toBe('الفجر');
    expect(fmtHijriAr(new Date('2026-11-15T04:00:00Z'), { d: 5, m: 6, y: 1448 }, 'Asia/Kuala_Lumpur')).toBe('الأحد، ٥ جمادى الآخرة ١٤٤٨ هـ');
  });

  it('chip relative text', () => {
    expect(chipRelative((60 + 42) * 60_000 + 5_000, 'ms')).toBe('1 jam 42 minit lagi');
    expect(chipRelative(39 * 60_000, 'ms')).toBe('39 minit lagi');
    expect(chipRelative(20_000, 'ms')).toBe('sebentar lagi');
    expect(chipRelative((60 + 42) * 60_000, 'en')).toBe('in 1 h 42 min');
    expect(chipRelative(39 * 60_000, 'en')).toBe('in 39 min');
    expect(chipRelative(20_000, 'en')).toBe('in a moment');
  });
});
