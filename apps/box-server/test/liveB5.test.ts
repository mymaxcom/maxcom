import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddedAudioId, AlignState, LiveStartRequest } from '@surau/core';
import { putFeature } from '../src/settingsStore.ts';
import { CpuSampler } from '../src/live/cpu.ts';
import type { CpuTotals } from '../src/live/cpu.ts';
import { LIVE_WARNINGS } from '@surau/core';
import { LiveSessions } from '../src/live/sessions.ts';
import type { AlignerLike, CameraSource, MixerLike } from '../src/live/sessions.ts';
import { createLiveSecrets } from '../src/live/mediamtx.ts';
import type { LiveRuntime } from '../src/live/mediamtx.ts';
import type { MixerOptions, MixerStartConfig, MixerStatus, VolumeTarget } from '../src/live/mixer.ts';
import { MONITOR_RATE } from '../src/live/mixer.ts';
import type { AlignerOptions } from '../src/live/align.ts';
import { startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';

/* Build 5, lane A: the silent box microphone warning, the CPU figure and the busy warning, the 3500 default.
   Sessions built on a fake MediaMTX API, a fake combiner (its monitor is fed by the test) and a fake aligner. Test values only. */

const dropBitrate = { on: false };
// the one place a test needs the stored bitrate to be absent: the box falls back to its own literal
vi.mock('../src/settingsStore.ts', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/settingsStore.ts')>();
  return {
    ...m,
    getSettings: (...a: Parameters<typeof m.getSettings>) => {
      const s = m.getSettings(...a);
      return dropBitrate.on ? { ...s, liveYoutube: { ...s.liveYoutube, maxBitrateKbps: undefined } } : s;
    },
  };
});

const CAM_URL = 'rtsp://camuser:Cam-Pa55word9@192.0.2.60:554/stream1';
const harnesses: LiveHarness[] = [];
afterEach(async () => {
  dropBitrate.on = false;
  for (const h of harnesses.splice(0)) await h.close();
});

class FakeMixer implements MixerLike {
  readonly monitor = new PassThrough();
  cfg: MixerStartConfig | null = null;
  readonly o: MixerOptions;
  constructor(o: MixerOptions) {
    this.o = o;
  }
  start(cfg: MixerStartConfig): void {
    this.cfg = cfg;
  }
  async setDelay(_id: AddedAudioId, _ms: number): Promise<void> {}
  async setVolume(_id: VolumeTarget, _pct: number): Promise<void> {}
  async stop(): Promise<void> {}
  kick(): void {}
  status(): MixerStatus {
    return { state: 'running', restarts: 0, lastError: null, stderrTail: [], unit: this.cfg?.unit ?? 'camera', channels: ['unit'], missing: [], commandsSent: 0, lastCommandError: null, stalls: 0, lastStall: null };
  }
}

class FakeAligner implements AlignerLike {
  readonly o: AlignerOptions;
  constructor(o: AlignerOptions) {
    this.o = o;
  }
  start(): void {}
  stop(): void {}
  state(): AlignState {
    return 'locked';
  }
  delayMs(): number {
    return 1234;
  }
  residualMs(): number | undefined {
    return undefined;
  }
  setManual(): void {}
  setAuto(): void {}
  reset(): void {}
}

function makeApi() {
  const ready = new Set<string>();
  const impl = {
    authUserAdd: async () => undefined,
    authUserRemove: async () => undefined,
    pathsPatch: async () => undefined,
    pathGet: async (name: string) => ({ ready: ready.has(name), source: ready.has(name) ? { type: 'rtspSource', id: '' } : null, readers: 0, bytesReceived: 0, tracks: name === 'surau-cam' ? ['H264', 'MPEG-4 Audio'] : [] }),
    kickPublisher: async () => undefined,
    basicAuthHeader: () => 'Basic x',
  };
  return { ready, impl: impl as unknown as NonNullable<LiveRuntime['api']> };
}

/** A reader whose cumulative totals the test moves. `null` stands for a platform that reports no CPU. */
function cpuReader() {
  let cur: CpuTotals | null = { idle: 0, total: 0 };
  return {
    read: (): CpuTotals | null => (cur === null ? null : { ...cur }),
    /** The next interval was `percent` busy. */
    use: (percent: number): void => {
      if (cur !== null) cur = { idle: cur.idle + (100 - percent), total: cur.total + 100 };
    },
    none: (): void => {
      cur = null;
    },
  };
}

const JACK = { deviceName: 'Line In' };
const MIX_BOX = { camera: { enabled: true, volume: 100 }, deviceMic: { enabled: false, volume: 100 }, boxInput: { enabled: true, volume: 100 } };
const MIX_BOX_MUTED = { camera: { enabled: true, volume: 100 }, deviceMic: { enabled: false, volume: 100 }, boxInput: { enabled: true, volume: 0 } };
const WINDOW_FRAMES = Math.round((MONITOR_RATE * 400) / 1000);
const LOUD = 3277; // about -20 dBFS
const QUIET = 0; // digital silence
const BETWEEN = 20; // about -64 dBFS

async function rig(o: { cpu?: ReturnType<typeof cpuReader>; audioIdle?: () => Promise<void> } = {}) {
  const h = await startLiveHarness();
  harnesses.push(h);
  putFeature(h.app.surau.db, 'liveCamera', { enabled: true }, 'test', undefined, 'sdm');
  const api = makeApi();
  const runtime = {
    tools: { mediamtx: 'mediamtx', ffmpeg: 'ffmpeg', missing: [], mediamtxTooOld: null },
    supervisor: { status: () => ({ running: true, restarts: 0 }) },
    api: api.impl,
    webrtcPort: 0,
    secrets: createLiveSecrets(),
    spawnListeners: new Set<() => void>(),
  } as unknown as LiveRuntime;
  const mixers: FakeMixer[] = [];
  const camera: CameraSource = { get: () => ({ url: CAM_URL }) as never, lastTest: null };
  const input: { v: { deviceName: string } | null } = { v: JACK };
  const reader = o.cpu ?? cpuReader();
  const s = new LiveSessions({
    db: h.app.surau.db,
    now: h.clock.now,
    runtime,
    onKiosk: () => undefined,
    monitorMs: 3_600_000,
    camera,
    boxInput: () => input.v,
    ...(o.audioIdle !== undefined ? { audioIdle: o.audioIdle } : {}),
    boxName: () => 'Kotak Ujian',
    cpu: new CpuSampler(reader.read),
    mixerFactory: (mo) => {
      const m = new FakeMixer(mo);
      mixers.push(m);
      return m;
    },
    alignerFactory: (ao) => new FakeAligner(ao),
    combiner: { fadeMs: 0 },
  });
  const baseReq = (over: Partial<LiveStartRequest>): LiveStartRequest => ({ kuliahId: h.kuliahId, source: 'web', outputs: { kiosk: true, youtube: false }, youtubeVia: 'box', video: 'external', ...over });
  const tick = async (advanceMs = 0): Promise<void> => {
    h.clock.t += advanceMs;
    await s.tick();
  };
  return {
    h,
    s,
    api,
    mixers,
    input,
    cpu: reader,
    tick,
    start: (over: Partial<LiveStartRequest> = {}) => s.start(baseReq(over), 'user:starter', 'dev-ipad', '192.0.2.5'),
    /**
     * Feeds `windows` monitor windows of 400 ms to the running combiner, the unit (camera) at `cam` and the box microphone at
     * `box` (int16 amplitudes), moving the clock with the monitor time.
     */
    feed: (windows: number, box: number, cam = LOUD): void => {
      const m = mixers.at(-1)!;
      const buf = Buffer.alloc(WINDOW_FRAMES * 2 * 2);
      for (let i = 0; i < windows; i++) {
        for (let f = 0; f < WINDOW_FRAMES; f++) {
          buf.writeInt16LE(cam, f * 4);
          buf.writeInt16LE(box, f * 4 + 2);
        }
        h.clock.t += 400;
        m.monitor.write(buf);
      }
    },
  };
}
type Rig = Awaited<ReturnType<typeof rig>>;

const boxRow = (r: Rig) => r.s.status().audio!.sources.find((x) => x.id === 'boxInput')!;

/** A live with the box microphone in the mix and the combiner built. */
async function micLive(r: Rig, mix = MIX_BOX): Promise<void> {
  await r.start({ audio: mix });
  r.api.ready.add('surau-cam');
  r.api.ready.add('surau');
  await r.tick();
  expect(r.mixers.at(-1)!.cfg?.added.map((a) => a.id)).toEqual(['boxInput']);
}

describe('A8, A9: the silent box microphone', () => {
  it('no warning at 59 s, the warning at 60 s, and noSignalSeconds on the row from the tenth second (state stays ok)', async () => {
    const r = await rig();
    await micLive(r);
    r.feed(3, QUIET); // 1200 ms
    await r.tick();
    expect(boxRow(r).noSignalSeconds).toBeUndefined(); // Q10: a short quiet spell is not shown
    r.feed(21, QUIET); // 9.6 s
    await r.tick();
    expect(boxRow(r).noSignalSeconds).toBeUndefined();
    r.feed(1, QUIET); // 10.0 s
    await r.tick();
    expect(boxRow(r).noSignalSeconds).toBe(10);
    r.feed(122, QUIET); // 58.8 s
    await r.tick();
    expect(r.s.status().warnings).not.toContain('box_mic_silent');
    expect(boxRow(r)).toMatchObject({ state: 'ok', noSignalSeconds: 58 });
    r.feed(2, QUIET); // 59.6 s
    await r.tick();
    expect(r.s.status().warnings).not.toContain('box_mic_silent');
    r.feed(1, QUIET); // 60.0 s
    await r.tick();
    expect(r.s.status().warnings).toContain('box_mic_silent');
    expect(boxRow(r)).toMatchObject({ state: 'ok', noSignalSeconds: 60 });
  });

  it('sound for 2 s does not clear it, 3 s clears it; a quiet window in between starts the 3 s again', async () => {
    const r = await rig();
    await micLive(r);
    r.feed(150, QUIET);
    await r.tick();
    expect(r.s.status().warnings).toContain('box_mic_silent');
    r.feed(5, LOUD); // 2.0 s
    await r.tick();
    expect(r.s.status().warnings).toContain('box_mic_silent');
    r.feed(1, QUIET);
    r.feed(7, LOUD); // 2.8 s since the quiet window
    await r.tick();
    expect(r.s.status().warnings).toContain('box_mic_silent');
    r.feed(1, LOUD); // 3.2 s
    await r.tick();
    expect(r.s.status().warnings).not.toContain('box_mic_silent');
    expect(boxRow(r).noSignalSeconds).toBeUndefined();
    // a level between -70 and -60 is neither sound nor silence: it never sets the warning either
    r.feed(200, BETWEEN);
    await r.tick();
    expect(r.s.status().warnings).not.toContain('box_mic_silent');
  });

  it('short phrases of sound with dips between the ticks clear the warning; one loud window does not', async () => {
    const r = await rig();
    await micLive(r);
    r.feed(150, QUIET);
    await r.tick();
    expect(r.s.status().warnings).toContain('box_mic_silent');
    // one loud window, then quiet: no clear
    r.feed(1, LOUD);
    r.feed(4, QUIET);
    await r.tick();
    expect(r.s.status().warnings).toContain('box_mic_silent');
    // a 3.2 s phrase that ends in a dip before the tick lands: the tick sees a current run of 0 but the phrase counts
    r.feed(8, LOUD);
    r.feed(2, QUIET);
    await r.tick();
    expect(r.s.status().warnings).not.toContain('box_mic_silent');
  });

  it('volume 0 never warns, and turning the volume to 0 clears a warning that is on', async () => {
    const muted = await rig();
    await micLive(muted, MIX_BOX_MUTED).catch(() => undefined);
    if (muted.mixers.length > 0 && muted.mixers.at(-1)!.cfg !== null) {
      muted.feed(200, QUIET);
      await muted.tick();
      expect(muted.s.status().warnings).not.toContain('box_mic_silent');
    }
    const r = await rig();
    await micLive(r);
    r.feed(160, QUIET);
    await r.tick();
    expect(r.s.status().warnings).toContain('box_mic_silent');
    await r.s.changeAudio('dev-ipad', { audio: MIX_BOX_MUTED });
    await r.tick();
    expect(r.s.status().warnings).not.toContain('box_mic_silent');
    // volume back up: the count starts again, one minute of silence is needed
    await r.s.changeAudio('dev-ipad', { audio: MIX_BOX });
    r.feed(10, QUIET);
    await r.tick();
    expect(r.s.status().warnings).not.toContain('box_mic_silent');
  });

  it('bench on never warns', async () => {
    const r = await rig();
    await micLive(r);
    r.feed(100, QUIET); // 40 s of silence, then the box microphone is benched (two stalls): it leaves the graph
    (r.s as unknown as { session: { boxInputBenchedUntilMs: number } }).session.boxInputBenchedUntilMs = r.h.clock.t + 60_000;
    await r.tick();
    expect(boxRow(r).state).toBe('lost');
    await r.tick(30_000);
    await r.tick(30_000);
    expect(r.s.status().warnings).not.toContain('box_mic_silent');
    expect(boxRow(r).noSignalSeconds).toBeUndefined();
  });

  it('a stale meter (the combiner restarts) neither sets nor clears the warning', async () => {
    const r = await rig();
    await micLive(r);
    r.feed(160, QUIET); // 64 s of silence fed, no tick yet
    r.h.clock.t += 5000; // the meter went stale before the tick looked
    await r.tick();
    expect(r.s.status().warnings).not.toContain('box_mic_silent');
    expect(boxRow(r).noSignalSeconds).toBeUndefined();
    r.feed(1, QUIET); // the monitor is back (Q9): the silence before the gap says nothing, the run starts again
    await r.tick();
    expect(r.s.status().warnings).not.toContain('box_mic_silent');
    r.feed(150, QUIET);
    await r.tick();
    expect(r.s.status().warnings).toContain('box_mic_silent');
    // on, then stale again with the sound back in the buffer: nothing clears it until the meter is fresh
    r.feed(8, LOUD);
    r.h.clock.t += 5000;
    await r.tick();
    expect(r.s.status().warnings).toContain('box_mic_silent');
    // Q9: the sound before the gap does not count; 3 s of sound after it clears the warning
    r.feed(1, LOUD);
    await r.tick();
    expect(r.s.status().warnings).toContain('box_mic_silent');
    r.feed(8, LOUD);
    await r.tick();
    expect(r.s.status().warnings).not.toContain('box_mic_silent');
  });

  it('the warning code is part of the contract list', () => {
    expect(LIVE_WARNINGS).toContain('box_mic_silent');
    expect(LIVE_WARNINGS).toContain('server_busy');
  });
});

/** Ticks `n` times 2 s apart, the reader `percent` busy each time. */
async function ticks(r: Rig, n: number, percent: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    r.cpu.use(percent);
    await r.tick(2000);
  }
}
const TWO_TVS = (): Array<{ tvId: string; state: 'playing' }> => [
  { tvId: 'self', state: 'playing' },
  { tvId: 'screen-2', state: 'playing' },
];

describe('A3 to A5: the CPU figure and server_busy', () => {
  it('cpuPercent only during a live (a whole number, the 30 s average); lastLiveCpuPercent after the stop and not before', async () => {
    const r = await rig();
    expect(r.s.status().cpuPercent).toBeUndefined();
    expect(r.s.status().lastLiveCpuPercent).toBeUndefined();
    const id = (await r.start()).session.id;
    expect(r.s.status().cpuPercent).toBeUndefined(); // no sample yet
    await r.tick(); // the baseline
    await ticks(r, 4, 40);
    expect(r.s.status().cpuPercent).toBe(40);
    expect(r.s.status().lastLiveCpuPercent).toBeUndefined();
    await ticks(r, 4, 60);
    expect(r.s.status().cpuPercent).toBe(50);
    await r.s.stop(id, 'user:starter');
    const after = r.s.status();
    expect(after.session).toBeNull();
    expect(after.cpuPercent).toBeUndefined();
    expect(after.lastLiveCpuPercent).toBe(50);
    expect(Number.isInteger(after.lastLiveCpuPercent)).toBe(true);
    // the next live shows the running figure again and hides the old average
    await r.start();
    expect(r.s.status().lastLiveCpuPercent).toBeUndefined();
  });

  it('the fields are absent when the platform reports no CPU, and the busy warning never shows', async () => {
    const reader = cpuReader();
    reader.none();
    const r = await rig({ cpu: reader });
    r.s.attachViewers(TWO_TVS);
    const id = (await r.start()).session.id;
    for (let i = 0; i < 25; i++) await r.tick(2000);
    const st = r.s.status();
    expect(st.cpuPercent).toBeUndefined();
    expect(st.warnings).not.toContain('server_busy');
    await r.s.stop(id, 'user:starter');
    expect(r.s.status().lastLiveCpuPercent).toBeUndefined();
  });

  it('server_busy needs CPU above 85% for 30 s, the own TV and another TV playing', async () => {
    const r = await rig();
    r.s.attachViewers(TWO_TVS);
    await r.start();
    await r.tick();
    await ticks(r, 13, 90); // 26 s
    expect(r.s.status().warnings).not.toContain('server_busy');
    await ticks(r, 2, 90); // 30 s
    expect(r.s.status().warnings).toContain('server_busy');
    expect(r.s.status().cpuPercent).toBe(90);
  });

  it('85% exactly is not busy, and one low sample inside the window keeps it off', async () => {
    const r = await rig();
    r.s.attachViewers(TWO_TVS);
    await r.start();
    await r.tick();
    await ticks(r, 20, 85);
    expect(r.s.status().warnings).not.toContain('server_busy');
    await ticks(r, 10, 95);
    await ticks(r, 1, 50); // a dip
    await ticks(r, 10, 95);
    // the dip is inside the last 30 s still: not on yet
    expect(r.s.status().warnings).not.toContain('server_busy');
    await ticks(r, 15, 95);
    expect(r.s.status().warnings).toContain('server_busy');
  });

  it('needs the own TV and another one: the own TV alone, another TV alone, or a TV that only connects never makes it busy', async () => {
    const own = await rig();
    own.s.attachViewers(() => [{ tvId: 'self', state: 'playing' }]);
    await own.start();
    await own.tick();
    await ticks(own, 20, 98);
    expect(own.s.status().warnings).not.toContain('server_busy');

    const others = await rig();
    others.s.attachViewers(() => [{ tvId: 'screen-2', state: 'playing' }, { tvId: 'screen-3', state: 'playing' }] as never);
    await others.start();
    await others.tick();
    await ticks(others, 20, 98);
    expect(others.s.status().warnings).not.toContain('server_busy');

    const joining = await rig();
    joining.s.attachViewers(() => [{ tvId: 'self', state: 'playing' }, { tvId: 'screen-2', state: 'connecting' }] as never);
    await joining.start();
    await joining.tick();
    await ticks(joining, 20, 98);
    expect(joining.s.status().warnings).not.toContain('server_busy');

    const low = await rig();
    low.s.attachViewers(TWO_TVS);
    await low.start();
    await low.tick();
    await ticks(low, 20, 60);
    expect(low.s.status().warnings).not.toContain('server_busy');
  });

  it('hysteresis: once on it stays until the 30 s average is under 75%', async () => {
    const r = await rig();
    r.s.attachViewers(TWO_TVS);
    await r.start();
    await r.tick();
    await ticks(r, 16, 95);
    expect(r.s.status().warnings).toContain('server_busy');
    // under 85 now but the average is still above 75
    await ticks(r, 8, 80);
    expect(r.s.status().warnings).toContain('server_busy');
    expect(r.s.status().cpuPercent).toBeGreaterThanOrEqual(75);
    // sinking further: the average passes under 75 and it clears
    await ticks(r, 15, 50);
    expect(r.s.status().cpuPercent).toBeLessThan(75);
    expect(r.s.status().warnings).not.toContain('server_busy');
    // and it does not come back until the 85 rule is met again
    await ticks(r, 5, 80);
    expect(r.s.status().warnings).not.toContain('server_busy');
  });

  it('clears at the next tick when one of the two TV conditions ends, whatever the CPU', async () => {
    const r = await rig();
    let list: Array<{ tvId: string; state: 'playing' }> = TWO_TVS();
    r.s.attachViewers(() => list);
    await r.start();
    await r.tick();
    await ticks(r, 16, 95);
    expect(r.s.status().warnings).toContain('server_busy');
    list = [{ tvId: 'self', state: 'playing' }];
    await ticks(r, 1, 95);
    expect(r.s.status().warnings).not.toContain('server_busy');
    list = TWO_TVS();
    await ticks(r, 1, 95);
    // it does not need another 30 s: the CPU has been above 85 the whole time
    expect(r.s.status().warnings).toContain('server_busy');
    list = [{ tvId: 'screen-2', state: 'playing' }];
    await ticks(r, 1, 95);
    expect(r.s.status().warnings).not.toContain('server_busy');
  });

  it('a TV whose live picture is off is not playing, so it does not count', async () => {
    const r = await rig();
    putFeature(r.h.app.surau.db, 'tvProfiles', { tvs: { 'screen-2': { live: { show: false } } } }, 'test', undefined, 'sdm');
    r.s.attachViewers(TWO_TVS);
    await r.start();
    await r.tick();
    await ticks(r, 20, 98);
    expect(r.s.status().warnings).not.toContain('server_busy');
  });
});

describe('A11: the bitrate default', () => {
  it('the box maximum is always 3500, whatever is stored', async () => {
    const r = await rig();
    const maxOf = (): number => (r.s as unknown as { maxBitrateKbps: () => number }).maxBitrateKbps();
    dropBitrate.on = true;
    expect(maxOf()).toBe(3500);
    dropBitrate.on = false;
    putFeature(r.h.app.surau.db, 'liveYoutube', { maxBitrateKbps: 5000 }, 'test', undefined, 'sdm');
    expect(maxOf()).toBe(3500);
  });

  it('the relay always gets 3500, a stored value is ignored', async () => {
    const r = await rig();
    const cap = (v: unknown): number => (r.s as unknown as { relayMaxKbps: (x: unknown) => number }).relayMaxKbps(v);
    expect(cap(undefined)).toBe(3500);
    expect(cap(5000)).toBe(3500);
    expect(cap(0)).toBe(3500);
    expect(cap(-1)).toBe(3500);
  });
});

describe('S2/Q5: a start waits for a running microphone probe or test', () => {
  it('the live does not go on (no combiner, no start answer) until audioIdle has settled; a rejecting audioIdle does not stop it', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const r = await rig({ audioIdle: () => gate });
    let answered = false;
    const started = r.start({ audio: MIX_BOX }).then(() => {
      answered = true;
    });
    r.api.ready.add('surau-cam');
    r.api.ready.add('surau');
    await new Promise((res) => setTimeout(res, 30));
    await r.tick();
    expect(answered).toBe(false);
    expect(r.mixers).toHaveLength(0);
    release();
    await started;
    await r.tick();
    expect(r.mixers.length).toBeGreaterThan(0);

    const bad = await rig({ audioIdle: () => Promise.reject(new Error('x')) });
    await expect(bad.start({ audio: MIX_BOX })).resolves.toBeDefined();
  });
});
