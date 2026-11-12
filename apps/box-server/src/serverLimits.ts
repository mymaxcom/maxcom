import type http from 'node:http';
import type https from 'node:https';

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
}
