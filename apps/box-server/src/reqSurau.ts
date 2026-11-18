import type { FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { LOCAL_SURAU_ID } from './tenant.ts';

/**
 * The surau a tenant route acts for (Plan 14 section 3.1): `request.tenant` is set by the authorisation hook before
 * the handler on every route whose table row says `tenant: 'required'`. A handler that asks for it on any other
 * route is a programming error, so this throws instead of guessing a surau.
 */
export function reqSurau(request: FastifyRequest): string {
  const tenant = request.tenant;
  if (tenant === null || tenant === undefined) throw new Error('no tenant on this route');
  return tenant.surauId;
}

/**
 * The suraus a timer serves each round: a box has its one local surau; the cloud serves every surau it has
 * (read at every round, so a surau made later is served at the next one).
 */
export function timerSurauIds(db: DatabaseSync, role: 'box' | 'cloud'): string[] {
  if (role !== 'cloud') return [LOCAL_SURAU_ID];
  return db.prepare('SELECT id FROM suraus ORDER BY id').all().map((r) => String(r.id));
}

/** A box id on the wire: 16 lower-case hex characters. */
const BOX_ID_RE = /^[0-9a-f]{16}$/;
/** A box id no site can have: the lookup of an absent or malformed header runs the same query. */
const NO_BOX = '0000000000000000';

/**
 * A surau id no tenant can have (the cloud's neutral answer): its settings are the defaults, so a public route
 * does the same work for it as for a real surau.
 */
export const NEUTRAL_SURAU_ID = '-';

/**
 * The surau a PUBLIC route (`/api/surau/info`, `/surau-logo`, `/api/health`, the web app's manifest and icons)
 * answers for. On a box: the local surau, unchanged. On the cloud (Plan 14 section 3.1): the surau of the LINKED
 * site named by the header `X-Maxcom-Box`; for no header, a malformed one, an unknown id or a revoked or unlinked
 * site, `null` (the neutral MAXCOM answer). The site lookup always runs, so the answer time does not tell which
 * of the cases it was.
 */
export function publicSurauOf(db: DatabaseSync, request: FastifyRequest, role: 'box' | 'cloud'): string | null {
  if (role !== 'cloud') return LOCAL_SURAU_ID;
  const raw = request.headers['x-maxcom-box'];
  const id = typeof raw === 'string' && BOX_ID_RE.test(raw) ? raw : NO_BOX;
  const row = db.prepare('SELECT surau_id FROM sites WHERE box_id = ? AND linked_at IS NOT NULL AND revoked_at IS NULL').get(id);
  return row !== undefined && typeof row.surau_id === 'string' && id !== NO_BOX ? row.surau_id : null;
}

export interface HealthScope {
  /** The surau whose facts the answer carries. */
  surauId: string;
  /** The Pentadbir MAXCOM on an ops device sees every site; a surau only its own. */
  all: boolean;
}

/** The authenticated `/api/health` of the cloud is scoped to the surau of the caller's device. */
export function healthScopeOf(db: DatabaseSync, request: FastifyRequest, role: 'box' | 'cloud'): HealthScope {
  if (role !== 'cloud') return { surauId: LOCAL_SURAU_ID, all: false };
  const a = request.auth;
  if (a === null || a === undefined || a.kind !== 'user') return { surauId: NEUTRAL_SURAU_ID, all: false };
  const dev = db.prepare('SELECT surau_id, ops FROM devices WHERE id = ?').get(a.deviceId);
  if (dev === undefined || typeof dev.surau_id !== 'string') return { surauId: NEUTRAL_SURAU_ID, all: false };
  if (dev.surau_id === '*') return { surauId: NEUTRAL_SURAU_ID, all: Number(dev.ops) === 1 && a.ops === true };
  return { surauId: dev.surau_id, all: false };
}
