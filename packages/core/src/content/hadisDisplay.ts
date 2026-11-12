/** What the TV shows for a hadis: size tier, parts of a long text, and today's pool. Pure, browser-safe. */

import { gradeAllowed } from './hadisSource.ts';
import type { HadisSettings } from '../features/registry.ts';
import type { Hadis } from './types.ts';

/** Text width inside the wide card (rem) and the room left for Arabic + Malay once tag and source are placed. */
const LINE_REM = 88;
const BLOCK_REM = 13.4;
/** Average advance per letter (em) measured on the preview: Amiri Quran ~0.45, Plus Jakarta Sans ~0.47. */
const AR_EM = 0.45;
const MS_EM = 0.47;

export type HadisTierKey = 'l' | 'm' | 's';
/** Type sizes per tier (rem) and the lines each may take; the CSS clamps to the same numbers. */
const TIERS: { len: HadisTierKey; arFs: number; arLines: number; msFs: number; msLines: number }[] = [
  { len: 'l', arFs: 2.5, arLines: 1, msFs: 1.8, msLines: 2 },
  { len: 'm', arFs: 2.05, arLines: 2, msFs: 1.5, msLines: 3 },
  { len: 's', arFs: 1.75, arLines: 2, msFs: 1.3, msLines: 4 },
];
const AR_LH = 1.75;
const MS_LH = 1.3;

const letters = (s: string): number => {
  let n = 0;
  for (const ch of s) if (/\p{L}/u.test(ch)) n++;
  return n;
};

/**
 * Largest tier, starting at `from` (default the largest), whose estimated lines fit the block.
 * Null when even the smallest does not fit: the text then goes to parts.
 */
export function hadisTier(textMs: string, textAr: string | undefined, from: HadisTierKey = 'l'): HadisTierKey | null {
  const start = TIERS.findIndex((t) => t.len === from);
  for (const tier of TIERS.slice(start < 0 ? 0 : start)) {
    const arLines = textAr ? Math.ceil((letters(textAr) * AR_EM * tier.arFs) / LINE_REM) : 0;
    const msLines = Math.ceil((textMs.length * MS_EM * tier.msFs) / LINE_REM);
    if (arLines > tier.arLines || msLines > tier.msLines) continue;
    const height = arLines * tier.arFs * AR_LH + (arLines ? 0.6 : 0) + msLines * tier.msFs * MS_LH;
    if (height <= BLOCK_REM) return tier.len;
  }
  return null;
}

/** Splits the opening `Daripada ... bersabda:` sentence off when `textMs` starts with it. */
export function hadisDisplayText(h: { textMs: string; intro?: string }): { body: string; intro: string | null } {
  const intro = h.intro?.trim();
  if (intro && h.textMs.startsWith(intro)) {
    const body = h.textMs.slice(intro.length).trim();
    if (body !== '') return { body, intro };
  }
  return { body: h.textMs, intro: null };
}

/** Parts of at most `max` characters, split at sentence ends; an over-long sentence is split at the last space. Never empty. */
export function hadisParts(body: string, max = 400): string[] {
  const text = body.trim();
  if (text === '') return [];
  const sentences = text.split(/(?<=[.?!][”"’)]*)\s+/).filter((x) => x !== '');
  const pieces: string[] = [];
  for (let s of sentences) {
    while (s.length > max) {
      let cut = s.lastIndexOf(' ', max);
      if (cut <= 0) cut = max;
      pieces.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if (s !== '') pieces.push(s);
  }
  const parts: string[] = [];
  let cur = '';
  for (const p of pieces) {
    if (cur === '') cur = p;
    else if (cur.length + 1 + p.length <= max) cur = `${cur} ${p}`;
    else {
      parts.push(cur);
      cur = p;
    }
  }
  if (cur !== '') parts.push(cur);
  return parts;
}

export type HadisPlan =
  | { mode: 'single'; tier: HadisTierKey; showIntro: true; showAr: boolean }
  | { mode: 'parts'; parts: string[]; tier: 'm' };

type PlanSettings = Pick<HadisSettings, 'showArabic' | 'fontSize'>;

/** One card for a hadis that fits, else its Malay body in parts (Arabic and the opening sentence dropped). */
export function hadisPlan(
  h: { textMs: string; textAr?: string; intro?: string },
  settings: Partial<PlanSettings>,
): HadisPlan {
  const showArabic = settings.showArabic !== false;
  const ar = showArabic && h.textAr ? h.textAr : undefined;
  // A chosen size applies when the text fits at it, else the largest smaller tier that fits.
  const from: HadisTierKey = settings.fontSize === 's' || settings.fontSize === 'm' || settings.fontSize === 'l' ? settings.fontSize : 'l';
  const tier = hadisTier(h.textMs, ar, from);
  if (tier !== null) return { mode: 'single', tier, showIntro: true, showAr: ar !== undefined };
  const { body } = hadisDisplayText(h);
  const parts = hadisParts(body);
  return { mode: 'parts', parts: parts.length > 0 ? parts : [h.textMs], tier: 'm' };
}

// ---- today's pool ----

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Days since 1970-01-01 of a YYYY-MM-DD date. */
function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

const byList = (a: Hadis, b: Hadis): number => {
  const ao = a.order;
  const bo = b.order;
  if (ao !== undefined && bo !== undefined && ao !== bo) return ao - bo;
  if (ao !== undefined && bo === undefined) return -1;
  if (ao === undefined && bo !== undefined) return 1;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

type PoolSettings = Pick<HadisSettings, 'source' | 'mix' | 'changeEvery' | 'perDay' | 'allowedGrades'>;

/** Most hadis one snapshot ships for `changeEvery: 'card'`; a bigger list rotates through in windows of this size, one per day. */
export const HADIS_CARD_POOL_MAX = 50;

/**
 * Today's hadis in show order: eligible items (shown, source, allowed grade), ordered by `mix`,
 * then the day's window of `perDay` items (for `changeEvery: 'card'` a window of up to `HADIS_CARD_POOL_MAX`).
 */
export function hadisPool(items: readonly Hadis[], settings: Partial<PoolSettings>, today: string): Hadis[] {
  const source = settings.source ?? 'both';
  const mix = settings.mix ?? 'list';
  const allowed = (settings.allowedGrades ?? {}) as Record<string, boolean>;
  const eligible = items.filter((h) => {
    if (h.shown === false) return false;
    const provider = h.ext?.provider === 'hadeethenc';
    if (provider) return source !== 'own' && h.ext?.blocked !== true && gradeAllowed(h.grade ?? null, allowed);
    return source !== 'hadeethenc';
  });
  const listed = [...eligible].sort(byList);

  let ordered = listed;
  if (mix === 'alternate' && source === 'both') {
    const own = listed.filter((h) => !h.ext);
    const prov = listed.filter((h) => h.ext);
    if (own.length > 0 && prov.length > 0) {
      ordered = [];
      for (let i = 0; i < Math.max(own.length, prov.length); i++) {
        if (own[i]) ordered.push(own[i]!);
        if (prov[i]) ordered.push(prov[i]!);
      }
    }
  } else if (mix === 'random') {
    ordered = [...listed];
    const rnd = mulberry32(hash32(today));
    for (let i = ordered.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [ordered[i], ordered[j]] = [ordered[j]!, ordered[i]!];
    }
  }

  const n = ordered.length;
  const per = settings.changeEvery === 'card'
    ? HADIS_CARD_POOL_MAX
    : Math.min(10, Math.max(1, Math.floor(settings.perDay ?? 3)));
  if (n <= per) return ordered;
  const start = (((dayNumber(today) * per) % n) + n) % n;
  const out: Hadis[] = [];
  for (let i = 0; i < per; i++) out.push(ordered[(start + i) % n]!);
  return out;
}
