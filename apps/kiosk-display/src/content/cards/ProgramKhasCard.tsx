import { fmtDateLong, fmtTimeOfDay, t } from '../../i18n.ts';
import { assetSrc } from '../assets.ts';
import type { CardProps } from '../ContentLayer.tsx';

export function ProgramKhasCard({ view, lang, content, itemId }: CardProps) {
  const p = content.programKhas.find((x) => x.id === itemId);
  if (!p) return null;
  const timeFormat = view.settings.prayerBar.timeFormat === '24h' ? '24h' : '12h';
  const [date, time] = p.at.split('T') as [string, string | undefined];
  const when = time ? `${fmtDateLong(date, lang)}, ${fmtTimeOfDay(time, lang, timeFormat)}` : fmtDateLong(date, lang);
  const src = assetSrc(p.assetId);
  const batal = p.status === 'batal';
  return (
    <article class={`card glass card--program${batal ? ' is-batal' : ''}`} data-card="programKhas" data-item={p.id}>
      {src ? (
        <div class="program__img">
          <img src={src} alt="" />
        </div>
      ) : null}
      <div class="program__body">
        <span class="card__tag">{t('programKhas', lang)}</span>
        <h2 class="program__title">{p.title}</h2>
        <p class="program__when num">{when}</p>
        {p.note ? <p class="program__note">{p.note}</p> : null}
      </div>
      {batal ? <span class="card__ribbon">{t('batal', lang)}</span> : null}
    </article>
  );
}
