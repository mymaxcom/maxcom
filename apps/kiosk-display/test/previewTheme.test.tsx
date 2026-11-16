import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/preact';
import { resolveSettings } from '@surau/core';
import { days } from './helpers.tsx';
import {
  installPreviewListener,
  readPreviewThemeMessage,
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

function stubNetwork(): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/kiosk/bundle') return new Response(JSON.stringify(bundle), { status: 200 });
    if (url === '/api/kiosk/content') return new Response(JSON.stringify({ version: 1, serverTime: bundle.serverTime, content }), { status: 200 });
    if (url === `/assets/${ASSET}`) return new Response(new Blob(['x'], { type: 'image/png' }), { status: 200 });
    return new Response('nope', { status: 404 });
  });
  class ES { onopen = null; onerror = null; addEventListener() {} close() {} }
  vi.stubGlobal('EventSource', ES);
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:preview-1', revokeObjectURL: () => undefined }));
}

function post(data: unknown, opts: { origin?: string; source?: MessageEventSource | null } = {}): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      data, origin: opts.origin ?? window.location.origin, source: opts.source === undefined ? window : opts.source,
    }));
  });
}
const tokenMsg = { type: 'surau-preview', token: TOKEN };
const themeMsg = (over: Record<string, unknown> = {}) => ({ type: 'surau-preview-theme', theme: 'creative', screen: 'kuliah', entry: {}, ...over });
const msgEvent = (data: unknown, origin = window.location.origin) => new MessageEvent('message', { data, origin, source: window });
const stage = (r: ReturnType<typeof render>) => r.container.querySelector('.stage') as HTMLElement;

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/?preview=1&now=2026-11-03T10:30:00%2B08:00');
  stubNetwork();
  installPreviewListener();
});
afterEach(() => {
  cleanup();
  resetPreviewForTest();
  resetSharedStream();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('theme message: reading', () => {
  it('reads a valid theme message only from the verified host', () => {
    const ok = msgEvent(themeMsg({ entry: { semua: { shade: 20, zz: 1 }, skrin: {} } }));
    expect(readPreviewThemeMessage(ok)).toEqual({ theme: 'creative', screen: 'kuliah', entry: { semua: { shade: 20 }, skrin: {} }, staged: null, pack: null });
    expect(readPreviewThemeMessage(msgEvent(themeMsg({ theme: 'Bad' })))).toBeNull();
    expect(readPreviewThemeMessage(msgEvent(themeMsg({ screen: 'setup' })))).toBeNull();
    expect(readPreviewThemeMessage(msgEvent(themeMsg(), 'https://evil.example'))).toBeNull();
    expect(readPreviewThemeMessage(msgEvent(themeMsg({ entry: [] })))).toBeNull();
    expect(readPreviewThemeMessage(msgEvent(themeMsg({ staged: 'zz' })))).toBeNull();
    expect(readPreviewThemeMessage(msgEvent(themeMsg({ staged: 'a'.repeat(32) })))?.staged).toBe('a'.repeat(32));
    const big = { semua: {}, skrin: {}, pad: 'x'.repeat(40_000) };
    expect(readPreviewThemeMessage(msgEvent(themeMsg({ entry: big })))).toBeNull();
  });
});

describe('theme message: the stage', () => {
  it('is ignored before the token and outside preview', async () => {
    const r = render(<App />);
    post(themeMsg({ theme: 'minimal', entry: { semua: { accent: '#5aa7ff' }, skrin: {} } }));
    await new Promise((x) => setTimeout(x, 60));
    expect(r.container.querySelector('.stage')?.getAttribute('data-theme') ?? 'none').not.toBe('minimal');
    cleanup();
    window.history.replaceState(null, '', '/');
    const r2 = render(<App />);
    post(tokenMsg);
    post(themeMsg({ theme: 'minimal' }));
    await new Promise((x) => setTimeout(x, 60));
    expect(r2.container.querySelector('.stage')?.getAttribute('data-theme') ?? 'none').not.toBe('minimal');
  });

  it('the stage follows the message: theme, screen, unsaved style', async () => {
    const r = render(<App />);
    post(tokenMsg);
    await waitFor(() => expect(stage(r)).toBeTruthy());
    post(themeMsg({ theme: 'minimal', screen: 'poster', entry: { semua: { accent: '#5aa7ff' }, skrin: {} } }));
    await waitFor(() => expect(stage(r).getAttribute('data-theme')).toBe('minimal'));
    await waitFor(() => expect(stage(r).getAttribute('data-screen')).toBe('poster'));
    expect(stage(r).getAttribute('data-template')).toBe('minimal');
    expect(stage(r).style.getPropertyValue('--accent')).toBe('#5aa7ff');
    await waitFor(() => expect(r.container.querySelector('[data-card="posters"]')).toBeTruthy());
  });

  it('no content for the screen: the notice, the screen id and the style stay', async () => {
    const r = render(<App />);
    post(tokenMsg);
    await waitFor(() => expect(stage(r)).toBeTruthy());
    post(themeMsg({ screen: 'hadis', entry: { semua: { scale: 'XL' }, skrin: {} } }));
    await waitFor(() => expect(r.getByTestId('preview-nocontent').textContent).toBe('Tiada kandungan untuk skrin ini lagi'));
    expect(stage(r).getAttribute('data-screen')).toBe('hadis');
    expect(stage(r).style.getPropertyValue('--scale')).toBe('1.3');
    expect(r.container.querySelector('.region-main')).toBeTruthy();
  });

  it('screen live shows the live screen without a player', async () => {
    const r = render(<App />);
    post(tokenMsg);
    await waitFor(() => expect(stage(r)).toBeTruthy());
    post(themeMsg({ screen: 'live' }));
    await waitFor(() => expect(r.getByTestId('live-waiting')).toBeTruthy());
    expect(stage(r).getAttribute('data-screen')).toBe('live');
    expect(r.container.querySelector('video')).toBeNull();
  });
});
