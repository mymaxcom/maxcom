import { useEffect, useMemo, useState } from 'preact/hooks';
import { matchingCodeGroups } from '@surau/core';
import { dateOf } from '@surau/core';
import { fmtClock } from '../format.ts';
import { commaOf, fmtDateShort } from '../i18n.ts';
import { dirOf, tl, tlx } from '../i18n-box.ts';
import type { BoxLang } from '../i18n-box.ts';
import { PROGRESS_STEPS, reasonKeyOf, secondsLeftAt } from '../data/linkState.ts';
import type { FollowerInfo, LinkScreenKind, LinkView } from '../data/linkState.ts';
import { Qr, qrPath } from '../ui/Qr.tsx';
import { qrPixelSize } from '../ui/QrCard.tsx';
import { fmtMmSs } from './Pair.tsx';
import { BoxLogo, textAttrs } from './BoxChrome.tsx';
import './link.css';

/** The box's clock now: this TV's clock plus the offset the poll measured, ticking every second. */
export function useServerNow(offsetMs: number): number {
  const [now, setNow] = useState(() => Date.now() + offsetMs);
  useEffect(() => {
    setNow(Date.now() + offsetMs);
    const id = setInterval(() => setNow(Date.now() + offsetMs), 1000);
    return () => clearInterval(id);
  }, [offsetMs]);
  return now;
}

/** Edge of a code in rem of the kiosk grid, converted to whole device pixels per module. */
function useQrPx(text: string, rem: number): number {
  const modules = useMemo(() => qrPath(text)?.modules ?? 0, [text]);
  const unit = Math.min(window.innerWidth, (window.innerHeight * 16) / 9) / 100;
  return qrPixelSize(rem * unit, modules, window.devicePixelRatio || 1);
}

/** The link QR with its countdown, counted against the box's clock (never the TV's clock alone). */
export function LinkQr({
  payload,
  expiresAt,
  offsetMs,
  rem,
  lang,
}: {
  payload: string;
  expiresAt: string;
  offsetMs: number;
  rem: number;
  lang: BoxLang;
}) {
  const nowMs = useServerNow(offsetMs);
  const left = secondsLeftAt(expiresAt, nowMs);
  const px = useQrPx(payload, rem);
  const code = useMemo(() => (px > 0 ? <Qr text={payload} size={px} lang={lang} /> : null), [payload, px, lang]);
  const showCode = code !== null && left !== 0;
  return (
    <div class="linkqr" data-testid="link-qr">
      <div class="linkqr__code" dir="ltr" style={{ width: `${rem}rem`, height: `${rem}rem` }}>
        {showCode ? code : <p class="linkqr__wait">{tl('linkQrRenewing', lang)}</p>}
      </div>
      {showCode && left !== null ? (
        <div class="linkqr__left num" data-testid="link-countdown" {...textAttrs(lang)}>
          {tlx('linkQrIn', lang, { mmss: fmtMmSs(left) })}
        </div>
      ) : null}
    </div>
  );
}

export interface LinkProps {
  lang: BoxLang;
  kind: LinkScreenKind;
  view: LinkView | null;
  /** The box's clock minus this TV's clock, from the poll. */
  offsetMs: number;
  /** The master's name for the follower's "connecting" screen. */
  masterName?: string | null;
}

/**
 * The whole-screen link states of the TV: the link QR, the matching code, the wait for the admin, the progress, the
 * end of a link, and a follower with nothing stored yet. A normal box with no session never mounts this.
 */
export function Link({ lang, kind, view, offsetMs, masterName }: LinkProps) {
  const txt = textAttrs(lang);
  let body;
  switch (kind) {
    case 'qr': {
      const qr = view?.qr ?? null;
      body = (
        <>
          <h1 class="link__title">{tl('linkQrTitle', lang)}</h1>
          {qr !== null ? (
            <LinkQr payload={qr.payload} expiresAt={qr.expiresAt} offsetMs={offsetMs} rem={36} lang={lang} />
          ) : null}
          <p class="link__lead">{tl('linkQrLead', lang)}</p>
        </>
      );
      break;
    }
    case 'code':
      body = (
        <>
          <h1 class="link__title">{tl('linkCodeTitle', lang)}</h1>
          <p class="link__code num" data-testid="link-code">
            <span dir="ltr">{matchingCodeGroups(view?.code ?? '')}</span>
          </p>
          {view?.peer ? <p class="link__sub">{tlx('linkCodeFrom', lang, { name: view.peer.name })}</p> : null}
          <p class="link__lead">{tl('linkCodeHint', lang)}</p>
        </>
      );
      break;
    case 'wait':
      body = (
        <>
          <h1 class="link__title">{tl('linkWaitTitle', lang)}</h1>
          <p class="link__lead">{tl('linkWaitHint', lang)}</p>
        </>
      );
      break;
    case 'progress': {
      const p = view?.progress ?? null;
      const stepKey = p !== null && (PROGRESS_STEPS as readonly string[]).includes(p.step) ? `linkStep_${p.step}` : null;
      // The store move of a link of two boxes that both hold data: "Memindahkan data, 62%" in place of the plain step.
      const moving = p !== null && p.step === 'commit' && p.percent !== null;
      body = (
        <>
          <h1 class="link__title">{tl('linkProgressTitle', lang)}</h1>
          {p !== null && p.stepNo !== null && p.steps !== null ? (
            <p class="link__step num" data-testid="link-step">
              {tlx('linkStepOf', lang, { n: p.stepNo, total: p.steps })}
            </p>
          ) : null}
          {moving ? (
            <p class="link__sub num" data-testid="link-move">
              {tlx('linkStep_move', lang, { pct: `${Math.round(Math.max(0, Math.min(100, p.percent as number)))}%` })}
            </p>
          ) : stepKey !== null ? (
            <p class="link__sub">{tl(stepKey, lang)}</p>
          ) : null}
          {p !== null && p.percent !== null ? (
            <>
              <div class="link__bar" aria-hidden="true">
                <i style={{ width: `${Math.max(0, Math.min(100, p.percent))}%` }} />
              </div>
              {moving ? null : <p class="link__pct num" dir="ltr">{`${Math.round(p.percent)}%`}</p>}
            </>
          ) : null}
          <p class="link__lead">{tl('linkProgressHint', lang)}</p>
        </>
      );
      break;
    }
    case 'unlink': {
      const u = view?.unlink ?? null;
      if (u !== null && u.step === 'done') {
        const qr = view?.qr ?? null;
        body = (
          <>
            <h1 class="link__title link__title--ok">{tl('unlinkDoneTitle', lang)}</h1>
            <p class="link__lead">{tl('unlinkDoneBody', lang)}</p>
            {qr !== null ? <LinkQr payload={qr.payload} expiresAt={qr.expiresAt} offsetMs={offsetMs} rem={30} lang={lang} /> : null}
          </>
        );
      } else {
        body = (
          <>
            <h1 class="link__title">{tl('unlinkTitle', lang)}</h1>
            {u !== null ? <p class="link__sub" data-testid="unlink-step">{tl(`unlinkStep_${u.step.replace('-', '_')}`, lang)}</p> : null}
            {u !== null && u.percent !== null ? (
              <>
                <div class="link__bar" aria-hidden="true">
                  <i style={{ width: `${Math.max(0, Math.min(100, u.percent))}%` }} />
                </div>
                <p class="link__pct num" dir="ltr" data-testid="unlink-pct">{`${Math.round(u.percent)}%`}</p>
              </>
            ) : null}
            <p class="link__lead">{tl('linkProgressHint', lang)}</p>
          </>
        );
      }
      break;
    }
    case 'done':
      body = (
        <>
          <h1 class="link__title link__title--ok">{tl('linkDoneTitle', lang)}</h1>
          <p class="link__lead">{tl('linkDoneBody', lang)}</p>
        </>
      );
      break;
    case 'ended':
      body = (
        <>
          <h1 class="link__title">{tl('linkEndedTitle', lang)}</h1>
          <p class="link__lead">{tl(reasonKeyOf(view?.last?.outcome ?? null), lang)}</p>
        </>
      );
      break;
    case 'connecting':
    default:
      body = (
        <>
          <h1 class="link__title">
            {tlx('linkConnecting', lang, { name: masterName ?? view?.master?.name ?? tl('linkMasterWord', lang) })}
          </h1>
          <p class="link__lead">{tl('linkConnectingSub', lang)}</p>
        </>
      );
  }
  return (
    <div class="screen screen--link box-screen" data-screen="link" data-kind={kind} data-lang={lang} {...txt}>
      <BoxLogo class="link__logo" />
      <div class="link__body" {...txt}>
        {body}
      </div>
    </div>
  );
}

/**
 * When the main box was last reached, for the O23 notice: the clock time on the same day, else the short date and the
 * time ("Isn 23 Nov, 08:30"), in the surau's time zone and the TV language (ص / م in Arabic).
 */
export function fmtLostSince(iso: string, nowMs: number, timeFormat: '12h' | '24h', tz: string, lang: BoxLang): string {
  const at = new Date(iso);
  const c = fmtClock(at, timeFormat, false, lang, tz);
  const time = c.ampm ? `${c.hm} ${c.ampm}` : c.hm;
  const day = dateOf(at, tz);
  return day === dateOf(new Date(nowMs), tz) ? time : `${fmtDateShort(day, lang)}${commaOf(lang)}${time}`;
}

/**
 * The small corner marks of a follower TV: the main box out of reach for 10 minutes or more, and a TV that needs an
 * update. Never a full-screen warning (K11). Nothing at all on a box that sent no follower fields. O23: after 6 hours
 * (`lostSince`, see masterLostSince) the away mark becomes a notice that names when the main box was last reached;
 * the content keeps playing under it.
 */
export function FollowerMarks({
  info,
  lang,
  lostSince = null,
  timeFormat = '12h',
  tz = 'Asia/Kuala_Lumpur',
  nowMs = Date.now(),
}: {
  info: FollowerInfo;
  lang: BoxLang;
  lostSince?: string | null;
  timeFormat?: '12h' | '24h';
  tz?: string;
  nowMs?: number;
}) {
  if (!info.away && !info.needsUpdate && lostSince === null) return null;
  return (
    <div class="fmarks" data-testid="follower-marks" lang={lang} dir={dirOf(lang)}>
      {lostSince !== null ? (
        <span class="fmark fmark--lost" data-mark="lost" role="status">
          {tl('linkMasterLost', lang, { time: fmtLostSince(lostSince, nowMs, timeFormat, tz, lang) })}
        </span>
      ) : info.away ? (
        <span class="fmark fmark--away" data-mark="away" role="status">
          {tl('linkMasterAway', lang)}
        </span>
      ) : null}
      {info.needsUpdate ? (
        <span class="fmark fmark--update" data-mark="update" role="status">
          {tl('linkNeedsUpdate', lang)}
        </span>
      ) : null}
    </div>
  );
}

/** The link QR and its two labels for the never-set-up box: "Pautkan ke surau sedia ada" and the app path line. */
export function SetupLinkBlock({
  qr,
  offsetMs,
  lang,
}: {
  qr: { payload: string; expiresAt: string } | null;
  offsetMs: number;
  lang: BoxLang;
}) {
  return (
    <div class="setuplink" data-testid="setup-link">
      {qr !== null ? (
        <div class="setuplink__qr">
          <LinkQr payload={qr.payload} expiresAt={qr.expiresAt} offsetMs={offsetMs} rem={17} lang={lang} />
          <div class="setuplink__label">{tl('setupExisting', lang)}</div>
        </div>
      ) : null}
      <p class="setuplink__line">{tl('setupHasMaxcom', lang)}</p>
    </div>
  );
}
