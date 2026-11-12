import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db.ts';
import { putProviderItem } from '../src/content/store.ts';
import {
  catalogStats, getHadith, listCategories, stateGet, stateSet, upsertHadith,
} from '../src/hadis/catalog.ts';
import { createCatalogJob } from '../src/hadis/catalogJob.ts';
import type { CatalogJob } from '../src/hadis/catalogJob.ts';
import { createHadeethEnc } from '../src/hadis/hadeethenc.ts';
import type { HadeethEncClient, HeHadith } from '../src/hadis/hadeethenc.ts';
import { checkProviderUpdates, startHadisTimers } from '../src/hadis/updates.ts';
import { fakeHadeethEnc, fixture } from './support/fakeHadeethEnc.ts';

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  vi.useRealTimers();
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
  const dir = mkdtempSync(join(tmpdir(), 'hadis-crawl-'));
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
const [L1, L2] = cats().filter((c) => !cats().some((d) => d.parent_id === c.id)).map((c) => c.id) as [string, string];

function setup(): { client: HadeethEncClient; fake: ReturnType<typeof fakeHadeethEnc> } {
  const fake = fakeHadeethEnc();
  fake.lists.clear();
  for (const c of cats()) fake.lists.set(c.id, []);
  return { client: createHadeethEnc(fake.fetch, BASE), fake };
}
async function finish(job: CatalogJob, id: string): Promise<void> {
  for (let i = 0; i < 3000 && job.status(id)?.state === 'running'; i++) await new Promise((r) => setTimeout(r, 2));
}
const run = async (job: CatalogJob) => {
  const started = job.start();
  if (started === 'busy') throw new Error('busy');
  await finish(job, started.id);
  return job.status(started.id)!;
};
const mkJob = (db: DatabaseSync, client: HadeethEncClient, onLog?: (a: string, d: string) => void) =>
  createCatalogJob({ db, client, now: () => NOW, sleep: noSleep, ...(onLog ? { onLog } : {}) });
const ids = (n: number, from = 70000): string[] => Array.from({ length: n }, (_, i) => String(from + i));

describe('group 2: a crawl does not stall on deterministic failures', () => {
  it('twelve hadis that answer 404 are skipped, the job goes on past them and stores the good ones that follow', async () => {
    const db = newDb();
    const { client, fake } = setup();
    const bad = ids(12);
    const good = ['80001', '80002'];
    fake.lists.set(L1, [...bad, ...good]);
    for (const id of bad) fake.one.set(id, 404);
    for (const id of good) fake.one.set(id, { ...fixture('one-66512'), id });
    const job = mkJob(db, client);
    const st = await run(job);
    expect(st).toMatchObject({ state: 'done', skipped: 12 });
    expect(getHadith(db, '80001')).not.toBeNull();
    expect(getHadith(db, '80002')).not.toBeNull();
    expect(stateGet(db, 'hadeethenc.cursor')).toBeNull();
  });

  it('a bad-shaped answer (source_bad_response) is deterministic too', async () => {
    const db = newDb();
    const { client, fake } = setup();
    const bad = ids(10);
    fake.lists.set(L1, [...bad, '80001']);
    for (const id of bad) fake.one.set(id, { ...fixture('one-66512'), id: '1' });
    fake.one.set('80001', { ...fixture('one-66512'), id: '80001' });
    const st = await run(mkJob(db, client));
    expect(st).toMatchObject({ state: 'done', skipped: 10 });
    expect(getHadith(db, '80001')).not.toBeNull();
  });

  it('5xx, a dead network and 429 still rewind: 8 in a row fail the job with the cursor at the first of them', async () => {
    for (const status of [503, 429]) {
      const db = newDb();
      const { client, fake } = setup();
      const list = ids(12);
      fake.lists.set(L1, list);
      for (const id of list) fake.one.set(id, status);
      const st = await run(mkJob(db, client));
      expect(st.state, String(status)).toBe('failed');
      expect(JSON.parse(stateGet(db, 'hadeethenc.cursor')!)).toMatchObject({ phase: 'one', next: 0 });
    }
  });

  it('lastFullRefresh is not set when anything was skipped; the next run retries the failed id and then sets it', async () => {
    const db = newDb();
    const { client, fake } = setup();
    fake.lists.set(L1, ['66512', '80001']);
    fake.one.set('80001', 404);
    const job = mkJob(db, client);
    expect((await run(job)).skipped).toBe(1);
    expect(stateGet(db, 'hadeethenc.lastFullRefresh')).toBeNull();
    expect(getHadith(db, '66512')).not.toBeNull();

    fake.one.set('80001', { ...fixture('one-66512'), id: '80001' });
    const before = fake.calls.length;
    const st = await run(job);
    expect(st).toMatchObject({ state: 'done' });
    expect(st.skipped ?? 0).toBe(0);
    expect(getHadith(db, '80001')).not.toBeNull();
    expect(stateGet(db, 'hadeethenc.lastFullRefresh')).toBe(NOW.toISOString());
    // the good id was not fetched again, only the failed one
    const ones = fake.calls.slice(before).filter((u) => u.includes('/hadeeths/one/'));
    expect(ones).toHaveLength(1);
  });

  it('a category that fails is listed again on the next pass; /status keeps showing skipped on the finished job', async () => {
    const db = newDb();
    const { client, fake } = setup();
    fake.lists.set(L2, 404);
    const job = mkJob(db, client);
    const st = await run(job);
    expect(st.skipped).toBe(1);
    expect(stateGet(db, 'hadeethenc.lastFullRefresh')).toBeNull();
    expect(job.last()?.skipped).toBe(1);
    fake.lists.set(L2, ['66513']);
    const st2 = await run(job);
    expect(st2.skipped ?? 0).toBe(0);
    expect(getHadith(db, '66513')).not.toBeNull();
    expect(stateGet(db, 'hadeethenc.lastFullRefresh')).toBe(NOW.toISOString());
  });

  it('an id that fails for good is given up after 3 runs so the refresh can finish', async () => {
    const db = newDb();
    const { client, fake } = setup();
    fake.lists.set(L1, ['80001']);
    fake.one.set('80001', 404);
    const job = mkJob(db, client);
    for (let i = 0; i < 3; i++) {
      expect((await run(job)).skipped, `run ${i + 1}`).toBe(1);
      expect(stateGet(db, 'hadeethenc.lastFullRefresh')).toBeNull();
    }
    const before = fake.calls.length;
    const last = await run(job);
    expect(last.skipped ?? 0).toBe(0);
    expect(last.abandoned).toBe(1);
    expect(fake.calls.slice(before).some((u) => u.includes('id=80001'))).toBe(false);
    expect(stateGet(db, 'hadeethenc.lastFullRefresh')).toBe(NOW.toISOString());
  });

  it('reaching MAX_PAGES on a category counts as skipped', async () => {
    const db = newDb();
    const { client } = setup();
    const endless: HadeethEncClient = {
      ...client,
      list: async () => ({ items: [{ id: '66512', title: 't' }], lastPage: 999, total: 99900 }),
    };
    const st = await run(mkJob(db, endless));
    expect(st.skipped).toBeGreaterThan(0);
    expect(stateGet(db, 'hadeethenc.lastFullRefresh')).toBeNull();
  });
});

describe('group 2: the category tree is protected', () => {
  it('an empty list is refused: the job fails and the stored tree stays', async () => {
    const db = newDb();
    const { client } = setup();
    expect((await run(mkJob(db, client))).state).toBe('done');
    const before = listCategories(db).length;
    expect(before).toBe(133);
    stateSet(db, 'hadeethenc.lastFullRefresh', '2000-01-01T00:00:00.000Z');
    const st = await run(mkJob(db, { ...client, categories: async () => [] }));
    expect(st.state).toBe('failed');
    expect(st.error).toMatch(/categor/i);
    expect(listCategories(db)).toHaveLength(before);
  });

  it('an implausibly small list is refused too, even with no tree yet', async () => {
    const db = newDb();
    const { client } = setup();
    const few = [{ id: '1', parentId: null, titleEn: 'A', count: 1 }, { id: '2', parentId: null, titleEn: 'B', count: 1 }];
    const st = await run(mkJob(db, { ...client, categories: async () => few }));
    expect(st.state).toBe('failed');
    expect(catalogStats(db).categories).toBe(0);
  });

  it('a list that shrinks to less than half of the stored tree is refused; the same list is fine again', async () => {
    const db = newDb();
    const { client } = setup();
    await run(mkJob(db, client));
    const quarter = cats().slice(0, 30).map((c) => ({ id: c.id, parentId: c.parent_id, titleEn: 'x', count: 0 }));
    stateSet(db, 'hadeethenc.lastFullRefresh', '2000-01-01T00:00:00.000Z');
    expect((await run(mkJob(db, { ...client, categories: async () => quarter }))).state).toBe('failed');
    expect(listCategories(db)).toHaveLength(133);
    expect((await run(mkJob(db, client))).state).toBe('done');
  });

  it('more than 2000 categories is refused and nothing is written', async () => {
    const db = newDb();
    const { client } = setup();
    const huge = Array.from({ length: 2001 }, (_, i) => ({ id: String(i + 1), parentId: null, titleEn: 'x', count: 0 }));
    const st = await run(mkJob(db, { ...client, categories: async () => huge }));
    expect(st.state).toBe('failed');
    expect(catalogStats(db).categories).toBe(0);
  });

  it('more than 20000 ids aborts the job and leaves no cursor to resume into the same flood', async () => {
    const db = newDb();
    const { client, fake } = setup();
    fake.lists.set(L1, ids(10000));
    fake.lists.set(L2, ids(10001, 90000));
    const st = await run(mkJob(db, client));
    expect(st.state).toBe('failed');
    expect(st.error).toMatch(/cap|too many|20000/i);
    expect(stateGet(db, 'hadeethenc.cursor')).toBeNull();
    expect(stateGet(db, 'hadeethenc.lastFullRefresh')).toBeNull();
  });

  it('exactly 20000 ids is allowed', async () => {
    const db = newDb();
    const { client, fake } = setup();
    // fetching 20000 texts is not the point: they are all fresh in the catalog already
    const list = ids(20000);
    fake.lists.set(L1, list.slice(0, 10000));
    fake.lists.set(L2, list.slice(10000));
    const fresh = NOW.toISOString();
    db.exec('BEGIN');
    for (const id of list) upsertHadith(db, hadith(id), fresh);
    db.exec('COMMIT');
    const st = await run(mkJob(db, client));
    expect(st.state).toBe('done');
    expect(st.skipped ?? 0).toBe(0);
    expect(stateGet(db, 'hadeethenc.lastFullRefresh')).toBe(NOW.toISOString());
  });
});

describe('group 2: field caps in the catalog', () => {
  it('upsertHadith refuses textAr 8001, title 301, attributionAr 201 and keeps the exact limits', () => {
    const db = newDb();
    expect(() => upsertHadith(db, hadith('1', { textAr: 'ن'.repeat(8001) }), NOW.toISOString())).toThrow(/too long/);
    expect(() => upsertHadith(db, hadith('2', { title: 't'.repeat(301) }), NOW.toISOString())).toThrow(/too long/);
    expect(() => upsertHadith(db, hadith('3', { attributionAr: 'ر'.repeat(201) }), NOW.toISOString())).toThrow(/too long/);
    upsertHadith(db, hadith('4', { textAr: 'ن'.repeat(8000), title: 't'.repeat(300), attributionAr: 'ر'.repeat(200) }), NOW.toISOString());
    expect(getHadith(db, '4')).not.toBeNull();
    expect(catalogStats(db).entries).toBe(1);
  });

  it('the crawl skips a hadith with an over-long field and goes on', async () => {
    const db = newDb();
    const { client, fake } = setup();
    fake.lists.set(L1, ['80001', '66512']);
    fake.one.set('80001', { ...fixture('one-66512'), id: '80001', hadeeth_ar: 'ن'.repeat(8001) });
    const st = await run(mkJob(db, client));
    expect(st).toMatchObject({ state: 'done', skipped: 1 });
    expect(getHadith(db, '66512')).not.toBeNull();
    expect(getHadith(db, '80001')).toBeNull();
  });
});

describe('group 2: the cursor is not written after every category', () => {
  it('writes it a handful of times for a 133-category tree', async () => {
    const db = newDb();
    db.exec(`CREATE TABLE cursor_writes (n INTEGER);
      CREATE TRIGGER cw_i AFTER INSERT ON hadis_catalog_state WHEN NEW.key = 'hadeethenc.cursor' BEGIN INSERT INTO cursor_writes VALUES (1); END;
      CREATE TRIGGER cw_u AFTER UPDATE ON hadis_catalog_state WHEN NEW.key = 'hadeethenc.cursor' BEGIN INSERT INTO cursor_writes VALUES (1); END;`);
    const { client, fake } = setup();
    fake.lists.set(L1, ['66512']);
    expect((await run(mkJob(db, client))).state).toBe('done');
    const n = Number(db.prepare('SELECT COUNT(*) AS n FROM cursor_writes').get()?.n);
    expect(n).toBeGreaterThan(1);
    expect(n).toBeLessThanOrEqual(15);
  });

  it('a stopped job still saves where it was so the next start resumes', async () => {
    const db = newDb();
    const { client, fake } = setup();
    fake.lists.set(L1, ['66512']);
    let calls = 0;
    const job = createCatalogJob({
      db, client, now: () => NOW,
      sleep: async () => { calls++; if (calls === 40) job.stop(); },
    });
    const first = await run(job);
    expect(first.state).toBe('failed');
    const cur = JSON.parse(stateGet(db, 'hadeethenc.cursor')!) as { phase: string; doneCats: string[] };
    expect(cur.phase).toBe('ids');
    expect(cur.doneCats.length).toBeGreaterThan(20);
    const before = fake.calls.length;
    const second = await run(createCatalogJob({ db, client, now: () => NOW, sleep: noSleep }));
    expect(second.state).toBe('done');
    expect(fake.calls.slice(before).some((u) => u.includes('/categories/list/'))).toBe(false);
  });
});

describe('group 2: one flag between the weekly check and a manual refresh', () => {
  it('hold() makes start() answer busy, and a running job makes hold() answer null', async () => {
    const db = newDb();
    const { client } = setup();
    const job = mkJob(db, client);
    const release = job.hold()!;
    expect(release).toBeTypeOf('function');
    expect(job.start()).toBe('busy');
    expect(job.hold()).toBeNull();
    release();
    const started = job.start();
    expect(started).not.toBe('busy');
    expect(job.hold()).toBeNull();
    await finish(job, (started as { id: string }).id);
    expect(job.hold()).toBeTypeOf('function');
  });

  it('the timer holds the job while the weekly check runs, and lets go afterwards', async () => {
    const db = newDb();
    const { client, fake } = setup();
    const job = mkJob(db, client);
    stateSet(db, 'hadeethenc.lastFullRefresh', NOW.toISOString());
    putProviderItem(db, {
      id: 'hadeethenc-66512', textMs: 'x', source: 'Riwayat Muslim', grade: 'sahih', shown: true,
      ext: { provider: 'hadeethenc', id: '66512', attributionAr: 'رواه مسلم', gradeAr: 'صحيح', categories: [], fetchedAt: NOW.toISOString(), digest: 'e'.repeat(64) },
    }, 'test');
    let release!: () => void;
    fake.hold = new Promise<void>((r) => { release = r; });
    vi.useFakeTimers();
    const stop = startHadisTimers({ db, role: 'box', client: { ...client, probe: async () => true }, job, now: () => NOW, firstMs: 100, everyMs: 100_000, check: { pauseMs: 0 } })!;
    await vi.advanceTimersByTimeAsync(200);
    expect(job.start()).toBe('busy');
    release();
    await vi.advanceTimersByTimeAsync(200);
    expect(job.start()).not.toBe('busy');
    stop();
  });
});

describe('group 2: the weekly check', () => {
  const saved = (db: DatabaseSync, n: number, gradeAr = 'صحيح'): string[] => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = String(80000 + i);
      putProviderItem(db, {
        id: `hadeethenc-${id}`, textMs: 'x', source: 'Riwayat Muslim', grade: 'sahih', shown: true,
        ext: { provider: 'hadeethenc', id, attributionAr: 'رواه مسلم', gradeAr, categories: [], fetchedAt: NOW.toISOString(), digest: 'e'.repeat(64) },
      }, 'test');
      out.push(id);
    }
    return out;
  };

  it('lastUpdateCheck is not stamped when the check gave up after 8 failures in a row', async () => {
    const db = newDb();
    const { client, fake } = setup();
    for (const id of saved(db, 12)) fake.one.set(id, 503);
    const res = await checkProviderUpdates(db, client, () => NOW, undefined, { pauseMs: 0 });
    expect(res).toMatchObject({ checked: 0, aborted: true });
    expect(stateGet(db, 'hadeethenc.lastUpdateCheck')).toBeNull();
  });

  it('lastUpdateCheck is stamped when the check completed, even if one hadis answers 404', async () => {
    const db = newDb();
    const { client, fake } = setup();
    const list = saved(db, 3);
    fake.one.set(list[0]!, 404);
    for (const id of list.slice(1)) fake.one.set(id, { ...fixture('one-66512'), id });
    const res = await checkProviderUpdates(db, client, () => NOW, undefined, { pauseMs: 0 });
    expect(res.aborted).toBeUndefined();
    expect(res.checked).toBe(2);
    expect(stateGet(db, 'hadeethenc.lastUpdateCheck')).toBe(NOW.toISOString());
  });

  it('twelve hadis that answer 404 do not abort the check (deterministic), the ones after them are checked', async () => {
    const db = newDb();
    const { client, fake } = setup();
    const list = saved(db, 14);
    for (const id of list.slice(0, 12)) fake.one.set(id, 404);
    for (const id of list.slice(12)) fake.one.set(id, { ...fixture('one-66512'), id });
    const res = await checkProviderUpdates(db, client, () => NOW, undefined, { pauseMs: 0 });
    expect(res.checked).toBe(2);
    expect(stateGet(db, 'hadeethenc.lastUpdateCheck')).toBe(NOW.toISOString());
  });

  it('an aborted check is tried again after retryMs, not after the normal interval', async () => {
    const db = newDb();
    const { client, fake } = setup();
    for (const id of saved(db, 10)) fake.one.set(id, 503);
    vi.useFakeTimers();
    const probeClient = { ...client, probe: async () => true };
    const stop = startHadisTimers({
      db, role: 'box', client: probeClient, job: mkJob(db, client), now: () => NOW,
      firstMs: 100, everyMs: 1_000_000, retryMs: 5_000, check: { pauseMs: 0 },
    })!;
    stateSet(db, 'hadeethenc.lastFullRefresh', NOW.toISOString());
    await vi.advanceTimersByTimeAsync(200);
    const first = fake.calls.filter((u) => u.includes('/hadeeths/one/')).length;
    expect(first).toBe(8);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(fake.calls.filter((u) => u.includes('/hadeeths/one/')).length).toBe(16);
    stop();
  });

  it('an unmapped grade or attribution is logged once per text, over several hadis and several checks', async () => {
    const db = newDb();
    const { client, fake } = setup();
    const list = saved(db, 3);
    for (const id of list) fake.one.set(id, { ...fixture('one-66512'), id, grade: 'ضعيف جدا', attribution: 'رواه فلان' });
    const logs: string[] = [];
    const job = mkJob(db, client, (a, d) => logs.push(`${a}:${d}`));
    const opts = { pauseMs: 0, noteUnknown: job.noteUnknown };
    await checkProviderUpdates(db, client, () => NOW, undefined, opts);
    await checkProviderUpdates(db, client, () => NOW, undefined, opts);
    expect(logs.sort()).toEqual(['hadis.attributionUnknown:رواه فلان', 'hadis.gradeUnknown:ضعيف جدا']);
  });

  it('with no shared noter one call still logs each text once, not once per hadis', async () => {
    const db = newDb();
    const { client, fake } = setup();
    for (const id of saved(db, 3)) fake.one.set(id, { ...fixture('one-66512'), id, grade: 'ضعيف جدا' });
    const logs: string[] = [];
    await checkProviderUpdates(db, client, () => NOW, (a, d) => logs.push(`${a}:${d}`), { pauseMs: 0 });
    expect(logs.filter((l) => l.startsWith('hadis.gradeUnknown'))).toHaveLength(1);
  });
});
