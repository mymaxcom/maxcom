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
import { chipLeft } from '../src/ui/NextChip.tsx';
import { STRINGS } from '../src/i18n.ts';
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
    tugasan: [{ ...base, id: 'g1', date: '2026-11-03', role: 'imam', petugasId: 'x1', petugas: { name: 'Haji Rosli Hamid' } } as never],
    ayat: { today: null, tomorrow: null }, zikir: [], tilawah: { slots: [], available: {} },
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

  it('worldTimes and tugasan take the content shell (operator 2026-11-17); no content is the full layout', async () => {
    for (const [f, id] of [['worldTimes', 'waktu-dunia'], ['tugasan', 'tugasan']] as const) {
      const r = showWithCard(f);
      await flush();
      expect(stage(r).getAttribute('data-kind'), f).toBe('content');
      expect(stage(r).getAttribute('data-screen'), f).toBe(id);
      expect(r.container.querySelector('.ident'), f).toBeNull();
      expect(r.container.querySelector('.shell-top'), f).toBeTruthy();
      // a text screen: the compact prayer strip stays (theme round 2, rule 1)
      expect(r.container.querySelector('.strip--compact'), f).toBeTruthy();
      cleanup();
    }
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

  it('no countdown inside a prayer cell on any screen (theme round 2, rule 7)', async () => {
    const r = showWithCard(null);
    await flush();
    expect(r.container.querySelector('.pcell__cd, [data-prayer] [role="timer"]')).toBeNull();
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

  it('chip countdown: hh:mm, minutes rounded up, the seconds alone in the last minute only with clock seconds on (rules 4, 5)', () => {
    expect(chipLeft(27 * 60_000, false)).toBe('00:27');
    expect(chipLeft(26 * 60_000 + 1_000, false)).toBe('00:27');
    expect(chipLeft((2 * 60 + 12) * 60_000, false)).toBe('02:12');
    expect(chipLeft((2 * 60 + 11) * 60_000 + 30_000, false)).toBe('02:12');
    expect(chipLeft(45_000, false)).toBe('00:01');
    expect(chipLeft(1_000, false)).toBe('00:01');
    expect(chipLeft(45_000, true)).toBe('45');
    expect(chipLeft(44_200, true)).toBe('45');
    expect(chipLeft(60_000, true)).toBe('60');
    expect(chipLeft(61_000, true)).toBe('00:02');
    expect(chipLeft(0, false)).toBe('00:00');
    expect(chipLeft(-5, true)).toBe('00:00');
    // No words: the old relative phrases are gone.
    for (const k of ['chipRelHM', 'chipRelH', 'chipRelM', 'chipRelNow']) expect(STRINGS.ms[k], k).toBeUndefined();
  });

  it('the chip: name, time, an hourglass and the hh:mm left, updated once a minute', async () => {
    const r = showWithCard('kuliahCard');
    await flush();
    const chip = r.container.querySelector('.next--chip')!;
    expect(chip.querySelector('.chip-k')!.textContent).toBe('Asar');
    expect(chip.querySelector('.chip-t')!.textContent).toBe('4:20PTG');
    expect(chip.querySelector('.chip-cd svg.chip-hg')).toBeTruthy();
    expect(chip.querySelector('.chip-cd b')!.textContent).toBe('00:28');
    expect(chip.classList.contains('is-now')).toBe(false);
    expect(chip.textContent).not.toMatch(/lagi|minit/);
  });

  it('"Masuk waktu" on the chip for three minutes after the prayer time, then the next prayer (rule 6)', async () => {
    // Asar is 16:20 on the fixture day; the content screen is back after the phases at 16:22 only in this probe.
    const { justInOf } = await import('../src/ui/visibleNext.ts');
    const v = makeView('2026-11-03', '16:22');
    expect(justInOf(v.state, v.settings, v.now, v.tz)?.name).toBe('asar');
    const later = makeView('2026-11-03', '16:23');
    expect(justInOf(later.state, later.settings, later.now, later.tz)).toBeNull();
    const before = makeView('2026-11-03', '16:19:59');
    expect(justInOf(before.state, before.settings, before.now, before.tz)).toBeNull();
    const { NextChip } = await import('../src/ui/NextChip.tsx');
    const now = render(<NextChip view={v} lang="ms" />);
    const chip = now.container.querySelector('.next--chip')!;
    expect(chip.classList.contains('is-now')).toBe(true);
    expect(chip.querySelector('.chip-k')!.textContent).toBe('Asar');
    expect(chip.querySelector('.chip-cd--now')!.textContent).toBe('Masuk waktu');
    expect(chip.querySelector('[role="timer"]')).toBeNull();
    cleanup();
    const next = render(<NextChip view={later} lang="ms" />);
    expect(next.container.querySelector('.chip-k')!.textContent).toBe('Maghrib');
    expect(next.container.querySelector('.next--chip')!.classList.contains('is-now')).toBe(false);
  });

  it('the chip shows the seconds alone in the last minute when the clock shows seconds', async () => {
    const { NextChip } = await import('../src/ui/NextChip.tsx');
    const on = makeView('2026-11-03', '16:19:15', { settings: { clock: { showSeconds: true } } });
    const r = render(<NextChip view={on} lang="ms" />);
    expect(r.container.querySelector('.chip-cd b')!.textContent).toBe('45');
    cleanup();
    const off = makeView('2026-11-03', '16:19:15');
    const r2 = render(<NextChip view={off} lang="ms" />);
    expect(r2.container.querySelector('.chip-cd b')!.textContent).toBe('00:01');
  });
});

describe('the shell head: dates and the next prayer (brief 2026-11-16 items 2 and 8)', () => {
  it('shows the Gregorian and the Hijri date under the surau name on a content screen', async () => {
    const r = showWithCard('kuliahCard');
    await flush();
    const d = r.getByTestId('shell-date');
    expect(d.textContent).toContain('Selasa, 3 November 2026');
    expect(d.querySelector('.shell-hijri')!.textContent).toMatch(/1448H$/);
    expect(d.closest('.region-brand')).toBeTruthy();
  });

  it('honours hijriDate: adjustDays moves the Hijri date; no Hijri date leaves the Gregorian alone', async () => {
    const a = showWithCard('kuliahCard');
    await flush();
    const plain = a.container.querySelector('.shell-hijri')!.textContent;
    cleanup();
    const b = showWithCard('kuliahCard', { settings: { hijriDate: { adjustDays: 1 } } });
    await flush();
    expect(b.container.querySelector('.shell-hijri')!.textContent).not.toBe(plain);
    cleanup();
    const c = content();
    const view = { ...makeView('2026-11-03', '15:52'), hijri: null };
    const cycle = buildCycle(c, view.settings, view.now);
    holder.view = view;
    holder.cv = { content: c, rotation: cycle.slots, current: currentSlot(cycle.slots, view.now, cycle.cycleStartSec), zikir: null, override: 'kuliahCard' };
    const n = render(<App />);
    await flush();
    expect(n.getByTestId('shell-date').textContent).toBe('Selasa, 3 November 2026');
    expect(n.container.querySelector('.shell-date .sep')).toBeNull();
  });

  it('the chip names the next VISIBLE prayer with the strip: Syuruk hidden at 06:30 is Zohor', async () => {
    const r = showWithCard('kuliahCard', { settings: { prayerBar: { showSyuruk: false } } }, '2026-11-03', '06:30');
    await flush();
    const chip = r.container.querySelector('.next--chip')!;
    expect(chip.querySelector('.chip-k')!.textContent).toBe('Zohor');
    expect(r.container.querySelector('.strip .pcell.is-current')!.getAttribute('data-prayer')).toBe('zohor');
    cleanup();
    const shown = showWithCard('kuliahCard', {}, '2026-11-03', '06:30');
    await flush();
    expect(shown.container.querySelector('.next--chip .chip-k')!.textContent).toBe('Syuruk');
  });
});

describe('the backgrounds list in every theme (brief 2026-11-16 item 5, spec 6.10.1 layer 4)', () => {
  const OWN = 'd'.repeat(64);
  it('a picture under the text marks the stage (data-picture): the scrim, the plates and the glow follow it', async () => {
    for (const theme of ['default', 'colourful', 'creative', 'oldschool', 'minimal', 'arabic']) {
      const r = showWithCard('kuliahCard', { settings: { kioskTemplate: { templateId: theme }, backgrounds: { images: [OWN] } } });
      await flush();
      expect(stage(r).getAttribute('data-picture'), theme).toBe('on');
      expect(r.container.querySelector('.bg .bg__scrim'), theme).toBeTruthy();
      cleanup();
      // The built-in default photos (the Default look itself) and no picture at all leave every theme as it was.
      const plain = showWithCard('kuliahCard', { settings: { kioskTemplate: { templateId: theme } } });
      await flush();
      expect(stage(plain).getAttribute('data-picture'), theme).toBeNull();
      cleanup();
    }
  });
  it('a theme other than Default wears the surau own list picture as its picture layer', async () => {
    for (const theme of ['colourful', 'creative', 'oldschool', 'minimal', 'arabic']) {
      const r = showWithCard('kuliahCard', { settings: { kioskTemplate: { templateId: theme }, backgrounds: { images: [OWN] } } });
      await flush();
      expect(stage(r).getAttribute('data-bg'), theme).toBe('image');
      expect(stage(r).style.getPropertyValue('--bg-image'), theme).toContain(`/assets/${OWN}`);
      expect(r.container.querySelector('.bg__menu'), theme).toBeTruthy();
      cleanup();
    }
  });
  it('the built-in default photos stay the Default look own: other themes keep their field', async () => {
    const r = showWithCard('kuliahCard', { settings: { kioskTemplate: { templateId: 'creative' } } });
    await flush();
    expect(stage(r).getAttribute('data-bg')).toBeNull();
    cleanup();
    const off = showWithCard('kuliahCard', { settings: { kioskTemplate: { templateId: 'creative' }, backgrounds: { enabled: false, images: [OWN] } } });
    await flush();
    expect(stage(off).getAttribute('data-bg')).toBeNull();
  });
  it('Default draws the list itself (unchanged): no picture layer', async () => {
    const r = showWithCard('kuliahCard', { settings: { backgrounds: { images: [OWN] } } });
    await flush();
    expect(stage(r).getAttribute('data-bg')).toBeNull();
    expect(r.container.querySelector('.bg__img')!.getAttribute('src')).toBe(`/assets/${OWN}`);
  });
  it('a menu picture of the screen still wins over the list', async () => {
    const MENU = 'e'.repeat(64);
    const r = showWithCard('kuliahCard', { settings: {
      kioskTemplate: { templateId: 'minimal' }, backgrounds: { images: [OWN] },
      themeStyle: { styles: { minimal: { semua: { bgImage: MENU }, skrin: {} } } },
    } });
    await flush();
    expect(stage(r).style.getPropertyValue('--bg-image')).toContain(MENU);
  });
});
