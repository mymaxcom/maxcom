/**
 * HTTP routes of the box's own YouTube side that are new in 2026.11.15 (Siaran langsung revamp). `app.ts` calls
 * `registerYoutubeRoutes` once (shapes in docs/design/plans/2026-11-22-live-revamp-route-shapes.md).
 *
 * - `POST /api/youtube/upload/abandon` `{ uploadId }` (live:control, a device session): U4.
 * - `GET /api/youtube/open-broadcast` (the linked-boxes question, Y11): answers `{ open: YoutubeOpenBroadcast | null }`.
 *
 * Every route here needs its row in ROUTE_PERMISSIONS (auth/authz.ts); without the row the route is refused as
 * unlisted. The rows this file needs:
 *   { method: 'POST', pattern: /^\/api\/youtube\/upload\/abandon$/, permission: 'live:control', sample: '/api/youtube/upload/abandon', tenant: 'required' }
 *   { method: 'GET', pattern: /^\/api\/youtube\/open-broadcast$/, permission: 'kiosk:read', sample: '/api/youtube/open-broadcast', tenant: 'required' }
 *
 * YouTube is PER BOX: each box holds its own sign-in, channel and destination memory. Nothing registered here
 * answers for another box's channel, and nothing here returns a key, a token or an upload address.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { YoutubeOpenBroadcast } from '@surau/core';
import { actorOf, deviceOf } from '../../actor.ts';
import { logChange } from '../../auth/users.ts';
import { reqSurau } from '../../reqSurau.ts';
import type { LiveSessionStore } from '../sessionStore.ts';
import type { YoutubeService } from './api.ts';

/** What `app.ts` hands over. All optional so a test can register the routes with only what it exercises. */
export interface YoutubeRouteDeps {
  role?: 'box' | 'cloud';
  db?: DatabaseSync;
  now?: () => Date;
  /** This box's id (the `boxId` of `YoutubeOpenBroadcast` and of `LiveSessionRecord`). */
  boxId?: string;
  /** This box's own YouTube service; null when the box has none (a follower, or no data directory). */
  youtube?: YoutubeService | null;
  /** The persisted live sessions; null until the box live core lane supplies the store. */
  sessionStore?: LiveSessionStore | null;
}

const send = (reply: FastifyReply, status: number, body: Record<string, unknown>): FastifyReply => reply.code(status).header('Cache-Control', 'no-store').send(body);

export function registerYoutubeRoutes(app: FastifyInstance, deps: YoutubeRouteDeps): void {
  const now = deps.now ?? ((): Date => new Date());
  const db = deps.db;

  /**
   * U4: the caller gives up its own open upload, so it stops counting against the open-upload cap (and, with a
   * session id, another device may upload that live). Another device's upload does not exist for this one. An
   * upload already done, expired or abandoned is left as it is. Nothing is asked of Google: the session address
   * was never kept here, and an unused one dies at Google by itself.
   */
  if (db !== undefined) {
    app.post('/api/youtube/upload/abandon', async (request, reply) => {
      const surauId = reqSurau(request);
      const deviceId = deviceOf(request) ?? null;
      if (deviceId === null) return send(reply, 403, { errors: ['Tidak dibenarkan'] });
      const b = request.body;
      const uploadId = typeof b === 'object' && b !== null && !Array.isArray(b) ? (b as Record<string, unknown>).uploadId : undefined;
      if (typeof uploadId !== 'string' || uploadId === '' || uploadId.length > 64) return send(reply, 400, { errors: ['Permintaan tidak sah'], code: 'invalid' });
      const row = db.prepare('SELECT device_id, state FROM uploads WHERE surau_id = ? AND id = ?').get(surauId, uploadId);
      if (row === undefined || row.device_id !== deviceId) return send(reply, 404, { errors: ['Muat naik tidak ditemui'], code: 'upload_not_found' });
      const done = db.prepare("UPDATE uploads SET state = 'abandoned', finished_at = ? WHERE surau_id = ? AND id = ? AND device_id = ? AND state = 'open'").run(now().toISOString(), surauId, uploadId, deviceId);
      const abandoned = Number(done.changes) === 1;
      if (abandoned) logChange(db, actorOf(request), 'youtube/uploadAbandoned', uploadId, null, { uploadId, deviceId }, { deviceId }, surauId);
      return send(reply, 200, { abandoned });
    });
  }

  /**
   * Y11: a linked box that is about to create a broadcast asks this one whether it has one open. The answer is the
   * box id, the channel id of THIS box's sign-in and the broadcast id (all public on the watch page), or null. The
   * asking box decides with `youtubeBusyOnPeer`: only the SAME channel id blocks. The cloud has no box channel: 404.
   * DORMANT (23 Nov 2026): nothing calls this route; see the Y11 note at the top of `api.ts`. Its permission row is
   * `kiosk:read`, so a paired TV can read the channel id and an open (also unlisted) broadcast id: review the row
   * before this route is ever put to use.
   */
  app.get('/api/youtube/open-broadcast', async (_request, reply) => {
    if (deps.role === 'cloud') return send(reply, 404, { errors: ['not found'] });
    const yt = deps.youtube ?? null;
    let found: { channelId: string | null; broadcastId: string } | null = null;
    try {
      found = yt?.openBroadcast() ?? null;
    } catch {
      found = null;
    }
    const open: YoutubeOpenBroadcast | null = found === null ? null : { boxId: deps.boxId ?? '', channelId: found.channelId, broadcastId: found.broadcastId };
    return send(reply, 200, { open });
  });
}
