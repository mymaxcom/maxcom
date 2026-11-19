import type http from 'node:http';
import type https from 'node:https';
import type { Socket } from 'node:net';

/** A client must finish its headers in 10 s, its whole request in 30 s, and may sit idle for 60 s. */
export const HEADERS_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 30_000;
export const IDLE_TIMEOUT_MS = 60_000;
/** Node only enforces the two limits above every this-many ms (default 30 s). */
const CHECK_INTERVAL_MS = 2_000;

/** Apply the slow-client limits to a listener (the HTTP loopback one and the HTTPS LAN one). */
export function hardenServer(server: http.Server | https.Server): void {
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  (server as { connectionsCheckingInterval?: number }).connectionsCheckingInterval = CHECK_INTERVAL_MS;
  server.setTimeout(IDLE_TIMEOUT_MS);
  guardClientErrors(server);
}

/** Sockets whose current request is a long upload with its own deadline (see `exemptFromRequestTimeout`). */
const exempt = new WeakSet<object>();
const guarded = new WeakSet<object>();

type ClientErrorListener = (this: unknown, err: Error & { code?: string }, socket: Socket) => void;

/** Node's own answer to a client error when no listener is installed (it writes a short response and closes). */
function nodeDefault(err: Error & { code?: string }, socket: Socket): void {
  if (socket.writable && socket.bytesWritten === 0) {
    const line =
      err.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large'
        : err.code === 'HPE_CHUNK_EXTENSIONS_OVERFLOW' ? '413 Payload Too Large'
          : err.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? '408 Request Timeout'
            : '400 Bad Request';
    socket.write(`HTTP/1.1 ${line}\r\nConnection: close\r\n\r\n`);
  }
  socket.destroy(err);
}

/**
 * Puts one gate in front of the server's client-error handling (Fastify's listener, or Node's default when there is
 * none): the whole-request time limit is not applied to a socket whose current request is exempt. Every other client
 * error, and the time limit of every other request, is handled exactly as before. Installed once per server.
 */
function guardClientErrors(server: http.Server | https.Server): void {
  if (guarded.has(server)) return;
  guarded.add(server);
  const prior = server.listeners('clientError') as ClientErrorListener[];
  server.removeAllListeners('clientError');
  server.on('clientError', function (this: unknown, err: Error & { code?: string }, socket: Socket) {
    if (err?.code === 'ERR_HTTP_REQUEST_TIMEOUT' && exempt.has(socket)) return;
    if (prior.length === 0) {
      nodeDefault(err, socket);
      return;
    }
    for (const l of prior) l.call(this, err, socket);
  });
}

/**
 * Exempts the request now running on `socket` from the server-wide whole-request limit (30 s) while a long upload (a
 * video, up to 300 MB over the surau Wi-Fi) is received. The caller enforces its own deadline and minimum rate; the
 * header limit and the idle limit stay on, and the server's own limit is never changed, so every other request and
 * every later request on the same connection keep it. Returns the function that ends the exemption (call it in
 * `finally`).
 */
export function exemptFromRequestTimeout(socket: unknown): () => void {
  if (typeof socket !== 'object' || socket === null) return () => undefined;
  exempt.add(socket);
  return () => {
    exempt.delete(socket);
  };
}
