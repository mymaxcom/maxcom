import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest, FastifyServerFactory } from 'fastify';
import fastifyStatic from '@fastify/static';
import { dateOf, hasOfficialSource, isFeatureKey, parseJakimCsv, patchNeedsSystemWrite, tzOf, validateFeatureSettings } from '@surau/core';
import type { ImageRef } from '@surau/core';
import type { KioskLive, PrayerDay } from '@surau/core';
import { actorOf, deviceOf } from './actor.ts';
import { isAppPath, registerAppStatic } from './appStatic.ts';
import { registerAssetRoutes } from './assets/routes.ts';
import { registerFinanceRoutes } from './finance/routes.ts';
import { DEFAULT_SURAU_ID } from './sync/verify.ts';
import { assetsTotalBytes } from './assets/store.ts';
import { attachPinPepper, derivePinPepper } from './auth/crypto.ts';
import { authHook, bearerToken, createLimiters, identityCan, parseKioskToken } from './auth/authz.ts';
import type { KioskAuth, Limiters } from './auth/authz.ts';
import { createKioskResolver } from './auth/pairing.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import { authLog, resolveSession } from './auth/sessions.ts';
import { boxId as boxIdOf, loadBoxKey } from './auth/secrets.ts';
import { appLockEnabled } from './auth/appLock.ts';
import { AuthError, MSG, setUsersRole } from './auth/users.ts';
import { certInfo } from './tls.ts';
import type { TlsMaterial } from './tls.ts';
import { hkdfSync, randomBytes } from 'node:crypto';
import type { FirewallState } from './live/firewall.ts';
import { createLiveRuntime } from './live/mediamtx.ts';
import type { LiveToolsOption } from './live/mediamtx.ts';
import { registerLiveRoutes } from './live/routes.ts';
import { LiveSessions } from './live/sessions.ts';
import type { RelayOptions } from './live/relay.ts';
import type { YoutubeLeg } from './live/sessions.ts';
import { createWebrtcProxy } from './live/webrtcProxy.ts';
import { createYoutubeService } from './live/youtube/api.ts';
import { registerYoutubeCloudRoutes } from './sync/youtubeCloud.ts';
import { CloudOrLocalLeg, RemoteYoutubeLeg } from './sync/youtubeRemote.ts';
import type { YoutubeService } from './live/youtube/api.ts';
import { isIP } from 'node:net';
import { registerContentRoutes } from './content/routes.ts';
import { openDb } from './db.ts';
import { createChangeBus } from './events.ts';
import { createHadeethEnc, lazyHadeethEnc } from './hadis/hadeethenc.ts';
import { createCatalogJob } from './hadis/catalogJob.ts';
import { registerHadisRoutes } from './hadis/routes.ts';
import { startHadisTimers } from './hadis/updates.ts';
import { registerIslamicRoutes } from './islamic/routes.ts';
import { guardedFetch, sourceUrlsFrom } from './net/safeFetch.ts';
import { createPrayerAutoFetch, fetchEsolatYear } from './prayerAutoFetch.ts';
import { registerSecurityHeaders, securityHeaders } from './securityHeaders.ts';
import { hardenServer } from './serverLimits.ts';
import { buildKioskContent } from './kioskContent.ts';
import { backfillOfficialFeed, importDays } from './prayerStore.ts';
import { registerPrayerRoutes } from './prayer/index.ts';
import { afterPrayerSettings, prayerSettingsGuard } from './prayer/settingsGuard.ts';
import { addDays as addCalendarDays, resolveDays, sourceLine } from './prayer/resolve.ts';
import { prayerStatus } from './prayer/routes.ts';
import { getSettings, getVersion, putFeature, SettingsError, surauPublicInfo } from './settingsStore.ts';
import { applySurauIni } from './surauIni.ts';
import { registerSettingsTest } from './settingsTest.ts';
import { registerSurauLogoRoutes, kioskLogoAssetId, surauLogoUrl } from './surauLogo.ts';
import { deriveImage, ImageAdjustError } from './imageAdjust.ts';
import { AssetError, getAssetPath } from './assets/store.ts';
import { SyncAgent } from './sync/agent.ts';
import { registerCors } from './sync/cors.ts';
import { registerSyncRoutes, syncStatus } from './sync/routes.ts';
import { ephemeralIdentity, loadIdentity } from './setup/identity.ts';
import { registerJoinRoutes } from './setup/joinRoutes.ts';
import { registerStateRoutes } from './setup/stateRoutes.ts';
import { createClaimHandler, createLinkHandler, enrolCloudOrigin, listSites, registerSiteAssetRoute } from './sync/sites.ts';
import { outboxStatus, setOutboxOn, WorkerOutboxSender } from './sync/workerOutbox.ts';
import type { WorkerAdminConfig } from './sync/workerOutbox.ts';
import { trimChangeLog } from './sync/trim.ts';

export interface AppOptions {
  now?: () => Date;
  fetchImpl?: typeof fetch;
  /** Test seam: how long `Cuba sambungan` waits for a source (default 5 s). */
  sourceTestTimeoutMs?: number;
  staticDir?: string | null;
  /** Built Flutter web app, served at /app/ (same origin). Null or missing folder: not served. */
  appDir?: string | null;
  heartbeatMs?: number;
  /** How often the version is re-read to catch writes by another process (CLI); default 5000. */
  versionPollMs?: number;
  /** Extra Host header names accepted besides loopback (only needed with SURAU_ALLOW_LAN=1). */
  allowedHosts?: string[];
  /** Trust X-Forwarded-For (only behind a proxy you control); default from env SURAU_TRUST_PROXY=1, else off. */
  trustProxy?: boolean;
  /** Per-start kiosk token (64 hex); default from env SURAU_KIOSK_TOKEN. Set: loopback is the kiosk only with cookie `mxk` equal to it. */
  kioskToken?: string;
  /** Event-stream slots one client address may hold (default 6). */
  maxSseClientsPerIp?: number;
  /** Lets main.ts supply the HTTP server (and run an HTTPS server beside it). */
  serverFactory?: FastifyServerFactory;
  /** Folder for assets, Islamic caches and other files; default is the folder holding the database. */
  dataDir?: string;
  /** Public id of this box (signed into every unlock); default derives it from `<dataDir>/secret/box.key`. */
  boxId?: string;
  /** `box` (default) or `cloud` (the always-on replica, Task 4). Only the cloud serves `POST /api/sync/link`. */
  role?: 'box' | 'cloud';
  /**
   * Box role: the cloud this box syncs with. Passing it (even `null`, "not set") starts the `SyncAgent` after the
   * app is ready; leave it out (tests, the CLI) and no agent runs on its own. The address a linked box really
   * talks to is the one stored at link time (`cloudLink.ts`) unless `url` overrides it (env SURAU_CLOUD_URL).
   */
  cloud?: { url: string | null; workerUrl?: string | null } | null;
  /** Origins allowed to call this server from a browser (CORS). Box: none by default. Cloud: the box origin. */
  corsOrigins?: string[];
  /** Tuning and test seams of the box's sync agent. */
  sync?: { auto?: boolean; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; debounceMs?: number; initialDelayMs?: number; limits?: { small?: number; page?: number; snapshot?: number; push?: number }; /** Test seam: how long the YouTube broadcast call waits for an asleep cloud (default 20 s). */ youtubeWaitMs?: number };
  /**
   * Cloud role: the Cloudflare Worker's admin address and token (from the environment). Set, it switches the
   * Worker outbox on (dirty seq, device allowlist, wake secret); left out or null, nothing is queued.
   */
  workerAdmin?: WorkerAdminConfig | null;
  /** Test seam: `auto: false` runs no timer, the test calls `app.workerOutbox.drain()`. */
  workerOutbox?: { auto?: boolean; pollMs?: number };
  /** TLS material, for the health report and the enrolment payload. */
  tls?: TlsMaterial | null;
  /** HTTPS port advertised in enrolment payloads. */
  httpsPort?: number;
  /** Task 6 hook: resolves the kiosk pairing cookie to a kiosk identity. */
  resolveKiosk?: (request: FastifyRequest) => KioskAuth | null;
  /**
   * Starts the daily automatic prayer-data fetch (first run after `firstDelayMs`, default 60 s,
   * then every `intervalMs`, default 24 h). Left out, no timer runs (tests, the CLI).
   */
  autoPrayerFetch?: { firstDelayMs?: number; intervalMs?: number };
  /** Test seam: the least gap between two Nominatim searches (default 1000 ms). */
  nominatimMinIntervalMs?: number;
  /**
   * Starts the HadeethEnc timers (box role only): the monthly catalog refresh and the weekly check of saved
   * hadis, first run after `firstMs` (default 10 min), then every `everyMs` (default 6 h). Left out, none runs.
   */
  hadisTimers?: { firstMs?: number; everyMs?: number };
  /**
   * Live video tools folder (MediaMTX, ffmpeg). When set, MediaMTX is started after the box listens
   * and stopped on close. Left out or null: no live tools run (tests, the CLI).
   */
  liveTools?: LiveToolsOption | null;
  /** The media-ports firewall check (main.ts supplies the real one on Windows); left out, the state is unknown. */
  liveFirewall?: { check(): Promise<FirewallState>; state(): FirewallState } | null;
  /** Live session tuning and the YouTube leg (Task 4 supplies `youtube`); tests shorten the timers. */
  live?: { monitorMs?: number; noVideoMs?: number; idleTimeoutMs?: number; reprovisionMs?: number; youtube?: YoutubeLeg | null; relay?: Partial<RelayOptions> };
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The one live session of this box (state machine, credentials in memory only). */
    liveSessions: LiveSessions;
    /** The box's sync agent (box role with a data folder), else null. */
    syncAgent: SyncAgent | null;
    /** The cloud's sender towards the Worker's admin routes (cloud role with a Worker configured), else null. */
    workerOutbox: WorkerOutboxSender | null;
  }
}

const ZONE = /^[A-Z]{3}\d{2}$/;
const MAX_SSE_CLIENTS = 20;
/** One address (the local kiosk, or one paired display) may hold at most this many streams. */
const MAX_SSE_PER_IP = 6;
const DEFAULT_HEARTBEAT_MS = 25_000;
const DEFAULT_VERSION_POLL_MS = 5_000;
const BODY_LIMIT = 2 * 1024 * 1024;

/** The cloud has no kiosk to pair, no box screen and no setup: these prefixes answer 404 there. */
const CLOUD_404_PREFIXES = ['/api/kiosk/pair/', '/api/box/', '/api/setup/', '/api/recovery/'] as const;

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1']);

/** Hostname part of a Host header value, lower-cased, without brackets or port; '' if unparseable. */
function hostnameOf(header: string | undefined): string {
  if (typeof header !== 'string') return '';
  const h = header.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end < 0 ? '' : h.slice(1, end);
  }
  const colon = h.lastIndexOf(':');
  if (colon < 0) return h;
  // Whatever follows the last colon must be a port; `127.0.0.1:80@evil.example` is not a host.
  return /^\d{1,5}$/.test(h.slice(colon + 1)) ? h.slice(0, colon) : '';
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function addDays(date: string, delta: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const shifted = new Date(Date.UTC(y, m - 1, d + delta));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

export function buildApp(dbPath: string, opts: AppOptions = {}): FastifyInstance {
  // First, before any file is opened: a malformed token is a clean start error.
  const kioskToken = parseKioskToken(opts.kioskToken ?? process.env.SURAU_KIOSK_TOKEN);
  const now = opts.now ?? (() => new Date());
  const fetchImpl = opts.fetchImpl ?? guardedFetch();
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const dataDir = opts.dataDir ?? dirname(dbPath);
  const role = opts.role ?? 'box';

  const db = openDb(dbPath);
  // The Pentadbir MAXCOM lives on the cloud: the users store needs to know which side it serves.
  setUsersRole(db, role);
  // A box sends the official days it already held before they replicated; a cloud only receives them.
  if (role === 'box') backfillOfficialFeed(db, now());
  // PIN hashes are peppered with a secret derived from box.key (see auth/crypto.ts). An in-memory
  // database with no data folder has no key file; it keeps a random per-handle pepper instead.
  if (!(dbPath === ':memory:' && opts.dataDir === undefined)) attachPinPepper(db, derivePinPepper(loadBoxKey(dataDir)));
  // First-boot surau.ini (+ logo) from the data folder; only while surauInfo was never saved. An
  // in-memory database with no data folder (tests) never reads one from the working directory.
  if (!(dbPath === ':memory:' && opts.dataDir === undefined)) applySurauIni(db, dataDir);
  const bus = createChangeBus();
  let syncAgent: SyncAgent | null = null;
  const limiters: Limiters = createLimiters();
  const boxId = opts.boxId ?? (dbPath === ':memory:' && opts.dataDir === undefined ? randomBytes(8).toString('hex') : boxIdOf(dataDir));
  const realDataDir = !(dbPath === ':memory:' && opts.dataDir === undefined);
  // Cloud role: the wake secrets of linked sites are sealed under this key, at rest and in the Worker outbox.
  const sealKey = role === 'cloud' && realDataDir ? Buffer.from(hkdfSync('sha256', loadBoxKey(dataDir), Buffer.alloc(0), 'site-wake', 32)) : null;
  // The Worker outbox is on only for a cloud with a Worker configured; otherwise nothing is ever queued.
  let workerOutbox: WorkerOutboxSender | null = null;
  if (role === 'cloud') {
    setOutboxOn(db, opts.workerAdmin != null);
    if (opts.workerAdmin) {
      workerOutbox = new WorkerOutboxSender({
        db,
        config: opts.workerAdmin,
        sealKey,
        now,
        ...(opts.workerOutbox?.auto !== undefined ? { auto: opts.workerOutbox.auto } : {}),
        ...(opts.workerOutbox?.pollMs !== undefined ? { pollMs: opts.workerOutbox.pollMs } : {}),
      });
    }
  }
  if (role === 'box' && realDataDir) {
    syncAgent = new SyncAgent({
      db,
      dataDir,
      boxId,
      now,
      bus,
      ...(opts.sync?.fetchImpl ? { fetchImpl: opts.sync.fetchImpl } : {}),
      ...(opts.sync?.sleep ? { sleep: opts.sync.sleep } : {}),
      ...(opts.sync?.debounceMs !== undefined ? { debounceMs: opts.sync.debounceMs } : {}),
      ...(opts.sync?.initialDelayMs !== undefined ? { initialDelayMs: opts.sync.initialDelayMs } : {}),
      ...(opts.sync?.limits ? { limits: opts.sync.limits } : {}),
      ...(opts.cloud?.url ? { cloudUrl: opts.cloud.url } : {}),
      ...(opts.cloud?.workerUrl ? { workerUrl: opts.cloud.workerUrl } : {}),
    });
  }
  const app = Fastify({
    logger: false,
    // behind a reverse proxy set SURAU_TRUST_PROXY=1 so request.ip is the client, not the proxy (default off)
    trustProxy: opts.trustProxy ?? process.env.SURAU_TRUST_PROXY === '1',
    bodyLimit: BODY_LIMIT,
    // Router-level refusals (over-long path parameter, bad URL) use the API's own error shape and
    // never echo the request path back.
    frameworkErrors: (error, request, reply) => {
      // Hooks do not run for these, so add the standard headers here.
      for (const [k, v] of Object.entries(securityHeaders((request.raw.socket as { encrypted?: boolean }).encrypted === true))) reply.header(k, v);
      reply.header('Cache-Control', 'no-store');
      const status = typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 400;
      return (reply as { code: (n: number) => { send: (b: unknown) => unknown } }).code(status).send({ errors: ["invalid request"] });
    },
    ...(opts.serverFactory ? { serverFactory: opts.serverFactory } : {}),
  });
  app.decorate('kioskToken', kioskToken);
  hardenServer(app.server);
  registerSecurityHeaders(app);
  const hostSet = (extra: readonly string[]): Set<string> =>
    new Set([...LOOPBACK_NAMES, ...extra.map((h) => h.trim().toLowerCase()).filter((h) => h !== '')]);
  let allowedHosts = hostSet(opts.allowedHosts ?? []);

  // Blocks DNS-rebinding: a page on another origin cannot talk to this unauthenticated API
  // under an attacker-controlled hostname.
  app.addHook('onRequest', async (request, reply) => {
    if (!allowedHosts.has(hostnameOf(request.headers.host))) {
      return reply.code(421).send({ errors: ['host not allowed'] });
    }
    return undefined;
  });

  // The cloud has no kiosk to pair.
  if (role === 'cloud') {
    app.addHook('onRequest', async (request, reply) => {
      const path = (request.raw.url ?? '').split('?')[0]!.toLowerCase();
      if (CLOUD_404_PREFIXES.some((p) => path.startsWith(p))) {
        return reply.code(404).send({ errors: ['not found'] });
      }
      return undefined;
    });
  }
  // CORS answers a listed origin's preflight before authorisation.
  registerCors(app, opts.corsOrigins ?? []);

  const resolveKiosk = opts.resolveKiosk ?? createKioskResolver(db, now);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', authHook({ db, now, limiters, resolveKiosk }));
  app.decorate('surau', {
    db,
    boxId,
    limiters,
    // A renewed certificate may name a new IP: the Host allowlist follows it without a restart.
    setAllowedHosts: (hosts: string[]): void => {
      allowedHosts = hostSet(hosts);
    },
  });

  const live = opts.liveTools && role === 'box'
    ? createLiveRuntime({ option: opts.liveTools, dataDir, lanIps: (opts.tls?.ipSan ?? []).filter((ip) => isIP(ip) !== 0) })
    : null;
  app.decorate('liveRuntime', live?.runtime ?? null);
  if (live) app.addHook('onReady', async () => live.start());
  // where live tools are detected: look at the media-port rules once (read-only; repairs only when this process is elevated)
  if (live && opts.liveFirewall) {
    const fw = opts.liveFirewall;
    app.addHook('onReady', async () => void fw.check().catch(() => undefined));
    // idle too: a fixed rule clears the banner without a live start (check() reuses a result under 60 s old and never blocks a request)
    const fwTimer = setInterval(() => void fw.check().catch(() => undefined), 60_000);
    fwTimer.unref();
    app.addHook('onClose', async () => clearInterval(fwTimer));
  }
  const lanIps = (opts.tls?.ipSan ?? []).filter((ip) => isIP(ip) !== 0);
  // the box's own YouTube leg (sealed token under <dataDir>/secret); a test may inject its own. No data folder, no leg.
  const localYoutube: YoutubeLeg | null =
    opts.live?.youtube ??
    (dbPath === ':memory:' && opts.dataDir === undefined ? null : createYoutubeService({ db, dataDir, fetchImpl, now, role }));
  const youtubeService: YoutubeService | null = localYoutube !== null && 'begin' in localYoutube ? (localYoutube as YoutubeService) : null;
  // A linked box (cloudSync on) takes its live YouTube leg from the cloud, which owns the Google token (Plan 6
  // Task 5); the box's own service stays as the fallback for an unlinked box or `cloudSync` off. A test that
  // injects its own leg keeps it.
  const youtubeRemote: RemoteYoutubeLeg | null =
    role === 'box' && realDataDir && opts.live?.youtube === undefined && localYoutube !== null
      ? new RemoteYoutubeLeg({
          db,
          dataDir,
          now,
          ...(opts.sync?.fetchImpl ? { fetchImpl: opts.sync.fetchImpl } : {}),
          ...(opts.cloud?.url ? { cloudUrl: opts.cloud.url } : {}),
          // wakes the cloud through the sync agent's own signed call (the wake secret stays there)
          ...(syncAgent !== null ? { wake: () => syncAgent!.wakeNow() } : {}),
          // how long to wait for an asleep cloud: the Pentadbir MAXCOM's `system.cloudWakeSeconds` (a test may pin it)
          waitBudgetMs: opts.sync?.youtubeWaitMs ?? ((): number => Number(getSettings(db).system.cloudWakeSeconds) * 1000),
        })
      : null;
  // stored YouTube completes are retried on every sync agent cycle too
  if (youtubeRemote !== null) syncAgent?.setCycleHook(() => void youtubeRemote.retryPending());
  const youtube: YoutubeLeg | null =
    youtubeRemote !== null && localYoutube !== null ? new CloudOrLocalLeg(youtubeRemote, localYoutube, () => youtubeRemote.active()) : localYoutube;
  app.addHook('onClose', async () => youtubeRemote?.stop());
  const liveSessions = new LiveSessions({
    db,
    now,
    runtime: live?.runtime ?? null,
    onKiosk: (k) => {
      // MediaMTX closes the kiosk's viewers when the picture goes away: forget their slots
      if (!k.live) webrtcProxy.resetWhep();
      bus.emitLive(k);
    },
    youtube,
    firewall: opts.liveFirewall ?? null,
    // the no-video warning delay: `system.noVideoSeconds`, read at every check (a test may pin it)
    noVideoMs: opts.live?.noVideoMs ?? ((): number => Number(getSettings(db).system.noVideoSeconds) * 1000),
    ...(dbPath === ':memory:' && opts.dataDir === undefined ? {} : { dataDir }),
    ...(opts.live?.relay !== undefined ? { relayOptions: opts.live.relay } : {}),
    ...(opts.live?.monitorMs !== undefined ? { monitorMs: opts.live.monitorMs } : {}),
    ...(opts.live?.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.live.idleTimeoutMs } : {}),
    ...(opts.live?.reprovisionMs !== undefined ? { reprovisionMs: opts.live.reprovisionMs } : {}),
  });
  // a broadcast an earlier run left open (crash, power cut) is ended now, in the background
  // (the cloud makes the broadcasts of a linked box, so it ends the ones a crash left open too)
  if (youtubeService !== null) app.addHook('onReady', async () => void youtubeService.recover());
  // The cloud has no live of its own: a broadcast the box has not mentioned for 6 hours is an orphan (the box
  // is gone or its complete was lost for good). A daily sweep ends those; the first one runs an hour after start,
  // so the box's status calls after a cloud restart have time to show that its live is still going.
  if (role === 'cloud' && youtubeService !== null) {
    const sweep = (): void => void youtubeService.sweepOrphans().catch(() => undefined);
    let sweepDaily: NodeJS.Timeout | null = null;
    const sweepFirst = setTimeout(() => {
      sweep();
      sweepDaily = setInterval(sweep, 24 * 3_600_000);
      sweepDaily.unref();
    }, 3_600_000);
    sweepFirst.unref();
    app.addHook('onClose', async () => {
      clearTimeout(sweepFirst);
      if (sweepDaily !== null) clearInterval(sweepDaily);
    });
  }
  const webrtcProxy = createWebrtcProxy({ sessions: liveSessions, runtime: () => live?.runtime ?? null });
  app.decorate('liveSessions', liveSessions);
  app.decorate('syncAgent', syncAgent);
  app.decorate('workerOutbox', workerOutbox);
  workerOutbox?.start();
  app.addHook('onClose', async () => {
    workerOutbox?.stop();
  });
  // after listen: the agent's first check is scheduled (never blocks start-up)
  if (syncAgent !== null && opts.cloud !== undefined && opts.sync?.auto !== false) {
    const agent = syncAgent;
    app.addHook('onReady', async () => agent.start());
  }

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    if (error instanceof AuthError) {
      if (error.retryAfterSec !== undefined) reply.header('Retry-After', String(error.retryAfterSec));
      return reply.code(error.status).header('Cache-Control', 'no-store').send({ errors: [error.message], code: error.code });
    }
    const status = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    if (status < 500) {
      return reply.code(status).send({ errors: [error.message] });
    }
    // Log the failure (never request bodies) and keep the detail off the wire.
    console.error(`${request.method} ${(request.raw.url ?? '').split('?')[0]} failed:`, error);
    return reply.code(500).send({ errors: ['internal error'] });
  });

  const autoFetch = createPrayerAutoFetch({
    db,
    now,
    fetchImpl,
    onChanged: (version) => bus.emit(version),
    ...(opts.autoPrayerFetch?.firstDelayMs !== undefined ? { firstDelayMs: opts.autoPrayerFetch.firstDelayMs } : {}),
    ...(opts.autoPrayerFetch?.intervalMs !== undefined ? { intervalMs: opts.autoPrayerFetch.intervalMs } : {}),
  });
  if (opts.autoPrayerFetch && role === 'box') autoFetch.start();
  const prayerDeps = { db, dataDir, now, fetchImpl, bus, autoFetch, autoFetchOn: opts.autoPrayerFetch !== undefined && role === 'box', role, limiters, ...(opts.nominatimMinIntervalMs !== undefined ? { nominatimMinIntervalMs: opts.nominatimMinIntervalMs } : {}) };

  let sseClients = 0;
  const sseByIp = new Map<string, number>();
  const clientCleanups = new Set<() => void>();

  app.get('/api/kiosk/bundle', async (_request, reply) => {
    const settings = getSettings(db);
    const zone = String(settings.zone.zone);
    const tz = tzOf(settings);
    const at = now();
    const today = dateOf(at, tz);
    // Each day carries where its times come from; the kiosk shows the source line and the gold band from these.
    // Every row carries its own source line: the kiosk reads today's from the row of the day it is on, so the
    // footer is right after midnight without fetching the bundle again.
    const days = resolveDays(db, settings, addCalendarDays(today, -1), addCalendarDays(today, 40))
      .map((d) => ({ ...d, footerMs: sourceLine(settings, d, 'ms'), footerEn: sourceLine(settings, d, 'en') }));
    const todayDay = days.find((d) => d.date === today);
    const prayer = {
      country: settings.location.country,
      hasOfficial: hasOfficialSource(settings.location.country),
      timezone: tz,
      utcOffsetMinutes: surauPublicInfo(db, at).utcOffsetMinutes,
      footerMs: todayDay ? sourceLine(settings, todayDay, 'ms') : '',
      footerEn: todayDay ? sourceLine(settings, todayDay, 'en') : '',
    };
    reply.header('Cache-Control', 'no-store');
    // The kiosk loads plain asset ids: its copy of the settings carries the derived wide logo, not the adjustment.
    const kioskSettings = { ...settings, surauInfo: { ...settings.surauInfo, logo: kioskLogoAssetId(db, dataDir) } };
    return { version: getVersion(db), zone, days, prayer, settings: kioskSettings, logo: surauLogoUrl(db, dataDir), serverTime: at.toISOString() };
  });

  app.get('/api/kiosk/content', async (_request, reply) => {
    const at = now();
    reply.header('Cache-Control', 'no-store');
    return {
      version: getVersion(db),
      serverTime: at.toISOString(),
      content: buildKioskContent(db, dataDir, at, getSettings(db)),
    };
  });

  app.get('/api/kiosk/events', (request, reply) => {
    if (sseClients >= MAX_SSE_CLIENTS) {
      reply.code(503).send({ errors: ['too many event-stream clients'] });
      return;
    }
    const ip = request.ip;
    if ((sseByIp.get(ip) ?? 0) >= (opts.maxSseClientsPerIp ?? MAX_SSE_PER_IP)) {
      reply.code(429).header('Retry-After', '5').send({ errors: ['too many event-stream clients from this address'] });
      return;
    }

    const res = reply.raw;
    reply.hijack();
    sseClients++;
    sseByIp.set(ip, (sseByIp.get(ip) ?? 0) + 1);

    res.writeHead(200, {
      ...securityHeaders((request.raw.socket as { encrypted?: boolean }).encrypted === true),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.socket?.setNoDelay(true);

    const identity = request.auth;
    const token = bearerToken(request);
    // The identity checked at connect must still be valid: a revoked device or cookie, an expired
    // session or a deactivated user ends the stream (checked on every event and every heartbeat).
    const stillValid = (): boolean => {
      if (identity === null) return false;
      try {
        if (identity.kind === 'kiosk') return identity.via === 'loopback' || resolveKiosk(request) !== null;
        return token !== null && resolveSession(db, token, now(), false) !== null;
      } catch {
        return false;
      }
    };

    const send = (version: number, check = true): void => {
      if (res.writableEnded || res.destroyed) return;
      if (check && !stillValid()) {
        cleanup();
        return;
      }
      res.write(`event: changed\ndata: ${JSON.stringify({ version })}\n\n`);
    };

    const sendLive = (live: KioskLive, check = true): void => {
      if (res.writableEnded || res.destroyed) return;
      if (check && !stillValid()) {
        cleanup();
        return;
      }
      res.write(`event: live
data: ${JSON.stringify(live)}

`);
    };

    // Send the current version once so a reconnecting kiosk catches up, then the current live state.
    send(getVersion(db), false);
    sendLive(liveSessions.kioskLive(), false);
    const unsubscribe = bus.on((version) => send(version));
    const unsubscribeLive = bus.onLive((live) => sendLive(live));
    const timer = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      if (!stillValid()) {
        cleanup();
        return;
      }
      res.write(': hb\n\n');
    }, heartbeatMs);
    timer.unref();

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      unsubscribe();
      unsubscribeLive();
      clearInterval(timer);
      clientCleanups.delete(cleanup);
      sseClients--;
      const left = (sseByIp.get(ip) ?? 1) - 1;
      if (left <= 0) sseByIp.delete(ip);
      else sseByIp.set(ip, left);
      if (!res.writableEnded && !res.destroyed) res.end();
    };

    clientCleanups.add(cleanup);
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
    res.on('close', cleanup);
  });

  app.get('/api/settings', async () => getSettings(db));

  app.put('/api/settings/:feature', async (request, reply) => {
    const { feature } = request.params as { feature: string };
    if (!isFeatureKey(feature)) {
      return reply.code(404).send({ errors: [`unknown feature ${feature}`] });
    }
    const patch = request.body ?? {};
    // MAXCOM system values (Lanjutan) are for the Pentadbir MAXCOM; the page being hidden is not the guard, this is.
    if (patchNeedsSystemWrite(feature, patch) && !identityCan(request.auth, 'system:write')) {
      const who = request.auth !== null && request.auth.kind === 'user' ? request.auth : null;
      authLog(db, now(), 'forbidden', false, { userId: who?.userId ?? null, deviceId: who?.deviceId ?? null, ip: request.ip, detail: 'system_write' });
      return reply.code(403).send({ errors: [MSG.forbidden] });
    }
    if (feature === 'surauInfo' && isPlain(patch) && typeof patch.logo === 'string' && patch.logo !== '' && /^[0-9a-f]{64}$/.test(patch.logo)) {
      const found = getAssetPath(db, dataDir, patch.logo);
      if (found === null) return reply.code(400).send({ errors: ['logo refers to an asset that does not exist'] });
      if (found.mime !== 'image/png' && found.mime !== 'image/jpeg') {
        return reply.code(400).send({ errors: ['logo must be a PNG or JPEG image'] });
      }
    }
    // An adjusted logo: render the wide and the square picture now; a bad adjustment is refused before saving.
    if (feature === 'surauInfo' && isPlain(patch) && isPlain(patch.logo) && validateFeatureSettings('surauInfo', { logo: patch.logo }).ok) {
      try {
        deriveImage(db, dataDir, 'logo', patch.logo as unknown as ImageRef);
        deriveImage(db, dataDir, 'logoSquare', patch.logo as unknown as ImageRef);
      } catch (error) {
        if (error instanceof AssetError) return reply.code(error.status).send({ errors: error.errors });
        if (error instanceof ImageAdjustError) {
          return reply.code(400).send({ errors: [`logo: ${error.message}`] });
        }
        throw error;
      }
    }
    const prayerFeature = feature === 'zone' || feature === 'location' || feature === 'prayerSources' || feature === 'prayerCalc';
    const guard = prayerFeature ? prayerSettingsGuard(db, feature, patch, now()) : {};
    if (guard.errors && guard.errors.length > 0) return reply.code(400).send({ errors: guard.errors });
    try {
      const versionBefore = getVersion(db);
      const before = prayerFeature ? getSettings(db)[feature as 'zone'] : undefined;
      const settings = putFeature(db, feature, patch, actorOf(request), deviceOf(request));
      if (prayerFeature) afterPrayerSettings(db, feature, before, settings[feature as 'zone'], prayerDeps);
      const versionAfter = getVersion(db);
      if (versionAfter !== versionBefore) bus.emit(versionAfter);
      // the kiosk hears about audio and on/off changes of the live at once
      if (feature === 'liveOnKiosk') liveSessions.publishKiosk();
      return guard.warnings && guard.warnings.length > 0 ? { ...settings, warnings: guard.warnings } : settings;
    } catch (error) {
      if (error instanceof SettingsError) {
        return reply.code(400).send({ errors: error.errors });
      }
      throw error;
    }
  });

  app.post('/api/prayer/import', async (request, reply) => {
    const body = request.body;
    if (!isPlain(body)) {
      return reply.code(400).send({ errors: ['body must be a JSON object'] });
    }
    const zone = body.zone;
    if (typeof zone !== 'string' || !ZONE.test(zone)) {
      return reply.code(400).send({ errors: ['zone must look like SGR01'] });
    }

    let days: PrayerDay[];
    if (typeof body.csv === 'string') {
      try {
        days = parseJakimCsv(body.csv);
      } catch (error) {
        return reply.code(400).send({ errors: [messageOf(error)] });
      }
    } else if (body.source === 'esolat') {
      const year = body.year;
      if (typeof year !== 'number' || !Number.isInteger(year) || year < 2020 || year > 2100) {
        return reply.code(400).send({ errors: ['year must be an integer 2020..2100'] });
      }
      try {
        days = await fetchEsolatYear(db, zone, year, fetchImpl);
      } catch (error) {
        // Upstream e-Solat failures are a bad gateway; our own validation is a 400.
        return reply.code(502).send({ errors: [messageOf(error)] });
      }
    } else {
      return reply
        .code(400)
        .send({ errors: ['body needs { zone, csv } or { zone, year, source: "esolat" }'] });
    }

    try {
      const result = importDays(db, zone, days, actorOf(request), deviceOf(request));
      bus.emit(getVersion(db));
      return result;
    } catch (error) {
      return reply.code(400).send({ errors: [messageOf(error)] });
    }
  });

  app.get('/api/surau/info', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const info = surauPublicInfo(db, now());
    const logo = surauLogoUrl(db, dataDir);
    return logo === null ? info : { ...info, logo };
  });

  app.get('/api/health', async (request) => {
    // Anonymous callers (and the kiosk) learn only that the box is up.
    // A linked box also names its cloud origin (`cloud`, the same one the enrolment payload carries), so the app can
    // reach the cloud when the box is away; absent when not linked, and never on the cloud itself.
    const cloudOrigin = role === 'box' ? enrolCloudOrigin(db) : undefined;
    const withCloud = <T extends object>(o: T): T & { cloud?: string } => (cloudOrigin === undefined ? o : { ...o, cloud: cloudOrigin });
    if (!identityCan(request.auth, 'health:read')) return withCloud({ ok: true, version: getVersion(db) });
    const count = (sql: string): number => Number(db.prepare(sql).get()?.n ?? 0);
    const prayer = prayerStatus({ db, now, autoFetch });
    return withCloud({
      ok: true,
      version: getVersion(db),
      tls: opts.tls ? certInfo(opts.tls, now()) : null,
      users: count('SELECT COUNT(*) AS n FROM users WHERE active = 1'),
      devices: count('SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL'),
      lockedUsers: Number(
        db.prepare('SELECT COUNT(*) AS n FROM users WHERE pin_locked_until > ?').get(now().toISOString())?.n ?? 0,
      ),
      daysAhead: prayer.daysAhead.resolved,
      prayer,
      autoFetch: autoFetch.status(),
      assetsBytes: assetsTotalBytes(db),
      appLock: appLockEnabled(db),
      live: liveSessions.healthBlock(),
      // the sync facts (was `cloud` before the origin took that name)
      sync: role === 'cloud' ? { role: 'cloud', sites: listSites(db), workerOutbox: outboxStatus(db) } : syncAgent !== null ? syncAgent.status() : { ...syncStatus(db, 'box'), state: 'idle' },
    });
  });

  // Another process (a CLI import, a user command) may write to the same database: no event reaches
  // this process's bus for that, so the version is re-read on a timer and announced when it moved.
  let lastVersion = getVersion(db);
  bus.on((v) => {
    lastVersion = v;
  });
  const versionTimer = setInterval(() => {
    try {
      const v = getVersion(db);
      if (v !== lastVersion) {
        lastVersion = v;
        bus.emit(v);
      }
    } catch {
      // The database may be closing.
    }
  }, opts.versionPollMs ?? DEFAULT_VERSION_POLL_MS);
  versionTimer.unref();

  registerAuthRoutes(app, {
    db,
    boxId,
    dataDir,
    now,
    limiters,
    tls: opts.tls ?? null,
    httpsPort: opts.httpsPort ?? 8443,
  });
  if (role === 'box') {
    // the box's identity key signs the setup and recovery QR; a box with no data folder (in-memory tests) gets a throwaway one
    const identity = realDataDir ? loadIdentity(dataDir) : ephemeralIdentity();
    registerStateRoutes(app, {
      db,
      dataDir,
      boxId,
      identity,
      now,
      tls: opts.tls ?? null,
      httpsPort: opts.httpsPort ?? 8443,
      realDataDir,
    });
    registerJoinRoutes(app, { db, dataDir, boxId, identity, now, limiters });
  }
  registerSyncRoutes(app, {
    db,
    boxId,
    dataDir,
    now,
    limiters,
    bus,
    role,
    ...(role === 'cloud'
      ? {
          link: createLinkHandler({
            db,
            now,
            sealKey,
            outbox: workerOutbox,
          }),
          claim: createClaimHandler({
            db,
            now,
            sealKey,
            outbox: workerOutbox,
            workerAdmin: opts.workerAdmin ?? null,
          }),
        }
      : {}),
  });
  // registered on both roles (the route table lists it); a box has no site keys, so it only ever answers 403 there
  registerSiteAssetRoute(app, { db, dataDir });
  app.post('/api/sync/run', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (role !== 'box' || syncAgent === null) return reply.code(404).send({ errors: ['not found'] });
    await syncAgent.runOnce();
    return syncAgent.status();
  });
  // Change history is kept 180 days on both sides; the trim runs a few minutes after start, then daily.
  const trimTimer = setInterval(() => {
    try {
      trimChangeLog(db, role, now());
    } catch (error) {
      console.error('change history trim failed', error);
    }
  }, 86_400_000);
  trimTimer.unref();
  const trimFirst = setTimeout(() => {
    try {
      trimChangeLog(db, role, now());
    } catch (error) {
      console.error('change history trim failed', error);
    }
  }, 300_000);
  trimFirst.unref();
  app.addHook('onClose', async () => {
    clearInterval(trimTimer);
    clearTimeout(trimFirst);
  });
  registerLiveRoutes(app, { sessions: liveSessions, proxy: webrtcProxy, lanIps, youtube: youtubeService });
  // the cloud's YouTube: the box's broadcast leg and the catch-up upload sessions (Plan 6 Task 5); 404 on a box
  registerYoutubeCloudRoutes(app, { role, db, now, youtube: youtubeService });
  registerPrayerRoutes(app, prayerDeps);
  registerContentRoutes(app, { db, bus, dataDir, actorOf });
  registerAssetRoutes(app, { db, dataDir, actorOf });
  registerFinanceRoutes(app, { db, dataDir, bus, role, surauId: DEFAULT_SURAU_ID, now, limiters, actorOf, deviceOf });
  registerSettingsTest(app, { db, fetchImpl, ...(opts.sourceTestTimeoutMs !== undefined ? { timeoutMs: opts.sourceTestTimeoutMs } : {}) });
  registerIslamicRoutes(app, {
    dataDir,
    fetchImpl,
    getReciter: () => String(getSettings(db).tilawah.reciter),
    getCacheMaxMb: () => Number(getSettings(db).tilawah.cacheMaxMb),
    getSourceUrls: () => sourceUrlsFrom(getSettings(db)),
    actorOf,
    logChange: (actor, action, detail) => {
      db.prepare(
        'INSERT INTO change_log (at, actor, entity, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, NULL, ?)',
      ).run(now().toISOString(), actor, 'islamic', action, JSON.stringify({ detail }));
    },
  });

  // HadeethEnc through the box (Plan 14): every request goes through `fetchImpl` (guardedFetch in production)
  // to the address in `dataSources.hadeethenc`. The timers run on the box role only.
  const hadisClient = lazyHadeethEnc(() => createHadeethEnc(fetchImpl, sourceUrlsFrom(getSettings(db)).hadeethenc));
  const hadisLog = (action: string, detail: string): void => {
    db.prepare(
      'INSERT INTO change_log (at, actor, entity, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, NULL, ?)',
    ).run(now().toISOString(), 'local', action, 'catalog', JSON.stringify({ detail }));
  };
  const hadisJob = createCatalogJob({ db, client: hadisClient, now, onLog: hadisLog });
  registerHadisRoutes(app, {
    db,
    bus,
    role,
    client: () => hadisClient,
    job: hadisJob,
    actorOf,
    now,
    logChange: (actor, action, detail) => {
      db.prepare(
        'INSERT INTO change_log (at, actor, entity, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, NULL, ?)',
      ).run(now().toISOString(), actor, action, 'catalog', JSON.stringify({ detail }));
    },
  });
  const stopHadisTimers = opts.hadisTimers
    ? startHadisTimers({ db, role, client: hadisClient, job: hadisJob, now, onLog: hadisLog, onChange: () => bus.emit(getVersion(db)), ...opts.hadisTimers })
    : null;
  app.addHook('onClose', async () => {
    stopHadisTimers?.();
    hadisJob.stop();
  });

  const staticDir = typeof opts.staticDir === 'string' ? opts.staticDir : null;
  const hasStatic = staticDir !== null && existsSync(staticDir);
  if (hasStatic) {
    app.register(fastifyStatic, {
      root: staticDir,
      prefix: '/',
      wildcard: true,
      index: ['index.html'],
      // The service worker and the shell document must always be revalidated so an
      // update is picked up. (cacheControl: false stops the plugin overwriting this
      // header; other files keep its default value.)
      cacheControl: false,
      setHeaders: (res, filePath) => {
        const name = basename(filePath);
        res.header(
          'Cache-Control',
          name === 'sw.js' || name === 'index.html' ? 'no-cache' : 'public, max-age=0',
        );
      },
    });
  }

  const appDir = typeof opts.appDir === 'string' ? opts.appDir : null;
  const hasApp = appDir !== null && existsSync(appDir);
  registerSurauLogoRoutes(app, { db, dataDir, appDir: hasApp ? appDir : null });
  if (hasApp) {
    registerAppStatic(app, appDir, () => {
      // the web shell may call the cloud the box is linked to (or the operator's env address); the synced
      // cloudSync.cloudUrl setting never widens the CSP
      const fromLink = (db.prepare("SELECT value FROM sync_state WHERE key = 'cloud_url'").get()?.value as string | undefined) ?? '';
      return [fromLink, opts.cloud?.url ?? ''].map((u) => {
        try { return u === '' ? '' : new URL(u).origin; } catch { return ''; }
      }).filter((o) => o !== '');
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const url = request.raw.url ?? '/';
    const path = url.split('?')[0] ?? '/';
    const isApi = path === '/api' || path.startsWith('/api/');
    const isGet = request.method === 'GET' || request.method === 'HEAD';
    const lastSegment = path.slice(path.lastIndexOf('/') + 1);
    const looksLikeFile = /\.[A-Za-z0-9]+$/.test(lastSegment);
    if (hasStatic && !isApi && isGet && !looksLikeFile && !(hasApp && isAppPath(path))) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ errors: [`not found: ${request.method} ${url}`] });
  });

  app.addHook('onClose', async () => {
    syncAgent?.stop();
    await live?.stop();
  });

  app.addHook('onClose', async () => {
    // an open live session ends cleanly (publisher user removed, broadcast completed) before the database closes
    await liveSessions.shutdown().catch(() => undefined);
    youtubeService?.shutdown();
    clearInterval(versionTimer);
    autoFetch.stop();
    for (const cleanup of [...clientCleanups]) {
      try {
        cleanup();
      } catch {
        // Cleanup is best-effort while shutting down.
      }
    }
    db.close();
  });

  return app;
}
