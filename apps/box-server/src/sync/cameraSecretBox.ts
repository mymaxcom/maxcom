import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { CameraStore, cameraBackupOf } from '../live/camera.ts';
import { getSettings } from '../settingsStore.ts';
import { LOCAL_SURAU_ID } from '../tenant.ts';
import { CameraError } from '../live/camera.ts';
import { BOX_REPORT_HEADERS, cloudFetch } from './agent.ts';
import { openFromCloud, relayAad } from './cameraRelayCrypto.ts';
import { loadSyncKey, normaliseCloudUrl } from './syncKey.ts';

/**
 * The box's side of the camera address backup (plan 4.2, 7; cloud side: `cameraSecretCloud.ts`).
 *
 *  - After the camera is saved or cleared (`PUT` / `DELETE /api/live/camera` answered 2xx) the box sends the backup
 *    form to the cloud over the site-authenticated link: `PUT` with {address without the password, user name,
 *    hasPassword}, or `DELETE` when none is left. The password never leaves the box (operator decision 2026-11-19:
 *    the cloud must not be able to read it). The cloud seals what it gets under its own key per surau.
 *  - A change is first marked pending (`sync_state`), and the mark is cleared only when the cloud confirmed. A
 *    sleeping or unreachable cloud leaves the mark, and the timer tries again. While a mark is set the box never
 *    restores, so a camera removed here cannot be brought back by an older cloud copy.
 *  - A box with no camera of its own (a replaced box of the same surau, linked by a new code) asks the cloud once
 *    after it starts; a record found is saved through the box's own `CameraStore` (so it passes the same address
 *    rules), and when the camera had a password it is marked "password needed" for the surau to type it again. A box
 *    that has a camera pushes it once after it starts instead.
 *  - Nothing here logs the address, the login or what the cloud answered. A failure is a short fixed reason.
 */

const TIMEOUT_MS = 8_000;
const BODY_CAP = 8 * 1024;
const PENDING_KEY = 'camera_secret_pending';
const FIRST_MS = 20_000;
const EVERY_MS = 5 * 60_000;

export type CameraSecretOutcome = 'stored' | 'removed' | 'restored' | 'none' | 'skipped' | 'failed';

export interface CameraSecretSyncOptions {
  db: DatabaseSync;
  dataDir: string;
  now: () => Date;
  /** The box's own LAN addresses (the store refuses an address pointing at the box). */
  boxIps?: readonly string[] | undefined;
  /** The fetch that reaches the cloud (default: the sync agent's, which trusts the surau root CA). */
  fetchImpl?: typeof fetch | undefined;
  /** Operator override of the address the box was linked to. */
  cloudUrl?: string | null | undefined;
  /** Wakes an asleep cloud (the sync agent's signed call). */
  wake?: (() => Promise<unknown>) | undefined;
  /** Run the timer (default true). Tests drive `push` / `restore` / `tick` themselves. */
  auto?: boolean | undefined;
  /** This box's id: a change sent through the cloud is applied only when it was sealed for this id. */
  boxId?: string | undefined;
}

export type CameraRelayOutcome = 'none' | 'applied' | 'refused' | 'rejected' | 'skipped' | 'failed';

const RELAY_SEQ_KEY = 'camera_relay_seq';
const RELAY_RESULT_KEY = 'camera_relay_result';


export class CameraSecretSync {
  private readonly o: CameraSecretSyncOptions;
  private readonly store: CameraStore;
  private readonly fetchImpl: typeof fetch;
  private bootDone = false;
  private busy: Promise<CameraSecretOutcome> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;

  constructor(o: CameraSecretSyncOptions) {
    this.o = o;
    this.store = new CameraStore(o.dataDir, { boxIps: o.boxIps ?? [], now: o.now });
    this.fetchImpl = o.fetchImpl ?? cloudFetch(o.dataDir);
  }

  /** Linked to a cloud and `cloudSync` on (the same test as the YouTube leg). */
  private link(): { token: string; base: string } | null {
    try {
      if (getSettings(this.o.db, LOCAL_SURAU_ID).cloudSync.enabled !== true) return null;
      const key = loadSyncKey(this.o.dataDir);
      if (key === null) return null;
      const override = this.o.cloudUrl ? normaliseCloudUrl(this.o.cloudUrl) : null;
      return { token: key.siteToken, base: override ?? key.cloudUrl };
    } catch {
      return null;
    }
  }

  private pending(): boolean {
    return this.o.db.prepare('SELECT 1 AS x FROM sync_state WHERE key = ?').get(PENDING_KEY) !== undefined;
  }

  private setPending(on: boolean): void {
    if (on) this.o.db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(PENDING_KEY, this.o.now().toISOString());
    else this.o.db.prepare('DELETE FROM sync_state WHERE key = ?').run(PENDING_KEY);
  }

  /** One request to the cloud: status and the (size-capped) JSON body only. */
  private async call(method: 'GET' | 'PUT' | 'DELETE' | 'POST', body?: unknown, path = '/api/sync/camera-secret'): Promise<{ status: number; json: Record<string, unknown> } | null> {
    const link = this.link();
    if (link === null) return null;
    // every request a box sends to the cloud says which theme contract it supports (as the sync agent does)
    const headers: Record<string, string> = { Authorization: `Bearer ${link.token}`, ...BOX_REPORT_HEADERS };
    const init: RequestInit = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) };
    // a write with nothing to say still sends `{}` as JSON (never a bodyless POST, PUT or DELETE); a GET sends nothing
    if (body !== undefined || method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body ?? {});
    }
    try {
      const res = await this.fetchImpl(`${link.base}${path}`, init);
      let text = '';
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
            return null;
          }
          chunks.push(value);
        }
        text = Buffer.concat(chunks).toString('utf8');
      }
      let json: Record<string, unknown> = {};
      try {
        const v: unknown = JSON.parse(text);
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) json = v as Record<string, unknown>;
      } catch {
        json = {};
      }
      return { status: res.status, json };
    } catch {
      return null;
    }
  }

  /** Called after the camera was saved or cleared here: marks the change and tries to deliver it. Never throws. */
  changed(): Promise<CameraSecretOutcome> {
    try {
      this.setPending(true);
    } catch {
      return Promise.resolve('failed');
    }
    return this.push().then((first) => (first !== 'failed' && first !== 'skipped' && this.pending() ? this.push() : first));
  }

  /** Makes the cloud match this box: the record when there is one, else removal. Clears the pending mark on success. */
  push(): Promise<CameraSecretOutcome> {
    if (this.busy !== null) return this.busy;
    const run = (async (): Promise<CameraSecretOutcome> => {
      try {
        if (this.link() === null) return 'skipped';
        const record = this.store.backup();
        const first = await this.call(record === null ? 'DELETE' : 'PUT', record ?? undefined);
        let res = first;
        if ((res === null || res.status === 503) && this.o.wake !== undefined) {
          // asleep: wake it once and try again
          await this.o.wake().catch(() => undefined);
          res = await this.call(record === null ? 'DELETE' : 'PUT', record ?? undefined);
        }
        if (res === null || res.status < 200 || res.status >= 300) return 'failed';
        // the record may have changed while the request was out: the mark stays then, and the next try sends it
        const after = this.store.backup();
        const same = (after === null && record === null) || (after !== null && record !== null && JSON.stringify(after) === JSON.stringify(record));
        if (same) this.setPending(false);
        return record === null ? 'removed' : 'stored';
      } catch {
        return 'failed';
      }
    })().finally(() => {
      this.busy = null;
    });
    this.busy = run;
    return run;
  }

  /** A box with no camera asks the cloud for its surau's backup. Saves it through the store; never throws. */
  async restore(): Promise<CameraSecretOutcome> {
    try {
      if (this.link() === null) return 'skipped';
      if (this.pending() || this.store.get() !== null) return 'skipped';
      let res = await this.call('GET');
      if ((res === null || res.status === 503) && this.o.wake !== undefined) {
        await this.o.wake().catch(() => undefined);
        res = await this.call('GET');
      }
      if (res === null || (res.status !== 200 && res.status !== 404)) return 'failed';
      if (res.status === 404) return 'none';
      // the backup holds no password (anything else the answer carries is ignored): the surau types it again
      const { url, username, hasPassword, passwordNeeded, password } = res.json;
      if (typeof url !== 'string') return 'failed';
      // an older cloud's row may still carry a password, in the address or beside it: it is dropped here too
      const clean = cameraBackupOf({ url, ...(typeof username === 'string' && username !== '' ? { username } : {}) });
      const needed = hasPassword === true || passwordNeeded === true || clean.hasPassword || (typeof password === 'string' && password !== '');
      // a camera saved by hand while the request was out wins
      if (this.store.get() !== null || this.pending()) return 'skipped';
      this.store.save({ url: clean.url, ...(clean.username !== undefined ? { username: clean.username } : {}) }, { passwordNeeded: needed });
      // the cloud learns that this box waits for the password (the phone away from the surau then asks for it too)
      if (needed) {
        this.setPending(true);
        void this.push();
      }
      return 'restored';
    } catch {
      return 'failed';
    }
  }

  // ---- a change sent through the cloud (set from anywhere) -------------------------------------------------------

  private stateGet(key: string): string | null {
    const r = this.o.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
    return r === undefined || r.value === null ? null : String(r.value);
  }

  private stateSet(key: string, value: string): void {
    this.o.db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  private relayBusy = false;

  /**
   * Asks the cloud whether a camera change sealed for this box is waiting; opens it with the box's own key, applies
   * it through the same `CameraStore` rules as the Wi-Fi form, and answers the cloud with the masked result. A number
   * at or below the last applied one is never applied again (a replayed value). It never wakes the cloud and never
   * logs the address or the login. Never throws.
   */
  async relayPoll(): Promise<CameraRelayOutcome> {
    if (this.relayBusy) return 'skipped';
    this.relayBusy = true;
    try {
      return await this.relayRun();
    } catch {
      return 'failed';
    } finally {
      this.relayBusy = false;
    }
  }

  private async relayRun(): Promise<CameraRelayOutcome> {
    if (this.link() === null || this.o.boxId === undefined) return 'skipped';
    const res = await this.call('GET', undefined, '/api/sync/camera-relay');
    if (res === null || (res.status !== 200 && res.status !== 404)) return 'failed';
    if (res.status === 404) return 'none';
    const { seq, op, boxId, sealed } = res.json;
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1 || (op !== 'put' && op !== 'delete') || boxId !== this.o.boxId) return 'rejected';
    const last = Number(this.stateGet(RELAY_SEQ_KEY) ?? '0');
    if (seq < last) {
      // numbered before a change this box already applied (the cloud was restored or relinked): refused, and said so,
      // so the phone sees the refusal and reads again instead of waiting for ever. Nothing is applied or remembered.
      await this.relayAck(seq, false, 'stale');
      return 'refused';
    }
    if (seq === last) {
      // applied before, the answer did not get through: say the same thing again, change nothing
      let prev: { seq?: unknown; ok?: unknown; code?: unknown } = {};
      try {
        prev = JSON.parse(this.stateGet(RELAY_RESULT_KEY) ?? '{}') as typeof prev;
      } catch {
        prev = {};
      }
      if (prev.seq !== seq) return 'rejected';
      await this.relayAck(seq, prev.ok === true, typeof prev.code === 'string' ? prev.code : undefined);
      return prev.ok === true ? 'applied' : 'refused';
    }

    let ok = false;
    let code: string | undefined;
    try {
      if (op === 'delete') {
        this.store.clear();
      } else {
        const key = loadSyncKey(this.o.dataDir);
        if (key === null || typeof sealed !== 'string') throw new CameraError(400, 'unreadable', 'unreadable');
        let plain: Record<string, unknown>;
        try {
          plain = JSON.parse(openFromCloud(key.privateJwk, sealed, relayAad(this.o.boxId, seq))) as Record<string, unknown>;
        } catch {
          throw new CameraError(400, 'unreadable', 'unreadable');
        }
        if (plain.seq !== seq || plain.boxId !== this.o.boxId || typeof plain.url !== 'string') throw new CameraError(400, 'unreadable', 'unreadable');
        const masked = this.store.save({
          url: plain.url,
          ...(typeof plain.username === 'string' ? { username: plain.username } : {}),
          ...(typeof plain.password === 'string' ? { password: plain.password } : {}),
        });
        this.audit('save', { url: masked.url, hasPassword: masked.hasPassword });
      }
      if (op === 'delete') this.audit('clear', {});
      ok = true;
    } catch (error) {
      // a fixed code, never the text of what failed
      code = error instanceof CameraError ? (['bad_address', 'bad_login', 'password_again', 'unreadable'].includes(error.code) ? error.code : 'error') : 'error';
    }
    // the number is kept before the answer goes, so a lost answer cannot make the same value apply twice
    this.stateSet(RELAY_SEQ_KEY, String(seq));
    this.stateSet(RELAY_RESULT_KEY, JSON.stringify({ seq, ok, ...(code !== undefined ? { code } : {}) }));
    await this.relayAck(seq, ok, code);
    if (ok) void this.changed();
    return ok ? 'applied' : 'refused';
  }

  private audit(entityId: string, after: Record<string, unknown>): void {
    try {
      this.o.db
        .prepare('INSERT INTO change_log (surau_id, at, actor, entity, entity_id, before_json, after_json, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(LOCAL_SURAU_ID, this.o.now().toISOString(), 'cloud-relay', 'live-camera', entityId, null, JSON.stringify(after), null);
    } catch {
      /* the history never stops a change */
    }
  }

  private async relayAck(seq: number, ok: boolean, code?: string): Promise<void> {
    const m = this.store.getMasked();
    const display = { configured: m.configured, url: m.url, username: m.username, hasPassword: m.hasPassword, ...(m.passwordNeeded === true ? { passwordNeeded: true } : {}) };
    const body = ok ? { seq, ok: true, display } : { seq, ok: false, code: code ?? 'error' };
    await this.call('POST', body, '/api/sync/camera-relay/ack');
  }

  /** One timer round: deliver a pending change, else (once after start) push an existing camera or restore a missing one. */
  async tick(): Promise<void> {
    try {
      if (this.link() === null) return;
      if (this.pending()) {
        await this.push();
        return;
      }
      if (this.bootDone) return;
      const out = this.store.get() !== null ? await this.push() : await this.restore();
      if (out !== 'failed') this.bootDone = true;
    } catch {
      /* the next round tries again */
    }
  }

  start(): void {
    if (this.o.auto === false || this.timer !== null) return;
    this.first = setTimeout(() => void this.tick(), FIRST_MS);
    this.first.unref();
    this.timer = setInterval(() => void this.tick(), EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.first !== null) clearTimeout(this.first);
    if (this.timer !== null) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
  }
}

/**
 * Wires the backup to the camera routes without touching them: a saved or cleared camera (`PUT` / `DELETE
 * /api/live/camera` answered 2xx) triggers `changed()` after the answer has gone. Box role with a data folder only.
 */
export function attachCameraSecretSync(app: FastifyInstance, o: CameraSecretSyncOptions): CameraSecretSync {
  const sync = new CameraSecretSync(o);
  app.addHook('onResponse', async (request, reply) => {
    if (request.method !== 'PUT' && request.method !== 'DELETE') return;
    if (reply.statusCode < 200 || reply.statusCode >= 300) return;
    if ((request.url.split('?')[0] ?? '') !== '/api/live/camera') return;
    void sync.changed();
  });
  sync.start();
  app.addHook('onClose', async () => sync.stop());
  return sync;
}
