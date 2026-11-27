import { LOCAL_SURAU_ID } from '../tenant.ts';
import { createHash, createHmac } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import https from 'node:https';
import { Readable } from 'node:stream';
import { rootCertificates } from 'node:tls';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CONTENT_KINDS, KIOSK_TEMPLATE_IDS, MAX_PHOTO_BYTES, SERVER_FEATURES, THEME_CONTRACT, VIDEO_MIME, isoInstantMs, normalisePhone } from '@surau/core';
import type { FeedEntry, Snapshot } from '@surau/core';
import { getAssetPath, isAssetId, putAsset } from '../assets/store.ts';
import { sweepVideoOrphans } from '../assets/video.ts';
import { PHOTO_ID_RE, checkJpeg, checkReplicatedBytes, markPresent, photoMeta, photoPath, writePhotoFile } from '../finance/photos.ts';
import { setCloudReceived } from '../finance/store.ts';
import type { ChangeBus } from '../events.ts';
import { getSettings, getVersion } from '../settingsStore.ts';
import { applyFeedEntry } from './apply.ts';
import { readFeed } from './feed.ts';
import { mergeDeviceSeen } from './deviceSeen.ts';
import { applyPeopleIdsAnswer, hasUnnumbered, localBoxIds, mergeCloudIds } from './peopleIds.ts';
import { backfillIds, raiseCounters, siteRoleOf, SITE_ROLE_KEY } from '../auth/ids.ts';
import { headSeq, SYNC_BODY_LIMIT } from './routes.ts';
import { AutoLink, linkState } from './register.ts';
import type { LinkState } from './register.ts';
import { loadSyncKey, normaliseCloudUrl } from './syncKey.ts';
import type { SyncKeyData } from './syncKey.ts';
import { LAST_PUSH_SEQ_KEY } from './trim.ts';
import { softwareToken } from '../productVersion.ts';
import { verifySiteEntry } from './verify.ts';

/**
 * The box's sync agent (box role). Event driven, never periodic:
 *  - a local change (outbox non-empty) is pushed after a 30 s debounce;
 *  - every `cloudSync.dirtyCheckSeconds` (default 120) a signed `GET /dirty` asks the Worker whether the
 *    cloud has changes for this box; the check is answered from KV and never wakes the VM;
 *  - every wake runs a full push and pull; the dirty flag is then cleared with the head the pull received.
 * Failure backs off 60 s, 2, 5, then 15 min. Everything runs on `setTimeout` chains and streamed transfers:
 * the kiosk and the box API never wait for the cloud.
 *
 * What goes up: feed entries written here (`origin` local) or applied here from a device (`app`). Entries
 * that came from the cloud, and the box's own echoes, never go back: pulled rows are skipped by moving the
 * push cursor over them when it was caught up, and any that still slip through are harmless duplicates
 * (same rev or same op id) the cloud answers without writing.
 */

export type AgentState = 'idle' | 'waking' | 'syncing' | 'offline';
export type AgentErrorReason = 'unreachable' | 'unauthorised' | 'http_5xx' | 'http_4xx' | 'tls' | 'snapshot_required' | 'bad_answer' | 'refused' | 'surau_asleep';

export const BACKOFF_MS = [60_000, 120_000, 300_000, 900_000] as const;
/** A camera mark that will not clear may force this many waking cycles an hour (S9). */
const CAMERA_WAKES_PER_HOUR = 3;
export const DEBOUNCE_MS = 30_000;
const PAGE = 500;
/** How often the box asks the cloud when its phones were last used there. */
const DEVICE_SEEN_EVERY_MS = 60 * 60_000;
/** While a record still waits for its ID the box asks again after this long. */
const IDS_SOON_MS = 60_000;

/** The cloud's `maxNo`, or null when it is not two non-negative integers. */
function maxNoOf(v: unknown): { user: number; device: number } | null {
  if (typeof v !== 'object' || v === null) return null;
  const { user, device } = v as Record<string, unknown>;
  return typeof user === 'number' && Number.isInteger(user) && user >= 0 && typeof device === 'number' && Number.isInteger(device) && device >= 0 ? { user, device } : null;
}
const MAX_WAKE_TRIES = 5;
const MAX_ASSETS_PER_CYCLE = 200;
const ASSET_MAX_BYTES = 20 * 1024 * 1024;
/** What this box supports for themes, sent on every request to the cloud: `<contract>;<built-in ids>`. */
export const THEMES_HEADER = 'X-Maxcom-Themes';
export const THEMES_HEADER_VALUE = `${THEME_CONTRACT};${KIOSK_TEMPLATE_IDS.join(',')}`;
/** The server features this box has (`SERVER_FEATURES`), sent beside the themes: the cloud lists a feature for the surau only when its box says it has it. */
export const FEATURES_HEADER = 'X-Maxcom-Features';
export const FEATURES_HEADER_VALUE = SERVER_FEATURES.join(',');
/** Both report headers, sent on every request a box makes to its cloud. */
export const BOX_REPORT_HEADERS: Record<string, string> = { [THEMES_HEADER]: THEMES_HEADER_VALUE, [FEATURES_HEADER]: FEATURES_HEADER_VALUE };
/** A parked settings entry (one a mixed rollout made one side refuse) is dropped after this long. */
const PARKED_MAX_AGE_MS = 60 * 24 * 3_600_000;
const PEER_TOKEN_RE = /^[0-9.]{1,20};b[0-9]$/;
const API_TIMEOUT_MS = 30_000;
const ASSET_TIMEOUT_MS = 120_000;
const ALL = { users: true, devices: true, keys: true, finance: true, financeWrite: true, contentWrite: true } as const;
const MAX_PHOTOS_PER_CYCLE = 10;
const PHOTO_SENT_PREFIX = 'photo_up/';
const FINANCE_TRAVELS: ReadonlySet<string> = new Set(['finance:entry', 'finance:fund', 'finance:perihal', 'finance:month', 'finance:photo']);
const HEX64 = /^[0-9a-f]{64}$/;
/** Largest answer read for the small calls (dirty flag, push reply). */
export const SMALL_BODY_LIMIT = 1024 * 1024;
/** A changes page: the same order as the largest request body the sync routes accept. */
export const PAGE_BODY_LIMIT = SYNC_BODY_LIMIT;
/** A push request is split so none is larger than this (the cloud answers 413 above SYNC_BODY_LIMIT, minus the envelope). */
export const PUSH_BODY_BUDGET = SYNC_BODY_LIMIT - 256 * 1024;
/** A full snapshot (settings, every item and tombstone, users, devices; assets travel separately). */
export const SNAPSHOT_BODY_LIMIT = 64 * 1024 * 1024;
/** Refusal reasons the cloud gives that are expected and not an error (the app lock never travels; a device enrolled on the box is unknown to the cloud). */
const BENIGN_REFUSALS: ReadonlySet<string> = new Set(['live_only', 'device_unknown']);
const REASON_RE = /^[a-z0-9_]{1,40}$/;

export class CycleError extends Error {
  readonly reason: AgentErrorReason;
  constructor(reason: AgentErrorReason) {
    super(reason);
    this.name = 'CycleError';
    this.reason = reason;
  }
}

/** base64url(HMAC-SHA256(secret, message)): the box's signature on `/wake`, `/dirty` and `/dirty/clear`. */
export const hmacSig = (secret: string, message: string): string => createHmac('sha256', secret).update(message).digest('base64url');

export const wakeMessage = (boxId: string, ts: number): string => `maxcom-wake-box\n${boxId}\n${ts}`;
export const dirtyGetMessage = (boxId: string, ts: number): string => `maxcom-dirty-get\n${boxId}\n${ts}`;
export const dirtyClearMessage = (boxId: string, upTo: number, ts: number): string => `maxcom-dirty-clear\n${boxId}\n${upTo}\n${ts}`;

/**
 * Can this change ever be applied by the cloud? The app lock is a live, per-box decision; a user row without a
 * name is a credential change (PIN). A device row travels when it is a revocation or an enrolment that carries
 * its public key (a kiosk device has no key and stays on its box).
 */
export function canTravel(e: FeedEntry): boolean {
  const after = typeof e.after === 'object' && e.after !== null ? (e.after as Record<string, unknown>) : null;
  if (e.entity.startsWith('finance:')) return FINANCE_TRAVELS.has(e.entity); // the audit-only rows (report, view, export) stay on the box
  if (e.entity === 'settings') return e.entityId !== 'appLock';
  if (e.entity === 'user') return after === null || typeof after.name === 'string';
  if (e.entity === 'device') {
    return after !== null && (after.revoked === true || (typeof after.publicJwk === 'object' && after.publicJwk !== null && !Array.isArray(after.publicJwk)));
  }
  return true;
}

/** Asset ids (64 hex, bare or the tail of `/assets/<id>`) found anywhere inside a feed entry's payload. */
export function assetIdsIn(value: unknown, into: Set<string> = new Set(), depth = 0): Set<string> {
  if (depth > 12) return into;
  if (typeof value === 'string') {
    const m = /(?:^|\/assets\/)([0-9a-f]{64})$/.exec(value);
    if (m) into.add(m[1]!);
  } else if (Array.isArray(value)) {
    for (const v of value) assetIdsIn(v, into, depth + 1);
  } else if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) assetIdsIn(v, into, depth + 1);
  }
  return into;
}

/**
 * `fetch` that trusts the system roots AND the surau's own root CA (`<dataDir>/pki/root-ca.cer`): in IP mode
 * the cloud's leaf is issued by it. Streams both ways, follows no redirect. Without that file, plain `fetch`.
 */
export function cloudFetch(dataDir: string): typeof fetch {
  const rootPath = join(dataDir, 'pki', 'root-ca.cer');
  if (!existsSync(rootPath)) return fetch;
  let ca: string[];
  try {
    const raw = readFileSync(rootPath);
    const pem = raw.toString('latin1').includes('BEGIN CERTIFICATE')
      ? raw.toString('latin1')
      : `-----BEGIN CERTIFICATE-----\n${raw.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
    ca = [...rootCertificates, pem];
  } catch {
    return fetch;
  }
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    return new Promise<Response>((resolve, reject) => {
      const req = https.request(
        url,
        { method, headers, ca, minVersion: 'TLSv1.2', ...(init?.signal ? { signal: init.signal } : {}) },
        (res) => {
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : v);
          const status = res.statusCode ?? 502;
          const bodyless = method === 'HEAD' || status === 204 || status === 205 || status === 304;
          if (bodyless) res.resume();
          resolve(new Response(bodyless ? null : (Readable.toWeb(res) as unknown as ReadableStream), { status, headers: h }));
        },
      );
      req.on('error', reject);
      const body = init?.body;
      if (body === undefined || body === null) req.end();
      else if (typeof body === 'string' || body instanceof Uint8Array) req.end(body);
      else Readable.fromWeb(body as never).pipe(req);
    });
  }) as typeof fetch;
}

export interface AgentOptions {
  db: DatabaseSync;
  dataDir: string;
  boxId: string;
  now: () => Date;
  bus: ChangeBus;
  fetchImpl?: typeof fetch;
  /** Operator override of the cloud address (env SURAU_CLOUD_URL); wins over the linked address. */
  cloudUrl?: string | null;
  /** Operator override of the Worker address (env SURAU_WORKER_URL); default: the linked/worker address, else the cloud's. */
  workerUrl?: string | null;
  debounceMs?: number;
  /** First scheduled check after start (default 10 s). */
  initialDelayMs?: number;
  /** Replaces `setTimeout` for waiting out `Retry-After` (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Answer size caps in bytes (tests lower them). */
  limits?: { small?: number; page?: number; snapshot?: number; /** Largest push request body (tests lower it). */ push?: number };
}

type StateRow = Record<string, unknown>;

export class SyncAgent {
  private readonly o: AgentOptions;
  private readonly fetchImpl: typeof fetch;
  private stopped = true;
  /** Set by stop(): the database may be closed, so nothing touches it any more. */
  private dead = false;
  private state: AgentState = 'idle';
  private running: Promise<void> | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private failures = 0;
  private nextDelay: number | null = null;
  private dirtySeen = 0;
  /** The Worker said a camera change relayed from a phone waits for this box (`camera: true` beside the seq). */
  private cameraSeen = false;
  /** When the camera mark alone forced a waking cycle, within the last hour (S9: at most CAMERA_WAKES_PER_HOUR). */
  private cameraWakes: number[] = [];
  /** Refusals seen in the running cycle that are not benign (push replies, malformed pulled entries). */
  private cycleRefused = 0;
  /** The cloud's software token from its last answer (`X-Maxcom-Server`); null until one carries it (an older cloud never does). */
  private peerToken: string | null = null;
  private cycleReasons: string[] = [];
  private cycleHook: (() => void) | null = null;
  /** The cloud answered 409 `surau_asleep` (another box of the surau leads): no cycle runs until the next `start()`. */
  private asleepSeen = false;
  private halted = false;

  private readonly autoLink: AutoLink;

  constructor(opts: AgentOptions) {
    this.o = opts;
    this.fetchImpl = opts.fetchImpl ?? cloudFetch(opts.dataDir);
    this.autoLink = new AutoLink({
      db: opts.db,
      dataDir: opts.dataDir,
      boxId: opts.boxId,
      now: opts.now,
      fetchImpl: this.fetchImpl,
      ...(opts.cloudUrl ? { cloudUrl: opts.cloudUrl } : {}),
    });
  }

  /** `linked`, `pending` (cloudSync on, waiting for MAXCOM's approval) or `off`. */
  linkState(): LinkState {
    return this.dead ? 'off' : linkState(this.o.db);
  }

  /** Delay (ms) of the next scheduled check, for health and tests. */
  get nextDelayMs(): number | null {
    return this.nextDelay;
  }

  agentState(): AgentState {
    return this.state;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.dead = false;
    this.halted = false;
    this.asleepSeen = false;
    this.unsubscribe = this.o.bus.on(() => this.noteLocalChange());
    this.schedule(this.o.initialDelayMs ?? 10_000);
    this.noteLocalChange();
  }

  stop(): void {
    this.stopped = true;
    this.dead = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.tickTimer = null;
    this.debounceTimer = null;
    this.nextDelay = null;
  }

  /** The sync facts for health: the stored status plus the live state. */
  status(): { linked: boolean; cloudUrl: string | null; lastPush: string | null; lastPull: string | null; pendingOut: number; lastError: string | null; state: AgentState; refused: number; lastRefusal: string | null; parked: number } {
    const err = this.getState('last_error');
    return {
      linked: this.getState('linked') === '1',
      cloudUrl: this.getState('cloud_url'),
      lastPush: this.getState('last_push'),
      lastPull: this.getState('last_pull'),
      pendingOut: this.pendingCount(),
      lastError: err === null ? null : err.slice(0, 200),
      state: this.state,
      refused: this.num('refused_total'),
      lastRefusal: this.getState('last_refusal'),
      parked: this.parkedCount(),
    };
  }

  /** A full push and pull now (the app's "Selaraskan sekarang", also what every wake runs). Never throws. */
  runOnce(): Promise<void> {
    return this.guarded();
  }

  // ---- scheduling ---------------------------------------------------------------------------

  private schedule(ms: number): void {
    if (this.stopped || this.halted) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.nextDelay = ms;
    this.tickTimer = setTimeout(() => void this.tick(), ms);
    this.tickTimer.unref();
  }

  /** A mark that sticks (a lost clear) may force at most a few waking cycles an hour; records the one asked for. */
  private cameraWakeAllowed(): boolean {
    const now = this.o.now().getTime();
    this.cameraWakes = this.cameraWakes.filter((t) => now - t < 3_600_000);
    if (this.cameraWakes.length >= CAMERA_WAKES_PER_HOUR) return false;
    this.cameraWakes.push(now);
    return true;
  }

  private intervalMs(): number {
    const s = Number(this.settings().dirtyCheckSeconds);
    return (Number.isFinite(s) && s >= 60 ? s : 120) * 1000;
  }

  private backoffMs(): number {
    return BACKOFF_MS[Math.min(Math.max(this.failures, 1), BACKOFF_MS.length) - 1]!;
  }

  private settings(): Record<string, unknown> {
    return getSettings(this.o.db, LOCAL_SURAU_ID).cloudSync as unknown as Record<string, unknown>;
  }

  private enabled(): boolean {
    return this.settings().enabled === true;
  }

  /** Something local is waiting: push it after the debounce. */
  private noteLocalChange(): void {
    if (this.stopped || this.halted || this.running !== null || !this.enabled()) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.pendingCount() === 0) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.stopped || this.pendingCount() === 0) return;
      void this.guarded();
    }, this.o.debounceMs ?? DEBOUNCE_MS);
    this.debounceTimer.unref();
  }

  private async tick(): Promise<void> {
    this.tickTimer = null;
    if (this.stopped) return;
    if (this.running !== null) {
      this.schedule(this.intervalMs());
      return;
    }
    if (this.dead) return;
    const key = this.linkOrNull();
    if (!this.enabled()) {
      this.state = 'idle';
      this.schedule(this.intervalMs());
      return;
    }
    if (key === null) {
      // not linked yet: the automatic link (register, then claim) runs in a cycle of its own
      await this.guarded();
      return;
    }
    this.runCycleHook();
    try {
      const dirty = await this.checkDirty(key);
      this.noteCloudOk();
      // A pending local change is the debounce timer's business unless nothing else is due.
      // a waiting camera change also takes a full cycle: it wakes a sleeping cloud, and the cycle hook then fetches it
      const cameraOnly = this.cameraSeen && dirty <= 0 && !(this.pendingCount() > 0 && this.debounceTimer === null);
      const camera = this.cameraSeen && (!cameraOnly || this.cameraWakeAllowed());
      // one waking cycle answers the mark: if the Worker still says so, the cap above keeps the cloud from being woken for ever
      this.cameraSeen = false;
      if (dirty > 0 || dirty === -1 || camera || (this.pendingCount() > 0 && this.debounceTimer === null)) {
        await this.guarded();
        return;
      }
      this.failures = 0;
      this.state = 'idle';
      this.schedule(this.intervalMs());
    } catch (error) {
      this.fail(error);
    }
  }

  /** Run one cycle, record the outcome, schedule the next check. */
  private guarded(): Promise<void> {
    if (this.running !== null) return this.running;
    if (this.halted) return Promise.resolve();
    // this cycle pushes whatever the debounce was waiting for
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    const p = (async (): Promise<void> => {
      try {
        let key = this.linkOrNull();
        if (!this.enabled()) {
          // keep the tick chain alive: enabling (or re-linking) later is picked up by the next check
          this.state = 'idle';
          this.schedule(this.intervalMs());
          return;
        }
        if (key === null) {
          const step = await this.autoLink.step();
          if (this.dead) return;
          if (step === 'retry') {
            // the cloud is asleep or down: normal for an unlinked box, so no error is recorded and nothing is woken
            this.failures += 1;
            this.state = 'offline';
            this.schedule(this.backoffMs());
            return;
          }
          key = step === 'linked' ? this.linkOrNull() : null;
          if (key === null) {
            this.failures = 0;
            this.state = 'idle';
            this.schedule(this.intervalMs());
            return;
          }
        }
        await this.cycle(key);
        // a call inside the cycle may have been refused for a sleeping surau and the error swallowed there
        if (this.asleepSeen) throw new CycleError('surau_asleep');
        this.failures = 0;
        this.state = 'idle';
        this.setState('last_error', this.cycleRefused > 0 ? 'refused' : null);
        this.runCycleHook();
        this.schedule(this.intervalMs());
      } catch (error) {
        this.fail(error);
      }
    })().finally(() => {
      this.running = null;
    });
    this.running = p;
    return p;
  }

  /** A good answer from the cloud (the Worker's dirty check counts): the kiosk's cloud icon follows `last_ok`. */
  private noteCloudOk(): void {
    this.setState('last_ok', this.o.now().toISOString());
    // a refusal recorded by an earlier cycle stays until a cycle decides otherwise
    if (this.getState('last_error') !== 'refused') this.setState('last_error', null);
  }

  private fail(error: unknown): void {
    if (this.dead) return;
    const reason: AgentErrorReason = error instanceof CycleError ? error.reason : 'unreachable';
    if (reason === 'surau_asleep') {
      // the surau sleeps on the cloud: nothing to retry (the next start asks again)
      this.halted = true;
      this.state = 'offline';
      this.setState('last_error', 'surau_asleep');
      if (this.tickTimer) clearTimeout(this.tickTimer);
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.tickTimer = null;
      this.debounceTimer = null;
      this.nextDelay = null;
      return;
    }
    this.failures += 1;
    this.state = 'offline';
    this.setState('last_error', reason);
    this.schedule(this.backoffMs());
  }

  // ---- link, state ---------------------------------------------------------------------------

  private linkOrNull(): SyncKeyData | null {
    let key: SyncKeyData | null;
    try {
      key = loadSyncKey(this.o.dataDir);
    } catch {
      key = null;
    }
    if (key === null) {
      this.setState('linked', null);
      return null;
    }
    this.setState('linked', '1');
    this.setState('cloud_url', this.baseUrl(key));
    return key;
  }

  /** The address the site key is sent to: the operator's override, else the address it was linked to. Never a setting. */
  private baseUrl(key: SyncKeyData): string {
    const override = this.o.cloudUrl ? normaliseCloudUrl(this.o.cloudUrl) : null;
    return override ?? key.cloudUrl;
  }

  private workerBase(key: SyncKeyData): string {
    const override = this.o.workerUrl ? normaliseCloudUrl(this.o.workerUrl) : null;
    return override ?? key.workerUrl ?? this.baseUrl(key);
  }

  private getState(key: string): string | null {
    if (this.dead) return null;
    const r = this.o.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as StateRow | undefined;
    return r !== undefined && typeof r.value === 'string' ? r.value : null;
  }

  private setState(key: string, value: string | null): void {
    if (this.dead) return;
    if (value === null) this.o.db.prepare('DELETE FROM sync_state WHERE key = ?').run(key);
    else
      this.o.db
        .prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value);
  }

  private num(key: string): number {
    const n = Number(this.getState(key) ?? 0);
    return Number.isInteger(n) && n > 0 ? n : 0;
  }

  /** Entries written or accepted here that the cloud has not seen. */
  private pendingCount(): number {
    if (this.dead) return 0;
    const row = this.o.db
      .prepare(
        `SELECT COUNT(*) AS n FROM change_log WHERE id > ? AND origin IN ('local', 'app')
           AND (entity LIKE 'content:%' OR entity IN ('settings', 'users', 'user', 'devices', 'device'))`,
      )
      .get(this.num(LAST_PUSH_SEQ_KEY));
    return Number(row?.n ?? 0);
  }

  // ---- HTTP ----------------------------------------------------------------------------------

  private signedHeaders(key: SyncKeyData, message: (ts: number) => string): Record<string, string> {
    const ts = this.o.now().getTime();
    return {
      'X-Maxcom-Site': this.o.boxId,
      'X-Maxcom-Ts': String(ts),
      'X-Maxcom-Sig': hmacSig(key.wakeSecret, message(ts)),
    };
  }

  private async send(url: string, init: RequestInit, timeoutMs = API_TIMEOUT_MS): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const text = `${(error as { code?: string }).code ?? ''} ${(error as { cause?: { code?: string } }).cause?.code ?? ''} ${(error as Error).message ?? ''}`;
      throw new CycleError(/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/i.test(text) ? 'tls' : 'unreachable');
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.o.sleep) return this.o.sleep(ms);
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref();
    });
  }

  /** A 409 whose body says `code: 'surau_asleep'` (the body is read from a copy; the answer stays readable). */
  private async isAsleep(res: Response): Promise<boolean> {
    try {
      const j = (await res.clone().json()) as { code?: unknown };
      return j.code === 'surau_asleep';
    } catch {
      return false;
    }
  }

  private async isWaking(res: Response): Promise<boolean> {
    if (res.status !== 503) return false;
    if (res.headers.get('retry-after') !== null) return true;
    try {
      const j = (await res.clone().json()) as { state?: unknown };
      return j.state === 'waking';
    } catch {
      return false;
    }
  }

  /** Called on each scheduled check and after each good cycle while the box is linked and `cloudSync` is on (the YouTube leg retries its pending completes). Must not throw. */
  setCycleHook(fn: (() => void) | null): void {
    this.cycleHook = fn;
  }

  private runCycleHook(): void {
    if (this.dead || this.cycleHook === null) return;
    try {
      this.cycleHook();
    } catch {
      /* a hook never breaks the sync */
    }
  }

  /**
   * Wakes the cloud with the same signed `/wake` call the cycle uses (the YouTube leg reuses it, so the wake
   * secret stays in this class). Best effort, never throws; false when the box is not linked or `cloudSync` is off.
   */
  async wakeNow(): Promise<boolean> {
    if (this.dead) return false;
    const key = this.linkOrNull();
    if (key === null || !this.enabled()) return false;
    await this.wake(key);
    return true;
  }

  /** A signed `POST /wake` (best effort: the answer only tells how long to wait). */
  private async wake(key: SyncKeyData): Promise<void> {
    try {
      // nothing to say, but never a bodyless POST: `{}` as JSON
      const res = await this.send(`${this.workerBase(key)}/wake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.signedHeaders(key, (ts) => wakeMessage(this.o.boxId, ts)) },
        body: '{}',
      });
      await res.arrayBuffer().catch(() => undefined);
    } catch {
      /* the retry decides */
    }
  }

  /**
   * One request to the cloud with the site key. A 503 `waking` calls `/wake`, waits `Retry-After` and tries
   * again (at most 5 times); any other outcome is returned for the caller to judge. `mk` builds a fresh
   * request each try (a streamed body cannot be sent twice).
   */
  private async call(key: SyncKeyData, path: string, mk: () => RequestInit, timeoutMs = API_TIMEOUT_MS): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      const init = mk();
      const res = await this.send(`${this.baseUrl(key)}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${key.siteToken}`, ...BOX_REPORT_HEADERS } }, timeoutMs);
      const peer = res.headers.get('x-maxcom-server');
      if (peer !== null && PEER_TOKEN_RE.test(peer)) this.peerToken = peer;
      if (res.status === 409 && (await this.isAsleep(res))) {
        this.asleepSeen = true;
        throw new CycleError('surau_asleep');
      }
      if (!(await this.isWaking(res))) return res;
      await res.arrayBuffer().catch(() => undefined);
      this.state = 'waking';
      if (attempt >= MAX_WAKE_TRIES) throw new CycleError('unreachable');
      await this.wake(key);
      const ra = Number(res.headers.get('retry-after'));
      await this.sleep(Math.min(Math.max(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60_000, 1_000), 120_000));
    }
  }

  /** Read the whole answer, at most `max` bytes (a longer one is refused, not buffered). */
  private async readCapped(res: Response, max: number): Promise<string> {
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > max) {
      await res.body?.cancel().catch(() => undefined);
      throw new CycleError('bad_answer');
    }
    if (res.body === null) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) {
          await reader.cancel().catch(() => undefined);
          throw new CycleError('bad_answer');
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof CycleError) throw error;
      throw new CycleError('unreachable');
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private async okJson(res: Response, max: number = this.o.limits?.small ?? SMALL_BODY_LIMIT): Promise<Record<string, unknown>> {
    if (res.status === 401 || res.status === 403) throw new CycleError('unauthorised');
    if (res.status >= 500) throw new CycleError('http_5xx');
    if (res.status < 200 || res.status >= 300) throw new CycleError('http_4xx');
    const text = await this.readCapped(res, max);
    try {
      const j = JSON.parse(text) as unknown;
      if (typeof j !== 'object' || j === null || Array.isArray(j)) throw new Error('shape');
      return j as Record<string, unknown>;
    } catch {
      throw new CycleError('bad_answer');
    }
  }

  // ---- dirty flag ----------------------------------------------------------------------------

  /**
   * Ask the Worker whether the cloud has changes for this box. Returns the dirty seq (0 = clean), or -1 when
   * there is no Worker (404): an always-on cloud, which is then simply pulled at every check.
   */
  private async checkDirty(key: SyncKeyData): Promise<number> {
    const res = await this.send(`${this.workerBase(key)}/dirty?site=${encodeURIComponent(this.o.boxId)}`, {
      method: 'GET',
      headers: this.signedHeaders(key, (ts) => dirtyGetMessage(this.o.boxId, ts)),
    });
    if (res.status === 404) {
      await res.arrayBuffer().catch(() => undefined);
      this.dirtySeen = 0;
      this.cameraSeen = false;
      return -1;
    }
    const j = await this.okJson(res);
    this.cameraSeen = j.camera === true;
    const seq = Number(j.seq ?? 0);
    this.dirtySeen = Number.isInteger(seq) && seq > 0 ? seq : 0;
    return this.dirtySeen;
  }

  /** Clear with the head the pull actually received (never the seq read earlier); a refusal just means pull again later. */
  private async clearDirty(key: SyncKeyData, head: number): Promise<void> {
    if (this.dirtySeen <= 0 || head <= 0) return;
    try {
      const res = await this.send(`${this.workerBase(key)}/dirty/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.signedHeaders(key, (ts) => dirtyClearMessage(this.o.boxId, head, ts)) },
        body: JSON.stringify({ upTo: head }),
      });
      await res.arrayBuffer().catch(() => undefined);
    } catch {
      /* the next check pulls again */
    }
    this.dirtySeen = 0;
  }

  // ---- the cycle -----------------------------------------------------------------------------

  private async cycle(key: SyncKeyData): Promise<void> {
    this.state = 'syncing';
    this.cycleRefused = 0;
    this.cycleReasons = [];
    const pushedAssets = await this.push(key);
    await this.assetsUp(key, pushedAssets);
    await this.photosUp(key);
    const { head, pulledAssets } = await this.pull(key);
    await this.assetsDown(key, pulledAssets);
    await this.photosDown(key);
    await this.themeSupportDown(key);
    await this.retryParked(key);
    await this.idsPushUp(key);
    await this.peopleResyncDown(key);
    await this.deviceSeenDown(key);
    const at = this.o.now().toISOString();
    this.setState('last_push', at);
    this.setState('last_pull', at);
    this.setState('last_ok', at);
    this.setState('pending_out', String(this.pendingCount()));
    this.recordRefusals();
    await this.clearDirty(key, head);
  }

  // ---- parked settings (a mixed rollout) -----------------------------------------------------

  /** What this side and its peer run now; a change of either is the moment a parked entry may be taken. */
  private softwareKey(): string {
    return `${softwareToken()}|${this.peerToken ?? this.getState('peer_token') ?? ''}`;
  }

  parkedCount(): number {
    if (this.dead) return 0;
    return Number(this.o.db.prepare('SELECT COUNT(*) AS n FROM parked_settings').get()?.n ?? 0);
  }

  /** Keep a refused settings entry (the newer stamp per feature and direction) with the day it was first parked. */
  private park(direction: 'push' | 'pull', e: FeedEntry): void {
    if (this.dead) return;
    this.o.db
      .prepare(
        `INSERT INTO parked_settings (direction, entity, entity_id, stamp, entry_json, parked_at) VALUES (?, 'settings', ?, ?, ?, ?)
         ON CONFLICT(direction, entity, entity_id) DO UPDATE SET stamp = excluded.stamp, entry_json = excluded.entry_json WHERE excluded.stamp > parked_settings.stamp`,
      )
      .run(direction, e.entityId, e.editedAt, JSON.stringify(e), this.o.now().toISOString());
    // the first parked entry starts the clock: the next software change on either side triggers its retry
    if (this.getState('parked_token') === null) this.setState('parked_token', this.softwareKey());
  }

  /** One settings entry alone to the cloud: true when the cloud refused it as `invalid`. */
  private async sendRefusedInvalid(key: SyncKeyData, e: FeedEntry): Promise<boolean> {
    const res = await this.call(key, '/api/sync/ops', () => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries: [e] }) }));
    const reply = await this.okJson(res);
    return Number(reply.refused) > 0 && Array.isArray(reply.reasons) && reply.reasons[0] === 'invalid';
  }

  /** A batch the cloud refused as `invalid` in part: find which settings entries, and park them. */
  private async parkRefusedSettings(key: SyncKeyData, entries: FeedEntry[], reply: Record<string, unknown>): Promise<void> {
    if (!Array.isArray(reply.reasons) || !reply.reasons.includes('invalid')) return;
    for (const e of entries) {
      if (e.entity !== 'settings') continue;
      if (await this.sendRefusedInvalid(key, e)) this.park('push', e);
    }
  }

  /**
   * Once after this box or the cloud changes software version: try the parked settings entries again. They still obey
   * the per-field stamps (a newer edit wins on either side), an entry taken is removed, one refused again stays,
   * and rows older than 60 days are dropped. A failure leaves the key unchanged so the next cycle tries again.
   */
  private async retryParked(key: SyncKeyData): Promise<void> {
    if (this.peerToken !== null) this.setState('peer_token', this.peerToken);
    const cutoff = new Date(this.o.now().getTime() - PARKED_MAX_AGE_MS).toISOString();
    this.o.db.prepare('DELETE FROM parked_settings WHERE parked_at < ?').run(cutoff);
    const now = this.softwareKey();
    if (this.parkedCount() === 0) {
      this.setState('parked_token', null);
      return;
    }
    if (this.getState('parked_token') === now) return;
    try {
      const rows = this.o.db.prepare('SELECT direction, entity_id, entry_json FROM parked_settings ORDER BY parked_at, entity_id').all();
      let changed = false;
      for (const r of rows) {
        const e = JSON.parse(String(r.entry_json)) as FeedEntry;
        const gone = (): void => void this.o.db.prepare('DELETE FROM parked_settings WHERE direction = ? AND entity = ? AND entity_id = ?').run(String(r.direction), 'settings', String(r.entity_id));
        if (r.direction === 'push') {
          if (!(await this.sendRefusedInvalid(key, e))) gone();
        } else {
          const caughtUp = this.num(LAST_PUSH_SEQ_KEY) === headSeq(this.o.db, ALL);
          const res = applyFeedEntry(this.o.db, e, { now: this.o.now(), origin: 'cloud', actor: e.actor, dataDir: this.o.dataDir, role: 'box', surauId: LOCAL_SURAU_ID });
          if (res.status === 'refused' && res.reason === 'invalid') continue;
          gone();
          if (res.status === 'applied') {
            changed = true;
            if (caughtUp) this.setState(LAST_PUSH_SEQ_KEY, String(headSeq(this.o.db, ALL)));
          }
        }
      }
      if (changed) this.o.bus.emit(getVersion(this.o.db, LOCAL_SURAU_ID), LOCAL_SURAU_ID);
      this.setState('parked_token', now);
    } catch {
      /* the next cycle tries again */
    }
  }

  /**
   * The theme contract of the surau's other boxes, from the cloud, kept in sync_state for `GET /api/themes/support`.
   * Best effort: a refusal or a bad answer keeps the older copy (which then ages out), it never fails the cycle.
   */
  private async themeSupportDown(key: SyncKeyData): Promise<void> {
    try {
      const res = await this.call(key, '/api/sync/theme-support', () => ({ method: 'GET' }));
      if (res.status !== 200) {
        await res.arrayBuffer().catch(() => undefined);
        return;
      }
      const body = JSON.parse(await this.readCapped(res, 64 * 1024)) as unknown;
      const raw = typeof body === 'object' && body !== null ? (body as { boxes?: unknown }).boxes : undefined;
      if (!Array.isArray(raw) || raw.length > 100) return;
      const boxes = raw.flatMap((b: unknown) => {
        if (typeof b !== 'object' || b === null) return [];
        const o = b as Record<string, unknown>;
        if (typeof o.boxId !== 'string' || !/^[0-9a-f]{16}$/.test(o.boxId)) return [];
        return [{
          boxId: o.boxId,
          name: typeof o.name === 'string' ? o.name.slice(0, 80) : '',
          contract: typeof o.contract === 'number' && Number.isInteger(o.contract) && o.contract >= 0 && o.contract < 1000 ? o.contract : null,
          builtIn: Array.isArray(o.builtIn) ? o.builtIn.filter((x): x is string => typeof x === 'string' && /^[a-z]{1,30}$/.test(x)).slice(0, 20) : [],
        }];
      });
      this.setState('theme_support_json', JSON.stringify(boxes));
      this.setState('theme_support_at', this.o.now().toISOString());
    } catch {
      /* the cached list ages out; "cannot confirm" is the safe answer */
    }
  }

  /**
   * Once after the upgrade (`people_resync`): read the cloud's snapshot and fill what the feed never carried before
   * this version: a missing phone number (kept as it is, no change row, no echo back) and a person the cloud has
   * deleted. A failure leaves the flag for the next round; an older cloud without the keys changes nothing.
   */
  private async peopleResyncDown(key: SyncKeyData): Promise<void> {
    if (this.getState('people_resync') !== '1') return;
    try {
      const res = await this.call(key, '/api/sync/snapshot', () => ({ method: 'GET' }), API_TIMEOUT_MS);
      if (res.status !== 200) {
        await res.arrayBuffer().catch(() => undefined);
        return;
      }
      const snap = (await this.okJson(res, this.o.limits?.snapshot ?? SNAPSHOT_BODY_LIMIT)) as { users?: unknown; serverTime?: unknown };
      const served = typeof snap.serverTime === 'string' && !Number.isNaN(Date.parse(snap.serverTime)) ? snap.serverTime : this.o.now().toISOString();
      const entries: FeedEntry[] = [];
      for (const u of Array.isArray(snap.users) ? snap.users.slice(0, 20_000) : []) {
        const o = (typeof u === 'object' && u !== null ? u : {}) as Record<string, unknown>;
        if (typeof o.id !== 'string') continue;
        const local = this.o.db.prepare('SELECT phone, deleted_at, surau_id FROM users WHERE id = ?').get(o.id);
        if (local === undefined || String(local.surau_id) === '*') continue;
        // never for a deleted person: a deleted person holds no number, here or on the cloud
        if (typeof o.phone === 'string' && local.phone === null && local.deleted_at === null && o.deleted !== true) {
          const e164 = normalisePhone(o.phone);
          if (e164 !== null) this.o.db.prepare('UPDATE users SET phone = ? WHERE id = ? AND phone IS NULL AND deleted_at IS NULL').run(e164, o.id);
        }
        if (o.deleted === true && local.deleted_at === null) {
          const at = typeof o.editedAt === 'string' && o.editedAt !== '' ? o.editedAt : served;
          entries.push({ seq: 0, entity: 'user', entityId: o.id, rev: typeof o.rev === 'string' && o.rev !== '' ? o.rev : `${at}|cloud`, editedAt: at, syncedAt: at, actor: 'cloud', deviceId: null, origin: 'cloud', opId: null, after: { id: o.id, name: o.name, roles: o.roles, active: false, deleted: true } });
        }
      }
      if (entries.length > 0) this.applyPulled(entries, new Set(), true);
      this.setState('people_resync', null);
    } catch {
      /* retried next round */
    }
  }

  /**
   * What the cloud knows that the box cannot see: when each phone was last used through the cloud (so a person who
   * only works from home is not flagged "Tidak aktif"), the cloud-series IDs it holds, the highest numbers it has
   * allocated (the box raises its counters above them) and the role it has on file for this box. At most one try an
   * hour, or a minute while some record still waits for its ID; any failure (an older cloud answers 404) is dropped
   * quietly, nothing else in the round depends on it. The time of the last good merge is `device_seen_at` (the
   * clean-up deletes no phone while it is older than 7 days).
   */
  private async deviceSeenDown(key: SyncKeyData): Promise<void> {
    try {
      const nowMs = this.o.now().getTime();
      const every = this.getState('ids_push') === '1' || hasUnnumbered(this.o.db) ? IDS_SOON_MS : DEVICE_SEEN_EVERY_MS;
      const tried = Date.parse(this.getState('device_seen_try_at') ?? '');
      if (Number.isFinite(tried) && tried <= nowMs && nowMs - tried < every) return;
      this.setState('device_seen_try_at', new Date(nowMs).toISOString());
      const res = await this.call(key, '/api/sync/device-seen', () => ({ method: 'GET' }));
      if (res.status !== 200) {
        await res.arrayBuffer().catch(() => undefined);
        return;
      }
      const body = JSON.parse(await this.readCapped(res, 2 * 1024 * 1024)) as unknown;
      if (typeof body !== 'object' || body === null) return;
      const o = body as { seen?: unknown; role?: unknown; maxNo?: unknown; ids?: unknown };
      if (!Array.isArray(o.seen)) return;
      if (typeof o.role === 'string' && /^[a-z]{1,20}$/.test(o.role)) {
        this.setState(SITE_ROLE_KEY, o.role);
      }
      const max = maxNoOf(o.maxNo);
      if (max !== null) raiseCounters(this.o.db, LOCAL_SURAU_ID, max);
      mergeCloudIds(this.o.db, o.ids);
      // a box the cloud calls primary numbers what it created while it waited for that answer (after it adopted the cloud's own numbers)
      if (siteRoleOf(this.o.db) === 'primary') backfillIds(this.o.db, 'box');
      mergeDeviceSeen(this.o.db, o.seen, this.o.now());
      this.setState('device_seen_at', this.o.now().toISOString());
    } catch {
      /* the next hour asks again */
    }
  }

  /**
   * The box's plain-series ID numbers go to the cloud once after the upgrade, and again after the cloud refused one
   * as taken (`ids_push`). The cloud's answer carries what to adopt and what to renumber. A cloud without the route
   * (404) or a failure leaves the flag for the next round; a 403 (this box is not the primary) clears it.
   */
  private async idsPushUp(key: SyncKeyData): Promise<void> {
    if (this.getState('ids_push') !== '1') return;
    try {
      const role = siteRoleOf(this.o.db);
      if (role !== null && role !== 'primary') {
        this.setState('ids_push', null);
        return;
      }
      const res = await this.call(key, '/api/sync/people-ids', () => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(localBoxIds(this.o.db)),
      }));
      if (res.status === 403) {
        await res.arrayBuffer().catch(() => undefined);
        this.setState('ids_push', null);
        return;
      }
      if (res.status !== 200) {
        await res.arrayBuffer().catch(() => undefined);
        return;
      }
      const answer = JSON.parse(await this.readCapped(res, 2 * 1024 * 1024)) as unknown;
      applyPeopleIdsAnswer(this.o.db, LOCAL_SURAU_ID, answer, maxNoOf(typeof answer === 'object' && answer !== null ? (answer as { maxNo?: unknown }).maxNo : undefined));
      this.setState('ids_push', null);
    } catch {
      /* retried next round */
    }
  }

  private async push(key: SyncKeyData): Promise<Set<string>> {
    const assets = new Set<string>();
    let cursor = this.num(LAST_PUSH_SEQ_KEY);
    for (;;) {
      const feed = readFeed(this.o.db, cursor, PAGE, ALL);
      // Rows the cloud can never take are not sent (it would refuse each one every time); the cursor still moves past them.
      const up = feed.entries.filter((e) => (e.origin === 'local' || e.origin === 'app') && canTravel(e));
      // A page is cut by serialized size, not by count: a run of large entries must not make one request the cloud
      // refuses with 413 (the cursor would never move). An entry too large on its own is logged and passed over.
      for (const batch of this.batches(up)) {
        if (batch.entries.length > 0) {
          const res = await this.call(key, '/api/sync/ops', () => ({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries: batch.entries }),
          }));
          const reply = await this.okJson(res);
          this.noteRefusals(reply);
          this.noteCloudReceipts(reply);
          await this.parkRefusedSettings(key, batch.entries, reply);
          for (const e of batch.entries) assetIdsIn(e.after, assets);
        }
        // everything before this batch's last entry that is not in `up` never travels, so the cursor may pass it
        cursor = batch.throughSeq;
        this.setState(LAST_PUSH_SEQ_KEY, String(cursor));
      }
      const last = feed.entries[feed.entries.length - 1];
      if (last !== undefined && last.seq > cursor) {
        cursor = last.seq;
        this.setState(LAST_PUSH_SEQ_KEY, String(cursor));
      }
      if (feed.next === null) break;
    }
    return assets;
  }

  /** Cut entries into request-sized batches in order; each batch knows the last feed seq it covers (an oversize entry skipped). */
  private batches(up: FeedEntry[]): Array<{ entries: FeedEntry[]; throughSeq: number }> {
    const budget = (this.o.limits?.push ?? PUSH_BODY_BUDGET) - 64; // the `{"entries":[]}` envelope
    const out: Array<{ entries: FeedEntry[]; throughSeq: number }> = [];
    let cur: FeedEntry[] = [];
    let size = 0;
    const flush = (): void => {
      if (cur.length > 0) out.push({ entries: cur, throughSeq: cur[cur.length - 1]!.seq });
      cur = [];
      size = 0;
    };
    for (const e of up) {
      const n = Buffer.byteLength(JSON.stringify(e)) + 1;
      if (n > budget) {
        // alone it is over the limit: nothing can deliver it, so say so and carry on after it
        flush();
        console.warn(`Sync: entry ${e.entity} ${e.entityId.slice(0, 40)} (seq ${e.seq}) is ${n} bytes, over the ${budget} byte limit; skipped`);
        this.cycleRefused += 1;
        this.noteReason('entry_too_large');
        out.push({ entries: [], throughSeq: e.seq });
        continue;
      }
      if (size + n > budget) flush();
      cur.push(e);
      size += n;
    }
    flush();
    return out;
  }

  /** Count what the cloud refused in a push reply. The cursor still moves (a refusal is deterministic), but it is recorded. */
  private noteRefusals(reply: Record<string, unknown>): void {
    const refused = Number(reply.refused);
    if (!Number.isInteger(refused) || refused <= 0) return;
    const reasons = (Array.isArray(reply.reasons) ? reply.reasons : []).filter((r): r is string => typeof r === 'string' && REASON_RE.test(r));
    const known = reasons.length === refused;
    const benign = known ? reasons.filter((r) => BENIGN_REFUSALS.has(r)).length : 0;
    this.cycleRefused += refused - benign;
    for (const r of known ? reasons.filter((x) => !BENIGN_REFUSALS.has(x)) : ['unknown']) this.noteReason(r);
    // the cloud holds a number this box issued for another record: send the numbers again so it can renumber
    if (reasons.includes('id_taken')) this.setState('ids_push', '1');
  }

  /** The cloud tells, per finance entry it took, when it first held it; the box shows that beside its own time. */
  private noteCloudReceipts(reply: Record<string, unknown>): void {
    const map = reply.receivedAt;
    if (typeof map !== 'object' || map === null || Array.isArray(map)) return;
    let n = 0;
    for (const [id, at] of Object.entries(map)) {
      if (++n > 500) break;
      if (/^[A-Za-z0-9_-]{1,100}$/.test(id) && typeof at === 'string' && isoInstantMs(at) !== null) setCloudReceived(this.o.db, id, at, LOCAL_SURAU_ID);
    }
  }

  /**
   * Count-sheet photos go up on their own route, a few per cycle, after the entries that name them. The cloud takes
   * bytes only for a photo row it already has; a refusal or a network error is noted and retried next cycle, and
   * never holds the entries back.
   */
  private async photosUp(key: SyncKeyData): Promise<void> {
    const rows = this.o.db.prepare('SELECT id FROM finance_photos WHERE present = 1 ORDER BY created_at, id').all();
    let n = 0;
    for (const r of rows) {
      const id = String(r.id);
      if (this.num(PHOTO_SENT_PREFIX + id) === 1) continue;
      if (n >= MAX_PHOTOS_PER_CYCLE) break;
      const local = photoPath(this.o.db, this.o.dataDir, id, LOCAL_SURAU_ID);
      if (local === null) continue;
      n++;
      try {
        const res = await this.call(
          key,
          `/api/sync/finance-photos/${id}`,
          () => ({
            method: 'PUT',
            headers: { 'Content-Type': 'image/jpeg' },
            body: Readable.toWeb(createReadStream(local.path)) as never,
            duplex: 'half',
          } as RequestInit),
          ASSET_TIMEOUT_MS,
        );
        await this.okJson(res);
        this.setState(PHOTO_SENT_PREFIX + id, '1');
      } catch {
        this.noteReason('photo_push');
      }
    }
  }

  /** Photo rows that arrived from the cloud without their bytes: fetch them (hash and JPEG header checked), a few per cycle. */
  private async photosDown(key: SyncKeyData): Promise<void> {
    const rows = this.o.db.prepare('SELECT id FROM finance_photos WHERE present = 0 ORDER BY created_at, id LIMIT ?').all(MAX_PHOTOS_PER_CYCLE);
    for (const r of rows) {
      const id = String(r.id);
      if (!PHOTO_ID_RE.test(id)) continue;
      try {
        const res = await this.call(key, `/api/sync/finance-photos/${id}`, () => ({ method: 'GET' }), ASSET_TIMEOUT_MS);
        if (res.status !== 200 || res.body === null) {
          await res.arrayBuffer().catch(() => undefined);
          continue;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of Readable.fromWeb(res.body as never)) {
          const b = chunk as Buffer;
          size += b.length;
          if (size > MAX_PHOTO_BYTES) throw new CycleError('bad_answer');
          chunks.push(b);
        }
        const buf = Buffer.concat(chunks);
        if (createHash('sha256').update(buf).digest('hex') !== id) continue;
        checkJpeg(buf);
        const row = photoMeta(this.o.db, id, LOCAL_SURAU_ID);
        if (row === null) continue;
        checkReplicatedBytes(this.o.db, row, buf, LOCAL_SURAU_ID);
        writePhotoFile(this.o.dataDir, id, buf);
        markPresent(this.o.db, id, LOCAL_SURAU_ID);
      } catch {
        this.noteReason('photo_pull');
      }
    }
  }

  private noteReason(reason: string): void {
    if (this.cycleReasons.length < 10 && !this.cycleReasons.includes(reason)) this.cycleReasons.push(reason);
  }

  /** Keep the running total and the last reasons in sync_state (codes only, never payload or secrets). */
  private recordRefusals(): void {
    if (this.cycleRefused <= 0) return;
    this.setState('refused_total', String(this.num('refused_total') + this.cycleRefused));
    this.setState('last_refusal', this.cycleReasons.join(',').slice(0, 120));
  }

  private async assetsUp(key: SyncKeyData, ids: Set<string>): Promise<void> {
    let n = 0;
    for (const id of ids) {
      if (n >= MAX_ASSETS_PER_CYCLE) break;
      const local = getAssetPath(this.o.db, this.o.dataDir, id);
      if (local === null) continue;
      // A video file never goes to the cloud (only the item's details do); another box lacking it skips the item.
      if (local.mime === VIDEO_MIME) continue;
      const head = await this.call(key, `/assets/${id}`, () => ({ method: 'HEAD' }));
      if (head.status !== 404) {
        if (head.status >= 500) throw new CycleError('http_5xx');
        continue;
      }
      n++;
      const res = await this.call(
        key,
        `/api/sync/assets/${id}`,
        () => ({
          method: 'PUT',
          headers: { 'Content-Type': local.mime },
          body: Readable.toWeb(createReadStream(local.path)) as never,
          duplex: 'half',
        } as RequestInit),
        ASSET_TIMEOUT_MS,
      );
      await this.okJson(res).catch((e: unknown) => {
        // an asset the cloud refuses (4xx) must not hold the feed back; transport and 5xx still fail the cycle
        if (e instanceof CycleError && (e.reason === 'http_4xx' || e.reason === 'bad_answer')) return {};
        throw e;
      });
    }
  }

  /**
   * Shape check of an entry the cloud sent (the same check the cloud applies to a box's entries). A `box:<id>`
   * origin is judged against that id; `cloud` is only ever made here, for snapshot entries (`synth`).
   */
  private pulledOk(e: unknown, synth: boolean): boolean {
    const o = typeof e === 'object' && e !== null ? (e as { origin?: unknown }) : {};
    const origin = typeof o.origin === 'string' ? o.origin : '';
    const probe = synth ? { ...(e as object), origin: 'local' } : e;
    const boxId = origin.startsWith('box:') ? origin.slice(4) : this.o.boxId;
    return verifySiteEntry({ boxId, surauId: LOCAL_SURAU_ID }, { surauId: LOCAL_SURAU_ID }, probe).ok;
  }

  /** Move the push cursor over rows just applied from the cloud, when everything before them was already pushed. */
  private applyPulled(entries: unknown[], assets: Set<string>, synth = false): boolean {
    const before = headSeq(this.o.db, ALL);
    const caughtUp = this.num(LAST_PUSH_SEQ_KEY) === before;
    let changed = false;
    // A finance entry made elsewhere that this box just numbered owes the cloud that number: its row must be pushed.
    let owesNumber = false;
    for (const raw of entries) {
      if (!this.pulledOk(raw, synth)) {
        this.cycleRefused += 1;
        this.noteReason('pull_bad_shape');
        continue;
      }
      const e = raw as FeedEntry;
      if (e.origin === `box:${this.o.boxId}`) continue;
      const r = applyFeedEntry(this.o.db, e, { now: this.o.now(), origin: 'cloud', actor: e.actor, dataDir: this.o.dataDir, role: 'box', surauId: LOCAL_SURAU_ID });
      // a settings value this build does not know yet (the cloud is newer): kept, and applied once this box is upgraded
      if (r.status === 'refused' && r.reason === 'invalid' && e.entity === 'settings') this.park('pull', e);
      if (r.status === 'applied') {
        changed = true;
        assetIdsIn(e.after, assets);
        if (e.entity === 'finance:entry' && (e.origin === 'app' || e.origin === 'local') && typeof e.after === 'object' && e.after !== null && (e.after as { refNo?: unknown }).refNo == null) owesNumber = true;
      }
    }
    if (caughtUp && !owesNumber) this.setState(LAST_PUSH_SEQ_KEY, String(headSeq(this.o.db, ALL)));
    return changed;
  }

  private async pull(key: SyncKeyData): Promise<{ head: number; pulledAssets: Set<string> }> {
    const assets = new Set<string>();
    let cursor = this.num('last_pull_seq');
    let head = 0;
    let changed = false;
    for (;;) {
      const res = await this.call(key, `/api/sync/changes?since=${cursor}&limit=${PAGE}`, () => ({ method: 'GET' }));
      if (res.status === 410) {
        await res.arrayBuffer().catch(() => undefined);
        // The cloud is the master copy now, so everything this box still has to say goes up first; if that
        // fails the cycle fails and the snapshot is not applied.
        const upAssets = await this.push(key);
        await this.assetsUp(key, upAssets);
        const snap = await this.snapshotApply(key, assets);
        cursor = snap.seq;
        head = snap.seq;
        changed = true;
        this.setState('last_pull_seq', String(cursor));
        break;
      }
      const j = await this.okJson(res, this.o.limits?.page ?? PAGE_BODY_LIMIT);
      const entries = Array.isArray(j.entries) ? (j.entries as unknown[]) : null;
      const pageHead = Number(j.head ?? j.seq);
      if (entries === null || !Number.isFinite(pageHead)) throw new CycleError('bad_answer');
      if (this.applyPulled(entries, assets)) changed = true;
      head = pageHead;
      const next = j.next === null || j.next === undefined ? null : Number(j.next);
      cursor = next ?? pageHead;
      this.setState('last_pull_seq', String(cursor));
      if (next === null) break;
    }
    if (changed) {
      // An upload video deleted or replaced on the other side leaves its file behind here: remove what no item uses any more.
      try { sweepVideoOrphans(this.o.db, this.o.dataDir, 60 * 60_000); } catch { /* the next pull tries again */ }
      this.o.bus.emit(getVersion(this.o.db, LOCAL_SURAU_ID), LOCAL_SURAU_ID);
    }
    return { head, pulledAssets: assets };
  }

  /**
   * A full snapshot after 410, applied as a mirror: the box's own pending changes are already pushed, so the
   * cloud wins. Items, settings and users are merged through the same rule as a feed entry using their real
   * edit stamps (a settings feature or user without one is stamped with the snapshot's server time, i.e. the
   * cloud's current word); a box item the snapshot lacks is deleted unless the box edited it after the
   * snapshot was made; tombstones are applied. Device revocations stay monotonic (revoke only).
   */
  private async snapshotApply(key: SyncKeyData, assets: Set<string>): Promise<Snapshot> {
    const res = await this.call(key, '/api/sync/snapshot', () => ({ method: 'GET' }), API_TIMEOUT_MS);
    const snap = (await this.okJson(res, this.o.limits?.snapshot ?? SNAPSHOT_BODY_LIMIT)) as unknown as Snapshot;
    if (typeof snap.seq !== 'number' || typeof snap.content !== 'object' || snap.content === null) throw new CycleError('bad_answer');
    const str = (v: unknown): v is string => typeof v === 'string' && v !== '';
    const served = str(snap.serverTime) && !Number.isNaN(Date.parse(snap.serverTime)) ? snap.serverTime : this.o.now().toISOString();
    const make = (entity: string, entityId: string, editedAt: string, after: unknown, rev?: string): FeedEntry => ({
      seq: 0, entity, entityId, rev: rev ?? `${editedAt}|cloud`, editedAt, syncedAt: editedAt, actor: 'cloud', deviceId: null, origin: 'cloud', opId: null, after,
    });
    const entries: FeedEntry[] = [];
    const present = new Map<string, Set<string>>();
    for (const [kind, items] of Object.entries(snap.content)) {
      if (!Array.isArray(items)) continue;
      const ids = new Set<string>();
      present.set(kind, ids);
      for (const it of items) {
        const o = (typeof it === 'object' && it !== null ? it : {}) as Record<string, unknown>;
        if (typeof o.id !== 'string') continue;
        ids.add(o.id);
        if (typeof o.deletedAt === 'string' && o.updatedAt === undefined) entries.push(make(`content:${kind}`, o.id, str(o.editedAt) ? o.editedAt : o.deletedAt, null));
        else if (typeof o.updatedAt === 'string') entries.push(make(`content:${kind}`, o.id, o.updatedAt, o));
      }
    }
    // box items the cloud no longer has: deleted at the snapshot's time, which loses to a newer local edit
    const live = this.o.db.prepare("SELECT id FROM content_items WHERE kind = ? AND deleted_at IS NULL");
    for (const [kind, ids] of present) {
      if (!(CONTENT_KINDS as readonly string[]).includes(kind)) continue;
      for (const r of live.all(kind)) {
        const id = String(r.id);
        if (!ids.has(id)) entries.push(make(`content:${kind}`, id, served, null));
      }
    }
    for (const [feature, value] of Object.entries(snap.settings ?? {})) {
      const meta = snap.settingsMeta?.[feature];
      const at = str(meta?.editedAt) ? meta.editedAt : served;
      const e = make('settings', feature, at, value, str(meta?.rev) ? meta.rev : undefined);
      if (meta?.stamps !== undefined && typeof meta.stamps === 'object' && meta.stamps !== null) e.stamps = meta.stamps;
      entries.push(e);
    }
    for (const u of snap.users ?? []) {
      const o = (typeof u === 'object' && u !== null ? u : {}) as Record<string, unknown>;
      if (typeof o.id !== 'string') continue;
      const at = str(o.editedAt) ? o.editedAt : served;
      entries.push(make('user', o.id, at, o, str(o.rev) ? o.rev : undefined));
    }
    for (const d of snap.devices ?? []) {
      const o = (typeof d === 'object' && d !== null ? d : {}) as Record<string, unknown>;
      if (typeof o.id !== 'string') continue;
      if (typeof o.revokedAt === 'string') entries.push(make('device', o.id, o.revokedAt, { revoked: true }));
      else if (typeof o.publicJwk === 'object' && o.publicJwk !== null && typeof o.enrolledAt === 'string') {
        // an enrolment: the apply side adds the device only when it is unknown and its user is active here
        entries.push(make('device', o.id, o.enrolledAt, { id: o.id, userId: o.userId, name: o.name, platform: o.platform, revoked: false, publicJwk: o.publicJwk, enrolledAt: o.enrolledAt }));
      }
    }
    entries.push(...this.snapshotPrayerEntries(snap.prayer, served, make));
    entries.push(...this.snapshotFinanceEntries(snap.finance, served, make));
    this.applyPulled(entries, assets, true);
    return snap;
  }

  /**
   * The prayer section of a snapshot as feed entries, so the box applies it by the same rules as the feed
   * (`prayerApply.ts`: every payload validated like a fresh import, a bad one refused and skipped alone, the
   * newer edit wins, a repeat changes nothing). A stamp the snapshot lacks (an older cloud) is the snapshot's
   * time, i.e. the cloud's current word. A box correction the snapshot lacks is removed at the snapshot's time,
   * which loses to a newer local edit; official days and imports are never deleted by absence. A section that is
   * not an object, or a list that is not a list, is skipped without touching the rest of the snapshot.
   */
  private snapshotPrayerEntries(
    prayer: unknown, served: string,
    make: (entity: string, entityId: string, editedAt: string, after: unknown, rev?: string) => FeedEntry,
  ): FeedEntry[] {
    const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
    if (!isObj(prayer)) return [];
    const stamp = (v: unknown, fallback: string): string => (typeof v === 'string' && isoInstantMs(v) !== null ? v : fallback);
    const out: FeedEntry[] = [];
    const list = (v: unknown, cap: number): Record<string, unknown>[] => (Array.isArray(v) ? v.slice(0, cap).filter(isObj) : []);
    // every zone and year a box can hold (some 60 zones, a few years each); the body cap of the snapshot is the real bound
    for (const o of list(prayer.official, 1000)) {
      const at = stamp(o.fetchedAt, served);
      out.push(make('prayer:official', `${String(o.zone)}:${String(o.year)}`, at, { zone: o.zone, year: o.year, days: o.days, fetchedAt: at }));
    }
    for (const it of list(prayer.imports, 200)) {
      const rec = isObj(it.record) ? it.record : {};
      const at = stamp(it.editedAt, stamp(rec.undoneAt, stamp(rec.createdAt, served)));
      out.push(make('prayer:import', String(rec.id), at, { record: it.record, days: it.days }, typeof it.rev === 'string' && it.rev !== '' ? it.rev : undefined));
    }
    if (Array.isArray(prayer.corrections)) {
      const present = new Set<string>();
      for (const c of list(prayer.corrections, 20_000)) {
        const id = `${String(c.date)}|${String(c.prayer)}`;
        present.add(id);
        out.push(make('prayer:correction', id, stamp(c.editedAt, served),
          { date: c.date, prayer: c.prayer, time: c.time, reason: c.reason, officialAtCorrection: c.officialAtCorrection ?? null },
          typeof c.rev === 'string' && c.rev !== '' ? c.rev : undefined));
      }
      for (const r of this.o.db.prepare('SELECT date, prayer FROM prayer_corrections').all()) {
        const id = `${String(r.date)}|${String(r.prayer)}`;
        if (!present.has(id)) out.push(make('prayer:correction', id, served, null));
      }
    }
    return out;
  }

  /** The finance section of a snapshot as feed entries (lookups first, then the ledger), applied by the same rules as the feed. */
  private snapshotFinanceEntries(
    fin: unknown, served: string,
    make: (entity: string, entityId: string, editedAt: string, after: unknown, rev?: string) => FeedEntry,
  ): FeedEntry[] {
    const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
    if (!isObj(fin)) return [];
    const list = (v: unknown, cap: number): Record<string, unknown>[] => (Array.isArray(v) ? v.slice(0, cap).filter(isObj) : []);
    const at = (v: unknown): string => (typeof v === 'string' && isoInstantMs(v) !== null ? v : served);
    const out: FeedEntry[] = [];
    for (const f of list(fin.funds, 200)) if (typeof f.id === 'string') out.push(make('finance:fund', f.id, at(f.updatedAt), f));
    for (const p of list(fin.perihal, 200)) if (typeof p.id === 'string') out.push(make('finance:perihal', p.id, at(p.updatedAt), p));
    for (const m of list(fin.months, 600)) {
      // the row's own edit stamp (an older cloud sends none: its closing time, else the snapshot's time)
      if (typeof m.ym === 'string') out.push(make('finance:month', m.ym, at(m.editedAt ?? m.closedAt), m, typeof m.rev === 'string' && m.rev !== '' ? m.rev : undefined));
    }
    // originals first, then corrections (a correction needs its original to exist), each group in the served order
    const entries = list(fin.entries, 200_000).filter((e) => typeof e.id === 'string');
    const entry = (e: Record<string, unknown>): FeedEntry => {
      const fe = make('finance:entry', String(e.id), at(e.editedAt), e);
      // an entry with no number is one this box will number: it carries the origin of a phone's entry so that the
      // row logged when it is numbered is pushed back, and the cloud learns the number (as for an ordinary pull)
      if (e.refNo == null) fe.origin = 'app';
      return fe;
    };
    for (const e of entries) if (e.kind !== 'adjust') out.push(entry(e));
    for (const e of entries) if (e.kind === 'adjust') out.push(entry(e));
    for (const ph of list(fin.photos, 20_000)) if (typeof ph.id === 'string') out.push(make('finance:photo', ph.id, served, ph));
    return out;
  }

  private async assetsDown(key: SyncKeyData, ids: Set<string>): Promise<void> {
    let n = 0;
    for (const id of ids) {
      if (!isAssetId(id) || getAssetPath(this.o.db, this.o.dataDir, id) !== null) continue;
      if (n++ >= MAX_ASSETS_PER_CYCLE) break;
      const res = await this.call(key, `/assets/${id}`, () => ({ method: 'GET' }), ASSET_TIMEOUT_MS);
      if (res.status === 404) {
        await res.arrayBuffer().catch(() => undefined);
        continue;
      }
      if (res.status >= 500) throw new CycleError('http_5xx');
      if (res.status < 200 || res.status >= 300 || res.body === null) throw new CycleError(res.status === 401 || res.status === 403 ? 'unauthorised' : 'http_4xx');
      const hash = createHash('sha256');
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of Readable.fromWeb(res.body as never)) {
          const b = chunk as Buffer;
          size += b.length;
          if (size > ASSET_MAX_BYTES) throw new CycleError('bad_answer');
          hash.update(b);
          chunks.push(b);
        }
      } catch (error) {
        if (error instanceof CycleError) throw error;
        throw new CycleError('unreachable');
      }
      // The id is the sha256 of the bytes: anything else is discarded.
      if (hash.digest('hex') !== id || !HEX64.test(id)) continue;
      try {
        putAsset(this.o.db, this.o.dataDir, Buffer.concat(chunks), res.headers.get('content-type') ?? '', 'sync');
      } catch {
        /* an unreadable or oversize file is skipped; the item still shows without it */
      }
    }
  }
}
