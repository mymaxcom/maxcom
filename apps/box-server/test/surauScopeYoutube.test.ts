import { mkdirSync, writeFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { klInstant } from '@surau/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { putItem } from '../src/content/store.ts';
import { putFeature } from '../src/settingsStore.ts';
import { generateSyncKeyPair } from '../src/sync/syncKey.ts';
import { insertSite } from './support/sites.ts';
import type { TestSite } from './support/sites.ts';
import type { FakeGoogle } from './support/fakeGoogle.ts';
import { buildBox } from './support/boxGrant.ts';
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
    // the box holds the grant (2026.11.13); the rows of a surau that is not this box's are still kept apart
    const cloud = buildBox('boxid0001', { now: clock.now, fetchImpl: up.fetchImpl });
    closers.push(cloud.close, g.close);
    const app = cloud.app;
    mkdirSync(join(cloud.dir, 'secret'), { recursive: true });
    writeFileSync(join(cloud.dir, 'secret', 'youtube-client.json'), JSON.stringify({ client_id: 'cid', client_secret: 'secret' }));

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

describe('[L1] the cloud holds no YouTube sign-in for any surau', () => {
  const B = 'zbravo-surau';
  const BOX_A = 'aaaa000000000001';
  const BOX_B = 'bbbb000000000001';

  async function rig(): Promise<{
    app: FastifyInstance;
    g: FakeGoogle;
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
    // a linked site has the public half of its sync key on the cloud (the flag route seals nothing, but asks for it)
    for (const boxId of [BOX_A, BOX_B]) db.prepare('UPDATE sites SET public_jwk = ? WHERE box_id = ?').run(JSON.stringify(generateSyncKeyPair().publicJwk), boxId);
    return { app: cloud.app, g, adminA, adminB, siteA, siteB };
  }

  const status = (r: Awaited<ReturnType<typeof rig>>, who: { headers: Record<string, string> }) =>
    r.app.inject({ method: 'GET', url: '/api/live/youtube/status', headers: who.headers });
  const flag = (r: Awaited<ReturnType<typeof rig>>, site: TestSite, body: object) =>
    r.app.inject({ method: 'PUT', url: '/api/sync/youtube/flag', headers: site.headers, payload: body });

  it('[L1] the status away from the surau is the own box flag of each surau: A signed in, B signed out', async () => {
    const r = await rig();
    expect((await flag(r, r.siteA, { signedIn: true, channelTitle: 'Saluran A' })).statusCode).toBe(200);
    expect((await status(r, r.adminA)).json()).toMatchObject({ signedIn: true, channelTitle: 'Saluran A', heldBy: 'box' });
    expect((await status(r, r.adminB)).json()).toMatchObject({ signedIn: false, channelTitle: null });
  });

  it('[L1] sign-out, sign-in and its poll are refused on the cloud for every surau (2026.11.13); B cannot sign A out', async () => {
    const r = await rig();
    await flag(r, r.siteA, { signedIn: true, channelTitle: 'Saluran A' });
    for (const who of [r.adminA, r.adminB]) {
      for (const url of ['/api/live/youtube/signout', '/api/live/youtube/signin', '/api/live/youtube/signin/poll']) {
        const out = await r.app.inject({ method: 'POST', url, headers: who.headers });
        expect(out.statusCode, url).toBe(409);
        expect(out.json().code).toBe('youtube_at_box');
      }
    }
    expect((await status(r, r.adminA)).json()).toMatchObject({ signedIn: true });
    expect(r.g.count('/revoke')).toBe(0);
    expect(r.g.count('/device/code')).toBe(0);
  });

  it('[L1] no site makes a broadcast on the cloud, on any surau: the old box leg answers youtube_at_box', async () => {
    const r = await rig();
    for (const site of [r.siteA, r.siteB]) {
      const res = await r.app.inject({
        method: 'POST',
        url: '/api/cloud/youtube/broadcast',
        headers: site.headers,
        payload: { sessionId: 'sess-1', meta: { title: 'Kuliah Maghrib', description: 'Bab Solat', privacy: 'unlisted' } },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('youtube_at_box');
    }
    expect(r.g.calls).toHaveLength(0);
  });

  it('[L1] verify of a video id is refused on the cloud for every surau: the box answers it', async () => {
    const r = await rig();
    const liveB = await loginAs(r.app, 'live', TEST_PIN, B);
    const res = await r.app.inject({ method: 'POST', url: '/api/youtube/verify', headers: liveB.headers, payload: { videoIds: ['someVideo001'] } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('youtube_at_box');
  });
});
