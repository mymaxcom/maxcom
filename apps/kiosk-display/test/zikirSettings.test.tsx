import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { buildRotation, currentSlot, zikirWindow } from '@surau/core';
import type { KioskContent } from '@surau/core';
import { days, makeView } from './helpers.tsx';
import type { ViewOpts } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';
import type { ContentView } from '../src/data/content.ts';
import { tarawihMonthFor } from '../src/data/tarawih.ts';
import { ArabEnvContext } from '../src/themes/arabContext.ts';
import type { Lang } from '../src/i18n.ts';

/**
 * The zikir settings of 2026.11.15 (O11, C6, R5): the start offset, the clock, the time left and the look, and the
 * zikir meaning in the TV language (English text on an English TV, the Arabic only on an Arabic TV).
 * 2026-11-03: Asar solat ends 16:45.
 */
const holder = vi.hoisted(() => ({
  view: null as unknown as KioskView,
  cv: null as unknown as ContentView,
}));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));
vi.mock('../src/data/content.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/data/content.ts')>();
  return { ...orig, useContent: () => holder.cv };
});

import { Main } from '../src/screens/Main.tsx';

const base = { updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'test' };
const ZIKIR = [
  { ...base, id: 'z1', order: 1, textAr: 'أَسْتَغْفِرُ اللهَ', textMs: 'Aku memohon keampunan Allah', textEn: 'I seek the forgiveness of Allah', repeat: 3 },
  { ...base, id: 'z2', order: 2, textAr: 'سُبْحَانَ اللهِ', textMs: 'Maha Suci Allah', repeat: 33 },
  { ...base, id: 'z3', order: 3, textAr: 'ٱلْحَمْدُ لِلَّٰهِ', textMs: 'Segala puji bagi Allah', textEn: '  ', repeat: 33 },
];

function fixture(): KioskContent {
  return {
    date: '2026-11-03', kuliah: [], pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [],
    hadisToday: [], worldTimes: [], tugasan: [], ayat: { today: null, tomorrow: null }, zikir: ZIKIR as never,
    tilawah: { slots: [], available: {} }, credits: { translation: 't', font: 'f', audio: 'a' },
  };
}

function viewAt(hms: string, opts: ViewOpts = {}) {
  const content = fixture();
  const view = makeView('2026-11-03', hms, opts);
  const rotation = buildRotation(content, view.settings, view.now);
  const today = view.state.today;
  const month = tarawihMonthFor(view.now, today ? [today] : [], view.settings) ?? view.hijri?.m;
  const zikir = zikirWindow(view.now, days, view.settings, month, content.zikir.length);
  holder.view = view;
  holder.cv = { content, rotation, current: currentSlot(rotation, view.now), zikir, override: null };
  return view;
}

const zikirOf = (r: ReturnType<typeof render>) => r.container.querySelector('[data-layer="zikir"]');
const show = (view: KioskView, lang: Lang = 'ms', looks: string[] = []) =>
  render(
    <ArabEnvContext.Provider value={{ looks: new Set(looks), forced: null, style: {} }}>
      <Main view={view} lang={lang} />
    </ArabEnvContext.Provider>,
  );

let play: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
});
afterEach(() => {
  cleanup();
  play.mockRestore();
});

describe('zikir start offset', () => {
  it('with 5 minutes the rotation stays after the solat, the zikir starts at 16:50', () => {
    const s = { settings: { zikirSelepasSolat: { startAfterMinutes: 5 } } };
    const early = show(viewAt('16:45:05', s));
    expect(zikirOf(early)).toBeNull();
    cleanup();
    const r = show(viewAt('16:50:05', s));
    expect(zikirOf(r)!.getAttribute('data-item')).toBe('z1');
    cleanup();
    const second = show(viewAt('16:50:25', s));
    expect(zikirOf(second)!.getAttribute('data-item')).toBe('z2');
  });
});

describe('zikir clock and time left', () => {
  it('by default the clock shows in the head and there is no time left', () => {
    const r = show(viewAt('16:45:05'));
    expect(zikirOf(r)).toBeTruthy();
    expect(r.container.querySelector('[data-role="clock"]')).toBeTruthy();
    expect(r.container.querySelector('[data-role="zikir-left"]')).toBeNull();
  });

  it('showClock off hides the clock while the zikir shows (the next-prayer chip stays)', () => {
    const r = show(viewAt('16:45:05', { settings: { zikirSelepasSolat: { showClock: false } } }));
    expect(zikirOf(r)).toBeTruthy();
    expect(r.container.querySelector('[data-role="clock"]')).toBeNull();
    expect(r.container.querySelector('.shell-top')).toBeTruthy();
  });

  it('showTimeLeft counts down to the end of the zikir (3 x 20 s from 16:45: 0:55 left at 16:45:05)', () => {
    const r = show(viewAt('16:45:05', { settings: { zikirSelepasSolat: { showTimeLeft: true } } }));
    const left = r.container.querySelector('[data-role="zikir-left"]')!;
    expect(left).toBeTruthy();
    expect(left.textContent).toContain('Masa berbaki');
    expect(left.querySelector('b')!.textContent).toBe('0:55');
  });

  it('the time left is in the TV language, also on the Arabic-led look', () => {
    const settings = { zikirSelepasSolat: { showTimeLeft: true, look: 'arab' } };
    const en = show(viewAt('16:45:05', { settings }), 'en');
    expect(en.container.querySelector('[data-role="zikir-left"]')!.textContent).toContain('Time left');
    cleanup();
    const ar = show(viewAt('16:45:05', { settings }), 'ar');
    expect(ar.container.querySelector('[data-role="zikir-left"]')!.textContent).toContain('الوقت المتبقي');
  });
});

describe('zikir look', () => {
  it('theme (default): the plain panel unless the theme turns the Arabic look on', () => {
    const plain = show(viewAt('16:45:05'));
    expect(plain.container.querySelector('section.zikir')).toBeTruthy();
    expect(plain.container.querySelector('.arab-zikir')).toBeNull();
    cleanup();
    const arab = show(viewAt('16:45:05'), 'ms', ['arab-zikir']);
    expect(arab.container.querySelector('.arab-zikir')).toBeTruthy();
  });

  it('plain: the plain panel even when the theme has the Arabic look', () => {
    const r = show(viewAt('16:45:05', { settings: { zikirSelepasSolat: { look: 'plain' } } }), 'ms', ['arab-zikir']);
    expect(r.container.querySelector('section.zikir')).toBeTruthy();
    expect(r.container.querySelector('.arab-zikir')).toBeNull();
  });

  it('arab: the Arabic-led ring on any theme', () => {
    const r = show(viewAt('16:45:05', { settings: { zikirSelepasSolat: { look: 'arab' } } }));
    expect(r.container.querySelector('.arab-zikir')).toBeTruthy();
    expect(r.container.querySelector('section.zikir')).toBeNull();
  });
});

describe('zikir meaning in the TV language', () => {
  it('BM TV: the Malay meaning', () => {
    const r = show(viewAt('16:45:05'));
    expect(r.getByText('Aku memohon keampunan Allah')).toBeTruthy();
    expect(r.queryByText('I seek the forgiveness of Allah')).toBeNull();
  });

  it('English TV: the English meaning, the Malay one when there is no English text', () => {
    const r = show(viewAt('16:45:05'), 'en');
    expect(r.getByText('I seek the forgiveness of Allah')).toBeTruthy();
    expect(r.queryByText('Aku memohon keampunan Allah')).toBeNull();
    expect(r.getByText('Zikir after Asar prayer', { exact: false })).toBeTruthy();
    cleanup();
    const noEn = show(viewAt('16:45:25'), 'en');
    expect(noEn.getByText('Maha Suci Allah')).toBeTruthy();
    cleanup();
    const blank = show(viewAt('16:45:45'), 'en');
    expect(blank.getByText('Segala puji bagi Allah')).toBeTruthy();
  });

  it('Arabic TV: the Arabic only, no Malay or English line', () => {
    const r = show(viewAt('16:45:05'), 'ar');
    const z = zikirOf(r)!;
    expect(z.textContent).toContain('أَسْتَغْفِرُ');
    expect(r.queryByText('Aku memohon keampunan Allah')).toBeNull();
    expect(r.queryByText('I seek the forgiveness of Allah')).toBeNull();
    expect(z.querySelector('.zikir__ms')).toBeNull();
  });

  it('English TV on the Arabic-led look: the English meaning under the Arabic', () => {
    const r = show(viewAt('16:45:05', { settings: { zikirSelepasSolat: { look: 'arab' } } }), 'en');
    expect(r.container.querySelector('.zk-ms')!.textContent).toBe('I seek the forgiveness of Allah');
  });
});
