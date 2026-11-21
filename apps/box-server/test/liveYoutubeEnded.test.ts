// When the live session ends (stop, ingest gone) the box must not go on saying the YouTube broadcast is live:
// /api/live/status never answers youtube.state 'live' with session null, and the broadcast is completed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveStatus } from '@surau/core';
import type { YoutubeLeg } from '../src/live/sessions.ts';
import { loginAs } from './authHelpers.ts';
import { startBody, startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';

const LAN = '10.168.1.40';
const harnesses: LiveHarness[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of harnesses.splice(0)) await h.close();
});

async function make(o: Parameters<typeof startLiveHarness>[0] = {}): Promise<LiveHarness> {
  const h = await startLiveHarness(o);
  harnesses.push(h);
  return h;
}

/** A leg that behaves like the real one: `live` once the stream is active, `complete` only after complete() ran. */
function leg(): YoutubeLeg & { completed: string[]; made: number } {
  let state: LiveStatus['youtube']['state'] = 'none';
  const completed: string[] = [];
  const self = {
    completed,
    made: 0,
    signedIn: () => true,
    createBroadcastFor: async () => {
      self.made++;
      state = 'live';
      return { broadcastId: 'bc1', watchUrl: 'https://youtu.be/bc1', key: 'abcd-efgh-ijkl-mnop-qrst' };
    },
    complete: async (id: string) => {
      completed.push(id);
      state = 'complete';
    },
    status: (): LiveStatus['youtube'] => ({
      signedIn: true, channelTitle: 'Surau', broadcastId: state === 'none' ? null : 'bc1', state, health: state === 'live' ? 'noData' : null,
      watchUrl: state === 'none' ? null : 'https://youtu.be/bc1', lastError: null,
    }),
  };
  return self;
}

const post = (h: LiveHarness, url: string, headers: Record<string, string>, payload: unknown = {}) =>
  h.app.inject({ method: 'POST', url, headers, payload: payload as object, remoteAddress: LAN });
const status = async (h: LiveHarness, headers: Record<string, string>) =>
  (await h.app.inject({ method: 'GET', url: '/api/live/status', headers, remoteAddress: LAN })).json() as LiveStatus;

async function ytReady(h: LiveHarness, headers: Record<string, string>): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const g = (await h.app.inject({ method: 'GET', url: '/api/live/youtube/ingest', headers, remoteAddress: LAN })).json() as { state: string };
    if (g.state !== 'starting') return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('the YouTube leg never settled');
}

const wants = { outputs: { kiosk: true, youtube: true }, youtubeVia: 'device' };

describe('the live ends: the YouTube state follows', () => {
  it('a running live reports the broadcast as live, with its session (the success path is untouched)', async () => {
    const yt = leg();
    const h = await make({ live: { monitorMs: 3_600_000, youtube: yt } });
    const user = await loginAs(h.app, 'live');
    await post(h, '/api/live/start', user.headers, startBody(h, wants));
    await ytReady(h, user.headers);
    const s = await status(h, user.headers);
    expect(s.session).not.toBeNull();
    expect(s.youtube).toMatchObject({ state: 'live', broadcastId: 'bc1' });
  });

  it('after a stop the broadcast is completed and the status says complete, not live', async () => {
    const yt = leg();
    const h = await make({ live: { monitorMs: 3_600_000, youtube: yt } });
    const user = await loginAs(h.app, 'live');
    await post(h, '/api/live/start', user.headers, startBody(h, wants));
    await ytReady(h, user.headers);
    expect((await post(h, '/api/live/stop', user.headers)).statusCode).toBe(200);
    await h.app.liveSessions!.settled();
    const s = await status(h, user.headers);
    expect(s.session).toBeNull();
    expect(s.youtube.state).toBe('complete');
    expect(yt.completed).toEqual(['bc1']);
  });

  it('inside the grace window (the broadcast kept open for a restart) the status still never says live with no session', async () => {
    const yt = leg();
    const h = await make({ live: { monitorMs: 3_600_000, youtube: yt, youtubeGraceMs: 60_000 } });
    const user = await loginAs(h.app, 'live');
    await post(h, '/api/live/start', user.headers, startBody(h, wants));
    await ytReady(h, user.headers);
    await post(h, '/api/live/stop', user.headers);
    await h.app.liveSessions!.settled();
    expect(yt.completed).toEqual([]); // held open for a restart of the same kuliah
    const s = await status(h, user.headers);
    expect(s.session).toBeNull();
    expect(s.youtube.state).not.toBe('live');
    expect(s.youtube.health).toBeNull();
    // a restart of the same kuliah carries on with the same broadcast, and the status is live again
    await post(h, '/api/live/start', user.headers, startBody(h, wants));
    await ytReady(h, user.headers);
    expect(yt.made).toBe(1);
    const again = await status(h, user.headers);
    expect(again.session).not.toBeNull();
    expect(again.youtube.state).toBe('live');
    await h.app.liveSessions!.shutdown();
    expect(yt.completed).toEqual(['bc1']);
  });

  it('ingest gone for 10 minutes ends the session and completes the broadcast at once (no grace window for a system end)', async () => {
    const yt = leg();
    const h = await make({ live: { monitorMs: 3_600_000, youtube: yt, youtubeGraceMs: 60_000 } });
    const user = await loginAs(h.app, 'live');
    await post(h, '/api/live/start', user.headers, startBody(h, wants));
    await ytReady(h, user.headers);
    const sessions = h.app.liveSessions!;
    h.clock.t += 11 * 60_000;
    await sessions.tick();
    await sessions.settled();
    expect(sessions.current()).toBeNull();
    const s = await status(h, user.headers);
    expect(s.session).toBeNull();
    expect(s.youtube.state).toBe('complete');
    expect(yt.completed).toEqual(['bc1']);
  });

  it('a camera that vanishes for 10 minutes (pulled live) completes the broadcast at once too', async () => {
    // the same system-end rule: only an explicit stop by a person may keep the broadcast open for a restart
    const yt = leg();
    const h = await make({ live: { monitorMs: 3_600_000, youtube: yt, youtubeGraceMs: 60_000 } });
    const user = await loginAs(h.app, 'live');
    await post(h, '/api/live/start', user.headers, startBody(h, wants));
    await ytReady(h, user.headers);
    const sessions = h.app.liveSessions!;
    await sessions.stop(sessions.current()!.id, 'system', 'controller_lost');
    expect(yt.completed).toEqual(['bc1']);
  });
});
