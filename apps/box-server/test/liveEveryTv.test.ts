import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveStatus } from '@surau/core';
import { getSettings, getVersion, putFeature } from '../src/settingsStore.ts';
import { boxName } from '../src/setup/state.ts';
import { loginAs, loginAsAdmin } from './authHelpers.ts';
import type { FastifyInstance } from 'fastify';
import { pairTv, TV_IP } from './support/pairTv.ts';
import type { Login } from './authHelpers.ts';
import { startBody, startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';

// real child processes (the stand-in ffmpeg of the audio leg)
vi.setConfig({ testTimeout: 40_000 });

/* Live on every TV: the viewers of the status, the audio leg that follows every TV's wish, a TV with live off, a viewer
   that drops and returns, and the cap of 8 viewers. A fake MediaMTX stands behind the WHEP proxy. */

const LAN = '10.168.1.40';
const SDP = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
const STUB = `
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(path.join(__dirname, 'argv.log'), JSON.stringify(process.argv.slice(2)) + '\\n');
process.stderr.write('[flv] ok\\n');
const tick = () => process.stdout.write('bitrate=100kbits/s\\nspeed=1.0x\\nprogress=continue\\n');
tick();
setInterval(tick, 30);
process.on('SIGTERM', () => process.exit(0));
`;

/** Pairs a screen from its own LAN address (the pairing start is limited per address). */
async function pairAt(app: FastifyInstance, admin: Login, ip: string, deviceName: string): Promise<{ cookie: string; deviceId: string; ip: string }> {
  const b = (await app.inject({ method: 'POST', url: '/api/kiosk/pair/begin', remoteAddress: ip })).json() as { code: string; pollToken: string };
  const a = await app.inject({ method: 'POST', url: '/api/kiosk/pair/approve', remoteAddress: '10.9.9.9', headers: admin.headers, payload: { code: b.code, deviceName } });
  if (a.statusCode !== 200) throw new Error(`approve ${a.statusCode}`);
  const p = await app.inject({ method: 'POST', url: '/api/kiosk/pair/poll', remoteAddress: ip, payload: { pollToken: b.pollToken } });
  const raw = p.headers['set-cookie'];
  return { cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]!, deviceId: String(a.json().deviceId), ip };
}

const harnesses: LiveHarness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A box with a running live and two paired screens (a follower box and a browser screen both use a kiosk cookie). */
async function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'surau-everytv-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'stub-ffmpeg.cjs'), STUB);
  const h = await startLiveHarness({
    live: { relay: { ffmpegPath: process.execPath, argsPrefix: [join(dir, 'stub-ffmpeg.cjs')], pollMs: 10, backoffBaseMs: 5, backoffMaxMs: 20, killAfterMs: 500 } },
  });
  harnesses.push(h);
  const admin = await loginAsAdmin(h.app);
  const follower = await pairTv(h.app, admin, 'Kotak Ruang Muslimat');
  const browser = await pairTv(h.app, admin, 'Skrin Dewan Utama');
  const db = h.app.surau.db;
  const profiles = (tvs: Record<string, unknown>): void => {
    putFeature(db, 'tvProfiles', { tvs }, 'test', undefined, 'sdm');
    h.app.liveSessions!.publishKiosk();
  };
  const runs = (): number => (existsSync(join(dir, 'argv.log')) ? readFileSync(join(dir, 'argv.log'), 'utf8').split('\n').filter((l) => l !== '').length : 0);
  const whepAs = (who: 'self' | { cookie: string; ip?: string }, id?: string) => {
    if (id !== undefined) h.fake.webSessionId = id;
    return h.app.inject({
      method: 'POST',
      url: '/api/kiosk/live/whep',
      headers: who === 'self' ? { 'content-type': 'application/sdp' } : { 'content-type': 'application/sdp', cookie: who.cookie },
      payload: SDP,
      remoteAddress: who === 'self' ? '127.0.0.1' : (who.ip ?? TV_IP),
    });
  };
  const del = (who: 'self' | { cookie: string; ip?: string }, id: string) =>
    h.app.inject({
      method: 'DELETE',
      url: `/api/kiosk/live/whep/${id}`,
      ...(who === 'self' ? {} : { headers: { cookie: who.cookie } }),
      remoteAddress: who === 'self' ? '127.0.0.1' : (who.ip ?? TV_IP),
    });
  const startLive = async (): Promise<void> => {
    h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1', bytesReceived: 5 });
    const live = await loginAs(h.app, 'live');
    const r = await h.app.inject({ method: 'POST', url: '/api/live/start', headers: live.headers, payload: startBody(h), remoteAddress: LAN });
    expect(r.statusCode).toBe(200);
    await until(() => h.app.liveSessions!.kioskLive().live);
  };
  const viewers = () => h.app.liveSessions!.status().viewers;
  return { h, admin, follower, browser, profiles, runs, whepAs, del, startLive, viewers };
}

describe('viewers in the live status', () => {
  it('lists the own TV, a follower box and a browser screen once each, with their names', async () => {
    const t = await rig();
    t.profiles({ self: { name: 'Dewan Utama' } });
    await t.startLive();
    // no viewer yet
    expect(t.viewers()).toEqual([]);

    expect((await t.whepAs('self', 'own-1')).statusCode).toBe(201);
    expect((await t.whepAs(t.follower, 'fol-1')).statusCode).toBe(201);
    expect((await t.whepAs(t.browser, 'brw-1')).statusCode).toBe(201);
    const list = t.viewers()!;
    expect(list).toHaveLength(3);
    // the TV profile name wins; a paired screen without one shows its device name
    expect(list).toContainEqual({ tvId: 'self', name: 'Dewan Utama', state: 'playing' });
    expect(list).toContainEqual({ tvId: t.follower.deviceId, name: 'Kotak Ruang Muslimat', state: 'playing' });
    expect(list).toContainEqual({ tvId: t.browser.deviceId, name: 'Skrin Dewan Utama', state: 'playing' });

    // the same list is in the status answer an app reads
    const live = await loginAs(t.h.app, 'live');
    const r = await t.h.app.inject({ method: 'GET', url: '/api/live/status', headers: live.headers, remoteAddress: LAN });
    expect((r.json() as LiveStatus).viewers).toHaveLength(3);

    // a viewer that leaves is gone from the list
    expect((await t.del(t.browser, 'brw-1')).statusCode).toBe(204);
    expect(t.viewers()!.map((v) => v.tvId).sort()).toEqual(['self', t.follower.deviceId].sort());
  });

  it('has no viewers field while no live runs, and an older reader is not broken by it (additive)', async () => {
    const t = await rig();
    expect(t.h.app.liveSessions!.status().viewers).toBeUndefined();
    await t.startLive();
    expect(Array.isArray(t.viewers())).toBe(true);
  });

  it('a TV counts once when it drops and returns', async () => {
    const t = await rig();
    await t.startLive();
    expect((await t.whepAs(t.browser, 'a-1')).statusCode).toBe(201);
    // the screen dropped without a DELETE and asks again
    expect((await t.whepAs(t.browser, 'a-2')).statusCode).toBe(201);
    expect(t.viewers()!.filter((v) => v.tvId === t.browser.deviceId)).toHaveLength(1);
    // it leaves for good: the old slot goes with the DELETE of the new one
    expect((await t.del(t.browser, 'a-2')).statusCode).toBe(204);
    expect((await t.del(t.browser, 'a-1')).statusCode).toBe(204);
    expect(t.viewers()).toEqual([]);
  });
});

describe('a TV with live off', () => {
  it('never gets a WHEP session, shows as off, and the others still play', async () => {
    const t = await rig();
    t.profiles({ [t.browser.deviceId]: { live: { show: false } } });
    await t.startLive();
    const before = t.h.fake.requests.filter((q) => q.url.endsWith('/whep')).length;
    const refused = await t.whepAs(t.browser, 'x-1');
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'tv_live_off' });
    expect(t.h.fake.requests.filter((q) => q.url.endsWith('/whep')).length).toBe(before);
    expect((await t.whepAs('self', 'own-1')).statusCode).toBe(201);
    const list = t.viewers()!;
    expect(list).toContainEqual({ tvId: t.browser.deviceId, name: 'Skrin Dewan Utama', state: 'off' });
    expect(list).toContainEqual({ tvId: 'self', name: boxName(t.h.app.surau.db, t.h.app.surau.boxId), state: 'playing' });
  });
});

describe('the cap of 8 viewers', () => {
  it('refuses a ninth different TV with a code, and a returning TV takes its own slot back', async () => {
    const t = await rig();
    await t.startLive();
    // the own TV, the follower, the browser screen and five more: eight different TVs
    const screens = [t.follower, t.browser];
    for (let i = 0; i < 5; i++) screens.push(await pairAt(t.h.app, t.admin, `10.168.50.${10 + i}`, `Skrin ${i + 1}`));
    expect((await t.whepAs('self', 'own')).statusCode).toBe(201);
    for (let i = 0; i < screens.length; i++) expect((await t.whepAs(screens[i]!, `s${i}`)).statusCode, `screen ${i}`).toBe(201);
    expect(t.viewers()).toHaveLength(8);
    const ninth = await pairAt(t.h.app, t.admin, '10.168.50.30', 'Skrin 7');
    const refused = await t.whepAs(ninth, 'nine');
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: 'too_many_viewers' });
    expect(t.viewers()).toHaveLength(8);
    // a TV already in the table drops and returns: it replaces its own slot and the table stays at eight
    expect((await t.whepAs(screens[3]!, 'again')).statusCode).toBe(201);
    expect(t.viewers()).toHaveLength(8);
  });
});

describe('the audio leg follows every TV', () => {
  it('runs while any one TV wants sound and ends when none does', async () => {
    const t = await rig();
    // the surau's own sound is off; only one TV asks for it
    putFeature(t.h.app.surau.db, 'liveOnKiosk', { audio: false }, 'test', undefined, 'sdm');
    t.profiles({ [t.browser.deviceId]: { live: { audio: true } } });
    await t.startLive();
    await until(() => t.runs() === 1);
    await until(() => t.h.app.liveSessions!.kioskPath() === 'surau-kiosk');
    // the TV that wants no sound reads the same Opus copy (it mutes itself)
    expect((await t.whepAs(t.follower, 'f-1')).statusCode).toBe(201);
    expect(t.h.fake.requests.some((q) => q.url === '/surau-kiosk/whep')).toBe(true);

    // a second TV asks too: still one leg
    t.profiles({ [t.browser.deviceId]: { live: { audio: true } }, [t.follower.deviceId]: { live: { audio: true } } });
    await new Promise((r) => setTimeout(r, 120));
    expect(t.runs()).toBe(1);

    // one stops wanting sound: the leg stays for the other
    t.profiles({ [t.browser.deviceId]: null });
    await new Promise((r) => setTimeout(r, 120));
    expect(t.h.app.liveSessions!.kioskPath()).toBe('surau-kiosk');

    // none wants it: the leg ends and the kiosk reads the plain path again
    t.profiles({ [t.follower.deviceId]: null });
    expect(t.h.app.liveSessions!.kioskPath()).toBe('surau');
    await t.h.app.liveSessions!.settled();
    const users = t.h.fake.global.authInternalUsers as Array<{ user: string }>;
    expect(users.some((u) => u.user.startsWith('kioskaudio-'))).toBe(false);
  });

  it('a TV that wants sound but has its live picture off does not keep the leg running', async () => {
    const t = await rig();
    putFeature(t.h.app.surau.db, 'liveOnKiosk', { audio: false }, 'test', undefined, 'sdm');
    t.profiles({ [t.browser.deviceId]: { live: { audio: true, show: false } } });
    await t.startLive();
    await new Promise((r) => setTimeout(r, 200));
    expect(t.runs()).toBe(0);
    expect(t.h.app.liveSessions!.kioskPath()).toBe('surau');
  });
});

// 2026.11.15, Lane A task A7: a TV that keeps playing stays listed (K1).
describe('A7: viewer refresh and prune (K1)', () => {
  const alive = (h: LiveHarness, who: 'self' | { cookie: string; ip?: string }, id: string) =>
    h.app.inject({
      method: 'POST',
      url: `/api/kiosk/live/whep/${id}/alive`,
      ...(who === 'self' ? {} : { headers: { cookie: who.cookie } }),
      remoteAddress: who === 'self' ? '127.0.0.1' : (who.ip ?? TV_IP),
    });

  it('K1: a TV playing for 31 minutes that says it is still watching stays listed (success path); a silent one is forgotten, not closed at MediaMTX, and comes back with a late alive', async () => {
    const t = await rig();
    await t.startLive();
    const owner = t.h.app.liveSessions!.current()!.deviceId;
    // the media server counts both TVs as readers, so the count check leaves every row alone
    vi.spyOn(t.h.app.liveRuntime!.api!, 'pathWebrtcReaders').mockResolvedValue(['r1', 'r2']);
    expect((await t.whepAs(t.browser, 'b-1')).statusCode).toBe(201);
    expect((await t.whepAs(t.follower, 'f-1')).statusCode).toBe(201);
    // the browser screen's page says "still watching" every 5 minutes; the other TV lost power
    for (let i = 0; i < 7; i++) {
      t.h.clock.t += 5 * 60_000;
      t.h.app.liveSessions!.heartbeat(owner);
      expect((await alive(t.h, t.browser, 'b-1')).statusCode).toBe(204);
    }
    expect(t.h.clock.t).toBeGreaterThan(0);
    const listed = t.viewers()!.filter((v) => v.state === 'playing').map((v) => v.tvId);
    expect(listed).toEqual([t.browser.deviceId]);
    // Q1: the silent TV's row is only forgotten; no DELETE reaches MediaMTX for either TV
    await new Promise((r) => setTimeout(r, 100));
    expect(t.h.fake.requests.some((q) => q.method === 'DELETE' && q.url === '/surau/whep/f-1')).toBe(false);
    expect(t.h.fake.requests.some((q) => q.method === 'DELETE' && q.url === '/surau/whep/b-1')).toBe(false);
    // a late alive of the follower TV gets its row back (the id was issued to it)
    expect((await alive(t.h, t.follower, 'f-1')).statusCode).toBe(204);
    expect(t.viewers()!.filter((v) => v.state === 'playing').map((v) => v.tvId).sort()).toEqual([t.browser.deviceId, t.follower.deviceId].sort());
    // another TV cannot take the id
    expect((await alive(t.h, t.browser, 'f-1')).statusCode).toBe(404);
  });

  it('K1: only the TV that opened a viewer keeps it alive; an unknown viewer is 404; no cookie is refused', async () => {
    const t = await rig();
    await t.startLive();
    expect((await t.whepAs(t.browser, 'b-1')).statusCode).toBe(201);
    expect((await alive(t.h, t.follower, 'b-1')).statusCode).toBe(404);
    expect((await alive(t.h, t.browser, 'nope')).statusCode).toBe(404);
    expect((await alive(t.h, t.browser, 'b-1')).statusCode).toBe(204);
    const anon = await t.h.app.inject({ method: 'POST', url: '/api/kiosk/live/whep/b-1/alive', remoteAddress: '10.168.50.99' });
    expect([401, 403]).toContain(anon.statusCode);
  });
});

// Build 5, lane A (A1, A2, A6): the per-TV switch "Paparkan siaran langsung".
describe('PUT /api/live/tv-show', () => {
  type Rig = Awaited<ReturnType<typeof rig>>;
  const put = (t: Rig, login: Login, payload: unknown) =>
    t.h.app.inject({ method: 'PUT', url: '/api/live/tv-show', headers: login.headers, payload: payload as object, remoteAddress: LAN });
  const entryOf = (t: Rig, tvId: string) => getSettings(t.h.app.surau.db, 'sdm').tvProfiles.tvs[tvId];

  it('false for self keeps the name and the other choices, lists self as off, refuses its WHEP, and tells only that TV the live is off', async () => {
    const t = await rig();
    t.profiles({ self: { name: 'Dewan Utama', orientation: 'portrait', live: { audio: true } } });
    await t.startLive();
    const live = await loginAs(t.h.app, 'live');
    const r = await put(t, live, { tvId: 'self', show: false });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ tvId: 'self', show: false });
    expect(entryOf(t, 'self')).toMatchObject({ name: 'Dewan Utama', orientation: 'portrait', live: { audio: true, show: false } });

    expect(t.viewers()).toContainEqual({ tvId: 'self', name: 'Dewan Utama', state: 'off' });
    const refused = await t.whepAs('self', 'own-1');
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'tv_live_off' });
    // the event of each TV is the surau's state laid over by its own profile: only `self` is told `live: false`
    const base = t.h.app.liveSessions!.kioskLive();
    expect(base.live).toBe(true);
    expect(t.h.app.liveSessions!.liveForTv(base, 'self').live).toBe(false);
    expect(t.h.app.liveSessions!.liveForTv(base, t.browser.deviceId).live).toBe(true);
    expect(t.h.app.liveSessions!.liveForTv(base, t.follower.deviceId).live).toBe(true);
  });

  it('true removes the key so the TV follows the surau again; the rest of its entry stays', async () => {
    const t = await rig();
    t.profiles({ self: { name: 'Dewan Utama', live: { show: false, volume: 30 } }, [t.browser.deviceId]: { live: { show: false } } });
    await t.startLive();
    const live = await loginAs(t.h.app, 'live');
    expect((await t.whepAs('self', 'own-1')).statusCode).toBe(403);
    expect((await put(t, live, { tvId: 'self', show: true })).json()).toEqual({ tvId: 'self', show: true });
    expect(entryOf(t, 'self')).toEqual({ name: 'Dewan Utama', live: { volume: 30 } });
    expect((await t.whepAs('self', 'own-2')).statusCode).toBe(201);
    // an emptied `live` object goes too, and the entry stays as {} (never null: that would remove the TV)
    expect((await put(t, live, { tvId: t.browser.deviceId, show: true })).statusCode).toBe(200);
    expect(entryOf(t, t.browser.deviceId)).toEqual({});
    expect((await t.whepAs(t.browser, 'b-1')).statusCode).toBe(201);
  });

  it('works for a linked box or paired screen by its device id, and writes nothing when there is nothing to change', async () => {
    const t = await rig();
    const live = await loginAs(t.h.app, 'live');
    const db = t.h.app.surau.db;
    const versionBefore = getVersion(db, 'sdm');
    // a paired screen with no entry yet: true is already the case, nothing written, no empty entry made
    expect((await put(t, live, { tvId: t.follower.deviceId, show: true })).statusCode).toBe(200);
    expect(entryOf(t, t.follower.deviceId)).toBeUndefined();
    expect(getVersion(db, 'sdm')).toBe(versionBefore);
    expect((await put(t, live, { tvId: t.follower.deviceId, show: false })).statusCode).toBe(200);
    expect(entryOf(t, t.follower.deviceId)).toEqual({ live: { show: false } });
    expect(getVersion(db, 'sdm')).toBeGreaterThan(versionBefore);
    const again = getVersion(db, 'sdm');
    expect((await put(t, live, { tvId: t.follower.deviceId, show: false })).statusCode).toBe(200);
    expect(getVersion(db, 'sdm')).toBe(again);
  });

  it('an unknown TV is 404 unknown_tv; a bad body is 400', async () => {
    const t = await rig();
    const live = await loginAs(t.h.app, 'live');
    const nope = await put(t, live, { tvId: 'no-such-screen', show: false });
    expect(nope.statusCode).toBe(404);
    expect(nope.json()).toMatchObject({ code: 'unknown_tv' });
    for (const bad of [{ tvId: 'self' }, { tvId: 'self', show: 'no' }, { tvId: 5, show: false }, { tvId: 'a b', show: false }, { tvId: '__proto__', show: false }]) {
      const r = await put(t, live, bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await put(t, live, [])).statusCode).toBe(400);
  });

  it('a phone device and an inherited object key are unknown TVs (404), not a 500', async () => {
    const t = await rig();
    const live = await loginAs(t.h.app, 'live');
    t.h.app.surau.db.prepare("UPDATE devices SET platform = 'android' WHERE id = ?").run(t.browser.deviceId);
    expect((await put(t, live, { tvId: t.browser.deviceId, show: false })).statusCode).toBe(404);
    for (const key of ['constructor', 'toString', 'hasOwnProperty']) {
      const r = await put(t, live, { tvId: key, show: false });
      expect(r.statusCode, key).toBe(404);
      expect(r.json()).toMatchObject({ code: 'unknown_tv' });
    }
  });

  it('a revoked screen with no profile is unknown', async () => {
    const t = await rig();
    const live = await loginAs(t.h.app, 'live');
    t.h.app.surau.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run('2026-11-05T00:00:00.000Z', t.browser.deviceId);
    expect((await put(t, live, { tvId: t.browser.deviceId, show: false })).statusCode).toBe(404);
  });

  it('a caller without live:settings is 403 and nothing is written; a Siaran Langsung holder without settings:write is 200', async () => {
    const t = await rig();
    const ajk = await loginAs(t.h.app, 'ajk');
    const denied = await put(t, ajk, { tvId: 'self', show: false });
    expect(denied.statusCode).toBe(403);
    expect(entryOf(t, 'self')).toBeUndefined();
    const live = await loginAs(t.h.app, 'live');
    expect((await put(t, live, { tvId: 'self', show: false })).statusCode).toBe(200);
    expect(entryOf(t, 'self')).toEqual({ live: { show: false } });
    // the same caller may not write the whole feature through the settings route
    const viaSettings = await t.h.app.inject({ method: 'PUT', url: '/api/settings/tvProfiles', headers: live.headers, payload: { tvs: { self: { name: 'X' } } }, remoteAddress: LAN });
    expect(viaSettings.statusCode).toBe(403);
  });

  it('the 16 TV cap of the settings is answered as the editor would', async () => {
    const t = await rig();
    const tvs: Record<string, unknown> = {};
    for (let i = 0; i < 16; i++) tvs[`tv-${i}`] = { name: `TV ${i}` };
    t.profiles(tvs);
    const live = await loginAs(t.h.app, 'live');
    const r = await put(t, live, { tvId: 'self', show: false });
    expect(r.statusCode).toBe(400);
    expect(r.json().errors[0]).toMatch(/at most 16/);
    expect(entryOf(t, 'self')).toBeUndefined();
  });

  it('the status names the box own TV with the name of the box when its profile has none', async () => {
    const t = await rig();
    await t.startLive();
    expect((await t.whepAs('self', 'own-1')).statusCode).toBe(201);
    const own = t.viewers()!.find((v) => v.tvId === 'self')!;
    expect(own.name).toBe(boxName(t.h.app.surau.db, t.h.app.surau.boxId));
    expect(own.name).not.toBe('self');
    // a profile name still wins
    t.profiles({ self: { name: 'Dewan Utama' } });
    expect(t.viewers()!.find((v) => v.tvId === 'self')!.name).toBe('Dewan Utama');
  });
});
