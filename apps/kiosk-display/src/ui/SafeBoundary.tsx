import { Component } from 'preact';
import type { ComponentChildren, ErrorInfo } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { tzOf } from '@surau/core';
import type { PrayerDay, PrayerName, Settings } from '@surau/core';
import { fmtClock, fmtGregorian, fmtPrayerTime, prayerLabel } from '../format.ts';
import { surauNameOf, t } from '../i18n.ts';
import type { Lang } from '../i18n.ts';

/** After a crash the boundary tries the real screen tree again (the page reload is lane B's). */
const RETRY_MS = 30_000;
const ORDER: readonly PrayerName[] = ['imsak', 'subuh', 'syuruk', 'zohor', 'asar', 'maghrib', 'isyak'];

export interface SafeBoundaryProps {
  /** Today's row, if the data layer has one; the fallback omits the times when it is unusable. */
  today: PrayerDay | null;
  settings: Settings;
  lang: Lang;
  children: ComponentChildren;
}

interface SafeBoundaryState {
  error: unknown | null;
}

/**
 * Calm minimal screen shown while the real screen tree is broken: surau name, the clock
 * (ticked from Date directly, nothing shared with the crashed tree), today's date and the
 * seven prayer times when they are usable. Never blank.
 */
export function SafeScreen({ today, settings, lang }: Omit<SafeBoundaryProps, 'children'>) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  let timeFormat: '12h' | '24h' = '12h';
  let showSeconds = false;
  try {
    timeFormat = settings?.prayerBar?.timeFormat === '24h' ? '24h' : '12h';
    showSeconds = settings?.clock?.showSeconds === true;
  } catch {
    /* defaults */
  }
  const tz = tzOf(settings);
  const c = fmtClock(now, timeFormat, showSeconds, lang, tz);

  let date: string | null = null;
  try {
    date = fmtGregorian(now, lang, tz);
  } catch {
    date = null;
  }

  let times: { name: PrayerName; label: string; time: string }[] | null = null;
  try {
    if (today && today.times) {
      const rows = ORDER.map((p) => {
        const hhmm = today.times[p];
        if (typeof hhmm !== 'string' || !/^\d{2}:\d{2}$/.test(hhmm)) throw new Error(`bad time for ${p}`);
        return { name: p, label: prayerLabel(p, lang), time: fmtPrayerTime(hhmm, timeFormat) };
      });
      times = rows;
    }
  } catch {
    times = null;
  }

  return (
    <div class="screen screen--safe" data-testid="safe-screen">
      <div class="bg" aria-hidden="true">
        <div class="bg__shade" />
      </div>
      <div class="safe">
        <div class="ident__name">{surauNameOf(settings, lang)}</div>
        <div class="clock" role="timer" data-role="clock">
          <span class="clock__hm num">{c.hm}</span>
          {showSeconds || c.ampm ? (
            <span class="clock__aside">
              {showSeconds ? <span class="num">{c.s}</span> : null}
              {c.ampm ? <span>{c.ampm}</span> : null}
            </span>
          ) : null}
        </div>
        {date ? <div class="safe__date">{date}</div> : null}
        {times ? (
          <div class="safe__times glass" role="list" aria-label="Waktu solat">
            {times.map((row) => (
              <div key={row.name} role="listitem" class={`pcell${row.name === 'imsak' || row.name === 'syuruk' ? ' is-minor' : ''}`} data-prayer={row.name}>
                <span class="pcell__label">{row.label}</span>
                <span class="pcell__time num">{row.time}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Preact error boundary around the screen tree. A render error anywhere below it swaps
 * in SafeScreen (never a blank TV), logs the error, hands it to the window error handlers
 * (the global handler reloads the page) and retries the real tree after RETRY_MS.
 */
export class SafeBoundary extends Component<SafeBoundaryProps, SafeBoundaryState> {
  override state: SafeBoundaryState = { error: null };
  private retry: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(error: unknown): Partial<SafeBoundaryState> {
    return { error: error ?? new Error('unknown render error') };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('kiosk screen crashed; showing the safe screen', error, info?.componentStack ?? '');
    try {
      // A boundary-caught error is no longer "uncaught": re-announce it so the global
      // error handler (30 s reload) still sees it.
      if (typeof ErrorEvent === 'function') {
        const message = error instanceof Error ? error.message : String(error);
        window.dispatchEvent(new ErrorEvent('error', { error, message }));
      }
    } catch {
      /* reporting must never throw */
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.setState({ error: null });
    }, RETRY_MS);
  }

  override componentWillUnmount(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  override render() {
    const { today, settings, lang, children } = this.props;
    if (this.state.error !== null) return <SafeScreen today={today} settings={settings} lang={lang} />;
    return children;
  }
}
