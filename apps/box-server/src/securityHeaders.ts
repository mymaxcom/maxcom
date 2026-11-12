import type { FastifyInstance } from 'fastify';

/**
 * Content-Security-Policy for the kiosk page and everything else the box serves. The built page
 * has no inline script, loads its fonts, images and sounds from its own origin (data:/blob: for
 * generated images and audio), talks to the API and the event stream on its own origin, and
 * registers a same-origin service worker. Inline styles are allowed because React writes style
 * attributes. Nothing may frame the page. Only the kiosk page document (KIOSK_CSP) may also POST to a loopback port
 * (the Windows host exit helper); every other answer keeps connect-src 'self'.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** The kiosk page document: the default CSP plus the loopback port of the Windows host exit helper. */
export const KIOSK_CSP = CSP.replace("connect-src 'self'", "connect-src 'self' http://127.0.0.1:*");

const HSTS = 'max-age=31536000';

/** Headers added to every response; HSTS only on an encrypted connection. */
export function securityHeaders(encrypted: boolean): Record<string, string> {
  return {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...(encrypted ? { 'Strict-Transport-Security': HSTS } : {}),
  };
}

/** True when the raw query string carries `preview=1` exactly (not `preview=11`, not `xpreview=1`). */
function wantsPreview(rawUrl: string): boolean {
  const q = rawUrl.indexOf('?');
  if (q < 0) return false;
  return rawUrl.slice(q + 1).split('#')[0]!.split('&').some((pair) => pair === 'preview=1');
}

/**
 * `onSend` hook: security headers everywhere, `no-store` on any `/api` answer that set no cache
 * policy. The kiosk page HTML (a 200 text/html GET outside /api and /app) gets KIOSK_CSP. The one framing relaxation: the kiosk page HTML (a 200 text/html GET outside /api and /app) with
 * `?preview=1` may be framed by its own origin (the app's preview screen); nothing else may.
 */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    const encrypted = (request.raw.socket as { encrypted?: boolean }).encrypted === true;
    for (const [name, value] of Object.entries(securityHeaders(encrypted))) reply.header(name, value);
    const rawUrl = request.raw.url ?? '';
    const path = rawUrl.split('?')[0] ?? '';
    const isGet = request.method === 'GET' || request.method === 'HEAD';
    const outsideApiAndApp = !(path === '/api' || path.startsWith('/api/') || path === '/app' || path.startsWith('/app/'));
    const isHtml = String(reply.getHeader('content-type') ?? '').toLowerCase().startsWith('text/html');
    const kioskDocument = isGet && outsideApiAndApp && reply.statusCode === 200 && isHtml;
    if (kioskDocument) reply.header('Content-Security-Policy', KIOSK_CSP);
    if (kioskDocument && wantsPreview(rawUrl)) {
      reply.header('Content-Security-Policy', KIOSK_CSP.replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
      reply.header('X-Frame-Options', 'SAMEORIGIN');
    }
    if ((path === '/api' || path.startsWith('/api/')) && !reply.hasHeader('cache-control')) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });
}
