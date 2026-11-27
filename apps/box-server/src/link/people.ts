import type { DatabaseSync } from 'node:sqlite';
import { OPS_ROLES, getsTicket, parseLinkPeople, planMerge } from '@surau/core';
import type { KeptPerson, LinkPerson, MergePlan, Role } from '@surau/core';
import { sha256hex } from '../auth/crypto.ts';
import { newCode, normaliseCode } from '../auth/devices.ts';
import { authLog } from '../auth/sessions.ts';
import {
  activeAdminCount, bumpFor, createUserIn, deleteUserRows, getUserRow, logChange, parseRoles, snapshot, stampRow,
} from '../auth/users.ts';

/**
 * The people part of a link on this box (phase 2C). SECURITY code: a merge creates accounts with roles on the master.
 * The rules (who is the same person, which role stays) are in `@surau/core` `planMerge`; this file reads and writes
 * the database. Plan: section 5 "People (L5)" and section 6 "Merge of users and PINs".
 *
 * - `ownPeople`: the list this box sends: active, not deleted people of its surau, no ops role, no secrets.
 * - `applyMerge`: inside the caller's transaction (the one that makes the follower's rows), so a failure rolls both
 *   back together. Returns the phone-move tickets (plain codes) to hand to the follower inside the sealed commit.
 * - `undoMerge`: a link that fails AFTER that transaction (the follower did not take the commit) takes it back.
 */

/** Phone-move tickets work for 30 days; after that an admin gives a normal join code (plan L8). */
export const TICKET_TTL_MS = 30 * 24 * 3600_000;
const LIVE_PHONES = "SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND revoked_at IS NULL AND public_jwk IS NOT NULL AND platform <> 'kiosk'";

function peopleRows(db: DatabaseSync, surauId: string): Record<string, unknown>[] {
  return db.prepare('SELECT * FROM users WHERE surau_id = ? AND active = 1 AND deleted_at IS NULL ORDER BY created_at, id').all(surauId);
}

/** What this box tells the other box about its people at the questions step. */
export function ownPeople(db: DatabaseSync, surauId: string): LinkPerson[] {
  const out: LinkPerson[] = [];
  for (const r of peopleRows(db, surauId)) {
    const roles = parseRoles(r.roles_json);
    // the hidden Pentadbir MAXCOM and support never cross; a person holding an ops role is filed under '*' anyway
    if (roles.some((x) => OPS_ROLES.includes(x))) continue;
    const devices = Math.min(50, Number(db.prepare(LIVE_PHONES).get(String(r.id))?.n ?? 0));
    const phone = typeof r.phone === 'string' && r.phone.length > 0 ? r.phone : null;
    out.push({ id: String(r.id), name: String(r.name).slice(0, 80), phone, roles, devices });
  }
  // the list is checked by the same strict parse the other box runs: a name the parse refuses is not sent
  return out.filter((p) => parseLinkPeople([p]) !== null).slice(0, 500);
}

/** The kept data's people as the merge compares them (any active, not deleted person; phones matched whole). */
export function keptPeople(db: DatabaseSync, surauId: string): KeptPerson[] {
  return peopleRows(db, surauId).map((r) => ({
    id: String(r.id), name: String(r.name), roles: parseRoles(r.roles_json),
    phone: typeof r.phone === 'string' && r.phone.length > 0 ? r.phone : null,
  }));
}

export interface MergeInput {
  linkId: string;
  surauId: string;
  /** The follower box: where the people came from. */
  fromBoxId: string;
  fromName: string;
  other: readonly LinkPerson[];
  answers: { roles: Record<string, string>; same: readonly string[]; phones?: 'direct' | 'code' };
  /** The admin who made the link on this box: the merged accounts are made in their name. */
  owner: string;
  now: Date;
}

export interface MergeResult {
  plan: MergePlan;
  /** Plain one-time codes by the person's id on the follower; only their hashes are stored here. */
  tickets: Record<string, string>;
  ticketsExpireAt: string;
}

/** Merge the follower's people into this box. The caller owns the transaction. Throws to stop the link. */
export function applyMerge(db: DatabaseSync, m: MergeInput): MergeResult {
  const plan = planMerge(keptPeople(db, m.surauId), m.other, m.answers);
  const actor = `user:${m.owner}`;
  const at = m.now.toISOString();
  const expiresAt = new Date(m.now.getTime() + TICKET_TTL_MS).toISOString();
  const tickets: Record<string, string> = {};
  const mark = db.prepare(
    'INSERT INTO link_people (link_id, user_id, from_box_id, peer_user_id, action, roles_before_json, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const step of plan.steps) {
    let userId: string;
    if (step.kind === 'create') {
      userId = createUserIn(db, { name: step.person.name, roles: step.roles, phone: step.person.phone }, actor, m.surauId).id;
      mark.run(m.linkId, userId, m.fromBoxId, step.person.id, 'created', null, at);
      authLog(db, m.now, 'link-merge', true, { userId, detail: `created ${m.linkId.slice(0, 8)}` });
    } else if (step.kind === 'same-phone' && step.added !== null) {
      userId = step.kept.id;
      const before = getUserRow(db, userId);
      if (before === undefined || before.deleted || !before.active) throw new Error('link: kept person changed during the link');
      setRolesIn(db, userId, [...before.roles, step.added], actor);
      mark.run(m.linkId, userId, m.fromBoxId, step.person.id, 'role', JSON.stringify(before.roles), at);
      authLog(db, m.now, 'link-merge', true, { userId, detail: `role ${step.added} ${m.linkId.slice(0, 8)}` });
    } else {
      userId = step.kept.id;
      mark.run(m.linkId, userId, m.fromBoxId, step.person.id, 'same', null, at);
    }
    if (getsTicket(step, m.answers.phones ?? 'code')) {
      const code = newCode();
      db.prepare('INSERT INTO enrolments (code_hash, user_id, device_name, expires_at, created_by, ops) VALUES (?, ?, ?, ?, ?, 0)')
        .run(sha256hex(normaliseCode(code)), userId, `Telefon dari ${m.fromName}`.slice(0, 80), expiresAt, `link:${m.linkId}`);
      tickets[step.person.id] = code;
    }
  }
  // The surau is never left without an administrator (true in case S, where the master keeps its own admins).
  if (activeAdminCount(db, m.surauId) < 1) throw new Error('link: no administrator after the merge');
  return { plan, tickets, ticketsExpireAt: expiresAt };
}

/** Takes back what `applyMerge` did for this link. The caller owns the transaction. */
export function undoMerge(db: DatabaseSync, linkId: string, actor: string, now: Date): void {
  const at = now.toISOString();
  // The tickets first: soft-deleting a person below also ends their open codes (marks them used), which would leave
  // this link's tickets behind as dead rows.
  db.prepare('DELETE FROM enrolments WHERE created_by = ? AND used_at IS NULL').run(`link:${linkId}`);
  const rows = db.prepare('SELECT user_id, action, roles_before_json FROM link_people WHERE link_id = ?').all(linkId);
  for (const r of rows) {
    const userId = String(r.user_id);
    const u = getUserRow(db, userId);
    if (u === undefined) continue;
    if (r.action === 'created' && !u.deleted) deleteUserRows(db, userId, actor, at);
    if (r.action === 'role') setRolesIn(db, userId, parseRoles(r.roles_before_json), actor);
  }
  db.prepare('DELETE FROM link_people WHERE link_id = ?').run(linkId);
}

/** `setRoles` for a caller that owns the transaction. Never gives or takes an ops role (the merge cannot carry one). */
function setRolesIn(db: DatabaseSync, id: string, roles: Role[], actor: string): void {
  const before = getUserRow(db, id);
  if (before === undefined) throw new Error('link: no such person');
  const clean = [...new Set(roles)].filter((r) => !OPS_ROLES.includes(r));
  if (before.roles.some((r) => OPS_ROLES.includes(r))) throw new Error('link: an ops account is never changed by a link');
  db.prepare('UPDATE users SET roles_json = ? WHERE id = ?').run(JSON.stringify(clean), id);
  stampRow(db, 'users', id);
  const after = getUserRow(db, id)!;
  logChange(db, actor, 'users', id, snapshot(before), snapshot(after), undefined, after.surauId);
  bumpFor(db, after.surauId);
}
