import { createPublicKey, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { openSecret, randomToken, sealSecret, sha256hex } from '../auth/crypto.ts';
import type { JsonWebKey } from '../auth/crypto.ts';
import { isAssetId, putAsset, AssetError } from '../assets/store.ts';
import { logChange, tx } from '../auth/users.ts';
import { DEFAULT_SURAU_ID } from './verify.ts';
import { enqueueSiteDelete, enqueueSitePut } from './workerOutbox.ts';
import type { WorkerAdminConfig, WorkerOutboxSender } from './workerOutbox.ts';
import { deleteRegistration } from './workerRegs.ts';

/**
 * The cloud's side of linking a box (SECURITY code).
 *
 *  - An operator on the cloud prints a one-time code for a box id (`cloud-code`). Only the sha256 of the
 *    code is stored, with the box id, the site name and a 15 minute expiry.
 *  - The box redeems it once with `POST /api/sync/link`. The code is spent on the first attempt that
 *    presents it, right or wrong box, so a leaked code cannot be tried twice. Every refusal is the same
 *    401, so the answer does not tell which part was wrong.
 *  - The cloud issues a site key and a wake secret. It keeps only the sha256 of the site key (the key is
 *    shown to the box once and never again) and the wake secret sealed under its own key, for the Worker.
 *  - Re-linking the same box id needs a new code and replaces the key and the secret: the old key dies.
 */

export const LINK_CODE_TTL_MS = 15 * 60 * 1000;
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 12;
const CODE_PREFIX = 'link_code:';
const WAKE_PREFIX = 'site_wake:';

const BOX_ID_RE = /^[0-9a-f]{16}$/;
const JWK_FIELDS = new Set(['kty', 'crv', 'x', 'y']);

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface SitesDeps {
  db: DatabaseSync;
  now: () => Date;
  surauId?: string;
  /** Seals the stored wake secret; null (a bare in-memory database) stores none. */
  sealKey?: Buffer | null;
  /** Delivers the Worker outbox; null when no Worker is configured (always-on cloud, tests). */
  outbox?: WorkerOutboxSender | null;
}

export interface LinkCode {
  /** Shown once to the operator; only its hash is kept. */
  code: string;
  expiresAt: string;
}

const normaliseCode = (raw: string): string => raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

function newCode(): string {
  let out = '';
  // 256 is a multiple of 32, so a byte modulo 32 is unbiased.
  for (const b of randomBytes(CODE_LENGTH)) out += CODE_ALPHABET[b % 32]!;
  return out;
}

/** Shown as XXXX-XXXX-XXXX. */
export const formatCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;

function setState(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** A new one-time link code for a box. Any earlier unspent code for the same box is withdrawn, and expired codes are swept. */
export function issueLinkCode(deps: SitesDeps, o: { boxId: string; name: string }): LinkCode {
  if (!BOX_ID_RE.test(o.boxId)) throw new Error('bad box id');
  const name = o.name.trim().slice(0, 120);
  if (name === '') throw new Error('name required');
  const now = deps.now();
  const code = newCode();
  const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_MS).toISOString();
  tx(deps.db, () => {
    const rows = deps.db.prepare("SELECT key, value FROM sync_state WHERE key LIKE 'link_code:%'").all();
    for (const r of rows) {
      let stale = true;
      try {
        const v = JSON.parse(String(r.value)) as { boxId?: string; expiresAt?: string };
        stale = v.boxId === o.boxId || String(v.expiresAt) <= now.toISOString();
      } catch {
        /* unreadable entry: sweep it */
      }
      if (stale) deps.db.prepare('DELETE FROM sync_state WHERE key = ?').run(String(r.key));
    }
    setState(deps.db, CODE_PREFIX + sha256hex(code), JSON.stringify({ boxId: o.boxId, name, expiresAt }));
  });
  return { code, expiresAt };
}

export interface LinkResult {
  siteToken: string;
  wakeSecret: string;
  surauId: string;
  name: string;
  cloudTime: string;
}

export class LinkError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'LinkError';
    this.status = status;
  }
}

const BAD_CODE = 'Kod tidak sah atau sudah tamat';

/** A clean EC P-256 public key: those four members only, a real point on the curve. */
export function cleanPublicJwk(v: unknown): JsonWebKey | null {
  if (!isPlain(v) || v.kty !== 'EC' || v.crv !== 'P-256' || typeof v.x !== 'string' || typeof v.y !== 'string') return null;
  for (const k of Object.keys(v)) if (!JWK_FIELDS.has(k)) return null;
  try {
    createPublicKey({ key: v as JsonWebKey, format: 'jwk' });
  } catch {
    return null;
  }
  return { kty: 'EC', crv: 'P-256', x: v.x, y: v.y } as JsonWebKey;
}

/** Spend a link code. Throws `LinkError` (always 401 for any code problem, 400 for a malformed body). */
export function redeemLink(deps: SitesDeps, body: unknown): LinkResult {
  if (!isPlain(body)) throw new LinkError(400, 'Permintaan tidak sah');
  const { boxId, code, publicJwk } = body;
  if (typeof boxId !== 'string' || !BOX_ID_RE.test(boxId) || typeof code !== 'string' || code.length > 40) {
    throw new LinkError(400, 'Permintaan tidak sah');
  }
  const jwk = cleanPublicJwk(publicJwk);
  if (jwk === null) throw new LinkError(400, 'Permintaan tidak sah');
  const normalised = normaliseCode(code);
  if (normalised.length !== CODE_LENGTH) throw new LinkError(401, BAD_CODE);

  const now = deps.now();
  const surauId = deps.surauId ?? DEFAULT_SURAU_ID;
  const siteToken = randomToken(32);
  const wakeSecret = randomToken(32);
  let name = '';

  const bad = tx(deps.db, (): boolean => {
    const key = CODE_PREFIX + sha256hex(normalised);
    const row = deps.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
    if (row === undefined) return true;
    // Spent on the first presentation, whatever follows (the delete commits even when the code is refused).
    deps.db.prepare('DELETE FROM sync_state WHERE key = ?').run(key);
    let entry: { boxId?: unknown; name?: unknown; expiresAt?: unknown };
    try {
      entry = JSON.parse(String(row.value)) as typeof entry;
    } catch {
      return true;
    }
    if (entry.boxId !== boxId || typeof entry.name !== 'string' || typeof entry.expiresAt !== 'string') return true;
    if (entry.expiresAt <= now.toISOString()) return true;
    name = entry.name;
    writeSite(deps, { boxId, name, jwk, siteToken, wakeSecret, now, surauId, event: 'link' });
    return false;
  });
  if (bad) throw new LinkError(401, BAD_CODE);

  return { siteToken, wakeSecret, surauId, name, cloudTime: now.toISOString() };
}

/**
 * Issue a site key: the one place the cloud writes a linked site (link by code and the automatic claim). Inside the
 * caller's transaction. A re-link replaces the key and token, which die with this statement.
 */
function writeSite(
  deps: SitesDeps,
  o: { boxId: string; name: string; jwk: JsonWebKey; siteToken: string; wakeSecret: string; now: Date; surauId: string; event: 'link' | 'claim' },
): void {
  const nowIso = o.now.toISOString();
  const existing = deps.db.prepare('SELECT box_id FROM sites WHERE box_id = ?').get(o.boxId);
  if (existing === undefined) {
    deps.db
      .prepare('INSERT INTO sites (surau_id, box_id, name, public_jwk, token_hash, linked_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(o.surauId, o.boxId, o.name, JSON.stringify(o.jwk), sha256hex(o.siteToken), nowIso);
  } else {
    deps.db
      .prepare('UPDATE sites SET name = ?, public_jwk = ?, token_hash = ?, linked_at = ?, revoked_at = NULL, last_seen_at = NULL WHERE box_id = ?')
      .run(o.name, JSON.stringify(o.jwk), sha256hex(o.siteToken), nowIso, o.boxId);
  }
  if (deps.sealKey) setState(deps.db, WAKE_PREFIX + o.boxId, sealSecret(deps.sealKey, o.wakeSecret));
  // the wake secret reaches the Worker through the outbox: committed with the link, sealed, retried until accepted
  enqueueSitePut(deps.db, deps.sealKey, o.boxId, o.wakeSecret, o.now);
  logChange(deps.db, 'system', 'site', o.boxId, undefined, { event: o.event, boxId: o.boxId, name: o.name });
}

// ---- automatic link: MAXCOM approves a self-registered box, the box claims (SECURITY code) ----------------------
//
// The box registered `sha256(R)` with the Worker (`register.ts`). `approveSite` stores an approval bound to that hash;
// `redeemClaim` issues the site key only to a caller that presents R itself for an approved, unclaimed box id whose
// site is not live. Every refusal is the same 401. The approval is spent by the first good claim; re-linking a live
// box needs the operator again (revoke, then a new approval or a link code). One exception, for a claim answer lost on
// the way: within 24 hours of the first claim, while that site is live, the same R gets a fresh key (the old one dies).
// Only the hash is ever stored here.

const CLAIM_HASH_RE = /^[0-9a-f]{64}$/;
const BAD_CLAIM = 'Tuntutan tidak sah';
/** A spent approval can be claimed again (a lost answer) for this long after its first claim. */
const RECLAIM_WINDOW_MS = 24 * 3_600_000;
/** The claim answer waits at most this long for the Worker outbox (which keeps retrying on its own). */
export const CLAIM_FLUSH_WAIT_MS = 5_000;

export class ApprovalError extends Error {
  readonly code: 'bad_args' | 'linked';
  constructor(code: 'bad_args' | 'linked', message: string) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
  }
}

const liveSite = (db: DatabaseSync, boxId: string): boolean =>
  db.prepare('SELECT 1 AS x FROM sites WHERE box_id = ? AND linked_at IS NOT NULL AND revoked_at IS NULL').get(boxId) !== undefined;

/** Approve a box for the automatic link, bound to the claimHash it registered. Replaces an earlier approval of that id. */
export function approveSite(deps: { db: DatabaseSync; now: () => Date }, o: { boxId: string; name: string; claimHash: string }, actor = 'local'): void {
  const name = o.name.trim().slice(0, 120);
  if (!BOX_ID_RE.test(o.boxId) || !CLAIM_HASH_RE.test(o.claimHash) || name === '') throw new ApprovalError('bad_args', 'ID kotak, nama atau cincangan tidak sah');
  tx(deps.db, () => {
    if (liveSite(deps.db, o.boxId)) throw new ApprovalError('linked', 'Kotak ini sudah dipautkan; batalkan tapaknya dahulu');
    deps.db
      .prepare(
        `INSERT INTO site_approvals (box_id, name, claim_hash, approved_at, claimed_at) VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(box_id) DO UPDATE SET name = excluded.name, claim_hash = excluded.claim_hash, approved_at = excluded.approved_at, claimed_at = NULL`,
      )
      .run(o.boxId, name, o.claimHash, deps.now().toISOString());
    logChange(deps.db, actor, 'site', o.boxId, undefined, { event: 'approve', boxId: o.boxId, name });
  });
}

/** Withdraw an approval (claimed or not). True when there was one. */
export function revokeApproval(db: DatabaseSync, boxId: string): boolean {
  return Number(db.prepare('DELETE FROM site_approvals WHERE box_id = ?').run(boxId).changes) > 0;
}

/** Spend an approval. Throws `LinkError(401)` for every refusal, malformed bodies included. */
export function redeemClaim(deps: SitesDeps, body: unknown): LinkResult & { boxId: string } {
  const refuse = (): never => {
    throw new LinkError(401, BAD_CLAIM);
  };
  if (!isPlain(body)) return refuse();
  const { boxId, claim, publicJwk } = body;
  if (typeof boxId !== 'string' || !BOX_ID_RE.test(boxId) || typeof claim !== 'string' || claim.length !== 64) return refuse();
  const jwk = cleanPublicJwk(publicJwk);
  if (jwk === null) return refuse();
  const presented = Buffer.from(sha256hex(claim), 'hex');

  const now = deps.now();
  const surauId = deps.surauId ?? DEFAULT_SURAU_ID;
  const siteToken = randomToken(32);
  const wakeSecret = randomToken(32);
  let name = '';
  const ok = tx(deps.db, (): boolean => {
    const row = deps.db.prepare('SELECT name, claim_hash, claimed_at FROM site_approvals WHERE box_id = ?').get(boxId);
    // compare first, whatever the row says, so the answer time does not tell an approved id from an unknown one
    const stored = row !== undefined && typeof row.claim_hash === 'string' && CLAIM_HASH_RE.test(row.claim_hash) ? Buffer.from(row.claim_hash, 'hex') : Buffer.alloc(32);
    const match = timingSafeEqual(presented, stored);
    if (row === undefined || !match) return false;
    if (row.claimed_at === null) {
      // the first claim of an approval: the site must not be live (re-linking a live site needs the operator)
      if (liveSite(deps.db, boxId)) return false;
      deps.db.prepare('UPDATE site_approvals SET claimed_at = ? WHERE box_id = ?').run(now.toISOString(), boxId);
    } else {
      // A lost answer: the box never stored its key, so it still holds R and claims again. Within 24 hours of the
      // first claim, and only while the site that claim made is live, it gets a fresh key and wake secret (the
      // previous ones die with writeSite). claimed_at stays at the first claim, so the window never grows.
      const at = typeof row.claimed_at === 'string' ? Date.parse(row.claimed_at) : NaN;
      if (!Number.isFinite(at) || now.getTime() - at >= RECLAIM_WINDOW_MS || now.getTime() < at || !liveSite(deps.db, boxId)) return false;
    }
    name = String(row.name);
    writeSite(deps, { boxId, name, jwk, siteToken, wakeSecret, now, surauId, event: 'claim' });
    return true;
  });
  if (!ok) return refuse();
  return { boxId, siteToken, wakeSecret, surauId, name, cloudTime: now.toISOString() };
}

/**
 * The `POST /api/sync/claim` handler body (rate limiting and the role gate are in the route). After a good claim the
 * box's pending registration is removed from the Worker (best effort: it also expires on its own).
 */
export function createClaimHandler(
  deps: SitesDeps & { workerAdmin?: WorkerAdminConfig | null; /** Test hook; default CLAIM_FLUSH_WAIT_MS. */ flushWaitMs?: number },
): (body: unknown) => Promise<{ status: number; body: unknown }> {
  const waitMs = Math.min(Math.max(deps.flushWaitMs ?? CLAIM_FLUSH_WAIT_MS, 0), CLAIM_FLUSH_WAIT_MS);
  return async (body) => {
    let out: LinkResult & { boxId: string };
    try {
      out = redeemClaim(deps, body);
    } catch (error) {
      if (error instanceof LinkError) return { status: 401, body: { errors: [error.message], code: 'bad_claim' } };
      throw error;
    }
    // one prompt try at the Worker, but the box's answer never waits on it for long: a lost answer strands the box
    let wakeRegistered = false;
    if (deps.outbox) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
      });
      const flush = deps.outbox.flushKey('site/' + out.boxId).catch(() => false);
      try {
        wakeRegistered = await Promise.race([flush, late]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    if (deps.workerAdmin) void deleteRegistration(deps.workerAdmin, out.boxId).catch(() => undefined);
    const { boxId: _boxId, ...answer } = out;
    return { status: 200, body: { ...answer, wakeRegistered } };
  };
}

/** The wake secret of a site, for re-registering it with the Worker. Null when unknown. */
export function wakeSecretOf(deps: SitesDeps, boxId: string): string | null {
  if (!deps.sealKey) return null;
  const row = deps.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(WAKE_PREFIX + boxId);
  if (row === undefined) return null;
  try {
    return openSecret(deps.sealKey, String(row.value));
  } catch {
    return null;
  }
}

/**
 * Revoke a site: its key stops working at once, its wake secret is forgotten, and any approval for its automatic
 * link (spent or pending) is withdrawn. True when a live site was revoked or a pending approval withdrawn.
 */
export function revokeSite(deps: SitesDeps, boxId: string, actor = 'system'): boolean {
  const nowIso = deps.now().toISOString();
  return tx(deps.db, () => {
    const pending = deps.db.prepare('SELECT 1 AS x FROM site_approvals WHERE box_id = ? AND claimed_at IS NULL').get(boxId) !== undefined;
    if (revokeApproval(deps.db, boxId) && pending) logChange(deps.db, actor, 'site', boxId, undefined, { event: 'approval_revoke', boxId });
    const r = deps.db
      .prepare('UPDATE sites SET revoked_at = ?, token_hash = NULL WHERE box_id = ? AND revoked_at IS NULL')
      .run(nowIso, boxId);
    if (Number(r.changes) === 0) return pending;
    deps.db.prepare('DELETE FROM sync_state WHERE key = ?').run(WAKE_PREFIX + boxId);
    enqueueSiteDelete(deps.db, boxId, deps.now());
    logChange(deps.db, actor, 'site', boxId, undefined, { event: 'revoke', boxId });
    return true;
  });
}

export interface SiteSummary {
  boxId: string;
  name: string;
  lastSeenAt: string | null;
}

export function listSites(db: DatabaseSync): SiteSummary[] {
  return db
    .prepare('SELECT box_id, name, last_seen_at FROM sites WHERE linked_at IS NOT NULL AND revoked_at IS NULL ORDER BY box_id')
    .all()
    .map((r) => ({ boxId: String(r.box_id), name: String(r.name), lastSeenAt: typeof r.last_seen_at === 'string' ? r.last_seen_at : null }));
}

/** The `POST /api/sync/link` handler body (rate limiting and the role gate are in the route). */
export function createLinkHandler(deps: SitesDeps): (body: unknown) => Promise<{ status: number; body: unknown }> {
  return async (body) => {
    try {
      const out = redeemLink(deps, body);
      let wakeRegistered = false;
      if (deps.outbox) {
        try {
          // one prompt try so the operator sees the answer; if it fails the outbox keeps retrying
          wakeRegistered = await deps.outbox.flushKey('site/' + String((body as Record<string, unknown>).boxId));
        } catch {
          wakeRegistered = false;
        }
      }
      return { status: 200, body: { ...out, wakeRegistered } };
    } catch (error) {
      if (error instanceof LinkError) return { status: error.status, body: { errors: [error.message], code: error.status === 401 ? 'bad_code' : 'bad_body' } };
      throw error;
    }
  };
}

const ASSET_UPLOAD_LIMIT = 20 * 1024 * 1024;

/**
 * `PUT /api/sync/assets/:id`: a linked box hands the cloud the bytes of an asset a pushed item references.
 * The id is the sha256 of the bytes, so the body is checked against it and a repeat is a plain 200. A
 * device session gets 404 here (a device sends `asset.put` ops, which are signed).
 */
export function registerSiteAssetRoute(app: FastifyInstance, deps: { db: DatabaseSync; dataDir: string }): void {
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      ['image/jpeg', 'image/png', 'image/webp', 'audio/mpeg'],
      { parseAs: 'buffer', bodyLimit: ASSET_UPLOAD_LIMIT },
      (_request, body, done) => done(null, body),
    );
    scope.put('/api/sync/assets/:id', { bodyLimit: ASSET_UPLOAD_LIMIT }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      // only a linked box sends assets this way; to anyone else the route does not exist
      if (request.auth?.kind !== 'site') return reply.code(404).send({ errors: ['Tidak dijumpai'], code: 'not_found' });
      const { id } = request.params as { id: string };
      const body: unknown = request.body;
      if (!isAssetId(id) || !Buffer.isBuffer(body)) return reply.code(400).send({ errors: ['Permintaan tidak sah'], code: 'bad_body' });
      try {
        const meta = putAsset(deps.db, deps.dataDir, body, request.headers['content-type'] ?? '', `site:${request.auth.boxId}`);
        if (meta.id !== id) return reply.code(400).send({ errors: ['Fail tidak sepadan dengan pengecam'], code: 'id_mismatch' });
        return reply.code(meta.created ? 201 : 200).send({ id: meta.id });
      } catch (error) {
        if (error instanceof AssetError) return reply.code(error.status).send({ errors: error.errors, code: 'bad_asset' });
        throw error;
      }
    });
  });
}

/**
 * The cloud origin an enrolment payload carries (`cloud`), or undefined: only a linked box names one, and only
 * the address it was linked to (`sync_state.cloud_url`, written by the link step) or the operator's override.
 * The synced `cloudSync.cloudUrl` setting is display info only and never decides this.
 */
export function enrolCloudOrigin(db: DatabaseSync, configured: string | null = null): string | undefined {
  const get = (k: string): string => {
    const r = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(k);
    return typeof r?.value === 'string' ? r.value : '';
  };
  if (get('linked') !== '1') return undefined;
  for (const u of [configured ?? '', get('cloud_url')]) {
    if (u === '') continue;
    try {
      const o = new URL(u);
      if (o.protocol === 'https:') return o.origin;
    } catch {
      /* try the next */
    }
  }
  return undefined;
}
