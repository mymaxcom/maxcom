import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loginAs, withAdmin } from './authHelpers.ts';
import type { AdminApp } from './authHelpers.ts';
import { readImageHeader } from '../src/assets/imageHeader.ts';
import { assetsMaxBytes, putAsset } from '../src/assets/store.ts';

const apps: FastifyInstance[] = [];
const tempDirs: string[] = [];

function makeApp(): { app: AdminApp; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'surau-assets-'));
  tempDirs.push(dir);
  const app = withAdmin(buildApp(join(dir, 'test.db')));
  apps.push(app);
  return { app, dir };
}

afterEach(async () => {
  for (const app of apps.splice(0)) {
    try {
      await app.close();
    } catch {
      // already closed
    }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function png(width: number, height: number, salt = 0): Buffer {
  const b = Buffer.alloc(33 + salt);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function jpeg(width: number, height: number): Buffer {
  const b = Buffer.alloc(2 + 4 + 14 + 2);
  b.writeUInt16BE(0xffd8, 0);
  b.writeUInt16BE(0xffe0, 2); // APP0, length 2 (empty)
  b.writeUInt16BE(2, 4);
  b.writeUInt16BE(0xffc0, 6); // SOF0
  b.writeUInt16BE(11, 8);
  b[10] = 8;
  b.writeUInt16BE(height, 11);
  b.writeUInt16BE(width, 13);
  b[15] = 1;
  return b;
}

function webpVp8x(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(22, 4);
  b.write('WEBPVP8X', 8, 'ascii');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

function webpVp8(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(22, 4);
  b.write('WEBPVP8 ', 8, 'ascii');
  b.writeUInt32LE(10, 16);
  Buffer.from([0x9d, 0x01, 0x2a]).copy(b, 23);
  b.writeUInt16LE(width, 26);
  b.writeUInt16LE(height, 28);
  return b;
}

function webpVp8l(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(22, 4);
  b.write('WEBPVP8L', 8, 'ascii');
  b.writeUInt32LE(5, 16);
  b[20] = 0x2f;
  const bits = (width - 1) | ((height - 1) << 14);
  b.writeUInt32LE(bits >>> 0, 21);
  return b;
}

const upload = (app: FastifyInstance, body: Buffer, type: string) =>
  app.inject({ method: 'POST', url: '/api/assets', headers: { 'content-type': type }, payload: body });

describe('readImageHeader', () => {
  it('parses png, jpeg and the three webp flavours', () => {
    expect(readImageHeader(png(2, 3))).toEqual({ mime: 'image/png', width: 2, height: 3 });
    expect(readImageHeader(jpeg(40, 30))).toEqual({ mime: 'image/jpeg', width: 40, height: 30 });
    expect(readImageHeader(webpVp8x(640, 480))).toEqual({ mime: 'image/webp', width: 640, height: 480 });
    expect(readImageHeader(webpVp8(100, 50))).toEqual({ mime: 'image/webp', width: 100, height: 50 });
    expect(readImageHeader(webpVp8l(321, 123))).toEqual({ mime: 'image/webp', width: 321, height: 123 });
  });

  it('returns null for svg, text, truncated and zero-size input', () => {
    expect(readImageHeader(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(readImageHeader(Buffer.from('hello'))).toBeNull();
    expect(readImageHeader(png(2, 2).subarray(0, 20))).toBeNull();
    expect(readImageHeader(png(0, 5))).toBeNull();
    expect(readImageHeader(Buffer.alloc(0))).toBeNull();
  });
});

describe('POST /api/assets and GET /assets/:id', () => {
  it('stores a png by sha256, dedupes, and serves it immutable', async () => {
    const { app, dir } = makeApp();
    const body = png(2, 2);
    const first = await upload(app, body, 'image/png');
    expect(first.statusCode).toBe(201);
    const meta = first.json();
    expect(meta).toMatchObject({ mime: 'image/png', bytes: body.length, width: 2, height: 2 });
    expect(meta.id).toBe(createHash('sha256').update(body).digest('hex'));

    const again = await upload(app, body, 'image/png');
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(meta.id);
    expect(readdirSync(join(dir, 'assets'))).toEqual([`${meta.id}.png`]);

    const served = await app.inject({ method: 'GET', url: `/assets/${meta.id}` });
    expect(served.statusCode).toBe(200);
    expect(served.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(served.rawPayload, body)).toBe(0);
  });

  it('rejects a header/content-type mismatch', async () => {
    const { app } = makeApp();
    const res = await upload(app, png(2, 2), 'image/jpeg');
    expect(res.statusCode).toBe(400);
    expect(res.json().errors.join(' ')).toMatch(/mismatch/);
  });

  it('rejects svg, unknown types and non-images declared as images', async () => {
    const { app } = makeApp();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect((await upload(app, svg, 'image/svg+xml')).statusCode).toBeGreaterThanOrEqual(400);
    expect((await upload(app, svg, 'image/png')).statusCode).toBe(400);
    expect((await upload(app, Buffer.from('MZ'), 'application/octet-stream')).statusCode).toBeGreaterThanOrEqual(400);
    expect((await upload(app, Buffer.alloc(0), 'image/png')).statusCode).toBe(400);
    const json = await app.inject({ method: 'POST', url: '/api/assets', payload: { a: 1 } });
    expect(json.statusCode).toBe(400);
  });

  it('enforces dimension and size limits', async () => {
    const { app } = makeApp();
    expect((await upload(app, png(6001, 10), 'image/png')).statusCode).toBe(400);
    expect((await upload(app, png(10, 6001), 'image/png')).statusCode).toBe(400);
    const nineMb = png(10, 10, 9 * 1024 * 1024);
    expect((await upload(app, nineMb, 'image/png')).statusCode).toBe(400);
    const huge = Buffer.alloc(21 * 1024 * 1024, 1);
    const res = await upload(app, huge, 'image/png');
    expect([400, 413]).toContain(res.statusCode);
  });

  it('caps images at 4096 px longest side and 16 megapixels (S7)', async () => {
    const { app } = makeApp();
    expect((await upload(app, png(4097, 10), 'image/png')).statusCode).toBe(400);
    expect((await upload(app, png(10, 4097), 'image/png')).statusCode).toBe(400);
    expect((await upload(app, png(4096, 3900), 'image/png')).statusCode).toBe(201);
    expect((await upload(app, png(4096, 4096), 'image/png')).statusCode).toBe(400);
  });

  it('refuses an image over the megapixel cap even when each side is legal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-assets-mp-'));
    tempDirs.push(dir);
    const app = buildApp(join(dir, 'test.db'));
    apps.push(app);
    expect(() => putAsset(app.surau.db, dir, png(4000, 4000), 'image/png', 't')).not.toThrow();
    expect(() => putAsset(app.surau.db, dir, png(4096, 4096), 'image/png', 't')).toThrow(/megapixel/);
  });

  it('enforces the total storage quota with 413 and a BM message (S7)', async () => {
    const prior = process.env.SURAU_ASSETS_MAX_MB;
    process.env.SURAU_ASSETS_MAX_MB = '1';
    try {
      const { app, dir } = makeApp();
      const a = png(10, 10, 600 * 1024);
      const b = png(10, 10, 600 * 1024 + 7);
      expect((await upload(app, a, 'image/png')).statusCode).toBe(201);
      const over = await upload(app, b, 'image/png');
      expect(over.statusCode).toBe(413);
      expect(over.json().errors.join(' ')).toMatch(/ruang simpanan/i);
      expect(readdirSync(join(dir, 'assets'))).toHaveLength(1);
      // Re-uploading an asset that is already stored never counts against the quota.
      expect((await upload(app, a, 'image/png')).statusCode).toBe(200);
    } finally {
      if (prior === undefined) delete process.env.SURAU_ASSETS_MAX_MB;
      else process.env.SURAU_ASSETS_MAX_MB = prior;
    }
  });

  it('defaults the quota to 2 GB and ignores a nonsense SURAU_ASSETS_MAX_MB', () => {
    expect(assetsMaxBytes({})).toBe(2048 * 1024 * 1024);
    expect(assetsMaxBytes({ SURAU_ASSETS_MAX_MB: '5' })).toBe(5 * 1024 * 1024);
    expect(assetsMaxBytes({ SURAU_ASSETS_MAX_MB: 'abc' })).toBe(2048 * 1024 * 1024);
    expect(assetsMaxBytes({ SURAU_ASSETS_MAX_MB: '-3' })).toBe(2048 * 1024 * 1024);
  });

  it('accepts mp3 by magic bytes only', async () => {
    const { app } = makeApp();
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 3)]);
    const ok = await upload(app, mp3, 'audio/mpeg');
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ mime: 'audio/mpeg', width: null, height: null });
    const served = await app.inject({ method: 'GET', url: `/assets/${ok.json().id}` });
    expect(served.headers['content-type']).toBe('audio/mpeg');
    expect((await upload(app, Buffer.from('not audio at all'), 'audio/mpeg')).statusCode).toBe(400);
  });

  it('lists only the MP3 files for ?mime=audio/mpeg, only the pictures without it, and refuses another filter', async () => {
    const { app } = makeApp();
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 5)]);
    const song = (await upload(app, mp3, 'audio/mpeg')).json();
    const pic = (await upload(app, png(40, 30), 'image/png')).json();
    const audio = await app.inject({ method: 'GET', url: '/api/assets?mime=audio/mpeg' });
    expect(audio.statusCode).toBe(200);
    expect(audio.json().assets.map((a: { id: string }) => a.id)).toEqual([song.id]);
    expect(audio.json().assets[0]).toMatchObject({ id: song.id, bytes: mp3.length });
    expect(audio.json().truncated).toBe(false);
    const images = await app.inject({ method: 'GET', url: '/api/assets' });
    expect(images.json().assets.map((a: { id: string }) => a.id)).toEqual([pic.id]);
    expect((await app.inject({ method: 'GET', url: '/api/assets?mime=text/html' })).statusCode).toBe(400);
  });

  it('404s on malformed ids and unknown hashes without touching the filesystem', async () => {
    const { app } = makeApp();
    const urls = [
      '/assets/zz',
      '/assets/../../etc/passwd',
      '/assets/%2e%2e%2fetc',
      `/assets/${'A'.repeat(64)}`,
      `/assets/${'a'.repeat(63)}`,
      `/assets/${'a'.repeat(64)}`,
    ];
    for (const url of urls) {
      const res = await app.inject({ method: 'GET', url });
      // Encoded traversal is now refused up front by the authz path guard (400); never served.
      if (url.includes('%2e')) expect([400, 404], url).toContain(res.statusCode);
      else expect(res.statusCode, url).toBe(404);
    }
  });

  it('404s when the row exists but the file was removed', async () => {
    const { app, dir } = makeApp();
    const id = (await upload(app, png(3, 3), 'image/png')).json().id as string;
    rmSync(join(dir, 'assets', `${id}.png`));
    expect((await app.inject({ method: 'GET', url: `/assets/${id}` })).statusCode).toBe(404);
  });

  it('leaves no temp file and reports assetsBytes in health', async () => {
    const { app, dir } = makeApp();
    const body = png(4, 4);
    await upload(app, body, 'image/png');
    expect(readdirSync(join(dir, 'assets')).some((n) => n.endsWith('.tmp'))).toBe(false);
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.json().assetsBytes).toBe(body.length);
  });

  it('works over a real socket', async () => {
    const { app, dir } = makeApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const body = png(5, 5);
    const { headers: auth } = await app.admin();
    const res = await fetch(`http://127.0.0.1:${port}/api/assets`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', ...auth },
      body,
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const got = await fetch(`http://127.0.0.1:${port}/assets/${id}`);
    expect(got.status).toBe(200);
    await got.arrayBuffer();
    expect(existsSync(join(dir, 'assets', `${id}.png`))).toBe(true);
  });
});

describe('GET /api/assets (the list the backgrounds picker draws)', () => {
  const LAN = '10.168.1.50';

  it('lists stored images newest first with only id, size, bytes and time', async () => {
    const { app } = makeApp();
    const a = (await upload(app, png(10, 20, 1), 'image/png')).json();
    const b = (await upload(app, jpeg(40, 30), 'image/jpeg')).json();
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 3)]);
    expect((await upload(app, mp3, 'audio/mpeg')).statusCode).toBe(201);
    // Give the three rows distinct, known times so the order is not a tie.
    const { db } = app.surau;
    db.prepare('UPDATE assets SET created_at = ? WHERE id = ?').run('2026-11-01T10:00:00.000Z', a.id);
    db.prepare('UPDATE assets SET created_at = ? WHERE id = ?').run('2026-11-02T10:00:00.000Z', b.id);

    const res = await app.inject({ method: 'GET', url: '/api/assets' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json() as { assets: Record<string, unknown>[] };
    expect(Object.keys(body)).toEqual(['assets', 'truncated']);
    expect(body.assets).toEqual([
      { id: b.id, width: 40, height: 30, bytes: jpeg(40, 30).length, createdAt: '2026-11-02T10:00:00.000Z' },
      { id: a.id, width: 10, height: 20, bytes: png(10, 20, 1).length, createdAt: '2026-11-01T10:00:00.000Z' },
    ]);
    for (const row of body.assets) expect(row.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('leaves out derived renders and reports truncated', async () => {
    const { app } = makeApp();
    const a = (await upload(app, png(10, 20, 1), 'image/png')).json();
    const d = (await upload(app, png(12, 12, 2), 'image/png')).json();
    const { db } = app.surau;
    db.prepare('INSERT INTO asset_derivatives (key, source_id, slot, derived_id, created_at) VALUES (?, ?, ?, ?, ?)').run('k', a.id, 'logo', d.id, 'now');
    const body = (await app.inject({ method: 'GET', url: '/api/assets' })).json() as { assets: { id: string }[]; truncated: boolean };
    expect(body.assets.map((r) => r.id)).toEqual([a.id]);
    expect(body.truncated).toBe(false);
  });

  it('is empty on a fresh box and caps the list at 500', async () => {
    const { app } = makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/assets' })).json()).toEqual({ assets: [], truncated: false });
    const { db } = app.surau;
    const insert = db.prepare(
      'INSERT INTO assets (id, mime, bytes, width, height, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < 520; i++) {
      const id = createHash('sha256').update(`row-${i}`).digest('hex');
      insert.run(id, 'image/png', 10, 1, 1, new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(), 't');
    }
    const full = (await app.inject({ method: 'GET', url: '/api/assets' })).json();
    const list = full.assets as { createdAt: string }[];
    expect(full.truncated).toBe(true);
    expect(list).toHaveLength(500);
    expect(list[0]!.createdAt).toBe(new Date(Date.UTC(2026, 10, 1, 0, 0, 519)).toISOString());
    expect(list[499]!.createdAt).toBe(new Date(Date.UTC(2026, 10, 1, 0, 0, 20)).toISOString());
  });

  it('admin ok, AJK 403, unauthenticated 401', async () => {
    const { app } = makeApp();
    const admin = await app.admin();
    const ajk = await loginAs(app, 'ajk');
    expect((await app.inject({ method: 'GET', url: '/api/assets', headers: admin.headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/assets', headers: ajk.headers })).statusCode).toBe(403);
    const anon = await app.inject({ method: 'GET', url: '/api/assets', headers: { authorization: 'Bearer not-a-session' }, remoteAddress: LAN });
    expect(anon.statusCode).toBe(401);
  });
});
