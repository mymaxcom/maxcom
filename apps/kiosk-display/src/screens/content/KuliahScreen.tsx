import { dateOf, kuliahOnScreen } from '@surau/core';
import type { KuliahView } from '@surau/core';
import { useEffect } from 'preact/hooks';
import { prayerLabel } from '../../format.ts';
import { commaOf, daysBetween, fmtDayMonth, fmtTimeOfDay, fmtWeekday, t } from '../../i18n.ts';
import type { Lang } from '../../i18n.ts';
import { assetSrc } from '../../content/assets.ts';
import type { CardProps } from '../../content/ContentLayer.tsx';
import { useFit } from '../../content/paging.ts';

/** How far a short kuliah's text may grow (the `--fit` it starts at) before it steps down to fit. */
export const KULIAH_FIT_MAX = 1.2;

export type KuliahDayRel = 'today' | 'tomorrow' | 'later';

/**
 * The enlarged day line of a kuliah screen: "Hari ini" (highlighted) or "Esok" with the weekday and date, else the
 * weekday with the date ('Khamis' / '5 November').
 */
export function kuliahDayOf(date: string, today: string, lang: Lang): { rel: KuliahDayRel; word: string; date: string } {
  const d = daysBetween(today, date);
  const dayMonth = fmtDayMonth(date, lang);
  if (d === 0) return { rel: 'today', word: t('kuliahWhenToday', lang), date: `${fmtWeekday(date, lang)}${commaOf(lang)}${dayMonth}` };
  if (d === 1) return { rel: 'tomorrow', word: t('kuliahWhenTomorrow', lang), date: `${fmtWeekday(date, lang)}${commaOf(lang)}${dayMonth}` };
  return { rel: 'later', word: fmtWeekday(date, lang), date: dayMonth };
}

/** The kuliah a slot shows: its own item, or (a slot with no item, the `?card=` aid) the first the TV would rotate. */
function kuliahOf(content: CardProps['content'], itemId: string | null, view: CardProps['view']): KuliahView | undefined {
  if (itemId !== null) return content.kuliah.find((k) => k.id === itemId);
  return kuliahOnScreen(content.kuliah, view.settings, view.now)[0];
}

/**
 * One kuliah on the whole screen (theme round 2, rule 11): the rotation gives every kuliah of the Tetapan window
 * (today up to today + kuliahCard.daysAhead) a slot of its own, today's or the nearest first. The speaker's photo, the
 * enlarged day and date ("Hari ini" highlighted, "Esok", else the weekday), the label, the name, the topic and the facts
 * (time, after which prayer, the book), and the book cover. A long name or topic shrinks through `--fit`. Tetapan decides
 * the photo and its shape (penceramahPhoto) and the book cover (kitabCover: the cover picture, or a printed title block
 * when the kitab has none; the facts then do not repeat the title). A cancelled kuliah keeps its slot with the ribbon.
 */
export function KuliahScreen({ view, lang, content, itemId, onRendered }: CardProps) {
  const { settings, now } = view;
  const timeFormat = settings.prayerBar.timeFormat === '24h' ? '24h' : '12h';
  const today = dateOf(now, view.tz);
  const k = kuliahOf(content, itemId, view);
  // A short kuliah grows a little to fill the area (theme round 2, maximise the screen); a long one steps down.
  const { ref, fit } = useFit<HTMLElement>(k?.id ?? '', { max: KULIAH_FIT_MAX });
  // No item (removed under the rotation): tell the content layer, so the band reads as empty and Main goes idle.
  const rendered = !!k;
  useEffect(() => {
    onRendered?.(rendered);
  }, [rendered, onRendered]);
  if (!k) return null;

  const day = kuliahDayOf(k.date, today, lang);
  const photo = settings.penceramahPhoto.enabled ? assetSrc(k.penceramah?.photoAssetId) : null;
  const facts: Array<[string, string]> = [[t('factTime', lang), fmtTimeOfDay(k.time, lang, timeFormat)]];
  if (k.slot !== 'lain') facts.push([t('factAfter', lang), t('factAfterPrayer', lang, { prayer: prayerLabel(k.slot, lang) })]);
  const kitab = k.kitab;
  const showCover = settings.kitabCover.enabled && kitab !== undefined;
  const cover = showCover ? assetSrc(kitab?.coverAssetId) : null;
  // The title block spells the title itself; the facts then leave it out.
  if (kitab && !(showCover && !cover)) facts.push([t('factBook', lang), kitab.title]);

  return (
    <article
      class={`kuliah is-${day.rel}${k.status === 'batal' ? ' is-batal' : ''}${showCover ? ' has-kitab' : ''}`}
      data-card="kuliahCard"
      data-item={k.id}
      ref={ref}
      style={`--fit:${fit}`}
    >
      {photo ? (
        <div class={`kul-photo is-${settings.penceramahPhoto.shape === 'square' ? 'square' : 'round'}`}>
          <img src={photo} alt="" />
        </div>
      ) : null}
      <div class="kul-body">
        <div class={`kul-day is-${day.rel}`} data-testid="kul-day">
          <span class="kul-day-word">{day.word}</span>
          <span class="kul-day-date">{day.date}</span>
        </div>
        <div class="kul-label">{k.label}</div>
        {k.penceramah ? <div class="kul-name">{k.penceramah.name}</div> : null}
        {k.topic ? <div class="kul-topic">{k.topic}</div> : null}
        <div class="kul-facts">
          {facts.map(([key, v]) => (
            <div key={key}>
              <span>{key}</span>
              <b class="num">{v}</b>
            </div>
          ))}
        </div>
        {k.status === 'batal' ? <div class="kul-batal">{t('batal', lang)}</div> : null}
      </div>
      {showCover && kitab ? (
        <div class={`kul-kitab${cover ? ' has-img' : ''}`}>
          {cover ? <img src={cover} alt="" /> : <span class="kul-kitab-title">{kitab.title}</span>}
        </div>
      ) : null}
    </article>
  );
}
