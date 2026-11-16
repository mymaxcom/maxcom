import type { ComponentChildren } from 'preact';
import type { KioskView } from '../data/kiosk.ts';
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
}

/**
 * The head of a full-stage content screen (spec 4): the surau brand with its logo, the compact clock and the
 * next-prayer chip. Main renders the card region (`.region-main`) and the compact prayer strip around it, so the
 * rotation keeps one mounted layer across a switch between the main layout and the shell. The clock and the chip
 * sit in one row (`.shell-top`) so a clock with seconds can never run under the chip.
 */
export function ContentShell({ view, lang, children }: ContentShellProps) {
  const { state, settings, now, logo, tz } = view;
  const timeFormat = settings.prayerBar.timeFormat === '24h' ? '24h' : '12h';
  const showSeconds = settings.clock.showSeconds === true;
  return (
    <>
      <div class={`region-brand brand${logo ? ' has-logo' : ''}`}>
        <SurauLogo src={logo} class="ident__logo" />
        {nameShownOf(settings, logo) ? <span class="brand-name free-text">{surauNameOf(settings, lang)}</span> : null}
      </div>
      <div class="shell-top">
        {state.next ? <NextChip next={state.next} now={now} lang={lang} timeFormat={timeFormat} tz={tz} /> : null}
        <Clock now={now} timeFormat={timeFormat} showSeconds={showSeconds} lang={lang} variant="shell" tz={tz} />
      </div>
      {children}
    </>
  );
}
