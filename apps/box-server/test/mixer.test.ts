import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:net';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEVELLER, LIFT, LIMITER, Mixer, delayCommand, demuxMonitor, mixArgs, monitorChannels, stdinLine, volumeCommand, zmqMessage, zmqRequest } from '../src/live/mixer.ts';
import type { MixArgsInput } from '../src/live/mixer.ts';

const base: MixArgsInput = {
  unit: 'camera',
  unitHasAudio: true,
  added: [],
  unitVolume: 100,
  headroomMs: 1500,
  control: 'stdin',
  platform: 'windows',
};
const mic = { id: 'deviceMic' as const, initialDelayMs: 1000, volume: 80 };
const box = { id: 'boxInput' as const, initialDelayMs: 900, volume: 60 };
const graph = (a: string[]): string => a[a.indexOf('-filter_complex') + 1] as string;
const inputs = (a: string[]): string[] => a.flatMap((x, i) => (x === '-i' ? [a[i + 1] as string] : []));

describe('mixArgs: the rules proven in T0', () => {
  const cases: Array<[string, Partial<MixArgsInput>]> = [
    ['camera only, windows/stdin', {}],
    ['camera only, windows/zmq', { control: 'zmq', zmqPort: 45123 }],
    ['camera only, android', { platform: 'android' }],
    ['camera + device mic, android', { platform: 'android', added: [mic] }],
    ['camera + device mic, windows/zmq', { control: 'zmq', zmqPort: 45123, added: [mic] }],
    ['camera + device mic + box input, windows', { added: [mic, box], deviceName: 'Line In (USB Audio)' }],
    ['mic only (unit volume 0)', { unitVolume: 0, added: [mic] }],
    ['ingest unit, android', { unit: 'ingest', platform: 'android', added: [mic] }],
    ['unit without audio + mic, android', { unitHasAudio: false, platform: 'android', added: [mic] }],
    ['unit without audio + box input, windows', { unitHasAudio: false, added: [box], deviceName: 'Line In' }],
  ];

  it.each(cases)('%s: video copied with its own timestamps, never wallclock-stamped, unit audio consumed', (_n, over) => {
    const a = mixArgs({ ...base, ...over });
    expect(a).not.toContain('-use_wallclock_as_timestamps');
    expect(a.join(' ')).not.toMatch(/wallclock/);
    expect(a[a.indexOf('-c:v') + 1]).toBe('copy');
    expect(a).toContain('-map');
    const unitIdx = (over.added ?? []).length;
    expect(a[a.indexOf('-map') + 1]).toBe(`${unitIdx}:v`);
    const g = graph(a);
    // the unit's own audio feeds a named volume (reference at volume 0 is still consumed)
    expect(g).toMatch(/volume@unit=volume=\d\.\d\d/);
    const silent = (over.added ?? []).length === 0 ? 'anullsrc=r=48000:cl=stereo,arealtime,asplit=2[m0][r0]' : 'anullsrc=r=48000:cl=stereo,asplit=2[m0][r0]';
    expect(g).toContain(over.unitHasAudio === false ? silent : `[${unitIdx}:a]asplit=2[m0][r0]`);
    // the unit (picture) input is always the LAST -i
    expect(inputs(a)[inputs(a).length - 1]).toBe(`rtsp://127.0.0.1:8554/${over.unit === 'ingest' ? 'surau-in' : 'surau-cam'}`);
    // -copyts only when every added source is an RTSP input
    const rtspOnly = (over.added ?? []).length > 0 && (over.added ?? []).every((x) => x.id === 'deviceMic');
    expect(a[0] === '-copyts').toBe(rtspOnly);
    expect(a.filter((x) => x === '-copyts')).toHaveLength(rtspOnly ? 1 : 0);
    expect(g.includes('arealtime')).toBe(over.unitHasAudio === false && (over.added ?? []).length === 0);
    // no direct `-map 0:a`: the audio goes through the graph, and nothing is left dangling
    expect(a.join(' ')).not.toContain('-map 0:a');
    expect(a.slice(-9)).toEqual(['-map', '[mon]', '-c:a', 'pcm_s16le', '-ar', '16000', '-f', 's16le', 'pipe:1']);
  });

  it('puts -itsoffset (headroom in seconds) on the unit input only', () => {
    const a = mixArgs({ ...base, added: [mic], headroomMs: 1500 });
    expect(a.filter((x) => x === '-itsoffset')).toHaveLength(1);
    expect(a.indexOf('-itsoffset')).toBeGreaterThan(a.indexOf('-i'));
    expect(a[a.indexOf('-itsoffset') + 1]).toBe('1.500');
    expect(a[a.indexOf('-itsoffset') + 5]).toBe('rtsp://127.0.0.1:8554/surau-cam');
    expect(inputs(a)).toEqual(['rtsp://127.0.0.1:8554/surau-mic', 'rtsp://127.0.0.1:8554/surau-cam']);
    expect(graph(a)).toContain('[1:a]asplit=2[m0][r0]');
    expect(graph(a)).toContain('[0:a]adelay@deviceMic');
  });

  it('reads the ingest path for an ingest unit and uses a per-session login when given', () => {
    const a = mixArgs({ ...base, unit: 'ingest', rtspUser: 'mixer-ab12', rtspPass: 'Passw0rdPassw0rd', rtspPort: 9554 });
    expect(inputs(a)[inputs(a).length - 1]).toBe('rtsp://mixer-ab12:Passw0rdPassw0rd@127.0.0.1:9554/surau-in');
    expect(a.some((x) => x === 'rtsp://mixer-ab12:Passw0rdPassw0rd@127.0.0.1:9554/surau')).toBe(true);
  });

  it('adds each source with a named adelay starting NON-ZERO and a named volume', () => {
    const g = graph(mixArgs({ ...base, added: [{ ...mic, initialDelayMs: 0 }, box], deviceName: 'Line In' }));
    expect(g).toContain('adelay@deviceMic=delays=1:all=1');
    expect(g).toContain('adelay@boxInput=delays=900:all=1');
    expect(g).toContain('volume@deviceMic=');
    expect(g).toContain('volume@boxInput=');
    expect(g).toContain('amix=inputs=3:normalize=0,aresample=async=1');
  });

  it('holds an added source out of the mix (volume 0) while the reference is audible, until told', () => {
    expect(graph(mixArgs({ ...base, added: [mic] }))).toContain('volume@deviceMic=volume=0.00');
    expect(graph(mixArgs({ ...base, added: [{ ...mic, held: false }] }))).toContain('volume@deviceMic=volume=0.80');
  });

  it('plays the added source at once when the reference is silent (mic only) or absent', () => {
    expect(graph(mixArgs({ ...base, unitVolume: 0, added: [mic] }))).toContain('volume@deviceMic=volume=0.80');
    expect(graph(mixArgs({ ...base, unitHasAudio: false, added: [mic] }))).toContain('volume@deviceMic=volume=0.80');
  });

  it('mic only keeps the unit audio in the graph at volume 0', () => {
    expect(graph(mixArgs({ ...base, unitVolume: 0, added: [mic] }))).toContain('volume@unit=volume=0.00');
  });

  it('-copyts only for all-RTSP added inputs; the dshow box input keeps the old behaviour', () => {
    expect(mixArgs({ ...base, added: [mic] })[0]).toBe('-copyts');
    expect(mixArgs({ ...base, added: [box], deviceName: 'Line In' })).not.toContain('-copyts');
    expect(mixArgs({ ...base, added: [mic, box], deviceName: 'Line In' })).not.toContain('-copyts');
    expect(mixArgs(base)).not.toContain('-copyts');
    // order with the dshow input: added first, the unit last
    const w = mixArgs({ ...base, added: [mic, box], deviceName: 'Line In' });
    expect(inputs(w)).toEqual(['rtsp://127.0.0.1:8554/surau-mic', 'audio=Line In', 'rtsp://127.0.0.1:8554/surau-cam']);
    expect(w[w.indexOf('-map') + 1]).toBe('2:v');
    expect(graph(w)).toContain('[0:a]adelay@deviceMic');
    expect(graph(w)).toContain('[1:a]adelay@boxInput');
    expect(graph(w)).toContain('[2:a]asplit=2[m0][r0]');
  });

  it('a unit without audio gets an anullsrc reference INSIDE the graph; arealtime only when no added source paces it', () => {
    for (const platform of ['android', 'windows'] as const) {
      const a = mixArgs({ ...base, unitHasAudio: false, platform, added: [{ ...mic, initialDelayMs: 650 }] });
      expect(graph(a)).toContain('anullsrc=r=48000:cl=stereo,asplit=2[m0][r0]');
      expect(graph(a)).not.toContain('arealtime');
      expect(graph(a)).toContain('[0:a]adelay@deviceMic=delays=650:all=1');
      expect(a).not.toContain('anullsrc=r=48000:cl=mono');
      expect(inputs(a)).toEqual(['rtsp://127.0.0.1:8554/surau-mic', 'rtsp://127.0.0.1:8554/surau-cam']);
      expect(a[a.indexOf('-map') + 1]).toBe('1:v');
      const alone = mixArgs({ ...base, unitHasAudio: false, platform });
      expect(graph(alone)).toContain('anullsrc=r=48000:cl=stereo,arealtime,asplit=2[m0][r0]');
    }
  });

  it('never uses -f lavfi on android (its ffmpeg is built without avdevice), in any case', () => {
    for (const [, over] of cases) {
      const a = mixArgs({ ...base, ...over, platform: 'android', control: 'stdin', added: (over.added ?? []).filter((x) => x.id !== 'boxInput'), deviceName: undefined });
      expect(a).not.toContain('lavfi');
      expect(a).not.toContain('-re');
    }
    expect(mixArgs({ ...base, unitHasAudio: false, platform: 'android' })).not.toContain('lavfi');
  });

  it('monitor: channel 0 = the reference, channel n = added source n after its delay (tap after adelay)', () => {
    const g = graph(mixArgs({ ...base, added: [mic, box], deviceName: 'Line In' }));
    expect(g).toContain('amerge=inputs=3');
    expect(g).toMatch(/\[0:a\]adelay@deviceMic=[^;]*asplit=2\[m1\]\[r1\]/);
    expect(g).toContain('[t0][t1][t2]amerge=inputs=3,aformat=sample_fmts=s16[mon]');
    expect(g).toContain('aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono');
    expect(monitorChannels([mic, box])).toEqual(['unit', 'deviceMic', 'boxInput']);
  });

  it('the lift sits on each input before its volume, the limiter once on the final mix, the monitor taps the raw sources', () => {
    const one = graph(mixArgs({ ...base }));
    expect(one).toContain(`[r0]${LIFT},volume@unit=`);
    expect(one).toContain(`[c0]aresample=async=1,${LIMITER}[mix]`);
    const many = graph(mixArgs({ ...base, added: [mic, box], deviceName: 'Line In' }));
    expect(many).toContain(`amix=inputs=3:normalize=0,aresample=async=1,${LIMITER}[mix]`);
    expect(many).toContain(`[r1]${LIFT},volume@deviceMic=`);
    expect(many).toContain(`[r2]${LIFT},volume@boxInput=`);
    expect(many.split(LIFT)).toHaveLength(4); // unit, mic, box: one each
    for (const g of [one, many]) {
      expect(g.split(LIMITER)).toHaveLength(2); // once, on the mix only
      expect(g).toMatch(/\[m0\]aresample=16000[^;]*\[t0\]/);
      expect(g.split(';').find((x) => x.endsWith('[mon]'))).toMatch(/^\[t0\]/);
      expect(g.split(';').find((x) => x.endsWith('[mon]'))).not.toMatch(/compand|alimiter/);
    }
    expect(LEVELLER).toBe(`${LIFT},${LIMITER}`);
    expect(LIMITER).toContain('alimiter=limit=0.89');
    expect(LIMITER).toContain('level=0');
    expect(Number(/attack=(\d+)/.exec(LIMITER)?.[1])).toBeLessThanOrEqual(5);
  });

  it('the Android app levels its own mic: its ingest unit and deviceMic are not lifted, the camera sound and box input are', () => {
    const ing = graph(mixArgs({ ...base, unit: 'ingest', platform: 'android', appLevelled: true, added: [mic] }));
    expect(ing).not.toContain('compand');
    expect(ing).toContain(LIMITER); // the safety limiter stays on the mix
    const cam = graph(mixArgs({ ...base, platform: 'windows', appLevelled: true, added: [mic, box], deviceName: 'Line In' }));
    expect(cam).toContain(`[r0]${LIFT},volume@unit=`); // IP camera sound
    expect(cam).toContain('[r1]volume@deviceMic=');
    expect(cam).toContain(`[r2]${LIFT},volume@boxInput=`);
    // a web session (not appLevelled) lifts the ingest feed
    expect(graph(mixArgs({ ...base, unit: 'ingest', platform: 'android', added: [mic] }))).toContain(`[r0]${LIFT},volume@unit=`);
  });

  it('leveller:false leaves the mix as before (no compand, no alimiter anywhere)', () => {
    expect(graph(mixArgs({ ...base, leveller: false }))).toContain('[c0]aresample=async=1[mix]');
    const g = graph(mixArgs({ ...base, leveller: false, added: [mic] }));
    expect(g).toContain('amix=inputs=2:normalize=0,aresample=async=1[mix]');
    expect(g).not.toMatch(/alimiter|compand/);
    expect(graph(mixArgs({ ...base, leveller: true }))).toContain('alimiter');
  });

  it('the mix is published as Opus 48 kHz stereo and the monitor is s16le 16 kHz on stdout', () => {
    const a = mixArgs({ ...base, added: [mic] });
    expect(a).toEqual(expect.arrayContaining(['-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-f', 'rtsp']));
    expect(a[a.length - 1]).toBe('pipe:1');
    expect(a).toContain('[mix]');
  });

  it('windows capture device: dshow input with an optional device number; android refuses it', () => {
    const w = mixArgs({ ...base, added: [box], deviceName: 'Line In (USB Audio)', device: 1 });
    const i = w.indexOf('dshow');
    expect(w.slice(i - 1, i + 7)).toEqual(['-f', 'dshow', '-sample_rate', '48000', '-audio_device_number', '1', '-i', 'audio=Line In (USB Audio)']);
    expect(() => mixArgs({ ...base, added: [box], deviceName: 'x"; calc' })).toThrow();
    for (const bad of ['a:b', 'a=b', 'a\nb', 'a�b', 'x'.repeat(121), '']) expect(() => mixArgs({ ...base, added: [box], deviceName: bad })).toThrow();
    expect(() => mixArgs({ ...base, added: [box] })).toThrow();
    expect(() => mixArgs({ ...base, platform: 'android', added: [box], deviceName: 'Line In' })).toThrow(/Android/);
  });

  it('a real Windows name (registered-sign, accents) passes through the argument array', () => {
    const name = 'Microphone Array (Intel® Smart Sound Technology for Digital Microphones)';
    const w = mixArgs({ ...base, added: [box], deviceName: name });
    expect(w).toContain(`audio=${name}`);
    expect(mixArgs({ ...base, added: [box], deviceName: 'Mikrofon éè (Realtek)' })).toContain('audio=Mikrofon éè (Realtek)');
  });

  describe('control channel', () => {
    it('zmq: azmq bound to loopback on the given port, no stdin read (-nostdin)', () => {
      const a = mixArgs({ ...base, control: 'zmq', zmqPort: 45123, added: [mic] });
      expect(graph(a)).toContain(`azmq=bind_address=tcp\\\\://127.0.0.1\\\\:45123,${LIMITER}[mix]`);
      expect(graph(a)).not.toMatch(/0\.0\.0\.0|\*/);
      expect(a).toContain('-nostdin');
    });
    it('stdin: no azmq and no -nostdin (ffmpeg must read its console)', () => {
      const a = mixArgs({ ...base, added: [mic] });
      expect(graph(a)).not.toContain('azmq');
      expect(a).not.toContain('-nostdin');
    });
    it('rejects zmq without a valid port, zmq on android, unknown control', () => {
      expect(() => mixArgs({ ...base, control: 'zmq' })).toThrow();
      expect(() => mixArgs({ ...base, control: 'zmq', zmqPort: 80 })).toThrow();
      expect(() => mixArgs({ ...base, control: 'zmq', zmqPort: 45123.5 })).toThrow();
      expect(() => mixArgs({ ...base, control: 'zmq', zmqPort: 45123, platform: 'android' })).toThrow(/azmq/);
      expect(() => mixArgs({ ...base, control: 'tcp' as never })).toThrow();
    });
  });

  it('refuses anything that is not a validated integer or a known id (no string injection)', () => {
    expect(() => mixArgs({ ...base, unitVolume: 101 })).toThrow();
    expect(() => mixArgs({ ...base, unitVolume: 50.5 })).toThrow();
    expect(() => mixArgs({ ...base, unitVolume: '50;x' as never })).toThrow();
    expect(() => mixArgs({ ...base, headroomMs: -1 })).toThrow();
    expect(() => mixArgs({ ...base, headroomMs: Number.NaN })).toThrow();
    expect(() => mixArgs({ ...base, added: [{ ...mic, initialDelayMs: 1.5 }] })).toThrow();
    expect(() => mixArgs({ ...base, added: [{ ...mic, initialDelayMs: 99999 }] })).toThrow();
    expect(() => mixArgs({ ...base, added: [{ ...mic, volume: -1 }] })).toThrow();
    expect(() => mixArgs({ ...base, added: [{ ...mic, id: 'x,y' as never }] })).toThrow();
    expect(() => mixArgs({ ...base, added: [mic, mic] })).toThrow();
    expect(() => mixArgs({ ...base, platform: 'linux' as never })).toThrow();
    expect(() => mixArgs({ ...base, rtspUser: 'a b', rtspPass: 'Passw0rdPassw0rd' })).toThrow();
    expect(() => mixArgs({ ...base, rtspUser: 'ok', rtspPass: 'p@ss/word' })).toThrow();
    expect(() => mixArgs({ ...base, rtspPort: 0 })).toThrow();
  });
});

describe('command formatting', () => {
  it('delay and volume commands carry digits only', () => {
    expect(delayCommand('deviceMic', 612)).toEqual({ target: 'adelay@deviceMic', command: 'delays', arg: '612' });
    expect(delayCommand('boxInput', 0).arg).toBe('1');
    expect(volumeCommand('boxInput', 75)).toEqual({ target: 'volume@boxInput', command: 'volume', arg: '0.75' });
    expect(volumeCommand('unit', 0).arg).toBe('0.00');
    for (const bad of [-1, 10001, 1.2, Number.NaN, Infinity, '5 5' as never]) expect(() => delayCommand('deviceMic', bad)).toThrow();
    for (const bad of [-1, 101, 1.2, Number.NaN, '1;2' as never]) expect(() => volumeCommand('unit', bad)).toThrow();
    expect(() => delayCommand('camera' as never, 5)).toThrow();
    expect(() => volumeCommand('a b' as never, 5)).toThrow();
  });

  it('stdin form is `c` immediately followed by the line (no newline after c)', () => {
    expect(stdinLine(delayCommand('deviceMic', 612))).toBe('cadelay@deviceMic -1 delays 612\n');
    expect(stdinLine(volumeCommand('unit', 50))).toBe('cvolume@unit -1 volume 0.50\n');
  });

  it('zmq form is `<target> <command> <arg>`', () => {
    expect(zmqMessage(delayCommand('boxInput', 40))).toBe('adelay@boxInput delays 40');
  });
});

describe('monitor demux', () => {
  it('splits interleaved s16le into channels and keeps a partial frame', () => {
    const frames = 5;
    const b = Buffer.alloc(frames * 3 * 2 + 2);
    for (let f = 0; f < frames; f++) {
      b.writeInt16LE(100 + f, f * 6);
      b.writeInt16LE(-200 - f, f * 6 + 2);
      b.writeInt16LE(32767 - f, f * 6 + 4);
    }
    b.writeInt16LE(7, frames * 6);
    const { channels, rest } = demuxMonitor(b, 3);
    expect(channels.map((c) => Array.from(c))).toEqual([
      [100, 101, 102, 103, 104],
      [-200, -201, -202, -203, -204],
      [32767, 32766, 32765, 32764, 32763],
    ]);
    expect(rest.length).toBe(2);
    const next = demuxMonitor(Buffer.concat([rest, Buffer.alloc(4)]), 3);
    expect(next.channels[0]![0]).toBe(7);
  });

  it('rejects a bad channel count', () => {
    expect(() => demuxMonitor(Buffer.alloc(8), 0)).toThrow();
    expect(() => demuxMonitor(Buffer.alloc(8), 1.5)).toThrow();
  });
});

/* ------------------------------------------------------------------ Mixer with a fake process */

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
}

function fakeSpawn(): { spawnFn: (c: string, a: string[]) => ChildProcess; procs: Fake[] } {
  const procs: Fake[] = [];
  const spawnFn = (_c: string, args: string[]): ChildProcess => {
    const f = new EventEmitter() as Fake;
    f.stdin = new PassThrough();
    f.stdout = new PassThrough();
    f.stderr = new PassThrough();
    f.exitCode = null;
    f.signalCode = null;
    f.written = [];
    f.args = args;
    f.stdin.on('data', (d: Buffer) => f.written.push(d.toString()));
    f.exit = (code) => {
      f.exitCode = code;
      f.emit('close', code, null);
    };
    f.kill = () => {
      queueMicrotask(() => f.exit(0));
      return true;
    };
    procs.push(f);
    return f as unknown as ChildProcess;
  };
  return { spawnFn, procs };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
const cfg = { unit: 'camera' as const, unitHasAudio: true, unitVolume: 100, added: [{ id: 'deviceMic' as const, initialDelayMs: 1000, volume: 80 }] };

describe('Mixer', () => {
  it('stdin control: commands are written to the child stdin in the T0 shape', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, spawnFn });
    m.start(cfg);
    expect(procs).toHaveLength(1);
    await m.setDelay('deviceMic', 640);
    await m.setVolume('deviceMic', 80);
    await m.setVolume('unit', 0);
    await tick();
    expect(procs[0]!.written.join('')).toBe('cadelay@deviceMic -1 delays 640\ncvolume@deviceMic -1 volume 0.80\ncvolume@unit -1 volume 0.00\n');
    expect(m.status().commandsSent).toBe(3);
    await m.stop();
  });

  it('zmq control: commands go to the injected sender on the given port; stdin stays unused', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const zmqSend = vi.fn(async () => '0 Success');
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'windows', headroomMs: 1500, zmqPort: 45123, spawnFn, zmqSend });
    m.start(cfg);
    expect(procs[0]!.args).toContain('-nostdin');
    await m.setDelay('deviceMic', 700);
    await m.setVolume('deviceMic', 100);
    expect(zmqSend.mock.calls).toEqual([
      [45123, 'adelay@deviceMic delays 700'],
      [45123, 'volume@deviceMic volume 1.00'],
    ]);
    expect(procs[0]!.written).toEqual([]);
    await m.stop();
  });

  it('a rejected command or invalid value never throws out of the mixer; invalid ones throw before sending', async () => {
    const { spawnFn } = fakeSpawn();
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'windows', headroomMs: 1500, zmqPort: 45123, spawnFn, zmqSend: async () => Promise.reject(new Error('zmq_timeout')) });
    m.start(cfg);
    await m.setDelay('deviceMic', 700);
    expect(m.status().lastCommandError).toBe('zmq_timeout');
    await expect(m.setDelay('deviceMic', 70000)).rejects.toThrow(RangeError);
    await expect(m.setVolume('deviceMic', 101)).rejects.toThrow(RangeError);
    await m.stop();
  });

  it('the monitor carries the child stdout and survives a restart; it drops chunks when nobody reads', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, spawnFn, backoffBaseMs: 1 });
    m.start(cfg);
    const got: Buffer[] = [];
    m.monitor.on('data', (d: Buffer) => got.push(d));
    procs[0]!.stdout.write(Buffer.from([1, 0, 2, 0]));
    await tick();
    expect(Buffer.concat(got)).toEqual(Buffer.from([1, 0, 2, 0]));
    procs[0]!.exit(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(procs).toHaveLength(2);
    procs[1]!.stdout.write(Buffer.from([3, 0]));
    await tick();
    expect(Buffer.concat(got)).toEqual(Buffer.from([1, 0, 2, 0, 3, 0]));
    await m.stop();
  });

  it('a lost source restarts the combiner without it; its return adds it back held out of the mix', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, spawnFn });
    m.start(cfg);
    await m.setVolume('deviceMic', 80); // released after a lock
    m.setSourceAvailable('deviceMic', false);
    await tick();
    expect(procs).toHaveLength(2);
    expect(procs[1]!.args.join(' ')).not.toContain('surau-mic');
    expect(m.status().missing).toEqual(['deviceMic']);
    expect(m.status().channels).toEqual(['unit']);
    m.setSourceAvailable('deviceMic', false); // no change, no restart
    await tick();
    expect(procs).toHaveLength(2);
    m.setSourceAvailable('deviceMic', true);
    await tick();
    expect(procs).toHaveLength(3);
    expect(procs[2]!.args.join(' ')).toContain('volume@deviceMic=volume=0.00');
    expect(m.status().channels).toEqual(['unit', 'deviceMic']);
    expect(procs[2]!.args).not.toContain('-use_wallclock_as_timestamps');
    await m.stop();
  });

  it('switchUnit restarts on the other unit path', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, spawnFn });
    m.start(cfg);
    m.switchUnit('ingest');
    await tick();
    expect(procs).toHaveLength(2);
    expect(procs[1]!.args.join(' ')).toContain('/surau-in');
    expect(m.status().unit).toBe('ingest');
    await m.stop();
  });

  it('keeps the latest delay for the next run', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, spawnFn });
    m.start(cfg);
    await m.setDelay('deviceMic', 777);
    m.switchUnit('ingest');
    await tick();
    expect(procs[1]!.args.join(' ')).toContain('adelay@deviceMic=delays=777:all=1');
    await m.stop();
  });

  it('gives up after too many failed runs and redacts the login from the status', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, rtspUser: 'mixer-1', rtspPass: 'Passw0rdPassw0rd', spawnFn, backoffBaseMs: 1, backoffMaxMs: 1, maxFailures: 3 });
    m.start(cfg);
    for (let n = 0; n < 3; n++) {
      procs[n]!.stderr.write(`rtsp://mixer-1:Passw0rdPassw0rd@127.0.0.1:8554/surau-cam: Server returned 401\n`);
      await tick();
      procs[n]!.exit(1);
      await new Promise((r) => setTimeout(r, 20));
    }
    const s = m.status();
    expect(s.state).toBe('failed');
    expect(JSON.stringify(s)).not.toContain('Passw0rdPassw0rd');
    expect(s.lastError).toContain('***');
    await m.stop();
  });

  it('a bad configuration shows as failed instead of throwing', () => {
    const { spawnFn } = fakeSpawn();
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, spawnFn });
    m.start({ ...cfg, unitVolume: 500 });
    expect(m.status().state).toBe('failed');
  });

  it('stop ends the child and is safe twice', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, spawnFn });
    m.start(cfg);
    await m.stop();
    await m.stop();
    expect(procs[0]!.exitCode).toBe(0);
    expect(m.status().state).toBe('off');
  });
});

/* ------------------------------------------------------------------ azmq wire client against a fake REP peer */

describe('zmqRequest (fake azmq peer)', () => {
  let srv: Server | null = null;
  afterEach(() => {
    srv?.close();
    srv = null;
  });

  function peer(reply: string): Promise<{ port: number; got: () => string }> {
    let received = '';
    return new Promise((resolve) => {
      srv = createServer((s) => {
        let buf = Buffer.alloc(0);
        let stage = 0;
        const g = Buffer.alloc(64);
        g[0] = 0xff;
        g[9] = 0x7f;
        g[10] = 3;
        g.write('NULL', 12, 'latin1');
        s.write(g);
        const frames: Buffer[] = [];
        s.on('data', (d: Buffer) => {
          buf = Buffer.concat([buf, d]);
          for (;;) {
            if (stage === 0) {
              if (buf.length < 64) return;
              buf = buf.subarray(64);
              stage = 1;
            }
            if (buf.length < 2 || buf.length < 2 + buf[1]!) return;
            const flags = buf[0]!;
            const body = Buffer.from(buf.subarray(2, 2 + buf[1]!));
            buf = buf.subarray(2 + buf[1]!);
            if (stage === 1) {
              expect(flags & 0x04).toBe(0x04);
              expect(body.toString('latin1')).toContain('Socket-Type');
              const ready = Buffer.concat([Buffer.from([5]), Buffer.from('READY'), Buffer.from([11]), Buffer.from('Socket-Type'), Buffer.from([0, 0, 0, 3]), Buffer.from('REP')]);
              s.write(Buffer.concat([Buffer.from([0x04, ready.length]), ready]));
              stage = 2;
              continue;
            }
            frames.push(body);
            if ((flags & 0x01) === 0) {
              received = frames[frames.length - 1]!.toString();
              expect(frames[0]!.length).toBe(0); // REQ envelope delimiter
              const r = Buffer.from(reply);
              s.write(Buffer.concat([Buffer.from([0x01, 0]), Buffer.from([0x00, r.length]), r]));
            }
          }
        });
      }).listen(0, '127.0.0.1', () => resolve({ port: (srv!.address() as { port: number }).port, got: () => received }));
    });
  }

  it('sends the message and returns the reply', async () => {
    const p = await peer('0 Success');
    expect(await zmqRequest(p.port, 'adelay@deviceMic delays 640')).toBe('0 Success');
    expect(p.got()).toBe('adelay@deviceMic delays 640');
  });

  it('rejects a non-zero ffmpeg reply status', async () => {
    const p = await peer('-22 Invalid argument');
    await expect(zmqRequest(p.port, 'adelay@deviceMic delays 640')).rejects.toThrow('zmq_reply_-22');
  });

  it('rejects when nothing listens and for a bad port', async () => {
    const p = await peer('0 Success');
    const port = p.port;
    srv?.close();
    await expect(zmqRequest(port, 'x', 500)).rejects.toThrow();
    expect(() => zmqRequest(80, 'x')).toThrow(RangeError);
  });
});

describe('Mixer leveller fallback (a box must never lose the live to the leveller)', () => {
  const hasLift = (args: string[]): boolean => args.join(' ').includes('compand');

  it('the probe is asked once before the first run; a box with both filters runs with the leveller', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const probe = vi.fn(async () => true);
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, spawnFn, levellerProbe: probe, backoffBaseMs: 1 });
    m.start(cfg);
    expect(procs).toHaveLength(0); // not started before the probe answered
    await tick();
    expect(procs).toHaveLength(1);
    expect(hasLift(procs[0]!.args)).toBe(true);
    procs[0]!.exit(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(procs).toHaveLength(2);
    expect(probe).toHaveBeenCalledTimes(1);
    await m.stop();
  });

  it('the probe says a filter is missing: no compand and no alimiter in the args, one warning', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const warn = vi.fn();
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, spawnFn, levellerProbe: async () => false, warn });
    m.start(cfg);
    await tick();
    expect(procs).toHaveLength(1);
    expect(procs[0]!.args.join(' ')).not.toMatch(/compand|alimiter/);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(m.buildArgs().join(' ')).not.toMatch(/compand|alimiter/);
    await m.stop();
  });

  it('a probe that cannot tell or throws still starts the live (with the leveller; the relaunch guards it)', async () => {
    for (const probe of [async () => null, async (): Promise<boolean | null> => Promise.reject(new Error('boom'))]) {
      const { spawnFn, procs } = fakeSpawn();
      const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, spawnFn, levellerProbe: probe });
      m.start(cfg);
      await tick();
      expect(procs).toHaveLength(1);
      expect(hasLift(procs[0]!.args)).toBe(true);
      await m.stop();
    }
  });

  it('"No such filter" on stderr: relaunch once at once without the leveller, and it stays off', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const warn = vi.fn();
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, spawnFn, backoffBaseMs: 60_000, warn });
    m.start(cfg);
    expect(hasLift(procs[0]!.args)).toBe(true);
    procs[0]!.stderr.write("[AVFilterGraph @ 0x1] No such filter: 'compand'\nError initializing complex filters.\n");
    await tick();
    procs[0]!.exit(1);
    await tick();
    expect(procs).toHaveLength(2); // no backoff wait
    expect(procs[1]!.args.join(' ')).not.toMatch(/compand|alimiter/);
    expect(warn).toHaveBeenCalledTimes(1);
    await m.stop();
  });

  it('a "No such filter" for something else (a command target) does not switch the leveller off', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, spawnFn, backoffBaseMs: 1 });
    m.start(cfg);
    procs[0]!.stderr.write("No such filter: 'volume@zzz'\n");
    await tick();
    expect(m.buildArgs().join(' ')).toContain('compand');
    await m.stop();
  });

  it('a restart-triggering call while the probe is pending spawns nothing; the one launch after it is the only spawn', async () => {
    const { spawnFn, procs } = fakeSpawn();
    let release: (v: boolean | null) => void = () => undefined;
    const probe = vi.fn(() => new Promise<boolean | null>((r) => (release = r)));
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, spawnFn, levellerProbe: probe });
    m.start({ ...cfg, added: [{ id: 'deviceMic', initialDelayMs: 1000, volume: 80 }] });
    m.setSourceAvailable('deviceMic', false); // restart path
    m.switchUnit('ingest'); // restart path
    expect(procs).toHaveLength(0);
    await tick(); // the probe is now running and still pending
    expect(procs).toHaveLength(0);
    release(true);
    await tick();
    expect(procs).toHaveLength(1); // exactly one, built from the latest state
    expect(procs[0]!.args.join(' ')).toContain('surau-in');
    expect(procs[0]!.args.join(' ')).not.toContain('surau-mic');
    await m.stop();
    expect(procs[0]!.exitCode).not.toBeNull(); // stop() killed it
    expect(procs).toHaveLength(1);
  });

  it('stop() while the probe is pending: no spawn at all', async () => {
    const { spawnFn, procs } = fakeSpawn();
    let release: (v: boolean | null) => void = () => undefined;
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, spawnFn, levellerProbe: () => new Promise<boolean | null>((r) => (release = r)) });
    m.start(cfg);
    await tick();
    await m.stop();
    release(true);
    await tick();
    expect(procs).toHaveLength(0);
  });

  it('"No such filter" calls onLevellerMissing once; a Mixer built after it (capability answers false) has no leveller and the probe is not run again', async () => {
    const { LevellerCapability } = await import('../src/live/levellerProbe.ts');
    const rawProbe = vi.fn(async () => null as boolean | null);
    const cap = new LevellerCapability(rawProbe);
    const { spawnFn, procs } = fakeSpawn();
    const mk = (): Mixer => new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, spawnFn, backoffBaseMs: 60_000, warn: () => undefined, levellerProbe: () => cap.check('ffmpeg'), onLevellerMissing: () => cap.markMissing('ffmpeg') });
    const m1 = mk();
    m1.start(cfg);
    await tick();
    expect(hasLift(procs[0]!.args)).toBe(true); // inconclusive probe: tried with the leveller
    procs[0]!.stderr.write("No such filter: 'alimiter'\n");
    await tick();
    procs[0]!.exit(1);
    await tick();
    expect(hasLift(procs[1]!.args)).toBe(false);
    await m1.stop();
    expect(rawProbe).toHaveBeenCalledTimes(1);
    const m2 = mk();
    m2.start(cfg);
    await tick();
    expect(hasLift(procs[procs.length - 1]!.args)).toBe(false);
    expect(rawProbe).toHaveBeenCalledTimes(1);
    await m2.stop();
  });

  it('leveller:false in the options skips the probe', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const probe = vi.fn(async () => true);
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, spawnFn, leveller: false, levellerProbe: probe });
    m.start(cfg);
    expect(procs).toHaveLength(1);
    expect(hasLift(procs[0]!.args)).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    await m.stop();
  });
});

describe('Mixer restart (round 2 review fixes)', () => {
  it('announces every launch on the monitor so readers can drop a partial frame', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, spawnFn, backoffBaseMs: 1 });
    let n = 0;
    m.monitor.on('restart', () => n++);
    m.start(cfg);
    expect(n).toBe(1);
    procs[0]!.exit(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(n).toBe(2);
    await m.stop();
  });

  it('picks a new azmq port on every relaunch and sends commands to the current one', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const ports = [31001, 31002];
    const zmqSend = vi.fn(async (_port: number, _msg: string) => '0 Success');
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'windows', headroomMs: 1500, zmqPortFn: () => ports.shift() ?? 31999, spawnFn, zmqSend, backoffBaseMs: 1 });
    m.start(cfg);
    expect(procs[0]!.args.join(' ')).toContain('31001');
    procs[0]!.exit(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(procs[1]!.args.join(' ')).toContain('31002');
    await m.setDelay('deviceMic', 700);
    expect(zmqSend.mock.calls[0]![0]).toBe(31002);
    await m.stop();
  });
});

const FFMPEG = ((): string | null => {
  for (const c of [process.env.MAXCOM_TEST_FFMPEG, 'ffmpeg']) {
    if (c === undefined || c === '') continue;
    try {
      if (spawnSync(c, ['-version'], { windowsHide: true }).status === 0) return c;
    } catch {
      /* try the next */
    }
  }
  return null;
})();

describe.skipIf(FFMPEG === null)('LIFT + LIMITER with the real ffmpeg', () => {
  const run = (src: string, af: string): string => {
    const r = spawnSync(FFMPEG as string, ['-hide_banner', '-nostats', '-f', 'lavfi', '-i', src, '-af', af, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
    return r.stderr;
  };
  const meanOf = (src: string, af: string): number => {
    const err = run(src, af);
    const m = /mean_volume: (-?[\d.]+) dB/.exec(err);
    expect(m, err).not.toBeNull();
    return Number((m as RegExpExecArray)[1]);
  };
  /** The source scaled to the given RMS (dBFS), through `chain`; returns the output mean level. */
  const level = (src: string, rms: number, chain: string): number => meanOf(src, `volume=${rms - meanOf(src, 'volumedetect')}dB,${chain},volumedetect`);
  const SINE = 'sine=frequency=300:duration=4:sample_rate=48000';
  const NOISE = 'anoisesrc=color=white:amplitude=0.5:duration=6:sample_rate=48000:seed=7';
  // speech-like: a 200 Hz carrier with a 3 Hz syllable swell
  const SPEECH = "aevalsrc=exprs='0.4*sin(2*PI*200*t)*(0.55+0.45*sin(2*PI*3*t))':s=48000:d=6";
  const tone = (rms: number, chain: string = LEVELLER): number => level(SINE, rms, chain);
  const noise = (rms: number, chain: string = LEVELLER): number => level(NOISE, rms, chain);
  const speech = (rms: number, chain: string = LEVELLER): number => level(SPEECH, rms, chain);

  it('a quiet -34 dBFS tone is lifted to about -20 (+-2)', () => {
    const out = tone(-34);
    expect(out).toBeGreaterThan(-22.2);
    expect(out).toBeLessThan(-18);
  });
  it('-28 dBFS is lifted to about -19 (+-2)', () => {
    const out = tone(-28);
    expect(out).toBeGreaterThan(-21);
    expect(out).toBeLessThan(-17);
  });
  it('normal level is left alone: -21 stays -21, -15 stays -15, -9 stays -9 (+-1.5)', () => {
    expect(Math.abs(tone(-21) + 21)).toBeLessThan(1.5);
    expect(Math.abs(tone(-15) + 15)).toBeLessThan(1.5);
    expect(Math.abs(tone(-9) + 9)).toBeLessThan(1.5);
  });
  it('room noise is not lifted: -43 dBFS noise rises at most 3 dB, -40 at most 5 dB', () => {
    expect(noise(-43)).toBeLessThanOrEqual(-43 + 3);
    expect(noise(-40)).toBeLessThanOrEqual(-40 + 5);
  });
  it('a -18 dBFS speech-like signal stays -18 (+-2) through the lift, and untouched through the limiter alone (the app-levelled path)', () => {
    expect(Math.abs(speech(-18) + 18)).toBeLessThan(2);
    expect(Math.abs(speech(-18, LIMITER) + 18)).toBeLessThan(0.5);
  });
  it('an app-levelled path (limiter only) leaves -40 dBFS room noise alone', () => {
    expect(Math.abs(noise(-40, LIMITER) + 40)).toBeLessThan(0.5);
  });
  it('the safety limiter holds a full-scale input under about -0.5 dBFS and adds no makeup gain', () => {
    const err = run(SINE, `${LIMITER},volumedetect`);
    const peak = Number((/max_volume: (-?[\d.]+) dB/.exec(err) as RegExpExecArray)[1]);
    expect(peak).toBeLessThanOrEqual(-0.5);
    expect(Math.abs(tone(-30, LIMITER) + 30)).toBeLessThan(0.5);
  });
});

/* ------------------------------------------------------------------ watchdog, kick, log, debug level, held, AAC rendition */

describe('Mixer monitor watchdog and kick', () => {
  const mk = (over: Partial<ConstructorParameters<typeof Mixer>[0]> = {}) => {
    const { spawnFn, procs } = fakeSpawn();
    const clock = { t: 1_000_000 };
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, spawnFn, now: () => clock.t, stallMs: 100, startGraceMs: 100, backoffBaseMs: 600_000, backoffMaxMs: 600_000, ...over });
    return { m, procs, clock };
  };
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('no monitor bytes for stallMs ends the run and starts the next at once (no back-off), counted as a stall', async () => {
    const { m, procs, clock } = mk();
    m.start(cfg);
    clock.t += 150;
    await wait(80);
    expect(procs).toHaveLength(2);
    const s = m.status();
    expect(s.stalls).toBe(1);
    expect(s.lastStall).toEqual({ reason: 'monitor_silent', atMs: 1_000_150 });
    expect(s.restarts).toBe(1);
    expect(s.state).toBe('running');
    await m.stop();
  });

  it('steady monitor bytes never end a run', async () => {
    const { m, procs, clock } = mk();
    m.start(cfg);
    for (let n = 0; n < 8; n++) {
      clock.t += 60;
      procs[0]!.stdout.write(Buffer.from([1, 0]));
      await wait(30);
    }
    expect(procs).toHaveLength(1);
    expect(m.status().stalls).toBe(0);
    await m.stop();
  });

  it('silence inside the start grace does not end the run; after the grace it does', async () => {
    const { m, procs, clock } = mk({ startGraceMs: 1000, stallMs: 100 });
    m.start(cfg);
    clock.t += 900;
    await wait(80);
    expect(procs).toHaveLength(1);
    clock.t += 200;
    await wait(80);
    expect(procs).toHaveLength(2);
    expect(m.status().stalls).toBe(1);
    await m.stop();
  });

  it('a stall is not a failure: many in a row never reach maxFailures', async () => {
    const { m, procs, clock } = mk({ maxFailures: 2, stallBackoffMs: [1, 1, 1] });
    m.start(cfg);
    for (let n = 0; n < 4; n++) {
      clock.t += 150;
      await wait(80);
    }
    expect(procs.length).toBeGreaterThanOrEqual(4);
    expect(m.status().state).toBe('running');
    expect(m.status().stalls).toBeGreaterThanOrEqual(3);
    await m.stop();
  });

  it('B4: the 3rd stall in a row waits 10 s, the 4th 30 s, the 5th and later 60 s; a healthy run (60 s of monitor bytes) resets the streak', async () => {
    const logs: Array<[string, string]> = [];
    const { m, procs, clock } = mk({ stallBackoffMs: [120, 240, 360], healthyRunMs: 1000, log: (k, x) => logs.push([k, x]) });
    m.start(cfg);
    for (let n = 0; n < 2; n++) {
      clock.t += 150;
      await wait(80);
    }
    expect(procs).toHaveLength(3); // stalls 1 and 2 relaunch at once
    clock.t += 150;
    await wait(60);
    expect(procs).toHaveLength(3); // the 3rd stall waits (120 ms here)
    expect(m.status().state).toBe('retrying');
    await wait(120);
    expect(procs).toHaveLength(4);
    expect(logs.some(([k, x]) => k === 'backoff' && x.includes('3 stalls in a row') && x.includes('waits'))).toBe(true);
    clock.t += 150;
    await wait(120);
    expect(procs).toHaveLength(4); // the 4th waits 240 ms
    await wait(200);
    expect(procs).toHaveLength(5);
    // a healthy run: monitor bytes over more than healthyRunMs, then a stall: the streak starts again
    procs[4]!.stdout.write(Buffer.from([1, 0]));
    clock.t += 1500;
    procs[4]!.stdout.write(Buffer.from([1, 0]));
    clock.t += 150;
    await wait(80);
    expect(procs).toHaveLength(6); // streak is 1 again: at once
    await m.stop();
  });

  it('kick relaunches without back-off, counts a stall and keeps the reason', async () => {
    const { m, procs } = mk();
    m.start(cfg);
    m.kick('no_output');
    await wait(20);
    expect(procs).toHaveLength(2);
    expect(m.status().stalls).toBe(1);
    expect(m.status().lastStall?.reason).toBe('no_output');
    await m.stop();
  });

  it('a kick while a kick relaunch is pending does nothing more', async () => {
    const { m, procs } = mk();
    m.start(cfg);
    let kills = 0;
    procs[0]!.kill = () => {
      kills++;
      return true; // the process is slow to die
    };
    m.kick('a');
    m.kick('b');
    expect(kills).toBe(1);
    expect(m.status().stalls).toBe(1);
    procs[0]!.exit(0);
    await wait(20);
    expect(procs).toHaveLength(2);
    expect(m.status().stalls).toBe(1);
    await m.stop();
  });

  it('kick is a no-op before start and after stop', async () => {
    const { m, procs } = mk();
    m.kick('early');
    expect(m.status().stalls).toBe(0);
    m.start(cfg);
    await m.stop();
    m.kick('late');
    await wait(20);
    expect(procs).toHaveLength(1);
    expect(m.status().stalls).toBe(0);
  });

  it('a stop during a stall does not relaunch, and the watchdog timer is gone after stop', async () => {
    const { m, procs, clock } = mk();
    m.start(cfg);
    procs[0]!.kill = () => true;
    m.kick('x');
    const done = m.stop();
    procs[0]!.exit(0);
    await done;
    clock.t += 10_000;
    await wait(80);
    expect(procs).toHaveLength(1);
    expect(m.status().state).toBe('off');
    expect(m.status().stalls).toBe(1);
  });

  it('the watchdog timer is cleared on every exit (an ordinary failed run waits for its back-off, no stall is made)', async () => {
    const { m, procs, clock } = mk({ backoffBaseMs: 600_000 });
    m.start(cfg);
    procs[0]!.exit(1);
    clock.t += 10_000;
    await wait(80);
    expect(procs).toHaveLength(1);
    expect(m.status().stalls).toBe(0);
    await m.stop();
  });
});

describe('Mixer log', () => {
  const PASS = 'Passw0rdPassw0rd';
  const mk = (over: Partial<ConstructorParameters<typeof Mixer>[0]> = {}) => {
    const { spawnFn, procs } = fakeSpawn();
    const lines: Array<[string, string]> = [];
    const clock = { t: 5_000_000 };
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, spawnFn, now: () => clock.t, rtspUser: 'mixer-1', rtspPass: PASS, backoffBaseMs: 1, log: (k, t) => lines.push([k, t]), ...over });
    return { m, procs, lines, clock };
  };
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('a launch line has the run number and the argument list with the login hidden', async () => {
    const { m, lines } = mk();
    m.start(cfg);
    const l = lines.find(([k]) => k === 'launch');
    expect(l?.[1]).toContain('run 1');
    expect(l?.[1]).toContain('-filter_complex');
    expect(l?.[1]).toContain('rtsp://***@127.0.0.1:8554/surau-cam');
    expect(l?.[1]).not.toContain(PASS);
    await m.stop();
  });

  it('every stderr line is logged, the same message over and over is counted not repeated', async () => {
    const { m, procs, lines, clock } = mk();
    m.start(cfg);
    procs[0]!.stderr.write('Non-monotonic DTS in output stream 0:1; previous: 100, current: 90\n');
    await wait(10);
    procs[0]!.stderr.write('Non-monotonic DTS in output stream 0:1; previous: 200, current: 190\n');
    procs[0]!.stderr.write('Non-monotonic DTS in output stream 0:1; previous: 300, current: 290\n');
    procs[0]!.stderr.write('something else\n');
    await wait(10);
    let err = lines.filter(([k]) => k === 'stderr').map(([, t]) => t);
    expect(err).toHaveLength(2);
    expect(err[1]).toBe('something else');
    clock.t += 11_000;
    procs[0]!.stderr.write('Non-monotonic DTS in output stream 0:1; previous: 400, current: 390\n');
    await wait(10);
    err = lines.filter(([k]) => k === 'stderr').map(([, t]) => t);
    expect(err).toHaveLength(3);
    expect(err[2]).toContain('(2 similar lines left out)');
    expect(m.status().stderrTail.length).toBe(5); // the in-memory tail still keeps every line
    await m.stop();
  });

  it('an exit line has the code and the seconds since launch', async () => {
    const { m, procs, lines, clock } = mk();
    m.start(cfg);
    clock.t += 7400;
    procs[0]!.exit(3);
    await wait(10);
    expect(lines.find(([k]) => k === 'exit')?.[1]).toBe('code=3 signal=none after 7 s');
    await m.stop();
  });

  it('a stall writes one block: reason, seconds since launch, monitor bytes, stderr tail; no password or camera address anywhere', async () => {
    const { m, procs, lines, clock } = mk();
    m.start(cfg);
    procs[0]!.stdout.write(Buffer.alloc(64));
    procs[0]!.stderr.write(`Error opening rtsp://admin:hunter2@192.0.2.9:554/stream1 using ${PASS}\n`);
    procs[0]!.stderr.write(`rtsp://mixer-1:${PASS}@127.0.0.1:8554/surau-cam: Server returned 401\n`);
    await wait(10);
    clock.t += 42_000;
    m.kick('no_output');
    await wait(10);
    const block = lines.filter(([k]) => k === 'stall');
    expect(block).toHaveLength(1);
    const t = block[0]![1];
    expect(t).toContain('reason=no_output');
    expect(t).toContain('seconds since launch=42');
    expect(t).toContain('monitor bytes in this run=64');
    expect(t).toContain('Server returned 401');
    const all = lines.map(([, x]) => x).join('\n');
    expect(all).not.toContain(PASS);
    expect(all).not.toContain('hunter2');
    expect(all).not.toContain('admin:');
    expect(all).toContain('rtsp://***@');
    await m.stop();
  });

  it('a logger that throws never stops the live', async () => {
    const { m, procs } = mk({
      log: () => {
        throw new Error('disk full');
      },
    });
    m.start(cfg);
    procs[0]!.stderr.write('x\n');
    procs[0]!.exit(1);
    await wait(30);
    expect(procs).toHaveLength(2);
    await m.stop();
  });
});

describe('Mixer debug level', () => {
  it('stderr is split on a bare carriage return too: progress lines never swallow the real message', async () => {
    const { spawnFn, procs } = fakeSpawn();
    const lines: Array<[string, string]> = [];
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, spawnFn, backoffBaseMs: 600_000, log: (k, t) => lines.push([k, t]) });
    m.start(cfg);
    procs[0]!.stderr.write('size=N/A time=00:00:01.00 bitrate=N/A speed=1x    \rsize=N/A time=00:00:02.00 bitrate=N/A speed=1x    \r');
    procs[0]!.stderr.write('Connection to tcp://x timed out\n');
    await new Promise((r) => setTimeout(r, 20));
    const err = lines.filter(([k]) => k === 'stderr').map(([, t]) => t);
    expect(err.at(-1)).toBe('Connection to tcp://x timed out');
    expect(err).toHaveLength(2); // the second progress line is the first again (counted, not repeated)
    await m.stop();
  });

  it('-nostats only while the debug flag is on; the default arguments carry none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mixer-nostats-'));
    const flag = join(dir, 'debug.flag');
    try {
      const { spawnFn, procs } = fakeSpawn();
      const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, spawnFn, backoffBaseMs: 1, debugFlagPath: flag });
      m.start(cfg);
      expect(procs[0]!.args).not.toContain('-nostats');
      writeFileSync(flag, '');
      m.kick('t');
      await new Promise((r) => setTimeout(r, 20));
      expect(procs[1]!.args).toContain('-nostats');
      await m.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ffmpeg runs with -loglevel info while the flag file exists, warning otherwise', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mixer-debug-'));
    const flag = join(dir, 'debug.flag');
    try {
      const { spawnFn, procs } = fakeSpawn();
      const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, spawnFn, backoffBaseMs: 1, debugFlagPath: flag });
      m.start(cfg);
      expect(procs[0]!.args[procs[0]!.args.indexOf('-loglevel') + 1]).toBe('warning');
      writeFileSync(flag, '');
      m.kick('t');
      await new Promise((r) => setTimeout(r, 20));
      expect(procs[1]!.args[procs[1]!.args.indexOf('-loglevel') + 1]).toBe('info');
      rmSync(flag);
      m.kick('t');
      await new Promise((r) => setTimeout(r, 20));
      expect(procs[2]!.args[procs[2]!.args.indexOf('-loglevel') + 1]).toBe('warning');
      await m.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unusable flag path means the normal level', () => {
    const { spawnFn, procs } = fakeSpawn();
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, spawnFn, debugFlagPath: '\u0000bad' });
    m.start(cfg);
    expect(procs[0]!.args[procs[0]!.args.indexOf('-loglevel') + 1]).toBe('warning');
  });
});

describe('Mixer: an explicit held in the start config survives a lost/back cycle', () => {
  const held = (a: string[], id: string): string => [...a.join(' ').matchAll(/volume@(\w+)=volume=(\d\.\d\d)/g)].find((x) => x[1] === id)?.[2] ?? '';
  const start = (added: Array<{ id: 'deviceMic' | 'boxInput'; initialDelayMs: number; volume: number; held?: boolean }>) => {
    const { spawnFn, procs } = fakeSpawn();
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'windows', control: 'stdin', deviceName: 'Line In', headroomMs: 1500, spawnFn });
    m.start({ unit: 'camera', unitHasAudio: true, unitVolume: 100, added });
    return { m, procs };
  };

  it('held:false stays in the mix after the input is lost and comes back; a source without held falls back to the default rule', async () => {
    const { m, procs } = start([
      { id: 'boxInput', initialDelayMs: 900, volume: 60, held: false },
      { id: 'deviceMic', initialDelayMs: 1000, volume: 80 },
    ]);
    expect(held(procs[0]!.args, 'boxInput')).toBe('0.60');
    expect(held(procs[0]!.args, 'deviceMic')).toBe('0.00');
    await m.setVolume('deviceMic', 80); // released after a lock
    m.setSourceAvailable('boxInput', false);
    await tick();
    m.setSourceAvailable('boxInput', true);
    await tick();
    m.setSourceAvailable('deviceMic', false);
    await tick();
    m.setSourceAvailable('deviceMic', true);
    await tick();
    const last = procs[procs.length - 1]!;
    expect(held(last.args, 'boxInput')).toBe('0.60');
    expect(held(last.args, 'deviceMic')).toBe('0.00');
    await m.stop();
  });

  it('held:false also survives switchUnit; a given held:true is restored too', async () => {
    const { m, procs } = start([
      { id: 'boxInput', initialDelayMs: 900, volume: 60, held: false },
      { id: 'deviceMic', initialDelayMs: 1000, volume: 80, held: true },
    ]);
    await m.setVolume('deviceMic', 80); // released after a lock
    m.switchUnit('ingest');
    await tick();
    const last = procs[procs.length - 1]!;
    expect(held(last.args, 'boxInput')).toBe('0.60');
    expect(held(last.args, 'deviceMic')).toBe('0.00');
    await m.stop();
  });
});

describe('mixArgs: AAC rendition for YouTube (ytOutputPath)', () => {
  /** The output groups after the filter graph: each starts at a `-map` that follows a finished output URL. */
  const outputs = (a: string[]): string[][] => {
    const res: string[][] = [];
    let cur: string[] = [];
    for (const x of a.slice(a.indexOf('-filter_complex') + 2)) {
      if (x === '-map' && cur.length > 0 && /^(rtsp:|pipe:)/.test(cur[cur.length - 1] ?? '')) {
        res.push(cur);
        cur = [];
      }
      cur.push(x);
    }
    res.push(cur);
    return res;
  };

  it('not set: the graph ends the mix in [mix] and there are exactly two outputs (picture + Opus, monitor)', () => {
    for (const over of [{}, { added: [mic] }, { added: [mic, box], deviceName: 'Line In' }]) {
      const a = mixArgs({ ...base, ...over });
      expect(graph(a)).not.toContain('mixyt');
      expect(graph(a)).toContain('[mix];');
      expect(a).not.toContain('aac');
      expect(outputs(a)).toHaveLength(2);
      expect(mixArgs({ ...base, ...over, ytOutputPath: undefined })).toEqual(a);
    }
  });

  it('set: one mix split in two; the second output copies the picture and encodes the same mix as AAC on the given path with the same login', () => {
    const a = mixArgs({ ...base, added: [mic], rtspUser: 'mixer-ab12', rtspPass: 'Passw0rdPassw0rd', ytOutputPath: 'surau-yt' });
    const g = graph(a);
    expect(g).toContain(',asplit=2[mix][mixyt];');
    expect(g.match(/amix=/g)).toHaveLength(1);
    expect(g.match(/\[mixyt\]/g)).toHaveLength(1);
    const o = outputs(a);
    expect(o).toHaveLength(3);
    expect(o[0]?.slice(0, 4)).toEqual(['-map', '1:v', '-map', '[mix]']);
    expect(o[0]).toContain('libopus');
    expect(o[1]).toEqual(['-map', '1:v', '-map', '[mixyt]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-f', 'rtsp', '-rtsp_transport', 'tcp', 'rtsp://mixer-ab12:Passw0rdPassw0rd@127.0.0.1:8554/surau-yt']);
    // the monitor stays the last output
    expect(a.slice(-9)).toEqual(['-map', '[mon]', '-c:a', 'pcm_s16le', '-ar', '16000', '-f', 's16le', 'pipe:1']);
  });

  it('set, single sound input: the split is on the one mix too', () => {
    const a = mixArgs({ ...base, ytOutputPath: 'surau-yt' });
    expect(graph(a)).toContain('[c0]aresample=async=1');
    expect(graph(a)).toContain(',asplit=2[mix][mixyt]');
    expect(a.filter((x) => x === 'aac')).toHaveLength(1);
  });

  it('refuses a bad path and the same path as the first output', () => {
    expect(() => mixArgs({ ...base, ytOutputPath: 'Bad Path' })).toThrow(RangeError);
    expect(() => mixArgs({ ...base, ytOutputPath: 'surau' })).toThrow(RangeError);
    expect(() => mixArgs({ ...base, outputPath: 'surau-yt', ytOutputPath: 'surau-yt' })).toThrow(RangeError);
  });

  it('the Mixer passes the start config path on to every run', () => {
    const { spawnFn, procs } = fakeSpawn();
    const m = new Mixer({ ffmpegPath: 'ffmpeg', platform: 'android', headroomMs: 1500, spawnFn });
    m.start({ ...cfg, ytOutputPath: 'surau-yt' });
    expect(procs[0]!.args.join(' ')).toContain('[mixyt]');
    expect(procs[0]!.args.join(' ')).toContain('/surau-yt');
  });
});
