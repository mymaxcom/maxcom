import { createPublicKey, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { openSecret, randomToken, sealSecret, sha256hex } from '../auth/crypto.ts';
import type { JsonWebKey } from '../auth/crypto.ts';
import { SURAU_ID_RE } from '@surau/core';
import { isAssetId, AssetError } from '../assets/store.ts';
import { authLog } from '../auth/sessions.ts';
import { logChange, tx } from '../auth/users.ts';
import { cleanText, insertSurau } from '../surau/registry.ts';
import { putSurauAsset, StorageFullError } from '../surau/storage.ts';
import { LOCAL_SURAU_ID } from '../tenant.ts';
import { PACK_MIME } from '../themes/packFormat.ts';
import { enqueueSiteDelete, enqueueSitePut } from './workerOutbox.ts';
import type { WorkerAdminConfig, WorkerOutboxSender } from './workerOutbox.ts';
import { deleteRegistration, getRegistration } from './workerRegs.ts';

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
export function issueLinkCode(
  deps: SitesDeps,
  o: { boxId: string; name: string; target?: ApprovalTarget },
  actor = 'local',
): LinkCode & { surauId: string; created: boolean } {
  if (!BOX_ID_RE.test(o.boxId)) throw new ApprovalError('bad_args', 'ID kotak tidak sah');
  const name = cleanText(o.name, 120);
  if (name === '') throw new ApprovalError('bad_args', 'Nama diperlukan');
  // a code names its surau; there is no default (Plan 14 Task 8)
  if (o.target === undefined || o.target === null) throw new ApprovalError('surau_required', 'Sasaran diperlukan: --new-surau atau --surau <id>');
  const target = o.target;
  const now = deps.now();
  const code = newCode();
  const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_MS).toISOString();
  try {
    return tx(deps.db, () => {
      // a live box may be re-linked by a code (its key is replaced), but only into its own surau
      const { surauId, created } = resolveTarget(deps.db, o.boxId, name, target, actor, now);
      sweepCodes(deps.db, o.boxId, now);
      setState(deps.db, CODE_PREFIX + sha256hex(code), JSON.stringify({ boxId: o.boxId, name, expiresAt, surauId }));
      logChange(deps.db, actor, 'site', o.boxId, undefined, { event: 'link_code', boxId: o.boxId, name, surauId, created }, undefined, surauId);
      return { code, expiresAt, surauId, created };
    });
  } catch (error) {
    if (error instanceof ApprovalError && error.code === 'foreign_surau') authLog(deps.db, now, 'site_link_code', false, { detail: 'foreign_surau' });
    throw error;
  }
}

/** Withdraw earlier unspent codes of the box and sweep expired ones. Inside the caller's transaction. */
function sweepCodes(db: DatabaseSync, boxId: string, now: Date): void {
  {
    const rows = db.prepare("SELECT key, value FROM sync_state WHERE key LIKE 'link_code:%'").all();
    for (const r of rows) {
      let stale = true;
      try {
        const v = JSON.parse(String(r.value)) as { boxId?: string; expiresAt?: string };
        stale = v.boxId === boxId || String(v.expiresAt) <= now.toISOString();
      } catch {
        /* unreadable entry: sweep it */
      }
      if (stale) db.prepare('DELETE FROM sync_state WHERE key = ?').run(String(r.key));
    }
  }
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
  let surauId = '';
  const siteToken = randomToken(32);
  const wakeSecret = randomToken(32);
  let name = '';

  const bad = tx(deps.db, (): boolean => {
    const key = CODE_PREFIX + sha256hex(normalised);
    const row = deps.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
    if (row === undefined) return true;
    // Spent on the first presentation, whatever follows (the delete commits even when the code is refused).
    deps.db.prepare('DELETE FROM sync_state WHERE key = ?').run(key);
    let entry: { boxId?: unknown; name?: unknown; expiresAt?: unknown; surauId?: unknown };
    try {
      entry = JSON.parse(String(row.value)) as typeof entry;
    } catch {
      return true;
    }
    if (entry.boxId !== boxId || typeof entry.name !== 'string' || typeof entry.expiresAt !== 'string') return true;
    if (entry.expiresAt <= now.toISOString()) return true;
    // the code's own surau (a code made before Task 8 names none and is refused), checked again now
    if (!surauExists(deps.db, entry.surauId)) return true;
    const site = deps.db.prepare('SELECT surau_id FROM sites WHERE box_id = ?').get(boxId);
    if (site !== undefined && site.surau_id !== entry.surauId) return true;
    if (surauHasOtherBox(deps.db, entry.surauId, boxId)) return true;
    surauId = entry.surauId;
    name = entry.name;
    writeSite(deps, { boxId, name, jwk, siteToken, wakeSecret, now, surauId, event: 'link' });
    deps.db.prepare('UPDATE suraus SET linked_at = ? WHERE id = ? AND linked_at IS NULL').run(now.toISOString(), surauId);
    return false;
  });
  if (bad) throw new LinkError(401, BAD_CODE);

  return { siteToken, wakeSecret, surauId, name, cloudTime: now.toISOString() };
}

/**
 * Issue a site key: the one place the cloud writes a linked site (link by code and the claim). Inside the caller's
 * transaction. A re-link replaces the key and token, which die with this statement; the site keeps its surau.
 */
function writeSite(
  deps: SitesDeps,
  o: { boxId: string; name: string; jwk: JsonWebKey; siteToken: string; wakeSecret: string; now: Date; surauId: string; event: 'link' | 'claim'; role?: string },
): void {
  const nowIso = o.now.toISOString();
  const role = o.role ?? 'primary';
  const existing = deps.db.prepare('SELECT box_id FROM sites WHERE box_id = ?').get(o.boxId);
  if (existing === undefined) {
    deps.db
      .prepare('INSERT INTO sites (surau_id, box_id, name, public_jwk, token_hash, linked_at, role) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(o.surauId, o.boxId, o.name, JSON.stringify(o.jwk), sha256hex(o.siteToken), nowIso, role);
  } else {
    deps.db
      .prepare('UPDATE sites SET name = ?, public_jwk = ?, token_hash = ?, linked_at = ?, revoked_at = NULL, last_seen_at = NULL, role = ? WHERE box_id = ?')
      .run(o.name, JSON.stringify(o.jwk), sha256hex(o.siteToken), nowIso, role, o.boxId);
  }
  if (deps.sealKey) setState(deps.db, WAKE_PREFIX + o.boxId, sealSecret(deps.sealKey, o.wakeSecret));
  // the wake secret reaches the Worker through the outbox: committed with the link, sealed, retried until accepted
  enqueueSitePut(deps.db, deps.sealKey, o.boxId, o.wakeSecret, o.now);
  logChange(deps.db, 'system', 'site', o.boxId, undefined, { event: o.event, boxId: o.boxId, name: o.name, surauId: o.surauId, role }, undefined, o.surauId);
}

// ---- automatic link (Plan 14 decisions 23, 24; SECURITY code) ----------------------------------------------------
//
// The box registered `sha256(R)` with the Worker (`register.ts`). At its claim the cloud issues a site key only to a
// caller that presents R itself:
//  - an approval made by the CLI (`approveSite`, bound to the registered hash and to a target surau) is spent by the
//    first good claim; a lost answer can be claimed again within 24 hours while that site is live;
//  - with no approval, the hash the Worker holds decides. A box id the cloud has never seen gets a NEW surau, named
//    from its registration, at most `autoSurauDailyCap()` a UTC day cloud-wide (beyond it: `pending`, nothing
//    written, the registration kept). A known box whose site was revoked re-links into its own surau (after
//    `cloud-unrevoke`), but only when it presents the key stored for its site, so a fresh registration squatting a
//    known id (or a reset box with a new key) gets nothing. A live site is never taken over by a claim.
// Every other refusal is the same 401. Only hashes are ever stored here.

const CLAIM_HASH_RE = /^[0-9a-f]{64}$/;
const BAD_CLAIM = 'Tuntutan tidak sah';
/** A spent approval can be claimed again (a lost answer) for this long after its first claim. */
const RECLAIM_WINDOW_MS = 24 * 3_600_000;
/** The claim answer waits at most this long for the Worker outbox (which keeps retrying on its own). */
export const CLAIM_FLUSH_WAIT_MS = 5_000;
/** Set by `cloud-unrevoke`: the revoked box may re-link once into its own surau. Cleared by a revoke. */
const UNREVOKE_PREFIX = 'site_unrevoked:';
/** `suraus.created_by` of an automatic creation (the daily cap counts these). */
export const AUTO_SURAU_ACTOR = 'auto';
export const DEFAULT_AUTO_SURAU_DAILY_CAP = 100;

/** The automatic new-surau cap per UTC day: env MAXCOM_AUTO_SURAU_DAILY_CAP (integer >= 0; 0 = none), default 100. */
export function autoSurauDailyCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.MAXCOM_AUTO_SURAU_DAILY_CAP ?? '').trim();
  return /^\d{1,6}$/.test(raw) ? Number(raw) : DEFAULT_AUTO_SURAU_DAILY_CAP;
}

export type ApprovalCode = 'bad_args' | 'linked' | 'surau_required' | 'surau_not_found' | 'surau_has_box' | 'foreign_surau' | 'not_found' | 'not_revoked';

export class ApprovalError extends Error {
  readonly code: ApprovalCode;
  constructor(code: ApprovalCode, message: string) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
  }
}

/** Where an approval puts the box: a new surau made now, or an existing one (that must have no live box). */
export type ApprovalTarget = { newSurau: { name?: string; kind?: string; location?: string; zone?: string } } | { surauId: string };

const liveSite = (db: DatabaseSync, boxId: string): boolean =>
  db.prepare('SELECT 1 AS x FROM sites WHERE box_id = ? AND linked_at IS NOT NULL AND revoked_at IS NULL').get(boxId) !== undefined;

/** Another box is live in the surau, or holds an unclaimed approval into it (one live box per surau for now). */
const surauHasOtherBox = (db: DatabaseSync, surauId: string, boxId: string): boolean =>
  db.prepare('SELECT 1 AS x FROM sites WHERE surau_id = ? AND box_id <> ? AND linked_at IS NOT NULL AND revoked_at IS NULL').get(surauId, boxId) !== undefined ||
  db.prepare('SELECT 1 AS x FROM site_approvals WHERE surau_id = ? AND box_id <> ? AND claimed_at IS NULL').get(surauId, boxId) !== undefined;

const surauExists = (db: DatabaseSync, surauId: unknown): surauId is string =>
  typeof surauId === 'string' && SURAU_ID_RE.test(surauId) && db.prepare('SELECT 1 AS x FROM suraus WHERE id = ?').get(surauId) !== undefined;

/**
 * The surau an approval or a link code puts a box in. Inside the caller's transaction. A box the cloud knows stays in
 * its own surau (`foreign_surau`); an existing target must exist and have no other live box (`surau_has_box`); a new
 * one is created now (`Menunggu MAXCOM` until the box links).
 */
function resolveTarget(db: DatabaseSync, boxId: string, name: string, target: ApprovalTarget, actor: string, now: Date): { surauId: string; created: boolean } {
  const site = db.prepare('SELECT surau_id FROM sites WHERE box_id = ?').get(boxId);
  if ('surauId' in target) {
    if (!surauExists(db, target.surauId)) throw new ApprovalError('surau_not_found', 'Surau tidak dijumpai');
    if (site !== undefined && site.surau_id !== target.surauId) throw new ApprovalError('foreign_surau', 'Kotak ini milik surau lain; ia tidak boleh dipindahkan');
    if (surauHasOtherBox(db, target.surauId, boxId)) throw new ApprovalError('surau_has_box', 'Surau ini sudah ada kotak yang aktif');
    return { surauId: target.surauId, created: false };
  }
  if (site !== undefined) throw new ApprovalError('foreign_surau', 'Kotak ini sudah milik surau lain; gunakan --surau dengan surau asalnya');
  // approving the same box into a new surau again reuses the surau of its earlier, still unclaimed approval: never an orphan
  const waiting = db.prepare('SELECT surau_id FROM site_approvals WHERE box_id = ? AND claimed_at IS NULL').get(boxId);
  if (waiting !== undefined && surauExists(db, waiting.surau_id)) return { surauId: waiting.surau_id, created: false };
  return { surauId: insertSurau(db, { ...target.newSurau, name: target.newSurau.name ?? name }, actor, now).id, created: true };
}

/**
 * Approve a box (CLI), bound to the claimHash it registered and to a target surau; there is no default target. A box
 * the cloud knows stays in its own surau (`foreign_surau`, logged); a surau with another live box is refused
 * (`surau_has_box`); a live site needs a revoke first (`linked`). Replaces an earlier approval of that id. Not limited
 * by the daily cap.
 */
export function approveSite(
  deps: { db: DatabaseSync; now: () => Date },
  o: { boxId: string; name: string; claimHash: string; target?: ApprovalTarget },
  actor = 'local',
): { surauId: string; created: boolean } {
  const name = cleanText(o.name, 120);
  if (!BOX_ID_RE.test(o.boxId) || !CLAIM_HASH_RE.test(o.claimHash) || name === '') throw new ApprovalError('bad_args', 'ID kotak, nama atau cincangan tidak sah');
  const target = o.target;
  if (target === undefined || target === null) throw new ApprovalError('surau_required', 'Sasaran diperlukan: --new-surau atau --surau <id>');
  const now = deps.now();
  try {
    return tx(deps.db, () => {
      if (liveSite(deps.db, o.boxId)) throw new ApprovalError('linked', 'Kotak ini sudah dipautkan; batalkan tapaknya dahulu');
      const { surauId, created } = resolveTarget(deps.db, o.boxId, name, target, actor, now);
      deps.db
        .prepare(
          `INSERT INTO site_approvals (box_id, name, claim_hash, approved_at, claimed_at, surau_id, mode) VALUES (?, ?, ?, ?, NULL, ?, 'primary')
           ON CONFLICT(box_id) DO UPDATE SET name = excluded.name, claim_hash = excluded.claim_hash, approved_at = excluded.approved_at,
             claimed_at = NULL, surau_id = excluded.surau_id, mode = excluded.mode`,
        )
        .run(o.boxId, name, o.claimHash, now.toISOString(), surauId);
      logChange(deps.db, actor, 'site', o.boxId, undefined, { event: 'approve', boxId: o.boxId, name, surauId, created }, undefined, surauId);
      return { surauId, created };
    });
  } catch (error) {
    // the refusal rolled back; its trace is written on its own
    if (error instanceof ApprovalError && error.code === 'foreign_surau') authLog(deps.db, now, 'site_approve', false, { detail: 'foreign_surau' });
    throw error;
  }
}

/** Withdraw an approval (claimed or not). True when there was one. */
export function revokeApproval(db: DatabaseSync, boxId: string): boolean {
  return Number(db.prepare('DELETE FROM site_approvals WHERE box_id = ?').run(boxId).changes) > 0;
}

/** What the Worker holds for a box with no approval: the hash it registered and its name. */
export interface ClaimRegistration {
  claimHash: string;
  name: string;
}

/** The box's own secret, but its site was revoked and MAXCOM has not let it back in (`cloud-unrevoke`). */
export class ClaimRevoked extends Error {
  constructor() {
    super('box_revoked');
    this.name = 'ClaimRevoked';
  }
}

/** The claim is good but the daily cap is reached: nothing was written, the box asks again later. */
export class ClaimPending extends Error {
  constructor() {
    super('pending');
    this.name = 'ClaimPending';
  }
}

/** True when the stored site key (JSON) is the same EC point as `jwk` (compared in constant time). */
function sameJwk(stored: unknown, jwk: JsonWebKey): boolean {
  let clean: JsonWebKey | null = null;
  try {
    clean = typeof stored === 'string' ? cleanPublicJwk(JSON.parse(stored)) : null;
  } catch {
    clean = null;
  }
  const a = Buffer.from(`${String(jwk.x)}.${String(jwk.y)}`);
  const b = clean === null ? Buffer.alloc(a.length) : Buffer.from(`${String(clean.x)}.${String(clean.y)}`);
  return clean !== null && a.length === b.length && timingSafeEqual(a, b);
}

const hashBuf = (v: unknown): Buffer => (typeof v === 'string' && CLAIM_HASH_RE.test(v) ? Buffer.from(v, 'hex') : Buffer.alloc(32));

/** The start and end (ISO) of the UTC day `now` falls in. */
function utcDay(now: Date): [string, string] {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return [new Date(start).toISOString(), new Date(start + 24 * 3_600_000).toISOString()];
}

/** True when today's (UTC) automatic new suraus have reached the daily cap: a new box would be held pending now. */
export function autoSurauCapReached(db: DatabaseSync, now: Date): boolean {
  const [dayStart, dayEnd] = utcDay(now);
  const today = Number(
    db.prepare('SELECT COUNT(*) AS n FROM suraus WHERE created_by = ? AND created_at >= ? AND created_at < ?').get(AUTO_SURAU_ACTOR, dayStart, dayEnd)?.n ?? 0,
  );
  return today >= autoSurauDailyCap();
}

/**
 * Spend an approval, or link a registered box by itself. Throws `LinkError(401)` for every refusal, malformed bodies
 * included, and `ClaimPending` when the daily cap holds a new box back. `registration` is what the Worker holds for
 * the box (null: none, or not asked because an approval exists).
 */
export function redeemClaim(deps: SitesDeps, body: unknown, registration: ClaimRegistration | null = null): LinkResult & { boxId: string; role: string } {
  const refuse = (): never => {
    throw new LinkError(401, BAD_CLAIM);
  };
  if (!isPlain(body)) return refuse();
  const { boxId, claim, publicJwk } = body;
  if (typeof boxId !== 'string' || !BOX_ID_RE.test(boxId) || typeof claim !== 'string' || claim.length !== 64) return refuse();
  const jwk = cleanPublicJwk(publicJwk);
  if (jwk === null) return refuse();
  const presentedHex = sha256hex(claim);
  const presented = Buffer.from(presentedHex, 'hex');

  const now = deps.now();
  const nowIso = now.toISOString();
  const siteToken = randomToken(32);
  const wakeSecret = randomToken(32);
  let name = '';
  let surauId = '';
  let role = 'primary';
  let pending = false;
  let revoked = false;
  const markLinked = (): void => {
    deps.db.prepare('UPDATE suraus SET linked_at = ? WHERE id = ? AND linked_at IS NULL').run(nowIso, surauId);
  };
  const ok = tx(deps.db, (): boolean => {
    const row = deps.db.prepare('SELECT name, claim_hash, claimed_at, surau_id, mode FROM site_approvals WHERE box_id = ?').get(boxId);
    const site = deps.db.prepare('SELECT surau_id, name, public_jwk FROM sites WHERE box_id = ?').get(boxId);
    if (row !== undefined) {
      // compare first, whatever the row says, so the answer time does not tell an approved id from an unknown one
      if (!timingSafeEqual(presented, hashBuf(row.claim_hash))) return false;
      // an approval with no target (made before migration 019) can never be claimed
      if (!surauExists(deps.db, row.surau_id)) return false;
      if (site !== undefined && site.surau_id !== row.surau_id) return false;
      surauId = row.surau_id;
      if (row.claimed_at === null) {
        // the first claim of an approval: the site must not be live, nor another box live in that surau
        if (liveSite(deps.db, boxId) || surauHasOtherBox(deps.db, surauId, boxId)) return false;
        deps.db.prepare('UPDATE site_approvals SET claimed_at = ? WHERE box_id = ?').run(nowIso, boxId);
      } else {
        // A lost answer: the box never stored its key, so it still holds R and claims again. Within 24 hours of the
        // first claim, and only while the site that claim made is live, it gets a fresh key and wake secret (the
        // previous ones die with writeSite). claimed_at stays at the first claim, so the window never grows.
        const at = typeof row.claimed_at === 'string' ? Date.parse(row.claimed_at) : NaN;
        if (!Number.isFinite(at) || now.getTime() - at >= RECLAIM_WINDOW_MS || now.getTime() < at || !liveSite(deps.db, boxId)) return false;
      }
      name = String(row.name);
      role = typeof row.mode === 'string' && row.mode !== '' ? row.mode : 'primary';
      writeSite(deps, { boxId, name, jwk, siteToken, wakeSecret, now, surauId, event: 'claim', role });
      markLinked();
      return true;
    }

    // no approval: the Worker's registration decides
    const registered = registration !== null && timingSafeEqual(presented, hashBuf(registration.claimHash));
    if (!registered) return false;
    const regName = cleanText(registration.name, 120);
    const keep = (): void => {
      deps.db
        .prepare(
          `INSERT INTO site_approvals (box_id, name, claim_hash, approved_at, claimed_at, surau_id, mode) VALUES (?, ?, ?, ?, ?, ?, 'primary')
           ON CONFLICT(box_id) DO UPDATE SET name = excluded.name, claim_hash = excluded.claim_hash, approved_at = excluded.approved_at,
             claimed_at = excluded.claimed_at, surau_id = excluded.surau_id, mode = excluded.mode`,
        )
        .run(boxId, name, presentedHex, nowIso, nowIso, surauId);
    };

    if (site !== undefined) {
      // A known box: back into its own surau, never over a live site, and only the SAME box: the claim matches the
      // current registration (checked above) AND the key it presents is the key stored for this site. The box makes a
      // new claim secret after each link, so the secret alone cannot tell it apart; a box that was reset (new key) or
      // a squatter registering a known id with another key never links here (the operator uses `cloud-approve --surau`).
      if (liveSite(deps.db, boxId)) return false;
      if (!sameJwk(site.public_jwk, jwk)) return false;
      // revoke is final: only the CLI `cloud-unrevoke` lets a revoked box back in (spent by this re-link)
      if (deps.db.prepare('SELECT 1 AS x FROM sync_state WHERE key = ?').get(UNREVOKE_PREFIX + boxId) === undefined) {
        revoked = true;
        return false;
      }
      if (!surauExists(deps.db, site.surau_id) || surauHasOtherBox(deps.db, site.surau_id, boxId)) return false;
      deps.db.prepare('DELETE FROM sync_state WHERE key = ?').run(UNREVOKE_PREFIX + boxId);
      surauId = site.surau_id;
      name = regName !== '' ? regName : String(site.name);
      keep();
      writeSite(deps, { boxId, name, jwk, siteToken, wakeSecret, now, surauId, event: 'claim', role });
      markLinked();
      return true;
    }

    // a new box: a new surau, within the daily cap (the count and the insert are in this one transaction)
    if (autoSurauCapReached(deps.db, now)) {
      pending = true;
      return false;
    }
    name = regName !== '' ? regName : `Surau ${boxId}`;
    surauId = insertSurau(deps.db, { name }, AUTO_SURAU_ACTOR, now).id;
    keep();
    writeSite(deps, { boxId, name, jwk, siteToken, wakeSecret, now, surauId, event: 'claim', role });
    markLinked();
    authLog(deps.db, now, 'surau_auto_create', true, { detail: 'surau_auto_create' });
    return true;
  });
  if (pending) throw new ClaimPending();
  if (revoked) throw new ClaimRevoked();
  if (!ok) return refuse();
  return { boxId, siteToken, wakeSecret, surauId, name, cloudTime: nowIso, role };
}

/**
 * The `POST /api/sync/claim` handler body (rate limiting and the role gate are in the route). A box with no approval
 * is looked up at the Worker (unreachable: 503, the box retries). After a good claim the box's pending registration
 * is removed from the Worker (best effort: it also expires on its own); a pending one is kept.
 */
export function createClaimHandler(
  deps: SitesDeps & { workerAdmin?: WorkerAdminConfig | null; /** Test hook; default CLAIM_FLUSH_WAIT_MS. */ flushWaitMs?: number },
): (body: unknown) => Promise<{ status: number; body: unknown }> {
  const waitMs = Math.min(Math.max(deps.flushWaitMs ?? CLAIM_FLUSH_WAIT_MS, 0), CLAIM_FLUSH_WAIT_MS);
  const badClaim = { status: 401, body: { errors: [BAD_CLAIM], code: 'bad_claim' } };
  return async (body) => {
    let registration: ClaimRegistration | null = null;
    const sentId = isPlain(body) ? body.boxId : undefined;
    const approved =
      typeof sentId === 'string' && BOX_ID_RE.test(sentId) && deps.db.prepare('SELECT 1 AS x FROM site_approvals WHERE box_id = ?').get(sentId) !== undefined;
    if (!approved && deps.workerAdmin && typeof sentId === 'string' && BOX_ID_RE.test(sentId)) {
      try {
        const reg = await getRegistration(deps.workerAdmin, sentId);
        registration = reg === null ? null : { claimHash: reg.claimHash, name: reg.name };
      } catch {
        return { status: 503, body: { errors: ['MAXCOM tidak dapat menyemak pendaftaran sekarang; cuba lagi'], code: 'worker_unreachable' } };
      }
    }
    let out: LinkResult & { boxId: string; role: string };
    try {
      out = redeemClaim(deps, body, registration);
    } catch (error) {
      if (error instanceof ClaimPending) return { status: 202, body: { errors: ['Menunggu MAXCOM'], code: 'pending' } };
      if (error instanceof ClaimRevoked) {
        // the registration is kept for MAXCOM to see; nothing else is written
        authLog(deps.db, deps.now(), 'site_claim', false, { detail: 'box_revoked' });
        return { status: 403, body: { errors: ['Kotak ini telah dibatalkan oleh MAXCOM'], code: 'box_revoked' } };
      }
      if (error instanceof LinkError) return badClaim;
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
    // logged under the surau the box belongs to (its site, else its approval's target)
    const owner = deps.db.prepare('SELECT surau_id FROM sites WHERE box_id = ?').get(boxId)?.surau_id
      ?? deps.db.prepare('SELECT surau_id FROM site_approvals WHERE box_id = ?').get(boxId)?.surau_id;
    const surauId = typeof owner === 'string' && SURAU_ID_RE.test(owner) ? owner : (deps.surauId ?? LOCAL_SURAU_ID);
    const pending = deps.db.prepare('SELECT 1 AS x FROM site_approvals WHERE box_id = ? AND claimed_at IS NULL').get(boxId) !== undefined;
    if (revokeApproval(deps.db, boxId) && pending) logChange(deps.db, actor, 'site', boxId, undefined, { event: 'approval_revoke', boxId }, undefined, surauId);
    const r = deps.db
      .prepare('UPDATE sites SET revoked_at = ?, token_hash = NULL WHERE box_id = ? AND revoked_at IS NULL')
      .run(nowIso, boxId);
    if (Number(r.changes) === 0) return pending;
    deps.db.prepare('DELETE FROM sync_state WHERE key = ?').run(WAKE_PREFIX + boxId);
    deps.db.prepare('DELETE FROM sync_state WHERE key = ?').run(UNREVOKE_PREFIX + boxId);
    enqueueSiteDelete(deps.db, boxId, deps.now());
    logChange(deps.db, actor, 'site', boxId, undefined, { event: 'revoke', boxId }, undefined, surauId);
    return true;
  });
}

/**
 * Let a revoked box re-link once, by itself, into its own surau (CLI `cloud-unrevoke`). Throws `ApprovalError`:
 * `not_found` for an unknown box, `not_revoked` for a live one.
 */
export function unrevokeSite(deps: { db: DatabaseSync; now: () => Date }, boxId: string, actor = 'local'): { surauId: string } {
  return tx(deps.db, () => {
    const site = BOX_ID_RE.test(boxId) ? deps.db.prepare('SELECT surau_id, revoked_at FROM sites WHERE box_id = ?').get(boxId) : undefined;
    if (site === undefined) throw new ApprovalError('not_found', 'Kotak tidak dijumpai');
    if (site.revoked_at === null) throw new ApprovalError('not_revoked', 'Kotak ini tidak dibatalkan');
    const surauId = String(site.surau_id);
    setState(deps.db, UNREVOKE_PREFIX + boxId, deps.now().toISOString());
    logChange(deps.db, actor, 'site', boxId, undefined, { event: 'unrevoke', boxId }, undefined, surauId);
    return { surauId };
  });
}

export interface SiteSummary {
  boxId: string;
  name: string;
  lastSeenAt: string | null;
  /** The theme contract the box reported (X-Maxcom-Themes), or null when it never did (an older MAXCOM). */
  themeContract: number | null;
  themeBuiltIn: string[];
}

const THEME_HEADER_RE = /^(\d{1,3});([a-z,]{0,200})$/;

/** Records what a box says it supports. Anything that does not match the exact shape is ignored. */
export function noteThemeSupport(db: DatabaseSync, boxId: string, header: unknown): void {
  if (typeof header !== 'string') return;
  const m = THEME_HEADER_RE.exec(header);
  if (m === null) return;
  const contract = Number(m[1]);
  const builtins = m[2]!;
  const row = db.prepare('SELECT theme_contract AS c, theme_builtins AS b FROM sites WHERE box_id = ?').get(boxId);
  if (row === undefined || (row.c === contract && row.b === builtins)) return;
  db.prepare('UPDATE sites SET theme_contract = ?, theme_builtins = ? WHERE box_id = ?').run(contract, builtins, boxId);
}

const FEATURES_HEADER_RE = /^[A-Za-z]{1,30}(?:,[A-Za-z]{1,30}){0,19}$/;

/** Records the server features a box says it has (`X-Maxcom-Features`). Anything that does not match the exact shape is ignored. */
export function noteBoxFeatures(db: DatabaseSync, boxId: string, header: unknown): void {
  if (typeof header !== 'string' || !FEATURES_HEADER_RE.test(header)) return;
  const row = db.prepare('SELECT box_features AS f FROM sites WHERE box_id = ?').get(boxId);
  if (row === undefined || row.f === header) return;
  db.prepare('UPDATE sites SET box_features = ? WHERE box_id = ?').run(header, boxId);
}

/**
 * True when the surau has at least one linked box and every linked box has reported `feature`. The cloud lists a
 * feature of its own for a surau only then: a box that has not (an older build, or one that never reported) would
 * refuse what the feature lets the app save.
 */
export function surauBoxesHave(db: DatabaseSync, surauId: string, feature: string): boolean {
  const rows = db.prepare('SELECT box_features AS f FROM sites WHERE surau_id = ? AND linked_at IS NOT NULL AND revoked_at IS NULL').all(surauId);
  return rows.length > 0 && rows.every((r) => typeof r.f === 'string' && r.f.split(',').includes(feature));
}

/** The boxes of one surau with what each supports, for the cloud's answers. */
export function themeSupportOf(db: DatabaseSync, surauId: string): Array<{ boxId: string; name: string; contract: number | null; builtIn: string[] }> {
  return db
    .prepare('SELECT box_id, name, theme_contract, theme_builtins FROM sites WHERE surau_id = ? AND linked_at IS NOT NULL AND revoked_at IS NULL ORDER BY box_id')
    .all(surauId)
    .map((r) => ({
      boxId: String(r.box_id),
      name: String(r.name),
      contract: typeof r.theme_contract === 'number' ? r.theme_contract : null,
      builtIn: typeof r.theme_builtins === 'string' && r.theme_builtins !== '' ? r.theme_builtins.split(',') : [],
    }));
}

export function listSites(db: DatabaseSync, surauId?: string): SiteSummary[] {
  const sql = 'SELECT box_id, name, last_seen_at FROM sites WHERE linked_at IS NOT NULL AND revoked_at IS NULL' + (surauId === undefined ? '' : ' AND surau_id = ?') + ' ORDER BY box_id';
  return db
    .prepare(sql.replace('SELECT box_id, name, last_seen_at FROM', 'SELECT box_id, name, last_seen_at, theme_contract, theme_builtins FROM'))
    .all(...(surauId === undefined ? [] : [surauId]))
    .map((r) => ({
      boxId: String(r.box_id),
      name: String(r.name),
      lastSeenAt: typeof r.last_seen_at === 'string' ? r.last_seen_at : null,
      themeContract: typeof r.theme_contract === 'number' ? r.theme_contract : null,
      themeBuiltIn: typeof r.theme_builtins === 'string' && r.theme_builtins !== '' ? r.theme_builtins.split(',') : [],
    }));
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
      ['image/jpeg', 'image/png', 'image/webp', 'audio/mpeg', PACK_MIME],
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
        // the bytes must be the id before anything is stored or counted for the surau
        if (sha256hex(body) !== id) return reply.code(400).send({ errors: ['Fail tidak sepadan dengan pengecam'], code: 'id_mismatch' });
        // counted against the site's own surau (decision 24); a full surau gets 413 storage_full, nothing stored
        const meta = putSurauAsset(deps.db, deps.dataDir, body, request.headers['content-type'] ?? '', `site:${request.auth.boxId}`, request.auth.surauId);
        return reply.code(meta.created ? 201 : 200).send({ id: meta.id });
      } catch (error) {
        if (error instanceof StorageFullError) return reply.code(413).send({ errors: error.errors, code: error.code });
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
