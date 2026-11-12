import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseJakimCsv, resolveSettings } from '@surau/core';
import type { PrayerDay, Settings, Snapshot } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { importDays } from '../src/prayerStore.ts';
import { putCorrection } from '../src/prayer/corrections.ts';
import { applyImport, parseCsvRows, parseTemplateRows, snapshotImports } from '../src/prayer/importFile.ts';
import { runCloudLink } from '../src/cli/cloudLink.ts';
import { snapshot } from '../src/sync/feed.ts';
import { issueLinkCode } from '../src/sync/sites.ts';
import { loadSyncKey } from '../src/sync/syncKey.ts';
import { buildCloud, CLOUD_URL } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FakeWorker } from './support/fakeWorker.ts';

/** Plan 13 gap 1: the prayer section of a 410 snapshot is applied by the box, by the same rules as the feed. */

const official = parseJakimCsv(readFileSync(fileURLToPath(new URL('../../../packages/core/test/fixtures/SGR01-2026.csv', import.meta.url)), 'utf8'));
const T = (iso: string): Date => new Date(iso);
const ke = (): Settings => resolveSettings({ location: { country: 'KE', timezone: 'Africa/Nairobi', latitude: -1.29, longitude: 36.82 }, prayerSources: { sourceOrder: ['file', 'calc', 'official'] } } as never);
const fileDays = (dates: string[]): PrayerDay[] => {
  const c = parseCsvRows(['tarikh,subuh,syuruk,zohor,asar,maghrib,isyak', ...dates.map((d) => `${d},04:50,06:00,12:12,15:30,18:20,19:30`)].join('\n'));
  return parseTemplateRows(c.rows, { kind: 'surau', imsakMinutes: 10 }, c.numbers).days;
};
const range = (from: string, n: number): string[] => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));

interface Pair { box: FastifyInstance; boxDir: string; cloud: TestCloud; hook: { fetch: typeof fetch } }
const pairs: Pair[] = [];
const extraDirs: string[] = [];
const extraDbs: DatabaseSync[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const p of pairs.splice(0)) { await p.box.close().catch(() => undefined); await p.cloud.close(); rmSync(p.boxDir, { recursive: true, force: true }); }
  for (const d of extraDbs.splice(0)) d.close();
  for (const d of extraDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function makePair(): Promise<Pair> {
  const boxDir = mkdtempSync(join(tmpdir(), 'surau-snapprayer-'));
  const hook = { fetch: undefined as unknown as typeof fetch };
  const box = buildApp(join(boxDir, 'box.db'), {
    dataDir: boxDir,
    sync: { fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => hook.fetch(i, n)) as typeof fetch, sleep: async () => undefined },
  });
  const boxId = box.surau.boxId;
  const cloud = buildCloud(boxId);
  const worker = new FakeWorker(cloud.fetch);
  hook.fetch = worker.fetch;
  const pair: Pair = { box, boxDir, cloud, hook };
  pairs.push(pair);
  const { code } = issueLinkCode({ db: cloud.app.surau.db, now: () => new Date() }, { boxId, name: 'Surau Ujian' });
  expect(await runCloudLink(['--data', boxDir, '--db', join(boxDir, 'box.db'), 'link', CLOUD_URL, code], { out: () => undefined, err: () => undefined }, worker.fetch)).toBe(0);
  worker.setSecret(boxId, loadSyncKey(boxDir)!.wakeSecret);
  return pair;
}

const urlOf = (i: Parameters<typeof fetch>[0]): string => (typeof i === 'string' ? i : i instanceof URL ? i.href : i.url);
const jsonRes = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const dbOf = (p: Pair): DatabaseSync => p.box.surau.db;

/** The cloud's own prayer data: official days, one file import and one correction. */
function cloudPrayer(): NonNullable<Snapshot['prayer']> {
  const d = mkdtempSync(join(tmpdir(), 'surau-snapsrc-'));
  extraDirs.push(d);
  const src = openDb(join(d, 'src.db'));
  extraDbs.push(src);
  importDays(src, 'SGR01', official, 'system:auto-prayer-fetch', undefined);
  applyImport(src, ke(), { kind: 'csv', fileName: 'a.csv', sha256: 'a'.repeat(64), days: fileDays(range('2026-12-01', 10)), overlap: 'replace' }, 'user:t', undefined, T('2026-01-01T01:00:00Z'));
  putCorrection(src, { date: '2026-11-26', prayer: 'asar', time: '16:25', reason: 'Ikut takwim' }, 'user:t', undefined, T('2026-01-02T01:00:00Z'));
  return snapshot(src, { users: true, devices: true }, { boxId: 'x', now: T('2026-01-03T00:00:00Z') }).prayer!;
}

/** Make the next sync cycle a 410 whose snapshot carries `prayer`; the box has pushed everything. */
async function runWithSnapshot(p: Pair, prayer: unknown): Promise<void> {
  await p.box.syncAgent!.runOnce();
  const head = Number(dbOf(p).prepare('SELECT MAX(id) AS m FROM change_log').get()?.m);
  dbOf(p).prepare("INSERT INTO sync_state (key, value) VALUES ('last_push_seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(head));
  p.cloud.app.surau.db.prepare("INSERT INTO sync_state (key, value) VALUES ('log_floor', '100000') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  const real = p.hook.fetch;
  p.hook.fetch = (async (i: Parameters<typeof fetch>[0], n?: RequestInit) => {
    const res = await real(i, n);
    if (!urlOf(i).includes('/api/sync/snapshot')) return res;
    const snap = (await res.json()) as Record<string, unknown>;
    snap.prayer = prayer;
    return jsonRes(200, snap);
  }) as typeof fetch;
  await p.box.syncAgent!.runOnce();
}

const count = (db: DatabaseSync, sql: string): number => Number(db.prepare(sql).get()!.n);

describe('Plan 13 gap 1: a snapshot carries the prayer data', () => {
  it('official days, an import and a correction arrive on an empty box', async () => {
    const p = await makePair();
    await runWithSnapshot(p, cloudPrayer());
    expect(p.box.syncAgent!.status().lastError).toBeNull();
    expect(count(dbOf(p), "SELECT COUNT(*) AS n FROM prayer_days WHERE zone = 'SGR01'")).toBe(365);
    expect(count(dbOf(p), 'SELECT COUNT(*) AS n FROM prayer_imports WHERE undone_at IS NULL')).toBe(1);
    expect(count(dbOf(p), 'SELECT COUNT(*) AS n FROM prayer_file_days')).toBe(10);
    expect(dbOf(p).prepare("SELECT time, reason FROM prayer_corrections WHERE date = '2026-11-26' AND prayer = 'asar'").get()).toMatchObject({ time: '16:25', reason: 'Ikut takwim' });
  });

  it('a newer local correction survives; an older local one is replaced', async () => {
    const p = await makePair();
    putCorrection(dbOf(p), { date: '2026-11-26', prayer: 'asar', time: '16:40', reason: 'Ubah tempatan' }, 'user:t', undefined, new Date());
    putCorrection(dbOf(p), { date: '2026-05-01', prayer: 'zohor', time: '13:00', reason: 'Lama sekali' }, 'user:t', undefined, T('2025-01-01T00:00:00Z'));
    const prayer = cloudPrayer();
    (prayer.corrections as Array<Record<string, unknown>>).push({ date: '2026-05-01', prayer: 'zohor', time: '13:05', reason: 'Dari awan', officialAtCorrection: null, editedAt: '2026-01-02T01:00:00.000Z', rev: '2026-01-02T01:00:00.000Z|cloud' });
    await runWithSnapshot(p, prayer);
    expect(dbOf(p).prepare("SELECT time FROM prayer_corrections WHERE date = '2026-11-26' AND prayer = 'asar'").get()?.time).toBe('16:40');
    expect(dbOf(p).prepare("SELECT time FROM prayer_corrections WHERE date = '2026-05-01' AND prayer = 'zohor'").get()?.time).toBe('13:05');
  });

  it('a local correction the snapshot lacks is removed unless it is newer than the snapshot', async () => {
    const p = await makePair();
    putCorrection(dbOf(p), { date: '2026-04-01', prayer: 'subuh', time: '05:10', reason: 'Lama sekali' }, 'user:t', undefined, T('2025-01-01T00:00:00Z'));
    putCorrection(dbOf(p), { date: '2026-04-02', prayer: 'subuh', time: '05:11', reason: 'Baru sahaja' }, 'user:t', undefined, new Date(Date.now() + 3_600_000));
    await runWithSnapshot(p, cloudPrayer());
    expect(count(dbOf(p), "SELECT COUNT(*) AS n FROM prayer_corrections WHERE date = '2026-04-01'")).toBe(0);
    expect(count(dbOf(p), "SELECT COUNT(*) AS n FROM prayer_corrections WHERE date = '2026-04-02'")).toBe(1);
  });

  it('a bad row is not stored and does not stop the good ones', async () => {
    const p = await makePair();
    const prayer = cloudPrayer();
    const bad = JSON.parse(JSON.stringify(prayer.official[0])) as { days: Array<{ times: Record<string, string> }>; zone: string };
    bad.zone = 'ZZZ01';
    bad.days[3]!.times.zohor = '99:99';
    prayer.official.push(bad as never);
    (prayer.corrections as unknown[]).push({ date: '2026-02-30', prayer: 'subuh', time: '05:00', reason: 'tarikh palsu' }, 'not an object', { date: '2026-03-01', prayer: 'asar', time: '25:99', reason: 'masa palsu' });
    (prayer.imports as unknown[]).push({ record: { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', kind: 'csv', fileName: '../../x', sha256: 'z' }, days: [] }, 5);
    await runWithSnapshot(p, prayer);
    expect(p.box.syncAgent!.status().lastError).toBeNull();
    expect(count(dbOf(p), "SELECT COUNT(*) AS n FROM prayer_days WHERE zone = 'ZZZ01'")).toBe(0);
    expect(count(dbOf(p), 'SELECT COUNT(*) AS n FROM prayer_corrections')).toBe(1);
    expect(count(dbOf(p), 'SELECT COUNT(*) AS n FROM prayer_imports')).toBe(1);
    expect(count(dbOf(p), "SELECT COUNT(*) AS n FROM prayer_days WHERE zone = 'SGR01'")).toBe(365);
  });

  it('a snapshot whose prayer section is not an object is skipped; the rest still applies', async () => {
    const p = await makePair();
    await runWithSnapshot(p, 'rubbish');
    expect(p.box.syncAgent!.status().lastError).toBeNull();
    expect(count(dbOf(p), 'SELECT COUNT(*) AS n FROM prayer_days')).toBe(0);
  });
});

describe('gate 13 item 5: snapshots keep the newest', () => {
  it('201 imports: the snapshot carries the newest 200, oldest first', () => {
    const d = mkdtempSync(join(tmpdir(), 'surau-snapsrc-'));
    extraDirs.push(d);
    const db = openDb(join(d, 'n.db'));
    extraDbs.push(db);
    const ids: string[] = [];
    for (let i = 0; i < 201; i++) {
      const day = new Date(Date.UTC(2026, 11, 1) + i * 86_400_000).toISOString().slice(0, 10);
      const at = new Date(Date.UTC(2026, 0, 1) + i * 60_000);
      ids.push(applyImport(db, ke(), { kind: 'csv', fileName: 'a.csv', sha256: 'a'.repeat(64), days: fileDays([day]), overlap: 'replace' }, 'user:t', undefined, at).id);
    }
    const got = snapshotImports(db).map((x) => x.record.id);
    expect(got).toHaveLength(200);
    expect(got).toEqual(ids.slice(1));
  });

  it('150 zone-years of official days all arrive (the old cap was 100)', async () => {
    const p = await makePair();
    const day = (date: string): PrayerDay => ({ date, hijri: { y: 1448, m: 1, d: 1 }, times: { imsak: '05:00', subuh: '05:10', syuruk: '06:20', zohor: '13:10', asar: '16:20', maghrib: '19:15', isyak: '20:25' } });
    const official: unknown[] = [];
    for (let z = 0; z < 75; z++) for (const y of [2026, 2027]) official.push({ zone: `AAA${String(z).padStart(2, '0')}`, year: y, days: [day(`${y}-03-01`)], fetchedAt: '2026-01-01T00:00:00.000Z' });
    await runWithSnapshot(p, { official, imports: [], corrections: [] });
    expect(p.box.syncAgent!.status().lastError).toBeNull();
    expect(count(dbOf(p), "SELECT COUNT(*) AS n FROM prayer_days WHERE zone LIKE 'AAA%'")).toBe(150);
  });
});
