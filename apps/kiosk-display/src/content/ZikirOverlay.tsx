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

/**
 * The zikir on screen at `now`: items by `order`, each once for `durationSeconds`, counted from the window start; null
 * once the last item's time is over (the list never wraps). The span is the one of the window it is given
 * (`endsAt - startsAt`: the live window and the video anchor share it, the editor preview builds its own), so
 * `minutesAfterSolat` is accepted for callers but never changes the result.
 */
export function zikirAt(items: Zikir[], now: Date, zikir: ZikirWindow, durationSeconds: number, _minutesAfterSolat?: number): { item: Zikir; index: number; startedAt: Date } | null {
  const sorted = [...items].sort((a, b) => a.order - b.order);
  if (sorted.length === 0) return null;
  const dur = durationSeconds > 0 ? durationSeconds : 20;
  const span = (zikir.endsAt.getTime() - zikir.startsAt.getTime()) / 1000;
  const startMs = zikir.startsAt.getTime();
  const elapsed = Math.max(0, (now.getTime() - startMs) / 1000);
  if (elapsed >= span) return null;
  const index = Math.floor(elapsed / dur);
  if (index >= sorted.length) return null;
  return { item: sorted[index]!, index, startedAt: new Date(startMs + index * dur * 1000) };
}

/**
 * The meaning shown under the Arabic in the TV language: the English text on an English TV (the Malay one when it is
 * missing or blank), nothing on an Arabic TV (the Arabic is the zikir itself), the Malay text otherwise.
 */
export function zikirMeaning(item: Pick<Zikir, 'textMs' | 'textEn'>, lang: Lang): string {
  if (lang === 'ar') return '';
  if (lang === 'en') {
    const en = typeof item.textEn === 'string' ? item.textEn.trim() : '';
    if (en !== '') return en;
  }
  return item.textMs;
}

/** The zikir display choices of Tetapan (2026.11.15), with their defaults for an older stored value. */
export function zikirOptions(settings: KioskView['settings']): { showClock: boolean; showTimeLeft: boolean; look: 'theme' | 'plain' | 'arab' } {
  const z = settings.zikirSelepasSolat as unknown as { showClock?: unknown; showTimeLeft?: unknown; look?: unknown };
  const look = z.look === 'plain' || z.look === 'arab' ? z.look : 'theme';
  return { showClock: z.showClock !== false, showTimeLeft: z.showTimeLeft === true, look };
}

/** A small "time left" line: the time until the zikir window ends, in the TV language (Tetapan showTimeLeft). */
export function ZikirTimeLeft({ zikir, now, lang, class: cls }: { zikir: ZikirWindow; now: Date; lang: Lang; class?: string }) {
  // minutes and seconds ('1:08', '25:00'): short enough to read at a glance from the back of the hall
  const sec = Math.ceil(Math.max(0, zikir.endsAt.getTime() - now.getTime()) / 1000);
  const left = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  return (
    <span class={`zikir-left${cls ? ` ${cls}` : ''}`} data-role="zikir-left" role="timer">
      <span class="zikir-left__label">{t('zikirTimeLeft', lang)}</span>
      <b class="num">{left}</b>
    </span>
  );
}

export interface ZikirSlot {
  item: Zikir;
  index: number;
  total: number;
  /** The Arabic and the meaning (in the TV language, see zikirMeaning) this slot shows now (after the layout's paging). */
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
export function useZikirSlot({ view, lang, content, zikir }: ZikirOverlayProps): ZikirSlot | null {
  const { settings, now } = view;
  const z = settings.zikirSelepasSolat as unknown as { durationSeconds?: unknown; minutesAfterSolat?: unknown };
  const items = content.zikir;
  const dur = num(z.durationSeconds, 20) > 0 ? num(z.durationSeconds, 20) : 20;
  const cur = zikirAt(items, now, zikir, num(z.durationSeconds, 20), num(z.minutesAfterSolat, 10));
  const key = cur ? `${cur.item.id}|${cur.index}` : '';
  // The text size (Ubah suai) re-measures the fit too, without remounting the page (`key` stays the item's).
  const scale = useScale();
  const { ref, fit, pages } = useFit<HTMLDivElement>(`${key}|${scale}|${lang}`, { paged: true });
  if (!cur) return null;
  const { item, index } = cur;
  const meaning = zikirMeaning(item, lang);
  // A long doa, or a larger text size, that will not fit shows over pages (Arabic first, then the meaning), never cut.
  const plan = planHadisPages(item.textAr, meaning, pages);
  const n = plan.length;
  const sub = n > 1 ? pageAt(now, cur.startedAt, dur / n, n, view.tz) : 0;
  const shown = plan[sub] ?? { ar: item.textAr, ms: meaning };
  const repeat = typeof item.repeat === 'number' && item.repeat > 1 ? item.repeat : null;
  return { item, index, total: items.length, shown, pages: n, sub, repeat, key, ref, fit };
}

/**
 * Zikir selepas solat: fills the content band (left gutter to right gutter) in place of the rotation while the
 * zikir window is open. Arabic centred in the Quran face, the Malay meaning under it, the repeat count as a badge.
 * Lives only inside Main, so no prayer phase can show it.
 */
export function ZikirOverlay(props: ZikirOverlayProps) {
  const { lang, zikir, view } = props;
  const slot = useZikirSlot(props);
  if (!slot) return null;
  const { item, index, total, shown, pages: n, sub, repeat, key, ref, fit } = slot;
  const { showTimeLeft } = zikirOptions(view.settings);

  return (
    <section class="zikir region-main glass" data-layer="zikir" data-prayer={zikir.prayer} data-item={item.id}>
      <header class="card__head zikir__head">
        <span class="card__tag">{t('zikirAfter', lang, { prayer: prayerLabel(zikir.prayer, lang) })}</span>
        <span class="zikir__meta">
          {showTimeLeft ? <ZikirTimeLeft zikir={zikir} now={view.now} lang={lang} /> : null}
          <span class="zikir__count num">{`${index + 1} / ${total}`}{n > 1 ? ` · ${sub + 1}/${n}` : ''}</span>
        </span>
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
