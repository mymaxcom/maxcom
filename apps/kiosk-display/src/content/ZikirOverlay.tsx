import type { KioskContent, Zikir } from '@surau/core';
import type { ContentView } from '../data/content.ts';
import type { KioskView } from '../data/kiosk.ts';
import { prayerLabel } from '../format.ts';
import { t } from '../i18n.ts';
import type { Lang } from '../i18n.ts';
import { num } from './assets.ts';
import { planHadisPages } from './cards/HadisCard.tsx';
import { pageAt, useFit } from './paging.ts';
import { useScale } from './scale.ts';

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
export function zikirAt(items: Zikir[], now: Date, zikir: ZikirWindow, durationSeconds: number, minutesAfterSolat: number): { item: Zikir; index: number; startedAt: Date } | null {
  const sorted = [...items].sort((a, b) => a.order - b.order);
  if (sorted.length === 0) return null;
  const dur = durationSeconds > 0 ? durationSeconds : 20;
  const startMs = zikir.endsAt.getTime() - Math.max(0, minutesAfterSolat) * 60_000;
  const elapsed = Math.max(0, (now.getTime() - startMs) / 1000);
  const turn = Math.floor(elapsed / dur);
  const index = turn % sorted.length;
  return { item: sorted[index]!, index, startedAt: new Date(startMs + turn * dur * 1000) };
}

export interface ZikirSlot {
  item: Zikir;
  index: number;
  total: number;
  /** The Arabic and the Malay this slot shows now (after the layout's paging). */
  shown: { ar: string | null; ms: string };
  /** Pages the item is shown over (1 at the usual size) and the one on screen. */
  pages: number;
  sub: number;
  repeat: number | null;
  key: string;
  ref: ReturnType<typeof useFit<HTMLDivElement>>['ref'];
  fit: number;
}

/**
 * What the zikir window shows now: the item by order and time, over as many pages as the measured layout needs (a long
 * doa is never cut), and its repeat count. Shared by the overlay and the Arabic-led zikir screen; null with no item.
 */
export function useZikirSlot({ view, content, zikir }: ZikirOverlayProps): ZikirSlot | null {
  const { settings, now } = view;
  const z = settings.zikirSelepasSolat as unknown as { durationSeconds?: unknown; minutesAfterSolat?: unknown };
  const sorted = content.zikir;
  const dur = num(z.durationSeconds, 20) > 0 ? num(z.durationSeconds, 20) : 20;
  const cur = zikirAt(sorted, now, zikir, num(z.durationSeconds, 20), num(z.minutesAfterSolat, 10));
  const key = cur ? `${cur.item.id}|${cur.index}` : '';
  // The text size (Ubah suai) re-measures the fit too, without remounting the page (`key` stays the item's).
  const scale = useScale();
  const { ref, fit, pages } = useFit<HTMLDivElement>(`${key}|${scale}`, { paged: true });
  if (!cur) return null;
  const { item, index } = cur;
  // A long doa, or a larger text size, that will not fit shows over pages (Arabic first, then the meaning), never cut.
  const plan = planHadisPages(item.textAr, item.textMs, pages);
  const n = plan.length;
  const sub = n > 1 ? pageAt(now, cur.startedAt, dur / n, n, view.tz) : 0;
  const shown = plan[sub] ?? { ar: item.textAr, ms: item.textMs };
  const repeat = typeof item.repeat === 'number' && item.repeat > 1 ? item.repeat : null;
  return { item, index, total: sorted.length, shown, pages: n, sub, repeat, key, ref, fit };
}

/**
 * Zikir selepas solat: fills the content band (left gutter to right gutter) in place of the rotation while the
 * zikir window is open. Arabic centred in the Quran face, the Malay meaning under it, the repeat count as a badge.
 * Lives only inside Main, so no prayer phase can show it.
 */
export function ZikirOverlay(props: ZikirOverlayProps) {
  const { lang, zikir } = props;
  const slot = useZikirSlot(props);
  if (!slot) return null;
  const { item, index, total, shown, pages: n, sub, repeat, key, ref, fit } = slot;

  return (
    <section class="zikir region-main glass" data-layer="zikir" data-prayer={zikir.prayer} data-item={item.id}>
      <header class="card__head zikir__head">
        <span class="card__tag">{t('zikirAfter', lang, { prayer: prayerLabel(zikir.prayer, lang) })}</span>
        <span class="zikir__count num">{`${index + 1} / ${total}`}{n > 1 ? ` · ${sub + 1}/${n}` : ''}</span>
      </header>
      <div class={`zikir__page is-${zikirTier(item.textAr)}${repeat ? ' has-repeat' : ''}`} key={key} ref={ref} style={`--fit:${fit}`}>
        {shown.ar !== null ? <p class="zikir__ar arab arabic" dir="rtl" lang="ar">{shown.ar}</p> : null}
        {shown.ms !== '' ? <p class="zikir__ms arab-tarjamah">{shown.ms}</p> : null}
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
