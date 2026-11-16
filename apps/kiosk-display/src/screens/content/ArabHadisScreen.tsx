import type { CardProps } from '../../content/ContentLayer.tsx';
import { useHadisSlot } from '../../content/cards/HadisCard.tsx';
import { t } from '../../i18n.ts';
import { useArabEnv } from '../../themes/arabContext.ts';
import { Hk } from '../../ui/Hk.tsx';
import { tarjamahMode } from './arabLook.ts';

/**
 * The Arabic-led hadis screen: the matn large in Arabic, the translation under it (or beside it, or hidden), then the
 * source and the grade. Only for a hadis that is one page with Arabic (a hadis in parts keeps the normal screen); the
 * same Tetapan rules as the normal look. The HadeethEnc credit stays.
 */
export function ArabHadisScreen(props: CardProps) {
  const { lang, view } = props;
  const env = useArabEnv();
  const slot = useHadisSlot(props);
  // (a page of the Malay translation, once the layout pages a long hadis, has no Arabic: it still shows, on this screen)
  if (!slot || (slot.shown.ar === null && slot.shown.ms === '' && slot.text.body === '')) return null;
  const { h, tier, shown, text, grade, attribution, ref, fit, nPages, sub } = slot;
  const showMalay = (view.settings.hadis as { showMalay?: unknown } | undefined)?.showMalay !== false;
  const mode = tarjamahMode(env.style, showMalay);
  const ms = nPages > 1 ? shown.ms : text.intro ? `${text.intro} ${text.body}` : text.body;
  return (
    <article class={`arab-hadis is-len-${tier}`} data-card="hadis" data-item={h.id} ref={ref} style={`--fit:${fit}`}>
      {shown.ar !== null ? <Hk class="ah-ar" text={shown.ar} /> : null}
      {(mode !== 'hidden' || shown.ar === null) && ms !== '' ? <p class="ah-ms arab-tarjamah">{ms}</p> : null}
      {attribution || grade ? (
        <div class="ah-src">
          {attribution ? <span class="ah-attr">{attribution}</span> : null}
          {attribution && grade ? <i class="sep" aria-hidden="true" /> : null}
          {grade ? <span class="ah-grade">{grade}</span> : null}
          {nPages > 1 ? <span class="ah-pg num">{`${sub + 1} / ${nPages}`}</span> : null}
        </div>
      ) : null}
      {h.credit ? <div class="ah-credit">{`${t('sumber', lang)}: ${h.credit}`}</div> : null}
    </article>
  );
}
