import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { dateOf, screenOfCard } from '@surau/core';
import type { SlotFeature } from '@surau/core';
import { useTilawah } from '../audio/tilawah.ts';
import { ContentLayer, pickSlot } from '../content/ContentLayer.tsx';
import { pengumumanPicture } from '../content/cards/PengumumanCard.tsx';
import { programKhasPicture } from '../content/cards/ProgramKhasCard.tsx';
import { useCardPictureFailures } from '../content/cardPictures.ts';
import { activeTickerItems, Ticker } from '../content/Ticker.tsx';
import { ZikirOverlay, zikirAt, zikirOptions } from '../content/ZikirOverlay.tsx';
import { ArabZikirScreen } from './content/ArabZikirScreen.tsx';
import { arabLookFor } from './content/arabLook.ts';
import type { ArabBase } from './content/arabLook.ts';
import { num } from '../content/assets.ts';
import { useArabEnv } from '../themes/arabContext.ts';
import { useContent } from '../data/content.ts';
import type { ContentView } from '../data/content.ts';
import type { KioskView } from '../data/kiosk.ts';
import { fmtGregorian, fmtHijri, prayerLabel } from '../format.ts';
import { fmtHijriAr, surauNameOf, t } from '../i18n.ts';
import type { Lang } from '../i18n.ts';
import { Clock } from '../ui/Clock.tsx';
import { Countdown } from '../ui/Countdown.tsx';
import { EmergencyBand } from '../ui/EmergencyBand.tsx';
import { nameShownOf, SurauLogo } from '../ui/Logo.tsx';
import { PrayerBar } from '../ui/PrayerBar.tsx';
import { QuietBoundary } from '../ui/QuietBoundary.tsx';
import type { Shown } from './screenId.ts';
import { SourceFooter } from '../ui/SourceFooter.tsx';
import { visibleNextOf } from '../ui/visibleNext.ts';
import { ContentShell } from './ContentShell.tsx';
import { shellOnlyScreenOf } from './screenId.ts';

export interface MainProps {
  view: KioskView;
  lang: Lang;
  /** Called before paint with the card on screen, 'zikir' while the zikir overlay holds the band, else null (and on unmount). */
  onScreen?: (shown: Shown) => void;
  /** The preview forces a content screen: the shell shows even while its card has nothing to show. */
  forceShell?: boolean;
}

interface RegionProps extends MainProps {
  /** The card on screen (Main's own record of it): the ticker gives way on the picture screens. */
  shown: SlotFeature | null;
  onTicker: (has: boolean) => void;
  onShown: (feature: SlotFeature | null, arab?: ArabBase | null) => void;
  /** Whether the zikir overlay holds the band (Main lays the header out for an empty band only without it), and whether it is the Arabic-led look. */
  onZikir: (on: boolean, arab?: boolean) => void;
  /** Main has the zikir layout on (its answer to onZikir): the zikir is put in the band only then (F32). */
  zikirStage: boolean;
}

/** Whether the card on screen is a picture screen the ticker gives way to (rule 13). */
export function tickerGivesWay(shown: SlotFeature | null, c: ContentView): boolean {
  if (shown === 'posters' || shown === 'videos' || shown === 'tabungCard') return true;
  if ((shown !== 'programKhas' && shown !== 'pengumuman') || !c.content) return false;
  const itemId = pickSlot(c)?.itemId ?? null;
  // A notice (or programme) with its picture gives the room to the picture; a text-only one, or one whose picture
  // failed to load, keeps the ticker.
  if (shown === 'pengumuman') return pengumumanPicture(c.content.pengumuman.find((x) => x.id === itemId)) !== null;
  return programKhasPicture(c.content.programKhas.find((x) => x.id === itemId)) !== null;
}

/** The screens with no prayer strip (rule 1): the picture and list screens keep the whole stage under the top row. */
const NO_STRIP: ReadonlySet<SlotFeature> = new Set<SlotFeature>(['posters', 'videos', 'pengumuman', 'programKhas', 'tabungCard']);

/**
 * The rotating content region: content, tilawah, ticker and zikir. Everything that can throw while rendering
 * content lives in here, behind its own quiet boundary, so a bad card never takes the prayer screen down.
 */
function ContentRegion({ view, lang, shown, onTicker, onShown, onZikir, zikirStage }: RegionProps) {
  const { settings, now } = view;
  const env = useArabEnv();
  const c = useContent(view);
  useTilawah(view, c.content);
  // A card picture that fails to load re-renders this region, so the ticker comes back for that slot.
  useCardPictureFailures();
  // Ticker strip (Plan 2 Task 10): only when the feature is on and a text is active on the KL date; the screen
  // is marked so the content region lifts to make room. Zikir replaces the rotation while its window is open.
  // Theme round 2, rule 13: the ticker gives way where a picture needs the room (the poster, a programme with its
  // picture, the tabung); the text screens (kuliah, hadis, pengumuman, ayat, takwim, zikir) keep it.
  const pictureScreen = tickerGivesWay(shown, c);
  const tickerItems = settings.ticker.enabled && c.content && !pictureScreen ? activeTickerItems(c.content.ticker, dateOf(now, view.tz)) : [];
  const hasTicker = tickerItems.length > 0;
  const showZikir = c.zikir !== null && c.content !== null && c.content.zikir.length > 0;
  useLayoutEffect(() => {
    onTicker(hasTicker);
    return () => onTicker(false);
  }, [hasTicker, onTicker]);
  // Zikir replaces the rotation: no card is on screen then, whatever the rotation says.
  useLayoutEffect(() => {
    if (showZikir) onShown(null);
  }, [showZikir, onShown]);
  // The Arabic-led zikir look: the theme turns it on (or the preview forces it) and the item on screen has Arabic.
  const zs = settings.zikirSelepasSolat as unknown as { durationSeconds?: unknown; minutesAfterSolat?: unknown };
  const zItem = showZikir && c.content && c.zikir ? zikirAt(c.content.zikir, now, c.zikir, num(zs.durationSeconds, 20), num(zs.minutesAfterSolat, 10))?.item : undefined;
  const zArabic = !!zItem && zItem.textAr.trim() !== '';
  // Tetapan `look`: 'theme' leaves it to the theme, 'plain' never, 'arab' always (with Arabic). A preview that forces one
  // of the two zikir screens shows that screen whatever the setting says.
  const { look } = zikirOptions(settings);
  const byLook = look === 'plain' ? false : look === 'arab' ? zArabic : arabLookFor('zikir', env.looks, { arabic: zArabic, tetapanArabic: true });
  const zikirArab = showZikir && (env.forced === 'arab-zikir' ? zArabic : env.forced === 'zikir' ? false : byLook);
  useLayoutEffect(() => {
    onZikir(showZikir, zikirArab);
    return () => onZikir(false, false);
  }, [showZikir, zikirArab, onZikir]);

  // F32: the zikir enters the band only once Main has the zikir layout. Put in before that (while the stage still had
  // the idle header or a card's band), its text measured its fit in a closed box, came up small or in pages, and the
  // layout changed around it a render later: the flicker. Until Main answers (the same task, before the frame is
  // drawn) the band holds nothing.
  return (
    <>
      {showZikir && c.content && c.zikir ? (
        !zikirStage ? null : zikirArab ? (
          <ArabZikirScreen view={view} lang={lang} content={c.content} zikir={c.zikir} />
        ) : (
          <ZikirOverlay view={view} lang={lang} content={c.content} zikir={c.zikir} />
        )
      ) : (
        <ContentLayer view={view} lang={lang} content={c} onShown={onShown} />
      )}
      {hasTicker ? <Ticker items={tickerItems} speed={settings.ticker.speed} now={now} lang={lang} tz={view.tz} /> : null}
    </>
  );
}

/**
 * Layout C: identity block top-left (logo beside the name when the surau has one), next prayer top-right,
 * content region, prayer bar. While a card (or the zikir overlay) with a catalog screen of its own is on screen the
 * stage is the content shell instead (spec 4): brand, compact clock, next-prayer chip, the card over the whole
 * main area and the compact prayer strip. The rotation layer stays mounted across the switch.
 */
export function Main({ view, lang, onScreen, forceShell = false }: MainProps) {
  const { state, settings, now, hijri, logo, tz } = view;
  const timeFormat = settings.prayerBar.timeFormat === '24h' ? '24h' : '12h';
  const showSeconds = settings.clock.showSeconds === true;
  // What the headline names as next is the prayer the bar highlights (a hidden Imsak or Syuruk is skipped).
  const next = visibleNextOf(state, settings, now, tz);
  const [hasTicker, setHasTicker] = useState(false);
  const [shownFeature, setShownFeature] = useState<SlotFeature | null>(null);
  const [shownArab, setShownArab] = useState<ArabBase | null>(null);
  const onShown = useCallback((f: SlotFeature | null, arab?: ArabBase | null) => {
    setShownFeature(f);
    setShownArab(arab ?? null);
  }, []);
  const [zikirOn, setZikirOn] = useState(false);
  const [zikirArab, setZikirArab] = useState(false);
  const onZikir = useCallback((on: boolean, arab?: boolean) => {
    setZikirOn(on);
    setZikirArab(on && arab === true);
  }, []);
  const reported: Shown = zikirOn
    ? (zikirArab ? 'arab-zikir' : 'zikir')
    : shownFeature !== null && shownArab !== null
      ? (`arab-${shownArab}` as Shown)
      : shownFeature;
  useLayoutEffect(() => {
    onScreen?.(reported);
  }, [reported, onScreen]);
  useLayoutEffect(() => () => onScreen?.(null), [onScreen]);
  // The shell takes the stage for every card that has a catalog screen, for the duty roster and the world clocks (shell
  // screens without a catalog entry), for the zikir overlay, and for a forced preview.
  const shell = zikirOn || (shownFeature !== null && (screenOfCard(shownFeature) !== null || shellOnlyScreenOf(shownFeature) !== null)) || forceShell;
  // Rule 1: no prayer strip on the poster, pengumuman, programme and tabung screens (the zikir overlay keeps it).
  const strip = !(shell && !zikirOn && shownFeature !== null && NO_STRIP.has(shownFeature));
  const name = surauNameOf(settings, lang);
  // The text name is left out only when the logo stands in for it (surauInfo.showName off) and there is one.
  const showName = nameShownOf(settings, logo);
  // A live never shows here: while one is on, the app shows the live screen instead (or a prayer screen over the
  // blurred live inside a prayer window), so Main is the kiosk without a live.
  // Nothing in the band (no card, no zikir): the header takes the screen (styles.css `.is-idle`).
  const idle = shownFeature === null && !zikirOn && !forceShell;
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
      class={`screen ${shell ? 'screen--shell' : 'screen--main'}${hasTicker ? ' has-ticker' : ''}${idle ? ' is-idle' : ''}${settle ? ' is-settling' : ''}${view.todaySource.emergency ? ' has-emergency' : ''}`}
      data-idle={idle ? 'true' : 'false'}
    >
      {shell ? (
        <ContentShell view={view} lang={lang} hideClock={zikirOn && !zikirOptions(settings).showClock} />
      ) : (
        <div class="ident">
          <div class={`ident__head region-brand has-logo`}>
            <SurauLogo src={logo} class="ident__logo" />
            {showName ? <div class="ident__name free-text">{name}</div> : null}
          </div>
          <Clock now={now} timeFormat={timeFormat} showSeconds={showSeconds} lang={lang} tz={tz} />
          <div class="ident__dates">
            <span class="ident__greg free-text">{fmtGregorian(now, lang, tz)}</span>
            {hijri ? (
              <>
                <span class="sep" aria-hidden="true" />
                <span class="ident__hijri free-text">{fmtHijri(hijri, lang)}</span>
              </>
            ) : null}
            {hijri ? <span class="date-ar arab free-text">{fmtHijriAr(now, hijri, tz)}</span> : null}
          </div>
        </div>
      )}

      {next && !shell ? (
        <div class="next region-next glass" data-role="next">
          <span class="next__label" data-must="">{t('nextIn', lang, { prayer: prayerLabel(next.name, lang) })}</span>
          <Countdown to={next.at} now={now} must />
        </div>
      ) : null}

      {/* Rotating content: mounted only here, so every prayer phase unmounts it (and stops tilawah). */}
      <QuietBoundary>
        <ContentRegion view={view} lang={lang} shown={shownFeature} onTicker={setHasTicker} onShown={onShown} onZikir={onZikir} zikirStage={zikirOn} />
      </QuietBoundary>

      <EmergencyBand view={view} lang={lang} />
      {strip ? <PrayerBar state={state} settings={settings} lang={lang} now={now} tz={tz} compact={shell} /> : null}
      <SourceFooter view={view} lang={lang} />
    </div>
  );
}
