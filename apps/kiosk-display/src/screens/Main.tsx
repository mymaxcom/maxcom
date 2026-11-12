import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { dateOf } from '@surau/core';
import type { SlotFeature } from '@surau/core';
import { useTilawah } from '../audio/tilawah.ts';
import { ContentLayer } from '../content/ContentLayer.tsx';
import { activeTickerItems, Ticker } from '../content/Ticker.tsx';
import { ZikirOverlay } from '../content/ZikirOverlay.tsx';
import { useContent } from '../data/content.ts';
import type { KioskView } from '../data/kiosk.ts';
import { useLive } from '../data/live.ts';
import { fmtGregorian, fmtHijri, prayerLabel } from '../format.ts';
import { surauNameOf, t } from '../i18n.ts';
import type { Lang } from '../i18n.ts';
import { LiveLayer } from '../live/LiveLayer.tsx';
import { Clock } from '../ui/Clock.tsx';
import { Countdown } from '../ui/Countdown.tsx';
import { EmergencyBand } from '../ui/EmergencyBand.tsx';
import { nameShownOf, SurauLogo } from '../ui/Logo.tsx';
import { PrayerBar } from '../ui/PrayerBar.tsx';
import { QuietBoundary } from '../ui/QuietBoundary.tsx';
import { SourceFooter } from '../ui/SourceFooter.tsx';

export interface MainProps {
  view: KioskView;
  lang: Lang;
}

interface RegionProps extends MainProps {
  /** A live is on air: the kuliah strip takes the band, so no card rotates and no tilawah plays. */
  live: boolean;
  onTicker: (has: boolean) => void;
  onShown: (feature: SlotFeature | null) => void;
  /** Whether the zikir overlay holds the band (Main lays the header out for an empty band only without it). */
  onZikir: (on: boolean) => void;
}

/**
 * The rotating content region: content, tilawah, ticker and zikir. Everything that can throw while rendering
 * content lives in here, behind its own quiet boundary, so a bad card never takes the prayer screen down.
 */
function ContentRegion({ view, lang, live, onTicker, onShown, onZikir }: RegionProps) {
  const { settings, now } = view;
  const c = useContent(view);
  useTilawah(view, live ? null : c.content);
  // Ticker strip (Plan 2 Task 10): only when the feature is on and a text is active on the KL date; the screen
  // is marked so the content region lifts to make room. Zikir replaces the rotation while its window is open.
  const tickerItems = settings.ticker.enabled && c.content ? activeTickerItems(c.content.ticker, dateOf(now, view.tz)) : [];
  const hasTicker = tickerItems.length > 0;
  const showZikir = !live && c.zikir !== null && c.content !== null && c.content.zikir.length > 0;
  useLayoutEffect(() => {
    onTicker(hasTicker);
    return () => onTicker(false);
  }, [hasTicker, onTicker]);
  // Zikir (and a live) replace the rotation: no card is on screen then, whatever the rotation says.
  useLayoutEffect(() => {
    if (showZikir || live) onShown(null);
  }, [showZikir, live, onShown]);
  useLayoutEffect(() => {
    onZikir(showZikir);
    return () => onZikir(false);
  }, [showZikir, onZikir]);

  return (
    <>
      {live ? null : showZikir && c.content && c.zikir ? (
        <ZikirOverlay view={view} lang={lang} content={c.content} zikir={c.zikir} />
      ) : (
        <ContentLayer view={view} lang={lang} content={c} onShown={onShown} />
      )}
      {hasTicker ? <Ticker items={tickerItems} speed={settings.ticker.speed} now={now} lang={lang} tz={view.tz} /> : null}
    </>
  );
}

/**
 * Layout C: identity block top-left (logo beside the name when the surau has one), next prayer top-right,
 * content region, prayer bar. While a poster is on screen it takes the whole stage and only a thin strip at
 * the bottom stays: clock, next prayer countdown and the surau; everything else fades out behind it.
 */
export function Main({ view, lang }: MainProps) {
  const { state, settings, now, hijri, logo, tz } = view;
  const timeFormat = settings.prayerBar.timeFormat === '24h' ? '24h' : '12h';
  const showSeconds = settings.clock.showSeconds === true;
  const next = state.next;
  const [hasTicker, setHasTicker] = useState(false);
  const [shownFeature, setShownFeature] = useState<SlotFeature | null>(null);
  const onShown = useCallback((f: SlotFeature | null) => setShownFeature(f), []);
  const [zikirOn, setZikirOn] = useState(false);
  const poster = shownFeature === 'posters';
  const name = surauNameOf(settings, lang);
  // The text name is left out only when the logo stands in for it (surauInfo.showName off) and there is one.
  const showName = nameShownOf(settings, logo);
  // The live (Plan 5 Task 6) exists only here, in the normal phase: every prayer phase unmounts Main and the
  // player with it. Live wins over the rotation (posters included); the prayer layer wins over live.
  const live = useLive(settings);
  const onAir = live.live === true;
  // Nothing in the band (no card, no zikir, no live): the header takes the screen (styles.css `.is-idle`).
  const idle = shownFeature === null && !zikirOn && !onAir;
  // The header fades only on an idle <-> card switch after Main has settled, never on the mount itself (Main mounts
  // after every prayer phase, and a fading header would hide the ticking clock). A short grace covers the first
  // frames, when the band settles from empty to its first card.
  const [armed, setArmed] = useState(false);
  const [settle, setSettle] = useState(false);
  const lastIdle = useRef(idle);
  useEffect(() => {
    const id = setTimeout(() => setArmed(true), 400);
    return () => clearTimeout(id);
  }, []);
  useEffect(() => {
    if (lastIdle.current === idle) return;
    lastIdle.current = idle;
    if (armed) setSettle(true);
  }, [idle, armed]);

  return (
    <div
      class={`screen screen--main${hasTicker ? ' has-ticker' : ''}${poster ? ' is-poster' : ''}${idle ? ' is-idle' : ''}${settle ? ' is-settling' : ''}${onAir ? ' has-live' : ''}${view.todaySource.emergency ? ' has-emergency' : ''}`}
      data-poster={poster ? 'true' : 'false'}
      data-idle={idle ? 'true' : 'false'}
    >
      {onAir ? (
        <QuietBoundary>
          <LiveLayer key={live.since ?? 'live'} live={live} settings={settings} lang={lang} />
        </QuietBoundary>
      ) : null}

      <div class="ident" aria-hidden={poster ? 'true' : undefined}>
        <div class={`ident__head${logo ? ' has-logo' : ''}`}>
          <SurauLogo src={logo} class="ident__logo" />
          {showName ? <div class="ident__name">{name}</div> : null}
        </div>
        <Clock now={now} timeFormat={timeFormat} showSeconds={showSeconds} lang={lang} tz={tz} />
        <div class="ident__dates">
          <span class="ident__greg">{fmtGregorian(now, lang, tz)}</span>
          {hijri ? (
            <>
              <span class="sep" aria-hidden="true" />
              <span class="ident__hijri">{fmtHijri(hijri, lang)}</span>
            </>
          ) : null}
        </div>
      </div>

      {next ? (
        <div class="next glass" aria-hidden={poster ? 'true' : undefined}>
          <span class="next__label">{t('nextIn', lang, { prayer: prayerLabel(next.name, lang) })}</span>
          <Countdown to={next.at} now={now} />
        </div>
      ) : null}

      {/* Rotating content: mounted only here, so every prayer phase unmounts it (and stops tilawah). */}
      <QuietBoundary>
        <ContentRegion view={view} lang={lang} live={onAir} onTicker={setHasTicker} onShown={onShown} onZikir={setZikirOn} />
      </QuietBoundary>

      <EmergencyBand view={view} lang={lang} />
      <PrayerBar state={state} settings={settings} lang={lang} now={now} tz={tz} />
      <SourceFooter view={view} lang={lang} />

      {poster ? (
        <div class="poster-strip glass" data-testid="poster-strip" role="contentinfo">
          <div class="poster-strip__surau">
            <SurauLogo src={logo} class="poster-strip__logo" />
            {showName ? <span class="poster-strip__name">{name}</span> : null}
          </div>
          <Clock now={now} timeFormat={timeFormat} showSeconds={showSeconds} lang={lang} variant="compact" tz={tz} />
          {next ? (
            <div class="poster-strip__next">
              <span class="poster-strip__label">{t('nextIn', lang, { prayer: prayerLabel(next.name, lang) })}</span>
              <Countdown to={next.at} now={now} class="poster-strip__cd" />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
