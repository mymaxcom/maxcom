/**
 * /api/finance/*. Every answer is `Cache-Control: no-store`. A finance value never appears in a URL (ids only) and
 * never in a log. Reads need finance:read; writes, photos, the PDF and the audit view need finance:write; lookups
 * and month states are the Pentadbir's (settings:write) and the handler also requires finance:write.
 */
import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { balances, klDateOf, monthIn, monthOut } from '@surau/core';
import type { FinanceEntry, Fund } from '@surau/core';
import { identityCan, tooMany } from '../auth/authz.ts';
import type { Limiters } from '../auth/authz.ts';
import { logChange, tx } from '../auth/users.ts';
import type { ChangeBus } from '../events.ts';
import { getSettings, getVersion } from '../settingsStore.ts';
import {
  FinanceError, allEntries, appendEntryIn, ensureSeeded, financeCounts, getEntry, listEntries, listFunds, listMonths, listPerihal,
  putFundIn, putMonthIn, putPerihalIn, monthStatus,
} from './store.ts';
import { PHOTO_ID_RE, PhotoError, MAX_PHOTO_BYTES, photoPath, putPhoto } from './photos.ts';
import { freezeReport } from './report.ts';
import { registerReportRoutes } from './reportRoutes.ts';
import { noteFinanceView } from './viewLog.ts';

export interface FinanceRouteDeps {
  db: DatabaseSync;
  dataDir: string;
  bus: ChangeBus;
  role: 'box' | 'cloud';
  surauId: string;
  now: () => Date;
  limiters: Limiters;
  actorOf: (request: FastifyRequest) => string;
  deviceOf: (request: FastifyRequest) => string | undefined;
  /** Builds the frozen report JSON when a month is closed; the default is the report module's. */
  freeze?: (db: DatabaseSync, ym: string, now: Date) => string;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function failure(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof FinanceError) return reply.code(error.status).send({ errors: error.errors, code: error.code });
  if (error instanceof PhotoError) return reply.code(error.status).send({ errors: error.errors });
  throw error;
}

/** Drops the photo reference for a caller who may not see photos (finance:read without finance:write). */
function stripPhoto<T extends { photoId: string | null }>(e: T, canPhoto: boolean): T | Omit<T, 'photoId'> {
  if (canPhoto) return e;
  const { photoId: _p, ...rest } = e;
  return rest;
}

export function registerFinanceRoutes(app: FastifyInstance, deps: FinanceRouteDeps): void {
  const { db, dataDir, bus } = deps;

  const emit = (): void => bus.emit(getVersion(db));
  const writer = (request: FastifyRequest): boolean => identityCan(request.auth, 'finance:write');
  const appendCtx = () => ({ now: deps.now(), role: deps.role, surauId: deps.surauId });
  const metaOf = (request: FastifyRequest) => {
    const deviceId = deps.deviceOf(request);
    return deviceId === undefined ? undefined : { deviceId };
  };

  void app.register(async (scope) => {
    scope.addContentTypeParser(['image/jpeg', 'image/png', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: MAX_PHOTO_BYTES }, (_request, body, done) => done(null, body));

    scope.addHook('preHandler', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const url = request.url;
      if (!url.startsWith('/api/finance/')) return undefined;
      // Module off (decision 25): data is kept and finance:write holders keep working; others see nothing.
      if (getSettings(db).finance.enabled !== true && !writer(request)) {
        return reply.code(404).send({ errors: ['module_off'], code: 'module_off' });
      }
      // The Pentadbir MAXCOM sees every surau's money by right; the Pentadbir Surau must be able to see that they did.
      noteFinanceView(db, request.auth, request.routeOptions.url ?? 'finance', deps.now(), deps.actorOf(request), deps.deviceOf(request));
      return undefined;
    });

    // The module is switched on in Tetapan; the starting lists are written the first time a box is asked.
    const seedIfNeeded = (request: FastifyRequest): void => {
      // only a box, only with the module on, and only on behalf of someone who may write: a reader never causes a write
      if (deps.role !== 'box' || getSettings(db).finance.enabled !== true || !writer(request)) return;
      if (financeCounts(db).funds > 0) return;
      ensureSeeded(db, deps.actorOf(request), deps.now());
      emit();
    };

    scope.get('/api/finance/summary', async (request) => {
      seedIfNeeded(request);
      const entries = allEntries(db);
      const funds = listFunds(db);
      const bal = balances(entries, funds);
      const now = deps.now();
      const ym = klDateOf(now).slice(0, 7);
      const fin = getSettings(db).finance as unknown as { startedOn: string };
      const since = (request.query as { since?: unknown }).since;
      const adjusts = entries.filter((e) => e.kind === 'adjust');
      return {
        funds: funds.map((f): Fund & { balanceSen: number } => ({ ...f, balanceSen: bal[f.id] ?? 0 })),
        month: { ym, status: monthStatus(db, ym), inSen: monthIn(entries, ym), outSen: monthOut(entries, ym) },
        counts: {
          entries: entries.length,
          corrections: adjusts.length,
          correctionsSince: typeof since === 'string' && ISO_RE.test(since) ? adjusts.filter((e) => e.receivedAt > since).length : null,
        },
        startedOn: fin.startedOn === '' ? null : fin.startedOn,
      };
    });

    scope.get('/api/finance/entries', async (request, reply) => {
      const q = request.query as { ym?: unknown; fund?: unknown; since?: unknown; limit?: unknown };
      const opts: { ym?: string; fundId?: string; sinceEditedAt?: string; limit?: number } = {};
      if (q.ym !== undefined) { if (typeof q.ym !== 'string' || !YM_RE.test(q.ym)) return reply.code(400).send({ errors: ['ym must be YYYY-MM'] }); opts.ym = q.ym; }
      if (q.fund !== undefined) { if (typeof q.fund !== 'string' || !SAFE_ID.test(q.fund)) return reply.code(400).send({ errors: ['fund is not valid'] }); opts.fundId = q.fund; }
      if (q.since !== undefined) { if (typeof q.since !== 'string' || !ISO_RE.test(q.since)) return reply.code(400).send({ errors: ['since must be a time'] }); opts.sinceEditedAt = q.since; }
      if (q.limit !== undefined) { const n = Number(q.limit); if (!Number.isInteger(n) || n < 1) return reply.code(400).send({ errors: ['limit is not valid'] }); opts.limit = n; }
      const can = writer(request);
      return { entries: listEntries(db, opts).map((e) => stripPhoto(e, can)) };
    });

    scope.get('/api/finance/entries/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!SAFE_ID.test(id)) return reply.code(404).send({ errors: ['not found'] });
      const got = getEntry(db, id);
      if (got === null) return reply.code(404).send({ errors: ['not found'] });
      const can = writer(request);
      return {
        entry: stripPhoto(got.entry, can),
        corrections: got.corrections.map((c) => stripPhoto(c, can)),
        effective: stripPhoto(got.effective, can),
      };
    });

    scope.put('/api/finance/entries/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      const body: unknown = request.body;
      if (!SAFE_ID.test(id)) return reply.code(400).send({ errors: ['id must be 1-100 letters, digits, - or _'] });
      if (!isPlain(body)) return reply.code(400).send({ errors: ['body must be a JSON object'] });
      if (body.id !== undefined && body.id !== id) return reply.code(400).send({ errors: ['id in the body must match the path'] });
      try {
        const entry: FinanceEntry = tx(db, () => appendEntryIn(db, { ...body, id }, deps.actorOf(request), appendCtx(), metaOf(request)));
        emit();
        return { entry };
      } catch (error) {
        return failure(reply, error);
      }
    });

    scope.get('/api/finance/funds', async (request) => {
      seedIfNeeded(request);
      const all = (request.query as { all?: unknown }).all === '1';
      return { funds: listFunds(db, { includeArchived: all }) };
    });

    scope.put('/api/finance/funds/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!writer(request)) return reply.code(403).send({ errors: ['forbidden'] });
      try {
        const fund = tx(db, () => putFundIn(db, id, request.body, deps.actorOf(request), metaOf(request)));
        emit();
        return { fund };
      } catch (error) {
        return failure(reply, error);
      }
    });

    scope.get('/api/finance/perihal', async (request) => {
      seedIfNeeded(request);
      const all = (request.query as { all?: unknown }).all === '1';
      return { perihal: listPerihal(db, { includeArchived: all }) };
    });

    scope.put('/api/finance/perihal/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!writer(request)) return reply.code(403).send({ errors: ['forbidden'] });
      try {
        const perihal = tx(db, () => putPerihalIn(db, id, request.body, deps.actorOf(request), metaOf(request)));
        emit();
        return { perihal };
      } catch (error) {
        return failure(reply, error);
      }
    });

    scope.get('/api/finance/months', async () => ({ months: listMonths(db) }));

    scope.put('/api/finance/months/:ym', async (request, reply) => {
      const { ym } = request.params as { ym: string };
      if (!writer(request)) return reply.code(403).send({ errors: ['forbidden'] });
      try {
        const now = deps.now();
        const freeze = deps.freeze ?? ((d: DatabaseSync, m: string, n: Date) => freezeReport(d, m, n, deps.role));
        const month = tx(db, () =>
          putMonthIn(db, ym, request.body, deps.actorOf(request), {
            now, role: deps.role, surauId: deps.surauId, ...(freeze ? { freeze: (m: string) => freeze(db, m, now) } : {}),
          }, metaOf(request)));
        emit();
        return { month };
      } catch (error) {
        return failure(reply, error);
      }
    });

    registerReportRoutes(scope, { db, role: deps.role, now: deps.now, limiters: deps.limiters, actorOf: deps.actorOf, deviceOf: deps.deviceOf });

    // ---- photos (finance:write; never reachable through /assets/) ----

    scope.post('/api/finance/photos', { bodyLimit: MAX_PHOTO_BYTES }, async (request, reply) => {
      const a = request.auth;
      const key = a !== null && a !== undefined && a.kind === 'user' ? `s:${a.sessionId}` : `ip:${request.ip}`;
      const hit = deps.limiters.financePhoto.hit(key);
      if (!hit.ok) return tooMany(reply, hit.retryAfterSec);
      const body: unknown = request.body;
      if (!Buffer.isBuffer(body)) return reply.code(400).send({ errors: ['body must be the raw JPEG with an image/jpeg Content-Type'] });
      const entryId = request.headers['x-entry-id'];
      if (typeof entryId !== 'string' || !SAFE_ID.test(entryId)) return reply.code(400).send({ errors: ['X-Entry-Id header is required'] });
      if ((request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase() !== 'image/jpeg') {
        return reply.code(400).send({ errors: ['photo must be a JPEG image'] });
      }
      try {
        const saved = tx(db, () => putPhoto(db, dataDir, body, entryId, deps.actorOf(request), deps.now(), metaOf(request)));
        const row = db.prepare('SELECT width, height FROM finance_photos WHERE id = ?').get(saved.id);
        return reply.code(200).send({ id: saved.id, bytes: saved.bytes, width: row?.width ?? null, height: row?.height ?? null });
      } catch (error) {
        return failure(reply, error);
      }
    });

    scope.get('/api/finance/photos/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!PHOTO_ID_RE.test(id)) return reply.code(404).send({ errors: ['not found'] });
      const found = photoPath(db, dataDir, id);
      if (found === null) return reply.code(404).send({ errors: ['not found'] });
      return reply
        .header('Content-Type', found.mime)
        .header('Cache-Control', 'no-store')
        .header('Content-Disposition', 'inline')
        .header('X-Content-Type-Options', 'nosniff')
        .send(createReadStream(found.path));
    });

    // ---- the finance audit view (finance:write): ledger writes, lookups, months, reports, views, refused ops ----

    scope.get('/api/finance/audit', async (request, reply) => {
      const q = request.query as { since?: unknown; limit?: unknown };
      const n = Number(q.limit ?? 200);
      const limit = Number.isInteger(n) ? Math.min(Math.max(n, 1), 1000) : 200;
      const sinceRaw = q.since === undefined ? 0 : Number(q.since);
      if (!Number.isInteger(sinceRaw) || sinceRaw < 0) return reply.code(400).send({ errors: ['since is not valid'] });
      // No `since`: the newest rows, newest first (what the screen shows). With `since` (a change id, 0 for the start): the rows AFTER it,
      // oldest first up to the limit, and `next` is the cursor for the following page (null when this page is the last).
      const forward = q.since !== undefined;
      const changes = db.prepare(
        `SELECT c.id, c.at, c.actor, c.entity, c.entity_id, c.after_json, c.device_id, c.origin, c.edited_at, c.synced_at,
                u.name AS user_name, f.cloud_received_at AS cloud_received_at
           FROM change_log c
           LEFT JOIN users u ON c.actor = 'user:' || u.id
           LEFT JOIN finance_entries f ON c.entity = 'finance:entry' AND f.id = c.entity_id
          WHERE c.entity LIKE 'finance:%' AND c.id > ?
          ORDER BY c.id ${forward ? 'ASC' : 'DESC'} LIMIT ?`,
      ).all(sinceRaw, limit);
      const fullPage = forward && changes.length === limit;
      const lastChangeId = changes.length > 0 ? Number(changes[changes.length - 1]!.id) : null;
      // Refused ops are in another table: with `since` they are bounded by the time of that change row (and, on a full
      // page, by the time of the page's last row, so the next page picks up the rest).
      const atOf = (id: number): string | null => {
        const r = db.prepare('SELECT at FROM change_log WHERE id = (SELECT MAX(id) FROM change_log WHERE id <= ?)').get(id);
        return r !== undefined && typeof r.at === 'string' ? r.at : null;
      };
      const lowAt = forward ? atOf(sinceRaw) : null;
      const highAt = fullPage && lastChangeId !== null ? atOf(lastChangeId) : null;
      const refused = db.prepare(
        `SELECT a.id, a.at, a.user_id, a.device_id, a.detail, u.name AS user_name
           FROM auth_log a LEFT JOIN users u ON a.user_id = u.id
          WHERE a.event = 'sync_refused' AND a.detail LIKE 'apply_finance_%'
            ${lowAt !== null ? 'AND a.at >= ?' : ''} ${highAt !== null ? 'AND a.at <= ?' : ''}
          ORDER BY a.id ${forward ? 'ASC' : 'DESC'} LIMIT ?`,
      ).all(...(lowAt !== null ? [lowAt] : []), ...(highAt !== null ? [highAt] : []), limit);
      const parse = (v: unknown): unknown => {
        if (typeof v !== 'string') return null;
        try { return JSON.parse(v) as unknown; } catch { return null; }
      };
      const rows = [
        ...changes.map((r) => ({
          id: `c${Number(r.id)}`, at: String(r.at), actor: String(r.actor), userName: typeof r.user_name === 'string' ? r.user_name : null,
          deviceId: typeof r.device_id === 'string' ? r.device_id : null, entity: String(r.entity),
          entityId: typeof r.entity_id === 'string' ? r.entity_id : null,
          editedAt: typeof r.edited_at === 'string' ? r.edited_at : String(r.at),
          syncedAt: typeof r.synced_at === 'string' ? r.synced_at : null,
          cloudReceivedAt: typeof r.cloud_received_at === 'string' ? r.cloud_received_at : null,
          origin: typeof r.origin === 'string' ? r.origin : 'local', after: parse(r.after_json), refused: null as { detail: string } | null,
        })),
        ...refused.map((r) => ({
          id: `r${Number(r.id)}`, at: String(r.at), actor: typeof r.user_id === 'string' ? `user:${r.user_id}` : 'unknown',
          userName: typeof r.user_name === 'string' ? r.user_name : null, deviceId: typeof r.device_id === 'string' ? r.device_id : null,
          entity: 'finance:refused', entityId: null, editedAt: String(r.at), syncedAt: null, cloudReceivedAt: null, origin: 'refused',
          after: null as unknown, refused: { detail: String(r.detail) },
        })),
      ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
      return forward ? { entries: rows, next: fullPage ? lastChangeId : null } : { entries: rows.slice(0, limit) };
    });
  });
}
