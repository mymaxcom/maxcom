import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { LiveStatus, YoutubeMeta } from '@surau/core';
import { getSettings } from '../../settingsStore.ts';
import type { YoutubeLeg } from '../sessions.ts';
import { GOOGLE_HOSTS, YoutubeAuth, YoutubeError, failureOf, googleDetail, googleRequest } from './oauth.ts';
import type { SigninBegin, SigninPoll, YoutubeReason } from './oauth.ts';

const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3/videos';
const HEALTH_MS = 10_000;
/** A resumable upload session lives a week at Google; the device is told to start a fresh one after that. */
const UPLOAD_SESSION_MS = 7 * 24 * 3_600_000;
const SESSION_BODY_CAP = 64 * 1024;

export type VideoPrivacy = 'private' | 'unlisted' | 'public';

/** The YouTube side of the box: the seam `YoutubeLeg` for the live sessions plus the sign-in used by the routes. */
export interface YoutubeService extends YoutubeLeg {
  configured(): boolean;
  begin(actor: string): Promise<SigninBegin>;
  poll(actor: string): Promise<SigninPoll>;
  signout(actor: string): Promise<void>;
  /**
   * At start. Box role: ends the broadcasts an earlier run left open (completed if it went live, deleted if
   * not). Cloud role: only reloads the open-broadcast record, because the cloud restarting says nothing about
   * the box's live; the box's own `complete` (or the orphan sweep) ends it. Never throws.
   */
  recover(): Promise<void>;
  /** Cloud: the box with this scope prefix (`<boxId>/`) is still there; its open broadcasts are not orphans. */
  touch(scopePrefix: string): void;
  /** Completes the open broadcasts nobody has touched for `maxAgeMs` (default 6 hours); returns how many were ended. */
  sweepOrphans(maxAgeMs?: number): Promise<number>;
  info(): { configured: boolean; signedIn: boolean; channelTitle: string | null; lastError: YoutubeReason | null };
  /** Stops the health timer (the box is closing). */
  shutdown(): void;
  /**
   * Opens a resumable upload session for one video (catch-up, Plan 6) and returns the session address. The
   * address is a capability: whoever holds it can upload to the channel, so it is returned to the caller
   * only, never stored or logged here. Quota: videos.insert 1600 at Google's published table (the upload
   * limit per day is separate).
   */
  createResumableUpload(meta: YoutubeMeta, privacy: VideoPrivacy, bytes?: number): Promise<{ uploadUri: string; expiresAt: string }>;
  /** `videos.update part=status` (quota 50). Reads the current status first so no other flag is reset. Never deletes. */
  setPrivacy(videoId: string, privacy: VideoPrivacy): Promise<void>;
  /** `videos.list part=status,processingDetails` (quota 1); null when the video does not exist. */
  videoStatus(videoId: string): Promise<{ privacyStatus: string | null; uploadStatus: string | null; processingStatus: string | null } | null>;
  /**
   * `videos.list part=status,processingDetails,contentDetails` for up to 20 ids in ONE call (quota 1). Read only
   * (clean-up verification, Plan 6 Task 13). One result per id, in the order asked; a video Google does not
   * return is `exists false`. `processed` is true only when Google reports the upload processed and, when it
   * reports a processing status, that it succeeded.
   */
  videosStatus(videoIds: readonly string[]): Promise<VideoVerification[]>;
  /**
   * `videos.list part=snippet` for one id (quota 1): when Google published it and on which channel, to check that
   * a video a device names was uploaded just now to this channel. null when Google returns nothing for the id.
   */
  videoOrigin(videoId: string): Promise<{ publishedAt: string | null; channelId: string | null; ownChannelId: string | null } | null>;
}

/** A broadcast the service has open. Ids and times only: never a key or a token. */
interface OpenRec {
  broadcastId: string;
  streamId: string;
  createdAt: string;
  seenAt: string;
}

/** How long an open broadcast may go unseen by the box before the cloud's sweep treats it as an orphan. */
export const ORPHAN_AFTER_MS = 6 * 3_600_000;
const SEEN_PERSIST_MS = 5 * 60_000;

export interface VideoVerification {
  videoId: string;
  exists: boolean;
  processed: boolean;
  privacy: string | null;
  durationSeconds: number | null;
}

/** ISO 8601 duration (`PT1H2M3S`, `P1DT2H`, `P0D`) to whole seconds; null when it is not one. */
export function parseIsoDuration(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(v);
  if (m === null || v === 'P' || v.endsWith('T')) return null;
  const n = (x: string | undefined): number => (x === undefined ? 0 : Number(x));
  return Math.round(n(m[1]) * 86400 + n(m[2]) * 3600 + n(m[3]) * 60 + n(m[4]));
}

export interface YoutubeServiceDeps {
  db: DatabaseSync;
  dataDir: string;
  /** The guarded fetch: https only, public addresses only, no redirects. */
  fetchImpl: typeof fetch;
  now: () => Date;
  timeoutMs?: number;
  healthMs?: number;
  /** `cloud`: recover() never ends a broadcast (see `YoutubeService.recover`). Default `box`. */
  role?: 'box' | 'cloud';
}

type Health = NonNullable<LiveStatus['youtube']['health']>;
const HEALTHS: ReadonlySet<string> = new Set<Health>(['noData', 'bad', 'ok', 'good']);

export function createYoutubeService(deps: YoutubeServiceDeps): YoutubeService {
  const { db, now } = deps;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const auth = new YoutubeAuth({ dataDir: deps.dataDir, fetchImpl: deps.fetchImpl, now, timeoutMs });

  let broadcastId: string | null = null;
  let watchUrl: string | null = null;
  let state: LiveStatus['youtube']['state'] = 'none';
  let health: Health | null = null;
  let lastError: YoutubeReason | null = null;
  let streamIdLive: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let polling = false;

  const audit = (actor: string, entityId: string, after: Record<string, unknown>): void => {
    db.prepare('INSERT INTO change_log (at, actor, entity, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)').run(
      now().toISOString(),
      actor,
      'youtube',
      entityId,
      null,
      JSON.stringify(after),
    );
  };

  /** One authorised call to the YouTube Data API; every failure leaves as a YoutubeError with a short reason. */
  async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, query: Record<string, string>, body?: unknown): Promise<Record<string, unknown>> {
    const token = await auth.accessToken();
    const url = `${API}/${path}?${new URLSearchParams(query).toString()}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const r = await googleRequest(deps.fetchImpl, url, init, { timeoutMs });
    if (r.status < 200 || r.status >= 300) throw failureOf(r.status, r.json);
    return r.json ?? {};
  }

  /**
   * The one request whose answer that matters is a header: the resumable session address (`Location`). Same
   * guard as `googleRequest` (Google hosts, https, timeout, size cap), and the address is checked to be a
   * Google upload address before it leaves this function.
   */
  async function openSession(token: string, body: unknown, bytes: number | null): Promise<string> {
    const url = `${UPLOAD_API}?${new URLSearchParams({ uploadType: 'resumable', part: 'snippet,status' }).toString()}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'video/mp4',
    };
    if (bytes !== null) headers['X-Upload-Content-Length'] = String(bytes);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await deps.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
      let text = '';
      if (res.body) {
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > SESSION_BODY_CAP) {
            ctl.abort();
            throw new YoutubeError('bad_response', res.status);
          }
          chunks.push(value);
        }
        text = Buffer.concat(chunks).toString('utf8');
      }
      let json: Record<string, unknown> | null = null;
      try {
        const v: unknown = JSON.parse(text);
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) json = v as Record<string, unknown>;
      } catch {
        json = null;
      }
      if (res.status < 200 || res.status >= 300) {
        // `uploadLimitExceeded` is the channel's daily upload limit: the same "come back after the reset" as quota
        if (res.status === 403 && googleDetail(json) === 'uploadLimitExceeded') throw new YoutubeError('quota', res.status, 'uploadLimitExceeded');
        throw failureOf(res.status, json);
      }
      const location = res.headers.get('location') ?? '';
      let ok = false;
      try {
        const u = new URL(location);
        ok = u.protocol === 'https:' && GOOGLE_HOSTS.has(u.hostname) && u.username === '' && u.password === '' && location.length <= 2048;
      } catch {
        ok = false;
      }
      if (!ok) throw new YoutubeError('bad_response', res.status);
      return location;
    } catch (e) {
      if (e instanceof YoutubeError) throw e;
      throw new YoutubeError('network');
    } finally {
      clearTimeout(timer);
    }
  }

  const items = (j: Record<string, unknown>): Record<string, unknown>[] =>
    Array.isArray(j.items) ? (j.items as unknown[]).filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : [];

  const keyOf = (stream: Record<string, unknown> | undefined): string => {
    const cdn = stream?.cdn as { ingestionInfo?: { streamName?: unknown } } | undefined;
    const k = cdn?.ingestionInfo?.streamName;
    return typeof k === 'string' ? k : '';
  };

  /**
   * A NON-reusable stream for one session (its key goes to the phone, so it must die with the session).
   * Quota (YouTube Data API v3 published table, not measured here): liveStreams.insert 50, liveStreams.delete 50.
   * Per session with the box leg: stream 50 + broadcast 50 + bind 50 + lifecycle read 1 + transition 50 +
   * stream delete 50 = about 250 of the 10,000 daily units.
   */
  async function createStream(): Promise<{ id: string; key: string }> {
    const surau = getSettings(db).surauInfo.name.trim();
    const made = await call(
      'POST',
      'liveStreams',
      { part: 'snippet,cdn,contentDetails,status' },
      {
        snippet: { title: `MAXCOM ${surau}`.trim().slice(0, 100) },
        cdn: { ingestionType: 'rtmp', resolution: 'variable', frameRate: 'variable' },
        contentDetails: { isReusable: false },
      },
    );
    const id = typeof made.id === 'string' ? made.id : '';
    const key = keyOf(made);
    if (id === '' || key === '') throw new YoutubeError('bad_response');
    return { id, key };
  }

  /** Best effort: used on clean-up paths where a second failure must not hide the first. */
  async function drop(path: 'liveBroadcasts' | 'liveStreams', id: string): Promise<void> {
    try {
      await call('DELETE', path, { id });
    } catch {
      /* already gone, or the next box start retries through the open-broadcast file */
    }
  }

  /* The open broadcasts are written down, by session, so a crash or power cut cannot leave one dangling on the
     channel and a retried request finds the one it made. Ids and times only: no key, no token. */
  const role = deps.role ?? 'box';
  const openFile = join(deps.dataDir, 'live', 'youtube-open.json');
  const open = new Map<string, OpenRec>();
  const creating = new Map<string, Promise<{ broadcastId: string; watchUrl: string; key: string }>>();
  let persistedSeen = 0;
  const persistOpen = (): void => {
    try {
      if (open.size === 0) {
        rmSync(openFile, { force: true });
        return;
      }
      mkdirSync(join(deps.dataDir, 'live'), { recursive: true });
      writeFileSync(openFile, JSON.stringify({ broadcasts: Object.fromEntries(open) }), { mode: 0o600 });
      chmodSync(openFile, 0o600);
      persistedSeen = now().getTime();
    } catch {
      /* a full disk must not break live */
    }
  };
  const idOk = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.length <= 64;
  /** Reads the file into `open` (the old single-slot shape `{broadcastId, streamId}` is read as one record). */
  const loadOpen = (): void => {
    open.clear();
    if (!existsSync(openFile)) return;
    try {
      const j = JSON.parse(readFileSync(openFile, 'utf8')) as Record<string, unknown>;
      const at = now().toISOString();
      if (typeof j.broadcasts === 'object' && j.broadcasts !== null) {
        for (const [k, v] of Object.entries(j.broadcasts as Record<string, unknown>)) {
          const r = v as Record<string, unknown> | null;
          if (r === null || typeof r !== 'object' || !idOk(r.broadcastId) || k.length > 200) continue;
          open.set(k, {
            broadcastId: r.broadcastId,
            streamId: idOk(r.streamId) ? r.streamId : '',
            createdAt: typeof r.createdAt === 'string' ? r.createdAt : at,
            seenAt: typeof r.seenAt === 'string' ? r.seenAt : at,
          });
        }
      } else if (idOk(j.broadcastId)) {
        open.set(`legacy:${j.broadcastId}`, { broadcastId: j.broadcastId, streamId: idOk(j.streamId) ? j.streamId : '', createdAt: at, seenAt: at });
      } else {
        rmSync(openFile, { force: true });
      }
    } catch {
      /* unreadable: leave the file for a person; nothing is guessed */
    }
  };
  const recOf = (id: string): [string, OpenRec] | undefined => [...open].find(([, r]) => r.broadcastId === id);

  /**
   * Ends one broadcast. If it went live it is completed; if it never did (created or ready) it is deleted,
   * so no empty "upcoming" entry piles up on the channel. The stream is deleted last. Throws only when the
   * broadcast itself could not be ended (the open file then stays for the next start).
   * Quota: liveBroadcasts.list 1, transition 50, delete 50 (published table).
   */
  async function finish(id: string, streamId: string | null): Promise<void> {
    let wentLive = true;
    try {
      const b = items(await call('GET', 'liveBroadcasts', { part: 'status', id }))[0];
      const life = (b?.status as { lifeCycleStatus?: unknown } | undefined)?.lifeCycleStatus;
      if (b === undefined || life === 'created' || life === 'ready') wentLive = false;
    } catch {
      wentLive = true; // cannot tell: the old behaviour, try to complete
    }
    if (wentLive) {
      try {
        await call('POST', 'liveBroadcasts/transition', { broadcastStatus: 'complete', id, part: 'status' });
      } catch (e) {
        // already complete: nothing left to do
        if (!(e instanceof YoutubeError && e.status === 403 && /redundantTransition|invalidTransition/.test(e.detail))) throw e;
      }
    } else {
      try {
        await call('DELETE', 'liveBroadcasts', { id });
      } catch (e) {
        if (!(e instanceof YoutubeError && e.reason === 'not_found')) throw e;
      }
    }
    if (streamId !== null && streamId !== '') await drop('liveStreams', streamId);
  }

  /** The status fields follow the newest open broadcast. */
  function adopt(id: string, streamId: string): void {
    broadcastId = id;
    watchUrl = `https://youtu.be/${id}`;
    streamIdLive = streamId === '' ? null : streamId;
    state = 'created';
    health = null;
    lastError = null;
    stopTimer();
    if (streamIdLive !== null) {
      timer = setInterval(() => void pollHealth(), deps.healthMs ?? HEALTH_MS);
      timer.unref();
    }
  }

  async function pollHealth(): Promise<void> {
    if (polling || broadcastId === null || streamIdLive === null) return;
    polling = true;
    try {
      const s = items(await call('GET', 'liveStreams', { part: 'status', id: streamIdLive }))[0];
      const status = s?.status as { streamStatus?: unknown; healthStatus?: { status?: unknown } } | undefined;
      const h = status?.healthStatus?.status;
      health = typeof h === 'string' && HEALTHS.has(h) ? (h as Health) : null;
      if (status?.streamStatus === 'active' && state === 'created') state = 'live';
      lastError = null;
    } catch (e) {
      // a failed health read never stops the broadcast; it only shows as a short reason
      lastError = e instanceof YoutubeError ? e.reason : 'network';
    } finally {
      polling = false;
    }
  }

  function stopTimer(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  async function createNew(req: { sessionId: string; meta: YoutubeMeta }, sessionKey: string): Promise<{ broadcastId: string; watchUrl: string; key: string }> {
    let stream: { id: string; key: string } | null = null;
    let id = '';
    let bound = false;
    try {
      stream = await createStream();
      const created = await call(
        'POST',
        'liveBroadcasts',
        { part: 'snippet,status,contentDetails' },
        {
          snippet: { title: req.meta.title, description: req.meta.description, scheduledStartTime: now().toISOString() },
          status: { privacyStatus: req.meta.privacy, selfDeclaredMadeForKids: false },
          contentDetails: { enableAutoStart: true, enableAutoStop: false, latencyPreference: 'low', monitorStream: { enableMonitorStream: false } },
        },
      );
      id = typeof created.id === 'string' ? created.id : '';
      if (id === '') throw new YoutubeError('bad_response');
      await call('POST', 'liveBroadcasts/bind', { id, part: 'id,contentDetails', streamId: stream.id });
      bound = true;
      const at = now().toISOString();
      open.set(sessionKey, { broadcastId: id, streamId: stream.id, createdAt: at, seenAt: at });
      persistOpen();
      adopt(id, stream.id);
      return { broadcastId: id, watchUrl: `https://youtu.be/${id}`, key: stream.key };
    } catch (e) {
      // nothing half-made is left behind: a failed insert or bind removes what was created
      if (!bound) {
        if (id !== '') await drop('liveBroadcasts', id);
        if (stream !== null) await drop('liveStreams', stream.id);
      }
      lastError = e instanceof YoutubeError ? e.reason : 'network';
      state = 'error';
      throw e;
    }
  }

  return {
    configured: () => auth.configured(),
    signedIn: () => auth.signedIn(),

    createBroadcastFor(req: { sessionId: string; meta: YoutubeMeta }) {
      // One broadcast per session: a retry (the first answer was lost) gets the same one, and a retry that
      // arrives while the first is still being made waits for it.
      const sessionKey = req.sessionId;
      const running = creating.get(sessionKey);
      if (running !== undefined) return running;
      const p = (async () => {
        const rec = open.get(sessionKey);
        if (rec !== undefined && rec.streamId !== '') {
          try {
            const st = items(await call('GET', 'liveStreams', { part: 'cdn', id: rec.streamId }))[0];
            const key = keyOf(st);
            if (st === undefined || key === '') throw new YoutubeError('not_found', 404);
            rec.seenAt = now().toISOString();
            persistOpen();
            if (broadcastId === null) adopt(rec.broadcastId, rec.streamId);
            return { broadcastId: rec.broadcastId, watchUrl: `https://youtu.be/${rec.broadcastId}`, key };
          } catch (e) {
            if (!(e instanceof YoutubeError && e.reason === 'not_found')) throw e;
            // the stream is gone (the broadcast ended): that session starts a fresh one
            open.delete(sessionKey);
            persistOpen();
          }
        }
        return createNew(req, sessionKey);
      })();
      creating.set(sessionKey, p);
      const clear = (): void => void creating.delete(sessionKey);
      p.then(clear, clear);
      return p;
    },

    async complete(id: string): Promise<void> {
      if (broadcastId === id) stopTimer();
      const found = recOf(id);
      const streamId = found !== undefined ? found[1].streamId : broadcastId === id ? streamIdLive : null;
      try {
        await finish(id, streamId);
      } catch (e) {
        lastError = e instanceof YoutubeError ? e.reason : 'network';
        state = 'error';
        throw e;
      }
      if (found !== undefined) {
        open.delete(found[0]);
        persistOpen();
      }
      if (broadcastId === id) {
        state = 'complete';
        streamIdLive = null;
      }
    },

    async recover(): Promise<void> {
      try {
        loadOpen();
        if (open.size === 0) return;
        if (role === 'cloud') {
          // the cloud restarted; the box's live did not: keep the record, show the newest, end nothing
          const newest = [...open.values()].sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))[0]!;
          adopt(newest.broadcastId, newest.streamId);
          return;
        }
        if (!auth.signedIn()) return;
        for (const [k, r] of [...open]) {
          try {
            await finish(r.broadcastId, r.streamId === '' ? null : r.streamId);
            open.delete(k);
          } catch {
            /* the record stays; the next start tries again */
          }
        }
        persistOpen();
      } catch {
        /* the file stays; the next start tries again */
      }
    },

    touch(scopePrefix: string): void {
      const t = now().getTime();
      let write = false;
      for (const [k, r] of open) {
        if (!k.startsWith(scopePrefix)) continue;
        r.seenAt = new Date(t).toISOString();
        write = true;
      }
      if (write && t - persistedSeen >= SEEN_PERSIST_MS) persistOpen();
    },

    async sweepOrphans(maxAgeMs = ORPHAN_AFTER_MS): Promise<number> {
      if (!auth.signedIn()) return 0;
      const t = now().getTime();
      let ended = 0;
      for (const [k, r] of [...open]) {
        if (t - new Date(r.seenAt).getTime() <= maxAgeMs) continue;
        try {
          await finish(r.broadcastId, r.streamId === '' ? null : r.streamId);
          open.delete(k);
          ended++;
          if (broadcastId === r.broadcastId) {
            state = 'complete';
            streamIdLive = null;
            stopTimer();
          }
        } catch {
          /* tried again at the next sweep */
        }
      }
      if (ended > 0) persistOpen();
      return ended;
    },

    status(): LiveStatus['youtube'] {
      return { signedIn: auth.signedIn(), channelTitle: auth.channelTitle(), broadcastId, state, health, watchUrl, lastError: lastError ?? auth.lastError() };
    },

    info: () => ({ configured: auth.configured(), signedIn: auth.signedIn(), channelTitle: auth.channelTitle(), lastError: lastError ?? auth.lastError() }),

    async begin(actor: string): Promise<SigninBegin> {
      void actor;
      return auth.begin();
    },

    async poll(actor: string): Promise<SigninPoll> {
      const wasIn = auth.signedIn();
      const r = await auth.poll();
      if (r.state === 'signed_in' && !wasIn) audit(actor, 'signin', { channelTitle: r.channelTitle });
      return r;
    },

    async signout(actor: string): Promise<void> {
      stopTimer();
      await auth.signout();
      broadcastId = null;
      watchUrl = null;
      state = 'none';
      health = null;
      lastError = null;
      audit(actor, 'signout', {});
    },

    async createResumableUpload(meta: YoutubeMeta, privacy: VideoPrivacy, bytes?: number) {
      const token = await auth.accessToken();
      const uploadUri = await openSession(
        token,
        {
          snippet: { title: meta.title, description: meta.description, categoryId: '22' },
          status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
        },
        typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null,
      );
      return { uploadUri, expiresAt: new Date(now().getTime() + UPLOAD_SESSION_MS).toISOString() };
    },

    async setPrivacy(videoId: string, privacy: VideoPrivacy): Promise<void> {
      const found = items(await call('GET', 'videos', { part: 'status', id: videoId }))[0];
      if (found === undefined) throw new YoutubeError('not_found', 404);
      // videos.update replaces the whole status part: carry over what is there, change only the privacy
      const current = (found.status ?? {}) as Record<string, unknown>;
      const status: Record<string, unknown> = { privacyStatus: privacy };
      for (const k of ['embeddable', 'license', 'publicStatsViewable', 'selfDeclaredMadeForKids'] as const) {
        if (current[k] !== undefined) status[k] = current[k];
      }
      await call('PUT', 'videos', { part: 'status' }, { id: videoId, status });
    },

    async videoStatus(videoId: string) {
      const v = items(await call('GET', 'videos', { part: 'status,processingDetails', id: videoId }))[0];
      if (v === undefined) return null;
      const st = (v.status ?? {}) as Record<string, unknown>;
      const pd = (v.processingDetails ?? {}) as Record<string, unknown>;
      const t = (x: unknown): string | null => (typeof x === 'string' ? x.slice(0, 40) : null);
      return { privacyStatus: t(st.privacyStatus), uploadStatus: t(st.uploadStatus), processingStatus: t(pd.processingStatus) };
    },

    async videosStatus(videoIds: readonly string[]): Promise<VideoVerification[]> {
      const ids = videoIds.slice(0, 20);
      if (ids.length === 0) return [];
      const got = new Map<string, Record<string, unknown>>();
      for (const v of items(await call('GET', 'videos', { part: 'status,processingDetails,contentDetails', id: ids.join(',') }))) {
        if (typeof v.id === 'string') got.set(v.id, v);
      }
      return ids.map((videoId) => {
        const v = got.get(videoId);
        if (v === undefined) return { videoId, exists: false, processed: false, privacy: null, durationSeconds: null };
        const st = (v.status ?? {}) as Record<string, unknown>;
        const pd = (v.processingDetails ?? {}) as Record<string, unknown>;
        const cd = (v.contentDetails ?? {}) as Record<string, unknown>;
        const processing = typeof pd.processingStatus === 'string' ? pd.processingStatus : null;
        return {
          videoId,
          exists: true,
          processed: st.uploadStatus === 'processed' && (processing === null || processing === 'succeeded'),
          privacy: typeof st.privacyStatus === 'string' ? st.privacyStatus.slice(0, 40) : null,
          durationSeconds: parseIsoDuration(cd.duration),
        };
      });
    },

    async videoOrigin(videoId: string) {
      const v = items(await call('GET', 'videos', { part: 'snippet', id: videoId }))[0];
      if (v === undefined) return null;
      const sn = (v.snippet ?? {}) as Record<string, unknown>;
      return {
        publishedAt: typeof sn.publishedAt === 'string' ? sn.publishedAt : null,
        channelId: typeof sn.channelId === 'string' ? sn.channelId : null,
        ownChannelId: auth.channelId(),
      };
    },

    shutdown: stopTimer,
  };
}
