import { reqSurau } from '../reqSurau.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { cleanYoutubeText, youtubeMetaFor } from '@surau/core';
import type { YoutubeMeta } from '@surau/core';
import { actorOf, deviceOf } from '../actor.ts';
import { randomToken } from '../auth/crypto.ts';
import { logChange } from '../auth/users.ts';
import { getItem } from '../content/store.ts';
import type { YoutubeService } from '../live/youtube/api.ts';
import { YoutubeError, youtubeErrorCode, youtubeErrorStatus, youtubeErrorText } from '../live/youtube/oauth.ts';
import { getSettings } from '../settingsStore.ts';
import { YOUTUBE_AT_BOX_MSG } from './youtubeBoxCloud.ts';

/**
 * The catch-up upload routes (Plan 6, Task 5) and the three old box-leg routes.
 *
 * Release 2026.11.13: the grant is held by the surau's BOX, and since 2026.11.15 (phase 4) the cloud holds none at all:
 *  - for a signed-in device with `live:control` (the catch-up upload): `POST /api/youtube/upload/begin`,
 *    `POST /api/youtube/upload/progress`, `POST /api/youtube/upload/done`, `POST /api/youtube/verify`,
 *    `GET /api/youtube/quota`. They answer on the box, from its own grant (at the surau). `begin` opens a Google
 *    resumable session and hands the session address to that one device; the device PUTs the bytes straight to Google.
 *    No Google token ever leaves the box and the session address is never stored, logged or put in `change_log`. On
 *    the cloud there is no service, so `begin` answers 409 `youtube_at_box`.
 *  - for a box that has not updated since before 2026.11.13 (site identity): `POST /api/cloud/youtube/broadcast`,
 *    `POST /api/cloud/youtube/complete`, `GET /api/cloud/youtube/status`. The cloud serves no broadcast now: each
 *    answers 409 `youtube_at_box`, which that box shows as a refusal to start a YouTube live.
 *
 * Every route has a row in `ROUTE_PERMISSIONS`. A device session on a site route (and the reverse) gets 404 / 403.
 */

export interface YoutubeCloudDeps {
  /** The box-leg routes exist on both roles (the route table is one), but answer 404 on a box. */
  role: 'box' | 'cloud';
  db: DatabaseSync;
  now: () => Date;
  /** The box's own YouTube service; null on the cloud (it holds no sign-in) and on a box without a data folder (unit tests). */
  youtube: YoutubeService | null;
  /** U4, U5: how often the sweep runs (expired upload sessions, set-private steps still owed). Default 5 minutes; 0 = no timer. */
  sweepMs?: number;
}

/** U5: a set-private step that keeps failing is given up after this long (the live stays as it is; the app is told `gone`). */
export const REPLACE_GIVE_UP_MS = 7 * 86_400_000;
const SWEEP_MS = 5 * 60_000;
const SWEEP_BATCH = 20;
const SESSION_ID_MAX = 100;

/** What became of the "replace the dropped live" step of an upload. */
export type ReplaceState = 'done' | 'pending' | 'gone';
/** `replaced_at`: an ISO time = done, `gone@<time>` = given up (the live video no longer exists, or 7 days of failures), a claim or NULL = still owed. */
export function replaceStateOf(replacedAt: unknown): ReplaceState {
  if (typeof replacedAt !== 'string' || replacedAt.startsWith('claim')) return 'pending';
  return replacedAt.startsWith('gone@') ? 'gone' : 'done';
}

/** U4: open upload sessions older than the 7 days Google keeps them are dead: they stop counting, in every surau. Returns how many. */
export function expireOpenUploads(db: DatabaseSync, now: Date, surauId?: string): number {
  const before = new Date(now.getTime() - UPLOAD_OPEN_MS).toISOString();
  const r =
    surauId === undefined
      ? db.prepare("UPDATE uploads SET state = 'expired' WHERE state = 'open' AND created_at < ?").run(before)
      : db.prepare("UPDATE uploads SET state = 'expired' WHERE surau_id = ? AND state = 'open' AND created_at < ?").run(surauId, before);
  return Number(r.changes);
}

/**
 * The "set the dropped live private" step of one finished upload, once. The claim marker keeps a repeated `done`,
 * a concurrent one and the sweep from doing it twice. A failure leaves the step owed (U5: the sweep tries again);
 * a live video Google no longer has ends it as `gone`.
 */
async function replaceLive(
  db: DatabaseSync,
  now: () => Date,
  yt: YoutubeService | null,
  u: { surauId: string; uploadId: string; live: string; videoId: string; actor: string; deviceId: string | null },
): Promise<ReplaceState> {
  // a claim left by a crashed attempt (older than 10 minutes, or the bare old marker) is taken over
  db.prepare("UPDATE uploads SET replaced_at = NULL WHERE surau_id = ? AND id = ? AND (replaced_at = 'claim' OR (replaced_at LIKE 'claim@%' AND substr(replaced_at, 7) < ?))").run(
    u.surauId,
    u.uploadId,
    new Date(now().getTime() - CLAIM_STALE_MS).toISOString(),
  );
  const claim = db.prepare('UPDATE uploads SET replaced_at = ? WHERE surau_id = ? AND id = ? AND replaced_at IS NULL').run(`claim@${now().toISOString()}`, u.surauId, u.uploadId);
  if (Number(claim.changes) !== 1) return replaceStateOf(db.prepare('SELECT replaced_at FROM uploads WHERE surau_id = ? AND id = ?').get(u.surauId, u.uploadId)?.replaced_at);
  const settle = (value: string | null): void => void db.prepare("UPDATE uploads SET replaced_at = ? WHERE surau_id = ? AND id = ? AND replaced_at LIKE 'claim%'").run(value, u.surauId, u.uploadId);
  try {
    if (yt === null) throw new YoutubeError('not_configured');
    await yt.setPrivacy(u.live, 'private');
    settle(now().toISOString());
    logChange(db, u.actor, 'youtube/replaceLive', u.live, null, { uploadId: u.uploadId, videoId: u.live, newVideoId: u.videoId }, u.deviceId !== null ? { deviceId: u.deviceId } : undefined, u.surauId);
    return 'done';
  } catch (error) {
    if (error instanceof YoutubeError && error.reason === 'not_found') {
      // the live video is gone from the channel: nothing is left to hide, and nothing to try again
      settle(`gone@${now().toISOString()}`);
      return 'gone';
    }
    // the upload itself is done and must not be uploaded again: this step stays owed
    settle(null);
    return 'pending';
  }
}

/**
 * U4 + U5, the sweep: expires dead upload sessions and tries again the set-private steps still owed, a few at a
 * time. Runs on a timer of the routes and may be called by hand. Never throws; returns what it did.
 */
export async function sweepUploads(db: DatabaseSync, now: () => Date, ytFor: (surauId: string) => YoutubeService | null): Promise<{ expired: number; replaced: number; gone: number }> {
  const out = { expired: 0, replaced: 0, gone: 0 };
  try {
    out.expired = expireOpenUploads(db, now());
    const owed = db
      .prepare("SELECT surau_id, id, replace_video_id, video_id, device_id, finished_at FROM uploads WHERE state = 'done' AND replace_video_id IS NOT NULL AND video_id IS NOT NULL AND (replaced_at IS NULL OR replaced_at LIKE 'claim%') ORDER BY finished_at LIMIT ?")
      .all(SWEEP_BATCH);
    for (const r of owed) {
      const surauId = String(r.surau_id);
      const uploadId = String(r.id);
      const finished = Date.parse(String(r.finished_at));
      if (Number.isFinite(finished) && now().getTime() - finished > REPLACE_GIVE_UP_MS) {
        db.prepare("UPDATE uploads SET replaced_at = ? WHERE surau_id = ? AND id = ? AND (replaced_at IS NULL OR replaced_at LIKE 'claim%')").run(`gone@${now().toISOString()}`, surauId, uploadId);
        out.gone += 1;
        continue;
      }
      let yt: YoutubeService | null = null;
      try {
        yt = ytFor(surauId);
      } catch {
        yt = null;
      }
      // no service or signed out: the step waits for the sign-in
      if (yt === null || !yt.signedIn()) continue;
      const state = await replaceLive(db, now, yt, { surauId, uploadId, live: String(r.replace_video_id), videoId: String(r.video_id), actor: 'system', deviceId: typeof r.device_id === 'string' ? r.device_id : null });
      if (state === 'done') out.replaced += 1;
      else if (state === 'gone') out.gone += 1;
    }
  } catch {
    /* the next round */
  }
  return out;
}

export const UPLOAD_LIMIT_PER_DAY = 100;
/** Open upload sessions one device may hold; a Google resumable session lives 7 days. */
export const OPEN_UPLOADS_PER_DEVICE = 10;
const UPLOAD_OPEN_MS = 7 * 86_400_000;
/** A set-private claim older than this was left by a crashed `done`; a later `done` takes it over. */
const CLAIM_STALE_MS = 10 * 60_000;
/** Google and this cloud's clock may differ a little; a video published this much before `begin` still counts. */
const PUBLISH_SKEW_MS = 2 * 60_000;
const TITLE_MAX = 100;
const MAX_UPLOAD_BYTES = 256 * 1024 ** 3;
const MAX_PARTS = 50;
const VERIFY_MAX_IDS = 20;
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

const MSG = {
  quota: 'Had penggunaan YouTube dicapai. Cuba lagi selepas masa set semula.',
  reauthorise: 'Log masuk YouTube di awan perlu dibuat semula',
  notConfigured: 'YouTube belum disediakan di awan',
  forbidden: 'YouTube menolak permintaan ini',
  notFound: 'Video tidak ditemui di YouTube',
  network: 'Tidak dapat menghubungi YouTube',
  badRequest: 'Permintaan tidak sah',
  catchupOff: 'Muat naik susulan YouTube dimatikan',
  unknownLive: 'Siaran langsung itu tidak dikenali',
  unknownVideo: 'Video itu tidak dikenali di saluran ini',
  tooManyUploads: 'Terlalu banyak muat naik yang belum selesai',
  alreadyUploading: 'Rakaman siaran ini sedang dimuat naik dari peranti lain',
  uploadAbandoned: 'Muat naik ini telah dibatalkan',
  uploadExpired: 'Muat naik ini telah tamat tempoh',
  notFoundRoute: 'not found',
} as const;

// ---- the YouTube quota day: it resets at midnight America/Los_Angeles --------------------------------------

const LA = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
});

function laParts(t: number): { y: number; m: number; d: number; h: number; mi: number } {
  const o: Record<string, number> = {};
  for (const p of LA.formatToParts(new Date(t))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year!, m: o.month!, d: o.day!, h: o.hour!, mi: o.minute! };
}

/** The UTC instant of 00:00 in Los Angeles on that calendar date (PDT is UTC-7, PST UTC-8: tried in turn, verified). */
function laMidnight(y: number, m: number, d: number): number {
  for (const off of [7, 8]) {
    const c = Date.UTC(y, m - 1, d, off);
    const p = laParts(c);
    if (p.y === y && p.m === m && p.d === d && p.h === 0 && p.mi === 0) return c;
  }
  return Date.UTC(y, m - 1, d, 8);
}

/** The quota day `now` falls in: when it started and when it resets (both ISO UTC). */
export function pacificWindow(now: Date): { since: string; resetsAt: string } {
  const p = laParts(now.getTime());
  const next = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
  return {
    since: new Date(laMidnight(p.y, p.m, p.d)).toISOString(),
    resetsAt: new Date(laMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate())).toISOString(),
  };
}

// ---- helpers ----------------------------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const cut = (s: string, max: number): string => Array.from(s).slice(0, max).join('');

function sendYoutubeFailure(reply: FastifyReply, error: unknown, now: () => Date): FastifyReply {
  const reason = error instanceof YoutubeError ? error.reason : 'network';
  reply.header('Cache-Control', 'no-store');
  switch (reason) {
    case 'quota':
      return reply.code(429).send({ errors: [MSG.quota], code: 'youtube_quota', resetsAt: pacificWindow(now()).resetsAt });
    case 'reauthorise':
      return reply.code(503).send({ errors: [MSG.reauthorise], code: 'youtube_reauthorise' });
    case 'not_configured':
      return reply.code(409).send({ errors: [MSG.notConfigured], code: 'youtube_not_configured' });
    case 'forbidden':
      return reply.code(403).send({ errors: [MSG.forbidden], code: 'youtube_forbidden' });
    case 'not_found':
      return reply.code(404).send({ errors: [MSG.notFound], code: 'youtube_not_found' });
    case 'live_not_enabled':
    case 'clock_wrong':
    case 'client_refused':
    case 'busy_other_box':
      // Y9: its own code and sentence, so the app can say what to do
      return reply.code(youtubeErrorStatus(reason)).send({ errors: [youtubeErrorText(reason) ?? MSG.network], code: youtubeErrorCode(reason) });
    default:
      return reply.code(502).send({ errors: [MSG.network], code: 'youtube_network' });
  }
}

const bad = (reply: FastifyReply, code = 'invalid'): FastifyReply =>
  reply.code(400).header('Cache-Control', 'no-store').send({ errors: [MSG.badRequest], code });

/** Title with the part suffix, cut so the whole stays within YouTube's 100 characters. */
function titleWithPart(base: string, part: { index: number; count: number } | null): string {
  if (part === null) return cut(base, TITLE_MAX);
  const suffix = ` (Bahagian ${part.index} daripada ${part.count})`;
  return cut(cut(base, TITLE_MAX - Array.from(suffix).length).trimEnd(), TITLE_MAX) + suffix;
}

function parsePart(v: unknown): { index: number; count: number } | null | 'bad' {
  if (v === null || v === undefined) return null;
  if (!isRecord(v)) return 'bad';
  const { index, count } = v;
  if (!Number.isInteger(index) || !Number.isInteger(count)) return 'bad';
  const i = index as number;
  const c = count as number;
  return c >= 1 && c <= MAX_PARTS && i >= 1 && i <= c ? { index: i, count: c } : 'bad';
}

/** The kuliah's YouTube text (the same as a live of that kuliah gets), or a plain fallback. */
function metaFor(db: DatabaseSync, kuliahId: string | null, now: Date, surauId: string): YoutubeMeta | 'not_found' {
  const settings = getSettings(db, surauId);
  const surauName = settings.surauInfo.name.trim();
  const fallback: YoutubeMeta = { title: cut(cleanYoutubeText(`Kuliah ${surauName}`).trim(), TITLE_MAX).trim(), description: '', privacy: settings.liveYoutube.privacy };
  if (kuliahId === null) return fallback;
  const k = getItem(db, 'kuliah', kuliahId, surauId);
  if (k === null) return 'not_found';
  const p = getItem(db, 'penceramah', k.penceramahId, surauId);
  if (p === null) return { ...fallback, title: cut(cleanYoutubeText(k.label ?? fallback.title).trim() || fallback.title, TITLE_MAX) };
  const kitab = k.kitabId !== undefined ? getItem(db, 'kitab', k.kitabId, surauId) : null;
  return youtubeMetaFor({ kuliah: k, penceramah: p, kitab, surauName, settings: settings.liveYoutube, now });
}

/** O5: a claim whose device has sent a progress call, then none for this long, is taken over by another device of the same live. */
export const UPLOAD_STALE_MS = 30 * 60_000;
/** S7, I8, F7: a claim that never sent a progress call (an older app, or a phone away from the box) is taken over only after this long. */
export const UPLOAD_NEVER_PINGED_MS = 6 * 60 * 60_000;

/**
 * O5, the upload claim. Runs inside one transaction with no await (the caller owns BEGIN/COMMIT): accepts any session id, refuses a live another device is uploading (or has uploaded), takes over a claim that made
 * no progress for 30 minutes (the old row becomes `superseded`, which may still finish), applies the daily and per-device caps, and inserts the
 * new `open` row. The last-progress time of an open row is kept in `finished_at` (NULL means "since `created_at`").
 */
function claimUpload(a: {
  db: DatabaseSync;
  role: 'box' | 'cloud';
  yt: YoutubeService;
  surauId: string;
  deviceId: string;
  uploadId: string;
  kuliahId: string | null;
  bytes: number;
  replace: string | null;
  sessionId: string | null;
  t0: Date;
  now: () => Date;
  reply: FastifyReply;
}): { ok: true; superseded: Array<{ id: string; finishedAt: string | null }> } | { ok: false; reply: () => FastifyReply } {
  const { db, surauId, deviceId, sessionId, t0, reply } = a;
  const refuse = (make: () => FastifyReply): { ok: false; reply: () => FastifyReply } => ({ ok: false, reply: make });
  // the dead claims this begin takes over, kept so a refusal by Google can put them back (Q4)
  const superseded: Array<{ id: string; finishedAt: string | null }> = [];
  if (sessionId !== null) {
    // I1: any session id is accepted, recorded by this box or not. A browser recording id ('s' + base36 time) and the id of a
    // recording made before `live_sessions` existed have no row, and an older Android id has the box's own shape yet no row
    // either; refusing them left the recording stuck for good. The atomic claim below still gives one device per live.
    // another device's dead claim is taken over by the next device of the live. `finished_at` of an open row is its last
    // progress call: a claim that has one is dead after 30 quiet minutes; a claim that never pinged is judged by its age
    // only, after 6 hours (S7, I8, F7: a phone away from the box sends no progress, and an older app sends none at all)
    const staleBefore = new Date(t0.getTime() - UPLOAD_STALE_MS).toISOString();
    const neverBefore = new Date(t0.getTime() - UPLOAD_NEVER_PINGED_MS).toISOString();
    const dead = db
      .prepare("SELECT id, finished_at FROM uploads WHERE surau_id = ? AND session_id = ? AND device_id <> ? AND state = 'open' AND ((finished_at IS NOT NULL AND finished_at < ?) OR (finished_at IS NULL AND created_at < ?))")
      .all(surauId, sessionId, deviceId, staleBefore, neverBefore);
    for (const d of dead) superseded.push({ id: String(d.id), finishedAt: d.finished_at === null ? null : String(d.finished_at) });
    db.prepare(
      "UPDATE uploads SET state = 'superseded', finished_at = ? WHERE surau_id = ? AND session_id = ? AND device_id <> ? AND state = 'open' AND ((finished_at IS NOT NULL AND finished_at < ?) OR (finished_at IS NULL AND created_at < ?))",
    ).run(t0.toISOString(), surauId, sessionId, deviceId, staleBefore, neverBefore);
    // U6: another device is uploading this very live (or has): this one does not upload it a second time
    const first = db
      .prepare("SELECT state FROM uploads WHERE surau_id = ? AND session_id = ? AND device_id <> ? AND state IN ('open', 'done') ORDER BY created_at DESC LIMIT 1")
      .get(surauId, sessionId, deviceId);
    if (first !== undefined) return refuse(() => reply.code(409).send({ errors: [MSG.alreadyUploading], code: 'already_uploading', state: String(first.state) }));
  }
  // the channel's daily upload limit, before Google is asked (the same count the quota route shows)
  const win = pacificWindow(t0);
  if (Number(db.prepare('SELECT COUNT(*) AS n FROM uploads WHERE surau_id = ? AND created_at >= ?').get(surauId, win.since)?.n ?? 0) >= UPLOAD_LIMIT_PER_DAY) {
    return refuse(() => sendYoutubeFailure(reply, new YoutubeError('quota'), a.now));
  }
  if (Number(db.prepare("SELECT COUNT(*) AS n FROM uploads WHERE surau_id = ? AND device_id = ? AND state = 'open'").get(surauId, deviceId)?.n ?? 0) >= OPEN_UPLOADS_PER_DEVICE) {
    return refuse(() => reply.code(409).send({ errors: [MSG.tooManyUploads], code: 'too_many_uploads' }));
  }
  if (!a.yt.signedIn()) return refuse(() => sendYoutubeFailure(reply, new YoutubeError('reauthorise'), a.now));
  db.prepare(
    `INSERT INTO uploads (surau_id, id, kuliah_id, device_id, state, bytes, created_at, replace_video_id, session_id) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
  ).run(surauId, a.uploadId, a.kuliahId, deviceId, a.bytes, t0.toISOString(), a.replace, sessionId);
  return { ok: true, superseded };
}

// ---- routes -----------------------------------------------------------------------------------------------

export function registerYoutubeCloudRoutes(
  app: FastifyInstance,
  deps: YoutubeCloudDeps,
): void {
  const { db, now } = deps;
  const ytFor = (_surauId: string): YoutubeService | null => deps.youtube;

  const notFound = (reply: FastifyReply): FastifyReply => reply.code(404).header('Cache-Control', 'no-store').send({ errors: [MSG.notFoundRoute] });
  // on a box the box-leg routes exist in the table but not in fact: they are the cloud's side of an old box's live
  const gate = { preHandler: async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => (deps.role === 'cloud' ? undefined : notFound(reply)) };
  /**
   * No YouTube service for this surau. On the cloud that means the grant is (now) held by the surau's box: the
   * catch-up steps are made there, at the surau. On a box it is a box without a data folder.
   */
  const noService = (reply: FastifyReply): FastifyReply =>
    deps.role === 'cloud'
      ? reply.code(409).header('Cache-Control', 'no-store').send({ errors: [YOUTUBE_AT_BOX_MSG], code: 'youtube_at_box' })
      : sendYoutubeFailure(reply, new YoutubeError('not_configured'), now);
  /** The three box routes are for the linked site only: to a device session they do not exist. */
  const siteOnly = (request: FastifyRequest, reply: FastifyReply): { boxId: string } | null => {
    const a = request.auth;
    if (a == null || a.kind !== 'site') {
      notFound(reply);
      return null;
    }
    return { boxId: a.boxId };
  };
  const body = (request: FastifyRequest): Record<string, unknown> => (isRecord(request.body) ? request.body : {});

  // U4 + U5: the box itself keeps at it; no app has to come back for an expired session or an owed set-private
  const sweepMs = deps.sweepMs ?? SWEEP_MS;
  if (sweepMs > 0) {
    let sweeping = false;
    const timer = setInterval(() => {
      if (sweeping) return;
      sweeping = true;
      void sweepUploads(db, now, ytFor).finally(() => {
        sweeping = false;
      });
    }, sweepMs);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  }

  // ---- the old box leg: refused ------------------------------------------------------------------------------

  // A box from before 2026.11.13 asks the cloud for its YouTube live. The cloud holds no sign-in, so it never serves
  // one: a clear refusal code, never a served broadcast. A device session does not know these routes (404).
  const oldBoxLeg = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const site = siteOnly(request, reply);
    if (site === null) return reply;
    return reply.code(409).header('Cache-Control', 'no-store').send({ errors: [YOUTUBE_AT_BOX_MSG], code: 'youtube_at_box' });
  };
  app.post('/api/cloud/youtube/broadcast', gate, oldBoxLeg);
  app.post('/api/cloud/youtube/complete', gate, oldBoxLeg);
  app.get('/api/cloud/youtube/status', gate, oldBoxLeg);

  // ---- the catch-up upload -----------------------------------------------------------------------------

  const deviceOnly = (request: FastifyRequest): string | null => deviceOf(request) ?? null;

  app.post('/api/youtube/upload/begin', async (request, reply) => {
    const surauId = reqSurau(request);
    reply.header('Cache-Control', 'no-store');
    const deviceId = deviceOnly(request);
    if (deviceId === null) return reply.code(403).send({ errors: ['Tidak dibenarkan'] });
    const b = body(request);
    const kuliahId = b.kuliahId === undefined ? null : b.kuliahId;
    if (kuliahId !== null && (typeof kuliahId !== 'string' || kuliahId === '' || kuliahId.length > 80)) return bad(reply);
    const part = parsePart(b.part);
    if (part === 'bad') return bad(reply);
    const bytes = b.bytes;
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_UPLOAD_BYTES) return bad(reply);
    const replace = b.replaceLiveVideoId === undefined ? null : b.replaceLiveVideoId;
    if (replace !== null && (typeof replace !== 'string' || !ID_RE.test(replace))) return bad(reply);
    // U6: the live session the recording belongs to (optional; without it the route behaves as before)
    const sessionId = b.sessionId === undefined || b.sessionId === null ? null : b.sessionId;
    if (sessionId !== null && (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > SESSION_ID_MAX)) return bad(reply);

    if (getSettings(db, surauId).youtubeCatchUp.enabled !== true) return reply.code(409).send({ errors: [MSG.catchupOff], code: 'catchup_off' });
    const yt = ytFor(surauId);
    if (yt === null) return noService(reply);
    // only a video this cloud broadcast itself can be replaced: no device can make another video private
    if (replace !== null && db.prepare("SELECT 1 AS x FROM change_log WHERE surau_id = ? AND entity = 'youtube/broadcast' AND entity_id = ?").get(surauId, replace) === undefined) {
      return reply.code(400).send({ errors: [MSG.unknownLive], code: 'unknown_live_video' });
    }
    const meta = metaFor(db, kuliahId as string | null, now(), surauId);
    if (meta === 'not_found') return reply.code(404).send({ errors: ['Kuliah tidak ditemui'], code: 'kuliah_not_found' });

    // an open session older than the 7 days Google keeps it is dead: it stops counting and cannot be finished
    const t0 = now();
    expireOpenUploads(db, t0, surauId);

    // O5: the checks and the claim are ONE synchronous step (a transaction with no await inside it), so two devices
    // that begin the same live at the same moment cannot both pass; the row exists before Google is asked.
    const uploadId = `up_${randomToken(12)}`;
    type Claim = { ok: true; superseded: Array<{ id: string; finishedAt: string | null }> } | { ok: false; reply: () => FastifyReply };
    let claim: Claim;
    db.exec('BEGIN IMMEDIATE');
    try {
      claim = claimUpload({ db, role: deps.role, yt, surauId, deviceId, uploadId, kuliahId: kuliahId as string | null, bytes, replace, sessionId: sessionId as string | null, t0, now, reply });
      db.exec(claim.ok ? 'COMMIT' : 'ROLLBACK');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (!claim.ok) return claim.reply();

    const title = titleWithPart(meta.title, part);
    try {
      const session = await yt.createResumableUpload({ ...meta, title }, getSettings(db, surauId).liveYoutube.privacy, bytes);
      // the history knows who and how much, never the session address
      logChange(db, actorOf(request), 'youtube/upload', uploadId, null, { uploadId, kuliahId: kuliahId as string | null, deviceId, bytes, ...(sessionId !== null ? { sessionId } : {}) }, { deviceId }, surauId);
      return reply.send({ uploadId, uploadUri: session.uploadUri, expiresAt: session.expiresAt, title });
    } catch (error) {
      // Google refused: the claim is released, so the live is free for this or another device at once
      db.prepare("DELETE FROM uploads WHERE surau_id = ? AND id = ? AND state = 'open'").run(surauId, uploadId);
      // Q4: the dead claims this begin took over are put back as they were, so the live is not left with no claim at all
      for (const d of claim.superseded) db.prepare("UPDATE uploads SET state = 'open', finished_at = ? WHERE surau_id = ? AND id = ? AND state = 'superseded'").run(d.finishedAt, surauId, d.id);
      return sendYoutubeFailure(reply, error, now);
    }
  });

  /**
   * O5: the device that uploads says now and then that bytes still go out (the app calls this every few minutes). It
   * moves the row's last-progress time, which keeps the live's claim from being taken over after 30 quiet minutes.
   * Only the device that began the upload, only while it is open; anything else answers `ok: false` (no 404 oracle).
   */
  app.post('/api/youtube/upload/progress', async (request, reply) => {
    const surauId = reqSurau(request);
    reply.header('Cache-Control', 'no-store');
    const deviceId = deviceOnly(request);
    if (deviceId === null) return reply.code(403).send({ errors: ['Tidak dibenarkan'] });
    const id = body(request).uploadId;
    if (typeof id !== 'string' || id === '' || id.length > 64) return bad(reply);
    const r = db.prepare("UPDATE uploads SET finished_at = ? WHERE surau_id = ? AND id = ? AND device_id = ? AND state = 'open'").run(now().toISOString(), surauId, id, deviceId);
    return reply.send({ ok: Number(r.changes) === 1 });
  });

  app.post('/api/youtube/upload/done', async (request, reply) => {
    const surauId = reqSurau(request);
    reply.header('Cache-Control', 'no-store');
    const deviceId = deviceOnly(request);
    if (deviceId === null) return reply.code(403).send({ errors: ['Tidak dibenarkan'] });
    const b = body(request);
    if (typeof b.uploadId !== 'string' || b.uploadId === '' || b.uploadId.length > 64) return bad(reply);
    if (typeof b.videoId !== 'string' || !ID_RE.test(b.videoId)) return bad(reply);
    const row = db.prepare('SELECT * FROM uploads WHERE surau_id = ? AND id = ?').get(surauId, b.uploadId);
    // another device's upload does not exist for this one
    if (row === undefined || row.device_id !== deviceId) return reply.code(404).send({ errors: ['Muat naik tidak ditemui'], code: 'upload_not_found' });
    if (row.state === 'done' && row.video_id !== b.videoId) return reply.code(409).send({ errors: [MSG.badRequest], code: 'video_mismatch' });
    if (row.state === 'expired') return reply.code(409).send({ errors: [MSG.uploadExpired], code: 'upload_expired' });
    if (row.state === 'abandoned') return reply.code(409).send({ errors: [MSG.uploadAbandoned], code: 'upload_abandoned' });
    // S7: a claim taken over by another device (`superseded`) may still finish: its video is on the channel, so it is
    // recorded (the newer claim of the same live makes a duplicate, which the history shows) instead of being refused
    // after the upload is done. A claim the device itself gave up (`abandoned`) stays refused above.
    if (row.state === 'open' || row.state === 'superseded') {
      // the id is the device's word: it must be a video this very upload made, on this channel, after `begin`
      if (db.prepare('SELECT 1 AS x FROM uploads WHERE surau_id = ? AND video_id = ? AND id <> ?').get(surauId, b.videoId, b.uploadId) !== undefined) return bad(reply, 'unknown_video');
      const yt = ytFor(surauId);
      if (yt === null) return noService(reply);
      try {
        const o = await yt.videoOrigin(b.videoId);
        const began = Date.parse(String(row.created_at));
        const published = o?.publishedAt == null ? Number.NaN : Date.parse(o.publishedAt);
        // Y10: a sign-in whose channel id is not known cannot prove the video is this channel's: not accepted on trust
        // (the service reads the id when it is missing, so this is a Google that could not be asked: tried again later)
        if (o !== null && o.ownChannelId === null) return sendYoutubeFailure(reply, new YoutubeError('network'), now);
        if (o === null || o.channelId !== o.ownChannelId || !(published >= began - PUBLISH_SKEW_MS)) return bad(reply, 'unknown_video');
      } catch (error) {
        return sendYoutubeFailure(reply, error, now);
      }
      db.prepare("UPDATE uploads SET state = 'done', video_id = ?, finished_at = ? WHERE surau_id = ? AND id = ? AND state IN ('open', 'superseded')").run(b.videoId, now().toISOString(), surauId, b.uploadId);
      if (row.state === 'superseded') logChange(db, actorOf(request), 'youtube/upload-late', b.uploadId, null, { uploadId: b.uploadId, videoId: b.videoId, deviceId }, { deviceId }, surauId);
    }

    // set the gappy live private, once. A failure is not hidden (U5): `replaceState` says `pending`, the sweep
    // keeps trying, and a later `done` for this upload reports the outcome.
    const live = typeof row.replace_video_id === 'string' ? row.replace_video_id : null;
    if (live === null) return reply.send({ uploadId: b.uploadId, state: 'done', videoId: b.videoId, replaced: false });
    let yt: YoutubeService | null = null;
    try {
      yt = ytFor(surauId);
    } catch {
      yt = null;
    }
    const replaceState = await replaceLive(db, now, yt, { surauId, uploadId: b.uploadId, live, videoId: b.videoId, actor: actorOf(request), deviceId });
    return reply.send({ uploadId: b.uploadId, state: 'done', videoId: b.videoId, replaced: replaceState === 'done', replaceState });
  });

  /**
   * Clean-up verification (Task 13): does each video exist, is it processed, what privacy and how long. Read
   * only: nothing is written or logged. On the cloud it answers from the cloud's token; on an unlinked box the
   * same route answers from the box's own YouTube service (no role gate: the app asks whichever it reaches).
   */
  app.post('/api/youtube/verify', async (request, reply) => {
    const surauId = reqSurau(request);
    reply.header('Cache-Control', 'no-store');
    const ids = body(request).videoIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > VERIFY_MAX_IDS) return bad(reply);
    if (!ids.every((x) => typeof x === 'string' && ID_RE.test(x))) return bad(reply);
    const unique = Array.from(new Set(ids as string[]));
    const yt = ytFor(surauId);
    if (yt === null) return noService(reply);
    if (!yt.signedIn()) return sendYoutubeFailure(reply, new YoutubeError('reauthorise'), now);
    // only a video this surau logged (a live it broadcast, an upload of its devices) may be asked about: one surau
    // cannot learn the state of another's videos, and (Y10) on a box no caller can probe any other video of the channel
    {
      const mine = db.prepare("SELECT 1 AS x FROM change_log WHERE surau_id = ? AND entity = 'youtube/broadcast' AND entity_id = ? UNION ALL SELECT 1 FROM uploads WHERE surau_id = ? AND video_id = ? LIMIT 1");
      if (!unique.every((id) => mine.get(surauId, id, surauId, id) !== undefined)) return bad(reply, 'unknown_video');
    }
    try {
      const found = new Map((await yt.videosStatus(unique)).map((v) => [v.videoId, v]));
      return reply.send({ results: (ids as string[]).map((id) => found.get(id)!) });
    } catch (error) {
      return sendYoutubeFailure(reply, error, now);
    }
  });

  app.get('/api/youtube/quota', async (request, reply) => {
    const surauId = reqSurau(request);
    reply.header('Cache-Control', 'no-store');
    const w = pacificWindow(now());
    const n = db.prepare('SELECT COUNT(*) AS n FROM uploads WHERE surau_id = ? AND created_at >= ?').get(surauId, w.since)?.n;
    return { uploadsToday: Number(n ?? 0), uploadLimit: UPLOAD_LIMIT_PER_DAY, resetsAt: w.resetsAt };
  });
}