import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIO_INPUT_MSG,
  AudioInputs,
  LIST_ARGS,
  isUsableDeviceName,
  levelArgs,
  parseDshowAudioDevices,
  parseVolumeDetect,
  registerAudioInputRoutes,
} from '../src/live/audioInputs.ts';
import type { Runner } from '../src/live/audioInputs.ts';

/** Recorded on the laptop with the pinned ffmpeg n9.0.2 (2026-11-17); the device names are made neutral. */
const REAL = [
  '[in#0 @ 000001b5f09a1540] "Integrated Camera" (video)',
  '[in#0 @ 000001b5f09a1540]   Alternative name "@device_pnp_\\\\?\\usb#vid_0000&pid_0000&mi_00#6&8bc1e46&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global"',
  '[in#0 @ 000001b5f09a1540] "Microphone Array (Test Digital Microphones)" (audio)',
  '[in#0 @ 000001b5f09a1540]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{37B93871-D02F-4DF7-A579-1876024B5737}"',
  'Error opening input file dummy.',
  '',
].join('\r\n');

/** The older ffmpeg layout (section headers, no type tag) with a localised Windows error line. */
const OLD = [
  '[dshow @ 0000020ab1c3f200] DirectShow video devices (some may be both video and audio devices)',
  '[dshow @ 0000020ab1c3f200]  "Integrated Camera"',
  '[dshow @ 0000020ab1c3f200]     Alternative name "@device_pnp_x"',
  '[dshow @ 0000020ab1c3f200] DirectShow audio devices',
  '[dshow @ 0000020ab1c3f200]  "Mikrofon (USB Audio)"',
  '[dshow @ 0000020ab1c3f200]     Alternative name "@device_cm_{A}\\wave_{B}"',
  'dummy: Ralat I/O (Input/output error)',
].join('\n');

describe('parseDshowAudioDevices', () => {
  it('reads the recorded English output: one audio device, the camera left out, the alternative name kept', () => {
    const d = parseDshowAudioDevices(REAL);
    expect(d).toEqual([
      { name: 'Microphone Array (Test Digital Microphones)', alt: '@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{37B93871-D02F-4DF7-A579-1876024B5737}', usable: true },
    ]);
  });

  it('reads the older section layout and ignores localised noise lines', () => {
    const d = parseDshowAudioDevices(OLD);
    expect(d.map((x) => x.name)).toEqual(['Mikrofon (USB Audio)']);
    expect(d[0]!.alt).toBe('@device_cm_{A}\\wave_{B}');
  });

  it('gives no devices for an empty list or one with video only', () => {
    expect(parseDshowAudioDevices('')).toEqual([]);
    expect(parseDshowAudioDevices('[in#0 @ 1] "Cam" (video)\r\nError opening input file dummy.')).toEqual([]);
  });

  it('keeps names with quotes and parentheses whole, and flags the unsafe ones', () => {
    const text = [
      '[in#0 @ 1] "Mic (Rear) (Line)" (audio)',
      '[in#0 @ 1] "Studio "A" Input" (audio)',
      '[in#0 @ 1] "Line:In=2" (audio)',
      '[in#0 @ 1] "Combo Device" (audio, video)',
      '[in#0 @ 1] "Mic (Rear) (Line)" (audio)',
    ].join('\n');
    const d = parseDshowAudioDevices(text);
    expect(d.map((x) => [x.name, x.usable])).toEqual([
      ['Mic (Rear) (Line)', true],
      ['Studio "A" Input', false],
      ['Line:In=2', false],
      ['Combo Device', true],
    ]);
  });

  it('marks a wrongly decoded name unusable', () => {
    expect(isUsableDeviceName('Mik\uFFFDrofon')).toBe(false);
    expect(isUsableDeviceName('')).toBe(false);
    expect(isUsableDeviceName('Microphone (Intel\u00AE Smart Sound)')).toBe(true);
  });
});

describe('parseVolumeDetect', () => {
  it('reads mean and max, and -inf as the floor', () => {
    expect(parseVolumeDetect('x mean_volume: -42.5 dB\nx max_volume: -10.0 dB')).toEqual({ meanDb: -42.5, maxDb: -10 });
    expect(parseVolumeDetect('mean_volume: -inf dB\nmax_volume: -inf dB')).toEqual({ meanDb: -91, maxDb: -91 });
    expect(parseVolumeDetect('nothing')).toBeNull();
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ai-'));
  dirs.push(d);
  return d;
};

function make(over: Partial<ConstructorParameters<typeof AudioInputs>[0]> = {}, output = REAL) {
  let t = 1_000_000;
  const run = vi.fn<Runner>(async () => ({ output, ok: true }));
  const inputs = new AudioInputs({ ffmpegPath: () => 'C:/tools/ffmpeg.exe', platform: 'windows', now: () => t, run, ...over });
  return { inputs, run, tick: (ms: number) => (t += ms) };
}

describe('AudioInputs view', () => {
  it('Android box: unavailable with the BM reason, ffmpeg never run', async () => {
    const { inputs, run } = make({ platform: 'android' });
    expect(await inputs.view()).toEqual({ platform: 'android', available: false, devices: [], selected: null, reason: 'Kotak Android belum menyokong Mic-in' });
    expect(inputs.boxInput()).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('no ffmpeg: unavailable', async () => {
    const { inputs, run } = make({ ffmpegPath: () => null });
    expect((await inputs.view()).reason).toBe(AUDIO_INPUT_MSG.noTool);
    expect(run).not.toHaveBeenCalled();
  });

  it('Windows with one device: available, that device is the default', async () => {
    const { inputs, run } = make();
    const v = await inputs.view();
    expect(v).toMatchObject({ platform: 'windows', available: true, selected: 'Microphone Array (Test Digital Microphones)' });
    expect(inputs.boxInput()).toEqual({ deviceName: 'Microphone Array (Test Digital Microphones)' });
    expect(run).toHaveBeenCalledWith('C:/tools/ffmpeg.exe', LIST_ARGS, expect.any(Number));
  });

  it('no devices: unavailable with the reason', async () => {
    const { inputs } = make({}, 'Error opening input file dummy.');
    const v = await inputs.view();
    expect(v).toMatchObject({ available: false, reason: 'Tiada input audio pada kotak ini' });
    expect(inputs.boxInput()).toBeNull();
  });

  it('two devices and no choice: no default; a choice must still exist', async () => {
    const two = '[in#0 @ 1] "Mic A" (audio)\n[in#0 @ 1] "Mic B" (audio)\n';
    const { inputs } = make({}, two);
    await inputs.view();
    expect(inputs.boxInput()).toBeNull();
    inputs.setSelected('Mic B');
    expect(inputs.boxInput()).toEqual({ deviceName: 'Mic B' });
    inputs.setSelected('Mic Z');
    expect(inputs.boxInput()).toBeNull();
  });

  it('failed listing: unavailable, list failed reason', async () => {
    const { inputs } = make({ run: async () => ({ output: '', ok: false }) });
    expect((await inputs.view()).reason).toBe(AUDIO_INPUT_MSG.listFailed);
  });
});

describe('caching', () => {
  it('lists once inside the interval, even when forced, and again after it', async () => {
    const { inputs, run, tick } = make({ minRefreshMs: 10_000 });
    await inputs.view();
    await inputs.view(true);
    tick(5_000);
    await inputs.view(true);
    expect(run).toHaveBeenCalledTimes(1);
    tick(6_000);
    await inputs.view(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('an unforced read reuses the list for a minute', async () => {
    const { inputs, run, tick } = make({ minRefreshMs: 1_000 });
    await inputs.view();
    tick(30_000);
    await inputs.view();
    expect(run).toHaveBeenCalledTimes(1);
    tick(31_000);
    await inputs.view();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('concurrent reads share one run', async () => {
    const { inputs, run } = make();
    await Promise.all([inputs.view(), inputs.view(), inputs.view()]);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('arguments are an array, never a shell string', () => {
  it('the list args hold no shell metacharacters in any single element, and a hostile name stays one element', () => {
    for (const a of LIST_ARGS) expect(a).toMatch(/^[A-Za-z0-9_\-:.]+$/);
    const name = 'Mic & calc.exe | "x" $(y) `z`;';
    const args = levelArgs(name);
    expect(args).toContain(`audio=${name}`);
    expect(args.filter((a) => a.includes('calc.exe'))).toHaveLength(1);
    expect(args.join(' ')).toContain('-sample_rate 48000');
  });

  it('an unusable name never reaches ffmpeg through the level probe', async () => {
    const two = '[in#0 @ 1] "Bad & Name:x" (audio)\n';
    const { inputs, run } = make({}, two);
    await inputs.view();
    inputs.setSelected('Bad & Name:x');
    expect(inputs.boxInput()).toBeNull();
    run.mockClear();
    expect((await inputs.level()).level).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('choice storage', () => {
  it('is kept in the data folder and read back by a new instance', async () => {
    const dir = tmp();
    const a = make({ dataDir: dir });
    await a.inputs.view();
    a.inputs.setSelected('Microphone Array (Test Digital Microphones)');
    expect(JSON.parse(readFileSync(join(dir, 'live-audio-input.json'), 'utf8'))).toEqual({ deviceName: 'Microphone Array (Test Digital Microphones)' });
    const b = make({ dataDir: dir });
    expect(b.inputs.selected()).toBe('Microphone Array (Test Digital Microphones)');
    b.inputs.setSelected(null);
    expect(make({ dataDir: dir }).inputs.selected()).toBeNull();
  });
});

describe('level probe', () => {
  const vd = 'x mean_volume: -30.0 dB\nx max_volume: -6.5 dB';
  it('probes once per interval and repeats the last answer', async () => {
    const run = vi.fn<Runner>(async (_f, args) => ({ output: args.includes('volumedetect') ? vd : REAL, ok: true }));
    const { inputs, tick } = make({ run, minLevelMs: 1500 });
    await inputs.view();
    expect((await inputs.level()).level).toEqual({ meanDb: -30, maxDb: -6.5 });
    await inputs.level();
    expect(run.mock.calls.filter((c) => c[1].includes('volumedetect'))).toHaveLength(1);
    tick(2000);
    await inputs.level();
    expect(run.mock.calls.filter((c) => c[1].includes('volumedetect'))).toHaveLength(2);
  });

  it('is not run while a live runs', async () => {
    const { inputs, run } = make({ isLive: () => true });
    await inputs.view();
    run.mockClear();
    expect(await inputs.level()).toEqual({ level: null, reason: AUDIO_INPUT_MSG.liveBusy });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('Mic-in codes (Windows privacy for the LOCAL SERVICE account)', () => {
  const sound = 'x mean_volume: -30.0 dB\nx max_volume: -6.5 dB';
  const silent = 'x mean_volume: -91.0 dB\nx max_volume: -91.0 dB';
  const probe = (answer: string) => vi.fn<Runner>(async (_f, args) => ({ output: args.includes('volumedetect') ? answer : REAL, ok: true }));

  it('no capture device found is the code no_device; a failed list is list_failed; no ffmpeg is no_tool', async () => {
    expect(await make({}, 'Error opening input file dummy.').inputs.view()).toMatchObject({ available: false, code: 'no_device' });
    expect(await make({ run: async () => ({ output: '', ok: false }) }).inputs.view()).toMatchObject({ code: 'list_failed' });
    expect(await make({ ffmpegPath: () => null }).inputs.view()).toMatchObject({ code: 'no_tool' });
    expect((await make().inputs.view()).code).toBeUndefined();
  });

  it('devices found and sound arrives: no code on the level, check says ok', async () => {
    const { inputs } = make({ run: probe(sound) });
    await inputs.view();
    expect(await inputs.level()).toEqual({ level: { meanDb: -30, maxDb: -6.5 } });
    expect(await inputs.check()).toEqual({ devices: 1, code: 'ok' });
  });

  it('devices found but digital silence (-91 dB): silent, with the plugged-in and not-muted text (not the privacy fix)', async () => {
    const { inputs } = make({ run: probe(silent) });
    await inputs.view();
    expect(await inputs.level()).toEqual({ level: { meanDb: -91, maxDb: -91 }, reason: AUDIO_INPUT_MSG.silent, code: 'silent' });
    expect(AUDIO_INPUT_MSG.silent).toContain('disambung');
    expect(AUDIO_INPUT_MSG.silent).toContain('dibisukan');
    expect((await make({ run: probe(silent) }).inputs.check())).toEqual({ devices: 1, code: 'silent' });
  });

  it('only a real access error is access_denied (the Windows sentence)', async () => {
    for (const text of ['Error opening input: Access is denied.', 'Could not run graph 0x80070005', 'dshow: Permission denied']) {
      const denied = vi.fn<Runner>(async (_f, args) => ({ output: args.includes('volumedetect') ? text : REAL, ok: true }));
      const { inputs } = make({ run: denied });
      await inputs.view();
      expect(await inputs.level(), text).toMatchObject({ level: null, code: 'access_denied', reason: AUDIO_INPUT_MSG.accessDenied });
    }
    expect(AUDIO_INPUT_MSG.accessDenied).toBe('Windows tidak membenarkan MAXCOM menggunakan Mic-in. Jalankan Semak MAXCOM.');
  });

  it('a device that cannot be opened for another reason (busy, unplugged, renamed) is device_unavailable, not access_denied', async () => {
    for (const text of ['[dshow @ 1] Could not run graph (sometimes caused by a device already in use, or a format setting)\nError opening input: I/O error', 'Error opening input file audio=Mic.', '']) {
      const busy = vi.fn<Runner>(async (_f, args) => ({ output: args.includes('volumedetect') ? text : REAL, ok: true }));
      const { inputs } = make({ run: busy });
      await inputs.view();
      expect(await inputs.level(), text).toMatchObject({ level: null, code: 'device_unavailable', reason: AUDIO_INPUT_MSG.deviceUnavailable });
      expect(await make({ run: busy }).inputs.check(), text).toEqual({ devices: 1, code: 'device_unavailable' });
    }
  });

  it('the answer is cleared when the problem is gone, and when there is no input any more', async () => {
    let answer = 'Error opening input: Access is denied.';
    let t = 1_000_000;
    const run = vi.fn<Runner>(async (_f, args) => ({ output: args.includes('volumedetect') ? answer : REAL, ok: true }));
    const { inputs } = make({ run, now: () => t });
    await inputs.view();
    expect((await inputs.level()).code).toBe('access_denied');
    answer = sound;
    t += 5000;
    expect(await inputs.level()).toEqual({ level: { meanDb: -30, maxDb: -6.5 } });
    answer = silent;
    t += 5000;
    expect((await inputs.level()).code).toBe('silent');
  });

  it('check is throttled: the last answer stands for 30 s (no new ffmpeg run), then a new one is made', async () => {
    const run = probe(sound);
    const { inputs, tick } = make({ run });
    expect(await inputs.check()).toEqual({ devices: 1, code: 'ok' });
    const calls = run.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    // many asks at once and soon after: all served from the first answer
    tick(5_000);
    await Promise.all([inputs.check(), inputs.check(), inputs.check()]);
    expect(run.mock.calls.length).toBe(calls);
    tick(31_000);
    expect(await inputs.check()).toEqual({ devices: 1, code: 'ok' });
    expect(run.mock.calls.length).toBeGreaterThan(calls);
  });

  it('check: no device is no_device (the doctor compares it with what Windows lists); a live running is untested', async () => {
    expect(await make({}, 'Error opening input file dummy.').inputs.check()).toEqual({ devices: 0, code: 'no_device' });
    expect(await make({ isLive: () => true }).inputs.check()).toEqual({ devices: 1, code: 'untested' });
  });
});

describe('routes', () => {
  async function app(platform: 'windows' | 'android' = 'windows') {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE change_log (surau_id TEXT, at TEXT, actor TEXT, entity TEXT, entity_id TEXT, before_json TEXT, after_json TEXT, device_id TEXT)');
    const { inputs } = make({ platform });
    const f = Fastify();
    f.addHook('onRequest', async (req) => {
      (req as unknown as { tenant: { surauId: string } }).tenant = { surauId: 'local' };
    });
    registerAudioInputRoutes(f, { db, inputs });
    return { f, db, inputs };
  }

  it('GET lists devices; Android answers the reason', async () => {
    const w = await app();
    const r = await w.f.inject({ method: 'GET', url: '/api/live/audio-inputs' });
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json()).toMatchObject({ platform: 'windows', available: true, devices: [{ name: 'Microphone Array (Test Digital Microphones)', usable: true }] });
    const a = await app('android');
    expect((await a.f.inject({ method: 'GET', url: '/api/live/audio-inputs' })).json().reason).toBe('Kotak Android belum menyokong Mic-in');
  });

  it('PUT chooses a listed device and audits it; unknown or unusable names are refused', async () => {
    const w = await app();
    const ok = await w.f.inject({ method: 'PUT', url: '/api/live/audio-input', payload: { deviceName: 'Microphone Array (Test Digital Microphones)' } });
    expect(ok.statusCode).toBe(200);
    expect(w.inputs.selected()).toBe('Microphone Array (Test Digital Microphones)');
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM change_log WHERE entity = ?').get('live-audio-input')).toMatchObject({ n: 1 });
    expect((await w.f.inject({ method: 'PUT', url: '/api/live/audio-input', payload: { deviceName: 'Nope' } })).statusCode).toBe(400);
    expect((await w.f.inject({ method: 'PUT', url: '/api/live/audio-input', payload: { deviceName: 5 } })).statusCode).toBe(400);
    expect((await w.f.inject({ method: 'PUT', url: '/api/live/audio-input', payload: { deviceName: null } })).statusCode).toBe(200);
    expect(w.inputs.selected()).toBeNull();
    const an = await app('android');
    expect((await an.f.inject({ method: 'PUT', url: '/api/live/audio-input', payload: { deviceName: 'x' } })).statusCode).toBe(400);
  });

  it('GET level answers the meter', async () => {
    const w = await app();
    const r = await w.f.inject({ method: 'GET', url: '/api/live/audio-inputs/level' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toHaveProperty('level');
  });
});

describe('test of every capture device (build 5)', () => {
  const TWO = [
    '[in#0 @ 1] "Microphone One" (audio)',
    '[in#0 @ 1] "Microphone Two" (audio)',
    '[in#0 @ 1] "Bad:Name" (audio)',
    'Error opening input file dummy.',
  ].join('\r\n');
  const vdOf = (mean: string, max: string): string => `x mean_volume: ${mean} dB\nx max_volume: ${max} dB`;

  /** A runner that lists TWO and answers each probe by the device named in `audio=<name>`. */
  function runnerFor(answers: Record<string, string | Error>) {
    return vi.fn<Runner>(async (_f, args) => {
      if (!args.includes('volumedetect')) return { output: TWO, ok: true };
      const name = String(args[args.indexOf('-i') + 1]).replace(/^audio=/, '');
      const a = answers[name];
      if (a instanceof Error) throw a;
      return { output: a ?? '', ok: true };
    });
  }
  const probes = (run: ReturnType<typeof runnerFor>) => run.mock.calls.filter((c) => c[1].includes('volumedetect'));

  it('runs one 5 s probe per usable device, one after another (N4)', async () => {
    let open = 0;
    let peak = 0;
    const run = vi.fn<Runner>(async (_f, args) => {
      if (!args.includes('volumedetect')) return { output: TWO, ok: true };
      open++;
      peak = Math.max(peak, open);
      await new Promise((r) => setTimeout(r, 5));
      open--;
      return { output: vdOf('-30.0', '-6.0'), ok: true };
    });
    const { inputs } = make({ run }, TWO);
    const r = await inputs.testAll();
    const p = run.mock.calls.filter((c) => c[1].includes('volumedetect'));
    expect(p).toHaveLength(2); // the unusable name is not probed
    for (const c of p) {
      expect(c[1][c[1].indexOf('-t') + 1]).toBe('5');
      expect(c[2]).toBe(10_000);
    }
    expect(peak).toBe(1);
    expect(r.seconds).toBe(5);
    expect(r.results.map((x) => x.name)).toEqual(['Microphone One', 'Microphone Two']);
    expect(r.results.every((x) => x.code === 'ok')).toBe(true);
    expect(new Date(r.testedAt!).toISOString()).toBe(r.testedAt);
  });

  it('silent at a mean of -70 and under, ok above; the chosen device is marked selected', async () => {
    const run = runnerFor({
      'Microphone One': vdOf('-70.0', '-50.0'),
      'Microphone Two': vdOf('-69.9', '-40.0'),
    });
    const { inputs } = make({ run }, TWO);
    inputs.setSelected('Microphone Two');
    const r = await inputs.testAll();
    expect(r.results).toEqual([
      { name: 'Microphone One', selected: false, meanDb: -70, maxDb: -50, code: 'silent' },
      { name: 'Microphone Two', selected: true, meanDb: -69.9, maxDb: -40, code: 'ok' },
    ]);
    expect(probes(run)).toHaveLength(2);
  });

  it('reads -inf as digital silence at the floor of -90', async () => {
    const run = runnerFor({ 'Microphone One': vdOf('-inf', '-inf'), 'Microphone Two': vdOf('-20.0', '-3.0') });
    const { inputs } = make({ run }, TWO);
    const r = await inputs.testAll();
    expect(r.results[0]).toMatchObject({ meanDb: -90, maxDb: -90, code: 'silent' });
  });

  it('a probe that throws or prints no reading fails that device only', async () => {
    const run = runnerFor({ 'Microphone One': new Error('spawn failed'), 'Microphone Two': 'Could not run graph: Access is denied.' });
    const { inputs } = make({ run }, TWO);
    const r = await inputs.testAll();
    expect(r.results).toEqual([
      { name: 'Microphone One', selected: false, meanDb: null, maxDb: null, code: 'device_unavailable' },
      { name: 'Microphone Two', selected: false, meanDb: null, maxDb: null, code: 'access_denied' },
    ]);
    const ok = runnerFor({ 'Microphone One': new Error('x'), 'Microphone Two': vdOf('-25.0', '-5.0') });
    const again = await make({ run: ok }, TWO).inputs.testAll();
    expect(again.results.map((x) => x.code)).toEqual(['device_unavailable', 'ok']);
  });

  it('is refused while a live runs', async () => {
    const run = runnerFor({});
    const { inputs } = make({ run, isLive: () => true }, TWO);
    await expect(inputs.testAll()).rejects.toMatchObject({ status: 409, code: 'live_busy' });
    expect(probes(run)).toHaveLength(0);
  });

  it('a second call inside 10 s returns the stored result without a probe; a new test after 10 s', async () => {
    const run = runnerFor({ 'Microphone One': vdOf('-30.0', '-6.0'), 'Microphone Two': vdOf('-30.0', '-6.0') });
    const { inputs, tick } = make({ run }, TWO);
    const first = await inputs.testAll();
    expect(probes(run)).toHaveLength(2);
    tick(9_000);
    const second = await inputs.testAll();
    expect(second).toBe(first);
    expect(probes(run)).toHaveLength(2);
    tick(1_500);
    const third = await inputs.testAll();
    expect(third).not.toBe(first);
    expect(probes(run)).toHaveLength(4);
  });

  it('a call while a test runs waits for and returns the same result', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const run = vi.fn<Runner>(async (_f, args) => {
      if (!args.includes('volumedetect')) return { output: TWO, ok: true };
      await gate;
      return { output: vdOf('-30.0', '-6.0'), ok: true };
    });
    const { inputs } = make({ run }, TWO);
    const a = inputs.testAll();
    const b = inputs.testAll();
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(rb).toBe(ra);
    expect(run.mock.calls.filter((c) => c[1].includes('volumedetect'))).toHaveLength(2);
  });

  it('a test started while a level probe runs waits for the probe to end', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let probing = 0;
    let overlap = false;
    let first = true;
    const run = vi.fn<Runner>(async (_f, args) => {
      if (!args.includes('volumedetect')) return { output: TWO, ok: true };
      if (first) {
        first = false;
        probing++;
        await gate;
        probing--;
        return { output: vdOf('-30.0', '-6.0'), ok: true };
      }
      if (probing > 0) overlap = true;
      return { output: vdOf('-30.0', '-6.0'), ok: true };
    });
    const { inputs } = make({ run }, TWO);
    await inputs.view();
    inputs.setSelected('Microphone One');
    const lvl = inputs.level();
    await new Promise((r) => setTimeout(r, 0));
    const test = inputs.testAll();
    await new Promise((r) => setTimeout(r, 0));
    // the test has not probed any device while the level probe holds the input
    expect(run.mock.calls.filter((c) => c[1].includes('volumedetect'))).toHaveLength(1);
    release();
    await lvl;
    const res = await test;
    expect(overlap).toBe(false);
    expect(res.results.length).toBeGreaterThan(0);
  });

  it('S2/Q5: idle() waits for a running level probe and for a test, and never rejects', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const run = vi.fn<Runner>(async (_f, args) => {
      if (!args.includes('volumedetect')) return { output: TWO, ok: true };
      await gate;
      return { output: vdOf('-30.0', '-6.0'), ok: true };
    });
    const { inputs } = make({ run }, TWO);
    await inputs.idle(); // nothing running: resolves at once
    await inputs.view();
    inputs.setSelected('Microphone One');
    const lvl = inputs.level();
    await new Promise((r) => setTimeout(r, 0));
    let idle = false;
    const waiting = inputs.idle().then(() => {
      idle = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(idle).toBe(false);
    release();
    await lvl;
    await waiting;
    expect(idle).toBe(true);
    // a test that is running is waited for too
    const run2 = vi.fn<Runner>(async (_f, args) => {
      if (!args.includes('volumedetect')) return { output: TWO, ok: true };
      await new Promise((r) => setTimeout(r, 20));
      return { output: vdOf('-30.0', '-6.0'), ok: true };
    });
    const b = make({ run: run2 }, TWO).inputs;
    const test = b.testAll();
    await new Promise((r) => setTimeout(r, 0));
    await b.idle();
    expect(b.lastTest().testedAt).not.toBeNull();
    await test;
  });

  it('S2/Q5: a live that starts while the test waited for a probe refuses the test, and no device is probed', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let live = false;
    const run = vi.fn<Runner>(async (_f, args) => {
      if (!args.includes('volumedetect')) return { output: TWO, ok: true };
      await gate;
      return { output: vdOf('-30.0', '-6.0'), ok: true };
    });
    const { inputs } = make({ run, isLive: () => live }, TWO);
    await inputs.view();
    inputs.setSelected('Microphone One');
    const lvl = inputs.level();
    await new Promise((r) => setTimeout(r, 0));
    const test = inputs.testAll();
    const refused = expect(test).rejects.toMatchObject({ status: 409, code: 'live_busy' });
    live = true;
    release();
    await lvl;
    await refused;
    expect(run.mock.calls.filter((c) => c[1].includes('volumedetect'))).toHaveLength(1);
    // the refused test left nothing running
    await inputs.idle();
  });

  it('lastTest is empty before a test and never starts a probe', async () => {
    const run = runnerFor({});
    const { inputs } = make({ run }, TWO);
    expect(inputs.lastTest()).toEqual({ testedAt: null, seconds: 5, results: [] });
    expect(run).not.toHaveBeenCalled();
  });

  it('Android box: an empty result and no ffmpeg run', async () => {
    const run = runnerFor({});
    const { inputs } = make({ run, platform: 'android' }, TWO);
    const r = await inputs.testAll();
    expect(r.results).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('routes: POST tests, GET reads the last result, POST during a live is 409 live_busy', async () => {
    const db = new DatabaseSync(':memory:');
    let live = false;
    const run = runnerFor({ 'Microphone One': vdOf('-30.0', '-6.0'), 'Microphone Two': vdOf('-80.0', '-70.0') });
    const { inputs } = make({ run, isLive: () => live }, TWO);
    const f = Fastify();
    f.addHook('onRequest', async (req) => {
      (req as unknown as { tenant: { surauId: string } }).tenant = { surauId: 'local' };
    });
    registerAudioInputRoutes(f, { db, inputs });
    const empty = await f.inject({ method: 'GET', url: '/api/live/audio-inputs/test' });
    expect(empty.json()).toEqual({ testedAt: null, seconds: 5, results: [] });
    expect(probes(run)).toHaveLength(0);
    const r = await f.inject({ method: 'POST', url: '/api/live/audio-inputs/test' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json().results.map((x: { code: string }) => x.code)).toEqual(['ok', 'silent']);
    const g = await f.inject({ method: 'GET', url: '/api/live/audio-inputs/test' });
    expect(g.json()).toEqual(r.json());
    live = true;
    const busy = await f.inject({ method: 'POST', url: '/api/live/audio-inputs/test' });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ code: 'live_busy' });
  });
});
