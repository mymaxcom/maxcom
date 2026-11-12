import type { DatabaseSync } from 'node:sqlite';
import { can, isFeatureKey, isoInstantMs, opMessage, patchNeedsSystemWrite } from '@surau/core';
import type { FeedEntry, OpKind, OpRefusal, Permission, SyncOp } from '@surau/core';
import { verifyP256 } from '../auth/crypto.ts';
import { getDeviceWithKey } from '../auth/devices.ts';
import { authLog } from '../auth/sessions.ts';
import { getAuthUser } from '../auth/users.ts';
import { sanitizeStamps } from '../settingsStore.ts';
import { cleanPublicJwk } from './sites.ts';
import type { VerifiedOp } from './apply.ts';

/** The surau this server holds today (spec 7.2: a second surau later is a second value, not a schema change). */
export const DEFAULT_SURAU_ID = 'sdm';

/** Same encoding `unlock` accepts: base64url of the 64-byte IEEE P1363 r||s. */
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const OP_KINDS: readonly OpKind[] = ['content.put', 'content.delete', 'settings.put', 'asset.put', 'user.put', 'device.revoke', 'audit.put',
  'finance.append', 'finance.lookup.put', 'finance.month.put', 'finance.photo.put',
];
const OP_KEYS = new Set([
  'v', 'opId', 'surauId', 'boxId', 'deviceId', 'userId', 'kind', 'entity', 'entityId', 'baseRev', 'editedAt', 'payload', 'sig',
]);

/** Every permission the user must hold, NOW, for each kind of op. */
export const OP_PERMISSIONS: Record<OpKind, readonly Permission[]> = {
  'content.put': ['content:write', 'assets:write'],
  'content.delete': ['content:write', 'assets:write'],
  'asset.put': ['content:write', 'assets:write'],
  'settings.put': ['settings:write'],
  'user.put': ['users:manage'],
  'device.revoke': ['devices:manage'],
  // a device records that it deleted its own recording after YouTube verified it (Plan 6 Task 13)
  'audit.put': ['live:control'],
  // Plan 7: money. An entry, a photo, a lookup and a month state are the Bendahari's or the Pentadbir's; lookups and
  // month states also need settings:write, so a Bendahari (who cannot change settings) is refused those.
  'finance.append': ['finance:write'],
  'finance.lookup.put': ['finance:write', 'settings:write'],
  'finance.month.put': ['finance:write', 'settings:write'],
  'finance.photo.put': ['finance:write'],
};

export type VerifyResult =
  | { ok: true; op: VerifiedOp; permission: Permission; permissions: readonly Permission[] }
  | { ok: false; reason: OpRefusal; detail: string };

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Fixed-shape check of a decoded op. Returns a detail code, or null when the shape is fine. */
function shapeProblem(op: unknown): string | null {
  if (!isPlain(op)) return 'bad_shape';
  for (const k of Object.keys(op)) if (!OP_KEYS.has(k)) return 'bad_shape';
  if (op.v !== 1) return 'bad_shape';
  if (typeof op.opId !== 'string' || !ULID_RE.test(op.opId)) return 'bad_shape';
  if (!str(op.surauId, 100) || !str(op.boxId, 100) || !str(op.deviceId, 100) || !str(op.userId, 100)) return 'bad_shape';
  if (typeof op.kind !== 'string' || !(OP_KINDS as readonly string[]).includes(op.kind)) return 'bad_shape';
  if (!str(op.entity, 64) || !str(op.entityId, 200)) return 'bad_shape';
  if (op.baseRev !== null && !str(op.baseRev, 200)) return 'bad_shape';
  if (!str(op.editedAt, 40)) return 'bad_shape';
  if (typeof op.sig !== 'string') return 'bad_shape';
  return null;
}

/** A value that is safe to write to the log as an id: a short token, else null (never free text). */
export function logId(v: unknown): string | null {
  return typeof v === 'string' && ID_RE.test(v) ? v : null;
}

/** One `auth_log` row for a refusal. `detail` is always a fixed code; ids are shape-checked, never free text. */
export function logSyncRefusal(
  db: DatabaseSync,
  now: Date,
  f: { userId?: unknown; deviceId?: unknown; ip?: string | null },
  detail: string,
): void {
  authLog(db, now, 'sync_refused', false, {
    userId: logId(f.userId),
    deviceId: logId(f.deviceId),
    ip: f.ip ?? null,
    detail,
  });
}

/**
 * Verify one device op at arrival, against the database as it is NOW. Nothing in the op is trusted:
 * the shape is checked, the box and surau must be this server's, the device must exist and be unrevoked,
 * belong to `op.userId`, the user must be active, the signature must verify against the device's stored
 * public key (over `opMessage(op)`, IEEE P1363, like `unlock`), and the user must hold every permission
 * the op's kind needs now (read from the role tables, never from the op). Each refusal writes one
 * `auth_log` row (event `sync_refused`, detail a fixed code) and changes no data.
 */
export function verifyDeviceOp(
  db: DatabaseSync,
  op: unknown,
  now: Date,
  server: { boxId: string; surauId?: string },
  ip: string | null = null,
): VerifyResult {
  const refuse = (reason: OpRefusal, detail: string): VerifyResult => {
    const o = isPlain(op) ? op : {};
    logSyncRefusal(db, now, { userId: o.userId, deviceId: o.deviceId, ip }, detail);
    return { ok: false, reason, detail };
  };

  const problem = shapeProblem(op);
  if (problem !== null) return refuse('invalid', problem);
  const o = op as SyncOp;
  if (o.boxId !== server.boxId) return refuse('invalid', 'box_mismatch');
  if (o.surauId !== (server.surauId ?? DEFAULT_SURAU_ID)) return refuse('invalid', 'surau_mismatch');

  const device = getDeviceWithKey(db, o.deviceId);
  if (device === undefined || device.publicJwk === null) return refuse('device_unknown', 'device_unknown');
  if (device.revokedAt !== null) return refuse('device_revoked', 'device_revoked');
  if (device.userId !== o.userId) return refuse('device_unknown', 'user_mismatch');
  const user = getAuthUser(db, o.userId);
  if (user === undefined || !user.active) return refuse('user_inactive', 'user_inactive');

  let message: Buffer;
  try {
    message = Buffer.from(opMessage(o));
  } catch {
    return refuse('invalid', 'bad_shape');
  }
  if (!SIG_RE.test(o.sig) || !verifyP256(device.publicJwk, message, Buffer.from(o.sig, 'base64url'))) {
    return refuse('bad_signature', 'bad_signature');
  }

  const needs = OP_PERMISSIONS[o.kind];
  for (const p of needs) if (!can(user.roles, p)) return refuse('forbidden', 'forbidden');

  // Finer rights inside two kinds. MAXCOM system values are for the Pentadbir MAXCOM only (system:write), and
  // adding or removing the Pentadbir MAXCOM role needs superadmin:manage; the permission above is not enough.
  if (o.kind === 'settings.put' && isFeatureKey(o.entityId) && patchNeedsSystemWrite(o.entityId, o.payload) && !can(user.roles, 'system:write')) {
    return refuse('forbidden', 'system_write');
  }
  if (o.kind === 'user.put' && (changesSuperadmin(db, o) || holdsSuperadmin(db, o.entityId)) && !can(user.roles, 'superadmin:manage')) {
    return refuse('forbidden', 'superadmin_manage');
  }
  // Any edit to a Pentadbir MAXCOM, or the revocation of one's device, is superadmin:manage too (not only the role bit).
  if (o.kind === 'device.revoke') {
    const owner = getDeviceWithKey(db, o.entityId)?.userId;
    if (owner !== undefined && holdsSuperadmin(db, owner) && !can(user.roles, 'superadmin:manage')) {
      return refuse('forbidden', 'superadmin_manage');
    }
  }

  return { ok: true, op: { ...o, userName: user.name }, permission: needs[0]!, permissions: needs };
}

const holdsSuperadmin = (db: DatabaseSync, userId: string): boolean => getAuthUser(db, userId)?.roles.includes('superadmin') === true;

/** Does a `user.put` add or remove the superadmin role on its target? (A payload without roles changes none.) */
function changesSuperadmin(db: DatabaseSync, o: SyncOp): boolean {
  if (!isPlain(o.payload) || o.payload.roles === undefined) return false;
  const after = Array.isArray(o.payload.roles) && o.payload.roles.includes('superadmin');
  const before = getAuthUser(db, o.entityId)?.roles.includes('superadmin') === true;
  return after !== before;
}

const ACTOR_RE = /^[A-Za-z0-9:_@.|-]{1,120}$/;
const ORIGIN_RE = /^[A-Za-z0-9:_.-]{1,120}$/;
const ENTRY_ENTITY_RE = /^(content:[A-Za-z0-9_-]{1,40}|settings|user|device|prayer:(?:official|import|correction)|finance:(?:entry|fund|perihal|month|photo))$/;

/** The id of a prayer entity must look like its kind, and its payload must be an object (a correction may be null = removed). */
const PRAYER_ID: Record<string, RegExp> = {
  'prayer:official': /^[A-Z]{3}\d{2}:\d{4}$/,
  'prayer:import': /^[0-9A-HJKMNP-TV-Z]{26}$/,
  'prayer:correction': /^\d{4}-\d{2}-\d{2}\|[a-z]{4,8}$/,
};
function prayerEntryOk(entity: string, entityId: unknown, after: unknown): boolean {
  const re = PRAYER_ID[entity];
  if (re === undefined) return true;
  if (typeof entityId !== 'string' || !re.test(entityId)) return false;
  if (entity === 'prayer:correction' && after === null) return true;
  return isPlain(after);
}

const DEVICE_AFTER_KEYS = new Set(['id', 'userId', 'name', 'platform', 'revoked', 'publicJwk', 'enrolledAt']);
const DEVICE_PLATFORMS: readonly string[] = ['android', 'ios-web', 'web', 'kiosk'];

/**
 * A device `after` may carry only the expected fields, each of the right kind; the key (public only) must be a
 * clean P-256 JWK (`cleanPublicJwk`: kty, crv, x, y and nothing else). Anything else is refused.
 */
function deviceAfterOk(entityId: string, after: unknown): boolean {
  if (!isPlain(after)) return false;
  for (const k of Object.keys(after)) if (!DEVICE_AFTER_KEYS.has(k)) return false;
  if (after.id !== undefined && after.id !== entityId) return false;
  if (after.userId !== undefined && !(typeof after.userId === 'string' && ID_RE.test(after.userId))) return false;
  if (after.name !== undefined && !str(after.name, 200)) return false;
  if (after.platform !== undefined && !(typeof after.platform === 'string' && DEVICE_PLATFORMS.includes(after.platform))) return false;
  if (after.revoked !== undefined && typeof after.revoked !== 'boolean') return false;
  if (after.enrolledAt !== undefined && !(typeof after.enrolledAt === 'string' && isoInstantMs(after.enrolledAt) !== null)) return false;
  if (after.publicJwk !== undefined) {
    if (cleanPublicJwk(after.publicJwk) === null) return false;
    // an enrolment names its user and its time
    if (typeof after.userId !== 'string' || typeof after.enrolledAt !== 'string') return false;
  }
  return true;
}

/** A finance entity's id must look like its kind and its payload must be an object whose own id (when it has one) matches. */
const FINANCE_ID: Record<string, RegExp> = {
  'finance:entry': ID_RE,
  'finance:fund': ID_RE,
  'finance:perihal': ID_RE,
  'finance:month': /^\d{4}-(0[1-9]|1[0-2])$/,
  'finance:photo': /^[0-9a-f]{64}$/,
};
function financeEntryOk(entity: string, entityId: unknown, after: unknown): boolean {
  const re = FINANCE_ID[entity];
  if (re === undefined) return true;
  if (typeof entityId !== 'string' || !re.test(entityId)) return false;
  if (!isPlain(after)) return false;
  if (entity === 'finance:entry' && after.id !== entityId) return false;
  return true;
}

export type EntryVerdict = { ok: true; entry: FeedEntry } | { ok: false; detail: string };

/**
 * Check one feed entry sent by a linked site: a site replicates for its OWN surau only. The shape is
 * fixed, the entity is one that may travel, the origin must be the site's own box (or a local/app
 * write on it) and never `cloud` (that would be an echo of this server's own change), and the actor
 * and ids are plain tokens. The data inside `after` is checked by the stores that write it.
 */
export function verifySiteEntry(site: { boxId: string; surauId: string }, server: { surauId?: string }, e: unknown): EntryVerdict {
  if (site.surauId !== (server.surauId ?? DEFAULT_SURAU_ID)) return { ok: false, detail: 'surau_mismatch' };
  if (!isPlain(e)) return { ok: false, detail: 'bad_shape' };
  const allowed = new Set(['seq', 'entity', 'entityId', 'rev', 'editedAt', 'syncedAt', 'actor', 'deviceId', 'origin', 'opId', 'after', 'stamps']);
  for (const k of Object.keys(e)) if (!allowed.has(k)) return { ok: false, detail: 'bad_shape' };
  if (typeof e.entity !== 'string' || !ENTRY_ENTITY_RE.test(e.entity)) return { ok: false, detail: 'bad_entity' };
  if (!str(e.entityId, 200) || !str(e.rev, 200) || !str(e.editedAt, 40)) return { ok: false, detail: 'bad_shape' };
  // An edit time that is not an ISO instant would be compared as text and could win every merge.
  if (isoInstantMs(e.editedAt) === null) return { ok: false, detail: 'bad_time' };
  if (typeof e.syncedAt !== 'string' || e.syncedAt.length > 40) return { ok: false, detail: 'bad_shape' };
  if (e.entity === 'device' && !deviceAfterOk(e.entityId as string, e.after)) return { ok: false, detail: 'bad_device' };
  if (e.entity.startsWith('prayer:') && !prayerEntryOk(e.entity, e.entityId, e.after)) return { ok: false, detail: 'bad_prayer' };
  if (e.entity.startsWith('finance:') && !financeEntryOk(e.entity, e.entityId, e.after)) return { ok: false, detail: 'bad_finance' };
  if (e.stamps !== undefined && (e.entity !== 'settings' || sanitizeStamps(e.stamps, (t) => t) === null)) return { ok: false, detail: 'bad_stamps' };
  if (typeof e.actor !== 'string' || !ACTOR_RE.test(e.actor)) return { ok: false, detail: 'bad_shape' };
  if (e.deviceId !== null && !(typeof e.deviceId === 'string' && ID_RE.test(e.deviceId))) return { ok: false, detail: 'bad_shape' };
  if (e.opId !== null && !(typeof e.opId === 'string' && ULID_RE.test(e.opId))) return { ok: false, detail: 'bad_shape' };
  if (typeof e.seq !== 'number' || !Number.isFinite(e.seq)) return { ok: false, detail: 'bad_shape' };
  if (typeof e.origin !== 'string' || !ORIGIN_RE.test(e.origin)) return { ok: false, detail: 'bad_shape' };
  if (e.origin === 'cloud') return { ok: false, detail: 'echo' };
  if (e.origin.startsWith('box:') && e.origin !== `box:${site.boxId}`) return { ok: false, detail: 'foreign_origin' };
  return { ok: true, entry: e as unknown as FeedEntry };
}
