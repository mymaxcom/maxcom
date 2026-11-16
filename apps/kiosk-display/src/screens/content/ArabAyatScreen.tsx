import { arabicIndic, pageAt, useFit } from '../../content/paging.ts';
import type { CardProps } from '../../content/ContentLayer.tsx';
import { textSizeOf } from '../../content/cards/AyatCard.tsx';
import { useScale } from '../../content/scale.ts';
import { t } from '../../i18n.ts';
import { useArabEnv } from '../../themes/arabContext.ts';
import { Hk } from '../../ui/Hk.tsx';
import { groupIndices, tarjamahMode } from './arabLook.ts';

/**
 * The Arabic-led ayat screen (an alternate look of the ayat card, chosen by the theme): the surah line, the verses in
 * the Quran face with their end marks, then the translation with the verse numbers. Tetapan decides whether a
 * translation shows (ayatCard.showTranslation) and its size (ayatCard.textSize); the menu places it below or beside. A range that will not fit
 * shrinks (`--fit`) and then takes more pages, grouped by verse; nothing is cut. The credit of the translation stays.
 */
export function ArabAyatScreen({ view, lang, content, startedAt, durationSeconds }: CardProps) {
  const a = content.ayat.today;
  const env = useArabEnv();
  const f = view.settings.ayatCard as unknown as { showTranslation?: unknown; textSize?: unknown };
  // Tetapan ayatCard.textSize (S/M/L) and the Ubah suai text size both size the text, so both re-measure the fit.
  const size = textSizeOf(f.textSize);
  const scale = useScale();
  const key = a ? `${a.surah}:${a.ayatFrom}-${a.ayatTo}|${size}|${scale}` : '';
  const { ref, fit, pages } = useFit<HTMLDivElement>(key, { paged: true });
  if (!a || a.arabic.length === 0) return null;
  const groups = groupIndices(a.arabic.length, pages);
  const pageNo = groups.length > 1 ? pageAt(view.now, startedAt, durationSeconds / groups.length, groups.length, view.tz) : 0;
  const idx = groups[pageNo] ?? groups[0]!;
  const multi = a.ayatTo > a.ayatFrom;
  const mode = tarjamahMode(env.style, f.showTranslation !== false);
  const range = multi ? `${a.ayatFrom}-${a.ayatTo}` : String(a.ayatFrom);
  const verses = idx.map((i) => `${a.arabic[i]} \u06dd${arabicIndic(a.ayatFrom + i)}`).join(' ');
  return (
    <article class={`arab-ayat is-size-${size}`} data-card="ayatCard" data-page={`${pageNo + 1}/${groups.length}`} ref={ref} style={`--fit:${fit}`}>
      <div class="aa-head">
        <span class="aa-surah">{t('arabSurahLine', lang, { name: a.surahNameMs, range })}</span>
      </div>
      <Hk class="aa-text" text={verses} quran />
      {mode !== 'hidden' ? (
        <p class="aa-tr arab-tarjamah">
          {idx.map((i) => (
            <span key={i}>
              {multi ? <span class="tr-n num">{a.ayatFrom + i}</span> : null}
              {` ${a.malay[i] ?? ''} `}
            </span>
          ))}
        </p>
      ) : null}
      <div class="aa-credit">
        <span>{content.credits.translation}</span>
        {groups.length > 1 ? <span class="num">{`${pageNo + 1} / ${groups.length}`}</span> : null}
      </div>
    </article>
  );
}
