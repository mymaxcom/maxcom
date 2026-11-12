import { createReadStream } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { can } from '@surau/core';
import type { OpResult, SyncStatus } from '@surau/core';
import { tooMany } from '../auth/authz.ts';
import { createRateLimiter } from '../auth/ratelimit.ts';
import type { AuthContext, Limiters, SiteAuth } from '../auth/authz.ts';
import type { ChangeBus } from '../events.ts';
import { getSettings, getVersion } from '../settingsStore.ts';
import { actorOf, deviceOf } from '../actor.ts';
import { noteFinanceView } from '../finance/viewLog.ts';
import { PHOTO_ID_RE, PhotoError, checkJpeg, checkReplicatedBytes, markPresent, photoMeta, photoPath, sha256Of, writePhotoFile } from '../finance/photos.ts';
import { MAX_PHOTO_BYTES } from '@surau/core';
import { identityCan } from '../auth/authz.ts';
import { freezeReport } from '../finance/report.ts';
import { MAX_ASSET_OP_BYTES, applyFeedEntry, applyOp } from './apply.ts';
import { readFeed, snapshot } from './feed.ts';
import type { FeedScope } from './feed.ts';
import { DEFAULT_SURAU_ID, logSyncRefusal, verifyDeviceOp, verifySiteEntry } from './verify.ts';
import { claimCodeOf, linkState } from './register.ts';

export const MAX_OPS_PER_BATCH = 200;
export const MAX_ASSET_OPS_PER_BATCH = 2;
/**
 * Largest request body of the batch route (the app-wide default is 2 MB). An `asset.put` op carries its file
 * as base64 (4/3 of the bytes), and a batch may hold MAX_ASSET_OPS_PER_BATCH of them at the 8 MB cap
 * (MAX_ASSET_OP_BYTES), plus room for the ordinary ops: derived from those constants so the two never
 * drift apart (the old 10 MB body refused an 8 MB file after base64, an effective 7.4 MB cap).
 */
export const SYNC_BODY_LIMIT = Math.ceil((MAX_ASSET_OP_BYTES * 4) / 3) * MAX_ASSET_OPS_PER_BATCH + 2 * 1024 * 1024;
export const MAX_ENTRIES_PER_BATCH = 500;
export const MAX_CHANGES_PAGE = 500;
/** A changes page is cut at this many serialized bytes, under the largest answer a box reads (the box reads SYNC_BODY_LIMIT). */
export const CHANGES_PAGE_BYTES = SYNC_BODY_LIMIT - 256 * 1024;

export type SyncRole = 'box' | 'cloud';

export interface SyncDeps {
  db: DatabaseSync;
  boxId: string;
  dataDir: string;
  now: () => Date;
  limiters: Limiters;
  bus: ChangeBus;
  /** `cloud` is the always-on replica (Task 4); a box never serves `/api/sync/link`. */
  role?: SyncRole;
  surauId?: string;
  /** The cloud's link-by-code exchange (sites.ts); absent, `POST /api/sync/link` answers 501. */
  link?: (body: unknown) => Promise<{ status: number; body: unknown }>;
  /** The cloud's automatic-link claim (sites.ts); absent, `POST /api/sync/claim` answers 501. */
  claim?: (body: unknown) => Promise<{ status: number; body: unknown }>;
}

/** A whole-batch refusal (nothing was applied). */
export class SyncBatchError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'SyncBatchError';
    this.status = status;
    this.code = code;
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const MSG_BAD_BODY = 'Permintaan tidak sah';
const MSG_FORBIDDEN = 'Tiada kebenaran untuk tindakan ini';
const CLAIM_BOX_ID_RE = /^[0-9a-f]{16}$/;

export interface DeviceBatchOut {
  results: OpResult[];
  seq: number;
  /** True when at least one op changed data (the caller then announces the new version once). */
  changed: boolean;
}

export interface SiteBatchOut {
  applied: number;
  duplicate: number;
  superseded: number;
  refused: number;
  /** Short reason codes of the refused entries (at most 20), so the box can tell a benign refusal from a real one. */
  reasons: string[];
  seq: number;
  changed: boolean;
  /** Finance entries only: the time THIS server first held each one, so the box can show when the cloud received it. */
  receivedAt: Record<string, string>;
}

/** The change-log head visible in `scope` (what a puller clears the dirty flag with). */
export function headSeq(db: DatabaseSync, scope: FeedScope): number {
  return readFeed(db, Number.MAX_SAFE_INTEGER, 1, scope).head;
}

/**
 * What an identity may be served. A signed-in user gets finance only while the finance module is on (the same
 * switch the finance routes honour); a linked site replicates finance whatever the switch says.
 */
export function scopeOf(identity: AuthContext | SiteAuth, db: DatabaseSync): FeedScope {
  if (identity.kind === 'site') return { users: true, devices: true, keys: true, finance: true, financeWrite: true };
  const financeOn = getSettings(db).finance.enabled === true;
  return {
    users: can(identity.roles, 'users:manage'),
    devices: can(identity.roles, 'devices:manage'),
    finance: financeOn && can(identity.roles, 'finance:read'),
    financeWrite: financeOn && can(identity.roles, 'finance:write'),
  };
}

/** The verify-and-apply core, separate from HTTP so it can be exercised with a session captured before a revocation. */
export function createSyncService(deps: SyncDeps) {
  const { db, boxId, dataDir } = deps;
  const surauId = deps.surauId ?? DEFAULT_SURAU_ID;
  const server = { boxId, surauId };

  /**
   * Verify then apply a device's queued ops, in order. A refused op does not block the rest. The batch is
   * refused whole (nothing applied) when it is too big or carries an op for another device or user.
   */
  function processDeviceOps(auth: AuthContext, ops: unknown, ip: string | null): DeviceBatchOut {
    if (!Array.isArray(ops)) throw new SyncBatchError(400, 'bad_body', MSG_BAD_BODY);
    if (ops.length > MAX_OPS_PER_BATCH) {
      throw new SyncBatchError(400, 'too_many_ops', `Terlalu banyak operasi dalam satu kumpulan (had ${MAX_OPS_PER_BATCH})`);
    }
    let assets = 0;
    for (const o of ops) {
      if (!isPlain(o)) throw new SyncBatchError(400, 'bad_body', MSG_BAD_BODY);
      if (o.kind === 'asset.put') assets += 1;
    }
    if (assets > MAX_ASSET_OPS_PER_BATCH) {
      throw new SyncBatchError(400, 'too_many_assets', `Terlalu banyak fail dalam satu kumpulan (had ${MAX_ASSET_OPS_PER_BATCH})`);
    }
    // The session that carries the batch must belong to the device and user of every op in it.
    for (const o of ops as Record<string, unknown>[]) {
      if (o.deviceId !== auth.deviceId || o.userId !== auth.userId) {
        logSyncRefusal(db, deps.now(), { userId: auth.userId, deviceId: auth.deviceId, ip }, 'device_mismatch');
        throw new SyncBatchError(403, 'device_mismatch', MSG_FORBIDDEN);
      }
    }

    const results: OpResult[] = [];
    let changed = false;
    for (const raw of ops as Record<string, unknown>[]) {
      const now = deps.now();
      const opId = typeof raw.opId === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(raw.opId) ? raw.opId : '';
      const v = verifyDeviceOp(db, raw, now, server, ip);
      if (!v.ok) {
        results.push({ opId, status: 'refused', rev: null, reason: v.reason, winner: null });
        continue;
      }
      const r = applyOp(db, v.op, { now, origin: 'app', actor: `user:${v.op.userId}`, dataDir, role: deps.role ?? 'box', surauId, freezeReport: (d, ym, at) => freezeReport(d, ym, at, deps.role ?? 'box') });
      if (r.status === 'refused') {
        logSyncRefusal(db, now, { userId: v.op.userId, deviceId: v.op.deviceId, ip }, `apply_${r.reason ?? 'invalid'}`);
      }
      if (r.status === 'applied') changed = true;
      results.push(r);
    }
    return { results, seq: headSeq(db, scopeOf(auth, db)), changed };
  }

  /** Apply the feed entries a linked box pushes, in order, under the same merge rule. */
  function processSiteEntries(site: SiteAuth, entries: unknown, ip: string | null): SiteBatchOut {
    if (!Array.isArray(entries)) throw new SyncBatchError(400, 'bad_body', MSG_BAD_BODY);
    if (entries.length > MAX_ENTRIES_PER_BATCH) {
      throw new SyncBatchError(400, 'too_many_entries', `Terlalu banyak entri dalam satu kumpulan (had ${MAX_ENTRIES_PER_BATCH})`);
    }
    const out: SiteBatchOut = { applied: 0, duplicate: 0, superseded: 0, refused: 0, reasons: [], seq: 0, changed: false, receivedAt: {} };
    const note = (code: string): void => {
      if (out.reasons.length < 20) out.reasons.push(code);
    };
    for (const raw of entries) {
      const now = deps.now();
      const v = verifySiteEntry(site, { surauId }, raw);
      if (!v.ok) {
        logSyncRefusal(db, now, { ip }, `site_${v.detail}`);
        out.refused += 1;
        note(`site_${v.detail}`);
        continue;
      }
      const r = applyFeedEntry(db, v.entry, { now, origin: `box:${site.boxId}`, actor: v.entry.actor, dataDir, acceptDeviceEnrolment: true, role: deps.role ?? 'box', surauId });
      if (v.entry.entity === 'finance:entry' && (r.status === 'applied' || r.status === 'duplicate') && Object.keys(out.receivedAt).length < MAX_ENTRIES_PER_BATCH) {
        const held = db.prepare('SELECT received_at FROM finance_entries WHERE id = ?').get(v.entry.entityId);
        if (held !== undefined) out.receivedAt[v.entry.entityId] = String(held.received_at);
      }
      if (r.status === 'applied') {
        out.applied += 1;
        out.changed = true;
      } else if (r.status === 'duplicate') out.duplicate += 1;
      else if (r.status === 'superseded') out.superseded += 1;
      else {
        out.refused += 1;
        note(r.reason ?? 'invalid');
        logSyncRefusal(db, now, { ip }, `site_apply_${r.reason ?? 'invalid'}`);
      }
    }
    out.seq = headSeq(db, { users: true, devices: true });
    return out;
  }

  return { processDeviceOps, processSiteEntries };
}

function stateOf(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
  return row !== undefined && typeof row.value === 'string' ? row.value : null;
}

/** `sync_state.log_floor`: the highest change_log id a trim job removed (0 when the log was never trimmed). */
function logFloor(db: DatabaseSync): number {
  const n = Number(stateOf(db, 'log_floor') ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function syncStatus(db: DatabaseSync, role: SyncRole): SyncStatus {
  if (role === 'cloud') {
    const row = db.prepare('SELECT COUNT(*) AS n FROM sites WHERE linked_at IS NOT NULL AND revoked_at IS NULL').get();
    return { linked: Number(row?.n ?? 0) > 0, cloudUrl: null, lastPush: null, lastPull: null, pendingOut: 0, lastError: null };
  }
  const pending = Number(stateOf(db, 'pending_out') ?? 0);
  const err = stateOf(db, 'last_error');
  return {
    linked: stateOf(db, 'linked') === '1',
    cloudUrl: stateOf(db, 'cloud_url'),
    lastPush: stateOf(db, 'last_push'),
    lastPull: stateOf(db, 'last_pull'),
    pendingOut: Number.isFinite(pending) && pending > 0 ? Math.trunc(pending) : 0,
    lastError: err === null ? null : err.slice(0, 200),
  };
}

export function registerSyncRoutes(app: FastifyInstance, deps: SyncDeps): void {
  const { db, now, bus, dataDir } = deps;
  const role: SyncRole = deps.role ?? 'box';
  const service = createSyncService(deps);
  const surauId = deps.surauId ?? DEFAULT_SURAU_ID;
  // linking has its own bucket: enrolment and linking must not exhaust each other (5 / 10 min per IP)
  const linkIp = createRateLimiter({ windowMs: 10 * 60_000, max: 5 });
  // the automatic claim: the same limit, in its own bucket per box id and address (a pending box asks every 5 minutes)
  const claimIp = createRateLimiter({ windowMs: 10 * 60_000, max: 5 });

  const fail = (reply: FastifyReply, status: number, code: string, message: string): FastifyReply =>
    reply.code(status).header('Cache-Control', 'no-store').send({ errors: [message], code });

  const identityOf = (request: FastifyRequest): AuthContext | SiteAuth | null => {
    const a = request.auth;
    return a != null && (a.kind === 'user' || a.kind === 'site') ? a : null;
  };

  app.post('/api/sync/ops', { bodyLimit: SYNC_BODY_LIMIT }, async (request, reply) => {
    const who = identityOf(request);
    if (who === null) return fail(reply, 403, 'forbidden', MSG_FORBIDDEN);
    const b = request.body;
    if (!isPlain(b)) return fail(reply, 400, 'bad_body', MSG_BAD_BODY);
    try {
      reply.header('Cache-Control', 'no-store');
      if (who.kind === 'site') {
        if (b.ops !== undefined) return fail(reply, 400, 'bad_body', MSG_BAD_BODY);
        const out = service.processSiteEntries(who, b.entries, request.ip);
        if (out.changed) bus.emit(getVersion(db));
        return { applied: out.applied, duplicate: out.duplicate, superseded: out.superseded, refused: out.refused, reasons: out.reasons, seq: out.seq, receivedAt: out.receivedAt };
      }
      if (b.entries !== undefined) return fail(reply, 400, 'bad_body', MSG_BAD_BODY);
      const out = service.processDeviceOps(who, b.ops, request.ip);
      if (out.changed) bus.emit(getVersion(db));
      return { results: out.results, seq: out.seq };
    } catch (error) {
      if (error instanceof SyncBatchError) return fail(reply, error.status, error.code, error.message);
      throw error;
    }
  });

  app.get('/api/sync/snapshot', async (request, reply) => {
    const who = identityOf(request);
    if (who === null) return fail(reply, 403, 'forbidden', MSG_FORBIDDEN);
    reply.header('Cache-Control', 'no-store');
    const snap = snapshot(db, scopeOf(who, db), { surauId, boxId: deps.boxId, now: now(), role });
    if (who.kind === 'user' && snap.finance !== undefined) {
      const f = snap.finance;
      if (f.funds.length + f.perihal.length + f.entries.length + f.months.length + f.photos.length > 0) {
        noteFinanceView(db, who, '/api/sync/snapshot', now(), actorOf(request), deviceOf(request));
      }
    }
    // The app lock is a local, live decision of each box: it never travels.
    delete snap.settings.appLock;
    return snap;
  });

  app.get('/api/sync/changes', async (request, reply) => {
    const who = identityOf(request);
    if (who === null) return fail(reply, 403, 'forbidden', MSG_FORBIDDEN);
    const q = (isPlain(request.query) ? request.query : {}) as Record<string, unknown>;
    const sinceText = q.since === undefined ? '0' : q.since;
    const limitText = q.limit === undefined ? String(MAX_CHANGES_PAGE) : q.limit;
    if (typeof sinceText !== 'string' || !/^\d{1,15}$/.test(sinceText)) return fail(reply, 400, 'bad_query', MSG_BAD_BODY);
    if (typeof limitText !== 'string' || !/^\d{1,5}$/.test(limitText)) return fail(reply, 400, 'bad_query', MSG_BAD_BODY);
    const since = Number(sinceText);
    const limit = Math.min(Math.max(Number(limitText), 1), MAX_CHANGES_PAGE);
    if (since < logFloor(db)) {
      return fail(reply, 410, 'snapshot_required', 'Sejarah perubahan telah dipangkas; ambil gambaran penuh');
    }
    reply.header('Cache-Control', 'no-store');
    const feed = readFeed(db, since, limit, scopeOf(who, db), CHANGES_PAGE_BYTES);
    if (who.kind === 'user' && feed.entries.some((e) => e.entity.startsWith('finance:'))) {
      noteFinanceView(db, who, '/api/sync/changes', now(), actorOf(request), deviceOf(request));
    }
    // No echo: what a box itself pushed is never handed back to it as a new change. The cursor still passes it.
    const entries = who.kind === 'site' ? feed.entries.filter((e) => e.origin !== `box:${who.boxId}`) : feed.entries;
    return { entries, next: feed.next, seq: feed.head, head: feed.head };
  });

  // ---- finance photo bytes (Plan 7): box -> cloud and cloud -> box, never through /assets/ ----
  // A photo's name is the sha256 of its bytes, and a server only takes bytes for a photo row it already knows (the
  // row travels first, as a feed entry) that is still waiting for them. Same size and type rules as the upload route.
  void app.register(async (scope) => {
    scope.addContentTypeParser(['image/jpeg', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: MAX_PHOTO_BYTES }, (_request, body, done) => done(null, body));

    scope.put('/api/sync/finance-photos/:id', { bodyLimit: MAX_PHOTO_BYTES }, async (request, reply) => {
      const who = identityOf(request);
      if (who === null) return fail(reply, 403, 'forbidden', MSG_FORBIDDEN);
      if (who.kind === 'user' && !identityCan(who, 'finance:write')) return fail(reply, 403, 'forbidden', MSG_FORBIDDEN);
      const { id } = request.params as { id: string };
      const body: unknown = request.body;
      if (!PHOTO_ID_RE.test(id) || !Buffer.isBuffer(body)) return fail(reply, 400, 'bad_body', MSG_BAD_BODY);
      const meta = photoMeta(db, id);
      if (meta === null) return fail(reply, 404, 'not_found', 'Tidak dijumpai');
      if (meta.present) return reply.header('Cache-Control', 'no-store').send({ ok: true });
      if (sha256Of(body) !== id) return fail(reply, 400, 'bad_body', MSG_BAD_BODY);
      try {
        checkJpeg(body);
        checkReplicatedBytes(db, meta, body);
      } catch (error) {
        if (error instanceof PhotoError) return fail(reply, error.status, 'bad_body', MSG_BAD_BODY);
        throw error;
      }
      writePhotoFile(dataDir, id, body);
      markPresent(db, id);
      return reply.header('Cache-Control', 'no-store').send({ ok: true });
    });

    scope.get('/api/sync/finance-photos/:id', async (request, reply) => {
      const who = identityOf(request);
      if (who === null) return fail(reply, 403, 'forbidden', MSG_FORBIDDEN);
      if (who.kind === 'user' && !identityCan(who, 'finance:write')) return fail(reply, 403, 'forbidden', MSG_FORBIDDEN);
      const { id } = request.params as { id: string };
      if (!PHOTO_ID_RE.test(id)) return fail(reply, 404, 'not_found', 'Tidak dijumpai');
      const found = photoPath(db, dataDir, id);
      if (found === null) return fail(reply, 404, 'not_found', 'Tidak dijumpai');
      return reply
        .header('Content-Type', found.mime)
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .send(createReadStream(found.path));
    });
  });

  app.get('/api/sync/status', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    // a box also tells how its link stands: linked, pending (waiting for MAXCOM's approval) or off
    if (role !== 'box') return syncStatus(db, role);
    const link = linkState(db);
    // while the link waits for approval, the box shows its claim code for the surau to read out to MAXCOM
    const claimCode = link === 'pending' ? claimCodeOf(db) : null;
    return { ...syncStatus(db, role), link, ...(claimCode !== null ? { claimCode } : {}) };
  });

  app.post('/api/sync/link', {
    bodyLimit: 8 * 1024,
    preHandler: async (_request, reply) => {
      // Only the cloud links a box; on a box the route does not exist.
      if (role !== 'cloud') return fail(reply, 404, 'not_found', 'Tidak dijumpai');
      const hit = linkIp.hit(_request.ip);
      return hit.ok ? undefined : tooMany(reply, hit.retryAfterSec);
    },
  }, async (request, reply) => {
    if (deps.link === undefined) return fail(reply, 501, 'not_implemented', 'Belum tersedia');
    const out = await deps.link(request.body);
    return reply.code(out.status).header('Cache-Control', 'no-store').send(out.body);
  });

  // The automatic link (sites.ts `redeemClaim`): a box that MAXCOM approved proves its claim secret once.
  app.post('/api/sync/claim', {
    bodyLimit: 2 * 1024,
    preHandler: async (_request, reply) => {
      // Only the cloud issues site keys; on a box the route does not exist.
      if (role !== 'cloud') return fail(reply, 404, 'not_found', 'Tidak dijumpai');
      // keyed on box id + address, so boxes behind one address (a mosque network, a carrier NAT) do not share a
      // bucket; a malformed box id falls back to the address alone
      const sent = isPlain(_request.body) ? _request.body.boxId : undefined;
      const hit = claimIp.hit(typeof sent === 'string' && CLAIM_BOX_ID_RE.test(sent) ? `${sent}|${_request.ip}` : _request.ip);
      return hit.ok ? undefined : tooMany(reply, hit.retryAfterSec);
    },
  }, async (request, reply) => {
    if (deps.claim === undefined) return fail(reply, 501, 'not_implemented', 'Belum tersedia');
    const out = await deps.claim(request.body);
    return reply.code(out.status).header('Cache-Control', 'no-store').send(out.body);
  });
}
