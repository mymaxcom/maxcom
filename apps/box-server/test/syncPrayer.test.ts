import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { parseJakimCsv, resolveSettings } from '@surau/core';
import type { FeedEntry, PrayerDay, Settings } from '@surau/core';
import { openDb } from '../src/db.ts';
import { importDays } from '../src/prayerStore.ts';
import { putCorrection, removeCorrection } from '../src/prayer/corrections.ts';
import { applyImport, parseCsvRows, parseTemplateRows, undoImport } from '../src/prayer/importFile.ts';
import { resolveDays } from '../src/prayer/resolve.ts';
import { getSettings } from '../src/settingsStore.ts';
import { applyFeedEntry } from '../src/sync/apply.ts';
import type { ApplyCtx } from '../src/sync/apply.ts';
import { readFeed, snapshot } from '../src/sync/feed.ts';
import { verifySiteEntry } from '../src/sync/verify.ts';

const official = parseJakimCsv(readFileSync(fileURLToPath(new URL('../../../packages/core/test/fixtures/SGR01-2026.csv', import.meta.url)), 'utf8'));
const ALL = { users: true, devices: true };
const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
const newDb = (): DatabaseSync => { const d = mkdtempSync(join(tmpdir(), 'surau-sp-')); dirs.push(d); const db = openDb(join(d, 't.db')); dbs.push(db); return db; };
afterEach(() => { for (const d of dbs.splice(0)) d.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const T = (iso: string): Date => new Date(iso);
const ctx = (): ApplyCtx => ({ now: T('2026-11-20T10:00:00Z'), origin: 'box:boxA', actor: 'system:sync', dataDir: tmpdir() });
const feedOf = (db: DatabaseSync): FeedEntry[] => readFeed(db, 0, 5000, ALL).entries;
const prayerOf = (db: DatabaseSync): FeedEntry[] => feedOf(db).filter((e) => e.entity.startsWith('prayer:'));
const send = (to: DatabaseSync, entries: FeedEntry[]): string[] => entries.map((e) => applyFeedEntry(to, e, ctx()).status);
const rowsOf = (db: DatabaseSync, sql: string): unknown[] => db.prepare(sql).all();

const fileDays = (dates: string[], over: Partial<PrayerDay['times']> = {}): PrayerDay[] => {
  const head = 'tarikh,subuh,syuruk,zohor,asar,maghrib,isyak';
  const lines = dates.map((d) => `${d},04:50,06:00,${over.zohor ?? '12:12'},15:30,18:20,19:30`);
  const c = parseCsvRows([head, ...lines].join('\n'));
  return parseTemplateRows(c.rows, { kind: 'surau', imsakMinutes: 10 }, c.numbers).days;
};
const range = (from: string, n: number): string[] => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
const ke = (): Settings => resolveSettings({ location: { country: 'KE', timezone: 'Africa/Nairobi', latitude: -1.29, longitude: 36.82 }, prayerSources: { sourceOrder: ['file', 'calc', 'official'] } } as never);

describe('prayer entities in the feed', () => {
  it('a JAKIM import is one prayer:official entry per year, and the other side ends with the same days', () => {
    const box = newDb();
    const cloud = newDb();
    importDays(box, 'SGR01', official, 'system:auto-prayer-fetch');
    const entries = prayerOf(box).filter((e) => e.entity === 'prayer:official');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entityId: 'SGR01:2026', origin: 'local' });
    expect((entries[0]!.after as { days: unknown[] }).days).toHaveLength(365);

    expect(send(cloud, entries)).toEqual(['applied']);
    expect(rowsOf(cloud, 'SELECT zone, date, json, fetched_at FROM prayer_days ORDER BY date')).toEqual(rowsOf(box, 'SELECT zone, date, json, fetched_at FROM prayer_days ORDER BY date'));
    // applied again: nothing changes, no new log rows, no echo back
    const before = Number(cloud.prepare('SELECT COUNT(*) AS n FROM change_log').get()!.n);
    expect(send(cloud, entries)).toEqual(['duplicate']);
    expect(Number(cloud.prepare('SELECT COUNT(*) AS n FROM change_log').get()!.n)).toBe(before);
    const echoed = feedOf(cloud).filter((e) => e.entity.startsWith('prayer:') && e.origin === 'local');
    expect(echoed).toEqual([]);
    expect(resolveDays(cloud, resolveSettings({}), '2026-11-01', '2026-11-03').map((d) => d.source)).toEqual(['official', 'official', 'official']);
  });

  it('the auto fetch (insert only) sends the full stored year, not only the days it added', () => {
    const box = newDb();
    importDays(box, 'SGR01', official.slice(0, 10), 'tester');
    importDays(box, 'SGR01', official.slice(0, 20), 'system:auto-prayer-fetch', undefined, { insertOnly: true });
    const second = prayerOf(box).filter((e) => e.entity === 'prayer:official')[1]!;
    expect((second.after as { days: unknown[] }).days).toHaveLength(20);
  });

  it('a file import, its replacement and its undo replicate, with the same resolved days', () => {
    const box = newDb();
    const cloud = newDb();
    const s = ke();
    const a = applyImport(box, s, { kind: 'csv', fileName: 'a.csv', sha256: 'a'.repeat(64), days: fileDays(range('2026-12-01', 31)), overlap: 'replace' }, 'user:t', undefined, T('2026-11-10T01:00:00Z'));
    const b = applyImport(box, s, { kind: 'csv', fileName: 'b.csv', sha256: 'b'.repeat(64), days: fileDays(range('2026-12-20', 20), { zohor: '12:40' }), overlap: 'replace' }, 'user:t', undefined, T('2026-11-11T01:00:00Z'));
    expect(send(cloud, prayerOf(box))).toEqual(['applied', 'applied']);
    const view = (db: DatabaseSync) => resolveDays(db, s, '2026-12-01', '2027-01-10').map((d) => [d.date, d.source, d.times.zohor]);
    expect(view(cloud)).toEqual(view(box));
    expect(view(cloud).find((r) => r[0] === '2026-12-25')![2]).toBe('12:40');
    expect(rowsOf(cloud, 'SELECT id, kind, file_name, sha256, rows, date_from, date_to, overlap, inserted, replaced, skipped FROM prayer_imports ORDER BY id'))
      .toEqual(rowsOf(box, 'SELECT id, kind, file_name, sha256, rows, date_from, date_to, overlap, inserted, replaced, skipped FROM prayer_imports ORDER BY id'));

    expect(undoImport(box, b.id, 'user:t', undefined, T('2026-11-12T01:00:00Z'))).toEqual({ ok: true, restored: 20 });
    const all = prayerOf(box);
    const undoEntry = all[all.length - 1]!;
    expect(undoEntry).toMatchObject({ entity: 'prayer:import', entityId: b.id });
    expect(send(cloud, [undoEntry])).toEqual(['applied']);
    expect(view(cloud)).toEqual(view(box));
    expect(view(cloud).find((r) => r[0] === '2026-12-25')![2]).toBe('12:12');
    expect(send(cloud, [undoEntry])).toEqual(['duplicate']);
    void a;
  });

  it('a correction and its removal round trip', () => {
    const box = newDb();
    const cloud = newDb();
    importDays(box, 'SGR01', official.filter((d) => d.date === '2026-11-26'), 'tester');
    putCorrection(box, { date: '2026-11-26', prayer: 'asar', time: '16:25', reason: 'Ikut takwim masjid' }, 'user:t', undefined, T('2026-11-10T01:00:00Z'), 'SGR01');
    send(cloud, prayerOf(box));
    const read = (db: DatabaseSync) => rowsOf(db, 'SELECT date, prayer, time, reason, official_at_correction FROM prayer_corrections');
    expect(read(cloud)).toEqual(read(box));
    expect(read(cloud)).toHaveLength(1);
    expect(removeCorrection(box, '2026-11-26', 'asar', 'user:t', undefined, T('2026-11-11T01:00:00Z'))).toBe(true);
    const last = prayerOf(box).pop()!;
    expect(last.after).toBeNull();
    expect(send(cloud, [last])).toEqual(['applied']);
    expect(read(cloud)).toEqual([]);
  });

  it('an older entry does not replace a newer one', () => {
    const box = newDb();
    const cloud = newDb();
    putCorrection(cloud, { date: '2026-11-26', prayer: 'asar', time: '16:30', reason: 'Dari awan' }, 'user:c', undefined, T('2026-11-15T01:00:00Z'));
    putCorrection(box, { date: '2026-11-26', prayer: 'asar', time: '16:25', reason: 'Dari kotak' }, 'user:b', undefined, T('2026-11-10T01:00:00Z'));
    expect(send(cloud, prayerOf(box))).toEqual(['superseded']);
    expect(rowsOf(cloud, 'SELECT time FROM prayer_corrections')).toEqual([{ time: '16:30' }]);
  });

  it('refuses bad payloads and applies nothing from them', () => {
    const box = newDb();
    const cloud = newDb();
    importDays(box, 'SGR01', official.filter((d) => d.date >= '2026-11-01' && d.date <= '2026-11-05'), 'tester');
    const good = prayerOf(box).find((e) => e.entity === 'prayer:official')!;
    const mut = (f: (a: Record<string, unknown> & { days: Record<string, unknown>[] }) => void): FeedEntry => {
      const a = JSON.parse(JSON.stringify(good.after)) as Record<string, unknown> & { days: Record<string, unknown>[] };
      f(a);
      return { ...good, after: a };
    };
    const bad = [
      mut((a) => { (a.days[1]!.times as Record<string, string>).asar = '03:00'; }),
      mut((a) => { a.days[0]!.date = '2027-01-01'; }),
      mut((a) => { a.days[1]!.date = a.days[0]!.date; }),
      mut((a) => { a.days = []; }),
      mut((a) => { a.zone = 'sgr01'; }),
      mut((a) => { a.year = 1999; }),
      mut((a) => { a.days = Array.from({ length: 367 }, () => a.days[0]!); }),
      mut((a) => { (a.days[0]!.times as Record<string, string>).subuh = '25:00'; }),
      { ...good, entityId: 'SGR01:2025' },
    ];
    for (const e of bad) expect(send(cloud, [e])[0], JSON.stringify(e.entityId)).toBe('refused');
    expect(Number(cloud.prepare('SELECT COUNT(*) AS n FROM prayer_days').get()!.n)).toBe(0);
    const badCorr: FeedEntry = { ...good, entity: 'prayer:correction', entityId: '2026-11-26|asar', after: { date: '2026-11-26', prayer: 'asar', time: '99:99', reason: 'x' } };
    expect(send(cloud, [badCorr])).toEqual(['refused']);
    const badImport: FeedEntry = { ...good, entity: 'prayer:import', entityId: 'A'.repeat(26), after: { record: { id: 'A'.repeat(26) }, days: [] } };
    expect(send(cloud, [badImport])).toEqual(['refused']);
    expect(Number(cloud.prepare("SELECT COUNT(*) AS n FROM auth_log WHERE detail LIKE 'prayer_bad_payload%'").get()!.n)).toBe(11);
  });

  it('a calculated day is never in the feed or the snapshot, and the snapshot holds the stored data', () => {
    const box = newDb();
    importDays(box, 'SGR01', official, 'tester');
    importDays(box, 'SGR01', official.map((d) => ({ ...d, date: d.date.replace('2026', '2027') })), 'tester');
    applyImport(box, ke(), { kind: 'csv', fileName: 'a.csv', sha256: 'a'.repeat(64), days: fileDays(range('2026-12-01', 5)), overlap: 'replace' }, 'user:t', undefined, T('2026-11-10T01:00:00Z'));
    putCorrection(box, { date: '2026-11-26', prayer: 'asar', time: '16:25', reason: 'Ikut takwim' }, 'user:t', undefined, T('2026-11-10T01:00:00Z'));
    const snap = snapshot(box, ALL, { boxId: 'b', now: T('2026-11-20T00:00:00Z') });
    expect(snap.prayer!.official.map((o) => `${o.zone}:${o.year}:${o.days.length}`)).toEqual(['SGR01:2026:365', 'SGR01:2027:365']);
    expect(snap.prayer!.imports).toHaveLength(1);
    expect(snap.prayer!.corrections).toHaveLength(1);
    for (const e of feedOf(box)) expect(JSON.stringify(e.after ?? null)).not.toMatch(/"source":"calc"/);
    expect(feedOf(box).filter((e) => e.entity === 'prayer_days')).toEqual([]);
  });
});

describe('who may send a prayer entry', () => {
  const entry = (over: Partial<FeedEntry> = {}): FeedEntry => ({
    seq: 1, entity: 'prayer:correction', entityId: '2026-11-26|asar', rev: '2026-11-10T01:00:00.000Z|dev', editedAt: '2026-11-10T01:00:00.000Z',
    syncedAt: '2026-11-10T01:00:00.000Z', actor: 'user:abc', deviceId: null, origin: 'local', opId: null,
    after: { date: '2026-11-26', prayer: 'asar', time: '16:25', reason: 'Ikut takwim' }, ...over,
  });
  it('the entity names and ids are checked by verifySiteEntry; a foreign surau is refused', () => {
    const verify = (e: unknown, site = 'sdm') => verifySiteEntry({ boxId: 'boxA', surauId: site }, { surauId: 'sdm' }, e);
    const withId = (id: string) => verify(entry({ entityId: id }));
    expect(verify(entry()).ok).toBe(true);
    expect(verify(entry(), 'other')).toMatchObject({ ok: false, detail: 'surau_mismatch' });
    expect(withId('..|asar').ok).toBe(false);
    expect(withId('2026-11-26|ASAR').ok).toBe(false);
    expect(verify(entry({ entity: 'prayer:other' as never }))).toMatchObject({ ok: false, detail: 'bad_entity' });
    expect(verify(entry({ entity: 'prayer:official', entityId: 'SGR01:2026', after: 'x' as never })).ok).toBe(false);
    expect(verify(entry({ entity: 'prayer:official', entityId: 'SGR01', after: {} })).ok).toBe(false);
    expect(verify(entry({ entity: 'prayer:official', entityId: 'SGR01:2026', after: {} })).ok).toBe(true);
    expect(verify(entry({ entity: 'prayer:correction', after: null })).ok).toBe(true);
    expect(verify(entry({ entity: 'prayer:import', entityId: 'A'.repeat(26), after: [] as never })).ok).toBe(false);
    expect(verify(entry({ entity: 'prayer:import', entityId: 'a'.repeat(26), after: {} })).ok).toBe(false);
  });
});
