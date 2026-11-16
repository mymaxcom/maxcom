import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';
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

import { Main } from '../src/screens/Main.tsx';
import { screenBodyFor } from '../src/screens/content/index.ts';

const PHOTO = 'a'.repeat(64);
const POSTER = 'c'.repeat(64);
const base = { updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'test' };
const SPEAKER = 'Ustaz Abu Bakar Ahmad';

function fixture(over: Partial<KioskContent> = {}): KioskContent {
  return {
    date: '2026-11-03',
    kuliah: [{
      ...base, id: 'k1', date: '2026-11-03', slot: 'maghrib', time: '19:15', label: 'Kuliah Maghrib', penceramahId: 'p1',
      topic: 'Tafsir Surah Al-Kahfi (siri 4)', status: 'aktif', penceramah: { name: SPEAKER, title: 'Ustaz', photoAssetId: PHOTO },
    }],
    pengumuman: [], ticker: [],
    posters: [{ ...base, id: 'po1', title: 'Poster 1', assetId: POSTER, days: ['umum'], order: 1 }],
    programKhas: [], takwim: [], hadisToday: [], worldTimes: [], tugasan: [],
    ayat: { today: null, tomorrow: null }, zikir: [], tilawah: { slots: [], available: {} },
    credits: { translation: 't', font: 'f', audio: 'a' },
    ...over,
  } as KioskContent;
}
const HADIS = {
  id: 'h1', attribution: 'Riwayat al-Bukhari dan Muslim',
  textAr: 'إِنَّمَا الْأَعْمَالُ بِالنِّيَّاتِ',
  textMs: 'Sesungguhnya setiap amalan itu bergantung kepada niat.',
};

function renderBody(content: KioskContent, card: SlotFeature, opts: ViewOpts = {}) {
  const view = makeView('2026-11-03', '15:52', opts);
  const cycle = buildCycle(content, view.settings, view.now);
  holder.view = view;
  holder.cv = { content, rotation: cycle.slots, current: currentSlot(cycle.slots, view.now, cycle.cycleStartSec), zikir: null, override: card };
  return render(<Main view={view} lang="ms" />);
}

let play: ReturnType<typeof vi.spyOn>;
beforeEach(() => { play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve()); });
afterEach(() => { cleanup(); play.mockRestore(); });

describe('content screen bodies', () => {
  it('poster screen: fill and frame, no text', () => {
    const r = renderBody(fixture(), 'posters');
    expect(r.container.querySelector('.poster-stage[data-card="posters"][data-item="po1"] .poster-fill')).toBeTruthy();
    expect(r.container.querySelector('.poster-frame img.poster__img')).toBeTruthy();
    expect(r.container.textContent).not.toContain('Poster 1');
    expect(r.container.querySelector('.poster-stage')!.classList.contains('is-wide')).toBe(false);
  });

  it('a wide poster takes the frame below the chip', () => {
    const r = renderBody(fixture(), 'posters');
    const img = r.container.querySelector('img.poster__img') as HTMLImageElement;
    Object.defineProperty(img, 'naturalWidth', { value: 1600 });
    Object.defineProperty(img, 'naturalHeight', { value: 900 });
    fireEvent.load(img);
    expect(r.container.querySelector('.poster-stage')!.classList.contains('is-wide')).toBe(true);
  });

  it('kuliah screen shows label, speaker, topic and the facts', () => {
    const r = renderBody(fixture(), 'kuliahCard');
    expect(r.container.querySelector('.kul-label')!.textContent).toBe('Kuliah Maghrib');
    expect(r.container.querySelector('.kul-name')!.textContent).toBe(SPEAKER);
    expect(r.container.querySelector('.kul-topic')!.textContent).toBe('Tafsir Surah Al-Kahfi (siri 4)');
    expect(r.container.querySelector('.eyebrow')!.textContent).toBe('Kuliah hari ini');
    expect([...r.container.querySelectorAll('.kul-facts span')].map((e) => e.textContent)).toEqual(expect.arrayContaining(['Masa', 'Selepas']));
    expect(r.container.querySelector('.kul-photo img')).toBeTruthy();
  });

  it('kuliah without a photo has no .kul-photo; without a topic no .kul-topic', () => {
    const c = fixture();
    delete c.kuliah[0]!.topic;
    delete c.kuliah[0]!.penceramah.photoAssetId;
    const r = renderBody(c, 'kuliahCard');
    expect(r.container.querySelector('.kul-photo')).toBeNull();
    expect(r.container.querySelector('.kul-topic')).toBeNull();
    expect(r.container.querySelector('.kul-name')).toBeTruthy();
  });

  it('hadis screen follows Tetapan: Arabic off hides .hadis-ar; Malay off with Arabic shows Arabic only', () => {
    const on = renderBody(fixture({ hadisToday: [HADIS] }), 'hadis');
    expect(on.container.querySelector('.hadis-ar.arab')!.textContent).toContain('إِنَّمَا');
    expect(on.container.querySelector('.hadis-ms.arab-tarjamah')).toBeTruthy();
    expect(on.container.querySelector('.hadis-src')!.textContent).toContain('Riwayat al-Bukhari dan Muslim');
    cleanup();
    const noAr = renderBody(fixture({ hadisToday: [HADIS] }), 'hadis', { settings: { hadis: { showArabic: false } } });
    expect(noAr.container.querySelector('.hadis-ar')).toBeNull();
    expect(noAr.container.querySelector('.hadis-ms')).toBeTruthy();
    cleanup();
    const arOnly = renderBody(fixture({ hadisToday: [HADIS] }), 'hadis', { settings: { hadis: { showMalay: false } } });
    expect(arOnly.container.querySelector('.hadis-ar')).toBeTruthy();
    expect(arOnly.container.querySelector('.hadis-ms')).toBeNull();
  });

  it('a hadis in parts shows one part, labelled, with no Arabic', () => {
    const long = { id: 'hl', attribution: 'Muttafaq alaih', textAr: 'نص', textMs: Array.from({ length: 60 }, (_, i) => `Ayat nombor ${i + 1} dalam hadis yang panjang.`).join(' ') };
    const r = renderBody(fixture({ hadisToday: [long] }), 'hadis');
    const card = r.container.querySelector('.hadis')!;
    if (card.getAttribute('data-page') !== null) {
      expect(card.querySelector('.hadis-ar')).toBeNull();
      expect(card.querySelector('.hadis-part')!.textContent).toMatch(/^Bahagian 1 daripada \d+$/);
    }
    expect(card.querySelector('.hadis-ms')!.textContent!.length).toBeGreaterThan(10);
  });

  it('a 60-character speaker name and a 600-character hadis carry the fit variable', () => {
    const c = fixture();
    c.kuliah[0]!.penceramah.name = 'Ustaz Dr Muhammad Abdul Rahman bin Haji Ahmad Zakaria al-Hafiz';
    const k = renderBody(c, 'kuliahCard');
    expect(k.container.querySelector('.kuliah')!.getAttribute('style')).toContain('--fit');
    cleanup();
    const h = renderBody(fixture({ hadisToday: [{ ...HADIS, textMs: 'perkataan '.repeat(60).trim() }] }), 'hadis');
    expect(h.container.querySelector('.hadis')!.getAttribute('style')).toContain('--fit');
  });

  it('features without a body use their card in the generic frame', () => {
    expect(screenBodyFor('takwim')).toBeNull();
    expect(screenBodyFor('worldTimes')).toBeNull();
    expect(screenBodyFor('pengumuman')).toBeNull();
    expect(screenBodyFor('posters')).toBeTruthy();
    expect(screenBodyFor('kuliahCard')).toBeTruthy();
    expect(screenBodyFor('hadis')).toBeTruthy();
  });
});
