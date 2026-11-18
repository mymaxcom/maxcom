import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Mixer, delayCommand, demuxMonitor, mixArgs, monitorChannels, stdinLine, volumeCommand, zmqMessage, zmqRequest } from '../src/live/mixer.ts';
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
      expect(graph(a)).toContain('azmq=bind_address=tcp\\\\://127.0.0.1\\\\:45123[mix]');
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
