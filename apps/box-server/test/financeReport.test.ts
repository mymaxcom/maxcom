import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { klInstant } from '@surau/core';
import type { FinanceEntry } from '@surau/core';
import { openDb } from '../src/db.ts';
import { createUser } from '../src/auth/users.ts';
import { freezeReport, reportFor } from '../src/finance/report.ts';
import { appendEntry, ensureSeeded, insertReplicatedEntry, listFunds, listPerihal, putFundIn, putMonthIn, putPerihalIn } from '../src/finance/store.ts';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });

interface Vectors {
  funds: { id: string; name: string; sortOrder: number }[];
  perihal: { id: string; direction: 'in' | 'out'; label: string }[];
  scenarios: { name: string; ym?: string; entries: Record<string, unknown>[]; report?: { expected: Record<string, unknown> } }[];
}
const vectors = JSON.parse(readFileSync(fileURLToPath(new URL('../../../packages/core/test/fixtures/finance-vectors.json', import.meta.url)), 'utf8')) as Vectors;

const NOW = klInstant('2026-11-02', '09:00');

function loaded(): DatabaseSync {
  const db = openDb(':memory:');
  dbs.push(db);
  for (const f of vectors.funds) putFundIn(db, f.id, { name: f.name, public: true, sortOrder: f.sortOrder }, 'test');
  vectors.perihal.forEach((p, i) => putPerihalIn(db, p.id, { direction: p.direction, label: p.label, sortOrder: i }, 'test'));
  const sc = vectors.scenarios.find((s) => s.name.startsWith('10'))!;
  for (const e of sc.entries) {
    const withCounters = e.method === 'tunai' ? { ...e, counters: [{ name: 'Ali' }, { name: 'Abu' }] } : e;
    insertReplicatedEntry(db, withCounters, String(e.id), 'user:test', { now: NOW, role: 'cloud' }, { editedAt: String(e.editedAt), origin: 'local' });
  }
  return db;
}

describe('reportFor', () => {
  it('the vector month equals the pinned JSON', () => {
    const db = loaded();
    const sc = vectors.scenarios.find((s) => s.name.startsWith('10'))!;
    const rep = reportFor(db, '2026-10', NOW, 'cloud');
    expect(rep).toEqual({ ...sc.report!.expected, generatedAt: NOW.toISOString(), syncedUntil: null });
  });

  it('closing a month freezes it; a later rename of a tabung changes only the open month', () => {
    const db = loaded();
    putMonthIn(db, '2026-09', { status: 'closed' }, 'test', { now: NOW, role: 'box', freeze: (ym) => freezeReport(db, ym, NOW, 'box') });
    putMonthIn(db, '2026-10', { status: 'closed' }, 'test', { now: NOW, role: 'box', freeze: (ym) => freezeReport(db, ym, NOW, 'box') });
    const before = JSON.stringify(reportFor(db, '2026-10', klInstant('2026-11-03', '09:00'), 'box'));
    expect(JSON.parse(before).status).toBe('closed');
    const f = listFunds(db)[0]!;
    putFundIn(db, f.id, { name: 'Tabung Jumaat Utama', public: true, sortOrder: f.sortOrder }, 'test');
    // the frozen report is byte for byte what it was, including the date it was made
    expect(JSON.stringify(reportFor(db, '2026-10', klInstant('2026-11-09', '09:00'), 'box'))).toBe(before);
    expect(reportFor(db, '2026-10', NOW, 'box').funds[0]!.name).toBe('Tabung Jumaat');
    // the open month uses the current name (a month with no rows lists the unarchived tabung)
    const open = reportFor(db, '2026-11', NOW, 'box');
    expect(open.status).toBe('open');
    expect(open.funds[0]!.name).toBe('Tabung Jumaat Utama');
  });

  it("a correction posted this month against last month's entry shows here as lastMonth and does not change last month's frozen figures", () => {
    const db = openDb(':memory:');
    dbs.push(db);
    ensureSeeded(db, 'test', klInstant('2026-10-05', '09:00'));
    const fund = listFunds(db)[0]!.id;
    const perIn = listPerihal(db).find((p) => p.direction === 'in')!.id;
    const u = createUser(db, { name: 'Bendahari', roles: ['treasurer'] }, 'test').id;
    const oct5 = { now: klInstant('2026-10-05', '09:00'), role: 'box' as const };
    appendEntry(db, { id: 's1', kind: 'in', entryDate: '2026-09-25', fundId: fund, perihalId: perIn, amountSen: 50000, method: 'tunai', counters: [{ userId: u }, { name: 'Ali' }] }, 'user:x', oct5);
    putMonthIn(db, '2026-09', { status: 'closed' }, 'test', { ...oct5, freeze: (ym) => freezeReport(db, ym, oct5.now, 'box') });
    const septBefore = JSON.stringify(reportFor(db, '2026-09', oct5.now, 'box'));
    const oct20 = { now: klInstant('2026-10-20', '09:00'), role: 'box' as const };
    appendEntry(db, { id: 'c1', kind: 'adjust', entryDate: '2026-10-20', fundId: fund, correctsId: 's1', correctionKind: 'amount', amountSen: 45000, reason: 'Salah taip jumlah: 450' }, 'user:x', oct20);
    const oct = reportFor(db, '2026-10', oct20.now, 'box');
    expect(oct.corrections).toHaveLength(1);
    expect(oct.corrections[0]).toMatchObject({ lastMonth: true, deltaSen: -5000, kind: 'amount', originalRefNo: 'K-0001' });
    expect(oct.funds[0]).toMatchObject({ openingSen: 50000, correctionsSen: -5000, closingSen: 45000 });
    expect(JSON.stringify(reportFor(db, '2026-09', oct20.now, 'box'))).toBe(septBefore);
  });

  it('an open month on a box says when it last reached the cloud', () => {
    const db = loaded();
    expect(reportFor(db, '2026-10', NOW, 'box').syncedUntil).toBeNull();
    db.prepare("INSERT INTO sync_state (key, value) VALUES ('last_push', ?)").run('2026-11-02T00:59:00.000Z');
    expect(reportFor(db, '2026-10', NOW, 'box').syncedUntil).toBe('2026-11-02T00:59:00.000Z');
    expect(reportFor(db, '2026-10', NOW, 'cloud').syncedUntil).toBeNull();
  });
});
