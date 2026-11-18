import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { listDevices } from '../src/auth/devices.ts';
import { activeAdminCount, listUsers } from '../src/auth/users.ts';
import { loginAs, TEST_PIN } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { signOp } from './support/signOp.ts';

const AT = new Date('2026-11-12T03:00:00.000Z');
const dirs: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const noNetwork = (async () => { throw new TypeError('network disabled in tests'); }) as unknown as typeof fetch;

interface Rig { app: FastifyInstance; admin: Login; su: Login; ops?: Login }

async function rig(role: 'box' | 'cloud'): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'surau-hidden-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'h.db'), { dataDir: dir, role, now: () => AT, fetchImpl: noNetwork });
  apps.push(app);
  const admin = await loginAs(app, 'admin', TEST_PIN, 'sdm');
  if (role === 'box') {
    // a box: the Pentadbir MAXCOM arrives from the cloud, and its phone is an ordinary (public) device of the box
    const su = await loginAs(app, ['admin', 'superadmin']);
    return { app, admin, su };
  }
  // the cloud: the Pentadbir MAXCOM only has ops devices; a second, public login stands for one enrolled before
  const ops = await loginAs(app, ['admin', 'superadmin']);
  return { app, admin, su: ops, ops };
}

const call = (r: Rig, who: Login, method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  r.app.inject({ method, url, headers: who.headers, ...(payload === undefined ? {} : { payload: payload as object }) });
const logRows = (r: Rig): number => Number(r.app.surau.db.prepare("SELECT COUNT(*) AS n FROM auth_log WHERE event = 'star_target_refused'").get()?.n);
const userRow = (r: Rig, id: string) => r.app.surau.db.prepare('SELECT roles_json, active, pin_hash FROM users WHERE id = ?').get(id);

for (const role of ['box', 'cloud'] as const) {
  describe(`a surau session never sees or touches the Pentadbir MAXCOM (${role})`, () => {
    it('lists do not include it or its devices', async () => {
      const r = await rig(role);
      const users = ((await call(r, r.admin, 'GET', '/api/users')).json().users as Array<{ id: string }>).map((u) => u.id);
      expect(users).toContain(r.admin.userId);
      expect(users).not.toContain(r.su.userId);
      const devices = ((await call(r, r.admin, 'GET', '/api/devices')).json().devices as Array<{ id: string }>).map((d) => d.id);
      expect(devices).toContain(r.admin.deviceId);
      expect(devices).not.toContain(r.su.deviceId);
    });

    it('cannot change roles, deactivate, reset the PIN, enrol a device for it or revoke its device: 404, nothing changes, one log row each', async () => {
      const r = await rig(role);
      const before = userRow(r, r.su.userId);
      const tries: Array<[string, 'PUT' | 'POST', string, unknown?]> = [
        ['roles', 'PUT', `/api/users/${r.su.userId}/roles`, { roles: ['ajk'] }],
        ['deactivate', 'POST', `/api/users/${r.su.userId}/deactivate`],
        ['pin', 'PUT', `/api/users/${r.su.userId}/pin`, {}],
        ['enrol', 'POST', '/api/enrol/begin', { userId: r.su.userId }],
        ['revoke', 'POST', `/api/devices/${r.su.deviceId}/revoke`],
      ];
      for (const [name, method, url, payload] of tries) {
        const n = logRows(r);
        const res = await call(r, r.admin, method, url, payload);
        expect(res.statusCode, name).toBe(404);
        expect(logRows(r), name).toBe(n + 1);
      }
      expect(userRow(r, r.su.userId)).toEqual(before);
      expect(r.app.surau.db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(r.su.deviceId)?.revoked_at).toBeNull();
    });

    it('answers the same as an unknown id', async () => {
      const r = await rig(role);
      const star = await call(r, r.admin, 'POST', `/api/users/${r.su.userId}/deactivate`);
      const none = await call(r, r.admin, 'POST', '/api/users/no-such-user/deactivate');
      expect(star.statusCode).toBe(none.statusCode);
      expect(star.json()).toEqual(none.json());
    });

    it('a signed sync op cannot change the superadmin or revoke its device either', async () => {
      const r = await rig(role);
      const before = userRow(r, r.su.userId);
      const put = await signOp(r.admin, r.app.surau.boxId, { kind: 'user.put', entity: 'users', entityId: r.su.userId, payload: { name: 'Dikuasai' } });
      const rev = await signOp(r.admin, r.app.surau.boxId, { kind: 'device.revoke', entity: 'devices', entityId: r.su.deviceId, payload: {} });
      for (const op of [put, rev]) {
        const n = Number(r.app.surau.db.prepare("SELECT COUNT(*) AS c FROM auth_log WHERE event = 'sync_refused' AND detail = 'not_found'").get()?.c);
        const res = await call(r, r.admin, 'POST', '/api/sync/ops', { ops: [op] });
        expect(res.statusCode).toBe(200);
        expect(res.json().results[0].status).toBe('refused');
        expect(Number(r.app.surau.db.prepare("SELECT COUNT(*) AS c FROM auth_log WHERE event = 'sync_refused' AND detail = 'not_found'").get()?.c)).toBe(n + 1);
      }
      expect(userRow(r, r.su.userId)).toEqual(before);
      expect(r.app.surau.db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(r.su.deviceId)?.revoked_at).toBeNull();
    });

    it('the superadmin is not a surau administrator, but the surau is not thrown into recovery', async () => {
      const r = await rig(role);
      expect(activeAdminCount(r.app.surau.db, 'sdm')).toBe(1);
      expect(listUsers(r.app.surau.db, 'sdm').some((u) => u.id === r.su.userId)).toBe(false);
      expect(listUsers(r.app.surau.db, 'sdm', true).some((u) => u.id === r.su.userId)).toBe(true);
      expect(listDevices(r.app.surau.db, undefined, undefined, 'sdm').some((d) => d.id === r.su.deviceId)).toBe(false);
      expect(listDevices(r.app.surau.db, undefined, { includeStar: true }, 'sdm').some((d) => d.id === r.su.deviceId)).toBe(true);
    });
  });
}

describe('the superadmin side still works', () => {
  it('an ops-device session on the cloud lists the Pentadbir MAXCOM and its devices', async () => {
    const r = await rig('cloud');
    const users = ((await call(r, r.ops!, 'GET', '/api/users')).json().users as Array<{ id: string }>).map((u) => u.id);
    expect(users).toContain(r.su.userId);
    const devices = ((await call(r, r.ops!, 'GET', '/api/devices')).json().devices as Array<{ id: string }>).map((d) => d.id);
    expect(devices).toContain(r.su.deviceId);
  });

  it('the CLI users store still finds and edits it', async () => {
    const r = await rig('box');
    const users = listUsers(r.app.surau.db, 'sdm', true);
    expect(users.find((u) => u.id === r.su.userId)?.roles).toContain('superadmin');
  });
});
