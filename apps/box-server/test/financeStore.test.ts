import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { klInstant } from '@surau/core';
import { openDb } from '../src/db.ts';
import { createUser, deactivateUser } from '../src/auth/users.ts';
import { putItem } from '../src/content/store.ts';
import { getSettings, getVersion } from '../src/settingsStore.ts';
import {
  FinanceError, appendEntry, ensureSeeded, financeCounts, fundBalance, getEntry, insertReplicatedEntry, listEntries, listFunds, listMonths,
  listPerihal, putFundIn, putMonthIn, putPerihalIn, setCloudReceived, setRefNoIfNull,
} from '../src/finance/store.ts';
import { tx } from '../src/auth/users.ts';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });

const NOW = klInstant('2026-11-10', '10:00');
const box = { now: NOW, role: 'box' as const };
const cloud = { now: NOW, role: 'cloud' as const };

function setup(): { db: DatabaseSync; fundA: string; fundB: string; perIn: string; perOut: string; perPen: string; u1: string; u2: string } {
  const db = openDb(':memory:');
  dbs.push(db);
  ensureSeeded(db, 'test', NOW);
  const funds = listFunds(db);
  const per = listPerihal(db);
  const u1 = createUser(db, { name: 'Bendahari', roles: ['treasurer'] }, 'test').id;
  const u2 = createUser(db, { name: 'Pengerusi', roles: ['admin'] }, 'test').id;
  return {
    db, fundA: funds[0]!.id, fundB: funds[1]!.id,
    perIn: per.find((p) => p.direction === 'in')!.id, perOut: per.find((p) => p.label === 'Utiliti')!.id,
    perPen: per.find((p) => p.system === 'penceramah')!.id, u1, u2,
  };
}

const cash = (s: ReturnType<typeof setup>, id: string, amountSen: number, extra: Record<string, unknown> = {}) => ({
  id, kind: 'in', entryDate: '2026-11-06', fundId: s.fundA, perihalId: s.perIn, amountSen, method: 'tunai',
  counters: [{ userId: s.u1 }, { userId: s.u2 }], ...extra,
});

function code(fn: () => unknown): { status: number; code: string } {
  try { fn(); } catch (e) {
    if (e instanceof FinanceError) return { status: e.status, code: e.code };
    throw e;
  }
  throw new Error('did not throw');
}

describe('finance migration', () => {
  it('creates the tables and both triggers on a fresh database', () => {
    const db = openDb(':memory:');
    dbs.push(db);
    for (const t of ['finance_funds', 'finance_perihal', 'finance_entries', 'finance_months', 'finance_photos', 'finance_counters']) {
      expect(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), t).toBeDefined();
    }
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((r) => String(r.name));
    expect(triggers).toEqual(expect.arrayContaining(['trg_fin_entries_immutable', 'trg_fin_entries_no_delete']));
  });
});

describe('seeds and lookups', () => {
  it('ensureSeeded writes the starting lists once and sets the penceramah tabung', () => {
    const db = openDb(':memory:');
    dbs.push(db);
    expect(ensureSeeded(db, 'test', NOW)).toBe(true);
    expect(ensureSeeded(db, 'test', NOW)).toBe(false);
    const funds = listFunds(db);
    expect(funds.map((f) => f.name)).toEqual(['Tabung Jumaat', 'Tabung Am', 'Tabung Pembangunan', 'Tabung Khairat Kematian']);
    expect(funds.map((f) => f.public)).toEqual([true, true, true, false]);
    expect(listPerihal(db).filter((p) => p.system === 'penceramah')).toHaveLength(1);
    expect(listPerihal(db)).toHaveLength(13);
    const fin = getSettings(db).finance as unknown as { penceramahFundId: string; startedOn: string };
    expect(fin.penceramahFundId).toBe(funds[0]!.id);
    expect(fin.startedOn).toBe('2026-11-10');
  });

  it('refuses a duplicate tabung name, renames, and archives only at zero balance', () => {
    const s = setup();
    const a = listFunds(s.db)[0]!;
    expect(code(() => putFundIn(s.db, 'new1', { name: 'tabung am', public: false }, 'test'))).toEqual({ status: 409, code: 'name_taken' });
    const renamed = putFundIn(s.db, a.id, { name: 'Tabung Jumaat Utama', public: true, jumaat: true, sortOrder: 1 }, 'test');
    expect(renamed.name).toBe('Tabung Jumaat Utama');
    appendEntry(s.db, cash(s, 'e1', 1), 'test', box);
    expect(fundBalance(s.db, a.id)).toBe(1);
    const arch = { name: 'Tabung Jumaat Utama', public: true, jumaat: true, sortOrder: 1, archivedAt: '2026-11-10T02:00:00.000Z' };
    expect(code(() => putFundIn(s.db, a.id, arch, 'test'))).toEqual({ status: 409, code: 'balance_not_zero' });
    appendEntry(s.db, { id: 'e2', kind: 'out', entryDate: '2026-11-07', fundId: a.id, perihalId: s.perOut, amountSen: 1, method: 'bank', reference: 'FPX1' }, 'test', box);
    expect(fundBalance(s.db, a.id)).toBe(0);
    expect(putFundIn(s.db, a.id, arch, 'test').archivedAt).not.toBeNull();
  });

  it('the penceramah perihal cannot be renamed or archived', () => {
    const s = setup();
    expect(code(() => putPerihalIn(s.db, s.perPen, { direction: 'out', label: 'Ustaz', sortOrder: 1 }, 'test'))).toEqual({ status: 409, code: 'system_perihal' });
    expect(code(() => putPerihalIn(s.db, s.perPen, { direction: 'out', label: 'Penceramah', sortOrder: 1, archivedAt: '2026-11-10T02:00:00.000Z' }, 'test'))).toEqual({ status: 409, code: 'system_perihal' });
    expect(putPerihalIn(s.db, s.perOut, { direction: 'out', label: 'Bil utiliti', sortOrder: 2 }, 'test').label).toBe('Bil utiliti');
  });
});

describe('append-only ledger', () => {
  it('assigns K-0001, K-0002 and B-0001 on the box, and nothing on the cloud', () => {
    const s = setup();
    expect(appendEntry(s.db, cash(s, 'e1', 100000), 'test', box).refNo).toBe('K-0001');
    expect(appendEntry(s.db, cash(s, 'e2', 5000), 'test', box).refNo).toBe('K-0002');
    const pay = appendEntry(s.db, { id: 'e3', kind: 'out', entryDate: '2026-11-07', fundId: s.fundA, perihalId: s.perOut, amountSen: 4000, method: 'bank', reference: 'FPX9', payee: 'TNB' }, 'test', box);
    expect(pay.refNo).toBe('B-0001');
    expect(appendEntry(s.db, { ...cash(s, 'e4', 700), id: 'e4' }, 'test', cloud).refNo).toBeNull();
  });

  it('the same id with the same body is idempotent; a different amount is 409', () => {
    const s = setup();
    const first = appendEntry(s.db, cash(s, 'e1', 100000), 'test', box);
    const again = appendEntry(s.db, cash(s, 'e1', 100000), 'test', box);
    expect(again).toEqual(first);
    expect(listEntries(s.db)).toHaveLength(1);
    expect(code(() => appendEntry(s.db, cash(s, 'e1', 100001), 'test', box))).toEqual({ status: 409, code: 'entry_exists' });
    expect(listEntries(s.db)[0]!.amountSen).toBe(100000);
  });

  it('writes one change_log row per insert, without bytes, and bumps the version once', () => {
    const s = setup();
    const v0 = getVersion(s.db);
    appendEntry(s.db, cash(s, 'e1', 100000), 'test', box);
    expect(getVersion(s.db)).toBe(v0 + 1);
    const rows = s.db.prepare("SELECT before_json, after_json FROM change_log WHERE entity = 'finance:entry'").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before_json).toBeNull();
    const after = JSON.parse(String(rows[0]!.after_json)) as Record<string, unknown>;
    expect(after.amountSen).toBe(100000);
    expect(after.refNo).toBe('K-0001');
    expect(Object.keys(after).some((k) => /bytes|base64/i.test(k))).toBe(false);
    appendEntry(s.db, cash(s, 'e1', 100000), 'test', box); // a retry changes nothing
    expect(getVersion(s.db)).toBe(v0 + 1);
  });

  it('the database itself refuses an UPDATE of money columns, an UPDATE of a set ref_no, and every DELETE', () => {
    const s = setup();
    appendEntry(s.db, cash(s, 'e1', 100000), 'test', box);
    expect(() => s.db.exec("UPDATE finance_entries SET amount_sen = 1 WHERE id = 'e1'")).toThrow(/append-only/);
    expect(() => s.db.exec("UPDATE finance_entries SET note = 'x' WHERE id = 'e1'")).toThrow(/append-only/);
    expect(() => s.db.exec("UPDATE finance_entries SET ref_no = 'K-9999' WHERE id = 'e1'")).toThrow(/append-only/);
    expect(() => s.db.exec("DELETE FROM finance_entries WHERE id = 'e1'")).toThrow(/append-only/);
    expect(listEntries(s.db)[0]!.amountSen).toBe(100000);
  });

  it('ref_no and cloud_received_at can be filled once', () => {
    const s = setup();
    appendEntry(s.db, cash(s, 'e1', 100000), 'test', cloud);
    expect(setRefNoIfNull(s.db, 'e1', 'K-0007')).toBe(true);
    expect(setRefNoIfNull(s.db, 'e1', 'K-0008')).toBe(false);
    expect(listEntries(s.db)[0]!.refNo).toBe('K-0007');
    expect(setRefNoIfNull(s.db, 'e1', 'bad')).toBe(false);
    expect(setCloudReceived(s.db, 'e1', '2026-11-10T03:00:00.000Z')).toBe(true);
    expect(setCloudReceived(s.db, 'e1', '2026-11-10T04:00:00.000Z')).toBe(false);
    expect(listEntries(s.db)[0]!.cloudReceivedAt).toBe('2026-11-10T03:00:00.000Z');
  });

  it('refuses a counter who is not an active user, and a correction to an archived tabung', () => {
    const s = setup();
    const gone = createUser(s.db, { name: 'Lama', roles: ['ajk'] }, 'test').id;
    deactivateUser(s.db, gone, 'test');
    expect(code(() => appendEntry(s.db, cash(s, 'e1', 100, { counters: [{ userId: s.u1 }, { userId: gone }] }), 'test', box)).code).toBe('counter_unknown');
    expect(code(() => appendEntry(s.db, cash(s, 'e1', 100, { counters: [{ userId: s.u1 }, { userId: 'nobody' }] }), 'test', box)).code).toBe('counter_unknown');
    expect(appendEntry(s.db, cash(s, 'e1', 100, { counters: [{ userId: s.u1 }, { name: 'Tuan Haji Ali' }] }), 'test', box).refNo).toBe('K-0001');
    const empty = listFunds(s.db)[3]!;
    putFundIn(s.db, empty.id, { name: empty.name, public: false, archivedAt: '2026-11-10T02:00:00.000Z' }, 'test');
    const adj = { id: 'c1', kind: 'adjust', entryDate: '2026-11-10', fundId: s.fundA, correctsId: 'e1', correctionKind: 'fund', toFundId: empty.id, amountSen: 0, reason: 'Salah tabung: pindah' };
    expect(code(() => appendEntry(s.db, adj, 'test', box))).toEqual({ status: 409, code: 'fund_archived' });
    expect(appendEntry(s.db, { ...adj, toFundId: s.fundB }, 'test', box).refNo).toBe('P-0001');
  });

  it('a perihal of the wrong direction, an archived perihal and an unknown tabung are refused', () => {
    const s = setup();
    expect(code(() => appendEntry(s.db, cash(s, 'e1', 100, { perihalId: s.perOut }), 'test', box)).status).toBe(400);
    expect(code(() => appendEntry(s.db, cash(s, 'e1', 100, { fundId: 'nope' }), 'test', box)).status).toBe(400);
    putPerihalIn(s.db, s.perIn, { direction: 'in', label: 'Lama', sortOrder: 1, archivedAt: '2026-11-10T02:00:00.000Z' }, 'test');
    expect(code(() => appendEntry(s.db, cash(s, 'e1', 100), 'test', box)).code).toBe('perihal_archived');
  });
});

describe('penceramah payments', () => {
  function kuliahOn(db: DatabaseSync, date: string, status = 'aktif'): string {
    const p = putItem(db, 'penceramah', { name: 'Ustaz Ahmad' }, 'local');
    return putItem(db, 'kuliah', { date, slot: 'maghrib', time: '19:15', label: 'Kuliah Maghrib', penceramahId: p.item.id, status }, 'local').item.id;
  }
  const pay = (s: ReturnType<typeof setup>, id: string, extra: Record<string, unknown>) => ({
    id, kind: 'out', entryDate: '2026-11-10', fundId: s.fundA, perihalId: s.perPen, amountSen: 15000, method: 'tunai',
    counters: [{ userId: s.u1 }, { userId: s.u2 }], ...extra,
  });

  it('copies the penceramah from the kuliah and ignores the client copy', () => {
    const s = setup();
    const k = kuliahOn(s.db, '2026-11-10');
    const e = appendEntry(s.db, pay(s, 'p1', { kuliahId: k, penceramahName: 'Palsu' }), 'test', box);
    expect(e.penceramahName).toBe('Ustaz Ahmad');
    expect(e.kuliahId).toBe(k);
    expect(e.refNo).toBe('B-0001');
  });
  it('a future kuliah is 409, none is 400, a cancelled one is allowed, an unknown one is 404', () => {
    const s = setup();
    expect(code(() => appendEntry(s.db, pay(s, 'p1', { kuliahId: kuliahOn(s.db, '2026-11-11') }), 'test', box))).toEqual({ status: 409, code: 'kuliah_future' });
    expect(code(() => appendEntry(s.db, pay(s, 'p1', {}), 'test', box)).status).toBe(400);
    expect(code(() => appendEntry(s.db, pay(s, 'p1', { kuliahId: 'nope' }), 'test', box)).status).toBe(404);
    expect(appendEntry(s.db, pay(s, 'p2', { kuliahId: kuliahOn(s.db, '2026-11-08', 'batal') }), 'test', box).refNo).toBe('B-0001');
  });
});

describe('months', () => {
  it('an entry dated in a closed month is 409; a correction dated today against it is accepted', () => {
    const s = setup();
    appendEntry(s.db, cash(s, 'e1', 100000, { entryDate: '2026-10-30' }), 'test', box);
    const ctx = { now: NOW, role: 'box' as const, freeze: () => '{"frozen":true}' };
    putMonthIn(s.db, '2026-10', { status: 'closed' }, 'test', ctx);
    expect(code(() => appendEntry(s.db, cash(s, 'e2', 100, { entryDate: '2026-10-31' }), 'test', box))).toEqual({ status: 409, code: 'month_closed' });
    const c = appendEntry(s.db, { id: 'c1', kind: 'adjust', entryDate: '2026-11-10', fundId: s.fundA, correctsId: 'e1', correctionKind: 'amount', amountSen: 90000, reason: 'Salah taip jumlah: 900' }, 'test', box);
    expect(c.refNo).toBe('P-0001');
    expect(fundBalance(s.db, s.fundA)).toBe(90000);
    const row = s.db.prepare("SELECT report_json FROM finance_months WHERE ym = '2026-10'").get();
    expect(row!.report_json).toBe('{"frozen":true}');
  });
  it('closing November before October is 409 month_order; October first works; reopening clears the frozen report', () => {
    const s = setup();
    appendEntry(s.db, cash(s, 'e1', 100000, { entryDate: '2026-10-30' }), 'test', box);
    appendEntry(s.db, cash(s, 'e2', 100, { entryDate: '2026-11-02' }), 'test', box);
    const ctx = { now: NOW, role: 'box' as const, freeze: () => '{}' };
    expect(code(() => putMonthIn(s.db, '2026-11', { status: 'closed' }, 'test', ctx)).code).toBe('month_order');
    putMonthIn(s.db, '2026-10', { status: 'closed' }, 'test', ctx);
    expect(putMonthIn(s.db, '2026-11', { status: 'closed' }, 'test', ctx).status).toBe('closed');
    expect(putMonthIn(s.db, '2026-11', { status: 'open' }, 'test', ctx).status).toBe('open');
    expect(s.db.prepare("SELECT report_json FROM finance_months WHERE ym = '2026-11'").get()!.report_json).toBeNull();
    expect(listMonths(s.db).map((m) => m.status)).toEqual(['closed', 'open']);
    expect(code(() => putMonthIn(s.db, '2026-12', { status: 'closed' }, 'test', ctx)).status).toBe(400);
  });
});

describe('getEntry', () => {
  it('returns the chain in (editedAt, id) order with the effective state', () => {
    const s = setup();
    appendEntry(s.db, cash(s, 'e1', 100000), 'test', box);
    const adj = (id: string, at: string, amount: number) => ({ id, kind: 'adjust', entryDate: '2026-11-10', fundId: s.fundA, correctsId: 'e1', correctionKind: 'amount', amountSen: amount, reason: 'Kiraan semula: x' });
    appendEntry(s.db, adj('c-b', '', 80000), 'test', box, { editedAt: '2026-11-10T02:00:00.000Z' });
    appendEntry(s.db, adj('c-a', '', 70000), 'test', box, { editedAt: '2026-11-10T02:00:00.000Z' });
    appendEntry(s.db, adj('c-0', '', 60000), 'test', box, { editedAt: '2026-11-10T01:00:00.000Z' });
    const got = getEntry(s.db, 'e1')!;
    expect(got.corrections.map((c) => c.id)).toEqual(['c-0', 'c-a', 'c-b']);
    expect(got.effective.effAmountSen).toBe(80000);
    expect(getEntry(s.db, 'c-a')).toBeNull();
    expect(financeCounts(s.db).entries).toBe(4);
    expect(tx(s.db, () => 1)).toBe(1);
  });
});

describe('entry numbers never collide', () => {
  const pull = (s: ReturnType<typeof setup>, n: number, ref: string | undefined) => insertReplicatedEntry(
    s.db,
    { kind: 'in', entryDate: '2026-11-06', fundId: s.fundA, perihalId: s.perIn, amountSen: 1000 * n, method: 'tunai', counters: [{ userId: s.u1 }, { userId: s.u2 }], ...(ref === undefined ? {} : { refNo: ref }) },
    `r${n}-${ref ?? 'x'}`, 'user:test', box, { editedAt: `2026-11-06T0${n}:00:00.000Z`, origin: 'cloud' },
  );

  it('pulling K-0001..K-0005 into an empty box lifts the counter so a local entry is K-0006', () => {
    const s = setup();
    for (let n = 1; n <= 5; n++) pull(s, n, `K-000${n}`);
    expect(listEntries(s.db).map((e) => e.refNo).sort()).toEqual(['K-0001', 'K-0002', 'K-0003', 'K-0004', 'K-0005']);
    expect(appendEntry(s.db, cash(s, 'local1', 5000), 'test', box).refNo).toBe('K-0006');
  });

  it('a counter set too low skips numbers already taken', () => {
    const s = setup();
    for (let n = 1; n <= 3; n++) pull(s, n, `K-000${n}`);
    s.db.prepare("UPDATE finance_counters SET next = 1 WHERE letter = 'K'").run();
    expect(appendEntry(s.db, cash(s, 'local1', 5000), 'test', box).refNo).toBe('K-0004');
    expect(appendEntry(s.db, cash(s, 'local2', 6000), 'test', box).refNo).toBe('K-0005');
  });

  it('a replicated entry whose ref is taken gets a fresh free number without throwing', () => {
    const s = setup();
    appendEntry(s.db, cash(s, 'local1', 5000), 'test', box);
    const e = pull(s, 2, 'K-0001');
    expect(e.refNo).toBe('K-0002');
    expect(appendEntry(s.db, cash(s, 'local2', 6000), 'test', box).refNo).toBe('K-0003');
  });
});

describe('correction rules', () => {
  const adj = (s: ReturnType<typeof setup>, over: Record<string, unknown>) => ({
    id: 'c1', kind: 'adjust', entryDate: '2026-11-10', fundId: s.fundA, correctsId: 'e1', correctionKind: 'amount', amountSen: 90000,
    reason: 'Salah taip jumlah: 900', ...over,
  });

  it('refuses an amount or void correction while the original tabung is archived; a fund move out of it is allowed', () => {
    const s = setup();
    appendEntry(s.db, cash(s, 'e1', 100000, { fundId: listFunds(s.db)[3]!.id }), 'test', box);
    const f = listFunds(s.db)[3]!;
    // archived with money in it can only arrive by replication (trusted)
    putFundIn(s.db, f.id, { name: f.name, public: false, archivedAt: '2026-11-10T02:00:00.000Z' }, 'test', { trusted: true });
    expect(code(() => appendEntry(s.db, adj(s, {}), 'test', box))).toEqual({ status: 409, code: 'fund_archived' });
    expect(code(() => appendEntry(s.db, adj(s, { correctionKind: 'void', amountSen: 0 }), 'test', box))).toEqual({ status: 409, code: 'fund_archived' });
    expect(appendEntry(s.db, adj(s, { correctionKind: 'fund', toFundId: s.fundB, amountSen: 0, reason: 'Salah tabung: pindah' }), 'test', box).refNo).toBe('P-0001');
    // now it sits in an active tabung, so an amount correction is fine again
    expect(appendEntry(s.db, adj(s, { id: 'c2' }), 'test', box).correctionKind).toBe('amount');
  });

  it('refuses a correction dated before its original; the same day and later are allowed', () => {
    const s = setup();
    appendEntry(s.db, cash(s, 'e1', 100000, { entryDate: '2026-11-06' }), 'test', box);
    expect(code(() => appendEntry(s.db, adj(s, { entryDate: '2026-11-05' }), 'test', box))).toEqual({ status: 409, code: 'correction_before_original' });
    expect(appendEntry(s.db, adj(s, { entryDate: '2026-11-06' }), 'test', box).id).toBe('c1');
    expect(appendEntry(s.db, adj(s, { id: 'c2', entryDate: '2026-11-09', amountSen: 80000 }), 'test', box).id).toBe('c2');
    expect(fundBalance(s.db, s.fundA)).toBe(80000);
  });
});

describe('month order holds both ways', () => {
  const ctx = { now: NOW, role: 'box' as const, freeze: () => '{}' };
  const adj = (s: ReturnType<typeof setup>, over: Record<string, unknown>) => ({
    id: 'c1', kind: 'adjust', entryDate: '2026-10-31', fundId: s.fundA, correctsId: 'e1', correctionKind: 'amount', amountSen: 90000,
    reason: 'Salah taip jumlah: 900', ...over,
  });

  it('a reopen is refused while a later month is closed; reopening in reverse order works', () => {
    const s = setup();
    appendEntry(s.db, cash(s, 'e1', 100000, { entryDate: '2026-10-30' }), 'test', box);
    appendEntry(s.db, cash(s, 'e2', 100, { entryDate: '2026-11-02' }), 'test', box);
    putMonthIn(s.db, '2026-10', { status: 'closed' }, 'test', ctx);
    putMonthIn(s.db, '2026-11', { status: 'closed' }, 'test', ctx);
    expect(code(() => putMonthIn(s.db, '2026-10', { status: 'open' }, 'test', ctx))).toEqual({ status: 409, code: 'later_month_closed' });
    expect(listMonths(s.db).map((m) => m.status)).toEqual(['closed', 'closed']);
    expect(putMonthIn(s.db, '2026-11', { status: 'open' }, 'test', ctx).status).toBe('open');
    expect(putMonthIn(s.db, '2026-10', { status: 'open' }, 'test', ctx).status).toBe('open');
    expect(appendEntry(s.db, cash(s, 'e5', 100, { entryDate: '2026-10-31' }), 'test', box).id).toBe('e5');
  });

  it('an entry or correction dated in an open month is refused while a later month is closed; the closed month and a later one still behave', () => {
    const s = setup();
    appendEntry(s.db, cash(s, 'e1', 100000, { entryDate: '2026-10-30' }), 'test', box);
    appendEntry(s.db, cash(s, 'e2', 100, { entryDate: '2026-11-02' }), 'test', box);
    putMonthIn(s.db, '2026-10', { status: 'closed' }, 'test', ctx);
    putMonthIn(s.db, '2026-11', { status: 'closed' }, 'test', ctx);
    putMonthIn(s.db, '2026-10', { status: 'open' }, 'test', ctx, { trusted: true }); // a replicated reopen leaves October open under a closed November
    expect(code(() => appendEntry(s.db, cash(s, 'e3', 100, { entryDate: '2026-10-31' }), 'test', box))).toEqual({ status: 409, code: 'later_month_closed' });
    expect(code(() => appendEntry(s.db, adj(s, {}), 'test', box))).toEqual({ status: 409, code: 'later_month_closed' });
    expect(code(() => appendEntry(s.db, cash(s, 'e4', 100, { entryDate: '2026-11-03' }), 'test', box)).code).toBe('month_closed');
  });
});
