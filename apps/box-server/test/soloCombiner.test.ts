import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { LIFT, LIMITER } from '../src/live/mixer.ts';
import { SoloCombiner, joinArgs, soundArgs } from '../src/live/soloCombiner.ts';
import type { MixerStartConfig } from '../src/live/mixer.ts';

/* Build 6, lane S: the solo sound path (one microphone in its own process, joined to the picture by remux). Test values only. */

const USER = 'mix-test1';
const PASS = 'Passw0rdPassw0rd';
const url = (path: string): string => `rtsp://${USER}:${PASS}@127.0.0.1:8554/${path}`;
const NORM = 'aformat=sample_rates=48000:channel_layouts=stereo';
const MON = '[m]aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono[mon]';
const OPUS = ['-c:a', 'libopus', '-b:a', '96k', '-ar', '48000', '-ac', '2', '-f', 'rtsp', '-rtsp_transport', 'tcp'];
const AAC = ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-f', 'rtsp', '-rtsp_transport', 'tcp'];
const PCM = ['-map', '[mon]', '-c:a', 'pcm_s16le', '-ar', '16000', '-f', 's16le', 'pipe:1'];

describe('soundArgs', () => {
  it('Windows: dshow input, azmq control, Opus and AAC outputs, the monitor last', () => {
    const a = soundArgs({ input: { kind: 'dshow', deviceName: 'Line In (Realtek(R) Audio)', device: 1 }, volume: 80, levelled: false, leveller: true, control: 'zmq', zmqPort: 45123, platform: 'windows', rtspUser: USER, rtspPass: PASS, aac: true });
    expect(a).toEqual([
      '-hide_banner', '-loglevel', 'warning', '-y', '-nostdin',
      '-f', 'dshow', '-sample_rate', '48000', '-audio_buffer_size', '20', '-audio_device_number', '1', '-i', 'audio=Line In (Realtek(R) Audio)',
      '-filter_complex', `[0:a]aresample=async=1:first_pts=0,asplit=2[m][r];[r]${LIFT},volume@snd=volume=0.80,${NORM},${LIMITER},azmq=bind_address=tcp\\\\://127.0.0.1\\\\:45123,asplit=2[o][a];${MON}`,
      '-map', '[o]', ...OPUS, url('surau-snd'),
      '-map', '[a]', ...AAC, url('surau-snd-aac'),
      ...PCM,
    ]);
  });

  it('Android: the phone microphone over RTSP, stdin control, no AAC rendition', () => {
    const a = soundArgs({ input: { kind: 'rtsp', path: 'surau-mic' }, volume: 100, levelled: false, leveller: true, control: 'stdin', platform: 'android', rtspUser: USER, rtspPass: PASS, aac: false });
    expect(a).toEqual([
      '-hide_banner', '-loglevel', 'warning', '-y',
      '-rtsp_transport', 'tcp', '-i', url('surau-mic'),
      '-filter_complex', `[0:a]aresample=async=1:first_pts=0,asplit=2[m][r];[r]${LIFT},volume@snd=volume=1.00,${NORM},${LIMITER}[o];${MON}`,
      '-map', '[o]', ...OPUS, url('surau-snd'),
      ...PCM,
    ]);
  });

  it('a levelled source skips the lift and keeps the limiter; no leveller drops both', () => {
    const base = { input: { kind: 'rtsp' as const, path: 'surau-mic' as const }, volume: 50, control: 'stdin' as const, platform: 'android' as const, aac: false };
    const levelled = soundArgs({ ...base, levelled: true, leveller: true }).join(' ');
    expect(levelled).not.toContain('compand');
    expect(levelled).toContain(`volume@snd=volume=0.50,${NORM},${LIMITER}[o]`);
    const off = soundArgs({ ...base, levelled: false, leveller: false }).join(' ');
    expect(off).not.toContain('compand');
    expect(off).not.toContain('alimiter');
    expect(off).toContain(`[r]volume@snd=volume=0.50,${NORM}[o]`);
  });

  it('uses only the filters the Android box ffmpeg has', () => {
    const a = soundArgs({ input: { kind: 'rtsp', path: 'surau-mic' }, volume: 70, levelled: false, leveller: true, control: 'stdin', platform: 'android', aac: true });
    const graph = a[a.indexOf('-filter_complex') + 1]!;
    const names = graph.split(/[;,]/).map((p) => p.replace(/\[[^\]]*\]/g, '').split('=')[0]!.split('@')[0]!).filter((n) => n !== '');
    const allowed = new Set(['aresample', 'aformat', 'anull', 'anullsrc', 'amix', 'adelay', 'volume', 'asplit', 'amerge', 'arealtime', 'compand', 'alimiter']);
    expect(names.length).toBeGreaterThanOrEqual(6);
    expect(names.filter((n) => !allowed.has(n))).toEqual([]);
  });

  it('refuses a bad device name, a bad path, dshow or azmq on the Android box, and a bad volume', () => {
    const ok = { volume: 50, levelled: false, leveller: true, aac: false } as const;
    expect(() => soundArgs({ ...ok, input: { kind: 'dshow', deviceName: 'bad"name' }, control: 'stdin', platform: 'windows' })).toThrow(RangeError);
    expect(() => soundArgs({ ...ok, input: { kind: 'dshow', deviceName: 'x=y' }, control: 'stdin', platform: 'windows' })).toThrow(RangeError);
    expect(() => soundArgs({ ...ok, input: { kind: 'rtsp', path: 'surau-cam' as 'surau-mic' }, control: 'stdin', platform: 'android' })).toThrow(RangeError);
    expect(() => soundArgs({ ...ok, input: { kind: 'dshow', deviceName: 'Line In' }, control: 'stdin', platform: 'android' })).toThrow(RangeError);
    expect(() => soundArgs({ ...ok, input: { kind: 'rtsp', path: 'surau-mic' }, control: 'zmq', zmqPort: 45000, platform: 'android' })).toThrow(RangeError);
    expect(() => soundArgs({ ...ok, input: { kind: 'rtsp', path: 'surau-mic' }, control: 'zmq', platform: 'windows' })).toThrow(RangeError);
    expect(() => soundArgs({ ...ok, volume: 101, input: { kind: 'rtsp', path: 'surau-mic' }, control: 'stdin', platform: 'android' })).toThrow(RangeError);
    expect(() => soundArgs({ ...ok, input: { kind: 'rtsp', path: 'surau-mic' }, control: 'stdin', platform: 'android', rtspUser: 'a b', rtspPass: PASS })).toThrow(RangeError);
  });
});

describe('joinArgs', () => {
  it('copies the picture and the sound with one delay, the unit input LAST; no filter, no decode', () => {
    expect(joinArgs({ unit: 'camera', delayMs: 400, yt: false, rtspUser: USER, rtspPass: PASS })).toEqual([
      '-copyts', '-hide_banner', '-loglevel', 'warning', '-y', '-nostdin',
      '-itsoffset', '0.400', '-rtsp_transport', 'tcp', '-i', url('surau-snd'),
      '-rtsp_transport', 'tcp', '-i', url('surau-cam'),
      '-map', '1:v', '-map', '0:a', '-c', 'copy', '-f', 'rtsp', '-rtsp_transport', 'tcp', url('surau'),
    ]);
  });

  it('with YouTube: the AAC sound is a second input with the same delay and a second output', () => {
    expect(joinArgs({ unit: 'ingest', delayMs: 1250, yt: true, rtspUser: USER, rtspPass: PASS })).toEqual([
      '-copyts', '-hide_banner', '-loglevel', 'warning', '-y', '-nostdin',
      '-itsoffset', '1.250', '-rtsp_transport', 'tcp', '-i', url('surau-snd'),
      '-itsoffset', '1.250', '-rtsp_transport', 'tcp', '-i', url('surau-snd-aac'),
      '-rtsp_transport', 'tcp', '-i', url('surau-in'),
      '-map', '2:v', '-map', '0:a', '-c', 'copy', '-f', 'rtsp', '-rtsp_transport', 'tcp', url('surau'),
      '-map', '2:v', '-map', '1:a', '-c', 'copy', '-f', 'rtsp', '-rtsp_transport', 'tcp', url('surau-yt'),
    ]);
  });

  it('delay 0 is -itsoffset 0.000; 2001, a fraction or a negative delay throws', () => {
    expect(joinArgs({ unit: 'camera', delayMs: 0, yt: false })).toContain('0.000');
    expect(() => joinArgs({ unit: 'camera', delayMs: 2001, yt: false })).toThrow(RangeError);
    expect(() => joinArgs({ unit: 'camera', delayMs: 10.5, yt: false })).toThrow(RangeError);
    expect(() => joinArgs({ unit: 'camera', delayMs: -1, yt: false })).toThrow(RangeError);
    expect(() => joinArgs({ unit: 'other' as 'camera', delayMs: 0, yt: false })).toThrow(RangeError);
    expect(() => joinArgs({ unit: 'camera', delayMs: 0, yt: true, ytOutputPath: 'surau' })).toThrow(RangeError);
  });
});

/* ------------------------------------------------------------------ SoloCombiner with a fake process */

interface Fake extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: string | null;
  kill: (sig?: string) => boolean;
  written: string[];
  exit: (code: number) => void;
  args: string[];
  kind: 'snd' | 'join';
  pid: number | undefined;
}

/** `exitAfterMs`: a killed child takes this long to end (a real ffmpeg flushing its output); 0 = at once. */
function fakeSpawn(o: { exitAfterMs?: (kind: 'snd' | 'join') => number } = {}): { spawnFn: (c: string, a: string[]) => ChildProcess; procs: Fake[]; kills: string[] } {
  const procs: Fake[] = [];
  const kills: string[] = [];
  const spawnFn = (_c: string, args: string[]): ChildProcess => {
    const f = new EventEmitter() as Fake;
    f.pid = 4000 + procs.length;
    f.stdin = new PassThrough();
    f.stdout = new PassThrough();
    f.stderr = new PassThrough();
    f.exitCode = null;
    f.signalCode = null;
    f.written = [];
    f.args = args;
    f.kind = args.includes('-copyts') ? 'join' : 'snd';
    f.stdin.on('data', (d: Buffer) => f.written.push(d.toString()));
    f.exit = (code) => {
      if (f.exitCode !== null) return;
      f.exitCode = code;
      f.emit('close', code, null);
    };
    f.kill = () => {
      kills.push(f.kind);
      const ms = o.exitAfterMs?.(f.kind) ?? 0;
      if (ms > 0) setTimeout(() => f.exit(0), ms);
      else queueMicrotask(() => f.exit(0));
      return true;
    };
    procs.push(f);
    return f as unknown as ChildProcess;
  };
  return { spawnFn, procs, kills };
}

function fakeApi(ready: string[] = ['surau-snd', 'surau-snd-aac']) {
  const set = new Set(ready);
  return { ready: set, api: { pathGet: async (name: string) => ({ ready: set.has(name) }) } };
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await wait(5);
  }
}
const cfg = (over: Partial<MixerStartConfig> = {}): MixerStartConfig => ({ unit: 'camera', unitHasAudio: true, unitVolume: 0, added: [{ id: 'deviceMic', initialDelayMs: 400, volume: 80 }], ...over });
const base = { ffmpegPath: 'ffmpeg', platform: 'android' as const, headroomMs: 0, pathPollMs: 5, backoffBaseMs: 1, backoffMaxMs: 1 };
const kinds = (procs: Fake[]): string => procs.map((p) => p.kind).join(',');

describe('SoloCombiner', () => {
  it('starts the sound process first and the join only once surau-snd is ready', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const { ready, api } = fakeApi([]);
    const c = new SoloCombiner({ ...base, spawnFn, api });
    c.start(cfg());
    expect(kinds(procs)).toBe('snd');
    await wait(40);
    expect(kinds(procs)).toBe('snd');
    expect(c.status().state).toBe('starting');
    ready.add('surau-snd');
    await until(() => procs.length === 2);
    expect(kinds(procs)).toBe('snd,join');
    expect(procs[1]!.args).toContain('0.400');
    expect(c.status().state).toBe('running');
    expect(c.status().channels).toEqual(['unit', 'deviceMic']);
    await c.stop();
  });

  it('with YouTube the join also waits for the AAC path', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const { ready, api } = fakeApi(['surau-snd']);
    const c = new SoloCombiner({ ...base, spawnFn, api });
    c.start(cfg({ ytOutputPath: 'surau-yt' }));
    await wait(40);
    expect(kinds(procs)).toBe('snd');
    ready.add('surau-snd-aac');
    await until(() => procs.length === 2);
    expect(procs[1]!.args.join(' ')).toContain('/surau-yt');
    expect(procs[0]!.args.join(' ')).toContain('/surau-snd-aac');
    await c.stop();
  });

  it('starts the join after the wait even when the path never shows (its own retry takes over)', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const { api } = fakeApi([]);
    const c = new SoloCombiner({ ...base, spawnFn, api, pathWaitMs: 30 });
    c.start(cfg());
    await until(() => procs.length === 2);
    expect(kinds(procs)).toBe('snd,join');
    await c.stop();
  });

  it('setVolume sends one run-time command to the sound process and spawns nothing; the unit is ignored', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const { api } = fakeApi();
    const c = new SoloCombiner({ ...base, spawnFn, api });
    c.start(cfg());
    await until(() => procs.length === 2);
    await c.setVolume('deviceMic', 50);
    await c.setVolume('unit', 0);
    await wait(10);
    expect(procs).toHaveLength(2);
    expect(procs[0]!.written.join('')).toBe('cvolume@snd -1 volume 0.50\n');
    expect(procs[1]!.written).toEqual([]);
    expect(c.status().commandsSent).toBe(1);
    await expect(c.setVolume('deviceMic', 101)).rejects.toThrow(RangeError);
    await c.stop();
  });

  it('zmq control on Windows: the volume goes to azmq on the port of the run', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const { api } = fakeApi();
    const zmqSend = vi.fn(async () => '0 Success');
    const c = new SoloCombiner({ ...base, platform: 'windows', deviceName: 'Line In', zmqPort: 45123, spawnFn, zmqSend, api });
    c.start(cfg({ added: [{ id: 'boxInput', initialDelayMs: 400, volume: 100 }] }));
    await until(() => procs.length === 2);
    await c.setVolume('boxInput', 30);
    expect(zmqSend.mock.calls).toEqual([[45123, 'volume@snd volume 0.30']]);
    expect(procs[0]!.args.join(' ')).toContain('audio=Line In');
    await c.stop();
  });

  it('setDelay restarts only the join with the new delay (clamped to 0..2000); the same value does nothing', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const { api } = fakeApi();
    const c = new SoloCombiner({ ...base, spawnFn, api });
    c.start(cfg());
    await until(() => procs.length === 2);
    await c.setDelay('deviceMic', 400);
    await wait(20);
    expect(procs).toHaveLength(2);
    await c.setDelay('deviceMic', 650);
    await until(() => procs.length === 3);
    expect(kinds(procs)).toBe('snd,join,join');
    expect(procs[2]!.args).toContain('0.650');
    expect(procs[0]!.exitCode).toBeNull();
    await c.setDelay('deviceMic', 9000);
    await until(() => procs.length === 4);
    expect(procs[3]!.args).toContain('2.000');
    expect(c.status().state).toBe('running');
    expect(c.status().lastError).toBeNull();
    await c.stop();
  });

  it('a sound process that exits stops the join, then both come back in order (sound first); the exit is counted as a stall', async () => {
    const { spawnFn, procs, kills } = fakeSpawn();
    const { api } = fakeApi();
    const c = new SoloCombiner({ ...base, spawnFn, api });
    c.start(cfg());
    await until(() => procs.length === 2);
    procs[0]!.exit(1);
    await until(() => procs.length === 4);
    expect(kinds(procs)).toBe('snd,join,snd,join');
    expect(kills).toEqual(['join']);
    expect(procs[1]!.exitCode).not.toBeNull();
    const st = c.status();
    expect(st.lastStall?.reason).toBe('sound_exit');
    expect(st.stalls).toBe(1);
    expect(st.restarts).toBeGreaterThanOrEqual(2);
    await c.stop();
  });

  it('a join that exits is relaunched alone', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const { api } = fakeApi();
    const c = new SoloCombiner({ ...base, spawnFn, api });
    c.start(cfg());
    await until(() => procs.length === 2);
    procs[1]!.exit(1);
    await until(() => procs.length === 3);
    expect(kinds(procs)).toBe('snd,join,join');
    expect(c.status().stalls).toBe(0);
    await c.stop();
  });

  it('kick restarts only the join and counts a stall with the reason', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const { api } = fakeApi();
    const c = new SoloCombiner({ ...base, spawnFn, api });
    c.start(cfg());
    await until(() => procs.length === 2);
    c.kick('no_output');
    await until(() => procs.length === 3);
    expect(kinds(procs)).toBe('snd,join,join');
    expect(c.status().lastStall?.reason).toBe('no_output');
    await c.stop();
  });

  it('a silent monitor counts a stall (monitor_silent) and relaunches the sound process', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const { api } = fakeApi();
    const c = new SoloCombiner({ ...base, spawnFn, api, stallMs: 40, startGraceMs: 0 });
    c.start(cfg());
    await until(() => procs.filter((p) => p.kind === 'snd').length >= 2);
    const st = c.status();
    expect(st.stalls).toBeGreaterThanOrEqual(1);
    expect(st.lastStall?.reason).toBe('monitor_silent');
    await c.stop();
  });

  it('the monitor is two channels: silence for the unit, the source in channel 1, across chunk boundaries', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const { api } = fakeApi();
    const c = new SoloCombiner({ ...base, spawnFn, api });
    const got: Buffer[] = [];
    c.monitor.on('data', (d: Buffer) => got.push(d));
    c.start(cfg());
    procs[0]!.stdout.write(Buffer.from([1, 0, 2]));
    procs[0]!.stdout.write(Buffer.from([0, 0xff, 0x7f]));
    await wait(10);
    expect(Buffer.concat(got)).toEqual(Buffer.from([0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 0xff, 0x7f]));
    await c.stop();
  });

  it('drops() counts the dshow "frame dropped" lines of the last 30 s', async () => {
    let now = 1_000_000;
    const { spawnFn, procs } = fakeSpawn();
    const { api } = fakeApi();
    const c = new SoloCombiner({ ...base, platform: 'windows', control: 'stdin', deviceName: 'Line In', spawnFn, api, now: () => now });
    c.start(cfg({ added: [{ id: 'boxInput', initialDelayMs: 400, volume: 100 }] }));
    procs[0]!.stderr.write('[dshow @ 0000] real-time buffer [Line In] [audio input] too full or near too full (63% of size: 3041280 [rtbufsize parameter])! frame dropped!\n');
    procs[0]!.stderr.write('[dshow @ 0000] real-time buffer [Line In] [audio input] too full or near too full (64% of size: 3041280 [rtbufsize parameter])! frame dropped!\r');
    await wait(10);
    expect(c.drops()).toBe(2);
    now += 31_000;
    expect(c.drops()).toBe(0);
    await c.stop();
  });

  it('a missing leveller filter relaunches the sound process without it, once', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const { api } = fakeApi();
    const missing = vi.fn();
    const c = new SoloCombiner({ ...base, spawnFn, api, onLevellerMissing: missing, warn: () => undefined });
    c.start(cfg());
    expect(procs[0]!.args.join(' ')).toContain('compand');
    procs[0]!.stderr.write('[AVFilterGraph @ 0000] No such filter: \'compand\'\n');
    await wait(5);
    procs[0]!.exit(1);
    await until(() => procs.filter((p) => p.kind === 'snd').length === 2);
    const second = procs.filter((p) => p.kind === 'snd')[1]!;
    expect(second.args.join(' ')).not.toContain('compand');
    expect(second.args.join(' ')).not.toContain('alimiter');
    expect(missing).toHaveBeenCalledTimes(1);
    expect(c.status().stalls).toBe(0);
    await c.stop();
  });

  it('asks the leveller probe once before the first run', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const { api } = fakeApi();
    const c = new SoloCombiner({ ...base, spawnFn, api, levellerProbe: async () => false, warn: () => undefined });
    c.start(cfg());
    expect(procs).toHaveLength(0);
    await until(() => procs.length >= 1);
    expect(procs[0]!.args.join(' ')).not.toContain('compand');
    await c.stop();
  });

  it('a bad configuration (not exactly one source) is state failed with solo_bad_config, never a throw', () => {
    const { spawnFn, procs } = fakeSpawn();
    const { api } = fakeApi();
    const none = new SoloCombiner({ ...base, spawnFn, api });
    none.start(cfg({ added: [] }));
    expect(none.status()).toMatchObject({ state: 'failed', lastError: 'solo_bad_config' });
    const two = new SoloCombiner({ ...base, spawnFn, api });
    two.start(cfg({ added: [{ id: 'deviceMic', initialDelayMs: 0, volume: 1 }, { id: 'boxInput', initialDelayMs: 0, volume: 1 }] }));
    expect(two.status().state).toBe('failed');
    expect(procs).toHaveLength(0);
  });

  it('gives up after too many failed sound runs, and no login reaches the status or the log', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const { api } = fakeApi([]);
    const lines: string[] = [];
    const c = new SoloCombiner({ ...base, spawnFn, api, rtspUser: USER, rtspPass: PASS, maxFailures: 3, log: (_k, t) => lines.push(t) });
    c.start(cfg());
    for (let n = 0; n < 3; n++) {
      await until(() => procs.length === n + 1);
      procs[n]!.stderr.write(`${url('surau-mic')}: Server returned 401\n`);
      await wait(5);
      procs[n]!.exit(1);
    }
    await until(() => c.status().state === 'failed');
    expect(JSON.stringify(c.status())).not.toContain(PASS);
    expect(lines.join('\n')).not.toContain(PASS);
    expect(lines.some((l) => l.includes('ffmpeg'))).toBe(true);
    await c.stop();
  });

  it('B1: a sound exit while the old join is still shutting down brings the join back (it is never left down)', async () => {
    const { spawnFn, procs } = fakeSpawn({ exitAfterMs: (k) => (k === 'join' ? 60 : 0) });
    const { api } = fakeApi();
    const c = new SoloCombiner({ ...base, spawnFn, api });
    c.start(cfg());
    await until(() => procs.length === 2);
    procs[0]!.exit(1);
    await until(() => procs.length === 4);
    expect(kinds(procs)).toBe('snd,join,snd,join');
    expect(procs[1]!.exitCode).not.toBeNull();
    expect(procs[3]!.exitCode).toBeNull();
    await until(() => c.status().state === 'running');
    await wait(100);
    expect(procs).toHaveLength(4);
    await c.stop();
  });

  it('B1: a kick launches a join that is down (not alive, nothing pending) while the sound runs', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const { api } = fakeApi();
    const c = new SoloCombiner({ ...base, spawnFn, api, maxFailures: 2 });
    c.start(cfg());
    await until(() => procs.length === 2);
    procs[1]!.exit(1);
    await until(() => procs.length === 3);
    procs[2]!.exit(1);
    await until(() => c.status().state === 'failed');
    await wait(20);
    expect(procs).toHaveLength(3);
    c.kick('no_output');
    await until(() => procs.length === 4);
    expect(kinds(procs)).toBe('snd,join,join,join');
    expect(procs[0]!.exitCode).toBeNull();
    await c.stop();
  });

  it('B3: after two dshow sound runs that end within 5 s, later launches leave -audio_buffer_size out', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const { api } = fakeApi([]);
    const c = new SoloCombiner({ ...base, platform: 'windows', control: 'stdin', deviceName: 'Line In', spawnFn, api, warn: () => undefined });
    c.start(cfg({ added: [{ id: 'boxInput', initialDelayMs: 400, volume: 100 }] }));
    const snd = (): Fake[] => procs.filter((p) => p.kind === 'snd');
    await until(() => snd().length === 1);
    expect(snd()[0]!.args).toContain('-audio_buffer_size');
    snd()[0]!.exit(1);
    await until(() => snd().length === 2);
    expect(snd()[1]!.args).toContain('-audio_buffer_size');
    snd()[1]!.exit(1);
    await until(() => snd().length === 3);
    expect(snd()[2]!.args).not.toContain('-audio_buffer_size');
    expect(snd()[2]!.args.join(' ')).toContain('-sample_rate 48000');
    await c.stop();
  });

  it('B3: soundArgs bufferSize false leaves the capture buffer option out', () => {
    const a = soundArgs({ input: { kind: 'dshow', deviceName: 'Line In' }, volume: 100, levelled: false, leveller: true, control: 'stdin', platform: 'windows', aac: false, bufferSize: false });
    expect(a.slice(4, 10)).toEqual(['-f', 'dshow', '-sample_rate', '48000', '-i', 'audio=Line In']);
  });

  it('B10: the status stderr tail has no URL login (user name included)', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const { api } = fakeApi();
    const c = new SoloCombiner({ ...base, spawnFn, api });
    c.start(cfg());
    await until(() => procs.length === 2);
    procs[1]!.stderr.write('rtsp://someone:secret9@127.0.0.1:8554/surau-cam: 404 Not Found\n');
    await wait(10);
    const tail = c.status().stderrTail.join('\n');
    expect(tail).toContain('rtsp://***@127.0.0.1:8554/surau-cam');
    expect(tail).not.toContain('someone');
    expect(tail).not.toContain('secret9');
    await c.stop();
  });

  it('B10: an error event of a started child waits for its close before anything is relaunched', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const { api } = fakeApi();
    const c = new SoloCombiner({ ...base, spawnFn, api });
    c.start(cfg());
    await until(() => procs.length === 2);
    procs[1]!.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
    await wait(30);
    expect(procs).toHaveLength(2);
    procs[1]!.exit(1);
    await until(() => procs.length === 3);
    expect(kinds(procs)).toBe('snd,join,join');
    await c.stop();
  });

  it('B13: a sound ffmpeg that cannot be spawned is a sound_spawn stall, not sound_exit', async () => {
    const { spawnFn: inner, procs } = fakeSpawn();
    const spawnFn = (cmd: string, args: string[]): ChildProcess => {
      const p = inner(cmd, args) as unknown as Fake;
      if (p.kind === 'snd' && procs.filter((x) => x.kind === 'snd').length === 1) {
        p.pid = undefined;
        queueMicrotask(() => p.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
      }
      return p as unknown as ChildProcess;
    };
    const { api } = fakeApi();
    const c = new SoloCombiner({ ...base, spawnFn, api });
    c.start(cfg());
    await until(() => c.status().stalls >= 1);
    expect(c.status().lastStall?.reason).toBe('sound_spawn');
    await c.stop();
  });

  it('stop ends the join first, then the sound process, and is safe twice', async () => {
    const { spawnFn, procs, kills } = fakeSpawn();
    const { api } = fakeApi();
    const c = new SoloCombiner({ ...base, spawnFn, api });
    c.start(cfg());
    await until(() => procs.length === 2);
    await c.stop();
    await c.stop();
    expect(kills).toEqual(['join', 'snd']);
    expect(c.status().state).toBe('off');
    await wait(20);
    expect(procs).toHaveLength(2);
  });
});
