import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { buildRotation, currentSlot, zikirWindow } from '@surau/core';
import type { KioskContent, SlotFeature } from '@surau/core';
import { days, makeView } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';
import type { ContentView } from '../src/data/content.ts';
import type { LiveView } from '../src/data/live.ts';
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
import { LiveScreen } from '../src/screens/LiveScreen.tsx';
import { LiveStrip } from '../src/live/LiveLayer.tsx';

const base = { updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'test' };
const HADIS = {
  id: 'h1', attribution: 'Riwayat al-Bukhari dan Muslim',
  textAr: 'إِنَّمَا الْأَعْمَالُ بِالنِّيَّاتِ',
  textMs: 'Sesungguhnya setiap amalan itu bergantung kepada niat.',
};
const AYAT = {
  surah: 2, surahNameAr: 'البقرة', surahNameMs: 'Al-Baqarah', ayatFrom: 2, ayatTo: 2,
  arabic: ['ذَٰلِكَ ٱلْكِتَٰبُ لَا رَيْبَ ۛ فِيهِ'], malay: ['Kitab Al-Quran ini, tidak ada sebarang syak padanya.'], translationVersion: 'unlisted',
};
const ZIKIR = [{ ...base, id: 'z1', order: 1, textAr: 'أَسْتَغْفِرُ اللهَ', textMs: 'Aku memohon keampunan Allah', repeat: 3 }];
const TICKER = [{ ...base, id: 'tk1', text: 'Kutipan derma dibuka setiap hari.', from: '2026-11-01', to: '2026-11-30' }];

function fixture(over: Partial<KioskContent> = {}): KioskContent {
  return {
    date: '2026-11-03',
    kuliah: [{
      ...base, id: 'k1', date: '2026-11-03', slot: 'maghrib', time: '19:15', label: 'Kuliah Maghrib',
      penceramahId: 'p1', status: 'aktif', penceramah: { name: 'Ustaz Abu Bakar Ahmad' },
    }],
    pengumuman: [], ticker: TICKER, posters: [], programKhas: [], takwim: [],
    hadisToday: [HADIS], worldTimes: [], tugasan: [], ayat: { today: AYAT, tomorrow: null }, zikir: ZIKIR,
    tilawah: { slots: [], available: {} },
    credits: { translation: 't', font: 'f', audio: 'a' },
    ...over,
  } as unknown as KioskContent;
}

function setup(date: string, hhmm: string, override: SlotFeature | null = null) {
  const content = fixture();
  const view = makeView(date, hhmm);
  const rotation = buildRotation(content, view.settings, view.now);
  const today = view.state.today;
  const month = tarawihMonthFor(view.now, today ? [today] : [], view.settings) ?? view.hijri?.m;
  const zikir = zikirWindow(view.now, days, view.settings, month);
  holder.view = view;
  holder.cv = { content, rotation, current: currentSlot(rotation, view.now), zikir, override };
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

describe('contract v1 hooks on the screens', () => {
  it('biasa carries every region it shows', () => {
    setup('2026-11-03', '15:52');
    const r = render(<App />);
    for (const sel of ['.region-brand', '.region-clock[data-role="clock"]', '.region-next[data-role="next"]', '.region-main', '.region-prayers[data-role="prayers"]', '.region-ticker'])
      expect(r.container.querySelectorAll(sel).length, sel).toBeGreaterThanOrEqual(1);
  });

  it('iqamah carries brand, clock, main, prayers and the countdown role', () => {
    holder.view = makeView('2026-11-03', '16:25');
    const r = render(<App />);
    expect(r.container.querySelector('.phase__head .region-brand')).toBeTruthy();
    expect(r.container.querySelector('.phase__head .region-clock[data-role="clock"]')).toBeTruthy();
    expect(r.container.querySelector('.phase__centre.region-main')).toBeTruthy();
    expect(r.container.querySelector('[data-role="countdown"].phase__big')).toBeTruthy();
    expect(r.container.querySelector('.pbar.region-prayers[data-role="prayers"]')).toBeTruthy();
  });

  it('azan carries the countdown role too', () => {
    holder.view = makeView('2026-11-03', '16:19');
    const r = render(<App />);
    expect(r.container.querySelector('.stage')!.getAttribute('data-phase')).toBe('azanCountdown');
    expect(r.container.querySelector('[data-role="countdown"].phase__big')).toBeTruthy();
  });

  it('old class names are all still there (the main layout: a card with no catalog screen of its own)', () => {
    setup('2026-11-03', '15:52', 'worldTimes');
    const r = render(<App />);
    for (const sel of ['.ident__head', '.clock', '.next.glass', '.pbar.glass', 'section.content', '.ticker.glass'])
      expect(r.container.querySelector(sel), sel).toBeTruthy();
  });

  it('the content shell: brand, clock, next chip and strip regions', () => {
    const content = fixture({ posters: [{ ...base, id: 'po1', title: 'P', assetId: 'a'.repeat(64), days: ['umum'], order: 1 }] as never });
    const view = makeView('2026-11-03', '15:52');
    holder.view = view;
    holder.cv = { content, rotation: [], current: null, zikir: null, override: 'posters' };
    const r = render(<Main view={view} lang="ms" />);
    for (const sel of ['.region-brand', '.region-clock[data-role="clock"]', '.region-next[data-role="next"]', '.region-prayers[data-role="prayers"]', '.region-main']) {
      expect(r.container.querySelectorAll(sel).length, sel).toBe(1);
    }
  });

  it('hadis and ayat cards carry the Arabic classes', () => {
    setup('2026-11-03', '15:52', 'hadis');
    let r = render(<Main view={holder.view} lang="ms" />);
    expect(r.container.querySelector('.hadis-ar.arab')).toBeTruthy();
    expect(r.container.querySelector('.hadis-ms.arab-tarjamah')).toBeTruthy();
    cleanup();
    setup('2026-11-03', '15:52', 'ayatCard');
    r = render(<Main view={holder.view} lang="ms" />);
    expect(r.container.querySelector('.ayat__ar.arab')).toBeTruthy();
    expect(r.container.querySelector('.ayat__ms.arab-tarjamah')).toBeTruthy();
  });

  it('the zikir overlay is a main region with the Arabic classes', () => {
    setup('2026-11-03', '16:50');
    const r = render(<Main view={holder.view} lang="ms" />);
    expect(r.container.querySelector('section.zikir.region-main')).toBeTruthy();
    expect(r.container.querySelector('.zikir__ar.arab.arabic')).toBeTruthy();
    expect(r.container.querySelector('.zikir__ms.arab-tarjamah')).toBeTruthy();
  });
});

const ON_AIR: LiveView = {
  live: true,
  since: '2026-11-05T07:40:00.000Z',
  kuliah: { label: 'Kuliah Maghrib', penceramah: 'Ustaz Ahmad Fauzi', topic: 'Bab Ikhlas dan Niat' },
  audio: false,
  volume: 50,
  playable: true,
} as unknown as LiveView;

describe('contract v1 hooks on the live screen', () => {
  it('live strip, frame, brand and next', () => {
    const view = makeView('2026-11-05', '14:00');
    const r = render(<LiveScreen view={view} live={ON_AIR} lang="ms" onAir />);
    expect(r.container.querySelector('.live-screen__frame.region-main')).toBeTruthy();
    expect(r.container.querySelector('.live-screen__ident.region-brand')).toBeTruthy();
    expect(r.container.querySelector('.region-next.next--chip[data-role="next"]')).toBeTruthy();
    expect(r.container.querySelector('.live-strip.region-live-strip')).toBeTruthy();
    expect(r.container.querySelector('.region-clock[data-role="clock"]')).toBeTruthy();
  });
  it('LiveStrip alone', () => {
    const r = render(<LiveStrip live={ON_AIR} lang="ms" onAir />);
    expect(r.container.querySelector('.live-strip.region-live-strip')).toBeTruthy();
  });
});
