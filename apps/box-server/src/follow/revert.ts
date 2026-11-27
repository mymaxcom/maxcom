import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isDirectLoopback } from '../auth/authz.ts';
import type { PinnedClient } from '../link/peerClient.ts';
import { backupDirOf, backupOf, planForget, planRestore, writeFileAtomic } from '../link/setAside.ts';
import { signLink } from '../link/sign.ts';
import { verifyRecoveryCode } from '../setup/codes.ts';
import { noteKeptByRestore } from '../link/unlink.ts';
import { clearUnlinkNote } from './unlinkNote.ts';
import type { BoxIdentity } from '../setup/identity.ts';
import type { FollowRecord, FollowStore } from './store.ts';

/**
 * A follower leaves BY ITSELF (multi-box phase 2D, D2): the master is dead, stolen or gone. SECURITY code.
 *
 * Only on the box itself (the Android maintenance screen calls the loopback address directly; `not_local` for any
 * other caller, the surau Wi-Fi included; 400, as every public row refuses):
 * - `POST /api/follow/revert {recoveryCode}`: "Putuskan pautan dan kembali ke data sebelum dipautkan". The code is the
 *   box's recovery code from BEFORE the link, checked against the backup's own database opened read-only (the store
 *   in use while following holds no code). Five wrong codes in an hour lock it for the hour (429 `locked`); the count
 *   lives outside the store. Then the restore of the backup at the next start; that start revokes every phone of the
 *   backup and the admin joins with the recovery code, as after any restore.
 * - `POST /api/follow/empty`: a follower that was a new box (no backup) can only be emptied: first setup again.
 *   409 `has_backup` for a box with a backup (it reverts instead).
 *
 * Both routes also need the per-start leave secret (O20, gate S3): the Android service makes 64 hex at each start,
 * hands it to this process as env `SURAU_LEAVE_SECRET` and gives it to the maintenance screen, which sends it as
 * header `X-Maxcom-Leave`. Any other app or process on the same phone can reach loopback but does not hold it. It is
 * compared in constant time BEFORE any other check; without the env (or a malformed one) both routes refuse (fail
 * closed). A wrong or missing header answers 400 `not_local`, like every other refusal of these public rows.
 *
 * Either way the box tells its master once, best effort, signed with its identity key, that it left (`left`): a
 * master that is still there takes it off its list and shows "Pautan diputuskan dari kotak itu".
 */
export const REVERT_ATTEMPTS_REL = 'link-revert-attempts.json';
const MAX_FAILS = 5;
const WINDOW_MS = 3600_000;

export const LEAVE_HEADER = 'x-maxcom-leave';

/** SURAU_LEAVE_SECRET as bytes: exactly 64 hex characters, else null (the routes then refuse everything). Never logged. */
export function parseLeaveSecret(value: string | undefined | null): Buffer | null {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) return null;
  return Buffer.from(value.toLowerCase(), 'utf8');
}

/** True when the request carries the leave secret (constant-time compare on equal-length buffers). */
export function leaveSecretAccepts(secret: Buffer | null, request: FastifyRequest): boolean {
  if (secret === null) return false;
  const given = request.headers[LEAVE_HEADER];
  if (typeof given !== 'string' || given.length !== secret.length) return false;
  const buf = Buffer.from(given.toLowerCase(), 'utf8');
  return buf.length === secret.length && timingSafeEqual(buf, secret);
}

export interface FollowRevertDeps {
  /** The per-start leave secret (64 hex). Null or malformed: both routes refuse (fail closed). */
  leaveSecret: string | null;
  dataDir: string | null;
  boxId: string;
  identity: BoxIdentity;
  follow: FollowStore;
  now: () => Date;
  /** This box's own name (the kept note shows it; never empty there). */
  ownName?: () => string;
  restart?: () => void;
  /** The channel to the master for the `left` note; failures are ignored. */
  client?: Pick<PinnedClient, 'json'>;
}

function readFails(dataDir: string): string[] {
  try {
    const v = JSON.parse(readFileSync(join(dataDir, REVERT_ATTEMPTS_REL), 'utf8')) as { fails?: unknown };
    return Array.isArray(v.fails) ? v.fails.filter((x): x is string => typeof x === 'string').slice(-50) : [];
  } catch {
    return [];
  }
}

/** The recovery code against the backup's database, opened read-only; false when it cannot be read. */
export function backupRecoveryMatches(dataDir: string, linkId: string, code: string): boolean {
  let bdb: DatabaseSync | null = null;
  try {
    bdb = new DatabaseSync(join(backupDirOf(dataDir, linkId), 'surau.db'), { readOnly: true });
    return verifyRecoveryCode(bdb, code);
  } catch {
    return false;
  } finally {
    try {
      bdb?.close();
    } catch {
      // nothing more to do
    }
  }
}

/** Best effort: tells the master this box left by itself. */
export async function tellMasterLeft(client: Pick<PinnedClient, 'json'>, identity: BoxIdentity, boxId: string, rec: FollowRecord): Promise<boolean> {
  const body = { boxId, linkId: rec.linkId, event: 'left' };
  const msg = { body, sig: signLink(identity, 'unlink-report', rec.linkId, body) };
  for (const origin of rec.addresses) {
    try {
      const r = await client.json(origin, rec.masterCa, {
        method: 'POST', path: '/api/unlink/peer/report', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg), timeoutMs: 5000,
      });
      if (r.status === 200) return true;
    } catch {
      // the next address
    }
  }
  return false;
}

export function registerFollowRevertRoutes(app: FastifyInstance, d: FollowRevertDeps): void {
  const small = { bodyLimit: 2 * 1024 } as const;
  const secret = parseLeaveSecret(d.leaveSecret);
  const refuse = (reply: FastifyReply, status: number, code: string, extra?: Record<string, unknown>): FastifyReply =>
    reply.code(status).header('Cache-Control', 'no-store').send({ ...(extra ?? {}), code, errors: [code] });

  /** The box itself, a follower, with a data folder. Null when it may go on. */
  const gate = (request: FastifyRequest, reply: FastifyReply): { dataDir: string; rec: FollowRecord } | FastifyReply => {
    reply.header('Cache-Control', 'no-store');
    // 400, not 403: a public row never answers with the hook's generic deny (security.test role matrix)
    // the secret first: nothing else is read or looked at for a caller that does not hold it
    if (!leaveSecretAccepts(secret, request)) return refuse(reply, 400, 'not_local');
    if (!isDirectLoopback(request)) return refuse(reply, 400, 'not_local');
    const rec = d.follow.read();
    if (rec === null || d.dataDir === null) return refuse(reply, 404, 'not_found');
    return { dataDir: d.dataDir, rec };
  };
  const leave = (rec: FollowRecord): void => {
    if (d.client !== undefined) void tellMasterLeft(d.client, d.identity, d.boxId, rec).catch(() => false);
    if (d.restart !== undefined) {
      const t = setTimeout(d.restart, 1500);
      t.unref();
    }
  };
  let leaving = false;

  app.post('/api/follow/revert', small, async (request, reply) => {
    const g = gate(request, reply);
    if (!('rec' in g)) return g;
    if (leaving) return { ok: true, restarting: d.restart !== undefined };
    const { dataDir, rec } = g;
    if (!rec.hadStore || backupOf(dataDir, rec.linkId) === null) return refuse(reply, 409, 'no_backup');
    const now = d.now().getTime();
    const fails = readFails(dataDir).filter((t) => now - Date.parse(t) < WINDOW_MS);
    if (fails.length >= MAX_FAILS) {
      const retryAfter = Math.max(60, Math.ceil((Date.parse(fails[0]!) + WINDOW_MS - now) / 1000));
      return refuse(reply.header('Retry-After', String(retryAfter)), 429, 'locked', { retryAfterSec: retryAfter });
    }
    const body = typeof request.body === 'object' && request.body !== null ? (request.body as Record<string, unknown>) : {};
    const code = typeof body.recoveryCode === 'string' ? body.recoveryCode.slice(0, 64) : '';
    if (!backupRecoveryMatches(dataDir, rec.linkId, code)) {
      writeFileAtomic(join(dataDir, REVERT_ATTEMPTS_REL), JSON.stringify({ fails: [...fails, d.now().toISOString()] }));
      return refuse(reply, 401, 'wrong_code');
    }
    try {
      planRestore(dataDir, rec.linkId, d.now());
      // the data in use is kept 7 days: the box shows it and "Buang data lama" removes it
      noteKeptByRestore(dataDir, 'follower', rec.linkId, { masterName: rec.masterName, ownName: d.ownName?.() ?? '' }, d.now());
      // a leave by the master's order that never finished must not act on the restored store
      clearUnlinkNote(dataDir);
    } catch {
      return refuse(reply, 409, 'no_backup');
    }
    writeFileAtomic(join(dataDir, REVERT_ATTEMPTS_REL), JSON.stringify({ fails: [] }));
    leaving = true;
    console.log('follow: left the surau by itself; the box goes back to its data from before the link');
    leave(rec);
    return { ok: true, restarting: d.restart !== undefined };
  });

  app.post('/api/follow/empty', small, async (request, reply) => {
    const g = gate(request, reply);
    if (!('rec' in g)) return g;
    if (leaving) return { ok: true, restarting: d.restart !== undefined };
    const { dataDir, rec } = g;
    if (rec.hadStore) return refuse(reply, 409, 'has_backup');
    try {
      planForget(dataDir, rec.linkId, d.now());
      clearUnlinkNote(dataDir);
    } catch {
      return refuse(reply, 409, 'linking');
    }
    leaving = true;
    console.log('follow: left the surau by itself; the box empties itself and returns to first setup');
    leave(rec);
    return { ok: true, restarting: d.restart !== undefined };
  });
}
