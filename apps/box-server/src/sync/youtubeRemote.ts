import type { DatabaseSync } from 'node:sqlite';
import type { LiveStatus, YoutubeMeta } from '@surau/core';
import type { YoutubeLeg } from '../live/sessions.ts';
import { getSettings } from '../settingsStore.ts';
import { cloudFetch } from './agent.ts';
import { loadSyncKey, normaliseCloudUrl } from './syncKey.ts';
import type { SyncKeyData } from './syncKey.ts';

/**
 * The box's YouTube leg over the cloud (Plan 6, Task 5). The Google token lives on the cloud; the box asks
 * the cloud's `/api/cloud/youtube/*` with its site key. Nothing here ever waits long on the cloud (6 s per
 * call) and nothing here can stop the kiosk leg: a cloud that cannot be reached is a short reason, and the
 * live session carries the warning `cloud_unreachable` (anti-goal 3).
 *
 * The stream key the cloud hands back goes to the live session's memory (Plan 5) and nowhere else: it is not
 * stored, cached or logged by this class.
 */

export type RemoteReason = 'cloud_unreachable' | 'quota' | 'reauthorise' | 'forbidden' | 'not_configured' | 'network';

/** A failure of the remote leg: a reason from a fixed vocabulary, never the cloud's text. */
export class CloudYoutubeError extends Error {
  readonly reason: RemoteReason;
  /** The HTTP status the cloud answered, when it answered. */
  readonly status: number | undefined;
  /** The cloud looked asleep or out of reach (503, or no answer): waking it and trying again may help. */
  readonly transient: boolean;
  constructor(reason: RemoteReason, detail: { status?: number; transient?: boolean } = {}) {
    super(reason);
    this.name = 'CloudYoutubeError';
    this.reason = reason;
    this.status = detail.status;
    this.transient = detail.transient === true;
  }
}

const TIMEOUT_MS = 6_000;
const BODY_CAP = 64 * 1024;
const KEY_TTL_MS = 20_000;
const STATUS_IDLE_MS = 60_000;
const STATUS_LIVE_MS = 10_000;
const RETRY_MS: readonly number[] = [30_000, 120_000, 300_000];
/** How long a broadcast request waits for an asleep cloud (wake, then retry with short backoff). */
const WAIT_BUDGET_MS = 20_000;
const WAIT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 3_000, 4_000, 5_000];
/** First look at the pending completes after the box started. */
const BOOT_RETRY_MS = 15_000;
/** A pending complete that keeps failing is dropped after this many tries (the agent cycle is minutes apart). */
const MAX_PENDING_ATTEMPTS = 200;

type YoutubeStatus = LiveStatus['youtube'];

const blank = (lastError: string | null): YoutubeStatus => ({
  signedIn: false,
  channelTitle: null,
  broadcastId: null,
  state: 'none',
  health: null,
  watchUrl: null,
  lastError,
});

export interface RemoteYoutubeOptions {
  db: DatabaseSync;
  dataDir: string;
  now: () => Date;
  /** The fetch that reaches the cloud (default: the sync agent's, which also trusts the surau root CA). */
  fetchImpl?: typeof fetch;
  /** Operator override of the address the box was linked to (SURAU_CLOUD_URL). */
  cloudUrl?: string | null;
  timeoutMs?: number;
  /** Delays between retries of a `complete` that did not get through (tests shorten them). */
  retryMs?: readonly number[];
  /** Wakes the cloud (the sync agent's signed `/wake`; the wake secret never reaches this class). */
  wake?: () => Promise<unknown>;
  /** Total time `createBroadcastFor` may spend waiting for an asleep cloud (default 20 s). */
  waitBudgetMs?: number | (() => number);
  /** Delays between those tries (the last one repeats). */
  waitBackoffMs?: readonly number[];
  /** Delay before the pending completes are looked at after start (default 15 s). */
  bootRetryMs?: number;
}

export class RemoteYoutubeLeg implements YoutubeLeg {
  private readonly o: RemoteYoutubeOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retry: readonly number[];
  private keyCache: { at: number; key: SyncKeyData | null } | null = null;
  /** Last answer of the cloud's status route, or null when the last try failed / none was made. */
  private last: YoutubeStatus | null = null;
  private lastAt = 0;
  private lastFailed = false;
  private inflight: Promise<void> | null = null;
  private readonly timers = new Set<NodeJS.Timeout>();
  private stopped = false;
  /** Broadcast ids whose `complete` is being tried right now (a timer and the agent cycle must not double up). */
  private readonly completing = new Set<string>();

  constructor(o: RemoteYoutubeOptions) {
    this.o = o;
    this.fetchImpl = o.fetchImpl ?? cloudFetch(o.dataDir);
    this.timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
    this.retry = o.retryMs ?? RETRY_MS;
    // completes an earlier run could not deliver are finished shortly after start
    const t = setTimeout(() => {
      this.timers.delete(t);
      void this.retryPending();
    }, o.bootRetryMs ?? BOOT_RETRY_MS);
    t.unref();
    this.timers.add(t);
  }

  // ---- whether the box uses the cloud for YouTube ------------------------------------------------------

  private key(): SyncKeyData | null {
    const t = Date.now();
    if (this.keyCache !== null && t - this.keyCache.at < KEY_TTL_MS) return this.keyCache.key;
    let key: SyncKeyData | null;
    try {
      key = loadSyncKey(this.o.dataDir);
    } catch {
      key = null;
    }
    this.keyCache = { at: t, key };
    return key;
  }

  /** Linked to a cloud and `cloudSync` on. Otherwise the box's own YouTube service is used (the fallback). */
  active(): boolean {
    try {
      if (getSettings(this.o.db).cloudSync.enabled !== true) return false;
    } catch {
      return false;
    }
    return this.key() !== null;
  }

  private baseUrl(key: SyncKeyData): string {
    const override = this.o.cloudUrl ? normaliseCloudUrl(this.o.cloudUrl) : null;
    return override ?? key.cloudUrl;
  }

  // ---- one request to the cloud ------------------------------------------------------------------------

  private async call(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<Record<string, unknown>> {
    const key = this.key();
    if (key === null) throw new CloudYoutubeError('cloud_unreachable');
    let res: Response;
    let text = '';
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${key.siteToken}` };
      const init: RequestInit = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      res = await this.fetchImpl(`${this.baseUrl(key)}${path}`, init);
      if (res.body) {
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > BODY_CAP) {
            await reader.cancel().catch(() => undefined);
            throw new CloudYoutubeError('cloud_unreachable');
          }
          chunks.push(value);
        }
        text = Buffer.concat(chunks).toString('utf8');
      }
    } catch (e) {
      throw e instanceof CloudYoutubeError ? e : new CloudYoutubeError('cloud_unreachable', { transient: true });
    }
    let json: Record<string, unknown> = {};
    try {
      const v: unknown = JSON.parse(text);
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) json = v as Record<string, unknown>;
    } catch {
      json = {};
    }
    if (res.status >= 200 && res.status < 300) return json;
    const code = typeof json.code === 'string' ? json.code : '';
    if (res.status === 429 || code === 'youtube_quota') throw new CloudYoutubeError('quota');
    if (code === 'youtube_reauthorise') throw new CloudYoutubeError('reauthorise');
    if (code === 'youtube_not_configured') throw new CloudYoutubeError('not_configured');
    if (code === 'youtube_forbidden') throw new CloudYoutubeError('forbidden');
    if (code === 'youtube_network') throw new CloudYoutubeError('network');
    // 401 (site key refused), 404 (an older cloud), 5xx, the Worker asleep: the cloud is not usable right now
    // (only a 503 means asleep: that one is worth waking and retrying)
    throw new CloudYoutubeError('cloud_unreachable', { status: res.status, transient: res.status === 503 });
  }

  // ---- status (cached; refreshed in the background, never awaited by a request) -------------------------

  private broadcasting(): boolean {
    const s = this.last;
    return s !== null && s.broadcastId !== null && (s.state === 'created' || s.state === 'testing' || s.state === 'live');
  }

  /** One status read from the cloud. Never throws: a failure is remembered as "unreachable". */
  refresh(): Promise<void> {
    if (this.inflight !== null) return this.inflight;
    this.inflight = (async () => {
      try {
        const j = await this.call('GET', '/api/cloud/youtube/status');
        this.last = this.shape(j);
        this.lastFailed = false;
      } catch {
        // keep what was known (a live in progress stays visible), but say the cloud cannot be reached
        this.last = this.last === null ? null : { ...this.last, lastError: 'cloud_unreachable' };
        this.lastFailed = true;
      } finally {
        this.lastAt = this.o.now().getTime();
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  private shape(j: Record<string, unknown>): YoutubeStatus {
    const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.length <= max ? v : null);
    const states = ['none', 'created', 'testing', 'live', 'complete', 'error'] as const;
    const healths = ['noData', 'bad', 'ok', 'good'] as const;
    const state = states.find((x) => x === j.state) ?? 'none';
    const health = healths.find((x) => x === j.health) ?? null;
    return {
      signedIn: j.signedIn === true,
      channelTitle: str(j.channelTitle, 120),
      broadcastId: str(j.broadcastId, 64),
      state,
      health,
      watchUrl: str(j.watchUrl),
      lastError: str(j.lastError, 60),
    };
  }

  // ---- YoutubeLeg --------------------------------------------------------------------------------------

  /**
   * "Signed in" as far as the box knows. The live start asks this synchronously, so an unknown or unreachable
   * cloud answers true: the attempt itself then decides (and, if the cloud is down, ends as `cloud_unreachable`
   * instead of a misleading "not signed in").
   */
  signedIn(): boolean {
    return this.last === null ? true : this.last.signedIn;
  }

  async createBroadcastFor(req: { sessionId: string; meta: YoutubeMeta }): Promise<{ broadcastId: string; watchUrl: string; key: string }> {
    const j = await this.callBroadcast(req);
    const { broadcastId, watchUrl, key } = j;
    if (typeof broadcastId !== 'string' || broadcastId === '' || broadcastId.length > 64) throw new CloudYoutubeError('network');
    if (typeof watchUrl !== 'string' || watchUrl === '' || watchUrl.length > 200) throw new CloudYoutubeError('network');
    if (typeof key !== 'string' || key === '' || key.length > 200) throw new CloudYoutubeError('network');
    this.last = { ...(this.last ?? blank(null)), signedIn: true, broadcastId, watchUrl, state: 'created', health: null, lastError: null };
    this.lastFailed = false;
    this.lastAt = 0; // the next status read asks the cloud for the channel and the health
    return { broadcastId, watchUrl, key };
  }

  /**
   * The broadcast request. A cloud that answers 503 (asleep behind the Worker) or does not answer is woken
   * (the sync agent's signed wake) and asked again with a short backoff, for about `waitBudgetMs` in all;
   * then `cloud_unreachable`. Anything else (a coded refusal, a refused key) is answered at once.
   */
  private async callBroadcast(req: { sessionId: string; meta: YoutubeMeta }): Promise<Record<string, unknown>> {
    const wb = this.o.waitBudgetMs;
    const budget = typeof wb === 'function' ? wb() : wb ?? WAIT_BUDGET_MS;
    const backoff = this.o.waitBackoffMs !== undefined && this.o.waitBackoffMs.length > 0 ? this.o.waitBackoffMs : WAIT_BACKOFF_MS;
    const began = Date.now();
    for (let attempt = 0; ; attempt++) {
      const left = budget - (Date.now() - began);
      try {
        return await this.call('POST', '/api/cloud/youtube/broadcast', { sessionId: req.sessionId, meta: req.meta }, Math.max(1_000, Math.min(this.timeoutMs, left)));
      } catch (e) {
        if (!(e instanceof CloudYoutubeError) || !e.transient || this.stopped) throw e;
        const remaining = budget - (Date.now() - began);
        if (remaining <= 0) throw e;
        if (attempt % 3 === 0 && this.o.wake !== undefined) {
          await Promise.race([
            this.o.wake().catch(() => undefined),
            new Promise<void>((r) => {
              const t = setTimeout(r, Math.max(1, remaining));
              t.unref();
            }),
          ]);
        }
        const wait = Math.min(backoff[Math.min(attempt, backoff.length - 1)]!, Math.max(0, budget - (Date.now() - began)));
        if (wait > 0) {
          await new Promise<void>((r) => {
            const t = setTimeout(r, wait);
            t.unref();
          });
        }
      }
    }
  }

  async complete(broadcastId: string): Promise<void> {
    // written first: a box that stops here (power cut) still finishes the broadcast at the next start
    this.storePending(broadcastId);
    try {
      await this.call('POST', '/api/cloud/youtube/complete', { broadcastId });
    } catch (e) {
      if (isFinalRefusal(e)) this.dropPending(broadcastId);
      else {
        this.bumpPending(broadcastId);
        this.later(broadcastId, 0);
      }
      throw e;
    }
    this.dropPending(broadcastId);
    if (this.last !== null && this.last.broadcastId === broadcastId) this.last = { ...this.last, state: 'complete' };
    void this.refresh();
  }

  /** A `complete` that did not get through is tried again a few times so no broadcast stays open on the channel. */
  private later(broadcastId: string, attempt: number): void {
    const delay = this.retry[attempt];
    if (delay === undefined || this.stopped) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.stopped) return;
      void this.tryPending(broadcastId).then((r) => {
        if (r === 'retry') this.later(broadcastId, attempt + 1);
      });
    }, delay);
    t.unref();
    this.timers.add(t);
  }

  // ---- completes that must survive a restart (ids and counters only; never a key) -------------------------

  private storePending(id: string): void {
    if (this.stopped) return;
    try {
      this.o.db.prepare('INSERT OR IGNORE INTO youtube_pending_complete (broadcast_id, attempts, created_at) VALUES (?, 0, ?)').run(id, this.o.now().toISOString());
    } catch {
      /* the in-memory retries still run */
    }
  }

  private bumpPending(id: string): void {
    if (this.stopped) return;
    try {
      this.o.db.prepare('UPDATE youtube_pending_complete SET attempts = attempts + 1 WHERE broadcast_id = ?').run(id);
    } catch {
      /* ignore */
    }
  }

  private dropPending(id: string): void {
    if (this.stopped) return;
    try {
      this.o.db.prepare('DELETE FROM youtube_pending_complete WHERE broadcast_id = ?').run(id);
    } catch {
      /* ignore */
    }
  }

  private pendingIds(): string[] {
    try {
      return this.o.db
        .prepare('SELECT broadcast_id FROM youtube_pending_complete ORDER BY created_at, broadcast_id LIMIT 20')
        .all()
        .flatMap((r) => (typeof r.broadcast_id === 'string' ? [r.broadcast_id] : []));
    } catch {
      return [];
    }
  }

  /** One try of a stored complete: done, a final refusal (row dropped), or to be tried again. */
  private async tryPending(id: string): Promise<'done' | 'final' | 'retry'> {
    if (this.stopped || this.completing.has(id)) return 'retry';
    this.completing.add(id);
    try {
      await this.call('POST', '/api/cloud/youtube/complete', { broadcastId: id });
      this.dropPending(id);
      if (this.last !== null && this.last.broadcastId === id) this.last = { ...this.last, state: 'complete' };
      void this.refresh();
      return 'done';
    } catch (e) {
      if (isFinalRefusal(e)) {
        this.dropPending(id);
        return 'final';
      }
      this.bumpPending(id);
      if (!this.stopped) {
        try {
          this.o.db.prepare('DELETE FROM youtube_pending_complete WHERE broadcast_id = ? AND attempts >= ?').run(id, MAX_PENDING_ATTEMPTS);
        } catch {
          /* ignore */
        }
      }
      return 'retry';
    } finally {
      this.completing.delete(id);
    }
  }

  /**
   * Tries the stored completes now (at boot and on every sync agent cycle) until each gets a 2xx or a final 4xx.
   * Does nothing when the box is not linked to a cloud (it still runs when `cloudSync` has since been turned off). Never throws.
   */
  async retryPending(): Promise<void> {
    // linked is enough: a complete stored while `cloudSync` was on must still reach the cloud that holds the broadcast
    if (this.stopped || this.key() === null) return;
    for (const id of this.pendingIds()) {
      if (this.stopped) return;
      const r = await this.tryPending(id);
      // the cloud is out of reach: the rest would only wait the same time again
      if (r === 'retry') return;
    }
  }

  status(): YoutubeStatus {
    const age = this.o.now().getTime() - this.lastAt;
    if (this.lastAt === 0 || age >= (this.broadcasting() ? STATUS_LIVE_MS : STATUS_IDLE_MS)) void this.refresh();
    if (this.last !== null) return this.last;
    return blank(this.lastFailed ? 'cloud_unreachable' : null);
  }

  /** The box is closing: pending retries are dropped. */
  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

/** A 4xx that asking again will not change (the broadcast is unknown or refused), unlike a sign-in or a key to fix. */
function isFinalRefusal(e: unknown): boolean {
  if (!(e instanceof CloudYoutubeError)) return false;
  return e.status === 400 || e.status === 403 || e.status === 404 || e.status === 410 || e.status === 422;
}

/**
 * Picks the remote or the box's own YouTube service per call: the cloud when the box is linked and `cloudSync`
 * is on, the local service otherwise. A broadcast is completed on the leg that made it.
 */
export class CloudOrLocalLeg implements YoutubeLeg {
  private readonly remote: RemoteYoutubeLeg;
  private readonly local: YoutubeLeg;
  private readonly useRemote: () => boolean;
  private readonly madeRemote = new Set<string>();

  constructor(remote: RemoteYoutubeLeg, local: YoutubeLeg, useRemote: () => boolean) {
    this.remote = remote;
    this.local = local;
    this.useRemote = useRemote;
  }

  signedIn(): boolean {
    return this.useRemote() ? this.remote.signedIn() : this.local.signedIn();
  }

  async createBroadcastFor(req: { sessionId: string; meta: YoutubeMeta }): Promise<{ broadcastId: string; watchUrl: string; key: string }> {
    if (!this.useRemote()) return this.local.createBroadcastFor(req);
    const made = await this.remote.createBroadcastFor(req);
    this.madeRemote.add(made.broadcastId);
    return made;
  }

  async complete(broadcastId: string): Promise<void> {
    if (this.madeRemote.delete(broadcastId)) return this.remote.complete(broadcastId);
    return this.local.complete(broadcastId);
  }

  status(): YoutubeStatus {
    return this.useRemote() ? this.remote.status() : this.local.status();
  }
}
