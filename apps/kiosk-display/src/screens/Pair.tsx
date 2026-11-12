import { useEffect, useState } from 'preact/hooks';
import { tzOf } from '@surau/core';
import type { Settings } from '@surau/core';
import { useBoxName } from '../data/boxState.ts';
import { useNow } from '../data/clock.ts';
import { usePairing } from '../data/pairing.ts';
import { PAIR_MENU_PATH, surauNameBox, tb, tbx } from '../i18n-box.ts';
import { LangSwitch } from '../ui/LangSwitch.tsx';
import { BoxClock, BoxLogo, textAttrs } from './BoxChrome.tsx';
import type { BoxLangProps } from './BoxChrome.tsx';

export interface PairProps extends BoxLangProps {
  /** Resolved settings (the fallback set when nothing is cached): clock format only. */
  settings: Settings;
  /** Called once the box has approved this display; the page reload lets every fetch carry the new cookie. */
  reload?: () => void;
  /** Test and preview hooks for the pairing driver. */
  pairing?: Parameters<typeof usePairing>[0];
}

/** '482913' -> ['482', '913']; an odd length or a non-6 code still splits into readable groups. */
export function groupCode(code: string): string[] {
  const digits = code.replace(/\D/g, '');
  if (digits.length <= 3) return [digits];
  const half = Math.ceil(digits.length / 2);
  return [digits.slice(0, half), digits.slice(half)];
}

/** Whole seconds left until `iso` at `nowMs`, never negative; null when the instant is unreadable. */
export function secondsLeft(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const end = new Date(iso).getTime();
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.ceil((end - nowMs) / 1000));
}

/** 581 -> '09:41'. */
export function fmtMmSs(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Real-time seconds left on the code (independent of the ?now= clock override). */
export function useSecondsLeft(expiresAt: string | null): number | null {
  const [left, setLeft] = useState(() => secondsLeft(expiresAt, Date.now()));
  useEffect(() => {
    setLeft(secondsLeft(expiresAt, Date.now()));
    if (!expiresAt) return;
    const id = setInterval(() => setLeft(secondsLeft(expiresAt, Date.now())), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  return left;
}

/**
 * Full-screen pairing: shown only on a display the box has refused and that has no cached
 * bundle. Identity block as on the main screen (name and clock, no date, no prayer data),
 * the six digits as the one loud thing in the centre, the instruction and the expiry under it.
 */
export function Pair({ lang, onLang, focus, settings, reload, pairing }: PairProps) {
  const now = useNow();
  const p = usePairing(pairing);
  const left = useSecondsLeft(p.expiresAt);
  const boxName = useBoxName();
  const timeFormat = settings.prayerBar.timeFormat === '24h' ? '24h' : '12h';
  const showSeconds = settings.clock.showSeconds === true;

  useEffect(() => {
    if (!p.paired) return;
    (reload ?? (() => window.location.reload()))();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.paired]);

  const state = p.paired ? 'paired' : p.error ? 'error' : p.code && left !== 0 ? 'code' : 'waiting';

  let centre;
  switch (state) {
    case 'paired':
      centre = <p class="pair__status">{tb('pairDone', lang)}</p>;
      break;
    case 'error':
      centre = (
        <>
          <p class="pair__status">{tb('pairUnreachable', lang)}</p>
          <p class="pair__sub">{tb('pairRetrying', lang)}</p>
        </>
      );
      break;
    case 'code': {
      const groups = groupCode(p.code ?? '');
      centre = (
        <>
          <div class="pair__code num" dir="ltr" data-code={p.code} aria-label={groups.join(' ')}>
            {groups.flatMap((g, i) => [i > 0 ? ' ' : null, <span key={i} class="pair__group">{g}</span>])}
          </div>
          {/* The string carries no-break spaces: its menu path must never split across two lines. */}
          <p class="pair__instruction">{tbx('pairInstruction', lang, { path: PAIR_MENU_PATH })}</p>
          {left !== null ? (
            <p class="pair__expiry">{tb('pairExpiresIn', lang, { mmss: fmtMmSs(left) })}</p>
          ) : null}
        </>
      );
      break;
    }
    case 'waiting':
    default:
      centre = <p class="pair__status">{tb('pairRenewing', lang)}</p>;
  }

  return (
    <div class="screen screen--pair box-screen" data-screen="pair" data-state={state} data-lang={lang}>
      <div class="ident" dir="ltr">
        <div class="ident__name">
          <bdi>{surauNameBox(settings, lang)}</bdi>
        </div>
        <BoxClock now={now} timeFormat={timeFormat} showSeconds={showSeconds} lang={lang} tz={tzOf(settings)} />
      </div>
      <div class="box-corner box-corner--pair" dir="ltr">
        <BoxLogo />
        {onLang ? <LangSwitch lang={lang} onPick={onLang} focus={focus} /> : null}
      </div>
      <div class="pair__centre" {...textAttrs(lang)}>
        <h1 class="pair__title">{tb('pairTitle', lang)}</h1>
        {centre}
        {boxName !== null ? <p class="pair__connected">{tbx('pairConnectedTo', lang, { name: boxName })}</p> : null}
      </div>
    </div>
  );
}
