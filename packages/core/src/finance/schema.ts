/**
 * Shape and arithmetic rules for finance bodies. Existence checks (fund, perihal, kuliah, user, month) belong to the
 * store; every rule here is a pure function of the body and today's KL date. Unknown keys refuse the whole body.
 */

import type { Counter, CorrectionKind, Denominations, EntryKind, Method } from './types.ts';
import {
  COUNTERS_REQUIRED, DENOMS, MAX_AMOUNT_SEN, MAX_TARGET_SEN, REASON_MAX, REASON_MIN,
} from './limits.ts';

export { COUNTERS_REQUIRED, DENOMS, MAX_AMOUNT_SEN, MAX_PHOTO_BYTES, MAX_PHOTO_SIDE, REASON_MIN } from './limits.ts';

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const PLAIN = /^[^<>\x00-\x1f\x7f]+$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const PHOTO_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

const KINDS: readonly EntryKind[] = ['in', 'out', 'opening', 'adjust'];
const METHODS: readonly Method[] = ['tunai', 'bank', 'duitnow', 'cek'];
const CORRECTIONS: readonly CorrectionKind[] = ['amount', 'void', 'fund'];

/** A validated, normalised entry body: every field present, absent ones null. Server-owned fields are not in it. */
export interface EntryInput {
  id: string;
  kind: EntryKind;
  entryDate: string;
  fundId: string;
  perihalId: string | null;
  amountSen: number;
  method: Method | null;
  reference: string | null;
  note: string | null;
  payee: string | null;
  counters: Counter[] | null;
  denominations: Denominations | null;
  photoId: string | null;
  kuliahId: string | null;
  /** Ignored by the store (copied from the kuliah); accepted so an older client's body is not refused. */
  penceramahId: string | null;
  penceramahName: string | null;
  correctsId: string | null;
  correctionKind: CorrectionKind | null;
  toFundId: string | null;
  reason: string | null;
}

const ENTRY_KEYS: ReadonlySet<string> = new Set([
  'id', 'kind', 'entryDate', 'fundId', 'perihalId', 'amountSen', 'method', 'reference', 'note', 'payee', 'counters',
  'denominations', 'photoId', 'kuliahId', 'penceramahId', 'penceramahName', 'correctsId', 'correctionKind',
  'toFundId', 'reason',
]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const absent = (v: unknown): boolean => v === undefined || v === null;

/** A real calendar date `YYYY-MM-DD`. */
export function isRealDate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** First day of the month before `todayKl`. */
export function previousMonthStart(todayKl: string): string {
  const y = Number(todayKl.slice(0, 4)); const m = Number(todayKl.slice(5, 7));
  const py = m === 1 ? y - 1 : y; const pm = m === 1 ? 12 : m - 1;
  return `${String(py).padStart(4, '0')}-${String(pm).padStart(2, '0')}-01`;
}

function textField(v: unknown, name: string, min: number, max: number, errors: string[]): string | null {
  if (absent(v)) return null;
  if (typeof v !== 'string') { errors.push(`${name} must be text`); return null; }
  const t = v;
  if (t.length === 0 && min === 0) return null;
  if (t.trim().length < Math.max(1, min) || t.length > max || !PLAIN.test(t)) {
    errors.push(`${name} must be ${Math.max(1, min)}..${max} characters of plain text`);
    return null;
  }
  return t;
}

function idField(v: unknown, name: string, errors: string[], required: boolean): string | null {
  if (absent(v)) { if (required) errors.push(`${name} is required`); return null; }
  if (typeof v !== 'string' || !SAFE_ID.test(v)) { errors.push(`${name} must be 1-100 letters, digits, - or _`); return null; }
  return v;
}

function checkCounters(v: unknown, errors: string[]): Counter[] | null {
  if (!Array.isArray(v) || v.length !== COUNTERS_REQUIRED) {
    errors.push(`counters must list exactly ${COUNTERS_REQUIRED} people`);
    return null;
  }
  const out: Counter[] = [];
  const seen = new Set<string>();
  for (const c of v) {
    if (!isObj(c)) { errors.push('each counter must be an object'); return null; }
    const keys = Object.keys(c);
    if (keys.length !== 1) { errors.push('a counter is { userId } or { name }'); return null; }
    if (keys[0] === 'userId') {
      if (typeof c.userId !== 'string' || !SAFE_ID.test(c.userId)) { errors.push('counter userId is not valid'); return null; }
      if (seen.has(`u:${c.userId}`)) { errors.push('the two counters must be different people'); return null; }
      seen.add(`u:${c.userId}`);
      out.push({ userId: c.userId });
    } else if (keys[0] === 'name') {
      const name = c.name;
      if (typeof name !== 'string' || name.trim().length < 1 || name.length > 80 || !PLAIN.test(name)) {
        errors.push('counter name must be 1..80 characters of plain text'); return null;
      }
      const k = `n:${name.trim().toLowerCase()}`;
      if (seen.has(k)) { errors.push('the two counters must be different people'); return null; }
      seen.add(k);
      out.push({ name });
    } else { errors.push('a counter is { userId } or { name }'); return null; }
  }
  return out;
}

function checkDenominations(v: unknown, amountSen: number, errors: string[]): Denominations | null {
  if (!isObj(v)) { errors.push('denominations must be an object'); return null; }
  const allowed = new Set<string>([...DENOMS.map(String), 'coinsSen']);
  let sum = 0;
  const out: Denominations = {};
  for (const [k, n] of Object.entries(v)) {
    if (!allowed.has(k)) { errors.push(`denominations has an unknown key "${k}"`); return null; }
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > MAX_AMOUNT_SEN) {
      errors.push(`denominations.${k} must be a whole number >= 0`); return null;
    }
    (out as Record<string, number>)[k] = n;
    sum += k === 'coinsSen' ? n : n * Number(k) * 100;
  }
  if (sum !== amountSen) { errors.push('denominations must add up to the amount'); return null; }
  return out;
}

export type ShapeResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Shape and arithmetic of an entry body. `todayKl` is the server's KL date. */
export function validateEntryShape(v: unknown, ctx: { todayKl: string }): ShapeResult<EntryInput> {
  const errors: string[] = [];
  if (!isObj(v)) return { ok: false, errors: ['body must be an object'] };
  for (const k of Object.keys(v)) if (!ENTRY_KEYS.has(k)) errors.push(`${k} is not a known field`);
  if (errors.length > 0) return { ok: false, errors };

  const id = idField(v.id, 'id', errors, true);
  const kind = typeof v.kind === 'string' && (KINDS as readonly string[]).includes(v.kind) ? (v.kind as EntryKind) : null;
  if (!kind) errors.push('kind must be in, out, opening or adjust');

  let entryDate = '';
  if (!isRealDate(v.entryDate)) errors.push('entryDate must be a real date YYYY-MM-DD');
  else {
    entryDate = v.entryDate;
    if (entryDate > ctx.todayKl) errors.push('entryDate cannot be in the future');
    else if (entryDate < previousMonthStart(ctx.todayKl)) errors.push('entryDate cannot be before the previous month');
  }

  const fundId = idField(v.fundId, 'fundId', errors, true);
  const amount = v.amountSen;
  let amountSen = 0;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0 || amount > MAX_AMOUNT_SEN) {
    errors.push(`amountSen must be a whole number of sen 0..${MAX_AMOUNT_SEN}`);
  } else amountSen = amount;
  if (kind === 'in' || kind === 'out') {
    if (typeof amount === 'number' && amount === 0) errors.push('amountSen must be more than 0');
  }

  const note = textField(v.note, 'note', 0, 200, errors);
  const payee = textField(v.payee, 'payee', 0, 80, errors);
  const perihalId = idField(v.perihalId, 'perihalId', errors, kind === 'in' || kind === 'out');
  const photoId = absent(v.photoId) ? null : (typeof v.photoId === 'string' && PHOTO_RE.test(v.photoId) ? v.photoId : (errors.push('photoId must be 64 hex characters'), null));
  const kuliahId = idField(v.kuliahId, 'kuliahId', errors, false);
  const penceramahId = idField(v.penceramahId, 'penceramahId', errors, false);
  const penceramahName = textField(v.penceramahName, 'penceramahName', 0, 80, errors);

  let method: Method | null = null;
  let reference: string | null = null;
  let counters: Counter[] | null = null;
  let denominations: Denominations | null = null;
  let correctsId: string | null = null;
  let correctionKind: CorrectionKind | null = null;
  let toFundId: string | null = null;
  let reason: string | null = null;

  if (kind === 'in' || kind === 'out') {
    if (typeof v.method !== 'string' || !(METHODS as readonly string[]).includes(v.method)) errors.push('method must be tunai, bank, duitnow or cek');
    else method = v.method as Method;
    if (method === 'tunai') {
      if (!absent(v.reference)) errors.push('a cash entry has no reference');
      counters = checkCounters(v.counters, errors);
    } else if (method) {
      if (!absent(v.counters)) errors.push('only a cash entry has counters');
      if (typeof v.reference !== 'string' || v.reference.trim().length < 3 || v.reference.length > 60 || !PLAIN.test(v.reference)) {
        errors.push('reference must be 3..60 characters of plain text');
      } else reference = v.reference;
    }
    if (!absent(v.denominations)) {
      if (method !== 'tunai') errors.push('only a cash entry has denominations');
      else denominations = checkDenominations(v.denominations, amountSen, errors);
    }
    if (kind === 'in') {
      if (!absent(payee)) errors.push('a collection has no payee');
      if (!absent(v.kuliahId) || !absent(v.penceramahId) || !absent(v.penceramahName)) errors.push('a collection has no kuliah');
    }
    for (const k of ['correctsId', 'correctionKind', 'toFundId', 'reason'] as const) {
      if (!absent(v[k])) errors.push(`${k} belongs to a correction only`);
    }
  } else if (kind === 'opening') {
    for (const k of ['perihalId', 'method', 'reference', 'counters', 'denominations', 'photoId', 'payee', 'kuliahId', 'penceramahId', 'penceramahName', 'correctsId', 'correctionKind', 'toFundId', 'reason'] as const) {
      if (!absent(v[k])) errors.push(`${k} is not allowed on an opening balance`);
    }
  } else if (kind === 'adjust') {
    for (const k of ['perihalId', 'method', 'reference', 'counters', 'denominations', 'photoId', 'payee', 'kuliahId', 'penceramahId', 'penceramahName'] as const) {
      if (!absent(v[k])) errors.push(`${k} is not allowed on a correction`);
    }
    correctsId = idField(v.correctsId, 'correctsId', errors, true);
    if (typeof v.correctionKind !== 'string' || !(CORRECTIONS as readonly string[]).includes(v.correctionKind)) errors.push('correctionKind must be amount, void or fund');
    else correctionKind = v.correctionKind as CorrectionKind;
    if (typeof v.reason !== 'string' || v.reason.trim().length < REASON_MIN || v.reason.trim().length > REASON_MAX) {
      errors.push(`reason must be ${REASON_MIN}..${REASON_MAX} characters`);
    } else if (!/^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f<>]+$/.test(v.reason)) {
      errors.push('reason must be plain text');
    } else reason = v.reason.trim();
    if (correctionKind === 'fund') {
      toFundId = idField(v.toFundId, 'toFundId', errors, true);
      if (toFundId && toFundId === fundId) errors.push('toFundId must differ from the current tabung');
      if (amountSen !== 0) errors.push('amountSen must be 0 for a tabung change');
    } else {
      if (!absent(v.toFundId)) errors.push('toFundId is for a tabung change only');
      if (correctionKind === 'void' && amountSen !== 0) errors.push('amountSen must be 0 for a void');
    }
  }

  if (errors.length > 0 || !id || !kind || !fundId) return { ok: false, errors };
  return {
    ok: true,
    value: {
      id, kind, entryDate, fundId, perihalId, amountSen, method, reference, note, payee, counters, denominations,
      photoId, kuliahId, penceramahId, penceramahName, correctsId, correctionKind, toFundId, reason,
    },
  };
}

export interface FundInput {
  name: string;
  public: boolean;
  targetSen: number | null;
  jumaat: boolean;
  sortOrder: number;
  archivedAt: string | null;
}
export interface PerihalInput {
  direction: 'in' | 'out';
  label: string;
  sortOrder: number;
  archivedAt: string | null;
}

function nameField(v: unknown, what: string, errors: string[]): string {
  if (typeof v !== 'string' || v.trim().length < 1 || v.length > 60 || !PLAIN.test(v)) {
    errors.push(`${what} must be 1..60 characters of plain text`);
    return '';
  }
  return v.trim();
}

function archivedField(v: unknown, errors: string[]): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || !ISO_RE.test(v)) { errors.push('archivedAt must be null or a time'); return null; }
  return v;
}

const sortField = (v: unknown, errors: string[]): number => {
  if (v === undefined) return 0;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > 10_000) { errors.push('sortOrder must be a whole number 0..10000'); return 0; }
  return v;
};

/** Fund or perihal body. Unknown keys refuse the body; a client can never set `system`. */
export function validateLookup(kind: 'fund', v: unknown): ShapeResult<FundInput>;
export function validateLookup(kind: 'perihal', v: unknown): ShapeResult<PerihalInput>;
export function validateLookup(kind: 'fund' | 'perihal', v: unknown): ShapeResult<FundInput | PerihalInput> {
  const errors: string[] = [];
  if (!isObj(v)) return { ok: false, errors: ['body must be an object'] };
  const keys = kind === 'fund'
    ? ['name', 'public', 'targetSen', 'jumaat', 'sortOrder', 'archivedAt']
    : ['direction', 'label', 'sortOrder', 'archivedAt'];
  for (const k of Object.keys(v)) if (!keys.includes(k)) errors.push(`${k} is not a known field`);
  if (errors.length > 0) return { ok: false, errors };
  const archivedAt = archivedField(v.archivedAt, errors);
  const sortOrder = sortField(v.sortOrder, errors);
  if (kind === 'fund') {
    const name = nameField(v.name, 'name', errors);
    if (v.public !== undefined && typeof v.public !== 'boolean') errors.push('public must be true or false');
    if (v.jumaat !== undefined && typeof v.jumaat !== 'boolean') errors.push('jumaat must be true or false');
    let targetSen: number | null = null;
    if (v.targetSen !== undefined && v.targetSen !== null) {
      if (typeof v.targetSen !== 'number' || !Number.isSafeInteger(v.targetSen) || v.targetSen < 0 || v.targetSen > MAX_TARGET_SEN) {
        errors.push(`targetSen must be null or a whole number of sen 0..${MAX_TARGET_SEN}`);
      } else targetSen = v.targetSen;
    }
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, value: { name, public: v.public === true, targetSen, jumaat: v.jumaat === true, sortOrder, archivedAt } };
  }
  const label = nameField(v.label, 'label', errors);
  if (v.direction !== 'in' && v.direction !== 'out') errors.push('direction must be in or out');
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { direction: v.direction as 'in' | 'out', label, sortOrder, archivedAt } };
}

export interface MonthInput { ym: string; status: 'open' | 'closed' }

/** `{ ym, status }`: `ym` is a real month and not after the current KL month. */
export function validateMonth(v: unknown, ctx: { todayKl: string }): ShapeResult<MonthInput> {
  const errors: string[] = [];
  if (!isObj(v)) return { ok: false, errors: ['body must be an object'] };
  for (const k of Object.keys(v)) if (k !== 'ym' && k !== 'status') errors.push(`${k} is not a known field`);
  if (typeof v.ym !== 'string' || !YM_RE.test(v.ym)) errors.push('ym must be YYYY-MM');
  else if (v.ym > ctx.todayKl.slice(0, 7)) errors.push('ym cannot be after the current month');
  if (v.status !== 'open' && v.status !== 'closed') errors.push('status must be open or closed');
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { ym: v.ym as string, status: v.status as 'open' | 'closed' } };
}
