import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getAssetPath } from './assets/store.ts';
import { resolveImageId } from './imageAdjust.ts';
import type { ImageSlotKey } from '@surau/core';
import { decodeImage, renderIcon } from './imageResize.ts';
import type { IconKind, Rgba } from './imageResize.ts';
import { getSettings } from './settingsStore.ts';
import { NEUTRAL_SURAU_ID, publicSurauOf } from './reqSurau.ts';

/** The app icon files the Flutter web build references, with the size and kind each one is made at. */
export const APP_ICONS: Readonly<Record<string, { size: number; kind: IconKind }>> = {
  'favicon.png': { size: 32, kind: 'any' },
  'icons/Icon-192.png': { size: 192, kind: 'any' },
  'icons/Icon-512.png': { size: 512, kind: 'any' },
  'icons/Icon-maskable-192.png': { size: 192, kind: 'maskable' },
  'icons/Icon-maskable-512.png': { size: 512, kind: 'maskable' },
};

const SHORT_NAME_MAX = 12;

/**
 * The asset to show for the logo when one is set and the file exists and is a PNG or JPEG, else
 * null. `logo` is the wide picture (natural shape); `logoSquare` the square one for the icons.
 * With an adjusted logo these are the derived pictures, otherwise the uploaded file.
 */
function currentLogo(
  db: DatabaseSync,
  dataDir: string,
  surauId: string,
  slot: Extract<ImageSlotKey, 'logo' | 'logoSquare'> = 'logo',
): { id: string; path: string; mime: string } | null {
  const ref = getSettings(db, surauId).surauInfo.logo;
  if (ref === '') return null;
  const id = resolveImageId(db, dataDir, slot, ref, surauId);
  const found = getAssetPath(db, dataDir, id);
  if (found === null || (found.mime !== 'image/png' && found.mime !== 'image/jpeg')) return null;
  return { id, ...found };
}

/** `?v=` value the kiosk and app put on the logo URL so a changed logo is fetched at once. */
export const logoVersion = (assetId: string): string => assetId.slice(0, 16);

/** Asset id of the wide logo the kiosk should load (`/assets/<id>`), or '' when none is set. */
export function kioskLogoAssetId(db: DatabaseSync, dataDir: string, surauId: string): string {
  return currentLogo(db, dataDir, surauId)?.id ?? '';
}

/** Public URL of the logo, or null when none is set. Used by the kiosk bundle and /api/surau/info. */
export function surauLogoUrl(db: DatabaseSync, dataDir: string, surauId: string): string | null {
  const logo = currentLogo(db, dataDir, surauId);
  return logo === null ? null : `/surau-logo?v=${logoVersion(logo.id)}`;
}

/** Manifest short name: the full name when short enough, else as many whole words as fit in 12 characters. */
export function shortNameOf(name: string): string {
  const n = name.trim();
  if (n.length <= SHORT_NAME_MAX) return n;
  let out = '';
  for (const word of n.split(/\s+/)) {
    const next = out === '' ? word : `${out} ${word}`;
    if (next.length > SHORT_NAME_MAX) break;
    out = next;
  }
  return out !== '' ? out : n.slice(0, SHORT_NAME_MAX);
}

/** Home-screen title: the stored short name when set, else the automatic short form of the name, else ''. */
export function homeScreenName(db: DatabaseSync, surauId: string): string {
  const info = getSettings(db, surauId).surauInfo;
  const stored = info.shortName.trim();
  return stored !== '' ? stored : shortNameOf(info.name);
}

const escapeHtml = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Set the iPad home-screen title (apple-mobile-web-app-title) and the page title; no short name: the html as built. */
export function withHomeScreenName(html: string, short: string): string {
  if (short === '') return html;
  const safe = escapeHtml(short);
  return html
    .replace(/(<meta\s+name="apple-mobile-web-app-title"\s+content=")[^"]*(")/i, (_m, a: string, b: string) => `${a}${safe}${b}`)
    .replace(/(<title>)[^<]*(<\/title>)/i, (_m, a: string, b: string) => `${a}${safe}${b}`);
}

const etagOf = (...parts: (string | number)[]): string =>
  `"${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32)}"`;

function notModified(request: FastifyRequest, etag: string): boolean {
  const inm = request.headers['if-none-match'];
  return typeof inm === 'string' && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
}

export interface SurauLogoDeps {
  db: DatabaseSync;
  dataDir: string;
  /** Built Flutter web app folder, or null when the app is not served. */
  appDir: string | null;
  role: 'box' | 'cloud';
}

/**
 * Public (no sign-in, like the kiosk bundle) routes for the surau logo:
 * `GET /surau-logo` and, when the web app is served, the dynamic `/app/manifest.json` plus the
 * icon files the app references (made from the logo, or the bundled files when none is set).
 */
export function registerSurauLogoRoutes(app: FastifyInstance, deps: SurauLogoDeps): void {
  const { db, dataDir, appDir } = deps;
  const role = deps.role;

  app.get('/surau-logo', async (request, reply) => {
    // Public: a box serves its own logo; the cloud the logo of the linked box named by `X-Maxcom-Box`, else none.
    const target = publicSurauOf(db, request, role);
    const logo = currentLogo(db, dataDir, target ?? NEUTRAL_SURAU_ID);
    if (target === null || logo === null) return reply.code(404).header('Cache-Control', 'no-store').send({ errors: ['not found'] });
    const etag = etagOf('logo', logo.id);
    reply.header('ETag', etag).header('X-Content-Type-Options', 'nosniff');
    // The URL handed out carries ?v=<id>, so that exact URL never changes meaning and may be kept;
    // the bare URL is revalidated every time (a cheap 304 while the logo is the same).
    const v = (request.query as { v?: unknown } | undefined)?.v;
    reply.header(
      'Cache-Control',
      v === logoVersion(logo.id) ? 'public, max-age=31536000, immutable' : 'no-cache',
    );
    if (notModified(request, etag)) return reply.code(304).send();
    return reply.header('Content-Type', logo.mime).send(createReadStream(logo.path));
  });

  if (appDir === null) return;

  // Decoded logo and rendered icons are kept for the current logo only (a handful of small PNGs).
  let cache: { id: string; rgba: Rgba | null; icons: Map<string, Buffer> } | null = null;
  const cacheFor = (id: string, path: string): { rgba: Rgba | null; icons: Map<string, Buffer> } => {
    if (cache === null || cache.id !== id) {
      let rgba: Rgba | null = null;
      try {
        rgba = decodeImage(readFileSync(path));
      } catch {
        rgba = null; // a logo that cannot be decoded falls back to the bundled icons
      }
      cache = { id, rgba, icons: new Map() };
    }
    return cache;
  };

  const sendFile = (request: FastifyRequest, reply: FastifyReply, body: Buffer, etag: string, type: string): FastifyReply => {
    // Same policy as the rest of /app/: always revalidate (file names are not content-hashed).
    reply.header('ETag', etag).header('Cache-Control', 'no-cache').header('X-Content-Type-Options', 'nosniff');
    if (notModified(request, etag)) return reply.code(304).send();
    return reply.header('Content-Type', type).send(body);
  };

  for (const [name, spec] of Object.entries(APP_ICONS)) {
    app.get(`/app/${name}`, async (request, reply) => {
      const logo = currentLogo(db, dataDir, publicSurauOf(db, request, role) ?? NEUTRAL_SURAU_ID, 'logoSquare');
      if (logo !== null) {
        const c = cacheFor(logo.id, logo.path);
        if (c.rgba !== null) {
          let png = c.icons.get(name);
          if (png === undefined) {
            png = renderIcon(c.rgba, spec.size, spec.kind);
            c.icons.set(name, png);
          }
          return sendFile(request, reply, png, etagOf('icon', logo.id, name), 'image/png');
        }
      }
      const bundled = join(appDir, name);
      if (!existsSync(bundled)) return reply.code(404).send({ errors: ['not found'] });
      const body = readFileSync(bundled);
      return sendFile(request, reply, body, etagOf('bundled', name, createHash('sha256').update(body).digest('hex')), 'image/png');
    });
  }

  for (const route of ['/app/', '/app/index.html']) {
    app.get(route, async (request, reply) => {
      const file = join(appDir, 'index.html');
      if (!existsSync(file)) return reply.code(404).send({ errors: ['not found'] });
      reply.header('Last-Modified', statSync(file).mtime.toUTCString());
      const body = Buffer.from(withHomeScreenName(readFileSync(file, 'utf8'), ((sid) => (sid === null ? '' : homeScreenName(db, sid)))(publicSurauOf(db, request, role))), 'utf8');
      return sendFile(request, reply, body, etagOf('index', createHash('sha256').update(body).digest('hex')), 'text/html; charset=utf-8');
    });
  }

  app.get('/app/manifest.json', async (request, reply) => {
    const file = join(appDir, 'manifest.json');
    if (!existsSync(file)) return reply.code(404).send({ errors: ['not found'] });
    let manifest: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      manifest = parsed as Record<string, unknown>;
    } catch {
      return reply.code(404).send({ errors: ['not found'] });
    }
    const sid = publicSurauOf(db, request, role);
    const name = sid === null ? '' : getSettings(db, sid).surauInfo.name.trim();
    if (name !== '') manifest.name = name;
    const short = sid === null ? '' : homeScreenName(db, sid);
    if (short !== '') manifest.short_name = short;
    const body = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    const logo = currentLogo(db, dataDir, publicSurauOf(db, request, role) ?? NEUTRAL_SURAU_ID, 'logoSquare');
    return sendFile(
      request,
      reply,
      body,
      etagOf('manifest', createHash('sha256').update(body).digest('hex'), logo?.id ?? ''),
      'application/manifest+json; charset=utf-8',
    );
  });
}
