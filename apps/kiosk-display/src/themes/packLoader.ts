// An installed theme pack on the stage: its one stylesheet over the base theme, with a fallback to the base.
import { useCallback, useEffect, useState } from 'preact/hooks';
import { isPreview, kioskFetch, getPreviewToken } from '../data/preview.ts';
import { packHash } from './index.ts';
import type { ResolvedTheme } from './index.ts';
import { PROTECTED_CSS } from './protectedCss.ts';

export type PackState = 'none' | 'loading' | 'ready' | 'failed';
export const PACK_LINK_ID = 'mx-theme-pack';
export const PACK_RETRY_MS = 60_000;
export const PROTECTED_STYLE_ID = 'mx-protected';
/** A rejection by the health check is forgotten after this long, so a transient fault does not keep a pack off for weeks (a real fault rejects it again). */
export const PACK_REJECT_CLEAR_MS = 30 * 60_000;

/** The protected rules, as the last element of <head> (after the pack's own stylesheet, so they win ties). */
function attachProtected(): void {
  document.getElementById(PROTECTED_STYLE_ID)?.remove();
  const style = document.createElement('style');
  style.id = PROTECTED_STYLE_ID;
  style.textContent = PROTECTED_CSS;
  document.head.appendChild(style);
}
const detachProtected = (): void => document.getElementById(PROTECTED_STYLE_ID)?.remove();

type Fetch = typeof fetch;

/** A pack address the kiosk may load: one of this page's own absolute paths, nothing else. */
const OWN_PACK_URL = /^\/(?:themes\/[a-z0-9-]{1,32}\/[0-9a-f]{16}-[1-9][0-9]{0,2}|api\/themes\/staged\/[0-9a-f]{32})\/(?:bundle\.css|images\/[a-z-]{1,12}\.(?:jpg|png))$/;

// ---- Preview: the stylesheet is fetched with the Bearer header and its addresses inlined -------------------------------
const made: string[] = [];

function revokeAll(): void {
  for (const u of made.splice(0)) {
    try {
      URL.revokeObjectURL(u);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Preview only: the bundle with every pack address replaced, because a stylesheet cannot send a Bearer header. Pictures
 * become blob: URLs. An address that cannot be fetched is left out (`none`), never left pointing at the network.
 */
export async function inlinePackCss(css: string, fetchImpl: Fetch): Promise<string> {
  const urls = new Set<string>();
  for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/g)) {
    const u = m[1] ?? m[2] ?? m[3] ?? '';
    if (OWN_PACK_URL.test(u)) urls.add(u);
  }
  const replaced = new Map<string, string>();
  for (const u of urls) {
    try {
      const res = await fetchImpl(u);
      if (!res.ok) continue;
      const obj = URL.createObjectURL(await res.blob());
      made.push(obj);
      replaced.set(u, obj);
    } catch {
      /* skipped below */
    }
  }
  return css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/g, (_all, a?: string, b?: string, c?: string) => {
    const u = a ?? b ?? c ?? '';
    const to = replaced.get(u);
    return to !== undefined ? `url("${to}")` : 'none';
  });
}

/** Where the active pack's stylesheet is: a paired display's own address, or the staged copy the host asked to preview. */
function sheetUrl(theme: ResolvedTheme, staged: string | null | undefined): string | null {
  if (staged) return `/api/themes/staged/${staged}/bundle.css`;
  return theme.cssUrl;
}

/**
 * Keeps one stylesheet element for the active pack in <head>. A load error leaves the base theme and tries again every
 * 60 s; `reject()` (the health check) leaves the base until the pack's version or the theme changes, or the page reloads.
 */
export function usePackCss(
  theme: ResolvedTheme,
  opts: { staged?: string | null; fetchImpl?: Fetch; enabled?: boolean } = {},
): { state: PackState; reject: (reason: string) => void } {
  // Off on the box's own screens (setup, pairing, recovery, stopped, network check): no pack stylesheet is in the page there.
  const url = theme.pack === null || opts.enabled === false ? null : sheetUrl(theme, opts.staged);
  const identity = url === null ? null : `${theme.name}@${theme.pack?.version ?? 0}@${url}`;
  const [loaded, setLoaded] = useState<{ id: string; state: 'ready' | 'failed' } | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const fetchImpl = opts.fetchImpl;

  useEffect(() => {
    if (url === null || identity === null || rejected === identity) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let el: HTMLLinkElement | HTMLStyleElement | null = null;
    const fail = (): void => {
      if (!alive) return;
      el?.remove();
      el = null;
      detachProtected();
      setLoaded({ id: identity, state: 'failed' });
      timer = setTimeout(() => setRetry((n) => n + 1), PACK_RETRY_MS);
    };
    document.getElementById(PACK_LINK_ID)?.remove();
    detachProtected();
    if (isPreview()) {
      // The preview page fetches the text itself (Bearer header) and inlines the pictures.
      const f = fetchImpl ?? kioskFetch;
      void (async () => {
        try {
          if (getPreviewToken() === null && fetchImpl === undefined) throw new Error('no token yet');
          const res = await f(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const text = await inlinePackCss(await res.text(), f);
          if (!alive) return;
          const style = document.createElement('style');
          style.id = PACK_LINK_ID;
          style.textContent = text;
          document.head.appendChild(style);
          el = style;
          attachProtected();
          setLoaded({ id: identity, state: 'ready' });
        } catch {
          fail();
        }
      })();
    } else {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.id = PACK_LINK_ID;
      link.href = url;
      link.addEventListener('load', () => {
        if (alive) setLoaded({ id: identity, state: 'ready' });
      });
      link.addEventListener('error', fail);
      document.head.appendChild(link);
      el = link;
      attachProtected();
    }
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
      el?.remove();
      detachProtected();
      if (isPreview()) revokeAll();
    };
  }, [url, identity, retry, rejected === identity, fetchImpl]);

  useEffect(() => {
    if (rejected === null) return undefined;
    const t = setTimeout(() => setRejected(null), PACK_REJECT_CLEAR_MS);
    return () => clearTimeout(t);
  }, [rejected]);

  const reject = useCallback(
    (_reason: string): void => {
      if (identity !== null) setRejected(identity);
    },
    [identity],
  );

  if (url === null || identity === null) return { state: 'none', reject };
  if (rejected === identity) return { state: 'failed', reject };
  if (loaded !== null && loaded.id === identity) return { state: loaded.state, reject };
  return { state: 'loading', reject };
}

/**
 * The address of one of the pack's pictures (a paired display loads it from its own folder; the preview page, which
 * cannot send a Bearer header from an <img>, fetches it and shows a blob). Null while there is none or it is not ready.
 */
export function usePackPicture(theme: ResolvedTheme, key: string | null, staged: string | null): string | null {
  const pack = theme.pack;
  const ext = pack !== null && key !== null && Object.prototype.hasOwnProperty.call(pack.images, key) ? pack.images[key as keyof typeof pack.images] : undefined;
  const path =
    pack === null || key === null || ext === undefined
      ? null
      : staged
        ? `/api/themes/staged/${staged}/images/${key}.${ext}`
        : `/themes/${theme.name}/${packHash(pack)}/images/${key}.${ext}`;
  const [blob, setBlob] = useState<{ path: string; url: string } | null>(null);
  useEffect(() => {
    if (path === null || !isPreview()) return undefined;
    let alive = true;
    let made: string | null = null;
    void (async () => {
      try {
        const res = await kioskFetch(path);
        if (!res.ok || !alive) return;
        made = URL.createObjectURL(await res.blob());
        if (alive) setBlob({ path, url: made });
        else URL.revokeObjectURL(made);
      } catch {
        /* the next layer shows */
      }
    })();
    return () => {
      alive = false;
      if (made !== null) {
        try {
          URL.revokeObjectURL(made);
        } catch {
          /* gone */
        }
      }
    };
  }, [path]);
  if (path === null) return null;
  if (!isPreview()) return path;
  return blob !== null && blob.path === path ? blob.url : null;
}
