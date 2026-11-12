/** Sync types shared by the box, the cloud and the app. Pure types: no runtime code. */

import type { FinanceSnapshot } from '../finance/types.ts';

export type OpKind = 'content.put' | 'content.delete' | 'settings.put' | 'asset.put' | 'user.put' | 'device.revoke' | 'audit.put'
  | 'finance.append' | 'finance.lookup.put' | 'finance.month.put' | 'finance.photo.put';

/** One signed edit made on a device. `sig` is over `opMessage()` (see canonical.ts). */
export interface SyncOp {
  v: 1;
  /** 26-character ULID made on the device. */
  opId: string;
  surauId: string;
  boxId: string;
  deviceId: string;
  userId: string;
  kind: OpKind;
  /** 'content:<kind>' | 'settings' | 'asset' | 'user' | 'device' | 'audit' */
  entity: string;
  entityId: string;
  /** The rev the device last saw for this entity (null when it saw none). */
  baseRev: string | null;
  /** ISO time on the device clock. */
  editedAt: string;
  /** The item, the settings patch, `{ mime, bytesBase64 }` for an asset, null for delete and revoke. */
  payload: unknown;
  /** base64url signature over `opMessage()`. */
  sig: string;
}

export type OpStatus = 'applied' | 'duplicate' | 'superseded' | 'refused';

export type OpRefusal =
  | 'bad_signature' | 'device_revoked' | 'device_unknown' | 'user_inactive'
  | 'forbidden' | 'invalid' | 'live_only' | 'too_large' | 'last_admin' | 'too_many'
  | 'month_closed' | 'fund_archived';

/** Who last wrote one settings field, and when: the unit settings merge by (see `decide`). */
export interface FieldStamp {
  editedAt: string;
  deviceId: string;
}

export interface OpResult {
  opId: string;
  status: OpStatus;
  rev: string | null;
  reason: OpRefusal | null;
  winner: { actor: string; userName: string | null; editedAt: string } | null;
}

export interface FeedEntry {
  seq: number;
  entity: string;
  entityId: string;
  rev: string;
  editedAt: string;
  syncedAt: string;
  actor: string;
  deviceId: string | null;
  /** 'box:<boxId>' | 'cloud' | 'app' */
  origin: string;
  opId: string | null;
  /** null = tombstone */
  after: unknown | null;
  /**
   * Settings only: field path (dot-joined) -> who last wrote it, for every field in `after`. A receiver takes
   * a field only when this stamp is newer than its own. Absent (older peers): every field carries the entry's stamp.
   */
  stamps?: Record<string, FieldStamp>;
}

/**
 * The `after` of a `device` feed entry: a revocation (`{ revoked: true }`) or an enrolment. An enrolment carries
 * the PUBLIC key only (never a private key, PIN or token); a receiver never replaces the key of a known device id.
 */
export interface DeviceEntryAfter {
  id?: string;
  userId?: string;
  name?: string;
  platform?: string;
  publicJwk?: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  enrolledAt?: string;
  revoked?: boolean;
}

export interface Snapshot {
  surauId: string;
  boxId: string;
  seq: number;
  settings: Record<string, unknown>;
  /** Per feature: when the stored settings row was last edited, its rev and per-field stamps (see FeedEntry.stamps). */
  settingsMeta?: Record<string, { editedAt: string; rev: string; stamps: Record<string, FieldStamp> }>;
  /** Per kind; tombstones are included as `{ id, deletedAt }`. */
  content: Record<string, unknown[]>;
  /** Only for callers holding `users:manage`. Each record carries its real `editedAt` and `rev`. */
  users?: unknown[];
  /** Only for callers holding `devices:manage`. */
  devices?: unknown[];
  /** Only for callers holding `finance:read`. */
  finance?: FinanceSnapshot;
  surauInfo: unknown;
  serverTime: string;
  /** Official days per zone and year, this surau's file imports with their rows, and its manual corrections (never calculated days). */
  prayer?: {
    official: { zone: string; year: number; days: unknown[]; fetchedAt: string | null }[];
    imports: unknown[];
    corrections: unknown[];
  };
}

export interface SyncStatus {
  linked: boolean;
  cloudUrl: string | null;
  lastPush: string | null;
  lastPull: string | null;
  pendingOut: number;
  lastError: string | null;
}
