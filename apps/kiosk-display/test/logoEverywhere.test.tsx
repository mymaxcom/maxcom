import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { buildRotation, currentSlot, KIOSK_TEMPLATE_IDS, zikirWindow } from '@surau/core';
import type { KioskContent, SlotFeature } from '@surau/core';
import { days, makeView } from './helpers.tsx';
import type { ViewOpts } from './helpers.tsx';
import { srcDir } from './themeCss.ts';
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
import { LiveScreen } from '../src/screens/LiveScreen.tsx';

const LOGO = '/surau-logo?v=abc';
const base = { updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'test' };
const AYAT = {
  surah: 2, surahNameAr: 'البقرة', surahNameMs: 'Al-Baqarah', ayatFrom: 2, ayatTo: 2,
  arabic: ['ذَٰلِكَ ٱلْكِتَٰبُ'], malay: ['Kitab Al-Quran ini.'], translationVersion: 'unlisted',
};
function fixture(): KioskContent {
  return {
    date: '2026-11-03',
    kuliah: [{
      ...base, id: 'k1', date: '2026-11-03', slot: 'maghrib', time: '19:15', label: 'Kuliah Maghrib',
      penceramahId: 'p1', status: 'aktif', penceramah: { name: 'Ustaz Abu Bakar Ahmad' },
    }],
    pengumuman: [{ ...base, id: 'pg1', title: 'Gotong-royong', body: 'Sabtu ini.', from: '2026-11-01', to: '2026-11-30' }],
    ticker: [],
    posters: [{ ...base, id: 'po1', title: 'P', assetId: 'a'.repeat(64), days: ['umum'], order: 1 }],
    programKhas: [{ ...base, id: 'pk1', title: 'Majlis', at: '2026-11-07T20:30', showFrom: '2026-11-01', showTo: '2026-11-07', status: 'aktif' }],
    takwim: [{ ...base, id: 't0', date: '2026-11-03', title: 'Mesyuarat AJK', hijriLabel: '23 Jamadilawal' }],
    hadisToday: [{ id: 'h1', attribution: 'Riwayat al-Bukhari', textAr: 'إِنَّمَا الْأَعْمَالُ بِالنِّيَّاتِ', textMs: 'Setiap amalan bergantung kepada niat.' }],
    worldTimes: [{ ...base, id: 'w1', city: 'Makkah', tz: 'Asia/Riyadh', order: 1 }],
    tugasan: [],
    ayat: { today: AYAT, tomorrow: null },
    zikir: [{ ...base, id: 'z1', order: 1, textAr: 'أَسْتَغْفِرُ اللهَ', textMs: 'Aku memohon keampunan Allah', repeat: 3 }],
    tilawah: { slots: [], available: {} },
    credits: { translation: 't', font: 'f', audio: 'a' },
  } as unknown as KioskContent;
}

function put(date: string, hhmm: string, opts: ViewOpts, override: SlotFeature | null) {
  const content = fixture();
  const view = makeView(date, hhmm, opts);
  const rotation = buildRotation(content, view.settings, view.now);
  const today = view.state.today;
  const month = tarawihMonthFor(view.now, today ? [today] : [], view.settings) ?? view.hijri?.m;
  const zikir = zikirWindow(view.now, days, view.settings, month, content.zikir.length);
  holder.view = view;
  holder.cv = { content, rotation, current: currentSlot(rotation, view.now), zikir, override };
}

let play: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
});
afterEach(() => {
  cleanup();
  play.mockRestore();
});

/** [label, date, hh:mm, card override, expected data-screen] */
const CASES: [string, string, string, SlotFeature | null, string][] = [
  ['biasa', '2026-11-03', '15:52', null, 'biasa'],
  ['azan', '2026-11-03', '16:19', null, 'azan'],
  ['masuk-waktu', '2026-11-03', '16:20:05', null, 'masuk-waktu'],
  ['iqamah', '2026-11-03', '16:25', null, 'iqamah'],
  ['solat', '2026-11-03', '16:35', null, 'solat'],
  ['jumaat', '2026-11-06', '13:02', null, 'jumaat'],
  ['kuliah', '2026-11-03', '15:52', 'kuliahCard', 'kuliah'],
  ['poster', '2026-11-03', '15:52', 'posters', 'poster'],
  ['program', '2026-11-03', '15:52', 'programKhas', 'program'],
  ['pengumuman', '2026-11-03', '15:52', 'pengumuman', 'pengumuman'],
  ['takwim', '2026-11-03', '15:52', 'takwim', 'takwim'],
  ['hadis', '2026-11-03', '15:52', 'hadis', 'hadis'],
  ['ayat', '2026-11-03', '15:52', 'ayatCard', 'ayat'],
  ['zikir', '2026-11-03', '16:45:05', null, 'zikir'],
];

for (const id of KIOSK_TEMPLATE_IDS) {
  for (const [label, d, t, card, screen] of CASES) {
    it(`${id} ${label}: logo inside the brand region`, () => {
      put(d, t, { logo: LOGO, settings: { kioskTemplate: { templateId: id } } }, card);
      // biasa = the idle screen: no content on it, so no card is showing.
      if (label === 'biasa') holder.cv = { ...holder.cv, content: null, rotation: [], current: null, zikir: null };
      const r = render(<App />);
      const stage = r.container.querySelector('.stage')!;
      // Arabic Art shows ayat, hadis and zikir in their Arabic-led looks (the fixtures have Arabic).
      const want = id === 'arabic' && (screen === 'hadis' || screen === 'ayat' || screen === 'zikir') ? `arab-${screen}` : screen;
      expect(stage.getAttribute('data-screen'), `${id} ${label}`).toBe(want);
      expect(r.container.querySelector('.region-brand [data-role="logo"]'), `${id} ${label}`).toBeTruthy();
    });
  }
}

const ON_AIR = {
  live: true, since: '2026-11-05T07:40:00.000Z',
  kuliah: { label: 'Kuliah Maghrib', penceramah: 'Ustaz Ahmad Fauzi', topic: 'Bab Ikhlas' },
  audio: false, volume: 50, playable: true,
} as unknown as LiveView;

describe('no-data, poster and live screens keep the logo', () => {
  it('no data (tiada-data) shows the logo in the brand region in every theme', () => {
    for (const id of KIOSK_TEMPLATE_IDS) {
      holder.view = makeView('2026-11-03', '15:52', { logo: LOGO, days: [], settings: { kioskTemplate: { templateId: id } } });
      const r = render(<App />);
      expect(r.container.querySelector('.stage')!.getAttribute('data-screen'), id).toBe('tiada-data');
      expect(r.container.querySelector('.region-brand [data-role="logo"]'), id).toBeTruthy();
      cleanup();
    }
  });

  it('the live screen keeps the logo', () => {
    for (const id of KIOSK_TEMPLATE_IDS) {
      const view = makeView('2026-11-05', '14:00', { logo: LOGO, settings: { kioskTemplate: { templateId: id } } });
      const r = render(<div class="stage" data-template={id}><LiveScreen view={view} live={ON_AIR} lang="ms" onAir /></div>);
      expect(r.container.querySelector('.region-brand [data-role="logo"]'), id).toBeTruthy();
      cleanup();
    }
  });
});

describe('logo with showName false', () => {
  it('still renders the logo on the poster and the live screen', () => {
    const settings = { surauInfo: { name: 'Surau Al-Hidayah', showName: false } };
    put('2026-11-03', '15:52', { logo: LOGO, settings }, 'posters');
    const r = render(<App />);
    expect(r.container.querySelector('.screen--shell .region-brand [data-role="logo"]')).toBeTruthy();
    expect(r.container.querySelector('.screen--shell .ident__name')).toBeNull();
    cleanup();
    const view = makeView('2026-11-05', '14:00', { logo: LOGO, settings });
    const l = render(<LiveScreen view={view} live={ON_AIR} lang="ms" onAir />);
    expect(l.container.querySelector('.live-screen__ident.region-brand [data-role="logo"]')).toBeTruthy();
    expect(l.container.querySelector('.ident__name')).toBeNull();
  });
});

describe('a logo that fails to load', () => {
  it('leaves the name in the brand region', () => {
    put('2026-11-03', '15:52', { logo: LOGO }, null);
    const r = render(<App />);
    fireEvent.error(r.container.querySelector('[data-role="logo"]')!);
    expect(r.container.querySelector('[data-role="logo"]')).toBeNull();
    expect(r.container.querySelector('.region-brand .ident__name, .region-brand .brand-name')).toBeTruthy();
  });
});

describe('no stylesheet hides the logo', () => {
  function cssFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = resolve(dir, f);
      return statSync(p).isDirectory() ? cssFiles(p) : p.endsWith('.css') ? [p] : [];
    });
  }
  it('no rule on a logo selector sets display:none, visibility:hidden or opacity:0', () => {
    const offenders: string[] = [];
    for (const file of cssFiles(srcDir())) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const block of css.split('}')) {
        const [sel, body] = block.split('{');
        if (!sel || !body) continue;
        // `.logo`, `.ident__logo`, `.poster-strip__logo`, `[data-role='logo']` (but not the unrelated box-screen logos)
        if (!/(\.logo\b|__logo\b|data-role=['"]?logo)/.test(sel) || /box-logo|locked__logo/.test(sel)) continue;
        if (/(display:\s*none|visibility:\s*hidden|opacity:\s*0(?![.\d]))/.test(body)) offenders.push(`${file}: ${sel.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
