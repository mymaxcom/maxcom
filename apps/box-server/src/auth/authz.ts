import { timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { KIOSK_PERMISSIONS, OPS_ROLES, can } from '@surau/core';
import type { Permission } from '@surau/core';
import { liveSettingsPutAllowed } from './liveSettings.ts';
import { createRateLimiter } from './ratelimit.ts';
import type { RateLimiter } from './ratelimit.ts';
import { authLog, deviceRevokedForToken, resolveSession, resolveSite } from './sessions.ts';
import type { AuthContext, SiteAuth } from './sessions.ts';
import { MSG } from './users.ts';
import { isTenantRefusal, tenantOf } from '../tenant.ts';
import type { Tenant } from '../tenant.ts';

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
    /** The surau this request acts for: set before the handler on every `tenant: 'required'` route, else null. */
    tenant: Tenant | null;
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
  method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE';
  /** Matched against the normalised path (lower case, no query, no trailing slash). */
  pattern: RegExp;
  permission: RoutePermission;
  /** A concrete path that matches the pattern (used by the role-matrix test). */
  sample: string;
  /**
   * `required`: the route reads or writes one surau's data; the request gets `request.tenant` (Plan 14 section
   * 3.1) or is refused before the handler. `none`: public, own-session and fleet routes.
   */
  tenant: 'required' | 'none';
  /**
   * The Pentadbir MAXCOM fleet rows (Plan 14 Task 10): on the cloud only an ops-device session passes, checked by
   * the hook before the permission, so the rule holds even if a fleet permission is ever given to a surau role. A
   * box does not register these routes (its answer stays the router's 404).
   */
  ops?: boolean;
}

export const ROUTE_PERMISSIONS: readonly RouteRule[] = [
  { method: 'POST', pattern: /^\/api\/enrol\/complete$/, permission: 'public', sample: '/api/enrol/complete', tenant: 'none' },
  { method: 'POST', pattern: /^\/api\/auth\/challenge$/, permission: 'public', sample: '/api/auth/challenge', tenant: 'none' },
  { method: 'POST', pattern: /^\/api\/auth\/unlock$/, permission: 'public', sample: '/api/auth/unlock', tenant: 'none' },
  { method: 'POST', pattern: /^\/api\/kiosk\/pair\/begin$/, permission: 'public', sample: '/api/kiosk/pair/begin', tenant: 'none' },
  { method: 'POST', pattern: /^\/api\/kiosk\/pair\/poll$/, permission: 'public', sample: '/api/kiosk/pair/poll', tenant: 'none' },
  { method: 'GET', pattern: /^\/api\/pki\/root\.cer$/, permission: 'public', sample: '/api/pki/root.cer', tenant: 'none' },
  { method: 'GET', pattern: /^\/api\/health$/, permission: 'public', sample: '/api/health', tenant: 'none' },
  { method: 'GET', pattern: /^\/api\/surau\/info$/, permission: 'public', sample: '/api/surau/info', tenant: 'none' },
  { method: 'GET', pattern: /^\/api\/box\/info$/, permission: 'public', sample: '/api/box/info', tenant: 'none' },
  { method: 'POST', pattern: /^\/api\/setup\/complete$/, permission: 'public', sample: '/api/setup/complete', tenant: 'none' },
  { method: 'POST', pattern: /^\/api\/setup\/probe$/, permission: 'public', sample: '/api/setup/probe', tenant: 'none' },
  { method: 'POST', pattern: /^\/api\/recovery\/complete$/, permission: 'public', sample: '/api/recovery/complete', tenant: 'none' },
  { method: 'GET', pattern: /^\/app\/ios\.mobileconfig$/, permission: 'public', sample: '/app/ios.mobileconfig', tenant: 'none' },
  { method: 'GET', pattern: /^\/app\/ios$/, permission: 'public', sample: '/app/ios', tenant: 'none' },
  { method: 'GET', pattern: /^\/surau-logo$/, permission: 'public', sample: '/surau-logo', tenant: 'none' },

  { method: 'GET', pattern: /^\/api\/kiosk\/bundle$/, permission: 'kiosk:read', sample: '/api/kiosk/bundle', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/kiosk\/events$/, permission: 'kiosk:read', sample: '/api/kiosk/events', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/kiosk\/content$/, permission: 'kiosk:read', sample: '/api/kiosk/content', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/kiosk\/live$/, permission: 'kiosk:read', sample: '/api/kiosk/live', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/box\/state$/, permission: 'kiosk:read', sample: '/api/box/state', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/box\/netcheck$/, permission: 'kiosk:read', sample: '/api/box/netcheck', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/kiosk\/cloud$/, permission: 'kiosk:read', sample: '/api/kiosk/cloud', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/kiosk\/live\/whep$/, permission: 'kiosk:read', sample: '/api/kiosk/live/whep', tenant: 'required' },
  { method: 'DELETE', pattern: /^\/api\/kiosk\/live\/whep\/[^/]+$/, permission: 'kiosk:read', sample: '/api/kiosk/live/whep/x', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/kiosk\/live\/whep\/[^/]+\/alive$/, permission: 'kiosk:read', sample: '/api/kiosk/live/whep/x/alive', tenant: 'required' },
  // Shared on purpose (Plan 14 section 3.1): content-addressed assets and the reference audio cache.
  { method: 'GET', pattern: /^\/assets\/[^/.]+$/, permission: 'kiosk:read', sample: `/assets/${'a'.repeat(64)}`, tenant: 'none' },
  { method: 'GET', pattern: /^\/islamic\/audio\/.+$/, permission: 'kiosk:read', sample: '/islamic/audio/x/001/001.mp3', tenant: 'none' },
  { method: 'GET', pattern: /^\/themes\/[^/]+\/[^/]+\/.+$/, permission: 'kiosk:read', sample: '/themes/hijau-siti/0123456789abcdef/bundle.css', tenant: 'none' },

  { method: 'GET', pattern: /^\/api\/settings$/, permission: 'settings:read', sample: '/api/settings', tenant: 'required' },
  { method: 'PUT', pattern: /^\/api\/settings\/[^/]+$/, permission: 'settings:write', sample: '/api/settings/clock', tenant: 'required' },
  { method: 'PUT', pattern: /^\/api\/box\/name$/, permission: 'settings:write', sample: '/api/box/name', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/settings\/test-source$/, permission: 'system:write', sample: '/api/settings/test-source', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/prayer\/import$/, permission: 'prayer:import', sample: '/api/prayer/import', tenant: 'required' },

  // Plan 13: prayer sources. Reads are settings:read (every role); writes that change prayer data are prayer:import.
  { method: 'GET', pattern: /^\/api\/prayer\/days$/, permission: 'settings:read', sample: '/api/prayer/days', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/prayer\/status$/, permission: 'settings:read', sample: '/api/prayer/status', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/prayer\/zones$/, permission: 'settings:read', sample: '/api/prayer/zones', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/location\/search$/, permission: 'settings:write', sample: '/api/location/search', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/prayer\/zones\/refresh$/, permission: 'settings:write', sample: '/api/prayer/zones/refresh', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/prayer\/imports$/, permission: 'settings:read', sample: '/api/prayer/imports', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/prayer\/imports\/[^/]+$/, permission: 'settings:read', sample: '/api/prayer/imports/x', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/prayer\/template\.csv$/, permission: 'settings:read', sample: '/api/prayer/template.csv', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/prayer\/template\.xlsx$/, permission: 'settings:read', sample: '/api/prayer/template.xlsx', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/prayer\/import\/file$/, permission: 'prayer:import', sample: '/api/prayer/import/file', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/prayer\/imports\/[^/]+\/undo$/, permission: 'prayer:import', sample: '/api/prayer/imports/x/undo', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/prayer\/countries$/, permission: 'settings:read', sample: '/api/prayer/countries', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/prayer\/timezone$/, permission: 'settings:read', sample: '/api/prayer/timezone', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/prayer\/calc\/preview$/, permission: 'settings:read', sample: '/api/prayer/calc/preview', tenant: 'required' },
  { method: 'PUT', pattern: /^\/api\/prayer\/corrections\/[^/]+\/[^/]+$/, permission: 'prayer:import', sample: '/api/prayer/corrections/2026-11-26/asar', tenant: 'required' },
  { method: 'DELETE', pattern: /^\/api\/prayer\/corrections\/[^/]+\/[^/]+$/, permission: 'prayer:import', sample: '/api/prayer/corrections/2026-11-26/asar', tenant: 'required' },

  { method: 'GET', pattern: /^\/api\/content\/.+$/, permission: 'content:read', sample: '/api/content/announcements', tenant: 'required' },
  { method: 'PUT', pattern: /^\/api\/content\/.+$/, permission: 'content:write', sample: '/api/content/announcements/x', tenant: 'required' },
  { method: 'DELETE', pattern: /^\/api\/content\/.+$/, permission: 'content:write', sample: '/api/content/announcements/x', tenant: 'required' },
  // "Main sekarang": the TV plays this video item at once (a box only)
  { method: 'POST', pattern: /^\/api\/content\/video\/[^/]+\/play-now$/, permission: 'content:write', sample: '/api/content/video/x/play-now', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/assets$/, permission: 'assets:write', sample: '/api/assets', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/assets\/video$/, permission: 'assets:write', sample: '/api/assets/video', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/assets\/video\/storage$/, permission: 'assets:write', sample: '/api/assets/video/storage', tenant: 'required' },
  { method: 'DELETE', pattern: /^\/api\/assets\/video\/[^/]+$/, permission: 'assets:write', sample: `/api/assets/video/${'a'.repeat(64)}`, tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/assets$/, permission: 'assets:write', sample: '/api/assets', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/assets\/[0-9a-f]{64}\/analyze$/, permission: 'assets:write', sample: `/api/assets/${'a'.repeat(64)}/analyze`, tenant: 'required' },

  { method: 'POST', pattern: /^\/api\/themes\/check$/, permission: 'settings:write', sample: '/api/themes/check', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/themes\/install$/, permission: 'settings:write', sample: '/api/themes/install', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/themes\/staged\/[^/]+\/.+$/, permission: 'settings:write', sample: `/api/themes/staged/${'a'.repeat(32)}/bundle.css`, tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/kiosk\/theme-health$/, permission: 'kiosk:read', sample: '/api/kiosk/theme-health', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/themes\/support$/, permission: 'settings:read', sample: '/api/themes/support', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/themes\/[^/]+\/pack$/, permission: 'settings:write', sample: '/api/themes/creative/pack', tenant: 'required' },
  { method: 'DELETE', pattern: /^\/api\/themes\/[^/]+$/, permission: 'settings:write', sample: '/api/themes/hijau-siti', tenant: 'required' },

  { method: 'POST', pattern: /^\/api\/islamic\/fetch$/, permission: 'islamic:fetch', sample: '/api/islamic/fetch', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/islamic\/.+$/, permission: 'settings:read', sample: '/api/islamic/status', tenant: 'required' },

  { method: 'GET', pattern: /^\/api\/hadis\/status$/, permission: 'content:read', sample: '/api/hadis/status', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/hadis\/jobs\/[^/]+$/, permission: 'content:read', sample: '/api/hadis/jobs/j1', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/hadis\/refresh$/, permission: 'islamic:fetch', sample: '/api/hadis/refresh', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/hadis\/search$/, permission: 'content:write', sample: '/api/hadis/search', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/hadis\/categories(?:\/[^/]+\/items)?$/, permission: 'content:write', sample: '/api/hadis/categories/1/items', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/hadis\/hadeethenc\/[^/]+$/, permission: 'content:write', sample: '/api/hadis/hadeethenc/66512', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/hadis\/add$/, permission: 'content:write', sample: '/api/hadis/add', tenant: 'required' },
  { method: 'PUT', pattern: /^\/api\/hadis\/order$/, permission: 'content:write', sample: '/api/hadis/order', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/hadis\/updates$/, permission: 'content:write', sample: '/api/hadis/updates', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/hadis\/[^/]+\/accept-update$/, permission: 'content:write', sample: '/api/hadis/x/accept-update', tenant: 'required' },

  { method: 'POST', pattern: /^\/api\/enrol\/begin$/, permission: 'users:manage', sample: '/api/enrol/begin', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/enrol\/open$/, permission: 'users:manage', sample: '/api/enrol/open', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/enrol\/cancel$/, permission: 'users:manage', sample: '/api/enrol/cancel', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/enrol\/recent$/, permission: 'users:manage', sample: '/api/enrol/recent', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/recovery\/code$/, permission: 'users:manage', sample: '/api/recovery/code', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/recovery\/status$/, permission: 'users:manage', sample: '/api/recovery/status', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/users$/, permission: 'users:manage', sample: '/api/users', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/users$/, permission: 'users:manage', sample: '/api/users', tenant: 'required' },
  { method: 'PUT', pattern: /^\/api\/users\/[^/]+\/roles$/, permission: 'users:manage', sample: '/api/users/none/roles', tenant: 'required' },
  { method: 'PUT', pattern: /^\/api\/users\/[^/]+\/name$/, permission: 'users:manage', sample: '/api/users/none/name', tenant: 'required' },
  { method: 'PUT', pattern: /^\/api\/users\/[^/]+\/phone$/, permission: 'users:manage', sample: '/api/users/none/phone', tenant: 'required' },
  { method: 'PUT', pattern: /^\/api\/users\/[^/]+\/pin$/, permission: 'users:manage', sample: '/api/users/none/pin', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/users\/[^/]+\/unlock$/, permission: 'users:manage', sample: '/api/users/none/unlock', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/users\/[^/]+\/activate$/, permission: 'users:manage', sample: '/api/users/none/activate', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/users\/[^/]+\/delete$/, permission: 'users:manage', sample: '/api/users/none/delete', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/users\/[^/]+\/restore$/, permission: 'users:manage', sample: '/api/users/none/restore', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/users\/[^/]+\/deactivate$/, permission: 'users:manage', sample: '/api/users/none/deactivate', tenant: 'required' },

  { method: 'GET', pattern: /^\/api\/devices$/, permission: 'devices:manage', sample: '/api/devices', tenant: 'required' },
  { method: 'PUT', pattern: /^\/api\/devices\/[^/]+\/name$/, permission: 'devices:manage', sample: '/api/devices/none/name', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/devices\/revoke-inactive$/, permission: 'devices:manage', sample: '/api/devices/revoke-inactive', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/people\/activity$/, permission: 'users:manage', sample: '/api/people/activity', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/devices\/[^/]+\/revoke$/, permission: 'devices:manage', sample: '/api/devices/none/revoke', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/kiosk\/pair\/approve$/, permission: 'devices:manage', sample: '/api/kiosk/pair/approve', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/kiosk\/pair\/pending$/, permission: 'devices:manage', sample: '/api/kiosk/pair/pending', tenant: 'required' },

  // Several boxes in one surau (box only; a cloud does not register these routes). The box-to-box rows are public:
  // the one-time code of the QR and the other box's identity signature decide, in link/session.ts.
  { method: 'GET', pattern: /^\/api\/link\/status$/, permission: 'devices:manage', sample: '/api/link/status', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/link\/(pin|show|scan|approve|agree|cancel)$/, permission: 'devices:manage', sample: '/api/link/show', tenant: 'required' },
  { method: 'PUT', pattern: /^\/api\/link\/answers$/, permission: 'devices:manage', sample: '/api/link/answers', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/kiosk\/link$/, permission: 'kiosk:read', sample: '/api/kiosk/link', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/link\/peer\/(hello|message|order)$/, permission: 'public', sample: '/api/link/peer/hello', tenant: 'none' },
  // Store move (phase 2B): the list answers only a signed message of the session's peer; a file only its read token.
  { method: 'POST', pattern: /^\/api\/link\/peer\/store\/list$/, permission: 'public', sample: '/api/link/peer/store/list', tenant: 'none' },
  { method: 'GET', pattern: /^\/api\/link\/peer\/store\/file$/, permission: 'public', sample: '/api/link/peer/store/file', tenant: 'none' },
  // A follower answers a phone of its old store: where the surau is managed now, with a one-time join ticket (phase 2C).
  { method: 'POST', pattern: /^\/api\/follow\/move(\/challenge)?$/, permission: 'public', sample: '/api/follow/move', tenant: 'none' },
  // phase 2D, "Putuskan pautan": who may answer for which box is decided in link/unlink.ts (a follower's Pentadbir of
  // link day may hold a lower role here), so status / answer / agree need a session only
  { method: 'GET', pattern: /^\/api\/unlink\/status$/, permission: 'session', sample: '/api/unlink/status', tenant: 'none' },
  { method: 'PUT', pattern: /^\/api\/unlink\/answer$/, permission: 'session', sample: '/api/unlink/answer', tenant: 'none' },
  { method: 'POST', pattern: /^\/api\/unlink\/agree$/, permission: 'session', sample: '/api/unlink/agree', tenant: 'none' },
  { method: 'POST', pattern: /^\/api\/unlink\/(start|cancel|switch|drop-kept)$/, permission: 'devices:manage', sample: '/api/unlink/start', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/unlink\/peer\/report$/, permission: 'public', sample: '/api/unlink/peer/report', tenant: 'none' },
  { method: 'POST', pattern: /^\/api\/unlink\/peer\/store\/list$/, permission: 'public', sample: '/api/unlink/peer/store/list', tenant: 'none' },
  { method: 'GET', pattern: /^\/api\/unlink\/peer\/store\/file$/, permission: 'public', sample: '/api/unlink/peer/store/file', tenant: 'none' },
  // D2: a follower leaves by itself; the route answers the box's own loopback caller only, and only with the per-start leave secret (follow/revert.ts)
  { method: 'POST', pattern: /^\/api\/follow\/(revert|empty)$/, permission: 'public', sample: '/api/follow/revert', tenant: 'none' },
  { method: 'GET', pattern: /^\/api\/link\/backup$/, permission: 'devices:manage', sample: '/api/link/backup', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/link\/backup\/(drop|restore)$/, permission: 'devices:manage', sample: '/api/link/backup/drop', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/boxes$/, permission: 'devices:manage', sample: '/api/boxes', tenant: 'required' },
  { method: 'DELETE', pattern: /^\/api\/boxes\/[^/]+$/, permission: 'devices:manage', sample: '/api/boxes/none', tenant: 'required' },

  { method: 'GET', pattern: /^\/api\/pki\/status$/, permission: 'devices:manage', sample: '/api/pki/status', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/audit$/, permission: 'audit:read', sample: '/api/audit', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/finance\/report\/[^/]+\.pdf$/, permission: 'finance:write', sample: '/api/finance/report/2026-10.pdf', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/finance\/report\/[^/.]+$/, permission: 'finance:read', sample: '/api/finance/report/2026-10', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/finance\/report\/[^/.]+\/shared$/, permission: 'finance:write', sample: '/api/finance/report/2026-10/shared', tenant: 'required' },

  // Plan 7: finance. Reads are finance:read (AJK sees entries but never a photo); every write and every photo,
  // PDF and audit route is finance:write. Lookups and month states are the Pentadbir's (settings:write), and the
  // store also requires finance:write on the caller so a role holding only settings:write cannot touch money.
  { method: 'GET', pattern: /^\/api\/finance\/summary$/, permission: 'finance:read', sample: '/api/finance/summary', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/finance\/entries$/, permission: 'finance:read', sample: '/api/finance/entries', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/finance\/entries\/[^/]+$/, permission: 'finance:read', sample: '/api/finance/entries/x', tenant: 'required' },
  { method: 'PUT', pattern: /^\/api\/finance\/entries\/[^/]+$/, permission: 'finance:write', sample: '/api/finance/entries/x', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/finance\/funds$/, permission: 'finance:read', sample: '/api/finance/funds', tenant: 'required' },
  { method: 'PUT', pattern: /^\/api\/finance\/funds\/[^/]+$/, permission: 'settings:write', sample: '/api/finance/funds/x', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/finance\/perihal$/, permission: 'finance:read', sample: '/api/finance/perihal', tenant: 'required' },
  { method: 'PUT', pattern: /^\/api\/finance\/perihal\/[^/]+$/, permission: 'settings:write', sample: '/api/finance/perihal/x', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/finance\/months$/, permission: 'finance:read', sample: '/api/finance/months', tenant: 'required' },
  { method: 'PUT', pattern: /^\/api\/finance\/months\/[^/]+$/, permission: 'settings:write', sample: '/api/finance/months/2026-10', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/finance\/photos$/, permission: 'finance:write', sample: '/api/finance/photos', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/finance\/photos\/[^/]+$/, permission: 'finance:write', sample: `/api/finance/photos/${'a'.repeat(64)}`, tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/finance\/audit$/, permission: 'finance:write', sample: '/api/finance/audit', tenant: 'required' },

  { method: 'POST', pattern: /^\/api\/live\/start$/, permission: 'live:control', sample: '/api/live/start', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/live\/stop$/, permission: 'live:control', sample: '/api/live/stop', tenant: 'required' },
  // the recording of a live, joined on the box (web and iPad): the device that ran the live, or a live administrator (checked in the route)
  { method: 'POST', pattern: /^\/api\/live\/recordings\/[^/]+\/pieces\/[^/]+$/, permission: 'live:control', sample: '/api/live/recordings/abcdef123456/pieces/0', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/live\/recordings\/[^/]+\/join$/, permission: 'live:control', sample: '/api/live/recordings/abcdef123456/join', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/live\/recordings\/[^/]+\/file$/, permission: 'live:control', sample: '/api/live/recordings/abcdef123456/file', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/live\/recordings\/[^/]+\/link$/, permission: 'live:control', sample: '/api/live/recordings/abcdef123456/link', tenant: 'required' },
  // Public with the token: the link is the credential (random 32 bytes, 15 minutes, surau network only; checked in the handler).
  { method: 'GET', pattern: /^\/api\/live\/recordings\/dl\/[^/]+$/, permission: 'public', sample: '/api/live/recordings/dl/0000000000000000000000000000000000000000000000000000000000000000', tenant: 'none' },
  { method: 'DELETE', pattern: /^\/api\/live\/recordings\/[^/]+$/, permission: 'live:control', sample: '/api/live/recordings/abcdef123456', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/live\/status$/, permission: 'live:control', sample: '/api/live/status', tenant: 'required' },
  // 2026.11.15: the last lives of this box (no secret, no device id)
  { method: 'GET', pattern: /^\/api\/live\/sessions\/recent$/, permission: 'live:control', sample: '/api/live/sessions/recent', tenant: 'required' },
  // the surau's live notice: any live:control holder reads and edits it (last edit wins); the frame is one still of the running picture
  { method: 'GET', pattern: /^\/api\/live\/notice$/, permission: 'live:control', sample: '/api/live/notice', tenant: 'required' },
  { method: 'PATCH', pattern: /^\/api\/live\/notice$/, permission: 'live:control', sample: '/api/live/notice', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/live\/notice\/frame\.jpg$/, permission: 'live:control', sample: '/api/live/notice/frame.jpg', tenant: 'required' },
  // Skrin and Merakam during a live: the same callers as Stop (the route decides: the starter, settings:write, any live:control holder for a box-pulled live)
  { method: 'POST', pattern: /^\/api\/live\/outputs$/, permission: 'live:control', sample: '/api/live/outputs', tenant: 'required' },
  // the starting device changes the audio mix of a running live (the route refuses every other device)
  { method: 'POST', pattern: /^\/api\/live\/audio$/, permission: 'live:control', sample: '/api/live/audio', tenant: 'required' },
  // the starting device's preview of the combined stream (the route refuses every other device)
  { method: 'POST', pattern: /^\/api\/live\/preview\/whep$/, permission: 'live:control', sample: '/api/live/preview/whep', tenant: 'required' },
  { method: 'DELETE', pattern: /^\/api\/live\/preview\/whep\/[^/]+$/, permission: 'live:control', sample: '/api/live/preview/whep/x', tenant: 'required' },
  // Mic-in of the box (M1): the device list and the level are read with live:control, the choice is a setting
  { method: 'GET', pattern: /^\/api\/live\/audio-inputs$/, permission: 'live:control', sample: '/api/live/audio-inputs', tenant: 'required' },
  { method: 'PUT', pattern: /^\/api\/live\/audio-input$/, permission: 'live:settings', sample: '/api/live/audio-input', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/live\/audio-inputs\/level$/, permission: 'live:control', sample: '/api/live/audio-inputs/level', tenant: 'required' },
  // build 5: the test of every capture device before Start (live:control), and the per-TV "show the live" switch (live:settings)
  { method: 'POST', pattern: /^\/api\/live\/audio-inputs\/test$/, permission: 'live:control', sample: '/api/live/audio-inputs/test', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/live\/audio-inputs\/test$/, permission: 'live:control', sample: '/api/live/audio-inputs/test', tenant: 'required' },
  { method: 'PUT', pattern: /^\/api\/live\/tv-show$/, permission: 'live:settings', sample: '/api/live/tv-show', tenant: 'required' },
  // external camera (plan 4.2, 4.3): configuration, test and discovery are live:settings; the phone reads the full address with live:control
  { method: 'GET', pattern: /^\/api\/live\/camera$/, permission: 'live:settings', sample: '/api/live/camera', tenant: 'required' },
  { method: 'PUT', pattern: /^\/api\/live\/camera$/, permission: 'live:settings', sample: '/api/live/camera', tenant: 'required' },
  { method: 'DELETE', pattern: /^\/api\/live\/camera$/, permission: 'live:settings', sample: '/api/live/camera', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/live\/camera\/test$/, permission: 'live:settings', sample: '/api/live/camera/test', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/live\/camera\/discover$/, permission: 'live:settings', sample: '/api/live/camera/discover', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/live\/camera\/discover\/fill$/, permission: 'live:settings', sample: '/api/live/camera/discover/fill', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/live\/camera\/source$/, permission: 'live:control', sample: '/api/live/camera/source', tenant: 'required' },
  // Lane X: network control of the camera. The opt-in is a setting; the actions are for the people running the live
  { method: 'PUT', pattern: /^\/api\/live\/camera\/control$/, permission: 'live:settings', sample: '/api/live/camera/control', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/live\/camera\/control$/, permission: 'live:control', sample: '/api/live/camera/control', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/live\/camera\/release$/, permission: 'live:control', sample: '/api/live/camera/release', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/live\/whip$/, permission: 'live:control', sample: '/api/live/whip', tenant: 'required' },
  { method: 'DELETE', pattern: /^\/api\/live\/whip\/[^/]+$/, permission: 'live:control', sample: '/api/live/whip/x', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/live\/youtube\/ingest$/, permission: 'live:control', sample: '/api/live/youtube/ingest', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/live\/youtube\/status$/, permission: 'live:control', sample: '/api/live/youtube/status', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/live\/youtube\/start$/, permission: 'live:control', sample: '/api/live/youtube/start', tenant: 'required' },
  // the surau's one YouTube choice for the next live: anyone who may start a live may change it (last change wins)
  { method: 'PUT', pattern: /^\/api\/live\/youtube\/next-live$/, permission: 'live:control', sample: '/api/live/youtube/next-live', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/live\/youtube\/signin$/, permission: 'live:settings', sample: '/api/live/youtube/signin', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/live\/youtube\/signin\/poll$/, permission: 'live:settings', sample: '/api/live/youtube/signin/poll', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/live\/youtube\/signout$/, permission: 'live:settings', sample: '/api/live/youtube/signout', tenant: 'required' },

  { method: 'POST', pattern: /^\/api\/cloud\/youtube\/broadcast$/, permission: 'session_or_site', sample: '/api/cloud/youtube/broadcast', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/cloud\/youtube\/complete$/, permission: 'session_or_site', sample: '/api/cloud/youtube/complete', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/cloud\/youtube\/status$/, permission: 'session_or_site', sample: '/api/cloud/youtube/status', tenant: 'required' },
  { method: 'PUT', pattern: /^\/api\/sync\/camera-secret$/, permission: 'session_or_site', sample: '/api/sync/camera-secret', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/sync\/camera-secret$/, permission: 'session_or_site', sample: '/api/sync/camera-secret', tenant: 'required' },
  { method: 'DELETE', pattern: /^\/api\/sync\/camera-secret$/, permission: 'session_or_site', sample: '/api/sync/camera-secret', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/sync\/camera-relay$/, permission: 'session_or_site', sample: '/api/sync/camera-relay', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/sync\/camera-relay\/ack$/, permission: 'session_or_site', sample: '/api/sync/camera-relay/ack', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/sync\/youtube\/handover$/, permission: 'session_or_site', sample: '/api/sync/youtube/handover', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/sync\/youtube\/handover\/ack$/, permission: 'session_or_site', sample: '/api/sync/youtube/handover/ack', tenant: 'required' },
  { method: 'PUT', pattern: /^\/api\/sync\/youtube\/flag$/, permission: 'session_or_site', sample: '/api/sync/youtube/flag', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/sync\/youtube\/client$/, permission: 'session_or_site', sample: '/api/sync/youtube/client', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/youtube\/upload\/begin$/, permission: 'live:control', sample: '/api/youtube/upload/begin', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/youtube\/upload\/done$/, permission: 'live:control', sample: '/api/youtube/upload/done', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/youtube\/upload\/progress$/, permission: 'live:control', sample: '/api/youtube/upload/progress', tenant: 'required' },
  // 2026.11.15 (routes in live/youtube/routes.ts): a device gives up its own open upload; a linked box asks whether a
  // broadcast is open here. The answer of the second holds only what the watch page shows (box id, channel id,
  // broadcast id); it is asked with the kiosk token a linked box already holds at its main box.
  { method: 'POST', pattern: /^\/api\/youtube\/upload\/abandon$/, permission: 'live:control', sample: '/api/youtube/upload/abandon', tenant: 'required' },
  // Y11 DORMANT (23 Nov 2026): no caller; see `live/youtube/api.ts`. Revisit this row before the route is used.
  { method: 'GET', pattern: /^\/api\/youtube\/open-broadcast$/, permission: 'kiosk:read', sample: '/api/youtube/open-broadcast', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/youtube\/verify$/, permission: 'live:control', sample: '/api/youtube/verify', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/youtube\/quota$/, permission: 'live:control', sample: '/api/youtube/quota', tenant: 'required' },

  { method: 'POST', pattern: /^\/api\/sync\/ops$/, permission: 'session_or_site', sample: '/api/sync/ops', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/sync\/snapshot$/, permission: 'session_or_site', sample: '/api/sync/snapshot', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/sync\/device-seen$/, permission: 'session_or_site', sample: '/api/sync/device-seen', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/sync\/people-ids$/, permission: 'session_or_site', sample: '/api/sync/people-ids', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/sync\/theme-support$/, permission: 'session_or_site', sample: '/api/sync/theme-support', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/sync\/changes$/, permission: 'session_or_site', sample: '/api/sync/changes', tenant: 'required' },
  // multi-box 2B (B3): a linked box puts its surau to sleep, wakes it, or makes the cloud copy equal to itself. Site
  // only (a person's session is answered 404 by the handler) and signed with the box's sync key (sync/boxCall.ts).
  { method: 'POST', pattern: /^\/api\/sync\/sleep$/, permission: 'session_or_site', sample: '/api/sync/sleep', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/sync\/wake$/, permission: 'session_or_site', sample: '/api/sync/wake', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/sync\/reset-from-box$/, permission: 'session_or_site', sample: '/api/sync/reset-from-box', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/sync\/link$/, permission: 'public', sample: '/api/sync/link', tenant: 'none' },
  { method: 'POST', pattern: /^\/api\/sync\/claim$/, permission: 'public', sample: '/api/sync/claim', tenant: 'none' },
  { method: 'GET', pattern: /^\/api\/sync\/status$/, permission: 'health:read', sample: '/api/sync/status', tenant: 'required' },
  { method: 'POST', pattern: /^\/api\/sync\/run$/, permission: 'settings:write', sample: '/api/sync/run', tenant: 'required' },
  { method: 'PUT', pattern: /^\/api\/sync\/assets\/[^/]+$/, permission: 'session_or_site', sample: '/api/sync/assets/x', tenant: 'required' },
  { method: 'PUT', pattern: /^\/api\/sync\/finance-photos\/[^/]+$/, permission: 'finance:write', sample: '/api/sync/finance-photos/x', tenant: 'required' },
  { method: 'GET', pattern: /^\/api\/sync\/finance-photos\/[^/]+$/, permission: 'finance:write', sample: '/api/sync/finance-photos/x', tenant: 'required' },

  // Plan 14 Task 10: the fleet routes of the MAXCOM Ops app (cloud role only). Support reads; every change is fleet:manage.
  // No row here creates, grants, removes or appoints a superadmin or support (decisions 19-20: CLI only).
  { method: 'GET', pattern: /^\/api\/suraus$/, permission: 'fleet:read', sample: '/api/suraus', tenant: 'none', ops: true },
  { method: 'GET', pattern: /^\/api\/suraus\/[^/]+$/, permission: 'fleet:read', sample: '/api/suraus/abcdefghijkl', tenant: 'none', ops: true },
  { method: 'POST', pattern: /^\/api\/suraus\/[^/]+\/suspend$/, permission: 'fleet:manage', sample: '/api/suraus/abcdefghijkl/suspend', tenant: 'none', ops: true },
  { method: 'POST', pattern: /^\/api\/suraus\/[^/]+\/unsuspend$/, permission: 'fleet:manage', sample: '/api/suraus/abcdefghijkl/unsuspend', tenant: 'none', ops: true },
  { method: 'PUT', pattern: /^\/api\/suraus\/[^/]+\/storage-limit$/, permission: 'fleet:manage', sample: '/api/suraus/abcdefghijkl/storage-limit', tenant: 'none', ops: true },
  { method: 'GET', pattern: /^\/api\/fleet\/pending$/, permission: 'fleet:read', sample: '/api/fleet/pending', tenant: 'none', ops: true },
  { method: 'POST', pattern: /^\/api\/fleet\/pending\/[^/]+\/approve$/, permission: 'fleet:manage', sample: '/api/fleet/pending/0123456789abcdef/approve', tenant: 'none', ops: true },
  { method: 'POST', pattern: /^\/api\/fleet\/pending\/[^/]+\/reject$/, permission: 'fleet:manage', sample: '/api/fleet/pending/0123456789abcdef/reject', tenant: 'none', ops: true },
  { method: 'POST', pattern: /^\/api\/fleet\/boxes\/[^/]+\/revoke$/, permission: 'fleet:manage', sample: '/api/fleet/boxes/0123456789abcdef/revoke', tenant: 'none', ops: true },
  { method: 'POST', pattern: /^\/api\/fleet\/boxes\/[^/]+\/unrevoke$/, permission: 'fleet:manage', sample: '/api/fleet/boxes/0123456789abcdef/unrevoke', tenant: 'none', ops: true },
  { method: 'DELETE', pattern: /^\/api\/fleet\/suraus\/[^/]+$/, permission: 'fleet:manage', sample: '/api/fleet/suraus/abcdefghijkl', tenant: 'none', ops: true },

  { method: 'GET', pattern: /^\/api\/auth\/me$/, permission: 'session', sample: '/api/auth/me', tenant: 'none' },
  { method: 'POST', pattern: /^\/api\/auth\/logout$/, permission: 'session', sample: '/api/auth/logout', tenant: 'none' },
  { method: 'POST', pattern: /^\/api\/auth\/leave$/, permission: 'session', sample: '/api/auth/leave', tenant: 'none' },
  { method: 'PUT', pattern: /^\/api\/auth\/device\/name$/, permission: 'session', sample: '/api/auth/device/name', tenant: 'none' },
  { method: 'PUT', pattern: /^\/api\/auth\/pin$/, permission: 'session', sample: '/api/auth/pin', tenant: 'none' },
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
  // Extracted theme packs: only what a rule lists is served, never an unlisted path or a file with a dot.
  if (path === '/themes' || path.startsWith('/themes/')) return true;
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

/**
 * Whether the listed route acts for one surau. Unlisted and static paths are `none` (no handler of surau data is
 * reached: unlisted is refused, static is page files). Matched the same way as `classifyRequest`.
 */
export function routeTenant(method: string, rawUrl: string): 'required' | 'none' {
  const path = normalisePath(rawUrl);
  if (path === null) return 'none';
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  for (const rule of ROUTE_PERMISSIONS) {
    if (rule.method === m && rule.pattern.test(path)) return rule.tenant;
  }
  return 'none';
}

/** Whether the listed route is an ops-only fleet row (`ops: true`). Matched the same way as `classifyRequest`. */
export function routeIsOps(method: string, rawUrl: string): boolean {
  const path = normalisePath(rawUrl);
  if (path === null) return false;
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  for (const rule of ROUTE_PERMISSIONS) {
    if (rule.method === m && rule.pattern.test(path)) return rule.ops === true;
  }
  return false;
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

/** A plain-http request that really comes from this machine: loopback socket, no proxy header, not cross-site. No kiosk token needed. */
export function isDirectLoopback(request: FastifyRequest): boolean {
  const socket = request.raw.socket as { remoteAddress?: string; encrypted?: boolean };
  if (socket.encrypted === true) return false;
  if (typeof socket.remoteAddress !== 'string' || !LOOPBACK_ADDRS.has(socket.remoteAddress)) return false;
  for (const h of PROXY_HEADERS) if (request.headers[h] !== undefined) return false;
  return request.headers['sec-fetch-site'] !== 'cross-site';
}

export function isLoopbackKiosk(request: FastifyRequest): boolean {
  return isDirectLoopback(request) && kioskTokenAccepts(request);
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
  /** 5 WRONG PINs / 15 min per user on the multi-box PIN proofs (link, unlink, backups); a right PIN is not counted. */
  linkPin: RateLimiter;
  /** 20 / 15 min per user on renaming their own phone. */
  deviceName: RateLimiter;
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
  /** 6 / min per session on the camera test (it drives MediaMTX and the camera). */
  cameraTest: RateLimiter;
  /** 30 / min per session on reading the full camera address. */
  cameraSource: RateLimiter;
  /** 6 / min per session on ONVIF discovery (a multicast probe on the LAN). */
  cameraDiscover: RateLimiter;
  /** 10 / min per session on the ONVIF address fill (each try is a login attempt on the camera). */
  cameraFill: RateLimiter;
  /** 10 / min per device on camera control (each call is a message to the camera on the LAN). */
  cameraControl: RateLimiter;
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
    linkPin: createRateLimiter({ windowMs: 15 * min, max: 5, ...c }),
    deviceName: createRateLimiter({ windowMs: 15 * min, max: 20, ...c }),
    recoveryIp: createRateLimiter({ windowMs: 60 * min, max: 3, ...c }),
    joinGlobal: createRateLimiter({ windowMs: 24 * 60 * min, max: 20, ...c }),
    locationSearch: createRateLimiter({ windowMs: min, max: 10, ...c }),
    zoneRefresh: createRateLimiter({ windowMs: 10 * min, max: 6, ...c }),
    financePhoto: createRateLimiter({ windowMs: 10 * min, max: 30, ...c }),
    financePdf: createRateLimiter({ windowMs: 10 * min, max: 20, ...c }),
    cameraTest: createRateLimiter({ windowMs: min, max: 6, ...c }),
    cameraSource: createRateLimiter({ windowMs: min, max: 30, ...c }),
    cameraDiscover: createRateLimiter({ windowMs: min, max: 6, ...c }),
    cameraFill: createRateLimiter({ windowMs: min, max: 10, ...c }),
    cameraControl: createRateLimiter({ windowMs: min, max: 10, ...c }),
  };
}

/** The fleet routes' own limits, per signed-in user, on the app's clock. */
export interface FleetLimiters {
  /** 120 / min on every fleet read. */
  read: RateLimiter;
  /** 30 / 10 min on every fleet change together. */
  manage: RateLimiter;
  /** 10 / 10 min on approvals (also counted in `manage`). */
  approve: RateLimiter;
}

export function createFleetLimiters(now: () => number): FleetLimiters {
  const min = 60_000;
  return {
    read: createRateLimiter({ windowMs: min, max: 120, now }),
    manage: createRateLimiter({ windowMs: 10 * min, max: 30, now }),
    approve: createRateLimiter({ windowMs: 10 * min, max: 10, now }),
  };
}

export const MSG_UNLOCK_AGAIN = 'Sila buka kunci semula';

export interface AuthzContext {
  db: DatabaseSync;
  now: () => Date;
  limiters: Limiters;
  /** Task 6: resolve the `surau_kiosk` cookie to a kiosk identity, or null. */
  resolveKiosk?: (request: FastifyRequest) => KioskAuth | null;
  /** The server role; tenants are resolved per request on the cloud, a box always has its local constant. */
  role?: 'box' | 'cloud';
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

const MSG_SUSPENDED = 'Surau ini digantung oleh MAXCOM';
const MSG_ASLEEP = 'Salinan awan surau ini dibekukan kerana kotaknya kini dipautkan kepada kotak lain';

/** What a phone of a suspended surau may still call on the cloud: who am I, sign out, leave. */
const SUSPENDED_MAY_CALL = new Set(['GET /api/auth/me', 'POST /api/auth/logout', 'POST /api/auth/leave']);
function suspendedMayCall(method: string, rawUrl: string): boolean {
  const path = normalisePath(rawUrl);
  if (path === null) return false;
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  return SUSPENDED_MAY_CALL.has(`${m} ${path}`);
}

/** The identity's own surau (a site's, or the session device's) is suspended. */
function surauSuspendedFor(db: DatabaseSync, identity: AuthContext | SiteAuth): boolean {
  const row =
    identity.kind === 'site'
      ? db.prepare('SELECT 1 AS x FROM suraus WHERE id = ? AND suspended_at IS NOT NULL').get(identity.surauId)
      : db.prepare('SELECT 1 AS x FROM devices d JOIN suraus s ON s.id = d.surau_id WHERE d.id = ? AND s.suspended_at IS NOT NULL').get(identity.deviceId);
  return row !== undefined;
}

/** Calls a sleeping surau's box still makes: its own sleep (idempotent) and its wake. Checked by their handlers. */
const ASLEEP_MAY_CALL = new Set(['POST /api/sync/sleep', 'POST /api/sync/wake']);

/** A write (not GET/HEAD/OPTIONS) to the cloud, other than the sleep and wake calls themselves. */
function asleepRefuses(method: string, rawUrl: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false;
  const path = normalisePath(rawUrl);
  return path === null || !ASLEEP_MAY_CALL.has(`${m} ${path}`);
}

/** The identity's own surau (a site's, or the session device's) sleeps (multi-box 2B: its box follows another box). */
function surauAsleepFor(db: DatabaseSync, identity: AuthContext | SiteAuth): boolean {
  const row =
    identity.kind === 'site'
      ? db.prepare('SELECT 1 AS x FROM suraus WHERE id = ? AND asleep_at IS NOT NULL').get(identity.surauId)
      : db.prepare('SELECT 1 AS x FROM devices d JOIN suraus s ON s.id = d.surau_id WHERE d.id = ? AND s.asleep_at IS NOT NULL').get(identity.deviceId);
  return row !== undefined;
}

/** The user's stored roles (not the session's effective ones) include an ops role. */
function userHoldsOpsRole(db: DatabaseSync, userId: string): boolean {
  const row = db.prepare('SELECT roles_json FROM users WHERE id = ?').get(userId);
  try {
    const roles = JSON.parse(String(row?.roles_json ?? '[]')) as unknown;
    return Array.isArray(roles) && roles.some((r) => (OPS_ROLES as readonly unknown[]).includes(r));
  } catch {
    return false;
  }
}

/** Fastify `onRequest` hook: identity, default-deny permission check, general rate limit. */
export function authHook(ctx: AuthzContext) {
  return async function authzHook(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    request.auth = null;
    request.tenant = null;
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

    // A suspended surau is shut out of the cloud (Plan 14 decision 23): its sites and the phones enrolled in it get
    // 403 on every call; the box keeps working locally. A Pentadbir MAXCOM acting from an ops device is not stopped.
    // A phone may still ask who it is (the answer says the surau is suspended, so the app can tell the user), sign out
    // and leave.
    if (
      ctx.role === 'cloud' && identity !== null && identity.kind !== 'kiosk' &&
      !(identity.kind === 'user' && suspendedMayCall(request.method, request.raw.url ?? '/')) &&
      surauSuspendedFor(ctx.db, identity)
    ) {
      return reply.code(403).header('Cache-Control', 'no-store').send({ errors: [MSG_SUSPENDED], code: 'surau_suspended' });
    }

    // A sleeping surau (multi-box 2B) is read-only on the cloud: its box follows another box now, and nothing may
    // change the copy the cloud keeps of it. Reads still answer; a phone may still sign out and leave; the box may
    // still sleep it again (idempotent) and wake it. Same reach as the suspended check (an ops device is not stopped).
    if (
      ctx.role === 'cloud' && identity !== null && identity.kind !== 'kiosk' &&
      asleepRefuses(request.method, request.raw.url ?? '/') &&
      !(identity.kind === 'user' && suspendedMayCall(request.method, request.raw.url ?? '/')) &&
      surauAsleepFor(ctx.db, identity)
    ) {
      return reply.code(409).header('Cache-Control', 'no-store').send({ errors: [MSG_ASLEEP], code: 'surau_asleep' });
    }

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
        // A request from a device that was revoked (or whose person was deleted, which revokes it): say so in the
        // code `device_revoked` instead of the bare "unlock again" that would send the phone round the unlock loop,
        // so the app always wipes its local copy. A queued sync push is also logged. Nothing is read or written.
        const tok = bearerToken(request);
        if (tok !== null) {
          const gone = deviceRevokedForToken(ctx.db, tok, ctx.now());
          if (gone !== null) {
            if (cls.permission === 'session_or_site' && request.method === 'POST') {
              authLog(ctx.db, ctx.now(), 'sync_refused', false, { ...gone, ip: request.ip, detail: 'device_revoked' });
            }
            return reply
              .code(401)
              .header('Cache-Control', 'no-store')
              .send({ errors: [MSG.deviceRevoked], code: 'device_revoked', reason: 'device_revoked' });
          }
        }
        return deny401();
      }
      // Fleet rows on the cloud: an ops-device session only, before the permission. A person holding an ops role on a
      // public device is refused with one auth_log row; anyone else (a surau role, a site, the kiosk) is a plain 403.
      if (ctx.role === 'cloud' && routeIsOps(request.method, request.raw.url ?? '/') && !(identity.kind === 'user' && identity.ops === true)) {
        if (identity.kind === 'user' && userHoldsOpsRole(ctx.db, identity.userId)) {
          authLog(ctx.db, ctx.now(), 'ops_device_required', false, { userId: identity.userId, deviceId: identity.deviceId, ip: request.ip, detail: 'ops_device_required' });
        }
        return deny403();
      }
      if (identity.kind === 'site') {
        if (!siteMayCall(request.method, request.raw.url ?? '/')) return deny403();
      } else if (!identityCan(identity, cls.permission)) {
        // Siaran Langsung holds live:settings, not settings:write: it may PUT only the live features (plan 4.1)
        const liveWrite =
          identity.kind === 'user' && cls.permission === 'settings:write' && liveSettingsPutAllowed(identity.roles, request.method, request.raw.url ?? '/');
        if (!liveWrite) return deny403();
      }
      if (routeTenant(request.method, request.raw.url ?? '/') === 'none') return undefined;
      // Tenant routes: the surau is told from the identity (and, for an acting Pentadbir MAXCOM on an ops device,
      // the X-Maxcom-Surau header) before any handler runs; a refusal is answered here.
      const t = tenantOf(identity, request.headers, ctx.db, ctx.role ?? 'box', { now: ctx.now(), ip: request.ip });
      if (isTenantRefusal(t)) {
        return reply.code(t.status).header('Cache-Control', 'no-store').send({ errors: [t.message], reason: t.code });
      }
      request.tenant = t;
      return undefined;
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
