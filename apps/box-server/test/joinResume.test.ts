import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { verifyRecoveryCode } from '../src/setup/codes.ts';
import { TEST_PIN, dbBytes, makeDevice, screenNonce } from './support/joinHelpers.ts';
import type { TestDevice } from './support/joinHelpers.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
const clock = { t: Date.parse('2026-11-09T10:00:00Z') };
afterEach(async () => {
  clock.t = Date.parse('2026-11-09T10:00:00Z');
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
let ip = 0;
const lan = (): string => `10.168.30.${++ip}`;
function make(): { app: FastifyInstance; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'surau-resume-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'surau.db'), { now: () => new Date(clock.t), dataDir: dir });
  apps.push(app);
  return { app, dir };
}
const post = (app: FastifyInstance, url: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url, remoteAddress: lan(), payload });
const setupBody = (nonce: string, dev: TestDevice, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  nonce, surauName: 'Surau X', boxName: 'MAXCOM X', adminName: 'Haji Ali', deviceName: 'vivo', publicJwk: dev.publicJwk, platform: 'android', pin: TEST_PIN, ...over,
});

describe('setup: a lost reply is resumed', () => {
  it('the retry gets the same device and a working new code; the old code stops working', async () => {
    const { app } = make();
    const dev = await makeDevice();
    const body = setupBody(await screenNonce(app), dev);
    const first = await post(app, '/api/setup/complete', body); // the reply is "lost": the phone never sees it
    expect(first.statusCode).toBe(201);
    const again = await post(app, '/api/setup/complete', body);
    expect(again.statusCode).toBe(201);
    const a = first.json();
    const b = again.json();
    expect(b.deviceId).toBe(a.deviceId);
    expect(b.userId).toBe(a.userId);
    expect(b.surauId).toBe(a.surauId);
    expect(b.boxName).toBe('MAXCOM X');
    expect(b.recoveryCode).not.toBe(a.recoveryCode);
    const db = app.surau.db;
    expect(verifyRecoveryCode(db, b.recoveryCode)).toBe(true);
    expect(verifyRecoveryCode(db, a.recoveryCode)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM devices').get()?.n).toBe(1);
    expect(db.prepare("SELECT ok FROM auth_log WHERE event = 'setup_resume'").get()).toMatchObject({ ok: 1 });
  });

  it('a wrong PIN, another key, the nonce after 10 minutes, or a revoked device is 401 bad_code', async () => {
    const { app } = make();
    const dev = await makeDevice();
    const body = setupBody(await screenNonce(app), dev);
    expect((await post(app, '/api/setup/complete', body)).statusCode).toBe(201);
    const wrongPin = await post(app, '/api/setup/complete', { ...body, pin: '593716' });
    expect(wrongPin.statusCode).toBe(401);
    expect(wrongPin.json().code).toBe('bad_code');
    const other = await makeDevice();
    expect((await post(app, '/api/setup/complete', { ...body, publicJwk: other.publicJwk })).statusCode).toBe(401);
    const db = app.surau.db;
    const deviceId = String(db.prepare('SELECT id FROM devices').get()?.id);
    db.prepare("UPDATE devices SET revoked_at = '2026-11-09T10:00:01Z' WHERE id = ?").run(deviceId);
    expect((await post(app, '/api/setup/complete', body)).statusCode).toBe(401);
    db.prepare('UPDATE devices SET revoked_at = NULL WHERE id = ?').run(deviceId);
    clock.t += 10 * 60_000 + 1000;
    expect((await post(app, '/api/setup/complete', body)).statusCode).toBe(401);
    expect(db.prepare('SELECT COUNT(*) AS n FROM devices').get()?.n).toBe(1);
  });

  it('a resume attempt counts against the shared limit like a live nonce', async () => {
    const { app } = make();
    const dev = await makeDevice();
    const body = setupBody(await screenNonce(app), dev);
    expect((await post(app, '/api/setup/complete', body)).statusCode).toBe(201);
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await post(app, '/api/setup/complete', body)).statusCode;
    expect(last).toBe(429);
  });

  it('stores no secret with the nonce row', async () => {
    const { app, dir } = make();
    const dev = await makeDevice();
    const r = await post(app, '/api/setup/complete', setupBody(await screenNonce(app), dev));
    const row = app.surau.db.prepare('SELECT device_id, user_id, key_thumb FROM box_codes WHERE device_id IS NOT NULL').get();
    expect(row?.device_id).toBe(r.json().deviceId);
    expect(String(row?.key_thumb)).toMatch(/^[0-9a-f]{64}$/);
    app.surau.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    for (const bytes of dbBytes(dir)) expect(bytes.includes(Buffer.from(r.json().recoveryCode)), 'code').toBe(false);
  });
});

describe('recovery: a lost reply is resumed', () => {
  async function lostAdmin(): Promise<{ app: FastifyInstance; code: string }> {
    const { app } = make();
    const first = await post(app, '/api/setup/complete', setupBody(await screenNonce(app), await makeDevice()));
    app.surau.db.prepare("UPDATE devices SET revoked_at = '2026-11-09T09:00:00Z' WHERE platform <> 'kiosk'").run();
    return { app, code: first.json().recoveryCode as string };
  }
  const rbody = (nonce: string, dev: TestDevice, code: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    nonce, recoveryCode: code, adminName: 'Hajjah Aminah', deviceName: 'iPad', publicJwk: dev.publicJwk, platform: 'ios-web', pin: TEST_PIN, ...over,
  });

  it('the retry, after the box is active again, gets the same device and a working new code', async () => {
    const { app, code } = await lostAdmin();
    const dev = await makeDevice();
    const body = rbody(await screenNonce(app), dev, code);
    const first = await post(app, '/api/recovery/complete', body);
    expect(first.statusCode).toBe(201);
    const again = await post(app, '/api/recovery/complete', body);
    expect(again.statusCode).toBe(201);
    expect(again.json().deviceId).toBe(first.json().deviceId);
    expect(again.json().userId).toBe(first.json().userId);
    expect(again.json().recoveryCode).not.toBe(first.json().recoveryCode);
    const db = app.surau.db;
    expect(verifyRecoveryCode(db, again.json().recoveryCode)).toBe(true);
    expect(verifyRecoveryCode(db, first.json().recoveryCode)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n).toBe(2);
    expect(db.prepare("SELECT ok FROM auth_log WHERE event = 'recovery_resume'").get()).toMatchObject({ ok: 1 });
  });

  it('a wrong PIN, another key, a revoked device or 10 minutes later is refused', async () => {
    const { app, code } = await lostAdmin();
    const dev = await makeDevice();
    const body = rbody(await screenNonce(app), dev, code);
    const first = await post(app, '/api/recovery/complete', body);
    expect(first.statusCode).toBe(201);
    expect((await post(app, '/api/recovery/complete', { ...body, pin: '593716' })).statusCode).toBe(401);
    expect((await post(app, '/api/recovery/complete', { ...body, publicJwk: (await makeDevice()).publicJwk })).statusCode).toBe(401);
    const db = app.surau.db;
    db.prepare("UPDATE devices SET revoked_at = '2026-11-09T10:00:01Z' WHERE id = ?").run(first.json().deviceId);
    // the box is in recovery again, but the nonce is spent: dead
    expect((await post(app, '/api/recovery/complete', body)).statusCode).toBe(401);
    db.prepare('UPDATE devices SET revoked_at = NULL WHERE id = ?').run(first.json().deviceId);
    clock.t += 10 * 60_000 + 1000;
    expect((await post(app, '/api/recovery/complete', body)).statusCode).toBe(401);
  });
});
