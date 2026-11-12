import { kioskFetch } from './preview.ts';

/**
 * WHEP player for the kiosk (Plan 5 Task 6): one receive-only RTCPeerConnection against the box's own
 * `/api/kiosk/live/whep` proxy (same origin, the kiosk's cookie or loopback). No trickle ICE: gathering runs
 * to completion (2 s cap, the LAN is fast) before the single POST. A failed connection is closed and retried
 * with backoff 1, 2, 4 ... 15 s until `close()`; a 404 (no publisher, `tiada siaran`) is reported as
 * `nostream` and then retried the same way: it is never a permanent stop while the caller wants playback.
 *
 * Edge on the box autoplays muted video. With audio on, the kiosk page has already been activated by its own
 * audio handling (Plan 2 beeps); if play() is still refused, the video falls back to muted so it never stalls.
 */

export type WhepState = 'connecting' | 'playing' | 'retrying' | 'nostream' | 'unsupported' | 'closed';

export interface WhepOpts {
  audio: boolean;
  /** 0 to 100. */
  volume: number;
  onState?: (s: WhepState) => void;
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
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 15000;

class NoStream extends Error {}

export function openWhep(video: HTMLVideoElement, opts: WhepOpts): WhepSession {
  const fetchImpl = opts.fetchImpl ?? kioskFetch;
  const PC = opts.RTCPeerConnectionImpl ?? (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection;
  const volume = Math.min(1, Math.max(0, (Number.isFinite(opts.volume) ? opts.volume : 50) / 100));
  let closed = false;
  let pc: RTCPeerConnection | null = null;
  let loc: string | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let delay = BACKOFF_START_MS;
  let attempt = 0;

  const state = (s: WhepState): void => {
    try {
      opts.onState?.(s);
    } catch {
      /* the caller's problem, never the player's */
    }
  };

  const stopTracks = (): void => {
    const src = video.srcObject as MediaStream | null;
    try {
      for (const t of src?.getTracks?.() ?? []) t.stop();
    } catch {
      /* already gone */
    }
    video.srcObject = null;
  };

  const sendDelete = (where: string | null): void => {
    if (where === null) return;
    void fetchImpl(where, { method: 'DELETE', credentials: 'same-origin' }).catch(() => undefined);
  };

  /** Tears down the current connection (and its box session); keeps the session object usable. */
  const teardown = (): void => {
    if (graceTimer !== null) clearTimeout(graceTimer);
    graceTimer = null;
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
    stopTracks();
    const where = loc;
    loc = null;
    sendDelete(where);
  };

  const scheduleRetry = (): void => {
    if (closed) return;
    teardown();
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
    video.muted = !opts.audio;
    video.volume = volume;
    video.playsInline = true;
    video.autoplay = true;
    cur.ontrack = (ev: RTCTrackEvent) => {
      if (stale()) return;
      const stream = ev.streams?.[0] ?? null;
      if (stream && video.srcObject !== stream) {
        video.srcObject = stream;
        play();
      } else if (!stream && typeof MediaStream === 'function') {
        const s = (video.srcObject as MediaStream | null) ?? new MediaStream();
        s.addTrack(ev.track);
        if (video.srcObject !== s) {
          video.srcObject = s;
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
        res = await fetchImpl(WHEP_URL, {
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
        teardown();
        state('nostream');
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
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      teardown();
      state('closed');
    },
  };
}
