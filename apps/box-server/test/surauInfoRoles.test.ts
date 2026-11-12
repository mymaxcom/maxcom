import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { can, klInstant } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { createUser, listUsers, setPin } from '../src/auth/users.ts';
import { loginAs, loginAsAdmin } from './authHelpers.ts';

const AT = klInstant('2026-11-03', '12:00');
const LAN = '10.168.1.60';
const apps: FastifyInstance[] = [];
const dirs: string[] = [];

function makeApp(): FastifyInstance {
  const d = mkdtempSync(join(tmpdir(), 'surau-info-'));
  dirs.push(d);
  const app = buildApp(join(d, 'test.db'), { now: () => AT });
  apps.push(app);
  return app;
}

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function decode(payload: string): Record<string, unknown> {
  expect(payload.startsWith('surau1:')).toBe(true);
  return JSON.parse(Buffer.from(payload.slice(7), 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('GET /api/surau/info (public)', () => {
  it('answers anonymously with the default name, no help, no-store', async () => {
    const app = makeApp();
    const r = await app.inject({ method: 'GET', url: '/api/surau/info', remoteAddress: LAN });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json()).toEqual({
      name: 'Surau', kind: 'surau', showName: true,
      country: 'MY', timezone: 'Asia/Kuala_Lumpur', utcOffsetMinutes: 480,
    });
  });

  it('reflects saved settings, omits empty fields, and exposes nothing beyond the contract', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings/surauInfo',
      headers: admin.headers,
      payload: {
        name: 'Masjid Al-Falah', kind: 'masjid', shortAddress: 'Shah Alam',
        helpName: 'Encik Ahmad (Setiausaha)', helpPhone: '012-345 6789', helpEmail: '',
      },
    });
    expect(put.statusCode).toBe(200);
    const r = await app.inject({ method: 'GET', url: '/api/surau/info', remoteAddress: LAN });
    expect(r.json()).toEqual({
      name: 'Masjid Al-Falah', kind: 'masjid', shortAddress: 'Shah Alam', showName: true,
      help: { name: 'Encik Ahmad (Setiausaha)', phone: '012-345 6789' },
      country: 'MY', timezone: 'Asia/Kuala_Lumpur', utcOffsetMinutes: 480,
    });
    // Where the surau is, but never its coordinates.
    expect(Object.keys(r.json() as object).sort()).toEqual(['country', 'help', 'kind', 'name', 'shortAddress', 'showName', 'timezone', 'utcOffsetMinutes']);
    expect(r.body).not.toMatch(/enabled|helpPhone|version|boxId|token/);
  });

  it('rejects an invalid surauInfo write', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const bad = await app.inject({ method: 'PUT', url: '/api/settings/surauInfo', headers: admin.headers, payload: { name: '  ' } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('enrolment payload', () => {
  it('keeps the old fields and adds surau, help, roles, invitedBy', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    await app.inject({
      method: 'PUT', url: '/api/settings/surauInfo', headers: admin.headers,
      payload: { helpName: 'Encik Ahmad', helpEmail: 'ahmad@example.my' },
    });
    const u = createUser(app.surau.db, { name: 'Puan Aminah', roles: ['treasurer', 'ajk'] }, 'test');
    const r = await app.inject({ method: 'POST', url: '/api/enrol/begin', headers: admin.headers, payload: { userId: u.id } });
    expect(r.statusCode).toBe(200);
    const body = decode(String(r.json().payload));
    for (const k of ['v', 'mode', 'box', 'boxId', 'caSha256', 'code', 'user', 'exp']) expect(body).toHaveProperty(k);
    expect(body.v).toBe(1);
    expect(body.user).toBe('Puan Aminah');
    expect(body.surau).toEqual({ name: 'Surau', kind: 'surau' });
    expect(body.help).toEqual({ name: 'Encik Ahmad', email: 'ahmad@example.my' });
    expect(body.roles).toEqual(['treasurer', 'ajk']);
    expect(typeof body.invitedBy).toBe('string');
    expect((body.invitedBy as string).startsWith('Test admin')).toBe(true);
  });

  it('tells the app whether a PIN exists (pinSet) and nothing else about the PIN', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const u = createUser(app.surau.db, { name: 'Puan Aminah', roles: ['ajk'] }, 'test');
    const before = await app.inject({ method: 'POST', url: '/api/enrol/begin', headers: admin.headers, payload: { userId: u.id } });
    expect(decode(String(before.json().payload)).pinSet).toBe(false);
    await setPin(app.surau.db, u.id, '483920', 'test');
    const after = await app.inject({ method: 'POST', url: '/api/enrol/begin', headers: admin.headers, payload: { userId: u.id } });
    const text = Buffer.from(String(after.json().payload).slice(7), 'base64url').toString('utf8');
    expect(decode(String(after.json().payload)).pinSet).toBe(true);
    expect(text).not.toContain('483920');
    expect(text.toLowerCase()).not.toContain('hash');
    expect(text.toLowerCase()).not.toContain('pin_');
    expect(Object.keys(decode(String(after.json().payload))).filter((k) => /pin/i.test(k))).toEqual(['pinSet']);
  });

  it('omits help when nothing is set', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const r = await app.inject({ method: 'POST', url: '/api/enrol/begin', headers: admin.headers, payload: { userId: admin.userId } });
    expect(decode(String(r.json().payload))).not.toHaveProperty('help');
  });
});

describe('a person may hold several roles', () => {
  it('media+treasurer can write content but not settings', async () => {
    const app = makeApp();
    const l = await loginAs(app, ['media', 'treasurer']);
    const content = await app.inject({ method: 'PUT', url: '/api/content/announcements/x', headers: l.headers, payload: {} });
    expect([401, 403]).not.toContain(content.statusCode);
    const settings = await app.inject({ method: 'PUT', url: '/api/settings/clock', headers: l.headers, payload: { showSeconds: true } });
    expect(settings.statusCode).toBe(403);
    // no finance routes exist yet: assert the union through core
    expect(can(['media', 'treasurer'], 'finance:write')).toBe(true);
    expect(can(['media', 'treasurer'], 'content:write')).toBe(true);
    expect(can(['media', 'treasurer'], 'settings:write')).toBe(false);
  });

  it('ajk+media reads everything and writes content', async () => {
    const app = makeApp();
    const l = await loginAs(app, ['ajk', 'media']);
    expect((await app.inject({ method: 'GET', url: '/api/settings', headers: l.headers })).statusCode).toBe(200);
    expect([401, 403]).not.toContain(
      (await app.inject({ method: 'PUT', url: '/api/content/announcements/x', headers: l.headers, payload: {} })).statusCode,
    );
    expect((await app.inject({ method: 'POST', url: '/api/users', headers: l.headers, payload: { name: 'x', roles: ['ajk'] } })).statusCode).toBe(403);
  });

  it('me, users list return the full role list', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const l = await loginAs(app, ['treasurer', 'ajk']);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: l.headers })).json().roles).toEqual(['treasurer', 'ajk']);
    const list = (await app.inject({ method: 'GET', url: '/api/users', headers: admin.headers })).json().users as { id: string; roles: string[] }[];
    expect(list.find((x) => x.id === l.userId)!.roles).toEqual(['treasurer', 'ajk']);
  });

  it('PUT roles: empty is 400, duplicates collapse, order is normalised, create uses the same rule', async () => {
    const app = makeApp();
    const admin = await loginAsAdmin(app);
    const u = createUser(app.surau.db, { name: 'Orang', roles: ['ajk'] }, 'test');
    const put = (roles: unknown) =>
      app.inject({ method: 'PUT', url: `/api/users/${u.id}/roles`, headers: admin.headers, payload: { roles } });
    const empty = await put([]);
    expect(empty.statusCode).toBe(400);
    expect(empty.json().errors).toEqual(['Peranan tidak sah']);
    expect((await put(['boss'])).statusCode).toBe(400);
    expect((await put('media')).statusCode).toBe(400);
    const ok = await put(['ajk', 'treasurer', 'ajk', 'admin']);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().roles).toEqual(['admin', 'treasurer', 'ajk']);

    const created = await app.inject({ method: 'POST', url: '/api/users', headers: admin.headers, payload: { name: 'Baru', roles: [] } });
    expect(created.statusCode).toBe(400);
    const c2 = await app.inject({ method: 'POST', url: '/api/users', headers: admin.headers, payload: { name: 'Baru', roles: ['ajk', 'media', 'ajk'] } });
    expect(c2.statusCode).toBe(201);
    expect(c2.json().roles).toEqual(['media', 'ajk']);
  });

  it('last-admin guard holds when the admin also has media and is changed to media only', async () => {
    const app = makeApp();
    const l = await loginAs(app, ['admin', 'media']);
    const r = await app.inject({ method: 'PUT', url: `/api/users/${l.userId}/roles`, headers: l.headers, payload: { roles: ['media'] } });
    expect(r.statusCode).toBe(409);
    expect(listUsers(app.surau.db).find((x) => x.id === l.userId)!.roles).toEqual(['admin', 'media']);
    // with a second admin the change is allowed
    await loginAs(app, 'admin');
    const r2 = await app.inject({ method: 'PUT', url: `/api/users/${l.userId}/roles`, headers: l.headers, payload: { roles: ['media'] } });
    expect(r2.statusCode).toBe(200);
  });
});
