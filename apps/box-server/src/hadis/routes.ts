import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HADIS_MAX_SAVED, attributionOf, gradeOf, hadisLength, providerItemId } from '@surau/core';
import type { Hadis, HadisGrade } from '@surau/core';
import { tx } from '../auth/users.ts';
import type { ChangeBus } from '../events.ts';
import { ContentError, countLive, getItem, listItems, putItemIn, putProviderItem, putProviderItemIn } from '../content/store.ts';
import { getVersion } from '../settingsStore.ts';
import { catalogStats, getHadith, itemsInCategory, listCategories, search, stateGet, stateSet, upsertHadith } from './catalog.ts';
import type { CatalogJob } from './catalogJob.ts';
import { HadeethEncError } from './hadeethenc.ts';
import type { HadeethEncClient, HeHadith } from './hadeethenc.ts';
import { createLimiter } from './limiter.ts';
import { buildProviderItem, gradeSavable } from './providerItem.ts';
import { parsePending } from './updates.ts';

export interface HadisRouteDeps {
  db: DatabaseSync;
  bus: ChangeBus;
  role: 'box' | 'cloud';
  /** The HadeethEnc client for the current `dataSources.hadeethenc` address (built over the guarded fetch). */
  client: () => HadeethEncClient;
  job: CatalogJob;
  actorOf: (request: FastifyRequest) => string;
  now: () => Date;
  /** One `change_log` line for an action that is not a content write (`hadis.refresh`). */
  logChange?: (actor: string, action: string, detail: string) => void;
  /** Test seam: the limiter's clock (default `Date.now`). */
  rateNow?: () => number;
}

const ID_RE = /^\d{1,8}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const JOB_RE = /^j\d{1,6}$/;
const ONLINE_MS = 60_000;
const STEP = 1000;
const MAX_ORDER = 1_000_000;
/** Browse, search, detail and add: about 20 a minute per user. Everything else (status, job polling) has a roomier cap. */
const HEAVY_PER_MIN = 20;
const LIGHT_PER_MIN = 120;
/** HadeethEnc is asked for at most this many hadis at the same moment. */
const MAX_PROVIDER_IN_FLIGHT = 2;

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const MSG = {
  gradeBlocked: 'Darjat tidak dibenarkan',
  gradeUnknown: 'Darjat tidak dikenali',
  tooLong: 'Teks terlalu panjang untuk MAXCOM',
  fieldTooLong: 'Maklumat sumber (rujukan atau darjat) terlalu panjang untuk MAXCOM',
  updateTooLong: 'Teks baharu terlalu panjang untuk MAXCOM; kemas kini ini dibuang dan teks yang tersimpan kekal',
  limit: 'Senarai hadis sudah penuh',
  offline: 'Carian perlukan internet',
  badSource: 'HadeethEnc memberi jawapan yang tidak dapat dibaca',
  tooMany: 'Terlalu banyak permintaan; cuba lagi sebentar',
  busy: 'Terlalu banyak permintaan ke HadeethEnc serentak; cuba lagi sebentar',
  orderStale: 'Senarai sudah berubah; muat semula senarai hadis dan cuba lagi',
} as const;

function send(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ errors: [message], code });
}

function sourceFailure(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof HadeethEncError) {
    return err.code === 'source_bad_response'
      ? send(reply, 502, 'source_bad_response', MSG.badSource)
      : send(reply, 503, 'source_unavailable', MSG.offline);
  }
  if (err instanceof RangeError) return send(reply, 400, 'invalid', 'invalid request');
  throw err;
}

function contentFailure(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ContentError) return reply.code(err.status).send({ errors: err.errors, code: 'invalid' });
  throw err;
}

/** `?name=value` as a single string, or undefined when absent or repeated. */
function queryString(request: FastifyRequest, name: string): string | undefined {
  const v = (request.query as Record<string, unknown> | undefined)?.[name];
  return typeof v === 'string' ? v : undefined;
}

function queryInt(request: FastifyRequest, name: string, def: number, min: number, max: number): number | null {
  const raw = queryString(request, name);
  if (raw === undefined) return def;
  if (!/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

interface Summary {
  id: string;
  title: string;
  grade: HadisGrade | null;
  gradeAr: string;
  attribution: { short: string; long: string | null } | null;
  attributionAr: string;
  length: 'short' | 'medium' | 'long';
  chars: number;
  allowed: boolean;
  saved: boolean;
}

function summarize(h: HeHadith, saved: ReadonlySet<string>): Summary {
  const grade = gradeOf(h.gradeAr);
  return {
    id: h.id,
    title: h.title,
    grade,
    gradeAr: h.gradeAr,
    attribution: attributionOf(h.attributionAr),
    attributionAr: h.attributionAr,
    length: hadisLength(h.textMs),
    chars: h.textMs.length,
    allowed: gradeSavable(grade),
    saved: saved.has(providerItemId('hadeethenc', h.id)),
  };
}

function savedIds(db: DatabaseSync): Set<string> {
  return new Set(listItems(db, 'hadis').filter((h) => h.ext !== undefined).map((h) => h.id));
}

/** Registers `/api/hadis/*`. Every route is permission-listed in `ROUTE_PERMISSIONS`; nothing here is public. */
export function registerHadisRoutes(app: FastifyInstance, deps: HadisRouteDeps): void {
  const { db, bus } = deps;
  // HadeethEnc is read through the box only: the cloud has no /api/hadis, so every path is 404 there.
  if (deps.role === 'cloud') return;

  const heavy = createLimiter({ max: HEAVY_PER_MIN, windowMs: 60_000, ...(deps.rateNow ? { now: deps.rateNow } : {}) });
  const light = createLimiter({ max: LIGHT_PER_MIN, windowMs: 60_000, ...(deps.rateNow ? { now: deps.rateNow } : {}) });
  const limit = (limiter: ReturnType<typeof createLimiter>) => async (request: FastifyRequest, reply: FastifyReply) => {
    const hit = limiter.hit(deps.actorOf(request));
    if (hit.ok) return undefined;
    reply.header('retry-after', String(hit.retryAfterSec));
    return send(reply, 429, 'rate_limited', MSG.tooMany);
  };
  const heavyOpts = { preHandler: limit(heavy) };
  const lightOpts = { preHandler: limit(light) };

  let inFlight = 0;
  /** Runs one request to HadeethEnc; null when two are already running (the caller answers 429 busy). */
  async function providerOne(id: string): Promise<{ h: HeHadith } | null> {
    if (inFlight >= MAX_PROVIDER_IN_FLIGHT) return null;
    inFlight++;
    try {
      return { h: await deps.client().one(id) };
    } finally {
      inFlight--;
    }
  }

  // ---- online probe: at most one request per 60 s, shared by concurrent callers
  let probeAt = -Infinity;
  let probeOk = false;
  let probing: Promise<boolean> | null = null;
  async function isOnline(): Promise<boolean> {
    const nowMs = deps.now().getTime();
    const last = stateGet(db, 'hadeethenc.lastOnline');
    if (last !== null && nowMs - Date.parse(last) < ONLINE_MS) return true;
    if (nowMs - probeAt < ONLINE_MS) return probeOk;
    if (probing === null) {
      probing = (async () => {
        let ok = false;
        try {
          ok = await deps.client().probe();
        } catch {
          ok = false;
        }
        probeAt = deps.now().getTime();
        probeOk = ok;
        if (ok) stateSet(db, 'hadeethenc.lastOnline', deps.now().toISOString());
        return ok;
      })().finally(() => {
        probing = null;
      });
    }
    return probing;
  }

  const pendingCount = (): number => Number(db.prepare('SELECT COUNT(*) AS n FROM hadis_source_updates').get()?.n ?? 0);

  app.get('/api/hadis/status', lightOpts, async () => ({
    online: await isOnline(),
    catalog: { ...catalogStats(db), job: deps.job.current(), lastJob: deps.job.last() },
    saved: countLive(db, 'hadis'),
    max: HADIS_MAX_SAVED,
    updates: pendingCount(),
  }));

  app.get('/api/hadis/categories', lightOpts, async () => ({
    categories: listCategories(db).map((c) => ({ id: c.id, parentId: c.parentId, titleMs: c.titleMs, titleEn: c.titleEn, count: c.count })),
  }));

  app.get('/api/hadis/categories/:id/items', heavyOpts, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ID_RE.test(id)) return send(reply, 400, 'invalid', 'invalid category');
    const page = queryInt(request, 'page', 1, 1, 50);
    const perPage = queryInt(request, 'perPage', 30, 10, 100);
    if (page === null || perPage === null) return send(reply, 400, 'invalid', 'invalid page');
    const r = itemsInCategory(db, id, page, perPage);
    const saved = savedIds(db);
    return { items: r.items.map((h) => summarize(h, saved)), total: r.total };
  });

  app.get('/api/hadis/search', heavyOpts, async (request, reply) => {
    const q = queryString(request, 'q')?.trim();
    if (q === undefined || q.length < 2 || q.length > 80) return send(reply, 400, 'invalid', 'q must be 2 to 80 characters');
    const saved = savedIds(db);
    return { items: search(db, q, 50).map((h) => summarize(h, saved)) };
  });

  app.get('/api/hadis/hadeethenc/:id', heavyOpts, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ID_RE.test(id)) return send(reply, 400, 'invalid', 'invalid id');
    let h = getHadith(db, id);
    if (h === null) {
      try {
        const got = await providerOne(id);
        if (got === null) return send(reply, 429, 'busy', MSG.busy);
        h = got.h;
      } catch (err) {
        return sourceFailure(reply, err);
      }
      try {
        upsertHadith(db, h, deps.now().toISOString());
      } catch {
        // the catalog is a convenience (it refuses a hadith over its field caps)
      }
    }
    const savedItemId = providerItemId('hadeethenc', id);
    const s = summarize(h, savedIds(db));
    const { digest: _digest, ...rest } = h;
    return {
      hadith: { ...rest, grade: s.grade, attribution: s.attribution, length: s.length, allowed: s.allowed, saved: s.saved, savedItemId: s.saved ? savedItemId : null },
    };
  });

  app.post('/api/hadis/add', { bodyLimit: 1024, ...heavyOpts }, async (request, reply) => {
    const body: unknown = request.body;
    if (!isPlain(body) || Object.keys(body).some((k) => k !== 'provider' && k !== 'id')) {
      return send(reply, 400, 'invalid', 'body must be {provider, id}');
    }
    if (body.provider !== 'hadeethenc' || typeof body.id !== 'string' || !ID_RE.test(body.id)) {
      return send(reply, 400, 'invalid', 'body must be {provider:"hadeethenc", id:<digits>}');
    }
    const id = body.id;
    const itemId = providerItemId('hadeethenc', id);
    const liveExisting = (): Hadis | null => {
      const e = getItem(db, 'hadis', itemId);
      return e !== null && e.ext?.provider === 'hadeethenc' ? e : null;
    };

    // Saved already: the same row, no request. Full: refused before any request.
    const already = liveExisting();
    if (already) return reply.code(200).send({ item: already });
    if (countLive(db, 'hadis') >= HADIS_MAX_SAVED) return send(reply, 409, 'limit_reached', MSG.limit);

    let h: HeHadith;
    try {
      const got = await providerOne(id);
      if (got === null) return send(reply, 429, 'busy', MSG.busy);
      h = got.h;
    } catch (err) {
      return sourceFailure(reply, err);
    }

    // The checks that matter run again here, in the same synchronous step as the write (the request above awaited).
    const again = liveExisting();
    if (again) return reply.code(200).send({ item: again });
    if (countLive(db, 'hadis') >= HADIS_MAX_SAVED) return send(reply, 409, 'limit_reached', MSG.limit);
    const at = deps.now().toISOString();
    const built = buildProviderItem(h, at);
    if (!built.ok) return send(reply, 400, built.error, built.error === 'field_too_long' ? MSG.fieldTooLong : MSG.tooLong);
    if (built.blocked) return send(reply, 400, 'grade_blocked', built.grade === null ? MSG.gradeUnknown : MSG.gradeBlocked);
    const order = Math.min(MAX_ORDER, listItems(db, 'hadis').reduce((m, x) => Math.max(m, x.order ?? 0), 0) + STEP);
    try {
      const result = putProviderItem(db, { ...built.item, order }, deps.actorOf(request));
      try {
        upsertHadith(db, h, at);
      } catch {
        // the catalog is a convenience
      }
      bus.emit(getVersion(db));
      return reply.code(result.created ? 201 : 200).send({ item: result.item });
    } catch (err) {
      return contentFailure(reply, err);
    }
  });

  app.put('/api/hadis/order', lightOpts, async (request, reply) => {
    const body: unknown = request.body;
    if (!isPlain(body) || Object.keys(body).some((k) => k !== 'ids') || !Array.isArray(body.ids)) {
      return send(reply, 400, 'invalid', 'body must be {ids:[...]}');
    }
    const ids = body.ids as unknown[];
    if (ids.length < 1 || ids.length > HADIS_MAX_SAVED || !ids.every((x): x is string => typeof x === 'string' && SAFE_ID.test(x)) ||
        new Set(ids).size !== ids.length) {
      return send(reply, 400, 'invalid', 'ids must be 1 to 500 distinct ids');
    }
    const order = ids as string[];
    const live = new Map(listItems(db, 'hadis').map((h) => [h.id, h]));
    // Every id must exist, and the list must be the whole set: a stale list would silently reshuffle what it leaves out.
    const unknown = order.find((id) => !live.has(id));
    if (unknown !== undefined) return send(reply, 400, 'invalid', `hadis ${unknown} not found`);
    if (order.length !== live.size) return send(reply, 409, 'order_stale', MSG.orderStale);
    let changed = 0;
    try {
      tx(db, () => {
        for (const [i, id] of order.entries()) {
          const item = live.get(id)!;
          const next = (i + 1) * STEP;
          if (item.order === next) continue;
          putItemIn(db, 'hadis', { ...item, order: next }, deps.actorOf(request));
          changed++;
        }
      });
    } catch (err) {
      return contentFailure(reply, err);
    }
    if (changed === 0) return { ok: true, count: order.length };
    bus.emit(getVersion(db));
    return { ok: true, count: order.length };
  });

  app.get('/api/hadis/updates', lightOpts, async () => {
    const rows = db.prepare('SELECT item_id, provider_id, new_json, found_at FROM hadis_source_updates ORDER BY found_at, item_id').all();
    const updates = [];
    for (const r of rows) {
      const item = getItem(db, 'hadis', String(r.item_id));
      const pending = parsePending(r.new_json);
      if (item === null || item.ext === undefined || pending === null) continue;
      const changed: string[] = [];
      if (pending.textMs !== item.textMs) changed.push('textMs');
      if (pending.textAr !== (item.textAr ?? '')) changed.push('textAr');
      if (pending.title !== (item.title ?? '')) changed.push('title');
      if ((pending.intro ?? '') !== (item.intro ?? '')) changed.push('intro');
      if (pending.attributionAr !== item.ext.attributionAr) changed.push('attribution');
      if (pending.gradeAr !== item.ext.gradeAr) changed.push('grade');
      updates.push({
        itemId: item.id,
        providerId: String(r.provider_id),
        foundAt: String(r.found_at),
        changed,
        preview: { title: pending.title, textMs: pending.textMs.slice(0, 600), textAr: pending.textAr.slice(0, 600), gradeAr: pending.gradeAr },
      });
    }
    return { updates };
  });

  app.post('/api/hadis/:id/accept-update', lightOpts, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!SAFE_ID.test(id)) return send(reply, 400, 'invalid', 'invalid id');
    const row = db.prepare('SELECT new_json FROM hadis_source_updates WHERE item_id = ?').get(id);
    if (row === undefined) return send(reply, 404, 'no_update', 'no pending update');
    const pending = parsePending(row.new_json);
    const item = getItem(db, 'hadis', id);
    if (item === null || item.ext?.provider !== 'hadeethenc') {
      db.prepare('DELETE FROM hadis_source_updates WHERE item_id = ?').run(id);
      return send(reply, 404, 'no_update', 'no pending update');
    }
    if (pending === null) return send(reply, 400, 'invalid', 'the pending update cannot be read');
    const h: HeHadith = {
      id: item.ext.id, title: pending.title, textMs: pending.textMs, introMs: pending.intro, textAr: pending.textAr, introAr: null,
      attributionAr: pending.attributionAr, gradeAr: pending.gradeAr, categories: pending.categories, digest: pending.digest,
    };
    const built = buildProviderItem(h, pending.fetchedAt, { ...(item.order !== undefined ? { order: item.order } : {}), ...(item.shown !== undefined ? { shown: item.shown } : {}) });
    if (!built.ok) {
      // the pending text can never be kept: drop it instead of leaving a row that fails for ever
      db.prepare('DELETE FROM hadis_source_updates WHERE item_id = ?').run(id);
      return send(reply, 400, built.error, built.error === 'field_too_long' ? MSG.fieldTooLong : MSG.updateTooLong);
    }
    try {
      const out = tx(db, () => {
        const r = putProviderItemIn(db, built.item, deps.actorOf(request));
        db.prepare('DELETE FROM hadis_source_updates WHERE item_id = ?').run(id);
        return r;
      });
      bus.emit(getVersion(db));
      return { item: out.item, gradeBlocked: built.blocked };
    } catch (err) {
      return contentFailure(reply, err);
    }
  });

  app.post('/api/hadis/refresh', lightOpts, async (request, reply) => {
    const started = deps.job.start();
    if (started === 'busy') return send(reply, 409, 'busy', 'another refresh is already running');
    deps.logChange?.(deps.actorOf(request), 'hadis.refresh', 'catalog');
    return reply.code(202).send({ jobId: started.id });
  });

  app.get('/api/hadis/jobs/:id', lightOpts, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!JOB_RE.test(id)) return send(reply, 400, 'invalid', 'invalid job');
    const job = deps.job.status(id);
    if (!job) return send(reply, 404, 'unknown_job', 'unknown job');
    const { error, ...rest } = job;
    return error === undefined ? rest : { ...rest, error };
  });
}
