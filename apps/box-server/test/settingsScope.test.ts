import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loginAs } from './authHelpers.ts';
import { signOp } from './support/signOp.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeApp(): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-scope-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'), { dataDir: dir });
  apps.push(app);
  return app;
}

const put = (app: FastifyInstance, headers: Record<string, string>, feature: string, payload: unknown) =>
  app.inject({ method: 'PUT', url: `/api/settings/${feature}`, headers, payload: payload as object });

const forbiddenRows = (app: FastifyInstance): number =>
  Number(app.surau.db.prepare("SELECT COUNT(*) AS n FROM auth_log WHERE event = 'forbidden' AND detail = 'system_write' AND ok = 0").get()?.n ?? 0);

describe('system settings need system:write on the settings route', () => {
  it('refuses a Lanjutan field to a Pentadbir Surau, logs it once and leaves the row alone', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const before = (await app.inject({ method: 'GET', url: '/api/settings', headers: admin.headers })).json().liveYoutube;
    const r = await put(app, admin.headers, 'liveYoutube', { relayVideo: 'reencode' });
    expect(r.statusCode).toBe(403);
    expect(forbiddenRows(app)).toBe(1);
    const row = app.surau.db.prepare("SELECT user_id, device_id FROM auth_log WHERE event = 'forbidden'").get();
    expect(row).toMatchObject({ user_id: admin.userId, device_id: admin.deviceId });
    const after = (await app.inject({ method: 'GET', url: '/api/settings', headers: admin.headers })).json().liveYoutube;
    expect(after).toEqual(before);
    expect(after.relayVideo).toBe('copy');
  });

  it('lets the Pentadbir MAXCOM write it, and an admin still writes the other fields of the same feature', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const sup = await loginAs(app, 'superadmin');
    expect((await put(app, sup.headers, 'liveYoutube', { relayVideo: 'reencode', maxBitrateKbps: 3000 })).statusCode).toBe(200);
    const s = (await app.inject({ method: 'GET', url: '/api/settings', headers: admin.headers })).json().liveYoutube;
    expect(s).toMatchObject({ relayVideo: 'reencode', maxBitrateKbps: 3000 });
    expect((await put(app, admin.headers, 'liveYoutube', { privacy: 'public' })).statusCode).toBe(200);
    // one system key hidden in an otherwise ordinary patch refuses the whole patch
    const mixed = await put(app, admin.headers, 'liveYoutube', { privacy: 'private', maxBitrateKbps: 2000 });
    expect(mixed.statusCode).toBe(403);
    const again = (await app.inject({ method: 'GET', url: '/api/settings', headers: admin.headers })).json().liveYoutube;
    expect(again).toMatchObject({ privacy: 'public', maxBitrateKbps: 3000 });
  });

  it('the system feature, cloud sync, the data sources and the tilawah disk budget', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const sup = await loginAs(app, 'superadmin');
    expect((await put(app, admin.headers, 'system', { noVideoSeconds: 30 })).statusCode).toBe(403);
    expect((await put(app, admin.headers, 'cloudSync', { enabled: false })).statusCode).toBe(403);
    expect((await put(app, admin.headers, 'dataSources', { esolat: { name: 'x' } })).statusCode).toBe(403);
    expect((await put(app, admin.headers, 'tilawah', { cacheMaxMb: 500 })).statusCode).toBe(403);
    expect((await put(app, admin.headers, 'tilawah', { volume: 50 })).statusCode).toBe(200);
    expect(forbiddenRows(app)).toBe(4);
    expect((await put(app, sup.headers, 'system', { noVideoSeconds: 30 })).statusCode).toBe(200);
    expect((await put(app, sup.headers, 'cloudSync', { enabled: false })).statusCode).toBe(200);
    expect((await put(app, sup.headers, 'tilawah', { cacheMaxMb: 500 })).statusCode).toBe(200);
    const s = (await app.inject({ method: 'GET', url: '/api/settings', headers: admin.headers })).json();
    expect(s.system.noVideoSeconds).toBe(30);
    expect(s.cloudSync.enabled).toBe(false);
    // a bad value is still a 400 for the Pentadbir MAXCOM
    expect((await put(app, sup.headers, 'system', { syncHistoryDays: 90 })).statusCode).toBe(400);
  });

  it('a signed settings.put on a system feature is refused for an admin device and applied for the Pentadbir MAXCOM', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const sup = await loginAs(app, 'superadmin');
    const send = async (login: typeof admin, entityId: string, payload: unknown) => {
      const op = await signOp(login, app.surau.boxId, { kind: 'settings.put', entity: 'settings', entityId, payload, editedAt: new Date().toISOString() });
      const r = await app.inject({ method: 'POST', url: '/api/sync/ops', headers: login.headers, payload: { ops: [op] } });
      return r.json().results[0] as { status: string; reason: string | null };
    };
    const refused = await send(admin, 'system', { noVideoSeconds: 40 });
    expect(refused).toMatchObject({ status: 'refused', reason: 'forbidden' });
    expect(Number(app.surau.db.prepare("SELECT COUNT(*) AS n FROM auth_log WHERE event = 'sync_refused' AND detail = 'system_write'").get()?.n)).toBe(1);
    expect((await send(admin, 'liveYoutube', { relayVideo: 'reencode' }))).toMatchObject({ status: 'refused', reason: 'forbidden' });
    expect((await send(admin, 'liveYoutube', { privacy: 'public' })).status).toBe('applied');
    expect((await send(sup, 'system', { noVideoSeconds: 40 })).status).toBe('applied');
    const s = (await app.inject({ method: 'GET', url: '/api/settings', headers: admin.headers })).json();
    expect(s.system.noVideoSeconds).toBe(40);
    expect(s.liveYoutube.relayVideo).toBe('copy');
  });
});
