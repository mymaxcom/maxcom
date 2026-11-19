import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { exemptFromRequestTimeout } from '../serverLimits.ts';
import { dropFreshVideo, receiveVideo, videoStorage, VideoError } from './video.ts';
import type { FreeBytes, ReceiveVideoOptions, VideoLimits } from './video.ts';

export interface VideoRouteDeps {
  db: DatabaseSync;
  dataDir: string;
  actorOf: (request: FastifyRequest) => string;
  /** Test hooks: the free-space reading and the limits, and the upload's deadline and minimum rate. */
  free?: FreeBytes;
  limits?: VideoLimits;
  receive?: Pick<ReceiveVideoOptions, 'deadlineMs' | 'minRate' | 'rateCheckMs'>;
}

/**
 * `POST /api/assets/video` (the raw MP4 as the body, `Content-Type: video/mp4`, `Content-Length` required),
 * `GET /api/assets/video/storage` (the room left for videos) and `DELETE /api/assets/video/:id` (the editor gives up a
 * fresh pick). Box only: a video is never uploaded to the cloud. The body is a stream, never buffered. The answer of a
 * refusal is `{ errors, code }` with a code of VIDEO_ERROR_CODES.
 */
export function registerVideoRoutes(app: FastifyInstance, deps: VideoRouteDeps): void {
  const { db, dataDir } = deps;
  void app.register(async (scope) => {
    // The raw stream is handed to the handler as the body (no buffering, no parser limit: the handler enforces its own).
    scope.addContentTypeParser('video/mp4', (_request, payload, done) => done(null, payload));

    scope.post('/api/assets/video', async (request, reply) => {
      const len = request.headers['content-length'];
      const declared = typeof len === 'string' && /^\d{1,12}$/.test(len) ? Number(len) : null;
      // this request only: the server-wide 30 s limit is replaced by the upload's own deadline and minimum rate
      const restore = exemptFromRequestTimeout(request.raw.socket);
      try {
        const body = request.body as NodeJS.ReadableStream & { pipe?: unknown };
        if (typeof body?.pipe !== 'function') {
          return reply.code(400).send({ errors: ['body must be the raw MP4 with Content-Type video/mp4'], code: 'upload_failed' });
        }
        const meta = await receiveVideo(db, dataDir, request.body as never, declared, deps.actorOf(request), {
          ...(deps.free ? { free: deps.free } : {}),
          ...(deps.limits ? { limits: deps.limits } : {}),
          ...(deps.receive ?? {}),
        });
        return reply.code(meta.created ? 201 : 200).send(meta);
      } catch (error) {
        if (error instanceof VideoError) {
          // The body may be unread (an early refusal): close the connection so the rest is not read for nothing.
          return reply.code(error.status).header('Connection', 'close').send({ errors: error.errors, code: error.code });
        }
        throw error;
      } finally {
        restore();
      }
    });

    scope.get('/api/assets/video/storage', async (_request, reply) => {
      return reply.header('Cache-Control', 'no-store').send(videoStorage(db, dataDir, deps.free, deps.limits));
    });

    // The editor replaced or cancelled its pick: the video goes when nothing uses it and it is less than a day old.
    scope.delete('/api/assets/video/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      const out = dropFreshVideo(db, dataDir, id);
      if (!out.found) return reply.code(404).header('Cache-Control', 'no-store').send({ errors: ['video not found'], code: 'not_found' });
      return reply.header('Cache-Control', 'no-store').send({ removed: out.removed });
    });
  });
}
