import { dateOf, offsetMinutes } from '@surau/core';
import { prayerLabel } from '../../format.ts';
import { fmtDateShort, fmtTimeOfDay, t } from '../../i18n.ts';
import { assetSrc, num } from '../../content/assets.ts';
import type { CardProps } from '../../content/ContentLayer.tsx';
import { pickKuliah } from '../../content/cards/KuliahCard.tsx';
import { useFit } from '../../content/paging.ts';

/**
 * The kuliah screen: the speaker's photo and, beside it, the label, the name, the topic and the facts (time, after
 * which prayer, the book). The same pick as the old card (today's or the next kuliah); a long name or topic shrinks
 * through `--fit`. Tetapan decides the photo (penceramahPhoto) and how many days ahead are looked at.
 */
export function KuliahScreen({ view, lang, content }: CardProps) {
  const { settings, now } = view;
  const timeFormat = settings.prayerBar.timeFormat === '24h' ? '24h' : '12h';
  const today = dateOf(now, view.tz);
  const kl = new Date(now.getTime() + offsetMinutes(now, view.tz) * 60_000);
  const nowMin = kl.getUTCHours() * 60 + kl.getUTCMinutes();
  const main = pickKuliah(content.kuliah, today, nowMin, num(settings.kuliahCard.daysAhead, 7))[0];
  const { ref, fit } = useFit<HTMLDivElement>(main?.id ?? '');
  if (!main) return null;

  const isToday = main.date === today;
  const photo = settings.penceramahPhoto.enabled ? assetSrc(main.penceramah.photoAssetId) : null;
  const time = fmtTimeOfDay(main.time, lang, timeFormat);
  const facts: Array<[string, string]> = [[t('factTime', lang), isToday ? time : `${fmtDateShort(main.date, lang)}, ${time}`]];
  if (main.slot !== 'lain') facts.push([t('factAfter', lang), t('factAfterPrayer', lang, { prayer: prayerLabel(main.slot, lang) })]);
  if (main.kitab) facts.push([t('factBook', lang), main.kitab.title]);

  return (
    <article class={`kuliah${main.status === 'batal' ? ' is-batal' : ''}`} data-card="kuliahCard" data-item={main.id} ref={ref} style={`--fit:${fit}`}>
      {photo ? (
        <div class={`kul-photo is-${settings.penceramahPhoto.shape === 'square' ? 'square' : 'round'}`}>
          <img src={photo} alt="" />
        </div>
      ) : null}
      <div class="kul-body">
        <div class="eyebrow">{t(isToday ? 'kuliahToday' : 'kuliahNext', lang)}</div>
        <div class="kul-label">{main.label}</div>
        <div class="kul-name">{main.penceramah.name}</div>
        {main.topic ? <div class="kul-topic">{main.topic}</div> : null}
        <div class="kul-facts">
          {facts.map(([k, v]) => (
            <div key={k}>
              <span>{k}</span>
              <b class="num">{v}</b>
            </div>
          ))}
        </div>
        {main.status === 'batal' ? <div class="kul-batal">{t('batal', lang)}</div> : null}
      </div>
    </article>
  );
}
