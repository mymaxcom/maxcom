import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { parseJakimCsv, resolveSettings } from '@surau/core';
import type { PrayerDay, Settings } from '@surau/core';
import { openDb } from '../src/db.ts';
import { importDays } from '../src/prayerStore.ts';
import { putCorrection, removeCorrection, listCorrections } from '../src/prayer/corrections.ts';
import { crossCheck, resolveDay, resolveDays, sourceLine } from '../src/prayer/resolve.ts';

const csv = readFileSync(fileURLToPath(new URL('../../../packages/core/test/fixtures/SGR01-2026.csv', import.meta.url)), 'utf8');
const official = parseJakimCsv(csv);
const NOW = new Date('2026-11-03T04:00:00Z');

const dbs: DatabaseSync[] = [];
function newDb(): DatabaseSync {
  const db = openDb(':memory:');
  dbs.push(db);
  return db;
}
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });

const my = (over: object = {}): Settings => resolveSettings({ location: { latitude: 3.07, longitude: 101.52 }, ...over } as never);
const ke = (over: object = {}): Settings => resolveSettings({
  location: { country: 'KE', timezone: 'Africa/Nairobi', latitude: -1.2921, longitude: 36.8219, city: 'Nairobi' },
  prayerSources: { sourceOrder: ['file', 'calc', 'official'] },
  ...over,
} as never);

/** A file import record with rows, written the way importFile will (a direct insert keeps this test about resolving). */
function addFileDays(db: DatabaseSync, days: PrayerDay[], undone = false): string {
  const id = `imp${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO prayer_imports (id, kind, file_name, sha256, rows, date_from, date_to, overlap, inserted, replaced, skipped, actor, created_at, undone_at)
     VALUES (?, 'csv', 'f.csv', 'x', ?, ?, ?, 'replace', ?, 0, 0, 'tester', ?, ?)`,
  ).run(id, days.length, days[0]!.date, days[days.length - 1]!.date, days.length, NOW.toISOString(), undone ? NOW.toISOString() : null);
  for (const d of days) db.prepare('INSERT INTO prayer_file_days (date, import_id, json) VALUES (?, ?, ?)').run(d.date, id, JSON.stringify(d));
  return id;
}

describe('resolveDays', () => {
  it('official days are official and not an emergency; a day JAKIM has not published is calculated and marked', () => {
    const db = newDb();
    importDays(db, 'SGR01', official.filter((d) => d.date >= '2026-11-01' && d.date <= '2026-11-30'), 'tester');
    const days = resolveDays(db, my(), '2026-11-28', '2026-12-02');
    expect(days.map((d) => [d.date, d.source, d.emergency])).toEqual([
      ['2026-11-28', 'official', false], ['2026-11-29', 'official', false], ['2026-11-30', 'official', false],
      ['2026-12-01', 'calc', true], ['2026-12-02', 'calc', true],
    ]);
    const nov = days[0]!;
    expect(nov.times).toEqual(official.find((d) => d.date === '2026-11-28')!.times);
    expect(nov.hijriSource).toBe('official');
    expect(days[3]!.hijriSource).toBe('calc');
  });

  it('with no coordinates a day official lacks is simply missing (the pilot behaves as before)', () => {
    const db = newDb();
    importDays(db, 'SGR01', official.slice(0, 5), 'tester');
    const days = resolveDays(db, resolveSettings({}), '2026-01-01', '2026-01-10');
    expect(days.map((d) => d.date)).toEqual(official.slice(0, 5).map((d) => d.date));
    expect(days.every((d) => d.source === 'official' && !d.emergency && d.corrected.length === 0)).toBe(true);
  });

  it('another zone is not used and the official source is skipped outside Malaysia', () => {
    const db = newDb();
    importDays(db, 'SGR01', official.slice(0, 5), 'tester');
    importDays(db, 'JHR01', official.slice(5, 10), 'tester');
    const days = resolveDays(db, resolveSettings({ zone: { zone: 'JHR01' } }), '2026-01-01', '2026-01-10');
    expect(days.map((d) => d.date)).toEqual(official.slice(5, 10).map((d) => d.date));
    expect(resolveDays(db, ke({ prayerSources: { sourceOrder: ['official', 'calc', 'file'] } }), '2026-01-01', '2026-01-03').every((d) => d.source === 'calc')).toBe(true);
  });

  it('outside Malaysia: a file row wins when file is first, every other day is calculated, and none is an emergency', () => {
    const db = newDb();
    const fileDay: PrayerDay = {
      date: '2026-11-09', hijri: { y: 1448, m: 5, d: 29 },
      times: { imsak: '04:40', subuh: '04:50', syuruk: '06:00', zohor: '12:12', asar: '15:30', maghrib: '18:20', isyak: '19:30' },
    };
    addFileDays(db, [fileDay]);
    const days = resolveDays(db, ke(), '2026-11-08', '2026-11-10');
    expect(days.map((d) => d.source)).toEqual(['calc', 'file', 'calc']);
    expect(days[1]!.times).toEqual(fileDay.times);
    expect(days.some((d) => d.emergency)).toBe(false);
    // calc first: the file row is passed over
    const calcFirst = resolveDays(db, ke({ prayerSources: { sourceOrder: ['calc', 'file', 'official'] } }), '2026-11-09', '2026-11-09');
    expect(calcFirst[0]!.source).toBe('calc');
  });

  it('a row of an undone import is never used', () => {
    const db = newDb();
    addFileDays(db, [{
      date: '2026-11-09', hijri: { y: 1448, m: 5, d: 29 },
      times: { imsak: '04:40', subuh: '04:50', syuruk: '06:00', zohor: '12:12', asar: '15:30', maghrib: '18:20', isyak: '19:30' },
    }], true);
    expect(resolveDay(db, ke(), '2026-11-09')!.source).toBe('calc');
  });

  it('a correction overrides only that prayer, shows in corrected, and removing it restores the source time', () => {
    const db = newDb();
    importDays(db, 'SGR01', official.filter((d) => d.date === '2026-11-26'), 'tester');
    const base = resolveDay(db, my(), '2026-11-26')!;
    putCorrection(db, { date: '2026-11-26', prayer: 'asar', time: '16:25', reason: 'Ikut takwim masjid' }, 'tester', undefined, NOW, 'SGR01');
    const fixed = resolveDay(db, my(), '2026-11-26')!;
    expect(fixed.times.asar).toBe('16:25');
    expect(fixed.corrected).toEqual(['asar']);
    expect(fixed.times.zohor).toBe(base.times.zohor);
    expect(fixed.source).toBe('official');
    expect(listCorrections(db, '2026-11-01', '2026-11-30')).toEqual([
      { date: '2026-11-26', prayer: 'asar', time: '16:25', reason: 'Ikut takwim masjid', officialAtCorrection: base.times.asar },
    ]);
    expect(removeCorrection(db, '2026-11-26', 'asar', 'tester', undefined, NOW)).toBe(true);
    expect(resolveDay(db, my(), '2026-11-26')!.times.asar).toBe(base.times.asar);
    expect(removeCorrection(db, '2026-11-26', 'asar', 'tester', undefined, NOW)).toBe(false);
  });

  it('a correction survives a JAKIM re-download', () => {
    const db = newDb();
    const day = official.find((d) => d.date === '2026-11-26')!;
    importDays(db, 'SGR01', [day], 'tester');
    putCorrection(db, { date: '2026-11-26', prayer: 'subuh', time: '05:52', reason: 'Semakan jabatan' }, 'tester', undefined, NOW, 'SGR01');
    importDays(db, 'SGR01', [day], 'tester');
    expect(resolveDay(db, my(), '2026-11-26')!.times.subuh).toBe('05:52');
  });

  it('refuses bad corrections with a reason', () => {
    const db = newDb();
    const put = (over: object): void => putCorrection(db, { date: '2026-11-26', prayer: 'asar', time: '16:25', reason: 'Ikut takwim', ...over } as never, 't', undefined, NOW);
    expect(() => put({ time: '25:00' })).toThrow(/time/);
    expect(() => put({ time: '4:25' })).toThrow(/time/);
    expect(() => put({ reason: 'x' })).toThrow(/reason/);
    expect(() => put({ reason: '<b>x</b>' })).toThrow(/reason/);
    expect(() => put({ prayer: 'dhuha' })).toThrow(/prayer/);
    expect(() => put({ date: '2026-02-30' })).toThrow(/date/);
    expect(listCorrections(db, '2026-01-01', '2026-12-31')).toEqual([]);
  });
});

describe('crossCheck', () => {
  const day = (subuh: string): PrayerDay => ({
    date: '2026-11-09', hijri: { y: 1448, m: 5, d: 29 },
    times: { imsak: '04:40', subuh, syuruk: '06:00', zohor: '12:12', asar: '15:30', maghrib: '18:20', isyak: '19:30' },
  });
  it('flags a day 3 minutes from the calculation and not one 1 minute away, and reports the median', () => {
    const db = newDb();
    const settings = ke();
    const calc = resolveDay(db, ke({ prayerSources: { sourceOrder: ['calc', 'file', 'official'] } }), '2026-11-09')!;
    const sub = calc.times.subuh;
    const shift = (t: string, by: number): string => {
      const m = Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) + by;
      return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    };
    const mk = (by: number): PrayerDay => ({ ...calc, times: { ...calc.times, subuh: shift(sub, by) } });
    addFileDays(db, [mk(3)]);
    let r = crossCheck(db, settings, '2026-11-09', '2026-11-09');
    expect(r.compared).toBe(1);
    expect(r.flagged).toHaveLength(1);
    expect(r.flagged[0]).toMatchObject({ date: '2026-11-09', source: 'file' });
    expect(r.flagged[0]!.diffs.subuh).toBe(3);
    expect(r.medianDiff.subuh).toBe(3);
    expect(r.maxDiff.subuh).toBe(3);
    expect(r.medianDiff.zohor).toBe(0);

    const db2 = newDb();
    addFileDays(db2, [mk(1)]);
    r = crossCheck(db2, settings, '2026-11-09', '2026-11-09');
    expect(r.flagged).toHaveLength(0);
    expect(r.medianDiff.subuh).toBe(1);
  });
  it('compares only non-calculated days and needs a located surau', () => {
    const db = newDb();
    expect(crossCheck(db, ke(), '2026-11-09', '2026-11-12').compared).toBe(0);
    addFileDays(db, [day('04:50')]);
    expect(crossCheck(db, resolveSettings({ location: { country: 'KE', timezone: 'Africa/Nairobi' } }), '2026-11-09', '2026-11-09').compared).toBe(0);
  });
  it('the median ignores the few days that differ', () => {
    const db = newDb();
    importDays(db, 'SGR01', official.filter((d) => d.date >= '2026-11-01' && d.date <= '2026-11-30'), 'tester');
    const r = crossCheck(db, my(), '2026-11-01', '2026-11-30');
    expect(r.compared).toBe(30);
    expect(Math.abs(r.medianDiff.zohor)).toBeLessThanOrEqual(3);
  });
});

describe('sourceLine', () => {
  it('says where the day comes from, with corrections appended', () => {
    const db = newDb();
    importDays(db, 'SGR01', official.filter((d) => d.date === '2026-11-26'), 'tester');
    const s = my();
    const off = resolveDay(db, s, '2026-11-26')!;
    expect(sourceLine(s, off, 'ms')).toBe('Sumber: JAKIM e-Solat SGR01');
    expect(sourceLine(s, off, 'en')).toBe('Source: JAKIM e-Solat SGR01');
    putCorrection(db, { date: '2026-11-26', prayer: 'asar', time: '16:25', reason: 'Ikut takwim' }, 't', undefined, NOW, 'SGR01');
    expect(sourceLine(s, resolveDay(db, s, '2026-11-26')!, 'ms')).toBe('Sumber: JAKIM e-Solat SGR01 dan pembetulan');
    const calc = resolveDay(db, s, '2027-03-01')!;
    expect(sourceLine(s, calc, 'ms')).toBe('Kiraan setempat (JAKIM 18/18)');
    const k = ke({ prayerSources: { sourceOrder: ['calc', 'file', 'official'] } });
    expect(sourceLine(k, resolveDay(db, k, '2026-11-09')!, 'ms')).toBe('Kiraan setempat (Liga Dunia Islam), Nairobi');
    expect(sourceLine(k, resolveDay(db, k, '2026-11-09')!, 'en')).toBe('Local calculation (Muslim World League), Nairobi');
  });
  it('names a file day for a surau or a masjid', () => {
    const db = newDb();
    addFileDays(db, [{
      date: '2026-11-09', hijri: { y: 1448, m: 5, d: 29 },
      times: { imsak: '04:40', subuh: '04:50', syuruk: '06:00', zohor: '12:12', asar: '15:30', maghrib: '18:20', isyak: '19:30' },
    }]);
    const s = ke();
    expect(sourceLine(s, resolveDay(db, s, '2026-11-09')!, 'ms')).toBe('Jadual surau (fail)');
    const m = ke({ surauInfo: { kind: 'masjid' } });
    expect(sourceLine(m, resolveDay(db, m, '2026-11-09')!, 'ms')).toBe('Jadual masjid (fail)');
  });
});
