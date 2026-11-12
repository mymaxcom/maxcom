import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { klInstant } from '@surau/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteYoutubeLeg } from '../src/sync/youtubeRemote.ts';
import { putFeature } from '../src/settingsStore.ts';
import { generateSyncKeyPair, saveSyncKey } from '../src/sync/syncKey.ts';
import { loginAs } from './authHelpers.ts';
import { buildCloud, CLOUD_URL } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FAKE_STREAM_KEY, startFakeGoogle } from './support/fakeGoogle.ts';
import type { FakeGoogle } from './support/fakeGoogle.ts';
import { withUploadApi } from './support/fakeGoogleUpload.ts';
import { changeLogText, startBody, startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';
import { insertSite } from './support/sites.ts';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0)) await c();
});

interface Rig {
  h: LiveHarness;
  cloud: TestCloud;
  g: FakeGoogle;
  /** The fetch the box uses for the cloud; swap `impl` to break the link. */
  hook: { impl: typeof fetch };
  logs: string[];
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A box (live harness) linked to an in-process cloud whose YouTube is signed in against the fake Google. */
async function rig(o: { cloudSignedIn?: boolean; linked?: boolean } = {}): Promise<Rig> {
  const g = await startFakeGoogle();
  const up = withUploadApi(g);
  const clock = { t: klInstant('2026-11-05', '19:00').getTime(), now: (): Date => new Date(clock.t) };
  const cloud = buildCloud('boxid0001', { now: clock.now, fetchImpl: up.fetchImpl });
  const hook = { impl: cloud.fetch };
  const h = await startLiveHarness({
    app: { cloud: { url: CLOUD_URL }, sync: { auto: false, youtubeWaitMs: 0, fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => hook.impl(i, n)) as typeof fetch } },
  });
  closers.push(h.close, cloud.close, g.close);

  mkdirSync(join(cloud.dir, 'secret'), { recursive: true });
  writeFileSync(join(cloud.dir, 'secret', 'youtube-client.json'), JSON.stringify({ client_id: 'cid-123.apps.googleusercontent.com', client_secret: 'csecret-SECRET' }));
  if (o.cloudSignedIn !== false) {
    const admin = await loginAs(cloud.app, 'admin');
    await cloud.app.inject({ method: 'POST', url: '/api/live/youtube/signin', headers: admin.headers });
    g.approve = true;
    clock.t += 6000;
    const done = await cloud.app.inject({ method: 'POST', url: '/api/live/youtube/signin/poll', headers: admin.headers });
    expect(done.json()).toMatchObject({ signedIn: true });
  }
  if (o.linked !== false) {
    const site = insertSite(cloud.app.surau.db, { boxId: h.app.surau.boxId });
    const keys = generateSyncKeyPair();
    saveSyncKey(h.dataDir, { ...keys, cloudUrl: CLOUD_URL, siteToken: site.token, wakeSecret: 'wake-secret-1', linkedAt: '2026-11-05T00:00:00.000Z' });
  }
  putFeature(h.app.surau.db, 'liveYoutube', { enabled: true, privacy: 'unlisted' }, 'test');
  const logs: string[] = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
  }
  return { h, cloud, g, hook, logs };
}

/** The YouTube leg is made after the start answer: waits until the phone's ingest is no longer `starting`. */
async function ytSettled(app: Rig['h']['app'], headers: Record<string, string>): Promise<{ state: string; ingest: string | null; key: string | null }> {
  for (let i = 0; i < 400; i++) {
    const g = (await app.inject({ method: 'GET', url: '/api/live/youtube/ingest', headers, remoteAddress: '10.168.1.40' })).json();
    if (g.state !== 'starting') return g;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('the YouTube leg never settled');
}

const start = (r: Rig, headers: Record<string, string>) =>
  r.h.app.inject({ method: 'POST', url: '/api/live/start', headers, payload: startBody(r.h, { outputs: { kiosk: true, youtube: true } }), remoteAddress: '10.168.1.40' });

function everythingOnTheBox(r: Rig): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.json') || e.name.endsWith('.ini') || e.name.endsWith('.log')) files.push(readFileSync(p, 'utf8'));
    }
  };
  walk(r.h.dataDir);
  return [
    changeLogText(r.h.app),
    JSON.stringify(r.h.app.surau.db.prepare('SELECT * FROM sync_state').all()),
    JSON.stringify(r.h.app.surau.db.prepare('SELECT * FROM auth_log').all()),
    r.logs.join('\n'),
    ...files,
  ].join('\n');
}

describe('the box leg over the cloud', () => {
  it('a live start creates the broadcast on the cloud; the key is in the start answer and nowhere on the box', async () => {
    const r = await rig();
    const media = await loginAs(r.h.app, 'media');
    const res = await start(r, media.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.warnings).toBeUndefined();
    expect(body.youtube).toEqual({ via: 'device', ingest: null, key: null, state: 'starting' });
    expect(await ytSettled(r.h.app, media.headers)).toEqual({ state: 'ready', ingest: 'rtmps://a.rtmps.youtube.com:443/live2', key: FAKE_STREAM_KEY });
    expect(r.h.app.liveSessions!.status().warnings).toEqual([]);
    // Google was reached by the cloud only, with the kuliah's text
    const ins = r.g.calls.find((c) => c.path === '/youtube/v3/liveBroadcasts' && c.method === 'POST')!;
    expect((ins.json!.snippet as { title: string }).title).toBe('Kuliah Maghrib: Ustaz Ahmad Fauzi');
    expect(r.cloud.app.surau.db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'youtube/broadcast'").get()!.n).toBe(1);
    // the stream key never reached a box table, file or log (and not the status the app polls)
    const status = await r.h.app.inject({ method: 'GET', url: '/api/live/status', headers: media.headers, remoteAddress: '10.168.1.40' });
    expect(everythingOnTheBox(r)).not.toContain(FAKE_STREAM_KEY);
    expect(status.body).not.toContain(FAKE_STREAM_KEY);
    expect(r.logs.join('\n')).not.toContain(FAKE_STREAM_KEY);
    expect(everythingOnTheBox(r)).not.toContain('wake-secret-1');
  });

  it('the Live status follows the cloud: broadcast id, watch address, signed-in', async () => {
    const r = await rig();
    const media = await loginAs(r.h.app, 'media');
    await start(r, media.headers);
    await ytSettled(r.h.app, media.headers);
    const read = async () => (await r.h.app.inject({ method: 'GET', url: '/api/live/status', headers: media.headers, remoteAddress: '10.168.1.40' })).json().youtube;
    // the first read asks the cloud in the background; the next ones carry its answer
    let y = await read();
    for (let i = 0; i < 100 && y.channelTitle === null; i++) {
      await new Promise((res) => setTimeout(res, 20));
      y = await read();
    }
    expect(y).toMatchObject({ signedIn: true, broadcastId: 'bc-1', watchUrl: 'https://youtu.be/bc-1', channelTitle: 'Surau D\'Waqaf' });
  });

  it('stop reaches the cloud, which completes the broadcast', async () => {
    const r = await rig();
    const media = await loginAs(r.h.app, 'media');
    await start(r, media.headers);
    await ytSettled(r.h.app, media.headers);
    const stop = await r.h.app.inject({ method: 'POST', url: '/api/live/stop', headers: media.headers, payload: {}, remoteAddress: '10.168.1.40' });
    expect(stop.json()).toEqual({ stopped: true });
    await r.h.app.liveSessions!.settled();
    const tr = r.g.calls.find((c) => c.path === '/youtube/v3/liveBroadcasts/transition')!;
    expect(tr.query.get('broadcastStatus')).toBe('complete');
    expect(tr.query.get('id')).toBe('bc-1');
  });

  it('cloud down: the start succeeds with cloud_unreachable and youtube null, the kiosk leg is untouched', async () => {
    const r = await rig();
    r.hook.impl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const media = await loginAs(r.h.app, 'media');
    const t0 = Date.now();
    const res = await start(r, media.headers);
    expect(res.statusCode).toBe(200);
    expect(Date.now() - t0).toBeLessThan(6500);
    const body = res.json();
    expect(body.youtube).toMatchObject({ state: 'starting' });
    expect((await ytSettled(r.h.app, media.headers)).state).toBe('failed');
    expect(r.h.app.liveSessions!.status().warnings).toEqual(['cloud_unreachable']);
    expect(body.session).toMatchObject({ outputs: { kiosk: true, youtube: true } });
    expect(r.g.calls.some((c) => c.path === '/youtube/v3/liveBroadcasts')).toBe(false);
    // the app sees why
    const read = async () => (await r.h.app.inject({ method: 'GET', url: '/api/live/status', headers: media.headers, remoteAddress: '10.168.1.40' })).json();
    let st = await read();
    for (let i = 0; i < 100 && st.youtube.lastError !== 'cloud_unreachable'; i++) {
      await new Promise((res) => setTimeout(res, 20));
      st = await read();
    }
    expect(st.youtube).toMatchObject({ signedIn: false, lastError: 'cloud_unreachable' });
    expect(st.session).not.toBeNull();
  });

  it('a hanging cloud is cut off after the 6 s timeout, not longer', async () => {
    const r = await rig();
    r.hook.impl = ((_i: Parameters<typeof fetch>[0], n?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        n?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'TimeoutError')));
      })) as typeof fetch;
    const leg = new RemoteYoutubeLeg({ db: r.h.app.surau.db, dataDir: r.h.dataDir, now: () => new Date(), fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => r.hook.impl(i, n)) as typeof fetch, timeoutMs: 80, waitBudgetMs: 0 });
    const t0 = Date.now();
    await expect(leg.createBroadcastFor({ sessionId: 's', meta: { title: 't', description: '', privacy: 'unlisted' } })).rejects.toMatchObject({ reason: 'cloud_unreachable' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('the cloud signed out: the start carries youtube_reauthorise', async () => {
    const r = await rig({ cloudSignedIn: false });
    const media = await loginAs(r.h.app, 'media');
    const res = await start(r, media.headers);
    expect(res.statusCode).toBe(200);
    expect((await ytSettled(r.h.app, media.headers)).state).toBe('failed');
    expect(r.h.app.liveSessions!.status().warnings).toEqual(['youtube_reauthorise']);
  });

  it('a revoked site key counts as unreachable, never as a crash', async () => {
    const r = await rig();
    r.cloud.app.surau.db.prepare('UPDATE sites SET revoked_at = ?').run('2026-11-05T00:00:00.000Z');
    const media = await loginAs(r.h.app, 'media');
    const res = await start(r, media.headers);
    expect(res.statusCode).toBe(200);
    await ytSettled(r.h.app, media.headers);
    expect(r.h.app.liveSessions!.status().warnings).toEqual(['cloud_unreachable']);
  });

  it('cloudSync switched off, or a box never linked: the local service is used and the cloud is not asked', async () => {
    const off = await rig();
    putFeature(off.h.app.surau.db, 'cloudSync', { enabled: false }, 'test');
    const m1 = await loginAs(off.h.app, 'media');
    const r1 = await start(off, m1.headers);
    expect(r1.json().warnings).toEqual(['youtube_not_signed_in']);
    expect(off.g.calls.some((c) => c.path === '/youtube/v3/liveBroadcasts')).toBe(false);

    const unlinked = await rig({ linked: false });
    const m2 = await loginAs(unlinked.h.app, 'media');
    const r2 = await start(unlinked, m2.headers);
    expect(r2.json().warnings).toEqual(['youtube_not_signed_in']);
    expect(unlinked.g.calls.some((c) => c.path === '/youtube/v3/liveBroadcasts')).toBe(false);
  });
});

describe('the remote leg on its own', () => {
  it('a complete that fails is retried and reaches the cloud when it is back', async () => {
    const r = await rig();
    const db = r.h.app.surau.db;
    const media = await loginAs(r.h.app, 'media');
    await start(r, media.headers);
    const leg = new RemoteYoutubeLeg({ db, dataDir: r.h.dataDir, now: () => new Date(), fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => r.hook.impl(i, n)) as typeof fetch, retryMs: [20, 20, 20] });
    const good = r.hook.impl;
    r.hook.impl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(leg.complete('bc-1')).rejects.toMatchObject({ reason: 'cloud_unreachable' });
    expect(r.g.calls.some((c) => c.path === '/youtube/v3/liveBroadcasts/transition')).toBe(false);
    r.hook.impl = good;
    await until(() => r.g.calls.some((c) => c.path === '/youtube/v3/liveBroadcasts/transition'));
    leg.stop();
  });

  it('refuses a key or address that is not what the cloud promised (no half-trusted answers)', async () => {
    const r = await rig();
    r.hook.impl = (async () => new Response(JSON.stringify({ broadcastId: 5, watchUrl: {}, key: null }), { status: 200 })) as typeof fetch;
    const leg = new RemoteYoutubeLeg({ db: r.h.app.surau.db, dataDir: r.h.dataDir, now: () => new Date(), fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => r.hook.impl(i, n)) as typeof fetch });
    await expect(leg.createBroadcastFor({ sessionId: 's', meta: { title: 't', description: '', privacy: 'unlisted' } })).rejects.toBeTruthy();
  });
});
