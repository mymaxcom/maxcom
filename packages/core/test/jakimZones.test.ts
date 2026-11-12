import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JAKIM_STATES, JAKIM_ZONES, parseZoneOptions } from '../src/index.ts';

const page = readFileSync(fileURLToPath(new URL('./fixtures/esolat-zones-2026-11-09.html', import.meta.url)), 'utf8');

describe('e-Solat zone page', () => {
  const zones = parseZoneOptions(page);
  it('lists at least 50 zones with SGR01 named as on the site', () => {
    expect(zones.length).toBeGreaterThanOrEqual(50);
    expect(zones.find((z) => z.code === 'SGR01')?.name).toBe('Gombak, Petaling, Sepang, Hulu Langat, Hulu Selangor, S.Alam');
  });
  it('skips the state dropdown and keeps every code once', () => {
    expect(new Set(zones.map((z) => z.code)).size).toBe(zones.length);
    expect(zones.every((z) => /^[A-Z]{3}\d{2}$/.test(z.code))).toBe(true);
  });
  it('handles double quotes, extra markup and junk without throwing', () => {
    expect(parseZoneOptions('<option value="ABC01" class="x">ABC01 - Some <b>Place</b></option>')).toEqual([{ code: 'ABC01', name: 'Some' }]);
    expect(parseZoneOptions('<option value="ABC1">x</option><option value="abc01">y</option>')).toEqual([]);
    expect(parseZoneOptions('')).toEqual([]);
    expect(parseZoneOptions(undefined as unknown as string)).toEqual([]);
  });
  it('is bounded: an option with a huge name is dropped, not read whole', () => {
    expect(parseZoneOptions(`<option value='ABC01'>${'x'.repeat(100000)}</option>`)).toEqual([]);
  });
});

describe('JAKIM zone snapshot', () => {
  it('matches the saved page, with a state and centre for every zone', () => {
    const fromPage = parseZoneOptions(page).map((z) => z.code);
    expect(JAKIM_ZONES.map((z) => z.code)).toEqual(fromPage);
    expect(JAKIM_STATES.SGR).toBe('Selangor');
    for (const z of JAKIM_ZONES) {
      expect(JAKIM_STATES[z.code.slice(0, 3)], z.code).toBe(z.state);
      expect(typeof z.lat, z.code).toBe('number');
      expect(z.lat!).toBeGreaterThan(0);
      expect(z.lat!).toBeLessThan(8);
      expect(z.lon!).toBeGreaterThan(98);
      expect(z.lon!).toBeLessThan(120);
    }
  });
});
