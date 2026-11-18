import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loginAs, TEST_PIN } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeApp(): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-k2b-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'), { dataDir: dir });
  apps.push(app);
  return app;
}

/** The real unlock handshake with a nonce asked for before the revoke (so the unlock itself meets the revoked device). */
async function unlockAfter(app: FastifyInstance, l: Login, revoke: () => void): Promise<{ status: number; code?: string }> {
  const ch = await app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress: '10.88.1.1', payload: { deviceId: l.deviceId } });
  const nonce = String(ch.json().nonce);
  revoke();
  const message = new TextEncoder().encode(`surau-unlock\n${app.surau.boxId}\n${l.deviceId}\n${nonce}`);
  const signature = await l.sign(message);
  const r = await app.inject({ method: 'POST', url: '/api/auth/unlock', remoteAddress: '10.88.1.1', payload: { deviceId: l.deviceId, nonce, signature, pin: TEST_PIN } });
  return { status: r.statusCode, code: r.json().code as string | undefined };
}

describe('[K2b] a revoked device always hears device_revoked', () => {
  it('[K2b] pull, push and any session route from a revoked device answer 401 device_revoked', async () => {
    const app = makeApp();
    const ajk = await loginAs(app, 'ajk');
    app.surau.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), ajk.deviceId);
    for (const [method, url, payload] of [
      ['GET', '/api/sync/changes?since=0', undefined],
      ['GET', '/api/sync/snapshot', undefined],
      ['POST', '/api/sync/ops', { ops: [] }],
      ['GET', '/api/auth/me', undefined],
    ] as const) {
      const r = await app.inject({ method, url, headers: ajk.headers, ...(payload !== undefined ? { payload } : {}) });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
      expect(r.json().code, `${method} ${url}`).toBe('device_revoked');
    }
  });

  it('[K2b] a challenge and an unlock from a revoked device answer device_revoked', async () => {
    const app = makeApp();
    const ajk = await loginAs(app, 'ajk');
    const revoke = (): void => void app.surau.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), ajk.deviceId);
    expect(await unlockAfter(app, ajk, revoke)).toEqual({ status: 401, code: 'device_revoked' });
    const ch = await app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress: '10.88.1.2', payload: { deviceId: ajk.deviceId } });
    expect(ch.statusCode).toBe(401);
    expect(ch.json().code).toBe('device_revoked');
  });

  it('[K2b] a device of a deleted person gets device_revoked on pull, push, any session route and unlock', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const r = app.surau.db.prepare('SELECT no FROM users WHERE id = ?').get(ajk.userId);
    const del = await app.inject({ method: 'POST', url: `/api/users/${ajk.userId}/delete`, headers: admin.headers, payload: { ref: `U-${String(r?.no).padStart(4, '0')}` } });
    expect(del.statusCode, del.body).toBe(200);
    for (const [method, url, payload] of [
      ['GET', '/api/sync/changes?since=0', undefined],
      ['POST', '/api/sync/ops', { ops: [] }],
      ['GET', '/api/auth/me', undefined],
    ] as const) {
      const res = await app.inject({ method, url, headers: ajk.headers, ...(payload !== undefined ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json().code, `${method} ${url}`).toBe('device_revoked');
    }
    const ch = await app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress: '10.88.1.9', payload: { deviceId: ajk.deviceId } });
    expect(ch.statusCode).toBe(401);
    expect(ch.json().code).toBe('device_revoked');
  });

  it('[K2b] a normal expired session keeps its old answer (401, no device_revoked)', async () => {
    const app = makeApp();
    const ajk = await loginAs(app, 'ajk');
    app.surau.db.prepare('UPDATE sessions SET expires_at = ? WHERE device_id = ?').run(new Date(Date.now() - 1000).toISOString(), ajk.deviceId);
    const r = await app.inject({ method: 'GET', url: '/api/auth/me', headers: ajk.headers });
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBeUndefined();
    const unknown = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: 'Bearer not-a-session' } });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().code).toBeUndefined();
  });

  it('[K2b] a live device is untouched', async () => {
    const app = makeApp();
    const ajk = await loginAs(app, 'ajk');
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: ajk.headers })).statusCode).toBe(200);
  });
});
