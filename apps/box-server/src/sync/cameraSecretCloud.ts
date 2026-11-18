import { hkdfSync } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CAMERA_URL_MAX, cameraUrlError } from '@surau/core';
import { openSecret, sealSecret } from '../auth/crypto.ts';
import { createRateLimiter } from '../auth/ratelimit.ts';
import type { RateLimiter } from '../auth/ratelimit.ts';
import { reqSurau } from '../reqSurau.ts';

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

/** One camera backup: the same fields as the box's sealed record. */
export interface CameraSecretRecord {
  url: string;
  username?: string;
  password?: string;
}

const FIELD_MAX = 128;
const BODY_FIELDS = new Set(['url', 'username', 'password']);
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

/** A clean record from a request body, or null. The address obeys the shared address rules (private IPv4, rtsp). */
export function cleanCameraRecord(v: unknown): CameraSecretRecord | null {
  if (!isRecord(v)) return null;
  for (const k of Object.keys(v)) if (!BODY_FIELDS.has(k)) return null;
  if (typeof v.url !== 'string' || v.url.length > CAMERA_URL_MAX || cameraUrlError(v.url, []) !== null) return null;
  const out: CameraSecretRecord = { url: v.url };
  for (const k of ['username', 'password'] as const) {
    const x = v[k];
    if (x === undefined) continue;
    if (typeof x !== 'string' || x.length > FIELD_MAX || !NO_CTRL.test(x)) return null;
    if (x !== '') out[k] = x;
  }
  return out;
}

export function registerCameraSecretCloudRoutes(app: FastifyInstance, deps: CameraSecretCloudDeps): void {
  const { db, now } = deps;
  const key = deps.masterKey === null ? null : deriveCameraSecretKey(deps.masterKey);
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
      const record = cleanCameraRecord({ url: j.url, ...(j.username !== undefined ? { username: j.username } : {}), ...(j.password !== undefined ? { password: j.password } : {}) });
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
