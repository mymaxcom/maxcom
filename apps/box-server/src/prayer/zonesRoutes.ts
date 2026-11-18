import { reqSurau } from '../reqSurau.ts';
import type { FastifyInstance } from 'fastify';
import { hasOfficialSource } from '@surau/core';
import { getSettings } from '../settingsStore.ts';
import { sourceUrlsFrom } from '../net/safeFetch.ts';
import { tooMany } from '../auth/authz.ts';
import type { PrayerDeps } from './index.ts';
import { located } from './calc.ts';
import { listZones, refreshZones, suggestZone, zoneWarning, zonesFetchedAt, ZoneListError } from './zones.ts';

const safe = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\bhttps?:\/\/\S*/gi, '[alamat]').replace(/\s+/g, ' ').trim().slice(0, 200);
};

export function registerZonesRoutes(app: FastifyInstance, deps: PrayerDeps): void {
  const { db, now, fetchImpl, limiters } = deps;

  app.get('/api/prayer/zones', async (request, reply) => {
    const settings = getSettings(db, reqSurau(request));
    const suggested = located(settings) && hasOfficialSource(settings.location.country)
      ? suggestZone(db, settings.location.latitude as number, settings.location.longitude as number, reqSurau(request))
      : null;
    reply.header('Cache-Control', 'no-store');
    return {
      zones: listZones(db, reqSurau(request)),
      fetchedAt: zonesFetchedAt(db, reqSurau(request)),
      warning: zoneWarning(db, settings, reqSurau(request)),
      suggested,
    };
  });

  app.post('/api/prayer/zones/refresh', async (request, reply) => {
    // one budget per surau (on a box: the one local surau), so one surau cannot use up another's refreshes
    const gate = limiters.zoneRefresh.hit(`surau:${reqSurau(request)}`);
    if (!gate.ok) return tooMany(reply, gate.retryAfterSec);
    try {
      return await refreshZones(db, fetchImpl, sourceUrlsFrom(getSettings(db, reqSurau(request))).esolatZones, now, reqSurau(request));
    } catch (error) {
      return reply.code(502).send({ errors: [error instanceof ZoneListError ? error.message : safe(error)], reason: 'upstream' });
    }
  });
}
