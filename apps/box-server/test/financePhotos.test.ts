import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { klInstant } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { putFeature } from '../src/settingsStore.ts';
import { loginAs } from './authHelpers.ts';
import { jpeg } from './support/jpeg.ts';

const AT = klInstant('2026-11-10', '10:00');
const apps: FastifyInstance[] = [];
const dirs: string[] = [];

function makeApp(): { app: FastifyInstance; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'surau-finp-'));
  dirs.push(dir);
  const noNetwork = (async () => { throw new TypeError('network disabled in tests'); }) as unknown as typeof fetch;
  const app = buildApp(join(dir, 'test.db'), { now: () => AT, fetchImpl: noNetwork });
  apps.push(app);
  return { app, dir };
}

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

async function rig() {
  const { app, dir } = makeApp();
  const treasurer = await loginAs(app, 'treasurer');
  const ajk = await loginAs(app, 'ajk');
  const admin = await loginAs(app, 'admin');
  putFeature(app.surau.db, 'finance', { enabled: true }, 'test');
  return { app, dir, treasurer, ajk, admin };
}

const upload = (r: Awaited<ReturnType<typeof rig>>, body: Buffer, type = 'image/jpeg', entry: string | null = 'e1', login = r.treasurer) =>
  r.app.inject({
    method: 'POST', url: '/api/finance/photos', payload: body,
    headers: { ...login.headers, 'content-type': type, ...(entry === null ? {} : { 'x-entry-id': entry }) },
  });

describe('finance photos', () => {
  it('a JPEG is stored under finance/photos and answers its id; the file exists', async () => {
    const r = await rig();
    const buf = jpeg(100_000);
    const res = await upload(r, buf);
    expect(res.statusCode).toBe(200);
    const id = createHash('sha256').update(buf).digest('hex');
    expect(res.json()).toMatchObject({ id, bytes: 100_000, width: 640, height: 480 });
    expect(existsSync(join(r.dir, 'finance', 'photos', `${id}.jpg`))).toBe(true);
    // the same bytes again: same row, still one
    expect((await upload(r, buf)).statusCode).toBe(200);
    expect(Number(r.app.surau.db.prepare('SELECT COUNT(*) AS n FROM finance_photos').get()!.n)).toBe(1);
  });

  it('refuses a PNG (400), a 3 MB JPEG (413), a missing X-Entry-Id (400) and a bad entry id', async () => {
    const r = await rig();
    expect((await upload(r, PNG, 'image/png')).statusCode).toBe(400);
    expect((await upload(r, PNG, 'image/jpeg')).statusCode).toBe(400);
    expect((await upload(r, jpeg(3 * 1024 * 1024))).statusCode).toBe(413);
    expect((await upload(r, jpeg(1000), 'image/jpeg', null)).statusCode).toBe(400);
    expect((await upload(r, jpeg(1000), 'image/jpeg', '../x')).statusCode).toBe(400);
    expect((await upload(r, jpeg(1000, 5000, 100))).statusCode).toBe(400);
    expect(Number(r.app.surau.db.prepare('SELECT COUNT(*) AS n FROM finance_photos').get()!.n)).toBe(0);
  });

  it('is never reachable through /assets/, and only the treasurer or admin can read it', async () => {
    const r = await rig();
    const buf = jpeg(50_000);
    const id = (await upload(r, buf)).json().id as string;
    expect((await r.app.inject({ method: 'GET', url: `/assets/${id}`, remoteAddress: '127.0.0.1' })).statusCode).toBe(404);
    expect((await r.app.inject({ method: 'GET', url: `/assets/${id}`, headers: r.admin.headers })).statusCode).toBe(404);
    const asAjk = await r.app.inject({ method: 'GET', url: `/api/finance/photos/${id}`, headers: r.ajk.headers });
    expect(asAjk.statusCode).toBe(403);
    expect((await r.app.inject({ method: 'GET', url: `/api/finance/photos/${id}`, remoteAddress: '127.0.0.1' })).statusCode).toBe(403);
    expect((await r.app.inject({ method: 'GET', url: `/api/finance/photos/${id}`, remoteAddress: '10.168.1.80' })).statusCode).toBe(401);
    const ok = await r.app.inject({ method: 'GET', url: `/api/finance/photos/${id}`, headers: r.treasurer.headers });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.rawPayload.equals(buf)).toBe(true);
    expect((await r.app.inject({ method: 'GET', url: `/api/finance/photos/${'b'.repeat(64)}`, headers: r.treasurer.headers })).statusCode).toBe(404);
    expect((await r.app.inject({ method: 'GET', url: `/api/finance/photos/${'b'.repeat(63)}`, headers: r.treasurer.headers })).statusCode).toBe(404);
  });

  it('the change history carries metadata only, never the bytes or the photo content', async () => {
    const r = await rig();
    const buf = jpeg(20_000);
    await upload(r, buf);
    const row = r.app.surau.db.prepare("SELECT entity_id, after_json FROM change_log WHERE entity = 'finance:photo'").get()!;
    expect(JSON.parse(String(row.after_json))).toEqual({ entryId: 'e1', mime: 'image/jpeg', bytes: 20_000 });
    expect(String(row.after_json)).not.toContain(buf.subarray(30, 60).toString('base64'));
  });
});
