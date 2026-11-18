import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { ContentError, deleteItem, getItem, listItems, putItem, countLive, putProviderItem } from '../src/content/store.ts';
import { openDb } from '../src/db.ts';
import { getVersion } from '../src/settingsStore.ts';

const A = 'sdm';
const B = 'surau-b';
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function setup(): DatabaseSync {
  const db = openDb(':memory:');
  dbs.push(db);
  return db;
}

function assetId(n: string): string {
  return n.repeat(64);
}

function insertAsset(db: DatabaseSync, id: string): void {
  db.prepare(
    'INSERT INTO assets (id, mime, bytes, width, height, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, 'image/png', 10, 2, 2, new Date().toISOString(), 'test');
}

describe('content items per surau', () => {
  it('lists are disjoint; the same id lives in both suraus', () => {
    const db = setup();
    putItem(db, 'penceramah', { id: 'p1', name: `Ustaz ${A}` }, 'test', undefined, A);
    putItem(db, 'penceramah', { id: 'p1', name: `Ustaz ${B}` }, 'test', undefined, B);
    expect(listItems(db, 'penceramah', {}, A).map((p) => p.name)).toEqual([`Ustaz ${A}`]);
    expect(listItems(db, 'penceramah', {}, B).map((p) => p.name)).toEqual([`Ustaz ${B}`]);
    expect(getItem(db, 'penceramah', 'p1', A)?.name).toBe(`Ustaz ${A}`);
    expect(getItem(db, 'penceramah', 'p1', B)?.name).toBe(`Ustaz ${B}`);
    expect(getItem(db, 'penceramah', 'p1', 'surau-c')).toBeNull();
    expect(listItems(db, 'penceramah', {}, 'surau-c')).toEqual([]);
  });

  it('with no surau the default one is used (behaviour unchanged)', () => {
    const db = setup();
    putItem(db, 'penceramah', { id: 'p1', name: 'Ustaz Default' }, 'test', undefined, 'sdm');
    expect(listItems(db, 'penceramah', undefined, 'sdm').map((p) => p.name)).toEqual(['Ustaz Default']);
    expect(getItem(db, 'penceramah', 'p1', 'sdm')?.name).toBe('Ustaz Default');
    expect(db.prepare('SELECT surau_id FROM content_items').get()?.surau_id).toBe(A);
  });

  it('a put in B with A\'s id creates B\'s own row and leaves A\'s untouched', () => {
    const db = setup();
    const a = putItem(db, 'penceramah', { id: 'p1', name: 'Ustaz A' }, 'test', undefined, A);
    expect(a.created).toBe(true);
    const b = putItem(db, 'penceramah', { id: 'p1', name: 'Ustaz B' }, 'test', undefined, B);
    expect(b.created).toBe(true);
    expect(getItem(db, 'penceramah', 'p1', A)?.name).toBe('Ustaz A');
    expect(getItem(db, 'penceramah', 'p1', B)?.name).toBe('Ustaz B');
    expect(db.prepare('SELECT COUNT(*) AS n FROM content_items').get()?.n).toBe(2);
  });

  it('a replace in one surau does not touch the other', () => {
    const db = setup();
    putItem(db, 'penceramah', { id: 'p1', name: 'Ustaz A' }, 'test', undefined, A);
    putItem(db, 'penceramah', { id: 'p1', name: 'Ustaz B' }, 'test', undefined, B);
    const again = putItem(db, 'penceramah', { id: 'p1', name: 'Ustaz B2' }, 'test', undefined, B);
    expect(again.created).toBe(false);
    expect(getItem(db, 'penceramah', 'p1', A)?.name).toBe('Ustaz A');
    expect(getItem(db, 'penceramah', 'p1', B)?.name).toBe('Ustaz B2');
  });

  it('delete only removes the item in its own surau', () => {
    const db = setup();
    putItem(db, 'penceramah', { id: 'p1', name: 'Ustaz A' }, 'test', undefined, A);
    putItem(db, 'penceramah', { id: 'p1', name: 'Ustaz B' }, 'test', undefined, B);
    expect(deleteItem(db, 'penceramah', 'p1', 'test', undefined, B)).toBe(true);
    expect(getItem(db, 'penceramah', 'p1', A)).not.toBeNull();
    expect(getItem(db, 'penceramah', 'p1', B)).toBeNull();
    expect(listItems(db, 'penceramah', { includeDeleted: true }, B)).toHaveLength(1);
    expect(listItems(db, 'penceramah', {}, A)).toHaveLength(1);
  });

  it('countLive is per surau', () => {
    const db = setup();
    putItem(db, 'penceramah', { id: 'p1', name: 'Ustaz A' }, 'test', undefined, A);
    putItem(db, 'penceramah', { id: 'p1', name: 'Ustaz B' }, 'test', undefined, B);
    putItem(db, 'penceramah', { id: 'p2', name: 'Ustaz A2' }, 'test', undefined, A);
    expect(countLive(db, 'penceramah', A)).toBe(2);
    expect(countLive(db, 'penceramah', B)).toBe(1);
  });

  it('references are resolved only within the same surau', () => {
    const db = setup();
    const a = putItem(db, 'penceramah', { id: 'p-a', name: 'Ustaz A' }, 'test', undefined, A);
    const b = putItem(db, 'penceramah', { id: 'p-b', name: 'Ustaz B' }, 'test', undefined, B);
    // a kuliah in A may reference only the penceramah in A
    expect(() =>
      putItem(
        db,
        'kuliah',
        { date: '2026-11-05', slot: 'maghrib', time: '19:15', label: 'Kuliah', penceramahId: b.item.id, status: 'aktif' },
        'test',
        undefined,
        A,
      ),
    ).toThrow(ContentError);
    const k = putItem(
      db,
      'kuliah',
      { date: '2026-11-05', slot: 'maghrib', time: '19:15', label: 'Kuliah', penceramahId: a.item.id, status: 'aktif' },
      'test',
      undefined,
      A,
    );
    expect(k.created).toBe(true);
  });

  it('asset references are checked within the surau; the same asset id works everywhere', () => {
    const db = setup();
    const id = assetId('b');
    insertAsset(db, id);
    putItem(db, 'penceramah', { id: 'p1', name: 'Ustaz A', photoAssetId: id }, 'test', undefined, A);
    putItem(db, 'penceramah', { id: 'p1', name: 'Ustaz B', photoAssetId: id }, 'test', undefined, B);
    expect(getItem(db, 'penceramah', 'p1', A)?.photoAssetId).toBe(id);
    expect(getItem(db, 'penceramah', 'p1', B)?.photoAssetId).toBe(id);
  });

  it('change_log rows carry the surau_id of the write', () => {
    const db = setup();
    putItem(db, 'penceramah', { id: 'p1', name: 'Ustaz A' }, 'test', undefined, A);
    putItem(db, 'penceramah', { id: 'p1', name: 'Ustaz B' }, 'test', undefined, B);
    const rows = db.prepare('SELECT surau_id, entity_id FROM change_log ORDER BY id').all();
    expect(rows.map((r) => `${r.surau_id}:${r.entity_id}`)).toEqual([`${A}:p1`, `${B}:p1`]);
  });

  it('the same id in two suraus is two independent rows in the database', () => {
    const db = setup();
    putItem(db, 'penceramah', { id: 'p1', name: 'Ustaz A' }, 'test', undefined, A);
    putItem(db, 'penceramah', { id: 'p1', name: 'Ustaz B' }, 'test', undefined, B);
    const rows = db
      .prepare('SELECT surau_id, json FROM content_items ORDER BY surau_id')
      .all()
      .map((r) => [r.surau_id, JSON.parse(String(r.json)).name]);
    expect(rows).toEqual([
      [A, 'Ustaz A'],
      [B, 'Ustaz B'],
    ]);
  });

  it('writes bump the meta version only for the target surau', () => {
    const db = setup();
    const beforeA = getVersion(db, A);
    const beforeB = getVersion(db, B);
    putItem(db, 'penceramah', { id: 'p1', name: 'Ustaz B' }, 'test', undefined, B);
    expect(getVersion(db, A)).toBe(beforeA);
    expect(getVersion(db, B)).toBe(beforeB + 1);
    deleteItem(db, 'penceramah', 'p1', 'test', undefined, B);
    expect(getVersion(db, A)).toBe(beforeA);
    expect(getVersion(db, B)).toBe(beforeB + 2);
  });

  it('provider hadis are scoped by surau', () => {
    const db = setup();
    const fetchedAt = new Date().toISOString();
    const digest = 'a'.repeat(64);
    const ext = (providerId: string) => ({
      provider: 'hadeethenc',
      id: providerId,
      attributionAr: 'رواه مسلم',
      gradeAr: 'صحيح',
      categories: [],
      fetchedAt,
      digest,
    });
    putProviderItem(
      db,
      {
        id: 'hadeethenc-123',
        textMs: 'Hadis A',
        source: 'Riwayat Muslim',
        grade: 'sahih',
        shown: true,
        updatedAt: fetchedAt,
        ext: ext('123'),
      },
      'test',
      A,
    );
    putProviderItem(
      db,
      {
        id: 'hadeethenc-456',
        textMs: 'Hadis B',
        source: 'Riwayat Muslim',
        grade: 'sahih',
        shown: true,
        updatedAt: fetchedAt,
        ext: ext('456'),
      },
      'test',
      B,
    );
    expect(getItem(db, 'hadis', 'hadeethenc-123', A)?.textMs).toBe('Hadis A');
    expect(getItem(db, 'hadis', 'hadeethenc-456', B)?.textMs).toBe('Hadis B');
    expect(getItem(db, 'hadis', 'hadeethenc-123', B)).toBeNull();
    expect(getItem(db, 'hadis', 'hadeethenc-456', A)).toBeNull();
  });
});
