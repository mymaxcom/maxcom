/** The player the kiosk page may frame (securityHeaders.ts KIOSK_CSP `frame-src`); no other host is ever framed. */
export const YT_ORIGIN = 'https://www.youtube-nocookie.com';

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The embed address of a video: autoplay, no controls, no related videos at the end, inline; `mute` follows the
 * item's sound switch (and is forced on by the caller where sound is not allowed). `enablejsapi` lets the page hear the
 * player end or fail (postMessage). A clip (`start`, `end` in seconds) only for a recording. Null for a bad id.
 */
export function youtubeEmbedUrl(id: string, opts: { muted: boolean; start?: number; end?: number; origin?: string }): string | null {
  if (!YT_ID.test(id)) return null;
  const q = new URLSearchParams({
    autoplay: '1', mute: opts.muted ? '1' : '0', controls: '0', rel: '0', playsinline: '1', modestbranding: '1', enablejsapi: '1',
  });
  if (opts.start !== undefined && opts.start > 0) q.set('start', String(Math.floor(opts.start)));
  if (opts.end !== undefined && opts.end > 0) q.set('end', String(Math.floor(opts.end)));
  if (opts.origin) q.set('origin', opts.origin);
  return `${YT_ORIGIN}/embed/${id}?${q.toString()}`;
}

/** What the embedded player says: `state` 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued; `error` when it cannot play. */
export interface PlayerSignal {
  state?: number;
  error?: boolean;
}

/** Reads a player message (`event.data`, a JSON string); null for anything that is not one of the two signals. */
export function readPlayerMessage(data: unknown): PlayerSignal | null {
  let m: unknown = data;
  if (typeof data === 'string') {
    try {
      m = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (typeof m !== 'object' || m === null) return null;
  const o = m as { event?: unknown; info?: unknown };
  if (o.event === 'onError') return { error: true };
  if (o.event === 'onStateChange' && typeof o.info === 'number') return { state: o.info };
  if (o.event === 'infoDelivery' && typeof o.info === 'object' && o.info !== null) {
    const s = (o.info as { playerState?: unknown }).playerState;
    if (typeof s === 'number') return { state: s };
  }
  return null;
}
