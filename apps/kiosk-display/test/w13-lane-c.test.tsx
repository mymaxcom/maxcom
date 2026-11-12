import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, render } from '@testing-library/preact';
import type { KioskContent } from '@surau/core';
import { contentForDate, readCachedContent, useContent } from '../src/data/content.ts';
import type { ContentView } from '../src/data/content.ts';
import { loadBundle } from '../src/data/bundle.ts';
import { MEDIA_CACHE } from '../src/data/media.ts';
import { makeView } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';

const ayat = (n: number) => ({ surah: n, ayatFrom: 1, ayatTo: 1, surahNameMs: 's', arabic: ['a'], malay: ['m'] }) as never;
const hadis = { id: 'h1', textMs: 'x', attribution: 's' } as never;
const base = (date: string): KioskContent => ({
  date, kuliah: [], pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [],
  hadisToday: [hadis], worldTimes: [], tugasan: [], ayat: { today: ayat(1), tomorrow: ayat(2) }, zikir: [],
  tilawah: { slots: [], available: {} }, credits: { translation: 't', font: 'f', audio: 'a' },
});

describe('contentForDate (Q3)', () => {
  it('same day keeps today ayat and hadis', () => {
    const c = contentForDate(base('2026-11-03'), '2026-11-03');
    expect(c.ayat.today).toEqual(ayat(1));
    expect(c.hadisToday).toHaveLength(1);
  });
  it('exactly one day ahead uses ayat.tomorrow and drops the hadis', () => {
    const c = contentForDate(base('2026-11-03'), '2026-11-04');
    expect(c.ayat.today).toEqual(ayat(2));
    expect(c.hadisToday).toEqual([]);
  });
  it('further ahead (incl. month and year ends) has no ayat card and no hadis', () => {
    expect(contentForDate(base('2026-11-03'), '2026-11-05').ayat.today).toBeNull();
    expect(contentForDate(base('2026-11-03'), '2026-11-05').hadisToday).toEqual([]);
    expect(contentForDate(base('2026-12-31'), '2027-01-01').ayat.today).toEqual(ayat(2));
    expect(contentForDate(base('2026-02-28'), '2026-03-02').ayat.today).toBeNull();
  });
});

function Probe(p: { view: KioskView; out: { c: ContentView | null } }) {
  p.out.c = useContent(p.view);
  return null;
}

describe('useContent', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('seeds synchronously from the cache (Q11), before any network answer', () => {
    localStorage.setItem('surau.content', JSON.stringify({ content: base('2026-11-03'), fetchedAt: 1 }));
    vi.stubGlobal('fetch', () => new Promise(() => undefined)); // network never answers
    expect(readCachedContent()?.source).toBe('cache');
    const out = { c: null as ContentView | null };
    render(h(Probe, { view: makeView('2026-11-03', '15:52'), out }));
    expect(out.c!.content?.date).toBe('2026-11-03');
  });

  it('switches ayat/hadis at the KL midnight and reloads the content once (Q3)', async () => {
    localStorage.setItem('surau.content', JSON.stringify({ content: base('2026-11-03'), fetchedAt: 1 }));
    const fetchMock = vi.fn(() => Promise.reject(new Error('offline')));
    vi.stubGlobal('fetch', fetchMock);
    const out = { c: null as ContentView | null };
    const { rerender } = render(h(Probe, { view: makeView('2026-11-03', '23:59:59'), out }));
    expect(out.c!.content?.ayat.today).toEqual(ayat(1));
    expect(out.c!.content?.hadisToday).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 30)); // the first load settles
    const before = fetchMock.mock.calls.length;
    rerender(h(Probe, { view: makeView('2026-11-04', '00:00:01'), out }));
    expect(out.c!.content?.ayat.today).toEqual(ayat(2));
    expect(out.c!.content?.hadisToday).toEqual([]);
    expect(fetchMock.mock.calls.length).toBe(before + 1);
  });
});

describe('S10 kiosk part', () => {
  it('a 401 on the bundle clears the picture cache', async () => {
    const del = vi.fn(() => Promise.resolve(true));
    vi.stubGlobal('caches', { delete: del });
    const f = (async () => new Response('no', { status: 401 })) as unknown as typeof fetch;
    await expect(loadBundle(f, undefined)).rejects.toThrow();
    expect(del).toHaveBeenCalledWith(MEDIA_CACHE);
    vi.unstubAllGlobals();
  });
});
