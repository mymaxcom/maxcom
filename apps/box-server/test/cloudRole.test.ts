import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { sha256hex } from '../src/auth/crypto.ts';
import { putItem } from '../src/content/store.ts';
import { corsOriginsFrom, parseRole } from '../src/main.ts';
import { readFeed } from '../src/sync/feed.ts';
import { generateSyncKeyPair } from '../src/sync/syncKey.ts';
import { issueLinkCode, revokeSite } from '../src/sync/sites.ts';
import { issueEnrolmentLines } from '../src/cli/bootstrap.ts';
import { createUser, listUsers } from '../src/auth/users.ts';
import { trimChangeLog } from '../src/sync/trim.ts';
import { putFeature } from '../src/settingsStore.ts';
import { loginAs } from './authHelpers.ts';
import { buildCloud } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';

const clouds: TestCloud[] = [];
const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of clouds.splice(0)) await c.close();
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BOX = 'a1b2c3d4e5f60718';
let ipN = 0;
const freshIp = (): string => `10.9.${(++ipN >> 8) & 255}.${ipN & 255}`;

function cloud(opts: Parameters<typeof buildCloud>[1] = {}): TestCloud {
  const c = buildCloud(BOX, opts);
  clouds.push(c);
  return c;
}

function plainBox(): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-boxrole-'));
  dirs.push(dir);
  const box = buildApp(join(dir, 'b.db'), { dataDir: dir });
  apps.push(box);
  return box;
}

const sitesDeps = (c: TestCloud, now: () => Date = () => new Date()) => ({ db: c.app.surau.db, now });
const code = (c: TestCloud, now?: () => Date): string => issueLinkCode(sitesDeps(c, now), { boxId: BOX, name: 'Surau D\'Waqaf' }).code;

async function link(c: TestCloud, linkCode: string, over: Record<string, unknown> = {}, ip = freshIp()) {
  return c.app.inject({
    method: 'POST',
    url: '/api/sync/link',
    remoteAddress: ip,
    payload: { boxId: BOX, code: linkCode, publicJwk: generateSyncKeyPair().publicJwk, name: 'x', ...over },
  });
}

describe('cloud role', () => {
  it('has no kiosk pairing (404) and serves the sync routes; a box does not serve /api/sync/link', async () => {
    const c = cloud();
    expect((await c.app.inject({ method: 'POST', url: '/api/kiosk/pair/begin', payload: {} })).statusCode).toBe(404);
    expect((await c.app.inject({ method: 'POST', url: '/api/kiosk/pair/poll', payload: {} })).statusCode).toBe(404);
    expect((await c.app.inject({ method: 'GET', url: '/api/sync/snapshot', remoteAddress: freshIp() })).statusCode).toBe(401);
    const box = plainBox();
    expect((await box.inject({ method: 'POST', url: '/api/sync/link', remoteAddress: freshIp(), payload: {} })).statusCode).toBe(404);
  });

  it('links with the right code: answers a site token, stores only its hash, and the token reads the snapshot but not the settings', async () => {
    const c = cloud();
    const res = await link(c, code(c));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('Surau D\'Waqaf');
    expect(typeof body.siteToken).toBe('string');
    expect(typeof body.wakeSecret).toBe('string');
    const db = c.app.surau.db;
    const row = db.prepare('SELECT token_hash, linked_at FROM sites WHERE box_id = ?').get(BOX);
    expect(row?.token_hash).toBe(sha256hex(body.siteToken));
    expect(row?.linked_at).not.toBeNull();
    // neither secret is in any table the cloud keeps
    const dump = JSON.stringify([
      db.prepare('SELECT * FROM sites').all(),
      db.prepare('SELECT * FROM sync_state').all(),
      db.prepare('SELECT * FROM change_log').all(),
      db.prepare('SELECT * FROM auth_log').all(),
    ]);
    expect(dump).not.toContain(body.siteToken);
    expect(dump).not.toContain(body.wakeSecret);
    expect(String(db.prepare("SELECT after_json FROM change_log WHERE entity = 'site'").get()?.after_json)).toContain('"link"');

    const auth = { authorization: `Bearer ${body.siteToken}` };
    expect((await c.app.inject({ method: 'GET', url: '/api/sync/snapshot', headers: auth })).statusCode).toBe(200);
    expect((await c.app.inject({ method: 'GET', url: '/api/settings', headers: auth })).statusCode).toBe(403);
    expect((await c.app.inject({ method: 'GET', url: '/api/audit', headers: auth })).statusCode).toBe(403);
  });

  it('a wrong code is 401 and the 6th try in 10 minutes is 429', async () => {
    const c = cloud();
    const ip = freshIp();
    for (let i = 0; i < 5; i++) expect((await link(c, 'WRONGCODE234', {}, ip)).statusCode).toBe(401);
    expect((await link(c, 'WRONGCODE234', {}, ip)).statusCode).toBe(429);
  });

  it('a code is single use, and one presented for another box is refused and burned', async () => {
    const c = cloud();
    const first = code(c);
    expect((await link(c, first)).statusCode).toBe(200);
    expect((await link(c, first)).statusCode).toBe(401);
    const second = code(c);
    expect((await link(c, second, { boxId: '0000000000000000' })).statusCode).toBe(401);
    expect((await link(c, second)).statusCode).toBe(401);
  });

  it('a code expires after 15 minutes; a new code for the same box withdraws the old one', async () => {
    let t = new Date('2026-11-05T10:00:00Z');
    const now = (): Date => t;
    const c = cloud({ now });
    const old = code(c, now);
    const fresh = code(c, now);
    expect((await link(c, old)).statusCode).toBe(401);
    t = new Date(t.getTime() + 16 * 60_000);
    expect((await link(c, fresh)).statusCode).toBe(401);
  });

  it('refuses a public key that is not a clean P-256 key (private part, other curve, extra members)', async () => {
    const c = cloud();
    const pair = generateSyncKeyPair();
    for (const bad of [pair.privateJwk, { ...pair.publicJwk, alg: 'ES256' }, { ...pair.publicJwk, crv: 'P-384' }, 'x', null]) {
      expect((await link(c, code(c), { publicJwk: bad })).statusCode).toBe(400);
    }
    expect(c.app.surau.db.prepare('SELECT COUNT(*) AS n FROM sites').get()?.n).toBe(0);
  });

  it('re-linking needs a new code and the old site key dies; revoking kills the key', async () => {
    const c = cloud();
    const a = (await link(c, code(c))).json();
    const b = (await link(c, code(c))).json();
    const snap = (t: string) => c.app.inject({ method: 'GET', url: '/api/sync/snapshot', headers: { authorization: `Bearer ${t}` } });
    expect((await snap(a.siteToken)).statusCode).toBe(401);
    expect((await snap(b.siteToken)).statusCode).toBe(200);
    expect(revokeSite(sitesDeps(c), BOX)).toBe(true);
    expect((await snap(b.siteToken)).statusCode).toBe(401);
    expect(revokeSite(sitesDeps(c), BOX)).toBe(false);
  });

  it('health shows the cloud block on the cloud and the box block on a box, to an admin', async () => {
    const c = cloud();
    const admin = await loginAs(c.app, 'admin');
    const h = (await c.app.inject({ method: 'GET', url: '/api/health', headers: admin.headers })).json();
    expect(h.sync).toEqual({ role: 'cloud', sites: [], workerOutbox: { pending: 0, failed: 0, lastError: null } });
    const box = plainBox();
    const a2 = await loginAs(box, 'admin');
    const hb = (await box.inject({ method: 'GET', url: '/api/health', headers: a2.headers })).json();
    expect(hb.sync).toMatchObject({ linked: false, lastPush: null, lastPull: null, lastError: null, state: 'idle' });
  });

  it('a site key may PUT an asset whose bytes match the id; a mismatch is refused and a device session gets 404', async () => {
    const c = cloud();
    const site = (await link(c, code(c))).json();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const id = sha256hex(png);
    const put = (path: string, headers: Record<string, string>) =>
      c.app.inject({ method: 'PUT', url: path, headers: { 'content-type': 'image/png', ...headers }, payload: png });
    const auth = { authorization: `Bearer ${site.siteToken}` };
    expect((await put(`/api/sync/assets/${id}`, auth)).statusCode).toBe(201);
    expect((await put(`/api/sync/assets/${id}`, auth)).statusCode).toBe(200);
    expect((await put(`/api/sync/assets/${'0'.repeat(64)}`, auth)).statusCode).toBe(400);
    const admin = await loginAs(c.app, 'admin');
    expect((await put(`/api/sync/assets/${id}`, admin.headers)).statusCode).toBe(404);
  });
});

describe('CORS', () => {
  const ORIGIN = 'https://10.168.1.14:8443';
  it('echoes a listed origin only, never credentials; answers its preflight 204 before authz; ignores an unlisted origin', async () => {
    const c = cloud({ corsOrigins: [ORIGIN, '*', 'null', 'not a url'] });
    const ok = await c.app.inject({ method: 'GET', url: '/api/health', headers: { origin: ORIGIN } });
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(ok.headers['access-control-allow-credentials']).toBeUndefined();
    const other = await c.app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://evil.example' } });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
    for (const o of ['null', 'https://10.168.1.14:8443.evil.example', 'http://10.168.1.14:8443']) {
      const r = await c.app.inject({ method: 'GET', url: '/api/health', headers: { origin: o } });
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    }
    const pre = await c.app.inject({
      method: 'OPTIONS',
      url: '/api/sync/changes',
      headers: { origin: ORIGIN, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(pre.headers['access-control-allow-headers']).toBe('Authorization, Content-Type');
    expect(pre.headers['access-control-allow-methods']).toBe('GET, POST, PUT, DELETE');
    const badPre = await c.app.inject({ method: 'OPTIONS', url: '/api/sync/changes', headers: { origin: 'https://evil.example' } });
    expect(badPre.statusCode).not.toBe(204);
    expect(badPre.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('a box has no allowed origin by default', async () => {
    const box = plainBox();
    const r = await box.inject({ method: 'OPTIONS', url: '/api/settings', headers: { origin: ORIGIN } });
    expect(r.statusCode).not.toBe(204);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('reads the environment: SURAU_ROLE and SURAU_CORS_ORIGINS', () => {
    expect(parseRole(undefined)).toBe('box');
    expect(parseRole('Cloud')).toBe('cloud');
    expect(parseRole('both')).toBeNull();
    expect(corsOriginsFrom({ SURAU_CORS_ORIGINS: ' https://a:1 , ,https://b ' })).toEqual(['https://a:1', 'https://b']);
  });
});

describe('change history trim (180 days on a box, 365 on the cloud)', () => {
  const NOW = new Date('2026-11-05T00:00:00Z');
  const ago = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

  function setup() {
    const c = cloud();
    const db = c.app.surau.db;
    const put = (id: string, name: string, days: number): void => {
      putItem(db, 'penceramah', { id, name }, 'local', { editedAt: ago(days), syncedAt: ago(days) });
      // the history row carries the age of the edit
      db.exec("UPDATE change_log SET at = edited_at WHERE entity LIKE 'content:%'");
    };
    return { c, db, put };
  }
  const contentIds = (db: ReturnType<typeof setup>['db']): number[] =>
    db.prepare("SELECT id FROM change_log WHERE entity LIKE 'content:%' ORDER BY id").all().map((x) => Number(x.id));

  it('removes old history, keeps the latest row of every entity and recent rows, raises the floor; current data is untouched', () => {
    const { db, put } = setup();
    put('p1', 'v1', 500);
    put('p1', 'v2', 450);
    put('p1', 'v3', 10);
    put('p2', 'only', 600);
    put('p3', 'a', 300); // inside the cloud's 365 days
    const r = trimChangeLog(db, 'cloud', NOW);
    expect(r.removed).toBe(2);
    const rows = db.prepare("SELECT entity_id FROM change_log WHERE entity LIKE 'content:%' ORDER BY id").all();
    expect(rows.map((x) => x.entity_id)).toEqual(['p1', 'p2', 'p3']);
    const floor = Number(db.prepare("SELECT value FROM sync_state WHERE key = 'log_floor'").get()?.value);
    expect(floor).toBeGreaterThan(0);
    expect(r.floor).toBe(floor);
    expect(db.prepare('SELECT COUNT(*) AS n FROM content_items WHERE deleted_at IS NULL').get()?.n).toBe(3);
  });

  it('never removes a box row that has not been pushed', () => {
    const { db, put } = setup();
    put('p1', 'v1', 300);
    put('p1', 'v2', 290);
    put('p1', 'v3', 280);
    put('p1', 'v4', 10);
    const ids = contentIds(db);
    // the box pushed only the first row
    db.prepare("INSERT INTO sync_state (key, value) VALUES ('last_push_seq', ?)").run(String(ids[0]));
    trimChangeLog(db, 'box', NOW);
    expect(contentIds(db)).toEqual([ids[1], ids[2], ids[3]]);
  });

  it('a client behind the floor is sent to the snapshot (410); the snapshot has the current data; the head is not sent', async () => {
    const { c, db, put } = setup();
    put('p1', 'v1', 500);
    put('p1', 'v2', 10);
    put('p9', 'gone', 600);
    const site = (await link(c, code(c))).json();
    const h = { authorization: `Bearer ${site.siteToken}` };
    expect((await c.app.inject({ method: 'GET', url: '/api/sync/changes?since=0', headers: h })).statusCode).toBe(200);
    const r = trimChangeLog(db, 'cloud', NOW);
    expect(r.removed).toBe(1);
    const behind = await c.app.inject({ method: 'GET', url: '/api/sync/changes?since=0', headers: h });
    expect(behind.statusCode).toBe(410);
    expect(behind.json().code).toBe('snapshot_required');
    const snap = (await c.app.inject({ method: 'GET', url: '/api/sync/snapshot', headers: h })).json();
    const names = (snap.content.penceramah as { id: string; name: string }[]).map((x) => `${x.id}:${x.name}`).sort();
    expect(names).toEqual(['p1:v2', 'p9:gone']);
    const head = readFeed(db, 0, 1, { users: true, devices: true }).head;
    expect((await c.app.inject({ method: 'GET', url: `/api/sync/changes?since=${head}`, headers: h })).statusCode).toBe(200);
  });
});

describe('enrolment payload and enrolment on the cloud', () => {
  const decode = (payload: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(payload.slice('surau1:'.length), 'base64url').toString('utf8')) as Record<string, unknown>;

  it('carries the cloud origin only when the box is linked (its linked address, not the synced setting); the CLI line does too', async () => {
    const box = plainBox();
    const admin = await loginAs(box, 'admin');
    let n = 0;
    const begin = async (): Promise<Record<string, unknown>> => {
      const u = createUser(box.surau.db, { name: `Ahli ${++n}`, roles: ['ajk'] }, 'test');
      return decode((await box.inject({ method: 'POST', url: '/api/enrol/begin', headers: admin.headers, payload: { userId: u.id, deviceName: 'Telefon' } })).json().payload);
    };
    expect(await begin()).not.toHaveProperty('cloud');
    const db = box.surau.db;
    putFeature(db, 'cloudSync', { cloudUrl: 'https://203.0.113.9/awan' }, 'test');
    expect(await begin()).not.toHaveProperty('cloud'); // not linked yet
    db.prepare("INSERT INTO sync_state (key, value) VALUES ('linked', '1')").run();
    // the synced setting never names the cloud (gate S5): only the linked address does
    expect(await begin()).not.toHaveProperty('cloud');
    db.prepare("INSERT INTO sync_state (key, value) VALUES ('cloud_url', 'https://203.0.113.9')").run();
    expect(await begin()).toMatchObject({ cloud: 'https://203.0.113.9' });
    const other = createUser(db, { name: 'Pengguna CLI', roles: ['ajk'] }, 'test');
    const user = listUsers(db).find((u) => u.id === other.id)!;
    const lines = issueEnrolmentLines(db, user, 'https://10.168.1.14:8443', mkdtempSync(join(tmpdir(), 'surau-cli-')), 'x');
    expect(decode(lines.find((l) => l.startsWith('Teks kod QR: '))!.slice('Teks kod QR: '.length))).toMatchObject({ cloud: 'https://203.0.113.9' });
    putFeature(db, 'cloudSync', { cloudUrl: '' }, 'test');
    db.prepare("DELETE FROM sync_state WHERE key = 'linked'").run();
    expect(await begin()).not.toHaveProperty('cloud');
  });

  it('works on the cloud role: an admin session gets a single-use code the cloud honours', async () => {
    const c = cloud();
    const admin = await loginAs(c.app, 'admin');
    const ajk = await loginAs(c.app, 'ajk');
    const fresh = createUser(c.app.surau.db, { name: 'Ahli baharu', roles: ['ajk'] }, 'test');
    const res = await c.app.inject({ method: 'POST', url: '/api/enrol/begin', headers: admin.headers, payload: { userId: fresh.id, deviceName: 'Telefon rumah' } });
    expect(res.statusCode).toBe(200);
    const { code, payload } = res.json();
    expect(decode(payload)).toMatchObject({ code, boxId: BOX });
    const complete = (ip: string) =>
      c.app.inject({ method: 'POST', url: '/api/enrol/complete', remoteAddress: ip, payload: { code, publicJwk: generateSyncKeyPair().publicJwk, platform: 'web', pin: '482916' } });
    expect((await complete(freshIp())).statusCode).toBe(200);
    expect((await complete(freshIp())).statusCode).not.toBe(200);
    // a plain AJK session may not issue codes
    expect((await c.app.inject({ method: 'POST', url: '/api/enrol/begin', headers: ajk.headers, payload: { userId: fresh.id } })).statusCode).toBe(403);
  });
});
