import { createReadStream } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { appLockRequiredFor } from '../auth/appLock.ts';
import { tooMany } from '../auth/authz.ts';
import type { Limiters } from '../auth/authz.ts';
import { DEFAULT_FLOOR_BYTES } from '../follow/cache.ts';
import { MIGRATIONS } from '../migrations/index.ts';
import { isLanDirect } from '../net/lan.ts';
import { boxVersion } from '../productVersion.ts';
import { buildReducedCopy } from './reducedCopy.ts';
import { LinkError } from './session.ts';
import { pinProver } from './routes.ts';
import { createStoreGrant, dropMoveOut, firstPageOf, pageOfList, pagesOf, rangeStart, STORE_TOKEN_HEADER, UNLINK_OUT_DIR } from './storeMove.ts';
import type { MoveList } from './storeMove.ts';
import { UnlinkError, dropKept, switchKept } from './unlink.ts';
import type { UnlinkCaller, Unlinks, UnlinkSide } from './unlink.ts';

/**
 * Routes of "Putuskan pautan" at the master (contract `2026-11-23-unlink-contract.md`). SECURITY code.
 *
 * - `start`, `cancel`, `switch`, `drop-kept` need `devices:manage` (authz table); `status`, `answer` and `agree` need a
 *   signed-in person only, because the follower's Pentadbir of link day may hold a lower role here: who may answer for
 *   which box is decided in `unlink.ts`, never by the route.
 * - Every app route answers on the surau network only (403 `lan_only`).
 * - `POST /api/unlink/peer/report` is a public row: only the follower's identity signature counts (`unlink.ts`).
 * - `POST /api/unlink/peer/store/list` and `GET /api/unlink/peer/store/file` (D3, a follower that carries on alone):
 *   public rows too. The list is made only for a request signed `store-list` by the leaving follower's identity key
 *   in its open carry-on session (`unlinks.copyFor`); it comes with a fresh read token, and a file is given only for
 *   that token, that session and a path IN the list (as the store move of cases X / N-X, `storeMove.ts`).
 * - Every refusal is a code.
 */
export interface UnlinkRouteDeps {
  db: DatabaseSync;
  now: () => Date;
  limiters: Limiters;
  surauId: string;
  unlinks: Unlinks;
  dataDir: string | null;
  restart?: () => void;
}

const SMALL = { bodyLimit: 16 * 1024 } as const;
const PEER = { bodyLimit: 8 * 1024 } as const;

function refuse(reply: FastifyReply, status: number, code: string): FastifyReply {
  return reply.code(status).header('Cache-Control', 'no-store').send({ code, errors: [code] });
}

export function registerUnlinkRoutes(app: FastifyInstance, d: UnlinkRouteDeps): void {
  const { db, unlinks } = d;
  const provePin = pinProver({ db, limiters: d.limiters, now: d.now, surauId: d.surauId });

  const callerOf = (request: FastifyRequest): UnlinkCaller => {
    const a = request.auth;
    if (a === null || a === undefined || a.kind !== 'user') throw new LinkError(401, 'no_session');
    return { userId: a.userId, deviceId: a.deviceId, roles: a.roles as readonly string[] };
  };
  const lanOnly = (request: FastifyRequest): void => {
    if (!isLanDirect(request)) throw new LinkError(403, 'lan_only');
  };
  const bodyOf = (request: FastifyRequest): Record<string, unknown> =>
    typeof request.body === 'object' && request.body !== null && !Array.isArray(request.body) ? (request.body as Record<string, unknown>) : {};
  const sideOf = (v: unknown): UnlinkSide => {
    if (v !== 'master' && v !== 'follower') throw new LinkError(400, 'bad_message');
    return v;
  };

  const guarded = <T>(fn: (request: FastifyRequest, reply: FastifyReply) => Promise<T>) =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<T | FastifyReply> => {
      reply.header('Cache-Control', 'no-store');
      try {
        return await fn(request, reply);
      } catch (e) {
        if (e instanceof LinkError || e instanceof UnlinkError) return refuse(reply, e.status, e.code);
        throw e;
      }
    };

  /** The kept-data routes change or destroy a whole store: the PIN typed now, the surau network, `confirm: true`. */
  const keptAct = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | { dataDir: string; side: UnlinkSide }> => {
    lanOnly(request);
    const b = bodyOf(request);
    const who = await provePin(request, reply, b.pin);
    if (typeof who !== 'string') return who;
    if (b.confirm !== true) throw new LinkError(400, 'confirm_required');
    if (d.dataDir === null) throw new UnlinkError(409, 'no_kept_data');
    if (unlinks.open()) throw new UnlinkError(409, 'unlink_open');
    return { dataDir: d.dataDir, side: sideOf(b.side) };
  };

  app.get('/api/unlink/status', guarded(async (request) => unlinks.status(callerOf(request))));

  app.post('/api/unlink/start', SMALL, guarded(async (request, reply) => {
    lanOnly(request);
    const b = bodyOf(request);
    const who = await provePin(request, reply, b.pin);
    if (typeof who !== 'string') return who;
    return unlinks.start(callerOf(request), b.deviceId);
  }));

  app.put('/api/unlink/answer', SMALL, guarded(async (request) => {
    lanOnly(request);
    return unlinks.answer(callerOf(request), bodyOf(request));
  }));

  app.post('/api/unlink/agree', SMALL, guarded(async (request, reply) => {
    lanOnly(request);
    const b = bodyOf(request);
    const c = callerOf(request);
    // A PIN typed with the agreement is checked now; with the app lock off the signed-in phone is the proof. Without
    // either, the agreement needs a proof from the last 15 minutes (`pin_required`).
    if (b.pin !== undefined || !appLockRequiredFor(db, c.roles, d.surauId)) {
      const who = await provePin(request, reply, b.pin);
      if (typeof who !== 'string') return who;
      unlinks.provePin(who);
    }
    return unlinks.agree(c, b);
  }));

  app.post('/api/unlink/cancel', SMALL, guarded(async (request) => {
    lanOnly(request);
    const c = callerOf(request);
    unlinks.cancel(c);
    return unlinks.status(c);
  }));

  /** "Tukar pilihan": carried out at the next start (a restore). */
  app.post('/api/unlink/switch', SMALL, guarded(async (request, reply) => {
    const a = await keptAct(request, reply);
    if (!('side' in a)) return a;
    switchKept(a.dataDir, a.side, d.now());
    if (d.restart !== undefined) {
      const t = setTimeout(d.restart, 750);
      t.unref();
    }
    return { ...unlinks.status(callerOf(request)), restarting: d.restart !== undefined };
  }));

  /** "Buang data lama". */
  app.post('/api/unlink/drop-kept', SMALL, guarded(async (request, reply) => {
    const a = await keptAct(request, reply);
    if (!('side' in a)) return a;
    dropKept(a.dataDir, a.side);
    return unlinks.status(callerOf(request));
  }));

  // ---- box to box: the follower that carries on alone fetches its reduced copy (D3)
  const grant = d.dataDir !== null ? createStoreGrant(d.dataDir, UNLINK_OUT_DIR) : null;
  // a copy left by a stop is never served again
  if (d.dataDir !== null) dropMoveOut(d.dataDir, UNLINK_OUT_DIR);
  let building: { unlinkId: string; list: MoveList | null; failed: boolean } | null = null;
  // Once the box is closing its database goes: a copy that finishes hashing after that must not write to it.
  let closing = false;
  app.addHook('onClose', async () => {
    closing = true;
  });
  /** Builds that failed for the current session: past three the follower is refused (it keeps its way back). */
  let buildFails = 0;
  const dropCopy = (): void => {
    grant?.end();
    building = null;
  };

  app.post('/api/unlink/peer/store/list', PEER, guarded(async (request, reply) => {
    lanOnly(request);
    // Only REFUSED requests count (the follower polls every 2 s while the copy is made): checked before the work
    const key = `unlink-copy:${request.ip}`;
    const state = d.limiters.authIp.check?.(key) ?? { ok: true, retryAfterSec: 0 };
    if (!state.ok) return tooMany(reply, state.retryAfterSec);
    // a copy whose session no longer copies goes at once (the session ended, or the follower reported it)
    if (building !== null && !unlinks.copyOpen(building.unlinkId)) dropCopy();
    const c = unlinks.copyFor(request.body);
    // 400, not 403: a public route never answers with the hook's generic deny
    if (c === null) {
      d.limiters.authIp.hit(key);
      return refuse(reply, 400, 'bad_message');
    }
    if (grant === null || d.dataDir === null) return refuse(reply, 409, 'wrong_step');
    if (building !== null && building.unlinkId !== c.id) buildFails = 0;
    if (building !== null && building.unlinkId === c.id && building.failed) {
      buildFails += 1;
      if (buildFails >= 3) return refuse(reply, 409, 'wrong_step');
    }
    if (building === null || building.unlinkId !== c.id || building.failed) {
      const b: { unlinkId: string; list: MoveList | null; failed: boolean } = { unlinkId: c.id, list: null, failed: false };
      building = b;
      buildReducedCopy({
        dataDir: d.dataDir, db, unlinkId: c.id, dbLevel: MIGRATIONS.length, release: boxVersion(), people: c.people,
        boxName: c.state.followerName, tvDeviceId: c.state.deviceId, followerFreeBytes: c.freeBytes, floorBytes: DEFAULT_FLOOR_BYTES,
      }).then(
        (r) => {
          if (closing) return;
          b.list = r.list;
          unlinks.copyBuilt(c.id, r.videosNotFit);
        },
        () => { b.failed = true; },
      ).catch(() => { b.failed = true; });
      return { state: 'preparing' };
    }
    if (building.list === null) return { state: 'preparing' };
    const p = pageOfList(building.list, c.page);
    if (p === null) return refuse(reply, 400, 'bad_message');
    // an asker of the previous release (no page in its request) reads one answer only: a longer list cannot be given to it
    if (c.legacy && pagesOf(building.list.files.length) > 1) return refuse(reply, 409, 'version');
    // page 0 starts the read (a fresh token and the progress at zero); a later page is a slice of the same list
    if (c.page > 0) return { state: 'ready', ...p };
    unlinks.copyProgress(c.id, 0);
    return { state: 'ready', ...firstPageOf(building.list), token: grant.issue(building.list) };
  }));

  app.get('/api/unlink/peer/store/file', guarded(async (request, reply) => {
    lanOnly(request);
    const q = (request.query ?? {}) as Record<string, unknown>;
    const unlinkId = typeof q.unlinkId === 'string' ? q.unlinkId : '';
    const rel = typeof q.path === 'string' ? q.path : '';
    const token = request.headers[STORE_TOKEN_HEADER];
    if (grant === null || building === null || building.list === null || building.unlinkId !== unlinkId) return refuse(reply, 404, 'not_found');
    if (!unlinks.copyOpen(unlinkId)) {
      // the follower reported its copy, or the session ended: the copy goes
      dropCopy();
      return refuse(reply, 404, 'not_found');
    }
    const f = grant.fileFor(unlinkId, typeof token === 'string' ? token : undefined, rel);
    if (f === null) return refuse(reply, 404, 'not_found');
    const start = rangeStart(request.headers.range, f.size);
    // percent of the copy: the files are fetched in list order
    const list = building.list;
    const i = list.files.findIndex((x) => x.path === rel);
    const before = list.files.slice(0, Math.max(0, i)).reduce((n, x) => n + x.size, 0);
    if (list.bytes > 0) unlinks.copyProgress(unlinkId, ((before + (start ?? 0)) * 100) / list.bytes);
    reply.header('Cache-Control', 'no-store').header('Content-Type', 'application/octet-stream').header('Accept-Ranges', 'bytes');
    if (start === null) return reply.code(200).header('Content-Length', String(f.size)).send(createReadStream(f.abs));
    reply.code(206).header('Content-Length', String(f.size - start)).header('Content-Range', `bytes ${start}-${Math.max(start, f.size - 1)}/${f.size}`);
    return reply.send(start >= f.size ? '' : createReadStream(f.abs, { start }));
  }));

  // ---- box to box: the follower reports (signed by its identity key)
  app.post('/api/unlink/peer/report', PEER, guarded(async (request, reply) => {
    lanOnly(request);
    const hit = d.limiters.authIp.hit(`unlink:${request.ip}`);
    if (!hit.ok) return tooMany(reply, hit.retryAfterSec);
    const r = unlinks.peerReport(request.body);
    // `copied`: the copy is no longer needed, it goes now
    if (building !== null && !unlinks.copyOpen(building.unlinkId)) dropCopy();
    if (r.ok) return { ok: true };
    return refuse(reply, r.status, r.code);
  }));
}
