import { instantOf } from '@surau/core';
import type { KioskState, PrayerName, Settings } from '@surau/core';
import { fmtPrayerTime, prayerLabel } from '../format.ts';
import { t } from '../i18n.ts';
import type { Lang } from '../i18n.ts';
import { Countdown } from './Countdown.tsx';

const ORDER: readonly PrayerName[] = ['imsak', 'subuh', 'syuruk', 'zohor', 'asar', 'maghrib', 'isyak'];
const MINOR = new Set<PrayerName>(['imsak', 'syuruk']);

/** Phases during which the highlighted cell is the prayer in progress, not the next one. */
const IN_PROGRESS = new Set<KioskState['phase']>(['azanCountdown', 'masukWaktu', 'khutbah', 'iqamah', 'solat', 'tarawih']);

/** Static pill word per in-progress phase (i18n key); iqamah/azanCountdown count down instead. */
const PHASE_WORD: Partial<Record<KioskState['phase'], string>> = {
  masukWaktu: 'barAzan',
  khutbah: 'barKhutbah',
  solat: 'barSolat',
  tarawih: 'barTarawih',
};

export interface PrayerBarProps {
  state: KioskState;
  settings: Settings;
  lang: Lang;
  now: Date;
  dimmed?: boolean;
  /** The surau's IANA zone; Kuala Lumpur when omitted. */
  tz?: string;
}

/** The bar cell a state prayer name lands on: Friday 'jumaat' is the Zohor cell. */
function cellOf(name: string | null | undefined): PrayerName | null {
  if (!name) return null;
  return (name === 'jumaat' ? 'zohor' : name) as PrayerName;
}

/**
 * Bottom frosted bar: seven cells. Outside a prayer the next prayer is filled with the
 * accent and counts down; while a prayer is in progress (azan, iqamah, solat, khutbah,
 * tarawih) that prayer keeps the highlight and its pill names the phase.
 */
export function PrayerBar({ state, settings, lang, now, dimmed = false, tz = 'Asia/Kuala_Lumpur' }: PrayerBarProps) {
  const day = state.today;
  if (!day) return null;
  const pb = settings.prayerBar;
  const timeFormat = pb.timeFormat === '24h' ? '24h' : '12h';
  const inProgress = IN_PROGRESS.has(state.phase) && !!state.prayer;
  const currentCell: PrayerName | null = inProgress ? cellOf(state.prayer) : cellOf(state.next?.name);

  const cells = ORDER.filter((p) => {
    if (p === 'imsak' && pb.showImsak === false) return false;
    if (p === 'syuruk' && pb.showSyuruk === false) return false;
    return true;
  });

  // The cell to highlight may be hidden (Imsak or Syuruk switched off): then the next
  // VISIBLE prayer takes the highlight with its own countdown. Its instant comes from
  // today's row; once that time has passed (tomorrow's Imsak is next after Isyak) the
  // same wall-clock time a day later stands in until the day rolls over.
  let highlight: PrayerName | null = currentCell;
  let standInAt: Date | null = null;
  if (currentCell && !cells.includes(currentCell)) {
    const after = ORDER.slice(ORDER.indexOf(currentCell) + 1);
    highlight = after.find((p) => cells.includes(p)) ?? null;
    if (highlight) {
      try {
        let at = instantOf(day.date, day.times[highlight], tz);
        if (at.getTime() <= now.getTime()) at = new Date(at.getTime() + 86_400_000);
        standInAt = at;
      } catch {
        standInAt = null;
      }
    }
  }

  const pill = () => {
    if (highlight !== currentCell) {
      return standInAt ? <Countdown to={standInAt} now={now} class="pcell__cd" /> : null;
    }
    if (!inProgress) {
      return state.next ? <Countdown to={state.next.at} now={now} class="pcell__cd" /> : null;
    }
    switch (state.phase) {
      case 'azanCountdown':
        return <Countdown to={state.phaseEndsAt} now={now} class="pcell__cd" />;
      case 'iqamah':
        return (
          <span class="pcell__cd pcell__cd--phase">
            <span class="pcell__tag">{t('barIqamah', lang)}</span>
            <Countdown to={state.phaseEndsAt} now={now} />
          </span>
        );
      default: {
        const key = PHASE_WORD[state.phase];
        return key ? <span class="pcell__cd pcell__cd--word">{t(key, lang)}</span> : null;
      }
    }
  };

  return (
    <div class={`pbar glass${dimmed ? ' is-dimmed' : ''}`} role="list" aria-label={t('barCaption', lang)}>
      {cells.map((p) => {
        const isCurrent = p === highlight;
        const label = p === 'zohor' && state.isJumaat && settings.jumaat.enabled ? 'jumaat' : p;
        return (
          <div
            key={p}
            role="listitem"
            data-prayer={p}
            class={`pcell${MINOR.has(p) ? ' is-minor' : ''}${isCurrent ? ' is-current' : ''}`}
            aria-current={isCurrent ? 'true' : undefined}
          >
            <span class="pcell__label">{prayerLabel(label, lang)}</span>
            <span class="pcell__time num">{fmtPrayerTime(day.times[p], timeFormat)}</span>
            {isCurrent ? pill() : null}
          </div>
        );
      })}
    </div>
  );
}
