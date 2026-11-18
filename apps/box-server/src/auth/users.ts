import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ROLES, isRole, normalisePhone } from '@surau/core';
import type { Role } from '@surau/core';
import { hashPin, isValidPin, pinPepperOf } from './crypto.ts';
import { bumpVersion } from '../settingsStore.ts';
import { revOf } from '../sync/meta.ts';
import { assignNewNo, refOfRow } from './ids.ts';
import { LOCAL_SURAU_ID } from '../tenant.ts';
import type { ChangeMeta } from '../sync/meta.ts';

export type { ChangeMeta } from '../sync/meta.ts';

export type AuthStatus = 400 | 401 | 403 | 404 | 409 | 423 | 429 | 502;

export class AuthError extends Error {
  readonly status: AuthStatus;
  readonly code: string;
  /** Seconds until a retry may succeed (sent as `Retry-After` on lockouts). */
  readonly retryAfterSec: number | undefined;
  /** Extra fields for the answer body (never a secret and never a phone number). */
  readonly extra: Record<string, unknown> | undefined;

  constructor(status: AuthStatus, code: string, message: string, retryAfterSec?: number, extra?: Record<string, unknown>) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
    this.extra = extra;
  }
}

/** BM messages for the client. */
export const MSG = {
  wrongPin: 'PIN salah',
  locked: (minutes: number): string => `Akaun dikunci. Cuba lagi dalam ${minutes} minit`,
  badEnrolCode: 'Kod pendaftaran tidak sah atau telah tamat',
  deviceRevoked: 'Peranti telah dibatalkan',
  sessionExpired: 'Sesi tamat. Sila buka kunci semula',
  forbidden: 'Tiada kebenaran untuk tindakan ini',
  tooMany: 'Terlalu banyak percubaan. Sila tunggu',
  pinPolicy: 'PIN mesti 6 digit dan tidak mudah diteka',
  pinExists: 'PIN sudah ditetapkan. Masukkan PIN semasa',
  pinRequired: 'PIN baharu diperlukan',
  pinMissing: 'PIN diperlukan',
  appLockOff: 'Kunci aplikasi dimatikan oleh pentadbir',
} as const;

/**
 * Which side this database serves. The Pentadbir MAXCOM (superadmin) lives on the cloud: a box takes
 * superadmin membership only from the cloud's feed, and the cloud takes nothing about a superadmin from a site.
 * Held per database (a test, or a process, may open both).
 */
const SERVER_ROLE = new WeakMap<DatabaseSync, 'box' | 'cloud'>();
export function setUsersRole(db: DatabaseSync, role: 'box' | 'cloud'): void {
  SERVER_ROLE.set(db, role);
}
const usersRole = (db: DatabaseSync): 'box' | 'cloud' => SERVER_ROLE.get(db) ?? 'box';
/** The role `setUsersRole` recorded for this database (`box` when never set). */
export const serverRoleOf = usersRole;

/**
 * This server's own box id (Plan 14 Task 7). A box stamps it into `devices.box_id` at every enrolment it makes, so
 * the cloud learns which box a phone signs for. Unset (a bare database in a test or a CLI): the row stays NULL and
 * signatures fall back to the server id, as before.
 */
const SERVER_BOX = new WeakMap<DatabaseSync, string>();
export function setServerBoxId(db: DatabaseSync, boxId: string): void {
  SERVER_BOX.set(db, boxId);
}
export function serverBoxIdOf(db: DatabaseSync): string | null {
  return SERVER_BOX.get(db) ?? null;
}

export interface User {
  id: string;
  name: string;
  roles: Role[];
  active: boolean;
  pinRequired: boolean;
  pinLockedUntil: string | null;
  createdAt: string;
  createdBy: string;
  /** The allocated ID number and its series (null while the record waits for one). */
  no: number | null;
  noSrc: 'b' | 'c' | null;
  /** The ID in its short form (`U-0001`), null while unassigned. */
  ref: string | null;
  /** Soft delete: a deleted person is in no list a surau can reach; the row and its history stay. */
  deleted: boolean;
  deletedAt: string | null;
  deletedBy: string | null;
  /** When the person was deactivated (null while active); the 365-day clean-up counts from here. */
  deactivatedAt: string | null;
  /** The surau the person is filed under (`'*'` for a Pentadbir MAXCOM). */
  surauId: string;
  /**
   * E.164, or null. Personal data: only the Pentadbir (users:manage), the person for their own account and the
   * Pentadbir MAXCOM through ops or the CLI ever receive it; never in a log, an audit answer or an error.
   */
  phone: string | null;
}

/** Run fn in an IMMEDIATE transaction (rolls back on throw). Not re-entrant. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** The name of the person behind a `user:<id>` actor right now, or null (`system`, a device, an unknown id). */
export function actorNameOf(db: DatabaseSync, actor: string, hideStar = false): string | null {
  if (!actor.startsWith('user:')) return null;
  const r = db.prepare('SELECT name, surau_id FROM users WHERE id = ?').get(actor.slice(5));
  if (r !== undefined && hideStar && r.surau_id === '*') return null;
  return r !== undefined && typeof r.name === 'string' ? r.name : null;
}

/** Is this actor a `user:<id>` of a Pentadbir MAXCOM / Sokongan MAXCOM row (`users.surau_id = '*'`)? */
export function isStarActor(db: DatabaseSync, actor: string): boolean {
  if (!actor.startsWith('user:')) return false;
  return db.prepare("SELECT 1 FROM users WHERE id = ? AND surau_id = '*'").get(actor.slice(5)) !== undefined;
}

/** Append a change_log row (secrets must already be stripped from before/after). Caller owns the tx. */
export function logChange(
  db: DatabaseSync,
  actor: string,
  entity: string,
  entityId: string,
  before: unknown,
  after: unknown,
  meta: ChangeMeta | undefined,
  surauId: string,
): void {
  // `'*'` is for the Pentadbir MAXCOM rows and their devices only: the feed hands those to every site.
  if (surauId === '*' && entity !== 'users' && entity !== 'devices') throw new Error(`change_log: ${entity} cannot be filed under '*'`);
  const at = new Date().toISOString();
  const editedAt = meta?.editedAt ?? at;
  db.prepare(
    `INSERT INTO change_log (surau_id, at, actor, entity, entity_id, before_json, after_json, device_id, origin, op_id, edited_at, synced_at, rev, actor_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    surauId,
    at,
    actor,
    entity,
    entityId,
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
    meta?.deviceId ?? null,
    meta?.origin ?? 'local',
    meta?.opId ?? null,
    editedAt,
    meta?.syncedAt ?? null,
    revOf(editedAt, meta),
    actorNameOf(db, actor),
  );
}

/** Stamp the sync columns of a users/devices row after a write. Caller owns the tx. */
export function stampRow(db: DatabaseSync, table: 'users' | 'devices', id: string, meta?: ChangeMeta): void {
  const editedAt = meta?.editedAt ?? new Date().toISOString();
  db.prepare(`UPDATE ${table} SET rev = ?, edited_at = ?, origin = ? WHERE id = ?`).run(
    revOf(editedAt, meta),
    editedAt,
    meta?.origin ?? 'local',
    id,
  );
}

type Row = Record<string, unknown>;

export function parseRoles(json: unknown): Role[] {
  try {
    const v: unknown = JSON.parse(String(json));
    return Array.isArray(v) ? v.filter((r): r is Role => typeof r === 'string' && isRole(r)) : [];
  } catch {
    return [];
  }
}

function toUser(row: Row): User {
  return {
    id: String(row.id),
    name: String(row.name),
    roles: parseRoles(row.roles_json),
    active: Number(row.active) === 1,
    pinRequired: !(typeof row.pin_hash === 'string' && row.pin_hash.length > 0),
    pinLockedUntil: typeof row.pin_locked_until === 'string' ? row.pin_locked_until : null,
    createdAt: String(row.created_at),
    createdBy: String(row.created_by),
    no: Number.isInteger(row.no) ? Number(row.no) : null,
    noSrc: row.no_src === 'b' || row.no_src === 'c' ? row.no_src : null,
    ref: refOfRow(row, 'user'),
    deleted: typeof row.deleted_at === 'string',
    deletedAt: typeof row.deleted_at === 'string' ? row.deleted_at : null,
    deletedBy: typeof row.deleted_by === 'string' ? row.deleted_by : null,
    deactivatedAt: typeof row.deactivated_at === 'string' && Number(row.active) !== 1 ? row.deactivated_at : null,
    surauId: String(row.surau_id),
    phone: typeof row.phone === 'string' && row.phone.length > 0 ? row.phone : null,
  };
}

/** Secret-free snapshot for change_log. */
export function snapshot(u: User): Record<string, unknown> {
  return { id: u.id, name: u.name, roles: u.roles, active: u.active, hasPin: !u.pinRequired, ...(u.no !== null && u.noSrc !== null ? { no: u.no, noSrc: u.noSrc } : {}), ...(u.deleted ? { deleted: true } : {}), ...(u.phone !== null && u.surauId !== '*' ? { phone: u.phone } : {}) };
}

export interface AuthUser extends User {
  pinHash: string | null;
  pinFailCount: number;
  lockRound: number;
}

/** Internal view WITH the PIN hash, for the unlock flow. Never return this from a route. */
export function getAuthUser(db: DatabaseSync, id: string): AuthUser | undefined {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (row === undefined) return undefined;
  return {
    ...toUser(row),
    pinHash: typeof row.pin_hash === 'string' ? row.pin_hash : null,
    pinFailCount: Number(row.pin_fail_count),
    lockRound: Number(row.lock_round),
  };
}

export function getUserRow(db: DatabaseSync, id: string): User | undefined {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return row === undefined ? undefined : toUser(row);
}

/**
 * A user as one surau sees them: by id, in the surau. A Pentadbir MAXCOM row (`'*'`) is hidden from every surau
 * session (operator decisions 21 and 22); only an ops-device session passes `includeStar`, and then sees it as
 * Pentadbir MAXCOM only on the cloud (its surau-level roles are not its power here).
 */
function toUserInTenant(row: Row, db: DatabaseSync, ops: boolean): User {
  let u = toUser(row);
  if (row.surau_id === '*' && usersRole(db) === 'cloud') u = { ...u, roles: u.roles.filter((r) => r === 'superadmin' || r === 'support') };
  // a surau session never learns who a Pentadbir MAXCOM is, not even through who added or deleted a person
  if (!ops) {
    if (isStarActor(db, u.createdBy)) u = { ...u, createdBy: 'system' };
    if (u.deletedBy !== null && isStarActor(db, u.deletedBy)) u = { ...u, deletedBy: 'system' };
  }
  return u;
}

export function getUserInTenant(db: DatabaseSync, id: string, surauId: string, includeStar = false): User | undefined {
  // a deleted person is never a target of a write route, whoever asks (a read of the deleted list goes through listUsers)
  const row = db.prepare('SELECT * FROM users WHERE id = ? AND surau_id IN (?, ?) AND deleted_at IS NULL').get(id, surauId, includeStar ? '*' : surauId);
  return row === undefined ? undefined : toUserInTenant(row, db, includeStar);
}

/**
 * The surau a user row is filed under (`'*'` for a Pentadbir MAXCOM). The user stores that act on an existing user
 * log and bump under the row's own surau, so a caller cannot file a change under another surau by mistake.
 */
export function userSurau(db: DatabaseSync, id: string): string {
  const r = db.prepare('SELECT surau_id FROM users WHERE id = ?').get(id);
  if (typeof r?.surau_id !== 'string') throw new AuthError(404, 'user_not_found', 'Pengguna tidak dijumpai');
  return r.surau_id;
}

/** Is this user a Pentadbir MAXCOM / Sokongan MAXCOM row (`users.surau_id = '*'`)? */
export function isStarUser(db: DatabaseSync, id: string): boolean {
  return db.prepare("SELECT 1 AS x FROM users WHERE id = ? AND surau_id = '*'").get(id) !== undefined;
}

/**
 * SQL condition over a `change_log` alias: the row is NOT a Pentadbir MAXCOM row (operator decision 22). A row is
 * a `*` row when its actor is a `*` user, its device is a `*` user's or an ops device, or it is the user or device
 * entity of one. Null columns never match (COALESCE), so an ordinary row with no device stays visible.
 */
export function notStarChangeSql(alias: string): string {
  const starDevices = "SELECT d.id FROM devices d LEFT JOIN users u ON u.id = d.user_id WHERE d.surau_id = '*' OR u.surau_id = '*'";
  const starUsers = "SELECT id FROM users WHERE surau_id = '*'";
  return `NOT (${alias}.actor IN (SELECT 'user:' || id FROM users WHERE surau_id = '*')`
    + ` OR COALESCE(${alias}.device_id, '') IN (${starDevices})`
    + ` OR (${alias}.entity IN ('users', 'user') AND COALESCE(${alias}.entity_id, '') IN (${starUsers}))`
    + ` OR (${alias}.entity IN ('devices', 'device') AND COALESCE(${alias}.entity_id, '') IN (${starDevices})))`;
}

/** The surau of a device row (`'*'` for an ops device). */
export function deviceSurau(db: DatabaseSync, id: string): string {
  const r = db.prepare('SELECT surau_id FROM devices WHERE id = ?').get(id);
  if (typeof r?.surau_id !== 'string') throw new AuthError(404, 'device_not_found', 'Peranti tidak dijumpai');
  return r.surau_id;
}

/**
 * The surau a change of a `'*'` row (a Pentadbir MAXCOM, an ops device) is ANNOUNCED under (the version bump, the
 * app-lock setting read for its device): the local surau, as before. Any other scope is itself. Its change_log row
 * is filed under `'*'` itself: the feed hands `'*'` user and device entries to every site (Plan 14 Task 6).
 */
export const announceSurau = (surauId: string): string => (surauId === '*' ? LOCAL_SURAU_ID : surauId);

/**
 * Bump the version of the surau a change of this scope is announced under. On the cloud a `'*'` change (a Pentadbir
 * MAXCOM row, which the feed hands to every site) bumps every surau that has a site, and no other: never a surau id
 * that does not exist (the local constant may be no surau there).
 */
export function bumpFor(db: DatabaseSync, surauId: string): void {
  if (surauId === '*' && usersRole(db) === 'cloud') {
    const rows = db.prepare('SELECT DISTINCT surau_id AS id FROM sites ORDER BY surau_id').all();
    for (const r of rows) bumpVersion(db, String(r.id));
    return;
  }
  bumpVersion(db, announceSurau(surauId));
}

function requireUser(db: DatabaseSync, id: string): User {
  const u = getUserRow(db, id);
  if (u === undefined) throw new AuthError(404, 'user_not_found', 'Pengguna tidak dijumpai');
  return u;
}

export function checkRoles(roles: unknown): Role[] {
  if (!Array.isArray(roles) || roles.length === 0 || !roles.every((r) => typeof r === 'string' && isRole(r))) {
    throw new AuthError(400, 'bad_roles', 'Peranan tidak sah');
  }
  const set = new Set(roles as Role[]);
  return ROLES.filter((r) => set.has(r));
}

/**
 * The one name rule for a person or a device: trimmed, inner runs of whitespace collapsed to one space, 1 to 80
 * characters, no control characters and no direction overrides or isolates (U+202A to U+202E, U+2066 to U+2069).
 */
export function cleanNameText(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  if (/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/.test(name)) return null;
  const clean = name.replace(/\s+/g, ' ').trim();
  return clean.length === 0 || clean.length > 80 ? null : clean;
}

export function checkName(name: unknown): string {
  const clean = cleanNameText(name);
  if (clean === null) throw new AuthError(400, 'bad_name', 'Nama tidak sah');
  return clean;
}

const holdsAdmin = (roles: readonly Role[]): boolean => roles.includes('admin') || roles.includes('superadmin');

/**
 * The rules for who may hold `superadmin`, applied to every write that can change a user's roles.
 * - Membership changes only through the cloud: on a box only a replicated cloud entry may add or remove it;
 *   on the cloud a replicated entry (from a box) never may, and never edits a superadmin row at all.
 *   The first Pentadbir MAXCOM is made by `promoteSuperadmin`, run on the cloud itself.
 * - The last active superadmin cannot be demoted or deactivated.
 */
function guardSuperadmin(
  db: DatabaseSync,
  before: User | undefined,
  after: { roles: readonly Role[]; active: boolean },
  meta?: ChangeMeta,
): void {
  const had = before?.roles.includes('superadmin') === true;
  const has = after.roles.includes('superadmin');
  const replicated = meta?.trusted === true;
  if (usersRole(db) === 'cloud' && replicated && (had || has)) {
    throw new AuthError(403, 'superadmin_cloud_only', 'Urus Pentadbir MAXCOM melalui awan MAXCOM');
  }
  if (had !== has && usersRole(db) === 'box' && !replicated) {
    throw new AuthError(403, 'superadmin_cloud_only', 'Urus Pentadbir MAXCOM melalui awan MAXCOM');
  }
  if (before?.active === true && had && (!has || !after.active) && activeSuperadminCount(db) <= 1) {
    throw new AuthError(409, 'last_superadmin', 'Mesti ada sekurang-kurangnya seorang Pentadbir MAXCOM aktif');
  }
}

/**
 * Acting on a Pentadbir MAXCOM (reset the PIN, issue a code, change roles, deactivate, revoke a device, edit the
 * row) needs `superadmin:manage`, whatever the caller may do to other users. Without this an ordinary admin could
 * reset a superadmin's PIN, enrol a device for it and unlock as it. A missing user passes (the caller's own 404).
 */
export function requireSuperadminTarget(db: DatabaseSync, targetUserId: string, callerMayManage: boolean): void {
  if (callerMayManage) return;
  if (getUserRow(db, targetUserId)?.roles.includes('superadmin') === true) {
    throw new AuthError(403, 'forbidden', MSG.forbidden);
  }
}

/**
 * A user who GAINS the Pentadbir MAXCOM role ends their open sessions: a session opened before (maybe without a
 * PIN, as an ordinary admin) must not carry the new role. Caller owns the tx.
 */
function endSessionsOnSuperadminGain(db: DatabaseSync, userId: string, hadBefore: boolean, hasAfter: boolean): void {
  if (hadBefore || !hasAfter) return;
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(new Date().toISOString(), userId);
}

/** A phone number as stored (E.164) or 400. The refusal never echoes the value. */
export function checkPhone(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) throw new AuthError(400, 'phone_required', 'Nombor telefon diperlukan');
  const e164 = normalisePhone(raw);
  if (e164 === null) throw new AuthError(400, 'bad_phone', 'Nombor telefon tidak sah');
  return e164;
}

/** The other person of the same surau (not deleted, a deactivated one still counts) who holds this number. */
export function phoneOwner(db: DatabaseSync, surauId: string, phone: string, exceptId: string): { id: string; ref: string | null } | null {
  const r = db.prepare('SELECT id, no, no_src FROM users WHERE surau_id = ? AND phone = ? AND deleted_at IS NULL AND id <> ? ORDER BY created_at, id LIMIT 1').get(surauId, phone, exceptId);
  return r === undefined ? null : { id: String(r.id), ref: refOfRow(r, 'user') };
}

/** One person, one account: refuse (409 `phone_taken`) a number another live person of the surau holds; the answer names that person by ID only. */
function refuseTakenPhone(db: DatabaseSync, surauId: string, phone: string, exceptId: string): void {
  const other = phoneOwner(db, surauId, phone, exceptId);
  if (other !== null) throw new AuthError(409, 'phone_taken', 'Nombor telefon ini sudah digunakan oleh pengguna lain', undefined, { ref: other.ref });
}

/**
 * Change a person's phone number (Pentadbir). The same number is a no-op with no log row. Caller checked tenant and
 * `*`. The change row carries the number as the sync transport; audit readers never see it (`phoneChanged` only).
 */
export function setUserPhone(db: DatabaseSync, id: string, raw: unknown, actor: string): User {
  const phone = checkPhone(raw);
  return tx(db, () => {
    const before = requireUser(db, id);
    if (before.phone === phone) return before;
    refuseTakenPhone(db, before.surauId, phone, id);
    db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, id);
    stampRow(db, 'users', id);
    const after = requireUser(db, id);
    logChange(db, actor, 'users', id, snapshot(before), snapshot(after), undefined, before.surauId);
    bumpFor(db, before.surauId);
    return after;
  });
}

export function createUser(db: DatabaseSync, input: { name: string; roles: Role[]; phone?: string }, actor: string, surauId: string): User {
  return tx(db, () => createUserIn(db, input, actor, surauId));
}

/** `createUser` for a caller that already owns the transaction (setup and recovery create the user and its device together). */
export function createUserIn(db: DatabaseSync, input: { name: string; roles: Role[]; phone?: string }, actor: string, surauId: string): User {
  const name = checkName(input.name);
  const roles = checkRoles(input.roles);
  guardSuperadmin(db, undefined, { roles, active: true });
  const id = randomUUID();
  const filedUnder = roles.some((r) => r === 'superadmin' || r === 'support') ? '*' : surauId;
  const phone = input.phone === undefined ? null : checkPhone(input.phone);
  if (phone !== null) refuseTakenPhone(db, filedUnder, phone, id);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, name, roles_json, active, created_at, created_by, surau_id) VALUES (?, ?, ?, 1, ?, ?, ?)`,
  ).run(id, name, JSON.stringify(roles), now, actor, filedUnder);
  assignNewNo(db, 'user', id, filedUnder);
  if (phone !== null) db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, id);
  stampRow(db, 'users', id);
  const user = requireUser(db, id);
  logChange(db, actor, 'users', id, undefined, snapshot(user), undefined, filedUnder);
  bumpFor(db, filedUnder);
  return user;
}

/** Every user row of the database, whatever the surau (for the global Pentadbir MAXCOM rules). */
function allUsers(db: DatabaseSync): User[] {
  return db.prepare('SELECT * FROM users ORDER BY created_at, id').all().map(toUser);
}

/**
 * Active users who can administer one surau: its own Pentadbir Surau. A Pentadbir MAXCOM (`'*'`) is nobody's last
 * administrator, on the cloud or on a box (operator decision 22). Whether a box needs recovery is decided by
 * `activeAdminDeviceCount` (real roles, with a device), which is unchanged.
 */
export function activeAdminCount(db: DatabaseSync, surauId: string): number {
  return adminRows(db, surauId, false);
}

/**
 * The count the replication guard uses: on a box a replicated Pentadbir MAXCOM row still counts, so the box refuses
 * a replicated change that would leave it with no administrator at all (as before). The cloud counts the surau only.
 */
function activeAdminCountForSync(db: DatabaseSync, surauId: string): number {
  return adminRows(db, surauId, usersRole(db) === 'box');
}

function adminRows(db: DatabaseSync, surauId: string, withStar: boolean): number {
  const rows = db
    .prepare(`SELECT * FROM users WHERE active = 1 AND deleted_at IS NULL AND surau_id IN (?, ?)`)
    .all(surauId, withStar ? '*' : surauId);
  return rows.map(toUser).filter((u) => holdsAdmin(u.roles)).length;
}

/** Active users holding the superadmin role (global: Pentadbir MAXCOM is not per surau). */
export function activeSuperadminCount(db: DatabaseSync): number {
  return allUsers(db).filter((u) => u.active && u.roles.includes('superadmin')).length;
}

/**
 * Users of one surau. The Pentadbir MAXCOM rows (`'*'`) are listed only with `includeStar` (an ops-device session
 * or the CLI). Never includes the PIN hash.
 */
export function listUsers(db: DatabaseSync, surauId: string, includeStar = false): User[] {
  return db
    .prepare(`SELECT * FROM users WHERE surau_id IN (?, ?)${includeStar ? '' : ' AND deleted_at IS NULL'} ORDER BY created_at, id`)
    .all(surauId, includeStar ? '*' : surauId)
    .map((r) => toUserInTenant(r, db, includeStar));
}

/**
 * Keep `users.surau_id` in step with `superadmin` (migration 019: a superadmin is `'*'`). Gaining it files the
 * user under `'*'`; losing it puts the user back in the surau of their oldest live device, else the local surau
 * constant. Caller owns the tx.
 */
function syncUserScope(db: DatabaseSync, id: string, hadSuper: boolean, hasSuper: boolean): void {
  if (hadSuper === hasSuper) return;
  if (hasSuper) {
    // The ID is per surau: a person filed under a new scope takes the next number of that scope (the one exception to "never changes").
    db.prepare(`UPDATE users SET surau_id = '*', no = NULL, no_src = NULL WHERE id = ?`).run(id);
    assignNewNo(db, 'user', id, '*');
    return;
  }
  const home = db
    .prepare(`SELECT surau_id FROM devices WHERE user_id = ? AND surau_id <> '*' AND revoked_at IS NULL ORDER BY enrolled_at, id LIMIT 1`)
    .get(id);
  const surau = typeof home?.surau_id === 'string' ? home.surau_id : LOCAL_SURAU_ID;
  db.prepare('UPDATE users SET surau_id = ?, no = NULL, no_src = NULL WHERE id = ?').run(surau, id);
  assignNewNo(db, 'user', id, surau);
}

export function setRoles(db: DatabaseSync, id: string, roles: Role[], actor: string): User {
  const checked = checkRoles(roles);
  return tx(db, () => {
    const before = requireUser(db, id);
    guardSuperadmin(db, before, { roles: checked, active: before.active });
    const surauBefore = userSurau(db, id);
    db.prepare('UPDATE users SET roles_json = ? WHERE id = ?').run(JSON.stringify(checked), id);
    endSessionsOnSuperadminGain(db, id, before.roles.includes('superadmin'), checked.includes('superadmin'));
    syncUserScope(db, id, before.roles.includes('superadmin'), checked.includes('superadmin'));
    stampRow(db, 'users', id);
    const after = requireUser(db, id);
    const surauAfter = userSurau(db, id);
    logChange(db, actor, 'users', id, snapshot(before), snapshot(after), undefined, surauAfter);
    bumpFor(db, surauAfter);
    // a demoted Pentadbir MAXCOM changes the list of the surau it comes back to, and the one it leaves
    if (surauBefore !== surauAfter) bumpFor(db, surauBefore);
    return after;
  });
}

/** Rename a user. The same name after cleaning is a no-op with no log row. Caller checked tenant and `*`. */
export function renameUser(db: DatabaseSync, id: string, name: string, actor: string): User {
  const clean = checkName(name);
  return tx(db, () => {
    const before = requireUser(db, id);
    if (before.name === clean) return before;
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(clean, id);
    stampRow(db, 'users', id);
    const after = requireUser(db, id);
    const own = userSurau(db, id);
    logChange(db, actor, 'users', id, snapshot(before), snapshot(after), undefined, own);
    bumpFor(db, own);
    return after;
  });
}

/** Set (or reset) the PIN under the PIN policy and clear the lockout state. */
export async function setPin(db: DatabaseSync, id: string, pin: string, actor: string): Promise<void> {
  if (!isValidPin(pin)) {
    throw new AuthError(400, 'pin_policy', 'PIN mesti 6 digit dan tidak mudah diteka');
  }
  const hash = await hashPin(pin, pinPepperOf(db));
  tx(db, () => {
    const before = requireUser(db, id);
    db.prepare(
      `UPDATE users SET pin_hash = ?, pin_fail_count = 0, pin_locked_until = NULL, lock_round = 0 WHERE id = ?`,
    ).run(hash, id);
    const after = requireUser(db, id);
    const own = userSurau(db, id);
    logChange(db, actor, 'users', id, snapshot(before), { ...snapshot(after), pinChanged: true }, undefined, own);
    bumpFor(db, own);
  });
}

/** Revoke a device and its sessions. Caller owns the tx. Returns true if it was newly revoked. */
export function revokeDeviceRow(
  db: DatabaseSync,
  deviceId: string,
  actor: string,
  now: string,
  meta?: ChangeMeta,
): boolean {
  const dev = db
    .prepare('SELECT id, user_id, name, platform, revoked_at, surau_id FROM devices WHERE id = ?')
    .get(deviceId);
  if (dev === undefined) return false;
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(now, deviceId);
  if (dev.revoked_at !== null) return false;
  db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(now, deviceId);
  stampRow(db, 'devices', deviceId, meta);
  const base = { id: dev.id, userId: dev.user_id, name: dev.name, platform: dev.platform };
  logChange(db, actor, 'devices', deviceId, { ...base, revoked: false }, { ...base, revoked: true }, meta, String(dev.surau_id));
  return true;
}

/** Deactivate a user body (revoke every device and session). Caller owns the tx. */
export function deactivateUserRows(db: DatabaseSync, id: string, actor: string, now: string, meta?: ChangeMeta): void {
  const before = requireUser(db, id);
  // `deactivated_at` is the only input of the 365-day clean-up: set by every deactivation, cleared by every activation.
  db.prepare('UPDATE users SET active = 0, deactivated_at = ? WHERE id = ?').run(now, id);
  stampRow(db, 'users', id, meta);
  // Kiosk displays belong to the box, not to the admin who happened to approve the pairing.
  for (const d of db.prepare("SELECT id FROM devices WHERE user_id = ? AND platform <> 'kiosk'").all(id)) {
    // Side effects of the op: logged without the op id (that belongs to the user row's entry, once).
    revokeDeviceRow(db, String(d.id), actor, now, meta === undefined ? undefined : { ...meta, opId: undefined });
  }
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, id);
  db.prepare('UPDATE enrolments SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(now, id);
  logChange(db, actor, 'users', id, snapshot(before), { ...snapshot(before), active: false }, meta, userSurau(db, id));
}

/** The body of `deactivateUser` for a caller that owns the transaction. */
export function deactivateUserIn(db: DatabaseSync, id: string, actor: string): void {
  const now = new Date().toISOString();
  const target = requireUser(db, id);
  guardSuperadmin(db, target, { roles: target.roles, active: false });
  deactivateUserRows(db, id, actor, now);
  bumpFor(db, userSurau(db, id));
}

/** Deactivate a user: revoke every device and session in the same transaction. */
export function deactivateUser(db: DatabaseSync, id: string, actor: string): void {
  tx(db, () => deactivateUserIn(db, id, actor));
}

/**
 * Padam: soft delete. In the caller's transaction the person is deactivated when active (every device, session and
 * open code revoked, so they cannot sign in), then `deleted_at` and `deleted_by` are set and one change row records
 * `deleted: true`. Nothing is physically removed. A deleted person is a no-op. Caller checked tenant, `*` and the
 * last-Pentadbir rules.
 */
export function deleteUserRows(db: DatabaseSync, id: string, actor: string, now: string, meta?: ChangeMeta): void {
  const before = requireUser(db, id);
  if (before.deleted) return;
  if (before.active) deactivateUserRows(db, id, actor, now, meta === undefined ? undefined : { ...meta, opId: undefined });
  db.prepare('UPDATE users SET active = 0, deleted_at = ?, deleted_by = ?, deactivated_at = COALESCE(deactivated_at, ?) WHERE id = ?').run(now, actor, now, id);
  stampRow(db, 'users', id, meta);
  logChange(db, actor, 'users', id, snapshot(before), { ...snapshot(requireUser(db, id)), active: false, deleted: true }, meta, userSurau(db, id));
}

/** The body of `deleteUser` for a caller that owns the transaction. */
export function deleteUserIn(db: DatabaseSync, id: string, actor: string): void {
  const now = new Date().toISOString();
  const target = requireUser(db, id);
  guardSuperadmin(db, target, { roles: target.roles, active: false });
  deleteUserRows(db, id, actor, now);
  bumpFor(db, userSurau(db, id));
}

/**
 * Pulihkan: a deleted person comes back DEACTIVATED with no devices (Aktifkan semula and a new code bring them in).
 * `deactivated_at` is set to now, so the 365-day clean-up clock starts again and the hourly clean-up never deletes
 * them within the hour. 404 for a person who is not deleted. Caller checked tenant and `*`.
 */
export function restoreUser(db: DatabaseSync, id: string, actor: string, meta?: ChangeMeta): User {
  return tx(db, () => {
    // REST and CLI restore keep one person, one number; the replicated path (restoreUserRows) stays lenient and flags a duplicate
    const row = requireUser(db, id);
    if (row.deleted && row.phone !== null) refuseTakenPhone(db, row.surauId, row.phone, id);
    return restoreUserRows(db, id, actor, new Date().toISOString(), meta);
  });
}

/** The body of `restoreUser` for a caller that owns the transaction (a replicated restore). */
export function restoreUserRows(db: DatabaseSync, id: string, actor: string, now: string, meta?: ChangeMeta): User {
  const before = requireUser(db, id);
  if (!before.deleted) throw new AuthError(404, 'not_found', 'Tidak dijumpai');
  db.prepare('UPDATE users SET deleted_at = NULL, deleted_by = NULL, active = 0, deactivated_at = ? WHERE id = ?').run(now, id);
  stampRow(db, 'users', id, meta);
  const after = requireUser(db, id);
  const own = userSurau(db, id);
  logChange(db, actor, 'users', id, snapshot(before), { ...snapshot(after), deleted: false }, meta, own);
  bumpFor(db, own);
  return after;
}

/**
 * Buka kunci: clear the wrong-PIN count and the lock. The PIN and the sessions stay. Returns whether anything was
 * locked (a user who was not locked writes no log row). Caller checked tenant and `*`.
 */
export function unlockUserPin(db: DatabaseSync, id: string, actor: string): boolean {
  return tx(db, () => {
    const before = requireUser(db, id);
    const row = db.prepare('SELECT pin_fail_count, pin_locked_until, lock_round FROM users WHERE id = ?').get(id);
    const locked = row !== undefined && (Number(row.pin_fail_count) > 0 || row.pin_locked_until !== null || Number(row.lock_round) > 0);
    if (!locked) return false;
    db.prepare('UPDATE users SET pin_fail_count = 0, pin_locked_until = NULL, lock_round = 0 WHERE id = ?').run(id);
    logChange(db, actor, 'users', id, snapshot(before), { ...snapshot(before), pinUnlocked: true }, undefined, userSurau(db, id));
    return true;
  });
}

/**
 * Aktifkan semula: an inactive user becomes active again (`deactivated_at` cleared). Their old devices stay revoked;
 * they enrol again with a new code. An active user is a no-op. Caller checked tenant and `*`.
 */
export function activateUser(db: DatabaseSync, id: string, actor: string): User {
  return tx(db, () => {
    const before = requireUser(db, id);
    if (before.deleted) throw new AuthError(404, 'not_found', 'Tidak dijumpai');
    if (before.active) return before;
    if (before.phone !== null) refuseTakenPhone(db, before.surauId, before.phone, id);
    guardSuperadmin(db, before, { roles: before.roles, active: true });
    db.prepare('UPDATE users SET active = 1, deactivated_at = NULL WHERE id = ?').run(id);
    stampRow(db, 'users', id);
    const after = requireUser(db, id);
    const own = userSurau(db, id);
    logChange(db, actor, 'users', id, snapshot(before), snapshot(after), undefined, own);
    bumpFor(db, own);
    return after;
  });
}

/**
 * Create or update a user from a synced edit: name, roles and active only, never PIN fields.
 * Caller owns the tx. Going inactive revokes the user's devices as `deactivateUser` does.
 */
export function putUserSynced(
  db: DatabaseSync,
  id: string,
  input: { name: string; roles: Role[]; active: boolean; deleted?: boolean; phone?: string },
  actor: string,
  meta: ChangeMeta,
  surauId: string,
): void {
  const name = checkName(input.name);
  const roles = checkRoles(input.roles);
  const existing = getUserRow(db, id);
  // Same guard as the admin routes: the surau must never be left without an active admin.
  // A deleted person stays inactive whatever arrives; an absent `deleted` key never undeletes (an older peer's later edit).
  const wasDeleted = existing?.deleted === true;
  // A number that arrives by sync is kept when it normalises (a duplicate is kept and flagged, never refused); absent leaves the stored one.
  const syncedPhone = typeof input.phone === 'string' ? normalisePhone(input.phone) : null;
  const active = wasDeleted || input.deleted === true ? false : input.active;
  if (existing?.active && holdsAdmin(existing.roles) && (!active || !holdsAdmin(roles)) && activeAdminCountForSync(db, surauId) <= 1) {
    throw new AuthError(409, 'last_admin', 'Mesti ada sekurang-kurangnya seorang pentadbir aktif');
  }
  guardSuperadmin(db, existing, { roles, active }, meta);
  const now = new Date().toISOString();
  if (existing === undefined) {
    db.prepare(
      `INSERT INTO users (id, name, roles_json, active, created_at, created_by, surau_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, JSON.stringify(roles), active ? 1 : 0, meta.editedAt ?? now, actor, roles.some((r) => r === 'superadmin' || r === 'support') ? '*' : surauId);
    if (!active) db.prepare('UPDATE users SET deactivated_at = ? WHERE id = ?').run(now, id);
    if (syncedPhone !== null) db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(syncedPhone, id);
    stampRow(db, 'users', id, meta);
    logChange(db, actor, 'users', id, undefined, snapshot(requireUser(db, id)), meta, userSurau(db, id));
    if (input.deleted === true) deleteUserRows(db, id, actor, now, meta);
  } else {
    const before = existing;
    db.prepare('UPDATE users SET name = ?, roles_json = ? WHERE id = ?').run(name, JSON.stringify(roles), id);
    if (syncedPhone !== null && syncedPhone !== before.phone) db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(syncedPhone, id);
    endSessionsOnSuperadminGain(db, id, before.roles.includes('superadmin'), roles.includes('superadmin'));
    syncUserScope(db, id, before.roles.includes('superadmin'), roles.includes('superadmin'));
    if (input.deleted === true && !wasDeleted) {
      deleteUserRows(db, id, actor, now, meta);
    } else if (input.deleted === false && wasDeleted) {
      restoreUserRows(db, id, actor, now, meta);
    } else if (before.active && !active) {
      deactivateUserRows(db, id, actor, now, meta);
    } else {
      if (active && !before.active) db.prepare('UPDATE users SET active = 1, deactivated_at = NULL WHERE id = ?').run(id);
      stampRow(db, 'users', id, meta);
      logChange(db, actor, 'users', id, snapshot(before), snapshot(requireUser(db, id)), meta, userSurau(db, id));
    }
  }
  bumpFor(db, userSurau(db, id));
}

/** Every user row holding the superadmin role, active or not (a deactivated one still counts for "none exists yet"). */
export function superadminRowCount(db: DatabaseSync): number {
  return allUsers(db).filter((u) => u.roles.includes('superadmin')).length;
}

/**
 * Make an existing user a Pentadbir MAXCOM (keeps `admin`), optionally renaming them. The first one is made only
 * this way, by the operator on the CLOUD's database (the CLI), against a user row that already replicated there;
 * it does not go through the cloud-only rule. Refuses when any superadmin row exists, active or not.
 */
export function promoteSuperadmin(db: DatabaseSync, userId: string, actor: string, rename?: string): User {
  return tx(db, () => {
    if (superadminRowCount(db) > 0) throw new AuthError(409, 'superadmin_exists', 'Pentadbir MAXCOM sudah wujud');
    const before = requireUser(db, userId);
    if (!before.active) throw new AuthError(409, 'user_inactive', 'Pengguna tidak aktif');
    const name = rename === undefined ? before.name : checkName(rename);
    const roles = checkRoles([...before.roles, 'superadmin']);
    db.prepare('UPDATE users SET name = ?, roles_json = ? WHERE id = ?').run(name, JSON.stringify(roles), userId);
    endSessionsOnSuperadminGain(db, userId, before.roles.includes('superadmin'), roles.includes('superadmin'));
    syncUserScope(db, userId, before.roles.includes('superadmin'), roles.includes('superadmin'));
    stampRow(db, 'users', userId);
    const after = requireUser(db, userId);
    logChange(db, actor, 'users', userId, snapshot(before), snapshot(after), undefined, userSurau(db, userId));
    bumpFor(db, userSurau(db, userId));
    return after;
  });
}
