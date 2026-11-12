import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/preact';
import { resolveSettings } from '@surau/core';
import { days } from './helpers.tsx';
import { nowOverrideAllowed } from '../src/data/clock.ts';
import { renderSw } from '../build/sw-plugin.ts';
import {
  PREVIEW_ASSET_ID_RE,
  PREVIEW_TOKEN_RE,
  getPreviewPoster,
  getPreviewToken,
  installPreviewListener,
  isPreview,
  readPreviewPosterMessage,
  resetPreviewForTest,
} from '../src/data/preview.ts';
import { resetSharedStream } from '../src/data/bundle.ts';
import { App } from '../src/app.tsx';

const TOKEN = 'tok_ABC-123';
const ASSET = 'a'.repeat(64);

const bundle = { version: 1, zone: 'SGR01', days, settings: resolveSettings({}), serverTime: new Date().toISOString() };
const content = {
  date: '2026-11-03', kuliah: [], pengumuman: [], ticker: [], posters: [{ id: 'p1', title: 'Poster 1', assetId: ASSET, days: ['umum'], order: 1 }], programKhas: [],
  takwim: [], hadisToday: [], worldTimes: [], tugasan: [], ayat: { today: null, tomorrow: null }, zikir: [],
  tilawah: { slots: [], available: {} }, credits: { translation: 't', font: 'f', audio: 'a' },
};

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

let calls: Call[];
let esCount: number;

function stubNetwork(): void {
  calls = [];
  esCount = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === '/api/kiosk/bundle') return new Response(JSON.stringify(bundle), { status: 200 });
    if (url === '/api/kiosk/content') {
      return new Response(JSON.stringify({ version: 1, serverTime: bundle.serverTime, content }), { status: 200 });
    }
    if (url === `/assets/${ASSET}`) return new Response(new Blob(['x'], { type: 'image/png' }), { status: 200 });
    return new Response('nope', { status: 404 });
  });
  class ES {
    onopen = null;
    onerror = null;
    constructor() {
      esCount += 1;
    }
    addEventListener() {}
    close() {}
  }
  vi.stubGlobal('EventSource', ES);
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:preview-1', revokeObjectURL: () => undefined }));
}

function post(data: unknown, opts: { origin?: string; source?: MessageEventSource | null } = {}): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data,
        origin: opts.origin ?? window.location.origin,
        source: opts.source === undefined ? window : opts.source,
      }),
    );
  });
}

const msg = (token: unknown) => ({ type: 'surau-preview', token });

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/?preview=1&now=2026-11-03T15:52:00%2B08:00');
  stubNetwork();
  installPreviewListener();
});

afterEach(() => {
  cleanup();
  resetPreviewForTest();
  resetSharedStream();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('preview mode: before a message', () => {
  it('makes no network call, opens no EventSource and never begins pairing', async () => {
    render(<App />);
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toEqual([]);
    expect(esCount).toBe(0);
    expect(getPreviewToken()).toBeNull();
  });

  it('ignores a message from another origin', async () => {
    render(<App />);
    post(msg(TOKEN), { origin: 'https://evil.example' });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);
    expect(getPreviewToken()).toBeNull();
  });

  it('ignores a message whose source is not the parent window', async () => {
    render(<App />);
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    post(msg(TOKEN), { source: frame.contentWindow });
    post(msg(TOKEN), { source: null });
    await new Promise((r) => setTimeout(r, 50));
    frame.remove();
    expect(calls).toEqual([]);
    expect(getPreviewToken()).toBeNull();
  });

  it.each([
    ['a token with a space', 'abc def'],
    ['a token with a quote', 'ab"c'],
    ['an empty token', ''],
    ['a token over 200 characters', 'a'.repeat(201)],
    ['a non-string token', 12345],
    ['a missing token', undefined],
  ])('ignores %s', async (_n, token) => {
    render(<App />);
    post(msg(token));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);
    expect(getPreviewToken()).toBeNull();
  });

  it('ignores a message of the wrong type or shape', async () => {
    render(<App />);
    post({ type: 'other', token: TOKEN });
    post(TOKEN);
    post(null);
    post({ token: TOKEN });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);
    expect(getPreviewToken()).toBeNull();
  });

  it('token pattern matches the box bearer pattern', () => {
    expect(PREVIEW_TOKEN_RE.test('aZ09_-')).toBe(true);
    expect(PREVIEW_TOKEN_RE.test('a.b')).toBe(false);
  });
});

describe('preview mode: after a valid message', () => {
  it('fetches bundle and content with a Bearer header, no cookies, no EventSource, no pairing', async () => {
    render(<App />);
    post(msg(TOKEN));
    await waitFor(() => {
      expect(calls.some((c) => c.url === '/api/kiosk/bundle')).toBe(true);
      expect(calls.some((c) => c.url === '/api/kiosk/content')).toBe(true);
    });
    for (const c of calls) {
      expect(headerOf(c.init, 'authorization')).toBe(`Bearer ${TOKEN}`);
      expect(c.init?.credentials).toBe('omit');
    }
    expect(esCount).toBe(0);
    expect(calls.some((c) => c.url.includes('/pair/'))).toBe(false);
  });

  it('loads pictures as blobs with the Bearer header and shows an object URL', async () => {
    render(<App />);
    post(msg(TOKEN));
    await waitFor(() => expect(calls.some((c) => c.url === `/assets/${ASSET}`)).toBe(true));
    const asset = calls.find((c) => c.url === `/assets/${ASSET}`)!;
    expect(headerOf(asset.init, 'authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('touches no storage API', async () => {
    const spies = [
      vi.spyOn(Storage.prototype, 'getItem'),
      vi.spyOn(Storage.prototype, 'setItem'),
      vi.spyOn(Storage.prototype, 'removeItem'),
      vi.spyOn(Storage.prototype, 'clear'),
    ];
    const cookie = vi.spyOn(document, 'cookie', 'set');
    const view = render(<App />);
    post(msg(TOKEN));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/kiosk/content')).toBe(true));
    await new Promise((r) => setTimeout(r, 60));
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(cookie).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    view.unmount();
  });

  it('never writes the token to the URL or the console', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info')];
    render(<App />);
    post(msg(TOKEN));
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(window.location.href).not.toContain(TOKEN);
    for (const l of logs) expect(JSON.stringify(l.mock.calls)).not.toContain(TOKEN);
  });

  it('uses a replacement token for later requests', async () => {
    render(<App />);
    post(msg(TOKEN));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/kiosk/bundle')).toBe(true));
    calls.length = 0;
    post(msg('newtoken_2'));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/kiosk/bundle')).toBe(true));
    const b = calls.find((c) => c.url === '/api/kiosk/bundle')!;
    expect(headerOf(b.init, 'authorization')).toBe('Bearer newtoken_2');
  });

  it('polls the bundle every 30 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App />);
    post(msg(TOKEN));
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/kiosk/bundle').length).toBe(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_000);
    });
    expect(calls.filter((c) => c.url === '/api/kiosk/bundle').length).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(calls.filter((c) => c.url === '/api/kiosk/bundle').length).toBe(2);
  });
});

describe('preview ribbon and clock', () => {
  it('shows the PRATONTON ribbon in preview mode only', () => {
    const a = render(<App />);
    expect(a.getByTestId('preview-ribbon').textContent).toBe('PRATONTON');
    a.unmount();
    window.history.replaceState(null, '', '/');
    const b = render(<App />);
    expect(b.queryByTestId('preview-ribbon')).toBeNull();
  });

  it('isPreview needs preview=1 exactly', () => {
    expect(isPreview('?preview=1')).toBe(true);
    expect(isPreview('?preview=0')).toBe(false);
    expect(isPreview('?preview=true')).toBe(false);
    expect(isPreview('')).toBe(false);
  });

  it('?now= is honoured in a production build only with preview=1 or proof=1', () => {
    const prod = { DEV: false, MODE: 'production' };
    expect(nowOverrideAllowed('?now=2026-11-03T15:52:00%2B08:00', prod)).toBe(false);
    expect(nowOverrideAllowed('?preview=1&now=2026-11-03T15:52:00%2B08:00', prod)).toBe(true);
    expect(nowOverrideAllowed('?proof=1&now=2026-11-03T15:52:00%2B08:00', prod)).toBe(true);
    expect(nowOverrideAllowed('?preview=0&now=2026-11-03T15:52:00%2B08:00', prod)).toBe(false);
  });
});

describe('service worker', () => {
  it('lets requests that carry an Authorization header go straight to the network', () => {
    const src = renderSw(['/index.html']);
    expect(src).toMatch(/headers\.has\('authorization'\)/);
    // the check comes before any cache handling in the fetch handler
    expect(src.indexOf("headers.has('authorization')")).toBeLessThan(src.indexOf('mediaFirst(request)', src.indexOf("addEventListener('fetch'")));
  });
});

describe('preview pictures', () => {
  it('assetSrc gives the blob URL in preview and the plain path otherwise', async () => {
    const { assetSrc } = await import('../src/content/assets.ts');
    const { preparePreviewAssets, kioskFetch } = await import('../src/data/preview.ts');
    expect(assetSrc(ASSET)).toBeNull(); // preview, nothing fetched yet
    post(msg(TOKEN));
    await preparePreviewAssets([ASSET], kioskFetch);
    expect(assetSrc(ASSET)).toBe('blob:preview-1');
    expect(assetSrc('../etc/passwd')).toBeNull();
    window.history.replaceState(null, '', '/');
    expect(assetSrc(ASSET)).toBe(`/assets/${ASSET}`);
  });
});

// Plan 4: "Pratonton di TV" from the poster editor. The host posts a second message naming one poster
// (a box asset id and its title); the preview shows that poster alone, full screen, as the TV would.
describe('preview poster message', () => {
  const DRAFT = 'b'.repeat(64);
  const posterMsg = (assetId: unknown, title: unknown = 'Kempen Derma') => ({ type: 'surau-preview-poster', assetId, title });

  function stubDraftAsset(): void {
    const prev = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `/assets/${DRAFT}`) {
        calls.push({ url: String(input), init });
        return new Response(new Blob(['y'], { type: 'image/png' }), { status: 200 });
      }
      return prev(input, init);
    });
  }

  it('after the token: fetches the poster with the Bearer header and shows it alone, full screen, with the strip', async () => {
    stubDraftAsset();
    const r = render(<App />);
    post(msg(TOKEN));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/kiosk/content')).toBe(true));
    post(posterMsg(DRAFT, 'Kempen Derma Surau'));
    await waitFor(() => expect(calls.some((c) => c.url === `/assets/${DRAFT}`)).toBe(true));
    const asset = calls.find((c) => c.url === `/assets/${DRAFT}`)!;
    expect(headerOf(asset.init, 'authorization')).toBe(`Bearer ${TOKEN}`);
    // The rotation's own poster (p1) gives way to the host's one.
    await waitFor(() => expect(r.container.querySelector('[data-card="posters"][data-item="preview-poster"]')).toBeTruthy());
    const card = r.container.querySelector('[data-card="posters"][data-item="preview-poster"]')!;
    expect(card.querySelector('img.poster__img')!.getAttribute('src')).toBe('blob:preview-1');
    // Once the cross-fade is over the host's poster is the only card.
    await waitFor(() => expect(r.container.querySelectorAll('[data-card]').length).toBe(1));
    expect(r.container.querySelector('.screen--main.is-poster')).toBeTruthy();
    expect(r.container.querySelector('[data-testid="poster-strip"]')).toBeTruthy();
    expect(r.container.querySelector('[data-testid="preview-ribbon"]')!.textContent).toBe('PRATONTON');
    // The title is for the admin app: it never appears on the kiosk page.
    expect(r.container.textContent).not.toContain('Kempen Derma');
    expect(getPreviewPoster()).toEqual({ assetId: DRAFT, title: 'Kempen Derma Surau' });
  });

  it('is ignored before a token has arrived', async () => {
    render(<App />);
    post(posterMsg(DRAFT));
    await new Promise((res) => setTimeout(res, 50));
    expect(getPreviewPoster()).toBeNull();
    expect(calls).toEqual([]);
  });

  it('is ignored from another origin or a window that is not the host', async () => {
    render(<App />);
    post(msg(TOKEN));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/kiosk/bundle')).toBe(true));
    post(posterMsg(DRAFT), { origin: 'https://evil.example' });
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    post(posterMsg(DRAFT), { source: frame.contentWindow });
    post(posterMsg(DRAFT), { source: null });
    await new Promise((res) => setTimeout(res, 50));
    frame.remove();
    expect(getPreviewPoster()).toBeNull();
    expect(calls.some((c) => c.url === `/assets/${DRAFT}`)).toBe(false);
  });

  it.each([
    ['an asset id that is a URL', 'https://evil.example/x.png'],
    ['a relative path', '../../etc/passwd'],
    ['a short hex id', 'abc'],
    ['an upper-case hex id', 'B'.repeat(64)],
    ['a 65-character id', 'b'.repeat(65)],
    ['a non-string id', 12345],
    ['a missing id', undefined],
  ])('refuses %s', async (_n, assetId) => {
    render(<App />);
    post(msg(TOKEN));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/kiosk/bundle')).toBe(true));
    post(posterMsg(assetId));
    await new Promise((res) => setTimeout(res, 50));
    expect(getPreviewPoster()).toBeNull();
  });

  it('refuses a non-string title and trims, caps and strips control characters from a string one', async () => {
    render(<App />);
    post(msg(TOKEN));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/kiosk/bundle')).toBe(true));
    post(posterMsg(DRAFT, { html: '<b>x</b>' }));
    post(posterMsg(DRAFT, 42));
    await new Promise((res) => setTimeout(res, 20));
    expect(getPreviewPoster()).toBeNull();
    post(posterMsg(DRAFT, `  Tajuk\u0000\n${'x'.repeat(200)}  `));
    await new Promise((res) => setTimeout(res, 20));
    const p = getPreviewPoster()!;
    expect(p.assetId).toBe(DRAFT);
    expect(p.title.length).toBe(80);
    expect(p.title.startsWith('Tajuk  ')).toBe(true);
    expect(p.title).not.toMatch(/[\u0000-\u001f]/);
  });

  it('readPreviewPosterMessage is pure and strict about the shape', () => {
    const ev = (data: unknown) => new MessageEvent('message', { data, origin: window.location.origin, source: window });
    expect(readPreviewPosterMessage(ev(posterMsg(DRAFT, 'T')))).toEqual({ assetId: DRAFT, title: 'T' });
    expect(readPreviewPosterMessage(ev({ type: 'surau-preview', token: TOKEN }))).toBeNull();
    expect(readPreviewPosterMessage(ev(posterMsg(DRAFT, '')))).toEqual({ assetId: DRAFT, title: '' });
    expect(readPreviewPosterMessage(ev(null))).toBeNull();
    expect(readPreviewPosterMessage(ev('surau-preview-poster'))).toBeNull();
    expect(PREVIEW_ASSET_ID_RE.test(DRAFT)).toBe(true);
    expect(PREVIEW_ASSET_ID_RE.test('/assets/' + DRAFT)).toBe(false);
  });

  it('outside preview the poster message does nothing', async () => {
    window.history.replaceState(null, '', '/?now=2026-11-03T15:52:00%2B08:00');
    render(<App />);
    post(msg(TOKEN));
    post(posterMsg(DRAFT));
    await new Promise((res) => setTimeout(res, 50));
    expect(getPreviewPoster()).toBeNull();
    expect(calls.some((c) => c.url === `/assets/${DRAFT}`)).toBe(false);
  });
});
