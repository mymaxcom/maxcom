import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  balances, effective, formatRm, monthIn, monthOut, klInstant, lastPenceramahPayment, monthReport, parseRm, refLetter, resolveSettings,
  isMonthReport, tempRefLabel, validateEntryShape, validateFeatureSettings, validateLookup, validateMonth,
} from '../src/index.ts';
import type { FinanceEntry, Fund, Perihal, KioskContent } from '../src/index.ts';
import { buildRotation } from '../src/content/rotation.ts';

interface Vectors {
  funds: { id: string; name: string; sortOrder: number }[];
  perihal: { id: string; direction: 'in' | 'out'; label: string }[];
  scenarios: {
    name: string; ym?: string; entries: Partial<FinanceEntry>[]; balances: Record<string, number>; month?: { inSen: number; outSen: number };
    report?: { now: string; syncedUntil: string | null; status: 'open' | 'closed'; expected: unknown };
  }[];
  money: { format: [number, string][]; formatParens: [number, string][]; parse: [string, number | null][] };
}
const vectors = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/finance-vectors.json', import.meta.url)), 'utf8')) as Vectors;

const full = (e: Partial<FinanceEntry>): FinanceEntry => ({
  id: '', kind: 'in', entryDate: '2026-10-01', fundId: 'f1', perihalId: null, amountSen: 0, method: null, reference: null,
  note: null, payee: null, counters: null, denominations: null, photoId: null, kuliahId: null, penceramahId: null,
  penceramahName: null, correctsId: null, correctionKind: null, toFundId: null, reason: null, refNo: null,
  createdBy: 'u1', deviceId: null, editedAt: '2026-10-01T00:00:00.000Z', receivedAt: e.editedAt ?? '2026-10-01T00:00:00.000Z',
  cloudReceivedAt: null, ...e,
});
const funds: Fund[] = vectors.funds.map((f) => ({
  id: f.id, name: f.name, public: true, targetSen: null, jumaat: false, sortOrder: f.sortOrder, archivedAt: null,
  updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: 'u1',
}));
const perihal: Perihal[] = vectors.perihal.map((p, i) => ({
  id: p.id, direction: p.direction, label: p.label, system: null, sortOrder: i, archivedAt: null,
  updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: 'u1',
}));

describe('money', () => {
  it('formats sen as RM with grouping', () => {
    for (const [sen, text] of vectors.money.format) expect(formatRm(sen)).toBe(text);
    for (const [sen, text] of vectors.money.formatParens) expect(formatRm(sen, { parens: true })).toBe(text);
    expect(formatRm(-1800)).toBe('-RM 18.00');
  });
  it('refuses a fractional sen amount', () => {
    expect(() => formatRm(1.5)).toThrow();
  });
  it('parses what a person types, exactly', () => {
    for (const [text, sen] of vectors.money.parse) expect(parseRm(text), text).toBe(sen);
  });
  it('1,356.80 is 135680 and never a float', () => {
    expect(parseRm('1,356.80')).toBe(135680);
    expect(parseRm('0.07')).toBe(7);
    expect(parseRm('19.99')).toBe(1999);
  });
});

const TODAY = '2026-11-10';
const cashIn = {
  id: 'e1', kind: 'in', entryDate: '2026-11-06', fundId: 'f1', perihalId: 'in-j', amountSen: 135680, method: 'tunai',
  counters: [{ userId: 'u1' }, { name: 'Tuan Haji Ali' }],
};

describe('validateEntryShape', () => {
  const ok = (v: unknown) => validateEntryShape(v, { todayKl: TODAY });
  it('accepts a valid cash collection and keeps integers', () => {
    const r = ok(cashIn);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.value.amountSen).toBe(135680); expect(r.value.reference).toBeNull(); expect(r.value.counters).toHaveLength(2); }
  });
  it('accepts a bank collection with a reference and no counters', () => {
    expect(ok({ ...cashIn, method: 'bank', counters: undefined, reference: 'FPX 12345' }).ok).toBe(true);
  });
  it('refuses one or three counters, or the same person twice', () => {
    expect(ok({ ...cashIn, counters: [{ userId: 'u1' }] }).ok).toBe(false);
    expect(ok({ ...cashIn, counters: [{ userId: 'u1' }, { userId: 'u2' }, { name: 'X' }] }).ok).toBe(false);
    expect(ok({ ...cashIn, counters: [{ userId: 'u1' }, { userId: 'u1' }] }).ok).toBe(false);
  });
  it('non-cash: counters refused, reference required', () => {
    expect(ok({ ...cashIn, method: 'bank', reference: 'FPX 1' }).ok).toBe(false);
    expect(ok({ ...cashIn, method: 'bank', counters: undefined }).ok).toBe(false);
    expect(ok({ ...cashIn, method: 'bank', counters: undefined, reference: 'ab' }).ok).toBe(false);
  });
  it('cash with a reference is refused', () => {
    expect(ok({ ...cashIn, reference: 'FPX123' }).ok).toBe(false);
  });
  it('denominations must add up to the amount, to the sen', () => {
    const d = { '100': 13, '50': 1, '5': 1, '1': 1, coinsSen: 80 };
    expect(ok({ ...cashIn, denominations: d }).ok).toBe(true);
    expect(ok({ ...cashIn, denominations: { ...d, coinsSen: 79 } }).ok).toBe(false);
    expect(ok({ ...cashIn, denominations: { ...d, '2': 1 } }).ok).toBe(false);
    expect(ok({ ...cashIn, denominations: { ...d, '1': -1 } }).ok).toBe(false);
  });
  const adj = {
    id: 'c1', kind: 'adjust', entryDate: '2026-11-08', fundId: 'f1', correctsId: 'e1', correctionKind: 'amount',
    amountSen: 100000, reason: 'Kiraan semula: 1000',
  };
  it('a reason of 14 characters fails and 15 passes (after trim)', () => {
    expect(ok({ ...adj, reason: '12345678901234' }).ok).toBe(false);
    expect(ok({ ...adj, reason: '123456789012345' }).ok).toBe(true);
    expect(ok({ ...adj, reason: '  12345678901234  ' }).ok).toBe(false);
    expect(ok({ ...adj, reason: 'x'.repeat(501) }).ok).toBe(false);
  });
  it('a correction carries no perihal, method or counters; a tabung change needs a different tabung', () => {
    expect(ok({ ...adj, perihalId: 'in-j' }).ok).toBe(false);
    expect(ok({ ...adj, method: 'tunai' }).ok).toBe(false);
    expect(ok({ ...adj, correctionKind: 'fund', amountSen: 0, toFundId: 'f1' }).ok).toBe(false);
    expect(ok({ ...adj, correctionKind: 'fund', amountSen: 0, toFundId: 'f2' }).ok).toBe(true);
    expect(ok({ ...adj, correctionKind: 'void', amountSen: 0 }).ok).toBe(true);
  });
  it('dates: not future, not before the previous month, real', () => {
    expect(ok({ ...cashIn, entryDate: '2026-09-30' }).ok).toBe(false);
    expect(ok({ ...cashIn, entryDate: '2026-10-01' }).ok).toBe(true);
    expect(ok({ ...cashIn, entryDate: '2026-11-11' }).ok).toBe(false);
    expect(ok({ ...cashIn, entryDate: '2026-02-30' }).ok).toBe(false);
  });
  it('refuses an unknown key', () => {
    expect(ok({ ...cashIn, refNo: 'K-0001' }).ok).toBe(false);
    expect(ok({ ...cashIn, createdBy: 'u9' }).ok).toBe(false);
  });
  it('amount rules: 0 refused for in and out, allowed for opening; floats, strings and negatives refused', () => {
    expect(ok({ ...cashIn, amountSen: 0 }).ok).toBe(false);
    expect(ok({ id: 'o1', kind: 'opening', entryDate: '2026-11-01', fundId: 'f1', amountSen: 0 }).ok).toBe(true);
    for (const bad of [2.5, '100', -1, 1e5 + 0.5, 1_000_000_001, Number.NaN, null]) {
      expect(ok({ ...cashIn, amountSen: bad }).ok, String(bad)).toBe(false);
    }
  });
  it('an opening balance has no perihal or method', () => {
    expect(ok({ id: 'o1', kind: 'opening', entryDate: '2026-11-01', fundId: 'f1', amountSen: 5, method: 'tunai' }).ok).toBe(false);
  });
  it('rejects markup in text fields and a bad photo id', () => {
    expect(ok({ ...cashIn, note: '<b>x</b>' }).ok).toBe(false);
    expect(ok({ ...cashIn, photoId: 'a'.repeat(63) }).ok).toBe(false);
    expect(ok({ ...cashIn, photoId: 'a'.repeat(64) }).ok).toBe(true);
    expect(ok({ ...cashIn, id: '../x' }).ok).toBe(false);
  });
});

describe('lookup and month shapes', () => {
  it('validates a fund and a perihal body, refuses unknown keys and a client-set system', () => {
    expect(validateLookup('fund', { name: 'Tabung Jumaat', public: true, targetSen: 5000000 }).ok).toBe(true);
    expect(validateLookup('fund', { name: '', public: true }).ok).toBe(false);
    expect(validateLookup('fund', { name: 'A', targetSen: 1.5 }).ok).toBe(false);
    expect(validateLookup('fund', { name: 'A', x: 1 }).ok).toBe(false);
    expect(validateLookup('perihal', { direction: 'out', label: 'Utiliti' }).ok).toBe(true);
    expect(validateLookup('perihal', { direction: 'out', label: 'Utiliti', system: 'penceramah' }).ok).toBe(false);
    expect(validateLookup('perihal', { direction: 'sideways', label: 'x' }).ok).toBe(false);
  });
  it('validates a month body: a real month, not in the future', () => {
    expect(validateMonth({ ym: '2026-10', status: 'closed' }, { todayKl: TODAY }).ok).toBe(true);
    expect(validateMonth({ ym: '2026-12', status: 'closed' }, { todayKl: TODAY }).ok).toBe(false);
    expect(validateMonth({ ym: '2026-13', status: 'open' }, { todayKl: TODAY }).ok).toBe(false);
    expect(validateMonth({ ym: '2026-10', status: 'done' }, { todayKl: TODAY }).ok).toBe(false);
  });
});

describe('ledger vectors', () => {
  for (const sc of vectors.scenarios) {
    it(`${sc.name}: balances`, () => {
      expect(balances(sc.entries.map(full), funds)).toEqual(sc.balances);
    });
  }
  it('effective keeps the corrections in (editedAt, id) order', () => {
    const sc = vectors.scenarios.find((s) => s.name.startsWith('8'))!;
    const eff = effective(sc.entries.map(full));
    expect(eff).toHaveLength(1);
    expect(eff[0]!.corrections.map((c) => c.id)).toEqual(['adj-a', 'adj-b']);
    expect(eff[0]!.effAmountSen).toBe(20000);
  });
  it('the month report of vector 10 equals the pinned JSON', () => {
    const sc = vectors.scenarios.find((s) => s.name.startsWith('10'))!;
    const rep = monthReport({
      ym: sc.ym!, entries: sc.entries.map(full), funds, perihal, kuliahTitles: {}, now: sc.report!.now,
      syncedUntil: sc.report!.syncedUntil, status: sc.report!.status,
    });
    expect(rep).toEqual(sc.report!.expected);
  });
  it('isMonthReport accepts what monthReport makes and refuses a wrong shape', () => {
    const sc = vectors.scenarios.find((s) => s.name.startsWith('10'))!;
    const rep = monthReport({
      ym: sc.ym!, entries: sc.entries.map(full), funds, perihal, kuliahTitles: {}, now: sc.report!.now,
      syncedUntil: sc.report!.syncedUntil, status: sc.report!.status,
    });
    expect(isMonthReport(JSON.parse(JSON.stringify(rep)))).toBe(true);
    for (const bad of [null, 'x', {}, { ...rep, totals: null }, { ...rep, funds: 'x' }, { ...rep, ym: 'x' }, { ...rep, status: 'shut' },
      { ...rep, funds: [{ ...rep.funds[0], closingSen: '1' }] }, { ...rep, corrections: [{ id: 'a' }] }]) {
      expect(isMonthReport(bad)).toBe(false);
    }
  });
  it('month totals use effective amounts: voids drop out and corrected amounts count (vector 13)', () => {
    const sc = vectors.scenarios.find((s) => s.name.startsWith('13'))!;
    const entries = sc.entries.map(full);
    expect(monthIn(entries, sc.ym!)).toBe(sc.month!.inSen);
    expect(monthOut(entries, sc.ym!)).toBe(sc.month!.outSen);
    // an uncorrected ledger is unchanged: the plain posted sums
    expect(monthIn(entries.filter((e) => e.kind !== 'adjust'), sc.ym!)).toBe(170000);
  });
  it('a report always adds up, per tabung', () => {
    for (const sc of vectors.scenarios) {
      const rep = monthReport({ ym: '2026-10', entries: sc.entries.map(full), funds, perihal, kuliahTitles: {}, now: 'x', syncedUntil: null, status: 'open' });
      for (const f of rep.funds) expect(f.openingSen + f.inSen - f.outSen + f.correctionsSen).toBe(f.closingSen);
    }
  });
  it('a correction posted in October never changes September', () => {
    const sc = vectors.scenarios.find((s) => s.name.startsWith('10'))!;
    const sep = monthReport({ ym: '2026-09', entries: sc.entries.map(full), funds, perihal, kuliahTitles: {}, now: 'x', syncedUntil: null, status: 'closed' });
    expect(sep.funds[0]).toMatchObject({ fundId: 'f1', openingSen: 100000, inSen: 50000, outSen: 20000, correctionsSen: 0, closingSen: 130000 });
    expect(sep.corrections).toEqual([]);
  });
  it('tells a penceramah payment from the rest and returns the corrected amount', () => {
    const pay = (id: string, date: string, sen: number, pid: string, at: string): FinanceEntry =>
      full({ id, kind: 'out', entryDate: date, amountSen: sen, penceramahId: pid, editedAt: at });
    const es = [
      pay('p1', '2026-10-02', 15000, 'pen1', '2026-10-02T01:00:00.000Z'),
      pay('p2', '2026-10-09', 20000, 'pen1', '2026-10-09T01:00:00.000Z'),
      pay('p3', '2026-10-09', 99999, 'pen2', '2026-10-09T02:00:00.000Z'),
      full({ id: 'c1', kind: 'adjust', correctsId: 'p2', correctionKind: 'amount', amountSen: 25000, entryDate: '2026-10-10', editedAt: '2026-10-10T01:00:00.000Z', reason: 'Kiraan semula: 250' }),
    ];
    expect(lastPenceramahPayment(es, 'pen1')).toMatchObject({ id: 'p2', amountSen: 25000 });
    expect(lastPenceramahPayment(es, 'pen9')).toBeNull();
    es.push(full({ id: 'c2', kind: 'adjust', correctsId: 'p2', correctionKind: 'void', entryDate: '2026-10-11', editedAt: '2026-10-11T01:00:00.000Z', reason: 'Dibayar dua kali' }));
    expect(lastPenceramahPayment(es, 'pen1')).toMatchObject({ id: 'p1', amountSen: 15000 });
  });
  it('reference labels', () => {
    expect(refLetter('in')).toBe('K');
    expect(refLetter('out')).toBe('B');
    expect(refLetter('adjust')).toBe('P');
    expect(refLetter('opening')).toBe('A');
    expect(tempRefLabel('01HXYZABC12345678900ABCD')).toBe('K-ABCD');
  });
});

describe('finance settings and the tabung card slot', () => {
  it('validates tabungCard rows as whole sen and the figure as an enum', () => {
    expect(validateFeatureSettings('tabungCard', { row1Sen: -1 }).ok).toBe(false);
    expect(validateFeatureSettings('tabungCard', { row1Sen: 1.5 }).ok).toBe(false);
    expect(validateFeatureSettings('tabungCard', { figure: 'x' }).ok).toBe(false);
    expect(validateFeatureSettings('tabungCard', { highlightSeconds: 121 }).ok).toBe(false);
    expect(validateFeatureSettings('tabungCard', { qrAssetId: 'nothex' }).ok).toBe(false);
    expect(validateFeatureSettings('tabungCard', { row1Sen: 135680, row1Label: 'Kutipan Jumaat 06/11/2026' }).ok).toBe(true);
    expect(validateFeatureSettings('tabungCard', { figure: 'month', highlightSeconds: 0, qrAssetId: 'a'.repeat(64) }).ok).toBe(true);
    expect(validateFeatureSettings('finance', { bigAmountSen: 2000000, startedOn: '2026-11-01', penceramahFundId: 'f1' }).ok).toBe(true);
    expect(validateFeatureSettings('finance', { startedOn: '1 Nov' }).ok).toBe(false);
    expect(validateFeatureSettings('finance', { bigAmountSen: -5 }).ok).toBe(false);
  });
  const view = { title: 'Tabung Surau', manual: false, figure: 'balance' as const, updatedAt: null, qrAssetId: null,
    rows: [{ id: 'f1', name: 'Tabung Jumaat', valueSen: 1000, subLabel: null, subSen: null, targetSen: null, highlightUntil: null }] };
  const content = (tabung?: KioskContent['tabung']): KioskContent => ({
    date: '2026-11-03', kuliah: [], pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [], hadisToday: [],
    worldTimes: [], tugasan: [], ayat: { today: null, tomorrow: null }, zikir: [], tilawah: { slots: [], available: {} },
    credits: { translation: '', font: '', audio: '' }, ...(tabung === undefined ? {} : { tabung }),
  });
  const now = klInstant('2026-11-03', '15:00');
  it('gives one tabungCard slot when the card is on and has rows', () => {
    const on = resolveSettings({ tabungCard: { enabled: true } });
    expect(buildRotation(content(view), on, now).map((s) => s.feature)).toEqual(['tabungCard']);
    expect(buildRotation(content({ ...view, rows: [] }), on, now)).toEqual([]);
    expect(buildRotation(content(null), on, now)).toEqual([]);
    expect(buildRotation(content(), on, now)).toEqual([]);
  });
  it('gives none when tabungCard is switched off', () => {
    const off = resolveSettings({ tabungCard: { enabled: false } });
    expect(buildRotation(content(view), off, now)).toEqual([]);
  });
});
