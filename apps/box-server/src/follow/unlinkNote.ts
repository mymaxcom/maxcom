import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { holdsSurauAdmin } from '@surau/core';
import type { BoxQrPub } from '@surau/core';
import { appLockRequiredFor } from '../auth/appLock.ts';
import { sha256hex } from '../auth/crypto.ts';
import { normaliseCode } from '../auth/devices.ts';
import { secretDir } from '../auth/secrets.ts';
import { bumpFor, createUserIn, getUserRow, logChange, parseRoles, snapshot, stampRow, tx } from '../auth/users.ts';
import type { PinnedClient } from '../link/peerClient.ts';
import { signLink } from '../link/sign.ts';
import type { OrderSecret } from '../link/unlink.ts';
import type { BoxIdentity } from '../setup/identity.ts';
import { openWithBoxKey, sealToBoxKey, sealedRe } from '../sync/boxSeal.ts';
import type { FollowRecord } from './store.ts';

/**
 * The follower's side of an unlink (multi-box phase 2D). SECURITY code: it makes a Pentadbir and a join code on the
 * box that leaves.
 *
 * When the master's signed order (`orders.ts`) is taken, the box keeps this note, sealed to its own identity key and
 * OUTSIDE the store (`secret/unlink-note.json`; a restore swaps the store and removes the follow record, the note
 * stays). At the first start on its new store (`applyUnlinkNote`, after the restore's revocation of every phone) the
 * person who answered for this box is made, or found, as its Pentadbir and given the one-time join code whose hash the
 * order carried; their phone joins with it and sets a PIN. Then the box tells the master once, signed with its own
 * identity key (`unlink-report` `joined`), and drops the note. While the note is there the TV says the link was cut
 * and the box's Pentadbir has to join.
 */
export const UNLINK_NOTE_REL = 'secret/unlink-note.json';
const FILE = 'unlink-note.json';
const LABEL = 'maxcom-unlink-note-v1';
const SEALED = sealedRe(32 * 1024);
/** After the ticket ran out the note waits one more day for the master, then goes. */
const GRACE_MS = 24 * 3600_000;

export interface UnlinkNote {
  v: 1;
  unlinkId: string;
  linkId: string;
  choice: 'back' | 'carry-on';
  person: OrderSecret['person'];
  ticketHash: string;
  ticketExpiresAt: string;
  dropYoutube: boolean;
  master: { boxId: string; name: string; pub: BoxQrPub; ca: string; addresses: string[] };
  /** Set at the first start on the new store, with the person who got the code. */
  applied: boolean;
  userId: string | null;
  /** Carry-on: the master was told the copy landed (`copied`); it waits for that before the join. Back: always true. */
  copied?: boolean;
}

export function noteFromOrder(rec: FollowRecord, unlinkId: string, s: OrderSecret): UnlinkNote {
  return {
    v: 1, unlinkId, linkId: rec.linkId, choice: s.choice, person: s.person, ticketHash: sha256hex(normaliseCode(s.ticket)),
    ticketExpiresAt: s.ticketExpiresAt, dropYoutube: s.dropYoutube,
    master: {
      boxId: rec.masterBoxId, name: rec.masterName, pub: rec.masterPub, ca: rec.masterCa,
      addresses: [...new Set([...s.master.addresses, ...rec.addresses])].slice(0, 8),
    },
    applied: false, userId: null, copied: s.choice !== 'carry-on',
  };
}

const aadOf = (boxId: string): string => `unlink-note|${boxId}`;

export function readUnlinkNote(dataDir: string, identity: BoxIdentity, boxId: string): UnlinkNote | null {
  try {
    const sealed = (JSON.parse(readFileSync(join(secretDir(dataDir), FILE), 'utf8')) as { sealed?: unknown }).sealed;
    const n = JSON.parse(openWithBoxKey(identity.privateJwk, String(sealed), LABEL, aadOf(boxId), SEALED)) as UnlinkNote;
    return n !== null && typeof n === 'object' && n.v === 1 && typeof n.unlinkId === 'string' && typeof n.ticketHash === 'string' ? n : null;
  } catch {
    return null;
  }
}

export function writeUnlinkNote(dataDir: string, identity: BoxIdentity, boxId: string, n: UnlinkNote): void {
  mkdirSync(secretDir(dataDir), { recursive: true });
  const path = join(secretDir(dataDir), FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, sealed: sealToBoxKey(identity.publicJwk, JSON.stringify(n), LABEL, aadOf(boxId)) }), { mode: 0o600 });
  renameSync(tmp, path);
}

export function clearUnlinkNote(dataDir: string): void {
  rmSync(join(secretDir(dataDir), FILE), { force: true });
}

export const unlinkNotePresent = (dataDir: string): boolean => existsSync(join(secretDir(dataDir), FILE));

const YOUTUBE_FILES = ['secret/youtube-token.json', 'secret/youtube-state.json', 'live/youtube-open.json'];

/**
 * The first start on the new store: the answering person is this box's Pentadbir and holds the join code. Repeats
 * safely (the note is marked only after the transaction). Returns the person's id, or null when there is no note.
 */
export function applyUnlinkNote(db: DatabaseSync, dataDir: string, identity: BoxIdentity, boxId: string, surauId: string, now: Date): string | null {
  const n = readUnlinkNote(dataDir, identity, boxId);
  if (n === null || n.applied) return null;
  // a note whose join code ran out was left by a leave that never finished: it makes nobody Pentadbir
  if (!(Date.parse(n.ticketExpiresAt) > now.getTime())) {
    clearUnlinkNote(dataDir);
    return null;
  }
  const actor = 'system:unlink';
  const at = now.toISOString();
  const userId = tx(db, () => {
    const active = (id: string): boolean => db.prepare('SELECT 1 AS x FROM users WHERE id = ? AND surau_id = ? AND active = 1 AND deleted_at IS NULL').get(id, surauId) !== undefined;
    let id: string | null = n.person.peerUserId !== null && active(n.person.peerUserId) ? n.person.peerUserId : null;
    if (id === null && n.person.phone !== null) {
      const r = db.prepare('SELECT id FROM users WHERE phone = ? AND surau_id = ? AND active = 1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1').get(n.person.phone, surauId);
      id = r === undefined ? null : String(r.id);
    }
    if (id === null) {
      id = createUserIn(db, { name: n.person.name.slice(0, 80), roles: ['admin'], phone: n.person.phone }, actor, surauId).id;
    } else {
      const before = getUserRow(db, id)!;
      if (!holdsSurauAdmin(before.roles)) {
        db.prepare('UPDATE users SET roles_json = ? WHERE id = ?').run(JSON.stringify([...before.roles, 'admin']), id);
        stampRow(db, 'users', id);
        logChange(db, actor, 'users', id, snapshot(before), snapshot(getUserRow(db, id)!), undefined, surauId);
        bumpFor(db, surauId);
      }
    }
    // the phone joins and sets a NEW PIN (plan: old PINs are not used); a PIN of link day would refuse that join
    db.prepare('UPDATE users SET pin_hash = NULL, pin_fail_count = 0, pin_locked_until = NULL WHERE id = ?').run(id);
    db.prepare('INSERT OR IGNORE INTO enrolments (code_hash, user_id, device_name, expires_at, created_by, ops) VALUES (?, ?, ?, ?, ?, 0)')
      .run(n.ticketHash, id, 'Telefon Pentadbir', n.ticketExpiresAt, `unlink:${n.unlinkId}`);
    db.prepare('INSERT INTO change_log (at, actor, entity, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, NULL, ?)')
      .run(at, actor, 'link', n.linkId, JSON.stringify({ event: 'unlinked', unlinkId: n.unlinkId, choice: n.choice, admin: id }));
    return id;
  });
  // one YouTube sign-in is never live on two boxes: the master goes on using this one
  if (n.dropYoutube) for (const rel of YOUTUBE_FILES) rmSync(join(dataDir, rel), { force: true });
  writeUnlinkNote(dataDir, identity, boxId, { ...n, applied: true, userId });
  return userId;
}

/** The answering person's phone joined (the code is spent) and, where the app lock asks for one, set a PIN. */
export function joinedNow(db: DatabaseSync, n: UnlinkNote, surauId: string): boolean {
  if (!n.applied || n.userId === null) return false;
  const e = db.prepare('SELECT used_at FROM enrolments WHERE code_hash = ?').get(n.ticketHash);
  if (e === undefined || e.used_at === null) return false;
  const u = db.prepare('SELECT roles_json, pin_hash FROM users WHERE id = ?').get(n.userId);
  if (u === undefined) return false;
  return u.pin_hash !== null || !appLockRequiredFor(db, parseRoles(u.roles_json), surauId);
}

/** One signed report to the master; true when the master took it (or no longer needs it). */
export async function sendUnlinkReport(
  client: Pick<PinnedClient, 'json'>, identity: BoxIdentity, boxId: string,
  n: Pick<UnlinkNote, 'unlinkId' | 'linkId' | 'master'>, event: 'copied' | 'joined',
): Promise<boolean> {
  const body = { unlinkId: n.unlinkId, boxId, event };
  const msg = { body, sig: signLink(identity, 'unlink-report', n.linkId, body) };
  for (const origin of n.master.addresses) {
    try {
      const r = await client.json(origin, n.master.ca, {
        method: 'POST', path: '/api/unlink/peer/report', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg),
      });
      if (r.status === 200) return true;
      // the master ended the session (its join window ran out, or it went back to its backup): nothing more to tell
      if (r.status === 409 || r.status === 404) return true;
    } catch {
      // the next address
    }
  }
  return false;
}

export interface UnlinkReporter {
  /** One check (tests); the timer calls it. */
  check(): Promise<void>;
  stop(): void;
}

/** While the note is there: tell the master once the phone joined; drop the note then, or a day after the code ran out. */
export function startUnlinkReporter(o: {
  db: DatabaseSync; dataDir: string; identity: BoxIdentity; boxId: string; surauId: string; client: Pick<PinnedClient, 'json'>; now: () => Date; everyMs?: number;
}): UnlinkReporter {
  let busy = false;
  const check = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const n = readUnlinkNote(o.dataDir, o.identity, o.boxId);
      if (n === null || !n.applied) return;
      if (o.now().getTime() > Date.parse(n.ticketExpiresAt) + GRACE_MS) {
        clearUnlinkNote(o.dataDir);
        return;
      }
      // carry-on: first the copy (the master holds its writes and waits for it before the join)
      if (n.copied === false) {
        if (!(await sendUnlinkReport(o.client, o.identity, o.boxId, n, 'copied'))) return;
        writeUnlinkNote(o.dataDir, o.identity, o.boxId, { ...n, copied: true });
      }
      if (!joinedNow(o.db, n, o.surauId)) return;
      if (await sendUnlinkReport(o.client, o.identity, o.boxId, n, 'joined')) clearUnlinkNote(o.dataDir);
    } finally {
      busy = false;
    }
  };
  const t = setInterval(() => void check().catch(() => undefined), o.everyMs ?? 30_000);
  t.unref();
  return { check, stop: () => clearInterval(t) };
}
