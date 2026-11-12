import { timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { KIOSK_PERMISSIONS, can } from '@surau/core';
import type { Permission } from '@surau/core';
import { createRateLimiter } from './ratelimit.ts';
import type { RateLimiter } from './ratelimit.ts';
import { authLog, deviceRevokedForToken, resolveSession, resolveSite } from './sessions.ts';
import type { AuthContext, SiteAuth } from './sessions.ts';
import { MSG } from './users.ts';

export type { AuthContext, SiteAuth };

/** The read-only identity of the kiosk display (loopback today; the pairing cookie from Task 6). */
export interface KioskAuth {
  kind: 'kiosk';
  deviceId: string | null;
  via: 'loopback' | 'cookie';
}

export type AuthIdentity = AuthContext | KioskAuth | SiteAuth;

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthIdentity | null;
  }
  interface FastifyInstance {
    /** Internals for in-process tests and main.ts (purge timer); not exposed over HTTP. */
    surau: { db: DatabaseSync; boxId: string; limiters: Limiters; setAllowedHosts: (hosts: string[]) => void };
    /** The per-start kiosk token (64 hex as bytes) when SURAU_KIOSK_TOKEN is set, else null. Never sent or logged. */
    kioskToken: Buffer | null;
  }
}

/**
 * `public`: anyone. `session`: any signed-in user (not the kiosk, not a site). `session_or_site`: a signed-in
 * user or a linked site (a site passes only on the paths `siteMayCall` allows). Otherwise a core permission.
 */
export type RoutePermission = Permission | 'public' | 'session' | 'session_or_site';

export interface RouteRule {
  method: 'GET' | 'PUT' | 'POST' | 'DELETE';
  /** Matched against the normalised path (lower case, no query, no trailing slash). */
  pattern: RegExp;
  permission: RoutePermission;
  /** A concrete path that matches the pattern (used by the role-matrix test). */
  sample: string;
}

export const ROUTE_PERMISSIONS: readonly RouteRule[] = [
  { method: 'POST', pattern: /^\/api\/enrol\/complete$/, permission: 'public', sample: '/api/enrol/complete' },
  { method: 'POST', pattern: /^\/api\/auth\/challenge$/, permission: 'public', sample: '/api/auth/challenge' },
  { method: 'POST', pattern: /^\/api\/auth\/unlock$/, permission: 'public', sample: '/api/auth/unlock' },
  { method: 'POST', pattern: /^\/api\/kiosk\/pair\/begin$/, permission: 'public', sample: '/api/kiosk/pair/begin' },
  { method: 'POST', pattern: /^\/api\/kiosk\/pair\/poll$/, permission: 'public', sample: '/api/kiosk/pair/poll' },
  { method: 'GET', pattern: /^\/api\/pki\/root\.cer$/, permission: 'public', sample: '/api/pki/root.cer' },
  { method: 'GET', pattern: /^\/api\/health$/, permission: 'public', sample: '/api/health' },
  { method: 'GET', pattern: /^\/api\/surau\/info$/, permission: 'public', sample: '/api/surau/info' },
  { method: 'GET', pattern: /^\/api\/box\/info$/, permission: 'public', sample: '/api/box/info' },
  { method: 'POST', pattern: /^\/api\/setup\/complete$/, permission: 'public', sample: '/api/setup/complete' },
  { method: 'POST', pattern: /^\/api\/setup\/probe$/, permission: 'public', sample: '/api/setup/probe' },
  { method: 'POST', pattern: /^\/api\/recovery\/complete$/, permission: 'public', sample: '/api/recovery/complete' },
  { method: 'GET', pattern: /^\/surau-logo$/, permission: 'public', sample: '/surau-logo' },

  { method: 'GET', pattern: /^\/api\/kiosk\/bundle$/, permission: 'kiosk:read', sample: '/api/kiosk/bundle' },
  { method: 'GET', pattern: /^\/api\/kiosk\/events$/, permission: 'kiosk:read', sample: '/api/kiosk/events' },
  { method: 'GET', pattern: /^\/api\/kiosk\/content$/, permission: 'kiosk:read', sample: '/api/kiosk/content' },
  { method: 'GET', pattern: /^\/api\/kiosk\/live$/, permission: 'kiosk:read', sample: '/api/kiosk/live' },
  { method: 'GET', pattern: /^\/api\/box\/state$/, permission: 'kiosk:read', sample: '/api/box/state' },
  { method: 'GET', pattern: /^\/api\/box\/netcheck$/, permission: 'kiosk:read', sample: '/api/box/netcheck' },
  { method: 'GET', pattern: /^\/api\/kiosk\/cloud$/, permission: 'kiosk:read', sample: '/api/kiosk/cloud' },
  { method: 'POST', pattern: /^\/api\/kiosk\/live\/whep$/, permission: 'kiosk:read', sample: '/api/kiosk/live/whep' },
  { method: 'DELETE', pattern: /^\/api\/kiosk\/live\/whep\/[^/]+$/, permission: 'kiosk:read', sample: '/api/kiosk/live/whep/x' },
  { method: 'GET', pattern: /^\/assets\/[^/.]+$/, permission: 'kiosk:read', sample: `/assets/${'a'.repeat(64)}` },
  { method: 'GET', pattern: /^\/islamic\/audio\/.+$/, permission: 'kiosk:read', sample: '/islamic/audio/x/001/001.mp3' },

  { method: 'GET', pattern: /^\/api\/settings$/, permission: 'settings:read', sample: '/api/settings' },
  { method: 'PUT', pattern: /^\/api\/settings\/[^/]+$/, permission: 'settings:write', sample: '/api/settings/clock' },
  { method: 'PUT', pattern: /^\/api\/box\/name$/, permission: 'settings:write', sample: '/api/box/name' },
  { method: 'POST', pattern: /^\/api\/settings\/test-source$/, permission: 'system:write', sample: '/api/settings/test-source' },
  { method: 'POST', pattern: /^\/api\/prayer\/import$/, permission: 'prayer:import', sample: '/api/prayer/import' },

  // Plan 13: prayer sources. Reads are settings:read (every role); writes that change prayer data are prayer:import.
  { method: 'GET', pattern: /^\/api\/prayer\/days$/, permission: 'settings:read', sample: '/api/prayer/days' },
  { method: 'GET', pattern: /^\/api\/prayer\/status$/, permission: 'settings:read', sample: '/api/prayer/status' },
  { method: 'GET', pattern: /^\/api\/prayer\/zones$/, permission: 'settings:read', sample: '/api/prayer/zones' },
  { method: 'POST', pattern: /^\/api\/location\/search$/, permission: 'settings:write', sample: '/api/location/search' },
  { method: 'POST', pattern: /^\/api\/prayer\/zones\/refresh$/, permission: 'settings:write', sample: '/api/prayer/zones/refresh' },
  { method: 'GET', pattern: /^\/api\/prayer\/imports$/, permission: 'settings:read', sample: '/api/prayer/imports' },
  { method: 'GET', pattern: /^\/api\/prayer\/imports\/[^/]+$/, permission: 'settings:read', sample: '/api/prayer/imports/x' },
  { method: 'GET', pattern: /^\/api\/prayer\/template\.csv$/, permission: 'settings:read', sample: '/api/prayer/template.csv' },
  { method: 'GET', pattern: /^\/api\/prayer\/template\.xlsx$/, permission: 'settings:read', sample: '/api/prayer/template.xlsx' },
  { method: 'POST', pattern: /^\/api\/prayer\/import\/file$/, permission: 'prayer:import', sample: '/api/prayer/import/file' },
  { method: 'POST', pattern: /^\/api\/prayer\/imports\/[^/]+\/undo$/, permission: 'prayer:import', sample: '/api/prayer/imports/x/undo' },
  { method: 'GET', pattern: /^\/api\/prayer\/countries$/, permission: 'settings:read', sample: '/api/prayer/countries' },
  { method: 'GET', pattern: /^\/api\/prayer\/timezone$/, permission: 'settings:read', sample: '/api/prayer/timezone' },
  { method: 'GET', pattern: /^\/api\/prayer\/calc\/preview$/, permission: 'settings:read', sample: '/api/prayer/calc/preview' },
  { method: 'PUT', pattern: /^\/api\/prayer\/corrections\/[^/]+\/[^/]+$/, permission: 'prayer:import', sample: '/api/prayer/corrections/2026-11-26/asar' },
  { method: 'DELETE', pattern: /^\/api\/prayer\/corrections\/[^/]+\/[^/]+$/, permission: 'prayer:import', sample: '/api/prayer/corrections/2026-11-26/asar' },

  { method: 'GET', pattern: /^\/api\/content\/.+$/, permission: 'content:read', sample: '/api/content/announcements' },
  { method: 'PUT', pattern: /^\/api\/content\/.+$/, permission: 'content:write', sample: '/api/content/announcements/x' },
  { method: 'DELETE', pattern: /^\/api\/content\/.+$/, permission: 'content:write', sample: '/api/content/announcements/x' },
  { method: 'POST', pattern: /^\/api\/assets$/, permission: 'assets:write', sample: '/api/assets' },
  { method: 'GET', pattern: /^\/api\/assets$/, permission: 'assets:write', sample: '/api/assets' },
  { method: 'GET', pattern: /^\/api\/assets\/[0-9a-f]{64}\/analyze$/, permission: 'assets:write', sample: `/api/assets/${'a'.repeat(64)}/analyze` },

  { method: 'POST', pattern: /^\/api\/islamic\/fetch$/, permission: 'islamic:fetch', sample: '/api/islamic/fetch' },
  { method: 'GET', pattern: /^\/api\/islamic\/.+$/, permission: 'settings:read', sample: '/api/islamic/status' },

  { method: 'GET', pattern: /^\/api\/hadis\/status$/, permission: 'content:read', sample: '/api/hadis/status' },
  { method: 'GET', pattern: /^\/api\/hadis\/jobs\/[^/]+$/, permission: 'content:read', sample: '/api/hadis/jobs/j1' },
  { method: 'POST', pattern: /^\/api\/hadis\/refresh$/, permission: 'islamic:fetch', sample: '/api/hadis/refresh' },
  { method: 'GET', pattern: /^\/api\/hadis\/search$/, permission: 'content:write', sample: '/api/hadis/search' },
  { method: 'GET', pattern: /^\/api\/hadis\/categories(?:\/[^/]+\/items)?$/, permission: 'content:write', sample: '/api/hadis/categories/1/items' },
  { method: 'GET', pattern: /^\/api\/hadis\/hadeethenc\/[^/]+$/, permission: 'content:write', sample: '/api/hadis/hadeethenc/66512' },
  { method: 'POST', pattern: /^\/api\/hadis\/add$/, permission: 'content:write', sample: '/api/hadis/add' },
  { method: 'PUT', pattern: /^\/api\/hadis\/order$/, permission: 'content:write', sample: '/api/hadis/order' },
  { method: 'GET', pattern: /^\/api\/hadis\/updates$/, permission: 'content:write', sample: '/api/hadis/updates' },
  { method: 'POST', pattern: /^\/api\/hadis\/[^/]+\/accept-update$/, permission: 'content:write', sample: '/api/hadis/x/accept-update' },

  { method: 'POST', pattern: /^\/api\/enrol\/begin$/, permission: 'users:manage', sample: '/api/enrol/begin' },
  { method: 'GET', pattern: /^\/api\/enrol\/recent$/, permission: 'users:manage', sample: '/api/enrol/recent' },
  { method: 'POST', pattern: /^\/api\/recovery\/code$/, permission: 'users:manage', sample: '/api/recovery/code' },
  { method: 'GET', pattern: /^\/api\/recovery\/status$/, permission: 'users:manage', sample: '/api/recovery/status' },
  { method: 'GET', pattern: /^\/api\/users$/, permission: 'users:manage', sample: '/api/users' },
  { method: 'POST', pattern: /^\/api\/users$/, permission: 'users:manage', sample: '/api/users' },
  { method: 'PUT', pattern: /^\/api\/users\/[^/]+\/roles$/, permission: 'users:manage', sample: '/api/users/none/roles' },
  { method: 'PUT', pattern: /^\/api\/users\/[^/]+\/pin$/, permission: 'users:manage', sample: '/api/users/none/pin' },
  { method: 'POST', pattern: /^\/api\/users\/[^/]+\/deactivate$/, permission: 'users:manage', sample: '/api/users/none/deactivate' },

  { method: 'GET', pattern: /^\/api\/devices$/, permission: 'devices:manage', sample: '/api/devices' },
  { method: 'POST', pattern: /^\/api\/devices\/[^/]+\/revoke$/, permission: 'devices:manage', sample: '/api/devices/none/revoke' },
  { method: 'POST', pattern: /^\/api\/kiosk\/pair\/approve$/, permission: 'devices:manage', sample: '/api/kiosk/pair/approve' },
  { method: 'GET', pattern: /^\/api\/kiosk\/pair\/pending$/, permission: 'devices:manage', sample: '/api/kiosk/pair/pending' },

  { method: 'GET', pattern: /^\/api\/pki\/status$/, permission: 'devices:manage', sample: '/api/pki/status' },
  { method: 'GET', pattern: /^\/api\/audit$/, permission: 'audit:read', sample: '/api/audit' },
  { method: 'GET', pattern: /^\/api\/finance\/report\/[^/]+\.pdf$/, permission: 'finance:write', sample: '/api/finance/report/2026-10.pdf' },
  { method: 'GET', pattern: /^\/api\/finance\/report\/[^/.]+$/, permission: 'finance:read', sample: '/api/finance/report/2026-10' },
  { method: 'POST', pattern: /^\/api\/finance\/report\/[^/.]+\/shared$/, permission: 'finance:write', sample: '/api/finance/report/2026-10/shared' },

  // Plan 7: finance. Reads are finance:read (AJK sees entries but never a photo); every write and every photo,
  // PDF and audit route is finance:write. Lookups and month states are the Pentadbir's (settings:write), and the
  // store also requires finance:write on the caller so a role holding only settings:write cannot touch money.
  { method: 'GET', pattern: /^\/api\/finance\/summary$/, permission: 'finance:read', sample: '/api/finance/summary' },
  { method: 'GET', pattern: /^\/api\/finance\/entries$/, permission: 'finance:read', sample: '/api/finance/entries' },
  { method: 'GET', pattern: /^\/api\/finance\/entries\/[^/]+$/, permission: 'finance:read', sample: '/api/finance/entries/x' },
  { method: 'PUT', pattern: /^\/api\/finance\/entries\/[^/]+$/, permission: 'finance:write', sample: '/api/finance/entries/x' },
  { method: 'GET', pattern: /^\/api\/finance\/funds$/, permission: 'finance:read', sample: '/api/finance/funds' },
  { method: 'PUT', pattern: /^\/api\/finance\/funds\/[^/]+$/, permission: 'settings:write', sample: '/api/finance/funds/x' },
  { method: 'GET', pattern: /^\/api\/finance\/perihal$/, permission: 'finance:read', sample: '/api/finance/perihal' },
  { method: 'PUT', pattern: /^\/api\/finance\/perihal\/[^/]+$/, permission: 'settings:write', sample: '/api/finance/perihal/x' },
  { method: 'GET', pattern: /^\/api\/finance\/months$/, permission: 'finance:read', sample: '/api/finance/months' },
  { method: 'PUT', pattern: /^\/api\/finance\/months\/[^/]+$/, permission: 'settings:write', sample: '/api/finance/months/2026-10' },
  { method: 'POST', pattern: /^\/api\/finance\/photos$/, permission: 'finance:write', sample: '/api/finance/photos' },
  { method: 'GET', pattern: /^\/api\/finance\/photos\/[^/]+$/, permission: 'finance:write', sample: `/api/finance/photos/${'a'.repeat(64)}` },
  { method: 'GET', pattern: /^\/api\/finance\/audit$/, permission: 'finance:write', sample: '/api/finance/audit' },

  { method: 'POST', pattern: /^\/api\/live\/start$/, permission: 'live:control', sample: '/api/live/start' },
  { method: 'POST', pattern: /^\/api\/live\/stop$/, permission: 'live:control', sample: '/api/live/stop' },
  { method: 'GET', pattern: /^\/api\/live\/status$/, permission: 'live:control', sample: '/api/live/status' },
  { method: 'POST', pattern: /^\/api\/live\/whip$/, permission: 'live:control', sample: '/api/live/whip' },
  { method: 'DELETE', pattern: /^\/api\/live\/whip\/[^/]+$/, permission: 'live:control', sample: '/api/live/whip/x' },
  { method: 'GET', pattern: /^\/api\/live\/youtube\/ingest$/, permission: 'live:control', sample: '/api/live/youtube/ingest' },
  { method: 'GET', pattern: /^\/api\/live\/youtube\/status$/, permission: 'live:control', sample: '/api/live/youtube/status' },
  { method: 'POST', pattern: /^\/api\/live\/youtube\/signin$/, permission: 'settings:write', sample: '/api/live/youtube/signin' },
  { method: 'POST', pattern: /^\/api\/live\/youtube\/signin\/poll$/, permission: 'settings:write', sample: '/api/live/youtube/signin/poll' },
  { method: 'POST', pattern: /^\/api\/live\/youtube\/signout$/, permission: 'settings:write', sample: '/api/live/youtube/signout' },

  { method: 'POST', pattern: /^\/api\/cloud\/youtube\/broadcast$/, permission: 'session_or_site', sample: '/api/cloud/youtube/broadcast' },
  { method: 'POST', pattern: /^\/api\/cloud\/youtube\/complete$/, permission: 'session_or_site', sample: '/api/cloud/youtube/complete' },
  { method: 'GET', pattern: /^\/api\/cloud\/youtube\/status$/, permission: 'session_or_site', sample: '/api/cloud/youtube/status' },
  { method: 'POST', pattern: /^\/api\/youtube\/upload\/begin$/, permission: 'live:control', sample: '/api/youtube/upload/begin' },
  { method: 'POST', pattern: /^\/api\/youtube\/upload\/done$/, permission: 'live:control', sample: '/api/youtube/upload/done' },
  { method: 'POST', pattern: /^\/api\/youtube\/verify$/, permission: 'live:control', sample: '/api/youtube/verify' },
  { method: 'GET', pattern: /^\/api\/youtube\/quota$/, permission: 'live:control', sample: '/api/youtube/quota' },

  { method: 'POST', pattern: /^\/api\/sync\/ops$/, permission: 'session_or_site', sample: '/api/sync/ops' },
  { method: 'GET', pattern: /^\/api\/sync\/snapshot$/, permission: 'session_or_site', sample: '/api/sync/snapshot' },
  { method: 'GET', pattern: /^\/api\/sync\/changes$/, permission: 'session_or_site', sample: '/api/sync/changes' },
  { method: 'POST', pattern: /^\/api\/sync\/link$/, permission: 'public', sample: '/api/sync/link' },
  { method: 'POST', pattern: /^\/api\/sync\/claim$/, permission: 'public', sample: '/api/sync/claim' },
  { method: 'GET', pattern: /^\/api\/sync\/status$/, permission: 'health:read', sample: '/api/sync/status' },
  { method: 'POST', pattern: /^\/api\/sync\/run$/, permission: 'settings:write', sample: '/api/sync/run' },
  { method: 'PUT', pattern: /^\/api\/sync\/assets\/[^/]+$/, permission: 'session_or_site', sample: '/api/sync/assets/x' },
  { method: 'PUT', pattern: /^\/api\/sync\/finance-photos\/[^/]+$/, permission: 'finance:write', sample: '/api/sync/finance-photos/x' },
  { method: 'GET', pattern: /^\/api\/sync\/finance-photos\/[^/]+$/, permission: 'finance:write', sample: '/api/sync/finance-photos/x' },

  { method: 'GET', pattern: /^\/api\/auth\/me$/, permission: 'session', sample: '/api/auth/me' },
  { method: 'POST', pattern: /^\/api\/auth\/logout$/, permission: 'session', sample: '/api/auth/logout' },
  { method: 'POST', pattern: /^\/api\/auth\/leave$/, permission: 'session', sample: '/api/auth/leave' },
  { method: 'PUT', pattern: /^\/api\/auth\/pin$/, permission: 'session', sample: '/api/auth/pin' },
];

/**
 * Canonical form used for permission matching: query/fragment dropped, percent-decoded once (as
 * the router does), backslashes read as slashes, duplicate slashes collapsed, `.`/`..` resolved,
 * trailing slash removed, lower-cased. Returns null for anything malformed (treated as deny).
 */
export function normalisePath(rawUrl: string): string | null {
  const cut = rawUrl.search(/[?#]/);
  const raw = cut < 0 ? rawUrl : rawUrl.slice(0, cut);
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const out: string[] = [];
  for (const seg of decoded.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/').toLowerCase();
}

export type Classification =
  | { kind: 'rule'; permission: RoutePermission }
  /** Static kiosk page file (non-API GET). */
  | { kind: 'static' }
  /** In the protected space but not listed: refused. */
  | { kind: 'unlisted' };

function inProtectedSpace(path: string): boolean {
  if (path === '/api' || path.startsWith('/api/')) return true;
  if (path === '/islamic' || path.startsWith('/islamic/')) return true;
  if (path === '/assets') return true;
  if (path.startsWith('/assets/')) {
    // Built page files (hashed, with an extension) are public; asset-store ids have no dot.
    const last = path.slice(path.lastIndexOf('/') + 1);
    return !last.includes('.');
  }
  return false;
}

/**
 * True when the RAW request path (before any decoding) hides a path separator or a dot behind a
 * percent escape (%2f, %5c, %2e in any case), or has a literal `..` segment. Such a URL is
 * refused outright: the classifier decodes and resolves paths, the router may not, and a request
 * the two read differently must never reach a handler. Query and fragment are not part of the path.
 */
export function hasAmbiguousPath(rawUrl: string): boolean {
  const cut = rawUrl.search(/[?#]/);
  const raw = cut < 0 ? rawUrl : rawUrl.slice(0, cut);
  if (/%(2f|5c|2e)/i.test(raw)) return true;
  return raw.split(/[/\\]/).some((seg) => seg === '..' || seg === '.');
}

export function classifyRequest(method: string, rawUrl: string): Classification {
  const path = normalisePath(rawUrl);
  if (path === null) return { kind: 'unlisted' };
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  for (const rule of ROUTE_PERMISSIONS) {
    if (rule.method === m && rule.pattern.test(path)) return { kind: 'rule', permission: rule.permission };
  }
  if (inProtectedSpace(path)) return { kind: 'unlisted' };
  if (m === 'GET') return { kind: 'static' };
  return { kind: 'unlisted' };
}

const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'via', 'cf-ray', 'cf-connecting-ip'];
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * The local-kiosk rule: a plain-HTTP request from the loopback interface itself, with no proxy
 * headers and not a cross-site browser request, is the box's own kiosk display. It gets ONLY
 * `kiosk:read`; writes are never granted by loopback alone.
 */
export const KIOSK_TOKEN_COOKIE = 'mxk';

/**
 * Reads SURAU_KIOSK_TOKEN once at start: unset or empty means no token (loopback alone is the
 * kiosk, as on Windows); anything set must be exactly 64 hex characters or the start fails.
 * The error never contains the value.
 */
export function parseKioskToken(value: string | undefined): Buffer | null {
  if (value === undefined || value === '') return null;
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error('SURAU_KIOSK_TOKEN must be exactly 64 hexadecimal characters');
  return Buffer.from(value.toLowerCase(), 'utf8');
}

function cookieValue(header: string | string[] | undefined, name: string): string | null {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/**
 * The token rule: true when the box was started without a kiosk token, otherwise only when the
 * request carries the cookie `mxk` equal to it (constant-time compare on equal-length buffers).
 */
export function kioskTokenAccepts(request: FastifyRequest): boolean {
  const token = request.server.kioskToken;
  if (token === null || token === undefined) return true;
  const given = cookieValue(request.headers.cookie, KIOSK_TOKEN_COOKIE);
  if (given === null || given.length !== token.length) return false;
  const buf = Buffer.from(given.toLowerCase(), 'utf8');
  return buf.length === token.length && timingSafeEqual(buf, token);
}

export function isLoopbackKiosk(request: FastifyRequest): boolean {
  const socket = request.raw.socket as { remoteAddress?: string; encrypted?: boolean };
  if (socket.encrypted === true) return false;
  if (typeof socket.remoteAddress !== 'string' || !LOOPBACK_ADDRS.has(socket.remoteAddress)) return false;
  for (const h of PROXY_HEADERS) if (request.headers[h] !== undefined) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  return kioskTokenAccepts(request);
}

/**
 * The only requests a linked site (the box talking to the cloud) may make: `/api/sync/*`,
 * `/api/cloud/youtube/*` and `GET /assets/:id`. Everything else is 403 to a site token, whatever the
 * route's own permission says.
 */
export function siteMayCall(method: string, rawUrl: string): boolean {
  const path = normalisePath(rawUrl);
  if (path === null) return false;
  if (path.startsWith('/api/sync/') || path.startsWith('/api/cloud/youtube/')) return true;
  const m = method.toUpperCase();
  return (m === 'GET' || m === 'HEAD') && /^\/assets\/[^/.]+$/.test(path);
}

/** Permissions an identity holds. A site holds none of them: its reach is `siteMayCall`, applied by the hook. */
export function identityCan(identity: AuthIdentity | null, permission: RoutePermission): boolean {
  if (permission === 'public') return true;
  if (identity === null) return false;
  if (identity.kind === 'kiosk') return (KIOSK_PERMISSIONS as readonly string[]).includes(permission);
  if (identity.kind === 'site') return false;
  if (permission === 'session' || permission === 'session_or_site') return true;
  return can(identity.roles, permission);
}

export interface Limiters {
  /** 600 / min per session (or per IP when anonymous). */
  general: RateLimiter;
  /** 20 / 5 min per IP on challenge and unlock. */
  authIp: RateLimiter;
  /** 10 / 5 min per device on challenge and unlock. */
  authDevice: RateLimiter;
  /** 5 / 10 min per IP on enrolment completion. */
  enrolIp: RateLimiter;
  /** 3 / 10 min per IP on pairing begin (used by Task 6). */
  pairBegin: RateLimiter;
  /** 5 / 15 min per user on PIN change (guards the current-PIN check). */
  pinChange: RateLimiter;
  /** 3 / 60 min per IP on recovery completion. */
  recoveryIp: RateLimiter;
  /** 20 / day for setup and recovery completion together (key 'global'; recovery adds its own 10 / day per box). */
  joinGlobal: RateLimiter;
  /** 10 / min per person on Cari (Nominatim place search). */
  locationSearch: RateLimiter;
  /** 6 / 10 min per box on the zone-list refresh. */
  zoneRefresh: RateLimiter;
  /** 30 / 10 min per session on finance photo uploads. */
  financePhoto: RateLimiter;
  /** 20 / 10 min per session on the finance PDF (CPU work on the box). */
  financePdf: RateLimiter;
}

export function createLimiters(now?: () => number): Limiters {
  const c = now === undefined ? {} : { now };
  const min = 60_000;
  return {
    general: createRateLimiter({ windowMs: min, max: 600, ...c }),
    authIp: createRateLimiter({ windowMs: 5 * min, max: 20, ...c }),
    authDevice: createRateLimiter({ windowMs: 5 * min, max: 10, ...c }),
    enrolIp: createRateLimiter({ windowMs: 10 * min, max: 5, ...c }),
    pairBegin: createRateLimiter({ windowMs: 10 * min, max: 3, ...c }),
    pinChange: createRateLimiter({ windowMs: 15 * min, max: 5, ...c }),
    recoveryIp: createRateLimiter({ windowMs: 60 * min, max: 3, ...c }),
    joinGlobal: createRateLimiter({ windowMs: 24 * 60 * min, max: 20, ...c }),
    locationSearch: createRateLimiter({ windowMs: min, max: 10, ...c }),
    zoneRefresh: createRateLimiter({ windowMs: 10 * min, max: 6, ...c }),
    financePhoto: createRateLimiter({ windowMs: 10 * min, max: 30, ...c }),
    financePdf: createRateLimiter({ windowMs: 10 * min, max: 20, ...c }),
  };
}

export const MSG_UNLOCK_AGAIN = 'Sila buka kunci semula';

export interface AuthzContext {
  db: DatabaseSync;
  now: () => Date;
  limiters: Limiters;
  /** Task 6: resolve the `surau_kiosk` cookie to a kiosk identity, or null. */
  resolveKiosk?: (request: FastifyRequest) => KioskAuth | null;
}

export function tooMany(reply: FastifyReply, retryAfterSec: number): FastifyReply {
  return reply
    .code(429)
    .header('Retry-After', String(retryAfterSec))
    .header('Cache-Control', 'no-store')
    .send({ errors: [MSG.tooMany] });
}

export function bearerToken(request: FastifyRequest): string | null {
  const h = request.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer ([A-Za-z0-9_-]{1,200})$/i.exec(h.trim());
  return m ? m[1]! : null;
}

/** Fastify `onRequest` hook: identity, default-deny permission check, general rate limit. */
export function authHook(ctx: AuthzContext) {
  return async function authzHook(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    request.auth = null;
    if (hasAmbiguousPath(request.raw.url ?? '/')) {
      return reply.code(400).header('Cache-Control', 'no-store').send({ errors: ['invalid request'] });
    }
    const cls = classifyRequest(request.method, request.raw.url ?? '/');

    let identity: AuthIdentity | null = null;
    if (cls.kind !== 'static') {
      // Bearer tokens are read from the Authorization header only, never from the query string.
      const token = bearerToken(request);
      if (token !== null) {
        identity = resolveSession(ctx.db, token, ctx.now());
        if (identity === null) identity = resolveSite(ctx.db, token, ctx.now());
      }
      if (identity === null && ctx.resolveKiosk !== undefined) identity = ctx.resolveKiosk(request);
      // A request that presented a bearer token which did not resolve is NOT the local kiosk: it
      // gets 401 so the app prompts for unlock instead of showing a bare 403.
      if (identity === null && token === null && isLoopbackKiosk(request)) {
        identity = { kind: 'kiosk', deviceId: null, via: 'loopback' };
      }
      request.auth = identity;
    }

    const key =
      identity !== null && identity.kind === 'user'
        ? `s:${identity.sessionId}`
        : identity !== null && identity.kind === 'site'
          ? `site:${identity.boxId}`
          : `ip:${request.ip}`;
    const hit = ctx.limiters.general.hit(key);
    if (!hit.ok) return tooMany(reply, hit.retryAfterSec);

    if (cls.kind === 'static') return undefined;

    const deny401 = (): FastifyReply =>
      reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer')
        .header('Cache-Control', 'no-store')
        .send({ errors: [MSG_UNLOCK_AGAIN] });
    const deny403 = (): FastifyReply =>
      reply.code(403).header('Cache-Control', 'no-store').send({ errors: [MSG.forbidden] });

    if (cls.kind === 'rule') {
      if (cls.permission === 'public') return undefined;
      if (identity === null) {
        // A queued sync batch from a device that was revoked: say so (and log the attempt) instead of a bare
        // "unlock again" that would send it round the unlock loop. Nothing is read or written.
        const tok = bearerToken(request);
        if (cls.permission === 'session_or_site' && request.method === 'POST' && tok !== null) {
          const gone = deviceRevokedForToken(ctx.db, tok, ctx.now());
          if (gone !== null) {
            authLog(ctx.db, ctx.now(), 'sync_refused', false, { ...gone, ip: request.ip, detail: 'device_revoked' });
            return reply
              .code(401)
              .header('Cache-Control', 'no-store')
              .send({ errors: [MSG.deviceRevoked], reason: 'device_revoked' });
          }
        }
        return deny401();
      }
      if (identity.kind === 'site') return siteMayCall(request.method, request.raw.url ?? '/') ? undefined : deny403();
      return identityCan(identity, cls.permission) ? undefined : deny403();
    }

    // Unlisted: default deny. A signed-in user asking for a route that does not exist gets the
    // normal 404; a route that exists but has no table entry is refused outright.
    if (identity === null) return deny401();
    if (identity.kind === 'kiosk') return deny403();
    if (identity.kind === 'site' && !siteMayCall(request.method, request.raw.url ?? '/')) return deny403();
    // 404 handler, or the static plugin's wildcard route (which answers unknown paths with a 404).
    if (request.is404 || request.routeOptions.url === '/*') return undefined;
    return deny403();
  };
}
