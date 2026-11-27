import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { THEME_BUNDLE_FORMAT, THEME_CONTRACT, isThemeName } from '@surau/core';
import type { KioskLive } from '@surau/core';
import type { ChangeBus } from '../events.ts';
import type { PinnedClient } from '../link/peerClient.ts';
import { LOCAL_SURAU_ID } from '../tenant.ts';
import { assetKey, themeKey } from './cache.ts';
import type { FileKind, FollowCache, PutResult } from './cache.ts';
import type { FollowRecord, FollowStore } from './store.ts';

/**
 * The follower box reads its master exactly as a paired TV does: the TV token goes in the kiosk cookie, every request
 * goes through the pinned client (only the master's root CA is trusted). What it receives is stored unchanged and
 * served unchanged; the master has already laid this TV's profile over the answer.
 *
 * One loop: hold ONE event stream to the master; the first `changed` event names the master's version, and the stored
 * copy is fetched again only when that differs (or something is missing). Each later event is re-emitted on this
 * box's own bus so its TV reacts within a second or two. When the master is away the loop backs off (1 s, doubling
 * to 60 s, with jitter) and the TV keeps showing the stored copy.
 */

export interface MirrorState {
  connected: boolean;
  /** ISO time of the last contact with the master, or null when there never was one. */
  lastOkAt: string | null;
  masterVersion: number | null;
  /** The master speaks a newer theme or bundle contract than this build understands: the stored copy keeps being shown. */
  needsUpdate: boolean;
  /** The master's signed order to forget the surau was verified and accepted. Nothing is fetched any more. */
  removed: boolean;
}

export interface Mirror {
  start(): void;
  stop(): Promise<void>;
  state(): MirrorState;
  /** The master address in use (or last in use), or null. */
  origin(): string | null;
}

export interface MirrorDeps {
  follow: FollowStore;
  client: Pick<PinnedClient, 'request' | 'json'>;
  cache: FollowCache;
  bus: ChangeBus;
  /** This box's own id, as the master knows it (the `boxId` of `POST /api/link/peer/order`). */
  boxId: string;
  now: () => Date;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Never receives the token or the cookie. */
  log: (event: string, detail?: Record<string, string | number | boolean | null>) => void;
  /**
   * Called with the master's answer that claims to be an order to forget the surau. The caller verifies the signature
   * and plans the emptying of the box; it returns true only when the order was genuine and is being carried out.
   * Anything else leaves the mirror running: an answer that does not verify is no order.
   */
  onOrder?: (order: unknown) => boolean;
  random?: () => number;
  /** Seconds between two forced refreshes while connected (the date moves on without a version change). */
  refreshMs?: number;
  /** Wait before a file that failed is fetched again. */
  retryMs?: number;
  /** No byte from the event stream (not even a heartbeat) for this long: reconnect. */
  idleMs?: number;
}

export const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const t = setTimeout(done, ms);
    t.unref();
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

const ASSET_ID_RE = /^[0-9a-f]{64}$/;
/** What a theme pack serves (`themes/routes.ts`): the stylesheet and the pack's pictures. */
export const THEME_PATH_RE = /^\/themes\/([a-z0-9-]{1,60})\/([0-9a-f]{16}-[1-9][0-9]{0,2})\/(bundle\.css|images\/[a-z-]{1,12}\.(?:jpg|png))$/;
export const ASSET_PATH_RE = /^\/assets\/([0-9a-f]{64})$/;

const MIN_MS = 1000;
const MAX_MS = 60_000;
/** A session that held this long counts as good: the back-off starts again at the minimum. */
const GOOD_MS = 10_000;
const PARALLEL = 2;
const MAX_SSE_BUFFER = 1024 * 1024;
const MAX_CSS_BYTES = 256 * 1024;
const MAX_RETRIES = 6;
/** Longer than the master's heartbeat (25 s) so an idle but healthy stream is not cut by the socket timeout. */
const STREAM_TIMEOUT_MS = 90_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

class Revoked extends Error {
  readonly origin: string;
  constructor(origin: string) {
    super('master refused the token');
    this.origin = origin;
  }
}
class Down extends Error {
  constructor(why: string) {
    super(why);
  }
}

/** The bundle without the master's clock: two answers that differ only by `serverTime` are the same copy. */
const stable = (v: unknown): string => (isObj(v) ? JSON.stringify({ ...v, serverTime: undefined }) : JSON.stringify(v));

function contractsNewer(bundle: unknown): boolean {
  if (!isObj(bundle)) return false;
  for (const k of ['contract', 'themeContract']) if (typeof bundle[k] === 'number' && (bundle[k] as number) > THEME_CONTRACT) return true;
  for (const k of ['bundleFormat', 'themeBundleFormat']) if (typeof bundle[k] === 'number' && (bundle[k] as number) > THEME_BUNDLE_FORMAT) return true;
  const packs = isObj(bundle.settings) && isObj(bundle.settings.themeStyle) ? bundle.settings.themeStyle.packs : undefined;
  if (isObj(packs)) {
    for (const p of Object.values(packs)) if (isObj(p) && typeof p.contract === 'number' && p.contract > THEME_CONTRACT) return true;
  }
  return false;
}

interface PackFiles {
  name: string;
  assetId: string;
  files: string[];
}

/** The installed packs of the bundle this build understands, with the files each serves. */
function packsOf(bundle: unknown): PackFiles[] {
  const out: PackFiles[] = [];
  const packs = isObj(bundle) && isObj(bundle.settings) && isObj(bundle.settings.themeStyle) ? bundle.settings.themeStyle.packs : undefined;
  if (!isObj(packs)) return out;
  for (const [name, p] of Object.entries(packs)) {
    if (!isThemeName(name) || !isObj(p) || typeof p.assetId !== 'string' || !ASSET_ID_RE.test(p.assetId)) continue;
    if (typeof p.contract !== 'number' || p.contract > THEME_CONTRACT) continue;
    const base = `/themes/${name}/${p.assetId.slice(0, 16)}-${THEME_BUNDLE_FORMAT}`;
    const files = [`${base}/bundle.css`];
    if (isObj(p.images)) {
      for (const [screen, ext] of Object.entries(p.images)) {
        if ((ext === 'jpg' || ext === 'png') && /^[a-z-]{1,12}$/.test(screen)) files.push(`${base}/images/${screen}.${ext}`);
      }
    }
    out.push({ name, assetId: p.assetId, files });
  }
  return out;
}

/** Every asset id the bundle and the content name (pictures, audio, videos, the logo), except the theme pack files. */
export function assetIdsOf(bundle: unknown, content: unknown): string[] {
  const skip = new Set(packsOf(bundle).map((p) => p.assetId));
  if (isObj(bundle) && isObj(bundle.settings) && isObj(bundle.settings.themeStyle) && isObj(bundle.settings.themeStyle.packs)) {
    for (const p of Object.values(bundle.settings.themeStyle.packs)) if (isObj(p) && typeof p.assetId === 'string') skip.add(p.assetId);
  }
  const found = new Set<string>();
  let budget = 200_000;
  const walk = (v: unknown, depth: number): void => {
    if (--budget < 0 || depth > 14) return;
    if (typeof v === 'string') {
      if (ASSET_ID_RE.test(v) && !skip.has(v)) found.add(v);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
    } else if (isObj(v)) {
      for (const x of Object.values(v)) walk(x, depth + 1);
    }
  };
  walk(bundle, 0);
  walk(content, 0);
  return [...found];
}

/** Server-sent events: feeds on chunks, yields whole events. */
function sseParser(): (chunk: string) => { event: string; data: string }[] {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    if (buf.length > MAX_SSE_BUFFER) buf = '';
    const out: { event: string; data: string }[] = [];
    let i: number;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length > 0) out.push({ event, data: data.join('\n') });
    }
    return out;
  };
}

function mimeOf(res: IncomingMessage): string {
  const t = res.headers['content-type'];
  return typeof t === 'string' && /^[a-z0-9][a-z0-9.+-]{0,60}\/[a-z0-9][a-z0-9.+-]{0,100}(?:\s*;\s*[a-z0-9=._-]{1,60})?$/i.test(t) ? t : 'application/octet-stream';
}

function lengthOf(res: IncomingMessage): number | null {
  const l = res.headers['content-length'];
  return typeof l === 'string' && /^\d{1,12}$/.test(l) ? Number(l) : null;
}

export function createMirror(d: MirrorDeps): Mirror {
  const random = d.random ?? Math.random;
  const refreshMs = d.refreshMs ?? 30 * 60_000;
  const retryMs = d.retryMs ?? 30_000;
  const idleMs = d.idleMs ?? 3 * 25_000;

  /**
   * K3: the mirrored live is only as good as the stream it came over. A stored `live: true` is replaced by "not live"
   * (kept: its sound setting and volume are not ours to invent) and this box's TV is told, once. Never throws.
   */
  const clearLive = (): void => {
    try {
      const have = d.cache.getJson<Record<string, unknown>>('live');
      if (!isObj(have) || have.live !== true) return;
      const off: KioskLive = { live: false, since: null, kuliah: null, audio: have.audio === true, volume: typeof have.volume === 'number' ? have.volume : 0 };
      d.cache.putJson('live', off);
      d.bus.emitLive(off, LOCAL_SURAU_ID);
    } catch {
      /* the cache is a convenience: the next event from the master sets it right */
    }
  };

  let running = false;
  let removed = false;
  let ordered = false;
  let connected = false;
  let ctl: AbortController | null = null;
  let loop: Promise<void> | null = null;
  let good: string | null = null;
  let lastOkMs: number | null = null;
  let masterVersion: number | null = null;
  let needsUpdate = false;

  const saved = d.cache.getJson<{ lastOkAt?: unknown }>('mirror-state');
  if (saved !== null && typeof saved.lastOkAt === 'string' && !Number.isNaN(Date.parse(saved.lastOkAt))) lastOkMs = Date.parse(saved.lastOkAt);
  const stored = d.cache.getJson<unknown>('bundle');
  if (isObj(stored) && typeof stored.version === 'number') masterVersion = stored.version;
  needsUpdate = contractsNewer(stored);

  const persist = (): void => {
    d.cache.putJson('mirror-state', { lastOkAt: lastOkMs === null ? null : new Date(lastOkMs).toISOString() });
  };
  const touch = (): void => {
    lastOkMs = d.now().getTime();
  };

  const cookieOf = (rec: FollowRecord): Record<string, string> => ({ cookie: `surau_kiosk=${rec.token}` });

  /** One GET with the TV cookie. 401 and 403 mean the token is revoked; anything that fails to answer is `Down`. */
  const get = async (rec: FollowRecord, origin: string, path: string, extra: Record<string, string> = {}, timeoutMs?: number): Promise<IncomingMessage> => {
    let res: IncomingMessage;
    try {
      res = await d.client.request(origin, rec.masterCa, {
        path, headers: { ...cookieOf(rec), ...extra }, ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(ctl ? { signal: ctl.signal } : {}),
      });
    } catch {
      throw new Down('unreachable');
    }
    if (res.statusCode === 401 || res.statusCode === 403) {
      res.resume();
      throw new Revoked(origin);
    }
    return res;
  };

  const getJson = async (rec: FollowRecord, origin: string, path: string): Promise<unknown> => {
    let r: { status: number; json: unknown };
    try {
      r = await d.client.json(origin, rec.masterCa, { path, headers: cookieOf(rec), ...(ctl ? { signal: ctl.signal } : {}) });
    } catch {
      throw new Down('unreachable');
    }
    if (r.status === 401 || r.status === 403) throw new Revoked(origin);
    if (r.status !== 200 || r.json === null) throw new Down(`status ${r.status}`);
    return r.json;
  };

  /** One file of the master into the cache: 'ok', 'skip' (gone or does not fit: not tried again soon), 'retry'. */
  const fetchFile = async (rec: FollowRecord, origin: string, path: string, key: string, sha256: string | undefined, kindOf: (mime: string) => FileKind): Promise<'ok' | 'skip' | 'retry'> => {
    let res: IncomingMessage;
    try {
      res = await get(rec, origin, path);
    } catch (e) {
      if (e instanceof Revoked) throw e;
      return 'retry';
    }
    if (res.statusCode === 404) {
      res.resume();
      return 'skip';
    }
    if (res.statusCode !== 200) {
      res.resume();
      return 'retry';
    }
    const mime = mimeOf(res);
    const etag = typeof res.headers.etag === 'string' ? res.headers.etag : null;
    const r: PutResult = await d.cache.putFile(key, { kind: kindOf(mime), mime, ...(sha256 !== undefined ? { sha256 } : {}), length: lengthOf(res), etag }, res);
    if (r === 'stored') return 'ok';
    if (r === 'no_space') {
      d.log('file_not_stored', { reason: 'no_space', path });
      return 'skip';
    }
    d.log('file_refused', { reason: r, path });
    return 'retry';
  };

  const pool = async <T>(items: T[], fn: (x: T) => Promise<void>): Promise<void> => {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
      while (i < items.length && running) await fn(items[i++]!);
    }));
  };

  /** Fetches every file the stored copy names that the cache lacks. Returns how many are worth another try. */
  const fetchMissing = async (rec: FollowRecord, origin: string, bundle: unknown, content: unknown): Promise<number> => {
    let retry = 0;
    const kind = (mime: string): FileKind => (mime.startsWith('video/') ? 'video' : mime.startsWith('image/') ? 'image' : 'other');
    const ids = assetIdsOf(bundle, content).filter((id) => d.cache.info(assetKey(id)) === null);
    await pool(ids, async (id) => {
      if ((await fetchFile(rec, origin, `/assets/${id}`, assetKey(id), id, kind)) === 'retry') retry++;
    });
    for (const pack of packsOf(bundle)) {
      for (const path of pack.files) {
        const key = themeKey(path);
        if (d.cache.info(key) === null && (await fetchFile(rec, origin, path, key, undefined, () => 'theme')) === 'retry') retry++;
      }
      // Files the stylesheet names (fonts and pictures of the same pack).
      const css = d.cache.info(themeKey(pack.files[0]!));
      if (css === null || css.size > MAX_CSS_BYTES) continue;
      let text = '';
      try {
        text = readFileSync(css.path, 'utf8');
      } catch {
        continue;
      }
      const named = new Set<string>();
      for (const m of text.matchAll(/url\(\s*(['"]?)(\/themes\/[^)'"\s]+)\1\s*\)/g)) if (THEME_PATH_RE.test(m[2]!)) named.add(m[2]!);
      for (const path of named) {
        const key = themeKey(path);
        if (d.cache.info(key) === null && (await fetchFile(rec, origin, path, key, undefined, () => 'theme')) === 'retry') retry++;
      }
    }
    return retry;
  };

  /** Bundle and content again; stored and announced when they differ from the stored copy; then the files. */
  const refresh = async (rec: FollowRecord, origin: string): Promise<number> => {
    const bundle = await getJson(rec, origin, '/api/kiosk/bundle');
    const content = await getJson(rec, origin, '/api/kiosk/content');
    if (!isObj(bundle) || typeof bundle.version !== 'number' || !isObj(bundle.settings) || !Array.isArray(bundle.days) || !isObj(content) || typeof content.version !== 'number') {
      d.log('master_answer_odd');
      throw new Down('shape');
    }
    touch();
    const changed = stable(d.cache.getJson('bundle')) !== stable(bundle) || stable(d.cache.getJson('content')) !== stable(content);
    if (changed) {
      const ok = d.cache.putJson('bundle', bundle) && d.cache.putJson('content', content);
      if (!ok) d.log('store_failed');
    }
    masterVersion = bundle.version;
    needsUpdate = contractsNewer(bundle);
    persist();
    if (changed) d.bus.emit(bundle.version, LOCAL_SURAU_ID);
    return fetchMissing(rec, origin, bundle, content);
  };

  /**
   * Holds the event stream of one address until it ends. Throws `Down` when no stream could be opened, `Revoked` when
   * the master refuses the token; returns when an open stream ended.
   */
  const session = async (rec: FollowRecord, origin: string): Promise<void> => {
    const res = await get(rec, origin, '/api/kiosk/events', { accept: 'text/event-stream' }, STREAM_TIMEOUT_MS);
    if (res.statusCode !== 200) {
      res.resume();
      throw new Down(`events ${res.statusCode ?? 0}`);
    }
    good = origin;
    connected = true;
    touch();
    d.log('connected', { origin });

    let revoked: Revoked | null = null;
    let syncing = false;
    let want: 'full' | 'files' | null = null;
    let tries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const stopStream = (): void => {
      res.destroy();
    };
    const onAbort = (): void => stopStream();
    ctl?.signal.addEventListener('abort', onAbort, { once: true });

    const schedule = (): void => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      if (tries >= MAX_RETRIES || !running) return;
      tries++;
      retryTimer = setTimeout(() => sync('files'), retryMs);
      retryTimer.unref();
    };

    // 'full': bundle and content again, then the files. 'files': only the files the stored copy names that are missing.
    // One run at a time; a request that arrives during a run asks for one more.
    const sync = (mode: 'full' | 'files'): void => {
      want = want === 'full' || mode === 'full' ? 'full' : 'files';
      if (syncing) return;
      syncing = true;
      void (async () => {
        try {
          while (want !== null && running) {
            const m = want;
            want = null;
            let left: number;
            if (m === 'full') left = await refresh(rec, origin);
            else left = await fetchMissing(rec, origin, d.cache.getJson('bundle'), d.cache.getJson('content'));
            if (left > 0) schedule();
            else tries = 0;
          }
        } catch (e) {
          if (e instanceof Revoked) {
            revoked = e;
            stopStream();
          } else {
            d.log('sync_failed');
            want = null;
            tries = Math.min(tries, MAX_RETRIES);
            if (tries < MAX_RETRIES && running) {
              tries++;
              if (retryTimer !== null) clearTimeout(retryTimer);
              retryTimer = setTimeout(() => sync('full'), retryMs);
              retryTimer.unref();
            }
          }
        } finally {
          syncing = false;
        }
      })();
    };

    const periodic = setInterval(() => sync('full'), refreshMs);
    periodic.unref();
    let idle: ReturnType<typeof setTimeout> | null = null;
    const armIdle = (): void => {
      if (idle !== null) clearTimeout(idle);
      idle = setTimeout(() => {
        d.log('stream_idle');
        stopStream();
      }, idleMs);
      idle.unref();
    };
    armIdle();

    const parse = sseParser();
    const handle = (ev: { event: string; data: string }): void => {
      let data: unknown;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!isObj(data)) return;
      if (ev.event === 'changed' && typeof data.version === 'number') {
        const have = d.cache.getJson<unknown>('bundle');
        const same = isObj(have) && have.version === data.version && d.cache.getJson('content') !== null;
        masterVersion = data.version;
        // The same version after a reconnect fetches no bundle and no content; it only completes missing files.
        sync(same ? 'files' : 'full');
      } else if (ev.event === 'live' && typeof data.live === 'boolean') {
        d.cache.putJson('live', data);
        d.bus.emitLive(data as unknown as KioskLive, LOCAL_SURAU_ID);
      } else if (ev.event === 'play-now' && typeof data.itemId === 'string') {
        d.bus.emitPlayNow(data.itemId, LOCAL_SURAU_ID);
      }
    };

    try {
      for await (const chunk of res) {
        touch();
        armIdle();
        for (const ev of parse(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))) handle(ev);
      }
    } catch {
      // A stream that breaks is an ended stream.
    } finally {
      clearInterval(periodic);
      if (idle !== null) clearTimeout(idle);
      if (retryTimer !== null) clearTimeout(retryTimer);
      ctl?.signal.removeEventListener('abort', onAbort);
      connected = false;
      persist();
      // K3: without the stream nothing would ever say that the master's live ended (or that the master restarted)
      clearLive();
      d.log('disconnected', { origin });
    }
    if (revoked !== null) throw revoked;
  };

  /** The master refused the token: ask it why. Only a signed order ends the mirror, and the caller acts on it. */
  const askOrder = async (rec: FollowRecord, origin: string): Promise<void> => {
    let r: { status: number; json: unknown };
    try {
      r = await d.client.json(origin, rec.masterCa, {
        method: 'POST', path: '/api/link/peer/order', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ boxId: d.boxId, linkId: rec.linkId }),
      });
    } catch {
      d.log('order_unreachable');
      return;
    }
    // `forget` (taken off), or an unlink's `revert` / `standalone`: the caller checks the signature and acts
    if (r.status !== 200 || !isObj(r.json) || (r.json.order !== 'forget' && r.json.order !== 'revert' && r.json.order !== 'standalone')) {
      d.log('token_refused_no_order', { status: r.status });
      return;
    }
    if (ordered) return;
    let accepted = false;
    try {
      accepted = d.onOrder?.(r.json) === true;
    } catch {
      accepted = false;
    }
    if (!accepted) {
      // Not signed by the master this box stored, or it could not be carried out now: asked again after the back-off.
      d.log('order_not_accepted');
      return;
    }
    ordered = true;
    removed = true;
    running = false;
    d.log('order_received');
  };

  const run = async (): Promise<void> => {
    let delay = MIN_MS;
    const signal = ctl!.signal;
    while (running && !removed) {
      const rec = d.follow.read();
      const t0 = d.now().getTime();
      let held = false;
      if (rec !== null) {
        const order = good !== null && rec.addresses.includes(good) ? [good, ...rec.addresses.filter((a) => a !== good)] : rec.addresses;
        for (const origin of order) {
          if (!running) break;
          try {
            await session(rec, origin);
            held = true;
            break;
          } catch (e) {
            if (e instanceof Revoked) {
              await askOrder(rec, e.origin);
              break;
            }
            d.log('address_down', { origin });
          }
        }
      }
      if (!running || removed) break;
      if (held && d.now().getTime() - t0 >= GOOD_MS) delay = MIN_MS;
      await d.sleep(Math.round(delay * (0.75 + 0.5 * random())), signal);
      delay = Math.min(delay * 2, MAX_MS);
    }
  };

  return {
    start() {
      if (running || removed) return;
      running = true;
      // K3: a live:true an earlier run left on disk is not a live now; the master's first event says what is
      clearLive();
      ctl = new AbortController();
      loop = run().catch(() => undefined).finally(() => {
        connected = false;
      });
    },
    async stop() {
      running = false;
      ctl?.abort();
      await loop;
      loop = null;
    },
    state() {
      return {
        connected,
        lastOkAt: lastOkMs === null ? null : new Date(lastOkMs).toISOString(),
        masterVersion,
        needsUpdate,
        removed,
      };
    },
    origin: () => good,
  };
}
