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
});
