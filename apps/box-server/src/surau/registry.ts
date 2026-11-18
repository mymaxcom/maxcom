import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { SURAU_ID_RE } from '@surau/core';
import { logChange, tx } from '../auth/users.ts';
import { LOCAL_SURAU_ID } from '../tenant.ts';
import { storageLimitOf, storageUsedBytes, DEFAULT_STORAGE_LIMIT_BYTES } from './storage.ts';

/**
 * The cloud's surau registry (Plan 14 Task 8, SECURITY code). A surau row is made by the cloud only: at a box's first
 * automatic claim, or by the cloud CLI. Its id is minted here (12 lower-case base32 characters, never `sdm`, never an
 * id that exists). Every change writes a `change_log` row `entity = 'surau'` under the surau itself; the feed never
 * carries that entity to a box.
 */

export const STATUS_WAITING = 'Menunggu MAXCOM';
export const STATUS_ACTIVE = 'Aktif';
export const STATUS_SUSPENDED = 'Digantung';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const NAME_MAX = 120;
const SHORT_MAX = 80;

export interface SurauBox {
  boxId: string;
  name: string;
  role: string;
  lastSeenAt: string | null;
  revoked: boolean;
}

export interface Surau {
  id: string;
  name: string;
  kind: string;
  location: string;
  zone: string;
  createdAt: string;
  createdBy: string;
  linkedAt: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
  status: string;
  /** The effective limit: the stored one, else the 2 GiB default. */
  storageLimitBytes: number;
}

export interface SurauDetail extends Surau {
  boxes: SurauBox[];
  storageUsedBytes: number;
  /** True when the surau holds nothing (see `surauUsage`): the Ops app may offer to delete it. */
  empty: boolean;
}

export interface NewSurau {
  name: string;
  kind?: string;
  location?: string;
  zone?: string;
}

/** Text stored or shown: no control (Cc) or format (Cf) characters, trimmed, at most `max`. */
export function cleanText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, max).replace(/[\uD800-\uDBFF]$/, '') : '';
}

function mintId(db: DatabaseSync): string {
  for (;;) {
    let id = '';
    // 256 is a multiple of 32, so a byte modulo 32 is unbiased
    for (const b of randomBytes(12)) id += ID_ALPHABET[b & 31];
    if (id !== 'sdm' && db.prepare('SELECT 1 AS x FROM suraus WHERE id = ?').get(id) === undefined) return id;
  }
}

function statusOf(r: Record<string, unknown>): string {
  if (typeof r.suspended_at === 'string') return STATUS_SUSPENDED;
  return typeof r.linked_at === 'string' ? STATUS_ACTIVE : STATUS_WAITING;
}

function rowOf(db: DatabaseSync, r: Record<string, unknown>): Surau {
  const id = String(r.id);
  return {
    id,
    name: String(r.name),
    kind: String(r.kind ?? 'surau'),
    location: String(r.location ?? ''),
    zone: String(r.zone ?? ''),
    createdAt: String(r.created_at),
    createdBy: String(r.created_by),
    linkedAt: typeof r.linked_at === 'string' ? r.linked_at : null,
    suspendedAt: typeof r.suspended_at === 'string' ? r.suspended_at : null,
    suspendedReason: typeof r.suspended_reason === 'string' ? r.suspended_reason : null,
    status: statusOf(r),
    storageLimitBytes: storageLimitOf(db, id) ?? DEFAULT_STORAGE_LIMIT_BYTES,
  };
}

/** Insert a surau row and its change_log row. The caller owns the transaction. Throws on an empty name. */
export function insertSurau(db: DatabaseSync, input: NewSurau, actor: string, at: Date = new Date()): Surau {
  const name = cleanText(input.name, NAME_MAX);
  if (name === '') throw new Error('surau name required');
  const kind = cleanText(input.kind ?? 'surau', SHORT_MAX) || 'surau';
  const location = cleanText(input.location ?? '', SHORT_MAX);
  const zone = cleanText(input.zone ?? '', SHORT_MAX);
  const by = cleanText(actor, SHORT_MAX) || 'system';
  const id = mintId(db);
  db.prepare('INSERT INTO suraus (id, name, kind, location, zone, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    name,
    kind,
    location,
    zone,
    at.toISOString(),
    by,
  );
  logChange(db, by, 'surau', id, undefined, { event: 'create', id, name, kind, location, zone }, undefined, id);
  return getSurau(db, id)!;
}

/** A new surau, status `Menunggu MAXCOM` until a box links. */
export function createSurau(db: DatabaseSync, input: NewSurau, actor: string): Surau {
  return tx(db, () => insertSurau(db, input, actor));
}

export function listSuraus(db: DatabaseSync): Surau[] {
  return db.prepare('SELECT * FROM suraus ORDER BY created_at, id').all().map((r) => rowOf(db, r));
}

/** One surau with its boxes (live and revoked) and what it holds; null for an unknown id. */
export function getSurau(db: DatabaseSync, id: string): SurauDetail | null {
  if (typeof id !== 'string' || !SURAU_ID_RE.test(id)) return null;
  const r = db.prepare('SELECT * FROM suraus WHERE id = ?').get(id);
  if (r === undefined) return null;
  const boxes = db
    .prepare('SELECT box_id, name, role, last_seen_at, revoked_at FROM sites WHERE surau_id = ? ORDER BY linked_at, box_id')
    .all(id)
    .map((b) => ({
      boxId: String(b.box_id),
      name: String(b.name),
      role: String(b.role ?? 'primary'),
      lastSeenAt: typeof b.last_seen_at === 'string' ? b.last_seen_at : null,
      revoked: b.revoked_at !== null,
    }));
  return { ...rowOf(db, r), boxes, storageUsedBytes: storageUsedBytes(db, id), empty: surauUsage(db, id).empty };
}

export type SurauErrorCode = 'surau_not_found' | 'bad_args' | 'limit_below_use' | 'not_empty';

export class SurauError extends Error {
  readonly code: SurauErrorCode;
  /** `not_empty`: the non-zero row counts per table. */
  readonly counts: Record<string, number>;
  constructor(code: SurauErrorCode, message: string, counts: Record<string, number> = {}) {
    super(message);
    this.name = 'SurauError';
    this.code = code;
    this.counts = counts;
  }
}

/** Tables whose surau rows do not make a surau non-empty: the audit trail, the version counter, the cloud-fetched prayer cache. */
const NOT_CONTENT_TABLES: ReadonlySet<string> = new Set(['change_log', 'meta', 'prayer_days']);

/** Every table with a `surau_id` column, read from the schema at run time (a new table is covered without a change here). */
function surauTables(db: DatabaseSync): string[] {
  return db
    .prepare(
      `SELECT m.name AS name FROM sqlite_master m
        WHERE m.type = 'table' AND substr(m.name, 1, 7) <> 'sqlite_'
          AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) p WHERE p.name = 'surau_id')
        ORDER BY m.name`,
    )
    .all()
    .map((r) => String(r.name));
}

export interface SurauUsage {
  /** Rows per table (non-zero only) that make the surau non-empty. */
  counts: Record<string, number>;
  empty: boolean;
}

/**
 * What a surau holds. EMPTY means: zero rows in every table that has a `surau_id` column, except `change_log`, `meta`,
 * `prayer_days` and unclaimed `site_approvals`; AND no row in `sites` at all (a revoked box stays on record so it cannot auto-link again); AND the id is not the local
 * surau (`sdm`) nor `*`. An unknown id counts as empty-with-nothing (the delete reports not found first).
 */
export function surauUsage(db: DatabaseSync, id: string): SurauUsage {
  const counts: Record<string, number> = {};
  if (id === LOCAL_SURAU_ID || id === '*') return { counts: { reserved: 1 }, empty: false };
  for (const t of surauTables(db)) {
    if (NOT_CONTENT_TABLES.has(t)) continue;
    const where = t === 'site_approvals' ? ' AND claimed_at IS NOT NULL' : '';
    const n = Number(db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE surau_id = ?${where}`).get(id)?.n ?? 0);
    if (n > 0) counts[t] = n;
  }
  return { counts, empty: Object.keys(counts).length === 0 };
}

/**
 * Delete a surau that holds nothing (`not_empty` 409 otherwise, with the counts; `surau_not_found` for an unknown id).
 * Removes its rows from every `surau_id` table except `change_log` (the audit is kept), its unclaimed approvals and
 * the `suraus` row, and writes one `change_log` entry, all in one transaction.
 */
export function deleteEmptySurau(db: DatabaseSync, id: string, actor: string): { id: string; name: string } {
  return tx(db, () => {
    const row = typeof id === 'string' && SURAU_ID_RE.test(id) ? db.prepare('SELECT id, name FROM suraus WHERE id = ?').get(id) : undefined;
    if (row === undefined) throw new SurauError('surau_not_found', 'Surau tidak dijumpai');
    const usage = surauUsage(db, id);
    if (!usage.empty) {
      const what = Object.entries(usage.counts).map(([t, n]) => `${t}: ${n}`).join(', ');
      throw new SurauError('not_empty', `Surau ini tidak kosong (${what}); ia tidak boleh dipadam`, usage.counts);
    }
    db.exec('PRAGMA defer_foreign_keys = ON');
    for (const t of surauTables(db)) {
      if (t === 'change_log') continue;
      db.prepare(`DELETE FROM "${t}" WHERE surau_id = ?`).run(id);
    }
    db.prepare('DELETE FROM suraus WHERE id = ?').run(id);
    const name = String(row.name);
    logChange(db, cleanText(actor, SHORT_MAX) || 'system', 'surau', id, undefined, { event: 'delete', id, name }, undefined, id);
    return { id, name };
  });
}

function update(db: DatabaseSync, id: string, actor: string, event: string, fn: (before: SurauDetail) => void): Surau {
  return tx(db, () => {
    const before = getSurau(db, id);
    if (before === null) throw new SurauError('surau_not_found', 'Surau tidak dijumpai');
    fn(before);
    const after = getSurau(db, id)!;
    const pick = (s: Surau): Record<string, unknown> => ({ suspendedAt: s.suspendedAt, suspendedReason: s.suspendedReason, storageLimitBytes: s.storageLimitBytes });
    logChange(db, actor, 'surau', id, pick(before), { event, ...pick(after) }, undefined, id);
    return after;
  });
}

/** Shut a surau out of the cloud: its sites and its phones get 403 `surau_suspended`. A reason is required. */
export function suspendSurau(db: DatabaseSync, id: string, reason: string, actor: string, now: Date = new Date()): Surau {
  const why = cleanText(reason, 200);
  if (why === '') throw new SurauError('bad_args', 'Sebab diperlukan');
  return update(db, id, actor, 'suspend', () => {
    db.prepare('UPDATE suraus SET suspended_at = ?, suspended_reason = ? WHERE id = ?').run(now.toISOString(), why, id);
  });
}

export function unsuspendSurau(db: DatabaseSync, id: string, actor: string): Surau {
  return update(db, id, actor, 'unsuspend', () => {
    db.prepare('UPDATE suraus SET suspended_at = NULL, suspended_reason = NULL WHERE id = ?').run(id);
  });
}

/**
 * Set one surau's storage limit in bytes (a positive safe integer), never below what the surau already holds
 * (`limit_below_use`): a limit under the current use would refuse every upload with nothing to free.
 */
export function setStorageLimit(db: DatabaseSync, id: string, bytes: number, actor: string): Surau {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new SurauError('bad_args', 'Had tidak sah');
  return update(db, id, actor, 'storage_limit', (before) => {
    if (bytes < before.storageUsedBytes) throw new SurauError('limit_below_use', 'Had lebih rendah daripada storan yang sudah digunakan surau ini');
    db.prepare('UPDATE suraus SET storage_limit_bytes = ? WHERE id = ?').run(bytes, id);
  });
}

/** True when the surau exists here and is suspended. */
export function isSuspended(db: DatabaseSync, id: string): boolean {
  return db.prepare('SELECT 1 AS x FROM suraus WHERE id = ? AND suspended_at IS NOT NULL').get(id) !== undefined;
}
