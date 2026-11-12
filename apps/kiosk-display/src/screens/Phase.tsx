import type { KioskView } from '../data/kiosk.ts';
import { fmtGregorian, fmtPrayerTime, prayerLabel } from '../format.ts';
import { surauNameOf, t } from '../i18n.ts';
import type { Lang } from '../i18n.ts';
import { Clock } from '../ui/Clock.tsx';
import { Countdown } from '../ui/Countdown.tsx';
import { nameShownOf, SurauLogo } from '../ui/Logo.tsx';
import { EmergencyBand } from '../ui/EmergencyBand.tsx';
import { PrayerBar } from '../ui/PrayerBar.tsx';
import { SourceFooter } from '../ui/SourceFooter.tsx';

export interface PhaseProps {
  view: KioskView;
  lang: Lang;
}

/** Phases that dim the whole screen and quieten the bar. */
export const CALM_PHASES = new Set(['solat', 'tarawih']);

function warningActive(view: KioskView): boolean {
  const { state, settings, now } = view;
  if (state.phase !== 'iqamah' || !state.phaseEndsAt) return false;
  const w = settings.iqamahCountdown.endWarningSeconds;
  const secs = typeof w === 'number' ? w : 30;
  return state.phaseEndsAt.getTime() - now.getTime() <= secs * 1000;
}

/** Full-screen prayer states. Nothing from the content layer renders here (anti-goal 1). */
export function Phase({ view, lang }: PhaseProps) {
  const { state, settings, now, tz } = view;
  const timeFormat = settings.prayerBar.timeFormat === '24h' ? '24h' : '12h';
  const showSeconds = settings.clock.showSeconds === true;
  const prayer = state.prayer ? prayerLabel(state.prayer, lang) : '';
  const calm = CALM_PHASES.has(state.phase);
  const noData = state.phase === 'noData';

  let centre;
  switch (state.phase) {
    case 'azanCountdown':
      centre = (
        <>
          <h1 class="phase__title">{t('azanIn', lang, { prayer })}</h1>
          <Countdown to={state.phaseEndsAt} now={now} class="phase__big" />
        </>
      );
      break;
    case 'masukWaktu': {
      const key = state.prayer === 'jumaat' ? 'zohor' : state.prayer;
      const hhmm = key && state.today ? state.today.times[key as keyof typeof state.today.times] : null;
      centre = (
        <>
          <h1 class="phase__title">{t('masukWaktu', lang, { prayer })}</h1>
          {hhmm ? <div class="phase__time num">{fmtPrayerTime(hhmm, timeFormat)}</div> : null}
        </>
      );
      break;
    }
    case 'iqamah':
      centre = (
        <>
          <h1 class="phase__title">{t('iqamahIn', lang)}</h1>
          <Countdown to={state.phaseEndsAt} now={now} class={`phase__big${warningActive(view) ? ' is-warning' : ''}`} />
        </>
      );
      break;
    case 'solat':
      centre = (
        <div class="phase__calm">
          <h1 class="phase__title">{t('solatNow', lang)}</h1>
          <p class="phase__sub">{String(settings.solatScreen.message ?? '')}</p>
        </div>
      );
      break;
    case 'khutbah':
      centre = (
        <div class="phase__calm">
          <h1 class="phase__title">{t('khutbahNow', lang)}</h1>
          <p class="phase__sub">{t('khutbahCalm', lang)}</p>
        </div>
      );
      break;
    case 'syuruk':
      centre = (
        <>
          <h1 class="phase__title">{t('syurukIn', lang)}</h1>
          <Countdown to={state.phaseEndsAt} now={now} class="phase__big" />
          <p class="phase__sub">{t('subuhEnding', lang)}</p>
        </>
      );
      break;
    case 'isyraq':
      centre = (
        <div class="phase__calm">
          <h1 class="phase__title">{t('isyraq', lang)}</h1>
        </div>
      );
      break;
    case 'tarawih':
      centre = (
        <div class="phase__calm">
          <h1 class="phase__title">{t('tarawih', lang)}</h1>
          <p class="phase__sub">{String(settings.solatScreen.message ?? '')}</p>
        </div>
      );
      break;
    case 'noData':
    default:
      // No prayer data: the TV still shows the clock and the date, never only text,
      // and no prayer-time digits at all.
      centre = (
        <div class="phase__nodata">
          <Clock now={now} timeFormat={timeFormat} showSeconds={showSeconds} lang={lang} tz={tz} />
          <div class="phase__date">{fmtGregorian(now, lang, tz)}</div>
          <h1 class="phase__title">{t('noData', lang)}</h1>
        </div>
      );
  }

  return (
    <div class={`screen screen--phase screen--${state.phase}`}>
      <div class="phase__head">
        <div class={`ident__head${view.logo ? ' has-logo' : ''}`}>
          <SurauLogo src={view.logo} class="ident__logo" />
          {nameShownOf(settings, view.logo) ? <div class="ident__name">{surauNameOf(settings, lang)}</div> : null}
        </div>
        {noData ? null : (
          <Clock now={now} timeFormat={timeFormat} showSeconds={showSeconds} lang={lang} variant="compact" tz={tz} />
        )}
      </div>
      <div class="phase__centre">{centre}</div>
      {noData ? null : <EmergencyBand view={view} lang={lang} />}
      {noData ? null : <PrayerBar state={state} settings={settings} lang={lang} now={now} dimmed={calm} tz={tz} />}
      {noData ? null : <SourceFooter view={view} lang={lang} />}
    </div>
  );
}
