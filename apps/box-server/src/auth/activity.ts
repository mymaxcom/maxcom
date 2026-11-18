import type { DatabaseSync } from 'node:sqlite';
import { AuthError, actorNameOf, activeAdminCount, bumpFor, deleteUserRows, parseRoles, tx, userSurau } from './users.ts';
import { activeAdminDeviceCount, revokeDeviceGuarded } from './devices.ts';
import { globalRefOfRow, refOfRow } from './ids.ts';
import { authLog } from './sessions.ts';

/**
 * The only place the clean-up day counts live. The flags the app shows ("Tidak aktif", "Perlu tindakan") are
 * computed here from the server's clock, never by the phone.
 */
export const DEVICE_IDLE_DAYS = 60;
export const TV_IDLE_DAYS = 30;
export const NO_DEVICE_DAYS = 3;
export const USER_IDLE_DAYS = 90;
/** Phones, tablets, computers and TV screens unused this long are removed by the hourly clean-up (box only). */
export const AUTO_DELETE_DEVICE_DAYS = 180;
/** A person deactivated this long is soft-deleted by the hourly clean-up (box only). */
export const AUTO_DELETE_DEACTIVATED_DAYS = 365;

const DAY_MS = 86_400_000;

export interface DeviceActivity {
  id: string;
  /** The device's ID (`D-0001`), null while it has none; `globalRef` only for an ops view. */
  ref: string | null;
  globalRef?: string | null;
  userId: string;
  kind: 'device' | 'tv';
  enrolledAt: string;
  lastSeenAt: string | null;
  idleDays: number;
  inactive: boolean;
}

export type UserNeed = 'locked' | 'no_device' | 'phone' | 'phone_duplicate';

export interface UserActivity {
  id: string;
  ref: string | null;
  globalRef?: string | null;
  createdAt: string;
  createdByName: string | null;
  /** The adder's ID (`U-0001`), null for the system or an unknown or unnumbered adder. */
  createdByRef: string | null;
  deviceCount: number;
  lastActiveAt: string | null;
  locked: boolean;
  pinLockedUntil: string | null;
  needs: UserNeed[];
  suggestDeactivate: boolean;
}

export interface PeopleActivity {
  now: string;
  authority: 'box' | 'cloud';
  limits: { deviceDays: 60; tvDays: 30; noDeviceDays: 3; userDays: 90; deactivatedDays: 365 };
  devices: DeviceActivity[];
  users: UserActivity[];
  /** True when no active Pentadbir of the surau has an unrevoked phone, tablet or computer (a TV screen does not count). */
  noAdminPhone: boolean;
}

/** The ID of the person behind a `user:<id>` actor, or null (`system`, a device, an unknown or unnumbered row). */
function actorRefOf(db: DatabaseSync, actor: string, hideStar: boolean): string | null {
  if (!actor.startsWith('user:')) return null;
  const r = db.prepare('SELECT * FROM users WHERE id = ?').get(actor.slice(5));
  if (r !== undefined && hideStar && r.surau_id === '*') return null;
  return r === undefined ? null : refOfRow(r, 'user');
}

/** Whole days between an ISO instant and `now` (never negative; an unreadable instant counts as today). */
function daysSince(iso: string, now: Date): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

/** Whole days a device has gone unused: since `last_seen_at`, or since it was enrolled when never seen. */
export function idleDaysOf(d: { enrolledAt: string; lastSeenAt: string | null }, now: Date): number {
  return daysSince(d.lastSeenAt ?? d.enrolledAt, now);
}

/** A phone, tablet or computer idle 60 days, or a TV screen idle 30 days. */
export function isIdleDevice(d: { platform: string; enrolledAt: string; lastSeenAt: string | null }, now: Date): boolean {
  return idleDaysOf(d, now) >= (d.platform === 'kiosk' ? TV_IDLE_DAYS : DEVICE_IDLE_DAYS);
}

/**
 * Every clean-up flag for one surau, from the server's clock. The cloud cannot see unlocks made on the surau
 * Wi-Fi, so on the cloud no device is "inactive", no suggestion is made and `lastSeenAt` stays null.
 * Revoked devices, inactive and deleted users are left out; a `*` user and their devices only with `includeStar`.
 */
export function peopleActivity(db: DatabaseSync, surauId: string, now: Date, role: 'box' | 'cloud', includeStar: boolean): PeopleActivity {
  const cloud = role === 'cloud';
  const scope = includeStar ? [surauId, '*'] : [surauId, surauId];
  const userRows = db
    .prepare(`SELECT * FROM users WHERE active = 1 AND deleted_at IS NULL AND surau_id IN (?, ?) ORDER BY created_at, id`)
    .all(...scope);
  const userIds = new Set(userRows.map((u) => String(u.id)));
  // how many live people of a surau hold each number (a duplicate that arrived by sync is flagged, never refused); no number leaves this function
  const phoneCount = new Map<string, number>();
  for (const p of db.prepare("SELECT surau_id, phone FROM users WHERE phone IS NOT NULL AND deleted_at IS NULL AND surau_id <> '*'").all()) {
    const k = `${String(p.surau_id)}|${String(p.phone)}`;
    phoneCount.set(k, (phoneCount.get(k) ?? 0) + 1);
  }
  const deviceRows = db
    .prepare(`SELECT * FROM devices WHERE revoked_at IS NULL AND surau_id IN (?, ?) ORDER BY enrolled_at, id`)
    .all(...scope)
    .filter((d) => userIds.has(String(d.user_id)));

  const devices: DeviceActivity[] = deviceRows.map((d) => {
    const enrolledAt = String(d.enrolled_at);
    const seen = cloud ? null : typeof d.last_seen_at === 'string' ? d.last_seen_at : null;
    const tv = String(d.platform) === 'kiosk';
    const idleDays = cloud ? 0 : idleDaysOf({ enrolledAt, lastSeenAt: seen }, now);
    return {
      id: String(d.id),
      ref: refOfRow(d, 'device'),
      ...(includeStar ? { globalRef: globalRefOfRow(d, 'device') } : {}),
      userId: String(d.user_id),
      kind: tv ? 'tv' : 'device',
      enrolledAt,
      lastSeenAt: seen,
      idleDays,
      inactive: !cloud && idleDays >= (tv ? TV_IDLE_DAYS : DEVICE_IDLE_DAYS),
    };
  });

  const byUser = new Map<string, DeviceActivity[]>();
  for (const d of devices) {
    if (d.kind === 'tv') continue;
    const list = byUser.get(d.userId) ?? [];
    list.push(d);
    byUser.set(d.userId, list);
  }

  const users: UserActivity[] = userRows.map((u) => {
    const id = String(u.id);
    const own = byUser.get(id) ?? [];
    const createdAt = String(u.created_at);
    const lockedUntil = typeof u.pin_locked_until === 'string' ? u.pin_locked_until : null;
    const locked = lockedUntil !== null && Date.parse(lockedUntil) > now.getTime();
    const needs: UserNeed[] = [];
    if (locked) needs.push('locked');
    if (own.length === 0 && daysSince(createdAt, now) >= NO_DEVICE_DAYS) needs.push('no_device');
    if (typeof u.phone !== 'string' || u.phone.length === 0) needs.push('phone');
    else if ((phoneCount.get(`${String(u.surau_id)}|${u.phone}`) ?? 0) > 1) needs.push('phone_duplicate');
    const roles = parseRoles(u.roles_json);
    const holdsAdmin = roles.includes('admin') || roles.includes('superadmin');
    const lastActiveAt = cloud ? null : own.reduce<string | null>((best, d) => {
      const t = d.lastSeenAt;
      return t !== null && (best === null || t > best) ? t : best;
    }, null);
    const allIdle = own.length > 0 && own.every((d) => idleDaysOf(d, now) >= USER_IDLE_DAYS);
    const lastAdmin = holdsAdmin && activeAdminCount(db, String(u.surau_id)) <= 1;
    return {
      id,
      ref: refOfRow(u, 'user'),
      ...(includeStar ? { globalRef: globalRefOfRow(u, 'user') } : {}),
      createdAt,
      createdByName: actorNameOf(db, String(u.created_by), !includeStar),
      createdByRef: actorRefOf(db, String(u.created_by), !includeStar),
      deviceCount: own.length,
      lastActiveAt,
      locked,
      pinLockedUntil: locked ? lockedUntil : null,
      needs,
      suggestDeactivate: !cloud && allIdle && !lastAdmin,
    };
  });

  return {
    now: now.toISOString(),
    authority: cloud ? 'cloud' : 'box',
    limits: { deviceDays: DEVICE_IDLE_DAYS, tvDays: TV_IDLE_DAYS, noDeviceDays: NO_DEVICE_DAYS, userDays: USER_IDLE_DAYS, deactivatedDays: AUTO_DELETE_DEACTIVATED_DAYS },
    devices,
    users,
    noAdminPhone: activeAdminDeviceCount(db, surauId) === 0,
  };
}

/** The cloud's last-used times must be this fresh before the box removes any idle device (else a phone used only through the cloud could be lost). */
export const CLOUD_SEEN_FRESH_DAYS = 7;

/**
 * Is it safe for this box to remove idle devices? A box with no cloud link has nothing to wait for; a linked box
 * needs a good `device-seen` merge in the last 7 days.
 */
export function cloudSeenFresh(db: DatabaseSync, now: Date): boolean {
  const linked = db.prepare("SELECT value FROM sync_state WHERE key = 'linked'").get();
  if (linked === undefined || linked.value !== '1') return true;
  const seen = db.prepare("SELECT value FROM sync_state WHERE key = 'device_seen_at'").get();
  const t = typeof seen?.value === 'string' ? Date.parse(seen.value) : Number.NaN;
  return Number.isFinite(t) && t <= now.getTime() + 60_000 && now.getTime() - t < CLOUD_SEEN_FRESH_DAYS * DAY_MS;
}

/** `sync_state` keys of the clean-up's own safety memory. */
export const CLEAN_LAST_RUN_KEY = 'clean_last_run_at';
export const CLEAN_GRACE_KEY = 'clean_grace_until';
/** After a long gap, a clock jump or a stopped box, no device is removed for this long. */
export const CLEAN_GRACE_DAYS = 30;
/** A gap between runs, or between the clock and the newest row the database holds, over this many days is not normal operation. */
export const CLEAN_MAX_GAP_DAYS = 2;

function syncStateGet(db: DatabaseSync, key: string): string | null {
  const r = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
  return typeof r?.value === 'string' ? r.value : null;
}

function syncStateSet(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** The newest instant the database holds in the change log, the sessions or the auth log, or null when all are empty. */
function newestDbInstant(db: DatabaseSync): number | null {
  let best: number | null = null;
  for (const sql of ['SELECT MAX(at) AS t FROM change_log', 'SELECT MAX(created_at) AS t FROM sessions', 'SELECT MAX(at) AS t FROM auth_log']) {
    const r = db.prepare(sql).get();
    const t = typeof r?.t === 'string' ? Date.parse(r.t) : Number.NaN;
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best;
}

/**
 * Is this run trustworthy enough to remove anything? Not after a long gap since the last run, a clock that went
 * backwards, or a clock more than 2 days past anything the database has recorded (a box that sat off for months,
 * or a clock that jumped forward). Such a run starts a 30 day grace period.
 */
function cleanRunSuspicious(db: DatabaseSync, now: Date): boolean {
  const last = Date.parse(syncStateGet(db, CLEAN_LAST_RUN_KEY) ?? '');
  const limit = CLEAN_MAX_GAP_DAYS * DAY_MS;
  if (Number.isFinite(last) && (now.getTime() < last || now.getTime() - last > limit)) return true;
  const newest = newestDbInstant(db);
  return newest !== null && now.getTime() - newest > limit;
}

/**
 * The hourly clean-up (box only; the cloud receives the results through the feed). Actor `system`, each removal in
 * its own transaction and logged: every unrevoked phone, tablet and computer unused 180 days or more is
 * revoked (never the last Pentadbir phone; none at all while a linked box has no fresh cloud-seen), and every
 * deactivated person whose `deactivated_at` is 365 days or more old is soft-deleted. An active person is never
 * touched, and a person with no `deactivated_at` is skipped. Safety nets: a run after a long gap, a clock jump
 * or a clock that went backwards removes nothing and starts a 30 day grace period; a run never revokes more
 * than half of a surau's phones (it revokes none and logs a note); a TV screen is never removed automatically.
 */
export function autoCleanPeople(db: DatabaseSync, now: Date, role: 'box' | 'cloud', seenFresh: boolean): { devices: string[]; users: string[] } {
  const out = { devices: [] as string[], users: [] as string[] };
  if (role === 'cloud') return out;
  const nowIso = now.toISOString();
  const suspicious = cleanRunSuspicious(db, now);
  if (suspicious) syncStateSet(db, CLEAN_GRACE_KEY, new Date(now.getTime() + CLEAN_GRACE_DAYS * DAY_MS).toISOString());
  const graceUntil = Date.parse(syncStateGet(db, CLEAN_GRACE_KEY) ?? '');
  const inGrace = Number.isFinite(graceUntil) && graceUntil > now.getTime();
  syncStateSet(db, CLEAN_LAST_RUN_KEY, nowIso);
  if (suspicious) return out;
  if (seenFresh && !inGrace) {
    const rows = db
      .prepare("SELECT id, surau_id, enrolled_at, last_seen_at FROM devices WHERE revoked_at IS NULL AND surau_id <> '*' AND platform <> 'kiosk' ORDER BY enrolled_at, id")
      .all();
    const total = new Map<string, number>();
    const candidates = new Map<string, string[]>();
    for (const d of rows) {
      const surau = String(d.surau_id);
      total.set(surau, (total.get(surau) ?? 0) + 1);
      const idle = idleDaysOf({ enrolledAt: String(d.enrolled_at), lastSeenAt: typeof d.last_seen_at === 'string' ? d.last_seen_at : null }, now);
      if (idle < AUTO_DELETE_DEVICE_DAYS) continue;
      candidates.set(surau, [...(candidates.get(surau) ?? []), String(d.id)]);
    }
    for (const [surau, ids] of candidates) {
      if (ids.length * 2 > (total.get(surau) ?? 0)) {
        // too many at once looks like a fault, not idleness: revoke none, leave one note a day
        const noted = db.prepare("SELECT 1 FROM auth_log WHERE event = 'auto_clean_skipped' AND detail = ? AND at > ?").get(`over_half:${surau}`, new Date(now.getTime() - DAY_MS).toISOString());
        if (noted === undefined) authLog(db, now, 'auto_clean_skipped', false, { detail: `over_half:${surau}` });
        continue;
      }
      for (const id of ids) {
        try {
          revokeDeviceGuarded(db, id, 'system');
          out.devices.push(id);
        } catch (error) {
          if (!(error instanceof AuthError && error.code === 'last_admin_device')) throw error;
        }
      }
    }
  }
  const people = db
    .prepare("SELECT id, deactivated_at FROM users WHERE active = 0 AND deleted_at IS NULL AND surau_id <> '*' AND deactivated_at IS NOT NULL ORDER BY created_at, id")
    .all();
  for (const u of people) {
    if (daysSince(String(u.deactivated_at), now) < AUTO_DELETE_DEACTIVATED_DAYS) continue;
    tx(db, () => {
      deleteUserRows(db, String(u.id), 'system', nowIso);
      bumpFor(db, userSurau(db, String(u.id)));
    });
    out.users.push(String(u.id));
  }
  return out;
}
