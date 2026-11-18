import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { klInstant } from '@surau/core';
import { openDb } from '../src/db.ts';
import {
  FinanceError, allEntries, appendEntry, entryRow, financeCounts, fundBalance, getEntry, getFund, getPerihal, isMonthClosed,
  listEntries, listFunds, listMonths, listPerihal, monthReportJson, monthStatus, putFundIn, putMonthIn, putPerihalIn,
  setCloudReceived, setRefNoIfNull,
} from '../src/finance/store.ts';
import {
  listPhotoMeta, markPresent, photoMeta, photoPath, photosTotalBytes, putPhoto,
} from '../src/finance/photos.ts';
import { monthClosedBy } from '../src/finance/reportRoutes.ts';
import { jpeg } from './support/jpeg.ts';

const A = 'sdm';
const B = 'surau-b';
const dbs: DatabaseSync[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = klInstant('2026-11-10', '10:00');
const box = { surauId: 'sdm', now: NOW, role: 'box' as const };

function setup(): DatabaseSync {
  const db = openDb(':memory:');
  dbs.push(db);
  // the same ids in both suraus on purpose: only the surau tells the rows apart
  for (const s of [A, B]) {
    putFundIn(db, 'fund1', { name: `Tabung ${s}`, public: true, jumaat: false, targetSen: null, sortOrder: 1, archivedAt: null }, 'test', undefined, s);
    putPerihalIn(db, 'per-in', { direction: 'in', label: `Derma ${s}`, sortOrder: 1, archivedAt: null }, 'test', undefined, undefined, s);
  }
  return db;
}

const entry = (id: string, amountSen: number, extra: Record<string, unknown> = {}) => ({
  id, kind: 'in', entryDate: '2026-11-06', fundId: 'fund1', perihalId: 'per-in', amountSen, method: 'tunai', counters: [{ name: 'Ali' }, { name: 'Abu' }], ...extra,
});

describe('finance lookups per surau', () => {
  it('funds and perihal are disjoint, and the same id lives in both', () => {
    const db = setup();
    expect(listFunds(db, {}, A).map((f) => f.name)).toEqual(['Tabung sdm']);
    expect(listFunds(db, {}, B).map((f) => f.name)).toEqual(['Tabung surau-b']);
    expect(getFund(db, 'fund1', B)?.name).toBe('Tabung surau-b');
    expect(listPerihal(db, {}, A).map((p) => p.label)).toEqual(['Derma sdm']);
    expect(getPerihal(db, 'per-in', B)?.label).toBe('Derma surau-b');
    expect(getFund(db, 'fund1', 'surau-c')).toBeNull();
    expect(listFunds(db, {}, 'surau-c')).toEqual([]);
  });

  it('with no surau the default one is used (behaviour unchanged)', () => {
    const db = setup();
    expect(listFunds(db, undefined, 'sdm').map((f) => f.name)).toEqual(['Tabung sdm']);
    expect(getFund(db, 'fund1', 'sdm')?.name).toBe('Tabung sdm');
  });

  it('a name taken in one surau is free in the other; archiving in B leaves A alone', () => {
    const db = setup();
    const am = { name: 'Tabung Am', public: true, jumaat: false, targetSen: null, sortOrder: 2, archivedAt: null };
    putFundIn(db, 'fund2', am, 'test', undefined, A);
    putFundIn(db, 'fund3', am, 'test', undefined, B);
    expect(listFunds(db, {}, A)).toHaveLength(2);
    expect(listFunds(db, {}, B)).toHaveLength(2);
    expect(() => putFundIn(db, 'fund4', { ...am, name: 'tabung am' }, 'test', undefined, B)).toThrow(FinanceError);
    putFundIn(db, 'fund3', { ...am, archivedAt: '2026-11-10T00:00:00.000Z' }, 'test', undefined, B);
    expect(listFunds(db, {}, B).map((f) => f.id)).toEqual(['fund1']);
    expect(listFunds(db, {}, A).map((f) => f.id).sort()).toEqual(['fund1', 'fund2']);
  });
});

describe('ledger per surau', () => {
  it('entries, balances and counts are disjoint; the same entry id is a different row in each surau', () => {
    const db = setup();
    appendEntry(db, entry('e1', 1000), 'user:u1', box, undefined, A);
    appendEntry(db, entry('e1', 7000), 'user:u1', box, undefined, B);
    appendEntry(db, entry('e2', 500), 'user:u1', box, undefined, B);
    expect(allEntries(db, A).map((e) => e.amountSen)).toEqual([1000]);
    expect(allEntries(db, B).map((e) => e.amountSen).sort()).toEqual([500, 7000]);
    expect(listEntries(db, {}, A)).toHaveLength(1);
    expect(listEntries(db, { fundId: 'fund1' }, B)).toHaveLength(2);
    expect(entryRow(db, 'e2', A)).toBeNull();
    expect(entryRow(db, 'e2', B)?.amountSen).toBe(500);
    expect(fundBalance(db, 'fund1', A)).toBe(1000);
    expect(fundBalance(db, 'fund1', B)).toBe(7500);
    expect(financeCounts(db, A)).toEqual({ entries: 1, funds: 1 });
    expect(financeCounts(db, B)).toEqual({ entries: 2, funds: 1 });
    // with no surau argument: the default surau only
    expect(allEntries(db, 'sdm')).toHaveLength(1);
  });

  it('a retry of the same body is a no-op, a different body is entry_exists, per surau', () => {
    const db = setup();
    appendEntry(db, entry('e1', 1000), 'user:u1', box, undefined, A);
    expect(appendEntry(db, entry('e1', 1000), 'user:u1', box, undefined, A).amountSen).toBe(1000);
    // the other surau does not see e1, so a different body is a fresh entry there
    expect(appendEntry(db, entry('e1', 2000), 'user:u1', box, undefined, B).amountSen).toBe(2000);
    expect(() => appendEntry(db, entry('e1', 3000), 'user:u1', box, undefined, B)).toThrow(FinanceError);
  });

  it('an entry cannot use a fund of the other surau', () => {
    const db = setup();
    putFundIn(db, 'only-a', { name: 'Hanya A', public: true, jumaat: false, targetSen: null, sortOrder: 9, archivedAt: null }, 'test', undefined, A);
    expect(() => appendEntry(db, entry('x1', 100, { fundId: 'only-a' }), 'user:u1', box, undefined, B)).toThrow(FinanceError);
    expect(appendEntry(db, entry('x1', 100, { fundId: 'only-a' }), 'user:u1', box, undefined, A).fundId).toBe('only-a');
  });

  it('a correction finds the original only in its own surau', () => {
    const db = setup();
    appendEntry(db, entry('e1', 1000), 'user:u1', box, undefined, A);
    const fix = { id: 'c1', kind: 'adjust', entryDate: '2026-11-07', fundId: 'fund1', correctsId: 'e1', correctionKind: 'amount', amountSen: 900, reason: 'salah kira semasa mengira kutipan' };
    expect(() => appendEntry(db, fix, 'user:u1', box, undefined, B)).toThrow(FinanceError);
    appendEntry(db, fix, 'user:u1', box, undefined, A);
    expect(getEntry(db, 'e1', A)?.corrections).toHaveLength(1);
    expect(getEntry(db, 'e1', B)).toBeNull();
    expect(fundBalance(db, 'fund1', A)).toBe(900);
  });

  it('keeps the append-only triggers: no update, no delete, in any surau', () => {
    const db = setup();
    appendEntry(db, entry('e1', 1000), 'user:u1', box, undefined, B);
    expect(() => db.prepare('UPDATE finance_entries SET amount_sen = 1 WHERE id = ?').run('e1')).toThrow(/append-only/);
    expect(() => db.prepare('UPDATE finance_entries SET surau_id = ? WHERE id = ?').run(A, 'e1')).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM finance_entries WHERE id = ?').run('e1')).toThrow(/append-only/);
  });
});

describe('reference numbers per surau', () => {
  it('each surau counts on its own', () => {
    const db = setup();
    expect(appendEntry(db, entry('a1', 100), 'user:u1', box, undefined, A).refNo).toBe('K-0001');
    expect(appendEntry(db, entry('a2', 100), 'user:u1', box, undefined, A).refNo).toBe('K-0002');
    expect(appendEntry(db, entry('b1', 100), 'user:u1', box, undefined, B).refNo).toBe('K-0001');
    expect(appendEntry(db, entry('a3', 100), 'user:u1', box, undefined, A).refNo).toBe('K-0003');
    expect(appendEntry(db, entry('b2', 100), 'user:u1', box, undefined, B).refNo).toBe('K-0002');
    const rows = db.prepare('SELECT surau_id, letter, next FROM finance_counters ORDER BY surau_id').all();
    expect(rows.map((r) => `${r.surau_id}:${r.letter}:${r.next}`).sort()).toEqual([`${A}:K:4`, `${B}:K:3`].sort());
  });

  it('a number taken in one surau does not skip the counter of the other', () => {
    const db = setup();
    const cloud = { surauId: 'sdm', now: NOW, role: 'cloud' as const };
    appendEntry(db, entry('a1', 100), 'user:u1', cloud, undefined, A);
    expect(setRefNoIfNull(db, 'a1', 'K-0001', A)).toBe(true);
    expect(appendEntry(db, entry('b1', 100), 'user:u1', box, undefined, B).refNo).toBe('K-0001');
    // setting a number on a row of the other surau by id does nothing
    appendEntry(db, entry('a2', 100), 'user:u1', cloud, undefined, A);
    expect(setRefNoIfNull(db, 'a2', 'K-0009', B)).toBe(false);
    expect(entryRow(db, 'a2', A)?.refNo).toBeNull();
    expect(setRefNoIfNull(db, 'a2', 'K-0001', A)).toBe(false); // taken in A
    expect(setRefNoIfNull(db, 'a2', 'K-0002', A)).toBe(true);
  });

  it('setCloudReceived is per surau', () => {
    const db = setup();
    appendEntry(db, entry('a1', 100), 'user:u1', box, undefined, A);
    expect(setCloudReceived(db, 'a1', '2026-11-10T01:00:00.000Z', B)).toBe(false);
    expect(setCloudReceived(db, 'a1', '2026-11-10T01:00:00.000Z', A)).toBe(true);
  });
});

describe('months per surau', () => {
  it('closing a month in one surau leaves the other open', () => {
    const db = setup();
    const ctx = { ...box, freeze: () => '{"frozen":true}' };
    appendEntry(db, entry('a1', 100, { entryDate: '2026-10-05' }), 'user:u1', box, undefined, A);
    putMonthIn(db, '2026-10', { status: 'closed' }, 'user:u1', ctx, undefined, A);
    expect(listMonths(db, A).map((m) => `${m.ym}:${m.status}`)).toEqual(['2026-10:closed']);
    expect(listMonths(db, B)).toEqual([]);
    expect(isMonthClosed(db, '2026-10', A)).toBe(true);
    expect(isMonthClosed(db, '2026-10', B)).toBe(false);
    expect(monthStatus(db, '2026-10', B)).toBe('open');
    expect(monthReportJson(db, '2026-10', A)).toBe('{"frozen":true}');
    expect(monthReportJson(db, '2026-10', B)).toBeNull();
    // B can still write into October; A cannot
    expect(appendEntry(db, entry('b1', 100, { entryDate: '2026-10-06' }), 'user:u1', box, undefined, B).entryDate).toBe('2026-10-06');
    expect(() => appendEntry(db, entry('a2', 100, { entryDate: '2026-10-06' }), 'user:u1', box, undefined, A)).toThrow(FinanceError);
  });

  it('the month order rule looks at the surau\'s own earlier entries only', () => {
    const db = setup();
    const ctx = { ...box, freeze: () => '{}' };
    appendEntry(db, entry('a1', 100, { entryDate: '2026-10-05' }), 'user:u1', box, undefined, A);
    // A has an open October, so November cannot close there; B has nothing, so it can
    expect(() => putMonthIn(db, '2026-11', { status: 'closed' }, 'user:u1', ctx, undefined, A)).toThrow(FinanceError);
    expect(putMonthIn(db, '2026-11', { status: 'closed' }, 'user:u1', ctx, undefined, B).status).toBe('closed');
  });
});

describe('report PDF closer per surau (qs-gate)', () => {
  it('the closer shown is the own surau row, not another surau row for the same month', () => {
    const db = setup();
    db.prepare("INSERT INTO users (id, name, roles_json, created_at, created_by, surau_id) VALUES ('ua', 'Ali A', '[]', 'x', 'x', ?), ('ub', 'Bakar B', '[]', 'x', 'x', ?)").run(A, B);
    const ctx = { ...box, freeze: () => '{}' };
    // A closes first, so its row comes first in the table
    putMonthIn(db, '2026-10', { status: 'closed' }, 'user:ua', { ...ctx, now: klInstant('2026-11-01', '09:00') }, undefined, A);
    expect(monthClosedBy(db, '2026-10', B)).toBeUndefined();
    putMonthIn(db, '2026-10', { status: 'closed' }, 'user:ub', { ...ctx, now: klInstant('2026-11-02', '09:00') }, undefined, B);
    expect(monthClosedBy(db, '2026-10', B)?.by).toBe('Bakar B');
    expect(monthClosedBy(db, '2026-10', A)?.by).toBe('Ali A');
  });
});

describe('photos per surau', () => {
  it('rows, totals and lookups are disjoint; the same bytes are a row in each surau', () => {
    const db = setup();
    const dir = mkdtempSync(join(tmpdir(), 'surau-finscope-'));
    dirs.push(dir);
    const buf = jpeg(5000);
    const a = putPhoto(db, dir, buf, 'e1', 'user:u1', NOW, undefined, A);
    expect(photoMeta(db, a.id, A)?.entryId).toBe('e1');
    expect(photoMeta(db, a.id, B)).toBeNull();
    expect(photoPath(db, dir, a.id, B)).toBeNull();
    expect(photoPath(db, dir, a.id, A)).not.toBeNull();
    expect(listPhotoMeta(db, B)).toEqual([]);
    expect(photosTotalBytes(db, B)).toBe(0);
    const b = putPhoto(db, dir, buf, 'e9', 'user:u1', NOW, undefined, B);
    expect(b.id).toBe(a.id);
    expect(photoMeta(db, b.id, B)?.entryId).toBe('e9');
    expect(photoMeta(db, a.id, A)?.entryId).toBe('e1');
    expect(listPhotoMeta(db, A)).toHaveLength(1);
    expect(photosTotalBytes(db, A)).toBe(5000);
    expect(db.prepare('SELECT surau_id FROM finance_photos').all().map((r) => String(r.surau_id)).sort()).toEqual([A, B].sort());
  });

  it('markPresent flips only the named surau\'s row', () => {
    const db = setup();
    const id = 'f'.repeat(64);
    const ins = db.prepare("INSERT INTO finance_photos (surau_id, id, entry_id, mime, bytes, created_at, created_by, present) VALUES (?, ?, 'e1', 'image/jpeg', 10, 'x', 'u', 0)");
    ins.run(A, id);
    ins.run(B, id);
    markPresent(db, id, B);
    expect(photoMeta(db, id, B)?.present).toBe(true);
    expect(photoMeta(db, id, A)?.present).toBe(false);
  });

  it('with no surau the default one is used', () => {
    const db = setup();
    const dir = mkdtempSync(join(tmpdir(), 'surau-finscope-'));
    dirs.push(dir);
    const p = putPhoto(db, dir, jpeg(3000), 'e1', 'user:u1', NOW, undefined, 'sdm');
    expect(photoMeta(db, p.id, 'sdm')?.entryId).toBe('e1');
    expect(db.prepare('SELECT surau_id FROM finance_photos').get()?.surau_id).toBe(A);
  });
});
