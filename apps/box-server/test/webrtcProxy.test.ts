import { afterEach, describe, expect, it, vi } from 'vitest';
import { loginAs } from './authHelpers.ts';
import { startBody, startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';

const harnesses: LiveHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});
async function make(o: Parameters<typeof startLiveHarness>[0] = {}): Promise<LiveHarness> {
  const h = await startLiveHarness(o);
  harnesses.push(h);
  return h;
}

const LAN = '10.168.1.40';
const SDP = 'v=0\r\no=- 1 1 IN IP4 10.168.1.40\r\ns=-\r\nt=0 0\r\n';
const sdp = (h: LiveHarness, url: string, headers: Record<string, string>, payload: string = SDP, remoteAddress = LAN) =>
  h.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/sdp', ...headers }, payload, remoteAddress });

async function startWeb(h: LiveHarness) {
  const liveUser = await loginAs(h.app, 'live');
  const r = await h.app.inject({
    method: 'POST',
    url: '/api/live/start',
    headers: liveUser.headers,
    payload: startBody(h, { source: 'web', youtubeVia: 'box' }),
    remoteAddress: LAN,
  });
  expect(r.statusCode).toBe(200);
  return { liveUser, id: r.json().session.id as string };
}

describe('WHIP proxy', () => {
  it('forwards the offer with the per-session publisher credential only and rewrites Location', async () => {
    const h = await make();
    const { liveUser, id } = await startWeb(h);
    const r = await sdp(h, '/api/live/whip', {
      ...liveUser.headers,
      cookie: 'session=stolen',
      'x-forwarded-for': '9.9.9.9',
      'x-custom': 'leak',
    });
    expect(r.statusCode).toBe(201);
    expect(r.headers['content-type']).toMatch(/^application\/sdp/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers.location).toBe('/api/live/whip/fake-session-1');
    expect(r.body).toContain('v=0');

    const seen = h.fake.requests.filter((q) => q.url === '/surau/whip');
    expect(seen).toHaveLength(1);
    const q = seen[0]!;
    // basic auth of pub-<id>, never the caller's bearer token and never the box credential
    const [user, pass] = Buffer.from((q.authorization ?? '').replace(/^Basic /, ''), 'base64').toString().split(':');
    expect(user).toBe(`pub-${id}`);
    const pub = (h.fake.global.authInternalUsers as Array<{ user: string; pass: string }>).find((u) => u.user === `pub-${id}`);
    expect(pass).toBe(pub?.pass);
    expect(q.authorization).not.toContain(liveUser.token);
    expect(q.cookie).toBeUndefined();
    expect(q.contentType).toBe('application/sdp');
    expect(q.body).toBe(SDP);
  });

  it('DELETE forwards only for a whip id this session created', async () => {
    const h = await make();
    const { liveUser } = await startWeb(h);
    await sdp(h, '/api/live/whip', liveUser.headers);
    const del = await h.app.inject({ method: 'DELETE', url: '/api/live/whip/fake-session-1', headers: liveUser.headers, remoteAddress: LAN });
    expect(del.statusCode).toBe(204);
    expect(h.fake.requests.some((q) => q.method === 'DELETE' && q.url === '/surau/whip/fake-session-1')).toBe(true);
    const before = h.fake.requests.length;
    const other = await h.app.inject({ method: 'DELETE', url: '/api/live/whip/someone-elses-id', headers: liveUser.headers, remoteAddress: LAN });
    expect(other.statusCode).toBe(404);
    expect(h.fake.requests.length).toBe(before);
  });

  it('403 when the live session belongs to another device', async () => {
    const h = await make();
    await startWeb(h);
    const intruder = await loginAs(h.app, 'live');
    const admin = await loginAs(h.app, 'admin');
    for (const who of [intruder, admin]) {
      const r = await sdp(h, '/api/live/whip', who.headers);
      expect(r.statusCode).toBe(403);
    }
    expect(h.fake.requests.some((q) => q.url === '/surau/whip')).toBe(false);
  });

  it('409 wrong_source for an android session; 409 no_session without a session', async () => {
    const h = await make();
    const liveUser = await loginAs(h.app, 'live');
    expect((await sdp(h, '/api/live/whip', liveUser.headers)).json()).toMatchObject({ code: 'no_session' });
    await h.app.inject({ method: 'POST', url: '/api/live/start', headers: liveUser.headers, payload: startBody(h), remoteAddress: LAN });
    const r = await sdp(h, '/api/live/whip', liveUser.headers);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('wrong_source');
  });

  it('refuses non-SDP, empty and oversized bodies', async () => {
    const h = await make();
    const { liveUser } = await startWeb(h);
    const json = await h.app.inject({ method: 'POST', url: '/api/live/whip', headers: liveUser.headers, payload: {}, remoteAddress: LAN });
    expect(json.statusCode).toBe(415);
    expect((await sdp(h, '/api/live/whip', liveUser.headers, '')).statusCode).toBe(400);
    expect((await sdp(h, '/api/live/whip', liveUser.headers, 'hello')).statusCode).toBe(400);
    const edge = await sdp(h, '/api/live/whip', liveUser.headers, 'v=0\r\n' + 'a'.repeat(64 * 1024 - 5));
    expect(edge.statusCode).toBe(201);
    const big = await sdp(h, '/api/live/whip', liveUser.headers, 'v=0\r\n' + 'a'.repeat(64 * 1024));
    expect(big.statusCode).toBe(413);
  });

  it('maps MediaMTX 401 to 503 mediamtx_auth and a dead MediaMTX to 503 mediamtx_down', async () => {
    const h = await make();
    const { liveUser } = await startWeb(h);
    h.fake.webOverride = { status: 401 };
    const r = await sdp(h, '/api/live/whip', liveUser.headers);
    expect(r.statusCode).toBe(503);
    expect(r.json().code).toBe('mediamtx_auth');
    h.fake.webOverride = null;
    h.fake.setWebDown(true);
    const down = await sdp(h, '/api/live/whip', liveUser.headers);
    expect(down.statusCode).toBe(503);
    expect(down.json().code).toBe('mediamtx_down');
  });

  it('does not leak the credential or upstream detail in an error', async () => {
    const h = await make();
    const { liveUser } = await startWeb(h);
    h.fake.webOverride = { status: 500 };
    const r = await sdp(h, '/api/live/whip', liveUser.headers);
    expect(r.statusCode).toBe(502);
    expect(r.body).not.toMatch(/Basic |pub-|127\.0\.0\.1/);
  });
});

describe('WHEP proxy', () => {
  it('works for the loopback kiosk with the box credential; DELETE only for its own ids', async () => {
    const h = await make();
    const r = await sdp(h, '/api/kiosk/live/whep', {}, SDP, '127.0.0.1');
    expect(r.statusCode).toBe(201);
    expect(r.headers.location).toBe('/api/kiosk/live/whep/fake-session-1');
    const q = h.fake.requests.find((x) => x.url === '/surau/whep')!;
    expect(q.authorization).toBe(`Basic ${Buffer.from(`box:${h.fake.pass}`).toString('base64')}`);
    const del = await h.app.inject({ method: 'DELETE', url: '/api/kiosk/live/whep/fake-session-1', remoteAddress: '127.0.0.1' });
    expect(del.statusCode).toBe(204);
    const bad = await h.app.inject({ method: 'DELETE', url: '/api/kiosk/live/whep/not-mine', remoteAddress: '127.0.0.1' });
    expect(bad.statusCode).toBe(404);
  });

  it('an anonymous LAN caller is 401', async () => {
    const h = await make();
    const r = await sdp(h, '/api/kiosk/live/whep', {}, SDP, LAN);
    expect(r.statusCode).toBe(401);
    expect(h.fake.requests.some((x) => x.url === '/surau/whep')).toBe(false);
  });

  it('a signed-in user holding kiosk:read (every role) is served from the LAN', async () => {
    const h = await make();
    const ajk = await loginAs(h.app, 'ajk');
    expect((await sdp(h, '/api/kiosk/live/whep', ajk.headers)).statusCode).toBe(201);
  });

  it('no publisher (MediaMTX 404) is 404 tiada siaran', async () => {
    const h = await make();
    h.fake.webOverride = { status: 404 };
    const r = await sdp(h, '/api/kiosk/live/whep', {}, SDP, '127.0.0.1');
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ errors: ['tiada siaran'] });
  });

  it('the 9th concurrent session evicts the oldest slot instead of being refused', async () => {
    const h = await make();
    for (let i = 0; i < 8; i++) {
      h.fake.webSessionId = `s${i}`;
      const r = await sdp(h, '/api/kiosk/live/whep', {}, SDP, '127.0.0.1');
      expect(r.statusCode, `session ${i}`).toBe(201);
    }
    h.fake.webSessionId = 's8';
    const ninth = await sdp(h, '/api/kiosk/live/whep', {}, SDP, '127.0.0.1');
    expect(ninth.statusCode).toBe(201);
    // the oldest slot (s0) is gone from the table, the newest is kept
    expect((await h.app.inject({ method: 'DELETE', url: '/api/kiosk/live/whep/s0', remoteAddress: '127.0.0.1' })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'DELETE', url: '/api/kiosk/live/whep/s8', remoteAddress: '127.0.0.1' })).statusCode).toBe(204);
  });

  it('refuses bodies over 64 KB', async () => {
    const h = await make();
    const r = await sdp(h, '/api/kiosk/live/whep', {}, 'v=0\r\n' + 'a'.repeat(64 * 1024), '127.0.0.1');
    expect(r.statusCode).toBe(413);
  });
});

describe('Skrin off closes the TV readers', () => {
  it('turning Skrin off during a live closes every open TV reader at MediaMTX, and a new one is refused', async () => {
    const h = await make({ live: { monitorMs: 3_600_000 } });
    const live = h.app.liveSessions;
    h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1' });
    const res = await live.start({ kuliahId: h.kuliahId, source: 'android', outputs: { kiosk: true, youtube: false, recording: true }, youtubeVia: 'device' }, 'user:t', 'dev1', '127.0.0.1');
    await live.tick();
    const opened = await sdp(h, '/api/kiosk/live/whep', {}, SDP, '127.0.0.1');
    expect(opened.statusCode).toBe(201);
    expect(h.fake.requests.some((q) => q.method === 'DELETE' && q.url.includes('/whep/'))).toBe(false);
    live.setOutputs({ sessionId: res.session.id, kiosk: false }, 'user:t', 'dev1');
    await new Promise((r) => setTimeout(r, 30));
    expect(h.fake.requests.some((q) => q.method === 'DELETE' && q.url === '/surau/whep/fake-session-1')).toBe(true);
    // its slot is forgotten and a new reader is refused
    expect((await h.app.inject({ method: 'DELETE', url: '/api/kiosk/live/whep/fake-session-1', remoteAddress: '127.0.0.1' })).statusCode).toBe(404);
    expect((await sdp(h, '/api/kiosk/live/whep', {}, SDP, '127.0.0.1')).statusCode).toBe(403);
  });

  it('B9: Skrin switched off while the viewer POST is on its way: the new reader is removed and the TV is refused', async () => {
    const h = await make({ live: { monitorMs: 3_600_000 } });
    const live = h.app.liveSessions;
    h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1' });
    const res = await live.start({ kuliahId: h.kuliahId, source: 'android', outputs: { kiosk: true, youtube: false, recording: true }, youtubeVia: 'device' }, 'user:t', 'dev1', '127.0.0.1');
    await live.tick();
    h.fake.onWebPost = () => {
      live.setOutputs({ sessionId: res.session.id, kiosk: false }, 'user:t', 'dev1');
    };
    const r = await sdp(h, '/api/kiosk/live/whep', {}, SDP, '127.0.0.1');
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ code: 'tv_live_off' });
    expect(h.fake.requests.some((q) => q.method === 'DELETE' && q.url === '/surau/whep/fake-session-1')).toBe(true);
    // the slot is not kept
    expect((await h.app.inject({ method: 'DELETE', url: '/api/kiosk/live/whep/fake-session-1', remoteAddress: '127.0.0.1' })).statusCode).toBe(404);
  });
});

describe('F6: viewer row life and the count check', () => {
  const until = async (cond: () => boolean, ms = 4000): Promise<void> => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('timeout waiting for condition');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

  async function rig() {
    const h = await make({ live: { monitorMs: 3_600_000 } });
    const live = h.app.liveSessions!;
    h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1' });
    await live.start({ kuliahId: h.kuliahId, source: 'android', outputs: { kiosk: true, youtube: false, recording: true }, youtubeVia: 'device' }, 'user:t', 'dev1', '127.0.0.1');
    await live.tick();
    const open = async (id: string) => {
      h.fake.webSessionId = id;
      const r = await sdp(h, '/api/kiosk/live/whep', {}, SDP, '127.0.0.1');
      expect(r.statusCode, `open ${id}`).toBe(201);
    };
    const alive = (id: string) => h.app.inject({ method: 'POST', url: `/api/kiosk/live/whep/${id}/alive`, remoteAddress: '127.0.0.1' });
    const del = (id: string) => h.app.inject({ method: 'DELETE', url: `/api/kiosk/live/whep/${id}`, remoteAddress: '127.0.0.1' });
    const playing = () => (live.status().viewers ?? []).filter((v) => v.state === 'playing').length;
    const closed = (id: string) => h.fake.requests.some((q) => q.method === 'DELETE' && q.url === `/surau/whep/${id}`);
    return { h, live, open, alive, del, playing, closed };
  }

  it('a row with an alive inside 60 s is forgotten 90 s after its last alive, its reader is NOT closed at the media server, and a late alive of the same TV gets the row back', async () => {
    const t = await rig();
    await t.open('f1');
    t.h.clock.t += 5_000;
    expect((await t.alive('f1')).statusCode).toBe(204);
    for (let i = 0; i < 4; i++) {
      t.h.clock.t += 30_000;
      expect((await t.alive('f1')).statusCode).toBe(204);
    }
    t.h.clock.t += 89_000;
    expect(t.playing()).toBe(1);
    expect(t.closed('f1')).toBe(false);
    t.h.clock.t += 2_000;
    expect(t.playing()).toBe(0);
    // Q1: a timer never cuts a picture: no DELETE reaches the media server
    await settle();
    expect(t.closed('f1')).toBe(false);
    expect((await t.alive('f1')).statusCode).toBe(204);
    expect(t.playing()).toBe(1);
  });

  it('a row without an alive inside 60 s lives 30 minutes, even when it says alive later', async () => {
    const t = await rig();
    await t.open('s1');
    t.h.clock.t += 2 * 60_000;
    expect((await t.alive('s1')).statusCode).toBe(204);
    t.h.clock.t += 5 * 60_000;
    expect(t.playing()).toBe(1);
    // 29 minutes after its last alive: a fast row would be long gone
    t.h.clock.t += 24 * 60_000;
    expect(t.playing()).toBe(1);
    t.h.clock.t += 2 * 60_000;
    expect(t.playing()).toBe(0);
    await settle();
    expect(t.closed('s1')).toBe(false);
  });

  it('a row that never says alive lives 30 minutes from its opening', async () => {
    const t = await rig();
    await t.open('s2');
    t.h.clock.t += 29 * 60_000;
    expect(t.playing()).toBe(1);
    t.h.clock.t += 2 * 60_000;
    expect(t.playing()).toBe(0);
  });

  it('count check: the media server counts fewer readers than rows, so the surplus rows go, quiet longest first', async () => {
    const t = await rig();
    await t.open('a');
    t.h.clock.t += 10_000;
    await t.open('b');
    t.h.clock.t += 10_000;
    await t.open('c');
    t.h.clock.t += 50_000;
    // a says it plays again, so b and c are the quiet ones
    expect((await t.alive('a')).statusCode).toBe(204);
    const spy = vi.spyOn(t.h.app.liveRuntime!.api!, 'pathWebrtcReaders');
    t.h.fake.setReady(true, { readers: 1 });
    t.live.status();
    await until(() => spy.mock.calls.length === 1);
    await settle();
    expect((await t.del('b')).statusCode).toBe(404);
    expect((await t.del('c')).statusCode).toBe(404);
    expect((await t.del('a')).statusCode).toBe(204);
  });

  it('count check: a row younger than 45 s stays, and so does every row when the counts agree or the media server counts more', async () => {
    const t = await rig();
    await t.open('y1');
    await t.open('y2');
    t.h.clock.t += 44_000;
    const spy = vi.spyOn(t.h.app.liveRuntime!.api!, 'pathWebrtcReaders');
    t.h.fake.setReady(true, { readers: 0 });
    t.live.status();
    await until(() => spy.mock.calls.length === 1);
    await settle();
    expect(t.playing()).toBe(1);
    // both rows survived: delete answers 204 for each
    expect((await t.del('y1')).statusCode).toBe(204);
    expect((await t.del('y2')).statusCode).toBe(204);
    await t.open('m1');
    t.h.clock.t += 60_000;
    t.h.fake.setReady(true, { readers: 3 });
    t.live.status();
    await until(() => spy.mock.calls.length === 2);
    await settle();
    expect((await t.del('m1')).statusCode).toBe(204);
  });

  it('count check: no answer from the media server (error or no list) removes nothing', async () => {
    const t = await rig();
    await t.open('n1');
    t.h.clock.t += 120_000;
    const api = t.h.app.liveRuntime!.api!;
    const spy = vi.spyOn(api, 'pathWebrtcReaders').mockRejectedValueOnce(new Error('mediamtx api: unreachable'));
    t.live.status();
    await until(() => spy.mock.calls.length === 1);
    await settle();
    spy.mockResolvedValueOnce(null);
    t.h.clock.t += 11_000;
    t.live.status();
    await until(() => spy.mock.calls.length === 2);
    await settle();
    expect((await t.del('n1')).statusCode).toBe(204);
  });

  it('count check: at most one question per 10 seconds', async () => {
    const t = await rig();
    await t.open('r1');
    t.h.clock.t += 60_000;
    const spy = vi.spyOn(t.h.app.liveRuntime!.api!, 'pathWebrtcReaders');
    t.h.fake.setReady(true, { readers: 1 });
    t.live.status();
    t.live.status();
    await until(() => spy.mock.calls.length >= 1);
    await settle();
    t.h.clock.t += 9_000;
    t.live.status();
    await settle();
    expect(spy.mock.calls.length).toBe(1);
    t.h.clock.t += 2_000;
    t.live.status();
    await until(() => spy.mock.calls.length === 2);
  });

  it('count check: an open preview on the path is subtracted from the readers; with a stale TV row it is removed, without one nothing is', async () => {
    const h = await make({ live: { monitorMs: 3_600_000 } });
    const starter = await loginAs(h.app, 'live');
    expect((await h.app.inject({ method: 'POST', url: '/api/live/start', headers: starter.headers, payload: startBody(h), remoteAddress: LAN })).statusCode).toBe(200);
    h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1' });
    await h.app.liveSessions!.tick();
    const post = async (url: string, headers: Record<string, string>, id: string) => {
      h.fake.webSessionId = id;
      return h.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/sdp', ...headers }, payload: SDP, remoteAddress: url.includes('kiosk') ? '127.0.0.1' : LAN });
    };
    expect((await post('/api/live/preview/whep', starter.headers, 'prev-1')).statusCode).toBe(201);
    expect((await post('/api/kiosk/live/whep', {}, 'tv-old')).statusCode).toBe(201);
    h.clock.t += 20_000;
    expect((await post('/api/kiosk/live/whep', {}, 'tv-new')).statusCode).toBe(201);
    h.clock.t += 60_000;
    const api = h.app.liveRuntime!.api!;
    // the media server counts the preview and one TV: tv-old is the stale row
    const spy = vi.spyOn(api, 'pathWebrtcReaders').mockResolvedValue(['u-prev', 'u-tv']);
    h.app.liveSessions!.status();
    await until(() => spy.mock.calls.length === 1);
    await settle();
    const del = (id: string) => h.app.inject({ method: 'DELETE', url: `/api/kiosk/live/whep/${id}`, remoteAddress: '127.0.0.1' });
    expect((await del('tv-old')).statusCode).toBe(404);
    // no stale row now: preview + one TV reader, one row: nothing is removed
    h.clock.t += 11_000;
    h.app.liveSessions!.status();
    await until(() => spy.mock.calls.length === 2);
    await settle();
    expect((await del('tv-new')).statusCode).toBe(204);
  });

  it('count check: the count check never rejects when the media server call throws synchronously', async () => {
    const t = await rig();
    await t.open('z1');
    t.h.clock.t += 60_000;
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    vi.spyOn(t.h.app.liveRuntime!.api!, 'pathWebrtcReaders').mockImplementation(() => {
      throw new Error('boom');
    });
    t.live.status();
    await settle();
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect((await t.del('z1')).statusCode).toBe(204);
  });

  it('a row the count check took comes back with the next alive of its TV, and is counted once', async () => {
    const t = await rig();
    await t.open('v1');
    t.h.clock.t += 60_000;
    const spy = vi.spyOn(t.h.app.liveRuntime!.api!, 'pathWebrtcReaders').mockResolvedValue([]);
    t.live.status();
    await until(() => spy.mock.calls.length === 1);
    await settle();
    expect(t.playing()).toBe(0);
    expect((await t.alive('v1')).statusCode).toBe(204);
    expect(t.playing()).toBe(1);
    // an id the box never issued is not revived
    expect((await t.alive('v2')).statusCode).toBe(404);
    // Q2: the revived row is slow again: it lives 30 minutes until an alive inside 60 s proves the fast cadence
    t.h.clock.t += 91_000;
    expect(t.playing()).toBe(1);
    // a revived row that re-proves fast: an alive inside 60 s of the revival
    const t2 = await rig();
    await t2.open('w1');
    t2.h.clock.t += 60_000;
    const spy2 = vi.spyOn(t2.h.app.liveRuntime!.api!, 'pathWebrtcReaders').mockResolvedValue([]);
    t2.live.status();
    await until(() => spy2.mock.calls.length === 1);
    await settle();
    expect((await t2.alive('w1')).statusCode).toBe(204);
    t2.h.clock.t += 30_000;
    expect((await t2.alive('w1')).statusCode).toBe(204);
    t2.h.clock.t += 91_000;
    expect(t2.playing()).toBe(0);
  });

  it('an alive never revives a row that was deleted or an id the box never issued; an expired row of the same TV comes back', async () => {
    const t = await rig();
    await t.open('d1');
    expect((await t.del('d1')).statusCode).toBe(204);
    expect((await t.alive('d1')).statusCode).toBe(404);
    expect(t.playing()).toBe(0);
    await t.open('e1');
    t.h.clock.t += 31 * 60_000;
    expect(t.playing()).toBe(0);
    // S1/Q3: issued to this TV and only forgotten: the TV gets its row back
    expect((await t.alive('e1')).statusCode).toBe(204);
    expect(t.playing()).toBe(1);
    // never issued by this box
    expect((await t.alive('never-issued')).statusCode).toBe(404);
    // a signed-in user (no TV) cannot revive anything
    const user = await loginAs(t.h.app, 'live');
    const r = await t.h.app.inject({ method: 'POST', url: '/api/kiosk/live/whep/u1/alive', headers: user.headers, remoteAddress: LAN });
    expect(r.statusCode).toBe(404);
    expect(t.playing()).toBe(1);
  });

  it('several rows of one TV (a follower box shares one identity) each keep their own revival', async () => {
    const t = await rig();
    await t.open('m1');
    await t.open('m2');
    t.h.clock.t += 31 * 60_000;
    expect(t.playing()).toBe(0);
    expect((await t.alive('m1')).statusCode).toBe(204);
    expect((await t.alive('m2')).statusCode).toBe(204);
  });

  it('Q1: the count check removes a row without a DELETE at the media server', async () => {
    const t = await rig();
    await t.open('q1');
    t.h.clock.t += 60_000;
    const spy = vi.spyOn(t.h.app.liveRuntime!.api!, 'pathWebrtcReaders').mockResolvedValue([]);
    t.live.status();
    await until(() => spy.mock.calls.length === 1);
    await settle();
    expect(t.playing()).toBe(0);
    expect(t.closed('q1')).toBe(false);
  });

  it('Q2: the count check removes a row past its own cadence before a quiet row that is still inside its own', async () => {
    const t = await rig();
    await t.open('slow');
    t.h.clock.t += 10_000;
    await t.open('fast');
    t.h.clock.t += 5_000;
    expect((await t.alive('fast')).statusCode).toBe(204);
    // 'fast' is 50 s without an alive (past 45 s); 'slow' is quiet for longer but well inside its 6 minutes
    t.h.clock.t += 50_000;
    const spy = vi.spyOn(t.h.app.liveRuntime!.api!, 'pathWebrtcReaders');
    t.h.fake.setReady(true, { readers: 1 });
    t.live.status();
    await until(() => spy.mock.calls.length === 1);
    await settle();
    expect((await t.del('fast')).statusCode).toBe(404);
    expect((await t.del('slow')).statusCode).toBe(204);
  });

  it('Q8: the preview readers are counted from the live preview table', async () => {
    const h = await make({ live: { monitorMs: 3_600_000 } });
    const starter = await loginAs(h.app, 'live');
    expect((await h.app.inject({ method: 'POST', url: '/api/live/start', headers: starter.headers, payload: startBody(h), remoteAddress: LAN })).statusCode).toBe(200);
    h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1' });
    await h.app.liveSessions!.tick();
    expect(h.app.liveSessions!.previewReaders('surau')).toBe(0);
    h.fake.webSessionId = 'pv-q8';
    expect((await h.app.inject({ method: 'POST', url: '/api/live/preview/whep', headers: { 'content-type': 'application/sdp', ...starter.headers }, payload: SDP, remoteAddress: LAN })).statusCode).toBe(201);
    expect(h.app.liveSessions!.previewReaders('surau')).toBe(1);
    expect(h.app.liveSessions!.previewReaders('other')).toBe(0);
  });
});
