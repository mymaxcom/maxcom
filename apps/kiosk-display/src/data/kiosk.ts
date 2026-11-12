import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { computeKioskState, dateOf, hijriForDisplay, resolveSettings, tzOf } from '@surau/core';
import type { HijriDate, KioskState, Settings } from '@surau/core';
import { loadBundle, subscribe } from './bundle.ts';
import type { LoadedBundle } from './bundle.ts';
import { useNow } from './clock.ts';
import { PREVIEW_POLL_MS, isPreview, usePreviewToken } from './preview.ts';
import { setKioskPhase, setKioskTz } from './recovery.ts';
import { todaySourceOf } from './todaySource.ts';
import type { TodaySource } from './todaySource.ts';
import { tarawihMonthFor } from './tarawih.ts';

export { tarawihMonthFor, todaySourceOf };
export type { TodaySource };

export interface KioskView {
  state: KioskState;
  settings: Settings;
  hijri: HijriDate | null;
  stale: boolean;
  now: Date;
  /** The surau's IANA time zone (the bundle's, Asia/Kuala_Lumpur for an old bundle). Every wall-clock read uses it. */
  tz: string;
  todaySource: TodaySource;
  daysAhead: number;
  ready: boolean;
  error: string | null;
  /** The surau logo's public URL from the bundle, or null when the surau has none. */
  logo: string | null;
}

const RELOAD_MS = 15 * 60 * 1000;
const STALE_MS = 10 * 60 * 1000;

/**
 * Whether an incoming result may replace the bundle currently shown.
 * Reloads are serialised, so results never arrive out of order: a fresh network
 * bundle always wins (even with a lower version, e.g. after the box DB was reset);
 * a cache fallback never replaces a network bundle already on screen.
 */
export function shouldReplace(cur: LoadedBundle | null, next: LoadedBundle): boolean {
  if (!cur) return true;
  if (next.source === 'network') return true;
  return cur.source === 'cache' && next.bundle.version >= cur.bundle.version;
}

export function useKiosk(): KioskView {
  const now = useNow();
  const [loaded, setLoaded] = useState<LoadedBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const alive = useRef(true);
  const loadedRef = useRef<LoadedBundle | null>(null);

  // In preview nothing loads until the host has sent a token; a new token restarts the loop.
  const previewToken = usePreviewToken();
  const preview = isPreview();
  useEffect(() => {
    if (preview && !previewToken) return undefined;
    alive.current = true;
    let inFlight = false;
    let pending = false;
    const reload = (): void => {
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = true;
      loadBundle()
        .then(
          (r) => {
            if (!alive.current) return;
            if (shouldReplace(loadedRef.current, r)) {
              loadedRef.current = r;
              setLoaded(r);
            }
            setError(null);
            setReady(true);
          },
          (e: unknown) => {
            if (!alive.current) return;
            setError(e instanceof Error ? e.message : String(e));
            setReady(true);
          },
        )
        .finally(() => {
          inFlight = false;
          if (pending && alive.current) {
            pending = false;
            reload();
          }
        });
    };
    reload();
    const unsub = subscribe((version) => {
      if (loadedRef.current?.bundle.version === version) return;
      reload();
    });
    const timer = setInterval(reload, preview ? PREVIEW_POLL_MS : RELOAD_MS);
    return () => {
      alive.current = false;
      unsub();
      clearInterval(timer);
    };
  }, [preview, previewToken]);

  const fallbackSettings = useMemo(() => resolveSettings({}), []);
  // Re-resolve on the client: a cached or older bundle may lack features or hold bad values.
  const settings = useMemo(
    () => (loaded ? resolveSettings(loaded.bundle.settings as Parameters<typeof resolveSettings>[0]) : fallbackSettings),
    [loaded, fallbackSettings],
  );
  const days = loaded?.bundle.days ?? [];
  const prayer = loaded?.bundle.prayer;
  const tz = prayer?.timezone ?? tzOf(settings);

  return useMemo<KioskView>(() => {
    try {
      const state = computeKioskState(now, days, settings, tarawihMonthFor(now, days, settings));
      setKioskPhase(state.phase);
      setKioskTz(tz);
      const hd = settings.hijriDate;
      const hijri = hd.enabled
        ? hijriForDisplay(now, days, hd.adjustDays, hd.switchAt, tz)
        : null;
      const today = dateOf(now, tz);
      const daysAhead = days.filter((d) => d.date >= today).length;
      const stale = loaded?.source === 'cache' && Date.now() - loaded.fetchedAt > STALE_MS;
      return {
        state,
        settings,
        hijri,
        stale,
        now,
        tz,
        todaySource: todaySourceOf(days, today, prayer),
        daysAhead,
        ready,
        error,
        logo: loaded?.bundle.logo ?? null,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setKioskPhase('noData');
      return {
        state: computeKioskState(now, [], fallbackSettings),
        settings: fallbackSettings,
        hijri: null,
        stale: false,
        now,
        tz: 'Asia/Kuala_Lumpur',
        todaySource: { source: 'official', emergency: false, footer: null },
        daysAhead: 0,
        ready,
        error: error ?? msg,
        logo: null,
      };
    }
  }, [now, loaded, settings, days, prayer, tz, ready, error, fallbackSettings]);
}
