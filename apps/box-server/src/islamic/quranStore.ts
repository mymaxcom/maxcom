import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AyatCard } from '@surau/core';

export const QURAN_KEY = 'malay_basumayyah';
export const QURAN_TOTAL_AYAT = 6236;

/** Ayat count per surah (index 0 = surah 1). Matches EveryAyah's ayahCount table. */
export const AYAT_COUNTS: readonly number[] = [
  7, 286, 200, 176, 120, 165, 206, 75, 129, 109, 123, 111, 43, 52, 99, 128, 111, 110, 98, 135,
  112, 78, 118, 64, 77, 227, 93, 88, 69, 60, 34, 30, 73, 54, 45, 83, 182, 88, 75, 85,
  54, 53, 89, 59, 37, 35, 38, 29, 18, 45, 60, 49, 62, 55, 78, 96, 29, 22, 24, 13,
  14, 11, 11, 18, 12, 12, 30, 52, 52, 44, 28, 28, 20, 56, 40, 31, 50, 40, 46, 42,
  29, 19, 36, 25, 22, 17, 19, 26, 30, 20, 15, 21, 11, 8, 8, 19, 5, 8, 8, 11,
  11, 8, 3, 9, 5, 4, 7, 3, 6, 3, 5, 4, 5, 6,
];

/** Surah names: Arabic and Malay (Malaysian transliteration). Index 0 = surah 1. */
export const SURAH_NAMES: readonly (readonly [string, string])[] = [
  ['الفاتحة', 'Al-Fatihah'], ['البقرة', 'Al-Baqarah'], ['آل عمران', "Ali 'Imran"],
  ['النساء', "An-Nisa'"], ['المائدة', "Al-Ma'idah"], ['الأنعام', "Al-An'am"],
  ['الأعراف', "Al-A'raf"], ['الأنفال', 'Al-Anfal'], ['التوبة', 'At-Taubah'],
  ['يونس', 'Yunus'], ['هود', 'Hud'], ['يوسف', 'Yusuf'],
  ['الرعد', "Ar-Ra'd"], ['إبراهيم', 'Ibrahim'], ['الحجر', 'Al-Hijr'],
  ['النحل', 'An-Nahl'], ['الإسراء', "Al-Isra'"], ['الكهف', 'Al-Kahfi'],
  ['مريم', 'Maryam'], ['طه', 'Taha'], ['الأنبياء', "Al-Anbiya'"],
  ['الحج', 'Al-Hajj'], ['المؤمنون', "Al-Mu'minun"], ['النور', 'An-Nur'],
  ['الفرقان', 'Al-Furqan'], ['الشعراء', "Asy-Syu'ara'"], ['النمل', 'An-Naml'],
  ['القصص', 'Al-Qasas'], ['العنكبوت', "Al-'Ankabut"], ['الروم', 'Ar-Rum'],
  ['لقمان', 'Luqman'], ['السجدة', 'As-Sajdah'], ['الأحزاب', 'Al-Ahzab'],
  ['سبأ', "Saba'"], ['فاطر', 'Fatir'], ['يس', 'Yasin'],
  ['الصافات', 'As-Saffat'], ['ص', 'Sad'], ['الزمر', 'Az-Zumar'],
  ['غافر', 'Ghafir'], ['فصلت', 'Fussilat'], ['الشورى', 'Asy-Syura'],
  ['الزخرف', 'Az-Zukhruf'], ['الدخان', 'Ad-Dukhan'], ['الجاثية', 'Al-Jasiyah'],
  ['الأحقاف', 'Al-Ahqaf'], ['محمد', 'Muhammad'], ['الفتح', 'Al-Fath'],
  ['الحجرات', 'Al-Hujurat'], ['ق', 'Qaf'], ['الذاريات', 'Az-Zariyat'],
  ['الطور', 'At-Tur'], ['النجم', 'An-Najm'], ['القمر', 'Al-Qamar'],
  ['الرحمن', 'Ar-Rahman'], ['الواقعة', "Al-Waqi'ah"], ['الحديد', 'Al-Hadid'],
  ['المجادلة', 'Al-Mujadalah'], ['الحشر', 'Al-Hasyr'], ['الممتحنة', 'Al-Mumtahanah'],
  ['الصف', 'As-Saff'], ['الجمعة', "Al-Jumu'ah"], ['المنافقون', 'Al-Munafiqun'],
  ['التغابن', 'At-Taghabun'], ['الطلاق', 'At-Talaq'], ['التحريم', 'At-Tahrim'],
  ['الملك', 'Al-Mulk'], ['القلم', 'Al-Qalam'], ['الحاقة', 'Al-Haqqah'],
  ['المعارج', "Al-Ma'arij"], ['نوح', 'Nuh'], ['الجن', 'Al-Jinn'],
  ['المزمل', 'Al-Muzzammil'], ['المدثر', 'Al-Muddaththir'], ['القيامة', 'Al-Qiyamah'],
  ['الإنسان', 'Al-Insan'], ['المرسلات', 'Al-Mursalat'], ['النبأ', "An-Naba'"],
  ['النازعات', "An-Nazi'at"], ['عبس', "'Abasa"], ['التكوير', 'At-Takwir'],
  ['الانفطار', 'Al-Infitar'], ['المطففين', 'Al-Mutaffifin'], ['الانشقاق', 'Al-Insyiqaq'],
  ['البروج', 'Al-Buruj'], ['الطارق', 'At-Tariq'], ['الأعلى', "Al-A'la"],
  ['الغاشية', 'Al-Ghasyiyah'], ['الفجر', 'Al-Fajr'], ['البلد', 'Al-Balad'],
  ['الشمس', 'Asy-Syams'], ['الليل', 'Al-Lail'], ['الضحى', 'Ad-Duha'],
  ['الشرح', 'Asy-Syarh'], ['التين', 'At-Tin'], ['العلق', "Al-'Alaq"],
  ['القدر', 'Al-Qadr'], ['البينة', 'Al-Bayyinah'], ['الزلزلة', 'Az-Zalzalah'],
  ['العاديات', "Al-'Adiyat"], ['القارعة', "Al-Qari'ah"], ['التكاثر', 'At-Takathur'],
  ['العصر', "Al-'Asr"], ['الهمزة', 'Al-Humazah'], ['الفيل', 'Al-Fil'],
  ['قريش', 'Quraisy'], ['الماعون', "Al-Ma'un"], ['الكوثر', 'Al-Kauthar'],
  ['الكافرون', 'Al-Kafirun'], ['النصر', 'An-Nasr'], ['المسد', 'Al-Masad'],
  ['الإخلاص', 'Al-Ikhlas'], ['الفلق', 'Al-Falaq'], ['الناس', 'An-Nas'],
];

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

/** Well-known ranges, indexed by day of year for pick 'daily' (surah, from, to). */
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

function dayOfYear(date: string): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`invalid date "${date}"`);
  const y = Number(m[1]);
  const t = Date.UTC(y, Number(m[2]) - 1, Number(m[3]));
  return Math.floor((t - Date.UTC(y, 0, 1)) / 86_400_000) + 1;
}

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

/** The ayat card for a KL date; null when the needed text is not cached. */
export function ayatForDay(q: QuranText, settings: AyatSettings, date: string): AyatCard | null {
  let range: readonly [number, number, number];
  if (settings.pick === 'manual') {
    range = [settings.surah, settings.ayatFrom, settings.ayatTo];
  } else if (settings.pick === 'daily') {
    const picked = DAILY_RANGES[(dayOfYear(date) - 1) % DAILY_RANGES.length];
    if (!picked) return null;
    range = picked;
  } else {
    const n = Math.floor(seededUnit(date) * QURAN_TOTAL_AYAT);
    const [s, a] = locate(n);
    range = [s, a, a];
  }
  const [surah, from, to] = range;
  const count = ayatCountOf(surah);
  if (count === 0 || from > count) return null;
  try {
    return getAyat(q, surah, from, Math.max(from, Math.min(to, count)));
  } catch {
    return null;
  }
}
