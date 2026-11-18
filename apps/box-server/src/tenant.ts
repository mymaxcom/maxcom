import type { DatabaseSync } from 'node:sqlite';
import { OPS_ROLES, SURAU_ID_RE } from '@surau/core';
import type { Role } from '@surau/core';
import type { AuthIdentity } from './auth/authz.ts';
import { authLog } from './auth/sessions.ts';
import { DEFAULT_SURAU_ID } from './sync/verify.ts';

/**
 * Tenant resolution (Plan 14 section 3.1). Every tenant route on the cloud acts for exactly one surau, told by
 * the server from the identity, never from a body:
 *  - a site: its `sites.surau_id`;
 *  - a device session: the device's `devices.surau_id` (the surau it enrolled in), whatever the user row says;
 *  - a Pentadbir MAXCOM (`users.surau_id = '*'`, holding `superadmin`) on an OPS device: the surau named by the
 *    header `X-Maxcom-Surau`, which must be well formed and exist in `suraus`.
 * On a box the tenant is always the local constant and the header is ignored. `'*'` is never a tenant.
 */

export interface Tenant {
  surauId: string;
}

export type TenantRefusalCode =
  | 'surau_required'
  | 'surau_malformed'
  | 'surau_not_found'
  | 'cross_surau_refused'
  | 'ops_device_required'
  | 'no_tenant';

export interface TenantRefusal {
  status: 400 | 403 | 404;
  code: TenantRefusalCode;
  message: string;
}

/** The box's own surau: a local constant (today's `DEFAULT_SURAU_ID`). */
export const LOCAL_SURAU_ID = DEFAULT_SURAU_ID;

/** The acting-surau header, as Node delivers it (lower case). */
export const SURAU_HEADER = 'x-maxcom-surau';

const MESSAGES: Record<TenantRefusalCode, string> = {
  surau_required: 'Pilih surau dahulu',
  surau_malformed: 'Surau tidak sah',
  surau_not_found: 'Surau tidak dijumpai',
  cross_surau_refused: 'Tiada kebenaran untuk tindakan ini',
  ops_device_required: 'Tiada kebenaran untuk tindakan ini',
  no_tenant: 'Tiada kebenaran untuk tindakan ini',
};

export const isTenantRefusal = (r: Tenant | TenantRefusal): r is TenantRefusal => 'status' in r;

const validSurauId = (v: unknown): v is string => typeof v === 'string' && SURAU_ID_RE.test(v);

function userHoldsOpsRole(rolesJson: string): boolean {
  try {
    const roles = JSON.parse(rolesJson) as unknown;
    return Array.isArray(roles) && roles.some((r) => OPS_ROLES.includes(r as Role));
  } catch {
    return false;
  }
}

type HeaderBag = Record<string, string | string[] | undefined>;

/**
 * The header as given: `absent`, `many` (given more than once, or an array), or the single string value. The
 * name is matched case-insensitively so a hand-built header object cannot hide a second copy under other case.
 */
function readHeader(headers: HeaderBag): { kind: 'absent' } | { kind: 'many' } | { kind: 'one'; value: string } {
  const found: Array<string | string[]> = [];
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === SURAU_HEADER && v !== undefined) found.push(v);
  }
  if (found.length === 0) return { kind: 'absent' };
  if (found.length > 1) return { kind: 'many' };
  const v = found[0]!;
  if (Array.isArray(v)) return v.length === 1 && typeof v[0] === 'string' ? { kind: 'one', value: v[0] } : { kind: 'many' };
  return { kind: 'one', value: v };
}

export interface TenantLogCtx {
  now?: Date;
  ip?: string | null;
}

/** One refusal row per (who, code) per this long; the repeats inside it are only counted. */
export const REFUSAL_LOG_WINDOW_MS = 60_000;
const REFUSAL_LOG_MAX_KEYS = 10_000;
/** Per database (a test, or a process, may open more than one): who+code -> window start and the repeats in it. */
const refusalLogged = new WeakMap<DatabaseSync, Map<string, { at: number; repeats: number }>>();

/** Forget the throttle of one database: the next refusal of each kind gets its row (tests that count rows per call). */
export function resetRefusalLogThrottle(db: DatabaseSync): void {
  refusalLogged.delete(db);
}

/**
 * True when this refusal gets its `auth_log` row: the first for its (user and device, or address when there is no
 * identity; code) in a minute. The rest are counted in memory only, so a client cannot flood the log.
 */
function refusalRowDue(db: DatabaseSync, key: string, nowMs: number): boolean {
  let seen = refusalLogged.get(db);
  if (seen === undefined) {
    seen = new Map();
    refusalLogged.set(db, seen);
  }
  const last = seen.get(key);
  if (last !== undefined && nowMs >= last.at && nowMs - last.at < REFUSAL_LOG_WINDOW_MS) {
    last.repeats += 1;
    return false;
  }
  if (seen.size >= REFUSAL_LOG_MAX_KEYS) {
    for (const [k, v] of seen) if (!(nowMs >= v.at && nowMs - v.at < REFUSAL_LOG_WINDOW_MS)) seen.delete(k);
    // still full of live keys: start over rather than grow without bound (at worst a few extra rows)
    if (seen.size >= REFUSAL_LOG_MAX_KEYS) seen.clear();
  }
  seen.set(key, { at: nowMs, repeats: 0 });
  return true;
}

/**
 * The tenant of one request, or the refusal to send. A refusal on the cloud writes one `auth_log` row (event and
 * detail are the refusal code, a fixed string; the header value is never logged), at most one per (user and device,
 * code) a minute; a tenant writes none.
 */
export function tenantOf(
  identity: AuthIdentity | null,
  headers: HeaderBag,
  db: DatabaseSync,
  role: 'box' | 'cloud',
  log: TenantLogCtx = {},
): Tenant | TenantRefusal {
  if (role !== 'cloud') return { surauId: LOCAL_SURAU_ID };

  const refuse = (
    status: TenantRefusal['status'],
    code: TenantRefusalCode,
    who: { userId?: string | null; deviceId?: string | null } = {},
  ): TenantRefusal => {
    const at = log.now ?? new Date();
    const key = who.userId != null || who.deviceId != null ? `u:${who.userId ?? ''}|d:${who.deviceId ?? ''}|${code}` : `ip:${log.ip ?? ''}|${code}`;
    if (refusalRowDue(db, key, at.getTime())) authLog(db, at, code, false, { ...who, ip: log.ip ?? null, detail: code });
    return { status, code, message: MESSAGES[code] };
  };

  // Kiosk and loopback are not on the cloud; no identity has no tenant.
  if (identity === null || identity.kind === 'kiosk') return refuse(403, 'no_tenant');

  if (identity.kind === 'site') {
    // The site key's surau, from the database; the header is ignored for a site.
    return validSurauId(identity.surauId) ? { surauId: identity.surauId } : refuse(403, 'no_tenant');
  }

  const who = { userId: identity.userId, deviceId: identity.deviceId };
  const user = db.prepare('SELECT surau_id, roles_json FROM users WHERE id = ?').get(identity.userId) as
    | { surau_id: string; roles_json: string }
    | undefined;
  const device = db.prepare('SELECT surau_id, ops, user_id FROM devices WHERE id = ?').get(identity.deviceId) as
    | { surau_id: string; ops: number; user_id: string }
    | undefined;
  if (user === undefined || device === undefined || device.user_id !== identity.userId) return refuse(403, 'no_tenant', who);

  // A Pentadbir MAXCOM: the user row is `*` (migration 019, and every CLI grant files the account there), or, as a
  // second guard should a row ever disagree, the account holds an ops role.
  const starUser = user.surau_id === '*' || userHoldsOpsRole(user.roles_json);
  const header = readHeader(headers);

  // Acting as `*`: only a `*` user, on a device that is an ops device both in the session and in the row, and
  // acting with `superadmin` (a `support` user has no surau data to act on).
  const opsDevice = identity.ops === true && Number(device.ops) === 1;
  if (starUser && opsDevice) {
    if (!identity.roles.includes('superadmin')) return refuse(403, 'no_tenant', who);
    if (header.kind === 'absent') return refuse(400, 'surau_required', who);
    if (header.kind === 'many' || !validSurauId(header.value)) return refuse(400, 'surau_malformed', who);
    const exists = db.prepare('SELECT 1 AS one FROM suraus WHERE id = ?').get(header.value) !== undefined;
    return exists ? { surauId: header.value } : refuse(404, 'surau_not_found', who);
  }

  // Everyone else is a user of the device's own surau. A device left at `'*'` without the ops flag (an unmarked
  // ops device) has no surau at all: it never acts as `*` and reaches no tenant route.
  if (!validSurauId(device.surau_id)) return refuse(403, 'ops_device_required', who);
  const own = device.surau_id;
  if (header.kind === 'absent') return { surauId: own };
  // A `*` user on a public device may not use the header at all, whatever surau it names.
  if (starUser) return refuse(403, 'ops_device_required', who);
  if (header.kind === 'many' || !validSurauId(header.value)) return refuse(400, 'surau_malformed', who);
  // Unknown or foreign: the same 403, so a surau user cannot probe which ids exist.
  return header.value === own ? { surauId: own } : refuse(403, 'cross_surau_refused', who);
}
