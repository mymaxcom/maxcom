import type { DatabaseSync } from 'node:sqlite';
import type { FeedEntry } from '@surau/core';
import { assignNewNo, incomingNo, numberTaken } from '../auth/ids.ts';
import { AuthError, getUserRow, logChange, putUserSynced, revokeDeviceRow, tx } from '../auth/users.ts';
import { bumpVersion } from '../settingsStore.ts';
import { LINK_ID_RE } from '../link/journal.ts';
import { applyFeedEntry } from './apply.ts';
import type { ChangeMeta } from './meta.ts';
import { verifySiteEntry } from './verify.ts';

/**
 * Reset-from-box on the cloud (multi-box 2B, B3; contract `2026-11-23-cloud-sleep-reset-contract.md`). After a box
 * restored a backup or adopted another box's store, the cloud copy of its surau has moved on; the box sends its whole
 * state and the cloud makes that surau equal to it, in ONE transaction, that surau only.
 *
 * The state is the box's feed: one entry per row, the same shape a sync push carries, checked by the same
 * `verifySiteEntry` and written by the same `applyFeedEntry` (so every rule of a push holds: no superadmin or ops
 * person, no PIN hash, no app lock, a device key never replaced, a device homed at the sending box only). What differs
 * from a push is that the surau's replaceable rows are removed first, so the box's rows are the whole of them:
 *
 * - content, settings (not `appLock`), prayer imports / file days / corrections, finance months: replaced.
 * - finance funds and perihal: replaced, except a row a kept ledger entry still names (entries are never removed).
 * - finance entries and photos: the box's missing ones are inserted; none is removed or changed (operator, 23 Nov).
 * - people: the state's are upserted under the merge rule; the surau's others are deleted the way the feed deletes a
 *   person (their devices revoked). `'*'` rows are never touched.
 * - devices: the state's are enrolled / renamed / revoked; the surau's others are revoked.
 * - `surau_assets`: rows not in the state's list are dropped; a listed id the surau does not already hold is NOT
 *   granted here (a hash is never a licence to read): it is answered back as `missing` and the box uploads the bytes.
 *
 * Op ids are dropped from the entries: the replay table keeps protecting the signed device ops it recorded, and a
 * reset never collides with it. One `change_log` marker row closes the reset and becomes the surau's log floor.
 */

export const RESET_ENTRY_MAX = 200_000;
export const RESET_ASSET_MAX = 50_000;
const RESET_REASONS = new Set(['restore', 'adopt', 'reduce']);
const ASSET_ID_RE = /^[0-9a-f]{64}$/;
/** Entities a reset carries (prayer:official is the cloud's own fetch, never replaced from a box). */
const RESET_ENTITY_RE = /^(content:[A-Za-z0-9_-]{1,40}|settings|user|device|prayer:(?:import|correction)|finance:(?:entry|fund|perihal|month|photo))$/;

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface ResetBody {
  linkId: string;
  reason: 'restore' | 'adopt';
  entries: FeedEntry[];
  assets: string[];
}

export class ResetRefused extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string | undefined;
  constructor(status: number, code: string, detail?: string) {
    super(code);
    this.name = 'ResetRefused';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** Strict parse of the body. Throws `ResetRefused(400, 'bad_state', <first failing part>)`. */
export function parseResetBody(raw: unknown, site: { boxId: string; surauId: string }): ResetBody {
  const bad = (detail: string): never => {
    throw new ResetRefused(400, 'bad_state', detail);
  };
  if (!isPlain(raw)) return bad('body');
  for (const k of Object.keys(raw)) if (k !== 'linkId' && k !== 'reason' && k !== 'state') bad('body');
  if (typeof raw.linkId !== 'string' || !LINK_ID_RE.test(raw.linkId)) bad('linkId');
  if (typeof raw.reason !== 'string' || !RESET_REASONS.has(raw.reason)) bad('reason');
  const state = raw.state;
  if (!isPlain(state)) return bad('state');
  for (const k of Object.keys(state)) if (k !== 'entries' && k !== 'assets') bad('state');
  if (!Array.isArray(state.entries) || state.entries.length > RESET_ENTRY_MAX) bad('entries');
  if (!Array.isArray(state.assets) || state.assets.length > RESET_ASSET_MAX) bad('assets');
  const assets = new Set<string>();
  (state.assets as unknown[]).forEach((a, i) => {
    if (typeof a !== 'string' || !ASSET_ID_RE.test(a)) bad(`assets[${i}]`);
    assets.add(a as string);
  });
  const entries: FeedEntry[] = [];
  const seen = new Set<string>();
  (state.entries as unknown[]).forEach((e, i) => {
    const v = verifySiteEntry(site, { surauId: site.surauId }, e);
    if (!v.ok) return bad(`entries[${i}]:${v.detail}`);
    if (!RESET_ENTITY_RE.test(v.entry.entity)) return bad(`entries[${i}]:entity`);
    // one row, one entry: two entries for the same row would make the result depend on their order
    const key = `${v.entry.entity}\u0000${v.entry.entityId}`;
    if (seen.has(key)) return bad(`entries[${i}]:twice`);
    seen.add(key);
    entries.push({ ...v.entry, opId: null });
  });
  return { linkId: raw.linkId as string, reason: raw.reason as 'restore' | 'adopt', entries, assets: [...assets] };
}

/**
 * A person or device id of the state that the cloud holds under another surau (or `'*'`): refused before anything,
 * `foreign_id` (409). A device entry naming a foreign person is refused the same way.
 */
export function foreignIdIn(db: DatabaseSync, surauId: string, entries: readonly FeedEntry[]): boolean {
  const ownerOf = (table: 'users' | 'devices', id: string): string | null => {
    const r = db.prepare(`SELECT surau_id FROM ${table} WHERE id = ?`).get(id);
    return r === undefined ? null : String(r.surau_id);
  };
  for (const e of entries) {
    if (e.entity === 'user') {
      const o = ownerOf('users', e.entityId);
      if (o !== null && o !== surauId) return true;
    } else if (e.entity === 'device') {
      const o = ownerOf('devices', e.entityId);
      if (o !== null && o !== surauId) return true;
      const uid = isPlain(e.after) ? e.after.userId : undefined;
      if (typeof uid === 'string') {
        const u = ownerOf('users', uid);
        if (u !== null && u !== surauId) return true;
      }
    }
  }
  return false;
}

export interface ResetCounts {
  applied: number;
  duplicate: number;
  superseded: number;
  peopleRemoved: number;
  devicesRevoked: number;
  assetsDropped: number;
  financeKept: number;
}

export interface ResetOutcome {
  seq: number;
  missing: string[];
  counts: ResetCounts;
}

/** Order of apply: what other rows point at comes first (people before devices, funds before entries). */
function rank(entity: string): number {
  if (entity === 'user') return 0;
  if (entity === 'device') return 1;
  if (entity === 'finance:fund' || entity === 'finance:perihal') return 2;
  if (entity === 'finance:entry') return 3;
  if (entity === 'finance:photo' || entity === 'finance:month') return 4;
  if (entity === 'prayer:import') return 5;
  return 6;
}

/**
 * Make the surau equal to the box's state. One transaction: on any refusal nothing is kept and `ResetRefused` is
 * thrown (`bad_state` with the failing entry, or `last_admin`). The caller has already checked the signature, the
 * sleep, the open live, the daily limit and foreign ids, and written the backup.
 */
export function applyReset(
  db: DatabaseSync,
  p: { surauId: string; boxId: string; body: ResetBody; now: Date; dataDir: string },
): ResetOutcome {
  const { surauId, boxId, body, now } = p;
  const nowIso = now.toISOString();
  const origin = `box:${boxId}`;
  const actor = `site:${boxId}`;
  const meta: ChangeMeta = { origin, editedAt: nowIso, syncedAt: nowIso, trusted: true };
  const entries = [...body.entries].sort((a, b) => rank(a.entity) - rank(b.entity));
  const ids = (entity: string): Set<string> => new Set(entries.filter((e) => e.entity === entity).map((e) => e.entityId));

  return tx(db, () => {
    // parents may be removed and put back within the transaction; the keys are checked at COMMIT
    db.exec('PRAGMA defer_foreign_keys = ON');
    const counts: ResetCounts = { applied: 0, duplicate: 0, superseded: 0, peopleRemoved: 0, devicesRevoked: 0, assetsDropped: 0, financeKept: 0 };

    // ---- 1. remove what is replaced --------------------------------------------------------------------------------
    db.prepare('DELETE FROM content_items WHERE surau_id = ?').run(surauId);
    db.prepare("DELETE FROM settings WHERE surau_id = ? AND feature <> 'appLock'").run(surauId);
    db.prepare('DELETE FROM prayer_file_days WHERE surau_id = ?').run(surauId);
    db.prepare('DELETE FROM prayer_imports WHERE surau_id = ?').run(surauId);
    db.prepare('DELETE FROM prayer_corrections WHERE surau_id = ?').run(surauId);
    db.prepare('DELETE FROM finance_months WHERE surau_id = ?').run(surauId);
    const keptRefs = (sql: string): Set<string> => new Set(db.prepare(sql).all(surauId).map((r) => String(r.id)));
    const fundRefs = keptRefs(
      `SELECT fund_id AS id FROM finance_entries WHERE surau_id = ? UNION SELECT to_fund_id FROM finance_entries WHERE surau_id = ?1 AND to_fund_id IS NOT NULL`,
    );
    const perihalRefs = keptRefs('SELECT perihal_id AS id FROM finance_entries WHERE surau_id = ? AND perihal_id IS NOT NULL');
    const stateFunds = ids('finance:fund');
    const statePerihal = ids('finance:perihal');
    for (const r of db.prepare('SELECT id FROM finance_funds WHERE surau_id = ?').all(surauId)) {
      const id = String(r.id);
      if (stateFunds.has(id) || !fundRefs.has(id)) db.prepare('DELETE FROM finance_funds WHERE surau_id = ? AND id = ?').run(surauId, id);
      else counts.financeKept += 1;
    }
    for (const r of db.prepare('SELECT id FROM finance_perihal WHERE surau_id = ?').all(surauId)) {
      const id = String(r.id);
      if (statePerihal.has(id) || !perihalRefs.has(id)) db.prepare('DELETE FROM finance_perihal WHERE surau_id = ? AND id = ?').run(surauId, id);
      else counts.financeKept += 1;
    }

    // The box state's numbers win over the surau's old ones: a box-series number (`U-0001`) that another row of the
    // state carries, or that the row's own state entry changes, is released here, so the push rule that refuses a
    // number another row holds (`id_taken`) never meets this surau's own old rows. Rows of other suraus are never reached.
    const claims = { users: new Map<string, number>(), devices: new Map<string, number>() };
    for (const e of entries) {
      if ((e.entity !== 'user' && e.entity !== 'device') || !isPlain(e.after)) continue;
      const inc = incomingNo(e.after.no, e.after.noSrc);
      if (inc !== null && inc.src === 'b') (e.entity === 'user' ? claims.users : claims.devices).set(e.entityId, inc.no);
    }
    const released = { users: new Set<string>(), devices: new Set<string>() };
    for (const table of ['users', 'devices'] as const) {
      const claimed = claims[table];
      const claimedNos = new Set(claimed.values());
      for (const r of db.prepare(`SELECT id, no FROM ${table} WHERE surau_id = ? AND no_src = 'b' AND no IS NOT NULL`).all(surauId)) {
        const id = String(r.id);
        const own = claimed.get(id);
        const release = own !== undefined ? own !== Number(r.no) : claimedNos.has(Number(r.no));
        if (release) {
          db.prepare(`UPDATE ${table} SET no = NULL, no_src = NULL WHERE id = ? AND surau_id = ?`).run(id, surauId);
          released[table].add(id);
        }
      }
    }

    // ---- 2. the box's rows, through the push rules ------------------------------------------------------------------
    entries.forEach((e) => {
      const r = applyFeedEntry(db, e, { now, origin, actor: e.actor, dataDir: p.dataDir, acceptDeviceEnrolment: true, siteBoxId: boxId, role: 'cloud', surauId });
      if (r.status === 'applied') counts.applied += 1;
      else if (r.status === 'duplicate') counts.duplicate += 1;
      else if (r.status === 'superseded') counts.superseded += 1;
      // a revocation of a device the cloud never saw is remembered by apply, and is nothing to refuse here
      else if (!(e.entity === 'device' && r.reason === 'device_unknown')) {
        throw new ResetRefused(r.reason === 'last_admin' ? 409 : 400, r.reason === 'last_admin' ? 'last_admin' : 'bad_state', `${e.entity}:${e.entityId}:${r.reason ?? 'invalid'}`);
      }
    });

    // a state row whose number was released above and that the push rules left without one (its entry was not newer
    // than the row) takes the number its entry carries; nothing else of the surau holds it any more
    for (const table of ['users', 'devices'] as const) {
      for (const [id, no] of claims[table]) {
        const row = db.prepare(`SELECT no FROM ${table} WHERE id = ? AND surau_id = ?`).get(id, surauId);
        if (row === undefined || row.no !== null) continue;
        if (!numberTaken(db, surauId, table === 'users' ? 'user' : 'device', 'b', no, id)) {
          db.prepare(`UPDATE ${table} SET no = ?, no_src = 'b' WHERE id = ? AND surau_id = ? AND no IS NULL`).run(no, id, surauId);
        }
      }
    }

    // a row released only because another state id took its number, present in the state without a number of its own,
    // is still without one here: the ordinary number assigner gives it the next free one
    for (const table of ['users', 'devices'] as const) {
      const kind = table === 'users' ? 'user' : 'device';
      const inState = ids(kind);
      for (const id of released[table]) {
        if (!inState.has(id) || claims[table].has(id)) continue;
        const row = db.prepare(`SELECT no FROM ${table} WHERE id = ? AND surau_id = ?`).get(id, surauId);
        if (row !== undefined && row.no === null) assignNewNo(db, kind, id, surauId);
      }
    }

    // ---- 3. people and devices the box no longer has -----------------------------------------------------------------
    const stateUsers = ids('user');
    const stateDevices = ids('device');
    for (const r of db.prepare('SELECT id FROM devices WHERE surau_id = ? AND revoked_at IS NULL').all(surauId)) {
      const id = String(r.id);
      if (stateDevices.has(id)) continue;
      if (revokeDeviceRow(db, id, actor, nowIso, meta)) counts.devicesRevoked += 1;
    }
    for (const r of db.prepare('SELECT id FROM users WHERE surau_id = ? AND deleted_at IS NULL').all(surauId)) {
      const id = String(r.id);
      if (stateUsers.has(id)) continue;
      const u = getUserRow(db, id);
      if (u === undefined) continue;
      try {
        putUserSynced(db, id, { name: u.name, roles: u.roles, active: false, deleted: true }, actor, meta, surauId);
      } catch (error) {
        if (error instanceof AuthError && error.code === 'last_admin') throw new ResetRefused(409, 'last_admin', `user:${id}`);
        throw error;
      }
      counts.peopleRemoved += 1;
    }

    // ---- 4. assets: drop what the box no longer lists; never grant one by its hash --------------------------------
    const listed = new Set(body.assets);
    const held = new Set(db.prepare('SELECT asset_id FROM surau_assets WHERE surau_id = ?').all(surauId).map((r) => String(r.asset_id)));
    for (const id of held) {
      if (listed.has(id)) continue;
      db.prepare('DELETE FROM surau_assets WHERE surau_id = ? AND asset_id = ?').run(surauId, id);
      counts.assetsDropped += 1;
    }
    const missing = body.assets.filter((id) => !held.has(id));

    // ---- 5. the marker, the surau's log floor, the audit ------------------------------------------------------------
    logChange(db, actor, 'surau', surauId, undefined, { event: 'reset', reason: body.reason, linkId: body.linkId, counts }, { origin: 'cloud', editedAt: nowIso }, surauId);
    const seq = Number(db.prepare('SELECT MAX(id) AS n FROM change_log').get()?.n ?? 0);
    db.prepare('UPDATE suraus SET log_floor = ? WHERE id = ?').run(seq, surauId);
    bumpVersion(db, surauId);
    return { seq, missing, counts };
  });
}
