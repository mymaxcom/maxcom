// The YouTube grace window: a kuliah that is stopped and started again a moment later (an admin restarting a live
// that looked stuck) carries on with ONE broadcast, so one kuliah stays one recording. Fake Google, stub ffmpeg.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { putItem } from '../src/content/store.ts';
import { putFeature } from '../src/settingsStore.ts';
import { loginAs } from './authHelpers.ts';
import { startFakeGoogle } from './support/fakeGoogle.ts';
import type { FakeGoogle } from './support/fakeGoogle.ts';
import { startBody, startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';

vi.setConfig({ testTimeout: 40_000 });

const LAN = '10.168.1.40';
const STUB = `
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(path.join(__dirname, 'argv.log'), JSON.stringify(process.argv.slice(2)) + '\\n');
const tick = () => process.stdout.write('bitrate=2500.0kbits/s\\nspeed=1.00x\\ndrop_frames=0\\nprogress=continue\\n');
tick();
setInterval(tick, 30);
process.on('SIGTERM', () => process.exit(0));
`;

interface Rig {
  h: LiveHarness;
  g: FakeGoogle;
  dir: string;
  runs: () => string[][];
  post: (url: string, payload: unknown) => Promise<Awaited<ReturnType<LiveHarness['app']['inject']>>>;
  start: (over?: Record<string, unknown>) => Promise<Awaited<ReturnType<LiveHarness['app']['inject']>>>;
  stop: () => Promise<void>;
}

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0).reverse()) await c();
});

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function rig(graceMs: number, privacy: 'public' | 'unlisted' = 'public'): Promise<Rig> {
  const g = await startFakeGoogle();
  const dir = mkdtempSync(join(tmpdir(), 'livegrace-'));
  writeFileSync(join(dir, 'stub-ffmpeg.cjs'), STUB);
  const h = await startLiveHarness({
    app: { fetchImpl: g.fetchImpl },
    live: { youtubeGraceMs: graceMs, relay: { ffmpegPath: process.execPath, argsPrefix: [join(dir, 'stub-ffmpeg.cjs')], pollMs: 10, backoffBaseMs: 5, backoffMaxMs: 20, killAfterMs: 500 } },
  });
  closers.push(() => rmSync(dir, { recursive: true, force: true }), g.close, h.close);
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(() => undefined);
  writeFileSync(join(h.dataDir, 'secret', 'youtube-client.json'), JSON.stringify({ client_id: 'cid-123.apps.googleusercontent.com', client_secret: 'csecret-SECRET' }));
  const admin = await loginAs(h.app, 'admin');
  await h.app.inject({ method: 'POST', url: '/api/live/youtube/signin', headers: admin.headers, remoteAddress: LAN });
  g.approve = true;
  h.clock.t += 6000;
  const done = await h.app.inject({ method: 'POST', url: '/api/live/youtube/signin/poll', headers: admin.headers, remoteAddress: LAN });
  expect(done.json()).toMatchObject({ state: 'signed_in' });
  putFeature(h.app.surau.db, 'liveYoutube', { enabled: true, privacy }, 'test', undefined, 'sdm');
  const liveUser = await loginAs(h.app, 'live');
  h.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
  g.lifeCycle = 'live';
  const post = (url: string, payload: unknown) => h.app.inject({ method: 'POST', url, headers: liveUser.headers, payload: payload as object, remoteAddress: LAN });
  const runs = (): string[][] =>
    existsSync(join(dir, 'argv.log')) ? readFileSync(join(dir, 'argv.log'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as string[]) : [];
  const start = (over: Record<string, unknown> = {}) => post('/api/live/start', startBody(h, { source: 'web', outputs: { kiosk: true, youtube: true }, youtubeVia: 'box', ...over }));
  const stop = async (): Promise<void> => {
    expect((await post('/api/live/stop', {})).statusCode).toBe(200);
    await h.app.liveSessions!.settled();
  };
  return { h, g, dir, runs, post, start, stop };
}

const inserts = (r: Rig) => r.g.calls.filter((c) => c.method === 'POST' && c.path === '/youtube/v3/liveBroadcasts');
const streamInserts = (r: Rig) => r.g.calls.filter((c) => c.method === 'POST' && c.path === '/youtube/v3/liveStreams');
const completes = (r: Rig) => r.g.calls.filter((c) => c.path === '/youtube/v3/liveBroadcasts/transition' && c.query.get('broadcastStatus') === 'complete');
const deletedBroadcasts = (r: Rig) => r.g.calls.filter((c) => c.method === 'DELETE' && c.path === '/youtube/v3/liveBroadcasts');

function otherKuliah(r: Rig): string {
  const { db } = r.h.app.surau;
  const pen = putItem(db, 'penceramah', { name: 'Ustaz Kedua' }, 'test', undefined, 'sdm');
  return putItem(
    db,
    'kuliah',
    { date: '2026-11-05', slot: 'isyak', time: '20:30', label: 'Kuliah Isyak', penceramahId: pen.item.id, topic: 'Bab Puasa', status: 'aktif' },
    'test', undefined, 'sdm',
  ).item.id;
}

describe('YouTube grace window after a stop', () => {
  it('stop then start of the same kuliah inside the window: ONE broadcast, the same stream key, nothing completed', async () => {
    const r = await rig(60_000);
    expect((await r.start()).statusCode).toBe(200);
    await until(() => r.runs().length >= 1);
    await r.stop();
    // the broadcast is held open, not completed or deleted
    expect(completes(r)).toHaveLength(0);
    expect(deletedBroadcasts(r)).toHaveLength(0);
    r.h.clock.t += 30_000;
    expect((await r.start()).statusCode).toBe(200);
    await until(() => r.runs().length >= 2);
    expect(inserts(r)).toHaveLength(1);
    expect(streamInserts(r)).toHaveLength(1);
    expect(r.g.count('/youtube/v3/liveBroadcasts/transition')).toBe(0);
    const urls = new Set(r.runs().map((a) => a.at(-1)));
    expect(urls.size).toBe(1);
    // the second end (window runs out or shutdown) completes it once
    await r.stop();
    await r.h.app.liveSessions!.shutdown();
    expect(completes(r)).toHaveLength(1);
    expect(deletedBroadcasts(r)).toHaveLength(0);
  });

  it('when the window passes the broadcast is completed (never deleted)', async () => {
    // a short real window: the lingering timer is a real timer
    const r = await rig(150);
    await r.start();
    await until(() => r.runs().length >= 1);
    await r.stop();
    await until(() => completes(r).length === 1);
    expect(deletedBroadcasts(r)).toHaveLength(0);
    // a start after the window makes a new broadcast
    await r.start();
    await until(() => r.runs().length >= 2);
    expect(inserts(r)).toHaveLength(2);
    expect(new Set(r.runs().map((a) => a.at(-1))).size).toBe(2);
  });

  it('a start of a DIFFERENT kuliah inside the window completes the lingering broadcast and makes a new one', async () => {
    const r = await rig(60_000);
    const other = otherKuliah(r);
    await r.start();
    await until(() => r.runs().length >= 1);
    await r.stop();
    expect(completes(r)).toHaveLength(0);
    await r.start({ kuliahId: other });
    await until(() => r.runs().length >= 2);
    await until(() => completes(r).length === 1);
    expect(inserts(r)).toHaveLength(2);
    expect(new Set(r.runs().map((a) => a.at(-1))).size).toBe(2);
    expect(deletedBroadcasts(r)).toHaveLength(0);
  });

  it('an ad-hoc live (no kuliah) does not linger: the next ad-hoc live gets its own broadcast', async () => {
    const r = await rig(60_000);
    await r.start({ kuliahId: null });
    await until(() => r.runs().length >= 1);
    await r.stop();
    await until(() => completes(r).length === 1);
    await r.start({ kuliahId: null });
    await until(() => r.runs().length >= 2);
    expect(inserts(r)).toHaveLength(2);
    expect(new Set(r.runs().map((a) => a.at(-1))).size).toBe(2);
  });

  it('an emergency stop by an administrator completes the broadcast at once (no lingering)', async () => {
    const r = await rig(60_000);
    await r.start();
    await until(() => r.runs().length >= 1);
    const admin = await loginAs(r.h.app, 'admin');
    const res = await r.h.app.inject({ method: 'POST', url: '/api/live/stop', headers: admin.headers, payload: {}, remoteAddress: LAN });
    expect(res.statusCode).toBe(200);
    await r.h.app.liveSessions!.settled();
    await until(() => completes(r).length === 1);
    await r.start();
    await until(() => r.runs().length >= 2);
    expect(inserts(r)).toHaveLength(2);
  });

  it('box shutdown completes the lingering broadcast at once', async () => {
    const r = await rig(60_000);
    await r.start();
    await until(() => r.runs().length >= 1);
    await r.stop();
    expect(completes(r)).toHaveLength(0);
    await r.h.app.liveSessions!.shutdown();
    expect(completes(r)).toHaveLength(1);
    expect(deletedBroadcasts(r)).toHaveLength(0);
  });

  it('visibility changed in the settings during the window: a new broadcast, the old one completed', async () => {
    const r = await rig(60_000, 'public');
    await r.start();
    await until(() => r.runs().length >= 1);
    await r.stop();
    putFeature(r.h.app.surau.db, 'liveYoutube', { enabled: true, privacy: 'unlisted' }, 'test', undefined, 'sdm');
    await r.start();
    await until(() => r.runs().length >= 2);
    await until(() => completes(r).length === 1);
    expect(inserts(r)).toHaveLength(2);
    expect((inserts(r)[0]!.json as { status: { privacyStatus: string } }).status.privacyStatus).toBe('public');
    expect((inserts(r)[1]!.json as { status: { privacyStatus: string } }).status.privacyStatus).toBe('unlisted');
  });
});

// 2026.11.15, Lane A task A2: the orphan rule for every session, and the linger on system stops.
describe('A2: orphan rule (S1) and linger on system stops (Y4)', () => {
  const LAN_IP = '10.168.1.40';
  async function plain(): Promise<{ h: LiveHarness; owner: Awaited<ReturnType<typeof loginAs>>; other: Awaited<ReturnType<typeof loginAs>>; id: string }> {
    const h = await startLiveHarness({ live: { monitorMs: 3_600_000 } });
    closers.push(h.close);
    const owner = await loginAs(h.app, 'live');
    const other = await loginAs(h.app, 'live');
    const r = await h.app.inject({ method: 'POST', url: '/api/live/start', headers: owner.headers, payload: startBody(h), remoteAddress: LAN_IP });
    expect(r.statusCode).toBe(200);
    return { h, owner, other, id: r.json().session.id as string };
  }
  const poll = (h: LiveHarness, headers: Record<string, string>) => h.app.inject({ method: 'GET', url: '/api/live/status', headers, remoteAddress: LAN_IP });
  const reasonOf = (h: LiveHarness, id: string): unknown => {
    const rows = h.app.surau.db.prepare("SELECT after_json FROM change_log WHERE entity = 'live' AND entity_id = ? ORDER BY id").all(id) as Array<{ after_json: string }>;
    return (JSON.parse(rows.at(-1)!.after_json) as { reason?: unknown }).reason;
  };

  it('S1: no ingest and no owner poll for 90 s ends the session with controller_lost, not before', async () => {
    const { h, id } = await plain();
    const sessions = h.app.liveSessions!;
    h.clock.t += 89_000;
    await sessions.tick();
    expect(sessions.current()?.id).toBe(id);
    h.clock.t += 2_000;
    await sessions.tick();
    expect(sessions.current()).toBeNull();
    expect(reasonOf(h, id)).toBe('controller_lost');
  });

  it('S1: the owner polling keeps a session without ingest (success path); another device polling does not', async () => {
    const { h, owner, other, id } = await plain();
    const sessions = h.app.liveSessions!;
    for (let i = 0; i < 5; i++) {
      h.clock.t += 60_000;
      expect((await poll(h, owner.headers)).statusCode).toBe(200);
      await sessions.tick();
    }
    expect(sessions.current()?.id).toBe(id);
    for (let i = 0; i < 2; i++) {
      h.clock.t += 60_000;
      await poll(h, other.headers);
      await sessions.tick();
    }
    expect(sessions.current()).toBeNull();
    expect(reasonOf(h, id)).toBe('controller_lost');
  });

  it('S1: a phone that still sends its picture is never an orphan, however long its app does not poll', async () => {
    const { h, id } = await plain();
    const sessions = h.app.liveSessions!;
    h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1', bytesReceived: 10 });
    for (let i = 0; i < 4; i++) {
      h.clock.t += 10 * 60_000;
      await sessions.tick();
    }
    expect(sessions.current()?.id).toBe(id);
  });

  it('Y4: the box ends an orphan kuliah live; a restart of the same kuliah inside the window reuses the broadcast (success path)', async () => {
    const r = await rig(300_000);
    const first = await r.start();
    expect(first.statusCode).toBe(200);
    await until(() => r.runs().length >= 1);
    const sessions = r.h.app.liveSessions!;
    // another phone reads the status (its polls are not the owner's heartbeat)
    const watcher = await loginAs(r.h.app, 'live');
    const liveA = (await r.h.app.inject({ method: 'GET', url: '/api/live/status', headers: watcher.headers, remoteAddress: LAN })).json();
    expect(liveA.broadcastIds).toHaveLength(1);
    // the app dies: no picture, no poll
    r.h.fake.setReady(false);
    // a monitor round already in flight must see the picture gone before the clock moves
    await until(() => !sessions.status().ingest.ready);
    r.h.clock.t += 91_000;
    await until(() => sessions.current() === null);
    await sessions.settled();
    expect(completes(r)).toHaveLength(0);
    expect(sessions.lingeringBroadcast()).toBe(liveA.broadcastIds[0]);
    // the same kuliah again, two minutes later
    r.h.clock.t += 120_000;
    r.h.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w2' });
    const second = await r.start();
    expect(second.statusCode).toBe(200);
    await until(() => r.runs().length >= 2);
    expect(inserts(r)).toHaveLength(1);
    expect(new Set(r.runs().map((a) => a.at(-1))).size).toBe(1);
    const liveB = (await r.h.app.inject({ method: 'GET', url: '/api/live/status', headers: watcher.headers, remoteAddress: LAN })).json();
    expect(liveB.broadcastIds).toEqual(liveA.broadcastIds);
    expect(liveB.session.id).not.toBe(liveA.session.id);
  });

  it('Y6: a YouTube sign-out while the broadcast lingers is refused (409), and allowed once the window is over', async () => {
    const r = await rig(60_000);
    await r.start();
    await until(() => r.runs().length >= 1);
    await r.stop();
    const admin = await loginAs(r.h.app, 'admin');
    const refused = await r.h.app.inject({ method: 'POST', url: '/api/live/youtube/signout', headers: admin.headers, payload: {}, remoteAddress: LAN });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('live_busy');
    await r.h.app.liveSessions!.shutdown();
    expect(completes(r)).toHaveLength(1);
    const ok = await r.h.app.inject({ method: 'POST', url: '/api/live/youtube/signout', headers: admin.headers, payload: {}, remoteAddress: LAN });
    expect(ok.statusCode).toBe(200);
  });
});
