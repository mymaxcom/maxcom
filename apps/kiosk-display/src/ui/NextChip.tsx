import type { KioskState } from '@surau/core';
import type { KioskView } from '../data/kiosk.ts';
import { fmtClock, prayerLabel } from '../format.ts';
import { PRAYER_AR, t } from '../i18n.ts';
import type { Lang } from '../i18n.ts';
import { justInOf, visibleNextOf } from './visibleNext.ts';

export interface NextChipProps {
  view: Pick<KioskView, 'state' | 'settings' | 'now' | 'tz'>;
  lang: Lang;
  /** A test hook (the live screen's chip). */
  testId?: string;
}

const p2 = (n: number): string => String(n).padStart(2, '0');

/**
 * What the chip counts (theme round 2, rules 4 and 5): hours and minutes left, the minutes rounded up ('00:27', '02:12';
 * the last minute reads '00:01'), so the chip changes once a minute. In the last minute, when Tetapan shows the clock's
 * seconds, only the seconds left ('45'). Never negative.
 */
export function chipLeft(ms: number, showSeconds: boolean): string {
  const left = Math.max(0, Number.isFinite(ms) ? ms : 0);
  if (showSeconds && left > 0 && left <= 60_000) return String(Math.ceil(left / 1000));
  const mins = Math.ceil(left / 60_000);
  return `${p2(Math.floor(mins / 60))}:${p2(mins % 60)}`;
}

/** The small hourglass beside the countdown: the chip says how long without a word. */
function Hourglass() {
  return (
    <svg class="chip-hg" viewBox="0 0 20 24" aria-hidden="true" focusable="false">
      <path
        d="M3 2h14M3 22h14M5 2c0 6 10 6 10 10S5 16 5 22M15 2c0 6-10 6-10 10s10 4 10 10"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
      />
    </svg>
  );
}

/**
 * The next-prayer chip of the content and live screens: the Arabic name (shown by themes that turn it on), the name and
 * the time of the next prayer the strip highlights (a hidden Imsak or Syuruk is skipped), then an hourglass and the time
 * left (`chipLeft`). For three minutes after a prayer time it names that prayer and says "Masuk waktu" instead
 * (`.is-now`, rule 6), then moves on to the next prayer.
 */
export function NextChip({ view, lang, testId }: NextChipProps) {
  const { state, settings, now, tz } = view;
  const timeFormat = settings.prayerBar.timeFormat === '24h' ? '24h' : '12h';
  const showSeconds = settings.clock.showSeconds === true;
  const justIn = justInOf(state, settings, now, tz);
  const next: NonNullable<KioskState['next']> | null = justIn ?? visibleNextOf(state, settings, now, tz);
  if (!next) return null;
  const c = fmtClock(next.at, timeFormat, false, lang, tz);
  const ar = (PRAYER_AR as Record<string, string>)[next.name] ?? '';
  return (
    <div class={`region-next next--chip${justIn ? ' is-now' : ''}`} data-role="next" data-testid={testId}>
      {ar !== '' ? <span class="next-ar arab">{ar}</span> : null}
      <span class="chip-k" data-must="">{prayerLabel(next.name, lang)}</span>
      <span class="chip-t num" data-must="">
        {c.hm}
        {c.ampm ? <small class="chip-ap">{c.ampm}</small> : null}
      </span>
      {justIn ? (
        <span class="chip-cd chip-cd--now">{t('chipNow', lang)}</span>
      ) : (
        <span class="chip-cd" role="timer">
          <Hourglass />
          <b class="num">{chipLeft(next.at.getTime() - now.getTime(), showSeconds)}</b>
        </span>
      )}
    </div>
  );
}
