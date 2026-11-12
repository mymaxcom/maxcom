/**
 * Finance store: tabung and perihal lookups, the append-only ledger, month states, reference numbers.
 * Money is integer sen everywhere. Nothing here logs an amount, a note, a payee, a reason or a counter's name:
 * `change_log` carries the rows for the feed and the audit view, and that is the only copy.
 */
import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import {
  balances, effective, klDateOf, refLetter, validateEntryShape, validateLookup, validateMonth,
} from '@surau/core';
import type {
  Counter, CorrectionKind, Denominations, EffectiveEntry, EntryKind, FinanceEntry, Fund, Method, MonthReport, MonthState, Perihal,
} from '@surau/core';
import { logChange, tx } from '../auth/users.ts';
import { getUserRow } from '../auth/users.ts';
import { bumpVersion, putFeatureIn } from '../settingsStore.ts';
import { revOf } from '../sync/meta.ts';
import type { ChangeMeta } from '../sync/meta.ts';
import { getItem } from '../content/store.ts';
import { DEFAULT_SURAU_ID } from '../sync/verify.ts';

export type FinanceStatus = 400 | 404 | 409 | 413;
export type FinanceCode =
  | 'invalid' | 'not_found' | 'entry_exists' | 'month_closed' | 'fund_archived' | 'perihal_archived' | 'name_taken'
  | 'balance_not_zero' | 'system_perihal' | 'kuliah_future' | 'kuliah_unknown' | 'counter_unknown' | 'month_order'
  | 'correction_before_original' | 'later_month_closed';

export class FinanceError extends Error {
  status: FinanceStatus;
  code: FinanceCode;
  errors: string[];
  constructor(status: FinanceStatus, code: FinanceCode, errors: string[] = [code]) {
    super(errors.join('; '));
    this.name = 'FinanceError';
    this.status = status;
    this.code = code;
    this.errors = errors;
  }
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface AppendCtx {
  now: Date;
  role: 'box' | 'cloud';
  surauId?: string;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => Number(v);

type Row = Record<string, unknown>;

function fundOf(r: Row): Fund {
  return {
    id: String(r.id), name: String(r.name), public: num(r.public) === 1,
    targetSen: r.target_sen === null || r.target_sen === undefined ? null : num(r.target_sen),
    jumaat: num(r.jumaat) === 1, sortOrder: num(r.sort_order), archivedAt: str(r.archived_at),
    updatedAt: String(r.updated_at), updatedBy: String(r.updated_by),
  };
}

function perihalOf(r: Row): Perihal {
  return {
    id: String(r.id), direction: r.direction === 'out' ? 'out' : 'in', label: String(r.label),
    system: r.system === 'penceramah' ? 'penceramah' : null, sortOrder: num(r.sort_order), archivedAt: str(r.archived_at),
    updatedAt: String(r.updated_at), updatedBy: String(r.updated_by),
  };
}

function jsonOf<T>(v: unknown): T | null {
  if (typeof v !== 'string') return null;
  try { return JSON.parse(v) as T; } catch { return null; }
}

export function entryOf(r: Row): FinanceEntry {
  return {
    id: String(r.id), kind: String(r.kind) as EntryKind, entryDate: String(r.entry_date), fundId: String(r.fund_id),
    perihalId: str(r.perihal_id), amountSen: num(r.amount_sen), method: str(r.method) as Method | null,
    reference: str(r.reference), note: str(r.note), payee: str(r.payee),
    counters: jsonOf<Counter[]>(r.counters_json), denominations: jsonOf<Denominations>(r.denominations_json),
    photoId: str(r.photo_id), kuliahId: str(r.kuliah_id), penceramahId: str(r.penceramah_id),
    penceramahName: str(r.penceramah_name), correctsId: str(r.corrects_id),
    correctionKind: str(r.correction_kind) as CorrectionKind | null, toFundId: str(r.to_fund_id), reason: str(r.reason),
    refNo: str(r.ref_no), createdBy: String(r.created_by), deviceId: str(r.device_id), editedAt: String(r.edited_at),
    receivedAt: String(r.received_at), cloudReceivedAt: str(r.cloud_received_at),
  };
}

function monthOf(r: Row): MonthState {
  return {
    ym: String(r.ym), status: r.status === 'closed' ? 'closed' : 'open', closedAt: str(r.closed_at), closedBy: str(r.closed_by),
    report: jsonOf<MonthReport>(r.report_json),
  };
}

const surauOf = (ctx?: { surauId?: string }): string => ctx?.surauId ?? DEFAULT_SURAU_ID;

// ---- lookups ----

export function listFunds(db: DatabaseSync, opts: { includeArchived?: boolean } = {}): Fund[] {
  const rows = db.prepare(
    `SELECT * FROM finance_funds ${opts.includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY sort_order, name, id`,
  ).all();
  return rows.map(fundOf);
}

export function getFund(db: DatabaseSync, id: string): Fund | null {
  const r = db.prepare('SELECT * FROM finance_funds WHERE id = ?').get(id);
  return r === undefined ? null : fundOf(r);
}

export function listPerihal(db: DatabaseSync, opts: { includeArchived?: boolean } = {}): Perihal[] {
  const rows = db.prepare(
    `SELECT * FROM finance_perihal ${opts.includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY direction, sort_order, label, id`,
  ).all();
  return rows.map(perihalOf);
}

export function getPerihal(db: DatabaseSync, id: string): Perihal | null {
  const r = db.prepare('SELECT * FROM finance_perihal WHERE id = ?').get(id);
  return r === undefined ? null : perihalOf(r);
}

const nameKey = (s: string): string => s.trim().toLowerCase();

/** Current balance of one fund from the ledger rows (corrections included). */
export function fundBalance(db: DatabaseSync, fundId: string): number {
  return balances(allEntries(db), [{ id: fundId }])[fundId] ?? 0;
}

export function putFundIn(db: DatabaseSync, id: string, input: unknown, actor: string, meta?: ChangeMeta): Fund {
  if (!SAFE_ID.test(id)) throw new FinanceError(400, 'invalid', ['id must be 1-100 letters, digits, - or _']);
  const v = validateLookup('fund', input);
  if (!v.ok) throw new FinanceError(400, 'invalid', v.errors);
  const body = v.value;
  const before = getFund(db, id);
  const trusted = meta?.trusted === true;
  if (!trusted && body.archivedAt === null) {
    for (const f of listFunds(db)) {
      if (f.id !== id && nameKey(f.name) === nameKey(body.name)) throw new FinanceError(409, 'name_taken');
    }
  }
  if (!trusted && body.archivedAt !== null && (before === null || before.archivedAt === null) && fundBalance(db, id) !== 0) {
    throw new FinanceError(409, 'balance_not_zero');
  }
  const now = new Date().toISOString();
  const editedAt = meta?.editedAt ?? now;
  const next: Fund = {
    id, name: body.name, public: body.public, targetSen: body.targetSen, jumaat: body.jumaat, sortOrder: body.sortOrder,
    archivedAt: body.archivedAt, updatedAt: now, updatedBy: actor,
  };
  if (before !== null && sameFund(before, next)) return before;
  const rev = revOf(editedAt, meta);
  db.prepare(
    `INSERT INTO finance_funds (surau_id, id, name, public, target_sen, jumaat, sort_order, archived_at, updated_at, updated_by, rev, edited_at, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, public = excluded.public, target_sen = excluded.target_sen,
       jumaat = excluded.jumaat, sort_order = excluded.sort_order, archived_at = excluded.archived_at,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by, rev = excluded.rev,
       edited_at = excluded.edited_at, origin = excluded.origin`,
  ).run(surauOf(), id, next.name, next.public ? 1 : 0, next.targetSen, next.jumaat ? 1 : 0, next.sortOrder, next.archivedAt,
    now, actor, rev, editedAt, meta?.origin ?? 'local');
  logChange(db, actor, 'finance:fund', id, before ?? undefined, next, meta);
  bumpVersion(db);
  return next;
}

const sameFund = (a: Fund, b: Fund): boolean =>
  a.name === b.name && a.public === b.public && a.targetSen === b.targetSen && a.jumaat === b.jumaat
  && a.sortOrder === b.sortOrder && a.archivedAt === b.archivedAt;

export function putPerihalIn(
  db: DatabaseSync, id: string, input: unknown, actor: string, meta?: ChangeMeta, opts?: { system?: 'penceramah' },
): Perihal {
  if (!SAFE_ID.test(id)) throw new FinanceError(400, 'invalid', ['id must be 1-100 letters, digits, - or _']);
  const v = validateLookup('perihal', input);
  if (!v.ok) throw new FinanceError(400, 'invalid', v.errors);
  const body = v.value;
  const before = getPerihal(db, id);
  const trusted = meta?.trusted === true;
  if (before !== null && before.direction !== body.direction) throw new FinanceError(400, 'invalid', ['direction cannot change']);
  if (before !== null && before.system !== null && (before.label !== body.label || body.archivedAt !== null)) {
    throw new FinanceError(409, 'system_perihal');
  }
  if (!trusted && body.archivedAt === null) {
    for (const p of listPerihal(db)) {
      if (p.id !== id && p.direction === body.direction && nameKey(p.label) === nameKey(body.label)) throw new FinanceError(409, 'name_taken');
    }
  }
  const now = new Date().toISOString();
  const editedAt = meta?.editedAt ?? now;
  const next: Perihal = {
    id, direction: body.direction, label: body.label, system: before?.system ?? opts?.system ?? null, sortOrder: body.sortOrder,
    archivedAt: body.archivedAt, updatedAt: now, updatedBy: actor,
  };
  if (before !== null && before.label === next.label && before.sortOrder === next.sortOrder && before.archivedAt === next.archivedAt) return before;
  const rev = revOf(editedAt, meta);
  db.prepare(
    `INSERT INTO finance_perihal (surau_id, id, direction, label, system, sort_order, archived_at, updated_at, updated_by, rev, edited_at, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET label = excluded.label, sort_order = excluded.sort_order, archived_at = excluded.archived_at,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by, rev = excluded.rev,
       edited_at = excluded.edited_at, origin = excluded.origin`,
  ).run(surauOf(), id, next.direction, next.label, next.system, next.sortOrder, next.archivedAt, now, actor, rev, editedAt, meta?.origin ?? 'local');
  logChange(db, actor, 'finance:perihal', id, before ?? undefined, next, meta);
  bumpVersion(db);
  return next;
}

/** Seeded system id of the penceramah perihal (the same on every box, so the apps can name it). */
export const PENCERAMAH_PERIHAL_ID = 'perihal-penceramah';

/**
 * The starting lists, written once when finance is first switched on. Idempotent: returns false when any fund
 * already exists. Sets the default penceramah tabung and the start date in the `finance` settings.
 */
export function ensureSeeded(db: DatabaseSync, actor: string, now: Date): boolean {
  return tx(db, () => {
    const has = db.prepare('SELECT 1 AS ok FROM finance_funds LIMIT 1').get();
    if (has !== undefined) return false;
    const id = (): string => `f${randomBytes(9).toString('hex')}`;
    const funds: [string, boolean, boolean][] = [
      ['Tabung Jumaat', true, true], ['Tabung Am', true, false], ['Tabung Pembangunan', true, false], ['Tabung Khairat Kematian', false, false],
    ];
    let jumaatId = '';
    funds.forEach(([name, pub, jumaat], i) => {
      const fid = id();
      if (jumaat) jumaatId = fid;
      putFundIn(db, fid, { name, public: pub, jumaat, targetSen: null, sortOrder: i + 1, archivedAt: null }, actor);
    });
    const ins = ['Kutipan solat Jumaat', 'Peti derma', 'Yuran khairat', 'Derma', 'Kutipan majlis'];
    ins.forEach((label, i) => putPerihalIn(db, id(), { direction: 'in', label, sortOrder: i + 1, archivedAt: null }, actor));
    const outs = ['Penceramah', 'Utiliti', 'Kebersihan', 'Penyelenggaraan', 'Khairat kematian', 'Pembangunan', 'Program dan majlis', 'Lain-lain'];
    outs.forEach((label, i) => {
      const pid = label === 'Penceramah' ? PENCERAMAH_PERIHAL_ID : id();
      putPerihalIn(db, pid, { direction: 'out', label, sortOrder: i + 1, archivedAt: null }, actor, undefined, label === 'Penceramah' ? { system: 'penceramah' } : undefined);
    });
    putFeatureIn(db, 'finance', { penceramahFundId: jumaatId, startedOn: klDateOf(now) }, actor);
    return true;
  });
}

// ---- ledger ----

export function allEntries(db: DatabaseSync): FinanceEntry[] {
  return db.prepare('SELECT * FROM finance_entries ORDER BY entry_date, edited_at, id').all().map(entryOf);
}

export function listEntries(
  db: DatabaseSync, opts: { ym?: string; fundId?: string; sinceEditedAt?: string; limit?: number } = {},
): FinanceEntry[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.ym !== undefined) { where.push('substr(entry_date, 1, 7) = ?'); args.push(opts.ym); }
  if (opts.fundId !== undefined) { where.push('fund_id = ?'); args.push(opts.fundId); }
  if (opts.sinceEditedAt !== undefined) { where.push('edited_at > ?'); args.push(opts.sinceEditedAt); }
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 500)), 5000);
  const sql = `SELECT * FROM (SELECT * FROM finance_entries ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY entry_date DESC, edited_at DESC, id DESC LIMIT ${limit}) ORDER BY entry_date, edited_at, id`;
  return db.prepare(sql).all(...args).map(entryOf);
}

export function entryRow(db: DatabaseSync, id: string): FinanceEntry | null {
  const r = db.prepare('SELECT * FROM finance_entries WHERE id = ?').get(id);
  return r === undefined ? null : entryOf(r);
}

export function getEntry(db: DatabaseSync, id: string): { entry: FinanceEntry; corrections: FinanceEntry[]; effective: EffectiveEntry } | null {
  const entry = entryRow(db, id);
  if (entry === null) return null;
  const corrections = db.prepare('SELECT * FROM finance_entries WHERE corrects_id = ?').all(id).map(entryOf);
  const eff = effective([entry, ...corrections])[0];
  if (eff === undefined) return null; // the id belongs to a correction row, which has no chain of its own
  return { entry, corrections: eff.corrections, effective: eff };
}

export function financeCounts(db: DatabaseSync): { entries: number; funds: number } {
  return {
    entries: num(db.prepare('SELECT COUNT(*) AS n FROM finance_entries').get()!.n),
    funds: num(db.prepare('SELECT COUNT(*) AS n FROM finance_funds').get()!.n),
  };
}

function nextRefNo(db: DatabaseSync, surauId: string, letter: string): string {
  db.prepare('INSERT INTO finance_counters (surau_id, letter, next) VALUES (?, ?, 1) ON CONFLICT(surau_id, letter) DO NOTHING').run(surauId, letter);
  let n = num(db.prepare('SELECT next FROM finance_counters WHERE surau_id = ? AND letter = ?').get(surauId, letter)!.next);
  // a number already on a row (pulled back from the cloud, or an old low counter) is never handed out again
  const taken = db.prepare('SELECT 1 AS ok FROM finance_entries WHERE ref_no = ?');
  while (taken.get(`${letter}-${String(n).padStart(4, '0')}`) !== undefined) n += 1;
  db.prepare('UPDATE finance_counters SET next = ? WHERE surau_id = ? AND letter = ?').run(n + 1, surauId, letter);
  return `${letter}-${String(n).padStart(4, '0')}`;
}

/** Raise a letter's counter to at least `n + 1` (a number kept from a replicated entry must never be handed out again). */
function raiseCounter(db: DatabaseSync, surauId: string, letter: string, n: number): void {
  db.prepare('INSERT INTO finance_counters (surau_id, letter, next) VALUES (?, ?, ?) ON CONFLICT(surau_id, letter) DO UPDATE SET next = MAX(next, excluded.next)')
    .run(surauId, letter, n + 1);
}

/** Fill a still-empty reference number (the cloud learns the box's number this way). False when already set or unknown. */
export function setRefNoIfNull(db: DatabaseSync, id: string, refNo: string): boolean {
  if (!/^[KBPA]-\d{4,}$/.test(refNo)) return false;
  const taken = db.prepare('SELECT 1 AS ok FROM finance_entries WHERE ref_no = ? AND id <> ?').get(refNo, id);
  if (taken !== undefined) return false;
  const r = db.prepare('UPDATE finance_entries SET ref_no = ? WHERE id = ? AND ref_no IS NULL').run(refNo, id);
  return Number(r.changes) > 0;
}

export function setCloudReceived(db: DatabaseSync, id: string, iso: string): boolean {
  const r = db.prepare('UPDATE finance_entries SET cloud_received_at = ? WHERE id = ? AND cloud_received_at IS NULL').run(iso, id);
  return Number(r.changes) > 0;
}

// ---- months ----

export function listMonths(db: DatabaseSync): MonthState[] {
  return db.prepare('SELECT * FROM finance_months ORDER BY ym').all().map(monthOf);
}

export function monthStatus(db: DatabaseSync, ym: string): 'open' | 'closed' {
  const r = db.prepare('SELECT status FROM finance_months WHERE ym = ?').get(ym);
  return r !== undefined && r.status === 'closed' ? 'closed' : 'open';
}

export const isMonthClosed = (db: DatabaseSync, ym: string): boolean => monthStatus(db, ym) === 'closed';

export function monthReportJson(db: DatabaseSync, ym: string): string | null {
  const r = db.prepare('SELECT report_json FROM finance_months WHERE ym = ?').get(ym);
  return r !== undefined && typeof r.report_json === 'string' ? r.report_json : null;
}

/** True when a month after `ym` is closed (months close and reopen in order on this side). */
function laterMonthClosed(db: DatabaseSync, ym: string): boolean {
  return db.prepare("SELECT 1 AS ok FROM finance_months WHERE ym > ? AND status = 'closed' LIMIT 1").get(ym) !== undefined;
}

export interface MonthCtx {
  now: Date;
  role: 'box' | 'cloud';
  surauId?: string;
  /** Builds the frozen report JSON when a month is closed (Task 6). */
  freeze?: (ym: string) => string;
  /** Replication: the frozen report the other side made, stored as it is (no freeze here). */
  frozenJson?: string | null;
}

export function putMonthIn(db: DatabaseSync, ym: string, input: unknown, actor: string, ctx: MonthCtx, meta?: ChangeMeta): MonthState {
  const todayKl = klDateOf(ctx.now);
  const body = typeof input === 'object' && input !== null ? { ...(input as Record<string, unknown>), ym } : input;
  const v = validateMonth(body, { todayKl });
  if (!v.ok || !YM_RE.test(ym)) throw new FinanceError(400, 'invalid', v.ok ? ['ym must be YYYY-MM'] : v.errors);
  const status = v.value.status;
  const cur = db.prepare('SELECT * FROM finance_months WHERE ym = ?').get(ym);
  const before = cur === undefined ? null : monthOf(cur);
  if ((before?.status ?? 'open') === status) return before ?? { ym, status: 'open', closedAt: null, closedBy: null, report: null };
  if (status === 'open' && meta?.trusted !== true && laterMonthClosed(db, ym)) {
    throw new FinanceError(409, 'later_month_closed', ['Bulan terkemudian sudah dimuktamadkan: buka semula bulan itu dahulu']);
  }
  if (status === 'closed' && meta?.trusted !== true) {
    const start = `${ym}-01`;
    const earlier = db.prepare('SELECT DISTINCT substr(entry_date, 1, 7) AS m FROM finance_entries WHERE entry_date < ?').all(start);
    for (const e of earlier) {
      if (!isMonthClosed(db, String(e.m))) throw new FinanceError(409, 'month_order', ['close the earlier month first']);
    }
  }
  const nowIso = ctx.now.toISOString();
  const editedAt = meta?.editedAt ?? nowIso;
  const rev = revOf(editedAt, meta);
  const report = status !== 'closed' ? null : ctx.frozenJson !== undefined ? ctx.frozenJson : ctx.freeze ? ctx.freeze(ym) : null;
  const next: MonthState = {
    ym, status, closedAt: status === 'closed' ? editedAt : null, closedBy: status === 'closed' ? actor : null,
    report: report === null ? null : jsonOf<MonthReport>(report),
  };
  db.prepare(
    `INSERT INTO finance_months (surau_id, ym, status, closed_at, closed_by, report_json, updated_at, rev, edited_at, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(surau_id, ym) DO UPDATE SET status = excluded.status, closed_at = excluded.closed_at,
       closed_by = excluded.closed_by, report_json = excluded.report_json, updated_at = excluded.updated_at,
       rev = excluded.rev, edited_at = excluded.edited_at, origin = excluded.origin`,
  ).run(surauOf(ctx), ym, status, next.closedAt, next.closedBy, report, nowIso, rev, editedAt, meta?.origin ?? 'local');
  logChange(db, actor, 'finance:month', ym, before ?? undefined, next, meta);
  bumpVersion(db);
  return next;
}

// ---- appending an entry ----

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** True when a stored row is what this (validated) input would have produced, so a retry is a no-op. */
function sameAsStored(row: FinanceEntry, i: ReturnType<typeof shape>): boolean {
  return row.kind === i.kind && row.entryDate === i.entryDate && row.perihalId === i.perihalId && row.amountSen === i.amountSen
    && row.method === i.method && row.reference === i.reference && row.note === i.note && row.payee === i.payee
    && sameJson(row.counters, i.counters) && sameJson(row.denominations, i.denominations) && row.photoId === i.photoId
    && row.kuliahId === i.kuliahId && row.correctsId === i.correctsId && row.correctionKind === i.correctionKind
    && row.toFundId === i.toFundId && row.reason === i.reason && (row.kind === 'adjust' || row.fundId === i.fundId);
}

function shape(input: unknown, todayKl: string) {
  const v = validateEntryShape(input, { todayKl });
  if (!v.ok) throw new FinanceError(400, 'invalid', v.errors);
  return v.value;
}

/**
 * Append one entry (a collection, a payment, an opening balance or a correction). The caller owns the transaction.
 * An id that already exists is a retry when the body is the same (the stored row is returned) and 409 `entry_exists`
 * otherwise: a ledger row is never overwritten. On the box the display number (`ref_no`) is assigned here.
 */
export function appendEntryIn(
  db: DatabaseSync, input: unknown, actor: string, ctx: AppendCtx, meta?: ChangeMeta,
): FinanceEntry {
  const surauId = surauOf(ctx);
  const todayKl = klDateOf(ctx.now);
  const rawId = typeof input === 'object' && input !== null ? (input as { id?: unknown }).id : undefined;
  const existing = typeof rawId === 'string' && SAFE_ID.test(rawId) ? entryRow(db, rawId) : null;
  if (existing !== null) {
    // A retry may arrive after the date window moved on: judge its shape as of the day it was entered.
    const i = shape(input, existing.entryDate);
    if (sameAsStored(existing, i)) return existing;
    throw new FinanceError(409, 'entry_exists');
  }
  const i = shape(input, todayKl);
  const errs: string[] = [];

  const fund = (id: string): Fund => {
    const f = getFund(db, id);
    if (f === null) throw new FinanceError(400, 'invalid', ['unknown tabung']);
    if (f.archivedAt !== null) throw new FinanceError(409, 'fund_archived');
    return f;
  };

  let fundId = i.fundId;
  let perihalId = i.perihalId;
  let kuliahId: string | null = null;
  let penceramahId: string | null = null;
  let penceramahName: string | null = null;

  if (i.kind === 'adjust') {
    const orig = entryRow(db, i.correctsId!);
    if (orig === null || orig.kind === 'adjust') throw new FinanceError(400, 'invalid', ['a correction must point at an original entry']);
    fundId = orig.fundId;
    // a correction is dated on or after the day of the entry it corrects
    if (i.entryDate < orig.entryDate) {
      throw new FinanceError(409, 'correction_before_original', ['Pembetulan tidak boleh bertarikh sebelum catatan asal']);
    }
    // an amount or void correction changes what the original's tabung holds: not once that tabung is archived
    if (i.correctionKind === 'amount' || i.correctionKind === 'void') {
      const atFund = getEntry(db, orig.id)?.effective.effFundId ?? orig.fundId;
      if (getFund(db, atFund)?.archivedAt != null) {
        throw new FinanceError(409, 'fund_archived', ['Tabung catatan asal sudah diarkibkan']);
      }
    }
    if (i.correctionKind === 'amount' && orig.kind !== 'opening' && i.amountSen <= 0) {
      throw new FinanceError(400, 'invalid', ['amountSen must be more than 0']);
    }
    if (i.correctionKind === 'fund') {
      fund(i.toFundId!);
      const eff = getEntry(db, orig.id)?.effective;
      if (eff !== undefined && eff.effFundId === i.toFundId) throw new FinanceError(400, 'invalid', ['the entry is already in that tabung']);
    }
    perihalId = null;
  } else {
    fund(i.fundId);
    if (i.kind === 'in' || i.kind === 'out') {
      const p = getPerihal(db, i.perihalId!);
      if (p === null) throw new FinanceError(400, 'invalid', ['unknown perihal']);
      if (p.archivedAt !== null) throw new FinanceError(409, 'perihal_archived');
      if (p.direction !== i.kind) throw new FinanceError(400, 'invalid', ['perihal is for the other direction']);
      if (p.system === 'penceramah') {
        if (i.kind !== 'out') throw new FinanceError(400, 'invalid', ['penceramah is a payment perihal']);
        if (i.kuliahId === null) throw new FinanceError(400, 'invalid', ['a penceramah payment needs a kuliah']);
        const k = getItem(db, 'kuliah', i.kuliahId);
        if (k === null) throw new FinanceError(404, 'kuliah_unknown');
        if (k.date > todayKl) throw new FinanceError(409, 'kuliah_future');
        kuliahId = k.id;
        penceramahId = k.penceramahId;
        penceramahName = getItem(db, 'penceramah', k.penceramahId)?.name ?? null;
      } else if (i.kuliahId !== null) {
        throw new FinanceError(400, 'invalid', ['only a penceramah payment is linked to a kuliah']);
      }
    }
  }

  if (i.counters !== null) {
    for (const c of i.counters) {
      if ('userId' in c) {
        const u = getUserRow(db, c.userId);
        if (u === undefined || !u.active) errs.push('a counter is not an active user');
      }
    }
    if (errs.length > 0) throw new FinanceError(400, 'counter_unknown', errs);
  }

  if (isMonthClosed(db, i.entryDate.slice(0, 7))) throw new FinanceError(409, 'month_closed');
  if (laterMonthClosed(db, i.entryDate.slice(0, 7))) {
    throw new FinanceError(409, 'later_month_closed', ['Bulan selepas ini sudah dimuktamadkan']);
  }

  const nowIso = ctx.now.toISOString();
  const editedAt = meta?.editedAt ?? nowIso;
  const refNo = ctx.role === 'box' ? nextRefNo(db, surauId, refLetter(i.kind)) : null;
  const rev = revOf(editedAt, meta);
  db.prepare(
    `INSERT INTO finance_entries (surau_id, id, kind, entry_date, fund_id, perihal_id, amount_sen, method, reference, note, payee,
       counters_json, denominations_json, photo_id, kuliah_id, penceramah_id, penceramah_name, corrects_id, correction_kind,
       to_fund_id, reason, ref_no, created_by, device_id, edited_at, received_at, origin, op_id, rev)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    surauId, i.id, i.kind, i.entryDate, fundId, perihalId, i.amountSen, i.method, i.reference, i.note, i.payee,
    i.counters === null ? null : JSON.stringify(i.counters), i.denominations === null ? null : JSON.stringify(i.denominations),
    i.photoId, kuliahId, penceramahId, penceramahName, i.correctsId, i.correctionKind, i.toFundId, i.reason, refNo,
    actor.replace(USER_PREFIX, ''), meta?.deviceId ?? null, editedAt, nowIso, meta?.origin ?? 'local', meta?.opId ?? null, rev,
  );
  const saved = entryRow(db, i.id)!;
  logChange(db, actor, 'finance:entry', i.id, undefined, saved, meta);
  bumpVersion(db);
  return saved;
}

const USER_PREFIX = /^user:/;


export function appendEntry(db: DatabaseSync, input: unknown, actor: string, ctx: AppendCtx, meta?: ChangeMeta): FinanceEntry {
  return tx(db, () => appendEntryIn(db, input, actor, ctx, meta));
}

// ---- replication ----

const INPUT_KEYS = [
  'id', 'kind', 'entryDate', 'fundId', 'perihalId', 'amountSen', 'method', 'reference', 'note', 'payee', 'counters',
  'denominations', 'photoId', 'kuliahId', 'penceramahId', 'penceramahName', 'correctsId', 'correctionKind', 'toFundId', 'reason',
] as const;
const ACTOR_OK = /^[A-Za-z0-9:_@.|-]{1,120}$/;
const ID_OK = /^[A-Za-z0-9_-]{1,100}$/;
const REF_OK = /^[KBPA]-\d{4,}$/;

/**
 * Insert an entry the other side already accepted (a feed entry). The shape and the arithmetic are checked again;
 * the things the first side owns (the month being open, counters being active users, the kuliah) are not, but the
 * rows the entry points at must exist here. The row is written as sent except for the clocks and numbers this
 * server owns: `received_at` is now, and on the box the display number is assigned. The caller owns the transaction.
 */
export function insertReplicatedEntry(
  db: DatabaseSync, after: Record<string, unknown>, id: string, actor: string, ctx: AppendCtx, meta: ChangeMeta,
): FinanceEntry {
  const input: Record<string, unknown> = {};
  for (const k of INPUT_KEYS) if (after[k] !== undefined) input[k] = after[k];
  input.id = id;
  const kind = typeof input.kind === 'string' ? input.kind : '';
  const entryDate = typeof input.entryDate === 'string' ? input.entryDate : '';
  const v = validateEntryShape(input, { todayKl: entryDate });
  if (!v.ok || kind === '') throw new FinanceError(400, 'invalid', v.ok ? ['invalid'] : v.errors);
  const i = v.value;
  const need = (table: 'finance_funds' | 'finance_perihal' | 'finance_entries', key: string | null): void => {
    if (key !== null && db.prepare(`SELECT 1 AS ok FROM ${table} WHERE id = ?`).get(key) === undefined) {
      throw new FinanceError(400, 'invalid', ['a row this entry points at is missing here']);
    }
  };
  need('finance_funds', i.fundId);
  need('finance_funds', i.toFundId);
  need('finance_perihal', i.perihalId);
  need('finance_entries', i.correctsId);
  const surauId = surauOf(ctx);
  const incomingRef = typeof after.refNo === 'string' && REF_OK.test(after.refNo) ? after.refNo : null;
  const taken = incomingRef !== null && db.prepare('SELECT 1 AS ok FROM finance_entries WHERE ref_no = ?').get(incomingRef) !== undefined;
  const refNo = incomingRef !== null && !taken ? incomingRef : ctx.role === 'box' ? nextRefNo(db, surauId, refLetter(i.kind)) : null;
  if (incomingRef !== null && refNo === incomingRef) raiseCounter(db, surauId, incomingRef.charAt(0), Number(incomingRef.slice(2)));
  const createdBy = typeof after.createdBy === 'string' && ACTOR_OK.test(after.createdBy) ? after.createdBy.replace(USER_PREFIX, '') : actor.replace(USER_PREFIX, '');
  const deviceId = typeof after.deviceId === 'string' && ID_OK.test(after.deviceId) ? after.deviceId : meta.deviceId ?? null;
  const nowIso = ctx.now.toISOString();
  const editedAt = meta.editedAt ?? nowIso;
  db.prepare(
    `INSERT INTO finance_entries (surau_id, id, kind, entry_date, fund_id, perihal_id, amount_sen, method, reference, note, payee,
       counters_json, denominations_json, photo_id, kuliah_id, penceramah_id, penceramah_name, corrects_id, correction_kind,
       to_fund_id, reason, ref_no, created_by, device_id, edited_at, received_at, origin, op_id, rev)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    surauId, i.id, i.kind, i.entryDate, i.fundId, i.perihalId, i.amountSen, i.method, i.reference, i.note, i.payee,
    i.counters === null ? null : JSON.stringify(i.counters), i.denominations === null ? null : JSON.stringify(i.denominations),
    i.photoId, i.kuliahId, i.penceramahId, i.penceramahName, i.correctsId, i.correctionKind, i.toFundId, i.reason, refNo,
    createdBy, deviceId, editedAt, nowIso, meta.origin ?? 'local', meta.opId ?? null, revOf(editedAt, meta),
  );
  const saved = entryRow(db, i.id)!;
  logChange(db, actor, 'finance:entry', i.id, undefined, saved, meta);
  bumpVersion(db);
  return saved;
}

/** A finance:entry feed entry for a row this side already has: only a missing display number is filled, and logged. */
export function fillRefNoFrom(db: DatabaseSync, id: string, refNo: string, actor: string, meta: ChangeMeta): boolean {
  if (!setRefNoIfNull(db, id, refNo)) return false;
  // the op id belongs to the row's first history entry (change_log.op_id is unique); this one only carries the number
  const { opId: _op, ...fillMeta } = meta;
  void _op;
  logChange(db, actor, 'finance:entry', id, undefined, entryRow(db, id), fillMeta);
  bumpVersion(db);
  return true;
}
