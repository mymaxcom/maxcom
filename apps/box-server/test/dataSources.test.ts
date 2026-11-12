import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchJakimYear } from '../src/jakimFetch.ts';
import { fetchEveryAyahSurah, fetchQuranEnc } from '../src/islamic/fetch.ts';
import { DEFAULT_SOURCE_URLS, guardedFetch, sourceUrlsFrom } from '../src/net/safeFetch.ts';

const seen: string[] = [];
const recorder = (body: () => Response): typeof fetch =>
  (async (input: Parameters<typeof fetch>[0]) => {
    seen.push(String(input));
    return body();
  }) as unknown as typeof fetch;

afterEach(() => {
  seen.length = 0;
});

describe('fetchers read the configured base URL', () => {
  it('e-Solat: appends the query to a URL with and without a query string', async () => {
    const f = recorder(() => new Response('{}'));
    await fetchJakimYear('SGR01', 2026, f, 'https://api.example.my/takwim?r=x').catch(() => undefined);
    await fetchJakimYear('SGR01', 2026, f, 'https://api.example.my/takwim').catch(() => undefined);
    await fetchJakimYear('SGR01', 2026, f).catch(() => undefined);
    expect(seen).toEqual([
      'https://api.example.my/takwim?r=x&period=duration&zone=SGR01',
      'https://api.example.my/takwim?period=duration&zone=SGR01',
      'https://www.e-solat.gov.my/index.php?r=esolatApi/takwimsolat&period=duration&zone=SGR01',
    ]);
  });

  it('Quran text: uses the new base (trailing slash trimmed)', async () => {
    const f = recorder(() => new Response('{"result":[]}'));
    await fetchQuranEnc(f, 'malay_basumayyah', undefined, 'https://quran.example.my/api/').catch(() => undefined);
    expect(seen[0]).toBe('https://quran.example.my/api/translation/sura/malay_basumayyah/1');
  });

  it('Quran audio: uses the new base', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-'));
    try {
      const f = recorder(() => new Response('nope'));
      await fetchEveryAyahSurah(f, dir, 'Husary_64kbps', 1, 7, undefined, { sourceUrl: 'https://audio.example.my/d' }).catch(() => undefined);
      expect(seen[0]).toBe('https://audio.example.my/d/Husary_64kbps/001001.mp3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an unacceptable base before any request', async () => {
    const f = recorder(() => new Response('{}'));
    await expect(fetchJakimYear('SGR01', 2026, f, 'http://example.my/x')).rejects.toThrow(/https/);
    await expect(fetchJakimYear('SGR01', 2026, f, 'https://127.0.0.1/x')).rejects.toThrow(/public/);
    await expect(fetchQuranEnc(f, 'malay_basumayyah', undefined, 'https://10.0.0.5/api')).rejects.toThrow(/public/);
    await expect(
      fetchEveryAyahSurah(f, tmpdir(), 'Husary_64kbps', 1, 7, undefined, { sourceUrl: 'https://[::1]/d' }),
    ).rejects.toThrow(/public/);
    expect(seen).toEqual([]);
  });
});

describe('sourceUrlsFrom', () => {
  it('falls back to the defaults when absent or unacceptable', () => {
    expect(sourceUrlsFrom(undefined)).toEqual(DEFAULT_SOURCE_URLS);
    expect(sourceUrlsFrom({ dataSources: { esolat: { url: 'http://x.my/' }, quranText: 5 } })).toEqual(DEFAULT_SOURCE_URLS);
  });
  it('uses a good configured address', () => {
    const u = sourceUrlsFrom({ dataSources: { quranAudio: { name: 'X', url: 'https://audio.example.my/d' } } });
    expect(u.quranAudio).toBe('https://audio.example.my/d');
    expect(u.esolat).toBe(DEFAULT_SOURCE_URLS.esolat);
  });
});

describe('guardedFetch', () => {
  const ok = (): typeof fetch => (async () => { seen.push('inner'); return new Response('ok'); }) as unknown as typeof fetch;

  it('passes a host that resolves to public addresses, forcing redirect:error', async () => {
    let init: RequestInit | undefined;
    const inner = (async (_u: unknown, i?: RequestInit) => { init = i; return new Response('ok'); }) as unknown as typeof fetch;
    const g = guardedFetch(inner, async () => ['93.184.216.34', '2606:2800:220:1::1']);
    expect(await (await g('https://example.my/x', { redirect: 'follow' })).text()).toBe('ok');
    expect(init?.redirect).toBe('error');
  });

  it.each([
    ['127.0.0.1'], ['10.1.2.3'], ['10.168.1.5'], ['169.254.169.254'], ['172.20.0.1'], ['100.64.0.9'],
    ['::1'], ['fe80::1'], ['fd00::5'], ['::ffff:127.0.0.1'], ['::ffff:a00:1'],
  ])('refuses a host that resolves to %s', async (addr) => {
    const g = guardedFetch(ok(), async () => [addr]);
    await expect(g('https://rebind.example.my/x')).rejects.toThrow(/private/);
    expect(seen).toEqual([]);
  });

  it('refuses when any one of several addresses is private, or none resolve', async () => {
    await expect(guardedFetch(ok(), async () => ['93.184.216.34', '10.0.0.1'])('https://a.example.my/')).rejects.toThrow(/private/);
    await expect(guardedFetch(ok(), async () => [])('https://a.example.my/')).rejects.toThrow(/private/);
    expect(seen).toEqual([]);
  });

  it('refuses http, credentials, literal private IPs and local names without resolving', async () => {
    let looked = 0;
    const g = guardedFetch(ok(), async () => { looked += 1; return ['93.184.216.34']; });
    await expect(g('http://example.my/')).rejects.toThrow(/https/);
    await expect(g('https://u:p@example.my/')).rejects.toThrow(/credentials/);
    await expect(g('https://127.0.0.1/')).rejects.toThrow(/private/);
    await expect(g('https://[::1]/')).rejects.toThrow(/private/);
    await expect(g('https://printer.local/')).rejects.toThrow(/private/);
    await expect(g('not a url')).rejects.toThrow(/valid/);
    expect(looked).toBe(0);
    expect(seen).toEqual([]);
  });

  describe('redirects', () => {
    let server: Server | undefined;
    afterEach(() => new Promise<void>((r) => { if (server) server.close(() => r()); else r(); }));

    it('a redirect to a private host is not followed', async () => {
      const hits: string[] = [];
      server = createServer((req, res) => {
        hits.push(req.url ?? '');
        if (req.url === '/start') {
          res.writeHead(302, { location: 'http://127.0.0.1:1/secret' });
          res.end();
        } else {
          res.end('secret');
        }
      });
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as AddressInfo).port;
      // The inner fetch is the real one, pointed at the local server so a real 302 comes back.
      const inner = ((_u: unknown, i?: RequestInit) => fetch(`http://127.0.0.1:${port}/start`, i)) as typeof fetch;
      const g = guardedFetch(inner, async () => ['93.184.216.34']);
      await expect(g('https://example.my/start')).rejects.toThrow();
      expect(hits).toEqual(['/start']);
    });
  });
});

describe('e-Solat body cap', () => {
  it('cancels a chunked body that passes the cap even with no content-length', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
        if (pulled > 50) controller.close();
      },
    });
    const f = (async () => new Response(body)) as unknown as typeof fetch;
    await expect(fetchJakimYear('SGR01', 2026, f)).rejects.toThrow(/too large/);
    expect(pulled).toBeLessThan(15);
  });
});
