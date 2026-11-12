import type { KioskContent, Zikir } from '@surau/core';
import type { ContentView } from '../data/content.ts';
import type { KioskView } from '../data/kiosk.ts';
import { prayerLabel } from '../format.ts';
import { t } from '../i18n.ts';
import type { Lang } from '../i18n.ts';
import { num } from './assets.ts';
import { useFit } from './paging.ts';

export type ZikirWindow = NonNullable<ContentView['zikir']>;

export interface ZikirOverlayProps {
  view: KioskView;
  lang: Lang;
  content: KioskContent;
  zikir: ZikirWindow;
}

/** Arabic size tier by length: a short zikir fills the panel, a long doa steps down (useFit guards the rest). */
export function zikirTier(textAr: string): 'xl' | 'l' | 'm' | 's' {
  let n = 0;
  for (const ch of textAr) if (/\p{L}/u.test(ch)) n++;
  return n <= 30 ? 'xl' : n <= 70 ? 'l' : n <= 140 ? 'm' : 's';
}

/** The zikir on screen at `now`: items by `order`, one per `durationSeconds`, counted from the window start. */
export function zikirAt(items: Zikir[], now: Date, zikir: ZikirWindow, durationSeconds: number, minutesAfterSolat: number): { item: Zikir; index: number } | null {
  const sorted = [...items].sort((a, b) => a.order - b.order);
  if (sorted.length === 0) return null;
  const dur = durationSeconds > 0 ? durationSeconds : 20;
  const startMs = zikir.endsAt.getTime() - Math.max(0, minutesAfterSolat) * 60_000;
  const elapsed = Math.max(0, (now.getTime() - startMs) / 1000);
  const index = Math.floor(elapsed / dur) % sorted.length;
  return { item: sorted[index]!, index };
}

/**
 * Zikir selepas solat: fills the content band (left gutter to right gutter) in place of the rotation while the
 * zikir window is open. Arabic centred in the Quran face, the Malay meaning under it, the repeat count as a badge.
 * Lives only inside Main, so no prayer phase can show it.
 */
export function ZikirOverlay({ view, lang, content, zikir }: ZikirOverlayProps) {
  const { settings, now } = view;
  const z = settings.zikirSelepasSolat as unknown as { durationSeconds?: unknown; minutesAfterSolat?: unknown };
  const sorted = content.zikir;
  const cur = zikirAt(sorted, now, zikir, num(z.durationSeconds, 20), num(z.minutesAfterSolat, 10));
  const key = cur ? `${cur.item.id}|${cur.index}` : '';
  const { ref, fit } = useFit<HTMLDivElement>(key);
  if (!cur) return null;
  const { item, index } = cur;
  const repeat = typeof item.repeat === 'number' && item.repeat > 1 ? item.repeat : null;

  return (
    <section class="zikir glass" data-layer="zikir" data-prayer={zikir.prayer} data-item={item.id}>
      <header class="card__head zikir__head">
        <span class="card__tag">{t('zikirAfter', lang, { prayer: prayerLabel(zikir.prayer, lang) })}</span>
        <span class="zikir__count num">{`${index + 1} / ${sorted.length}`}</span>
      </header>
      <div class={`zikir__page is-${zikirTier(item.textAr)}${repeat ? ' has-repeat' : ''}`} key={key} ref={ref} style={`--fit:${fit}`}>
        <p class="zikir__ar arabic" dir="rtl" lang="ar">{item.textAr}</p>
        <p class="zikir__ms">{item.textMs}</p>
      </div>
      {repeat ? (
        <span class="zikir__repeat">
          <b class="num">{`×${repeat}`}</b>
          <small>{t('timesWord', lang)}</small>
        </span>
      ) : null}
    </section>
  );
}
