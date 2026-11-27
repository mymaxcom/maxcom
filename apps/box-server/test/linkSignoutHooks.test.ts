import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLimiters } from '../src/auth/authz.ts';
import { openDb } from '../src/db.ts';
import { registerCameraRoutes } from '../src/live/cameraRoutes.ts';
import { registerLiveRoutes } from '../src/live/routes.ts';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function bare(): FastifyInstance {
  const app = Fastify();
  apps.push(app);
  app.addHook('onRequest', async (request) => {
    (request as { auth: unknown }).auth = { kind: 'user', userId: 'u1', deviceId: 'd1', roles: ['live'], sessionId: 's1', ops: false };
    (request as { tenant: unknown }).tenant = { surauId: LOCAL_SURAU_ID };
  });
  return app;
}

describe('POST /api/live/youtube/signout calls onYoutubeSignedOut', () => {
  async function make(o: { youtube: unknown; live?: boolean; hook?: () => void }): Promise<FastifyInstance> {
    const app = bare();
    registerLiveRoutes(app, {
      sessions: { current: () => (o.live === true ? ({ id: 'x', deviceId: 'd9', source: 'android' } as never) : null), lingeringBroadcast: () => null } as never,
      proxy: {} as never,
      lanIps: [],
      youtube: o.youtube as never,
      ...(o.hook !== undefined ? { onYoutubeSignedOut: o.hook } : {}),
    });
    await app.ready();
    return app;
  }
  const signout = (app: FastifyInstance) => app.inject({ method: 'POST', url: '/api/live/youtube/signout' });

  it('is called once after a successful sign-out', async () => {
    const hook = vi.fn();
    const signoutFn = vi.fn(async () => undefined);
    const app = await make({ youtube: { signout: signoutFn }, hook });
    const r = await signout(app);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ signedIn: false });
    expect(signoutFn).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('is not called when the box has no YouTube service, during a live, or when the sign-out fails', async () => {
    const none = vi.fn();
    expect((await signout(await make({ youtube: null, hook: none }))).statusCode).not.toBe(200);
    const busy = vi.fn();
    const signoutBusy = vi.fn(async () => undefined);
    const r = await signout(await make({ youtube: { signout: signoutBusy }, live: true, hook: busy }));
    expect(r.statusCode).toBe(409);
    expect(signoutBusy).not.toHaveBeenCalled();
    const failed = vi.fn();
    const r2 = await signout(await make({ youtube: { signout: async () => { throw new Error('boom'); } }, hook: failed }));
    expect(r2.statusCode).not.toBe(200);
    expect([none, busy, failed].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it('a throwing callback does not change the answer; no callback at all is fine', async () => {
    const hook = vi.fn(() => {
      throw new Error('listener broke');
    });
    const r = await signout(await make({ youtube: { signout: async () => undefined }, hook }));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ signedIn: false });
    expect(hook).toHaveBeenCalledTimes(1);
    const plain = await signout(await make({ youtube: { signout: async () => undefined } }));
    expect(plain.statusCode).toBe(200);
  });
});

describe('DELETE /api/live/camera calls onCameraRemoved', () => {
  async function make(o: { clear?: () => void; hook?: () => void }): Promise<FastifyInstance> {
    const dir = mkdtempSync(join(tmpdir(), 'maxcom-cam-hook-'));
    dirs.push(dir);
    const db = openDb(join(dir, 'surau.db'));
    const app = bare();
    app.addHook('onClose', async () => db.close());
    const store = { clear: o.clear ?? (() => undefined), getMasked: () => ({ configured: false }) };
    registerCameraRoutes(app, {
      db,
      store: store as never,
      tester: null,
      sessions: { current: () => null },
      limiters: createLimiters(),
      boxIps: ['10.168.50.10'],
      ...(o.hook !== undefined ? { onCameraRemoved: o.hook } : {}),
    });
    await app.ready();
    return app;
  }
  const remove = (app: FastifyInstance) => app.inject({ method: 'DELETE', url: '/api/live/camera' });

  it('is called once after the record was removed', async () => {
    const hook = vi.fn();
    const r = await remove(await make({ hook }));
    expect(r.statusCode).toBe(200);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('is not called when removing the record failed', async () => {
    const hook = vi.fn();
    const r = await remove(await make({ clear: () => { throw new Error('disk'); }, hook }));
    expect(r.statusCode).toBe(500);
    expect(hook).not.toHaveBeenCalled();
  });

  it('a throwing callback does not change the answer', async () => {
    const hook = vi.fn(() => {
      throw new Error('listener broke');
    });
    const r = await remove(await make({ hook }));
    expect(r.statusCode).toBe(200);
    expect(hook).toHaveBeenCalledTimes(1);
  });
});
