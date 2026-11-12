/**
 * The ledger as a pure function of its rows. The Dart port (apps/surau-app/lib/finance/ledger.dart) must give the
 * same figures for every scenario in test/fixtures/finance-vectors.json. All arithmetic is on integer sen.
 */

import type {
  EffectiveEntry, EntryKind, FinanceEntry, Fund, MonthReport, Perihal, ReportCorrection, ReportFundRow,
  ReportGroup, ReportInRow, ReportOutRow,
} from './types.ts';

const ORIGINALS: readonly EntryKind[] = ['in', 'out', 'opening'];

/** +1 for money in (in, opening), -1 for money out, 0 for a correction row itself. */
export function signOf(kind: EntryKind): 1 | -1 | 0 {
  return kind === 'in' || kind === 'opening' ? 1 : kind === 'out' ? -1 : 0;
}

/** Display letter of the server-assigned reference number. */
export function refLetter(kind: EntryKind): 'K' | 'B' | 'P' | 'A' {
  return kind === 'in' ? 'K' : kind === 'out' ? 'B' : kind === 'adjust' ? 'P' : 'A';
}

/** The label a device shows until the server assigns the real number: `K-` + the last 4 characters of the id. */
export function tempRefLabel(id: string, kind: EntryKind = 'in'): string {
  return `${refLetter(kind)}-${id.slice(-4).toUpperCase()}`;
}

function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** Order of corrections of one entry: (editedAt, id). */
function byEdit(a: FinanceEntry, b: FinanceEntry): number {
  const d = ms(a.editedAt) - ms(b.editedAt);
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

interface State { fund: string; amount: number; voided: boolean }

function step(s: State, c: FinanceEntry): State {
  if (c.correctionKind === 'amount') return { fund: s.fund, amount: c.amountSen, voided: false };
  if (c.correctionKind === 'fund' && c.toFundId) return { fund: c.toFundId, amount: s.amount, voided: false };
  if (c.correctionKind === 'void') return { fund: s.fund, amount: s.amount, voided: true };
  return s;
}

/** Each original entry with its corrections applied in (editedAt, id) order; the last state wins. */
export function effective(entries: readonly FinanceEntry[]): EffectiveEntry[] {
  const chains = new Map<string, FinanceEntry[]>();
  for (const e of entries) {
    if (e.kind === 'adjust' && e.correctsId) {
      const list = chains.get(e.correctsId);
      if (list) list.push(e); else chains.set(e.correctsId, [e]);
    }
  }
  const out: EffectiveEntry[] = [];
  for (const e of entries) {
    if (!ORIGINALS.includes(e.kind)) continue;
    const chain = (chains.get(e.id) ?? []).slice().sort(byEdit);
    let s: State = { fund: e.fundId, amount: e.amountSen, voided: false };
    for (const c of chain) s = step(s, c);
    out.push({ ...e, effFundId: s.fund, effAmountSen: s.amount, voided: s.voided, corrections: chain });
  }
  return out;
}

const contribution = (kind: EntryKind, s: State): number => (s.voided ? 0 : signOf(kind) * s.amount);

/** Balance per fund id: every fund in `funds` is present (0 when empty). */
export function balances(entries: readonly FinanceEntry[], funds: readonly Pick<Fund, 'id'>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of funds) out[f.id] = 0;
  for (const e of effective(entries)) {
    if (e.voided) continue;
    out[e.effFundId] = (out[e.effFundId] ?? 0) + signOf(e.kind) * e.effAmountSen;
  }
  return out;
}

const inMonth = (date: string, ym: string): boolean => date.slice(0, 7) === ym;

/**
 * Sum of the effective amounts of `in` entries dated in the month: a voided entry counts for nothing and an amount
 * correction replaces the posted amount (the same figures the TV card shows). A fund move changes nothing here.
 */
export function monthIn(entries: readonly FinanceEntry[], ym: string): number {
  return effective(entries).reduce((a, e) => (e.kind === 'in' && !e.voided && inMonth(e.entryDate, ym) ? a + e.effAmountSen : a), 0);
}
export function monthOut(entries: readonly FinanceEntry[], ym: string): number {
  return effective(entries).reduce((a, e) => (e.kind === 'out' && !e.voided && inMonth(e.entryDate, ym) ? a + e.effAmountSen : a), 0);
}

function nextMonthStart(ym: string): string {
  const y = Number(ym.slice(0, 4)); const m = Number(ym.slice(5, 7));
  const ny = m === 12 ? y + 1 : y; const nm = m === 12 ? 1 : m + 1;
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-01`;
}

/** The ledger as it stood before `cutoff` (KL date): rows and corrections dated earlier only. */
function before(entries: readonly FinanceEntry[], cutoff: string): FinanceEntry[] {
  return entries.filter((e) => e.entryDate < cutoff);
}

export interface MonthReportInput {
  ym: string;
  entries: readonly FinanceEntry[];
  funds: readonly Fund[];
  perihal: readonly Perihal[];
  kuliahTitles: Record<string, string>;
  kuliahDates?: Record<string, string>;
  now: string;
  syncedUntil: string | null;
  status: 'open' | 'closed';
}

const cmpRow = (a: FinanceEntry, b: FinanceEntry): number =>
  a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : byEdit(a, b);

/**
 * The month's report. Per tabung: opening (what the ledger held at the start of the month, plus any opening balance
 * entered in the month), money in and out as first posted, corrections posted in the month, closing. The corrections
 * column is closing minus the rest, so a row always adds up. A correction posted this month against an earlier month
 * shows here (`lastMonth`) and never changes that earlier month's figures.
 */
export function monthReport(input: MonthReportInput): MonthReport {
  const { ym, entries } = input;
  const start = `${ym}-01`;
  const end = nextMonthStart(ym);
  const fundName = new Map(input.funds.map((f) => [f.id, f.name]));
  const perihalLabel = new Map(input.perihal.map((p) => [p.id, p.label]));

  const open: Record<string, number> = {};
  const closing: Record<string, number> = {};
  const inSum: Record<string, number> = {};
  const outSum: Record<string, number> = {};
  const add = (m: Record<string, number>, k: string, n: number): void => { m[k] = (m[k] ?? 0) + n; };

  for (const e of effective(before(entries, start))) if (!e.voided) add(open, e.effFundId, signOf(e.kind) * e.effAmountSen);
  const endEntries = before(entries, end);
  const endEff = effective(endEntries);
  for (const e of endEff) if (!e.voided) add(closing, e.effFundId, signOf(e.kind) * e.effAmountSen);

  const inRows: FinanceEntry[] = [];
  const outRows: FinanceEntry[] = [];
  for (const e of entries) {
    if (!inMonth(e.entryDate, ym)) continue;
    if (e.kind === 'opening') add(open, e.fundId, e.amountSen);
    else if (e.kind === 'in') { add(inSum, e.fundId, e.amountSen); inRows.push(e); }
    else if (e.kind === 'out') { add(outSum, e.fundId, e.amountSen); outRows.push(e); }
  }

  const fundRows: ReportFundRow[] = [];
  for (const f of input.funds.slice().sort((a, b) => a.sortOrder - b.sortOrder || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const o = open[f.id] ?? 0; const i = inSum[f.id] ?? 0; const u = outSum[f.id] ?? 0; const c = closing[f.id] ?? 0;
    const corr = c - o - i + u;
    if (f.archivedAt !== null && o === 0 && i === 0 && u === 0 && c === 0) continue;
    fundRows.push({ fundId: f.id, name: f.name, openingSen: o, inSen: i, outSen: u, correctionsSen: corr, closingSen: c });
  }

  const group = <R extends ReportInRow>(rows: FinanceEntry[], toRow: (e: FinanceEntry) => R): ReportGroup<R>[] => {
    const map = new Map<string, FinanceEntry[]>();
    for (const e of rows) {
      const key = `${e.perihalId ?? ''}\u0000${e.fundId}`;
      const l = map.get(key);
      if (l) l.push(e); else map.set(key, [e]);
    }
    const groups: ReportGroup<R>[] = [];
    for (const list of map.values()) {
      list.sort(cmpRow);
      const first = list[0]!;
      const perihalId = first.perihalId ?? '';
      groups.push({
        perihalId, label: perihalLabel.get(perihalId) ?? perihalId, fundId: first.fundId,
        rows: list.map(toRow), totalSen: list.reduce((a, e) => a + e.amountSen, 0),
      });
    }
    return groups.sort((a, b) =>
      a.label < b.label ? -1 : a.label > b.label ? 1 : a.fundId < b.fundId ? -1 : a.fundId > b.fundId ? 1 : 0);
  };

  const inByPerihal = group<ReportInRow>(inRows, (e) => ({ date: e.entryDate, refNo: e.refNo, note: e.note, amountSen: e.amountSen }));
  const outByPerihal = group<ReportOutRow>(outRows, (e) => ({
    date: e.entryDate, refNo: e.refNo, note: e.note, amountSen: e.amountSen, payee: e.payee,
    penceramahName: e.penceramahName,
    kuliahTitle: e.kuliahId ? (input.kuliahTitles[e.kuliahId] ?? null) : null,
    kuliahDate: e.kuliahId ? (input.kuliahDates?.[e.kuliahId] ?? null) : null,
  }));

  const corrections: ReportCorrection[] = [];
  for (const e of endEff) {
    let s: State = { fund: e.fundId, amount: e.amountSen, voided: false };
    for (const c of e.corrections) {
      const prev = contribution(e.kind, s);
      s = step(s, c);
      if (!inMonth(c.entryDate, ym)) continue;
      corrections.push({
        id: c.id, date: c.entryDate, refNo: c.refNo, originalRefNo: e.refNo, kind: c.correctionKind ?? 'amount',
        reason: c.reason ?? '', deltaSen: contribution(e.kind, s) - prev,
        fundName: fundName.get(s.fund) ?? s.fund, lastMonth: e.entryDate < start,
      });
    }
  }
  const byId = new Map(entries.map((e) => [e.id, e]));
  corrections.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const ea = byId.get(a.id); const eb = byId.get(b.id);
    return ea && eb ? byEdit(ea, eb) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const sum = (pick: (r: ReportFundRow) => number): number => fundRows.reduce((a, r) => a + pick(r), 0);
  return {
    ym, status: input.status, generatedAt: input.now, syncedUntil: input.syncedUntil,
    funds: fundRows, inByPerihal, outByPerihal, corrections,
    totals: {
      openingSen: sum((r) => r.openingSen), inSen: sum((r) => r.inSen), outSen: sum((r) => r.outSen),
      correctionsSen: sum((r) => r.correctionsSen), closingSen: sum((r) => r.closingSen),
    },
  };
}

/** The latest payment to this penceramah that is not voided, carrying its current (corrected) amount and tabung. */
export function lastPenceramahPayment(entries: readonly FinanceEntry[], penceramahId: string): FinanceEntry | null {
  let best: EffectiveEntry | null = null;
  for (const e of effective(entries)) {
    if (e.kind !== 'out' || e.penceramahId !== penceramahId || e.voided) continue;
    if (best === null || cmpRow(best, e) < 0) best = e;
  }
  if (!best) return null;
  const { effFundId, effAmountSen, voided: _v, corrections: _c, ...rest } = best;
  void _v; void _c;
  return { ...rest, fundId: effFundId, amountSen: effAmountSen };
}
