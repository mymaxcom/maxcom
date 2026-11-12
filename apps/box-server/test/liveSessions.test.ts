import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveStatus } from '@surau/core';
import { putFeature } from '../src/settingsStore.ts';
import type { YoutubeLeg } from '../src/live/sessions.ts';
import { loginAs } from './authHelpers.ts';
import { changeLogText, startBody, startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';

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

/** The YouTube leg is made after the start answer: waits until the phone's ingest is no longer `starting`. */
async function ytSettled(app: LiveHarness['app'], headers: Record<string, string>): Promise<{ state: string; ingest: string | null; key: string | null }> {
  for (let i = 0; i < 400; i++) {
    const g = (await app.inject({ method: 'GET', url: '/api/live/youtube/ingest', headers, remoteAddress: '10.168.1.40' })).json();
    if (g.state !== 'starting') return g;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('the YouTube leg never settled');
}

const post = (h: LiveHarness, url: string, headers: Record<string, string>, payload: unknown) =>
  h.app.inject({ method: 'POST', url, headers, payload: payload as object, remoteAddress: '10.168.1.40' });

const fakeYoutube = (over: Partial<YoutubeLeg> = {}): YoutubeLeg & { completed: string[]; created: string[] } => {
  const completed: string[] = [];
  const created: string[] = [];
  const base: YoutubeLeg = {
    signedIn: () => true,
    createBroadcastFor: async (req) => {
      created.push(req.meta.title);
      return { broadcastId: 'bc1', watchUrl: 'https://youtu.be/bc1', key: 'abcd-efgh-ijkl-mnop-qrst' };
    },
    complete: async (id) => {
      completed.push(id);
    },
    status: (): LiveStatus['youtube'] => ({
      signedIn: true,
      channelTitle: 'Surau',
      broadcastId: 'bc1',
      state: 'created',
      health: null,
      watchUrl: 'https://youtu.be/bc1',
      lastError: null,
    }),
  };
  return Object.assign({ ...base, ...over }, { completed, created });
};

describe('live start (android, SRT)', () => {
  it('creates a per-session publisher user and passphrase, returns them once, and never logs or audits them', async () => {
    const logs = ['log', 'info', 'warn', 'error', 'debug'].map((m) => vi.spyOn(console, m as 'log').mockImplementation(() => undefined));
    const h = await make();
    const media = await loginAs(h.app, 'media');
    const r = await post(h, '/api/live/start', media.headers, startBody(h));
    expect(r.statusCode).toBe(200);
    const body = r.json();
    const id = body.session.id as string;
    expect(body.session).toMatchObject({ kuliahId: h.kuliahId, source: 'android', youtubeVia: 'device', startedBy: `user:${media.userId}` });
    expect(body.ingest.whip).toBe('/api/live/whip');
    const srt = body.ingest.srt;
    expect(srt.port).toBe(8890);
    expect(srt.passphrase).toMatch(/^[A-Za-z0-9]{24}$/);
    const m = /^publish:surau:(pub-[A-Za-z0-9_-]+):([A-Za-z0-9]{32})$/.exec(srt.streamId);
    expect(m, srt.streamId).not.toBeNull();
    expect(m![1]).toBe(`pub-${id}`);
    const pass = m![2]!;

    // the fake MediaMTX now knows the user (publish only, on the live path) and the passphrase
    const users = h.fake.global.authInternalUsers as Array<{ user: string; pass: string; permissions: Array<{ action: string; path?: string }> }>;
    const pub = users.find((u) => u.user === `pub-${id}`);
    expect(pub?.pass).toBe(pass);
    expect(pub?.permissions).toEqual([{ action: 'publish', path: 'surau' }]);
    expect(h.fake.paths.get('surau')).toMatchObject({ srtPublishPassphrase: srt.passphrase });

    // kiosk part of the answer
    expect(body.kiosk).toMatchObject({ live: false, kuliah: { label: 'Kuliah Maghrib', penceramah: 'Ustaz Ahmad Fauzi', topic: 'Bab Solat' } });
    expect(body.youtube).toBeNull();

    // no secret in the audit, in the console, or in the status answer
    const audit = changeLogText(h.app);
    for (const s of [pass, srt.passphrase]) expect(audit).not.toContain(s);
    expect(audit).toContain('"entity":"live"');
    const row = h.app.surau.db.prepare("SELECT after_json FROM change_log WHERE entity = 'live'").get() as { after_json: string };
    const after = JSON.parse(row.after_json) as Record<string, unknown>;
    expect(after).toMatchObject({ kuliahId: h.kuliahId, source: 'android', youtubeVia: 'device' });
    for (const k of Object.keys(after)) expect(k).not.toMatch(/key|pass|passphrase|token|secret/i);
    const status = await h.app.inject({ method: 'GET', url: '/api/live/status', headers: media.headers, remoteAddress: '10.168.1.40' });
    expect(status.statusCode).toBe(200);
    for (const s of [pass, srt.passphrase, h.fake.pass]) expect(status.body).not.toContain(s);
    const logged = JSON.stringify(logs.flatMap((l) => l.mock.calls));
    for (const s of [pass, srt.passphrase, h.fake.pass]) expect(logged).not.toContain(s);
    // MediaMTX logs the stream id: the supervisor's redaction list holds the session's credentials
    const scrub = h.app.liveRuntime!.secrets.list();
    expect(scrub).toContain(pass);
    expect(scrub).toContain(srt.passphrase);
  });

  it('web start has no SRT leg and clears any passphrase', async () => {
    const h = await make();
    const media = await loginAs(h.app, 'media');
    const r = await post(h, '/api/live/start', media.headers, startBody(h, { source: 'web', youtubeVia: 'box' }));
    expect(r.statusCode).toBe(200);
    expect(r.json().ingest.srt).toBeNull();
    expect(h.fake.paths.get('surau')?.srtPublishPassphrase ?? '').toBe('');
  });

  it('a second device gets 409 live_busy naming the device; the same device gets the same session', async () => {
    const h = await make();
    const a = await loginAs(h.app, 'media');
    const b = await loginAs(h.app, 'media');
    const first = await post(h, '/api/live/start', a.headers, startBody(h));
    expect(first.statusCode).toBe(200);
    const busy = await post(h, '/api/live/start', b.headers, startBody(h));
    expect(busy.statusCode).toBe(409);
    expect(busy.json().code).toBe('live_busy');
    expect(busy.json().errors[0]).toMatch(/^Siaran sedang berjalan dari peranti lain/);
    expect(busy.json().errors[0]).toMatch(/Peranti \d+/);
    const again = await post(h, '/api/live/start', a.headers, startBody(h));
    expect(again.statusCode).toBe(200);
    expect(again.json().session.id).toBe(first.json().session.id);
    // still exactly one publisher user (plus the box user)
    const users = h.fake.global.authInternalUsers as Array<{ user: string }>;
    expect(users.filter((u) => u.user.startsWith('pub-'))).toHaveLength(1);
  });

  it('two simultaneous starts from different devices: one wins, one is busy', async () => {
    const h = await make();
    const a = await loginAs(h.app, 'media');
    const b = await loginAs(h.app, 'media');
    const [ra, rb] = await Promise.all([
      post(h, '/api/live/start', a.headers, startBody(h)),
      post(h, '/api/live/start', b.headers, startBody(h)),
    ]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 409]);
    const users = h.fake.global.authInternalUsers as Array<{ user: string }>;
    expect(users.filter((u) => u.user.startsWith('pub-'))).toHaveLength(1);
  });
});

describe('live start refusals', () => {
  it('liveOnKiosk off is 409 live_off', async () => {
    const h = await make();
    putFeature(h.app.surau.db, 'liveOnKiosk', { enabled: false }, 'test');
    const media = await loginAs(h.app, 'media');
    const r = await post(h, '/api/live/start', media.headers, startBody(h));
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: 'live_off', errors: ['Siaran langsung di skrin dimatikan'] });
    expect((h.fake.global.authInternalUsers as Array<{ user: string }>).filter((u) => u.user.startsWith('pub-'))).toHaveLength(0);
  });

  it('missing tools is 503 tools_missing', async () => {
    const h = await make({ noTools: true });
    const media = await loginAs(h.app, 'media');
    const r = await post(h, '/api/live/start', media.headers, startBody(h));
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ code: 'tools_missing', errors: ['Perisian siaran belum dipasang di kotak'] });
  });

  it('a box built without live tools is 503 tools_missing', async () => {
    const h = await make({ app: { liveTools: null } });
    const media = await loginAs(h.app, 'media');
    const r = await post(h, '/api/live/start', media.headers, startBody(h));
    expect(r.statusCode).toBe(503);
    expect(r.json().code).toBe('tools_missing');
  });

  it('MediaMTX not running is 503 mediamtx_down', async () => {
    const h = await make();
    await h.app.liveRuntime!.supervisor!.stop();
    const media = await loginAs(h.app, 'media');
    const r = await post(h, '/api/live/start', media.headers, startBody(h));
    expect(r.statusCode).toBe(503);
    expect(r.json().code).toBe('mediamtx_down');
  });

  it('unknown kuliah is 404; a cancelled kuliah is 409; bad bodies are 400', async () => {
    const h = await make();
    const media = await loginAs(h.app, 'media');
    expect((await post(h, '/api/live/start', media.headers, startBody(h, { kuliahId: 'nope' }))).statusCode).toBe(404);
    const { db } = h.app.surau;
    const row = db.prepare("SELECT json FROM content_items WHERE kind = 'kuliah' AND id = ?").get(h.kuliahId) as { json: string };
    const batal = { ...JSON.parse(row.json), status: 'batal' };
    db.prepare("UPDATE content_items SET json = ? WHERE kind = 'kuliah' AND id = ?").run(JSON.stringify(batal), h.kuliahId);
    const r = await post(h, '/api/live/start', media.headers, startBody(h));
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('kuliah_batal');
    for (const bad of [{}, startBody(h, { source: 'ios' }), startBody(h, { outputs: { kiosk: false, youtube: false } }), startBody(h, { youtubeVia: 'cloud' }), startBody(h, { kuliahId: 7 })]) {
      expect((await post(h, '/api/live/start', media.headers, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    // nothing was left behind in MediaMTX
    expect((h.fake.global.authInternalUsers as Array<{ user: string }>).filter((u) => u.user.startsWith('pub-'))).toHaveLength(0);
  });

  it('a start without a kuliah is allowed', async () => {
    const h = await make();
    const media = await loginAs(h.app, 'media');
    const r = await post(h, '/api/live/start', media.headers, startBody(h, { kuliahId: null }));
    expect(r.statusCode).toBe(200);
    expect(r.json().kiosk.kuliah).toBeNull();
  });
});

describe('live stop', () => {
  it('removes the user and passphrase, kicks the publisher, writes a secret-free audit row and clears the state', async () => {
    const h = await make();
    const media = await loginAs(h.app, 'media');
    const start = await post(h, '/api/live/start', media.headers, startBody(h));
    const id = start.json().session.id as string;
    const pass = /:([A-Za-z0-9]{32})$/.exec(start.json().ingest.srt.streamId)![1]!;
    const passphrase = start.json().ingest.srt.passphrase as string;
    h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'conn-1', bytesReceived: 1000 });

    h.clock.t += 90_000;
    const stop = await post(h, '/api/live/stop', media.headers, { sessionId: id });
    expect(stop.statusCode).toBe(200);
    expect(stop.json()).toMatchObject({ stopped: true });
    // the HTTP answer does not wait for the MediaMTX clean-up
    await h.app.liveSessions!.settled();

    expect((h.fake.global.authInternalUsers as Array<{ user: string }>).some((u) => u.user.startsWith('pub-'))).toBe(false);
    expect(h.fake.kicked).toContain('srtconns/conn-1');
    expect(h.fake.paths.get('surau')?.srtPublishPassphrase).toBe('');
    const rows = h.app.surau.db.prepare("SELECT after_json FROM change_log WHERE entity = 'live' AND entity_id = ? ORDER BY id").all(id) as Array<{ after_json: string }>;
    expect(rows).toHaveLength(2);
    const stopped = JSON.parse(rows[1]!.after_json) as Record<string, unknown>;
    expect(stopped).toMatchObject({ reason: 'stopped' });
    expect(typeof stopped.stoppedAt).toBe('string');
    for (const row of rows) for (const k of Object.keys(JSON.parse(row.after_json) as object)) expect(k).not.toMatch(/key|pass|passphrase|token|secret/i);
    const audit = changeLogText(h.app);
    expect(audit).not.toContain(pass);
    expect(audit).not.toContain(passphrase);

    const status = (await h.app.inject({ method: 'GET', url: '/api/live/status', headers: media.headers, remoteAddress: '10.168.1.40' })).json();
    expect(status.session).toBeNull();
    // a different device may start now
    const b = await loginAs(h.app, 'media');
    expect((await post(h, '/api/live/start', b.headers, startBody(h))).statusCode).toBe(200);
  });

  it('only the owning device or an admin may stop; an unknown id is a harmless no-op', async () => {
    const h = await make();
    const a = await loginAs(h.app, 'media');
    const b = await loginAs(h.app, 'media');
    const admin = await loginAs(h.app, 'admin');
    const id = (await post(h, '/api/live/start', a.headers, startBody(h))).json().session.id as string;
    expect((await post(h, '/api/live/stop', b.headers, { sessionId: id })).statusCode).toBe(403);
    expect((await post(h, '/api/live/stop', a.headers, { sessionId: 'nope' })).json()).toMatchObject({ stopped: false });
    expect((await post(h, '/api/live/stop', admin.headers, { sessionId: id })).json()).toMatchObject({ stopped: true });
    expect((await post(h, '/api/live/stop', a.headers, { sessionId: id })).json()).toMatchObject({ stopped: false });
  });

  it('auto-stops with reason timeout when no ingest arrives for 10 minutes', async () => {
    const h = await make({ live: { monitorMs: 3_600_000 } });
    const media = await loginAs(h.app, 'media');
    const id = (await post(h, '/api/live/start', media.headers, startBody(h))).json().session.id as string;
    const sessions = h.app.liveSessions!;
    h.clock.t += 9 * 60_000;
    await sessions.tick();
    expect(sessions.current()?.id).toBe(id);
    h.clock.t += 2 * 60_000;
    await sessions.tick();
    expect(sessions.current()).toBeNull();
    const rows = h.app.surau.db.prepare("SELECT after_json FROM change_log WHERE entity = 'live' AND entity_id = ? ORDER BY id").all(id) as Array<{ after_json: string }>;
    expect(JSON.parse(rows[1]!.after_json)).toMatchObject({ reason: 'timeout' });
  });

  it('auto-stops when the publisher vanishes for 10 minutes, but not while it is ready', async () => {
    const h = await make({ live: { monitorMs: 3_600_000 } });
    const media = await loginAs(h.app, 'media');
    await post(h, '/api/live/start', media.headers, startBody(h));
    const sessions = h.app.liveSessions!;
    h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1', bytesReceived: 10 });
    h.clock.t += 30 * 60_000;
    await sessions.tick();
    expect(sessions.current()).not.toBeNull();
    h.fake.setReady(false);
    h.clock.t += 5 * 60_000;
    await sessions.tick();
    expect(sessions.current()).not.toBeNull();
    h.clock.t += 6 * 60_000;
    await sessions.tick();
    expect(sessions.current()).toBeNull();
  });
});

describe('live and YouTube (seam for Task 4)', () => {
  it('device leg: the key is in the start answer only; the box relay keeps it in memory and returns none', async () => {
    const logs = ['log', 'info', 'warn', 'error'].map((m) => vi.spyOn(console, m as 'log').mockImplementation(() => undefined));
    const yt = fakeYoutube();
    const h = await make({ live: { youtube: yt } });
    const media = await loginAs(h.app, 'media');
    const r = await post(h, '/api/live/start', media.headers, startBody(h, { outputs: { kiosk: true, youtube: true }, youtubeVia: 'device' }));
    expect(r.statusCode).toBe(200);
    expect(r.json().youtube).toEqual({ via: 'device', ingest: null, key: null, state: 'starting' });
    // the key follows from the owner-only ingest read, once the broadcast exists
    expect(await ytSettled(h.app, media.headers)).toEqual({ state: 'ready', ingest: 'rtmps://a.rtmps.youtube.com:443/live2', key: 'abcd-efgh-ijkl-mnop-qrst' });
    expect(yt.created).toEqual(['Kuliah Maghrib: Ustaz Ahmad Fauzi']);
    const status = await h.app.inject({ method: 'GET', url: '/api/live/status', headers: media.headers, remoteAddress: '10.168.1.40' });
    expect(status.json().youtube).toMatchObject({ broadcastId: 'bc1', watchUrl: 'https://youtu.be/bc1' });
    const stop = await post(h, '/api/live/stop', media.headers, {});
    expect(stop.statusCode).toBe(200);
    await h.app.liveSessions!.settled();
    expect(yt.completed).toEqual(['bc1']);
    const secret = 'abcd-efgh-ijkl-mnop-qrst';
    expect(changeLogText(h.app)).not.toContain(secret);
    expect(status.body).not.toContain(secret);
    expect(JSON.stringify(logs.flatMap((l) => l.mock.calls))).not.toContain(secret);
    const row = h.app.surau.db.prepare("SELECT after_json FROM change_log WHERE entity = 'live' ORDER BY id DESC").get() as { after_json: string };
    // the broadcast is made after the start row is written: the stop row carries its id
    expect(JSON.parse(row.after_json)).toMatchObject({ broadcastId: 'bc1' });

    const h2 = await make({ live: { youtube: fakeYoutube() } });
    const m2 = await loginAs(h2.app, 'media');
    const r2 = await post(h2, '/api/live/start', m2.headers, startBody(h2, { source: 'web', outputs: { kiosk: true, youtube: true }, youtubeVia: 'box' }));
    expect(r2.json().youtube).toEqual({ via: 'box', ingest: null, key: null, state: 'starting' });
  });

  it('warns instead of failing: youtube_off, youtube_not_signed_in, no_internet', async () => {
    const wants = { outputs: { kiosk: true, youtube: true } };
    const off = await make({ live: { youtube: fakeYoutube() } });
    putFeature(off.app.surau.db, 'liveYoutube', { enabled: false }, 'test');
    const m1 = await loginAs(off.app, 'media');
    const r1 = await post(off, '/api/live/start', m1.headers, startBody(off, wants));
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ youtube: null, warnings: ['youtube_off'] });

    const out = await make({ live: { youtube: fakeYoutube({ signedIn: () => false }) } });
    const m2 = await loginAs(out.app, 'media');
    expect((await post(out, '/api/live/start', m2.headers, startBody(out, wants))).json()).toMatchObject({ youtube: null, warnings: ['youtube_not_signed_in'] });

    const down = await make({ live: { youtube: fakeYoutube({ createBroadcastFor: async () => { throw new Error('ENOTFOUND'); } }) } });
    const m3 = await loginAs(down.app, 'media');
    const r3 = await post(down, '/api/live/start', m3.headers, startBody(down, wants));
    expect(r3.statusCode).toBe(200);
    expect(r3.json()).toMatchObject({ youtube: { state: 'starting' } });
    await ytSettled(down.app, m3.headers);
    expect(down.app.liveSessions!.status().warnings).toEqual(['no_internet']);

    const none = await make();
    const m4 = await loginAs(none.app, 'media');
    expect((await post(none, '/api/live/start', m4.headers, startBody(none, wants))).json()).toMatchObject({ youtube: null, warnings: ['youtube_not_signed_in'] });
  });
});

describe('live stop answers promptly (slow MediaMTX clean-up runs after the answer)', () => {
  const slow = 250;

  it('POST /api/live/stop returns long before the MediaMTX clean-up ends; the session and the kiosk picture are gone at once', async () => {
    const h = await make();
    const media = await loginAs(h.app, 'media');
    const start = await post(h, '/api/live/start', media.headers, startBody(h));
    const id = start.json().session.id as string;
    h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'conn-1', bytesReceived: 1000 });
    await h.app.liveSessions!.tick();
    expect(h.app.liveSessions!.kioskLive().live).toBe(true);

    // pathGet + kick + user read/write + passphrase patch: five sequential MediaMTX calls
    h.fake.apiDelayMs = slow;
    const t0 = Date.now();
    const stop = await post(h, '/api/live/stop', media.headers, { sessionId: id });
    const took = Date.now() - t0;
    expect(stop.statusCode).toBe(200);
    expect(stop.json()).toMatchObject({ stopped: true });
    expect(took).toBeLessThan(slow * 2);
    expect(h.app.liveSessions!.current()).toBeNull();
    expect(h.app.liveSessions!.kioskLive().live).toBe(false);
    // the box keeps answering the app's status poll while the clean-up runs
    const t1 = Date.now();
    const status = await h.app.inject({ method: 'GET', url: '/api/live/status', headers: media.headers, remoteAddress: '10.168.1.40' });
    expect(status.statusCode).toBe(200);
    expect(status.json().session).toBeNull();
    expect(Date.now() - t1).toBeLessThan(slow);
    // the credentials are still being removed in the background ...
    expect((h.fake.global.authInternalUsers as Array<{ user: string }>).some((u) => u.user.startsWith('pub-'))).toBe(true);
    await h.app.liveSessions!.settled();
    // ... and are gone once it ends
    expect((h.fake.global.authInternalUsers as Array<{ user: string }>).some((u) => u.user.startsWith('pub-'))).toBe(false);
    expect(h.fake.kicked).toContain('srtconns/conn-1');
    expect(h.fake.paths.get('surau')?.srtPublishPassphrase).toBe('');
  });

  it('the audit row is written once, at stop, with no secret', async () => {
    const h = await make();
    const media = await loginAs(h.app, 'media');
    const id = (await post(h, '/api/live/start', media.headers, startBody(h))).json().session.id as string;
    h.fake.apiDelayMs = slow;
    await post(h, '/api/live/stop', media.headers, { sessionId: id });
    const rows = h.app.surau.db.prepare("SELECT after_json FROM change_log WHERE entity = 'live' AND entity_id = ?").all(id) as Array<{ after_json: string }>;
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[1]!.after_json)).toMatchObject({ reason: 'stopped' });
    await h.app.liveSessions!.settled();
  });

  it('a start right after a stop waits for the clean-up and keeps its own passphrase and user', async () => {
    const h = await make();
    const a = await loginAs(h.app, 'media');
    const first = (await post(h, '/api/live/start', a.headers, startBody(h))).json();
    h.fake.apiDelayMs = slow;
    expect((await post(h, '/api/live/stop', a.headers, { sessionId: first.session.id })).statusCode).toBe(200);
    const b = await loginAs(h.app, 'media');
    const second = await post(h, '/api/live/start', b.headers, startBody(h));
    expect(second.statusCode).toBe(200);
    const sec = second.json();
    expect(sec.session.id).not.toBe(first.session.id);
    const users = (h.fake.global.authInternalUsers as Array<{ user: string }>).map((u) => u.user);
    expect(users).toContain(`pub-${sec.session.id}`);
    expect(users).not.toContain(`pub-${first.session.id}`);
    // the first session's clean-up did not wipe the second session's SRT passphrase
    expect(h.fake.paths.get('surau')?.srtPublishPassphrase).toBe(sec.ingest.srt.passphrase);
  });

  it('shutdown and the idle timeout still finish their clean-up before returning', async () => {
    const h = await make({ live: { monitorMs: 3_600_000 } });
    const media = await loginAs(h.app, 'media');
    await post(h, '/api/live/start', media.headers, startBody(h));
    h.fake.apiDelayMs = 50;
    h.clock.t += 11 * 60_000;
    await h.app.liveSessions!.tick();
    expect(h.app.liveSessions!.current()).toBeNull();
    expect((h.fake.global.authInternalUsers as Array<{ user: string }>).some((u) => u.user.startsWith('pub-'))).toBe(false);
  });
});

const fwStub = (state: 'ok' | 'missing' | 'wrong' | 'unknown') => ({ check: async () => state, state: () => state });

describe('media ports firewall warning', () => {
  it('start still succeeds and carries media_ports_blocked when the rules are missing or wrong; status and health report it', async () => {
    for (const state of ['missing', 'wrong'] as const) {
      const h = await make({ app: { liveFirewall: fwStub(state) } });
      const media = await loginAs(h.app, 'media');
      const r = await post(h, '/api/live/start', media.headers, startBody(h));
      expect(r.statusCode).toBe(200);
      expect(r.json().warnings).toContain('media_ports_blocked');
      const st = await h.app.inject({ method: 'GET', url: '/api/live/status', headers: media.headers, remoteAddress: '10.168.1.40' });
      expect(st.json().warnings).toContain('media_ports_blocked');
      const admin = await loginAs(h.app, 'admin');
      const health = await h.app.inject({ method: 'GET', url: '/api/health', headers: admin.headers, remoteAddress: '10.168.1.40' });
      expect(health.json().live.firewall).toBe(state);
    }
  });

  it('no warning when the rules are ok or the state is unknown (no firewall check wired)', async () => {
    for (const fw of [fwStub('ok'), fwStub('unknown'), undefined]) {
      const h = await make({ app: fw === undefined ? {} : { liveFirewall: fw } });
      const media = await loginAs(h.app, 'media');
      const r = await post(h, '/api/live/start', media.headers, startBody(h));
      expect(r.json().warnings ?? []).not.toContain('media_ports_blocked');
      expect(h.app.liveSessions!.status().warnings).toEqual([]);
    }
  });

  it('the status warns before any start, so the app can show it up front', async () => {
    const h = await make({ app: { liveFirewall: fwStub('wrong') } });
    await h.app.liveSessions!.checkFirewall();
    expect(h.app.liveSessions!.status().warnings).toEqual(['media_ports_blocked']);
  });
});

describe('no-video watchdog', () => {
  it('warns no_video_from_device when the path is not ready 12 s after the start, and clears it when the picture arrives', async () => {
    const h = await make({ live: { monitorMs: 3_600_000 } });
    const media = await loginAs(h.app, 'media');
    await post(h, '/api/live/start', media.headers, startBody(h));
    const sessions = h.app.liveSessions!;
    h.clock.t += 11_000;
    await sessions.tick();
    expect(sessions.status().warnings).toEqual([]);
    h.clock.t += 2_000;
    await sessions.tick();
    expect(sessions.status().warnings).toEqual(['no_video_from_device']);
    const st = await h.app.inject({ method: 'GET', url: '/api/live/status', headers: media.headers, remoteAddress: '10.168.1.40' });
    expect(st.json().warnings).toEqual(['no_video_from_device']);
    h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1', bytesReceived: 10 });
    h.clock.t += 1_000;
    await sessions.tick();
    expect(sessions.status().warnings).toEqual([]);
  });

  it('a picture that arrives in time never warns, and a picture that vanishes for 12 s warns again', async () => {
    const h = await make({ live: { monitorMs: 3_600_000 } });
    const media = await loginAs(h.app, 'media');
    await post(h, '/api/live/start', media.headers, startBody(h));
    const sessions = h.app.liveSessions!;
    h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1', bytesReceived: 10 });
    h.clock.t += 5_000;
    await sessions.tick();
    expect(sessions.status().warnings).toEqual([]);
    h.fake.setReady(false);
    h.clock.t += 8_000;
    await sessions.tick();
    expect(sessions.status().warnings).toEqual([]);
    h.clock.t += 8_000;
    await sessions.tick();
    expect(sessions.status().warnings).toEqual(['no_video_from_device']);
  });

  it('the 12 s window starts when the start answer returns (the YouTube broadcast is made after it and does not move it)', async () => {
    const yt = fakeYoutube();
    const h = await make({ live: { monitorMs: 3_600_000, youtube: yt } });
    const media = await loginAs(h.app, 'media');
    const r = await post(h, '/api/live/start', media.headers, startBody(h, { outputs: { kiosk: true, youtube: true }, youtubeVia: 'device' }));
    expect(r.statusCode).toBe(200);
    const sessions = h.app.liveSessions!;
    await sessions.tick();
    expect(sessions.status().warnings).not.toContain('no_video_from_device');
    h.clock.t += 11_000;
    await sessions.tick();
    expect(sessions.status().warnings).not.toContain('no_video_from_device');
    h.clock.t += 2_000;
    await sessions.tick();
    expect(sessions.status().warnings).toContain('no_video_from_device');
  });

  it('no warning without a session', async () => {
    const h = await make();
    expect(h.app.liveSessions!.status().warnings).toEqual([]);
  });

  it('follows system.noVideoSeconds: 5 s warns at 5 and not at 4; a later change applies at the next check without a restart', async () => {
    const h = await make({ live: { monitorMs: 3_600_000 } });
    putFeature(h.app.surau.db, 'system', { noVideoSeconds: 5 }, 'test');
    const media = await loginAs(h.app, 'media');
    await post(h, '/api/live/start', media.headers, startBody(h));
    const sessions = h.app.liveSessions!;
    h.clock.t += 4_000;
    await sessions.tick();
    expect(sessions.status().warnings).toEqual([]);
    h.clock.t += 1_000;
    await sessions.tick();
    expect(sessions.status().warnings).toEqual(['no_video_from_device']);
    // raised to 20 s: the same 5 s without a picture is no longer a warning at the very next check
    putFeature(h.app.surau.db, 'system', { noVideoSeconds: 20 }, 'test');
    await sessions.tick();
    expect(sessions.status().warnings).toEqual([]);
    h.clock.t += 14_000;
    await sessions.tick();
    expect(sessions.status().warnings).toEqual([]);
    h.clock.t += 2_000;
    await sessions.tick();
    expect(sessions.status().warnings).toEqual(['no_video_from_device']);
  });
});

describe('firewall state refresh while live', () => {
  it('a tick asks the firewall check for a fresh state (the check itself rate-limits to once per 60 s), without blocking the tick', async () => {
    let calls = 0;
    let state: 'missing' | 'ok' = 'missing';
    const fw = {
      check: () => {
        calls++;
        return new Promise<'missing' | 'ok'>((res) => setTimeout(() => res(state), 1_500)); // slow: a tick must not wait for it
      },
      state: () => state,
    };
    const h = await make({ live: { monitorMs: 3_600_000 }, app: { liveFirewall: fw } });
    const media = await loginAs(h.app, 'media');
    await post(h, '/api/live/start', media.headers, startBody(h));
    const before = calls;
    const t0 = Date.now();
    await h.app.liveSessions!.tick();
    expect(Date.now() - t0).toBeLessThan(700);
    expect(calls).toBeGreaterThan(before);
  });

  it('after the rules are fixed the banner clears on the next refresh and a reconnect sees the fresh state', async () => {
    let truth: 'missing' | 'ok' = 'missing';
    let cached: 'missing' | 'ok' = 'missing';
    const fw = {
      check: async () => {
        cached = truth;
        return cached;
      },
      state: () => cached, // like LiveFirewall: state() only returns the last cached result
    };
    const h = await make({ live: { monitorMs: 3_600_000 }, app: { liveFirewall: fw } });
    const media = await loginAs(h.app, 'media');
    const first = await post(h, '/api/live/start', media.headers, startBody(h));
    expect(first.json().warnings).toContain('media_ports_blocked');
    expect(h.app.liveSessions!.status().warnings).toContain('media_ports_blocked');
    truth = 'ok';
    await h.app.liveSessions!.tick();
    const back = await post(h, '/api/live/start', media.headers, startBody(h));
    expect(back.json().warnings ?? []).not.toContain('media_ports_blocked');
    expect(h.app.liveSessions!.status().warnings).not.toContain('media_ports_blocked');
  });
});
