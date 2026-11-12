import { parseJakimApi } from '@surau/core';
import type { PrayerDay } from '@surau/core';
import { readCapped } from './net/readCapped.ts';
import { assertSourceUrl, DEFAULT_SOURCE_URLS } from './net/safeFetch.ts';

const ZONE = /^[A-Z]{3}\d{2}$/;
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 5 * 1024 * 1024;

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

export async function fetchJakimYear(
  zone: string,
  year: number,
  fetchImpl: typeof fetch = fetch,
  /** `dataSources.esolat.url`; the default JAKIM address when absent. */
  baseUrl: string = DEFAULT_SOURCE_URLS.esolat,
): Promise<PrayerDay[]> {
  if (!ZONE.test(zone)) throw new Error(`invalid zone "${zone}"`);
  assertSourceUrl(baseUrl, 'e-Solat');
  const apiUrl = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}period=duration&zone=`;

  // NOTE: the upstream "duration" form (POST datestart/dateend) is unverified against the live
  // e-Solat API; a field test is still to do. The year is requested explicitly so a request made
  // late in the year cannot return the wrong one.
  const response = await fetchImpl(`${apiUrl}${zone}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ datestart: `${year}-01-01`, dateend: `${year}-12-31` }).toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`e-Solat request failed with HTTP ${response.status}`);
  }

  const text = new TextDecoder().decode(await readCapped(response, MAX_BYTES, 'e-Solat response'));
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('e-Solat response is not valid JSON');
  }

  // Measured 2026-11-03: a year JAKIM has not published yet comes back as
  // { status: 'NO_RECORD!', prayerTime: { data: [...] } } with HTTP 200.
  const status = (json as { status?: unknown } | null)?.status;
  if (typeof status === 'string' && status.toUpperCase().startsWith('NO_RECORD')) {
    throw new Error(`e-Solat has not published ${year} prayer times for ${zone} yet; try later or import a CSV`);
  }

  const days = parseJakimApi(json).filter((day) => day.date.startsWith(`${year}-`));
  const expected = isLeapYear(year) ? 366 : 365;
  if (days.length !== expected) {
    throw new Error(
      `e-Solat data incomplete: got ${days.length} days for ${year}, expected ${expected}`,
    );
  }
  return days;
}
