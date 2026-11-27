import { LOCAL_SURAU_ID } from '../../tenant.ts';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { youtubeBusyOnPeer } from '@surau/core';
import type { LiveStatus, YoutubeAccountReason, YoutubeAccountState, YoutubeLastGood, YoutubeMeta, YoutubeOpenBroadcast } from '@surau/core';
import { removeSecretFromBackups } from '../../link/backupInfo.ts';
import { getSettings } from '../../settingsStore.ts';
import type { LiveSessionStore } from '../sessionStore.ts';
import { LiveError } from '../sessions.ts';
import type { YoutubeLeg } from '../sessions.ts';
import { GOOGLE_HOSTS, YoutubeAuth, YoutubeError, failureOf, fetchFailure, googleDetail, googleRequest } from './oauth.ts';
import type { SigninBegin, SigninInfo, SigninPoll, YoutubeReason } from './oauth.ts';

const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3/videos';
const HEALTH_MS = 10_000;
/** A resumable upload session lives a week at Google; the device is told to start a fresh one after that. */
const UPLOAD_SESSION_MS = 7 * 24 * 3_600_000;
const SESSION_BODY_CAP = 64 * 1024;
/** Y8: a complete that failed (no internet, a token Google withdrew) is tried again this often until it lands. */
const COMPLETE_RETRY_MS = 60_000;
/*
 * Y11 IS DORMANT (operator decision 23 Nov 2026, kept for future reference, not wired):
 * - `setPeersOpen` has no caller, so `peersBusy()` / `busyOnPeer()` always answer false and `createNew` never refuses
 *   with `busy_other_box`. `probe()` (Y1) has no caller either; Y1 is met by clearing `lastError` at every start.
 * - Why: in the multi-box model a box linked to another is a FOLLOWER (`app.ts` `followerAtStart`), and a follower runs
 *   no live tools and no YouTube (`link/routes.ts` FOLLOWER_OPEN). Linked boxes therefore never both stream, so a
 *   linked-peers check could never fire.
 * - Unlinked boxes are separate entities by decision, even with the same surau/masjid name or the same YouTube
 *   account: each may stream to YouTube independently (as far as YouTube itself allows several live streams on one
 *   channel). No cloud-side "one live per channel" check is wanted.
 * - If the link model ever lets two linked boxes both go live, wire `setPeersOpen` in `app.ts` over an authenticated
 *   box-to-box call (not the kiosk token) and revisit the `GET /api/youtube/open-broadcast` permission row.
 */
/** Y11 (dormant, see above): how long the box waits for its linked peers before it goes on without their answer. */
const PEERS_WAIT_MS = 3_000;
/** Y6: the refusal of a sign-out while a broadcast is open (the app shows the server's sentence as it is). */
export const SIGNOUT_BROADCAST_OPEN = { status: 409, code: 'youtube_broadcast_open', message: 'Siaran YouTube belum ditutup. Cuba lagi dalam beberapa minit.' } as const;

export type VideoPrivacy = 'private' | 'unlisted' | 'public';

/** The YouTube side of the box: the seam `YoutubeLeg` for the live sessions plus the sign-in used by the routes. */
export interface YoutubeService extends YoutubeLeg {
  configured(): boolean;
  begin(actor: string): Promise<SigninBegin>;
  /** `surauId`: the surau whose change log gets the sign-in row (the request's tenant; default the local one). */
  poll(actor: string, surauId?: string): Promise<SigninPoll>;
  signout(actor: string, surauId?: string): Promise<void>;
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
  /** True while a broadcast of this sign-in is open (made and not yet completed). */
  hasOpenBroadcast(): boolean;
  /** `signIn` is present only while a sign-in is pending or just ended (denied / expired). */
  info(): {
    configured: boolean;
    signedIn: boolean;
    channelTitle: string | null;
    lastError: YoutubeReason | null;
    signIn?: SigninInfo;
    state: YoutubeAccountState;
    reason: YoutubeAccountReason | null;
    lastGood: YoutubeLastGood | null;
    revokedAt: string | null;
  };
  /**
   * The daily look at the grant (one forced token refresh): a withdrawn grant (`invalid_grant`) shows now, with its
   * date, not at "Mula siaran". A network error or a 5xx changes nothing. Never throws.
   */
  verifyGrant(): Promise<'ok' | 'revoked' | 'failed' | 'skipped'>;
  /** Lets the part of the box that knows say why the sign-in cannot be judged yet (status `unknown`, never signed out). */
  setUnknownProbe(fn: (() => 'handover_pending' | 'cloud_unreachable' | null) | null): void;
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
  /** A grant is stored here, even one Google has since withdrawn (release 2026.11.13). */
  holdsGrant(): boolean;
  /** Box: one forced refresh of the stored grant (a handover whose acknowledgement did not get through). */
  proveGrant(): Promise<'ok' | 'invalid_grant' | 'failed'>;
  /** Box: the cloud's grant was withdrawn by Google before it could move: show the re-sign-in state. */
  markRevoked(): void;

  // ---- 2026.11.15 (Siaran langsung revamp). All additive: `YoutubeLeg` and every method above keep their shape.

  /**
   * Y1: the look at "Mula siaran". One cheap authorised read (quota 1; the token is refreshed first when it is due),
   * so "no internet" is what Google says NOW, never what an earlier live left behind. Sets and returns the status's
   * `lastError` (null = reachable and signed in). Also learns the channel id when the sign-in could not read it.
   * Never throws. DORMANT: no caller (see the Y11 note at the top of this file).
   */
  probe(): Promise<YoutubeReason | null>;
  /** The YouTube channel id of THIS box's sign-in (public); null when signed out or not known. */
  channelId(): string | null;
  /**
   * Y11: this box's open broadcast for a linked peer that asks, or null. The newest when several are open. `boxId`
   * is added by the route. Ids only.
   */
  openBroadcast(): { channelId: string | null; broadcastId: string } | null;
  /**
   * Y11: true when a linked peer on the SAME channel id has a broadcast open (`youtubeBusyOnPeer`). A peer that does
   * not answer in 3 s, a box with no peers and a box whose channel id is unknown are never busy. `createBroadcastFor`
   * asks this itself before it makes a NEW broadcast and refuses with reason `busy_other_box`; the live start may ask
   * first to refuse with 409 `youtube_busy_other_box`. Never throws.
   */
  busyOnPeer(): Promise<boolean>;
  /** Y11: how this box asks its linked peers; null = no peers. DORMANT: never called (see the Y11 note at the top). */
  setPeersOpen(fn: (() => Promise<YoutubeOpenBroadcast[]>) | null): void;
  /** D1: where the YouTube gaps of a live are written (`live/sessionStore.ts`); null = not recorded. */
  setSessionStore(store: Pick<LiveSessionStore, 'appendGap'> | null): void;
  /**
   * Y8: tries again every complete that failed. Runs by itself once a minute while one is waiting and right after a
   * new sign-in; returns how many broadcasts are still waiting. Never throws.
   */
  retryCompletes(): Promise<number>;
}

/** A broadcast the service has open. Ids and times only: never a key or a token. */
interface OpenRec {
  broadcastId: string;
  streamId: string;
  createdAt: string;
  seenAt: string;
  /** Y8: `complete` was asked and failed; it is tried again until it lands. */
  ending?: boolean;
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
  /** The surau this service signs in for: its name titles the stream and its change log gets the audit rows (default the local one). */
  surauId?: string;
  /** Token file under the secret folder (default `youtube-token.json`; the cloud uses one per surau). */
  tokenFile?: string;
  /** Open-broadcast record under `live/` (default `youtube-open.json`). */
  openFile?: string;
  /** Called after a sign-in completed here or a sign-out (the box pushes its non-secret flag to the cloud). */
  onChange?: () => void;
  /** First and later daily looks at the grant (a box only; default 5 minutes after start, then every 24 hours). */
  grantCheck?: { firstMs?: number; everyMs?: number; off?: boolean };
  /** D1: where YouTube gaps are written (also `setSessionStore`). A box only. */
  sessionStore?: Pick<LiveSessionStore, 'appendGap'> | null;
  /** Y11: asks the linked peers for their open broadcast (also `setPeersOpen`). A box only. */
  peersOpen?: (() => Promise<YoutubeOpenBroadcast[]>) | null;
  /** Y8: pause between tries of a failed complete (default 60 s). */
  completeRetryMs?: number;
}
const DAY_MS = 24 * 3_600_000;

type Health = NonNullable<LiveStatus['youtube']['health']>;
const HEALTHS: ReadonlySet<string> = new Set<Health>(['noData', 'bad', 'ok', 'good']);

export function createYoutubeService(deps: YoutubeServiceDeps): YoutubeService {
  const { db, now } = deps;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const surauOf = deps.surauId ?? LOCAL_SURAU_ID;
  /** Who started the sign-in the server is carrying: the change log row names them when it completes. */
  let signInActor = 'system';
  const auth = new YoutubeAuth({
    dataDir: deps.dataDir,
    fetchImpl: deps.fetchImpl,
    now,
    timeoutMs,
    ...(deps.tokenFile !== undefined ? { tokenFile: deps.tokenFile } : {}),
    onSignedIn: (channelTitle) => {
      audit(signInActor, 'signin', { channelTitle }, surauOf);
      changed();
      // Y8: a broadcast the withdrawn grant could not close is closed with the new one
      void retryCompletes();
    },
    // a box keeps the last good sign-in and the end of a sign-in across restarts
    persistState: (deps.role ?? 'box') === 'box',
    onRevoked: () => {
      try {
        audit('system', 'revoked', { reason: 'invalid_grant' }, surauOf);
      } catch {
        /* the history never hides the state */
      }
      changed();
    },
  });
  const changed = (): void => {
    try {
      deps.onChange?.();
    } catch {
      /* the flag push never undoes a sign-in or a sign-out */
    }
  };

  let broadcastId: string | null = null;
  let watchUrl: string | null = null;
  let state: LiveStatus['youtube']['state'] = 'none';
  let health: Health | null = null;
  let lastError: YoutubeReason | null = null;
  let streamIdLive: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let polling = false;
  let sessionStore: Pick<LiveSessionStore, 'appendGap'> | null = deps.sessionStore ?? null;
  let peersOpen: (() => Promise<YoutubeOpenBroadcast[]>) | null = deps.peersOpen ?? null;
  /** D1: since when YouTube has not been receiving the running broadcast (ISO time); null while it receives. */
  let gapFrom: string | null = null;
  let completeTimer: NodeJS.Timeout | null = null;

  const audit = (actor: string, entityId: string, after: Record<string, unknown>, surauId: string): void => {
    db.prepare('INSERT INTO change_log (surau_id, at, actor, entity, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      surauId,
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
    const url = `${API}/${path}?${new URLSearchParams(query).toString()}`;
    // a 401 means the access token was spent early: it is refreshed once, silently, and the call is made again.
    // Only Google refusing the refresh (invalid_grant) ends the sign-in.
    for (let attempt = 0; ; attempt++) {
      const token = await auth.accessToken();
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const r = await googleRequest(deps.fetchImpl, url, init, { timeoutMs });
      if (r.status === 401 && attempt === 0) {
        auth.invalidateAccess();
        continue;
      }
      if (r.status < 200 || r.status >= 300) throw failureOf(r.status, r.json);
      return r.json ?? {};
    }
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
      throw fetchFailure(e);
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
    const surau = getSettings(db, surauOf).surauInfo.name.trim();
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
  const openFile = join(deps.dataDir, 'live', deps.openFile ?? 'youtube-open.json');
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
            ...(r.ending === true ? { ending: true as const } : {}),
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
    gapFrom = null;
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
      const active = status?.streamStatus === 'active';
      if (active && state === 'created') state = 'live';
      lastError = null;
      // D1: once the broadcast went live, "not active" or `noData` is a gap (the state itself stays `live`)
      if (state === 'live') markReceiving(active && health !== 'noData');
    } catch (e) {
      // a failed health read never stops the broadcast; it only shows as a short reason
      lastError = e instanceof YoutubeError ? e.reason : 'network';
      // D1: Google cannot be reached from here, so the relay cannot reach it either: the gap starts now
      if (state === 'live' && lastError === 'network') markReceiving(false);
    } finally {
      polling = false;
    }
  }

  function stopTimer(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  /**
   * D1: the box's own record of when YouTube was not receiving. A gap opens at the first look that says so and is
   * written, closed, at the first look that says it receives again (or when the broadcast is completed). Whole
   * seconds only; a gap under one second is not written. A box only: the cloud holds no session record.
   */
  function markReceiving(receiving: boolean): void {
    if (role !== 'box') return;
    const at = now().toISOString();
    if (!receiving) {
      gapFrom ??= at;
      return;
    }
    closeGap(at);
  }
  function closeGap(at: string): void {
    const from = gapFrom;
    gapFrom = null;
    if (from === null || broadcastId === null || sessionStore === null) return;
    if (Date.parse(at) - Date.parse(from) < 1000) return;
    const sessionId = recOf(broadcastId)?.[0];
    if (sessionId === undefined) return;
    try {
      sessionStore.appendGap(sessionId, { from, to: at, kind: 'youtube', broadcastId });
    } catch {
      /* the record never breaks a live */
    }
  }

  /** Y8: the completes that failed, tried again. One pass; the timer stops when none is left. */
  async function retryCompletes(): Promise<number> {
    try {
      if (auth.signedIn()) {
        for (const [k, r] of [...open]) {
          if (r.ending !== true) continue;
          try {
            await finish(r.broadcastId, r.streamId === '' ? null : r.streamId);
            open.delete(k);
            persistOpen();
            if (broadcastId === r.broadcastId) {
              state = 'complete';
              streamIdLive = null;
              lastError = null;
            }
          } catch {
            /* the next pass */
          }
        }
      }
    } catch {
      /* never throws */
    }
    const left = [...open.values()].filter((r) => r.ending === true).length;
    if (left === 0 && completeTimer !== null) {
      clearInterval(completeTimer);
      completeTimer = null;
    }
    return left;
  }
  function scheduleCompleteRetry(): void {
    if (completeTimer !== null) return;
    completeTimer = setInterval(() => void retryCompletes(), deps.completeRetryMs ?? COMPLETE_RETRY_MS);
    completeTimer.unref();
  }

  /** Y11: the peers' open broadcasts; a peer that fails or is slow counts as "nothing open". */
  async function peersBusy(): Promise<boolean> {
    const ask = peersOpen;
    const own = auth.channelId();
    if (role !== 'box' || ask === null || own === null) return false;
    let wait: NodeJS.Timeout | null = null;
    try {
      const answers = await Promise.race([
        ask(),
        new Promise<YoutubeOpenBroadcast[]>((resolve) => {
          wait = setTimeout(() => resolve([]), PEERS_WAIT_MS);
          wait.unref();
        }),
      ]);
      return youtubeBusyOnPeer(own, Array.isArray(answers) ? answers : []);
    } catch {
      return false;
    } finally {
      if (wait !== null) clearTimeout(wait);
    }
  }

  async function createNew(req: { sessionId: string; meta: YoutubeMeta }, sessionKey: string): Promise<{ broadcastId: string; watchUrl: string; key: string }> {
    let stream: { id: string; key: string } | null = null;
    let id = '';
    let bound = false;
    try {
      // Y11: one live per channel between linked boxes; boxes on different channels never block each other
      if (await peersBusy()) throw new YoutubeError('busy_other_box', 409);
      stream = await createStream();
      const created = await call(
        'POST',
        'liveBroadcasts',
        { part: 'snippet,status,contentDetails' },
        {
          snippet: { title: req.meta.title, description: req.meta.description, scheduledStartTime: now().toISOString() },
          status: { privacyStatus: req.meta.privacy, selfDeclaredMadeForKids: false },
          // recordFromStart and enableDvr are YouTube's defaults; set explicitly (as a broadcast made in YouTube Studio has them) so the recording is kept
          contentDetails: { enableAutoStart: true, enableAutoStop: false, enableDvr: true, recordFromStart: true, latencyPreference: 'low', monitorStream: { enableMonitorStream: false } },
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

  /** The daily look at the grant (a box only). The first look comes soon after start, so a withdrawn grant shows before the kuliah. */
  let grantFirst: NodeJS.Timeout | null = null;
  let grantTimer: NodeJS.Timeout | null = null;
  const stopGrantCheck = (): void => {
    if (grantFirst !== null) clearTimeout(grantFirst);
    if (grantTimer !== null) clearInterval(grantTimer);
    grantFirst = null;
    grantTimer = null;
  };
  if (role === 'box' && deps.grantCheck?.off !== true) {
    const look = (): void => void auth.verify().catch(() => undefined);
    grantFirst = setTimeout(look, deps.grantCheck?.firstMs ?? 5 * 60_000);
    grantFirst.unref();
    grantTimer = setInterval(look, deps.grantCheck?.everyMs ?? DAY_MS);
    grantTimer.unref();
  }

  return {
    configured: () => auth.configured(),
    signedIn: () => auth.signedIn(),
    verifyGrant: () => auth.verify().catch(() => 'failed' as const),
    setUnknownProbe: (fn) => auth.setUnknownProbe(fn),

    createBroadcastFor(req: { sessionId: string; meta: YoutubeMeta }) {
      // One broadcast per session: a retry (the first answer was lost) gets the same one, and a retry that
      // arrives while the first is still being made waits for it.
      const sessionKey = req.sessionId;
      const running = creating.get(sessionKey);
      if (running !== undefined) return running;
      // Y1: every start is a fresh attempt; what an earlier live left behind (a failed health read, a failed
      // complete) says nothing about this one
      lastError = null;
      if (state === 'error') state = broadcastId === null ? 'none' : 'complete';
      const p = (async () => {
        const rec = open.get(sessionKey);
        if (rec !== undefined && rec.streamId !== '' && rec.ending !== true) {
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
        // Cloud: a box runs one live at a time, so its other open broadcasts are left over from a power cut
        // (no complete was ever sent, and its status reads keep them from the orphan sweep): end them now.
        const slash = sessionKey.indexOf('/');
        if (role === 'cloud' && slash > 0) {
          const prefix = sessionKey.slice(0, slash + 1);
          for (const [k, r] of [...open]) {
            if (k === sessionKey || !k.startsWith(prefix)) continue;
            try {
              await finish(r.broadcastId, r.streamId === '' ? null : r.streamId);
              open.delete(k);
              persistOpen();
            } catch {
              /* the sweep tries again later */
            }
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
      if (broadcastId === id) {
        stopTimer();
        // D1: a gap still open when the live ends closes with it
        closeGap(now().toISOString());
      }
      const found = recOf(id);
      const streamId = found !== undefined ? found[1].streamId : broadcastId === id ? streamIdLive : null;
      try {
        await finish(id, streamId);
      } catch (e) {
        lastError = e instanceof YoutubeError ? e.reason : 'network';
        state = 'error';
        // Y8: not left for the next box start: tried again every minute, and at the next sign-in
        if (found !== undefined && role === 'box') {
          found[1].ending = true;
          persistOpen();
          scheduleCompleteRetry();
        }
        throw e;
      }
      if (found !== undefined) {
        open.delete(found[0]);
        persistOpen();
      }
      if (broadcastId === id) {
        state = 'complete';
        streamIdLive = null;
        // Y1: the live is over and closed: nothing of it blocks the next one
        lastError = null;
        health = null;
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
            // Y8: the record stays and is tried again every minute, not only at the next start
            r.ending = true;
            scheduleCompleteRetry();
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
      const v = auth.view();
      // `signedIn` stays a plain yes or no for an older app; when the box cannot tell (unknown) it shows what was last good
      const signedIn = v.state === 'signedIn' || (v.state === 'unknown' && v.lastGood !== null);
      return {
        signedIn,
        channelTitle: auth.channelTitle() ?? (v.state === 'unknown' ? v.lastGood?.channelTitle ?? null : null),
        broadcastId,
        state,
        health,
        watchUrl,
        lastError: lastError ?? auth.lastError(),
        channelId: signedIn ? auth.channelId() : null,
        signIn: auth.signInState(),
        account: v,
      };
    },

    info() {
      const signIn = auth.signInState();
      const v = auth.view();
      const signedIn = v.state === 'signedIn' || (v.state === 'unknown' && v.lastGood !== null);
      return {
        configured: auth.configured(),
        signedIn,
        channelTitle: auth.channelTitle() ?? (v.state === 'unknown' ? v.lastGood?.channelTitle ?? null : null),
        lastError: lastError ?? auth.lastError(),
        ...(signIn !== null ? { signIn } : {}),
        state: v.state,
        reason: v.reason,
        lastGood: v.lastGood,
        revokedAt: v.revokedAt,
      };
    },

    hasOpenBroadcast: () => open.size > 0,

    async begin(actor: string): Promise<SigninBegin> {
      const out = await auth.begin();
      signInActor = actor;
      return out;
    },

    async poll(actor: string, surauId: string = surauOf): Promise<SigninPoll> {
      // the server completes the sign-in on its own timer; this route only reports (the change log row is written there)
      void actor;
      void surauId;
      return auth.poll();
    },

    async signout(actor: string, surauId: string = surauOf): Promise<void> {
      // Y6: a broadcast still open (running, or kept for a restart of the same kuliah) would be left open on the
      // channel with no grant to close it: refused until it is closed. A grant Google already withdrew can close
      // nothing, so then the sign-out goes through and the records are dropped.
      // A `LiveError`, so the sign-out route answers 409 with this code and sentence as it does for `live_busy`.
      if (open.size > 0 && auth.signedIn()) throw new LiveError(SIGNOUT_BROADCAST_OPEN.status, SIGNOUT_BROADCAST_OPEN.code, SIGNOUT_BROADCAST_OPEN.message);
      stopTimer();
      if (completeTimer !== null) clearInterval(completeTimer);
      completeTimer = null;
      const { revoked } = await auth.signout();
      open.clear();
      persistOpen();
      broadcastId = null;
      watchUrl = null;
      streamIdLive = null;
      gapFrom = null;
      state = 'none';
      health = null;
      lastError = null;
      // Y7: no copy of the token outlives the sign-out: every backup folder of this box, whatever its kind
      let backupFiles = 0;
      if (role === 'box') {
        try {
          backupFiles = removeSecretFromBackups(deps.dataDir, 'youtube');
        } catch {
          console.error('YouTube: the sign-in could not be removed from a backup folder');
        }
      }
      // `revoked false`: Google did not confirm; the grant may still stand there until it is removed in the Google account
      audit(actor, 'signout', { revoked, ...(backupFiles > 0 ? { backupFiles } : {}) }, surauId);
      changed();
    },

    async probe(): Promise<YoutubeReason | null> {
      try {
        const token = await auth.accessToken();
        const r = await googleRequest(deps.fetchImpl, `${API}/channels?${new URLSearchParams({ part: 'id', mine: 'true' }).toString()}`, { headers: { Authorization: `Bearer ${token}` } }, { timeoutMs });
        if (r.status === 401) {
          auth.invalidateAccess();
          await auth.accessToken();
        } else if (r.status < 200 || r.status >= 300) throw failureOf(r.status, r.json);
        else {
          const first = items(r.json ?? {})[0];
          if (typeof first?.id === 'string') auth.setChannel(first.id, '');
        }
        lastError = null;
        if (state === 'error') state = broadcastId === null ? 'none' : 'complete';
      } catch (e) {
        lastError = e instanceof YoutubeError ? e.reason : fetchFailure(e).reason;
      }
      return lastError;
    },

    channelId: () => (auth.signedIn() ? auth.channelId() : null),

    openBroadcast() {
      const newest = [...open.values()].sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))[0];
      return newest === undefined ? null : { channelId: auth.channelId(), broadcastId: newest.broadcastId };
    },

    busyOnPeer: () => peersBusy(),
    setPeersOpen(fn) {
      peersOpen = fn;
    },
    setSessionStore(store) {
      sessionStore = store;
    },
    retryCompletes: () => retryCompletes(),

    holdsGrant: () => auth.hasGrant(),
    proveGrant: () => auth.prove(),
    markRevoked: () => auth.markRevoked(),

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
        // Y10: a sign-in that could not read its channel at the time learns it here, so the check is never skipped
        ownChannelId: await auth.readOwnChannel().catch(() => null),
      };
    },

    shutdown(): void {
      stopTimer();
      if (completeTimer !== null) clearInterval(completeTimer);
      completeTimer = null;
      stopGrantCheck();
      auth.shutdown();
    },
  };
}
