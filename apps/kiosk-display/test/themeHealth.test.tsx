import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/preact';
import { buildRotation, currentSlot } from '@surau/core';
import type { KioskContent } from '@surau/core';
import { makeView } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';
import type { ContentView } from '../src/data/content.ts';
import type { ElMetrics } from '../src/themes/health.ts';
import minSizes from '../src/themes/minSizes.json';

const holder = vi.hoisted(() => ({
  view: null as unknown as KioskView,
  cv: null as unknown as ContentView,
  metrics: null as null | ((el: Element) => unknown),
}));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));
vi.mock('../src/data/content.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/data/content.ts')>();
  return { ...orig, useContent: () => holder.cv };
});
// The real measure reads the layout (jsdom has none): the app-level tests choose what each element measures.
vi.mock('../src/themes/health.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/themes/health.ts')>();
  return { ...orig, realMeasure: (el: Element) => (holder.metrics ? holder.metrics(el) : orig.realMeasure(el)) };
});

import { App } from '../src/app.tsx';
import { checkScreenHealth, contrastRatio, HEALTH_DELAY_MS, HEALTH_INTERVAL_MS, MIN_CONTRAST, minSizeOf, over, parseColor, requiredRoles } from '../src/themes/health.ts';
import { MOTION_QUIET_MS, HEALTH_RECHECK_MS, REPORT_BACKOFF_MS } from '../src/themes/useThemeHealth.ts';
import { PACK_REJECT_CLEAR_MS } from '../src/themes/packLoader.ts';
import { PACK_LINK_ID, PROTECTED_STYLE_ID } from '../src/themes/packLoader.ts';

type Role = 'clock' | 'prayers' | 'countdown' | 'next' | 'logo';
const MIN = minSizes as unknown as Record<string, Record<string, Partial<Record<Role, number>>>>;
const good: ElMetrics = { displayed: true, visible: true, opacity: 1, rect: { left: 10, top: 10, right: 300, bottom: 100 }, fontRem: 10, heightRem: 4, covered: false, textHidden: false, contrast: 7 };
const vp = { width: 1920, height: 1080 };

/** A stage with one element per role, the metrics of each given by the test. */
function run(screen: Parameters<typeof checkScreenHealth>[1], present: Partial<Record<Role, ElMetrics>>, logoSet = false, base: 'creative' | 'default' = 'creative') {
  const stage = document.createElement('div');
  const table = new Map<Element, ElMetrics>();
  for (const [role, m] of Object.entries(present)) {
    const el = document.createElement('div');
    el.setAttribute('data-role', role);
    stage.appendChild(el);
    table.set(el, m);
  }
  return checkScreenHealth(stage, screen, { logoSet, base, viewport: vp, measure: (el) => table.get(el)! });
}
const fontOf = (screen: string, role: Role): number => MIN.creative![screen]![role]!;

describe('the protected rules text', () => {
  it('the readable protected.css and the string the loader injects are the same', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { PROTECTED_CSS } = await import('../src/themes/protectedCss.ts');
    const norm = (t: string): string => t.split(String.fromCharCode(13)).join('');
    expect(norm(readFileSync(resolve(process.cwd(), 'src/themes/protected.css'), 'utf8'))).toBe(norm(PROTECTED_CSS));
  });
});

describe('the protected rules cover every protected role and everything inside it', () => {
  it('every role, its descendants and their pseudo-elements get the full list, and the z-index sits above a pack and below the box overlays', async () => {
    const { PROTECTED_CSS } = await import('../src/themes/protectedCss.ts');
    const css = PROTECTED_CSS;
    for (const role of ['clock', 'prayers', 'countdown', 'next', 'logo']) {
      for (const form of ['', ' *', '::before', '::after', ' *::before', ' *::after']) {
        expect(css, role + form).toContain(`[data-role='${role}']:not([aria-hidden='true'] *)${form},`.replace(/,$/, ''));
      }
    }
    for (const decl of [
      'visibility: visible !important', 'opacity: 1 !important', 'filter: none !important', 'mix-blend-mode: normal !important', 'transform: none !important',
      'animation: none !important', 'transition: none !important', 'clip-path: none !important', 'mask-image: none !important', '-webkit-mask-image: none !important',
      '-webkit-text-fill-color: currentColor !important', 'content: none !important', 'z-index: 35 !important',
    ]) expect(css, decl).toContain(decl);
    // the position is a rule with no specificity (:where), so one that already positions the element is not overridden
    expect(css).toMatch(/:where\(\s*\.stage\[data-pack\] \[data-role='clock'\],[\s\S]*\) \{\s*position: relative;\s*\}/);
    // content: none only for the pseudo-elements, never on the element itself
    const contentBlock = css.slice(css.indexOf('content: none') - 600, css.indexOf('content: none'));
    expect(contentBlock).not.toMatch(/\[data-role='[a-z]+'\]:not\(\[aria-hidden='true'\] \*\),\s*html body[^{]*\{/);
  });

  it('the pack ceiling for z-index is below the protected z-index and below the box overlays', async () => {
    const { MAX_PACK_Z_INDEX } = await import('../../box-server/src/themes/cssCheck.ts');
    const { PROTECTED_CSS } = await import('../src/themes/protectedCss.ts');
    const z = Number(/z-index: (\d+) !important/.exec(PROTECTED_CSS)![1]);
    expect(MAX_PACK_Z_INDEX).toBeLessThan(z);
    expect(z).toBeLessThan(40);
  });
});

describe('the colour maths of the contrast check', () => {
  it('reads computed colours', () => {
    expect(parseColor('rgb(1, 2, 3)')).toEqual([1, 2, 3, 1]);
    expect(parseColor('rgba(10, 20, 30, 0.5)')).toEqual([10, 20, 30, 0.5]);
    expect(parseColor('rgb(10 20 30 / 25%)')).toEqual([10, 20, 30, 0.25]);
    expect(parseColor('transparent')).toBeNull();
    expect(parseColor('')).toBeNull();
  });
  it('white on black is 21, equal colours are 1, and the floor is 3', () => {
    expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 5);
    expect(contrastRatio([10, 10, 10], [10, 10, 10])).toBeCloseTo(1, 5);
    expect(contrastRatio([119, 119, 119], [255, 255, 255])).toBeGreaterThan(MIN_CONTRAST);
    expect(contrastRatio([160, 160, 160], [255, 255, 255])).toBeLessThan(MIN_CONTRAST);
  });
  it('a translucent colour is mixed over what is behind it', () => {
    const c = over([0, 0, 0, 0.5], [255, 255, 255, 1]);
    expect(c[0]).toBeCloseTo(127.5, 5);
    expect(c[3]).toBe(1);
    expect(over([1, 2, 3, 0], [9, 9, 9, 1])).toEqual([9, 9, 9, 1]);
  });
});

describe('the health check', () => {
  it('a covered element, hidden text and low contrast each fail it (a clock with a layer over it, text at no size, grey on grey)', () => {
    expect(run('biasa', { clock: { ...good, covered: true }, prayers: good, next: good }).failed).toEqual(['clock']);
    expect(run('biasa', { clock: good, prayers: { ...good, textHidden: true }, next: good }).failed).toEqual(['prayers']);
    expect(run('biasa', { clock: { ...good, contrast: 2.99 }, prayers: good, next: good }).failed).toEqual(['clock']);
    expect(run('biasa', { clock: { ...good, contrast: 3 }, prayers: good, next: good }).ok).toBe(true);
    // when the background cannot be known (a picture behind it) the contrast rule does not decide
    expect(run('biasa', { clock: { ...good, contrast: null }, prayers: good, next: good }).ok).toBe(true);
  });


  it('the size table was measured for every built-in theme', () => {
    expect(Object.keys(MIN).sort()).toEqual(['arabic', 'colourful', 'creative', 'default', 'minimal', 'oldschool']);
    for (const t of Object.values(MIN)) {
      expect(Object.keys(t)).toEqual(expect.arrayContaining(['biasa', 'azan', 'iqamah']));
      for (const screen of Object.values(t)) for (const rem of Object.values(screen)) expect(rem).toBeGreaterThan(0);
    }
  });

  it('biasa passes with clock, prayers and next present and sound', () => {
    expect(run('biasa', { clock: good, prayers: good, next: good })).toEqual({ ok: true, failed: [] });
  });

  it.each([
    ['display none', { displayed: false }],
    ['visibility hidden', { visible: false }],
    ['opacity 0.89', { opacity: 0.89 }],
    ['off the right edge', { rect: { left: 1800, top: 10, right: 1925, bottom: 100 } }],
    ['off the left edge', { rect: { left: -300, top: 10, right: -2, bottom: 100 } }],
    ['above the top', { rect: { left: 10, top: -5, right: 300, bottom: 100 } }],
    ['below the bottom', { rect: { left: 10, top: 1000, right: 300, bottom: 1082 } }],
    ['zero size', { rect: { left: 10, top: 10, right: 10, bottom: 10 } }],
    ['font below 90 percent', { fontRem: fontOf('biasa', 'clock') * 0.89 }],
  ] as Array<[string, Partial<ElMetrics>]>)('the clock with %s fails', (_n, over) => {
    expect(run('biasa', { clock: { ...good, ...over }, prayers: good, next: good })).toEqual({ ok: false, failed: ['clock'] });
  });

  it('opacity exactly 0.9, a box one pixel outside, and a font exactly 90 percent pass', () => {
    const edge: ElMetrics = { ...good, opacity: 0.9, rect: { left: -1, top: -1, right: 1921, bottom: 1081 }, fontRem: fontOf('biasa', 'clock') * 0.9 };
    expect(run('biasa', { clock: edge, prayers: good, next: good })).toEqual({ ok: true, failed: [] });
    expect(run('biasa', { clock: { ...edge, rect: { ...edge.rect, right: 1921.5 } }, prayers: good, next: good }).failed).toEqual(['clock']);
  });

  it('a missing element fails its role', () => {
    expect(run('azan', { clock: good, prayers: good }).failed).toEqual(['countdown']);
    expect(run('biasa', {}).failed).toEqual(['clock', 'prayers', 'next']);
  });

  it('live needs only the clock and the next chip', () => {
    expect(run('live', { clock: good, next: good })).toEqual({ ok: true, failed: [] });
    expect(run('live', { clock: good }).failed).toEqual(['next']);
  });

  it('with a logo set the logo is required on every screen, live and poster included', () => {
    expect(requiredRoles('live', true)).toEqual(['clock', 'next', 'logo']);
    expect(requiredRoles('poster', true)).toEqual(['clock', 'prayers', 'logo']);
    expect(requiredRoles('live', false)).toEqual(['clock', 'next']);
    expect(run('live', { clock: good, next: good }, true).failed).toEqual(['logo']);
    expect(run('live', { clock: good, next: good, logo: good }, true).ok).toBe(true);
  });

  it('the logo is measured by its height', () => {
    const need = minSizeOf('creative', 'biasa', 'logo');
    expect(need).toBeGreaterThan(0);
    expect(run('biasa', { clock: good, prayers: good, next: good, logo: { ...good, heightRem: need * 0.89, fontRem: 99 } }, true).failed).toEqual(['logo']);
    expect(run('biasa', { clock: good, prayers: good, next: good, logo: { ...good, heightRem: need, fontRem: 0 } }, true).ok).toBe(true);
  });

  it('a hidden duplicate does not count for or against: one sound element is enough', () => {
    const stage = document.createElement('div');
    const hidden = document.createElement('div');
    hidden.setAttribute('aria-hidden', 'true');
    const bad = document.createElement('div');
    bad.setAttribute('data-role', 'clock');
    hidden.appendChild(bad);
    const sound = document.createElement('div');
    sound.setAttribute('data-role', 'clock');
    stage.append(hidden, sound);
    const m = (el: Element): ElMetrics => (el === bad ? { ...good, displayed: false } : good);
    const others = ['prayers', 'next'].map((r) => { const e = document.createElement('div'); e.setAttribute('data-role', r); stage.appendChild(e); return e; });
    expect(others).toHaveLength(2);
    expect(checkScreenHealth(stage, 'biasa', { logoSet: false, base: 'creative', viewport: vp, measure: m })).toEqual({ ok: true, failed: [] });
    // and when the only element is hidden, the role is missing
    stage.removeChild(sound);
    expect(checkScreenHealth(stage, 'biasa', { logoSet: false, base: 'creative', viewport: vp, measure: m }).failed).toEqual(['clock']);
  });

  it('syuruk, isyraq and tarawih require the clock and the prayer times', () => {
    expect(requiredRoles('tarawih', false)).toEqual(['clock', 'prayers']);
    expect(requiredRoles('syuruk', false)).toEqual(['clock', 'prayers']);
    expect(requiredRoles('isyraq', true)).toEqual(['clock', 'prayers', 'logo']);
  });

  it('a screen with no table entry uses the smallest value of that role across the theme', () => {
    const smallest = Math.min(...Object.values(MIN.creative!).map((s) => s.clock).filter((v): v is number => v !== undefined));
    expect(minSizeOf('creative', 'tarawih', 'clock')).toBe(smallest);
    expect(minSizeOf('creative', 'biasa', 'clock')).toBe(MIN.creative!.biasa!.clock);
  });

  it('a throwing measure counts as a failure of that element, never as a crash', () => {
    const stage = document.createElement('div');
    const el = document.createElement('div');
    el.setAttribute('data-role', 'clock');
    stage.appendChild(el);
    const r = checkScreenHealth(stage, 'tiada-data', { logoSet: false, base: 'creative', viewport: vp, measure: () => { throw new Error('x'); } });
    expect(r).toEqual({ ok: false, failed: ['clock'] });
  });
});

// ---- the stage ---------------------------------------------------------------------------------------------------------
const packs = { 'hijau-siti': { assetId: 'a'.repeat(64), version: 3, title: 'Hijau Siti', base: 'creative', contract: 1, bytes: 1, fonts: [], screens: [], images: {}, defaults: {} } };
const content = (): KioskContent => ({
  date: '2026-11-03', kuliah: [], pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [], hadisToday: [], worldTimes: [], tugasan: [],
  ayat: { today: null, tomorrow: null }, zikir: [], tilawah: { slots: [], available: {} }, credits: { translation: 't', font: 'f', audio: 'a' },
}) as unknown as KioskContent;
function view(templateId: string, at = '10:15', opts: { logo?: string | null } = {}): void {
  const v = makeView('2026-11-03', at, { settings: { kioskTemplate: { enabled: true, templateId }, themeStyle: { styles: {}, packs } } as never, ...(opts.logo !== undefined ? { logo: opts.logo } : {}) });
  const c = content();
  const rotation = buildRotation(c, v.settings, v.now);
  holder.view = v;
  holder.cv = { content: c, rotation, current: currentSlot(rotation, v.now), zikir: null, override: null };
}
const stage = (r: ReturnType<typeof render>): HTMLElement => r.container.querySelector('.stage') as HTMLElement;
const link = (): HTMLLinkElement | null => document.getElementById(PACK_LINK_ID) as HTMLLinkElement | null;
const posts: Array<{ url: string; body: unknown }> = [];

beforeEach(() => {
  vi.useFakeTimers();
  posts.length = 0;
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') posts.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(null, { status: 204 });
  }));
  holder.metrics = null;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  holder.metrics = null;
  document.getElementById(PACK_LINK_ID)?.remove();
  document.getElementById(PROTECTED_STYLE_ID)?.remove();
});

const sound = (): ElMetrics => ({ ...good, fontRem: 999, heightRem: 999 });
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe('the health check on the stage', () => {
  it('a failing pack falls to the base and reports once', () => {
    view('hijau-siti');
    holder.metrics = (el) => ((el as HTMLElement).getAttribute('data-role') === 'clock' ? { ...sound(), displayed: false } : sound());
    const r = render(<App />);
    act(() => { link()!.dispatchEvent(new Event('load')); });
    expect(stage(r).getAttribute('data-pack')).toBe('ready');
    advance(HEALTH_DELAY_MS - 1);
    expect(stage(r).getAttribute('data-pack')).toBe('ready');
    advance(1);
    expect(stage(r).getAttribute('data-pack')).toBe('ready'); // the first failing look is only noted
    advance(HEALTH_RECHECK_MS);
    expect(stage(r).getAttribute('data-pack')).toBe('failed');
    expect(link()).toBeNull();
    // Q7: the stage says it wears the base theme, not the rejected pack
    expect(stage(r).getAttribute('data-theme')).toBe('creative');
    expect(document.getElementById(PROTECTED_STYLE_ID)).toBeNull();
    expect(posts).toEqual([{ url: '/api/kiosk/theme-health', body: { theme: 'hijau-siti', version: 3, screen: 'biasa', ok: false, failed: ['clock'] } }]);
    // and it stays on the base: no retry of a pack that failed the check
    advance(10 * 60_000);
    expect(link()).toBeNull();
    expect(posts).toHaveLength(1);
  });

  it('a healthy pack reports ok once and stays', () => {
    view('hijau-siti');
    holder.metrics = () => sound();
    const r = render(<App />);
    act(() => { link()!.dispatchEvent(new Event('load')); });
    advance(HEALTH_DELAY_MS);
    expect(stage(r).getAttribute('data-pack')).toBe('ready');
    expect(posts).toEqual([{ url: '/api/kiosk/theme-health', body: { theme: 'hijau-siti', version: 3, screen: 'biasa', ok: true, failed: [] } }]);
    advance(60_000);
    expect(posts).toHaveLength(1);
  });

  it('the check runs again on a screen change', () => {
    view('hijau-siti', '10:15');
    holder.metrics = (el) => (stage2Bad && (el as HTMLElement).getAttribute('data-role') === 'clock' ? { ...sound(), opacity: 0.2 } : sound());
    let stage2Bad = false;
    const r = render(<App />);
    act(() => { link()!.dispatchEvent(new Event('load')); });
    advance(HEALTH_DELAY_MS);
    expect(stage(r).getAttribute('data-pack')).toBe('ready');
    // the next phase (iqamah) arrives with a pack that hides the clock there
    stage2Bad = true;
    view('hijau-siti', '16:25');
    r.rerender(<App />);
    expect(stage(r).getAttribute('data-screen')).toBe('iqamah');
    advance(HEALTH_DELAY_MS + HEALTH_RECHECK_MS);
    expect(stage(r).getAttribute('data-pack')).toBe('failed');
    expect(posts.at(-1)!.body).toEqual({ theme: 'hijau-siti', version: 3, screen: 'iqamah', ok: false, failed: ['clock'] });
  });

  it('a missing logo fails a theme when the surau has set one', () => {
    view('hijau-siti', '10:15', { logo: '/surau-logo?v=1' });
    holder.metrics = (el) => ((el as HTMLElement).getAttribute('data-role') === 'logo' ? { ...sound(), heightRem: 0.1 } : sound());
    const r = render(<App />);
    act(() => { link()!.dispatchEvent(new Event('load')); });
    advance(HEALTH_DELAY_MS + HEALTH_RECHECK_MS);
    expect(stage(r).getAttribute('data-pack')).toBe('failed');
    expect(posts[0]!.body).toMatchObject({ ok: false, failed: ['logo'] });
  });

  it('a built-in theme is never checked and never reports', () => {
    view('creative');
    holder.metrics = () => ({ ...sound(), displayed: false });
    const r = render(<App />);
    advance(10 * HEALTH_DELAY_MS);
    expect(stage(r).hasAttribute('data-pack')).toBe(false);
    expect(posts).toEqual([]);
  });

  it('the protected rules are the last element of head while a pack is attached, and absent for built-ins', () => {
    view('hijau-siti');
    holder.metrics = () => sound();
    const r = render(<App />);
    const prot = document.getElementById(PROTECTED_STYLE_ID)!;
    expect(prot.tagName).toBe('STYLE');
    expect(document.head.lastElementChild).toBe(prot);
    expect(link()!.compareDocumentPosition(prot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(prot.textContent).toContain("[data-role='clock']");
    expect(prot.textContent).toContain('!important');
    expect(prot.textContent).toContain('filter: none !important');
    view('creative');
    r.rerender(<App />);
    expect(document.getElementById(PROTECTED_STYLE_ID)).toBeNull();
    expect(link()).toBeNull();
  });

  it('the check runs again every 60 s while the pack is on the stage, and a failure that appears later falls back and is reported', () => {
    view('hijau-siti');
    holder.metrics = () => sound();
    const r = render(<App />);
    act(() => { link()!.dispatchEvent(new Event('load')); });
    advance(HEALTH_DELAY_MS);
    expect(stage(r).getAttribute('data-pack')).toBe('ready');
    expect(posts).toHaveLength(1); // the first pass reports once
    // the pack starts to cover the clock later on: the next scheduled check sees it
    holder.metrics = (el) => ((el as HTMLElement).getAttribute('data-role') === 'clock' ? { ...sound(), covered: true } : sound());
    advance(HEALTH_INTERVAL_MS + HEALTH_RECHECK_MS);
    expect(stage(r).getAttribute('data-pack')).toBe('failed');
    expect(posts.at(-1)!.body).toEqual({ theme: 'hijau-siti', version: 3, screen: 'biasa', ok: false, failed: ['clock'] });
  });

  it('an animation or a transition that ends starts another check once things are quiet', () => {
    view('hijau-siti');
    holder.metrics = () => sound();
    const r = render(<App />);
    act(() => { link()!.dispatchEvent(new Event('load')); });
    advance(HEALTH_DELAY_MS);
    expect(stage(r).getAttribute('data-pack')).toBe('ready');
    holder.metrics = (el) => ((el as HTMLElement).getAttribute('data-role') === 'prayers' ? { ...sound(), textHidden: true } : sound());
    act(() => { document.body.dispatchEvent(new Event('animationend', { bubbles: true })); });
    advance(MOTION_QUIET_MS - 1);
    expect(stage(r).getAttribute('data-pack')).toBe('ready'); // it waits for quiet
    act(() => { document.body.dispatchEvent(new Event('transitionend', { bubbles: true })); }); // another event: the wait starts again
    advance(MOTION_QUIET_MS - 1);
    expect(stage(r).getAttribute('data-pack')).toBe('ready');
    advance(2 + HEALTH_RECHECK_MS);
    expect(stage(r).getAttribute('data-pack')).toBe('failed');
    expect(posts.at(-1)!.body).toMatchObject({ ok: false, failed: ['prayers'] });
  });

  it('nothing is reported from the preview page', () => {
    window.history.replaceState(null, '', '/?preview=1');
    view('hijau-siti');
    holder.metrics = () => ({ ...sound(), displayed: false });
    render(<App />);
    advance(10 * HEALTH_DELAY_MS);
    expect(posts.filter((p) => p.url === '/api/kiosk/theme-health')).toEqual([]);
    window.history.replaceState(null, '', '/');
  });
});

describe('round 2: a transient fault does not reject, and a rejection does not stick', () => {
  const clockBad = (el: Element) => ((el as HTMLElement).getAttribute('data-role') === 'clock' ? { ...sound(), covered: true } : sound());
  it('Q3: one failing pass does not reject; the same failure 3 s later does, and reports once', () => {
    view('hijau-siti');
    holder.metrics = clockBad;
    const r = render(<App />);
    act(() => { link()!.dispatchEvent(new Event('load')); });
    advance(HEALTH_DELAY_MS);
    expect(stage(r).getAttribute('data-pack')).toBe('ready');
    expect(posts).toEqual([]);
    advance(HEALTH_RECHECK_MS - 1);
    expect(stage(r).getAttribute('data-pack')).toBe('ready');
    advance(1);
    expect(stage(r).getAttribute('data-pack')).toBe('failed');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({ ok: false, failed: ['clock'] });
  });

  it('Q3: a fault that is gone at the second look is forgotten', () => {
    view('hijau-siti');
    holder.metrics = clockBad;
    const r = render(<App />);
    act(() => { link()!.dispatchEvent(new Event('load')); });
    advance(HEALTH_DELAY_MS);
    holder.metrics = () => sound();
    advance(HEALTH_RECHECK_MS + 100);
    expect(stage(r).getAttribute('data-pack')).toBe('ready');
    expect(posts.filter((p) => (p.body as { ok: boolean }).ok === false)).toEqual([]);
    expect(posts.filter((p) => (p.body as { ok: boolean }).ok === true)).toHaveLength(1);
  });

  it('Q3: a failure report that does not get through is posted again with a growing wait', async () => {
    view('hijau-siti');
    holder.metrics = clockBad;
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        calls++;
        if (calls <= 2) throw new Error('offline');
        posts.push({ url, body: JSON.parse(String(init.body)) });
      }
      return new Response(null, { status: 204 });
    }));
    render(<App />);
    act(() => { link()!.dispatchEvent(new Event('load')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(HEALTH_DELAY_MS + HEALTH_RECHECK_MS); });
    expect(calls).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(REPORT_BACKOFF_MS[0]! + 1); });
    expect(calls).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(REPORT_BACKOFF_MS[1]! + 1); });
    expect(calls).toBe(3);
    expect(posts).toHaveLength(1);
  });

  it('Q3: a rejected pack is tried again after 30 minutes, and rejected again if it still fails', () => {
    view('hijau-siti');
    holder.metrics = clockBad;
    const r = render(<App />);
    act(() => { link()!.dispatchEvent(new Event('load')); });
    advance(HEALTH_DELAY_MS + HEALTH_RECHECK_MS);
    expect(stage(r).getAttribute('data-pack')).toBe('failed');
    expect(link()).toBeNull();
    advance(PACK_REJECT_CLEAR_MS - 1000);
    expect(link()).toBeNull();
    advance(1500);
    expect(link()).not.toBeNull(); // back on trial
    act(() => { link()!.dispatchEvent(new Event('load')); });
    advance(HEALTH_DELAY_MS + HEALTH_RECHECK_MS);
    expect(stage(r).getAttribute('data-pack')).toBe('failed');
  });

  it('S9: a change of the stage data attributes starts a new check at once', () => {
    view('hijau-siti');
    holder.metrics = () => sound();
    const r = render(<App />);
    act(() => { link()!.dispatchEvent(new Event('load')); });
    advance(HEALTH_DELAY_MS);
    expect(stage(r).getAttribute('data-pack')).toBe('ready');
    holder.metrics = clockBad;
    act(() => { stage(r).setAttribute('data-dim', 'true'); });
    return Promise.resolve().then(() => {
      advance(400);
      advance(HEALTH_RECHECK_MS + 100);
      expect(stage(r).getAttribute('data-pack')).toBe('failed');
    });
  });
});
