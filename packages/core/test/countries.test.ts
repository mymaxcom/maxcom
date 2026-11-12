import { describe, expect, it } from 'vitest';
import { COUNTRIES, countryTimezones, isCountryCode } from '../src/index.ts';

describe('country table', () => {
  it('has unique ISO codes and at least one zone each', () => {
    const codes = COUNTRIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.length).toBeGreaterThan(240);
    for (const c of COUNTRIES) expect(c.timezones.length, c.code).toBeGreaterThan(0);
  });
  it('every listed zone is one Node knows', () => {
    // supportedValuesOf lists canonical names only; the formatter also accepts the old aliases (America/Argentina/...).
    for (const c of COUNTRIES) {
      for (const z of c.timezones) {
        expect(() => new Intl.DateTimeFormat('en', { timeZone: z }), `${c.code} ${z}`).not.toThrow();
      }
    }
  });
  it('helpers', () => {
    expect(isCountryCode('MY')).toBe(true);
    expect(isCountryCode('XX')).toBe(false);
    expect(isCountryCode(5)).toBe(false);
    expect(countryTimezones('KE')).toEqual(['Africa/Nairobi']);
    expect(countryTimezones('XX')).toEqual(['UTC']);
  });
});
