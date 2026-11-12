import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import {
  catalogStats, descendantIds, getHadith, itemsInCategory, listCategories, normalise, search, stateGet, upsertCategories, upsertHadith,
} from '../src/hadis/catalog.ts';
import { createCatalogJob, shouldRefresh } from '../src/hadis/catalogJob.ts';
import { createHadeethEnc } from '../src/hadis/hadeethenc.ts';
import type { HadeethEncClient, HeHadith } from '../src/hadis/hadeethenc.ts';
import { fakeHadeethEnc, fixture } from './support/fakeHadeethEnc.ts';

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) {
    try {
      d.close();
    } catch {
      // already closed
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function newDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'hadis-'));
  dirs.push(dir);
  const db = openDb(join(dir, 'test.db'));
  dbs.push(db);
  return db;
}

const hadith = (id: string, over: Partial<HeHadith> = {}): HeHadith => ({
  id, title: `Tajuk ${id}`, textMs: `Teks ${id}`, introMs: null, textAr: 'نص', introAr: null,
  attributionAr: 'رواه مسلم', gradeAr: 'صحيح', categories: ['59'], digest: 'd'.repeat(64), ...over,
});
const NOW = new Date('2026-11-09T01:00:00.000Z');
const BASE = 'https://hadeethenc.com/api/v1';
const noSleep = async (): Promise<void> => undefined;
const cats = (): { id: string; parent_id: string | null }[] => fixture('categories-list') as never;
const allCategoryIds = (): string[] => cats().map((c) => c.id);
/** Two categories that have no child: the ones the crawl lists. */
const [L1, L2] = cats().filter((c) => !cats().some((d) => d.parent_id === c.id)).map((c) => c.id) as [string, string];

describe('hadis catalog tables', () => {
  it('the migration creates the five box-local tables on a database that already has Plan 6', () => {
    const db = newDb();
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'hadis_%' ORDER BY name").all().map((r) => r.name);
    expect(names).toEqual(['hadis_catalog', 'hadis_catalog_cat', 'hadis_catalog_state', 'hadis_categories', 'hadis_source_updates']);
    expect(db.prepare("SELECT 1 FROM schema_migrations WHERE name = '014-hadis-sources'").get()).toBeTruthy();
  });

  it('normalise folds case, marks and punctuation', () => {
    expect(normalise('Solat!')).toBe('solat');
    expect(normalise('  Amalan-amalan,  ITU. ')).toBe('amalan amalan itu');
    expect(normalise('Rasulullah صلى الله عليه وسلم')).toBe('rasulullah صلى الله عليه وسلم');
    expect(normalise('Café')).toBe('cafe');
  });

  it('upserts and reads back a hadith, and replaces it by id', () => {
    const db = newDb();
    upsertHadith(db, hadith('1'), NOW.toISOString());
    expect(getHadith(db, '1')).toEqual(hadith('1'));
    upsertHadith(db, hadith('1', { title: 'Baharu' }), NOW.toISOString());
    expect(getHadith(db, '1')?.title).toBe('Baharu');
    expect(catalogStats(db)).toEqual({ entries: 1, categories: 0, fetchedAt: NOW.toISOString() });
    expect(getHadith(db, '2')).toBeNull();
  });

  it('search finds by text and ranks title hits first; wildcard characters match nothing', () => {
    const db = newDb();
    upsertHadith(db, hadith('66512', { title: 'Islam itu dibina', textMs: 'Rukun solat dan puasa' }), NOW.toISOString());
    upsertHadith(db, hadith('66513', { title: 'Kejadian manusia', textMs: 'Amalan ahli syurga' }), NOW.toISOString());
    upsertHadith(db, hadith('66514', { title: 'Amalan yang baik', textMs: 'Niat' }), NOW.toISOString());
    expect(search(db, 'amalan').map((h) => h.id)).toEqual(['66514', '66513']);
    expect(search(db, 'SOLAT!').map((h) => h.id)).toEqual(['66512']);
    expect(search(db, '%')).toEqual([]);
    expect(search(db, '_')).toEqual([]);
    expect(search(db, '   ')).toEqual([]);
    expect(search(db, 'amalan', 1)).toHaveLength(1);
  });

  it('categories: replace, BM names with English fallback, descendants and paging', () => {
    const db = newDb();
    upsertCategories(db, [
      { id: '1', parentId: null, titleEn: "The Noble Qur'an", count: 9 },
      { id: '8', parentId: '1', titleEn: 'Revelation', count: 1 },
      { id: '17', parentId: '8', titleEn: 'Collecting', count: 1 },
      { id: '88888', parentId: null, titleEn: 'Not in the table', count: 0 },
    ], NOW.toISOString());
    const cats = listCategories(db);
    expect(cats.find((c) => c.id === '1')?.titleMs).toBe('Al-Quran dan Ulum Al-Quran');
    expect(cats.find((c) => c.id === '88888')?.titleMs).toBe('Not in the table');
    expect(descendantIds(db, '1').sort()).toEqual(['1', '17', '8']);
    expect(descendantIds(db, '9999')).toEqual(['9999']);
    for (let i = 1; i <= 5; i++) upsertHadith(db, hadith(String(i), { categories: [i % 2 ? '17' : '99'] }), NOW.toISOString());
    const p1 = itemsInCategory(db, '1', 1, 2);
    expect(p1.total).toBe(3);
    expect(p1.items.map((h) => h.id)).toEqual(['1', '3']);
    expect(itemsInCategory(db, '1', 2, 2).items.map((h) => h.id)).toEqual(['5']);
    upsertCategories(db, [{ id: '1', parentId: null, titleEn: 'x', count: 0 }], NOW.toISOString());
    expect(listCategories(db)).toHaveLength(1);
  });
});

/** A client over the fake service so the crawl is tested against the real parsing. */
function setup(): { client: HadeethEncClient; fake: ReturnType<typeof fakeHadeethEnc> } {
  const fake = fakeHadeethEnc();
  fake.lists.clear();
  for (const id of allCategoryIds()) fake.lists.set(id, []);
  return { client: createHadeethEnc(fake.fetch, BASE), fake };
}
async function finish(job: ReturnType<typeof createCatalogJob>, id: string): Promise<void> {
  for (let i = 0; i < 1000 && job.status(id)?.state === 'running'; i++) await new Promise((r) => setTimeout(r, 2));
}
const startId = (job: ReturnType<typeof createCatalogJob>): string => (job.start() as { id: string }).id;

describe('catalog crawl job', () => {
  it('runs to done: categories, ids per leaf category, one() per new id; sets lastFullRefresh and clears the cursor', async () => {
    const db = newDb();
    const { client, fake } = setup();
    fake.lists.set(L1, ['66512', '66513']);
    fake.lists.set(L2, ['66513']);
    const logs: string[] = [];
    const job = createCatalogJob({ db, client, now: () => NOW, sleep: noSleep, onLog: (a, d) => logs.push(`${a}:${d}`) });
    expect(shouldRefresh(db, NOW)).toBe(true);
    const id = startId(job);
    await finish(job, id);
    expect(job.status(id)).toMatchObject({ state: 'done', progress: 1 });
    expect(catalogStats(db)).toMatchObject({ entries: 2, categories: 133 });
    expect(getHadith(db, '66512')?.introMs).toMatch(/bersabda:$/);
    expect(stateGet(db, 'hadeethenc.lastFullRefresh')).toBe(NOW.toISOString());
    expect(stateGet(db, 'hadeethenc.cursor')).toBeNull();
    expect(shouldRefresh(db, NOW)).toBe(false);
    expect(shouldRefresh(db, new Date(NOW.getTime() + 31 * 86_400_000))).toBe(true);
    expect(fake.calls.filter((u) => u.includes('/hadeeths/one/')).length).toBe(2);
    expect(logs).toEqual([]);
  });

  it('does not refetch a hadith fresher than 30 days but does refetch an older one', async () => {
    const db = newDb();
    const { client, fake } = setup();
    fake.lists.set(L1, ['66512', '66513']);
    upsertHadith(db, hadith('66512'), NOW.toISOString());
    upsertHadith(db, hadith('66513'), new Date(NOW.getTime() - 40 * 86_400_000).toISOString());
    const job = createCatalogJob({ db, client, now: () => NOW, sleep: noSleep });
    const id = startId(job);
    await finish(job, id);
    expect(job.status(id)?.state).toBe('done');
    const ones = fake.calls.filter((u) => u.includes('/hadeeths/one/'));
    expect(ones).toHaveLength(1);
    expect(ones[0]).toContain('id=66513');
  });

  it('start() while running answers busy, and after it ends a new job may start', async () => {
    const db = newDb();
    const { client } = setup();
    const job = createCatalogJob({ db, client, now: () => NOW, sleep: noSleep });
    const first = job.start();
    expect(job.start()).toBe('busy');
    expect(job.current()).toBe(first);
    await finish(job, (first as { id: string }).id);
    expect(job.current()).toBeNull();
    expect(job.start()).not.toBe('busy');
  });

  it('a category that answers 500 is skipped and counted once; the job still finishes done', async () => {
    const db = newDb();
    const { client, fake } = setup();
    fake.lists.set(L1, ['66512']);
    fake.lists.set(L2, 500);
    const job = createCatalogJob({ db, client, now: () => NOW, sleep: noSleep });
    const id = startId(job);
    await finish(job, id);
    expect(job.status(id)).toMatchObject({ state: 'done', skipped: 1 });
    expect(getHadith(db, '66512')).not.toBeNull();
    expect(fake.calls.filter((u) => u.includes(`category_id=${L2}&`)).length).toBe(1);
  });

  it('8 consecutive failures end failed with a cursor, and the next start resumes from it', async () => {
    const db = newDb();
    const { client, fake } = setup();
    const ids = Array.from({ length: 12 }, (_, i) => String(66600 + i));
    fake.lists.set(L1, ids);
    for (const id of ids) fake.one.set(id, 503);
    const job = createCatalogJob({ db, client, now: () => NOW, sleep: noSleep });
    const id1 = startId(job);
    await finish(job, id1);
    expect(job.status(id1)?.state).toBe('failed');
    expect(job.status(id1)?.error).toBeTruthy();
    expect(stateGet(db, 'hadeethenc.lastFullRefresh')).toBeNull();
    expect(JSON.parse(stateGet(db, 'hadeethenc.cursor')!)).toMatchObject({ phase: 'one', next: 0 });
    expect(fake.calls.filter((u) => u.includes('/hadeeths/one/')).length).toBe(8);
    // the source recovers; the second start resumes (no categories call, no list call) and finishes
    for (const id of ids) fake.one.set(id, { ...fixture('one-66512'), id });
    const before = fake.calls.length;
    const id2 = startId(job);
    await finish(job, id2);
    expect(job.status(id2)?.state).toBe('done');
    const after = fake.calls.slice(before);
    expect(after.some((u) => u.includes('/categories/list/'))).toBe(false);
    expect(after.some((u) => u.includes('/hadeeths/list/'))).toBe(false);
    expect(catalogStats(db).entries).toBe(12);
    expect(stateGet(db, 'hadeethenc.cursor')).toBeNull();
  });

  it('an offline source fails the job on the first call with nothing stored', async () => {
    const db = newDb();
    const { client, fake } = setup();
    fake.offline = true;
    const job = createCatalogJob({ db, client, now: () => NOW, sleep: noSleep });
    const id = startId(job);
    await finish(job, id);
    expect(job.status(id)?.state).toBe('failed');
    expect(catalogStats(db).entries).toBe(0);
  });

  it('logs an unmapped grade or attribution once per distinct text', async () => {
    const db = newDb();
    const { client, fake } = setup();
    fake.lists.set(L1, ['66512', '66513', '66514']);
    for (const id of ['66512', '66513', '66514']) {
      fake.one.set(id, { ...fixture('one-66512'), id, grade: 'ضعيف جدا', attribution: 'رواه فلان' });
    }
    const logs: string[] = [];
    const job = createCatalogJob({ db, client, now: () => NOW, sleep: noSleep, onLog: (a, d) => logs.push(`${a}:${d}`) });
    const id = startId(job);
    await finish(job, id);
    expect(logs.sort()).toEqual(['hadis.attributionUnknown:رواه فلان', 'hadis.gradeUnknown:ضعيف جدا']);
  });

  it('waits the pause (300 ms default) between requests through the injected sleep', async () => {
    const db = newDb();
    const { client, fake } = setup();
    fake.lists.set(L1, ['66512']);
    const waits: number[] = [];
    const job = createCatalogJob({ db, client, now: () => NOW, sleep: async (ms) => { waits.push(ms); } });
    const id = startId(job);
    await finish(job, id);
    expect(job.status(id)?.state).toBe('done');
    expect(waits.length).toBe(fake.calls.length - 1);
    expect(new Set(waits)).toEqual(new Set([300]));
  });
});
