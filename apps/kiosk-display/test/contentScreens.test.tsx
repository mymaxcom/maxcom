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
import { KuliahScreen, kuliahDayOf } from '../src/screens/content/KuliahScreen.tsx';
import { STRINGS } from '../src/i18n.ts';
import { AR } from '../src/i18n-box.ts';

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
    expect(r.container.querySelector('.poster-stage')!.getAttribute('style')).toBeNull();
  });

  it('the poster carries its own proportions once loaded (the frame sizes it), and no strip or ticker shows (rules 1, 13)', () => {
    const r = renderBody(fixture({ ticker: [{ ...base, id: 't1', text: 'Makluman ujian', from: '2026-11-01', to: '2026-11-30' }] }), 'posters');
    const img = r.container.querySelector('img.poster__img') as HTMLImageElement;
    Object.defineProperty(img, 'naturalWidth', { value: 1600 });
    Object.defineProperty(img, 'naturalHeight', { value: 900 });
    fireEvent.load(img);
    expect((r.container.querySelector('.poster-stage') as HTMLElement).style.getPropertyValue('--poster-ar').trim()).toBe('1.7778');
    expect(r.container.querySelector('[data-role="prayers"]')).toBeNull();
    expect(r.container.querySelector('.ticker')).toBeNull();
    expect(r.container.querySelector('[data-role="next"]')).toBeTruthy();
    expect(r.container.querySelector('[data-testid="shell-date"]')).toBeTruthy();
  });

  it('kuliah screen shows label, speaker, topic and the facts', () => {
    const r = renderBody(fixture(), 'kuliahCard');
    expect(r.container.querySelector('.kul-label')!.textContent).toBe('Kuliah Maghrib');
    expect(r.container.querySelector('.kul-name')!.textContent).toBe(SPEAKER);
    expect(r.container.querySelector('.kul-topic')!.textContent).toBe('Tafsir Surah Al-Kahfi (siri 4)');
    expect(r.container.querySelector('.kul-day-word')!.textContent).toBe('Hari ini');
    expect([...r.container.querySelectorAll('.kul-facts span')].map((e) => e.textContent)).toEqual(expect.arrayContaining(['Masa', 'Selepas']));
    expect(r.container.querySelector('.kul-photo img')).toBeTruthy();
  });

  it('kuliah without a photo has no .kul-photo; without a topic no .kul-topic', () => {
    const c = fixture();
    delete c.kuliah[0]!.topic;
    delete c.kuliah[0]!.penceramah!.photoAssetId;
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
    c.kuliah[0]!.penceramah!.name = 'Ustaz Dr Muhammad Abdul Rahman bin Haji Ahmad Zakaria al-Hafiz';
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

describe('kuliah: one screen per kuliah, rotating (theme round 2, rule 11)', () => {
  const COVER = 'b'.repeat(64);
  // Neutral invented names. 2026-11-03 (a Tuesday) is "today" in renderBody, at 15:52.
  const more = (id: string, date: string, over: Record<string, unknown> = {}) => ({
    ...base, id, date, slot: 'maghrib', time: '19:15', label: 'Kuliah Maghrib', penceramahId: `p-${id}`,
    topic: `Topik ${id}`, status: 'aktif', penceramah: { name: `Penceramah ${id}` }, ...over,
  });
  const withMore = (...extra: ReturnType<typeof more>[]) => {
    const c = fixture();
    c.kuliah = [...c.kuliah, ...(extra as unknown as KioskContent['kuliah'])];
    return c;
  };
  const kuliahSlots = (c: KioskContent, opts: ViewOpts = {}) => {
    const view = makeView('2026-11-03', '15:52', opts);
    return buildCycle(c, view.settings, view.now).slots.filter((s) => s.feature === 'kuliahCard');
  };
  /** The kuliah screen of one slot, as the rotation would put it on the stage. */
  function renderSlot(c: KioskContent, itemId: string, opts: ViewOpts = {}) {
    const view = makeView('2026-11-03', '15:52', opts);
    return render(<KuliahScreen view={view} lang="ms" content={c} itemId={itemId} startedAt={null} durationSeconds={15} />);
  }

  it('the rotation gives every kuliah of the window its own slot, today first, in time order', () => {
    const c = withMore(more('k3', '2026-11-06'), more('k2', '2026-11-04', { slot: 'subuh', time: '06:20' }));
    expect(kuliahSlots(c).map((s) => s.itemId)).toEqual(['k1', 'k2', 'k3']);
  });

  it('kuliahCard.daysAhead ("Hari ke hadapan", default 7) bounds the window: today up to today + daysAhead', () => {
    const c = withMore(more('d4', '2026-11-07'), more('d7', '2026-11-10'), more('d8', '2026-11-11'));
    expect(kuliahSlots(c).map((s) => s.itemId)).toEqual(['k1', 'd4', 'd7']);
    expect(kuliahSlots(c, { settings: { kuliahCard: { daysAhead: 8 } } }).map((s) => s.itemId)).toEqual(['k1', 'd4', 'd7', 'd8']);
    expect(kuliahSlots(c, { settings: { kuliahCard: { daysAhead: 1 } } }).map((s) => s.itemId)).toEqual(['k1']);
  });

  it('a cancelled kuliah keeps its slot and shows the ribbon', () => {
    const c = withMore(more('k2', '2026-11-04', { status: 'batal' }));
    expect(kuliahSlots(c).map((s) => s.itemId)).toEqual(['k1', 'k2']);
    const r = renderSlot(c, 'k2');
    expect(r.container.querySelector('.kuliah')!.classList.contains('is-batal')).toBe(true);
    expect(r.container.querySelector('.kul-batal')!.textContent).toBe('DIBATALKAN');
  });

  it('the enlarged day line: "Hari ini" highlighted today, "Esok" tomorrow, else the weekday and the date', () => {
    const c = withMore(more('k2', '2026-11-04'), more('k3', '2026-11-05'));
    const today = renderSlot(c, 'k1');
    const day0 = today.container.querySelector('[data-testid="kul-day"]')!;
    expect(day0.classList.contains('is-today')).toBe(true);
    expect(day0.querySelector('.kul-day-word')!.textContent).toBe('Hari ini');
    expect(day0.querySelector('.kul-day-date')!.textContent).toBe('Selasa, 3 November');
    cleanup();
    const day1 = renderSlot(c, 'k2').container.querySelector('[data-testid="kul-day"]')!;
    expect(day1.classList.contains('is-tomorrow')).toBe(true);
    expect(day1.querySelector('.kul-day-word')!.textContent).toBe('Esok');
    expect(day1.querySelector('.kul-day-date')!.textContent).toBe('Rabu, 4 November');
    cleanup();
    const day2 = renderSlot(c, 'k3').container.querySelector('[data-testid="kul-day"]')!;
    expect(day2.classList.contains('is-later')).toBe(true);
    expect(day2.querySelector('.kul-day-word')!.textContent).toBe('Khamis');
    expect(day2.querySelector('.kul-day-date')!.textContent).toBe('5 November');
  });

  it('the day words in Malay, English and Arabic; the old following list is gone', () => {
    expect(kuliahDayOf('2026-11-04', '2026-11-03', 'en')).toEqual({ rel: 'tomorrow', word: 'Tomorrow', date: 'Wednesday, 4 November' });
    expect(kuliahDayOf('2026-11-06', '2026-11-03', 'en')).toEqual({ rel: 'later', word: 'Friday', date: '6 November' });
    for (const k of ['kuliahWhenToday', 'kuliahWhenTomorrow']) {
      expect(STRINGS.ms[k], k).toBeTruthy();
      expect(STRINGS.en[k], k).toBeTruthy();
      expect(AR[k], k).toBeTruthy();
    }
    for (const k of ['kuliahListHead', 'kuliahListAfter', 'kuliahToday', 'kuliahNext']) expect(STRINGS.ms[k], k).toBeUndefined();
    const r = renderBody(withMore(more('k2', '2026-11-04')), 'kuliahCard');
    expect(r.container.querySelector('.kul-next')).toBeNull();
    expect(r.container.querySelectorAll('[data-card="kuliahCard"]')).toHaveLength(1);
  });

  it('a slot whose kuliah is gone renders nothing', () => {
    const r = renderSlot(fixture(), 'nope');
    expect(r.container.querySelector('.kuliah')).toBeNull();
  });

  it('book cover: the picture when Tetapan shows it, nothing when off, a title block when the kitab has no picture', () => {
    const c = fixture();
    c.kuliah[0]!.kitab = { title: 'Kitab Contoh', coverAssetId: COVER };
    const on = renderBody(c, 'kuliahCard', { settings: { kitabCover: { enabled: true } } });
    expect(on.container.querySelector(`.kul-kitab.has-img img[src="/assets/${COVER}"]`)).toBeTruthy();
    expect(on.container.querySelector('.kuliah')!.classList.contains('has-kitab')).toBe(true);
    expect([...on.container.querySelectorAll('.kul-facts b')].map((e) => e.textContent)).toContain('Kitab Contoh');
    cleanup();
    const off = renderBody(c, 'kuliahCard', { settings: { kitabCover: { enabled: false } } });
    expect(off.container.querySelector('.kul-kitab')).toBeNull();
    expect([...off.container.querySelectorAll('.kul-facts b')].map((e) => e.textContent)).toContain('Kitab Contoh');
    cleanup();
    c.kuliah[0]!.kitab = { title: 'Kitab Contoh' };
    const block = renderBody(c, 'kuliahCard', { settings: { kitabCover: { enabled: true } } });
    expect(block.container.querySelector('.kul-kitab:not(.has-img) .kul-kitab-title')!.textContent).toBe('Kitab Contoh');
    expect([...block.container.querySelectorAll('.kul-facts span')].map((e) => e.textContent)).not.toContain('Kitab');
  });

  it('a later kuliah shows its own book cover', () => {
    const c = withMore(more('k2', '2026-11-04', { kitab: { title: 'Kitab Dua', coverAssetId: COVER } }));
    const r = renderSlot(c, 'k2', { settings: { kitabCover: { enabled: true } } });
    expect(r.container.querySelector(`.kul-kitab img[src="/assets/${COVER}"]`)).toBeTruthy();
  });

  it('photo shape follows penceramahPhoto.shape', () => {
    const round = renderBody(fixture(), 'kuliahCard', { settings: { penceramahPhoto: { shape: 'round' } } });
    expect(round.container.querySelector('.kul-photo.is-round')).toBeTruthy();
    cleanup();
    const square = renderBody(fixture(), 'kuliahCard', { settings: { penceramahPhoto: { shape: 'square' } } });
    expect(square.container.querySelector('.kul-photo.is-square')).toBeTruthy();
  });
});
