import { dateOf, instantOf } from '@surau/core';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';

/** Whole seconds since midnight of the surau's zone (KL by default): the clock every time-driven card shares (pure function of `now`). */
export function secondsSinceKlMidnight(now: Date, tz: string = 'Asia/Kuala_Lumpur'): number {
  const midnight = instantOf(dateOf(now, tz), '00:00', tz).getTime();
  return Math.max(0, Math.floor((now.getTime() - midnight) / 1000));
}

/**
 * Page index at `now` for a card that turns a page every `pageSeconds`: counted from the slot start when the
 * rotation gives one, else from KL midnight (the `?card=` override), so a reload lands on the same page.
 */
export function pageAt(now: Date, startedAt: Date | null, pageSeconds: number, pages: number, tz: string = 'Asia/Kuala_Lumpur'): number {
  if (!(pages > 0)) return 0;
  const per = pageSeconds > 0 ? pageSeconds : 1;
  const elapsed = startedAt ? Math.max(0, (now.getTime() - startedAt.getTime()) / 1000) : secondsSinceKlMidnight(now, tz);
  return Math.floor(elapsed / per) % pages;
}

/** Arabic-Indic digits for an ayah number (the QPC font draws them inside the end-of-ayah mark). */
export function arabicIndic(n: number): string {
  return String(n).replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
}

const FIT_MIN = 0.55;
const FIT_STEP = 0.05;
/** A card that pages its text shrinks only this far before it takes another page (larger text pages, it never drops text). */
export const FIT_PAGED_MIN = 0.8;
/** Most pages one slot is split into by the measured fit. */
export const MAX_PAGES = 12;

/**
 * Splits running text into at most `n` balanced pages without dropping or reordering a word: the cut goes at the
 * sentence end nearest the even share, else at the nearest space. Joining the pages with a space gives the text
 * back (runs of spaces collapsed; line breaks kept). Fewer than `n` pages come back only when the text has fewer words.
 */
export function splitForPages(text: string, n: number): string[] {
  const clean = text.replace(/[^\S\n]+/g, ' ').trim();
  if (clean === '') return [];
  const want = Math.max(1, Math.floor(n));
  if (want === 1) return [clean];
  const words = clean.split(' ').filter((w) => w !== '');
  if (words.length <= want) return words;
  // Cumulative end offset (chars) of each word, so a cut can be placed on a word boundary.
  const ends: number[] = [];
  let pos = 0;
  for (const w of words) {
    pos += w.length + 1;
    ends.push(pos);
  }
  const total = pos;
  const out: string[] = [];
  let from = 0;
  for (let i = 1; i <= want; i++) {
    if (from >= words.length) break;
    if (i === want) {
      out.push(words.slice(from).join(' '));
      break;
    }
    const target = (total * i) / want;
    // The last word this page may end on (leave at least one word for each page still to come).
    const hi = words.length - (want - i) - 1;
    let best = from;
    let bestScore = Infinity;
    for (let k = from; k <= hi; k++) {
      // Distance from the even share; a sentence end is worth a tenth of a share in its favour.
      const sentence = /[.!?؟۔][”"’)\]]*$/.test(words[k]!);
      const score = Math.abs(ends[k]! - target) - (sentence ? total / want / 10 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = k;
      }
    }
    out.push(words.slice(from, best + 1).join(' '));
    from = best + 1;
  }
  return out;
}

/**
 * Shrinks a text block until it no longer overflows its box (a `--fit` factor the CSS multiplies the font
 * sizes by). The estimate picks the size; this is the guarantee that no Quran or hadis line is ever cut.
 * No-op where layout is not measured (jsdom), and resets when `key` (the page) changes.
 */
export function useFit<T extends HTMLElement>(key: string, opts: { paged?: boolean; max?: number } = {}): { ref: RefObject<T | null>; fit: number; pages: number } {
  const paged = opts.paged === true;
  // `max` above 1 lets a short text start larger and fill its box (theme round 2, "maximise the screen"): the fit
  // starts at `max` and steps down as before, so a long text ends where it always did.
  const start = typeof opts.max === 'number' && opts.max > 1 ? opts.max : 1;
  const ref = useRef<T>(null);
  const [fit, setFit] = useState(start);
  // Paged mode (long text): once the text will not fit at FIT_PAGED_MIN, it is split over `pages` pages (the card
  // cuts its text with splitForPages) and the fit starts again, so the text stays as large as the pages allow.
  const [pages, setPages] = useState(1);
  // Bumped when the box itself changes size: a card can mount while its band is still closed (the screen is idle
  // until the first card reports in) or a template gives the band a different size; the fit starts again then.
  const [box, setBox] = useState(0);
  useLayoutEffect(() => {
    setFit(start);
    setPages(1);
  }, [key, start]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // Only a box that opens (from nothing) or changes width starts the fit again: a height that follows the fit
    // itself (a block sized by its own text) must not, or the two would chase each other. The state change waits
    // for the next frame, outside the observer callback.
    let lastW = el.clientWidth;
    let lastH = el.clientHeight;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      const opened = (lastW === 0 || lastH === 0) && w > 0 && h > 0;
      const widthChanged = w !== lastW;
      lastW = w;
      lastH = h;
      if (!opened && !widthChanged) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setFit(start);
        setPages(1);
        setBox((n) => n + 1);
      });
    });
    ro.observe(el);
    // The web fonts change the text's measure without changing the box: once they have loaded, fit again.
    let alive = true;
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (fonts && fonts.status !== 'loaded') {
      fonts.ready.then(() => {
        if (!alive) return;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          setFit(start);
          setPages(1);
          setBox((n) => n + 1);
        });
      }).catch(() => {});
    }
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [key, start]);
  const floor = paged ? FIT_PAGED_MIN : FIT_MIN;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!(el.scrollHeight > el.clientHeight + 1)) return;
    if (fit > floor + 1e-9) {
      setFit(Math.round((fit - FIT_STEP) * 100) / 100);
    } else if (paged && pages < MAX_PAGES) {
      setPages(pages + 1);
      setFit(start);
    }
    // A paged card is checked after every render: the page on screen changes with the clock, not only with the key.
  }, paged ? undefined : [fit, key, box]);
  return { ref, fit, pages };
}
