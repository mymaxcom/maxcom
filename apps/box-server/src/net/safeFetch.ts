import { lookup as dnsLookup } from 'node:dns/promises';
import { FEATURES, isBlockedHost, isBlockedIp, sourceUrlError } from '@surau/core';

export interface SourceUrls {
  esolat: string;
  esolatZones: string;
  nominatim: string;
  quranText: string;
  quranAudio: string;
  hadeethenc: string;
}

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);

export const DEFAULT_SOURCE_URLS: Readonly<SourceUrls> = (() => {
  const d = FEATURES.find((f) => f.key === 'dataSources')?.defaults as Record<string, { url: string }>;
  return { esolat: d.esolat?.url ?? '', esolatZones: d.esolatZones?.url ?? '', nominatim: d.nominatim?.url ?? '', quranText: d.quranText?.url ?? '', quranAudio: d.quranAudio?.url ?? '', hadeethenc: d.hadeethenc?.url ?? '' };
})();

/** Base URLs from the current settings (`settings.dataSources`); a missing or unacceptable one falls back to the default. */
export function sourceUrlsFrom(settings: unknown): SourceUrls {
  const ds = isPlain(settings) && isPlain(settings.dataSources) ? settings.dataSources : {};
  const pick = (k: keyof SourceUrls): string => {
    const entry = ds[k];
    const u = isPlain(entry) ? entry.url : undefined;
    return typeof u === 'string' && sourceUrlError(u) === null ? u : DEFAULT_SOURCE_URLS[k];
  };
  return { esolat: pick('esolat'), esolatZones: pick('esolatZones'), nominatim: pick('nominatim'), quranText: pick('quranText'), quranAudio: pick('quranAudio'), hadeethenc: pick('hadeethenc') };
}

/** Throws when a configured base URL is not an acceptable public https address. */
export function assertSourceUrl(url: string, what: string): void {
  const e = sourceUrlError(url);
  if (e !== null) throw new Error(`${what} address ${e}`);
}

export type HostLookup = (hostname: string) => Promise<string[]>;

const systemLookup: HostLookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/**
 * `fetch` that refuses to contact a private, loopback or link-local destination and refuses every redirect.
 * Before each request the host name is resolved and every returned address must be public.
 *
 * Limit: the check and the connection resolve the name separately (Node's fetch gives no hook to pin the
 * connection to the checked address), so a DNS server that answers differently the second time (rebinding)
 * could still steer one request. For this LAN box the sources are https-only, size-capped and never
 * executed; redirects are refused so a hijacked host cannot bounce the box elsewhere.
 */
export function guardedFetch(inner: typeof fetch = fetch, resolveHost: HostLookup = systemLookup): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error('source address is not a valid URL');
    }
    if (u.protocol !== 'https:') throw new Error('source address must use https');
    if (u.username !== '' || u.password !== '') throw new Error('source address must not contain credentials');
    if (isBlockedHost(u.hostname)) throw new Error('source address is local or private; refused');
    if (!u.hostname.includes(':') && !/^[0-9.]+$/.test(u.hostname)) {
      const addrs = await resolveHost(u.hostname);
      if (addrs.length === 0 || addrs.some((a) => isBlockedIp(a))) {
        throw new Error('source address resolves to a local or private address; refused');
      }
    }
    return inner(input, { ...init, redirect: 'error' });
  }) as typeof fetch;
}
