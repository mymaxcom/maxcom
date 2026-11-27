import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openWhep } from '../src/data/whep.ts';
import type { WhepState } from '../src/data/whep.ts';

// Note: Edge on the box autoplays muted video. With `audio: true` the page has already been activated by the
// kiosk's own audio handling (Plan 2 beeps); if play() is still refused the client falls back to muted.

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}
class FakeStream {
  tracks = [new FakeTrack(), new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
}

class FakePC {
  static instances: FakePC[] = [];
  config: unknown;
  transceivers: { kind: string; init: unknown }[] = [];
  iceGatheringState: RTCIceGatheringState = 'new';
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remote: { type: string; sdp: string } | null = null;
  closed = false;
  ontrack: ((ev: { track: unknown; streams: unknown[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  private listeners = new Map<string, (() => void)[]>();
  constructor(config: unknown) {
    this.config = config;
    FakePC.instances.push(this);
  }
  addTransceiver(kind: string, init: unknown) {
    this.transceivers.push({ kind, init });
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0 offer' };
  }
  async setLocalDescription(d: { type: string; sdp: string }) {
    this.localDescription = { type: d.type, sdp: `${d.sdp} with-candidates` };
    this.iceGatheringState = 'gathering';
    queueMicrotask(() => {
      this.iceGatheringState = 'complete';
      for (const fn of this.listeners.get('icegatheringstatechange') ?? []) fn();
    });
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remote = d;
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  close() {
    this.closed = true;
  }
  setConnection(s: RTCPeerConnectionState) {
    this.connectionState = s;
    this.onconnectionstatechange?.();
  }
  fireTrack(stream: FakeStream) {
    this.ontrack?.({ track: stream.tracks[0], streams: [stream] });
  }
}

interface Call {
  url: string;
  init: RequestInit;
}

function whepFetch(answer: () => Response) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    return answer();
  });
  return { fn: fn as unknown as typeof fetch, calls };
}
const created = () =>
  new Response('v=0 answer', { status: 201, headers: { 'Content-Type': 'application/sdp', Location: '/api/kiosk/live/whep/abc123' } });

function fakeVideo() {
  const v = document.createElement('video');
  const play = vi.fn(async () => {});
  Object.defineProperty(v, 'play', { value: play });
  return { v, play };
}

const PC = FakePC as unknown as typeof RTCPeerConnection;
const tick = async (n = 8) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  FakePC.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('openWhep', () => {
  it('posts the offer as application/sdp with same-origin credentials, applies the answer and keeps Location', async () => {
    const { fn, calls } = whepFetch(created);
    const { v } = fakeVideo();
    const states: WhepState[] = [];
    const s = openWhep(v, { audio: false, volume: 50, fetchImpl: fn, RTCPeerConnectionImpl: PC, onState: (x) => states.push(x) });
    await tick();
    const pc = FakePC.instances[0]!;
    expect(pc.config).toEqual({ iceServers: [] });
    expect(pc.transceivers.map((t) => t.kind)).toEqual(['video', 'audio']);
    expect(pc.transceivers.every((t) => (t.init as { direction: string }).direction === 'recvonly')).toBe(true);
    expect(calls[0]!.url).toBe('/api/kiosk/live/whep');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.credentials).toBe('same-origin');
    expect(new Headers(calls[0]!.init.headers).get('Content-Type')).toBe('application/sdp');
    expect(calls[0]!.init.body).toBe('v=0 offer with-candidates');
    expect(pc.remote).toEqual({ type: 'answer', sdp: 'v=0 answer' });
    expect(s.location()).toBe('/api/kiosk/live/whep/abc123');
    pc.fireTrack(new FakeStream());
    expect(v.srcObject).toBeTruthy();
    expect(v.muted).toBe(true);
    expect(v.volume).toBeCloseTo(0.5);
    expect(v.autoplay).toBe(true);
    expect(v.playsInline).toBe(true);
    expect(states).toContain('connecting');
    await s.close();
  });

  it('O31: a low-memory display asks the box for a lower live height on the offer; others ask for nothing', async () => {
    const low = whepFetch(created);
    const a = openWhep(fakeVideo().v, { audio: false, volume: 50, maxHeight: 720, fetchImpl: low.fn, RTCPeerConnectionImpl: PC });
    await tick();
    expect(low.calls[0]!.url).toBe('/api/kiosk/live/whep?maxHeight=720');
    await a.close();
    const normal = whepFetch(created);
    const b = openWhep(fakeVideo().v, { audio: false, volume: 50, maxHeight: undefined, fetchImpl: normal.fn, RTCPeerConnectionImpl: PC });
    await tick();
    expect(normal.calls[0]!.url).toBe('/api/kiosk/live/whep');
    await b.close();
    // a bad value is never sent
    const bad = whepFetch(created);
    const c = openWhep(fakeVideo().v, { audio: false, volume: 50, maxHeight: Number.NaN, fetchImpl: bad.fn, RTCPeerConnectionImpl: PC });
    await tick();
    expect(bad.calls[0]!.url).toBe('/api/kiosk/live/whep');
    await c.close();
  });

  it('unmutes with audio on and applies the volume', async () => {
    const { fn } = whepFetch(created);
    const { v } = fakeVideo();
    const s = openWhep(v, { audio: true, volume: 80, fetchImpl: fn, RTCPeerConnectionImpl: PC });
    await tick();
    FakePC.instances[0]!.fireTrack(new FakeStream());
    expect(v.muted).toBe(false);
    expect(v.volume).toBeCloseTo(0.8);
    await s.close();
  });

  it('close() sends DELETE to the Location, stops the tracks and closes the connection', async () => {
    const { fn, calls } = whepFetch(created);
    const { v } = fakeVideo();
    const s = openWhep(v, { audio: false, volume: 50, fetchImpl: fn, RTCPeerConnectionImpl: PC });
    await tick();
    const stream = new FakeStream();
    FakePC.instances[0]!.fireTrack(stream);
    await s.close();
    const del = calls.find((c) => c.init.method === 'DELETE');
    expect(del?.url).toBe('/api/kiosk/live/whep/abc123');
    expect(del?.init.credentials).toBe('same-origin');
    expect(stream.tracks.every((t) => t.stopped)).toBe(true);
    expect(FakePC.instances[0]!.closed).toBe(true);
    expect(v.srcObject).toBeNull();
  });

  it('never sends DELETE to a Location outside the WHEP route', async () => {
    const { fn, calls } = whepFetch(
      () => new Response('v=0 answer', { status: 201, headers: { Location: 'https://evil.example/x' } }),
    );
    const { v } = fakeVideo();
    const s = openWhep(v, { audio: false, volume: 50, fetchImpl: fn, RTCPeerConnectionImpl: PC });
    await tick();
    await s.close();
    expect(calls.filter((c) => c.init.method === 'DELETE')).toEqual([]);
  });

  it('a failed connection retries after 1 s, then after 2 s', async () => {
    const { fn, calls } = whepFetch(created);
    const { v } = fakeVideo();
    const states: WhepState[] = [];
    const s = openWhep(v, { audio: false, volume: 50, fetchImpl: fn, RTCPeerConnectionImpl: PC, onState: (x) => states.push(x) });
    await tick();
    FakePC.instances[0]!.setConnection('failed');
    expect(FakePC.instances[0]!.closed).toBe(true);
    expect(states).toContain('retrying');
    await vi.advanceTimersByTimeAsync(999);
    expect(FakePC.instances.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await tick();
    expect(FakePC.instances.length).toBe(2);
    FakePC.instances[1]!.setConnection('failed');
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakePC.instances.length).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await tick();
    expect(FakePC.instances.length).toBe(3);
    expect(calls.filter((c) => c.init.method === 'POST').length).toBe(3);
    await s.close();
  });

  it('disconnected for 3 s counts as failed; a recovery inside 3 s does not', async () => {
    const { fn } = whepFetch(created);
    const { v } = fakeVideo();
    const s = openWhep(v, { audio: false, volume: 50, fetchImpl: fn, RTCPeerConnectionImpl: PC });
    await tick();
    const pc = FakePC.instances[0]!;
    pc.setConnection('disconnected');
    await vi.advanceTimersByTimeAsync(2000);
    pc.setConnection('connected');
    await vi.advanceTimersByTimeAsync(5000);
    expect(pc.closed).toBe(false);
    pc.setConnection('disconnected');
    await vi.advanceTimersByTimeAsync(3000);
    expect(pc.closed).toBe(true);
    await s.close();
  });

  it('the backoff is capped at 15 s and a 503 retries too', async () => {
    const { fn, calls } = whepFetch(() => new Response('{"errors":["x"]}', { status: 503 }));
    const { v } = fakeVideo();
    const s = openWhep(v, { audio: false, volume: 50, fetchImpl: fn, RTCPeerConnectionImpl: PC });
    await tick();
    // 1, 2, 4, 8, 15, 15
    for (const d of [1000, 2000, 4000, 8000, 15000, 15000]) {
      await vi.advanceTimersByTimeAsync(d);
      await tick();
    }
    expect(calls.filter((c) => c.init.method === 'POST').length).toBe(7);
    await s.close();
  });

  it('a 404 (tiada siaran) is reported and retried with the same backoff, then plays', async () => {
    let n = 0;
    const { fn, calls } = whepFetch(() =>
      ++n <= 2 ? new Response('{"errors":["tiada siaran"]}', { status: 404 }) : created(),
    );
    const { v } = fakeVideo();
    const states: WhepState[] = [];
    const s = openWhep(v, { audio: false, volume: 50, fetchImpl: fn, RTCPeerConnectionImpl: PC, onState: (x) => states.push(x) });
    await tick();
    expect(states).toContain('nostream');
    expect(states.at(-1)).toBe('retrying');
    expect(FakePC.instances[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    await tick();
    expect(calls.filter((c) => c.init.method === 'POST').length).toBe(2);
    await vi.advanceTimersByTimeAsync(1999);
    await tick();
    expect(calls.filter((c) => c.init.method === 'POST').length).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await tick();
    expect(calls.filter((c) => c.init.method === 'POST').length).toBe(3);
    FakePC.instances.at(-1)!.setConnection('connected');
    expect(states.at(-1)).toBe('playing');
    await s.close();
  });

  it('close() during a pending retry stops it', async () => {
    const { fn, calls } = whepFetch(created);
    const { v } = fakeVideo();
    const s = openWhep(v, { audio: false, volume: 50, fetchImpl: fn, RTCPeerConnectionImpl: PC });
    await tick();
    FakePC.instances[0]!.setConnection('failed');
    await s.close();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.filter((c) => c.init.method === 'POST').length).toBe(1);
  });

  it('without RTCPeerConnection it reports failure and never throws', async () => {
    const { fn } = whepFetch(created);
    const { v } = fakeVideo();
    const states: WhepState[] = [];
    const s = openWhep(v, { audio: false, volume: 50, fetchImpl: fn, RTCPeerConnectionImpl: undefined as unknown as typeof RTCPeerConnection, onState: (x) => states.push(x) });
    await tick();
    expect(states.at(-1)).toBe('unsupported');
    await s.close();
  });

  describe('decode watch', () => {
    function statsPC(framesDecoded: number | null, kindKey: 'kind' | 'mediaType' = 'kind') {
      let bytes = 0;
      const calls = { n: 0 };
      (FakePC.prototype as unknown as { getStats: unknown }).getStats = async () => {
        calls.n++;
        bytes += 100_000;
        const entries: Record<string, unknown>[] = [
          { type: 'inbound-rtp', [kindKey]: 'audio', bytesReceived: 5000 },
          { type: 'inbound-rtp', [kindKey]: 'video', bytesReceived: bytes, ...(framesDecoded === null ? {} : { framesDecoded }) },
        ];
        return { forEach: (fn: (e: Record<string, unknown>) => void) => entries.forEach(fn) };
      };
      return calls;
    }
    afterEach(() => {
      delete (FakePC.prototype as unknown as { getStats?: unknown }).getStats;
    });

    it('calls onDecodeStuck once when video bytes grow with no decoded frame, and stops sampling on close()', async () => {
      const calls = statsPC(0);
      const { fn } = whepFetch(created);
      const { v } = fakeVideo();
      const onDecodeStuck = vi.fn();
      const s = openWhep(v, { audio: false, volume: 50, fetchImpl: fn, RTCPeerConnectionImpl: PC, onDecodeStuck });
      await tick();
      const before = vi.getTimerCount();
      FakePC.instances[0]!.setConnection('connected');
      // the stats sampler, and the "still watching" timer every connected player has (K1)
      expect(vi.getTimerCount()).toBe(before + 2);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(onDecodeStuck).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(onDecodeStuck).toHaveBeenCalledTimes(1);
      expect(FakePC.instances[0]!.closed).toBe(false);
      expect(FakePC.instances.length).toBe(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onDecodeStuck).toHaveBeenCalledTimes(1);
      await s.close();
      const n = calls.n;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls.n).toBe(n);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('works with the legacy mediaType key', async () => {
      statsPC(0, 'mediaType');
      const { fn } = whepFetch(created);
      const { v } = fakeVideo();
      const onDecodeStuck = vi.fn();
      const s = openWhep(v, { audio: false, volume: 50, fetchImpl: fn, RTCPeerConnectionImpl: PC, onDecodeStuck });
      await tick();
      FakePC.instances[0]!.setConnection('connected');
      await vi.advanceTimersByTimeAsync(40_000);
      expect(onDecodeStuck).toHaveBeenCalledTimes(1);
      await s.close();
    });

    it('does not call onDecodeStuck when frames decode, or when framesDecoded is missing', async () => {
      for (const frames of [12, null]) {
        statsPC(frames);
        const { fn } = whepFetch(created);
        const { v } = fakeVideo();
        const onDecodeStuck = vi.fn();
        const s = openWhep(v, { audio: false, volume: 50, fetchImpl: fn, RTCPeerConnectionImpl: PC, onDecodeStuck });
        await tick();
        FakePC.instances.at(-1)!.setConnection('connected');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(onDecodeStuck).not.toHaveBeenCalled();
        await s.close();
      }
    });

    it('a getStats rejection on every sample never reports stuck and closes cleanly', async () => {
      let n = 0;
      (FakePC.prototype as unknown as { getStats: unknown }).getStats = async () => {
        n++;
        throw new Error('no stats');
      };
      const unhandled: unknown[] = [];
      const onUnhandled = (e: unknown): void => {
        unhandled.push(e);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        const { fn } = whepFetch(created);
        const { v } = fakeVideo();
        const onDecodeStuck = vi.fn();
        const s = openWhep(v, { audio: false, volume: 50, fetchImpl: fn, RTCPeerConnectionImpl: PC, onDecodeStuck });
        await tick();
        FakePC.instances[0]!.setConnection('connected');
        await vi.advanceTimersByTimeAsync(30_000);
        expect(n).toBeGreaterThan(0);
        expect(onDecodeStuck).not.toHaveBeenCalled();
        await s.close();
        expect(vi.getTimerCount()).toBe(0);
        await tick();
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('a throwing onDecodeStuck is contained: no teardown, no retry, no timers left after close()', async () => {
      statsPC(0);
      const { fn, calls } = whepFetch(created);
      const { v } = fakeVideo();
      const states: WhepState[] = [];
      const onDecodeStuck = vi.fn(() => {
        throw new Error('boom');
      });
      const s = openWhep(v, {
        audio: false,
        volume: 50,
        fetchImpl: fn,
        RTCPeerConnectionImpl: PC,
        onDecodeStuck,
        onState: (x) => states.push(x),
      });
      await tick();
      FakePC.instances[0]!.setConnection('connected');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onDecodeStuck).toHaveBeenCalledTimes(1);
      expect(FakePC.instances.length).toBe(1);
      expect(FakePC.instances[0]!.closed).toBe(false);
      expect(calls.filter((c) => c.init.method === 'POST' && !c.url.endsWith('/alive')).length).toBe(1);
      expect(states).not.toContain('retrying');
      expect(states.at(-1)).toBe('playing');
      await s.close();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('a fake without getStats means no sampling and no timer', async () => {
      const { fn } = whepFetch(created);
      const { v } = fakeVideo();
      const s = openWhep(v, { audio: false, volume: 50, fetchImpl: fn, RTCPeerConnectionImpl: PC, onDecodeStuck: vi.fn() });
      await tick();
      const before = vi.getTimerCount();
      FakePC.instances[0]!.setConnection('connected');
      // only the "still watching" timer (K1): no stats sampler
      expect(vi.getTimerCount()).toBe(before + 1);
      await s.close();
      expect(vi.getTimerCount()).toBe(before);
    });
  });
});

// 2026.11.15, Lane A tasks A6 and A7: the last picture survives a reconnect (D4), and a full box says so (K4).
describe('A6/A7: held picture across a retry (D4) and the 429 answer (K4)', () => {
  it('D4: a dropped connection keeps the last picture on the element while it retries; the new stream replaces it; close() clears it', async () => {
    const { fn } = whepFetch(created);
    const { v } = fakeVideo();
    const states: WhepState[] = [];
    const s = openWhep(v, { audio: false, volume: 50, fetchImpl: fn, RTCPeerConnectionImpl: PC, onState: (x) => states.push(x) });
    await tick();
    const first = new FakeStream();
    FakePC.instances[0]!.fireTrack(first);
    FakePC.instances[0]!.setConnection('connected');
    expect(v.srcObject).toBe(first);
    // the publisher went away: MediaMTX closed the viewer
    FakePC.instances[0]!.setConnection('failed');
    expect(states.at(-1)).toBe('retrying');
    expect(v.srcObject).toBe(first);
    expect(first.tracks.every((t) => !t.stopped)).toBe(true);
    // the retry connects: success path, the new stream takes over and the old one is let go
    await vi.advanceTimersByTimeAsync(1000);
    await tick();
    const second = new FakeStream();
    FakePC.instances[1]!.fireTrack(second);
    FakePC.instances[1]!.setConnection('connected');
    expect(v.srcObject).toBe(second);
    expect(first.tracks.every((t) => t.stopped)).toBe(true);
    expect(states.at(-1)).toBe('playing');
    await s.close();
    expect(v.srcObject).toBeNull();
    expect(second.tracks.every((t) => t.stopped)).toBe(true);
  });

  it('D4: a 404 while the picture is held (the ingest is still away) keeps holding it', async () => {
    let n = 0;
    const { fn } = whepFetch(() => (++n === 1 ? created() : new Response('{"errors":["tiada siaran"]}', { status: 404 })));
    const { v } = fakeVideo();
    const s = openWhep(v, { audio: false, volume: 50, fetchImpl: fn, RTCPeerConnectionImpl: PC });
    await tick();
    const first = new FakeStream();
    FakePC.instances[0]!.fireTrack(first);
    FakePC.instances[0]!.setConnection('connected');
    FakePC.instances[0]!.setConnection('failed');
    await vi.advanceTimersByTimeAsync(1000);
    await tick();
    expect(v.srcObject).toBe(first);
    await s.close();
  });

  it('K4: a 429 (every viewer slot taken) is reported as toomany and tried again 15 s later, then plays (success path)', async () => {
    let n = 0;
    const { fn, calls } = whepFetch(() => (++n === 1 ? new Response('{"code":"too_many_viewers"}', { status: 429 }) : created()));
    const { v } = fakeVideo();
    const states: WhepState[] = [];
    const s = openWhep(v, { audio: false, volume: 50, fetchImpl: fn, RTCPeerConnectionImpl: PC, onState: (x) => states.push(x) });
    await tick();
    expect(states).toContain('toomany');
    const posts = () => calls.filter((c) => c.init.method === 'POST').length;
    expect(posts()).toBe(1);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(posts()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_100);
    await tick();
    expect(posts()).toBe(2);
    FakePC.instances.at(-1)!.setConnection('connected');
    expect(states.at(-1)).toBe('playing');
    await s.close();
  });
});

describe('A7: the TV says it is still watching (K1)', () => {
  it('K1: while connected the player posts to its own viewer address 5 s after playing and then every 30 s, and stops when the connection ends or it is closed', async () => {
    const { fn, calls } = whepFetch(created);
    const { v } = fakeVideo();
    const s = openWhep(v, { audio: false, volume: 50, fetchImpl: fn, RTCPeerConnectionImpl: PC });
    await tick();
    const alive = () => calls.filter((c) => c.url === '/api/kiosk/live/whep/abc123/alive');
    // not before the picture is connected
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(alive()).toHaveLength(0);
    FakePC.instances[0]!.setConnection('connected');
    await vi.advanceTimersByTimeAsync(4_900);
    expect(alive()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(alive()).toHaveLength(1);
    expect(alive()[0]!.init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(alive()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(alive()).toHaveLength(12);
    await s.close();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(alive()).toHaveLength(12);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('K1: a connection that ends before the first alive never sends it', async () => {
    const { fn, calls } = whepFetch(created);
    const { v } = fakeVideo();
    const s = openWhep(v, { audio: false, volume: 50, fetchImpl: fn, RTCPeerConnectionImpl: PC });
    await tick();
    FakePC.instances[0]!.setConnection('connected');
    await vi.advanceTimersByTimeAsync(2_000);
    await s.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.filter((c) => c.url.endsWith('/alive'))).toHaveLength(0);
  });
});

describe('F6: the page leaving frees the viewer row', () => {
  const deletes = (calls: Call[]) => calls.filter((c) => c.init.method === 'DELETE');

  it('pagehide sends one DELETE of the current location with keepalive', async () => {
    const { fn, calls } = whepFetch(created);
    const { v } = fakeVideo();
    const s = openWhep(v, { audio: false, volume: 50, fetchImpl: fn, RTCPeerConnectionImpl: PC });
    await tick();
    FakePC.instances[0]!.setConnection('connected');
    expect(deletes(calls)).toHaveLength(0);
    window.dispatchEvent(new Event('pagehide'));
    expect(deletes(calls)).toHaveLength(1);
    expect(deletes(calls)[0]!.url).toBe('/api/kiosk/live/whep/abc123');
    expect(deletes(calls)[0]!.init).toMatchObject({ method: 'DELETE', credentials: 'same-origin', keepalive: true });
    await s.close();
  });

  it('no DELETE after close() on pagehide, and the listener is removed', async () => {
    const { fn, calls } = whepFetch(created);
    const { v } = fakeVideo();
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const s = openWhep(v, { audio: false, volume: 50, fetchImpl: fn, RTCPeerConnectionImpl: PC });
    await tick();
    FakePC.instances[0]!.setConnection('connected');
    const onHide = add.mock.calls.find((c) => c[0] === 'pagehide')![1];
    await s.close();
    // close() freed the row itself: one DELETE, without keepalive
    expect(deletes(calls)).toHaveLength(1);
    expect(deletes(calls)[0]!.init.keepalive).toBeUndefined();
    expect(remove.mock.calls.some((c) => c[0] === 'pagehide' && c[1] === onHide)).toBe(true);
    window.dispatchEvent(new Event('pagehide'));
    expect(deletes(calls)).toHaveLength(1);
    add.mockRestore();
    remove.mockRestore();
  });

  it('N2: pagehide into the back-forward cache (persisted) sends no DELETE; pageshow persisted reconnects with a new offer', async () => {
    const { fn, calls } = whepFetch(created);
    const { v } = fakeVideo();
    const s = openWhep(v, { audio: false, volume: 50, fetchImpl: fn, RTCPeerConnectionImpl: PC });
    await tick();
    FakePC.instances[0]!.setConnection('connected');
    const posts = (): number => calls.filter((c) => c.init.method === 'POST' && !c.url.endsWith('/alive')).length;
    expect(posts()).toBe(1);
    window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
    expect(deletes(calls)).toHaveLength(0);
    // a pageshow that is no return from the cache changes nothing
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
    await tick();
    expect(posts()).toBe(1);
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    await tick();
    expect(posts()).toBe(2);
    expect(FakePC.instances).toHaveLength(2);
    await s.close();
    // the listener is gone after close(): a later pageshow starts nothing
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    await tick();
    expect(posts()).toBe(2);
  });

  it('pagehide before the box answered sends nothing (there is no row yet)', async () => {
    const { fn, calls } = whepFetch(created);
    const { v } = fakeVideo();
    const s = openWhep(v, { audio: false, volume: 50, fetchImpl: fn, RTCPeerConnectionImpl: PC });
    window.dispatchEvent(new Event('pagehide'));
    expect(deletes(calls)).toHaveLength(0);
    await s.close();
  });
});
