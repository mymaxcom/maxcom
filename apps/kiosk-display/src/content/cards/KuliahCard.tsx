import { dateOf, offsetMinutes } from '@surau/core';
import type { KuliahView } from '@surau/core';
import { prayerLabel } from '../../format.ts';
import { fmtDateShort, fmtTimeOfDay, t, ymdParts } from '../../i18n.ts';
import type { Lang } from '../../i18n.ts';
import { assetSrc, num } from '../assets.ts';
import type { CardProps } from '../ContentLayer.tsx';

/** A kuliah stays "today's" for this long after its start before the card moves on to the next one. */
const GRACE_MIN = 90;

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

function addDays(date: string, n: number): string {
  const p = ymdParts(date);
  if (!p) return date;
  return new Date(p.utc + n * 86_400_000).toISOString().slice(0, 10);
}

/** 'Maghrib' for a prayer slot, the time for a free slot ('lain'). */
function slotWord(k: KuliahView, lang: Lang, timeFormat: '12h' | '24h'): string {
  return k.slot === 'lain' ? fmtTimeOfDay(k.time, lang, timeFormat) : prayerLabel(k.slot, lang);
}

/** Today's or the next kuliah: first upcoming within `daysAhead`; failing that, today's latest one (already held). */
export function pickKuliah(list: KuliahView[], today: string, nowMin: number, daysAhead: number): KuliahView[] {
  const last = addDays(today, Math.max(0, daysAhead));
  const window = list
    .filter((k) => k.date >= today && k.date <= last)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const upcoming = window.filter((k) => k.date !== today || minutesOf(k.time) + GRACE_MIN > nowMin);
  if (upcoming.length > 0) return upcoming;
  const todays = window.filter((k) => k.date === today);
  return todays.length > 0 ? [todays[todays.length - 1]!] : [];
}

/**
 * How many "following" rows fit under the name and topic (card height is fixed). Estimated from the text
 * width available (rem) and the type sizes in content.css; a wrapped name or topic costs one row each.
 */
export function followingRows(k: KuliahView, hasPhoto: boolean, hasKitab: boolean): number {
  const bodyRem = 52.8 - (hasPhoto ? 12.5 : 0) - (hasKitab ? 9.1 : 0);
  const nameChars = Math.floor((bodyRem / 1.45) * 0.9); // 2.5rem, ~0.58em per glyph at weight 800
  const topicChars = Math.floor((bodyRem / 0.85) * 0.9); // 1.6rem, ~0.53em per glyph
  const nameLines = Math.min(2, Math.ceil(k.penceramah.name.length / Math.max(1, nameChars)));
  const topicLines = k.topic ? Math.min(2, Math.ceil(k.topic.length / Math.max(1, topicChars))) : 1;
  return Math.max(0, 3 - (nameLines - 1) - (topicLines - 1));
}

export function KuliahCard({ view, lang, content }: CardProps) {
  const { settings, now } = view;
  const timeFormat = settings.prayerBar.timeFormat === '24h' ? '24h' : '12h';
  const today = dateOf(now, view.tz);
  const kl = new Date(now.getTime() + offsetMinutes(now, view.tz) * 60_000);
  const nowMin = kl.getUTCHours() * 60 + kl.getUTCMinutes();

  const list = pickKuliah(content.kuliah, today, nowMin, num(settings.kuliahCard.daysAhead, 7));
  const main = list[0];
  if (!main) return null;

  const isToday = main.date === today;
  const batal = main.status === 'batal';
  const photo = settings.penceramahPhoto.enabled ? assetSrc(main.penceramah.photoAssetId) : null;
  const shape = settings.penceramahPhoto.shape === 'square' ? 'square' : 'round';
  const kitab = main.kitab;
  const showCover = settings.kitabCover.enabled && kitab !== undefined;
  const cover = showCover ? assetSrc(kitab?.coverAssetId) : null;
  // The cover block spells the title itself when it has no image; the meta line then does not repeat it.
  const metaKitab = kitab && !(showCover && !cover) ? kitab.title : null;
  const when = `${isToday ? '' : `${fmtDateShort(main.date, lang)}, `}${main.slot === 'lain' ? '' : prayerLabel(main.slot, lang)}`.trim();
  const following = list.slice(1, 1 + followingRows(main, photo !== null, showCover));

  return (
    <article class={`card glass card--kuliah${batal ? ' is-batal' : ''}`} data-card="kuliahCard" data-item={main.id}>
      {photo ? (
        <div class={`kuliah__photo is-${shape}`}>
          <img src={photo} alt="" />
        </div>
      ) : null}
      <div class="kuliah__body">
        <div class="kuliah__head">
          <span class="card__tag">{t(isToday ? 'kuliahToday' : 'kuliahNext', lang)}</span>
          <span class="kuliah__when">
            {when ? <span>{when}</span> : null}
            <b class="num">{fmtTimeOfDay(main.time, lang, timeFormat)}</b>
          </span>
        </div>
        <h2 class="kuliah__name">{main.penceramah.name}</h2>
        {main.topic ? <p class="kuliah__topic">{main.topic}</p> : null}
        <p class="kuliah__meta">
          <span>{main.label}</span>
          {metaKitab ? (
            <>
              <span class="sep" aria-hidden="true" />
              <span>{metaKitab}</span>
            </>
          ) : null}
        </p>
        {following.length > 0 ? (
          <ul class="kuliah__next">
            {following.map((k) => (
              <li key={k.id}>
                <span class="kuliah__next-when">{`${fmtDateShort(k.date, lang)}, ${slotWord(k, lang, timeFormat)}`}</span>
                <span class="kuliah__next-name">{k.penceramah.name}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {showCover && kitab ? (
        <div class={`kuliah__kitab${cover ? ' has-img' : ''}`}>
          {cover ? <img src={cover} alt="" /> : <span class="kuliah__kitab-title">{kitab.title}</span>}
        </div>
      ) : null}
      {batal ? <span class="card__ribbon">{t('batal', lang)}</span> : null}
    </article>
  );
}
