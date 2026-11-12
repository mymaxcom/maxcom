import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { putItem } from '../src/content/store.ts';
import { putFeature } from '../src/settingsStore.ts';
import { enrolCloudOrigin, issueLinkCode } from '../src/sync/sites.ts';
import { trimChangeLog } from '../src/sync/trim.ts';
import { generateSyncKeyPair } from '../src/sync/syncKey.ts';
import { outboxStatus } from '../src/sync/workerOutbox.ts';
import { buildCloud } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FakeWorker } from './support/fakeWorker.ts';
import { insertSite } from './support/sites.ts';

/** Gate fixes: Worker outbox (Q8), trim (Q11/S11), cloud address for QR and CSP (S5), link limiter and trustProxy (S6). */

const BOX = 'a1b2c3d4e5f60718';
const clouds: TestCloud[] = [];
const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of clouds.splice(0)) await c.close();
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Rig {
  cloud: TestCloud;
  worker: FakeWorker;
  clock: { t: number };
}

function rig(): Rig {
  const clock = { t: Date.now() };
  const hook: { fetch: typeof fetch } = { fetch: (() => Promise.reject(new Error('unwired'))) as typeof fetch };
  const cloud = buildCloud(BOX, {
    now: () => new Date(clock.t),
    workerAdmin: { url: 'https://worker.test', token: 'test-admin-token', fetchImpl: ((i: Parameters<typeof fetch>[0], init?: RequestInit) => hook.fetch(i, init)) as typeof fetch },
    workerOutbox: { auto: false },
  });
  clouds.push(cloud);
  const worker = new FakeWorker(cloud.fetch);
  hook.fetch = worker.fetch;
  return { cloud, worker, clock };
}

const db = (r: Rig) => r.cloud.app.surau.db;
const rows = (r: Rig, where = '1=1') => db(r).prepare(`SELECT * FROM worker_outbox WHERE ${where} ORDER BY id`).all();
const drain = (r: Rig) => r.cloud.app.workerOutbox!.drain();

describe('Q8: the outbox survives a wrong admin token', () => {
  it('401 and 403 stay pending with backoff, and drain once the token works again', async () => {
    const r = rig();
    insertSite(db(r), { boxId: BOX });
    await drain(r);
    putItem(db(r), 'penceramah', { id: 'p1', name: 'A' }, 'local');
    expect(rows(r)).toHaveLength(1);
    for (const status of [401, 403]) {
      r.worker.adminStatus = status;
      r.clock.t += 700_000;
      await drain(r);
      expect(rows(r)[0]).toMatchObject({ state: 'pending', last_error: `http_${status}` });
    }
    expect(Number(rows(r)[0]!.attempts)).toBeGreaterThanOrEqual(2);
    expect(String(rows(r)[0]!.next_at)).not.toBe('');
    expect(outboxStatus(db(r))).toMatchObject({ failed: 0, pending: 1 });
    r.worker.adminStatus = null; // the operator fixed the token
    r.clock.t += 700_000;
    await drain(r);
    expect(rows(r)).toHaveLength(0);
    expect(r.worker.dirty.get(BOX)).toBeGreaterThan(0);
  });

  it('a validation error (400, 404, 409, 422) is still failed and visible', async () => {
    const r = rig();
    insertSite(db(r), { boxId: BOX });
    await drain(r);
    for (const status of [400, 404, 409, 422]) {
      putItem(db(r), 'penceramah', { id: `v${status}`, name: 'A' }, 'local');
      r.worker.adminStatus = status;
      await drain(r);
      expect(rows(r)[0]).toMatchObject({ state: 'failed', last_error: `http_${status}` });
      db(r).exec("DELETE FROM worker_outbox");
    }
  });

  it('rows failed by an earlier run (including a site_put) are re-queued at start and delivered', async () => {
    const r = rig();
    const { code } = issueLinkCode({ db: db(r), now: () => new Date(r.clock.t) }, { boxId: BOX, name: 'Surau Ujian' });
    r.worker.adminStatus = 400; // the old behaviour: the wrong token ended as a failed row
    const res = await r.cloud.app.inject({ method: 'POST', url: '/api/sync/link', remoteAddress: '10.9.0.1', payload: { boxId: BOX, code, publicJwk: generateSyncKeyPair().publicJwk } });
    const { wakeSecret } = res.json() as { wakeSecret: string };
    expect(rows(r, "kind = 'site_put'")[0]).toMatchObject({ state: 'failed' });
    r.worker.adminStatus = null;
    await drain(r);
    expect(r.worker.secrets.get(BOX)).toBeUndefined(); // failed rows are not drained
    r.cloud.app.workerOutbox!.start(); // process start
    expect(rows(r, "kind = 'site_put'")[0]).toMatchObject({ state: 'pending', attempts: 0 });
    await drain(r);
    expect(rows(r)).toHaveLength(0);
    expect(r.worker.secrets.get(BOX)).toBe(wakeSecret);
  });
});

describe('Q11/S11: trim keeps every row the agent would still push', () => {
  it('origin app rows above last_push_seq survive; pushed ones and other origins may go', () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-gftrim-'));
    dirs.push(dir);
    const box = buildApp(join(dir, 'box.db'), { dataDir: dir });
    apps.push(box);
    const d = box.surau.db;
    const old = '2025-01-01T00:00:00.000Z';
    const ins = (id: string, origin: string, n: number): number => {
      d.prepare(
        `INSERT INTO change_log (at, actor, entity, entity_id, before_json, after_json, origin, edited_at, rev) VALUES (?, 'x', 'content:penceramah', ?, NULL, ?, ?, ?, ?)`,
      ).run(old, id, JSON.stringify({ n }), origin, old, `${old}|d`);
      return Number(d.prepare('SELECT MAX(id) AS m FROM change_log').get()?.m);
    };
    // two old versions of each entity so that the first is trim-eligible (the latest row of an entity always stays)
    const a1 = ins('ea', 'app', 1);
    ins('ea', 'app', 2);
    const l1 = ins('el', 'local', 1);
    ins('el', 'local', 2);
    const c1 = ins('ec', 'cloud', 1);
    ins('ec', 'cloud', 2);
    d.prepare("INSERT INTO sync_state (key, value) VALUES ('last_push_seq', '0') ON CONFLICT(key) DO UPDATE SET value = '0'").run();
    trimChangeLog(d, 'box', new Date('2026-11-06T00:00:00.000Z'));
    const has = (id: number): boolean => d.prepare('SELECT 1 AS x FROM change_log WHERE id = ?').get(id) !== undefined;
    expect(has(a1)).toBe(true); // an unpushed app row is protected like a local one
    expect(has(l1)).toBe(true);
    expect(has(c1)).toBe(false); // a cloud row never goes up, so it is not protected
    // once pushed the app row may go
    d.prepare("UPDATE sync_state SET value = ? WHERE key = 'last_push_seq'").run(String(a1 + 1000));
    trimChangeLog(d, 'box', new Date('2026-11-06T00:00:00.000Z'));
    expect(has(a1)).toBe(false);
  });
});

describe('S5: only the linked cloud address decides the QR cloud field and the CSP', () => {
  it('the synced cloudSync.cloudUrl setting is ignored by the enrolment origin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-gfs5-'));
    dirs.push(dir);
    const box = buildApp(join(dir, 'box.db'), { dataDir: dir });
    apps.push(box);
    const d = box.surau.db;
    putFeature(d, 'cloudSync', { cloudUrl: 'https://evil.example/x' }, 'test');
    d.prepare("INSERT INTO sync_state (key, value) VALUES ('linked', '1')").run();
    expect(enrolCloudOrigin(d)).toBeUndefined();
    d.prepare("INSERT INTO sync_state (key, value) VALUES ('cloud_url', 'https://cloud.real.example')").run();
    expect(enrolCloudOrigin(d)).toBe('https://cloud.real.example');
  });

  it('the CSP connect-src names the linked cloud, never the synced setting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-gfs5b-'));
    dirs.push(dir);
    const appDir = join(dir, 'app');
    mkdirSync(appDir);
    writeFileSync(join(appDir, 'index.html'), '<!doctype html><title>app</title>');
    const box = buildApp(join(dir, 'box.db'), { dataDir: dir, appDir });
    apps.push(box);
    putFeature(box.surau.db, 'cloudSync', { cloudUrl: 'https://evil.example' }, 'test');
    box.surau.db.prepare("INSERT INTO sync_state (key, value) VALUES ('cloud_url', 'https://cloud.real.example')").run();
    const csp = String((await box.inject({ method: 'GET', url: '/app/' })).headers['content-security-policy']);
    expect(csp).toContain('https://cloud.real.example');
    expect(csp).not.toContain('evil.example');
  });
});

describe('S6: linking has its own limiter bucket; trustProxy is opt-in', () => {
  const cloudApp = (opts: Parameters<typeof buildCloud>[1] = {}): FastifyInstance => {
    const c = buildCloud(BOX, opts);
    clouds.push(c);
    return c.app;
  };

  it('exhausting the enrolment limit does not block linking, and linking does not use up enrolment', async () => {
    const app = cloudApp();
    for (let i = 0; i < 5; i++) expect(app.surau.limiters.enrolIp.hit('10.168.1.80').ok).toBe(true);
    expect(app.surau.limiters.enrolIp.hit('10.168.1.80').ok).toBe(false);
    const linkCodes: number[] = [];
    for (let i = 0; i < 6; i++) linkCodes.push((await app.inject({ method: 'POST', url: '/api/sync/link', remoteAddress: '10.168.1.80', payload: {} })).statusCode);
    expect(linkCodes).toEqual([400, 400, 400, 400, 400, 429]);
    // and the other way round: a fresh address, link until limited, enrolment is untouched
    expect(app.surau.limiters.enrolIp.hit('10.168.1.81').ok).toBe(true);
    for (let i = 0; i < 6; i++) await app.inject({ method: 'POST', url: '/api/sync/link', remoteAddress: '10.168.1.81', payload: {} });
    expect(app.surau.limiters.enrolIp.hit('10.168.1.81').ok).toBe(true);
  });

  it('trustProxy is off by default and on only when asked (option or SURAU_TRUST_PROXY=1)', async () => {
    const probe = async (opts: Record<string, unknown>): Promise<string> => {
      const dir = mkdtempSync(join(tmpdir(), 'surau-gftp-'));
      dirs.push(dir);
      const box = buildApp(join(dir, 'box.db'), { dataDir: dir, ...opts });
      apps.push(box);
      let ip = '';
      box.addHook('onRequest', async (req) => {
        ip = req.ip;
      });
      await box.inject({ method: 'GET', url: '/api/health', remoteAddress: '10.168.1.5', headers: { 'x-forwarded-for': '203.0.113.7' } });
      return ip;
    };
    expect(await probe({})).toBe('10.168.1.5');
    expect(await probe({ trustProxy: true })).toBe('203.0.113.7');
    vi.stubEnv('SURAU_TRUST_PROXY', '1');
    expect(await probe({})).toBe('203.0.113.7');
    vi.unstubAllEnvs();
    expect(await probe({})).toBe('10.168.1.5');
  });
});
