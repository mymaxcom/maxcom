import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { buildCycle, buildRotation, currentSlot, hadisParts, klInstant } from '@surau/core';
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
import { Main } from '../src/screens/Main.tsx';
import { PengumumanCard } from '../src/content/cards/PengumumanCard.tsx';
import { paginateAyat } from '../src/content/cards/AyatCard.tsx';
import { cityTime } from '../src/content/cards/WorldTimesCard.tsx';

const PHOTO = 'a'.repeat(64);
const COVER = 'b'.repeat(64);
const POSTER = 'c'.repeat(64);
const PROGRAM = 'd'.repeat(64);
const base = { updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'test' };

function fixture(over: Partial<KioskContent> = {}): KioskContent {
  return {
    date: '2026-11-03',
    kuliah: [
      {
        ...base, id: 'k1', date: '2026-11-03', slot: 'maghrib', time: '19:15', label: 'Kuliah Maghrib',
        penceramahId: 'p1', kitabId: 'b1', topic: 'Tafsir Surah Al-Kahfi (siri 4)', status: 'aktif',
        penceramah: { name: 'Ustaz Abu Bakar Ahmad', title: 'Ustaz', photoAssetId: PHOTO },
        kitab: { title: 'Tafsir Ibnu Kathir', coverAssetId: COVER },
      },
      {
        ...base, id: 'k2', date: '2026-11-04', slot: 'maghrib', time: '19:15', label: 'Kuliah Maghrib',
        penceramahId: 'p2', status: 'aktif', penceramah: { name: 'Ustaz Hafiz Rahman' },
      },
      {
        ...base, id: 'k3', date: '2026-11-05', slot: 'subuh', time: '06:20', label: 'Kuliah Subuh',
        penceramahId: 'p3', status: 'aktif', penceramah: { name: 'Ustaz Zulkifli Omar' },
      },
    ],
    pengumuman: [
      {
        ...base, id: 'a1', title: 'Gotong-royong perdana', body: 'Semua jemaah dijemput hadir pada Sabtu ini selepas Subuh.',
        from: '2026-11-01', to: '2026-11-10', priority: 1,
      },
    ],
    ticker: [],
    posters: [{ ...base, id: 'po1', title: 'Poster 1', assetId: POSTER, days: ['umum'], order: 1 }],
    programKhas: [
      {
        ...base, id: 'pk1', title: 'Majlis Khatam Al-Quran', at: '2026-11-07T20:30', showFrom: '2026-11-01', showTo: '2026-11-07',
        assetId: PROGRAM, note: 'Jamuan ringan disediakan.', status: 'aktif',
      },
    ],
    takwim: [
      { ...base, id: 't0', date: '2026-11-03', title: 'Mesyuarat AJK', hijriLabel: '23 Jamadilawal' },
      { ...base, id: 't1', date: '2026-11-15', title: 'Kelas Fardu Ain', hijriLabel: '5 Jamadilakhir' },
    ],
    hadisToday: [],
    worldTimes: [],
    tugasan: [],
    ayat: { today: null, tomorrow: null },
    zikir: [],
    tilawah: { slots: [], available: {} },
    credits: { translation: 't', font: 'f', audio: 'a' },
    ...over,
  };
}

function show(content: KioskContent, card: SlotFeature | null, date = '2026-11-03', hhmm = '15:00', opts: ViewOpts = {}) {
  const view = makeView(date, hhmm, opts);
  const cycle = buildCycle(content, view.settings, view.now);
  holder.view = view;
  holder.cv = { content, rotation: cycle.slots, current: currentSlot(cycle.slots, view.now, cycle.cycleStartSec), zikir: null, override: card };
  return render(<Main view={view} lang="ms" />);
}

let play: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
});
afterEach(() => {
  cleanup();
  play.mockRestore();
});

const section = (r: ReturnType<typeof render>) => r.container.querySelector('[data-layer="content"]')!;

describe('KuliahCard', () => {
  it('shows today\'s kuliah with photo, kitab cover, time and the following kuliah', () => {
    const r = show(fixture(), 'kuliahCard');
    const card = section(r).querySelector('[data-card="kuliahCard"]')!;
    expect(card).toBeTruthy();
    expect(card.getAttribute('data-item')).toBe('k1');
    expect(r.getByText('Kuliah hari ini')).toBeTruthy();
    expect(r.getByText('Ustaz Abu Bakar Ahmad')).toBeTruthy();
    expect(r.getByText('Tafsir Surah Al-Kahfi (siri 4)')).toBeTruthy();
    expect(r.getByText(/7:15 malam/)).toBeTruthy();
    expect(card.querySelector(`img[src="/assets/${PHOTO}"]`)).toBeTruthy();
    expect(card.querySelector(`img[src="/assets/${COVER}"]`)).toBeTruthy();
    expect(r.getByText(/Rab 4 Nov, Maghrib/)).toBeTruthy();
    expect(r.getByText(/Ustaz Hafiz Rahman/)).toBeTruthy();
    expect(r.getByText(/Kha 5 Nov, Subuh/)).toBeTruthy();
    expect(r.queryByText('DIBATALKAN')).toBeNull();
  });

  it('says Kuliah seterusnya when the first kuliah is on a later day', () => {
    const c = fixture();
    c.kuliah = c.kuliah.filter((k) => k.id !== 'k1');
    const r = show(c, 'kuliahCard');
    expect(r.getByText('Kuliah seterusnya')).toBeTruthy();
    expect(r.getByText('Ustaz Hafiz Rahman')).toBeTruthy();
  });

  it('shows the DIBATALKAN ribbon for a cancelled kuliah', () => {
    const c = fixture();
    c.kuliah[0]!.status = 'batal';
    const r = show(c, 'kuliahCard');
    expect(r.getByText('DIBATALKAN')).toBeTruthy();
    expect(r.getByText('Ustaz Abu Bakar Ahmad')).toBeTruthy();
  });

  it('hides the photo and the cover when their features are off', () => {
    const r = show(fixture(), 'kuliahCard', '2026-11-03', '15:00', {
      settings: { penceramahPhoto: { enabled: false }, kitabCover: { enabled: false } },
    });
    const card = section(r).querySelector('[data-card="kuliahCard"]')!;
    expect(card.querySelector('img')).toBeNull();
    expect(r.getByText('Ustaz Abu Bakar Ahmad')).toBeTruthy();
  });

  it('renders the photo as a circle or a square per penceramahPhoto.shape', () => {
    const r1 = show(fixture(), 'kuliahCard');
    expect(section(r1).querySelector('.kuliah__photo.is-round')).toBeTruthy();
    cleanup();
    const r2 = show(fixture(), 'kuliahCard', '2026-11-03', '15:00', { settings: { penceramahPhoto: { shape: 'square' } } });
    expect(section(r2).querySelector('.kuliah__photo.is-square')).toBeTruthy();
  });

  it('never emits an image for an asset id that is not a sha256 hex', () => {
    const c = fixture();
    c.kuliah[0]!.penceramah.photoAssetId = 'https://evil.example/x.png';
    c.kuliah[0]!.kitab!.coverAssetId = '../../etc/passwd';
    const r = show(c, 'kuliahCard');
    expect(section(r).querySelector('img')).toBeNull();
    expect(r.getByText('Tafsir Ibnu Kathir')).toBeTruthy(); // kitab title still shown as text
  });

  it('skips today\'s kuliah once it is well past and shows the next one', () => {
    const r = show(fixture(), 'kuliahCard', '2026-11-03', '22:30');
    expect(r.getByText('Kuliah seterusnya')).toBeTruthy();
    expect(r.getByText('Ustaz Hafiz Rahman')).toBeTruthy();
  });
});

describe('PengumumanCard', () => {
  it('tells the content layer when its item is missing, so the screen goes idle', () => {
    const onRendered = vi.fn();
    const c = fixture();
    const r = render(
      <PengumumanCard view={holder.view} lang="ms" content={c} itemId="nope" startedAt={null} durationSeconds={10} onRendered={onRendered} />,
    );
    expect(r.container.querySelector('[data-card="pengumuman"]')).toBeNull();
    expect(onRendered).toHaveBeenLastCalledWith(false);
  });

  it('renders header, title and body; priority 1 is marked', () => {
    const r = show(fixture(), 'pengumuman');
    const card = section(r).querySelector('[data-card="pengumuman"]')!;
    expect(card.getAttribute('data-item')).toBe('a1');
    expect(r.getByText('Pengumuman')).toBeTruthy();
    expect(r.getByText('Gotong-royong perdana')).toBeTruthy();
    expect(r.getByText(/Semua jemaah dijemput/)).toBeTruthy();
    expect(card.classList.contains('is-priority')).toBe(true);
  });

  it('priority 2 is not marked', () => {
    const c = fixture();
    c.pengumuman[0]!.priority = 2;
    const r = show(c, 'pengumuman');
    expect(section(r).querySelector('[data-card="pengumuman"]')!.classList.contains('is-priority')).toBe(false);
  });
});

describe('PosterCard', () => {
  it('renders the poster image only, no text', () => {
    const r = show(fixture(), 'posters');
    const card = section(r).querySelector('[data-card="posters"]')!;
    const img = card.querySelector('img[data-item="po1"]')!;
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe(`/assets/${POSTER}`);
    expect(card.textContent!.trim()).toBe('');
  });

  it('drops the poster when its picture cannot be loaded (no black box with a broken-image icon)', async () => {
    const r = show(fixture(), 'posters');
    const img = section(r).querySelector('img[data-item="po1"]')!;
    img.dispatchEvent(new Event('error'));
    await Promise.resolve();
    await new Promise((res) => setTimeout(res, 0));
    expect(section(r).querySelector('[data-card="posters"]')).toBeNull();
  });

  it('renders no image for a bad asset id', () => {
    const c = fixture();
    c.posters[0]!.assetId = 'javascript:alert(1)';
    const r = show(c, 'posters');
    expect(section(r).querySelector('img')).toBeNull();
  });

  it('never shows its title on the TV', () => {
    const c = fixture();
    c.posters[0]!.title = 'Kempen Derma Surau <b>x</b>';
    const r = show(c, 'posters');
    expect(r.container.textContent).not.toContain('Kempen Derma');
  });
});

// The poster takes the whole screen; the normal chrome gives way to one thin strip.
describe('Poster takeover (full screen + strip)', () => {
  const LOGO = '/surau-logo?v=0123456789abcdef';
  // Effects chain two levels deep (card -> layer -> Main) and Preact runs each after paint (~a few tens of
  // ms in jsdom): give it time rather than microtasks.
  const flush = async () => {
    for (let i = 0; i < 8; i++) await new Promise((res) => setTimeout(res, 10));
  };
  const strip = (r: ReturnType<typeof render>) => r.container.querySelector('[data-testid="poster-strip"]');
  const screen = (r: ReturnType<typeof render>) => r.container.querySelector('.screen--main')!;

  it('marks the screen, hides the identity block and next box, and shows clock + countdown + surau in the strip', async () => {
    const r = show(fixture(), 'posters', '2026-11-03', '15:52', {
      settings: { surauInfo: { name: 'Surau Al-Hidayah' } },
    });
    await flush();
    expect(screen(r).classList.contains('is-poster')).toBe(true);
    expect(screen(r).getAttribute('data-poster')).toBe('true');
    expect(r.container.querySelector('.ident')!.getAttribute('aria-hidden')).toBe('true');
    expect(r.container.querySelector('.next')!.getAttribute('aria-hidden')).toBe('true');
    const s = strip(r)!;
    expect(s).toBeTruthy();
    expect(s.querySelector('[data-role="clock"]')!.textContent).toContain('3:52');
    expect(s.querySelector('.poster-strip__name')!.textContent).toBe('Surau Al-Hidayah');
    expect(s.querySelector('.poster-strip__label')!.textContent).toBe('Asar dalam');
    expect(s.querySelector('.poster-strip__cd')!.textContent).toBe('00:28:00');
    expect(s.querySelector('img[data-role="logo"]')).toBeNull();
    // The prayer bar is still in the DOM (it fades out in CSS) and the poster is the only card.
    expect(r.container.querySelector('.pbar')).toBeTruthy();
    expect(section(r).querySelectorAll('[data-card]').length).toBe(1);
  });

  it('carries the surau logo small in the strip when the bundle has one', async () => {
    const r = show(fixture(), 'posters', '2026-11-03', '15:52', { logo: LOGO });
    await flush();
    const img = strip(r)!.querySelector('img[data-role="logo"]')!;
    expect(img.getAttribute('src')).toBe(LOGO);
    expect(img.classList.contains('poster-strip__logo')).toBe(true);
  });

  it('shows seconds and the 24h clock in the strip when the clock settings say so', async () => {
    const r = show(fixture(), 'posters', '2026-11-03', '15:52:07', {
      settings: { prayerBar: { timeFormat: '24h' }, clock: { showSeconds: true } },
    });
    await flush();
    const clock = strip(r)!.querySelector('[data-role="clock"]')!;
    expect(clock.textContent).toContain('15:52');
    expect(clock.textContent).toContain('07');
  });

  it('is the normal layout for every other card', async () => {
    const r = show(fixture(), 'kuliahCard');
    await flush();
    expect(screen(r).classList.contains('is-poster')).toBe(false);
    expect(screen(r).getAttribute('data-poster')).toBe('false');
    expect(strip(r)).toBeNull();
    expect(r.container.querySelector('.ident')!.getAttribute('aria-hidden')).toBeNull();
  });

  it('leaves poster mode again when the picture fails to load', async () => {
    const r = show(fixture(), 'posters');
    await flush();
    expect(screen(r).classList.contains('is-poster')).toBe(true);
    section(r).querySelector('img[data-item="po1"]')!.dispatchEvent(new Event('error'));
    await flush();
    expect(screen(r).classList.contains('is-poster')).toBe(false);
    expect(strip(r)).toBeNull();
    expect(section(r).querySelector('[data-card="posters"]')).toBeNull();
  });

  it('never enters poster mode for a poster whose asset id is not a box asset', async () => {
    const c = fixture();
    c.posters[0]!.assetId = 'javascript:alert(1)';
    const r = show(c, 'posters');
    await flush();
    expect(screen(r).classList.contains('is-poster')).toBe(false);
    expect(strip(r)).toBeNull();
  });

  it('switches cleanly when the rotation moves from a poster to another card', async () => {
    const c = fixture();
    const view = makeView('2026-11-03', '15:52');
    const rotation = buildRotation(c, view.settings, view.now);
    holder.view = view;
    holder.cv = { content: c, rotation, current: currentSlot(rotation, view.now), zikir: null, override: 'posters' };
    const r = render(<Main view={view} lang="ms" />);
    await flush();
    expect(screen(r).classList.contains('is-poster')).toBe(true);
    holder.cv = { ...holder.cv, override: 'pengumuman' };
    r.rerender(<Main view={view} lang="ms" />);
    await flush();
    expect(screen(r).classList.contains('is-poster')).toBe(false);
    expect(strip(r)).toBeNull();
    expect(section(r).querySelector('[data-card="pengumuman"]')).toBeTruthy();
  });

  // The prayer sequence always wins: a poster slot during a phase must not show, nor its strip.
  it.each([
    ['azan countdown 16:12', '16:12', 'azanCountdown'],
    ['masuk waktu 16:20:10', '16:20:10', 'masukWaktu'],
    ['iqamah countdown 16:25', '16:25', 'iqamah'],
    ['solat 16:35', '16:35', 'solat'],
    ['syuruk warning 06:52', '06:52', 'syuruk'],
    ['khutbah Jumaat 13:05', '13:05', 'khutbah'],
  ])('shows nothing of a poster slot during %s', async (_n, hhmm, phase) => {
    const c = fixture();
    const date = phase === 'khutbah' ? '2026-11-06' : '2026-11-03';
    const view = makeView(date, hhmm);
    const rotation = buildRotation(c, view.settings, view.now);
    holder.view = view;
    holder.cv = { content: c, rotation, current: currentSlot(rotation, view.now), zikir: null, override: 'posters' };
    const r = render(<App />);
    await flush();
    expect(r.container.querySelector('.stage')!.getAttribute('data-phase')).toBe(phase);
    expect(r.container.querySelector('[data-layer="content"]')).toBeNull();
    expect(r.container.querySelector('[data-card="posters"]')).toBeNull();
    expect(r.container.querySelector('.card--poster')).toBeNull();
    expect(r.container.querySelector('[data-testid="poster-strip"]')).toBeNull();
    expect(r.container.querySelector('.is-poster')).toBeNull();
    expect(r.container.querySelector('.pbar')).toBeTruthy();
  });

  it('shows nothing of a poster slot on the no-data screen', async () => {
    const c = fixture();
    const view = makeView('2027-01-01', '09:00');
    holder.view = view;
    holder.cv = { content: c, rotation: [], current: null, zikir: null, override: 'posters' };
    const r = render(<App />);
    await flush();
    expect(r.container.querySelector('.stage')!.getAttribute('data-phase')).toBe('noData');
    expect(r.container.querySelector('.card--poster')).toBeNull();
    expect(r.container.querySelector('[data-testid="poster-strip"]')).toBeNull();
  });

  it('a poster slot in the normal phase through App takes over, with the strip', async () => {
    const c = fixture();
    const view = makeView('2026-11-03', '15:52');
    const rotation = buildRotation(c, view.settings, view.now);
    holder.view = view;
    holder.cv = { content: c, rotation, current: currentSlot(rotation, view.now), zikir: null, override: 'posters' };
    const r = render(<App />);
    await flush();
    expect(r.container.querySelector('.stage')!.getAttribute('data-phase')).toBe('normal');
    expect(r.container.querySelector('.screen--main.is-poster')).toBeTruthy();
    expect(r.container.querySelector('[data-testid="poster-strip"]')).toBeTruthy();
  });
});

describe('ProgramKhasCard', () => {
  it('shows title, long date with time, note and image', () => {
    const r = show(fixture(), 'programKhas');
    const card = section(r).querySelector('[data-card="programKhas"]')!;
    expect(card.getAttribute('data-item')).toBe('pk1');
    expect(r.getByText('Program khas')).toBeTruthy();
    expect(r.getByText('Majlis Khatam Al-Quran')).toBeTruthy();
    expect(r.getByText('Sabtu, 7 November 2026, 8:30 malam')).toBeTruthy();
    expect(r.getByText('Jamuan ringan disediakan.')).toBeTruthy();
    expect(card.querySelector(`img[src="/assets/${PROGRAM}"]`)).toBeTruthy();
  });

  it('shows the DIBATALKAN ribbon when cancelled', () => {
    const c = fixture();
    c.programKhas[0]!.status = 'batal';
    const r = show(c, 'programKhas');
    expect(r.getByText('DIBATALKAN')).toBeTruthy();
  });
});

describe('TakwimCard', () => {
  it('counts days left in KL dates; today reads Hari ini', () => {
    const r = show(fixture(), 'takwim');
    expect(r.getByText('Takwim')).toBeTruthy();
    expect(r.getByText('Hari ini')).toBeTruthy();
    expect(r.getByText('12')).toBeTruthy();
    expect(r.getByText('Kelas Fardu Ain')).toBeTruthy();
    expect(r.getByText('5 Jamadilakhir')).toBeTruthy();
    expect(section(r).querySelectorAll('.takwim__row').length).toBe(2);
  });

  it('respects takwim.count', () => {
    const r = show(fixture(), 'takwim', '2026-11-03', '15:00', { settings: { takwim: { count: 1 } } });
    expect(section(r).querySelectorAll('.takwim__row').length).toBe(1);
  });
});

describe('ContentLayer', () => {
  it('renders the current rotation slot when there is no override', () => {
    const c = fixture();
    const view = makeView('2026-11-03', '00:00:20'); // 20 s into the day: second slot (pengumuman, order 2)
    const rotation = buildRotation(c, view.settings, view.now);
    holder.view = view;
    holder.cv = { content: c, rotation, current: currentSlot(rotation, view.now), zikir: null, override: null };
    const r = render(<Main view={view} lang="ms" />);
    expect(section(r).querySelector('[data-card="pengumuman"]')).toBeTruthy();
    expect(section(r).querySelectorAll('[data-card]').length).toBe(1);
  });

  it('leaves the section empty when the rotation is empty', () => {
    const r = show(fixture(), null, '2026-11-03', '15:00', {
      settings: {
        kuliahCard: { enabled: false }, pengumuman: { enabled: false }, posters: { enabled: false },
        programKhas: { enabled: false }, takwim: { enabled: false },
      },
    });
    expect(section(r)).toBeTruthy();
    expect(section(r).children.length).toBe(0);
  });

  it('leaves the section empty when there is no content yet', () => {
    const view = makeView('2026-11-03', '15:00');
    holder.view = view;
    holder.cv = { content: null, rotation: [], current: null, zikir: null, override: 'kuliahCard' };
    const r = render(<Main view={view} lang="ms" />);
    expect(section(r).children.length).toBe(0);
  });

  it('override wins only when the feature has content', () => {
    const c = fixture({ posters: [] });
    const r = show(c, 'posters');
    expect(section(r).children.length).toBe(0);
  });

  it('renders nothing from the content layer in a prayer phase (solat 16:35)', () => {
    const c = fixture();
    const view = makeView('2026-11-03', '16:35');
    const rotation = buildRotation(c, view.settings, view.now);
    holder.view = view;
    holder.cv = { content: c, rotation, current: currentSlot(rotation, view.now), zikir: null, override: 'kuliahCard' };
    const r = render(<App />);
    expect(r.container.querySelector('.stage')!.getAttribute('data-phase')).toBe('solat');
    expect(r.container.querySelector('[data-layer="content"]')).toBeNull();
    expect(r.container.querySelector('[data-card]')).toBeNull();
    expect(r.queryByText('Ustaz Abu Bakar Ahmad')).toBeNull();
  });

  it('renders the content layer through App in the normal phase', () => {
    const c = fixture();
    const view = makeView('2026-11-03', '15:52');
    const rotation = buildRotation(c, view.settings, view.now);
    holder.view = view;
    holder.cv = { content: c, rotation, current: currentSlot(rotation, view.now), zikir: null, override: 'kuliahCard' };
    const r = render(<App />);
    expect(r.container.querySelector('[data-layer="content"] [data-card="kuliahCard"]')).toBeTruthy();
    expect(klInstant('2026-11-03', '15:52').getTime()).toBe(view.now.getTime());
  });
});

// ---- Plan 2 Task 10: hadis, world times, tugasan, ayat ----------------------------------------

const QURANENC = 'apps/box-server/test/fixtures/quranenc-sura-2.json';
const quranencPath = [QURANENC, `../../${QURANENC}`].map((p) => resolve(process.cwd(), p)).find(existsSync);
if (!quranencPath) throw new Error(`fixture not found from ${process.cwd()}`);
const quranenc = JSON.parse(readFileSync(quranencPath, 'utf8')) as { result: { aya: string; arabic_text: string; translation: string }[] };
const ayaRow = (n: number) => quranenc.result.find((r) => r.aya === String(n))!;

const HADIS = {
  id: 'h1', attribution: 'Riwayat al-Bukhari dan Muslim',
  textAr: 'إِنَّمَا الْأَعْمَالُ بِالنِّيَّاتِ',
  textMs: 'Sesungguhnya setiap amalan itu bergantung kepada niat.',
};
const PROVIDER = {
  id: 'hadeethenc-66512', title: 'Islam itu dibina atas lima perkara', grade: 'sahih' as const,
  intro: 'Daripada Ibnu Umar, beliau berkata: Rasulullah bersabda:',
  textMs: 'Daripada Ibnu Umar, beliau berkata: Rasulullah bersabda: Islam itu dibina atas lima perkara.',
  textAr: 'بني الإسلام على خمس',
  attribution: 'Muttafaq alaih', attributionLong: 'Riwayat al-Bukhari dan Muslim', credit: 'HadeethEnc.com' as const,
};
const LONG_SAMPLE = (() => {
  const p = [QURANENC, `../../${QURANENC}`]
    .map((x) => resolve(process.cwd(), x.replace('quranenc-sura-2.json', 'hadeethenc/one-66513.json')))
    .find(existsSync);
  if (!p) throw new Error('fixture one-66513 not found');
  return JSON.parse(readFileSync(p, 'utf8')) as { hadeeth: string; hadeeth_ar: string; hadeeth_intro: string };
})();
const LONG = {
  id: 'hadeethenc-66513', grade: 'sahih' as const, intro: LONG_SAMPLE.hadeeth_intro, textMs: LONG_SAMPLE.hadeeth, textAr: LONG_SAMPLE.hadeeth_ar,
  attribution: 'Muttafaq alaih', attributionLong: 'Riwayat al-Bukhari dan Muslim', credit: 'HadeethEnc.com' as const,
};
const hadisCard = (r: ReturnType<typeof render>) => section(r).querySelector('[data-card="hadis"]')!;

describe('HadisCard', () => {
  it('shows header, Arabic right-to-left, Malay text and the source', () => {
    const r = show(fixture({ hadisToday: [HADIS] }), 'hadis');
    const card = hadisCard(r);
    expect(card).toBeTruthy();
    expect(card.getAttribute('data-item')).toBe('h1');
    expect(r.getByText('Hadis')).toBeTruthy();
    const ar = card.querySelector('[dir="rtl"]')!;
    expect(ar).toBeTruthy();
    expect(ar.textContent).toContain('إِنَّمَا');
    expect(r.getByText(/Sesungguhnya setiap amalan/)).toBeTruthy();
    expect(r.getByText('Riwayat al-Bukhari dan Muslim')).toBeTruthy();
  });

  it('omits the Arabic block when the hadis has none', () => {
    const { textAr: _ar, ...noAr } = HADIS;
    const r = show(fixture({ hadisToday: [noAr] }), 'hadis');
    expect(hadisCard(r).querySelector('[dir="rtl"]')).toBeNull();
    expect(r.getByText(/Sesungguhnya/)).toBeTruthy();
  });

  it('an own-list card has no grade chip and no credit; an unstated source prints no attribution', () => {
    const own = show(fixture({ hadisToday: [HADIS] }), 'hadis');
    expect(hadisCard(own).querySelector('.hadis__grade')).toBeNull();
    expect(hadisCard(own).querySelector('.hadis__credit')).toBeNull();
    cleanup();
    const none = show(fixture({ hadisToday: [{ ...HADIS, attribution: null }] }), 'hadis');
    expect(hadisCard(none).querySelector('.hadis__src')).toBeNull();
    expect(hadisCard(none).textContent).not.toMatch(/Tidak dinyatakan/);
  });

  it('a HadeethEnc card has the grade chip, Muttafaq alaih with the kitab names, and the credit', () => {
    const r = show(fixture({ hadisToday: [PROVIDER] }), 'hadis');
    const card = hadisCard(r);
    expect(card.querySelector('.hadis__grade')!.textContent).toBe('Sahih');
    expect(card.querySelector('.hadis__src')!.textContent).toBe('Muttafaq alaih (al-Bukhari dan Muslim)');
    expect(card.querySelector('.hadis__credit')!.textContent).toBe('Sumber: HadeethEnc.com');
    // the opening sentence is part of the single card, styled apart
    expect(card.querySelector('.hadis__intro')!.textContent).toContain('Daripada Ibnu Umar');
    expect(card.querySelector('[dir="rtl"]')).toBeTruthy();
    expect(card.getAttribute('data-page')).toBeNull();
  });

  it('a short attribution is printed as it is, with no brackets', () => {
    const r = show(fixture({ hadisToday: [{ ...PROVIDER, attribution: 'Riwayat Muslim', attributionLong: undefined }] }), 'hadis');
    expect(hadisCard(r).querySelector('.hadis__src')!.textContent).toBe('Riwayat Muslim');
  });

  it('the fields settings hide Arabic, attribution and grade, but never the credit', () => {
    const r = show(fixture({ hadisToday: [PROVIDER] }), 'hadis', '2026-11-03', '15:00', {
      settings: { hadis: { showArabic: false, showAttribution: false, showGrade: false } },
    });
    const card = hadisCard(r);
    expect(card.querySelector('[dir="rtl"]')).toBeNull();
    expect(card.querySelector('.hadis__src')).toBeNull();
    expect(card.querySelector('.hadis__grade')).toBeNull();
    expect(card.querySelector('.hadis__credit')!.textContent).toBe('Sumber: HadeethEnc.com');
    expect(r.getByText(/Islam itu dibina/)).toBeTruthy();
  });

  it('showMalay off keeps the Malay when there is no Arabic, and hides it when the Arabic stands in', () => {
    const off = { hadis: { showMalay: false } };
    const withAr = show(fixture({ hadisToday: [HADIS] }), 'hadis', '2026-11-03', '15:00', { settings: off });
    expect(hadisCard(withAr).querySelector('.hadis__ms')).toBeNull();
    expect(hadisCard(withAr).querySelector('[dir="rtl"]')).toBeTruthy();
    cleanup();
    const { textAr: _ar, ...noAr } = HADIS;
    const noArabic = show(fixture({ hadisToday: [noAr] }), 'hadis', '2026-11-03', '15:00', { settings: off });
    expect(noArabic.getByText(/Sesungguhnya/)).toBeTruthy();
  });

  it('a long hadis shows in parts, with no Arabic and no opening sentence, and the part follows the slot', () => {
    const parts = hadisParts(LONG.textMs.slice(LONG.intro.length).trim());
    expect(parts.length).toBeGreaterThanOrEqual(3);
    const content = fixture({ hadisToday: [LONG], kuliah: [], pengumuman: [], posters: [], programKhas: [], takwim: [] });
    // only the hadis card is in the cycle: its parts run back to back, each for the full card time (20 s)
    const first = show(content, null, '2026-11-03', '00:00');
    let card = hadisCard(first);
    expect(card.getAttribute('data-page')).toBe('0');
    expect(card.querySelector('.hadis__parts-label')!.textContent).toBe(`Bahagian 1 daripada ${parts.length}`);
    expect(card.querySelectorAll('.hadis__dots i')).toHaveLength(parts.length);
    expect(card.querySelectorAll('.hadis__dots i.is-on')).toHaveLength(1);
    expect(card.querySelector('[dir="rtl"]')).toBeNull();
    expect(card.querySelector('.hadis__intro')).toBeNull();
    expect(card.querySelector('.hadis__ms')!.textContent).toBe(parts[0]);
    expect(card.querySelector('.hadis__credit')!.textContent).toBe('Sumber: HadeethEnc.com');
    cleanup();
    const second = show(content, null, '2026-11-03', '00:00:25');
    card = hadisCard(second);
    expect(card.getAttribute('data-page')).toBe('1');
    expect(card.querySelector('.hadis__parts-label')!.textContent).toBe(`Bahagian 2 daripada ${parts.length}`);
    expect(card.querySelector('.hadis__ms')!.textContent).toBe(parts[1]);
  });

  it('a chosen size larger than the text allows falls back to the one that fits', () => {
    const medium = { ...HADIS, textMs: 'x'.repeat(230), textAr: undefined };
    const auto = show(fixture({ hadisToday: [medium] }), 'hadis', '2026-11-03', '15:00', { settings: { hadis: { fontSize: 'auto' } } });
    const autoClass = [...hadisCard(auto).classList].find((c) => c.startsWith('is-len-'))!;
    cleanup();
    const big = show(fixture({ hadisToday: [medium] }), 'hadis', '2026-11-03', '15:00', { settings: { hadis: { fontSize: 'l' } } });
    expect([...hadisCard(big).classList]).toContain(autoClass);
    cleanup();
    const small = show(fixture({ hadisToday: [{ ...HADIS, textMs: 'Pendek.', textAr: undefined }] }), 'hadis', '2026-11-03', '15:00', { settings: { hadis: { fontSize: 's' } } });
    expect([...hadisCard(small).classList]).toContain('is-len-s');
  });

  it('the ?card=hadis override shows the first hadis of the day, first part', () => {
    const r = show(fixture({ hadisToday: [PROVIDER, LONG] }), 'hadis');
    expect(hadisCard(r).getAttribute('data-item')).toBe('hadeethenc-66512');
  });

  it('an empty pool shows no hadis card at all', () => {
    const r = show(fixture({ hadisToday: [] }), 'hadis');
    expect(hadisCard(r)).toBeNull();
  });
});

describe('WorldTimesCard', () => {
  const cities = [
    { ...base, id: 'w1', city: 'Makkah', tz: 'Asia/Riyadh', order: 1 },
    { ...base, id: 'w2', city: 'Nowhere', tz: 'Nowhere/Nope', order: 2 },
    { ...base, id: 'w3', city: 'London', tz: 'Europe/London', order: 3 },
  ];

  it('shows each valid city with a time and its offset from KL; an invalid tz is skipped, never throws', () => {
    const r = show(fixture({ worldTimes: cities }), 'worldTimes');
    expect(r.getByText('Waktu dunia')).toBeTruthy();
    expect(r.getByText('Makkah')).toBeTruthy();
    expect(r.getByText('London')).toBeTruthy();
    expect(r.queryByText('Nowhere')).toBeNull();
    const tiles = section(r).querySelectorAll('.wt__tile');
    expect(tiles.length).toBe(2);
    expect(tiles[0]!.querySelector('.wt__time')!.textContent).toMatch(/^\d{1,2}:\d\d$/);
    // 15:00 KL on 3 Nov 2026 is 10:00 in Riyadh (-5 h) and 07:00 in London (-8 h, GMT after the DST end).
    expect(tiles[0]!.querySelector('.wt__time')!.textContent).toBe('10:00');
    expect(tiles[0]!.querySelector('.wt__offset')!.textContent).toMatch(/[-−]5 j/);
    expect(tiles[1]!.querySelector('.wt__time')!.textContent).toBe('7:00');
    expect(tiles[1]!.querySelector('.wt__offset')!.textContent).toMatch(/[-−]8 j/);
  });

  it('cityTime is DST-aware and returns null for an invalid zone', () => {
    const summer = cityTime('Europe/London', klInstant('2026-07-03', '15:00'), '24h', 'ms');
    expect(summer).toEqual(expect.objectContaining({ time: '08:00', offsetMin: -7 * 60 }));
    const winter = cityTime('Europe/London', klInstant('2026-11-03', '15:00'), '24h', 'ms');
    expect(winter).toEqual(expect.objectContaining({ time: '07:00', offsetMin: -8 * 60 }));
    const half = cityTime('Asia/Kolkata', klInstant('2026-11-03', '15:00'), '12h', 'ms');
    expect(half).toEqual(expect.objectContaining({ time: '12:30', offsetMin: -150 }));
    expect(cityTime('Nowhere/Nope', klInstant('2026-11-03', '15:00'), '12h', 'ms')).toBeNull();
  });

  it('shows at most six cities, by order', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...base, id: `w${i}`, city: `Bandar ${i}`, tz: 'Asia/Tokyo', order: 8 - i }));
    const r = show(fixture({ worldTimes: many }), 'worldTimes');
    const names = [...section(r).querySelectorAll('.wt__city')].map((n) => n.textContent);
    expect(names.length).toBe(6);
    expect(names[0]).toBe('Bandar 7');
  });
});

describe('TugasanCard', () => {
  const tugasan = [
    { ...base, id: 'g1', date: '2026-11-03', role: 'imam' as const, petugasId: 'x1', petugas: { name: 'Haji Rosli Hamid', photoAssetId: PHOTO } },
    { ...base, id: 'g2', date: '2026-11-03', role: 'bilal' as const, petugasId: 'x2', petugas: { name: 'Encik Faizal Karim' } },
    { ...base, id: 'g3', date: '2026-11-06', role: 'khatib' as const, petugasId: 'x3', petugas: { name: 'Ustaz Zaidi Musa' } },
    { ...base, id: 'g4', date: '2026-11-06', role: 'ajk' as const, petugasId: 'x4', petugas: { name: 'Encik Azman Idris' } },
    { ...base, id: 'g5', date: '2026-11-01', role: 'imam' as const, petugasId: 'x5', petugas: { name: 'Sudah Lepas' } },
    { ...base, id: 'g6', date: '2026-12-25', role: 'imam' as const, petugasId: 'x6', petugas: { name: 'Terlalu Jauh' } },
  ];

  it('groups the coming days by date with role labels and the petugas photo', () => {
    const r = show(fixture({ tugasan }), 'tugasan');
    const card = section(r).querySelector('[data-card="tugasan"]')!;
    expect(card).toBeTruthy();
    expect(r.getByText('Tugasan')).toBeTruthy();
    expect(r.getByText('Imam')).toBeTruthy();
    expect(r.getByText('Bilal')).toBeTruthy();
    expect(r.getByText('Khatib')).toBeTruthy();
    expect(r.getByText('AJK bertugas')).toBeTruthy();
    expect(r.getByText('Haji Rosli Hamid')).toBeTruthy();
    expect(card.querySelector(`img[src="/assets/${PHOTO}"]`)).toBeTruthy();
    expect(r.getByText('Hari ini')).toBeTruthy();
    expect(r.getByText(/Jum 6 Nov/)).toBeTruthy();
    expect(card.querySelectorAll('.tugasan__day').length).toBe(2);
    expect(r.queryByText('Sudah Lepas')).toBeNull();
    expect(r.queryByText('Terlalu Jauh')).toBeNull();
  });
});

describe('AyatCard', () => {
  const short = ayaRow(2);
  const kursi = ayaRow(255);
  const ayatShort = {
    surah: 2, surahNameAr: 'البقرة', surahNameMs: 'Al-Baqarah', ayatFrom: 2, ayatTo: 2,
    arabic: [short.arabic_text], malay: [short.translation], translationVersion: 'unlisted',
  };
  const credits = { translation: 'Terjemahan: Abdullah Basmeih (QuranEnc.com)', font: 'Tulisan Al-Quran: KFGQPC Uthmanic Hafs', audio: 'a' };

  it('renders header, surah line, Arabic right-to-left verbatim, Malay and the credit', () => {
    const r = show(fixture({ ayat: { today: ayatShort, tomorrow: null }, credits }), 'ayatCard');
    const card = section(r).querySelector('[data-card="ayatCard"]')!;
    expect(card).toBeTruthy();
    expect(r.getByText('Ayat hari ini')).toBeTruthy();
    expect(r.getByText('Surah Al-Baqarah (2): 2')).toBeTruthy();
    const ar = card.querySelector('[dir="rtl"]')!;
    expect(ar).toBeTruthy();
    expect(ar.textContent).toContain(short.arabic_text); // verbatim, no normalisation
    expect(r.getByText(/Kitab Al-Quran ini, tidak ada sebarang syak/)).toBeTruthy();
    expect(r.getByText(/Terjemahan: Abdullah Basmeih \(QuranEnc\.com\)/)).toBeTruthy();
    expect(card.classList.contains('is-size-m')).toBe(true);
  });

  it('hides the translation when showTranslation is false; textSize maps to a class', () => {
    const r = show(fixture({ ayat: { today: ayatShort, tomorrow: null }, credits }), 'ayatCard', '2026-11-03', '15:00', {
      settings: { ayatCard: { showTranslation: false, textSize: 'l' } },
    });
    const card = section(r).querySelector('[data-card="ayatCard"]')!;
    expect(card.querySelector('[dir="rtl"]')!.textContent).toContain(short.arabic_text);
    expect(r.queryByText(/Kitab Al-Quran ini/)).toBeNull();
    expect(r.getByText(/Terjemahan: Abdullah Basmeih/)).toBeTruthy(); // credit stays
    expect(card.classList.contains('is-size-l')).toBe(true);
  });

  it('pages a range of up to four ayat per page and splits a long ayat into Arabic then translation pages', () => {
    // Five of the shortest ayat (2:1) fit on one page by size, yet the four-per-page cap splits them 4 + 1.
    const a = ayaRow(1).arabic_text;
    const m = ayaRow(1).translation;
    const pages = paginateAyat({ arabic: [a, a, a, a, a], malay: [m, m, m, m, m] }, { showTranslation: true, textSize: 'm' });
    expect(pages.length).toBe(2);
    expect(pages[0]).toEqual(expect.objectContaining({ from: 0, to: 3, mode: 'both' }));
    expect(pages[1]).toEqual(expect.objectContaining({ from: 4, to: 4, mode: 'both' }));

    const long = paginateAyat({ arabic: [kursi.arabic_text], malay: [kursi.translation] }, { showTranslation: true, textSize: 'm' });
    expect(long.map((p) => p.mode)).toEqual(['arabic', 'malay']);
    const noMs = paginateAyat({ arabic: [kursi.arabic_text], malay: [kursi.translation] }, { showTranslation: false, textSize: 'm' });
    expect(noMs.map((p) => p.mode)).toEqual(['arabic']);
  });

  it('shows the page for the moment: durationSeconds / pages each, from the slot start', () => {
    const today = {
      ...ayatShort, ayatFrom: 255, ayatTo: 255, arabic: [kursi.arabic_text], malay: [kursi.translation],
    };
    // 20 s slot, 2 pages -> 10 s per page; with the override the clock since KL midnight drives the page.
    const r1 = show(fixture({ ayat: { today, tomorrow: null }, credits }), 'ayatCard', '2026-11-03', '15:00:00');
    const c1 = section(r1).querySelector('[data-card="ayatCard"]')!;
    expect(c1.getAttribute('data-page')).toBe('1/2');
    expect(c1.querySelector('[dir="rtl"]')!.textContent).toContain(kursi.arabic_text);
    expect(r1.queryByText(/Allah, tiada Tuhan/)).toBeNull();
    cleanup();
    const r2 = show(fixture({ ayat: { today, tomorrow: null }, credits }), 'ayatCard', '2026-11-03', '15:00:12');
    const c2 = section(r2).querySelector('[data-card="ayatCard"]')!;
    expect(c2.getAttribute('data-page')).toBe('2/2');
    expect(c2.querySelector('[dir="rtl"]')).toBeNull();
    expect(r2.getByText(/Allah, tiada Tuhan/)).toBeTruthy();
    expect(r2.getByText(/Terjemahan: Abdullah Basmeih/)).toBeTruthy();
  });
});

// Nothing in the band (a new surau with no cards): the header takes the screen (styles.css `.is-idle`).
describe('Idle main screen (no card in the band)', () => {
  const flush = async () => {
    for (let i = 0; i < 8; i++) await new Promise((res) => setTimeout(res, 10));
  };
  const screen = (r: ReturnType<typeof render>) => r.container.querySelector('.screen--main')!;
  const empty = () =>
    fixture({
      kuliah: [], pengumuman: [], posters: [], programKhas: [], takwim: [], hadisToday: [], worldTimes: [], tugasan: [],
      ayat: { ...fixture().ayat, today: null }, tabung: null,
    } as Partial<KioskContent>);

  it('is idle when no card is on screen, with the clock, the date and the next prayer still there', async () => {
    const r = show(empty(), null);
    await flush();
    expect(section(r).querySelector('[data-card]')).toBeNull();
    expect(screen(r).classList.contains('is-idle')).toBe(true);
    expect(screen(r).getAttribute('data-idle')).toBe('true');
    expect(r.container.querySelector('[data-role="clock"]')).toBeTruthy();
    expect(r.container.querySelector('.next')).toBeTruthy();
  });

  it('is not idle while a card is showing (the layout stays as it was)', async () => {
    const r = show(fixture(), 'kuliahCard');
    await flush();
    expect(screen(r).classList.contains('is-idle')).toBe(false);
    expect(screen(r).getAttribute('data-idle')).toBe('false');
  });

  it('a poster is never idle; a poster whose picture fails leaves the band empty, so the screen goes idle', async () => {
    const r = show(fixture(), 'posters');
    await flush();
    expect(screen(r).classList.contains('is-idle')).toBe(false);
    section(r).querySelector('img[data-item="po1"]')!.dispatchEvent(new Event('error'));
    await flush();
    expect(screen(r).classList.contains('is-poster')).toBe(false);
    expect(screen(r).classList.contains('is-idle')).toBe(true);
  });
});
