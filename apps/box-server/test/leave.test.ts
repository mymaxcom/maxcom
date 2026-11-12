import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { completeEnrolment, beginEnrolment } from '../src/auth/devices.ts';
import { verifyRecoveryCode } from '../src/setup/codes.ts';
import { readFeed } from '../src/sync/feed.ts';
import { issueRecoveryCode } from '../src/setup/codes.ts';
import { loginAs } from './authHelpers.ts';
import { makeDevice } from './support/joinHelpers.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function make(): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-leave-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'surau.db'), { dataDir: dir });
  apps.push(app);
  return app;
}
const leave = (app: FastifyInstance, headers: Record<string, string>) =>
  app.inject({ method: 'POST', url: '/api/auth/leave', headers, remoteAddress: '10.168.3.3', payload: {} });
const me = (app: FastifyInstance, headers: Record<string, string>) =>
  app.inject({ method: 'GET', url: '/api/auth/me', headers, remoteAddress: '10.168.3.3' });

describe('leaving the surau', () => {
  it('an AJK phone leaves: its device is revoked, its session dies, the row is audited and travels', async () => {
    const app = make();
    await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    expect((await me(app, ajk.headers)).statusCode).toBe(200);
    const r = await leave(app, ajk.headers);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect((await me(app, ajk.headers)).statusCode).toBe(401);
    const db = app.surau.db;
    expect(db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(ajk.deviceId)?.revoked_at).not.toBeNull();
    expect(db.prepare("SELECT ok FROM auth_log WHERE event = 'leave' AND device_id = ?").get(ajk.deviceId)?.ok).toBe(1);
    // the revoked device travels to the cloud; nothing secret rides with it
    const feed = readFeed(db, 0, 500, { users: true, devices: true });
    const revoked = feed.entries.filter((e) => e.entity === 'device' && e.entityId === ajk.deviceId);
    expect(revoked.some((e) => (e.after as { revoked?: boolean } | null)?.revoked === true)).toBe(true);
    // the user stays; only the phone left
    expect(db.prepare('SELECT active FROM users WHERE id = ?').get(ajk.userId)?.active).toBe(1);
  });

  it('never touches another device: the owner’s other phone and an admin keep working', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    await leave(app, ajk.headers);
    expect((await me(app, admin.headers)).statusCode).toBe(200);
    expect(app.surau.db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(admin.deviceId)?.revoked_at).toBeNull();
  });

  it('the only Pentadbir device cannot leave: 409 last_admin_device and nothing changes', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const before = JSON.stringify(app.surau.db.prepare('SELECT id, revoked_at FROM devices').all());
    const r = await leave(app, admin.headers);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('last_admin_device');
    expect(r.json().errors).toEqual(['Daftar peranti Pentadbir lain dahulu']);
    expect(JSON.stringify(app.surau.db.prepare('SELECT id, revoked_at FROM devices').all())).toBe(before);
    expect((await me(app, admin.headers)).statusCode).toBe(200);
    expect(app.surau.db.prepare("SELECT ok, detail FROM auth_log WHERE event = 'leave'").get()).toEqual({ ok: 0, detail: 'last_admin_device' });
  });

  it('with two Pentadbir phones the first leaves fine, the second is then the last', async () => {
    const app = make();
    const a = await loginAs(app, 'admin');
    const b = await loginAs(app, 'admin');
    expect((await leave(app, a.headers)).statusCode).toBe(200);
    expect((await leave(app, b.headers)).statusCode).toBe(409);
  });

  it('a Pentadbir with a second phone of their own may leave the first', async () => {
    const app = make();
    const a = await loginAs(app, 'admin');
    const db = app.surau.db;
    const { code } = beginEnrolment(db, { userId: a.userId, deviceName: 'iPad' }, 'test');
    const dev = await makeDevice();
    completeEnrolment(db, { code, publicJwk: dev.publicJwk as never, platform: 'ios-web' }, '10.0.0.5');
    expect((await leave(app, a.headers)).statusCode).toBe(200);
  });

  it('a TV screen (paired cookie) cannot leave, and an anonymous caller gets 401', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const begin = (await app.inject({ method: 'POST', url: '/api/kiosk/pair/begin', remoteAddress: '10.168.4.4' })).json();
    await app.inject({ method: 'POST', url: '/api/kiosk/pair/approve', headers: admin.headers, payload: { code: begin.code } });
    const poll = await app.inject({ method: 'POST', url: '/api/kiosk/pair/poll', remoteAddress: '10.168.4.4', payload: { pollToken: begin.pollToken } });
    const cookie = String(poll.headers['set-cookie']).split(';')[0]!;
    const k = await app.inject({ method: 'POST', url: '/api/auth/leave', headers: { cookie }, remoteAddress: '10.168.4.4', payload: {} });
    expect(k.statusCode).toBe(403);
    expect(app.surau.db.prepare("SELECT COUNT(*) AS n FROM devices WHERE platform = 'kiosk' AND revoked_at IS NULL").get()?.n).toBe(1);
    const anon = await app.inject({ method: 'POST', url: '/api/auth/leave', remoteAddress: '10.168.4.5', payload: {} });
    expect(anon.statusCode).toBe(401);
  });
});

describe('recovery code rotation', () => {
  it('a Pentadbir gets a new 19-char code once; the old one dies; the audit has a row and no code', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const db = app.surau.db;
    const old = issueRecoveryCode(db);
    const r = await app.inject({ method: 'POST', url: '/api/recovery/code', headers: admin.headers, remoteAddress: '10.168.3.3', payload: {} });
    expect(r.statusCode).toBe(200);
    const code = r.json().recoveryCode as string;
    expect(code).toHaveLength(19);
    expect(verifyRecoveryCode(db, old)).toBe(false);
    expect(verifyRecoveryCode(db, code)).toBe(true);
    const row = db.prepare("SELECT after_json FROM change_log WHERE entity = 'users' AND entity_id = ? ORDER BY id DESC LIMIT 1").get(admin.userId);
    expect(JSON.parse(String(row?.after_json)).recoveryCodeRotated).toBe(true);
    const everything = JSON.stringify(db.prepare('SELECT * FROM change_log').all()) + JSON.stringify(db.prepare('SELECT * FROM auth_log').all());
    expect(everything).not.toContain(code);
    expect(everything).not.toContain(code.replaceAll('-', ''));
    const feed = JSON.stringify(readFeed(db, 0, 500, { users: true, devices: true }));
    expect(feed).not.toContain(code);
  });

  it('AJK is 403; the 4th rotation in a day is 429', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const ajk = await loginAs(app, 'ajk');
    const post = (h: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/api/recovery/code', headers: h, remoteAddress: '10.168.3.3', payload: {} });
    expect((await post(ajk.headers)).statusCode).toBe(403);
    for (let i = 0; i < 3; i++) expect((await post(admin.headers)).statusCode).toBe(200);
    expect((await post(admin.headers)).statusCode).toBe(429);
  });
});

describe('recent enrolment codes', () => {
  it('shows expiry, use and "tried again" counts, never the code', async () => {
    const app = make();
    const admin = await loginAs(app, 'admin');
    const target = await loginAs(app, 'ajk');
    const db = app.surau.db;
    const b = await app.inject({
      method: 'POST', url: '/api/enrol/begin', headers: admin.headers, remoteAddress: '10.168.3.3',
      payload: { userId: target.userId, deviceName: 'Telefon baharu' },
    });
    expect(b.statusCode).toBe(200);
    const code = b.json().code as string;
    const list = async () => (await app.inject({ method: 'GET', url: '/api/enrol/recent', headers: admin.headers, remoteAddress: '10.168.3.3' })).json().codes;
    let codes = await list();
    expect(codes).toHaveLength(1);
    expect(codes[0]).toMatchObject({ userId: target.userId, deviceName: 'Telefon baharu', usedAt: null, reuseAttempts: 0 });
    expect(JSON.stringify(codes)).not.toContain(code);
    const dev = await makeDevice();
    completeEnrolment(db, { code, publicJwk: dev.publicJwk as never, platform: 'web' }, '10.0.0.7');
    await new Promise((r) => setTimeout(r, 5));
    const dev2 = await makeDevice();
    expect(() => completeEnrolment(db, { code, publicJwk: dev2.publicJwk as never, platform: 'web' }, '10.0.0.8')).toThrow();
    codes = await list();
    expect(codes[0].usedAt).not.toBeNull();
    expect(codes[0].reuseAttempts).toBe(1);
    // another Pentadbir does not see this one
    const other = await loginAs(app, 'admin');
    const theirs = (await app.inject({ method: 'GET', url: '/api/enrol/recent', headers: other.headers, remoteAddress: '10.168.3.3' })).json().codes;
    expect(theirs).toEqual([]);
    // AJK may not read it
    expect((await app.inject({ method: 'GET', url: '/api/enrol/recent', headers: target.headers, remoteAddress: '10.168.3.3' })).statusCode).toBe(403);
  });
});

describe('enrolment codes are kept a day for the issuer', () => {
  it('purgeExpired keeps a used code 1 h, drops it after 25 h; an unused expired code likewise', async () => {
    const { purgeExpired } = await import('../src/auth/sessions.ts');
    const app = make();
    const admin = await loginAs(app, 'admin');
    const target = await loginAs(app, 'ajk');
    const db = app.surau.db;
    const { code } = beginEnrolment(db, { userId: target.userId, deviceName: 'A' }, `user:${admin.userId}`);
    beginEnrolment(db, { userId: target.userId, deviceName: 'B' }, `user:${admin.userId}`);
    const dev = await makeDevice();
    completeEnrolment(db, { code, publicJwk: dev.publicJwk as never, platform: 'web' }, '10.0.0.7');
    const count = (): number => Number(db.prepare('SELECT COUNT(*) AS n FROM enrolments').get()?.n);
    const base = count();
    purgeExpired(db, new Date(Date.now() + 61 * 60_000));
    expect(count()).toBe(base);
    purgeExpired(db, new Date(Date.now() + 25 * 3_600_000));
    expect(count()).toBe(0);
  });
});
