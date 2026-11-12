import { createReadStream, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { guardedFetch } from '../net/safeFetch.ts';
import { audioCacheBytes, audioRoot, fetchEveryAyahSurah, fetchQuranEnc, readAudioIndex } from './fetch.ts';
import { AYAT_COUNTS, countAyat, loadQuran, quranFileStat, saveQuran } from './quranStore.ts';
import type { QuranText } from './quranStore.ts';

export interface IslamicRouteDeps {
  dataDir: string;
  /** Injected so tests never touch the network. */
  fetchImpl?: typeof fetch;
  /** Current `tilawah.reciter` folder name. */
  getReciter: () => string;
  /** Current `tilawah.cacheMaxMb`. */
  getCacheMaxMb: () => number;
  /** Current `dataSources` base URLs; the defaults when absent. */
  getSourceUrls?: () => { quranText: string; quranAudio: string };
  /** Who is acting; Plan 3 supplies `user:<id>`. */
  actorOf?: (request: FastifyRequest) => string;
  /** Receives one line per fetch job start, for the change log. */
  logChange?: (actor: string, action: string, detail: string) => void;
}

type JobState = 'running' | 'done' | 'failed';
interface Job {
  id: string;
  state: JobState;
  progress: number;
  error?: string;
}

const RECITER_RE = /^[A-Za-z0-9_]{3,64}$/;
const SURAH_RE = /^(?:[1-9]|[1-9]\d|10\d|11[0-4])$/;
const FILE_RE = /^(\d{1,3})\.mp3$/;
const MAX_JOBS = 20;
const IMMUTABLE = 'public, max-age=31536000, immutable';

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function cachedSurahs(dataDir: string, reciter: string): number[] {
  const out: number[] = [];
  let names: string[];
  try {
    names = readdirSync(join(audioRoot(dataDir), reciter));
  } catch {
    return out;
  }
  for (const name of names) {
    if (!SURAH_RE.test(name)) continue;
    const n = Number(name);
    const idx = readAudioIndex(dataDir, reciter, n);
    if (idx && idx.ayatCount === AYAT_COUNTS[n - 1]) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'bad' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return 'bad';
  let start: number;
  let end: number;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'bad';
  return { start, end };
}

/** Registers `/api/islamic/*` and `/islamic/audio/*` on the given Fastify instance. */
export function registerIslamicRoutes(app: FastifyInstance, deps: IslamicRouteDeps): void {
  const { dataDir } = deps;
  const jobs = new Map<string, Job>();
  let seq = 0;
  let busy = false;
  let quranCache: { mtimeMs: number; size: number; quran: QuranText } | null = null;

  const actorOf = deps.actorOf ?? ((): string => 'local');

  function quranNow(): QuranText | null {
    const st = quranFileStat(dataDir);
    if (!st) return null;
    if (quranCache && quranCache.mtimeMs === st.mtimeMs && quranCache.size === st.size) return quranCache.quran;
    const quran = loadQuran(dataDir);
    quranCache = quran ? { ...st, quran } : null;
    return quran;
  }

  app.get('/api/islamic/status', async () => {
    const q = quranNow();
    const reciter = deps.getReciter();
    const surahs = RECITER_RE.test(reciter) ? cachedSurahs(dataDir, reciter) : [];
    return {
      quran: q
        ? { present: true, version: q.version, fetchedAt: q.fetchedAt, ayatCount: countAyat(q) }
        : { present: false },
      audio: { reciter, surahs, bytes: audioCacheBytes(dataDir), cacheMaxMb: deps.getCacheMaxMb() },
    };
  });

  app.post('/api/islamic/fetch', async (request, reply) => {
    const body: unknown = request.body;
    let task: { what: 'quran' } | { what: 'audio'; surah: number };
    if (isObj(body) && body.what === 'quran') {
      task = { what: 'quran' };
    } else if (
      isObj(body) && body.what === 'audio' && typeof body.surah === 'number' &&
      Number.isInteger(body.surah) && body.surah >= 1 && body.surah <= 114
    ) {
      task = { what: 'audio', surah: body.surah };
    } else {
      return reply.code(400).send({ errors: ['body must be {what:"quran"} or {what:"audio",surah:1..114}'] });
    }
    const reciter = deps.getReciter();
    if (task.what === 'audio' && !RECITER_RE.test(reciter)) {
      return reply.code(400).send({ errors: ['tilawah.reciter is not a valid reciter folder name'] });
    }
    if (busy) return reply.code(409).send({ errors: ['another fetch is already running'] });

    busy = true;
    seq += 1;
    const job: Job = { id: `j${seq}`, state: 'running', progress: 0 };
    jobs.set(job.id, job);
    while (jobs.size > MAX_JOBS) {
      const oldest = jobs.keys().next().value;
      if (oldest === undefined) break;
      jobs.delete(oldest);
    }
    deps.logChange?.(actorOf(request), 'islamic.fetch', task.what === 'quran' ? 'quran' : `audio ${reciter} ${task.surah}`);

    const fetchImpl = deps.fetchImpl ?? guardedFetch();
    const onProgress = (done: number, total: number): void => {
      job.progress = total > 0 ? done / total : 0;
    };
    void (async () => {
      try {
        if (task.what === 'quran') {
          saveQuran(dataDir, await fetchQuranEnc(fetchImpl, undefined, onProgress, deps.getSourceUrls?.().quranText));
        } else {
          const count = AYAT_COUNTS[task.surah - 1] ?? 0;
          await fetchEveryAyahSurah(fetchImpl, dataDir, reciter, task.surah, count, onProgress, {
            cacheMaxMb: deps.getCacheMaxMb(),
            sourceUrl: deps.getSourceUrls?.().quranAudio,
          });
        }
        job.state = 'done';
        job.progress = 1;
      } catch (err) {
        job.state = 'failed';
        job.error = err instanceof Error ? err.message.slice(0, 300) : 'fetch failed';
      } finally {
        busy = false;
      }
    })();
    return reply.code(202).send({ jobId: job.id });
  });

  app.get('/api/islamic/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = jobs.get(id);
    if (!job) return reply.code(404).send({ errors: ['unknown job'] });
    return job.error === undefined
      ? { state: job.state, progress: job.progress }
      : { state: job.state, progress: job.progress, error: job.error };
  });

  app.get('/islamic/audio/:reciter/:surah/:file', async (request, reply) => {
    const { reciter, surah, file } = request.params as { reciter: string; surah: string; file: string };
    const fm = FILE_RE.exec(file);
    if (!RECITER_RE.test(reciter) || !SURAH_RE.test(surah) || !fm) return reply.code(404).send({ errors: ['not found'] });
    const aya = Number(fm[1]);
    if (aya < 1 || aya > (AYAT_COUNTS[Number(surah) - 1] ?? 0)) return reply.code(404).send({ errors: ['not found'] });
    const path = join(audioRoot(dataDir), reciter, surah, `${String(aya).padStart(3, '0')}.mp3`);
    let size: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) throw new Error('not a file');
      size = st.size;
    } catch {
      return reply.code(404).send({ errors: ['not found'] });
    }
    const range = parseRange(request.headers.range, size);
    reply.header('content-type', 'audio/mpeg').header('cache-control', IMMUTABLE).header('accept-ranges', 'bytes');
    if (range === 'bad') {
      return reply.code(416).header('content-range', `bytes */${size}`).send();
    }
    if (range) {
      return reply
        .code(206)
        .header('content-range', `bytes ${range.start}-${range.end}/${size}`)
        .header('content-length', range.end - range.start + 1)
        .send(createReadStream(path, { start: range.start, end: range.end }));
    }
    return reply.header('content-length', size).send(createReadStream(path));
  });
}
