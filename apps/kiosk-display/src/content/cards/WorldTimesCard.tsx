import type { WorldTime } from '@surau/core';
import { t } from '../../i18n.ts';
import type { Lang } from '../../i18n.ts';
import type { CardProps } from '../ContentLayer.tsx';

/** Tiles readable from 10 m: six at most, two rows of three. */
const MAX_CITIES = 6;
const KL_TZ = 'Asia/Kuala_Lumpur';

const p2 = (n: number): string => String(n).padStart(2, '0');

interface Wall { y: number; mo: number; d: number; h: number; mi: number }

/** Wall-clock fields of `now` in `zone` (throws RangeError for an unknown zone). */
function wallClock(zone: string, now: Date): Wall {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(now);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute') };
}

export interface CityTime {
  /** '10:00' (12h, no suffix) or '07:00' (24h). */
  time: string;
  /** 'PG' / 'PTG' (ms) or 'am' / 'pm' (en) in 12h mode; '' in 24h mode. */
  period: string;
  /** Minutes ahead (+) or behind (-) Kuala Lumpur at `now`, so DST is already in it. */
  offsetMin: number;
  /** -1 when the city is still on yesterday's date, +1 when already on tomorrow's. */
  dayShift: -1 | 0 | 1;
}

/** The city's clock at `now` via Intl (DST correct); null for a zone Intl does not know, never throws. */
export function cityTime(tz: string, now: Date, timeFormat: '12h' | '24h', lang: Lang): CityTime | null {
  try {
    const a = wallClock(tz, now);
    const k = wallClock(KL_TZ, now);
    const ms = (w: Wall): number => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
    const offsetMin = Math.round((ms(a) - ms(k)) / 60_000);
    if (!Number.isFinite(offsetMin)) return null;
    const dayShift = Math.sign(Date.UTC(a.y, a.mo - 1, a.d) - Date.UTC(k.y, k.mo - 1, k.d)) as -1 | 0 | 1;
    if (timeFormat === '24h') return { time: `${p2(a.h)}:${p2(a.mi)}`, period: '', offsetMin, dayShift };
    const parts = new Intl.DateTimeFormat(lang === 'en' ? 'en-MY' : 'ms-MY', {
      timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
    }).formatToParts(now);
    const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    const hour = part('hour') || String(a.h % 12 === 0 ? 12 : a.h % 12);
    const minute = part('minute') || p2(a.mi);
    return { time: `${hour}:${minute}`, period: part('dayPeriod'), offsetMin, dayShift };
  } catch {
    return null;
  }
}

/** '+5 j', '−8 j', '+5.5 j'; '±0 j' when the city keeps KL time. */
export function fmtOffset(offsetMin: number, lang: Lang): string {
  const unit = t('hourShort', lang);
  if (offsetMin === 0) return `±0 ${unit}`;
  const hours = Math.round((Math.abs(offsetMin) / 60) * 100) / 100;
  return `${offsetMin > 0 ? '+' : '−'}${hours} ${unit}`;
}

export function WorldTimesCard({ view, lang, content }: CardProps) {
  const { settings, now } = view;
  const timeFormat = settings.prayerBar.timeFormat === '24h' ? '24h' : '12h';
  const tiles = [...content.worldTimes]
    .sort((a, b) => a.order - b.order)
    .map((w): { w: WorldTime; ct: CityTime } | null => {
      const ct = cityTime(w.tz, now, timeFormat, lang);
      return ct ? { w, ct } : null;
    })
    .filter((x): x is { w: WorldTime; ct: CityTime } => x !== null)
    .slice(0, MAX_CITIES);
  if (tiles.length === 0) return null;
  // 1-3 cities in one row, 4 as 2 x 2, 5-6 as 3 x 2 (never a lone tile on the second row).
  const cols = tiles.length <= 3 ? tiles.length : tiles.length === 4 ? 2 : 3;

  return (
    <article class="card glass card--wt" data-card="worldTimes">
      <span class="card__tag">{t('worldTimes', lang)}</span>
      <ul class={`wt__grid cols-${cols}${tiles.length > 3 ? ' is-two-rows' : ''}`}>
        {tiles.map(({ w, ct }) => (
          <li class="wt__tile" key={w.id}>
            <span class="wt__city">{w.city}</span>
            <span class="wt__clock">
              <b class="wt__time num">{ct.time}</b>
              {ct.period ? <small class="wt__period">{ct.period}</small> : null}
            </span>
            <span class="wt__offset">
              {fmtOffset(ct.offsetMin, lang)}
              {ct.dayShift !== 0 ? (
                <em class="wt__day">{t(ct.dayShift > 0 ? 'tomorrowWord' : 'yesterdayWord', lang)}</em>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </article>
  );
}
