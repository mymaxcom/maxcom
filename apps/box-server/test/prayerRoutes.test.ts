import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { klInstant, parseJakimCsv } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { importDays } from '../src/prayerStore.ts';
import { putFeature } from '../src/settingsStore.ts';
import { createPrayerAutoFetch } from '../src/prayerAutoFetch.ts';
import { loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';

const csv = readFileSync(fileURLToPath(new URL('../../../packages/core/test/fixtures/SGR01-2026.csv', import.meta.url)), 'utf8');
const official = parseJakimCsv(csv);
const AT = klInstant('2026-11-03', '12:00');

const apps: FastifyInstance[] = [];
const dirs: string[] = [];

function makeApp(): FastifyInstance {
  const d = mkdtempSync(join(tmpdir(), 'surau-prayer-'));
  dirs.push(d);
  const app = buildApp(join(d, 'test.db'), { now: () => AT });
  apps.push(app);
  return app;
}
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Bundle { zone: string; days: { date: string; times: Record<string, string>; source: string; emergency: boolean; corrected: string[] }[]; prayer: Record<string, unknown> }

describe('GET /api/kiosk/bundle', () => {
  it('for the pilot copy carries the same times as before, now with the source, and no coordinates are needed', async () => {
    const app = makeApp();
    importDays(app.surau.db, 'SGR01', official, 'tester', undefined, undefined, 'sdm');
    const r = await app.inject({ method: 'GET', url: '/api/kiosk/bundle' });
    expect(r.statusCode).toBe(200);
    const b = r.json() as Bundle;
    expect(b.zone).toBe('SGR01');
    // yesterday .. +40 days around 2026-11-03
    expect(b.days[0]!.date).toBe('2026-11-02');
    expect(b.days).toHaveLength(42);
    for (const d of b.days) {
      expect(d.source).toBe('official');
      expect(d.emergency).toBe(false);
      expect(d.corrected).toEqual([]);
      expect(d.times).toEqual(official.find((o) => o.date === d.date)!.times);
    }
    expect(b.prayer).toMatchObject({
      country: 'MY', hasOfficial: true, timezone: 'Asia/Kuala_Lumpur', utcOffsetMinutes: 480,
      footerMs: 'Sumber: JAKIM e-Solat SGR01', footerEn: 'Source: JAKIM e-Solat SGR01',
    });
  });

  it('shows a correction, and removing it restores the official time', async () => {
    const app = makeApp();
    importDays(app.surau.db, 'SGR01', official, 'tester', undefined, undefined, 'sdm');
    const admin = await loginAs(app, 'admin');
    const put = await app.inject({
      method: 'PUT', url: '/api/prayer/corrections/2026-11-26/asar', headers: admin.headers,
      payload: { time: '16:25', reason: 'Ikut takwim masjid' },
    });
    expect(put.statusCode).toBe(200);
    let b = (await app.inject({ method: 'GET', url: '/api/kiosk/bundle' })).json() as Bundle;
    const day = b.days.find((d) => d.date === '2026-11-26')!;
    expect(day.times.asar).toBe('16:25');
    expect(day.corrected).toEqual(['asar']);
    const del = await app.inject({ method: 'DELETE', url: '/api/prayer/corrections/2026-11-26/asar', headers: admin.headers });
    expect(del.statusCode).toBe(200);
    b = (await app.inject({ method: 'GET', url: '/api/kiosk/bundle' })).json() as Bundle;
    expect(b.days.find((d) => d.date === '2026-11-26')!.times.asar).toBe(official.find((o) => o.date === '2026-11-26')!.times.asar);
    expect(b.days.find((d) => d.date === '2026-11-26')!.corrected).toEqual([]);
  });

  it('an Africa/Nairobi surau gets calculated days in Nairobi time with the footer and no emergency', async () => {
    const app = makeApp();
    putFeature(app.surau.db, 'location', { country: 'KE', timezone: 'Africa/Nairobi', latitude: -1.2921, longitude: 36.8219, city: 'Nairobi' }, 'tester', undefined, 'sdm');
    putFeature(app.surau.db, 'prayerSources', { sourceOrder: ['file', 'calc', 'official'] }, 'tester', undefined, 'sdm');
    const b = (await app.inject({ method: 'GET', url: '/api/kiosk/bundle' })).json() as Bundle;
    expect(b.days.every((d) => d.source === 'calc' && !d.emergency)).toBe(true);
    expect(b.prayer).toMatchObject({
      country: 'KE', hasOfficial: false, timezone: 'Africa/Nairobi', utcOffsetMinutes: 180,
      footerMs: 'Kiraan setempat (Liga Dunia Islam), Nairobi',
    });
  });
});

describe('prayer routes and who may call them', () => {
  async function logins(app: FastifyInstance): Promise<Record<'admin' | 'media' | 'ajk', Login>> {
    return { admin: await loginAs(app, 'admin'), media: await loginAs(app, 'media'), ajk: await loginAs(app, 'ajk') };
  }

  it('GET /api/prayer/days: every role may read, an anonymous LAN caller and the kiosk may not', async () => {
    const app = makeApp();
    importDays(app.surau.db, 'SGR01', official, 'tester', undefined, undefined, 'sdm');
    const l = await logins(app);
    const ok = await app.inject({ method: 'GET', url: '/api/prayer/days?from=2026-11-01&to=2026-11-05', headers: l.ajk.headers });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { days: { date: string; source: string }[]; sources: Record<string, unknown>; crossCheck: { compared: number } };
    expect(body.days.map((d) => d.date)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']);
    expect(body.days.every((d) => d.source === 'official')).toBe(true);
    expect(body.sources).toMatchObject({ order: ['official', 'calc', 'file'], country: 'MY', hasOfficial: true, zone: 'SGR01', located: false, timezone: 'Asia/Kuala_Lumpur' });
    expect(body.crossCheck.compared).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/prayer/days', remoteAddress: '10.168.1.77' })).statusCode).toBe(401);
    // the local kiosk (loopback, no sign-in) holds kiosk:read only
    expect([401, 403]).toContain((await app.inject({ method: 'GET', url: '/api/prayer/days' })).statusCode);
  });

  it('GET /api/prayer/days flags a corrected prayer whose official time moved since the correction', async () => {
    const app = makeApp();
    importDays(app.surau.db, 'SGR01', official, 'tester', undefined, undefined, 'sdm');
    const { admin } = await logins(app);
    const put = await app.inject({
      method: 'PUT', url: '/api/prayer/corrections/2026-11-26/asar', headers: admin.headers,
      payload: { time: '16:25', reason: 'Ikut takwim masjid' },
    });
    expect(put.statusCode).toBe(200);
    type Day = { date: string; corrected: string[]; officialChanged: string[] };
    const get = async (): Promise<Day> => {
      const r = await app.inject({ method: 'GET', url: '/api/prayer/days?from=2026-11-25&to=2026-11-27', headers: admin.headers });
      return (r.json() as { days: Day[] }).days.find((d) => d.date === '2026-11-26')!;
    };
    // Success path: nothing moved yet, so nothing is flagged.
    expect((await get()).corrected).toEqual(['asar']);
    expect((await get()).officialChanged).toEqual([]);
    // JAKIM re-downloaded with a different asar: the correction stays and is flagged.
    const moved = official.map((d) => (d.date === '2026-11-26' ? { ...d, times: { ...d.times, asar: '16:40' } } : d));
    importDays(app.surau.db, 'SGR01', moved, 'tester', undefined, undefined, 'sdm');
    const after = await get();
    expect(after.corrected).toEqual(['asar']);
    expect(after.officialChanged).toEqual(['asar']);
    const other = (await app.inject({ method: 'GET', url: '/api/prayer/days?from=2026-11-25&to=2026-11-25', headers: admin.headers })).json() as { days: Day[] };
    expect(other.days[0]!.officialChanged).toEqual([]);
  });

  it('GET /api/prayer/timezone suggests the zone of the longitude within the country', async () => {
    const app = makeApp();
    const { ajk } = await logins(app);
    const ask = async (q: string): Promise<{ statusCode: number; timezone?: string }> => {
      const r = await app.inject({ method: 'GET', url: `/api/prayer/timezone?${q}`, headers: ajk.headers });
      return { statusCode: r.statusCode, ...(r.statusCode === 200 ? { timezone: (r.json() as { timezone: string }).timezone } : {}) };
    };
    // Success path: two coordinates of one country, two different zones.
    expect(await ask('country=ID&lon=106.8')).toEqual({ statusCode: 200, timezone: 'Asia/Jakarta' });
    expect(await ask('country=ID&lon=128')).toEqual({ statusCode: 200, timezone: 'Asia/Jayapura' });
    expect(await ask('country=KE&lon=36.8')).toEqual({ statusCode: 200, timezone: 'Africa/Nairobi' });
    // Failure paths.
    expect((await ask('country=ID')).statusCode).toBe(400);
    expect((await ask('country=ID&lon=abc')).statusCode).toBe(400);
    expect((await ask('country=ID&lon=200')).statusCode).toBe(400);
    expect((await ask('country=ZZZ&lon=10')).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/prayer/timezone?country=ID&lon=106.8', remoteAddress: '10.168.1.77' })).statusCode).toBe(401);
  });

  it('GET /api/prayer/days refuses bad or huge ranges', async () => {
    const app = makeApp();
    const { admin } = await logins(app);
    for (const q of ['from=2026-13-01', 'from=2026-11-05&to=2026-11-01', 'from=2026-01-01&to=2027-12-31', 'to=xx']) {
      const r = await app.inject({ method: 'GET', url: `/api/prayer/days?${q}`, headers: admin.headers });
      expect(r.statusCode, q).toBe(400);
    }
    const def = await app.inject({ method: 'GET', url: '/api/prayer/days', headers: admin.headers });
    expect(def.statusCode).toBe(200);
  });

  it('corrections: admin 200, media 403, a bad time or a one letter reason 400, an unknown prayer 404, an out of order time 400', async () => {
    const app = makeApp();
    importDays(app.surau.db, 'SGR01', official, 'tester', undefined, undefined, 'sdm');
    const l = await logins(app);
    const url = '/api/prayer/corrections/2026-11-26/asar';
    const payload = { time: '16:25', reason: 'Ikut takwim masjid' };
    expect((await app.inject({ method: 'PUT', url, headers: l.media.headers, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url, headers: l.media.headers })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url, headers: l.admin.headers, payload: { ...payload, time: '25:00' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url, headers: l.admin.headers, payload: { ...payload, reason: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url, headers: l.admin.headers, payload: { time: '16:25' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/prayer/corrections/2026-11-26/dhuha', headers: l.admin.headers, payload })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: '/api/prayer/corrections/2026-02-30/asar', headers: l.admin.headers, payload })).statusCode).toBe(400);
    // asar after maghrib would break the day
    const late = await app.inject({ method: 'PUT', url, headers: l.admin.headers, payload: { ...payload, time: '23:00' } });
    expect(late.statusCode).toBe(400);
    const good = await app.inject({ method: 'PUT', url, headers: l.admin.headers, payload });
    expect(good.statusCode).toBe(200);
    expect(good.json().day.times.asar).toBe('16:25');
    const row = app.surau.db.prepare("SELECT * FROM change_log WHERE entity = 'prayer:correction'").get();
    expect(row).toMatchObject({ entity_id: '2026-11-26|asar' });
    expect(String(row!.actor)).toMatch(/^user:/);
  });

  it('GET /api/prayer/status: today, source, counts and warnings; a calculated day in Malaysia warns', async () => {
    const app = makeApp();
    const { admin } = await logins(app);
    importDays(app.surau.db, 'SGR01', official.filter((d) => d.date <= '2026-11-30'), 'tester', undefined, undefined, 'sdm');
    let s = (await app.inject({ method: 'GET', url: '/api/prayer/status', headers: admin.headers })).json();
    expect(s).toMatchObject({
      country: 'MY', hasOfficial: true, zone: 'SGR01', located: false, order: ['official', 'calc', 'file'],
      today: { date: '2026-11-03', source: 'official', emergency: false },
      official: { zone: 'SGR01', years: [{ year: 2026, days: 334 }] },
      zones: { selectedKnown: true },
    });
    expect(s.zones.count).toBeGreaterThanOrEqual(50);
    expect(s.warnings).toEqual([]);
    expect(s.daysAhead.official).toBe(28);

    // today without any official day, but located: the calculation fills it and it is an emergency in Malaysia
    putFeature(app.surau.db, 'location', { latitude: 3.07, longitude: 101.52 }, 'tester', undefined, 'sdm');
    putFeature(app.surau.db, 'zone', { zone: 'JHR02' }, 'tester', undefined, 'sdm');
    s = (await app.inject({ method: 'GET', url: '/api/prayer/status', headers: admin.headers })).json();
    expect(s.today).toMatchObject({ source: 'calc', emergency: true });
    expect(s.warnings).toContain('Hari ini guna kiraan sementara');
    const health = (await app.inject({ method: 'GET', url: '/api/health', headers: admin.headers })).json();
    expect(health.prayer.warnings).toContain('Hari ini guna kiraan sementara');
    expect(health.daysAhead).toBe(health.prayer.daysAhead.official + health.prayer.daysAhead.file);
  });

  it('GET /api/health keeps daysAhead as the pilot knew it when nothing is located', async () => {
    const app = makeApp();
    const { admin } = await logins(app);
    importDays(app.surau.db, 'SGR01', official, 'tester', undefined, undefined, 'sdm');
    const health = (await app.inject({ method: 'GET', url: '/api/health', headers: admin.headers })).json();
    // from 2026-11-03 to 2026-12-31
    expect(health.daysAhead).toBe(59);
    expect(health.prayer).toMatchObject({ today: { source: 'official' }, warnings: [] });
  });

  it('GET /api/prayer/calc/preview and /api/prayer/countries', async () => {
    const app = makeApp();
    const { ajk } = await logins(app);
    const none = await app.inject({ method: 'GET', url: '/api/prayer/calc/preview?date=2026-11-09', headers: ajk.headers });
    expect(none.statusCode).toBe(200);
    expect(none.json()).toBeNull();
    putFeature(app.surau.db, 'location', { latitude: 3.07, longitude: 101.52 }, 'tester', undefined, 'sdm');
    const day = (await app.inject({ method: 'GET', url: '/api/prayer/calc/preview?date=2026-11-09', headers: ajk.headers })).json();
    expect(day.date).toBe('2026-11-09');
    expect(Object.keys(day.times)).toHaveLength(7);
    expect((await app.inject({ method: 'GET', url: '/api/prayer/calc/preview?date=bad', headers: ajk.headers })).statusCode).toBe(400);

    const c = await app.inject({ method: 'GET', url: '/api/prayer/countries?lang=ms', headers: ajk.headers });
    expect(c.statusCode).toBe(200);
    expect(c.headers['cache-control']).toBe('max-age=86400');
    const list = c.json() as { code: string; name: string; timezones: string[]; defaults: { method: string }; hasOfficial: boolean }[];
    const my = list.find((x) => x.code === 'MY')!;
    expect(my).toMatchObject({ name: 'Malaysia', timezones: ['Asia/Kuala_Lumpur', 'Asia/Kuching'], hasOfficial: true });
    expect(my.defaults.method).toBe('jakim');
    expect(list.find((x) => x.code === 'KE')).toMatchObject({ hasOfficial: false, defaults: { method: 'mwl' } });
    const en = (await app.inject({ method: 'GET', url: '/api/prayer/countries?lang=en', headers: ajk.headers })).json() as { code: string; name: string }[];
    expect(en.find((x) => x.code === 'JP')!.name).toBe('Japan');
    expect(list.find((x) => x.code === 'JP')!.name).toBe('Jepun');
  });
});

describe('automatic fetch only for a country with an official source', () => {
  it('runOnce is not run for Kenya and is for Malaysia', async () => {
    const app = makeApp();
    let calls = 0;
    const fetchImpl = (async () => { calls++; throw new Error('no network in tests'); }) as unknown as typeof fetch;
    const mk = (): ReturnType<typeof createPrayerAutoFetch> => createPrayerAutoFetch({ db: app.surau.db, now: () => AT, fetchImpl, surauIds: () => ['sdm'] });
    expect(await mk().runOnce('sdm')).toMatchObject({ ran: true, ok: false });
    expect(calls).toBeGreaterThan(0);
    calls = 0;
    putFeature(app.surau.db, 'location', { country: 'KE', timezone: 'Africa/Nairobi' }, 'tester', undefined, 'sdm');
    expect(await mk().runOnce('sdm')).toEqual({ ran: false });
    expect(calls).toBe(0);
  });
});

describe('[P1] the health count of days ahead', () => {
  it('[P1] a Malaysian surau with coordinates and 20 official days reports daysAhead 20; abroad reports the resolved count', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    putFeature(app.surau.db, 'location', { latitude: 3.07, longitude: 101.52 }, 'tester', undefined, 'sdm');
    importDays(app.surau.db, 'SGR01', official.filter((d) => d.date >= '2026-11-03' && d.date <= '2026-11-22'), 'tester', undefined, undefined, 'sdm');
    const health = (await app.inject({ method: 'GET', url: '/api/health', headers: admin.headers })).json();
    expect(health.daysAhead).toBe(20);
    expect(health.prayer.daysAhead).toMatchObject({ official: 20, file: 0 });
    expect(health.prayer.daysAhead.resolved).toBeGreaterThan(300);
    expect(health.prayer.daysAhead.calc).toBe(health.prayer.daysAhead.resolved - 20);

    putFeature(app.surau.db, 'location', { country: 'KE', timezone: 'Africa/Nairobi', latitude: -1.2921, longitude: 36.8219, city: 'Nairobi' }, 'tester', undefined, 'sdm');
    const abroad = (await app.inject({ method: 'GET', url: '/api/health', headers: admin.headers })).json();
    expect(abroad.daysAhead).toBe(abroad.prayer.daysAhead.resolved);
    expect(abroad.daysAhead).toBeGreaterThan(300);
  });
});

describe('[P3] the official CSV is checked against its year and can be undone', () => {
  const load = (app: FastifyInstance, headers: object, year?: number) =>
    app.inject({ method: 'POST', url: '/api/prayer/import', headers: headers as never, payload: { zone: 'SGR01', csv, ...(year === undefined ? {} : { year }) } });
  const count = (app: FastifyInstance): number => Number(app.surau.db.prepare("SELECT COUNT(*) AS n FROM prayer_days WHERE zone = 'SGR01'").get()?.n);

  it('[P3] a 2026 CSV sent with year 2027 is 400 csv_year_mismatch and nothing changes', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const r = await load(app, admin.headers, 2027);
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'csv_year_mismatch', detail: { year: 2027, from: '2026-01-01', to: '2026-12-31' } });
    expect(count(app)).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/prayer/imports', headers: admin.headers })).json().imports).toEqual([]);
  });

  it('[P3] a good load is in the import records and undo restores the previous days', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const day = official.find((d) => d.date === '2026-11-03')!;
    importDays(app.surau.db, 'SGR01', [{ ...day, times: { ...day.times, subuh: '05:11' } }], 'tester', undefined, undefined, 'sdm');
    const r = await load(app, admin.headers, 2026);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ inserted: 364, replaced: 1 });
    const list = (await app.inject({ method: 'GET', url: '/api/prayer/imports', headers: admin.headers })).json().imports;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'official-csv', dateFrom: '2026-01-01', dateTo: '2026-12-31', rows: 365, undoneAt: null });
    expect(count(app)).toBe(365);
    const undo = await app.inject({ method: 'POST', url: `/api/prayer/imports/${list[0].id}/undo`, headers: admin.headers });
    expect(undo.statusCode).toBe(200);
    expect(count(app)).toBe(1);
    const row = app.surau.db.prepare("SELECT json FROM prayer_days WHERE zone = 'SGR01' AND date = '2026-11-03'").get();
    expect(JSON.parse(String(row?.json)).times.subuh).toBe('05:11');
    const again = await app.inject({ method: 'POST', url: `/api/prayer/imports/${list[0].id}/undo`, headers: admin.headers });
    expect(again.statusCode).toBe(409);
  });

  it('[P3] an undo of an earlier load is blocked while a later load covers its days (undo_blocked)', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    expect((await load(app, admin.headers, 2026)).statusCode).toBe(200);
    expect((await load(app, admin.headers, 2026)).statusCode).toBe(200);
    const list = (await app.inject({ method: 'GET', url: '/api/prayer/imports', headers: admin.headers })).json().imports as Array<{ id: string }>;
    const older = list[1]!;
    const r = await app.inject({ method: 'POST', url: `/api/prayer/imports/${older.id}/undo`, headers: admin.headers });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: 'undo_blocked', detail: { date: '2026-01-01' } });
    expect(typeof r.json().detail.by).toBe('string');
  });
});

describe('[P5] prayer refusals and warnings carry codes', () => {
  const failing = (kind: 'network' | 'norecord'): typeof fetch => (async () => {
    if (kind === 'network') throw new Error('connect ECONNREFUSED');
    return new Response(JSON.stringify({ status: 'NO_RECORD!', prayerTime: { data: [] } }));
  }) as unknown as typeof fetch;
  const appWith = (fetchImpl: typeof fetch): FastifyInstance => {
    const d = mkdtempSync(join(tmpdir(), 'surau-prayer-'));
    dirs.push(d);
    const app = buildApp(join(d, 'test.db'), { now: () => AT, fetchImpl });
    apps.push(app);
    return app;
  };

  it('[P5] no data today: the status warning has its code', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const bare = (await app.inject({ method: 'GET', url: '/api/prayer/status', headers: admin.headers })).json();
    expect(bare.warningCodes).toContainEqual({ code: 'not_located', detail: {} });
    putFeature(app.surau.db, 'location', { latitude: 89.9, longitude: 0 }, 'tester', undefined, 'sdm');
    const s = (await app.inject({ method: 'GET', url: '/api/prayer/status', headers: admin.headers })).json();
    expect(s.warnings).toContain('Tiada data waktu solat untuk hari ini');
    expect(s.warningCodes).toContainEqual({ code: 'no_data_today', detail: {} });
  });

  it('[P5] a zone with no data: the settings answer has code zone_no_data with its detail', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const r = await app.inject({ method: 'PUT', url: '/api/settings/zone', headers: admin.headers, payload: { zone: 'JHR02' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().warningCodes).toEqual([{ code: 'zone_no_data', detail: { willFetch: false } }]);
  });

  it('[P5] e-Solat down is 502 esolat_unreachable; an unpublished year is 502 esolat_no_record', async () => {
    const down = appWith(failing('network'));
    const a = await loginAs(down, 'admin');
    const r1 = await down.inject({ method: 'POST', url: '/api/prayer/import', headers: a.headers, payload: { zone: 'SGR01', year: 2027, source: 'esolat' } });
    expect(r1.statusCode).toBe(502);
    expect(r1.json()).toMatchObject({ code: 'esolat_unreachable' });
    expect(r1.json().errors).toHaveLength(1);
    const none = appWith(failing('norecord'));
    const b = await loginAs(none, 'admin');
    const r2 = await none.inject({ method: 'POST', url: '/api/prayer/import', headers: b.headers, payload: { zone: 'SGR01', year: 2027, source: 'esolat' } });
    expect(r2.statusCode).toBe(502);
    expect(r2.json()).toMatchObject({ code: 'esolat_no_record', detail: { year: 2027, zone: 'SGR01' } });
  });

  it('[P5] a bad file row has code import_row_invalid with row, field and reason', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const text = 'tarikh,imsak,subuh,syuruk,dhuha,zohor,asar,maghrib,isyak,nota\n2026-11-03,04:40,04:50,06:00,,12:12,xx:yy,18:20,19:30,';
    const dry = await app.inject({ method: 'POST', url: '/api/prayer/import/file', headers: admin.headers, payload: { kind: 'csv', name: 'a.csv', dryRun: true, overlap: 'replace', text } });
    expect(dry.statusCode).toBe(200);
    expect(dry.json().errors[0]).toMatchObject({ row: 2, code: 'import_row_invalid', field: 'asar', reason: 'invalid' });
    const apply = await app.inject({ method: 'POST', url: '/api/prayer/import/file', headers: admin.headers, payload: { kind: 'csv', name: 'a.csv', dryRun: false, overlap: 'replace', text, expectSha256: dry.json().sha256 } });
    expect(apply.statusCode).toBe(400);
    expect(apply.json()).toMatchObject({ code: 'import_row_invalid', detail: { row: 2, field: 'asar', reason: 'invalid' } });
  });

  it('[P5] the countries list accepts lang=ar and names them in Arabic', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ar = new Intl.DisplayNames(['ar'], { type: 'region' });
    const list = (await app.inject({ method: 'GET', url: '/api/prayer/countries?lang=ar', headers: admin.headers })).json() as Array<{ code: string; name: string }>;
    expect(list.find((c) => c.code === 'MY')!.name).toBe(ar.of('MY'));
    const ms = (await app.inject({ method: 'GET', url: '/api/prayer/countries', headers: admin.headers })).json() as Array<{ code: string; name: string }>;
    expect(ms.find((c) => c.code === 'MY')!.name).not.toBe(ar.of('MY'));
  });
});

describe('[P7] a country without an official source is not offered JAKIM actions', () => {
  it('[P7] fetch, the official hint and a pasted official CSV are 409 no_official_source for a UK surau', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    putFeature(app.surau.db, 'location', { country: 'GB', timezone: 'Europe/London', latitude: 51.5, longitude: -0.12, city: 'London' }, 'tester', undefined, 'sdm');
    const fetched = await app.inject({ method: 'POST', url: '/api/prayer/import', headers: admin.headers, payload: { zone: 'SGR01', year: 2026, source: 'esolat' } });
    expect(fetched.statusCode).toBe(409);
    expect(fetched.json()).toMatchObject({ code: 'no_official_source' });
    const pasted = await app.inject({ method: 'POST', url: '/api/prayer/import', headers: admin.headers, payload: { zone: 'SGR01', csv, year: 2026 } });
    expect(pasted.statusCode).toBe(409);
    expect(pasted.json()).toMatchObject({ code: 'no_official_source' });
    const hint = await app.inject({ method: 'POST', url: '/api/prayer/import/file', headers: admin.headers, payload: { kind: 'csv', name: 'e.csv', dryRun: true, overlap: 'replace', text: csv } });
    expect(hint.statusCode).toBe(409);
    expect(hint.json()).toMatchObject({ code: 'no_official_source' });
    expect(Number(app.surau.db.prepare('SELECT COUNT(*) AS n FROM prayer_days').get()?.n)).toBe(0);
  });
});

describe('[P8] the new-zone warning follows the auto-fetch state', () => {
  const put = (app: FastifyInstance, headers: object, body: object) => app.inject({ method: 'PUT', url: '/api/settings/zone', headers: headers as never, payload: body });

  it('[P8] zone_no_data carries willFetch false when auto-fetch is off and the sentence does not promise a download', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const r = await put(app, admin.headers, { zone: 'JHR02' });
    expect(r.json().warningCodes).toEqual([{ code: 'zone_no_data', detail: { willFetch: false } }]);
    expect(r.json().warnings.join(' ')).not.toMatch(/akan memuat turun/);
  });

  it('[P8] willFetch is true when the box fetches by itself, false when the surau turned auto-fetch off', async () => {
    const d = mkdtempSync(join(tmpdir(), 'surau-prayer-'));
    dirs.push(d);
    const app = buildApp(join(d, 'test.db'), { now: () => AT, autoPrayerFetch: { firstDelayMs: 3_600_000 }, fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch });
    apps.push(app);
    const admin = await loginAs(app, 'admin');
    const on = await put(app, admin.headers, { zone: 'JHR02' });
    expect(on.json().warningCodes).toEqual([{ code: 'zone_no_data', detail: { willFetch: true } }]);
    expect(on.json().warnings.join(' ')).toMatch(/akan memuat turun/);
    const off = await put(app, admin.headers, { zone: 'JHR03', autoFetch: false });
    expect(off.json().warningCodes).toEqual([{ code: 'zone_no_data', detail: { willFetch: false } }]);
  });
});
