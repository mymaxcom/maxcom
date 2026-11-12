import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { klInstant } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { withAdmin } from './authHelpers.ts';
import type { AdminApp } from './authHelpers.ts';

const fixtureCsv = readFileSync(
  fileURLToPath(new URL('../../../packages/core/test/fixtures/SGR01-2026.csv', import.meta.url)),
  'utf8',
);

const AT = klInstant('2026-11-03', '12:00');

const apps: FastifyInstance[] = [];
const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'surau-api-'));
  tempDirs.push(dir);
  return join(dir, 'test.db');
}

function makeApp(options: Parameters<typeof buildApp>[1] = {}): AdminApp {
  const app = withAdmin(buildApp(tempDbPath(), { now: () => AT, ...options }));
  apps.push(app);
  return app;
}

async function importFixture(app: FastifyInstance): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/prayer/import',
    payload: { zone: 'SGR01', csv: fixtureCsv },
  });
  expect(response.statusCode).toBe(200);
}

async function bundleOf(app: FastifyInstance): Promise<{
  version: number;
  zone: string;
  days: { date: string }[];
  settings: Record<string, unknown>;
  serverTime: string;
}> {
  const response = await app.inject({ method: 'GET', url: '/api/kiosk/bundle' });
  expect(response.statusCode).toBe(200);
  return response.json();
}

afterEach(async () => {
  for (const app of apps.splice(0)) {
    try {
      await app.close();
    } catch {
      // already closed by the test
    }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/kiosk/bundle', () => {
  it('returns yesterday..+40 days of prayer data, zone and settings', async () => {
    const app = makeApp();
    await importFixture(app);

    const bundle = await bundleOf(app);
    expect(bundle.days.length).toBeGreaterThanOrEqual(30);
    expect(bundle.days[0]?.date).toBe('2026-11-02');
    expect(bundle.version).toBeGreaterThanOrEqual(1);
    expect(bundle.zone).toBe('SGR01');
    expect(typeof bundle.serverTime).toBe('string');
    expect(bundle.settings).toHaveProperty('prayerBar');
  });

  it('sets Cache-Control: no-store', async () => {
    const app = makeApp();
    const response = await app.inject({ method: 'GET', url: '/api/kiosk/bundle' });
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('PUT /api/settings/:feature', () => {
  it('rejects switching off a locked feature', async () => {
    const app = makeApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/clock',
      payload: { enabled: false },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().errors.length).toBeGreaterThan(0);
  });

  it('returns 404 for an unknown feature', async () => {
    const app = makeApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/nosuch',
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().errors.length).toBeGreaterThan(0);
  });

  it('stores a valid patch, bumps the version and is visible in GET settings', async () => {
    const app = makeApp();
    const { baseVersion } = await app.admin();
    expect((await bundleOf(app)).version).toBe(baseVersion);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings/iqamahCountdown',
      payload: { minutes: { isnin: { asar: 12 } } },
    });
    expect(put.statusCode).toBe(200);

    const bundle = await bundleOf(app);
    const iqamah = bundle.settings.iqamahCountdown as { minutes: Record<string, Record<string, number>> };
    expect(iqamah.minutes.isnin?.asar).toBe(12);

    const settings = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(settings.statusCode).toBe(200);
    const body = settings.json() as { iqamahCountdown: { minutes: Record<string, Record<string, number>> } };
    expect(body.iqamahCountdown.minutes.isnin?.asar).toBe(12);
    expect(bundle.version).toBeGreaterThanOrEqual(1);
  });
});

describe('POST /api/prayer/import', () => {
  it('rejects a garbage CSV with the parser message', async () => {
    const app = makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/prayer/import',
      payload: { zone: 'SGR01', csv: 'nonsense' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().errors[0]).toMatch(/header|row/i);
  });

  it('rejects a malformed zone', async () => {
    const app = makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/prayer/import',
      payload: { zone: 'sgr01', csv: fixtureCsv },
    });
    expect(response.statusCode).toBe(400);
  });

  it('maps an incomplete e-Solat download to 502', async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          prayerTime: [
            { hijri: '1448-05-23', date: '03-Nov-2026', imsak: '05:38:00', fajr: '05:48:00', syuruk: '06:55:00', dhuhr: '13:00:00', asr: '16:20:00', maghrib: '18:58:00', isha: '20:09:00' },
            { hijri: '1448-05-24', date: '04-Nov-2026', imsak: '05:38:00', fajr: '05:48:00', syuruk: '06:55:00', dhuhr: '13:00:00', asr: '16:20:00', maghrib: '18:58:00', isha: '20:09:00' },
            { hijri: '1448-05-25', date: '05-Nov-2026', imsak: '05:38:00', fajr: '05:48:00', syuruk: '06:55:00', dhuhr: '13:00:00', asr: '16:20:00', maghrib: '18:58:00', isha: '20:09:00' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    const app = makeApp({ fetchImpl: fakeFetch });
    const response = await app.inject({
      method: 'POST',
      url: '/api/prayer/import',
      payload: { zone: 'SGR01', year: 2026, source: 'esolat' },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().errors[0]).toContain('incomplete');
  });

  it('rejects an out-of-range year for the e-Solat source', async () => {
    const app = makeApp({ fetchImpl: (async () => new Response('{}')) as typeof fetch });
    const response = await app.inject({
      method: 'POST',
      url: '/api/prayer/import',
      payload: { zone: 'SGR01', year: 1999, source: 'esolat' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /api/health', () => {
  it('reports 0 days ahead on an empty database', async () => {
    const app = makeApp();
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    const { baseVersion } = await app.admin();
    expect(response.json()).toMatchObject({ ok: true, version: baseVersion, daysAhead: 0 });
  });

  it('counts remaining days of the year after a fixture import', async () => {
    const app = makeApp();
    await importFixture(app);
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.json().daysAhead).toBe(59);
  });
});

describe('GET /api/kiosk/events (SSE)', () => {
  it('sends the current version on connect and again after a change', async () => {
    const app = makeApp({ heartbeatMs: 60_000 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/kiosk/events`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    const reader = response.body!.getReader();
    const state = { buffer: '' };

    const first = await readUntil(reader, state, (buf) => /event: changed\ndata: \{"version":\d+\}\n\n/.test(buf));
    expect(first).toMatch(/event: changed/);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings/iqamahCountdown',
      payload: { minutes: { isnin: { asar: 12 } } },
    });
    expect(put.statusCode).toBe(200);

    const second = await readUntil(reader, state, (buf) => {
      const matches = buf.match(/event: changed\ndata: \{"version":(\d+)\}\n\n/g) ?? [];
      return matches.length >= 2;
    });
    const versions = [...second.matchAll(/event: changed\ndata: \{"version":(\d+)\}\n\n/g)].map((m) => Number(m[1]));
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(versions[versions.length - 1]).toBeGreaterThan(versions[0]!);

    controller.abort();
    await reader.cancel().catch(() => undefined);
    await app.close();
  });

  it('returns 503 when more than 20 clients are connected', async () => {
    const app = makeApp({ heartbeatMs: 60_000, maxSseClientsPerIp: 20 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}/api/kiosk/events`;

    const controllers: AbortController[] = [];
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    for (let i = 0; i < 20; i++) {
      const controller = new AbortController();
      controllers.push(controller);
      const res = await fetch(base, { signal: controller.signal });
      expect(res.status).toBe(200);
      readers.push(res.body!.getReader());
      // Read the initial event so the connection is fully open.
      await readUntil(readers[i]!, { buffer: '' }, (buf) => buf.includes('event: changed'));
    }

    const overflow = await fetch(base);
    expect(overflow.status).toBe(503);
    await overflow.body?.cancel().catch(() => undefined);

    for (const controller of controllers) controller.abort();
    for (const reader of readers) await reader.cancel().catch(() => undefined);
    await app.close();
  });
});

describe('unknown routes', () => {
  it('returns JSON 404 for unknown /api paths', async () => {
    const app = makeApp();
    const response = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json().errors.length).toBeGreaterThan(0);
  });
});

describe('static files', () => {
  it('serves index.html for non-API GETs and keeps API 404s as JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-static-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>kiosk</title>');

    const app = withAdmin(buildApp(tempDbPath(), { now: () => AT, staticDir: dir }));
    apps.push(app);

    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('kiosk');

    const deep = await app.inject({ method: 'GET', url: '/some/deep/link' });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('kiosk');

    const api = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(api.statusCode).toBe(404);
    expect(api.headers['content-type']).toContain('application/json');
  });
});

describe('static caching headers', () => {
  it('serves sw.js and index.html with no-cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-static-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>kiosk</title>');
    writeFileSync(join(dir, 'sw.js'), '// sw');

    const app = withAdmin(buildApp(tempDbPath(), { now: () => AT, staticDir: dir }));
    apps.push(app);

    const sw = await app.inject({ method: 'GET', url: '/sw.js' });
    expect(sw.statusCode).toBe(200);
    expect(sw.headers['cache-control']).toBe('no-cache');

    const index = await app.inject({ method: 'GET', url: '/index.html' });
    expect(index.headers['cache-control']).toBe('no-cache');

    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.headers['cache-control']).toBe('no-cache');

    const deep = await app.inject({ method: 'GET', url: '/some/deep/link' });
    expect(deep.headers['cache-control']).toBe('no-cache');
  });
});

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { buffer: string },
  done: (buffer: string) => boolean,
  timeoutMs = 5000,
): Promise<string> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  while (!done(state.buffer)) {
    if (Date.now() > deadline) throw new Error(`SSE read timed out; buffer: ${state.buffer}`);
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`SSE stream ended early; buffer: ${state.buffer}`);
    state.buffer += decoder.decode(chunk.value, { stream: true });
  }
  return state.buffer;
}
