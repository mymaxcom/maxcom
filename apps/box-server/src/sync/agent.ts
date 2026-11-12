import { createHash, createHmac } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import https from 'node:https';
import { Readable } from 'node:stream';
import { rootCertificates } from 'node:tls';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CONTENT_KINDS, MAX_PHOTO_BYTES, isoInstantMs } from '@surau/core';
import type { FeedEntry, Snapshot } from '@surau/core';
import { getAssetPath, isAssetId, putAsset } from '../assets/store.ts';
import { PHOTO_ID_RE, checkJpeg, checkReplicatedBytes, markPresent, photoMeta, photoPath, writePhotoFile } from '../finance/photos.ts';
import { setCloudReceived } from '../finance/store.ts';
import type { ChangeBus } from '../events.ts';
import { getSettings, getVersion } from '../settingsStore.ts';
import { applyFeedEntry } from './apply.ts';
import { readFeed } from './feed.ts';
import { headSeq, SYNC_BODY_LIMIT } from './routes.ts';
import { AutoLink, linkState } from './register.ts';
import type { LinkState } from './register.ts';
import { loadSyncKey, normaliseCloudUrl } from './syncKey.ts';
import type { SyncKeyData } from './syncKey.ts';
import { LAST_PUSH_SEQ_KEY } from './trim.ts';
import { DEFAULT_SURAU_ID, verifySiteEntry } from './verify.ts';

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
export type AgentErrorReason = 'unreachable' | 'unauthorised' | 'http_5xx' | 'http_4xx' | 'tls' | 'snapshot_required' | 'bad_answer' | 'refused';

export const BACKOFF_MS = [60_000, 120_000, 300_000, 900_000] as const;
export const DEBOUNCE_MS = 30_000;
const PAGE = 500;
const MAX_WAKE_TRIES = 5;
const MAX_ASSETS_PER_CYCLE = 200;
const ASSET_MAX_BYTES = 20 * 1024 * 1024;
const API_TIMEOUT_MS = 30_000;
const ASSET_TIMEOUT_MS = 120_000;
const ALL = { users: true, devices: true, keys: true, finance: true, financeWrite: true } as const;
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
  /** Refusals seen in the running cycle that are not benign (push replies, malformed pulled entries). */
  private cycleRefused = 0;
  private cycleReasons: string[] = [];
  private cycleHook: (() => void) | null = null;

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
  status(): { linked: boolean; cloudUrl: string | null; lastPush: string | null; lastPull: string | null; pendingOut: number; lastError: string | null; state: AgentState; refused: number; lastRefusal: string | null } {
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
    };
  }

  /** A full push and pull now (the app's "Selaraskan sekarang", also what every wake runs). Never throws. */
  runOnce(): Promise<void> {
    return this.guarded();
  }

  // ---- scheduling ---------------------------------------------------------------------------

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.nextDelay = ms;
    this.tickTimer = setTimeout(() => void this.tick(), ms);
    this.tickTimer.unref();
  }

  private intervalMs(): number {
    const s = Number(this.settings().dirtyCheckSeconds);
    return (Number.isFinite(s) && s >= 60 ? s : 120) * 1000;
  }

  private backoffMs(): number {
    return BACKOFF_MS[Math.min(Math.max(this.failures, 1), BACKOFF_MS.length) - 1]!;
  }

  private settings(): Record<string, unknown> {
    return getSettings(this.o.db).cloudSync as unknown as Record<string, unknown>;
  }

  private enabled(): boolean {
    return this.settings().enabled === true;
  }

  /** Something local is waiting: push it after the debounce. */
  private noteLocalChange(): void {
    if (this.stopped || this.running !== null || !this.enabled()) return;
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
      // A pending local change is the debounce timer's business unless nothing else is due.
      if (dirty > 0 || dirty === -1 || (this.pendingCount() > 0 && this.debounceTimer === null)) {
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

  private fail(error: unknown): void {
    if (this.dead) return;
    const reason: AgentErrorReason = error instanceof CycleError ? error.reason : 'unreachable';
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
      const res = await this.send(`${this.workerBase(key)}/wake`, {
        method: 'POST',
        headers: this.signedHeaders(key, (ts) => wakeMessage(this.o.boxId, ts)),
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
      const res = await this.send(`${this.baseUrl(key)}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${key.siteToken}` } }, timeoutMs);
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
      return -1;
    }
    const j = await this.okJson(res);
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
    const at = this.o.now().toISOString();
    this.setState('last_push', at);
    this.setState('last_pull', at);
    this.setState('pending_out', String(this.pendingCount()));
    this.recordRefusals();
    await this.clearDirty(key, head);
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
  }

  /** The cloud tells, per finance entry it took, when it first held it; the box shows that beside its own time. */
  private noteCloudReceipts(reply: Record<string, unknown>): void {
    const map = reply.receivedAt;
    if (typeof map !== 'object' || map === null || Array.isArray(map)) return;
    let n = 0;
    for (const [id, at] of Object.entries(map)) {
      if (++n > 500) break;
      if (/^[A-Za-z0-9_-]{1,100}$/.test(id) && typeof at === 'string' && isoInstantMs(at) !== null) setCloudReceived(this.o.db, id, at);
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
      const local = photoPath(this.o.db, this.o.dataDir, id);
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
        const row = photoMeta(this.o.db, id);
        if (row === null) continue;
        checkReplicatedBytes(this.o.db, row, buf);
        writePhotoFile(this.o.dataDir, id, buf);
        markPresent(this.o.db, id);
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
    return verifySiteEntry({ boxId, surauId: DEFAULT_SURAU_ID }, { surauId: DEFAULT_SURAU_ID }, probe).ok;
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
      const r = applyFeedEntry(this.o.db, e, { now: this.o.now(), origin: 'cloud', actor: e.actor, dataDir: this.o.dataDir, role: 'box', surauId: DEFAULT_SURAU_ID });
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
    if (changed) this.o.bus.emit(getVersion(this.o.db));
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
