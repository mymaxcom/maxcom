import { useState } from 'preact/hooks';
import { isBoxLang } from '../i18n-box.ts';
import type { BoxLang } from '../i18n-box.ts';
import type { Lang } from '../i18n.ts';

/** Where this display remembers the language chosen on its box screens. Nothing else reads it. */
export const BOX_LANG_KEY = 'mx-box-lang';

/** The language chosen on this display, or null when none was chosen or storage cannot be read. */
export function readBoxLang(): BoxLang | null {
  try {
    const v = window.localStorage.getItem(BOX_LANG_KEY);
    return isBoxLang(v) ? v : null;
  } catch {
    return null;
  }
}

/** Remembers the choice; a display without storage just keeps it until the page reloads. */
export function writeBoxLang(lang: BoxLang): void {
  try {
    window.localStorage.setItem(BOX_LANG_KEY, lang);
  } catch {
    /* storage unavailable or full: the choice still holds for this page */
  }
}

/**
 * Where this display remembers the TV language it last showed: the boot screen of index.html (public/boot-lang.js)
 * reads it to say "loading" in that one language before the program has loaded.
 */
export const TV_LANG_KEY = 'mx-tv-lang';

/** Remembers the TV language for the next boot screen (only when it changed; storage errors are ignored). */
export function rememberTvLang(lang: Lang): void {
  try {
    if (window.localStorage.getItem(TV_LANG_KEY) !== lang) window.localStorage.setItem(TV_LANG_KEY, lang);
  } catch {
    /* storage unavailable: the boot screen shows its three lines */
  }
}

/**
 * The box screens' language. A choice made on this display wins and is remembered. Until one is made it follows
 * the surau's kiosk language: a fresh box (no settings yet) starts in Bahasa Melayu, and a box whose surau has
 * chosen English starts in English. The main kiosk program never reads this.
 */
export function useBoxLang(surau: Lang, opts: { remember?: boolean } = {}): [BoxLang, (lang: BoxLang) => void] {
  // The admin app's preview touches no storage at all.
  const remember = opts.remember !== false;
  const [chosen, setChosen] = useState<BoxLang | null>(() => (remember ? readBoxLang() : null));
  const choose = (lang: BoxLang): void => {
    if (remember) writeBoxLang(lang);
    setChosen(lang);
  };
  return [chosen ?? surau, choose];
}
