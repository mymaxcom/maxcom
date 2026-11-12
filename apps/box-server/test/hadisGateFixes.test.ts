import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { getItem } from '../src/content/store.ts';
import { buildKioskContent } from '../src/kioskContent.ts';
import { getSettings } from '../src/settingsStore.ts';
import { createHadeethEnc } from '../src/hadis/hadeethenc.ts';
import { checkProviderUpdates } from '../src/hadis/updates.ts';
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

interface Ctx { app: FastifyInstance; fake: FakeHadeethEnc; admin: Login; ajk: Login; dir: string }
async function setup(over: Parameters<typeof buildApp>[1] = {}): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'hadis-gate-'));
  dirs.push(dir);
  const fake = fakeHadeethEnc();
  const app = buildApp(join(dir, 'test.db'), { now: () => AT, fetchImpl: fake.fetch, ...over });
  apps.push(app);
  return { app, fake, dir, admin: await loginAs(app, 'admin'), ajk: await loginAs(app, 'ajk') };
}
const post = (c: Ctx, url: string, payload: unknown, as: Login = c.admin) =>
  c.app.inject({ method: 'POST', url, headers: as.headers, payload: payload as never });
const get = (c: Ctx, url: string, as: Login = c.admin) => c.app.inject({ method: 'GET', url, headers: as.headers });
const add = (c: Ctx, id: string) => post(c, '/api/hadis/add', { provider: 'hadeethenc', id });
const client = (fake: FakeHadeethEnc) => createHadeethEnc(fake.fetch, BASE);
const check = (c: Ctx, opts: Parameters<typeof checkProviderUpdates>[4] = {}) =>
  checkProviderUpdates(c.app.surau.db, client(c.fake), () => AT, undefined, { pauseMs: 0, ...opts });
const pool = (c: Ctx): string[] => {
  const s = getSettings(c.app.surau.db);
  const card = { ...s, hadis: { ...s.hadis, changeEvery: 'card' as const } };
  return (buildKioskContent(c.app.surau.db, c.dir, AT, card).hadisToday ?? []).map((h) => h.id);
};
const pendingRows = (c: Ctx): number => Number(c.app.surau.db.prepare('SELECT COUNT(*) AS n FROM hadis_source_updates').get()?.n);

describe('group 1: a downgraded grade leaves the TV at once', () => {
  it('a new dhaif grade hides the item from the TV with no admin; shown stays the person choice; the update stays pending', async () => {
    const c = await setup();
    await add(c, '66512');
    expect(pool(c)).toEqual(['hadeethenc-66512']);
    c.fake.one.set('66512', { ...fixture('one-66512'), grade: 'ضعيف' });
    await check(c);
    const item = getItem(c.app.surau.db, 'hadis', 'hadeethenc-66512')!;
    expect(item.shown).toBe(true);
    expect(item.ext?.blocked).toBe(true);
    expect(item.grade).toBe('sahih');
    expect(pool(c)).toEqual([]);
    expect((await get(c, '/api/hadis/updates')).json().updates).toHaveLength(1);
  });

  it('an unknown new grade hides it the same way', async () => {
    const c = await setup();
    await add(c, '66512');
    c.fake.one.set('66512', { ...fixture('one-66512'), grade: 'ضعيف جدا' });
    await check(c);
    expect(getItem(c.app.surau.db, 'hadis', 'hadeethenc-66512')?.ext?.blocked).toBe(true);
    expect(pool(c)).toEqual([]);
  });

  it('a text-only change stays pending and the item keeps showing', async () => {
    const c = await setup();
    await add(c, '66512');
    c.fake.one.set('66512', { ...fixture('one-66512'), hadeeth: `${String(fixture('one-66512').hadeeth)} Tambahan.` });
    await check(c);
    const item = getItem(c.app.surau.db, 'hadis', 'hadeethenc-66512')!;
    expect(item.ext?.blocked).toBeUndefined();
    expect(pool(c)).toEqual(['hadeethenc-66512']);
    expect((await get(c, '/api/hadis/updates')).json().updates).toHaveLength(1);
  });

  it('the grade recovering (source back to what is saved) clears the flag and the item shows again', async () => {
    const c = await setup();
    await add(c, '66512');
    c.fake.one.set('66512', { ...fixture('one-66512'), grade: 'ضعيف' });
    await check(c);
    expect(pool(c)).toEqual([]);
    c.fake.one.set('66512', fixture('one-66512'));
    await check(c);
    expect(getItem(c.app.surau.db, 'hadis', 'hadeethenc-66512')?.ext?.blocked).toBeUndefined();
    expect(pool(c)).toEqual(['hadeethenc-66512']);
    expect((await get(c, '/api/hadis/updates')).json().updates).toEqual([]);
  });

  it('a flagged item whose new grade is savable again but with new text is unflagged and the text waits', async () => {
    const c = await setup();
    await add(c, '66512');
    c.fake.one.set('66512', { ...fixture('one-66512'), grade: 'ضعيف' });
    await check(c);
    c.fake.one.set('66512', { ...fixture('one-66512'), grade: 'حسن', hadeeth: `${String(fixture('one-66512').hadeeth)} Lain.` });
    await check(c);
    expect(getItem(c.app.surau.db, 'hadis', 'hadeethenc-66512')?.ext?.blocked).toBeUndefined();
    expect(pool(c)).toEqual(['hadeethenc-66512']);
  });

  it('accepting the update clears the flag: a blocked grade then stays hidden by shown:false', async () => {
    const c = await setup();
    await add(c, '66512');
    c.fake.one.set('66512', { ...fixture('one-66512'), grade: 'ضعيف' });
    await check(c);
    const acc = await post(c, '/api/hadis/hadeethenc-66512/accept-update', {});
    expect(acc.statusCode).toBe(200);
    expect(acc.json().gradeBlocked).toBe(true);
    const item = getItem(c.app.surau.db, 'hadis', 'hadeethenc-66512')!;
    expect(item.ext?.blocked).toBeUndefined();
    expect(item).toMatchObject({ shown: false, grade: 'dhaif' });
    expect(pool(c)).toEqual([]);
  });

  it('the flag announces the change once (bus callback) and a repeat check changes nothing', async () => {
    const c = await setup();
    await add(c, '66512');
    const seen: number[] = [];
    c.fake.one.set('66512', { ...fixture('one-66512'), grade: 'ضعيف' });
    await check(c, { onChange: () => seen.push(1) });
    expect(seen).toHaveLength(1);
    await check(c, { onChange: () => seen.push(1) });
    expect(seen).toHaveLength(1);
  });

  it('an update whose new text is too long is not stored as a pending row nobody can accept', async () => {
    const c = await setup();
    await add(c, '66512');
    c.fake.one.set('66512', { ...fixture('one-66512'), hadeeth: 'a'.repeat(2001), hadeeth_intro: null });
    await check(c);
    expect((await get(c, '/api/hadis/updates')).json().updates).toEqual([]);
    expect(pendingRows(c)).toBe(0);
    expect(pool(c)).toEqual(['hadeethenc-66512']);
  });

  it('accepting a pending row that is too long drops the row and answers a typed BM error', async () => {
    const c = await setup();
    await add(c, '66512');
    c.app.surau.db.prepare(
      "INSERT INTO hadis_source_updates (item_id, provider, provider_id, new_json, found_at) VALUES (?, 'hadeethenc', '66512', ?, ?)",
    ).run('hadeethenc-66512', '66512-placeholder', AT.toISOString());
    c.app.surau.db.prepare('UPDATE hadis_source_updates SET new_json = ? WHERE item_id = ?').run(JSON.stringify({
      title: 't', textMs: 'a'.repeat(2001), intro: null, textAr: 'ar', attributionAr: 'رواه مسلم', gradeAr: 'صحيح', categories: [],
      digest: 'b'.repeat(64), fetchedAt: AT.toISOString(),
    }), 'hadeethenc-66512');
    const acc = await post(c, '/api/hadis/hadeethenc-66512/accept-update', {});
    expect(acc.statusCode).toBe(400);
    expect(acc.json().code).toBe('too_long');
    expect(acc.json().errors[0]).toMatch(/terlalu panjang/);
    expect(pendingRows(c)).toBe(0);
    expect(getItem(c.app.surau.db, 'hadis', 'hadeethenc-66512')).not.toBeNull();
  });
});
