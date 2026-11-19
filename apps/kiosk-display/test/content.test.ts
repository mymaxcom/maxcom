import { describe, expect, it } from 'vitest';
import { assetIdsOf, loadContent, parseCardOverride, shouldReplaceContent } from '../src/data/content.ts';

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, v); },
  };
}

const content = {
  date: '2026-11-03', kuliah: [], pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [],
  hadisToday: [], worldTimes: [], tugasan: [], ayat: { today: null, tomorrow: null }, zikir: [],
  tilawah: { slots: [], available: {} }, credits: { translation: 't', font: 'f', audio: 'a' },
};
const okFetch = (async () => new Response(JSON.stringify({ version: 1, serverTime: "2026-11-03T07:52:00.000Z", content }), { status: 200 })) as unknown as typeof fetch;
const failFetch = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
const badFetch = (async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 })) as unknown as typeof fetch;

describe('loadContent', () => {
  it('fetches and caches under surau.content', async () => {
    const s = fakeStorage();
    const r = await loadContent(okFetch, s);
    expect(r.source).toBe('network');
    expect(r.content.date).toBe('2026-11-03');
    expect(JSON.parse(s.getItem('surau.content')!).content.date).toBe('2026-11-03');
  });
  it('falls back to the cached copy when fetch rejects', async () => {
    const s = fakeStorage();
    const first = await loadContent(okFetch, s);
    const r = await loadContent(failFetch, s);
    expect(r.source).toBe('cache');
    expect(r.fetchedAt).toBe(first.fetchedAt);
  });
  it('falls back to cache on a malformed body and on HTTP errors', async () => {
    const s = fakeStorage();
    await loadContent(okFetch, s);
    expect((await loadContent(badFetch, s)).source).toBe('cache');
    const f500 = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    expect((await loadContent(f500, s)).source).toBe('cache');
  });
  it('throws no content when neither exists', async () => {
    await expect(loadContent(failFetch, fakeStorage())).rejects.toThrow(/no content/);
    await expect(loadContent(badFetch, fakeStorage())).rejects.toThrow(/no content/);
  });
  it('ignores a corrupt cache entry', async () => {
    const s = fakeStorage();
    s.setItem('surau.content', '{not json');
    await expect(loadContent(failFetch, s)).rejects.toThrow(/no content/);
  });
});

describe('parseCardOverride', () => {
  it('accepts known features only', () => {
    expect(parseCardOverride('?card=hadis')).toBe('hadis');
    expect(parseCardOverride('?card=kuliahCard')).toBe('kuliahCard');
    expect(parseCardOverride('?card=bogus')).toBeNull();
    expect(parseCardOverride('')).toBeNull();
  });
});

describe('shouldReplaceContent', () => {
  const mk = (source: 'network' | 'cache') => ({ content: content as never, source, fetchedAt: 1 });
  it('network wins; cache never replaces network', () => {
    expect(shouldReplaceContent(null, mk('cache'))).toBe(true);
    expect(shouldReplaceContent(mk('cache'), mk('network'))).toBe(true);
    expect(shouldReplaceContent(mk('network'), mk('cache'))).toBe(false);
    expect(shouldReplaceContent(mk('cache'), mk('cache'))).toBe(true);
  });
});

describe('useContent rotation rebuild', () => {
  it('drops a programKhas within a minute of its hide time without a reload', async () => {
    const { renderHook, waitFor } = await import('@testing-library/preact');
    const { useContent } = await import('../src/data/content.ts');
    const { makeView } = await import('./helpers.tsx');
    const seeded = {
      ...content,
      programKhas: [{
        id: 'pk', updatedAt: '2026-11-01T00:00:00Z', updatedBy: 't', title: 'Ceramah', at: '2026-11-03T15:00',
        showFrom: '2026-11-01', showTo: '2026-11-03', status: 'aktif',
      }],
    };
    // No box in tests: the hook takes the cache path (same format loadContent writes).
    localStorage.setItem('surau.content', JSON.stringify({ content: seeded, fetchedAt: Date.now() }));
    try {
      const { klInstant } = await import('@surau/core');
      const v1 = makeView('2026-11-03', '15:04:30', { settings: { programKhas: { hideAfterMinutes: 5 } } });
      // Same settings object and KL date as the live kiosk: only the clock moves.
      const v2 = { ...v1, now: klInstant('2026-11-03', '15:05:10') };
      const hook = renderHook((v) => useContent(v), { initialProps: v1 });
      await waitFor(() => expect(hook.result.current.content).not.toBeNull());
      expect(hook.result.current.rotation.some((s) => s.feature === 'programKhas')).toBe(true);
      hook.rerender(v2);
      expect(hook.result.current.rotation.some((s) => s.feature === 'programKhas')).toBe(false);
      hook.unmount();
    } finally {
      localStorage.removeItem('surau.content');
    }
  });
});

describe('useContent hadis cycles', () => {
  it('shows the three hadis of the day on three consecutive cycles, a cycle being the other cards plus one hadis slot', async () => {
    const { renderHook, waitFor } = await import('@testing-library/preact');
    const { useContent } = await import('../src/data/content.ts');
    const { makeView } = await import('./helpers.tsx');
    const { buildCycle, klInstant } = await import('@surau/core');
    const kh = (id: string) => ({ id, textMs: `Teks ${id}.`, attribution: 'Riwayat Muslim' });
    const seeded = {
      ...content,
      posters: [
        { id: 'p1', updatedAt: 'x', updatedBy: 't', title: 'P1', assetId: 'a'.repeat(64), days: ['umum'], order: 1 },
        { id: 'p2', updatedAt: 'x', updatedBy: 't', title: 'P2', assetId: 'b'.repeat(64), days: ['umum'], order: 2 },
      ],
      hadisToday: [kh('h0'), kh('h1'), kh('h2')],
    };
    localStorage.setItem('surau.content', JSON.stringify({ content: seeded, fetchedAt: Date.now() }));
    try {
      // posters 2 x 15 s + hadis 20 s = a 50 s cycle
      const at = (sec: number) => makeView('2026-11-03', '00:00', {}).now.getTime() + sec * 1000;
      const view = (sec: number) => ({ ...makeView('2026-11-03', '00:00'), now: new Date(at(sec)) });
      const hook = renderHook((v) => useContent(v), { initialProps: view(40) });
      await waitFor(() => expect(hook.result.current.content).not.toBeNull());
      const seen: (string | null)[] = [];
      for (const sec of [40, 90, 140, 190]) {
        hook.rerender(view(sec));
        const r = hook.result.current;
        expect(r.rotation.reduce((a, s) => a + s.durationSeconds, 0)).toBe(50);
        expect(r.current!.slot).toMatchObject({ feature: 'hadis' });
        seen.push(r.current!.slot.itemId);
        // the same instant through core gives the same cycle
        const direct = buildCycle(r.content!, view(sec).settings, view(sec).now);
        expect(direct.slots).toEqual(r.rotation);
      }
      expect(seen).toEqual(['h0', 'h1', 'h2', 'h0']);
      hook.unmount();
      expect(klInstant('2026-11-03', '00:00')).toBeTruthy();
    } finally {
      localStorage.removeItem('surau.content');
    }
  });
});

describe('loadContent envelope (box answers { version, serverTime, content })', () => {
  it('rejects a bare KioskContent body without the envelope', async () => {
    const bare = (async () => new Response(JSON.stringify(content), { status: 200 })) as unknown as typeof fetch;
    await expect(loadContent(bare, fakeStorage())).rejects.toThrow(/no content/);
  });
});

describe('assetIdsOf', () => {
  const id = (c: string) => c.repeat(64);
  it('collects every picture id once, in a stable order, ignoring anything that is not a sha256', () => {
    const rich = {
      ...content,
      kuliah: [{ id: 'k', penceramah: { name: 'A', photoAssetId: id('a') }, kitab: { title: 'K', coverAssetId: id('b') } }],
      posters: [{ id: 'p', assetId: id('c') }, { id: 'p2', assetId: id('c') }],
      programKhas: [{ id: 'g', assetId: id('d') }, { id: 'g2', assetId: 'javascript:alert(1)' }],
      takwim: [{ id: 't', assetId: id('e') }],
      tugasan: [{ id: 'u', petugas: { name: 'B', photoAssetId: id('a') } }],
    } as unknown as Parameters<typeof assetIdsOf>[0];
    expect(assetIdsOf(rich)).toEqual([id('a'), id('b'), id('c'), id('d'), id('e')]);
  });

  it('collects a notice picture (pengumuman bergambar) and skips a notice without one', () => {
    const withNotice = {
      ...content,
      pengumuman: [{ id: 'a1', title: 'T', body: 'B', pictureAssetId: id('f') }, { id: 'a2', title: 'T', body: 'B' }, { id: 'a3', title: 'T', body: 'B', pictureAssetId: '../x.png' }],
    } as unknown as Parameters<typeof assetIdsOf>[0];
    expect(assetIdsOf(withNotice)).toEqual([id('f')]);
  });

  it('is empty for content without pictures', () => {
    expect(assetIdsOf(content as unknown as Parameters<typeof assetIdsOf>[0])).toEqual([]);
  });
});

describe('useContent skip: the slot after a skipped one gets a fixed start', () => {
  const asset = (c: string) => c.repeat(64);
  const vid = (id: string, order: number) => ({
    id, updatedAt: '2026-11-01T00:00:00Z', updatedBy: 't', title: id, source: 'upload', assetId: asset(id === 'va' ? 'a' : 'b'), days: ['umum'], order, durationSec: 60,
  });
  const seeded = {
    ...content,
    posters: [{ id: 'p1', updatedAt: 'x', updatedBy: 't', title: 'P1', assetId: asset('c'), days: ['umum'], order: 1 }],
    videos: [vid('va', 1), vid('vb', 2)],
  };

  it('keeps the start fixed while the clock runs, lets a second video skip itself, and the card pages from the fixed start', async () => {
    const { renderHook, waitFor, act } = await import('@testing-library/preact');
    const { useContent } = await import('../src/data/content.ts');
    const { makeView } = await import('./helpers.tsx');
    const { buildCycle } = await import('@surau/core');
    const { pageAt } = await import('../src/content/paging.ts');
    localStorage.setItem('surau.content', JSON.stringify({ content: seeded, fetchedAt: Date.now() }));
    try {
      const base = makeView('2026-11-03', '12:00').now.getTime();
      const view = (sec: number) => ({ ...makeView('2026-11-03', '12:00'), now: new Date(base + sec * 1000) });
      const hook = renderHook((v) => useContent(v), { initialProps: view(0) });
      await waitFor(() => expect(hook.result.current.content).not.toBeNull());
      const cycle = buildCycle(hook.result.current.content!, view(0).settings, view(0).now);
      const idx = cycle.slots.map((s) => s.itemId);
      expect(idx).toContain('va');
      expect(idx).toContain('vb');
      // find the first instant in the cycle at which the first of the two videos is showing, then play from there
      let t = 0;
      for (; t < 1000; t++) {
        hook.rerender(view(t));
        if (hook.result.current.current?.slot.feature === 'videos') break;
      }
      const first = hook.result.current.current!;
      expect(first.slot.feature).toBe('videos');
      const t0 = t;
      // the first video ends early (6 s in): the slot after it starts at that instant, once
      hook.rerender(view(t0 + 6));
      act(() => hook.result.current.skip!(hook.result.current.current!.startedAt));
      const after1 = hook.result.current.current!;
      expect(after1.startedAt.getTime()).toBe(base + (t0 + 6) * 1000);
      expect(after1.slot.itemId).not.toBe(first.slot.itemId);
      // the clock runs: the start does not move, so the card's page timer and its skip key stay still
      for (const dt of [7, 8, 9, 12]) {
        hook.rerender(view(t0 + dt));
        expect(hook.result.current.current!.startedAt.getTime()).toBe(after1.startedAt.getTime());
        expect(hook.result.current.current!.slot.itemId).toBe(after1.slot.itemId);
      }
      // a paged card gets pages that advance: elapsed grows from the fixed start
      const pageOf = (sec: number) => pageAt(view(sec).now, hook.result.current.current!.startedAt, 5, 4);
      expect(pageOf(t0 + 6)).toBe(0);
      expect(pageOf(t0 + 12)).toBe(1);
      // when that slot is itself a video it can skip itself, and the one after gets its own fixed start
      if (after1.slot.feature === 'videos') {
        hook.rerender(view(t0 + 10));
        act(() => hook.result.current.skip!(hook.result.current.current!.startedAt));
        const after2 = hook.result.current.current!;
        expect(after2.slot.itemId).not.toBe(after1.slot.itemId);
        expect(after2.slot.feature).toBe('posters');
        expect(after2.startedAt.getTime()).toBe(base + (t0 + 10) * 1000);
        hook.rerender(view(t0 + 14));
        expect(hook.result.current.current!.startedAt.getTime()).toBe(after2.startedAt.getTime());
      }
      hook.unmount();
    } finally {
      localStorage.removeItem('surau.content');
    }
  });
});
