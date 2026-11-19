import { hkdfSync } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CAMERA_URL_MAX, cameraUrlError } from '@surau/core';
import { openSecret, sealSecret } from '../auth/crypto.ts';
import { createRateLimiter } from '../auth/ratelimit.ts';
import type { RateLimiter } from '../auth/ratelimit.ts';
import { reqSurau } from '../reqSurau.ts';
import { cameraBackupOf } from '../live/camera.ts';

/**
 * The cloud's sealed backup of a surau's external camera address (plan 4.2, 6, 7). SECURITY code.
 *
 *  - Three routes under `/api/sync/camera-secret` (`PUT`, `GET`, `DELETE`), for the linked site only: a device
 *    session, a kiosk or no session gets 404, and so does a box (the routes exist on the cloud only).
 *  - The record is keyed by the site's surau (`request.tenant`), never by anything the caller sends: a box of
 *    another surau reads and writes its own row and cannot name this one. A replaced box of the same surau gets
 *    the same record back.
 *  - Stored as `sealSecret(cloudKey, json)`. The cloud key is derived from the cloud's master key in its own HKDF
 *    domain (`camera-secret`), the same scheme as the wake secret and the Google token, so the database file alone
 *    cannot show the address or the login. The surau id is inside the sealed text and checked on open, so a row
 *    moved to another surau does not open.
 *  - The address and login are never logged, never put in `change_log`, never in an error text. The history keeps
 *    only that a backup was stored or removed, and by which box.
 *  - The record is never sent to a device by the cloud and never enters the settings feed.
 *  - The cloud never holds the camera PASSWORD (operator decision 2026-11-19): a row is {address without the
 *    password, user name, hasPassword}. A password an older box still sends (beside the address or inside it) is
 *    dropped before anything is stored; rows written before this rule are rewritten once at start-up
 *    (`scrubCameraSecrets`). A replaced box restores the address and user name and asks for the password again.
 */

export interface CameraSecretCloudDeps {
  /** The routes exist on both roles (one route table) but answer 404 on a box. */
  role: 'box' | 'cloud';
  db: DatabaseSync;
  now: () => Date;
  /** The cloud's master key (32 bytes) or null (a bare in-memory cloud: the routes then answer 503). */
  masterKey: Buffer | null;
  /** Test seam: the limiter clock (ms). */
  clock?: () => number;
}

/** One camera backup: never the password. */
export interface CameraSecretRecord {
  url: string;
  username?: string;
  hasPassword: boolean;
  /** The box restored this record and waits for the password to be typed there or sent to it. */
  passwordNeeded?: true;
}

const FIELD_MAX = 128;
// `password` is still accepted from an older box so it is not refused forever, and is dropped unread
const BODY_FIELDS = new Set(['url', 'username', 'hasPassword', 'passwordNeeded', 'password']);
const SCRUB_FLAG = 'camera_secret_scrubbed_v2';
const NO_CTRL = /^[^\u0000-\u001f\u007f]*$/;

const MSG = {
  notFound: 'not found',
  badRequest: 'Permintaan tidak sah',
  none: 'Tiada sandaran kamera',
  unavailable: 'Sandaran kamera tidak tersedia di awan',
  tooMany: 'Terlalu banyak permintaan. Cuba sebentar lagi.',
} as const;

/** Key of the sealed rows: HKDF of the cloud master key, its own domain. */
export function deriveCameraSecretKey(masterKey: Buffer): Buffer {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) throw new Error('camera secret: bad key');
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'camera-secret', 32));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A clean record from a request body (or an older stored row), or null. The address obeys the shared address rules
 * (private IPv4, rtsp). Whatever password came in, beside the address or inside it, is dropped: only `hasPassword`
 * is kept.
 */
export function cleanCameraRecord(v: unknown): CameraSecretRecord | null {
  if (!isRecord(v)) return null;
  for (const k of Object.keys(v)) if (!BODY_FIELDS.has(k)) return null;
  if (typeof v.url !== 'string' || v.url.length > CAMERA_URL_MAX || cameraUrlError(v.url, []) !== null) return null;
  if (v.hasPassword !== undefined && typeof v.hasPassword !== 'boolean') return null;
  if (v.passwordNeeded !== undefined && typeof v.passwordNeeded !== 'boolean') return null;
  const login: { username?: string; password?: string } = {};
  for (const k of ['username', 'password'] as const) {
    const x = v[k];
    if (x === undefined) continue;
    if (typeof x !== 'string' || x.length > FIELD_MAX || !NO_CTRL.test(x)) return null;
    if (x !== '') login[k] = x;
  }
  const b = cameraBackupOf({ url: v.url, ...login });
  // an address with its login split out still obeys the rules (it is the same address); checked again all the same
  if (cameraUrlError(b.url, []) !== null) return null;
  return {
    url: b.url,
    ...(b.username !== undefined ? { username: b.username } : {}),
    hasPassword: v.hasPassword === true || v.passwordNeeded === true || b.hasPassword || login.password !== undefined,
    ...(v.passwordNeeded === true ? { passwordNeeded: true as const } : {}),
  };
}

/**
 * Once per cloud (a `sync_state` flag), at start-up: rewrites every `camera_secrets` row written before the "no
 * password in the cloud" rule to its clean form (address and user name kept, the password gone), with SQLite's
 * secure delete on so the old bytes are overwritten, and removes a row that does not open (it was already unusable).
 * Idempotent: a clean row is rewritten to the same content. Never logs a record. Returns the rows looked at.
 */
export function scrubCameraSecrets(db: DatabaseSync, key: Buffer): number {
  if (db.prepare('SELECT value FROM sync_state WHERE key = ?').get(SCRUB_FLAG)?.value === '1') return 0;
  const was = Number(db.prepare('PRAGMA secure_delete').get()?.secure_delete ?? 0);
  db.exec('PRAGMA secure_delete = ON');
  let changed = 0;
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of db.prepare('SELECT surau_id, sealed FROM camera_secrets').all()) {
        const surauId = String(row.surau_id);
        let clean: CameraSecretRecord | null = null;
        try {
          const j = JSON.parse(openSecret(key, String(row.sealed))) as Record<string, unknown>;
          if (j.surauId === surauId) {
            const { surauId: _s, ...rest } = j;
            clean = cleanCameraRecord(rest);
          }
        } catch {
          clean = null;
        }
        if (clean === null) {
          db.prepare('DELETE FROM camera_secrets WHERE surau_id = ?').run(surauId);
        } else {
          db.prepare('UPDATE camera_secrets SET sealed = ? WHERE surau_id = ?').run(sealSecret(key, JSON.stringify({ surauId, ...clean })), surauId);
        }
        changed += 1;
      }
      db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(SCRUB_FLAG, '1');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    // the WAL may still hold the old pages: copy them back into the file and empty it
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* not in WAL mode, or busy: the next checkpoint writes the overwritten pages */
    }
  } finally {
    db.exec(`PRAGMA secure_delete = ${was === 1 ? 'ON' : 'OFF'}`);
  }
  return changed;
}

export function registerCameraSecretCloudRoutes(app: FastifyInstance, deps: CameraSecretCloudDeps): void {
  const { db, now } = deps;
  const key = deps.masterKey === null ? null : deriveCameraSecretKey(deps.masterKey);
  if (deps.role === 'cloud' && key !== null) {
    try {
      scrubCameraSecrets(db, key);
    } catch {
      // a fixed reason, never a record; the next start tries again
      console.error('camera backup: the start-up rewrite did not finish (reason: scrub_failed)');
    }
  }
  const clock = deps.clock === undefined ? {} : { now: deps.clock };
  // per site: a fresh backup follows every save, so a handful a minute is plenty
  const writes: RateLimiter = createRateLimiter({ windowMs: 60_000, max: 12, ...clock });
  const reads: RateLimiter = createRateLimiter({ windowMs: 60_000, max: 30, ...clock });

  const notFound = (reply: FastifyReply): FastifyReply => reply.code(404).header('Cache-Control', 'no-store').send({ errors: [MSG.notFound] });
  const gate = { preHandler: async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => (deps.role === 'cloud' ? undefined : notFound(reply)) };
  const siteOnly = (request: FastifyRequest, reply: FastifyReply): { boxId: string } | null => {
    const a = request.auth;
    if (a == null || a.kind !== 'site') {
      notFound(reply);
      return null;
    }
    return { boxId: a.boxId };
  };
  const tooMany = (reply: FastifyReply, retryAfterSec: number): FastifyReply =>
    reply.code(429).header('Retry-After', String(retryAfterSec)).header('Cache-Control', 'no-store').send({ errors: [MSG.tooMany], code: 'too_many' });
  const audit = (surauId: string, boxId: string, event: 'put' | 'delete'): void => {
    // who and what, never the record
    db.prepare('INSERT INTO change_log (surau_id, at, actor, entity, entity_id, before_json, after_json, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      surauId,
      now().toISOString(),
      `site:${boxId}`,
      'live-camera/cloud-backup',
      event,
      null,
      JSON.stringify({ event }),
      null,
    );
  };

  app.put('/api/sync/camera-secret', gate, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const surauId = reqSurau(request);
    const site = siteOnly(request, reply);
    if (site === null) return reply;
    if (key === null) return reply.code(503).send({ errors: [MSG.unavailable], code: 'unavailable' });
    const hit = writes.hit(`${surauId}:${site.boxId}`);
    if (!hit.ok) return tooMany(reply, hit.retryAfterSec);
    const record = cleanCameraRecord(request.body);
    if (record === null) return reply.code(400).send({ errors: [MSG.badRequest], code: 'invalid' });
    const sealed = sealSecret(key, JSON.stringify({ surauId, ...record }));
    db.prepare(
      'INSERT INTO camera_secrets (surau_id, sealed, box_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(surau_id) DO UPDATE SET sealed = excluded.sealed, box_id = excluded.box_id, updated_at = excluded.updated_at',
    ).run(surauId, sealed, site.boxId, now().toISOString());
    audit(surauId, site.boxId, 'put');
    return reply.send({ stored: true });
  });

  app.get('/api/sync/camera-secret', gate, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const surauId = reqSurau(request);
    const site = siteOnly(request, reply);
    if (site === null) return reply;
    if (key === null) return reply.code(503).send({ errors: [MSG.unavailable], code: 'unavailable' });
    const hit = reads.hit(`${surauId}:${site.boxId}`);
    if (!hit.ok) return tooMany(reply, hit.retryAfterSec);
    const row = db.prepare('SELECT sealed FROM camera_secrets WHERE surau_id = ?').get(surauId);
    if (row === undefined) return reply.code(404).send({ errors: [MSG.none], code: 'none' });
    try {
      const j = JSON.parse(openSecret(key, String(row.sealed))) as Record<string, unknown>;
      // the row must belong to this surau (a row copied under another surau id does not open)
      if (j.surauId !== surauId) throw new Error('surau');
      const { surauId: _s, ...rest } = j;
      const record = cleanCameraRecord(rest);
      if (record === null) throw new Error('record');
      return reply.send(record);
    } catch {
      // a row that does not open is as good as none (no text from the failure)
      return reply.code(404).send({ errors: [MSG.none], code: 'none' });
    }
  });

  app.delete('/api/sync/camera-secret', gate, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const surauId = reqSurau(request);
    const site = siteOnly(request, reply);
    if (site === null) return reply;
    const hit = writes.hit(`${surauId}:${site.boxId}`);
    if (!hit.ok) return tooMany(reply, hit.retryAfterSec);
    const r = db.prepare('DELETE FROM camera_secrets WHERE surau_id = ?').run(surauId);
    if (Number(r.changes) > 0) audit(surauId, site.boxId, 'delete');
    return reply.send({ removed: Number(r.changes) > 0 });
  });
}
