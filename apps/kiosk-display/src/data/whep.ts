import { createDecodeWatch } from './decodeWatch.ts';
import type { DecodeWatch } from './decodeWatch.ts';
import { kioskFetch } from './preview.ts';

/**
 * WHEP player for the kiosk (Plan 5 Task 6): one receive-only RTCPeerConnection against the box's own
 * `/api/kiosk/live/whep` proxy (same origin, the kiosk's cookie or loopback). No trickle ICE: gathering runs
 * to completion (2 s cap, the LAN is fast) before the single POST. A failed connection is closed and retried
 * with backoff 1, 2, 4 ... 15 s until `close()`; a 404 (no publisher, `tiada siaran`) is reported as
 * `nostream` and then retried the same way: it is never a permanent stop while the caller wants playback.
 * A 429 (every viewer slot of the box is taken) is reported as `toomany` and tried again at the longest backoff.
 *
 * The last picture is kept across a retry (D4): the stream that ended stays on the video element, frozen on its last
 * frame, until the new connection delivers its own; only `close()` clears the element.
 *
 * Edge on the box autoplays muted video. With audio on, the kiosk page has already been activated by its own
 * audio handling (Plan 2 beeps); if play() is still refused, the video falls back to muted so it never stalls.
 */

export type WhepState = 'connecting' | 'playing' | 'retrying' | 'nostream' | 'toomany' | 'unsupported' | 'closed';

export interface WhepOpts {
  audio: boolean;
  /** 0 to 100. */
  volume: number;
  onState?: (s: WhepState) => void;
  /**
   * Called at most once per session when the connection is up and video bytes arrive but the browser never
   * decodes a frame (a dead video decoder). Nothing is torn down or retried because of it. It is one report per
   * openWhep session, also across internal reconnects.
   */
  onDecodeStuck?: () => void;
  /**
   * O31: the tallest live picture this display should get (a box TV with little memory asks for 720). Sent to the box
   * as `?maxHeight=` on the offer; left out (or not a positive whole number) the box sends its usual picture.
   */
  maxHeight?: number;
  fetchImpl?: typeof fetch;
  RTCPeerConnectionImpl?: typeof RTCPeerConnection;
}

export interface WhepSession {
  close(): Promise<void>;
  /** The box's resource URL of the current WHEP session (for tests and diagnostics). */
  location(): string | null;
}

export const WHEP_URL = '/api/kiosk/live/whep';
const LOCATION_RE = /^\/api\/kiosk\/live\/whep\/[A-Za-z0-9_-]{1,128}$/;
const GATHER_CAP_MS = 2000;
const DISCONNECT_GRACE_MS = 3000;
const POST_TIMEOUT_MS = 8000;
const STATS_EVERY_MS = 5000;
/**
 * K1: how often the player tells the box its viewer still plays. The first message goes out shortly after the picture
 * plays (the box then treats the row as a fast one and forgets it 90 seconds after the last message); a box or a page
 * of an older build keeps its 30 minute rule.
 */
const ALIVE_FIRST_MS = 5_000;
const ALIVE_EVERY_MS = 30_000;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 15000;

/** The offer's address: with `?maxHeight=` only for a positive whole height (O31). */
function whepPostUrl(maxHeight: number | undefined): string {
  return typeof maxHeight === 'number' && Number.isInteger(maxHeight) && maxHeight > 0 ? `${WHEP_URL}?maxHeight=${maxHeight}` : WHEP_URL;
}

class NoStream extends Error {}
class TooMany extends Error {}

export function openWhep(video: HTMLVideoElement, opts: WhepOpts): WhepSession {
  const fetchImpl = opts.fetchImpl ?? kioskFetch;
  const PC = opts.RTCPeerConnectionImpl ?? (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection;
  const volume = Math.min(1, Math.max(0, (Number.isFinite(opts.volume) ? opts.volume : 50) / 100));
  let closed = false;
  let pc: RTCPeerConnection | null = null;
  let loc: string | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let statsTimer: ReturnType<typeof setInterval> | null = null;
  let aliveTimer: ReturnType<typeof setTimeout> | null = null;
  let stuckReported = false;
  let delay = BACKOFF_START_MS;
  let attempt = 0;

  const state = (s: WhepState): void => {
    try {
      opts.onState?.(s);
    } catch {
      /* the caller's problem, never the player's */
    }
  };

  const stuck = (): void => {
    if (stuckReported) return;
    stuckReported = true;
    try {
      opts.onDecodeStuck?.();
    } catch {
      /* the caller's problem, never the player's */
    }
  };

  const stopAlive = (): void => {
    if (aliveTimer !== null) clearTimeout(aliveTimer);
    aliveTimer = null;
  };

  /** K1: "still watching", to the viewer's own address; the answer does not matter (a box that forgot it is asked again by a reconnect). */
  const startAlive = (stale: () => boolean): void => {
    stopAlive();
    const send = (): void => {
      if (stale() || loc === null) return;
      void fetchImpl(`${loc}/alive`, { method: 'POST', credentials: 'same-origin' }).catch(() => undefined);
    };
    // one timer at a time: the first message 5 s after the picture plays, then one every 30 s
    const next = (wait: number): void => {
      aliveTimer = setTimeout(() => {
        send();
        next(ALIVE_EVERY_MS);
      }, wait);
    };
    next(ALIVE_FIRST_MS);
  };

  const stopStats = (): void => {
    if (statsTimer !== null) clearInterval(statsTimer);
    statsTimer = null;
  };

  /** Samples the inbound video stats every few seconds while connected and feeds the decode watch. */
  const startStats = (cur: RTCPeerConnection, stale: () => boolean): void => {
    stopStats();
    if (typeof cur.getStats !== 'function') return;
    const watch: DecodeWatch = createDecodeWatch();
    statsTimer = setInterval(() => {
      if (stale() || stuckReported) return;
      try {
        void Promise.resolve(cur.getStats())
          .then((report) => {
            if (stale() || stuckReported) return;
            let videoBytes: number | null = null;
            let framesDecoded: number | null = null;
            report.forEach((entry: Record<string, unknown>) => {
              const kind = entry.kind ?? entry.mediaType;
              if (entry.type !== 'inbound-rtp' || kind !== 'video') return;
              if (typeof entry.bytesReceived === 'number') videoBytes = entry.bytesReceived;
              if (typeof entry.framesDecoded === 'number') framesDecoded = entry.framesDecoded;
            });
            if (watch.feed({ atMs: Date.now(), videoBytes, framesDecoded })) stuck();
          })
          .catch(() => undefined);
      } catch {
        /* a stats failure never matters to playback */
      }
    }, STATS_EVERY_MS);
  };

  const stopStream = (src: MediaStream | null): void => {
    try {
      for (const t of src?.getTracks?.() ?? []) t.stop();
    } catch {
      /* already gone */
    }
  };

  const stopTracks = (): void => {
    stopStream(video.srcObject as MediaStream | null);
    video.srcObject = null;
  };

  const sendDelete = (where: string | null, keepalive = false): void => {
    if (where === null) return;
    void fetchImpl(where, { method: 'DELETE', credentials: 'same-origin', ...(keepalive ? { keepalive: true } : {}) }).catch(() => undefined);
  };

  /**
   * The page is going away (reload, navigation, the browser closing): free the box's row at once; `keepalive` lets the
   * request outlive the page. A page that goes into the browser's back-forward cache (`persisted`) may come back, so its
   * row is left alone here (the box forgets a quiet row by itself) and `onPageShow` reconnects when it does.
   */
  const onPageHide = (ev?: Event): void => {
    if (closed) return;
    if ((ev as PageTransitionEvent | undefined)?.persisted === true) return;
    sendDelete(loc, true);
  };
  /** Back from the back-forward cache: the old connection is dead, so the player starts a clean one at once. */
  const onPageShow = (ev?: Event): void => {
    if (closed || (ev as PageTransitionEvent | undefined)?.persisted !== true) return;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    delay = BACKOFF_START_MS;
    teardown(true);
    state('retrying');
    void connect();
  };
  const pageTarget: Window | null = typeof window !== 'undefined' ? window : null;
  pageTarget?.addEventListener('pagehide', onPageHide);
  pageTarget?.addEventListener('pageshow', onPageShow);

  /**
   * Tears down the current connection (and its box session); keeps the session object usable. With `keepPicture` the
   * ended stream stays on the element so its last frame stays on screen while the player retries (D4).
   */
  const teardown = (keepPicture = false): void => {
    if (graceTimer !== null) clearTimeout(graceTimer);
    graceTimer = null;
    stopStats();
    stopAlive();
    const cur = pc;
    pc = null;
    if (cur) {
      cur.onconnectionstatechange = null;
      cur.ontrack = null;
      try {
        cur.close();
      } catch {
        /* closed */
      }
    }
    if (!keepPicture) stopTracks();
    const where = loc;
    loc = null;
    sendDelete(where);
  };

  const scheduleRetry = (): void => {
    if (closed) return;
    teardown(true);
    state('retrying');
    const wait = delay;
    delay = Math.min(delay * 2, BACKOFF_MAX_MS);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, wait);
  };

  const waitForGathering = (cur: RTCPeerConnection): Promise<void> =>
    new Promise((resolve) => {
      if (cur.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      const done = (): void => {
        if (cur.iceGatheringState !== 'complete') return;
        clearTimeout(cap);
        cur.removeEventListener('icegatheringstatechange', done);
        resolve();
      };
      const cap = setTimeout(() => {
        cur.removeEventListener('icegatheringstatechange', done);
        resolve();
      }, GATHER_CAP_MS);
      cur.addEventListener('icegatheringstatechange', done);
    });

  const play = (): void => {
    let p: Promise<void> | undefined;
    try {
      p = video.play();
    } catch {
      return;
    }
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        if (closed || video.muted) return;
        // autoplay with sound refused: play muted rather than show a frozen frame
        video.muted = true;
        void video.play()?.catch?.(() => undefined);
      });
    }
  };

  const connect = async (): Promise<void> => {
    if (closed) return;
    const mine = ++attempt;
    if (typeof PC !== 'function') {
      state('unsupported');
      return;
    }
    state('connecting');
    let cur: RTCPeerConnection;
    try {
      cur = new PC({ iceServers: [] });
    } catch {
      state('unsupported');
      return;
    }
    pc = cur;
    const stale = (): boolean => closed || mine !== attempt || pc !== cur;
    // the stream this connection put on the element (a held one belongs to an earlier connection)
    let own: MediaStream | null = null;
    video.muted = !opts.audio;
    video.volume = volume;
    video.playsInline = true;
    video.autoplay = true;
    cur.ontrack = (ev: RTCTrackEvent) => {
      if (stale()) return;
      const stream = ev.streams?.[0] ?? null;
      if (stream && video.srcObject !== stream) {
        // the picture held from the connection before this one is let go now
        stopStream(video.srcObject as MediaStream | null);
        video.srcObject = stream;
        own = stream;
        play();
      } else if (!stream && typeof MediaStream === 'function') {
        // tracks without a stream: gathered into one stream of this connection (never added to a held, ended one)
        const s = own ?? new MediaStream();
        s.addTrack(ev.track);
        if (video.srcObject !== s) {
          stopStream(video.srcObject as MediaStream | null);
          video.srcObject = s;
          own = s;
          play();
        }
      }
    };
    cur.onconnectionstatechange = () => {
      if (stale()) return;
      const c = cur.connectionState;
      if (c === 'connected') {
        if (graceTimer !== null) clearTimeout(graceTimer);
        graceTimer = null;
        delay = BACKOFF_START_MS;
        state('playing');
        if (statsTimer === null) startStats(cur, stale);
        if (aliveTimer === null) startAlive(stale);
      } else if (c === 'failed' || c === 'closed') {
        scheduleRetry();
      } else if (c === 'disconnected') {
        if (graceTimer !== null) return;
        graceTimer = setTimeout(() => {
          graceTimer = null;
          if (!stale() && cur.connectionState !== 'connected') scheduleRetry();
        }, DISCONNECT_GRACE_MS);
      }
    };
    try {
      cur.addTransceiver('video', { direction: 'recvonly' });
      cur.addTransceiver('audio', { direction: 'recvonly' });
      const offer = await cur.createOffer();
      await cur.setLocalDescription(offer);
      await waitForGathering(cur);
      if (stale()) return;
      const sdp = cur.localDescription?.sdp ?? offer.sdp ?? '';
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetchImpl(whepPostUrl(opts.maxHeight), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/sdp' },
          body: sdp,
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 404) throw new NoStream();
      if (res.status === 429) throw new TooMany();
      if (res.status !== 201 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const where = res.headers.get('Location');
      const answer = await res.text();
      if (stale()) {
        // closed while the POST was in flight: free the box's session at once
        sendDelete(where !== null && LOCATION_RE.test(where) ? where : null);
        return;
      }
      loc = where !== null && LOCATION_RE.test(where) ? where : null;
      await cur.setRemoteDescription({ type: 'answer', sdp: answer });
    } catch (e) {
      if (stale()) return;
      if (e instanceof NoStream) {
        // no publisher yet (the box may still say live while the ingest comes back): show the state, keep trying
        teardown(true);
        state('nostream');
      } else if (e instanceof TooMany) {
        // K4: every viewer slot of the box is taken; say so and ask again at the slow pace
        teardown(true);
        state('toomany');
        delay = BACKOFF_MAX_MS;
      }
      scheduleRetry();
    }
  };

  void connect();

  return {
    location: () => loc,
    async close() {
      if (closed) return;
      closed = true;
      pageTarget?.removeEventListener('pagehide', onPageHide);
      pageTarget?.removeEventListener('pageshow', onPageShow);
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      teardown();
      state('closed');
    },
  };
}
