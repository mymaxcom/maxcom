import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchEveryAyahSurah, fetchQuranEnc } from '../src/islamic/fetch.ts';
import {
  AYAT_COUNTS,
  DAILY_RANGES,
  SURAH_NAMES,
  ayatForDay,
  getAyat,
  loadQuran,
  saveQuran,
} from '../src/islamic/quranStore.ts';
import type { QuranText } from '../src/islamic/quranStore.ts';
import { registerIslamicRoutes } from '../src/islamic/routes.ts';
import { runCli } from '../src/cli/fetchIslamic.ts';

interface Row { id: string; sura: string; aya: string; arabic_text: string; translation: string; footnotes: null }
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/quranenc-sura-2.json', import.meta.url), 'utf8'),
) as { result: Row[] };
const found = fixture.result.find((r) => r.aya === '255');
if (!found) throw new Error('fixture lacks 2:255');
const ayat255: Row = found;

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** Fake QuranEnc: every surah answers with the 5-ayat fixture excerpt. */
const fixtureFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes('/translation/sura/')) return json(fixture);
  return json({ translations: [] });
};

/** Fake QuranEnc serving a complete 6236-ayat set (2:255 is the real fixture row). */
function completeFetch(counter?: { n: number }): typeof fetch {
  return async (input) => {
    const url = String(input);
    const m = /\/translation\/sura\/([a-z_]+)\/(\d+)$/.exec(url);
    if (m) {
      if (counter) counter.n += 1;
      const surah = Number(m[2]);
      const count = AYAT_COUNTS[surah - 1] ?? 0;
      const result: Row[] = [];
      for (let aya = 1; aya <= count; aya += 1) {
        result.push(
          surah === 2 && aya === 255
            ? ayat255
            : { id: `${surah}-${aya}`, sura: String(surah), aya: String(aya), arabic_text: `ar ${surah}:${aya}`, translation: `ms ${surah}:${aya}`, footnotes: null },
        );
      }
      return json({ result });
    }
    if (url.endsWith('/translations/list')) {
      return json({ translations: [{ key: 'malay_basumayyah', version: '1.0.9', title: 'Terjemahan Basmeih' }] });
    }
    return new Response('not found', { status: 404 });
  };
}

const mp3 = (bytes: number): Uint8Array => {
  const b = new Uint8Array(bytes);
  b[0] = 0xff;
  b[1] = 0xf3;
  return b;
};

function audioFetch(perFile: number, calls?: string[]): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.endsWith('/recitations.js')) {
      return json({ '19': { subfolder: 'Husary_64kbps', name: 'Husary', bitrate: '64kbps' } });
    }
    if (/\/\d{6}\.mp3$/.test(url)) {
      calls?.push(url);
      return new Response(mp3(perFile), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }
    return new Response('nope', { status: 404 });
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'surau-islamic-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('constants', () => {
  it('has 114 surahs, 6236 ayat, names for all, and 60 valid daily ranges', () => {
    expect(AYAT_COUNTS).toHaveLength(114);
    expect(AYAT_COUNTS.reduce((a, b) => a + b, 0)).toBe(6236);
    expect(SURAH_NAMES).toHaveLength(114);
    expect(DAILY_RANGES).toHaveLength(60);
    for (const [s, from, to] of DAILY_RANGES) {
      expect(from).toBeGreaterThanOrEqual(1);
      expect(to).toBeGreaterThanOrEqual(from);
      expect(to).toBeLessThanOrEqual(AYAT_COUNTS[s - 1] ?? 0);
    }
  });
});

describe('fetchQuranEnc', () => {
  it('throws incomplete when a surah comes back with only the 5-ayat excerpt', async () => {
    await expect(fetchQuranEnc(fixtureFetch)).rejects.toThrow(/incomplete/);
  });

  it('stores a complete set verbatim with the listed version', async () => {
    const calls = { n: 0 };
    const q = await fetchQuranEnc(completeFetch(calls));
    expect(calls.n).toBe(114);
    expect(q.version).toBe('1.0.9');
    expect(q.surahs[2]?.ayat[254]?.aya).toBe(255);
    expect(q.surahs[2]?.ayat[254]?.translation).toBe(ayat255.translation);
    expect(q.surahs[2]?.ayat[254]?.arabic).toBe(ayat255.arabic_text);
    expect(q.surahs[2]?.nameMs).toBe('Al-Baqarah');
    expect(q.surahs[114]?.ayat).toHaveLength(6);
  });

  it('rejects an unsafe translation key before any request', async () => {
    let called = false;
    const spy: typeof fetch = async () => {
      called = true;
      return json({});
    };
    await expect(fetchQuranEnc(spy, '../x')).rejects.toThrow(/invalid translation key/);
    expect(called).toBe(false);
  });

  it('keeps an unlisted translation usable (version "unlisted")', async () => {
    const inner = completeFetch();
    const noList: typeof fetch = async (input, init) =>
      String(input).endsWith('/translations/list') ? json({ translations: [] }) : inner(input, init);
    expect((await fetchQuranEnc(noList)).version).toBe('unlisted');
  });
});

describe('quranStore', () => {
  let quran: QuranText;
  beforeEach(async () => {
    quran = await fetchQuranEnc(completeFetch());
  });

  it('round-trips through saveQuran and loadQuran', () => {
    expect(loadQuran(dir)).toBeNull();
    saveQuran(dir, quran);
    const back = loadQuran(dir);
    expect(back?.version).toBe('1.0.9');
    expect(back?.surahs[2]?.ayat).toHaveLength(286);
  });

  it('ayatForDay daily is stable per date and differs on the next day', () => {
    const s = { pick: 'daily' as const, surah: 2, ayatFrom: 255, ayatTo: 255 };
    const a = ayatForDay(quran, s, '2026-11-03');
    expect(a).not.toBeNull();
    expect(ayatForDay(quran, s, '2026-11-03')).toEqual(a);
    expect(ayatForDay(quran, s, '2026-11-04')).not.toEqual(a);
  });

  it('ayatForDay random is seeded by the date', () => {
    const s = { pick: 'random' as const, surah: 2, ayatFrom: 255, ayatTo: 255 };
    expect(ayatForDay(quran, s, '2026-11-03')).toEqual(ayatForDay(quran, s, '2026-11-03'));
    const days = new Set<string>();
    for (let d = 1; d <= 20; d += 1) {
      const c = ayatForDay(quran, s, `2026-11-${String(d).padStart(2, '0')}`);
      days.add(`${c?.surah}:${c?.ayatFrom}`);
    }
    expect(days.size).toBeGreaterThan(10);
  });

  it('manual 2:255 returns one Arabic string with the verbatim text and credit version', async () => {
    const real = { ...quran, surahs: { ...quran.surahs } };
    const baq = real.surahs[2];
    if (!baq) throw new Error('no surah 2');
    real.surahs[2] = { ...baq, ayat: baq.ayat.map((a) => (a.aya === 255 ? { aya: 255, arabic: ayat255.arabic_text, translation: ayat255.translation } : a)) };
    const card = ayatForDay(real, { pick: 'manual', surah: 2, ayatFrom: 255, ayatTo: 255 }, '2026-11-03');
    expect(card?.arabic).toHaveLength(1);
    // Allah, with the mark order QuranEnc serves (shadda before fatha); never normalised.
    expect(card?.arabic[0]).toContain('ٱللَّهُ');
    expect(card?.malay[0]).toBe(ayat255.translation);
    expect(card?.translationVersion).toBe('1.0.9');
    expect(card?.surahNameAr).toBe('البقرة');
  });

  it('cuts ranges longer than 8 ayat and returns null for an uncached surah', () => {
    const card = ayatForDay(quran, { pick: 'manual', surah: 2, ayatFrom: 1, ayatTo: 30 }, '2026-11-03');
    expect(card?.ayatFrom).toBe(1);
    expect(card?.ayatTo).toBe(8);
    expect(card?.arabic).toHaveLength(8);
    const partial: QuranText = { ...quran, surahs: { 1: quran.surahs[1] as QuranText['surahs'][number] } };
    expect(ayatForDay(partial, { pick: 'manual', surah: 2, ayatFrom: 1, ayatTo: 2 }, '2026-11-03')).toBeNull();
    expect(() => getAyat(partial, 2, 1, 2)).toThrow();
  });
});

describe('fetchEveryAyahSurah', () => {
  it('writes 110 files and index.json, and a second run fetches nothing', async () => {
    const calls: string[] = [];
    const out = await fetchEveryAyahSurah(audioFetch(1024, calls), dir, 'Husary_64kbps', 18, 110);
    expect(out.bytes).toBe(110 * 1024);
    expect(calls).toHaveLength(110);
    expect(calls[0]).toBe('https://everyayah.com/data/Husary_64kbps/018001.mp3');
    const folder = join(dir, 'islamic', 'audio', 'Husary_64kbps', '18');
    const files = readdirSync(folder).filter((f) => f.endsWith('.mp3'));
    expect(files).toHaveLength(110);
    expect(files).toContain('001.mp3');
    expect(files).toContain('110.mp3');
    const index = JSON.parse(readFileSync(join(folder, 'index.json'), 'utf8')) as Record<string, unknown>;
    expect(index).toMatchObject({ reciter: 'Husary_64kbps', reciterName: 'Husary', surah: 18, ayatCount: 110, bytes: 110 * 1024 });
    expect(typeof index.fetchedAt).toBe('string');

    calls.length = 0;
    await fetchEveryAyahSurah(audioFetch(1024, calls), dir, 'Husary_64kbps', 18, 110);
    expect(calls).toHaveLength(0);
  });

  it('resumes: only the missing files are fetched', async () => {
    const calls: string[] = [];
    await fetchEveryAyahSurah(audioFetch(1024, calls), dir, 'Husary_64kbps', 18, 110);
    const folder = join(dir, 'islamic', 'audio', 'Husary_64kbps', '18');
    rmSync(join(folder, '005.mp3'));
    rmSync(join(folder, 'index.json'));
    calls.length = 0;
    await fetchEveryAyahSurah(audioFetch(1024, calls), dir, 'Husary_64kbps', 18, 110);
    expect(calls).toEqual(['https://everyayah.com/data/Husary_64kbps/018005.mp3']);
  });

  it('rejects before writing when the projected cache exceeds cacheMaxMb', async () => {
    await expect(
      fetchEveryAyahSurah(audioFetch(1024 * 1024), dir, 'Husary_64kbps', 18, 110, undefined, { cacheMaxMb: 50 }),
    ).rejects.toThrow(/cacheMaxMb/);
    expect(existsSync(join(dir, 'islamic', 'audio', 'Husary_64kbps', '18'))).toBe(false);
  });

  it('refuses a wrong ayat count, a bad reciter and non-MP3 data', async () => {
    await expect(fetchEveryAyahSurah(audioFetch(1024), dir, 'Husary_64kbps', 18, 99)).rejects.toThrow(/110 ayat/);
    await expect(fetchEveryAyahSurah(audioFetch(1024), dir, '../etc', 18, 110)).rejects.toThrow(/invalid reciter/);
    const html: typeof fetch = async () => new Response('<html>', { status: 200 });
    await expect(fetchEveryAyahSurah(html, dir, 'Husary_64kbps', 112, 4)).rejects.toThrow(/not an MP3/);
  });
});

describe('islamic routes', () => {
  async function build(fetchImpl: typeof fetch = completeFetch(), cacheMaxMb = 300) {
    const app = Fastify();
    const logs: string[] = [];
    registerIslamicRoutes(app, {
      dataDir: dir,
      fetchImpl,
      getReciter: () => 'Husary_64kbps',
      getCacheMaxMb: () => cacheMaxMb,
      logChange: (actor, action, detail) => logs.push(`${actor} ${action} ${detail}`),
    });
    await app.ready();
    return { app, logs };
  }

  async function waitJob(app: Awaited<ReturnType<typeof build>>['app'], id: string) {
    for (let i = 0; i < 200; i += 1) {
      const res = await app.inject({ method: 'GET', url: `/api/islamic/jobs/${id}` });
      const body = res.json() as { state: string; progress: number; error?: string };
      if (body.state !== 'running') return body;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('job did not finish');
  }

  it('status on an empty data dir: no quran, no audio', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/api/islamic/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      quran: { present: false },
      audio: { reciter: 'Husary_64kbps', surahs: [], bytes: 0, cacheMaxMb: 300 },
    });
    await app.close();
  });

  it('fetches the quran as a job, logs the actor, then reports it present', async () => {
    const { app, logs } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/islamic/fetch', payload: { what: 'quran' } });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    const done = await waitJob(app, jobId);
    expect(done).toMatchObject({ state: 'done', progress: 1 });
    const status = (await app.inject({ method: 'GET', url: '/api/islamic/status' })).json() as { quran: Record<string, unknown> };
    expect(status.quran).toMatchObject({ present: true, version: '1.0.9', ayatCount: 6236 });
    expect(logs).toEqual(['local islamic.fetch quran']);
    await app.close();
  });

  it('reports a failed job with the error and frees the slot', async () => {
    const { app } = await build(fixtureFetch);
    const res = await app.inject({ method: 'POST', url: '/api/islamic/fetch', payload: { what: 'quran' } });
    const done = await waitJob(app, (res.json() as { jobId: string }).jobId);
    expect(done.state).toBe('failed');
    expect(done.error).toMatch(/incomplete/);
    const again = await app.inject({ method: 'POST', url: '/api/islamic/fetch', payload: { what: 'quran' } });
    expect(again.statusCode).toBe(202);
    await waitJob(app, (again.json() as { jobId: string }).jobId);
    await app.close();
  });

  it('answers 409 while a job is running and 400 for a bad body', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inner = completeFetch();
    const slow: typeof fetch = async (input, init) => {
      await gate;
      return inner(input, init);
    };
    const { app } = await build(slow);
    const first = await app.inject({ method: 'POST', url: '/api/islamic/fetch', payload: { what: 'quran' } });
    expect(first.statusCode).toBe(202);
    const second = await app.inject({ method: 'POST', url: '/api/islamic/fetch', payload: { what: 'audio', surah: 112 } });
    expect(second.statusCode).toBe(409);
    release();
    await waitJob(app, (first.json() as { jobId: string }).jobId);
    for (const payload of [{}, { what: 'audio' }, { what: 'audio', surah: 0 }, { what: 'audio', surah: 115 }, { what: 'x' }]) {
      const bad = await app.inject({ method: 'POST', url: '/api/islamic/fetch', payload });
      expect(bad.statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'GET', url: '/api/islamic/jobs/nope' })).statusCode).toBe(404);
    await app.close();
  });

  it('fetches an audio surah and serves it with immutable caching and ranges', async () => {
    const { app } = await build(audioFetch(2048));
    const res = await app.inject({ method: 'POST', url: '/api/islamic/fetch', payload: { what: 'audio', surah: 112 } });
    expect(res.statusCode).toBe(202);
    expect((await waitJob(app, (res.json() as { jobId: string }).jobId)).state).toBe('done');
    const status = (await app.inject({ method: 'GET', url: '/api/islamic/status' })).json() as { audio: { surahs: number[]; bytes: number } };
    expect(status.audio).toMatchObject({ surahs: [112], bytes: 4 * 2048 });

    const file = await app.inject({ method: 'GET', url: '/islamic/audio/Husary_64kbps/112/001.mp3' });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('audio/mpeg');
    expect(file.headers['cache-control']).toContain('immutable');
    expect(file.rawPayload.length).toBe(2048);
    const part = await app.inject({ method: 'GET', url: '/islamic/audio/Husary_64kbps/112/1.mp3', headers: { range: 'bytes=0-9' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 0-9/2048');
    expect(part.rawPayload.length).toBe(10);
    const bad = await app.inject({ method: 'GET', url: '/islamic/audio/Husary_64kbps/112/1.mp3', headers: { range: 'bytes=9999-' } });
    expect(bad.statusCode).toBe(416);
    await app.close();
  });

  it('never serves outside the audio folder', async () => {
    mkdirSync(join(dir, 'islamic', 'audio', 'Husary_64kbps', '1'), { recursive: true });
    writeFileSync(join(dir, 'secret.mp3'), 'x');
    const { app } = await build();
    for (const url of [
      '/islamic/audio/../x/1/1.mp3',
      '/islamic/audio/..%2F..%2Fsecret/1/1.mp3',
      '/islamic/audio/Husary_64kbps/..%2F1/1.mp3',
      '/islamic/audio/Husary_64kbps/1/..%2F..%2Fsecret.mp3',
      '/islamic/audio/Husary_64kbps/1/1.mp3',
      '/islamic/audio/Husary_64kbps/1/999.mp3',
      '/islamic/audio/Husary_64kbps/200/1.mp3',
      '/islamic/audio/Hu/1/1.mp3',
    ]) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
    await app.close();
  });
});

describe('fetchIslamic CLI', () => {
  it('prints usage without work, and fetches quran plus audio to the data dir', async () => {
    const lines: string[] = [];
    expect(await runCli(['--data', dir], fetch, (l) => lines.push(l))).toBe(2);
    expect(lines[0]).toMatch(/usage/);

    lines.length = 0;
    const quranFetch = completeFetch();
    const audio = audioFetch(512);
    const both: typeof fetch = async (input, init) =>
      String(input).includes('everyayah') ? audio(input, init) : quranFetch(input, init);
    expect(await runCli(['--data', dir, '--quran', '--audio', '112,113'], both, (l) => lines.push(l))).toBe(0);
    expect(lines.some((l) => /^sha256 [0-9a-f]{64}$/.test(l))).toBe(true);
    expect(loadQuran(dir)?.version).toBe('1.0.9');
    expect(existsSync(join(dir, 'islamic', 'audio', 'Husary_64kbps', '113', 'index.json'))).toBe(true);
  });
});

describe('outbound fetch hardening (S6)', () => {
  it('never follows redirects: every request carries redirect "error"', async () => {
    const inits: (RequestInit | undefined)[] = [];
    const spy: typeof fetch = async (input, init) => {
      inits.push(init);
      return fixtureFetch(input, init);
    };
    await fetchQuranEnc(spy, 'malay_basumayyah').catch(() => undefined);
    expect(inits.length).toBeGreaterThan(0);
    for (const init of inits) expect(init?.redirect).toBe('error');
    const audioInits: (RequestInit | undefined)[] = [];
    const audioSpy: typeof fetch = async (input, init) => {
      audioInits.push(init);
      return audioFetch(100)(input, init);
    };
    await fetchEveryAyahSurah(audioSpy, dir, 'Husary_64kbps', 1, AYAT_COUNTS[0] ?? 7).catch(() => undefined);
    expect(audioInits.length).toBeGreaterThan(0);
    for (const init of audioInits) expect(init?.redirect).toBe('error');
  });

  it('rejects a declared Content-Length over the cap before reading the body', async () => {
    let pulled = 0;
    const big: typeof fetch = async () =>
      new Response(
        new ReadableStream({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(10)); } }),
        { status: 200, headers: { 'content-length': String(50 * 1024 * 1024) } },
      );
    await expect(fetchQuranEnc(big, 'malay_basumayyah')).rejects.toThrow(/too large/);
    expect(pulled).toBeLessThanOrEqual(1);
    const bigAudio: typeof fetch = async (input) =>
      String(input).endsWith('.mp3')
        ? new Response(mp3(10), { status: 200, headers: { 'content-length': String(50 * 1024 * 1024) } })
        : audioFetch(10)(input);
    await expect(fetchEveryAyahSurah(bigAudio, dir, 'Husary_64kbps', 1, AYAT_COUNTS[0] ?? 7)).rejects.toThrow(/too large/);
  });

  it('stops reading a body with no Content-Length once it passes the byte cap', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const endless: typeof fetch = async () =>
      new Response(new ReadableStream({ pull(c) { pulled += 1; c.enqueue(chunk); } }), { status: 200 });
    await expect(fetchQuranEnc(endless, 'malay_basumayyah')).rejects.toThrow(/too large/);
    expect(pulled).toBeLessThanOrEqual(8); // 5 MB cap, 1 MB chunks, plus read-ahead
  });

  it('counts multibyte text in bytes, not characters', async () => {
    // 3 000 000 chars x 2 bytes = 6 MB > 5 MB cap although the character count is below it.
    const text = 'ا'.repeat(3_000_000);
    const multi: typeof fetch = async () => new Response(text, { status: 200 });
    await expect(fetchQuranEnc(multi, 'malay_basumayyah')).rejects.toThrow(/too large/);
  });
});
