import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { buildCycle, currentSlot, dateOf, videoAfterPrayerSlots, videoSlotSeconds, zikirWindow } from '@surau/core';
import type { AfterPrayerSlot } from '@surau/core';
import type { KioskContent, Slot, SlotFeature } from '@surau/core';
import { num } from '../content/assets.ts';
import { subscribe, subscribePlayNow } from './bundle.ts';
import { clearMedia, keepMedia } from './media.ts';
import {
  PREVIEW_POLL_MS, isPreview, kioskFetch, preparePreviewAssets, usePreviewPoster, usePreviewTheme, usePreviewToken,
} from './preview.ts';
import type { PreviewPoster } from './preview.ts';
import type { KioskView } from './kiosk.ts';
import { tarawihMonthFor } from './tarawih.ts';
import { videoRoomSeconds } from '../video/room.ts';

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
  'kuliahCard', 'pengumuman', 'posters', 'videos', 'programKhas', 'takwim', 'hadis', 'worldTimes', 'tugasan', 'ayatCard', 'tabungCard',
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

/** Every picture the content refers to (speaker and duty photos, covers, posters, notice pictures, programme and calendar images), once each. */
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
  // A notice's picture (pengumuman bergambar, 2026.11.11): optional (`KioskPengumuman.pictureAssetId`).
  for (const p of content.pengumuman) add(p.pictureAssetId);
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

/** The rotation card a catalog screen shows (the inverse of screenOfCard); null for a screen with no card. */
export function cardOfScreen(screen: string): SlotFeature | null {
  switch (screen) {
    case 'kuliah': return 'kuliahCard';
    case 'pengumuman': return 'pengumuman';
    case 'poster': return 'posters';
    case 'program': return 'programKhas';
    case 'takwim': return 'takwim';
    case 'hadis': return 'hadis';
    case 'ayat': return 'ayatCard';
    case 'arab-ayat': return 'ayatCard';
    case 'arab-hadis': return 'hadis';
    case 'tabung': return 'tabungCard';
    default: return null;
  }
}

/** The catalog screens the preview forces onto the stage: the card screens, the zikir overlay and the live screen. */
export function isForcedScreen(screen: string): boolean {
  return cardOfScreen(screen) !== null || screen === 'zikir' || screen === 'arab-zikir' || screen === 'live';
}

export interface ContentView {
  /** The preview shows one forced content screen: no card of it means a notice, never a rotation card. */
  forced?: boolean;
  content: KioskContent | null;
  rotation: Slot[];
  current: ReturnType<typeof currentSlot>;
  zikir: ReturnType<typeof zikirWindow>;
  override: SlotFeature | null;
  /** A slot that cannot go on (a video that ended, failed or may not start) is given up: the rotation shows what follows. */
  skip?: (startedAt: Date) => void;
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

  const natural = useMemo(() => currentSlot(rotation, view.now, cycle.cycleStartSec, view.tz), [rotation, view.now, cycle.cycleStartSec, view.tz]);

  // Slots given up: a video that ended, failed, stalled or cannot play is skipped for the rest of its time (keyed by the
  // slot's start instant). A video that cannot finish before the next prayer phase or recitation is not started (soft rule).
  // The value is the instant the skip happened, recorded once: the slot that follows starts from it (a fixed start, so
  // its own page timer and its own skip key stay still while the time runs). Always after the skipped start, so a chain
  // of skips never meets its own key.
  const [skipped, setSkipped] = useState<ReadonlyMap<number, number>>(() => new Map());
  const nowRef = useRef(view.now);
  nowRef.current = view.now;
  // Videos tied to a prayer (afterPrayer): played once a day, outside the rotation, right after the prayer's zikir screen.
  // `afterDone` holds the ones that ended, failed or were given up today (date|itemId), kept across a reload of the page.
  const [afterDone, setAfterDone] = useState<ReadonlySet<string>>(() => (preview ? new Set<string>() : readAfterDone(dateOf(view.now, view.tz))));
  const afterStarts = useRef(new Map<number, string>());
  // "Main sekarang": a video item the box asked to show at once. It replaces the rotation until it ends, fails or is
  // replaced by a second press, then the rotation is what its own clock says. It lives in Main, so a prayer phase or a
  // live (which remove Main) end it with no more code. Never in a preview (the stream is not opened there).
  const [playNow, setPlayNow] = useState<{ itemId: string; startedAt: Date } | null>(null);
  const playNowRef = useRef(playNow);
  playNowRef.current = playNow;
  useEffect(
    () =>
      subscribePlayNow((data) => {
        const id = isObj(data) && typeof data.itemId === 'string' ? data.itemId : null;
        if (id !== null) setPlayNow({ itemId: id, startedAt: new Date() });
      }),
    [],
  );
  const skip = useCallback((startedAt: Date) => {
    const pn = playNowRef.current;
    if (pn !== null && pn.startedAt.getTime() === startedAt.getTime()) {
      setPlayNow(null);
      return;
    }
    const tied = afterStarts.current.get(startedAt.getTime());
    if (tied !== undefined) {
      setAfterDone((cur) => {
        if (cur.has(tied)) return cur;
        const day = tied.split('|')[0] ?? '';
        const next = new Set([...cur].filter((k) => k.startsWith(`${day}|`))).add(tied);
        if (!preview) writeAfterDone(next);
        return next;
      });
      return;
    }
    setSkipped((cur) => (cur.has(startedAt.getTime()) ? cur : new Map(cur).set(startedAt.getTime(), Math.max(nowRef.current.getTime(), startedAt.getTime() + 1))));
  }, [preview]);
  const roomChecked = useRef(new Set<number>());
  const today = view.state.today;
  const hijriMonth = view.hijri?.m;
  const tooLate = useMemo(() => {
    if (!natural || natural.slot.feature !== 'videos') return false;
    const key = natural.startedAt.getTime();
    if (skipped.has(key)) return false;
    // decided once per showing, when it is first seen
    if (roomChecked.current.has(key)) return false;
    roomChecked.current.add(key);
    if (roomChecked.current.size > 50) roomChecked.current = new Set([key]);
    const room = videoRoomSeconds(view.now, today ?? null, settings, content?.tilawah.slots ?? [], tarawihMonthFor(view.now, today ? [today] : [], settings) ?? hijriMonth, content?.zikir.length ?? 0);
    return room < natural.slot.durationSeconds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [natural, skipped]);
  useEffect(() => {
    if (tooLate && natural) skip(natural.startedAt);
  }, [tooLate, natural, skip]);
  const rotationCurrent = useMemo(() => {
    let cur = natural;
    let nat = natural; // the slot the clock itself is on: the chain walks the clock's boundaries, the shown start is the skip's
    for (let guard = 0; cur && nat && skipped.has(cur.startedAt.getTime()) && guard < rotation.length + 1; guard++) {
      const end = new Date(nat.startedAt.getTime() + nat.slot.durationSeconds * 1000);
      const after = currentSlot(rotation, end, cycle.cycleStartSec, view.tz);
      // one slot in the cycle: nothing else to show until the showing's time is over
      if (!after || after.index === nat.index) return null;
      // the following slot starts at the instant of the skip (fixed), or at its own start when that instant is past
      const at = skipped.get(cur.startedAt.getTime()) as number;
      if (at >= end.getTime()) {
        cur = after;
        nat = after;
        continue;
      }
      // An early skip: the slots that follow run from the skip instant, each for its own time, until the clock's own
      // next boundary (a video given up must not leave the next card up for the rest of the video's long slot).
      const slots = rotation.filter((s) => Number.isFinite(s.durationSeconds) && s.durationSeconds > 0);
      const nowMs = view.now.getTime();
      // The slot given up (same feature, item and part) and every one that gives itself up in this run is not shown again
      // before the clock's own boundary, however often the run wraps round the rotation.
      const same = (a: Slot, b: Slot): boolean => a.feature === b.feature && a.itemId === b.itemId && a.page === b.page;
      const out: Slot[] = [nat.slot];
      const left = (): number => slots.filter((s) => !out.some((o) => same(o, s))).length;
      // every turn of the run either moves the time on by a slot's own length or passes an excluded slot (at most one lap)
      const minSec = slots.reduce((m, s) => Math.min(m, s.durationSeconds), Infinity);
      const maxHops = Math.min(20_000, Math.ceil((end.getTime() - at) / (minSec * 1000)) * 2 + slots.length * 2 + 2);
      let t = at;
      let i = after.index;
      let run: NonNullable<typeof cur> | null = null;
      let last: NonNullable<typeof cur> | null = null; // the last slot that was shown and has run its time out
      for (let hops = 0; hops <= maxHops && t < end.getTime() && left() > 0; hops++) {
        const s = slots[i % slots.length]!;
        const idx = i % slots.length;
        i = (i + 1) % slots.length;
        if (out.some((o) => same(o, s))) continue;
        const next = skipped.get(t);
        if (next !== undefined) {
          out.push(s); // a video in this run that gave itself up: the one after it starts from that instant
          t = Math.max(next, t + 1);
          continue;
        }
        // the only slot left to show is kept up from its start until the clock's boundary (no spinning through itself)
        const stop = t + s.durationSeconds * 1000;
        if (left() === 1 || nowMs < stop || stop >= end.getTime()) {
          run = { slot: s, index: idx, startedAt: new Date(t) };
          break;
        }
        last = { slot: s, index: idx, startedAt: new Date(t) };
        t = stop;
      }
      // Nothing is left that can still be shown: the last slot of the run stays (it has started), else nothing.
      return run ?? last;
    }
    return cur;
  }, [natural, skipped, rotation, cycle.cycleStartSec, view.tz, view.now]);

  // Where today's after-prayer videos start; one that could not finish before the next phase or recitation is left out
  // (the same room rule as a video in the rotation, decided at its own start, so it is the same answer all day).
  const afterMonth = tarawihMonthFor(view.now, today ? [today] : [], settings) ?? hijriMonth;
  const afterSlots = useMemo((): AfterPrayerSlot[] => {
    if (!content) return [];
    return videoAfterPrayerSlots(content, settings, view.now, today ?? null, afterMonth).filter(
      (a) => videoRoomSeconds(new Date(a.startsAt.getTime() - 1), today ?? null, settings, content.tilawah.slots, afterMonth, content.zikir.length) >= a.durationSeconds,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, settings, klDate, today, afterMonth]);
  const doneKey = (a: AfterPrayerSlot): string => `${klDate}|${a.itemId}`;
  const afterNow = useMemo(() => {
    const t = view.now.getTime();
    return afterSlots.find((a) => a.startsAt.getTime() <= t && t < a.startsAt.getTime() + a.durationSeconds * 1000 && !afterDone.has(doneKey(a))) ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [afterSlots, second, afterDone]);
  afterStarts.current = new Map(afterSlots.map((a) => [a.startsAt.getTime(), doneKey(a)]));
  // the item must be on this box's list (an upload whose file is missing is not): else there is nothing to show and the press is dropped
  const playNowVideo = playNow !== null && !preview ? (content?.videos ?? []).find((v) => v.id === playNow.itemId) ?? null : null;
  const playNowSeconds = playNowVideo ? videoSlotSeconds(playNowVideo) : 0;
  useEffect(() => {
    if (playNow === null) return;
    if (playNowVideo === null && content !== null) setPlayNow(null);
    else if (playNowVideo !== null && view.now.getTime() >= playNow.startedAt.getTime() + playNowSeconds * 1000) setPlayNow(null);
  }, [playNow, playNowVideo, playNowSeconds, content, second]);
  const current = useMemo((): ReturnType<typeof currentSlot> => {
    if (playNow !== null && playNowVideo !== null && view.now.getTime() < playNow.startedAt.getTime() + playNowSeconds * 1000) {
      return { slot: { feature: 'videos', itemId: playNowVideo.id, durationSeconds: playNowSeconds }, index: -1, startedAt: playNow.startedAt };
    }
    if (!afterNow || preview) return rotationCurrent;
    return { slot: { feature: 'videos', itemId: afterNow.itemId, durationSeconds: afterNow.durationSeconds }, index: -1, startedAt: afterNow.startsAt };
  }, [afterNow, rotationCurrent, preview, playNow, playNowVideo, playNowSeconds, second]);

  // The zikir window needs the item count: until the content is there it is never computed with an unknown count (that
  // gave the full ceiling, then a shorter window once the list arrived: a flicker). Without content the last window
  // computed stays (null on a fresh mount: wait for the content).
  const lastZikir = useRef<ReturnType<typeof zikirWindow>>(null);
  const zikir = useMemo(() => {
    if (!content) return keptZikirWindow(lastZikir.current, view.now);
    const days = today ? [today] : [];
    const month = tarawihMonthFor(view.now, days, settings) ?? view.hijri?.m;
    const w = zikirWindow(view.now, days, settings, month, content.zikir.length);
    lastZikir.current = w;
    return w;
  }, [view.now, today, settings, view.hijri, content]);

  const urlOverride = useMemo(() => {
    try {
      return parseCardOverride(globalThis.location?.search ?? '');
    } catch {
      return null;
    }
  }, []);
  // Preview only: the Ubah suai editor asks for one catalog screen (spec 6.10.4); a card screen forces its card, the
  // zikir screen forces the overlay with the first zikir item.
  const previewTheme = usePreviewTheme();
  const themeScreen = preview && previewTheme && !previewPoster ? previewTheme.screen : null;
  const themeCard = themeScreen ? cardOfScreen(themeScreen) : null;
  const forced = themeScreen !== null && isForcedScreen(themeScreen);
  const override: SlotFeature | null = preview && previewPoster ? 'posters' : themeCard ?? (forced ? null : urlOverride);
  // Preview: a fake window that repeats every full pass over the items, so the editor shows the zikir items whatever
  // minutesAfterSolat is (the live window still treats 0 minutes as no zikir).
  const zikirOut = themeScreen === 'zikir' || themeScreen === 'arab-zikir'
    ? previewZikirWindow(view.now, content?.zikir.length ?? 0, settings.zikirSelepasSolat.durationSeconds)
    : forced ? null : zikir;

  return { forced, content, rotation, current, zikir: zikirOut, override, skip };
}

/** The window kept while the content is missing: only while it has not ended (a past window must not show a zikir screen). */
export function keptZikirWindow(last: ReturnType<typeof zikirWindow>, now: Date): ReturnType<typeof zikirWindow> {
  return last !== null && last.endsAt.getTime() > now.getTime() ? last : null;
}

/**
 * The editor preview's zikir window: every item once at `durationSeconds` (20 s when unset), repeating. It does not use
 * minutesAfterSolat, so the preview is never blank for a surau whose setting is 0. Null with no item.
 */
export function previewZikirWindow(now: Date, itemCount: number, durationSeconds: unknown): { prayer: 'zohor'; startsAt: Date; endsAt: Date } | null {
  if (!(itemCount > 0)) return null;
  const d = num(durationSeconds, 20);
  const spanMs = itemCount * (d > 0 ? d : 20) * 1000;
  const start = Math.floor(now.getTime() / spanMs) * spanMs;
  return { prayer: 'zohor', startsAt: new Date(start), endsAt: new Date(start + spanMs) };
}

const AFTER_DONE_KEY = 'surau.afterPrayerDone';

/** The after-prayer videos already played or given up on `date` (the entries of other days are forgotten). */
function readAfterDone(date: string): ReadonlySet<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(AFTER_DONE_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && x.startsWith(`${date}|`)) : []);
  } catch {
    return new Set();
  }
}

function writeAfterDone(done: ReadonlySet<string>): void {
  try {
    localStorage.setItem(AFTER_DONE_KEY, JSON.stringify([...done]));
  } catch {
    /* storage full or blocked: the in-memory set still holds for this page */
  }
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
    ...(p.stretch === undefined ? {} : { stretch: p.stretch }),
    updatedAt: content.date, updatedBy: 'preview',
  } as unknown as KioskContent['posters'][number];
  return { ...content, posters: [poster] };
}
