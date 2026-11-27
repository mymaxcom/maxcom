import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { CAMERA_PASSWORD_MASK } from '@surau/core';
import { createLimiters } from '../src/auth/authz.ts';
import { CameraStore, CameraTester } from '../src/live/camera.ts';
import type { MediamtxLogTail } from '../src/live/camera.ts';
import { registerCameraRoutes } from '../src/live/cameraRoutes.ts';
import { renderMediamtxConfig } from '../src/live/mediamtx.ts';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';
import { loginAs } from './authHelpers.ts';
import { changeLogText, startBody, startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';

const LAN = '10.168.1.40';
const ADDRESS = 'rtsp://viewer:lihat123@10.168.1.20:554/main';

const harnesses: LiveHarness[] = [];
const minis: FastifyInstance[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  for (const m of minis.splice(0)) await m.close();
});
async function make(o: Parameters<typeof startLiveHarness>[0] = {}): Promise<LiveHarness> {
  const h = await startLiveHarness(o);
  harnesses.push(h);
  return h;
}
const call = (h: LiveHarness, method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, headers: Record<string, string>, payload?: object) =>
  h.app.inject({ method, url, headers, remoteAddress: LAN, ...(payload !== undefined ? { payload } : {}) });

describe('roles on the live routes: Siaran Langsung in, Media out', () => {
  it('Media is refused on every live route; the live role and the administrator may use them', async () => {
    const h = await make();
    const media = await loginAs(h.app, 'media');
    const live = await loginAs(h.app, 'live');
    const admin = await loginAs(h.app, 'admin');
    const routes: Array<['GET' | 'POST' | 'PUT' | 'DELETE', string]> = [
      ['POST', '/api/live/start'],
      ['POST', '/api/live/stop'],
      ['GET', '/api/live/status'],
      ['GET', '/api/live/camera'],
      ['PUT', '/api/live/camera'],
      ['DELETE', '/api/live/camera'],
      ['POST', '/api/live/camera/test'],
      ['GET', '/api/live/camera/source'],
      ['POST', '/api/live/youtube/signin'],
      ['POST', '/api/live/youtube/signin/poll'],
      ['POST', '/api/live/youtube/signout'],
    ];
    for (const [m, u] of routes) {
      expect((await call(h, m, u, media.headers, m === 'GET' || m === 'DELETE' ? undefined : {})).statusCode, `media ${m} ${u}`).toBe(403);
      for (const who of [live, admin]) {
        const r = await call(h, m, u, who.headers, m === 'GET' || m === 'DELETE' ? undefined : {});
        expect([401, 403], `${who.roles.join()} ${m} ${u} (${r.body})`).not.toContain(r.statusCode);
      }
    }
  });

  it('the live role starts a live; Media is refused', async () => {
    const h = await make();
    const media = await loginAs(h.app, 'media');
    expect((await call(h, 'POST', '/api/live/start', media.headers, startBody(h))).statusCode).toBe(403);
    const live = await loginAs(h.app, 'live');
    expect((await call(h, 'POST', '/api/live/start', live.headers, startBody(h))).statusCode).toBe(200);
  });

  it('PUT /api/settings: the live role writes liveCamera and recording and nothing else; Media neither; admin unchanged', async () => {
    const h = await make();
    const live = await loginAs(h.app, 'live');
    const media = await loginAs(h.app, 'media');
    const admin = await loginAs(h.app, 'admin');
    expect((await call(h, 'PUT', '/api/settings/liveCamera', live.headers, { enabled: true, name: 'Kamera dewan' })).statusCode).toBe(200);
    expect((await call(h, 'PUT', '/api/settings/recording', live.headers, { keepOnDevice: true })).statusCode).toBe(200);
    expect((await call(h, 'PUT', '/api/settings/clock', live.headers, { enabled: true })).statusCode).toBe(403);
    expect((await call(h, 'PUT', '/api/settings/surauInfo', live.headers, {})).statusCode).toBe(403);
    expect((await call(h, 'PUT', '/api/settings/liveCamera', media.headers, { enabled: true })).statusCode).toBe(403);
    expect((await call(h, 'PUT', '/api/settings/recording', media.headers, { keepOnDevice: true })).statusCode).toBe(403);
    expect((await call(h, 'PUT', '/api/settings/liveCamera', admin.headers, { enabled: false })).statusCode).toBe(200);
    expect((await call(h, 'PUT', '/api/settings/clock', admin.headers, { enabled: true })).statusCode).not.toBe(403);
  });

  it('PUT /api/settings: odd spellings of a live feature do not open other features to the live role', async () => {
    const h = await make();
    const live = await loginAs(h.app, 'live');
    for (const url of ['/api/settings/liveCamera/', '/api/settings/live%43amera', '/API/settings/liveCamera', '/api/settings/liveCamera%2Fx', '/api/settings/livecamera', '/api/settings/clock%3FliveCamera', '/api/settings/clock?x=/api/settings/liveCamera']) {
      const r = await call(h, 'PUT', url, live.headers, { enabled: true });
      // a refusal (403) or no such route (404): never a write
      expect([200, 204], url).not.toContain(r.statusCode);
    }
    expect((await call(h, 'PUT', '/api/settings/clock?x=/api/settings/liveCamera', live.headers, { enabled: true })).statusCode).toBe(403);
  });
});

describe('camera routes on a real box app', () => {
  it('save, read back masked, clear; the password is in no answer, audit row or log', async () => {
    const h = await make();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const live = await loginAs(h.app, 'live');
      const empty = await call(h, 'GET', '/api/live/camera', live.headers);
      expect(empty.json()).toMatchObject({ configured: false, url: '', hasPassword: false });
      expect(empty.headers['cache-control']).toBe('no-store');

      const put = await call(h, 'PUT', '/api/live/camera', live.headers, { url: ADDRESS });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toMatchObject({ configured: true, url: `rtsp://viewer:${CAMERA_PASSWORD_MASK}@10.168.1.20:554/main`, username: 'viewer', hasPassword: true });
      expect(put.body).not.toContain('lihat123');

      const got = await call(h, 'GET', '/api/live/camera', live.headers);
      expect(got.body).not.toContain('lihat123');

      // the form sends the dots back: the stored password is kept
      const again = await call(h, 'PUT', '/api/live/camera', live.headers, { url: got.json().url });
      expect(again.statusCode).toBe(200);

      // an address the rules refuse is a 400 that does not echo it
      const bad = await call(h, 'PUT', '/api/live/camera', live.headers, { url: 'rtsp://8.8.8.8:554/x' });
      expect(bad.statusCode).toBe(400);
      expect(bad.body).not.toContain('8.8.8.8');
      // [L8] and says which rule (the app words it in its own language)
      expect(bad.json()).toMatchObject({ code: 'bad_address', detail: { reason: 'not_private' } });
      expect((await call(h, 'PUT', '/api/live/camera', live.headers, { url: 'rtsp://10.168.1.20/x' })).statusCode).toBe(200);
      expect((await call(h, 'PUT', '/api/live/camera', live.headers, [] as unknown as object)).statusCode).toBe(400);

      // back to the full address, then the phone's source read
      await call(h, 'PUT', '/api/live/camera', live.headers, { url: ADDRESS });
      const src = await call(h, 'GET', '/api/live/camera/source', live.headers);
      expect(src.statusCode).toBe(200);
      expect(src.json()).toEqual({ url: ADDRESS });
      expect(src.headers['cache-control']).toBe('no-store');

      const del = await call(h, 'DELETE', '/api/live/camera', live.headers);
      expect(del.json()).toMatchObject({ configured: false });
      expect((await call(h, 'GET', '/api/live/camera/source', live.headers)).statusCode).toBe(404);

      const audit = changeLogText(h.app);
      expect(audit).toContain('live-camera');
      expect(audit).toContain('source-read');
      expect(audit).not.toMatch(/lihat123/);
      expect(log.mock.calls.concat(warn.mock.calls).flat().join(' ')).not.toMatch(/lihat123/);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it('GET answers a Media user with 403 and Siaran Langsung with the masked record', async () => {
    const h = await make();
    const live = await loginAs(h.app, 'live');
    await call(h, 'PUT', '/api/live/camera', live.headers, { url: ADDRESS });
    const media = await loginAs(h.app, 'media');
    const r = await call(h, 'GET', '/api/live/camera', media.headers);
    expect(r.statusCode).toBe(403);
    expect(r.body).not.toMatch(/192\.168|lihat123/);
  });
});

/* ---------------------------------------------------------------- the test route, on a small app with a scripted MediaMTX */

async function mini(h: LiveHarness, o: { live?: boolean; replies?: Array<'ok' | 'login'> } = {}) {
  const store = new CameraStore(h.dataDir, { boxIps: [LAN] });
  const patches: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  let ready = false;
  let nextReply: 'ok' | 'login' = 'ok';
  const api = {
    async pathsPatch(_n: string, p: Record<string, unknown>): Promise<void> {
      patches.push(p);
      ready = false;
      if (p.source !== 'publisher') {
        if (nextReply === 'ok') ready = true;
        else lines.push('out 2026/11/17 06:37:18 ERR [path surau-uji] [RTSP source] bad status code: 401 (Unauthorized)');
      }
    },
    async pathGet() {
      return { ready, source: ready ? { type: 'rtspSource', id: '' } : null, readers: 0, bytesReceived: 0, tracks: ready ? ['H264', 'MPEG-4 Audio'] : [] };
    },
  };
  const log: MediamtxLogTail = { mark: () => lines.length, since: (m) => lines.slice(m) };
  const tester = new CameraTester({ api: () => api, log, readyTimeoutMs: 50, pollMs: 1, now: () => new Date('2026-11-17T08:00:00Z') });
  const app = Fastify();
  minis.push(app);
  app.addHook('onRequest', async (request) => {
    (request as { auth: unknown }).auth = { kind: 'user', userId: 'u1', deviceId: 'd1', roles: ['live'], sessionId: 's1', ops: false };
    (request as { tenant: unknown }).tenant = { surauId: LOCAL_SURAU_ID };
  });
  registerCameraRoutes(app, {
    db: h.app.surau.db,
    store,
    tester,
    sessions: { current: () => (o.live ? ({ id: 'x', deviceId: 'd9', source: 'android' } as never) : null) },
    limiters: createLimiters(),
    boxIps: [LAN],
  });
  await app.ready();
  return { app, store, patches, setReply: (r: 'ok' | 'login') => (nextReply = r) };
}

describe('POST /api/live/camera/test', () => {
  it('without a saved address: not_configured, nothing patched', async () => {
    const h = await make();
    const m = await mini(h);
    const r = await m.app.inject({ method: 'POST', url: '/api/live/camera/test', payload: {} });
    expect(r.json()).toMatchObject({ code: 'not_configured', ok: false });
    expect(m.patches).toEqual([]);
  });

  it('ok: fixed BM text, codecs, audio flag, the last test stored with the record, the path put back, no login anywhere', async () => {
    const h = await make();
    const m = await mini(h);
    m.store.save({ url: ADDRESS });
    const r = await m.app.inject({ method: 'POST', url: '/api/live/camera/test', payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ code: 'ok', ok: true, message: 'Berjaya. Kotak menerima gambar dari kamera.', hasAudio: true, codecs: ['H264', 'MPEG-4 Audio'], transport: 'tcp' });
    expect(r.body).not.toMatch(/lihat123|192\.168/);
    expect(m.store.lastTest).toMatchObject({ code: 'ok', hasAudio: true });
    expect(m.patches.at(-1)).toEqual({ source: 'publisher' });
    expect(changeLogText(h.app)).toContain("live-camera");
    expect(changeLogText(h.app)).not.toMatch(/lihat123/);
  });

  it('login failure: its own code and text; a transport asked for in the body is used', async () => {
    const h = await make();
    const m = await mini(h);
    m.store.save({ url: ADDRESS });
    m.setReply('login');
    const r = await m.app.inject({ method: 'POST', url: '/api/live/camera/test', payload: { transport: 'udp' } });
    expect(r.json()).toMatchObject({ code: 'login', message: 'Gagal: nama pengguna atau kata laluan salah', hasAudio: null });
    expect(m.patches[0]).toMatchObject({ rtspTransport: 'udp' });
    expect(m.store.lastTest).toMatchObject({ code: 'login' });
  });

  it('refused with 409 while a live runs, and nothing is patched', async () => {
    const h = await make();
    const m = await mini(h, { live: true });
    m.store.save({ url: ADDRESS });
    const r = await m.app.inject({ method: 'POST', url: '/api/live/camera/test', payload: {} });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: 'live_busy' });
    expect(m.patches).toEqual([]);
  });

  it('is limited to 6 a minute per session', async () => {
    const h = await make();
    const m = await mini(h);
    m.store.save({ url: ADDRESS });
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await m.app.inject({ method: 'POST', url: '/api/live/camera/test', payload: {} })).statusCode);
    expect(codes.slice(0, 6)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(codes.slice(6)).toEqual([429, 429]);
  });
});

describe('the MediaMTX configuration with a camera', () => {
  it('renders byte for byte the same with and without a saved camera; the address is never in the file', async () => {
    const h = await make();
    const render = (): string => renderMediamtxConfig({ dataDir: h.dataDir, lanIps: ['10.168.1.2'], password: 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6' });
    const before = render();
    new CameraStore(h.dataDir).save({ url: ADDRESS });
    expect(render()).toBe(before);
    expect(before).not.toMatch(/lihat123|rtsp:\/\/viewer/);
  });

  it('the template adds only the publisher paths of plan 4.6, the AAC rendition path and the two solo sound paths', () => {
    const t = readFileSync(new URL('../src/live/mediamtx.template.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const paths = t.slice(t.indexOf('\npaths:\n') + 8);
    const names = [...paths.matchAll(/^ {2}([A-Za-z0-9_-]+):\n {4}source: (\S+)/gm)].map((m) => [m[1], m[2]]);
    expect(names).toEqual([
      ['surau', 'publisher'],
      ['surau-kiosk', 'publisher'],
      ['surau-cam', 'publisher'],
      ['surau-mic', 'publisher'],
      ['surau-in', 'publisher'],
      ['surau-yt', 'publisher'],
      ['surau-snd', 'publisher'],
      ['surau-snd-aac', 'publisher'],
      ['surau-uji', 'publisher'],
    ]);
    expect(t).not.toMatch(/rtsp:\/\/\d/);
    expect(t).toMatch(/^rtmp: no$/m);
  });
});

// 2026.11.15, Lane A task A4 (C5 and the operator's camera-pull decision): who gets the full camera address while a
// live runs, the "camera in use" flag in the status, and joining the shared picture through the box.
describe('A4: camera/source during a live, the camera-in-use flag, joining the shared picture', () => {
  const SDP = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
  const whep = (h: LiveHarness, headers: Record<string, string>, method: 'POST' | 'DELETE', url: string) =>
    h.app.inject({ method, url, headers: method === 'POST' ? { ...headers, 'content-type': 'application/sdp' } : headers, ...(method === 'POST' ? { payload: SDP } : {}), remoteAddress: LAN });
  async function withCamera(o: Parameters<typeof startLiveHarness>[0] = {}): Promise<{ h: LiveHarness; owner: Awaited<ReturnType<typeof loginAs>>; other: Awaited<ReturnType<typeof loginAs>> }> {
    const h = await make(o);
    const owner = await loginAs(h.app, 'live');
    const other = await loginAs(h.app, 'live');
    expect((await call(h, 'PUT', '/api/live/camera', owner.headers, { url: ADDRESS })).statusCode).toBe(200);
    expect((await call(h, 'PUT', '/api/settings/liveCamera', owner.headers, { enabled: true })).statusCode).toBe(200);
    return { h, owner, other };
  }
  const external = (h: LiveHarness, over: Record<string, unknown> = {}) => startBody(h, { video: 'external', ...over });

  it('with no live anyone holding live:control reads the address (the phone reads it before it starts), and no flag is set', async () => {
    const { h, owner, other } = await withCamera();
    for (const who of [owner, other]) expect((await call(h, 'GET', '/api/live/camera/source', who.headers)).json()).toEqual({ url: ADDRESS });
    expect((await call(h, 'GET', '/api/live/status', owner.headers)).json().cameraUse).toEqual([]);
  });

  it('the starting phone pulls: it reads the address, the status flags the camera, a second device is refused with camera_in_use (success and refusal)', async () => {
    const { h, owner, other } = await withCamera();
    const start = await call(h, 'POST', '/api/live/start', owner.headers, external(h));
    expect(start.statusCode).toBe(200);
    expect(start.json().session).toMatchObject({ videoPath: 'device', mine: true });
    const mine = await call(h, 'GET', '/api/live/camera/source', owner.headers);
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toEqual({ url: ADDRESS });

    const flagOwner = (await call(h, 'GET', '/api/live/status', owner.headers)).json().cameraUse;
    const flagOther = (await call(h, 'GET', '/api/live/status', other.headers)).json().cameraUse;
    expect(flagOwner).toEqual([{ cameraId: 'external', sessionId: start.json().session.id, via: 'device', by: { name: expect.stringMatching(/^Peranti \d+$/), mine: true }, since: start.json().session.startedAt }]);
    expect(flagOther).toEqual([{ ...flagOwner[0], by: { name: flagOwner[0].by.name, mine: false } }]);
    // the flag names the device by its display name only
    expect(JSON.stringify(flagOther)).not.toContain(owner.deviceId);

    const refused = await call(h, 'GET', '/api/live/camera/source', other.headers);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('camera_in_use');
    expect(refused.body).not.toContain('lihat123');
    expect(refused.body).not.toContain('10.168.1.20');
    expect(refused.headers['cache-control']).toBe('no-store');
    // the refusal is on record, without the address
    const rows = h.app.surau.db.prepare("SELECT entity_id, after_json FROM change_log WHERE entity = 'live-camera' ORDER BY id").all() as Array<{ entity_id: string; after_json: string }>;
    expect(rows.at(-1)).toMatchObject({ entity_id: 'source-refused' });
    expect(JSON.parse(rows.at(-1)!.after_json)).toMatchObject({ code: 'camera_in_use' });
    expect(changeLogText(h.app)).not.toContain('lihat123');

    // the live ends: the flag clears and the address is readable again
    await call(h, 'POST', '/api/live/stop', owner.headers, {});
    expect((await call(h, 'GET', '/api/live/status', other.headers)).json().cameraUse).toEqual([]);
    expect((await call(h, 'GET', '/api/live/camera/source', other.headers)).statusCode).toBe(200);
  });

  it('C5: during a live on the phone camera another live:control device is refused (403); the owner switching to the camera mid-live reads it and sets the flag', async () => {
    const { h, owner, other } = await withCamera();
    await call(h, 'POST', '/api/live/start', owner.headers, startBody(h));
    const refused = await call(h, 'GET', '/api/live/camera/source', other.headers);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('not_owner');
    expect(refused.body).not.toContain('lihat123');
    expect((await call(h, 'GET', '/api/live/status', other.headers)).json().cameraUse).toEqual([]);
    h.clock.t += 5000;
    expect((await call(h, 'GET', '/api/live/camera/source', owner.headers)).json()).toEqual({ url: ADDRESS });
    const flag = (await call(h, 'GET', '/api/live/status', other.headers)).json().cameraUse;
    expect(flag).toMatchObject([{ cameraId: 'external', via: 'device', by: { mine: false }, since: new Date(h.clock.t).toISOString() }]);
    // now the camera is held: the second device gets the in-use answer
    expect((await call(h, 'GET', '/api/live/camera/source', other.headers)).json().code).toBe('camera_in_use');
  });

  it('a second device joins the shared picture through the box while the camera is in use, one viewer per device; not during a phone-camera live', async () => {
    const { h, owner, other } = await withCamera();
    const media = await loginAs(h.app, 'media');
    await call(h, 'POST', '/api/live/start', owner.headers, external(h));
    h.fake.webSessionId = 'join-1';
    const ok = await whep(h, other.headers, 'POST', '/api/live/preview/whep');
    expect(ok.statusCode).toBe(201);
    expect(ok.headers.location).toBe('/api/live/preview/whep/join-1');
    expect(h.fake.requests.some((q) => q.method === 'POST' && q.url === '/surau/whep')).toBe(true);
    // a second viewer of the same device replaces its first one
    h.fake.webSessionId = 'join-2';
    expect((await whep(h, other.headers, 'POST', '/api/live/preview/whep')).statusCode).toBe(201);
    expect(h.fake.requests.some((q) => q.method === 'DELETE' && q.url === '/surau/whep/join-1')).toBe(true);
    // each device closes only its own viewer
    expect((await whep(h, owner.headers, 'DELETE', '/api/live/preview/whep/join-2')).statusCode).toBe(404);
    expect((await whep(h, other.headers, 'DELETE', '/api/live/preview/whep/join-2')).statusCode).toBe(204);
    // Media has no live:control: refused at the door
    expect((await whep(h, media.headers, 'POST', '/api/live/preview/whep')).statusCode).toBe(403);
    // five further devices: four join, the fifth is told the picture has too many viewers
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const d = await loginAs(h.app, 'live');
      h.fake.webSessionId = `more-${i}`;
      codes.push((await whep(h, d.headers, 'POST', '/api/live/preview/whep')).statusCode);
    }
    expect(codes).toEqual([201, 201, 201, 201, 429]);

    await call(h, 'POST', '/api/live/stop', owner.headers, {});
    await h.app.liveSessions!.settled();
    await call(h, 'POST', '/api/live/start', owner.headers, startBody(h));
    const refused = await whep(h, other.headers, 'POST', '/api/live/preview/whep');
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('not_owner');
  });

  it('Q5: a joined device that went away without a DELETE loses its slot after the TTL, and its reader is closed; one that still polls keeps it', async () => {
    // the clock jumps half an hour here: the monitor is kept away, or it would end the pictureless live meanwhile
    const { h, owner } = await withCamera({ live: { monitorMs: 3_600_000 } });
    await call(h, 'POST', '/api/live/start', owner.headers, external(h));
    const devices: Array<Awaited<ReturnType<typeof loginAs>>> = [];
    for (let i = 0; i < 4; i++) {
      const d = await loginAs(h.app, 'live');
      devices.push(d);
      h.fake.webSessionId = `dead-${i}`;
      expect((await whep(h, d.headers, 'POST', '/api/live/preview/whep')).statusCode).toBe(201);
    }
    const fifth = await loginAs(h.app, 'live');
    h.fake.webSessionId = 'fifth-1';
    // the cap stands while the four are fresh
    expect((await whep(h, fifth.headers, 'POST', '/api/live/preview/whep')).json()).toMatchObject({ code: 'too_many_viewers' });
    // 20 minutes on, the first device still polls the status (its viewer is open); the other three are gone
    h.clock.t += 20 * 60 * 1000;
    expect((await call(h, 'GET', '/api/live/status', devices[0]!.headers)).statusCode).toBe(200);
    h.clock.t += 11 * 60 * 1000;
    const ok = await whep(h, fifth.headers, 'POST', '/api/live/preview/whep');
    expect(ok.statusCode).toBe(201);
    expect(ok.headers.location).toBe('/api/live/preview/whep/fifth-1');
    // the readers the dead devices left are closed at MediaMTX; the polling device keeps its own
    // (the close is not awaited by the route: it lands a moment later)
    await vi.waitFor(() => {
      for (const i of [1, 2, 3]) expect(h.fake.requests.some((q) => q.method === 'DELETE' && q.url === `/surau/whep/dead-${i}`)).toBe(true);
    }, 5000);
    expect(h.fake.requests.some((q) => q.method === 'DELETE' && q.url === '/surau/whep/dead-0')).toBe(false);
    expect((await whep(h, devices[0]!.headers, 'DELETE', '/api/live/preview/whep/dead-0')).statusCode).toBe(204);
    // the owner's own preview never counts as a joined device
    h.fake.webSessionId = 'own-1';
    expect((await whep(h, owner.headers, 'POST', '/api/live/preview/whep')).statusCode).toBe(201);
  });
});

// 2026.11.15, Lane B task O4: the pulling device releases the camera it holds.
describe('O4: POST /api/live/camera/release', () => {
  async function pulled(): Promise<{ h: LiveHarness; owner: Awaited<ReturnType<typeof loginAs>>; other: Awaited<ReturnType<typeof loginAs>>; sessionId: string }> {
    const h = await make();
    const owner = await loginAs(h.app, 'live');
    const other = await loginAs(h.app, 'live');
    expect((await call(h, 'PUT', '/api/live/camera', owner.headers, { url: ADDRESS })).statusCode).toBe(200);
    expect((await call(h, 'PUT', '/api/settings/liveCamera', owner.headers, { enabled: true })).statusCode).toBe(200);
    const start = await call(h, 'POST', '/api/live/start', owner.headers, startBody(h, { video: 'external' }));
    expect(start.statusCode).toBe(200);
    return { h, owner, other, sessionId: start.json().session.id as string };
  }

  it('the flag set by the owner own pull is cleared by release (204); the address is then not handed to a second device', async () => {
    const { h, owner, other, sessionId } = await pulled();
    expect((await call(h, 'GET', '/api/live/camera/source', owner.headers)).statusCode).toBe(200);
    expect((await call(h, 'GET', '/api/live/status', other.headers)).json().cameraUse).toHaveLength(1);
    const r = await call(h, 'POST', '/api/live/camera/release', owner.headers, { sessionId });
    expect(r.statusCode).toBe(204);
    expect((await call(h, 'GET', '/api/live/status', other.headers)).json().cameraUse).toEqual([]);
    // a repeat is a plain success
    expect((await call(h, 'POST', '/api/live/camera/release', owner.headers, { sessionId })).statusCode).toBe(204);
    // no address leaks through the other device after the release
    const again = await call(h, 'GET', '/api/live/camera/source', other.headers);
    expect(again.statusCode).toBe(403);
    expect(again.body).not.toContain('lihat123');
  });

  it('another device is refused and the flag stays; a wrong or missing session id is refused', async () => {
    const { h, owner, other, sessionId } = await pulled();
    await call(h, 'GET', '/api/live/camera/source', owner.headers);
    const refused = await call(h, 'POST', '/api/live/camera/release', other.headers, { sessionId });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('not_owner');
    expect((await call(h, 'GET', '/api/live/status', owner.headers)).json().cameraUse).toHaveLength(1);
    expect((await call(h, 'POST', '/api/live/camera/release', owner.headers, { sessionId: 'nope' })).json().code).toBe('no_session');
    expect((await call(h, 'POST', '/api/live/camera/release', owner.headers, {})).statusCode).toBe(400);
    const media = await loginAs(h.app, 'media');
    expect((await call(h, 'POST', '/api/live/camera/release', media.headers, { sessionId })).statusCode).toBe(403);
  });
});
