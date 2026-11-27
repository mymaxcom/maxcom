import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createRateLimiter } from '../auth/ratelimit.ts';
import { logChange, tx } from '../auth/users.ts';
import { authLog } from '../auth/sessions.ts';
import type { ChangeBus } from '../events.ts';
import { getVersion } from '../settingsStore.ts';
import { LINK_ID_RE } from '../link/journal.ts';
import { backupBeforePrune } from '../surau/prune.ts';
import type { BackupOptions } from '../surau/prune.ts';
import { verifyBoxCall } from './boxCall.ts';
import { ResetRefused, applyReset, foreignIdIn, parseResetBody } from './surauReset.ts';

/**
 * Cloud routes of multi-box 2B (B3; contract `2026-11-23-cloud-sleep-reset-contract.md`):
 *
 * - `POST /api/sync/sleep {linkId, reason:'link'}`: the surau of a box that became a follower sleeps. Every write to it
 *   is refused 409 `surau_asleep` (the auth hook), reads still answer, the prune skips it.
 * - `POST /api/sync/wake {linkId, reason:'unlink-back'|'unlink-on'}`: only the box that put it to sleep (the operator
 *   wakes any with the CLI `surau-wake`).
 * - `POST /api/sync/reset-from-box {linkId, reason, state}`: the surau is made equal to its box (`surauReset.ts`),
 *   after an encrypted backup of the whole cloud database.
 *
 * All three: a linked SITE only (a person's session is answered 404 `not_found`), the surau is the site's own (never a
 * body field), and the call is signed with the box's sync key (`boxCall.ts`).
 */

export const SLEEP_BODY_LIMIT = 64 * 1024;
export const RESET_BODY_LIMIT = 64 * 1024 * 1024;
export const RESETS_PER_DAY = 3;
const DAY_MS = 24 * 3_600_000;
export const SLEEP_ACTOR_CLI = 'system:cli';

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface SurauSleep {
  asleepAt: string;
  asleepBox: string | null;
}

/** The surau's sleep, or null when it is awake (or unknown here). */
export function sleepOf(db: DatabaseSync, surauId: string): SurauSleep | null {
  const r = db.prepare('SELECT asleep_at, asleep_box FROM suraus WHERE id = ? AND asleep_at IS NOT NULL').get(surauId);
  return r === undefined ? null : { asleepAt: String(r.asleep_at), asleepBox: r.asleep_box === null ? null : String(r.asleep_box) };
}

/** The surau's own change-log floor (0 when never reset). */
export function surauLogFloor(db: DatabaseSync, surauId: string): number {
  const r = db.prepare('SELECT log_floor FROM suraus WHERE id = ?').get(surauId);
  const n = Number(r?.log_floor ?? 0);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** Wake a surau (the operator's CLI, or its own box through the route). Returns false when it was not asleep. */
export function wakeSurau(db: DatabaseSync, surauId: string, actor: string, why: string, now: Date): boolean {
  return tx(db, () => {
    const before = sleepOf(db, surauId);
    if (before === null) return false;
    db.prepare('UPDATE suraus SET asleep_at = NULL, asleep_box = NULL WHERE id = ?').run(surauId);
    logChange(db, actor, 'surau', surauId, { asleepAt: before.asleepAt, asleepBox: before.asleepBox }, { event: 'wake', reason: why, at: now.toISOString() }, { origin: 'cloud' }, surauId);
    return true;
  });
}

export interface SurauSleepDeps {
  role: 'box' | 'cloud';
  db: DatabaseSync;
  now: () => Date;
  dataDir: string;
  bus: ChangeBus;
  /** `<db dir>/backups`; null (an in-memory database) refuses every reset with `backup_unavailable`. */
  backupDir: string | null;
  backup?: Omit<BackupOptions, 'log' | 'kind'>;
  /** Is a live broadcast of this surau open on the cloud (an old cloud-held YouTube grant)? */
  openBroadcast: (surauId: string) => boolean;
  log?: (line: string) => void;
}

export function registerSurauSleepRoutes(app: FastifyInstance, deps: SurauSleepDeps): void {
  const { db, now } = deps;
  // per surau and box, on top of the general limiter: these calls are rare (once per link or unlink)
  const limits = createRateLimiter({ windowMs: 10 * 60_000, max: 20 });

  const send = (reply: FastifyReply, status: number, code: string, extra: Record<string, unknown> = {}): FastifyReply =>
    reply.code(status).header('Cache-Control', 'no-store').send({ ...(status >= 400 ? { errors: [code] } : {}), ...(status >= 400 ? { code } : {}), ...extra });

  /** Site only, rate limited, signed; returns the site or null when the reply was already sent. */
  const gate = (request: FastifyRequest, reply: FastifyReply, path: string): { surauId: string; boxId: string; body: unknown } | null => {
    const a = request.auth;
    if (deps.role !== 'cloud') {
      send(reply, 404, 'not_found');
      return null;
    }
    // a person's session passes the hook (`session_or_site`) and is answered like an unknown route, as
    // `device-seen` and `people-ids` do
    if (a == null || a.kind !== 'site') {
      send(reply, 404, 'not_found');
      return null;
    }
    const hit = limits.hit(`${a.surauId}:${a.boxId}`);
    if (!hit.ok) {
      reply.header('Retry-After', String(hit.retryAfterSec));
      send(reply, 429, 'too_many');
      return null;
    }
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const refused = verifyBoxCall(db, { method: request.method, path, boxId: a.boxId, headers: request.headers as Record<string, unknown>, body: raw, now: now() });
    if (refused !== null) {
      authLog(db, now(), 'box_call_refused', false, { detail: `${path}:${refused.code}`, ip: request.ip });
      send(reply, refused.status, refused.code);
      return null;
    }
    let body: unknown;
    try {
      body = raw.length === 0 ? null : (JSON.parse(raw.toString('utf8')) as unknown);
    } catch {
      send(reply, 400, 'bad_body');
      return null;
    }
    return { surauId: a.surauId, boxId: a.boxId, body };
  };

  const linkAndReason = (body: unknown, reasons: ReadonlySet<string>): { linkId: string; reason: string } | null => {
    if (!isPlain(body)) return null;
    for (const k of Object.keys(body)) if (k !== 'linkId' && k !== 'reason') return null;
    if (typeof body.linkId !== 'string' || !LINK_ID_RE.test(body.linkId)) return null;
    if (typeof body.reason !== 'string' || !reasons.has(body.reason)) return null;
    return { linkId: body.linkId, reason: body.reason };
  };

  void app.register(async (scope) => {
    // the signature covers the exact bytes: the body is read raw and parsed here
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: RESET_BODY_LIMIT }, (_request, body, done) => done(null, body));

    scope.post('/api/sync/sleep', { bodyLimit: SLEEP_BODY_LIMIT }, async (request, reply) => {
      const site = gate(request, reply, '/api/sync/sleep');
      if (site === null) return reply;
      const b = linkAndReason(site.body, new Set(['link']));
      if (b === null) return send(reply, 400, 'bad_body');
      // only the surau's primary box sleeps it (as only it resets it): a second site cannot freeze the surau
      const role = db.prepare('SELECT role FROM sites WHERE box_id = ? AND revoked_at IS NULL').get(site.boxId);
      if (role === undefined || role.role !== 'primary') return send(reply, 403, 'forbidden');
      const at = now().toISOString();
      const result = tx(db, () => {
        const was = sleepOf(db, site.surauId);
        if (was !== null) return was.asleepBox === site.boxId ? 'same' : 'other';
        db.prepare('UPDATE suraus SET asleep_at = ?, asleep_box = ? WHERE id = ?').run(at, site.boxId, site.surauId);
        logChange(db, `site:${site.boxId}`, 'surau', site.surauId, undefined, { event: 'sleep', reason: b.reason, linkId: b.linkId, at }, { origin: 'cloud' }, site.surauId);
        return 'slept';
      });
      if (result === 'other') return send(reply, 409, 'surau_asleep');
      return send(reply, 200, 'ok', { ok: true, asleepAt: sleepOf(db, site.surauId)?.asleepAt ?? at });
    });

    scope.post('/api/sync/wake', { bodyLimit: SLEEP_BODY_LIMIT }, async (request, reply) => {
      const site = gate(request, reply, '/api/sync/wake');
      if (site === null) return reply;
      const b = linkAndReason(site.body, new Set(['unlink-back', 'unlink-on']));
      if (b === null) return send(reply, 400, 'bad_body');
      const was = sleepOf(db, site.surauId);
      if (was === null) return send(reply, 200, 'ok', { ok: true });
      // only the box that put it to sleep wakes it (the operator uses the CLI)
      if (was.asleepBox !== site.boxId) return send(reply, 403, 'not_sleeper');
      wakeSurau(db, site.surauId, `site:${site.boxId}`, `${b.reason}:${b.linkId}`, now());
      return send(reply, 200, 'ok', { ok: true });
    });

    scope.post('/api/sync/reset-from-box', { bodyLimit: RESET_BODY_LIMIT }, async (request, reply) => {
      const site = gate(request, reply, '/api/sync/reset-from-box');
      if (site === null) return reply;
      const { surauId, boxId } = site;
      // only the surau's primary box may make the cloud equal to itself
      const row = db.prepare('SELECT role FROM sites WHERE box_id = ? AND revoked_at IS NULL').get(boxId);
      if (row === undefined || row.role !== 'primary') return send(reply, 403, 'forbidden');
      if (sleepOf(db, surauId) !== null) return send(reply, 409, 'surau_asleep');
      if (deps.openBroadcast(surauId)) return send(reply, 409, 'live_open');
      const since = new Date(now().getTime() - DAY_MS).toISOString();
      const done = Number(db.prepare('SELECT COUNT(*) AS n FROM surau_resets WHERE surau_id = ? AND ok = 1 AND at > ?').get(surauId, since)?.n ?? 0);
      // every attempt that reached the backup costs a whole-database copy: refused ones count too (twice the cap)
      const tried = Number(db.prepare('SELECT COUNT(*) AS n FROM surau_resets WHERE surau_id = ? AND at > ?').get(surauId, since)?.n ?? 0);
      if (done >= RESETS_PER_DAY || tried >= RESETS_PER_DAY * 2) return send(reply, 429, 'reset_limit');
      let body;
      try {
        body = parseResetBody(site.body, { boxId, surauId });
      } catch (error) {
        if (error instanceof ResetRefused) return send(reply, error.status, error.code, { detail: error.detail });
        throw error;
      }
      if (foreignIdIn(db, surauId, body.entries)) {
        authLog(db, now(), 'box_reset_refused', false, { detail: 'foreign_id', ip: request.ip });
        return send(reply, 409, 'foreign_id');
      }
      // BACKUP first: the whole cloud database, encrypted; no backup, no reset
      if (deps.backupDir === null) return send(reply, 503, 'backup_unavailable');
      let backup: string;
      try {
        backup = backupBeforePrune(db, deps.backupDir, now(), { ...deps.backup, kind: 'reset', ...(deps.log ? { log: deps.log } : {}) });
      } catch (error) {
        deps.log?.(`reset: sandaran gagal, surau ${surauId} tidak ditetapkan semula (${error instanceof Error ? error.message : String(error)})`);
        return send(reply, 503, 'backup_unavailable');
      }
      const at = now().toISOString();
      const audit = (ok: boolean, counts: unknown): void => {
        db.prepare('INSERT INTO surau_resets (surau_id, box_id, link_id, reason, at, backup, counts_json, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
          surauId, boxId, body.linkId, body.reason, at, backup.split(/[\\/]/).pop() ?? null, JSON.stringify(counts), ok ? 1 : 0,
        );
      };
      try {
        const out = applyReset(db, { surauId, boxId, body, now: now(), dataDir: deps.dataDir });
        audit(true, out.counts);
        deps.bus.emit(getVersion(db, surauId), surauId);
        return send(reply, 200, 'ok', { ok: true, at, seq: out.seq, missing: out.missing });
      } catch (error) {
        if (error instanceof ResetRefused) {
          audit(false, { refused: error.code, detail: error.detail ?? null });
          return send(reply, error.status, error.code, { detail: error.detail });
        }
        throw error;
      }
    });
  });
}
