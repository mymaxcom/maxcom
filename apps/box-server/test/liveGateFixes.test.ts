import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KioskLive, LiveStartRequest } from '@surau/core';
import { createLiveRuntime } from '../src/live/mediamtx.ts';
import { Relay } from '../src/live/relay.ts';
import { LiveSessions } from '../src/live/sessions.ts';
import type { YoutubeLeg } from '../src/live/sessions.ts';
import { putFeature } from '../src/settingsStore.ts';
import { loginAs } from './authHelpers.ts';
import { startBody, startLiveHarness } from './support/liveHarness.ts';
import type { HarnessOptions, LiveHarness } from './support/liveHarness.ts';

vi.setConfig({ testTimeout: 40_000 });

const LAN = '10.168.1.40';
const harnesses: LiveHarness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of harnesses.splice(0)) await h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function make(o: HarnessOptions = {}): Promise<LiveHarness> {
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

const post = (h: LiveHarness, url: string, headers: Record<string, string>, payload: unknown) =>
  h.app.inject({ method: 'POST', url, headers, payload: payload as object, remoteAddress: LAN });

/** A stand-in for ffmpeg: logs argv, then runs (progress lines) or dies, as mode.json says. */
const STUB = `
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
fs.appendFileSync(path.join(dir, 'argv.log'), JSON.stringify(process.argv.slice(2)) + '\\n');
let mode = { mode: 'run' };
try { mode = JSON.parse(fs.readFileSync(path.join(dir, 'mode.json'), 'utf8')); } catch {}
if (mode.mode === 'die') { process.stderr.write('input failed\\n'); process.exit(1); }
const tick = () => process.stdout.write('bitrate=900.0kbits/s\\nspeed=1.00x\\ndrop_frames=0\\nprogress=continue\\n');
tick();
setInterval(tick, 30);
process.on('SIGTERM', () => process.exit(0));
`;

describe('A1: MediaMTX respawn with an open session', () => {
  it('sets the publisher user and the SRT passphrase again', async () => {
    const h = await make({ live: { monitorMs: 20, reprovisionMs: 20 }, spawn: { backoffBaseMs: 20, backoffMaxMs: 40 } });
    const media = await loginAs(h.app, 'media');
    const r = await post(h, '/api/live/start', media.headers, startBody(h));
    expect(r.statusCode).toBe(200);
    const id = r.json().session.id as string;
    const passphrase = r.json().ingest.srt.passphrase as string;
    const users = (): Array<{ user: string }> => h.fake.global.authInternalUsers as Array<{ user: string }>;
    expect(users().some((u) => u.user === `pub-${id}`)).toBe(true);

    // MediaMTX keeps both in memory only: a new process knows neither
    h.fake.global.authInternalUsers = users().filter((u) => u.user === 'box');
    h.fake.paths.clear();
    const sup = h.app.liveRuntime!.supervisor!;
    const before = sup.status().restarts;
    process.kill(sup.status().pid!);

    await until(() => sup.status().restarts > before && sup.status().running);
    await until(() => users().some((u) => u.user === `pub-${id}`) && h.fake.paths.get('surau')?.srtPublishPassphrase === passphrase);
  });
});

describe('A2: the kiosk path follows the audio leg', () => {
  async function audioRig(relay: Record<string, unknown> = {}, mode: 'run' | 'die' = 'run') {
    const dir = mkdtempSync(join(tmpdir(), 'surau-gate-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'stub-ffmpeg.cjs'), STUB);
    writeFileSync(join(dir, 'mode.json'), JSON.stringify({ mode }));
    const h = await make({ live: { monitorMs: 20 } });
    putFeature(h.app.surau.db, 'liveOnKiosk', { audio: true }, 'test');
    const events: KioskLive[] = [];
    const sessions = new LiveSessions({
      db: h.app.surau.db,
      now: h.clock.now,
      runtime: h.app.liveRuntime,
      onKiosk: (k) => events.push(k),
      dataDir: h.dataDir,
      monitorMs: 20,
      relayOptions: { ffmpegPath: process.execPath, argsPrefix: [join(dir, 'stub-ffmpeg.cjs')], pollMs: 10, backoffBaseMs: 5, backoffMaxMs: 20, killAfterMs: 500, ...relay },
    });
    const req: LiveStartRequest = { kuliahId: h.kuliahId, source: 'android', outputs: { kiosk: true, youtube: false }, youtubeVia: 'device' };
    const runs = (): number => (existsSync(join(dir, 'argv.log')) ? readFileSync(join(dir, 'argv.log'), 'utf8').split('\n').filter((l) => l !== '').length : 0);
    return { h, dir, events, sessions, req, runs, setMode: (m: 'run' | 'die') => writeFileSync(join(dir, 'mode.json'), JSON.stringify({ mode: m })) };
  }

  it('is surau while the leg starts, surau-kiosk only while it runs, and the event announces each change', async () => {
    const a = await audioRig();
    a.h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1' });
    await a.sessions.start(a.req, 'user:t', 'dev1', '127.0.0.1');
    // the leg exists or is about to; ffmpeg has not printed progress yet
    expect(a.sessions.kioskPath()).toBe('surau');
    expect(a.sessions.kioskLive().path).toBe('surau');
    await until(() => a.sessions.kioskPath() === 'surau-kiosk');
    await until(() => a.events.some((e) => e.live && e.path === 'surau-kiosk'));
    expect(a.events.filter((e) => e.path === 'surau-kiosk').length).toBeGreaterThan(0);
    // the audio switched off: back to surau, announced
    const n = a.events.length;
    putFeature(a.h.app.surau.db, 'liveOnKiosk', { audio: false }, 'test');
    a.sessions.publishKiosk();
    expect(a.sessions.kioskPath()).toBe('surau');
    expect(a.events.length).toBeGreaterThan(n);
    expect(a.events[a.events.length - 1]!.path).toBe('surau');
    await a.sessions.shutdown();
  });

  it('a failed leg leaves the kiosk on surau, and is replaced only when the picture drops and returns', async () => {
    const a = await audioRig({ maxFailures: 2 }, 'die');
    a.h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1' });
    await a.sessions.start(a.req, 'user:t', 'dev1', '127.0.0.1');
    await until(() => a.runs() >= 2);
    expect(a.sessions.kioskPath()).toBe('surau');
    // the leg gave up while the picture stayed: no hot retry loop
    await new Promise((r) => setTimeout(r, 200));
    const settled = a.runs();
    await new Promise((r) => setTimeout(r, 200));
    expect(a.runs()).toBe(settled);
    // the phone reconnects: a fresh leg, now with a working ffmpeg
    a.setMode('run');
    a.h.fake.setReady(false);
    await new Promise((r) => setTimeout(r, 100));
    a.h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c2' });
    await until(() => a.sessions.kioskPath() === 'surau-kiosk');
    await a.sessions.shutdown();
  });
});

describe('A2/Q9b: ffmpeg exits while the ingest is gone are not failures', () => {
  it('does not give up while the picture is absent at each exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-q9b-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'stub-ffmpeg.cjs'), STUB);
    writeFileSync(join(dir, 'mode.json'), JSON.stringify({ mode: 'die' }));
    // odd pathGet calls are the wait for the picture, even ones the check right after an exit
    let calls = 0;
    const api = {
      pathGet: async () => ({ ready: ++calls % 2 === 1 }),
      authUserAdd: async () => undefined,
      authUserRemove: async () => undefined,
    };
    const relay = new Relay({
      ffmpegPath: process.execPath,
      argsPrefix: [join(dir, 'stub-ffmpeg.cjs')],
      api,
      dataDir: join(dir, 'data'),
      sessionId: 'q9b',
      kind: 'kioskAudio',
      pollMs: 5,
      backoffBaseMs: 5,
      backoffMaxMs: 10,
      maxFailures: 3,
    });
    relay.start({ key: '', relayVideo: 'copy', maxBitrateKbps: 0 });
    await until(() => relay.status().restarts >= 6);
    expect(relay.status().state).not.toBe('failed');
    await relay.stop();
  });
});

describe('A3: MediaMTX older than v1.21.0', () => {
  it('is not started and the health block says mediamtx_version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-ver-'));
    dirs.push(dir);
    const tools = join(dir, 'tools');
    for (const n of ['mediamtx', 'ffmpeg']) {
      mkdirSync(join(tools, n), { recursive: true });
      writeFileSync(join(tools, n, `${n}.exe`), 'stub');
    }
    const sha = 'a'.repeat(64);
    writeFileSync(join(tools, 'VERSIONS.md'), `| Name | Version | URL | sha256 | Licence | Date |\n|---|---|---|---|---|---|\n| mediamtx | v1.16.0 | https://x/y.zip | ${sha} | MIT | 2026-11-04 |\n`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const live = createLiveRuntime({ option: { dir: tools }, dataDir: join(dir, 'data'), lanIps: [] });
    live.start();
    expect(live.runtime.supervisor).toBeNull();
    expect(live.runtime.api).toBeNull();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('mediamtx_version');
    const h = await make();
    const sessions = new LiveSessions({ db: h.app.surau.db, now: h.clock.now, runtime: live.runtime, onKiosk: () => undefined });
    expect(sessions.healthBlock().mediamtx).toMatchObject({ running: false, reason: 'mediamtx_version', version: 'v1.16.0' });
    await expect(sessions.start({ kuliahId: null, source: 'android', outputs: { kiosk: true, youtube: false }, youtubeVia: 'device' }, 'user:t', 'dev1', '127.0.0.1')).rejects.toMatchObject({ code: 'mediamtx_down' });
    await live.stop();
  });

  it('a current MediaMTX is not blocked', async () => {
    const h = await make();
    expect(h.app.liveRuntime!.tools.mediamtxTooOld).toBeNull();
    expect(h.app.liveSessions.healthBlock().mediamtx.reason).toBeUndefined();
  });
});

describe('A6: start limiter', () => {
  it('6 starts per device per hour and 12 per box; a reconnect is not counted', async () => {
    const h = await make();
    const a = await loginAs(h.app, 'media');
    for (let i = 0; i < 6; i++) {
      const s = await post(h, '/api/live/start', a.headers, startBody(h));
      expect(s.statusCode, `start ${i}`).toBe(200);
      // same device again: the existing session, not counted
      const again = await post(h, '/api/live/start', a.headers, startBody(h));
      expect(again.statusCode).toBe(200);
      expect(again.json().session.id).toBe(s.json().session.id);
      await post(h, '/api/live/stop', a.headers, {});
    }
    const seventh = await post(h, '/api/live/start', a.headers, startBody(h));
    expect(seventh.statusCode).toBe(429);
    expect(seventh.json()).toMatchObject({ code: 'live_rate', errors: ['Terlalu banyak cubaan mula siaran. Cuba lagi sebentar lagi.'] });

    // another device still has its own six, up to the box total of twelve
    const b = await loginAs(h.app, 'media');
    for (let i = 0; i < 6; i++) {
      const s = await post(h, '/api/live/start', b.headers, startBody(h));
      expect(s.statusCode, `b start ${i}`).toBe(200);
      await post(h, '/api/live/stop', b.headers, {});
    }
    const c = await loginAs(h.app, 'media');
    const over = await post(h, '/api/live/start', c.headers, startBody(h));
    expect(over.statusCode).toBe(429);
    expect(over.json().code).toBe('live_rate');

    // an hour later the window has emptied
    h.clock.t += 3_600_001;
    expect((await post(h, '/api/live/start', c.headers, startBody(h))).statusCode).toBe(200);
  });
});

describe('A7: Q3, Q11 and the fallback title', () => {
  const leg = (over: Partial<YoutubeLeg> = {}): YoutubeLeg & { titles: string[] } => {
    const titles: string[] = [];
    const base: YoutubeLeg = {
      signedIn: () => true,
      createBroadcastFor: async (req) => {
        titles.push(req.meta.title);
        return { broadcastId: 'bc1', watchUrl: 'https://youtu.be/bc1', key: 'abcd-efgh-ijkl-mnop-qrst' };
      },
      complete: async () => undefined,
      status: () => ({ signedIn: true, channelTitle: null, broadcastId: null, state: 'none', health: null, watchUrl: null, lastError: null }),
    };
    return Object.assign({ ...base, ...over }, { titles });
  };

  it('Q3: a throw after the claim tears the session down so the next start works', async () => {
    let boom = true;
    const y = leg({
      signedIn: () => {
        if (boom) throw new Error('boom');
        return true;
      },
    });
    const h = await make({ live: { youtube: y, monitorMs: 20 } });
    putFeature(h.app.surau.db, 'liveYoutube', { enabled: true }, 'test');
    const media = await loginAs(h.app, 'media');
    const first = await post(h, '/api/live/start', media.headers, startBody(h, { outputs: { kiosk: true, youtube: true } }));
    expect(first.statusCode).toBe(500);
    expect(h.app.liveSessions.current()).toBeNull();
    await h.app.liveSessions.settled();
    expect((h.fake.global.authInternalUsers as Array<{ user: string }>).some((u) => u.user.startsWith('pub-'))).toBe(false);
    boom = false;
    const second = await post(h, '/api/live/start', media.headers, startBody(h, { outputs: { kiosk: true, youtube: true } }));
    expect(second.statusCode).toBe(200);
  });

  it('Missed-1: the fallback title is cleaned like the templated one', async () => {
    const y = leg();
    const h = await make({ live: { youtube: y, monitorMs: 20 } });
    putFeature(h.app.surau.db, 'liveYoutube', { enabled: true }, 'test');
    putFeature(h.app.surau.db, 'surauInfo', { name: 'Surau – Al <Hidayah> → Utama' }, 'test');
    const media = await loginAs(h.app, 'media');
    const r = await post(h, '/api/live/start', media.headers, startBody(h, { kuliahId: null, outputs: { kiosk: true, youtube: true } }));
    expect(r.statusCode).toBe(200);
    expect(y.titles).toHaveLength(1);
    expect(y.titles[0]).toBe('Kuliah Surau , Al Hidayah : Utama');
    expect(y.titles[0]).not.toMatch(/[<>–—→]/);
  });
});
