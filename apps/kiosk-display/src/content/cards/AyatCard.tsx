import type { AyatCard as AyatData } from '@surau/core';
import { t } from '../../i18n.ts';
import type { CardProps } from '../ContentLayer.tsx';
import { arabicIndic, pageAt, useFit } from '../paging.ts';

export type TextSize = 's' | 'm' | 'l';

export interface AyatPage {
  /** Index range into `arabic` / `malay` (inclusive). */
  from: number;
  to: number;
  /** A long ayat whose Arabic and translation cannot share the card gets an Arabic page then a translation page. */
  mode: 'both' | 'arabic' | 'malay';
  /** Font sizes (rem) the estimate chose; `useFit` shrinks further only if the real layout still overflows. */
  arFs: number;
  msFs: number;
}

/** Text width inside the wide card and the height left for the text block (card 19rem less tag, credit, padding). */
const LINE_REM = 88;
const BLOCK_REM = 12.2;
const MAX_PER_PAGE = 4;
const AR_LH = 1.85;
const MS_LH = 1.35;
const GAP_REM = 0.8;
const SIZES: Record<TextSize, { ar: number; arMin: number; ms: number; msMin: number }> = {
  s: { ar: 2.3, arMin: 1.9, ms: 1.35, msMin: 1.2 },
  m: { ar: 2.8, arMin: 2.1, ms: 1.55, msMin: 1.3 },
  l: { ar: 3.3, arMin: 2.4, ms: 1.8, msMin: 1.45 },
};

const letters = (s: string): number => {
  let n = 0;
  for (const ch of s) if (/\p{L}/u.test(ch)) n++;
  return n;
};
/** Estimated height (rem) of the Arabic run: letters at ~0.6 em each plus the ayah mark, loose Uthmani leading. */
function arHeight(texts: string[], fs: number): number {
  const chars = texts.reduce((a, s) => a + letters(s) + 3, 0);
  return Math.max(1, Math.ceil((chars * 0.6 * fs) / LINE_REM)) * fs * AR_LH;
}
function msHeight(texts: string[], fs: number): number {
  const chars = texts.reduce((a, s) => a + s.length + 5, 0);
  return Math.max(1, Math.ceil((chars * 0.5 * fs) / LINE_REM)) * fs * MS_LH;
}

export function textSizeOf(v: unknown): TextSize {
  return v === 's' || v === 'l' ? v : 'm';
}

/**
 * Pages for a range: up to four ayat per page while Arabic (and the translation when shown) fit at the preferred
 * size; a lone ayat that does not fit shrinks towards the minimum size, and failing that is split into an
 * Arabic page and a translation page. Pure: the same input always pages the same way.
 */
export function paginateAyat(
  card: { arabic: string[]; malay: string[] },
  opts: { showTranslation: boolean; textSize: TextSize },
): AyatPage[] {
  const sz = SIZES[opts.textSize] ?? SIZES.m;
  const n = card.arabic.length;
  const ar = (from: number, to: number) => card.arabic.slice(from, to + 1);
  const ms = (from: number, to: number) => card.malay.slice(from, to + 1).map((s) => s ?? '');
  const fits = (from: number, to: number, arFs: number, msFs: number): boolean => {
    const h = arHeight(ar(from, to), arFs) + (opts.showTranslation ? GAP_REM + msHeight(ms(from, to), msFs) : 0);
    return h <= BLOCK_REM;
  };
  const mode: AyatPage['mode'] = opts.showTranslation ? 'both' : 'arabic';
  const pages: AyatPage[] = [];
  let i = 0;
  while (i < n) {
    let to = -1;
    for (let j = i; j < Math.min(n, i + MAX_PER_PAGE); j++) {
      if (!fits(i, j, sz.ar, sz.ms)) break;
      to = j;
    }
    if (to >= i) {
      pages.push({ from: i, to, mode, arFs: sz.ar, msFs: sz.ms });
      i = to + 1;
      continue;
    }
    // One ayat does not fit at the preferred size: shrink both texts together.
    let shrunk: AyatPage | null = null;
    for (let f = 0.95; f >= sz.arMin / sz.ar - 1e-9; f -= 0.05) {
      const arFs = Math.round(sz.ar * f * 100) / 100;
      const msFs = Math.max(sz.msMin, Math.round(sz.ms * f * 100) / 100);
      if (fits(i, i, arFs, msFs)) {
        shrunk = { from: i, to: i, mode, arFs, msFs };
        break;
      }
    }
    if (shrunk) {
      pages.push(shrunk);
      i++;
      continue;
    }
    // Still too long: the Arabic alone (as large as fits, the minimum at worst), then the translation alone.
    let arFs = sz.arMin;
    for (let f = sz.ar; f >= sz.arMin - 1e-9; f -= 0.1) {
      if (arHeight(ar(i, i), f) <= BLOCK_REM) { arFs = Math.round(f * 100) / 100; break; }
    }
    pages.push({ from: i, to: i, mode: 'arabic', arFs, msFs: 0 });
    if (opts.showTranslation) {
      let msFs = sz.msMin;
      for (let f = sz.ms + 0.4; f >= sz.msMin - 1e-9; f -= 0.05) {
        if (msHeight(ms(i, i), f) <= BLOCK_REM) { msFs = Math.round(f * 100) / 100; break; }
      }
      pages.push({ from: i, to: i, mode: 'malay', arFs: 0, msFs });
    }
    i++;
  }
  // A short range that fits on one page grows to fill the card (up to 1.4x the preferred Arabic size).
  const only = pages.length === 1 ? pages[0]! : null;
  if (only && only.mode !== 'malay') {
    for (let f = 1.4; f > 1.0001; f -= 0.05) {
      const arFs = Math.round(sz.ar * f * 100) / 100;
      const msFs = Math.round(sz.ms * Math.min(f, 1.15) * 100) / 100;
      if (fits(only.from, only.to, arFs, msFs)) {
        only.arFs = arFs;
        only.msFs = msFs;
        break;
      }
    }
  }
  return pages;
}

function rangeLabel(a: AyatData): string {
  return a.ayatTo > a.ayatFrom ? `${a.ayatFrom}-${a.ayatTo}` : String(a.ayatFrom);
}

export function AyatCard({ view, lang, content, startedAt, durationSeconds }: CardProps) {
  const a = content.ayat.today;
  const f = view.settings.ayatCard as unknown as { showTranslation?: unknown; textSize?: unknown };
  const showTranslation = f.showTranslation !== false;
  const size = textSizeOf(f.textSize);
  const pages = a ? paginateAyat(a, { showTranslation, textSize: size }) : [];
  const pageNo = pages.length > 0 ? pageAt(view.now, startedAt, durationSeconds / pages.length, pages.length, view.tz) : 0;
  const key = `${a?.surah ?? 0}:${a?.ayatFrom ?? 0}-${a?.ayatTo ?? 0}|${size}|${showTranslation ? 1 : 0}|${pageNo}`;
  const { ref, fit } = useFit<HTMLDivElement>(key);
  if (!a || pages.length === 0) return null;
  const p = pages[pageNo]!;
  const multi = a.ayatTo > a.ayatFrom;

  return (
    <article
      class={`card glass card--wide card--ayat is-size-${size}`}
      data-card="ayatCard"
      data-page={`${pageNo + 1}/${pages.length}`}
    >
      <header class="card__head">
        <span class="card__tag">{t('ayatToday', lang)}</span>
        <span class="ayat__ref">{t('surahLine', lang, { name: a.surahNameMs, n: a.surah, range: rangeLabel(a) })}</span>
        {p.mode === 'malay' ? <span class="ayat__mode">{t('translation', lang)}</span> : null}
        {pages.length > 1 ? <span class="ayat__pages num">{`${pageNo + 1} / ${pages.length}`}</span> : null}
      </header>
      <div class="ayat__page" key={key} ref={ref} style={`--ar-fs:${p.arFs}rem;--ms-fs:${p.msFs}rem;--fit:${fit}`}>
        {p.mode !== 'malay' ? (
          <p class="ayat__ar" dir="rtl" lang="ar">
            {a.arabic.slice(p.from, p.to + 1).map((txt, k) => (
              <span class="ayat__aya" key={p.from + k}>
                {txt}
                <span class="ayat__no">{` ۝${arabicIndic(a.ayatFrom + p.from + k)}`}</span>
                {' '}
              </span>
            ))}
          </p>
        ) : null}
        {p.mode !== 'arabic' ? (
          <p class="ayat__ms">
            {a.malay.slice(p.from, p.to + 1).map((txt, k) => (
              <span class="ayat__tr" key={p.from + k}>
                {multi ? <b class="ayat__trno num">{`${a.ayatFrom + p.from + k}.`}</b> : null}
                {txt}
                {' '}
              </span>
            ))}
          </p>
        ) : null}
      </div>
      <footer class="ayat__credit">
        <span>{content.credits.translation}</span>
        {content.credits.font ? (
          <>
            <span class="sep" aria-hidden="true" />
            <span>{content.credits.font}</span>
          </>
        ) : null}
      </footer>
    </article>
  );
}
