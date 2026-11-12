import { webcrypto } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { parseBoxQr } from '@surau/core';
import type { BoxStateView } from '@surau/core';

export const TEST_PIN = '482916';

export interface TestDevice {
  publicJwk: { kty: string | undefined; crv: string | undefined; x: string | undefined; y: string | undefined };
  sign: (message: Uint8Array) => Promise<string>;
}

export async function makeDevice(): Promise<TestDevice> {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
  return {
    publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    sign: async (m) =>
      Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, Buffer.from(m))).toString('base64url'),
  };
}

/** The live QR nonce the box shows on its own screen (loopback), for the type the box is in. */
export async function screenNonce(app: FastifyInstance): Promise<string> {
  const r = await app.inject({ method: 'GET', url: '/api/box/state', remoteAddress: '127.0.0.1' });
  const v = r.json() as BoxStateView;
  if (v.qr === undefined) throw new Error(`no QR on the box screen (state ${v.state})`);
  return parseBoxQr(v.qr.payload).nonce;
}

/** Challenge + unlock with the PIN through the real routes; returns the session token or the failing status. */
export async function unlockWith(
  app: FastifyInstance,
  deviceId: string,
  dev: TestDevice,
  pin: string,
  remoteAddress = '10.50.0.9',
): Promise<{ status: number; token?: string }> {
  const ch = await app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress, payload: { deviceId } });
  if (ch.statusCode !== 200) return { status: ch.statusCode };
  const nonce = String(ch.json().nonce);
  const sig = await dev.sign(new TextEncoder().encode(`surau-unlock\n${app.surau.boxId}\n${deviceId}\n${nonce}`));
  const un = await app.inject({ method: 'POST', url: '/api/auth/unlock', remoteAddress, payload: { deviceId, nonce, signature: sig, pin } });
  return { status: un.statusCode, ...(un.statusCode === 200 ? { token: String(un.json().token) } : {}) };
}

/** Every byte of the database files (main, wal, shm) in a data folder, for "this secret is nowhere on disk" checks. */
export function dbBytes(dir: string): Buffer[] {
  return readdirSync(dir)
    .filter((n) => /\.db(-wal|-shm)?$/.test(n))
    .map((n) => readFileSync(join(dir, n)));
}
