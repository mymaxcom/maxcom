import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { getItem, putItem, putProviderItem } from '../src/content/store.ts';
import { stateGet, upsertCategories, upsertHadith } from '../src/hadis/catalog.ts';
import { createCatalogJob } from '../src/hadis/catalogJob.ts';
import { createHadeethEnc } from '../src/hadis/hadeethenc.ts';
import { checkProviderUpdates, startHadisTimers } from '../src/hadis/updates.ts';
import { getVersion } from '../src/settingsStore.ts';
import { loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { fakeHadeethEnc, fixture } from './support/fakeHadeethEnc.ts';
import type { FakeHadeethEnc } from './support/fakeHadeethEnc.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const a of apps.splice(0)) {
    try {
      await a.close();
    } catch {
      // closed
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BASE = 'https://hadeethenc.com/api/v1';
const AT = new Date('2026-11-09T01:00:00.000Z');

interface Ctx { app: FastifyInstance; fake: FakeHadeethEnc; admin: Login; ajk: Login; media: Login }
async function setup(over: Parameters<typeof buildApp>[1] = {}): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'hadis-routes-'));
  dirs.push(dir);
  const fake = fakeHadeethEnc();
  const app = buildApp(join(dir, 'test.db'), { now: () => AT, fetchImpl: fake.fetch, ...over });
  apps.push(app);
  return { app, fake, admin: await loginAs(app, 'admin'), ajk: await loginAs(app, 'ajk'), media: await loginAs(app, 'media') };
}
const post = (c: Ctx, url: string, payload: unknown, as: Login = c.admin) =>
  c.app.inject({ method: 'POST', url, headers: as.headers, payload: payload as never });
const get = (c: Ctx, url: string, as: Login = c.admin) => c.app.inject({ method: 'GET', url, headers: as.headers });
const add = (c: Ctx, id: string, as: Login = c.admin) => post(c, '/api/hadis/add', { provider: 'hadeethenc', id }, as);
const ones = (c: Ctx) => c.fake.calls.filter((u) => u.includes('/hadeeths/one/')).length;

describe('POST /api/hadis/add', () => {
  it('saves a hadis from HadeethEnc: 201, deterministic id, BM attribution, grade, intro, kiosk version bumped', async () => {
    const c = await setup();
    const before = getVersion(c.app.surau.db);
    const r = await add(c, '66512');
    expect(r.statusCode).toBe(201);
    const item = r.json().item;
    expect(item).toMatchObject({
      id: 'hadeethenc-66512', source: 'Muttafaq alaih', grade: 'sahih', shown: true, order: 1000,
      ext: { provider: 'hadeethenc', id: '66512', attributionAr: 'رواه البخاري ومسلم', gradeAr: 'صحيح', fetchedAt: AT.toISOString() },
    });
    expect(item.intro).toMatch(/bersabda:$/);
    expect(item.textMs.startsWith(item.intro)).toBe(true);
    expect(item.ext.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(item)).not.toContain('PENJELASAN');
    expect(getVersion(c.app.surau.db)).toBeGreaterThan(before);
    expect(getItem(c.app.surau.db, 'hadis', 'hadeethenc-66512')?.textMs).toBe(item.textMs);
    expect(c.fake.calls[0]).toBe(`${BASE}/hadeeths/one/?language=ms&id=66512`);
  });

  it('adding the same hadis again is 200 with the same row and makes no second request', async () => {
    const c = await setup();
    await add(c, '66512');
    const calls = c.fake.calls.length;
    const again = await add(c, '66512');
    expect(again.statusCode).toBe(200);
    expect(again.json().item.id).toBe('hadeethenc-66512');
    expect(c.fake.calls.length).toBe(calls);
    expect((await get(c, '/api/content/hadis')).json().items).toHaveLength(1);
  });

  it('the next hadis gets order +1000', async () => {
    const c = await setup();
    await add(c, '66512');
    const r = await add(c, '66513');
    expect(r.json().item.order).toBe(2000);
  });

  it('refuses dhaif, maudhu and an unmapped grade with 400 grade_blocked and saves nothing', async () => {
    const c = await setup();
    for (const [id, gradeAr] of [['66599', 'ضعيف'], ['66598', 'موضوع'], ['66597', 'ضعيف جدا']] as const) {
      c.fake.one.set(id, { ...fixture('one-66512'), id, grade: gradeAr });
      const r = await add(c, id);
      expect(r.statusCode, gradeAr).toBe(400);
      expect(r.json().code).toBe('grade_blocked');
      expect(getItem(c.app.surau.db, 'hadis', `hadeethenc-${id}`)).toBeNull();
    }
  });

  it('refuses a text of 2001 characters with too_long and accepts exactly 2000', async () => {
    const c = await setup();
    c.fake.one.set('70001', { ...fixture('one-66512'), id: '70001', hadeeth: 'a'.repeat(2001), hadeeth_intro: null });
    const r = await add(c, '70001');
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('too_long');
    c.fake.one.set('70002', { ...fixture('one-66512'), id: '70002', hadeeth: 'a'.repeat(2000), hadeeth_intro: null });
    expect((await add(c, '70002')).statusCode).toBe(201);
  });

  it('the 501st saved hadis is 409 limit_reached, before any request', async () => {
    const c = await setup();
    const { db } = c.app.surau;
    for (let i = 0; i < 500; i++) putItem(db, 'hadis', { id: `own-${i}`, textMs: `Teks ${i}`, source: 'Riwayat Muslim' }, 'test');
    const r = await add(c, '66512');
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('limit_reached');
    expect(c.fake.calls).toEqual([]);
    expect(getItem(db, 'hadis', 'hadeethenc-66512')).toBeNull();
  });

  it('HadeethEnc down or offline is 503 and no row; a broken answer is 502', async () => {
    const c = await setup();
    c.fake.one.set('66512', 500);
    expect((await add(c, '66512')).statusCode).toBe(503);
    c.fake.offline = true;
    const off = await add(c, '66513');
    expect(off.statusCode).toBe(503);
    expect(off.json().code).toBe('source_unavailable');
    c.fake.offline = false;
    c.fake.one.set('66514', { ...fixture('one-66512'), id: '66514', hadeeth: 5 });
    expect((await add(c, '66514')).statusCode).toBe(502);
    expect(getItem(c.app.surau.db, 'hadis', 'hadeethenc-66512')).toBeNull();
    expect((await get(c, '/api/content/hadis')).json().items).toEqual([]);
  });

  it('validates the body: ids that are not digits, extra keys, another provider, a big body; no request leaves the box', async () => {
    const c = await setup();
    for (const body of [
      { provider: 'hadeethenc', id: '../x' }, { provider: 'hadeethenc', id: '1/2' }, { provider: 'hadeethenc', id: '123456789' },
      { provider: 'hadeethenc', id: 66512 }, { provider: 'hadeethenc', id: '' }, { provider: 'myhadith', id: '1' },
      { id: '1' }, { provider: 'hadeethenc', id: '1', extra: true }, { provider: 'hadeethenc', id: '1', url: 'https://evil.example' }, [], 'x', null,
    ]) {
      const r = await post(c, '/api/hadis/add', body);
      // a body that is not JSON at all is refused by the parser (415), the rest by the route (400)
      expect([400, 415], JSON.stringify(body)).toContain(r.statusCode);
    }
    expect((await post(c, '/api/hadis/add', { provider: 'hadeethenc', id: '../x' })).statusCode).toBe(400);
    const big = await c.app.inject({ method: 'POST', url: '/api/hadis/add', headers: c.admin.headers, payload: { provider: 'hadeethenc', id: '1', pad: 'x'.repeat(2000) } });
    expect(big.statusCode).toBe(413);
    expect(c.fake.calls).toEqual([]);
  });

  it('needs content:write: an AJK is 403, the media role may add', async () => {
    const c = await setup();
    expect((await add(c, '66512', c.ajk)).statusCode).toBe(403);
    expect(c.fake.calls).toEqual([]);
    expect((await add(c, '66512', c.media)).statusCode).toBe(201);
  });
});

describe('the content route cannot change what HadeethEnc served', () => {
  it('shown and order change; textMs, a forged ext and a provider id without ext are 400', async () => {
    const c = await setup();
    const item = (await add(c, '66512')).json().item;
    const put = (body: unknown, id = 'hadeethenc-66512') =>
      c.app.inject({ method: 'PUT', url: `/api/content/hadis/${id}`, headers: c.admin.headers, payload: body as never });
    const { id: _id, updatedAt: _u, updatedBy: _b, ...fields } = item;
    const off = await put({ ...fields, shown: false });
    expect(off.statusCode).toBe(200);
    expect(off.json().item.shown).toBe(false);
    expect((await put({ ...fields, textMs: 'Kata yang direka.' })).statusCode).toBe(400);
    expect((await put({ ...fields, grade: 'hasan' })).statusCode).toBe(400);
    expect((await put({ ...fields, ext: undefined })).statusCode).toBe(400);
    expect((await put(fields, 'forged-id')).statusCode).toBe(400);
    expect((await put({ textMs: 'x', source: 'y' }, 'hadeethenc-12')).statusCode).toBe(400);
    expect(getItem(c.app.surau.db, 'hadis', 'hadeethenc-66512')).toMatchObject({ shown: false, textMs: item.textMs });
    // Buang is a normal delete
    expect((await c.app.inject({ method: 'DELETE', url: '/api/content/hadis/hadeethenc-66512', headers: c.admin.headers })).statusCode).toBe(204);
    // and the hadis can be added again
    expect((await add(c, '66512')).statusCode).toBe(201);
  });
});

describe('PUT /api/hadis/order', () => {
  it('renumbers by 1000 in one step and writes one change row per item whose order changed', async () => {
    const c = await setup();
    for (const id of ['66512', '66513']) await add(c, id);
    putItem(c.app.surau.db, 'hadis', { id: 'own-a', textMs: 'Sendiri', source: 'Riwayat Muslim', order: 9000 }, 'test');
    const rows = () => Number(c.app.surau.db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'content:hadis'").get()?.n);
    const before = rows();
    const v = getVersion(c.app.surau.db);
    const r = await c.app.inject({ method: 'PUT', url: '/api/hadis/order', headers: c.admin.headers, payload: { ids: ['own-a', 'hadeethenc-66513', 'hadeethenc-66512'] } });
    expect(r.statusCode).toBe(200);
    expect(rows() - before).toBe(2); // hadeethenc-66513 was already at 2000
    expect(getVersion(c.app.surau.db)).toBeGreaterThan(v);
    const items = (await get(c, '/api/content/hadis')).json().items as { id: string; order: number }[];
    expect(Object.fromEntries(items.map((i) => [i.id, i.order]))).toEqual({ 'own-a': 1000, 'hadeethenc-66513': 2000, 'hadeethenc-66512': 3000 });
  });

  it('refuses a bad list and an unknown id, changing nothing', async () => {
    const c = await setup();
    await add(c, '66512');
    const put = (payload: unknown) => c.app.inject({ method: 'PUT', url: '/api/hadis/order', headers: c.admin.headers, payload: payload as never });
    for (const body of [{}, { ids: [] }, { ids: 'x' }, { ids: [1] }, { ids: ['../x'] }, { ids: ['a', 'a'] }, { ids: ['hadeethenc-66512', 'nope'] }, { ids: ['hadeethenc-66512'], x: 1 }, []]) {
      expect((await put(body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(getItem(c.app.surau.db, 'hadis', 'hadeethenc-66512')?.order).toBe(1000);
    expect((await c.app.inject({ method: 'PUT', url: '/api/hadis/order', headers: c.ajk.headers, payload: { ids: ['hadeethenc-66512'] } })).statusCode).toBe(403);
  });
});

describe('browse and search the local catalog', () => {
  it('GET categories gives BM names, items and search page through the catalog; search validates q', async () => {
    const c = await setup();
    const { db } = c.app.surau;
    upsertCategories(db, [
      { id: '1', parentId: null, titleEn: "The Noble Qur'an and Qur'anic Sciences", count: 9 },
      { id: '8', parentId: '1', titleEn: 'Revelation', count: 1 },
    ], AT.toISOString());
    await add(c, '66512'); // the add also refreshes the catalog row; the rows below replace it
    const h = (id: string, title: string, textMs: string, cats: string[]) => ({
      id, title, textMs, introMs: null, textAr: 'نص', introAr: null, attributionAr: 'رواه مسلم', gradeAr: 'صحيح', categories: cats, digest: 'a'.repeat(64),
    });
    upsertHadith(db, h('66512', 'Islam itu dibina', 'Rukun solat', ['8']), AT.toISOString());
    upsertHadith(db, h('66513', 'Kejadian manusia', 'Amalan ahli syurga', ['8']), AT.toISOString());
    upsertHadith(db, h('66514', 'Amalan yang baik', 'Niat', ['8']), AT.toISOString());
    upsertHadith(db, { ...h('66515', 'Hadis lemah', 'Teks lemah', ['8']), gradeAr: 'ضعيف' }, AT.toISOString());

    const cats = (await get(c, '/api/hadis/categories')).json().categories as { id: string; titleMs: string }[];
    expect(cats.find((x) => x.id === '1')?.titleMs).toBe('Al-Quran dan Ulum Al-Quran');

    const items = (await get(c, '/api/hadis/categories/1/items?page=1&perPage=10')).json();
    expect(items.total).toBe(4);
    expect(items.items.map((x: { id: string }) => x.id)).toEqual(['66512', '66513', '66514', '66515']);
    expect(items.items[0]).toMatchObject({ saved: true, allowed: true, grade: 'sahih', length: 'short', attribution: { short: 'Riwayat Muslim', long: null } });
    expect(items.items[3]).toMatchObject({ allowed: false, grade: 'dhaif', saved: false });

    const found = (await get(c, '/api/hadis/search?q=amalan')).json().items as { id: string }[];
    expect(found.map((x) => x.id)).toEqual(['66514', '66513']);
    expect((await get(c, '/api/hadis/search?q=a')).statusCode).toBe(400);
    expect((await get(c, '/api/hadis/search')).statusCode).toBe(400);
    expect((await get(c, `/api/hadis/search?q=${'x'.repeat(81)}`)).statusCode).toBe(400);
    expect((await get(c, '/api/hadis/search?q=ab&q=cd')).statusCode).toBe(400);
    expect((await get(c, '/api/hadis/categories/x/items')).statusCode).toBe(400);
    expect((await get(c, '/api/hadis/categories/1/items?page=51')).statusCode).toBe(400);
    expect((await get(c, '/api/hadis/categories/1/items?perPage=9')).statusCode).toBe(400);
    expect((await get(c, '/api/hadis/search?q=amalan', c.ajk)).statusCode).toBe(403);
    expect(c.fake.calls.filter((u) => !u.includes('/hadeeths/one/'))).toEqual([]);
  });

  it('GET hadeethenc/:id serves the catalog row, else one live call that fills the catalog', async () => {
    const c = await setup();
    const r1 = await get(c, '/api/hadis/hadeethenc/66512');
    expect(r1.statusCode).toBe(200);
    expect(r1.json().hadith).toMatchObject({ id: '66512', grade: 'sahih', saved: false, savedItemId: null, allowed: true, length: 'medium' });
    expect(r1.json().hadith.digest).toBeUndefined();
    expect(ones(c)).toBe(1);
    await get(c, '/api/hadis/hadeethenc/66512');
    expect(ones(c)).toBe(1);
    await add(c, '66512');
    expect((await get(c, '/api/hadis/hadeethenc/66512')).json().hadith).toMatchObject({ saved: true, savedItemId: 'hadeethenc-66512' });
    expect((await get(c, '/api/hadis/hadeethenc/..%2Fx')).statusCode).toBe(400);
    expect((await get(c, '/api/hadis/hadeethenc/abc')).statusCode).toBe(400);
    c.fake.offline = true;
    expect((await get(c, '/api/hadis/hadeethenc/66513')).statusCode).toBe(503);
  });
});

describe('status, refresh and jobs', () => {
  it('status reports online by one probe per minute, the catalog and the saved count', async () => {
    const c = await setup();
    await add(c, '66512');
    const s = (await get(c, '/api/hadis/status', c.ajk)).json();
    expect(s).toMatchObject({ online: true, saved: 1, max: 500, updates: 0, catalog: { entries: 1, categories: 0, job: null } });
    await get(c, '/api/hadis/status');
    expect(c.fake.calls.filter((u) => u.endsWith('/languages')).length).toBe(1);
  });

  it('offline: status says so, and does not probe again within a minute', async () => {
    const c = await setup();
    c.fake.offline = true;
    expect((await get(c, '/api/hadis/status')).json().online).toBe(false);
    await get(c, '/api/hadis/status');
    expect(c.fake.calls.filter((u) => u.endsWith('/languages')).length).toBe(1);
  });

  it('refresh needs islamic:fetch, starts one job, answers 409 while it runs, and the job can be read', async () => {
    const c = await setup();
    expect((await post(c, '/api/hadis/refresh', {}, c.ajk)).statusCode).toBe(403);
    expect((await post(c, '/api/hadis/refresh', {}, c.media)).statusCode).toBe(403);
    let release: () => void = () => undefined;
    c.fake.hold = new Promise<void>((resolve) => { release = resolve; });
    const r = await post(c, '/api/hadis/refresh', {});
    expect(r.statusCode).toBe(202);
    const { jobId } = r.json();
    expect(jobId).toMatch(/^j\d+$/);
    expect((await post(c, '/api/hadis/refresh', {})).statusCode).toBe(409);
    expect((await get(c, `/api/hadis/jobs/${jobId}`)).json().state).toBe('running');
    c.fake.hold = null;
    c.fake.offline = true;
    release();
    for (let i = 0; i < 200 && (await get(c, `/api/hadis/jobs/${jobId}`, c.ajk)).json().state === 'running'; i++) await new Promise((x) => setTimeout(x, 5));
    const job = (await get(c, `/api/hadis/jobs/${jobId}`, c.ajk)).json();
    expect(job.state).toBe('failed');
    expect((await get(c, '/api/hadis/jobs/j999')).statusCode).toBe(404);
    expect((await get(c, '/api/hadis/jobs/x1')).statusCode).toBe(400);
    const log = c.app.surau.db.prepare("SELECT actor FROM change_log WHERE entity = 'hadis.refresh'").all();
    expect(log.length).toBe(1);
  });
});

describe('weekly update check and accept-update', () => {
  const client = (fake: FakeHadeethEnc) => createHadeethEnc(fake.fetch, BASE);

  it('a changed text is flagged, listed, and replaces the old one only on accept', async () => {
    const c = await setup();
    await add(c, '66512');
    const old = getItem(c.app.surau.db, 'hadis', 'hadeethenc-66512')!;
    c.fake.one.set('66512', { ...fixture('one-66512'), hadeeth: `${String(fixture('one-66512').hadeeth)} Tambahan baharu.` });
    const res = await checkProviderUpdates(c.app.surau.db, client(c.fake), () => AT, undefined, { pauseMs: 0 });
    expect(res).toEqual({ checked: 1, changed: 1 });
    expect(stateGet(c.app.surau.db, 'hadeethenc.lastUpdateCheck')).toBe(AT.toISOString());
    // the TV copy is untouched
    expect(getItem(c.app.surau.db, 'hadis', 'hadeethenc-66512')?.textMs).toBe(old.textMs);

    const list = (await get(c, '/api/hadis/updates')).json().updates;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ itemId: 'hadeethenc-66512', providerId: '66512', changed: ['textMs'] });
    expect((await get(c, '/api/hadis/status')).json().updates).toBe(1);

    const v = getVersion(c.app.surau.db);
    const acc = await post(c, '/api/hadis/hadeethenc-66512/accept-update', {});
    expect(acc.statusCode).toBe(200);
    expect(acc.json().gradeBlocked).toBe(false);
    const now = getItem(c.app.surau.db, 'hadis', 'hadeethenc-66512')!;
    expect(now.textMs).toMatch(/Tambahan baharu\.$/);
    expect(now.order).toBe(old.order);
    expect(now.shown).toBe(true);
    expect(now.ext?.digest).not.toBe(old.ext?.digest);
    expect(getVersion(c.app.surau.db)).toBeGreaterThan(v);
    expect((await get(c, '/api/hadis/updates')).json().updates).toEqual([]);
    expect((await post(c, '/api/hadis/hadeethenc-66512/accept-update', {})).statusCode).toBe(404);
  });

  it('an unchanged text clears a stale flag; a hidden item stays hidden after accept', async () => {
    const c = await setup();
    await add(c, '66512');
    c.fake.one.set('66512', { ...fixture('one-66512'), hadeeth: `${String(fixture('one-66512').hadeeth)} X` });
    await checkProviderUpdates(c.app.surau.db, client(c.fake), () => AT, undefined, { pauseMs: 0 });
    const item = getItem(c.app.surau.db, 'hadis', 'hadeethenc-66512')!;
    const { id: _i, updatedAt: _a, updatedBy: _b, ...fields } = item;
    await c.app.inject({ method: 'PUT', url: '/api/content/hadis/hadeethenc-66512', headers: c.admin.headers, payload: { ...fields, shown: false } });
    await post(c, '/api/hadis/hadeethenc-66512/accept-update', {});
    expect(getItem(c.app.surau.db, 'hadis', 'hadeethenc-66512')?.shown).toBe(false);

    c.fake.one.set('66512', { ...fixture('one-66512'), hadeeth: `${String(fixture('one-66512').hadeeth)} Y` });
    await checkProviderUpdates(c.app.surau.db, client(c.fake), () => AT, undefined, { pauseMs: 0 });
    expect(Number(c.app.surau.db.prepare('SELECT COUNT(*) AS n FROM hadis_source_updates').get()?.n)).toBe(1);
    // the source goes back to what is saved
    c.fake.one.set('66512', { ...fixture('one-66512'), hadeeth: `${String(fixture('one-66512').hadeeth)} X` });
    const again = await checkProviderUpdates(c.app.surau.db, client(c.fake), () => AT, undefined, { pauseMs: 0 });
    expect(again.changed).toBe(0);
    expect(Number(c.app.surau.db.prepare('SELECT COUNT(*) AS n FROM hadis_source_updates').get()?.n)).toBe(0);
  });

  it('an update whose grade became dhaif is saved hidden and the answer says gradeBlocked', async () => {
    const c = await setup();
    await add(c, '66512');
    c.fake.one.set('66512', { ...fixture('one-66512'), grade: 'ضعيف' });
    await checkProviderUpdates(c.app.surau.db, client(c.fake), () => AT, undefined, { pauseMs: 0 });
    expect((await get(c, '/api/hadis/updates')).json().updates[0].changed).toEqual(['grade']);
    const acc = await post(c, '/api/hadis/hadeethenc-66512/accept-update', {});
    expect(acc.statusCode).toBe(200);
    expect(acc.json().gradeBlocked).toBe(true);
    expect(getItem(c.app.surau.db, 'hadis', 'hadeethenc-66512')).toMatchObject({ shown: false, grade: 'dhaif' });
  });

  it('accept-update on an item with no pending row or an own item is 404; needs content:write; bad id 400', async () => {
    const c = await setup();
    putItem(c.app.surau.db, 'hadis', { id: 'own-1', textMs: 'x', source: 'y' }, 'test');
    expect((await post(c, '/api/hadis/own-1/accept-update', {})).statusCode).toBe(404);
    expect((await post(c, '/api/hadis/nope/accept-update', {})).statusCode).toBe(404);
    expect((await post(c, '/api/hadis/hadeethenc-1/accept-update', {}, c.ajk)).statusCode).toBe(403);
    expect((await post(c, '/api/hadis/a%20b/accept-update', {})).statusCode).toBe(400);
    expect((await get(c, '/api/hadis/updates', c.ajk)).statusCode).toBe(403);
  });

  it('the check stops after 8 failures in a row and skips a hadis it cannot read', async () => {
    const c = await setup();
    const { db } = c.app.surau;
    const ext = (id: string) => ({
      provider: 'hadeethenc', id, attributionAr: 'رواه مسلم', gradeAr: 'صحيح', categories: [], fetchedAt: AT.toISOString(), digest: 'e'.repeat(64),
    });
    for (let i = 0; i < 12; i++) {
      const id = String(80000 + i);
      putProviderItem(db, { id: `hadeethenc-${id}`, textMs: 'x', source: 'Riwayat Muslim', grade: 'sahih', shown: true, ext: ext(id) }, 'test');
      c.fake.one.set(id, 503);
    }
    const res = await checkProviderUpdates(db, client(c.fake), () => AT, undefined, { pauseMs: 0 });
    expect(res.checked).toBe(0);
    expect(c.fake.calls.filter((u) => u.includes('/hadeeths/one/')).length).toBe(8);
  });
});

describe('timers', () => {
  it('a cloud role starts none; a box starts the catalog refresh after the first delay and not when offline', async () => {
    const c = await setup();
    const { db } = c.app.surau;
    const client = createHadeethEnc(c.fake.fetch, BASE);
    const job = createCatalogJob({ db, client, now: () => AT, sleep: async () => undefined });
    expect(startHadisTimers({ db, role: 'cloud', client, job, now: () => AT })).toBeNull();

    vi.useFakeTimers();
    c.fake.offline = true;
    const stop = startHadisTimers({ db, role: 'box', client, job, now: () => AT, firstMs: 1000, everyMs: 5000, check: { pauseMs: 0 } })!;
    expect(stop).toBeTypeOf('function');
    await vi.advanceTimersByTimeAsync(1100);
    expect(job.current()).toBeNull();
    expect(c.fake.calls.some((u) => u.includes('/categories/list/'))).toBe(false);
    c.fake.offline = false;
    for (const cat of fixture('categories-list') as unknown as { id: string }[]) c.fake.lists.set(cat.id, []);
    await vi.advanceTimersByTimeAsync(5100);
    expect(c.fake.calls.some((u) => u.includes('/categories/list/'))).toBe(true);
    expect(stateGet(db, 'hadeethenc.lastFullRefresh')).toBe(AT.toISOString());
    stop();
    const calls = c.fake.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(c.fake.calls.length).toBe(calls);
  });

  it('buildApp starts no timer unless asked, and the cloud role never does', async () => {
    const c = await setup({ role: 'cloud', hadisTimers: { firstMs: 10 } });
    await new Promise((r) => setTimeout(r, 60));
    expect(c.fake.calls).toEqual([]);
  });
});
