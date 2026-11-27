import type { ComponentChildren } from 'preact';
import type { KioskView } from '../data/kiosk.ts';
import { fmtGregorian, fmtHijri } from '../format.ts';
import { surauNameOf } from '../i18n.ts';
import type { Lang } from '../i18n.ts';
import { Clock } from '../ui/Clock.tsx';
import { nameShownOf, SurauLogo } from '../ui/Logo.tsx';
import { NextChip } from '../ui/NextChip.tsx';

export interface ContentShellProps {
  view: KioskView;
  lang: Lang;
  /** Whatever the shell holds beside its head (nothing today: the card region and the strip belong to Main). */
  children?: ComponentChildren;
  /** No clock in the head (the zikir screen with Tetapan zikir showClock off); the next-prayer chip stays. */
  hideClock?: boolean;
}

/**
 * The head of a full-stage content screen (spec 4): the surau brand with its logo, the day's dates under the name
 * (Gregorian, and Hijri when Tetapan hijriDate gives one, as on the main screen), the compact clock and the
 * next-prayer chip. The chip names the next prayer the strip highlights (a hidden Imsak or Syuruk is skipped). Main renders the card region (`.region-main`) and the compact prayer strip around it, so the
 * rotation keeps one mounted layer across a switch between the main layout and the shell. The clock and the chip
 * sit in one row (`.shell-top`) so a clock with seconds can never run under the chip.
 */
export function ContentShell({ view, lang, children, hideClock = false }: ContentShellProps) {
  const { settings, now, hijri, logo, tz } = view;
  const showName = nameShownOf(settings, logo);
  const timeFormat = settings.prayerBar.timeFormat === '24h' ? '24h' : '12h';
  const showSeconds = settings.clock.showSeconds === true;
  const nameText = showName ? surauNameOf(settings, lang) : '';
  const letters = Array.from(nameText).length;
  // A long name steps its size and tracking down (contract.css .name-t1/.name-t2); an Arabic one is not tracked at all.
  const nameStep = letters > 22 ? ' name-t2' : letters > 16 ? ' name-t1' : '';
  const nameArabic = Array.from(nameText).some((c) => c.charCodeAt(0) >= 0x600 && c.charCodeAt(0) <= 0x6ff) ? ' name-ar' : '';
  return (
    <>
      <div class={`region-brand brand has-logo${nameStep}${nameArabic}`}>
        <SurauLogo src={logo} class="ident__logo" />
        <div class="brand-text">
          {showName ? <span class="brand-name free-text">{nameText}</span> : null}
          <div class="shell-date free-text" data-testid="shell-date">
            <span class="shell-greg">{fmtGregorian(now, lang, tz)}</span>
            {hijri ? (
              <>
                <span class="sep" aria-hidden="true" />
                <span class="shell-hijri">{fmtHijri(hijri, lang)}</span>
              </>
            ) : null}
          </div>
        </div>
      </div>
      <div class="shell-top">
        <NextChip view={view} lang={lang} />
        {hideClock ? null : <Clock now={now} timeFormat={timeFormat} showSeconds={showSeconds} lang={lang} variant="shell" tz={tz} />}
      </div>
      {children}
    </>
  );
}
