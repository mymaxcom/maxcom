import { fmtCountdown } from '../format.ts';

export interface CountdownProps {
  /** Target instant; the countdown shows target - now, floored at zero. */
  to: Date | null;
  now: Date;
  class?: string;
  /** Optional `data-role` hook (the theme contract finds the azan, iqamah and syuruk countdown by it). */
  dataRole?: string;
  /** A part of a protected element that must show (health check): always so when it carries a `data-role`. */
  must?: boolean;
}

export function Countdown({ to, now, class: cls, dataRole, must }: CountdownProps) {
  const ms = to ? to.getTime() - now.getTime() : 0;
  return (
    <span class={`num${cls ? ` ${cls}` : ''}`} role="timer" data-role={dataRole} data-must={must === true || dataRole !== undefined ? '' : undefined}>
      {fmtCountdown(ms)}
    </span>
  );
}
