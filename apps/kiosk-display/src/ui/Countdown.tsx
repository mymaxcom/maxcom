import { fmtCountdown } from '../format.ts';

export interface CountdownProps {
  /** Target instant; the countdown shows target - now, floored at zero. */
  to: Date | null;
  now: Date;
  class?: string;
}

export function Countdown({ to, now, class: cls }: CountdownProps) {
  const ms = to ? to.getTime() - now.getTime() : 0;
  return (
    <span class={`num${cls ? ` ${cls}` : ''}`} role="timer">
      {fmtCountdown(ms)}
    </span>
  );
}
