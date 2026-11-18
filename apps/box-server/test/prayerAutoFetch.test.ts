import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { klInstant } from '@surau/core';
import type { PrayerDay } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { createPrayerAutoFetch } from '../src/prayerAutoFetch.ts';
import { countDaysFrom, getDays, importDays } from '../src/prayerStore.ts';
import { getSettings, getVersion, putFeature } from '../src/settingsStore.ts';
import { withAdmin } from './authHelpers.ts';
import { ensureSurau } from './support/surauRow.ts';

const AT = klInstant('2026-11-03', '12:00');
const TIMES: PrayerDay['times'] = {
  imsak: '05:40', subuh: '05:50', syuruk: '07:00', zohor: '13:10', asar: '16:20', maghrib: '19:10', isyak: '20:20',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number): string => String(n).padStart(2, '0');

function yearDays(year: number, times: PrayerDay['times'] = TIMES): PrayerDay[] {
  const out: PrayerDay[] = [];
  for (let t = Date.UTC(year, 0, 1); new Date(t).getUTCFullYear() === year; t += 86_400_000) {
    const d = new Date(t);
    out.push({
      date: `${year}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
      hijri: { y: 1448, m: 5, d: 10, raw: '1448-05-10' } as PrayerDay['hijri'],
      times,
    });
  }
  return out;
}

const toApi = (day: PrayerDay) => {
  const [y, m, d] = day.date.split('-').map(Number) as [number, number, number];
  return {
    date: `${d}-${MONTHS[m - 1]}-${y}`,
    hijri: '1448-05-10',
    imsak: `${day.times.imsak}:00`, fajr: `${day.times.subuh}:00`, syuruk: `${day.times.syuruk}:00`,
    dhuhr: `${day.times.zohor}:00`, asr: `${day.times.asar}:00`, maghrib: `${day.times.maghrib}:00`, isha: `${day.times.isyak}:00`,
  };
};

interface Fake { impl: typeof fetch; calls: string[]; bodies: string[] }
function fakeEsolat(respond: (year: number) => Response | Error): Fake {
  const calls: string[] = [];
  const bodies: string[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push(String(url));
    bodies.push(String(init.body));
    const year = Number(String(init.body).slice(10, 14));
    const r = respond(year);
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { impl, calls, bodies };
}
const okYear = (year: number): Response => new Response(JSON.stringify({ prayerTime: yearDays(year).map(toApi) }));
const noRecord = (): Response => new Response(JSON.stringify({ status: 'NO_RECORD!', prayerTime: { data: [] } }));

const dbs: DatabaseSync[] = [];
const dirs: string[] = [];
const apps: FastifyInstance[] = [];
function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'surau-autofetch-'));
  dirs.push(dir);
  return join(dir, 't.db');
}
function newDb(): DatabaseSync {
  const db = openDb(tempPath());
  dbs.push(db);
  return db;
}
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dbs.splice(0)) try { d.close(); } catch { /* closed */ }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runner(db: DatabaseSync, fake: Fake, extra: Partial<Parameters<typeof createPrayerAutoFetch>[0]> = {}) {
  return createPrayerAutoFetch({ db, now: () => AT, fetchImpl: fake.impl, surauIds: () => ['sdm'], ...extra });
}
const auditRows = (db: DatabaseSync) =>
  db.prepare("SELECT actor, after_json FROM change_log WHERE entity = 'prayer_days' ORDER BY id").all();

describe('automatic prayer-data fetch', () => {
  it('fetches the current year when it has no data from today, and fills only dates from today', async () => {
    const db = newDb();
    const fake = fakeEsolat((y) => okYear(y));
    const out = await runner(db, fake).runOnce('sdm');
    expect(fake.bodies).toEqual(['datestart=2026-01-01&dateend=2026-12-31']);
    expect(out).toMatchObject({ ran: true, ok: true, added: 59 });
    expect(countDaysFrom(db, 'SGR01', '2026-11-03', 'sdm')).toBe(59);
    expect(getDays(db, 'SGR01', '2026-01-01', '2026-11-02', 'sdm')).toHaveLength(0);
  });

  it('picks the next year when the current year is full from today', async () => {
    const db = newDb();
    importDays(db, 'SGR01', yearDays(2026), 'tester', undefined, undefined, 'sdm');
    // 59 days ahead is below 60, so the run proceeds and asks for 2027
    const fake = fakeEsolat((y) => okYear(y));
    const out = await runner(db, fake).runOnce('sdm');
    expect(fake.bodies).toEqual(['datestart=2027-01-01&dateend=2027-12-31']);
    expect(out).toMatchObject({ ran: true, ok: true, added: 365 });
  });

  it('does not fetch at 60 days ahead or more', async () => {
    const db = newDb();
    importDays(db, 'SGR01', yearDays(2026).concat(yearDays(2027).slice(0, 5)), 'tester', undefined, undefined, 'sdm');
    expect(countDaysFrom(db, 'SGR01', '2026-11-03', 'sdm')).toBe(64);
    const fake = fakeEsolat((y) => okYear(y));
    const r = runner(db, fake);
    expect(await r.runOnce('sdm')).toMatchObject({ ran: false });
    expect(fake.calls).toHaveLength(0);
    expect(r.status('sdm').lastAttemptAt).toBeNull();
  });

  it('NO_RECORD: no rows, attempt recorded, no throw, tries again next run', async () => {
    const db = newDb();
    const fake = fakeEsolat(() => noRecord());
    const r = runner(db, fake);
    const out = await r.runOnce('sdm');
    expect(out).toMatchObject({ ran: true, ok: false });
    expect(countDaysFrom(db, 'SGR01', '2026-01-01', 'sdm')).toBe(0);
    expect(r.status('sdm')).toMatchObject({ enabled: true, lastAttemptAt: AT.toISOString(), lastOk: false });
    expect(r.status('sdm').lastError).toMatch(/not published/);
    await r.runOnce('sdm');
    expect(fake.calls).toHaveLength(2);
    expect(auditRows(db)).toHaveLength(0);
  });

  it('network error: recorded, no throw, no secrets or addresses in the status', async () => {
    const db = newDb();
    const fake = fakeEsolat(() => new Error('connect ECONNREFUSED https://www.e-solat.gov.my/index.php?r=x&token=SECRET'));
    const r = runner(db, fake);
    await expect(r.runOnce('sdm')).resolves.toMatchObject({ ran: true, ok: false });
    expect(r.status('sdm').lastOk).toBe(false);
    expect(JSON.stringify(r.status('sdm'))).not.toMatch(/SECRET|https?:/);
    expect(countDaysFrom(db, 'SGR01', '2026-01-01', 'sdm')).toBe(0);
  });

  it('never overwrites a date that already has times', async () => {
    const db = newDb();
    const manual: PrayerDay[] = [{ ...yearDays(2026)[307]!, times: { ...TIMES, subuh: '05:55' } }];
    expect(manual[0]!.date).toBe('2026-11-04');
    importDays(db, 'SGR01', manual, 'user:manual', undefined, undefined, 'sdm');
    const fake = fakeEsolat((y) => okYear(y));
    const out = await runner(db, fake).runOnce('sdm');
    expect(out).toMatchObject({ added: 58 });
    expect(getDays(db, 'SGR01', '2026-11-04', '2026-11-04', 'sdm')[0]!.times.subuh).toBe('05:55');
    expect(countDaysFrom(db, 'SGR01', '2026-11-03', 'sdm')).toBe(59);
  });

  it('writes one audit entry when days were added, none when nothing was', async () => {
    const db = newDb();
    const fake = fakeEsolat((y) => okYear(y));
    const r = runner(db, fake);
    await r.runOnce('sdm');
    const rows = auditRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe('system:auto-prayer-fetch');
    expect(JSON.parse(String(rows[0]!.after_json))).toMatchObject({
      summary: 'Data waktu solat dimuat turun secara automatik dari e-Solat JAKIM: 59 hari ditambah',
    });
    // Remove the 2026 tail days that are still missing from the second run's point of view: all
    // present now (58), so the run is a no-op or targets 2027; make 2027 return the same days to
    // prove a no-add run writes nothing.
    const fakeNoop = fakeEsolat((y) => (y === 2026 ? okYear(2026) : noRecord()));
    const v = getVersion(db, 'sdm');
    await runner(db, fakeNoop).runOnce('sdm');
    expect(auditRows(db)).toHaveLength(1);
    expect(getVersion(db, 'sdm')).toBe(v);
  });

  it('does nothing when the setting is off', async () => {
    const db = newDb();
    putFeature(db, 'zone', { autoFetch: false }, 'tester', undefined, 'sdm');
    const fake = fakeEsolat((y) => okYear(y));
    const r = runner(db, fake);
    expect(await r.runOnce('sdm')).toMatchObject({ ran: false });
    expect(fake.calls).toHaveLength(0);
    expect(r.status('sdm').enabled).toBe(false);
  });

  it('does nothing when no zone is set', async () => {
    const db = newDb();
    const fake = fakeEsolat((y) => okYear(y));
    const base = getSettings(db, 'sdm');
    const r = runner(db, fake, {
      readSettings: () => ({ ...base, zone: { ...base.zone, zone: '' } }),
    });
    expect(await r.runOnce('sdm')).toMatchObject({ ran: false });
    expect(fake.calls).toHaveLength(0);
  });

  it('uses the configured e-Solat address and source name', async () => {
    const db = newDb();
    putFeature(db, 'dataSources', { esolat: { name: 'Sumber Lain', url: 'https://api.example.my/takwim' } }, 'tester', undefined, 'sdm');
    const fake = fakeEsolat((y) => okYear(y));
    await runner(db, fake).runOnce('sdm');
    expect(fake.calls[0]).toBe('https://api.example.my/takwim?period=duration&zone=SGR01');
    expect(String(auditRows(db)[0]!.after_json)).toContain('Sumber Lain');
  });

  it('counts the year per surau: surau A full in a zone does not stop surau B (same zone, empty) fetching', async () => {
    const db = newDb();
    importDays(db, 'SGR01', yearDays(2026).concat(yearDays(2027)), 'tester', undefined, undefined, 'a1');
    const fake = fakeEsolat((y) => okYear(y));
    const r = createPrayerAutoFetch({ db, now: () => AT, fetchImpl: fake.impl, surauIds: () => ['a1', 'b1'] });
    expect(await r.runOnce('a1')).toMatchObject({ ran: false });
    expect(fake.calls).toHaveLength(0);
    const out = await r.runOnce('b1');
    expect(out).toMatchObject({ ran: true, ok: true, added: 59, year: 2026 });
    expect(countDaysFrom(db, 'SGR01', '2026-11-03', 'b1')).toBe(59);
  });
});

describe('importDays insertOnly', () => {
  it('keeps existing dates and counts only inserts', () => {
    const db = newDb();
    importDays(db, 'SGR01', [{ ...yearDays(2026)[0]!, times: { ...TIMES, subuh: '05:11' } }], 'a', undefined, undefined, 'sdm');
    const r = importDays(db, 'SGR01', yearDays(2026).slice(0, 3), 'b', undefined, { insertOnly: true }, 'sdm');
    expect(r).toEqual({ inserted: 2, replaced: 0 });
    expect(getDays(db, 'SGR01', '2026-01-01', '2026-01-01', 'sdm')[0]!.times.subuh).toBe('05:11');
  });

  it('writes nothing and does not bump the version when all dates exist', () => {
    const db = newDb();
    importDays(db, 'SGR01', yearDays(2026).slice(0, 3), 'a', undefined, undefined, 'sdm');
    const v = getVersion(db, 'sdm');
    expect(importDays(db, 'SGR01', yearDays(2026).slice(0, 3), 'b', undefined, { insertOnly: true }, 'sdm')).toEqual({ inserted: 0, replaced: 0 });
    expect(getVersion(db, 'sdm')).toBe(v);
    expect(auditRows(db)).toHaveLength(1);
  });
});

describe('wiring in buildApp', () => {
  it('runs after the delay, shows the attempt in admin health, and stops on close', async () => {
    const fake = fakeEsolat((y) => okYear(y));
    const app = withAdmin(buildApp(tempPath(), {
      now: () => AT, fetchImpl: fake.impl, autoPrayerFetch: { firstDelayMs: 10, intervalMs: 3_600_000 },
    }));
    apps.push(app);
    const admin = await app.admin();
    for (let i = 0; i < 100 && fake.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(fake.calls.length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 100));
    const health = (await app.inject({ method: 'GET', url: '/api/health', headers: admin.headers })).json();
    expect(health.autoFetch).toMatchObject({ enabled: true, lastOk: true });
    expect(typeof health.autoFetch.lastAttemptAt).toBe('string');
    expect(JSON.stringify(health.autoFetch)).not.toMatch(/https?:/);
  });

  it('does not start timers unless asked, and a close before the delay cancels the run', async () => {
    const plain = fakeEsolat((y) => okYear(y));
    const a = buildApp(tempPath(), { now: () => AT, fetchImpl: plain.impl });
    apps.push(a);
    const early = fakeEsolat((y) => okYear(y));
    const b = buildApp(tempPath(), { now: () => AT, fetchImpl: early.impl, autoPrayerFetch: { firstDelayMs: 80, intervalMs: 50 } });
    await b.close();
    await new Promise((r) => setTimeout(r, 250));
    expect(plain.calls).toHaveLength(0);
    expect(early.calls).toHaveLength(0);
  });

  it('manual import route still replaces existing dates', async () => {
    const fake = fakeEsolat((y) => okYear(y));
    const app = withAdmin(buildApp(tempPath(), { now: () => AT, fetchImpl: fake.impl }));
    apps.push(app);
    const admin = await app.admin();
    const post = () => app.inject({
      method: 'POST', url: '/api/prayer/import', headers: admin.headers,
      payload: { zone: 'SGR01', year: 2026, source: 'esolat' },
    });
    expect((await post()).json()).toMatchObject({ inserted: 365, replaced: 0 });
    expect((await post()).json()).toMatchObject({ inserted: 0, replaced: 365 });
  });
});

describe('[P9] the auto-fetch state belongs to the zone it was for', () => {
  it('[P9] a zone change resets the state (no old OK or failed shown for the new zone)', async () => {
    const db = newDb();
    const fake = fakeEsolat(() => noRecord());
    const r = runner(db, fake);
    expect(await r.runOnce('sdm')).toMatchObject({ ran: true, ok: false });
    expect(r.status('sdm')).toMatchObject({ lastOk: false });
    putFeature(db, 'zone', { zone: 'SGR02' }, 'tester', undefined, 'sdm');
    const st = r.status('sdm');
    expect(st.lastOk).toBeNull();
    expect(st.lastAttemptAt).toBeNull();
    expect(st.lastError).toBeUndefined();
    expect(st.zone).toBe('SGR02');
  });
});

describe('[P10] box and cloud do not both fetch one surau', () => {
  it('[P10] a cloud with a linked box and the box both fetch one zone-year: the cloud leaves a surau with an unrevoked linked box alone', async () => {
    const fake = fakeEsolat((y) => okYear(y));
    const app = buildApp(tempPath(), {
      now: () => AT, fetchImpl: fake.impl, role: 'cloud', boxId: 'c'.repeat(16), autoPrayerFetch: { firstDelayMs: 10, intervalMs: 3_600_000 },
    });
    apps.push(app);
    const db = app.surau.db;
    for (const id of ['surau-a', 'surau-b', 'surau-c']) ensureSurau(db, id, `Surau ${id}`);
    const site = (surau: string, box: string, revoked: string | null): void => {
      db.prepare("INSERT INTO sites (surau_id, box_id, name, linked_at, revoked_at) VALUES (?, ?, 'Kotak', '2026-11-01T00:00:00.000Z', ?)").run(surau, box, revoked);
    };
    site('surau-a', 'a'.repeat(16), null);
    site('surau-c', 'b'.repeat(16), '2026-11-02T00:00:00.000Z');
    const exchanged = (surau: string): number =>
      Number(db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'prayer:official' AND surau_id = ?").get(surau)?.n ?? 0);
    for (let i = 0; i < 150 && (exchanged('surau-b') === 0 || exchanged('surau-c') === 0); i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 150));
    expect(exchanged('surau-b')).toBeGreaterThan(0);
    expect(exchanged('surau-c')).toBeGreaterThan(0);
    expect(countDaysFrom(db, 'SGR01', '2026-11-03', 'surau-a')).toBe(0);
    expect(exchanged('surau-a')).toBe(0);
  });
});
