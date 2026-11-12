import { isValidTimeZone } from '@surau/core';
import type { PrayerDay, ResolvedDay, Settings } from '@surau/core';
import { clearMedia } from './media.ts';
import { isPreview, kioskFetch } from './preview.ts';

/** The surau's prayer-time context (Plan 13): time zone and the finished source line for today. Absent in an old bundle. */
export interface PrayerInfo {
  country: string;
  hasOfficial: boolean;
  timezone: string;
  utcOffsetMinutes: number;
  footerMs: string;
  footerEn: string;
}

export interface Bundle {
  version: number;
  zone: string;
  /** Resolved days; an old bundle's rows carry no source fields (read them through todaySourceOf). */
  days: ResolvedDay[];
  prayer?: PrayerInfo;
  settings: Settings;
  serverTime: string;
  /** Public URL of the surau logo (`/surau-logo?v=...`), or null when none is set. */
  logo: string | null;
}

/** The only logo URL the kiosk will put in an <img>: the box's own public route, same origin, with its version tag. */
const LOGO_URL_RE = /^\/surau-logo(?:\?v=[0-9a-f]{1,64})?$/;

/** The bundle's `logo` when it is exactly the box's public logo URL; anything else is treated as no logo. */
export function logoUrlOf(v: unknown): string | null {
  return typeof v === 'string' && LOGO_URL_RE.test(v) ? v : null;
}

export interface LoadedBundle {
  bundle: Bundle;
  source: 'network' | 'cache';
  /** ms epoch when the bundle was fetched from the network. */
  fetchedAt: number;
}

/** The box answered 401: this display is not paired and has no cached bundle to keep showing. */
export class NotPairedError extends Error {
  constructor() {
    super('not paired');
    this.name = 'NotPairedError';
  }
}

let notPaired = false;
const notPairedListeners = new Set<(v: boolean) => void>();

/** True while the box refuses this display (401) but a cached bundle keeps the screen running. */
export function isNotPaired(): boolean {
  return notPaired;
}

export function setNotPaired(v: boolean): void {
  if (notPaired === v) return;
  notPaired = v;
  for (const fn of [...notPairedListeners]) fn(v);
}

export function onNotPairedChange(fn: (v: boolean) => void): () => void {
  notPairedListeners.add(fn);
  return () => {
    notPairedListeners.delete(fn);
  };
}

const STORAGE_KEY = 'surau.bundle';
const FETCH_TIMEOUT_MS = 8000;

const PRAYERS = ['imsak', 'subuh', 'syuruk', 'zohor', 'asar', 'maghrib', 'isyak'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isDay(v: unknown): v is ResolvedDay {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  if (typeof d.date !== 'string' || !DATE_RE.test(d.date)) return false;
  if (typeof d.hijri !== 'object' || d.hijri === null) return false;
  const t = d.times;
  if (typeof t !== 'object' || t === null) return false;
  const times = t as Record<string, unknown>;
  return PRAYERS.every((p) => typeof times[p] === 'string' && TIME_RE.test(times[p] as string));
}

const FOOTER_MAX = 300;

/** The `prayer` block when it has the exact shape and a real IANA zone; anything else is treated as absent. */
export function parsePrayerInfo(v: unknown): PrayerInfo | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const p = v as Record<string, unknown>;
  if (
    typeof p.country !== 'string' ||
    typeof p.hasOfficial !== 'boolean' ||
    !isValidTimeZone(p.timezone) ||
    typeof p.utcOffsetMinutes !== 'number' ||
    !Number.isFinite(p.utcOffsetMinutes) ||
    typeof p.footerMs !== 'string' ||
    typeof p.footerEn !== 'string'
  ) {
    return undefined;
  }
  return {
    country: p.country,
    hasOfficial: p.hasOfficial,
    timezone: p.timezone,
    utcOffsetMinutes: p.utcOffsetMinutes,
    footerMs: p.footerMs.slice(0, FOOTER_MAX),
    footerEn: p.footerEn.slice(0, FOOTER_MAX),
  };
}

/** Validates the envelope; malformed day rows are dropped, the rest of the bundle is kept. */
function parseBundle(v: unknown): Bundle | null {
  if (typeof v !== 'object' || v === null) return null;
  const b = v as Record<string, unknown>;
  if (
    !Array.isArray(b.days) ||
    typeof b.settings !== 'object' || b.settings === null || Array.isArray(b.settings) ||
    typeof b.version !== 'number'
  ) {
    return null;
  }
  const { prayer: _raw, ...rest } = b as unknown as Bundle & { prayer?: unknown };
  void _raw;
  const prayer = parsePrayerInfo(b.prayer);
  return { ...rest, days: b.days.filter(isDay), logo: logoUrlOf(b.logo), ...(prayer ? { prayer } : {}) };
}

function defaultStorage(): Storage | undefined {
  // Preview mode keeps nothing on the device.
  if (isPreview()) return undefined;
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function readCache(storage: Storage | undefined): { bundle: Bundle; fetchedAt: number } | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { bundle?: unknown; fetchedAt?: unknown };
    const bundle = parseBundle(parsed.bundle);
    if (!bundle || typeof parsed.fetchedAt !== 'number') return null;
    return { bundle, fetchedAt: parsed.fetchedAt };
  } catch {
    return null;
  }
}

export async function loadBundle(
  fetchImpl: typeof fetch = kioskFetch,
  storage: Storage | undefined = defaultStorage(),
): Promise<LoadedBundle> {
  let failure = 'unknown';
  let unauthorised = false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl('/api/kiosk/bundle', { signal: ctrl.signal, credentials: 'same-origin' });
    if (res.status === 401) {
      unauthorised = true;
      if (!isPreview()) clearMedia();
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json: unknown = await res.json();
    const parsed = parseBundle(json);
    if (!parsed) throw new Error('bad bundle shape');
    const fetchedAt = Date.now();
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify({ bundle: parsed, fetchedAt }));
    } catch {
      // quota or storage disabled: the live bundle is still good
    }
    if (!isPreview()) setNotPaired(false);
    return { bundle: parsed, source: 'network', fetchedAt };
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }
  const cached = readCache(storage);
  if (unauthorised && !isPreview()) setNotPaired(true);
  if (cached) return { bundle: cached.bundle, source: 'cache', fetchedAt: cached.fetchedAt };
  if (unauthorised) throw new NotPairedError();
  throw new Error(`no data: ${failure}`);
}

const BACKOFF_START_MS = 2000;
const BACKOFF_MAX_MS = 60000;

/** One EventSource per page (and per implementation): every subscriber shares it. */
interface Hub {
  listeners: Set<(version: number) => void>;
  /** `live` event subscribers (Plan 5 Task 6): handed the parsed JSON, validated by data/live.ts. */
  liveListeners: Set<(data: unknown) => void>;
  es: EventSource | null;
  timer: ReturnType<typeof setTimeout> | null;
  delay: number;
  stopped: boolean;
}

const hubs = new Map<unknown, Hub>();

function openHub(ES: typeof EventSource, hub: Hub): void {
  const connect = (): void => {
    hub.timer = null;
    if (hub.stopped) return;
    const cur = new ES('/api/kiosk/events');
    hub.es = cur;
    cur.onopen = () => {
      hub.delay = BACKOFF_START_MS;
    };
    cur.addEventListener('changed', (ev: Event) => {
      try {
        const data = JSON.parse((ev as MessageEvent<string>).data) as { version?: unknown };
        if (typeof data.version === 'number') for (const fn of [...hub.listeners]) fn(data.version);
      } catch {
        // ignore malformed event
      }
    });
    cur.addEventListener('live', (ev: Event) => {
      let data: unknown;
      try {
        data = JSON.parse((ev as MessageEvent<string>).data);
      } catch {
        return; // ignore malformed event
      }
      for (const fn of [...hub.liveListeners]) {
        try {
          fn(data);
        } catch {
          // a bad live subscriber never breaks the change stream
        }
      }
    });
    cur.onerror = () => {
      cur.close();
      if (hub.stopped || hub.es !== cur) return;
      hub.es = null;
      hub.timer = setTimeout(connect, hub.delay);
      hub.delay = Math.min(hub.delay * 2, BACKOFF_MAX_MS);
    };
  };
  connect();
}

function hubFor(ES: typeof EventSource): Hub {
  let hub = hubs.get(ES);
  if (!hub) {
    hub = { listeners: new Set(), liveListeners: new Set(), es: null, timer: null, delay: BACKOFF_START_MS, stopped: false };
    hubs.set(ES, hub);
    openHub(ES, hub);
  }
  return hub;
}

function release(ES: typeof EventSource, hub: Hub): void {
  if (hub.listeners.size > 0 || hub.liveListeners.size > 0) return;
  hub.stopped = true;
  if (hub.timer !== null) clearTimeout(hub.timer);
  hub.timer = null;
  hub.es?.close();
  hub.es = null;
  if (hubs.get(ES) === hub) hubs.delete(ES);
}

/** Subscribes to the box's change events over a single shared stream; the last unsubscribe closes it. */
export function subscribe(
  onChange: (version: number) => void,
  opts: { EventSourceImpl?: typeof EventSource } = {},
): () => void {
  // A preview is not a paired display: it never opens the change stream (it polls instead).
  if (isPreview()) return () => {};
  const ES = opts.EventSourceImpl ?? globalThis.EventSource;
  if (!ES) return () => {};
  const mine = hubFor(ES);
  mine.listeners.add(onChange);
  return () => {
    if (!mine.listeners.delete(onChange)) return;
    release(ES, mine);
  };
}

/**
 * Subscribes to the box's `live` events on the same shared stream (one EventSource per page). The payload is
 * the parsed JSON, unvalidated: data/live.ts checks its shape. Preview never opens the stream.
 */
export function subscribeLive(
  onLive: (data: unknown) => void,
  opts: { EventSourceImpl?: typeof EventSource } = {},
): () => void {
  if (isPreview()) return () => {};
  const ES = opts.EventSourceImpl ?? globalThis.EventSource;
  if (!ES) return () => {};
  const mine = hubFor(ES);
  mine.liveListeners.add(onLive);
  return () => {
    if (!mine.liveListeners.delete(onLive)) return;
    release(ES, mine);
  };
}

/** Test aid: closes and forgets every shared stream. */
export function resetSharedStream(): void {
  for (const hub of hubs.values()) {
    hub.stopped = true;
    if (hub.timer !== null) clearTimeout(hub.timer);
    hub.es?.close();
  }
  hubs.clear();
}
