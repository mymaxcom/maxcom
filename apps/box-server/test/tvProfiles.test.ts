import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { klInstant } from '@surau/core';
import type { KioskContent, KioskLive, LiveStartRequest, Settings } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { putItem } from '../src/content/store.ts';
import { LiveSessions } from '../src/live/sessions.ts';
import { getSettings, putFeature, SettingsError } from '../src/settingsStore.ts';
import { readFeed } from '../src/sync/feed.ts';
import { loginAs, loginAsAdmin } from './authHelpers.ts';
import { pairTv, TV_IP } from './support/pairTv.ts';
import { startBody, startLiveHarness } from './support/liveHarness.ts';
import type { HarnessOptions, LiveHarness } from './support/liveHarness.ts';

vi.setConfig({ testTimeout: 40_000 });

const AT = klInstant('2026-11-03', '12:00');
const ASSET = 'c'.repeat(64);
const LAN = '10.168.1.40';
const SDP = 'v=0\r\no=- 1 1 IN IP4 10.168.1.40\r\ns=-\r\nt=0 0\r\n';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
const harnesses: LiveHarness[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const h of harnesses.splice(0)) await h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function make(): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-tv-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'), { now: () => AT, dataDir: dir });
  apps.push(app);
  app.surau.db
    .prepare('INSERT INTO assets (id, mime, bytes, width, height, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ASSET, 'image/png', 10, 2, 2, new Date().toISOString(), 'local');
  return app;
}
async function makeLive(o: HarnessOptions = {}): Promise<LiveHarness> {
  const h = await startLiveHarness(o);
  harnesses.push(h);
  return h;
}
async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const tvs = (app: FastifyInstance): Record<string, unknown> => getSettings(app.surau.db, 'sdm').tvProfiles.tvs;
const put = (app: FastifyInstance, headers: Record<string, string>, payload: unknown) =>
  app.inject({ method: 'PUT', url: '/api/settings/tvProfiles', headers, payload: payload as object, remoteAddress: LAN });

describe('per-TV merge on write', () => {
  it('two patches to two different TVs both survive', async () => {
    const app = make();
    const admin = await loginAsAdmin(app);
    expect((await put(app, admin.headers, { tvs: { self: { templateId: 'minimal' } } })).statusCode).toBe(200);
    expect((await put(app, admin.headers, { tvs: { dev1: { lang: 'en', name: 'Foyer' } } })).statusCode).toBe(200);
    expect(tvs(app)).toEqual({ self: { templateId: 'minimal' }, dev1: { lang: 'en', name: 'Foyer' } });
  });

  it('a patch replaces that TV whole and leaves the others alone', async () => {
    const app = make();
    const admin = await loginAsAdmin(app);
    await put(app, admin.headers, { tvs: { a: { lang: 'en', name: 'A' }, b: { name: 'B' } } });
    await put(app, admin.headers, { tvs: { a: { templateId: 'creative' } } });
    expect(tvs(app)).toEqual({ a: { templateId: 'creative' }, b: { name: 'B' } });
  });

  it('null removes a TV; the others stay; a read never shows it', async () => {
    const app = make();
    const admin = await loginAsAdmin(app);
    await put(app, admin.headers, { tvs: { a: { name: 'A' }, b: { name: 'B' } } });
    const r = await put(app, admin.headers, { tvs: { a: null } });
    expect(r.statusCode).toBe(200);
    expect(tvs(app)).toEqual({ b: { name: 'B' } });
    expect(r.json().tvProfiles.tvs).toEqual({ b: { name: 'B' } });
    // the removal stays in the stored row so it travels to the other boxes and the cloud
    const row = app.surau.db.prepare("SELECT json FROM settings WHERE feature = 'tvProfiles'").get()!;
    expect(JSON.parse(String(row.json)).tvs).toEqual({ a: null, b: { name: 'B' } });
    // the removed id can be used again
    await put(app, admin.headers, { tvs: { a: { name: 'A2' } } });
    expect(tvs(app)).toEqual({ a: { name: 'A2' }, b: { name: 'B' } });
  });

  it('refuses a bad profile with 400 and stores nothing', async () => {
    const app = make();
    const admin = await loginAsAdmin(app);
    for (const bad of [{ tvs: { a: { zzz: 1 } } }, { tvs: { 'bad id': {} } }, { tvs: { a: { live: { volume: 101 } } } }, { tvs: { a: { hideKinds: ['x'] } } }, { tvs: [] }]) {
      const r = await put(app, admin.headers, bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(tvs(app)).toEqual({});
  });

  it('holds at most 16 TVs in all (removed ones do not count)', () => {
    const app = make();
    const { db } = app.surau;
    const batch = (from: number, n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`tv${from + i}`, { name: 'x' }]));
    putFeature(db, 'tvProfiles', { tvs: batch(0, 16) }, 'test', undefined, 'sdm');
    expect(() => putFeature(db, 'tvProfiles', { tvs: batch(16, 1) }, 'test', undefined, 'sdm')).toThrow(SettingsError);
    expect(Object.keys(tvs(app))).toHaveLength(16);
    // replacing one of the 16 is fine, and so is trading one TV for another
    putFeature(db, 'tvProfiles', { tvs: { tv3: { name: 'y' } } }, 'test', undefined, 'sdm');
    putFeature(db, 'tvProfiles', { tvs: { tv0: null, tv16: { name: 'z' } } }, 'test', undefined, 'sdm');
    expect(Object.keys(tvs(app))).toHaveLength(16);
  });

  it('a settings read through the API holds the TVs too', async () => {
    const app = make();
    const admin = await loginAsAdmin(app);
    await put(app, admin.headers, { tvs: { a: { name: 'A' } } });
    const r = await app.inject({ method: 'GET', url: '/api/settings', headers: admin.headers, remoteAddress: LAN });
    expect((r.json() as Settings).tvProfiles).toEqual({ enabled: true, tvs: { a: { name: 'A' } } });
  });
});

describe('the sync feed carries the tvProfiles settings entry', () => {
  it('a profile and a removal are entries of the feed', () => {
    const app = make();
    const { db } = app.surau;
    putFeature(db, 'tvProfiles', { tvs: { a: { name: 'A' }, b: { lang: 'ar' } } }, 'local', undefined, 'sdm');
    putFeature(db, 'tvProfiles', { tvs: { a: null } }, 'local', undefined, 'sdm');
    const feed = readFeed(db, 0, 500, { users: false, devices: false });
    const mine = feed.entries.filter((e) => e.entity === 'settings' && e.entityId === 'tvProfiles');
    expect(mine).toHaveLength(2);
    expect(mine[0]!.after).toMatchObject({ tvs: { a: { name: 'A' }, b: { lang: 'ar' } } });
    expect(mine[1]!.after).toMatchObject({ tvs: { a: null, b: { lang: 'ar' } } });
  });
});

describe('the kiosk reads its own profile', () => {
  async function rig() {
    const app = make();
    const admin = await loginAsAdmin(app);
    const tv = await pairTv(app, admin);
    const { db } = app.surau;
    putItem(db, 'poster', { title: 'Poster 1', assetId: ASSET, days: ['jumaat'], order: 1, stretch: false }, 'test', undefined, 'sdm');
    putItem(db, 'zikir', { order: 1, textAr: 'أ', textMs: 'satu' }, 'test', undefined, 'sdm');
    putFeature(db, 'tvProfiles', {
      tvs: {
        self: { templateId: 'minimal', orientation: 'portrait', hideKinds: ['poster'], sounds: { beeps: false }, name: 'SECRET-SELF' },
        [tv.deviceId]: { templateId: 'creative', lang: 'en', live: { volume: 20 }, hideKinds: ['zikir'], name: 'SECRET-COOKIE' },
        other: { templateId: 'colourful', name: 'SECRET-OTHER' },
      },
    }, 'test', undefined, 'sdm');
    const loop = () => app.inject({ method: 'GET', url: '/api/kiosk/bundle', remoteAddress: '127.0.0.1' });
    const cookie = () => app.inject({ method: 'GET', url: '/api/kiosk/bundle', headers: { cookie: tv.cookie }, remoteAddress: TV_IP });
    return { app, admin, tv, loop, cookie };
  }

  it('the loopback TV and a paired TV get different bundles', async () => {
    const { loop, cookie } = await rig();
    const a = (await loop()).json().settings as Settings;
    const b = (await cookie()).json().settings as Settings;
    expect(a.kioskTemplate.templateId).toBe('minimal');
    expect(a.orientation.mode).toBe('portrait');
    expect(a.beeps.enabled).toBe(false);
    expect(a.language.lang).toBe('auto');
    expect(b.kioskTemplate.templateId).toBe('creative');
    expect(b.orientation.mode).toBe('landscape');
    expect(b.beeps.enabled).toBe(true);
    expect(b.language).toMatchObject({ lang: 'en', enabled: true });
    expect(b.liveOnKiosk.volume).toBe(20);
  });

  it('a TV is served only its own profile', async () => {
    const { loop, cookie, tv } = await rig();
    const a = await loop();
    const b = await cookie();
    expect(Object.keys((a.json().settings as Settings).tvProfiles.tvs)).toEqual(['self']);
    expect(Object.keys((b.json().settings as Settings).tvProfiles.tvs)).toEqual([tv.deviceId]);
    expect(a.body).not.toMatch(/SECRET-COOKIE|SECRET-OTHER/);
    expect(b.body).not.toMatch(/SECRET-SELF|SECRET-OTHER/);
  });

  it('a paired TV with no profile gets the surau values and no profile at all', async () => {
    const { app, admin } = await rig();
    const second = await pairTv(app, admin, 'TV lain');
    const r = await app.inject({ method: 'GET', url: '/api/kiosk/bundle', headers: { cookie: second.cookie }, remoteAddress: TV_IP });
    const s = r.json().settings as Settings;
    expect(s.kioskTemplate.templateId).toBe('default');
    expect(s.tvProfiles.tvs).toEqual({});
    expect(r.body).not.toMatch(/SECRET/);
  });

  it('an admin reading the route gets the surau values with no profile applied', async () => {
    const { app, admin } = await rig();
    const r = await app.inject({ method: 'GET', url: '/api/kiosk/bundle', headers: admin.headers, remoteAddress: LAN });
    const s = r.json().settings as Settings;
    expect(s.kioskTemplate.templateId).toBe('default');
    expect(s.orientation.mode).toBe('landscape');
    expect(s.beeps.enabled).toBe(true);
  });

  it('content: each TV loses the kinds it hid', async () => {
    const { app, admin, tv } = await rig();
    const content = async (init: { headers?: Record<string, string>; remoteAddress: string }) =>
      (await app.inject({ method: 'GET', url: '/api/kiosk/content', ...init })).json().content as KioskContent;
    const own = await content({ remoteAddress: '127.0.0.1' });
    const paired = await content({ headers: { cookie: tv.cookie }, remoteAddress: TV_IP });
    const adminView = await content({ headers: admin.headers, remoteAddress: LAN });
    expect(own.posters).toHaveLength(0);
    expect(own.zikir).toHaveLength(1);
    expect(paired.posters).toHaveLength(1);
    expect(paired.zikir).toHaveLength(0);
    expect(adminView.posters).toHaveLength(1);
    expect(adminView.zikir).toHaveLength(1);
  });
});

describe('live per TV', () => {
  const kioskLive = async (h: LiveHarness, init: { headers?: Record<string, string>; remoteAddress: string }): Promise<KioskLive> =>
    (await h.app.inject({ method: 'GET', url: '/api/kiosk/live', ...init })).json() as KioskLive;
  const whep = (h: LiveHarness, init: { headers?: Record<string, string>; remoteAddress: string }) =>
    h.app.inject({ method: 'POST', url: '/api/kiosk/live/whep', ...init, headers: { 'content-type': 'application/sdp', ...(init.headers ?? {}) }, payload: SDP });

  async function liveRig() {
    const h = await makeLive();
    const admin = await loginAsAdmin(h.app);
    const tv = await pairTv(h.app, admin);
    return { h, admin, tv };
  }

  it('a TV with live.show:false gets live:false and 403 tv_live_off while another TV still plays', async () => {
    const { h, tv } = await liveRig();
    putFeature(h.app.surau.db, 'liveOnKiosk', { audio: true, volume: 60 }, 'test', undefined, 'sdm');
    putFeature(h.app.surau.db, 'tvProfiles', { tvs: { [tv.deviceId]: { live: { show: false } } } }, 'test', undefined, 'sdm');
    const live = await loginAs(h.app, 'live');
    const start = await h.app.inject({ method: 'POST', url: '/api/live/start', headers: live.headers, payload: startBody(h), remoteAddress: LAN });
    expect(start.statusCode).toBe(200);
    h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1', bytesReceived: 5 });
    await until(() => h.app.liveSessions!.kioskLive().live);

    const self = { remoteAddress: '127.0.0.1' };
    const paired = { headers: { cookie: tv.cookie }, remoteAddress: TV_IP };
    expect((await kioskLive(h, self)).live).toBe(true);
    expect(await kioskLive(h, paired)).toMatchObject({ live: false, since: null });

    const off = await whep(h, paired);
    expect(off.statusCode).toBe(403);
    expect(off.json()).toMatchObject({ code: 'tv_live_off' });
    expect(h.fake.requests.some((q) => q.url.endsWith('/whep'))).toBe(false);
    expect((await whep(h, self)).statusCode).toBe(201);
  });

  it('audio and volume come from the profile when set, else from the surau', async () => {
    const { h, tv } = await liveRig();
    putFeature(h.app.surau.db, 'liveOnKiosk', { audio: true, volume: 60 }, 'test', undefined, 'sdm');
    putFeature(h.app.surau.db, 'tvProfiles', { tvs: { self: { live: { audio: false } }, [tv.deviceId]: { live: { volume: 15 } } } }, 'test', undefined, 'sdm');
    expect(await kioskLive(h, { remoteAddress: '127.0.0.1' })).toMatchObject({ audio: false, volume: 60 });
    expect(await kioskLive(h, { headers: { cookie: tv.cookie }, remoteAddress: TV_IP })).toMatchObject({ audio: true, volume: 15 });
    // no argument: exactly the surau's state, as before
    expect(h.app.liveSessions!.kioskLive()).toMatchObject({ audio: true, volume: 60 });
  });

  it('the live event of a stream is shaped for its TV', async () => {
    const { h, tv } = await liveRig();
    putFeature(h.app.surau.db, 'tvProfiles', { tvs: { [tv.deviceId]: { live: { show: false, audio: true } } } }, 'test', undefined, 'sdm');
    const base: KioskLive = { live: true, since: '2026-11-05T19:00:00Z', kuliah: null, audio: false, volume: 50, path: 'surau' };
    expect(h.app.liveSessions!.liveForTv(base, tv.deviceId)).toMatchObject({ live: false, since: null, audio: true });
    expect(h.app.liveSessions!.liveForTv(base, 'self')).toEqual(base);
    expect(h.app.liveSessions!.liveForTv(base, null)).toBe(base);
  });

  it('8 WHEP sessions are accepted and the 9th evicts the oldest', async () => {
    const { h } = await liveRig();
    const self = { remoteAddress: '127.0.0.1' };
    for (let i = 0; i < 8; i++) {
      h.fake.webSessionId = `s${i}`;
      expect((await whep(h, self)).statusCode, `session ${i}`).toBe(201);
    }
    h.fake.webSessionId = 's8';
    expect((await whep(h, self)).statusCode).toBe(201);
    const del = (id: string) => h.app.inject({ method: 'DELETE', url: `/api/kiosk/live/whep/${id}`, remoteAddress: '127.0.0.1' });
    expect((await del('s0')).statusCode).toBe(404);
    expect((await del('s1')).statusCode).toBe(204);
    expect((await del('s8')).statusCode).toBe(204);
  });
});

describe('the audio leg follows any TV that wants sound', () => {
  /** A stand-in for ffmpeg that logs argv and runs. */
  const STUB = `
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(path.join(__dirname, 'argv.log'), JSON.stringify(process.argv.slice(2)) + '\\n');
const tick = () => process.stdout.write('bitrate=900.0kbits/s\\nspeed=1.00x\\ndrop_frames=0\\nprogress=continue\\n');
tick();
setInterval(tick, 30);
process.on('SIGTERM', () => process.exit(0));
`;

  it('starts when only a profile wants audio, and ends when none does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-tvaudio-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'stub-ffmpeg.cjs'), STUB);
    const h = await makeLive({ live: { monitorMs: 20 } });
    const events: KioskLive[] = [];
    const sessions = new LiveSessions({
      db: h.app.surau.db,
      now: h.clock.now,
      runtime: h.app.liveRuntime,
      onKiosk: (k) => events.push(k),
      dataDir: h.dataDir,
      monitorMs: 20,
      relayOptions: { ffmpegPath: process.execPath, argsPrefix: [join(dir, 'stub-ffmpeg.cjs')], pollMs: 10, backoffBaseMs: 5, backoffMaxMs: 20, killAfterMs: 500 },
    });
    const runs = (): number => (existsSync(join(dir, 'argv.log')) ? readFileSync(join(dir, 'argv.log'), 'utf8').split('\n').filter((l) => l !== '').length : 0);
    const req: LiveStartRequest = { kuliahId: h.kuliahId, source: 'android', outputs: { kiosk: true, youtube: false }, youtubeVia: 'device' };
    h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1' });
    await sessions.start(req, 'user:t', 'dev1', '127.0.0.1');
    // the surau does not want the sound and no TV does: no leg
    await new Promise((r) => setTimeout(r, 150));
    expect(runs()).toBe(0);
    expect(sessions.kioskPath()).toBe('surau');

    putFeature(h.app.surau.db, 'tvProfiles', { tvs: { dev9: { live: { audio: true } } } }, 'test', undefined, 'sdm');
    sessions.publishKiosk();
    await until(() => sessions.kioskPath() === 'surau-kiosk');
    expect(runs()).toBeGreaterThan(0);
    // the surau's own value is untouched: a TV with no profile is told audio:false and mutes its player
    expect(sessions.kioskLive().audio).toBe(false);
    expect(sessions.kioskLive('dev9').audio).toBe(true);
    expect(sessions.kioskLive('dev7').audio).toBe(false);

    putFeature(h.app.surau.db, 'tvProfiles', { tvs: { dev9: null } }, 'test', undefined, 'sdm');
    sessions.publishKiosk();
    expect(sessions.kioskPath()).toBe('surau');
    await sessions.shutdown();
  });
});
