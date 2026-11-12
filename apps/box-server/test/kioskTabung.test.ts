import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { klInstant } from '@surau/core';
import { openDb } from '../src/db.ts';
import { createUser } from '../src/auth/users.ts';
import { buildKioskContent } from '../src/kioskContent.ts';
import { appendEntry, ensureSeeded, listFunds, listPerihal, putFundIn } from '../src/finance/store.ts';
import { getSettings, putFeature } from '../src/settingsStore.ts';

const dbs: DatabaseSync[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T0 = klInstant('2026-11-10', '10:00');
const at = (sec: number): Date => new Date(T0.getTime() + sec * 1000);

function rig() {
  const db = openDb(':memory:');
  dbs.push(db);
  const dir = mkdtempSync(join(tmpdir(), 'surau-tab-'));
  dirs.push(dir);
  putFeature(db, 'finance', { enabled: true }, 'test');
  putFeature(db, 'tabungCard', { enabled: true }, 'test');
  ensureSeeded(db, 'test', T0);
  const funds = listFunds(db);
  const perIn = listPerihal(db).find((p) => p.direction === 'in')!.id;
  const u = createUser(db, { name: 'Bendahari', roles: ['treasurer'] }, 'test').id;
  const put = (id: string, fundId: string, sen: number, date = '2026-11-06', when = T0, extra: Record<string, unknown> = {}) =>
    appendEntry(db, { id, kind: 'in', entryDate: date, fundId, perihalId: perIn, amountSen: sen, method: 'bank', reference: 'FPX1', ...extra }, 'user:x', { now: when, role: 'box' });
  const content = (now: Date) => buildKioskContent(db, dir, now, getSettings(db));
  return { db, funds, put, content, u };
}

describe('kiosk tabung block', () => {
  it('lists the public tabung only, with balances equal to the ledger', () => {
    const r = rig();
    r.put('e1', r.funds[0]!.id, 135680);
    r.put('e2', r.funds[1]!.id, 5000);
    r.put('e3', r.funds[3]!.id, 777); // Khairat Kematian: not public
    const t = r.content(at(3600)).tabung!;
    expect(t.manual).toBe(false);
    expect(t.rows.map((x) => x.name)).toEqual(['Tabung Jumaat', 'Tabung Am', 'Tabung Pembangunan']);
    expect(t.rows.map((x) => x.valueSen)).toEqual([135680, 5000, 0]);
    expect(t.rows[0]).toMatchObject({ subLabel: 'Kutipan Jumaat terakhir', subSen: 135680 });
    expect(t.rows[1]).toMatchObject({ subLabel: 'Bulan ini', subSen: 5000 });
    expect(JSON.stringify(t)).not.toContain('777');
  });

  it('highlights the tabung that just changed for 20 seconds, then not', () => {
    const r = rig();
    r.put('e1', r.funds[0]!.id, 100, '2026-11-06', at(0));
    const soon = r.content(at(10)).tabung!;
    expect(soon.rows[0]!.highlightUntil).toBe(at(20).toISOString());
    expect(soon.rows[1]!.highlightUntil).toBeNull();
    expect(r.content(at(30)).tabung!.rows[0]!.highlightUntil).toBeNull();
    putFeature(r.db, 'tabungCard', { highlightSeconds: 0 }, 'test');
    expect(r.content(at(10)).tabung!.rows[0]!.highlightUntil).toBeNull();
  });

  it('a correction on the box lights the tabung too, and the figure follows the corrected amount', () => {
    const r = rig();
    r.put('e1', r.funds[0]!.id, 10000, '2026-11-06', at(0));
    appendEntry(r.db, { id: 'c1', kind: 'adjust', entryDate: '2026-11-10', fundId: r.funds[0]!.id, correctsId: 'e1', correctionKind: 'amount', amountSen: 9000, reason: 'Salah taip jumlah: 90' }, 'user:x', { now: at(100), role: 'box' });
    const t = r.content(at(105)).tabung!;
    expect(t.rows[0]!.valueSen).toBe(9000);
    expect(t.rows[0]!.highlightUntil).toBe(at(120).toISOString());
  });

  it("the 'month' figure is this month's net; 'lastEntry' is the last collection; a target replaces the small line", () => {
    const r = rig();
    const f = r.funds[1]!;
    r.put('o1', f.id, 50000, '2026-10-30');
    r.put('e1', f.id, 3000, '2026-11-02');
    r.put('e2', f.id, 700, '2026-11-05');
    appendEntry(r.db, { id: 'x1', kind: 'out', entryDate: '2026-11-06', fundId: f.id, perihalId: listPerihal(r.db).find((p) => p.label === 'Utiliti')!.id, amountSen: 200, method: 'bank', reference: 'FPX2' }, 'user:x', { now: T0, role: 'box' });
    putFeature(r.db, 'tabungCard', { figure: 'month' }, 'test');
    expect(r.content(at(60)).tabung!.rows[1]!.valueSen).toBe(3000 + 700 - 200);
    putFeature(r.db, 'tabungCard', { figure: 'lastEntry' }, 'test');
    expect(r.content(at(60)).tabung!.rows[1]!.valueSen).toBe(700);
    putFundIn(r.db, f.id, { name: f.name, public: true, jumaat: false, targetSen: 100000, sortOrder: f.sortOrder }, 'test');
    putFeature(r.db, 'tabungCard', { figure: 'balance' }, 'test');
    const row = r.content(at(60)).tabung!.rows[1]!;
    expect(row).toMatchObject({ valueSen: 50000 + 3000 + 700 - 200, targetSen: 100000, subLabel: null });
    putFeature(r.db, 'tabungCard', { showTarget: false }, 'test');
    expect(r.content(at(60)).tabung!.rows[1]).toMatchObject({ targetSen: null, subLabel: 'Bulan ini' });
  });

  it("'lastEntry' breaks a tie of date and edit time by id, whatever order the rows were written in", () => {
    for (const order of [['a1', 'b1'], ['b1', 'a1']]) {
      const r = rig();
      const f = r.funds[1]!;
      for (const id of order) r.put(id, f.id, id === 'b1' ? 700 : 300, '2026-11-05', T0);
      putFeature(r.db, 'tabungCard', { figure: 'lastEntry' }, 'test');
      expect(r.content(at(60)).tabung!.rows[1]!.valueSen).toBe(700);
    }
  });

  it('finance off with typed rows gives the manual card; the card off gives null', () => {
    const r = rig();
    r.put('e1', r.funds[0]!.id, 100);
    putFeature(r.db, 'finance', { enabled: false }, 'test');
    putFeature(r.db, 'tabungCard', { manualTitle: 'Tabung Masjid', row1Label: 'Kutipan Jumaat 06/11/2026', row1Sen: 135680, row2Label: 'Derma Pembangunan', row2Sen: 2500000, row3Label: '   ' }, 'test');
    const t = r.content(at(5)).tabung!;
    expect(t.manual).toBe(true);
    expect(t.title).toBe('Tabung Masjid');
    expect(t.rows.map((x) => [x.name, x.valueSen])).toEqual([['Kutipan Jumaat 06/11/2026', 135680], ['Derma Pembangunan', 2500000]]);
    expect(t.updatedAt).not.toBeNull();
    putFeature(r.db, 'tabungCard', { enabled: false }, 'test');
    expect(r.content(at(5)).tabung).toBeNull();
  });

  it('only a 64-hex picture id becomes the QR', () => {
    const r = rig();
    expect(r.content(at(5)).tabung!.qrAssetId).toBeNull();
    putFeature(r.db, 'tabungCard', { qrAssetId: 'd'.repeat(64) }, 'test');
    expect(r.content(at(5)).tabung!.qrAssetId).toBe('d'.repeat(64));
  });
});
