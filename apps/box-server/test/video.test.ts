import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { VIDEO_LIMITS, resolveSettings } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { defaultVideoLimits, readMp4Facts, receiveVideo, sweepVideoOrphans } from '../src/assets/video.ts';
import { parseRange } from '../src/assets/videoServe.ts';
import { buildKioskContent } from '../src/kioskContent.ts';
import { CSP, KIOSK_CSP } from '../src/securityHeaders.ts';
import { withAdmin } from './authHelpers.ts';
import type { AdminApp } from './authHelpers.ts';
import { mp4 } from './support/mp4.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];

interface Opts { free?: number | null; limits?: Partial<ReturnType<typeof defaultVideoLimits>> }
function makeApp(o: Opts = {}): { app: AdminApp; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'surau-video-'));
  dirs.push(dir);
  const app = withAdmin(buildApp(join(dir, 'test.db'), {
    videoFree: () => (o.free === undefined ? 50 * 1024 * 1024 * 1024 : o.free),
    videoLimits: { ...defaultVideoLimits(), ...o.limits },
  }));
  apps.push(app);
  return { app, dir };
}

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const up = (app: FastifyInstance, body: Buffer) =>
  app.inject({ method: 'POST', url: '/api/assets/video', headers: { 'content-type': 'video/mp4' }, payload: body });
const filesOf = (dir: string): string[] => (existsSync(join(dir, 'assets')) ? readdirSync(join(dir, 'assets')) : []);
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

describe('video upload', () => {
  it('stores an H.264 MP4 by hash, answers its facts and dedupes', async () => {
    const { app, dir } = makeApp();
    const body = mp4({ seconds: 42.4 });
    const first = await up(app, body);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ id: sha(body), mime: 'video/mp4', bytes: body.length, width: 1280, height: 720, durationSec: 42, created: true });
    expect(filesOf(dir)).toEqual([`${sha(body)}.mp4`]);
    const again = await up(app, body);
    expect(again.statusCode).toBe(200);
    expect(again.json().created).toBe(false);
    expect(filesOf(dir)).toEqual([`${sha(body)}.mp4`]);
  });

  it('reads the facts when the movie box comes after the media', () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-mp4-'));
    dirs.push(dir);
    const p = join(dir, 'x.mp4');
    writeFileSync(p, mp4({ moovLast: true, padding: 5000 }));
    expect(readMp4Facts(p)).toMatchObject({ codec: 'avc1', width: 1280, height: 720, durationSec: 30 });
  });

  it('refuses what is not an H.264 MP4, with a coded error and no file left', async () => {
    const { app, dir } = makeApp();
    for (const body of [Buffer.from('not a video at all'), mp4({ codec: 'hvc1' }), mp4({ codec: 'vp09' })]) {
      const r = await up(app, body);
      expect(r.statusCode).toBe(400);
      expect(r.json().code).toBe('not_h264');
    }
    expect(filesOf(dir)).toEqual([]);
  });

  it('refuses a video that is too long or larger than 720p', async () => {
    const { app, dir } = makeApp();
    const long = await up(app, mp4({ seconds: VIDEO_LIMITS.maxSeconds + 30 }));
    expect([long.statusCode, long.json().code]).toEqual([400, 'too_long']);
    const big = await up(app, mp4({ width: 1920, height: 1080 }));
    expect([big.statusCode, big.json().code]).toEqual([413, 'too_big']);
    expect((await up(app, mp4({ seconds: VIDEO_LIMITS.maxSeconds }))).statusCode).toBe(201);
    expect((await up(app, mp4({ width: 720, height: 1280, salt: 2 }))).statusCode).toBe(201); // portrait 720p
    expect(filesOf(dir)).toHaveLength(2);
  });

  it('refuses a file over the size cap before reading it', async () => {
    const { app, dir } = makeApp({ limits: { maxFileBytes: 1000 } });
    const r = await up(app, mp4({ padding: 5000 }));
    expect([r.statusCode, r.json().code]).toEqual([413, 'too_big']);
    expect(filesOf(dir)).toEqual([]);
  });

  it('keeps to the total quota and to the free space the box must keep', async () => {
    const a = mp4({ padding: 3000, salt: 1 });
    const b = mp4({ padding: 3000, salt: 2 });
    const quota = makeApp({ limits: { totalBytes: a.length + 100 } });
    expect((await up(quota.app, a)).statusCode).toBe(201);
    const second = await up(quota.app, b);
    expect([second.statusCode, second.json().code]).toEqual([413, 'no_space']);

    const disk = makeApp({ free: VIDEO_LIMITS.minFreeBytes + a.length - 1 });
    const r = await up(disk.app, a);
    expect([r.statusCode, r.json().code]).toEqual([413, 'no_space']);
    expect(filesOf(disk.dir)).toEqual([]);
    const ok = makeApp({ free: VIDEO_LIMITS.minFreeBytes + a.length });
    expect((await up(ok.app, a)).statusCode).toBe(201);
  });

  it('leaves no partial file when the upload is cut off, is shorter than it said, or is longer', async () => {
    const { app, dir } = makeApp();
    const db = app.surau.db;
    const body = mp4({ padding: 4000 });
    const cut = new Readable({ read() { /* nothing more comes */ } });
    cut.push(body.subarray(0, 100));
    setImmediate(() => cut.destroy(new Error('connection lost')));
    await expect(receiveVideo(db, dir, cut, body.length, 'test')).rejects.toMatchObject({ code: 'upload_failed' });
    await expect(receiveVideo(db, dir, Readable.from([body.subarray(0, 500)]), body.length, 'test')).rejects.toMatchObject({ code: 'upload_failed' });
    await expect(receiveVideo(db, dir, Readable.from([body]), body.length - 10, 'test')).rejects.toMatchObject({ code: 'too_big' });
    await expect(receiveVideo(db, dir, Readable.from([body]), null, 'test')).rejects.toMatchObject({ code: 'upload_failed' });
    expect(filesOf(dir)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM assets WHERE mime = 'video/mp4'").get()?.n).toBe(0);
  });

  it('answers the room left for videos', async () => {
    const { app } = makeApp({ free: 1024 * 1024 * 1024 });
    const r = await app.inject({ method: 'GET', url: '/api/assets/video/storage' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ usedBytes: 0, totalBytes: VIDEO_LIMITS.totalBytes, availableBytes: 1024 * 1024 * 1024 - VIDEO_LIMITS.minFreeBytes, maxSeconds: 600 });
  });
});

describe('serving a video', () => {
  it('sends the whole file, a range (206) and refuses a range outside it (416)', async () => {
    const { app } = makeApp();
    const body = mp4({ padding: 2000 });
    const { id } = (await up(app, body)).json();
    const full = await app.inject({ method: 'GET', url: `/assets/${id}` });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('video/mp4');
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(Buffer.from(full.rawPayload).equals(body)).toBe(true);
    const part = await app.inject({ method: 'GET', url: `/assets/${id}`, headers: { range: 'bytes=10-99' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 10-99/${body.length}`);
    expect(Buffer.from(part.rawPayload).equals(body.subarray(10, 100))).toBe(true);
    const tail = await app.inject({ method: 'GET', url: `/assets/${id}`, headers: { range: 'bytes=-50' } });
    expect(tail.statusCode).toBe(206);
    expect(Buffer.from(tail.rawPayload).equals(body.subarray(body.length - 50))).toBe(true);
    const open = await app.inject({ method: 'GET', url: `/assets/${id}`, headers: { range: `bytes=${body.length - 5}-` } });
    expect(open.statusCode).toBe(206);
    const bad = await app.inject({ method: 'GET', url: `/assets/${id}`, headers: { range: `bytes=${body.length}-` } });
    expect(bad.statusCode).toBe(416);
    expect(bad.headers['content-range']).toBe(`bytes */${body.length}`);
  });

  it('parses ranges', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=5-2', 100)).toBe('bad');
    expect(parseRange('bytes=-', 100)).toBe('bad');
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
  });
});

describe('video items and their files', () => {
  const item = (assetId: string, extra: Record<string, unknown> = {}) => ({
    title: 'Selamat datang', source: 'upload', assetId, days: ['umum'], order: 1, durationSec: 30, ...extra,
  });
  const put = (app: FastifyInstance, id: string, body: unknown) => app.inject({ method: 'PUT', url: `/api/content/video/${id}`, payload: body as object });

  it('deletes the file when its item is deleted, keeps it while another item uses it', async () => {
    const { app, dir } = makeApp();
    const { id: asset } = (await up(app, mp4())).json();
    expect((await put(app, 'v1', item(asset))).statusCode).toBe(201);
    expect((await put(app, 'v2', item(asset, { title: 'Salinan' }))).statusCode).toBe(201);
    expect((await app.inject({ method: 'DELETE', url: '/api/content/video/v1' })).statusCode).toBe(204);
    expect(filesOf(dir)).toEqual([`${asset}.mp4`]);
    expect((await app.inject({ method: 'DELETE', url: '/api/content/video/v2' })).statusCode).toBe(204);
    expect(filesOf(dir)).toEqual([]);
    expect(app.surau.db.prepare('SELECT 1 FROM assets WHERE id = ?').get(asset)).toBeUndefined();
  });

  it('deletes the old file when the item is saved with another file', async () => {
    const { app, dir } = makeApp();
    const a = (await up(app, mp4({ salt: 1 }))).json().id as string;
    const b = (await up(app, mp4({ salt: 2 }))).json().id as string;
    await put(app, 'v1', item(a));
    expect((await put(app, 'v1', item(b))).statusCode).toBe(200);
    expect(filesOf(dir)).toEqual([`${b}.mp4`]);
  });

  it('refuses an upload item whose file is not on the box', async () => {
    const { app } = makeApp();
    const r = await put(app, 'v1', item('c'.repeat(64)));
    expect(r.statusCode).toBe(409);
  });

  it('sweeps stored videos no item uses (older than the grace) and stray temp files', async () => {
    const { app, dir } = makeApp();
    const db = app.surau.db;
    const keep = (await up(app, mp4({ salt: 1 }))).json().id as string;
    const used = (await up(app, mp4({ salt: 2 }))).json().id as string;
    await put(app, 'v1', item(used));
    writeFileSync(join(dir, 'assets', '.video-1-ab.tmp'), 'x');
    expect(sweepVideoOrphans(db, dir, 60 * 60_000, new Date())).toBe(0); // all fresh
    const later = new Date(Date.now() + 2 * 60 * 60_000); // a clock two hours on: the unused video and the temp file are old
    expect(sweepVideoOrphans(db, dir, 60 * 60_000, later)).toBe(2);
    expect(filesOf(dir)).toEqual([`${used}.mp4`]);
    expect(db.prepare('SELECT 1 FROM assets WHERE id = ?').get(keep)).toBeUndefined();
  });
});

describe('the TV sees videos', () => {
  it('lists youtube items and uploads with a file, and leaves out an upload whose file is gone', async () => {
    const { app, dir } = makeApp();
    const db = app.surau.db as DatabaseSync;
    const { id: asset } = (await up(app, mp4())).json();
    const put = (id: string, body: object) => app.inject({ method: 'PUT', url: `/api/content/video/${id}`, payload: body });
    await put('a', { title: 'A', source: 'upload', assetId: asset, days: ['umum'], order: 2 });
    await put('b', { title: 'B', source: 'youtube', youtubeId: 'dQw4w9WgXcQ', days: ['umum'], order: 1 });
    const settings = resolveSettings({});
    const first = buildKioskContent(db, dir, new Date('2026-11-19T04:00:00Z'), settings, 'sdm');
    expect(first.videos?.map((v) => v.id)).toEqual(['b', 'a']);
    rmSync(join(dir, 'assets', `${asset}.mp4`));
    const second = buildKioskContent(db, dir, new Date('2026-11-19T04:00:00Z'), settings, 'sdm');
    expect(second.videos?.map((v) => v.id)).toEqual(['b']);
  });

  it('lets only the kiosk page frame the YouTube player', () => {
    expect(KIOSK_CSP.match(/frame-src [^;]+/g)).toEqual(['frame-src https://www.youtube-nocookie.com']);
    expect(CSP).not.toContain('frame-src');
    expect(KIOSK_CSP).toContain("frame-ancestors 'none'");
  });
});

