import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { buildCycle, currentSlot, dateOf, zikirWindow } from '@surau/core';
import type { KioskContent, Slot, SlotFeature } from '@surau/core';
import { subscribe } from './bundle.ts';
import { clearMedia, keepMedia } from './media.ts';
import {
  PREVIEW_POLL_MS, isPreview, kioskFetch, preparePreviewAssets, usePreviewPoster, usePreviewToken,
} from './preview.ts';
import type { PreviewPoster } from './preview.ts';
import type { KioskView } from './kiosk.ts';
import { tarawihMonthFor } from './tarawih.ts';

export interface LoadedContent {
  content: KioskContent;
  source: 'network' | 'cache';
  /** ms epoch when the content was fetched from the network. */
  fetchedAt: number;
}

const STORAGE_KEY = 'surau.content';
const FETCH_TIMEOUT_MS = 8000;
const RELOAD_MS = 15 * 60 * 1000;

const LIST_KEYS = ['kuliah', 'pengumuman', 'ticker', 'posters', 'programKhas', 'takwim', 'worldTimes', 'tugasan', 'zikir'] as const;
const FEATURES: readonly SlotFeature[] = [
  'kuliahCard', 'pengumuman', 'posters', 'programKhas', 'takwim', 'hadis', 'worldTimes', 'tugasan', 'ayatCard', 'tabungCard',
];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Envelope check only: the box validates content, the kiosk just refuses shapes it cannot render. */
function parseContent(v: unknown): KioskContent | null {
  if (!isObj(v) || typeof v.date !== 'string') return null;
  for (const k of LIST_KEYS) if (!Array.isArray(v[k])) return null;
  if (!isObj(v.ayat) || !isObj(v.tilawah) || !isObj(v.credits)) return null;
  if (!Array.isArray(v.tilawah.slots) || !isObj(v.tilawah.available)) return null;
  // A snapshot kept by an older box has no hadisToday: it simply has no hadis card.
  if (v.hadisToday !== undefined && !Array.isArray(v.hadisToday)) return null;
  // The donation card (Plan 7): a box older than that sends none; a bad shape is refused like the others.
  if (v.tabung !== undefined && v.tabung !== null && (!isObj(v.tabung) || !Array.isArray(v.tabung.rows))) return null;
  return { ...v, hadisToday: v.hadisToday ?? [] } as unknown as KioskContent;
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

function readCache(storage: Storage | undefined): { content: KioskContent; fetchedAt: number } | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { content?: unknown; fetchedAt?: unknown };
    const content = parseContent(parsed.content);
    if (!content || typeof parsed.fetchedAt !== 'number') return null;
    return { content, fetchedAt: parsed.fetchedAt };
  } catch {
    return null;
  }
}

/** The cached copy as a LoadedContent, for the synchronous first render; null when there is none. */
export function readCachedContent(storage: Storage | undefined = defaultStorage()): LoadedContent | null {
  const cached = readCache(storage);
  return cached ? { content: cached.content, source: 'cache', fetchedAt: cached.fetchedAt } : null;
}

const nextDay = (ymd: string): string => {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

/**
 * Content is built for `content.date`. Once the KL date is past it, today's ayat is `ayat.tomorrow` only when that
 * is exactly one day ahead of the content, else there is no ayat card; the hadis of the day is dropped.
 */
export function contentForDate(content: KioskContent, klDate: string): KioskContent {
  if (klDate <= content.date) return content;
  const ayat = klDate === nextDay(content.date) ? content.ayat.tomorrow : null;
  return { ...content, ayat: { today: ayat, tomorrow: null }, hadisToday: [] };
}

export async function loadContent(
  fetchImpl: typeof fetch = kioskFetch,
  storage: Storage | undefined = defaultStorage(),
): Promise<LoadedContent> {
  let failure = 'unknown';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl('/api/kiosk/content', { signal: ctrl.signal, credentials: 'same-origin' });
    if (res.status === 401 && !isPreview()) clearMedia();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json: unknown = await res.json();
    // The box answers { version, serverTime, content } (Plan 2 Task 7); unwrap the envelope.
    const content = parseContent(isObj(json) ? json.content : null);
    if (!content) throw new Error('bad content shape');
    const fetchedAt = Date.now();
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify({ content, fetchedAt }));
    } catch {
      // quota or storage disabled: the live content is still good
    }
    return { content, source: 'network', fetchedAt };
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }
  const cached = readCache(storage);
  if (cached) return { content: cached.content, source: 'cache', fetchedAt: cached.fetchedAt };
  throw new Error(`no content: ${failure}`);
}

const SHA256 = /^[0-9a-f]{64}$/;

/** Every picture the content refers to (speaker and duty photos, covers, posters, programme and calendar images), once each. */
export function assetIdsOf(content: KioskContent): string[] {
  const found = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === 'string' && SHA256.test(v)) found.add(v);
  };
  for (const k of content.kuliah) {
    add(k.penceramah?.photoAssetId);
    add(k.kitab?.coverAssetId);
  }
  for (const p of content.posters) add(p.assetId);
  for (const p of content.programKhas) add(p.assetId);
  for (const t of content.takwim) add(t.assetId);
  for (const t of content.tugasan) add(t.petugas?.photoAssetId);
  return [...found];
}

/**
 * Fetches every picture once, in the background, so the service worker keeps them: the card that shows a poster
 * may not come up for minutes, and the box may be down by then. Failures are ignored (the card drops itself).
 */
export async function warmAssets(
  content: KioskContent,
  fetchImpl: typeof fetch = kioskFetch,
): Promise<void> {
  for (const id of assetIdsOf(content)) {
    try {
      const res = await fetchImpl(`/assets/${id}`, { credentials: 'same-origin' });
      if (res.ok) await res.arrayBuffer();
    } catch {
      /* offline or refused: nothing to keep */
    }
  }
}

/** Reloads are serialised; a network result always wins, a cache fallback never replaces network content on screen. */
export function shouldReplaceContent(cur: LoadedContent | null, next: LoadedContent): boolean {
  if (!cur) return true;
  if (next.source === 'network') return true;
  return cur.source === 'cache';
}

/** '?card=kuliahCard' forces that feature's card. Proof aid only; unknown names are ignored. */
export function parseCardOverride(search: string): SlotFeature | null {
  const raw = new URLSearchParams(search).get('card');
  return FEATURES.find((f) => f === raw) ?? null;
}

export interface ContentView {
  content: KioskContent | null;
  rotation: Slot[];
  current: ReturnType<typeof currentSlot>;
  zikir: ReturnType<typeof zikirWindow>;
  override: SlotFeature | null;
}

export function useContent(view: KioskView): ContentView {
  // Seeded from the cache on the first render, so a Main that remounts after a prayer phase has content at once.
  const [loaded, setLoaded] = useState<LoadedContent | null>(() => readCachedContent());
  const loadedRef = useRef<LoadedContent | null>(loaded);
  const reloadRef = useRef<() => void>(() => undefined);

  // In preview nothing loads until the host has sent a token; a new token restarts the loop.
  const previewToken = usePreviewToken();
  const preview = isPreview();
  useEffect(() => {
    if (preview && !previewToken) return undefined;
    let alive = true;
    let inFlight = false;
    let pending = false;
    const reload = (): void => {
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = true;
      loadContent()
        .then(
          async (r) => {
            // Pictures need the Bearer header, so preview turns them into object URLs before the cards render.
            if (preview && r.source === 'network') await preparePreviewAssets(assetIdsOf(r.content));
            if (!alive) return;
            if (shouldReplaceContent(loadedRef.current, r)) {
              loadedRef.current = r;
              setLoaded(r);
              // Only a page the service worker controls can keep the pictures; without one this would be wasted traffic.
              if (!preview && r.source === 'network' && globalThis.navigator?.serviceWorker?.controller) {
                keepMedia(assetIdsOf(r.content));
                void warmAssets(r.content);
              }
            }
          },
          () => {
            // no content yet: the rotation stays empty and the prayer layer is unaffected
          },
        )
        .finally(() => {
          inFlight = false;
          if (pending && alive) {
            pending = false;
            reload();
          }
        });
    };
    reloadRef.current = reload;
    reload();
    const unsub = subscribe(() => reload());
    const timer = setInterval(reload, preview ? PREVIEW_POLL_MS : RELOAD_MS);
    return () => {
      alive = false;
      unsub();
      clearInterval(timer);
    };
  }, [preview, previewToken]);

  // The KL date rolling over reloads the content at once (a day's ayat and hadis change at midnight).
  const klDate = dateOf(view.now, view.tz);
  const lastDate = useRef(klDate);
  useEffect(() => {
    if (lastDate.current === klDate) return;
    lastDate.current = klDate;
    reloadRef.current();
  }, [klDate]);

  // Preview only: the admin app's poster editor asks for one poster (saved or still a draft) to be shown on
  // its own. The picture is fetched with the Bearer header like every other preview asset; the rotation is
  // replaced by that single poster until the host sends another one.
  const previewPoster = usePreviewPoster();
  const [posterFetched, setPosterFetched] = useState<string | null>(null);
  useEffect(() => {
    if (!preview || !previewPoster) return undefined;
    let alive = true;
    const base = loadedRef.current?.content;
    preparePreviewAssets([...(base ? assetIdsOf(base) : []), previewPoster.assetId]).then(() => {
      if (alive) setPosterFetched(previewPoster.assetId);
    });
    return () => {
      alive = false;
    };
  }, [preview, previewPoster, loaded]);

  const raw = loaded?.content ?? null;
  const content = useMemo(() => {
    const dated = raw ? contentForDate(raw, klDate) : null;
    if (!preview || !previewPoster) return dated;
    return withPreviewPoster(dated ?? emptyContent(klDate), previewPoster);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, klDate, preview, previewPoster, posterFetched]);
  const { settings } = view;
  // The cycle is rebuilt when content, settings or the second change (cheap): it is a pure function of the time,
  // so the hadis of each cycle (one per cycle, a long one in parts), a programKhas past `hideAfterMinutes` and
  // the KL date roll-over all take effect on time, no reload.
  const second = Math.floor(view.now.getTime() / 1000);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cycle = useMemo(() => (content ? buildCycle(content, settings, view.now) : { slots: [], cycleStartSec: 0 }), [content, settings, second]);
  const rotation = cycle.slots;

  const current = useMemo(() => currentSlot(rotation, view.now, cycle.cycleStartSec, view.tz), [rotation, view.now, cycle.cycleStartSec, view.tz]);

  const today = view.state.today;
  const zikir = useMemo(() => {
    const days = today ? [today] : [];
    const month = tarawihMonthFor(view.now, days, settings) ?? view.hijri?.m;
    return zikirWindow(view.now, days, settings, month);
  }, [view.now, today, settings, view.hijri]);

  const urlOverride = useMemo(() => {
    try {
      return parseCardOverride(globalThis.location?.search ?? '');
    } catch {
      return null;
    }
  }, []);
  const override: SlotFeature | null = preview && previewPoster ? 'posters' : urlOverride;

  return { content, rotation, current, zikir, override };
}

/** The id the preview gives the host's poster; never a box item id (those are UUIDs). */
export const PREVIEW_POSTER_ID = 'preview-poster';

/** A content snapshot with nothing in it, for a preview that has no content yet but a poster to show. */
export function emptyContent(date: string): KioskContent {
  return {
    date,
    kuliah: [], pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [],
    hadisToday: [], worldTimes: [], tugasan: [],
    ayat: { today: null, tomorrow: null },
    zikir: [],
    tilawah: { slots: [], available: {} },
    credits: { translation: '', font: '', audio: '' },
  } as unknown as KioskContent;
}

/** [content] with its posters replaced by the one the host asked the preview to show. */
export function withPreviewPoster(content: KioskContent, p: PreviewPoster): KioskContent {
  const poster = {
    id: PREVIEW_POSTER_ID, assetId: p.assetId, title: p.title, days: ['umum'], order: 0,
    updatedAt: content.date, updatedBy: 'preview',
  } as unknown as KioskContent['posters'][number];
  return { ...content, posters: [poster] };
}
