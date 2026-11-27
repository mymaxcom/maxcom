import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { holdsSurauAdmin, linkCase, OPS_ROLES } from '@surau/core';
import type { LinkCase, LinkHello, LinkPerson } from '@surau/core';
import { randomToken, sha256hex } from '../auth/crypto.ts';
import { newCode, normaliseCode } from '../auth/devices.ts';
import { assignNewNo } from '../auth/ids.ts';
import { DEFAULT_FLOOR_BYTES } from '../follow/cache.ts';
import { MIGRATIONS } from '../migrations/index.ts';
import { newRecoveryCode } from '../setup/codes.ts';
import { carryOf, commitAdopt, dropAdoptPlan, openCrossing, planAdopt } from './adopt.ts';
import type { AdoptTicket } from './adopt.ts';
import { collectPages, pullStore, stageDirOf, StoreMoveError, sweepStage } from './storeMove.ts';
import { logChange, revokeDeviceRow, tx } from '../auth/users.ts';
import type { FollowRecord, FollowStore } from '../follow/store.ts';
import type { BoxIdentity } from '../setup/identity.ts';
import { openWithBoxKey, sealToBoxKey, sealedRe } from '../sync/boxSeal.ts';
import { markCloudSleep } from '../sync/resetFromBox.ts';
import { applyMerge, TICKET_TTL_MS, undoMerge } from './people.ts';
import type { LinkSessionRow, LinkSessions } from './session.ts';

/**
 * What the two boxes do after both admins agreed: the master makes the follower's TV token, hands it over sealed,
 * and the follower stores who it follows. SECURITY code.
 *
 * Cases S and N-S (the kept data is the master's own): below. Cases X and N-X (the follower's store moves to the
 * master, `storeWork`): the master pulls the store into its stage, plans the adopt (`adopt.ts`), sends the same
 * commit, and on the follower's 200 writes the adopt journal and starts again; the adopt runs at that start.
 * `CASE_X_READY` is the one switch.
 *
 * Order, and what a failure at each point leaves:
 * 1. the master's backup (hook; a failure ends the link, nothing changed);
 * 2. (progress step only) the people merge: done INSIDE the transaction of step 3 (`people.ts`), so the two land
 *    or fail together;
 * 3. the master merges the follower's people and makes the follower's TV device row, its token (only the hash is
 *    stored) and the `linked_boxes` row, in one transaction;
 * 4. the master sends `commit` signed, with the token and the phone-move tickets sealed to the follower's identity key;
 * 5. COMMIT POINT of the follower: it keeps the phone-move list, plans the set-aside of its own store (when it had
 *    one), writes its follow record and answers 200. The master then ends the session as `linked`. No answer: the
 *    master removes the rows of step 3, takes the merge back, and both boxes stay as they were.
 */
export const CASE_X_READY = true;

const FOLLOW_SEAL_LABEL = 'maxcom-link-commit-v1';
// the token plus up to 500 phone-move tickets
const SEALED = sealedRe(48 * 1024);
/** A follower's token does not run out by time: it ends when the master revokes the device row. */
const TOKEN_TTL_MS = 100 * 365 * 24 * 3600_000;
const WORK_TIMEOUT_MS = 10 * 60 * 1000;
/** Cases X / N-X: how long the giver may take to copy and hash its store before the link gives up. */
const LIST_TIMEOUT_MS = 30 * 60 * 1000;
const LIST_POLL_MS = 2000;
/** Cases X and N-X: the giver's linking admin's one-time move ticket to the master (the only Pentadbir ticket there is). */
const ADMIN_TICKET_TTL_MS = 30 * 60 * 1000;

/** SECURITY. The giver's linking admin gets a ticket only when it is an admin person of the list the giver sent. */
export function isGiverAdmin(giverAdmin: string, other: readonly LinkPerson[]): boolean {
  const person = other.find((p) => p.id === giverAdmin);
  return person !== undefined && holdsSurauAdmin(person.roles);
}

export type LinkWorkStep = 'backup' | 'people' | 'commit' | 'finish';
export interface LinkProgress {
  linkId: string;
  step: LinkWorkStep;
  /** 1-based place of `step` in the list of steps of this case. */
  stepNo: number;
  steps: number;
  percent: number | null;
}

export interface LinkWorkDeps {
  db: DatabaseSync;
  boxId: string;
  identity: BoxIdentity;
  surauId: string;
  now: () => Date;
  sessions: () => LinkSessions;
  follow: FollowStore;
  /** Called after this box became a follower or stopped being one: the process starts again in its new mode. */
  restart?: () => void;
  /** Tells every screen of this box that the list of TVs changed. */
  changed?: () => void;
  /** Phase 2A: the kept-data master's own backup, taken once before its first follower. Throws to stop the link. */
  masterBackup?: (s: LinkSessionRow) => Promise<void>;
  /** Phase 2A: plans the set-aside of this box's store, done at the next start BEFORE the database is opened. */
  planSetAside?: (linkId: string) => void;
  /** Phase 2C: the follower keeps the list of its phones that may move to the master (`follow/moves.ts`). */
  keepMoves?: (moves: { linkId: string; tickets: Record<string, string>; expiresAt: string; expiries?: Record<string, string> }) => void;
  /** Removes that list again: a commit this box refuses leaves no plain ticket on its disk. */
  dropMoves?: () => void;
  /** Cases X / N-X (the master side): the data folder, the giver's file reader and the free space. */
  dataDir?: string | null;
  fetchStoreFile?: (s: LinkSessionRow, path: string, start: number, token: string) => Promise<IncomingMessage>;
  freeBytes?: () => number | null;
  sleep?: (ms: number) => Promise<void>;
}

export interface LinkWork {
  onAgreed(s: LinkSessionRow): void;
  onCommit(s: LinkSessionRow, body: Record<string, unknown>): boolean;
  recoverAgreed(s: LinkSessionRow): string;
  progress(): LinkProgress | null;
  /** Resolves when no work is running (tests). */
  idle(): Promise<void>;
}

const sidesOf = (s: LinkSessionRow): { show: LinkHello; scan: LinkHello } =>
  s.role === 'show' ? { show: s.ownHello, scan: s.peerHello! } : { show: s.peerHello!, scan: s.ownHello };

export function caseOf(s: LinkSessionRow): LinkCase | null {
  if (s.answers === null || s.peerHello === null) return null;
  const b = sidesOf(s);
  return linkCase(s.answers, b.show, b.scan);
}

const commitAad = (linkId: string, followerBoxId: string, masterBoxId: string): string => `${linkId}|${followerBoxId}|${masterBoxId}`;

export function createLinkWork(d: LinkWorkDeps): LinkWork {
  const { db } = d;
  let progress: LinkProgress | null = null;
  let running: Promise<void> = Promise.resolve();
  /** Cases X / N-X: the master starts again after the commit, so the adopt runs before its database opens. */
  let restartAfter = false;
  const iso = (): string => d.now().toISOString();

  const removeFollowerRows = (deviceId: string, linkId: string): void => {
    tx(db, () => {
      db.prepare('DELETE FROM kiosk_cookies WHERE device_id = ?').run(deviceId);
      db.prepare('DELETE FROM linked_boxes WHERE device_id = ?').run(deviceId);
      revokeDeviceRow(db, deviceId, 'system:link', iso());
      undoMerge(db, linkId, 'system:link', d.now());
    });
  };

  const masterWork = async (s: LinkSessionRow): Promise<string> => {
    const peer = s.peerHello!;
    const steps = 4;
    const at = (step: LinkWorkStep, stepNo: number): void => {
      progress = { linkId: s.id, step, stepNo, steps, percent: null };
    };
    const c = caseOf(s);
    if (c === null) return 'failed';
    if ((c === 'X' || c === 'N-X') && !CASE_X_READY) return 'case_x_unavailable';
    if (c === 'X' || c === 'N-X') return storeWork(s, c);
    const owner = s.pinProofUser;
    if (owner === null) return 'failed';

    at('backup', 1);
    if (c === 'S' && d.masterBackup !== undefined) await d.masterBackup(s);
    at('people', 2);
    const other = s.peerPeople;
    if (other === null) return 'failed';

    at('commit', 3);
    const deviceId = randomToken(12);
    const token = randomToken(32);
    const linkedAt = iso();
    const merged = tx(db, () => {
      const m = applyMerge(db, {
        linkId: s.id, surauId: d.surauId, fromBoxId: peer.boxId, fromName: peer.name, other,
        answers: { roles: s.answers!.roles, same: s.answers!.same, phones: s.answers!.phones }, owner, now: d.now(),
      });
      // A box that was linked before and taken off keeps its old row for the log; the new link takes the box id over.
      db.prepare('UPDATE linked_boxes SET box_id = box_id || ? WHERE box_id = ? AND removed_at IS NOT NULL').run(`#${s.id.slice(0, 8)}`, peer.boxId);
      db.prepare(`INSERT INTO devices (id, user_id, name, platform, public_jwk, enrolled_at, surau_id) VALUES (?, ?, ?, 'kiosk', NULL, ?, ?)`)
        .run(deviceId, owner, peer.name.slice(0, 80), linkedAt, d.surauId);
      assignNewNo(db, 'device', deviceId, d.surauId);
      db.prepare('INSERT INTO kiosk_cookies (token_hash, device_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(sha256hex(token), deviceId, linkedAt, new Date(d.now().getTime() + TOKEN_TTL_MS).toISOString());
      db.prepare(
        `INSERT INTO linked_boxes (device_id, box_id, key_fp, public_jwk, name, local_name, addresses_json, version, linked_at, link_id)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      ).run(deviceId, peer.boxId, peer.keyFp, JSON.stringify(peer.pub), peer.name, JSON.stringify(peer.addresses), peer.release, linkedAt, s.id);
      logChange(db, `user:${owner}`, 'devices', deviceId, undefined, { id: deviceId, userId: owner, name: peer.name, platform: 'kiosk', revoked: false, linkId: s.id }, undefined, d.surauId);
      return m;
    });
    let taken = false;
    try {
      const sealed = sealToBoxKey(peer.pub, JSON.stringify({ token, deviceId, tickets: merged.tickets, ticketsExpireAt: merged.ticketsExpireAt }), FOLLOW_SEAL_LABEL, commitAad(s.id, peer.boxId, d.boxId));
      const res = await d.sessions().sendSigned(s.id, 'commit', { sealed, linkedAt });
      taken = res.status === 200;
    } catch {
      taken = false;
    }
    if (!taken) {
      removeFollowerRows(deviceId, s.id);
      return 'failed';
    }
    at('finish', 4);
    return 'linked';
  };

  /**
   * Cases X and N-X at the master. Nothing in this box's store changes here: the received store waits in the stage
   * and the adopt plan in a sealed file; only the follower's 200 to the commit makes the journal that adopts it at
   * the next start. Any failure before that removes the stage and the plan.
   */
  const storeWork = async (s: LinkSessionRow, c: 'X' | 'N-X'): Promise<string> => {
    const peer = s.peerHello!;
    const dataDir = d.dataDir ?? null;
    const fetchFile = d.fetchStoreFile;
    if (dataDir === null || fetchFile === undefined) return 'failed';
    const steps = 4;
    const at = (step: LinkWorkStep, stepNo: number, percent: number | null = null): void => {
      progress = { linkId: s.id, step, stepNo, steps, percent };
    };
    const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let committed = false;
    try {
      // 1. this box's backup is its own store, set aside at the adopt (case X); a new box has none
      at('backup', 1);
      at('people', 2);
      const other = s.peerPeople;
      if (other === null) return 'failed';

      // 3. the giver copies and lists its store; this box pulls it (percent on the commit step)
      at('commit', 3, 0);
      const deadline = d.now().getTime() + LIST_TIMEOUT_MS;
      let ready: { first: unknown; token: unknown; admin: unknown; secrets: unknown } | null = null;
      while (ready === null) {
        const r = await d.sessions().sendSigned(s.id, 'store-list', { page: 0 });
        const j = (typeof r.json === 'object' && r.json !== null ? r.json : {}) as Record<string, unknown>;
        if (r.status !== 200) return 'failed';
        if (j.state === 'ready') ready = { first: j, token: j.token, admin: j.admin, secrets: j.secrets };
        else if (j.state !== 'preparing' || d.now().getTime() > deadline) return 'failed';
        else await sleep(LIST_POLL_MS);
      }
      // the list comes in pages of at most 2,000 entries; the rest of the pages follow page 0
      const list = await collectPages(ready.first, async (page) => {
        const r = await d.sessions().sendSigned(s.id, 'store-list', { page });
        if (r.status !== 200) throw new StoreMoveError('peer');
        const j = (typeof r.json === 'object' && r.json !== null ? r.json : {}) as Record<string, unknown>;
        if (j.state !== 'ready') throw new StoreMoveError('peer');
        return j;
      }, s.id);
      // the two databases must be at one level (L1): the received one is opened as it is
      if (list.dbLevel !== MIGRATIONS.length || typeof ready.token !== 'string') return 'failed';
      const token = ready.token;
      await pullStore({
        list, stageDir: stageDirOf(dataDir, s.id),
        fetch: (path, start) => fetchFile(s, path, start, token),
        freeBytes: d.freeBytes ?? (() => null),
        floorBytes: DEFAULT_FLOOR_BYTES,
        onProgress: (done, total) => at('commit', 3, total <= 0 ? 99 : Math.min(99, Math.floor((done * 100) / total))),
      });

      // who the follower's TV row is made for: this box's PIN-proof admin (X), else the giver's linking admin
      const giverAdmin = typeof ready.admin === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(ready.admin) ? ready.admin : null;
      const owner = c === 'X' ? (s.pinProofUser ?? giverAdmin) : giverAdmin;
      if (owner === null) return 'failed';

      // the phone-move tickets for the giver's people (its phones are revoked by the adopt), as in case S
      const now = d.now();
      const expiresAt = new Date(now.getTime() + TICKET_TTL_MS).toISOString();
      const tickets: Record<string, string> = {};
      const carried: AdoptTicket[] = [];
      // each ticket's own end, sent with the tickets so the phone is told the true expiry of its own ticket
      const expiries: Record<string, string> = {};
      const give = (userId: string, expires: string): void => {
        const code = newCode();
        tickets[userId] = code;
        expiries[userId] = expires;
        carried.push({ userId, codeHash: sha256hex(normaliseCode(code)), deviceName: `Telefon dari ${peer.name}`.slice(0, 80), expiresAt: expires });
      };
      // Q3 "Telefon pengguna Box ini": 'direct' gives every person with a phone a ticket, admins included, with the same
      // long life (both admins agreed with their PIN); 'code' leaves the admins to a join code from an admin of the master.
      const direct = s.answers!.phones === 'direct';
      for (const p of other) {
        if (p.devices > 0 && (direct || !holdsSurauAdmin(p.roles)) && !p.roles.some((r) => OPS_ROLES.includes(r))) give(p.id, expiresAt);
      }
      // The giver's LINKING admin (the one who proved a PIN at the giver in this link) gets a 30-minute, one-use admin
      // ticket, in both cases. N-X: without it the new master would have no admin phone at all. X: this admin agreed
      // to the link and would otherwise have to ask the master's admin for a join code. Any other admin of the giver
      // gets none, unless the admins chose 'direct' above: a Pentadbir ticket is then given to every admin with a phone.
      // The id comes from the giver: it must be a person of the list the giver sent and hold the Pentadbir role, or no
      // ticket is made (a buggy or hostile giver cannot name just anyone).
      if (giverAdmin !== null && tickets[giverAdmin] === undefined) {
        if (isGiverAdmin(giverAdmin, other)) give(giverAdmin, new Date(now.getTime() + ADMIN_TICKET_TTL_MS).toISOString());
        else console.log(`Link: no admin ticket for the giver's linking admin (not an admin of the list it sent) ${s.id.slice(0, 8)}`);
      }

      const deviceId = randomToken(12);
      const followerToken = randomToken(32);
      const linkedAt = now.toISOString();
      planAdopt(dataDir, d.identity, {
        v: 1, linkId: s.id, case: c, boxId: d.boxId, ...carryOf(db, now, s.id),
        follower: {
          deviceId, tokenHash: sha256hex(followerToken), tokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS).toISOString(), owner,
          boxId: peer.boxId, keyFp: peer.keyFp, pub: peer.pub, name: peer.name, addresses: peer.addresses, release: peer.release, linkedAt,
        },
        tickets: carried,
        recovery: newRecoveryCode(),
        files: list.files,
        ...openCrossing(d.identity, ready.secrets, s.id, peer.boxId, d.boxId),
      });

      let taken = false;
      try {
        const sealed = sealToBoxKey(peer.pub, JSON.stringify({ token: followerToken, deviceId, tickets, ticketsExpireAt: expiresAt, ticketsExpiry: expiries }), FOLLOW_SEAL_LABEL, commitAad(s.id, peer.boxId, d.boxId));
        const res = await d.sessions().sendSigned(s.id, 'commit', { sealed, linkedAt });
        taken = res.status === 200;
      } catch {
        taken = false;
      }
      if (!taken) return 'failed';
      // COMMIT POINT of this box: the giver follows it now; the next start adopts the received store
      commitAdopt(dataDir, s.id, d.now());
      committed = true;
      at('finish', 4);
      restartAfter = true;
      return 'linked';
    } catch {
      return 'failed';
    } finally {
      if (!committed) {
        try {
          dropAdoptPlan(dataDir);
          sweepStage(dataDir, null);
        } catch {
          // left for the sweep at the next start
        }
      }
    }
  };

  const run = (s: LinkSessionRow, work: () => Promise<string>): void => {
    if (!d.sessions().markWorking(s.id)) return;
    running = running.then(async () => {
      let outcome = 'failed';
      try {
        outcome = await work();
      } catch {
        outcome = 'failed';
      }
      // Tell the waiting follower that nothing will come, so it does not hold its writes until the timer.
      if (outcome !== 'linked') await d.sessions().sendSigned(s.id, 'cancel', { reason: 'failed' }).catch(() => undefined);
      d.sessions().finish(outcome);
      progress = null;
      if (outcome === 'linked') d.changed?.();
      if (outcome === 'linked' && restartAfter && d.restart !== undefined) {
        restartAfter = false;
        const t = setTimeout(d.restart, 750);
        t.unref();
      }
    });
  };

  return {
    onAgreed(s) {
      if (s.answers === null || s.peerHello === null) return;
      if (s.answers.master === s.role) {
        run(s, () => masterWork(s));
        return;
      }
      // The follower waits for the master's signed commit; without one in time nothing changed here.
      if (!d.sessions().markWorking(s.id)) return;
      progress = { linkId: s.id, step: 'commit', stepNo: 3, steps: 4, percent: null };
      const timer = setTimeout(() => {
        if (d.sessions().current()?.id === s.id) {
          d.sessions().finish('failed');
          progress = null;
        }
      }, WORK_TIMEOUT_MS);
      timer.unref();
    },

    onCommit(s, body) {
      const peer = s.peerHello;
      if (peer === null || d.follow.present()) return false;
      let inner: { token?: unknown; deviceId?: unknown; tickets?: unknown; ticketsExpireAt?: unknown; ticketsExpiry?: unknown };
      try {
        inner = JSON.parse(openWithBoxKey(d.identity.privateJwk, String(body.sealed), FOLLOW_SEAL_LABEL, commitAad(s.id, d.boxId, peer.boxId), SEALED)) as typeof inner;
      } catch {
        return false;
      }
      const linkedAt = typeof body.linkedAt === 'string' && !Number.isNaN(Date.parse(body.linkedAt)) ? body.linkedAt : iso();
      const rec: FollowRecord = {
        v: 1, linkId: s.id, masterBoxId: peer.boxId, masterKeyFp: peer.keyFp, masterPub: peer.pub, masterCa: peer.caSha256,
        masterName: peer.name, addresses: peer.addresses, token: String(inner.token), deviceId: String(inner.deviceId),
        linkedAt, hadStore: s.ownHello.setUp,
      };
      const tickets: Record<string, string> = {};
      if (typeof inner.tickets === 'object' && inner.tickets !== null && !Array.isArray(inner.tickets)) {
        for (const [k, v] of Object.entries(inner.tickets as Record<string, unknown>)) if (typeof v === 'string' && v.length <= 20) tickets[k] = v;
      }
      // an optional end per ticket (older boxes send none: the one end above then holds for all)
      const expiries: Record<string, string> = {};
      if (typeof inner.ticketsExpiry === 'object' && inner.ticketsExpiry !== null && !Array.isArray(inner.ticketsExpiry)) {
        for (const [k, v] of Object.entries(inner.ticketsExpiry as Record<string, unknown>)) {
          if (k in tickets && typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v))) expiries[k] = v;
        }
      }
      const ticketsExpireAt = typeof inner.ticketsExpireAt === 'string' && !Number.isNaN(Date.parse(inner.ticketsExpireAt)) ? inner.ticketsExpireAt : linkedAt;
      try {
        // The phone-move list first, from this box's own people while its store is still open (it is set aside at
        // the next start). Then the plan: a set-aside with no follow record is dropped at the next start, the reverse would leave
        // a follower still serving its old store.
        if (s.ownHello.setUp && d.planSetAside === undefined) return false;
        if (Object.keys(tickets).length > 0 && d.keepMoves !== undefined) d.keepMoves({ linkId: s.id, tickets, expiresAt: ticketsExpireAt, ...(Object.keys(expiries).length > 0 ? { expiries } : {}) });
        if (s.ownHello.setUp) d.planSetAside!(s.id);
        d.follow.write(rec);
      } catch {
        // refused: the tickets this box was given must not stay on its disk
        try {
          d.dropMoves?.();
        } catch {
          // nothing more to do; the moves route answers only while a follow record exists
        }
        return false;
      }
      // A box that was linked to the cloud tells it, once, that its surau now sleeps. Its own sync key is set aside at
      // the next start, so what the call needs is kept now, sealed (`sync/resetFromBox.ts`). A failure here never
      // fails the commit: the cloud copy then just keeps taking this box's old data.
      if (d.dataDir != null) {
        try {
          markCloudSleep(d.dataDir, s.id, d.boxId);
        } catch {
          console.log('Link: could not keep the note to put the cloud copy to sleep');
        }
      }
      d.sessions().finish('linked');
      progress = null;
      d.changed?.();
      if (d.restart !== undefined) {
        const t = setTimeout(d.restart, 750);
        t.unref();
      }
      return true;
    },

    recoverAgreed(s) {
      if (s.answers !== null && s.answers.master !== s.role) return d.follow.read()?.linkId === s.id ? 'linked' : 'failed';
      const row = db.prepare('SELECT 1 AS x FROM linked_boxes WHERE link_id = ? AND removed_at IS NULL').get(s.id);
      return row !== undefined ? 'linked' : 'failed';
    },

    progress: () => progress,
    idle: () => running,
  };
}
