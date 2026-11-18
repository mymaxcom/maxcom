/**
 * qs-gate findings on plan-14-multisurau, route level on a cloud with two suraus: the zone refresh budget and the zone
 * list time per surau, the finance audit join per surau, and what a suspended surau's phone may still call.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { putFeature } from '../src/settingsStore.ts';
import { loginAs, TEST_PIN } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { buildCloud } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';

const A = 'qsalpha-surau';
const B = 'qsbravo-surau';
const noNetwork = (async () => {
  throw new TypeError('network disabled in tests');
}) as unknown as typeof fetch;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function cloud(): { c: TestCloud; app: FastifyInstance } {
  const c = buildCloud('0c10ad00000000aa', { fetchImpl: noNetwork });
  cleanups.push(() => c.close());
  for (const id of [A, B]) {
    c.app.surau.db.prepare('INSERT INTO suraus (id, name, created_at, created_by) VALUES (?, ?, ?, ?)').run(id, `Surau ${id}`, new Date().toISOString(), 'test');
  }
  return { c, app: c.app };
}

const call = (app: FastifyInstance, who: Login, method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: who.headers, ...(payload !== undefined ? { payload } : {}) });

describe('zone list per surau (qs-gate 5, 7)', () => {
  it('the refresh budget is per surau: A spending its 6 does not stop B', async () => {
    const { app } = cloud();
    const a = await loginAs(app, 'admin', TEST_PIN, A);
    const b = await loginAs(app, 'admin', TEST_PIN, B);
    for (let i = 0; i < 6; i += 1) {
      // no network in the test: the refresh itself fails upstream (502), but it is not rate limited
      expect((await call(app, a, 'POST', '/api/prayer/zones/refresh', {})).statusCode, `A ${i}`).toBe(502);
    }
    expect((await call(app, a, 'POST', '/api/prayer/zones/refresh', {})).statusCode).toBe(429);
    expect((await call(app, b, 'POST', '/api/prayer/zones/refresh', {})).statusCode).toBe(502);
  });

  it('the zone list time is the surau’s own (zones route and prayer status)', async () => {
    const { app } = cloud();
    const a = await loginAs(app, 'admin', TEST_PIN, A);
    const b = await loginAs(app, 'admin', TEST_PIN, B);
    app.surau.db.prepare("INSERT INTO meta (surau_id, key, value) VALUES (?, 'jakimZones.fetchedAt', '2026-11-01T00:00:00.000Z')").run(A);
    const za = (await call(app, a, 'GET', '/api/prayer/zones')).json() as { fetchedAt: string | null };
    const zb = (await call(app, b, 'GET', '/api/prayer/zones')).json() as { fetchedAt: string | null };
    expect(za.fetchedAt).toBe('2026-11-01T00:00:00.000Z');
    expect(zb.fetchedAt).not.toBe('2026-11-01T00:00:00.000Z');
    const sa = (await call(app, a, 'GET', '/api/prayer/status')).json() as { zones: { fetchedAt: string | null } };
    const sb = (await call(app, b, 'GET', '/api/prayer/status')).json() as { zones: { fetchedAt: string | null } };
    expect(sa.zones.fetchedAt).toBe('2026-11-01T00:00:00.000Z');
    expect(sb.zones.fetchedAt).not.toBe('2026-11-01T00:00:00.000Z');
  });
});

describe('finance audit joins its own surau’s entry (qs-gate 7)', () => {
  it('the same entry id in two suraus: A’s audit lists its own change once, with its own receipt time', async () => {
    const { app } = cloud();
    const db = app.surau.db;
    const t: Record<string, Login> = {};
    for (const s of [A, B]) {
      putFeature(db, 'finance', { enabled: true }, 'test', undefined, s);
      const admin = await loginAs(app, 'admin', TEST_PIN, s);
      const treasurer = await loginAs(app, 'treasurer', TEST_PIN, s);
      t[s] = treasurer;
      expect((await call(app, admin, 'PUT', '/api/finance/funds/f1', { name: `Tabung ${s}`, public: false })).statusCode).toBe(200);
      expect((await call(app, admin, 'PUT', '/api/finance/perihal/p1', { label: `Derma ${s}`, direction: 'in' })).statusCode).toBe(200);
      const res = await call(app, treasurer, 'PUT', '/api/finance/entries/e-same', {
        kind: 'in', entryDate: '2026-11-06', fundId: 'f1', perihalId: 'p1', amountSen: 100, method: 'tunai', counters: [{ userId: treasurer.userId }, { name: 'Abu' }],
      });
      expect(res.statusCode, res.body).toBe(200);
    }
    db.prepare("UPDATE finance_entries SET cloud_received_at = '2026-11-07T00:00:00.000Z' WHERE surau_id = ? AND id = 'e-same'").run(B);
    db.prepare("UPDATE finance_entries SET cloud_received_at = '2026-11-06T09:00:00.000Z' WHERE surau_id = ? AND id = 'e-same'").run(A);
    const audit = (await call(app, t[A]!, 'GET', '/api/finance/audit')).json() as { entries: { entity: string; entityId: string | null; cloudReceivedAt: string | null }[] };
    const rows = audit.entries.filter((e) => e.entity === 'finance:entry' && e.entityId === 'e-same');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cloudReceivedAt).toBe('2026-11-06T09:00:00.000Z');
  });
});

describe('a suspended surau’s phone (qs-gate 9)', () => {
  it('may ask who it is (suspended: true), sign out and leave; every other route stays 403 surau_suspended', async () => {
    const { app } = cloud();
    const admin = await loginAs(app, 'admin', TEST_PIN, B);
    const media = await loginAs(app, 'media', TEST_PIN, B);
    const other = await loginAs(app, 'admin', TEST_PIN, A);
    const meBefore = (await call(app, admin, 'GET', '/api/auth/me')).json() as { suspended: boolean };
    expect(meBefore.suspended).toBe(false);
    app.surau.db.prepare('UPDATE suraus SET suspended_at = ?, suspended_reason = ? WHERE id = ?').run(new Date().toISOString(), 'ujian', B);

    const settings = await call(app, admin, 'GET', '/api/settings');
    expect(settings.statusCode).toBe(403);
    expect(settings.json().code).toBe('surau_suspended');
    expect((await call(app, admin, 'PUT', '/api/auth/pin', { currentPin: TEST_PIN, newPin: '771935' })).statusCode).toBe(403);
    const me = await call(app, admin, 'GET', '/api/auth/me');
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json()).toMatchObject({ suspended: true, surau: { id: B } });
    expect((await call(app, media, 'POST', '/api/auth/leave', {})).statusCode).toBe(200);
    expect(app.surau.db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(media.deviceId)?.revoked_at).not.toBeNull();
    expect((await call(app, admin, 'POST', '/api/auth/logout', {})).statusCode).toBe(200);
    expect((await call(app, admin, 'GET', '/api/auth/me')).statusCode).toBe(401);
    // another surau is not suspended
    expect((await call(app, other, 'GET', '/api/auth/me')).json()).toMatchObject({ suspended: false });
    expect((await call(app, other, 'GET', '/api/settings')).statusCode).toBe(200);
  });
});
