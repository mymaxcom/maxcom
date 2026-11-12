import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSettings } from '@surau/core';
import { openDb } from '../src/db.ts';
import { guardedFetch } from '../src/net/safeFetch.ts';
import { importDays } from '../src/prayerStore.ts';
import { listZones, refreshZones, suggestZone, zoneKnown, zoneWarning } from '../src/prayer/zones.ts';

const page = readFileSync(fileURLToPath(new URL('./fixtures/esolat-zones-page.html', import.meta.url)), 'utf8');
const URL_OK = 'https://www.e-solat.gov.my/index.php?siteId=24&pageId=24';
const NOW = (): Date => new Date('2026-11-09T10:00:00Z');

const dbs: DatabaseSync[] = [];
const newDb = (): DatabaseSync => { const d = openDb(':memory:'); dbs.push(d); return d; };
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });

const serve = (body: string, status = 200): { impl: typeof fetch; calls: string[] } => {
  const calls: string[] = [];
  const impl = (async (url: string) => { calls.push(String(url)); return new Response(body, { status }); }) as unknown as typeof fetch;
  return { impl, calls };
};

describe('refreshZones', () => {
  it('on the saved page adds nothing to a fresh seed, reports the count and records the time', async () => {
    const db = newDb();
    const f = serve(page);
    const r = await refreshZones(db, f.impl, URL_OK, NOW);
    expect(r.count).toBeGreaterThanOrEqual(50);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(r.renamed).toEqual([]);
    expect(f.calls).toEqual([URL_OK]);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'jakimZones.fetchedAt'").get()).toEqual({ value: '2026-11-09T10:00:00.000Z' });
  });

  it('marks a zone JAKIM dropped as removed (kept, not deleted), clears it when it is back, and notes a new one', async () => {
    const db = newDb();
    const without = page.replace(/<option value='SGR03'[^>]*>[^<]*/, '');
    expect(without).not.toBe(page);
    let r = await refreshZones(db, serve(without).impl, URL_OK, NOW);
    expect(r.removed).toEqual(['SGR03']);
    expect(zoneKnown(db, 'SGR03')).toBe(false);
    expect(listZones(db).find((z) => z.code === 'SGR03')!.removed).toBe(true);
    r = await refreshZones(db, serve(page).impl, URL_OK, NOW);
    expect(r.added).toEqual(['SGR03']);
    expect(zoneKnown(db, 'SGR03')).toBe(true);
    const extra = page.replace('</select>', "<option value='ZZZ01' class='hs'>ZZZ01 - Tempat baharu</option></select>");
    r = await refreshZones(db, serve(extra).impl, URL_OK, NOW);
    expect(r.added).toEqual(['ZZZ01']);
    expect(zoneKnown(db, 'ZZZ01')).toBe(true);
  });

  it('records a changed name as renamed and warns the surau that chose it', async () => {
    const db = newDb();
    const renamedPage = page.replace('SGR01 - Gombak, Petaling', 'SGR01 - Gombak dan Petaling');
    expect(renamedPage).not.toBe(page);
    const r = await refreshZones(db, serve(renamedPage).impl, URL_OK, NOW);
    expect(r.renamed).toEqual(['SGR01']);
    expect(zoneWarning(db, resolveSettings({}))).toBe('Nama zon SGR01 bertukar');
    expect(zoneWarning(db, resolveSettings({ zone: { zone: 'JHR01' } }))).toBeNull();
    // the next refresh sees no new change, so the warning clears
    await refreshZones(db, serve(renamedPage).impl, URL_OK, NOW);
    expect(zoneWarning(db, resolveSettings({}))).toBeNull();
  });

  it('a removed zone warns with the last day the box holds', async () => {
    const db = newDb();
    importDays(db, 'SGR02', [
      { date: '2027-12-30', hijri: { y: 1449, m: 1, d: 1 }, times: { imsak: '05:40', subuh: '05:50', syuruk: '07:00', zohor: '13:10', asar: '16:20', maghrib: '19:10', isyak: '20:20' } },
      { date: '2027-12-31', hijri: { y: 1449, m: 1, d: 2 }, times: { imsak: '05:40', subuh: '05:50', syuruk: '07:00', zohor: '13:10', asar: '16:20', maghrib: '19:10', isyak: '20:20' } },
    ], 'tester');
    const s2 = resolveSettings({ zone: { zone: 'SGR02' } });
    expect(zoneWarning(db, s2)).toBeNull();
    await refreshZones(db, serve(page.replace(/<option value='SGR02'[^>]*>[^<]*/, '')).impl, URL_OK, NOW);
    expect(zoneWarning(db, s2)).toBe('Zon SGR02 tiada lagi dalam senarai JAKIM; data tersimpan digunakan sehingga 31 Dis 2027');
    // a zone with no data at all still gets the short warning
    await refreshZones(db, serve(page.replace(/<option value='SGR03'[^>]*>[^<]*/, '').replace(/<option value='SGR02'[^>]*>[^<]*/, '')).impl, URL_OK, NOW);
    expect(zoneWarning(db, resolveSettings({ zone: { zone: 'SGR03' } }))).toBe('Zon SGR03 tiada lagi dalam senarai JAKIM');
  });

  it('refuses a page that is not the zone list and leaves the table alone', async () => {
    const db = newDb();
    const ten = [...page.matchAll(/<option value='[A-Z]{3}\d{2}'[^>]*>[^<]*/g)].slice(0, 10).map((m) => `${m[0]}</option>`).join('');
    await expect(refreshZones(db, serve(ten).impl, URL_OK, NOW)).rejects.toThrow(/zone list/);
    await expect(refreshZones(db, serve('<html>ok</html>').impl, URL_OK, NOW)).rejects.toThrow(/zone list/);
    await expect(refreshZones(db, serve(page, 500).impl, URL_OK, NOW)).rejects.toThrow(/HTTP 500/);
    expect(listZones(db).every((z) => !z.removed)).toBe(true);
    expect(listZones(db).length).toBeGreaterThanOrEqual(50);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'jakimZones.lastError'").get()).toBeDefined();
  });

  it('is bounded: a page over 2 MB is refused', async () => {
    const db = newDb();
    await expect(refreshZones(db, serve('x'.repeat(2 * 1024 * 1024 + 10)).impl, URL_OK, NOW)).rejects.toThrow(/too large/);
  });

  it('never reaches the network for an http, local or private address', async () => {
    const db = newDb();
    const f = serve(page);
    await expect(refreshZones(db, f.impl, 'http://www.e-solat.gov.my/x', NOW)).rejects.toThrow();
    await expect(refreshZones(db, f.impl, 'https://localhost/x', NOW)).rejects.toThrow();
    expect(f.calls).toEqual([]);
    // a host that resolves to a private address is refused by the guarded fetch itself
    const guarded = guardedFetch(f.impl, async () => ['10.0.0.5']);
    await expect(refreshZones(db, guarded, URL_OK, NOW)).rejects.toThrow(/private|local/);
    expect(f.calls).toEqual([]);
    // and a public one passes
    const okGuard = guardedFetch(f.impl, async () => ['203.0.113.9']);
    await expect(refreshZones(db, okGuard, URL_OK, NOW)).resolves.toMatchObject({ added: [] });
  });
});

describe('suggestZone and listZones', () => {
  it('suggests the nearest zone within 150 km and nothing farther', () => {
    const db = newDb();
    expect(suggestZone(db, 3.0738, 101.5183)?.code).toBe('SGR01');
    expect(suggestZone(db, 3.1390, 101.6869)?.code).toBe('WLY01');
    expect(suggestZone(db, -1.29, 36.82)).toBeNull();
    expect(suggestZone(db, Number.NaN, 1)).toBeNull();
  });
  it('does not suggest a removed zone', async () => {
    const db = newDb();
    db.prepare("UPDATE jakim_zones SET removed_at = 'x' WHERE code = 'SGR01'").run();
    expect(suggestZone(db, 3.0738, 101.5183)?.code).not.toBe('SGR01');
  });
  it('tags the years the box holds with 300 days or more', () => {
    const db = newDb();
    const mk = (date: string) => ({ date, hijri: { y: 1448, m: 1, d: 1 }, times: { imsak: '05:40', subuh: '05:50', syuruk: '07:00', zohor: '13:10', asar: '16:20', maghrib: '19:10', isyak: '20:20' } });
    const days = [];
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2026, 11, 31); t += 86_400_000) days.push(mk(new Date(t).toISOString().slice(0, 10)));
    importDays(db, 'SGR01', days, 'tester');
    importDays(db, 'JHR01', days.slice(0, 20), 'tester');
    const z = listZones(db);
    expect(z.find((x) => x.code === 'SGR01')!.years).toEqual([2026]);
    expect(z.find((x) => x.code === 'JHR01')!.years).toEqual([]);
  });
});
