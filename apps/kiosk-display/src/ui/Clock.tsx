import { fmtClock } from '../format.ts';
import type { Lang } from '../i18n.ts';

export interface ClockProps {
  now: Date;
  timeFormat: '12h' | '24h';
  showSeconds: boolean;
  lang: Lang;
  /** 'hero' = the big top-left clock; 'compact' = the small clock on phase screens; 'shell' = the compact clock of the content screens. */
  variant?: 'hero' | 'compact' | 'shell';
  /** The surau's IANA zone; Kuala Lumpur when omitted. */
  tz?: string;
}

export function Clock({ now, timeFormat, showSeconds, lang, variant = 'hero', tz }: ClockProps) {
  const c = fmtClock(now, timeFormat, showSeconds, lang, tz);
  if (variant === 'shell') {
    return (
      <div class="region-clock clock--compact free-text" role="timer" data-role="clock">
        <span class="hm num" data-must="">{c.hm}</span>
        {showSeconds ? <small class="num">{c.s}</small> : null}
        {c.ampm ? <small class="ap">{c.ampm}</small> : null}
      </div>
    );
  }
  if (variant === 'compact') {
    return (
      <div class="phase__clock region-clock free-text" role="timer" data-role="clock">
        <span class="num" data-must="">{c.hm}</span>
        {showSeconds ? <small class="num">{c.s}</small> : null}
        {c.ampm ? <small>{c.ampm}</small> : null}
      </div>
    );
  }
  const aside = showSeconds || c.ampm;
  return (
    <div class="clock region-clock" role="timer" data-role="clock">
      <span class="clock__hm num free-text" data-must="">{c.hm}</span>
      {aside ? (
        <span class="clock__aside free-text">
          {showSeconds ? <span class="num">{c.s}</span> : null}
          {c.ampm ? <span>{c.ampm}</span> : null}
        </span>
      ) : null}
    </div>
  );
}
