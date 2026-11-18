import { describe, expect, it } from 'vitest';
import {
  FEATURES, resolveSettings, splitBalanced, TABUNG_PER_PAGE, TABUNG_SHOWING_MAX_PAGES, tabungFeatured, tabungHotPage, tabungPageCount,
  tabungPages, tabungShownPage, tabungTotalSen, tabungWindowPage,
} from '../src/index.ts';
import type { KioskContent, TabungCardView, TabungPage, TabungRow } from '../src/index.ts';
import { buildCycle, buildRotation } from '../src/content/rotation.ts';

const row = (i: number, over: Partial<TabungRow> = {}): TabungRow => ({
  id: `f${i}`, name: `Tabung ${i}`, valueSen: i * 1000, subLabel: null, subSen: null, targetSen: null, highlightUntil: null, ...over,
});
const view = (n: number, over: Partial<TabungCardView> = {}): TabungCardView => ({
  title: 'Tabung Surau', manual: false, figure: 'balance', updatedAt: null, qrAssetId: null,
  rows: Array.from({ length: n }, (_, i) => row(i + 1)), ...over,
});
const sizes = (n: number): number[] => splitBalanced(Array.from({ length: n }, (_, i) => i), TABUNG_PER_PAGE).map((p) => p.length);
const NOW = Date.parse('2026-11-03T07:52:00.000Z');

describe('tabung paging split', () => {
  it('splits 1..15 funds into the fewest pages of at most 4, balanced and in order', () => {
    const want: Record<number, number[]> = {
      1: [1], 2: [2], 3: [3], 4: [4], 5: [3, 2], 6: [3, 3], 7: [4, 3], 8: [4, 4], 9: [3, 3, 3], 10: [4, 3, 3],
      11: [4, 4, 3], 12: [4, 4, 4], 13: [4, 3, 3, 3], 14: [4, 4, 3, 3], 15: [4, 4, 4, 3],
    };
    for (let n = 1; n <= 15; n++) {
      expect(sizes(n), `${n} funds`).toEqual(want[n]);
      const flat = splitBalanced(Array.from({ length: n }, (_, i) => i), TABUNG_PER_PAGE).flat();
      expect(flat).toEqual(Array.from({ length: n }, (_, i) => i));
    }
    expect(sizes(0)).toEqual([]);
  });

  it('shows every fund however many there are (no limit of 4), then summary pages of at most 16 with all of them', () => {
    const pages = tabungPages(view(40));
    expect(pages).toHaveLength(13); // 10 pages of 4, then 14 + 13 + 13 on the summary pages
    expect(pages.slice(0, 10).every((p) => p.kind === 'rows' && p.rows.length <= 4)).toBe(true);
    const shown = pages.flatMap((p) => (p.kind === 'rows' ? p.rows.map((r) => r.id) : []));
    expect(shown).toEqual(view(40).rows.map((r) => r.id));
    const summary = pages.slice(10);
    expect(summary.map((p) => (p.kind === 'summary' ? p.rows.length : -1))).toEqual([14, 13, 13]);
    expect(summary.flatMap((p) => (p.kind === 'summary' ? p.rows.map((r) => r.id) : []))).toEqual(view(40).rows.map((r) => r.id));
    // The title keeps the real number of funds; the total only on the last summary page.
    expect(summary.map((p) => (p.kind === 'summary' ? p.count : -1))).toEqual([40, 40, 40]);
    expect(summary.map((p) => (p.kind === 'summary' ? p.totalSen : -1))).toEqual([null, null, tabungTotalSen(view(40).rows)]);
  });

  it('a summary of 16 funds or fewer is one page', () => {
    const pages = tabungPages(view(16));
    expect(pages.map((p) => p.kind)).toEqual(['rows', 'rows', 'rows', 'rows', 'summary']);
    const s = pages.at(-1)!;
    expect(s.kind === 'summary' && [s.rows.length, s.count, s.totalSen]).toEqual([16, 16, tabungTotalSen(view(16).rows)]);
  });

  it('the summary total only when the figure is the balance (Q2): a sum of the month or the last entry means nothing', () => {
    const totalOf = (figure: TabungCardView['figure']) => {
      const s = tabungPages(view(6, { figure })).at(-1)!;
      return s.kind === 'summary' ? s.totalSen : 'no summary';
    };
    expect(totalOf('balance')).toBe(21000);
    expect(totalOf('month')).toBeNull();
    expect(totalOf('lastEntry')).toBeNull();
  });

  it('one fund is the single page, 2..4 one page of rows, no summary for a single page', () => {
    expect(tabungPages(view(1)).map((p) => p.kind)).toEqual(['single']);
    expect(tabungPages(view(4)).map((p) => p.kind)).toEqual(['rows']);
    expect(tabungPages(view(5)).map((p) => p.kind)).toEqual(['rows', 'rows', 'summary']);
    expect(tabungPages(view(0))).toEqual([]);
    expect(tabungPages(null)).toEqual([]);
  });

  it('the manual variant (finance off) pages its rows the same way with no summary', () => {
    const m = view(3, { manual: true });
    expect(tabungPages(m).map((p) => p.kind)).toEqual(['rows']);
    expect(tabungPages(view(1, { manual: true })).map((p) => p.kind)).toEqual(['rows']);
    expect(tabungPages(view(6, { manual: true })).map((p) => p.kind)).toEqual(['rows', 'rows']);
    // Featured never applies to the typed rows.
    expect(tabungPages(m, true).map((p) => p.kind)).toEqual(['rows']);
  });

  it('featured: the first fund on every page, the others 3 at a time, then the summary', () => {
    const pages = tabungPages(view(6), true);
    expect(pages.map((p) => p.kind)).toEqual(['featured', 'featured', 'summary']);
    expect(pages.every((p) => p.kind !== 'featured' || p.hero.id === 'f1')).toBe(true);
    expect(pages.map((p) => (p.kind === 'featured' ? p.minis.length : 0))).toEqual([3, 2, 0]);
    expect(tabungPages(view(4), true).map((p) => p.kind)).toEqual(['featured']);
    expect(tabungPages(view(1), true).map((p) => p.kind)).toEqual(['single']);
  });

  it('sums the figures of every fund for the summary total', () => {
    expect(tabungTotalSen(view(15).rows)).toBe(120 * 1000);
    expect(tabungTotalSen([row(1, { valueSen: 3248050 }), row(2, { valueSen: -500 })])).toBe(3247550);
  });
});

describe('the hot fund ("Baru") and the page on screen', () => {
  it('shows the page holding the hot fund, whatever page the clock is on, and the clock page otherwise', () => {
    const v = view(9);
    v.rows[7] = { ...v.rows[7]!, highlightUntil: '2026-11-03T07:52:20.000Z' };
    const pages = tabungPages(v);
    expect(pages.map((p) => p.kind)).toEqual(['rows', 'rows', 'rows', 'summary']);
    expect(tabungHotPage(pages, NOW)).toBe(2);
    expect(tabungShownPage(pages, NOW, 0)).toBe(2);
    expect(tabungShownPage(pages, NOW, 3)).toBe(2);
    // Once the highlight is over the clock decides again.
    const later = Date.parse('2026-11-03T07:52:21.000Z');
    expect(tabungHotPage(pages, later)).toBe(-1);
    expect(tabungShownPage(pages, later, 3)).toBe(3);
    expect(tabungShownPage(pages, later, 9)).toBe(3);
  });

  it('finds a hot featured fund or tile, never on the summary page', () => {
    const v = view(6);
    v.rows[5] = { ...v.rows[5]!, highlightUntil: '2026-11-03T08:00:00.000Z' };
    expect(tabungHotPage(tabungPages(v, true), NOW)).toBe(1);
    expect(tabungHotPage(tabungPages(view(6)), NOW)).toBe(-1);
  });
});

describe('many funds: at most 8 pages a showing, the next showing goes on (Q4, S1)', () => {
  const ids = (p: TabungPage): string[] => {
    switch (p.kind) {
      case 'single': return [p.row.id];
      case 'featured': return [p.hero.id, ...p.minis.map((r) => r.id)];
      default: return p.rows.map((r) => r.id);
    }
  };
  for (const [n, featured] of [[40, false], [200, false], [200, true]] as const) {
    it(`${n} funds${featured ? ' (featured)' : ''}: the slot is 8 pages long and every fund comes round over the showings`, () => {
      const v = view(n);
      const pages = tabungPages(v, featured);
      const s = resolveSettings({ tabungCard: { enabled: true, featured } });
      expect(pages.length).toBeGreaterThan(TABUNG_SHOWING_MAX_PAGES);
      expect(tabungPageCount(v, s)).toBe(TABUNG_SHOWING_MAX_PAGES);
      const showings = Math.ceil(pages.length / TABUNG_SHOWING_MAX_PAGES);
      const seen = new Set<number>();
      for (let k = 0; k < showings; k++) {
        for (let c = 0; c < TABUNG_SHOWING_MAX_PAGES; c++) seen.add(tabungWindowPage(pages.length, k, c));
      }
      expect(seen.size).toBe(pages.length);
      // Each showing goes on from where the last one stopped.
      expect(tabungWindowPage(pages.length, 1, 0)).toBe(tabungWindowPage(pages.length, 0, TABUNG_SHOWING_MAX_PAGES - 1) + 1);
      const shown = new Set([...seen].flatMap((i) => ids(pages[i]!).filter(() => pages[i]!.kind !== 'summary')));
      expect(shown.size).toBe(n);
    });
  }

  it('8 pages or fewer: the clock page as it is', () => {
    expect(tabungWindowPage(5, 7, 3)).toBe(3);
    expect(tabungWindowPage(8, 2, 7)).toBe(7);
    expect(tabungWindowPage(9, 1, 0)).toBe(8);
    expect(tabungWindowPage(9, 2, 0)).toBe(7);
  });

  it('the rotation numbers the showings of a windowed tabung slot, one more each cycle, and leaves a short one alone', () => {
    const fixture = (t: TabungCardView): KioskContent => ({
      date: '2026-11-03', kuliah: [], pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [], hadisToday: [],
      worldTimes: [], tugasan: [], ayat: { today: null, tomorrow: null }, zikir: [], tilawah: { slots: [], available: {} },
      credits: { translation: '', font: '', audio: '' }, tabung: t,
    });
    const settings = resolveSettings({ tabungCard: { enabled: true, durationSeconds: 15 } });
    const slotAt = (t: TabungCardView, ms: number) => buildCycle(fixture(t), settings, new Date(ms)).slots.find((x) => x.feature === 'tabungCard')!;
    const a = slotAt(view(200), NOW);
    expect(a.durationSeconds).toBe(15 * TABUNG_SHOWING_MAX_PAGES);
    const cycle = buildCycle(fixture(view(200)), settings, new Date(NOW)).slots.reduce((x, y) => x + y.durationSeconds, 0);
    const b = slotAt(view(200), NOW + cycle * 1000);
    expect(typeof a.page).toBe('number');
    expect(b.page).toBe(a.page! + 1);
    expect(slotAt(view(6), NOW).page).toBeUndefined();
  });
});

describe('Tetapan tabungCard and the rotation', () => {
  const fixture = (t: TabungCardView | null): KioskContent => ({
    date: '2026-11-03', kuliah: [], pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [], hadisToday: [],
    worldTimes: [], tugasan: [], ayat: { today: null, tomorrow: null }, zikir: [], tilawah: { slots: [], available: {} },
    credits: { translation: '', font: '', audio: '' }, tabung: t,
  });
  const now = new Date(NOW);
  const dur = (t: TabungCardView | null, card: Record<string, unknown> = {}): number[] =>
    buildRotation(fixture(t), resolveSettings({ tabungCard: { enabled: true, ...card } }), now)
      .filter((s) => s.feature === 'tabungCard').map((s) => s.durationSeconds);

  it('gives the card durationSeconds per page: one page as before, more pages plus the summary page', () => {
    expect(dur(view(3))).toEqual([15]);
    expect(dur(view(1))).toEqual([15]);
    expect(dur(view(6))).toEqual([45]); // 3 + 3 and the summary
    expect(dur(view(15), { durationSeconds: 20 })).toEqual([100]); // 4 pages and the summary, 20 s each
    expect(dur(view(6), { featured: true, durationSeconds: 10 })).toEqual([30]); // 3 + 2 tiles and the summary
    expect(dur(view(0))).toEqual([]);
    expect(dur(null)).toEqual([]);
  });

  it('settings stored before the featured switch load unchanged, featured off', () => {
    const old = { tabungCard: { enabled: true, durationSeconds: 25, figure: 'month', highlightSeconds: 0, showTarget: false, qrAssetId: '' } };
    const s = resolveSettings(old);
    const card = (s as unknown as Record<string, Record<string, unknown>>).tabungCard!;
    expect(card.featured).toBe(false);
    expect(card).toMatchObject({ enabled: true, durationSeconds: 25, figure: 'month', highlightSeconds: 0, showTarget: false });
    expect(tabungFeatured(s)).toBe(false);
    expect(tabungFeatured(resolveSettings({ tabungCard: { featured: true } }))).toBe(true);
    expect(tabungPageCount(view(6), s)).toBe(3);
  });

  it('adds exactly one new tabungCard setting, the featured switch, default off', () => {
    const def = FEATURES.find((f) => f.key === 'tabungCard')!;
    expect(Object.keys(def.defaults)).toEqual([
      'durationSeconds', 'order', 'figure', 'highlightSeconds', 'showTarget', 'qrAssetId', 'featured',
      'manualTitle', 'row1Label', 'row1Sen', 'row2Label', 'row2Sen', 'row3Label', 'row3Sen',
    ]);
    expect((def.defaults as Record<string, unknown>).featured).toBe(false);
  });
});
