import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isThemeName, KIOSK_TEMPLATE_IDS, THEME_CONTRACT } from '@surau/core';
import type { ChangeBus } from '../events.ts';
import { getSettings, getVersion } from '../settingsStore.ts';
import { themeSupportOf } from '../sync/sites.ts';
import { DEFAULT_SURAU_ID } from '../sync/verify.ts';
import { buildDownload, DownloadError } from './download.ts';
import { parseHealthBody, recordThemeHealth } from './health.ts';
import { issue, MAX_PACK_BYTES, PACK_MIME, ThemeError } from './packFormat.ts';
import type { ThemeStore } from './store.ts';
import { ThemeStoreError } from './store.ts';
import { emptyReport } from './validate.ts';

export interface ThemeRouteDeps {
  store: ThemeStore;
  bus: ChangeBus;
  db: import('node:sqlite').DatabaseSync;
  dataDir: string;
  role: 'box' | 'cloud';
  boxId: string;
  now: () => Date;
  /** The kiosk build folder (it holds builtin-themes/<id>/theme.json), or null when the box serves no page. */
  staticDir: string | null;
  actorOf: (request: FastifyRequest) => string;
  deviceOf: (request: FastifyRequest) => string | undefined;
}

/** The theme the surau has chosen for the display. */
function activeThemeName(db: import('node:sqlite').DatabaseSync): string | null {
  const k = getSettings(db).kioskTemplate as { enabled?: unknown; templateId?: unknown };
  return k.enabled !== false && typeof k.templateId === 'string' ? k.templateId : null;
}

/** The only files an extracted or staged pack serves, matched before any filesystem call. */
export const PACK_FILE_RE = /^(bundle\.css|images\/[a-z-]{1,12}\.(jpg|png))$/;
/** The address segment of an installed pack: the first 16 hex of its file's sha-256 and the bundle format (a new file, or a new format, is a new address). */
const HASH_RE = /^[0-9a-f]{16}-[1-9][0-9]{0,2}$/;
/** A display's health report: at most one a minute of each kind (passed, failed) per device. */
export const HEALTH_REPORT_GAP_MS = 60_000;
/** Routes only a box has: checking, installing, deleting and downloading a theme, and the display's health report. (The cloud still serves the installed files, for the away preview.) */
const CLOUD_ALLOWED = new Set(['/api/themes/support', '/api/sync/theme-support']);
const isBoxOnlyPath = (path: string): boolean =>
  ((path.startsWith('/api/themes/') || path === '/api/themes') && !CLOUD_ALLOWED.has(path)) || path === '/api/kiosk/theme-health';
/** The path of a raw request address, percent-decoded (only reached when no route matched). */
function rawPath(url: string): string {
  const path = url.split('?')[0]!;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}
const ID_RE = /^[0-9a-f]{32}$/;
const TYPES: Record<string, string> = { css: 'text/css; charset=utf-8', jpg: 'image/jpeg', png: 'image/png' };
const BODY_LIMIT = MAX_PACK_BYTES + 1024;

export interface SupportBox { boxId: string; name: string; contract: number | null; builtIn: string[] }
export const SUPPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Which theme contract each of the surau's boxes supports. On the cloud: what each box reported. On a box that is
 * not linked: itself. On a linked box: the list the cloud last sent (this box's own entry always live); it is
 * `complete` only while that list is younger than 24 hours.
 */
export function themeSupport(deps: Pick<ThemeRouteDeps, 'db' | 'role' | 'boxId' | 'now'>): { contract: number; builtIn: string[]; boxes: SupportBox[]; complete: boolean } {
  const builtIn = [...KIOSK_TEMPLATE_IDS] as string[];
  const base = { contract: THEME_CONTRACT, builtIn };
  if (deps.role === 'cloud') return { ...base, boxes: themeSupportOf(deps.db, DEFAULT_SURAU_ID), complete: true };
  const self: SupportBox = { boxId: deps.boxId, name: getSettings(deps.db).surauInfo.name, contract: THEME_CONTRACT, builtIn };
  const state = (k: string): string | null => {
    const r = deps.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(k);
    return typeof r?.value === 'string' ? r.value : null;
  };
  if (state('linked') !== '1') return { ...base, boxes: [self], complete: true };
  let cached: SupportBox[] = [];
  try {
    const parsed: unknown = JSON.parse(state('theme_support_json') ?? '[]');
    if (Array.isArray(parsed)) cached = parsed as SupportBox[];
  } catch {
    cached = [];
  }
  const at = Date.parse(state('theme_support_at') ?? '');
  const fresh = Number.isFinite(at) && deps.now().getTime() - at < SUPPORT_MAX_AGE_MS && deps.now().getTime() >= at - 60_000;
  const boxes = cached.some((b) => b.boxId === deps.boxId) ? cached.map((b) => (b.boxId === deps.boxId ? self : b)) : [...cached, self];
  return { ...base, boxes, complete: fresh };
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The file inside `dir` for a validated sub-path, or null (missing, or not a plain file). */
function fileIn(dir: string, sub: string): { path: string; type: string } | null {
  if (!PACK_FILE_RE.test(sub)) return null;
  const path = join(dir, ...sub.split('/'));
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null;
  } catch {
    return null;
  }
  return { path, type: TYPES[sub.slice(sub.lastIndexOf('.') + 1)]! };
}

function themeFailure(reply: FastifyReply, error: ThemeError): FastifyReply {
  const first = error.issues[0]!;
  const status = first.code === 'version_not_higher' ? 409 : first.code === 'storage_full' ? 413 : first.code === 'too_many_installs' ? 429 : 400;
  return reply.code(status).send({ code: first.code, errors: error.issues.map((i) => i.messageMs), issues: error.issues });
}

/**
 * /api/themes/* (settings:write) and /themes/<name>/<version>/* (kiosk:read, same origin, so the CSP never changes).
 * A refused pack answers 200 with the issues on `check`: the app shows them; nothing is stored.
 */
export function registerThemeRoutes(app: FastifyInstance, deps: ThemeRouteDeps): void {
  const { store, bus, db } = deps;
  const healthSeen = new Map<string, number>();

  const bump = (before: number): void => {
    const after = getVersion(db);
    if (after !== before) bus.emit(after);
  };

  void app.register(async (scope) => {
    // The cloud only stores and relays the pack files a surau synced; it never takes, checks, installs, serves or hands out a theme.
    scope.addHook('onRequest', async (request, reply) => {
      // The decision is made on the route the router matched (it decodes the address), never on the raw text a client wrote:
      // `/api/%74hemes/check` is the same route as `/api/themes/check`.
      if (deps.role === 'cloud' && isBoxOnlyPath(request.routeOptions.url ?? rawPath(request.url))) return reply.code(404).send({ errors: ['not found'] });
      return undefined;
    });

    scope.addContentTypeParser([PACK_MIME], { parseAs: 'buffer', bodyLimit: BODY_LIMIT }, (_request, body, done) => done(null, body));

    scope.setErrorHandler((error, request, reply) => {
      const e = error as { code?: string; statusCode?: number; message: string };
      if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE' && request.url.split('?')[0] === '/api/themes/check') {
        const i = issue('too_big', null, null, 'Fail tema melebihi 15 MB.', 'The theme file is larger than 15 MB.');
        return reply.code(413).send({ report: emptyReport([i]), stagedId: null });
      }
      return reply.code(e.statusCode ?? 500).send({ errors: [e.statusCode !== undefined && e.statusCode < 500 ? e.message : 'internal error'] });
    });

    scope.post('/api/themes/check', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
      const body: unknown = request.body;
      const type = (request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (!Buffer.isBuffer(body) || type !== PACK_MIME) {
        return reply.code(415).send({ errors: [`body must be the raw .maxtheme file with Content-Type ${PACK_MIME}`] });
      }
      try {
        const result = await store.stage(body);
        return reply.header('Cache-Control', 'no-store').send(result);
      } catch (error) {
        if (error instanceof ThemeError) return themeFailure(reply, error);
        throw error;
      }
    });

    scope.post('/api/themes/install', async (request, reply) => {
      const body: unknown = request.body;
      const stagedId = isPlain(body) ? body.stagedId : undefined;
      if (typeof stagedId !== 'string' || !ID_RE.test(stagedId)) return reply.code(400).send({ errors: ['stagedId must be the id from the check'] });
      const before = getVersion(db);
      try {
        const p = await store.install(stagedId, deps.actorOf(request), deps.deviceOf(request));
        bump(before);
        return reply.code(201).send({ name: p.name, version: p.version, title: p.title });
      } catch (error) {
        if (error instanceof ThemeStoreError && error.code === 'gone') {
          return reply.code(410).send({ code: 'gone', errors: ['Semakan sudah tamat tempoh. Semak fail sekali lagi.'] });
        }
        if (error instanceof ThemeError) return themeFailure(reply, error);
        throw error;
      }
    });

    scope.get('/api/themes/support', async (_request, reply) => reply.header('Cache-Control', 'no-store').send(themeSupport(deps)));

    // A linked box asks the cloud which contract its sibling boxes support. Only a site token has this route.
    scope.get('/api/sync/theme-support', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (deps.role !== 'cloud' || request.auth?.kind !== 'site') return reply.code(404).send({ errors: ['not found'] });
      return { boxes: themeSupportOf(deps.db, request.auth.surauId) };
    });

    // What a display saw when it loaded an uploaded theme (the health check). A bad body is 400; a report for a theme or
    // version that is not installed is dropped without error (the display may be a version behind).
    scope.post('/api/kiosk/theme-health', async (request, reply) => {
      const report = parseHealthBody(request.body);
      if (report === null) return reply.code(400).send({ errors: ['not a theme health report'] });
      // Only the theme this box shows now has a state to report; any other report is dropped without a word.
      if (activeThemeName(db) !== report.theme) return reply.code(204).send();
      // At most one report of each kind a minute from one display: a display that is not behaving cannot flip the box's state.
      const nowMs = deps.now().getTime();
      const key = `${deps.deviceOf(request) ?? request.ip}|${report.ok ? 'ok' : 'bad'}`;
      for (const [k, at] of healthSeen) if (nowMs - at >= HEALTH_REPORT_GAP_MS || at > nowMs) healthSeen.delete(k);
      if (healthSeen.has(key)) return reply.code(429).header('Retry-After', '60').send({ errors: ['too many reports'] });
      healthSeen.set(key, nowMs);
      recordThemeHealth(db, report, deps.now(), deps.deviceOf(request) ?? request.ip);
      return reply.code(204).send();
    });

    // The theme as one .maxtheme: a built-in as a starting pack (a name is needed), an uploaded theme as it is or with the menu values baked in.
    scope.get('/api/themes/:name/pack', async (request, reply) => {
      const { name } = request.params as { name: string };
      const q = request.query as { bake?: unknown; as?: unknown };
      if (q.bake !== undefined && q.bake !== '1' && q.bake !== '0') return reply.code(400).send({ errors: ['bake must be 1 or 0'] });
      if (q.as !== undefined && (typeof q.as !== 'string' || q.as.length > 64)) return reply.code(400).send({ errors: ['as must be a theme name'] });
      if (!isThemeName(name)) return reply.code(404).send({ errors: ['not found'] });
      try {
        const out = buildDownload({ db, dataDir: deps.dataDir, staticDir: deps.staticDir }, name, { bake: q.bake !== '0', ...(q.as !== undefined ? { as: q.as } : {}) });
        return reply
          .header('Content-Type', PACK_MIME)
          .header('Content-Disposition', `attachment; filename="${out.fileName}"`)
          .header('Cache-Control', 'no-store')
          .header('X-Content-Type-Options', 'nosniff')
          .send(out.data);
      } catch (error) {
        if (error instanceof DownloadError) return reply.code(error.status).send({ errors: error.errors });
        throw error;
      }
    });

    scope.delete('/api/themes/:name', async (request, reply) => {
      const { name } = request.params as { name: string };
      if (!isThemeName(name) && !/^[A-Za-z0-9-]{1,64}$/.test(name)) return reply.code(404).send({ errors: ['not found'] });
      const before = getVersion(db);
      try {
        store.remove(name, deps.actorOf(request), deps.deviceOf(request));
        bump(before);
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof ThemeStoreError) {
          if (error.code === 'in_use') return reply.code(409).send({ code: 'in_use', errors: ['Tema ini sedang digunakan. Pilih tema lain dahulu.'] });
          if (error.code === 'built_in') return reply.code(400).send({ code: 'built_in', errors: ['Tema bawaan MAXCOM tidak boleh dipadam.'] });
          return reply.code(404).send({ code: 'not_found', errors: ['not found'] });
        }
        throw error;
      }
    });

    // Fixed shapes, no wildcard: bundle.css and images/<file>; the file part is matched again by PACK_FILE_RE.
    const SHAPES = ['bundle.css', 'images/:file'];
    const subOf = (shape: string, params: Record<string, string | undefined>): string => (shape === 'bundle.css' ? shape : `${shape.split('/')[0]}/${params.file ?? ''}`);

    for (const shape of SHAPES) {
      scope.get(`/api/themes/staged/:id/${shape}`, async (request, reply) => {
        const params = request.params as Record<string, string | undefined>;
        const id = params.id ?? '';
        if (!ID_RE.test(id)) return reply.code(404).send({ errors: ['not found'] });
        const dir = store.stagedDir(id);
        const file = dir === null ? null : fileIn(dir, subOf(shape, params));
        if (file === null) return reply.code(404).send({ errors: ['not found'] });
        return reply
          .header('Content-Type', file.type)
          .header('Cache-Control', 'no-store')
          .header('X-Content-Type-Options', 'nosniff')
          .send(createReadStream(file.path));
      });

      scope.get(`/themes/:name/:hash/${shape}`, async (request, reply) => {
        const params = request.params as Record<string, string | undefined>;
        const name = params.name ?? '';
        const hash = params.hash ?? '';
        if (!isThemeName(name) || !HASH_RE.test(hash)) return reply.code(404).send({ errors: ['not found'] });
        const found = await store.ensureExtracted(name);
        // Only the installed file is served; an older address answers 404 (a kiosk keeps its own cached copy).
        if (found === null || found.hash !== hash) return reply.code(404).send({ errors: ['not found'] });
        const file = fileIn(found.dir, subOf(shape, params));
        if (file === null) return reply.code(404).send({ errors: ['not found'] });
        return reply
          .header('Content-Type', file.type)
          .header('Cache-Control', 'private, max-age=31536000, immutable')
          .header('X-Content-Type-Options', 'nosniff')
          .send(createReadStream(file.path));
      });
    }
  });
}
