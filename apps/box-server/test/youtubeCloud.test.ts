import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { klInstant } from '@surau/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { putItem } from '../src/content/store.ts';
import { createYoutubeService } from '../src/live/youtube/api.ts';
import { putFeature } from '../src/settingsStore.ts';
import { pacificWindow } from '../src/sync/youtubeCloud.ts';
import { loginAs } from './authHelpers.ts';
import { startFakeGoogle } from './support/fakeGoogle.ts';
import type { FakeGoogle } from './support/fakeGoogle.ts';
import { FAKE_UPLOAD_ID, withUploadApi } from './support/fakeGoogleUpload.ts';
import type { GoogleUploadFake } from './support/fakeGoogleUpload.ts';
import { buildCloud } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { insertSite } from './support/sites.ts';
import type { TestSite } from './support/sites.ts';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0)) await c();
});

interface Rig {
  cloud: TestCloud;
  app: FastifyInstance;
  g: FakeGoogle;
  up: GoogleUploadFake;
  clock: { t: number; now: () => Date };
  site: TestSite;
  kuliahId: string;
  logs: string[];
}

async function rig(o: { signedIn?: boolean; wrap?: (f: typeof fetch) => typeof fetch } = {}): Promise<Rig> {
  const g = await startFakeGoogle();
  const up = withUploadApi(g);
  const clock = { t: klInstant('2026-11-05', '19:00').getTime(), now: (): Date => new Date(clock.t) };
  up.snippet = () => ({ publishedAt: new Date(clock.t + 1000).toISOString(), channelId: 'UC-surau' });
  const cloud = buildCloud('boxid0001', { now: clock.now, fetchImpl: o.wrap ? o.wrap(up.fetchImpl) : up.fetchImpl });
  closers.push(cloud.close, g.close);
  const app = cloud.app;
  mkdirSync(join(cloud.dir, 'secret'), { recursive: true });
  writeFileSync(join(cloud.dir, 'secret', 'youtube-client.json'), JSON.stringify({ client_id: 'cid-123.apps.googleusercontent.com', client_secret: 'csecret-SECRET' }));
  const logs: string[] = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
  }
  if (o.signedIn !== false) {
    const admin = await loginAs(app, 'admin');
    expect((await app.inject({ method: 'POST', url: '/api/live/youtube/signin', headers: admin.headers })).statusCode).toBe(200);
    g.approve = true;
    clock.t += 6000;
    const done = await app.inject({ method: 'POST', url: '/api/live/youtube/signin/poll', headers: admin.headers });
    expect(done.json()).toMatchObject({ state: 'signed_in', signedIn: true });
  }
  const { db } = app.surau;
  const pen = putItem(db, 'penceramah', { name: 'Ustaz Ahmad Fauzi' }, 'test');
  const kuliah = putItem(
    db,
    'kuliah',
    { date: '2026-11-05', slot: 'maghrib', time: '19:15', label: 'Kuliah Maghrib', penceramahId: pen.item.id, topic: 'Bab Solat', status: 'aktif' },
    'test',
  );
  return { cloud, app, g, up, clock, site: insertSite(db, { boxId: 'boxid0001' }), kuliahId: kuliah.item.id, logs };
}

const post = (r: Rig, url: string, headers: Record<string, string>, payload: object = {}) =>
  r.app.inject({ method: 'POST', url, headers, payload });
const begin = (r: Rig, headers: Record<string, string>, over: Record<string, unknown> = {}) =>
  post(r, '/api/youtube/upload/begin', headers, { kuliahId: r.kuliahId, part: null, bytes: 123_456_789, replaceLiveVideoId: null, ...over });

/** Everything that could carry a secret: change history, uploads rows, the console. */
function leakText(r: Rig): string {
  const { db } = r.app.surau;
  return JSON.stringify([db.prepare('SELECT * FROM change_log').all(), db.prepare('SELECT * FROM uploads').all(), db.prepare('SELECT * FROM auth_log').all()]) + r.logs.join('\n');
}

describe('upload sessions for the catch-up', () => {
  it('begin as Media opens a resumable session with the kuliah title and the privacy from settings', async () => {
    const r = await rig();
    putFeature(r.app.surau.db, 'liveYoutube', { enabled: true, privacy: 'private' }, 'test');
    const media = await loginAs(r.app, 'media');
    const res = await begin(r, media.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.uploadUri).toBe(`https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=${FAKE_UPLOAD_ID}`);
    expect(body.title).toBe('Kuliah Maghrib: Ustaz Ahmad Fauzi');
    expect(typeof body.uploadId).toBe('string');
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(r.clock.t);
    expect(res.headers['cache-control']).toBe('no-store');

    expect(r.up.sessions).toHaveLength(1);
    const s = r.up.sessions[0]!;
    expect(s.query.get('uploadType')).toBe('resumable');
    expect(s.query.get('part')).toBe('snippet,status');
    expect(s.headers['x-upload-content-type']).toBe('video/mp4');
    expect(s.headers.authorization).toMatch(/^Bearer access-token-/);
    expect(s.json).toMatchObject({
      snippet: { title: 'Kuliah Maghrib: Ustaz Ahmad Fauzi' },
      status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
    });
    expect((s.json!.snippet as { description: string }).description).toContain('Bab Solat');

    // bookkeeping without the URI, and no token or upload id anywhere
    const row = r.app.surau.db.prepare('SELECT * FROM uploads WHERE id = ?').get(body.uploadId)!;
    expect(row).toMatchObject({ state: 'open', kuliah_id: r.kuliahId, device_id: media.deviceId, bytes: 123_456_789 });
    const log = r.app.surau.db.prepare("SELECT * FROM change_log WHERE entity = 'youtube/upload'").get()!;
    expect(JSON.parse(String(log.after_json))).toEqual({ uploadId: body.uploadId, kuliahId: r.kuliahId, deviceId: media.deviceId, bytes: 123_456_789 });
    const text = leakText(r);
    expect(text).not.toContain(FAKE_UPLOAD_ID);
    expect(text).not.toContain('upload_id');
    expect(text).not.toContain('access-token');
    expect(text).not.toContain('refresh-token');
  });

  it('a part appends the Bahagian suffix and stays within 100 characters', async () => {
    const r = await rig();
    const media = await loginAs(r.app, 'media');
    const res = await begin(r, media.headers, { part: { index: 2, count: 4 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe('Kuliah Maghrib: Ustaz Ahmad Fauzi (Bahagian 2 daripada 4)');
    expect((r.up.sessions[0]!.json!.snippet as { title: string }).title).toBe('Kuliah Maghrib: Ustaz Ahmad Fauzi (Bahagian 2 daripada 4)');

    const longName = 'Ustaz ' + 'X'.repeat(90);
    const pen = putItem(r.app.surau.db, 'penceramah', { name: longName }, 'test');
    const k2 = putItem(r.app.surau.db, 'kuliah', { date: '2026-11-05', slot: 'maghrib', time: '19:15', label: 'Kuliah', penceramahId: pen.item.id, topic: 'T', status: 'aktif' }, 'test');
    const long = await begin(r, media.headers, { kuliahId: k2.item.id, part: { index: 1, count: 3 } });
    expect(long.statusCode).toBe(200);
    expect(Array.from(long.json().title as string).length).toBeLessThanOrEqual(100);
    expect(long.json().title.endsWith(' (Bahagian 1 daripada 3)')).toBe(true);
  });

  it('a kuliah-less upload gets a sensible title; an unknown kuliah is 404; bad bodies are 400', async () => {
    const r = await rig();
    const media = await loginAs(r.app, 'media');
    const none = await begin(r, media.headers, { kuliahId: null });
    expect(none.statusCode).toBe(200);
    expect(String(none.json().title).startsWith('Kuliah')).toBe(true);
    expect((await begin(r, media.headers, { kuliahId: 'nope' })).statusCode).toBe(404);
    for (const bad of [{ bytes: 0 }, { bytes: -5 }, { bytes: 'x' }, { part: { index: 0, count: 2 } }, { part: { index: 3, count: 2 } }, { part: 'x' }, { replaceLiveVideoId: 5 }, { kuliahId: 7 }]) {
      expect((await begin(r, media.headers, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await post(r, '/api/youtube/upload/begin', media.headers, {})).statusCode).toBe(400);
  });

  it('AJK is 403; a site token is 403 on begin and 200 on the status route; a user session cannot use the site routes', async () => {
    const r = await rig();
    const ajk = await loginAs(r.app, 'ajk');
    expect((await begin(r, ajk.headers)).statusCode).toBe(403);
    expect((await begin(r, r.site.headers)).statusCode).toBe(403);
    expect((await r.app.inject({ method: 'GET', url: '/api/youtube/quota', headers: r.site.headers })).statusCode).toBe(403);
    const st = await r.app.inject({ method: 'GET', url: '/api/cloud/youtube/status', headers: r.site.headers });
    expect(st.statusCode).toBe(200);
    expect(st.json()).toMatchObject({ signedIn: true, channelTitle: 'Surau D\'Waqaf' });
    // a device session is not a site: the route does not exist for it
    const admin = await loginAs(r.app, 'admin');
    for (const [m, u] of [['GET', '/api/cloud/youtube/status'], ['POST', '/api/cloud/youtube/broadcast'], ['POST', '/api/cloud/youtube/complete']] as const) {
      const res = await r.app.inject({ method: m, url: u, headers: admin.headers, ...(m === 'POST' ? { payload: {} } : {}) });
      expect(res.statusCode, u).toBe(404);
    }
    // anonymous
    expect((await r.app.inject({ method: 'GET', url: '/api/cloud/youtube/status', remoteAddress: '10.168.1.77' })).statusCode).toBe(401);
    expect(r.up.sessions).toHaveLength(0);
  });

  it('the catch-up feature switched off answers 409 and calls nothing', async () => {
    const r = await rig();
    putFeature(r.app.surau.db, 'youtubeCatchUp', { enabled: false }, 'test');
    const media = await loginAs(r.app, 'media');
    const res = await begin(r, media.headers);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('catchup_off');
    expect(r.up.sessions).toHaveLength(0);
  });

  it('signed out on the cloud is 503 youtube_reauthorise', async () => {
    const r = await rig({ signedIn: false });
    const media = await loginAs(r.app, 'media');
    const res = await begin(r, media.headers);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('youtube_reauthorise');
    expect(r.up.sessions).toHaveLength(0);
  });

  it('quotaExceeded and uploadLimitExceeded become 429 youtube_quota with a future ISO resetsAt', async () => {
    for (const keyword of ['quotaExceeded', 'uploadLimitExceeded']) {
      const r = await rig();
      const media = await loginAs(r.app, 'media');
      r.up.sessionError = keyword;
      const res = await begin(r, media.headers);
      expect(res.statusCode, keyword).toBe(429);
      expect(res.json().code).toBe('youtube_quota');
      const at = new Date(res.json().resetsAt as string);
      expect(at.toISOString()).toBe(res.json().resetsAt);
      expect(at.getTime()).toBeGreaterThan(r.clock.t);
      // a failed begin leaves no row behind
      expect(r.app.surau.db.prepare('SELECT COUNT(*) AS n FROM uploads').get()!.n).toBe(0);
      expect(res.body).not.toContain('access-token');
      await closers.splice(0).reduce((p, c) => p.then(c), Promise.resolve());
    }
  });

  it('a Location that is not a Google upload address is refused', async () => {
    const r = await rig({
      wrap: (f) =>
        (async (i: Parameters<typeof fetch>[0], n?: RequestInit) => {
          const u = new URL(typeof i === 'string' ? i : i instanceof URL ? i.href : i.url);
          if (u.pathname === '/upload/youtube/v3/videos') return new Response('{}', { status: 200, headers: { Location: 'https://evil.example/steal' } });
          return f(i, n);
        }) as typeof fetch,
    });
    const media = await loginAs(r.app, 'media');
    const res = await begin(r, media.headers);
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('evil.example');
    expect(r.app.surau.db.prepare('SELECT COUNT(*) AS n FROM uploads').get()!.n).toBe(0);
  });
});

describe('done, set-private and the quota counter', () => {
  async function liveVideo(r: Rig): Promise<string> {
    const res = await post(r, '/api/cloud/youtube/broadcast', r.site.headers, {
      sessionId: 'sess1',
      meta: { title: 'Kuliah Maghrib: Ustaz Ahmad Fauzi', description: 'Bab Solat', privacy: 'unlisted' },
    });
    expect(res.statusCode).toBe(200);
    return res.json().broadcastId as string;
  }

  it('done with replaceLiveVideoId sets the live video private exactly once, even when done is repeated', async () => {
    const r = await rig();
    const live = await liveVideo(r);
    const media = await loginAs(r.app, 'media');
    const b = await begin(r, media.headers, { replaceLiveVideoId: live });
    expect(b.statusCode).toBe(200);
    const done = await post(r, '/api/youtube/upload/done', media.headers, { uploadId: b.json().uploadId, videoId: 'NEWvideo123' });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ uploadId: b.json().uploadId, state: 'done', replaced: true });
    expect(r.up.updates).toHaveLength(1);
    const u = r.up.updates[0]!;
    expect(u.query.get('part')).toBe('status');
    expect(u.json).toMatchObject({ id: live, status: { privacyStatus: 'private' } });
    // the video is never deleted
    expect(r.g.calls.some((c) => c.method === 'DELETE' && c.path === '/youtube/v3/videos')).toBe(false);
    const row = r.app.surau.db.prepare('SELECT * FROM uploads WHERE id = ?').get(b.json().uploadId)!;
    expect(row).toMatchObject({ state: 'done', video_id: 'NEWvideo123' });
    expect(r.app.surau.db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'youtube/replaceLive'").get()!.n).toBe(1);

    const again = await post(r, '/api/youtube/upload/done', media.headers, { uploadId: b.json().uploadId, videoId: 'NEWvideo123' });
    expect(again.statusCode).toBe(200);
    expect(r.up.updates).toHaveLength(1);
  });

  it('a failed set-private does not fail done and is retried by a repeated done', async () => {
    const r = await rig();
    const live = await liveVideo(r);
    const media = await loginAs(r.app, 'media');
    const b = await begin(r, media.headers, { replaceLiveVideoId: live });
    r.up.updateStatus = 500;
    const done = await post(r, '/api/youtube/upload/done', media.headers, { uploadId: b.json().uploadId, videoId: 'NEWvideo123' });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ state: 'done', replaced: false });
    r.up.updateStatus = 200;
    const retry = await post(r, '/api/youtube/upload/done', media.headers, { uploadId: b.json().uploadId, videoId: 'NEWvideo123' });
    expect(retry.json()).toMatchObject({ replaced: true });
    expect(r.up.updates.filter((x) => x.json && (x.json.status as { privacyStatus: string }).privacyStatus === 'private')).toHaveLength(2);
  });

  it('only a video the cloud itself broadcast can be replaced', async () => {
    const r = await rig();
    const media = await loginAs(r.app, 'media');
    const res = await begin(r, media.headers, { replaceLiveVideoId: 'someOtherVid1' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('unknown_live_video');
    expect(r.up.sessions).toHaveLength(0);
  });

  it('done is checked: unknown id, other device, bad video id, conflicting video id', async () => {
    const r = await rig();
    const media = await loginAs(r.app, 'media');
    const other = await loginAs(r.app, 'media');
    const b = await begin(r, media.headers);
    const id = b.json().uploadId as string;
    expect((await post(r, '/api/youtube/upload/done', media.headers, { uploadId: 'nope', videoId: 'NEWvideo123' })).statusCode).toBe(404);
    expect((await post(r, '/api/youtube/upload/done', other.headers, { uploadId: id, videoId: 'NEWvideo123' })).statusCode).toBe(404);
    for (const videoId of ['', 'a b', 'x'.repeat(40), 5]) {
      expect((await post(r, '/api/youtube/upload/done', media.headers, { uploadId: id, videoId })).statusCode, String(videoId)).toBe(400);
    }
    expect((await post(r, '/api/youtube/upload/done', media.headers, { uploadId: id, videoId: 'NEWvideo123' })).statusCode).toBe(200);
    expect((await post(r, '/api/youtube/upload/done', media.headers, { uploadId: id, videoId: 'OTHERvideo99' })).statusCode).toBe(409);
    expect(r.up.updates).toHaveLength(0);
  });

  it('quota counts only the rows since the last midnight Pacific', async () => {
    const r = await rig();
    const { db } = r.app.surau;
    const media = await loginAs(r.app, 'media');
    // clock: 2026-11-05 11:00 UTC = 03:00 PST; the window opened 2026-11-05T08:00:00Z
    const ins = db.prepare("INSERT INTO uploads (id, device_id, state, created_at) VALUES (?, 'd', 'done', ?)");
    ins.run('old1', '2026-11-05T07:59:00.000Z');
    ins.run('old2', '2026-11-04T12:00:00.000Z');
    ins.run('today1', '2026-11-05T08:01:00.000Z');
    ins.run('today2', '2026-11-05T10:00:00.000Z');
    const q = await r.app.inject({ method: 'GET', url: '/api/youtube/quota', headers: media.headers });
    expect(q.statusCode).toBe(200);
    expect(q.json()).toEqual({ uploadsToday: 2, uploadLimit: 100, resetsAt: '2026-11-06T08:00:00.000Z' });
    await begin(r, media.headers);
    expect((await r.app.inject({ method: 'GET', url: '/api/youtube/quota', headers: media.headers })).json().uploadsToday).toBe(3);
  });

  it('the Pacific window follows daylight saving', () => {
    expect(pacificWindow(new Date('2026-07-01T12:00:00.000Z'))).toEqual({ since: '2026-07-01T07:00:00.000Z', resetsAt: '2026-07-02T07:00:00.000Z' });
    expect(pacificWindow(new Date('2026-07-01T06:59:00.000Z'))).toEqual({ since: '2026-06-30T07:00:00.000Z', resetsAt: '2026-07-01T07:00:00.000Z' });
    expect(pacificWindow(new Date('2026-11-05T11:00:00.000Z'))).toEqual({ since: '2026-11-05T08:00:00.000Z', resetsAt: '2026-11-06T08:00:00.000Z' });
    // the day the clocks go back (2026-11-01) is 25 hours long
    expect(pacificWindow(new Date('2026-11-01T20:00:00.000Z'))).toEqual({ since: '2026-11-01T07:00:00.000Z', resetsAt: '2026-11-02T08:00:00.000Z' });
  });
});

describe('site routes: broadcast, complete, status', () => {
  it('broadcast returns the key once, completes by id, and the key is in no log or table', async () => {
    const r = await rig();
    const res = await post(r, '/api/cloud/youtube/broadcast', r.site.headers, {
      sessionId: 'sess1',
      meta: { title: 'Kuliah Maghrib: Ustaz Ahmad Fauzi', description: 'Bab Solat', privacy: 'unlisted' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ broadcastId: 'bc-1', watchUrl: 'https://youtu.be/bc-1' });
    expect(typeof body.key).toBe('string');
    expect(body.key.length).toBeGreaterThan(5);
    expect(res.headers['cache-control']).toBe('no-store');
    const ins = r.g.calls.find((c) => c.path === '/youtube/v3/liveBroadcasts' && c.method === 'POST')!;
    expect(ins.json).toMatchObject({ snippet: { title: 'Kuliah Maghrib: Ustaz Ahmad Fauzi' }, status: { privacyStatus: 'unlisted' } });
    const text = leakText(r);
    expect(text).not.toContain(body.key);
    expect(text).not.toContain('refresh-token');
    expect(r.app.surau.db.prepare("SELECT after_json FROM change_log WHERE entity = 'youtube/broadcast'").get()!.after_json).toBe(JSON.stringify({ sessionId: 'sess1', broadcastId: 'bc-1' }));

    const st = await r.app.inject({ method: 'GET', url: '/api/cloud/youtube/status', headers: r.site.headers });
    expect(st.json()).toMatchObject({ broadcastId: 'bc-1', state: 'created', signedIn: true });
    const done = await post(r, '/api/cloud/youtube/complete', r.site.headers, { broadcastId: 'bc-1' });
    expect(done.statusCode).toBe(200);
    const tr = r.g.calls.find((c) => c.path === '/youtube/v3/liveBroadcasts/transition')!;
    expect(tr.query.get('id')).toBe('bc-1');
  });

  it('the meta is validated and cleaned, a bad body is 400', async () => {
    const r = await rig();
    const url = '/api/cloud/youtube/broadcast';
    for (const bad of [{}, { sessionId: 's' }, { sessionId: 's', meta: { title: '', description: '', privacy: 'unlisted' } }, { sessionId: 's', meta: { title: 'a', description: '', privacy: 'secret' } }, { sessionId: 5, meta: { title: 'a', description: '', privacy: 'public' } }]) {
      expect((await post(r, url, r.site.headers, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await post(r, '/api/cloud/youtube/complete', r.site.headers, {})).statusCode).toBe(400);
    expect(r.g.calls.some((c) => c.path === '/youtube/v3/liveBroadcasts' && c.method === 'POST')).toBe(false);
    const ok = await post(r, url, r.site.headers, { sessionId: 's', meta: { title: 'Kuliah <b>A</b> — B', description: 'x→y', privacy: 'public' } });
    expect(ok.statusCode).toBe(200);
    const ins = r.g.calls.find((c) => c.path === '/youtube/v3/liveBroadcasts' && c.method === 'POST')!;
    expect((ins.json!.snippet as { title: string }).title).toBe('Kuliah bA/b , B');
    expect((ins.json!.snippet as { description: string }).description).toBe('x:y');
  });

  it('signed out: broadcast is 503 youtube_reauthorise; a revoked site token is refused', async () => {
    const r = await rig({ signedIn: false });
    const res = await post(r, '/api/cloud/youtube/broadcast', r.site.headers, { sessionId: 's', meta: { title: 'a', description: '', privacy: 'unlisted' } });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('youtube_reauthorise');
    r.app.surau.db.prepare('UPDATE sites SET revoked_at = ?').run('2026-11-05T00:00:00.000Z');
    expect((await r.app.inject({ method: 'GET', url: '/api/cloud/youtube/status', headers: r.site.headers })).statusCode).toBe(401);
  });
});

describe('on a box', () => {
  it('the cloud YouTube routes exist in the table but answer 404: the box holds no Google token for them', async () => {
    const app = buildApp(':memory:');
    closers.push(() => app.close());
    const admin = await loginAs(app, 'admin');
    for (const [method, url] of [['POST', '/api/youtube/upload/begin'], ['POST', '/api/youtube/upload/done'], ['GET', '/api/youtube/quota'], ['GET', '/api/cloud/youtube/status'], ['POST', '/api/cloud/youtube/broadcast']] as const) {
      const res = await app.inject({ method, url, headers: admin.headers, ...(method === 'POST' ? { payload: {} } : {}) });
      expect(res.statusCode, url).toBe(404);
    }
  });
});

// ---- Plan 6 gate 2 fixes (lane BOX) ---------------------------------------------------------------

const BC = { sessionId: 'sess1', meta: { title: 'Kuliah Maghrib', description: 'Bab Solat', privacy: 'unlisted' } };

describe('S3: done checks the video is one this upload created', () => {
  async function liveAndBegin(r: Rig): Promise<{ live: string; media: Awaited<ReturnType<typeof loginAs>>; uploadId: string }> {
    const live = (await post(r, '/api/cloud/youtube/broadcast', r.site.headers, BC)).json().broadcastId as string;
    const media = await loginAs(r.app, 'media');
    const b = await begin(r, media.headers, { replaceLiveVideoId: live });
    expect(b.statusCode).toBe(200);
    return { live, media, uploadId: b.json().uploadId as string };
  }

  it('a made-up id (Google has no such video) is 400 unknown_video and the live video stays public', async () => {
    const r = await rig();
    const { media, uploadId } = await liveAndBegin(r);
    r.up.videos.GHOSTvideo1 = { exists: false };
    const res = await post(r, '/api/youtube/upload/done', media.headers, { uploadId, videoId: 'GHOSTvideo1' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('unknown_video');
    expect(r.up.updates).toHaveLength(0);
    expect(r.app.surau.db.prepare('SELECT state FROM uploads WHERE id = ?').get(uploadId)!.state).toBe('open');
  });

  it('a video published before this upload began, or on another channel, is refused', async () => {
    const r = await rig();
    const { media, uploadId } = await liveAndBegin(r);
    r.up.videos.OLDvideo0001 = { publishedAt: new Date(r.clock.t - 3 * 3_600_000).toISOString() };
    r.up.videos.FOREIGNvid01 = { channelId: 'UC-someone-else' };
    for (const videoId of ['OLDvideo0001', 'FOREIGNvid01']) {
      const res = await post(r, '/api/youtube/upload/done', media.headers, { uploadId, videoId });
      expect(res.statusCode, videoId).toBe(400);
      expect(res.json().code).toBe('unknown_video');
    }
    expect(r.up.updates).toHaveLength(0);
    // the real upload then goes through
    const ok = await post(r, '/api/youtube/upload/done', media.headers, { uploadId, videoId: 'NEWvideo123' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().replaced).toBe(true);
    expect(r.up.updates).toHaveLength(1);
  });

  it('one video id cannot close two uploads', async () => {
    const r = await rig();
    const media = await loginAs(r.app, 'media');
    const a = (await begin(r, media.headers)).json().uploadId as string;
    const b = (await begin(r, media.headers)).json().uploadId as string;
    expect((await post(r, '/api/youtube/upload/done', media.headers, { uploadId: a, videoId: 'NEWvideo123' })).statusCode).toBe(200);
    const dup = await post(r, '/api/youtube/upload/done', media.headers, { uploadId: b, videoId: 'NEWvideo123' });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().code).toBe('unknown_video');
  });

  it('a stale replace claim (older than 10 minutes) is cleared so a later done retries; a fresh one is respected', async () => {
    const r = await rig();
    const { media, uploadId } = await liveAndBegin(r);
    expect((await post(r, '/api/youtube/upload/done', media.headers, { uploadId, videoId: 'NEWvideo123' })).statusCode).toBe(200);
    expect(r.up.updates).toHaveLength(1);
    const { db } = r.app.surau;
    // a crash left the claim behind: nobody finished the set-private
    db.prepare('UPDATE uploads SET replaced_at = ? WHERE id = ?').run(`claim@${new Date(r.clock.t - 60_000).toISOString()}`, uploadId);
    const fresh = await post(r, '/api/youtube/upload/done', media.headers, { uploadId, videoId: 'NEWvideo123' });
    expect(fresh.json().replaced).toBe(false);
    expect(r.up.updates).toHaveLength(1);
    db.prepare('UPDATE uploads SET replaced_at = ? WHERE id = ?').run(`claim@${new Date(r.clock.t - 11 * 60_000).toISOString()}`, uploadId);
    const stale = await post(r, '/api/youtube/upload/done', media.headers, { uploadId, videoId: 'NEWvideo123' });
    expect(stale.json().replaced).toBe(true);
    expect(r.up.updates).toHaveLength(2);
  });
});

describe('S2: begin enforces the daily limit and a per-device cap', () => {
  it('100 uploads today: 429 youtube_quota with resetsAt, and Google is not called', async () => {
    const r = await rig();
    const media = await loginAs(r.app, 'media');
    const ins = r.app.surau.db.prepare("INSERT INTO uploads (id, device_id, state, created_at) VALUES (?, 'd', 'done', ?)");
    for (let i = 0; i < 100; i++) ins.run(`u${i}`, '2026-11-05T09:00:00.000Z');
    const res = await begin(r, media.headers);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: 'youtube_quota', resetsAt: '2026-11-06T08:00:00.000Z' });
    expect(r.up.sessions).toHaveLength(0);
    // yesterday's rows do not count
    r.app.surau.db.prepare("UPDATE uploads SET created_at = '2026-11-04T09:00:00.000Z' WHERE id = 'u0'").run();
    expect((await begin(r, media.headers)).statusCode).toBe(200);
  });

  it('10 open uploads on one device: 409 too_many_uploads; another device is unaffected', async () => {
    const r = await rig();
    const media = await loginAs(r.app, 'media');
    const other = await loginAs(r.app, 'media');
    for (let i = 0; i < 10; i++) expect((await begin(r, media.headers)).statusCode).toBe(200);
    const res = await begin(r, media.headers);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('too_many_uploads');
    expect(r.up.sessions).toHaveLength(10);
    expect((await begin(r, other.headers)).statusCode).toBe(200);
    // finishing one frees a place
    const id = r.app.surau.db.prepare("SELECT id FROM uploads WHERE device_id = ? AND state = 'open' LIMIT 1").get(media.deviceId)!.id as string;
    expect((await post(r, '/api/youtube/upload/done', media.headers, { uploadId: id, videoId: 'NEWvideo123' })).statusCode).toBe(200);
    expect((await begin(r, media.headers)).statusCode).toBe(200);
  });

  it('open rows older than 7 days expire (they neither count against the cap nor can be finished)', async () => {
    const r = await rig();
    const media = await loginAs(r.app, 'media');
    const { db } = r.app.surau;
    const ins = db.prepare("INSERT INTO uploads (id, device_id, state, created_at) VALUES (?, ?, 'open', ?)");
    for (let i = 0; i < 10; i++) ins.run(`old${i}`, media.deviceId, new Date(r.clock.t - 8 * 86_400_000).toISOString());
    expect((await begin(r, media.headers)).statusCode).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM uploads WHERE state = 'expired'").get()!.n).toBe(10);
    const done = await post(r, '/api/youtube/upload/done', media.headers, { uploadId: 'old0', videoId: 'NEWvideo123' });
    expect(done.statusCode).toBe(409);
    expect(done.json().code).toBe('upload_expired');
  });
});

describe('Q-M2: the broadcast call is idempotent per site and session', () => {
  it('a retry after a timeout returns the same broadcast and key; Google creates one', async () => {
    const r = await rig();
    const first = await post(r, '/api/cloud/youtube/broadcast', r.site.headers, BC);
    const again = await post(r, '/api/cloud/youtube/broadcast', r.site.headers, BC);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(r.g.calls.filter((c) => c.path === '/youtube/v3/liveBroadcasts' && c.method === 'POST')).toHaveLength(1);
    expect(r.g.calls.filter((c) => c.path === '/youtube/v3/liveStreams' && c.method === 'POST')).toHaveLength(1);
    // the key still never reaches a table or a log
    expect(leakText(r)).not.toContain(first.json().key);
  });

  it('a retry that arrives while the first is still running joins it', async () => {
    const r = await rig();
    r.g.delayMs = 60;
    const [a, b] = await Promise.all([
      post(r, '/api/cloud/youtube/broadcast', r.site.headers, BC),
      post(r, '/api/cloud/youtube/broadcast', r.site.headers, BC),
    ]);
    expect(a.json()).toEqual(b.json());
    expect(r.g.calls.filter((c) => c.path === '/youtube/v3/liveBroadcasts' && c.method === 'POST')).toHaveLength(1);
  });

  it('another session gets its own broadcast; another site with the same session id never gets this one', async () => {
    const r = await rig();
    const one = await post(r, '/api/cloud/youtube/broadcast', r.site.headers, BC);
    const two = await post(r, '/api/cloud/youtube/broadcast', r.site.headers, { ...BC, sessionId: 'sess2' });
    expect(two.json().broadcastId).not.toBe(one.json().broadcastId);
    const site2 = insertSite(r.app.surau.db, { boxId: 'boxid0002' });
    const three = await post(r, '/api/cloud/youtube/broadcast', site2.headers, BC);
    expect(three.statusCode).toBe(200);
    expect(three.json().broadcastId).not.toBe(one.json().broadcastId);
    expect(three.json().key).not.toBe(one.json().key);
  });

  it('both open broadcasts survive: completing one leaves the other recorded', async () => {
    const r = await rig();
    const one = (await post(r, '/api/cloud/youtube/broadcast', r.site.headers, BC)).json();
    const two = (await post(r, '/api/cloud/youtube/broadcast', r.site.headers, { ...BC, sessionId: 'sess2' })).json();
    const file = join(r.cloud.dir, 'live', 'youtube-open.json');
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).broadcasts)).toHaveLength(2);
    expect((await post(r, '/api/cloud/youtube/complete', r.site.headers, { broadcastId: one.broadcastId })).statusCode).toBe(200);
    const left = JSON.parse(readFileSync(file, 'utf8')).broadcasts as Record<string, { broadcastId: string }>;
    expect(Object.values(left).map((x) => x.broadcastId)).toEqual([two.broadcastId]);
  });
});

describe('S8: complete only for broadcasts this cloud made for that site', () => {
  it('an unknown id, or another site broadcast, is 404 and Google is not asked', async () => {
    const r = await rig();
    const mine = (await post(r, '/api/cloud/youtube/broadcast', r.site.headers, BC)).json();
    const site2 = insertSite(r.app.surau.db, { boxId: 'boxid0002' });
    const before = r.g.calls.length;
    for (const [h, id] of [[r.site.headers, 'someOtherLive'], [site2.headers, mine.broadcastId as string]] as const) {
      const res = await post(r, '/api/cloud/youtube/complete', h, { broadcastId: id });
      expect(res.statusCode, id).toBe(404);
    }
    expect(r.g.calls.length).toBe(before);
    expect((await post(r, '/api/cloud/youtube/complete', r.site.headers, { broadcastId: mine.broadcastId })).statusCode).toBe(200);
  });
});

describe('S7: the cloud never completes a broadcast at boot', () => {
  const svcOf = (r: Rig, role: 'box' | 'cloud', now: () => Date = r.clock.now) =>
    createYoutubeService({ db: r.app.surau.db, dataDir: r.cloud.dir, fetchImpl: r.up.fetchImpl, now, role });
  const ends = (r: Rig) => r.g.count('/youtube/v3/liveBroadcasts/transition') + r.g.calls.filter((c) => c.method === 'DELETE').length;

  it('a cloud restart during a live leaves the broadcast live (service level); a later box complete still ends it', async () => {
    const r = await rig();
    const made = (await post(r, '/api/cloud/youtube/broadcast', r.site.headers, BC)).json();
    r.g.lifeCycle = 'live';
    const restarted = svcOf(r, 'cloud');
    await restarted.recover();
    expect(ends(r)).toBe(0);
    expect(r.g.broadcasts.has(made.broadcastId)).toBe(true);
    expect(existsSync(join(r.cloud.dir, 'live', 'youtube-open.json'))).toBe(true);
    expect(restarted.status()).toMatchObject({ broadcastId: made.broadcastId });
    await restarted.complete(made.broadcastId);
    expect(r.g.count('/youtube/v3/liveBroadcasts/transition')).toBe(1);
    // the stream it had is deleted too (the id came from the open record, not from memory)
    expect(r.g.streams.size).toBe(0);
    expect(existsSync(join(r.cloud.dir, 'live', 'youtube-open.json'))).toBe(false);
    restarted.shutdown();
  });

  it('a whole cloud app rebooted on the same data leaves the live broadcast alone', async () => {
    const r = await rig();
    const made = (await post(r, '/api/cloud/youtube/broadcast', r.site.headers, BC)).json();
    r.g.lifeCycle = 'live';
    const app2 = buildApp(join(r.cloud.dir, 'cloud.db'), { dataDir: r.cloud.dir, role: 'cloud', boxId: 'boxid0001', now: r.clock.now, fetchImpl: r.up.fetchImpl });
    closers.unshift(async () => void (await app2.close().catch(() => undefined)));
    await app2.ready();
    await new Promise((res) => setTimeout(res, 300)); // recover() runs in the background after ready
    expect(ends(r)).toBe(0);
    expect(r.g.broadcasts.has(made.broadcastId)).toBe(true);
  });

  it('an orphan (no status or complete from the box for 6 hours) is completed by the sweep; a seen one is not', async () => {
    const r = await rig();
    const made = (await post(r, '/api/cloud/youtube/broadcast', r.site.headers, BC)).json();
    r.g.lifeCycle = 'live';
    const clock2 = { t: r.clock.t };
    const svc = svcOf(r, 'cloud', () => new Date(clock2.t));
    await svc.recover();
    clock2.t += 5 * 3_600_000;
    expect(await svc.sweepOrphans()).toBe(0);
    // the box asks for the status: the clock restarts
    svc.touch('boxid0001/');
    clock2.t += 5 * 3_600_000;
    expect(await svc.sweepOrphans()).toBe(0);
    expect(ends(r)).toBe(0);
    clock2.t += 2 * 3_600_000;
    expect(await svc.sweepOrphans()).toBe(1);
    expect(r.g.count('/youtube/v3/liveBroadcasts/transition')).toBe(1);
    expect(r.g.broadcasts.has(made.broadcastId)).toBe(true);
    expect(existsSync(join(r.cloud.dir, 'live', 'youtube-open.json'))).toBe(false);
    svc.shutdown();
  });

  it('the status route counts as the box being there', async () => {
    const r = await rig();
    await post(r, '/api/cloud/youtube/broadcast', r.site.headers, BC);
    const file = join(r.cloud.dir, 'live', 'youtube-open.json');
    const seen = () => Object.values(JSON.parse(readFileSync(file, 'utf8')).broadcasts as Record<string, { seenAt: string }>)[0]!.seenAt;
    const t0 = seen();
    r.clock.t += 20 * 60_000;
    await r.app.inject({ method: 'GET', url: '/api/cloud/youtube/status', headers: r.site.headers });
    expect(new Date(seen()).getTime()).toBeGreaterThan(new Date(t0).getTime());
  });

  it('a file in the old single-slot shape is still read, and ended by the box role', async () => {
    const r = await rig();
    await post(r, '/api/cloud/youtube/broadcast', r.site.headers, BC);
    r.g.lifeCycle = 'live';
    writeFileSync(join(r.cloud.dir, 'live', 'youtube-open.json'), JSON.stringify({ broadcastId: 'bc-1', streamId: 'stream-1' }));
    const svc = svcOf(r, 'box');
    await svc.recover();
    expect(r.g.count('/youtube/v3/liveBroadcasts/transition')).toBe(1);
    expect(r.g.streams.size).toBe(0);
    svc.shutdown();
  });

  it('the box role still ends a leftover broadcast at boot', async () => {
    const r = await rig();
    await post(r, '/api/cloud/youtube/broadcast', r.site.headers, BC);
    r.g.lifeCycle = 'live';
    const svc = svcOf(r, 'box');
    await svc.recover();
    expect(r.g.count('/youtube/v3/liveBroadcasts/transition')).toBe(1);
    svc.shutdown();
  });
});
