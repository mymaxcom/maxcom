// Strings for the box's own screens (setup, recovery, stopped, pairing, network check).
//
// These screens speak three languages, chosen on the display itself: Bahasa Melayu (default), English and
// Arabic. The main kiosk program keeps the surau's setting (`Lang` in i18n.ts: ms, en or ar).
// All three live in STRINGS (i18n.ts) beside the rest of the kiosk.
//
// The Arabic is formal Modern Standard Arabic and follows the terms on mymaxcom.my (المصلى, المسؤول,
// امسح, رمز QR, رمز الاسترداد, السحابة). Product names stay Latin. It still wants a native speaker's check.

import { h } from 'preact';
import type { ComponentChildren } from 'preact';
import { STRINGS, t } from './i18n.ts';

export type BoxLang = 'ms' | 'en' | 'ar';
export const BOX_LANGS: readonly BoxLang[] = ['ms', 'en', 'ar'];

export function isBoxLang(x: unknown): x is BoxLang {
  return x === 'ms' || x === 'en' || x === 'ar';
}

/** Text direction of a box-screen language. */
export function dirOf(lang: BoxLang): 'rtl' | 'ltr' {
  return lang === 'ar' ? 'rtl' : 'ltr';
}

/** What each choice is called on the switch, in its own language (as on mymaxcom.my). */
export const LANG_NAMES: Record<BoxLang, string> = { ms: 'BM', en: 'EN', ar: 'عربي' };

/** The Arabic strings: since the TV language can be Arabic too (W14), they live in the kiosk's STRINGS (i18n.ts). */
export const AR: Record<string, string> = STRINGS.ar;

/**
 * The app's menu path for the Arabic pairing line. The app itself speaks Malay and English, so the path names
 * the English menu words the person will see; it is set left to right so the arrows read in the app's order.
 */
// No-break spaces: like the Malay and English lines, the path never splits across two lines on the TV.
export const PAIR_MENU_PATH = 'More > Users & devices > TV screens';

/** Box-screen text. Arabic from AR, Malay and English from the kiosk's STRINGS. A missing key comes back as the key. */
export function tb(key: string, lang: BoxLang, vars?: Record<string, string | number>): string {
  if (lang !== 'ar') return t(key, lang, vars);
  const s = AR[key];
  if (s === undefined) return key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** Codes and addresses: always left to right. Names and times take their direction from their own letters. */
const LTR_VARS = new Set(['url', 'id', 'address', 'mmss', 'path']);

/**
 * Like `tb`, but in Arabic every filled-in value is isolated (`<bdi>`), so an address, a code or a Latin name keeps
 * its own order inside the right-to-left sentence. Malay and English come back as the plain string.
 */
export function tbx(key: string, lang: BoxLang, vars: Record<string, string | number>): ComponentChildren {
  if (lang !== 'ar') return t(key, lang, vars);
  const s = AR[key];
  if (s === undefined) return key;
  const out: ComponentChildren[] = [];
  let last = 0;
  s.replace(/\{(\w+)\}/g, (m, name: string, at: number) => {
    if (at > last) out.push(s.slice(last, at));
    out.push(name in vars ? h('bdi', LTR_VARS.has(name) ? { dir: 'ltr' } : {}, String(vars[name])) : m);
    last = at + m.length;
    return m;
  });
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/** The surau's name for a box screen: its own name when set, else the generic word in the screen's language. */
export function surauNameBox(settings: { surauInfo?: { name?: unknown } } | null | undefined, lang: BoxLang): string {
  try {
    const n = settings?.surauInfo?.name;
    if (typeof n === 'string' && n.trim() !== '') return n.trim();
  } catch {
    /* fall through */
  }
  return tb('surauName', lang);
}
