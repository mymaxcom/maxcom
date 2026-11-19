// Video upload hardening (qs-gate round 1): the MP4 walk is bounded, a file without a usable length is refused, one
// upload at a time with its bytes reserved, a per-upload deadline and minimum rate instead of lifting the server-wide
// time limit, a fresh upload is held until its item is saved, and the editor can drop a fresh pick.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import {
  defaultVideoLimits,
  dropFreshVideo,
  MAX_MOOV_BOXES,
  MAX_TOP_BOXES,
  readMp4Facts,
  receiveVideo,
  sweepVideoOrphans,
  videoDeadlineMs,
  videoStorage,
  VIDEO_HOLD_MS,
} from '../src/assets/video.ts';
import { exemptFromRequestTimeout, hardenServer } from '../src/serverLimits.ts';
import { withAdmin } from './authHelpers.ts';
import type { AdminApp } from './authHelpers.ts';
import { box, mp4 } from './support/mp4.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

function makeApp(): { app: AdminApp; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'surau-videogate-'));
  dirs.push(dir);
  const app = withAdmin(buildApp(join(dir, 'test.db'), { videoFree: () => 50 * 1024 * 1024 * 1024, videoLimits: defaultVideoLimits() }));
  apps.push(app);
  return { app, dir };
}

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'surau-videogate-f-'));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const factsOf = (b: Buffer) => {
  const p = join(tempDir(), 'x.mp4');
  writeFileSync(p, b);
  return readMp4Facts(p);
};
const up = (app: FastifyInstance, body: Buffer) =>
  app.inject({ method: 'POST', url: '/api/assets/video', headers: { 'content-type': 'video/mp4' }, payload: body });
const filesOf = (dir: string): string[] => (existsSync(join(dir, 'assets')) ? readdirSync(join(dir, 'assets')) : []);

/** A body that sends `first` and then nothing until `release()` (or `fail()`). */
function heldBody(first: Buffer, rest: Buffer = Buffer.alloc(0)): { stream: Readable; release: () => void; fail: () => void } {
  const stream = new Readable({ read() { /* pushed by hand */ } });
  stream.push(first);
  return {
    stream,
    release: () => {
      stream.push(rest);
      stream.push(null);
    },
    fail: () => stream.destroy(new Error('connection lost')),
  };
}

describe('S1: the MP4 walk is bounded', () => {
  it('refuses a file of thousands of tiny top-level boxes, and does it quickly', () => {
    const free8 = box('free');
    const flood = Array.from({ length: MAX_TOP_BOXES + 10 }, () => free8);
    const t0 = Date.now();
    expect(factsOf(mp4({ before: flood }))).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('still reads a normal file with an empty 8-byte free box (as encoders write)', () => {
    expect(factsOf(mp4({ before: [box('free')] }))).toMatchObject({ codec: 'avc1', durationSec: 30 });
  });

  it('refuses a top-level box (not mdat/free/skip/wide) with less than 8 bytes of payload', () => {
    expect(factsOf(mp4({ before: [box('uuid', Buffer.alloc(4))] }))).toBeNull();
    expect(factsOf(mp4({ before: [box('uuid', Buffer.alloc(16))] }))).not.toBeNull();
  });

  it('refuses a movie box holding more boxes than the cap', () => {
    const flood = Array.from({ length: MAX_MOOV_BOXES + 10 }, () => box('free'));
    expect(factsOf(mp4({ inMoov: flood }))).toBeNull();
  });
});

describe('S9: no usable length is refused', () => {
  it('no movie header, a time scale of 0 or a length of 0 (a fragmented file) is not a video the box takes', async () => {
    expect(factsOf(mp4({ mvhd: false }))).toBeNull();
    expect(factsOf(mp4({ timescale: 0 }))).toBeNull();
    expect(factsOf(mp4({ durationUnits: 0 }))).toBeNull();
    const { app, dir } = makeApp();
    const r = await up(app, mp4({ durationUnits: 0 }));
    expect([r.statusCode, r.json().code]).toEqual([400, 'not_h264']);
    expect(filesOf(dir)).toEqual([]);
  });
});

describe('S2 + Q7: one upload at a time, its bytes reserved', () => {
  it('a second upload while one runs is refused busy (409); the declared bytes count as used until the first ends', async () => {
    const { app, dir } = makeApp();
    const db = app.surau.db;
    const free = () => 50 * 1024 * 1024 * 1024;
    const body = mp4({ padding: 4000 });
    const before = videoStorage(db, dir, free).availableBytes;
    const held = heldBody(body.subarray(0, 100), body.subarray(100));
    const first = receiveVideo(db, dir, held.stream, body.length, 'test', { free });
    await new Promise((r) => setTimeout(r, 20));
    expect(videoStorage(db, dir, free).availableBytes).toBe(before - body.length);
    await expect(receiveVideo(db, dir, Readable.from([mp4({ salt: 9 })]), mp4({ salt: 9 }).length, 'test', { free })).rejects.toMatchObject({ code: 'busy', status: 409 });
    // over the route too, with the coded answer
    const r = await up(app, mp4({ salt: 8 }));
    expect([r.statusCode, r.json().code]).toEqual([409, 'busy']);
    held.release();
    await expect(first).resolves.toMatchObject({ created: true });
    // released: the room is the stored file only, and the next upload goes in
    expect(videoStorage(db, dir, free).availableBytes).toBe(before - body.length);
    expect((await up(app, mp4({ salt: 8 }))).statusCode).toBe(201);
  });

  it('a failed upload releases the lock and the reservation', async () => {
    const { app, dir } = makeApp();
    const db = app.surau.db;
    const free = () => 50 * 1024 * 1024 * 1024;
    const before = videoStorage(db, dir, free).availableBytes;
    const held = heldBody(Buffer.alloc(100));
    const first = receiveVideo(db, dir, held.stream, 5000, 'test', { free });
    await new Promise((r) => setTimeout(r, 20));
    held.fail();
    await expect(first).rejects.toMatchObject({ code: 'upload_failed' });
    expect(videoStorage(db, dir, free).availableBytes).toBe(before);
    expect((await up(app, mp4())).statusCode).toBe(201);
  });

  it('the quota check counts the reservation of a running upload', async () => {
    const dir = tempDir();
    const { app } = makeApp();
    const db = app.surau.db;
    const a = mp4({ padding: 3000, salt: 1 });
    const limits = { ...defaultVideoLimits(), totalBytes: a.length + 100 };
    const held = heldBody(a.subarray(0, 10), a.subarray(10));
    const first = receiveVideo(db, dir, held.stream, a.length, 'test', { limits, free: () => null });
    await new Promise((r) => setTimeout(r, 20));
    expect(videoStorage(db, dir, () => null, limits).availableBytes).toBe(100);
    held.release();
    await first;
  });
});

describe('S4: a per-upload deadline and minimum rate; the server-wide limit is never lifted', () => {
  it('the deadline is the declared size at 100 KB/s, between 2 and 30 minutes', () => {
    expect(videoDeadlineMs(1000)).toBe(2 * 60_000);
    expect(videoDeadlineMs(300 * 1024 * 1024)).toBe(30 * 60_000);
    expect(videoDeadlineMs(50 * 1024 * 1024)).toBe(512_000);
  });

  it('an upload past its deadline is cut off (408) and leaves nothing behind', async () => {
    const dir = tempDir();
    const { app } = makeApp();
    const held = heldBody(Buffer.alloc(100));
    await expect(receiveVideo(app.surau.db, dir, held.stream, 5000, 'test', { deadlineMs: 100, free: () => null })).rejects.toMatchObject({ code: 'upload_failed', status: 408 });
    expect(filesOf(dir)).toEqual([]);
  });

  it('an upload slower than the minimum rate over the window is cut off; a steady one is not', async () => {
    const dir = tempDir();
    const { app } = makeApp();
    const db = app.surau.db;
    const body = mp4({ padding: 4000 });
    const trickle = new Readable({ read() { /* timed */ } });
    let i = 0;
    const drip = setInterval(() => {
      if (i < body.length) trickle.push(body.subarray(i, i + 1));
      i += 1;
    }, 20);
    closers.push(() => clearInterval(drip));
    await expect(receiveVideo(db, dir, trickle, body.length, 'test', { free: () => null, minRate: { bytesPerSec: 1000, windowMs: 200 }, rateCheckMs: 20 })).rejects.toMatchObject({ code: 'upload_failed', status: 408 });
    clearInterval(drip);
    expect(filesOf(dir)).toEqual([]);
    await expect(receiveVideo(db, dir, Readable.from([body]), body.length, 'test', { free: () => null, minRate: { bytesPerSec: 1000, windowMs: 200 }, rateCheckMs: 20 })).resolves.toMatchObject({ created: true });
  });

  it('on a live socket, only the exempt request outlives the server time limit; the limit itself is never changed', async () => {
    const seen: string[] = [];
    let priorCalls = 0;
    const handler = (q: IncomingMessage, r: ServerResponse): void => {
      const release = q.url === '/up' ? exemptFromRequestTimeout(q.socket) : () => undefined;
      if (q.url === '/up') seen.push(`limit-during-upload:${server.requestTimeout}`);
      q.on('data', () => undefined);
      q.on('end', () => {
        release();
        r.end('ok');
      });
      q.on('error', () => undefined);
    };
    const server = createServer(handler);
    // a listener installed before (Fastify's) keeps answering every other client error
    server.on('clientError', (_err, socket) => {
      priorCalls++;
      socket.destroy();
    });
    hardenServer(server);
    // (Node applies the request limit only when it is not below the header limit, as on the box: 10 s and 30 s)
    server.headersTimeout = 800;
    server.requestTimeout = 800;
    (server as { connectionsCheckingInterval?: number }).connectionsCheckingInterval = 100;
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    closers.push(() => new Promise<void>((res) => server.close(() => res())));
    const port = (server.address() as AddressInfo).port;
    const slowPost = (path: string): Promise<string> =>
      new Promise((resolve) => {
        const s = netConnect(port, '127.0.0.1', () => {
          s.write(`POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nConnection: close\r\n\r\n`);
          let n = 0;
          const iv = setInterval(() => {
            if (s.destroyed) return clearInterval(iv);
            s.write('a');
            if (++n === 5) clearInterval(iv);
          }, 400);
        });
        let got = '';
        s.on('data', (d) => (got += d.toString('latin1')));
        s.on('error', () => undefined);
        s.on('close', () => resolve(got.split('\r\n')[0] ?? ''));
      });
    const [upload, other] = await Promise.all([slowPost('/up'), slowPost('/other')]);
    expect(upload).toBe('HTTP/1.1 200 OK');
    expect(other).toBe('');
    expect(priorCalls).toBeGreaterThanOrEqual(1);
    expect(seen).toEqual(['limit-during-upload:800']);
    expect(server.requestTimeout).toBe(800);
  }, 20_000);

  it('the box server answers a slow upload past its 30 s limit stand-in, and still cuts a slow other request', async () => {
    const { app } = makeApp();
    const headers = (await app.admin()).headers;
    await app.ready();
    app.server.headersTimeout = 800;
    app.server.requestTimeout = 800;
    (app.server as { connectionsCheckingInterval?: number }).connectionsCheckingInterval = 100;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const body = mp4({ padding: 400 });
    const slow = (method: string, path: string, type: string, payload: Buffer): Promise<string> =>
      new Promise((resolve) => {
        const s = netConnect(port, '127.0.0.1', () => {
          s.write(`${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: ${headers.authorization}\r\nContent-Type: ${type}\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`);
          const parts = [0, 4, 8, 12, 16].map((at, i, all) => payload.subarray(at, i === all.length - 1 ? payload.length : all[i + 1]));
          const iv = setInterval(() => {
            if (s.destroyed) return clearInterval(iv);
            const next = parts.shift();
            if (next === undefined) return clearInterval(iv);
            s.write(next);
          }, 400);
        });
        let got = '';
        s.on('data', (d) => (got += d.toString('latin1')));
        s.on('error', () => undefined);
        s.on('close', () => resolve(got.split('\r\n')[0] ?? ''));
      });
    const [video, other] = await Promise.all([
      slow('POST', '/api/assets/video', 'video/mp4', body),
      slow('PUT', '/api/content/penceramah/p1', 'application/json', Buffer.from(JSON.stringify({ name: 'Ustaz Lambat' }))),
    ]);
    expect(video).toBe('HTTP/1.1 201 Created');
    expect(other).toMatch(/^HTTP\/1\.1 408|^$/);
    expect(app.server.requestTimeout).toBe(800);
  }, 20_000);
});

describe('S3: a matched (deduplicated) upload is held until its item is saved', () => {
  const item = (assetId: string, extra: Record<string, unknown> = {}) => ({
    title: 'Selamat datang', source: 'upload', assetId, days: ['umum'], order: 1, durationSec: 30, ...extra,
  });
  const put = (app: FastifyInstance, id: string, body: unknown) => app.inject({ method: 'PUT', url: `/api/content/video/${id}`, payload: body as object });

  it('an item replaced while another editor has just uploaded the same file keeps the file for that editor', async () => {
    const { app, dir } = makeApp();
    const x = mp4({ salt: 1 });
    const y = mp4({ salt: 2 });
    const idX = (await up(app, x)).json().id as string;
    expect((await put(app, 'v1', item(idX))).statusCode).toBe(201);
    // editor 2 picks the same file: matched, not stored twice
    expect((await up(app, x)).json().created).toBe(false);
    // editor 1 replaces v1's video: X is no longer in an item, but editor 2 holds it
    const idY = (await up(app, y)).json().id as string;
    expect((await put(app, 'v1', item(idY))).statusCode).toBe(200);
    expect(filesOf(dir)).toContain(`${idX}.mp4`);
    // editor 2 saves its item: the file is there
    expect((await put(app, 'v2', item(idX, { title: 'Kedua' }))).statusCode).toBe(201);
  });

  it('the match marks the row fresh, so a sweep does not take it either', async () => {
    const { app, dir } = makeApp();
    const db = app.surau.db;
    const x = mp4({ salt: 3 });
    const id = (await up(app, x)).json().id as string;
    db.prepare('UPDATE assets SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', id);
    expect((await up(app, x)).json().created).toBe(false);
    expect(String(db.prepare('SELECT created_at FROM assets WHERE id = ?').get(id)?.created_at) > '2026-01-01').toBe(true);
    expect(sweepVideoOrphans(db, dir, 60 * 60_000)).toBe(0);
    expect(filesOf(dir)).toContain(`${id}.mp4`);
    // once the hold and the fresh age have both passed, an unused video goes
    expect(sweepVideoOrphans(db, dir, 60 * 60_000, new Date(Date.now() + VIDEO_HOLD_MS + 2 * 60 * 60_000))).toBe(1);
  });
});

describe('Q3: the editor drops a fresh pick; the box sweeps every 6 hours', () => {
  const drop = (app: FastifyInstance, id: string) => app.inject({ method: 'DELETE', url: `/api/assets/video/${id}` });

  it('DELETE removes an unused video younger than a day; keeps one in use, an old one, or one another editor holds', async () => {
    const { app, dir } = makeApp();
    const db = app.surau.db;
    const a = (await up(app, mp4({ salt: 1 }))).json().id as string;
    expect((await drop(app, a)).json()).toEqual({ removed: true });
    expect(filesOf(dir)).toEqual([]);
    expect((await drop(app, a)).statusCode).toBe(404);
    expect((await drop(app, 'not-an-id')).statusCode).toBe(404);

    const b = (await up(app, mp4({ salt: 2 }))).json().id as string;
    await app.inject({ method: 'PUT', url: '/api/content/video/v1', payload: { title: 'T', source: 'upload', assetId: b, days: ['umum'], order: 1, durationSec: 30 } });
    expect((await drop(app, b)).json()).toEqual({ removed: false });

    // two editors matched the same file: the first drop leaves it for the second
    const c = mp4({ salt: 3 });
    const idC = (await up(app, c)).json().id as string;
    await up(app, c);
    expect((await drop(app, idC)).json()).toEqual({ removed: false });
    expect((await drop(app, idC)).json()).toEqual({ removed: true });

    const d = (await up(app, mp4({ salt: 4 }))).json().id as string;
    expect(dropFreshVideo(db, dir, d, new Date(Date.now() + 25 * 60 * 60_000))).toEqual({ found: true, removed: false });
  });

  it('DELETE needs assets:write', async () => {
    const { app } = makeApp();
    const r = await app.inject({ method: 'DELETE', url: `/api/assets/video/${'a'.repeat(64)}`, headers: { authorization: 'Bearer nobody' } });
    expect([401, 403]).toContain(r.statusCode);
  });

  it('a box with a data folder sweeps on a timer, not only at start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-videosweep-'));
    dirs.push(dir);
    const app = withAdmin(buildApp(join(dir, 'box.db'), { dataDir: dir, videoFree: () => 50 * 1024 * 1024 * 1024, videoSweepMs: 50 }));
    apps.push(app);
    await app.ready();
    const id = (await up(app, mp4({ salt: 5 }))).json().id as string;
    // an abandoned upload two days old, held by nobody
    dropFreshVideo(app.surau.db, dir, id, new Date(Date.now() + 3 * 24 * 60 * 60_000));
    app.surau.db.prepare('UPDATE assets SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', id);
    const end = Date.now() + 3000;
    while (filesOf(dir).includes(`${id}.mp4`) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(filesOf(dir)).not.toContain(`${id}.mp4`);
  });
});
