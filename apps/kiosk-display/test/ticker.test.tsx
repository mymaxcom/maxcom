import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { buildRotation, currentSlot } from '@surau/core';
import type { KioskContent } from '@surau/core';
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
import { activeTickerItems, tickerSeconds } from '../src/content/Ticker.tsx';
import { resetCardPictureFailures } from '../src/content/cardPictures.ts';

const base = { updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'test' };
const TICKER = [
  { ...base, id: 'tk1', text: 'Kutipan derma pembinaan ruang wuduk baharu dibuka setiap hari selepas solat Maghrib.', from: '2026-11-01', to: '2026-11-30' },
  { ...base, id: 'tk2', text: 'Kelas mengaji dewasa setiap malam Selasa dan Khamis selepas Isyak.', from: '2026-11-03', to: '2026-11-03' },
  { ...base, id: 'tk3', text: 'Teks ini sudah tamat tempoh dan tidak boleh muncul.', from: '2026-10-01', to: '2026-10-31' },
  { ...base, id: 'tk4', text: 'Teks ini belum bermula.', from: '2026-11-04', to: '2026-11-30' },
];

function fixture(over: Partial<KioskContent> = {}): KioskContent {
  return {
    date: '2026-11-03',
    kuliah: [{
      ...base, id: 'k1', date: '2026-11-03', slot: 'maghrib', time: '19:15', label: 'Kuliah Maghrib',
      penceramahId: 'p1', status: 'aktif', penceramah: { name: 'Ustaz Abu Bakar Ahmad' },
    }],
    pengumuman: [], ticker: TICKER, posters: [], programKhas: [], takwim: [],
    hadisToday: [], worldTimes: [], tugasan: [], ayat: { today: null, tomorrow: null }, zikir: [],
    tilawah: { slots: [], available: {} },
    credits: { translation: 't', font: 'f', audio: 'a' },
    ...over,
  };
}

function show(content: KioskContent | null, date = '2026-11-03', hhmm = '15:00', opts: ViewOpts = {}) {
  const view = makeView(date, hhmm, opts);
  const rotation = content ? buildRotation(content, view.settings, view.now) : [];
  holder.view = view;
  holder.cv = { content, rotation, current: currentSlot(rotation, view.now), zikir: null, override: 'kuliahCard' };
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

const strip = (r: ReturnType<typeof render>) => r.container.querySelector('[data-layer="ticker"]');

describe('Ticker', () => {
  it('scrolls the active ticker texts above the prayer bar, in a strip under the content region', () => {
    const r = show(fixture());
    const el = strip(r)!;
    expect(el).toBeTruthy();
    expect(el.textContent).toContain('Kutipan derma pembinaan ruang wuduk baharu');
    expect(el.textContent).toContain('Kelas mengaji dewasa');
    expect(el.textContent).not.toContain('sudah tamat tempoh');
    expect(el.textContent).not.toContain('belum bermula');
    expect(el.getAttribute('data-speed')).toBe('normal');
    // The strip precedes the prayer bar in the DOM and the screen is marked so the content region moves up.
    const screen = r.container.querySelector('.screen')!;
    expect(screen.classList.contains('has-ticker')).toBe(true);
    const order = [...screen.children].map((c) => c.getAttribute('data-layer') ?? c.className);
    expect(order.indexOf('ticker')).toBeLessThan(order.findIndex((c) => String(c).includes('region-prayers')));
    expect(r.container.querySelector('[data-layer="content"] [data-card="kuliahCard"]')).toBeTruthy();
  });

  it('is absent when the ticker feature is off, when no text is active, and when there is no content', () => {
    const off = show(fixture(), '2026-11-03', '15:00', { settings: { ticker: { enabled: false } } });
    expect(strip(off)).toBeNull();
    expect(off.container.querySelector('.screen')!.classList.contains('has-ticker')).toBe(false);
    cleanup();
    const none = show(fixture({ ticker: [TICKER[2]!] }));
    expect(strip(none)).toBeNull();
    cleanup();
    const empty = show(null);
    expect(strip(empty)).toBeNull();
  });

  it('maps speed to seconds per screen width and selects items by KL date', () => {
    expect(tickerSeconds('slow')).toBe(90);
    expect(tickerSeconds('normal')).toBe(60);
    expect(tickerSeconds('fast')).toBe(40);
    expect(tickerSeconds('bogus')).toBe(60);
    expect(activeTickerItems(TICKER, '2026-11-03').map((x) => x.id)).toEqual(['tk1', 'tk2']);
    expect(activeTickerItems(TICKER, '2026-11-04').map((x) => x.id)).toEqual(['tk1', 'tk4']);
    expect(activeTickerItems(TICKER, '2026-12-01')).toEqual([]);
    const r = show(fixture(), '2026-11-03', '15:00', { settings: { ticker: { speed: 'fast' } } });
    expect(strip(r)!.getAttribute('data-speed')).toBe('fast');
  });

  it('never shows in a prayer phase (solat 16:35 through App)', () => {
    const c = fixture();
    const view = makeView('2026-11-03', '16:35');
    const rotation = buildRotation(c, view.settings, view.now);
    holder.view = view;
    holder.cv = { content: c, rotation, current: currentSlot(rotation, view.now), zikir: null, override: 'kuliahCard' };
    const r = render(<App />);
    expect(r.container.querySelector('.stage')!.getAttribute('data-phase')).toBe('solat');
    expect(r.container.querySelector('[data-layer="ticker"]')).toBeNull();
    expect(r.queryByText(/Kutipan derma/)).toBeNull();
  });

  it('gives way on a notice with its picture and stays on a text-only notice (rule 13, pengumuman bergambar)', () => {
    const notice = { ...base, id: 'a1', title: 'Ruang solat wanita dibuka semula', body: 'Mulai hari ini.', from: '2026-11-01', to: '2026-11-30', priority: 2 as const };
    const onNotice = (pengumuman: KioskContent['pengumuman']) => {
      const c = fixture({ kuliah: [], pengumuman });
      const view = makeView('2026-11-03', '15:00');
      const rotation = buildRotation(c, view.settings, view.now);
      holder.view = view;
      holder.cv = { content: c, rotation, current: currentSlot(rotation, view.now), zikir: null, override: 'pengumuman' };
      return render(<Main view={view} lang="ms" />);
    };
    const text = onNotice([notice]);
    expect(text.container.querySelector('[data-card="pengumuman"]')).toBeTruthy();
    expect(strip(text)).toBeTruthy();
    cleanup();
    const pic = onNotice([{ ...notice, pictureAssetId: 'e'.repeat(64) } as KioskContent['pengumuman'][number]]);
    const card = pic.container.querySelector('[data-card="pengumuman"]')!;
    expect(card.classList.contains('has-picture')).toBe(true);
    expect(card.querySelector(`.pengumuman__pic img[src="/assets/${'e'.repeat(64)}"]`)).toBeTruthy();
    expect(strip(pic)).toBeNull();
    cleanup();
    // A picture id that is not an asset id is no picture: the text card and its ticker stay.
    const bad = onNotice([{ ...notice, pictureAssetId: '../x.png' } as KioskContent['pengumuman'][number]]);
    expect(bad.container.querySelector('.pengumuman__pic')).toBeNull();
    expect(strip(bad)).toBeTruthy();
  });

  it('a notice or programme picture that fails to load: text-only card and the ticker comes back (Q4)', () => {
    resetCardPictureFailures();
    const notice = { ...base, id: 'a1', title: 'Ruang solat wanita dibuka semula', body: 'Mulai hari ini.', from: '2026-11-01', to: '2026-11-30', priority: 2 as const };
    const at = (over: Partial<KioskContent>, feature: 'pengumuman' | 'programKhas') => {
      const c = fixture({ kuliah: [], ...over });
      const view = makeView('2026-11-03', '15:00');
      const rotation = buildRotation(c, view.settings, view.now);
      holder.view = view;
      holder.cv = { content: c, rotation, current: currentSlot(rotation, view.now), zikir: null, override: feature };
      return render(<Main view={view} lang="ms" />);
    };
    const missing = '9'.repeat(64);
    const r = at({ pengumuman: [{ ...notice, pictureAssetId: missing } as KioskContent['pengumuman'][number]] }, 'pengumuman');
    expect(strip(r)).toBeNull();
    fireEvent.error(r.container.querySelector('.pengumuman__pic img')!);
    const card = r.container.querySelector('[data-card="pengumuman"]')!;
    expect(card.classList.contains('has-picture')).toBe(false);
    expect(card.querySelector('.pengumuman__pic, .pengumuman__main')).toBeNull();
    expect([...card.children].map((e) => e.className)).toEqual(['card__tag', 'pengumuman__text']);
    expect(r.getByText('Ruang solat wanita dibuka semula')).toBeTruthy();
    expect(strip(r)).toBeTruthy();
    cleanup();

    const prog = {
      ...base, id: 'pk1', title: 'Majlis Maulidur Rasul', at: '2026-11-20T20:30', assetId: '8'.repeat(64),
      note: 'Jamuan ringan.', status: 'aktif' as const,
    } as unknown as KioskContent['programKhas'][number];
    const p = at({ programKhas: [prog] }, 'programKhas');
    expect(strip(p)).toBeNull();
    fireEvent.error(p.container.querySelector('.program__img img')!);
    expect(p.container.querySelector('.program__img')).toBeNull();
    expect(p.getByText('Majlis Maulidur Rasul')).toBeTruthy();
    expect(strip(p)).toBeTruthy();
    resetCardPictureFailures();
  });
});
