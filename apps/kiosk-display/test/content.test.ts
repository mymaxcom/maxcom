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

  it('is empty for content without pictures', () => {
    expect(assetIdsOf(content as unknown as Parameters<typeof assetIdsOf>[0])).toEqual([]);
  });
});
