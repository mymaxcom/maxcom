import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ROLES, isRole } from '@surau/core';
import type { Role } from '@surau/core';
import { hashPin, isValidPin, pinPepperOf } from './crypto.ts';
import { bumpVersion } from '../settingsStore.ts';
import { revOf } from '../sync/meta.ts';
import type { ChangeMeta } from '../sync/meta.ts';

export type { ChangeMeta } from '../sync/meta.ts';

export type AuthStatus = 400 | 401 | 403 | 404 | 409 | 423 | 429;

export class AuthError extends Error {
  readonly status: AuthStatus;
  readonly code: string;
  /** Seconds until a retry may succeed (sent as `Retry-After` on lockouts). */
  readonly retryAfterSec: number | undefined;

  constructor(status: AuthStatus, code: string, message: string, retryAfterSec?: number) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
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

export interface User {
  id: string;
  name: string;
  roles: Role[];
  active: boolean;
  pinRequired: boolean;
  pinLockedUntil: string | null;
  createdAt: string;
  createdBy: string;
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

/** Append a change_log row (secrets must already be stripped from before/after). Caller owns the tx. */
export function logChange(
  db: DatabaseSync,
  actor: string,
  entity: string,
  entityId: string,
  before: unknown,
  after: unknown,
  meta?: ChangeMeta,
): void {
  const at = new Date().toISOString();
  const editedAt = meta?.editedAt ?? at;
  db.prepare(
    `INSERT INTO change_log (at, actor, entity, entity_id, before_json, after_json, device_id, origin, op_id, edited_at, synced_at, rev)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
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

function parseRoles(json: unknown): Role[] {
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
  };
}

/** Secret-free snapshot for change_log. */
function snapshot(u: User): Record<string, unknown> {
  return { id: u.id, name: u.name, roles: u.roles, active: u.active, hasPin: !u.pinRequired };
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

export function checkName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 80) {
    throw new AuthError(400, 'bad_name', 'Nama tidak sah');
  }
  return name.trim();
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

export function createUser(db: DatabaseSync, input: { name: string; roles: Role[] }, actor: string): User {
  return tx(db, () => createUserIn(db, input, actor));
}

/** `createUser` for a caller that already owns the transaction (setup and recovery create the user and its device together). */
export function createUserIn(db: DatabaseSync, input: { name: string; roles: Role[] }, actor: string): User {
  const name = checkName(input.name);
  const roles = checkRoles(input.roles);
  guardSuperadmin(db, undefined, { roles, active: true });
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, name, roles_json, active, created_at, created_by) VALUES (?, ?, ?, 1, ?, ?)`,
  ).run(id, name, JSON.stringify(roles), now, actor);
  stampRow(db, 'users', id);
  const user = requireUser(db, id);
  logChange(db, actor, 'users', id, undefined, snapshot(user));
  bumpVersion(db);
  return user;
}

/** Active users who can administer the surau: the Pentadbir Surau or the Pentadbir MAXCOM. */
export function activeAdminCount(db: DatabaseSync): number {
  return listUsers(db).filter((u) => u.active && holdsAdmin(u.roles)).length;
}

/** Active users holding the superadmin role. */
export function activeSuperadminCount(db: DatabaseSync): number {
  return listUsers(db).filter((u) => u.active && u.roles.includes('superadmin')).length;
}

/** Never includes the PIN hash. */
export function listUsers(db: DatabaseSync): User[] {
  return db.prepare('SELECT * FROM users ORDER BY created_at, id').all().map(toUser);
}

export function setRoles(db: DatabaseSync, id: string, roles: Role[], actor: string): User {
  const checked = checkRoles(roles);
  return tx(db, () => {
    const before = requireUser(db, id);
    guardSuperadmin(db, before, { roles: checked, active: before.active });
    db.prepare('UPDATE users SET roles_json = ? WHERE id = ?').run(JSON.stringify(checked), id);
    endSessionsOnSuperadminGain(db, id, before.roles.includes('superadmin'), checked.includes('superadmin'));
    stampRow(db, 'users', id);
    const after = requireUser(db, id);
    logChange(db, actor, 'users', id, snapshot(before), snapshot(after));
    bumpVersion(db);
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
    logChange(db, actor, 'users', id, snapshot(before), { ...snapshot(after), pinChanged: true });
    bumpVersion(db);
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
    .prepare('SELECT id, user_id, name, platform, revoked_at FROM devices WHERE id = ?')
    .get(deviceId);
  if (dev === undefined) return false;
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(now, deviceId);
  if (dev.revoked_at !== null) return false;
  db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(now, deviceId);
  stampRow(db, 'devices', deviceId, meta);
  const base = { id: dev.id, userId: dev.user_id, name: dev.name, platform: dev.platform };
  logChange(db, actor, 'devices', deviceId, { ...base, revoked: false }, { ...base, revoked: true }, meta);
  return true;
}

/** Deactivate a user body (revoke every device and session). Caller owns the tx. */
export function deactivateUserRows(db: DatabaseSync, id: string, actor: string, now: string, meta?: ChangeMeta): void {
  const before = requireUser(db, id);
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id);
  stampRow(db, 'users', id, meta);
  // Kiosk displays belong to the box, not to the admin who happened to approve the pairing.
  for (const d of db.prepare("SELECT id FROM devices WHERE user_id = ? AND platform <> 'kiosk'").all(id)) {
    // Side effects of the op: logged without the op id (that belongs to the user row's entry, once).
    revokeDeviceRow(db, String(d.id), actor, now, meta === undefined ? undefined : { ...meta, opId: undefined });
  }
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, id);
  db.prepare('UPDATE enrolments SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(now, id);
  logChange(db, actor, 'users', id, snapshot(before), { ...snapshot(before), active: false }, meta);
}

/** Deactivate a user: revoke every device and session in the same transaction. */
export function deactivateUser(db: DatabaseSync, id: string, actor: string): void {
  const now = new Date().toISOString();
  tx(db, () => {
    const target = requireUser(db, id);
    guardSuperadmin(db, target, { roles: target.roles, active: false });
    deactivateUserRows(db, id, actor, now);
    bumpVersion(db);
  });
}

/**
 * Create or update a user from a synced edit: name, roles and active only, never PIN fields.
 * Caller owns the tx. Going inactive revokes the user's devices as `deactivateUser` does.
 */
export function putUserSynced(
  db: DatabaseSync,
  id: string,
  input: { name: string; roles: Role[]; active: boolean },
  actor: string,
  meta: ChangeMeta,
): void {
  const name = checkName(input.name);
  const roles = checkRoles(input.roles);
  const existing = getUserRow(db, id);
  // Same guard as the admin routes: the surau must never be left without an active admin.
  if (existing?.active && holdsAdmin(existing.roles) && (!input.active || !holdsAdmin(roles)) && activeAdminCount(db) <= 1) {
    throw new AuthError(409, 'last_admin', 'Mesti ada sekurang-kurangnya seorang pentadbir aktif');
  }
  guardSuperadmin(db, existing, { roles, active: input.active }, meta);
  const now = new Date().toISOString();
  if (existing === undefined) {
    db.prepare(
      `INSERT INTO users (id, name, roles_json, active, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, name, JSON.stringify(roles), input.active ? 1 : 0, meta.editedAt ?? now, actor);
    stampRow(db, 'users', id, meta);
    logChange(db, actor, 'users', id, undefined, snapshot(requireUser(db, id)), meta);
  } else {
    const before = existing;
    db.prepare('UPDATE users SET name = ?, roles_json = ? WHERE id = ?').run(name, JSON.stringify(roles), id);
    endSessionsOnSuperadminGain(db, id, before.roles.includes('superadmin'), roles.includes('superadmin'));
    if (before.active && !input.active) {
      deactivateUserRows(db, id, actor, now, meta);
    } else {
      if (input.active && !before.active) db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(id);
      stampRow(db, 'users', id, meta);
      logChange(db, actor, 'users', id, snapshot(before), snapshot(requireUser(db, id)), meta);
    }
  }
  bumpVersion(db);
}

/** Every user row holding the superadmin role, active or not (a deactivated one still counts for "none exists yet"). */
export function superadminRowCount(db: DatabaseSync): number {
  return listUsers(db).filter((u) => u.roles.includes('superadmin')).length;
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
    stampRow(db, 'users', userId);
    const after = requireUser(db, userId);
    logChange(db, actor, 'users', userId, snapshot(before), snapshot(after));
    bumpVersion(db);
    return after;
  });
}
