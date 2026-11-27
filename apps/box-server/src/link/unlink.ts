import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DatabaseSync as Db } from 'node:sqlite';
import { LINK_IDLE_TTL_MS, LINK_PIN_PROOF_TTL_MS, OPS_ROLES, holdsSurauAdmin, parseLinkHello, parseLinkPeople } from '@surau/core';
import type { BoxQrPub, LinkHello, LinkPerson, Role } from '@surau/core';
import { newCode } from '../auth/devices.ts';
import { activeAdminCount, deleteUserRows, parseRoles, revokeDeviceRow, tx } from '../auth/users.ts';
import { boxName } from '../setup/state.ts';
import type { BoxIdentity } from '../setup/identity.ts';
import { sealToBoxKey } from '../sync/boxSeal.ts';
import { AT_UNLINK_KEEP_DAYS, backupInfo, dropBackup } from './backupInfo.ts';
import { LINK_ID_RE } from './journal.ts';
import { atUnlinkFolder, backupDirOf, backupOf, journalIsOpen, pathExists, planRestore, writeFileAtomic, writeManifest } from './setAside.ts';
import { signLink, verifyLink } from './sign.ts';
import { requestedPage } from './storeMove.ts';

/**
 * "Putuskan pautan" at the MASTER (multi-box phase 2D, contract `docs/design/plans/2026-11-23-unlink-contract.md`).
 * SECURITY code: it decides who may answer for which box, signs the order a follower obeys, and plans the master's
 * own restore.
 *
 * The session is one `link_sessions` row (`kind = 'unlink'`); its state is `answers_json` (`UnlinkState`), its stage
 * is `step` (`answers`, `working`, `join`, `done`). The follower is reached the way a removed follower always is: its
 * TV token is revoked, its mirror asks `POST /api/link/peer/order`, and the answer is the order signed by this box's
 * identity key for that box and that link (`orderFor`). The order carries, sealed to the follower's identity key, the
 * join ticket of the person who answered for it, so that person's phone moves there and sets a PIN. The follower
 * tells this box what it did with a message signed by ITS identity key (`peerReport`: `copied`, `joined`).
 *
 * Order of work (never the reverse): the follower's copy (carry-on), the follower's own change, this box's change,
 * then the join. This box's "back" (a restore of its backup) is carried out LAST, after the join or when the join
 * window ends, because the restored store no longer knows the follower nor this session.
 *
 * Kept data (7 days, "Tukar pilihan", "Buang data lama") is recorded in a note outside the store (`KEPT_REL`), because
 * a restore swaps the database the session lived in. The note is read by `keptRows`, `switchKept` and `dropKept`.
 */

export type UnlinkSide = 'master' | 'follower';
export type UnlinkChoice = 'back' | 'carry-on' | 'empty';
export type UnlinkStage = 'answers' | 'working' | 'join' | 'done';
export type UnlinkStepName = 'copy' | 'back' | 'carry-on' | 'empty' | 'join';

/** How long the phone that answered for the follower has to join it and set a PIN. */
export const UNLINK_JOIN_TTL_MS = 30 * 60 * 1000;
/** The follower's copy (carry-on) and its taking of the order: past this the session ends `failed` (nothing at the master changed). */
export const UNLINK_WORK_TTL_MS = 60 * 60 * 1000;
export const KEPT_REL = 'link-unlink-kept.json';
const ORDER_SEAL_LABEL = 'maxcom-unlink-order-v1';
const MAX_NAMES = 50;

export class UnlinkError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export interface UnlinkCaller {
  userId: string;
  deviceId: string;
  roles: readonly string[];
}

interface SideState {
  choice: UnlinkChoice | null;
  by: string | null;
  byDevice: string | null;
  byName: string | null;
  agreedRev: number | null;
  removePeople: boolean;
  financeTick: boolean;
}

interface WorkState {
  step: UnlinkStepName;
  /** The follower asked for its order (it has it now; its token is dead). */
  fetchedAt: string | null;
  copiedAt: string | null;
  joinedAt: string | null;
  /** The master's own change was made (carry-on) or planned (back). */
  masterDoneAt: string | null;
  order: { step: 'order-revert' | 'order-standalone'; body: OrderBody; sig: string } | null;
  joinUser: string | null;
  joinUntil: string | null;
  deadline: string;
  /** Follower carry-on: the videos its copy left out (they did not fit its free space). */
  videosNotFit?: { title: string; bytes: number }[];
}

export interface UnlinkState {
  v: 1;
  linkId: string;
  deviceId: string;
  followerBoxId: string;
  followerName: string;
  masterName: string;
  caseX: boolean;
  followerHadStore: boolean;
  masterAsked: boolean;
  eligible: 'before' | 'any';
  /** Users of this box who were Pentadbir of the follower before the link. */
  before: string[];
  rev: number;
  master: SideState;
  follower: SideState;
  /** userId -> ISO time of the last PIN proof in this session. */
  pins: Record<string, string>;
  work: WorkState | null;
}

export interface OrderBody {
  boxId: string;
  linkId: string;
  masterBoxId: string;
  unlinkId: string;
  sealed: string;
}

/** What the follower opens from `OrderBody.sealed`. */
export interface OrderSecret {
  v: 1;
  choice: 'back' | 'carry-on';
  /** The person who answered for the follower; `peerUserId` is their id on the follower when known. */
  person: { peerUserId: string | null; name: string; phone: string | null };
  /** Plain one-time join code; only its hash is stored at the follower. */
  ticket: string;
  ticketExpiresAt: string;
  /** The YouTube sign-in in the follower's backup is the one this master goes on using: the follower drops its copy. */
  dropYoutube: boolean;
  /** The master's addresses now (the follower keeps its key and certificate hash from its follow record). */
  master: { boxId: string; name: string; addresses: string[] };
}

export interface KeptNote {
  v: 1;
  linkId: string;
  side: UnlinkSide;
  chosen: 'back' | 'carry-on';
  /** The folder of the data not chosen (`linkundo/<folder>`). */
  folder: string;
  keptUntil: string;
  followerName: string;
  masterName: string;
  finishedAt: string;
  outcome: 'done' | 'expired';
  unlinkId: string;
  /**
   * False for the data kept by a restore that no unlink session made (a follower's own way back, a box that restored
   * its backup alone): "Buang data lama" is offered, "Tukar pilihan" is not. Absent means true.
   */
  switchable?: boolean;
}

export const orderAad = (unlinkId: string, followerBoxId: string, masterBoxId: string): string => `${unlinkId}|${followerBoxId}|${masterBoxId}`;
export const ORDER_LABEL = ORDER_SEAL_LABEL;

// ---------------------------------------------------------------- the kept note (outside the store)

export function readKeptNote(dataDir: string): KeptNote | null {
  try {
    const n = JSON.parse(readFileSync(join(dataDir, KEPT_REL), 'utf8')) as Partial<KeptNote> | null;
    if (
      n === null || typeof n !== 'object' || n.v !== 1 || typeof n.linkId !== 'string' || !LINK_ID_RE.test(n.linkId) ||
      (n.side !== 'master' && n.side !== 'follower') || (n.chosen !== 'back' && n.chosen !== 'carry-on') ||
      typeof n.folder !== 'string' || !LINK_ID_RE.test(n.folder) || typeof n.keptUntil !== 'string' ||
      typeof n.followerName !== 'string' || typeof n.masterName !== 'string' ||
      (n.switchable !== undefined && typeof n.switchable !== 'boolean')
    ) return null;
    return n as KeptNote;
  } catch {
    return null;
  }
}

export function writeKeptNote(dataDir: string, n: KeptNote): void {
  writeFileAtomic(join(dataDir, KEPT_REL), JSON.stringify(n));
}

export function clearKeptNote(dataDir: string): void {
  rmSync(join(dataDir, KEPT_REL), { force: true });
}

export interface KeptRow {
  side: UnlinkSide;
  followerName: string;
  masterName: string;
  keptUntil: string;
  chosen: 'back' | 'carry-on';
  /** False: the data can only be dropped, not switched to (see `KeptNote.switchable`). */
  switchable: boolean;
}

/** The kept rows the status shows: only while the note's folder still exists and the window is open. */
export function keptRows(dataDir: string | null, now: Date): KeptRow[] {
  if (dataDir === null) return [];
  const n = readKeptNote(dataDir);
  if (n === null || !pathExists(backupDirOf(dataDir, n.folder)) || Date.parse(n.keptUntil) <= now.getTime()) return [];
  return [{ side: n.side, followerName: n.followerName, masterName: n.masterName, keptUntil: n.keptUntil, chosen: n.chosen, switchable: n.switchable !== false }];
}

/**
 * A restore that no unlink session made (a follower that went back by itself, a box that restored its backup alone)
 * keeps the data in use for 7 days under `<linkId>-at-unlink` and refuses a new link until it is gone. Without a note
 * the status showed nothing and the person could not remove it, so the restore writes one: the box shows the data
 * and may drop it. Called after the restore was planned. Never throws; an older kept note is left as it is (the
 * restore itself is refused while that folder exists).
 */
export function noteKeptByRestore(
  dataDir: string, side: UnlinkSide, linkId: string,
  names: { followerName?: string; masterName?: string; ownName?: string }, now: Date,
): void {
  try {
    // a note whose folder is gone (or whose window is over) is stale and is replaced; a live one is left as it is
    if (keptRows(dataDir, now).length > 0) return;
    // never an empty name (older apps refuse the whole status for one): this box's own name for its side, the peer's
    // name when known, this box's name when not
    const own = (names.ownName ?? '').trim() || 'MAXCOM';
    const peer = side === 'follower' ? (names.masterName ?? '').trim() : (names.followerName ?? '').trim();
    const followerName = side === 'follower' ? own : peer || own;
    const masterName = side === 'follower' ? peer || own : own;
    writeKeptNote(dataDir, {
      v: 1, linkId, side, chosen: 'back', folder: atUnlinkFolder(linkId),
      keptUntil: new Date(now.getTime() + AT_UNLINK_KEEP_DAYS * 86_400_000).toISOString(),
      followerName: followerName, masterName: masterName, finishedAt: now.toISOString(), outcome: 'done', unlinkId: '',
      switchable: false,
    });
  } catch {
    // the restore stands without the note; the link screens still show the data
  }
}

/**
 * The daily sweep of the kept note: past its window the data not chosen goes (a carry-on box's backup; the data of a
 * box that went back is swept by `sweepKeptAtUnlink` by its own date) and the note with it.
 */
export function sweepKeptNote(dataDir: string, now: Date): boolean {
  const n = readKeptNote(dataDir);
  if (n === null) return false;
  if (Date.parse(n.keptUntil) > now.getTime()) return false;
  try {
    if (n.chosen === 'carry-on' && backupOf(dataDir, n.folder) !== null) dropBackup(dataDir, n.folder);
  } catch {
    return false;
  }
  clearKeptNote(dataDir);
  return true;
}

/**
 * "Tukar pilihan": the box runs on the data it did not choose, and the data it ran on is kept for the rest of the
 * window. Carried out at the next start (a restore). `back` -> `carry-on`: the data kept at the unlink becomes the
 * backup folder again and is restored. `carry-on` -> `back`: the backup is restored. Throws `UnlinkError`.
 */
export function switchKept(dataDir: string, side: UnlinkSide, now: Date): KeptNote {
  const n = readKeptNote(dataDir);
  if (n === null || n.side !== side || n.switchable === false || !pathExists(backupDirOf(dataDir, n.folder))) throw new UnlinkError(409, 'no_kept_data');
  if (Date.parse(n.keptUntil) <= now.getTime()) throw new UnlinkError(409, 'kept_window_over');
  const linkId = n.linkId;
  // a step of another move still open: nothing is touched (the rename below must never stay without its restore)
  if (journalIsOpen(dataDir)) throw new UnlinkError(409, 'linking');
  let renamed = false;
  if (n.chosen === 'back') {
    // the kept data is `<linkId>-at-unlink`: it becomes `<linkId>` (a backup that may be restored), then the restore
    // sets the store in use aside as `<linkId>-at-unlink` again. A stop between the two leaves a box with a backup.
    const kept = backupDirOf(dataDir, n.folder);
    const m = backupOf(dataDir, n.folder);
    if (m === null || pathExists(backupDirOf(dataDir, linkId))) throw new UnlinkError(409, 'no_kept_data');
    writeManifest(kept, { ...m, kind: 'set-aside' });
    renameSync(kept, backupDirOf(dataDir, linkId));
    renamed = true;
  }
  try {
    planRestore(dataDir, linkId, now);
  } catch (e) {
    // undo the rename: the kept data stays where its note says, under the 7-day sweep
    if (renamed) {
      try {
        renameSync(backupDirOf(dataDir, linkId), backupDirOf(dataDir, n.folder));
        const back = backupOf(dataDir, n.folder);
        if (back !== null) writeManifest(backupDirOf(dataDir, n.folder), { ...back, kind: 'at-unlink' });
      } catch {
        // left as a backup; the note still names the kept folder
      }
    }
    const code = e instanceof Error ? e.message.split(': ')[1] ?? '' : '';
    throw new UnlinkError(409, code === 'journal_open' ? 'linking' : 'no_kept_data');
  }
  const next: KeptNote = { ...n, chosen: n.chosen === 'back' ? 'carry-on' : 'back', folder: n.chosen === 'back' ? linkId : atUnlinkFolder(linkId) };
  // the window does not grow: it stays the one of the unlink
  writeKeptNote(dataDir, next);
  return next;
}

/** "Buang data lama": the data not chosen goes now, and the choice can no longer be changed. */
export function dropKept(dataDir: string, side: UnlinkSide): void {
  const n = readKeptNote(dataDir);
  if (n === null || n.side !== side) throw new UnlinkError(409, 'no_kept_data');
  try {
    if (backupOf(dataDir, n.folder) !== null) dropBackup(dataDir, n.folder);
  } catch (e) {
    const code = e instanceof Error ? e.message.split(': ')[1] ?? '' : '';
    if (code === 'journal_open') throw new UnlinkError(409, 'linking');
    // the data could not be removed: the note stays, so the data is still shown and swept later
    throw e;
  }
  clearKeptNote(dataDir);
}

// ---------------------------------------------------------------- the session at the master

export interface UnlinkDeps {
  db: Db;
  boxId: string;
  identity: BoxIdentity;
  surauId: string;
  dataDir: string | null;
  now: () => Date;
  /** A reason this box cannot start an unlink now (`live_on`, `linking`), or null. */
  busy: () => string | null;
  /** True for a follower box: it has no unlink of its own (409 `not_linked`). */
  isFollower: () => boolean;
  /** Starts the process again (the master's own "back" is carried out at the next start). */
  restart?: () => void;
  /** The list of TVs changed. */
  changed?: () => void;
}

export interface UnlinkSideView {
  asked: boolean;
  eligible: 'before' | 'any' | null;
  mayAnswer: boolean;
  choice: UnlinkChoice | null;
  answeredBy: string | null;
  agreed: boolean;
  needsTyped: boolean;
  financeTick: boolean;
  options: {
    back: { available: boolean; backupAt: string | null; backupBytes: number | null };
    carryOn: { available: boolean };
    empty: { available: boolean };
  };
  numbers: {
    changesSinceBackup: number | null;
    peopleBack: string[];
    peopleAbsent: string[];
    financeEntriesLeft: number | null;
    videosNotFit: { title: string; bytes: number }[];
    peopleFromFollower: number | null;
  };
  removePeople: boolean;
  youtube: 'kept' | 'returns' | 'sign-in-again' | 'none';
}

export interface UnlinkView {
  id: string;
  rev: number;
  stage: UnlinkStage;
  expiresAt: string;
  masterName: string;
  followerName: string;
  master: UnlinkSideView;
  follower: UnlinkSideView;
  progress: { step: UnlinkStepName; stepNo: number; steps: number; percent: number | null } | null;
  /**
   * Given ONLY to the answering device. Besides the pointer fields it carries what a `surau1:` enrol payload needs, so a
   * browser can hand the person to the follower's own web app: `box` (the follower's origin), `mode`, `user` (the
   * person's name) and `exp` (when the ticket dies, ms since 1970). The payload is `{ v: 1, mode, box, boxId, caSha256,
   * code: ticket, user, exp }`.
   */
  join: { name: string; boxId: string; addresses: string[]; caSha256: string; keyFp: string; ticket: string; box: string | null; mode: 'ip' | 'name'; user: string; exp: number } | null;
}

export interface UnlinkCopy {
  id: string;
  state: UnlinkState;
  people: Map<string, string | null>;
  freeBytes: number | null;
  /** The page of the list this request asks for (the signed body names it). */
  page: number;
  /** True for a request of the previous release (no `page`): it reads one answer only. */
  legacy: boolean;
}

export interface UnlinkStatus {
  session: UnlinkView | null;
  last: { id: string; outcome: 'done' | 'cancelled' | 'failed' | 'expired'; finishedAt: string; followerName: string } | null;
  kept: KeptRow[];
}

export interface Unlinks {
  status(caller: UnlinkCaller | null): UnlinkStatus;
  /** True while the master's data is being copied for the follower: every other write waits. */
  writesBlocked(): boolean;
  /** True while a session is open (a link may not start). */
  open(): boolean;
  start(caller: UnlinkCaller, deviceId: unknown): UnlinkStatus;
  provePin(userId: string): void;
  answer(caller: UnlinkCaller, input: unknown): UnlinkStatus;
  agree(caller: UnlinkCaller, input: unknown): UnlinkStatus;
  cancel(caller: UnlinkCaller): void;
  /** `POST /api/link/peer/order` asks first: the signed order of an unlink for that follower, or null. */
  orderFor(boxId: string, linkId: string): { order: 'revert' | 'standalone'; body: OrderBody; sig: string } | null;
  /** A follower's signed report (`copied`, `joined`). */
  peerReport(body: unknown): { ok: true } | { ok: false; status: number; code: string };
  /**
   * For the follower's copy (D3): the open session in which this follower carries on, checked by its key, with the
   * people its copy takes (this box's user id -> the id they had on the follower, when known) and its free bytes.
   */
  copyFor(body: unknown): UnlinkCopy | null;
  /** The copy is still wanted for that session (the follower has not reported `copied`, the session is open). */
  copyOpen(unlinkId: string): boolean;
  /** The copy was made: the videos it left out (shown on the follower's sheet). */
  copyBuilt(unlinkId: string, videosNotFit: { title: string; bytes: number }[]): void;
  /** Percent of the copy the follower has fetched (the `copy` step). */
  copyProgress(unlinkId: string, percent: number): void;
  /** Expiry, the join window and the master's last change. Called by status and by a timer. */
  tick(): void;
  /** The TV line of this box (`GET /api/kiosk/link` `unlink`). */
  kioskView(): { step: UnlinkStepName | 'done'; percent: number | null } | null;
}

const iso = (d: Date): string => d.toISOString();
const parseJson = (s: unknown): unknown => {
  if (typeof s !== 'string') return null;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
};
const emptySide = (): SideState => ({ choice: null, by: null, byDevice: null, byName: null, agreedRev: null, removePeople: false, financeTick: false });

interface LinkFacts {
  linkId: string;
  peerHello: LinkHello | null;
  peerPeople: LinkPerson[];
  ownPeople: LinkPerson[];
  caseX: boolean;
  committedAt: string | null;
}

export function createUnlinks(d: UnlinkDeps): Unlinks {
  const { db } = d;
  /** The plain join code lives in memory only: a restart in the join window leaves the follower to its recovery code. */
  const tickets = new Map<string, string>();
  /** When the join ticket of a session dies (ms since 1970), kept with the ticket in memory only. */
  const ticketEnds = new Map<string, number>();
  let pct: number | null = null;

  const linkFacts = (linkId: string): LinkFacts => {
    const r = db.prepare("SELECT * FROM link_sessions WHERE id = ? AND kind = 'link'").get(linkId);
    const answers = parseJson(r?.answers_json) as { keep?: unknown; master?: unknown } | null;
    return {
      linkId,
      peerHello: parseLinkHello(parseJson(r?.peer_hello_json)),
      peerPeople: parseLinkPeople(parseJson(r?.peer_people_json)) ?? [],
      ownPeople: parseLinkPeople(parseJson(r?.own_people_json)) ?? [],
      caseX: answers !== null && typeof answers === 'object' && answers.keep !== answers.master,
      committedAt: typeof r?.committed_at === 'string' ? r.committed_at : typeof r?.finished_at === 'string' ? r.finished_at : null,
    };
  };

  const activeUser = (id: string): { id: string; name: string; phone: string | null; roles: Role[] } | null => {
    const r = db.prepare('SELECT id, name, phone, roles_json FROM users WHERE id = ? AND surau_id = ? AND active = 1 AND deleted_at IS NULL').get(id, d.surauId);
    if (r === undefined) return null;
    return { id: String(r.id), name: String(r.name), phone: typeof r.phone === 'string' && r.phone !== '' ? r.phone : null, roles: parseRoles(r.roles_json) };
  };

  /** A person of the follower's list, as a user of this box now: by the link's merge record, else by phone. */
  const mapPeer = (linkId: string, p: LinkPerson): string | null => {
    const m = db.prepare('SELECT user_id FROM link_people WHERE link_id = ? AND peer_user_id = ?').get(linkId, p.id);
    if (m !== undefined) return String(m.user_id);
    if (p.phone === null) return null;
    const r = db.prepare("SELECT id FROM users WHERE phone = ? AND surau_id = ? AND active = 1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1").get(p.phone, d.surauId);
    return r === undefined ? null : String(r.id);
  };

  /** The follower's people of link day as users here (id), with their roles then. */
  const followerPeople = (f: LinkFacts): { userId: string; peer: LinkPerson }[] => {
    const out: { userId: string; peer: LinkPerson }[] = [];
    for (const p of f.peerPeople) {
      const id = mapPeer(f.linkId, p);
      if (id !== null) out.push({ userId: id, peer: p });
    }
    return out;
  };

  /** The people the switch "Buang pengguna yang datang dari kotak ..." would remove. */
  const fromFollower = (f: LinkFacts): string[] => {
    const own = new Set(f.ownPeople.flatMap((p) => [p.id, ...(p.phone === null ? [] : [`tel:${p.phone}`])]));
    const ids = new Set<string>();
    for (const { userId, peer } of followerPeople(f)) {
      const link = db.prepare('SELECT action FROM link_people WHERE link_id = ? AND peer_user_id = ?').get(f.linkId, peer.id);
      // case S: only the accounts the link made; case X: everyone of the follower's list who was not this box's own
      if (link !== undefined && link.action !== 'created') continue;
      if (link === undefined && (own.has(userId) || (peer.phone !== null && own.has(`tel:${peer.phone}`)))) continue;
      const u = activeUser(userId);
      if (u !== null && !u.roles.some((r) => OPS_ROLES.includes(r))) ids.add(userId);
    }
    return [...ids];
  };

  const rowOf = (r: Record<string, unknown> | undefined): { id: string; stage: UnlinkStage; state: UnlinkState; expiresAt: string; finishedAt: string | null; outcome: string | null; startedBy: string | null } | null => {
    if (r === undefined) return null;
    const state = parseJson(r.answers_json) as UnlinkState | null;
    if (state === null || typeof state !== 'object' || state.v !== 1) return null;
    return {
      id: String(r.id), stage: String(r.step) as UnlinkStage, state, expiresAt: String(r.expires_at),
      finishedAt: typeof r.finished_at === 'string' ? r.finished_at : null, outcome: typeof r.outcome === 'string' ? r.outcome : null,
      startedBy: typeof r.pin_proof_user === 'string' ? r.pin_proof_user : null,
    };
  };
  type Row = NonNullable<ReturnType<typeof rowOf>>;

  const openRow = (): Row | null =>
    rowOf(db.prepare("SELECT * FROM link_sessions WHERE kind = 'unlink' AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1").get());

  const save = (id: string, state: UnlinkState, stage?: UnlinkStage, expiresAt?: string): void => {
    db.prepare('UPDATE link_sessions SET answers_json = ?, answers_rev = ?, step = COALESCE(?, step), expires_at = COALESCE(?, expires_at) WHERE id = ?')
      .run(JSON.stringify(state), state.rev, stage ?? null, expiresAt ?? null, id);
  };

  const end = (id: string, outcome: 'done' | 'cancelled' | 'failed' | 'expired'): void => {
    db.prepare("UPDATE link_sessions SET step = 'done', finished_at = ?, outcome = ? WHERE id = ? AND finished_at IS NULL").run(iso(d.now()), outcome, id);
    tickets.delete(id);
    ticketEnds.delete(id);
    pct = null;
  };

  const touch = (): string => iso(new Date(d.now().getTime() + LINK_IDLE_TTL_MS));

  // ---------------------------------------------------------------- the sheet

  const masterBackup = (): ReturnType<typeof backupInfo> => (d.dataDir === null ? null : backupInfo(d.dataDir));

  /** People of the master's backup (read-only open of its database). null when it cannot be read. */
  const backupPeople = (): Map<string, string> | null => {
    const b = masterBackup();
    if (b === null || d.dataDir === null) return null;
    let bdb: DatabaseSync | null = null;
    try {
      bdb = new DatabaseSync(join(backupDirOf(d.dataDir, b.linkId), 'surau.db'), { readOnly: true });
      const rows = bdb.prepare("SELECT id, name FROM users WHERE surau_id <> '*' AND active = 1 AND deleted_at IS NULL").all();
      return new Map(rows.map((r) => [String(r.id), String(r.name)]));
    } catch {
      return null;
    } finally {
      try {
        bdb?.close();
      } catch {
        // nothing more to do
      }
    }
  };

  const changesSince = (at: string | null): number | null => {
    if (at === null) return null;
    return Number(db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE at > ? AND entity <> 'link'").get(at)?.n ?? 0);
  };

  const activePeopleNames = (): Map<string, string> =>
    new Map(db.prepare('SELECT id, name FROM users WHERE surau_id = ? AND active = 1 AND deleted_at IS NULL').all(d.surauId).map((r) => [String(r.id), String(r.name)]));

  const youtubeNow = (): boolean => d.dataDir !== null && pathExists(join(d.dataDir, 'secret', 'youtube-token.json'));

  const sideView = (row: Row, side: UnlinkSide, caller: UnlinkCaller | null): UnlinkSideView => {
    const s = row.state;
    const st = s[side];
    const f = linkFacts(s.linkId);
    const asked = side === 'follower' || s.masterAsked;
    const mayAnswer = caller !== null && row.stage === 'answers' && asked && mayAnswerFor(s, side, caller) === null;
    const mb = masterBackup();
    const backAvailable = side === 'master' ? mb !== null : s.followerHadStore;
    const numbers: UnlinkSideView['numbers'] = { changesSinceBackup: null, peopleBack: [], peopleAbsent: [], financeEntriesLeft: null, videosNotFit: [], peopleFromFollower: null };
    let youtube: UnlinkSideView['youtube'] = 'none';
    if (side === 'master') {
      if (st.choice === 'back' && mb !== null) {
        numbers.changesSinceBackup = changesSince(mb.at);
        const then = backupPeople();
        const now = activePeopleNames();
        if (then !== null) {
          numbers.peopleBack = [...then].filter(([id]) => !now.has(id)).map(([, n]) => n).slice(0, MAX_NAMES);
          numbers.peopleAbsent = [...now].filter(([id]) => !then.has(id)).map(([, n]) => n).slice(0, MAX_NAMES);
        }
        youtube = d.dataDir !== null && pathExists(join(backupDirOf(d.dataDir, mb.linkId), 'secret', 'youtube-token.json')) ? 'returns' : 'none';
      } else {
        numbers.peopleFromFollower = fromFollower(f).length;
        youtube = youtubeNow() ? 'kept' : 'none';
      }
    } else if (st.choice === 'back') {
      numbers.changesSinceBackup = changesSince(f.committedAt);
      const mapped = followerPeople(f);
      const mappedIds = new Set(mapped.map((m) => m.userId));
      // back: the follower's people of link day who are no longer here come back; people here who were never there are absent
      numbers.peopleBack = f.peerPeople.filter((p) => {
        const m = mapped.find((x) => x.peer.id === p.id);
        return m === undefined || activeUser(m.userId) === null;
      }).map((p) => p.name).slice(0, MAX_NAMES);
      numbers.peopleAbsent = [...activePeopleNames()].filter(([id]) => !mappedIds.has(id)).map(([, n]) => n).slice(0, MAX_NAMES);
      youtube = f.peerHello?.facts.youtube === true ? (youtubeClash(s) ? 'sign-in-again' : 'returns') : 'none';
    } else if (st.choice === 'carry-on') {
      numbers.financeEntriesLeft = Number(db.prepare('SELECT COUNT(*) AS n FROM finance_entries').get()?.n ?? 0);
      numbers.videosNotFit = (s.work?.videosNotFit ?? []).slice(0, MAX_NAMES);
      youtube = 'none';
    }
    return {
      asked,
      eligible: side === 'follower' ? s.eligible : null,
      mayAnswer,
      choice: asked ? st.choice : 'carry-on',
      answeredBy: st.byName,
      agreed: st.agreedRev !== null && st.agreedRev === s.rev,
      needsTyped: st.choice === 'back' || st.choice === 'empty',
      financeTick: st.financeTick,
      options: {
        back: {
          available: backAvailable,
          backupAt: side === 'master' ? mb?.at ?? null : s.followerHadStore ? f.committedAt : null,
          backupBytes: side === 'master' ? mb?.bytes ?? null : null,
        },
        carryOn: { available: true },
        empty: { available: side === 'follower' && !s.followerHadStore },
      },
      numbers,
      removePeople: side === 'master' && st.choice === 'carry-on' && st.removePeople,
      youtube,
    };
  };

  /**
   * One YouTube sign-in is never live on two boxes: in case X the master uses the sign-in that crossed from the
   * follower, and the follower's backup holds the same one. If the master carries on, the follower's copy goes.
   */
  const youtubeClash = (s: UnlinkState): boolean => s.caseX && youtubeNow() && (!s.masterAsked || s.master.choice !== 'back');

  /** null when this caller may answer for that side now, else the refusal code. */
  const mayAnswerFor = (s: UnlinkState, side: UnlinkSide, c: UnlinkCaller): string | null => {
    const u = activeUser(c.userId);
    if (u === null || u.roles.some((r) => OPS_ROLES.includes(r))) return 'not_allowed_to_answer';
    const other = side === 'master' ? s.follower : s.master;
    if (other.byDevice !== null && other.byDevice === c.deviceId) return 'same_phone';
    if (side === 'master') {
      if (!s.masterAsked) return 'not_allowed_to_answer';
      return holdsSurauAdmin(u.roles) ? null : 'not_allowed_to_answer';
    }
    if (s.eligible === 'before') return s.before.includes(c.userId) ? null : 'not_allowed_to_answer';
    return holdsSurauAdmin(u.roles) ? null : 'not_allowed_to_answer';
  };

  const stepsOf = (s: UnlinkState): UnlinkStepName[] => {
    const fc = s.follower.choice ?? 'back';
    const out: UnlinkStepName[] = [];
    if (fc === 'carry-on') out.push('copy');
    out.push(fc);
    if (s.masterAsked && s.master.choice !== null) out.push(s.master.choice === 'back' ? 'back' : 'carry-on');
    if (fc !== 'empty') out.push('join');
    return out;
  };

  const joinOf = (row: Row, caller: UnlinkCaller | null): UnlinkView['join'] => {
    const s = row.state;
    if (row.stage !== 'join' || caller === null || s.work?.joinUser !== caller.userId || s.follower.byDevice !== caller.deviceId) return null;
    const ticket = tickets.get(row.id);
    const f = linkFacts(s.linkId);
    const lb = db.prepare('SELECT key_fp, addresses_json FROM linked_boxes WHERE device_id = ?').get(s.deviceId);
    const addresses = (parseJson(lb?.addresses_json) as unknown[] | null)?.filter((a): a is string => typeof a === 'string') ?? f.peerHello?.addresses ?? [];
    if (ticket === undefined || f.peerHello === null || lb === undefined) return null;
    // the pairing record's address list (not the follower's latest hello) decides where the browser is sent
    const box = addresses.find((a) => /^https:\/\/[^/?#\s]+$/.test(a)) ?? null;
    const hostOf = box === null ? '' : box.slice('https://'.length).replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return {
      name: s.followerName, boxId: s.followerBoxId, addresses, caSha256: f.peerHello.caSha256, keyFp: String(lb.key_fp), ticket,
      box, mode: isIP(hostOf) !== 0 ? 'ip' : 'name', user: activeUser(caller.userId)?.name ?? '', exp: ticketEnds.get(row.id) ?? Date.parse(row.expiresAt),
    };
  };

  const viewOf = (row: Row, caller: UnlinkCaller | null): UnlinkView => {
    const s = row.state;
    const steps = stepsOf(s);
    const w = s.work;
    return {
      id: row.id, rev: s.rev, stage: row.stage, expiresAt: row.stage === 'join' && w?.joinUntil != null ? w.joinUntil : row.expiresAt,
      masterName: s.masterName, followerName: s.followerName,
      master: sideView(row, 'master', caller), follower: sideView(row, 'follower', caller),
      progress: w === null ? null : { step: w.step, stepNo: Math.max(1, steps.indexOf(w.step) + 1), steps: steps.length, percent: w.step === 'copy' ? pct : null },
      join: joinOf(row, caller),
    };
  };

  const lastOf = (): UnlinkStatus['last'] => {
    const r = db.prepare("SELECT id, outcome, finished_at, answers_json FROM link_sessions WHERE kind = 'unlink' AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1").get();
    if (r !== undefined) {
      const s = parseJson(r.answers_json) as UnlinkState | null;
      const o = String(r.outcome);
      return {
        id: String(r.id), outcome: o === 'done' || o === 'cancelled' || o === 'expired' ? o : 'failed', finishedAt: String(r.finished_at),
        followerName: s !== null && typeof s.followerName === 'string' ? s.followerName : '',
      };
    }
    // a master that went back runs on a store that never saw the session: the note remembers it
    const n = d.dataDir === null ? null : readKeptNote(d.dataDir);
    return n === null ? null : { id: n.unlinkId, outcome: n.outcome, finishedAt: n.finishedAt, followerName: n.followerName };
  };

  // ---------------------------------------------------------------- the work

  const ownAddresses = (f: LinkFacts): string[] => {
    const r = db.prepare("SELECT own_hello_json FROM link_sessions WHERE id = ? AND kind = 'link'").get(f.linkId);
    return parseLinkHello(parseJson(r?.own_hello_json))?.addresses ?? [];
  };

  /** Both asked sides agreed: the follower's TV token dies now and its order waits for it. */
  const startWork = (row: Row): void => {
    const s = row.state;
    const f = linkFacts(s.linkId);
    const now = d.now();
    const fc = s.follower.choice!;
    let order: WorkState['order'] = null;
    let joinUser: string | null = null;
    if (fc !== 'empty') {
      const peer = f.peerHello;
      const lb = db.prepare('SELECT public_jwk FROM linked_boxes WHERE device_id = ?').get(s.deviceId);
      const fpub = parseJson(lb?.public_jwk) as BoxQrPub | null;
      const u = activeUser(s.follower.by!);
      if (peer === null || fpub === null || u === null) {
        end(row.id, 'failed');
        return;
      }
      joinUser = u.id;
      const peerUser = f.peerPeople.find((p) => mapPeer(f.linkId, p) === u.id)?.id ?? null;
      const ticket = newCode();
      const ticketExpiresAt = iso(new Date(now.getTime() + UNLINK_JOIN_TTL_MS + UNLINK_WORK_TTL_MS));
      const secret: OrderSecret = {
        v: 1, choice: fc, person: { peerUserId: peerUser, name: u.name, phone: u.phone }, ticket, ticketExpiresAt,
        dropYoutube: fc === 'back' && youtubeClash(s),
        master: { boxId: d.boxId, name: s.masterName, addresses: ownAddresses(f) },
      };
      const sealed = sealToBoxKey(fpub, JSON.stringify(secret), ORDER_SEAL_LABEL, orderAad(row.id, s.followerBoxId, d.boxId));
      const body: OrderBody = { boxId: s.followerBoxId, linkId: s.linkId, masterBoxId: d.boxId, unlinkId: row.id, sealed };
      const step = fc === 'back' ? 'order-revert' : 'order-standalone';
      order = { step, body, sig: signLink(d.identity, step, s.linkId, body) };
      tickets.set(row.id, ticket);
      ticketEnds.set(row.id, Date.parse(ticketExpiresAt));
    }
    const at = iso(now);
    s.work = {
      step: fc === 'carry-on' ? 'copy' : fc, fetchedAt: null, copiedAt: null, joinedAt: null, masterDoneAt: null, order, joinUser, joinUntil: null,
      deadline: iso(new Date(now.getTime() + UNLINK_WORK_TTL_MS)),
    };
    tx(db, () => {
      // the follower's TV token dies: its mirror asks why and gets the order (`orderFor`), or `forget` (empty)
      db.prepare('DELETE FROM kiosk_cookies WHERE device_id = ?').run(s.deviceId);
      db.prepare('UPDATE linked_boxes SET removed_at = COALESCE(removed_at, ?) WHERE device_id = ?').run(at, s.deviceId);
      revokeDeviceRow(db, s.deviceId, 'system:unlink', at);
      save(row.id, s, 'working', s.work!.deadline);
      db.prepare('INSERT INTO change_log (at, actor, entity, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, NULL, ?)')
        .run(at, 'system:unlink', 'link', s.linkId, JSON.stringify({ event: 'unlink_started', unlinkId: row.id, follower: s.follower.choice, master: s.masterAsked ? s.master.choice : 'not_asked' }));
    });
    d.changed?.();
  };

  /** The master's carry-on change (at once once the follower took its order); its "back" is only planned at the end. */
  const masterCarryOn = (row: Row): void => {
    const s = row.state;
    const f = linkFacts(s.linkId);
    const at = iso(d.now());
    tx(db, () => {
      if (s.masterAsked && s.master.removePeople) {
        const keep = new Set([s.master.by, s.follower.by].filter((x): x is string => x !== null));
        for (const id of fromFollower(f)) {
          if (keep.has(id)) continue;
          const u = activeUser(id);
          if (u === null) continue;
          // never the last administrator
          if (holdsSurauAdmin(u.roles) && activeAdminCount(db, d.surauId) <= 1) continue;
          deleteUserRows(db, id, 'system:unlink', at);
        }
      }
      // the leaving TV's profile goes
      const tv = db.prepare("SELECT json FROM settings WHERE surau_id = ? AND feature = 'tvProfiles'").get(d.surauId);
      const j = parseJson(tv?.json) as { tvs?: Record<string, unknown> } | null;
      if (j !== null && typeof j === 'object' && j.tvs !== undefined && typeof j.tvs === 'object' && j.tvs !== null && s.deviceId in j.tvs) {
        delete j.tvs[s.deviceId];
        db.prepare("UPDATE settings SET json = ?, updated_at = ?, updated_by = 'system:unlink' WHERE surau_id = ? AND feature = 'tvProfiles'").run(JSON.stringify(j), at, d.surauId);
      }
    });
    if (s.masterAsked && d.dataDir !== null) {
      const b = masterBackup();
      if (b !== null) {
        writeKeptNote(d.dataDir, {
          v: 1, linkId: b.linkId, side: 'master', chosen: 'carry-on', folder: b.linkId,
          keptUntil: iso(new Date(d.now().getTime() + AT_UNLINK_KEEP_DAYS * 86_400_000)), followerName: s.followerName, masterName: s.masterName,
          finishedAt: at, outcome: 'done', unlinkId: row.id,
        });
      }
    }
  };

  /** The end: the master's "back" (planned, carried out at the next start) or nothing more. */
  const finish = (row: Row, outcome: 'done' | 'expired'): void => {
    const s = row.state;
    const back = s.masterAsked && s.master.choice === 'back';
    if (back && d.dataDir !== null) {
      const b = masterBackup();
      if (b !== null) {
        const finishedAt = iso(d.now());
        // the note first (outside the store): the session row goes aside with the store in use
        writeKeptNote(d.dataDir, {
          v: 1, linkId: b.linkId, side: 'master', chosen: 'back', folder: atUnlinkFolder(b.linkId),
          keptUntil: iso(new Date(d.now().getTime() + AT_UNLINK_KEEP_DAYS * 86_400_000)), followerName: s.followerName, masterName: s.masterName,
          finishedAt, outcome, unlinkId: row.id,
        });
        end(row.id, outcome);
        try {
          planRestore(d.dataDir, b.linkId, d.now());
        } catch {
          // the master stays on its data; the note says nothing was kept
          clearKeptNote(d.dataDir);
          return;
        }
        if (d.restart !== undefined) {
          const t = setTimeout(d.restart, 750);
          t.unref();
        }
        return;
      }
    }
    end(row.id, outcome);
    d.changed?.();
  };

  /** Moves the work on from what is known now. Idempotent. */
  const advance = (row: Row): void => {
    const s = row.state;
    const w = s.work;
    if (w === null) return;
    const now = d.now();
    const fc = s.follower.choice!;
    if (row.stage === 'working') {
      if (w.fetchedAt === null || (fc === 'carry-on' && w.copiedAt === null)) {
        if (Date.parse(w.deadline) <= now.getTime()) {
          // the follower never took its order: it keeps following a master that removed it; its local revert remains
          end(row.id, 'failed');
        }
        return;
      }
      // the follower has what it needs: the master's own carry-on change now
      if (w.masterDoneAt === null && !(s.masterAsked && s.master.choice === 'back')) {
        masterCarryOn(row);
        w.masterDoneAt = iso(now);
      }
      if (fc === 'empty') {
        save(row.id, s);
        finish(row, 'done');
        return;
      }
      w.step = 'join';
      w.joinUntil = iso(new Date(now.getTime() + UNLINK_JOIN_TTL_MS));
      save(row.id, s, 'join', w.joinUntil);
      return;
    }
    if (row.stage === 'join') {
      if (w.joinedAt !== null) {
        finish(row, 'done');
        return;
      }
      if (w.joinUntil !== null && Date.parse(w.joinUntil) <= now.getTime()) finish(row, 'expired');
    }
  };

  const tick = (): void => {
    const row = openRow();
    if (row === null) return;
    if (row.stage === 'answers') {
      if (row.expiresAt <= iso(d.now())) end(row.id, 'expired');
      return;
    }
    advance(row);
  };

  const need = (): Row => {
    tick();
    const row = openRow();
    if (row === null) throw new UnlinkError(409, 'stale_session');
    return row;
  };

  const bodyOf = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const sideOf = (v: unknown): UnlinkSide => {
    if (v !== 'master' && v !== 'follower') throw new UnlinkError(400, 'bad_message');
    return v;
  };
  const pinFresh = (s: UnlinkState, userId: string): boolean => {
    const at = s.pins[userId];
    return at !== undefined && d.now().getTime() - Date.parse(at) <= LINK_PIN_PROOF_TTL_MS;
  };

  /**
   * A follower left by itself (its local revert or emptying, D2), signed by its identity key: this box takes it off
   * at once, as "Tanggalkan" does, and an unlink of that box still at its answers ends. The change log keeps `left`, so
   * the list of boxes says "Pautan diputuskan dari kotak itu".
   */
  const followerLeft = (p: Record<string, unknown>, sig: unknown): { ok: true } | { ok: false; status: number; code: string } => {
    if (Object.keys(p).sort().join() !== 'boxId,event,linkId' || typeof p.boxId !== 'string' || typeof p.linkId !== 'string') return { ok: false, status: 400, code: 'bad_message' };
    const lb = db.prepare('SELECT device_id, public_jwk FROM linked_boxes WHERE link_id = ? AND box_id = ? AND removed_at IS NULL').get(p.linkId, p.boxId);
    const pub = parseJson(lb?.public_jwk) as BoxQrPub | null;
    if (lb === undefined || pub === null) return { ok: false, status: 404, code: 'not_found' };
    if (!verifyLink(pub, 'unlink-report', p.linkId, p, sig)) return { ok: false, status: 400, code: 'bad_message' };
    const deviceId = String(lb.device_id);
    const linkId = p.linkId;
    const fromBox = p.boxId;
    const at = iso(d.now());
    const open = openRow();
    tx(db, () => {
      db.prepare('DELETE FROM kiosk_cookies WHERE device_id = ?').run(deviceId);
      db.prepare('UPDATE linked_boxes SET removed_at = COALESCE(removed_at, ?) WHERE device_id = ?').run(at, deviceId);
      revokeDeviceRow(db, deviceId, 'system:unlink', at);
      db.prepare('INSERT INTO change_log (at, actor, entity, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, NULL, ?)')
        .run(at, 'system:unlink', 'link', linkId, JSON.stringify({ event: 'left', boxId: fromBox }));
    });
    if (open !== null && open.state.deviceId === deviceId && open.stage === 'answers') end(open.id, 'cancelled');
    d.changed?.();
    return { ok: true };
  };

  const status = (caller: UnlinkCaller | null): UnlinkStatus => {
    tick();
    const row = openRow();
    return { session: row === null ? null : viewOf(row, caller), last: lastOf(), kept: keptRows(d.dataDir, d.now()) };
  };

  return {
    status,
    writesBlocked() {
      const row = openRow();
      return row !== null && row.stage === 'working' && row.state.follower.choice === 'carry-on' && row.state.work?.copiedAt === null;
    },
    open: () => openRow() !== null,
    tick,

    start(caller, deviceIdIn) {
      if (d.isFollower()) throw new UnlinkError(409, 'not_linked');
      tick();
      if (openRow() !== null) throw new UnlinkError(409, 'unlink_open');
      const busy = d.busy();
      if (busy !== null) throw new UnlinkError(409, busy);
      const deviceId = typeof deviceIdIn === 'string' ? deviceIdIn : '';
      const lb = db.prepare('SELECT device_id, box_id, name, link_id FROM linked_boxes WHERE device_id = ? AND removed_at IS NULL').get(deviceId);
      if (lb === undefined) throw new UnlinkError(409, 'not_linked');
      const linkId = String(lb.link_id);
      const f = linkFacts(linkId);
      const followers = Number(db.prepare('SELECT COUNT(*) AS n FROM linked_boxes WHERE removed_at IS NULL').get()?.n ?? 0);
      // the follower's Pentadbir of link day, as people here who are still active
      const before = followerPeople(f).filter((m) => holdsSurauAdmin(m.peer.roles) && activeUser(m.userId) !== null).map((m) => m.userId);
      const dev = db.prepare('SELECT name FROM devices WHERE id = ?').get(deviceId);
      const state: UnlinkState = {
        v: 1, linkId, deviceId, followerBoxId: String(lb.box_id).split('#')[0]!,
        followerName: typeof dev?.name === 'string' && dev.name !== '' ? dev.name : String(lb.name),
        masterName: boxName(db, d.boxId).slice(0, 60),
        caseX: f.caseX, followerHadStore: f.peerHello?.setUp ?? true, masterAsked: followers <= 1,
        eligible: before.length > 0 ? 'before' : 'any', before: [...new Set(before)], rev: 1,
        master: emptySide(), follower: emptySide(), pins: { [caller.userId]: iso(d.now()) }, work: null,
      };
      const id = randomBytes(16).toString('hex');
      const at = d.now();
      db.prepare(
        `INSERT INTO link_sessions (id, kind, role, peer_box_id, step, answers_json, answers_rev, pin_proof_at, pin_proof_user, started_at, expires_at)
         VALUES (?, 'unlink', 'show', ?, 'answers', ?, 1, ?, ?, ?, ?)`,
      ).run(id, state.followerBoxId, JSON.stringify(state), iso(at), caller.userId, iso(at), touch());
      return status(caller);
    },

    provePin(userId) {
      const row = openRow();
      if (row === null) return;
      row.state.pins[userId] = iso(d.now());
      save(row.id, row.state);
    },

    answer(caller, input) {
      const row = need();
      if (row.stage !== 'answers') throw new UnlinkError(409, 'stale_session');
      const b = bodyOf(input);
      const side = sideOf(b.side);
      const choice = b.choice;
      if (choice !== 'back' && choice !== 'carry-on' && choice !== 'empty') throw new UnlinkError(400, 'bad_message');
      const s = row.state;
      const refusal = mayAnswerFor(s, side, caller);
      if (refusal !== null) throw new UnlinkError(refusal === 'same_phone' ? 409 : 403, refusal);
      const v = sideView(row, side, caller);
      const ok = choice === 'back' ? v.options.back.available : choice === 'carry-on' ? v.options.carryOn.available : v.options.empty.available;
      if (!ok) throw new UnlinkError(409, 'option_unavailable');
      if (b.removePeople !== undefined && typeof b.removePeople !== 'boolean') throw new UnlinkError(400, 'bad_message');
      if (b.financeTick !== undefined && typeof b.financeTick !== 'boolean') throw new UnlinkError(400, 'bad_message');
      const u = activeUser(caller.userId)!;
      s[side] = {
        choice, by: caller.userId, byDevice: caller.deviceId, byName: u.name, agreedRev: null,
        removePeople: side === 'master' && choice === 'carry-on' && b.removePeople === true,
        financeTick: side === 'follower' && choice === 'carry-on' && b.financeTick === true,
      };
      // every agreement counts for one revision only
      s.rev += 1;
      s.master.agreedRev = null;
      s.follower.agreedRev = null;
      save(row.id, s, undefined, touch());
      return status(caller);
    },

    agree(caller, input) {
      const row = need();
      if (row.stage !== 'answers') throw new UnlinkError(409, 'stale_session');
      const b = bodyOf(input);
      const side = sideOf(b.side);
      const s = row.state;
      const st = s[side];
      if (b.rev !== s.rev) throw new UnlinkError(409, 'stale_revision');
      if (st.choice === null || st.by !== caller.userId || st.byDevice !== caller.deviceId) throw new UnlinkError(403, 'not_allowed_to_answer');
      const refusal = mayAnswerFor(s, side, caller);
      if (refusal !== null) throw new UnlinkError(refusal === 'same_phone' ? 409 : 403, refusal);
      if (side === 'follower' && st.choice === 'carry-on' && !st.financeTick) throw new UnlinkError(409, 'finance_tick');
      if ((st.choice === 'back' || st.choice === 'empty') && b.confirm !== true) throw new UnlinkError(409, 'confirm_required');
      if (!pinFresh(s, caller.userId)) throw new UnlinkError(409, 'pin_required');
      st.agreedRev = s.rev;
      save(row.id, s, undefined, touch());
      const all = s.follower.agreedRev === s.rev && (!s.masterAsked || s.master.agreedRev === s.rev);
      if (all) startWork(openRow()!);
      return status(caller);
    },

    cancel(caller) {
      void caller;
      const row = openRow();
      if (row === null) return;
      if (row.stage !== 'answers') throw new UnlinkError(409, 'linking');
      end(row.id, 'cancelled');
    },

    orderFor(boxId, linkId) {
      // The latest unlink of that follower, open or ended: a follower that asks late (it was off when the work timed
      // out) still gets the order it was given, never the `forget` a removed row would otherwise answer.
      const row = rowOf(db.prepare("SELECT * FROM link_sessions WHERE kind = 'unlink' AND peer_box_id = ? ORDER BY started_at DESC LIMIT 1").get(boxId));
      if (row === null || row.state.linkId !== linkId || row.state.work === null || row.outcome === 'cancelled') return null;
      const w = row.state.work;
      if (row.finishedAt === null && w.fetchedAt === null) {
        w.fetchedAt = iso(d.now());
        save(row.id, row.state);
        // an empty follower forgets; nothing else is asked of it
        advance(openRow()!);
      }
      if (w.order === null) return null;
      return { order: w.order.step === 'order-revert' ? 'revert' : 'standalone', body: w.order.body, sig: w.order.sig };
    },

    peerReport(body) {
      const m = bodyOf(body);
      const p = bodyOf(m.body);
      if (p.event === 'left') return followerLeft(p, m.sig);
      const row = openRow();
      if (row === null || row.stage === 'answers' || row.state.work === null) return { ok: false, status: 409, code: 'stale_session' };
      const s = row.state;
      if (p.unlinkId !== row.id || p.boxId !== s.followerBoxId || (p.event !== 'copied' && p.event !== 'joined')) return { ok: false, status: 400, code: 'bad_message' };
      if (Object.keys(p).sort().join() !== 'boxId,event,unlinkId') return { ok: false, status: 400, code: 'bad_message' };
      const lb = db.prepare('SELECT public_jwk FROM linked_boxes WHERE device_id = ?').get(s.deviceId);
      const pub = parseJson(lb?.public_jwk) as BoxQrPub | null;
      if (pub === null || !verifyLink(pub, 'unlink-report', s.linkId, p, m.sig)) return { ok: false, status: 400, code: 'bad_message' };
      const w = s.work!;
      const at = iso(d.now());
      if (p.event === 'copied' && (s.follower.choice !== 'carry-on' || row.stage !== 'working')) return { ok: false, status: 409, code: 'stale_session' };
      if (p.event === 'copied' && w.copiedAt === null) {
        w.copiedAt = at;
        w.step = 'carry-on';
      }
      if (p.event === 'joined' && w.joinedAt === null) {
        if (row.stage !== 'join') return { ok: false, status: 409, code: 'stale_session' };
        w.joinedAt = at;
        // the phone that answered for the follower belongs to the follower now
        const dev = s.follower.byDevice;
        if (dev !== null) revokeDeviceRow(db, dev, 'system:unlink', at);
      }
      save(row.id, s);
      advance(openRow()!);
      return { ok: true };
    },

    copyFor(body) {
      const m = bodyOf(body);
      const p = bodyOf(m.body);
      const row = openRow();
      if (row === null || row.stage !== 'working' || row.state.follower.choice !== 'carry-on' || row.state.work?.fetchedAt == null) return null;
      if (row.state.work.copiedAt !== null) return null;
      const s = row.state;
      // the older release sends no `page` (page 0 only): `boxId,unlinkId` or `boxId,freeBytes,unlinkId`
      const keys = Object.keys(p).sort().join();
      if (keys !== 'boxId,page,unlinkId' && keys !== 'boxId,freeBytes,page,unlinkId' && keys !== 'boxId,unlinkId' && keys !== 'boxId,freeBytes,unlinkId') return null;
      const legacy = !keys.includes('page');
      const page = requestedPage(p.page);
      if (page === null) return null;
      if (p.unlinkId !== row.id || p.boxId !== s.followerBoxId) return null;
      const free = p.freeBytes;
      if (free !== undefined && free !== null && !(Number.isSafeInteger(free) && (free as number) >= 0)) return null;
      const lb = db.prepare('SELECT public_jwk FROM linked_boxes WHERE device_id = ?').get(s.deviceId);
      const pub = parseJson(lb?.public_jwk) as BoxQrPub | null;
      if (pub === null || !verifyLink(pub, 'store-list', s.linkId, m.body, m.sig)) return null;
      // the follower's people of link day still active here, with the id they had there; and the person who answered
      const f = linkFacts(s.linkId);
      const people = new Map<string, string | null>();
      for (const { userId, peer } of followerPeople(f)) if (!people.has(userId) && activeUser(userId) !== null) people.set(userId, peer.id);
      if (s.follower.by !== null && !people.has(s.follower.by) && activeUser(s.follower.by) !== null) people.set(s.follower.by, null);
      return { state: s, id: row.id, people, freeBytes: typeof free === 'number' ? free : null, page, legacy };
    },

    copyOpen(unlinkId) {
      const row = openRow();
      return row !== null && row.id === unlinkId && row.stage === 'working' && row.state.follower.choice === 'carry-on' && row.state.work?.copiedAt === null;
    },

    copyBuilt(unlinkId, videosNotFit) {
      const row = openRow();
      if (row === null || row.id !== unlinkId || row.state.work === null) return;
      row.state.work.videosNotFit = videosNotFit.slice(0, MAX_NAMES);
      save(row.id, row.state);
    },

    copyProgress(unlinkId, percent) {
      const row = openRow();
      if (row === null || row.id !== unlinkId) return;
      pct = Math.max(0, Math.min(99, Math.floor(percent)));
    },

    kioskView() {
      const row = openRow();
      if (row === null || row.state.work === null) return null;
      return { step: row.state.work.step, percent: row.state.work.step === 'copy' ? pct : null };
    },
  };
}
