import { zikirTier, useZikirSlot } from '../../content/ZikirOverlay.tsx';
import type { ZikirOverlayProps } from '../../content/ZikirOverlay.tsx';
import { prayerLabel } from '../../format.ts';
import { t } from '../../i18n.ts';
import { useArabEnv } from '../../themes/arabContext.ts';
import { Hk } from '../../ui/Hk.tsx';
import { tarjamahMode } from './arabLook.ts';

/** The 33 beads of the ring, drawn in code on a circle of radius 380 in a 840 square (same as the mockup). */
const BEADS = Array.from({ length: 33 }, (_, i) => {
  const a = (i / 33) * Math.PI * 2 - Math.PI / 2;
  return { x: Math.round(380 * Math.cos(a) * 10) / 10, y: Math.round(380 * Math.sin(a) * 10) / 10 };
});

/**
 * The Arabic-led zikir screen: the zikir selepas solat in a ring of beads, the Arabic large in the middle, the meaning
 * under it, the repeat count at the side (only above one). The same item, order, timing and paging as the overlay.
 */
export function ArabZikirScreen(props: ZikirOverlayProps) {
  const { lang, zikir } = props;
  const env = useArabEnv();
  const slot = useZikirSlot(props);
  // (a Malay page of a paged zikir has no Arabic: it still shows, with the ring)
  if (!slot || (slot.shown.ar === null && slot.shown.ms === '')) return null;
  const { item, shown, repeat, ref, fit, key, pages, sub } = slot;
  const mode = tarjamahMode(env.style, shown.ms !== '');
  return (
    <section class={`arab-zikir is-${zikirTier(item.textAr)}`} data-layer="zikir" data-prayer={zikir.prayer} data-item={item.id} ref={ref} style={`--fit:${fit}`} key={key}>
      <div class="zk-side">
        <div class="eyebrow">{t('zikirAfter', lang, { prayer: prayerLabel(zikir.prayer, lang) })}</div>
        {pages > 1 ? <span class="zk-pg num">{`${sub + 1} / ${pages}`}</span> : null}
      </div>
      <svg class="zk-ring" viewBox="-420 -420 840 840" aria-hidden="true">
        <circle class="zk-orbit" r="380" />
        <g class="zk-beads">
          {BEADS.map((b, i) => <circle key={i} cx={b.x} cy={b.y} r="11" />)}
        </g>
      </svg>
      {shown.ar !== null ? <Hk class="zk-ar" text={shown.ar} /> : null}
      {(mode !== 'hidden' || shown.ar === null) && shown.ms !== '' ? <div class="zk-ms arab-tarjamah">{shown.ms}</div> : null}
      {repeat ? (
        <div class="zk-count">
          <b class="num">{repeat}</b>
          <span>{t('timesWord', lang)}</span>
        </div>
      ) : null}
    </section>
  );
}
