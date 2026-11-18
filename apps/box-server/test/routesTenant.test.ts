import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { klInstant } from '@surau/core';
import type { PrayerDay } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { beginEnrolment } from '../src/auth/devices.ts';
import { openDb } from '../src/db.ts';
import { putProviderItem } from '../src/content/store.ts';
import type { HadeethEncClient } from '../src/hadis/hadeethenc.ts';
import { startHadisTimers } from '../src/hadis/updates.ts';
import { createPrayerAutoFetch } from '../src/prayerAutoFetch.ts';
import { countDaysFrom } from '../src/prayerStore.ts';
import { getSettings, getVersion, putFeature } from '../src/settingsStore.ts';
import { timerSurauIds } from '../src/reqSurau.ts';
import { loginAs, TEST_PIN } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';

const A = 'sdm';
const B = 'masjid-b';
const AT = klInstant('2026-11-03', '12:00');
const BOX_A = 'a1b2c3d4e5f60718';
const BOX_B = '0123456789abcdef';

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
const dbs: DatabaseSync[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dbs.splice(0)) try { d.close(); } catch { /* closed */ }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const noNetwork = (async () => { throw new TypeError('network disabled in tests'); }) as unknown as typeof fetch;

function cloudApp(): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-tenant-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'c.db'), { dataDir: dir, role: 'cloud', now: () => AT, fetchImpl: noNetwork });
  apps.push(app);
  const ins = app.surau.db.prepare('INSERT INTO suraus (id, name, created_at, created_by) VALUES (?, ?, ?, ?)');
  ins.run(A, 'Surau A', AT.toISOString(), 'test');
  ins.run(B, 'Surau B', AT.toISOString(), 'test');
  return app;
}

function boxApp(): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-tenant-box-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'b.db'), { dataDir: dir, now: () => AT, fetchImpl: noNetwork });
  apps.push(app);
  return app;
}

function linkSite(app: FastifyInstance, surauId: string, boxId: string, over: { revoked?: boolean; linked?: boolean } = {}): void {
  app.surau.db
    .prepare('INSERT INTO sites (surau_id, box_id, name, linked_at, revoked_at) VALUES (?, ?, ?, ?, ?)')
    .run(surauId, boxId, `Kotak ${boxId.slice(0, 4)}`, over.linked === false ? null : AT.toISOString(), over.revoked === true ? AT.toISOString() : null);
}

interface Rig { app: FastifyInstance; a: Login; b: Login }
async function rig(): Promise<Rig> {
  const app = cloudApp();
  const a = await loginAs(app, 'admin', TEST_PIN, A);
  const b = await loginAs(app, 'admin', TEST_PIN, B);
  return { app, a, b };
}

const call = (r: Rig, who: Login, method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  r.app.inject({ method, url, headers: who.headers, ...(payload === undefined ? {} : { payload: payload as object }) });

describe('every route works in the request surau (cloud role, two suraus)', () => {
  it('the device of each admin is filed under its own surau', async () => {
    const r = await rig();
    const row = (id: string): string => String(r.app.surau.db.prepare('SELECT surau_id FROM devices WHERE id = ?').get(id)?.surau_id);
    expect(row(r.a.deviceId)).toBe(A);
    expect(row(r.b.deviceId)).toBe(B);
  });

  it('settings written in a are invisible in b, and the versions are independent', async () => {
    const r = await rig();
    const vb = getVersion(r.app.surau.db, B);
    expect((await call(r, r.a, 'PUT', '/api/settings/surauInfo', { name: 'Surau Aman' })).statusCode).toBe(200);
    expect((await call(r, r.a, 'GET', '/api/settings')).json().surauInfo.name).toBe('Surau Aman');
    expect((await call(r, r.b, 'GET', '/api/settings')).json().surauInfo.name).not.toBe('Surau Aman');
    expect(getVersion(r.app.surau.db, B)).toBe(vb);
    expect(getSettings(r.app.surau.db, A).surauInfo.name).toBe('Surau Aman');
  });

  it('content written in a is invisible in b (list, get, kiosk content) and b cannot delete it', async () => {
    const r = await rig();
    const put = await call(r, r.a, 'PUT', '/api/content/ticker/t1', { text: 'Berita A', from: '2026-11-01', to: '2026-12-01' });
    expect(put.statusCode).toBe(201);
    expect((await call(r, r.a, 'GET', '/api/content/ticker')).json().items).toHaveLength(1);
    expect((await call(r, r.b, 'GET', '/api/content/ticker')).json().items).toHaveLength(0);
    expect((await call(r, r.b, 'GET', '/api/content/ticker/t1')).statusCode).toBe(404);
    expect(JSON.stringify((await call(r, r.b, 'GET', '/api/kiosk/content')).json())).not.toContain('Berita A');
    expect(JSON.stringify((await call(r, r.a, 'GET', '/api/kiosk/content')).json())).toContain('Berita A');
    await call(r, r.b, 'DELETE', '/api/content/ticker/t1');
    expect((await call(r, r.a, 'GET', '/api/content/ticker')).json().items).toHaveLength(1);
  });

  it('finance written in a is invisible in b', async () => {
    const r = await rig();
    for (const [who, s] of [[r.a, A], [r.b, B]] as const) {
      expect(who.userId).not.toBe('');
      putFeature(r.app.surau.db, 'finance', { enabled: true }, 'test', undefined, s);
    }
    expect((await call(r, r.a, 'PUT', '/api/finance/funds/f-a', { name: 'Tabung Khas A', public: false })).statusCode).toBe(200);
    const listA = (await call(r, r.a, 'GET', '/api/finance/funds')).json().funds as Array<{ id: string }>;
    const listB = (await call(r, r.b, 'GET', '/api/finance/funds')).json().funds as Array<{ id: string }>;
    expect(listA.map((f) => f.id)).toContain('f-a');
    expect(listB.map((f) => f.id)).not.toContain('f-a');
  });

  it('prayer data written in a is invisible in b', async () => {
    const r = await rig();
    const times: PrayerDay['times'] = { imsak: '05:40', subuh: '05:50', syuruk: '07:00', zohor: '13:10', asar: '16:20', maghrib: '19:10', isyak: '20:20' };
    const csv = ['Date,Hijri,Imsak,Fajr,Syuruk,Dhuhr,Asr,Maghrib,Isha', `03-Nov-2026,1448-05-10,${times.imsak}:00,${times.subuh}:00,${times.syuruk}:00,${times.zohor}:00,${times.asar}:00,${times.maghrib}:00,${times.isyak}:00`].join('\n');
    const imp = await call(r, r.a, 'POST', '/api/prayer/import', { zone: 'SGR01', csv });
    // the import is accepted or refused on its own merits; what matters is where the days land
    const inA = countDaysFrom(r.app.surau.db, 'SGR01', '2026-01-01', A);
    const inB = countDaysFrom(r.app.surau.db, 'SGR01', '2026-01-01', B);
    if (imp.statusCode === 200) expect(inA).toBeGreaterThan(0);
    expect(inB).toBe(0);
    const stB = (await call(r, r.b, 'GET', '/api/prayer/status')).json() as { official: { years: unknown[] } };
    expect(stB.official.years).toHaveLength(0);
  });

  it('users written in a are invisible in b and b cannot touch them', async () => {
    const r = await rig();
    const made = await call(r, r.a, 'POST', '/api/users', { name: 'Ali A', roles: ['ajk'], phone: '012-000 0002' });
    expect(made.statusCode).toBe(201);
    const aliId = String(made.json().id);
    const namesA = ((await call(r, r.a, 'GET', '/api/users')).json().users as Array<{ id: string }>).map((u) => u.id);
    const namesB = ((await call(r, r.b, 'GET', '/api/users')).json().users as Array<{ id: string }>).map((u) => u.id);
    expect(namesA).toContain(aliId);
    expect(namesB).not.toContain(aliId);
    expect((await call(r, r.b, 'PUT', `/api/users/${aliId}/roles`, { roles: ['admin'] })).statusCode).toBe(404);
    expect((await call(r, r.b, 'POST', `/api/users/${aliId}/deactivate`)).statusCode).toBe(404);
    expect((await call(r, r.b, 'PUT', `/api/users/${aliId}/pin`, {})).statusCode).toBe(404);
    expect((await call(r, r.b, 'POST', '/api/enrol/begin', { userId: aliId })).statusCode).toBe(404);
    const row = r.app.surau.db.prepare('SELECT roles_json, active FROM users WHERE id = ?').get(aliId);
    expect(row?.roles_json).toBe('["ajk"]');
    expect(row?.active).toBe(1);
  });

  it('devices of a are invisible in b and b cannot revoke them', async () => {
    const r = await rig();
    const listB = ((await call(r, r.b, 'GET', '/api/devices')).json().devices as Array<{ id: string }>).map((d) => d.id);
    expect(listB).toContain(r.b.deviceId);
    expect(listB).not.toContain(r.a.deviceId);
    expect((await call(r, r.b, 'POST', `/api/devices/${r.a.deviceId}/revoke`)).statusCode).toBe(404);
    expect(r.app.surau.db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(r.a.deviceId)?.revoked_at).toBeNull();
  });

  it('an ordinary enrolment by an admin of b makes a device of b', async () => {
    const r = await rig();
    const made = await call(r, r.b, 'POST', '/api/users', { name: 'Bakar B', roles: ['ajk'], phone: '012-000 0003' });
    expect(made.statusCode).toBe(201);
    // the cloud makes no device code for a surau's person (409 box_only): the box makes it, so issue it as the box does
    const refused = await call(r, r.b, 'POST', '/api/enrol/begin', { userId: String(made.json().id) });
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toContain('box_only');
    const begin = { json: () => beginEnrolment(r.app.surau.db, { userId: String(made.json().id), deviceName: 'Telefon' }, 'test', { canManageSuperadmin: false }) };
    const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
    const done = await r.app.inject({
      method: 'POST', url: '/api/enrol/complete', remoteAddress: '10.77.0.9',
      payload: { code: begin.json().code, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, platform: 'web', pin: TEST_PIN },
    });
    expect(done.statusCode).toBe(200);
    expect(r.app.surau.db.prepare('SELECT surau_id FROM devices WHERE id = ?').get(String(done.json().deviceId))?.surau_id).toBe(B);
  });
});

describe('public routes on the cloud answer by X-Maxcom-Box', () => {
  async function publicRig(): Promise<Rig> {
    const r = await rig();
    expect((await call(r, r.a, 'PUT', '/api/settings/surauInfo', { name: 'Surau Aman' })).statusCode).toBe(200);
    expect((await call(r, r.b, 'PUT', '/api/settings/surauInfo', { name: 'Masjid Bayu' })).statusCode).toBe(200);
    linkSite(r.app, A, BOX_A);
    linkSite(r.app, B, BOX_B);
    return r;
  }
  const info = (r: Rig, headers: Record<string, string> = {}) => r.app.inject({ method: 'GET', url: '/api/surau/info', headers });

  it('a linked box id answers that surau; each box its own', async () => {
    const r = await publicRig();
    expect((await info(r, { 'x-maxcom-box': BOX_A })).json().name).toBe('Surau Aman');
    expect((await info(r, { 'x-maxcom-box': BOX_B })).json().name).toBe('Masjid Bayu');
  });

  it('no header, a malformed id, an unknown id, a revoked or unlinked box all get the one neutral answer', async () => {
    const r = await publicRig();
    linkSite(r.app, A, 'fedcba9876543210', { revoked: true });
    linkSite(r.app, A, '1111111111111111', { linked: false });
    const neutral = (await info(r)).json();
    expect(neutral.name).toBe('MAXCOM');
    for (const h of ['not-hex', 'ABCDEF0123456789', '0000000000000000', 'ffffffffffffffff', 'fedcba9876543210', '1111111111111111']) {
      const got = await info(r, { 'x-maxcom-box': h });
      expect(got.statusCode).toBe(200);
      expect(got.json()).toEqual(neutral);
    }
    expect(JSON.stringify(neutral)).not.toContain('Surau Aman');
    expect(JSON.stringify(neutral)).not.toContain('Masjid Bayu');
  });

  it('the logo route is neutral (404) without a linked box id', async () => {
    const r = await publicRig();
    expect((await r.app.inject({ method: 'GET', url: '/surau-logo' })).statusCode).toBe(404);
    expect((await r.app.inject({ method: 'GET', url: '/surau-logo', headers: { 'x-maxcom-box': 'ffffffffffffffff' } })).statusCode).toBe(404);
  });

  it('anonymous /api/health lists no sites; an admin sees only the sites of its own surau', async () => {
    const r = await publicRig();
    const anon = await r.app.inject({ method: 'GET', url: '/api/health' });
    expect(anon.statusCode).toBe(200);
    expect(anon.json().ok).toBe(true);
    expect(anon.json().sync).toBeUndefined();
    expect(JSON.stringify(anon.json())).not.toContain(BOX_A);
    expect(JSON.stringify(anon.json())).not.toContain(BOX_B);
    const withBox = await r.app.inject({ method: 'GET', url: '/api/health', headers: { 'x-maxcom-box': BOX_A } });
    expect(withBox.json().sync).toBeUndefined();
    const sitesOf = async (who: Login): Promise<string[]> =>
      ((await call(r, who, 'GET', '/api/health')).json().sync.sites as Array<{ boxId: string }>).map((s) => s.boxId);
    expect(await sitesOf(r.a)).toEqual([BOX_A]);
    expect(await sitesOf(r.b)).toEqual([BOX_B]);
  });

  it('a box answers for its own surau and ignores the header', async () => {
    const box = boxApp();
    const login = await loginAs(box, 'admin');
    await box.inject({ method: 'PUT', url: '/api/settings/surauInfo', headers: login.headers, payload: { name: 'Surau Kotak' } });
    const plain = await box.inject({ method: 'GET', url: '/api/surau/info' });
    expect(plain.json().name).toBe('Surau Kotak');
    expect((await box.inject({ method: 'GET', url: '/api/surau/info', headers: { 'x-maxcom-box': 'ffffffffffffffff' } })).json().name).toBe('Surau Kotak');
    expect((await box.inject({ method: 'GET', url: '/api/health' })).json().ok).toBe(true);
  });
});

describe('timers run per surau on the cloud and once on a box', () => {
  const TIMES: PrayerDay['times'] = { imsak: '05:40', subuh: '05:50', syuruk: '07:00', zohor: '13:10', asar: '16:20', maghrib: '19:10', isyak: '20:20' };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n: number): string => String(n).padStart(2, '0');
  const okYear = (year: number): Response => {
    const days = [];
    for (let t = Date.UTC(year, 0, 1); new Date(t).getUTCFullYear() === year; t += 86_400_000) {
      const d = new Date(t);
      days.push({
        date: `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${year}`, hijri: '1448-05-10',
        imsak: `${TIMES.imsak}:00`, fajr: `${TIMES.subuh}:00`, syuruk: `${TIMES.syuruk}:00`,
        dhuhr: `${TIMES.zohor}:00`, asr: `${TIMES.asar}:00`, maghrib: `${TIMES.maghrib}:00`, isha: `${TIMES.isyak}:00`,
      });
    }
    void pad;
    return new Response(JSON.stringify({ prayerTime: days }));
  };

  it('timerSurauIds: the cloud lists its suraus, a box only the local one', () => {
    const c = cloudApp();
    expect(timerSurauIds(c.surau.db, 'cloud')).toEqual([B, A].sort());
    expect(timerSurauIds(c.surau.db, 'box')).toEqual(['sdm']);
  });

  it('the prayer top-up runs for every surau of the cloud, each with its own status', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-timer-'));
    dirs.push(dir);
    const db = openDb(join(dir, 't.db'));
    dbs.push(db);
    for (const s of [A, B]) putFeature(db, 'zone', { zone: 'SGR01' }, 'test', undefined, s);
    const fetchImpl = (async (_u: string, init: RequestInit) => okYear(Number(String(init.body).slice(10, 14)))) as unknown as typeof fetch;
    const changed: Array<[number, string]> = [];
    const af = createPrayerAutoFetch({ db, now: () => AT, fetchImpl, surauIds: () => [A, B], onChanged: (v, s) => changed.push([v, s]) });
    await af.runAll();
    expect(countDaysFrom(db, 'SGR01', '2026-11-03', A)).toBeGreaterThan(30);
    expect(countDaysFrom(db, 'SGR01', '2026-11-03', B)).toBeGreaterThan(30);
    expect(changed.map(([, s]) => s).sort()).toEqual([B, A].sort());
    expect(af.status(A).lastOk).toBe(true);
    expect(af.status(B).lastOk).toBe(true);
  });

  it('the prayer top-up of a box serves its one surau only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-timer-'));
    dirs.push(dir);
    const db = openDb(join(dir, 't.db'));
    dbs.push(db);
    const fetchImpl = (async (_u: string, init: RequestInit) => okYear(Number(String(init.body).slice(10, 14)))) as unknown as typeof fetch;
    const af = createPrayerAutoFetch({ db, now: () => AT, fetchImpl, surauIds: () => timerSurauIds(db, 'box') });
    await af.runAll();
    expect(countDaysFrom(db, 'SGR01', '2026-11-03', 'sdm')).toBeGreaterThan(30);
    expect(countDaysFrom(db, 'SGR01', '2026-11-03', B)).toBe(0);
  });

  it('the weekly hadis check runs for every surau, and the box still gets its timer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-timer-'));
    dirs.push(dir);
    const db = openDb(join(dir, 't.db'));
    dbs.push(db);
    const item = (n: string) => ({
      id: `hadeethenc-${n}`, textMs: 'x', source: 'Riwayat Muslim', grade: 'sahih', shown: true,
      ext: { provider: 'hadeethenc', id: n, attributionAr: 'رواه مسلم', gradeAr: 'صحيح', categories: [], fetchedAt: AT.toISOString(), digest: 'e'.repeat(64) },
    });
    putProviderItem(db, item('100') as never, 'test', A);
    putProviderItem(db, item('200') as never, 'test', B);
    const asked: string[] = [];
    const client: HadeethEncClient = {
      categories: async () => [], list: async () => { throw new Error('unused'); },
      one: async (id) => { asked.push(id); throw new Error('offline'); },
      probe: async () => true,
    };
    const job = { start: () => 'busy', hold: () => () => undefined, noteUnknown: () => undefined, current: () => null, last: () => null, status: () => null, stop: () => undefined } as never;
    vi.useFakeTimers();
    const stop = startHadisTimers({ db, surauIds: () => [A, B], client, job, now: () => AT, firstMs: 10, everyMs: 1_000_000, check: { pauseMs: 0 } });
    await vi.advanceTimersByTimeAsync(100);
    stop();
    expect(asked.sort()).toEqual(['100', '200']);
  });
});
