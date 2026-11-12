import { isIP } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { actorOf } from '../actor.ts';
import { identityCan } from '../auth/authz.ts';
import { LIVE_MSG, LiveError, parseStartRequest } from './sessions.ts';
import type { LiveSessions } from './sessions.ts';
import { MAX_SDP_BYTES, sendLiveError } from './webrtcProxy.ts';
import type { WebrtcProxy } from './webrtcProxy.ts';
import type { YoutubeService } from './youtube/api.ts';
import { YoutubeError } from './youtube/oauth.ts';

export interface LiveRouteDeps {
  sessions: LiveSessions;
  proxy: WebrtcProxy;
  /** LAN IP literals of the box (the certificate's IP SANs); the SRT host handed to a publisher. */
  lanIps: string[];
  /** The box's YouTube service; null when the box has no data folder (unit tests) or the leg was injected as a bare seam. */
  youtube?: YoutubeService | null;
}

/** Hostname the caller used to reach the box (fallback for the SRT host when no LAN IP is known). */
function hostFromHeader(request: FastifyRequest): string {
  const h = String(request.headers.host ?? '').trim();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  const colon = h.lastIndexOf(':');
  return colon < 0 ? h : h.slice(0, colon);
}

function lanHostFor(deps: LiveRouteDeps, request: FastifyRequest): string {
  const v4 = deps.lanIps.find((ip) => isIP(ip) === 4 && !ip.startsWith('127.'));
  return v4 ?? deps.lanIps[0] ?? hostFromHeader(request);
}

/** Routes of the live feature; every one has a row in ROUTE_PERMISSIONS (auth/authz.ts). */
export function registerLiveRoutes(app: FastifyInstance, deps: LiveRouteDeps): void {
  const { sessions, proxy } = deps;

  // WHIP and WHEP bodies are SDP text: parsed as a string under the same 64 KB cap as the route.
  app.addContentTypeParser('application/sdp', { parseAs: 'string', bodyLimit: MAX_SDP_BYTES }, (_request, body, done) => {
    done(null, body);
  });

  const userOf = (request: FastifyRequest): { deviceId: string } => {
    const a = request.auth;
    if (a == null || a.kind !== 'user') throw new LiveError(403, 'not_owner', LIVE_MSG.forbidden);
    return { deviceId: a.deviceId };
  };

  app.post('/api/live/start', async (request, reply) => {
    try {
      const req = parseStartRequest(request.body);
      const { deviceId } = userOf(request);
      const result = await sessions.start(req, actorOf(request), deviceId, lanHostFor(deps, request));
      return reply.header('Cache-Control', 'no-store').send(result);
    } catch (error) {
      return sendLiveError(reply, error);
    }
  });

  app.post('/api/live/stop', async (request, reply) => {
    try {
      const { deviceId } = userOf(request);
      const body = request.body;
      const id = typeof body === 'object' && body !== null && typeof (body as { sessionId?: unknown }).sessionId === 'string' ? (body as { sessionId: string }).sessionId : undefined;
      const current = sessions.current();
      if (current === null || (id !== undefined && id !== current.id)) return reply.header('Cache-Control', 'no-store').send({ stopped: false });
      // the starting device ends its own session; an administrator may clear a stuck one
      if (current.deviceId !== deviceId && !identityCan(request.auth, 'settings:write')) {
        throw new LiveError(403, 'not_owner', LIVE_MSG.forbidden);
      }
      // the answer does not wait for ffmpeg, MediaMTX and YouTube clean-up; a new start does
      const result = await sessions.stop(current.id, actorOf(request), 'stopped', { background: true });
      return reply.header('Cache-Control', 'no-store').send(result);
    } catch (error) {
      return sendLiveError(reply, error);
    }
  });

  // the phone's own YouTube leg gets its stream key here once the broadcast exists (the start answers before that)
  app.get('/api/live/youtube/ingest', async (request, reply) => {
    try {
      const { deviceId } = userOf(request);
      return reply.header('Cache-Control', 'no-store').send(sessions.deviceYoutubeFor(deviceId));
    } catch (error) {
      return sendLiveError(reply, error);
    }
  });

  app.get('/api/live/status', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return sessions.status();
  });

  app.get('/api/kiosk/live', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return sessions.kioskLive();
  });

  // YouTube sign-in (device code). Only the user code and the Google address ever reach a client:
  // the device code, the tokens and the OAuth client stay on the box.
  const yt = deps.youtube ?? null;
  const youtubeFailure = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof LiveError) return sendLiveError(reply, error);
    const reason = error instanceof YoutubeError ? error.reason : 'network';
    const text: Record<string, [number, string]> = {
      not_configured: [409, 'YouTube belum disediakan di kotak'],
      reauthorise: [409, 'Log masuk YouTube perlu dibuat semula'],
      quota: [429, 'Had penggunaan YouTube dicapai'],
      forbidden: [403, 'YouTube menolak permintaan ini'],
    };
    const [status, message] = text[reason] ?? [502, 'Tidak dapat menghubungi YouTube'];
    return reply.code(status).header('Cache-Control', 'no-store').send({ errors: [message], code: `youtube_${reason}` });
  };

  app.get('/api/live/youtube/status', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (yt !== null) return yt.info();
    const s = sessions.status().youtube;
    return { configured: false, signedIn: s.signedIn, channelTitle: s.channelTitle, lastError: s.lastError };
  });
  app.post('/api/live/youtube/signin', async (request, reply) => {
    try {
      if (yt === null) throw new YoutubeError('not_configured');
      const out = await yt.begin(actorOf(request));
      return reply.header('Cache-Control', 'no-store').send(out);
    } catch (error) {
      return youtubeFailure(reply, error);
    }
  });
  app.post('/api/live/youtube/signin/poll', async (request, reply) => {
    try {
      if (yt === null) throw new YoutubeError('not_configured');
      const out = await yt.poll(actorOf(request));
      return reply.header('Cache-Control', 'no-store').send(out);
    } catch (error) {
      return youtubeFailure(reply, error);
    }
  });
  app.post('/api/live/youtube/signout', async (request, reply) => {
    try {
      if (yt === null) throw new YoutubeError('not_configured');
      // signing out mid-live would orphan the broadcast: refused until the live is stopped
      if (sessions.current() !== null) throw new LiveError(409, 'live_busy', LIVE_MSG.ytSignoutBusy);
      await yt.signout(actorOf(request));
      return reply.header('Cache-Control', 'no-store').send({ signedIn: false });
    } catch (error) {
      return youtubeFailure(reply, error);
    }
  });

  app.post('/api/live/whip', { bodyLimit: MAX_SDP_BYTES }, (request, reply) => proxy.whipPost(request, reply));
  app.delete('/api/live/whip/:id', (request, reply) => proxy.whipDelete(request, reply));
  app.post('/api/kiosk/live/whep', { bodyLimit: MAX_SDP_BYTES }, (request, reply) => proxy.whepPost(request, reply));
  app.delete('/api/kiosk/live/whep/:id', (request, reply) => proxy.whepDelete(request, reply));
}
