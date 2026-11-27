import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediamtxApi } from '../src/live/mediamtx.ts';
import { LagWindow, Relay, createRedactor } from '../src/live/relay.ts';
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
if (mode.mode === 'ioerror') {
  process.stderr.write('[tls @ 0x7f1] mbedtls_x509_crt_verify not correctly signed by the trusted CA\\n');
  process.stderr.write('[tls @ 0x7f1] The certificate is not correctly signed by the trusted CA.\\n');
  process.stderr.write('Error opening output files: I/O error\\n');
  process.exit(1);
}
if (mode.mode === 'ioerrorsecret') {
  process.stderr.write('[tls @ 0x7f1] The certificate is not correctly signed by the trusted CA.\\n');
  process.stderr.write('Failed to open ' + key + '\\n');
  process.stderr.write('Error opening output files: I/O error\\n');
  process.exit(1);
}
if (mode.mode === 'flood' || mode.mode === 'floodthendie') {
  for (let i = 0; i < 20; i++) process.stderr.write('[mp4 @ 0x55' + (80 + i) + '] Non-monotonic DTS in output stream 0:1; previous: ' + (1000 + i) + ', current: ' + (900 + i) + '; changing to ' + (1001 + i) + '.\\n');
  for (let i = 0; i < 5; i++) process.stderr.write('[libopus @ 0x7f' + i + '] Queue input is backward in time' + '\\n');
  process.stderr.write('Audio device lost' + '\\n');
}
process.stderr.write('[flv] using key ' + key + ' ok' + '\\n');
if (mode.mode === 'floodthendie') process.exit(1);
// 'stall': the output stops taking bytes (total_size stands still); 'flow': it keeps growing
let sent = 1000;
let outUs = 0;
// O9: 'stallna' = total_size is N/A and nothing else moves; 'flowna' = total_size is N/A but the output time advances
const size = () =>
  mode.mode === 'stall' ? 'total_size=1000\\n'
  : mode.mode === 'flow' ? 'total_size=' + (sent += 500) + '\\n'
  : mode.mode === 'stallna' ? 'total_size=N/A\\nout_time_us=N/A\\nframe=0\\n'
  : mode.mode === 'flowna' ? 'total_size=N/A\\nout_time_us=' + (outUs += 40000) + '\\n'
  : mode.mode === 'lag' ? 'total_size=N/A\\nout_time_us=' + (outUs += 10000) + '\\n'
  : '';
const tick = () => process.stdout.write('bitrate=1234.5kbits/s\\n' + size() + 'speed=1.01x\\ndrop_frames=3\\nprogress=continue\\n');
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
  setMode: (m: 'run' | 'die' | 'flood' | 'floodthendie' | 'ioerror' | 'ioerrorsecret' | 'stall' | 'flow' | 'stallna' | 'flowna' | 'lag') => void;
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

async function until(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((res) => setTimeout(res, 10));
  }
}

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const platform = (p: string): void => {
  Object.defineProperty(process, 'platform', { ...realPlatform, value: p });
};

describe('relay command line', () => {
  it('rtmps: passes -ca_file (the option, else SSL_CERT_FILE) right before the URL; null passes none', async () => {
    const ca = join(tmpdir(), `surau-ca-${process.pid}.pem`);
    writeFileSync(ca, '-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n');
    try {
      const a = await rig({ caFile: '/data/runtime/etc/cert.pem' });
      a.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
      make(a).start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
      await until(() => a.runs().length >= 1);
      const argv = a.runs()[0]!;
      expect(argv.slice(-3)).toEqual(['-ca_file', '/data/runtime/etc/cert.pem', `rtmps://a.rtmps.youtube.com:443/live2/${KEY}`]);

      platform('linux');
      vi.stubEnv('SSL_CERT_FILE', ca);
      const b = await rig();
      b.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
      make(b).start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
      await until(() => b.runs().length >= 1);
      expect(b.runs()[0]!.slice(-3, -1)).toEqual(['-ca_file', ca]);

      const c = await rig({ caFile: null });
      c.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
      make(c).start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
      await until(() => c.runs().length >= 1);
      expect(c.runs()[0]).not.toContain('-ca_file');

      vi.stubEnv('SSL_CERT_FILE', join(tmpdir(), 'surau-no-such-ca.pem'));
      const d = await rig();
      d.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
      make(d).start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
      await until(() => d.runs().length >= 1);
      expect(d.runs()[0]).not.toContain('-ca_file');

      // a directory is not a bundle
      vi.stubEnv('SSL_CERT_FILE', tmpdir());
      const e = await rig();
      e.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
      make(e).start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
      await until(() => e.runs().length >= 1);
      expect(e.runs()[0]).not.toContain('-ca_file');

      // Windows: the file is ignored, the OS store stays in use
      platform('win32');
      vi.stubEnv('SSL_CERT_FILE', ca);
      const f = await rig();
      f.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
      make(f).start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
      await until(() => f.runs().length >= 1);
      expect(f.runs()[0]).not.toContain('-ca_file');
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
      vi.unstubAllEnvs();
      rmSync(ca, { force: true });
    }
  });

  it('a plain rtmp ingest gets no -ca_file', async () => {
    const r = await rig({ caFile: '/x/cert.pem', ingestUrl: 'rtmp://a.rtmp.youtube.com/live2' });
    r.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    make(r).start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
    await until(() => r.runs().length >= 1);
    expect(r.runs()[0]).not.toContain('-ca_file');
  });

  it('the generic I/O error pairs with the previous non-redacted line when the line between carried the key', async () => {
    const r = await rig({ caFile: null, maxFailures: 2 });
    r.setMode('ioerrorsecret');
    r.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    const relay = make(r);
    relay.start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
    await until(() => relay.status().state === 'failed');
    const st = relay.status();
    expect(st.lastError).toBe('[tls @ 0x7f1] The certificate is not correctly signed by the trusted CA. | Error opening output files: I/O error');
    expect(JSON.stringify(st)).not.toContain(KEY);
  });

  it('every redacted stderr line also reaches the log hook (the live log), the key never does', async () => {
    const r = await rig({ caFile: null, maxFailures: 2 });
    r.setMode('ioerrorsecret');
    r.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    const seen: string[] = [];
    const relay = new Relay({ ...r.opts, log: (t) => seen.push(t) });
    relays.push(relay);
    relay.start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
    await until(() => relay.status().state === 'failed');
    expect(seen).toContain('[tls @ 0x7f1] The certificate is not correctly signed by the trusted CA.');
    expect(seen).toContain('Error opening output files: I/O error');
    expect(JSON.stringify(seen)).not.toContain(KEY);
  });

  it('the generic I/O error keeps the line before it, and the status carries the stderr tail', async () => {
    const r = await rig({ caFile: null, maxFailures: 2 });
    r.setMode('ioerror');
    r.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    const relay = make(r);
    relay.start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
    await until(() => relay.status().state === 'failed');
    const st = relay.status();
    expect(st.lastError).toBe('[tls @ 0x7f1] The certificate is not correctly signed by the trusted CA. | Error opening output files: I/O error');
    expect(st.stderrTail).toHaveLength(3);
    expect(st.stderrTail[2]).toBe('Error opening output files: I/O error');
    expect(JSON.stringify(st)).not.toContain(KEY);
    expect(r.logText()).toContain('ffmpeg: [tls @ 0x7f1] mbedtls_x509_crt_verify');
  });

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
    expect(joined).toContain('-c:v libx264 -preset veryfast -tune zerolatency -force_key_frames expr:gte(t,n_forced*2) -sc_threshold 0 -x264-params nal-hrd=cbr -b:v 3000k -minrate 3000k -maxrate 3000k -bufsize 6000k -pix_fmt yuv420p');
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

// 2026.11.15, Lane A task A5: ffmpeg never waits for ever on a dead socket, and a stalled run is ended (Y3).
describe('A5: relay timeouts and the stall watchdog (Y3)', () => {
  const argsOf = (kind: 'youtube' | 'kioskAudio'): string[] => {
    const dataDir = mkdtempSync(join(tmpdir(), 'relay-args-'));
    try {
      const relay = new Relay({ ffmpegPath: 'ffmpeg', api: {} as RelayOptions['api'], dataDir, sessionId: 'abc123', kind }) as unknown as { args(s: { key: string; relayVideo: 'copy'; maxBitrateKbps: number }): string[] };
      return relay.args({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  };

  it('Y3: the ffmpeg arguments carry a read timeout on the RTSP input and a write timeout on the RTMPS output', () => {
    const yt = argsOf('youtube');
    const i = yt.indexOf('-i');
    // input options stand before -i, the output option before the address
    expect(yt.indexOf('-timeout')).toBeGreaterThan(0);
    expect(yt.indexOf('-timeout')).toBeLessThan(i);
    expect(yt[yt.indexOf('-timeout') + 1]).toBe('15000000');
    expect(yt.indexOf('-rw_timeout')).toBeGreaterThan(i);
    expect(yt[yt.indexOf('-rw_timeout') + 1]).toBe('15000000');
    expect(yt.at(-1)!.startsWith('rtmps://')).toBe(true);
    // the TV sound leg reads and writes loopback RTSP: the same read timeout on its input
    const leg = argsOf('kioskAudio');
    expect(leg.indexOf('-timeout')).toBeGreaterThan(0);
    expect(leg.indexOf('-timeout')).toBeLessThan(leg.indexOf('-i'));
    expect(leg).not.toContain('-rw_timeout');
  });

  it('Y3: a run whose output stops growing is ended as stalled and started again; a flowing run is left alone (success path)', async () => {
    const r = await rig({ stallMs: 200 });
    r.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    r.setMode('flow');
    const relay = make(r);
    relay.start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
    await until(() => relay.status().state === 'running');
    await new Promise((res) => setTimeout(res, 600));
    expect(r.runs()).toHaveLength(1);
    expect(relay.status().state).toBe('running');
    await relay.stop();

    const r2 = await rig({ stallMs: 200 });
    r2.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    r2.setMode('stall');
    const stalled = make(r2);
    stalled.start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
    await until(() => r2.runs().length >= 2, 15000);
    expect(r2.logText()).toContain('stalled');
    // the picture is back to flowing: the next run stays
    r2.setMode('flow');
    await until(() => stalled.status().state === 'running' && stalled.status().lastError === null, 15000);
  });
});

describe('relay sound option (copy of an AAC input)', () => {
  const argsWith = (start: { relayVideo: 'copy' | 'reencode'; audio?: 'aac' | 'copy' }, path?: string): string[] => {
    const dataDir = mkdtempSync(join(tmpdir(), 'relay-audio-'));
    try {
      const relay = new Relay({ ffmpegPath: 'ffmpeg', api: {} as RelayOptions['api'], dataDir, sessionId: 'abc123', path }) as unknown as { args(s: object): string[] };
      return relay.args({ key: KEY, maxBitrateKbps: 2500, ...start });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  };
  const AAC = ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'];

  it('without the option the sound is encoded to AAC 128k 48 kHz stereo, as before', () => {
    const plain = argsWith({ relayVideo: 'copy' });
    const i = plain.indexOf('-c:a');
    expect(plain.slice(i, i + 8)).toEqual(AAC);
    expect(argsWith({ relayVideo: 'copy', audio: 'aac' })).toEqual(plain);
  });

  it('audio copy passes the sound through and leaves the picture branch alone', () => {
    const a = argsWith({ relayVideo: 'copy', audio: 'copy' });
    const i = a.indexOf('-c:a');
    expect(a.slice(i, i + 2)).toEqual(['-c:a', 'copy']);
    expect(a).not.toContain('aac');
    expect(a).not.toContain('-b:a');
    expect(a).not.toContain('-ar');
    expect(a[a.indexOf('-c:v') + 1]).toBe('copy');
    const re = argsWith({ relayVideo: 'reencode', audio: 'copy' });
    expect(re[re.indexOf('-c:v') + 1]).toBe('libx264');
    expect(re[re.indexOf('-c:a') + 1]).toBe('copy');
    // everything but the sound arguments equals the default arguments
    const plain = argsWith({ relayVideo: 'copy' });
    const j = plain.indexOf('-c:a');
    expect([...plain.slice(0, j), ...plain.slice(j + 8)]).toEqual([...a.slice(0, i), ...a.slice(i + 2)]);
  });

  it('the input path is configurable (surau-yt for a combined live)', () => {
    const a = argsWith({ relayVideo: 'copy', audio: 'copy' }, 'surau-yt');
    expect(a[a.indexOf('-i') + 1]).toMatch(/\/surau-yt$/);
  });
});

describe('O9: the stall watchdog with total_size=N/A', () => {
  it('a run that reports total_size=N/A and nothing advancing is ended as stalled', async () => {
    const r = await rig({ stallMs: 200 });
    r.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    r.setMode('stallna');
    const relay = make(r);
    relay.start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
    await until(() => r.runs().length >= 2, 15000);
    expect(r.logText()).toContain('stalled');
  });

  it('a run with total_size=N/A whose output time keeps advancing is left alone (success path)', async () => {
    const r = await rig({ stallMs: 200 });
    r.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    r.setMode('flowna');
    const relay = make(r);
    relay.start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
    await until(() => relay.status().state === 'running');
    await new Promise((res) => setTimeout(res, 700));
    expect(r.runs()).toHaveLength(1);
    expect(r.logText()).not.toContain('stalled');
    expect(relay.status().state).toBe('running');
  });
});

describe('relay inside a live session', () => {
  const fakeYoutube = (): YoutubeLeg => ({
    signedIn: () => true,
    createBroadcastFor: async () => ({ broadcastId: 'bc1', watchUrl: 'https://youtu.be/bc1', key: KEY }),
    complete: async () => undefined,
    status: () => ({ signedIn: true, channelTitle: 'Surau', broadcastId: 'bc1', state: 'created', health: null, watchUrl: 'https://youtu.be/bc1', lastError: null }),
  });

  async function session(setup?: (h: LiveHarness) => void, encoderProbe: (p: string) => Promise<boolean | null> = async () => true) {
    const dir = mkdtempSync(join(tmpdir(), 'surau-relay-sess-'));
    const script = join(dir, 'stub-ffmpeg.cjs');
    writeFileSync(script, STUB);
    const h = await startLiveHarness({
      live: { youtube: fakeYoutube(), encoderProbe, relay: { ffmpegPath: process.execPath, argsPrefix: [script], pollMs: 10, backoffBaseMs: 5, backoffMaxMs: 20, killAfterMs: 500 } },
    });
    harnesses.push(h);
    setup?.(h);
    const liveUser = await loginAs(h.app, 'live');
    const call = (url: string, payload: unknown) => h.app.inject({ method: 'POST', url, headers: liveUser.headers, payload: payload as object, remoteAddress: '10.168.1.40' });
    const runs = (): string[][] =>
      existsSync(join(dir, 'argv.log')) ? readFileSync(join(dir, 'argv.log'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as string[]) : [];
    const status = async () => (await h.app.inject({ method: 'GET', url: '/api/live/status', headers: liveUser.headers, remoteAddress: '10.168.1.40' })).json();
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

  it('relayVideo reencode comes from the settings and the bitrate cap is fixed at 3500', async () => {
    const s = await session((h) => putFeature(h.app.surau.db, 'liveYoutube', { relayVideo: 'reencode', maxBitrateKbps: 1800 }, 'test', undefined, 'sdm'));
    try {
      s.h.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
      await s.call('/api/live/start', startBody(s.h, { source: 'web', outputs: { kiosk: true, youtube: true }, youtubeVia: 'box' }));
      await until(() => s.runs().length === 1);
      expect(s.runs()[0]!.join(' ')).toContain('-c:v libx264 -preset veryfast -tune zerolatency -force_key_frames expr:gte(t,n_forced*2) -sc_threshold 0 -x264-params nal-hrd=cbr -b:v 3500k -minrate 3500k -maxrate 3500k -bufsize 7000k');
    } finally {
      s.cleanup();
    }
  });

  it('reencode asked on a box without an H.264 encoder relays copy, warns reencode_unsupported and never fails the live', async () => {
    let probes = 0;
    const s = await session(
      (h) => putFeature(h.app.surau.db, 'liveYoutube', { relayVideo: 'reencode', maxBitrateKbps: 1800 }, 'test', undefined, 'sdm'),
      async () => {
        probes++;
        return false;
      },
    );
    try {
      s.h.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
      const r = await s.call('/api/live/start', startBody(s.h, { source: 'web', outputs: { kiosk: true, youtube: true }, youtubeVia: 'box' }));
      expect(r.statusCode).toBe(200);
      await until(() => s.runs().length === 1);
      const argv = s.runs()[0]!.join(' ');
      expect(argv).toContain('-c:v copy');
      expect(argv).not.toContain('libx264');
      const st = await s.status();
      expect(st.warnings).toContain('reencode_unsupported');
      expect(st.relayReencode).toBe(false);
      expect(probes).toBe(1);
    } finally {
      s.cleanup();
    }
  });

  it('the status never waits for the encoder probe: false while it runs, the answer once it is known', async () => {
    let answer: (v: boolean) => void = () => undefined;
    let probes = 0;
    const s = await session(undefined, () => {
      probes++;
      return new Promise<boolean>((res) => {
        answer = res;
      });
    });
    try {
      const t0 = Date.now();
      expect((await s.status()).relayReencode).toBe(false);
      expect(Date.now() - t0).toBeLessThan(2000);
      // the probe was started at boot, once
      expect(probes).toBe(1);
      answer(true);
      await until(async () => (await s.status()).relayReencode === true);
      expect(probes).toBe(1);
    } finally {
      s.cleanup();
    }
  });

  it('status reports relayReencode true on a capable box and false when the probe throws', async () => {
    const a = await session();
    try {
      await until(async () => (await a.status()).relayReencode === true);
      expect((await a.status()).relayReencode).toBe(true);
    } finally {
      a.cleanup();
    }
    const b = await session(undefined, async () => {
      throw new Error('boom');
    });
    try {
      expect((await b.status()).relayReencode).toBe(false);
    } finally {
      b.cleanup();
    }
  });

  // the HTTP status route is rate limited: these waits read the sessions directly
  const relayState = (h: LiveHarness): string => h.app.liveSessions.status().relay.state;

  it('Y2: a relay that gave up is started again when the picture returns (success path)', async () => {
    const s = await session();
    try {
      s.h.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
      writeFileSync(join(s.dir, 'mode.json'), JSON.stringify({ mode: 'die' }));
      await s.call('/api/live/start', startBody(s.h, { source: 'web', outputs: { kiosk: true, youtube: true }, youtubeVia: 'box' }));
      await until(() => relayState(s.h) === 'failed', 20000);
      const failedRuns = s.runs().length;
      // the internet is back, but nothing tells the relay: it stays failed while the picture never left
      writeFileSync(join(s.dir, 'mode.json'), JSON.stringify({ mode: 'run' }));
      await s.h.app.liveSessions.tick();
      expect(relayState(s.h)).toBe('failed');
      // the picture drops and returns: a fresh relay
      s.h.fake.setReady(false);
      await until(() => !s.h.app.liveSessions.status().ingest.ready);
      s.h.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w2' });
      await until(() => relayState(s.h) === 'running', 20000);
      expect(s.runs().length).toBeGreaterThan(failedRuns);
      const users = s.h.fake.global.authInternalUsers as Array<{ user: string }>;
      expect(users.filter((u) => u.user.startsWith('relay-'))).toHaveLength(1);
    } finally {
      s.cleanup();
    }
  });

  it('Y2: with the picture steady the whole time, a relay that gave up is tried again a minute later (the internet came back)', async () => {
    const s = await session();
    try {
      s.h.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
      writeFileSync(join(s.dir, 'mode.json'), JSON.stringify({ mode: 'die' }));
      await s.call('/api/live/start', startBody(s.h, { source: 'web', outputs: { kiosk: true, youtube: true }, youtubeVia: 'box' }));
      await until(() => relayState(s.h) === 'failed', 20000);
      // several monitor rounds (20 ms each) see the failure before the clock moves: the minute counts from here
      await new Promise((res) => setTimeout(res, 200));
      writeFileSync(join(s.dir, 'mode.json'), JSON.stringify({ mode: 'run' }));
      s.h.clock.t += 30_000;
      await new Promise((res) => setTimeout(res, 200));
      expect(relayState(s.h)).toBe('failed');
      s.h.clock.t += 31_000;
      await until(() => relayState(s.h) === 'running', 20000);
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

  it('B8: the live log callback of the YouTube relay gets a repeated line once (the relay file keeps every line)', async () => {
    const r = await rig();
    r.setMode('flood');
    r.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    const seen: string[] = [];
    const relay = new Relay({ ...r.opts, log: (x) => seen.push(x) });
    relay.start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
    await until(() => r.logText().includes('[flv] using key'));
    expect(r.logText().match(/Non-monotonic DTS/g)).toHaveLength(20);
    expect(seen.filter((x) => x.includes('Non-monotonic DTS'))).toHaveLength(1);
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
    const liveUser = await loginAs(h.app, 'live');
    const call = (url: string, payload: unknown) => h.app.inject({ method: 'POST', url, headers: liveUser.headers, payload: payload as object, remoteAddress: '10.168.1.40' });
    const runs = (): string[][] =>
      existsSync(join(dir, 'argv.log')) ? readFileSync(join(dir, 'argv.log'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as string[]) : [];
    const whep = () => h.app.inject({ method: 'POST', url: '/api/kiosk/live/whep', headers: { 'content-type': 'application/sdp' }, payload: SDP, remoteAddress: '127.0.0.1' });
    const setAudio = (audio: boolean) => {
      putFeature(h.app.surau.db, 'liveOnKiosk', { audio }, 'test', undefined, 'sdm');
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

describe('B12: the lag is measured against the smallest lag of the last 10 minutes (no drift)', () => {
  /** One sample per second of a run whose lag (s) at second `sec` is `lagAt(sec)`; returns the reading at each second. */
  const simulate = (seconds: number, lagAt: (sec: number) => number): number[] => {
    const w = new LagWindow();
    const out: number[] = [];
    for (let sec = 0; sec <= seconds; sec++) {
      const t = 1_000_000 + sec * 1000;
      w.add(t, lagAt(sec));
      out.push(w.behind(t, lagAt(sec)));
    }
    return out;
  };

  it('a constant offset that appears early and stays reads 0 once the window has moved past its start', () => {
    const got = simulate(1200, (sec) => (sec < 10 ? 0 : 5));
    expect(got[20]).toBeCloseTo(5, 5);
    expect(got[700]).toBe(0);
    expect(got[1200]).toBe(0);
  });

  it('a steady drift of 1 ms per second never reaches 4 over two hours', () => {
    const got = simulate(7200, (sec) => sec * 0.001);
    expect(Math.max(...got)).toBeLessThan(4);
    expect(Math.max(...got)).toBeLessThan(0.7);
  });

  it('a real backlog of 8 s that appears at minute 20 reads about 8', () => {
    const got = simulate(1260, (sec) => 0.3 + (sec >= 1200 ? 8 : 0));
    expect(got[1199]).toBeCloseTo(0, 5);
    expect(got[1230]).toBeCloseTo(8, 5);
  });

  it('keeps at most one sample per second and drops samples older than the window', () => {
    const w = new LagWindow();
    for (let ms = 0; ms < 5000; ms += 100) w.add(ms, 1);
    expect(w.size()).toBe(5);
    for (let s = 5; s < 2000; s++) w.add(s * 1000, 1);
    expect(w.size()).toBeLessThanOrEqual(601);
    w.reset();
    expect(w.size()).toBe(0);
  });
});

describe('B6: relay lag, low quality and the quality change', () => {
  type Args = (s: object) => string[];
  const argsFor = (start: object): string[] => {
    const dataDir = mkdtempSync(join(tmpdir(), 'relay-b6-'));
    try {
      const relay = new Relay({ ffmpegPath: 'ffmpeg', api: {} as RelayOptions['api'], dataDir, sessionId: 'abc123', caFile: null }) as unknown as { args: Args; quality: string };
      relay.quality = (start as { quality?: string }).quality === 'low' ? 'low' : 'full';
      return relay.args({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500, ...start });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  };
  const HEAD = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-progress', 'pipe:1', '-rtsp_transport', 'tcp', '-timeout', '15000000', '-i'];
  const TAIL = ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-f', 'flv', '-rtmp_live', 'live', '-rw_timeout', '15000000', `rtmps://a.rtmps.youtube.com:443/live2/${KEY}`];
  const lowVideo = (enc: string, pix: string, extra: string[] = []): string[] => ['-vf', 'scale=-2:480', '-c:v', enc, '-b:v', '1000k', '-maxrate', '1000k', '-bufsize', '2000k', '-g', '50', '-pix_fmt', pix, ...extra];

  it('without a quality option the arguments are exactly those of build 5 (copy and reencode)', () => {
    const copy = argsFor({});
    expect(copy.slice(0, HEAD.length)).toEqual(HEAD);
    expect(copy.slice(HEAD.length + 1)).toEqual(['-c:v', 'copy', ...TAIL]);
    expect(argsFor({ quality: 'full', lowEncoder: 'libx264' })).toEqual(copy);
    const re = argsFor({ relayVideo: 'reencode' });
    expect(re.slice(HEAD.length + 1)).toEqual([
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-force_key_frames', 'expr:gte(t,n_forced*2)', '-sc_threshold', '0', '-x264-params', 'nal-hrd=cbr',
      '-b:v', '2500k', '-minrate', '2500k', '-maxrate', '2500k', '-bufsize', '5000k', '-pix_fmt', 'yuv420p', ...TAIL,
    ]);
  });

  it('low quality: 480p at 1000 kbps with each encoder, audio unchanged', () => {
    const cases: Array<['h264_qsv' | 'h264_mf' | 'libx264', string[]]> = [
      ['h264_qsv', lowVideo('h264_qsv', 'nv12')],
      ['h264_mf', lowVideo('h264_mf', 'yuv420p')],
      ['libx264', lowVideo('libx264', 'yuv420p', ['-preset', 'veryfast', '-tune', 'zerolatency'])],
    ];
    for (const [enc, video] of cases) {
      const a = argsFor({ quality: 'low', lowEncoder: enc });
      expect(a.slice(0, HEAD.length)).toEqual(HEAD);
      expect(a.slice(HEAD.length + 1)).toEqual([...video, ...TAIL]);
    }
    // a re-encoding relay keeps its brightness lift ahead of the scale
    const lit = argsFor({ quality: 'low', lowEncoder: 'libx264', relayVideo: 'reencode', brightness: 'bright' });
    expect(lit[lit.indexOf('-vf') + 1]).toBe('eq=gamma=1.2:brightness=0.04,scale=-2:480');
  });

  it('quality low without an encoder is copy', () => {
    expect(argsFor({ quality: 'low' })).toEqual(argsFor({}));
    expect(argsFor({ quality: 'low', lowEncoder: 'h264_nvenc; rm' })).toEqual(argsFor({}));
  });

  it('behindSeconds: null before two samples, grows when the output runs slower than the clock, resets on a new run', async () => {
    let offset = 0;
    const r = await rig({ now: () => Date.now() + offset });
    r.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    r.setMode('lag');
    const relay = make(r);
    expect(relay.status().behindSeconds).toBeNull();
    relay.start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500, lowEncoder: 'libx264' });
    await until(() => relay.status().behindSeconds !== null);
    offset += 10_000;
    await until(() => (relay.status().behindSeconds ?? 0) >= 9);
    expect(relay.status().quality).toBe('full');
    // a new run starts with no reading (the old clock offset does not leak into it)
    relay.setQuality('low');
    await until(() => relay.status().restarts >= 1);
    const after = relay.status().behindSeconds;
    expect(after === null || after < 9).toBe(true);
  });

  it('setQuality restarts with the new arguments, counts in restarts, marks no failure and waits no back-off', async () => {
    const r = await rig({ backoffBaseMs: 60_000, backoffMaxMs: 60_000 });
    r.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    r.setMode('flow');
    const relay = make(r);
    relay.setQuality('low'); // not started: no-op
    relay.start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500, lowEncoder: 'libx264' });
    await until(() => relay.status().state === 'running');
    expect(relay.status().quality).toBe('full');
    relay.setQuality('full'); // unchanged: no-op
    expect(r.runs().length).toBe(1);
    relay.setQuality('low');
    await until(() => r.runs().length === 2);
    const second = r.runs()[1]!;
    expect(second[second.indexOf('-c:v') + 1]).toBe('libx264');
    expect(second).toContain('scale=-2:480');
    await until(() => relay.status().state === 'running');
    const st = relay.status();
    expect(st.quality).toBe('low');
    expect(st.restarts).toBe(1);
    expect(st.lastError).toBeNull();
    relay.setQuality('full');
    await until(() => r.runs().length === 3);
    expect(r.runs()[2]).toContain('copy');
    expect(relay.status().restarts).toBe(2);
  });

  it('B6/B8: plannedRestarts counts the quality restarts; a later exit of the new run is an ordinary failure', async () => {
    const r = await rig({ backoffBaseMs: 5, backoffMaxMs: 5 });
    r.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    r.setMode('flow');
    const relay = make(r);
    relay.start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500, lowEncoder: 'libx264' });
    await until(() => relay.status().state === 'running');
    expect(relay.status().plannedRestarts).toBe(0);
    // the next run dies by itself: only the first end is the planned one
    r.setMode('die');
    relay.setQuality('low');
    await until(() => r.runs().length >= 3);
    const st = relay.status();
    expect(st.plannedRestarts).toBe(1);
    expect(st.restarts).toBeGreaterThanOrEqual(2);
    expect(st.lastError).not.toBeNull();
  });

  it('setQuality low without an encoder keeps the relay on full', async () => {
    const r = await rig();
    r.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    r.setMode('flow');
    const relay = make(r);
    relay.start({ key: KEY, relayVideo: 'copy', maxBitrateKbps: 2500 });
    await until(() => relay.status().state === 'running');
    relay.setQuality('low');
    await until(() => r.runs().length === 2);
    expect(r.runs()[1]).toEqual(r.runs()[0]);
    expect(relay.status().quality).toBe('full');
  });
});
