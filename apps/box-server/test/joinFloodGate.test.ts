import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import * as crypto from '../src/auth/crypto.ts';
import { TEST_PIN, makeDevice, screenNonce } from './support/joinHelpers.ts';

vi.mock('../src/auth/crypto.ts', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/auth/crypto.ts')>();
  return { ...m, hashPin: vi.fn(m.hashPin) };
});

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
const clock = { t: Date.parse('2026-11-09T10:00:00Z') };
function make(): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-flood-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'surau.db'), { now: () => new Date(clock.t), dataDir: dir });
  apps.push(app);
  return app;
}
afterEach(async () => {
  vi.mocked(crypto.hashPin).mockClear();
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let n = 0;
const addr = (): string => `10.20.${Math.floor(++n / 250)}.${(n % 250) + 1}`;

async function setupBody(nonce: string, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const d = await makeDevice();
  return { nonce, surauName: 'Surau X', boxName: 'MAXCOM X', adminName: 'Haji Ali', deviceName: 'vivo', publicJwk: d.publicJwk, platform: 'android', pin: TEST_PIN, ...over };
}
const postSetup = (app: FastifyInstance, payload: Record<string, unknown>, remoteAddress = addr()) =>
  app.inject({ method: 'POST', url: '/api/setup/complete', remoteAddress, payload });
const postRecovery = (app: FastifyInstance, payload: Record<string, unknown>, remoteAddress = addr()) =>
  app.inject({ method: 'POST', url: '/api/recovery/complete', remoteAddress, payload });
const junk = (i: number): string => `${String.fromCharCode(65 + (i % 26))}${'x'.repeat(42)}`;

describe('anonymous traffic cannot use up setup or recovery', () => {
  it('25 junk setup POSTs from varied addresses, then a real setup succeeds', async () => {
    const app = make();
    for (let i = 0; i < 25; i++) {
      const r = await postSetup(app, await setupBody(junk(i)));
      expect(r.statusCode).toBe(401);
      expect(r.json().code).toBe('bad_code');
    }
    expect((await postSetup(app, await setupBody(await screenNonce(app)))).statusCode).toBe(201);
  });

  it('25 junk recovery POSTs from varied addresses, then a real recovery succeeds', async () => {
    const app = make();
    const first = await postSetup(app, await setupBody(await screenNonce(app)));
    const code = first.json().recoveryCode as string;
    app.surau.db.prepare("UPDATE devices SET revoked_at = '2026-11-09T09:00:00Z' WHERE platform <> 'kiosk'").run();
    for (let i = 0; i < 25; i++) {
      const r = await postRecovery(app, { ...(await setupBody(junk(i))), recoveryCode: code });
      expect(r.statusCode).toBe(401);
    }
    const ok = await postRecovery(app, { ...(await setupBody(await screenNonce(app), { adminName: 'Hajjah' })), recoveryCode: code });
    expect(ok.statusCode).toBe(201);
  });

  it('an expired or spent nonce is refused without charging the shared limits and is logged', async () => {
    const app = make();
    const nonce = await screenNonce(app);
    clock.t += 11 * 60_000;
    for (let i = 0; i < 22; i++) expect((await postSetup(app, await setupBody(nonce))).statusCode).toBe(401);
    const rows = app.surau.db.prepare("SELECT detail FROM auth_log WHERE event = 'setup' AND ok = 0").all();
    expect(rows).toHaveLength(22);
    expect(rows.every((r) => r.detail === 'expired')).toBe(true);
    clock.t -= 11 * 60_000;
    expect((await postSetup(app, await setupBody(await screenNonce(app)))).statusCode).toBe(201);
  });

  it('a request with a live nonce still counts against the shared setup limit', async () => {
    const app = make();
    const nonce = await screenNonce(app);
    // a weak PIN is refused with 400 and does not spend the nonce, but each request holds a live nonce
    for (let i = 0; i < 20; i++) expect((await postSetup(app, await setupBody(nonce, { pin: '123456' }))).statusCode).toBe(400);
    const r = await postSetup(app, await setupBody(nonce));
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBeDefined();
  });

  it('a live recovery nonce still counts against the shared recovery limit', async () => {
    const app = make();
    const first = await postSetup(app, await setupBody(await screenNonce(app)));
    app.surau.db.prepare("UPDATE devices SET revoked_at = '2026-11-09T09:00:00Z' WHERE platform <> 'kiosk'").run();
    const nonce = await screenNonce(app);
    const body = { ...(await setupBody(nonce, { pin: '123456' })), recoveryCode: first.json().recoveryCode };
    for (let i = 0; i < 10; i++) expect((await postRecovery(app, body)).statusCode).toBe(400);
    expect((await postRecovery(app, body)).statusCode).toBe(429);
  });

  it('the PIN is not hashed for a dead nonce, and is hashed once for a live one', async () => {
    const app = make();
    const hash = vi.mocked(crypto.hashPin);
    hash.mockClear();
    expect((await postSetup(app, await setupBody(junk(1)))).statusCode).toBe(401);
    expect(hash).not.toHaveBeenCalled();
    // direct callers (no route) are guarded too
    const { setupComplete } = await import('../src/setup/complete.ts');
    await expect(
      setupComplete(app.surau.db, '', app.surau.boxId, (await setupBody(junk(2))) as never, '10.1.1.1', new Date(clock.t)),
    ).rejects.toMatchObject({ code: 'bad_code' });
    expect(hash).not.toHaveBeenCalled();
    expect((await postSetup(app, await setupBody(await screenNonce(app)))).statusCode).toBe(201);
    expect(hash).toHaveBeenCalledTimes(1);
  });

  it('an active box still answers recovery 409 without spending a nonce', async () => {
    const app = make();
    const first = await postSetup(app, await setupBody(await screenNonce(app)));
    const r = await postRecovery(app, { ...(await setupBody(junk(3))), recoveryCode: first.json().recoveryCode });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('not_in_recovery');
  });
});
