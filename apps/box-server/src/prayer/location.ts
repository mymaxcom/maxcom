import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { COUNTRIES, offsetMinutes } from '@surau/core';
import type { RateLimiter } from '../auth/ratelimit.ts';
import { readCapped } from '../net/readCapped.ts';
import { assertSourceUrl } from '../net/safeFetch.ts';
import { USER_AGENT } from './zones.ts';

const TIMEOUT_MS = 20_000;
const MAX_BYTES = 256 * 1024;
const MAX_QUERY = 200;
const CACHE_DAYS = 7;
const MAX_RESULTS = 5;
export const ATTRIBUTION = '(c) OpenStreetMap contributors';

export interface LocationHit { label: string; city: string; lat: number; lon: number; country: string }

export type SearchResult =
  | { ok: true; results: LocationHit[]; cached: boolean; attribution: string }
  | { ok: false; reason: 'offline' | 'rate_limited' | 'bad_query' | 'upstream'; retryAfterSec?: number };

export interface SearchOptions {
  /** Who is searching (rate limit key). */
  key?: string;
  /** Minimum gap between two requests to Nominatim from this box (policy: 1 per second). */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const lastRequestAt = new WeakMap<DatabaseSync, number>();

/** The text is hashed for the cache and the audit row; the query itself is never stored or logged. */
const queryHash = (q: string): string => createHash('sha256').update(q.toLowerCase()).digest('hex');

function hitsFrom(json: unknown): LocationHit[] {
  if (!Array.isArray(json)) return [];
  const out: LocationHit[] = [];
  for (const raw of json) {
    if (out.length >= MAX_RESULTS) break;
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const address = typeof r.address === 'object' && r.address !== null ? (r.address as Record<string, unknown>) : {};
    const code = typeof address.country_code === 'string' ? address.country_code.toUpperCase() : '';
    if (!/^[A-Z]{2}$/.test(code)) continue;
    const pick = (k: string): string => (typeof address[k] === 'string' ? (address[k] as string) : '');
    const city = (pick('city') || pick('town') || pick('village') || pick('suburb')).replace(CONTROL, ' ').trim().slice(0, 80);
    const name = typeof r.display_name === 'string' ? r.display_name : '';
    const label = name.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (label === '') continue;
    out.push({ label, city, lat: round4(lat), lon: round4(lon), country: code });
  }
  return out;
}

/**
 * One place search through Nominatim, from this box, when the person presses Cari (never as they type, never from
 * the kiosk). Cached 7 days by the hash of the lower-cased query; at most one request a second from this box;
 * the per-person limiter is the caller's. The query text and the addresses in the answer are not logged.
 */
export async function searchLocation(
  db: DatabaseSync,
  query: string,
  fetchImpl: typeof fetch,
  baseUrl: string,
  now: () => Date,
  limiter: RateLimiter,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const q = typeof query === 'string' ? query.trim().slice(0, MAX_QUERY) : '';
  if (q === '' || CONTROL.test(q)) return { ok: false, reason: 'bad_query' };
  const gate = limiter.hit(options.key ?? 'box');
  if (!gate.ok) return { ok: false, reason: 'rate_limited', retryAfterSec: gate.retryAfterSec };

  const hash = queryHash(q);
  const at = now();
  const cached = db.prepare('SELECT json, fetched_at FROM location_cache WHERE query_hash = ?').get(hash);
  if (cached && typeof cached.json === 'string' && typeof cached.fetched_at === 'string') {
    const age = at.getTime() - Date.parse(cached.fetched_at);
    if (age >= 0 && age < CACHE_DAYS * 86_400_000) {
      try {
        return { ok: true, results: JSON.parse(cached.json) as LocationHit[], cached: true, attribution: ATTRIBUTION };
      } catch { /* a bad cache row is fetched again */ }
    }
  }

  try {
    assertSourceUrl(baseUrl, 'Nominatim');
  } catch {
    return { ok: false, reason: 'upstream' };
  }
  const gap = options.minIntervalMs ?? 1000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // The slot is reserved before waiting, in one synchronous step, so concurrent searches queue one gap apart
  // instead of all reading the same last time and going out together.
  const last = lastRequestAt.get(db);
  const slot = gap > 0 && last !== undefined ? Math.max(Date.now(), last + gap) : Date.now();
  lastRequestAt.set(db, slot);
  const wait = slot - Date.now();
  if (wait > 0) await sleep(wait);

  const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}${new URLSearchParams({ q, format: 'jsonv2', limit: String(MAX_RESULTS), addressdetails: '1' }).toString()}`;
  let json: unknown;
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, 'accept-language': 'ms,en', accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: 'upstream' };
    json = JSON.parse(new TextDecoder().decode(await readCapped(response, MAX_BYTES, 'Nominatim response')));
  } catch (error) {
    // A refused address, a size cap or bad JSON is the service's fault; a network failure means no internet.
    const m = error instanceof Error ? error.message : '';
    const upstream = error instanceof SyntaxError || /too large|refused|must use https|not a valid URL|private/i.test(m);
    return { ok: false, reason: upstream ? 'upstream' : 'offline' };
  }

  const results = hitsFrom(json);
  const stamp = at.toISOString();
  db.prepare(
    `INSERT INTO location_cache (query_hash, json, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(query_hash) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`,
  ).run(hash, JSON.stringify(results), stamp);
  // Only the hash and the count: not the place the person typed.
  db.prepare(
    `INSERT INTO change_log (at, actor, entity, entity_id, before_json, after_json)
     VALUES (?, ?, 'location_search', ?, NULL, ?)`,
  ).run(stamp, options.key ?? 'system', hash.slice(0, 16), JSON.stringify({ results: results.length }));
  return { ok: true, results, cached: false, attribution: ATTRIBUTION };
}

/** The zone of a country whose current offset is closest to the longitude's solar time; the only zone when there is one. */
export function suggestTimezone(country: string, lon: number, at: Date = new Date()): string {
  const zones = COUNTRIES.find((c) => c.code === country)?.timezones ?? ['UTC'];
  if (zones.length === 1 || !Number.isFinite(lon)) return zones[0]!;
  const target = lon / 15;
  let best = zones[0]!;
  let bestGap = Infinity;
  for (const z of zones) {
    let gap: number;
    try {
      gap = Math.abs(offsetMinutes(at, z) / 60 - target);
    } catch {
      continue;
    }
    if (gap < bestGap) { best = z; bestGap = gap; }
  }
  return best;
}
