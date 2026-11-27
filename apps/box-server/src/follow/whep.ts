import type { IncomingMessage } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FollowStore } from './store.ts';

/**
 * The live picture on a follower's TV. The page posts its WebRTC offer to this box's own `/api/kiosk/live/whep`; this
 * box has no MediaMTX, so it forwards the offer to the master's same path with the TV cookie and hands back the
 * answer and the `Location` unchanged. The media then flows from the master straight to this TV, never through this box.
 *
 * Nothing from the page is copied except the SDP body: the headers sent are fixed here, so the page's own cookies and
 * tokens never reach the master.
 */

const MAX_SDP_BYTES = 64 * 1024;
const MAX_ANSWER_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;
const WHEP_PATH = '/api/kiosk/live/whep';
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const LOCATION_RE = /^\/api\/kiosk\/live\/whep\/[A-Za-z0-9-]{1,64}$/;

/** The pinned client, with the methods a WHEP resource needs (the real client passes any method on to `https`). */
export interface WhepClient {
  request(
    origin: string,
    caSha256: string,
    req: { method?: 'GET' | 'POST' | 'DELETE' | 'PATCH'; path: string; headers?: Record<string, string>; body?: string | Uint8Array; timeoutMs?: number },
  ): Promise<IncomingMessage>;
}

export interface WhepDeps {
  follow: FollowStore;
  client: WhepClient;
  /** The master address that worked last; tried first. */
  origin?: () => string | null;
}

export interface Whep {
  /** True when `method` and `path` are a WHEP call this module answers. */
  matches(method: string, path: string): boolean;
  /** Answers it. `body` is the SDP offer when the framework already read it, else it is read from the raw request. */
  handle(request: FastifyRequest, reply: FastifyReply, path: string): Promise<FastifyReply>;
}

function refuse(reply: FastifyReply, status: number, code: string): FastifyReply {
  return reply.code(status).header('Cache-Control', 'no-store').type('application/json; charset=utf-8').send({ code, errors: [code] });
}

function readBody(res: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    let size = 0;
    res.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        res.destroy();
        resolve(null);
        return;
      }
      parts.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(parts)));
    res.on('error', () => resolve(null));
    res.on('close', () => resolve(null));
  });
}

function readRaw(request: FastifyRequest, max: number): Promise<string | null> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    let size = 0;
    const raw = request.raw;
    raw.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        resolve(null);
        return;
      }
      if (size <= max) parts.push(c);
    });
    raw.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    raw.on('error', () => resolve(null));
  });
}

const ALIVE = '/alive';

export function forwardWhep(d: WhepDeps): Whep {
  /** Tries the master's addresses in order; the first that answers wins. A refused token is the master's answer too. */
  const upstream = async (method: 'POST' | 'DELETE', path: string, body?: string): Promise<{ status: number; headers: IncomingMessage['headers']; body: Buffer } | null> => {
    const rec = d.follow.read();
    if (rec === null) return null;
    const first = d.origin?.() ?? null;
    const order = first !== null && rec.addresses.includes(first) ? [first, ...rec.addresses.filter((a) => a !== first)] : rec.addresses;
    for (const origin of order) {
      try {
        const res = await d.client.request(origin, rec.masterCa, {
          method, path, timeoutMs: TIMEOUT_MS,
          headers: { cookie: `surau_kiosk=${rec.token}`, ...(body !== undefined ? { 'content-type': 'application/sdp' } : {}) },
          ...(body !== undefined ? { body } : {}),
        });
        const answer = await readBody(res, MAX_ANSWER_BYTES);
        if (answer === null) continue;
        return { status: res.statusCode ?? 502, headers: res.headers, body: answer };
      } catch {
        // next address
      }
    }
    return null;
  };

  const relay = (reply: FastifyReply, up: { status: number; headers: IncomingMessage['headers']; body: Buffer }): FastifyReply => {
    const location = up.headers.location;
    if (typeof location === 'string' && !LOCATION_RE.test(location)) return refuse(reply, 502, 'bad_location');
    reply.code(up.status).header('Cache-Control', 'no-store');
    const type = up.headers['content-type'];
    if (typeof type === 'string' && /^(application\/sdp|application\/json)(;|$)/i.test(type)) reply.header('Content-Type', type);
    if (typeof location === 'string') reply.header('Location', location);
    return up.body.length === 0 ? reply.send() : reply.send(up.body);
  };

  return {
    matches(method, path) {
      if (method === 'POST' && path === WHEP_PATH) return true;
      if (!path.startsWith(`${WHEP_PATH}/`)) return false;
      const rest = path.slice(WHEP_PATH.length + 1);
      // K1: the TV's "still watching" goes to the master too, or the master forgets this box's TV (after 90 seconds for a page that says it every 30 seconds, after 30 minutes for an older page)
      if (method === 'POST') return rest.endsWith(ALIVE) && ID_RE.test(rest.slice(0, -ALIVE.length));
      return method === 'DELETE' && ID_RE.test(rest);
    },

    async handle(request, reply, path) {
      if (request.method === 'POST' && path !== WHEP_PATH) {
        const id = path.slice(WHEP_PATH.length + 1, -ALIVE.length);
        if (!path.endsWith(ALIVE) || !ID_RE.test(id)) return refuse(reply, 404, 'not_found');
        const up = await upstream('POST', `${WHEP_PATH}/${id}${ALIVE}`);
        return up === null ? refuse(reply, 502, 'master_unreachable') : relay(reply, up);
      }
      if (request.method === 'POST') {
        const type = String(request.headers['content-type'] ?? '');
        if (!type.toLowerCase().startsWith('application/sdp')) return refuse(reply, 415, 'unsupported');
        const offer = typeof request.body === 'string' ? request.body : await readRaw(request, MAX_SDP_BYTES);
        if (offer === null || offer.length > MAX_SDP_BYTES) return refuse(reply, 413, 'too_large');
        if (offer.trim() === '') return refuse(reply, 400, 'bad_offer');
        const up = await upstream('POST', WHEP_PATH, offer);
        return up === null ? refuse(reply, 502, 'master_unreachable') : relay(reply, up);
      }
      const id = path.slice(WHEP_PATH.length + 1);
      if (!ID_RE.test(id)) return refuse(reply, 404, 'not_found');
      const up = await upstream('DELETE', `${WHEP_PATH}/${id}`);
      return up === null ? refuse(reply, 502, 'master_unreachable') : relay(reply, up);
    },
  };
}
