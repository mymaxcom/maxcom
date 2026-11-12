import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeedEntry } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { ContentError, getItem, putItem, putProviderItem } from '../src/content/store.ts';
import { openDb } from '../src/db.ts';
import type { HeHadith } from '../src/hadis/hadeethenc.ts';
import { buildProviderItem } from '../src/hadis/providerItem.ts';
import { applyFeedEntry, applyOp } from '../src/sync/apply.ts';
import type { ApplyCtx, VerifiedOp } from '../src/sync/apply.ts';
import { loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { fakeHadeethEnc, fixture } from './support/fakeHadeethEnc.ts';
import type { FakeHadeethEnc } from './support/fakeHadeethEnc.ts';

const dbs: DatabaseSync[] = [];
const dirs: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
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
function newDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hadis-trust-'));
  dirs.push(dir);
  const db = openDb(join(dir, 'test.db'));
  dbs.push(db);
  return { db, dir };
}

const EXT = {
  provider: 'hadeethenc', id: '66512', attributionAr: 'رواه البخاري ومسلم', gradeAr: 'صحيح', categories: ['59'],
  fetchedAt: '2026-11-09T01:00:00.000Z', digest: 'a'.repeat(64),
};
const provider = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'hadeethenc-66512', textMs: 'Islam itu dibina atas lima perkara.', textAr: 'بني الإسلام', source: 'Muttafaq alaih',
  title: 'Islam itu', intro: 'Daripada Ibnu Umar:', grade: 'sahih', shown: true, order: 1000, ext: EXT, ...over,
});
const stored = (db: DatabaseSync) => getItem(db, 'hadis', 'hadeethenc-66512');
const trusted = { trusted: true };

describe('group 5: the trusted (replication) path still checks a provider hadis', () => {
  it('refuses an id that is not the provider id of its ext, and a grade that does not match ext.gradeAr', () => {
    const { db } = newDb();
    expect(() => putItem(db, 'hadis', provider({ id: 'hadeethenc-999' }), 'a', trusted)).toThrow(ContentError);
    expect(getItem(db, 'hadis', 'hadeethenc-999')).toBeNull();
    expect(() => putItem(db, 'hadis', provider({ id: 'own-looks-ok' }), 'a', trusted)).toThrow(ContentError);
    expect(() => putItem(db, 'hadis', provider({ grade: 'hasan' }), 'a', trusted)).toThrow(ContentError);
    expect(() => putItem(db, 'hadis', provider({ grade: undefined }), 'a', trusted)).toThrow(ContentError);
    expect(stored(db)).toBeNull();
  });

  it('accepts a consistent item: known grade, a blocked grade, and an unknown grade with no grade chip', () => {
    const { db } = newDb();
    expect(putItem(db, 'hadis', provider(), 'a', trusted).created).toBe(true);
    expect(putItem(db, 'hadis', provider({ grade: 'dhaif', shown: false, ext: { ...EXT, gradeAr: 'ضعيف' } }), 'a', trusted).item.grade).toBe('dhaif');
    expect(putItem(db, 'hadis', provider({ grade: undefined, shown: false, ext: { ...EXT, gradeAr: 'ضعيف جدا' } }), 'a', trusted).item.grade).toBeUndefined();
  });

  it('a replicated feed entry that breaks the rule is refused invalid', () => {
    const { db, dir } = newDb();
    const ctx: ApplyCtx = { now: new Date('2026-12-31T10:00:00.000Z'), origin: 'app', actor: 'user:u1', dataDir: dir };
    const entry = (after: unknown): FeedEntry => ({
      seq: 1, entity: 'content:hadis', entityId: 'hadeethenc-66512', rev: '2026-12-01T09:30:00.000Z|dev-b',
      editedAt: '2026-12-01T09:30:00.000Z', syncedAt: '2026-12-01T09:30:01.000Z', actor: 'user:u1', deviceId: 'dev-b',
      origin: 'app', opId: null, after,
    });
    expect(applyFeedEntry(db, entry(provider({ grade: 'hasan' })), ctx)).toMatchObject({ status: 'refused', reason: 'invalid' });
    expect(stored(db)).toBeNull();
    expect(applyFeedEntry(db, entry(provider()), ctx).status).toBe('applied');
  });
});

describe('group 5: over-long attribution or grade is a typed BM error', () => {
  const he = (over: Partial<HeHadith> = {}): HeHadith => ({
    id: '66512', title: 't', textMs: 'Teks', introMs: null, textAr: 'نص', introAr: null, attributionAr: 'رواه مسلم', gradeAr: 'صحيح',
    categories: ['59'], digest: 'f'.repeat(64), ...over,
  });

  it('buildProviderItem refuses 201 and 61 characters and keeps 200 and 60', () => {
    expect(buildProviderItem(he({ attributionAr: 'ر'.repeat(201) }), '2026-11-09T01:00:00.000Z')).toEqual({ ok: false, error: 'field_too_long' });
    expect(buildProviderItem(he({ gradeAr: 'ص'.repeat(61) }), '2026-11-09T01:00:00.000Z')).toEqual({ ok: false, error: 'field_too_long' });
    const ok = buildProviderItem(he({ attributionAr: 'ر'.repeat(200), gradeAr: 'ص'.repeat(60) }), '2026-11-09T01:00:00.000Z');
    expect(ok.ok).toBe(true);
    expect(buildProviderItem(he({ textMs: 'a'.repeat(2001) }), '2026-11-09T01:00:00.000Z')).toEqual({ ok: false, error: 'too_long' });
  });

  interface Ctx { app: FastifyInstance; fake: FakeHadeethEnc; admin: Login }
  async function setup(): Promise<Ctx> {
    const dir = mkdtempSync(join(tmpdir(), 'hadis-trust-app-'));
    dirs.push(dir);
    const fake = fakeHadeethEnc();
    const app = buildApp(join(dir, 'test.db'), { now: () => new Date('2026-11-09T01:00:00.000Z'), fetchImpl: fake.fetch });
    apps.push(app);
    return { app, fake, admin: await loginAs(app, 'admin') };
  }
  const add = (c: Ctx, id: string) =>
    c.app.inject({ method: 'POST', url: '/api/hadis/add', headers: c.admin.headers, payload: { provider: 'hadeethenc', id } });

  it('add answers 400 field_too_long in Malay (not the English schema text), and saves nothing', async () => {
    const c = await setup();
    c.fake.one.set('70001', { ...fixture('one-66512'), id: '70001', attribution: 'ر'.repeat(201) });
    c.fake.one.set('70002', { ...fixture('one-66512'), id: '70002', grade: 'ص'.repeat(61) });
    for (const id of ['70001', '70002']) {
      const r = await add(c, id);
      expect(r.statusCode, id).toBe(400);
      expect(r.json().code).toBe('field_too_long');
      expect(r.json().errors[0]).toMatch(/terlalu panjang/);
      expect(r.body).not.toMatch(/must be|at most|characters/i);
      expect(getItem(c.app.surau.db, 'hadis', `hadeethenc-${id}`)).toBeNull();
    }
    c.fake.one.set('70003', { ...fixture('one-66512'), id: '70003', attribution: 'ر'.repeat(200) });
    expect((await add(c, '70003')).statusCode).toBe(201);
  });

  it('accepting a pending row with an over-long attribution drops the row and answers the same typed error', async () => {
    const c = await setup();
    await add(c, '66512');
    c.app.surau.db.prepare(
      "INSERT INTO hadis_source_updates (item_id, provider, provider_id, new_json, found_at) VALUES (?, 'hadeethenc', '66512', ?, ?)",
    ).run('hadeethenc-66512', JSON.stringify({
      title: 't', textMs: 'ok', intro: null, textAr: 'ar', attributionAr: 'ر'.repeat(201), gradeAr: 'صحيح', categories: [],
      digest: 'b'.repeat(64), fetchedAt: '2026-11-09T01:00:00.000Z',
    }), '2026-11-09T01:00:00.000Z');
    const acc = await c.app.inject({ method: 'POST', url: '/api/hadis/hadeethenc-66512/accept-update', headers: c.admin.headers, payload: {} });
    expect(acc.statusCode).toBe(400);
    expect(acc.json().code).toBe('field_too_long');
    expect(Number(c.app.surau.db.prepare('SELECT COUNT(*) AS n FROM hadis_source_updates').get()?.n)).toBe(0);
  });
});

describe('group 5: a toggle sent as {shown, order} replays after the text changed', () => {
  const NOW = new Date('2026-12-31T10:00:00.000Z');
  const ctx = (dir: string): ApplyCtx => ({ now: NOW, origin: 'app', actor: 'user:u1', dataDir: dir });
  let n = 0;
  const op = (payload: unknown, over: Partial<VerifiedOp> = {}): VerifiedOp => {
    n += 1;
    return {
      v: 1, opId: `PT${String(n).padStart(24, '0')}`, surauId: 'sdm', boxId: 'box1', deviceId: 'dev-a', userId: 'u1',
      kind: 'content.put', entity: 'content:hadis', entityId: 'hadeethenc-66512', baseRev: null,
      editedAt: '2026-12-01T09:00:00.000Z', payload, sig: 'x', userName: 'Ali', ...over,
    };
  };

  it('a patch with only shown applies on top of the NEW text; order alone applies too', () => {
    const { db, dir } = newDb();
    putProviderItem(db, provider(), 'user:u1');
    // the box accepts a new text while the phone is away
    putProviderItem(db, provider({ textMs: 'Teks baharu.', ext: { ...EXT, digest: 'c'.repeat(64) } }), 'user:u1');
    const r = applyOp(db, op({ shown: false }, { editedAt: '2026-12-01T09:50:00.000Z' }), ctx(dir));
    expect(r.status).toBe('applied');
    expect(stored(db)).toMatchObject({ shown: false, textMs: 'Teks baharu.', order: 1000 });
    expect(stored(db)?.ext?.digest).toBe('c'.repeat(64));
    const r2 = applyOp(db, op({ order: 7000 }, { editedAt: '2026-12-01T09:51:00.000Z' }), ctx(dir));
    expect(r2.status).toBe('applied');
    expect(stored(db)).toMatchObject({ shown: false, order: 7000, textMs: 'Teks baharu.' });
  });

  it('a patch that carries any other field is not a patch: forged text and a stale full body are still refused', () => {
    const { db, dir } = newDb();
    putProviderItem(db, provider(), 'user:u1');
    const stale = provider();
    putProviderItem(db, provider({ textMs: 'Teks baharu.', ext: { ...EXT, digest: 'c'.repeat(64) } }), 'user:u1');
    const { id: _i, ...old } = stale;
    expect(applyOp(db, op({ ...old, shown: false }, { editedAt: '2026-12-01T09:52:00.000Z' }), ctx(dir))).toMatchObject({ status: 'refused', reason: 'invalid' });
    expect(applyOp(db, op({ shown: false, textMs: 'Kata direka.' }, { editedAt: '2026-12-01T09:53:00.000Z' }), ctx(dir))).toMatchObject({ status: 'refused', reason: 'invalid' });
    expect(stored(db)).toMatchObject({ shown: true, textMs: 'Teks baharu.' });
  });

  it('a patch for an own item, a missing item or a deleted one is refused (nothing to patch onto)', () => {
    const { db, dir } = newDb();
    putItem(db, 'hadis', { id: 'own-1', textMs: 'x', source: 'y' }, 'a');
    expect(applyOp(db, op({ shown: false }, { entityId: 'own-1' }), ctx(dir))).toMatchObject({ status: 'refused', reason: 'invalid' });
    expect(applyOp(db, op({ shown: false }, { entityId: 'hadeethenc-5', editedAt: '2026-12-01T09:54:00.000Z' }), ctx(dir))).toMatchObject({ status: 'refused', reason: 'invalid' });
  });

  it('the content route takes the same patch online', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hadis-trust-route-'));
    dirs.push(dir);
    const app = buildApp(join(dir, 'test.db'), { now: () => NOW });
    apps.push(app);
    const admin = await loginAs(app, 'admin');
    putProviderItem(app.surau.db, provider(), 'user:u1');
    const r = await app.inject({ method: 'PUT', url: '/api/content/hadis/hadeethenc-66512', headers: admin.headers, payload: { shown: false } });
    expect(r.statusCode).toBe(200);
    expect(stored(app.surau.db)).toMatchObject({ shown: false, textMs: 'Islam itu dibina atas lima perkara.', grade: 'sahih' });
    const bad = await app.inject({ method: 'PUT', url: '/api/content/hadis/hadeethenc-66512', headers: admin.headers, payload: { shown: false, textMs: 'x' } });
    expect(bad.statusCode).toBe(400);
  });
});
