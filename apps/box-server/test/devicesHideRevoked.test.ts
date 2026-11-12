// A cancelled device is never listed (operator rule 2026-11-06): GET
// /api/devices omits revoked rows, while the box keeps the row, still
// refuses it on unlock and on its existing token.

import { webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { klInstant } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { beginEnrolment } from '../src/auth/devices.ts';
import { createUser } from '../src/auth/users.ts';
import { loginAsAdmin } from './authHelpers.ts';

const AT = klInstant('2026-11-06', '12:00');
const apps: FastifyInstance[] = [];
const dirs: string[] = [];
let n = 0;

function makeApp(): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-hide-revoked-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'), { now: () => AT });
  apps.push(app);
  return app;
}

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function enrolDevice(app: FastifyInstance) {
  const { db, boxId } = app.surau;
  const ip = `10.66.0.${++n}`;
  const user = createUser(db, { name: `Orang ${n}`, roles: ['ajk'] }, 'test');
  const { code } = beginEnrolment(db, { userId: user.id, deviceName: 'Tel' }, 'test');
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
  const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  const res = await app.inject({
    method: 'POST', url: '/api/enrol/complete', remoteAddress: ip,
    payload: { code, publicJwk, platform: 'web' },
  });
  expect(res.statusCode).toBe(200);
  const deviceId = String(res.json().deviceId);
  const challenge = async () => {
    const ch = await app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress: ip, payload: { deviceId } });
    return ch;
  };
  const unlock = async (nonce: string) => {
    const msg = new TextEncoder().encode(`surau-unlock\n${boxId}\n${deviceId}\n${nonce}`);
    const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, msg);
    return app.inject({
      method: 'POST', url: '/api/auth/unlock', remoteAddress: ip,
      payload: { deviceId, nonce, signature: Buffer.from(sig).toString('base64url') },
    });
  };
  return { deviceId, challenge, unlock };
}

const listIds = async (app: FastifyInstance, headers: Record<string, string>): Promise<string[]> => {
  const r = await app.inject({ method: 'GET', url: '/api/devices', headers });
  expect(r.statusCode).toBe(200);
  return (r.json().devices as { id: string }[]).map((d) => d.id);
};

describe('revoked devices are never listed', () => {
  it('revoke, then GET /api/devices no longer contains it; the row is kept', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const d = await enrolDevice(app);
    expect(await listIds(app, admin.headers)).toContain(d.deviceId);
    const rev = await app.inject({ method: 'POST', url: `/api/devices/${d.deviceId}/revoke`, headers: admin.headers, payload: {} });
    expect(rev.statusCode).toBe(200);
    expect(await listIds(app, admin.headers)).not.toContain(d.deviceId);
    expect(await listIds(app, admin.headers)).toContain(admin.deviceId);
    const row = app.surau.db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(d.deviceId);
    expect(row?.revoked_at).not.toBeNull();
  });

  it('a revoked device is still refused on unlock and on its signed challenge', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const d = await enrolDevice(app);
    const nonce = String((await d.challenge()).json().nonce);
    const unlocked = await d.unlock(nonce);
    expect(unlocked.statusCode).toBe(200);
    const token = String(unlocked.json().token);
    const nonce2 = String((await d.challenge()).json().nonce);
    await app.inject({ method: 'POST', url: `/api/devices/${d.deviceId}/revoke`, headers: admin.headers, payload: {} });
    expect((await d.unlock(nonce2)).statusCode).toBe(401);
    expect((await d.challenge()).statusCode).not.toBe(200);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(401);
  });
});
