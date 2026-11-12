import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSettings } from '@surau/core';
import type { PrayerDay, Settings } from '@surau/core';
import { openDb } from '../src/db.ts';
import { importDays } from '../src/prayerStore.ts';
import { CorrectionError, MAX_CORRECTION_ROWS, putCorrection } from '../src/prayer/corrections.ts';
import { resolveDay } from '../src/prayer/resolve.ts';

const dbs: DatabaseSync[] = [];
const newDb = (): DatabaseSync => { const db = openDb(':memory:'); dbs.push(db); return db; };
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });
const T = (iso: string): Date => new Date(iso);
const my = (over: object = {}): Settings => resolveSettings({ location: { latitude: 3.07, longitude: 101.52 }, ...over } as never);
const day = (date: string, over: Partial<PrayerDay['times']> = {}): PrayerDay => ({
  date, hijri: { y: 1448, m: 5, d: 20 },
  times: { imsak: '05:40', subuh: '05:50', syuruk: '07:00', zohor: '13:10', asar: '16:20', maghrib: '19:15', isyak: '20:25', ...over },
});

describe('gate 13 item 6: a correction can never blank a day', () => {
  it('a correction that keeps the order is used (success path)', () => {
    const db = newDb();
    importDays(db, 'SGR01', [day('2026-11-03')], 'tester');
    putCorrection(db, { date: '2026-11-03', prayer: 'asar', time: '16:25', reason: 'Ikut takwim' }, 'user:t', undefined, T('2026-11-01T00:00:00Z'));
    const d = resolveDay(db, my({ zone: { zone: 'SGR01' } }), '2026-11-03')!;
    expect(d.times.asar).toBe('16:25');
    expect(d.corrected).toEqual(['asar']);
    expect(d.correctionIgnored).toBeUndefined();
  });

  it('a correction that a later source change put out of order is ignored for that day and flagged', () => {
    const db = newDb();
    importDays(db, 'SGR01', [day('2026-11-03')], 'tester');
    putCorrection(db, { date: '2026-11-03', prayer: 'asar', time: '14:00', reason: 'Ikut takwim' }, 'user:t', undefined, T('2026-11-01T00:00:00Z'));
    putCorrection(db, { date: '2026-11-03', prayer: 'maghrib', time: '19:30', reason: 'Ikut takwim' }, 'user:t', undefined, T('2026-11-01T00:00:00Z'));
    // the official source is fetched again with a later zohor: the old asar correction (14:00) is now before it
    importDays(db, 'SGR01', [day('2026-11-03', { zohor: '14:30' })], 'tester');
    const d = resolveDay(db, my({ zone: { zone: 'SGR01' } }), '2026-11-03')!;
    const ordered = ['imsak', 'subuh', 'syuruk', 'zohor', 'asar', 'maghrib', 'isyak'].map((p) => d.times[p as keyof typeof d.times]);
    expect([...ordered].sort()).toEqual(ordered);
    expect(d.correctionIgnored).toEqual(['asar']);
    expect(d.corrected).toEqual(['maghrib']);
    expect(d.times.asar).toBe('16:20');
    expect(d.times.maghrib).toBe('19:30');
  });

  it('a replicated correction outside 2020..2100 or past the row ceiling is refused; one inside is kept', () => {
    const db = newDb();
    const meta = { editedAt: '2026-11-20T00:00:00.000Z', rev: '2026-11-20T00:00:00.000Z|cloud', origin: 'cloud' } as never;
    const put = (date: string): void => putCorrection(db, { date, prayer: 'asar', time: '16:25', reason: 'Dari awan' }, 'system:sync', undefined, T('2026-11-20T00:00:00Z'), null, { meta });
    expect(() => put('1999-05-01')).toThrow(CorrectionError);
    expect(() => put('2101-05-01')).toThrow(CorrectionError);
    put('2026-05-01');
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM prayer_corrections').get()!.n)).toBe(1);
    const ins = db.prepare("INSERT INTO prayer_corrections (date, prayer, time, reason, actor, created_at) VALUES (?, 'subuh', '05:10', 'x', 'a', '2026-01-01T00:00:00Z')");
    db.exec('BEGIN');
    for (let i = 0; i < MAX_CORRECTION_ROWS; i++) ins.run(`2030-01-01#${i}`);
    db.exec('COMMIT');
    expect(() => put('2026-05-02')).toThrow(/too many/);
    put('2026-05-01'); // an existing key may still be updated
    // a local correction is not capped by the replicated ceiling
    expect(() => putCorrection(db, { date: '2026-05-03', prayer: 'asar', time: '16:25', reason: 'Tempatan' }, 'user:t', undefined, T('2026-11-20T00:00:00Z'))).not.toThrow();
  });
});

describe('gate 13 item 7: a dry run says when the file would never be used', () => {
  it('flags calc above file for a located surau, not file above calc, not an unlocated one', async () => {
    const { dryRun } = await import('../src/prayer/importFile.ts');
    const db = newDb();
    const days = [day('2026-12-01'), day('2026-12-02')];
    const my = (order: string[], located = true): Settings => resolveSettings({
      location: located ? { latitude: 3.07, longitude: 101.52 } : {}, prayerSources: { sourceOrder: order },
    } as never);
    expect(dryRun(db, my(['official', 'calc', 'file']), days, 'replace').fileShadowed).toBe(true);
    expect(dryRun(db, my(['file', 'calc', 'official']), days, 'replace').fileShadowed).toBe(false);
    expect(dryRun(db, my(['file', 'official', 'calc']), days, 'replace').fileShadowed).toBe(false);
    expect(dryRun(db, my(['official', 'calc', 'file'], false), days, 'replace').fileShadowed).toBe(false);
  });
});

describe('gate 13 item 8: Hijri stays continuous between sources', () => {
  it('carries the official-minus-Umm-al-Qura difference to a non-official day within 30 days, bounded, and not without official data', async () => {
    const { hijriOf } = await import('@surau/core');
    const { resolveDays } = await import('../src/prayer/resolve.ts');
    const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const base = '2026-11-10';
    const settings = my({ zone: { zone: 'SGR01' } });
    const hijriKey = (h: { y: number; m: number; d: number }): string => `${h.y}-${h.m}-${h.d}`;

    // no official data at all: the calculated day keeps Umm al-Qura, unchanged
    const bare = newDb();
    expect(hijriKey(resolveDays(bare, settings, addDays(base, 5), addDays(base, 5))[0]!.hijri)).toBe(hijriKey(hijriOf(addDays(base, 5))));

    // JAKIM's Malaysian date is one day ahead of Umm al-Qura on the official day
    const db = newDb();
    importDays(db, 'SGR01', [{ ...day(base), hijri: hijriOf(addDays(base, 1)) }], 'tester');
    const days = resolveDays(db, settings, addDays(base, -31), addDays(base, 31));
    const byDate = new Map(days.map((d) => [d.date, d]));
    expect(byDate.get(base)!.source).toBe('official');
    // after the boundary and before it, within 30 days: the one-day lead carries over
    for (const k of [-30, -5, 1, 5, 30]) {
      const d = byDate.get(addDays(base, k))!;
      expect(d.source, `day ${k}`).toBe('calc');
      expect(hijriKey(d.hijri), `day ${k}`).toBe(hijriKey(hijriOf(addDays(base, k + 1))));
    }
    // 31 days away: back to plain Umm al-Qura
    for (const k of [-31, 31]) expect(hijriKey(byDate.get(addDays(base, k))!.hijri), `day ${k}`).toBe(hijriKey(hijriOf(addDays(base, k))));

    // a difference larger than 2 days is not carried (it would be a data error)
    const far = newDb();
    importDays(far, 'SGR01', [{ ...day(base), hijri: hijriOf(addDays(base, 3)) }], 'tester');
    expect(hijriKey(resolveDays(far, settings, addDays(base, 4), addDays(base, 4))[0]!.hijri)).toBe(hijriKey(hijriOf(addDays(base, 4))));
  });
});
