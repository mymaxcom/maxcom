import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { analyzeImage } from '../imageAdjust.ts';
import { decodeImage } from '../imageResize.ts';
import { AssetError, getAssetPath, isAssetId, listAudioAssets, listImageAssets } from './store.ts';
import { putSurauAsset, StorageFullError, surauHoldsAsset } from '../surau/storage.ts';
import { reqSurau } from '../reqSurau.ts';
import { VIDEO_MIME } from '@surau/core';
import { serveVideo } from './videoServe.ts';

const UPLOAD_LIMIT = 20 * 1024 * 1024;

export interface AssetRouteDeps {
  db: DatabaseSync;
  dataDir: string;
  actorOf: (request: FastifyRequest) => string;
  /** On the cloud the list and the analyze read are limited to the request's surau (`surau_assets`). Default box. */
  role?: 'box' | 'cloud';
}

/** `POST /api/assets` (raw body) and `GET /assets/:id`. Parsers live in an encapsulated scope. */
export function registerAssetRoutes(app: FastifyInstance, deps: AssetRouteDeps): void {
  const { db, dataDir } = deps;
  const role = deps.role ?? 'box';
  // The surau a listing is limited to: on the cloud the request's own; on a box every asset is the surau's.
  const holderOf = (request: FastifyRequest): string | null => (role === 'cloud' ? reqSurau(request) : null);

  void app.register(async (scope) => {
    scope.addContentTypeParser(
      ['image/jpeg', 'image/png', 'image/webp', 'audio/mpeg'],
      { parseAs: 'buffer', bodyLimit: UPLOAD_LIMIT },
      (_request, body, done) => done(null, body),
    );

    scope.post('/api/assets', { bodyLimit: UPLOAD_LIMIT }, async (request, reply) => {
      const body: unknown = request.body;
      if (!Buffer.isBuffer(body)) {
        return reply.code(400).send({ errors: ['body must be the raw file with an image/jpeg, image/png, image/webp or audio/mpeg Content-Type'] });
      }
      try {
        // counted against the request's surau (decision 24): no limit on a box, 413 storage_full when a surau is full
        const meta = putSurauAsset(db, dataDir, body, request.headers['content-type'] ?? '', deps.actorOf(request), reqSurau(request));
        return reply
          .code(meta.created ? 201 : 200)
          .send({ id: meta.id, mime: meta.mime, bytes: meta.bytes, width: meta.width, height: meta.height });
      } catch (error) {
        if (error instanceof StorageFullError) return reply.code(413).send({ errors: error.errors, code: error.code });
        if (error instanceof AssetError) return reply.code(error.status).send({ errors: error.errors });
        throw error;
      }
    });

    // The pictures on the box, for the backgrounds picker. Ids only; never paths or file names.
    // `?mime=audio/mpeg` lists the MP3 files instead (the first-azan picker); any other filter is refused.
    scope.get('/api/assets', async (request, reply) => {
      const mime = (request.query as { mime?: unknown }).mime;
      if (mime === undefined) return reply.header('Cache-Control', 'no-store').send(listImageAssets(db, holderOf(request)));
      if (mime !== 'audio/mpeg') return reply.code(400).send({ errors: ['mime must be audio/mpeg'] });
      return reply.header('Cache-Control', 'no-store').send(listAudioAssets(db, holderOf(request)));
    });

    // What the adjust screen needs to start: size, the tight trim box and the detected background.
    scope.get('/api/assets/:id(^[0-9a-f]{64}$)/analyze', async (request, reply) => {
      const { id } = request.params as { id: string };
      // on the cloud only an asset the request's surau holds: another surau's hash is "not found", same as unknown
      if (!surauHoldsAsset(db, role, reqSurau(request), id)) return reply.code(404).send({ errors: ['not found'] });
      const found = getAssetPath(db, dataDir, id);
      if (found === null) return reply.code(404).send({ errors: ['not found'] });
      if (found.mime !== 'image/png' && found.mime !== 'image/jpeg') {
        return reply.code(400).send({ errors: ['only a PNG or JPEG picture can be adjusted'] });
      }
      try {
        const analysis = analyzeImage(decodeImage(readFileSync(found.path)));
        return reply.header('Cache-Control', 'no-store').send(analysis);
      } catch {
        return reply.code(400).send({ errors: ['the picture could not be read'] });
      }
    });

    scope.get('/assets/:id(^[0-9a-f]{64}$)', async (request, reply) => {
      const { id } = request.params as { id: string };
      // Shape check first: nothing malformed ever reaches the database or the filesystem.
      if (!isAssetId(id)) return reply.code(404).send({ errors: ['not found'] });
      // A linked box (site session) asks "do you have it?" with HEAD (only HEAD; its GET download is unchanged) before it uploads: on the cloud the answer is
      // "no" until ITS surau holds the bytes (`surau_assets`), else it would skip `PUT /api/sync/assets/:id`, the
      // only call that records the hold. Kiosks, devices and users read by id as before.
      if (role === 'cloud' && request.method === 'HEAD' && request.auth?.kind === 'site' && !surauHoldsAsset(db, role, request.auth.surauId, id)) {
        return reply.code(404).send({ errors: ['not found'] });
      }
      const found = getAssetPath(db, dataDir, id);
      if (found === null) return reply.code(404).send({ errors: ['not found'] });
      // A video is read in ranges by the media element: 206 with Content-Range, 416 for a range outside the file.
      if (found.mime === VIDEO_MIME) return serveVideo(request, reply, found.path);
      return reply
        .header('Content-Type', found.mime)
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .header('X-Content-Type-Options', 'nosniff')
        .send(createReadStream(found.path));
    });
  });
}
