import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { klInstant } from '@surau/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { putItem } from '../src/content/store.ts';
import { putFeature } from '../src/settingsStore.ts';
import { insertSite } from './support/sites.ts';
import type { TestSite } from './support/sites.ts';
import type { FakeGoogle } from './support/fakeGoogle.ts';
import { buildCloud } from './support/fakeCloud.ts';
import { withUploadApi } from './support/fakeGoogleUpload.ts';
import { startFakeGoogle } from './support/fakeGoogle.ts';
import { TEST_PIN, loginAs } from './authHelpers.ts';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0)) await c();
});

const OTHER_SURAU = 'other';
const DEFAULT_SURAU = 'sdm';

describe('youtube uploads scoped by surau_id', () => {
  it('uploads rows and quota are isolated by surau', async () => {
    const g = await startFakeGoogle();
    const up = withUploadApi(g);
    const clock = { t: klInstant('2026-11-05', '19:00').getTime(), now: (): Date => new Date(clock.t) };
    up.snippet = () => ({ publishedAt: new Date(clock.t + 1000).toISOString(), channelId: 'UC-surau' });
    const cloud = buildCloud('boxid0001', { now: clock.now, fetchImpl: up.fetchImpl });
    closers.push(cloud.close, g.close);
    const app = cloud.app;
    mkdirSync(join(cloud.dir, 'secret'), { recursive: true });
    writeFileSync(join(cloud.dir, 'secret', 'youtube-client.json'), JSON.stringify({ client_id: 'cid', client_secret: 'secret' }));

    // sign in
    const admin = await loginAs(app, 'admin');
    expect((await app.inject({ method: 'POST', url: '/api/live/youtube/signin', headers: admin.headers })).statusCode).toBe(200);
    g.approve = true;
    clock.t += 6000;
    expect((await app.inject({ method: 'POST', url: '/api/live/youtube/signin/poll', headers: admin.headers })).json()).toMatchObject({ signedIn: true });

    const { db } = app.surau;
    const pen = putItem(db, 'penceramah', { name: 'Ustaz' }, 'test', undefined, 'sdm');
    const kuliah = putItem(db, 'kuliah', { date: '2026-11-05', slot: 'maghrib', time: '19:15', label: 'K', penceramahId: pen.item.id, status: 'aktif' }, 'test', undefined, 'sdm');

    // seed an upload belonging to another surau: it must not affect this surau's quota
    db.prepare(
      `INSERT INTO uploads (surau_id, id, kuliah_id, device_id, state, bytes, created_at, replace_video_id) VALUES (?, ?, ?, ?, 'open', 1, ?, NULL)`,
    ).run(OTHER_SURAU, 'up_other', kuliah.item.id, 'dev-other', new Date().toISOString());

    const liveUser = await loginAs(app, 'live');
    const quota = await app.inject({ method: 'GET', url: '/api/youtube/quota', headers: liveUser.headers });
    expect(quota.json().uploadsToday).toBe(0);

    const begin = await app.inject({
      method: 'POST',
      url: '/api/youtube/upload/begin',
      headers: liveUser.headers,
      payload: { kuliahId: kuliah.item.id, part: null, bytes: 1000, replaceLiveVideoId: null },
    });
    expect(begin.statusCode).toBe(200);
    const { uploadId } = begin.json();

    const row = db.prepare('SELECT * FROM uploads WHERE id = ?').get(uploadId);
    expect(row!.surau_id).toBe(DEFAULT_SURAU);

    const log = db.prepare("SELECT * FROM change_log WHERE entity = 'youtube/upload'").get();
    expect(log!.surau_id).toBe(DEFAULT_SURAU);

    // the other surau's upload is still there and untouched
    expect(db.prepare('SELECT state FROM uploads WHERE id = ?').get('up_other')!.state).toBe('open');

    // finishing only affects this surau's upload
    const done = await app.inject({
      method: 'POST',
      url: '/api/youtube/upload/done',
      headers: liveUser.headers,
      payload: { uploadId, videoId: 'video123' },
    });
    expect(done.statusCode).toBe(200);
    expect(db.prepare('SELECT state FROM uploads WHERE id = ?').get(uploadId)!.state).toBe('done');
    expect(db.prepare('SELECT state FROM uploads WHERE id = ?').get('up_other')!.state).toBe('open');
  });
});

describe('[L1] one YouTube sign-in per surau on the cloud', () => {
  const B = 'zbravo-surau';
  const BOX_A = 'boxid0001';
  const BOX_B = 'boxid0002';

  async function rig(): Promise<{
    app: FastifyInstance;
    dir: string;
    g: FakeGoogle;
    clock: { t: number };
    adminA: Awaited<ReturnType<typeof loginAs>>;
    adminB: Awaited<ReturnType<typeof loginAs>>;
    siteA: TestSite;
    siteB: TestSite;
  }> {
    const g = await startFakeGoogle();
    const clock = { t: klInstant('2026-11-05', '19:00').getTime() };
    const cloud = buildCloud('boxid0000', { now: () => new Date(clock.t), fetchImpl: withUploadApi(g).fetchImpl });
    closers.push(cloud.close, g.close);
    const { db } = cloud.app.surau;
    mkdirSync(join(cloud.dir, 'secret'), { recursive: true });
    writeFileSync(join(cloud.dir, 'secret', 'youtube-client.json'), JSON.stringify({ client_id: 'cid', client_secret: 'secret' }));
    db.prepare('INSERT INTO suraus (id, name, created_at, created_by) VALUES (?, ?, ?, ?)').run(B, 'Surau Bravo', new Date(clock.t).toISOString(), 'test');
    putFeature(db, 'surauInfo', { name: 'Surau Alfa' }, 'test', undefined, DEFAULT_SURAU);
    putFeature(db, 'surauInfo', { name: 'Surau Bravo' }, 'test', undefined, B);
    const adminA = await loginAs(cloud.app, 'admin');
    const adminB = await loginAs(cloud.app, 'admin', TEST_PIN, B);
    const siteA = insertSite(db, { boxId: BOX_A, surauId: DEFAULT_SURAU });
    const siteB = insertSite(db, { boxId: BOX_B, surauId: B });
    return { app: cloud.app, dir: cloud.dir, g, clock, adminA, adminB, siteA, siteB };
  }

  async function signIn(r: Awaited<ReturnType<typeof rig>>, who: { headers: Record<string, string> }): Promise<void> {
    expect((await r.app.inject({ method: 'POST', url: '/api/live/youtube/signin', headers: who.headers })).statusCode).toBe(200);
    r.g.approve = true;
    r.clock.t += 6000;
    expect((await r.app.inject({ method: 'POST', url: '/api/live/youtube/signin/poll', headers: who.headers })).json()).toMatchObject({ signedIn: true });
  }
  const status = (r: Awaited<ReturnType<typeof rig>>, who: { headers: Record<string, string> }) =>
    r.app.inject({ method: 'GET', url: '/api/live/youtube/status', headers: who.headers });
  const broadcast = (r: Awaited<ReturnType<typeof rig>>, site: TestSite, sessionId: string) =>
    r.app.inject({
      method: 'POST',
      url: '/api/cloud/youtube/broadcast',
      headers: site.headers,
      payload: { sessionId, meta: { title: 'Kuliah Maghrib', description: 'Bab Solat', privacy: 'unlisted' } },
    });

  it('[L1] surau A signed in: surau B is signed out, and B cannot sign A out', async () => {
    const r = await rig();
    await signIn(r, r.adminA);
    expect((await status(r, r.adminA)).json()).toMatchObject({ signedIn: true });
    expect((await status(r, r.adminB)).json()).toMatchObject({ signedIn: false });
    const out = await r.app.inject({ method: 'POST', url: '/api/live/youtube/signout', headers: r.adminB.headers });
    expect(out.statusCode).toBe(200);
    expect((await status(r, r.adminA)).json()).toMatchObject({ signedIn: true });
    // B's own site cannot make a broadcast on A's account
    const res = await broadcast(r, r.siteB, 'sess-b');
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('youtube_reauthorise');
    expect(r.g.calls.some((c) => c.path === '/youtube/v3/liveBroadcasts' && c.method === 'POST')).toBe(false);
  });

  it('[L1] the token file name carries the surau id and no code path reads the shared file', async () => {
    const r = await rig();
    await signIn(r, r.adminA);
    await signIn(r, r.adminB);
    expect(existsSync(join(r.dir, 'secret', `youtube-token-${DEFAULT_SURAU}.json`))).toBe(true);
    expect(existsSync(join(r.dir, 'secret', `youtube-token-${B}.json`))).toBe(true);
    expect(existsSync(join(r.dir, 'secret', 'youtube-token.json'))).toBe(false);
    // B signs out: A's file stays
    await r.app.inject({ method: 'POST', url: '/api/live/youtube/signout', headers: r.adminB.headers });
    expect(existsSync(join(r.dir, 'secret', `youtube-token-${B}.json`))).toBe(false);
    expect(existsSync(join(r.dir, 'secret', `youtube-token-${DEFAULT_SURAU}.json`))).toBe(true);
  });

  it('[L1] a broadcast carries its own surau name and a surau cannot end a live of another', async () => {
    const r = await rig();
    await signIn(r, r.adminA);
    await signIn(r, r.adminB);
    const a = await broadcast(r, r.siteA, 'sess-a');
    expect(a.statusCode).toBe(200);
    const b = await broadcast(r, r.siteB, 'sess-b');
    expect(b.statusCode).toBe(200);
    const titles = r.g.calls.filter((c) => c.path === '/youtube/v3/liveStreams' && c.method === 'POST').map((c) => (c.json!.snippet as { title: string }).title);
    expect(titles).toEqual(['MAXCOM Surau Alfa', 'MAXCOM Surau Bravo']);
    // A cannot end B's broadcast
    const end = await r.app.inject({ method: 'POST', url: '/api/cloud/youtube/complete', headers: r.siteA.headers, payload: { broadcastId: b.json().broadcastId } });
    expect(end.statusCode).toBe(404);
  });

  it('[L1] verify of another surau video id is refused; the own one answers', async () => {
    const r = await rig();
    await signIn(r, r.adminA);
    await signIn(r, r.adminB);
    const a = await broadcast(r, r.siteA, 'sess-a');
    const id = a.json().broadcastId as string;
    const liveA = await loginAs(r.app, 'live');
    const liveB = await loginAs(r.app, 'live', TEST_PIN, B);
    const mine = await r.app.inject({ method: 'POST', url: '/api/youtube/verify', headers: liveA.headers, payload: { videoIds: [id] } });
    expect(mine.statusCode).toBe(200);
    const theirs = await r.app.inject({ method: 'POST', url: '/api/youtube/verify', headers: liveB.headers, payload: { videoIds: [id] } });
    expect(theirs.statusCode).toBe(400);
    expect(theirs.json().code).toBe('unknown_video');
  });

  it('[L1] sign-out is refused while one of the surau sites has a live open', async () => {
    const r = await rig();
    await signIn(r, r.adminA);
    await signIn(r, r.adminB);
    expect((await broadcast(r, r.siteA, 'sess-a')).statusCode).toBe(200);
    const out = await r.app.inject({ method: 'POST', url: '/api/live/youtube/signout', headers: r.adminA.headers });
    expect(out.statusCode).toBe(409);
    expect(out.json().code).toBe('live_busy');
    expect((await status(r, r.adminA)).json()).toMatchObject({ signedIn: true });
    // B has no live: B may sign out
    expect((await r.app.inject({ method: 'POST', url: '/api/live/youtube/signout', headers: r.adminB.headers })).statusCode).toBe(200);
  });

  it('[L1] the old shared token and open-broadcast files are gone after the first start of a cloud', () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-cloud-old-'));
    mkdirSync(join(dir, 'secret'), { recursive: true });
    mkdirSync(join(dir, 'live'), { recursive: true });
    writeFileSync(join(dir, 'secret', 'youtube-token.json'), 'old');
    writeFileSync(join(dir, 'live', 'youtube-open.json'), '{}');
    const app = buildApp(join(dir, 'cloud.db'), { dataDir: dir, role: 'cloud', boxId: 'boxid0000' });
    closers.push(async () => {
      await app.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    });
    expect(existsSync(join(dir, 'secret', 'youtube-token.json'))).toBe(false);
    expect(existsSync(join(dir, 'live', 'youtube-open.json'))).toBe(false);
  });
});
