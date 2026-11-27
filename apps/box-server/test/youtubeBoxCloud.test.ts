import * as fs from 'node:fs';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { klInstant } from '@surau/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

// every file read of the whole cloud app goes through this wrapper: the test below proves which paths are read
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real, readFileSync: vi.fn(real.readFileSync) };
});
import { buildApp } from '../src/app.ts';
import { sweepQuarantine } from '../src/live/youtube/quarantine.ts';
import { CLIENT_FILE_MAX, openClient, sealClient } from '../src/sync/youtubeSeal.ts';
import { generateSyncKeyPair } from '../src/sync/syncKey.ts';
import { loginAs } from './authHelpers.ts';
import { buildCloud } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FAKE_REFRESH, startFakeGoogle } from './support/fakeGoogle.ts';
import type { FakeGoogle } from './support/fakeGoogle.ts';
import { withUploadApi } from './support/fakeGoogleUpload.ts';
import { insertSite } from './support/sites.ts';
import type { TestSite } from './support/sites.ts';

/**
 * The cloud's half of "YouTube held by the box" (release 2026.11.13), after phase 4 (2026.11.15): the cloud holds NO
 * YouTube sign-in. It refuses every sign-in, keeps a non-secret flag, delivers the OAuth client sealed to a linked
 * box, answers the old handover and the old box leg with plain refusals, and removes what an earlier release left.
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
const tokenName = (surauId: string): string => `youtube-token-${surauId}.json`;

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

async function rig(): Promise<Rig> {
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
  return { cloud, g, clock, a: site(BOX_A), logs, site };
}

const tokenPath = (r: Rig, surauId = 'sdm'): string => join(r.cloud.dir, 'secret', tokenName(surauId));
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
    const r = await rig();
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
    const r = await rig();
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
    const r = await rig();
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
    const r = await rig();
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

describe('the old handover and the old box leg: refused, nothing served', () => {
  it('the handover answers "nothing to move" (404 none) to a linked site, with a JSON body or none; no token is sealed or read', async () => {
    const r = await rig();
    const withJson = await r.cloud.app.inject({ method: 'POST', url: '/api/sync/youtube/handover', headers: { ...r.a.headers, 'content-type': 'application/json' }, payload: '{}' });
    expect(withJson.statusCode).toBe(404);
    expect(withJson.json()).toEqual({ code: 'none' });
    const bodyless = await handover(r, r.a);
    expect(bodyless.statusCode).toBe(404);
    expect(bodyless.json()).toEqual({ code: 'none' });
    expect(r.cloud.app.surau.db.prepare('SELECT COUNT(*) AS n FROM youtube_handover').get()!.n).toBe(0);
    expect(withJson.body + bodyless.body).not.toContain('sealed');
  });

  it('only to a linked site of that surau: a revoked site and a device session get no "nothing to move"', async () => {
    const r = await rig();
    const revoked = r.site(BOX_A2);
    r.cloud.app.surau.db.prepare('UPDATE sites SET revoked_at = ? WHERE box_id = ?').run('2026-11-19T00:00:00.000Z', BOX_A2);
    expect((await handover(r, revoked)).json()).not.toEqual({ code: 'none' });
    const admin = await loginAs(r.cloud.app, 'admin');
    expect((await req(r, 'POST', '/api/sync/youtube/handover', admin.headers)).json()).not.toEqual({ code: 'none' });
  });

  it('the old box leg (a box before 2026.11.13) is refused with youtube_at_box and the sentence for an old app; Google is never asked', async () => {
    const r = await rig();
    const meta = { title: 'Kuliah', description: '', privacy: 'unlisted' };
    for (const [m, url, body] of [
      ['POST', '/api/cloud/youtube/broadcast', { sessionId: 's1', meta }],
      ['POST', '/api/cloud/youtube/complete', { broadcastId: 'bc-1' }],
      ['GET', '/api/cloud/youtube/status', undefined],
    ] as const) {
      const res = await req(r, m, url, r.a.headers, body);
      expect([url, res.statusCode]).toEqual([url, 409]);
      expect(res.json()).toEqual({ errors: ['Log masuk YouTube kini dibuat pada MAXCOM di surau. Kemas kini aplikasi dan cuba di Wi-Fi surau.'], code: 'youtube_at_box' });
    }
    // a device session does not know these routes
    const admin = await loginAs(r.cloud.app, 'admin');
    expect((await req(r, 'GET', '/api/cloud/youtube/status', admin.headers)).statusCode).not.toBe(409);
    expect(r.g.calls).toHaveLength(0);
    expect(r.cloud.app.surau.db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'youtube/broadcast'").get()!.n).toBe(0);
  });

  it('the catch-up routes on the cloud answer from no grant: youtube_at_box, never a served upload', async () => {
    const r = await rig();
    const live = await loginAs(r.cloud.app, 'live');
    const verify = await req(r, 'POST', '/api/youtube/verify', live.headers, { videoIds: ['abc'] });
    expect(verify.statusCode).toBe(409);
    expect(verify.json().code).toBe('youtube_at_box');
    expect(r.g.calls.filter((c) => c.path.startsWith('/youtube/'))).toEqual([]);
  });

  it('a token file an earlier release left is never read: not at start, not by status, upload, verify or the old leg', async () => {
    const r = await rig();
    // the leftover of an earlier release (sealed by the old cloud; here only its name and place matter)
    writeFileSync(tokenPath(r), 'leftover-sealed-grant');
    const readSpy = vi.mocked(fs.readFileSync);
    readSpy.mockClear();
    const app2 = buildApp(join(r.cloud.dir, 'cloud.db'), { dataDir: r.cloud.dir, role: 'cloud', boxId: 'boxid0001', now: r.clock.now, fetchImpl: withUploadApi(r.g).fetchImpl });
    // closed before the cloud that owns the data folder removes it
    closers.unshift(() => app2.close());
    await app2.ready();
    const reads = (): string[] => readSpy.mock.calls.map((c) => String(c[0])).filter((p) => p.includes('youtube-token-'));
    const admin = await loginAs(app2, 'admin');
    const live = await loginAs(app2, 'live');
    expect((await app2.inject({ method: 'GET', url: '/api/live/youtube/status', headers: admin.headers })).statusCode).toBe(200);
    expect((await app2.inject({ method: 'GET', url: '/api/live/status', headers: admin.headers })).statusCode).toBe(200);
    expect((await app2.inject({ method: 'POST', url: '/api/youtube/upload/begin', headers: live.headers, payload: { kuliahId: null, part: null, bytes: 1000, replaceLiveVideoId: null } })).statusCode).toBe(409);
    expect((await app2.inject({ method: 'POST', url: '/api/youtube/verify', headers: live.headers, payload: { videoIds: ['abc'] } })).json().code).toBe('youtube_at_box');
    expect((await app2.inject({ method: 'POST', url: '/api/cloud/youtube/broadcast', headers: r.a.headers, payload: { sessionId: 's1', meta: { title: 'K', description: '', privacy: 'unlisted' } } })).statusCode).toBe(409);
    expect(reads()).toEqual([]);
    expect(r.g.calls.filter((c) => c.path.startsWith('/youtube/') || c.path === '/token')).toEqual([]);
  });

  it('the acknowledgement only closes an offer an earlier cloud wrote; nothing is deleted or revoked', async () => {
    const r = await rig();
    const offer = (id: string, box = BOX_A): void => {
      r.cloud.app.surau.db
        .prepare("INSERT OR REPLACE INTO youtube_handover (surau_id, box_id, handover_id, state, offered_at, acked_at) VALUES ('sdm', ?, ?, 'offered', ?, NULL)")
        .run(box, id, r.clock.now().toISOString());
    };
    offer('ho_earlier0001');
    // a box that could not prove it yet (network): the box asks again later
    expect((await ack(r, r.a, { handoverId: 'ho_earlier0001', ok: false, code: 'network' })).json()).toEqual({ acknowledged: false });
    expect(r.cloud.app.surau.db.prepare('SELECT state FROM youtube_handover').get()).toEqual({ state: 'offered' });
    // proved: closed, the flag says signed in, and the same answer again changes nothing
    expect((await ack(r, r.a, { handoverId: 'ho_earlier0001', ok: true, channelTitle: 'Surau Contoh' })).json()).toEqual({ acknowledged: true });
    expect((await ack(r, r.a, { handoverId: 'ho_earlier0001', ok: true, channelTitle: 'Surau Contoh' })).json()).toEqual({ acknowledged: true });
    const admin = await loginAs(r.cloud.app, 'admin');
    expect((await req(r, 'GET', '/api/live/youtube/status', admin.headers)).json()).toMatchObject({ signedIn: true, channelTitle: 'Surau Contoh', heldBy: 'box' });
    // Google withdrew it: closed too and the flag says withdrawn
    offer('ho_earlier0002');
    expect((await ack(r, r.a, { handoverId: 'ho_earlier0002', ok: false, code: 'invalid_grant' })).json()).toEqual({ acknowledged: true });
    expect((await req(r, 'GET', '/api/live/youtube/status', admin.headers)).json()).toMatchObject({ signedIn: false, lastError: 'reauthorise', heldBy: 'box' });
    expect(r.g.calls).toHaveLength(0);
    expect(cloudText(r)).not.toContain(FAKE_REFRESH);
  });

  it('bad acknowledgements are 400; an unknown handover id, or one of another box, is 404', async () => {
    const r = await rig();
    for (const bad of [{}, { handoverId: 'x', ok: true }, { handoverId: 'ho_aaaaaaaaaaaa', ok: 'yes' }, { handoverId: 'ho_aaaaaaaaaaaa', ok: true, channelTitle: 7 }]) {
      expect((await ack(r, r.a, bad)).statusCode).toBe(400);
    }
    expect((await ack(r, r.a, { handoverId: 'ho_aaaaaaaaaaaa', ok: true })).statusCode).toBe(404);
    const a2 = r.site(BOX_A2);
    r.cloud.app.surau.db
      .prepare("INSERT INTO youtube_handover (surau_id, box_id, handover_id, state, offered_at, acked_at) VALUES ('sdm', ?, 'ho_earlier0003', 'offered', ?, NULL)")
      .run(BOX_A, r.clock.now().toISOString());
    expect((await ack(r, a2, { handoverId: 'ho_earlier0003', ok: true })).statusCode).toBe(404);
  });
});

describe('D2: the OAuth client is delivered sealed to a linked box', () => {
  it('only that box opens it; another surau site gets it sealed to its own key; no client secret in the clear', async () => {
    const r = await rig();
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
  it('Q6: with no handover any linked box may push the flag; with one only its box; an unacknowledged offer stops blocking after 6 hours', async () => {
    const r = await rig();
    const a2 = r.site(BOX_A2);
    expect((await req(r, 'PUT', '/api/sync/youtube/flag', a2.headers, { signedIn: true, channelTitle: 'Saluran' })).statusCode).toBe(200);
    // box A holds an offer an earlier cloud made
    r.cloud.app.surau.db
      .prepare("INSERT INTO youtube_handover (surau_id, box_id, handover_id, state, offered_at, acked_at) VALUES ('sdm', ?, 'ho_earlier0001', 'offered', ?, NULL)")
      .run(BOX_A, r.clock.now().toISOString());
    // the other box does not overwrite the flag
    expect((await req(r, 'PUT', '/api/sync/youtube/flag', a2.headers, { signedIn: false, channelTitle: null })).statusCode).toBe(409);
    expect((await req(r, 'PUT', '/api/sync/youtube/flag', r.a.headers, { signedIn: true, channelTitle: 'Saluran A' })).statusCode).toBe(200);
    r.clock.t += 6 * 3_600_000 + 1000;
    expect((await req(r, 'PUT', '/api/sync/youtube/flag', a2.headers, { signedIn: false, channelTitle: null })).statusCode).toBe(200);
  });

  it('S2: a quarantine copy an earlier release left is deleted after 7 days; no sooner', async () => {
    const r = await rig();
    const q = join(r.cloud.dir, 'secret', 'quarantine');
    mkdirSync(q, { recursive: true });
    const copy = join(q, `${tokenName('sdm')}.1763500000000`);
    writeFileSync(copy, 'sealed-old-copy');
    const t0 = Date.now();
    utimesSync(copy, new Date(t0), new Date(t0));
    sweepQuarantine(r.cloud.dir, t0 + 6 * 24 * 3_600_000);
    expect(readdirSync(q)).toHaveLength(1);
    sweepQuarantine(r.cloud.dir, t0 + 8 * 24 * 3_600_000);
    expect(readdirSync(q)).toHaveLength(0);
    // and a missing folder is nothing to sweep
    sweepQuarantine(join(r.cloud.dir, 'nowhere'));
  });

  it('M4 + S3: one client size limit; an operator plaintext file is sealed at rest and still delivered', async () => {
    const r = await rig();
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
  const acked = (r: Rig, box: string): void => {
    r.cloud.app.surau.db
      .prepare("INSERT OR REPLACE INTO youtube_handover (surau_id, box_id, handover_id, state, offered_at, acked_at) VALUES ('sdm', ?, 'ho_earlier0009', 'acked', ?, ?)")
      .run(box, r.clock.now().toISOString(), r.clock.now().toISOString());
  };

  it('F10: an acknowledged holder blocks the other box until its site is revoked or unseen for 30 days', async () => {
    const r = await rig();
    const a2 = r.site(BOX_A2);
    acked(r, BOX_A);
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
    acked(r, BOX_A);
    expect((await req(r, 'PUT', '/api/sync/youtube/flag', b2.headers, { signedIn: true, channelTitle: 'B' })).statusCode).toBe(409);
    r.cloud.app.surau.db.prepare('UPDATE sites SET revoked_at = ? WHERE box_id = ?').run(r.clock.now().toISOString(), BOX_A);
    expect((await req(r, 'PUT', '/api/sync/youtube/flag', b2.headers, { signedIn: true, channelTitle: 'B' })).statusCode).toBe(200);
  });
});

describe('Y7 (2026.11.15): a sign-out at the box leaves no copy of an old grant on the cloud', () => {
  const secret = (r: Rig): string => join(r.cloud.dir, 'secret');
  const quarantine = (r: Rig): string => join(secret(r), 'quarantine');
  /** What an earlier release may have left: a token file of the surau, its quarantine copies, and another surau's. */
  const seedLeftovers = (r: Rig): void => {
    mkdirSync(quarantine(r), { recursive: true });
    writeFileSync(tokenPath(r), 'sealed-old-grant');
    writeFileSync(join(quarantine(r), `${tokenName('sdm')}.1763500000000`), 'sealed-old-copy');
    writeFileSync(join(quarantine(r), `${tokenName(OTHER)}.1763500000000`), 'sealed-other-surau');
  };

  it('signedOut wipes the token file and the quarantine copies of that surau only, with no revoke', async () => {
    const r = await rig();
    seedLeftovers(r);
    const put = await req(r, 'PUT', '/api/sync/youtube/flag', r.a.headers, { signedIn: false, channelTitle: null, revoked: false, signedOut: true });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ stored: true, wiped: true });
    expect(existsSync(tokenPath(r))).toBe(false);
    expect(readdirSync(quarantine(r))).toEqual([`${tokenName(OTHER)}.1763500000000`]);
    expect(r.g.calls.filter((c) => c.path === '/revoke')).toHaveLength(0);
    const admin = await loginAs(r.cloud.app, 'admin');
    expect((await req(r, 'GET', '/api/live/youtube/status', admin.headers)).json()).toMatchObject({ signedIn: false, heldBy: 'box' });
    // the token is in no log line and no change-log row
    expect(r.logs.join('\n') + JSON.stringify(r.cloud.app.surau.db.prepare('SELECT * FROM change_log').all())).not.toContain(FAKE_REFRESH);
  });

  it('a signed-out flag without signedOut (a box that never signed in, a withdrawn grant) wipes nothing', async () => {
    const r = await rig();
    seedLeftovers(r);
    for (const body of [{ signedIn: false, channelTitle: null, revoked: false }, { signedIn: false, channelTitle: null, revoked: true }, { signedIn: false, channelTitle: null, signedOut: false }]) {
      const put = await req(r, 'PUT', '/api/sync/youtube/flag', r.a.headers, body);
      expect(put.statusCode, JSON.stringify(body)).toBe(200);
    }
    expect(existsSync(tokenPath(r))).toBe(true);
    expect(readdirSync(quarantine(r))).toHaveLength(2);
  });

  it('signedOut together with signedIn true, or not a boolean, is 400; a box that does not hold the flag cannot wipe', async () => {
    const r = await rig();
    seedLeftovers(r);
    for (const bad of [{ signedIn: true, channelTitle: 'x', signedOut: true }, { signedIn: false, signedOut: 'yes' }, { signedIn: false, signedOut: 1 }]) {
      expect((await req(r, 'PUT', '/api/sync/youtube/flag', r.a.headers, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    // another linked box of the surau holds the flag (D4): this one is refused before anything is touched
    const holder = r.site(BOX_A2);
    r.cloud.app.surau.db
      .prepare("INSERT OR REPLACE INTO youtube_handover (surau_id, box_id, handover_id, state, offered_at, acked_at) VALUES ('sdm', ?, 'ho_other00001', 'acked', ?, ?)")
      .run(holder.boxId, r.clock.now().toISOString(), r.clock.now().toISOString());
    const put = await req(r, 'PUT', '/api/sync/youtube/flag', r.a.headers, { signedIn: false, channelTitle: null, signedOut: true });
    expect(put.statusCode).toBe(409);
    expect(existsSync(tokenPath(r))).toBe(true);
  });
});
