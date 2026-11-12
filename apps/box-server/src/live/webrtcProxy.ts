import http from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { LiveError } from './sessions.ts';
import type { LiveSessions } from './sessions.ts';
import type { LiveRuntime } from './mediamtx.ts';

/** Caps on everything that crosses the proxy. */
export const MAX_SDP_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_WHEP_SESSIONS = 4;
const WHEP_TTL_MS = 30 * 60 * 1000;
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
}

export interface WebrtcProxy {
  whipPost(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply>;
  whipDelete(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply>;
  whepPost(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply>;
  whepDelete(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply>;
  /** Forgets the open WHEP sessions (the live ended, MediaMTX closed them). */
  resetWhep(): void;
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
  // WHEP session id -> when it opened and which MediaMTX path it reads (the path can change with the kiosk audio)
  const whep = new Map<string, { at: number; path: string }>();

  const prune = (): void => {
    const now = Date.now();
    for (const [id, w] of whep) if (now - w.at > WHEP_TTL_MS) whep.delete(id);
  };

  const port = (): number => {
    const rt = deps.runtime();
    if (rt === null || rt.api === null) throw new LiveError(503, 'mediamtx_down', MSG.down);
    return rt.webrtcPort;
  };

  const boxAuth = (): string => {
    const api = deps.runtime()?.api;
    if (!api) throw new LiveError(503, 'mediamtx_down', MSG.down);
    return api.basicAuthHeader();
  };

  /** Common mapping of an upstream answer that is not a success. */
  function refuse(up: Upstream, noStream: boolean): LiveError | 'no_stream' {
    if (up.status === 401 || up.status === 403) return new LiveError(503, 'mediamtx_auth', MSG.auth);
    if (up.status === 404 && noStream) return 'no_stream';
    if (up.status === 400) return new LiveError(400, 'bad_offer', MSG.badOffer);
    return new LiveError(502, 'mediamtx_error', MSG.upstream);
  }

  const deviceOf = (request: FastifyRequest): string => {
    const a = request.auth;
    if (a == null || a.kind !== 'user') throw new LiveError(403, 'not_owner', 'Tiada kebenaran untuk tindakan ini');
    return a.deviceId;
  };

  return {
    resetWhep(): void {
      whep.clear();
    },

    async whipPost(request, reply) {
      try {
        const offer = sdpBody(request);
        const pub = deps.sessions.publisherFor(deviceOf(request));
        const up = await forwardToMediamtx({ port: port(), method: 'POST', path: '/surau/whip', authorization: pub.authorization, body: offer });
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
        const up = await forwardToMediamtx({ port: port(), method: 'DELETE', path: `/surau/whip/${id}`, authorization: pub.authorization });
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
        prune();
        // a full table (a kiosk that dropped without a DELETE) frees its oldest slot instead of refusing the next viewer
        while (whep.size >= MAX_WHEP_SESSIONS) {
          const oldest = whep.keys().next().value;
          if (oldest === undefined) break;
          const gone = whep.get(oldest);
          whep.delete(oldest);
          if (gone !== undefined) {
            // best effort: let MediaMTX free the reader too
            void forwardToMediamtx({ port: port(), method: 'DELETE', path: `/${gone.path}/whep/${oldest}`, authorization: boxAuth() }).catch(() => undefined);
          }
        }
        const readPath = deps.sessions.kioskPath();
        const up = await forwardToMediamtx({ port: port(), method: 'POST', path: `/${readPath}/whep`, authorization: boxAuth(), body: offer });
        if (up.status !== 201 && up.status !== 200) {
          const why = refuse(up, true);
          if (why === 'no_stream') return reply.code(404).header('Cache-Control', 'no-store').send({ errors: [MSG.noStream] });
          throw why;
        }
        const id = sessionIdFrom(up.location);
        if (id === null) throw new LiveError(502, 'mediamtx_error', MSG.upstream);
        whep.set(id, { at: Date.now(), path: readPath });
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

    async whepDelete(request, reply) {
      try {
        const { id } = request.params as { id: string };
        const open = ID_RE.test(id) ? whep.get(id) : undefined;
        if (open === undefined) {
          return reply.code(404).header('Cache-Control', 'no-store').send({ errors: [MSG.noStream] });
        }
        const up = await forwardToMediamtx({ port: port(), method: 'DELETE', path: `/${open.path}/whep/${id}`, authorization: boxAuth() });
        whep.delete(id);
        if ((up.status >= 200 && up.status < 300) || up.status === 404) return reply.code(204).header('Cache-Control', 'no-store').send();
        const why = refuse(up, false);
        throw why === 'no_stream' ? new LiveError(502, 'mediamtx_error', MSG.upstream) : why;
      } catch (error) {
        return sendLiveError(reply, error);
      }
    },
  };
}
