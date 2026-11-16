import { gradeLabelMs, hadisDisplayText, hadisPlan } from '@surau/core';
import type { HadisSettings } from '@surau/core';
import { t } from '../../i18n.ts';
import type { CardProps } from '../ContentLayer.tsx';
import { pageAt, splitForPages, useFit } from '../paging.ts';
import { useScale } from '../scale.ts';

export interface HadisPage {
  /** The Arabic shown on this page (null: none). */
  ar: string | null;
  /** The Malay shown on this page ('' when the page is Arabic only). */
  ms: string;
}

/**
 * The pages one hadis slot is shown over: a single page while it fits; once the measured layout says it does not
 * (larger text size, a narrow card), the same text over `pages` pages, the Arabic first (as many pages as its share
 * of the text asks) and the Malay after, so no word is ever cut. Pure: the same input always pages the same way.
 */
export function planHadisPages(ar: string | null, ms: string, pages: number): HadisPage[] {
  const n = Math.max(1, Math.floor(pages));
  const hasAr = ar !== null && ar.trim() !== '';
  const hasMs = ms.trim() !== '';
  if (n === 1) return [{ ar: hasAr ? ar : null, ms }];
  if (!hasAr) return splitForPages(ms, n).map((m) => ({ ar: null, ms: m }));
  if (!hasMs) return splitForPages(ar, n).map((a) => ({ ar: a, ms: '' }));
  // Arabic runs about 0.6 em a letter, Malay about 0.5 em: the Arabic gets pages in proportion, at least one each.
  const arW = ar.length * 0.6;
  const msW = ms.length * 0.5;
  const nAr = Math.min(n - 1, Math.max(1, Math.round((n * arW) / (arW + msW))));
  return [
    ...splitForPages(ar, nAr).map((a) => ({ ar: a, ms: '' })),
    ...splitForPages(ms, n - nAr).map((m) => ({ ar: null, ms: m })),
  ];
}

export interface HadisSlot {
  h: NonNullable<CardProps['content']['hadisToday'][number]>;
  tier: ReturnType<typeof hadisPlan>['tier'];
  parts: string[] | null;
  partIndex: number;
  nPages: number;
  sub: number;
  /** The Arabic and the Malay this slot shows now (after the layout's paging). */
  shown: HadisPage;
  /** The opening sentence and the body, as the card writes a hadis that is not paged or in parts. */
  text: ReturnType<typeof hadisDisplayText>;
  malayOn: boolean;
  grade: string | null;
  attribution: string | null;
  ref: ReturnType<typeof useFit<HTMLDivElement>>['ref'];
  fit: number;
}

/**
 * What one hadis slot shows, by the Tetapan rules (showArabic, showMalay, grade, attribution, parts for a long
 * hadis, one part per slot) and by the layout's own fit. Shared by the card and the content screens: null when the
 * hadis is gone. `ref` goes on the box whose overflow the fit measures.
 */
export function useHadisSlot({ content, itemId, view, page, startedAt, durationSeconds }: CardProps): HadisSlot | null {
  const h = (itemId === null ? content.hadisToday[0] : content.hadisToday.find((x) => x.id === itemId)) ?? null;
  const settings = (view.settings?.hadis ?? {}) as Partial<HadisSettings>;
  const part = page ?? 0;
  // The text size (Ubah suai) is part of the key: a new size measures the fit again from the full size.
  const scale = useScale();
  const { ref, fit, pages } = useFit<HTMLDivElement>(`${h?.id ?? ''}|${part}|${scale}`, { paged: true });
  if (!h) return null;

  const plan = hadisPlan(h, settings);
  const showAr = settings.showArabic !== false;
  const showMalay = settings.showMalay !== false;
  const hasAr = plan.mode === 'single' && plan.showAr && showAr && !!h.textAr;
  // Malay is hidden only when the Arabic is there to stand in for it.
  const malayOn = showMalay || !hasAr;

  const parts = plan.mode === 'parts' ? plan.parts : null;
  const partIndex = parts ? Math.min(Math.max(part, 0), parts.length - 1) : 0;
  const text = hadisDisplayText(h);

  // The text this slot shows, over as many pages as the layout needs (one at the usual size).
  const msText = parts ? (parts[partIndex] ?? '') : text.intro ? `${text.intro} ${text.body}` : text.body;
  const plan2 = planHadisPages(hasAr ? h.textAr ?? null : null, malayOn ? msText : '', pages);
  const nPages = plan2.length;
  const sub = nPages > 1 ? pageAt(view.now, startedAt, durationSeconds / nPages, nPages, view.tz) : 0;
  const shown = plan2[sub] ?? { ar: null, ms: '' };

  const grade = settings.showGrade !== false && h.grade ? gradeLabelMs(h.grade) : null;
  const attribution =
    settings.showAttribution !== false && h.attribution
      ? h.attributionLong
        ? `${h.attribution} (${h.attributionLong.replace(/^Riwayat /, '')})`
        : h.attribution
      : null;
  return { h, tier: plan.tier, parts, partIndex, nPages, sub, shown, text, malayOn, grade, attribution, ref, fit };
}

/**
 * One hadis of today's pool. A hadis that fits is one card (Arabic, the opening sentence, the Malay text); a
 * long one is shown in parts, each part for the full card time, without the Arabic and the opening sentence.
 * Everything comes from the saved copy in `hadisToday`: the kiosk never asks HadeethEnc anything.
 */
export function HadisCard(props: CardProps) {
  const { lang } = props;
  const slot = useHadisSlot(props);
  if (!slot) return null;
  const { h, tier, parts, partIndex, nPages, sub, shown, text, malayOn, grade, attribution, ref, fit } = slot;

  return (
    <article class={`card glass card--wide card--hadis is-len-${tier}${parts ? ' is-parts' : ''}`} data-card="hadis" data-item={h.id} data-page={parts ? partIndex : undefined}>
      <header class="card__head">
        <span class="card__tag">{t('hadis', lang)}</span>
        {grade ? <span class="hadis__grade">{grade}</span> : null}
        {parts ? (
          <span class="hadis__parts" aria-label={`${t('bahagian', lang)} ${partIndex + 1} ${t('daripada', lang)} ${parts.length}`}>
            <span class="hadis__parts-label">{`${t('bahagian', lang)} ${partIndex + 1} ${t('daripada', lang)} ${parts.length}`}</span>
            <span class="hadis__dots" aria-hidden="true">
              {parts.map((_, i) => <i key={i} class={i === partIndex ? 'is-on' : ''} />)}
            </span>
          </span>
        ) : null}
        {nPages > 1 ? <span class="hadis__sub num">{`${sub + 1} / ${nPages}`}</span> : null}
      </header>
      <div class="hadis__body" ref={ref} style={`--fit:${fit}`}>
        {shown.ar !== null ? <p class="hadis__ar arab arabic" dir="rtl" lang="ar">{shown.ar}</p> : null}
        {malayOn && shown.ms !== '' ? (
          nPages > 1 || parts ? (
            <p class="hadis__ms arab-tarjamah">{shown.ms}</p>
          ) : (
            <p class="hadis__ms arab-tarjamah">
              {text.intro ? <span class="hadis__intro">{text.intro} </span> : null}
              {text.body}
            </p>
          )
        ) : null}
      </div>
      <footer class="hadis__foot">
        {attribution ? <span class="hadis__src">{attribution}</span> : <span />}
        {h.credit ? <span class="hadis__credit">{`${t('sumber', lang)}: ${h.credit}`}</span> : null}
      </footer>
    </article>
  );
}
