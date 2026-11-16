import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { buildCycle, buildRotation, currentSlot, hadisPlan, zikirWindow } from '@surau/core';
import type { KioskContent, SlotFeature } from '@surau/core';
import { days, makeView } from './helpers.tsx';
import type { ViewOpts } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';
import type { ContentView } from '../src/data/content.ts';
import { tarawihMonthFor } from '../src/data/tarawih.ts';

const holder = vi.hoisted(() => ({ view: null as unknown as KioskView, cv: null as unknown as ContentView }));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));
vi.mock('../src/data/content.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/data/content.ts')>();
  return { ...orig, useContent: () => holder.cv };
});


// Q2: the layout's paging is chosen by the test (jsdom has no layout): two pages, the Arabic first and the Malay after.
const paging = vi.hoisted(() => ({ pages: 2, sub: 1 }));
vi.mock('../src/content/paging.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/content/paging.ts')>();
  return { ...orig, useFit: () => ({ ref: { current: null }, fit: 1, pages: paging.pages }), pageAt: () => paging.sub };
});

import { App } from '../src/app.tsx';
import { arabBaseOf } from '../src/content/ContentLayer.tsx';
import { arabLookFor, groupIndices, tarjamahMode } from '../src/screens/content/arabLook.ts';
import { screenIdOf } from '../src/screens/screenId.ts';
import { arabLooksOf, builtInTheme } from '../src/themes/index.ts';
import type { ResolvedTheme } from '../src/themes/index.ts';

const base = { updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'test' };
const HADIS = {
  id: 'h1', attribution: 'Riwayat al-Bukhari dan Muslim',
  textAr: 'إِنَّمَا الْأَعْمَالُ بِالنِّيَّاتِ',
  textMs: 'Sesungguhnya setiap amalan itu bergantung kepada niat.',
};
const AYAT = {
  surah: 18, surahNameMs: 'Al-Kahfi', ayatFrom: 1, ayatTo: 2,
  arabic: ['ٱلۡحَمۡدُ لِلَّهِ ٱلَّذِيٓ أَنزَلَ عَلَىٰ عَبۡدِهِ ٱلۡكِتَٰبَ', 'قَيِّمٗا لِّيُنذِرَ بَأۡسٗا شَدِيدٗا'],
  malay: ['Segala puji tertentu bagi Allah yang telah menurunkan Kitab suci Al-Quran.', 'Tetap benar lagi menjadi pengawas.'],
} as never;
const ZIKIR = [
  { ...base, id: 'z2', order: 2, textAr: 'سُبْحَانَ اللهِ', textMs: 'Maha Suci Allah', repeat: 33 },
  { ...base, id: 'z1', order: 1, textAr: 'أَسْتَغْفِرُ اللهَ', textMs: 'Aku memohon keampunan Allah', repeat: 1 },
];

function fixture(over: Partial<KioskContent> = {}): KioskContent {
  return {
    date: '2026-11-03',
    kuliah: [{
      ...base, id: 'k1', date: '2026-11-03', slot: 'maghrib', time: '19:15', label: 'Kuliah Maghrib',
      penceramahId: 'p1', status: 'aktif', penceramah: { name: 'Ustaz Abu Bakar Ahmad' },
    }],
    pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [],
    hadisToday: [HADIS], worldTimes: [], tugasan: [], ayat: { today: AYAT, tomorrow: null }, zikir: ZIKIR,
    tilawah: { slots: [], available: {} },
    credits: { translation: 'Terjemahan: Basmeih (QuranEnc.com)', font: 'f', audio: 'a' },
    ...over,
  } as KioskContent;
}

function showCard(card: SlotFeature, opts: { theme?: string; content?: KioskContent; settings?: ViewOpts['settings'] } = {}) {
  const content = opts.content ?? fixture();
  const view = makeView('2026-11-03', '15:52', { settings: { kioskTemplate: { templateId: opts.theme ?? 'arabic' }, ...(opts.settings ?? {}) } });
  const cycle = buildCycle(content, view.settings, view.now);
  holder.view = view;
  holder.cv = { content, rotation: cycle.slots, current: currentSlot(cycle.slots, view.now, cycle.cycleStartSec), zikir: null, override: card };
  return render(<App />);
}
function showZikir(theme: string, content = fixture()) {
  const view = makeView('2026-11-03', '16:50', { settings: { kioskTemplate: { templateId: theme } } });
  const rotation = buildRotation(content, view.settings, view.now);
  const today = view.state.today;
  const month = tarawihMonthFor(view.now, today ? [today] : [], view.settings) ?? view.hijri?.m;
  holder.view = view;
  holder.cv = { content, rotation, current: currentSlot(rotation, view.now), zikir: zikirWindow(view.now, days, view.settings, month), override: null };
  return render(<App />);
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((res) => setTimeout(res, 10)); };
let play: ReturnType<typeof vi.spyOn>;
beforeEach(() => { play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve()); });
afterEach(() => { cleanup(); play.mockRestore(); });

// Q2: a hadis or a zikir that the layout pages (larger text) shows its Arabic pages first and its Malay pages after. The Arabic
// screens used to draw nothing on a Malay page.
describe('Arabic screens on a page without Arabic', () => {
  it('the hadis screen: the first page has the Arabic, the second page the Malay on the same screen', async () => {
    paging.pages = 2; paging.sub = 0;
    const a = showCard('hadis');
    await flush();
    expect(a.container.querySelector('.arab-hadis .ah-ar')).not.toBeNull();
    cleanup();
    paging.sub = 1;
    const b = showCard('hadis');
    await flush();
    expect(b.container.querySelector('.arab-hadis')).not.toBeNull();
    expect(b.container.querySelector('.arab-hadis .ah-ar')).toBeNull();
    expect(b.container.querySelector('.arab-hadis .ah-ms')?.textContent).toContain('Sesungguhnya');
    expect(b.container.querySelector('.arab-hadis .ah-pg')?.textContent).toBe('2 / 2');
  });

  it('the zikir screen shows its meaning on the Malay page', async () => {
    paging.pages = 2; paging.sub = 1;
    const r = showZikir('arabic');
    await flush();
    expect(r.container.querySelector('.arab-zikir')).not.toBeNull();
    expect(r.container.querySelector('.arab-zikir .zk-ar')).toBeNull();
    expect(r.container.querySelector('.arab-zikir .zk-ms')?.textContent).toMatch(/Maha Suci|keampunan/);
    expect(r.container.querySelector('.arab-zikir .zk-pg')?.textContent).toBe('2 / 2');
  });
});
