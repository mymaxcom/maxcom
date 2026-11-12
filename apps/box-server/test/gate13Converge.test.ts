import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSettings } from '@surau/core';
import type { FeedEntry, PrayerDay, Settings } from '@surau/core';
import { openDb } from '../src/db.ts';
import { applyImport, parseCsvRows, parseTemplateRows, undoImport } from '../src/prayer/importFile.ts';
import { applyFeedEntry } from '../src/sync/apply.ts';
import type { ApplyCtx } from '../src/sync/apply.ts';
import { readFeed } from '../src/sync/feed.ts';

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
const newDb = (): DatabaseSync => { const d = mkdtempSync(join(tmpdir(), 'surau-g13-')); dirs.push(d); const db = openDb(join(d, 't.db')); dbs.push(db); return db; };
afterEach(() => { for (const d of dbs.splice(0)) d.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const T = (iso: string): Date => new Date(iso);
const ctx = (): ApplyCtx => ({ now: T('2026-11-20T10:00:00Z'), origin: 'box:boxA', actor: 'system:sync', dataDir: tmpdir() });
const prayerOf = (db: DatabaseSync): FeedEntry[] => readFeed(db, 0, 5000, { users: true, devices: true }).entries.filter((e) => e.entity.startsWith('prayer:'));
const importEntry = (db: DatabaseSync, id: string): FeedEntry => prayerOf(db).filter((e) => e.entity === 'prayer:import' && e.entityId === id).pop()!;
const send = (to: DatabaseSync, entries: FeedEntry[]): string[] => entries.map((e) => applyFeedEntry(to, e, ctx()).status);
const fileRows = (db: DatabaseSync): unknown[] => db.prepare('SELECT date, import_id, json, prev_import_id, prev_json FROM prayer_file_days ORDER BY date').all()
  .map((r) => ({ ...r, json: JSON.parse(String(r.json)), prev_json: r.prev_json === null ? null : JSON.parse(String(r.prev_json)) }));

const fileDays = (dates: string[], zohor = '12:12'): PrayerDay[] => {
  const head = 'tarikh,subuh,syuruk,zohor,asar,maghrib,isyak';
  const lines = dates.map((d) => `${d},04:50,06:00,${zohor},15:30,18:20,19:30`);
  const c = parseCsvRows([head, ...lines].join('\n'));
  return parseTemplateRows(c.rows, { kind: 'surau', imsakMinutes: 10 }, c.numbers).days;
};
const range = (from: string, n: number): string[] => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
const ke = (): Settings => resolveSettings({ location: { country: 'KE', timezone: 'Africa/Nairobi', latitude: -1.29, longitude: 36.82 }, prayerSources: { sourceOrder: ['file', 'calc', 'official'] } } as never);
const imp = (db: DatabaseSync, name: string, dates: string[], zohor: string, at: string, overlap: 'replace' | 'keep' | 'fillEmpty' = 'replace') =>
  applyImport(db, ke(), { kind: 'csv', fileName: name, sha256: name.charCodeAt(0).toString(16).padStart(2, '0').repeat(32), days: fileDays(dates, zohor), overlap }, 'user:t', undefined, T(at));

describe('gate 13 item 2: replicated imports converge', () => {
  it('X then Y and Y then X end identical, and undo restores the same on both', () => {
    const a = newDb(); const b = newDb(); const c = newDb(); const d = newDb();
    const x = imp(a, 'x.csv', range('2026-12-01', 20), '12:20', '2026-11-10T01:00:00Z');
    const y = imp(b, 'y.csv', range('2026-12-10', 20), '12:40', '2026-11-11T01:00:00Z');
    const ex = importEntry(a, x.id); const ey = importEntry(b, y.id);
    expect(send(c, [ex, ey])).toEqual(['applied', 'applied']);
    expect(send(d, [ey, ex])).toEqual(['applied', 'applied']);
    expect(fileRows(d)).toEqual(fileRows(c));
    // the overlap 12-10..12-20 belongs to the newer import Y on both, with X recorded as previous
    const overlapRow = fileRows(d).find((r) => (r as { date: string }).date === '2026-12-15') as { import_id: string; prev_import_id: string };
    expect(overlapRow.import_id).toBe(y.id);
    expect(overlapRow.prev_import_id).toBe(x.id);
    // the origin boxes converge with them too
    send(a, [ey]); send(b, [ex]);
    expect(fileRows(a)).toEqual(fileRows(c));
    expect(fileRows(b)).toEqual(fileRows(c));
    // undoing Y gives X back on a side that applied in each order
    expect(undoImport(c, y.id, 'user:t', undefined, T('2026-11-12T01:00:00Z'))).toMatchObject({ ok: true });
    expect(undoImport(d, y.id, 'user:t', undefined, T('2026-11-12T01:00:00Z'))).toMatchObject({ ok: true });
    expect(fileRows(d)).toEqual(fileRows(c));
    const back = fileRows(c).find((r) => (r as { date: string }).date === '2026-12-15') as { import_id: string; json: { times: { zohor: string } } };
    expect(back.import_id).toBe(x.id);
    expect(back.json.times.zohor).toBe('12:20');
  });

  it('an import replacing an earlier one keeps working as before (success path)', () => {
    const a = newDb(); const c = newDb();
    const x = imp(a, 'x.csv', range('2026-12-01', 10), '12:20', '2026-11-10T01:00:00Z');
    const y = imp(a, 'y.csv', range('2026-12-05', 10), '12:40', '2026-11-11T01:00:00Z');
    send(c, prayerOf(a).filter((e) => e.entity === 'prayer:import'));
    expect(fileRows(c)).toEqual(fileRows(a));
    expect((fileRows(c).find((r) => (r as { date: string }).date === '2026-12-07') as { import_id: string }).import_id).toBe(y.id);
    void x;
  });

  it('a day outside dateFrom..dateTo is refused and nothing is applied', () => {
    const a = newDb(); const c = newDb();
    const x = imp(a, 'x.csv', range('2026-12-01', 10), '12:20', '2026-11-10T01:00:00Z');
    const e = importEntry(a, x.id);
    const after = JSON.parse(JSON.stringify(e.after)) as { days: Array<{ date: string; json: { date: string } }> };
    after.days[3]!.date = '2027-03-03'; after.days[3]!.json.date = '2027-03-03';
    expect(send(c, [{ ...e, after }])).toEqual(['refused']);
    expect(fileRows(c)).toEqual([]);
    expect(send(c, [e])).toEqual(['applied']);
  });
});

describe('gate 13 item 3: existing official days reach the cloud', () => {
  const official = (): PrayerDay[] => {
    const mk = (date: string): PrayerDay => ({ date, hijri: { y: 1448, m: 1, d: 1 }, times: { imsak: '05:00', subuh: '05:10', syuruk: '06:20', zohor: '13:10', asar: '16:20', maghrib: '19:15', isyak: '20:25' } });
    return [...range('2026-12-20', 12), ...range('2027-01-01', 5)].map(mk);
  };
  const rawInsert = (db: DatabaseSync, zone: string, days: PrayerDay[]): void => {
    for (const d of days) db.prepare('INSERT INTO prayer_days (zone, date, json, fetched_at) VALUES (?, ?, ?, ?)').run(zone, d.date, JSON.stringify(d), '2026-11-01T00:00:00.000Z');
  };
  const entries = (db: DatabaseSync): FeedEntry[] => prayerOf(db).filter((e) => e.entity === 'prayer:official');

  it('an upgraded box sends one entry per stored zone and year, once, with the full list', async () => {
    const { backfillOfficialFeed } = await import('../src/prayerStore.ts');
    const box = newDb();
    rawInsert(box, 'SGR01', official());
    rawInsert(box, 'JHR02', official().slice(0, 3));
    expect(entries(box)).toEqual([]);
    expect(backfillOfficialFeed(box, T('2026-11-20T00:00:00Z'))).toBe(3);
    const got = entries(box);
    expect(got.map((e) => e.entityId).sort()).toEqual(['JHR02:2026', 'SGR01:2026', 'SGR01:2027']);
    expect((got.find((e) => e.entityId === 'SGR01:2026')!.after as { days: unknown[] }).days).toHaveLength(12);
    expect((got.find((e) => e.entityId === 'SGR01:2027')!.after as { days: unknown[] }).days).toHaveLength(5);
    // a second start writes nothing
    expect(backfillOfficialFeed(box, T('2026-11-21T00:00:00Z'))).toBe(0);
    expect(entries(box)).toHaveLength(3);
    // the cloud accepts them and holds the same days
    const cloud = newDb();
    expect(send(cloud, got)).toEqual(['applied', 'applied', 'applied']);
    expect(Number(cloud.prepare('SELECT COUNT(*) AS n FROM prayer_days').get()!.n)).toBe(20);
  });

  it('buildApp backfills for a box and never for a cloud', async () => {
    const { buildApp } = await import('../src/app.ts');
    const dir = mkdtempSync(join(tmpdir(), 'surau-g13b-'));
    const seed = (path: string): void => { const d = openDb(path); rawInsert(d, 'SGR01', official()); d.close(); };
    seed(join(dir, 'box.db')); seed(join(dir, 'cloud.db'));
    const count = (path: string): number => { const d = openDb(path); try { return entries(d).length; } finally { d.close(); } };
    const box = buildApp(join(dir, 'box.db'), { dataDir: dir, role: 'box' });
    await box.close();
    const cloud = buildApp(join(dir, 'cloud.db'), { dataDir: dir, role: 'cloud' });
    await cloud.close();
    expect(count(join(dir, 'box.db'))).toBe(2);
    expect(count(join(dir, 'cloud.db'))).toBe(0);
  });

  it('an insert-only fetch of a few days sends the full year', async () => {
    const { importDays } = await import('../src/prayerStore.ts');
    const box = newDb();
    importDays(box, 'SGR01', official().slice(0, 5), 'tester');
    importDays(box, 'SGR01', official().slice(0, 9), 'system:auto-prayer-fetch', undefined, { insertOnly: true });
    const second = entries(box)[1]!;
    expect((second.after as { days: unknown[] }).days).toHaveLength(9);
  });
});
