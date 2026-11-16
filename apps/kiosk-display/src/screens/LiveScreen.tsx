import type { KioskView } from '../data/kiosk.ts';
import type { LiveView } from '../data/live.ts';
import { fmtGregorian, fmtHijri } from '../format.ts';
import { surauNameOf, t } from '../i18n.ts';
import type { Lang } from '../i18n.ts';
import { LiveStrip } from '../live/LiveLayer.tsx';
import { Clock } from '../ui/Clock.tsx';
import { nameShownOf, SurauLogo } from '../ui/Logo.tsx';
import { NextChip } from '../ui/NextChip.tsx';
import { QuietBoundary } from '../ui/QuietBoundary.tsx';

export interface LiveScreenProps {
  view: KioskView;
  live: LiveView;
  lang: Lang;
  /** The video (owned by the app, under this screen) is playing real pictures inside the frame. */
  onAir: boolean;
}

/**
 * The live screen (data-screen="live", operator decision 2026-11-14): while a live is on and no prayer window is
 * open, the live takes priority over every other screen. The video owns the main area (`.live-screen__frame`; the
 * app's .live element is placed on exactly the same box from the same custom properties, live.css); the surau brand
 * (with its logo), the compact clock and the next-prayer chip sit in the side column (or, in the full-screen
 * layout, over the video on their own pills); the kuliah strip is under the video. No prayer table, no cards, no
 * ticker. Which layout a theme wears is `data-live-layout` on the stage (themes/index.ts): full-screen video for
 * Default and Creative, a framed video for the others (spec 6.12.6).
 */
export function LiveScreen({ view, live, lang, onAir }: LiveScreenProps) {
  const { state, settings, now, hijri, logo, tz } = view;
  const timeFormat = settings.prayerBar.timeFormat === '24h' ? '24h' : '12h';
  const showSeconds = settings.clock.showSeconds === true;
  const next = state.next;
  const showStrip = settings.liveOnKiosk?.showStrip !== false || !onAir;
  return (
    <div class="screen screen--live" data-screen="live" data-playing={onAir ? 'true' : 'false'}>
      <div class="live-screen__frame region-main" data-testid="live-frame">
        {onAir ? null : (
          <div class="live-screen__waiting" data-testid="live-waiting">
            <span class="live-screen__waiting-tag">
              <i class="live-strip__dot" aria-hidden="true" />
              {t('liveNow', lang)}
            </span>
            <span class="live-screen__waiting-text">{t('liveRunning', lang)}</span>
          </div>
        )}
      </div>

      <aside class="live-screen__side">
        <div class={`live-screen__ident region-brand brand${logo ? ' has-logo' : ''}`}>
          <SurauLogo src={logo} class="ident__logo" />
          {nameShownOf(settings, logo) ? <span class="brand-name free-text">{surauNameOf(settings, lang)}</span> : null}
        </div>
        <div class="live-screen__time">
          <Clock now={now} timeFormat={timeFormat} showSeconds={showSeconds} lang={lang} variant="shell" tz={tz} />
          <div class="live-screen__dates">
            <span class="live-screen__greg free-text">{fmtGregorian(now, lang, tz)}</span>
            {hijri ? <span class="live-screen__hijri free-text">{fmtHijri(hijri, lang)}</span> : null}
          </div>
        </div>
        {next ? <NextChip next={next} now={now} lang={lang} timeFormat={timeFormat} tz={tz} testId="live-next" /> : null}
      </aside>

      <div class="live-screen__strip">
        {showStrip ? (
          <QuietBoundary>
            <LiveStrip live={live} lang={lang} onAir={onAir} />
          </QuietBoundary>
        ) : null}
      </div>
    </div>
  );
}
