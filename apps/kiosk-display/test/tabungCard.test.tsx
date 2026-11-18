import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { buildCycle, currentSlot } from '@surau/core';
import type { KioskContent, SlotFeature, TabungCardView } from '@surau/core';
import { makeView } from './helpers.tsx';
import type { ViewOpts } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';
import type { ContentView } from '../src/data/content.ts';
import { loadContent } from '../src/data/content.ts';

const holder = vi.hoisted(() => ({ view: null as unknown as KioskView, cv: null as unknown as ContentView }));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));
vi.mock('../src/data/content.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/data/content.ts')>();
  return { ...orig, useContent: () => holder.cv };
});

import { Main } from '../src/screens/Main.tsx';
import { FIGURE_FIT_MIN, figureFitFactor, TabungCard } from '../src/content/cards/TabungCard.tsx';

const QR = 'e'.repeat(64);
const row = (id: string, name: string, valueSen: number, over: Partial<TabungCardView['rows'][number]> = {}): TabungCardView['rows'][number] => ({
  id, name, valueSen, subLabel: null, subSen: null, targetSen: null, highlightUntil: null, ...over,
});

function tabung(over: Partial<TabungCardView> = {}): TabungCardView {
  return {
    title: 'Tabung Surau', manual: false, figure: 'balance', updatedAt: '2026-11-03T05:00:00.000Z', qrAssetId: null,
    rows: [
      row('f1', 'Tabung Jumaat', 135680, { subLabel: 'Kutipan Jumaat terakhir', subSen: 28000 }),
      row('f2', 'Tabung Am', 5000, { subLabel: 'Bulan ini', subSen: 1500 }),
      row('f3', 'Tabung Pembangunan', 3200000, { targetSen: 10000000 }),
    ],
    ...over,
  };
}

function fixture(t?: TabungCardView | null): KioskContent {
  return {
    date: '2026-11-03', kuliah: [], pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [], hadisToday: [], worldTimes: [],
    tugasan: [], ayat: { today: null, tomorrow: null }, zikir: [], tilawah: { slots: [], available: {} },
    credits: { translation: 't', font: 'f', audio: 'a' }, ...(t === undefined ? {} : { tabung: t }),
  };
}

function show(content: KioskContent, card: SlotFeature | null, opts: ViewOpts = {}) {
  const view = makeView('2026-11-03', '15:00', { settings: { tabungCard: { enabled: true } }, ...opts });
  const cycle = buildCycle(content, view.settings, view.now);
  holder.view = view;
  holder.cv = { content, rotation: cycle.slots, current: currentSlot(cycle.slots, view.now, cycle.cycleStartSec), zikir: null, override: card };
  return render(<Main view={view} lang="ms" />);
}

let play: ReturnType<typeof vi.spyOn>;
beforeEach(() => { play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve()); });
afterEach(() => { cleanup(); play.mockRestore(); });
const card = (r: ReturnType<typeof render>) => r.container.querySelector('[data-card="tabung"]');

describe('TabungCard', () => {
  it('shows Dikemas kini as the local date of the surau, not the UTC date', () => {
    // 22:30 UTC on the 6th is already 06:30 on the 7th in Kuala Lumpur.
    const late = show(fixture(tabung({ updatedAt: '2026-11-06T22:30:00Z' })), 'tabungCard');
    expect(card(late)!.textContent).toContain('Dikemas kini 07/11/2026');
    expect(card(late)!.textContent).not.toContain('06/11/2026');
    cleanup();
    // The same day either way.
    const noon = show(fixture(tabung({ updatedAt: '2026-11-03T05:00:00.000Z' })), 'tabungCard');
    expect(card(noon)!.textContent).toContain('Dikemas kini 03/11/2026');
  });

  it('shows a row per tabung with RM and the figure on one line, the small line, and percent, bar and target', () => {
    const c = card(show(fixture(tabung()), 'tabungCard'))!;
    expect(c).toBeTruthy();
    expect(c.getAttribute('data-page-kind')).toBe('rows');
    expect(c.querySelectorAll('.tabung__row')).toHaveLength(3);
    expect(c.querySelector('.tabung__rows')!.classList.contains('n-3')).toBe(true);
    expect(c.textContent).toContain('Tabung surau');
    expect(c.textContent).toContain('Tabung Jumaat');
    expect(c.querySelector('[data-fund="f1"] .tabung__value b')!.textContent).toBe('1,356.80');
    expect(c.querySelector('[data-fund="f1"] .tabung__value small')!.textContent).toBe('RM');
    expect(c.querySelector('[data-fund="f1"] .tabung__sub')!.textContent).toBe('Kutipan Jumaat terakhir: RM 280.00');
    const bar = c.querySelector('[data-fund="f3"] [role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('32');
    expect((bar.querySelector('i') as HTMLElement).style.width).toBe('32%');
    expect(c.querySelector('[data-fund="f3"] .tabung__pct')!.textContent).toBe('32%');
    expect(c.querySelector('[data-fund="f3"] .tabung__tgt')!.textContent).toBe('daripada sasaran RM 100,000.00');
    // One page: no page dots.
    expect(c.querySelector('.tabung__dots')).toBeNull();
  });

  it('a fund past its target: a full bar, 100% and Sasaran tercapai', () => {
    const t = tabung({ rows: [row('o1', 'Tabung Bantuan Banjir', 1045025, { targetSen: 1000000 }), row('o2', 'Tabung Am', 5000)] });
    const c = card(show(fixture(t), 'tabungCard'))!;
    const over = c.querySelector('[data-fund="o1"]')!;
    expect(over.classList.contains('is-done')).toBe(true);
    expect(over.querySelector('.tabung__pct')!.textContent).toBe('100%');
    expect((over.querySelector('.tabung__bar i') as HTMLElement).style.width).toBe('100%');
    expect(over.querySelector('.tabung__done')!.textContent).toBe('Sasaran tercapai');
    expect(over.querySelector('.tabung__tgt')).toBeNull();
  });

  it('one fund: the ring, a very large amount and Baki diperlukan', () => {
    const c = card(show(fixture(tabung({ rows: [row('s1', 'Tabung Pembinaan Ruang Wuduk', 3248050, { targetSen: 5000000 })] })), 'tabungCard'))!;
    expect(c.getAttribute('data-page-kind')).toBe('single');
    expect(c.querySelector('.tabung__ring')!.getAttribute('aria-valuenow')).toBe('64');
    expect(c.textContent).toContain('Baki diperlukan RM 17,519.50');
    expect(c.querySelector('.tabung__value b')!.textContent).toBe('32,480.50');
  });

  it('highlights the hot tabung with no amount and no percent, and not an expired one', () => {
    const view = makeView('2026-11-03', '15:00');
    const live = new Date(view.now.getTime() + 15_000).toISOString();
    const gone = new Date(view.now.getTime() - 1_000).toISOString();
    const t = tabung();
    t.rows[2] = { ...t.rows[2]!, highlightUntil: live };
    t.rows[1] = { ...t.rows[1]!, highlightUntil: gone };
    const c = card(show(fixture(t), 'tabungCard'))!;
    const hot = c.querySelector('[data-fund="f3"]')!;
    expect(hot.classList.contains('is-hot')).toBe(true);
    expect(c.querySelector('[data-fund="f2"]')!.classList.contains('is-hot')).toBe(false);
    expect(c.querySelectorAll('.is-hot')).toHaveLength(1);
    expect(hot.textContent).toContain('Baru');
    expect(hot.textContent).toContain('Sumbangan baru diterima');
    expect(hot.textContent).toContain('Terima kasih. Semoga Allah membalas kebaikan anda.');
    expect(hot.querySelector('.tabung__value, .tabung__pct, [role="progressbar"]')).toBeNull();
    expect(hot.textContent).not.toMatch(/RM|%/);
  });

  it('shows every fund (no limit of 4): pages of at most 4 with dots, the hot fund on screen first', () => {
    const view = makeView('2026-11-03', '15:00');
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((n, i) => row(n, `Tabung ${n}`, (i + 1) * 100));
    rows[7] = { ...rows[7]!, highlightUntil: new Date(view.now.getTime() + 15_000).toISOString() };
    const c = card(show(fixture(tabung({ qrAssetId: QR, rows })), 'tabungCard'))!;
    // 9 funds: 3 + 3 + 3 and the summary; the page with fund h is on screen.
    expect([...c.querySelectorAll('.tabung__row')].map((e) => e.getAttribute('data-fund'))).toEqual(['g', 'h', 'i']);
    expect(c.querySelectorAll('.tabung__dots i')).toHaveLength(4);
    expect(c.querySelector('.tabung__dots .num')!.textContent).toBe('3/4');
    expect(c.querySelector('.tabung__dots i:nth-child(3)')!.classList.contains('is-on')).toBe(true);
  });

  it('draws the QR panel only for a valid picture id; without one the rows take the whole width', () => {
    const c = card(show(fixture(tabung({ qrAssetId: QR })), 'tabungCard'))!;
    expect(c.querySelector(`.tabung__qr img[src="/assets/${QR}"]`)).toBeTruthy();
    expect(c.classList.contains('has-qr')).toBe(true);
    expect(c.textContent).toContain('Imbas untuk menderma');
    expect(c.textContent).toContain('DuitNow QR');
    expect(c.textContent).toContain('Boleh guna mana-mana aplikasi bank atau e-dompet');
    cleanup();
    const none = card(show(fixture(tabung({ qrAssetId: null })), 'tabungCard'))!;
    expect(none.classList.contains('no-qr')).toBe(true);
    expect(none.querySelector('.tabung__qr')).toBeNull();
    cleanup();
    const bad = card(show(fixture(tabung({ qrAssetId: '../../x' })), 'tabungCard'))!;
    expect(bad.querySelector('img')).toBeNull();
    expect(bad.classList.contains('no-qr')).toBe(true);
  });

  it('the manual variant lists the typed rows with its own title, same rows without bars or small lines', () => {
    const t = tabung({ manual: true, title: 'Tabung Masjid', rows: [row('manual-1', 'Kutipan Jumaat 06/11/2026', 135680), row('manual-2', 'Derma Pembangunan', 2500000)] });
    const c = card(show(fixture(t), 'tabungCard'))!;
    expect(c.classList.contains('card--tabung-manual')).toBe(true);
    expect(c.textContent).toContain('Tabung Masjid');
    expect(c.querySelectorAll('.tabung__row')).toHaveLength(2);
    expect(c.querySelector('.tabung__sub')).toBeNull();
    expect(c.querySelector('[role="progressbar"]')).toBeNull();
    expect(c.querySelector('[data-fund="manual-2"] .tabung__value b')!.textContent).toBe('25,000.00');
  });

  it('the featured fund (Tetapan) is large above the other funds as tiles, 3 a page, without target text', () => {
    const rows = [row('h', 'Tabung Wuduk', 3248050, { targetSen: 5000000 }), ...['a', 'b', 'c', 'd'].map((n) => row(n, `Tabung ${n}`, 100, { targetSen: 1000 }))];
    const c = card(show(fixture(tabung({ rows })), 'tabungCard', { settings: { tabungCard: { enabled: true, featured: true } } }))!;
    expect(c.getAttribute('data-page-kind')).toBe('featured');
    expect(c.querySelector('.tabung__fhero')!.getAttribute('data-fund')).toBe('h');
    expect(c.querySelector('.tabung__fhero .tabung__ring')).toBeTruthy();
    expect(c.querySelectorAll('.tabung__mini').length).toBeLessThanOrEqual(3);
    expect(c.querySelector('.tabung__mini .tabung__tgt')).toBeNull();
    expect(c.querySelector('.tabung__fsub .tabung__dots')).toBeTruthy();
  });

  it('renders nothing for an empty or absent tabung', () => {
    expect(card(show(fixture(tabung({ rows: [] })), 'tabungCard'))).toBeNull();
    cleanup();
    expect(card(show(fixture(null), 'tabungCard'))).toBeNull();
  });

  it('is in the rotation when the card is on and has rows, after the kuliah card by order', () => {
    const view = makeView('2026-11-03', '15:00', { settings: { tabungCard: { enabled: true } } });
    const slots = buildCycle(fixture(tabung()), view.settings, view.now).slots.map((s) => s.feature);
    expect(slots).toEqual(['tabungCard']);
    expect(buildCycle(fixture(tabung({ rows: [] })), view.settings, view.now).slots).toEqual([]);
    const off = makeView('2026-11-03', '15:00');
    expect(buildCycle(fixture(tabung()), off.settings, off.now).slots).toEqual([]);
  });
});

describe('TabungCard summary pages and fitting (fix round 2026-11-17)', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => row(`m${i + 1}`, `Tabung ${i + 1}`, (i + 1) * 1000));
  const settings = { settings: { tabungCard: { enabled: true } } };
  /** The card alone, at page `clock` of a showing that started `clock` pages ago (15 s a page). */
  function direct(t: TabungCardView, clock: number, showing?: number) {
    const view = makeView('2026-11-03', '15:00', settings);
    const startedAt = new Date(view.now.getTime() - clock * 15_000);
    return render(
      <TabungCard view={view} lang="ms" content={fixture(t)} itemId={null} startedAt={startedAt} durationSeconds={120} {...(showing === undefined ? {} : { page: showing })} />,
    );
  }

  it('N1: a negative figure keeps its minus on the summary page (figure month)', () => {
    const rows = [row('a', 'Tabung Am', 5000), row('b', 'Tabung Kebajikan', -12550), row('c', 'Tabung Jumaat', 700), row('d', 'Tabung Wakaf', 100), row('e', 'Tabung Banjir', 300)];
    const c = card(direct(tabung({ figure: 'month', rows }), 2))!; // 3 + 2 rows, page 3 is the summary
    expect(c.getAttribute('data-page-kind')).toBe('summary');
    const amt = c.querySelector('[data-fund="b"] .tabung__samt')!;
    expect(amt.textContent).toBe('-RM125.50');
    expect(amt.querySelector('small')!.textContent).toBe('-RM');
    expect(c.querySelector('[data-fund="a"] .tabung__samt small')!.textContent).toBe('RM');
  });

  it('Q2: Jumlah semua tabung only when the figure is the balance', () => {
    const rows = many(5);
    const month = card(direct(tabung({ figure: 'month', rows }), 2))!;
    expect(month.getAttribute('data-page-kind')).toBe('summary');
    expect(month.querySelector('.tabung__total')).toBeNull();
    expect(month.textContent).not.toContain('Jumlah');
    expect(month.querySelectorAll('.tabung__srow')).toHaveLength(5);
    cleanup();
    const bal = card(direct(tabung({ figure: 'balance', rows }), 2))!;
    expect(bal.querySelector('.tabung__total .tabung__value b')!.textContent).toBe('150.00');
  });

  it('Q4: 40 funds give three summary pages of at most 16, the title keeps 40, the total on the last only', () => {
    // 40 funds: 10 pages of rows, then summary pages 11-13; showing 1 starts at page 8, so clock 2..4 are 11..13.
    const seen: string[] = [];
    for (const clock of [2, 3, 4]) {
      const c = card(direct(tabung({ rows: many(40) }), clock, 1))!;
      expect(c.getAttribute('data-page-kind')).toBe('summary');
      expect(c.querySelector('.tabung__title')!.textContent).toBe('Semua tabung (40)');
      const r = [...c.querySelectorAll('.tabung__srow')].map((e) => e.getAttribute('data-fund')!);
      expect(r.length).toBeLessThanOrEqual(16);
      seen.push(...r);
      expect(c.querySelector('.tabung__total') !== null).toBe(clock === 4);
      expect(c.querySelector('.tabung__dots .num')!.textContent).toBe(`${8 + clock + 1}/13`);
      cleanup();
    }
    expect(seen).toEqual(many(40).map((r) => r.id));
  });

  it('Q6: no Baru on the summary page', () => {
    const c = card(direct(tabung({ rows: many(5) }), 2))!;
    expect(c.getAttribute('data-page-kind')).toBe('summary');
    expect(c.querySelector('.tabung__summary .tabung__new, .tabung__summary .tabung__thanks')).toBeNull();
  });

  it('S2: the figure size never goes below the floor, however long the figure', () => {
    expect(FIGURE_FIT_MIN).toBe(0.2);
    expect(figureFitFactor(1, [{ w: 100, need: 1e9 }])).toBe(FIGURE_FIT_MIN);
    expect(figureFitFactor(1, [{ w: 100, need: 50 }])).toBe(1);
    expect(figureFitFactor(1, [{ w: 100, need: 200 }])).toBe(0.49);
    expect(figureFitFactor(1, [{ w: 0, need: 0 }])).toBeNull();
  });

  describe('with layout measured', () => {
    const restore: (() => void)[] = [];
    const stub = (prop: 'scrollHeight' | 'offsetWidth' | 'clientWidth', get: (el: HTMLElement) => number) => {
      const before = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
      Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get() { return get(this as HTMLElement); } });
      restore.push(() => {
        if (before) Object.defineProperty(HTMLElement.prototype, prop, before);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
      });
    };
    afterEach(() => { for (const r of restore.splice(0).reverse()) r(); });

    const at = (view: ReturnType<typeof makeView>, t: TabungCardView, startedAt: Date) => (
      <TabungCard view={view} lang="ms" content={fixture(t)} itemId={null} startedAt={startedAt} durationSeconds={15} />
    );
    const later = (from: Date, ms: number) => makeView('2026-11-03', '15:00', { ...settings, at: new Date(from.getTime() + ms) });

    it('Q1: the page fits again when the Baru moment ends', () => {
      // The body overflows while a fund is hot (the Baru row is laid out differently), and fits once it is not.
      stub('scrollHeight', (el) => (el.classList.contains('tabung__body') && el.querySelector('.is-hot') ? 1000 : 0));
      const v0 = makeView('2026-11-03', '15:00', settings);
      const t = tabung();
      t.rows[1] = { ...t.rows[1]!, highlightUntil: new Date(v0.now.getTime() + 5_000).toISOString() };
      const r = render(at(v0, t, v0.now));
      const fit = () => (r.container.querySelector('.tabung__body') as HTMLElement).style.getPropertyValue('--fit').trim();
      expect(fit()).toBe('0.55');
      r.rerender(at(later(v0.now, 6_000), t, v0.now));
      expect(r.container.querySelector('.is-hot')).toBeNull();
      expect(fit()).toBe('1');
    });

    it('N3: the figures are not measured again on a clock tick of the same page', () => {
      let reads = 0;
      stub('offsetWidth', (el) => {
        if (!el.classList.contains('tabung__value')) return 0;
        reads++;
        return 50;
      });
      stub('clientWidth', () => 100);
      const v0 = makeView('2026-11-03', '15:00', settings);
      const r = render(at(v0, tabung(), v0.now));
      expect(reads).toBeGreaterThan(0);
      const first = reads;
      for (let s = 1; s <= 3; s++) r.rerender(at(later(v0.now, s * 1000), tabung(), v0.now));
      expect(reads).toBe(first);
    });
  });
});

describe('content envelope', () => {
  const okWith = (tab: unknown) => (async () => new Response(JSON.stringify({ version: 1, serverTime: '2026-11-03T07:52:00.000Z', content: { ...fixture(), tabung: tab } }), { status: 200 })) as unknown as typeof fetch;
  const store = (): Storage => {
    const m = new Map<string, string>();
    return { get length() { return m.size; }, clear: () => m.clear(), getItem: (k) => m.get(k) ?? null, key: (i) => [...m.keys()][i] ?? null, removeItem: (k) => { m.delete(k); }, setItem: (k, v) => { m.set(k, v); } };
  };
  it('accepts null and an object, and refuses a number', async () => {
    expect((await loadContent(okWith(null), store())).source).toBe('network');
    expect((await loadContent(okWith(tabung()), store())).content.tabung?.rows).toHaveLength(3);
    await expect(loadContent(okWith(5), store())).rejects.toThrow(/no content/);
  });
});
