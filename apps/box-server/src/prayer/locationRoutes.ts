import type { FastifyInstance } from 'fastify';
import { actorOf } from '../actor.ts';
import { tooMany } from '../auth/authz.ts';
import { sourceUrlsFrom } from '../net/safeFetch.ts';
import { getSettings } from '../settingsStore.ts';
import type { PrayerDeps } from './index.ts';
import { ATTRIBUTION, searchLocation } from './location.ts';

export function registerLocationRoutes(app: FastifyInstance, deps: PrayerDeps): void {
  const { db, now, fetchImpl, limiters } = deps;

  // The search belongs to setting the location (settings:write). Nothing the person typed is logged.
  app.post('/api/location/search', async (request, reply) => {
    const body = request.body;
    const query = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { query?: unknown }).query : undefined;
    if (typeof query !== 'string') return reply.code(400).send({ errors: ['query must be text'], reason: 'bad_query' });
    const result = await searchLocation(db, query, fetchImpl, sourceUrlsFrom(getSettings(db)).nominatim, now, limiters.locationSearch, { key: actorOf(request), ...(deps.nominatimMinIntervalMs !== undefined ? { minIntervalMs: deps.nominatimMinIntervalMs } : {}) });
    reply.header('Cache-Control', 'no-store');
    if (result.ok) return { ...result, attribution: ATTRIBUTION };
    switch (result.reason) {
      case 'rate_limited': return tooMany(reply, result.retryAfterSec ?? 60);
      case 'bad_query': return reply.code(400).send({ errors: ['query must be 1 to 200 characters of plain text'], reason: 'bad_query' });
      case 'offline': return reply.code(503).send({ errors: ['MAXCOM tiada internet; taip koordinat'], reason: 'offline' });
      default: return reply.code(502).send({ errors: ['Carian lokasi tidak tersedia sekarang'], reason: 'upstream' });
    }
  });
}
