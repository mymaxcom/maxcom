import { describe, expect, it } from 'vitest';
import { buildFileList, cacheNameFor, renderSw } from '../build/sw-plugin.ts';

const FILES = ['index.html', 'assets/index-AAA.js', 'assets/index-BBB.css', 'assets/beep-short-CCC.wav', 'sw.js'];

describe('service worker plugin helpers', () => {
  it('lists built files as URL paths, without sw.js itself', () => {
    const list = buildFileList(FILES);
    expect(list).toContain('/index.html');
    expect(list).toContain('/assets/index-AAA.js');
    expect(list).not.toContain('/sw.js');
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
