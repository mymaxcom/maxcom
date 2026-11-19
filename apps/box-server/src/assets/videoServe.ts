import { createReadStream, statSync } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** One byte range of `size` from a `Range` header: [start, end] inclusive; 'bad' when it cannot be met; null when absent or not bytes. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'bad' | null {
  if (header === undefined) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null) return null; // not a single byte range: the whole file is sent
  const [, a, b] = m;
  if (a === '' && b === '') return 'bad';
  let start: number;
  let end: number;
  if (a === '') {
    const n = Number(b);
    if (n === 0) return 'bad';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return 'bad';
  return { start, end };
}

/** Sends a stored MP4 with HTTP Range support (206, 416, Accept-Ranges); the same cache and nosniff headers as a picture. */
export function serveVideo(request: FastifyRequest, reply: FastifyReply, path: string): FastifyReply {
  const size = statSync(path).size;
  const range = parseRange(typeof request.headers.range === 'string' ? request.headers.range : undefined, size);
  const base = reply
    .header('Content-Type', 'video/mp4')
    .header('Accept-Ranges', 'bytes')
    .header('Cache-Control', 'public, max-age=31536000, immutable')
    .header('X-Content-Type-Options', 'nosniff');
  if (range === 'bad') return base.code(416).header('Content-Range', `bytes */${size}`).send();
  if (range === null) return base.header('Content-Length', size).send(createReadStream(path));
  return base
    .code(206)
    .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
    .header('Content-Length', range.end - range.start + 1)
    .send(createReadStream(path, { start: range.start, end: range.end }));
}
