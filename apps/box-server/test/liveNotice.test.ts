import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { KioskLive } from '@surau/core';
import { loginAs } from './authHelpers.ts';
import { startBody, startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';

const LAN = '10.168.1.40';
const VID = 'dQw4w9WgXcQ';
const WATCH = `https://www.youtube.com/live/${VID}`;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

const harnesses: LiveHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

interface Spawned {
  cmd: string;
  args: string[];
}

/** An ffmpeg stand-in: `jpeg` null answers with garbage and exit 1. */
function standIn(spawned: Spawned[], jpeg: Buffer | null, delayMs = 0) {
  return (cmd: string, args: string[]) => {
    spawned.push({ cmd, args });
    const proc = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => void };
    proc.stdout = new PassThrough();
    proc.kill = () => undefined;
    setTimeout(() => {
      proc.stdout.write(jpeg !== null ? jpeg : Buffer.from('nope'));
      proc.stdout.end();
      proc.emit('close', jpeg !== null ? 0 : 1);
    }, delayMs);
    return proc as never;
  };
}

async function make(spawned: Spawned[] = [], jpeg: Buffer | null = JPEG, delayMs = 0): Promise<LiveHarness> {
  const h = await startLiveHarness({ live: { frame: { spawnFn: standIn(spawned, jpeg, delayMs) } } });
  harnesses.push(h);
  return h;
}

async function startYoutubeLive(h: LiveHarness, ready = true) {
  const user = await loginAs(h.app, 'live');
  const r = await h.app.inject({ method: 'POST', url: '/api/live/start', headers: user.headers, payload: startBody(h), remoteAddress: LAN });
  expect(r.statusCode).toBe(200);
  const sessions = h.app.liveSessions as unknown as { session: { watchUrl: string | null; broadcastId: string | null } };
  sessions.session.watchUrl = `https://www.youtube.com/watch?v=${VID}`;
  sessions.session.broadcastId = VID;
  if (ready) {
    h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1', bytesReceived: 5 });
    const end = Date.now() + 3000;
    while (!h.app.liveSessions!.kioskLive().live && Date.now() < end) await new Promise((x) => setTimeout(x, 10));
  }
  return user;
}

type Who = { headers: { authorization: string } };
const get = (h: LiveHarness, user: Who, url: string) => h.app.inject({ method: 'GET', url, headers: user.headers, remoteAddress: LAN });
const patch = (h: LiveHarness, user: Who, payload: unknown) =>
  h.app.inject({ method: 'PATCH', url: '/api/live/notice', headers: user.headers, payload: payload as never, remoteAddress: LAN });

describe('GET/PATCH /api/live/notice', () => {
  it('is inactive with no live, and without a YouTube watch link', async () => {
    const h = await make();
    const user = await loginAs(h.app, 'live');
    expect((await get(h, user, '/api/live/notice')).json()).toEqual({ active: false });
    await h.app.inject({ method: 'POST', url: '/api/live/start', headers: user.headers, payload: startBody(h), remoteAddress: LAN });
    expect((await get(h, user, '/api/live/notice')).json()).toEqual({ active: false });
    expect((await patch(h, user, { editedText: `x ${WATCH}` })).statusCode).toBe(404);
  });

  it('describes the live, and a second admin sees the first one edit (last edit wins)', async () => {
    const h = await make();
    const a = await startYoutubeLive(h);
    const b = await loginAs(h.app, 'admin');
    const n = (await get(h, b, '/api/live/notice')).json();
    expect(n).toMatchObject({
      active: true,
      videoId: VID,
      watchUrl: WATCH,
      kuliah: { title: 'Kuliah Maghrib', speaker: 'Ustaz Ahmad Fauzi', time: '19:15' },
      editedText: null,
      editedBy: null,
      editedAt: null,
      frame: true,
    });
    expect((h.app.liveSessions!.kioskLive() as KioskLive).noticeRev).toBeUndefined();
    expect((await get(h, a, '/api/live/status')).json().noticeRev).toBeUndefined();
    const e1 = await patch(h, a, { editedText: `Siaran: ${WATCH}` });
    expect(e1.statusCode).toBe(200);
    expect(e1.json()).toMatchObject({ editedText: `Siaran: ${WATCH}` });
    expect(typeof e1.json().editedBy).toBe('string');
    const rev1 = (h.app.liveSessions!.kioskLive() as KioskLive).noticeRev;
    expect(typeof rev1).toBe('number');
    expect((await get(h, a, '/api/live/status')).json().noticeRev).toBe(rev1);
    const e2 = await patch(h, b, { editedText: `Kedua ${WATCH}` });
    expect(e2.json().editedText).toBe(`Kedua ${WATCH}`);
    expect((h.app.liveSessions!.kioskLive() as KioskLive).noticeRev!).toBeGreaterThan(rev1!);
    expect((await get(h, a, '/api/live/status')).json().noticeRev).toBe((h.app.liveSessions!.kioskLive() as KioskLive).noticeRev);
    expect((await get(h, a, '/api/live/notice')).json().editedText).toBe(`Kedua ${WATCH}`);
    // null = back to the original
    const e3 = await patch(h, a, { editedText: null });
    expect(e3.json()).toMatchObject({ editedText: null, editedBy: null, editedAt: null });
    expect((h.app.liveSessions!.kioskLive() as KioskLive).noticeRev).toBeUndefined();
    expect((await get(h, a, '/api/live/status')).json().noticeRev).toBeUndefined();
  });

  it('refuses a text without the watch link, an empty one, one over 1000 characters, a control character and a bad body', async () => {
    const h = await make();
    const a = await startYoutubeLive(h);
    const bad = [{ editedText: 'tiada pautan' }, { editedText: '' }, { editedText: `${WATCH} ${'a'.repeat(1000)}` }, { editedText: 5 }, {}, { editedText: `${WATCH}${String.fromCharCode(0)}` }];
    for (const payload of bad) expect((await patch(h, a, payload)).statusCode).toBe(400);
    expect((await get(h, a, '/api/live/notice')).json().editedText).toBeNull();
  });

  it('ends with the live', async () => {
    const h = await make();
    const a = await startYoutubeLive(h);
    await patch(h, a, { editedText: WATCH });
    await h.app.inject({ method: 'POST', url: '/api/live/stop', headers: a.headers, payload: {}, remoteAddress: LAN });
    expect((await get(h, a, '/api/live/notice')).json()).toEqual({ active: false });
    expect((await get(h, a, '/api/live/status')).json().noticeRev).toBeUndefined();
  });

  it('needs live:control (a role without it, and no sign-in, are refused)', async () => {
    const h = await make();
    await startYoutubeLive(h);
    const ajk = await loginAs(h.app, 'ajk');
    expect((await get(h, ajk, '/api/live/notice')).statusCode).toBe(403);
    expect((await patch(h, ajk, { editedText: WATCH })).statusCode).toBe(403);
    expect((await get(h, ajk, '/api/live/notice/frame.jpg')).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'GET', url: '/api/live/notice', remoteAddress: LAN })).statusCode).toBe(401);
  });
});

describe('GET /api/live/notice/frame.jpg', () => {
  it('is 404 with no live, and 404 while no picture is ready (nothing is spawned)', async () => {
    const spawned: Spawned[] = [];
    const h = await make(spawned);
    const user = await loginAs(h.app, 'live');
    expect((await get(h, user, '/api/live/notice/frame.jpg')).statusCode).toBe(404);
    await startYoutubeLive(h, false);
    expect((await get(h, user, '/api/live/notice')).json().frame).toBe(false);
    expect((await get(h, user, '/api/live/notice/frame.jpg')).statusCode).toBe(404);
    expect(spawned).toHaveLength(0);
  });

  it('returns the JPEG with a 30 s private cache, decodes one frame, and keeps the address out of the answers', async () => {
    const spawned: Spawned[] = [];
    const h = await make(spawned);
    const user = await startYoutubeLive(h);
    const r = await get(h, user, '/api/live/notice/frame.jpg');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(r.headers['cache-control']).toBe('private, max-age=30');
    expect(r.rawPayload.equals(JPEG)).toBe(true);
    const args = spawned[0]!.args;
    expect(args).toContain('-frames:v');
    expect(args).toContain('mjpeg');
    expect(args).toContain('-map_metadata');
    expect(args).not.toContain('-vf');
    expect(args.some((a) => a.includes('scale'))).toBe(false);
    expect(args).not.toContain('-pix_fmt');
    const url = args.find((a) => a.startsWith('rtsp://'))!;
    expect(url).toMatch(/^rtsp:\/\/frm[0-9a-f]+:[0-9a-f]+@127\.0\.0\.1:8554\/surau$/);
    const secret = url.slice('rtsp://'.length, url.indexOf('@'));
    expect(JSON.stringify(r.headers)).not.toContain(secret);
    expect((await get(h, user, '/api/live/notice')).body).not.toContain('rtsp');
    // the short-lived MediaMTX user is gone again
    expect(JSON.stringify(h.fake.global.authInternalUsers)).not.toContain('frm');
  });

  it('caches for 30 s and runs one ffmpeg for concurrent requests', async () => {
    const spawned: Spawned[] = [];
    const h = await make(spawned, JPEG, 60);
    const user = await startYoutubeLive(h);
    const rs = await Promise.all([1, 2, 3, 4].map(() => get(h, user, '/api/live/notice/frame.jpg')));
    expect(rs.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
    expect(spawned).toHaveLength(1);
    await get(h, user, '/api/live/notice/frame.jpg');
    expect(spawned).toHaveLength(1);
  });

  it('is 404 when ffmpeg cannot decode a frame, and a failure is not retried at once', async () => {
    const spawned: Spawned[] = [];
    const h = await make(spawned, null);
    const user = await startYoutubeLive(h);
    expect((await get(h, user, '/api/live/notice/frame.jpg')).statusCode).toBe(404);
    expect((await get(h, user, '/api/live/notice/frame.jpg')).statusCode).toBe(404);
    expect(spawned).toHaveLength(1);
    expect((await get(h, user, '/api/live/notice')).json().frame).toBe(false);
  });
});
