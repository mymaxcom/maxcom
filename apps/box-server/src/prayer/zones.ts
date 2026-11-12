import type { DatabaseSync } from 'node:sqlite';
import { JAKIM_STATES, parseZoneOptions } from '@surau/core';
import type { Settings } from '@surau/core';
import { readCapped } from '../net/readCapped.ts';
import { assertSourceUrl } from '../net/safeFetch.ts';

const ZONE = /^[A-Z]{3}\d{2}$/;
const TIMEOUT_MS = 20_000;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MIN_ZONES = 40;
/** A zone is "stored on this box" for a year when it holds at least this many days of it. */
const MIN_DAYS_FOR_YEAR = 300;
/** Farthest a location may be from a zone centre for the zone to be suggested. */
export const SUGGEST_MAX_KM = 150;
export const USER_AGENT = 'MAXCOM/1.0 (+https://mymaxcom.my)';

export interface ZoneRefreshResult { added: string[]; removed: string[]; renamed: string[]; count: number }

/** Why the zone page could not be used; the message is safe to show (no address in it). */
export class ZoneListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZoneListError';
  }
}

function setMeta(db: DatabaseSync, key: string, value: string | null): void {
  if (value === null) {
    db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    return;
  }
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

function getMeta(db: DatabaseSync, key: string): string | null {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return typeof r?.value === 'string' ? r.value : null;
}

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\bhttps?:\/\/\S*/gi, '[alamat]').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Re-reads the zone `<select>` of the e-Solat page and updates `jakim_zones`: new codes are added, a code that
 * is no longer listed is marked removed (never deleted: stored days of it keep being used), a changed name is
 * recorded as renamed. A page that does not look like the zone page (under 40 zones, or no SGR01) changes
 * nothing. The caller supplies a guarded fetch (https, public addresses, no redirects); the address is checked
 * here again so a bad setting never reaches the network.
 */
export async function refreshZones(
  db: DatabaseSync,
  fetchImpl: typeof fetch,
  baseUrl: string,
  now: () => Date,
): Promise<ZoneRefreshResult> {
  assertSourceUrl(baseUrl, 'e-Solat zone list');
  const at = now().toISOString();
  let html: string;
  try {
    const response = await fetchImpl(baseUrl, {
      method: 'GET',
      headers: { accept: 'text/html', 'user-agent': USER_AGENT },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`e-Solat zone page answered HTTP ${response.status}`);
    html = new TextDecoder().decode(await readCapped(response, MAX_PAGE_BYTES, 'e-Solat zone page'));
  } catch (error) {
    setMeta(db, 'jakimZones.lastError', safeMessage(error));
    throw error;
  }

  const listed = parseZoneOptions(html);
  if (listed.length < MIN_ZONES || !listed.some((z) => z.code === 'SGR01')) {
    const msg = 'The e-Solat page does not look like the zone list; the stored list is kept';
    setMeta(db, 'jakimZones.lastError', msg);
    throw new ZoneListError(msg);
  }

  const added: string[] = [];
  const renamed: string[] = [];
  const removed: string[] = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const known = new Map<string, { name: string; removedAt: string | null }>();
    for (const r of db.prepare('SELECT code, name, removed_at FROM jakim_zones').all()) {
      known.set(String(r.code), { name: String(r.name), removedAt: typeof r.removed_at === 'string' ? r.removed_at : null });
    }
    const insert = db.prepare('INSERT INTO jakim_zones (code, state, name, lat, lon, fetched_at) VALUES (?, ?, ?, NULL, NULL, ?)');
    const touch = db.prepare('UPDATE jakim_zones SET name = ?, fetched_at = ?, removed_at = NULL WHERE code = ?');
    const seen = new Set<string>();
    for (const z of listed) {
      seen.add(z.code);
      const was = known.get(z.code);
      if (!was) {
        insert.run(z.code, JAKIM_STATES[z.code.slice(0, 3)] ?? z.code.slice(0, 3), z.name, at);
        added.push(z.code);
      } else {
        if (was.name !== z.name) renamed.push(z.code);
        if (was.removedAt !== null) added.push(z.code);
        touch.run(z.name, at, z.code);
      }
    }
    for (const [code, was] of known) {
      if (!seen.has(code) && was.removedAt === null) {
        db.prepare('UPDATE jakim_zones SET removed_at = ? WHERE code = ?').run(at, code);
        removed.push(code);
      }
    }
    setMeta(db, 'jakimZones.fetchedAt', at);
    setMeta(db, 'jakimZones.lastError', null);
    setMeta(db, 'jakimZones.renamed', JSON.stringify(renamed));
    db.prepare(
      `INSERT INTO change_log (at, actor, entity, entity_id, before_json, after_json)
       VALUES (?, 'system:zone-refresh', 'jakim_zones', 'refresh', NULL, ?)`,
    ).run(at, JSON.stringify({ added, removed, renamed, count: listed.length }));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { added, removed, renamed, count: listed.length };
}

export interface ZoneRow { code: string; state: string; name: string; lat: number | null; lon: number | null; removed: boolean; years: number[] }

/** Every zone of the list; `years` are the years this box really holds (300 days or more) for it. */
export function listZones(db: DatabaseSync): ZoneRow[] {
  const years = new Map<string, number[]>();
  for (const r of db
    .prepare('SELECT zone, substr(date, 1, 4) AS y, COUNT(*) AS n FROM prayer_days GROUP BY zone, y HAVING n >= ? ORDER BY y')
    .all(MIN_DAYS_FOR_YEAR)) {
    const list = years.get(String(r.zone));
    const y = Number(r.y);
    if (list) list.push(y); else years.set(String(r.zone), [y]);
  }
  return db.prepare('SELECT code, state, name, lat, lon, removed_at FROM jakim_zones ORDER BY code').all().map((r) => ({
    code: String(r.code), state: String(r.state), name: String(r.name),
    lat: typeof r.lat === 'number' ? r.lat : null, lon: typeof r.lon === 'number' ? r.lon : null,
    removed: typeof r.removed_at === 'string', years: years.get(String(r.code)) ?? [],
  }));
}

export function zoneKnown(db: DatabaseSync, code: string): boolean {
  if (!ZONE.test(code)) return false;
  return db.prepare('SELECT 1 AS ok FROM jakim_zones WHERE code = ? AND removed_at IS NULL').get(code) !== undefined;
}

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = (d: number): number => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** The zone whose centre is nearest to a place; null when none is within 150 km. Never applied by itself. */
export function suggestZone(db: DatabaseSync, lat: number, lon: number): { code: string; distanceKm: number } | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let best: { code: string; distanceKm: number } | null = null;
  for (const z of listZones(db)) {
    if (z.removed || z.lat === null || z.lon === null) continue;
    const d = haversineKm(lat, lon, z.lat, z.lon);
    if (best === null || d < best.distanceKm) best = { code: z.code, distanceKm: d };
  }
  if (best === null || best.distanceKm > SUGGEST_MAX_KM) return null;
  return { code: best.code, distanceKm: Math.round(best.distanceKm * 10) / 10 };
}

const MONTHS = ['Jan', 'Feb', 'Mac', 'Apr', 'Mei', 'Jun', 'Jul', 'Ogo', 'Sep', 'Okt', 'Nov', 'Dis'];

/** BM warning for the chosen zone when JAKIM dropped or renamed it; null when all is well. */
export function zoneWarning(db: DatabaseSync, settings: Settings): string | null {
  const code = String(settings.zone.zone);
  if (!ZONE.test(code)) return null;
  const row = db.prepare('SELECT removed_at FROM jakim_zones WHERE code = ?').get(code);
  if (row && typeof row.removed_at === 'string') {
    const last = db.prepare('SELECT MAX(date) AS d FROM prayer_days WHERE zone = ?').get(code);
    const d = typeof last?.d === 'string' ? last.d : null;
    if (d === null) return `Zon ${code} tiada lagi dalam senarai JAKIM`;
    const day = Number(d.slice(8, 10));
    return `Zon ${code} tiada lagi dalam senarai JAKIM; data tersimpan digunakan sehingga ${day} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
  }
  try {
    const renamed = JSON.parse(getMeta(db, 'jakimZones.renamed') ?? '[]') as unknown;
    if (Array.isArray(renamed) && renamed.includes(code)) return `Nama zon ${code} bertukar`;
  } catch { /* an unreadable note is no warning */ }
  return null;
}
