import { useMemo } from 'preact/hooks';
import { fingerprintGroups } from '@surau/core';
import { dirOf, tb } from '../i18n-box.ts';
import type { BoxLang } from '../i18n-box.ts';
import { fmtMmSs, useSecondsLeft } from '../screens/Pair.tsx';
import { Qr, qrPath } from './Qr.tsx';

/** Every box code lives ten minutes (`NONCE_TTL_MS` on the box): the bar under the code runs down from that. */
const NONCE_LIFETIME_S = 600;

/**
 * Edge of the code in CSS pixels, at most `target`, such that every module is a whole number of device pixels.
 * A box QR is dense (about 110 modules); a module blurred across two pixels is what stops a phone reading it
 * from across a room.
 */
export function qrPixelSize(target: number, modules: number, dpr: number): number {
  if (modules <= 0) return 0;
  const scale = dpr > 0 ? dpr : 1;
  const perModule = Math.max(1, Math.floor((target * scale) / modules));
  return (perModule * modules) / scale;
}

export interface QrCardProps {
  payload: string | null | undefined;
  expiresAt: string | null | undefined;
  caption: string;
  /** Largest edge of the code, in rem of the kiosk grid (1rem = 1 % of the stage width). */
  rem: number;
  keyFp?: string;
  hint?: string;
  /** The box screen's language (Malay, English or Arabic). */
  lang: BoxLang;
}

/** The white card: the code, what it is, when it is replaced, and the fingerprint to check against the phone. */
export function QrCard({ payload, expiresAt, caption, rem, keyFp, hint, lang }: QrCardProps) {
  const left = useSecondsLeft(expiresAt ?? null);
  const text = payload ?? '';
  const modules = useMemo(() => qrPath(text)?.modules ?? 0, [text]);
  // The same unit styles.css sets on :root.
  const unit = Math.min(window.innerWidth, (window.innerHeight * 16) / 9) / 100;
  const px = qrPixelSize(rem * unit, modules, window.devicePixelRatio || 1);
  // The screen re-renders every second for the clock: the same vnode lets Preact skip redrawing a dense code.
  const code = useMemo(() => (px > 0 ? <Qr text={text} size={px} /> : null), [text, px]);
  const showCode = code !== null && left !== 0;

  return (
    <div class="qrcard" data-testid="qr-card" lang={lang} dir={dirOf(lang)}>
      <div class="qrcard__code" dir="ltr" style={{ width: `${rem}rem`, height: `${rem}rem` }}>
        {showCode ? code : <p class="qrcard__wait">{tb('pairRenewing', lang)}</p>}
      </div>
      <div class="qrcard__cap">{caption}</div>
      {showCode && left !== null ? (
        <>
          <div class="qrcard__left num">{tb('setupNewCodeIn', lang, { mmss: fmtMmSs(left) })}</div>
          <div class="qrcard__bar" aria-hidden="true">
            <i style={{ width: `${Math.min(100, (left / NONCE_LIFETIME_S) * 100)}%` }} />
          </div>
        </>
      ) : null}
      {keyFp ? (
        <div class="qrcard__fp">
          <span class="qrcard__fp-k">{tb('setupFingerprint', lang)}</span>
          <span class="qrcard__fp-v num" dir="ltr">{fingerprintGroups(keyFp)}</span>
        </div>
      ) : null}
      {hint ? <div class="qrcard__hint">{hint}</div> : null}
    </div>
  );
}
