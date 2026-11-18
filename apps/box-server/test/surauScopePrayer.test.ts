import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { parseJakimCsv, resolveSettings } from '@surau/core';
import type { PrayerDay, Settings } from '@surau/core';
import { openDb } from '../src/db.ts';
import { countDaysFrom, getDays, importDays, officialYears, officialZones } from '../src/prayerStore.ts';
import { listCorrections, putCorrection, removeCorrection, snapshotCorrections } from '../src/prayer/corrections.ts';
import { applyImport, dryRun, getImport, listImports, snapshotImports, undoImport } from '../src/prayer/importFile.ts';
import { resolveDay, resolveDays } from '../src/prayer/resolve.ts';
import { listZones, zoneKnown, zoneWarning } from '../src/prayer/zones.ts';
import { checkProviderUpdates } from '../src/hadis/updates.ts';
import { createHadeethEnc } from '../src/hadis/hadeethenc.ts';
import type { HeHadith } from '../src/hadis/hadeethenc.ts';
import { buildProviderItem } from '../src/hadis/providerItem.ts';
import { fakeHadeethEnc, fixture } from './support/fakeHadeethEnc.ts';

/** Plan 14 Task 4c: the prayer and hadis stores take a surau; the reference caches stay shared. */

const A = 'sdm';
const B = 'surau-b';
const SGR = 'SGR01';
const NOW = new Date('2026-11-20T02:00:00Z');

const csv = readFileSync(fileURLToPath(new URL('../../../packages/core/test/fixtures/SGR01-2026.csv', import.meta.url)), 'utf8');
const official = parseJakimCsv(csv);

const dbs: DatabaseSync[] = [];
function newDb(): DatabaseSync {
  const db = openDb(':memory:');
  dbs.push(db);
  return db;
}
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });

/** Both suraus are in the same zone on purpose: only the surau tells their days apart. */
const sameZone = (): Settings => resolveSettings({ zone: { zone: SGR } });

function day(date: string, zohor: string): PrayerDay {
  return {
    date,
    hijri: { y: 1448, m: 6, d: 1 },
    times: { imsak: '05:40', subuh: '05:50', syuruk: '07:00', zohor, asar: '16:30', maghrib: '19:20', isyak: '20:30' },
  };
}

function fileDays(from: string, n: number, zohor: string): PrayerDay[] {
  return Array.from({ length: n }, (_, i) =>
    day(new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), zohor));
}

const importInput = (days: PrayerDay[], fileName = 'jadual.csv') =>
  ({ kind: 'csv' as const, fileName, sha256: 'x'.repeat(64), days, overlap: 'replace' as const });

describe('official days per surau', () => {
  it('an import into one surau is invisible to the other, and the default one is unchanged', () => {
    const db = newDb();
    const jan = official.filter((d) => d.date.startsWith('2026-01'));
    importDays(db, SGR, jan, 'tester', undefined, {}, A);
    importDays(db, SGR, official.filter((d) => d.date.startsWith('2026-02')), 'tester', undefined, {}, B);

    expect(getDays(db, SGR, '2026-01-01', '2026-01-31', 'sdm')).toHaveLength(jan.length);
    expect(getDays(db, SGR, '2026-01-01', '2026-01-31', B)).toHaveLength(0);
    expect(getDays(db, SGR, '2026-02-01', '2026-02-28', A)).toHaveLength(0);
    expect(getDays(db, SGR, '2026-02-01', '2026-02-28', B)).toHaveLength(28);
    expect(countDaysFrom(db, SGR, '2026-01-01', 'sdm')).toBe(jan.length);
    expect(countDaysFrom(db, SGR, '2026-02-01', 'sdm')).toBe(0);
    expect(countDaysFrom(db, SGR, '2026-02-01', B)).toBe(28);
    expect(officialZones(db, 'sdm')).toEqual([SGR]);
    expect(officialZones(db, B)).toEqual([SGR]);
    expect(officialZones(db, 'surau-c')).toEqual([]);
    expect(officialYears(db, SGR, 'sdm')[0]!.days).toHaveLength(jan.length);
    expect(officialYears(db, SGR, 'surau-c')).toEqual([]);
  });

  it('two suraus in the same zone resolve their own days (the official read is scoped too)', () => {
    const db = newDb();
    importDays(db, SGR, [day('2026-11-20', '12:10')], 'tester', undefined, {}, A);
    importDays(db, SGR, [day('2026-11-20', '12:40')], 'tester', undefined, {}, B);

    expect(resolveDay(db, sameZone(), '2026-11-20', 'sdm')!.times.zohor).toBe('12:10');
    expect(resolveDay(db, sameZone(), '2026-11-20', B)!.times.zohor).toBe('12:40');
    expect(resolveDays(db, sameZone(), '2026-11-20', '2026-11-20', B).map((d) => d.times.zohor)).toEqual(['12:40']);
    // A has a day the other surau does not: B must not borrow it.
    importDays(db, SGR, [day('2026-11-21', '12:11')], 'tester', undefined, {}, A);
    expect(resolveDay(db, sameZone(), '2026-11-21', 'sdm')).not.toBeNull();
    expect(resolveDay(db, sameZone(), '2026-11-21', B)).toBeNull();
  });
});

describe('corrections per surau', () => {
  it('the same date and prayer carry a different correction in each surau', () => {
    const db = newDb();
    importDays(db, SGR, [day('2026-11-20', '12:10')], 'tester', undefined, {}, A);
    importDays(db, SGR, [day('2026-11-20', '12:10')], 'tester', undefined, {}, B);
    putCorrection(db, { date: '2026-11-20', prayer: 'zohor', time: '12:25', reason: 'Jadual surau A' }, 'tester', undefined, NOW, SGR, {}, A);
    putCorrection(db, { date: '2026-11-20', prayer: 'zohor', time: '12:45', reason: 'Jadual surau B' }, 'tester', undefined, NOW, SGR, {}, B);

    expect(listCorrections(db, '2026-11-01', '2026-11-30', 'sdm').map((c) => c.time)).toEqual(['12:25']);
    expect(listCorrections(db, '2026-11-01', '2026-11-30', B).map((c) => c.time)).toEqual(['12:45']);
    expect(snapshotCorrections(db, 'sdm').map((c) => c.reason)).toEqual(['Jadual surau A']);
    expect(snapshotCorrections(db, B).map((c) => c.reason)).toEqual(['Jadual surau B']);
    expect(resolveDay(db, sameZone(), '2026-11-20', 'sdm')!.times.zohor).toBe('12:25');
    expect(resolveDay(db, sameZone(), '2026-11-20', B)!.times.zohor).toBe('12:45');
  });

  it('removing a correction touches only its own surau', () => {
    const db = newDb();
    for (const s of [A, B]) {
      putCorrection(db, { date: '2026-11-20', prayer: 'asar', time: '16:45', reason: 'Pembetulan bersama' }, 'tester', undefined, NOW, SGR, {}, s);
    }
    expect(removeCorrection(db, '2026-11-20', 'asar', 'tester', undefined, NOW, {}, A)).toBe(true);
    expect(listCorrections(db, '2026-11-01', '2026-11-30', 'sdm')).toEqual([]);
    expect(listCorrections(db, '2026-11-01', '2026-11-30', B)).toHaveLength(1);
    expect(removeCorrection(db, '2026-11-20', 'asar', 'tester', undefined, NOW, {}, A)).toBe(false);
    expect(removeCorrection(db, '2026-11-20', 'asar', 'tester', undefined, NOW, {}, B)).toBe(true);
    expect(listCorrections(db, '2026-11-01', '2026-11-30', B)).toEqual([]);
  });
});

describe('timetable imports per surau', () => {
  it('file days, the import list and undo stay inside one surau', () => {
    const db = newDb();
    const days = fileDays('2027-03-01', 3, '12:20');
    const a = applyImport(db, sameZone(), importInput(days, 'a.csv'), 'tester', undefined, NOW, A);
    const b = applyImport(db, sameZone(), importInput(days, 'b.csv'), 'tester', undefined, NOW, B);

    expect(listImports(db, 'sdm').map((r) => r.id)).toEqual([a.id]);
    expect(listImports(db, B).map((r) => r.id)).toEqual([b.id]);
    expect(getImport(db, a.id, B)).toBeNull();
    expect(getImport(db, a.id, 'sdm')?.days).toHaveLength(3);
    expect(snapshotImports(db, 'sdm').map((r) => r.record.id)).toEqual([a.id]);
    expect(snapshotImports(db, B).map((r) => r.record.id)).toEqual([b.id]);
    expect(dryRun(db, sameZone(), fileDays('2027-03-01', 3, '12:20'), 'replace', A).overlaps.file).toBe(3);
    expect(dryRun(db, sameZone(), fileDays('2027-03-01', 3, '12:20'), 'replace', 'surau-c').overlaps.file).toBe(0);

    // B's import cannot be undone through A (and the other way round), and undoing B leaves A's rows.
    expect(undoImport(db, b.id, 'tester', undefined, NOW, A)).toEqual({ ok: false, reason: 'Import tidak dijumpai' });
    expect(resolveDay(db, sameZone(), '2027-03-02', 'sdm')).not.toBeNull();
    expect(undoImport(db, b.id, 'tester', undefined, NOW, B)).toEqual({ ok: true, restored: 3 });
    expect(resolveDay(db, sameZone(), '2027-03-02', 'sdm')).not.toBeNull();
    expect(resolveDay(db, sameZone(), '2027-03-02', B)).toBeNull();
    expect(listImports(db, B)[0]!.undoneAt).not.toBeNull();
  });
});

describe('reference caches stay shared', () => {
  it('the JAKIM zone list is one cache for every surau; the years it reports are per surau', () => {
    const db = newDb();
    // the list is seeded once by the migration, never per surau
    db.prepare('UPDATE jakim_zones SET removed_at = NULL WHERE code = ?').run(SGR);
    importDays(db, SGR, official, 'tester', undefined, {}, A);

    expect(zoneKnown(db, SGR)).toBe(true);
    const fromA = listZones(db, A).find((z) => z.code === SGR)!;
    const fromB = listZones(db, B).find((z) => z.code === SGR)!;
    expect(fromB.code).toBe(SGR); // the same cached list, not a per-surau copy
    expect(fromA.years).toEqual([2026]);
    expect(fromB.years).toEqual([]);

    // the warning is shared (the list) but reads the stored days of the surau that asks
    db.prepare("UPDATE jakim_zones SET removed_at = ? WHERE code = ?").run(NOW.toISOString(), SGR);
    expect(zoneWarning(db, sameZone(), A)).toBe('Zon SGR01 tiada lagi dalam senarai JAKIM; data tersimpan digunakan sehingga 31 Dis 2026');
    expect(zoneWarning(db, sameZone(), B)).toBe('Zon SGR01 tiada lagi dalam senarai JAKIM');
  });
});

describe('hadis source updates per surau', () => {
  const savedUpdateRows = (db: DatabaseSync, surauId: string): string[] =>
    db.prepare('SELECT item_id FROM hadis_source_updates WHERE surau_id = ? ORDER BY item_id').all(surauId).map((r) => String(r.item_id));

  function saveHadis(db: DatabaseSync, surauId: string, client: ReturnType<typeof createHadeethEnc>, id: string): Promise<void> {
    return client.one(id).then((h) => {
      const built = buildProviderItem(h, NOW.toISOString());
      if (!built.ok) throw new Error('fixture does not build');
      db.prepare(
        "INSERT INTO content_items (surau_id, kind, id, json, updated_at, updated_by) VALUES (?, 'hadis', ?, ?, ?, 'tester')",
      ).run(surauId, String(built.item.id), JSON.stringify(built.item), NOW.toISOString());
    });
  }

  it('a changed text is flagged for its own surau only, and the other surau is not even checked', async () => {
    const db = newDb();
    const fake = fakeHadeethEnc();
    const client = createHadeethEnc(fake.fetch, 'https://hadeethenc.com/api/v1');
    await saveHadis(db, A, client, '66513');
    await saveHadis(db, B, client, '66512');
    fake.one.set('66512', { ...fixture('one-66512'), hadeeth: '<p>Teks yang berubah</p>' });
    fake.one.set('66513', { ...fixture('one-66513'), hadeeth: '<p>Teks lain yang berubah</p>' });

    const res = await checkProviderUpdates(db, client, () => NOW, undefined, { pauseMs: 0 }, B);
    expect(res.checked).toBe(1);
    expect(savedUpdateRows(db, B)).toEqual(['hadeethenc-66512']);
    expect(savedUpdateRows(db, A)).toEqual([]);

    // an unchanged text clears the flag of its own surau only
    fake.one.set('66512', fixture('one-66512'));
    await checkProviderUpdates(db, client, () => NOW, undefined, { pauseMs: 0 }, B);
    expect(savedUpdateRows(db, B)).toEqual([]);
  });
});
