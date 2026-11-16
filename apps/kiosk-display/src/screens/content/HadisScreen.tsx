import { t } from '../../i18n.ts';
import type { CardProps } from '../../content/ContentLayer.tsx';
import { useHadisSlot } from '../../content/cards/HadisCard.tsx';
import { harakatOn } from '../../themes/styleVars.ts';
import { useArabEnv } from '../../themes/arabContext.ts';
import { Hk } from '../../ui/Hk.tsx';

/**
 * The hadis screen: Arabic over the Malay text, the source and the grade under them, centred in the whole main
 * area. The same Tetapan rules as the old card (showArabic, showMalay, grade, attribution, parts for a long hadis, one
 * part per slot); a text that does not fit shrinks through `--fit`, then takes more pages, and is never cut.
 */
export function HadisScreen(props: CardProps) {
  const { lang } = props;
  const slot = useHadisSlot(props);
  // The two-layer text is drawn only when the harakat colour is on (spec 6.12.2); otherwise one plain paragraph.
  const harakat = harakatOn(useArabEnv().style);
  if (!slot) return null;
  const { h, tier, parts, partIndex, nPages, sub, shown, text, malayOn, grade, attribution, ref, fit } = slot;
  const partLabel = parts ? `${t('bahagian', lang)} ${partIndex + 1} ${t('daripada', lang)} ${parts.length}` : null;
  return (
    <article class={`hadis is-len-${tier}`} data-card="hadis" data-item={h.id} data-page={parts ? partIndex : undefined} ref={ref} style={`--fit:${fit}`}>
      <div class="eyebrow">
        {t('hadis', lang)}
        {partLabel ? <span class="hadis-part num">{partLabel}</span> : null}
        {nPages > 1 ? <span class="hadis-part num">{`${sub + 1} / ${nPages}`}</span> : null}
      </div>
      {shown.ar !== null ? (
        harakat ? <Hk class="hadis-ar" text={shown.ar} /> : <p class="hadis-ar arab" dir="rtl" lang="ar">{shown.ar}</p>
      ) : null}
      {malayOn && shown.ms !== '' ? (
        nPages > 1 || parts ? (
          <p class="hadis-ms arab-tarjamah">{shown.ms}</p>
        ) : (
          <p class="hadis-ms arab-tarjamah">
            {text.intro ? <span class="hadis-intro">{text.intro} </span> : null}
            {text.body}
          </p>
        )
      ) : null}
      {attribution || grade || h.credit ? (
        <div class="hadis-src">
          {attribution ? <span class="hadis-attr">{attribution}</span> : null}
          {attribution && grade ? <span class="sep" aria-hidden="true" /> : null}
          {grade ? <span class="hadis-grade">{grade}</span> : null}
          {h.credit ? <span class="hadis-credit">{`${t('sumber', lang)}: ${h.credit}`}</span> : null}
        </div>
      ) : null}
    </article>
  );
}
