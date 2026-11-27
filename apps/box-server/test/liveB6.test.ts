import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddedAudioId, LiveStartRequest } from '@surau/core';
import { LIVE_WARNINGS, SOLO_DEFAULT_DELAY_MS } from '@surau/core';
import { putFeature } from '../src/settingsStore.ts';
import { LiveSessions, parseStartRequest } from '../src/live/sessions.ts';
import type { CameraSource, MixerLike, SoloLike, YoutubeLeg } from '../src/live/sessions.ts';
import type { LowEncoder, Relay, RelayStatus } from '../src/live/relay.ts';
import { createLiveSecrets } from '../src/live/mediamtx.ts';
import type { LiveRuntime } from '../src/live/mediamtx.ts';
import type { MixerOptions, MixerStartConfig, MixerStatus, VolumeTarget } from '../src/live/mixer.ts';
import type { SoloCombinerOptions } from '../src/live/soloCombiner.ts';
import { startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';

/* Build 6, lane S: one sound per live. A microphone goes through the solo path (sound process + remux join), the camera's
   own sound through the existing single-input combiner. Sessions on a fake MediaMTX API and fake combiners. Test values only. */

const CAM_URL = 'rtsp://camuser:Cam-Pa55word9@192.0.2.60:554/stream1';
const harnesses: LiveHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

class FakeMixer implements MixerLike {
  readonly monitor = new PassThrough();
  cfg: MixerStartConfig | null = null;
  readonly o: MixerOptions;
  stopped = false;
  constructor(o: MixerOptions) {
    this.o = o;
  }
  start(cfg: MixerStartConfig): void {
    this.cfg = cfg;
  }
  async setDelay(_id: AddedAudioId, _ms: number): Promise<void> {}
  async setVolume(_id: VolumeTarget, _pct: number): Promise<void> {}
  async stop(): Promise<void> {
    this.stopped = true;
  }
  kick(): void {}
  status(): MixerStatus {
    return { state: 'running', restarts: 0, lastError: null, stderrTail: [], unit: this.cfg?.unit ?? 'camera', channels: ['unit'], missing: [], commandsSent: 0, lastCommandError: null, stalls: 0, lastStall: null };
  }
}

class FakeSolo implements SoloLike {
  readonly monitor = new PassThrough();
  cfg: MixerStartConfig | null = null;
  readonly o: SoloCombinerOptions;
  delays: Array<[AddedAudioId, number]> = [];
  volumes: Array<[VolumeTarget, number]> = [];
  kicks: string[] = [];
  stopped = false;
  dropCount = 0;
  stalls = 0;
  stallReason: string | null = null;
  constructor(o: SoloCombinerOptions) {
    this.o = o;
  }
  start(cfg: MixerStartConfig): void {
    this.cfg = cfg;
  }
  async setDelay(id: AddedAudioId, ms: number): Promise<void> {
    this.delays.push([id, ms]);
  }
  async setVolume(id: VolumeTarget, pct: number): Promise<void> {
    this.volumes.push([id, pct]);
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  kick(reason: string): void {
    this.kicks.push(reason);
  }
  drops(): number {
    return this.dropCount;
  }
  status(): MixerStatus {
    const id = this.cfg?.added[0]?.id;
    return {
      state: 'running',
      restarts: 0,
      lastError: null,
      stderrTail: [],
      unit: this.cfg?.unit ?? 'camera',
      channels: id === undefined ? ['unit'] : ['unit', id],
      missing: [],
      commandsSent: 0,
      lastCommandError: null,
      stalls: this.stalls,
      lastStall: this.stallReason === null ? null : { reason: this.stallReason, atMs: 0 },
    };
  }
}

function makeApi() {
  const ready = new Set<string>();
  const users: Array<{ user: string; permissions: Array<{ action: string; path?: string }> }> = [];
  const camTracks = ['H264', 'MPEG-4 Audio'];
  let bytes = 0;
  // the output paths grow too (a live input), unless the test freezes one (the input paused)
  const frozen = new Set<string>();
  const out = new Map<string, number>();
  const outBytes = (name: string): number => {
    if (name !== 'surau' && name !== 'surau-yt') return 0;
    const n = (out.get(name) ?? 0) + (frozen.has(name) ? 0 : 50_000);
    out.set(name, n);
    return n;
  };
  const impl = {
    authUserAdd: async (u: { user: string; permissions: Array<{ action: string; path?: string }> }) => {
      users.push(u);
    },
    authUserRemove: async () => undefined,
    pathsPatch: async () => undefined,
    // the camera's byte counter grows on every read, so a stall points at the capture device (the camera is fine)
    pathGet: async (name: string) => ({
      ready: ready.has(name),
      source: ready.has(name) ? { type: 'rtspSource', id: '' } : null,
      readers: 0,
      bytesReceived: name === 'surau-cam' ? (bytes += 100_000) : outBytes(name),
      tracks: name === 'surau-cam' ? [...camTracks] : name === 'surau-in' ? ['H264', 'Opus'] : [],
    }),
    kickPublisher: async () => undefined,
    basicAuthHeader: () => 'Basic x',
  };
  return { ready, users, camTracks, frozen, impl: impl as unknown as NonNullable<LiveRuntime['api']> };
}

const JACK = { deviceName: 'Line In' };
const MIX_BOX = { camera: { enabled: true, volume: 100 }, deviceMic: { enabled: false, volume: 100 }, boxInput: { enabled: true, volume: 100 } };
const MIX_CAM = { camera: { enabled: true, volume: 100 }, deviceMic: { enabled: false, volume: 100 }, boxInput: { enabled: false, volume: 100 } };
const MIX_IPAD = { camera: { enabled: true, volume: 100 }, deviceMic: { enabled: true, volume: 80 }, boxInput: { enabled: false, volume: 100 } };

async function rig() {
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
  const solos: FakeSolo[] = [];
  const aligners = vi.fn();
  const camera: CameraSource = { get: () => ({ url: CAM_URL }) as never, lastTest: null };
  const box: { input: { deviceName: string } | null } = { input: JACK };
  const s = new LiveSessions({
    db: h.app.surau.db,
    now: h.clock.now,
    runtime,
    onKiosk: () => undefined,
    monitorMs: 3_600_000,
    camera,
    boxInput: () => box.input,
    boxName: () => 'Kotak Ujian',
    mixerFactory: (mo) => {
      const m = new FakeMixer(mo);
      mixers.push(m);
      return m;
    },
    soloFactory: (so) => {
      const m = new FakeSolo(so);
      solos.push(m);
      return m;
    },
    alignerFactory: (ao) => {
      aligners(ao);
      throw new Error('no aligner on the solo path');
    },
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
    runtime,
    api,
    mixers,
    solos,
    aligners,
    box,
    tick,
    start: (over: Partial<LiveStartRequest> = {}) => s.start(baseReq(over), 'user:starter', 'dev-ipad', '192.0.2.5'),
  };
}
type Rig = Awaited<ReturnType<typeof rig>>;

const sources = (r: Rig) => r.s.status().audio!.sources;

/** A box-pulled live with the camera up and the combiner built. */
async function pulledLive(r: Rig, audio: Record<string, unknown> = MIX_BOX): Promise<void> {
  await r.start({ audio: audio as never });
  r.api.ready.add('surau-cam');
  r.api.ready.add('surau-mic');
  r.api.ready.add('surau');
  await r.tick();
}

describe('build 6: the solo sound path in the sessions', () => {
  it('a box-pulled live with the box microphone builds a SoloCombiner and no aligner; the join delay is the default', async () => {
    const r = await rig();
    await pulledLive(r);
    expect(r.mixers).toHaveLength(0);
    expect(r.solos).toHaveLength(1);
    expect(r.aligners).not.toHaveBeenCalled();
    const solo = r.solos[0]!;
    expect(solo.cfg).toMatchObject({ unit: 'camera', added: [{ id: 'boxInput', initialDelayMs: SOLO_DEFAULT_DELAY_MS, volume: 100 }] });
    expect(solo.o.deviceName).toBe('Line In');
    expect(solo.o.rtspUser).toMatch(/^mix-/);
    const row = sources(r).find((x) => x.id === 'boxInput')!;
    expect(row.align).toEqual({ state: 'manual', delayMs: SOLO_DEFAULT_DELAY_MS });
    // one sound: the camera's own is not in the live
    expect(sources(r).map((x) => x.id)).toEqual(['boxInput']);
    expect(r.s.status().warnings).not.toContain('audio_align_searching');
  });

  it('the camera sound alone builds the single-input Mixer (no added source), audible', async () => {
    const r = await rig();
    await pulledLive(r, MIX_CAM);
    expect(r.solos).toHaveLength(0);
    expect(r.mixers).toHaveLength(1);
    expect(r.mixers[0]!.cfg).toMatchObject({ unit: 'camera', unitHasAudio: true, unitVolume: 100, added: [] });
  });

  it('the iPad microphone of a box-pulled live goes through the solo path from surau-mic', async () => {
    const r = await rig();
    await pulledLive(r, MIX_IPAD);
    expect(r.solos).toHaveLength(1);
    expect(r.solos[0]!.cfg).toMatchObject({ unit: 'camera', added: [{ id: 'deviceMic', volume: 80 }] });
    expect(r.solos[0]!.o.appLevelled).toBe(false);
    expect(sources(r).map((x) => x.id)).toEqual(['deviceMic']);
  });

  it('the box microphone added to a phone stream joins the phone picture (unit ingest)', async () => {
    const r = await rig();
    await r.start({ source: 'android', video: 'phone', youtubeVia: 'device', audio: { camera: { enabled: false, volume: 100 }, deviceMic: { enabled: true, volume: 100 }, boxInput: { enabled: true, volume: 90 } } });
    r.api.ready.add('surau-in');
    r.api.ready.add('surau');
    await r.tick();
    expect(r.solos).toHaveLength(1);
    expect(r.solos[0]!.cfg).toMatchObject({ unit: 'ingest', added: [{ id: 'boxInput', volume: 90 }] });
    expect(r.mixers).toHaveLength(0);
  });

  it('the session user may read and publish the two sound paths', async () => {
    const r = await rig();
    await pulledLive(r);
    const mix = r.api.users.find((u) => u.user.startsWith('mix-'))!;
    expect(mix.permissions).toEqual(expect.arrayContaining([
      { action: 'read', path: 'surau-snd' },
      { action: 'read', path: 'surau-snd-aac' },
      { action: 'publish', path: 'surau-snd' },
      { action: 'publish', path: 'surau-snd-aac' },
    ]));
  });

  it('YouTube on the box: the solo path also publishes the AAC rendition for surau-yt', async () => {
    const r = await rig();
    putFeature(r.h.app.surau.db, 'liveYoutube', { enabled: true }, 'test', undefined, 'sdm');
    await r.start({ audio: MIX_BOX, outputs: { kiosk: true, youtube: true } });
    r.api.ready.add('surau-cam');
    await r.tick();
    expect(r.solos[0]!.cfg?.ytOutputPath).toBe('surau-yt');
  });
});

describe('build 6: Review Focus 4, an old app that sends two sources', () => {
  it('a start request with two enabled sources is accepted and ends as one by the priority rule', async () => {
    const r = await rig();
    const body = { kuliahId: r.h.kuliahId, source: 'web', outputs: { kiosk: true, youtube: false }, youtubeVia: 'box', video: 'external', audio: MIX_BOX };
    const req = parseStartRequest(body);
    await r.s.start(req, 'user:starter', 'dev-ipad', '192.0.2.5');
    r.api.ready.add('surau-cam');
    await r.tick();
    const enabled = sources(r).filter((x) => x.enabled).map((x) => x.id);
    expect(enabled).toEqual(['boxInput']);
    expect(r.solos).toHaveLength(1);
  });

  it('an audio change with two enabled sources is accepted and ends as one', async () => {
    const r = await rig();
    await pulledLive(r, MIX_CAM);
    await r.s.changeAudio('dev-ipad', { audio: MIX_IPAD });
    expect(sources(r).map((x) => x.id)).toEqual(['deviceMic']);
    // the iPad microphone joins once it has been steady for a moment (the camera sound carries the live meanwhile)
    await r.tick();
    await r.tick(4000);
    expect(r.solos).toHaveLength(1);
    expect(r.solos[0]!.cfg?.added.map((a) => a.id)).toEqual(['deviceMic']);
  });
});

describe('build 6: the join delay', () => {
  it('starts at the setting when it is above 0', async () => {
    const r = await rig();
    putFeature(r.h.app.surau.db, 'liveCamera', { avOffsetMs: { boxInput: 300 } }, 'test', undefined, 'sdm');
    await pulledLive(r);
    expect(r.solos[0]!.cfg?.added[0]?.initialDelayMs).toBe(300);
    expect(sources(r)[0]!.align?.delayMs).toBe(300);
  });

  it('avOffsetMs changes the join delay through setDelay (no rebuild); null goes back to the setting or the default', async () => {
    const r = await rig();
    await pulledLive(r);
    await r.s.changeAudio('dev-ipad', { audio: MIX_BOX, avOffsetMs: 650, avOffsetId: 'boxInput' });
    expect(r.solos).toHaveLength(1);
    expect(r.solos[0]!.delays).toEqual([['boxInput', 650]]);
    expect(sources(r)[0]!.align).toEqual({ state: 'manual', delayMs: 650 });
    await r.s.changeAudio('dev-ipad', { audio: MIX_BOX, avOffsetMs: null, avOffsetId: 'boxInput' });
    expect(r.solos[0]!.delays.at(-1)).toEqual(['boxInput', SOLO_DEFAULT_DELAY_MS]);
    expect(sources(r)[0]!.align?.delayMs).toBe(SOLO_DEFAULT_DELAY_MS);
    // an older app without avOffsetId moves the device microphone's offset: the box microphone keeps its delay
    await r.s.changeAudio('dev-ipad', { audio: MIX_BOX, avOffsetMs: 900 });
    expect(r.solos[0]!.delays.at(-1)).toEqual(['boxInput', SOLO_DEFAULT_DELAY_MS]);
    expect(r.solos).toHaveLength(1);
  });

  it('a hand-set delay survives a rebuild of the solo path', async () => {
    const r = await rig();
    await pulledLive(r, MIX_IPAD);
    await r.s.changeAudio('dev-ipad', { audio: MIX_IPAD, avOffsetMs: 1200, avOffsetId: 'deviceMic' });
    expect(r.solos[0]!.delays).toEqual([['deviceMic', 1200]]);
    r.api.ready.delete('surau-cam');
    await r.tick();
    r.api.ready.add('surau-cam');
    await r.tick();
    expect(r.solos).toHaveLength(2);
    expect(r.solos[1]!.cfg?.added[0]?.initialDelayMs).toBe(1200);
  });
});

describe('build 6: Review Focus 2, a volume change mid live', () => {
  it('goes to the sound process as a volume, never a rebuild or a join restart', async () => {
    const r = await rig();
    await pulledLive(r);
    const before = r.solos[0]!;
    await r.s.changeAudio('dev-ipad', { audio: { ...MIX_BOX, boxInput: { enabled: true, volume: 60 } } });
    await r.tick();
    expect(r.solos).toHaveLength(1);
    expect(before.stopped).toBe(false);
    expect(before.delays).toEqual([]);
    expect(before.volumes).toContainEqual(['boxInput', 60]);
    expect(before.volumes.some(([id]) => id === 'unit')).toBe(false);
  });
});

describe('build 6: Review Focus 1, the microphone fails mid live', () => {
  for (const reason of ['monitor_silent', 'sound_exit']) {
    it(`two stalls (${reason}) bench the box microphone: the Mixer is built with the camera sound at 100`, async () => {
      const r = await rig();
      await pulledLive(r);
      const solo = r.solos[0]!;
      solo.stalls = 1;
      solo.stallReason = reason;
      await r.tick(2000);
      solo.stalls = 2;
      await r.tick(2000);
      await r.tick(2000);
      expect(solo.stopped).toBe(true);
      expect(r.mixers).toHaveLength(1);
      expect(r.mixers[0]!.cfg).toMatchObject({ unit: 'camera', unitHasAudio: true, unitVolume: 100, added: [] });
      expect(sources(r).find((x) => x.id === 'boxInput')!.state).toBe('lost');
      expect(r.s.status().warnings).toContain('audio_source_lost');
      // the bench ends: the microphone comes back on its own path
      await r.tick(61_000);
      expect(r.solos).toHaveLength(2);
    });
  }

  it('B2: ONE sound_exit benches the box microphone; one monitor_silent does not', async () => {
    const a = await rig();
    await pulledLive(a);
    a.solos[0]!.stalls = 1;
    a.solos[0]!.stallReason = 'monitor_silent';
    await a.tick(2000);
    await a.tick(2000);
    expect(a.mixers).toHaveLength(0);
    const b = await rig();
    await pulledLive(b);
    b.solos[0]!.stalls = 1;
    b.solos[0]!.stallReason = 'sound_exit';
    await b.tick(2000);
    expect(b.solos[0]!.stopped).toBe(true);
    expect(b.mixers).toHaveLength(1);
    expect(b.mixers[0]!.cfg).toMatchObject({ unitHasAudio: true, unitVolume: 100, added: [] });
  });

  it('B13: a sound_spawn stall never benches the microphone', async () => {
    const r = await rig();
    await pulledLive(r);
    const solo = r.solos[0]!;
    solo.stallReason = 'sound_spawn';
    for (let n = 1; n <= 3; n++) {
      solo.stalls = n;
      await r.tick(2000);
    }
    expect(solo.stopped).toBe(false);
    expect(r.mixers).toHaveLength(0);
  });

  it('B2: the bench grows on repeats within a live: 60 s, 120 s, 240 s, then 300 s', async () => {
    const r = await rig();
    await pulledLive(r);
    const benchFor = async (seconds: number): Promise<void> => {
      const solo = r.solos.at(-1)!;
      solo.stalls = 1;
      solo.stallReason = 'sound_exit';
      const before = r.solos.length;
      await r.tick(2000);
      expect(solo.stopped).toBe(true);
      await r.tick(seconds * 1000 - 2000);
      expect(r.solos).toHaveLength(before);
      await r.tick(3000);
      expect(r.solos).toHaveLength(before + 1);
    };
    await benchFor(60);
    await benchFor(120);
    await benchFor(240);
    await benchFor(300);
    await benchFor(300);
  });

  it('B2: a box microphone that is gone when the bench ends stays benched until it is back', async () => {
    const r = await rig();
    await pulledLive(r);
    r.solos[0]!.stalls = 1;
    r.solos[0]!.stallReason = 'sound_exit';
    await r.tick(2000);
    expect(r.mixers).toHaveLength(1);
    r.box.input = null;
    await r.tick(61_000);
    await r.tick(30_000);
    expect(r.solos).toHaveLength(1);
    expect(sources(r).find((x) => x.id === 'boxInput')!.state).toBe('lost');
    r.box.input = JACK;
    await r.tick(61_000);
    expect(r.solos).toHaveLength(2);
  });

  it('B2: the phone microphone gets the same bench on sound_exit, with the camera sound meanwhile', async () => {
    const r = await rig();
    await pulledLive(r, MIX_IPAD);
    expect(r.solos).toHaveLength(1);
    r.solos[0]!.stalls = 1;
    r.solos[0]!.stallReason = 'sound_exit';
    await r.tick(2000);
    expect(r.solos[0]!.stopped).toBe(true);
    expect(r.mixers).toHaveLength(1);
    expect(r.mixers[0]!.cfg).toMatchObject({ unit: 'camera', unitHasAudio: true, unitVolume: 100, added: [] });
    expect(r.s.status().warnings).toContain('audio_source_lost');
    await r.tick(61_000);
    expect(r.solos).toHaveLength(2);
  });

  it('B11: on the solo path the graph signature leaves the align mode out', async () => {
    const r = await rig();
    await pulledLive(r);
    const sig = (r.s as unknown as { session: { graphSig: string } }).session.graphSig;
    expect(sig).toBe('camera|0|boxInput');
  });

  it('a camera without sound falls back to a silent picture, never a dead output', async () => {
    const r = await rig();
    await pulledLive(r);
    // the camera's tracks hold no sound
    r.api.camTracks.splice(1);
    await r.tick();
    expect(r.solos).toHaveLength(1);
    const s = (r.s as unknown as { session: { boxInputBenchedUntilMs: number } }).session;
    s.boxInputBenchedUntilMs = r.h.clock.t + 60_000;
    await r.tick();
    expect(r.mixers).toHaveLength(1);
    expect(r.mixers[0]!.cfg).toMatchObject({ unit: 'camera', unitHasAudio: false, added: [] });
  });

  it('a kick for no output reaches the solo path (its join restarts)', async () => {
    const r = await rig();
    await pulledLive(r);
    // the output stands still
    r.api.frozen.add('surau');
    const s = (r.s as unknown as { session: { outOkAtMs: number; runStartAtMs: number } }).session;
    s.outOkAtMs = r.h.clock.t - 60_000;
    s.runStartAtMs = r.h.clock.t - 60_000;
    await r.tick();
    expect(r.solos[0]!.kicks).toEqual(['no_output']);
  });
});

describe('build 6: box_mic_drops', () => {
  it('shows while the solo path counts dshow drops, and clears when it stops', async () => {
    const r = await rig();
    await pulledLive(r);
    expect(r.s.status().warnings).not.toContain('box_mic_drops');
    r.solos[0]!.dropCount = 3;
    expect(r.s.status().warnings).toContain('box_mic_drops');
    r.solos[0]!.dropCount = 0;
    expect(r.s.status().warnings).not.toContain('box_mic_drops');
    expect(LIVE_WARNINGS).toContain('box_mic_drops');
  });

  it('never shows on the camera-sound path', async () => {
    const r = await rig();
    await pulledLive(r, MIX_CAM);
    expect(r.s.status().warnings).not.toContain('box_mic_drops');
  });
});

/* Lane W: the quality ladder of the YouTube leg, wired into the session poll. The relay is a stand-in whose readings the test sets. */
class FakeRelay {
  st: RelayStatus = { state: 'running', restarts: 0, lastError: null, bitrateKbps: null, speed: 1, dropFrames: null, behindSeconds: null, quality: 'full', plannedRestarts: 0, stderrTail: [] };
  calls: string[] = [];
  startOpts: Record<string, unknown> | null = null;
  start(o: Record<string, unknown>): void {
    this.startOpts = o;
  }
  status(): RelayStatus {
    return { ...this.st };
  }
  setQuality(q: 'full' | 'low'): void {
    this.calls.push(q);
    this.st.quality = q;
    // a planned restart: the new run has no reading yet
    this.st.behindSeconds = null;
  }
  readPassword(): string {
    return 'relaypass';
  }
  async stop(): Promise<void> {}
}

const YT: YoutubeLeg = {
  signedIn: () => true,
  createBroadcastFor: async () => ({ broadcastId: 'bc1', watchUrl: 'https://youtu.be/bc1', key: 'abcd-efgh-ijkl-mnop-qrst' }),
  complete: async () => undefined,
  status: () => ({ signedIn: true, channelTitle: 'Surau', broadcastId: 'bc1', state: 'created', health: null, watchUrl: null, lastError: null }),
};

async function ladderRig(probe: (p: string) => Promise<LowEncoder | null>, autoQuality?: boolean, relayVideo: 'copy' | 'reencode' = 'copy') {
  const relays: FakeRelay[] = [];
  const r = await rig();
  const logged: Array<{ kind: string; fields: Record<string, unknown> | undefined }> = [];
  const liveLog = { event: (kind: string, fields?: Record<string, unknown>) => void logged.push({ kind, fields }), line: () => undefined, setSecrets: () => undefined };
  // the rig has no data folder and no YouTube leg until they are given: the relay needs both
  const s = new LiveSessions({
    db: r.h.app.surau.db,
    now: r.h.clock.now,
    runtime: r.runtime,
    onKiosk: () => undefined,
    monitorMs: 3_600_000,
    camera: { get: () => ({ url: CAM_URL }) as never, lastTest: null },
    boxInput: () => JACK,
    youtube: YT,
    youtubeGraceMs: 0,
    dataDir: r.h.dataDir,
    lowEncoderProbe: probe,
    encoderProbe: async () => true,
    liveLog,
    relayFactory: () => {
      const f = new FakeRelay();
      relays.push(f);
      return f as unknown as Relay;
    },
    mixerFactory: (mo) => new FakeMixer(mo),
    soloFactory: (so) => new FakeSolo(so),
    combiner: { fadeMs: 0 },
  });
  putFeature(r.h.app.surau.db, 'liveYoutube', { enabled: true, relayVideo, ...(autoQuality === undefined ? {} : { autoQuality }) }, 'test', undefined, 'sdm');
  await s.start({ kuliahId: r.h.kuliahId, source: 'web', outputs: { kiosk: true, youtube: true }, youtubeVia: 'box', video: 'external', audio: MIX_CAM as never }, 'user:starter', 'dev-ipad', '192.0.2.5');
  for (let i = 0; i < 200 && relays.length === 0; i++) await new Promise((x) => setTimeout(x, 5));
  r.api.ready.add('surau-cam');
  r.api.ready.add('surau');
  const tick = async (ms = 2000): Promise<void> => {
    r.h.clock.t += ms;
    await s.tick();
  };
  await tick(0);
  // let the probe answer
  await new Promise((x) => setTimeout(x, 5));
  const events = (name: string): Array<Record<string, unknown> | undefined> => logged.filter((e) => e.kind === name).map((e) => e.fields);
  return { r, s, relays, tick, events };
}

describe('build 6 lane W: the quality ladder in the session', () => {
  it('behind more than 6 s for 10 s asks the relay for low once', async () => {
    const { s, relays, tick } = await ladderRig(async () => 'libx264');
    const relay = relays[0]!;
    expect(relay.startOpts).not.toHaveProperty('quality');
    for (let i = 0; i < 8; i++) {
      relay.st.behindSeconds = 8;
      await tick();
    }
    expect(relay.calls).toEqual(['low']);
    expect(relay.startOpts).toMatchObject({ lowEncoder: 'libx264' });
    expect(s.status().warnings).toContain('quality_lowered');
    expect(s.status().relay.quality).toBe('low');
    // the planned restart has no reading: nothing more is asked
    await tick();
    expect(relay.calls).toEqual(['low']);
  });

  it('a box without an encoder (probe null) never calls setQuality, and still shows upload_behind', async () => {
    const { s, relays, tick } = await ladderRig(async () => null);
    const relay = relays[0]!;
    for (let i = 0; i < 10; i++) {
      relay.st.behindSeconds = 9;
      await tick();
    }
    expect(relay.calls).toEqual([]);
    expect(s.status().warnings).toContain('upload_behind');
    expect(s.status().warnings).not.toContain('quality_lowered');
    expect(s.status().relay.behindSeconds).toBe(9);
  });

  it('a probe that throws counts as no encoder', async () => {
    const { relays, tick } = await ladderRig(async () => {
      throw new Error('probe broke');
    });
    const relay = relays[0]!;
    for (let i = 0; i < 10; i++) {
      relay.st.behindSeconds = 9;
      await tick();
    }
    expect(relay.calls).toEqual([]);
  });

  it('autoQuality false disables the ladder, upload_behind still shows', async () => {
    const { s, relays, tick } = await ladderRig(async () => 'libx264', false);
    const relay = relays[0]!;
    for (let i = 0; i < 10; i++) {
      relay.st.behindSeconds = 9;
      await tick();
    }
    expect(relay.calls).toEqual([]);
    expect(s.status().warnings).toContain('upload_behind');
  });

  it('no upload_behind while the relay has no reading (start-up or right after a planned restart)', async () => {
    const { s, relays, tick } = await ladderRig(async () => 'libx264');
    const relay = relays[0]!;
    relay.st.behindSeconds = null;
    await tick();
    expect(s.status().warnings).not.toContain('upload_behind');
    expect(s.status().relay).not.toHaveProperty('behindSeconds');
  });

  it('upload_behind shows from 4 s and clears when the leg catches up', async () => {
    const { s, relays, tick } = await ladderRig(async () => 'libx264');
    const relay = relays[0]!;
    relay.st.behindSeconds = 3.4;
    await tick();
    expect(s.status().warnings).not.toContain('upload_behind');
    relay.st.behindSeconds = 4.2;
    await tick();
    expect(s.status().warnings).toContain('upload_behind');
    expect(s.status().relay.behindSeconds).toBe(4);
    relay.st.behindSeconds = 0.5;
    await tick();
    expect(s.status().warnings).not.toContain('upload_behind');
  });

  it('B4: while the input of the relay does not grow, the lag is not read (no step down, no upload_behind)', async () => {
    const { r, s, relays, tick } = await ladderRig(async () => 'libx264');
    const relay = relays[0]!;
    const path = (relay.startOpts as { audio?: string }).audio === 'copy' ? 'surau-yt' : 'surau';
    r.api.frozen.add(path);
    for (let i = 0; i < 10; i++) {
      relay.st.behindSeconds = 9;
      await tick();
    }
    expect(relay.calls).toEqual([]);
    expect(s.status().warnings).not.toContain('upload_behind');
    // the input moves again: the lag is a real one
    r.api.frozen.delete(path);
    await tick();
    expect(s.status().warnings).toContain('upload_behind');
    for (let i = 0; i < 7; i++) await tick();
    expect(relay.calls).toEqual(['low']);
  });

  it('B5: a low step whose relay does not run for 15 s goes back to full for good (relay_quality low_failed)', async () => {
    const { s, relays, tick, events } = await ladderRig(async () => 'libx264');
    const relay = relays[0]!;
    for (let i = 0; i < 8; i++) {
      relay.st.behindSeconds = 8;
      await tick();
    }
    expect(relay.calls).toEqual(['low']);
    relay.st.state = 'retrying';
    await tick(2000);
    for (let i = 0; i < 6; i++) await tick(2000);
    expect(relay.calls).toEqual(['low']);
    await tick(2000);
    await tick(2000);
    expect(relay.calls).toEqual(['low', 'full']);
    expect(events('relay_quality').at(-1)).toMatchObject({ quality: 'full', reason: 'low_failed' });
    // given up: a lag now never asks for low again
    relay.st.state = 'running';
    for (let i = 0; i < 10; i++) {
      relay.st.behindSeconds = 9;
      await tick();
    }
    expect(relay.calls).toEqual(['low', 'full']);
    expect(s.status().warnings).not.toContain('quality_lowered');
  });

  it('B7a: a re-encoding relay has no ladder and is never asked for a quality', async () => {
    const { relays, tick, s } = await ladderRig(async () => 'libx264', undefined, 'reencode');
    const relay = relays[0]!;
    expect(relay.startOpts).toMatchObject({ relayVideo: 'reencode' });
    expect((s as unknown as { session: { ladder: unknown } }).session.ladder).toBeNull();
    for (let i = 0; i < 10; i++) {
      relay.st.behindSeconds = 9;
      await tick();
    }
    expect(relay.calls).toEqual([]);
  });

  it('B8: relay.restarts counts the unplanned restarts only, across a revival of the relay', async () => {
    const { s, relays, tick } = await ladderRig(async () => 'libx264');
    const first = relays[0]!;
    first.st.restarts = 5;
    first.st.plannedRestarts = 2;
    await tick();
    expect(s.status().relay.restarts).toBe(3);
    first.st.state = 'failed';
    first.st.lastError = 'Connection refused';
    await tick();
    await tick(61_000);
    for (let i = 0; i < 200 && relays.length < 2; i++) await new Promise((x) => setTimeout(x, 5));
    expect(relays).toHaveLength(2);
    relays[1]!.st.restarts = 2;
    relays[1]!.st.plannedRestarts = 1;
    expect(s.status().relay.restarts).toBe(4);
  });

  it('B9: a null probe answer is asked again at the next live start, at most once per live', async () => {
    let probes = 0;
    const answers: Array<LowEncoder | null> = [null, 'libx264'];
    const { r, s, relays, tick } = await ladderRig(async () => answers[probes++] ?? null);
    expect(probes).toBe(1);
    await tick();
    expect(probes).toBe(1);
    await s.stop(undefined, 'user:starter', 'stopped');
    await s.settled();
    await s.start({ kuliahId: r.h.kuliahId, source: 'web', outputs: { kiosk: true, youtube: true }, youtubeVia: 'box', video: 'external', audio: MIX_CAM as never }, 'user:starter', 'dev-ipad', '192.0.2.5');
    for (let i = 0; i < 200 && relays.length < 2; i++) await new Promise((x) => setTimeout(x, 5));
    await new Promise((x) => setTimeout(x, 5));
    expect(probes).toBe(2);
    const relay = relays[1]!;
    for (let i = 0; i < 8; i++) {
      relay.st.behindSeconds = 9;
      await tick();
    }
    expect(relay.calls).toEqual(['low']);
  });

  it('the probe runs once and the live starts at full before it answers', async () => {
    let probes = 0;
    let release: (e: LowEncoder | null) => void = () => undefined;
    const gate = new Promise<LowEncoder | null>((res) => {
      release = res;
    });
    const { relays, tick } = await ladderRig(async () => {
      probes++;
      return gate;
    });
    expect(relays).toHaveLength(1);
    expect(relays[0]!.startOpts).not.toHaveProperty('lowEncoder');
    relays[0]!.st.behindSeconds = 9;
    for (let i = 0; i < 8; i++) await tick();
    expect(relays[0]!.calls).toEqual([]);
    release('libx264');
    await new Promise((x) => setTimeout(x, 5));
    expect(probes).toBe(1);
    relays[0]!.st.behindSeconds = 9;
    for (let i = 0; i < 8; i++) await tick();
    expect(relays[0]!.calls).toEqual(['low']);
  });
});
