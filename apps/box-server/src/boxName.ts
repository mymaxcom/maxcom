import { isIP } from 'node:net';
import type { TlsMaterial } from './tls.ts';

/** The numbered local name a box claims on its LAN: `box1-surau.local` .. `box99-surau.local`. */
export const BOX_NAME_RE = /^box([1-9][0-9]?)-surau\.local$/;

export function isBoxName(value: string): boolean {
  return BOX_NAME_RE.test(value);
}

/**
 * The box's numbered local name, read from the leaf certificate's DNS names, or null.
 * The legacy `box.surau.local` is never a name: only a root made for the numbered names puts one in the leaf.
 */
export function boxNameOf(tls: TlsMaterial | null): string | null {
  if (tls === null) return null;
  for (const h of tls.dnsSan) {
    const lower = h.toLowerCase();
    if (BOX_NAME_RE.test(lower)) return lower;
  }
  return null;
}

/** The box's LAN IPv4 addresses (certificate IP names, loopback and IPv6 left out). */
export function lanIpv4Of(tls: TlsMaterial | null): string[] {
  if (tls === null) return [];
  return tls.ipSan.filter((a) => isIP(a) === 4 && a !== '127.0.0.1');
}

function originOf(host: string, port: number): string {
  return `https://${isIP(host) === 6 ? `[${host}]` : host}${port === 443 ? '' : `:${port}`}`;
}

/** `https://<name or LAN address>:<port>`: the name first, else the first LAN IP, else any non-loopback DNS name; '' when none. */
export function preferredOrigin(tls: TlsMaterial | null, port: number): string {
  if (tls === null) return '';
  const name = boxNameOf(tls);
  if (name !== null) return originOf(name, port);
  const ip = tls.ipSan.find((a) => a !== '127.0.0.1' && a !== '::1');
  const host = ip ?? tls.dnsSan.find((h) => h !== 'localhost');
  return host === undefined ? '' : originOf(host, port);
}
