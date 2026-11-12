import type { FastifyInstance } from 'fastify';
import { klInstant } from '@surau/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loginAs } from './authHelpers.ts';
import { startFakeGoogle } from './support/fakeGoogle.ts';
import type { FakeGoogle } from './support/fakeGoogle.ts';
import { withUploadApi } from './support/fakeGoogleUpload.ts';
import type { GoogleUploadFake } from './support/fakeGoogleUpload.ts';
import { buildCloud } from './support/fakeCloud.ts';
import { parseIsoDuration } from '../src/live/youtube/api.ts';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0)) await c();
});

interface Rig {
  app: FastifyInstance;
  g: FakeGoogle;
  up: GoogleUploadFake;
}

async function rig(signedIn = true): Promise<Rig> {
  const g = await startFakeGoogle();
  const up = withUploadApi(g);
  const clock = { t: klInstant('2026-11-05', '19:00').getTime(), now: (): Date => new Date(clock.t) };
  const cloud = buildCloud('boxid0001', { now: clock.now, fetchImpl: up.fetchImpl });
  closers.push(cloud.close, g.close);
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  mkdirSync(join(cloud.dir, 'secret'), { recursive: true });
  writeFileSync(join(cloud.dir, 'secret', 'youtube-client.json'), JSON.stringify({ client_id: 'cid-123.apps.googleusercontent.com', client_secret: 'csecret-SECRET' }));
  if (signedIn) {
    const admin = await loginAs(cloud.app, 'admin');
    await cloud.app.inject({ method: 'POST', url: '/api/live/youtube/signin', headers: admin.headers });
    g.approve = true;
    clock.t += 6000;
    const done = await cloud.app.inject({ method: 'POST', url: '/api/live/youtube/signin/poll', headers: admin.headers });
    expect(done.json()).toMatchObject({ signedIn: true });
  }
  return { app: cloud.app, g, up };
}

describe('parseIsoDuration', () => {
  it('reads YouTube durations', () => {
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723);
    expect(parseIsoDuration('PT45M')).toBe(2700);
    expect(parseIsoDuration('PT30S')).toBe(30);
    expect(parseIsoDuration('PT0S')).toBe(0);
    expect(parseIsoDuration('P0D')).toBe(0);
    expect(parseIsoDuration('P1DT2H')).toBe(93600);
    expect(parseIsoDuration('PT1M1.5S')).toBe(62);
  });
  it('refuses nonsense', () => {
    for (const v of [undefined, null, '', 'abc', 'PT', 'P', '1h', 5]) expect(parseIsoDuration(v)).toBeNull();
  });
});

describe('POST /api/youtube/verify', () => {
  const post = (r: Rig, headers: Record<string, string>, payload: unknown) =>
    r.app.inject({ method: 'POST', url: '/api/youtube/verify', headers, payload: payload as object });

  it('answers per video in the order asked, with one videos.list call for all ids', async () => {
    const r = await rig();
    r.up.videos.vidMissing = { exists: false };
    r.up.videos.vidBusy = { uploadStatus: 'uploaded', processingStatus: 'processing', duration: 'PT10M' };
    r.up.videos.vidPrivate = { privacy: 'private', duration: 'PT30M' };
    r.up.videos.vidOk = { privacy: 'unlisted', uploadStatus: 'processed', processingStatus: 'succeeded', duration: 'PT1H1M5S' };
    const media = await loginAs(r.app, 'media');
    const res = await post(r, media.headers, { videoIds: ['vidOk', 'vidMissing', 'vidBusy', 'vidPrivate'] });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      results: [
        { videoId: 'vidOk', exists: true, processed: true, privacy: 'unlisted', durationSeconds: 3665 },
        { videoId: 'vidMissing', exists: false, processed: false, privacy: null, durationSeconds: null },
        { videoId: 'vidBusy', exists: true, processed: false, privacy: 'unlisted', durationSeconds: 600 },
        { videoId: 'vidPrivate', exists: true, processed: true, privacy: 'private', durationSeconds: 1800 },
      ],
    });
    expect(r.up.lists).toHaveLength(1);
    expect(r.up.lists[0]!.query.get('part')).toBe('status,processingDetails,contentDetails');
    expect(r.up.lists[0]!.query.get('id')).toBe('vidOk,vidMissing,vidBusy,vidPrivate');
  });

  it('a video with no duration yet is not processed enough: durationSeconds null', async () => {
    const r = await rig();
    const media = await loginAs(r.app, 'media');
    const res = await post(r, media.headers, { videoIds: ['vidNoDur'] });
    expect(res.json().results[0]).toMatchObject({ exists: true, durationSeconds: null });
  });

  it('refuses a bad body: not a list, empty, more than 20, bad id, not text', async () => {
    const r = await rig();
    const media = await loginAs(r.app, 'media');
    const many = Array.from({ length: 21 }, (_, i) => `v${i}`);
    for (const body of [{}, { videoIds: 'abc' }, { videoIds: [] }, { videoIds: many }, { videoIds: ['a b'] }, { videoIds: [5] }, { videoIds: ['x'.repeat(33)] }]) {
      expect((await post(r, media.headers, body)).statusCode).toBe(400);
    }
    expect((await post(r, media.headers, { videoIds: many.slice(0, 20) })).statusCode).toBe(200);
    expect(r.up.lists).toHaveLength(1);
  });

  it('is for live:control only: a viewer and an anonymous caller are refused', async () => {
    const r = await rig();
    const anon = await r.app.inject({ method: 'POST', url: '/api/youtube/verify', payload: { videoIds: ['a'] } });
    expect([401, 403]).toContain(anon.statusCode);
    const ajk = await loginAs(r.app, 'ajk');
    expect((await post(r, ajk.headers, { videoIds: ['a'] })).statusCode).toBe(403);
    expect(r.up.lists).toHaveLength(0);
  });

  it('not signed in to YouTube: 503 reauthorise, no Google call', async () => {
    const r = await rig(false);
    const media = await loginAs(r.app, 'media');
    const res = await post(r, media.headers, { videoIds: ['a'] });
    expect(res.statusCode).toBeGreaterThanOrEqual(409);
    expect(r.up.lists).toHaveLength(0);
  });

  it('writes nothing to the change history and leaks no token', async () => {
    const r = await rig();
    const { db } = r.app.surau;
    const media = await loginAs(r.app, 'media');
    const before = Number(db.prepare('SELECT COUNT(*) AS n FROM change_log').get()?.n);
    const res = await post(r, media.headers, { videoIds: ['vidOk'] });
    expect(res.body).not.toContain('access-token');
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM change_log').get()?.n)).toBe(before);
  });
});
