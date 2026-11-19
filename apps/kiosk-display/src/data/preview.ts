import { useEffect, useState } from 'preact/hooks';
import { THEME_CONTRACT, THEME_STYLE_MAX_BYTES, isBuiltInTheme, isScreenId, isThemeName, packsError, sanitizeThemeStyles } from '@surau/core';
import type { InstalledPack, ScreenId, ThemeStyleEntry } from '@surau/core';

/**
 * Preview mode: the real kiosk page opened as `/?preview=1` inside the admin app (an iframe on the web, a
 * WebView on Android). It is not a paired display: it never pairs, never opens the change stream and loads
 * nothing until the host hands it a session token by postMessage. The token stays in memory only.
 */

/** Same shape the box accepts in `Authorization: Bearer` (apps/box-server/src/auth/authz.ts). */
export const PREVIEW_TOKEN_RE = /^[A-Za-z0-9_-]{1,200}$/;
export const PREVIEW_MESSAGE_TYPE = 'surau-preview';
/**
 * "Show this poster" from the admin app's poster editor: a box asset id (sha256 hex, as `/assets/:id`) and the
 * poster's title. Accepted only in preview mode, from the same verified sender as the token message, and only
 * after a token has arrived (the page cannot fetch the picture without one). Nothing else is read from it.
 */
export const PREVIEW_POSTER_MESSAGE_TYPE = 'surau-preview-poster';
export const PREVIEW_ASSET_ID_RE = /^[0-9a-f]{64}$/;
/** Same cap as the box's poster `title` (packages/core content schema). */
export const PREVIEW_POSTER_TITLE_MAX = 80;

export interface PreviewPoster {
  assetId: string;
  title: string;
  /** "Regangkan gambar" of the poster being edited; absent means true (as on a saved poster). */
  stretch?: boolean;
}
/** Bundle and content are re-read this often in preview (a paired display waits for change events instead). */
export const PREVIEW_POLL_MS = 30_000;

type Fetch = typeof fetch;

export function isPreview(search: string = globalThis.location?.search ?? ''): boolean {
  try {
    return new URLSearchParams(search).get('preview') === '1';
  } catch {
    return false;
  }
}

let token: string | null = null;
const tokenListeners = new Set<(t: string | null) => void>();

export function getPreviewToken(): string | null {
  return token;
}

function setPreviewToken(t: string | null): void {
  if (token === t) return;
  token = t;
  for (const fn of [...tokenListeners]) fn(t);
}

/**
 * The host's message as a plain object, or null when it must be ignored. A message counts only when it
 * comes from this page's own origin AND from the window that hosts it: `window.parent` (the admin app's page
 * on the web). On Android the host runs `window.postMessage` from inside the WebView's top-level page, where
 * `window.parent === window`, so the same check admits exactly that case and nothing else.
 */
function trustedMessage(ev: MessageEvent, win: Window): Record<string, unknown> | null {
  if (ev.origin !== win.location.origin) return null;
  if (ev.source === null || ev.source !== win.parent) return null;
  const d: unknown = ev.data;
  if (typeof d !== 'object' || d === null) return null;
  return d as Record<string, unknown>;
}

/** The token from a host message, or null when the message must be ignored (see {@link trustedMessage}). */
export function readPreviewMessage(ev: MessageEvent, win: Window = window): string | null {
  const m = trustedMessage(ev, win);
  if (!m || m.type !== PREVIEW_MESSAGE_TYPE) return null;
  return typeof m.token === 'string' && PREVIEW_TOKEN_RE.test(m.token) ? m.token : null;
}

/**
 * The poster from a host "show this poster" message, or null when it must be ignored: same sender checks as
 * the token, the asset id must be a 64-hex box asset id, the title a string (trimmed, cut at 80 characters,
 * empty allowed). The title is only ever rendered as a text node, never as markup.
 */
export function readPreviewPosterMessage(ev: MessageEvent, win: Window = window): PreviewPoster | null {
  const m = trustedMessage(ev, win);
  if (!m || m.type !== PREVIEW_POSTER_MESSAGE_TYPE) return null;
  if (typeof m.assetId !== 'string' || !PREVIEW_ASSET_ID_RE.test(m.assetId)) return null;
  if (typeof m.title !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const title = m.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, PREVIEW_POSTER_TITLE_MAX);
  // Only a real boolean is carried; anything else is ignored (absent = stretch).
  return typeof m.stretch === 'boolean' ? { assetId: m.assetId, title, stretch: m.stretch } : { assetId: m.assetId, title };
}

/**
 * "Show this theme, this screen, with these unsaved values" from the admin app's Ubah suai editor. Same sender
 * checks and same token rule as the poster; nothing is stored, the stage just wears it.
 */
export const PREVIEW_THEME_MESSAGE_TYPE = 'surau-preview-theme';
const STAGED_RE = /^[0-9a-f]{32}$/;

export interface PreviewTheme {
  theme: string;
  screen: ScreenId;
  entry: ThemeStyleEntry;
  /** A staged pack id (plan C), or null. */
  staged: string | null;
  /** What the staged pack's file says (base, version, pictures, defaults), so the stage can wear it before it is installed; null otherwise. */
  pack: InstalledPack | null;
}

/** The staged pack's facts from the host message as an installed-pack record, or null when they do not pass the same rules as a real record. */
function readStagedPack(theme: string, raw: unknown): InstalledPack | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (!isBuiltInTheme(p.base) || typeof p.version !== 'number') return null;
  const record = {
    assetId: '0'.repeat(64), version: p.version, title: theme, base: p.base, contract: THEME_CONTRACT, bytes: 0,
    fonts: [], screens: [], images: p.images ?? {}, defaults: p.defaults ?? {},
  };
  return packsError({ [theme]: record }) === null ? (record as InstalledPack) : null;
}

/**
 * The theme request from a host message, or null when it must be ignored: same sender checks as the token; the theme
 * a theme name, the screen a catalog screen, the entry sanitised as one ThemeStyleEntry (at most 32 KB of JSON),
 * `staged` 32 hex or absent.
 */
export function readPreviewThemeMessage(ev: MessageEvent, win: Window = window): PreviewTheme | null {
  const m = trustedMessage(ev, win);
  if (!m || m.type !== PREVIEW_THEME_MESSAGE_TYPE) return null;
  if (!isThemeName(m.theme) || !isScreenId(m.screen)) return null;
  if (typeof m.entry !== 'object' || m.entry === null || Array.isArray(m.entry)) return null;
  let bytes: number;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(m.entry)).length;
  } catch {
    return null;
  }
  if (bytes > THEME_STYLE_MAX_BYTES) return null;
  let staged: string | null = null;
  if (m.staged !== undefined && m.staged !== null) {
    if (typeof m.staged !== 'string' || !STAGED_RE.test(m.staged)) return null;
    staged = m.staged;
  }
  const entry = sanitizeThemeStyles({ [m.theme]: m.entry })[m.theme];
  if (!entry) return null;
  let pack: InstalledPack | null = null;
  if (m.pack !== undefined && m.pack !== null) {
    pack = readStagedPack(m.theme, m.pack);
    if (pack === null) return null;
  }
  return { theme: m.theme, screen: m.screen, entry, staged, pack };
}

let themeReq: PreviewTheme | null = null;
const themeListeners = new Set<(p: PreviewTheme | null) => void>();

function setPreviewThemeReq(p: PreviewTheme): void {
  themeReq = p;
  for (const fn of [...themeListeners]) fn(p);
}

let poster: PreviewPoster | null = null;
const posterListeners = new Set<(p: PreviewPoster | null) => void>();

export function getPreviewPoster(): PreviewPoster | null {
  return poster;
}

function setPreviewPoster(p: PreviewPoster | null): void {
  if (poster === p || (poster && p && poster.assetId === p.assetId && poster.title === p.title && poster.stretch === p.stretch)) return;
  poster = p;
  for (const fn of [...posterListeners]) fn(p);
}

let listener: ((ev: MessageEvent) => void) | null = null;

/** Listens for the host's token (and, after it, a poster to show). Idempotent; call it at page start. */
export function installPreviewListener(win: Window = window): () => void {
  if (listener) return () => undefined;
  const fn = (ev: MessageEvent): void => {
    // Only the preview page (`?preview=1`) ever acts on a host message; a paired display ignores them all.
    if (!isPreview()) return;
    const t = readPreviewMessage(ev, win);
    if (t !== null) {
      setPreviewToken(t);
      return;
    }
    // A poster is only meaningful once the page can fetch it: no token, no poster.
    if (token === null) return;
    const p = readPreviewPosterMessage(ev, win);
    if (p !== null) {
      setPreviewPoster(p);
      return;
    }
    const th = readPreviewThemeMessage(ev, win);
    if (th !== null) setPreviewThemeReq(th);
  };
  listener = fn;
  win.addEventListener('message', fn);
  return () => {
    win.removeEventListener('message', fn);
    if (listener === fn) listener = null;
  };
}

/** Preact hook: the current token (null until the host sends one, and always null outside preview). */
export function usePreviewToken(): string | null {
  const [t, setT] = useState<string | null>(() => (isPreview() ? token : null));
  useEffect(() => {
    if (!isPreview()) return undefined;
    installPreviewListener();
    setT(token);
    tokenListeners.add(setT);
    return () => {
      tokenListeners.delete(setT);
    };
  }, []);
  return t;
}

/** Preact hook: the poster the host asked the preview to show (null outside preview or until it asks). */
export function usePreviewPoster(): PreviewPoster | null {
  const [p, setP] = useState<PreviewPoster | null>(() => (isPreview() ? poster : null));
  useEffect(() => {
    if (!isPreview()) return undefined;
    installPreviewListener();
    setP(poster);
    posterListeners.add(setP);
    return () => {
      posterListeners.delete(setP);
    };
  }, []);
  return p;
}

/** Preact hook: the theme request of the host (null outside preview and before the token and the request). */
export function usePreviewTheme(): PreviewTheme | null {
  const [p, setP] = useState<PreviewTheme | null>(() => (isPreview() ? themeReq : null));
  useEffect(() => {
    if (!isPreview()) return undefined;
    installPreviewListener();
    setP(themeReq);
    themeListeners.add(setP);
    return () => {
      themeListeners.delete(setP);
    };
  }, []);
  return p;
}

/** Preact hook: fetches the extra pictures in preview (a no-op elsewhere); the result changes when they arrive. */
export function usePreviewExtraAssets(ids: readonly string[]): number {
  const [n, setN] = useState(0);
  const key = ids.join(',');
  const tok = usePreviewToken();
  useEffect(() => {
    if (!isPreview() || tok === null) return undefined;
    let alive = true;
    preparePreviewExtraAssets(ids).then(() => {
      if (alive) setN((x) => x + 1);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tok]);
  return n;
}

/** The kiosk's fetch: plain outside preview; in preview a Bearer header and no cookies. */
export const kioskFetch: Fetch = (input, init) => {
  if (!isPreview()) return globalThis.fetch(input, init);
  const headers = new Headers(init?.headers);
  if (token !== null) headers.set('Authorization', `Bearer ${token}`);
  return globalThis.fetch(input, { ...init, headers, credentials: 'omit' });
};

// ---- Pictures --------------------------------------------------------------------------------------------
// <img src> cannot send a Bearer header, so preview fetches each picture as a blob and shows an object URL.
const objectUrls = new Map<string, string>();

/** Object URL of an already fetched picture; null if it is not (yet) available. */
export function previewAssetUrl(id: string): string | null {
  return objectUrls.get(id) ?? null;
}

let prepareChain: Promise<void> = Promise.resolve();
/** The last list the content loader asked for, and the extra ids (menu backgrounds) the stage asked for. */
let contentIds: readonly string[] = [];
let extraIds: readonly string[] = [];

/**
 * Fetches the pictures the content uses (once each) and drops the ones it no longer uses. Failures are
 * skipped. The picture of the poster the host asked for is always kept, whatever list the caller passes.
 * Calls run one after another, so two overlapping calls never fetch or create a URL for the same id twice.
 */
export function preparePreviewAssets(ids: readonly string[], fetchImpl: Fetch = kioskFetch): Promise<void> {
  contentIds = ids;
  const run = prepareChain.then(() => prepareNow(ids, fetchImpl));
  prepareChain = run.catch(() => undefined);
  return run;
}

async function prepareNow(ids: readonly string[], fetchImpl: Fetch): Promise<void> {
  const want = new Set(ids);
  if (poster) want.add(poster.assetId);
  for (const id of extraIds) want.add(id);
  for (const [id, url] of [...objectUrls]) {
    if (want.has(id)) continue;
    objectUrls.delete(id);
    revoke(url);
  }
  for (const id of want) {
    if (objectUrls.has(id)) continue;
    try {
      const res = await fetchImpl(`/assets/${id}`);
      if (!res.ok) continue;
      const next = URL.createObjectURL(await res.blob());
      const old = objectUrls.get(id);
      objectUrls.set(id, next);
      if (old !== undefined) revoke(old);
    } catch {
      /* the card drops itself */
    }
  }
}

/**
 * Menu background pictures of the screen on stage: fetched like the content pictures and kept whatever the
 * content loader passes. Resolves when they are available (or failed).
 */
export function preparePreviewExtraAssets(ids: readonly string[], fetchImpl: Fetch = kioskFetch): Promise<void> {
  extraIds = ids;
  const run = prepareChain.then(() => prepareNow(contentIds, fetchImpl));
  prepareChain = run.catch(() => undefined);
  return run;
}

function revoke(url: string): void {
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* already gone */
  }
}

/** Test aid: forget the token, the pictures and the listener. */
export function resetPreviewForTest(): void {
  if (listener) {
    window.removeEventListener('message', listener);
    listener = null;
  }
  token = null;
  tokenListeners.clear();
  poster = null;
  posterListeners.clear();
  themeReq = null;
  themeListeners.clear();
  for (const url of objectUrls.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }
  objectUrls.clear();
  contentIds = [];
  extraIds = [];
  prepareChain = Promise.resolve();
}
