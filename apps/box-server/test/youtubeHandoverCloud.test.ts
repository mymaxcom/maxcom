import * as fs from 'node:fs';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { klInstant } from '@surau/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

// every file read of the whole cloud app goes through this wrapper: the test below proves which paths are read
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real, readFileSync: vi.fn(real.readFileSync) };
});
import { sweepQuarantine, tokenFileFor } from '../src/live/youtube/registry.ts';
import { CLIENT_FILE_MAX, openClient, openHandover, sealClient } from '../src/sync/youtubeSeal.ts';
import { generateSyncKeyPair } from '../src/sync/syncKey.ts';
import { loginAs } from './authHelpers.ts';
import { seedCloudGrant } from './support/cloudGrant.ts';
import { buildCloud } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FAKE_REFRESH, startFakeGoogle } from './support/fakeGoogle.ts';
import type { FakeGoogle } from './support/fakeGoogle.ts';
import { withUploadApi } from './support/fakeGoogleUpload.ts';
import { insertSite } from './support/sites.ts';
import type { TestSite } from './support/sites.ts';

/**
 * Release 2026.11.13, phase 1 (the cloud): the YouTube grant is the box's. The cloud refuses every sign-in, keeps a
 * non-secret flag, hands an old grant over ONCE to a linked box of that surau (sealed to that box, acknowledged,
 * then DELETED without a revoke), and delivers the OAuth client sealed to a linked box.
 */

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0)) await c();
});

const BOX_A = 'aaaa000000000001';
const BOX_A2 = 'aaaa000000000002';
const BOX_B = 'bbbb000000000001';
const OTHER = 'other';
const CLIENT = JSON.stringify({ installed: { client_id: 'cid-123.apps.googleusercontent.com', client_secret: 'csecret-SECRET' } });

interface Site extends TestSite {
  keys: ReturnType<typeof generateSyncKeyPair>;
}

interface Rig {
  cloud: TestCloud;
  g: FakeGoogle;
  clock: { t: number; now: () => Date };
  a: Site;
  logs: string[];
  site: (boxId: string, surauId?: string) => Site;
}

async function rig(o: { grant?: boolean } = {}): Promise<Rig> {
  const g = await startFakeGoogle();
  const clock = { t: klInstant('2026-11-19', '10:00').getTime(), now: (): Date => new Date(clock.t) };
  const cloud = buildCloud('boxid0001', { now: clock.now, fetchImpl: withUploadApi(g).fetchImpl });
  closers.push(cloud.close, g.close);
  mkdirSync(join(cloud.dir, 'secret'), { recursive: true });
  writeFileSync(join(cloud.dir, 'secret', 'youtube-client.json'), CLIENT);
  const db = cloud.app.surau.db;
  db.prepare('INSERT INTO suraus (id, name, created_at, created_by) VALUES (?, ?, ?, ?)').run(OTHER, 'Surau Lain', clock.now().toISOString(), 'test');
  const logs: string[] = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
  }
  const site = (boxId: string, surauId = 'sdm'): Site => {
    const s = insertSite(db, { boxId, surauId });
    const keys = generateSyncKeyPair();
    db.prepare('UPDATE sites SET public_jwk = ? WHERE box_id = ?').run(JSON.stringify(keys.publicJwk), boxId);
    return { ...s, keys };
  };
  if (o.grant !== false) seedCloudGrant(cloud.dir, clock.now);
  return { cloud, g, clock, a: site(BOX_A), logs, site };
}

const tokenPath = (r: Rig, surauId = 'sdm'): string => join(r.cloud.dir, 'secret', tokenFileFor(surauId));
const req = (r: Rig, method: 'GET' | 'POST' | 'PUT', url: string, headers: Record<string, string>, payload?: object) =>
  r.cloud.app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });
const handover = (r: Rig, s: Site) => req(r, 'POST', '/api/sync/youtube/handover', s.headers);
const ack = (r: Rig, s: Site, body: object) => req(r, 'POST', '/api/sync/youtube/handover/ack', s.headers, body);

/** Everything the cloud keeps or said that could carry a secret. */
function cloudText(r: Rig): string {
  const db = r.cloud.app.surau.db;
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return [
    JSON.stringify(db.prepare('SELECT * FROM change_log').all()),
    JSON.stringify(db.prepare('SELECT * FROM youtube_flag').all()),
    JSON.stringify(db.prepare('SELECT * FROM youtube_handover').all()),
    readFileSync(join(r.cloud.dir, 'cloud.db')).toString('latin1'),
    r.logs.join('\n'),
  ].join('\n');
}

describe('the cloud makes no new grant', () => {
  it('sign-in, its poll and sign-out answer 409 youtube_at_box with the BM sentence for an old app; Google is never asked', async () => {
    const r = await rig({ grant: false });
    const admin = await loginAs(r.cloud.app, 'admin');
    for (const url of ['/api/live/youtube/signin', '/api/live/youtube/signin/poll', '/api/live/youtube/signout']) {
      const res = await req(r, 'POST', url, admin.headers, {});
      expect(res.statusCode, url).toBe(409);
      expect(res.json()).toEqual({ errors: ['Log masuk YouTube kini dibuat pada MAXCOM di surau. Kemas kini aplikasi dan cuba di Wi-Fi surau.'], code: 'youtube_at_box' });
    }
    expect(r.g.calls).toHaveLength(0);
    expect(existsSync(tokenPath(r))).toBe(false);
  });

  it('the status away from the surau is the box flag (heldBy box, signInHere false), never a token', async () => {
    const r = await rig({ grant: false });
    const admin = await loginAs(r.cloud.app, 'admin');
    expect((await req(r, 'GET', '/api/live/youtube/status', admin.headers)).json()).toMatchObject({ signedIn: false, heldBy: 'box', signInHere: false });
    const put = await req(r, 'PUT', '/api/sync/youtube/flag', r.a.headers, { signedIn: true, channelTitle: 'Surau Contoh' });
    expect(put.statusCode).toBe(200);
    expect((await req(r, 'GET', '/api/live/youtube/status', admin.headers)).json()).toMatchObject({ signedIn: true, channelTitle: 'Surau Contoh', heldBy: 'box', signInHere: false, lastError: null });
    const live = (await req(r, 'GET', '/api/live/status', admin.headers)).json() as { youtube: Record<string, unknown> };
    expect(live.youtube).toMatchObject({ signedIn: true, channelTitle: 'Surau Contoh', signInHere: false });
    // another surau sees nothing of it
    const otherAdmin = await loginAs(r.cloud.app, 'admin', undefined, OTHER);
    expect((await req(r, 'GET', '/api/live/youtube/status', otherAdmin.headers)).json()).toMatchObject({ signedIn: false, channelTitle: null });
  });

  it('the flag takes exactly signedIn, channelTitle and revoked: a token cannot be stored through it', async () => {
    const r = await rig({ grant: false });
    for (const bad of [
      { signedIn: true, channelTitle: 'x', refreshToken: FAKE_REFRESH },
      { signedIn: 'yes' },
      { signedIn: true, channelTitle: 'a\u0000b' },
      { signedIn: true, revoked: 'no' },
    ]) {
      expect((await req(r, 'PUT', '/api/sync/youtube/flag', r.a.headers, bad)).statusCode).toBe(400);
    }
    expect(r.cloud.app.surau.db.prepare('SELECT COUNT(*) AS n FROM youtube_flag').get()!.n).toBe(0);
    // a device session never reaches the site routes
    const admin = await loginAs(r.cloud.app, 'admin');
    for (const [m, url] of [['PUT', '/api/sync/youtube/flag'], ['POST', '/api/sync/youtube/handover'], ['POST', '/api/sync/youtube/handover/ack'], ['GET', '/api/sync/youtube/client']] as const) {
      expect((await req(r, m, url, admin.headers, m === 'GET' ? undefined : { signedIn: true })).statusCode, url).not.toBe(200);
    }
  });

  it('D4: the flag is the holding box: another box of the surau cannot clear it; a revoked site loses the hold', async () => {
    const r = await rig({ grant: false });
    const a2 = r.site(BOX_A2);
    // box A holds the handover of this surau (Q6: the flag is the handover holder's)
    r.cloud.app.surau.db
      .prepare("INSERT INTO youtube_handover (surau_id, box_id, handover_id, state, offered_at, acked_at) VALUES ('sdm', ?, 'ho_seeded0001', 'acked', ?, ?)")
      .run(BOX_A, r.clock.now().toISOString(), r.clock.now().toISOString());
    expect((await req(r, 'PUT', '/api/sync/youtube/flag', r.a.headers, { signedIn: true, channelTitle: 'Saluran A' })).statusCode).toBe(200);
    const other = await req(r, 'PUT', '/api/sync/youtube/flag', a2.headers, { signedIn: false, channelTitle: null });
    expect(other.statusCode).toBe(409);
    expect(other.json().code).toBe('claimed');
    r.cloud.app.surau.db.prepare('UPDATE sites SET revoked_at = ? WHERE box_id = ?').run('2026-11-19T00:00:00.000Z', BOX_A);
    expect((await req(r, 'PUT', '/api/sync/youtube/flag', a2.headers, { signedIn: false, channelTitle: null })).statusCode).toBe(200);
  });
});

describe('the one-time handover of an old cloud grant', () => {
  it('seals the grant to the asking box only; the cloud deletes its copy on the acknowledgement with ZERO revoke calls', async () => {
    const r = await rig();
    const res = await handover(r, r.a);
    expect(res.statusCode).toBe(200);
    const { handoverId, sealed, boxId } = res.json() as { handoverId: string; sealed: string; boxId: string };
    expect(boxId).toBe(BOX_A);
    // the answer carries no clear token
    expect(res.body).not.toContain(FAKE_REFRESH);
    // only this box's key, this box id and this handover id open it
    const g = JSON.parse(openHandover(r.a.keys.privateJwk, sealed, BOX_A, handoverId)) as Record<string, unknown>;
    expect(g).toMatchObject({ v: 1, surauId: 'sdm', boxId: BOX_A, handoverId, refreshToken: FAKE_REFRESH, channelTitle: 'Surau Contoh' });
    expect(() => openHandover(generateSyncKeyPair().privateJwk, sealed, BOX_A, handoverId)).toThrow();
    expect(() => openHandover(r.a.keys.privateJwk, sealed, BOX_A2, handoverId)).toThrow();
    expect(() => openHandover(r.a.keys.privateJwk, sealed, BOX_A, 'ho_other00000')).toThrow();
    // nor as a camera value or a client file (another label)
    expect(() => openClient(r.a.keys.privateJwk, sealed, BOX_A)).toThrow();
    // the cloud still holds it until the box says it works
    expect(existsSync(tokenPath(r))).toBe(true);

    const done = await ack(r, r.a, { handoverId, ok: true, channelTitle: 'Surau Contoh' });
    expect(done.json()).toEqual({ acknowledged: true });
    expect(existsSync(tokenPath(r))).toBe(false);
    expect(existsSync(`${tokenPath(r)}.tmp`)).toBe(false);
    // deleted, never revoked: the box's copy stays valid
    expect(r.g.count('/revoke')).toBe(0);
    expect(r.g.calls.filter((c) => c.path === '/revoke')).toEqual([]);
    // the same acknowledgement again (a lost answer): the same answer, nothing else happens
    expect((await ack(r, r.a, { handoverId, ok: true, channelTitle: 'Surau Contoh' })).json()).toEqual({ acknowledged: true });
    // nothing more to hand over
    expect((await handover(r, r.a)).statusCode).toBe(404);
    // the flag now says the box holds it; no token anywhere the cloud keeps or logs
    const admin = await loginAs(r.cloud.app, 'admin');
    expect((await req(r, 'GET', '/api/live/youtube/status', admin.headers)).json()).toMatchObject({ signedIn: true, channelTitle: 'Surau Contoh', heldBy: 'box' });
    expect(cloudText(r)).not.toContain(FAKE_REFRESH);
    expect(cloudText(r)).not.toContain('access-token-1');
    expect(r.g.count('/revoke')).toBe(0);
  });

  it('after the handover no cloud path reads a youtube-token- file: status, upload, verify, the box leg all answer from the flag', async () => {
    const r = await rig();
    const readSpy = vi.mocked(fs.readFileSync);
    const reads = (): string[] => readSpy.mock.calls.map((c) => String(c[0])).filter((p) => p.includes('youtube-token-'));
    readSpy.mockClear();
    const h = (await handover(r, r.a)).json() as { handoverId: string };
    // the probe works: the handover itself is the one path that read the file while it was there
    expect(reads().length).toBeGreaterThan(0);
    await ack(r, r.a, { handoverId: h.handoverId, ok: true, channelTitle: 'Surau Contoh' });
    readSpy.mockClear();
    const admin = await loginAs(r.cloud.app, 'admin');
    const live = await loginAs(r.cloud.app, 'live');
    expect((await req(r, 'GET', '/api/live/youtube/status', admin.headers)).statusCode).toBe(200);
    expect((await req(r, 'GET', '/api/live/status', admin.headers)).statusCode).toBe(200);
    const begin = await req(r, 'POST', '/api/youtube/upload/begin', live.headers, { kuliahId: null, part: null, bytes: 1000, replaceLiveVideoId: null });
    // catch-up is off by default (409 catchup_off) or at the box (409 youtube_at_box): never served by the cloud
    expect(begin.statusCode).toBe(409);
    const verify = await req(r, 'POST', '/api/youtube/verify', live.headers, { videoIds: ['abc'] });
    expect(verify.statusCode).toBe(409);
    expect(verify.json().code).toBe('youtube_at_box');
    const bc = await req(r, 'POST', '/api/cloud/youtube/broadcast', r.a.headers, { sessionId: 's1', meta: { title: 'K', description: '', privacy: 'unlisted' } });
    expect(bc.statusCode).toBe(409);
    expect((await handover(r, r.a)).statusCode).toBe(404);
    expect(reads()).toEqual([]);
    expect(r.g.calls.filter((c) => c.path.startsWith('/youtube/'))).toEqual([]);
  });

  it('a POST with an empty JSON body ({} and Content-Type application/json, as the box sends it) is answered like a bodyless one', async () => {
    const r = await rig();
    const withJson = await r.cloud.app.inject({ method: 'POST', url: '/api/sync/youtube/handover', headers: { ...r.a.headers, 'content-type': 'application/json' }, payload: '{}' });
    const bodyless = await handover(r, r.a);
    expect(withJson.statusCode).toBe(200);
    expect(withJson.json()).toMatchObject({ boxId: expect.any(String), sealed: expect.anything() });
    expect(bodyless.statusCode).toBe(200); // the same offer again (still unacknowledged)
    const r2 = await rig({ grant: false });
    const none = await r2.cloud.app.inject({ method: 'POST', url: '/api/sync/youtube/handover', headers: { ...r2.a.headers, 'content-type': 'application/json' }, payload: '{}' });
    expect(none.statusCode).toBe(404);
    expect(none.json()).toMatchObject({ code: 'none' });
  });

  it('only to a site of that surau: another surau, a revoked site and a device session get nothing', async () => {
    const r = await rig();
    const b = r.site(BOX_B, OTHER);
    // the other surau's site has no grant of its own to receive, and never this one's
    expect((await handover(r, b)).statusCode).toBe(404);
    const revoked = r.site(BOX_A2);
    r.cloud.app.surau.db.prepare('UPDATE sites SET revoked_at = ? WHERE box_id = ?').run('2026-11-19T00:00:00.000Z', BOX_A2);
    expect((await handover(r, revoked)).statusCode).not.toBe(200);
    const admin = await loginAs(r.cloud.app, 'admin');
    expect((await req(r, 'POST', '/api/sync/youtube/handover', admin.headers)).statusCode).toBe(404);
    // nothing was offered, the grant is still the cloud's
    expect(r.cloud.app.surau.db.prepare('SELECT COUNT(*) AS n FROM youtube_handover').get()!.n).toBe(0);
    expect(existsSync(tokenPath(r))).toBe(true);
  });

  it('D4: the first box to ask claims it; a second box of the surau gets 409 claimed and the flag only', async () => {
    const r = await rig();
    const a2 = r.site(BOX_A2);
    expect((await handover(r, r.a)).statusCode).toBe(200);
    const second = await handover(r, a2);
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('claimed');
    expect(second.body).not.toContain('sealed');
    // a foreign acknowledgement changes nothing
    const h = r.cloud.app.surau.db.prepare('SELECT handover_id FROM youtube_handover').get()!.handover_id as string;
    expect((await ack(r, a2, { handoverId: h, ok: true })).statusCode).toBe(404);
    expect(existsSync(tokenPath(r))).toBe(true);
  });

  it('preconditions: not while a broadcast the cloud made is open (an old box live)', async () => {
    const r = await rig();
    const bc = await req(r, 'POST', '/api/cloud/youtube/broadcast', r.a.headers, { sessionId: 's1', meta: { title: 'Kuliah', description: '', privacy: 'unlisted' } });
    expect(bc.statusCode).toBe(200);
    const res = await handover(r, r.a);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('live_busy');
    await req(r, 'POST', '/api/cloud/youtube/complete', r.a.headers, { broadcastId: bc.json().broadcastId });
    expect((await handover(r, r.a)).statusCode).toBe(200);
  });

  it('a box that could not prove it yet (network) leaves the cloud copy; invalid_grant deletes it (no revoke) and flags withdrawn', async () => {
    const r = await rig();
    const h = (await handover(r, r.a)).json() as { handoverId: string };
    expect((await ack(r, r.a, { handoverId: h.handoverId, ok: false, code: 'network' })).json()).toEqual({ acknowledged: false });
    expect(existsSync(tokenPath(r))).toBe(true);
    // Google really withdrew it: the cloud's own refresh fails too (S2: it asks first)
    r.g.refreshError = 'invalid_grant';
    expect((await ack(r, r.a, { handoverId: h.handoverId, ok: false, code: 'invalid_grant' })).json()).toEqual({ acknowledged: true });
    expect(existsSync(tokenPath(r))).toBe(false);
    expect(r.g.count('/revoke')).toBe(0);
    const admin = await loginAs(r.cloud.app, 'admin');
    expect((await req(r, 'GET', '/api/live/youtube/status', admin.headers)).json()).toMatchObject({ signedIn: false, lastError: 'reauthorise', heldBy: 'box' });
  });

  it('a cloud grant Google already withdrew: 410, deleted without a revoke, the flag says withdrawn', async () => {
    const r = await rig();
    // the cloud learns it on its own refresh (an old box live start)
    r.g.refreshError = 'invalid_grant';
    r.clock.t += 2 * 3_600_000;
    const bc = await req(r, 'POST', '/api/cloud/youtube/broadcast', r.a.headers, { sessionId: 's1', meta: { title: 'K', description: '', privacy: 'unlisted' } });
    expect(bc.statusCode).toBe(503);
    const res = await handover(r, r.a);
    expect(res.statusCode).toBe(410);
    expect(res.json().code).toBe('youtube_reauthorise');
    expect(existsSync(tokenPath(r))).toBe(false);
    expect(r.g.count('/revoke')).toBe(0);
    const admin = await loginAs(r.cloud.app, 'admin');
    expect((await req(r, 'GET', '/api/live/youtube/status', admin.headers)).json()).toMatchObject({ signedIn: false, lastError: 'reauthorise' });
  });

  it('bad acknowledgements are 400; an unknown handover id is 404', async () => {
    const r = await rig();
    await handover(r, r.a);
    for (const bad of [{}, { handoverId: 'x', ok: true }, { handoverId: 'ho_aaaaaaaaaaaa', ok: 'yes' }, { handoverId: 'ho_aaaaaaaaaaaa', ok: true, channelTitle: 7 }]) {
      expect((await ack(r, r.a, bad)).statusCode).toBe(400);
    }
    expect((await ack(r, r.a, { handoverId: 'ho_aaaaaaaaaaaa', ok: true })).statusCode).toBe(404);
    expect(existsSync(tokenPath(r))).toBe(true);
  });
});

describe('D2: the OAuth client is delivered sealed to a linked box', () => {
  it('only that box opens it; another surau site gets it sealed to its own key; no client secret in the clear', async () => {
    const r = await rig({ grant: false });
    const res = await req(r, 'GET', '/api/sync/youtube/client', r.a.headers);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('csecret-SECRET');
    const { sealed, boxId } = res.json() as { sealed: string; boxId: string };
    expect(boxId).toBe(BOX_A);
    expect(openClient(r.a.keys.privateJwk, sealed, BOX_A)).toBe(CLIENT);
    expect(() => openClient(generateSyncKeyPair().privateJwk, sealed, BOX_A)).toThrow();
    expect(() => openClient(r.a.keys.privateJwk, sealed, BOX_A2)).toThrow();
    // no client file on the cloud: 404 none (an unlinked box keeps an operator-placed file)
    fs.rmSync(join(r.cloud.dir, 'secret', 'youtube-client.json'));
    expect((await req(r, 'GET', '/api/sync/youtube/client', r.a.headers)).statusCode).toBe(404);
    expect(r.logs.join('\n')).not.toContain('csecret-SECRET');
  });
});

describe('gate round 2 (cloud half)', () => {
  it('Q1: a token file that will not open answers 503 grant_unreadable, never 404 none; a good one still hands over', async () => {
    const r = await rig();
    const good = readFileSync(tokenPath(r));
    writeFileSync(tokenPath(r), 'not-a-sealed-file');
    const bad = await handover(r, r.a);
    expect(bad.statusCode).toBe(503);
    expect(bad.json().code).toBe('grant_unreadable');
    writeFileSync(tokenPath(r), good);
    expect((await handover(r, r.a)).statusCode).toBe(200);
    // nothing at all stays 404 none
    const none = await rig({ grant: false });
    const res = await handover(none, none.a);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('none');
  });

  it('Q6: with no handover any linked box may push the flag; with one only its box; an unacknowledged offer stops blocking after 6 hours', async () => {
    const r = await rig({ grant: false });
    const a2 = r.site(BOX_A2);
    expect((await req(r, 'PUT', '/api/sync/youtube/flag', a2.headers, { signedIn: true, channelTitle: 'Saluran' })).statusCode).toBe(200);
    seedCloudGrant(r.cloud.dir, r.clock.now);
    expect((await handover(r, r.a)).statusCode).toBe(200);
    // box A holds the offer: the other box neither takes the grant nor overwrites the flag
    const blocked = await handover(r, a2);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('claimed');
    expect((await req(r, 'PUT', '/api/sync/youtube/flag', a2.headers, { signedIn: false, channelTitle: null })).statusCode).toBe(409);
    expect((await req(r, 'PUT', '/api/sync/youtube/flag', r.a.headers, { signedIn: true, channelTitle: 'Saluran A' })).statusCode).toBe(200);
    r.clock.t += 6 * 3_600_000 + 1000;
    const taken = await handover(r, a2);
    expect(taken.statusCode).toBe(200);
    expect(taken.json().boxId).toBe(BOX_A2);
  });

  it('S2: the retired grant is kept as a sealed copy for 7 days, then deleted; no token in the copy', async () => {
    const r = await rig();
    const h = (await handover(r, r.a)).json() as { handoverId: string };
    expect((await ack(r, r.a, { handoverId: h.handoverId, ok: true, channelTitle: 'Surau' })).json()).toEqual({ acknowledged: true });
    expect(existsSync(tokenPath(r))).toBe(false);
    const q = join(r.cloud.dir, 'secret', 'quarantine');
    const files = readdirSync(q);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(q, files[0]!), 'latin1')).not.toContain(FAKE_REFRESH);
    sweepQuarantine(r.cloud.dir, Date.now() + 6 * 24 * 3_600_000);
    expect(readdirSync(q)).toHaveLength(1);
    sweepQuarantine(r.cloud.dir, Date.now() + 8 * 24 * 3_600_000);
    expect(readdirSync(q)).toHaveLength(0);
  });

  it('S2: a box says invalid_grant but the cloud refresh works: the cloud keeps the grant and does not acknowledge', async () => {
    const r = await rig();
    const h = (await handover(r, r.a)).json() as { handoverId: string };
    expect((await ack(r, r.a, { handoverId: h.handoverId, ok: false, code: 'invalid_grant' })).json()).toEqual({ acknowledged: false });
    expect(existsSync(tokenPath(r))).toBe(true);
    expect(r.g.count('/revoke')).toBe(0);
  });

  it('M4 + S3: one client size limit; an operator plaintext file is sealed at rest and still delivered', async () => {
    const r = await rig({ grant: false });
    const res = await req(r, 'GET', '/api/sync/youtube/client', r.a.headers);
    expect(res.statusCode).toBe(200);
    expect(openClient(r.a.keys.privateJwk, res.json().sealed, BOX_A)).toBe(CLIENT);
    expect(readFileSync(join(r.cloud.dir, 'secret', 'youtube-client.json'), 'utf8')).not.toContain('csecret-SECRET');
    // the largest file the cloud seals is one the box opens
    const big = JSON.stringify({ installed: { client_id: 'c', client_secret: 'x'.repeat(CLIENT_FILE_MAX - 60) } });
    expect(Buffer.byteLength(big)).toBeLessThanOrEqual(CLIENT_FILE_MAX);
    expect(openClient(r.a.keys.privateJwk, sealClient(r.a.keys.publicJwk, big, BOX_A), BOX_A)).toBe(big);
    // a bigger one is not delivered at all
    writeFileSync(join(r.cloud.dir, 'secret', 'youtube-client.json'), JSON.stringify({ installed: { client_id: 'c', client_secret: 'x'.repeat(CLIENT_FILE_MAX) } }));
    expect((await req(r, 'GET', '/api/sync/youtube/client', r.a.headers)).statusCode).toBe(404);
  });
});

describe('release audit follow-ups (cloud half)', () => {
  it('F7: a proof that merely failed keeps the cloud grant and does not acknowledge; only the cloud own invalid_grant retires it', async () => {
    const r = await rig();
    const h = (await handover(r, r.a)).json() as { handoverId: string };
    // Google answers with something other than invalid_grant (a failed proof): the box word alone retires nothing
    r.g.refreshError = 'temporarily_unavailable';
    expect((await ack(r, r.a, { handoverId: h.handoverId, ok: false, code: 'invalid_grant' })).json()).toEqual({ acknowledged: false });
    expect(existsSync(tokenPath(r))).toBe(true);
    expect(r.cloud.app.surau.db.prepare('SELECT state FROM youtube_handover').get()).toEqual({ state: 'offered' });
    // the cloud own proof says invalid_grant: now it retires
    r.g.refreshError = 'invalid_grant';
    expect((await ack(r, r.a, { handoverId: h.handoverId, ok: false, code: 'invalid_grant' })).json()).toEqual({ acknowledged: true });
    expect(existsSync(tokenPath(r))).toBe(false);
  });

  it('F10: an acknowledged holder blocks the other box until its site is revoked or unseen for 30 days', async () => {
    const r = await rig();
    const a2 = r.site(BOX_A2);
    const h = (await handover(r, r.a)).json() as { handoverId: string };
    expect((await ack(r, r.a, { handoverId: h.handoverId, ok: true, channelTitle: 'Saluran A' })).statusCode).toBe(200);
    const db = r.cloud.app.surau.db;
    const flag = () => req(r, 'PUT', '/api/sync/youtube/flag', a2.headers, { signedIn: true, channelTitle: 'Saluran B' });
    const seen = (days: number) => db.prepare('UPDATE sites SET last_seen_at = ? WHERE box_id = ?').run(new Date(r.clock.t - days * 86_400_000).toISOString(), BOX_A);
    // the holder was seen 29 days ago: the holder rule stays
    seen(29);
    expect((await flag()).statusCode).toBe(409);
    // 31 days of silence: the other box flag is taken
    seen(31);
    expect((await flag()).statusCode).toBe(200);
    expect(db.prepare('SELECT box_id FROM youtube_flag').get()).toEqual({ box_id: BOX_A2 });
  });

  it('F10: a revoked holder no longer blocks the other box, even when it was seen today', async () => {
    const r = await rig();
    const b2 = r.site(BOX_A2);
    const h = (await handover(r, r.a)).json() as { handoverId: string };
    await ack(r, r.a, { handoverId: h.handoverId, ok: true });
    expect((await req(r, 'PUT', '/api/sync/youtube/flag', b2.headers, { signedIn: true, channelTitle: 'B' })).statusCode).toBe(409);
    r.cloud.app.surau.db.prepare('UPDATE sites SET revoked_at = ? WHERE box_id = ?').run(r.clock.now().toISOString(), BOX_A);
    expect((await req(r, 'PUT', '/api/sync/youtube/flag', b2.headers, { signedIn: true, channelTitle: 'B' })).statusCode).toBe(200);
  });
});
