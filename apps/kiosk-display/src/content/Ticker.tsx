import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { TickerItem } from '@surau/core';
import { t } from '../i18n.ts';
import type { Lang } from '../i18n.ts';
import { secondsSinceKlMidnight } from './paging.ts';

/** Seconds for the text to travel one strip width: slow / normal / fast. */
export function tickerSeconds(speed: unknown): number {
  return speed === 'slow' ? 90 : speed === 'fast' ? 40 : 60;
}

/** Items whose `from..to` window (KL dates) contains `today`, in stored order. */
export function activeTickerItems(items: TickerItem[], today: string): TickerItem[] {
  return items.filter((i) => i.from <= today && today <= i.to);
}

/** Static fallback (reduced motion): one item at a time, this many seconds each. */
const STATIC_SECONDS = 10;

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export interface TickerProps {
  items: TickerItem[];
  speed: unknown;
  now: Date;
  lang: Lang;
  /** The surau's IANA zone; Kuala Lumpur when omitted. */
  tz?: string;
}

/**
 * One-line strip above the prayer bar: the active texts scroll right-to-left as one CSS animation whose length
 * is measured from the real text width (so every speed means the same pixels per second). The start position is
 * taken from the KL clock once at measure time, so a reload resumes mid-stream instead of from the right edge.
 * With reduced motion the strip shows one item at a time instead. Mounted only inside Main.
 */
export function Ticker({ items, speed, now, lang, tz }: TickerProps) {
  const speedName = speed === 'slow' || speed === 'fast' ? speed : 'normal';
  const seconds = tickerSeconds(speedName);
  const reduced = prefersReducedMotion();
  const stripRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [anim, setAnim] = useState<{ duration: number; delay: number } | null>(null);
  const textKey = items.map((i) => `${i.id}:${i.text}`).join('\u001f');
  const nowRef = useRef(now);
  nowRef.current = now;

  useLayoutEffect(() => {
    if (reduced) return;
    const strip = stripRef.current;
    const track = trackRef.current;
    if (!strip || !track) return;
    const w = strip.clientWidth;
    const tw = track.scrollWidth; // includes the one-strip-width lead-in
    if (!(w > 0) || !(tw > 0)) return; // not laid out (tests)
    const duration = Math.max(1, (seconds * tw) / w);
    setAnim({ duration, delay: -(secondsSinceKlMidnight(nowRef.current, tz) % duration) });
  }, [textKey, seconds, reduced]);

  if (items.length === 0) return null;

  if (reduced) {
    const idx = Math.floor(secondsSinceKlMidnight(now, tz) / STATIC_SECONDS) % items.length;
    const item = items[idx]!;
    return (
      <div class="ticker glass" data-layer="ticker" data-speed={speedName} data-motion="static">
        <span class="ticker__cap">{t('tickerCap', lang)}</span>
        <div class="ticker__strip">
          <span class="ticker__static" key={item.id}>{item.text}</span>
        </div>
      </div>
    );
  }

  const style = anim ? `animation-duration:${anim.duration.toFixed(2)}s;animation-delay:${anim.delay.toFixed(2)}s` : undefined;
  return (
    <div class="ticker glass" data-layer="ticker" data-speed={speedName} data-motion="scroll">
      <span class="ticker__cap">{t('tickerCap', lang)}</span>
      <div class="ticker__strip" ref={stripRef}>
        <div class={`ticker__track${anim ? ' is-live' : ''}`} ref={trackRef} style={style}>
          {items.map((i, k) => (
            <span class="ticker__item" key={i.id}>
              {k > 0 ? <span class="ticker__dot" aria-hidden="true">{'•'}</span> : null}
              {i.text}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
