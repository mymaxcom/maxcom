import type { FastifyInstance } from 'fastify';
import { hasOfficialSource } from '@surau/core';
import { getSettings } from '../settingsStore.ts';
import { sourceUrlsFrom } from '../net/safeFetch.ts';
import { tooMany } from '../auth/authz.ts';
import type { PrayerDeps } from './index.ts';
import { located } from './calc.ts';
import { listZones, refreshZones, suggestZone, zoneWarning, ZoneListError } from './zones.ts';

const safe = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\bhttps?:\/\/\S*/gi, '[alamat]').replace(/\s+/g, ' ').trim().slice(0, 200);
};

export function registerZonesRoutes(app: FastifyInstance, deps: PrayerDeps): void {
  const { db, now, fetchImpl, limiters } = deps;

  app.get('/api/prayer/zones', async (_request, reply) => {
    const settings = getSettings(db);
    const row = db.prepare("SELECT value FROM meta WHERE key = 'jakimZones.fetchedAt'").get();
    const newest = db.prepare('SELECT MAX(fetched_at) AS at FROM jakim_zones').get();
    const suggested = located(settings) && hasOfficialSource(settings.location.country)
      ? suggestZone(db, settings.location.latitude as number, settings.location.longitude as number)
      : null;
    reply.header('Cache-Control', 'no-store');
    return {
      zones: listZones(db),
      fetchedAt: typeof row?.value === 'string' ? row.value : typeof newest?.at === 'string' ? newest.at : null,
      warning: zoneWarning(db, settings),
      suggested,
    };
  });

  app.post('/api/prayer/zones/refresh', async (_request, reply) => {
    const gate = limiters.zoneRefresh.hit('box');
    if (!gate.ok) return tooMany(reply, gate.retryAfterSec);
    try {
      return await refreshZones(db, fetchImpl, sourceUrlsFrom(getSettings(db)).esolatZones, now);
    } catch (error) {
      return reply.code(502).send({ errors: [error instanceof ZoneListError ? error.message : safe(error)], reason: 'upstream' });
    }
  });
}
