import { dateOf } from '@surau/core';
import { daysBetween, fmtDateLong, t } from '../../i18n.ts';
import { num } from '../assets.ts';
import type { CardProps } from '../ContentLayer.tsx';

/** Rows readable from 10 m: the card holds at most this many whatever `takwim.count` says. */
const MAX_ROWS = 3;

export function TakwimCard({ view, lang, content }: CardProps) {
  const today = dateOf(view.now, view.tz);
  const count = Math.min(MAX_ROWS, Math.max(0, Math.floor(num(view.settings.takwim.count, 3))));
  const rows = content.takwim
    .filter((x) => x.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, count);
  if (rows.length === 0) return null;

  return (
    <article class="card glass card--takwim" data-card="takwim">
      <span class="card__tag">{t('takwim', lang)}</span>
      <ol class="takwim__list">
        {rows.map((r) => {
          const n = daysBetween(today, r.date) ?? 0;
          return (
            <li class="takwim__row" key={r.id}>
              <span class="takwim__days">
                {n <= 0 ? (
                  <b class="takwim__n takwim__n--word">{t('today', lang)}</b>
                ) : (
                  <>
                    <b class="takwim__n num">{n}</b>
                    <small>{t('daysLeftWord', lang)}</small>
                  </>
                )}
              </span>
              <span class="takwim__text">
                <span class="takwim__title">{r.title}</span>
                <span class="takwim__date">
                  <span>{fmtDateLong(r.date, lang)}</span>
                  {r.hijriLabel ? (
                    <>
                      <span class="sep" aria-hidden="true" />
                      <span class="takwim__hijri">{r.hijriLabel}</span>
                    </>
                  ) : null}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </article>
  );
}
