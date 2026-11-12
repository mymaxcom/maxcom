import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { putFeature } from '../src/settingsStore.ts';
import { createYoutubeService } from '../src/live/youtube/api.ts';
import { YoutubeError, googleRequest } from '../src/live/youtube/oauth.ts';
import { TokenStore } from '../src/live/youtube/tokenStore.ts';
import { loginAs } from './authHelpers.ts';
import { FAKE_DEVICE_CODE, FAKE_REFRESH, FAKE_STREAM_KEY, startFakeGoogle } from './support/fakeGoogle.ts';
import type { FakeGoogle } from './support/fakeGoogle.ts';
import { changeLogText, startBody, startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';

const LAN = '10.168.1.40';
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0)) await c();
});

interface Rig {
  h: LiveHarness;
  g: FakeGoogle;
  tokenPath: string;
  clientPath: string;
  logs: string[];
}

async function rig(opts: { client?: boolean } = {}): Promise<Rig> {
  const g = await startFakeGoogle();
  const h = await startLiveHarness({ app: { fetchImpl: g.fetchImpl } });
  closers.push(h.close, g.close);
  const clientPath = join(h.dataDir, 'secret', 'youtube-client.json');
  if (opts.client !== false) writeFileSync(clientPath, JSON.stringify({ client_id: 'cid-123.apps.googleusercontent.com', client_secret: 'csecret-SECRET' }));
  const logs: string[] = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
  }
  return { h, g, tokenPath: join(h.dataDir, 'secret', 'youtube-token.json'), clientPath, logs };
}

const inject = async (r: Rig, method: 'GET' | 'POST', url: string, headers: Record<string, string>, payload?: object) => {
  const res = await r.h.app.inject({ method, url, headers, ...(payload ? { payload } : {}), remoteAddress: LAN });
  // the broadcast is made after the start answer: wait until it has settled so the checks below see its result
  if (method === 'POST' && url === '/api/live/start' && res.statusCode === 200 && res.json().youtube?.state === 'starting') {
    for (let i = 0; i < 400; i++) {
      const g = (await r.h.app.inject({ method: 'GET', url: '/api/live/youtube/ingest', headers, remoteAddress: LAN })).json();
      if (g.state !== 'starting') break;
      await new Promise((x) => setTimeout(x, 15));
    }
  }
  return res;
};
const ingestOf = async (r: Rig, headers: Record<string, string>) =>
  (await r.h.app.inject({ method: 'GET', url: '/api/live/youtube/ingest', headers, remoteAddress: LAN })).json();
const warningsOf = async (r: Rig, headers: Record<string, string>) => (await inject(r, 'GET', '/api/live/status', headers)).json().warnings;

/** Full sign-in through the routes as an administrator. */
async function signIn(r: Rig): Promise<{ admin: Awaited<ReturnType<typeof loginAs>> }> {
  const admin = await loginAs(r.h.app, 'admin');
  const begin = await inject(r, 'POST', '/api/live/youtube/signin', admin.headers);
  expect(begin.statusCode).toBe(200);
  r.g.approve = true;
  r.h.clock.t += 6000;
  const done = await inject(r, 'POST', '/api/live/youtube/signin/poll', admin.headers);
  expect(done.json()).toMatchObject({ state: 'signed_in', signedIn: true });
  return { admin };
}

describe('sign-in by device code', () => {
  it('without the OAuth client file the status says not configured and sign-in is refused', async () => {
    const r = await rig({ client: false });
    const admin = await loginAs(r.h.app, 'admin');
    expect((await inject(r, 'GET', '/api/live/youtube/status', admin.headers)).json()).toEqual({ configured: false, signedIn: false, channelTitle: null, lastError: null });
    const res = await inject(r, 'POST', '/api/live/youtube/signin', admin.headers);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('youtube_not_configured');
    expect(r.g.calls).toHaveLength(0);
  });

  it('begin shows only the user code and the address, stores nothing and hides the device code', async () => {
    const r = await rig();
    const admin = await loginAs(r.h.app, 'admin');
    const res = await inject(r, 'POST', '/api/live/youtube/signin', admin.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ verificationUrl: 'https://www.google.com/device', userCode: 'ABCD-EFGH', interval: 5 });
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'interval', 'userCode', 'verificationUrl']);
    expect(res.body).not.toContain(FAKE_DEVICE_CODE);
    expect(res.body).not.toContain('csecret-SECRET');
    expect(existsSync(r.tokenPath)).toBe(false);
    expect((await inject(r, 'GET', '/api/live/youtube/status', admin.headers)).json()).toMatchObject({ configured: true, signedIn: false });
    // the device-code request carried the client id and the YouTube scope, nothing else
    const dc = r.g.calls.find((c) => c.path === '/device/code')!;
    expect(new URLSearchParams(dc.body).get('scope')).toBe('https://www.googleapis.com/auth/youtube');
  });

  it('a poll before the interval is answered from the cache and does not hit Google', async () => {
    const r = await rig();
    const admin = await loginAs(r.h.app, 'admin');
    await inject(r, 'POST', '/api/live/youtube/signin', admin.headers);
    const a = await inject(r, 'POST', '/api/live/youtube/signin/poll', admin.headers);
    const b = await inject(r, 'POST', '/api/live/youtube/signin/poll', admin.headers);
    expect(a.json()).toMatchObject({ state: 'pending', signedIn: false });
    expect(b.json()).toEqual(a.json());
    expect(r.g.count('/token')).toBe(0);
    r.h.clock.t += 5000;
    expect((await inject(r, 'POST', '/api/live/youtube/signin/poll', admin.headers)).json()).toMatchObject({ state: 'pending', signedIn: false });
    expect(r.g.count('/token')).toBe(1);
    // and again right away: still the cache
    await inject(r, 'POST', '/api/live/youtube/signin/poll', admin.headers);
    expect(r.g.count('/token')).toBe(1);
    expect(existsSync(r.tokenPath)).toBe(false);
  });

  it('success seals the token (no clear refresh token on disk), reads the channel, logs the change without tokens', async () => {
    const r = await rig();
    const { admin } = await signIn(r);
    const bytes = readFileSync(r.tokenPath);
    for (const secret of [FAKE_REFRESH, 'access-token-1', 'UC-surau', 'Surau D\'Waqaf']) expect(bytes.includes(Buffer.from(secret))).toBe(false);
    expect(readFileSync(r.tokenPath, 'utf8').startsWith('v1.')).toBe(true);
    const status = await inject(r, 'GET', '/api/live/youtube/status', admin.headers);
    expect(status.json()).toEqual({ configured: true, signedIn: true, channelTitle: 'Surau D\'Waqaf', lastError: null });
    const log = r.h.app.surau.db.prepare("SELECT actor, entity, entity_id, after_json FROM change_log WHERE entity = 'youtube'").all() as Array<{ entity_id: string; after_json: string }>;
    expect(log).toHaveLength(1);
    expect(log[0]!.entity_id).toBe('signin');
    expect(JSON.parse(log[0]!.after_json)).toEqual({ channelTitle: 'Surau D\'Waqaf' });
    const everything = changeLogText(r.h.app) + r.logs.join('\n') + status.body;
    for (const secret of [FAKE_REFRESH, 'access-token', 'csecret-SECRET', FAKE_DEVICE_CODE]) expect(everything).not.toContain(secret);
    // the polling call asked for the device-code grant with the client secret, over the wire only
    const tok = r.g.calls.find((c) => c.path === '/token')!;
    expect(new URLSearchParams(tok.body).get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
  });

  it('survives a restart; a corrupt or foreign token file reads as signed out and never throws', async () => {
    const r = await rig();
    await signIn(r);
    const again = createYoutubeService({ db: r.h.app.surau.db, dataDir: r.h.dataDir, fetchImpl: r.g.fetchImpl, now: r.h.clock.now });
    expect(again.signedIn()).toBe(true);
    expect(again.info().channelTitle).toBe('Surau D\'Waqaf');
    writeFileSync(r.tokenPath, 'v1.AAAA.BBBB.CCCC');
    expect(createYoutubeService({ db: r.h.app.surau.db, dataDir: r.h.dataDir, fetchImpl: r.g.fetchImpl, now: r.h.clock.now }).signedIn()).toBe(false);
    writeFileSync(r.tokenPath, 'not even sealed');
    expect(new TokenStore(r.h.dataDir).load()).toBeNull();
    expect(r.logs.join('\n')).toContain('token_unreadable');
  });

  it('denied and expired end the attempt without storing anything', async () => {
    const r = await rig();
    const admin = await loginAs(r.h.app, 'admin');
    await inject(r, 'POST', '/api/live/youtube/signin', admin.headers);
    r.h.clock.t += 1_900_000;
    expect((await inject(r, 'POST', '/api/live/youtube/signin/poll', admin.headers)).json()).toMatchObject({ state: 'expired', signedIn: false });
    expect(existsSync(r.tokenPath)).toBe(false);
  });

  it('sign-out clears the file, revokes at Google and logs without tokens', async () => {
    const r = await rig();
    const { admin } = await signIn(r);
    const res = await inject(r, 'POST', '/api/live/youtube/signout', admin.headers);
    expect(res.json()).toEqual({ signedIn: false });
    expect(existsSync(r.tokenPath)).toBe(false);
    expect(r.g.count('/revoke')).toBe(1);
    expect((await inject(r, 'GET', '/api/live/youtube/status', admin.headers)).json()).toMatchObject({ signedIn: false });
    const rows = r.h.app.surau.db.prepare("SELECT entity_id, after_json FROM change_log WHERE entity = 'youtube' ORDER BY id").all() as Array<{ entity_id: string }>;
    expect(rows.map((x) => x.entity_id)).toEqual(['signin', 'signout']);
  });

  it('only the administrator may sign in or out: AJK and Media get 403', async () => {
    const r = await rig();
    for (const role of ['ajk', 'media'] as const) {
      const who = await loginAs(r.h.app, role);
      for (const url of ['/api/live/youtube/signin', '/api/live/youtube/signin/poll', '/api/live/youtube/signout']) {
        expect((await inject(r, 'POST', url, who.headers)).statusCode).toBe(403);
      }
    }
    const admin = await loginAs(r.h.app, 'admin');
    expect((await inject(r, 'POST', '/api/live/youtube/signin', admin.headers)).statusCode).toBe(200);
    // the status is for the people who run the live
    const media = await loginAs(r.h.app, 'media');
    expect((await inject(r, 'GET', '/api/live/youtube/status', media.headers)).statusCode).toBe(200);
    expect((await r.h.app.inject({ method: 'GET', url: '/api/live/youtube/status', remoteAddress: LAN })).statusCode).toBe(401);
  });
});

describe('Google HTTP is guarded', () => {
  it('refuses any host but the two API hosts and plain http, without calling fetch', async () => {
    const spy = vi.fn();
    for (const url of ['https://evil.example/token', 'http://oauth2.googleapis.com/token', 'https://oauth2.googleapis.com.evil.example/x']) {
      await expect(googleRequest(spy as unknown as typeof fetch, url, {}, { timeoutMs: 100 })).rejects.toMatchObject({ reason: 'forbidden' });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('a slow answer times out as network, and an oversized answer is cut off', async () => {
    const r = await rig();
    const svc = createYoutubeService({ db: r.h.app.surau.db, dataDir: r.h.dataDir, fetchImpl: r.g.fetchImpl, now: r.h.clock.now, timeoutMs: 60 });
    r.g.delayMs = 400;
    await expect(svc.begin('test')).rejects.toMatchObject({ reason: 'network' });
    r.g.delayMs = 0;
    r.g.bigBody = 400_000;
    await expect(googleRequest(r.g.fetchImpl, 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: 'Bearer access-token-1' } }, { timeoutMs: 2000 })).rejects.toMatchObject({ reason: 'bad_response' });
  });

  it('a Google failure shows as a short reason, never the raw body', async () => {
    const r = await rig();
    await signIn(r);
    putFeature(r.h.app.surau.db, 'liveYoutube', { enabled: true }, 'test');
    r.g.insertStatus = 403;
    const media = await loginAs(r.h.app, 'media');
    const res = await inject(r, 'POST', '/api/live/start', media.headers, startBody(r.h, { outputs: { kiosk: true, youtube: true } }));
    expect(await warningsOf(r, media.headers)).toEqual(['youtube_quota']);
    const status = await inject(r, 'GET', '/api/live/status', media.headers);
    expect(status.json().youtube).toMatchObject({ state: 'error', lastError: 'quota' });
    expect(status.body).not.toContain('quotaExceeded');
  });
});

describe('broadcast lifecycle from the kuliah', () => {
  it('creates a stream per session, a broadcast with the kuliah text and settings, binds, and the key stays out of everything', async () => {
    const r = await rig();
    await signIn(r);
    putFeature(r.h.app.surau.db, 'liveYoutube', { enabled: true, privacy: 'unlisted' }, 'test');
    const media = await loginAs(r.h.app, 'media');
    const res = await inject(r, 'POST', '/api/live/start', media.headers, startBody(r.h, { outputs: { kiosk: true, youtube: true } }));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.warnings).toBeUndefined();
    expect(body.youtube).toEqual({ via: 'device', ingest: null, key: null, state: 'starting' });
    expect(await ingestOf(r, media.headers)).toEqual({ state: 'ready', ingest: 'rtmps://a.rtmps.youtube.com:443/live2', key: FAKE_STREAM_KEY });

    const streamIns = r.g.calls.filter((c) => c.path === '/youtube/v3/liveStreams' && c.method === 'POST');
    expect(streamIns).toHaveLength(1);
    expect(streamIns[0]!.json).toMatchObject({ cdn: { ingestionType: 'rtmp', resolution: 'variable', frameRate: 'variable' }, contentDetails: { isReusable: false } });
    const ins = r.g.calls.find((c) => c.path === '/youtube/v3/liveBroadcasts' && c.method === 'POST')!;
    expect(ins.json).toMatchObject({
      snippet: { title: 'Kuliah Maghrib: Ustaz Ahmad Fauzi', scheduledStartTime: r.h.clock.now().toISOString() },
      status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false },
      contentDetails: { enableAutoStart: true, enableAutoStop: false, latencyPreference: 'low', monitorStream: { enableMonitorStream: false } },
    });
    expect((ins.json!.snippet as { description: string }).description).toContain('Bab Solat');
    const bind = r.g.calls.find((c) => c.path === '/youtube/v3/liveBroadcasts/bind')!;
    expect(bind.query.get('id')).toBe('bc-1');
    expect(bind.query.get('streamId')).toBe('stream-1');
    expect(ins.headers.authorization).toBe('Bearer access-token-1');

    const status = await inject(r, 'GET', '/api/live/status', media.headers);
    expect(status.json().youtube).toMatchObject({ broadcastId: 'bc-1', watchUrl: 'https://youtu.be/bc-1', state: 'created', signedIn: true });
    const admin = await loginAs(r.h.app, 'admin');
    const health = await inject(r, 'GET', '/api/health', admin.headers);
    await inject(r, 'POST', '/api/live/stop', media.headers, {});
    for (const text of [changeLogText(r.h.app), status.body, health.body, r.logs.join('\n')]) expect(text).not.toContain(FAKE_STREAM_KEY);
    expect(readFileSync(r.tokenPath).includes(Buffer.from(FAKE_STREAM_KEY))).toBe(false);

    // a second session gets its OWN non-reusable stream and key (no permanent key on any phone)
    const again = await inject(r, 'POST', '/api/live/start', media.headers, startBody(r.h, { outputs: { kiosk: true, youtube: true } }));
    expect((await ingestOf(r, media.headers)).key).not.toBe(FAKE_STREAM_KEY);
    expect(r.g.calls.filter((c) => c.path === '/youtube/v3/liveStreams' && c.method === 'POST')).toHaveLength(2);
  });

  it('a kuliah-less live still gets a sensible title', async () => {
    const r = await rig();
    await signIn(r);
    putFeature(r.h.app.surau.db, 'liveYoutube', { enabled: true }, 'test');
    const media = await loginAs(r.h.app, 'media');
    const res = await inject(r, 'POST', '/api/live/start', media.headers, startBody(r.h, { kuliahId: null, outputs: { kiosk: true, youtube: true } }));
    expect(res.statusCode).toBe(200);
    const ins = r.g.calls.find((c) => c.path === '/youtube/v3/liveBroadcasts' && c.method === 'POST')!;
    expect((ins.json!.snippet as { title: string }).title.startsWith('Kuliah')).toBe(true);
  });

  it('stop completes the broadcast and tolerates redundantTransition', async () => {
    const r = await rig();
    await signIn(r);
    putFeature(r.h.app.surau.db, 'liveYoutube', { enabled: true }, 'test');
    const media = await loginAs(r.h.app, 'media');
    await inject(r, 'POST', '/api/live/start', media.headers, startBody(r.h, { outputs: { kiosk: true, youtube: true } }));
    r.g.transitionError = 'redundantTransition';
    const stop = await inject(r, 'POST', '/api/live/stop', media.headers, {});
    expect(stop.json()).toEqual({ stopped: true });
    await r.h.app.liveSessions!.settled();
    const tr = r.g.calls.find((c) => c.path === '/youtube/v3/liveBroadcasts/transition')!;
    expect(tr.query.get('broadcastStatus')).toBe('complete');
    expect(tr.query.get('id')).toBe('bc-1');
    expect((await inject(r, 'GET', '/api/live/status', media.headers)).json().youtube).toMatchObject({ state: 'complete', lastError: null });
  });

  it('the health poll maps streamStatus and healthStatus while live', async () => {
    const r = await rig();
    await signIn(r);
    const svc = createYoutubeService({ db: r.h.app.surau.db, dataDir: r.h.dataDir, fetchImpl: r.g.fetchImpl, now: r.h.clock.now, healthMs: 20 });
    const made = await svc.createBroadcastFor({ sessionId: 's1', meta: { title: 'T', description: 'D', privacy: 'public' } });
    expect(made.key).toBe(FAKE_STREAM_KEY);
    const end = Date.now() + 3000;
    while (svc.status().health === null && Date.now() < end) await new Promise((x) => setTimeout(x, 10));
    expect(svc.status()).toMatchObject({ health: 'good', state: 'live', broadcastId: 'bc-1' });
    await svc.complete(made.broadcastId);
    expect(svc.status().state).toBe('complete');
    svc.shutdown();
  });
});

describe('token refresh', () => {
  it('refreshes 60 s before expiry with the refresh token and uses the new access token', async () => {
    const r = await rig();
    await signIn(r);
    putFeature(r.h.app.surau.db, 'liveYoutube', { enabled: true }, 'test');
    r.h.clock.t += 3600_000 - 30_000;
    const media = await loginAs(r.h.app, 'media');
    await inject(r, 'POST', '/api/live/start', media.headers, startBody(r.h, { outputs: { kiosk: true, youtube: true } }));
    const refresh = r.g.calls.filter((c) => c.path === '/token' && new URLSearchParams(c.body).get('grant_type') === 'refresh_token');
    expect(refresh).toHaveLength(1);
    expect(new URLSearchParams(refresh[0]!.body).get('refresh_token')).toBe(FAKE_REFRESH);
    const ins = r.g.calls.find((c) => c.path === '/youtube/v3/liveBroadcasts' && c.method === 'POST')!;
    expect(ins.headers.authorization).toBe('Bearer access-token-2');
    expect(readFileSync(r.tokenPath).includes(Buffer.from('access-token-2'))).toBe(false);
  });

  it('invalid_grant marks the box for re-authorisation and is never retried', async () => {
    const r = await rig();
    const { admin } = await signIn(r);
    putFeature(r.h.app.surau.db, 'liveYoutube', { enabled: true }, 'test');
    r.h.clock.t += 4000_000;
    r.g.refreshError = 'invalid_grant';
    const media = await loginAs(r.h.app, 'media');
    const first = await inject(r, 'POST', '/api/live/start', media.headers, startBody(r.h, { outputs: { kiosk: true, youtube: true } }));
    void first;
    expect(await warningsOf(r, media.headers)).toEqual(['youtube_reauthorise']);
    await inject(r, 'POST', '/api/live/stop', media.headers, {});
    const second = await inject(r, 'POST', '/api/live/start', media.headers, startBody(r.h, { outputs: { kiosk: true, youtube: true } }));
    expect(second.json().warnings).toEqual(['youtube_not_signed_in']);
    const grants = r.g.calls.filter((c) => c.path === '/token' && new URLSearchParams(c.body).get('grant_type') === 'refresh_token');
    expect(grants).toHaveLength(1);
    expect((await inject(r, 'GET', '/api/live/youtube/status', admin.headers)).json()).toMatchObject({ signedIn: false, lastError: 'reauthorise' });
  });

  it('YoutubeError carries a reason only', () => {
    const e = new YoutubeError('quota', 403, 'quotaExceeded');
    expect(e.message).toBe('quota');
  });
});

describe('the OAuth client file forms', () => {
  async function statusWith(content: string): Promise<{ configured: boolean; body: string }> {
    const r = await rig({ client: false });
    writeFileSync(r.clientPath, content);
    const admin = await loginAs(r.h.app, 'admin');
    const res = await inject(r, 'GET', '/api/live/youtube/status', admin.headers);
    return { configured: (res.json() as { configured: boolean }).configured, body: res.body };
  }
  const ID = 'cid-9.apps.googleusercontent.com';
  const SEC = 'sec-9-SECRET';

  it('accepts the flat form', async () => {
    expect((await statusWith(JSON.stringify({ client_id: ID, client_secret: SEC }))).configured).toBe(true);
  });

  it('accepts the installed wrapper as Google downloads it and ignores other fields', async () => {
    const file = { installed: { client_id: ID, project_id: 'p', auth_uri: 'https://x', client_secret: SEC, redirect_uris: ['http://localhost'] } };
    const s = await statusWith(JSON.stringify(file));
    expect(s.configured).toBe(true);
    expect(s.body).not.toContain(SEC);
  });

  it('accepts the web wrapper', async () => {
    expect((await statusWith(JSON.stringify({ web: { client_id: ID, client_secret: SEC } }))).configured).toBe(true);
  });

  it('refuses garbage, empty and non-string values', async () => {
    for (const bad of [
      'not json',
      '[]',
      '{}',
      JSON.stringify({ installed: {} }),
      JSON.stringify({ installed: { client_id: '', client_secret: SEC } }),
      JSON.stringify({ installed: { client_id: ID, client_secret: 5 } }),
      JSON.stringify({ web: 'x' }),
      JSON.stringify({ client_id: 1, client_secret: SEC }),
    ]) {
      expect((await statusWith(bad)).configured).toBe(false);
    }
  });
});

describe('A4/A5: broadcasts are never orphaned and phones never get a permanent key', () => {
  const ytBody = (r: Rig) => startBody(r.h, { outputs: { kiosk: true, youtube: true } });
  async function ready(r: Rig) {
    await signIn(r);
    putFeature(r.h.app.surau.db, 'liveYoutube', { enabled: true }, 'test');
    return loginAs(r.h.app, 'media');
  }
  const deletes = (r: Rig, path: string) => r.g.calls.filter((c) => c.method === 'DELETE' && c.path === `/youtube/v3/${path}`);

  it('A4a: a failed bind deletes the new broadcast and its stream', async () => {
    const r = await rig();
    const media = await ready(r);
    r.g.bindStatus = 500;
    const res = await inject(r, 'POST', '/api/live/start', media.headers, ytBody(r));
    expect(res.statusCode).toBe(200);
    expect(await warningsOf(r, media.headers)).toEqual(['no_internet']);
    expect(deletes(r, 'liveBroadcasts')).toHaveLength(1);
    expect(r.g.broadcasts.size).toBe(0);
    expect(r.g.streams.size).toBe(0);
  });

  it('A4b: a broadcast that never went live is deleted at teardown, a live one is completed', async () => {
    const r = await rig();
    const media = await ready(r);
    r.g.lifeCycle = 'ready';
    await inject(r, 'POST', '/api/live/start', media.headers, ytBody(r));
    await inject(r, 'POST', '/api/live/stop', media.headers, {});
    await r.h.app.liveSessions!.settled();
    expect(r.g.count('/youtube/v3/liveBroadcasts/transition')).toBe(0);
    expect(deletes(r, 'liveBroadcasts')).toHaveLength(1);
    expect(r.g.broadcasts.size).toBe(0);

    r.g.lifeCycle = 'live';
    await inject(r, 'POST', '/api/live/start', media.headers, ytBody(r));
    await inject(r, 'POST', '/api/live/stop', media.headers, {});
    await r.h.app.liveSessions!.settled();
    expect(r.g.count('/youtube/v3/liveBroadcasts/transition')).toBe(1);
    expect(deletes(r, 'liveBroadcasts')).toHaveLength(1);
  });

  it('A4c: sign-out is refused with 409 live_busy while a session is open', async () => {
    const r = await rig();
    const media = await ready(r);
    const admin = await loginAs(r.h.app, 'admin');
    await inject(r, 'POST', '/api/live/start', media.headers, ytBody(r));
    const refused = await inject(r, 'POST', '/api/live/youtube/signout', admin.headers);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('live_busy');
    expect(existsSync(r.tokenPath)).toBe(true);
    await inject(r, 'POST', '/api/live/stop', media.headers, {});
    await r.h.app.liveSessions!.settled();
    expect((await inject(r, 'POST', '/api/live/youtube/signout', admin.headers)).statusCode).toBe(200);
  });

  it('A4d: the open broadcast is written down (ids only) and ended at the next box start', async () => {
    const r = await rig();
    const media = await ready(r);
    await inject(r, 'POST', '/api/live/start', media.headers, ytBody(r));
    const file = join(r.h.dataDir, 'live', 'youtube-open.json');
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, 'utf8');
    const open = Object.values(JSON.parse(text).broadcasts as Record<string, Record<string, string>>);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ broadcastId: 'bc-1', streamId: 'stream-1' });
    expect(Object.keys(open[0]!).sort()).toEqual(['broadcastId', 'createdAt', 'seenAt', 'streamId']);
    expect(text).not.toContain(FAKE_STREAM_KEY);

    // the box died without a teardown; a new service (the next start) recovers it
    for (const lifeCycle of ['ready', 'live']) {
      r.g.lifeCycle = lifeCycle;
      r.g.broadcasts.add('bc-1');
      const before = r.g.count('/youtube/v3/liveBroadcasts/transition');
      writeFileSync(file, text);
      const svc = createYoutubeService({ db: r.h.app.surau.db, dataDir: r.h.dataDir, fetchImpl: r.g.fetchImpl, now: r.h.clock.now });
      await svc.recover();
      svc.shutdown();
      expect(existsSync(file)).toBe(false);
      expect(r.g.count('/youtube/v3/liveBroadcasts/transition') - before).toBe(lifeCycle === 'live' ? 1 : 0);
    }
    expect(deletes(r, 'liveBroadcasts').length).toBeGreaterThanOrEqual(1);
    expect(deletes(r, 'liveStreams').length).toBeGreaterThanOrEqual(1);
  });

  it('A5: each session gets its own non-reusable stream and key; teardown deletes the stream', async () => {
    const r = await rig();
    const media = await ready(r);
    const one = await inject(r, 'POST', '/api/live/start', media.headers, ytBody(r));
    void one;
    const key1 = (await ingestOf(r, media.headers)).key as string;
    expect(r.g.streams.get('stream-1')?.reusable).toBe(false);
    await inject(r, 'POST', '/api/live/stop', media.headers, {});
    await r.h.app.liveSessions!.settled();
    expect(r.g.streams.has('stream-1')).toBe(false);
    const two = await inject(r, 'POST', '/api/live/start', media.headers, ytBody(r));
    void two;
    const key2 = (await ingestOf(r, media.headers)).key as string;
    expect(key2).not.toBe(key1);
    expect(r.g.streams.has('stream-2')).toBe(true);
    expect(r.g.streams.get('stream-2')?.reusable).toBe(false);
    const binds = r.g.calls.filter((c) => c.path === '/youtube/v3/liveBroadcasts/bind').map((c) => c.query.get('streamId'));
    expect(binds).toEqual(['stream-1', 'stream-2']);
  });
});
