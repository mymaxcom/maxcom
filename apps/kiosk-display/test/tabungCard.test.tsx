import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { buildCycle, currentSlot, instantOf } from '@surau/core';
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

  it('shows a column per tabung with the figure in RM and sen, the small line and the target bar at 32 percent', () => {
    const r = show(fixture(tabung()), 'tabungCard');
    const c = card(r)!;
    expect(c).toBeTruthy();
    expect(c.querySelectorAll('.tabung__col')).toHaveLength(3);
    expect(c.textContent).toContain('Tabung Jumaat');
    expect(c.querySelector('[data-fund="f1"] .tabung__value b')!.textContent).toBe('1,356.80');
    expect(c.querySelector('[data-fund="f1"] .tabung__value small')!.textContent).toBe('RM');
    expect(c.querySelector('[data-fund="f1"] .tabung__sub')!.textContent).toBe('Kutipan Jumaat terakhir: RM 280.00');
    const bar = c.querySelector('[data-fund="f3"] [role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('32');
    expect((bar.querySelector('i') as HTMLElement).style.width).toBe('32%');
    expect(c.textContent).toContain('32% daripada sasaran RM 100,000.00');
    expect(c.querySelector('.tabung__qr')).toBeNull();
  });

  it('highlights the tabung whose time has not run out, shows no amount change, and not an expired one', () => {
    const view = makeView('2026-11-03', '15:00');
    const live = new Date(view.now.getTime() + 15_000).toISOString();
    const gone = new Date(view.now.getTime() - 1_000).toISOString();
    const t = tabung();
    t.rows[0] = { ...t.rows[0]!, highlightUntil: live };
    t.rows[1] = { ...t.rows[1]!, highlightUntil: gone };
    const c = card(show(fixture(t), 'tabungCard'))!;
    expect(c.querySelector('[data-fund="f1"]')!.classList.contains('tabung__col--hot')).toBe(true);
    expect(c.querySelector('[data-fund="f2"]')!.classList.contains('tabung__col--hot')).toBe(false);
    expect(c.querySelectorAll('.tabung__col--hot')).toHaveLength(1);
    expect(c.textContent).not.toMatch(/\+\s*RM/);
  });

  it('draws the QR only for a valid picture id, and never more than four columns', () => {
    const many = tabung({ qrAssetId: QR, rows: ['a', 'b', 'c', 'd', 'e'].map((n, i) => row(n, `Tabung ${n}`, i * 100)) });
    const c = card(show(fixture(many), 'tabungCard'))!;
    expect(c.querySelector(`img[src="/assets/${QR}"]`)).toBeTruthy();
    expect(c.querySelectorAll('.tabung__col')).toHaveLength(4);
    cleanup();
    const bad = card(show(fixture(tabung({ qrAssetId: '../../x' })), 'tabungCard'))!;
    expect(bad.querySelector('img')).toBeNull();
  });

  it('the manual variant lists the typed rows with its own title and no bars or small lines', () => {
    const t = tabung({ manual: true, title: 'Tabung Masjid', rows: [row('manual-1', 'Kutipan Jumaat 06/11/2026', 135680), row('manual-2', 'Derma Pembangunan', 2500000)] });
    const c = card(show(fixture(t), 'tabungCard'))!;
    expect(c.classList.contains('card--tabung-manual')).toBe(true);
    expect(c.textContent).toContain('Tabung Masjid');
    expect(c.querySelectorAll('.tabung__col')).toHaveLength(2);
    expect(c.querySelector('.tabung__sub')).toBeNull();
    expect(c.querySelector('[role="progressbar"]')).toBeNull();
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
    void instantOf;
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
