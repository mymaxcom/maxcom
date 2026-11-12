import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoxStateView } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { issueRecoveryCode } from '../src/setup/codes.ts';
import { loginAs } from './authHelpers.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function make(): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-rcflag-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'surau.db'), { dataDir: dir });
  apps.push(app);
  return app;
}
const screen = (app: FastifyInstance) =>
  app.inject({ method: 'GET', url: '/api/box/state', remoteAddress: '127.0.0.1' }).then((r) => r.json() as BoxStateView);
const loseAdmin = (app: FastifyInstance): void => {
  app.surau.db.prepare("UPDATE devices SET revoked_at = '2026-11-09T09:00:00Z' WHERE platform <> 'kiosk'").run();
};

describe('a box upgraded from before recovery codes', () => {
  it('in recovery with no code: the screen says so and gets no QR', async () => {
    const app = make();
    await loginAs(app, 'admin'); // made without the setup route: no recovery code was ever issued
    loseAdmin(app);
    const v = await screen(app);
    expect(v.state).toBe('recovery');
    expect(v.recoveryCodeSet).toBe(false);
    expect(v.qr).toBeUndefined();
    expect(app.surau.db.prepare("SELECT COUNT(*) AS n FROM box_codes WHERE type = 'recovery'").get()?.n).toBe(0);
  });

  it('with a code on file the screen shows the QR as before', async () => {
    const app = make();
    await loginAs(app, 'admin');
    issueRecoveryCode(app.surau.db);
    loseAdmin(app);
    const v = await screen(app);
    expect(v.recoveryCodeSet).toBe(true);
    expect(v.qr).toBeDefined();
  });

  it('the flag is not on the setup, active or any other caller\'s view', async () => {
    const app = make();
    expect((await screen(app)).recoveryCodeSet).toBeUndefined();
    const admin = await loginAs(app, 'admin');
    expect((await screen(app)).recoveryCodeSet).toBeUndefined();
    loseAdmin(app);
    const lan = await app.inject({ method: 'GET', url: '/api/box/state', remoteAddress: '10.168.1.60', headers: admin.headers });
    expect(lan.json().recoveryCodeSet).toBeUndefined();
    const info = await app.inject({ method: 'GET', url: '/api/box/info', remoteAddress: '10.168.1.60' });
    expect(info.body).not.toContain('recoveryCodeSet');
  });
});

describe('GET /api/recovery/status', () => {
  it('tells a Pentadbir whether a code exists; AJK is 403, anonymous 401', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const get = (headers: Record<string, string>) =>
      app.inject({ method: 'GET', url: '/api/recovery/status', headers, remoteAddress: '10.168.3.3' });
    expect((await get(admin.headers)).json()).toEqual({ recoveryCodeSet: false });
    expect((await get(ajk.headers)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/recovery/status', remoteAddress: '10.168.3.4' })).statusCode).toBe(401);
    issueRecoveryCode(app.surau.db);
    const r = await get(admin.headers);
    expect(r.json()).toEqual({ recoveryCodeSet: true });
    expect(r.headers['cache-control']).toContain('no-store');
  });
});
