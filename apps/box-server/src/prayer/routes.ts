import type { FastifyInstance } from 'fastify';
import { checkPrayerDay, COUNTRIES, countryDefaults, dateOf, hasOfficialSource, tzOf } from '@surau/core';
import type { PrayerName, Settings } from '@surau/core';
import { actorOf, deviceOf } from '../actor.ts';
import { getSettings, getVersion } from '../settingsStore.ts';
import { officialYears } from '../prayerStore.ts';
import { computeDay, located } from './calc.ts';
import { suggestTimezone } from './location.ts';
import { CorrectionError, isPrayerName, isRealDate, putCorrection, removeCorrection } from './corrections.ts';
import type { PrayerDeps } from './index.ts';
import { addDays, crossCheck, daysBetween, officialChangedDays, PRAYER_NAMES, resolveDay, resolveDays } from './resolve.ts';
import type { CrossCheck } from './resolve.ts';
import { zoneWarning } from './zones.ts';

/** How far ahead the status counts days. */
export const STATUS_HORIZON_DAYS = 400;
const MAX_RANGE_DAYS = 400;

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface PrayerStatus {
  country: string;
  hasOfficial: boolean;
  zone: string;
  timezone: string;
  located: boolean;
  order: string[];
  today: { date: string; source: string; emergency: boolean } | null;
  daysAhead: { resolved: number; official: number; file: number };
  official: { zone: string; years: { year: number; days: number; fetchedAt: string | null }[] };
  zones: { fetchedAt: string | null; count: number; selectedKnown: boolean; warning: string | null };
  autoFetch: ReturnType<PrayerDeps['autoFetch']['status']>;
  warnings: string[];
}

function zoneInfo(deps: Pick<PrayerDeps, 'db'>, settings: Settings): PrayerStatus['zones'] {
  const { db } = deps;
  const count = Number(db.prepare('SELECT COUNT(*) AS n FROM jakim_zones WHERE removed_at IS NULL').get()?.n ?? 0);
  const meta = db.prepare("SELECT value FROM meta WHERE key = 'jakimZones.fetchedAt'").get();
  const newest = db.prepare('SELECT MAX(fetched_at) AS at FROM jakim_zones').get();
  const fetchedAt = typeof meta?.value === 'string' ? meta.value : typeof newest?.at === 'string' ? newest.at : null;
  const row = db.prepare('SELECT removed_at FROM jakim_zones WHERE code = ?').get(String(settings.zone.zone));
  return { fetchedAt, count, selectedKnown: row !== undefined && row.removed_at === null, warning: zoneWarning(db, settings) };
}

/** The one status block: the prayer routes, `/api/health` and the app all read this. */
export function prayerStatus(deps: Pick<PrayerDeps, 'db' | 'now' | 'autoFetch'>, settings: Settings = getSettings(deps.db)): PrayerStatus {
  const { db } = deps;
  const tz = tzOf(settings);
  const today = dateOf(deps.now(), tz);
  const country = settings.location.country;
  const days = resolveDays(db, settings, today, addDays(today, STATUS_HORIZON_DAYS - 1));
  const todayDay = days.find((d) => d.date === today) ?? null;
  const zone = String(settings.zone.zone);
  const years = hasOfficialSource(country)
    ? officialYears(db, zone).map((y) => ({ year: y.year, days: y.days.length, fetchedAt: y.fetchedAt }))
    : [];
  const zones = zoneInfo(deps, settings);
  const warnings: string[] = [];
  if (todayDay === null) warnings.push(located(settings) ? 'Tiada data waktu solat untuk hari ini' : 'Lokasi surau belum ditetapkan; waktu solat tidak dapat dikira');
  else if (todayDay.emergency) warnings.push('Hari ini guna kiraan sementara');
  if (zones.warning !== null) warnings.push(zones.warning);
  return {
    country,
    hasOfficial: hasOfficialSource(country),
    zone,
    timezone: tz,
    located: located(settings),
    order: [...(settings.prayerSources.sourceOrder as string[])],
    today: todayDay === null ? null : { date: today, source: todayDay.source, emergency: todayDay.emergency },
    daysAhead: {
      resolved: days.length,
      official: days.filter((d) => d.source === 'official').length,
      file: days.filter((d) => d.source === 'file').length,
    },
    official: { zone, years },
    zones,
    autoFetch: deps.autoFetch.status(),
    warnings,
  };
}

function rangeOf(query: unknown, tz: string, now: Date): { from: string; to: string } | { error: string } {
  const q = isPlain(query) ? query : {};
  const today = dateOf(now, tz);
  const from = typeof q.from === 'string' ? q.from : `${today.slice(0, 8)}01`;
  if (!isRealDate(from) || (q.to !== undefined && !isRealDate(q.to))) return { error: 'from and to must be real dates like 2026-11-01' };
  const to = typeof q.to === 'string' ? q.to : monthEnd(from);
  if (to < from) return { error: 'to must not be before from' };
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) return { error: `at most ${MAX_RANGE_DAYS} days at a time` };
  return { from, to };
}

function monthEnd(date: string): string {
  const first = `${date.slice(0, 7)}-01`;
  const next = addDays(first, 32);
  return addDays(`${next.slice(0, 7)}-01`, -1);
}

const emptyCross = (): CrossCheck => {
  const z = { imsak: 0, subuh: 0, syuruk: 0, zohor: 0, asar: 0, maghrib: 0, isyak: 0 };
  return { flagged: [], maxDiff: { ...z }, medianDiff: { ...z }, compared: 0 };
};

export function registerPrayerCoreRoutes(app: FastifyInstance, deps: PrayerDeps): void {
  const { db, now, bus } = deps;

  app.get('/api/prayer/days', async (request, reply) => {
    const settings = getSettings(db);
    const tz = tzOf(settings);
    const r = rangeOf(request.query, tz, now());
    if ('error' in r) return reply.code(400).send({ errors: [r.error] });
    const cross = settings.prayerSources.crossCheck && located(settings) ? crossCheck(db, settings, r.from, r.to) : emptyCross();
    reply.header('Cache-Control', 'no-store');
    const changed = officialChangedDays(db, settings, r.from, r.to);
    return {
      days: resolveDays(db, settings, r.from, r.to).map((d) => ({ ...d, officialChanged: changed.get(d.date) ?? [] })),
      crossCheck: cross,
      sources: {
        order: [...(settings.prayerSources.sourceOrder as string[])],
        country: settings.location.country,
        hasOfficial: hasOfficialSource(settings.location.country),
        zone: String(settings.zone.zone),
        located: located(settings),
        timezone: tz,
      },
    };
  });

  app.get('/api/prayer/status', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return prayerStatus(deps);
  });

  app.get('/api/prayer/calc/preview', async (request, reply) => {
    const settings = getSettings(db);
    const q = isPlain(request.query) ? request.query : {};
    const date = typeof q.date === 'string' ? q.date : dateOf(now(), tzOf(settings));
    if (!isRealDate(date)) return reply.code(400).send({ errors: ['date must be a real date like 2026-11-26'] });
    reply.header('Cache-Control', 'no-store');
    return reply.type('application/json').send(JSON.stringify(computeDay(date, settings)));
  });

  // The zone of a country that best fits a longitude, for the location screen's preselect.
  app.get('/api/prayer/timezone', async (request, reply) => {
    const q = isPlain(request.query) ? request.query : {};
    const country = typeof q.country === 'string' ? q.country.toUpperCase() : '';
    const lonText = typeof q.lon === 'string' ? q.lon.trim() : '';
    const lon = lonText === '' ? NaN : Number(lonText);
    if (!COUNTRIES.some((c) => c.code === country)) return reply.code(400).send({ errors: ['country must be a two-letter country code like MY'] });
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) return reply.code(400).send({ errors: ['lon must be a number from -180 to 180'] });
    reply.header('Cache-Control', 'no-store');
    return { timezone: suggestTimezone(country, lon, now()) };
  });

  app.get('/api/prayer/countries', async (request, reply) => {
    const q = isPlain(request.query) ? request.query : {};
    const lang = q.lang === 'en' ? 'en' : 'ms';
    const names = new Intl.DisplayNames([lang], { type: 'region' });
    reply.header('Cache-Control', 'max-age=86400');
    return COUNTRIES.map((c) => {
      let name = c.code;
      try { name = names.of(c.code) ?? c.code; } catch { /* keep the code */ }
      return { code: c.code, name, timezones: c.timezones, defaults: countryDefaults(c.code), hasOfficial: hasOfficialSource(c.code) };
    }).sort((a, b) => a.name.localeCompare(b.name, lang));
  });

  app.put('/api/prayer/corrections/:date/:prayer', async (request, reply) => {
    const { date, prayer } = request.params as { date: string; prayer: string };
    if (!isPrayerName(prayer)) return reply.code(404).send({ errors: [`unknown prayer ${prayer}`] });
    const body = isPlain(request.body) ? request.body : {};
    const input = { date, prayer, time: body.time, reason: body.reason };
    const settings = getSettings(db);
    try {
      // The corrected day must still be in order; a day with no times yet has nothing to compare with.
      const current = isRealDate(date) && typeof body.time === 'string' ? resolveDay(db, settings, date) : null;
      if (current !== null && typeof body.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) {
        const bad = checkPrayerDay({ ...current, times: { ...current.times, [prayer]: body.time } });
        if (bad !== null) return reply.code(400).send({ errors: [bad] });
      }
      putCorrection(db, input as { date: string; prayer: PrayerName; time: string; reason: string }, actorOf(request), deviceOf(request), now(),
        hasOfficialSource(settings.location.country) ? String(settings.zone.zone) : null);
    } catch (error) {
      if (error instanceof CorrectionError) return reply.code(error.status).send({ errors: error.errors });
      throw error;
    }
    bus.emit(getVersion(db));
    return { ok: true, day: resolveDay(db, settings, date) };
  });

  app.delete('/api/prayer/corrections/:date/:prayer', async (request, reply) => {
    const { date, prayer } = request.params as { date: string; prayer: string };
    if (!isPrayerName(prayer) || !PRAYER_NAMES.includes(prayer)) return reply.code(404).send({ errors: [`unknown prayer ${prayer}`] });
    if (!isRealDate(date)) return reply.code(400).send({ errors: ['date must be a real date like 2026-11-26'] });
    const removed = removeCorrection(db, date, prayer, actorOf(request), deviceOf(request), now());
    if (removed) bus.emit(getVersion(db));
    return { ok: true, removed, day: resolveDay(db, getSettings(db), date) };
  });
}
