import { LOCAL_SURAU_ID } from '../tenant.ts';
import type { DatabaseSync } from 'node:sqlite';
import { CONTENT_KINDS, SURAU_ID_RE } from '@surau/core';
import type { FeedEntry, Snapshot } from '@surau/core';
import { readFieldStamps, surauPublicInfo } from '../settingsStore.ts';
import { snapshotCorrections } from '../prayer/corrections.ts';
import { snapshotImports } from '../prayer/importFile.ts';
import { officialYears, officialZones } from '../prayerStore.ts';
import { retentionDays } from './trim.ts';
import { allEntries, listFunds, listMonths, listPerihal } from '../finance/store.ts';
import { listPhotoMeta } from '../finance/photos.ts';
import { refOfRow } from '../auth/ids.ts';

/** What the caller may see: users need `users:manage`, devices `devices:manage`. */
export interface FeedScope {
  users: boolean;
  devices: boolean;
  /**
   * Device PUBLIC keys are handed out to a linked site only. A user or device session, and every admin list,
   * gets none: a missing `keys` means no keys.
   */
  keys?: boolean;
  /** A site or an ops-device session also gets the Pentadbir MAXCOM rows (`users.surau_id = '*'`) and their devices. */
  star?: boolean;
  /**
   * The surau whose entries are read (Plan 14 Task 6): its own change_log rows, plus, for a `star` scope, the
   * Pentadbir MAXCOM user and device entries (nothing else filed under `'*'`). Absent = the box's local surau.
   */
  surauId?: string;
  /** `finance:read`: the ledger, lookups and month states (never the audit-only rows `finance:report|view|export`). */
  finance?: boolean;
  /** `finance:write`: also the photo ids and photo metadata. A reader without it never learns a photo exists. */
  financeWrite?: boolean;
  /**
   * `content:write`: the editors of content also get a penceramah's private phone number. A missing flag means
   * no phone (every read-only role). A linked site and the box-to-cloud agent carry it.
   */
  contentWrite?: boolean;
  /**
   * The cloud serving a linked site: user and device entries leave without `no` and `noSrc`. An older box refuses
   * a device entry with a key it does not know, so a cloud-series ID reaches a box through `GET /api/sync/device-seen`
   * instead (the box asks for it; an older box never does).
   */
  omitIds?: boolean;
}

export interface Feed {
  entries: FeedEntry[];
  /** `since` for the next page when more entries remain, else null. */
  next: number | null;
  /**
   * The highest change_log id visible in this scope, read in the same snapshot as the entries.
   * A box that has paged to the end (next === null) clears the cloud's dirty flag with exactly this value.
   */
  head: number;
}

const DEFAULT_LIMIT = 500;
type Row = Record<string, unknown>;

/** change_log entity names are plural for users and devices; the feed uses the singular of the op model. */
const FEED_NAME: Record<string, string> = { users: 'user', devices: 'device' };

/** Entities that may leave this box. `live`, `islamic`, `youtube/*` and `auth` never do. */
function entityPredicate(scope: FeedScope): string {
  // Official days, file imports and corrections travel; a calculated day is never stored, so never sent.
  const parts = ["entity LIKE 'content:%'", "entity = 'settings'", "entity IN ('prayer:official', 'prayer:import', 'prayer:correction')"];
  if (scope.finance === true) {
    parts.push(scope.financeWrite === true
      ? "entity IN ('finance:entry', 'finance:fund', 'finance:perihal', 'finance:month', 'finance:photo')"
      : "entity IN ('finance:entry', 'finance:fund', 'finance:perihal', 'finance:month')");
  }
  if (scope.users) parts.push("entity IN ('users', 'user')");
  if (scope.devices) parts.push("entity IN ('devices', 'device')");
  const own = `surau_id = ${sqlText(scopeSurau(scope))}`;
  if (scope.keys === true || scope.star === true) {
    // The feed of a site (or an ops session) = its surau's entries plus the `*` user and device entries: a row
    // filed under '*', or any row of a `*` user or an ops device (older rows were filed under the local surau).
    const star: string[] = [];
    if (scope.users) star.push(`(entity IN ('users', 'user') AND (surau_id = '*' OR entity_id IN (SELECT id FROM users WHERE surau_id = '*')))`);
    if (scope.devices) star.push(`(entity IN ('devices', 'device') AND (surau_id = '*' OR entity_id IN (SELECT id FROM devices WHERE surau_id = '*')))`);
    const mine = `(${own} AND (${parts.join(' OR ')}))`;
    return star.length === 0 ? mine : `(${mine} OR ${star.join(' OR ')})`;
  }
  // A surau session never sees a Pentadbir MAXCOM or its devices (operator decision 22).
  return `(${own} AND (${parts.join(' OR ')}) AND NOT (entity IN ('users', 'user') AND entity_id IN (SELECT id FROM users WHERE surau_id = '*'))`
    + ` AND NOT (entity IN ('devices', 'device') AND entity_id IN (SELECT d.id FROM devices d JOIN users u ON u.id = d.user_id WHERE u.surau_id = '*' OR d.surau_id = '*')))`;
}

/** The surau a scope reads: its own, else the box's local one. Never `'*'` (that is not a tenant). */
function scopeSurau(scope: FeedScope): string {
  const s = scope.surauId ?? LOCAL_SURAU_ID;
  if (!SURAU_ID_RE.test(s)) throw new Error('feed scope needs a surau id');
  return s;
}

/** A surau id as an SQL string literal (checked against SURAU_ID_RE first, so it holds no quote). */
const sqlText = (s: string): string => `'${s}'`;

/** Run fn in one read snapshot (a deferred transaction), unless the caller already holds a transaction. */
function inSnapshot<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN');
  try {
    return fn();
  } finally {
    db.exec('COMMIT');
  }
}

function parseJson(v: unknown): unknown {
  if (typeof v !== 'string') return null;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return null;
  }
}

/** A reader who may not see photos gets the entry without its photo reference. */
function withoutPhoto(after: unknown): unknown {
  if (typeof after !== 'object' || after === null || Array.isArray(after) || !('photoId' in after)) return after;
  const { photoId: _drop, ...rest } = after as Record<string, unknown>;
  return rest;
}

/** A reader who may not edit content gets a penceramah without the speaker's private phone number. */
function withoutPhone<T>(item: T): T {
  if (typeof item !== 'object' || item === null || Array.isArray(item) || !('phone' in item)) return item;
  const { phone: _drop, ...rest } = item as Record<string, unknown>;
  return rest as T;
}

/** Remove device key material from a feed `after` unless the scope may carry keys. */
function withoutKeys(after: unknown): unknown {
  if (typeof after !== 'object' || after === null || Array.isArray(after) || !('publicJwk' in after)) return after;
  const { publicJwk: _drop, ...rest } = after as Record<string, unknown>;
  return rest;
}

/** An entry's `after` without the ID keys (see `FeedScope.omitIds`). */
function withoutIds(after: unknown): unknown {
  if (typeof after !== 'object' || after === null || Array.isArray(after) || !('no' in after || 'noSrc' in after)) return after;
  const { no: _a, noSrc: _b, ...rest } = after as Record<string, unknown>;
  return rest;
}

function toEntry(r: Row, scope: FeedScope): FeedEntry {
  const at = String(r.at);
  const entity = String(r.entity);
  const stamps = entity === 'settings' ? parseJson(r.stamps_json) : null;
  return {
    seq: Number(r.id),
    entity: FEED_NAME[entity] ?? entity,
    entityId: typeof r.entity_id === 'string' ? r.entity_id : '',
    rev: typeof r.rev === 'string' ? r.rev : `${at}|local`,
    editedAt: typeof r.edited_at === 'string' ? r.edited_at : at,
    syncedAt: typeof r.synced_at === 'string' ? r.synced_at : at,
    actor: String(r.actor),
    deviceId: typeof r.device_id === 'string' ? r.device_id : null,
    origin: typeof r.origin === 'string' ? r.origin : 'local',
    opId: typeof r.op_id === 'string' ? r.op_id : null,
    after: (entity === 'devices' || entity === 'users') && scope.omitIds === true
      ? withoutIds(entity === 'devices' && scope.keys !== true ? withoutKeys(parseJson(r.after_json)) : parseJson(r.after_json))
      : entity === 'devices' && scope.keys !== true
      ? withoutKeys(parseJson(r.after_json))
      : entity === 'finance:entry' && scope.financeWrite !== true
        ? withoutPhoto(parseJson(r.after_json))
        : entity === 'content:penceramah' && scope.contentWrite !== true
          ? withoutPhone(parseJson(r.after_json))
          : parseJson(r.after_json),
    ...(stamps !== null && typeof stamps === 'object' && !Array.isArray(stamps) ? { stamps: stamps as FeedEntry['stamps'] } : {}),
  };
}

/** The highest visible change_log id (0 when none). */
function headOf(db: DatabaseSync, scope: FeedScope): number {
  const row = db.prepare(`SELECT MAX(id) AS head FROM change_log WHERE ${entityPredicate(scope)}`).get();
  return row !== undefined && row.head !== null && row.head !== undefined ? Number(row.head) : 0;
}

/** Changes after `since`, in id order, at most `limit`; entries, `next` and `head` come from one read snapshot. */
export function readFeed(db: DatabaseSync, since: number, limit = DEFAULT_LIMIT, scope: FeedScope, maxBytes?: number): Feed {
  const from = Number.isInteger(since) && since > 0 ? since : 0;
  const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 5000) : DEFAULT_LIMIT;
  return inSnapshot(db, () => {
    const rows = db
      .prepare(`SELECT * FROM change_log WHERE id > ? AND ${entityPredicate(scope)} ORDER BY id LIMIT ?`)
      .all(from, max + 1);
    if (maxBytes === undefined) {
      const more = rows.length > max;
      const entries = rows.slice(0, max).map((r) => toEntry(r, scope));
      return {
        entries,
        next: more ? entries[entries.length - 1]!.seq : null,
        head: headOf(db, scope),
      };
    }
    // Cut by serialized size too: the page the reader accepts is capped in bytes, and an over-size page would be
    // refused every time. An entry larger than the cap alone cannot be delivered, so it is logged and passed over
    // (the cursor still moves).
    const entries: FeedEntry[] = [];
    let bytes = 0;
    let consumed = 0;
    let lastSeq = from;
    for (const r of rows.slice(0, max)) {
      const e = toEntry(r, scope);
      const size = Buffer.byteLength(JSON.stringify(e)) + 1;
      if (size > maxBytes) {
        console.warn(`Sync feed: entry ${e.entity} (seq ${e.seq}) is ${size} bytes, over the ${maxBytes} byte page limit; skipped`);
      } else {
        if (bytes + size > maxBytes && entries.length > 0) break;
        bytes += size;
        entries.push(e);
      }
      consumed++;
      lastSeq = e.seq;
    }
    return { entries, next: rows.length > consumed ? lastSeq : null, head: headOf(db, scope) };
  });
}

function parseRoles(v: unknown): unknown[] {
  const parsed = parseJson(v);
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * The whole current state for a first sync: settings, live items per kind, tombstones within the retention window,
 * users and devices when in scope, the public surau info. `seq` is the same head `readFeed` reports, read in
 * the same snapshot as the data. Secrets (PIN hashes, device keys) are never included.
 */
export function snapshot(
  db: DatabaseSync,
  scope: FeedScope,
  opts: { boxId: string; now?: Date; role?: 'box' | 'cloud' },
): Snapshot {
  const now = opts.now ?? new Date();
  // the surau is the scope's, so the data and the `seq` (the head of the same scope) can never disagree
  const surauId = scopeSurau(scope);
  const withStar = scope.keys === true || scope.star === true;
  // Tombstones travel for as long as the change history is kept (one window, see trim.ts `retentionDays`), so a
  // snapshot never loses a delete the feed could still replay.
  const cutoff = new Date(now.getTime() - retentionDays(db, opts.role ?? 'box') * 86_400_000).toISOString();
  return inSnapshot(db, () => {
    const seq = headOf(db, scope);

    const settings: Record<string, unknown> = {};
    const settingsMeta: NonNullable<Snapshot['settingsMeta']> = {};
    for (const r of db.prepare('SELECT feature, json, rev, edited_at, updated_at FROM settings WHERE surau_id = ? ORDER BY feature').all(surauId)) {
      const v = parseJson(r.json);
      if (v === null) continue;
      const feature = String(r.feature);
      settings[feature] = v;
      const editedAt = typeof r.edited_at === 'string' ? r.edited_at : String(r.updated_at);
      settingsMeta[feature] = {
        editedAt,
        rev: typeof r.rev === 'string' ? r.rev : `${editedAt}|local`,
        stamps: readFieldStamps(db, feature, surauId),
      };
    }

    const content: Record<string, unknown[]> = {};
    for (const kind of CONTENT_KINDS) content[kind] = [];
    for (const r of db
      .prepare('SELECT kind, id, json, deleted_at FROM content_items WHERE surau_id = ? ORDER BY kind, id')
      .all(surauId)) {
      const list = content[String(r.kind)];
      if (list === undefined) continue;
      if (r.deleted_at === null || r.deleted_at === undefined) {
        const item = parseJson(r.json);
        if (item !== null) list.push(String(r.kind) === 'penceramah' && scope.contentWrite !== true ? withoutPhone(item) : item);
      } else if (String(r.deleted_at) >= cutoff) {
        list.push({ id: String(r.id), deletedAt: String(r.deleted_at) });
      }
    }

    const out: Snapshot = {
      // the wire value phones sign ops with (Plan 14 section 3.1: `sdm`, "my own surau", until a version floor)
      surauId: LOCAL_SURAU_ID,
      boxId: opts.boxId,
      seq,
      settings,
      content,
      settingsMeta,
      surauInfo: surauPublicInfo(db, undefined, surauId),
      serverTime: now.toISOString(),
      prayer: {
        official: officialZones(db, surauId).flatMap((zone) => officialYears(db, zone, surauId).map((y) => ({ zone, year: y.year, days: y.days, fetchedAt: y.fetchedAt }))),
        imports: snapshotImports(db, surauId),
        corrections: snapshotCorrections(db, surauId),
      },
    };
    if (scope.finance === true) {
      const entries = allEntries(db, surauId);
      out.finance = {
        funds: listFunds(db, { includeArchived: true }, surauId),
        perihal: listPerihal(db, { includeArchived: true }, surauId),
        entries: scope.financeWrite === true ? entries : entries.map((e) => ({ ...e, photoId: null })),
        months: listMonths(db, surauId).map((m) => {
          const st = db.prepare('SELECT edited_at, rev FROM finance_months WHERE surau_id = ? AND ym = ?').get(surauId, m.ym);
          return {
            ...m,
            ...(typeof st?.edited_at === 'string' ? { editedAt: st.edited_at } : {}),
            ...(typeof st?.rev === 'string' ? { rev: st.rev } : {}),
          };
        }),
        photos: scope.financeWrite === true ? listPhotoMeta(db, surauId) : [],
      };
    }
    if (scope.users) {
      out.users = db
        .prepare(`SELECT id, name, roles_json, active, created_at, rev, edited_at, no, no_src, surau_id, deleted_at, phone FROM users WHERE surau_id IN (?, ?) ORDER BY created_at, id`)
        .all(surauId, withStar ? '*' : surauId)
        .map((r) => {
          const editedAt = typeof r.edited_at === 'string' ? r.edited_at : String(r.created_at);
          return {
            id: String(r.id),
            name: String(r.name),
            roles: parseRoles(r.roles_json),
            active: Number(r.active) === 1,
            createdAt: String(r.created_at),
            editedAt,
            rev: typeof r.rev === 'string' ? r.rev : `${editedAt}|local`,
            ...(scope.omitIds === true ? {} : { ref: refOfRow(r, 'user') }),
            ...(typeof r.deleted_at === 'string' ? { deleted: true } : {}),
            // personal data: only for the surau's own people (never a Pentadbir MAXCOM's), and only to who may manage users
            ...(typeof r.phone === 'string' && String(r.surau_id) !== '*' ? { phone: r.phone } : {}),
          };
        });
    }
    if (scope.devices) {
      out.devices = db
        .prepare(`SELECT id, user_id, name, platform, enrolled_at, revoked_at, public_jwk, no, no_src, surau_id FROM devices WHERE surau_id IN (?, ?)${withStar ? '' : " AND user_id NOT IN (SELECT id FROM users WHERE surau_id = '*')"} ORDER BY enrolled_at, id`)
        .all(surauId, withStar ? '*' : surauId)
        .map((r) => {
          const out: Record<string, unknown> = {
            id: String(r.id),
            userId: String(r.user_id),
            name: String(r.name),
            platform: String(r.platform),
            enrolledAt: String(r.enrolled_at),
            revokedAt: typeof r.revoked_at === 'string' ? r.revoked_at : null,
            ...(scope.omitIds === true ? {} : { ref: refOfRow(r, 'device') }),
          };
          // The public key, for the site scope only; a device without a key (a kiosk) has none to give.
          if (scope.keys === true) {
            const jwk = parseJson(r.public_jwk);
            if (typeof jwk === 'object' && jwk !== null && !Array.isArray(jwk)) out.publicJwk = jwk;
          }
          return out;
        });
    }
    return out;
  });
}
