import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { offsetMinutes, resolveSettings } from '@surau/core';
import type { PrayerDay, PrayerName, Settings } from '@surau/core';
import { openDb } from '../src/db.ts';
import { createRateLimiter } from '../src/auth/ratelimit.ts';
import { searchLocation } from '../src/prayer/location.ts';
import { computeDay } from '../src/prayer/calc.ts';
import { putCorrection } from '../src/prayer/corrections.ts';
import { applyImport, parseCsvRows, parseTemplateRows, undoImport } from '../src/prayer/importFile.ts';
import { resolveDay } from '../src/prayer/resolve.ts';
import { openXlsx } from '../src/files/xlsxRead.ts';
import { buildXlsx } from './support/zipBuild.ts';

const dbs: DatabaseSync[] = [];
const newDb = (): DatabaseSync => { const d = openDb(':memory:'); dbs.push(d); return d; };
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });
const T = (iso: string): Date => new Date(iso);
const PNAMES: PrayerName[] = ['imsak', 'subuh', 'syuruk', 'zohor', 'asar', 'maghrib', 'isyak'];

describe('gate 13 item 9: Nominatim slot is reserved synchronously', () => {
  it('three searches started together are spaced one gap apart, not all released at once', async () => {
    const db = newDb();
    const fixture = readFileSync(fileURLToPath(new URL('./fixtures/nominatim-shah-alam.json', import.meta.url)), 'utf8');
    const impl = (async () => new Response(fixture, { status: 200 })) as unknown as typeof fetch;
    const clock = Date.parse('2026-11-09T10:00:00Z');
    const limiter = createRateLimiter({ windowMs: 60_000, max: 50, now: () => clock });
    const slept: number[] = [];
    const opts = { key: 'u', minIntervalMs: 1000, sleep: async (ms: number) => { slept.push(ms); } };
    await Promise.all(['one', 'two', 'three'].map((q) => searchLocation(db, q, impl, 'https://nominatim.openstreetmap.org/search', () => new Date(clock), limiter, opts)));
    slept.sort((a, b) => a - b);
    expect(slept).toHaveLength(2);
    expect(slept[0]!).toBeGreaterThan(900);
    expect(slept[1]!).toBeGreaterThan(1900);
  });
});

describe('gate 13 item 9: emergency only when official comes before calc', () => {
  const my = (order: string[]): Settings => resolveSettings({ location: { latitude: 3.07, longitude: 101.52 }, zone: { zone: 'SGR01' }, prayerSources: { sourceOrder: order } } as never);
  it('a calculated day is an emergency under official-first, and not when the surau put calc above official', () => {
    const db = newDb();
    expect(resolveDay(db, my(['official', 'calc', 'file']), '2026-12-01')).toMatchObject({ source: 'calc', emergency: true });
    expect(resolveDay(db, my(['calc', 'official', 'file']), '2026-12-01')).toMatchObject({ source: 'calc', emergency: false });
    expect(resolveDay(db, my(['file', 'calc', 'official']), '2026-12-01')).toMatchObject({ source: 'calc', emergency: false });
  });
});

describe('gate 13 item 9: xlsx times are truncated, a date-time in a time column is its time', () => {
  const sheet = (cells: string): string[][] => openXlsx(buildXlsx({
    sheets: [{ name: 'S', xml: `<row r="1">${cells}</row>` }],
    styles: '<styleSheet><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="20"/><xf numFmtId="22"/></cellXfs></styleSheet>',
  })).readSheet('xl/worksheets/sheet1.xml');
  it('05:59:59 reads 05:59, and exact minutes stay exact', () => {
    const at = (h: number, m: number, s: number): number => (h * 3600 + m * 60 + s) / 86_400;
    const row = sheet(`<c r="A1" s="1"><v>${at(5, 59, 59)}</v></c><c r="B1" s="1"><v>${at(6, 0, 0)}</v></c><c r="C1" s="1"><v>0.2417</v></c><c r="D1" s="1"><v>${at(23, 59, 59)}</v></c>`)[0]!;
    expect(row).toEqual(['05:59', '06:00', '05:48', '23:59']);
  });
  it('a date-time from a date-styled cell is accepted in a time column as its time of day', () => {
    const c = parseCsvRows(['tarikh,subuh,syuruk,zohor,asar,maghrib,isyak', '2026-12-01,2026-12-01 05:48,06:58,13:08,16:30,19:12,20:26'].join('\n'));
    const parsed = parseTemplateRows(c.rows, { kind: 'surau', imsakMinutes: 10 }, c.numbers);
    expect(parsed.errors).toEqual([]);
    expect(parsed.days[0]!.times.subuh).toBe('05:48');
  });
});

describe('gate 13 item 9: undo is judged by local arrival', () => {
  const days = (dates: string[]): PrayerDay[] => {
    const c = parseCsvRows(['tarikh,subuh,syuruk,zohor,asar,maghrib,isyak', ...dates.map((d) => `${d},04:50,06:00,12:12,15:30,18:20,19:30`)].join('\n'));
    return parseTemplateRows(c.rows, { kind: 'surau', imsakMinutes: 10 }, c.numbers).days;
  };
  const ke = (): Settings => resolveSettings({ location: { country: 'KE', timezone: 'Africa/Nairobi', latitude: -1.29, longitude: 36.82 }, prayerSources: { sourceOrder: ['file', 'calc', 'official'] } } as never);
  const meta = (at: string): never => ({ editedAt: at, rev: `${at}|cloud`, origin: 'cloud' }) as never;
  const imp = (db: DatabaseSync, at: string) => applyImport(db, ke(), { kind: 'csv', fileName: 'a.csv', sha256: 'a'.repeat(64), days: days(['2026-12-01', '2026-12-02']), overlap: 'replace' }, 'user:t', undefined, T(at));

  it('a correction made elsewhere BEFORE the import but arriving AFTER it blocks the undo', () => {
    const db = newDb();
    const a = imp(db, '2026-11-10T01:00:00Z');
    putCorrection(db, { date: '2026-12-01', prayer: 'asar', time: '15:40', reason: 'Dari awan' }, 'system:sync', undefined, T('2026-11-12T01:00:00Z'), null, { meta: meta('2026-11-01T00:00:00.000Z') });
    const r = undoImport(db, a.id, 'user:t', undefined, T('2026-11-13T01:00:00Z'));
    expect(r.ok).toBe(false);
  });

  it('a correction that arrived before the import was here does not block the undo (success path)', () => {
    const db = newDb();
    putCorrection(db, { date: '2026-12-01', prayer: 'asar', time: '15:40', reason: 'Dari awan' }, 'system:sync', undefined, T('2026-11-09T01:00:00Z'), null, { meta: meta('2026-11-20T00:00:00.000Z') });
    const a = imp(db, '2026-11-10T01:00:00Z');
    expect(undoImport(db, a.id, 'user:t', undefined, T('2026-11-13T01:00:00Z'))).toMatchObject({ ok: true });
  });

  it('a local correction after the import still blocks it, as before', () => {
    const db = newDb();
    const a = imp(db, '2026-11-10T01:00:00Z');
    putCorrection(db, { date: '2026-12-02', prayer: 'asar', time: '15:40', reason: 'Tempatan' }, 'user:t', undefined, T('2026-11-11T01:00:00Z'));
    expect(undoImport(db, a.id, 'user:t', undefined, T('2026-11-13T01:00:00Z')).ok).toBe(false);
  });
});

describe('gate 13 item 9: computeDay in zones near the date line and across a DST change', () => {
  const settingsFor = (tz: string, lat: number, lon: number): Settings => resolveSettings({
    location: { country: 'NZ', timezone: tz, latitude: lat, longitude: lon, city: 'x' },
  } as never);
  const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const mins = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const noonUtc = (d: string): Date => new Date(`${d}T12:00:00Z`);

  const walk = (tz: string, lat: number, lon: number, start: string, n: number): void => {
    const s = settingsFor(tz, lat, lon);
    let prev: PrayerDay | null = null;
    let prevDate = '';
    for (let i = 0; i < n; i++) {
      const date = addDays(start, i);
      const d = computeDay(date, s);
      expect(d, `${tz} ${date}`).not.toBeNull();
      for (let k = 1; k < PNAMES.length; k++) expect(mins(d!.times[PNAMES[k]!]) > mins(d!.times[PNAMES[k - 1]!]), `${tz} ${date} order ${PNAMES[k]}`).toBe(true);
      if (prev) {
        // the clock itself moves at a DST change, so compare after taking that change out
        const shift = offsetMinutes(noonUtc(date), tz) - offsetMinutes(noonUtc(prevDate), tz);
        for (const p of PNAMES) {
          const diff = mins(d!.times[p]) - mins(prev.times[p]) - shift;
          expect(Math.abs(diff), `${tz} ${date} ${p} vs ${prevDate}`).toBeLessThanOrEqual(2);
        }
      }
      prev = d;
      prevDate = date;
    }
  };

  it('Pacific/Tongatapu (UTC+13, west of the date line)', () => walk('Pacific/Tongatapu', -21.14, -175.2, '2026-11-20', 20));
  it('Pacific/Kiritimati (UTC+14, the furthest east)', () => walk('Pacific/Kiritimati', 1.87, -157.4, '2026-06-15', 20));
  it('Pacific/Auckland across the September DST start (2026-09-27)', () => walk('Pacific/Auckland', -36.85, 174.76, '2026-09-18', 20));
  it('Pacific/Auckland across the April DST end (2026-04-05)', () => walk('Pacific/Auckland', -36.85, 174.76, '2026-03-27', 20));
});

describe('gate 13 item 9: the kiosk bundle carries a footer per day', () => {
  it('each row has its own source line', async () => {
    const { buildApp } = await import('../src/app.ts');
    const app = buildApp(':memory:', { now: () => new Date('2026-11-03T04:00:00Z') });
    try {
      const { parseJakimCsv } = await import('@surau/core');
      const { importDays } = await import('../src/prayerStore.ts');
      importDays(app.surau.db, 'SGR01', parseJakimCsv(readFileSync(fileURLToPath(new URL('../../../packages/core/test/fixtures/SGR01-2026.csv', import.meta.url)), 'utf8')), 'tester');
      const res = await app.inject({ method: 'GET', url: '/api/kiosk/bundle' });
      expect(res.statusCode).toBe(200);
      const days = res.json().days as Array<{ date: string; source: string; footerMs: string; footerEn: string }>;
      expect(days.length).toBeGreaterThan(30);
      for (const d of days) {
        expect(typeof d.footerMs).toBe('string');
        expect(d.footerMs).not.toBe('');
        expect(d.footerEn).not.toBe('');
      }
      expect(res.json().prayer.footerMs).toBe(days.find((d) => d.date === '2026-11-03')!.footerMs);
    } finally {
      await app.close();
    }
  });
});
