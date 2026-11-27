import { createServer, request } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for the giving box in the store-move tests: a local http server that serves a set of files with `Range`
 * support, and can misbehave on demand (cut the connection, send wrong bytes, answer from another offset, send too
 * much). `fetch` has the shape `pullStore` wants.
 */

export interface GiverRequest {
  path: string;
  range: string | null;
}

export type GiverAction =
  /** Send this many bytes of the answer, wait a moment so the client has stored them, then drop the connection. */
  | { kind: 'cut'; after: number }
  /** Answer with exactly these bytes (same status and headers as an honest answer for the asked range). */
  | { kind: 'bytes'; body: Buffer }
  /** Answer 206 whose Content-Range starts at another offset than the one asked for. */
  | { kind: 'range'; start: number }
  /** Send this many bytes more than the file has. */
  | { kind: 'extra'; extra: number };

export interface Giver {
  requests: GiverRequest[];
  /** Decides what to do with a request; `n` counts the requests for that path so far (0 for the first). Default honest. */
  behave: ((r: GiverRequest, n: number) => GiverAction | undefined) | null;
  fetch(path: string, start: number): Promise<IncomingMessage>;
  close(): Promise<void>;
}

export async function startGiver(files: Map<string, Buffer>): Promise<Giver> {
  const seen = new Map<string, number>();
  const giver: Giver = {
    requests: [],
    behave: null,
    fetch(path, start) {
      return new Promise((resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port, path: `/file?path=${encodeURIComponent(path)}`, headers: start > 0 ? { range: `bytes=${start}-` } : {}, agent: false },
          resolve,
        );
        req.on('error', reject);
        req.end();
      });
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.searchParams.get('path') ?? '';
    const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : null;
    const r: GiverRequest = { path, range: rangeHeader };
    giver.requests.push(r);
    const n = seen.get(path) ?? 0;
    seen.set(path, n + 1);
    const data = files.get(path);
    if (data === undefined) {
      res.writeHead(404).end();
      return;
    }
    const m = rangeHeader === null ? null : /^bytes=(\d+)-$/.exec(rangeHeader);
    const start = m === null ? 0 : Number(m[1]);
    const act = giver.behave?.(r, n);
    let body = data.subarray(start);
    let claimed = start;
    if (act?.kind === 'bytes') body = act.body;
    if (act?.kind === 'range') claimed = act.start;
    const out = act?.kind === 'extra' ? Buffer.concat([body, Buffer.alloc(act.extra, 0x7a)]) : body;
    const headers: Record<string, string> = { 'Content-Length': String(out.length), 'Accept-Ranges': 'bytes' };
    if (m !== null) {
      headers['Content-Range'] = `bytes ${claimed}-${data.length - 1}/${data.length}`;
      res.writeHead(206, headers);
    } else {
      res.writeHead(200, headers);
    }
    if (act?.kind === 'cut') {
      res.write(out.subarray(0, act.after));
      setTimeout(() => req.socket.destroy(), 80);
      return;
    }
    res.end(out);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return giver;
}
