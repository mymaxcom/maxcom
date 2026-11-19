import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CAMERA_URL_MAX, maskCameraUrl } from '@surau/core';
import { actorOf, deviceOf } from '../actor.ts';
import { openSecret } from '../auth/crypto.ts';
import { createRateLimiter } from '../auth/ratelimit.ts';
import type { RateLimiter } from '../auth/ratelimit.ts';
import { reqSurau } from '../reqSurau.ts';
import { cleanCameraRecord, deriveCameraSecretKey } from './cameraSecretCloud.ts';
import { SEALED_RE } from './cameraRelayCrypto.ts';
import { enqueueCameraMark } from './workerOutbox.ts';

/**
 * The cloud's half of "set the camera from anywhere" (RTSP address + login from a phone away from the surau). SECURITY code.
 *
 *  - The phone seals {address, login} to the BOX's public key (`cameraRelayCrypto.ts`). The cloud keeps and relays
 *    that sealed value; it holds no key that opens it, and it never validates the address (the box does, with the
 *    same rules as the surau's Wi-Fi form, and reports the outcome in its acknowledgement).
 *  - One row per surau (`camera_relay`). `seq` grows by one per change and is part of what the phone seals, so a
 *    value cannot be played again, to another box or under another number: the cloud takes only `seq = last + 1` for
 *    the box named by the surau's own site, and the box applies only a number above the last it applied.
 *  - What the phone reads back is the masked address (password as dots) and `hasPassword`: from the box's own
 *    acknowledgement, or from the older sealed backup (`camera_secrets`), whichever is newer. Never the password.
 *  - A change is `pending` until the box acknowledges it on its next check (a few minutes). A refusal by the box
 *    is kept as a short fixed code, never as text the box or the phone sent.
 *  - The cloud's change history keeps only that a change was queued or acknowledged, by whom, and its number.
 *  - A queued change also marks the box at the Worker (`enqueueCameraMark`): the box's signed `GET /dirty` then says
 *    `camera: true` and the box runs a waking cycle, so a change sent from 4G reaches it even when the cloud slept. The
 *    mark is cleared when the box answers, or when it asks and nothing waits for it (the Worker drops it after 24 h).
 */

export interface CameraRelayCloudDeps {
  role: 'box' | 'cloud';
  db: DatabaseSync;
  now: () => Date;
  /** The cloud's master key (32 bytes): opens the older sealed backup to show the masked address. Null: no backup shown. */
  masterKey: Buffer | null;
  clock?: () => number;
}

const MSG = {
  notFound: 'not found',
  badRequest: 'Permintaan tidak sah',
  noBox: 'Kotak belum disambung ke awan, jadi kamera hanya boleh ditetapkan di Wi-Fi surau.',
  stale: 'Tetapan kamera telah berubah. Cuba lagi.',
  tooMany: 'Terlalu banyak percubaan. Cuba sebentar lagi.',
  testHere: 'Uji kamera hanya di Wi-Fi surau.',
} as const;

const FIELD_MAX = 128;
const BOX_ID_RE = /^[0-9a-f]{16}$/;
const NO_CTRL = /^[^\u0000-\u001f\u007f]*$/;
/** What a box may say about why it did not apply a change: a fixed vocabulary. */
const FAIL_CODES = new Set(['bad_address', 'bad_login', 'password_again', 'unreadable', 'stale', 'error']);

export interface RelayRow {
  surauId: string;
  seq: number;
  op: 'put' | 'delete';
  sealed: string | null;
  boxId: string;
  state: 'pending' | 'applied' | 'failed';
  code: string | null;
  display: Display | null;
  queuedAt: string;
  ackedAt: string | null;
}

export interface Display {
  configured: boolean;
  url: string;
  username: string | null;
  hasPassword: boolean;
  /** Only when true: the box restored the camera from the backup and waits for its password to be typed again. */
  passwordNeeded?: true;
}

const none = (): Display => ({ configured: false, url: '', username: null, hasPassword: false });

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A masked display from the box's acknowledgement, or null. Re-masked here, so a password cannot pass through. */
export function cleanDisplay(v: unknown): Display | null {
  if (!isRec(v) || typeof v.configured !== 'boolean' || typeof v.hasPassword !== 'boolean' || typeof v.url !== 'string') return null;
  const username = v.username;
  if (username !== null && username !== undefined && (typeof username !== 'string' || username.length > FIELD_MAX || !NO_CTRL.test(username))) return null;
  if (v.url.length > CAMERA_URL_MAX || !NO_CTRL.test(v.url)) return null;
  return {
    configured: v.configured,
    url: maskCameraUrl(v.url),
    username: typeof username === 'string' && username !== '' ? username : null,
    hasPassword: v.hasPassword,
    ...(v.passwordNeeded === true && !v.hasPassword ? { passwordNeeded: true as const } : {}),
  };
}

export function ensureRelayTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS camera_relay (
      surau_id TEXT NOT NULL PRIMARY KEY,
      seq INTEGER NOT NULL,
      op TEXT NOT NULL,
      sealed TEXT,
      box_id TEXT NOT NULL,
      state TEXT NOT NULL,
      code TEXT,
      display_json TEXT,
      queued_at TEXT NOT NULL,
      acked_at TEXT
    )
  `);
}

function readRow(db: DatabaseSync, surauId: string): RelayRow | null {
  const r = db.prepare('SELECT * FROM camera_relay WHERE surau_id = ?').get(surauId);
  if (r === undefined) return null;
  let display: Display | null = null;
  if (typeof r.display_json === 'string') {
    try {
      display = cleanDisplay(JSON.parse(r.display_json));
    } catch {
      display = null;
    }
  }
  return {
    surauId,
    seq: Number(r.seq),
    op: r.op === 'delete' ? 'delete' : 'put',
    sealed: typeof r.sealed === 'string' ? r.sealed : null,
    boxId: String(r.box_id),
    state: r.state === 'applied' || r.state === 'failed' ? r.state : 'pending',
    code: typeof r.code === 'string' ? r.code : null,
    display,
    queuedAt: String(r.queued_at),
    ackedAt: typeof r.acked_at === 'string' ? r.acked_at : null,
  };
}

/** The surau's live site with its public key: the box a sealed value is for. Null when none is linked. */
function siteOf(db: DatabaseSync, surauId: string): { boxId: string; jwk: Record<string, string> } | null {
  const rows = db
    .prepare('SELECT box_id, public_jwk FROM sites WHERE surau_id = ? AND linked_at IS NOT NULL AND revoked_at IS NULL AND public_jwk IS NOT NULL ORDER BY linked_at DESC, box_id')
    .all(surauId);
  for (const r of rows) {
    try {
      const j = JSON.parse(String(r.public_jwk)) as Record<string, unknown>;
      if (j.kty === 'EC' && j.crv === 'P-256' && typeof j.x === 'string' && typeof j.y === 'string' && BOX_ID_RE.test(String(r.box_id))) {
        return { boxId: String(r.box_id), jwk: { kty: 'EC', crv: 'P-256', x: j.x, y: j.y } };
      }
    } catch {
      /* next site */
    }
  }
  return null;
}

/** Masked view of the backup (which holds no password): the address, the user name and whether a password exists. */
function maskedOfBackup(rec: { url: string; username?: string; hasPassword: boolean; passwordNeeded?: true }): Display {
  const m = /^rtsp:\/\/([^@/?#]*)@/.exec(rec.url);
  const user = m !== null ? (m[1] ?? '') : (rec.username ?? '');
  // a box waiting for its password holds none: the form asks for it instead of showing dots
  if (rec.passwordNeeded === true) return { configured: true, url: maskCameraUrl(rec.url), username: user !== '' ? user : null, hasPassword: false, passwordNeeded: true };
  return { configured: true, url: maskCameraUrl(rec.url), username: user !== '' ? user : null, hasPassword: rec.hasPassword };
}

export function registerCameraRelayCloudRoutes(app: FastifyInstance, deps: CameraRelayCloudDeps): void {
  if (deps.role !== 'cloud') {
    // a box has no relay queue: the routes exist (one permission table for both roles) and answer "not found"
    const notHere = async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> =>
      reply.code(404).header('Cache-Control', 'no-store').send({ errors: [MSG.notFound] });
    app.get('/api/sync/camera-relay', notHere);
    app.post('/api/sync/camera-relay/ack', notHere);
    return;
  }
  const { db, now } = deps;
  ensureRelayTable(db);
  const backupKey = deps.masterKey === null ? null : deriveCameraSecretKey(deps.masterKey);
  const clock = deps.clock === undefined ? {} : { now: deps.clock };
  const writes: RateLimiter = createRateLimiter({ windowMs: 60_000, max: 10, ...clock });
  const reads: RateLimiter = createRateLimiter({ windowMs: 60_000, max: 60, ...clock });
  const polls: RateLimiter = createRateLimiter({ windowMs: 60_000, max: 30, ...clock });

  const send = (reply: FastifyReply, code: number, body: unknown): FastifyReply => reply.code(code).header('Cache-Control', 'no-store').send(body);
  const tooMany = (reply: FastifyReply, retry: number): FastifyReply => {
    reply.header('Retry-After', String(retry));
    return send(reply, 429, { errors: [MSG.tooMany], code: 'too_many' });
  };
  const limitKey = (request: FastifyRequest): string => {
    const a = request.auth;
    return `${reqSurau(request)}:${a != null && a.kind === 'user' ? a.sessionId : request.ip}`;
  };
  const userOnly = (request: FastifyRequest): boolean => request.auth != null && request.auth.kind === 'user';

  const audit = (surauId: string, actor: string, deviceId: string | null, id: string, after: Record<string, unknown>): void => {
    // who and what, never the sealed value or anything of the address
    db.prepare('INSERT INTO change_log (surau_id, at, actor, entity, entity_id, before_json, after_json, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      surauId,
      now().toISOString(),
      actor,
      'live-camera/cloud-relay',
      id,
      null,
      JSON.stringify(after),
      deviceId,
    );
  };

  /** What the phone sees: the masked address from the newer of the box's acknowledgement and the older backup. */
  function displayOf(surauId: string, row: RelayRow | null): Display {
    let backup: { at: string; d: Display } | null = null;
    if (backupKey !== null) {
      const b = db.prepare('SELECT sealed, updated_at FROM camera_secrets WHERE surau_id = ?').get(surauId);
      if (b !== undefined) {
        try {
          const j = JSON.parse(openSecret(backupKey, String(b.sealed))) as Record<string, unknown>;
          const { surauId: owner, ...rest } = j;
          const rec = owner === surauId ? cleanCameraRecord(rest) : null;
          if (rec !== null) backup = { at: String(b.updated_at), d: maskedOfBackup(rec) };
        } catch {
          backup = null;
        }
      }
    }
    const ack = row !== null && row.state === 'applied' && row.display !== null && row.ackedAt !== null ? { at: row.ackedAt, d: row.display } : null;
    if (ack !== null && (backup === null || ack.at >= backup.at)) return ack.d;
    return backup?.d ?? none();
  }

  function view(surauId: string): Record<string, unknown> {
    const row = readRow(db, surauId);
    const site = siteOf(db, surauId);
    const pending = row !== null && row.state === 'pending';
    return {
      ...displayOf(surauId, row),
      lastTest: null,
      pending,
      failure: row !== null && row.state === 'failed' ? (row.code ?? 'error') : null,
      // what the phone needs to seal a new value: the box, its public key and the number this change takes
      relay: site === null ? null : { boxId: site.boxId, key: site.jwk, seq: (row?.seq ?? 0) + 1 },
    };
  }

  app.get('/api/live/camera', async (request, reply) => {
    if (!userOnly(request)) return send(reply, 404, { errors: [MSG.notFound] });
    const hit = reads.hit(limitKey(request));
    if (!hit.ok) return tooMany(reply, hit.retryAfterSec);
    return send(reply, 200, view(reqSurau(request)));
  });

  const queue = (request: FastifyRequest, reply: FastifyReply, op: 'put' | 'delete', sealed: string | null, boxId: string | null, seq: number | null): FastifyReply => {
    const surauId = reqSurau(request);
    const hit = writes.hit(limitKey(request));
    if (!hit.ok) return tooMany(reply, hit.retryAfterSec);
    const site = siteOf(db, surauId);
    if (site === null) return send(reply, 409, { errors: [MSG.noBox], code: 'no_box' });
    const row = readRow(db, surauId);
    const next = (row?.seq ?? 0) + 1;
    // a value sealed for another box, or numbered before the last change, is stale: the phone reads again and seals again
    if (op === 'put' && (boxId !== site.boxId || seq !== next)) return send(reply, 409, { errors: [MSG.stale], code: 'stale' });
    const at = now().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO camera_relay (surau_id, seq, op, sealed, box_id, state, code, display_json, queued_at, acked_at)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)
         ON CONFLICT(surau_id) DO UPDATE SET seq = excluded.seq, op = excluded.op, sealed = excluded.sealed, box_id = excluded.box_id,
           state = 'pending', code = NULL, display_json = excluded.display_json, queued_at = excluded.queued_at, acked_at = NULL`,
      ).run(surauId, next, op, sealed, site.boxId, row?.display !== null && row?.display !== undefined ? JSON.stringify(row.display) : null, at);
      // the box learns of it at its next Worker check, even while this cloud sleeps
      enqueueCameraMark(db, site.boxId, true, now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    audit(surauId, actorOf(request), deviceOf(request) ?? null, op === 'put' ? 'queue-save' : 'queue-clear', { seq: next, boxId: site.boxId });
    return send(reply, 200, view(surauId));
  };

  app.put('/api/live/camera', async (request, reply) => {
    if (!userOnly(request)) return send(reply, 404, { errors: [MSG.notFound] });
    const b = request.body;
    if (!isRec(b) || Object.keys(b).some((k) => k !== 'boxId' && k !== 'seq' && k !== 'sealed')) return send(reply, 400, { errors: [MSG.badRequest], code: 'invalid' });
    if (typeof b.boxId !== 'string' || !BOX_ID_RE.test(b.boxId) || typeof b.seq !== 'number' || !Number.isSafeInteger(b.seq) || b.seq < 1 || typeof b.sealed !== 'string' || !SEALED_RE.test(b.sealed)) {
      return send(reply, 400, { errors: [MSG.badRequest], code: 'invalid' });
    }
    return queue(request, reply, 'put', b.sealed, b.boxId, b.seq);
  });

  app.delete('/api/live/camera', async (request, reply) => {
    if (!userOnly(request)) return send(reply, 404, { errors: [MSG.notFound] });
    return queue(request, reply, 'delete', null, null, null);
  });

  // A test needs the box's own network: over the cloud it says so, in the box's wording, instead of "not found".
  app.post('/api/live/camera/test', async (request, reply) => {
    if (!userOnly(request)) return send(reply, 404, { errors: [MSG.notFound] });
    return send(reply, 409, { errors: [MSG.testHere], code: 'at_surau_only' });
  });

  // ---- the box's side: what is waiting for it, and its answer ---------------------------------------------------

  const siteOnly = (request: FastifyRequest, reply: FastifyReply): { boxId: string } | null => {
    const a = request.auth;
    if (a == null || a.kind !== 'site') {
      send(reply, 404, { errors: [MSG.notFound] });
      return null;
    }
    return { boxId: a.boxId };
  };

  app.get('/api/sync/camera-relay', async (request, reply) => {
    const site = siteOnly(request, reply);
    if (site === null) return reply;
    const hit = polls.hit(`${reqSurau(request)}:${site.boxId}`);
    if (!hit.ok) return tooMany(reply, hit.retryAfterSec);
    const row = readRow(db, reqSurau(request));
    // only the box the value was sealed for, and only while it waits
    if (row === null || row.state !== 'pending' || row.boxId !== site.boxId) {
      // nothing waits for this box: a mark left at the Worker would only keep it cycling
      enqueueCameraMark(db, site.boxId, false, now());
      return send(reply, 404, { code: 'none' });
    }
    return send(reply, 200, { seq: row.seq, op: row.op, boxId: row.boxId, ...(row.sealed !== null ? { sealed: row.sealed } : {}) });
  });

  app.post('/api/sync/camera-relay/ack', async (request, reply) => {
    const site = siteOnly(request, reply);
    if (site === null) return reply;
    const surauId = reqSurau(request);
    const hit = polls.hit(`${surauId}:${site.boxId}`);
    if (!hit.ok) return tooMany(reply, hit.retryAfterSec);
    const b = request.body;
    if (!isRec(b) || typeof b.seq !== 'number' || !Number.isSafeInteger(b.seq) || typeof b.ok !== 'boolean') return send(reply, 400, { errors: [MSG.badRequest], code: 'invalid' });
    const display = b.ok ? cleanDisplay(b.display) : null;
    if (b.ok && display === null) return send(reply, 400, { errors: [MSG.badRequest], code: 'invalid' });
    const code = b.ok ? null : typeof b.code === 'string' && FAIL_CODES.has(b.code) ? b.code : 'error';
    const row = readRow(db, surauId);
    // an old or foreign acknowledgement changes nothing
    if (row === null || row.boxId !== site.boxId || row.seq !== b.seq || row.state !== 'pending') return send(reply, 200, { acknowledged: false });
    const at = now().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE camera_relay SET state = ?, code = ?, display_json = ?, acked_at = ? WHERE surau_id = ? AND seq = ? AND state = 'pending'").run(
        b.ok ? 'applied' : 'failed',
        code,
        display !== null ? JSON.stringify(display) : row.display !== null ? JSON.stringify(row.display) : null,
        at,
        surauId,
        b.seq,
      );
      // answered: the Worker stops telling the box
      enqueueCameraMark(db, site.boxId, false, now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    audit(surauId, `site:${site.boxId}`, null, 'ack', { seq: b.seq, ok: b.ok, ...(code !== null ? { code } : {}) });
    return send(reply, 200, { acknowledged: true });
  });
}
