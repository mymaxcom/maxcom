import type { Settings } from '../features/registry.ts';
import type { TabungCardView, TabungRow } from '../finance/types.ts';

/** Fund rows on one page of the tabung screen (read from about 10 m). */
export const TABUNG_PER_PAGE = 4;
/** Small fund tiles on one page under the featured fund. */
export const TABUNG_FEATURED_PER_PAGE = 3;
/** Funds on one summary page (two columns of 8). More funds take more summary pages, balanced. */
export const TABUNG_SUMMARY_PER_PAGE = 16;
/**
 * Most pages one showing of the card turns through (its rotation slot is at most this many times durationSeconds).
 * A screen with more pages shows the next ones at its next showing (tabungWindowPage), so every fund is still seen.
 */
export const TABUNG_SHOWING_MAX_PAGES = 8;

/**
 * One page of the tabung screen. A summary page carries `count`, the number of all funds (its title), and `totalSen`,
 * the total of every fund on the last summary page when the figure is the balance; null on the others (a total of the
 * month's or the last entry's figures means nothing).
 */
export type TabungPage =
  | { kind: 'rows'; rows: TabungRow[] }
  | { kind: 'single'; row: TabungRow }
  | { kind: 'featured'; hero: TabungRow; minis: TabungRow[] }
  | { kind: 'summary'; rows: TabungRow[]; count: number; totalSen: number | null };

/**
 * Splits a list into the fewest pages of at most `max`, filled evenly and in order: 5 -> 3+2, 6 -> 3+3, 9 -> 3+3+3,
 * 15 -> 4+4+4+3 (max 4). An empty list gives no page.
 */
export function splitBalanced<T>(list: readonly T[], max: number): T[][] {
  const per = Math.max(1, Math.floor(max));
  const n = Math.ceil(list.length / per);
  const out: T[][] = [];
  let i = 0;
  for (let p = 0; p < n; p++) {
    const size = Math.ceil((list.length - i) / (n - p));
    out.push(list.slice(i, i + size));
    i += size;
  }
  return out;
}

/** Tetapan tabungCard.featured ("Tonjolkan tabung pertama"): off unless switched on. */
export function tabungFeatured(settings: Settings | undefined): boolean {
  const card = (settings as unknown as Record<string, { featured?: unknown } | undefined> | undefined)?.tabungCard;
  return card?.featured === true;
}

/**
 * The pages of the tabung screen, in the order the admin set the funds (Fund.sortOrder, public funds only, already in
 * `view.rows`):
 * - one fund: the single-fund page (ring and very large amount);
 * - featured on and two funds or more: the first fund large on every page, the others as small tiles, 3 per page;
 * - otherwise rows, at most 4 per page, balanced; the manual variant (finance off) the same way;
 * - two pages or more (not manual): summary pages with every fund, at most 16 a page (balanced), the total on the last
 *   one when the figure is the balance.
 * A view with no rows has no page.
 */
export function tabungPages(view: TabungCardView | null | undefined, featured = false): TabungPage[] {
  const rows = view?.rows ?? [];
  if (rows.length === 0) return [];
  if (view!.manual) return splitBalanced(rows, TABUNG_PER_PAGE).map((r) => ({ kind: 'rows', rows: r }));
  if (rows.length === 1) return [{ kind: 'single', row: rows[0]! }];
  const pages: TabungPage[] = featured
    ? splitBalanced(rows.slice(1), TABUNG_FEATURED_PER_PAGE).map((m) => ({ kind: 'featured', hero: rows[0]!, minis: m }))
    : splitBalanced(rows, TABUNG_PER_PAGE).map((r) => ({ kind: 'rows', rows: r }));
  if (pages.length >= 2) {
    const parts = splitBalanced(rows, TABUNG_SUMMARY_PER_PAGE);
    const total = view!.figure === 'balance' ? tabungTotalSen(rows) : null;
    parts.forEach((part, i) => pages.push({ kind: 'summary', rows: part, count: rows.length, totalSen: i === parts.length - 1 ? total : null }));
  }
  return pages;
}

/**
 * How many pages one showing of the tabung screen turns through (at most TABUNG_SHOWING_MAX_PAGES): the rotation gives
 * the card this many times its durationSeconds.
 */
export function tabungPageCount(view: TabungCardView | null | undefined, settings: Settings | undefined): number {
  return Math.min(tabungPages(view, tabungFeatured(settings)).length, TABUNG_SHOWING_MAX_PAGES);
}

/**
 * The page (of all `total`) at page `clockPage` of showing number `showing`: with more than TABUNG_SHOWING_MAX_PAGES
 * pages each showing takes the next run of that many, wrapping round, so showing k, k+1, ... continue where the last
 * one stopped and every page comes round within ceil(total / max) showings. With fewer pages the clock page as it is.
 */
export function tabungWindowPage(total: number, showing: number, clockPage: number): number {
  const c = Math.max(0, Math.floor(clockPage));
  if (!(total > TABUNG_SHOWING_MAX_PAGES)) return c;
  const s = Number.isFinite(showing) ? Math.max(0, Math.floor(showing)) : 0;
  return ((s % total) * TABUNG_SHOWING_MAX_PAGES + c) % total;
}

/** Whether a fund's "Baru" moment is still on at `nowMs` (TabungRow.highlightUntil, from tabungCard.highlightSeconds). */
export function tabungHot(row: TabungRow, nowMs: number): boolean {
  return row.highlightUntil !== null && Date.parse(row.highlightUntil) > nowMs;
}

/** The first page (never the summary) holding a fund that is hot at `nowMs`, or -1 when no fund is. */
export function tabungHotPage(pages: readonly TabungPage[], nowMs: number): number {
  return pages.findIndex((p) => {
    switch (p.kind) {
      case 'rows': return p.rows.some((r) => tabungHot(r, nowMs));
      case 'single': return tabungHot(p.row, nowMs);
      case 'featured': return tabungHot(p.hero, nowMs) || p.minis.some((r) => tabungHot(r, nowMs));
      default: return false;
    }
  });
}

/**
 * The page on screen: while a fund is hot ("Baru", tabungCard.highlightSeconds) the page holding it, whatever page
 * the clock is on, so a new donation is always seen; else the page the clock gives (`clockPage`, turning every
 * durationSeconds).
 */
export function tabungShownPage(pages: readonly TabungPage[], nowMs: number, clockPage: number): number {
  const hot = tabungHotPage(pages, nowMs);
  if (hot >= 0) return hot;
  return pages.length > 0 ? Math.min(Math.max(0, Math.floor(clockPage)), pages.length - 1) : 0;
}

/** Sum of the funds' figures (the summary page's total). */
export function tabungTotalSen(rows: readonly TabungRow[]): number {
  return rows.reduce((a, r) => a + r.valueSen, 0);
}
