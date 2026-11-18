import type { DatabaseSync } from 'node:sqlite';
import { formatGlobalRef, formatRef, parseRef } from '@surau/core';
import type { RefKind, RefSrc } from '@surau/core';
import { AuthError, bumpFor, getUserRow, logChange, serverRoleOf, snapshot as userSnapshot, stampRow, tx } from './users.ts';
import { getDeviceWithKey, snap as deviceSnapshot } from './devices.ts';

/**
 * The allocated, stored, guaranteed unique ID of a user or a device (`U-0001`, `D-0001`; cloud series `U-C0001`).
 * Per surau and per kind a number issued once at creation, counting up from 1, never reused, never changed. It is a
 * label: no route authenticates, authorises or selects a write target by it.
 */

const tableOf = (kind: RefKind): 'users' | 'devices' => (kind === 'user' ? 'users' : 'devices');
const KINDS: readonly RefKind[] = ['user', 'device'];

/** `sync_state` key where a box remembers the role the cloud has on file for it (`primary`, `secondary`). */
export const SITE_ROLE_KEY = 'site_role';

/** The role the cloud last told this box it has (null: never told, or not linked). */
export function siteRoleOf(db: DatabaseSync): string | null {
  const r = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(SITE_ROLE_KEY);
  return r !== undefined && typeof r.value === 'string' && r.value.length > 0 ? r.value : null;
}

/**
 * May this server issue IDs for this surau now, and in which series? The cloud issues the C series for any surau.
 * A box issues the plain series for its own surau unless the cloud has told it it is not the primary box; it never
 * issues one for a Pentadbir MAXCOM (`'*'`, the cloud's).
 */
export function allocatorFor(db: DatabaseSync, surauId: string): RefSrc | null {
  if (serverRoleOf(db) === 'cloud') return 'c';
  if (surauId === '*') return null;
  const role = siteRoleOf(db);
  if (role === 'primary') return 'b';
  if (role !== null) return null;
  // The cloud has not (yet) said what this box is: only a box that was never linked may number its own records.
  // A linked or once-linked box waits for the cloud's answer (it might be a secondary) and adopts the cloud's numbers.
  return hasLinkHistory(db) ? null : 'b';
}

/** `sync_state` key a box keeps for good once it has been linked to a cloud (an unlink clears `linked`, never this). */
export const LINK_HISTORY_KEY = 'link_history';

function hasLinkHistory(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 AS x FROM sync_state WHERE key IN ('linked', 'cloud_url', ?) LIMIT 1").get(LINK_HISTORY_KEY) !== undefined;
}

const highestNo = (db: DatabaseSync, kind: RefKind, surauId: string, src: RefSrc): number => {
  const r = db.prepare(`SELECT MAX(no) AS n FROM ${tableOf(kind)} WHERE surau_id = ? AND no_src = ? AND no IS NOT NULL`).get(surauId, src);
  return Number.isInteger(r?.n) ? Number(r?.n) : 0;
};

/** Issue the next number of (surau, kind, series): never below the counter, never below 1 + the highest on a row. */
function issue(db: DatabaseSync, surauId: string, kind: RefKind, src: RefSrc): number {
  const cur = db.prepare('SELECT next FROM id_counters WHERE surau_id = ? AND kind = ?').get(surauId, kind);
  const counter = Number.isInteger(cur?.next) ? Number(cur?.next) : 1;
  const no = Math.max(counter, highestNo(db, kind, surauId, src) + 1);
  db.prepare(
    `INSERT INTO id_counters (surau_id, kind, next) VALUES (?, ?, ?)
     ON CONFLICT(surau_id, kind) DO UPDATE SET next = MAX(next, excluded.next)`,
  ).run(surauId, kind, no + 1);
  return no;
}

/**
 * Inside the caller's transaction: the next number for a record this server creates, or null when this server is not
 * an allocator for the surau (a secondary box, or a box for a `'*'` record).
 */
export function allocateNo(db: DatabaseSync, surauId: string, kind: RefKind): { no: number; src: RefSrc } | null {
  const src = allocatorFor(db, surauId);
  return src === null ? null : { no: issue(db, surauId, kind, src), src };
}

/** Give a record this server just created its number (a no-op when it is not an allocator or the row has one). */
export function assignNewNo(db: DatabaseSync, kind: RefKind, id: string, surauId: string): void {
  const n = allocateNo(db, surauId, kind);
  if (n !== null) db.prepare(`UPDATE ${tableOf(kind)} SET no = ?, no_src = ? WHERE id = ? AND no IS NULL`).run(n.no, n.src, id);
}

/** The short form of a stored number, or null while the record has none. */
export function refOfRow(row: Record<string, unknown>, kind: RefKind): string | null {
  const no = row.no;
  const src = row.no_src;
  return Number.isInteger(no) && Number(no) >= 1 && (src === 'b' || src === 'c') ? formatRef(kind, src, Number(no)) : null;
}

/** `<surau>/U-0001` for the superadmin, ops and CLI views (a `'*'` record is filed under `maxcom`). */
export function globalRefOfRow(row: Record<string, unknown>, kind: RefKind): string | null {
  const no = row.no;
  const src = row.no_src;
  if (!(Number.isInteger(no) && Number(no) >= 1 && (src === 'b' || src === 'c'))) return null;
  const surau = String(row.surau_id ?? '');
  return formatGlobalRef(surau === '*' ? 'maxcom' : surau, kind, src, Number(no));
}

/**
 * Number every row that has none, in creation order; idempotent. A box numbers all its local users (`created_at`,
 * id) and devices (`enrolled_at`, id), deactivated, deleted and revoked ones included, when it is an allocator. The
 * cloud numbers only the rows of `'*'` and of suraus that have no unrevoked primary box behind them.
 */
export function backfillIds(db: DatabaseSync, role: 'box' | 'cloud'): { users: number; devices: number } {
  const out = { users: 0, devices: 0 };
  const cloudHeld = (surauId: string): boolean =>
    role === 'cloud' && surauId !== '*' &&
    db.prepare("SELECT 1 AS x FROM sites WHERE surau_id = ? AND role = 'primary' AND linked_at IS NOT NULL AND revoked_at IS NULL").get(surauId) !== undefined;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const kind of KINDS) {
      const order = kind === 'user' ? 'created_at, id' : 'enrolled_at, id';
      const rows = db.prepare(`SELECT id, surau_id FROM ${tableOf(kind)} WHERE no IS NULL ORDER BY ${order}`).all();
      for (const r of rows) {
        const surau = String(r.surau_id);
        if (role === 'box' && surau === '*') continue;
        if (cloudHeld(surau)) continue;
        const src: RefSrc | null = role === 'cloud' ? 'c' : allocatorFor(db, surau);
        if (src === null) continue;
        const no = issue(db, surau, kind, src);
        db.prepare(`UPDATE ${tableOf(kind)} SET no = ?, no_src = ? WHERE id = ? AND no IS NULL`).run(no, src, String(r.id));
        out[kind === 'user' ? 'users' : 'devices'] += 1;
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return out;
}

/** Raise the counters to at least max + 1 (from the cloud's `maxNo`), so a restored box never reissues a number. */
export function raiseCounters(db: DatabaseSync, surauId: string, max: { user: number; device: number }): void {
  const up = db.prepare(
    `INSERT INTO id_counters (surau_id, kind, next) VALUES (?, ?, ?)
     ON CONFLICT(surau_id, kind) DO UPDATE SET next = MAX(next, excluded.next)`,
  );
  for (const kind of KINDS) {
    const m = max[kind];
    if (Number.isInteger(m) && m >= 0 && m < 1_000_000_000) up.run(surauId, kind, m + 1);
  }
}

/** Does a row other than `exceptId` of this surau and kind already hold the number of that series? */
export function numberTaken(db: DatabaseSync, surauId: string, kind: RefKind, src: RefSrc, no: number, exceptId?: string): boolean {
  const r = db.prepare(`SELECT id FROM ${tableOf(kind)} WHERE surau_id = ? AND no_src = ? AND no = ?`).get(surauId, src, no);
  return r !== undefined && String(r.id) !== exceptId;
}

/** A well-formed incoming `{ no, noSrc }` pair from an entry, or null. */
export function incomingNo(no: unknown, noSrc: unknown): { no: number; src: RefSrc } | null {
  return typeof no === 'number' && Number.isInteger(no) && no >= 1 && no < 1_000_000_000 && (noSrc === 'b' || noSrc === 'c') ? { no, src: noSrc } : null;
}

/**
 * Cloud, at ingest from a site, for a row that exists: keep a number the row already has (an ID never changes);
 * accept a `b` number only from the surau's primary site and only when no other row of that surau and kind holds it
 * (else `id_taken`, nothing changed); give a `c` number to a row arriving with none, or with a number it may not set.
 */
export function settleIncomingNo(
  db: DatabaseSync,
  row: { kind: RefKind; id: string; surauId: string },
  incoming: { no: number; src: RefSrc } | null,
  fromPrimarySite: boolean,
): 'kept' | 'assigned' | 'id_taken' {
  const table = tableOf(row.kind);
  const cur = db.prepare(`SELECT no FROM ${table} WHERE id = ?`).get(row.id);
  if (cur === undefined) return 'kept';
  if (cur.no !== null) return 'kept';
  if (incoming !== null && incoming.src === 'b' && fromPrimarySite) {
    if (numberTaken(db, row.surauId, row.kind, 'b', incoming.no, row.id)) return 'id_taken';
    db.prepare(`UPDATE ${table} SET no = ?, no_src = 'b' WHERE id = ? AND no IS NULL`).run(incoming.no, row.id);
    return 'kept';
  }
  const n = allocateNo(db, row.surauId, row.kind);
  if (n === null) return 'kept';
  db.prepare(`UPDATE ${table} SET no = ?, no_src = ? WHERE id = ? AND no IS NULL`).run(n.no, n.src, row.id);
  return 'assigned';
}

/**
 * Box: a number the cloud refused (`id_taken`: another record of the surau holds it there) is replaced by the next
 * free one, written as a new change so the record travels again with its new number. Only a plain-series number the
 * cloud never accepted is renumbered; the caller raised the counters from the cloud's `maxNo` first.
 */
export function renumberRow(db: DatabaseSync, kind: RefKind, id: string): void {
  tx(db, () => {
    const row = db.prepare(`SELECT * FROM ${tableOf(kind)} WHERE id = ?`).get(id);
    if (row === undefined || row.no_src !== 'b') return;
    const surau = String(row.surau_id);
    const n = allocateNo(db, surau, kind);
    if (n === null) return;
    db.prepare(`UPDATE ${tableOf(kind)} SET no = ?, no_src = ? WHERE id = ?`).run(n.no, n.src, id);
    stampRow(db, tableOf(kind), id);
    if (kind === 'user') {
      const u = getUserRow(db, id);
      if (u !== undefined) logChange(db, 'system', 'users', id, undefined, userSnapshot(u), undefined, surau);
    } else {
      const d = getDeviceWithKey(db, id);
      if (d !== undefined) logChange(db, 'system', 'devices', id, undefined, deviceSnapshot(d, d.publicJwk ?? {}, d.boxId), undefined, surau);
    }
    bumpFor(db, surau);
  });
}

/**
 * A cached lookup of the short ID of a user or device by id, for the answers that name a record (audit, finance
 * history). A `'*'` record's ID is given only when `includeStar` (an ops session): a surau session never learns it.
 */
export function refLookup(db: DatabaseSync, kind: RefKind, includeStar: boolean): (id: string | null | undefined) => string | null {
  const cache = new Map<string, string | null>();
  const stmt = db.prepare(`SELECT no, no_src, surau_id FROM ${tableOf(kind)} WHERE id = ?`);
  return (id) => {
    if (typeof id !== 'string' || id.length === 0) return null;
    if (cache.has(id)) return cache.get(id) ?? null;
    const r = stmt.get(id);
    const v = r === undefined || (!includeStar && String(r.surau_id) === '*') ? null : refOfRow(r, kind);
    cache.set(id, v);
    return v;
  };
}

/** The long form of every user or device that has an ID, by id, for an ops session's lists (`maxcom/U-C0001` for a `'*'` record). */
export function globalRefMap(db: DatabaseSync, kind: RefKind): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of db.prepare(`SELECT id, no, no_src, surau_id FROM ${tableOf(kind)} WHERE no IS NOT NULL`).all()) {
    const g = globalRefOfRow(r, kind);
    if (g !== null) m.set(String(r.id), g);
  }
  return m;
}

/**
 * The CLI's selector: one user id from a typed ID. On a box the short form (`U-0001`) names a user of its surau; on
 * the cloud the long form (`<surau>/U-0001`, `maxcom/U-C0001`) is needed, the short form being ambiguous. Exactly
 * one live row or an error; never a guess.
 */
export function userIdByRef(db: DatabaseSync, text: string, role: 'box' | 'cloud', localSurau: string): string {
  const p = parseRef(text);
  if (p === null || p.kind === 'device') throw new AuthError(400, 'bad_args', 'ID pengguna tidak sah (contoh U-0001)');
  if (role === 'cloud' && p.surauId === null) throw new AuthError(400, 'bad_args', 'Di awan guna bentuk penuh: <surau>/U-0001');
  const surau = p.surauId === null ? localSurau : p.surauId === 'maxcom' ? '*' : p.surauId;
  const hits = db.prepare('SELECT id FROM users WHERE surau_id = ? AND no_src = ? AND no = ?').all(surau, p.src, p.no);
  if (hits.length !== 1) throw new AuthError(404, 'user_not_found', 'Pengguna tidak dijumpai');
  return String(hits[0]!.id);
}

/** Problems `users check-ids` reports: two rows sharing (surau, kind, series, number), or a counter not above its highest number. */
export function checkIds(db: DatabaseSync, role: 'box' | 'cloud'): string[] {
  const out: string[] = [];
  const mine: RefSrc = role === 'cloud' ? 'c' : 'b';
  for (const kind of KINDS) {
    const t = tableOf(kind);
    for (const r of db.prepare(`SELECT surau_id, no_src, no, COUNT(*) AS n FROM ${t} WHERE no IS NOT NULL GROUP BY surau_id, no_src, no HAVING COUNT(*) > 1`).all()) {
      out.push(`${kind}: ${String(r.surau_id)} ${String(r.no_src)} ${String(r.no)} dipegang ${String(r.n)} rekod`);
    }
    for (const r of db.prepare(`SELECT surau_id, MAX(no) AS hi FROM ${t} WHERE no IS NOT NULL AND no_src = ? GROUP BY surau_id`).all(mine)) {
      const c = db.prepare('SELECT next FROM id_counters WHERE surau_id = ? AND kind = ?').get(String(r.surau_id), kind);
      if (!(Number.isInteger(c?.next) && Number(c?.next) > Number(r.hi))) out.push(`${kind}: pembilang ${String(r.surau_id)} tidak melebihi nombor tertinggi ${String(r.hi)}`);
    }
  }
  return out;
}
