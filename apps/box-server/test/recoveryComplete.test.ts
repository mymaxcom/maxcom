import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoxInfo } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { putFeature } from '../src/settingsStore.ts';
import { issueNonce, verifyRecoveryCode } from '../src/setup/codes.ts';
import { TEST_PIN, dbBytes, makeDevice, screenNonce, unlockWith } from './support/joinHelpers.ts';
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
const lan = (): string => `10.168.8.${++ip}`;

interface Setup { app: FastifyInstance; dir: string; code: string; deviceId: string; dev: TestDevice }
/** A box that finished setup through the real route. */
async function setUpBox(): Promise<Setup> {
  const dir = mkdtempSync(join(tmpdir(), 'surau-recov-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'surau.db'), { now: () => new Date(clock.t), dataDir: dir });
  apps.push(app);
  const dev = await makeDevice();
  const r = await app.inject({
    method: 'POST', url: '/api/setup/complete', remoteAddress: lan(),
    payload: { nonce: await screenNonce(app), surauName: 'Surau X', boxName: 'MAXCOM X', adminName: 'Haji Ali', deviceName: 'vivo', publicJwk: dev.publicJwk, platform: 'android', pin: TEST_PIN },
  });
  expect(r.statusCode).toBe(201);
  return { app, dir, code: r.json().recoveryCode, deviceId: r.json().deviceId, dev };
}
const loseAdmin = (app: FastifyInstance): void => {
  app.surau.db.prepare("UPDATE devices SET revoked_at = '2026-11-09T09:00:00Z' WHERE platform <> 'kiosk'").run();
};
async function recover(app: FastifyInstance, nonce: string, code: string, over: Record<string, unknown> = {}, remoteAddress = lan()) {
  const dev = await makeDevice();
  const r = await app.inject({
    method: 'POST', url: '/api/recovery/complete', remoteAddress,
    payload: { nonce, recoveryCode: code, adminName: 'Hajjah Aminah', deviceName: 'iPad', publicJwk: dev.publicJwk, platform: 'ios-web', pin: TEST_PIN, ...over },
  });
  return { r, dev };
}

describe('recovery by the recovery code', () => {
  it('is 409 not_in_recovery while an active Pentadbir device exists, whatever the nonce', async () => {
    const { app, code } = await setUpBox();
    const nonce = issueNonce(app.surau.db, 'recovery', new Date(clock.t)).nonce;
    const { r } = await recover(app, nonce, code);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('not_in_recovery');
    expect(app.surau.db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n).toBe(1);
    // the nonce was not spent by a refusal about the state
    expect(app.surau.db.prepare('SELECT used_at FROM box_codes WHERE type = ?').get('recovery')?.used_at).toBeNull();
  });

  it('a wrong code is 401 and spends the nonce; the right code on that nonce is 401 too; a new nonce with the right code works', async () => {
    const { app, code } = await setUpBox();
    loseAdmin(app);
    const nonce = await screenNonce(app);
    const wrong = code.slice(0, 18) + (code[18] === 'A' ? 'B' : 'A');
    const a = await recover(app, nonce, wrong);
    expect(a.r.statusCode).toBe(401);
    expect(a.r.json().code).toBe('bad_code');
    expect(app.surau.db.prepare("SELECT outcome FROM box_codes WHERE type = 'recovery' AND used_at IS NOT NULL").get()?.outcome).toBe('bad_code');
    const b = await recover(app, nonce, code);
    expect(b.r.statusCode).toBe(401);
    expect(app.surau.db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n).toBe(1);
    // the screen shows a fresh QR on the next poll
    const next = await screenNonce(app);
    expect(next).not.toBe(nonce);
    const c = await recover(app, next, code.toLowerCase().replaceAll('-', ' '));
    expect(c.r.statusCode).toBe(201);
  });

  it('success creates a NEW Pentadbir, rotates the code, and the box is active again', async () => {
    const { app, code, deviceId } = await setUpBox();
    loseAdmin(app);
    const { r, dev } = await recover(app, await screenNonce(app), code);
    expect(r.statusCode).toBe(201);
    const j = r.json();
    expect(j.roles).toEqual(['admin']);
    expect(j.userId).not.toBe(app.surau.db.prepare('SELECT user_id FROM devices WHERE id = ?').get(deviceId)?.user_id);
    expect(app.surau.db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n).toBe(2);
    expect(r.body).not.toContain(TEST_PIN);
    expect(verifyRecoveryCode(app.surau.db, code)).toBe(false);
    expect(verifyRecoveryCode(app.surau.db, j.recoveryCode)).toBe(true);
    expect(j.recoveryCode).not.toBe(code);
    expect(((await app.inject({ method: 'GET', url: '/api/box/info' })).json() as BoxInfo).state).toBe('active');
    putFeature(app.surau.db, 'appLock', { enabled: true }, 'test');
    expect((await unlockWith(app, j.deviceId, dev, TEST_PIN)).status).toBe(200);
    const log = app.surau.db.prepare("SELECT ok, detail FROM auth_log WHERE event = 'recovery' ORDER BY id").all();
    expect(log).toEqual([{ ok: 1, detail: 'ok' }]);
    // the old code can never work again, even if the box falls into recovery a second time
    loseAdmin(app);
    const again = await recover(app, await screenNonce(app), code);
    expect(again.r.statusCode).toBe(401);
  });

  it('the old Pentadbir rows stay; recovery never reuses an existing user', async () => {
    const { app, code } = await setUpBox();
    loseAdmin(app);
    await recover(app, await screenNonce(app), code, { adminName: 'Haji Ali' });
    const users = app.surau.db.prepare('SELECT id, active FROM users').all();
    expect(users).toHaveLength(2);
    expect(users.every((u) => u.active === 1)).toBe(true);
  });

  it('is limited to 3 attempts per hour per address: the 4th is 429', async () => {
    const { app, code } = await setUpBox();
    loseAdmin(app);
    const same = '10.168.77.7';
    for (let i = 0; i < 3; i++) {
      const { r } = await recover(app, await screenNonce(app), 'AAAA-AAAA-AAAA-AAAA', {}, same);
      expect(r.statusCode).toBe(401);
    }
    const { r } = await recover(app, await screenNonce(app), code, {}, same);
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBeDefined();
    expect(app.surau.db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n).toBe(1);
    // another address is not locked by it
    expect((await recover(app, await screenNonce(app), code, {}, '10.168.77.8')).r.statusCode).toBe(201);
  });

  it('is limited to 10 attempts a day for the whole box', async () => {
    const { app } = await setUpBox();
    loseAdmin(app);
    for (let i = 0; i < 10; i++) {
      const { r } = await recover(app, await screenNonce(app), 'AAAA-AAAA-AAAA-AAAA', {}, lan());
      expect(r.statusCode).toBe(401);
    }
    expect((await recover(app, await screenNonce(app), 'AAAA-AAAA-AAAA-AAAA', {}, lan())).r.statusCode).toBe(429);
  });

  it('refuses a short code, a weak PIN and a kiosk platform; a refusal before the nonce keeps the nonce', async () => {
    const { app, code } = await setUpBox();
    loseAdmin(app);
    const nonce = await screenNonce(app);
    expect((await recover(app, nonce, code, { pin: '111111' })).r.statusCode).toBe(400);
    expect((await recover(app, nonce, code, { platform: 'kiosk' })).r.statusCode).toBe(400);
    expect((await recover(app, nonce, code, { adminName: '' })).r.statusCode).toBe(400);
    expect((await recover(app, nonce, code.slice(0, 15))).r.statusCode).toBe(401);
  });

  it('an expired nonce is 401 even with the right code', async () => {
    const { app, code } = await setUpBox();
    loseAdmin(app);
    const nonce = await screenNonce(app);
    clock.t += 11 * 60_000;
    const { r } = await recover(app, nonce, code);
    expect(r.statusCode).toBe(401);
    expect(app.surau.db.prepare("SELECT detail FROM auth_log WHERE event = 'recovery' ORDER BY id DESC LIMIT 1").get()?.detail).toBe('expired');
  });

  it('an unlinked box with no recovery code on file refuses every code', async () => {
    const { app } = await setUpBox();
    app.surau.db.prepare("DELETE FROM meta WHERE key = 'recovery_code_hash'").run();
    loseAdmin(app);
    // the screen shows no QR without a code, so the nonce is issued directly
    const { r } = await recover(app, issueNonce(app.surau.db, 'recovery', new Date(clock.t)).nonce, 'AAAA-AAAA-AAAA-AAAA');
    expect(r.statusCode).toBe(401);
  });

  it('writes no code or nonce to the database or the audit log', async () => {
    const { app, dir, code } = await setUpBox();
    loseAdmin(app);
    const nonce = await screenNonce(app);
    const { r } = await recover(app, nonce, code);
    const fresh = r.json().recoveryCode as string;
    app.surau.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    for (const bytes of dbBytes(dir)) {
      for (const s of [code, code.replaceAll('-', ''), fresh, fresh.replaceAll('-', ''), nonce, TEST_PIN]) {
        expect(bytes.includes(Buffer.from(s)), s).toBe(false);
      }
    }
  });
});
