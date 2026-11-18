import { PassThrough } from 'node:stream';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddedAudioId, AlignState, LiveStartRequest } from '@surau/core';
import { putFeature } from '../src/settingsStore.ts';
import { LiveSessions, parseStartRequest } from '../src/live/sessions.ts';
import type { AlignerLike, CameraSource, MixerLike } from '../src/live/sessions.ts';
import { registerLiveRoutes } from '../src/live/routes.ts';
import { createLiveSecrets } from '../src/live/mediamtx.ts';
import type { LiveRuntime } from '../src/live/mediamtx.ts';
import { mixArgs } from '../src/live/mixer.ts';
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
  status(): MixerStatus {
    return { state: this.state, restarts: 0, lastError: null, stderrTail: [], unit: this.cfg?.unit ?? 'camera', channels: ['unit'], missing: [], commandsSent: 0, lastCommandError: null };
  }
  volumeOf(id: VolumeTarget): number[] {
    return this.volumes.filter(([x]) => x === id).map(([, v]) => v);
  }
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
}

function makeApi(): { api: FakeApi; impl: NonNullable<LiveRuntime['api']> } {
  const api: FakeApi = { users: new Map(), patches: [], ready: new Set(), tracks: {}, removed: [], failPatch: false };
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
      bytesReceived: 0,
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

async function rig(o: { camera?: Partial<Rig['camera']>; combiner?: NonNullable<ConstructorParameters<typeof LiveSessions>[0]['combiner']>; cameraSettings?: Record<string, unknown> } = {}): Promise<Rig> {
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
    alignerFactory: (ao) => {
      const a = new FakeAligner(ao);
      aligners.push(a);
      return a;
    },
    combiner: { fadeMs: 0, ...(o.combiner ?? {}) },
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
  it('waits for the picture, then starts the combiner with the unit, the plan and the aligner wired to it', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    cameraUp(r, true);
    await r.tick();
    expect(r.mixers).toHaveLength(1);
    const m = r.mixers[0]!;
    expect(m.o).toMatchObject({ rtspUser: expect.stringMatching(/^mix-/), headroomMs: 2000, maxFailures: 1_000_000 });
    expect(m.cfg).toMatchObject({ unit: 'camera', unitHasAudio: true, unitVolume: 100 });
    expect(m.cfg?.added).toEqual([{ id: 'deviceMic', initialDelayMs: 1000, volume: 80 }]);
    const a = r.aligners[0]!;
    expect(a.started).toBe(true);
    expect(a.o.monitor).toBe(m.monitor); // Mixer.monitor -> Aligner
    expect(a.o.added).toEqual(['deviceMic']);
    expect(a.o.maxLagMs).toBe(4000);
    a.o.apply('deviceMic', 2650); // Aligner.apply -> Mixer.setDelay
    expect(m.delays).toEqual([['deviceMic', 2650]]);
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
    expect(m.cfg?.added).toEqual([{ id: 'deviceMic', initialDelayMs: 2350, volume: 80 }]); // headroom + 350
    expect(r.aligners[0]!.states.get('deviceMic')).toBe('manual');
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

  it('the camera lost: the combiner waits (stopped); the camera back: a new combiner, the microphone held out again and searching', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    cameraUp(r, true);
    await r.tick();
    r.aligners[0]!.emit('deviceMic', 'locked');
    expect(r.mixers[0]!.volumeOf('deviceMic')).toEqual([80]);
    r.api.ready.delete('surau-cam');
    r.api.ready.delete('surau');
    await r.tick(3000);
    expect(r.mixers[0]!.stopped).toBe(true);
    expect(r.aligners[0]!.stopped).toBe(true);
    expect(r.mixers).toHaveLength(1);
    r.api.ready.add('surau-cam');
    r.api.ready.add('surau');
    await r.tick(3000);
    expect(r.mixers).toHaveLength(2);
    expect(r.aligners).toHaveLength(2);
    expect(r.aligners[1]!.state('deviceMic')).toBe('searching');
    expect(r.mixers[1]!.cfg?.added[0]).toMatchObject({ id: 'deviceMic', initialDelayMs: 1000 });
    expect(r.mixers[1]!.volumeOf('deviceMic')).toEqual([]); // held out until the new lock
  });

  it('a late state from a replaced combiner is ignored', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    cameraUp(r, true);
    await r.tick();
    const old = r.aligners[0]!;
    r.api.ready.delete('surau-cam');
    await r.tick(3000);
    old.emit('deviceMic', 'locked');
    expect(r.mixers[0]!.volumeOf('deviceMic')).toEqual([]);
  });
});

describe('hold-out and lock release', () => {
  it('holds the added microphone at 0 while the camera is audible and unlocked, releases it on the lock', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    cameraUp(r, true);
    await r.tick();
    const m = r.mixers[0]!;
    const a = r.aligners[0]!;
    expect(m.volumeOf('deviceMic')).toEqual([]); // the Mixer starts it at 0 (held) and nothing raised it
    a.emit('deviceMic', 'searching');
    a.emit('deviceMic', 'failed'); // no lock after 60 s: still held out
    expect(m.volumeOf('deviceMic')).toEqual([]);
    a.emit('deviceMic', 'locked');
    expect(m.volumeOf('deviceMic')).toEqual([80]);
    a.emit('deviceMic', 'holding'); // silence in the room: stays in
    expect(m.volumeOf('deviceMic')).toEqual([80]);
  });

  it('the release is a fade: steps rise to the user volume', async () => {
    const r = await rig({ combiner: { fadeMs: 60, fadeSteps: 4 } });
    await r.start({ audio: MIX_MIC });
    cameraUp(r, true);
    await r.tick();
    r.aligners[0]!.emit('deviceMic', 'locked');
    for (let i = 0; i < 100 && r.mixers[0]!.volumeOf('deviceMic').length < 4; i++) await new Promise((x) => setTimeout(x, 10));
    const v = r.mixers[0]!.volumeOf('deviceMic');
    expect(v).toHaveLength(4);
    expect(v.at(-1)).toBe(80);
    expect([...v].sort((a, b) => a - b)).toEqual(v);
  });

  it('with the camera volume at 0 ("mic only") nothing is held: the microphone plays at once and no hold-out command is sent', async () => {
    const r = await rig();
    await r.start({ audio: { ...MIX_MIC, camera: { enabled: true, volume: 0 } } });
    cameraUp(r, true);
    await r.tick();
    const m = r.mixers[0]!;
    expect(m.cfg).toMatchObject({ unitVolume: 0, unitHasAudio: true });
    expect(m.volumeOf('deviceMic')).toEqual([]);
    r.aligners[0]!.emit('deviceMic', 'failed');
    expect(m.volumeOf('deviceMic')).toEqual([]);
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
    expect(ok.json().audio.sources.map((x: { id: string }) => x.id)).toEqual(['camera', 'deviceMic']);
    expect((await post(app, 'dev-ipad', 'loud')).statusCode).toBe(400);
  });

  it('refuses when no live runs', async () => {
    const r = await rig();
    const app = await mini(r);
    expect((await post(app, 'dev-ipad', MIX_MIC)).statusCode).toBe(409);
  });

  it('a volume is a run-time command: no restart; a raised camera volume holds an unaligned microphone out again', async () => {
    const r = await rig();
    await r.start({ audio: { ...MIX_MIC, camera: { enabled: true, volume: 0 } } });
    cameraUp(r, true);
    await r.tick();
    const m = r.mixers[0]!;
    const app = await mini(r);
    // microphone volume only: the camera is silent, so nothing can double; the graph value follows at once
    expect((await post(app, 'dev-ipad', { ...MIX_MIC, camera: { enabled: true, volume: 0 }, deviceMic: { enabled: true, volume: 50 } })).statusCode).toBe(200);
    expect(r.mixers).toHaveLength(1);
    expect(m.volumeOf('deviceMic')).toEqual([50]);
    // the camera audible again while the microphone has no lock: the unit volume goes up and the microphone is held out (0)
    expect((await post(app, 'dev-ipad', { ...MIX_MIC, deviceMic: { enabled: true, volume: 50 } })).statusCode).toBe(200);
    expect(r.mixers).toHaveLength(1);
    expect(m.volumeOf('unit')).toEqual([100]);
    expect(m.volumeOf('deviceMic').at(-1)).toBe(0);
    // locked: released to the user's volume
    r.aligners[0]!.emit('deviceMic', 'locked');
    expect(m.volumeOf('deviceMic').at(-1)).toBe(50);
  });

  it('adding or removing a source restarts the combiner (the old one stops first); the new source goes through searching', async () => {
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
    expect(r.mixers[1]!.cfg?.added.map((a) => a.id)).toEqual(['deviceMic']);
    expect(r.s.status().audio?.sources.find((x) => x.id === 'deviceMic')?.align?.state).toBe('searching');
    // removed again
    expect((await post(app, 'dev-ipad', { ...MIX_MIC, deviceMic: { enabled: false, volume: 80 } })).statusCode).toBe(200);
    expect(r.mixers).toHaveLength(3);
    expect(r.mixers[2]!.cfg?.added).toEqual([]);
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
    expect(o.deviceName).toBe(real);
    const args = mixArgs({ unit: 'ingest', unitHasAudio: true, added: [{ id: 'boxInput', initialDelayMs: 0, volume: 60 }], unitVolume: 100, headroomMs: 2000, control: 'zmq', zmqPort: 30000, platform: 'windows', deviceName: o.deviceName! });
    expect(args).toContain(`audio=${real}`);
    expect(args).toContain('-sample_rate');
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
    expect(m.cfg).toMatchObject({ unit: 'ingest', unitHasAudio: true, unitVolume: 100 });
    expect(m.o).toMatchObject({ deviceName: 'Line In' });
    expect(m.cfg?.added.map((a) => a.id)).toEqual(['boxInput']);
    expect(r.aligners[0]!.o.added).toEqual(['boxInput']);
    r.aligners[0]!.emit('boxInput', 'locked');
    expect(m.volumeOf('boxInput')).toEqual([60]);
  });

  it('"Mic-in only" (every phone-side volume 0): the box takes the reference sound and mutes it', async () => {
    const r = await rig();
    r.inputAvailable.v = { deviceName: 'Line In' };
    await r.start({ source: 'android', youtubeVia: 'device', video: 'phone', audio: { camera: { enabled: false, volume: 100 }, deviceMic: { enabled: true, volume: 0 }, boxInput: { enabled: true, volume: 100 } } }, 'dev-phone');
    r.api.ready.add('surau-in');
    await r.tick();
    expect(r.mixers[0]!.cfg).toMatchObject({ unit: 'ingest', unitHasAudio: true, unitVolume: 0 });
    expect(r.aligners[0]!.o.added).toEqual(['boxInput']); // still aligned: the phone sends the reference
  });

  it('without a capture device the choice is dropped: an ordinary phone live', async () => {
    const r = await rig();
    const res = await r.start({ source: 'android', youtubeVia: 'device', video: 'phone', audio: { ...MIX_MIC, boxInput: { enabled: true, volume: 100 } } }, 'dev-phone');
    expect(res.ingest.path).toBe('surau');
    expect(r.api.users.size).toBe(1);
  });
});

describe('status (plan 4.7)', () => {
  it('reports the video, one row per source with its state, volume and alignment; the chip follows the aligner', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    // before the picture: the camera has not been seen yet
    let st = r.s.status();
    expect(st.video).toBe('external');
    expect(st.audio?.sources.map((x) => [x.id, x.volume, x.state])).toEqual([
      ['camera', 100, 'ok'],
      ['deviceMic', 80, 'ok'],
    ]);
    expect(st.audio?.sources[1]?.align).toEqual({ state: 'searching', delayMs: 1000 });
    cameraUp(r, true);
    await r.tick();
    st = r.s.status();
    expect(st.warnings).toContain('audio_align_searching');
    r.aligners[0]!.emit('deviceMic', 'failed');
    st = r.s.status();
    expect(st.warnings).toContain('audio_align_failed');
    expect(st.audio?.sources[1]?.align).toMatchObject({ state: 'failed', delayMs: 1234 });
    r.aligners[0]!.emit('deviceMic', 'locked');
    st = r.s.status();
    expect(st.warnings).not.toContain('audio_align_failed');
    expect(st.warnings).not.toContain('audio_align_searching');
    expect(st.audio?.sources[1]?.align?.state).toBe('locked');
    expect(st.audio?.sources[0]?.align).toBeUndefined(); // only added sources align
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

  it('ends the live after 10 minutes without the camera (reason camera_lost), not before', async () => {
    const r = await rig();
    const id = (await r.start()).session.id;
    cameraUp(r);
    await r.tick();
    r.api.ready.delete('surau-cam');
    r.api.ready.delete('surau');
    const poll = (): void => r.s.heartbeat('dev-ipad'); // the iPad is still there
    await r.tick(3000);
    poll();
    await r.tick(9 * 60_000);
    poll();
    expect(r.s.current()?.id).toBe(id);
    await r.tick(61_000);
    expect(r.s.current()).toBeNull();
    const rows = r.h.app.surau.db.prepare("SELECT after_json FROM change_log WHERE entity = 'live' AND entity_id = ? ORDER BY id").all(id) as Array<{ after_json: string }>;
    expect(JSON.parse(rows.at(-1)!.after_json)).toMatchObject({ reason: 'camera_lost' });
    expect(r.mixers[0]!.stopped).toBe(true);
  });

  it('a camera that never came ends the live too, after 10 minutes', async () => {
    const r = await rig();
    await r.start();
    r.s.heartbeat('dev-ipad');
    await r.tick(9 * 60_000);
    r.s.heartbeat('dev-ipad');
    expect(r.s.current()).not.toBeNull();
    await r.tick(61_000);
    expect(r.s.current()).toBeNull();
  });

  it('the controller heartbeat: the starter polling keeps a box-pulled live; another device does not; 10 minutes of silence ends it (controller_lost)', async () => {
    const r = await rig();
    const id = (await r.start()).session.id;
    cameraUp(r);
    await r.tick();
    for (let i = 0; i < 4; i++) {
      r.s.heartbeat('dev-ipad');
      await r.tick(4 * 60_000);
    }
    expect(r.s.current()?.id).toBe(id); // 16 minutes, polled every 4
    // another device polling does not count
    for (let i = 0; i < 3; i++) {
      r.s.heartbeat('dev-other');
      await r.tick(4 * 60_000);
    }
    expect(r.s.current()).toBeNull();
    const rows = r.h.app.surau.db.prepare("SELECT after_json FROM change_log WHERE entity = 'live' AND entity_id = ? ORDER BY id").all(id) as Array<{ after_json: string }>;
    expect(JSON.parse(rows.at(-1)!.after_json)).toMatchObject({ reason: 'controller_lost' });
  });

  it('the status route is the heartbeat, for the starting device only', async () => {
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
    r.h.clock.t += 9 * 60_000;
    await app.inject({ method: 'GET', url: '/api/live/status', headers: { 'x-device': 'dev-ipad' } });
    await r.tick(2 * 60_000);
    expect(r.s.current()).not.toBeNull(); // the poll of the starter moved the deadline
    await app.inject({ method: 'GET', url: '/api/live/status', headers: { 'x-device': 'dev-other' } });
    await r.tick(9 * 60_000);
    expect(r.s.current()).toBeNull(); // the other device's poll did not
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

  it('refuses a bad video value and a switch on a live the box does not pull', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    await expect(r.s.changeAudio('dev-ipad', { audio: audio(), video: 'ndi' })).rejects.toMatchObject({ status: 400 });
    await r.s.stop(undefined, 'user:starter', 'user');
    const phone = await r.start({ source: 'android', youtubeVia: 'device', video: 'phone' }, 'dev-phone');
    expect(phone.ingest.path).toBe('surau');
    await expect(r.s.changeAudio('dev-phone', { audio: audio(), video: 'external' })).rejects.toMatchObject({ status: 409 });
  });

  it('avOffsetMs: validated 0..2000 step 50, and a running manual combiner gets headroom + offset as the delay', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    r.api.ready.add('surau-cam');
    r.api.ready.add('surau-mic');
    r.api.tracks['surau-cam'] = ['H264']; // no camera audio: the fallback
    await r.tick();
    const m = r.mixers[0]!;
    expect(m.cfg?.added).toEqual([{ id: 'deviceMic', initialDelayMs: 2000, volume: 80 }]);
    for (const bad of [-50, 2050, 25, 1.5, '300', null]) {
      await expect(r.s.changeAudio('dev-ipad', { audio: audio(), avOffsetMs: bad })).rejects.toMatchObject({ status: 400 });
    }
    expect(m.delays).toEqual([]);
    const st = await r.s.changeAudio('dev-ipad', { audio: audio(), avOffsetMs: 350 });
    expect(m.delays).toEqual([['deviceMic', 2350]]);
    expect(r.mixers).toHaveLength(1); // no restart
    expect(st.audio?.sources.find((x) => x.id === 'deviceMic')?.align).toMatchObject({ state: 'manual', delayMs: 2350 });
    await r.s.changeAudio('dev-ipad', { audio: audio(), avOffsetMs: 0 });
    expect(m.delays.at(-1)).toEqual(['deviceMic', 2000]);
  });

  it('level meters: RMS dBFS per source from the monitor, absent before the first window and after the combiner goes', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    cameraUp(r, true);
    await r.tick();
    const m = r.mixers[0]!;
    expect(r.s.status().audio?.sources.every((x) => x.level === undefined)).toBe(true);
    // 0.5 s of 16 kHz stereo (unit, deviceMic): unit at half scale (-6.0 dBFS), mic silent
    const frames = 8000;
    const buf = Buffer.alloc(frames * 4);
    for (let f = 0; f < frames; f++) {
      buf.writeInt16LE(f % 2 === 0 ? 16384 : -16384, f * 4);
      buf.writeInt16LE(0, f * 4 + 2);
    }
    m.monitor.write(buf);
    await new Promise((res) => setImmediate(res));
    const src = r.s.status().audio!.sources;
    expect(src.find((x) => x.id === 'camera')?.level).toBeCloseTo(-6, 0);
    expect(src.find((x) => x.id === 'deviceMic')?.level).toBe(-90);
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

  it('a silent reference (phone mic off, camera sound off) is aligned by hand: manual mode, headroom plus the saved offset; the own track of the stream stays consumed at volume 0', async () => {
    const r = await rig({ camera: { lastTest: { ...LAST_TEST, hasAudio: false, codecs: ['H264'] } }, cameraSettings: { avOffsetMs: { deviceMic: 0, boxInput: 450 } } });
    r.inputAvailable.v = { deviceName: 'Line In' };
    await r.start(ANDROID_EXT({ camera: { enabled: false, volume: 100 }, deviceMic: { enabled: false, volume: 100 }, boxInput: { enabled: true, volume: 100 } }), 'dev-phone');
    r.api.ready.add('surau-in');
    await r.tick();
    const m = r.mixers[0]!;
    expect(m.cfg).toMatchObject({ unit: 'ingest', unitHasAudio: true, unitVolume: 0 }); // the track is still consumed (T0 rule), at volume 0
    expect(m.cfg?.added).toEqual([{ id: 'boxInput', initialDelayMs: 2450, volume: 100 }]);
    expect(r.aligners[0]!.states.get('boxInput')).toBe('manual');
    expect(r.s.status().warnings).not.toContain('audio_align_searching');
  });

  it('a device stream with a picture and no sound track uses the silent reference and manual alignment', async () => {
    const r = await rig();
    r.inputAvailable.v = { deviceName: 'Line In' };
    await r.start({ source: 'android', youtubeVia: 'device', video: 'phone', audio: { camera: { enabled: false, volume: 100 }, deviceMic: { enabled: true, volume: 100 }, boxInput: { enabled: true, volume: 100 } } }, 'dev-phone');
    r.api.ready.add('surau-in');
    r.api.tracks['surau-in'] = ['H264'];
    await r.tick();
    expect(r.mixers[0]!.cfg).toMatchObject({ unit: 'ingest', unitHasAudio: false });
    expect(r.aligners[0]!.states.get('boxInput')).toBe('manual');
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
