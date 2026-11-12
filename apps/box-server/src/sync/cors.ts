import type { FastifyInstance } from 'fastify';

/** An origin as a browser sends it (scheme, host, optional port). Anything else, `*` and `null` included, is not an origin. */
export function normaliseOrigin(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.hostname === '') return null;
  if (u.username !== '' || u.password !== '' || u.pathname !== '/' || u.search !== '' || u.hash !== '') return null;
  return u.origin;
}

const ALLOW_HEADERS = 'Authorization, Content-Type';
const ALLOW_METHODS = 'GET, POST, PUT, DELETE';

/**
 * CORS for the configured app origins only (SECURITY code). The allow header is echoed only for an exact
 * match of a listed origin, never `*`, never with credentials. A preflight from a listed origin is answered
 * 204 here, before authorisation (a preflight carries no token); from any other origin it is not answered
 * and falls through to the normal rules, which refuse it. Register before the auth hook.
 */
export function registerCors(app: FastifyInstance, origins: readonly string[]): void {
  const allowed = new Set(origins.map(normaliseOrigin).filter((o): o is string => o !== null));
  if (allowed.size === 0) return;
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !allowed.has(origin)) return undefined;
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Vary', 'Origin');
    if (request.method === 'OPTIONS') {
      reply
        .header('Access-Control-Allow-Headers', ALLOW_HEADERS)
        .header('Access-Control-Allow-Methods', ALLOW_METHODS)
        .header('Access-Control-Max-Age', '600')
        .header('Cache-Control', 'no-store');
      return reply.code(204).send();
    }
    return undefined;
  });
}
