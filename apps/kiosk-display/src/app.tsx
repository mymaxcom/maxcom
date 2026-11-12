import '@fontsource/plus-jakarta-sans/400.css';
import '@fontsource/plus-jakarta-sans/500.css';
import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';
import '@fontsource/plus-jakarta-sans/800.css';
import '@fontsource/amiri-quran/400.css';
import './styles.css';

import { useEffect, useState } from 'preact/hooks';
import type { Tone } from '@surau/core';
import { useBoxLang } from './data/boxLang.ts';
import { useBoxState } from './data/boxState.ts';
import { NotPairedError } from './data/bundle.ts';
import { useCloudStatus } from './data/cloud.ts';
import { useKiosk } from './data/kiosk.ts';
import { useNotPaired } from './data/pairing.ts';
import { isPreview } from './data/preview.ts';
import { useRemoteKeys } from './data/remote.ts';
import { isBoxLang } from './i18n-box.ts';
import { t } from './i18n.ts';
import type { Lang } from './i18n.ts';
import { Locked } from './screens/Locked.tsx';
import { Main } from './screens/Main.tsx';
import { NetCheck } from './screens/NetCheck.tsx';
import { Pair } from './screens/Pair.tsx';
import { Phase, CALM_PHASES } from './screens/Phase.tsx';
import { Recovery } from './screens/Recovery.tsx';
import { Setup } from './screens/Setup.tsx';
import { Background, resolveTone, toneVars } from './ui/Background.tsx';
import { useBeep } from './ui/Beep.ts';
import { CloudBadge } from './ui/CloudBadge.tsx';
import { HostExit } from './ui/HostExit.tsx';
import { useBoxNav } from './ui/LangSwitch.tsx';
import { SafeBoundary } from './ui/SafeBoundary.tsx';
import { templateOf } from './templates.ts';
// After every component import, so a template's rules follow styles.css and content.css in the bundle.
import './templates.css';

/** The data layer reports errors as message strings; this is the one `loadBundle` throws for a 401 with no cache. */
const NOT_PAIRED_MESSAGE = new NotPairedError().message;

/** The admin app's preview shows the normal kiosk: it never asks the box which state it is in. */
const noBoxFetch: typeof fetch = () => Promise.reject(new Error('preview'));

export function App() {
  const view = useKiosk();
  const { state, settings } = view;
  const lang: Lang = settings.language.enabled && settings.language.lang === 'en' ? 'en' : 'ms';
  const [measured, setMeasured] = useState<Tone | null>(null);
  const tone = resolveTone(measured, settings);
  // A preview is not a display of its own: it never pairs, and a thin ribbon says so.
  const preview = isPreview();
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
  // A stopped box shows nothing of the surau, and that includes the prayer tones.
  useBeep(locked ? { ...state, beep: null } : state, settings);
  const notPaired = useNotPaired();
  const cloud = useCloudStatus(preview ? { fetchImpl: noBoxFetch } : {});
  const [netCheckOpen, setNetCheckOpen] = useState(false);
  // A screen with the on-screen button: a damaged box has no network check route to open.
  const hasNetButton = boxScreen && (box.state === 'setup' || (box.state === 'recovery' && box.reason !== 'db_damaged'));
  const canOpenNetCheck = !preview && !locked;
  // The box's own screens (setup, recovery, stopped, pairing, network check) speak BM, English or Arabic, chosen on
  // this display. Everything else keeps the surau's language: the main program does not change.
  const [boxLang, setBoxLang] = useBoxLang(lang, { remember: !preview });
  // Pairing takes the whole screen only when there is nothing else to show: the box refused this
  // display and no cached bundle exists. With data on screen the prayer layer wins and pairing is a badge.
  const showPair = !preview && view.error === NOT_PAIRED_MESSAGE && state.phase === 'noData';
  const onBoxScreen = (box !== null && (locked || boxScreen)) || showPair;
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

  const normal = state.phase === 'normal';
  const dim = CALM_PHASES.has(state.phase);
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
  const template = templateOf(settings.kioskTemplate);
  return (
    <div
      class="stage"
      data-phase={state.phase}
      data-dim={dim ? 'true' : 'false'}
      data-template={template}
      style={template === 'default' ? toneVars(tone) : undefined}
    >
      <SafeBoundary today={state.today} settings={settings} lang={lang}>
        <Background settings={settings} now={view.now} onTone={setMeasured} />
        {normal ? <Main key="main" view={view} lang={lang} /> : <Phase key={state.phase} view={view} lang={lang} />}
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
  );
}
