import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest, FastifyServerFactory } from 'fastify';
import fastifyStatic from '@fastify/static';
import { KIOSK_TEMPLATE_IDS, THEME_CONTRACT, dateOf, hasOfficialSource, isFeatureKey, parseJakimCsv, patchNeedsSystemWrite, tzOf, validateFeatureSettings } from '@surau/core';
import type { ImageRef } from '@surau/core';
import type { KioskLive, PrayerDay } from '@surau/core';
import { actorOf, deviceOf } from './actor.ts';
import { isAppPath, registerAppStatic } from './appStatic.ts';
import { registerAssetRoutes } from './assets/routes.ts';
import { registerThemeRoutes } from './themes/routes.ts';
import { createThemeStore } from './themes/store.ts';
import { activeThemeHealth, themeOk } from './themes/health.ts';
import { registerFinanceRoutes } from './finance/routes.ts';
import { NEUTRAL_SURAU_ID, healthScopeOf, publicSurauOf, reqSurau, timerSurauIds } from './reqSurau.ts';
import { LOCAL_SURAU_ID } from './tenant.ts';
import { assetsTotalBytes } from './assets/store.ts';
import { surauHoldsAsset } from './surau/storage.ts';
import { attachPinPepper, derivePinPepper } from './auth/crypto.ts';
import { authHook, bearerToken, createLimiters, identityCan, isDirectLoopback, parseKioskToken } from './auth/authz.ts';
import type { KioskAuth, Limiters } from './auth/authz.ts';
import { createKioskResolver } from './auth/pairing.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import { registerFleetRoutes } from './surau/routes.ts';
import { autoPruneDays, startAutoPrune } from './surau/prune.ts';
import { authLog, resolveSession } from './auth/sessions.ts';
import { boxId as boxIdOf, loadBoxKey } from './auth/secrets.ts';
import { appLockEnabled } from './auth/appLock.ts';
import { AuthError, MSG, setServerBoxId, setUsersRole } from './auth/users.ts';
import { backfillIds } from './auth/ids.ts';
import { certInfo } from './tls.ts';
import { boxNameOf } from './boxName.ts';
import type { TlsMaterial } from './tls.ts';
import { hkdfSync, randomBytes } from 'node:crypto';
import type { FirewallState } from './live/firewall.ts';
import { createLiveRuntime } from './live/mediamtx.ts';
import type { LiveToolsOption } from './live/mediamtx.ts';
import { CameraStore, CameraTester, fileLogTail } from './live/camera.ts';
import { localAddresses } from './live/onvif.ts';
import { AudioInputs, registerAudioInputRoutes } from './live/audioInputs.ts';
import { registerCameraRoutes } from './live/cameraRoutes.ts';
import { registerLiveRoutes } from './live/routes.ts';
import { LiveSessions } from './live/sessions.ts';
import type { RelayOptions } from './live/relay.ts';
import type { YoutubeLeg } from './live/sessions.ts';
import { createWebrtcProxy } from './live/webrtcProxy.ts';
import { createYoutubeService } from './live/youtube/api.ts';
import { registerYoutubeCloudRoutes } from './sync/youtubeCloud.ts';
import { createYoutubeRegistry } from './live/youtube/registry.ts';
import type { YoutubeRegistry } from './live/youtube/registry.ts';
import { registerCameraSecretCloudRoutes } from './sync/cameraSecretCloud.ts';
import { attachCameraSecretSync } from './sync/cameraSecretBox.ts';
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
import { EsolatError } from './jakimFetch.ts';
import { applyOfficialCsv } from './prayer/importFile.ts';
import { registerPrayerRoutes } from './prayer/index.ts';
import { afterPrayerSettings, prayerSettingsGuard } from './prayer/settingsGuard.ts';
import { addDays as addCalendarDays, resolveDays, sourceLine } from './prayer/resolve.ts';
import { prayerStatus } from './prayer/routes.ts';
import { getSettings, getVersion, putFeature, SettingsError, surauPublicInfo } from './settingsStore.ts';
import { applySurauIni } from './surauIni.ts';
import { registerSettingsTest } from './settingsTest.ts';
import { registerIosProfileRoutes, DEFAULT_CLOUD_ORIGIN } from './iosProfile.ts';
import { registerSurauLogoRoutes, kioskLogoAssetId, surauLogoUrl } from './surauLogo.ts';
import { deriveImage, ImageAdjustError } from './imageAdjust.ts';
import { AssetError, getAssetPath } from './assets/store.ts';
import { SyncAgent } from './sync/agent.ts';
import { registerCors } from './sync/cors.ts';
import { registerSyncRoutes, syncStatus } from './sync/routes.ts';
import { ephemeralIdentity, loadIdentity } from './setup/identity.ts';
import { registerJoinRoutes } from './setup/joinRoutes.ts';
import { registerCloudInfoRoute, registerStateRoutes } from './setup/stateRoutes.ts';
import { createClaimHandler, createLinkHandler, enrolCloudOrigin, listSites, noteThemeSupport, registerSiteAssetRoute } from './sync/sites.ts';
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
  /** The live TLS material (follows a certificate reload); defaults to `tls`. */
  tlsNow?: () => TlsMaterial | null;
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
   * Cloud role only: the daily prune of empty suraus (older than `days`, default env MAXCOM_AUTO_PRUNE_DAYS or 7; 0 =
   * off), with a database backup first. Left out, no timer runs (tests, the CLI).
   */
  autoPrune?: { days?: number; firstDelayMs?: number; intervalMs?: number };
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

/** The only `/api/box/` route the cloud answers (a minimal public body, see registerCloudInfoRoute). */
const CLOUD_BOX_INFO_PATH = '/api/box/info';

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

/**
 * The `bgImage` references of a themeStyle.styles patch that are new or changed compared with `stored` (the
 * stored styles map), each with where it sits. An unchanged old reference is not listed: a picture that was
 * removed since then must not block an unrelated save (the kiosk falls back to the next layer).
 */
function newStyleBgImages(styles: Record<string, unknown>, stored: unknown): { id: string; theme: string; screen: string }[] {
  const out: { id: string; theme: string; screen: string }[] = [];
  const old = isPlain(stored) ? stored : {};
  const take = (v: unknown, was: unknown, theme: string, screen: string): void => {
    if (!isPlain(v) || typeof v.bgImage !== 'string') return;
    if (isPlain(was) && was.bgImage === v.bgImage) return;
    out.push({ id: v.bgImage, theme, screen });
  };
  for (const [theme, entry] of Object.entries(styles)) {
    if (!isPlain(entry)) continue;
    const was = isPlain(old[theme]) ? old[theme] : {};
    take(entry.semua, was.semua, theme, 'all screens');
    if (isPlain(entry.skrin)) {
      const wasSkrin = isPlain(was.skrin) ? was.skrin : {};
      for (const [screen, v] of Object.entries(entry.skrin)) take(v, wasSkrin[screen], theme, screen);
    }
  }
  return out;
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
  // Number every user and device that has no ID yet (migration 022 only adds the columns: the series depends on the role).
  backfillIds(db, role);
  // A box sends the official days it already held before they replicated; a cloud only receives them.
  if (role === 'box') backfillOfficialFeed(db, now(), LOCAL_SURAU_ID);
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
  // A box stamps its own id on every device it enrols (the box the phone signs for); the cloud stamps the sending site's.
  setServerBoxId(db, boxId);
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
      // GET /api/box/info is the one exception: MAXCOM Ops reads the cloud's own id from it before it enrols
      if (path === CLOUD_BOX_INFO_PATH && request.method === 'GET') return undefined;
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
  app.decorateRequest('tenant', null);
  app.addHook('onRequest', authHook({ db, now, limiters, resolveKiosk, role }));
  // The cloud learns which theme contract each linked box supports from the header its sync agent sends.
  if (role === 'cloud') {
    app.addHook('onRequest', async (request) => {
      if (request.auth?.kind === 'site') noteThemeSupport(db, request.auth.boxId, request.headers['x-maxcom-themes']);
    });
  }
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
  // On the cloud every surau has its own sign-in (L1): a registry of services, one token file each. A box has one.
  const noDataFolder = dbPath === ':memory:' && opts.dataDir === undefined;
  const youtubeRegistry: YoutubeRegistry | null =
    role === 'cloud' && opts.live?.youtube === undefined && !noDataFolder ? createYoutubeRegistry({ db, dataDir, fetchImpl, now }) : null;
  const localYoutube: YoutubeLeg | null =
    opts.live?.youtube ??
    (noDataFolder ? null : youtubeRegistry !== null ? youtubeRegistry.for(LOCAL_SURAU_ID) : createYoutubeService({ db, dataDir, fetchImpl, now, role }));
  const youtubeService: YoutubeService | null = localYoutube !== null && 'begin' in localYoutube ? (localYoutube as YoutubeService) : null;
  /** The YouTube service of one surau: the registry's on the cloud, the box's own otherwise. */
  const youtubeFor = (surauId: string): YoutubeService | null => (youtubeRegistry !== null ? youtubeRegistry.for(surauId) : youtubeService);
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
          waitBudgetMs: opts.sync?.youtubeWaitMs ?? ((): number => Number(getSettings(db, LOCAL_SURAU_ID).system.cloudWakeSeconds) * 1000),
        })
      : null;
  // stored YouTube completes are retried on every sync agent cycle too
  if (youtubeRemote !== null) syncAgent?.setCycleHook(() => void youtubeRemote.retryPending());
  const youtube: YoutubeLeg | null =
    youtubeRemote !== null && localYoutube !== null ? new CloudOrLocalLeg(youtubeRemote, localYoutube, () => youtubeRemote.active()) : localYoutube;
  app.addHook('onClose', async () => youtubeRemote?.stop());
  // "Mic-in pada kotak" (M1): the box's own capture devices; listed once at start so the combiner finds the name at once
  const audioInputs = new AudioInputs({
    ffmpegPath: () => live?.runtime.tools.ffmpeg ?? null,
    ...(dbPath === ':memory:' && opts.dataDir === undefined ? {} : { dataDir }),
    isLive: () => liveSessions.status().session !== null,
  });
  if (live) app.addHook('onReady', async () => void audioInputs.list().catch(() => undefined));
  const liveSessions = new LiveSessions({
    db,
    now,
    runtime: live?.runtime ?? null,
    onKiosk: (k) => {
      // MediaMTX closes the kiosk's viewers when the picture goes away: forget their slots
      if (!k.live) webrtcProxy.resetWhep();
      bus.emitLive(k, LOCAL_SURAU_ID);
    },
    youtube,
    firewall: opts.liveFirewall ?? null,
    boxInput: () => audioInputs.boxInput(),
    // the no-video warning delay: `system.noVideoSeconds`, read at every check (a test may pin it)
    noVideoMs: opts.live?.noVideoMs ?? ((): number => Number(getSettings(db, LOCAL_SURAU_ID).system.noVideoSeconds) * 1000),
    ...(dbPath === ':memory:' && opts.dataDir === undefined ? {} : { dataDir }),
    ...(opts.live?.relay !== undefined ? { relayOptions: opts.live.relay } : {}),
    ...(opts.live?.monitorMs !== undefined ? { monitorMs: opts.live.monitorMs } : {}),
    ...(opts.live?.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.live.idleTimeoutMs } : {}),
    ...(opts.live?.reprovisionMs !== undefined ? { reprovisionMs: opts.live.reprovisionMs } : {}),
  });
  // a broadcast an earlier run left open (crash, power cut) is ended now, in the background
  // (the cloud makes the broadcasts of a linked box, so it ends the ones a crash left open too)
  // (the cloud's services recover as they are made)
  if (youtubeService !== null && youtubeRegistry === null) app.addHook('onReady', async () => void youtubeService.recover());
  // The cloud has no live of its own: a broadcast the box has not mentioned for 6 hours is an orphan (the box
  // is gone or its complete was lost for good). A daily sweep ends those; the first one runs an hour after start,
  // so the box's status calls after a cloud restart have time to show that its live is still going.
  if (role === 'cloud' && (youtubeRegistry !== null || youtubeService !== null)) {
    const sweep = (): void => {
      for (const svc of youtubeRegistry !== null ? youtubeRegistry.all() : [youtubeService!]) void svc.sweepOrphans().catch(() => undefined);
    };
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
      return reply.code(error.status).header('Cache-Control', 'no-store').send({ ...(error.extra ?? {}), errors: [error.message], code: error.code });
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
    onChanged: (version, surauId) => bus.emit(version, surauId),
    surauIds: () => timerSurauIds(db, role),
    // a surau whose box is linked fetches on that box and receives the days by sync; the cloud does not fetch twice
    ...(role === 'cloud'
      ? { skipSurau: (surauId: string): boolean => db.prepare('SELECT 1 FROM sites WHERE surau_id = ? AND linked_at IS NOT NULL AND revoked_at IS NULL').get(surauId) !== undefined }
      : {}),
    ...(opts.autoPrayerFetch?.firstDelayMs !== undefined ? { firstDelayMs: opts.autoPrayerFetch.firstDelayMs } : {}),
    ...(opts.autoPrayerFetch?.intervalMs !== undefined ? { intervalMs: opts.autoPrayerFetch.intervalMs } : {}),
  });
  // a box tops up its one surau; the cloud, each surau it has
  if (opts.autoPrayerFetch) autoFetch.start();
  const prayerDeps = { db, dataDir, now, fetchImpl, bus, autoFetch, autoFetchOn: opts.autoPrayerFetch !== undefined, role, limiters, ...(opts.nominatimMinIntervalMs !== undefined ? { nominatimMinIntervalMs: opts.nominatimMinIntervalMs } : {}) };

  let sseClients = 0;
  const sseByIp = new Map<string, number>();
  const clientCleanups = new Set<() => void>();

  app.get('/api/kiosk/bundle', async (request, reply) => {
    const surauId = reqSurau(request);
    const settings = getSettings(db, surauId);
    const zone = String(settings.zone.zone);
    const tz = tzOf(settings);
    const at = now();
    const today = dateOf(at, tz);
    // Each day carries where its times come from; the kiosk shows the source line and the gold band from these.
    // Every row carries its own source line: the kiosk reads today's from the row of the day it is on, so the
    // footer is right after midnight without fetching the bundle again.
    const days = resolveDays(db, settings, addCalendarDays(today, -1), addCalendarDays(today, 40), surauId)
      .map((d) => ({ ...d, footerMs: sourceLine(settings, d, 'ms'), footerEn: sourceLine(settings, d, 'en') }));
    const todayDay = days.find((d) => d.date === today);
    const prayer = {
      country: settings.location.country,
      hasOfficial: hasOfficialSource(settings.location.country),
      timezone: tz,
      utcOffsetMinutes: surauPublicInfo(db, at, surauId).utcOffsetMinutes,
      footerMs: todayDay ? sourceLine(settings, todayDay, 'ms') : '',
      footerEn: todayDay ? sourceLine(settings, todayDay, 'en') : '',
    };
    reply.header('Cache-Control', 'no-store');
    // The kiosk loads plain asset ids: its copy of the settings carries the derived wide logo, not the adjustment.
    const kioskSettings = { ...settings, surauInfo: { ...settings.surauInfo, logo: kioskLogoAssetId(db, dataDir, surauId) } };
    return { version: getVersion(db, surauId), zone, days, prayer, settings: kioskSettings, logo: surauLogoUrl(db, dataDir, surauId), serverTime: at.toISOString() };
  });

  app.get('/api/kiosk/content', async (request, reply) => {
    const surauId = reqSurau(request);
    const at = now();
    reply.header('Cache-Control', 'no-store');
    return {
      version: getVersion(db, surauId),
      serverTime: at.toISOString(),
      content: buildKioskContent(db, dataDir, at, getSettings(db, surauId), surauId),
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

    const surauId = reqSurau(request);
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
    send(getVersion(db, surauId), false);
    sendLive(liveSessions.kioskLive(), false);
    const unsubscribe = bus.on((version) => send(version), surauId);
    const unsubscribeLive = bus.onLive((live) => sendLive(live), surauId);
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

  app.get('/api/settings', async (request) => getSettings(db, reqSurau(request)));

  app.put('/api/settings/:feature', async (request, reply) => {
    const { feature } = request.params as { feature: string };
    if (!isFeatureKey(feature)) {
      return reply.code(404).send({ errors: [`unknown feature ${feature}`] });
    }
    const surauId = reqSurau(request);
    const patch = request.body ?? {};
    // MAXCOM system values (Lanjutan) are for the Pentadbir MAXCOM; the page being hidden is not the guard, this is.
    if (patchNeedsSystemWrite(feature, patch) && !identityCan(request.auth, 'system:write')) {
      const who = request.auth !== null && request.auth.kind === 'user' ? request.auth : null;
      authLog(db, now(), 'forbidden', false, { userId: who?.userId ?? null, deviceId: who?.deviceId ?? null, ip: request.ip, detail: 'system_write' });
      return reply.code(403).send({ errors: [MSG.forbidden] });
    }
    if (feature === 'surauInfo' && isPlain(patch) && typeof patch.logo === 'string' && patch.logo !== '' && /^[0-9a-f]{64}$/.test(patch.logo)) {
      const found = surauHoldsAsset(db, role, surauId, patch.logo) ? getAssetPath(db, dataDir, patch.logo) : null;
      if (found === null) return reply.code(400).send({ errors: ['logo refers to an asset that does not exist'] });
      if (found.mime !== 'image/png' && found.mime !== 'image/jpeg') {
        return reply.code(400).send({ errors: ['logo must be a PNG or JPEG image'] });
      }
    }
    // An adjusted logo: render the wide and the square picture now; a bad adjustment is refused before saving.
    if (feature === 'surauInfo' && isPlain(patch) && isPlain(patch.logo) && validateFeatureSettings('surauInfo', { logo: patch.logo }).ok) {
      try {
        deriveImage(db, dataDir, 'logo', patch.logo as unknown as ImageRef, undefined, surauId);
        deriveImage(db, dataDir, 'logoSquare', patch.logo as unknown as ImageRef, undefined, surauId);
      } catch (error) {
        if (error instanceof AssetError) return reply.code(error.status).send({ errors: error.errors });
        if (error instanceof ImageAdjustError) {
          return reply.code(400).send({ errors: [`logo: ${error.message}`] });
        }
        throw error;
      }
    }
    // Menu backgrounds must be pictures this box holds; a missing one is refused, not stored.
    if (feature === 'themeStyle' && isPlain(patch) && isPlain(patch.styles)) {
      for (const ref of newStyleBgImages(patch.styles, getSettings(db, surauId).themeStyle.styles)) {
        const found = surauHoldsAsset(db, role, surauId, ref.id) ? getAssetPath(db, dataDir, ref.id) : null;
        if (found === null || (found.mime !== 'image/jpeg' && found.mime !== 'image/png' && found.mime !== 'image/webp')) {
          return reply.code(400).send({ errors: [`bgImage refers to a picture that does not exist (theme ${ref.theme}, screen ${ref.screen})`] });
        }
      }
    }
    // On the cloud a theme file named by a pack record must be one this surau holds (a box has one surau; every asset is its own).
    if (role === 'cloud' && feature === 'themeStyle' && isPlain(patch) && isPlain(patch.packs)) {
      for (const rec of Object.values(patch.packs)) {
        if (isPlain(rec) && typeof rec.assetId === 'string' && !surauHoldsAsset(db, role, surauId, rec.assetId)) {
          return reply.code(400).send({ errors: ['a theme file refers to an asset that does not exist'] });
        }
      }
    }
    const prayerFeature = feature === 'zone' || feature === 'location' || feature === 'prayerSources' || feature === 'prayerCalc';
    const guard = prayerFeature ? prayerSettingsGuard(db, feature, patch, now(), surauId, opts.autoPrayerFetch !== undefined) : {};
    if (guard.errors && guard.errors.length > 0) return reply.code(400).send({ errors: guard.errors });
    try {
      const versionBefore = getVersion(db, surauId);
      const before = prayerFeature ? getSettings(db, surauId)[feature as 'zone'] : undefined;
      const settings = putFeature(db, feature, patch, actorOf(request), deviceOf(request), surauId);
      if (prayerFeature) afterPrayerSettings(db, feature, before, settings[feature as 'zone'], prayerDeps, surauId);
      const versionAfter = getVersion(db, surauId);
      if (versionAfter !== versionBefore) bus.emit(versionAfter, surauId);
      // the kiosk hears about audio and on/off changes of the live at once
      if (feature === 'liveOnKiosk' && surauId === LOCAL_SURAU_ID) liveSessions.publishKiosk();
      return guard.warnings && guard.warnings.length > 0 ? { ...settings, warnings: guard.warnings, ...(guard.warningCodes ? { warningCodes: guard.warningCodes } : {}) } : settings;
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
    const surauId = reqSurau(request);
    // JAKIM data is for a country that has an official source; a surau elsewhere is never offered it
    if (!hasOfficialSource(getSettings(db, surauId).location.country)) {
      return reply.code(409).send({ errors: ['Negara ini tiada sumber rasmi; gunakan fail atau kiraan'], code: 'no_official_source' });
    }

    let days: PrayerDay[];
    let csvYear: number | null = null;
    if (typeof body.csv === 'string') {
      if (body.year !== undefined) {
        if (typeof body.year !== 'number' || !Number.isInteger(body.year) || body.year < 2020 || body.year > 2100) {
          return reply.code(400).send({ errors: ['year must be an integer 2020..2100'] });
        }
        csvYear = body.year;
      }
      try {
        days = parseJakimCsv(body.csv);
      } catch (error) {
        return reply.code(400).send({ errors: [messageOf(error)] });
      }
      // The chosen year is enforced: a file for another year is refused whole, nothing is written.
      if (csvYear !== null && days.length > 0 && days.some((d) => !d.date.startsWith(`${csvYear}-`))) {
        const dates = days.map((d) => d.date).sort();
        return reply.code(400).send({
          errors: [`Fail ini bukan untuk tahun ${csvYear} (${dates[0]} hingga ${dates[dates.length - 1]})`],
          code: 'csv_year_mismatch',
          detail: { year: csvYear, from: dates[0], to: dates[dates.length - 1] },
        });
      }
    } else if (body.source === 'esolat') {
      const year = body.year;
      if (typeof year !== 'number' || !Number.isInteger(year) || year < 2020 || year > 2100) {
        return reply.code(400).send({ errors: ['year must be an integer 2020..2100'] });
      }
      try {
        days = await fetchEsolatYear(db, zone, year, fetchImpl, surauId);
      } catch (error) {
        // Upstream e-Solat failures are a bad gateway; our own validation is a 400.
        return reply.code(502).send({
          errors: [messageOf(error)],
          code: error instanceof EsolatError ? error.code : 'esolat_unreachable',
          ...(error instanceof EsolatError ? { detail: error.detail } : {}),
        });
      }
    } else {
      return reply
        .code(400)
        .send({ errors: ['body needs { zone, csv } or { zone, year, source: "esolat" }'] });
    }

    try {
      // a pasted official file is recorded with what it replaced, so it can be undone from the import records
      const result = typeof body.csv === 'string' && days.length > 0
        ? applyOfficialCsv(db, zone, days, actorOf(request), deviceOf(request), now(), surauId)
        : importDays(db, zone, days, actorOf(request), deviceOf(request), undefined, surauId);
      bus.emit(getVersion(db, surauId), surauId);
      return result;
    } catch (error) {
      return reply.code(400).send({ errors: [messageOf(error)] });
    }
  });

  // Public. A box answers for its own surau. The cloud answers for the surau of the linked site named by the header
  // `X-Maxcom-Box` and the neutral MAXCOM answer for anything else, after the same lookups (no enumeration).
  app.get('/api/surau/info', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const target = publicSurauOf(db, request, role);
    const sid = target ?? NEUTRAL_SURAU_ID;
    const info = surauPublicInfo(db, now(), sid);
    const logo = surauLogoUrl(db, dataDir, sid);
    if (target === null) return { ...info, name: 'MAXCOM' };
    return logo === null ? info : { ...info, logo };
  });

  const tlsNow = (): TlsMaterial | null => (opts.tlsNow !== undefined ? opts.tlsNow() : (opts.tls ?? null));
  app.get('/api/health', async (request) => {
    // Anonymous callers (and the kiosk) learn only that the box is up.
    // A linked box also names its cloud origin (`cloud`, the same one the enrolment payload carries), so the app can
    // reach the cloud when the box is away; absent when not linked, and never on the cloud itself.
    const cloudOrigin = role === 'box' ? enrolCloudOrigin(db) : undefined;
    const themes = { contract: THEME_CONTRACT, builtIn: [...KIOSK_TEMPLATE_IDS] };
    const withCloud = <T extends object>(o: T): T & { cloud?: string } => (cloudOrigin === undefined ? o : { ...o, cloud: cloudOrigin });
    // the numbered local name (public: it is a certificate DNS name), null on a legacy root; not on the cloud
    const localName = role === 'box' ? boxNameOf(tlsNow()) : null;
    // The theme state is for the box's own machine (the setup doctor reads it on loopback) and for an admin; a caller across the network learns nothing about the theme.
    // Proxy-aware (a caller behind cloudflared reaches us from 127.0.0.1 too) and only on a box: the cloud has no display of its own.
    const onThisMachine = role === 'box' && isDirectLoopback(request);
    if (!identityCan(request.auth, 'health:read')) {
      // Anonymous: only that it is up, and (cloud) for the surau of the named linked box; never a list of sites.
      return withCloud({ ok: true, version: getVersion(db, publicSurauOf(db, request, role) ?? NEUTRAL_SURAU_ID), name: localName, themes, ...(onThisMachine ? { themeOk: themeOk(db) } : {}) });
    }
    const scope = healthScopeOf(db, request, role);
    const surauId = scope.surauId;
    // The cloud counts only the caller's surau (the Pentadbir MAXCOM on an ops device counts everything).
    const own = !scope.all;
    const count = (sql: string, ...args: string[]): number => Number(db.prepare(sql).get(...args)?.n ?? 0);
    const prayer = prayerStatus({ db, now, autoFetch }, surauId);
    return withCloud({
      ok: true,
      version: getVersion(db, surauId),
      name: localName,
      themes,
      // The theme state is the box's own display; the cloud has none (its themeStyle is per surau and never reported on).
      ...(role === 'box' ? { themeOk: themeOk(db), themeHealth: activeThemeHealth(db) } : {}),
      tls: tlsNow() ? certInfo(tlsNow()!, now()) : null,
      users: own ? count('SELECT COUNT(*) AS n FROM users WHERE active = 1 AND surau_id = ?', surauId) : count('SELECT COUNT(*) AS n FROM users WHERE active = 1'),
      devices: own ? count("SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL AND surau_id = ? AND user_id NOT IN (SELECT id FROM users WHERE surau_id = '*')", surauId) : count('SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL'),
      lockedUsers: own
        ? count('SELECT COUNT(*) AS n FROM users WHERE pin_locked_until > ? AND deleted_at IS NULL AND surau_id = ?', now().toISOString(), surauId)
        : count('SELECT COUNT(*) AS n FROM users WHERE pin_locked_until > ? AND deleted_at IS NULL', now().toISOString()),
      // where official data exists, only official and file days count (a calculated day is a fallback and must not hide missing data)
      daysAhead: prayer.hasOfficial ? prayer.daysAhead.official + prayer.daysAhead.file : prayer.daysAhead.resolved,
      prayer,
      autoFetch: autoFetch.status(surauId),
      // the cloud counts only what the caller's surau holds (`surau_assets`); a box, or the ops view, the whole store
      assetsBytes: role === 'cloud' && own ? count('SELECT COALESCE(SUM(bytes), 0) AS n FROM surau_assets WHERE surau_id = ?', surauId) : assetsTotalBytes(db),
      appLock: appLockEnabled(db, surauId),
      live: liveSessions.healthBlock(),
      // the sync facts (was `cloud` before the origin took that name)
      sync: role === 'cloud' ? { role: 'cloud', sites: listSites(db, scope.all ? undefined : surauId), workerOutbox: outboxStatus(db) } : syncAgent !== null ? syncAgent.status() : { ...syncStatus(db, 'box'), state: 'idle' },
    });
  });

  // Another process (a CLI import, a user command) may write to the same database: no event reaches
  // this process's bus for that, so the version is re-read on a timer and announced when it moved.
  // One version per surau (a box has one; the cloud one for each surau it has).
  const lastVersions = new Map<string, number>();
  const pollVersions = (announce: boolean): void => {
    for (const id of timerSurauIds(db, role)) {
      const v = getVersion(db, id);
      const before = lastVersions.get(id);
      lastVersions.set(id, v);
      if (announce && before !== undefined && v !== before) bus.emit(v, id);
    }
  };
  pollVersions(false);
  bus.on((v, id) => {
    lastVersions.set(id, v);
  });
  const versionTimer = setInterval(() => {
    try {
      pollVersions(true);
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
    tlsNow,
    httpsPort: opts.httpsPort ?? 8443,
    role,
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
      tlsNow,
      httpsPort: opts.httpsPort ?? 8443,
      realDataDir,
    });
    registerJoinRoutes(app, { db, dataDir, boxId, identity, now, limiters });
  } else {
    registerCloudInfoRoute(app, { boxId, now });
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
  // Plan 14 Task 10: the MAXCOM Ops fleet routes work on the cloud only (a box answers every one of them 404)
  // a deleted surau leaves no timer or cache entry behind that could bring a row back
  const forgetSurau = (surauId: string): void => {
    autoFetch.forget(surauId);
    lastVersions.delete(surauId);
  };
  registerFleetRoutes(app, { db, now, workerAdmin: opts.workerAdmin ?? null, role, onSurauDeleted: forgetSurau });
  if (role === 'cloud' && opts.autoPrune !== undefined && dbPath !== ':memory:') {
    const stopPrune = startAutoPrune({
      db,
      now,
      days: opts.autoPrune.days ?? autoPruneDays(),
      backupDir: join(dirname(resolve(dbPath)), 'backups'),
      onDeleted: forgetSurau,
      ...(opts.autoPrune.firstDelayMs !== undefined ? { firstDelayMs: opts.autoPrune.firstDelayMs } : {}),
      ...(opts.autoPrune.intervalMs !== undefined ? { intervalMs: opts.autoPrune.intervalMs } : {}),
    });
    app.addHook('onClose', async () => {
      stopPrune();
    });
  }
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
  registerLiveRoutes(app, { sessions: liveSessions, proxy: webrtcProxy, lanIps, youtube: youtubeService, youtubeFor, cloud: role === 'cloud' });
  if (role === 'box') registerAudioInputRoutes(app, { db, inputs: audioInputs });
  // the external camera: sealed address, the box's own test (a box with a data folder only)
  if (role === 'box' && realDataDir) {
    // every address of every local interface is the box itself (the certificate list alone misses some)
    const selfIps = [...new Set([...lanIps, ...localAddresses()])];
    const cameraStore = new CameraStore(dataDir, { boxIps: selfIps, now });
    liveSessions.attachCamera(cameraStore); // the box pulls the saved camera for an iPad or web live
    const cameraTester = live ? new CameraTester({ api: () => live.runtime.api, log: fileLogTail(dataDir), secrets: live.runtime.secrets, now }) : null;
    liveSessions.attachCameraBusy(cameraTester !== null ? () => cameraTester.busy : null);
    registerCameraRoutes(app, {
      db,
      store: cameraStore,
      tester: cameraTester,
      sessions: liveSessions,
      limiters,
      boxIps: selfIps,
    });
    attachCameraSecretSync(app, { db, dataDir, now, boxIps: selfIps, fetchImpl: opts.sync?.fetchImpl, cloudUrl: opts.cloud?.url, wake: syncAgent !== null ? () => syncAgent!.wakeNow() : undefined, auto: opts.sync?.auto });
  }
  // the cloud's YouTube: the box's broadcast leg and the catch-up upload sessions (Plan 6 Task 5); 404 on a box
  registerYoutubeCloudRoutes(app, { role, db, now, youtube: youtubeService, youtubeFor });
  // the sealed backup of the camera address: cloud routes (404 on a box), and the box's push and restore (B5)
  registerCameraSecretCloudRoutes(app, { role, db, now, masterKey: role === 'cloud' && realDataDir ? loadBoxKey(dataDir) : null });
  registerPrayerRoutes(app, prayerDeps);
  registerContentRoutes(app, { db, bus, dataDir, actorOf });
  registerAssetRoutes(app, { db, dataDir, actorOf, role });
  const themeStore = createThemeStore({ db, dataDir, now, role });
  registerThemeRoutes(app, { store: themeStore, bus, db, dataDir, role, boxId, now, staticDir: typeof opts.staticDir === 'string' ? opts.staticDir : null, actorOf, deviceOf });
  registerFinanceRoutes(app, { db, dataDir, bus, role, now, limiters, actorOf, deviceOf });
  registerSettingsTest(app, { db, fetchImpl, ...(opts.sourceTestTimeoutMs !== undefined ? { timeoutMs: opts.sourceTestTimeoutMs } : {}) });
  registerIslamicRoutes(app, {
    dataDir,
    fetchImpl,
    getReciter: (surauId) => String(getSettings(db, surauId).tilawah.reciter),
    getCacheMaxMb: (surauId) => Number(getSettings(db, surauId).tilawah.cacheMaxMb),
    getSourceUrls: (surauId) => sourceUrlsFrom(getSettings(db, surauId)),
    actorOf,
    logChange: (actor, action, detail) => {
      db.prepare(
        'INSERT INTO change_log (at, actor, entity, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, NULL, ?)',
      ).run(now().toISOString(), actor, 'islamic', action, JSON.stringify({ detail }));
    },
  });

  // HadeethEnc through the box (Plan 14): every request goes through `fetchImpl` (guardedFetch in production)
  // to the address in `dataSources.hadeethenc`. The timers run on the box role only.
  const hadisClient = lazyHadeethEnc(() => createHadeethEnc(fetchImpl, sourceUrlsFrom(getSettings(db, LOCAL_SURAU_ID)).hadeethenc));
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
    ? startHadisTimers({ db, client: hadisClient, job: hadisJob, now, onLog: hadisLog, surauIds: () => timerSurauIds(db, role), onChange: (surauId) => bus.emit(getVersion(db, surauId), surauId), ...opts.hadisTimers })
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
  registerSurauLogoRoutes(app, { db, dataDir, appDir: hasApp ? appDir : null, role });
  registerIosProfileRoutes(app, {
    role,
    db,
    boxId,
    httpsPort: opts.httpsPort ?? 8443,
    lanIps,
    boxName: () => boxNameOf(tlsNow()),
    allowedHosts: () => allowedHosts,
    cloudOrigin: () => {
      const fromLink = (db.prepare("SELECT value FROM sync_state WHERE key = 'cloud_url'").get()?.value as string | undefined) ?? '';
      for (const u of [fromLink, opts.cloud?.url ?? '']) {
        try { if (u !== '') return new URL(u).origin; } catch { /* next */ }
      }
      return DEFAULT_CLOUD_ORIGIN;
    },
  });
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
    if (youtubeRegistry !== null) for (const svc of youtubeRegistry.all()) svc.shutdown();
    else youtubeService?.shutdown();
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
