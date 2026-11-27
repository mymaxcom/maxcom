import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/preact';
import { buildCycle, currentSlot, FEATURES, FIELD_META, HIDDEN_FEATURES } from '@surau/core';
import type { FeatureKey, KioskContent, SlotFeature } from '@surau/core';
import { makeView } from './helpers.tsx';
import type { ViewOpts } from './helpers.tsx';
import { srcDir } from './themeCss.ts';
import { REACH } from './settingsReach.ts';
import type { KioskView } from '../src/data/kiosk.ts';
import type { ContentView } from '../src/data/content.ts';

const holder = vi.hoisted(() => ({ view: null as unknown as KioskView, cv: null as unknown as ContentView }));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));
vi.mock('../src/data/content.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/data/content.ts')>();
  return { ...orig, useContent: () => holder.cv };
});

import { App } from '../src/app.tsx';

const repo = resolve(srcDir(), '../../..');
const leavesOf = (defaults: Record<string, unknown>): string[] => ['enabled', ...Object.keys(defaults)];
const word = (w: string): RegExp => new RegExp(`(^|[^A-Za-z0-9_])${w}([^A-Za-z0-9_]|$)`);
/** How far apart (characters) the feature's name and its leaf may sit in one file: a leaf word of another feature far away does not count. */
export const NEAR = 2500;

const stripComments = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

/**
 * Whether `text` reads `feature.leaf`: the code (comments removed) names the feature, and its leaf comes as a property read
 * of the feature or of a name the file gives it (`const sw = settings.syurukWarning`, `{ syurukWarning: sw }`): `x.leaf`,
 * `x?.leaf`, `x['leaf']`, or else as a word within NEAR characters of the feature's name. A bare word match anywhere in the
 * file (the key here, the same word for another feature there, a word in a comment, an object key) does not pass.
 * `needle` replaces the check where the code builds the name.
 */
export function reads(text: string, feature: string, leaf: string, needle?: RegExp): boolean {
  if (needle !== undefined) return needle.test(text);
  const code = stripComments(text);
  if (!word(feature).test(code)) return false;
  const names = new Set<string>([feature]);
  const alias = [
    new RegExp(`(?:const|let|var|final)\\s+(?:\\{\\s*)?(\\w+)[^=;\\n]*=[^;\\n]*(?<![A-Za-z0-9_])${feature}(?![A-Za-z0-9_])`, 'g'),
    new RegExp(`(?<![A-Za-z0-9_])${feature}\\s*:\\s*(\\w+)`, 'g'),
  ];
  for (const re of alias) for (const m of code.matchAll(re)) names.add(m[1]!);
  for (const n of names) {
    if (new RegExp(`(?<![A-Za-z0-9_])${n}(?:\\?\\.|\\.|\\[\\s*['"])${leaf}(?![A-Za-z0-9_])`).test(code)) return true;
  }
  const at = [...code.matchAll(new RegExp(word(feature).source, 'g'))].map((m) => m.index!);
  return [...code.matchAll(new RegExp(word(leaf).source, 'g'))].some((m) => at.some((i) => Math.abs(m.index! - i) <= NEAR));
}

describe('every Tetapan parameter is consumed, or listed as hidden / planned / locked / a known gap', () => {
  it('the table names every parameter of the registry and nothing else', () => {
    const want = FEATURES.flatMap((f) => leavesOf(f.defaults as Record<string, unknown>).map((l) => `${f.key}.${l}`)).sort();
    const have = Object.entries(REACH).flatMap(([f, ls]) => Object.keys(ls).map((l) => `${f}.${l}`)).sort();
    expect(want.filter((x) => !have.includes(x)), 'parameters with no entry in test/settingsReach.ts').toEqual([]);
    expect(have.filter((x) => !want.includes(x)), 'entries for parameters that no longer exist').toEqual([]);
  });

  it('each consumer file exists and still names its parameter', () => {
    const bad: string[] = [];
    for (const [f, ls] of Object.entries(REACH)) {
      for (const [leaf, r] of Object.entries(ls)) {
        if (!('by' in r)) continue;
        for (const file of r.by) {
          const p = resolve(repo, file);
          if (!existsSync(p)) { bad.push(`${f}.${leaf}: ${file} is missing`); continue; }
          const text = readFileSync(p, 'utf8');
          if (!reads(text, f, leaf, r.needle)) bad.push(`${f}.${leaf}: ${file} does not read it`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('the check does not pass on a bare word match', () => {
    // The feature key in one place and the same leaf word for another feature elsewhere (the old false passes).
    const other = 'const a = settings.azanCountdown; if (a.beep && calc.enabled) play();';
    const gap = `\n${'x = 1;\n'.repeat(500)}`;
    expect(reads(`const c = settings.prayerCalc;${gap}${other}`, 'prayerCalc', 'enabled')).toBe(false);
    expect(reads(`const sw = settings.syurukWarning;${gap}${other}`, 'syurukWarning', 'beep')).toBe(false);
    expect(reads('/* the beep of syurukWarning */ const y = 1;', 'syurukWarning', 'beep')).toBe(false);
    expect(reads('const x = { beep: true }; // syurukWarning', 'syurukWarning', 'beep')).toBe(false);
    // A real read passes, with the alias in between.
    expect(reads('const sw = settings.syurukWarning;\nif (sw.enabled && sw.beep) play();', 'syurukWarning', 'beep')).toBe(true);
    expect(reads('settings.prayerCalc?.enabled', 'prayerCalc', 'enabled')).toBe(true);
    expect(reads('s.titleTemplate', 'liveYoutube', 'titleTemplate', /s\.titleTemplate/)).toBe(true);
  });

  it('locked and hidden entries agree with the registry and the Tetapan metadata', () => {
    for (const f of FEATURES) {
      const e = REACH[f.key]?.enabled;
      if (e && 'none' in e && e.none === 'locked') expect(f.locked, `${f.key} is listed as locked`).toBe(true);
    }
    for (const [f, fields] of Object.entries(FIELD_META)) {
      for (const [leaf, m] of Object.entries(fields ?? {})) {
        if (!m.hidden) continue;
        // a dotted meta key (`avOffsetMs.deviceMic`) is covered by its parent entry in the table
        const r = REACH[f]?.[leaf] ?? REACH[f]?.[leaf.split('.')[0]!];
        expect(r && 'none' in r && r.none === 'hidden', `${f}.${leaf} is hidden in Tetapan`).toBe(true);
      }
    }
    for (const key of HIDDEN_FEATURES) {
      const r = REACH[key as FeatureKey]?.enabled;
      expect(r !== undefined, `${key}`).toBe(true);
    }
  });
});

// ---- Render probes: a parameter that changes the TV changes the reachable screen (App, not a card on its own). ----

const PHOTO = 'a'.repeat(64);
const COVER = 'b'.repeat(64);
const base = { updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'test' };
function content(): KioskContent {
  const k = (id: string, date: string, slot: string, time: string, name: string, topic: string) => ({
    ...base, id, date, slot, time, label: `Kuliah ${slot === 'subuh' ? 'Subuh' : 'Maghrib'}`, penceramahId: `p-${id}`, kitabId: 'b1', topic,
    status: 'aktif', penceramah: { name, title: 'Ustaz', photoAssetId: PHOTO }, kitab: { title: 'Riyadhus Solihin', coverAssetId: COVER },
  });
  return {
    date: '2026-11-03',
    kuliah: [
      k('k1', '2026-11-03', 'maghrib', '19:15', 'Ustaz Contoh Satu', 'Adab menuntut ilmu'),
      k('k2', '2026-11-06', 'maghrib', '19:15', 'Ustaz Contoh Dua', 'Fiqh solat jemaah'),
    ],
    pengumuman: [],
    ticker: [{ ...base, id: 't1', text: 'Gotong-royong hari Sabtu selepas Subuh.', from: '2026-11-01', to: '2026-11-30', order: 1 }],
    posters: [], programKhas: [], takwim: [],
    hadisToday: [{
      id: 'h1', attribution: 'Riwayat al-Bukhari dan Muslim', grade: 'sahih',
      textAr: 'إِنَّمَا الْأَعْمَالُ بِالنِّيَّاتِ', textMs: 'Sesungguhnya setiap amalan itu bergantung kepada niat.',
    }],
    worldTimes: [], tugasan: [],
    ayat: {
      today: {
        surah: 18, surahNameMs: 'Al-Kahfi', ayatFrom: 1, ayatTo: 2,
        arabic: ['ٱلۡحَمۡدُ لِلَّهِ ٱلَّذِيٓ أَنزَلَ عَلَىٰ عَبۡدِهِ ٱلۡكِتَٰبَ', 'قَيِّمٗا لِّيُنذِرَ بَأۡسٗا شَدِيدٗا'],
        malay: ['Segala puji tertentu bagi Allah yang telah menurunkan Kitab suci Al-Quran.', 'Tetap benar lagi menjadi pengawas.'],
      },
      tomorrow: null,
    },
    zikir: [], tilawah: { slots: [], available: {} },
    credits: { translation: 'Terjemahan: Basmeih (QuranEnc.com)', font: 'f', audio: 'a' },
  } as unknown as KioskContent;
}

function show(card: SlotFeature | null, settings: ViewOpts['settings'], hhmm = '15:52') {
  const c = content();
  const view = makeView('2026-11-03', hhmm, { settings: { surauInfo: { name: 'Surau Contoh' }, ...settings } });
  const cycle = buildCycle(c, view.settings, view.now);
  holder.view = view;
  holder.cv = card === null
    ? { content: c, rotation: [], current: null, zikir: null, override: null }
    : { content: c, rotation: cycle.slots, current: currentSlot(cycle.slots, view.now, cycle.cycleStartSec), zikir: null, override: card };
  return render(<App />);
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((res) => setTimeout(res, 10)); };
async function html(card: SlotFeature | null, settings: ViewOpts['settings'], hhmm?: string): Promise<string> {
  const r = show(card, settings, hhmm);
  await flush();
  const out = (r.container.querySelector('.stage') as HTMLElement).outerHTML;
  cleanup();
  return out;
}

/** Every slot of the card's feature in the rotation, each rendered through the App as the rotation puts it on the stage. */
async function rotationHtml(card: SlotFeature | null, settings: ViewOpts['settings'], hhmm = '15:52'): Promise<string> {
  const c = content();
  const view = makeView('2026-11-03', hhmm, { settings: { surauInfo: { name: 'Surau Contoh' }, ...settings } });
  const cycle = buildCycle(c, view.settings, view.now);
  const out: string[] = [];
  for (const [index, slot] of cycle.slots.entries()) {
    if (slot.feature !== card) continue;
    holder.view = view;
    holder.cv = { content: c, rotation: cycle.slots, current: { slot, index, startedAt: view.now }, zikir: null, override: null };
    const r = render(<App />);
    await flush();
    out.push((r.container.querySelector('.stage') as HTMLElement).outerHTML);
    cleanup();
  }
  return out.join('\n');
}

let play: ReturnType<typeof vi.spyOn>;
beforeEach(() => { play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve()); });
afterEach(() => { cleanup(); play.mockRestore(); });

/** `rotation`: the screens of every slot of that card in the rotation, one after the other (a window setting decides which
 * kuliah get a screen, not what the first one looks like). */
interface Probe { param: string; change: Record<string, unknown>; card: SlotFeature | null; themes?: string[]; at?: string; rotation?: boolean }
const ALL = ['default', 'colourful', 'creative', 'oldschool', 'minimal', 'arabic'];
const PROBES: Probe[] = [
  { param: 'prayerBar.showImsak', change: { prayerBar: { showImsak: false } }, card: null },
  { param: 'prayerBar.showSyuruk', change: { prayerBar: { showSyuruk: false } }, card: 'kuliahCard' },
  { param: 'prayerBar.timeFormat', change: { prayerBar: { timeFormat: '24h' } }, card: 'kuliahCard' },
  { param: 'clock.showSeconds', change: { clock: { showSeconds: true } }, card: 'hadis' },
  { param: 'hijriDate.adjustDays', change: { hijriDate: { adjustDays: 1 } }, card: 'ayatCard' },
  { param: 'language.lang', change: { language: { lang: 'en' } }, card: 'kuliahCard' },
  { param: 'kuliahCard.daysAhead', change: { kuliahCard: { daysAhead: 1 } }, card: 'kuliahCard', rotation: true },
  { param: 'penceramahPhoto.enabled', change: { penceramahPhoto: { enabled: false } }, card: 'kuliahCard' },
  { param: 'penceramahPhoto.shape', change: { penceramahPhoto: { shape: 'square' } }, card: 'kuliahCard' },
  { param: 'kitabCover.enabled', change: { kitabCover: { enabled: false } }, card: 'kuliahCard' },
  { param: 'ticker.enabled', change: { ticker: { enabled: false } }, card: 'kuliahCard' },
  { param: 'hadis.showArabic', change: { hadis: { showArabic: false } }, card: 'hadis', themes: ['default'] },
  { param: 'hadis.showMalay', change: { hadis: { showMalay: false } }, card: 'hadis' },
  { param: 'hadis.showAttribution', change: { hadis: { showAttribution: false } }, card: 'hadis' },
  { param: 'hadis.showGrade', change: { hadis: { showGrade: false } }, card: 'hadis' },
  { param: 'hadis.fontSize', change: { hadis: { fontSize: 's' } }, card: 'hadis' },
  { param: 'ayatCard.showTranslation', change: { ayatCard: { showTranslation: false } }, card: 'ayatCard' },
  { param: 'ayatCard.textSize', change: { ayatCard: { textSize: 'l' } }, card: 'ayatCard' },
  { param: 'kioskTemplate.templateId', change: { kioskTemplate: { templateId: 'minimal' } }, card: 'kuliahCard', themes: ['default'] },
];

describe('the parameters that change the TV change the screen it reaches, in every theme', () => {
  for (const p of PROBES) {
    for (const theme of p.themes ?? ALL) {
      it(`${p.param} (${theme})`, async () => {
        const t = { kioskTemplate: { templateId: theme } };
        const merged: Record<string, Record<string, unknown>> = { ...t };
        for (const [k, v] of Object.entries(p.change)) merged[k] = { ...(merged[k] ?? {}), ...(v as Record<string, unknown>) };
        const read = p.rotation ? rotationHtml : html;
        const before = await read(p.card, t as never, p.at);
        const after = await read(p.card, merged as never, p.at);
        expect(after, `${p.param} changed nothing on the ${p.card ?? 'main'} screen of ${theme}`).not.toBe(before);
      });
    }
  }
  it('every probe names a parameter of the table that is consumed on the kiosk', () => {
    for (const p of PROBES) {
      const [f, leaf] = p.param.split('.') as [string, string];
      const r = REACH[f]?.[leaf];
      expect(r && 'by' in r, p.param).toBe(true);
    }
  });
});
