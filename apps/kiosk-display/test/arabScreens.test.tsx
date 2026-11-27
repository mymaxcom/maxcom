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
  const view = makeView('2026-11-03', '16:45:05', { settings: { kioskTemplate: { templateId: theme } } });
  const rotation = buildRotation(content, view.settings, view.now);
  const today = view.state.today;
  const month = tarawihMonthFor(view.now, today ? [today] : [], view.settings) ?? view.hijri?.m;
  holder.view = view;
  holder.cv = { content, rotation, current: currentSlot(rotation, view.now), zikir: zikirWindow(view.now, days, view.settings, month, content.zikir.length), override: null };
  return render(<App />);
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((res) => setTimeout(res, 10)); };
const stage = (r: ReturnType<typeof render>) => r.container.querySelector('.stage') as HTMLElement;

let play: ReturnType<typeof vi.spyOn>;
beforeEach(() => { play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve()); });
afterEach(() => { cleanup(); play.mockRestore(); });

describe('the rule', () => {
  it('theme on, Arabic present, Tetapan allows', () => {
    const on = new Set(['arab-ayat', 'arab-hadis', 'arab-zikir']);
    expect(arabLookFor('hadis', on, { arabic: true, tetapanArabic: true })).toBe(true);
    expect(arabLookFor('hadis', on, { arabic: false, tetapanArabic: true })).toBe(false);
    expect(arabLookFor('hadis', on, { arabic: true, tetapanArabic: false })).toBe(false);
    expect(arabLookFor('hadis', new Set(), { arabic: true, tetapanArabic: true })).toBe(false);
    expect(arabLookFor('zikir', new Set(['arab-ayat']), { arabic: true, tetapanArabic: true })).toBe(false);
  });

  it('only Arabic Art turns the looks on among built-ins; a pack opts in by its screen files', () => {
    expect([...arabLooksOf(builtInTheme('arabic'))].sort()).toEqual(['arab-ayat', 'arab-hadis', 'arab-zikir']);
    expect(arabLooksOf(builtInTheme('creative')).size).toBe(0);
    const pack = { ...builtInTheme('creative'), builtIn: false, pack: { screens: ['arab-zikir', 'poster'] } } as unknown as ResolvedTheme;
    expect([...arabLooksOf(pack)]).toEqual(['arab-zikir']);
  });

  it('translation: Tetapan off always hides; the menu only places it (an old sembunyi counts as below)', () => {
    expect(tarjamahMode({ tarjamah: 'sisi' }, false)).toBe('hidden');
    expect(tarjamahMode({}, true)).toBe('below');
    expect(tarjamahMode({ tarjamah: 'sisi' }, true)).toBe('beside');
    expect(tarjamahMode({ tarjamah: 'sembunyi' }, true)).toBe('below');
  });

  it('screenIdOf maps the bases that are in the arab set', () => {
    const state = { phase: 'normal', prayer: null } as never;
    expect(screenIdOf(state, false, 'hadis', new Set(['hadis']))).toBe('arab-hadis');
    expect(screenIdOf(state, false, 'ayatCard', new Set(['ayat']))).toBe('arab-ayat');
    expect(screenIdOf(state, false, 'zikir', new Set(['zikir']))).toBe('arab-zikir');
    expect(screenIdOf(state, false, 'hadis', new Set(['ayat']))).toBe('hadis');
    expect(screenIdOf(state, false, 'arab-hadis')).toBe('arab-hadis');
  });

  it('groupIndices splits verses into balanced contiguous groups', () => {
    expect(groupIndices(5, 1)).toEqual([[0, 1, 2, 3, 4]]);
    expect(groupIndices(5, 2)).toEqual([[0, 1, 2], [3, 4]]);
    expect(groupIndices(2, 5)).toEqual([[0], [1]]);
  });
});

describe('the screens', () => {
  it('in Arabic Art a hadis with Arabic shows as arab-hadis; one without shows as hadis', async () => {
    const a = showCard('hadis');
    await flush();
    expect(stage(a).getAttribute('data-screen')).toBe('arab-hadis');
    expect(stage(a).getAttribute('data-kind')).toBe('content');
    cleanup();
    const { textAr: _ar, ...noAr } = HADIS;
    const b = showCard('hadis', { content: fixture({ hadisToday: [noAr] as never }) });
    await flush();
    expect(stage(b).getAttribute('data-screen')).toBe('hadis');
    cleanup();
    const c = showCard('hadis', { settings: { hadis: { showArabic: false } } });
    await flush();
    expect(stage(c).getAttribute('data-screen')).toBe('hadis');
    cleanup();
    const d = showCard('hadis', { theme: 'creative' });
    await flush();
    expect(stage(d).getAttribute('data-screen')).toBe('hadis');
  });

  it('arab-hadis: the matn leads through Hk, then the translation, the source and the credit', async () => {
    const credit = { ...HADIS, credit: 'HadeethEnc.com', grade: 'sahih' as const };
    const r = showCard('hadis', { content: fixture({ hadisToday: [credit] as never }) });
    await flush();
    const card = r.container.querySelector('.arab-hadis')!;
    expect(card.querySelector('p.hk.ah-ar.arab > .hk-b')!.textContent).toContain('إِنَّمَا');
    expect(card.querySelector('.ah-ms.arab-tarjamah')).toBeTruthy();
    expect(card.querySelector('.ah-src')!.textContent).toContain('Riwayat al-Bukhari dan Muslim');
    expect(card.querySelector('.ah-credit')!.textContent).toBe('Sumber: HadeethEnc.com');
  });

  it('arab-ayat: Arabic leads through Hk with the quran face, translation follows with verse numbers, the credit stays', async () => {
    const r = showCard('ayatCard');
    await flush();
    expect(stage(r).getAttribute('data-screen')).toBe('arab-ayat');
    const card = r.container.querySelector('.arab-ayat')!;
    expect(card.querySelector('p.hk.aa-text.quran > .hk-b')!.textContent).toContain('۝١');
    expect(card.querySelector('p.hk.aa-text.quran > .hk-b')!.textContent).toContain('۝٢');
    expect([...card.querySelectorAll('.aa-tr .tr-n')].map((e) => e.textContent)).toEqual(['1', '2']);
    expect(card.querySelector('.aa-surah')!.textContent).toBe('Surah Al-Kahfi, ayat 1-2');
    expect(card.querySelector('.aa-credit')!.textContent).toContain('Terjemahan: Basmeih');
  });

  it('arab-zikir: 33 beads, the count only when repeat is above 1', async () => {
    const once = showZikir('arabic', fixture({ zikir: [ZIKIR[1]!] as never }));
    await flush();
    expect(stage(once).getAttribute('data-screen')).toBe('arab-zikir');
    expect(once.container.querySelectorAll('.zk-beads circle').length).toBe(33);
    expect(once.container.querySelector('.zk-ar .hk-b')!.textContent).toContain('أَسْتَغْفِرُ');
    expect(once.container.querySelector('.zk-count')).toBeNull();
    cleanup();
    const many = showZikir('arabic', fixture({ zikir: [ZIKIR[0]!] as never }));
    await flush();
    expect(many.container.querySelector('.zk-count b')!.textContent).toBe('33');
  });

  it('the other themes keep the normal zikir overlay and cards', async () => {
    const r = showZikir('creative');
    await flush();
    expect(stage(r).getAttribute('data-screen')).toBe('zikir');
    expect(r.container.querySelector('.arab-zikir')).toBeNull();
    expect(r.container.querySelector('.zikir')).toBeTruthy();
  });

  it('a hadis in parts keeps the normal look', async () => {
    const long = { id: 'hl', attribution: 'Muttafaq alaih', textAr: 'نص', textMs: Array.from({ length: 80 }, (_, i) => `Kalimat nombor ${i + 1} dalam hadis yang sangat panjang sekali.`).join(' ') };
    expect(hadisPlan(long as never, {}).mode).toBe('parts');
    const r = showCard('hadis', { content: fixture({ hadisToday: [long] as never }) });
    await flush();
    expect(stage(r).getAttribute('data-screen')).toBe('hadis');
    expect(r.container.querySelector('.arab-hadis')).toBeNull();
  });

  it('an old stored sembunyi no longer hides the translation: Tetapan alone decides (one control)', async () => {
    const entry = { themeStyle: { styles: { arabic: { semua: { tarjamah: 'sembunyi' }, skrin: {} }, creative: { semua: { tarjamah: 'sembunyi' }, skrin: {} } } } };
    const on = showCard('ayatCard', { settings: entry as never });
    await flush();
    expect(stage(on).getAttribute('data-tarjamah')).not.toBe('hidden');
    expect(on.container.querySelector('.arab-ayat .aa-tr')).toBeTruthy();
    expect(on.container.querySelector('.arab-ayat .aa-text')).toBeTruthy();
    cleanup();
    const normal = showCard('ayatCard', { theme: 'creative', settings: entry as never });
    await flush();
    expect(normal.container.querySelector('.card--ayat .ayat__ms')).toBeTruthy();
  });

  it('F30: an Arabic TV keeps the translation on the arab ayat screen while Tetapan shows it, and drops it when off', async () => {
    const on = showCard('ayatCard', { settings: { language: { lang: 'ar' } } as never });
    await flush();
    expect(on.container.querySelector('.arab-ayat .aa-tr')).toBeTruthy();
    expect(on.container.querySelector('.arab-ayat .aa-credit')!.textContent).toContain('الترجمة');
    cleanup();
    const off = showCard('ayatCard', { settings: { language: { lang: 'ar' }, ayatCard: { showTranslation: false } } as never });
    await flush();
    expect(off.container.querySelector('.arab-ayat .aa-tr')).toBeNull();
  });

  it('Tetapan wins: showTranslation off hides the translation on the arab screen whatever the menu says', async () => {
    const r = showCard('ayatCard', { settings: { ayatCard: { showTranslation: false } } });
    await flush();
    expect(r.container.querySelector('.arab-ayat .aa-tr')).toBeNull();
  });

  it('the preview can force an arab look for any theme', () => {
    const view = makeView('2026-11-03', '15:52');
    const props = { view, lang: 'ms' as const, content: fixture(), itemId: null, startedAt: null, durationSeconds: 20 };
    expect(arabBaseOf('hadis', props, { looks: new Set(), forced: null, style: {} })).toBeNull();
    expect(arabBaseOf('hadis', props, { looks: new Set(), forced: 'arab-hadis', style: {} })).toBe('hadis');
    expect(arabBaseOf('ayatCard', props, { looks: new Set(), forced: 'arab-ayat', style: {} })).toBe('ayat');
    expect(arabBaseOf('kuliahCard', props, { looks: new Set(['arab-ayat']), forced: 'arab-ayat', style: {} })).toBeNull();
  });
});

describe('Tetapan sizes reach the Arabic-led screens (brief 2026-11-16 item 3)', () => {
  it('ayatCard.textSize puts its size class on arab-ayat (M by default)', async () => {
    const m = showCard('ayatCard');
    await flush();
    expect(m.container.querySelector('.arab-ayat')!.classList.contains('is-size-m')).toBe(true);
    cleanup();
    const s = showCard('ayatCard', { settings: { ayatCard: { textSize: 's' } } });
    await flush();
    expect(s.container.querySelector('.arab-ayat')!.classList.contains('is-size-s')).toBe(true);
  });

  it('hadis.fontSize picks the tier of arab-hadis as on the normal hadis screen', async () => {
    const l = showCard('hadis');
    await flush();
    expect(l.container.querySelector('.arab-hadis')!.classList.contains('is-len-l')).toBe(true);
    cleanup();
    const s = showCard('hadis', { settings: { hadis: { fontSize: 's' } } });
    await flush();
    expect(s.container.querySelector('.arab-hadis')!.classList.contains('is-len-s')).toBe(true);
  });
});
