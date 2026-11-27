import http from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { tvIdOf } from '../kioskTv.ts';
import { LiveError } from './sessions.ts';
import type { LiveSessions } from './sessions.ts';
import type { LiveRuntime } from './mediamtx.ts';

/** Caps on everything that crosses the proxy. */
export const MAX_SDP_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_WHEP_SESSIONS = 8;
const MAX_PREVIEW_SESSIONS = 2;
/**
 * K1: a viewer row lives this long after its TV last said it is still watching (`POST /api/kiosk/live/whep/:id/alive`),
 * unless the row proved a fast alive (see `FAST_*` below). A TV page of an older build says so only every 5 minutes, so
 * its row keeps this 30 minute life. A TV that plays for hours keeps its row; one that vanished without a DELETE loses
 * it. The box only forgets the row: it never closes the reader at MediaMTX for a timer (MediaMTX drops a dead WebRTC
 * session by itself after about 30 seconds), so a TV whose messages were late keeps its picture.
 */
const WHEP_TTL_MS = 30 * 60 * 1000;
/** A row whose first alive comes inside this time of its creation is from a page that says alive every 30 seconds. */
const FAST_PROOF_MS = 60 * 1000;
/** A fast row lives this long after its last alive (three missed messages). */
const FAST_TTL_MS = 90 * 1000;
/** The count check asks the media server at most this often. */
const COUNT_CHECK_EVERY_MS = 10 * 1000;
/** The count check never removes a row younger than this. */
const COUNT_CHECK_MIN_AGE_MS = 45 * 1000;
/** Preview sessions remembered with their path, to subtract them from the reader count of that path (bounded). */
const MAX_PREVIEW_MEMO = 64;
/** Ids of viewer rows the box closed on purpose (deleted, evicted, closed with Skrin); an alive for one never revives it (bounded). */
const MAX_CLOSED_MEMO = 64;
/** Ids of viewers the box handed out (id -> the TV and path it was issued for); only these can be revived (bounded). */
const MAX_ISSUED = 64;
/** The count check removes a slow row (an older page, alive every 5 minutes) first once it is this long without an alive. */
const SLOW_QUIET_MS = 6 * 60 * 1000;
/** The count check removes a fast row (alive every 30 seconds) first once it is this long without an alive. */
const FAST_QUIET_MS = 45 * 1000;
/** The viewer table key of a caller that is no TV (a signed-in user reading the picture). */
const NO_TV = '';
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

const MSG = {
  down: 'Pelayan siaran tidak berjalan',
  auth: 'Pelayan siaran menolak kunci kotak',
  upstream: 'Pelayan siaran bermasalah',
  badOffer: 'Tawaran sambungan tidak sah',
  tooMany: 'Terlalu banyak paparan siaran',
  noStream: 'tiada siaran',
  unsupported: 'Jenis kandungan tidak disokong',
} as const;

export interface Upstream {
  status: number;
  location: string | null;
  body: Buffer;
}

/**
 * One request to MediaMTX's WHIP/WHEP endpoint on 127.0.0.1. Nothing from the caller is copied
 * except the SDP body: the headers sent are fixed here, so cookies, the caller's bearer token and
 * proxy headers cannot reach MediaMTX. A size cap and a time cap apply to the answer.
 */
export function forwardToMediamtx(o: {
  port: number;
  method: 'POST' | 'DELETE';
  path: string;
  authorization: string;
  body?: string;
  timeoutMs?: number;
}): Promise<Upstream> {
  return new Promise((resolve, reject) => {
    const payload = o.body === undefined ? null : Buffer.from(o.body, 'utf8');
    const fail = (e: LiveError): void => reject(e);
    const timeoutMs = o.timeoutMs ?? REQUEST_TIMEOUT_MS;
    let settled = false;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: o.port,
        method: o.method,
        path: o.path,
        headers: {
          Authorization: o.authorization,
          ...(payload ? { 'Content-Type': 'application/sdp', 'Content-Length': String(payload.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_SDP_BYTES) {
            settled = true;
            req.destroy();
            fail(new LiveError(502, 'mediamtx_error', MSG.upstream));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          const loc = res.headers.location;
          resolve({ status: res.statusCode ?? 0, location: typeof loc === 'string' ? loc : null, body: Buffer.concat(chunks) });
        });
        res.on('error', () => undefined);
      },
    );
    // a hard deadline for the whole exchange, not just socket idleness
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      fail(new LiveError(503, 'mediamtx_down', MSG.down));
    }, timeoutMs);
    deadline.unref();
    req.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      // connection refused, reset or timeout: MediaMTX is not answering (the detail never reaches the caller)
      fail(new LiveError(503, 'mediamtx_down', MSG.down));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Last path segment of a Location value (relative path or full URL). */
function sessionIdFrom(location: string | null): string | null {
  if (location === null) return null;
  const path = location.split(/[?#]/)[0] ?? '';
  const last = path.replace(/\/+$/, '').split('/').pop() ?? '';
  return ID_RE.test(last) ? last : null;
}

export function sendLiveError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof LiveError) {
    return reply.code(error.status).header('Cache-Control', 'no-store').send({ errors: [error.message], code: error.code });
  }
  throw error;
}

export interface WebrtcProxyDeps {
  sessions: LiveSessions;
  runtime: () => LiveRuntime | null;
  /** The clock of the viewer table (default: the system's). */
  now?: () => number;
}

export interface WebrtcProxy {
  whipPost(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply>;
  whipDelete(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply>;
  whepPost(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply>;
  whepDelete(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply>;
  /** K1: a TV says its viewer is still watching; 404 when the box does not know the viewer (the TV reconnects by itself). */
  whepAlive(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply>;
  /** The live preview of the combined stream (`surau`): the starting device's, or another device joining the shared picture of a live that holds the camera. */
  previewPost(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply>;
  previewDelete(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply>;
  /** Forgets the open WHEP sessions (the live ended, MediaMTX closed them). */
  resetWhep(): void;
  /** Skrin went off while the picture goes on: close every open TV reader at MediaMTX (best effort) and forget them. */
  closeWhep(): void;
}

function sdpBody(request: FastifyRequest): string {
  const type = String(request.headers['content-type'] ?? '').toLowerCase();
  if (!type.startsWith('application/sdp') || typeof request.body !== 'string') {
    throw new LiveError(415, 'unsupported_media', MSG.unsupported);
  }
  if (!request.body.startsWith('v=0')) throw new LiveError(400, 'bad_offer', MSG.badOffer);
  return request.body;
}

export function createWebrtcProxy(deps: WebrtcProxyDeps): WebrtcProxy {
  // WHEP session id -> when it opened (`born`), when its TV last said it plays (`at`), whether it proved a fast alive,
  // and which MediaMTX path it reads (the path can change with the kiosk audio)
  const whep = new Map<string, { born: number; at: number; fast: boolean; path: string; tv: string }>();
  // preview session ids this proxy opened; an alive never revives one of them (the count of preview readers comes from
  // the live session's own preview table, see `previewReaders`)
  const previewMemo = new Map<string, string>();
  const closedMemo = new Set<string>();
  // every viewer id the box issued in `whepPost` and has not closed on purpose: an alive for a row the box no longer holds
  // (expired, taken by the count check) revives it only when the id was issued to that same TV
  const issued = new Map<string, { tv: string; path: string }>();
  let countCheckAt = Number.NEGATIVE_INFINITY;
  let countChecking = false;
  // offers sent to MediaMTX that it has not answered yet, per TV (shown as `connecting`)
  const pending = new Map<string, number>();
  const clock = deps.now ?? Date.now;
  // the viewer list of the live status: one entry per TV, however many sessions it has opened
  deps.sessions.attachViewers(() => {
    prune();
    void countCheck();
    const out = new Map<string, 'playing' | 'connecting'>();
    for (const w of whep.values()) if (w.tv !== NO_TV) out.set(w.tv, 'playing');
    for (const [tv, n] of pending) if (n > 0 && tv !== NO_TV && !out.has(tv)) out.set(tv, 'connecting');
    return [...out].map(([tvId, state]) => ({ tvId, state }));
  });

  function rememberClosed(id: string): void {
    if (closedMemo.size >= MAX_CLOSED_MEMO) {
      const first = closedMemo.values().next().value;
      if (first !== undefined) closedMemo.delete(first);
    }
    closedMemo.add(id);
  }

  function rememberIssued(id: string, tv: string, path: string): void {
    issued.delete(id);
    if (issued.size >= MAX_ISSUED) {
      const first = issued.keys().next().value;
      if (first !== undefined) issued.delete(first);
    }
    issued.set(id, { tv, path });
  }

  /**
   * Q1: a row whose TV has been quiet past its life is only forgotten here. The reader is NOT closed at MediaMTX and the id
   * does not enter the closed memo: a TV that is still playing (its alive messages were late or lost) must never lose its
   * picture to a timer. MediaMTX drops a dead WebRTC session by itself after about 30 seconds, and the id stays in
   * `issued`, so a late alive from the same TV gets its row back.
   */
  function prune(): void {
    const now = clock();
    for (const [id, w] of whep) {
      if (now - w.at <= (w.fast ? FAST_TTL_MS : WHEP_TTL_MS)) continue;
      whep.delete(id);
    }
  }

  /**
   * Compares the rows of the kiosk path with the WebRTC readers the media server reports for it (the open preview
   * sessions on that path subtracted). When the media server reports fewer readers than rows, the surplus rows are forgotten, the one quiet longest
   * first, never a row younger than 45 seconds. No answer, or any failure: nothing changes. At most one question per
   * 10 seconds, started from the viewer list and never waited for. The check goes by count only: the ids the box
   * stored come from the WHEP `Location` header and are not the media server's session ids. A TV whose row went by
   * mistake gets it back with its next alive (see `whepAlive`). The rows removed first are those past their own cadence
   * (a slow row more than 6 minutes, a fast row more than 45 seconds without an alive), the quietest first; then the
   * quietest of the rest. A row younger than 45 seconds is never removed.
   */
  async function countCheck(): Promise<void> {
    try {
      const t0 = clock();
      if (countChecking || t0 - countCheckAt < COUNT_CHECK_EVERY_MS) return;
      const path = deps.sessions.kioskPath();
      let rows = 0;
      for (const w of whep.values()) if (w.path === path) rows++;
      if (rows === 0) return;
      const api = deps.runtime()?.api;
      if (!api) return;
      countCheckAt = t0;
      countChecking = true;
      try {
        const ids = await api.pathWebrtcReaders(path);
        if (ids === null) return;
        // one WHEP viewer is one reader; the open preview sessions on this path are readers too, so they are subtracted
        // (Q8: counted from the live session's own preview table, not from what this proxy once remembered)
        const previews = deps.sessions.previewReaders(path);
        const readers = Math.max(0, ids.length - previews);
        const now = clock();
        const mine = [...whep].filter(([, w]) => w.path === path);
        let surplus = mine.length - readers;
        if (surplus <= 0) return;
        const past = (w: { at: number; fast: boolean }): boolean => now - w.at > (w.fast ? FAST_QUIET_MS : SLOW_QUIET_MS);
        mine.sort((a, b) => Number(past(b[1])) - Number(past(a[1])) || a[1].at - b[1].at);
        for (const [id, w] of mine) {
          if (surplus <= 0) break;
          if (now - w.born < COUNT_CHECK_MIN_AGE_MS) continue;
          whep.delete(id);
          surplus--;
        }
      } finally {
        countChecking = false;
      }
    } catch {
      /* the media server does not answer: keep every row */
    }
  }

  function rememberPreview(id: string, path: string): void {
    if (previewMemo.size >= MAX_PREVIEW_MEMO) {
      const first = previewMemo.values().next().value;
      if (first !== undefined) previewMemo.delete(first);
    }
    previewMemo.set(id, path);
  }

  function port(): number {
    const rt = deps.runtime();
    if (rt === null || rt.api === null) throw new LiveError(503, 'mediamtx_down', MSG.down);
    return rt.webrtcPort;
  }

  function boxAuth(): string {
    const api = deps.runtime()?.api;
    if (!api) throw new LiveError(503, 'mediamtx_down', MSG.down);
    return api.basicAuthHeader();
  }

  /** Common mapping of an upstream answer that is not a success. */
  function refuse(up: Upstream, noStream: boolean): LiveError | 'no_stream' {
    if (up.status === 401 || up.status === 403) return new LiveError(503, 'mediamtx_auth', MSG.auth);
    if (up.status === 404 && noStream) return 'no_stream';
    if (up.status === 400) return new LiveError(400, 'bad_offer', MSG.badOffer);
    return new LiveError(502, 'mediamtx_error', MSG.upstream);
  }

  /** Q5: the viewers of joined devices that went away are closed at MediaMTX too (best effort). */
  function closeStale(view: { path: string; stale?: string[] }): void {
    for (const id of view.stale ?? []) {
      previewMemo.delete(id);
      try {
        void forwardToMediamtx({ port: port(), method: 'DELETE', path: `/${view.path}/whep/${id}`, authorization: boxAuth() }).catch(() => undefined);
      } catch {
        /* MediaMTX is not running: nothing is held */
      }
    }
  }

  const deviceOf = (request: FastifyRequest): string => {
    const a = request.auth;
    if (a == null || a.kind !== 'user') throw new LiveError(403, 'not_owner', 'Tiada kebenaran untuk tindakan ini');
    return a.deviceId;
  };

  return {
    resetWhep(): void {
      whep.clear();
      issued.clear();
      pending.clear();
    },

    closeWhep(): void {
      for (const [id, w] of whep) {
        rememberClosed(id);
        void forwardToMediamtx({ port: port(), method: 'DELETE', path: `/${w.path}/whep/${id}`, authorization: boxAuth() }).catch(() => undefined);
        issued.delete(id);
      }
      whep.clear();
      pending.clear();
    },

    async previewPost(request, reply) {
      try {
        const offer = sdpBody(request);
        const view = deps.sessions.previewFor(deviceOf(request));
        closeStale(view);
        // the oldest preview makes room (a tab that closed without a DELETE)
        while (view.ids.size >= (view.max ?? MAX_PREVIEW_SESSIONS)) {
          const oldest = view.ids.values().next().value;
          if (oldest === undefined) break;
          view.ids.delete(oldest);
          previewMemo.delete(oldest);
          void forwardToMediamtx({ port: port(), method: 'DELETE', path: `/${view.path}/whep/${oldest}`, authorization: boxAuth() }).catch(() => undefined);
        }
        const up = await forwardToMediamtx({ port: port(), method: 'POST', path: `/${view.path}/whep`, authorization: boxAuth(), body: offer });
        if (up.status !== 201 && up.status !== 200) {
          const why = refuse(up, true);
          if (why === 'no_stream') return reply.code(404).header('Cache-Control', 'no-store').send({ errors: [MSG.noStream] });
          throw why;
        }
        const id = sessionIdFrom(up.location);
        if (id === null) throw new LiveError(502, 'mediamtx_error', MSG.upstream);
        view.ids.add(id);
        rememberPreview(id, view.path);
        return reply
          .code(201)
          .header('Content-Type', 'application/sdp')
          .header('Location', `/api/live/preview/whep/${id}`)
          .header('Cache-Control', 'no-store')
          .send(up.body);
      } catch (error) {
        return sendLiveError(reply, error);
      }
    },

    async previewDelete(request, reply) {
      try {
        const { id } = request.params as { id: string };
        const view = deps.sessions.previewFor(deviceOf(request));
        closeStale(view);
        if (!ID_RE.test(id) || !view.ids.has(id)) return reply.code(404).header('Cache-Control', 'no-store').send({ errors: [MSG.noStream] });
        const up = await forwardToMediamtx({ port: port(), method: 'DELETE', path: `/${view.path}/whep/${id}`, authorization: boxAuth() });
        view.ids.delete(id);
        previewMemo.delete(id);
        if ((up.status >= 200 && up.status < 300) || up.status === 404) return reply.code(204).header('Cache-Control', 'no-store').send();
        const why = refuse(up, false);
        throw why === 'no_stream' ? new LiveError(502, 'mediamtx_error', MSG.upstream) : why;
      } catch (error) {
        return sendLiveError(reply, error);
      }
    },

    async whipPost(request, reply) {
      try {
        const offer = sdpBody(request);
        const pub = deps.sessions.publisherFor(deviceOf(request));
        const up = await forwardToMediamtx({ port: port(), method: 'POST', path: `/${pub.path}/whip`, authorization: pub.authorization, body: offer });
        if (up.status !== 201 && up.status !== 200) {
          const why = refuse(up, false);
          throw why === 'no_stream' ? new LiveError(502, 'mediamtx_error', MSG.upstream) : why;
        }
        const id = sessionIdFrom(up.location);
        if (id === null) throw new LiveError(502, 'mediamtx_error', MSG.upstream);
        pub.whipIds.add(id);
        return reply
          .code(201)
          .header('Content-Type', 'application/sdp')
          .header('Location', `/api/live/whip/${id}`)
          .header('Cache-Control', 'no-store')
          .send(up.body);
      } catch (error) {
        return sendLiveError(reply, error);
      }
    },

    async whipDelete(request, reply) {
      try {
        const { id } = request.params as { id: string };
        const pub = deps.sessions.publisherFor(deviceOf(request));
        if (!ID_RE.test(id) || !pub.whipIds.has(id)) {
          return reply.code(404).header('Cache-Control', 'no-store').send({ errors: [MSG.noStream], code: 'not_found' });
        }
        const up = await forwardToMediamtx({ port: port(), method: 'DELETE', path: `/${pub.path}/whip/${id}`, authorization: pub.authorization });
        pub.whipIds.delete(id);
        if (up.status >= 200 && up.status < 300) return reply.code(204).header('Cache-Control', 'no-store').send();
        if (up.status === 404) return reply.code(204).header('Cache-Control', 'no-store').send();
        const why = refuse(up, false);
        throw why === 'no_stream' ? new LiveError(502, 'mediamtx_error', MSG.upstream) : why;
      } catch (error) {
        return sendLiveError(reply, error);
      }
    },

    async whepPost(request, reply) {
      try {
        const offer = sdpBody(request);
        // this TV's own profile switched the live picture off (the code is what the TV switches on)
        if (!deps.sessions.tvMayWatch(tvIdOf(request.auth))) throw new LiveError(403, 'tv_live_off', 'tv_live_off');
        prune();
        const tv = tvIdOf(request.auth) ?? NO_TV;
        // a full table: a slot a dropped kiosk left behind (no DELETE) is freed, this TV's own oldest first, then any
        // TV that holds more than one. When every slot is a different live TV the ninth viewer is refused with a code.
        while (whep.size >= MAX_WHEP_SESSIONS) {
          const perTv = new Map<string, number>();
          for (const w of whep.values()) perTv.set(w.tv, (perTv.get(w.tv) ?? 0) + 1);
          let oldest: string | undefined;
          for (const [id, w] of whep) if (w.tv === tv) { oldest = id; break; }
          if (oldest === undefined) for (const [id, w] of whep) if ((perTv.get(w.tv) ?? 0) > 1) { oldest = id; break; }
          if (oldest === undefined) throw new LiveError(429, 'too_many_viewers', MSG.tooMany);
          const gone = whep.get(oldest);
          whep.delete(oldest);
          issued.delete(oldest);
          rememberClosed(oldest);
          if (gone !== undefined) {
            // best effort: let MediaMTX free the reader too
            void forwardToMediamtx({ port: port(), method: 'DELETE', path: `/${gone.path}/whep/${oldest}`, authorization: boxAuth() }).catch(() => undefined);
          }
        }
        const readPath = deps.sessions.kioskPath();
        pending.set(tv, (pending.get(tv) ?? 0) + 1);
        let up: Upstream;
        try {
          up = await forwardToMediamtx({ port: port(), method: 'POST', path: `/${readPath}/whep`, authorization: boxAuth(), body: offer });
        } finally {
          const left = (pending.get(tv) ?? 1) - 1;
          if (left > 0) pending.set(tv, left);
          else pending.delete(tv);
        }
        if (up.status !== 201 && up.status !== 200) {
          const why = refuse(up, true);
          if (why === 'no_stream') return reply.code(404).header('Cache-Control', 'no-store').send({ errors: [MSG.noStream] });
          throw why;
        }
        const id = sessionIdFrom(up.location);
        if (id === null) throw new LiveError(502, 'mediamtx_error', MSG.upstream);
        // B9: Skrin or this TV's profile may have switched off while the POST was awaited: the new reader is removed and refused
        if (!deps.sessions.tvMayWatch(tvIdOf(request.auth))) {
          try {
            await forwardToMediamtx({ port: port(), method: 'DELETE', path: `/${readPath}/whep/${id}`, authorization: boxAuth() });
          } catch {
            /* best effort: MediaMTX drops an idle reader by itself */
          }
          throw new LiveError(403, 'tv_live_off', 'tv_live_off');
        }
        const born = clock();
        whep.set(id, { born, at: born, fast: false, path: readPath, tv });
        rememberIssued(id, tv, readPath);
        return reply
          .code(201)
          .header('Content-Type', 'application/sdp')
          .header('Location', `/api/kiosk/live/whep/${id}`)
          .header('Cache-Control', 'no-store')
          .send(up.body);
      } catch (error) {
        return sendLiveError(reply, error);
      }
    },

    async whepAlive(request, reply) {
      const { id } = request.params as { id: string };
      const tv = tvIdOf(request.auth) ?? NO_TV;
      const now = clock();
      const open = ID_RE.test(id) ? whep.get(id) : undefined;
      if (open === undefined) {
        // a row the box forgot (the count check, or its life ran out) while the TV still plays: it gets it back with its
        // alive, so it is counted again (the picture was never touched). Only for an id this box issued to this same TV,
        // on the path it was issued for; never for a caller that is no TV, a row closed on purpose or a full table. A TV
        // may hold several rows (a follower box shares one identity on the main box), so the row count is not limited per TV.
        const grant = ID_RE.test(id) ? issued.get(id) : undefined;
        const mayRevive =
          grant !== undefined &&
          tv !== NO_TV &&
          grant.tv === tv &&
          !closedMemo.has(id) &&
          !previewMemo.has(id) &&
          whep.size < MAX_WHEP_SESSIONS &&
          deps.sessions.tvMayWatch(tvIdOf(request.auth));
        if (!mayRevive || grant === undefined) return reply.code(404).header('Cache-Control', 'no-store').send({ errors: [MSG.noStream] });
        // the row proves its cadence again with the next alive inside 60 seconds
        whep.set(id, { born: now, at: now, fast: false, path: grant.path, tv });
        return reply.code(204).header('Cache-Control', 'no-store').send();
      }
      // only the TV that opened the viewer keeps it alive
      if (open.tv !== tv) {
        return reply.code(404).header('Cache-Control', 'no-store').send({ errors: [MSG.noStream] });
      }
      // an alive inside the first minute shows a page that says it every 30 seconds: this row then lives 90 seconds
      // after its last alive; a page that does not (5 minutes) keeps the 30 minute life
      if (!open.fast && now - open.born <= FAST_PROOF_MS) open.fast = true;
      open.at = now;
      return reply.code(204).header('Cache-Control', 'no-store').send();
    },

    async whepDelete(request, reply) {
      try {
        const { id } = request.params as { id: string };
        const open = ID_RE.test(id) ? whep.get(id) : undefined;
        // only the TV that opened the viewer closes it
        if (open === undefined || open.tv !== (tvIdOf(request.auth) ?? NO_TV)) {
          return reply.code(404).header('Cache-Control', 'no-store').send({ errors: [MSG.noStream] });
        }
        const up = await forwardToMediamtx({ port: port(), method: 'DELETE', path: `/${open.path}/whep/${id}`, authorization: boxAuth() });
        whep.delete(id);
        issued.delete(id);
        rememberClosed(id);
        if ((up.status >= 200 && up.status < 300) || up.status === 404) return reply.code(204).header('Cache-Control', 'no-store').send();
        const why = refuse(up, false);
        throw why === 'no_stream' ? new LiveError(502, 'mediamtx_error', MSG.upstream) : why;
      } catch (error) {
        return sendLiveError(reply, error);
      }
    },
  };
}
