import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SURAU_ID_RE } from '@surau/core';
import { createFleetLimiters, tooMany } from '../auth/authz.ts';
import type { AuthContext } from '../auth/authz.ts';
import type { RateLimiter } from '../auth/ratelimit.ts';
import { authLog } from '../auth/sessions.ts';
import { AuthError, MSG } from '../auth/users.ts';
import { ApprovalError, approveSite, autoSurauCapReached, revokeSite, unrevokeSite } from '../sync/sites.ts';
import type { ApprovalTarget } from '../sync/sites.ts';
import type { WorkerAdminConfig } from '../sync/workerOutbox.ts';
import { deleteRegistration, getRegistration, isStaleRegistration, listRegistrations, PENDING_GRACE_MS, registrationAgeMs } from '../sync/workerRegs.ts';
import { cleanText, deleteEmptySurau, getSurau, listSuraus, setStorageLimit, SurauError, suspendSurau, unsuspendSurau } from './registry.ts';

/**
 * The fleet routes of the MAXCOM Ops app (Plan 14 Task 10, SECURITY code). Cloud role only: on a box every path is
 * registered (so the route table has no stale row) but answers 404 and reads nothing. The hook has already refused anyone but an ops-device session (`ops: true` rows) and checked `fleet:read` /
 * `fleet:manage`. Every change goes through the same functions as the cloud CLI (`approveSite`, `revokeSite`,
 * `unrevokeSite`, `suspendSurau`, `unsuspendSurau`, `setStorageLimit`), so the app and the CLI share one code path
 * and one set of refusal codes. No route here creates, grants, removes or appoints a superadmin or support
 * (decisions 19-20): those stay CLI only. No answer or log row ever carries the Worker admin token, a claim hash or
 * a site key; a Worker failure is answered without any detail.
 */

export interface FleetRouteDeps {
  db: DatabaseSync;
  now: () => Date;
  /** The Worker's registration admin settings (the outbox's); null when no Worker is configured. */
  workerAdmin: WorkerAdminConfig | null;
  role: 'box' | 'cloud';
  /** Called after a surau was deleted (drops the in-memory per-surau state: timers, caches). */
  onSurauDeleted?: (surauId: string) => void;
}

const FLEET_PATHS: readonly (readonly ['GET' | 'POST' | 'PUT' | 'DELETE', string])[] = [
  ['GET', '/api/suraus'],
  ['GET', '/api/suraus/:id'],
  ['GET', '/api/fleet/pending'],
  ['POST', '/api/fleet/pending/:boxId/approve'],
  ['POST', '/api/fleet/pending/:boxId/reject'],
  ['POST', '/api/suraus/:id/suspend'],
  ['POST', '/api/suraus/:id/unsuspend'],
  ['PUT', '/api/suraus/:id/storage-limit'],
  ['POST', '/api/fleet/boxes/:boxId/revoke'],
  ['POST', '/api/fleet/boxes/:boxId/unrevoke'],
  ['DELETE', '/api/fleet/suraus/:id'],
];

const BOX_ID_RE = /^[0-9a-f]{16}$/;
const REASON_MAX = 200;
const SMALL_BODY = { bodyLimit: 8 * 1024 } as const;
const MSG_WORKER = 'MAXCOM tidak dapat menyemak pendaftaran kotak sekarang; cuba lagi';

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One pending box as the app sees it: never the claim hash, only cleaned text. */
export interface PendingBox {
  boxId: string;
  name: string;
  at: string;
  boxName?: string;
  platform?: 'android' | 'windows' | 'linux';
  version?: string;
  /** True when the daily cap on automatic new suraus holds this box back now (it links by itself otherwise). */
  heldByCap: boolean;
  /** Why the box is listed: the daily cap holds it, or it has waited past the grace period without linking. */
  held: 'daily_cap' | 'other';
}

function caller(request: FastifyRequest): AuthContext {
  const a = request.auth;
  if (a === null || a.kind !== 'user' || a.ops !== true) throw new AuthError(403, 'forbidden', MSG.forbidden);
  return a;
}

const workerDown = (): AuthError => new AuthError(502, 'worker_unreachable', MSG_WORKER);
const noWorker = (): AuthError => new AuthError(400, 'no_worker', 'Worker MAXCOM tidak ditetapkan pada awan ini');
const surauNotFound = (): AuthError => new AuthError(404, 'surau_not_found', 'Surau tidak dijumpai');
const boxNotFound = (): AuthError => new AuthError(404, 'not_found', 'Kotak tidak dijumpai');
const badArgs = (message: string): AuthError => new AuthError(400, 'bad_args', message);

function fromApproval(e: ApprovalError): AuthError {
  const status = e.code === 'surau_not_found' || e.code === 'not_found' ? 404 : e.code === 'bad_args' || e.code === 'surau_required' ? 400 : 409;
  return new AuthError(status, e.code, e.message);
}

function fromSurau(e: SurauError): AuthError {
  return new AuthError(e.code === 'surau_not_found' ? 404 : e.code === 'not_empty' ? 409 : 400, e.code, e.message);
}

/** `{ newSurau: true }` or `{ surauId }`, exactly one; no default (the guard against the wrong surau). */
function targetOf(body: Record<string, unknown>): ApprovalTarget {
  const { newSurau, surauId } = body;
  if (newSurau !== undefined && typeof newSurau !== 'boolean') throw badArgs('newSurau mesti true atau false');
  if (surauId !== undefined && typeof surauId !== 'string') throw badArgs('surauId tidak sah');
  if (newSurau === true && surauId !== undefined) throw badArgs('Pilih satu sasaran sahaja: surau baharu atau surau sedia ada');
  if (newSurau === true) return { newSurau: {} };
  if (surauId === undefined) throw new AuthError(400, 'surau_required', 'Sasaran diperlukan: surau baharu atau surau sedia ada');
  return { surauId };
}

export function registerFleetRoutes(app: FastifyInstance, deps: FleetRouteDeps): void {
  if (deps.role !== 'cloud') {
    // a box has no fleet: the same 404 as an unknown path, before anything is read
    for (const [method, url] of FLEET_PATHS) {
      app.route({ method, url, ...SMALL_BODY, handler: async (_request, reply) => reply.code(404).header('Cache-Control', 'no-store').send({ errors: ['not found'] }) });
    }
    return;
  }
  const { db, now } = deps;
  const limits = createFleetLimiters(() => now().getTime());
  /** Every call counts, refused ones too (the limit is checked before the body is read). */
  const limit =
    (...limiters: RateLimiter[]) =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      const a = caller(request);
      for (const l of limiters) {
        const hit = l.hit(`u:${a.userId}`);
        if (!hit.ok) return tooMany(reply, hit.retryAfterSec);
      }
      return undefined;
    };
  const read = { preHandler: limit(limits.read) };
  const manage = { ...SMALL_BODY, preHandler: limit(limits.manage) };
  const approve = { ...SMALL_BODY, preHandler: limit(limits.manage, limits.approve) };

  const actor = (a: AuthContext): string => `user:${a.userId}`;
  /** The one auth_log row of a change that went through: the caller and the target ids (ids only, never a secret). */
  const logDone = (request: FastifyRequest, a: AuthContext, event: string, detail: string): void => {
    authLog(db, now(), event, true, { userId: a.userId, deviceId: a.deviceId, ip: request.ip, detail });
  };
  const bodyOf = (request: FastifyRequest): Record<string, unknown> => (isPlain(request.body) ? request.body : {});
  const surauParam = (request: FastifyRequest): string => {
    const id = (request.params as { id?: unknown }).id;
    return typeof id === 'string' && SURAU_ID_RE.test(id) ? id : '';
  };
  const boxParam = (request: FastifyRequest): string => {
    const id = (request.params as { boxId?: unknown }).boxId;
    return typeof id === 'string' && BOX_ID_RE.test(id) ? id : '';
  };
  const noStore = (reply: FastifyReply): void => {
    reply.header('Cache-Control', 'no-store');
  };

  // ---- reads (fleet:read: support too) ----

  app.get('/api/suraus', read, async (_request, reply) => {
    noStore(reply);
    return { suraus: listSuraus(db).map((s) => getSurau(db, s.id)).filter((s) => s !== null) };
  });

  app.get('/api/suraus/:id', read, async (request, reply) => {
    noStore(reply);
    const surau = getSurau(db, surauParam(request));
    if (surau === null) throw surauNotFound();
    return { surau };
  });

  app.get('/api/fleet/pending', read, async (_request, reply) => {
    noStore(reply);
    if (deps.workerAdmin === null) throw noWorker();
    let regs;
    try {
      regs = await listRegistrations(deps.workerAdmin);
    } catch {
      throw workerDown();
    }
    const at = now();
    const capReached = autoSurauCapReached(db, at);
    const known = db.prepare('SELECT 1 AS x FROM sites WHERE box_id = ?');
    const approved = db.prepare('SELECT 1 AS x FROM site_approvals WHERE box_id = ? AND claimed_at IS NULL');
    const pending: PendingBox[] = [];
    for (const r of regs) {
      // a box the cloud knows (linked, or revoked: its way back is unrevoke) is not pending
      if (!BOX_ID_RE.test(r.boxId) || known.get(r.boxId) !== undefined) continue;
      // a registration whose box has not been seen for a day is stale (it expires at the Worker by itself)
      if (isStaleRegistration(r, at)) continue;
      const byCap = capReached && approved.get(r.boxId) === undefined;
      // only a box that is really held: by the cap, or by something else (it has waited past the grace period)
      if (!byCap && !(registrationAgeMs(r, at) >= PENDING_GRACE_MS)) continue;
      pending.push({
        boxId: r.boxId,
        name: cleanText(r.name, 80),
        at: cleanText(r.at, 40),
        ...(r.boxName !== undefined && cleanText(r.boxName, 60) !== '' ? { boxName: cleanText(r.boxName, 60) } : {}),
        ...(r.platform !== undefined ? { platform: r.platform } : {}),
        ...(r.version !== undefined ? { version: cleanText(r.version, 16) } : {}),
        heldByCap: byCap,
        held: byCap ? 'daily_cap' : 'other',
      });
    }
    pending.sort((x, y) => x.at.localeCompare(y.at) || x.boxId.localeCompare(y.boxId));
    return { pending };
  });

  // ---- changes (fleet:manage) ----

  app.post('/api/fleet/pending/:boxId/approve', approve, async (request, reply) => {
    noStore(reply);
    const a = caller(request);
    const boxId = boxParam(request);
    if (boxId === '') throw badArgs('ID kotak tidak sah');
    const target = targetOf(bodyOf(request));
    // an unknown target is refused before the Worker is asked (approveSite checks it again in its transaction)
    if ('surauId' in target && getSurau(db, target.surauId) === null) throw surauNotFound();
    if (deps.workerAdmin === null) throw noWorker();
    let reg;
    try {
      reg = await getRegistration(deps.workerAdmin, boxId);
    } catch {
      throw workerDown();
    }
    if (reg === null) throw new AuthError(404, 'not_registered', 'Kotak ini belum mendaftar (atau pendaftarannya sudah tamat)');
    // a new surau is named from the registration, as the automatic link would name it
    const name = cleanText(reg.name, 120) || `Surau ${boxId}`;
    let done: { surauId: string; created: boolean };
    try {
      done = approveSite({ db, now }, { boxId, name, claimHash: reg.claimHash, target }, actor(a));
    } catch (e) {
      if (e instanceof ApprovalError) throw fromApproval(e);
      throw e;
    }
    logDone(request, a, 'fleet_approve', `box:${boxId} surau:${done.surauId}`);
    return { surauId: done.surauId, created: done.created };
  });

  /**
   * Reject a pending registration: the Worker entry is deleted, nothing else. A box the cloud already knows (a site,
   * live or revoked, or a waiting approval) is refused: its way out is revoke, never this route.
   */
  app.post('/api/fleet/pending/:boxId/reject', manage, async (request, reply) => {
    noStore(reply);
    const a = caller(request);
    const boxId = boxParam(request);
    if (boxId === '') throw boxNotFound();
    if (
      db.prepare('SELECT 1 AS x FROM sites WHERE box_id = ?').get(boxId) !== undefined ||
      db.prepare('SELECT 1 AS x FROM site_approvals WHERE box_id = ?').get(boxId) !== undefined
    ) {
      throw new AuthError(409, 'already_linked', 'Kotak ini sudah dipautkan atau diluluskan; guna Batalkan, bukan Tolak');
    }
    if (deps.workerAdmin === null) throw noWorker();
    try {
      if ((await getRegistration(deps.workerAdmin, boxId)) === null) {
        throw new AuthError(404, 'not_registered', 'Kotak ini belum mendaftar (atau pendaftarannya sudah tamat)');
      }
      await deleteRegistration(deps.workerAdmin, boxId);
    } catch (e) {
      if (e instanceof AuthError) throw e;
      throw workerDown();
    }
    logDone(request, a, 'fleet_reject', `box:${boxId}`);
    return { rejected: true };
  });

  app.post('/api/suraus/:id/suspend', manage, async (request, reply) => {
    noStore(reply);
    const a = caller(request);
    const raw = bodyOf(request).reason;
    if (typeof raw !== 'string') throw badArgs('Sebab diperlukan');
    // refused, never cut short: the reason the surau is told must be the one MAXCOM wrote
    const why = cleanText(raw, Number.MAX_SAFE_INTEGER);
    if (why === '' || [...why].length > REASON_MAX) throw badArgs(`Sebab diperlukan, paling banyak ${REASON_MAX} aksara`);
    const id = surauParam(request);
    if (id === '') throw surauNotFound();
    try {
      const surau = suspendSurau(db, id, why, actor(a), now());
      logDone(request, a, 'fleet_suspend', `surau:${id}`);
      return { surau: getSurau(db, surau.id) };
    } catch (e) {
      if (e instanceof SurauError) throw fromSurau(e);
      throw e;
    }
  });

  app.post('/api/suraus/:id/unsuspend', manage, async (request, reply) => {
    noStore(reply);
    const a = caller(request);
    const id = surauParam(request);
    if (id === '') throw surauNotFound();
    try {
      const surau = unsuspendSurau(db, id, actor(a));
      logDone(request, a, 'fleet_unsuspend', `surau:${id}`);
      return { surau: getSurau(db, surau.id) };
    } catch (e) {
      if (e instanceof SurauError) throw fromSurau(e);
      throw e;
    }
  });

  app.put('/api/suraus/:id/storage-limit', manage, async (request, reply) => {
    noStore(reply);
    const a = caller(request);
    const bytes = bodyOf(request).bytes;
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0) throw badArgs('Had mesti nombor bait bulat yang positif');
    const id = surauParam(request);
    if (id === '') throw surauNotFound();
    try {
      const surau = setStorageLimit(db, id, bytes, actor(a));
      logDone(request, a, 'fleet_storage_limit', `surau:${id}`);
      return { surau: getSurau(db, surau.id) };
    } catch (e) {
      if (e instanceof SurauError) throw fromSurau(e);
      throw e;
    }
  });

  /**
   * Delete a surau that holds nothing (no content, users, devices, finance, live box...). Anything else is refused
   * 409 `not_empty` with the counts; the CLI `surau-delete` and the daily prune use the same function.
   */
  app.delete('/api/fleet/suraus/:id', manage, async (request, reply) => {
    noStore(reply);
    const a = caller(request);
    const id = surauParam(request);
    if (id === '') throw surauNotFound();
    try {
      deleteEmptySurau(db, id, actor(a));
    } catch (e) {
      if (e instanceof SurauError) {
        const err = fromSurau(e);
        if (e.code === 'not_empty') {
          reply.code(409).send({ errors: [e.message], code: 'not_empty', counts: e.counts });
          return reply;
        }
        throw err;
      }
      throw e;
    }
    deps.onSurauDeleted?.(id);
    logDone(request, a, 'fleet_surau_delete', `surau:${id}`);
    return { deleted: true };
  });

  app.post('/api/fleet/boxes/:boxId/revoke', manage, async (request, reply) => {
    noStore(reply);
    const a = caller(request);
    const boxId = boxParam(request);
    // a live or revoked site, or only a pending approval (withdrawn by the revoke, as `revokeSite` does)
    const known =
      boxId !== '' &&
      (db.prepare('SELECT 1 AS x FROM sites WHERE box_id = ?').get(boxId) !== undefined ||
        db.prepare('SELECT 1 AS x FROM site_approvals WHERE box_id = ?').get(boxId) !== undefined);
    if (!known) throw boxNotFound();
    if (!revokeSite({ db, now }, boxId, actor(a))) throw new AuthError(409, 'not_linked', 'Kotak ini sudah dibatalkan');
    logDone(request, a, 'fleet_revoke', `box:${boxId}`);
    return { revoked: true };
  });

  app.post('/api/fleet/boxes/:boxId/unrevoke', manage, async (request, reply) => {
    noStore(reply);
    const a = caller(request);
    const boxId = boxParam(request);
    if (boxId === '') throw boxNotFound();
    try {
      const done = unrevokeSite({ db, now }, boxId, actor(a));
      logDone(request, a, 'fleet_unrevoke', `box:${boxId} surau:${done.surauId}`);
      return { surauId: done.surauId };
    } catch (e) {
      if (e instanceof ApprovalError) throw fromApproval(e);
      throw e;
    }
  });
}
