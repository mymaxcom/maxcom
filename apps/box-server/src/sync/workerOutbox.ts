import { createPublicKey } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openSecret, sealSecret } from '../auth/crypto.ts';

/**
 * The cloud's outbox towards the Worker's admin routes (SECURITY code; Plan 6 "no lost set").
 *
 * Rows are written in the same transaction as the change that causes them (triggers of migration 009 for the
 * dirty seq and the device allowlist; `enqueueSitePut` / `enqueueSiteDelete` for the wake secret). The sender
 * delivers them with backoff until the Worker answers 2xx, so a Worker that is down never loses a change.
 *
 *  - The Worker address and the admin token come from the environment (never from synced settings).
 *  - With no Worker configured the outbox is off: nothing is queued and anything left over is dropped.
 *  - The `site_put` body holds the wake secret and is stored sealed under the cloud's key.
 *  - `last_error` and the log carry a short reason code only: never the token, a header, a URL or a response body.
 */

export interface WorkerAdminConfig {
  /** https base address of the Worker, no trailing slash. */
  url: string;
  /** Bearer token of the `/_admin` routes. */
  token: string;
  fetchImpl?: typeof fetch;
}

/**
 * The cloud's Worker admin settings from the environment (SURAU_WORKER_URL + SURAU_WORKER_ADMIN_TOKEN); null when
 * not both set (always-on cloud: no Worker, no outbox). Never read from synced settings.
 */
export function workerAdminFrom(env: NodeJS.ProcessEnv): WorkerAdminConfig | null {
  const url = (env.SURAU_WORKER_URL ?? '').trim().replace(/\/+$/, '');
  const token = (env.SURAU_WORKER_ADMIN_TOKEN ?? '').trim();
  if (!url.startsWith('https://') || token === '') return null;
  return { url, token };
}

export const BACKOFF_MIN_MS = 5_000;
export const BACKOFF_MAX_MS = 10 * 60 * 1000;
const POLL_MS = 2_000;
const CALL_TIMEOUT_MS = 15_000;
const FLAG = 'worker_outbox';

type Row = Record<string, unknown>;

export const backoffMs = (attempts: number): number => Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempts - 1));

/** Is the outbox on (a Worker is configured on this cloud)? */
export function outboxOn(db: DatabaseSync): boolean {
  return db.prepare('SELECT value FROM sync_state WHERE key = ?').get(FLAG)?.value === '1';
}

/** Switch the outbox on or off at start. Off drops whatever was queued. */
export function setOutboxOn(db: DatabaseSync, on: boolean): void {
  db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(FLAG, on ? '1' : '0');
  if (!on) db.exec('DELETE FROM worker_outbox');
}

const UPSERT =
  `INSERT INTO worker_outbox (kind, key, body, created_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, body = excluded.body, state = 'pending', attempts = 0, next_at = '', last_error = NULL, rev = worker_outbox.rev + 1`;

/** Queue the wake secret of a linked site (sealed). Caller owns the transaction. A re-link replaces the item. */
export function enqueueSitePut(db: DatabaseSync, sealKey: Buffer | null | undefined, boxId: string, wakeSecret: string, now = new Date()): void {
  if (!sealKey || !outboxOn(db)) return;
  db.prepare(UPSERT).run('site_put', `site/${boxId}`, sealSecret(sealKey, JSON.stringify({ wakeSecret })), now.toISOString());
}

/** Queue the removal of a site's wake secret and forget its pending dirty flag. Caller owns the transaction. */
export function enqueueSiteDelete(db: DatabaseSync, boxId: string, now = new Date()): void {
  if (!outboxOn(db)) return;
  db.prepare(UPSERT).run('site_delete', `site/${boxId}`, '{}', now.toISOString());
  db.prepare('DELETE FROM worker_outbox WHERE key = ?').run(`dirty/${boxId}`);
}

export interface OutboxStatus {
  pending: number;
  failed: number;
  lastError: string | null;
}

export function outboxStatus(db: DatabaseSync): OutboxStatus {
  const n = (state: string): number => Number(db.prepare('SELECT COUNT(*) AS n FROM worker_outbox WHERE state = ?').get(state)?.n ?? 0);
  const last = db.prepare('SELECT last_error FROM worker_outbox WHERE last_error IS NOT NULL ORDER BY id DESC LIMIT 1').get();
  return { pending: n('pending'), failed: n('failed'), lastError: typeof last?.last_error === 'string' ? last.last_error : null };
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A clean EC P-256 public key: kty, crv, x, y only (no `d`, no extras), a real point. */
function publicJwkOk(v: unknown): boolean {
  if (!isPlain(v) || v.kty !== 'EC' || v.crv !== 'P-256' || typeof v.x !== 'string' || typeof v.y !== 'string') return false;
  for (const k of Object.keys(v)) if (k !== 'kty' && k !== 'crv' && k !== 'x' && k !== 'y') return false;
  try {
    createPublicKey({ key: v as never, format: 'jwk' });
    return true;
  } catch {
    return false;
  }
}

interface Call {
  method: 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
}

class Unsendable extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export interface SenderOptions {
  db: DatabaseSync;
  config: WorkerAdminConfig;
  sealKey?: Buffer | null;
  now?: () => Date;
  /** Run the timer chain (default true). Tests turn it off and call `drain()`. */
  auto?: boolean;
  pollMs?: number;
}

export class WorkerOutboxSender {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private readonly o: SenderOptions;

  constructor(o: SenderOptions) {
    this.o = o;
  }

  start(): void {
    // a fixed admin token (or a Worker that is back) must recover rows an older run gave up on
    this.requeueFailed();
    if (this.o.auto === false || this.timer !== null || this.stopped) return;
    this.schedule(this.o.pollMs ?? POLL_MS);
  }

  /** Put every failed row back to pending (called at start). A real validation error fails again and stays visible. */
  requeueFailed(): number {
    try {
      const r = this.o.db.prepare("UPDATE worker_outbox SET state = 'pending', attempts = 0, next_at = '' WHERE state = 'failed'").run();
      return Number(r.changes);
    } catch {
      return 0;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  status(): OutboxStatus {
    return outboxStatus(this.o.db);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain().finally(() => this.schedule(this.o.pollMs ?? POLL_MS));
    }, ms);
    this.timer.unref();
  }

  /** Send every due item once, in id order (one row per key, so order per key holds). Stops at the first retryable failure. */
  async drain(onlyKey?: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const nowIso = (this.o.now?.() ?? new Date()).toISOString();
      const rows = onlyKey
        ? this.o.db.prepare("SELECT * FROM worker_outbox WHERE key = ? AND state = 'pending' AND next_at <= ?").all(onlyKey, nowIso)
        : this.o.db.prepare("SELECT * FROM worker_outbox WHERE state = 'pending' AND next_at <= ? ORDER BY id").all(nowIso);
      for (const row of rows) {
        if (this.stopped) return;
        if (!(await this.sendOne(row))) return;
      }
    } catch (error) {
      // the database may be closing; the reason code is enough
      if (!this.stopped) console.error('worker outbox pass failed', error instanceof Error ? error.name : 'error');
    } finally {
      this.running = false;
    }
  }

  /** Try one key now; true when the Worker has accepted it (the row is gone). Used at link time. */
  async flushKey(key: string): Promise<boolean> {
    await this.drain(key);
    return this.o.db.prepare('SELECT 1 AS x FROM worker_outbox WHERE key = ?').get(key) === undefined;
  }

  private callFor(row: Row): Call {
    const key = String(row.key);
    const id = encodeURIComponent(key.slice(key.indexOf('/') + 1));
    let body: unknown;
    switch (String(row.kind)) {
      case 'dirty': {
        body = JSON.parse(String(row.body));
        const seq = isPlain(body) ? body.seq : undefined;
        if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= 0) throw new Unsendable('bad_seq');
        return { method: 'PUT', path: `/_admin/dirty/${id}`, body: { seq } };
      }
      case 'dev_put': {
        body = JSON.parse(String(row.body));
        if (!isPlain(body) || !publicJwkOk(body.jwk) || typeof body.revoked !== 'boolean') throw new Unsendable('bad_jwk');
        return { method: 'PUT', path: `/_admin/dev/${id}`, body: { jwk: body.jwk, revoked: body.revoked } };
      }
      case 'dev_delete':
        return { method: 'DELETE', path: `/_admin/dev/${id}` };
      case 'site_put': {
        if (!this.o.sealKey) throw new Unsendable('no_seal_key');
        let wakeSecret: unknown;
        try {
          wakeSecret = (JSON.parse(openSecret(this.o.sealKey, String(row.body))) as { wakeSecret?: unknown }).wakeSecret;
        } catch {
          throw new Unsendable('unsealable');
        }
        if (typeof wakeSecret !== 'string' || wakeSecret === '') throw new Unsendable('unsealable');
        return { method: 'PUT', path: `/_admin/site/${id}`, body: { wakeSecret } };
      }
      case 'site_delete':
        return { method: 'DELETE', path: `/_admin/site/${id}` };
      default:
        throw new Unsendable('bad_kind');
    }
  }

  /** Returns false to stop the pass (the Worker is unreachable or unwell). */
  private async sendOne(row: Row): Promise<boolean> {
    const { db, config } = this.o;
    const id = Number(row.id);
    const rev = Number(row.rev);
    const key = String(row.key);
    let call: Call;
    try {
      call = this.callFor(row);
    } catch (error) {
      this.fail(id, rev, key, error instanceof Unsendable ? error.code : 'bad_item', true);
      return true;
    }
    let status = 0;
    let reason = '';
    try {
      const res = await (config.fetchImpl ?? fetch)(`${config.url.replace(/\/+$/, '')}${call.path}`, {
        method: call.method,
        redirect: 'manual',
        headers: { Authorization: `Bearer ${config.token}`, ...(call.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      status = res.status;
      await res.arrayBuffer().catch(() => undefined);
    } catch (error) {
      reason = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'timeout' : 'network';
    }
    const ok = status >= 200 && status < 300 ? true : call.method === 'DELETE' && status === 404;
    if (ok) {
      // only if nobody replaced the row while it was in flight
      db.prepare('DELETE FROM worker_outbox WHERE id = ? AND rev = ?').run(id, rev);
      return true;
    }
    if (status !== 0) reason = `http_${status}`;
    // 401/403 are an operator problem (wrong or expired admin token): keep retrying with the capped backoff,
    // the admin fixes the token and the queue drains. 400/404/409/422 are real validation errors: failed, visible.
    const retryable = status === 0 || status >= 500 || status === 408 || status === 429 || status === 401 || status === 403;
    if (retryable) {
      this.retryLater(id, rev, key, reason);
      return false;
    }
    this.fail(id, rev, key, reason, false);
    return true;
  }

  private retryLater(id: number, rev: number, key: string, reason: string): void {
    const attempts = Number(this.o.db.prepare('SELECT attempts FROM worker_outbox WHERE id = ? AND rev = ?').get(id, rev)?.attempts ?? 0) + 1;
    const nextAt = new Date((this.o.now?.() ?? new Date()).getTime() + backoffMs(attempts)).toISOString();
    this.o.db.prepare('UPDATE worker_outbox SET attempts = ?, next_at = ?, last_error = ? WHERE id = ? AND rev = ?').run(attempts, nextAt, reason, id, rev);
    console.error(`worker outbox: ${key} will retry (${reason})`);
  }

  private fail(id: number, rev: number, key: string, reason: string, local: boolean): void {
    this.o.db.prepare("UPDATE worker_outbox SET state = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ? AND rev = ?").run(reason, id, rev);
    console.error(`worker outbox: ${key} failed, not retried (${local ? 'unsendable ' : ''}${reason})`);
  }
}
