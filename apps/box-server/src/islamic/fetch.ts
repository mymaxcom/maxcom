import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AYAT_COUNTS,
  QURAN_KEY,
  QURAN_TOTAL_AYAT,
  SURAH_NAMES,
} from './quranStore.ts';
import type { QuranAyah, QuranText } from './quranStore.ts';
import { assertSourceUrl, DEFAULT_SOURCE_URLS } from '../net/safeFetch.ts';
import { readCapped } from '../net/readCapped.ts';

const baseOf = (url: string, what: string): string => {
  assertSourceUrl(url, what);
  return url.replace(/\/+$/, '');
};
const TIMEOUT_MS = 20_000;
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const KEY_RE = /^[a-z0-9_]{3,64}$/;
const RECITER_RE = /^[A-Za-z0-9_]{3,64}$/;
const DEFAULT_TITLE = 'Terjemahan Al-Quran oleh Abdullah Muhammad Basmeih (QuranEnc)';

type FetchImpl = typeof fetch;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Redirects are refused outright: the two sources answer directly, and a redirect would let a
// hijacked host steer the box to an arbitrary URL.
const requestInit = (): RequestInit => ({ signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });

async function getText(fetchImpl: FetchImpl, url: string, maxBytes: number): Promise<string> {
  const res = await fetchImpl(url, requestInit());
  if (!res.ok) throw new Error(`request failed with HTTP ${res.status}`);
  return new TextDecoder().decode(await readCapped(res, maxBytes, 'response'));
}

async function getBytes(fetchImpl: FetchImpl, url: string): Promise<Uint8Array> {
  const res = await fetchImpl(url, requestInit());
  if (!res.ok) throw new Error(`request failed with HTTP ${res.status}`);
  const buf = await readCapped(res, MAX_AUDIO_BYTES, 'audio response');
  if (buf.length === 0) throw new Error('empty audio response');
  const mpeg = (buf[0] === 0xff && ((buf[1] ?? 0) & 0xe0) === 0xe0) || (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33);
  if (!mpeg) throw new Error('audio response is not an MP3 file');
  return buf;
}

/** Only line ends are normalised; the text is otherwise stored exactly as served. */
const verbatim = (s: string): string => s.replace(/\r\n?/g, '\n');

function parseRows(surah: number, json: unknown): QuranAyah[] {
  const result = isObj(json) ? json.result : undefined;
  if (!Array.isArray(result)) throw new Error(`QuranEnc surah ${surah}: unexpected response shape`);
  const rows: QuranAyah[] = [];
  for (const row of result) {
    if (!isObj(row)) throw new Error(`QuranEnc surah ${surah}: unexpected row`);
    const aya = Number(row.aya);
    if (!Number.isInteger(aya) || aya < 1) {
      throw new Error(`QuranEnc surah ${surah}: unexpected row numbering`);
    }
    if (typeof row.arabic_text !== 'string' || typeof row.translation !== 'string') {
      throw new Error(`QuranEnc surah ${surah}:${aya}: missing text`);
    }
    rows.push({ aya, arabic: verbatim(row.arabic_text), translation: verbatim(row.translation) });
  }
  rows.sort((a, b) => a.aya - b.aya);
  return rows;
}

async function lookupVersion(fetchImpl: FetchImpl, base: string, key: string): Promise<{ version: string; title: string }> {
  try {
    const json: unknown = JSON.parse(await getText(fetchImpl, `${base}/translations/list`, MAX_TEXT_BYTES));
    const list = isObj(json) && Array.isArray(json.translations) ? json.translations : [];
    for (const entry of list) {
      if (isObj(entry) && entry.key === key && typeof entry.version === 'string') {
        return { version: entry.version, title: typeof entry.title === 'string' ? entry.title : DEFAULT_TITLE };
      }
    }
  } catch {
    // The list is informational; the text itself is what matters.
  }
  return { version: 'unlisted', title: DEFAULT_TITLE };
}

/**
 * Downloads the whole translation (114 surahs) and checks it is complete before returning.
 * `onProgress` receives (surahsDone, 114).
 */
export async function fetchQuranEnc(
  fetchImpl: FetchImpl,
  key: string = QURAN_KEY,
  onProgress?: (done: number, total: number) => void,
  /** `dataSources.quranText.url`; the QuranEnc default when absent. */
  sourceUrl: string = DEFAULT_SOURCE_URLS.quranText,
): Promise<QuranText> {
  if (!KEY_RE.test(key)) throw new Error(`invalid translation key "${key}"`);
  const base = baseOf(sourceUrl, 'Quran text');
  const surahs: QuranText['surahs'] = {};
  let total = 0;
  const problems: string[] = [];
  for (let n = 1; n <= 114; n += 1) {
    const json: unknown = JSON.parse(await getText(fetchImpl, `${base}/translation/sura/${key}/${n}`, MAX_TEXT_BYTES));
    const ayat = parseRows(n, json);
    const expected = AYAT_COUNTS[n - 1] ?? 0;
    const contiguous = ayat.every((a, i) => a.aya === i + 1);
    if (ayat.length !== expected || !contiguous) problems.push(`${n}:${ayat.length}/${expected}`);
    const names = SURAH_NAMES[n - 1] ?? ['', ''];
    surahs[n] = { nameAr: names[0], nameMs: names[1], ayat };
    total += ayat.length;
    onProgress?.(n, 114);
  }
  if (total !== QURAN_TOTAL_AYAT || problems.length > 0) {
    throw new Error(
      `QuranEnc text is incomplete: ${total} of ${QURAN_TOTAL_AYAT} ayat (surahs short: ${problems.slice(0, 8).join(', ')})`,
    );
  }
  const meta = await lookupVersion(fetchImpl, base, key);
  return { key, title: meta.title, version: meta.version, fetchedAt: new Date().toISOString(), surahs };
}

const pad3 = (n: number): string => String(n).padStart(3, '0');

export const audioRoot = (dataDir: string): string => join(dataDir, 'islamic', 'audio');

/** Total bytes of every .mp3 below the audio cache (all reciters). */
export function audioCacheBytes(dataDir: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.mp3')) total += statSync(p).size;
    }
  };
  walk(audioRoot(dataDir));
  return total;
}

export interface AudioIndex {
  reciter: string;
  reciterName: string;
  surah: number;
  ayatCount: number;
  bytes: number;
  fetchedAt: string;
}

export function readAudioIndex(dataDir: string, reciter: string, surah: number): AudioIndex | null {
  try {
    const v: unknown = JSON.parse(readFileSync(join(audioRoot(dataDir), reciter, String(surah), 'index.json'), 'utf8'));
    if (
      isObj(v) && v.reciter === reciter && v.surah === surah && typeof v.reciterName === 'string' &&
      typeof v.ayatCount === 'number' && typeof v.bytes === 'number' && typeof v.fetchedAt === 'string'
    ) {
      return v as unknown as AudioIndex;
    }
  } catch {
    // absent or unreadable index
  }
  return null;
}

async function reciterDisplayName(fetchImpl: FetchImpl, base: string, reciter: string): Promise<string> {
  try {
    const json: unknown = JSON.parse(await getText(fetchImpl, `${base}/recitations.js`, MAX_TEXT_BYTES));
    if (isObj(json)) {
      for (const entry of Object.values(json)) {
        if (isObj(entry) && entry.subfolder === reciter && typeof entry.name === 'string') return entry.name;
      }
    }
  } catch {
    // fall back to the folder name
  }
  return reciter;
}

function writeAtomic(file: string, data: Uint8Array | string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export interface AudioFetchOptions {
  /** `tilawah.cacheMaxMb`; default 300. */
  cacheMaxMb?: number;
  /** `dataSources.quranAudio.url`; the EveryAyah default when absent. */
  sourceUrl?: string;
}

/**
 * Caches one surah of one reciter below `<dataDir>/islamic/audio/<reciter>/<surah>/`.
 * Resumable (existing files are skipped); refuses before writing when the projected
 * cache size would exceed `cacheMaxMb`.
 */
export async function fetchEveryAyahSurah(
  fetchImpl: FetchImpl,
  dataDir: string,
  reciter: string,
  surah: number,
  ayatCount: number,
  onProgress?: (done: number, total: number) => void,
  options: AudioFetchOptions = {},
): Promise<{ bytes: number }> {
  if (!RECITER_RE.test(reciter)) throw new Error(`invalid reciter "${reciter}"`);
  if (!Number.isInteger(surah) || surah < 1 || surah > 114) throw new Error(`invalid surah ${surah}`);
  if (ayatCount !== AYAT_COUNTS[surah - 1]) throw new Error(`surah ${surah} has ${AYAT_COUNTS[surah - 1]} ayat, not ${ayatCount}`);
  const capBytes = (options.cacheMaxMb ?? 300) * 1024 * 1024;
  const base = baseOf(options.sourceUrl ?? DEFAULT_SOURCE_URLS.quranAudio, 'Quran audio');

  const dir = join(audioRoot(dataDir), reciter, String(surah));
  const fileOf = (aya: number): string => join(dir, `${pad3(aya)}.mp3`);
  const sizeOf = (aya: number): number => {
    try {
      return statSync(fileOf(aya)).size;
    } catch {
      return 0;
    }
  };

  const missing: number[] = [];
  let have = 0;
  for (let aya = 1; aya <= ayatCount; aya += 1) {
    const s = sizeOf(aya);
    if (s > 0) have += s;
    else missing.push(aya);
  }
  const prior = readAudioIndex(dataDir, reciter, surah);
  if (missing.length === 0 && prior) {
    onProgress?.(ayatCount, ayatCount);
    return { bytes: have };
  }

  const urlOf = (aya: number): string => `${base}/${reciter}/${pad3(surah)}${pad3(aya)}.mp3`;
  let cursor = 0;
  let firstBytes: Uint8Array | null = null;
  const firstAya = missing[0];
  if (firstAya !== undefined) {
    firstBytes = await getBytes(fetchImpl, urlOf(firstAya));
    const projected = audioCacheBytes(dataDir) + firstBytes.length * missing.length;
    if (projected > capBytes) {
      throw new Error(
        `audio cache would reach about ${Math.ceil(projected / 1048576)} MB, above tilawah.cacheMaxMb ${options.cacheMaxMb ?? 300}`,
      );
    }
  }

  mkdirSync(dir, { recursive: true });
  let bytes = have;
  let cacheNow = audioCacheBytes(dataDir);
  onProgress?.(ayatCount - missing.length, ayatCount);
  for (const aya of missing) {
    let data: Uint8Array;
    if (aya === firstAya && firstBytes) {
      data = firstBytes;
    } else {
      try {
        data = await getBytes(fetchImpl, urlOf(aya));
      } catch {
        data = await getBytes(fetchImpl, urlOf(aya)); // one retry
      }
    }
    if (cacheNow + data.length > capBytes) {
      throw new Error(`audio cache reached tilawah.cacheMaxMb ${options.cacheMaxMb ?? 300}; fetch stopped (resumable)`);
    }
    writeAtomic(fileOf(aya), data);
    cacheNow += data.length;
    bytes += data.length;
    cursor += 1;
    onProgress?.(ayatCount - missing.length + cursor, ayatCount);
  }

  const reciterName = prior?.reciterName ?? (await reciterDisplayName(fetchImpl, base, reciter));
  const index: AudioIndex = { reciter, reciterName, surah, ayatCount, bytes, fetchedAt: new Date().toISOString() };
  writeAtomic(join(dir, 'index.json'), JSON.stringify(index));
  return { bytes };
}
