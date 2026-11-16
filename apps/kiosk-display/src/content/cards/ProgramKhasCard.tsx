import { useState } from 'preact/hooks';
import { fmtDateLong, fmtTimeOfDay, t } from '../../i18n.ts';
import { assetSrc } from '../assets.ts';
import { cardPictureFailed, markCardPictureFailed } from '../cardPictures.ts';
import type { CardProps } from '../ContentLayer.tsx';

/**
 * A special programme: its picture whole (contained, never cropped to a band) and the title, date and note beside it,
 * or under it where the theme stacks them. A wide picture takes a larger share of the card than a tall one.
 * A picture that fails to load drops out: the card shows the text-only layout and Main keeps the ticker.
 */
export function programKhasPicture(p: { assetId?: unknown } | undefined): string | null {
  const id = p?.assetId;
  return typeof id === 'string' && /^[0-9a-f]{64}$/.test(id) && !cardPictureFailed(id) ? id : null;
}

export function ProgramKhasCard({ view, lang, content, itemId }: CardProps) {
  const p = content.programKhas.find((x) => x.id === itemId);
  const [wide, setWide] = useState(false);
  const [broken, setBroken] = useState(false);
  if (!p) return null;
  const timeFormat = view.settings.prayerBar.timeFormat === '24h' ? '24h' : '12h';
  const [date, time] = p.at.split('T') as [string, string | undefined];
  const when = time ? `${fmtDateLong(date, lang)}, ${fmtTimeOfDay(time, lang, timeFormat)}` : fmtDateLong(date, lang);
  const pictureId = broken ? null : programKhasPicture(p);
  const src = assetSrc(pictureId);
  const batal = p.status === 'batal';
  return (
    <article class={`card glass card--program${batal ? ' is-batal' : ''}${src && wide ? ' is-wide' : ''}`} data-card="programKhas" data-item={p.id}>
      {src ? (
        <div class="program__img">
          <img
            src={src}
            alt=""
            onLoad={(e) => {
              const img = e.currentTarget;
              setWide(img.naturalWidth > img.naturalHeight);
            }}
            onError={() => {
              if (pictureId !== null) markCardPictureFailed(pictureId);
              setBroken(true);
            }}
          />
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
