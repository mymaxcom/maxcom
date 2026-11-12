import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { klInstant, parseJakimCsv } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { importDays } from '../src/prayerStore.ts';
import { getSettings } from '../src/settingsStore.ts';
import { loginAs } from './authHelpers.ts';

const csv = readFileSync(fileURLToPath(new URL('../../../packages/core/test/fixtures/SGR01-2026.csv', import.meta.url)), 'utf8');
const official = parseJakimCsv(csv);
const zonePage = readFileSync(fileURLToPath(new URL('./fixtures/esolat-zones-page.html', import.meta.url)), 'utf8');
const nominatim = readFileSync(fileURLToPath(new URL('./fixtures/nominatim-shah-alam.json', import.meta.url)), 'utf8');
const AT = klInstant('2026-11-03', '12:00');

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Net { calls: { url: string; method: string }[]; impl: typeof fetch; fail: boolean }
function makeApp(options: { autoFetch?: boolean } = {}): { app: FastifyInstance; net: Net } {
  const d = mkdtempSync(join(tmpdir(), 'surau-guard-'));
  dirs.push(d);
  const net: Net = { calls: [], fail: false, impl: undefined as unknown as typeof fetch };
  net.impl = (async (url: string, init?: RequestInit) => {
    net.calls.push({ url: String(url), method: String(init?.method ?? 'GET') });
    if (net.fail) throw new TypeError('fetch failed');
    if (String(url).includes('nominatim')) return new Response(nominatim);
    if (String(url).includes('pageId=24')) return new Response(zonePage);
    throw new Error('no other network in tests');
  }) as unknown as typeof fetch;
  const app = buildApp(join(d, 'test.db'), {
    now: () => AT, fetchImpl: net.impl, nominatimMinIntervalMs: 0,
    ...(options.autoFetch ? { autoPrayerFetch: { firstDelayMs: 3_600_000, intervalMs: 3_600_000 } } : {}),
  });
  apps.push(app);
  return { app, net };
}

describe('PUT /api/settings/zone', () => {
  it('refuses a code that is not on the JAKIM list and accepts a listed one with data', async () => {
    const { app } = makeApp();
    const admin = await loginAs(app, 'admin');
    importDays(app.surau.db, 'SGR01', official, 'tester');
    const bad = await app.inject({ method: 'PUT', url: '/api/settings/zone', headers: admin.headers, payload: { zone: 'XXX99' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors[0]).toBe('Zon tidak dikenali; kemas kini senarai zon');
    const ok = await app.inject({ method: 'PUT', url: '/api/settings/zone', headers: admin.headers, payload: { zone: 'SGR01' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().warnings).toBeUndefined();
  });

  it('accepts a known zone without data with a warning, and the box fetches it', async () => {
    const { app, net } = makeApp({ autoFetch: true });
    const admin = await loginAs(app, 'admin');
    const r = await app.inject({ method: 'PUT', url: '/api/settings/zone', headers: admin.headers, payload: { zone: 'JHR02' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().warnings).toEqual(['Tiada data untuk zon ini; MAXCOM akan memuat turun']);
    expect(r.json().zone.zone).toBe('JHR02');
    // the fetch runs after saving; it is the e-Solat call for this zone (the fake refuses it, no real network)
    await new Promise((res) => setTimeout(res, 100));
    expect(net.calls.some((c) => c.method === 'POST' && c.url.includes('zone=JHR02'))).toBe(true);
  });

  it('does not fetch by itself where the box does not run its own fetch (tests, the cloud)', async () => {
    const { app, net } = makeApp();
    const admin = await loginAs(app, 'admin');
    expect((await app.inject({ method: 'PUT', url: '/api/settings/zone', headers: admin.headers, payload: { zone: 'JHR02' } })).statusCode).toBe(200);
    await new Promise((res) => setTimeout(res, 50));
    expect(net.calls).toEqual([]);
  });
});

describe('PUT /api/settings/location', () => {
  it('rewrites the source order to the new country default when it still is the old default', async () => {
    const { app } = makeApp();
    const admin = await loginAs(app, 'admin');
    const r = await app.inject({ method: 'PUT', url: '/api/settings/location', headers: admin.headers, payload: { country: 'KE', timezone: 'Africa/Nairobi' } });
    expect(r.statusCode).toBe(200);
    expect(getSettings(app.surau.db).prayerSources.sourceOrder).toEqual(['file', 'calc', 'official']);
    const row = app.surau.db.prepare("SELECT actor FROM change_log WHERE entity = 'settings' AND entity_id = 'prayerSources' ORDER BY id DESC").get();
    expect(row!.actor).toBe('system:prayer-sources');
    // and back
    await app.inject({ method: 'PUT', url: '/api/settings/location', headers: admin.headers, payload: { country: 'MY', timezone: 'Asia/Kuala_Lumpur' } });
    expect(getSettings(app.surau.db).prayerSources.sourceOrder).toEqual(['official', 'calc', 'file']);
  });

  it('leaves an order the admin chose alone', async () => {
    const { app } = makeApp();
    const admin = await loginAs(app, 'admin');
    await app.inject({ method: 'PUT', url: '/api/settings/prayerSources', headers: admin.headers, payload: { sourceOrder: ['calc', 'official', 'file'] } });
    await app.inject({ method: 'PUT', url: '/api/settings/location', headers: admin.headers, payload: { country: 'KE', timezone: 'Africa/Nairobi' } });
    expect(getSettings(app.surau.db).prayerSources.sourceOrder).toEqual(['calc', 'official', 'file']);
  });

  it('refuses a time zone the runtime does not know, and keeps coordinates to 4 places', async () => {
    const { app } = makeApp();
    const admin = await loginAs(app, 'admin');
    const bad = await app.inject({ method: 'PUT', url: '/api/settings/location', headers: admin.headers, payload: { timezone: 'Mars/Olympus' } });
    expect(bad.statusCode).toBe(400);
    const five = await app.inject({ method: 'PUT', url: '/api/settings/location', headers: admin.headers, payload: { latitude: 3.24861 } });
    expect(five.statusCode).toBe(400);
    const ok = await app.inject({ method: 'PUT', url: '/api/settings/location', headers: admin.headers, payload: { latitude: 3.2486, longitude: 101.6556, city: 'Shah Alam' } });
    expect(ok.statusCode).toBe(200);
    expect(getSettings(app.surau.db).location).toMatchObject({ latitude: 3.2486, longitude: 101.6556, city: 'Shah Alam' });
  });
});

describe('zone and location routes', () => {
  it('GET /api/prayer/zones lists the zones with data tags and a suggestion once the surau is located', async () => {
    const { app } = makeApp();
    const ajk = await loginAs(app, 'ajk');
    const admin = await loginAs(app, 'admin');
    importDays(app.surau.db, 'SGR01', official, 'tester');
    let r = (await app.inject({ method: 'GET', url: '/api/prayer/zones', headers: ajk.headers })).json();
    expect(r.zones.length).toBeGreaterThanOrEqual(50);
    expect(r.zones.find((z: { code: string }) => z.code === 'SGR01')).toMatchObject({ state: 'Selangor', removed: false, years: [2026] });
    expect(r.suggested).toBeNull();
    await app.inject({ method: 'PUT', url: '/api/settings/location', headers: admin.headers, payload: { latitude: 3.0738, longitude: 101.5183 } });
    r = (await app.inject({ method: 'GET', url: '/api/prayer/zones', headers: ajk.headers })).json();
    expect(r.suggested).toMatchObject({ code: 'SGR01' });
    expect(r.warning).toBeNull();
  });

  it('POST /api/prayer/zones/refresh: admin only, runs the guarded fetch, answers the counts', async () => {
    const { app, net } = makeApp();
    const media = await loginAs(app, 'media');
    const admin = await loginAs(app, 'admin');
    expect((await app.inject({ method: 'POST', url: '/api/prayer/zones/refresh', headers: media.headers })).statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/api/prayer/zones/refresh', headers: admin.headers });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ added: [], removed: [], renamed: [] });
    expect(ok.json().count).toBeGreaterThanOrEqual(50);
    expect(net.calls[0]!.url).toBe('https://www.e-solat.gov.my/index.php?siteId=24&pageId=24');
    net.fail = true;
    const down = await app.inject({ method: 'POST', url: '/api/prayer/zones/refresh', headers: admin.headers });
    expect(down.statusCode).toBe(502);
    expect(down.body).not.toMatch(/https?:/);
  });

  it('POST /api/location/search: the Nominatim search with its limiter, offline and bad query answers', async () => {
    const { app, net } = makeApp();
    const media = await loginAs(app, 'media');
    const admin = await loginAs(app, 'admin');
    const post = (headers: object, query: unknown) => app.inject({ method: 'POST', url: '/api/location/search', headers: headers as never, payload: { query } });
    expect((await post(media.headers, 'Shah Alam')).statusCode).toBe(403);
    const ok = await post(admin.headers, 'Masjid An-Nur Eastleigh');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, cached: false, attribution: '(c) OpenStreetMap contributors' });
    expect(ok.json().results[0]).toMatchObject({ country: 'KE', city: 'Nairobi' });
    expect(net.calls.filter((c) => c.url.includes('nominatim'))).toHaveLength(1);
    expect((await post(admin.headers, 'Masjid An-Nur Eastleigh')).json().cached).toBe(true);
    expect((await post(admin.headers, 5)).statusCode).toBe(400);
    expect((await post(admin.headers, '')).statusCode).toBe(400);
    net.fail = true;
    const off = await post(admin.headers, 'Somewhere else');
    expect(off.statusCode).toBe(503);
    expect(off.json()).toMatchObject({ reason: 'offline', errors: ['MAXCOM tiada internet; taip koordinat'] });
    net.fail = false;
    for (let i = 0; i < 12; i++) await post(admin.headers, `p${i}`);
    expect((await post(admin.headers, 'one more')).statusCode).toBe(429);
  });
});
