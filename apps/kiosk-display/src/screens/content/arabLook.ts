import type { ScreenId, ScreenStyle } from '@surau/core';

export type ArabBase = 'ayat' | 'hadis' | 'zikir';

/** True when the theme turns the look on AND the item has Arabic AND Tetapan lets Arabic show. */
export function arabLookFor(
  base: ArabBase,
  looks: ReadonlySet<ScreenId | string>,
  has: { arabic: boolean; tetapanArabic: boolean },
): boolean {
  return looks.has(`arab-${base}`) && has.arabic && has.tetapanArabic;
}

/**
 * below | beside | hidden. Tetapan off (showMalay false, or the ayat mode without translation) is always 'hidden';
 * else the menu value; 'hidden' from the menu counts on arab-* screens only (the normal screens never ask).
 */
export function tarjamahMode(style: Pick<ScreenStyle, 'tarjamah'>, tetapanShows: boolean): 'below' | 'beside' | 'hidden' {
  if (!tetapanShows) return 'hidden';
  if (style.tarjamah === 'sisi') return 'beside';
  if (style.tarjamah === 'sembunyi') return 'hidden';
  return 'below';
}

/** Splits `n` verses (or lines) into `pages` contiguous, balanced groups of indices. */
export function groupIndices(n: number, pages: number): number[][] {
  const p = Math.max(1, Math.min(Math.floor(pages), Math.max(1, n)));
  const out: number[][] = [];
  let from = 0;
  for (let i = 0; i < p; i++) {
    const to = Math.round(((i + 1) * n) / p);
    out.push(Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k));
    from = to;
  }
  return out.filter((g) => g.length > 0);
}
