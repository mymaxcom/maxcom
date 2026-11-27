import { createReadStream } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { holdsSurauAdmin, LINK_PROTOCOL } from '@surau/core';
import type { LinkFacts } from '@surau/core';
import { actorOf } from '../actor.ts';
import { appLockRequiredFor } from '../auth/appLock.ts';
import { isDirectLoopback, kioskTokenAccepts, normalisePath, tooMany } from '../auth/authz.ts';
import type { Limiters } from '../auth/authz.ts';
import { pinPepperOf, verifyPin } from '../auth/crypto.ts';
import { AuthError, MSG, getAuthUser, revokeDeviceRow, tx } from '../auth/users.ts';
import type { FollowStore } from '../follow/store.ts';
import { MIGRATIONS } from '../migrations/index.ts';
import { isLanDirect } from '../net/lan.ts';
import { boxVersion } from '../productVersion.ts';
import type { BoxIdentity } from '../setup/identity.ts';
import { boxName, boxState } from '../setup/state.ts';
import { statfsFreeBytes } from '../assets/video.ts';
import { AT_UNLINK_KEEP_DAYS, backupInfo, dropBackup } from './backupInfo.ts';
import { atUnlinkFolder, listBackups, planRestore } from './setAside.ts';
import { LinkError } from './session.ts';
import type { LinkSessionRow, LinkSessions, OwnHello } from './session.ts';
import { buildMoveList, createStoreGrant, firstPageOf, pageOfList, pagesOf, rangeStart, requestedPage, STORE_TOKEN_HEADER } from './storeMove.ts';
import { CAM_CROSS_LABEL, takeRecoveryNote, YT_CROSS_LABEL } from './adopt.ts';
import { TokenStore } from '../live/youtube/tokenStore.ts';
import { CameraStore } from '../live/camera.ts';
import { sealToBoxKey } from '../sync/boxSeal.ts';
import type { MoveList } from './storeMove.ts';
import { identityPub, signLink } from './sign.ts';
import { CASE_X_READY, caseOf } from './work.ts';
import { clearKeptNote, noteKeptByRestore, readKeptNote } from './unlink.ts';
import type { Unlinks } from './unlink.ts';
import type { LinkWork } from './work.ts';

/**
 * Routes of the box link. SECURITY code.
 *
 * - App routes need `devices:manage` (table in `auth/authz.ts`), the surau network (`isLanDirect`) and, to start or
 *   to agree, the PIN typed now (bound to the session, good for 15 minutes).
 * - Box-to-box routes are public rows: what they accept is decided by the one-time code of the QR and by the other
 *   box's identity signature, checked in `session.ts`. They too answer only on the surau network.
 * - Every refusal is a code. No sentence in any language leaves this file.
 */
export interface LinkRouteDeps {
  db: DatabaseSync;
  boxId: string;
  identity: BoxIdentity;
  now: () => Date;
  limiters: Limiters;
  sessions: LinkSessions;
  work: LinkWork;
  follow: FollowStore;
  isLive: () => boolean;
  surauId: string;
  /** The data folder, null for a box with none (in-memory tests): no backup exists there. */
  dataDir: string | null;
  /** Starts the process again (a restore is carried out at the next start, before the database opens). */
  restart?: () => void;
  /** Phase 2D: the unlink sessions of this box (as master), and the follower's own line while it leaves. */
  unlinks?: Unlinks;
  /** Follower only: when the master last answered, if it has been silent for 6 hours (the TV shows a notice), else null. */
  masterUnreachableSince?: () => string | null;
  followerUnlink?: () => { step: 'copy' | 'back' | 'carry-on' | 'empty' | 'done'; percent: number | null } | null;
}

export interface LinkGateState {
  sessions: LinkSessions | null;
  follow: FollowStore | null;
  unlinks?: Unlinks | null;
}

/** A follower not seen at the master for longer than this is shown as stale in the list of boxes (O23). */
export const NOT_SEEN_MS = 3 * 24 * 3_600_000;
const SMALL = { bodyLimit: 16 * 1024 } as const;
const PEER = { bodyLimit: 64 * 1024 } as const;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** A follower answers its own TV, the other box and nothing else. */
const FOLLOWER_OPEN = [/^\/api\/kiosk\//, /^\/api\/box\//, /^\/api\/pki\//, /^\/api\/link\/peer\//, /^\/api\/follow\//, /^\/api\/health$/];
/** Inside those prefixes, still not a follower's business: pairing a browser screen and renaming the box are the master's. */
const FOLLOWER_SHUT = [/^\/api\/kiosk\/pair\//, /^\/api\/box\/name$/];
/** While the boxes do the work of a link, only these writes pass: the link itself, signing in, and the TV. */
const LINKING_OPEN = [/^\/api\/link\//, /^\/api\/unlink\//, /^\/api\/auth\//, /^\/api\/enrol\//, /^\/api\/kiosk\//, /^\/api\/follow\//];

function refuse(reply: FastifyReply, status: number, code: string, extra?: Record<string, unknown>): FastifyReply {
  return reply.code(status).header('Cache-Control', 'no-store').send({ ...(extra ?? {}), code, errors: [code] });
}

/**
 * Two rules for every request, placed right after authorisation:
 * a follower refuses every session and admin route with 409 `follower` and its master's name and addresses;
 * a box in the middle of a link refuses every other write with 409 `linking`.
 */
export function linkGateHook(state: LinkGateState) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    const path = normalisePath(request.raw.url ?? '');
    if (path === null || !path.startsWith('/api/')) return undefined;
    const rec = state.follow !== null && state.follow.present() ? state.follow.read() : null;
    if (state.follow !== null && state.follow.present() && (!FOLLOWER_OPEN.some((re) => re.test(path)) || FOLLOWER_SHUT.some((re) => re.test(path)))) {
      return refuse(reply, 409, 'follower', rec === null ? {} : { master: { name: rec.masterName, boxId: rec.masterBoxId, addresses: rec.addresses, caSha256: rec.masterCa } });
    }
    const blocked = (state.sessions !== null && state.sessions.writesBlocked()) || (state.unlinks != null && state.unlinks.writesBlocked());
    if (WRITE_METHODS.has(request.method) && blocked && !LINKING_OPEN.some((re) => re.test(path))) {
      return refuse(reply, 409, 'linking');
    }
    return undefined;
  };
}

/** What this box says about itself in a hello: numbers and switches only. */
export function ownHelloOf(d: {
  db: DatabaseSync; boxId: string; identity: BoxIdentity; origins: () => string[]; caSha256: () => string | null;
  follow: FollowStore; freeBytes: () => number; youtube: () => boolean; cloud: () => boolean;
}): OwnHello {
  const n = (sql: string): number => {
    try {
      return Number(d.db.prepare(sql).get()?.n ?? 0);
    } catch {
      return 0;
    }
  };
  let lastEditAt: string | null = null;
  try {
    const r = d.db.prepare('SELECT MAX(at) AS at FROM change_log').get();
    lastEditAt = typeof r?.at === 'string' && !Number.isNaN(Date.parse(r.at)) ? r.at : null;
  } catch {
    lastEditAt = null;
  }
  const facts: LinkFacts = {
    content: n("SELECT COUNT(*) AS n FROM content_items WHERE deleted_at IS NULL AND kind NOT IN ('poster','video')"),
    posters: n("SELECT COUNT(*) AS n FROM content_items WHERE deleted_at IS NULL AND kind = 'poster'"),
    videos: n("SELECT COUNT(*) AS n FROM content_items WHERE deleted_at IS NULL AND kind = 'video'"),
    finance: n('SELECT COUNT(*) AS n FROM finance_entries'),
    people: n('SELECT COUNT(*) AS n FROM users WHERE active = 1 AND deleted_at IS NULL'),
    lastEditAt,
    device: process.platform === 'win32' ? 'windows' : process.platform === 'android' || process.platform === 'linux' ? 'android' : 'other',
    wired: null,
    freeBytes: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(d.freeBytes()))),
    youtube: d.youtube(),
    cloud: d.cloud(),
  };
  return {
    v: 1, proto: LINK_PROTOCOL, boxId: d.boxId, keyFp: d.identity.keyFp, pub: identityPub(d.identity),
    caSha256: d.caSha256() ?? '', name: boxName(d.db, d.boxId).slice(0, 60), addresses: d.origins().slice(0, 4),
    release: boxVersion(), dbLevel: MIGRATIONS.length, setUp: boxState(d.db).state !== 'setup', isFollower: d.follow.present(),
    followers: n('SELECT COUNT(*) AS n FROM linked_boxes WHERE removed_at IS NULL'), facts,
  };
}

/**
 * "Typed the PIN now": wrong PINs count against the `linkPin` limit (5 per 15 minutes per person), and a person the
 * unlock flow has locked stays locked here (423); a wrong PIN here does not add to that lock. A surau that runs with the app lock off has no PIN anywhere: there the signed-in admin device on
 * the surau network is the proof (decision for the operator, see the handoff note). Shared by the link and unlink
 * routes. Returns the user id, or the reply already sent (429).
 */
export function pinProver(d: { db: DatabaseSync; limiters: Limiters; now: () => Date; surauId: string }) {
  return async (request: FastifyRequest, reply: FastifyReply, pin: unknown): Promise<FastifyReply | string> => {
    const a = request.auth;
    if (a === null || a === undefined || a.kind !== 'user') throw new LinkError(401, 'no_session');
    if (!appLockRequiredFor(d.db, a.roles as readonly string[], d.surauId)) return a.userId;
    // 400, not 401: the session is fine, the body lacks the PIN.
    if (typeof pin !== 'string' || pin === '') throw new LinkError(400, 'pin_required');
    // Only WRONG PINs count (a right one, typed at each step of a link or unlink, never locks anyone out). A slot is
    // TAKEN before the slow compare, so guesses sent side by side cannot all pass one check; a right PIN gives it back.
    const lim = d.limiters.linkPin;
    const slot = lim.hit(a.userId);
    if (!slot.ok) return tooMany(reply, slot.retryAfterSec);
    const user = getAuthUser(d.db, a.userId);
    if (user === undefined || !user.active) throw new LinkError(401, 'no_session');
    if (user.pinLockedUntil !== null && user.pinLockedUntil > d.now().toISOString()) {
      const secs = Math.max(60, Math.ceil((Date.parse(user.pinLockedUntil) - d.now().getTime()) / 1000));
      throw new AuthError(423, 'locked', MSG.locked(Math.ceil(secs / 60)), secs);
    }
    if (user.pinHash === null || !(await verifyPin(pin, user.pinHash, pinPepperOf(d.db)))) throw new LinkError(401, 'wrong_pin');
    lim.release?.(a.userId);
    return a.userId;
  };
}

export function registerLinkRoutes(app: FastifyInstance, d: LinkRouteDeps): void {
  const { db, sessions, work, follow, limiters } = d;

  const userOf = (request: FastifyRequest): { userId: string; deviceId: string; roles: readonly string[] } => {
    const a = request.auth;
    if (a === null || a === undefined || a.kind !== 'user') throw new LinkError(401, 'no_session');
    return { userId: a.userId, deviceId: a.deviceId, roles: a.roles as readonly string[] };
  };
  const lanOnly = (request: FastifyRequest): void => {
    if (!isLanDirect(request)) throw new LinkError(403, 'lan_only');
  };
  const bodyOf = (request: FastifyRequest): Record<string, unknown> =>
    typeof request.body === 'object' && request.body !== null && !Array.isArray(request.body) ? (request.body as Record<string, unknown>) : {};

  const provePin = pinProver({ db, limiters, now: d.now, surauId: d.surauId });

  const lastFinished = (): { id: string; outcome: string | null; finishedAt: string; role: string } | null => {
    const since = new Date(d.now().getTime() - 30 * 60 * 1000).toISOString();
    const r = db.prepare("SELECT id, outcome, finished_at, role FROM link_sessions WHERE kind = 'link' AND finished_at > ? AND pin_proof_user IS NOT NULL ORDER BY finished_at DESC LIMIT 1").get(since);
    return r === undefined ? null : { id: String(r.id), outcome: typeof r.outcome === 'string' ? r.outcome : null, finishedAt: String(r.finished_at), role: String(r.role) };
  };

  const mayTakeRecovery = (request: FastifyRequest): boolean => {
    const a = request.auth;
    if (a === null || a === undefined || a.kind !== 'user') return false;
    const r = db.prepare("SELECT pin_proof_user FROM link_sessions WHERE kind = 'link' AND outcome = 'linked' ORDER BY finished_at DESC LIMIT 1").get();
    const linker = typeof r?.pin_proof_user === 'string' ? r.pin_proof_user : null;
    const linkerHere = linker !== null && db.prepare('SELECT 1 AS x FROM users WHERE id = ? AND active = 1 AND deleted_at IS NULL').get(linker) !== undefined;
    return linkerHere ? a.userId === linker : holdsSurauAdmin(a.roles as Parameters<typeof holdsSurauAdmin>[0]);
  };

  const status = (request: FastifyRequest): Record<string, unknown> => ({
    mode: follow.present() ? 'follower' : 'main',
    session: sessions.view(),
    last: lastFinished(),
    // Cases X / N-X: the new recovery code of this box, given ONCE (the read removes it), and only to the person who
    // linked: the admin who proved the PIN here, or, when that person is not on this box (N-X), a Pentadbir.
    recoveryCode: d.dataDir === null || !mayTakeRecovery(request) ? null : takeRecoveryNote(d.dataDir, d.identity, d.boxId, d.now())?.code ?? null,
    progress: work.progress(),
    checks: {
      lan: isLanDirect(request),
      live: d.isLive(),
      caseX: CASE_X_READY,
      setUp: boxState(db).state !== 'setup',
    },
  });

  const guarded = <T>(fn: (request: FastifyRequest, reply: FastifyReply) => Promise<T>) =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<T | FastifyReply> => {
      reply.header('Cache-Control', 'no-store');
      try {
        return await fn(request, reply);
      } catch (e) {
        if (e instanceof LinkError) return refuse(reply, e.status, e.code, e.extra);
        throw e;
      }
    };

  app.get('/api/link/status', guarded(async (request) => status(request)));

  app.post('/api/link/pin', SMALL, guarded(async (request, reply) => {
    lanOnly(request);
    const who = await provePin(request, reply, bodyOf(request).pin);
    if (typeof who !== 'string') return who;
    sessions.provePin(who);
    return status(request);
  }));

  app.post('/api/link/show', SMALL, guarded(async (request, reply) => {
    lanOnly(request);
    const who = await provePin(request, reply, bodyOf(request).pin);
    if (typeof who !== 'string') return who;
    const q = sessions.show(who);
    // The QR text goes to this box's own TV only (`/api/kiosk/link`), never to a phone.
    return { ...status(request), shown: { id: q.id, expiresAt: q.expiresAt } };
  }));

  app.post('/api/link/scan', SMALL, guarded(async (request, reply) => {
    lanOnly(request);
    const b = bodyOf(request);
    const who = await provePin(request, reply, b.pin);
    if (typeof who !== 'string') return who;
    await sessions.scan(who, b.qr);
    return status(request);
  }));

  app.post('/api/link/approve', SMALL, guarded(async (request) => {
    lanOnly(request);
    userOf(request);
    await sessions.approve(bodyOf(request).ok === true);
    return status(request);
  }));

  app.put('/api/link/answers', SMALL, guarded(async (request) => {
    lanOnly(request);
    userOf(request);
    const b = bodyOf(request);
    if (!CASE_X_READY && b.keep !== b.master) throw new LinkError(409, 'case_x_unavailable');
    await sessions.setAnswers(b);
    return status(request);
  }));

  app.post('/api/link/agree', SMALL, guarded(async (request) => {
    lanOnly(request);
    userOf(request);
    const cur = sessions.current();
    if (!CASE_X_READY && cur?.answers !== null && cur?.answers !== undefined && cur.answers.keep !== cur.answers.master) throw new LinkError(409, 'case_x_unavailable');
    await sessions.agree(bodyOf(request).rev);
    return status(request);
  }));

  app.post('/api/link/cancel', SMALL, guarded(async (request) => {
    lanOnly(request);
    userOf(request);
    await sessions.cancel();
    return status(request);
  }));

  // ---- this box's own TV ----
  app.get('/api/kiosk/link', guarded(async (request) => {
    const a = request.auth;
    const ownTv = a !== null && a !== undefined && a.kind === 'kiosk' && a.via === 'loopback' && isDirectLoopback(request) && kioskTokenAccepts(request);
    const rec = follow.present() ? follow.read() : null;
    const base = { mode: follow.present() ? 'follower' : 'main', master: rec === null ? null : { name: rec.masterName }, serverTime: d.now().toISOString() };
    // A TV paired by code is another screen in another room: it never shows this box's link QR or code. It still
    // gets the instant the main box went unreachable (a time, nothing secret), so every TV of the follower shows the notice.
    if (!ownTv) return { ...base, qr: null, step: null, code: null, progress: null, last: null, unlink: null, masterUnreachableSince: follow.present() ? d.masterUnreachableSince?.() ?? null : null };
    const unlink = follow.present() || d.unlinks === undefined ? d.followerUnlink?.() ?? null : d.unlinks.kioskView() ?? d.followerUnlink?.() ?? null;
    let qr = sessions.qrForTv();
    if (qr === null && !follow.present() && boxState(db).state === 'setup') {
      db.prepare("DELETE FROM link_sessions WHERE pin_proof_user IS NULL AND peer_box_id IS NULL AND finished_at IS NOT NULL AND kind = 'link'").run();
      try {
        qr = sessions.showAsNewBox();
      } catch {
        qr = null;
      }
    }
    const v = sessions.view();
    const last = db.prepare("SELECT outcome, finished_at FROM link_sessions WHERE kind = 'link' AND peer_box_id IS NOT NULL AND finished_at > ? ORDER BY finished_at DESC LIMIT 1")
      .get(new Date(d.now().getTime() - 60_000).toISOString());
    return {
      ...base, qr, step: v?.step ?? null,
      code: v !== null && v.step === 'code' ? v.code : null,
      peer: v?.peer === null || v === null ? null : { name: v.peer.name },
      progress: work.progress(),
      last: last === undefined ? null : { outcome: typeof last.outcome === 'string' ? last.outcome : null, finishedAt: String(last.finished_at) },
      unlink,
      masterUnreachableSince: follow.present() ? d.masterUnreachableSince?.() ?? null : null,
    };
  }));

  // ---- box to box ----
  app.post('/api/link/peer/hello', PEER, guarded(async (request, reply) => {
    lanOnly(request);
    const hit = limiters.authIp.hit(`link:${request.ip}`);
    if (!hit.ok) return tooMany(reply, hit.retryAfterSec);
    return sessions.peerHello(request.body, request.ip);
  }));

  app.post('/api/link/peer/message', PEER, guarded(async (request, reply) => {
    lanOnly(request);
    const r = sessions.peerMessage(request.body);
    if (r.ok) return { ok: true, ...(r.reply ?? {}) };
    return refuse(reply, r.status, r.code, r.answers !== undefined ? { answers: r.answers } : undefined);
  }));

  /**
   * A follower whose token stopped working asks why. The only answer with any weight is the order to forget this
   * surau, signed by this box's identity key for that follower and that link. It carries no secret.
   */
  app.post('/api/link/peer/order', SMALL, guarded(async (request, reply) => {
    lanOnly(request);
    const hit = limiters.authIp.hit(`link:${request.ip}`);
    if (!hit.ok) return tooMany(reply, hit.retryAfterSec);
    const b = bodyOf(request);
    const boxId = typeof b.boxId === 'string' ? b.boxId : '';
    const linkId = typeof b.linkId === 'string' ? b.linkId : '';
    // an unlink's order (revert / carry on) comes first: a follower that left by an unlink never gets `forget`
    const u = /^[0-9a-f]{16}$/.test(boxId) && /^[0-9a-f]{32}$/.test(linkId) ? d.unlinks?.orderFor(boxId, linkId) ?? null : null;
    if (u !== null) return u;
    const row = db.prepare('SELECT removed_at FROM linked_boxes WHERE link_id = ? AND (box_id = ? OR box_id LIKE ?)').get(linkId, boxId, `${boxId.replace(/[%_]/g, '')}#%`);
    if (row === undefined || !/^[0-9a-f]{16}$/.test(boxId) || !/^[0-9a-f]{32}$/.test(linkId)) return refuse(reply, 404, 'not_found');
    if (row.removed_at === null) return { order: null };
    const body = { boxId, linkId, masterBoxId: d.boxId };
    return { order: 'forget', body, sig: signLink(d.identity, 'order-forget', linkId, body) };
  }));

  // ---- store move, at the GIVER (cases X and N-X: this box's data is kept and it becomes the follower) ----
  /**
   * The kept data's YouTube sign-in and camera address (never the camera password, never the cloud key), each sealed
   * to the receiver's identity key under its own label. Read failures leave the item out: the admin signs in again.
   */
  const crossingSecrets = (dataDir: string, s: LinkSessionRow, ownBoxId: string): { youtube: string | null; camera: string | null } => {
    const pub = s.peerHello!.pub;
    const aadOf = `${s.id}|${ownBoxId}|${s.peerHello!.boxId}`;
    let youtube: string | null = null;
    let camera: string | null = null;
    try {
      const t = new TokenStore(dataDir).load();
      if (t !== null) youtube = sealToBoxKey(pub, JSON.stringify(t), YT_CROSS_LABEL, aadOf);
    } catch {
      youtube = null;
    }
    try {
      const b = new CameraStore(dataDir).backup();
      if (b !== null) camera = sealToBoxKey(pub, JSON.stringify(b), CAM_CROSS_LABEL, aadOf);
    } catch {
      camera = null;
    }
    return { youtube, camera };
  };
  const grant = d.dataDir !== null ? createStoreGrant(d.dataDir) : null;
  let building: { linkId: string; list: MoveList | null; failed: boolean } | null = null;
  /** This box gives its store in this session: past the agreement, the follower side, and its data is the kept one. */
  const givesStore = (s: LinkSessionRow | null): s is LinkSessionRow => {
    if (s === null || (s.step !== 'agreed' && s.step !== 'working') || s.answers === null || s.answers.master === s.role) return false;
    const c = caseOf(s);
    return c === 'X' || c === 'N-X';
  };

  /**
   * The receiver asks (signed) for the list. The first call starts the database copy and the hashing and answers
   * `preparing`; a later call answers `ready` with page 0 of the list and a fresh read token. The signed body names
   * the page (`{page}`); the list is built once and the later pages (up to 2,000 entries each) are slices of it, with
   * no new token. SECURITY: only the session's peer, only while this box gives its store.
   */
  app.post('/api/link/peer/store/list', PEER, guarded(async (request, reply) => {
    lanOnly(request);
    const v = sessions.verifiedPeer(request.body, 'store-list');
    // 400, not 403: a public route never answers with the hook's generic deny (security.test role matrix)
    if (v === null) return refuse(reply, 400, 'bad_message');
    if (grant === null || d.dataDir === null || !givesStore(v.s)) return refuse(reply, 409, 'wrong_step');
    const linkId = v.s.id;
    // `{page}`, or an empty body (the older release): page 0
    const keys = Object.keys(v.payload).join();
    const page = keys === 'page' ? requestedPage(v.payload.page) : keys === '' ? 0 : null;
    const legacyAsker = keys === '';
    if (page === null) return refuse(reply, 400, 'bad_message');
    if (page > 0) {
      // a later page is a slice of the list already built for this session
      if (building === null || building.linkId !== linkId || building.list === null) return refuse(reply, 409, 'wrong_step');
      const p = pageOfList(building.list, page);
      return p === null ? refuse(reply, 400, 'bad_message') : { state: 'ready', ...p };
    }
    if (building === null || building.linkId !== linkId || building.failed) {
      const b: { linkId: string; list: MoveList | null; failed: boolean } = { linkId, list: null, failed: false };
      building = b;
      buildMoveList({ dataDir: d.dataDir, db, linkId, dbLevel: MIGRATIONS.length, release: boxVersion() }).then(
        (list) => { b.list = list; },
        () => { b.failed = true; },
      );
      return { state: 'preparing' };
    }
    if (building.list === null) return { state: 'preparing' };
    // An asker of the previous release sends no page and reads one answer only: a longer list cannot be given to it.
    if (legacyAsker && pagesOf(building.list.files.length) > 1) return refuse(reply, 409, 'version');
    // `admin`: the admin who proved the PIN here; in N-X the new master makes that person's one move ticket
    return { state: 'ready', ...firstPageOf(building.list), token: grant.issue(building.list), admin: v.s.pinProofUser, secrets: crossingSecrets(d.dataDir, v.s, d.boxId) };
  }));

  app.get('/api/link/peer/store/file', guarded(async (request, reply) => {
    lanOnly(request);
    const q = (request.query ?? {}) as Record<string, unknown>;
    const linkId = typeof q.linkId === 'string' ? q.linkId : '';
    const rel = typeof q.path === 'string' ? q.path : '';
    const token = request.headers[STORE_TOKEN_HEADER];
    const s = sessions.current();
    if (grant === null || !givesStore(s) || s.id !== linkId) {
      // the session that owns the copy is over (finished, failed or cancelled): its copy goes at once
      if (grant !== null && building !== null && (s === null || s.id !== building.linkId)) {
        grant.end();
        building = null;
      }
      return refuse(reply, 404, 'not_found');
    }
    const f = grant.fileFor(linkId, typeof token === 'string' ? token : undefined, rel);
    if (f === null) return refuse(reply, 404, 'not_found');
    const start = rangeStart(request.headers.range, f.size);
    reply.header('Cache-Control', 'no-store').header('Content-Type', 'application/octet-stream').header('Accept-Ranges', 'bytes');
    if (start === null) return reply.code(200).header('Content-Length', String(f.size)).send(createReadStream(f.abs));
    reply.code(206).header('Content-Length', String(f.size - start)).header('Content-Range', `bytes ${start}-${Math.max(start, f.size - 1)}/${f.size}`);
    return reply.send(start >= f.size ? '' : createReadStream(f.abs, { start }));
  }));

  // ---- the list of boxes of this surau, at the master ----
  const notSeenSince = (r: Record<string, unknown>): string | null => {
    if (r.removed_at !== null && r.removed_at !== undefined) return null;
    const from = typeof r.last_seen_at === 'string' ? r.last_seen_at : String(r.linked_at);
    const ms = Date.parse(from);
    return Number.isNaN(ms) || d.now().getTime() - ms <= NOT_SEEN_MS ? null : new Date(ms).toISOString();
  };
  app.get('/api/boxes', guarded(async () => {
    const rows = db.prepare(
      `SELECT b.device_id, b.box_id, b.key_fp, b.name, b.version, b.linked_at, b.removed_at, b.link_id, d.last_seen_at, d.name AS device_name
         FROM linked_boxes b JOIN devices d ON d.id = b.device_id ORDER BY b.linked_at`,
    ).all();
    const rec = follow.present() ? follow.read() : null;
    return {
      self: {
        boxId: d.boxId, name: boxName(db, d.boxId), keyFp: d.identity.keyFp, version: boxVersion(),
        mode: follow.present() ? 'follower' : 'main', master: rec === null ? null : { name: rec.masterName, boxId: rec.masterBoxId },
        ...backupView(),
      },
      boxes: rows.map((r) => ({
        id: String(r.device_id), boxId: String(r.box_id).split('#')[0], keyFp: String(r.key_fp),
        name: typeof r.device_name === 'string' && r.device_name !== '' ? r.device_name : String(r.name),
        version: String(r.version), linkedAt: String(r.linked_at), linkId: String(r.link_id),
        lastSeenAt: typeof r.last_seen_at === 'string' ? r.last_seen_at : null,
        removedAt: typeof r.removed_at === 'string' ? r.removed_at : null,
        // A follower not seen for more than 3 days (its time of last contact, else the day of the link). Only shown, never acted on.
        notSeenSince: notSeenSince(r),
        // "Pautan diputuskan dari kotak itu": the box left by itself (its local revert, D2)
        leftByItself: r.removed_at !== null && db.prepare("SELECT 1 AS x FROM change_log WHERE entity = 'link' AND entity_id = ? AND after_json LIKE '%\"event\":\"left\"%' LIMIT 1").get(String(r.link_id)) !== undefined,
      })),
    };
  }));

  // ---- this box's backup from before the link ("sandaran sebelum pautan") ----
  const backupView = (): Record<string, unknown> => {
    if (d.dataDir === null) return { backup: null, kept: null, freeBytes: null };
    const kept = listBackups(d.dataDir).find((b) => b.atUnlink);
    let freeBytes: number | null = null;
    try {
      freeBytes = statfsFreeBytes(d.dataDir);
    } catch {
      freeBytes = null;
    }
    return {
      backup: backupInfo(d.dataDir),
      // The data in use when the link was cut, kept 7 days: until then the choice can be changed.
      kept: kept === undefined ? null : {
        linkId: kept.manifest.linkId, at: kept.manifest.at, bytes: kept.manifest.bytes,
        until: Number.isNaN(Date.parse(kept.manifest.at)) ? null : new Date(Date.parse(kept.manifest.at) + AT_UNLINK_KEEP_DAYS * 86_400_000).toISOString(),
      },
      freeBytes,
    };
  };
  const followersNow = (): number => Number(db.prepare('SELECT COUNT(*) AS n FROM linked_boxes WHERE removed_at IS NULL').get()?.n ?? 0);
  const logLink = (request: FastifyRequest, linkId: string, event: string): void => {
    db.prepare('INSERT INTO change_log (at, actor, entity, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, NULL, ?)')
      .run(d.now().toISOString(), actorOf(request), 'link', linkId, JSON.stringify({ event }));
  };
  /** The backup routes change or destroy a whole store: the PIN typed now, the surau network, and a plain `confirm: true`. */
  const backupAct = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | { dataDir: string; linkId: string; body: Record<string, unknown> }> => {
    lanOnly(request);
    const b = bodyOf(request);
    const who = await provePin(request, reply, b.pin);
    if (typeof who !== 'string') return who;
    if (d.dataDir === null) throw new LinkError(404, 'no_backup');
    if (sessions.writesBlocked() || sessions.current() !== null) throw new LinkError(409, 'linking');
    if (d.unlinks?.open() === true) throw new LinkError(409, 'unlink_open');
    if (b.confirm !== true) throw new LinkError(400, 'confirm_required');
    const linkId = typeof b.linkId === 'string' && /^[0-9a-f]{32}$/.test(b.linkId) ? b.linkId : '';
    if (linkId === '') throw new LinkError(404, 'no_backup');
    return { dataDir: d.dataDir, linkId, body: b };
  };
  const codeOf = (e: unknown): string => (e instanceof Error ? e.message.split(': ')[1] ?? '' : '');

  app.get('/api/link/backup', guarded(async () => ({ ...backupView(), followers: followersNow() })));

  /**
   * "Buang sandaran sebelum pautan" (`which: 'backup'`): after it this box can never go back to its data of link day.
   * "Buang data lama" (`which: 'kept'`): the data kept for 7 days after the link was cut. Both free the space at once.
   */
  app.post('/api/link/backup/drop', SMALL, guarded(async (request, reply) => {
    const a = await backupAct(request, reply);
    if (!('linkId' in a)) return a;
    const kept = a.body.which === 'kept';
    try {
      dropBackup(a.dataDir, kept ? atUnlinkFolder(a.linkId) : a.linkId);
    } catch (e) {
      const code = codeOf(e);
      if (code === 'journal_open') throw new LinkError(409, 'linking');
      throw new LinkError(404, 'no_backup');
    }
    // the kept note names the folder just dropped: it goes with it (a note alone would still refuse a new link)
    if (kept && readKeptNote(a.dataDir)?.folder === atUnlinkFolder(a.linkId)) clearKeptNote(a.dataDir);
    logLink(request, a.linkId, kept ? 'kept_dropped' : 'backup_dropped');
    return { ok: true, ...backupView() };
  }));

  /**
   * "Kembali ke data sebelum dipautkan" at a box that runs alone again (its last follower is gone). The store in use
   * is set aside for 7 days, the backup comes back at the next start, and that start revokes every phone of the
   * restored store (`afterRestore.ts`). A box that still has followers leaves through the unlink, not through here.
   */
  app.post('/api/link/backup/restore', SMALL, guarded(async (request, reply) => {
    const a = await backupAct(request, reply);
    if (!('linkId' in a)) return a;
    if (d.isLive()) throw new LinkError(409, 'live_on');
    if (followersNow() > 0) throw new LinkError(409, 'has_followers');
    try {
      planRestore(a.dataDir, a.linkId, d.now());
    } catch (e) {
      const code = codeOf(e);
      if (code === 'journal_open') throw new LinkError(409, 'linking');
      if (code === 'at_unlink_exists') throw new LinkError(409, 'kept_exists');
      if (code === 'other_volume') throw new LinkError(409, 'other_volume');
      throw new LinkError(404, 'no_backup');
    }
    noteKeptByRestore(a.dataDir, 'master', a.linkId, { ownName: boxName(d.db, d.boxId) }, d.now());
    logLink(request, a.linkId, 'restore_planned');
    if (d.restart !== undefined) {
      const t = setTimeout(d.restart, 750);
      t.unref();
    }
    return { ok: true, restarting: d.restart !== undefined };
  }));

  /** "Tanggalkan": the follower's token dies now. The box itself is told to forget the surau when it next asks. */
  app.delete('/api/boxes/:id', guarded(async (request, reply) => {
    lanOnly(request);
    userOf(request);
    const id = String((request.params as { id?: unknown }).id ?? '');
    const row = db.prepare('SELECT removed_at FROM linked_boxes WHERE device_id = ?').get(id);
    if (row === undefined) return refuse(reply, 404, 'not_found');
    if (sessions.writesBlocked()) throw new LinkError(409, 'linking');
    const at = d.now().toISOString();
    tx(db, () => {
      db.prepare('DELETE FROM kiosk_cookies WHERE device_id = ?').run(id);
      db.prepare('UPDATE linked_boxes SET removed_at = COALESCE(removed_at, ?) WHERE device_id = ?').run(at, id);
      revokeDeviceRow(db, id, actorOf(request), at);
    });
    return { ok: true };
  }));
}
