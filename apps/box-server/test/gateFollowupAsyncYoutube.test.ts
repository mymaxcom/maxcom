import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveStatus } from '@surau/core';
import type { YoutubeLeg } from '../src/live/sessions.ts';
import { loginAs } from './authHelpers.ts';
import { startBody, startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';

/** Plan 6: the YouTube broadcast is created after the start answer; a sleeping cloud never delays the phone or the kiosk. */

const harnesses: LiveHarness[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const h of harnesses.splice(0)) await h.close();
});

const KEY = 'abcd-efgh-ijkl-mnop-qrst';
type Made = { broadcastId: string; watchUrl: string; key: string };

/** A YouTube leg whose broadcast takes as long as the test says (a fake 20 s on a fake clock, or a held promise). */
function slowYoutube(): YoutubeLeg & { completed: string[]; calls: number; resolve: (m?: Made) => void; reject: (e: unknown) => void } {
  let res!: (m: Made) => void;
  let rej!: (e: unknown) => void;
  const o = {
    completed: [] as string[],
    calls: 0,
    resolve: (m: Made = { broadcastId: 'bc-late', watchUrl: 'https://youtu.be/bc-late', key: KEY }) => res(m),
    reject: (e: unknown) => rej(e),
  };
  const leg: YoutubeLeg = {
    signedIn: () => true,
    createBroadcastFor: () => {
      o.calls++;
      return new Promise<Made>((a, b) => {
        res = a;
        rej = b;
      });
    },
    complete: async (id) => {
      o.completed.push(id);
    },
    status: (): LiveStatus['youtube'] => ({ signedIn: true, channelTitle: 'Surau', broadcastId: null, state: 'none', health: null, watchUrl: null, lastError: null }),
  };
  return Object.assign(o, leg);
}

async function begin(yt: YoutubeLeg, via: 'box' | 'device' = 'box') {
  const h = await startLiveHarness({ live: { monitorMs: 3_600_000, youtube: yt } });
  harnesses.push(h);
  const media = await loginAs(h.app, 'media');
  const t0 = Date.now();
  const r = await h.app.inject({
    method: 'POST',
    url: '/api/live/start',
    headers: media.headers,
    payload: startBody(h, { source: via === 'box' ? 'web' : 'android', outputs: { kiosk: true, youtube: true }, youtubeVia: via }),
    remoteAddress: '10.168.1.40',
  });
  return { h, media, r, took: Date.now() - t0 };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

describe('start does not wait for YouTube', () => {
  it('answers at once with the YouTube leg pending while the broadcast takes 20 s; the kiosk is live', async () => {
    const yt = slowYoutube();
    const { h, r, took } = await begin(yt);
    expect(r.statusCode).toBe(200);
    expect(took).toBeLessThan(2000);
    const body = r.json();
    expect(body.youtube).toEqual({ via: 'box', ingest: null, key: null, state: 'starting' });
    expect(body.warnings).toBeUndefined();
    expect(body.ingest.whip).toBe('/api/live/whip');
    expect(body.kiosk).toBeDefined();
    expect(h.app.liveSessions!.status().relay.state).toBe('off');
    expect(yt.calls).toBe(1);
  });

  it('the no-video watchdog still runs from the answer, with the broadcast still pending', async () => {
    const yt = slowYoutube();
    const { h } = await begin(yt);
    const s = h.app.liveSessions!;
    h.clock.t += 13_000;
    await s.tick();
    expect(s.status().warnings).toContain('no_video_from_device');
  });

  it('the YouTube relay starts after the broadcast resolves', async () => {
    const yt = slowYoutube();
    const { h } = await begin(yt);
    const s = h.app.liveSessions!;
    expect(s.relayKey()).toBeNull();
    yt.resolve();
    await flush();
    expect(s.relayKey()).toBe(KEY);
    expect(s.status().relay.state).not.toBe('off');
    expect(s.status().warnings).toEqual([]);
    await s.stop(undefined, 'test');
    await s.settled();
    expect(yt.completed).toEqual(['bc-late']);
  });

  it('a failure sets the warning visible in /api/live/status', async () => {
    const yt = slowYoutube();
    const { h, media } = await begin(yt);
    yt.reject(Object.assign(new Error('x'), { reason: 'cloud_unreachable' }));
    await flush();
    const st = await h.app.inject({ method: 'GET', url: '/api/live/status', headers: media.headers, remoteAddress: '10.168.1.40' });
    expect(st.json().warnings).toContain('cloud_unreachable');
    expect(h.app.liveSessions!.relayKey()).toBeNull();
    expect(h.app.liveSessions!.current()).not.toBeNull();
  });

  it('a plain network failure shows no_internet', async () => {
    const yt = slowYoutube();
    const { h } = await begin(yt);
    yt.reject(new Error('ENOTFOUND'));
    await flush();
    expect(h.app.liveSessions!.status().warnings).toContain('no_internet');
  });

  it('stop while pending completes the late broadcast exactly once and starts no relay', async () => {
    const yt = slowYoutube();
    const { h } = await begin(yt);
    const s = h.app.liveSessions!;
    await s.stop(undefined, 'test');
    await s.settled();
    expect(yt.completed).toEqual([]);
    yt.resolve();
    await flush();
    await s.settled();
    expect(yt.completed).toEqual(['bc-late']);
    expect(s.status().relay.state).toBe('off');
    expect(s.current()).toBeNull();
  });

  it('stop while pending, then the broadcast fails: nothing to complete', async () => {
    const yt = slowYoutube();
    const { h } = await begin(yt);
    const s = h.app.liveSessions!;
    await s.stop(undefined, 'test');
    yt.reject(new Error('ENOTFOUND'));
    await flush();
    await s.settled();
    expect(yt.completed).toEqual([]);
  });

  it('a late broadcast never touches the next session', async () => {
    const yt = slowYoutube();
    const { h } = await begin(yt);
    const s = h.app.liveSessions!;
    await s.stop(undefined, 'test');
    await s.settled();
    yt.resolve();
    await flush();
    await s.settled();
    expect(yt.completed).toEqual(['bc-late']);
    expect(s.relayKey()).toBeNull();
  });
});

describe('the phone own YouTube leg gets the key after the answer', () => {
  it('starting, then ready for the owner only; never in the status', async () => {
    const yt = slowYoutube();
    const { h, media, r } = await begin(yt, 'device');
    expect(r.json().youtube).toEqual({ via: 'device', ingest: null, key: null, state: 'starting' });
    const get = (headers: Record<string, string>) =>
      h.app.inject({ method: 'GET', url: '/api/live/youtube/ingest', headers, remoteAddress: '10.168.1.40' });
    expect((await get(media.headers)).json()).toEqual({ state: 'starting', ingest: null, key: null });
    yt.resolve();
    await flush();
    expect((await get(media.headers)).json()).toEqual({ state: 'ready', ingest: 'rtmps://a.rtmps.youtube.com:443/live2', key: KEY });
    const other = await loginAs(h.app, 'media');
    expect((await get(other.headers)).statusCode).toBe(403);
    const st = await h.app.inject({ method: 'GET', url: '/api/live/status', headers: media.headers, remoteAddress: '10.168.1.40' });
    expect(st.body).not.toContain(KEY);
  });

  it('failed reports failed with the warning in the status', async () => {
    const yt = slowYoutube();
    const { h, media } = await begin(yt, 'device');
    yt.reject(new Error('ENOTFOUND'));
    await flush();
    const g = await h.app.inject({ method: 'GET', url: '/api/live/youtube/ingest', headers: media.headers, remoteAddress: '10.168.1.40' });
    expect(g.json()).toEqual({ state: 'failed', ingest: null, key: null });
    expect(h.app.liveSessions!.status().warnings).toContain('no_internet');
  });
});
