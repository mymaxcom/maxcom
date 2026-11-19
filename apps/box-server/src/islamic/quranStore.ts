import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AYAT_MAX_AT_ONCE, SURAHS } from '@surau/core';
import type { AyatCard } from '@surau/core';

export const QURAN_KEY = 'malay_basumayyah';
export const QURAN_TOTAL_AYAT = 6236;

/** Ayat count per surah (index 0 = surah 1), from the one core surah table. */
export const AYAT_COUNTS: readonly number[] = SURAHS.map((s) => s.ayat);

/** Surah names: Arabic and Malay (Malaysian transliteration), from the one core table. Index 0 = surah 1. */
export const SURAH_NAMES: readonly (readonly [string, string])[] = SURAHS.map((s) => [s.nameAr, s.nameMs] as const);

export interface QuranAyah {
  aya: number;
  arabic: string;
  translation: string;
}

export interface QuranSurah {
  nameAr: string;
  nameMs: string;
  ayat: QuranAyah[];
}

export interface QuranText {
  key: string;
  title: string;
  version: string;
  fetchedAt: string;
  surahs: Record<number, QuranSurah>;
}

export interface AyatSettings {
  pick: 'daily' | 'random' | 'manual';
  surah: number;
  ayatFrom: number;
  ayatTo: number;
}

/** Longest range the card shows; the card pages longer ranges itself. */
export const MAX_CARD_AYAT = 8;

/**
 * Pick 'daily' (Pilihan harian): the Quran read in order, one chunk a day. A chunk is up to AYAT_MAX_AT_ONCE (3) verses
 * and never crosses the end of a surah, so a surah's last chunk can be 1 or 2 verses: Al-Fatihah 1-3, 4-6, 7, then
 * Al-Baqarah 1-3, ... to An-Nas, then Al-Fatihah again. Entries are [surah, from, to].
 */
export const DAILY_CHUNKS: readonly (readonly [number, number, number])[] = (() => {
  const out: (readonly [number, number, number])[] = [];
  AYAT_COUNTS.forEach((count, i) => {
    for (let from = 1; from <= count; from += AYAT_MAX_AT_ONCE) out.push([i + 1, from, Math.min(count, from + AYAT_MAX_AT_ONCE - 1)] as const);
  });
  return out;
})();

/** Whole KL-calendar days from `anchor` to `date` (both YYYY-MM-DD); negative when `date` is earlier. */
export function daysBetween(anchor: string, date: string): number {
  const at = (d: string): number => {
    const m = DATE_RE.exec(d);
    if (!m) throw new Error(`invalid date "${d}"`);
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  };
  return Math.round((at(date) - at(anchor)) / 86_400_000);
}

/** The daily chunk of `date` when the reading started on `anchor` (day 0 = Al-Fatihah 1-3); wraps after An-Nas. */
export function dailyChunk(anchor: string, date: string): readonly [number, number, number] {
  const n = DAILY_CHUNKS.length;
  const i = ((daysBetween(anchor, date) % n) + n) % n;
  return DAILY_CHUNKS[i]!;
}

/** Well-known ranges (surah, from, to): the curated list the daily pick used before 2026.11.13 (kept for reference). */
export const DAILY_RANGES: readonly (readonly [number, number, number])[] = [
  [1, 1, 7], [2, 255, 255], [2, 285, 286], [2, 152, 152], [2, 153, 153], [2, 186, 186],
  [2, 201, 201], [2, 216, 216], [3, 8, 9], [3, 26, 27], [3, 103, 103], [3, 133, 134],
  [3, 190, 191], [4, 36, 36], [4, 58, 58], [5, 2, 2], [7, 56, 56], [7, 199, 199],
  [8, 46, 46], [9, 128, 129], [10, 57, 58], [11, 114, 114], [13, 28, 28], [14, 7, 7],
  [16, 90, 90], [16, 125, 125], [17, 23, 24], [17, 80, 81], [18, 10, 10], [18, 46, 46],
  [20, 25, 28], [21, 87, 88], [23, 1, 9], [24, 35, 35], [25, 63, 65], [29, 45, 45],
  [31, 13, 14], [33, 56, 56], [36, 58, 58], [39, 53, 53], [40, 60, 60], [41, 30, 31],
  [42, 38, 38], [49, 10, 10], [49, 13, 13], [55, 1, 4], [57, 3, 3], [59, 22, 24],
  [62, 9, 10], [64, 16, 16], [65, 2, 3], [67, 1, 2], [93, 1, 8], [94, 1, 8],
  [99, 7, 8], [103, 1, 3], [108, 1, 3], [109, 1, 6], [112, 1, 4], [114, 1, 6],
];

export const ayatCountOf = (surah: number): number => AYAT_COUNTS[surah - 1] ?? 0;

export const quranFilePath = (dataDir: string, key: string = QURAN_KEY): string =>
  join(dataDir, 'islamic', 'quran', `${key}.json`);

/** Writes the Quran text atomically (temp file, then rename). */
export function saveQuran(dataDir: string, quran: QuranText): string {
  const file = quranFilePath(dataDir, quran.key);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(quran));
  renameSync(tmp, file);
  return file;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function isQuranText(v: unknown): v is QuranText {
  if (!isObj(v)) return false;
  return (
    typeof v.key === 'string' &&
    typeof v.title === 'string' &&
    typeof v.version === 'string' &&
    typeof v.fetchedAt === 'string' &&
    isObj(v.surahs)
  );
}

/** Reads the cached Quran text; null when absent or unreadable. */
export function loadQuran(dataDir: string, key: string = QURAN_KEY): QuranText | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(quranFilePath(dataDir, key), 'utf8'));
    return isQuranText(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function quranFileStat(dataDir: string, key: string = QURAN_KEY): { mtimeMs: number; size: number } | null {
  try {
    const st = statSync(quranFilePath(dataDir, key));
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

export function countAyat(q: QuranText): number {
  let total = 0;
  for (const s of Object.values(q.surahs)) total += s.ayat.length;
  return total;
}

/**
 * Returns the ayat from..to of a surah. The range is clamped to the surah and cut to
 * MAX_CARD_AYAT; throws when the surah or the starting ayah is not in the cache.
 */
export function getAyat(q: QuranText, surah: number, from: number, to: number): AyatCard {
  const s = q.surahs[surah];
  if (!s) throw new Error(`surah ${surah} is not in the Quran cache`);
  const first = Math.max(1, Math.trunc(from));
  const last = Math.min(Math.trunc(to), first + MAX_CARD_AYAT - 1);
  const rows = s.ayat.filter((a) => a.aya >= first && a.aya <= last);
  const head = rows[0];
  const tail = rows[rows.length - 1];
  if (!head || !tail) throw new Error(`ayat ${surah}:${first}-${last} are not in the Quran cache`);
  return {
    surah,
    surahNameAr: s.nameAr,
    surahNameMs: s.nameMs,
    ayatFrom: head.aya,
    ayatTo: tail.aya,
    arabic: rows.map((a) => a.arabic),
    malay: rows.map((a) => a.translation),
    translationVersion: q.version,
  };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** FNV-1a then mulberry32: a small deterministic PRNG seeded by the date string. */
function seededUnit(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let t = (h + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Surah and ayah number of the n-th ayah (0-based) of the whole Quran. */
function locate(n: number): [number, number] {
  let rest = n;
  for (let i = 0; i < AYAT_COUNTS.length; i += 1) {
    const c = AYAT_COUNTS[i] ?? 0;
    if (rest < c) return [i + 1, rest + 1];
    rest -= c;
  }
  return [1, 1];
}

/**
 * The ayat card for a KL date; null when the needed text is not cached. `dailyAnchor` (YYYY-MM-DD) is the day the
 * daily reading started (day 0 shows Al-Fatihah 1-3); the box keeps it once, so the card is the same all day and
 * carries on across restarts.
 */
export function ayatForDay(q: QuranText, settings: AyatSettings, date: string, dailyAnchor: string = date): AyatCard | null {
  let range: readonly [number, number, number];
  if (settings.pick === 'manual') {
    range = [settings.surah, settings.ayatFrom, settings.ayatTo];
  } else if (settings.pick === 'daily') {
    range = dailyChunk(dailyAnchor, date);
  } else {
    const n = Math.floor(seededUnit(date) * QURAN_TOTAL_AYAT);
    const [s, a] = locate(n);
    range = [s, a, a];
  }
  const [surah, from, to] = range;
  const count = ayatCountOf(surah);
  if (count === 0 || from > count) return null;
  try {
    // At most AYAT_MAX_AT_ONCE verses: a longer curated passage or an old stored range shows its first verses.
    return getAyat(q, surah, from, Math.max(from, Math.min(to, count, from + AYAT_MAX_AT_ONCE - 1)));
  } catch {
    return null;
  }
}
