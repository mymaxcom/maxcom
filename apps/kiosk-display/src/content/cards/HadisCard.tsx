import { gradeLabelMs, hadisDisplayText, hadisPlan } from '@surau/core';
import type { HadisSettings } from '@surau/core';
import { t } from '../../i18n.ts';
import type { CardProps } from '../ContentLayer.tsx';
import { useFit } from '../paging.ts';

/**
 * One hadis of today's pool. A hadis that fits is one card (Arabic, the opening sentence, the Malay text); a
 * long one is shown in parts, each part for the full card time, without the Arabic and the opening sentence.
 * Everything comes from the saved copy in `hadisToday`: the kiosk never asks HadeethEnc anything.
 */
export function HadisCard({ lang, content, itemId, view, page }: CardProps) {
  const h = (itemId === null ? content.hadisToday[0] : content.hadisToday.find((x) => x.id === itemId)) ?? null;
  const settings = (view.settings?.hadis ?? {}) as Partial<HadisSettings>;
  const part = page ?? 0;
  const { ref, fit } = useFit<HTMLDivElement>(`${h?.id ?? ''}|${part}`);
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
  const tier = plan.tier;

  const grade = settings.showGrade !== false && h.grade ? gradeLabelMs(h.grade) : null;
  const attribution =
    settings.showAttribution !== false && h.attribution
      ? h.attributionLong
        ? `${h.attribution} (${h.attributionLong.replace(/^Riwayat /, '')})`
        : h.attribution
      : null;

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
      </header>
      <div class="hadis__body" ref={ref} style={`--fit:${fit}`}>
        {hasAr ? <p class="hadis__ar arabic" dir="rtl" lang="ar">{h.textAr}</p> : null}
        {malayOn ? (
          parts ? (
            <p class="hadis__ms">{parts[partIndex]}</p>
          ) : (
            <p class="hadis__ms">
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
