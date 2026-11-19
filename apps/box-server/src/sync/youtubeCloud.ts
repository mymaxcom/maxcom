import { reqSurau } from '../reqSurau.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { cleanYoutubeText, youtubeMetaFor } from '@surau/core';
import type { YoutubeMeta } from '@surau/core';
import { actorOf, deviceOf } from '../actor.ts';
import { randomToken } from '../auth/crypto.ts';
import { logChange } from '../auth/users.ts';
import { getItem } from '../content/store.ts';
import type { YoutubeService, VideoPrivacy } from '../live/youtube/api.ts';
import { YoutubeError } from '../live/youtube/oauth.ts';
import { getSettings } from '../settingsStore.ts';
import { YOUTUBE_AT_BOX_MSG } from './youtubeBoxCloud.ts';

/**
 * YouTube on the cloud (Plan 6, Task 5). The cloud owns the sealed Google token. Two groups of routes:
 *
 *  - for the linked box (site identity): `POST /api/cloud/youtube/broadcast`, `POST /api/cloud/youtube/complete`,
 *    `GET /api/cloud/youtube/status`. The stream key crosses one TLS hop to the box and is held in its live
 *    session's memory only (as in Plan 5); it is never written here.
 *  - for a signed-in device with `live:control` (the catch-up upload): `POST /api/youtube/upload/begin`,
 *    `POST /api/youtube/upload/done`, `GET /api/youtube/quota`. `begin` opens a Google resumable session and hands
 *    the session address to that one device; the device PUTs the bytes straight to Google. No Google token ever
 *    leaves the cloud and the session address is never stored, logged or put in `change_log`.
 *
 * Every route has a row in `ROUTE_PERMISSIONS`. A device session on a site route (and the reverse) gets 404 / 403.
 *
 * Release 2026.11.13: the grant is held by the surau's BOX. The catch-up routes (`begin`, `done`, `quota`, `verify`)
 * now answer on the box too, from its own grant (at the surau). On the cloud they keep serving a surau whose grant the
 * cloud still holds from before (an old app, until its box takes the grant over); for any other surau they answer 409
 * `youtube_at_box`. The three box-leg routes stay for a box that has not updated yet.
 */

export interface YoutubeCloudDeps {
  /** The box-leg routes exist on both roles (the route table is one), but answer 404 on a box. */
  role: 'box' | 'cloud';
  db: DatabaseSync;
  now: () => Date;
  /** The cloud's YouTube service; null when the cloud has no data folder (unit tests). */
  youtube: YoutubeService | null;
  /** One service per surau (L1): the cloud keeps one Google sign-in for each. When absent `youtube` serves every request. */
  youtubeFor?: (surauId: string) => YoutubeService | null;
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
const DESCRIPTION_MAX = 5000;
const MAX_UPLOAD_BYTES = 256 * 1024 ** 3;
const MAX_PARTS = 50;
const VERIFY_MAX_IDS = 20;
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const PRIVACIES: ReadonlySet<string> = new Set<VideoPrivacy>(['private', 'unlisted', 'public']);

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

// ---- routes -----------------------------------------------------------------------------------------------

export function registerYoutubeCloudRoutes(
  app: FastifyInstance,
  deps: YoutubeCloudDeps,
): void {
  const { db, now } = deps;
  const ytFor = (surauId: string): YoutubeService | null => (deps.youtubeFor !== undefined ? deps.youtubeFor(surauId) : deps.youtube);

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

  // ---- the box leg -------------------------------------------------------------------------------------

  app.post('/api/cloud/youtube/broadcast', gate, async (request, reply) => {
    const surauId = reqSurau(request);
    const site = siteOnly(request, reply);
    if (site === null) return reply;
    const b = body(request);
    const meta = b.meta;
    if (typeof b.sessionId !== 'string' || b.sessionId === '' || b.sessionId.length > 64 || !isRecord(meta)) return bad(reply);
    if (typeof meta.title !== 'string' || typeof meta.description !== 'string' || typeof meta.privacy !== 'string' || !PRIVACIES.has(meta.privacy)) return bad(reply);
    // the box composed the text; the cloud still cleans it (no angle brackets, dashes or arrows reach YouTube)
    const title = cut(cleanYoutubeText(meta.title).trim(), TITLE_MAX).trim();
    if (title === '') return bad(reply);
    const yt = ytFor(surauId);
    if (yt === null) return sendYoutubeFailure(reply, new YoutubeError('not_configured'), now);
    if (!yt.signedIn()) return sendYoutubeFailure(reply, new YoutubeError('reauthorise'), now);
    try {
      const made = await yt.createBroadcastFor({
        // scoped by site: another site that sends the same session id never reaches this site's broadcast
        sessionId: `${site.boxId}/${b.sessionId}`,
        meta: { title, description: cut(cleanYoutubeText(meta.description), DESCRIPTION_MAX), privacy: meta.privacy as VideoPrivacy },
      });
      // ids only: the stream key is in the answer and nowhere else
      logChange(db, `site:${site.boxId}`, 'youtube/broadcast', made.broadcastId, null, { sessionId: b.sessionId, broadcastId: made.broadcastId }, undefined, surauId);
      return reply.header('Cache-Control', 'no-store').send({ broadcastId: made.broadcastId, watchUrl: made.watchUrl, key: made.key });
    } catch (error) {
      return sendYoutubeFailure(reply, error, now);
    }
  });

  app.post('/api/cloud/youtube/complete', gate, async (request, reply) => {
    const surauId = reqSurau(request);
    const site = siteOnly(request, reply);
    if (site === null) return reply;
    const id = body(request).broadcastId;
    if (typeof id !== 'string' || id === '' || id.length > 64) return bad(reply);
    // only a broadcast this cloud made for this very site: no site can end another's (or a person's own) live
    if (db.prepare("SELECT 1 AS x FROM change_log WHERE surau_id = ? AND entity = 'youtube/broadcast' AND entity_id = ? AND actor = ?").get(surauId, id, `site:${site.boxId}`) === undefined) return notFound(reply);
    const yt = ytFor(surauId);
    if (yt === null) return sendYoutubeFailure(reply, new YoutubeError('not_configured'), now);
    try {
      await yt.complete(id);
      return reply.header('Cache-Control', 'no-store').send({ completed: true });
    } catch (error) {
      return sendYoutubeFailure(reply, error, now);
    }
  });

  app.get('/api/cloud/youtube/status', gate, async (request, reply) => {
    const surauId = reqSurau(request);
    const site = siteOnly(request, reply);
    if (site === null) return reply;
    const yt = ytFor(surauId);
    reply.header('Cache-Control', 'no-store');
    // the box asking is the sign that its live is still going (the orphan sweep leaves it alone)
    yt?.touch(`${site.boxId}/`);
    return (
      yt?.status() ?? { signedIn: false, channelTitle: null, broadcastId: null, state: 'none', health: null, watchUrl: null, lastError: 'not_configured' }
    );
  });

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
    db.prepare("UPDATE uploads SET state = 'expired' WHERE surau_id = ? AND state = 'open' AND created_at < ?").run(surauId, new Date(t0.getTime() - UPLOAD_OPEN_MS).toISOString());
    // the channel's daily upload limit, before Google is asked (the same count the quota route shows)
    const win = pacificWindow(t0);
    if (Number(db.prepare('SELECT COUNT(*) AS n FROM uploads WHERE surau_id = ? AND created_at >= ?').get(surauId, win.since)?.n ?? 0) >= UPLOAD_LIMIT_PER_DAY) {
      return sendYoutubeFailure(reply, new YoutubeError('quota'), now);
    }
    if (Number(db.prepare("SELECT COUNT(*) AS n FROM uploads WHERE surau_id = ? AND device_id = ? AND state = 'open'").get(surauId, deviceId)?.n ?? 0) >= OPEN_UPLOADS_PER_DEVICE) {
      return reply.code(409).send({ errors: [MSG.tooManyUploads], code: 'too_many_uploads' });
    }
    if (!yt.signedIn()) return sendYoutubeFailure(reply, new YoutubeError('reauthorise'), now);

    const title = titleWithPart(meta.title, part);
    try {
      const session = await yt.createResumableUpload({ ...meta, title }, getSettings(db, surauId).liveYoutube.privacy, bytes);
      const uploadId = `up_${randomToken(12)}`;
      db.prepare(
        `INSERT INTO uploads (surau_id, id, kuliah_id, device_id, state, bytes, created_at, replace_video_id) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
      ).run(surauId, uploadId, kuliahId as string | null, deviceId, bytes, now().toISOString(), replace);
      // the history knows who and how much, never the session address
      logChange(db, actorOf(request), 'youtube/upload', uploadId, null, { uploadId, kuliahId: kuliahId as string | null, deviceId, bytes }, { deviceId }, surauId);
      return reply.send({ uploadId, uploadUri: session.uploadUri, expiresAt: session.expiresAt, title });
    } catch (error) {
      return sendYoutubeFailure(reply, error, now);
    }
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
    if (row.state === 'open') {
      // the id is the device's word: it must be a video this very upload made, on this channel, after `begin`
      if (db.prepare('SELECT 1 AS x FROM uploads WHERE surau_id = ? AND video_id = ? AND id <> ?').get(surauId, b.videoId, b.uploadId) !== undefined) return bad(reply, 'unknown_video');
      const yt = ytFor(surauId);
      if (yt === null) return noService(reply);
      try {
        const o = await yt.videoOrigin(b.videoId);
        const began = Date.parse(String(row.created_at));
        const published = o?.publishedAt == null ? Number.NaN : Date.parse(o.publishedAt);
        const sameChannel = o?.ownChannelId == null || o.channelId === o.ownChannelId;
        if (o === null || !sameChannel || !(published >= began - PUBLISH_SKEW_MS)) return bad(reply, 'unknown_video');
      } catch (error) {
        return sendYoutubeFailure(reply, error, now);
      }
      db.prepare("UPDATE uploads SET state = 'done', video_id = ?, finished_at = ? WHERE surau_id = ? AND id = ? AND state = 'open'").run(b.videoId, now().toISOString(), surauId, b.uploadId);
    }

    // set the gappy live private, once. The claim marker keeps a repeated or concurrent `done` from doing it twice.
    let replaced = false;
    const live = typeof row.replace_video_id === 'string' ? row.replace_video_id : null;
    if (live !== null) {
      // a claim left by a crashed `done` (older than 10 minutes, or the bare old marker) is taken over
      db.prepare("UPDATE uploads SET replaced_at = NULL WHERE surau_id = ? AND id = ? AND (replaced_at = 'claim' OR (replaced_at LIKE 'claim@%' AND substr(replaced_at, 7) < ?))").run(
        surauId,
        b.uploadId,
        new Date(now().getTime() - CLAIM_STALE_MS).toISOString(),
      );
      const claim = db.prepare('UPDATE uploads SET replaced_at = ? WHERE surau_id = ? AND id = ? AND replaced_at IS NULL').run(`claim@${now().toISOString()}`, surauId, b.uploadId);
      if (Number(claim.changes) === 1) {
        try {
          const yt = ytFor(surauId);
          if (yt === null) throw new YoutubeError('not_configured');
          await yt.setPrivacy(live, 'private');
          db.prepare('UPDATE uploads SET replaced_at = ? WHERE surau_id = ? AND id = ?').run(now().toISOString(), surauId, b.uploadId);
          logChange(db, actorOf(request), 'youtube/replaceLive', live, null, { uploadId: b.uploadId, videoId: live, newVideoId: b.videoId }, { deviceId }, surauId);
          replaced = true;
        } catch {
          // the upload itself is done and must not be uploaded again: the next `done` retries this step
          db.prepare("UPDATE uploads SET replaced_at = NULL WHERE surau_id = ? AND id = ? AND replaced_at LIKE 'claim%'").run(surauId, b.uploadId);
        }
      } else {
        const now2 = db.prepare('SELECT replaced_at FROM uploads WHERE surau_id = ? AND id = ?').get(surauId, b.uploadId);
        replaced = typeof now2?.replaced_at === 'string' && !now2.replaced_at.startsWith('claim');
      }
    }
    return reply.send({ uploadId: b.uploadId, state: 'done', videoId: b.videoId, replaced });
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
    // on the cloud only a video this surau logged (a live its sites broadcast, an upload of its devices) may be
    // asked about: one surau cannot learn the state of another's videos
    if (deps.role === 'cloud') {
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