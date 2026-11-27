import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readClientText } from '../src/live/youtube/clientFile.ts';
import { putFeature } from '../src/settingsStore.ts';
import { generateSyncKeyPair, saveSyncKey } from '../src/sync/syncKey.ts';
import { loginAs } from './authHelpers.ts';
import { buildCloud, CLOUD_URL } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FAKE_REFRESH, FAKE_STREAM_KEY, startFakeGoogle } from './support/fakeGoogle.ts';
import type { FakeGoogle } from './support/fakeGoogle.ts';
import { withUploadApi } from './support/fakeGoogleUpload.ts';
import { startBody, startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';
import { insertSite } from './support/sites.ts';

/**
 * The box's link to the cloud for YouTube (release 2026.11.13, phase 4 in 2026.11.15): the grant lives on the box and
 * the cloud holds none, so the old handover is settled on the box with no call to the cloud. What the link still does:
 * takes the operator's OAuth client sealed to this box, pushes a flag that never carries a token, and finishes a
 * handover an earlier version began. The box makes every YouTube call itself, so a live starts with the cloud
 * unreachable; the catch-up steps answer on the box.
 */

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0)) await c();
});

const CLIENT = JSON.stringify({ installed: { client_id: 'cid-123.apps.googleusercontent.com', client_secret: 'csecret-SECRET' } });
const LAN = '10.168.1.40';
const MIN = 60_000;

interface Rig {
  h: LiveHarness;
  cloud: TestCloud;
  g: FakeGoogle;
  /** The fetch the box uses for the cloud; swap `impl` to break the link. */
  hook: { impl: typeof fetch };
  logs: string[];
}

async function rig(o: { linked?: boolean } = {}): Promise<Rig> {
  const g = await startFakeGoogle();
  const up = withUploadApi(g);
  const cloud = buildCloud('boxid0001', { fetchImpl: up.fetchImpl });
  const hook = { impl: cloud.fetch };
  const h = await startLiveHarness({
    app: {
      fetchImpl: up.fetchImpl,
      cloud: { url: CLOUD_URL },
      sync: { auto: false, fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => hook.impl(i, n)) as typeof fetch },
    },
  });
  closers.push(h.close, cloud.close, g.close);
  // the operator's client is on the cloud only: the box takes it sealed (D2)
  mkdirSync(join(cloud.dir, 'secret'), { recursive: true });
  writeFileSync(join(cloud.dir, 'secret', 'youtube-client.json'), CLIENT);
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
const boxStatus = async (r: Rig, headers: Record<string, string>) =>
  (await r.h.app.inject({ method: 'GET', url: '/api/live/youtube/status', headers, remoteAddress: LAN })).json() as Record<string, unknown>;
const start = (r: Rig, headers: Record<string, string>) =>
  r.h.app.inject({ method: 'POST', url: '/api/live/start', headers, payload: startBody(r.h, { outputs: { kiosk: true, youtube: true } }), remoteAddress: LAN });
const stateRow = (r: Rig) => r.h.app.surau.db.prepare("SELECT value FROM sync_state WHERE key = 'youtube_handover'").get()?.value;
const flagSent = (r: Rig) => r.h.app.surau.db.prepare("SELECT value FROM sync_state WHERE key = 'youtube_flag_sent'").get()?.value;

async function ytSettled(r: Rig, headers: Record<string, string>): Promise<{ state: string; ingest: string | null; key: string | null }> {
  for (let i = 0; i < 400; i++) {
    const g = (await r.h.app.inject({ method: 'GET', url: '/api/live/youtube/ingest', headers, remoteAddress: LAN })).json();
    if (g.state !== 'starting') return g;
    await new Promise((res) => setTimeout(res, 15));
  }
  throw new Error('the YouTube leg never settled');
}

/** A person signs in at the surau (device code on the box, approved at the fake Google). Returns the admin's headers. */
async function signInHere(r: Rig): Promise<Record<string, string>> {
  const admin = await loginAs(r.h.app, 'admin');
  expect((await r.h.app.inject({ method: 'POST', url: '/api/live/youtube/signin', headers: admin.headers, remoteAddress: LAN })).statusCode).toBe(200);
  r.g.approve = true;
  r.h.clock.t += 6000;
  const done = await r.h.app.inject({ method: 'POST', url: '/api/live/youtube/signin/poll', headers: admin.headers, remoteAddress: LAN });
  expect(done.json()).toMatchObject({ state: 'signed_in', signedIn: true });
  return admin.headers;
}

/** An offer an earlier cloud made to this box, as the cloud's table still holds it. */
function cloudOffer(r: Rig, id: string): void {
  r.cloud.app.surau.db
    .prepare("INSERT OR REPLACE INTO youtube_handover (surau_id, box_id, handover_id, state, offered_at, acked_at) VALUES ('sdm', ?, ?, 'offered', ?, NULL)")
    .run(r.h.app.surau.boxId, id, new Date().toISOString());
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

describe('the client and the settled handover', () => {
  it('client delivered sealed; the handover is settled with no call to the cloud; the flag says signed out; no revoke', async () => {
    const r = await rig();
    const admin = await loginAs(r.h.app, 'admin');
    expect(await boxStatus(r, admin.headers)).toMatchObject({ configured: false, signedIn: false, state: 'unknown', reason: 'handover_pending' });
    const seen: Array<{ method: string; path: string; type: string | null; body: unknown }> = [];
    const real = r.hook.impl;
    r.hook.impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push({ method: init?.method ?? 'GET', path: new URL(String(input)).pathname, type: new Headers(init?.headers).get('content-type'), body: init?.body });
      return real(input, init);
    }) as typeof fetch;
    await link(r).cycle();
    // D2 and S3: the operator's client is on the box, sealed at rest, and it reads back as the operator's file
    expect(readFileSync(join(r.h.dataDir, 'secret', 'youtube-client.json'), 'utf8')).not.toContain('csecret-SECRET');
    expect(readClientText(r.h.dataDir)).toBe(CLIENT);
    // nothing is moved: the cloud is not asked for a handover and Google is not asked for anything
    expect(seen.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /api/sync/youtube/client', 'PUT /api/sync/youtube/flag']);
    expect(JSON.parse(String(stateRow(r)))).toEqual({ state: 'done' });
    expect(await boxStatus(r, admin.headers)).toMatchObject({ configured: true, signedIn: false, state: 'signedOut' });
    expect(r.g.count('/revoke')).toBe(0);
    // every write the box sends is JSON; a GET sends no body and no content type
    for (const w of seen.filter((x) => x.method !== 'GET')) expect(w).toMatchObject({ type: 'application/json', body: expect.any(String) as unknown as string });
    for (const g of seen.filter((x) => x.method === 'GET')) expect(g).toMatchObject({ type: null, body: undefined });
    // the flag the cloud shows away from the surau: no sign-in held by the box
    expect(r.cloud.app.surau.db.prepare('SELECT signed_in, revoked FROM youtube_flag').get()).toEqual({ signed_in: 0, revoked: 0 });
    // a second round changes nothing
    const calls = seen.length;
    await link(r).cycle();
    expect(seen.length).toBe(calls);
  });

  it('the cloud being unreachable or the client fetch failing does not leave the box "unknown": it settles and says signed out', async () => {
    const r = await rig();
    const admin = await loginAs(r.h.app, 'admin');
    expect(await boxStatus(r, admin.headers)).toMatchObject({ state: 'unknown', reason: 'handover_pending' });
    r.hook.impl = (async () => {
      throw new TypeError('cloud asleep');
    }) as typeof fetch;
    await link(r).cycle();
    expect(await boxStatus(r, admin.headers)).toMatchObject({ state: 'signedOut', signedIn: false });
    expect(JSON.parse(String(stateRow(r)))).toEqual({ state: 'done' });
    expect(r.cloud.app.surau.db.prepare('SELECT COUNT(*) AS n FROM youtube_flag').get()).toEqual({ n: 0 });
    // the cloud wakes: the client arrives and the flag lands
    r.hook.impl = r.cloud.fetch;
    await link(r).cycle();
    expect(readClientText(r.h.dataDir)).toBe(CLIENT);
    expect(r.cloud.app.surau.db.prepare('SELECT signed_in FROM youtube_flag').get()).toEqual({ signed_in: 0 });
  });

  it('an unlinked box asks nothing and keeps its own client file; a box with a client placed by the operator settles too', async () => {
    const unlinked = await rig({ linked: false });
    mkdirSync(join(unlinked.h.dataDir, 'secret'), { recursive: true });
    writeFileSync(join(unlinked.h.dataDir, 'secret', 'youtube-client.json'), '{"client_id":"own","client_secret":"own"}');
    await link(unlinked).cycle();
    expect(await link(unlinked).handover()).toBe('skipped');
    expect(readFileSync(join(unlinked.h.dataDir, 'secret', 'youtube-client.json'), 'utf8')).toBe('{"client_id":"own","client_secret":"own"}');
    expect(stateRow(unlinked)).toBeUndefined();

    const placed = await rig();
    mkdirSync(join(placed.h.dataDir, 'secret'), { recursive: true });
    writeFileSync(join(placed.h.dataDir, 'secret', 'youtube-client.json'), CLIENT);
    const admin = await loginAs(placed.h.app, 'admin');
    expect(await boxStatus(placed, admin.headers)).toMatchObject({ state: 'unknown', reason: 'handover_pending' });
    await link(placed).cycle();
    expect(await boxStatus(placed, admin.headers)).toMatchObject({ state: 'signedOut' });
    expect(JSON.parse(String(stateRow(placed)))).toEqual({ state: 'done' });
  });

  it('S3: an older plaintext client file is read and sealed in place; the box stays configured', async () => {
    const r = await rig();
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

describe('the box holds the grant itself', () => {
  it('a live starts with the cloud unreachable: the box makes the broadcast itself and the cloud makes none', async () => {
    const r = await rig();
    await link(r).cycle();
    await signInHere(r);
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
    expect(r.cloud.app.surau.db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'youtube/broadcast'").get()!.n).toBe(0);
    expect(everything(r)).not.toContain(FAKE_STREAM_KEY);
  });

  it('a box that holds the grant, with the cloud down, stays signed in and starts a live with YouTube', async () => {
    const r = await rig();
    await link(r).cycle();
    const admin = await loginAs(r.h.app, 'admin');
    await signInHere(r);
    r.hook.impl = (async () => {
      throw new TypeError('cloud asleep');
    }) as typeof fetch;
    await link(r).cycle();
    expect(await boxStatus(r, admin.headers)).toMatchObject({ state: 'signedIn', signedIn: true });
    const liveUser = await loginAs(r.h.app, 'live');
    expect((await start(r, liveUser.headers)).statusCode).toBe(200);
    expect((await ytSettled(r, liveUser.headers)).state).not.toBe('error');
    expect(r.g.calls.some((c) => c.path === '/youtube/v3/liveBroadcasts' && c.method === 'POST')).toBe(true);
  });

  it('a sign-in and a sign-out made at the box push the flag; the flag row never carries a token', async () => {
    const r = await rig();
    await link(r).cycle();
    await signInHere(r);
    const flagIs = (n: number) => r.cloud.app.surau.db.prepare('SELECT signed_in FROM youtube_flag').get()?.signed_in === n;
    await vi.waitFor(() => expect(flagIs(1)).toBe(true));
    expect(r.cloud.app.surau.db.prepare('SELECT signed_in, channel_title FROM youtube_flag').get()).toEqual({ signed_in: 1, channel_title: 'Surau Contoh' });
    const admin = await loginAs(r.h.app, 'admin');
    expect((await r.h.app.inject({ method: 'POST', url: '/api/live/youtube/signout', headers: admin.headers, remoteAddress: LAN })).statusCode).toBe(200);
    await vi.waitFor(() => expect(flagIs(0)).toBe(true));
    expect(r.cloud.app.surau.db.prepare('SELECT signed_in, channel_title, revoked FROM youtube_flag').get()).toEqual({ signed_in: 0, channel_title: null, revoked: 0 });
    expect(JSON.stringify(r.cloud.app.surau.db.prepare('SELECT * FROM youtube_flag').all())).not.toContain(FAKE_REFRESH);
  });

  it('upload begin, done and quota answer on the box from its own grant (at the surau)', async () => {
    const r = await rig();
    await link(r).cycle();
    await signInHere(r);
    putFeature(r.h.app.surau.db, 'youtubeCatchUp', { enabled: true }, 'test', undefined, 'sdm');
    const liveUser = await loginAs(r.h.app, 'live');
    const q = await r.h.app.inject({ method: 'GET', url: '/api/youtube/quota', headers: liveUser.headers, remoteAddress: LAN });
    expect(q.json()).toMatchObject({ uploadsToday: 0, uploadLimit: 100 });
    const begin = await r.h.app.inject({ method: 'POST', url: '/api/youtube/upload/begin', headers: liveUser.headers, remoteAddress: LAN, payload: { kuliahId: null, part: null, bytes: 1000, replaceLiveVideoId: null } });
    expect(begin.statusCode).toBe(200);
    expect(begin.json()).toMatchObject({ uploadId: expect.stringMatching(/^up_/) as unknown as string, uploadUri: expect.stringMatching(/^https:\/\//) as unknown as string });
    // the session address is a capability: never stored or logged on the box
    expect(everything(r)).not.toContain(String(begin.json().uploadUri));
    // the refresh token is sealed on the box disk and nowhere in clear (tables, logs, files of either side)
    expect(existsSync(join(r.h.dataDir, 'secret', 'youtube-token.json'))).toBe(true);
    expect(everything(r)).not.toContain(FAKE_REFRESH);
  });
});

describe('finishing a handover an earlier version began', () => {
  /** The state an earlier version kept after Google withdrew a moved grant and the cloud had not yet heard (M3). */
  const revokedState = (r: Rig): void => {
    const t = r.h.clock.t;
    r.h.app.surau.db
      .prepare("INSERT INTO sync_state (key, value) VALUES ('youtube_handover', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ state: 'revoked', id: 'ho_test000001', n: 1, since: t, at: t }));
  };

  it('a lost acknowledgement of an adopted grant: the box proves it again and the cloud closes the row', async () => {
    const r = await rig();
    expect(await link(r).fetchClient()).toBe('written');
    await signInHere(r);
    r.h.app.surau.db.prepare("INSERT INTO sync_state (key, value) VALUES ('youtube_handover', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ state: 'adopted', id: 'ho_test000002' }));
    cloudOffer(r, 'ho_test000002');
    const good = r.hook.impl;
    r.hook.impl = (async (i: Parameters<typeof fetch>[0], n?: RequestInit) => {
      if (String(i).endsWith('/api/sync/youtube/handover/ack')) throw new TypeError('fetch failed');
      return good(i, n);
    }) as typeof fetch;
    expect(await link(r).handover()).toBe('failed');
    expect(JSON.parse(String(stateRow(r)))).toEqual({ state: 'adopted', id: 'ho_test000002' });
    r.hook.impl = good;
    expect(await link(r).handover()).toBe('adopted');
    expect(JSON.parse(String(stateRow(r)))).toEqual({ state: 'done' });
    expect(r.cloud.app.surau.db.prepare("SELECT state FROM youtube_handover WHERE handover_id = 'ho_test000002'").get()).toEqual({ state: 'acked' });
    expect(await link(r).handover()).toBe('held');
    expect(r.g.count('/revoke')).toBe(0);
  });

  it('M3: a lost acknowledgement of a withdrawn grant is repeated until it lands', async () => {
    const r = await rig();
    expect(await link(r).fetchClient()).toBe('written');
    cloudOffer(r, 'ho_test000001');
    revokedState(r);
    const real = r.hook.impl;
    r.hook.impl = ((i: Parameters<typeof fetch>[0], n?: RequestInit) =>
      String(i).endsWith('/handover/ack') ? Promise.reject(new TypeError('fetch failed')) : real(i, n)) as typeof fetch;
    // not at once (F8): the first repeat is after 2 minutes
    expect(await link(r).handover()).toBe('held');
    r.h.clock.t += 2 * MIN + 1;
    expect(await link(r).handover()).toBe('failed');
    r.hook.impl = real;
    // the second gap is 10 minutes
    r.h.clock.t += 10 * MIN + 1;
    expect(await link(r).handover()).toBe('revoked');
    expect(JSON.parse(String(stateRow(r)))).toEqual({ state: 'revoked' });
    expect(r.cloud.app.surau.db.prepare('SELECT signed_in, revoked FROM youtube_flag').get()).toEqual({ signed_in: 0, revoked: 1 });
    expect(await link(r).handover()).toBe('held');
    expect(r.g.count('/revoke')).toBe(0);
  });

  it('F8: the withdrawn-grant acknowledgement backs off 2 min, 10 min, 1 h, then 6 h, and goes on once a day after 3 days', async () => {
    const r = await rig();
    expect(await link(r).fetchClient()).toBe('written');
    cloudOffer(r, 'ho_test000001');
    revokedState(r);
    const real = r.hook.impl;
    let acks = 0;
    r.hook.impl = ((i: Parameters<typeof fetch>[0], n?: RequestInit) => {
      if (!String(i).endsWith('/handover/ack')) return real(i, n);
      acks++;
      return Promise.reject(new TypeError('fetch failed'));
    }) as typeof fetch;
    // inside 2 minutes: no try
    r.h.clock.t += 1 * MIN;
    expect(await link(r).handover()).toBe('held');
    expect(acks).toBe(0);
    r.h.clock.t += 1 * MIN + 1;
    expect(await link(r).handover()).toBe('failed');
    expect(acks).toBe(1);
    // next gap 10 minutes
    r.h.clock.t += 9 * MIN;
    expect(await link(r).handover()).toBe('held');
    r.h.clock.t += 1 * MIN + 1;
    expect(await link(r).handover()).toBe('failed');
    expect(acks).toBe(2);
    // then 1 hour
    r.h.clock.t += 59 * MIN;
    expect(await link(r).handover()).toBe('held');
    r.h.clock.t += 1 * MIN + 1;
    expect(await link(r).handover()).toBe('failed');
    expect(acks).toBe(3);
    // then every 6 hours
    r.h.clock.t += 5 * 60 * MIN;
    expect(await link(r).handover()).toBe('held');
    r.h.clock.t += 60 * MIN + 1;
    expect(await link(r).handover()).toBe('failed');
    expect(acks).toBe(4);
    // after 3 days it does not stop: one try a day, each one logged (Q5), until the cloud has heard
    r.h.clock.t += 3 * 86_400_000;
    expect(await link(r).handover()).toBe('failed');
    expect(acks).toBe(5);
    expect(r.logs.filter((l) => l.includes('asking again tomorrow')).length).toBe(1);
    r.h.clock.t += 23 * 60 * MIN;
    expect(await link(r).handover()).toBe('held');
    expect(acks).toBe(5);
    r.h.clock.t += 60 * MIN + 1;
    expect(await link(r).handover()).toBe('failed');
    expect(acks).toBe(6);
    expect(r.logs.filter((l) => l.includes('asking again tomorrow')).length).toBe(2);
    // a day later the cloud is reachable again: the acknowledgement lands and the retry ends
    r.hook.impl = real;
    r.h.clock.t += 86_400_000 + 1;
    expect(await link(r).handover()).toBe('revoked');
    expect(JSON.parse(String(stateRow(r)))).toEqual({ state: 'revoked' });
    expect(await link(r).handover()).toBe('held');
  });
});

describe('the flag', () => {
  it('M2: a sign-out made before the handover settled still reaches the cloud', async () => {
    const r = await rig();
    // the cloud has a stale "signed in" flag; this box holds no grant and the handover was never settled
    r.cloud.app.surau.db
      .prepare("INSERT INTO youtube_flag (surau_id, signed_in, channel_title, revoked, box_id, updated_at) VALUES ('sdm', 1, 'Lama', 0, ?, ?)")
      .run(r.h.app.surau.boxId, new Date().toISOString());
    expect(stateRow(r)).toBeUndefined();
    link(r).changed();
    await vi.waitFor(() => expect(r.cloud.app.surau.db.prepare('SELECT signed_in FROM youtube_flag').get()).toEqual({ signed_in: 0 }));
    expect(JSON.parse(String(stateRow(r)))).toEqual({ state: 'done' });
  });

  it('Q6: a 409 on the flag is not remembered as sent', async () => {
    const r = await rig();
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
    expect(flagSent(r)).toContain('"signedIn":false');
    // the other box leaves: the next round delivers it
    r.cloud.app.surau.db.prepare('UPDATE sites SET revoked_at = ? WHERE box_id = ?').run('2026-11-19T00:00:00.000Z', 'cccc000000000001');
    expect(await link(r).pushFlag()).toBe(true);
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
    expect(r.cloud.app.surau.db.prepare('SELECT signed_in, box_id FROM youtube_flag').get()).toEqual({ signed_in: 0, box_id: r.h.app.surau.boxId });
    // unchanged, within the day: nothing is said again
    r.h.clock.t += 5 * 60 * MIN;
    expect(await link(r).pushFlag()).toBe(true);
    expect(puts).toBe(1);
    // another box wrote "connected" under its own id
    r.cloud.app.surau.db.prepare("UPDATE youtube_flag SET signed_in = 1, channel_title = 'Lain', box_id = 'cccc000000000001'").run();
    r.h.clock.t += 20 * 60 * MIN;
    expect(await link(r).pushFlag()).toBe(true);
    expect(puts).toBe(2);
    expect(r.cloud.app.surau.db.prepare('SELECT signed_in, box_id FROM youtube_flag').get()).toEqual({ signed_in: 0, box_id: r.h.app.surau.boxId });
    // and not again until another day has passed
    expect(await link(r).pushFlag()).toBe(true);
    expect(puts).toBe(2);
  });
});

describe('Y7 (2026.11.15): a sign-out at the box', () => {
  it('the flag of a sign-out carries signedOut; the cloud has no copy of the grant to drop and keeps the plain flag', async () => {
    const r = await rig();
    // the box takes the operator's client from the cloud first (D2)
    await link(r).cycle();
    const headers = await signInHere(r);
    await vi.waitFor(() => expect(flagSent(r)).toContain('"signedIn":true'));
    const out = await r.h.app.inject({ method: 'POST', url: '/api/live/youtube/signout', headers, remoteAddress: LAN });
    expect(out.statusCode).toBe(200);
    await vi.waitFor(() => expect(flagSent(r)).toContain('"signedOut":true'));
    expect(r.cloud.app.surau.db.prepare('SELECT signed_in, revoked FROM youtube_flag').get()).toEqual({ signed_in: 0, revoked: 0 });
    expect(existsSync(join(r.h.dataDir, 'secret', 'youtube-token.json'))).toBe(false);
  });

  it('a box that never signed in does not say signedOut, and a cloud from before 2026.11.15 still takes the flag', async () => {
    const r = await rig();
    const bodies: string[] = [];
    const real = r.hook.impl;
    r.hook.impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/api/sync/youtube/flag') {
        bodies.push(String(init?.body));
        // the older cloud takes exactly the three old keys
        if (String(init?.body).includes('signedOut')) return new Response(JSON.stringify({ code: 'invalid' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      return real(input, init);
    }) as typeof fetch;
    await link(r).cycle();
    await link(r).pushFlag();
    expect(bodies.every((b) => !b.includes('signedOut'))).toBe(true);
    const headers = await signInHere(r);
    await vi.waitFor(() => expect(bodies.some((b) => b.includes('"signedIn":true'))).toBe(true));
    const n = bodies.length;
    expect((await r.h.app.inject({ method: 'POST', url: '/api/live/youtube/signout', headers, remoteAddress: LAN })).statusCode).toBe(200);
    await vi.waitFor(() => expect(bodies.length).toBe(n + 2));
    expect(JSON.parse(bodies[n]!)).toMatchObject({ signedIn: false, signedOut: true });
    expect(JSON.parse(bodies[n + 1]!)).toEqual({ signedIn: false, channelTitle: null, revoked: false });
    await vi.waitFor(() => expect(flagSent(r)).toContain('"signedIn":false'));
  });
});
