import { describe, expect, it } from 'vitest';
import { buildFileList, cacheNameFor, renderSw } from '../build/sw-plugin.ts';
import { packHash, resolveTheme } from '../src/themes/index.ts';

const FILES = ['index.html', 'assets/index-AAA.js', 'assets/index-BBB.css', 'assets/beep-short-CCC.wav', 'sw.js'];

describe('service worker plugin helpers', () => {
  it('lists built files as URL paths, without sw.js itself', () => {
    const list = buildFileList(FILES);
    expect(list).toContain('/index.html');
    expect(list).toContain('/assets/index-AAA.js');
    expect(list).not.toContain('/sw.js');
  });

  it('leaves the built-in theme files out of the precache', () => {
    expect(buildFileList([...FILES, 'builtin-themes/creative/theme.json', 'builtin-themes\minimal\theme.css'])).not.toContain('/builtin-themes/creative/theme.json');
    expect(buildFileList(['builtin-themes/x/theme.css']).length).toBe(0);
  });

  it('normalises Windows separators', () => {
    expect(buildFileList(['assets\\a.js'])).toEqual(['/assets/a.js']);
  });

  it('never lists /api paths', () => {
    const list = buildFileList([...FILES, 'api/health', 'api']);
    expect(list.some((u) => u === '/api' || u.startsWith('/api/'))).toBe(false);
  });

  it('gives the same cache name for the same inputs, in any order', () => {
    const a = cacheNameFor(buildFileList(FILES));
    expect(cacheNameFor(buildFileList([...FILES].reverse()))).toBe(a);
    expect(a).toMatch(/^surau-shell-[0-9a-f]{12}$/);
  });

  it('gives a different cache name for a different file list', () => {
    const a = cacheNameFor(buildFileList(FILES));
    const b = cacheNameFor(buildFileList([...FILES, 'assets/new-DDD.js']));
    expect(b).not.toBe(a);
  });

  it('renders a worker that embeds the list and name and skips /api', () => {
    const urls = buildFileList(FILES);
    const src = renderSw(urls);
    expect(src).toContain(cacheNameFor(urls));
    expect(src).toContain('"/index.html"');
    expect(src).toContain("'/api/'");
  });

  it('keeps box pictures (asset ids) for offline use in a cache the shell clean-up never deletes', () => {
    const src = renderSw(buildFileList(FILES));
    expect(src).toContain('surau-media');
    expect(src).toContain('[0-9a-f]{64}');
    expect(src).toContain('response.ok');
    // the shell cache clean-up only touches the shell prefix, so the media cache survives a new build
    expect(src).toContain('surau-shell-');
    expect(src).not.toContain("startsWith('surau-')");
  });

  it('keeps installed theme packs in a cache of their own, cache first, outside the shell clean-up', () => {
    const src = renderSw(buildFileList(FILES));
    expect(src).toContain("'surau-themes-v1'");
    expect(src).toContain('/themes/');
    expect(src).toContain('themeFirst');
    expect(src).not.toContain("startsWith('surau-')");
  });

  // Q1: the addresses are the ones the kiosk itself builds (the sha-256 prefix and the bundle format), not made-up ones.
const H_NEW = packHash({ assetId: 'a'.repeat(64) });
const H_OLD = packHash({ assetId: 'b'.repeat(64) });
const H_OTHER = packHash({ assetId: 'c'.repeat(64) });

describe('theme pack cache', () => {
    const run = async (hit: unknown, resp: { ok: boolean }, cachedUrls: string[]) => {
      const store = new Map<string, unknown>(cachedUrls.map((u) => [u, { url: u }]));
      const cache = {
        match: async (u: string) => (hit !== undefined && u.endsWith(`/themes/hijau-siti/${H_NEW}/bundle.css`) ? hit : undefined),
        put: async (u: string) => { store.set(u, { url: u }); },
        keys: async () => [...store.values()],
        delete: async (r: { url: string }) => store.delete(r.url),
      };
      let onFetch: (e: unknown) => void = () => undefined;
      const self = { location: { origin: 'https://box.local' }, addEventListener: (t: string, fn: (e: unknown) => void) => { if (t === 'fetch') onFetch = fn; } };
      const fetched: string[] = [];
      const fetchFn = async (r: { url: string }) => { fetched.push(r.url); return { ok: resp.ok, clone: () => ({}) }; };
      new Function('self', 'caches', 'fetch', renderSw(buildFileList(FILES)))(self, { open: async () => cache, keys: async () => [], delete: async () => true }, fetchFn);
      let answered: Promise<unknown> | null = null;
      const url = `https://box.local/themes/hijau-siti/${H_NEW}/bundle.css`;
      onFetch({ request: { method: 'GET', url, mode: 'no-cors', headers: new Headers() }, respondWith: (p: Promise<unknown>) => { answered = p; } });
      await answered;
      return { fetched, kept: [...store.keys()].sort() };
    };

    it('answers from the cache without the network', async () => {
      const r = await run({ marker: 1 }, { ok: true }, []);
      expect(r.fetched).toEqual([]);
    });

    it('fetches, keeps the answer, and drops the files of the same theme at other versions only', async () => {
      const old = `https://box.local/themes/hijau-siti/${H_OLD}/bundle.css`;
      const other = `https://box.local/themes/biru/${H_OTHER}/bundle.css`;
      const r = await run(undefined, { ok: true }, [old, other]);
      expect(r.fetched).toEqual([`https://box.local/themes/hijau-siti/${H_NEW}/bundle.css`]);
      expect(r.kept).toEqual([other, `https://box.local/themes/hijau-siti/${H_NEW}/bundle.css`].sort());
    });

    it('the kiosk own addresses (the bundle and a picture) are the ones the cache recognises', async () => {
      const pack = { assetId: 'a'.repeat(64), version: 3, title: 'T', base: 'creative', contract: 1, bytes: 1, fonts: [], screens: [], images: { kuliah: 'jpg' }, defaults: {} };
      const theme = resolveTheme({ kioskTemplate: { enabled: true, templateId: 'hijau-siti' }, themeStyle: { styles: {}, packs: { 'hijau-siti': pack } } } as never);
      const src = renderSw(buildFileList(FILES));
      const re = /const THEME_PATH = (\/.*\/);/.exec(src)![1]!;
      const THEME_PATH = new Function(`return ${re}`)() as RegExp;
      expect(THEME_PATH.exec(theme.cssUrl!)?.[1]).toBe('hijau-siti');
      expect(THEME_PATH.exec(`/themes/hijau-siti/${packHash(pack)}/images/kuliah.jpg`)?.[2]).toBe(packHash(pack));
      // the old shapes (a small version number, a woff2) are not kept any more
      expect(THEME_PATH.test('/themes/hijau-siti/3/bundle.css')).toBe(false);
      expect(THEME_PATH.test(`/themes/hijau-siti/${packHash(pack)}/fonts/x.woff2`)).toBe(false);
    });

    it('does not keep an error answer', async () => {
      const r = await run(undefined, { ok: false }, []);
      expect(r.kept).toEqual([]);
    });
  });

  describe('media cache pruning (Q13) and clearing (S10)', () => {
    const id = (n: number): string => n.toString(16).padStart(64, '0');
    const req = (n: number) => ({ url: `https://box.local/assets/${id(n)}` });

    function boot(initial: number[]) {
      const store = new Map<string, { url: string }>(initial.map((n) => [req(n).url, req(n)]));
      const media = {
        keys: async () => [...store.values()],
        delete: async (r: { url: string }) => store.delete(r.url),
      };
      const deleted: string[] = [];
      const caches = {
        open: async () => media,
        delete: async (name: string) => { deleted.push(name); return true; },
      };
      let onMessage: (e: unknown) => void = () => undefined;
      const self = {
        location: { origin: 'https://box.local' },
        addEventListener: (t: string, fn: (e: unknown) => void) => { if (t === 'message') onMessage = fn; },
      };
      new Function('self', 'caches', renderSw(buildFileList(FILES)))(self, caches);
      const send = async (data: unknown): Promise<void> => {
        const waits: Promise<unknown>[] = [];
        onMessage({ data, waitUntil: (p: Promise<unknown>) => waits.push(p) });
        await Promise.all(waits);
      };
      return { store, send, deleted };
    }

    it('keeps only the asset ids named by the latest content', async () => {
      const w = boot([1, 2, 3]);
      await w.send({ type: 'media-keep', ids: [id(2)] });
      expect([...w.store.keys()]).toEqual([req(2).url]);
    });

    it('caps the cache at 300 entries, oldest first', async () => {
      const all = Array.from({ length: 305 }, (_, i) => i + 1);
      const w = boot(all);
      await w.send({ type: 'media-keep', ids: all.map(id) });
      expect(w.store.size).toBe(300);
      expect(w.store.has(req(1).url)).toBe(false);
      expect(w.store.has(req(305).url)).toBe(true);
    });

    it('media-clear deletes the whole media cache, and junk messages are ignored', async () => {
      const w = boot([1]);
      await w.send({ type: 'nope' });
      await w.send(null);
      expect(w.deleted).toEqual([]);
      await w.send({ type: 'media-clear' });
      expect(w.deleted).toEqual(['surau-media-v1']);
    });
  });
});
