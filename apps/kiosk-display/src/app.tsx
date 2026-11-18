import '@fontsource/plus-jakarta-sans/400.css';
import '@fontsource/plus-jakarta-sans/500.css';
import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';
import '@fontsource/plus-jakarta-sans/800.css';
import '@fontsource/amiri-quran/400.css';
import './styles.css';

import { useEffect, useRef, useState } from 'preact/hooks';
import type { Settings, ThemeStyleEntry, Tone } from '@surau/core';
import { useBoxLang } from './data/boxLang.ts';
import { useBoxState } from './data/boxState.ts';
import { NotPairedError } from './data/bundle.ts';
import { useCloudStatus } from './data/cloud.ts';
import { useKiosk } from './data/kiosk.ts';
import { useLive } from './data/live.ts';
import { useNotPaired } from './data/pairing.ts';
import { isForcedScreen } from './data/content.ts';
import { isPreview, usePreviewExtraAssets, usePreviewTheme } from './data/preview.ts';
import { assetSrc } from './content/assets.ts';
import { useRemoteKeys } from './data/remote.ts';
import { isBoxLang } from './i18n-box.ts';
import { t } from './i18n.ts';
import type { Lang } from './i18n.ts';
import { LiveVideo } from './live/LiveLayer.tsx';
import { liveDisplayMode, useLiveAnchors } from './live/liveMode.ts';
import { LiveScreen } from './screens/LiveScreen.tsx';
import { Locked } from './screens/Locked.tsx';
import { Main } from './screens/Main.tsx';
import { NetCheck } from './screens/NetCheck.tsx';
import { Pair } from './screens/Pair.tsx';
import { Phase, CALM_PHASES, azanFullOf } from './screens/Phase.tsx';
import { Recovery } from './screens/Recovery.tsx';
import { kindOf } from './screens/kind.ts';
import { screenIdOf } from './screens/screenId.ts';
import type { Shown } from './screens/screenId.ts';
import { Setup } from './screens/Setup.tsx';
import { Background, ownListPictureOn, pictureTone, resolveTone, themeListPicture, toneVars } from './ui/Background.tsx';
import { useBeep } from './ui/Beep.ts';
import { useFirstAzan } from './audio/firstAzan.ts';
import { CloudBadge } from './ui/CloudBadge.tsx';
import { HostExit } from './ui/HostExit.tsx';
import { QuietBoundary } from './ui/QuietBoundary.tsx';
import { useBoxNav } from './ui/LangSwitch.tsx';
import { SafeBoundary } from './ui/SafeBoundary.tsx';
import { arabLooksOf, builtInTheme, liveLayoutOf, packPictureKey, resolvePreviewTheme } from './themes/index.ts';
import { ArabEnvContext } from './themes/arabContext.ts';
import type { ResolvedTheme } from './themes/index.ts';
import { usePackCss, usePackPicture } from './themes/packLoader.ts';
import { useThemeHealth } from './themes/useThemeHealth.ts';
import { createFailedPictures } from './themes/failedPictures.ts';
import { effectiveShade, harakatOn, stageStyleFor, styleVars } from './themes/styleVars.ts';
import { SCALE_FACTOR, sanitizeThemeStyles, tvLanguage } from '@surau/core';
import { ScaleContext } from './content/scale.ts';
// After every component import, so the contract's rules follow styles.css and content.css and a template's rules follow the contract.
import './themes/contract.css';
import './templates.css';
// After the templates: the whole-screen azan countdown restyles the phase screen with the same theme tokens.
import './screens/azan-full.css';

/** The data layer reports errors as message strings; this is the one `loadBundle` throws for a 401 with no cache. */
const NOT_PAIRED_MESSAGE = new NotPairedError().message;

/** The admin app's preview shows the normal kiosk: it never asks the box which state it is in. */
const noBoxFetch: typeof fetch = () => Promise.reject(new Error('preview'));

/** Every menu picture id the surau set for a theme (all-screens layer and each screen). */
function menuImageIds(settings: Settings, theme: string, override?: ThemeStyleEntry): string[] {
  const all = sanitizeThemeStyles(settings.themeStyle?.styles);
  const e = override ?? (Object.prototype.hasOwnProperty.call(all, theme) ? all[theme] : undefined);
  if (!e) return [];
  const ids = new Set<string>();
  if (e.semua.bgImage) ids.add(e.semua.bgImage);
  for (const s of Object.values(e.skrin)) if (s?.bgImage) ids.add(s.bgImage);
  return [...ids];
}

/** The themes whose ground (and so the scrim over a picture) is light. */
const LIGHT_GROUND: ReadonlySet<string> = new Set(['minimal', 'oldschool']);

export function App() {
  const view = useKiosk();
  const { state, settings } = view;
  const lang: Lang = tvLanguage(settings);
  const [measured, setMeasured] = useState<Tone | null>(null);
  const tone = resolveTone(measured, settings);
  // A preview is not a display of its own: it never pairs, and a thin ribbon says so.
  const preview = isPreview();
  // The menu pictures of the theme on stage: fetched in preview (a paired display loads /assets/<id> itself); one that
  // fails to load is dropped for good so the next layer shows (spec 6.10.1).
  // The preview page may be asked (Ubah suai) to wear another theme, another screen and unsaved values.
  const previewTheme = usePreviewTheme();
  const themeNow: ResolvedTheme = resolvePreviewTheme(previewTheme, settings);
  // A failed poll keeps the last answer, and no answer yet means the normal kiosk: display fails safe.
  const box = useBoxState(preview ? { fetchImpl: noBoxFetch } : {}).view;
  const locked = box?.state === 'locked';
  // Setup and recovery take the screen only for the display that is given their QR (the box's own loopback kiosk, or a
  // damaged-database box that shows its own notice). A paired hall display gets the state without a QR and keeps its
  // normal content: it must not turn into a screen that asks someone to scan.
  const boxScreen =
    box !== null &&
    (box.state === 'setup' || box.state === 'recovery') &&
    (box.qr !== undefined || box.recoveryCodeSet !== undefined || box.reason === 'db_damaged');
  // Pairing takes the whole screen only when there is nothing else to show: the box refused this
  // display and no cached bundle exists. With data on screen the prayer layer wins and pairing is a badge.
  const showPair = !preview && view.error === NOT_PAIRED_MESSAGE && state.phase === 'noData';
  const onBoxScreen = (box !== null && (locked || boxScreen)) || showPair;
  // An uploaded theme: its stylesheet over the base theme. Until it has loaded (and whenever it failed the health check)
  // the stage is the base theme exactly: no pack defaults, no pack pictures, none of the surau's values for the pack.
  // The box's own screens (setup, pairing, recovery, stopped) never load it: no pack stylesheet is in the page there.
  const packLoad = usePackCss(themeNow, { staged: previewTheme?.staged ?? null, enabled: !onBoxScreen });
  const packOn = themeNow.pack !== null && packLoad.state === 'ready';
  const styleTheme: ResolvedTheme = themeNow.pack !== null && !packOn ? builtInTheme(themeNow.base) : themeNow;
  const styleOverride = previewTheme !== null && styleTheme.name === previewTheme.theme ? previewTheme.entry : undefined;
  // Failed pictures are kept per id and retried (a settings change, else once a minute); `bump` re-renders when one fails.
  const failedPictures = useRef(createFailedPictures()).current;
  const [, bumpFailed] = useState(0);
  // The measured mean luminance of the menu picture, with the picture it belongs to (free text over a picture is dressed from it).
  const [menuLuma, setMenuLuma] = useState<{ id: string | null; luma: number | null }>({ id: null, luma: null });
  const [failedPackPicture, setFailedPackPicture] = useState<string | null>(null);
  const [failedListPicture, setFailedListPicture] = useState<string | null>(null);
  usePreviewExtraAssets(menuImageIds(settings, styleTheme.name, styleOverride));
  // The live (operator decision 2026-11-14): owned here, above the phase switch, so one WHEP session runs for
  // the whole live. Clear = the live screen takes priority; blurred = the prayer screen of a window (1 min either
  // side of the azan or the iqamah time) on top of the still-playing, blurred video; none = no live.
  // It runs only where the kiosk program runs: never on a box screen (setup, recovery, stopped) and never before
  // there is prayer data (the no-data screen, a preview still waiting for its token).
  const live = useLive(settings, { active: !locked && !boxScreen && state.phase !== 'noData' });
  const liveAnchors = useLiveAnchors(state, settings);
  // What the live wants (keeps the video mounted) versus what is shown: the live takes the screen only while its
  // video really has frames (liveOnAir); with none, or none for 10 s, the normal screens and their tones stay.
  const liveWanted = liveDisplayMode(view.now, state, settings, live.live === true, liveAnchors);
  const [liveOnAir, setLiveOnAir] = useState(false);
  // The preview has no player by design (nothing can play): it keeps showing the live screen as the illustration.
  // The Ubah suai preview can ask for the live screen with no video (the waiting panel).
  const forcedLive = preview && previewTheme?.screen === 'live';
  const liveMode = forcedLive ? 'clear' : liveOnAir || (live.live === true && !live.playable) ? liveWanted : 'none';
  // A stopped box shows nothing of the surau, and that includes the prayer tones. While the live has priority
  // (clear) no prayer tone sounds over it either: the tones of the windows (masuk waktu, the iqamah end warning)
  // still sound, because their screens are up then.
  useBeep(locked || liveMode === 'clear' ? { ...state, beep: null } : state, settings);
  // The first Subuh azan (an audio file) follows the same rule: silent on a stopped box and under a live with priority.
  useFirstAzan(state, settings, { muted: locked || liveMode === 'clear', now: view.now });
  // The card (or the zikir overlay) Main has on screen: the stage names the catalog screen after it.
  const [shown, setShown] = useState<Shown>(null);
  const liveClear = liveMode === 'clear';
  // A forced content screen of the preview is on the stage's data-screen even when its card has nothing to show.
  const forcedScreen = preview && previewTheme && state.phase === 'normal' && isForcedScreen(previewTheme.screen) ? previewTheme.screen : null;
  const screen = forcedScreen ?? screenIdOf(state, liveClear, shown);
  // The pack's own picture for this screen (the surau's menu picture, when there is one, comes first).
  const packKey = packOn && themeNow.pack !== null ? packPictureKey(themeNow.pack, screen) : null;
  const packPicture = usePackPicture(themeNow, packKey, previewTheme?.staged ?? null);
  useThemeHealth({ active: packOn, theme: themeNow, screen, logoSet: view.logo !== null, reject: packLoad.reject, report: !preview });
  const notPaired = useNotPaired();
  const cloud = useCloudStatus(preview ? { fetchImpl: noBoxFetch } : {});
  const [netCheckOpen, setNetCheckOpen] = useState(false);
  // A screen with the on-screen button: a damaged box has no network check route to open.
  const hasNetButton = boxScreen && (box.state === 'setup' || (box.state === 'recovery' && box.reason !== 'db_damaged'));
  const canOpenNetCheck = !preview && !locked;
  // The box's own screens (setup, recovery, stopped, pairing, network check) speak BM, English or Arabic, chosen on
  // this display. Everything else keeps the surau's language: the main program does not change.
  const [boxLang, setBoxLang] = useBoxLang(lang, { remember: !preview });
  const boxFocus = useBoxNav({ enabled: onBoxScreen && !netCheckOpen, hasNet: hasNetButton && !locked, lang: boxLang });
  useRemoteKeys({
    onOk: () => {
      if (netCheckOpen) return;
      if (isBoxLang(boxFocus)) setBoxLang(boxFocus);
      else if (hasNetButton) setNetCheckOpen(true);
    },
    onHoldOk: () => {
      if (canOpenNetCheck) setNetCheckOpen(true);
    },
  });
  // A box stopped while the check is open must not bring it back when it is released.
  useEffect(() => {
    if (locked) setNetCheckOpen(false);
  }, [locked]);
  const overlay =
    netCheckOpen && canOpenNetCheck ? (
      <NetCheck
        lang={boxLang}
        onLang={setBoxLang}
        settings={settings}
        boxState={box?.state ?? 'active'}
        keyFp={box?.keyFp ?? ''}
        onClose={() => setNetCheckOpen(false)}
      />
    ) : null;

  if (box !== null && locked) {
    return (
      <div class="stage" data-phase="locked" data-dim="false">
        <Locked boxId={box.boxId} lang={boxLang} onLang={setBoxLang} focus={boxFocus} />
      </div>
    );
  }

  if (box !== null && boxScreen) {
    const Screen = box.state === 'setup' ? Setup : Recovery;
    return (
      <div class="stage" data-phase={box.state} data-dim="true" style={toneVars(tone)}>
        <SafeBoundary today={state.today} settings={settings} lang={lang}>
          <Background settings={settings} now={view.now} onTone={setMeasured} />
          <Screen
            key={box.state}
            box={box}
            view={view}
            lang={boxLang}
            surauLang={lang}
            onLang={setBoxLang}
            focus={boxFocus}
            onNetCheck={() => setNetCheckOpen(true)}
          />
          {overlay}
        </SafeBoundary>
      </div>
    );
  }

  const normal = state.phase === 'normal' && !liveClear;
  const dim = !liveClear && CALM_PHASES.has(state.phase);
  const showDot = view.stale || (view.ready && view.daysAhead < 30);
  const showBadge = !preview && notPaired && !showPair && !dim;

  if (showPair) {
    return (
      <div class="stage" data-phase="pair" data-dim="false" style={toneVars(tone)}>
        <SafeBoundary today={state.today} settings={settings} lang={lang}>
          <Background settings={settings} now={view.now} onTone={setMeasured} />
          <Pair key="pair" lang={boxLang} onLang={setBoxLang} focus={boxFocus} settings={settings} />
          {overlay}
        </SafeBoundary>
      </div>
    );
  }

  // A presentation template owns its colours (templates.css); the measured tone dresses only the default look.
  const theme = styleTheme;
  const packDefaults = packOn && themeNow.pack !== null ? themeNow.pack.defaults : undefined;
  const screenStyle = stageStyleFor(settings, theme, screen, packDefaults, styleOverride);
  const wall = Date.now();
  // Spec 6.10.1: under the menu and the pack pictures, the surau's backgrounds list (Tetapan) is the picture of every
  // theme. The default look draws it itself (Background's list picture, measured for autoTone); any other theme takes
  // the list's own pictures as its picture layer, dressed like a menu picture: the theme's shade over it and free text
  // on plates by the measured tone (data-pic), so the theme keeps it legible.
  const listPicture = theme.base !== 'default' ? themeListPicture(settings, view.now) : null;
  const layerPicture =
    packPicture !== null && packPicture !== failedPackPicture
      ? packPicture
      : listPicture !== null && listPicture !== failedListPicture
        ? listPicture
        : null;
  const menu = styleVars(
    screenStyle,
    (id) => (failedPictures.blocked(id, settings, wall) ? null : assetSrc(id)),
    layerPicture,
  );
  // The layer darkness over a menu picture is always explicit on the stage: the surau's value, else the theme's own
  // default (kept above a readable minimum on the default look). Without a picture only the surau's own value applies.
  const ownShade = stageStyleFor(settings, theme, screen, packDefaults ?? {}, styleOverride).shade;
  const hasPicture = menu.bgAssetId !== null || menu.packImageUrl !== null;
  const pictureId = menu.bgAssetId ?? menu.packImageUrl;
  const shade = effectiveShade(screenStyle.shade, theme.base, tone.shadeAlpha, hasPicture);
  if (hasPicture) menu.vars['--shade'] = String(shade / 100);
  else if (ownShade === undefined) delete menu.vars['--shade'];
  // Text that sits directly on the stage (not in a panel) reads against the picture: its tone, light or dark, is
  // measured from the picture and the surau's shade, and each theme dresses its free text from it (`data-pic`).
  // The calm phases (solat, khutbah...) dim the whole picture away, so no tone applies there.
  // A picture the surau (or the pack) put under the text: the menu or pack picture, the list picture of a theme, or
  // the default look's own list picture. The stage wears `data-picture` and the contract lays a theme-tinted scrim over
  // the picture, plates under the text blocks and a soft glow on the text (theme round 2, operator 2026-11-16).
  const pictureOn = hasPicture || (theme.base === 'default' && ownListPictureOn(settings, view.now));
  const measuredPic =
    !dim && pictureId !== null && menuLuma.id === pictureId
      ? pictureTone(menuLuma.luma, shade / 100)
      : null;
  // The scrim over a picture (contract.css, data-picture) is the theme's own ground: light in Minimal and Old School,
  // dark in the others. Text then reads against that ground, so the free-text tone follows the theme, not the picture.
  const pic = measuredPic !== null && pictureOn ? (LIGHT_GROUND.has(theme.base) ? 'light' : 'dark') : measuredPic;
  // The default look keeps its measured tone (from the menu picture when one shows). A theme owns its colours: its
  // panels are light or dark by design, so a text colour measured from the picture is not forced onto them.
  const baseVars: Record<string, string> = theme.base === 'default' ? toneVars(tone) : {};
  const stageVars = { ...baseVars, ...menu.vars };
  const scaleFactor = SCALE_FACTOR[screenStyle.scale ?? 'S'] ?? 1;
  // The Arabic-led looks of this theme, the preview's forced arab-* screen, and the style of the screen (translation place).
  const arabEnv = {
    looks: arabLooksOf(theme),
    forced: forcedScreen !== null && String(forcedScreen).startsWith('arab-') ? String(forcedScreen) : null,
    style: screenStyle,
  };
  return (
    <ScaleContext.Provider value={scaleFactor}>
    <ArabEnvContext.Provider value={arabEnv}>
    <div
      class="stage"
      data-phase={state.phase}
      data-screen={screen}
      data-azan-full={azanFullOf(view) && !liveClear ? 'true' : undefined}
      data-kind={kindOf(screen)}
      data-live-layout={liveLayoutOf(themeNow)}
      data-harakat={harakatOn(screenStyle) ? 'on' : undefined}
      data-live={liveMode}
      data-dim={dim ? 'true' : 'false'}
      data-template={themeNow.base}
      data-theme={packLoad.state === 'failed' ? themeNow.base : themeNow.name}
      data-pack={themeNow.pack !== null ? packLoad.state : undefined}
      data-lang={lang}
      {...menu.attrs}
      data-pic={pic ?? undefined}
      data-picture={pictureOn ? 'on' : undefined}
      style={Object.keys(stageVars).length > 0 ? stageVars : undefined}
    >
      <SafeBoundary today={state.today} settings={settings} lang={lang}>
        <Background
          settings={settings}
          now={view.now}
          onTone={setMeasured}
          menuImage={menu.bgAssetId}
          packImageUrl={menu.packImageUrl}
          onMenuImageFailed={() => {
            if (menu.bgAssetId !== null) failedPictures.mark(menu.bgAssetId, settings, Date.now());
            else if (menu.packImageUrl === packPicture) setFailedPackPicture(menu.packImageUrl);
            else setFailedListPicture(menu.packImageUrl);
            bumpFailed((n) => n + 1);
          }}
          onMenuLuma={(luma) => setMenuLuma({ id: pictureId, luma })}
        />
        <div class="deco" aria-hidden="true">
          <i class="d1" />
          <i class="d2" />
          <i class="d3" />
        </div>
        {liveWanted !== 'none' ? (
          <QuietBoundary>
            <LiveVideo key={live.since ?? 'live'} live={live} settings={settings} mode={liveWanted} onAir={setLiveOnAir} />
          </QuietBoundary>
        ) : null}
        {liveClear ? (
          <LiveScreen key="live" view={view} live={live} lang={lang} onAir={liveOnAir} />
        ) : normal ? (
          <Main key="main" view={view} lang={lang} onScreen={setShown} forceShell={forcedScreen !== null} />
        ) : (
          <Phase key={state.phase} view={view} lang={lang} />
        )}
        {showBadge ? (
          <div class="pair-badge" data-testid="pair-badge" data-dim={normal ? 'false' : 'true'} role="status">
            <span class="pair-badge__dot" aria-hidden="true" />
            {t('pairBadge', lang)}
          </div>
        ) : null}
        {cloud.offline && !preview && !dim ? (
          <CloudBadge lastOkAt={cloud.lastOkAt} settings={settings} lang={lang} dim={!normal} />
        ) : null}
        {showDot ? <span class="status-dot" data-testid="status-dot" aria-hidden="true" /> : null}
        <HostExit />
        {preview ? <div class="preview-ribbon" data-testid="preview-ribbon">PRATONTON</div> : null}
        {overlay}
      </SafeBoundary>
    </div>
    </ArabEnvContext.Provider>
    </ScaleContext.Provider>
  );
}
