import { useEffect, useMemo, useState } from 'preact/hooks';
import type { KioskLive, Settings } from '@surau/core';
import { subscribeLive } from './bundle.ts';
import { PREVIEW_POLL_MS, isPreview, kioskFetch } from './preview.ts';

/**
 * What the kiosk knows about the live (Plan 5 Task 6). `playable` says whether this page may open the WHEP
 * player at all: never in preview (the admin app's pratonton shows the strip only).
 */
export type LiveView = KioskLive & {
  /** Which box path the kiosk should receive: 'surau' or 'surau-kiosk'. A change reconnects the player. */
  path?: string;
  playable: boolean;
};

const NOT_LIVE: KioskLive = { live: false, since: null, kuliah: null, audio: false, volume: 50 };
const FETCH_TIMEOUT_MS = 8000;
const MAX_TEXT = 200;

function text(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TEXT);
}

/** The box's KioskLive when the value has its shape; null for anything malformed (the caller ignores it). */
export function parseKioskLive(v: unknown): (KioskLive & { path?: string }) | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.live !== 'boolean') return null;
  if (o.since !== null && o.since !== undefined && typeof o.since !== 'string') return null;
  let kuliah: KioskLive['kuliah'] = null;
  if (o.kuliah !== null && o.kuliah !== undefined) {
    if (typeof o.kuliah !== 'object' || Array.isArray(o.kuliah)) return null;
    const k = o.kuliah as Record<string, unknown>;
    const label = text(k.label);
    const penceramah = text(k.penceramah);
    if (label === null || penceramah === null) return null;
    const topic = text(k.topic);
    kuliah = { label, penceramah, topic: topic === '' ? null : topic };
  }
  const volume = typeof o.volume === 'number' && Number.isFinite(o.volume) ? Math.min(100, Math.max(0, o.volume)) : 50;
  return {
    live: o.live,
    since: typeof o.since === 'string' ? o.since : null,
    kuliah,
    audio: o.audio === true,
    volume,
    ...(o.path === 'surau' || o.path === 'surau-kiosk' ? { path: o.path } : {}),
  };
}

/** GET /api/kiosk/live; null on any failure (network, 401, 503, bad JSON). Never throws. */
export async function fetchKioskLive(fetchImpl: typeof fetch = kioskFetch): Promise<KioskLive | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl('/api/kiosk/live', { signal: ctrl.signal, credentials: 'same-origin' });
    if (!res.ok) return null;
    return parseKioskLive(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface UseLiveOpts {
  fetchImpl?: typeof fetch;
  EventSourceImpl?: typeof EventSource;
}

/**
 * The live as the kiosk should show it. One GET at mount, then the `live` events of the shared stream (the
 * box sends one on every change and on connect). An event that arrived first wins over a late GET answer.
 * While `liveOnKiosk` is off everything is ignored. In preview: no stream, a GET every 30 s, never playable.
 */
export function useLive(settings: Settings, opts: UseLiveOpts = {}): LiveView {
  const enabled = settings.liveOnKiosk?.enabled === true;
  const preview = isPreview();
  const [live, setLive] = useState<KioskLive>(NOT_LIVE);
  const { fetchImpl, EventSourceImpl } = opts;

  useEffect(() => {
    if (!enabled) {
      setLive(NOT_LIVE);
      return undefined;
    }
    let alive = true;
    let heard = false;
    const fromGet = (): void => {
      void fetchKioskLive(fetchImpl ?? kioskFetch).then((k) => {
        if (!alive || k === null) return;
        // a `live` event is newer than a GET that was in flight when it arrived
        if (heard && !preview) return;
        setLive(k);
      });
    };
    let unsub: () => void = () => {};
    try {
      unsub = subscribeLive(
        (data) => {
          const k = parseKioskLive(data);
          if (!alive || k === null) return;
          heard = true;
          setLive(k);
        },
        EventSourceImpl ? { EventSourceImpl } : {},
      );
    } catch {
      // no stream: the GET (and the reload of the page) still keep the screen right
    }
    fromGet();
    const timer = preview ? setInterval(fromGet, PREVIEW_POLL_MS) : null;
    return () => {
      alive = false;
      unsub();
      if (timer !== null) clearInterval(timer);
    };
  }, [enabled, preview, fetchImpl, EventSourceImpl]);

  return useMemo<LiveView>(
    () => (enabled ? { ...live, playable: !preview } : { ...NOT_LIVE, playable: !preview }),
    [enabled, live, preview],
  );
}
