import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { act, cleanup, render } from '@testing-library/preact';
import { resolveSettings } from '@surau/core';
import type { KioskLive, Settings } from '@surau/core';
import { resetSharedStream, subscribe } from '../src/data/bundle.ts';
import { parseKioskLive, useLive } from '../src/data/live.ts';
import type { LiveView } from '../src/data/live.ts';

class FakeES {
  static instances: FakeES[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(url: string) {
    this.url = url;
    FakeES.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: string) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data } as MessageEvent);
  }
}
const ES = FakeES as unknown as typeof EventSource;

const LIVE_ON: KioskLive = {
  live: true,
  since: '2026-11-05T19:40:00.000Z',
  kuliah: { label: 'Kuliah Maghrib', penceramah: 'Ustaz Ahmad Fauzi', topic: 'Bab Ikhlas dan Niat' },
  audio: false,
  volume: 50,
};
const LIVE_OFF: KioskLive = { live: false, since: null, kuliah: null, audio: false, volume: 50 };

const on = (): Settings => resolveSettings({ liveOnKiosk: { enabled: true } } as Parameters<typeof resolveSettings>[0]);
const off = (): Settings => resolveSettings({ liveOnKiosk: { enabled: false } } as Parameters<typeof resolveSettings>[0]);

function jsonFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

let seen: LiveView | null = null;
function Probe(props: { settings: Settings; fetchImpl: typeof fetch }) {
  seen = useLive(props.settings, { fetchImpl: props.fetchImpl, EventSourceImpl: ES });
  return null;
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  FakeES.instances = [];
  resetSharedStream();
  seen = null;
});
afterEach(() => {
  cleanup();
  resetSharedStream();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('parseKioskLive', () => {
  it('keeps a known path and drops an unknown one', () => {
    expect(parseKioskLive({ ...LIVE_ON, path: 'surau-kiosk' })).toMatchObject({ path: 'surau-kiosk' });
    expect(parseKioskLive({ ...LIVE_ON, path: '../x' })).not.toHaveProperty('path');
  });
  it('accepts the box shape', () => {
    expect(parseKioskLive(LIVE_ON)).toEqual(LIVE_ON);
    expect(parseKioskLive(LIVE_OFF)).toEqual(LIVE_OFF);
  });
  it('rejects malformed payloads', () => {
    expect(parseKioskLive(null)).toBeNull();
    expect(parseKioskLive('live')).toBeNull();
    expect(parseKioskLive({ live: 'yes' })).toBeNull();
    expect(parseKioskLive({ ...LIVE_ON, kuliah: { label: 3 } })).toBeNull();
  });
  it('clamps the volume and drops a non-string topic', () => {
    expect(parseKioskLive({ ...LIVE_ON, volume: 400 })?.volume).toBe(100);
    expect(parseKioskLive({ ...LIVE_ON, volume: -5 })?.volume).toBe(0);
    expect(parseKioskLive({ ...LIVE_ON, kuliah: { label: 'K', penceramah: 'P', topic: 5 } })?.kuliah?.topic).toBeNull();
  });
});

describe('useLive', () => {
  it('reads GET /api/kiosk/live, then follows `live` events on the shared stream', async () => {
    const f = jsonFetch(LIVE_OFF);
    render(h(Probe, { settings: on(), fetchImpl: f as unknown as typeof fetch }));
    await flush();
    expect(f).toHaveBeenCalledWith('/api/kiosk/live', expect.objectContaining({ credentials: 'same-origin' }));
    expect(seen?.live).toBe(false);
    expect(FakeES.instances.length).toBe(1);
    act(() => FakeES.instances[0]!.emit('live', JSON.stringify(LIVE_ON)));
    expect(seen?.live).toBe(true);
    expect(seen?.playable).toBe(true);
    expect(seen?.kuliah?.penceramah).toBe('Ustaz Ahmad Fauzi');
    act(() => FakeES.instances[0]!.emit('live', JSON.stringify(LIVE_OFF)));
    expect(seen?.live).toBe(false);
  });

  it('shares one stream with the bundle subscriber', async () => {
    const unsub = subscribe(() => {}, { EventSourceImpl: ES });
    const r = render(h(Probe, { settings: on(), fetchImpl: jsonFetch(LIVE_OFF) as unknown as typeof fetch }));
    await flush();
    expect(FakeES.instances.length).toBe(1);
    act(() => FakeES.instances[0]!.emit('live', JSON.stringify(LIVE_ON)));
    expect(seen?.live).toBe(true);
    r.unmount();
    // Preact runs effect cleanups of an unmounted tree after the commit, not inside unmount()
    await act(async () => {
      await new Promise((res) => setTimeout(res, 50));
    });
    expect(FakeES.instances[0]!.closed).toBe(false);
    unsub();
    expect(FakeES.instances[0]!.closed).toBe(true);
  });

  it('an event that arrived first is not overwritten by a late GET answer', async () => {
    let resolveGet: (r: Response) => void = () => {};
    const f = vi.fn(() => new Promise<Response>((r) => (resolveGet = r)));
    render(h(Probe, { settings: on(), fetchImpl: f as unknown as typeof fetch }));
    act(() => FakeES.instances[0]!.emit('live', JSON.stringify(LIVE_ON)));
    resolveGet(new Response(JSON.stringify(LIVE_OFF), { status: 200 }));
    await flush();
    expect(seen?.live).toBe(true);
  });

  it('with liveOnKiosk off it ignores events and never fetches', async () => {
    const f = jsonFetch(LIVE_ON);
    render(h(Probe, { settings: off(), fetchImpl: f as unknown as typeof fetch }));
    await flush();
    expect(f).not.toHaveBeenCalled();
    for (const es of FakeES.instances) es.emit('live', JSON.stringify(LIVE_ON));
    expect(seen?.live).toBe(false);
  });

  it('ignores a malformed event payload', async () => {
    render(h(Probe, { settings: on(), fetchImpl: jsonFetch(LIVE_ON) as unknown as typeof fetch }));
    await flush();
    expect(seen?.live).toBe(true);
    act(() => {
      FakeES.instances[0]!.emit('live', '{not json');
      FakeES.instances[0]!.emit('live', JSON.stringify({ live: 'maybe' }));
      FakeES.instances[0]!.emit('live', 'null');
    });
    expect(seen?.live).toBe(true);
  });

  it('a 503 from GET /api/kiosk/live leaves live false with no throw', async () => {
    const f = jsonFetch({ errors: ['x'] }, 503);
    render(h(Probe, { settings: on(), fetchImpl: f as unknown as typeof fetch }));
    await flush();
    expect(seen?.live).toBe(false);
    expect(seen?.playable).toBe(true);
  });

  it('a fetch that rejects leaves live false with no throw', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('network');
    });
    render(h(Probe, { settings: on(), fetchImpl: f as unknown as typeof fetch }));
    await flush();
    expect(seen?.live).toBe(false);
  });

  it('preview: never opens the stream, polls the GET every 30 s and is never playable', async () => {
    vi.useFakeTimers();
    try {
      window.history.replaceState(null, '', '/?preview=1');
      const f = jsonFetch(LIVE_ON);
      render(h(Probe, { settings: on(), fetchImpl: f as unknown as typeof fetch }));
      await flush();
      expect(FakeES.instances.length).toBe(0);
      expect(seen?.live).toBe(true);
      expect(seen?.playable).toBe(false);
      expect(f).toHaveBeenCalledTimes(1);
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      await flush();
      expect(f).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
