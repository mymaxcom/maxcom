import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

/**
 * CSP for the Flutter web build under /app/. CanvasKit needs `wasm-unsafe-eval`; everything else
 * stays on the box's own origin (no CDN: the iPad may be offline). `frame-src 'self'` lets the
 * preview screen load the kiosk page. It replaces the kiosk page CSP on /app/* responses; the two
 * are never sent together.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  // image_picker on web reads the picked file through a same-origin blob: URL (fetch).
  "connect-src 'self' blob:",
  "worker-src 'self'",
  "font-src 'self' data:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** The app CSP with extra `connect-src` origins (the cloud the web shell syncs with). Only plain https origins are added. */
export function appCsp(extraConnect: readonly string[] = []): string {
  const extra = extraConnect.filter((o) => /^https:\/\/[A-Za-z0-9.[\]:-]+$/.test(o));
  return extra.length === 0 ? APP_CSP : APP_CSP.replace("connect-src 'self' blob:", `connect-src 'self' blob: ${extra.join(' ')}`);
}

export function isAppPath(path: string): boolean {
  return path === '/app' || path.startsWith('/app/');
}

/** Second static root: the web build at /app/. Call after registerSecurityHeaders. */
export function registerAppStatic(app: FastifyInstance, appDir: string, connectOrigins: () => readonly string[] = () => []): void {
  app.get('/app', (_request, reply) => reply.redirect('/app/', 301));
  app.register(fastifyStatic, {
    root: appDir,
    prefix: '/app/',
    decorateReply: false,
    index: ['index.html'],
    // Flutter web file names (main.dart.js, assets/, canvaskit/, flutter.js, icons) are not
    // content-hashed, so every file is revalidated: ETag/Last-Modified give a cheap 304 and an
    // update is never hidden behind a long-lived cache entry.
    etag: true,
    lastModified: true,
    cacheControl: false,
    setHeaders: (res) => {
      res.header('Cache-Control', 'no-cache');
    },
  });
  // Runs after the global security-header hook, so this replaces (never adds to) its CSP.
  app.addHook('onSend', async (request, reply, payload) => {
    const path = (request.raw.url ?? '').split('?')[0] ?? '';
    if (isAppPath(path)) reply.header('Content-Security-Policy', appCsp(connectOrigins()));
    return payload;
  });
}
