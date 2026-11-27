import { PassThrough } from 'node:stream';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddedAudioId, AlignState, LiveStartRequest } from '@surau/core';
import { putFeature } from '../src/settingsStore.ts';
import { LiveSessions, parseStartRequest } from '../src/live/sessions.ts';
import type { AlignerLike, CameraSource, MixerLike, YoutubeLeg } from '../src/live/sessions.ts';
import { registerLiveRoutes } from '../src/live/routes.ts';
import { createLiveSecrets } from '../src/live/mediamtx.ts';
import type { LiveRuntime } from '../src/live/mediamtx.ts';
import { mixArgs } from '../src/live/mixer.ts';
import { soundArgs } from '../src/live/soloCombiner.ts';
import type { MixerOptions, MixerStartConfig, MixerStatus, VolumeTarget } from '../src/live/mixer.ts';
import { AudioInputs, parseDshowAudioDevices } from '../src/live/audioInputs.ts';
import type { AlignerOptions } from '../src/live/align.ts';
import { loginAs } from './authHelpers.ts';
import { startBody, startLiveHarness, changeLogText } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';

/* The box path of the external camera (plan 2026-11-16-live-external-source rev 4, 3.2, 4.6, 4.7, 6): sessions built on a
   fake MediaMTX API, a fake combiner and a fake aligner. The camera login below is a test value, never a real one. */

const CAM_USER = 'camuser';
const CAM_PASS = 'Cam-Pa55word9';
const CAM_URL = `rtsp://${CAM_USER}:${CAM_PASS}@10.168.1.60:554/stream1`;

const harnesses: LiveHarness[] = [];
const minis: FastifyInstance[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const m of minis.splice(0)) await m.close();
  for (const h of harnesses.splice(0)) await h.close();
});

class FakeMixer implements MixerLike {
  readonly monitor = new PassThrough();
  cfg: MixerStartConfig | null = null;
  delays: Array<[AddedAudioId, number]> = [];
  volumes: Array<[VolumeTarget, number]> = [];
  stopped = false;
  state: MixerStatus['state'] = 'running';
  stalls = 0;
  kicks: string[] = [];
  readonly o: MixerOptions;
  constructor(o: MixerOptions) {
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
    this.stalls += 1;
  }
  status(): MixerStatus {
    return { state: this.state, restarts: 0, lastError: null, stderrTail: [], unit: this.cfg?.unit ?? 'camera', channels: ['unit'], missing: [], commandsSent: 0, lastCommandError: null, stalls: this.stalls, lastStall: null };
  }
  volumeOf(id: VolumeTarget): number[] {
    return this.volumes.filter(([x]) => x === id).map(([, v]) => v);
  }
  /** Build 6: the solo path's dropped-frame count (this fake stands in for both combiners). */
  drops(): number {
    return 0;
  }
  /** Built through the solo factory (one microphone on its own path), not the mixer. */
  solo = false;
}

class FakeAligner implements AlignerLike {
  started = false;
  stopped = false;
  readonly states = new Map<AddedAudioId, AlignState>();
  readonly o: AlignerOptions;
  constructor(o: AlignerOptions) {
    this.o = o;
  }
  start(): void {
    this.started = true;
    for (const id of this.o.added) this.states.set(id, 'searching');
  }
  stop(): void {
    this.stopped = true;
  }
  state(id: AddedAudioId): AlignState {
    return this.states.get(id) ?? 'searching';
  }
  delayMs(): number {
    return 1234;
  }
  residualMs(): number | undefined {
    return undefined;
  }
  setManual(id: AddedAudioId): void {
    this.states.set(id, 'manual');
  }
  autos: Array<[AddedAudioId, number]> = [];
  setAuto(id: AddedAudioId, delayMs: number): void {
    this.autos.push([id, delayMs]);
    this.states.set(id, 'searching');
  }
  reset(): void {}
  /** The aligner reports a state (a lock, a failure). */
  emit(id: AddedAudioId, st: AlignState): void {
    this.states.set(id, st);
    this.o.onState(id, st);
  }
}

interface FakeApi {
  users: Map<string, { pass: string; permissions: Array<{ action: string; path?: string }>; ips?: string[] }>;
  patches: Array<{ path: string; patch: Record<string, unknown> }>;
  ready: Set<string>;
  tracks: Record<string, string[]>;
  removed: string[];
  failPatch: boolean;
  /** bytesReceived per path (the bitrate the monitor measures). */
  bytes: Record<string, number>;
}

function makeApi(): { api: FakeApi; impl: NonNullable<LiveRuntime['api']> } {
  const api: FakeApi = { users: new Map(), patches: [], ready: new Set(), tracks: {}, removed: [], failPatch: false, bytes: {} };
  const impl = {
    authUserAdd: async (u: { user: string; pass: string; permissions: Array<{ action: string; path?: string }>; ips?: string[] }) => {
      api.users.set(u.user, { pass: u.pass, permissions: u.permissions, ips: u.ips });
    },
    authUserRemove: async (user: string) => {
      api.users.delete(user);
      api.removed.push(user);
    },
    pathsPatch: async (path: string, patch: Record<string, unknown>) => {
      if (api.failPatch) throw new Error('mediamtx api: down');
      api.patches.push({ path, patch });
    },
    pathGet: async (name: string) => ({
      ready: api.ready.has(name),
      source: api.ready.has(name) ? { type: 'rtspSource', id: '' } : null,
      readers: 0,
      bytesReceived: api.bytes[name] ?? 0,
      tracks: api.tracks[name] ?? [],
    }),
    kickPublisher: async () => undefined,
    basicAuthHeader: () => 'Basic x',
  };
  return { api, impl: impl as unknown as NonNullable<LiveRuntime['api']> };
}

const LAST_TEST = { code: 'ok' as const, ok: true, at: '2026-11-05T11:00:00.000Z', hasAudio: true, codecs: ['H264', 'MPEG-4 Audio'], transport: 'tcp' as const };

interface Rig {
  h: LiveHarness;
  s: LiveSessions;
  api: FakeApi;
  runtime: LiveRuntime;
  mixers: FakeMixer[];
  aligners: FakeAligner[];
  kiosk: Array<ReturnType<LiveSessions['kioskLive']>>;
  camera: { record: { url: string } | null; lastTest: typeof LAST_TEST | null };
  tick: (advanceMs?: number) => Promise<void>;
  start: (over?: Partial<LiveStartRequest>, device?: string) => ReturnType<LiveSessions['start']>;
  inputAvailable: { v: { deviceName: string } | null };
}

async function rig(o: { camera?: Partial<Rig['camera']>; combiner?: NonNullable<ConstructorParameters<typeof LiveSessions>[0]['combiner']>; cameraSettings?: Record<string, unknown>; extra?: Partial<ConstructorParameters<typeof LiveSessions>[0]> } = {}): Promise<Rig> {
  const h = await startLiveHarness();
  harnesses.push(h);
  putFeature(h.app.surau.db, 'liveCamera', { enabled: true, ...(o.cameraSettings ?? {}) }, 'test', undefined, 'sdm');
  const { api, impl } = makeApi();
  const runtime = {
    tools: { mediamtx: 'mediamtx', ffmpeg: 'ffmpeg', missing: [], mediamtxTooOld: null },
    supervisor: { status: () => ({ running: true, restarts: 0 }) },
    api: impl,
    webrtcPort: 0,
    secrets: createLiveSecrets(),
    spawnListeners: new Set<() => void>(),
  } as unknown as LiveRuntime;
  const mixers: FakeMixer[] = [];
  const aligners: FakeAligner[] = [];
  const kiosk: Rig['kiosk'] = [];
  const camera: Rig['camera'] = { record: { url: CAM_URL }, lastTest: LAST_TEST, ...(o.camera ?? {}) };
  const source: CameraSource = { get: () => camera.record, get lastTest() { return camera.lastTest; } };
  const inputAvailable: Rig['inputAvailable'] = { v: null };
  const s = new LiveSessions({
    db: h.app.surau.db,
    now: h.clock.now,
    runtime,
    onKiosk: (k) => kiosk.push(k),
    monitorMs: 3_600_000,
    camera: source,
    boxInput: () => inputAvailable.v,
    mixerFactory: (mo) => {
      const m = new FakeMixer(mo);
      mixers.push(m);
      return m;
    },
    // build 6: a microphone goes through the solo path; the same fake records it, marked `solo`
    soloFactory: (so) => {
      const m = new FakeMixer(so);
      m.solo = true;
      mixers.push(m);
      return m;
    },
    alignerFactory: (ao) => {
      const a = new FakeAligner(ao);
      aligners.push(a);
      return a;
    },
    combiner: { fadeMs: 0, ...(o.combiner ?? {}) },
    ...(o.extra ?? {}),
  });
  const baseReq = (over: Partial<LiveStartRequest>): LiveStartRequest => ({
    kuliahId: h.kuliahId,
    source: 'web',
    outputs: { kiosk: true, youtube: false },
    youtubeVia: 'box',
    video: 'external',
    ...over,
  });
  return {
    h,
    s,
    api,
    runtime,
    mixers,
    aligners,
    kiosk,
    camera,
    inputAvailable,
    tick: async (advanceMs = 0) => {
      h.clock.t += advanceMs;
      await s.tick();
    },
    start: (over = {}, device = 'dev-ipad') => s.start(baseReq(over), 'user:starter', device, '10.168.1.5'),
  };
}

const MIX_MIC = { camera: { enabled: true, volume: 100 }, deviceMic: { enabled: true, volume: 80 }, boxInput: { enabled: false, volume: 100 } };

/** The camera and the surau output are up. */
function cameraUp(r: Rig, mic = false): void {
  r.api.ready.add('surau-cam');
  r.api.ready.add('surau');
  if (mic) r.api.ready.add('surau-mic');
  r.api.tracks['surau-cam'] = ['H264', 'MPEG-4 Audio'];
}

describe('start request', () => {
  it('parses video and audio, refuses nonsense, and an old request without them still parses', () => {
    const base = { kuliahId: null, source: 'web', outputs: { kiosk: true, youtube: false }, youtubeVia: 'box' };
    expect(parseStartRequest(base)).not.toHaveProperty('video');
    expect(parseStartRequest({ ...base, video: 'external', audio: MIX_MIC })).toMatchObject({ video: 'external', audio: MIX_MIC });
    expect(() => parseStartRequest({ ...base, video: 'ndi' })).toThrow();
    expect(() => parseStartRequest({ ...base, audio: 'loud' })).toThrow();
    expect(() => parseStartRequest({ ...base, audio: [1] })).toThrow();
  });

  it('refuses Kamera luaran when it is off, not saved, or H.265 on the box path; the phone path takes H.265', async () => {
    const off = await rig({ cameraSettings: { enabled: false } });
    await expect(off.start()).rejects.toMatchObject({ status: 409, code: 'camera_off' });

    const none = await rig({ camera: { record: null } });
    await expect(none.start()).rejects.toMatchObject({ status: 409, code: 'camera_not_set' });

    const h265 = await rig({ camera: { lastTest: { ...LAST_TEST, codecs: ['H265', 'MPEG-4 Audio'] } } });
    await expect(h265.start()).rejects.toMatchObject({ status: 409, code: 'camera_h265' });
    expect(h265.s.current()).toBeNull();
    // the phone decodes H.265 itself: an Android live with this camera is accepted
    const phone = await h265.start({ source: 'android', youtubeVia: 'device' }, 'dev-phone');
    expect(phone.session.source).toBe('android');
    expect(phone.ingest.path).toBe('surau');
  });
});

describe('box-pull topology (iPad or web with Kamera luaran)', () => {
  it('Lane X2: a live that uses the external camera calls the camera-profile hook once, without waiting for it; a live with the phone camera does not', async () => {
    let calls = 0;
    const r = await rig({ extra: { onExternalCameraLive: () => void calls++ } });
    await r.start({ audio: MIX_MIC });
    expect(calls).toBe(1);
    const p = await rig({ extra: { onExternalCameraLive: () => void calls++ } });
    await p.start({ video: 'phone', source: 'android', youtubeVia: 'device' }, 'dev-phone');
    expect(calls).toBe(1);
  });

  it('pulls the camera into surau-cam through the API only, gives the iPad a surau-mic publisher and the combiner its own user', async () => {
    const r = await rig();
    const res = await r.start({ audio: MIX_MIC });
    const id = res.session.id;
    expect(res.ingest.path).toBe('surau-mic');
    expect(res.ingest.srt).toBeNull();
    // the camera address goes to MediaMTX as a JSON string (a patch), with the transport of the last test
    const cam = r.api.patches.find((p) => p.path === 'surau-cam');
    expect(cam?.patch).toMatchObject({ source: CAM_URL, sourceOnDemand: false, rtspTransport: 'tcp' });
    // the iPad may publish its microphone and nothing else
    expect(r.api.users.get(`pub-${id}`)?.permissions).toEqual([{ action: 'publish', path: 'surau-mic' }]);
    // the combiner's ffmpeg: loopback only, reads the three inputs, publishes the mix
    const mix = r.api.users.get(`mix-${id}`);
    expect(mix?.ips).toEqual(['127.0.0.1', '::1']);
    expect(mix?.permissions).toEqual([
      { action: 'read', path: 'surau-cam' },
      { action: 'read', path: 'surau-mic' },
      { action: 'read', path: 'surau-in' },
      { action: 'publish', path: 'surau' },
      // A21: YouTube is on in the settings (the default), so the AAC rendition for the box relay may be published too
      { action: 'publish', path: 'surau-yt' },
      // build 6: the solo sound process publishes the microphone (Opus, AAC) and the join reads it back
      { action: 'read', path: 'surau-snd' },
      { action: 'read', path: 'surau-snd-aac' },
      { action: 'publish', path: 'surau-snd' },
      { action: 'publish', path: 'surau-snd-aac' },
    ]);
    // the login and the combiner password are in the log scrubber
    const scrub = r.runtime.secrets.list();
    expect(scrub).toContain(CAM_PASS);
    expect(scrub).toContain(mix!.pass);
    // the audit holds the video and the mix, never the login
    const audit = changeLogText(r.h.app);
    expect(audit).toContain('\\"video\\":\\"external\\"');
    expect(audit).not.toContain(CAM_PASS);
    expect(audit).not.toContain(CAM_USER);
  });

  it('puts the camera back to publisher, kicks nothing it does not own and removes both users on stop', async () => {
    const r = await rig();
    const id = (await r.start()).session.id;
    cameraUp(r);
    await r.tick();
    expect(r.mixers).toHaveLength(1);
    await r.s.stop(id, 'user:starter');
    expect(r.api.patches.filter((p) => p.path === 'surau-cam').at(-1)?.patch).toEqual({ source: 'publisher' });
    expect(r.api.users.size).toBe(0);
    expect(r.mixers[0]!.stopped).toBe(true);
    expect(r.aligners[0]?.stopped ?? true).toBe(true);
  });

  it('puts the camera, the publisher and the combiner users back after a MediaMTX respawn', async () => {
    const r = await rig();
    const id = (await r.start()).session.id;
    r.api.users.clear();
    r.api.patches.length = 0;
    for (const l of [...r.runtime.spawnListeners]) l();
    for (let i = 0; i < 50 && r.api.users.size < 2; i++) await new Promise((x) => setTimeout(x, 10));
    expect([...r.api.users.keys()].sort()).toEqual([`mix-${id}`, `pub-${id}`].sort());
    expect(r.api.patches.some((p) => p.path === 'surau-cam' && p.patch.source === CAM_URL)).toBe(true);
  });

  it('transport: a fixed choice is used as it is; Automatik starts with the last test and then tries the other', async () => {
    const udp = await rig({ cameraSettings: { transport: 'udp' } });
    await udp.start();
    expect(udp.api.patches.find((p) => p.path === 'surau-cam')?.patch.rtspTransport).toBe('udp');

    const auto = await rig({ combiner: { transportSwitchMs: 15_000 } });
    await auto.start();
    expect(auto.api.patches.filter((p) => p.path === 'surau-cam').map((p) => p.patch.rtspTransport)).toEqual(['tcp']);
    await auto.tick(10_000); // not long enough
    expect(auto.api.patches.filter((p) => p.path === 'surau-cam')).toHaveLength(1);
    await auto.tick(6_000); // 16 s without a picture: the other transport
    expect(auto.api.patches.filter((p) => p.path === 'surau-cam').map((p) => p.patch.rtspTransport)).toEqual(['tcp', 'udp']);
    cameraUp(auto);
    await auto.tick(20_000); // a picture: stays
    expect(auto.api.patches.filter((p) => p.path === 'surau-cam')).toHaveLength(2);
  });
});

describe('combiner and aligner lifecycle', () => {
  it('waits for the picture, then starts the combiner with the unit and the one chosen sound (build 6: the solo path, no aligner)', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    await r.tick();
    expect(r.mixers).toHaveLength(0); // no picture yet
    cameraUp(r, true);
    await r.tick();
    expect(r.mixers).toHaveLength(1);
    const m = r.mixers[0]!;
    expect(m.solo).toBe(true);
    expect(m.o).toMatchObject({ rtspUser: expect.stringMatching(/^mix-/), maxFailures: 1_000_000 });
    expect(m.cfg).toMatchObject({ unit: 'camera' });
    // the iPad microphone is the one sound (the camera's own is off by the one-sound rule), joined with the default delay
    expect(m.cfg?.added).toEqual([{ id: 'deviceMic', initialDelayMs: 400, volume: 80, held: false }]);
    expect(r.aligners).toHaveLength(0);
    // a second poll with nothing changed does not restart anything
    await r.tick();
    expect(r.mixers).toHaveLength(1);
  });

  it('only the camera audio: no aligner and no added source', async () => {
    const r = await rig();
    await r.start();
    cameraUp(r);
    await r.tick();
    expect(r.mixers[0]!.cfg?.added).toEqual([]);
    expect(r.aligners).toHaveLength(0);
  });

  it('the tracks of the pulled camera decide whether it has sound: no audio track means the fallback, the source alone with the fixed offset', async () => {
    const r = await rig({ cameraSettings: { avOffsetMs: { deviceMic: 350, boxInput: 0 } } });
    await r.start({ audio: MIX_MIC });
    r.api.ready.add('surau-cam');
    r.api.ready.add('surau-mic');
    r.api.tracks['surau-cam'] = ['H264']; // video only
    await r.tick();
    const m = r.mixers[0]!;
    expect(m.cfg).toMatchObject({ unitHasAudio: false });
    // build 6: the join delay is the saved offset itself (no headroom on the solo path)
    expect(m.cfg?.added).toEqual([{ id: 'deviceMic', initialDelayMs: 350, volume: 80, held: false }]);
    expect(r.aligners).toHaveLength(0);
    const st = r.s.status();
    expect(st.audio?.sources.find((x) => x.id === 'deviceMic')?.align?.state).toBe('manual');
    expect(st.warnings).toContain('camera_no_audio');
    expect(st.audio?.sources.some((x) => x.id === 'camera')).toBe(false);
  });

  it('waits a little for the iPad microphone, then goes on without it, and adds it back once it is steady (held out, new lock)', async () => {
    const r = await rig({ combiner: { micWaitMs: 8000, micSteadyMs: 3000 } });
    await r.start({ audio: MIX_MIC });
    cameraUp(r); // no microphone yet
    await r.tick();
    expect(r.mixers).toHaveLength(0);
    await r.tick(9000);
    expect(r.mixers).toHaveLength(1);
    expect(r.mixers[0]!.cfg?.added).toEqual([]);
    // build 6: the camera's own sound carries the live meanwhile (it is not the chosen sound, so at 100)
    expect(r.mixers[0]!.cfg).toMatchObject({ unitHasAudio: true, unitVolume: 100 });
    expect(r.s.status().warnings).toContain('audio_source_lost');
    // the microphone arrives: not added until steady
    r.api.ready.add('surau-mic');
    await r.tick(1000);
    expect(r.mixers).toHaveLength(1);
    await r.tick(3500);
    expect(r.mixers).toHaveLength(2);
    expect(r.mixers[0]!.stopped).toBe(true);
    expect(r.mixers[1]!.cfg?.added.map((a) => a.id)).toEqual(['deviceMic']);
    expect(r.s.status().warnings).not.toContain('audio_source_lost');
  });

  it('an added microphone that goes away leaves the graph after 5 s, so a stalled input never stalls the picture', async () => {
    const r = await rig({ combiner: { micLostMs: 5000 } });
    await r.start({ audio: MIX_MIC });
    cameraUp(r, true);
    await r.tick();
    expect(r.mixers[0]!.cfg?.added).toHaveLength(1);
    r.api.ready.delete('surau-mic');
    await r.tick(2000);
    expect(r.mixers).toHaveLength(1);
    await r.tick(5000);
    expect(r.mixers).toHaveLength(2);
    expect(r.mixers[1]!.cfg?.added).toEqual([]);
    expect(r.s.status().audio?.sources.find((x) => x.id === 'deviceMic')?.state).toBe('lost');
  });

  it('the camera lost: the combiner waits (stopped); the camera back: a new combiner with the same sound and delay', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    cameraUp(r, true);
    await r.tick();
    r.api.ready.delete('surau-cam');
    r.api.ready.delete('surau');
    await r.tick(3000);
    expect(r.mixers[0]!.stopped).toBe(true);
    expect(r.mixers).toHaveLength(1);
    r.api.ready.add('surau-cam');
    r.api.ready.add('surau');
    await r.tick(3000);
    expect(r.mixers).toHaveLength(2);
    expect(r.mixers[1]!.solo).toBe(true);
    expect(r.mixers[1]!.cfg?.added[0]).toEqual({ id: 'deviceMic', initialDelayMs: 400, volume: 80, held: false });
    expect(r.aligners).toHaveLength(0);
  });

  it('a change after the rebuild reaches the new combiner only, never the replaced one', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    cameraUp(r, true);
    await r.tick();
    r.api.ready.delete('surau-cam');
    await r.tick(3000);
    r.api.ready.add('surau-cam');
    await r.tick(3000);
    await r.s.changeAudio('dev-ipad', { audio: { ...MIX_MIC, deviceMic: { enabled: true, volume: 40 } } });
    expect(r.mixers[0]!.volumeOf('deviceMic')).toEqual([]);
    expect(r.mixers[1]!.volumeOf('deviceMic')).toEqual([40]);
  });
});

describe('build 6: no hold-out on the solo path (was: hold-out and lock release)', () => {
  it('the chosen microphone plays at once at its volume: never held at 0, whatever the camera does', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    cameraUp(r, true);
    await r.tick();
    const m = r.mixers[0]!;
    expect(m.cfg?.added[0]).toMatchObject({ volume: 80, held: false });
    expect(m.volumeOf('deviceMic')).toEqual([]); // nothing to release
    expect(r.s.status().audio?.sources.find((x) => x.id === 'deviceMic')?.align).toEqual({ state: 'manual', delayMs: 400 });
    expect(r.s.status().warnings).not.toContain('audio_align_searching');
  });

  it('a volume change is one command, never a fade of steps', async () => {
    const r = await rig({ combiner: { fadeMs: 60, fadeSteps: 4 } });
    await r.start({ audio: MIX_MIC });
    cameraUp(r, true);
    await r.tick();
    await r.s.changeAudio('dev-ipad', { audio: { ...MIX_MIC, deviceMic: { enabled: true, volume: 30 } } });
    await r.s.changeAudio('dev-ipad', { audio: { ...MIX_MIC, deviceMic: { enabled: true, volume: 60 } } });
    await new Promise((x) => setTimeout(x, 100));
    expect(r.mixers[0]!.volumeOf('deviceMic')).toEqual([30, 60]);
    expect(r.mixers).toHaveLength(1);
  });

  it('the camera volume at 0 with the microphone chosen: the microphone is the sound, the camera is not in the live', async () => {
    const r = await rig();
    await r.start({ audio: { ...MIX_MIC, camera: { enabled: true, volume: 0 } } });
    cameraUp(r, true);
    await r.tick();
    const m = r.mixers[0]!;
    expect(m.solo).toBe(true);
    expect(m.cfg?.added.map((a) => a.id)).toEqual(['deviceMic']);
    expect(r.s.status().audio?.sources.map((x) => x.id)).toEqual(['deviceMic']);
    expect(m.volumeOf('unit')).toEqual([]);
  });
});

describe('POST /api/live/audio', () => {
  async function mini(r: Rig): Promise<FastifyInstance> {
    const app = Fastify();
    app.addHook('onRequest', async (req) => {
      const dev = req.headers['x-device'];
      (req as unknown as { auth: unknown }).auth = typeof dev === 'string' ? { kind: 'user', userId: `u-${dev}`, deviceId: dev, roles: ['live'] } : null;
    });
    registerLiveRoutes(app, { sessions: r.s, proxy: {} as never, lanIps: [] });
    await app.ready();
    minis.push(app);
    return app;
  }
  const post = (app: FastifyInstance, device: string, audio: unknown) =>
    app.inject({ method: 'POST', url: '/api/live/audio', headers: { 'x-device': device }, payload: { audio } as object });

  it('only the device that started the live may change the audio; the answer is the status', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    const app = await mini(r);
    expect((await post(app, 'dev-other', MIX_MIC)).statusCode).toBe(403);
    const ok = await post(app, 'dev-ipad', MIX_MIC);
    expect(ok.statusCode).toBe(200);
    // build 6: an older app sends two enabled sources; the box keeps one by the priority rule (never a 400)
    expect(ok.json().audio.sources.map((x: { id: string }) => x.id)).toEqual(['deviceMic']);
    expect((await post(app, 'dev-ipad', 'loud')).statusCode).toBe(400);
  });

  it('refuses when no live runs', async () => {
    const r = await rig();
    const app = await mini(r);
    expect((await post(app, 'dev-ipad', MIX_MIC)).statusCode).toBe(409);
  });

  it('a volume is a run-time command: no restart; the camera volume of an older app changes nothing (one sound)', async () => {
    const r = await rig();
    await r.start({ audio: { ...MIX_MIC, camera: { enabled: true, volume: 0 } } });
    cameraUp(r, true);
    await r.tick();
    const m = r.mixers[0]!;
    const app = await mini(r);
    // the microphone volume: the graph value follows at once
    expect((await post(app, 'dev-ipad', { ...MIX_MIC, camera: { enabled: true, volume: 0 }, deviceMic: { enabled: true, volume: 50 } })).statusCode).toBe(200);
    expect(r.mixers).toHaveLength(1);
    expect(m.volumeOf('deviceMic')).toEqual([50]);
    // the camera raised as well (an older app): the microphone stays the one sound, no unit volume, no hold-out, no restart
    expect((await post(app, 'dev-ipad', { ...MIX_MIC, deviceMic: { enabled: true, volume: 50 } })).statusCode).toBe(200);
    expect(r.mixers).toHaveLength(1);
    expect(m.volumeOf('unit')).toEqual([]);
    expect(m.volumeOf('deviceMic')).toEqual([50]);
    expect(m.stopped).toBe(false);
  });

  it('choosing the microphone or the camera sound restarts the combiner (the old one stops first); the microphone is joined by hand (manual)', async () => {
    const r = await rig();
    await r.start();
    cameraUp(r, true);
    await r.tick();
    expect(r.mixers[0]!.cfg?.added).toEqual([]);
    const app = await mini(r);
    expect((await post(app, 'dev-ipad', MIX_MIC)).statusCode).toBe(200);
    // the iPad starts publishing its microphone: the combiner restarts with it once it is steady
    expect(r.s.status().audio?.sources.find((x) => x.id === 'deviceMic')?.state).toBe('ok');
    r.api.ready.add('surau-mic');
    await r.tick();
    await r.tick(3500);
    expect(r.mixers).toHaveLength(2);
    expect(r.mixers[0]!.stopped).toBe(true);
    expect(r.mixers[1]!.solo).toBe(true);
    expect(r.mixers[1]!.cfg?.added.map((a) => a.id)).toEqual(['deviceMic']);
    expect(r.s.status().audio?.sources.find((x) => x.id === 'deviceMic')?.align?.state).toBe('manual');
    // back to the camera sound
    expect((await post(app, 'dev-ipad', { ...MIX_MIC, deviceMic: { enabled: false, volume: 80 } })).statusCode).toBe(200);
    expect(r.mixers).toHaveLength(3);
    expect(r.mixers[1]!.stopped).toBe(true);
    expect(r.mixers[2]!.solo).toBe(false);
    expect(r.mixers[2]!.cfg).toMatchObject({ unitHasAudio: true, unitVolume: 100, added: [] });
  });

  it('a phone-run live: volumes are only recorded; Mic-in cannot be switched on or off mid-live (409)', async () => {
    const r = await rig();
    await r.start({ source: 'android', youtubeVia: 'device' }, 'dev-phone');
    const app = await mini(r);
    const phoneMix = { camera: { enabled: true, volume: 40 }, deviceMic: { enabled: true, volume: 70 }, boxInput: { enabled: false, volume: 100 } };
    const ok = await post(app, 'dev-phone', phoneMix);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().audio.sources.find((x: { id: string }) => x.id === 'deviceMic').volume).toBe(70);
    expect(r.mixers).toHaveLength(0);
    r.inputAvailable.v = { deviceName: 'Line In' };
    const bad = await post(app, 'dev-phone', { ...phoneMix, boxInput: { enabled: true, volume: 100 } });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().code).toBe('audio_unsupported');
  });
});

describe('Mic-in on a device stream (the box only ingests)', () => {
  it('the real laptop device name (registered sign) reaches the dshow input of the combiner arguments', async () => {
    const real = 'Microphone Array (Intel® Smart Sound Technology for Digital Microphones)';
    const listing = `[in#0 @ 000001] "${real}" (audio)
[in#0 @ 000001]   Alternative name "@device_cm_{x}"
`;
    const inputs = new AudioInputs({ ffmpegPath: () => 'ffmpeg', platform: 'windows', run: async () => ({ ok: true, output: listing }) });
    await inputs.list();
    expect(parseDshowAudioDevices(listing)[0]!.usable).toBe(true);
    const r = await rig();
    r.inputAvailable.v = inputs.boxInput();
    await r.start(
      { source: 'android', youtubeVia: 'device', video: 'phone', audio: { camera: { enabled: false, volume: 100 }, deviceMic: { enabled: true, volume: 100 }, boxInput: { enabled: true, volume: 60 } } },
      'dev-phone',
    );
    r.api.ready.add('surau-in');
    await r.tick();
    const o = r.mixers[0]!.o;
    expect(r.mixers[0]!.solo).toBe(true);
    expect(o.deviceName).toBe(real);
    // build 6: the box microphone is read by the solo sound process
    const args = soundArgs({ input: { kind: 'dshow', deviceName: o.deviceName! }, volume: 60, levelled: false, leveller: true, control: 'zmq', zmqPort: 30000, platform: 'windows', aac: false });
    expect(args).toContain(`audio=${real}`);
    expect(args).toContain('-sample_rate');
    // and the mixer still takes the same name (its argument rules are unchanged)
    expect(mixArgs({ unit: 'ingest', unitHasAudio: true, added: [{ id: 'boxInput', initialDelayMs: 0, volume: 60 }], unitVolume: 100, headroomMs: 2000, control: 'zmq', zmqPort: 30000, platform: 'windows', deviceName: o.deviceName! })).toContain(`audio=${real}`);
  });

  it('the phone publishes to surau-in; the combiner takes it as the unit and the capture device as the added source', async () => {
    const r = await rig();
    r.inputAvailable.v = { deviceName: 'Line In' };
    const res = await r.start(
      { source: 'android', youtubeVia: 'device', video: 'phone', audio: { camera: { enabled: false, volume: 100 }, deviceMic: { enabled: true, volume: 100 }, boxInput: { enabled: true, volume: 60 } } },
      'dev-phone',
    );
    const id = res.session.id;
    expect(res.ingest.path).toBe('surau-in');
    expect(res.ingest.srt?.streamId).toBe(`publish:surau-in:pub-${id}:${r.api.users.get(`pub-${id}`)!.pass}`);
    expect(r.api.users.get(`pub-${id}`)?.permissions).toEqual([{ action: 'publish', path: 'surau-in' }]);
    expect(r.api.patches.some((p) => p.path === 'surau-cam')).toBe(false); // the box does not pull anything
    r.api.ready.add('surau-in');
    await r.tick();
    const m = r.mixers[0]!;
    // build 6: the box microphone is the one sound, joined to the phone's picture (the phone's own sound is not used)
    expect(m.solo).toBe(true);
    expect(m.cfg).toMatchObject({ unit: 'ingest' });
    expect(m.o).toMatchObject({ deviceName: 'Line In' });
    expect(m.cfg?.added).toEqual([{ id: 'boxInput', initialDelayMs: 400, volume: 60, held: false }]);
    expect(r.aligners).toHaveLength(0);
    expect(r.s.status().audio?.sources.map((x) => x.id)).toEqual(['boxInput']);
  });

  it('"Mic-in only" (every phone-side volume 0): the same solo path, the phone stream is the picture only', async () => {
    const r = await rig();
    r.inputAvailable.v = { deviceName: 'Line In' };
    await r.start({ source: 'android', youtubeVia: 'device', video: 'phone', audio: { camera: { enabled: false, volume: 100 }, deviceMic: { enabled: true, volume: 0 }, boxInput: { enabled: true, volume: 100 } } }, 'dev-phone');
    r.api.ready.add('surau-in');
    await r.tick();
    expect(r.mixers[0]!.solo).toBe(true);
    expect(r.mixers[0]!.cfg).toMatchObject({ unit: 'ingest', added: [{ id: 'boxInput', volume: 100 }] });
    expect(r.aligners).toHaveLength(0);
  });

  it('without a capture device the choice is dropped: an ordinary phone live', async () => {
    const r = await rig();
    const res = await r.start({ source: 'android', youtubeVia: 'device', video: 'phone', audio: { ...MIX_MIC, boxInput: { enabled: true, volume: 100 } } }, 'dev-phone');
    expect(res.ingest.path).toBe('surau');
    expect(r.api.users.size).toBe(1);
  });
});

describe('status (plan 4.7)', () => {
  it('reports the video and one row for the one sound with its state, volume and fixed delay (build 6: never searching)', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    // before the picture
    let st = r.s.status();
    expect(st.video).toBe('external');
    expect(st.audio?.sources.map((x) => [x.id, x.volume, x.state])).toEqual([['deviceMic', 80, 'ok']]);
    expect(st.audio?.sources[0]?.align).toEqual({ state: 'manual', delayMs: 400 });
    cameraUp(r, true);
    await r.tick();
    st = r.s.status();
    expect(st.warnings).not.toContain('audio_align_searching');
    expect(st.warnings).not.toContain('audio_align_failed');
    expect(st.audio?.sources[0]?.align).toEqual({ state: 'manual', delayMs: 400 });
    // the camera's own sound chosen: one row, no alignment (only a microphone is joined with a delay)
    await r.s.changeAudio('dev-ipad', { audio: { ...MIX_MIC, deviceMic: { enabled: false, volume: 80 } } });
    st = r.s.status();
    expect(st.audio?.sources.map((x) => x.id)).toEqual(['camera']);
    expect(st.audio?.sources[0]?.align).toBeUndefined();
  });

  it('warns when every source is silent, and marks a silenced source', async () => {
    const r = await rig();
    await r.start({ audio: { ...MIX_MIC, camera: { enabled: true, volume: 0 }, deviceMic: { enabled: true, volume: 0 } } });
    const st = r.s.status();
    expect(st.warnings).toContain('audio_all_muted');
    expect(st.audio?.sources.every((x) => x.state === 'silent')).toBe(true);
  });

  it('no_video_from_camera instead of the device warning when the camera gives no picture', async () => {
    const r = await rig();
    await r.start();
    await r.tick(5000);
    expect(r.s.status().warnings).not.toContain('no_video_from_camera');
    await r.tick(8000);
    const w = r.s.status().warnings;
    expect(w).toContain('no_video_from_camera');
    expect(w).not.toContain('no_video_from_device');
  });

  it('a phone live that sent no audio mix has no audio block, and still reports its video', async () => {
    const r = await rig();
    await r.start({ source: 'android', youtubeVia: 'device', video: undefined }, 'dev-phone');
    const st = r.s.status();
    expect(st.video).toBe('phone');
    expect(st.audio).toBeUndefined();
  });

  it('never carries the camera address or login, in the status, the start answer, the kiosk event or the console', async () => {
    const spies = ['log', 'info', 'warn', 'error'].map((m) => vi.spyOn(console, m as 'log').mockImplementation(() => undefined));
    const r = await rig();
    const res = await r.start({ audio: MIX_MIC });
    cameraUp(r, true);
    await r.tick();
    const everything = JSON.stringify([r.s.status(), res, r.kiosk, r.s.kioskLive()]);
    for (const secret of [CAM_PASS, CAM_USER, 'rtsp://', '10.168.1.60']) expect(everything).not.toContain(secret);
    r.api.failPatch = true; // a failing path restore warns: the warning must not carry the address either
    await r.s.stop(res.session.id, 'user:starter');
    const logged = JSON.stringify(spies.flatMap((l) => l.mock.calls));
    for (const secret of [CAM_PASS, CAM_USER]) expect(logged).not.toContain(secret);
  });
});

describe('camera lost (waiting flag, 10 minute stop) and the controller heartbeat', () => {
  it('the kiosk keeps the live with waiting while the camera is gone, and drops waiting when it returns', async () => {
    const r = await rig();
    await r.start();
    expect(r.s.kioskLive().live).toBe(false); // nothing was ever shown
    cameraUp(r);
    await r.tick();
    expect(r.s.kioskLive()).toMatchObject({ live: true });
    expect(r.s.kioskLive().waiting).toBeUndefined();
    r.api.ready.delete('surau-cam');
    r.api.ready.delete('surau');
    await r.tick(3000);
    expect(r.s.kioskLive()).toMatchObject({ live: true, waiting: true });
    expect(r.kiosk.at(-1)).toMatchObject({ live: true, waiting: true });
    cameraUp(r);
    await r.tick(3000);
    const back = r.s.kioskLive();
    expect(back.live).toBe(true);
    expect(back.waiting).toBeUndefined();
  });

  it('a box-pulled live has no automatic end: the camera gone for 3 hours (fake time) leaves it open, with the waiting card', async () => {
    const r = await rig();
    const id = (await r.start()).session.id;
    cameraUp(r);
    await r.tick();
    r.api.ready.delete('surau-cam');
    r.api.ready.delete('surau');
    for (let i = 0; i < 18; i++) {
      r.h.clock.t += 10 * 60_000;
      await r.tick();
    }
    expect(r.s.current()?.id).toBe(id);
    expect(r.s.status().warnings).toContain('no_video_from_camera');
    expect(r.s.kioskLive()).toMatchObject({ live: true, waiting: true });
    // the camera comes back by itself: a new combiner, the same live
    cameraUp(r);
    await r.tick(3000);
    expect(r.s.current()?.id).toBe(id);
    expect(r.mixers.at(-1)!.stopped).toBe(false);
  });

  it('a live that started box-pulled stays open after the switch to the iPad\'s own camera, however long that camera is missing (K2)', async () => {
    const r = await rig();
    const id = (await r.start({ audio: MIX_MIC })).session.id;
    cameraUp(r);
    await r.tick();
    await r.s.changeAudio('dev-ipad', { audio: MIX_MIC, video: 'phone' });
    const round = async (ms: number): Promise<void> => {
      r.h.clock.t += ms;
      r.s.heartbeat('dev-ipad');
      r.api.ready.add('surau'); // the box output is still there: only the unit is missing
      await r.tick();
    };
    await round(3000);
    await round(9 * 60_000);
    expect(r.s.current()?.id).toBe(id);
    await round(61_000);
    await round(60 * 60_000);
    expect(r.s.current()?.id).toBe(id);
  });

  it('a camera that never came leaves a box-pulled live open too', async () => {
    const r = await rig();
    await r.start();
    for (let i = 0; i < 6; i++) {
      r.h.clock.t += 30 * 60_000;
      await r.tick();
    }
    expect(r.s.current()).not.toBeNull();
  });

  it('A3: no poll of any device for 3 hours leaves a box-pulled live open; controller_quiet shows from 10 minutes and one poll of the starter clears it', async () => {
    const r = await rig();
    const id = (await r.start()).session.id;
    cameraUp(r);
    await r.tick();
    expect(r.s.status().warnings).not.toContain('controller_quiet');
    expect(r.s.status().controllerQuietSeconds).toBe(0);
    await r.tick(9 * 60_000);
    expect(r.s.status().warnings).not.toContain('controller_quiet');
    await r.tick(61_000);
    expect(r.s.status().warnings).toContain('controller_quiet');
    expect(r.s.status().controllerQuietSeconds).toBeGreaterThanOrEqual(600);
    for (let i = 0; i < 17; i++) {
      cameraUp(r);
      await r.tick(10 * 60_000);
    }
    expect(r.s.current()?.id).toBe(id);
    // a device that did not start the live does not clear the notice; the starter does
    r.s.heartbeat('dev-other');
    expect(r.s.status().warnings).toContain('controller_quiet');
    r.s.heartbeat('dev-ipad');
    expect(r.s.status().warnings).not.toContain('controller_quiet');
    expect(r.s.status().controllerQuietSeconds).toBe(0);
  });

  it('the status route: a poll of another device leaves the quiet notice in place', async () => {
    const r = await rig();
    await r.start();
    cameraUp(r);
    await r.tick();
    const app = Fastify();
    app.addHook('onRequest', async (req) => {
      (req as unknown as { auth: unknown }).auth = { kind: 'user', userId: 'u', deviceId: req.headers['x-device'], roles: ['live'] };
    });
    registerLiveRoutes(app, { sessions: r.s, proxy: {} as never, lanIps: [] });
    await app.ready();
    minis.push(app);
    r.h.clock.t += 11 * 60_000;
    expect(r.s.status().warnings).toContain('controller_quiet');
    const polled = await app.inject({ method: 'GET', url: '/api/live/status', headers: { 'x-device': 'dev-other' } });
    expect(polled.json().warnings).toContain('controller_quiet');
    expect(polled.json().canToggleKiosk).toBe(true);
  });

  it('a phone-run live is not ended by a silent controller (it ends with its stream)', async () => {
    const r = await rig();
    await r.start({ source: 'android', youtubeVia: 'device' }, 'dev-phone');
    r.api.ready.add('surau');
    await r.tick(9 * 60_000);
    r.api.ready.add('surau');
    await r.tick(9 * 60_000);
    expect(r.s.current()).not.toBeNull();
  });
});

describe('stop rule and the emergency-stop audit (real roles)', () => {
  const LAN = '10.168.1.40';
  const post = (h: LiveHarness, url: string, headers: Record<string, string>, payload: unknown) =>
    h.app.inject({ method: 'POST', url, headers, payload: payload as object, remoteAddress: LAN });
  const emergencyRows = (h: LiveHarness): Array<{ actor: string; after: Record<string, unknown> }> =>
    (h.app.surau.db.prepare("SELECT actor, after_json FROM change_log WHERE entity = 'live' AND entity_id = 'emergency-stop'").all() as Array<{ actor: string; after_json: string }>).map((x) => ({
      actor: x.actor,
      after: JSON.parse(x.after_json) as Record<string, unknown>,
    }));

  it('the Pentadbir stops a live another device started, with the emergency audit naming both actors', async () => {
    const h = await startLiveHarness();
    harnesses.push(h);
    const starter = await loginAs(h.app, 'live');
    const admin = await loginAs(h.app, 'admin');
    const id = (await post(h, '/api/live/start', starter.headers, startBody(h))).json().session.id as string;
    const r = await post(h, '/api/live/stop', admin.headers, { sessionId: id });
    expect(r.json()).toMatchObject({ stopped: true });
    const rows = emergencyRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe(`user:${admin.userId}`);
    expect(rows[0]!.after).toMatchObject({ sessionId: id, startedBy: `user:${starter.userId}`, stoppedBy: `user:${admin.userId}` });
    // B12: the record names a person's stop `stopped`, the Pentadbir's included. The starting device, which did not
    // stop it, reads its own row (`mine`) with that reason as "dihentikan oleh pentadbir" (app: live_controller.dart).
    const recent = async (headers: Record<string, string>) =>
      ((await h.app.inject({ method: 'GET', url: '/api/live/sessions/recent', headers, remoteAddress: LAN })).json().sessions as Array<{ id: string; reason: string | null; mine: boolean }>).find((x) => x.id === id);
    expect(await recent(starter.headers)).toMatchObject({ reason: 'stopped', mine: true });
    expect(await recent(admin.headers)).toMatchObject({ reason: 'stopped', mine: false });
  });

  it('the starter stopping its own live is no emergency', async () => {
    const h = await startLiveHarness();
    harnesses.push(h);
    const starter = await loginAs(h.app, 'live');
    const id = (await post(h, '/api/live/start', starter.headers, startBody(h))).json().session.id as string;
    expect((await post(h, '/api/live/stop', starter.headers, { sessionId: id })).json()).toMatchObject({ stopped: true });
    expect(emergencyRows(h)).toHaveLength(0);
  });

  it('a holder of live:control or live:settings who is not the starter is refused, and nothing is audited', async () => {
    const h = await startLiveHarness();
    harnesses.push(h);
    const starter = await loginAs(h.app, 'live');
    const other = await loginAs(h.app, 'live'); // holds live:control and live:settings
    const id = (await post(h, '/api/live/start', starter.headers, startBody(h))).json().session.id as string;
    const r = await post(h, '/api/live/stop', other.headers, { sessionId: id });
    expect(r.statusCode).toBe(403);
    expect(h.app.liveSessions!.current()?.id).toBe(id);
    expect(emergencyRows(h)).toHaveLength(0);
  });

  it('the audio route: a Media-only user and an anonymous caller are refused at the door; another Siaran Langsung device is refused by the route', async () => {
    const h = await startLiveHarness();
    harnesses.push(h);
    const starter = await loginAs(h.app, 'live');
    const other = await loginAs(h.app, 'live');
    const media = await loginAs(h.app, 'media');
    await post(h, '/api/live/start', starter.headers, startBody(h));
    expect((await post(h, '/api/live/audio', {}, { audio: MIX_MIC })).statusCode).toBe(401);
    expect((await post(h, '/api/live/audio', media.headers, { audio: MIX_MIC })).statusCode).toBe(403);
    const refused = await post(h, '/api/live/audio', other.headers, { audio: MIX_MIC });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('not_owner');
    expect((await post(h, '/api/live/audio', starter.headers, { audio: MIX_MIC })).statusCode).toBe(200);
  });
});

describe('preview WHEP of the combined stream (starting device only)', () => {
  const LAN = '10.168.1.40';
  const SDP = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
  const whep = (h: LiveHarness, headers: Record<string, string>, method: 'POST' | 'DELETE', url: string) =>
    h.app.inject({ method, url, headers: method === 'POST' ? { ...headers, 'content-type': 'application/sdp' } : headers, ...(method === 'POST' ? { payload: SDP } : {}), remoteAddress: LAN });

  it('the starter gets an answer and can close it; another device and a Media-only user cannot; nothing without a live', async () => {
    const h = await startLiveHarness();
    harnesses.push(h);
    const starter = await loginAs(h.app, 'live');
    const other = await loginAs(h.app, 'live');
    const media = await loginAs(h.app, 'media');
    expect((await whep(h, starter.headers, 'POST', '/api/live/preview/whep')).statusCode).toBe(409); // no live yet
    await h.app.inject({ method: 'POST', url: '/api/live/start', headers: starter.headers, payload: startBody(h), remoteAddress: LAN });
    h.fake.webSessionId = 'prev-1';
    const ok = await whep(h, starter.headers, 'POST', '/api/live/preview/whep');
    expect(ok.statusCode).toBe(201);
    expect(ok.headers.location).toBe('/api/live/preview/whep/prev-1');
    expect(h.fake.requests.some((q) => q.method === 'POST' && q.url === '/surau/whep')).toBe(true);
    expect((await whep(h, other.headers, 'POST', '/api/live/preview/whep')).statusCode).toBe(403);
    expect((await whep(h, media.headers, 'POST', '/api/live/preview/whep')).statusCode).toBe(403);
    expect((await whep(h, other.headers, 'DELETE', '/api/live/preview/whep/prev-1')).statusCode).toBe(403);
    expect((await whep(h, starter.headers, 'DELETE', '/api/live/preview/whep/prev-1')).statusCode).toBe(204);
    expect((await whep(h, starter.headers, 'DELETE', '/api/live/preview/whep/prev-1')).statusCode).toBe(404);
  });

  it('the WHIP proxy publishes to the session path (surau-mic for an iPad microphone)', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    const pub = r.s.publisherFor('dev-ipad');
    expect(pub.path).toBe('surau-mic');
    expect(() => r.s.publisherFor('dev-other')).toThrow();
  });
});

describe('mid-live switch to the iPad camera, hand-set offset and level meters (integration round)', () => {
  const audio = (over: Partial<typeof MIX_MIC> = {}): typeof MIX_MIC => ({ ...MIX_MIC, ...over });

  it('video phone: the unit becomes surau-in, the publisher is re-authorised there, the camera pull stays; video external returns', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    cameraUp(r, true);
    await r.tick();
    expect(r.mixers[0]!.cfg).toMatchObject({ unit: 'camera' });
    const id = r.s.current()!.id;

    const st = await r.s.changeAudio('dev-ipad', { audio: audio(), video: 'phone' });
    expect(st.video).toBe('phone');
    expect(r.api.users.get(`pub-${id}`)?.permissions).toEqual([{ action: 'publish', path: 'surau-in' }]);
    expect(r.mixers[0]!.stopped).toBe(true); // waits until the iPad's own stream is there
    expect(r.mixers).toHaveLength(1);
    expect(r.s.publisherFor('dev-ipad').path).toBe('surau-in');

    r.api.ready.add('surau-in');
    await r.tick();
    expect(r.mixers).toHaveLength(2);
    expect(r.mixers[1]!.cfg).toMatchObject({ unit: 'ingest', unitHasAudio: true });
    expect(r.mixers[1]!.cfg?.added).toEqual([]);

    const back = await r.s.changeAudio('dev-ipad', { audio: audio(), video: 'external' });
    expect(back.video).toBe('external');
    expect(r.api.users.get(`pub-${id}`)?.permissions).toEqual([{ action: 'publish', path: 'surau-mic' }]);
    expect(r.s.publisherFor('dev-ipad').path).toBe('surau-mic');
    expect(r.mixers[2]!.cfg).toMatchObject({ unit: 'camera' });
    expect(r.mixers[2]!.cfg?.added).toEqual([]); // the iPad microphone is added once it has been steady for a while
    await r.tick(3500);
    expect(r.mixers[3]!.cfg?.added.map((a) => a.id)).toEqual(['deviceMic']);
  });

  it('Q6: the camera-in-use flag follows the video source: cleared on the iPad\'s own camera, set again (via box) when the pulled camera returns', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    const id = r.s.current()!.id;
    expect(r.s.cameraUse('dev-other')).toMatchObject([{ sessionId: id, via: 'box', by: { mine: false } }]);
    // A14: a box-pulled live shows no picture to another device; the iPad (web) owner keeps its one reader
    expect(() => r.s.previewFor('dev-other')).toThrowError(expect.objectContaining({ status: 409, code: 'preview_off' }));
    expect(r.s.previewFor('dev-ipad')).toMatchObject({ path: 'surau' });

    const st = await r.s.changeAudio('dev-ipad', { audio: audio(), video: 'phone' });
    expect(st.cameraUse).toEqual([]);
    expect(r.s.cameraUse('dev-other')).toEqual([]);
    // no camera in the live: nobody new joins, and another device is not told the camera is busy
    expect(() => r.s.previewFor('dev-new')).toThrowError(expect.objectContaining({ code: 'not_owner' }));
    expect(() => r.s.cameraAddressFor('dev-new')).toThrowError(expect.objectContaining({ code: 'not_owner' }));

    const back = await r.s.changeAudio('dev-ipad', { audio: audio(), video: 'external' });
    expect(back.cameraUse).toMatchObject([{ cameraId: 'external', sessionId: id, via: 'box', by: { mine: true } }]);
    expect(() => r.s.cameraAddressFor('dev-new')).toThrowError(expect.objectContaining({ code: 'camera_in_use' }));
    // a change of the mix alone leaves the flag (and its since) as it is
    const since = back.cameraUse![0]!.since;
    expect((await r.s.changeAudio('dev-ipad', { audio: audio() })).cameraUse![0]!.since).toBe(since);
  });

  it('refuses a bad video value and a switch on a live the box does not pull', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    await expect(r.s.changeAudio('dev-ipad', { audio: audio(), video: 'ndi' })).rejects.toMatchObject({ status: 400 });
    await r.s.stop(undefined, 'user:starter', 'user');
    const phone = await r.start({ source: 'android', youtubeVia: 'device', video: 'phone' }, 'dev-phone');
    expect(phone.ingest.path).toBe('surau');
    await expect(r.s.changeAudio('dev-phone', { audio: audio(), video: 'external' })).rejects.toMatchObject({ status: 409 });
  });

  it('avOffsetMs: validated 0..2000 step 50, and the running solo path gets the offset as its join delay', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    r.api.ready.add('surau-cam');
    r.api.ready.add('surau-mic');
    r.api.tracks['surau-cam'] = ['H264']; // no camera audio
    await r.tick();
    const m = r.mixers[0]!;
    expect(m.cfg?.added).toEqual([{ id: 'deviceMic', initialDelayMs: 400, volume: 80, held: false }]);
    for (const bad of [-50, 2050, 25, 1.5, '300']) {
      await expect(r.s.changeAudio('dev-ipad', { audio: audio(), avOffsetMs: bad })).rejects.toMatchObject({ status: 400 });
    }
    expect(m.delays).toEqual([]);
    const st = await r.s.changeAudio('dev-ipad', { audio: audio(), avOffsetMs: 350 });
    expect(m.delays).toEqual([['deviceMic', 350]]);
    expect(r.mixers).toHaveLength(1); // no rebuild (the solo path restarts its join only)
    expect(st.audio?.sources.find((x) => x.id === 'deviceMic')?.align).toEqual({ state: 'manual', delayMs: 350 });
    // a hand-set 0 is a real value (no delay), not "unset"
    await r.s.changeAudio('dev-ipad', { audio: audio(), avOffsetMs: 0 });
    expect(m.delays.at(-1)).toEqual(['deviceMic', 0]);
  });

  it('level meters: RMS dBFS per source from the monitor, absent before the first window and after the combiner goes', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    cameraUp(r, true);
    await r.tick();
    const m = r.mixers[0]!;
    expect(r.s.status().audio?.sources.every((x) => x.level === undefined)).toBe(true);
    // 0.5 s of 16 kHz stereo (unit, deviceMic) as the solo path gives it: the unit channel silent, the mic at half scale (-6.0 dBFS)
    const frames = 8000;
    const buf = Buffer.alloc(frames * 4);
    for (let f = 0; f < frames; f++) {
      buf.writeInt16LE(0, f * 4);
      buf.writeInt16LE(f % 2 === 0 ? 16384 : -16384, f * 4 + 2);
    }
    m.monitor.write(buf);
    await new Promise((res) => setImmediate(res));
    const src = r.s.status().audio!.sources;
    expect(src.find((x) => x.id === 'deviceMic')?.level).toBeCloseTo(-6, 0);
    expect(src.find((x) => x.id === 'camera')).toBeUndefined(); // one sound: the camera's is not in the live
    // the camera is lost: the combiner is gone and so are the levels
    r.api.ready.delete('surau-cam');
    await r.tick(3000);
    expect(r.s.status().audio?.sources.every((x) => x.level === undefined)).toBe(true);
  });
});

describe('round 2 review fixes: Android with an external camera and Mic-in', () => {
  const ANDROID_EXT = (audio: Record<string, { enabled: boolean; volume: number }>): Partial<LiveStartRequest> => ({
    source: 'android',
    youtubeVia: 'device',
    video: 'external',
    audio: audio as LiveStartRequest['audio'],
  });

  it('the phone mixes its own microphone into surau-in: the combiner gets no surau-mic input, only Mic-in', async () => {
    const r = await rig();
    r.inputAvailable.v = { deviceName: 'Line In' };
    await r.start(ANDROID_EXT({ camera: { enabled: true, volume: 100 }, deviceMic: { enabled: true, volume: 80 }, boxInput: { enabled: true, volume: 60 } }), 'dev-phone');
    r.api.ready.add('surau-in');
    await r.tick();
    const m = r.mixers[0]!;
    expect(m.cfg?.unit).toBe('ingest');
    expect(m.cfg?.added.map((a) => a.id)).toEqual(['boxInput']);
    const args = mixArgs({ unit: 'ingest', unitHasAudio: true, added: m.cfg!.added, unitVolume: 100, headroomMs: 2000, control: 'zmq', zmqPort: 30000, platform: 'windows', deviceName: 'Line In' });
    expect(args.join(' ')).not.toContain('surau-mic');
  });

  it('a silent reference (phone mic off, camera sound off): the box microphone is joined by hand with the saved offset as its delay', async () => {
    const r = await rig({ camera: { lastTest: { ...LAST_TEST, hasAudio: false, codecs: ['H264'] } }, cameraSettings: { avOffsetMs: { deviceMic: 0, boxInput: 450 } } });
    r.inputAvailable.v = { deviceName: 'Line In' };
    await r.start(ANDROID_EXT({ camera: { enabled: false, volume: 100 }, deviceMic: { enabled: false, volume: 100 }, boxInput: { enabled: true, volume: 100 } }), 'dev-phone');
    r.api.ready.add('surau-in');
    await r.tick();
    const m = r.mixers[0]!;
    expect(m.solo).toBe(true);
    expect(m.cfg).toMatchObject({ unit: 'ingest' });
    // build 6: the join delay is the saved offset itself
    expect(m.cfg?.added).toEqual([{ id: 'boxInput', initialDelayMs: 450, volume: 100, held: false }]);
    expect(r.s.status().audio?.sources.find((x) => x.id === 'boxInput')?.align).toEqual({ state: 'manual', delayMs: 450 });
    expect(r.s.status().warnings).not.toContain('audio_align_searching');
  });

  it('a device stream with a picture and no sound track: the box microphone on the solo path, and a silent picture if it is benched', async () => {
    const r = await rig();
    r.inputAvailable.v = { deviceName: 'Line In' };
    await r.start({ source: 'android', youtubeVia: 'device', video: 'phone', audio: { camera: { enabled: false, volume: 100 }, deviceMic: { enabled: true, volume: 100 }, boxInput: { enabled: true, volume: 100 } } }, 'dev-phone');
    r.api.ready.add('surau-in');
    r.api.tracks['surau-in'] = ['H264'];
    await r.tick();
    expect(r.mixers[0]!.solo).toBe(true);
    expect(r.mixers[0]!.cfg).toMatchObject({ unit: 'ingest', added: [{ id: 'boxInput' }] });
    (r.s as unknown as { session: { boxInputBenchedUntilMs: number } }).session.boxInputBenchedUntilMs = r.h.clock.t + 60_000;
    await r.tick();
    expect(r.mixers[1]!.cfg).toMatchObject({ unit: 'ingest', unitHasAudio: false, added: [] });
  });

  it('Mic-in uses the device captured at the start: a later empty device list does not break the build', async () => {
    const r = await rig();
    r.inputAvailable.v = { deviceName: 'Line In' };
    await r.start({ source: 'android', youtubeVia: 'device', video: 'phone', audio: { camera: { enabled: false, volume: 100 }, deviceMic: { enabled: true, volume: 100 }, boxInput: { enabled: true, volume: 60 } } }, 'dev-phone');
    r.inputAvailable.v = null; // the cached list failed to refresh
    r.api.ready.add('surau-in');
    await r.tick();
    expect(r.mixers[0]!.o).toMatchObject({ deviceName: 'Line In' });
    expect(r.mixers[0]!.cfg?.added.map((a) => a.id)).toEqual(['boxInput']);
  });

  it('a combiner in state failed shows as a status warning', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    cameraUp(r, true);
    await r.tick();
    expect(r.s.status().warnings).not.toContain('audio_mix_failed');
    r.mixers[0]!.state = 'failed';
    expect(r.s.status().warnings).toContain('audio_mix_failed');
  });

  it('a live with the external camera is refused (409) while a camera test is running', async () => {
    const r = await rig();
    let busy = true;
    r.s.attachCameraBusy(() => busy);
    await expect(r.start()).rejects.toMatchObject({ status: 409, code: 'camera_test_busy' });
    expect(r.s.current()).toBeNull();
    busy = false;
    await expect(r.start()).resolves.toBeTruthy();
  });

  it('after a switch to the iPad camera the kiosk shows no camera waiting card and the warning blames the device, not the camera', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    cameraUp(r, true);
    await r.tick();
    expect(r.s.kioskLive().waiting).toBeUndefined();
    await r.s.changeAudio('dev-ipad', { audio: MIX_MIC, video: 'phone' });
    r.api.ready.delete('surau-cam');
    r.api.ready.delete('surau');
    await r.tick(13_000); // the iPad's own picture has not arrived yet
    expect(r.s.kioskLive().waiting).toBeUndefined();
    const w = r.s.status().warnings;
    expect(w).not.toContain('no_video_from_camera');
    expect(w).toContain('no_video_from_device');
  });
});

// 2026.11.15, Lane A task A4 (B11): an Android phone asks the box to pull the camera (`videoPath: 'box'`); the phone
// only controls. The default stays the phone pull, and the box flags the camera as in use either way.
describe('A4: box pull for an Android phone, the camera-in-use flag, bitrate and codec warnings', () => {
  const android = { source: 'android' as const, videoPath: 'box' as const };

  it('B11: an Android start with videoPath box is a pulled session: the box pulls into surau-cam, the phone gets a surau-mic SRT target (success path)', async () => {
    const r = await rig();
    const res = await r.start({ ...android, audio: MIX_MIC }, 'dev-phone');
    expect(res.session).toMatchObject({ source: 'android', videoPath: 'box', mine: true });
    expect(res.ingest.path).toBe('surau-mic');
    expect(res.ingest.srt).toMatchObject({ host: '10.168.1.5', port: 8890 });
    expect(res.ingest.srt!.streamId.startsWith('publish:surau-mic:pub-')).toBe(true);
    // the camera address reaches MediaMTX through the API only
    const cam = r.api.patches.filter((p) => p.path === 'surau-cam');
    expect(cam.at(-1)!.patch).toMatchObject({ source: CAM_URL, rtspTransport: 'tcp' });
    // the box joins the phone's microphone to the camera picture, as for a browser (build 6: the solo path)
    cameraUp(r, true);
    await r.tick();
    expect(r.mixers).toHaveLength(1);
    expect(r.mixers[0]!.solo).toBe(true);
    expect(r.mixers[0]!.cfg).toMatchObject({ unit: 'camera' });
    expect(r.mixers[0]!.cfg!.added.map((a) => a.id)).toEqual(['deviceMic']);
    // the Android app levels its own microphone: the solo path does not lift it again
    expect(r.mixers[0]!.o.appLevelled).toBe(true);
    const st = r.s.status('dev-phone');
    expect(st.session).toMatchObject({ videoPath: 'box', mine: true });
    expect(st.cameraUse).toEqual([{ cameraId: 'external', sessionId: res.session.id, via: 'box', by: { name: '', mine: true }, since: res.session.startedAt }]);
    // the box holds the camera: nobody reads the address, not even the starting phone
    expect(() => r.s.cameraAddressFor('dev-phone')).toThrowError(expect.objectContaining({ status: 409, code: 'camera_in_use' }));
    expect(() => r.s.cameraAddressFor('dev-other')).toThrowError(expect.objectContaining({ status: 409, code: 'camera_in_use' }));
    await r.s.stop(res.session.id, 'user:starter');
    expect(r.api.patches.at(-1)).toMatchObject({ path: 'surau-mic' });
    expect(r.api.patches.some((p) => p.path === 'surau-cam' && p.patch.source === 'publisher')).toBe(true);
    expect(r.s.status('dev-phone').cameraUse).toEqual([]);
  });

  it('the default is the phone pull: an Android start without videoPath is not pulled, and the starting phone holds the camera', async () => {
    const r = await rig();
    const res = await r.start({ source: 'android', youtubeVia: 'device' }, 'dev-phone');
    expect(res.session.videoPath).toBe('device');
    expect(res.ingest.path).toBe('surau');
    expect(r.api.patches.some((p) => p.path === 'surau-cam')).toBe(false);
    expect(r.s.status('dev-phone').cameraUse).toMatchObject([{ cameraId: 'external', via: 'device', by: { mine: true } }]);
    expect(r.s.status('dev-other').cameraUse).toMatchObject([{ via: 'device', by: { mine: false } }]);
    // the starting phone reads the address; a second device is refused and joins the shared picture instead
    expect(() => r.s.cameraAddressFor('dev-phone')).not.toThrow();
    expect(() => r.s.cameraAddressFor('dev-other')).toThrowError(expect.objectContaining({ status: 409, code: 'camera_in_use' }));
    expect(r.s.previewFor('dev-other')).toMatchObject({ path: 'surau', max: 1 });
  });

  it('a box pull with YouTube from the phone is refused at the door: the phone has no picture to push', () => {
    const base = { kuliahId: null, source: 'android', video: 'external', videoPath: 'box', outputs: { kiosk: true, youtube: true } };
    expect(() => parseStartRequest({ ...base, youtubeVia: 'device' })).toThrow();
    expect(parseStartRequest({ ...base, youtubeVia: 'box' })).toMatchObject({ videoPath: 'box', youtubeVia: 'box' });
    // without YouTube the leg does not matter
    expect(parseStartRequest({ ...base, outputs: { kiosk: true, youtube: false }, youtubeVia: 'device' })).toMatchObject({ videoPath: 'box' });
  });

  it('C11: an H.265-only camera is refused for an Android box pull when the test knows it, and warned by its tracks when no test exists', async () => {
    const tested = await rig({ camera: { lastTest: { ...LAST_TEST, codecs: ['H265', 'MPEG-4 Audio'] } } });
    await expect(tested.start(android, 'dev-phone')).rejects.toMatchObject({ status: 409, code: 'camera_h265' });
    const untested = await rig({ camera: { lastTest: null } });
    await untested.start(android, 'dev-phone');
    expect(untested.s.status().warnings).not.toContain('camera_h265');
    untested.api.ready.add('surau-cam');
    untested.api.tracks['surau-cam'] = ['H265', 'MPEG-4 Audio'];
    await untested.tick();
    expect(untested.s.status().warnings).toContain('camera_h265');
    // an H.264 camera never warns
    untested.api.tracks['surau-cam'] = ['H264', 'MPEG-4 Audio'];
    await untested.tick();
    expect(untested.s.status().warnings).not.toContain('camera_h265');
  });

  it('C3: the copy relay of a pulled camera warns when the camera sends well above the configured maximum, and not below it', async () => {
    const yt: YoutubeLeg = {
      signedIn: () => true,
      createBroadcastFor: async () => ({ broadcastId: 'bc1', watchUrl: 'https://youtu.be/bc1', key: 'abcd-efgh-ijkl-mnop-qrst' }),
      complete: async () => undefined,
      status: () => ({ signedIn: true, channelTitle: 'Surau', broadcastId: 'bc1', state: 'created', health: null, watchUrl: null, lastError: null }),
    };
    const r = await rig({ extra: { youtube: yt, youtubeGraceMs: 0 } });
    // the rig has no data folder until it is given one: the relay needs it
    const withRelay = new LiveSessions({
      db: r.h.app.surau.db,
      now: r.h.clock.now,
      runtime: r.runtime,
      onKiosk: () => undefined,
      monitorMs: 3_600_000,
      camera: { get: () => r.camera.record, lastTest: LAST_TEST },
      youtube: yt,
      youtubeGraceMs: 0,
      dataDir: r.h.dataDir,
      relayOptions: { ffmpegPath: process.execPath, argsPrefix: ['-e', 'setInterval(() => {}, 1000)'], pollMs: 10, killAfterMs: 300 },
      mixerFactory: (mo) => new FakeMixer(mo),
      alignerFactory: (ao) => new FakeAligner(ao),
    });
    putFeature(r.h.app.surau.db, 'liveYoutube', { enabled: true, relayVideo: 'copy', maxBitrateKbps: 2500 }, 'test', undefined, 'sdm');
    const res = await withRelay.start({ kuliahId: r.h.kuliahId, source: 'android', outputs: { kiosk: true, youtube: true }, youtubeVia: 'box', video: 'external', videoPath: 'box' }, 'user:starter', 'dev-phone', '10.168.1.5');
    try {
      for (let i = 0; i < 300 && withRelay.status().relay.state === 'off'; i++) await new Promise((x) => setTimeout(x, 10));
      expect(withRelay.status().relay.state).not.toBe('off');
      cameraUp(r);
      // the camera's own bytes (surau-cam), averaged over 30 s: 10 s of samples give no verdict yet
      r.api.bytes['surau-cam'] = 0;
      await withRelay.tick();
      const feed = async (kbps: number, seconds: number): Promise<void> => {
        for (let i = 0; i < seconds / 2; i++) {
          r.h.clock.t += 2000;
          r.api.bytes['surau-cam'] = (r.api.bytes['surau-cam'] ?? 0) + (kbps * 1000 * 2) / 8;
          await withRelay.tick();
        }
      };
      await feed(10_000, 10);
      expect(withRelay.status().warnings).not.toContain('camera_bitrate_high');
      expect(withRelay.status().cameraKbps).toBeUndefined();
      // 40 s at 2.4 Mbps: under the maximum (the 10 s of 10 Mbps leave the 30 s window)
      await feed(2400, 40);
      expect(withRelay.status().cameraKbps).toBe(2400);
      expect(withRelay.status().warnings).not.toContain('camera_bitrate_high');
      // 40 s at 10 Mbps: the camera's main stream as it is
      await feed(10_000, 40);
      expect(withRelay.status().warnings).toContain('camera_bitrate_high');
      // "Kod semula" on a box that can encode brings it down itself: no warning
      putFeature(r.h.app.surau.db, 'liveYoutube', { relayVideo: 'reencode' }, 'test', undefined, 'sdm');
      expect(withRelay.status().warnings).not.toContain('camera_bitrate_high');
    } finally {
      await withRelay.stop(res.session.id, 'user:starter');
    }
  });
});

// 2026.11.15, Lane A task A7 (K2): a change of one TV's live profile during a live is announced, so that TV follows it.
describe('K2: a per-TV profile change mid-live is pushed', () => {
  it('announces again when one TV profile changes while the surau state is the same, and each TV gets its own view (success path)', async () => {
    const r = await rig();
    await r.start();
    cameraUp(r);
    await r.tick();
    const base = r.kiosk.length;
    expect(r.kiosk.at(-1)).toMatchObject({ live: true });
    // nothing changed: nothing is announced
    r.s.publishKiosk();
    expect(r.kiosk).toHaveLength(base);
    putFeature(r.h.app.surau.db, 'tvProfiles', { tvs: { 'tv-dewan': { live: { show: false } } } }, 'test', undefined, 'sdm');
    r.s.publishKiosk();
    expect(r.kiosk).toHaveLength(base + 1);
    // the surau state is as before; the one TV is told its own
    expect(r.kiosk.at(-1)).toMatchObject({ live: true });
    expect(r.s.liveForTv(r.kiosk.at(-1)!, 'tv-dewan').live).toBe(false);
    expect(r.s.liveForTv(r.kiosk.at(-1)!, 'tv-lain').live).toBe(true);
    putFeature(r.h.app.surau.db, 'tvProfiles', { tvs: { 'tv-dewan': { live: { show: true, audio: true, volume: 30 } } } }, 'test', undefined, 'sdm');
    r.s.publishKiosk();
    expect(r.kiosk).toHaveLength(base + 2);
    expect(r.s.liveForTv(r.kiosk.at(-1)!, 'tv-dewan')).toMatchObject({ live: true, audio: true, volume: 30 });
  });
});
