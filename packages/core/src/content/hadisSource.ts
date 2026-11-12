/** Hadis provider facts: grade and attribution tables (Arabic from HadeethEnc to Bahasa Malaysia), length class, ids. Pure, browser-safe. */

import categoriesMs from './hadisCategoriesMs.json' with { type: 'json' };
import type { HadisGrade } from './types.ts';

/** `source` of an own-list hadis the importer could not attribute; the TV omits the attribution line for it. */
export const UNSTATED_SOURCE = 'Tidak dinyatakan';
/** Live (not deleted) hadis the box keeps, both sources together. */
export const HADIS_MAX_SAVED = 500;

export interface GradeRow {
  ar: string;
  key: HadisGrade;
  ms: string;
  note: string;
  /** False for the two grades that can never be shown on the TV. */
  allowed: boolean;
}

export const HADIS_GRADES: readonly GradeRow[] = [
  { ar: 'صحيح', key: 'sahih', ms: 'Sahih', note: 'Darjat tertinggi', allowed: true },
  { ar: 'حسن', key: 'hasan', ms: 'Hasan', note: 'Diterima sebagai hujah', allowed: true },
  { ar: 'صحيح لغيره', key: 'sahih_lighairihi', ms: 'Sahih li ghairihi', note: 'Sahih kerana sokongan riwayat lain', allowed: true },
  { ar: 'حسن لغيره', key: 'hasan_lighairihi', ms: 'Hasan li ghairihi', note: 'Hasan kerana sokongan riwayat lain', allowed: true },
  { ar: 'ضعيف', key: 'dhaif', ms: 'Dhaif', note: 'Lemah; tidak dipaparkan', allowed: false },
  { ar: 'موضوع', key: 'maudhu', ms: 'Palsu (maudhu)', note: 'Tidak sekali-kali dipaparkan', allowed: false },
];

/** Remove tatweel and Arabic diacritics, fold alef/ya/ta marbuta variants, collapse spaces. */
function foldAr(s: string): string {
  return s
    .replace(/[ـً-ٰٟ]/g, '')
    .replace(/[آأإ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim();
}

const GRADE_BY_AR = new Map<string, HadisGrade>(HADIS_GRADES.map((g) => [foldAr(g.ar), g.key]));

/** Grade key for HadeethEnc's Arabic grade text, or null when it is not one of the six known texts. */
export function gradeOf(ar: string): HadisGrade | null {
  if (typeof ar !== 'string') return null;
  return GRADE_BY_AR.get(foldAr(ar)) ?? null;
}

/** BM label of a grade key (`Sahih`, `Palsu (maudhu)`...), or the key itself when unknown. */
export function gradeLabelMs(key: string): string {
  return HADIS_GRADES.find((g) => g.key === key)?.ms ?? key;
}

/** True when the grade may be shown on the TV: known, not locked off, and switched on in `allowed`. */
export function gradeAllowed(grade: HadisGrade | null, allowed: Record<string, boolean>): boolean {
  if (grade === null) return false;
  const row = HADIS_GRADES.find((g) => g.key === grade);
  if (!row || !row.allowed) return false;
  return allowed[grade] === true;
}

/** Kitab names as HadeethEnc writes them (folded Arabic) mapped to their BM form. */
const NARRATORS: readonly (readonly [string, string])[] = [
  ['البخاري', 'al-Bukhari'],
  ['مسلم', 'Muslim'],
  ['أبو داود', 'Abu Daud'],
  ['الترمذي', 'al-Tirmizi'],
  ['النسائي', 'al-Nasai'],
  ['ابن ماجه', 'Ibnu Majah'],
  ['أحمد', 'Ahmad'],
  ['مالك', 'Malik'],
  ['الدارمي', 'al-Darimi'],
  ['ابن حبان', 'Ibnu Hibban'],
  ['الحاكم', 'al-Hakim'],
  ['البيهقي', 'al-Baihaqi'],
  ['الطبراني', 'al-Tabarani'],
];
const NARRATOR_BY_AR = new Map<string, string>(NARRATORS.map(([ar, ms]) => [foldAr(ar), ms]));
const MUTTAFAQ_AR = new Set([foldAr('متفق عليه'), foldAr('رواه البخاري ومسلم'), foldAr('رواه البخاري و مسلم')]);

function joinNames(names: string[]): string {
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} dan ${names[names.length - 1]!}`;
}

/**
 * BM form of HadeethEnc's Arabic attribution. `رواه البخاري ومسلم` is Muttafaq alaih (with the long form);
 * `رواه X وY وZ` becomes `Riwayat X, Y dan Z`. Null when any name is not in the table.
 */
export function attributionOf(ar: string): { short: string; long: string | null } | null {
  if (typeof ar !== 'string') return null;
  const s = foldAr(ar);
  if (s === '') return null;
  if (MUTTAFAQ_AR.has(s)) return { short: 'Muttafaq alaih', long: 'Riwayat al-Bukhari dan Muslim' };
  const m = /^رواه (.+)$/.exec(s);
  if (!m) return null;
  const parts = m[1]!
    .replace(/\s*[،,]\s*/g, '|')
    .replace(/\s+و\s+/g, '|')
    .replace(/\s+و(?=\S)/g, '|')
    .split('|')
    .map((x) => x.trim())
    .filter((x) => x !== '');
  if (parts.length === 0) return null;
  const names: string[] = [];
  for (const p of parts) {
    const n = NARRATOR_BY_AR.get(p);
    if (n === undefined) return null;
    names.push(n);
  }
  if (names.length === 2 && names[0] === 'al-Bukhari' && names[1] === 'Muslim') {
    return { short: 'Muttafaq alaih', long: 'Riwayat al-Bukhari dan Muslim' };
  }
  return { short: `Riwayat ${joinNames(names)}`, long: null };
}

/** Pendek <= 220 characters, Sederhana <= 520, else Panjang. */
export function hadisLength(textMs: string): 'short' | 'medium' | 'long' {
  const n = typeof textMs === 'string' ? textMs.length : 0;
  return n <= 220 ? 'short' : n <= 520 ? 'medium' : 'long';
}

export function providerItemId(provider: 'hadeethenc', id: string): string {
  return `${provider}-${id}`;
}

const CATEGORY_MS = new Map<string, string>((categoriesMs as { id: string; ms: string }[]).map((c) => [c.id, c.ms]));

/** BM name of a HadeethEnc category id (the API itself answers English), or null when the table lacks it. */
export function hadisCategoryMs(id: string): string | null {
  return CATEGORY_MS.get(id) ?? null;
}
