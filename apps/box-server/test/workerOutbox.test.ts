import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logChange, tx } from '../src/auth/users.ts';
import { revokeDevice } from '../src/auth/devices.ts';
import { putItem } from '../src/content/store.ts';
import { generateSyncKeyPair } from '../src/sync/syncKey.ts';
import { issueLinkCode, revokeSite } from '../src/sync/sites.ts';
import { BACKOFF_MIN_MS, backoffMs, outboxStatus, setOutboxOn } from '../src/sync/workerOutbox.ts';
import { loginAs } from './authHelpers.ts';
import { buildCloud } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FakeWorker } from './support/fakeWorker.ts';
import { insertSite } from './support/sites.ts';

const BOX = 'a1b2c3d4e5f60718';
const clouds: TestCloud[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of clouds.splice(0)) await c.close();
});

interface Rig {
  cloud: TestCloud;
  worker: FakeWorker;
  clock: { t: number };
}

/** A cloud wired to a fake Worker (admin routes), a manual clock and no timer: tests call `drain()`. */
function rig(opts: { withWorker?: boolean; token?: string } = {}): Rig {
  const clock = { t: Date.now() };
  const hook: { fetch: typeof fetch } = { fetch: (() => Promise.reject(new Error('unwired'))) as typeof fetch };
  const withWorker = opts.withWorker !== false;
  const cloud = buildCloud(BOX, {
    now: () => new Date(clock.t),
    ...(withWorker
      ? {
          workerAdmin: { url: 'https://worker.test', token: opts.token ?? 'test-admin-token', fetchImpl: ((i: Parameters<typeof fetch>[0], init?: RequestInit) => hook.fetch(i, init)) as typeof fetch },
          workerOutbox: { auto: false },
        }
      : {}),
  });
  clouds.push(cloud);
  const worker = new FakeWorker(cloud.fetch);
  hook.fetch = worker.fetch;
  return { cloud, worker, clock };
}

const db = (r: Rig) => r.cloud.app.surau.db;
const rows = (r: Rig, where = '1=1') => db(r).prepare(`SELECT * FROM worker_outbox WHERE ${where} ORDER BY id`).all();
const feedHead = (r: Rig): number => Number(db(r).prepare("SELECT MAX(id) AS h FROM change_log WHERE entity LIKE 'content:%' OR entity IN ('settings','users','user','devices','device')").get()?.h ?? 0);
const calls = (r: Rig, kind: string) => r.worker.adminCalls.filter((c) => c.path.startsWith(`/_admin/${kind}/`));
const drain = (r: Rig) => r.cloud.app.workerOutbox!.drain();
let ipN = 0;
const freshIp = (): string => `10.8.${(++ipN >> 8) & 255}.${ipN & 255}`;

const change = (r: Rig, id: string) => putItem(db(r), 'penceramah', { id, name: `Ustaz ${id}` }, 'local');

describe('worker outbox: the dirty flag', () => {
  it('a change on the cloud gives exactly one dirty PUT carrying the head, with the admin token', async () => {
    const r = rig();
    insertSite(db(r), { boxId: BOX });
    change(r, 'p1');
    expect(rows(r)).toHaveLength(1);
    await drain(r);
    const puts = calls(r, 'dirty');
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ method: 'PUT', path: `/_admin/dirty/${BOX}`, body: { seq: feedHead(r) }, auth: 'Bearer test-admin-token' });
    expect(r.worker.dirty.get(BOX)).toBe(feedHead(r));
    expect(rows(r)).toHaveLength(0);
  });

  it('two changes coalesce into one pending item holding the larger seq', async () => {
    const r = rig();
    insertSite(db(r), { boxId: BOX });
    change(r, 'p1');
    const first = feedHead(r);
    change(r, 'p2');
    const items = rows(r, "kind = 'dirty'");
    expect(items).toHaveLength(1);
    expect(JSON.parse(String(items[0]!.body))).toEqual({ seq: feedHead(r) });
    expect(feedHead(r)).toBeGreaterThan(first);
    await drain(r);
    expect(calls(r, 'dirty')).toHaveLength(1);
    expect(r.worker.dirty.get(BOX)).toBe(feedHead(r));
  });

  it('Worker down, then up: the PUT is retried with backoff and lands; the stored seq never goes down', async () => {
    const r = rig();
    insertSite(db(r), { boxId: BOX });
    r.worker.dirty.set(BOX, 99_999); // a higher value already stored
    r.worker.adminDown = true;
    change(r, 'p1');
    await drain(r);
    const item = rows(r)[0]!;
    expect(item).toMatchObject({ state: 'pending', attempts: 1, last_error: 'network' });
    expect(Date.parse(String(item.next_at)) - r.clock.t).toBe(backoffMs(1));
    expect(backoffMs(1)).toBe(BACKOFF_MIN_MS);
    // not due yet: no attempt
    r.worker.adminDown = false;
    await drain(r);
    expect(calls(r, 'dirty')).toHaveLength(0);
    // a second change while it waits coalesces and keeps the backoff
    change(r, 'p2');
    expect(rows(r)).toHaveLength(1);
    r.clock.t += 6_000;
    await drain(r);
    expect(calls(r, 'dirty')).toHaveLength(1);
    expect(rows(r)).toHaveLength(0);
    expect(r.worker.dirty.get(BOX)).toBe(99_999); // max(stored, seq): never lowered
    // backoff doubles and is capped
    expect(backoffMs(2)).toBe(10_000);
    expect(backoffMs(30)).toBe(600_000);
  });

  it('retries on 5xx, 408 and 429; keeps the item pending', async () => {
    const r = rig();
    insertSite(db(r), { boxId: BOX });
    change(r, 'p1');
    for (const status of [500, 503, 408, 429]) {
      r.worker.adminStatus = status;
      r.clock.t += 700_000;
      await drain(r);
      expect(rows(r)[0]).toMatchObject({ state: 'pending', last_error: `http_${status}` });
    }
    expect(Number(rows(r)[0]!.attempts)).toBe(4);
    r.worker.adminStatus = null;
    r.clock.t += 700_000;
    await drain(r);
    expect(rows(r)).toHaveLength(0);
  });

  it('a 400 from the Worker marks the item failed, is not retried, and shows in health', async () => {
    const r = rig();
    insertSite(db(r), { boxId: BOX });
    const admin = await loginAs(r.cloud.app, 'admin');
    await drain(r);
    expect(rows(r)).toHaveLength(0);
    change(r, 'p1');
    r.worker.adminStatus = 400;
    await drain(r);
    expect(rows(r)[0]).toMatchObject({ state: 'failed', attempts: 1, last_error: 'http_400' });
    const before = r.worker.adminCalls.length;
    r.clock.t += 3_600_000;
    await drain(r);
    await drain(r);
    expect(r.worker.adminCalls.length).toBe(before);
    expect(outboxStatus(db(r))).toEqual({ pending: 0, failed: 1, lastError: 'http_400' });
    const health = await r.cloud.app.inject({ method: 'GET', url: '/api/health', headers: admin.headers });
    expect(health.json().sync.workerOutbox).toEqual({ pending: 0, failed: 1, lastError: 'http_400' });
  });

  it('a new change revives a failed dirty item', async () => {
    const r = rig();
    insertSite(db(r), { boxId: BOX });
    change(r, 'p1');
    r.worker.adminStatus = 400;
    await drain(r);
    r.worker.adminStatus = null;
    change(r, 'p2');
    expect(rows(r)[0]).toMatchObject({ state: 'pending', attempts: 0 });
    await drain(r);
    expect(r.worker.dirty.get(BOX)).toBe(feedHead(r));
  });

  it('the outbox row commits with the change and rolls back with it', () => {
    const r = rig();
    insertSite(db(r), { boxId: BOX });
    const logs = (): number => Number(db(r).prepare('SELECT COUNT(*) AS n FROM change_log').get()?.n);
    const base = logs();
    expect(() =>
      tx(db(r), () => {
        logChange(db(r), 'user:t', 'content:penceramah', 'x1', undefined, { id: 'x1' });
        expect(rows(r)).toHaveLength(1); // visible inside the transaction
        throw new Error('forced');
      }),
    ).toThrow('forced');
    expect(logs()).toBe(base);
    expect(rows(r)).toHaveLength(0);
    tx(db(r), () => logChange(db(r), 'user:t', 'content:penceramah', 'x2', undefined, { id: 'x2' }));
    expect(logs()).toBe(base + 1);
    expect(rows(r)).toHaveLength(1);
  });

  it('flags only what a box can pull, for linked sites other than the sender', () => {
    const r = rig();
    insertSite(db(r), { boxId: BOX });
    insertSite(db(r), { boxId: '0011223344556677', revoked: true });
    insertSite(db(r), { boxId: '8899aabbccddeeff', linked: false });
    // entities that never leave the cloud do not raise the flag (the box could never clear it)
    logChange(db(r), 'user:t', 'live', '1', undefined, { a: 1 });
    logChange(db(r), 'user:t', 'site', BOX, undefined, { a: 1 });
    logChange(db(r), 'user:t', 'auth', '1', undefined, { a: 1 });
    expect(rows(r)).toHaveLength(0);
    // a change the site itself pushed does not flag that site
    logChange(db(r), 'user:t', 'settings', 'zone', undefined, { a: 1 }, { origin: `box:${BOX}` });
    expect(rows(r)).toHaveLength(0);
    logChange(db(r), 'user:t', 'settings', 'zone', undefined, { a: 1 }, { origin: 'app' });
    expect(rows(r).map((x) => x.key)).toEqual([`dirty/${BOX}`]);
  });
});

describe('worker outbox: the device allowlist', () => {
  it('enrol queues dev_put with the public key only and revoked:false', async () => {
    const r = rig();
    const login = await loginAs(r.cloud.app, 'admin');
    const item = rows(r, `key = 'dev/${login.deviceId}'`)[0]!;
    expect(item.kind).toBe('dev_put');
    await drain(r);
    const put = calls(r, 'dev').find((c) => c.path === `/_admin/dev/${login.deviceId}`)!;
    expect(put.method).toBe('PUT');
    const body = put.body as { jwk: Record<string, unknown>; revoked: boolean };
    expect(body.revoked).toBe(false);
    expect(Object.keys(body.jwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(body.jwk).not.toHaveProperty('d');
    expect(r.worker.devices.get(login.deviceId)?.revoked).toBe(false);
  });

  it('revoke queues dev_put with revoked:true, replacing a pending put', async () => {
    const r = rig();
    const login = await loginAs(r.cloud.app, 'admin');
    revokeDevice(db(r), login.deviceId, 'test');
    const items = rows(r, `key = 'dev/${login.deviceId}'`);
    expect(items).toHaveLength(1);
    expect(JSON.parse(String(items[0]!.body)).revoked).toBe(true);
    await drain(r);
    expect(r.worker.devices.get(login.deviceId)?.revoked).toBe(true);
  });

  it('deleting a device queues dev_delete', async () => {
    const r = rig();
    const login = await loginAs(r.cloud.app, 'admin');
    await drain(r);
    expect(r.worker.devices.has(login.deviceId)).toBe(true);
    db(r).exec('PRAGMA foreign_keys = OFF');
    db(r).prepare('DELETE FROM devices WHERE id = ?').run(login.deviceId);
    expect(rows(r, `key = 'dev/${login.deviceId}'`)[0]).toMatchObject({ kind: 'dev_delete' });
    await drain(r);
    expect(r.worker.devices.has(login.deviceId)).toBe(false);
    expect(calls(r, 'dev').some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('never queues a key that is not EC P-256 public-only, nor a device without a key', async () => {
    const r = rig();
    const login = await loginAs(r.cloud.app, 'admin');
    const kp = generateSyncKeyPair().publicJwk as unknown as Record<string, string>;
    const ins = (id: string, jwk: string | null): void => {
      db(r)
        .prepare("INSERT INTO devices (id, user_id, name, platform, public_jwk, enrolled_at) VALUES (?, ?, 'x', 'web', ?, '2026-11-05T00:00:00.000Z')")
        .run(id, login.userId, jwk);
    };
    ins('with-d', JSON.stringify({ ...kp, d: 'SECRETSECRET' }));
    ins('rsa', JSON.stringify({ kty: 'RSA', n: 'a', e: 'AQAB' }));
    ins('p384', JSON.stringify({ ...kp, crv: 'P-384' }));
    ins('junk', 'not json');
    ins('kiosk', null);
    expect(rows(r, "key IN ('dev/with-d','dev/rsa','dev/p384','dev/junk','dev/kiosk')")).toHaveLength(0);
    ins('extra', JSON.stringify({ ...kp, alg: 'ES256' }));
    const item = rows(r, "key = 'dev/extra'")[0]!;
    expect(JSON.parse(String(item.body)).jwk).toEqual({ kty: 'EC', crv: 'P-256', x: kp.x, y: kp.y });
  });
});

describe('worker outbox: the wake secret', () => {
  async function link(r: Rig) {
    const { code } = issueLinkCode({ db: db(r), now: () => new Date(r.clock.t) }, { boxId: BOX, name: 'Surau D\'Waqaf' });
    return r.cloud.app.inject({
      method: 'POST',
      url: '/api/sync/link',
      remoteAddress: freshIp(),
      payload: { boxId: BOX, code, publicJwk: generateSyncKeyPair().publicJwk },
    });
  }

  it('link queues site_put sealed at rest, delivers it, and reports it registered', async () => {
    const r = rig();
    const res = await link(r);
    expect(res.statusCode).toBe(200);
    const { wakeSecret, wakeRegistered } = res.json() as { wakeSecret: string; wakeRegistered: boolean };
    expect(wakeRegistered).toBe(true);
    expect(r.worker.secrets.get(BOX)).toBe(wakeSecret);
    expect(calls(r, 'site')[0]).toMatchObject({ method: 'PUT', path: `/_admin/site/${BOX}`, body: { wakeSecret } });
    expect(rows(r, "kind = 'site_put'")).toHaveLength(0);
  });

  it('with the Worker down the sealed item waits (no plaintext anywhere on disk), then lands', async () => {
    const r = rig();
    r.worker.adminDown = true;
    const res = await link(r);
    const { wakeSecret, wakeRegistered } = res.json() as { wakeSecret: string; wakeRegistered: boolean };
    expect(wakeRegistered).toBe(false);
    const item = rows(r, "kind = 'site_put'")[0]!;
    expect(String(item.body).startsWith('v1.')).toBe(true);
    expect(String(item.body)).not.toContain(wakeSecret);
    for (const t of ['sync_state', 'worker_outbox', 'change_log']) {
      expect(JSON.stringify(db(r).prepare(`SELECT * FROM ${t}`).all())).not.toContain(wakeSecret);
    }
    db(r).exec('PRAGMA wal_checkpoint(TRUNCATE)');
    for (const f of readdirSync(r.cloud.dir)) {
      if (!f.startsWith('cloud.db')) continue;
      expect(readFileSync(join(r.cloud.dir, f)).includes(Buffer.from(wakeSecret))).toBe(false);
    }
    r.worker.adminDown = false;
    r.clock.t += 6_000;
    await drain(r);
    expect(r.worker.secrets.get(BOX)).toBe(wakeSecret);
    expect(rows(r, "kind = 'site_put'")).toHaveLength(0);
  });

  it('a re-link replaces the pending item; revoking the site queues site_delete and drops its dirty flag', async () => {
    const r = rig();
    r.worker.adminDown = true;
    const first = (await link(r)).json() as { wakeSecret: string };
    const second = (await link(r)).json() as { wakeSecret: string };
    expect(rows(r, "key = 'site/" + BOX + "'")).toHaveLength(1);
    r.worker.adminDown = false;
    r.clock.t += 6_000;
    await drain(r);
    expect(r.worker.secrets.get(BOX)).toBe(second.wakeSecret);
    expect(r.worker.secrets.get(BOX)).not.toBe(first.wakeSecret);
    change(r, 'p1');
    expect(rows(r, "kind = 'dirty'")).toHaveLength(1);
    expect(revokeSite({ db: db(r), now: () => new Date(r.clock.t) }, BOX)).toBe(true);
    expect(rows(r, "kind = 'dirty'")).toHaveLength(0);
    expect(rows(r, "kind = 'site_delete'")).toHaveLength(1);
    await drain(r);
    expect(r.worker.secrets.has(BOX)).toBe(false);
    expect(calls(r, 'site').some((c) => c.method === 'DELETE')).toBe(true);
  });
});

describe('worker outbox: secrets and the no-Worker mode', () => {
  it('the admin token never appears in a log line or in last_error', async () => {
    const token = 'tok-SUPERSECRET-123';
    const r = rig({ token });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    insertSite(db(r), { boxId: BOX });
    change(r, 'p1');
    for (const mode of ['down', 500, 401, 400] as const) {
      r.worker.adminDown = mode === 'down';
      r.worker.adminStatus = typeof mode === 'number' ? mode : null;
      r.clock.t += 700_000;
      await drain(r);
    }
    // 401 here: the fake wants its own token
    const logged = spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged.length).toBeGreaterThan(0);
    expect(logged).not.toContain(token);
    expect(JSON.stringify(db(r).prepare('SELECT * FROM worker_outbox').all())).not.toContain(token);
    expect(JSON.stringify(outboxStatus(db(r)))).not.toContain(token);
  });

  it('with no Worker configured nothing is queued at all', async () => {
    const r = rig({ withWorker: false });
    expect(r.cloud.app.workerOutbox).toBeNull();
    insertSite(db(r), { boxId: BOX });
    change(r, 'p1');
    const login = await loginAs(r.cloud.app, 'admin');
    revokeDevice(db(r), login.deviceId, 'test');
    const { code } = issueLinkCode({ db: db(r), now: () => new Date() }, { boxId: 'ffeeddccbbaa9988', name: 'Lain' });
    const res = await r.cloud.app.inject({
      method: 'POST',
      url: '/api/sync/link',
      remoteAddress: freshIp(),
      payload: { boxId: 'ffeeddccbbaa9988', code, publicJwk: generateSyncKeyPair().publicJwk },
    });
    expect(res.statusCode).toBe(200);
    expect(rows(r)).toHaveLength(0);
    expect(r.worker.adminCalls).toHaveLength(0);
  });

  it('switching the outbox off drops what was queued', () => {
    const r = rig();
    insertSite(db(r), { boxId: BOX });
    change(r, 'p1');
    expect(rows(r)).toHaveLength(1);
    setOutboxOn(db(r), false);
    expect(rows(r)).toHaveLength(0);
    change(r, 'p2');
    expect(rows(r)).toHaveLength(0);
  });
});
