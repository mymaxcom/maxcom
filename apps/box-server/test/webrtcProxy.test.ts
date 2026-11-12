import { afterEach, describe, expect, it } from 'vitest';
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
  const media = await loginAs(h.app, 'media');
  const r = await h.app.inject({
    method: 'POST',
    url: '/api/live/start',
    headers: media.headers,
    payload: startBody(h, { source: 'web', youtubeVia: 'box' }),
    remoteAddress: LAN,
  });
  expect(r.statusCode).toBe(200);
  return { media, id: r.json().session.id as string };
}

describe('WHIP proxy', () => {
  it('forwards the offer with the per-session publisher credential only and rewrites Location', async () => {
    const h = await make();
    const { media, id } = await startWeb(h);
    const r = await sdp(h, '/api/live/whip', {
      ...media.headers,
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
    expect(q.authorization).not.toContain(media.token);
    expect(q.cookie).toBeUndefined();
    expect(q.contentType).toBe('application/sdp');
    expect(q.body).toBe(SDP);
  });

  it('DELETE forwards only for a whip id this session created', async () => {
    const h = await make();
    const { media } = await startWeb(h);
    await sdp(h, '/api/live/whip', media.headers);
    const del = await h.app.inject({ method: 'DELETE', url: '/api/live/whip/fake-session-1', headers: media.headers, remoteAddress: LAN });
    expect(del.statusCode).toBe(204);
    expect(h.fake.requests.some((q) => q.method === 'DELETE' && q.url === '/surau/whip/fake-session-1')).toBe(true);
    const before = h.fake.requests.length;
    const other = await h.app.inject({ method: 'DELETE', url: '/api/live/whip/someone-elses-id', headers: media.headers, remoteAddress: LAN });
    expect(other.statusCode).toBe(404);
    expect(h.fake.requests.length).toBe(before);
  });

  it('403 when the live session belongs to another device', async () => {
    const h = await make();
    await startWeb(h);
    const intruder = await loginAs(h.app, 'media');
    const admin = await loginAs(h.app, 'admin');
    for (const who of [intruder, admin]) {
      const r = await sdp(h, '/api/live/whip', who.headers);
      expect(r.statusCode).toBe(403);
    }
    expect(h.fake.requests.some((q) => q.url === '/surau/whip')).toBe(false);
  });

  it('409 wrong_source for an android session; 409 no_session without a session', async () => {
    const h = await make();
    const media = await loginAs(h.app, 'media');
    expect((await sdp(h, '/api/live/whip', media.headers)).json()).toMatchObject({ code: 'no_session' });
    await h.app.inject({ method: 'POST', url: '/api/live/start', headers: media.headers, payload: startBody(h), remoteAddress: LAN });
    const r = await sdp(h, '/api/live/whip', media.headers);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('wrong_source');
  });

  it('refuses non-SDP, empty and oversized bodies', async () => {
    const h = await make();
    const { media } = await startWeb(h);
    const json = await h.app.inject({ method: 'POST', url: '/api/live/whip', headers: media.headers, payload: {}, remoteAddress: LAN });
    expect(json.statusCode).toBe(415);
    expect((await sdp(h, '/api/live/whip', media.headers, '')).statusCode).toBe(400);
    expect((await sdp(h, '/api/live/whip', media.headers, 'hello')).statusCode).toBe(400);
    const edge = await sdp(h, '/api/live/whip', media.headers, 'v=0\r\n' + 'a'.repeat(64 * 1024 - 5));
    expect(edge.statusCode).toBe(201);
    const big = await sdp(h, '/api/live/whip', media.headers, 'v=0\r\n' + 'a'.repeat(64 * 1024));
    expect(big.statusCode).toBe(413);
  });

  it('maps MediaMTX 401 to 503 mediamtx_auth and a dead MediaMTX to 503 mediamtx_down', async () => {
    const h = await make();
    const { media } = await startWeb(h);
    h.fake.webOverride = { status: 401 };
    const r = await sdp(h, '/api/live/whip', media.headers);
    expect(r.statusCode).toBe(503);
    expect(r.json().code).toBe('mediamtx_auth');
    h.fake.webOverride = null;
    h.fake.setWebDown(true);
    const down = await sdp(h, '/api/live/whip', media.headers);
    expect(down.statusCode).toBe(503);
    expect(down.json().code).toBe('mediamtx_down');
  });

  it('does not leak the credential or upstream detail in an error', async () => {
    const h = await make();
    const { media } = await startWeb(h);
    h.fake.webOverride = { status: 500 };
    const r = await sdp(h, '/api/live/whip', media.headers);
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

  it('the 5th concurrent session evicts the oldest slot instead of being refused', async () => {
    const h = await make();
    for (let i = 0; i < 4; i++) {
      h.fake.webSessionId = `s${i}`;
      const r = await sdp(h, '/api/kiosk/live/whep', {}, SDP, '127.0.0.1');
      expect(r.statusCode, `session ${i}`).toBe(201);
    }
    h.fake.webSessionId = 's4';
    const fifth = await sdp(h, '/api/kiosk/live/whep', {}, SDP, '127.0.0.1');
    expect(fifth.statusCode).toBe(201);
    // the oldest slot (s0) is gone from the table, the newest is kept
    expect((await h.app.inject({ method: 'DELETE', url: '/api/kiosk/live/whep/s0', remoteAddress: '127.0.0.1' })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'DELETE', url: '/api/kiosk/live/whep/s4', remoteAddress: '127.0.0.1' })).statusCode).toBe(204);
  });

  it('refuses bodies over 64 KB', async () => {
    const h = await make();
    const r = await sdp(h, '/api/kiosk/live/whep', {}, 'v=0\r\n' + 'a'.repeat(64 * 1024), '127.0.0.1');
    expect(r.statusCode).toBe(413);
  });
});
