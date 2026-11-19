import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeedEntry } from '@surau/core';
import { openDb } from '../src/db.ts';
import { createYoutubeService } from '../src/live/youtube/api.ts';
import type { YoutubeService } from '../src/live/youtube/api.ts';
import { getSettings, getVersion, putFeature } from '../src/settingsStore.ts';
import { applyFeedEntry } from '../src/sync/apply.ts';
import type { ApplyCtx } from '../src/sync/apply.ts';
import { loginAs } from './authHelpers.ts';
import { startFakeGoogle } from './support/fakeGoogle.ts';
import type { FakeGoogle } from './support/fakeGoogle.ts';
import { startBody, startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';

/* Release 2026.11.13 round 2, W4 (box): the YouTube sign-in is remembered across restarts, "cannot tell" is never
   "signed out", Google withdrawing the grant is remembered with its date, and the surau's YouTube choice for the next
   live (`liveYoutube.nextLiveOn`) is one setting for everyone. Google is a local fake; no real account is used. */

const LAN = '10.168.1.40';
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0)) await c();
});

interface Rig {
  h: LiveHarness;
  g: FakeGoogle;
  tokenPath: string;
  svc: (over?: { fetchImpl?: typeof fetch; grantCheck?: { firstMs?: number; everyMs?: number; off?: boolean } }) => YoutubeService;
}

async function rig(app: Record<string, unknown> = {}): Promise<Rig> {
  const g = await startFakeGoogle();
  const h = await startLiveHarness({ app: { fetchImpl: g.fetchImpl, ...app } });
  closers.push(h.close, g.close);
  writeFileSync(join(h.dataDir, 'secret', 'youtube-client.json'), JSON.stringify({ client_id: 'cid-123.apps.googleusercontent.com', client_secret: 'csecret-SECRET' }));
  const made: YoutubeService[] = [];
  closers.push(async () => made.forEach((s) => s.shutdown()));
  return {
    h,
    g,
    tokenPath: join(h.dataDir, 'secret', 'youtube-token.json'),
    // a restarted box: a new service over the same data folder
    svc: (over = {}) => {
      const s = createYoutubeService({ db: h.app.surau.db, dataDir: h.dataDir, fetchImpl: over.fetchImpl ?? g.fetchImpl, now: h.clock.now, grantCheck: { off: true }, ...over });
      made.push(s);
      return s;
    },
  };
}

const call = (r: Rig, method: 'GET' | 'POST' | 'PUT', url: string, headers: Record<string, string>, payload?: object) =>
  r.h.app.inject({ method, url, headers, ...(payload ? { payload } : {}), remoteAddress: LAN });

async function signIn(r: Rig): Promise<{ admin: Awaited<ReturnType<typeof loginAs>> }> {
  const admin = await loginAs(r.h.app, 'admin');
  expect((await call(r, 'POST', '/api/live/youtube/signin', admin.headers)).statusCode).toBe(200);
  r.g.approve = true;
  r.h.clock.t += 6000;
  const done = await call(r, 'POST', '/api/live/youtube/signin/poll', admin.headers);
  expect(done.json()).toMatchObject({ state: 'signed_in', signedIn: true });
  return { admin };
}

/** A fetch that answers every refresh with this status (a Google 5xx) and leaves the rest to the fake. */
const refreshFails = (g: FakeGoogle, status: number): typeof fetch =>
  (async (input: string | URL | { url: string }, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/token') && String(init?.body ?? '').includes('refresh_token')) return new Response('{"error":"backend_error"}', { status });
    return g.fetchImpl(input as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;

const unreachable: typeof fetch = (async () => {
  throw new TypeError('network down');
}) as typeof fetch;

describe('the sign-in is remembered across restarts and "cannot tell" is not "signed out"', () => {
  it('a restart with Google unreachable stays signed in and names the channel (no network is needed to know)', async () => {
    const r = await rig();
    await signIn(r);
    const again = r.svc({ fetchImpl: unreachable });
    expect(again.info()).toMatchObject({ state: 'signedIn', signedIn: true, reason: null, channelTitle: 'Surau Contoh', lastGood: { signedIn: true, channelTitle: 'Surau Contoh' } });
    expect(again.status().account).toMatchObject({ state: 'signedIn' });
  });

  it('a token file that will not open is unknown with the last good channel, never signed out, and heals when it opens', async () => {
    const r = await rig();
    await signIn(r);
    const good = readFileSync(r.tokenPath, 'utf8');
    writeFileSync(r.tokenPath, 'v1.AAAA.BBBB.CCCC');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const again = r.svc();
    const i = again.info();
    expect(i).toMatchObject({ state: 'unknown', reason: 'token_unreadable', signedIn: true, channelTitle: 'Surau Contoh' });
    expect(i.lastGood?.at).toBeTruthy();
    // the leg itself cannot use it, and that is not a request to sign in again
    expect(again.signedIn()).toBe(false);
    expect(i.lastError).toBeNull();
    // the file opens a moment later (a lock ended): the next read is signed in again
    writeFileSync(r.tokenPath, good);
    expect(again.info()).toMatchObject({ state: 'signedIn', reason: null });
    expect(again.signedIn()).toBe(true);
  });

  it('no grant here but the handover is not settled (cloud asleep or not asked yet) is unknown; settled with no grant is signed out', async () => {
    const r = await rig();
    const svc = r.svc();
    expect(svc.info()).toMatchObject({ state: 'signedOut', signedIn: false, reason: null });
    svc.setUnknownProbe(() => 'cloud_unreachable');
    expect(svc.info()).toMatchObject({ state: 'unknown', reason: 'cloud_unreachable', lastGood: null });
    svc.setUnknownProbe(() => 'handover_pending');
    expect(svc.status().account).toMatchObject({ state: 'unknown', reason: 'handover_pending' });
    svc.setUnknownProbe(() => null);
    expect(svc.info().state).toBe('signedOut');
  });

  it('a probe never overrides a grant the box holds', async () => {
    const r = await rig();
    await signIn(r);
    const again = r.svc({ fetchImpl: unreachable });
    again.setUnknownProbe(() => 'cloud_unreachable');
    expect(again.info()).toMatchObject({ state: 'signedIn', reason: null });
  });

  it('the status routes carry the three-state fields next to the old ones', async () => {
    const r = await rig();
    const { admin } = await signIn(r);
    const s = (await call(r, 'GET', '/api/live/youtube/status', admin.headers)).json();
    expect(s).toMatchObject({ configured: true, signedIn: true, channelTitle: 'Surau Contoh', lastError: null, heldBy: 'box', signInHere: true, state: 'signedIn', reason: null });
    expect(s.lastGood).toMatchObject({ signedIn: true, channelTitle: 'Surau Contoh' });
    const live = (await call(r, 'GET', '/api/live/status', admin.headers)).json();
    expect(live.youtube).toMatchObject({ signedIn: true, state: 'none', account: { state: 'signedIn' } });
  });

  it('an explicit sign-out is signed out with its reason, and stays so after a restart', async () => {
    const r = await rig();
    const { admin } = await signIn(r);
    expect((await call(r, 'POST', '/api/live/youtube/signout', admin.headers)).json()).toEqual({ signedIn: false });
    const again = r.svc({ fetchImpl: unreachable });
    expect(again.info()).toMatchObject({ state: 'signedOut', signedIn: false, reason: 'signed_out', lastGood: null });
  });
});

describe('Google withdrawing the grant is the only thing that ends a sign-in, and it is remembered', () => {
  it('invalid_grant on the daily look shows signed out with its date at once, survives a restart, and is cleared by a new sign-in', async () => {
    const r = await rig();
    const { admin } = await signIn(r);
    const svc = r.svc();
    r.h.clock.t += 4000_000;
    r.g.refreshError = 'invalid_grant';
    expect(await svc.verifyGrant()).toBe('revoked');
    const at = new Date(r.h.clock.t).toISOString();
    expect(svc.info()).toMatchObject({ state: 'signedOut', signedIn: false, reason: 'reauthorise', lastError: 'reauthorise', revokedAt: at });
    // the history says so, once, without a token
    const rows = r.h.app.surau.db.prepare("SELECT entity_id, after_json FROM change_log WHERE entity = 'youtube' ORDER BY id").all() as Array<{ entity_id: string; after_json: string }>;
    expect(rows.map((x) => x.entity_id)).toEqual(['signin', 'revoked']);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
    // a restart with Google unreachable: still signed out, with the same date, not "signed in" from the file on disk
    const again = r.svc({ fetchImpl: unreachable });
    expect(again.info()).toMatchObject({ state: 'signedOut', signedIn: false, reason: 'reauthorise', lastError: 'reauthorise', revokedAt: at });
    expect(again.signedIn()).toBe(false);
    // asked again: no second refresh is made and no second history row
    const grants = (): number => r.g.calls.filter((c) => c.path === '/token' && new URLSearchParams(c.body).get('grant_type') === 'refresh_token').length;
    const before = grants();
    expect(await svc.verifyGrant()).toBe('skipped');
    expect(grants()).toBe(before);
    // one new sign-in ends it
    r.g.refreshError = null;
    await call(r, 'POST', '/api/live/youtube/signin', admin.headers);
    r.h.clock.t += 6000;
    r.g.approve = true;
    await call(r, 'POST', '/api/live/youtube/signin/poll', admin.headers);
    expect(r.svc({ fetchImpl: unreachable }).info()).toMatchObject({ state: 'signedIn', reason: null, revokedAt: null });
  });

  it('invalid_grant found at a live start is remembered across a restart too (it was in memory only before)', async () => {
    const r = await rig();
    await signIn(r);
    const liveUser = await loginAs(r.h.app, 'live');
    r.h.clock.t += 4000_000;
    r.g.refreshError = 'invalid_grant';
    await call(r, 'POST', '/api/live/start', liveUser.headers, startBody(r.h, { outputs: { kiosk: true, youtube: true } }));
    await new Promise((x) => setTimeout(x, 150));
    const again = r.svc({ fetchImpl: unreachable });
    expect(again.info()).toMatchObject({ state: 'signedOut', reason: 'reauthorise', lastError: 'reauthorise' });
  });

  it.each([500, 503])('a Google %i on a refresh stays signed in (also after a restart)', async (status) => {
    const r = await rig();
    await signIn(r);
    r.h.clock.t += 4000_000;
    const svc = r.svc({ fetchImpl: refreshFails(r.g, status) });
    expect(await svc.verifyGrant()).toBe('failed');
    expect(svc.info()).toMatchObject({ state: 'signedIn', signedIn: true, reason: null });
    expect(r.svc({ fetchImpl: refreshFails(r.g, status) }).info().state).toBe('signedIn');
  });

  it('a network error on a refresh stays signed in', async () => {
    const r = await rig();
    await signIn(r);
    r.h.clock.t += 4000_000;
    const svc = r.svc({ fetchImpl: unreachable });
    expect(await svc.verifyGrant()).toBe('failed');
    expect(svc.info()).toMatchObject({ state: 'signedIn', signedIn: true });
  });

  it('the daily timer looks by itself: a withdrawn grant shows without anyone opening the Live screen', async () => {
    const r = await rig();
    await signIn(r);
    r.g.refreshError = 'invalid_grant';
    r.h.clock.t += 4000_000;
    const svc = r.svc({ grantCheck: { firstMs: 20, everyMs: 3_600_000 } });
    expect(svc.info().state).toBe('signedIn');
    const end = Date.now() + 3000;
    while (svc.info().state !== 'signedOut' && Date.now() < end) await new Promise((x) => setTimeout(x, 15));
    expect(svc.info()).toMatchObject({ state: 'signedOut', reason: 'reauthorise' });
  });

  it('a good refresh keeps the last good sign-in up to date', async () => {
    const r = await rig();
    await signIn(r);
    const svc = r.svc();
    r.h.clock.t += 4000_000;
    expect(await svc.verifyGrant()).toBe('ok');
    expect(svc.info().lastGood?.at).toBe(new Date(r.h.clock.t).toISOString());
  });
});

describe('a start with YouTube on does not wait for the cloud', () => {
  it('a cloud that takes longer than the wake budget changes nothing: the box leg is local and the broadcast is made', async () => {
    let cloudCalls = 0;
    // a cloud that is asleep: every call hangs well past `cloudWakeSeconds` (20 s) and the ~35 s cold wake
    const asleep = (() => {
      cloudCalls += 1;
      return new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch;
    const r = await rig({ sync: { auto: false, fetchImpl: asleep } });
    await signIn(r);
    const liveUser = await loginAs(r.h.app, 'live');
    const t0 = Date.now();
    const res = await call(r, 'POST', '/api/live/start', liveUser.headers, startBody(r.h, { outputs: { kiosk: true, youtube: true } }));
    expect(res.statusCode).toBe(200);
    const end = Date.now() + 5000;
    while (r.g.count('/youtube/v3/liveBroadcasts') === 0 && Date.now() < end) await new Promise((x) => setTimeout(x, 15));
    expect(r.g.calls.some((c) => c.path === '/youtube/v3/liveBroadcasts' && c.method === 'POST')).toBe(true);
    expect(res.json().warnings ?? []).not.toContain('youtube_cloud_unreachable');
    expect(res.json().warnings ?? []).not.toContain('youtube_not_signed_in');
    expect(cloudCalls).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});

describe('the surau choice for the next live: liveYoutube.nextLiveOn', () => {
  it('is on by default, in the settings every device reads', async () => {
    const r = await rig();
    const admin = await loginAs(r.h.app, 'admin');
    const s = (await call(r, 'GET', '/api/settings', admin.headers)).json();
    expect(s.liveYoutube.nextLiveOn).toBe(true);
  });

  it('any admin with live:control sets it; another sees it; last change wins; it is logged with the actor and bumps the version', async () => {
    const r = await rig();
    const liveRole = await loginAs(r.h.app, 'live');
    const admin = await loginAs(r.h.app, 'admin');
    const db = r.h.app.surau.db;
    const v0 = getVersion(db, 'sdm');
    const off = await call(r, 'PUT', '/api/live/youtube/next-live', liveRole.headers, { on: false });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ nextLiveOn: false });
    expect(getVersion(db, 'sdm')).toBeGreaterThan(v0);
    expect((await call(r, 'GET', '/api/settings', admin.headers)).json().liveYoutube.nextLiveOn).toBe(false);
    const row = db.prepare("SELECT actor, before_json, after_json FROM change_log WHERE entity = 'settings' AND entity_id = 'liveYoutube' ORDER BY id DESC").get() as { actor: string; after_json: string };
    expect(row.actor).toMatch(/^user:/);
    expect(JSON.parse(row.after_json).nextLiveOn).toBe(false);
    const on = await call(r, 'PUT', '/api/live/youtube/next-live', admin.headers, { on: true });
    expect(on.json()).toEqual({ nextLiveOn: true });
    expect((await call(r, 'GET', '/api/settings', liveRole.headers)).json().liveYoutube.nextLiveOn).toBe(true);
    // the same value again changes nothing and logs nothing more
    const n = (db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'settings' AND entity_id = 'liveYoutube'").get() as { n: number }).n;
    await call(r, 'PUT', '/api/live/youtube/next-live', admin.headers, { on: true });
    expect((db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'settings' AND entity_id = 'liveYoutube'").get() as { n: number }).n).toBe(n);
  });

  it('a person without live:control gets 403, a bad body 400, and nobody unsigned in gets in', async () => {
    const r = await rig();
    const ajk = await loginAs(r.h.app, 'ajk');
    expect((await call(r, 'PUT', '/api/live/youtube/next-live', ajk.headers, { on: false })).statusCode).toBe(403);
    const admin = await loginAs(r.h.app, 'admin');
    expect((await call(r, 'PUT', '/api/live/youtube/next-live', admin.headers, { on: 'no' })).statusCode).toBe(400);
    expect((await call(r, 'PUT', '/api/live/youtube/next-live', admin.headers, {})).statusCode).toBe(400);
    expect((await r.h.app.inject({ method: 'PUT', url: '/api/live/youtube/next-live', payload: { on: false }, remoteAddress: LAN })).statusCode).toBe(401);
    expect((await call(r, 'GET', '/api/settings', admin.headers)).json().liveYoutube.nextLiveOn).toBe(true);
  });

  it('a block (signed out, grant withdrawn) never changes it, and other liveYoutube writes keep it', async () => {
    const r = await rig();
    const admin = await loginAs(r.h.app, 'admin');
    await call(r, 'PUT', '/api/live/youtube/next-live', admin.headers, { on: false });
    await signIn(r);
    r.g.refreshError = 'invalid_grant';
    r.h.clock.t += 4000_000;
    expect(await r.svc().verifyGrant()).toBe('revoked');
    putFeature(r.h.app.surau.db, 'liveYoutube', { privacy: 'public' }, 'test', undefined, 'sdm');
    expect(getSettings(r.h.app.surau.db, 'sdm').liveYoutube).toMatchObject({ nextLiveOn: false, privacy: 'public' });
    await call(r, 'POST', '/api/live/youtube/signout', admin.headers);
    expect(getSettings(r.h.app.surau.db, 'sdm').liveYoutube.nextLiveOn).toBe(false);
  });
});

describe('nextLiveOn through the sync: per field, never reset by a side that lacks it or is older', () => {
  const dirs: string[] = [];
  const dbs: DatabaseSync[] = [];
  afterEach(() => {
    for (const d of dbs.splice(0)) {
      try {
        d.close();
      } catch {
        /* closed */
      }
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const NOW = new Date('2026-11-05T10:00:00.000Z');
  const ctx = (dir: string): ApplyCtx => ({ surauId: 'sdm', now: NOW, origin: 'cloud', actor: 'user:u1', dataDir: dir });
  const entry = (editedAt: string, after: Record<string, unknown>, deviceId = 'dev-a'): FeedEntry => ({
    seq: 1, entity: 'settings', entityId: 'liveYoutube', rev: `${editedAt}|${deviceId}`, editedAt, syncedAt: editedAt, actor: 'user:u1',
    deviceId, origin: 'app', opId: null, after,
  });

  it('lands when newer; an older entry, or one that lacks the field, leaves it alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-yt-'));
    dirs.push(dir);
    const db = openDb(join(dir, 'test.db'));
    dbs.push(db);
    const nextLive = (): unknown => getSettings(db, 'sdm').liveYoutube.nextLiveOn;
    expect(nextLive()).toBe(true);
    expect(applyFeedEntry(db, entry('2026-11-05T09:00:00.000Z', { nextLiveOn: false }), ctx(dir)).status).toBe('applied');
    expect(nextLive()).toBe(false);
    // an older side saying "on" does not win
    expect(applyFeedEntry(db, entry('2026-11-05T08:00:00.000Z', { nextLiveOn: true }, 'dev-b'), ctx(dir)).status).toBe('superseded');
    expect(nextLive()).toBe(false);
    // a side that knows nothing of the field (an edit of another field, newer) leaves it as it is
    expect(applyFeedEntry(db, entry('2026-11-05T09:30:00.000Z', { privacy: 'public' }, 'dev-c'), ctx(dir)).status).toBe('applied');
    expect(getSettings(db, 'sdm').liveYoutube).toMatchObject({ nextLiveOn: false, privacy: 'public' });
    // a whole older row (every field, "on") does not reset it either
    applyFeedEntry(db, entry('2026-11-05T07:00:00.000Z', { privacy: 'unlisted', nextLiveOn: true }, 'dev-d'), ctx(dir));
    expect(getSettings(db, 'sdm').liveYoutube).toMatchObject({ nextLiveOn: false, privacy: 'public' });
    // a newer choice from another phone wins
    expect(applyFeedEntry(db, entry('2026-11-05T09:45:00.000Z', { nextLiveOn: true }, 'dev-b'), ctx(dir)).status).toBe('applied');
    expect(nextLive()).toBe(true);
  });

  it('an entry with an unknown field is refused and changes nothing (the receiver does not store what it does not know)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-yt-'));
    dirs.push(dir);
    const db = openDb(join(dir, 'test.db'));
    dbs.push(db);
    expect(() => applyFeedEntry(db, entry('2026-11-05T09:00:00.000Z', { nextLiveOnn: false }), ctx(dir))).not.toThrow();
    expect(getSettings(db, 'sdm').liveYoutube.nextLiveOn).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'settings' AND entity_id = 'liveYoutube'").get() as { n: number }).n).toBe(0);
  });
});
