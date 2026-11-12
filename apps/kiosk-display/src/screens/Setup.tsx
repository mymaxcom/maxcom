import { fingerprintGroups, parseBoxQr } from '@surau/core';
import type { BoxStateView } from '@surau/core';
import type { KioskView } from '../data/kiosk.ts';
import { tb, tbx } from '../i18n-box.ts';
import type { BoxLang } from '../i18n-box.ts';
import type { Lang } from '../i18n.ts';
import { QrCard } from '../ui/QrCard.tsx';
import { BoxClock, BoxHead, textAttrs } from './BoxChrome.tsx';
import type { BoxLangProps } from './BoxChrome.tsx';

/** Largest edge of the code: 7 device pixels a module on a 1080p panel for the usual payload. */
const QR_REM = 42;

export interface BoxScreenProps extends BoxLangProps {
  box: BoxStateView;
  view: KioskView;
  /** The surau's kiosk language, for the parts shared with the main program (the prayer bar). Defaults to `lang`. */
  surauLang?: Lang;
  /** OK on the remote does the same; a click is for a box with a mouse attached. */
  onNetCheck?: () => void;
}

/** The box's own https origin as signed into the QR: '' when it has none, null when there is no readable code. */
export function originOf(payload: string | undefined): string | null {
  if (payload === undefined) return null;
  try {
    return parseBoxQr(payload).box;
  } catch {
    return null;
  }
}

/** One label and value with a status dot. */
export function StatusItem({ state, label, value }: { state: 'ok' | 'bad' | 'off'; label: string; value: string }) {
  return (
    <div class="netitem">
      <i class={`dot dot--${state}`} aria-hidden="true" />
      <b>{label}</b>
      <span>{value}</span>
    </div>
  );
}

/**
 * The screen's own button. It is drawn focused while the remote's focus is on it (the default); the arrows can
 * move the focus up to the language switch.
 */
export function NetCheckButton({
  lang,
  onNetCheck,
  focused = true,
}: {
  lang: BoxLang;
  onNetCheck?: () => void;
  focused?: boolean;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      class={`tvbtn${focused ? ' is-focused' : ''}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onNetCheck}
    >
      {tb('setupNetCheck', lang)}
    </button>
  );
}

/** First boot: the QR that makes the first phone the Pentadbir. Mockup screen 1. */
export function Setup({ box, view, lang, onLang, focus, onNetCheck }: BoxScreenProps) {
  const { settings, now } = view;
  const timeFormat = settings.prayerBar.timeFormat === '24h' ? '24h' : '12h';
  const origin = originOf(box.qr?.payload);
  const noCert = origin === '' || (origin === null && !box.https);
  const txt = textAttrs(lang);

  return (
    <div class="screen screen--setup box-screen" data-screen="setup" data-lang={lang}>
      <div class="box-main">
        <BoxHead
          lang={lang}
          onLang={onLang}
          focus={focus}
          title={<span class="box-brandrow__sub">{tb('setupSub', lang)}</span>}
          end={<BoxClock now={now} timeFormat={timeFormat} showSeconds={false} lang={lang} variant="compact" />}
        />
        <div class="box-body" {...txt}>
          <h1 class="box-title">{tb('setupTitle', lang)}</h1>
          <p class="box-lead">
            <b>{tb('setupLead', lang)}</b> {tb('setupLead2', lang)}
          </p>
          <ol class="box-steps">
            {(['setupStep1', 'setupStep2', 'setupStep3'] as const).map((k, i) => (
              <li key={k}>
                <i aria-hidden="true">{i + 1}</i>
                {tb(k, lang)}
              </li>
            ))}
          </ol>
          <dl class="box-id">
            <dt>{tb('setupBoxName', lang)}</dt>
            <dd>
              <bdi>{box.name}</bdi>
            </dd>
            <dt>{tb('setupBoxId', lang)}</dt>
            <dd class="num">
              <bdi dir="ltr">{fingerprintGroups(box.boxId)}</bdi>
            </dd>
            {origin ? (
              <>
                <dt>{tb('setupAddress', lang)}</dt>
                <dd class="num">
                  <bdi dir="ltr">{origin}</bdi>
                </dd>
              </>
            ) : null}
          </dl>
          {noCert ? <p class="box-warn">{tb('setupNoHttps', lang)}</p> : null}
          <p class="box-note">{tb('setupNeedsCamera', lang)}</p>
          {box.appDownloadUrl !== '' ? <p class="box-note">{tbx('setupApp', lang, { url: box.appDownloadUrl })}</p> : null}
        </div>
        <footer class="box-foot glass" {...txt}>
          <div class="netitems">
            <StatusItem
              state={box.https ? 'ok' : 'bad'}
              label={tb('netServer', lang)}
              value={tb(box.https ? 'setupHttpsOn' : 'netServerOff', lang)}
            />
            <StatusItem
              state={box.linked ? 'ok' : 'off'}
              label={tb('netCloud', lang)}
              value={tb(box.linked ? 'netLinkedShort' : 'netUnlinked', lang)}
            />
          </div>
          <NetCheckButton lang={lang} onNetCheck={onNetCheck} focused={focus === undefined || focus === 'net'} />
        </footer>
      </div>
      <QrCard
        payload={box.qr?.payload}
        expiresAt={box.qr?.expiresAt}
        caption={tb('setupCodeOnce', lang)}
        rem={QR_REM}
        keyFp={box.keyFp}
        lang={lang}
      />
    </div>
  );
}
