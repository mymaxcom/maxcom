import type { KioskState, PrayerName, Settings } from '@surau/core';
import { fmtPrayerTime, prayerLabel } from '../format.ts';
import { PRAYER_AR, t } from '../i18n.ts';
import type { Lang } from '../i18n.ts';
import { cellOf, visibleNextOf, visiblePrayers } from './visibleNext.ts';

const MINOR = new Set<PrayerName>(['imsak', 'syuruk']);

/** Phases during which the highlighted cell is the prayer in progress, not the next one. */
const IN_PROGRESS = new Set<KioskState['phase']>(['azanCountdown', 'masukWaktu', 'khutbah', 'iqamah', 'solat', 'tarawih']);

export interface PrayerBarProps {
  state: KioskState;
  settings: Settings;
  lang: Lang;
  now: Date;
  dimmed?: boolean;
  /** The compact strip of the content screens (`strip--compact`, the mockup's own markup, no `.pbar`). */
  compact?: boolean;
  /** The surau's IANA zone; Kuala Lumpur when omitted. */
  tz?: string;
}

/**
 * Bottom frosted bar: seven cells (five or six when Tetapan hides Imsak or Syuruk). Outside a prayer the next prayer
 * is filled with the accent; while a prayer is in progress (azan, iqamah, solat, khutbah, tarawih) that prayer keeps
 * the highlight. No countdown inside the cell (theme round 2, rule 7): the big countdown and the chip say how long.
 */
export function PrayerBar({ state, settings, lang, now, dimmed = false, compact = false, tz = 'Asia/Kuala_Lumpur' }: PrayerBarProps) {
  const day = state.today;
  if (!day) return null;
  const pb = settings.prayerBar;
  const timeFormat = pb.timeFormat === '24h' ? '24h' : '12h';
  const inProgress = IN_PROGRESS.has(state.phase) && !!state.prayer;
  const currentCell: PrayerName | null = inProgress ? cellOf(state.prayer) : cellOf(state.next?.name);

  const cells = visiblePrayers(settings);

  // The cell to highlight may be hidden (Imsak or Syuruk switched off): then the next
  // VISIBLE prayer takes the highlight (visibleNextOf, the same prayer the headline and the chip name as next).
  let highlight: PrayerName | null = currentCell;
  if (currentCell && !cells.includes(currentCell)) {
    const vn = visibleNextOf({ next: { name: currentCell, at: now }, today: day, isJumaat: state.isJumaat }, settings, now, tz);
    highlight = cellOf(vn?.name);
  }

  // The compact strip of the content screens (the mockup's DOM: .strip--compact > .pcell > .pcell-ar, .pcell-label,
  // .pcell-time). It is not the main bar: no `.pbar`, no in-cell countdown, so the main layout's rules never reach it.
  if (compact) {
    return (
      <div data-role="prayers" data-cells={cells.length} class={`region-prayers strip strip--compact glass${dimmed ? ' is-dimmed' : ''}`} role="list" aria-label={t('barCaption', lang)}>
        {cells.map((p) => {
          const isCurrent = p === highlight;
          const label = p === 'zohor' && state.isJumaat && settings.jumaat.enabled ? 'jumaat' : p;
          return (
            <div
              key={p}
              role="listitem"
              data-prayer={p}
              data-p={p}
              class={`pcell${MINOR.has(p) ? ' is-minor' : ''}${isCurrent ? ' is-current' : ''}`}
              aria-current={isCurrent ? 'true' : undefined}
            >
              <span class="pcell-ar arab">{PRAYER_AR[label]}</span>
              <span class="pcell-label">{prayerLabel(label, lang)}</span>
              <span class="pcell-time num" data-must="">{fmtPrayerTime(day.times[p], timeFormat)}</span>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div data-role="prayers" data-cells={cells.length} class={`pbar region-prayers glass${dimmed ? ' is-dimmed' : ''}`} role="list" aria-label={t('barCaption', lang)}>
      {cells.map((p) => {
        const isCurrent = p === highlight;
        const label = p === 'zohor' && state.isJumaat && settings.jumaat.enabled ? 'jumaat' : p;
        return (
          <div
            key={p}
            role="listitem"
            data-prayer={p}
            data-p={p}
            class={`pcell${MINOR.has(p) ? ' is-minor' : ''}${isCurrent ? ' is-current' : ''}`}
            aria-current={isCurrent ? 'true' : undefined}
          >
            <span class="pcell-ar arab">{PRAYER_AR[label]}</span>
            <span class="pcell__label" data-must="">{prayerLabel(label, lang)}</span>
            <span class="pcell__time num" data-must="">{fmtPrayerTime(day.times[p], timeFormat)}</span>
          </div>
        );
      })}
    </div>
  );
}
