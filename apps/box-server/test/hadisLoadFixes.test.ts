import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { getItem, putItem } from '../src/content/store.ts';
import { itemsInCategory, search, upsertCategories, upsertHadith } from '../src/hadis/catalog.ts';
import type { HeHadith } from '../src/hadis/hadeethenc.ts';
import { createLimiter } from '../src/hadis/limiter.ts';
import { getVersion } from '../src/settingsStore.ts';
import { loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { buildCloud } from './support/fakeCloud.ts';
import { fakeHadeethEnc, fixture } from './support/fakeHadeethEnc.ts';
import type { FakeHadeethEnc } from './support/fakeHadeethEnc.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dbs.splice(0)) {
    try {
      d.close();
    } catch {
      // closed
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const AT = new Date('2026-11-09T01:00:00.000Z');

interface Ctx { app: FastifyInstance; fake: FakeHadeethEnc; admin: Login; media: Login }
async function setup(): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'hadis-load-'));
  dirs.push(dir);
  const fake = fakeHadeethEnc();
  const app = buildApp(join(dir, 'test.db'), { now: () => AT, fetchImpl: fake.fetch });
  apps.push(app);
  return { app, fake, admin: await loginAs(app, 'admin'), media: await loginAs(app, 'media') };
}
const get = (c: Ctx, url: string, as: Login = c.admin) => c.app.inject({ method: 'GET', url, headers: as.headers });
const add = (c: Ctx, id: string, as: Login = c.admin) =>
  c.app.inject({ method: 'POST', url: '/api/hadis/add', headers: as.headers, payload: { provider: 'hadeethenc', id } });
const put = (c: Ctx, ids: string[]) =>
  c.app.inject({ method: 'PUT', url: '/api/hadis/order', headers: c.admin.headers, payload: { ids } });

function newDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'hadis-load-db-'));
  dirs.push(dir);
  const db = openDb(join(dir, 'test.db'));
  dbs.push(db);
  return db;
}
const hadith = (id: string, over: Partial<HeHadith> = {}): HeHadith => ({
  id, title: `Tajuk ${id}`, textMs: `Teks ${id}`, introMs: null, textAr: 'نص', introAr: null,
  attributionAr: 'رواه مسلم', gradeAr: 'صحيح', categories: ['59'], digest: 'd'.repeat(64), ...over,
});

describe('group 3: the limiter', () => {
  it('lets max through per window per key and answers when to retry; a new window starts clean', () => {
    let t = 1000;
    const lim = createLimiter({ max: 3, windowMs: 60_000, now: () => t });
    expect([1, 2, 3].map(() => lim.hit('a').ok)).toEqual([true, true, true]);
    const over = lim.hit('a');
    if (over.ok) throw new Error('should be limited');
    expect(over.retryAfterSec).toBeGreaterThan(0);
    expect(over.retryAfterSec).toBeLessThanOrEqual(60);
    expect(lim.hit('b').ok).toBe(true);
    t += 60_001;
    expect(lim.hit('a').ok).toBe(true);
  });

  it('forgets idle keys so the map does not grow for ever', () => {
    let t = 0;
    const lim = createLimiter({ max: 1, windowMs: 1000, now: () => t });
    for (let i = 0; i < 5000; i++) lim.hit(`k${i}`);
    t += 5000;
    lim.hit('fresh');
    expect(lim.size()).toBeLessThan(10);
  });
});

describe('group 3: /api/hadis/* is limited per actor', () => {
  it('the 21st browse request in a minute is 429 with a BM message; another user is unaffected; the first 20 were fine', async () => {
    const c = await setup();
    const codes: number[] = [];
    for (let i = 0; i < 20; i++) codes.push((await get(c, '/api/hadis/search?q=amalan')).statusCode);
    expect(new Set(codes)).toEqual(new Set([200]));
    const over = await get(c, '/api/hadis/search?q=amalan');
    expect(over.statusCode).toBe(429);
    expect(over.json().code).toBe('rate_limited');
    expect(over.json().errors[0]).toMatch(/Terlalu banyak/);
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    expect((await get(c, '/api/hadis/search?q=amalan', c.media)).statusCode).toBe(200);
  });

  it('polling a job once a second is not choked by the browse limit', async () => {
    const c = await setup();
    for (let i = 0; i < 20; i++) await get(c, '/api/hadis/search?q=amalan');
    for (let i = 0; i < 40; i++) expect((await get(c, '/api/hadis/status')).statusCode).toBe(200);
  });

  it('at most 2 provider fetches run at once: the third is 429 busy, and works when one finishes', async () => {
    const c = await setup();
    c.fake.one.set('66514', { ...fixture('one-66512'), id: '66514' });
    let release!: () => void;
    c.fake.hold = new Promise<void>((r) => { release = r; });
    const a = get(c, '/api/hadis/hadeethenc/66512');
    const b = get(c, '/api/hadis/hadeethenc/66513');
    await new Promise((r) => setTimeout(r, 30));
    const third = await get(c, '/api/hadis/hadeethenc/66514');
    expect(third.statusCode).toBe(429);
    expect(third.json().code).toBe('busy');
    release();
    expect([(await a).statusCode, (await b).statusCode]).toEqual([200, 200]);
    c.fake.hold = null;
    expect((await get(c, '/api/hadis/hadeethenc/66514')).statusCode).toBe(200);
  });

  it('a failed provider fetch gives its slot back', async () => {
    const c = await setup();
    c.fake.offline = true;
    for (let i = 0; i < 4; i++) expect((await get(c, '/api/hadis/hadeethenc/66512')).statusCode).toBe(503);
    c.fake.offline = false;
    expect((await get(c, '/api/hadis/hadeethenc/66512')).statusCode).toBe(200);
  });
});

describe('group 3: the cloud has no /api/hadis', () => {
  it('every route answers 404 on the cloud role, for an admin; the same route works on a box', async () => {
    const cloud = buildCloud('a1b2c3d4e5f60718');
    try {
      const admin = await loginAs(cloud.app, 'admin');
      for (const [method, url] of [
        ['GET', '/api/hadis/status'], ['GET', '/api/hadis/categories'], ['GET', '/api/hadis/search?q=amalan'],
        ['GET', '/api/hadis/updates'], ['POST', '/api/hadis/refresh'], ['PUT', '/api/hadis/order'], ['POST', '/api/hadis/add'],
        ['GET', '/api/hadis/jobs/j1'], ['GET', '/api/hadis/hadeethenc/66512'], ['POST', '/api/hadis/x/accept-update'],
      ] as const) {
        const r = await cloud.app.inject({ method, url, headers: admin.headers, payload: method === 'GET' ? undefined : ({} as never) });
        expect(r.statusCode, `${method} ${url}`).toBe(404);
      }
    } finally {
      await cloud.close();
    }
    const c = await setup();
    expect((await get(c, '/api/hadis/status')).statusCode).toBe(200);
  });
});

describe('group 3: browsing pages in SQL', () => {
  /** Rows the catalog statements hand back to JS. */
  function countRows(db: DatabaseSync): { loaded: () => number } {
    let loaded = 0;
    const orig = db.prepare.bind(db);
    (db as { prepare: unknown }).prepare = (sql: string) => {
      const st = orig(sql);
      if (/hadis_catalog(?!_)/.test(sql) && !/COUNT\(/i.test(sql)) {
        const all = st.all.bind(st);
        (st as { all: unknown }).all = (...a: unknown[]) => {
          const r = (all as (...x: unknown[]) => unknown[])(...a);
          loaded += r.length;
          return r;
        };
      }
      return st;
    };
    return { loaded: () => loaded };
  }

  function seed(db: DatabaseSync, n: number): void {
    upsertCategories(db, [
      { id: '1', parentId: null, titleEn: 'Root', count: n },
      { id: '8', parentId: '1', titleEn: 'A', count: n },
      { id: '9', parentId: '1', titleEn: 'B', count: n },
      { id: '70', parentId: null, titleEn: 'Other', count: 1 },
    ], AT.toISOString());
    db.exec('BEGIN');
    for (let i = 1; i <= n; i++) {
      upsertHadith(db, hadith(String(i), { title: i % 7 === 0 ? `Amalan ${i}` : `Tajuk ${i}`, textMs: i % 5 === 0 ? `niat dan amalan ${i}` : `Teks ${i}`, categories: i % 2 ? ['8'] : ['9'] }), AT.toISOString());
    }
    upsertHadith(db, hadith('9999', { categories: ['8', '9'] }), AT.toISOString());
    upsertHadith(db, hadith('9998', { categories: ['70'] }), AT.toISOString());
    db.exec('COMMIT');
  }

  it('a page of a category reads one page, in id order, and counts a hadith in two sub-categories once', () => {
    const db = newDb();
    seed(db, 1000);
    const probe = countRows(db);
    const r = itemsInCategory(db, '1', 3, 30);
    expect(r.total).toBe(1001);
    expect(r.items).toHaveLength(30);
    expect(r.items.map((h) => h.id)).toEqual(Array.from({ length: 30 }, (_, i) => String(61 + i)));
    expect(probe.loaded()).toBeLessThanOrEqual(30);
    const last = itemsInCategory(db, '1', 34, 30);
    expect(last.items.map((h) => h.id)).toEqual([...Array.from({ length: 10 }, (_, i) => String(991 + i)), '9999']);
    expect(itemsInCategory(db, '70', 1, 10)).toMatchObject({ total: 1, items: [{ id: '9998' }] });
    expect(itemsInCategory(db, '123', 1, 10)).toEqual({ items: [], total: 0 });
  });

  it('a search reads at most its limit and still puts title hits first', () => {
    const db = newDb();
    seed(db, 1500);
    const probe = countRows(db);
    const hits = search(db, 'amalan', 50);
    expect(hits).toHaveLength(50);
    expect(probe.loaded()).toBeLessThanOrEqual(50);
    // titles with "Amalan" come first (7, 14, ...), in id order, then the text hits
    expect(hits.slice(0, 3).map((h) => h.id)).toEqual(['7', '14', '21']);
    expect(hits.every((h) => /amalan/i.test(`${h.title} ${h.textMs}`))).toBe(true);
    const all = search(db, 'amalan', 5000);
    const titleHits = all.filter((h) => /amalan/i.test(h.title));
    expect(all.slice(0, titleHits.length)).toEqual(titleHits);
  });

  it('upserting a hadith again moves it between categories instead of keeping the old link', () => {
    const db = newDb();
    upsertCategories(db, [{ id: '8', parentId: null, titleEn: 'A', count: 1 }, { id: '9', parentId: null, titleEn: 'B', count: 1 }], AT.toISOString());
    upsertHadith(db, hadith('1', { categories: ['8'] }), AT.toISOString());
    expect(itemsInCategory(db, '8', 1, 10).total).toBe(1);
    upsertHadith(db, hadith('1', { categories: ['9'] }), AT.toISOString());
    expect(itemsInCategory(db, '8', 1, 10).total).toBe(0);
    expect(itemsInCategory(db, '9', 1, 10).total).toBe(1);
  });
});

describe('group 3: PUT /api/hadis/order', () => {
  const seedItems = async (c: Ctx): Promise<void> => {
    for (const id of ['66512', '66513']) await add(c, id);
    putItem(c.app.surau.db, 'hadis', { id: 'own-a', textMs: 'Sendiri', source: 'Riwayat Muslim', order: 9000 }, 'test');
  };
  const rows = (c: Ctx): number => Number(c.app.surau.db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'content:hadis'").get()?.n);

  it('a list that leaves a live hadis out is 409 and changes nothing', async () => {
    const c = await setup();
    await seedItems(c);
    const before = rows(c);
    const r = await put(c, ['hadeethenc-66513', 'hadeethenc-66512']);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('order_stale');
    expect(r.json().errors[0]).toMatch(/senarai/i);
    expect(rows(c)).toBe(before);
    expect(getItem(c.app.surau.db, 'hadis', 'hadeethenc-66512')?.order).toBe(1000);
  });

  it('the full set renumbers; rows whose order did not change are not written', async () => {
    const c = await setup();
    await seedItems(c);
    // current orders: 66512=1000, 66513=2000, own-a=9000. New list keeps 66512 first.
    const before = rows(c);
    const v = getVersion(c.app.surau.db);
    const r = await put(c, ['hadeethenc-66512', 'own-a', 'hadeethenc-66513']);
    expect(r.statusCode).toBe(200);
    expect(r.json().count).toBe(3);
    expect(rows(c) - before).toBe(2); // 66512 stays at 1000
    expect(getVersion(c.app.surau.db)).toBeGreaterThan(v);
    const again = await put(c, ['hadeethenc-66512', 'own-a', 'hadeethenc-66513']);
    expect(again.statusCode).toBe(200);
    expect(rows(c) - before).toBe(2);
    expect(getVersion(c.app.surau.db)).toBeGreaterThan(v);
    const v2 = getVersion(c.app.surau.db);
    await put(c, ['hadeethenc-66512', 'own-a', 'hadeethenc-66513']);
    expect(getVersion(c.app.surau.db)).toBe(v2);
  });

  it('a deleted hadis is not part of the set', async () => {
    const c = await setup();
    await seedItems(c);
    expect((await c.app.inject({ method: 'DELETE', url: '/api/content/hadis/own-a', headers: c.admin.headers })).statusCode).toBe(204);
    expect((await put(c, ['hadeethenc-66513', 'hadeethenc-66512'])).statusCode).toBe(200);
  });
});
