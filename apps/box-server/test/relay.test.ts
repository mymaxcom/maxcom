import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediamtxApi } from '../src/live/mediamtx.ts';
import { Relay, createRedactor } from '../src/live/relay.ts';
import type { RelayOptions } from '../src/live/relay.ts';
import type { YoutubeLeg } from '../src/live/sessions.ts';
import { putFeature } from '../src/settingsStore.ts';
import { loginAs } from './authHelpers.ts';
import { BOX_PASS, startBody, startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';
import { startFakeMediamtx } from './support/fakeMediamtx.ts';
import type { FakeMediamtx } from './support/fakeMediamtx.ts';

// real child processes: under a loaded full-suite run each spawn can take a few hundred ms
vi.setConfig({ testTimeout: 40_000 });

const KEY = 'abcd-efgh-ijkl-mnop-qrst';

/** A stand-in for ffmpeg: logs its argv, then behaves as the test's mode.json says. */
const STUB = `
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
fs.appendFileSync(path.join(dir, 'argv.log'), JSON.stringify(process.argv.slice(2)) + '\\n');
let mode = { mode: 'run' };
try { mode = JSON.parse(fs.readFileSync(path.join(dir, 'mode.json'), 'utf8')); } catch {}
const key = process.argv[process.argv.length - 1].split('/').pop();
const rtsp = process.argv[process.argv.indexOf('-i') + 1];
if (mode.mode === 'die') {
  process.stderr.write('Connection to tcp://a.rtmps.youtube.com failed for ' + key + ' via ' + rtsp + '\\n');
  process.stderr.write('Error opening output file: Connection refused\\n');
  process.exit(1);
}
if (mode.mode === 'flood' || mode.mode === 'floodthendie') {
  for (let i = 0; i < 20; i++) process.stderr.write('[mp4 @ 0x55' + (80 + i) + '] Non-monotonic DTS in output stream 0:1; previous: ' + (1000 + i) + ', current: ' + (900 + i) + '; changing to ' + (1001 + i) + '.\\n');
  for (let i = 0; i < 5; i++) process.stderr.write('[libopus @ 0x7f' + i + '] Queue input is backward in time' + '\\n');
  process.stderr.write('Audio device lost' + '\\n');
}
process.stderr.write('[flv] using key ' + key + ' ok' + '\\n');
if (mode.mode === 'floodthendie') process.exit(1);
const tick = () => process.stdout.write('bitrate=1234.5kbits/s\\nspeed=1.01x\\ndrop_frames=3\\nprogress=continue\\n');
tick();
setInterval(tick, 30);
process.on('SIGTERM', () => process.exit(0));
`;

interface Rig {
  dir: string;
  dataDir: string;
  fake: FakeMediamtx;
  api: MediamtxApi;
  opts: RelayOptions;
  setMode: (m: 'run' | 'die' | 'flood' | 'floodthendie') => void;
  runs: () => string[][];
  logText: () => string;
}

const rigs: Rig[] = [];
const harnesses: LiveHarness[] = [];
const relays: Relay[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of relays.splice(0)) await r.stop();
  for (const h of harnesses.splice(0)) await h.close();
  for (const r of rigs.splice(0)) {
    await r.fake.close();
    rmSync(r.dir, { recursive: true, force: true });
  }
});

async function rig(over: Partial<RelayOptions> = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'surau-relay-'));
  const dataDir = join(dir, 'data');
  mkdirSync(join(dataDir, 'live'), { recursive: true });
  const script = join(dir, 'stub-ffmpeg.cjs');
  writeFileSync(script, STUB);
  const fake = await startFakeMediamtx({ pass: BOX_PASS });
  const api = new MediamtxApi({ user: 'box', pass: BOX_PASS, port: fake.port });
  const opts: RelayOptions = {
    ffmpegPath: process.execPath,
    argsPrefix: [script],
    api,
    dataDir,
    sessionId: 'sess123abc',
    pollMs: 10,
    readyTimeoutMs: 2000,
    backoffBaseMs: 5,
    backoffMaxMs: 40,
    killAfterMs: 500,
    ...over,
  };
  const r: Rig = {
    dir,
    dataDir,
    fake,
    api,
    opts,
    setMode: (m) => writeFileSync(join(dir, 'mode.json'), JSON.stringify({ mode: m })),
    runs: () => (existsSync(join(dir, 'argv.log')) ? readFileSync(join(dir, 'argv.log'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as string[]) : []),
    logText: () => (existsSync(join(dataDir, 'live', 'relay.log')) ? readFileSync(join(dataDir, 'live', 'relay.log'), 'utf8') : ''),
  };
  rigs.push(r);
  return r;
}

const make = (r: Rig): Relay => {
  const relay = new Relay(r.opts);
  relays.push(relay);
  return relay;
};

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((res) => setTimeout(res, 10));
  }
}

describe('relay command line', () => {
  it('copy mode: video is copied, audio goes to AAC, output is RTMPS with the key', async () => {
    const r = await rig();
    r.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    const relay = make(r);
    relay.start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
    await until(() => r.runs().length >= 1);
    const argv = r.runs()[0]!;
    const joined = argv.join(' ');
    expect(argv.slice(0, 7)).toEqual(['-hide_banner', '-loglevel', 'warning', '-nostdin', '-progress', 'pipe:1', '-rtsp_transport']);
    expect(joined).toContain('-c:v copy');
    expect(joined).toContain('-c:a aac -b:a 128k -ar 48000 -ac 2 -f flv -rtmp_live live');
    expect(joined).not.toContain('libx264');
    expect(argv[argv.length - 1]).toBe(`rtmps://a.rtmps.youtube.com:443/live2/${KEY}`);
    expect(joined).toContain('-rtsp_transport tcp');
  });

  it('reencode mode: libx264 with a 2 second GOP and the bitrate cap', async () => {
    const r = await rig();
    r.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    const relay = make(r);
    relay.start({ key: KEY, relayVideo: 'reencode', maxBitrateKbps: 3000 });
    await until(() => r.runs().length >= 1);
    const joined = r.runs()[0]!.join(' ');
    expect(joined).toContain('-c:v libx264 -preset veryfast -tune zerolatency -g 60 -keyint_min 60 -b:v 3000k -maxrate 3000k -bufsize 6000k -pix_fmt yuv420p');
    expect(joined).not.toContain('-c:v copy');
  });

  it('reads the path as a per-session read-only user, never as the box', async () => {
    const r = await rig();
    r.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    const relay = make(r);
    relay.start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
    await until(() => r.runs().length >= 1);
    const argv = r.runs()[0]!;
    const url = argv[argv.indexOf('-i') + 1]!;
    const m = /^rtsp:\/\/(relay-sess123abc):([A-Za-z0-9]{32})@127\.0\.0\.1:8554\/surau$/.exec(url);
    expect(m, url).not.toBeNull();
    const user = (r.fake.global.authInternalUsers as Array<{ user: string; pass: string; permissions: unknown }>).find((u) => u.user === 'relay-sess123abc');
    expect(user?.pass).toBe(m![2]);
    expect(user?.permissions).toEqual([{ action: 'read', path: 'surau' }]);
    expect(argv.join(' ')).not.toContain(BOX_PASS);
  });
});

describe('relay redaction', () => {
  it('replaces the key and the password wherever they appear', () => {
    const red = createRedactor([KEY, 'p4ssw0rdp4ssw0rdp4ssw0rdp4ssw0rd']);
    const r = red(`rtsp://relay-x:p4ssw0rdp4ssw0rdp4ssw0rdp4ssw0rd@127.0.0.1/surau failed; rtmps://a/live2/${KEY} ${KEY}`);
    expect(r.text).toBe('rtsp://relay-x:***@127.0.0.1/surau failed; rtmps://a/live2/*** ***');
    expect(r.hit).toBe(true);
    expect(red('plain line')).toEqual({ text: 'plain line', hit: false });
  });

  it('ignores empty secrets', () => {
    expect(createRedactor(['', KEY])('abc').text).toBe('abc');
  });
});

describe('relay lifecycle', () => {
  it('waits for the path to be ready before spawning', async () => {
    const r = await rig();
    const relay = make(r);
    relay.start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
    await new Promise((res) => setTimeout(res, 150));
    expect(r.runs()).toHaveLength(0);
    expect(relay.status().state).toBe('starting');
    r.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    await until(() => r.runs().length === 1);
  });

  it('restarts a dying process with a growing delay and gives up as failed after 10 exits, without the key in lastError', async () => {
    const r = await rig();
    r.setMode('die');
    r.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    const relay = make(r);
    relay.start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
    await until(() => relay.status().state === 'failed', 15000);
    expect(r.runs()).toHaveLength(10);
    const st = relay.status();
    expect(st.restarts).toBe(9);
    expect(st.lastError).toBe('Error opening output file: Connection refused');
    expect(JSON.stringify(st)).not.toContain(KEY);
    const log = r.logText();
    expect(log).not.toContain(KEY);
    // the failing line that carried the key and the password is logged redacted
    expect(log).toContain('Connection to tcp://a.rtmps.youtube.com failed for ***');
    await new Promise((res) => setTimeout(res, 100));
    expect(r.runs()).toHaveLength(10);
  });

  it('delays grow between restarts', async () => {
    const r = await rig({ backoffBaseMs: 40, backoffMaxMs: 160 });
    r.setMode('die');
    r.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    const stamps: number[] = [];
    const relay = make(r);
    relay.start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
    let seen = 0;
    const end = Date.now() + 4000;
    while (stamps.length < 5 && Date.now() < end) {
      if (r.runs().length > seen) {
        seen = r.runs().length;
        stamps.push(Date.now());
      }
      await new Promise((res) => setTimeout(res, 2));
    }
    expect(stamps.length).toBeGreaterThanOrEqual(5);
    // delays 40, 80, 160, 160 sit between five runs; load only adds time, so the sum is a safe lower bound
    expect(stamps[4]! - stamps[0]!).toBeGreaterThanOrEqual(40 + 80 + 160 + 160 - 30);
    expect(stamps[2]! - stamps[0]!).toBeGreaterThanOrEqual(40 + 80 - 30);
    expect(['starting', 'retrying']).toContain(relay.status().state);
  });

  it('progress lines update the bitrate and speed, and mark the relay running', async () => {
    const r = await rig();
    r.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    const relay = make(r);
    relay.start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
    await until(() => relay.status().state === 'running');
    const st = relay.status();
    expect(st.bitrateKbps).toBeCloseTo(1234.5, 0);
    expect(st.speed).toBeCloseTo(1.01, 2);
    expect(st.dropFrames).toBe(3);
    expect(st.lastError).toBeNull();
  });

  it('stop() kills the process, deletes the read user, stays off, and the log holds no key or password', async () => {
    const r = await rig();
    r.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    const relay = make(r);
    relay.start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
    await until(() => relay.status().state === 'running');
    const argv = r.runs()[0]!;
    const pass = /:\/\/relay-sess123abc:([A-Za-z0-9]{32})@/.exec(argv[argv.indexOf('-i') + 1]!)![1]!;
    await relay.stop();
    expect(relay.status().state).toBe('off');
    expect((r.fake.global.authInternalUsers as Array<{ user: string }>).some((u) => u.user === 'relay-sess123abc')).toBe(false);
    const before = r.runs().length;
    await new Promise((res) => setTimeout(res, 150));
    expect(r.runs()).toHaveLength(before);
    const log = r.logText();
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain(KEY);
    expect(log).not.toContain(pass);
    expect(log).toContain('[flv] using key *** ok');
    // the raw bytes on disk
    expect(readFileSync(join(r.dataDir, 'live', 'relay.log')).includes(Buffer.from(KEY))).toBe(false);
    await relay.stop();
  });

  it('stop() during the wait for the path spawns nothing', async () => {
    const r = await rig();
    const relay = make(r);
    relay.start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
    await new Promise((res) => setTimeout(res, 50));
    await relay.stop();
    r.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    await new Promise((res) => setTimeout(res, 100));
    expect(r.runs()).toHaveLength(0);
  });

  it('refuses a malformed key without spawning', async () => {
    const r = await rig();
    r.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    const relay = make(r);
    relay.start({ key: 'bad key/../x', relayVideo: 'copy', maxBitrateKbps: 2500 });
    await until(() => relay.status().state === 'failed');
    expect(r.runs()).toHaveLength(0);
    expect(relay.status().lastError).toBe('bad_key');
  });

  it('a missing ffmpeg executable ends as failed with a redacted reason', async () => {
    const r = await rig({ ffmpegPath: join(tmpdir(), 'no-such-ffmpeg-binary.exe'), argsPrefix: [], maxFailures: 3 });
    r.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    const relay = make(r);
    relay.start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
    await until(() => relay.status().state === 'failed');
    expect(relay.status().lastError).toMatch(/ENOENT|spawn/);
    expect(JSON.stringify(relay.status())).not.toContain(KEY);
  });
});

describe('relay inside a live session', () => {
  const fakeYoutube = (): YoutubeLeg => ({
    signedIn: () => true,
    createBroadcastFor: async () => ({ broadcastId: 'bc1', watchUrl: 'https://youtu.be/bc1', key: KEY }),
    complete: async () => undefined,
    status: () => ({ signedIn: true, channelTitle: 'Surau', broadcastId: 'bc1', state: 'created', health: null, watchUrl: 'https://youtu.be/bc1', lastError: null }),
  });

  async function session(setup?: (h: LiveHarness) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'surau-relay-sess-'));
    const script = join(dir, 'stub-ffmpeg.cjs');
    writeFileSync(script, STUB);
    const h = await startLiveHarness({
      live: { youtube: fakeYoutube(), relay: { ffmpegPath: process.execPath, argsPrefix: [script], pollMs: 10, backoffBaseMs: 5, backoffMaxMs: 20, killAfterMs: 500 } },
    });
    harnesses.push(h);
    setup?.(h);
    const media = await loginAs(h.app, 'media');
    const call = (url: string, payload: unknown) => h.app.inject({ method: 'POST', url, headers: media.headers, payload: payload as object, remoteAddress: '10.168.1.40' });
    const runs = (): string[][] =>
      existsSync(join(dir, 'argv.log')) ? readFileSync(join(dir, 'argv.log'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as string[]) : [];
    const status = async () => (await h.app.inject({ method: 'GET', url: '/api/live/status', headers: media.headers, remoteAddress: '10.168.1.40' })).json();
    return { h, dir, call, runs, status, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('web + youtube via box starts the relay after the picture is ready, reports it in status, and stop removes the user and the process', async () => {
    const s = await session();
    try {
      const r = await s.call('/api/live/start', startBody(s.h, { source: 'web', outputs: { kiosk: true, youtube: true }, youtubeVia: 'box' }));
      expect(r.statusCode).toBe(200);
      const id = r.json().session.id as string;
      expect(r.json().youtube).toEqual({ via: 'box', ingest: null, key: null, state: 'starting' });
      // the broadcast is made after the answer; the relay then starts and waits for the picture
      for (let i = 0; i < 200 && (await s.status()).relay.state === 'off'; i++) await new Promise((res) => setTimeout(res, 10));
      expect((await s.status()).relay.state).toBe('starting');
      expect(s.runs()).toHaveLength(0);
      s.h.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
      await until(() => s.runs().length === 1);
      expect(s.runs()[0]!.join(' ')).toContain('-c:v copy');
      expect(s.runs()[0]!.at(-1)).toBe(`rtmps://a.rtmps.youtube.com:443/live2/${KEY}`);
      let st = await s.status();
      for (let i = 0; i < 200 && st.relay.state !== 'running'; i++) {
        await new Promise((res) => setTimeout(res, 10));
        st = await s.status();
      }
      expect(st.relay).toMatchObject({ state: 'running', restarts: 0 });
      expect(JSON.stringify(st)).not.toContain(KEY);
      const users = () => s.h.fake.global.authInternalUsers as Array<{ user: string }>;
      expect(users().some((u) => u.user === `relay-${id}`)).toBe(true);

      const stop = await s.call('/api/live/stop', {});
      expect(stop.statusCode).toBe(200);
      await s.h.app.liveSessions!.settled();
      expect(users().some((u) => u.user === `relay-${id}` || u.user === `pub-${id}`)).toBe(false);
      expect((await s.status()).relay.state).toBe('off');
      const n = s.runs().length;
      await new Promise((res) => setTimeout(res, 100));
      expect(s.runs()).toHaveLength(n);
      const log = join(s.h.dataDir, 'live', 'relay.log');
      expect(readFileSync(log, 'utf8')).not.toContain(KEY);
      const audit = JSON.stringify(s.h.app.surau.db.prepare('SELECT after_json FROM change_log').all());
      expect(audit).not.toContain(KEY);
    } finally {
      s.cleanup();
    }
  });

  it('relayVideo reencode and the bitrate cap come from the liveYoutube settings', async () => {
    const s = await session((h) => putFeature(h.app.surau.db, 'liveYoutube', { relayVideo: 'reencode', maxBitrateKbps: 1800 }, 'test'));
    try {
      s.h.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
      await s.call('/api/live/start', startBody(s.h, { source: 'web', outputs: { kiosk: true, youtube: true }, youtubeVia: 'box' }));
      await until(() => s.runs().length === 1);
      expect(s.runs()[0]!.join(' ')).toContain('-c:v libx264 -preset veryfast -tune zerolatency -g 60 -keyint_min 60 -b:v 1800k -maxrate 1800k -bufsize 3600k');
    } finally {
      s.cleanup();
    }
  });

  it('no relay for the device leg, for kiosk-only, or without a key', async () => {
    const s = await session();
    try {
      s.h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 's1' });
      const r = await s.call('/api/live/start', startBody(s.h, { outputs: { kiosk: true, youtube: true }, youtubeVia: 'device' }));
      expect(r.statusCode).toBe(200);
      await new Promise((res) => setTimeout(res, 150));
      expect(s.runs()).toHaveLength(0);
      expect((await s.status()).relay).toMatchObject({ state: 'off' });
      await s.call('/api/live/stop', {});
    } finally {
      s.cleanup();
    }
  });

  it('an idle timeout stops the relay too', async () => {
    const s = await session();
    try {
      s.h.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
      await s.call('/api/live/start', startBody(s.h, { source: 'web', outputs: { kiosk: true, youtube: true }, youtubeVia: 'box' }));
      await until(() => s.runs().length === 1);
      s.h.fake.setReady(false);
      s.h.clock.t += 11 * 60_000;
      // the background monitor may be mid-round: tick until the round that applies the timeout has run
      for (let i = 0; i < 100 && s.h.app.liveSessions.current() !== null; i++) {
        await s.h.app.liveSessions.tick();
        await new Promise((res) => setTimeout(res, 10));
      }
      expect(s.h.app.liveSessions.current()).toBeNull();
      expect((await s.status()).relay.state).toBe('off');
    } finally {
      s.cleanup();
    }
  });
});

describe('kiosk audio leg (Opus copy for the kiosk)', () => {
  const SDP = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
  const users = (r: Rig) => r.fake.global.authInternalUsers as Array<{ user: string; pass: string; permissions: unknown }>;

  it('copies the picture, turns the sound into Opus and republishes to surau-kiosk as a per-session user (no key, no RTMPS)', async () => {
    const r = await rig({ kind: 'kioskAudio' });
    r.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1' });
    const leg = make(r);
    leg.start({ key: '', relayVideo: 'copy', maxBitrateKbps: 0 });
    await until(() => r.runs().length >= 1);
    const argv = r.runs()[0]!;
    const joined = argv.join(' ');
    expect(joined).toContain('-c:v copy -af aresample=async=1:first_pts=0 -c:a libopus -b:a 96k -ar 48000 -ac 2 -f rtsp -rtsp_transport tcp');
    // the phone's AAC timestamps jump back: regenerate PTS on the input (before -i), resample the sound against them
    expect(argv[argv.indexOf('-fflags') + 1]).toBe('+genpts');
    expect(argv.indexOf('-fflags')).toBeGreaterThan(-1);
    expect(argv.indexOf('-fflags')).toBeLessThan(argv.indexOf('-i'));
    expect(argv.indexOf('-af')).toBeGreaterThan(argv.indexOf('-i'));
    expect(argv[argv.indexOf('-c:v') + 1]).toBe('copy');
    expect(joined).not.toMatch(/rtmps|flv|libx264|aac /);
    const input = argv[argv.indexOf('-i') + 1]!;
    const output = argv[argv.length - 1]!;
    const m = /^rtsp:\/\/(kioskaudio-sess123abc):([A-Za-z0-9]{32})@127\.0\.0\.1:8554\/surau$/.exec(input);
    expect(m, input).not.toBeNull();
    expect(output).toBe(`rtsp://kioskaudio-sess123abc:${m![2]}@127.0.0.1:8554/surau-kiosk`);
    const user = users(r).find((u) => u.user === 'kioskaudio-sess123abc');
    expect(user?.pass).toBe(m![2]);
    expect(user?.permissions).toEqual([
      { action: 'read', path: 'surau' },
      { action: 'publish', path: 'surau-kiosk' },
    ]);
    expect(joined).not.toContain(BOX_PASS);
  });

  it('keeps its own log, redacts the password, retries with backoff and removes its user on stop', async () => {
    const r = await rig({ kind: 'kioskAudio', maxFailures: 3 });
    r.setMode('die');
    r.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1' });
    const leg = make(r);
    leg.start({ key: '', relayVideo: 'copy', maxBitrateKbps: 0 });
    await until(() => leg.status().state === 'failed', 10_000);
    expect(r.runs()).toHaveLength(3);
    const argv = r.runs()[0]!;
    const pass = /:\/\/kioskaudio-sess123abc:([A-Za-z0-9]{32})@/.exec(argv[argv.indexOf('-i') + 1]!)![1]!;
    const audioLog = join(r.dataDir, 'live', 'kiosk-audio.log');
    expect(existsSync(audioLog)).toBe(true);
    expect(existsSync(join(r.dataDir, 'live', 'relay.log'))).toBe(false);
    const text = readFileSync(audioLog, 'utf8');
    expect(text).toContain('via rtsp://kioskaudio-sess123abc:***@127.0.0.1:8554/surau');
    expect(text).not.toContain(pass);
    expect(JSON.stringify(leg.status())).not.toContain(pass);
    await leg.stop();
    expect(users(r).some((u) => u.user === 'kioskaudio-sess123abc')).toBe(false);
  });

  it('throttles repeated timestamp warnings: one per kind per 10 s, other warnings still pass', async () => {
    const t = 1_000_000;
    const r = await rig({ kind: 'kioskAudio', now: () => t });
    r.setMode('flood');
    r.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1' });
    const leg = make(r);
    leg.start({ key: '', relayVideo: 'copy', maxBitrateKbps: 0 });
    const audioLog = join(r.dataDir, 'live', 'kiosk-audio.log');
    const text = () => (existsSync(audioLog) ? readFileSync(audioLog, 'utf8') : '');
    await until(() => text().includes('[flv] using key'));
    const log = text();
    // 20 DTS lines and 5 libopus lines came in: one of each kind is kept
    expect(log.match(/Non-monotonic DTS/g)).toHaveLength(1);
    expect(log.match(/Queue input is backward in time/g)).toHaveLength(1);
    expect(log).toContain('Audio device lost');
    await leg.stop();
  });

  it('after 10 s the kind is logged again with the number of lines left out', async () => {
    let t = 5_000_000;
    const r = await rig({ kind: 'kioskAudio', now: () => t, maxFailures: 50, backoffBaseMs: 300, backoffMaxMs: 300 });
    r.setMode('floodthendie'); // each run floods, then dies, so the leg runs again
    r.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1' });
    const leg = make(r);
    leg.start({ key: '', relayVideo: 'copy', maxBitrateKbps: 0 });
    const audioLog = join(r.dataDir, 'live', 'kiosk-audio.log');
    const dts = () => (existsSync(audioLog) ? readFileSync(audioLog, 'utf8') : '').split('\n').filter((l) => l.includes('Non-monotonic DTS'));
    await until(() => dts().length >= 1);
    await until(() => r.runs().length >= 2); // a second run came and its flood was throttled
    await new Promise((res) => setTimeout(res, 100));
    expect(dts()).toHaveLength(1);
    t += 10_001;
    await until(() => r.runs().length >= 3);
    await until(() => dts().length >= 2);
    const lines = dts();
    expect(lines[0]).not.toContain('left out');
    expect(lines[1]).toMatch(/\((\d+) similar lines left out\)/);
    expect(Number(/\((\d+) similar/.exec(lines[1]!)![1])).toBeGreaterThanOrEqual(19);
    await leg.stop();
  });

  it('the YouTube relay is not throttled: every stderr line is logged', async () => {
    const r = await rig();
    r.setMode('flood');
    r.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    const relay = make(r);
    relay.start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
    await until(() => r.logText().includes('[flv] using key'));
    expect(r.logText().match(/Non-monotonic DTS/g)).toHaveLength(20);
    await relay.stop();
  });

  async function audioSession(relay: Partial<RelayOptions> = {}, mode?: 'die') {
    const dir = mkdtempSync(join(tmpdir(), 'surau-audio-sess-'));
    const script = join(dir, 'stub-ffmpeg.cjs');
    writeFileSync(script, STUB);
    if (mode !== undefined) writeFileSync(join(dir, 'mode.json'), JSON.stringify({ mode }));
    const h = await startLiveHarness({
      live: { relay: { ffmpegPath: process.execPath, argsPrefix: [script], pollMs: 10, backoffBaseMs: 5, backoffMaxMs: 20, killAfterMs: 500, ...relay } },
    });
    harnesses.push(h);
    const media = await loginAs(h.app, 'media');
    const call = (url: string, payload: unknown) => h.app.inject({ method: 'POST', url, headers: media.headers, payload: payload as object, remoteAddress: '10.168.1.40' });
    const runs = (): string[][] =>
      existsSync(join(dir, 'argv.log')) ? readFileSync(join(dir, 'argv.log'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as string[]) : [];
    const whep = () => h.app.inject({ method: 'POST', url: '/api/kiosk/live/whep', headers: { 'content-type': 'application/sdp' }, payload: SDP, remoteAddress: '127.0.0.1' });
    const setAudio = (audio: boolean) => {
      putFeature(h.app.surau.db, 'liveOnKiosk', { audio }, 'test');
      h.app.liveSessions!.publishKiosk();
    };
    return { h, dir, call, runs, whep, setAudio, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('audio OFF: no ffmpeg, and the kiosk reads surau directly', async () => {
    const s = await audioSession();
    try {
      s.h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1' });
      const start = await s.call('/api/live/start', startBody(s.h));
      expect(start.statusCode).toBe(200);
      await new Promise((res) => setTimeout(res, 150));
      expect(s.runs()).toHaveLength(0);
      expect(s.h.app.liveSessions!.kioskPath()).toBe('surau');
      expect((await s.whep()).statusCode).toBe(201);
      expect(s.h.fake.requests.some((q) => q.url === '/surau/whep')).toBe(true);
      expect(s.h.fake.requests.some((q) => q.url === '/surau-kiosk/whep')).toBe(false);
      expect((s.h.fake.global.authInternalUsers as Array<{ user: string }>).some((u) => u.user.startsWith('kioskaudio-'))).toBe(false);
    } finally {
      s.cleanup();
    }
  });

  it('audio ON: the leg runs after the picture is ready and the kiosk reads surau-kiosk; OFF again ends ffmpeg and returns to surau', async () => {
    const s = await audioSession();
    try {
      s.setAudio(true);
      s.h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1' });
      const start = await s.call('/api/live/start', startBody(s.h));
      expect(start.statusCode).toBe(200);
      await until(() => s.runs().length === 1);
      expect(s.runs()[0]!.join(' ')).toContain('libopus');
      // the kiosk moves to surau-kiosk only once the leg is really running (ffmpeg printed progress)
      await until(() => s.h.app.liveSessions!.kioskPath() === 'surau-kiosk');
      const users = () => s.h.fake.global.authInternalUsers as Array<{ user: string }>;
      expect(users().some((u) => u.user.startsWith('kioskaudio-'))).toBe(true);
      const w = await s.whep();
      expect(w.statusCode).toBe(201);
      expect(w.headers.location).toBe('/api/kiosk/live/whep/fake-session-1');
      expect(s.h.fake.requests.some((q) => q.url === '/surau-kiosk/whep')).toBe(true);
      // the DELETE goes to the path that session was opened on, even after the setting flips
      s.setAudio(false);
      expect(s.h.app.liveSessions!.kioskPath()).toBe('surau');
      await s.h.app.liveSessions!.settled();
      expect(users().some((u) => u.user.startsWith('kioskaudio-'))).toBe(false);
      const del = await s.h.app.inject({ method: 'DELETE', url: '/api/kiosk/live/whep/fake-session-1', remoteAddress: '127.0.0.1' });
      expect(del.statusCode).toBe(204);
      expect(s.h.fake.requests.some((q) => q.method === 'DELETE' && q.url === '/surau-kiosk/whep/fake-session-1')).toBe(true);
      // the stub ffmpeg stays down now
      const n = s.runs().length;
      await new Promise((res) => setTimeout(res, 150));
      expect(s.runs()).toHaveLength(n);
      // back ON: a new leg
      s.setAudio(true);
      await until(() => s.runs().length === n + 1);
    } finally {
      s.cleanup();
    }
  });

  it('stopping the live ends the audio leg and removes its user', async () => {
    const s = await audioSession();
    try {
      s.setAudio(true);
      s.h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1' });
      await s.call('/api/live/start', startBody(s.h));
      await until(() => s.runs().length === 1);
      const stop = await s.call('/api/live/stop', {});
      expect(stop.statusCode).toBe(200);
      await s.h.app.liveSessions!.settled();
      const users = s.h.fake.global.authInternalUsers as Array<{ user: string }>;
      expect(users.some((u) => u.user.startsWith('kioskaudio-') || u.user.startsWith('pub-'))).toBe(false);
      expect(s.h.app.liveSessions!.kioskPath()).toBe('surau');
      const n = s.runs().length;
      await new Promise((res) => setTimeout(res, 150));
      expect(s.runs()).toHaveLength(n);
    } finally {
      s.cleanup();
    }
  });

  it('a leg that gave up as failed is not used: the kiosk falls back to surau (picture, no sound)', async () => {
    const s = await audioSession({ backoffBaseMs: 2, backoffMaxMs: 4, maxFailures: 2 }, 'die');
    try {
      s.setAudio(true);
      s.h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1' });
      await s.call('/api/live/start', startBody(s.h));
      await until(() => s.runs().length >= 2, 8000);
      await until(() => s.h.app.liveSessions!.kioskPath() === 'surau', 8000);
      expect((await s.whep()).statusCode).toBe(201);
      expect(s.h.fake.requests.some((q) => q.url === '/surau/whep')).toBe(true);
    } finally {
      s.cleanup();
    }
  });
});
