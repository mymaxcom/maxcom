import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readClientText } from '../src/live/youtube/clientFile.ts';
import { YoutubeBoxLink } from '../src/sync/youtubeBoxLink.ts';
import type { YoutubeBoxLinkOptions } from '../src/sync/youtubeBoxLink.ts';
import { tokenFileFor } from '../src/live/youtube/registry.ts';
import { putFeature } from '../src/settingsStore.ts';
import { generateSyncKeyPair, saveSyncKey } from '../src/sync/syncKey.ts';
import { loginAs } from './authHelpers.ts';
import { seedCloudGrant } from './support/cloudGrant.ts';
import { buildCloud, CLOUD_URL } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FAKE_REFRESH, FAKE_STREAM_KEY, startFakeGoogle } from './support/fakeGoogle.ts';
import type { FakeGoogle } from './support/fakeGoogle.ts';
import { withUploadApi } from './support/fakeGoogleUpload.ts';
import { startBody, startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';
import { insertSite } from './support/sites.ts';

/**
 * Release 2026.11.13, phase 2 (the box): the grant lives on the box. A grant the cloud held moves here with no
 * re-sign-in (sealed to this box, proved with one refresh, acknowledged, then deleted on the cloud WITHOUT a revoke);
 * the box makes every YouTube call itself, so a live starts with the cloud unreachable; the box pushes a flag that
 * never carries a token; the catch-up steps answer on the box.
 */

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0)) await c();
});

const CLIENT = JSON.stringify({ installed: { client_id: 'cid-123.apps.googleusercontent.com', client_secret: 'csecret-SECRET' } });
const LAN = '10.168.1.40';

interface Rig {
  h: LiveHarness;
  cloud: TestCloud;
  g: FakeGoogle;
  /** The fetch the box uses for the cloud; swap `impl` to break the link. */
  hook: { impl: typeof fetch };
  logs: string[];
}

async function rig(o: { grant?: boolean; linked?: boolean } = {}): Promise<Rig> {
  const g = await startFakeGoogle();
  const up = withUploadApi(g);
  const cloud = buildCloud('boxid0001', { fetchImpl: up.fetchImpl });
  const hook = { impl: cloud.fetch };
  const h = await startLiveHarness({
    app: {
      fetchImpl: up.fetchImpl,
      cloud: { url: CLOUD_URL },
      sync: { auto: false, youtubeWaitMs: 0, fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => hook.impl(i, n)) as typeof fetch },
    },
  });
  closers.push(h.close, cloud.close, g.close);
  // the operator's client is on the cloud only: the box takes it sealed (D2)
  mkdirSync(join(cloud.dir, 'secret'), { recursive: true });
  writeFileSync(join(cloud.dir, 'secret', 'youtube-client.json'), CLIENT);
  if (o.grant !== false) seedCloudGrant(cloud.dir, () => new Date());
  if (o.linked !== false) {
    const site = insertSite(cloud.app.surau.db, { boxId: h.app.surau.boxId });
    const keys = generateSyncKeyPair();
    saveSyncKey(h.dataDir, { ...keys, cloudUrl: CLOUD_URL, siteToken: site.token, wakeSecret: 'wake-secret-1', linkedAt: '2026-11-05T00:00:00.000Z' });
    cloud.app.surau.db.prepare('UPDATE sites SET public_jwk = ? WHERE box_id = ?').run(JSON.stringify(keys.publicJwk), h.app.surau.boxId);
  }
  putFeature(h.app.surau.db, 'liveYoutube', { enabled: true, privacy: 'unlisted' }, 'test', undefined, 'sdm');
  const logs: string[] = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
  }
  return { h, cloud, g, hook, logs };
}

const link = (r: Rig) => r.h.app.youtubeBoxLink!;
const cloudToken = (r: Rig): string => join(r.cloud.dir, 'secret', tokenFileFor('sdm'));
const boxStatus = async (r: Rig, headers: Record<string, string>) =>
  (await r.h.app.inject({ method: 'GET', url: '/api/live/youtube/status', headers, remoteAddress: LAN })).json() as Record<string, unknown>;
const start = (r: Rig, headers: Record<string, string>) =>
  r.h.app.inject({ method: 'POST', url: '/api/live/start', headers, payload: startBody(r.h, { outputs: { kiosk: true, youtube: true } }), remoteAddress: LAN });
const refreshes = (r: Rig): number => r.g.calls.filter((c) => c.path === '/token' && new URLSearchParams(c.body).get('grant_type') === 'refresh_token').length;

async function ytSettled(r: Rig, headers: Record<string, string>): Promise<{ state: string; ingest: string | null; key: string | null }> {
  for (let i = 0; i < 400; i++) {
    const g = (await r.h.app.inject({ method: 'GET', url: '/api/live/youtube/ingest', headers, remoteAddress: LAN })).json();
    if (g.state !== 'starting') return g;
    await new Promise((res) => setTimeout(res, 15));
  }
  throw new Error('the YouTube leg never settled');
}

/** Every text file and table of the box and the cloud that could carry a secret. */
function everything(r: Rig): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(json|ini|log|key)$/.test(e.name)) files.push(readFileSync(p, 'latin1'));
    }
  };
  walk(r.h.dataDir);
  walk(r.cloud.dir);
  const rows = (app: Rig['h']['app'], t: string): string => JSON.stringify(app.surau.db.prepare(`SELECT * FROM ${t}`).all());
  return [rows(r.h.app, 'change_log'), rows(r.h.app, 'sync_state'), rows(r.cloud.app, 'change_log'), rows(r.cloud.app, 'youtube_flag'), rows(r.cloud.app, 'youtube_handover'), r.logs.join('\n'), ...files].join('\n');
}

describe('the grant moves to the box with no re-sign-in', () => {
  it('client delivered, grant handed over and proved by one refresh, cloud copy deleted with ZERO revoke calls, flag pushed', async () => {
    const r = await rig();
    const admin = await loginAs(r.h.app, 'admin');
    expect(await boxStatus(r, admin.headers)).toMatchObject({ configured: false, signedIn: false });
    await link(r).cycle();
    // D2: the operator's client is now on the box
    // S3: kept sealed at rest, and it reads back as the operator's file
    expect(readFileSync(join(r.h.dataDir, 'secret', 'youtube-client.json'), 'utf8')).not.toContain('csecret-SECRET');
    expect(readClientText(r.h.dataDir)).toBe(CLIENT);
    // the box holds the grant and proved it at Google itself
    expect(await boxStatus(r, admin.headers)).toMatchObject({ configured: true, signedIn: true, channelTitle: 'Surau Contoh', lastError: null, heldBy: 'box', signInHere: true });
    expect(refreshes(r)).toBe(1);
    // the cloud's copy is gone, never revoked
    expect(existsSync(cloudToken(r))).toBe(false);
    expect(r.g.count('/revoke')).toBe(0);
    // the flag the cloud shows away from the surau
    const cAdmin = await loginAs(r.cloud.app, 'admin');
    expect((await r.cloud.app.inject({ method: 'GET', url: '/api/live/youtube/status', headers: cAdmin.headers })).json()).toMatchObject({ signedIn: true, channelTitle: 'Surau Contoh', heldBy: 'box', signInHere: false });
    // the refresh token is sealed on the box disk and nowhere in clear (tables, logs, files of either side)
    expect(existsSync(join(r.h.dataDir, 'secret', 'youtube-token.json'))).toBe(true);
    const text = everything(r);
    expect(text).not.toContain(FAKE_REFRESH);
    // the client secret is in no table and no log (only in the client file itself, as an operator would place it)
    expect([JSON.stringify(r.h.app.surau.db.prepare('SELECT * FROM change_log').all()), r.logs.join('\n')].join('\n')).not.toContain('csecret-SECRET');
    // a second round changes nothing and asks Google nothing
    const calls = r.g.calls.length;
    await link(r).cycle();
    expect(r.g.calls.length).toBe(calls);
    expect(r.g.count('/revoke')).toBe(0);
  });

  it('every write the box sends to the cloud is JSON: the bodyless handover POST sends {} with Content-Type application/json, and the cloud answers it normally', async () => {
    const r = await rig();
    const seen: Array<{ method: string; path: string; type: string | null; body: unknown }> = [];
    const real = r.hook.impl;
    r.hook.impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push({ method: init?.method ?? 'GET', path: new URL(String(input)).pathname, type: new Headers(init?.headers).get('content-type'), body: init?.body });
      return real(input, init);
    }) as typeof fetch;
    await link(r).cycle();
    const writes = seen.filter((x) => x.method !== 'GET');
    expect(writes.map((x) => `${x.method} ${x.path}`)).toEqual(expect.arrayContaining(['POST /api/sync/youtube/handover', 'POST /api/sync/youtube/handover/ack', 'PUT /api/sync/youtube/flag']));
    expect(writes.find((x) => x.path === '/api/sync/youtube/handover')).toMatchObject({ type: 'application/json', body: '{}' });
    for (const w of writes) {
      expect([w.method, w.path, w.type]).toEqual([w.method, w.path, 'application/json']);
      expect([w.method, w.path, typeof w.body]).toEqual([w.method, w.path, 'string']);
    }
    // a GET still sends no body and no content type
    for (const g of seen.filter((x) => x.method === 'GET')) expect(g).toMatchObject({ type: null, body: undefined });
    // and the cloud took it: the grant moved
    expect(existsSync(cloudToken(r))).toBe(false);
    expect(await boxStatus(r, (await loginAs(r.h.app, 'admin')).headers)).toMatchObject({ signedIn: true, heldBy: 'box' });
  });

  it('no handover while the client fetch fails in this start: the cloud copy stays; once fetched, the handover proceeds', async () => {
    const r = await rig();
    const realFetch = r.hook.impl;
    r.hook.impl = (async (i: Parameters<typeof fetch>[0], n?: RequestInit) => {
      if (String(i).endsWith('/api/sync/youtube/client')) throw new TypeError('fetch failed');
      return realFetch(i, n);
    }) as typeof fetch;
    const spy = vi.spyOn(link(r), 'handover');
    await link(r).cycle();
    expect(spy).not.toHaveBeenCalled();
    expect(existsSync(cloudToken(r))).toBe(true);
    expect(existsSync(join(r.h.dataDir, 'secret', 'youtube-token.json'))).toBe(false);
    r.hook.impl = realFetch;
    await link(r).cycle();
    expect(spy).toHaveBeenCalled();
    expect(existsSync(cloudToken(r))).toBe(false);
    expect(existsSync(join(r.h.dataDir, 'secret', 'youtube-token.json'))).toBe(true);
  });

  it('a live starts with the cloud unreachable once the box holds the grant: the box makes the broadcast itself', async () => {
    const r = await rig();
    await link(r).cycle();
    r.hook.impl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const liveUser = await loginAs(r.h.app, 'live');
    const res = await start(r, liveUser.headers);
    expect(res.statusCode).toBe(200);
    expect(await ytSettled(r, liveUser.headers)).toMatchObject({ state: 'ready', key: FAKE_STREAM_KEY });
    expect(r.h.app.liveSessions!.status().warnings).toEqual([]);
    expect(r.g.calls.some((c) => c.path === '/youtube/v3/liveBroadcasts' && c.method === 'POST')).toBe(true);
    // the box writes its own youtube/broadcast row (the catch-up replace and verify checks read it)
    expect(r.h.app.surau.db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'youtube/broadcast'").get()!.n).toBe(1);
    // the cloud never made a broadcast
    expect(r.cloud.app.surau.db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'youtube/broadcast'").get()!.n).toBe(0);
    expect(everything(r)).not.toContain(FAKE_STREAM_KEY);
  });

  it('no handover while a live runs; the cloud keeps its copy until the box is idle', async () => {
    const r = await rig();
    // the box has its own client already (an operator-placed file), but no grant
    writeFileSync(join(r.h.dataDir, 'secret', 'youtube-client.json'), CLIENT);
    const liveUser = await loginAs(r.h.app, 'live');
    expect((await r.h.app.inject({ method: 'POST', url: '/api/live/start', headers: liveUser.headers, payload: startBody(r.h, { outputs: { kiosk: true, youtube: false } }), remoteAddress: LAN })).statusCode).toBe(200);
    expect(await link(r).handover()).toBe('busy');
    expect(existsSync(cloudToken(r))).toBe(true);
  });

  it('Google refuses the moved grant (invalid_grant): the box shows ditarik balik, the cloud deletes its copy, no revoke', async () => {
    const r = await rig();
    r.g.refreshError = 'invalid_grant';
    await link(r).cycle();
    const admin = await loginAs(r.h.app, 'admin');
    expect(await boxStatus(r, admin.headers)).toMatchObject({ signedIn: false, lastError: 'reauthorise' });
    expect(existsSync(cloudToken(r))).toBe(false);
    expect(existsSync(join(r.h.dataDir, 'secret', 'youtube-token.json'))).toBe(false);
    expect(r.g.count('/revoke')).toBe(0);
    const cAdmin = await loginAs(r.cloud.app, 'admin');
    expect((await r.cloud.app.inject({ method: 'GET', url: '/api/live/youtube/status', headers: cAdmin.headers })).json()).toMatchObject({ signedIn: false, lastError: 'reauthorise' });
    // a sign-in at the surau is still possible (device code on the box)
    expect((await r.h.app.inject({ method: 'POST', url: '/api/live/youtube/signin', headers: admin.headers, remoteAddress: LAN })).statusCode).toBe(200);
  });

  it('a lost acknowledgement: the box keeps the grant, proves it again next round and acknowledges; the cloud deletes once', async () => {
    const r = await rig();
    expect(await link(r).fetchClient()).toBe('written');
    const good = r.hook.impl;
    r.hook.impl = (async (i: Parameters<typeof fetch>[0], n?: RequestInit) => {
      if (String(i).endsWith('/api/sync/youtube/handover/ack')) throw new TypeError('fetch failed');
      return good(i, n);
    }) as typeof fetch;
    expect(await link(r).handover()).toBe('failed');
    expect(existsSync(cloudToken(r))).toBe(true);
    const admin = await loginAs(r.h.app, 'admin');
    expect(await boxStatus(r, admin.headers)).toMatchObject({ signedIn: true });
    r.hook.impl = good;
    expect(await link(r).handover()).toBe('adopted');
    expect(existsSync(cloudToken(r))).toBe(false);
    expect(await link(r).handover()).toBe('held');
    expect(r.g.count('/revoke')).toBe(0);
  });

  it('nothing on the cloud, or an unlinked box: nothing is asked of a grant; an unlinked box keeps its own client file', async () => {
    const none = await rig({ grant: false });
    expect(await link(none).handover()).toBe('none');
    const unlinked = await rig({ linked: false });
    writeFileSync(join(unlinked.h.dataDir, 'secret', 'youtube-client.json'), '{"client_id":"own","client_secret":"own"}');
    await link(unlinked).cycle();
    expect(await link(unlinked).handover()).toBe('skipped');
    expect(readFileSync(join(unlinked.h.dataDir, 'secret', 'youtube-client.json'), 'utf8')).toBe('{"client_id":"own","client_secret":"own"}');
    expect(existsSync(cloudToken(unlinked))).toBe(true);
  });
});

describe('the flag and the catch-up at the surau', () => {
  it('a sign-in and a sign-out made at the box push the flag; the flag row never carries a token', async () => {
    const r = await rig({ grant: false });
    await link(r).cycle();
    const admin = await loginAs(r.h.app, 'admin');
    expect((await r.h.app.inject({ method: 'POST', url: '/api/live/youtube/signin', headers: admin.headers, remoteAddress: LAN })).statusCode).toBe(200);
    r.g.approve = true;
    r.h.clock.t += 6000;
    const done = await r.h.app.inject({ method: 'POST', url: '/api/live/youtube/signin/poll', headers: admin.headers, remoteAddress: LAN });
    expect(done.json()).toMatchObject({ state: 'signed_in', signedIn: true });
    for (let i = 0; i < 100 && r.cloud.app.surau.db.prepare('SELECT signed_in FROM youtube_flag').get()?.signed_in !== 1; i++) await new Promise((res) => setTimeout(res, 20));
    expect(r.cloud.app.surau.db.prepare('SELECT signed_in, channel_title FROM youtube_flag').get()).toEqual({ signed_in: 1, channel_title: 'Surau Contoh' });
    expect((await r.h.app.inject({ method: 'POST', url: '/api/live/youtube/signout', headers: admin.headers, remoteAddress: LAN })).statusCode).toBe(200);
    for (let i = 0; i < 100 && r.cloud.app.surau.db.prepare('SELECT signed_in FROM youtube_flag').get()?.signed_in !== 0; i++) await new Promise((res) => setTimeout(res, 20));
    expect(r.cloud.app.surau.db.prepare('SELECT signed_in, channel_title, revoked FROM youtube_flag').get()).toEqual({ signed_in: 0, channel_title: null, revoked: 0 });
    expect(JSON.stringify(r.cloud.app.surau.db.prepare('SELECT * FROM youtube_flag').all())).not.toContain(FAKE_REFRESH);
  });

  it('upload begin, done and quota answer on the box from its own grant (at the surau)', async () => {
    const r = await rig();
    await link(r).cycle();
    putFeature(r.h.app.surau.db, 'youtubeCatchUp', { enabled: true }, 'test', undefined, 'sdm');
    const liveUser = await loginAs(r.h.app, 'live');
    const q = await r.h.app.inject({ method: 'GET', url: '/api/youtube/quota', headers: liveUser.headers, remoteAddress: LAN });
    expect(q.json()).toMatchObject({ uploadsToday: 0, uploadLimit: 100 });
    const begin = await r.h.app.inject({ method: 'POST', url: '/api/youtube/upload/begin', headers: liveUser.headers, remoteAddress: LAN, payload: { kuliahId: null, part: null, bytes: 1000, replaceLiveVideoId: null } });
    expect(begin.statusCode).toBe(200);
    expect(begin.json()).toMatchObject({ uploadId: expect.stringMatching(/^up_/) as unknown as string, uploadUri: expect.stringMatching(/^https:\/\//) as unknown as string });
    // the session address is a capability: never stored or logged on the box
    expect(everything(r)).not.toContain(String(begin.json().uploadUri));
  });
});

describe('a linked box whose cloud is asleep never reports signed out for what it cannot see (round 2)', () => {
  const down = (async () => {
    throw new TypeError('cloud asleep');
  }) as typeof fetch;

  it('no grant here, the handover not settled and the cloud unreachable: unknown (cloud_unreachable), no flag pushed; once settled with none, signed out', async () => {
    const r = await rig({ grant: false });
    const admin = await loginAs(r.h.app, 'admin');
    // before the first cycle: not looked at yet
    expect(await boxStatus(r, admin.headers)).toMatchObject({ state: 'unknown', reason: 'handover_pending' });
    r.hook.impl = down;
    await link(r).cycle();
    expect(await boxStatus(r, admin.headers)).toMatchObject({ state: 'unknown', reason: 'cloud_unreachable', lastGood: null });
    expect(r.cloud.app.surau.db.prepare('SELECT COUNT(*) AS n FROM youtube_flag').get()).toEqual({ n: 0 });
    // the cloud wakes and says it holds nothing: now it is a plain signed out
    r.hook.impl = r.cloud.fetch;
    await link(r).cycle();
    expect(await boxStatus(r, admin.headers)).toMatchObject({ state: 'signedOut', signedIn: false });
  });

  it('a box that already holds the grant, restarted with the cloud down, stays signed in and starts a live with YouTube', async () => {
    const r = await rig();
    await link(r).cycle();
    const admin = await loginAs(r.h.app, 'admin');
    expect(await boxStatus(r, admin.headers)).toMatchObject({ state: 'signedIn' });
    r.hook.impl = down;
    await link(r).cycle();
    expect(await boxStatus(r, admin.headers)).toMatchObject({ state: 'signedIn', signedIn: true });
    const liveUser = await loginAs(r.h.app, 'live');
    expect((await start(r, liveUser.headers)).statusCode).toBe(200);
    const y = await ytSettled(r, liveUser.headers);
    expect(y.state).not.toBe('error');
    expect(r.g.calls.some((c) => c.path === '/youtube/v3/liveBroadcasts' && c.method === 'POST')).toBe(true);
  });
});

describe('gate round 2 (box half)', () => {
  const fail404 = (body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status: 404, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
  const stateRow = (r: Rig) => r.h.app.surau.db.prepare("SELECT value FROM sync_state WHERE key = 'youtube_handover'").get()?.value;

  it('Q1: a 404 with no code is not "nothing to move": tried again; 404 none settles', async () => {
    const r = await rig();
    expect(await link(r).fetchClient()).toBe('written');
    const real = r.hook.impl;
    r.hook.impl = ((i: Parameters<typeof fetch>[0], n?: RequestInit) =>
      String(i).endsWith('/api/sync/youtube/handover') ? fail404({})(i, n) : real(i, n)) as typeof fetch;
    expect(await link(r).handover()).toBe('failed');
    expect(stateRow(r)).toBeUndefined();
    // the cloud's file will not open: 503, also tried again
    r.hook.impl = real;
    const tokenFile = cloudToken(r);
    const good = readFileSync(tokenFile);
    writeFileSync(tokenFile, 'garbage');
    expect(await link(r).handover()).toBe('failed');
    expect(stateRow(r)).toBeUndefined();
    writeFileSync(tokenFile, good);
    expect(await link(r).handover()).toBe('adopted');
    // and with nothing at all the cloud says none: settled
    const none = await rig({ grant: false });
    expect(await link(none).fetchClient()).toBe('written');
    expect(await link(none).handover()).toBe('none');
    expect(JSON.parse(String(stateRow(none)))).toEqual({ state: 'done' });
  });

  it('Q2: a box that already has a client (placed by the operator) runs the handover although the cloud has no client file', async () => {
    const r = await rig({ grant: false });
    rmSync(join(r.cloud.dir, 'secret', 'youtube-client.json'));
    mkdirSync(join(r.h.dataDir, 'secret'), { recursive: true });
    writeFileSync(join(r.h.dataDir, 'secret', 'youtube-client.json'), CLIENT);
    const admin = await loginAs(r.h.app, 'admin');
    expect(await boxStatus(r, admin.headers)).toMatchObject({ state: 'unknown', reason: 'handover_pending' });
    await link(r).cycle();
    expect(await boxStatus(r, admin.headers)).toMatchObject({ state: 'signedOut' });
    expect(JSON.parse(String(stateRow(r)))).toEqual({ state: 'done' });
  });

  it('M2: a sign-out made before the handover settled still reaches the cloud', async () => {
    const r = await rig({ grant: false });
    // the cloud has a stale "signed in" flag; this box holds no grant and the handover was never settled
    r.cloud.app.surau.db
      .prepare("INSERT INTO youtube_flag (surau_id, signed_in, channel_title, revoked, box_id, updated_at) VALUES ('sdm', 1, 'Lama', 0, ?, ?)")
      .run(r.h.app.surau.boxId, new Date().toISOString());
    expect(stateRow(r)).toBeUndefined();
    link(r).changed();
    await vi.waitFor(() => expect(r.cloud.app.surau.db.prepare('SELECT signed_in FROM youtube_flag').get()).toEqual({ signed_in: 0 }));
    expect(JSON.parse(String(stateRow(r)))).toEqual({ state: 'done' });
  });

  it('M3: a lost acknowledgement of a withdrawn grant is repeated until it lands', async () => {
    const r = await rig();
    expect(await link(r).fetchClient()).toBe('written');
    r.g.refreshError = 'invalid_grant';
    const real = r.hook.impl;
    r.hook.impl = ((i: Parameters<typeof fetch>[0], n?: RequestInit) =>
      String(i).endsWith('/handover/ack') ? Promise.reject(new TypeError('fetch failed')) : real(i, n)) as typeof fetch;
    expect(await link(r).handover()).toBe('revoked');
    expect(existsSync(cloudToken(r))).toBe(true);
    expect(JSON.parse(String(stateRow(r))).id).toMatch(/^ho_/);
    r.hook.impl = real;
    // the repeat backs off (F8): not at once, after 2 minutes
    expect(await link(r).handover()).toBe('held');
    r.h.clock.t += 2 * 60_000 + 1;
    expect(await link(r).handover()).toBe('revoked');
    expect(existsSync(cloudToken(r))).toBe(false);
    expect(JSON.parse(String(stateRow(r)))).toEqual({ state: 'revoked' });
    expect(await link(r).handover()).toBe('held');
    expect(r.g.count('/revoke')).toBe(0);
  });

  it('Q6: a 409 on the flag is not remembered as sent', async () => {
    const r = await rig({ grant: false });
    await link(r).cycle();
    // another linked box holds the handover of this surau
    const other = insertSite(r.cloud.app.surau.db, { boxId: 'cccc000000000001' });
    r.cloud.app.surau.db.prepare('UPDATE sites SET public_jwk = ? WHERE box_id = ?').run(JSON.stringify(generateSyncKeyPair().publicJwk), other.boxId);
    r.cloud.app.surau.db
      .prepare("INSERT OR REPLACE INTO youtube_handover (surau_id, box_id, handover_id, state, offered_at, acked_at) VALUES ('sdm', 'cccc000000000001', 'ho_other00001', 'acked', ?, ?)")
      .run(new Date().toISOString(), new Date().toISOString());
    const admin = await loginAs(r.h.app, 'admin');
    expect((await r.h.app.inject({ method: 'POST', url: '/api/live/youtube/signin', headers: admin.headers, remoteAddress: LAN })).statusCode).toBe(200);
    r.g.approve = true;
    r.h.clock.t += 6000;
    await r.h.app.inject({ method: 'POST', url: '/api/live/youtube/signin/poll', headers: admin.headers, remoteAddress: LAN });
    expect(await link(r).pushFlag()).toBe(false);
    // the signed-out text sent before stays the last one the cloud took; the 409 text was not stored
    expect(r.h.app.surau.db.prepare("SELECT value FROM sync_state WHERE key = 'youtube_flag_sent'").get()?.value).toContain('"signedIn":false');
    // the other box leaves: the next round delivers it
    r.cloud.app.surau.db.prepare('UPDATE sites SET revoked_at = ? WHERE box_id = ?').run('2026-11-19T00:00:00.000Z', 'cccc000000000001');
    expect(await link(r).pushFlag()).toBe(true);
  });

  it('S3: an older plaintext client file is read and sealed in place; the box stays configured', async () => {
    const r = await rig({ grant: false });
    const path = join(r.h.dataDir, 'secret', 'youtube-client.json');
    mkdirSync(join(r.h.dataDir, 'secret'), { recursive: true });
    writeFileSync(path, CLIENT);
    const admin = await loginAs(r.h.app, 'admin');
    expect(await boxStatus(r, admin.headers)).toMatchObject({ configured: true });
    expect(readFileSync(path, 'utf8')).not.toContain('csecret-SECRET');
    expect(await boxStatus(r, admin.headers)).toMatchObject({ configured: true });
    expect(readClientText(r.h.dataDir)).toBe(CLIENT);
  });
});

describe('release audit follow-ups (box half)', () => {
  const down = (async () => {
    throw new TypeError('cloud asleep');
  }) as typeof fetch;
  const stateRow = (r: Rig) => r.h.app.surau.db.prepare("SELECT value FROM sync_state WHERE key = 'youtube_handover'").get()?.value;
  const MIN = 60_000;

  it('F1: an unsettled handover asks the cloud to wake, at most 3 times an hour; once settled it never does', async () => {
    const r = await rig({ grant: false });
    const wake = vi.spyOn(r.h.app.syncAgent!, 'wakeNow').mockResolvedValue(true);
    r.hook.impl = down;
    for (let i = 0; i < 5; i++) await link(r).cycle();
    expect(wake).toHaveBeenCalledTimes(3);
    // an hour later the cap frees up
    r.h.clock.t += 60 * MIN + 1000;
    await link(r).cycle();
    expect(wake).toHaveBeenCalledTimes(4);
    // the cloud is up and says nothing to move: settled, so no more wakes
    r.hook.impl = r.cloud.fetch;
    r.h.clock.t += 60 * MIN + 1000;
    await link(r).cycle();
    expect(wake).toHaveBeenCalledTimes(5);
    expect(JSON.parse(String(stateRow(r)))).toEqual({ state: 'done' });
    r.h.clock.t += 60 * MIN + 1000;
    await link(r).cycle();
    expect(wake).toHaveBeenCalledTimes(5);
  });

  it('F1: a box that holds a grant never wakes the cloud again once the handover is settled', async () => {
    const r = await rig();
    const wake = vi.spyOn(r.h.app.syncAgent!, 'wakeNow').mockResolvedValue(true);
    await link(r).cycle();
    expect(JSON.parse(String(stateRow(r)))).toEqual({ state: 'done' });
    expect(wake).toHaveBeenCalledTimes(1);
    await link(r).cycle();
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('F8: the withdrawn-grant acknowledgement backs off 2 min, 10 min, 1 h, then 6 h, and stops after 3 days', async () => {
    const r = await rig();
    expect(await link(r).fetchClient()).toBe('written');
    r.g.refreshError = 'invalid_grant';
    const real = r.hook.impl;
    let acks = 0;
    r.hook.impl = ((i: Parameters<typeof fetch>[0], n?: RequestInit) => {
      if (!String(i).endsWith('/handover/ack')) return real(i, n);
      acks++;
      return Promise.reject(new TypeError('fetch failed'));
    }) as typeof fetch;
    expect(await link(r).handover()).toBe('revoked');
    expect(acks).toBe(1);
    // inside 2 minutes: no new try
    r.h.clock.t += 1 * MIN;
    expect(await link(r).handover()).toBe('held');
    expect(acks).toBe(1);
    r.h.clock.t += 1 * MIN + 1;
    expect(await link(r).handover()).toBe('failed');
    expect(acks).toBe(2);
    // next gap 10 minutes
    r.h.clock.t += 9 * MIN;
    expect(await link(r).handover()).toBe('held');
    r.h.clock.t += 1 * MIN + 1;
    expect(await link(r).handover()).toBe('failed');
    expect(acks).toBe(3);
    // then 1 hour
    r.h.clock.t += 59 * MIN;
    expect(await link(r).handover()).toBe('held');
    r.h.clock.t += 1 * MIN + 1;
    expect(await link(r).handover()).toBe('failed');
    expect(acks).toBe(4);
    // then every 6 hours
    r.h.clock.t += 5 * 60 * MIN;
    expect(await link(r).handover()).toBe('held');
    r.h.clock.t += 60 * MIN + 1;
    expect(await link(r).handover()).toBe('failed');
    expect(acks).toBe(5);
    r.h.clock.t += 6 * 60 * MIN + 1;
    expect(await link(r).handover()).toBe('failed');
    expect(acks).toBe(6);
    // after 3 days it does not stop: one try a day, each one logged (Q5), until the cloud has heard
    r.h.clock.t += 3 * 86_400_000;
    expect(await link(r).handover()).toBe('failed');
    expect(acks).toBe(7);
    expect(r.logs.filter((l) => l.includes('asking again tomorrow')).length).toBe(1);
    r.h.clock.t += 23 * 60 * MIN;
    expect(await link(r).handover()).toBe('held');
    expect(acks).toBe(7);
    r.h.clock.t += 60 * MIN + 1;
    expect(await link(r).handover()).toBe('failed');
    expect(acks).toBe(8);
    expect(r.logs.filter((l) => l.includes('asking again tomorrow')).length).toBe(2);
    // a day later the cloud is reachable again: the acknowledgement lands and the retry ends
    r.hook.impl = real;
    r.h.clock.t += 86_400_000 + 1;
    expect(await link(r).handover()).toBe('revoked');
    expect(JSON.parse(String(stateRow(r)))).toEqual({ state: 'revoked' });
    expect(await link(r).handover()).toBe('held');
  });

  /** The same link as the running one, as a restarted box would build it (nothing kept in memory). */
  const restarted = (r: Rig): YoutubeBoxLink => new YoutubeBoxLink({ ...(link(r) as unknown as { o: YoutubeBoxLinkOptions }).o, auto: false });

  it('Q4: the hourly wake times are kept in the database, so a restart does not reset the cap', async () => {
    const r = await rig({ grant: false });
    const wake = vi.spyOn(r.h.app.syncAgent!, 'wakeNow').mockResolvedValue(true);
    r.hook.impl = down;
    for (let i = 0; i < 4; i++) await link(r).cycle();
    expect(wake).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(r.h.app.surau.db.prepare("SELECT value FROM sync_state WHERE key = 'youtube_wakes'").get()?.value))).toHaveLength(3);
    // a new process: the cap still holds
    await restarted(r).cycle();
    expect(wake).toHaveBeenCalledTimes(3);
    // an hour on it frees up, restart or not
    r.h.clock.t += 60 * MIN + 1000;
    await restarted(r).cycle();
    expect(wake).toHaveBeenCalledTimes(4);
  });

  it('S4: the wake stops 24 hours after the first one; a restart, or a sign-in change, starts it again', async () => {
    const r = await rig({ grant: false });
    const wake = vi.spyOn(r.h.app.syncAgent!, 'wakeNow').mockResolvedValue(true);
    r.hook.impl = down;
    await link(r).cycle();
    expect(wake).toHaveBeenCalledTimes(1);
    r.h.clock.t += 23 * 60 * MIN;
    await link(r).cycle();
    expect(wake).toHaveBeenCalledTimes(2);
    // 25 hours after the first wake: no more, however many rounds
    r.h.clock.t += 2 * 60 * MIN;
    for (let i = 0; i < 3; i++) await link(r).cycle();
    expect(wake).toHaveBeenCalledTimes(2);
    // the box restarts: the next round wakes again
    const again = restarted(r);
    await again.cycle();
    expect(wake).toHaveBeenCalledTimes(3);
    // 26 hours on, the restarted process is past its own window; switching sync off and on starts it afresh
    r.h.clock.t += 26 * 60 * MIN;
    await again.cycle();
    expect(wake).toHaveBeenCalledTimes(3);
    putFeature(r.h.app.surau.db, 'cloudSync', { enabled: false }, 'test', undefined, 'sdm');
    await again.cycle();
    putFeature(r.h.app.surau.db, 'cloudSync', { enabled: true }, 'test', undefined, 'sdm');
    await again.cycle();
    expect(wake).toHaveBeenCalledTimes(4);
  });

  it('S4: no wake once it is known that the handover cannot run (no client on the cloud and none here)', async () => {
    const r = await rig({ grant: false });
    rmSync(join(r.cloud.dir, 'secret', 'youtube-client.json'));
    const wake = vi.spyOn(r.h.app.syncAgent!, 'wakeNow').mockResolvedValue(true);
    await link(r).cycle();
    // the first round may wake (nothing is known yet); the cloud then says it has no client, so the next ones do not
    const first = wake.mock.calls.length;
    expect(first).toBeLessThanOrEqual(1);
    for (let i = 0; i < 3; i++) await link(r).cycle();
    expect(wake.mock.calls.length).toBe(first);
    // the operator puts a client on the box: the handover can run and settles
    mkdirSync(join(r.h.dataDir, 'secret'), { recursive: true });
    writeFileSync(join(r.h.dataDir, 'secret', 'youtube-client.json'), CLIENT);
    await link(r).cycle();
    expect(JSON.parse(String(stateRow(r)))).toEqual({ state: 'done' });
  });

  it('M3: the flag is sent again at least once a day, and a flag another box wrote is replaced by the holder', async () => {
    const r = await rig();
    let puts = 0;
    const real = r.hook.impl;
    r.hook.impl = ((i: Parameters<typeof fetch>[0], n?: RequestInit) => {
      if (String(i).endsWith('/youtube/flag')) puts++;
      return real(i, n);
    }) as typeof fetch;
    await link(r).cycle();
    expect(puts).toBe(1);
    expect(r.cloud.app.surau.db.prepare('SELECT signed_in, box_id FROM youtube_flag').get()).toEqual({ signed_in: 1, box_id: r.h.app.surau.boxId });
    // unchanged, within the day: nothing is said again
    r.h.clock.t += 5 * 60 * MIN;
    expect(await link(r).pushFlag()).toBe(true);
    expect(puts).toBe(1);
    // the holder was silent for a month and another box wrote "not connected" under its own id
    r.cloud.app.surau.db.prepare("UPDATE youtube_flag SET signed_in = 0, channel_title = NULL, box_id = 'cccc000000000001'").run();
    r.h.clock.t += 20 * 60 * MIN;
    expect(await link(r).pushFlag()).toBe(true);
    expect(puts).toBe(2);
    expect(r.cloud.app.surau.db.prepare('SELECT signed_in, box_id FROM youtube_flag').get()).toEqual({ signed_in: 1, box_id: r.h.app.surau.boxId });
    // and not again until another day has passed
    expect(await link(r).pushFlag()).toBe(true);
    expect(puts).toBe(2);
  });

  it('F8: when the acknowledgement finally lands the retry ends as before', async () => {
    const r = await rig();
    expect(await link(r).fetchClient()).toBe('written');
    r.g.refreshError = 'invalid_grant';
    const real = r.hook.impl;
    r.hook.impl = ((i: Parameters<typeof fetch>[0], n?: RequestInit) =>
      String(i).endsWith('/handover/ack') ? Promise.reject(new TypeError('fetch failed')) : real(i, n)) as typeof fetch;
    expect(await link(r).handover()).toBe('revoked');
    r.hook.impl = real;
    r.h.clock.t += 2 * MIN + 1;
    expect(await link(r).handover()).toBe('revoked');
    expect(existsSync(cloudToken(r))).toBe(false);
    expect(JSON.parse(String(stateRow(r)))).toEqual({ state: 'revoked' });
  });
});
