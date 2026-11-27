import { isIP } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { actorOf } from '../actor.ts';
import { identityCan } from '../auth/authz.ts';
import type { AuthIdentity } from '../auth/authz.ts';
import { tvIdOf } from '../kioskTv.ts';
import { reqSurau } from '../reqSurau.ts';
import { SettingsError } from '../settingsStore.ts';
import { LIVE_MSG, LiveError, parseStartRequest } from './sessions.ts';
import type { LiveSessions } from './sessions.ts';
import { MAX_SDP_BYTES, sendLiveError } from './webrtcProxy.ts';
import type { WebrtcProxy } from './webrtcProxy.ts';
import type { YoutubeAccountView, YoutubeSignInState } from '@surau/core';
import type { YoutubeService } from './youtube/api.ts';
import { YoutubeError, youtubeErrorCode, youtubeErrorStatus, youtubeErrorText } from './youtube/oauth.ts';
import type { YoutubeReason } from './youtube/oauth.ts';
import { YOUTUBE_AT_BOX_MSG, readYoutubeFlag } from '../sync/youtubeBoxCloud.ts';

export interface LiveRouteDeps {
  sessions: LiveSessions;
  proxy: WebrtcProxy;
  /** LAN IP literals of the box (the certificate's IP SANs); the SRT host handed to a publisher. */
  lanIps: string[];
  /** The box's YouTube service; null when the box has no data folder (unit tests) or the leg was injected as a bare seam. */
  youtube?: YoutubeService | null;
  /** Called once after a YouTube sign-out succeeded (the link backup drops its copy of the token); errors are swallowed. */
  onYoutubeSignedOut?: () => void;
  /**
   * The cloud. Release 2026.11.13: the grant is held by the surau's box, so the cloud refuses every sign-in and
   * sign-out (`youtube_at_box`) and answers the status from the box's non-secret flag (or from a grant it still holds
   * from before, until the box takes it over).
   */
  cloud?: boolean;
  /** Announces the settings version of the surau after a write (the box passes its change bus); the route calls it only when something was written. */
  announceSettings?: (surauId: string) => void;
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

/**
 * The pending YouTube sign-in as a caller may see it. The code that signs the box in to a Google account is for callers
 * who may change the live settings; a caller with live:control only learns that a sign-in is waiting (it could
 * otherwise finish it with its own Google account).
 */
export function signInForCaller(auth: AuthIdentity | null, signIn: YoutubeSignInState | null | undefined): YoutubeSignInState | { state: 'pending' } | null {
  if (signIn == null) return null;
  if (signIn.state !== 'pending' || identityCan(auth, 'live:settings')) return signIn;
  return { state: 'pending' };
}

/**
 * The sign-in as the cloud can tell it from the box's non-secret flag. No flag at all is "not known" (the box has not
 * said), never "signed out"; a revoked flag is signed out for a real reason.
 */
function accountOfFlag(flag: ReturnType<typeof readYoutubeFlag>): YoutubeAccountView {
  if (flag === null) return { state: 'unknown', reason: 'handover_pending', lastGood: null, revokedAt: null };
  if (flag.signedIn) return { state: 'signedIn', reason: null, lastGood: { signedIn: true, channelTitle: flag.channelTitle, at: flag.updatedAt }, revokedAt: null };
  if (flag.revoked) return { state: 'signedOut', reason: 'reauthorise', lastGood: null, revokedAt: flag.updatedAt };
  return { state: 'signedOut', reason: 'signed_out', lastGood: null, revokedAt: null };
}

/** Routes of the live feature; every one has a row in ROUTE_PERMISSIONS (auth/authz.ts). */
export function registerLiveRoutes(app: FastifyInstance, deps: LiveRouteDeps): void {
  const { sessions, proxy } = deps;

  // WHIP and WHEP bodies are SDP text: parsed as a string under the same 64 KB cap as the route.
  app.addContentTypeParser('application/sdp', { parseAs: 'string', bodyLimit: MAX_SDP_BYTES }, (_request, body, done) => {
    done(null, body);
  });

  const ytFor = (_request: FastifyRequest): YoutubeService | null =>
    deps.youtube ?? null;

  const signInFor = (request: FastifyRequest, signIn: YoutubeSignInState | null | undefined) => signInForCaller(request.auth ?? null, signIn);

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

  /** Stop and the output switches share one rule: the starter, a settings:write holder, or (box-pulled live) any live:control holder. */
  const mayStopLive = (request: FastifyRequest, current: NonNullable<ReturnType<LiveSessions['current']>>, deviceId: string): boolean =>
    current.deviceId === deviceId || identityCan(request.auth, 'settings:write') || (current.boxPulled && identityCan(request.auth, 'live:control'));

  // S3: Skrin (and the Merakam flag) during the live; the same callers as Stop
  app.post('/api/live/outputs', async (request, reply) => {
    try {
      const { deviceId } = userOf(request);
      const b = request.body;
      if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new LiveError(400, 'bad_request', LIVE_MSG.badRequest);
      const { sessionId, kiosk, recording } = b as Record<string, unknown>;
      if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 64 || typeof kiosk !== 'boolean') throw new LiveError(400, 'bad_request', LIVE_MSG.badRequest);
      if (recording !== undefined && typeof recording !== 'boolean') throw new LiveError(400, 'bad_request', LIVE_MSG.badRequest);
      const current = sessions.current();
      if (current === null || current.id !== sessionId) throw new LiveError(409, 'no_session', LIVE_MSG.noSession);
      if (!mayStopLive(request, current, deviceId)) throw new LiveError(403, 'not_owner', LIVE_MSG.forbidden);
      const status = sessions.setOutputs({ sessionId, kiosk, ...(recording !== undefined ? { recording } : {}) }, actorOf(request), deviceId);
      return reply.header('Cache-Control', 'no-store').send(status);
    } catch (error) {
      return sendLiveError(reply, error);
    }
  });

  // Build 5: the per-TV switch "Paparkan siaran langsung" (Siaran langsung, Tetapan siaran). The Siaran Langsung role holds
  // live:settings but not settings:write, so it cannot write `tvProfiles` through the settings route; this route writes only
  // `live.show` of one TV and keeps the rest of that TV's entry.
  app.put('/api/live/tv-show', async (request, reply) => {
    // the cloud holds no live and no TV of a box
    if (deps.cloud === true) return reply.code(404).header('Cache-Control', 'no-store').send({ errors: [LIVE_MSG.unknownTv], code: 'unknown_tv' });
    try {
      const b = request.body;
      if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new LiveError(400, 'bad_request', LIVE_MSG.badRequest);
      const { tvId, show } = b as Record<string, unknown>;
      const a = request.auth;
      const r = sessions.setTvShow(tvId, show, actorOf(request), a != null && a.kind === 'user' ? a.deviceId : undefined);
      if (r.changed) deps.announceSettings?.(reqSurau(request));
      return reply.header('Cache-Control', 'no-store').send({ tvId: r.tvId, show: r.show });
    } catch (error) {
      // the settings rule of the TV cap (16) or any other refusal of the store, as the editor would show it
      if (error instanceof SettingsError) return reply.code(400).header('Cache-Control', 'no-store').send({ errors: error.errors, code: 'bad_request' });
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
      // the starting device ends its own session; an administrator may clear a stuck one; any holder of live:control may
      // stop a live the box pulls (it has no automatic end, so nobody may be left unable to end it)
      if (!mayStopLive(request, current, deviceId)) throw new LiveError(403, 'not_owner', LIVE_MSG.forbidden);
      // the answer does not wait for ffmpeg, MediaMTX and YouTube clean-up; a new start does
      const result = await sessions.stop(current.id, actorOf(request), 'stopped', { background: true, emergency: current.deviceId !== deviceId });
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

  // a device's status poll is its heartbeat: the starting device's keeps a device-sourced live from being an orphan, and only the starting device's clears the quiet notice
  app.get('/api/live/status', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const a = request.auth;
    if (a != null && a.kind === 'user') sessions.heartbeat(a.deviceId);
    // additive: whether this box can "Kod semula" (H.264 encoder present); unknown or a failed probe is false
    // `mine` and the camera flag are computed for the asking device; its id is never in the answer
    const base = sessions.status(a != null && a.kind === 'user' ? a.deviceId : null);
    let youtube = base.youtube;
    // on the cloud the sign-in fields are the asking surau's own: its old cloud grant while it still has one, else
    // the flag its box pushed. Nothing can be signed in here (`signInHere` false): the app says "at the surau".
    if (deps.cloud === true) {
      const own = ytFor(request)?.status();
      if (own !== undefined) youtube = { ...youtube, signedIn: own.signedIn, channelTitle: own.channelTitle, lastError: own.lastError, signIn: null, ...(own.account !== undefined ? { account: own.account } : {}) };
      else {
        const flag = readYoutubeFlag(request.server.surau.db, reqSurau(request));
        youtube = { ...youtube, signedIn: flag?.signedIn ?? false, channelTitle: flag?.channelTitle ?? null, lastError: flag?.revoked === true ? 'reauthorise' : null, signIn: null, account: accountOfFlag(flag) };
      }
      youtube = { ...youtube, signInHere: false };
    }
    const noticeRev = sessions.noticeRev();
    return { ...base, youtube: { ...youtube, signIn: signInFor(request, youtube.signIn) }, relayReencode: sessions.relayReencodeCapable(), ...(noticeRev !== undefined ? { noticeRev } : {}) };
  });

  // S3: the last lives of this box (at most 10), for the "resume" and "upload the recording" offers of any phone.
  // No secret and no device id: `mine` says whether the asking device started the live.
  app.get('/api/live/sessions/recent', async (request, reply) => {
    const a = request.auth;
    const list = sessions.recentSessions(reqSurau(request), a != null && a.kind === 'user' ? a.deviceId : null);
    return reply.header('Cache-Control', 'no-store').send({ sessions: list });
  });

  // volume = a run-time command, adding or removing a source = a combiner restart; the starting device only
  app.post('/api/live/audio', async (request, reply) => {
    try {
      const { deviceId } = userOf(request);
      const status = await sessions.changeAudio(deviceId, request.body);
      return reply.header('Cache-Control', 'no-store').send(status);
    } catch (error) {
      return sendLiveError(reply, error);
    }
  });

  // The surau-level live notice (one per YouTube live, shared by every live:control holder; the app builds the text).
  const noticeName = (request: FastifyRequest): string => {
    const a = request.auth;
    if (a == null || a.kind !== 'user') return '';
    const r = request.server.surau.db.prepare('SELECT name FROM users WHERE id = ?').get(a.userId) as { name?: unknown } | undefined;
    return typeof r?.name === 'string' ? r.name.slice(0, 80) : '';
  };
  app.get('/api/live/notice', async (_request, reply) => reply.header('Cache-Control', 'no-store').send(sessions.noticeView()));
  app.patch('/api/live/notice', async (request, reply) => {
    try {
      const b = request.body;
      if (typeof b !== 'object' || b === null || !('editedText' in b)) throw new LiveError(400, 'bad_notice', LIVE_MSG.badNotice);
      return reply.header('Cache-Control', 'no-store').send(sessions.editNotice((b as { editedText: unknown }).editedText, noticeName(request)));
    } catch (error) {
      return sendLiveError(reply, error);
    }
  });
  app.get('/api/live/notice/frame.jpg', async (request, reply) => {
    void request;
    const jpeg = await sessions.noticeFrame();
    if (jpeg === null) return reply.code(404).header('Cache-Control', 'no-store').send({ errors: [LIVE_MSG.noNotice], code: 'no_frame' });
    return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'private, max-age=30').send(jpeg);
  });

  app.get('/api/kiosk/live', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return sessions.kioskLive(tvIdOf(request.auth));
  });

  // YouTube sign-in (device code). Only the user code and the Google address ever reach a client:
  // the device code, the tokens and the OAuth client stay on the box.
  const youtubeFailure = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof LiveError) return sendLiveError(reply, error);
    const reason: YoutubeReason = error instanceof YoutubeError ? error.reason : 'network';
    // the sentences of the older reasons; Y9, Y11: the newer ones carry their own (`youtubeErrorText`). Status and
    // code come from the YouTube lane's one table, so a refusal reads the same on every route.
    const older: Partial<Record<YoutubeReason, string>> = {
      not_configured: 'YouTube belum disediakan di kotak',
      reauthorise: 'Log masuk YouTube perlu dibuat semula',
      quota: 'Had penggunaan YouTube dicapai',
      forbidden: 'YouTube menolak permintaan ini',
    };
    const message = youtubeErrorText(reason) ?? older[reason];
    // a reason without a sentence of its own stays the generic 502, as before
    if (message === undefined) return reply.code(502).header('Cache-Control', 'no-store').send({ errors: ['Tidak dapat menghubungi YouTube'], code: youtubeErrorCode(reason) });
    return reply.code(youtubeErrorStatus(reason)).header('Cache-Control', 'no-store').send({ errors: [message], code: youtubeErrorCode(reason) });
  };

  /** Old apps show the server's sentence as it is: it says where the sign-in is made now. */
  const atBox = (reply: FastifyReply): FastifyReply =>
    reply.code(409).header('Cache-Control', 'no-store').send({ errors: [YOUTUBE_AT_BOX_MSG], code: 'youtube_at_box' });

  // O34: YouTube turned on for a running live that started without it (the box makes the broadcast and, for a box
  // leg, the relay; the mixer and the TV leg are not restarted). Every refusal is a code.
  app.post('/api/live/youtube/start', async (request, reply) => {
    // the live runs on the surau's box: the cloud holds no session and no grant any more
    if (deps.cloud === true) return atBox(reply);
    try {
      const { deviceId } = userOf(request);
      const b = request.body;
      if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new LiveError(400, 'bad_request', LIVE_MSG.badRequest);
      const { sessionId, title, privacy } = b as Record<string, unknown>;
      if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 64) throw new LiveError(400, 'bad_request', LIVE_MSG.badRequest);
      if ((title !== undefined && title !== null && (typeof title !== 'string' || title.length > 300)) || (privacy !== undefined && privacy !== null && typeof privacy !== 'string')) {
        throw new LiveError(400, 'bad_request', LIVE_MSG.badRequest);
      }
      const out = await sessions.startYoutube(
        { sessionId, ...(typeof title === 'string' ? { title } : {}), ...(typeof privacy === 'string' ? { privacy } : {}) },
        { deviceId, admin: identityCan(request.auth, 'settings:write') },
      );
      // I2/F3: the answer is the live status (what the phone parses and applies) plus the leg block in `youtube`
      // (`via`, `ingest`, `key` for the owner, `legState`); the status fields are never missing from it
      const base = sessions.status(deviceId);
      const noticeRev = sessions.noticeRev();
      return reply.header('Cache-Control', 'no-store').send({
        ...base,
        session: out.session,
        youtube: { ...base.youtube, signIn: signInFor(request, base.youtube.signIn), via: out.youtube.via, ingest: out.youtube.ingest, key: out.youtube.key, legState: out.youtube.legState },
        relayReencode: sessions.relayReencodeCapable(),
        ...(noticeRev !== undefined ? { noticeRev } : {}),
      });
    } catch (error) {
      return sendLiveError(reply, error);
    }
  });

  app.get('/api/live/youtube/status', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const yt = ytFor(request);
    if (deps.cloud === true) {
      // never the pending code (no sign-in runs here) and never more than the flag carries
      if (yt !== null) {
        const i = yt.info();
        return { configured: i.configured, signedIn: i.signedIn, channelTitle: i.channelTitle, lastError: i.lastError, state: i.state, reason: i.reason, lastGood: i.lastGood, revokedAt: i.revokedAt, heldBy: 'cloud', signInHere: false };
      }
      const flag = readYoutubeFlag(request.server.surau.db, reqSurau(request));
      return {
        configured: true,
        signedIn: flag?.signedIn ?? false,
        channelTitle: flag?.channelTitle ?? null,
        lastError: flag?.revoked === true ? 'reauthorise' : null,
        ...accountOfFlag(flag),
        heldBy: 'box',
        signInHere: false,
        updatedAt: flag?.updatedAt ?? null,
      };
    }
    if (yt !== null) {
      // the pending code only reaches a caller who may change the live settings
      const { signIn, ...info } = yt.info();
      const shown = signInFor(request, signIn);
      return { ...info, ...(shown !== null ? { signIn: shown } : {}), heldBy: 'box', signInHere: true };
    }
    const s = sessions.status().youtube;
    const shown = signInFor(request, s.signIn);
    return { configured: false, signedIn: s.signedIn, channelTitle: s.channelTitle, lastError: s.lastError, ...(shown !== null ? { signIn: shown } : {}) };
  });
  app.post('/api/live/youtube/signin', async (request, reply) => {
    // no new grant is ever made on the cloud
    if (deps.cloud === true) return atBox(reply);
    try {
      const yt = ytFor(request);
      if (yt === null) throw new YoutubeError('not_configured');
      const out = await yt.begin(actorOf(request));
      return reply.header('Cache-Control', 'no-store').send(out);
    } catch (error) {
      return youtubeFailure(reply, error);
    }
  });
  app.post('/api/live/youtube/signin/poll', async (request, reply) => {
    if (deps.cloud === true) return atBox(reply);
    try {
      const yt = ytFor(request);
      if (yt === null) throw new YoutubeError('not_configured');
      const out = await yt.poll(actorOf(request), reqSurau(request));
      return reply.header('Cache-Control', 'no-store').send(out);
    } catch (error) {
      return youtubeFailure(reply, error);
    }
  });
  app.post('/api/live/youtube/signout', async (request, reply) => {
    // a sign-out on the cloud would revoke the grant at Google, and with it the box's copy: at the surau only
    if (deps.cloud === true) return atBox(reply);
    try {
      const yt = ytFor(request);
      if (yt === null) throw new YoutubeError('not_configured');
      // signing out mid-live would orphan the broadcast: refused until the live is stopped
      if (sessions.current() !== null) throw new LiveError(409, 'live_busy', LIVE_MSG.ytSignoutBusy);
      // Y6: a live that just ended keeps its broadcast open for a restart; a sign-out now would leave it open on the channel
      if (sessions.lingeringBroadcast() !== null) throw new LiveError(409, 'live_busy', LIVE_MSG.ytSignoutLinger);
      await yt.signout(actorOf(request), reqSurau(request));
      try {
        deps.onYoutubeSignedOut?.();
      } catch {
        /* a sign-out never fails because of what listens to it */
      }
      return reply.header('Cache-Control', 'no-store').send({ signedIn: false });
    } catch (error) {
      return youtubeFailure(reply, error);
    }
  });

  app.post('/api/live/whip', { bodyLimit: MAX_SDP_BYTES }, (request, reply) => proxy.whipPost(request, reply));
  app.delete('/api/live/whip/:id', (request, reply) => proxy.whipDelete(request, reply));
  // the starting device's preview of the combined stream (muted on the device)
  app.post('/api/live/preview/whep', { bodyLimit: MAX_SDP_BYTES }, (request, reply) => proxy.previewPost(request, reply));
  app.delete('/api/live/preview/whep/:id', (request, reply) => proxy.previewDelete(request, reply));
  app.post('/api/kiosk/live/whep', { bodyLimit: MAX_SDP_BYTES }, (request, reply) => proxy.whepPost(request, reply));
  app.delete('/api/kiosk/live/whep/:id', (request, reply) => proxy.whepDelete(request, reply));
  // K1: the TV page says every few minutes that its viewer still plays, so the box keeps listing it
  app.post('/api/kiosk/live/whep/:id/alive', (request, reply) => proxy.whepAlive(request, reply));
}
