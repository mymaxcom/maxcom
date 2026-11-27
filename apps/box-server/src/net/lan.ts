import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

/**
 * "On the surau network, talking to this box directly." SECURITY code: linking and unlinking boxes is allowed only
 * from here, never through the cloud relay, a tunnel or a proxy.
 *
 * True only when the socket's own remote address is a private, link-local or loopback address AND the request
 * carries no header a proxy or tunnel adds. The address is the socket's, never a header's.
 */
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'via', 'cf-ray', 'cf-connecting-ip', 'cdn-loop', 'true-client-ip'];

/** RFC 1918, link-local, loopback, CGNAT is NOT included (a carrier network is not the surau's). */
export function isPrivateAddress(addr: string): boolean {
  let a = addr.trim().toLowerCase();
  const zone = a.indexOf('%');
  if (zone !== -1) a = a.slice(0, zone);
  if (a.startsWith('::ffff:') && isIP(a.slice(7)) === 4) a = a.slice(7);
  const kind = isIP(a);
  if (kind === 4) {
    const p = a.split('.').map((x) => Number.parseInt(x, 10));
    const [x, y] = [p[0]!, p[1]!];
    return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254);
  }
  if (kind === 6) {
    if (a === '::1') return true;
    const first = Number.parseInt(a.split(':')[0] || '0', 16);
    // fc00::/7 unique local, fe80::/10 link-local
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

export function isLanDirect(request: FastifyRequest): boolean {
  const addr = (request.raw.socket as { remoteAddress?: string }).remoteAddress;
  if (typeof addr !== 'string' || !isPrivateAddress(addr)) return false;
  for (const h of PROXY_HEADERS) if (request.headers[h] !== undefined) return false;
  return true;
}
