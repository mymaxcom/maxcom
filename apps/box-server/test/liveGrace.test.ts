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
