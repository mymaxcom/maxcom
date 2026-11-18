/** Plan 14: the cloud answers a minimal public GET /api/box/info so MAXCOM Ops can read its id before it enrols. */
import { webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { expectedBoxId } from '../src/auth/devices.ts';
import { issueOpsEnrolment } from '../src/auth/opsDevice.ts';
import { createUser, serverRoleOf } from '../src/auth/users.ts';
import { TEST_PIN } from './authHelpers.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeApp(role: 'box' | 'cloud'): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-boxinfo-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'), { dataDir: dir, role });
  apps.push(app);
  return app;
}

describe('cloud GET /api/box/info', () => {
  it('answers 200 with the cloud boxId, no-store and only public fields', async () => {
    const app = makeApp('cloud');
    const res = await app.inject({ method: 'GET', url: '/api/box/info', remoteAddress: '10.9.9.9' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['boxId', 'role', 'serverTime', 'version']);
    expect(body.role).toBe('cloud');
    expect(typeof body.boxId).toBe('string');
    expect(body.boxId).toMatch(/^[0-9a-f]{16}$/);
    expect(body.boxId.length).toBeGreaterThan(0);
    expect(res.body).not.toMatch(/keyFp|pub|caSha256|nonce|qr/i);
  });

  it('does not register the box state routes on the cloud', async () => {
    const app = makeApp('cloud');
    for (const url of ['/api/box/state', '/api/box/netcheck']) {
      const res = await app.inject({ method: 'GET', url, remoteAddress: '10.9.9.9' });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('the box role still answers its full info', async () => {
    const app = makeApp('box');
    const res = await app.inject({ method: 'GET', url: '/api/box/info', remoteAddress: '10.9.9.9' });
    expect(res.statusCode).toBe(200);
    expect(res.json().keyFp).toEqual(expect.any(String));
    expect(res.json().role).toBeUndefined();
  });

  it('end to end: the id it returns is the one an ops device is verified against, and ops-enrol completes with it', async () => {
    const app = makeApp('cloud');
    const { db } = app.surau;
    const info = (await app.inject({ method: 'GET', url: '/api/box/info', remoteAddress: '10.9.9.9' })).json();
    expect(typeof info.boxId).toBe('string');
    const u = createUser(db, { name: 'Orang Ops', roles: ['ajk'] }, 'test', 'sdm');
    db.prepare('UPDATE users SET roles_json = ? WHERE id = ?').run(JSON.stringify(['admin', 'superadmin']), u.id);
    const { code } = issueOpsEnrolment(db, { userId: u.id, deviceName: 'Telefon Ops' }, 'cli');
    const keys = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
    const jwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
    const res = await app.inject({
      method: 'POST',
      url: '/api/enrol/complete',
      remoteAddress: '10.9.9.10',
      payload: { code, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, platform: 'android', client: 'ops', pin: TEST_PIN },
    });
    expect(res.statusCode, res.body).toBe(200);
    const dev = db.prepare('SELECT * FROM devices WHERE id = ?').get(res.json().deviceId)!;
    expect(Number(dev.ops)).toBe(1);
    expect(dev.surau_id).toBe('*');
    expect(dev.box_id).toBeNull();
    const home = expectedBoxId(db, { boxId: null, surauId: String(dev.surau_id) }, { boxId: info.boxId, role: serverRoleOf(db) });
    expect(home).toBe(info.boxId);
  });
});
