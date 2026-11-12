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

/**
 * Shrinks a text block until it no longer overflows its box (a `--fit` factor the CSS multiplies the font
 * sizes by). The estimate picks the size; this is the guarantee that no Quran or hadis line is ever cut.
 * No-op where layout is not measured (jsdom), and resets when `key` (the page) changes.
 */
export function useFit<T extends HTMLElement>(key: string): { ref: RefObject<T | null>; fit: number } {
  const ref = useRef<T>(null);
  const [fit, setFit] = useState(1);
  // Bumped when the box itself changes size: a card can mount while its band is still closed (the screen is idle
  // until the first card reports in) or a template gives the band a different size; the fit starts again then.
  const [box, setBox] = useState(0);
  useLayoutEffect(() => {
    setFit(1);
  }, [key]);
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
        setFit(1);
        setBox((n) => n + 1);
      });
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [key]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.scrollHeight > el.clientHeight + 1 && fit > FIT_MIN) {
      setFit(Math.round((fit - FIT_STEP) * 100) / 100);
    }
  }, [fit, key, box]);
  return { ref, fit };
}
