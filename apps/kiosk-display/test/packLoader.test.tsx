import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/preact';
import { buildRotation, currentSlot } from '@surau/core';
import type { KioskContent } from '@surau/core';
import { makeView } from './helpers.tsx';
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
import { resetPreviewForTest } from '../src/data/preview.ts';
import { PACK_LINK_ID, PACK_RETRY_MS, inlinePackCss, usePackCss } from '../src/themes/packLoader.ts';
import { builtInTheme, packTheme } from '../src/themes/index.ts';
import type { ResolvedTheme } from '../src/themes/index.ts';

const base = { updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'test' };
const MENU_PIC = 'b'.repeat(64);
const content = (): KioskContent => ({
  date: '2026-11-03',
  kuliah: [{ ...base, id: 'k1', date: '2026-11-03', slot: 'maghrib', time: '19:15', label: 'Kuliah Maghrib', penceramahId: 'p1', status: 'aktif', penceramah: { name: 'Ustaz Abu Bakar Ahmad' } }],
  pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [], hadisToday: [], worldTimes: [], tugasan: [],
  ayat: { today: null, tomorrow: null }, zikir: [], tilawah: { slots: [], available: {} }, credits: { translation: 't', font: 'f', audio: 'a' },
}) as unknown as KioskContent;

const packs = (over: Record<string, unknown> = {}) => ({
  'hijau-siti': { assetId: 'a'.repeat(64), version: 3, title: 'Hijau Siti', base: 'creative', contract: 1, bytes: 1, fonts: [], screens: [], images: { kuliah: 'jpg' }, defaults: { semua: { accent: '#0a8f4e' } }, ...over },
});
function view(templateId: string, p: Record<string, unknown> = packs(), styles: Record<string, unknown> = {}, at = '15:52', override: 'kuliahCard' | null = null): void {
  const v = makeView('2026-11-03', at, { settings: { kioskTemplate: { enabled: true, templateId }, themeStyle: { styles, packs: p } } as never });
  const c = override === null ? { ...content(), kuliah: [] } as KioskContent : content();
  const rotation = buildRotation(c, v.settings, v.now);
  holder.view = v;
  holder.cv = { content: c, rotation, current: currentSlot(rotation, v.now), zikir: null, override };
}
const stage = (r: ReturnType<typeof render>): HTMLElement => r.container.querySelector('.stage') as HTMLElement;
const link = (): HTMLLinkElement | null => document.getElementById(PACK_LINK_ID) as HTMLLinkElement | null;

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetPreviewForTest();
  document.getElementById(PACK_LINK_ID)?.remove();
  window.history.replaceState(null, '', '/');
});

describe('an installed pack on the stage', () => {
  it('while the pack loads the stage is the base theme, with no pack defaults', () => {
    view('hijau-siti');
    const r = render(<App />);
    expect(stage(r).getAttribute('data-template')).toBe('creative');
    expect(stage(r).getAttribute('data-theme')).toBe('hijau-siti');
    expect(stage(r).getAttribute('data-pack')).toBe('loading');
    expect(stage(r).style.getPropertyValue('--accent')).toBe('');
    expect(link()?.getAttribute('href')).toBe('/themes/hijau-siti/aaaaaaaaaaaaaaaa-2/bundle.css');
    expect(link()?.getAttribute('rel')).toBe('stylesheet');
    // the pack link comes after the bundled CSS in head
    expect(link()!.nextElementSibling?.id).toBe('mx-protected');
    expect(document.head.lastElementChild?.id).toBe('mx-protected');
  });

  it('the surau values for the pack are not applied while it loads; the base values are', () => {
    view('hijau-siti', packs(), { 'hijau-siti': { semua: { accent: '#ff0000' }, skrin: {} }, creative: { semua: { shade: 60 }, skrin: {} } });
    const r = render(<App />);
    expect(stage(r).style.getPropertyValue('--accent')).toBe('');
    act(() => { link()!.dispatchEvent(new Event('load')); });
    expect(stage(r).getAttribute('data-pack')).toBe('ready');
    expect(stage(r).style.getPropertyValue('--accent')).toBe('#ff0000');
  });

  it('once loaded the pack defaults apply', () => {
    view('hijau-siti');
    const r = render(<App />);
    act(() => { link()!.dispatchEvent(new Event('load')); });
    expect(stage(r).getAttribute('data-pack')).toBe('ready');
    expect(stage(r).style.getPropertyValue('--accent')).toBe('#0a8f4e');
    expect(stage(r).style.getPropertyValue('--accent-rgb')).toBe('10 143 78');
  });

  it('a load error leaves the base and removes the link', () => {
    view('hijau-siti');
    const r = render(<App />);
    act(() => { link()!.dispatchEvent(new Event('error')); });
    expect(stage(r).getAttribute('data-pack')).toBe('failed');
    expect(stage(r).style.getPropertyValue('--accent')).toBe('');
    expect(link()).toBeNull();
  });

  it('a new version swaps the link; switching to a built-in removes it and the data-pack attribute', () => {
    view('hijau-siti');
    const r = render(<App />);
    act(() => { link()!.dispatchEvent(new Event('load')); });
    view('hijau-siti', packs({ version: 4, assetId: 'b'.repeat(64) }));
    r.rerender(<App />);
    expect(link()?.getAttribute('href')).toBe('/themes/hijau-siti/bbbbbbbbbbbbbbbb-2/bundle.css');
    expect(stage(r).getAttribute('data-pack')).toBe('loading');
    expect(document.querySelectorAll(`#${PACK_LINK_ID}`)).toHaveLength(1);
    view('creative');
    r.rerender(<App />);
    expect(link()).toBeNull();
    expect(stage(r).hasAttribute('data-pack')).toBe(false);
    expect(stage(r).getAttribute('data-theme')).toBe('creative');
  });

  it('a built-in theme never has a pack link', () => {
    view('minimal');
    const r = render(<App />);
    expect(link()).toBeNull();
    expect(stage(r).hasAttribute('data-pack')).toBe(false);
  });

  it('a record for a newer contract is the default theme', () => {
    view('hijau-siti', packs({ contract: 2 }));
    const r = render(<App />);
    expect(stage(r).getAttribute('data-theme')).toBe('default');
    expect(link()).toBeNull();
  });

  it('the pack picture of the screen is used only when the surau set none, and only once the pack is ready', () => {
    view('hijau-siti', packs(), {}, '15:52', 'kuliahCard');
    const r = render(<App />);
    expect(stage(r).getAttribute('data-screen')).toBe('kuliah');
    expect(stage(r).style.getPropertyValue('--bg-image')).toBe('');
    act(() => { link()!.dispatchEvent(new Event('load')); });
    expect(stage(r).style.getPropertyValue('--bg-image')).toBe('url("/themes/hijau-siti/aaaaaaaaaaaaaaaa-2/images/kuliah.jpg")');
    expect(stage(r).getAttribute('data-bg')).toBe('image');
    // another screen has no picture of its own: the all-screens picture, else none
    cleanup();
    view('hijau-siti', packs(), {}, '10:15', null);
    const r2 = render(<App />);
    act(() => { link()!.dispatchEvent(new Event('load')); });
    expect(stage(r2).getAttribute('data-screen')).toBe('biasa');
    expect(stage(r2).style.getPropertyValue('--bg-image')).toBe('');
    cleanup();
    view('hijau-siti', packs({ images: { semua: 'png' } }), {}, '10:15', null);
    const r3 = render(<App />);
    act(() => { link()!.dispatchEvent(new Event('load')); });
    expect(stage(r3).style.getPropertyValue('--bg-image')).toBe('url("/themes/hijau-siti/aaaaaaaaaaaaaaaa-2/images/semua.png")');
    // the surau's own menu picture comes first
    cleanup();
    view('hijau-siti', packs({ images: { semua: 'png' } }), { 'hijau-siti': { semua: { bgImage: MENU_PIC }, skrin: {} } }, '10:15', null);
    const r4 = render(<App />);
    act(() => { link()!.dispatchEvent(new Event('load')); });
    expect(stage(r4).style.getPropertyValue('--bg-image')).toBe(`url("/assets/${MENU_PIC}")`);
  });
});

describe('usePackCss', () => {
  const theme: ResolvedTheme = packTheme('hijau-siti', packs()['hijau-siti'] as never, '/themes/hijau-siti/aaaaaaaaaaaaaaaa-2/bundle.css');
  function Probe(p: { theme: ResolvedTheme; onReject?: (fn: (r: string) => void) => void }) {
    const { state, reject } = usePackCss(p.theme);
    p.onReject?.(reject);
    return <i data-state={state} />;
  }
  const state = (r: ReturnType<typeof render>): string => (r.container.querySelector('i') as HTMLElement).getAttribute('data-state')!;

  it('a failed load is tried again after 60 seconds', () => {
    vi.useFakeTimers();
    const r = render(<Probe theme={theme} />);
    expect(state(r)).toBe('loading');
    act(() => { link()!.dispatchEvent(new Event('error')); });
    expect(state(r)).toBe('failed');
    expect(link()).toBeNull();
    act(() => { vi.advanceTimersByTime(PACK_RETRY_MS - 1); });
    expect(link()).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(link()?.getAttribute('href')).toBe('/themes/hijau-siti/aaaaaaaaaaaaaaaa-2/bundle.css');
    act(() => { link()!.dispatchEvent(new Event('load')); });
    expect(state(r)).toBe('ready');
  });

  it('reject() removes the pack and keeps it removed (no retry) until the version changes', () => {
    vi.useFakeTimers();
    let reject: (r: string) => void = () => undefined;
    const r = render(<Probe theme={theme} onReject={(f) => { reject = f; }} />);
    act(() => { link()!.dispatchEvent(new Event('load')); });
    expect(state(r)).toBe('ready');
    act(() => { reject('health'); });
    expect(state(r)).toBe('failed');
    expect(link()).toBeNull();
    act(() => { vi.advanceTimersByTime(10 * PACK_RETRY_MS); });
    expect(link()).toBeNull();
    expect(state(r)).toBe('failed');
    r.rerender(<Probe theme={packTheme('hijau-siti', packs({ version: 4, assetId: 'b'.repeat(64) })['hijau-siti'] as never, '/themes/hijau-siti/bbbbbbbbbbbbbbbb/bundle.css')} />);
    expect(state(r)).toBe('loading');
    expect(link()?.getAttribute('href')).toBe('/themes/hijau-siti/bbbbbbbbbbbbbbbb/bundle.css');
  });

  it('a built-in theme is none and adds nothing to head', () => {
    const r = render(<Probe theme={builtInTheme('creative')} />);
    expect(state(r)).toBe('none');
    expect(link()).toBeNull();
  });

  it('in preview the stylesheet is fetched with the Bearer header and its addresses inlined', async () => {
    window.history.replaceState(null, '', '/?preview=1');
    const css = 'a{background:url("/themes/hijau-siti/aaaaaaaaaaaaaaaa-2/images/kuliah.jpg")} b{background:url("/themes/hijau-siti/aaaaaaaaaaaaaaaa-2/fonts/f.woff2")}';
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.endsWith('bundle.css')) return new Response(css, { status: 200 });
      return new Response(new Blob(['x']), { status: 200 });
    }) as unknown as typeof fetch;
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:pack-1', revokeObjectURL: () => undefined }));
    function P() {
      const { state } = usePackCss(theme, { fetchImpl: fakeFetch });
      return <i data-state={state} />;
    }
    const r = render(<P />);
    await waitFor(() => expect(r.container.querySelector('i')!.getAttribute('data-state')).toBe('ready'));
    const el = document.getElementById(PACK_LINK_ID)!;
    expect(el.tagName).toBe('STYLE');
    expect(el.textContent).toContain('url("blob:pack-1")');
    // a font address is not one of the pack's (no fonts in a pack): it is never fetched, and left out
    expect(fakeFetch).not.toHaveBeenCalledWith(expect.stringContaining('.woff2'));
    expect(el.textContent).not.toContain('woff2');
    expect(el.textContent).not.toContain('/themes/');
  });
});

describe('inlinePackCss', () => {
  it('replaces pack pictures by blob: URLs, and never fetches a font address', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:abc', revokeObjectURL: () => undefined }));
    const seen: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL) => { seen.push(String(input)); return new Response(new Blob(['i']), { status: 200 }); }) as typeof fetch;
    const css = await inlinePackCss('a{background:url("/themes/x/0123456789abcdef-2/images/kuliah.jpg")} b{background:url("/themes/x/0123456789abcdef-2/fonts/f.woff2")} c{background:url("/themes/x/0123456789abcdef-2/images/w.webp")}', fakeFetch);
    expect(css).toMatch(/url\("blob:[^"]+"\)/);
    expect(seen).toEqual(['/themes/x/0123456789abcdef-2/images/kuliah.jpg']);
    expect(css).not.toContain('/themes/');
  });

  it('an address that cannot be fetched is left out, and an address that is not the pack\'s is never fetched', async () => {
    const calls: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL) => { calls.push(String(input)); return new Response('no', { status: 404 }); }) as typeof fetch;
    const css = await inlinePackCss('a{background:url("/themes/x/0123456789abcdef-2/images/gone.jpg")} b{background:url(https://evil.example/a.png)} c{background:url(/api/health)}', fakeFetch);
    expect(calls).toEqual(['/themes/x/0123456789abcdef-2/images/gone.jpg']);
    expect(css).not.toContain('/themes/');
    expect(css).toContain('url(https://evil.example/a.png)'.replace('url(https://evil.example/a.png)', 'none'));
    expect(css).not.toContain('evil.example');
    expect(css).not.toContain('/api/health');
  });
});
