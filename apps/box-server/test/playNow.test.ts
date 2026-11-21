// "Main sekarang" (2026.11.14): POST /api/content/video/<id>/play-now and the `play-now` event on the kiosk stream.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDayIntervals, computeKioskState, klInstant, parseJakimCsv, resolveSettings } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { importDays } from '../src/prayerStore.ts';
import { loginAs } from './authHelpers.ts';

const csv = readFileSync(fileURLToPath(new URL('../../../packages/core/test/fixtures/SGR01-2026.csv', import.meta.url)), 'utf8');
const DATE = '2026-11-10';
const days = parseJakimCsv(csv);
const day = days.find((d) => d.date === DATE)!;
const intervals = buildDayIntervals(day, resolveSettings({}));
const mid = (phase: string): Date => {
  const iv = intervals.find((i) => i.phase === phase && i.prayer === 'zohor')!;
  return new Date((iv.start.getTime() + iv.end.getTime()) / 2);
};
/** 10:00 in KL: after the sunrise phases, before Zohor. */
const QUIET = klInstant(DATE, '10:00');

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
let clock = QUIET;

function make(): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-playnow-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'), { dataDir: dir, now: () => clock, heartbeatMs: 60_000 });
  apps.push(app);
  importDays(app.surau.db, 'SGR01', days, 'tester', undefined, undefined, 'sdm');
  return app;
}

afterEach(async () => {
  clock = QUIET;
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function withVideo(app: FastifyInstance, id = 'v1'): Promise<Record<string, string>> {
  const { headers } = await loginAs(app, 'admin');
  const put = await app.inject({ method: 'PUT', url: `/api/content/video/${id}`, headers, payload: { title: 'Ceramah', source: 'youtube', youtubeId: 'dQw4w9WgXcQ', days: ['umum'], order: 1 } });
  expect(put.statusCode).toBe(201);
  return headers;
}

const playNow = (app: FastifyInstance, headers: Record<string, string>, id = 'v1') =>
  app.inject({ method: 'POST', url: `/api/content/video/${id}/play-now`, headers });

describe('play now: the prayer phases are real', () => {
  it('the fixture day has an iqamah and a solat phase at Zohor and is quiet at 10:00', () => {
    expect(computeKioskState(mid('iqamah'), days, resolveSettings({})).phase).toBe('iqamah');
    expect(computeKioskState(mid('solat'), days, resolveSettings({})).phase).toBe('solat');
    expect(computeKioskState(QUIET, days, resolveSettings({})).phase).toBe('normal');
  });
});

describe('POST /api/content/video/:id/play-now', () => {
  it('outside a prayer phase: 200 with startsAt, and the kiosk stream carries play-now { itemId }', async () => {
    const app = make();
    const headers = await withVideo(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const ctl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/kiosk/events`, { signal: ctl.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const until = async (re: RegExp): Promise<void> => {
      while (!re.test(buf)) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
      }
    };
    await until(/event: live/);
    const r = await playNow(app, headers);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ startsAt: QUIET.toISOString() });
    await until(/event: play-now\ndata: \{"itemId":"v1"\}\n\n/);
    expect(buf).toMatch(/event: play-now\ndata: \{"itemId":"v1"\}\n\n/);
    // a second press sends a second event (the kiosk replaces the first by it)
    await withVideo(app, 'v2');
    expect((await playNow(app, headers, 'v2')).statusCode).toBe(200);
    await until(/play-now\ndata: \{"itemId":"v2"\}/);
    expect(buf.match(/event: play-now/g)).toHaveLength(2);
    ctl.abort();
    await reader.cancel().catch(() => undefined);
  });

  it.each(['iqamah', 'solat'] as const)('refuses 409 prayer_phase in the %s phase', async (phase) => {
    clock = mid(phase); // set before the sign-in: a session is tied to the clock
    const app = make();
    const headers = await withVideo(app);
    const r = await playNow(app, headers);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('prayer_phase');
  });

  it('refuses the azan phases too', async () => {
    const settings = resolveSettings({});
    for (const phase of ['masukWaktu', 'azanCountdown'] as const) {
      const iv = intervals.find((i) => i.phase === phase);
      expect(iv, phase).toBeDefined();
      clock = new Date((iv!.start.getTime() + iv!.end.getTime()) / 2);
      expect(computeKioskState(clock, days, settings).phase).toBe(phase);
      const app = make();
      const headers = await withVideo(app);
      expect((await playNow(app, headers)).json().code).toBe('prayer_phase');
    }
  });

  it('refuses 409 live_running while a live is on the TV', async () => {
    const app = make();
    const headers = await withVideo(app);
    const live = app.liveSessions as unknown as { kioskLive: () => { live: boolean } };
    live.kioskLive = () => ({ live: true });
    const r = await playNow(app, headers);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('live_running');
  });

  it('404 for an unknown item', async () => {
    const app = make();
    const { headers } = await loginAs(app, 'admin');
    const r = await playNow(app, headers, 'nope');
    expect(r.statusCode).toBe(404);
  });

  it('only a role that can edit content may press it (media yes; ajk and no sign-in no)', async () => {
    const app = make();
    const headers = await withVideo(app);
    const media = await loginAs(app, 'media');
    expect((await playNow(app, media.headers)).statusCode).toBe(200);
    const ajk = await loginAs(app, 'ajk');
    expect((await playNow(app, ajk.headers)).statusCode).toBe(403);
    expect([401, 403]).toContain((await app.inject({ method: 'POST', url: '/api/content/video/v1/play-now' })).statusCode);
    expect(headers).toBeDefined();
  });

  it('works for an upload-less youtube item and for an afterPrayer item', async () => {
    const app = make();
    const { headers } = await loginAs(app, 'admin');
    const put = await app.inject({ method: 'PUT', url: '/api/content/video/ap', headers, payload: { title: 'Selepas Zohor', source: 'youtube', youtubeId: 'dQw4w9WgXcQ', days: ['umum'], order: 1, afterPrayer: 'zohor' } });
    expect(put.statusCode).toBe(201);
    expect((await playNow(app, headers, 'ap')).statusCode).toBe(200);
  });
});
