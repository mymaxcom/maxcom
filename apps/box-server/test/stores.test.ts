import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { parseJakimCsv } from '@surau/core';
import type { PrayerDay } from '@surau/core';
import { openDb } from '../src/db.ts';
import { fetchJakimYear } from '../src/jakimFetch.ts';
import { countDaysFrom, getDays, importDays } from '../src/prayerStore.ts';
import { getSettings, getVersion, putFeature, SettingsError } from '../src/settingsStore.ts';

const fixturePath = fileURLToPath(new URL('../../../packages/core/test/fixtures/SGR01-2026.csv', import.meta.url));
const fixtureDays = parseJakimCsv(readFileSync(fixturePath, 'utf8'));

const openDbs: DatabaseSync[] = [];
const tempDirs: string[] = [];

function newDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'surau-box-'));
  tempDirs.push(dir);
  const db = openDb(join(dir, 'test.db'));
  openDbs.push(db);
  return db;
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'surau-box-'));
  tempDirs.push(dir);
  return join(dir, 'test.db');
}

function changeRows(db: DatabaseSync): Record<string, unknown>[] {
  return db.prepare('SELECT * FROM change_log ORDER BY id').all();
}

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toApi(day: PrayerDay): Record<string, string> {
  const y = day.date.slice(0, 4);
  const m = Number(day.date.slice(5, 7));
  const d = day.date.slice(8, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d}-${MONTHS[m - 1]}-${y}`,
    hijri: `${day.hijri.y}-${pad(day.hijri.m)}-${pad(day.hijri.d)}`,
    imsak: `${day.times.imsak}:00`,
    fajr: `${day.times.subuh}:00`,
    syuruk: `${day.times.syuruk}:00`,
    dhuhr: `${day.times.zohor}:00`,
    asr: `${day.times.asar}:00`,
    maghrib: `${day.times.maghrib}:00`,
    isha: `${day.times.isyak}:00`,
  };
}

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

const apiYear = (days: PrayerDay[]) => ({ prayerTime: days.map(toApi) });

describe('openDb', () => {
  it('creates tables and is idempotent on the same file', () => {
    const path = tempDbPath();
    const a = openDb(path);
    openDbs.push(a);
    const b = openDb(path);
    openDbs.push(b);

    const table = (name: string) =>
      a.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    for (const name of ['prayer_days', 'settings', 'change_log', 'meta']) {
      expect(table(name)).toBeDefined();
    }
    expect(a.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
  });
});

describe('prayerStore', () => {
  it('imports the fixture and counts inserted then replaced', () => {
    const db = newDb();
    expect(importDays(db, 'SGR01', fixtureDays, 'tester')).toEqual({ inserted: 365, replaced: 0 });
    expect(importDays(db, 'SGR01', fixtureDays, 'tester')).toEqual({ inserted: 0, replaced: 365 });
  });

  it('reads an inclusive ordered date range', () => {
    const db = newDb();
    importDays(db, 'SGR01', fixtureDays, 'tester');

    const rows = getDays(db, 'SGR01', '2026-11-03', '2026-11-04');
    const expected = fixtureDays.filter((d) => d.date === '2026-11-03' || d.date === '2026-11-04');
    expect(rows).toEqual(expected);
    expect(rows.map((r) => r.date)).toEqual(['2026-11-03', '2026-11-04']);
  });

  it('counts rows from a date', () => {
    const db = newDb();
    importDays(db, 'SGR01', fixtureDays, 'tester');
    expect(countDaysFrom(db, 'SGR01', '2026-11-03')).toBe(59);
  });

  it('writes one change_log row per non-empty import', () => {
    const db = newDb();
    importDays(db, 'SGR01', fixtureDays, 'tester');

    // One summary row (the audit view) and, since Plan 13, its feed twin carrying the days of each year.
    const rows = changeRows(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actor: 'tester', entity: 'prayer_days', entity_id: 'SGR01' });
    expect(JSON.parse(String(rows[0]!.after_json))).toEqual({ count: 365, from: '2026-01-01', to: '2026-12-31' });
    expect(rows[1]).toMatchObject({ actor: 'tester', entity: 'prayer:official', entity_id: 'SGR01:2026' });
    const twin = JSON.parse(String(rows[1]!.after_json)) as { zone: string; year: number; days: unknown[]; fetchedAt: string };
    expect(twin).toMatchObject({ zone: 'SGR01', year: 2026 });
    expect(twin.days).toHaveLength(365);
  });

  it('ignores an empty import without a log row', () => {
    const db = newDb();
    expect(importDays(db, 'SGR01', [], 'tester')).toEqual({ inserted: 0, replaced: 0 });
    expect(changeRows(db)).toHaveLength(0);
    expect(getVersion(db)).toBe(0);
  });

  it('rejects a bad zone', () => {
    const db = newDb();
    expect(() => importDays(db, 'x', fixtureDays, 'tester')).toThrow();
  });
});

describe('settingsStore', () => {
  it('partially updates a feature and keeps defaults', () => {
    const db = newDb();
    const settings = putFeature(db, 'iqamahCountdown', { minutes: { isnin: { asar: 12 } } }, 'tester');

    expect(settings.iqamahCountdown.minutes.isnin.asar).toBe(12);
    expect(settings.iqamahCountdown.minutes.isnin.subuh).toBe(12);

    const rows = db
      .prepare("SELECT actor, entity, entity_id FROM change_log WHERE entity = 'settings'")
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'tester', entity: 'settings', entity_id: 'iqamahCountdown' });
  });

  it('rejects an invalid patch and changes nothing', () => {
    const db = newDb();
    putFeature(db, 'iqamahCountdown', { minutes: { isnin: { asar: 12 } } }, 'tester');

    const before = getSettings(db);
    const version = getVersion(db);
    const logCount = changeRows(db).length;

    let error: unknown;
    try {
      putFeature(db, 'iqamahCountdown', { minutes: { isnin: { asar: -1 } } }, 'tester');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SettingsError);
    expect((error as SettingsError).errors.length).toBeGreaterThan(0);

    expect(getSettings(db)).toEqual(before);
    expect(getVersion(db)).toBe(version);
    expect(changeRows(db)).toHaveLength(logCount);
  });

  it('rejects disabling a locked feature', () => {
    const db = newDb();
    expect(() => putFeature(db, 'clock', { enabled: false }, 't')).toThrow(SettingsError);
  });

  it('an empty or unchanged PUT does not write, log or bump the version', () => {
    const db = newDb();
    putFeature(db, 'hijriDate', { adjustDays: 1 }, 'tester');
    const version = getVersion(db);
    const logCount = changeRows(db).length;

    putFeature(db, 'hijriDate', {}, 'tester');
    putFeature(db, 'hijriDate', { adjustDays: 1 }, 'tester');
    putFeature(db, 'ticker', {}, 'tester');

    expect(getVersion(db)).toBe(version);
    expect(changeRows(db)).toHaveLength(logCount);
    expect(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE feature = 'ticker'").get()).toMatchObject({ n: 0 });
  });

  it('bumps the version on import and on a valid update', () => {
    const db = newDb();
    expect(getVersion(db)).toBe(0);

    importDays(db, 'SGR01', fixtureDays, 'tester');
    expect(getVersion(db)).toBe(1);

    putFeature(db, 'hijriDate', { adjustDays: 1 }, 'tester');
    expect(getVersion(db)).toBe(2);
  });
});

describe('fetchJakimYear', () => {
  it('returns a complete year from the API shape', async () => {
    const days = await fetchJakimYear('SGR01', 2026, fakeFetch(apiYear(fixtureDays)));
    expect(days).toHaveLength(365);
    expect(days[0]).toEqual(fixtureDays[0]);
  });

  it('rejects an incomplete year', async () => {
    await expect(fetchJakimYear('SGR01', 2026, fakeFetch(apiYear(fixtureDays.slice(0, 3))))).rejects.toThrow(
      /incomplete/i,
    );
  });

  it('rejects a non-2xx response with the status', async () => {
    await expect(fetchJakimYear('SGR01', 2026, fakeFetch({}, 503))).rejects.toThrow(/503/);
  });

  it('requests the asked year explicitly with a POST form and safe options', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const spy = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify(apiYear(fixtureDays)));
    }) as unknown as typeof fetch;
    await fetchJakimYear('SGR01', 2026, spy);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(
      'https://www.e-solat.gov.my/index.php?r=esolatApi/takwimsolat&period=duration&zone=SGR01',
    );
    expect(seen[0]!.init.method).toBe('POST');
    expect(seen[0]!.init.redirect).toBe('error');
    expect(String(seen[0]!.init.body)).toBe('datestart=2026-01-01&dateend=2026-12-31');
    expect((seen[0]!.init.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded',
    );
  });

  it('rejects a response over 5 MB', async () => {
    const big = (async () => new Response('x'.repeat(5 * 1024 * 1024 + 1))) as unknown as typeof fetch;
    await expect(fetchJakimYear('SGR01', 2026, big)).rejects.toThrow(/too large/);
  });

  it('rejects a bad zone before calling fetch', async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch;
    await expect(fetchJakimYear('x', 2026, spy)).rejects.toThrow();
    expect(called).toBe(false);
  });
});

describe('fetchJakimYear: year not yet published (live API shape, measured 2026-11-03)', () => {
  it('gives a clear "not published" error for NO_RECORD!', async () => {
    const body = { prayerTime: { data: ['No data available for the current request'] }, status: 'NO_RECORD!', periodType: 'duration', zone: 'SGR01' };
    await expect(fetchJakimYear('SGR01', 2027, fakeFetch(body))).rejects.toThrow(/not published 2027/);
  });
});
