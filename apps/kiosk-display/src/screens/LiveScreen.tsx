import type { KioskView } from '../data/kiosk.ts';
import type { LiveView } from '../data/live.ts';
import { fmtGregorian, fmtHijri, prayerLabel } from '../format.ts';
import { surauNameOf, t } from '../i18n.ts';
import type { Lang } from '../i18n.ts';
import { LiveStrip } from '../live/LiveLayer.tsx';
import { Clock } from '../ui/Clock.tsx';
import { Countdown } from '../ui/Countdown.tsx';
import { nameShownOf, SurauLogo } from '../ui/Logo.tsx';
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
 * open, the live takes priority over every other screen. The video owns the main area, a 16:9 frame top-left
 * (.live-screen__frame; the app's .live element is placed on exactly the same box from the same custom
 * properties, live.css); a side column keeps compact identity, the clock and the dates; the bottom row is the
 * kuliah strip under the video and the next prayer chip under the side column. No prayer table, no cards, no
 * ticker. Every template dresses the same DOM through its custom properties (templates.css).
 */
export function LiveScreen({ view, live, lang, onAir }: LiveScreenProps) {
  const { state, settings, now, hijri, logo, tz } = view;
  const timeFormat = settings.prayerBar.timeFormat === '24h' ? '24h' : '12h';
  const showSeconds = settings.clock.showSeconds === true;
  const next = state.next;
  const showStrip = settings.liveOnKiosk?.showStrip !== false || !onAir;
  return (
    <div class="screen screen--live" data-screen="live" data-playing={onAir ? 'true' : 'false'}>
      <div class="live-screen__frame" data-testid="live-frame">
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
        <div class={`live-screen__ident ident__head${logo ? ' has-logo' : ''}`}>
          <SurauLogo src={logo} class="ident__logo" />
          {nameShownOf(settings, logo) ? <div class="ident__name">{surauNameOf(settings, lang)}</div> : null}
        </div>
        <div class="live-screen__time">
          <Clock now={now} timeFormat={timeFormat} showSeconds={showSeconds} lang={lang} tz={tz} />
          <div class="live-screen__dates">
            <span class="live-screen__greg">{fmtGregorian(now, lang, tz)}</span>
            {hijri ? <span class="live-screen__hijri">{fmtHijri(hijri, lang)}</span> : null}
          </div>
        </div>
      </aside>

      <div class="live-screen__strip">
        {showStrip ? (
          <QuietBoundary>
            <LiveStrip live={live} lang={lang} onAir={onAir} />
          </QuietBoundary>
        ) : null}
      </div>

      {next ? (
        <div class="live-screen__next glass" data-testid="live-next">
          <span class="live-screen__next-label">{t('nextIn', lang, { prayer: prayerLabel(next.name, lang) })}</span>
          <Countdown to={next.at} now={now} class="live-screen__next-cd" />
        </div>
      ) : null}
    </div>
  );
}
