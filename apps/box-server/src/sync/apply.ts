import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { decide, isContentKind, isFeatureKey, isMonthReport, isoInstantMs, newRev, MAX_PHOTO_BYTES, OPS_ROLES } from '@surau/core';
import type { FeedEntry, OpRefusal, OpResult, OpStatus, SyncOp } from '@surau/core';
import { AssetError } from '../assets/store.ts';
import { putSurauAsset } from '../surau/storage.ts';
import { enrolDeviceSynced, getDeviceWithKey, renameDeviceRows } from '../auth/devices.ts';
import { AuthError, cleanNameText, deviceSurau, getUserRow, logChange, putUserSynced, revokeDeviceRow, tx, userSurau } from '../auth/users.ts';
import { incomingNo, numberTaken, settleIncomingNo } from '../auth/ids.ts';
import { ContentError, deleteItemIn, putItemIn } from '../content/store.ts';
import { SettingsError, bumpVersion, putFeatureIn, sanitizeStamps } from '../settingsStore.ts';
import { deviceOfRev } from './meta.ts';
import { applyPrayerEntry } from './prayerApply.ts';
import { FinanceError, appendEntryIn, entryRow, fillRefNoFrom, insertReplicatedEntry, putFundIn, putMonthIn, putPerihalIn } from '../finance/store.ts';
import { PHOTO_ID_RE, PhotoError, photoMeta, photosDirOf, putPhoto } from '../finance/photos.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logSyncRefusal } from './verify.ts';
import type { ChangeMeta } from './meta.ts';

/** An op whose signature, device, user and permission the caller already verified (Task 3). */
export type VerifiedOp = SyncOp & { userName: string | null };

export interface ApplyCtx {
  now: Date;
  /** change_log origin of what is written: 'app' for a device op, 'box:<boxId>' or 'cloud' for replication. */
  origin: string;
  /** change_log actor, `user:<id>`. */
  actor: string;
  /** Where asset files live. */
  dataDir: string;
  /**
   * Whether an unknown device's public key may be registered from this feed. Set only where the cloud takes
   * entries from its own linked box. A box never takes a key from the cloud: a device key is a login, and a
   * compromised cloud must not be able to plant one on the surau's LAN.
   */
  acceptDeviceEnrolment?: boolean;
  /**
   * The sending site's own box id, set with `acceptDeviceEnrolment`: a device enrolled from that feed is homed at
   * this box (`devices.box_id`, Plan 14 Task 7). Never taken from the entry.
   */
  siteBoxId?: string;
  /**
   * Which server this is. Only the box hands out display numbers (`K-0001`) for finance entries; an unset role
   * is the cloud, which never invents one.
   */
  role?: 'box' | 'cloud';
  surauId: string;
  /** Builds the frozen report JSON when a device op closes a finance month (set where the report code is wired). */
  freezeReport?: (db: DatabaseSync, ym: string, now: Date, surauId: string) => string;
}

/** An asset op larger than this after decoding is refused. */
export const MAX_ASSET_OP_BYTES = 8 * 1024 * 1024;
/** A client clock this far ahead of the server is clamped to the server's. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

class Refused extends Error {
  readonly reason: OpRefusal;
  /** A fixed code for one `auth_log` row, written after the transaction rolled back (absent: no row). */
  readonly detail: string | undefined;
  constructor(reason: OpRefusal, detail?: string) {
    super(reason);
    this.name = 'Refused';
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Users and devices keep GLOBAL ids (migration 019 step 5), so an id may already exist under another surau. Such a
 * row is never touched from this surau: `foreign_id`. A `'*'` row (a Pentadbir MAXCOM, an ops device) is
 * foreign to a site, whose feed may never carry one up (the cloud alone holds them); a box or a device op may touch
 * one, under the checks `verifyDeviceOp` already made.
 */
function foreignRow(db: DatabaseSync, table: 'users' | 'devices', id: string, surauId: string, fromSite: boolean): boolean {
  const row = db.prepare(`SELECT surau_id FROM ${table} WHERE id = ?`).get(id);
  if (row === undefined) return false;
  const owner = String(row.surau_id);
  if (owner === surauId) return false;
  return !(owner === '*' && !fromSite);
}

/** Is the sending site the surau's primary box (the only source of plain-series ID numbers)? */
function siteIsPrimary(db: DatabaseSync, boxId: string | undefined): boolean {
  if (boxId === undefined) return false;
  const r = db.prepare('SELECT role FROM sites WHERE box_id = ? AND revoked_at IS NULL').get(boxId);
  return r !== undefined && r.role === 'primary';
}

/** Cloud: keep, accept or assign the ID of a row an entry just touched; a number another record holds falls back to a cloud-series one. */
function settleEntryNo(db: DatabaseSync, kind: 'user' | 'device', id: string, surauId: string, incoming: { no: number; src: 'b' | 'c' } | null, primary: boolean): void {
  if (settleIncomingNo(db, { kind, id, surauId }, incoming, primary) === 'id_taken') settleIncomingNo(db, { kind, id, surauId }, null, false);
}

type Current = { rev: string; editedAt: string; deviceId: string | null; deletedAt: string | null; revokedAt: string | null };

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The stored revision of an entity, with a fallback for rows written before migration 008 stamped them. */
function currentOf(db: DatabaseSync, entity: string, id: string, surauId: string): Current | null {
  let row: Record<string, unknown> | undefined;
  let fallbackAt = '';
  let deletedAt: string | null = null;
  let revokedAt: string | null = null;
  if (entity.startsWith('content:')) {
    row = db.prepare('SELECT rev, edited_at, updated_at, deleted_at FROM content_items WHERE surau_id = ? AND kind = ? AND id = ?').get(surauId, entity.slice(8), id);
    if (row === undefined) return null;
    fallbackAt = String(row.updated_at);
    deletedAt = str(row.deleted_at);
  } else if (entity === 'settings') {
    row = db.prepare('SELECT rev, edited_at, updated_at FROM settings WHERE surau_id = ? AND feature = ?').get(surauId, id);
    if (row === undefined) return null;
    fallbackAt = String(row.updated_at);
  } else if (entity === 'user') {
    row = db.prepare('SELECT rev, edited_at, created_at FROM users WHERE id = ?').get(id);
    if (row === undefined) return null;
    fallbackAt = String(row.created_at);
  } else if (entity === 'device') {
    row = db.prepare('SELECT rev, edited_at, enrolled_at, revoked_at FROM devices WHERE id = ?').get(id);
    if (row === undefined) return null;
    fallbackAt = String(row.enrolled_at);
    revokedAt = str(row.revoked_at);
  } else if (entity === 'finance:fund' || entity === 'finance:perihal') {
    row = db.prepare(`SELECT rev, edited_at, updated_at FROM ${entity === 'finance:fund' ? 'finance_funds' : 'finance_perihal'} WHERE surau_id = ? AND id = ?`).get(surauId, id);
    if (row === undefined) return null;
    fallbackAt = String(row.updated_at);
  } else if (entity === 'finance:month') {
    row = db.prepare('SELECT rev, edited_at, updated_at FROM finance_months WHERE surau_id = ? AND ym = ?').get(surauId, id);
    if (row === undefined) return null;
    fallbackAt = String(row.updated_at);
  } else {
    return null;
  }
  const rev = str(row.rev) ?? `${fallbackAt}|local`;
  return { rev, editedAt: str(row.edited_at) ?? fallbackAt, deviceId: deviceOfRev(rev), deletedAt, revokedAt };
}

/** The change_log entity name a store writes for a sync entity. */
const LOG_ENTITY: Record<string, string> = { user: 'users', device: 'devices' };

/** Who made the edit that currently holds an entity: the latest change_log row, with the user's name. */
function winnerOf(db: DatabaseSync, entity: string, id: string, current: Current, surauId: string): OpResult['winner'] {
  const row = db
    .prepare(
      `SELECT c.actor, c.edited_at, c.at, u.name AS user_name
         FROM change_log c LEFT JOIN users u ON c.actor = 'user:' || u.id
        WHERE c.surau_id IN (?, ?) AND c.entity = ? AND c.entity_id = ? ORDER BY c.id DESC LIMIT 1`,
    )
    .get(surauId, LOG_ENTITY[entity] !== undefined ? '*' : surauId, LOG_ENTITY[entity] ?? entity, id);
  if (row === undefined) return { actor: 'local', userName: null, editedAt: current.editedAt };
  return {
    actor: String(row.actor),
    userName: str(row.user_name),
    editedAt: str(row.edited_at) ?? String(row.at),
  };
}

/** Remember the op's first answer: `result` is the status it got, `winner` who beat it when superseded. */
function record(
  db: DatabaseSync,
  surauId: string,
  opId: string,
  deviceId: string,
  status: string,
  rev: string | null,
  now: string,
  result: OpStatus = 'applied',
  winner: OpResult['winner'] = null,
): void {
  db.prepare(
    'INSERT INTO applied_ops (surau_id, op_id, device_id, status, rev, applied_at, result_status, winner_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(surauId, opId, deviceId, status, rev, now, result, winner === null ? null : JSON.stringify(winner));
}

function appliedBefore(db: DatabaseSync, surauId: string, opId: string): { rev: string | null; result: string; winner: OpResult['winner'] } | null {
  const row = db.prepare('SELECT rev, result_status, winner_json FROM applied_ops WHERE surau_id = ? AND op_id = ?').get(surauId, opId);
  if (row === undefined) return null;
  let winner: OpResult['winner'] = null;
  if (typeof row.winner_json === 'string') {
    try {
      winner = JSON.parse(row.winner_json) as OpResult['winner'];
    } catch {
      winner = null;
    }
  }
  return { rev: str(row.rev), result: typeof row.result_status === 'string' ? row.result_status : 'applied', winner };
}

/** The answer to an op seen before: a superseded op stays superseded (same winner); anything else is a duplicate. */
function replayOf(opId: string, seen: NonNullable<ReturnType<typeof appliedBefore>>): OpResult {
  if (seen.result === 'superseded') return { opId, status: 'superseded', rev: seen.rev, reason: null, winner: seen.winner };
  return { opId, status: 'duplicate', rev: seen.rev, reason: null, winner: null };
}

const plain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** True when the op's entity is the one its kind writes (and, for content, a known kind). */
function entityMatches(op: SyncOp): boolean {
  switch (op.kind) {
    case 'content.put':
    case 'content.delete':
      return op.entity.startsWith('content:') && isContentKind(op.entity.slice(8));
    case 'settings.put':
      return op.entity === 'settings';
    case 'asset.put':
      return op.entity === 'asset';
    case 'user.put':
      return op.entity === 'user';
    case 'device.revoke':
      return op.entity === 'device';
    case 'audit.put':
      return op.entity === 'audit';
    case 'finance.append':
      return op.entity === 'finance:entry';
    case 'finance.lookup.put':
      return op.entity === 'finance:fund' || op.entity === 'finance:perihal';
    case 'finance.month.put':
      return op.entity === 'finance:month';
    case 'finance.photo.put':
      return op.entity === 'finance:photo';
    default:
      return false;
  }
}

/** The edit time as a normalized ISO instant, clamped to `now` when the clock runs ahead. Anything but an ISO instant is refused. */
function clampedEditedAt(editedAt: unknown, now: Date): string {
  const ms = isoInstantMs(editedAt);
  if (ms === null) throw new Refused('invalid');
  return new Date(ms > now.getTime() + CLOCK_SKEW_MS ? now.getTime() : ms).toISOString();
}

function refused(op: SyncOp, reason: OpRefusal): OpResult {
  return { opId: op.opId, status: 'refused', rev: null, reason, winner: null };
}

const AUDIT_KEYS = new Set(['event', 'sessionId', 'videoIds', 'bytes']);
const MAX_AUDIT_VIDEOS = 50;
const AUDIT_MAX_PER_DAY = 200;

/** The one audit note a device may write: `recording/deleted`. Anything else, or any extra key, is refused. */
function auditNote(op: SyncOp): { sessionId: string; videoIds: string[]; bytes: number } {
  const p = op.payload;
  if (!plain(p) || Object.keys(p).some((k) => !AUDIT_KEYS.has(k)) || p.event !== 'recording/deleted') throw new Refused('invalid');
  if (typeof p.sessionId !== 'string' || !SAFE_ID.test(p.sessionId)) throw new Refused('invalid');
  if (!Array.isArray(p.videoIds) || p.videoIds.length > MAX_AUDIT_VIDEOS) throw new Refused('invalid');
  if (!p.videoIds.every((v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(v))) throw new Refused('invalid');
  if (typeof p.bytes !== 'number' || !Number.isSafeInteger(p.bytes) || p.bytes < 0) throw new Refused('invalid');
  return { sessionId: p.sessionId, videoIds: p.videoIds as string[], bytes: p.bytes };
}

function decodeAsset(payload: unknown): { mime: string; buf: Buffer } {
  if (!plain(payload) || typeof payload.mime !== 'string' || typeof payload.bytesBase64 !== 'string') {
    throw new Refused('invalid');
  }
  const b64 = payload.bytesBase64;
  // Refuse on the encoded length first, so an oversize payload is never decoded into memory.
  if (b64.length > Math.ceil((MAX_ASSET_OP_BYTES * 4) / 3) + 4) throw new Refused('too_large');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > MAX_ASSET_OP_BYTES) throw new Refused('too_large');
  if (buf.length === 0) throw new Refused('invalid');
  return { mime: payload.mime, buf };
}

/**
 * Apply one verified device op under the merge rule (latest edit wins; delete and revoke are monotonic).
 * Verification (signature, device, user, permission) is the caller's job. One transaction per op: the data
 * write, its change_log row, the version bump and the `applied_ops` record land together or not at all.
 * The same `opId` twice answers `duplicate` and touches nothing.
 */
export function applyOp(db: DatabaseSync, op: VerifiedOp, ctx: ApplyCtx): OpResult {
  if (!entityMatches(op) || typeof op.opId !== 'string' || op.opId === '' || typeof op.entityId !== 'string') {
    return refused(op, 'invalid');
  }
  const nowIso = ctx.now.toISOString();
  try {
    const editedAt = clampedEditedAt(op.editedAt, ctx.now);
    return tx(db, () => {
      const seen = appliedBefore(db, ctx.surauId, op.opId);
      if (seen !== null) return replayOf(op.opId, seen);

      if (op.kind === 'asset.put') {
        const { mime, buf } = decodeAsset(op.payload);
        // counted against the surau's cloud storage limit (decision 24); full: 413, refused `too_large` on the wire
        const meta = putSurauAsset(db, ctx.dataDir, buf, mime, ctx.actor, ctx.surauId);
        record(db, ctx.surauId, op.opId, op.deviceId, meta.created ? 'applied' : 'duplicate', meta.id, nowIso);
        return { opId: op.opId, status: meta.created ? 'applied' : 'duplicate', rev: meta.id, reason: null, winner: null };
      }

      if (op.kind.startsWith('finance.')) return financeOp(db, op, ctx, editedAt, nowIso);

      if (op.kind === 'audit.put') {
        // An append-only note by a device (no merge, no feed): ids and a size, nothing a URI or token could hide in.
        const note = auditNote(op);
        // a device cannot flood the history: 200 notes per rolling day (a clean-up writes one per session)
        const dayAgo = new Date(ctx.now.getTime() - 24 * 3_600_000).toISOString();
        const sent = db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'recording/deleted' AND device_id = ? AND synced_at >= ?").get(op.deviceId, dayAgo);
        if (Number(sent?.n ?? 0) >= AUDIT_MAX_PER_DAY) throw new Refused('too_many');
        const rev = newRev(editedAt, op.deviceId);
        const meta: ChangeMeta = { deviceId: op.deviceId, origin: ctx.origin, opId: op.opId, editedAt, rev, syncedAt: nowIso };
        logChange(db, ctx.actor, 'recording/deleted', note.sessionId, undefined, note, meta, ctx.surauId);
        record(db, ctx.surauId, op.opId, op.deviceId, 'applied', rev, nowIso);
        return { opId: op.opId, status: 'applied', rev, reason: null, winner: null };
      }

      if (op.kind === 'settings.put') {
        if (!isFeatureKey(op.entityId)) throw new Refused('invalid');
        // The app lock is a local, live decision of the box; it never travels as an edit.
        if (op.entityId === 'appLock') throw new Refused('live_only');
      }
      if (op.kind === 'user.put' && !SAFE_ID.test(op.entityId)) throw new Refused('invalid');
      // a user or device of another surau does not exist for this one
      if (op.kind === 'user.put' && foreignRow(db, 'users', op.entityId, ctx.surauId, false)) throw new Refused('invalid', 'foreign_id');
      if (op.kind === 'device.revoke' && foreignRow(db, 'devices', op.entityId, ctx.surauId, false)) throw new Refused('invalid', 'foreign_id');

      if (op.kind === 'settings.put') {
        // Settings merge field by field inside the store; the op lands if any field was newer.
        const rev = newRev(editedAt, op.deviceId);
        const meta: ChangeMeta = { deviceId: op.deviceId, origin: ctx.origin, opId: op.opId, editedAt, rev, syncedAt: nowIso };
        const put = putFeatureIn(db, op.entityId as never, op.payload, ctx.actor, op.deviceId, meta, undefined, ctx.surauId);
        if (put.applied) {
          record(db, ctx.surauId, op.opId, op.deviceId, 'applied', rev, nowIso);
          // A field that lost to a newer stored stamp is named, so the app can show a Konflik card for it.
          return { opId: op.opId, status: 'applied', rev, reason: null, winner: null, ...(put.skipped.length > 0 ? { skipped: put.skipped } : {}) };
        }
        const cur = currentOf(db, 'settings', op.entityId, ctx.surauId)!;
        const winner = winnerOf(db, 'settings', op.entityId, cur, ctx.surauId);
        record(db, ctx.surauId, op.opId, op.deviceId, 'superseded', cur.rev, nowIso, 'superseded', winner);
        return { opId: op.opId, status: 'superseded', rev: cur.rev, reason: null, winner };
      }

      const current = currentOf(db, op.entity, op.entityId, ctx.surauId);
      if (op.kind === 'device.revoke' && current === null) throw new Refused('invalid');
      const verdict = decide({ kind: op.kind, current, op: { editedAt, deviceId: op.deviceId } });

      if (!verdict.apply) {
        const cur = current!;
        // A delete of something already deleted, a revoke of something already revoked: the end state holds.
        if (verdict.reason === 'already_revoked' || (op.kind === 'content.delete' && verdict.reason === 'tombstoned')) {
          record(db, ctx.surauId, op.opId, op.deviceId, verdict.reason, cur.rev, nowIso);
          return { opId: op.opId, status: 'applied', rev: cur.rev, reason: null, winner: null };
        }
        const winner = winnerOf(db, op.entity, op.entityId, cur, ctx.surauId);
        record(db, ctx.surauId, op.opId, op.deviceId, 'superseded', cur.rev, nowIso, 'superseded', winner);
        return { opId: op.opId, status: 'superseded', rev: cur.rev, reason: null, winner };
      }

      const rev = newRev(editedAt, op.deviceId);
      const meta: ChangeMeta = { deviceId: op.deviceId, origin: ctx.origin, opId: op.opId, editedAt, rev, syncedAt: nowIso };
      writeOp(db, op, ctx, meta, nowIso);
      record(db, ctx.surauId, op.opId, op.deviceId, 'applied', rev, nowIso);
      return { opId: op.opId, status: 'applied', rev, reason: null, winner: null };
    });
  } catch (error) {
    if (error instanceof Refused) {
      if (error.detail !== undefined) logSyncRefusal(db, ctx.now, { userId: op.userId, deviceId: op.deviceId }, error.detail);
      return refused(op, error.reason);
    }
    if (error instanceof AssetError) return refused(op, error.status === 413 ? 'too_large' : 'invalid');
    if (error instanceof FinanceError || error instanceof PhotoError || error instanceof FinanceRefusal) {
      const [reason, detail] = financeRefusal(error);
      logSyncRefusal(db, ctx.now, { userId: op.userId, deviceId: op.deviceId }, detail);
      return refused(op, reason);
    }
    if (error instanceof AuthError && (error.code === 'last_admin' || error.code === 'last_superadmin')) {
      logSyncRefusal(db, ctx.now, { userId: op.userId, deviceId: op.deviceId }, error.code);
      return refused(op, 'last_admin');
    }
    if (error instanceof AuthError && error.code === 'superadmin_cloud_only') {
      logSyncRefusal(db, ctx.now, { userId: op.userId, deviceId: op.deviceId }, 'superadmin_cloud_only');
      return refused(op, 'forbidden');
    }
    if (error instanceof ContentError || error instanceof SettingsError || error instanceof AuthError) {
      return refused(op, 'invalid');
    }
    throw error;
  }
}

function writeOp(db: DatabaseSync, op: VerifiedOp, ctx: ApplyCtx, meta: ChangeMeta, nowIso: string): void {
  switch (op.kind) {
    case 'content.put': {
      if (!plain(op.payload)) throw new Refused('invalid');
      const kind = op.entity.slice(8);
      if (!isContentKind(kind)) throw new Refused('invalid');
      putItemIn(db, kind, { ...op.payload, id: op.entityId }, ctx.actor, meta, ctx.surauId);
      return;
    }
    case 'content.delete': {
      const kind = op.entity.slice(8);
      if (!isContentKind(kind)) throw new Refused('invalid');
      deleteItemIn(db, kind, op.entityId, ctx.actor, meta, ctx.surauId);
      return;
    }
    case 'settings.put':
      // Handled in applyOp (field by field).
      throw new Refused('invalid');
    case 'user.put': {
      if (!plain(op.payload)) throw new Refused('invalid');
      const p = op.payload;
      const existing = getUserRow(db, op.entityId);
      const active = typeof p.active === 'boolean' ? p.active : existing?.active ?? true;
      const name = p.name ?? existing?.name;
      const roles = p.roles ?? existing?.roles;
      putUserSynced(db, op.entityId, { name: name as string, roles: roles as never, active }, ctx.actor, meta, ctx.surauId);
      // A user first seen by the cloud through a phone's op gets a cloud-series ID (an ID is allocated, never sent by a phone).
      if (ctx.role === 'cloud') settleIncomingNo(db, { kind: 'user', id: op.entityId, surauId: userSurau(db, op.entityId) }, null, false);
      return;
    }
    case 'device.revoke':
      if (revokeDeviceRow(db, op.entityId, ctx.actor, nowIso, meta)) bumpVersion(db, ctx.surauId);
      return;
    default:
      throw new Refused('invalid');
  }
}

// ---- Plan 7: finance ----------------------------------------------------------------------------------------

/** A finance op that cannot be applied, with the fixed code that goes in the refusal log (never a value). */
class FinanceRefusal extends Error {
  readonly reason: OpRefusal;
  readonly code: 'entry_exists' | 'invalid';
  constructor(reason: OpRefusal, code: 'entry_exists' | 'invalid' = 'invalid') {
    super(reason);
    this.name = 'FinanceRefusal';
    this.reason = reason;
    this.code = code;
  }
}

/** The refusal reason an op gets and the fixed log detail for it. */
function financeRefusal(error: FinanceError | PhotoError | FinanceRefusal): [OpRefusal, string] {
  if (error instanceof FinanceRefusal) return [error.reason, `apply_finance_${error.code}`];
  if (error instanceof PhotoError) return error.status === 413 ? ['too_large', 'apply_finance_too_large'] : ['invalid', 'apply_finance_invalid'];
  if (error.code === 'month_closed') return ['month_closed', 'apply_finance_month_closed'];
  if (error.code === 'fund_archived') return ['fund_archived', 'apply_finance_fund_archived'];
  if (error.code === 'entry_exists') return ['invalid', 'apply_finance_entry_exists'];
  if (error.code === 'opening_exists') return ['invalid', 'apply_finance_opening_exists'];
  if (error.code === 'already_voided') return ['invalid', 'apply_finance_already_voided'];
  return ['invalid', 'apply_finance_invalid'];
}

const FINANCE_YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const FUND_KEYS = ['name', 'public', 'targetSen', 'jumaat', 'sortOrder', 'archivedAt'] as const;
const PERIHAL_KEYS = ['direction', 'label', 'sortOrder', 'archivedAt'] as const;

function pickKeys(from: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (from[k] !== undefined) out[k] = from[k];
  return out;
}

/**
 * A month moves one way unless somebody explicitly reopens it: `closed` wins over `open` unless a later `open`
 * (a reopen) is already there; `open` wins over `closed` only when its edit time is later than the close.
 * `same` = the end state already holds; the cloud never invents either state.
 */
function monthVerdict(db: DatabaseSync, surauId: string, ym: string, status: 'open' | 'closed', editedAt: string): 'apply' | 'same' | 'superseded' {
  const cur = db.prepare('SELECT status, edited_at FROM finance_months WHERE surau_id = ? AND ym = ?').get(surauId, ym);
  const curStatus = cur === undefined ? 'open' : String(cur.status);
  const curAt = cur === undefined ? null : Date.parse(String(cur.edited_at));
  const at = Date.parse(editedAt);
  if (status === 'closed') {
    if (curStatus === 'closed') return 'same';
    return curAt !== null && at <= curAt ? 'superseded' : 'apply';
  }
  if (curStatus === 'open') return 'same';
  return curAt !== null && at > curAt ? 'apply' : 'superseded';
}

/** One verified finance op, inside the caller's transaction. A refusal is thrown and logged by the caller. */
function financeOp(db: DatabaseSync, op: VerifiedOp, ctx: ApplyCtx, editedAt: string, nowIso: string): OpResult {
  const rev = newRev(editedAt, op.deviceId);
  const meta: ChangeMeta = { deviceId: op.deviceId, origin: ctx.origin, opId: op.opId, editedAt, rev, syncedAt: nowIso };
  const fctx = { now: ctx.now, role: ctx.role ?? 'cloud', surauId: ctx.surauId };
  const applied = (): OpResult => {
    record(db, ctx.surauId, op.opId, op.deviceId, 'applied', rev, nowIso);
    return { opId: op.opId, status: 'applied', rev, reason: null, winner: null };
  };
  const superseded = (cur: Current): OpResult => {
    const winner = winnerOf(db, op.entity, op.entityId, cur, ctx.surauId);
    record(db, ctx.surauId, op.opId, op.deviceId, 'superseded', cur.rev, nowIso, 'superseded', winner);
    return { opId: op.opId, status: 'superseded', rev: cur.rev, reason: null, winner };
  };

  switch (op.kind) {
    case 'finance.append': {
      if (!plain(op.payload) || !SAFE_ID.test(op.entityId)) throw new Refused('invalid');
      // A ledger row is never overwritten. An id that exists already is a retry (`duplicate`) when the body is the
      // one stored, and refused otherwise; appendEntryIn judges which and writes nothing in either case.
      const had = entryRow(db, op.entityId, ctx.surauId) !== null;
      try {
        appendEntryIn(db, { ...op.payload, id: op.entityId }, ctx.actor, fctx, meta);
      } catch (error) {
        if (had && error instanceof FinanceError && error.code === 'entry_exists') throw new FinanceRefusal('invalid', 'entry_exists');
        throw error;
      }
      if (had) {
        record(db, ctx.surauId, op.opId, op.deviceId, 'duplicate', null, nowIso);
        return { opId: op.opId, status: 'duplicate', rev: null, reason: null, winner: null };
      }
      return applied();
    }
    case 'finance.lookup.put': {
      if (!plain(op.payload) || !SAFE_ID.test(op.entityId)) throw new Refused('invalid');
      const current = currentOf(db, op.entity, op.entityId, ctx.surauId);
      const verdict = decide({ kind: 'content.put', current, op: { editedAt, deviceId: op.deviceId } });
      if (!verdict.apply) return superseded(current!);
      if (op.entity === 'finance:fund') putFundIn(db, op.entityId, op.payload, ctx.actor, meta, ctx.surauId);
      else putPerihalIn(db, op.entityId, op.payload, ctx.actor, meta, undefined, ctx.surauId);
      return applied();
    }
    case 'finance.month.put': {
      if (!plain(op.payload) || !FINANCE_YM.test(op.entityId)) throw new Refused('invalid');
      const status = op.payload.status;
      if (Object.keys(op.payload).some((k) => k !== 'status') || (status !== 'open' && status !== 'closed')) throw new Refused('invalid');
      const verdict = monthVerdict(db, ctx.surauId, op.entityId, status, editedAt);
      if (verdict === 'superseded') return superseded(currentOf(db, op.entity, op.entityId, ctx.surauId)!);
      if (verdict === 'apply') {
        const freeze = ctx.freezeReport;
        putMonthIn(db, op.entityId, { status }, ctx.actor, { ...fctx, ...(freeze ? { freeze: (m: string) => freeze(db, m, ctx.now, ctx.surauId) } : {}) }, meta);
      }
      return applied();
    }
    case 'finance.photo.put': {
      const p = op.payload;
      if (!plain(p) || Object.keys(p).some((k) => k !== 'bytesBase64' && k !== 'entryId')) throw new Refused('invalid');
      if (typeof p.bytesBase64 !== 'string' || typeof p.entryId !== 'string' || !SAFE_ID.test(p.entryId) || !PHOTO_ID_RE.test(op.entityId)) throw new Refused('invalid');
      // Refuse on the encoded length first, so an oversize photo is never decoded into memory.
      if (p.bytesBase64.length > Math.ceil((MAX_PHOTO_BYTES * 4) / 3) + 4) throw new Refused('too_large');
      const buf = Buffer.from(p.bytesBase64, 'base64');
      if (buf.length > MAX_PHOTO_BYTES) throw new Refused('too_large');
      // The entity id IS the hash of the bytes: a photo can only ever be stored under its own name.
      if (createHash('sha256').update(buf).digest('hex') !== op.entityId) throw new Refused('invalid');
      putPhoto(db, ctx.dataDir, buf, p.entryId, ctx.actor, ctx.now, meta, ctx.surauId);
      return applied();
    }
    default:
      throw new Refused('invalid');
  }
}

/** One replicated finance feed entry, inside the caller's transaction. */
function financeEntry(
  db: DatabaseSync, e: FeedEntry, ctx: ApplyCtx, meta: ChangeMeta, editedAt: string, entryDevice: string,
  done: (status: OpStatus) => EntryResult,
): EntryResult {
  const bad: EntryResult = { status: 'refused', reason: 'invalid' };
  const after = e.after;
  if (!plain(after)) return bad;
  if ((e.entity === 'finance:entry' || e.entity === 'finance:fund' || e.entity === 'finance:perihal') && !SAFE_ID.test(e.entityId)) return bad;
  const fctx = { now: ctx.now, role: ctx.role ?? 'cloud', surauId: ctx.surauId };
  try {
    switch (e.entity) {
      case 'finance:entry': {
        if (after.id !== e.entityId) return bad;
        const existing = entryRow(db, e.entityId, ctx.surauId);
        if (existing !== null) {
          // A ledger row is never rewritten by replication; the only thing that may arrive late is its display number.
          const ref = typeof after.refNo === 'string' ? after.refNo : null;
          if (existing.refNo === null && ref !== null && fillRefNoFrom(db, e.entityId, ref, e.actor, meta, ctx.surauId)) return { status: 'applied', reason: null };
          return { status: 'duplicate', reason: null };
        }
        insertReplicatedEntry(db, after, e.entityId, e.actor, fctx, meta);
        // the op id may already be on record (the row was refused once before it arrived)
        if (e.opId !== null && appliedBefore(db, ctx.surauId, e.opId) === null) return done('applied');
        return { status: 'applied', reason: null };
      }
      case 'finance:fund':
      case 'finance:perihal': {
        const current = currentOf(db, e.entity, e.entityId, ctx.surauId);
        const verdict = decide({ kind: 'content.put', current, op: { editedAt, deviceId: entryDevice } });
        if (!verdict.apply) return { status: 'superseded', reason: null };
        if (e.entity === 'finance:fund') putFundIn(db, e.entityId, pickKeys(after, FUND_KEYS), e.actor, meta, ctx.surauId);
        else putPerihalIn(db, e.entityId, pickKeys(after, PERIHAL_KEYS), e.actor, meta, after.system === 'penceramah' ? { system: 'penceramah' } : undefined, ctx.surauId);
        return done('applied');
      }
      case 'finance:month': {
        // the other side's note that an entry reached a month it had closed: its own history, never a close or reopen
        if (plain(after.lateEntry)) return { status: 'duplicate', reason: null };
        const status = after.status;
        if (!FINANCE_YM.test(e.entityId) || (status !== 'open' && status !== 'closed')) return bad;
        // a frozen report that is present must be the shape freezeReport makes, for this month; anything else is refused
        const rep = after.report;
        if (status === 'closed' && rep !== undefined && rep !== null && (!isMonthReport(rep) || rep.ym !== e.entityId)) return bad;
        const verdict = monthVerdict(db, ctx.surauId, e.entityId, status, editedAt);
        if (verdict === 'superseded') return { status: 'superseded', reason: null };
        if (verdict === 'same') return { status: 'duplicate', reason: null };
        const frozen = status === 'closed' && isMonthReport(rep) ? JSON.stringify(rep) : null;
        putMonthIn(db, e.entityId, { status }, e.actor, { ...fctx, frozenJson: frozen }, meta);
        return done('applied');
      }
      case 'finance:photo': {
        const mime = after.mime; const bytes = after.bytes; const entryId = after.entryId;
        if (!PHOTO_ID_RE.test(e.entityId) || mime !== 'image/jpeg' || typeof entryId !== 'string' || !SAFE_ID.test(entryId)) return bad;
        if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_PHOTO_BYTES) return bad;
        if (photoMeta(db, e.entityId, ctx.surauId) !== null) return { status: 'duplicate', reason: null };
        // A photo hash another surau holds is never registered here (Plan 14 section 5): the name alone would hand
        // this surau that surau's file. Refused `foreign_id` (the site route logs `site_apply_foreign_id`).
        if (db.prepare('SELECT 1 AS x FROM finance_photos WHERE id = ? AND surau_id <> ?').get(e.entityId, ctx.surauId) !== undefined) {
          return { status: 'refused', reason: 'foreign_id' };
        }
        // Metadata only: the bytes come by their own route and flip `present` when they arrive. On a box a file
        // already on disk is its own surau's; on the cloud a file is never this surau's until it sends the bytes
        // itself (the bytes route checks their hash), so a file left by anyone else is never granted by its name.
        const onDisk = existsSync(join(photosDirOf(ctx.dataDir), `${e.entityId}.jpg`));
        const present = onDisk && ctx.role === 'box' ? 1 : 0;
        db.prepare(
          'INSERT INTO finance_photos (surau_id, id, entry_id, mime, bytes, created_at, created_by, present) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(ctx.surauId, e.entityId, entryId, 'image/jpeg', bytes, ctx.now.toISOString(), e.actor, present);
        logChange(db, e.actor, 'finance:photo', e.entityId, undefined, { entryId, mime: 'image/jpeg', bytes }, meta, ctx.surauId);
        return done('applied');
      }
      default:
        return bad;
    }
  } catch (error) {
    if (error instanceof FinanceError || error instanceof PhotoError) return bad;
    throw error;
  }
}

export interface EntryResult {
  status: OpStatus;
  /**
   * `device_key_mismatch`: an enrolment names an existing device id with a different key (sync never replaces a key).
   * `foreign_id`: a user or device id that exists under another surau (never touched from this one).
   */
  reason: OpRefusal | 'device_key_mismatch' | 'foreign_id' | null;
}

const DEV_REVOKED_PREFIX = 'dev_revoked/';

/** A revocation that reached a side before the device did: a late enrolment entry for that id must not bring it back. */
function noteRevokedEarly(db: DatabaseSync, id: string, at: string): void {
  db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(DEV_REVOKED_PREFIX + id, at);
}
const revokedEarly = (db: DatabaseSync, id: string): boolean =>
  db.prepare('SELECT 1 AS x FROM sync_state WHERE key = ?').get(DEV_REVOKED_PREFIX + id) !== undefined;

/**
 * The replication twin of `applyOp`: apply one feed entry from the other side under the same merge rule.
 * The entry's `rev`, `editedAt`, `origin` and `opId` are written as they are (a rev is never re-made), so a
 * device op replicated through the box keeps its id and cannot be applied twice on the cloud. Reference
 * checks are skipped: the feed delivers items in order and assets are transferred separately.
 * An entry whose revision the row already holds is a no-op, so redelivery is safe.
 */
export function applyFeedEntry(db: DatabaseSync, e: FeedEntry, ctx: ApplyCtx): EntryResult {
  const nowIso = ctx.now.toISOString();
  const origin = e.origin === 'local' ? ctx.origin : e.origin;
  // The device that made the edit is the one inside the rev; a local edit's is 'local'.
  const entryDevice = deviceOfRev(e.rev) ?? e.deviceId ?? '';
  // The time is held to the same rule as a device op's: an ISO instant, clamped when it is ahead of now.
  let editedAt: string;
  try {
    editedAt = clampedEditedAt(e.editedAt, ctx.now);
  } catch {
    return { status: 'refused', reason: 'invalid' };
  }
  const clamped = isoInstantMs(e.editedAt) !== Date.parse(editedAt);
  const meta: ChangeMeta = {
    deviceId: e.deviceId ?? undefined,
    origin,
    opId: e.opId ?? undefined,
    editedAt,
    rev: clamped ? newRev(editedAt, entryDevice) : e.rev,
    syncedAt: nowIso,
    trusted: true,
  };
  // Where the cloud takes entries from its linked box: the cloud holds the Pentadbir MAXCOM alone.
  const fromSite = ctx.acceptDeviceEnrolment === true || origin.startsWith('box:');
  const ownerIsSuperadmin = (userId: string): boolean => fromSite && getUserRow(db, userId)?.roles.includes('superadmin') === true;
  const refuseSuperadmin = (userId: unknown, deviceId: unknown): EntryResult => {
    logSyncRefusal(db, ctx.now, { userId, deviceId }, 'superadmin_cloud_only');
    return { status: 'refused', reason: 'forbidden' };
  };
  try {
    return tx(db, () => {
      // A finance entry decides for itself (it may still be owed its display number), so the op id shortcut skips it.
      if (e.entity !== 'finance:entry' && e.opId !== null && appliedBefore(db, ctx.surauId, e.opId) !== null) return { status: 'duplicate', reason: null };
      const done = (status: OpStatus): EntryResult => {
        if (status === 'applied' && e.opId !== null) record(db, ctx.surauId, e.opId, e.deviceId ?? '', 'applied', meta.rev ?? e.rev, nowIso);
        return { status, reason: null };
      };

      if (e.entity.startsWith('finance:')) return financeEntry(db, e, ctx, meta, editedAt, entryDevice, done);

      if (e.entity.startsWith('prayer:')) {
        const r = applyPrayerEntry(db, e, meta, ctx.now, ctx.surauId);
        return r.status === 'applied' ? done('applied') : { status: r.status, reason: r.reason };
      }

      if (e.entity.startsWith('content:')) {
        const kind = e.entity.slice(8);
        if (!isContentKind(kind)) return { status: 'refused', reason: 'invalid' };
        const isDelete = e.after === null;
        if (!isDelete && !plain(e.after)) return { status: 'refused', reason: 'invalid' };
        const current = currentOf(db, e.entity, e.entityId, ctx.surauId);
        const verdict = decide({ kind: isDelete ? 'content.delete' : 'content.put', current, op: { editedAt, deviceId: entryDevice } });
        if (!verdict.apply) return { status: 'superseded', reason: null };
        // A delete of an entity this side never saw still writes the tombstone.
        if (isDelete) deleteItemIn(db, kind, e.entityId, e.actor, meta, ctx.surauId);
        else putItemIn(db, kind, { ...(e.after as Record<string, unknown>), id: e.entityId }, e.actor, meta, ctx.surauId);
        return done('applied');
      }

      if (e.entity === 'settings') {
        if (!isFeatureKey(e.entityId) || e.entityId === 'appLock' || !plain(e.after)) {
          return { status: 'refused', reason: e.entityId === 'appLock' ? 'live_only' : 'invalid' };
        }
        let fieldStamps;
        if (e.stamps !== undefined) {
          fieldStamps = sanitizeStamps(e.stamps, (t) => clampedEditedAt(t, ctx.now));
          if (fieldStamps === null) return { status: 'refused', reason: 'invalid' };
        }
        // Field by field: a field lands only when its stamp is newer than the stored one.
        const put = putFeatureIn(db, e.entityId, e.after, e.actor, e.deviceId ?? undefined, meta, { fieldStamps }, ctx.surauId);
        return put.applied ? done('applied') : { status: 'superseded', reason: null };
      }

      if (e.entity === 'user') {
        const after = e.after;
        if (!plain(after) || !SAFE_ID.test(e.entityId)) return { status: 'refused', reason: 'invalid' };
        const existing = getUserRow(db, e.entityId);
        // From a site the cloud takes no superadmin: not a new one, not an edit of one (rename, roles, active).
        // Checked before the merge verdict, so an old or new stamp makes no difference to the answer.
        if (fromSite && (existing?.roles.includes('superadmin') === true || (Array.isArray(after.roles) && after.roles.includes('superadmin')))) {
          return refuseSuperadmin(e.entityId, e.deviceId);
        }
        // Sokongan MAXCOM is made by the cloud CLI alone too (operator decision 20): a site never plants a `'*'` user.
        if (fromSite && Array.isArray(after.roles) && after.roles.some((r) => OPS_ROLES.includes(r as never))) return refuseSuperadmin(e.entityId, e.deviceId);
        if (foreignRow(db, 'users', e.entityId, ctx.surauId, fromSite)) return { status: 'refused', reason: 'foreign_id' };
        const current = currentOf(db, 'user', e.entityId, ctx.surauId);
        const verdict = decide({ kind: 'user.put', current, op: { editedAt, deviceId: entryDevice } });
        if (!verdict.apply) return { status: 'superseded', reason: null };
        const active = typeof after.active === 'boolean' ? after.active : existing?.active ?? true;
        // The ID: only the cloud settles one, and only from a site (a box never takes a number from an entry).
        const incoming = ctx.role === 'cloud' && fromSite ? incomingNo(after.no, after.noSrc) : null;
        const primary = ctx.role === 'cloud' && fromSite && siteIsPrimary(db, ctx.siteBoxId);
        if (existing === undefined && incoming !== null && incoming.src === 'b' && primary && numberTaken(db, ctx.surauId, 'user', 'b', incoming.no)) {
          return { status: 'refused', reason: 'id_taken' };
        }
        putUserSynced(db, e.entityId, { name: after.name as string, roles: after.roles as never, active, ...(typeof after.deleted === 'boolean' ? { deleted: after.deleted } : {}), ...(typeof after.phone === 'string' ? { phone: after.phone } : {}) }, e.actor, meta, ctx.surauId);
        if (ctx.role === 'cloud') settleEntryNo(db, 'user', e.entityId, userSurau(db, e.entityId), incoming, primary);
        return done('applied');
      }

      if (e.entity === 'device') {
        const after = plain(e.after) ? e.after : null;
        if (after === null || !SAFE_ID.test(e.entityId)) return { status: 'refused', reason: 'invalid' };
        const key = plain(after.publicJwk) ? after.publicJwk : null;
        const current = currentOf(db, 'device', e.entityId, ctx.surauId);

        if (current === null) {
          if (key === null) {
            // A revocation of a device this side never saw: remembered, so a late enrolment of it stays revoked.
            if (after.revoked === true) noteRevokedEarly(db, e.entityId, editedAt);
            return { status: 'refused', reason: 'device_unknown' };
          }
          if (ctx.acceptDeviceEnrolment !== true) return { status: 'refused', reason: 'device_unknown' };
          // the home box is the sending site's; an entry naming any other box is refused (verifySiteEntry already does)
          if (after.boxId !== undefined && after.boxId !== ctx.siteBoxId) {
            logSyncRefusal(db, ctx.now, { userId: after.userId, deviceId: e.entityId }, 'box_mismatch');
            return { status: 'refused', reason: 'invalid' };
          }
          if (revokedEarly(db, e.entityId)) return { status: 'duplicate', reason: null };
          // Nothing about a Pentadbir MAXCOM comes from a site: its devices are enrolled on the cloud alone.
          if (ownerIsSuperadmin(String(after.userId))) return refuseSuperadmin(after.userId, e.entityId);
          // a device is enrolled for a user of the sending site's own surau only
          if (foreignRow(db, 'users', String(after.userId), ctx.surauId, fromSite)) return { status: 'refused', reason: 'foreign_id' };
          // The box's number for a device the cloud has not seen is refused when another device of the surau holds it.
          const devNo = ctx.role === 'cloud' ? incomingNo(after.no, after.noSrc) : null;
          if (devNo !== null && devNo.src === 'b' && siteIsPrimary(db, ctx.siteBoxId) && numberTaken(db, ctx.surauId, 'device', 'b', devNo.no)) {
            return { status: 'refused', reason: 'id_taken' };
          }
          try {
            enrolDeviceSynced(
              db,
              { id: e.entityId, userId: String(after.userId), name: String(after.name ?? ''), platform: String(after.platform), publicJwk: key, enrolledAt: String(after.enrolledAt) },
              e.actor,
              meta,
              ctx.siteBoxId ?? null,
              ctx.surauId,
            );
            if (ctx.role === 'cloud') {
              settleEntryNo(db, 'device', e.entityId, deviceSurau(db, e.entityId), incomingNo(after.no, after.noSrc), siteIsPrimary(db, ctx.siteBoxId));
            }
          } catch (error) {
            if (error instanceof AuthError) {
              logSyncRefusal(db, ctx.now, { userId: after.userId, deviceId: e.entityId }, error.code === 'user_not_found' ? 'enrol_user_unknown' : 'enrol_invalid');
              return { status: 'refused', reason: 'invalid' };
            }
            throw error;
          }
          // an entry that says both "enrolled" and "revoked" leaves the device revoked
          if (after.revoked === true && revokeDeviceRow(db, e.entityId, e.actor, nowIso, meta)) bumpVersion(db, ctx.surauId);
          return done('applied');
        }

        if (fromSite) {
          const owner = db.prepare('SELECT user_id FROM devices WHERE id = ?').get(e.entityId);
          if (owner !== undefined && ownerIsSuperadmin(String(owner.user_id))) return refuseSuperadmin(owner.user_id, e.entityId);
          // nor a device of a Sokongan MAXCOM (decision 21), wherever it was enrolled
          if (owner !== undefined && foreignRow(db, 'users', String(owner.user_id), ctx.surauId, fromSite)) return { status: 'refused', reason: 'foreign_id' };
        }
        if (foreignRow(db, 'devices', e.entityId, ctx.surauId, fromSite)) return { status: 'refused', reason: 'foreign_id' };
        if (key !== null) {
          // A key is never replaced by sync (a re-enrolment makes a new id).
          const stored = getDeviceWithKey(db, e.entityId)?.publicJwk;
          const same = stored != null && stored.x === key.x && stored.y === key.y && stored.kty === key.kty && stored.crv === key.crv;
          if (!same) {
            logSyncRefusal(db, ctx.now, { userId: after.userId, deviceId: e.entityId }, 'device_key_mismatch');
            return { status: 'refused', reason: 'device_key_mismatch' };
          }
        }
        if (ctx.role === 'cloud') settleEntryNo(db, 'device', e.entityId, deviceSurau(db, e.entityId), incomingNo(after.no, after.noSrc), siteIsPrimary(db, ctx.siteBoxId));
        if (after.revoked !== true) {
          // A rename: the one change of a live device that travels besides its revocation (no new op kind).
          const stored = db.prepare('SELECT name, revoked_at FROM devices WHERE id = ?').get(e.entityId);
          if (stored !== undefined && stored.revoked_at === null && typeof after.name === 'string') {
            const clean = cleanNameText(after.name);
            if (clean !== null && clean !== stored.name && decide({ kind: 'content.put', current, op: { editedAt, deviceId: entryDevice } }).apply) {
              renameDeviceRows(db, e.entityId, clean, e.actor, meta);
              return done('applied');
            }
          }
          return { status: 'duplicate', reason: null };
        }
        const verdict = decide({ kind: 'device.revoke', current, op: { editedAt, deviceId: entryDevice } });
        if (!verdict.apply) return { status: 'duplicate', reason: null };
        if (revokeDeviceRow(db, e.entityId, e.actor, nowIso, meta)) bumpVersion(db, ctx.surauId);
        return done('applied');
      }

      return { status: 'refused', reason: 'invalid' };
    });
  } catch (error) {
    // A replicated edit would leave the surau without an active admin: refused, and recorded in the auth log.
    if (error instanceof AuthError && (error.code === 'last_admin' || error.code === 'last_superadmin')) {
      logSyncRefusal(db, ctx.now, { userId: e.entityId, deviceId: e.deviceId }, error.code);
      return { status: 'refused', reason: 'last_admin' };
    }
    if (error instanceof AuthError && error.code === 'superadmin_cloud_only') {
      logSyncRefusal(db, ctx.now, { userId: e.entityId, deviceId: e.deviceId }, 'superadmin_cloud_only');
      return { status: 'refused', reason: 'forbidden' };
    }
    if (error instanceof ContentError || error instanceof SettingsError || error instanceof AuthError) {
      return { status: 'refused', reason: 'invalid' };
    }
    throw error;
  }
}
