import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { klInstant } from '@surau/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { putItem } from '../src/content/store.ts';
import { registerYoutubeRoutes } from '../src/live/youtube/routes.ts';
import { createLiveSessionStore } from '../src/live/sessionStore.ts';
import { YoutubeError } from '../src/live/youtube/oauth.ts';
import type { YoutubeService } from '../src/live/youtube/api.ts';
import { TokenStore } from '../src/live/youtube/tokenStore.ts';
import { logChange } from '../src/auth/users.ts';
import { OPEN_UPLOADS_PER_DEVICE, REPLACE_GIVE_UP_MS, UPLOAD_STALE_MS, expireOpenUploads, registerYoutubeCloudRoutes, replaceStateOf, sweepUploads } from '../src/sync/youtubeCloud.ts';
import { loginAs } from './authHelpers.ts';
import { buildBox } from './support/boxGrant.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { startFakeGoogle } from './support/fakeGoogle.ts';
import type { FakeGoogle } from './support/fakeGoogle.ts';
import { withUploadApi } from './support/fakeGoogleUpload.ts';
import type { GoogleUploadFake } from './support/fakeGoogleUpload.ts';

/**
 * 2026.11.15 Siaran langsung revamp, the YouTube lane, catch-up upload: the live session id on `begin` (U6), the
 * abandon route and the expiry sweep (U4), the set-private step retried by the server until it lands (U5), and the
 * two small checks of Y10 (no channel id means no trust; `verify` answers only for videos this surau logged).
 */

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const c of closers.splice(0)) await c();
});

interface Rig {
  cloud: TestCloud;
  app: FastifyInstance;
  g: FakeGoogle;
  up: GoogleUploadFake;
  clock: { t: number; now: () => Date };
  kuliahId: string;
}

async function rig(o: { channelId?: string } = {}): Promise<Rig> {
  const g = await startFakeGoogle();
  const up = withUploadApi(g);
  const clock = { t: klInstant('2026-11-05', '19:00').getTime(), now: (): Date => new Date(clock.t) };
  up.snippet = () => ({ publishedAt: new Date(clock.t + 1000).toISOString(), channelId: 'UC-surau' });
  // the box holds the grant (2026.11.13); the cloud serves no upload now
  const cloud = buildBox('boxid0001', { now: clock.now, fetchImpl: up.fetchImpl }, o.channelId !== undefined ? { channelId: o.channelId } : {});
  closers.push(cloud.close, g.close);
  mkdirSync(join(cloud.dir, 'secret'), { recursive: true });
  writeFileSync(join(cloud.dir, 'secret', 'youtube-client.json'), JSON.stringify({ client_id: 'cid-123.apps.googleusercontent.com', client_secret: 'csecret-SECRET' }));
  const { db } = cloud.app.surau;
  const pen = putItem(db, 'penceramah', { name: 'Ustaz Ahmad Fauzi' }, 'test', undefined, 'sdm');
  const kuliah = putItem(db, 'kuliah', { date: '2026-11-05', slot: 'maghrib', time: '19:15', label: 'Kuliah Maghrib', penceramahId: pen.item.id, topic: 'Bab Solat', status: 'aktif' }, 'test', undefined, 'sdm');
  return { cloud, app: cloud.app, g, up, clock, kuliahId: kuliah.item.id };
}

type Headers = Record<string, string>;
const post = (r: Rig, url: string, headers: Headers, payload: object = {}) => r.app.inject({ method: 'POST', url, headers, payload });
const begin = (r: Rig, headers: Headers, over: Record<string, unknown> = {}) =>
  post(r, '/api/youtube/upload/begin', headers, { kuliahId: r.kuliahId, part: null, bytes: 123_456_789, replaceLiveVideoId: null, ...over });
const done = (r: Rig, headers: Headers, uploadId: string, videoId: string) => post(r, '/api/youtube/upload/done', headers, { uploadId, videoId });
const uploadRow = (r: Rig, id: string) => r.app.surau.db.prepare('SELECT * FROM uploads WHERE id = ?').get(id)!;
/** A live the box broadcast: its `youtube/broadcast` row (the box writes it for every live) and the id the catch-up replaces. */
const liveVideo = async (r: Rig): Promise<string> => {
  const id = 'bcLive0001';
  logChange(r.app.surau.db, 'system:live', 'youtube/broadcast', id, null, { sessionId: 'sess1', broadcastId: id }, undefined, 'sdm');
  return id;
};

/** The lane's own routes on a bare server (their rows in ROUTE_PERMISSIONS come with the integration): the caller is whoever the test says. */
async function laneRoutes(r: Rig | null, o: { youtube?: Partial<YoutubeService> | null; role?: 'box' | 'cloud'; boxId?: string } = {}): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('auth', null);
  app.decorateRequest('tenant', null);
  app.addHook('preHandler', async (request) => {
    const deviceId = request.headers['x-test-device'];
    (request as unknown as { auth: unknown }).auth = typeof deviceId === 'string' ? { kind: 'user', userId: 'u-test', deviceId } : null;
    (request as unknown as { tenant: unknown }).tenant = { surauId: 'sdm' };
  });
  registerYoutubeRoutes(app, {
    role: o.role ?? 'box',
    ...(r !== null ? { db: r.app.surau.db, now: r.clock.now } : {}),
    boxId: o.boxId ?? 'boxid0001',
    youtube: (o.youtube ?? null) as YoutubeService | null,
    sessionStore: null,
  });
  await app.ready();
  closers.push(() => app.close());
  return app;
}

describe('U6: the upload names its live session', () => {
  it('begin, done and replace with a session id: the happy path', async () => {
    const r = await rig();
    const live = await liveVideo(r);
    const user = await loginAs(r.app, 'live');
    const b = await begin(r, user.headers, { sessionId: 'live-2026-11-05-a', replaceLiveVideoId: live });
    expect(b.statusCode).toBe(200);
    const { uploadId } = b.json() as { uploadId: string };
    expect(uploadRow(r, uploadId)).toMatchObject({ state: 'open', session_id: 'live-2026-11-05-a', replace_video_id: live });
    const d = await done(r, user.headers, uploadId, 'NEWvideo123');
    expect(d.statusCode).toBe(200);
    expect(d.json()).toEqual({ uploadId, state: 'done', videoId: 'NEWvideo123', replaced: true, replaceState: 'done' });
    expect(r.up.updates).toHaveLength(1);
    // the same device may upload a second part of the same live
    expect((await begin(r, user.headers, { sessionId: 'live-2026-11-05-a', part: { index: 2, count: 2 } })).statusCode).toBe(200);
  });

  it('a second device that begins for the same live is refused with already_uploading and the first upload state', async () => {
    const r = await rig();
    const one = await loginAs(r.app, 'live');
    const two = await loginAs(r.app, 'live');
    const first = await begin(r, one.headers, { sessionId: 'live-A' });
    expect(first.statusCode).toBe(200);
    const sessions = r.up.sessions.length;
    const second = await begin(r, two.headers, { sessionId: 'live-A' });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'already_uploading', state: 'open' });
    // Google was not asked for a second upload session
    expect(r.up.sessions.length).toBe(sessions);
    // once the first is done the answer says so
    await done(r, one.headers, first.json().uploadId as string, 'NEWvideo123');
    expect((await begin(r, two.headers, { sessionId: 'live-A' })).json()).toMatchObject({ code: 'already_uploading', state: 'done' });
    // another live is not affected, and neither is an upload without a session id
    expect((await begin(r, two.headers, { sessionId: 'live-B' })).statusCode).toBe(200);
    expect((await begin(r, two.headers)).statusCode).toBe(200);
  });

  it('a bad session id is 400', async () => {
    const r = await rig();
    const user = await loginAs(r.app, 'live');
    for (const sessionId of ['', 7, 'x'.repeat(101), { a: 1 }]) expect((await begin(r, user.headers, { sessionId })).statusCode, JSON.stringify(sessionId)).toBe(400);
    expect((await begin(r, user.headers, { sessionId: 'x'.repeat(100) })).statusCode).toBe(200);
  });
});

describe('U4: abandon and the expiry sweep', () => {
  it('abandon frees the slot of the open-upload cap and lets another device upload that live', async () => {
    const r = await rig();
    const one = await loginAs(r.app, 'live');
    const two = await loginAs(r.app, 'live');
    const ids: string[] = [];
    for (let i = 0; i < OPEN_UPLOADS_PER_DEVICE; i++) ids.push((await begin(r, one.headers, i === 0 ? { sessionId: 'live-A' } : {})).json().uploadId as string);
    expect((await begin(r, one.headers)).json().code).toBe('too_many_uploads');
    expect((await begin(r, two.headers, { sessionId: 'live-A' })).json().code).toBe('already_uploading');

    const routes = await laneRoutes(r);
    const device = String(uploadRow(r, ids[0]!).device_id);
    const res = await routes.inject({ method: 'POST', url: '/api/youtube/upload/abandon', headers: { 'x-test-device': device }, payload: { uploadId: ids[0] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ abandoned: true });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(uploadRow(r, ids[0]!)).toMatchObject({ state: 'abandoned' });
    expect(r.app.surau.db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'youtube/uploadAbandoned' AND entity_id = ?").get(ids[0]!)!.n).toBe(1);

    expect((await begin(r, one.headers)).statusCode).toBe(200);
    expect((await begin(r, two.headers, { sessionId: 'live-A' })).statusCode).toBe(200);
    // an abandoned upload cannot be finished
    expect((await done(r, one.headers, ids[0]!, 'NEWvideo123')).json().code).toBe('upload_abandoned');
  });

  it("another device's upload is 404; a finished one answers abandoned false; a bad body is 400; no device session is 403", async () => {
    const r = await rig();
    const one = await loginAs(r.app, 'live');
    const open = (await begin(r, one.headers)).json().uploadId as string;
    const finished = (await begin(r, one.headers)).json().uploadId as string;
    await done(r, one.headers, finished, 'NEWvideo123');
    const device = String(uploadRow(r, open).device_id);
    const routes = await laneRoutes(r);
    const abandon = (headers: Headers, payload: unknown) => routes.inject({ method: 'POST', url: '/api/youtube/upload/abandon', headers, payload: payload as object });

    const other = await abandon({ 'x-test-device': 'dev-someone-else' }, { uploadId: open });
    expect(other.statusCode).toBe(404);
    expect(other.json().code).toBe('upload_not_found');
    expect(uploadRow(r, open).state).toBe('open');
    expect((await abandon({ 'x-test-device': device }, { uploadId: 'up_nope' })).statusCode).toBe(404);
    expect((await abandon({ 'x-test-device': device }, { uploadId: finished })).json()).toEqual({ abandoned: false });
    expect(uploadRow(r, finished).state).toBe('done');
    for (const bad of [{}, { uploadId: 5 }, { uploadId: '' }, { uploadId: 'x'.repeat(65) }]) expect((await abandon({ 'x-test-device': device }, bad)).statusCode).toBe(400);
    expect((await abandon({}, { uploadId: open })).statusCode).toBe(403);
    // a second abandon of the same upload changes nothing
    expect((await abandon({ 'x-test-device': device }, { uploadId: open })).json()).toEqual({ abandoned: true });
    expect((await abandon({ 'x-test-device': device }, { uploadId: open })).json()).toEqual({ abandoned: false });
  });

  it('the sweep expires an open session after 7 days without any app asking, and keeps a younger one', async () => {
    const r = await rig();
    const one = await loginAs(r.app, 'live');
    const old = (await begin(r, one.headers)).json().uploadId as string;
    r.clock.t += 6 * 86_400_000;
    const later = await loginAs(r.app, 'live');
    const young = (await begin(r, later.headers)).json().uploadId as string;
    r.clock.t += 86_400_000 + 60_000;
    expect((await sweepUploads(r.app.surau.db, r.clock.now, () => null)).expired).toBe(1);
    expect(uploadRow(r, old).state).toBe('expired');
    expect(uploadRow(r, young).state).toBe('open');
    expect(expireOpenUploads(r.app.surau.db, r.clock.now())).toBe(0);
  });
});

describe('U5: the set-private step is retried by the server until it lands, and reported', () => {
  it('a failed set-private says pending, the sweep retries it, and the next done reports it done', async () => {
    // the sweep timer of the routes is driven by hand (only setInterval is faked: the fake Google is a real socket)
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const r = await rig();
    const live = await liveVideo(r);
    const user = await loginAs(r.app, 'live');
    const uploadId = (await begin(r, user.headers, { replaceLiveVideoId: live })).json().uploadId as string;
    r.up.updateStatus = 500;
    const first = await done(r, user.headers, uploadId, 'NEWvideo123');
    // the upload itself is done (2xx: never uploaded again), and the missing step is said, not hidden
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ uploadId, state: 'done', videoId: 'NEWvideo123', replaced: false, replaceState: 'pending' });
    expect(uploadRow(r, uploadId).replaced_at).toBeNull();

    // no app comes back; the server's own sweep tries again: still failing, then Google recovers
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.waitFor(() => expect(r.up.updates.length).toBe(2));
    expect(replaceStateOf(uploadRow(r, uploadId).replaced_at)).toBe('pending');
    r.up.updateStatus = 200;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.waitFor(() => expect(replaceStateOf(uploadRow(r, uploadId).replaced_at)).toBe('done'));
    expect(r.up.updates.length).toBe(3);
    expect(JSON.parse(r.up.updates[2]!.body)).toMatchObject({ id: live, status: { privacyStatus: 'private' } });
    expect(r.app.surau.db.prepare("SELECT actor FROM change_log WHERE entity = 'youtube/replaceLive' AND entity_id = ?").get(live)).toEqual({ actor: 'system' });

    const again = await done(r, user.headers, uploadId, 'NEWvideo123');
    expect(again.json()).toMatchObject({ replaced: true, replaceState: 'done' });
    // done once: neither the sweep nor a repeated done sets it private again
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(r.up.updates.length).toBe(3);
  });

  it('a live video Google no longer has ends the step as gone; 7 days of failures give up', async () => {
    const r = await rig();
    const live = await liveVideo(r);
    const user = await loginAs(r.app, 'live');
    // the live video was deleted on the channel: nothing is left to hide, and nothing to try again
    const a = (await begin(r, user.headers, { replaceLiveVideoId: live })).json().uploadId as string;
    r.up.videos[live] = { exists: false };
    const gone = await done(r, user.headers, a, 'NEWvideo123');
    expect(gone.statusCode).toBe(200);
    expect(gone.json()).toMatchObject({ state: 'done', replaced: false, replaceState: 'gone' });
    expect((await sweepUploads(r.app.surau.db, r.clock.now, () => null)).gone).toBe(0);
    delete r.up.videos[live];

    // a step that keeps failing is given up after 7 days
    const b = (await begin(r, user.headers, { replaceLiveVideoId: live })).json().uploadId as string;
    r.up.updateStatus = 500;
    expect((await done(r, user.headers, b, 'NEWvideo124')).json().replaceState).toBe('pending');
    r.clock.t += REPLACE_GIVE_UP_MS + 60_000;
    expect((await sweepUploads(r.app.surau.db, r.clock.now, () => null)).gone).toBe(1);
    expect(replaceStateOf(uploadRow(r, b).replaced_at)).toBe('gone');
  });
});

describe('Y10: small checks', () => {
  it('done never trusts a video while the channel of the sign-in is unknown: the id is read first, then checked', async () => {
    // the grant was stored without a channel id (the sign-in could not read it at the time)
    const r = await rig({ channelId: '' });
    const user = await loginAs(r.app, 'live');
    const uploadId = (await begin(r, user.headers)).json().uploadId as string;
    r.up.videos.FOREIGNvid01 = { channelId: 'UC-someone-else' };
    // the fake Google says the sign-in's own channel is UC-surau: a video of another channel is refused
    const foreign = await done(r, user.headers, uploadId, 'FOREIGNvid01');
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().code).toBe('unknown_video');
    expect(uploadRow(r, uploadId).state).toBe('open');
    // the id was learned and kept
    expect(new TokenStore(r.cloud.dir).load()?.channelId).toBe('UC-surau');
    // the real upload then goes through
    expect((await done(r, user.headers, uploadId, 'NEWvideo123')).statusCode).toBe(200);
  });

  it('verify answers only for a video this surau logged', async () => {
    const r = await rig();
    const live = await liveVideo(r);
    const user = await loginAs(r.app, 'live');
    const verify = (ids: string[]) => post(r, '/api/youtube/verify', user.headers, { videoIds: ids });
    expect((await verify([live])).statusCode).toBe(200);
    const other = await verify([live, 'SOMEONEelse1']);
    expect(other.statusCode).toBe(400);
    expect(other.json().code).toBe('unknown_video');
  });
});

describe('Y11: the linked-boxes question', () => {
  it('answers the open broadcast with this box id and channel id, null when nothing is open, and never a key', async () => {
    let open: { channelId: string | null; broadcastId: string } | null = { channelId: 'UC-box-one', broadcastId: 'bc-1' };
    const routes = await laneRoutes(null, { youtube: { openBroadcast: () => open }, boxId: 'box-one' });
    const res = await routes.inject({ method: 'GET', url: '/api/youtube/open-broadcast' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ open: { boxId: 'box-one', channelId: 'UC-box-one', broadcastId: 'bc-1' } });
    open = null;
    expect((await routes.inject({ method: 'GET', url: '/api/youtube/open-broadcast' })).json()).toEqual({ open: null });
  });

  it('a box with no YouTube service answers null; the cloud has no box channel and answers 404', async () => {
    const none = await laneRoutes(null, { youtube: null });
    expect((await none.inject({ method: 'GET', url: '/api/youtube/open-broadcast' })).json()).toEqual({ open: null });
    const cloud = await laneRoutes(null, { role: 'cloud', youtube: { openBroadcast: () => ({ channelId: 'UC-x', broadcastId: 'bc-9' }) } });
    expect((await cloud.inject({ method: 'GET', url: '/api/youtube/open-broadcast' })).statusCode).toBe(404);
  });
});

// 2026.11.15, Lane B task O5: the claim of a live's upload is checked and taken in one step, names a recorded live on a
// box, is released when Google refuses, and is taken over from a device that went quiet for 30 minutes.
describe('O5: the upload claim', () => {
  async function boxRoutes(r: Rig, yt?: Partial<YoutubeService>): Promise<FastifyInstance> {
    const app = Fastify();
    app.decorateRequest('auth', null);
    app.decorateRequest('tenant', null);
    app.addHook('preHandler', async (request) => {
      const deviceId = request.headers['x-test-device'];
      (request as unknown as { auth: unknown }).auth = typeof deviceId === 'string' ? { kind: 'user', userId: 'u-test', deviceId } : null;
      (request as unknown as { tenant: unknown }).tenant = { surauId: 'sdm' };
    });
    const service = { signedIn: () => true, createResumableUpload: async () => ({ uploadUri: 'https://upload.invalid/x', expiresAt: '2026-11-12T00:00:00.000Z' }), ...yt } as unknown as YoutubeService;
    registerYoutubeCloudRoutes(app, { role: 'box', db: r.app.surau.db, now: r.clock.now, youtube: service, sweepMs: 0 });
    await app.ready();
    closers.push(() => app.close());
    return app;
  }
  const boxBegin = (app: FastifyInstance, r: Rig, device: string, over: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/api/youtube/upload/begin', headers: { 'x-test-device': device }, payload: { kuliahId: r.kuliahId, part: null, bytes: 1_000_000, replaceLiveVideoId: null, ...over } });
  const record = (r: Rig, id: string, surauId = 'sdm'): void =>
    createLiveSessionStore(r.app.surau.db).begin({
      id, surauId, boxId: 'a1b2c3d4e5f60718', ownerDeviceId: 'D1', startedBy: 'Pentadbir Ujian', kuliahId: null, source: 'android', video: 'phone', videoPath: 'device',
      outputs: { kiosk: true, youtube: true }, youtubeVia: 'device', youtubeChannelId: null, startedAt: '2026-11-05T11:00:00.000Z',
    });
  const ping = (app: FastifyInstance, device: string | null, uploadId: unknown) =>
    app.inject({ method: 'POST', url: '/api/youtube/upload/progress', headers: device === null ? {} : { 'x-test-device': device }, payload: { uploadId } });

  it('(a) I1: on a box a browser recording id, an old id with no live_sessions row and a recorded id are all accepted; the claim still locks one device per id', async () => {
    const r = await rig();
    const app = await boxRoutes(r);
    // the browser/iPad id: 's' + base36 time; and an id with the box's own shape that was recorded before live_sessions existed
    for (const id of ['smgx4k2a1', 'Ab3_dE-gH1jK2lMn']) {
      const first = await boxBegin(app, r, 'dev-1', { sessionId: id });
      expect(first.statusCode, id).toBe(200);
      expect(uploadRow(r, first.json().uploadId as string)).toMatchObject({ state: 'open', session_id: id });
      const second = await boxBegin(app, r, 'dev-2', { sessionId: id });
      expect(second.statusCode, id).toBe(409);
      expect(second.json().code).toBe('already_uploading');
    }
    record(r, 'live-real');
    const ok = await boxBegin(app, r, 'dev-1', { sessionId: 'live-real' });
    expect(ok.statusCode).toBe(200);
    expect(uploadRow(r, ok.json().uploadId as string)).toMatchObject({ state: 'open', session_id: 'live-real' });
    // no session id: unchanged
    expect((await boxBegin(app, r, 'dev-1')).statusCode).toBe(200);
  });

  it('(b) the claim exists before Google answers: a second device that begins while the first waits for Google is refused', async () => {
    const r = await rig();
    record(r, 'live-A');
    let release: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const app = await boxRoutes(r, { createResumableUpload: async () => (await slow, { uploadUri: 'https://upload.invalid/x', expiresAt: '2026-11-12T00:00:00.000Z' }) });
    const first = boxBegin(app, r, 'dev-1', { sessionId: 'live-A' });
    await vi.waitFor(() => expect(r.app.surau.db.prepare("SELECT COUNT(*) AS n FROM uploads WHERE session_id = 'live-A'").get()!.n).toBe(1));
    const second = await boxBegin(app, r, 'dev-2', { sessionId: 'live-A' });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'already_uploading', state: 'open' });
    release!();
    expect((await first).statusCode).toBe(200);
  });

  it('(b) if Google refuses, the claim row is released and the live is free for another device', async () => {
    const r = await rig();
    record(r, 'live-A');
    const failing = await boxRoutes(r, {
      createResumableUpload: async () => {
        throw new YoutubeError('quota');
      },
    });
    const refused = await boxBegin(failing, r, 'dev-1', { sessionId: 'live-A' });
    expect(refused.statusCode).not.toBe(200);
    expect(r.app.surau.db.prepare("SELECT COUNT(*) AS n FROM uploads WHERE session_id = 'live-A'").get()!.n).toBe(0);
    const fine = await boxRoutes(r);
    expect((await boxBegin(fine, r, 'dev-2', { sessionId: 'live-A' })).statusCode).toBe(200);
  });

  it('(c) a claim with no progress for 30 minutes is taken over (the old row becomes superseded); a progress ping keeps it', async () => {
    const r = await rig();
    record(r, 'live-A');
    const app = await boxRoutes(r);
    const first = (await boxBegin(app, r, 'dev-1', { sessionId: 'live-A' })).json().uploadId as string;
    r.clock.t += UPLOAD_STALE_MS - 60_000;
    expect((await boxBegin(app, r, 'dev-2', { sessionId: 'live-A' })).json().code).toBe('already_uploading');
    // the first device is still sending bytes and says so
    expect((await ping(app, 'dev-1', first)).json()).toEqual({ ok: true });
    r.clock.t += UPLOAD_STALE_MS - 60_000;
    expect((await boxBegin(app, r, 'dev-2', { sessionId: 'live-A' })).json().code).toBe('already_uploading');
    expect(uploadRow(r, first).state).toBe('open');
    // quiet for the whole 30 minutes: the second device takes over
    r.clock.t += 120_000;
    const taken = await boxBegin(app, r, 'dev-2', { sessionId: 'live-A' });
    expect(taken.statusCode).toBe(200);
    expect(uploadRow(r, first).state).toBe('superseded');
    expect(uploadRow(r, taken.json().uploadId as string)).toMatchObject({ state: 'open', device_id: 'dev-2' });
    // the first device can no longer ping; another device's ping does nothing; no device session is refused
    expect((await ping(app, 'dev-1', first)).json()).toEqual({ ok: false });
    expect((await ping(app, 'dev-1', taken.json().uploadId)).json()).toEqual({ ok: false });
    expect((await ping(app, null, first)).statusCode).toBe(403);
    expect((await ping(app, 'dev-2', 5)).statusCode).toBe(400);
  });

  it('(c) Q4: when Google refuses the takeover, the claim it superseded goes back to open with its last-progress time', async () => {
    const r = await rig();
    record(r, 'live-A');
    const app = await boxRoutes(r);
    const first = (await boxBegin(app, r, 'dev-1', { sessionId: 'live-A' })).json().uploadId as string;
    expect((await ping(app, 'dev-1', first)).json()).toEqual({ ok: true });
    const lastPing = String(uploadRow(r, first).finished_at);
    r.clock.t += UPLOAD_STALE_MS + 60_000;
    const failing = await boxRoutes(r, {
      createResumableUpload: async () => {
        throw new YoutubeError('quota');
      },
    });
    expect((await boxBegin(failing, r, 'dev-2', { sessionId: 'live-A' })).statusCode).not.toBe(200);
    expect(r.app.surau.db.prepare("SELECT COUNT(*) AS n FROM uploads WHERE device_id = 'dev-2'").get()!.n).toBe(0);
    expect(uploadRow(r, first)).toMatchObject({ state: 'open', finished_at: lastPing });
  });

  it('(c) S7, I8, F7: a claim that never pinged is kept for 6 hours, then taken over; the superseded device may still finish its upload', async () => {
    const r = await rig();
    record(r, 'live-A');
    const app = await boxRoutes(r);
    const first = (await boxBegin(app, r, 'dev-1', { sessionId: 'live-A' })).json().uploadId as string;
    // an older app never pings: 31 minutes, even 5 hours, do not make it dead
    r.clock.t += UPLOAD_STALE_MS + 60_000;
    expect((await boxBegin(app, r, 'dev-2', { sessionId: 'live-A' })).json().code).toBe('already_uploading');
    r.clock.t += 4 * 60 * 60_000;
    expect((await boxBegin(app, r, 'dev-2', { sessionId: 'live-A' })).json().code).toBe('already_uploading');
    expect(uploadRow(r, first).state).toBe('open');
    r.clock.t += 2 * 60 * 60_000;
    const taken = await boxBegin(app, r, 'dev-2', { sessionId: 'live-A' });
    expect(taken.statusCode).toBe(200);
    expect(uploadRow(r, first).state).toBe('superseded');
  });

  it('(c) S7: the done of a superseded claim is accepted (its video proves out) and the row is recorded as done', async () => {
    const r = await rig();
    record(r, 'live-A');
    const app = await boxRoutes(r, {
      videoOrigin: async () => ({ channelId: 'UC1', ownChannelId: 'UC1', publishedAt: new Date(r.clock.t + 1000).toISOString() }),
    } as unknown as Partial<YoutubeService>);
    const first = (await boxBegin(app, r, 'dev-1', { sessionId: 'live-A' })).json().uploadId as string;
    await ping(app, 'dev-1', first);
    r.clock.t += UPLOAD_STALE_MS + 60_000;
    expect((await boxBegin(app, r, 'dev-2', { sessionId: 'live-A' })).statusCode).toBe(200);
    expect(uploadRow(r, first).state).toBe('superseded');
    const fin = await app.inject({ method: 'POST', url: '/api/youtube/upload/done', headers: { 'x-test-device': 'dev-1' }, payload: { uploadId: first, videoId: 'NEWvideo123' } });
    expect(fin.statusCode).toBe(200);
    expect(fin.json()).toMatchObject({ state: 'done', videoId: 'NEWvideo123' });
    expect(uploadRow(r, first)).toMatchObject({ state: 'done', video_id: 'NEWvideo123' });
  });

  it('(c) a finished upload of the live is never taken over, however old', async () => {
    const r = await rig();
    record(r, 'live-A');
    const app = await boxRoutes(r);
    const first = (await boxBegin(app, r, 'dev-1', { sessionId: 'live-A' })).json().uploadId as string;
    r.app.surau.db.prepare("UPDATE uploads SET state = 'done', video_id = 'NEWvideo123' WHERE id = ?").run(first);
    r.clock.t += 3 * UPLOAD_STALE_MS;
    expect((await boxBegin(app, r, 'dev-2', { sessionId: 'live-A' })).json()).toMatchObject({ code: 'already_uploading', state: 'done' });
  });
});
