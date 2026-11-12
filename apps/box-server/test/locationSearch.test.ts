import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { createRateLimiter } from '../src/auth/ratelimit.ts';
import { ATTRIBUTION, searchLocation, suggestTimezone } from '../src/prayer/location.ts';

const fixture = readFileSync(fileURLToPath(new URL('./fixtures/nominatim-shah-alam.json', import.meta.url)), 'utf8');
const BASE = 'https://nominatim.openstreetmap.org/search';
let clock = Date.parse('2026-11-09T10:00:00Z');
const NOW = (): Date => new Date(clock);

const dbs: DatabaseSync[] = [];
const newDb = (): DatabaseSync => { const d = openDb(':memory:'); dbs.push(d); return d; };
afterEach(() => { for (const d of dbs.splice(0)) d.close(); clock = Date.parse('2026-11-09T10:00:00Z'); });

interface Fake { impl: typeof fetch; calls: { url: string; headers: Record<string, string> }[] }
function fake(body = fixture, status = 200): Fake {
  const calls: Fake['calls'] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const limiter = () => createRateLimiter({ windowMs: 60_000, max: 10, now: () => clock });
const OPT = { key: 'user:a', minIntervalMs: 0 };

describe('searchLocation', () => {
  it('returns places with country, city and 4 place coordinates; the second call is cached and sends nothing', async () => {
    const db = newDb();
    const f = fake();
    const l = limiter();
    const a = await searchLocation(db, 'Masjid An-Nur Eastleigh', f.impl, BASE, NOW, l, OPT);
    expect(a).toMatchObject({ ok: true, cached: false, attribution: ATTRIBUTION });
    if (!a.ok) throw new Error('unreachable');
    expect(a.results[0]).toEqual({
      label: 'Masjid An-Nur, Eastleigh, Nairobi, Nairobi County, 00610, Kenya', city: 'Nairobi', lat: -1.28, lon: 36.8495, country: 'KE',
    });
    expect(a.results[1]).toMatchObject({ city: 'Shah Alam', country: 'MY', lat: 3.0733, lon: 101.5185 });
    // a broken row, an out of range row are dropped; a control character in a name is replaced
    expect(a.results.map((r) => r.label)).not.toContain('Broken row');
    expect(a.results.map((r) => r.label)).not.toContain('Latitude out of range');
    expect(a.results[2]!.label).toBe('Kampung Baru , Kelantan, Malaysia');
    expect(a.results).toHaveLength(3);
    expect(f.calls).toHaveLength(1);
    const b = await searchLocation(db, '  masjid an-nur eastleigh ', f.impl, BASE, NOW, l, OPT);
    expect(b).toMatchObject({ ok: true, cached: true });
    expect(f.calls).toHaveLength(1);
  });

  it('follows the Nominatim policy on the wire: User-Agent, format, limit, language, https', async () => {
    const db = newDb();
    const f = fake();
    await searchLocation(db, 'Shah Alam', f.impl, BASE, NOW, limiter(), OPT);
    const c = f.calls[0]!;
    expect(c.url.startsWith('https://nominatim.openstreetmap.org/search?')).toBe(true);
    const q = new URL(c.url).searchParams;
    expect(q.get('q')).toBe('Shah Alam');
    expect(q.get('format')).toBe('jsonv2');
    expect(q.get('limit')).toBe('5');
    expect(q.get('addressdetails')).toBe('1');
    expect(c.headers['user-agent']).toBe('MAXCOM/1.0 (+https://mymaxcom.my)');
    expect(c.headers['accept-language']).toBe('ms,en');
  });

  it('asks again after the 7 day cache has run out', async () => {
    const db = newDb();
    const f = fake();
    const l = limiter();
    await searchLocation(db, 'Shah Alam', f.impl, BASE, NOW, l, OPT);
    clock += 6 * 86_400_000;
    expect((await searchLocation(db, 'Shah Alam', f.impl, BASE, NOW, createRateLimiter({ windowMs: 1000, max: 99, now: () => clock }), OPT))).toMatchObject({ cached: true });
    clock += 2 * 86_400_000;
    expect((await searchLocation(db, 'Shah Alam', f.impl, BASE, NOW, createRateLimiter({ windowMs: 1000, max: 99, now: () => clock }), OPT))).toMatchObject({ cached: false });
    expect(f.calls).toHaveLength(2);
  });

  it('limits one person to 10 searches a minute', async () => {
    const db = newDb();
    const f = fake();
    const l = limiter();
    for (let i = 0; i < 10; i++) expect((await searchLocation(db, `place ${i}`, f.impl, BASE, NOW, l, OPT)).ok).toBe(true);
    const r = await searchLocation(db, 'place 11', f.impl, BASE, NOW, l, OPT);
    expect(r).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(f.calls).toHaveLength(10);
    expect((await searchLocation(db, 'place 11', f.impl, BASE, NOW, l, { ...OPT, key: 'user:b' })).ok).toBe(true);
  });

  it('spaces two requests from one box by the minimum interval', async () => {
    const db = newDb();
    const f = fake();
    const slept: number[] = [];
    const opts = { key: 'u', minIntervalMs: 1000, sleep: async (ms: number) => { slept.push(ms); } };
    await searchLocation(db, 'one', f.impl, BASE, NOW, limiter(), opts);
    await searchLocation(db, 'two', f.impl, BASE, NOW, limiter(), opts);
    expect(slept).toHaveLength(1);
    expect(slept[0]!).toBeGreaterThan(0);
    expect(slept[0]!).toBeLessThanOrEqual(1000);
  });

  it('refuses a bad query before anything is sent', async () => {
    const db = newDb();
    const f = fake();
    for (const q of ['', '   ', 'a\u0007b', 'x\ny']) {
      expect(await searchLocation(db, q, f.impl, BASE, NOW, limiter(), OPT), JSON.stringify(q)).toMatchObject({ ok: false, reason: 'bad_query' });
    }
    expect(f.calls).toHaveLength(0);
    // a query over 200 characters is cut, not refused
    const long = await searchLocation(db, 'a'.repeat(500), f.impl, BASE, NOW, limiter(), OPT);
    expect(long.ok).toBe(true);
    expect(new URL(f.calls[0]!.url).searchParams.get('q')).toHaveLength(200);
  });

  it('answers offline when the network fails, upstream for a bad answer, and never caches a failure', async () => {
    const db = newDb();
    const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    expect(await searchLocation(db, 'x1', down, BASE, NOW, limiter(), OPT)).toMatchObject({ ok: false, reason: 'offline' });
    expect(await searchLocation(db, 'x2', fake('nope', 200).impl, BASE, NOW, limiter(), OPT)).toMatchObject({ ok: false, reason: 'upstream' });
    expect(await searchLocation(db, 'x3', fake('[]', 503).impl, BASE, NOW, limiter(), OPT)).toMatchObject({ ok: false, reason: 'upstream' });
    expect(await searchLocation(db, 'x4', fake('x'.repeat(300_000), 200).impl, BASE, NOW, limiter(), OPT)).toMatchObject({ ok: false, reason: 'upstream' });
    expect(await searchLocation(db, 'x5', fake().impl, 'http://nominatim.example/search', NOW, limiter(), OPT)).toMatchObject({ ok: false, reason: 'upstream' });
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM location_cache').get()!.n)).toBe(0);
  });

  it('keeps the query text out of the cache, the change log and the audit trail', async () => {
    const db = newDb();
    await searchLocation(db, 'Rumah Sendiri Jalan Rahsia 12', fake().impl, BASE, NOW, limiter(), OPT);
    const dump = JSON.stringify([
      db.prepare('SELECT * FROM change_log').all(), db.prepare('SELECT * FROM location_cache').all(), db.prepare('SELECT * FROM meta').all(),
    ]);
    expect(dump).not.toMatch(/Rahsia/i);
    const row = db.prepare("SELECT * FROM change_log WHERE entity = 'location_search'").get()!;
    expect(JSON.parse(String(row.after_json))).toEqual({ results: 3 });
  });
});

describe('suggestTimezone', () => {
  const at = new Date('2026-11-09T12:00:00Z');
  it('picks the zone of the longitude, and the only zone when there is one', () => {
    expect(suggestTimezone('ID', 106.8, at)).toBe('Asia/Jakarta');
    expect(suggestTimezone('ID', 128, at)).toBe('Asia/Jayapura');
    expect(suggestTimezone('ID', 119, at)).toBe('Asia/Makassar');
    expect(suggestTimezone('KE', 36.8, at)).toBe('Africa/Nairobi');
    // Peninsular and Sarawak clocks agree, so either is right; the first listed is kept
    expect(['Asia/Kuala_Lumpur', 'Asia/Kuching']).toContain(suggestTimezone('MY', 110.3, at));
    expect(suggestTimezone('XX', 10, at)).toBe('UTC');
  });
});
