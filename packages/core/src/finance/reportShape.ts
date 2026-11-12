/**
 * The shape `monthReport` produces, as a guard. A frozen report that came from elsewhere (a replicated month) or from
 * storage is only served and drawn when it passes; anything else is refused or recomputed.
 */
import type { MonthReport } from './types.ts';

const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ['amount', 'void', 'fund'];

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.length <= 2000;
const strOrNull = (v: unknown): boolean => v === null || str(v);
const sen = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const date = (v: unknown): boolean => typeof v === 'string' && DATE_RE.test(v);

function inRow(r: unknown, out: boolean): boolean {
  if (!obj(r)) return false;
  if (!date(r.date) || !strOrNull(r.refNo) || !strOrNull(r.note) || !sen(r.amountSen)) return false;
  if (!out) return true;
  return strOrNull(r.payee) && strOrNull(r.penceramahName) && strOrNull(r.kuliahTitle) && (r.kuliahDate === null || date(r.kuliahDate));
}

function groups(v: unknown, out: boolean): boolean {
  return Array.isArray(v) && v.every((g) => obj(g) && str(g.perihalId) && str(g.label) && str(g.fundId) && sen(g.totalSen)
    && Array.isArray(g.rows) && g.rows.every((r) => inRow(r, out)));
}

/** True when `v` has exactly the fields and types of a MonthReport (extra keys are tolerated, missing or mistyped ones are not). */
export function isMonthReport(v: unknown): v is MonthReport {
  if (!obj(v)) return false;
  if (typeof v.ym !== 'string' || !YM_RE.test(v.ym)) return false;
  if (v.status !== 'open' && v.status !== 'closed') return false;
  if (!str(v.generatedAt) || !strOrNull(v.syncedUntil)) return false;
  if (!Array.isArray(v.funds) || !v.funds.every((f) => obj(f) && str(f.fundId) && str(f.name) && sen(f.openingSen) && sen(f.inSen)
    && sen(f.outSen) && sen(f.correctionsSen) && sen(f.closingSen))) return false;
  if (!groups(v.inByPerihal, false) || !groups(v.outByPerihal, true)) return false;
  if (!Array.isArray(v.corrections) || !v.corrections.every((c) => obj(c) && str(c.id) && date(c.date) && strOrNull(c.refNo)
    && strOrNull(c.originalRefNo) && typeof c.kind === 'string' && KINDS.includes(c.kind) && str(c.reason) && sen(c.deltaSen)
    && str(c.fundName) && typeof c.lastMonth === 'boolean')) return false;
  const t = v.totals;
  return obj(t) && sen(t.openingSen) && sen(t.inSen) && sen(t.outSen) && sen(t.correctionsSen) && sen(t.closingSen);
}
