import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeedEntry } from '@surau/core';
import { ContentError, countLive, deleteItem, getItem, putItem, putProviderItem } from '../src/content/store.ts';
import { openDb } from '../src/db.ts';
import { applyFeedEntry, applyOp } from '../src/sync/apply.ts';
import type { ApplyCtx, VerifiedOp } from '../src/sync/apply.ts';

const dbs: DatabaseSync[] = [];
const dirs: string[] = [];
afterEach(() => {
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
  const dir = mkdtempSync(join(tmpdir(), 'hadis-lock-'));
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
const fails = (fn: () => unknown): ContentError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ContentError);
    return e as ContentError;
  }
  throw new Error('expected a ContentError');
};
const stored = (db: DatabaseSync) => getItem(db, 'hadis', 'hadeethenc-66512');

describe('provider write lock (store)', () => {
  it('putProviderItem creates a provider item; a plain putItem cannot', () => {
    const { db } = newDb();
    expect(fails(() => putItem(db, 'hadis', provider(), 'user:u1')).status).toBe(400);
    expect(stored(db)).toBeNull();
    const r = putProviderItem(db, provider(), 'user:u1');
    expect(r.created).toBe(true);
    expect(stored(db)).toMatchObject({ textMs: 'Islam itu dibina atas lima perkara.', ext: { id: '66512' }, grade: 'sahih' });
  });

  it('shown and order may change; every provider field is read-only', () => {
    const { db } = newDb();
    putProviderItem(db, provider(), 'user:u1');
    putItem(db, 'hadis', provider({ shown: false, order: 5000 }), 'user:u2');
    expect(stored(db)).toMatchObject({ shown: false, order: 5000, updatedBy: 'user:u2' });
    for (const change of [
      { textMs: 'Kata lain.' }, { textAr: 'نص آخر' }, { intro: 'Lain' }, { title: 'Tajuk lain' }, { source: 'Riwayat Muslim' },
      { grade: 'hasan' }, { ext: { ...EXT, gradeAr: 'حسن' } }, { ext: { ...EXT, digest: 'b'.repeat(64) } }, { ext: { ...EXT, id: '1' } },
      { textAr: undefined }, { intro: undefined }, { ext: undefined }, { ext: undefined, grade: undefined },
    ]) {
      const e = fails(() => putItem(db, 'hadis', provider(change as Record<string, unknown>), 'user:u2'));
      expect(e.status, JSON.stringify(change)).toBe(400);
      expect(e.errors[0]).toMatch(/read-only/);
    }
    expect(stored(db)).toMatchObject({ textMs: 'Islam itu dibina atas lima perkara.', grade: 'sahih', shown: false, order: 5000 });
  });

  it('a new item with ext, a provider row id without ext, and an own item with a grade are all refused', () => {
    const { db } = newDb();
    expect(fails(() => putItem(db, 'hadis', provider({ id: 'forged-1' }), 'user:u1')).status).toBe(400);
    expect(fails(() => putItem(db, 'hadis', { id: 'hadeethenc-77', textMs: 'x', source: 'y' }, 'user:u1')).status).toBe(400);
    expect(fails(() => putItem(db, 'hadis', { id: 'own-1', textMs: 'x', source: 'y', grade: 'sahih' }, 'user:u1')).status).toBe(400);
    expect(getItem(db, 'hadis', 'forged-1')).toBeNull();
    // the own list is unaffected: shown, order, intro and title are fine on an own item
    expect(putItem(db, 'hadis', { id: 'own-2', textMs: 'Teks', source: 'Riwayat Muslim', shown: false, order: 3000 }, 'user:u1').created).toBe(true);
    expect(putItem(db, 'hadis', { id: 'own-2', textMs: 'Teks lain', source: 'Riwayat Muslim', textAr: 'نص' }, 'user:u1').created).toBe(false);
  });

  it('a deleted provider item is not revived by a plain put, only by the provider path', () => {
    const { db } = newDb();
    putProviderItem(db, provider(), 'user:u1');
    expect(deleteItem(db, 'hadis', 'hadeethenc-66512', 'user:u1')).toBe(true);
    expect(countLive(db, 'hadis')).toBe(0);
    expect(fails(() => putItem(db, 'hadis', provider(), 'user:u1')).status).toBe(400);
    expect(stored(db)).toBeNull();
    const again = putProviderItem(db, provider({ textMs: 'Teks baharu.' }), 'user:u1');
    expect(again.created).toBe(true);
    expect(stored(db)?.textMs).toBe('Teks baharu.');
  });

  it('putProviderItem refuses anything that is not a HadeethEnc hadis with its own id', () => {
    const { db } = newDb();
    expect(fails(() => putProviderItem(db, { id: 'own-1', textMs: 'x', source: 'y' }, 'u')).status).toBe(400);
    expect(fails(() => putProviderItem(db, provider({ id: 'hadeethenc-99999999' }), 'u')).status).toBe(400);
    expect(fails(() => putProviderItem(db, provider({ ext: { ...EXT, id: '../x' } }), 'u')).status).toBe(400);
    expect(fails(() => putProviderItem(db, provider({ grade: undefined }), 'u')).status).toBe(400);
    // an unknown grade is only allowed hidden
    expect(putProviderItem(db, provider({ grade: undefined, shown: false }), 'u').created).toBe(true);
  });

  it('deleting a provider item (Buang) is allowed for the normal path', () => {
    const { db } = newDb();
    putProviderItem(db, provider(), 'user:u1');
    expect(deleteItem(db, 'hadis', 'hadeethenc-66512', 'user:u2')).toBe(true);
  });
});

describe('provider write lock (sync)', () => {
  const NOW = new Date('2026-12-31T10:00:00.000Z');
  const ctx = (dir: string): ApplyCtx => ({ now: NOW, origin: 'app', actor: 'user:u1', dataDir: dir });
  let n = 0;
  const op = (payload: unknown, over: Partial<VerifiedOp> = {}): VerifiedOp => {
    n += 1;
    return {
      v: 1, opId: `OP${String(n).padStart(24, '0')}`, surauId: 'sdm', boxId: 'box1', deviceId: 'dev-a', userId: 'u1',
      kind: 'content.put', entity: 'content:hadis', entityId: 'hadeethenc-66512', baseRev: null,
      editedAt: '2026-12-01T09:00:00.000Z', payload, sig: 'x', userName: 'Ali', ...over,
    };
  };
  const entry = (after: unknown, over: Partial<FeedEntry> = {}): FeedEntry => ({
    seq: 1, entity: 'content:hadis', entityId: 'hadeethenc-66512', rev: '2026-12-01T09:30:00.000Z|dev-b',
    editedAt: '2026-12-01T09:30:00.000Z', syncedAt: '2026-12-01T09:30:01.000Z', actor: 'user:u1', deviceId: 'dev-b',
    origin: 'app', opId: null, after, ...over,
  });

  it('a signed op changing provider text is refused invalid; one changing shown is applied', () => {
    const { db, dir } = newDb();
    putProviderItem(db, provider(), 'user:u1');
    const { id: _id, ...fields } = provider();
    const forged = applyOp(db, op({ ...fields, textMs: 'Kata yang direka.' }), ctx(dir));
    expect(forged).toMatchObject({ status: 'refused', reason: 'invalid' });
    expect(stored(db)?.textMs).toBe('Islam itu dibina atas lima perkara.');
    const ok = applyOp(db, op({ ...fields, shown: false }, { editedAt: '2026-12-01T09:10:00.000Z' }), ctx(dir));
    expect(ok.status).toBe('applied');
    expect(stored(db)).toMatchObject({ shown: false, textMs: 'Islam itu dibina atas lima perkara.' });
  });

  it('a signed op cannot create a provider item or strip ext', () => {
    const { db, dir } = newDb();
    const { id: _id, ...fields } = provider();
    expect(applyOp(db, op(fields), ctx(dir))).toMatchObject({ status: 'refused', reason: 'invalid' });
    expect(stored(db)).toBeNull();
    putProviderItem(db, provider(), 'user:u1');
    const { ext: _ext, ...noExt } = fields;
    expect(applyOp(db, op(noExt, { editedAt: '2026-12-01T09:20:00.000Z' }), ctx(dir))).toMatchObject({ status: 'refused', reason: 'invalid' });
    expect(stored(db)?.ext).toMatchObject({ id: '66512' });
  });

  it('a stale offline toggle made before a text update is refused, never applied with old text', () => {
    const { db, dir } = newDb();
    putProviderItem(db, provider(), 'user:u1');
    const { id: _id, ...old } = provider();
    // the box accepts a new text
    putProviderItem(db, provider({ textMs: 'Teks baharu.', ext: { ...EXT, digest: 'c'.repeat(64) } }), 'user:u1');
    const stale = applyOp(db, op({ ...old, shown: false }, { editedAt: '2026-12-01T09:50:00.000Z' }), ctx(dir));
    expect(stale).toMatchObject({ status: 'refused', reason: 'invalid' });
    expect(stored(db)).toMatchObject({ textMs: 'Teks baharu.', shown: true });
  });

  it('a replicated feed entry (trusted) applies, provider text included', () => {
    const { db, dir } = newDb();
    putProviderItem(db, provider(), 'user:u1');
    const r = applyFeedEntry(db, entry(provider({ textMs: 'Teks dari awan.', ext: { ...EXT, digest: 'd'.repeat(64) } })), ctx(dir));
    expect(r.status).toBe('applied');
    expect(stored(db)?.textMs).toBe('Teks dari awan.');
    // and a whole new provider item arrives the same way
    const fresh = applyFeedEntry(db, entry(provider({ id: 'hadeethenc-5', ext: { ...EXT, id: '5' } }), { entityId: 'hadeethenc-5', rev: '2026-12-01T09:31:00.000Z|dev-b' }), ctx(dir));
    expect(fresh.status).toBe('applied');
    expect(getItem(db, 'hadis', 'hadeethenc-5')?.ext?.id).toBe('5');
  });

  it('two devices adding the same hadis end as one row (deterministic id, latest edit wins)', () => {
    const { db, dir } = newDb();
    const a = applyFeedEntry(db, entry(provider({ order: 1000 })), ctx(dir));
    const b = applyFeedEntry(db, entry(provider({ order: 2000 }), { rev: '2026-12-01T09:40:00.000Z|dev-c', editedAt: '2026-12-01T09:40:00.000Z' }), ctx(dir));
    expect([a.status, b.status]).toEqual(['applied', 'applied']);
    expect(countLive(db, 'hadis')).toBe(1);
    expect(stored(db)?.order).toBe(2000);
  });
});
