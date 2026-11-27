import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import type { MixerOptions, MixerStartConfig, MixerStatus, VolumeTarget } from '../src/live/mixer.ts';
import { AudioInputs, parseDshowAudioDevices } from '../src/live/audioInputs.ts';
import type { AlignerOptions } from '../src/live/align.ts';
import type { LiveLogLike } from '../src/live/liveLog.ts';
import { createLiveSessionStore } from '../src/live/sessionStore.ts';
import { loginAs } from './authHelpers.ts';
import { startBody, startLiveHarness, changeLogText } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';

/* Rectification of the live lanes (build 4): a box-pulled live has no automatic end, the box microphone is the main sound,
   the output watchdog and its escalation, the camera bitrate, no picture on devices, the AAC rendition, the live log and the
   Skrin switches. Sessions built on a fake MediaMTX API, a fake combiner and a fake aligner. Test values only. */

const CAM_USER = 'camuser';
const CAM_PASS = 'Cam-Pa55word9';
const CAM_URL = `rtsp://${CAM_USER}:${CAM_PASS}@192.0.2.60:554/stream1`;

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
  restarts = 0;
  kicks: string[] = [];
  /** The reason of the last stall (a test that sets `stalls` by hand means a silent monitor). */
  lastReason = 'monitor_silent';
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
    this.lastReason = reason;
    this.stalls += 1;
  }
  status(): MixerStatus {
    return { state: this.state, restarts: this.restarts, lastError: null, stderrTail: [], unit: this.cfg?.unit ?? 'camera', channels: ['unit'], missing: [], commandsSent: 0, lastCommandError: null, stalls: this.stalls, lastStall: this.stalls > 0 ? { reason: this.lastReason, atMs: 0 } : null };
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
    start: (over = {}, device = 'dev-ipad') => s.start(baseReq(over), 'user:starter', device, '192.0.2.5'),
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


const MIX_BOX = { camera: { enabled: true, volume: 100 }, deviceMic: { enabled: false, volume: 100 }, boxInput: { enabled: true, volume: 100 } };
const JACK = { deviceName: 'Line In' };
const sec = (n: number): number => n * 1000;
const lastReason = (r: Rig, id: string): unknown => {
  const rows = r.h.app.surau.db.prepare("SELECT after_json FROM change_log WHERE entity = 'live' AND entity_id = ? ORDER BY id").all(id) as Array<{ after_json: string }>;
  return (JSON.parse(rows.at(-1)!.after_json) as { reason?: unknown }).reason;
};

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const settle = (ms: number): Promise<void> => new Promise((x) => setTimeout(x, ms));

/** A route app over the rig's sessions with a fake sign-in: the device and roles come from request headers. */
async function routeApp(r: Rig): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    (req as unknown as { auth: unknown }).auth = { kind: 'user', userId: `u-${String(req.headers['x-device'])}`, deviceId: req.headers['x-device'], roles: String(req.headers['x-roles'] ?? 'live').split(',') };
  });
  registerLiveRoutes(app, { sessions: r.s, proxy: {} as never, lanIps: [] });
  await app.ready();
  minis.push(app);
  return app;
}
const asDevice = (device: string, roles = 'live'): Record<string, string> => ({ 'x-device': device, 'x-roles': roles });

describe('A1, A2, K2: a box-pulled live has no automatic end', () => {
  it('camera gone, no output and no poll for 3 hours (fake time): still open, nothing in the record', async () => {
    const r = await rig();
    const id = (await r.start()).session.id;
    cameraUp(r);
    await r.tick();
    r.api.ready.delete('surau-cam');
    r.api.ready.delete('surau');
    for (let i = 0; i < 18; i++) await r.tick(10 * 60_000);
    expect(r.s.current()?.id).toBe(id);
    expect(r.s.status().session).not.toBeNull();
    const warnings = r.s.status().warnings;
    expect(warnings).toContain('no_video_from_camera');
    expect(warnings).toContain('controller_quiet');
    // a person's Stop ends it
    await r.s.stop(id, 'user:starter');
    expect(lastReason(r, id)).toBe('stopped');
  });

  it('a camera that never came and a silent controller: still open after 6 hours', async () => {
    const r = await rig();
    const id = (await r.start()).session.id;
    for (let i = 0; i < 12; i++) await r.tick(30 * 60_000);
    expect(r.s.current()?.id).toBe(id);
  });

  it('device-sourced lives keep ending as before: orphan (no picture, no poll 90 s) and timeout (no picture 10 minutes, polled)', async () => {
    const orphan = await rig();
    const id1 = (await orphan.start({ source: 'android', youtubeVia: 'device' }, 'dev-phone')).session.id;
    await orphan.tick(89_000);
    expect(orphan.s.current()?.id).toBe(id1);
    await orphan.tick(2_000);
    expect(orphan.s.current()).toBeNull();
    expect(lastReason(orphan, id1)).toBe('controller_lost');

    const idle = await rig();
    const id2 = (await idle.start({ source: 'android', youtubeVia: 'device' }, 'dev-phone')).session.id;
    for (let i = 0; i < 10; i++) {
      idle.s.heartbeat('dev-phone');
      await idle.tick(59_000);
    }
    expect(idle.s.current()?.id).toBe(id2);
    idle.s.heartbeat('dev-phone');
    await idle.tick(30_000);
    expect(idle.s.current()).toBeNull();
    expect(lastReason(idle, id2)).toBe('timeout');
  });
});

describe('A4, K1: stopping a box-pulled live', () => {
  const emergencyRows = (r: Rig): Array<{ actor: string; after: Record<string, unknown> }> =>
    (r.h.app.surau.db.prepare("SELECT actor, after_json FROM change_log WHERE entity = 'live' AND entity_id = 'emergency-stop'").all() as Array<{ actor: string; after_json: string }>).map((x) => ({
      actor: x.actor,
      after: JSON.parse(x.after_json) as Record<string, unknown>,
    }));

  it('another device with live:control stops a box-pulled live, and the change log names the starter and the stopper', async () => {
    const r = await rig();
    const id = (await r.start()).session.id;
    expect(r.s.current()).toMatchObject({ id, boxPulled: true });
    const app = await routeApp(r);
    const res = await app.inject({ method: 'POST', url: '/api/live/stop', headers: asDevice('dev-other'), payload: { sessionId: id } });
    expect(res.json()).toMatchObject({ stopped: true });
    expect(r.s.current()).toBeNull();
    const rows = emergencyRows(r);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after).toMatchObject({ sessionId: id, startedBy: 'user:starter', stoppedBy: 'user:u-dev-other' });
  });

  it('a user without live:control is refused; a device-sourced live is still refused (403 not_owner) to a second device', async () => {
    const r = await rig();
    const id = (await r.start()).session.id;
    const app = await routeApp(r);
    const refused = await app.inject({ method: 'POST', url: '/api/live/stop', headers: asDevice('dev-other', 'media'), payload: { sessionId: id } });
    expect(refused.statusCode).toBe(403);
    expect(r.s.current()?.id).toBe(id);

    const phone = await rig();
    const pid = (await phone.start({ source: 'android', youtubeVia: 'device' }, 'dev-phone')).session.id;
    expect(phone.s.current()).toMatchObject({ id: pid, boxPulled: false });
    const app2 = await routeApp(phone);
    const no = await app2.inject({ method: 'POST', url: '/api/live/stop', headers: asDevice('dev-other'), payload: { sessionId: pid } });
    expect(no.statusCode).toBe(403);
    expect(no.json().code).toBe('not_owner');
    expect(phone.s.current()?.id).toBe(pid);
    expect(emergencyRows(phone)).toHaveLength(0);
  });

  it('the starter stopping its own live is no emergency', async () => {
    const r = await rig();
    const id = (await r.start()).session.id;
    const app = await routeApp(r);
    await app.inject({ method: 'POST', url: '/api/live/stop', headers: asDevice('dev-ipad'), payload: { sessionId: id } });
    expect(emergencyRows(r)).toHaveLength(0);
  });
});

describe('A3: controller quiet', () => {
  it('the starter silent for 10 minutes while a second device polls every 2 s: the second device sees the warning; one starter poll clears it', async () => {
    const r = await rig();
    await r.start();
    cameraUp(r);
    await r.tick();
    const app = await routeApp(r);
    const poll = (device: string) => app.inject({ method: 'GET', url: '/api/live/status', headers: asDevice(device) });
    for (let i = 0; i < 299; i++) {
      r.h.clock.t += 2000;
      const st = (await poll('dev-other')).json();
      expect(st.warnings, `at ${(i + 1) * 2} s`).not.toContain('controller_quiet');
    }
    // 10 minutes (600 s) have passed since the starter's last poll
    r.h.clock.t += 2000;
    const quiet = (await poll('dev-other')).json();
    expect(quiet.warnings).toContain('controller_quiet');
    expect(quiet.controllerQuietSeconds).toBeGreaterThanOrEqual(600);
    // the second device keeps polling: still quiet
    r.h.clock.t += 2000;
    expect((await poll('dev-other')).json().warnings).toContain('controller_quiet');
    // one poll of the starter clears it (the route heartbeats before it reads the status)
    const mine = (await poll('dev-ipad')).json();
    expect(mine.warnings).not.toContain('controller_quiet');
    expect(mine.controllerQuietSeconds).toBe(0);
    expect((await poll('dev-other')).json().warnings).not.toContain('controller_quiet');
  });

  it('a device-sourced live reports no quiet notice', async () => {
    const r = await rig();
    await r.start({ source: 'android', youtubeVia: 'device' }, 'dev-phone');
    r.api.ready.add('surau');
    r.s.heartbeat('dev-phone');
    r.h.clock.t += 11 * 60_000;
    expect(r.s.status().warnings).not.toContain('controller_quiet');
    expect(r.s.status().controllerQuietSeconds).toBe(0);
  });
});

describe('A9 to A12: the box jack microphone is the main sound', () => {
  it('is never held out of the mix, from the first launch and after a relaunch; build 6: the device microphone neither (one sound, no aligner)', async () => {
    const r = await rig();
    r.inputAvailable.v = JACK;
    await r.start({ audio: MIX_BOX });
    cameraUp(r);
    await r.tick();
    const first = r.mixers.at(-1)!;
    expect(first.cfg?.added).toEqual([expect.objectContaining({ id: 'boxInput', volume: 100, held: false })]);
    expect(first.volumeOf('boxInput')).not.toContain(0);
    // the camera drops and comes back: a new combiner, the same rule
    r.api.ready.delete('surau-cam');
    await r.tick(3000);
    cameraUp(r);
    await r.tick(3000);
    const second = r.mixers.at(-1)!;
    expect(second).not.toBe(first);
    expect(second.cfg?.added[0]).toMatchObject({ id: 'boxInput', held: false });
    expect(second.volumeOf('boxInput')).not.toContain(0);
    expect(r.aligners).toHaveLength(0);

    // the iPad microphone as the one sound: never held either
    const mic = await rig();
    await mic.start({ audio: MIX_MIC });
    cameraUp(mic, true);
    await mic.tick();
    const m = mic.mixers.at(-1)!;
    expect(m.cfg?.added[0]).toMatchObject({ id: 'deviceMic', held: false });
    expect(m.volumeOf('deviceMic')).not.toContain(0);
    expect(mic.aligners).toHaveLength(0);
  });

  it('a request with no audio block on a box with a jack input: the box microphone at 100 is the one sound; without a jack input the old default', async () => {
    const r = await rig();
    r.inputAvailable.v = JACK;
    await r.start();
    cameraUp(r);
    await r.tick();
    expect(r.mixers[0]!.cfg).toMatchObject({ unit: 'camera' });
    expect(r.mixers[0]!.cfg?.added).toEqual([expect.objectContaining({ id: 'boxInput', volume: 100, held: false })]);
    const sources = r.s.status().audio!.sources;
    expect(sources.find((x) => x.id === 'camera')).toBeUndefined(); // build 6: one sound, the camera's is not in the live
    expect(sources.find((x) => x.id === 'boxInput')).toMatchObject({ enabled: true, volume: 100 });

    const none = await rig();
    await none.start();
    cameraUp(none);
    await none.tick();
    expect(none.mixers[0]!.cfg).toMatchObject({ unitVolume: 100 });
    expect(none.mixers[0]!.cfg?.added).toEqual([]);
  });

  it('build 6: starts at the box microphone offset of the settings as the join delay, the same in every live (no measured delay)', async () => {
    const r = await rig({ cameraSettings: { avOffsetMs: { boxInput: 150 } } });
    r.inputAvailable.v = JACK;
    const id = (await r.start()).session.id;
    cameraUp(r);
    await r.tick();
    expect(r.mixers[0]!.cfg?.added[0]!.initialDelayMs).toBe(150);
    await r.s.stop(id, 'user:starter');
    await r.s.settled();
    await r.start();
    cameraUp(r);
    await r.tick();
    expect(r.mixers.at(-1)!.cfg?.added[0]!.initialDelayMs).toBe(150);
    expect(r.aligners).toHaveLength(0);
  });

  it('avOffsetMs for the box microphone reaches the solo path as its join delay and shows as manual; 0 to 2000 in steps of 50 only', async () => {
    const r = await rig();
    r.inputAvailable.v = JACK;
    await r.start({ audio: MIX_BOX });
    cameraUp(r);
    await r.tick();
    const st = await r.s.changeAudio('dev-ipad', { audio: MIX_BOX, avOffsetMs: 300, avOffsetId: 'boxInput' });
    expect(r.mixers[0]!.delays).toEqual([['boxInput', 300]]);
    expect(st.audio!.sources.find((x) => x.id === 'boxInput')!.align).toEqual({ state: 'manual', delayMs: 300 });
    expect(r.mixers).toHaveLength(1);
    // the offset survives a relaunch of the combiner
    r.api.ready.delete('surau-cam');
    await r.tick(3000);
    cameraUp(r);
    await r.tick(3000);
    expect(r.mixers.at(-1)!.cfg?.added[0]!.initialDelayMs).toBe(300);
    for (const bad of [25, 2050, -50, 1.5, '300']) {
      await expect(r.s.changeAudio('dev-ipad', { audio: MIX_BOX, avOffsetMs: bad })).rejects.toMatchObject({ status: 400 });
    }
    await expect(r.s.changeAudio('dev-ipad', { audio: MIX_BOX, avOffsetMs: 100, avOffsetId: 'camera' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('avOffsetMs null: back to the setting or the default (build 6: was "back to automatic")', () => {
  it('the box microphone: manual 600, then null gives the default join delay, never held, and a relaunch keeps it', async () => {
    const r = await rig();
    r.inputAvailable.v = JACK;
    await r.start({ audio: MIX_BOX });
    cameraUp(r);
    await r.tick();
    const manual = await r.s.changeAudio('dev-ipad', { audio: MIX_BOX, avOffsetMs: 600, avOffsetId: 'boxInput' });
    expect(manual.audio!.sources.find((x) => x.id === 'boxInput')!.align).toEqual({ state: 'manual', delayMs: 600 });
    const back = await r.s.changeAudio('dev-ipad', { audio: MIX_BOX, avOffsetMs: null, avOffsetId: 'boxInput' });
    expect(r.mixers[0]!.delays).toEqual([['boxInput', 600], ['boxInput', 400]]);
    expect(back.audio!.sources.find((x) => x.id === 'boxInput')!.align).toEqual({ state: 'manual', delayMs: 400 });
    expect(r.mixers[0]!.volumeOf('boxInput')).not.toContain(0);
    expect(r.mixers).toHaveLength(1);
    // a relaunch starts at the default too (no hand-set offset any more)
    r.api.ready.delete('surau-cam');
    await r.tick(3000);
    cameraUp(r);
    await r.tick(3000);
    expect(r.mixers.at(-1)!.cfg?.added[0]!.initialDelayMs).toBe(400);
  });

  it('the device microphone: a hand-set value then null goes back to the saved setting; a bad id is refused', async () => {
    const r = await rig({ cameraSettings: { avOffsetMs: { deviceMic: 250 } } });
    await r.start({ audio: MIX_MIC });
    cameraUp(r, true);
    await r.tick();
    await r.s.changeAudio('dev-ipad', { audio: MIX_MIC, avOffsetMs: 600, avOffsetId: 'deviceMic' });
    const st = await r.s.changeAudio('dev-ipad', { audio: MIX_MIC, avOffsetMs: null, avOffsetId: 'deviceMic' });
    expect(r.mixers[0]!.delays).toEqual([['deviceMic', 600], ['deviceMic', 250]]);
    expect(st.audio!.sources.find((x) => x.id === 'deviceMic')!.align).toEqual({ state: 'manual', delayMs: 250 });
    await expect(r.s.changeAudio('dev-ipad', { audio: MIX_MIC, avOffsetMs: null, avOffsetId: 'camera' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('A7, A8: the output watchdog and its escalation', () => {
  it('kicks the combiner when the output is not there for 15 s, once, not on every tick; never while the output grows', async () => {
    const r = await rig();
    await r.start();
    r.api.ready.add('surau-cam'); // the unit is ready, the output is not
    r.api.tracks['surau-cam'] = ['H264', 'MPEG-4 Audio'];
    await r.tick();
    const mixer = r.mixers[0]!;
    await r.tick(sec(10));
    await r.tick(sec(10));
    await r.tick(sec(10));
    expect(mixer.kicks).toEqual([]); // 30 s: inside the 35 s grace of the run
    await r.tick(sec(6));
    expect(mixer.kicks).toEqual(['no_output']);
    await r.tick(sec(2));
    await r.tick(sec(30));
    expect(mixer.kicks).toHaveLength(1); // 32 s since the kick: not yet 35 s
    await r.tick(sec(4));
    expect(mixer.kicks).toHaveLength(2);

    const ok = await rig();
    await ok.start();
    cameraUp(ok);
    ok.api.bytes.surau = 0;
    await ok.tick();
    for (let i = 0; i < 60; i++) {
      ok.api.bytes.surau += 40_000;
      await ok.tick(sec(2));
    }
    expect(ok.mixers[0]!.kicks).toEqual([]);
  });

  it('kicks when the output is ready but its byte count has not moved for 15 s', async () => {
    const r = await rig();
    await r.start();
    cameraUp(r);
    r.api.bytes.surau = 5000;
    await r.tick();
    for (let i = 0; i < 17; i++) await r.tick(sec(2));
    expect(r.mixers[0]!.kicks).toEqual([]);
    await r.tick(sec(4));
    expect(r.mixers[0]!.kicks).toEqual(['no_output']);
  });

  it('does not kick a combiner that is retrying by itself', async () => {
    const r = await rig();
    await r.start();
    r.api.ready.add('surau-cam');
    r.api.tracks['surau-cam'] = ['H264', 'MPEG-4 Audio'];
    await r.tick();
    r.mixers[0]!.state = 'retrying';
    await r.tick(sec(40));
    expect(r.mixers[0]!.kicks).toEqual([]);
  });

  it('two stalls inside 2 minutes bench the box microphone for 60 s: no capture input, the camera sound audible, audio_source_lost; then it comes back', async () => {
    const r = await rig();
    r.inputAvailable.v = JACK;
    await r.start();
    cameraUp(r);
    r.api.bytes.surau = 1;
    r.api.bytes['surau-cam'] = 5_000;
    await r.tick();
    expect(r.mixers[0]!.cfg?.added.map((a) => a.id)).toEqual(['boxInput']);
    expect(r.mixers[0]!.cfg?.unitVolume).toBe(0);
    r.mixers[0]!.stalls = 1;
    r.api.bytes.surau += 10;
    r.api.bytes['surau-cam'] += 5_000;
    await r.tick(sec(10));
    expect(r.mixers).toHaveLength(1); // one stall is not enough
    r.mixers[0]!.stalls = 2;
    r.api.bytes.surau += 10;
    r.api.bytes['surau-cam'] += 10_000;
    await r.tick(sec(10));
    expect(r.mixers).toHaveLength(2);
    expect(r.mixers[1]!.cfg?.added).toEqual([]);
    expect(r.mixers[1]!.cfg?.unitVolume).toBe(100);
    expect(r.s.status().warnings).toContain('audio_source_lost');
    expect(r.mixers[1]!.o.deviceName).toBeUndefined(); // no capture input in the graph
    // after a minute the microphone is tried again
    cameraUp(r);
    r.api.bytes.surau += 10;
    await r.tick(sec(61));
    expect(r.mixers).toHaveLength(3);
    expect(r.mixers[2]!.cfg?.added.map((a) => a.id)).toEqual(['boxInput']);
    expect(r.mixers[2]!.cfg?.unitVolume).toBe(0);
    expect(r.mixers[2]!.o.deviceName).toBe('Line In');
    expect(r.s.status().warnings).not.toContain('audio_source_lost');
  });

  it('two stalls two minutes apart do not bench', async () => {
    const r = await rig();
    r.inputAvailable.v = JACK;
    await r.start();
    cameraUp(r);
    r.api.bytes.surau = 1;
    r.api.bytes['surau-cam'] = 5_000;
    await r.tick();
    r.mixers[0]!.stalls = 1;
    r.api.bytes.surau += 10;
    r.api.bytes['surau-cam'] += 10_000;
    await r.tick(sec(10));
    r.api.bytes.surau += 10;
    await r.tick(sec(125));
    r.mixers[0]!.stalls = 2;
    r.api.bytes.surau += 10;
    r.api.bytes['surau-cam'] += 10_000;
    await r.tick(sec(2));
    expect(r.mixers).toHaveLength(1);
  });

  it('B3: kicks for no output and stalls while the camera is silent never bench the box microphone', async () => {
    const r = await rig();
    r.inputAvailable.v = JACK;
    await r.start();
    cameraUp(r);
    r.api.bytes.surau = 1;
    r.api.bytes['surau-cam'] = 10_000;
    await r.tick();
    // two no_output kicks with the camera growing: no bench
    r.mixers[0]!.kick('no_output');
    r.api.bytes['surau-cam'] += 10_000;
    await r.tick(sec(4));
    r.mixers[0]!.kick('no_output');
    r.api.bytes['surau-cam'] += 10_000;
    await r.tick(sec(4));
    expect(r.mixers).toHaveLength(1);
    // two silent-monitor stalls while the camera bytes stand still: no bench either
    await r.tick(sec(30)); // the camera bytes did not move for 30 s
    r.mixers[0]!.lastReason = 'monitor_silent';
    r.mixers[0]!.stalls += 1;
    await r.tick(sec(2));
    r.mixers[0]!.stalls += 1;
    await r.tick(sec(2));
    expect(r.mixers).toHaveLength(1);
    // two silent-monitor stalls with the camera growing do bench
    r.api.bytes['surau-cam'] += 10_000;
    await r.tick(sec(2));
    r.mixers[0]!.stalls += 1;
    r.api.bytes['surau-cam'] += 10_000;
    await r.tick(sec(2));
    r.mixers[0]!.stalls += 1;
    r.api.bytes['surau-cam'] += 10_000;
    await r.tick(sec(2));
    expect(r.mixers).toHaveLength(2);
    expect(r.mixers[1]!.cfg?.added).toEqual([]);
  });
});

describe('A14: no picture on devices during a box-pulled live', () => {
  it('a joiner and an Android owner get 409 preview_off; the iPad (web) owner is served; on the iPad camera the refusal goes away', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    expect(() => r.s.previewFor('dev-other')).toThrowError(expect.objectContaining({ status: 409, code: 'preview_off' }));
    expect(r.s.previewFor('dev-ipad')).toMatchObject({ path: 'surau' });

    const phone = await rig();
    await phone.start({ source: 'android', youtubeVia: 'box', videoPath: 'box', audio: MIX_MIC }, 'dev-phone');
    expect(phone.s.current()).toMatchObject({ boxPulled: true });
    expect(() => phone.s.previewFor('dev-phone')).toThrowError(expect.objectContaining({ status: 409, code: 'preview_off' }));
    expect(() => phone.s.previewFor('dev-other')).toThrowError(expect.objectContaining({ status: 409, code: 'preview_off' }));
    // the owner switches to the phone's own camera: it is a device-sourced live now
    await phone.s.changeAudio('dev-phone', { audio: MIX_MIC, video: 'phone' });
    expect(phone.s.previewFor('dev-phone')).toMatchObject({ path: 'surau' });
  });

  it('a live the phone runs itself still lets other devices join the shared picture', async () => {
    const r = await rig();
    await r.start({ source: 'android', youtubeVia: 'device' }, 'dev-phone');
    expect(r.s.previewFor('dev-other')).toMatchObject({ path: 'surau', max: 1 });
  });
});

describe('A16, A17, A19: the camera bitrate', () => {
  const feed = async (r: Rig, kbps: number, seconds: number, tickMs = 2000): Promise<void> => {
    for (let i = 0; i < seconds / (tickMs / 1000); i++) {
      r.api.bytes['surau-cam'] = (r.api.bytes['surau-cam'] ?? 0) + (kbps * 1000 * (tickMs / 1000)) / 8;
      await r.tick(tickMs);
    }
  };

  it('cameraKbps is the 30 s average of the camera path: absent before 20 s, steady after, bursts averaged', async () => {
    const r = await rig();
    await r.start();
    cameraUp(r);
    r.api.bytes['surau-cam'] = 0;
    await r.tick();
    await feed(r, 1100, 18);
    expect(r.s.status().cameraKbps).toBeUndefined();
    await feed(r, 1100, 30);
    expect(r.s.status().cameraKbps).toBe(1100);
    // 2 s bursts of 4000 kbps in a 10 s cycle that averages 1100
    for (let c = 0; c < 6; c++) {
      await feed(r, 4000, 2);
      await feed(r, 375, 8);
    }
    expect(r.s.status().cameraKbps).toBeGreaterThan(1000);
    expect(r.s.status().cameraKbps).toBeLessThan(1250);
    // the output number is a different one and stays what it was
    expect(r.s.status().ingest.bitrateKbps).toBe(0);
  });

  /** A box-pulled live with a copy relay (the warning is only for that case), with a stand-in for ffmpeg. */
  async function relayRig(): Promise<{ r: Rig; sessions: LiveSessions; stop: () => Promise<void> }> {
    const yt: YoutubeLeg = {
      signedIn: () => true,
      createBroadcastFor: async () => ({ broadcastId: 'bc1', watchUrl: 'https://youtu.be/bc1', key: 'abcd-efgh-ijkl-mnop-qrst' }),
      complete: async () => undefined,
      status: () => ({ signedIn: true, channelTitle: 'Surau', broadcastId: 'bc1', state: 'created', health: null, watchUrl: null, lastError: null }),
    };
    const r = await rig();
    putFeature(r.h.app.surau.db, 'liveYoutube', { enabled: true, relayVideo: 'copy', maxBitrateKbps: 2500 }, 'test', undefined, 'sdm');
    const sessions = new LiveSessions({
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
    const res = await sessions.start({ kuliahId: r.h.kuliahId, source: 'android', outputs: { kiosk: true, youtube: true }, youtubeVia: 'box', video: 'external', videoPath: 'box' }, 'user:starter', 'dev-phone', '192.0.2.5');
    for (let i = 0; i < 300 && sessions.status().relay.state === 'off'; i++) await settle(10);
    expect(sessions.status().relay.state).not.toBe('off');
    cameraUp(r);
    r.api.bytes['surau-cam'] = 0;
    await sessions.tick();
    return { r, sessions, stop: async () => void (await sessions.stop(res.session.id, 'user:starter')) };
  }

  const run = async (rr: { r: Rig; sessions: LiveSessions }, kbps: number, seconds: number): Promise<void> => {
    for (let i = 0; i < seconds / 2; i++) {
      rr.r.h.clock.t += 2000;
      rr.r.api.bytes['surau-cam'] = (rr.r.api.bytes['surau-cam'] ?? 0) + (kbps * 1000 * 2) / 8;
      await rr.sessions.tick();
    }
  };

  it('bursts that average 1100 kbps never warn at the fixed maximum of 3500; a steady 5000 warns, 2000 clears it, with a hysteresis between', async () => {
    const rr = await relayRig();
    try {
      const warn = (): boolean => rr.sessions.status().warnings.includes('camera_bitrate_high');
      for (let c = 0; c < 8; c++) {
        await run(rr, 4000, 2);
        await run(rr, 375, 8);
        expect(warn()).toBe(false);
      }
      await run(rr, 5000, 40); // the window is all 5000 now
      expect(warn()).toBe(true);
      expect(rr.sessions.status().cameraKbps).toBe(5000);
      // 10 s of 2000: the average 4000 is not above 1.2 x 3500 and not below 1.05 x 3500: no change
      await run(rr, 2000, 10);
      expect(warn()).toBe(true);
      await run(rr, 2000, 20);
      expect(warn()).toBe(false);
    } finally {
      await rr.stop();
    }
  });

  it('a steady 5000 does not warn before 20 s of samples', async () => {
    const rr = await relayRig();
    try {
      await run(rr, 5000, 18);
      expect(rr.sessions.status().warnings).not.toContain('camera_bitrate_high');
      await run(rr, 5000, 12);
      expect(rr.sessions.status().warnings).toContain('camera_bitrate_high');
    } finally {
      await rr.stop();
    }
  });

  it('a counter that goes backwards (the camera reconnected) clears the window: no spike, no verdict for 20 s', async () => {
    const r = await rig();
    await r.start();
    cameraUp(r);
    r.api.bytes['surau-cam'] = 0;
    await r.tick();
    await feed(r, 1100, 40);
    expect(r.s.status().cameraKbps).toBe(1100);
    r.api.bytes['surau-cam'] = 100; // a new connection counts from zero
    await r.tick(2000);
    expect(r.s.status().cameraKbps).toBeUndefined();
    expect(r.s.status().warnings).not.toContain('camera_bitrate_high');
    await feed(r, 1100, 24);
    expect(r.s.status().cameraKbps).toBe(1100);
  });

  it('A19: a camera that falls under a quarter of its own running level warns camera_slow, and the warning clears when it recovers', async () => {
    const r = await rig();
    await r.start();
    cameraUp(r);
    r.api.bytes['surau-cam'] = 0;
    await r.tick();
    await feed(r, 1100, 240);
    expect(r.s.status().warnings).not.toContain('camera_slow');
    await feed(r, 150, 20);
    expect(r.s.status().warnings).not.toContain('camera_slow'); // the window still holds mostly healthy samples
    await feed(r, 150, 40);
    expect(r.s.status().warnings).toContain('camera_slow');
    await feed(r, 1100, 40);
    expect(r.s.status().warnings).not.toContain('camera_slow');
  });

  it('A19: a quiet picture at a low level is not slow', async () => {
    const r = await rig();
    await r.start();
    cameraUp(r);
    r.api.bytes['surau-cam'] = 0;
    await r.tick();
    await feed(r, 120, 240);
    await feed(r, 20, 60);
    expect(r.s.status().warnings).not.toContain('camera_slow');
  });
});

describe('A18: one camera reader only', () => {
  it('during a box-pulled live every way to open the camera is refused: the address (owner and others), a second start, and a camera test', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    expect(() => r.s.cameraAddressFor('dev-ipad')).toThrowError(expect.objectContaining({ status: 409, code: 'camera_in_use' }));
    expect(() => r.s.cameraAddressFor('dev-other')).toThrowError(expect.objectContaining({ status: 409, code: 'camera_in_use' }));
    await expect(r.start({}, 'dev-other')).rejects.toMatchObject({ status: 409, code: 'live_busy' });
    // the same device asking again gets its own session back, not a second pull
    const again = await r.start({ audio: MIX_MIC });
    expect(again.session.id).toBe(r.s.current()!.id);
    expect(r.api.patches.filter((p) => p.path === 'surau-cam' && p.patch.source === CAM_URL)).toHaveLength(1);
    // a camera test running keeps a live from starting
    const busy = await rig();
    busy.s.attachCameraBusy(() => true);
    await expect(busy.start()).rejects.toMatchObject({ status: 409, code: 'camera_test_busy' });
  });
});

describe('A20, A21: sound legs and the AAC rendition', () => {
  const STUB = `
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(path.join(__dirname, 'argv.log'), JSON.stringify(process.argv.slice(2)) + '\\n');
const tick = () => process.stdout.write('bitrate=900.0kbits/s\\nspeed=1.00x\\ndrop_frames=0\\nprogress=continue\\n');
tick();
setInterval(tick, 30);
process.on('SIGTERM', () => process.exit(0));
`;
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const yt: YoutubeLeg = {
    signedIn: () => true,
    createBroadcastFor: async () => ({ broadcastId: 'bc1', watchUrl: 'https://youtu.be/bc1', key: 'abcd-efgh-ijkl-mnop-qrst' }),
    complete: async () => undefined,
    status: () => ({ signedIn: true, channelTitle: 'Surau', broadcastId: 'bc1', state: 'created', health: null, watchUrl: null, lastError: null }),
  };

  /** The rig's database and fake MediaMTX with a sessions object whose relays and TV sound leg are a logging stand-in for ffmpeg. */
  async function legRig(youtube: boolean): Promise<{ r: Rig; s: LiveSessions; runs: () => string[][]; mixers: FakeMixer[] }> {
    const r = await rig();
    const dir = mkdtempSync(join(tmpdir(), 'surau-rect-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'stub-ffmpeg.cjs'), STUB);
    putFeature(r.h.app.surau.db, 'liveOnKiosk', { audio: true }, 'test', undefined, 'sdm');
    putFeature(r.h.app.surau.db, 'liveYoutube', { enabled: youtube, relayVideo: 'copy', maxBitrateKbps: 2500 }, 'test', undefined, 'sdm');
    const mixers: FakeMixer[] = [];
    const s = new LiveSessions({
      db: r.h.app.surau.db,
      now: r.h.clock.now,
      runtime: r.runtime,
      onKiosk: () => undefined,
      monitorMs: 3_600_000,
      camera: { get: () => r.camera.record, lastTest: LAST_TEST },
      boxInput: () => r.inputAvailable.v,
      youtube: yt,
      youtubeGraceMs: 0,
      dataDir: r.h.dataDir,
      relayOptions: { ffmpegPath: process.execPath, argsPrefix: [join(dir, 'stub-ffmpeg.cjs')], pollMs: 10, backoffBaseMs: 5, backoffMaxMs: 20, killAfterMs: 300 },
      mixerFactory: (mo) => {
        const m = new FakeMixer(mo);
        mixers.push(m);
        return m;
      },
      alignerFactory: (ao) => new FakeAligner(ao),
    });
    const runs = (): string[][] => (existsSync(join(dir, 'argv.log')) ? readFileSync(join(dir, 'argv.log'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as string[]) : []);
    return { r, s, runs, mixers };
  }
  const pull = (r: Rig, over: Partial<LiveStartRequest> = {}): LiveStartRequest => ({ kuliahId: r.h.kuliahId, source: 'web', outputs: { kiosk: true, youtube: false }, youtubeVia: 'box', video: 'external', ...over });

  it('A20: a combined live with TV sound on has no sound leg and the kiosk reads surau; a phone SRT live still gets the leg', async () => {
    const a = await legRig(false);
    await a.s.start(pull(a.r), 'user:starter', 'dev-ipad', '192.0.2.5');
    a.s.publishKiosk();
    await settle(300);
    expect(a.runs()).toHaveLength(0);
    expect(a.s.kioskPath()).toBe('surau');
    await a.s.shutdown();

    const b = await legRig(false);
    b.r.api.ready.add('surau');
    await b.s.start({ kuliahId: b.r.h.kuliahId, source: 'android', outputs: { kiosk: true, youtube: false }, youtubeVia: 'device' }, 'user:starter', 'dev-phone', '192.0.2.5');
    await until(() => b.s.kioskPath() === 'surau-kiosk');
    expect(b.runs().length).toBeGreaterThan(0);
    await b.s.shutdown();
  });

  it('A21: with YouTube on in the settings a combined live publishes an AAC rendition to surau-yt and the relay copies it; the mix user may publish there', async () => {
    const a = await legRig(true);
    const res = await a.s.start(pull(a.r, { outputs: { kiosk: true, youtube: true } }), 'user:starter', 'dev-ipad', '192.0.2.5');
    const id = res.session.id;
    expect(a.r.api.users.get(`mix-${id}`)?.permissions).toContainEqual({ action: 'publish', path: 'surau-yt' });
    a.r.api.ready.add('surau-cam');
    a.r.api.ready.add('surau-yt');
    a.r.api.tracks['surau-cam'] = ['H264', 'MPEG-4 Audio'];
    await a.s.tick();
    expect(a.mixers[0]!.cfg?.ytOutputPath).toBe('surau-yt');
    await until(() => a.runs().length > 0);
    const argv = a.runs()[0]!.join(' ');
    expect(argv).toMatch(/\/surau-yt /);
    expect(argv).toContain('-c:a copy');
    expect(argv).not.toContain('-c:a aac');
    await a.s.stop(id, 'user:starter');
    expect(a.r.api.users.size).toBe(0);
    await a.s.shutdown();
  });

  it('A21: with YouTube off in the settings, or a live that is not combined, nothing changes (surau, AAC encode in the relay)', async () => {
    const off = await legRig(false);
    const res = await off.s.start(pull(off.r), 'user:starter', 'dev-ipad', '192.0.2.5');
    expect(off.r.api.users.get(`mix-${res.session.id}`)?.permissions).not.toContainEqual({ action: 'publish', path: 'surau-yt' });
    off.r.api.ready.add('surau-cam');
    off.r.api.tracks['surau-cam'] = ['H264', 'MPEG-4 Audio'];
    await off.s.tick();
    expect(off.mixers[0]!.cfg?.ytOutputPath).toBeUndefined();
    await off.s.shutdown();

    const plain = await legRig(true);
    plain.r.api.ready.add('surau');
    await plain.s.start({ kuliahId: plain.r.h.kuliahId, source: 'android', outputs: { kiosk: true, youtube: true }, youtubeVia: 'box' }, 'user:starter', 'dev-phone', '192.0.2.5');
    await until(() => plain.runs().some((x) => x.includes('flv')));
    const argv = plain.runs().find((x) => x.includes('flv'))!.join(' ');
    expect(argv).toMatch(/\/surau /);
    expect(argv).toContain('-c:a aac');
    await plain.s.shutdown();
  });

  it('A21: a phone-run live with Mic-in and YouTube from the phone makes no rendition (only the box relay reads it)', async () => {
    const a = await legRig(true);
    a.r.inputAvailable.v = JACK;
    const res = await a.s.start(
      { kuliahId: a.r.h.kuliahId, source: 'android', outputs: { kiosk: true, youtube: false }, youtubeVia: 'device', video: 'phone', audio: { camera: { enabled: false, volume: 100 }, deviceMic: { enabled: true, volume: 100 }, boxInput: { enabled: true, volume: 100 } } },
      'user:starter',
      'dev-phone',
      '192.0.2.5',
    );
    expect(a.r.api.users.get(`mix-${res.session.id}`)?.permissions).not.toContainEqual({ action: 'publish', path: 'surau-yt' });
    await a.s.shutdown();
  });
});

describe('C2: the live log', () => {
  class MemoryLog implements LiveLogLike {
    events: Array<{ kind: string; fields: Record<string, unknown> | undefined }> = [];
    lines: Array<{ source: string; text: string }> = [];
    secrets: string[][] = [];
    event(kind: string, fields?: Record<string, string | number | boolean | null>): void {
      this.events.push({ kind, fields });
    }
    line(source: string, text: string): void {
      this.lines.push({ source, text });
    }
    setSecrets(secrets: string[]): void {
      this.secrets.push(secrets);
    }
    kinds(): string[] {
      return this.events.map((e) => e.kind);
    }
  }

  it('a start, a stall, a kick, a bench and a stop write the expected event kinds in order, with no camera address, login or user name', async () => {
    const log = new MemoryLog();
    const r = await rig({ extra: { liveLog: log, dataDir: join('d', 'data') } });
    r.inputAvailable.v = JACK;
    const id = (await r.start()).session.id;
    cameraUp(r);
    r.api.bytes.surau = 5;
    await r.tick();
    r.api.ready.delete('surau');
    await r.tick(sec(20));
    await r.tick(sec(20)); // the output watchdog kicks
    r.api.bytes['surau-cam'] = (r.api.bytes['surau-cam'] ?? 0) + 50_000; // the camera is still sending
    await r.tick(sec(2));
    r.mixers[0]!.lastReason = 'monitor_silent';
    r.mixers[0]!.stalls = 3;
    r.api.bytes['surau-cam'] += 50_000;
    await r.tick(sec(2));
    r.mixers[0]!.stalls = 4;
    r.api.bytes['surau-cam'] += 50_000;
    await r.tick(sec(2)); // more stalls inside two minutes: bench
    await r.s.stop(id, 'user:starter');
    const kinds = log.kinds();
    const order = ['session_start', 'unit_ready', 'combiner_build', 'combiner_kick', 'combiner_stall', 'combiner_bench', 'session_stop'];
    let at = -1;
    for (const k of order) {
      const i = kinds.indexOf(k, at + 1);
      expect(i, `${k} in ${kinds.join(',')}`).toBeGreaterThan(at);
      at = i;
    }
    expect(log.events.find((e) => e.kind === 'session_stop')!.fields).toMatchObject({ reason: 'stopped' });
    const text = JSON.stringify([log.events, log.lines]);
    expect(text).not.toContain(CAM_PASS);
    expect(text).not.toContain(CAM_USER);
    expect(text).not.toContain('192.0.2.60');
    expect(text).not.toContain('dev-ipad');
    expect(text).not.toContain('user:starter');
  });

  it('B7: combiner_bench is logged once when a bench starts', async () => {
    const log = new MemoryLog();
    const r = await rig({ extra: { liveLog: log } });
    r.inputAvailable.v = JACK;
    await r.start();
    cameraUp(r);
    r.api.bytes.surau = 1;
    r.api.bytes['surau-cam'] = 10_000;
    await r.tick();
    r.api.bytes['surau-cam'] += 10_000;
    await r.tick(sec(2));
    for (let i = 0; i < 2; i++) {
      r.mixers[0]!.stalls += 1;
      r.api.bytes['surau-cam'] += 10_000;
      await r.tick(sec(2));
    }
    expect(log.events.filter((e) => e.kind === 'combiner_bench' && (e.fields as { on?: boolean }).on === true)).toHaveLength(1);
  });

  it('B8: the camera host name goes to the log redactor with the other secrets', async () => {
    const log = new MemoryLog();
    const r = await rig({ extra: { liveLog: log }, camera: { record: { url: 'rtsp://camuser:Cam-Pa55word9@cam-hall.example.test:554/stream1' } } });
    await r.start();
    expect(log.secrets.at(-1)).toContain('cam-hall.example.test');
  });

  it('every secret the runtime holds goes to the log redactor at the start, and the session\'s own with it', async () => {
    const log = new MemoryLog();
    const r = await rig({ extra: { liveLog: log } });
    const id = (await r.start()).session.id;
    const mix = r.api.users.get(`mix-${id}`)!.pass;
    const pub = r.api.users.get(`pub-${id}`)!.pass;
    expect(log.secrets[0]).toContain(mix);
    expect(log.secrets[0]).toContain(pub);
    // the camera login reaches the redactor once the pull is set
    expect(log.secrets.at(-1)).toContain(CAM_PASS);
  });

  it('the combiner gets the log and the debug flag path; its stderr lines become log lines, its other events log events', async () => {
    const log = new MemoryLog();
    const r = await rig({ extra: { liveLog: log, dataDir: join('d', 'data') } });
    await r.start();
    cameraUp(r);
    await r.tick();
    const o = r.mixers[0]!.o;
    expect(o.debugFlagPath).toBe(join('d', 'data', 'live', 'debug.flag'));
    o.log!('stderr', 'a line');
    o.log!('stall', 'a block');
    expect(log.lines).toContainEqual({ source: 'combiner', text: 'a line' });
    expect(log.events).toContainEqual({ kind: 'combiner_stall', fields: { text: 'a block' } });
  });

  it('a live in the whole box writes <dataDir>/live/live.log as a timeline', async () => {
    const h = await startLiveHarness();
    harnesses.push(h);
    const user = await loginAs(h.app, 'live');
    const res = await h.app.inject({ method: 'POST', url: '/api/live/start', headers: user.headers, payload: startBody(h), remoteAddress: '127.0.0.1' });
    expect(res.statusCode).toBe(200);
    await h.app.inject({ method: 'POST', url: '/api/live/stop', headers: user.headers, payload: { sessionId: res.json().session.id }, remoteAddress: '127.0.0.1' });
    const file = join(h.dataDir, 'live', 'live.log');
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text.indexOf('event session_start')).toBeGreaterThan(-1);
    expect(text.indexOf('event session_stop')).toBeGreaterThan(text.indexOf('event session_start'));
  });
});

describe('S1 to S3: the Skrin and Merakam switches', () => {
  const body = (over: Record<string, unknown>): Record<string, unknown> => ({ kuliahId: null, source: 'android', youtubeVia: 'device', outputs: { kiosk: true, youtube: false }, ...over });

  it('S1: the start request: Skrin off is accepted with YouTube or Merakam on, refused 400 no_destination with nothing on, the old shape is unchanged', () => {
    expect(parseStartRequest(body({ outputs: { kiosk: false, youtube: true } }))).toMatchObject({ outputs: { kiosk: false, youtube: true } });
    expect(parseStartRequest(body({ outputs: { kiosk: false, youtube: false, recording: true } }))).toMatchObject({ outputs: { kiosk: false, youtube: false, recording: true } });
    for (const outputs of [{ kiosk: false, youtube: false }, { kiosk: false, youtube: false, recording: false }]) {
      expect(() => parseStartRequest(body({ outputs }))).toThrowError(expect.objectContaining({ status: 400, code: 'no_destination' }));
    }
    // the old app: kiosk true, no recording field
    expect(parseStartRequest(body({})).outputs).toEqual({ kiosk: true, youtube: false });
    expect(() => parseStartRequest(body({ outputs: { kiosk: 'no', youtube: false } }))).toThrowError(expect.objectContaining({ code: 'bad_request' }));
    expect(() => parseStartRequest(body({ outputs: { kiosk: true, youtube: false, recording: 'yes' } }))).toThrowError(expect.objectContaining({ code: 'bad_request' }));
  });

  it('S1, S2: a live started with Skrin off is not offered to the TVs; Skrin on brings it back, announced at once', async () => {
    const r = await rig();
    await r.start({ outputs: { kiosk: false, youtube: false, recording: true } });
    cameraUp(r);
    await r.tick();
    expect(r.s.kioskLive()).toMatchObject({ live: false });
    expect(r.kiosk.at(-1)).toMatchObject({ live: false });
    expect(r.s.tvMayWatch('tv-1')).toBe(false);
    expect(r.s.status('dev-ipad').session?.outputs).toMatchObject({ kiosk: false, youtube: false, recording: true });
    // the combiner keeps running
    expect(r.mixers).toHaveLength(1);
    expect(r.mixers[0]!.stopped).toBe(false);
    const id = r.s.current()!.id;
    const st = r.s.setOutputs({ sessionId: id, kiosk: true }, 'user:starter', 'dev-ipad');
    expect(st.session?.outputs.kiosk).toBe(true);
    expect(r.s.kioskLive()).toMatchObject({ live: true });
    expect(r.kiosk.at(-1)).toMatchObject({ live: true });
    expect(r.s.tvMayWatch('tv-1')).toBe(true);
    // the change is on record
    expect(r.h.app.surau.db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'live-outputs'").get()).toMatchObject({ n: 1 });
  });

  it('S3: during a live the last destination cannot be turned off (409 last_output); with Merakam on, Skrin may go and leaves the kiosk event at once', async () => {
    const r = await rig();
    await r.start({ outputs: { kiosk: true, youtube: false } });
    cameraUp(r);
    await r.tick();
    const id = r.s.current()!.id;
    expect(r.s.kioskLive()).toMatchObject({ live: true });
    expect(() => r.s.setOutputs({ sessionId: id, kiosk: false }, 'user:starter', 'dev-ipad')).toThrowError(expect.objectContaining({ status: 409, code: 'last_output' }));
    expect(r.s.kioskLive()).toMatchObject({ live: true });
    const st = r.s.setOutputs({ sessionId: id, kiosk: false, recording: true }, 'user:starter', 'dev-ipad');
    expect(st.session?.outputs).toMatchObject({ kiosk: false, recording: true });
    expect(r.kiosk.at(-1)).toMatchObject({ live: false });
    // and now Merakam is the last one
    expect(() => r.s.setOutputs({ sessionId: id, kiosk: false, recording: false }, 'user:starter', 'dev-ipad')).toThrowError(expect.objectContaining({ code: 'last_output' }));
    expect(() => r.s.setOutputs({ sessionId: 'other', kiosk: true }, 'user:starter', 'dev-ipad')).toThrowError(expect.objectContaining({ code: 'no_session' }));
  });

  describe('B2: never a live with no real destination', () => {
    const okLeg = (): YoutubeLeg => ({
      signedIn: () => true,
      createBroadcastFor: async () => ({ broadcastId: 'bc1', watchUrl: 'https://youtu.be/bc1', key: 'abcd-efgh-ijkl-mnop-qrst' }),
      complete: async () => undefined,
      status: () => ({ signedIn: true, channelTitle: 'Surau', broadcastId: 'bc1', state: 'created', health: null, watchUrl: null, lastError: null }),
    });
    const failLeg = (): YoutubeLeg => ({ ...okLeg(), createBroadcastFor: async () => Promise.reject(Object.assign(new Error('refused'), { reason: 'quota' })) });
    const ytRig = async (leg: YoutubeLeg): Promise<Rig> => {
      const r = await rig({ extra: { youtube: leg, youtubeGraceMs: 0 } });
      putFeature(r.h.app.surau.db, 'liveYoutube', { enabled: true, relayVideo: 'copy', maxBitrateKbps: 2500 }, 'test', undefined, 'sdm');
      return r;
    };
    const outputsLog = (r: Rig): number => (r.h.app.surau.db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'live-outputs' AND actor = 'system'").get() as { n: number }).n;

    it('the broadcast cannot be made, Skrin is off and Merakam is off: Skrin comes back on by itself, with the event, the change log and the warning', async () => {
      const log: Array<{ kind: string; fields?: Record<string, unknown> }> = [];
      const r = await ytRig(failLeg());
      (r.s as unknown as { log: unknown }).log = { event: (kind: string, fields?: Record<string, unknown>) => log.push({ kind, fields }), line: () => undefined, setSecrets: () => undefined };
      await r.start({ outputs: { kiosk: false, youtube: true }, video: 'phone' });
      await settle(30);
      const st = r.s.status('dev-ipad');
      expect(st.session?.outputs).toMatchObject({ kiosk: true, youtube: true });
      expect(st.warnings).toContain('kiosk_restored');
      expect(st.warnings).toContain('youtube_quota');
      expect(r.s.tvMayWatch('tv-1')).toBe(true); // the TVs are offered the picture again
      expect(outputsLog(r)).toBe(1);
      expect(log.some((e) => e.kind === 'outputs_auto_kiosk')).toBe(true);
      // a person who sets Skrin clears the notice
      r.s.setOutputs({ sessionId: r.s.current()!.id, kiosk: true }, 'user:starter', 'dev-ipad');
      expect(r.s.status('dev-ipad').warnings).not.toContain('kiosk_restored');
    });

    it('a key YouTube refused for good does the same; Skrin or Merakam already on leaves everything as it is', async () => {
      const r = await ytRig(okLeg());
      await r.start({ outputs: { kiosk: false, youtube: true }, video: 'phone' });
      await settle(30);
      const sess = (r.s as unknown as { session: { relay: unknown } }).session;
      const real = sess.relay as { stop: () => Promise<void> } | null;
      sess.relay = { status: () => ({ state: 'failed', lastError: 'bad_key' }), stop: async () => undefined, readPassword: () => null };
      await r.tick(2000);
      expect(r.s.status('dev-ipad').session?.outputs.kiosk).toBe(true);
      expect(r.s.status('dev-ipad').warnings).toContain('kiosk_restored');
      expect(outputsLog(r)).toBe(1);
      await r.tick(2000);
      expect(outputsLog(r)).toBe(1); // once
      await real?.stop();

      const rec = await ytRig(failLeg());
      await rec.start({ outputs: { kiosk: false, youtube: true, recording: true }, video: 'phone' });
      await settle(30);
      expect(rec.s.status('dev-ipad').session?.outputs).toMatchObject({ kiosk: false, recording: true });
      expect(rec.s.status('dev-ipad').warnings).not.toContain('kiosk_restored');
      expect(outputsLog(rec)).toBe(0);
    });

    it('an Android phone whose camera the box pulls cannot record: Merakam alone is no destination (400 no_destination)', async () => {
      const body = { kuliahId: null, source: 'android', youtubeVia: 'box', video: 'external', videoPath: 'box', outputs: { kiosk: false, youtube: false, recording: true } };
      expect(() => parseStartRequest(body)).toThrowError(expect.objectContaining({ status: 400, code: 'no_destination' }));
      expect(parseStartRequest({ ...body, outputs: { kiosk: true, youtube: false, recording: true } })).toMatchObject({ outputs: { kiosk: true } });
      expect(parseStartRequest({ ...body, source: 'web', outputs: { kiosk: false, youtube: false, recording: true } })).toMatchObject({ outputs: { recording: true } });
      const r = await rig();
      await expect(r.s.start({ kuliahId: r.h.kuliahId, source: 'android', outputs: { kiosk: false, youtube: false, recording: true }, youtubeVia: 'box', video: 'external', videoPath: 'box' }, 'user:starter', 'dev-phone', '192.0.2.5')).rejects.toMatchObject({ code: 'no_destination' });
    });
  });

  it('S3: YouTube counts as a destination only while a broadcast exists or is pending; the status says the box can toggle Skrin', async () => {
    const r = await rig();
    await r.start({ outputs: { kiosk: true, youtube: true } }); // YouTube was asked for but is off in the settings: it never came up
    const id = r.s.current()!.id;
    expect(() => r.s.setOutputs({ sessionId: id, kiosk: false }, 'user:starter', 'dev-ipad')).toThrowError(expect.objectContaining({ status: 409, code: 'last_output' }));
    const live = (r.s as unknown as { session: { broadcastId: string | null; ytPending: boolean } }).session;
    live.ytPending = true;
    expect(r.s.setOutputs({ sessionId: id, kiosk: false }, 'user:starter', 'dev-ipad').session?.outputs.kiosk).toBe(false);
    expect(r.s.status().canToggleKiosk).toBe(true);
    // a broadcast that exists counts too
    const r2 = await rig();
    await r2.start({ outputs: { kiosk: true, youtube: true } });
    (r2.s as unknown as { session: { broadcastId: string | null } }).session.broadcastId = 'bc1';
    expect(r2.s.setOutputs({ sessionId: r2.s.current()!.id, kiosk: false }, 'user:starter', 'dev-ipad').session?.outputs.kiosk).toBe(false);
  });

  it('S1: at the start YouTube counts only when it is enabled in the settings and signed in', async () => {
    const asked = { kiosk: false, youtube: true };
    const off = await rig();
    await expect(off.start({ outputs: asked })).rejects.toMatchObject({ status: 400, code: 'no_destination' });
    expect(off.s.current()).toBeNull();
    const signedOut = await rig({ extra: { youtube: { signedIn: () => false, status: () => ({ signedIn: false }) } as never } });
    putFeature(signedOut.h.app.surau.db, 'liveYoutube', { enabled: true }, 'test', undefined, 'sdm');
    await expect(signedOut.start({ outputs: asked })).rejects.toMatchObject({ status: 400, code: 'no_destination' });
    const real = await rig({ extra: { youtube: { signedIn: () => true, status: () => ({ signedIn: true }), createBroadcastFor: () => new Promise(() => undefined), complete: async () => undefined } as never } });
    putFeature(real.h.app.surau.db, 'liveYoutube', { enabled: true }, 'test', undefined, 'sdm');
    await real.start({ outputs: asked });
    expect(real.s.current()).not.toBeNull();
  });

  it('S3: the route has the same caller rules as Stop: the starter, a settings:write holder, any live:control holder for a box-pulled live', async () => {
    const r = await rig();
    await r.start({ outputs: { kiosk: true, youtube: false, recording: true } });
    const id = r.s.current()!.id;
    const app = await routeApp(r);
    const call = (headers: Record<string, string>, payload: unknown) => app.inject({ method: 'POST', url: '/api/live/outputs', headers, payload: payload as object });
    expect((await call(asDevice('dev-other', 'media'), { sessionId: id, kiosk: false })).statusCode).toBe(403);
    expect((await call(asDevice('dev-other'), { sessionId: id, kiosk: 'x' })).statusCode).toBe(400);
    expect((await call(asDevice('dev-other'), { sessionId: 'nope', kiosk: false })).statusCode).toBe(409);
    const ok = await call(asDevice('dev-other'), { sessionId: id, kiosk: false });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().session.outputs).toMatchObject({ kiosk: false });
    expect(ok.json().canToggleKiosk).toBe(true);
    // a device-sourced live: only the starter (and a settings:write holder)
    const phone = await rig();
    await phone.start({ source: 'android', youtubeVia: 'device', outputs: { kiosk: true, youtube: false, recording: true } }, 'dev-phone');
    const pid = phone.s.current()!.id;
    const app2 = await routeApp(phone);
    const no = await app2.inject({ method: 'POST', url: '/api/live/outputs', headers: asDevice('dev-other'), payload: { sessionId: pid, kiosk: false } });
    expect(no.statusCode).toBe(403);
    const yes = await app2.inject({ method: 'POST', url: '/api/live/outputs', headers: asDevice('dev-phone'), payload: { sessionId: pid, kiosk: false } });
    expect(yes.statusCode).toBe(200);
  });

  describe('the TV sound leg follows Skrin', () => {
    const STUB = `
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(path.join(__dirname, 'argv.log'), JSON.stringify(process.argv.slice(2)) + '\\n');
const tick = () => process.stdout.write('bitrate=900.0kbits/s\\nspeed=1.00x\\ndrop_frames=0\\nprogress=continue\\n');
tick();
setInterval(tick, 30);
process.on('SIGTERM', () => process.exit(0));
`;
    it('no leg while Skrin is off, a leg when it is turned on, none again when it is turned off', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'surau-rect-'));
      try {
        writeFileSync(join(dir, 'stub-ffmpeg.cjs'), STUB);
        const h = await startLiveHarness({ live: { monitorMs: 20 } });
        harnesses.push(h);
        putFeature(h.app.surau.db, 'liveOnKiosk', { audio: true }, 'test', undefined, 'sdm');
        const events: Array<{ live: boolean; path?: string }> = [];
        const s = new LiveSessions({
          db: h.app.surau.db,
          now: h.clock.now,
          runtime: h.app.liveRuntime,
          onKiosk: (k) => events.push(k),
          dataDir: h.dataDir,
          monitorMs: 20,
          relayOptions: { ffmpegPath: process.execPath, argsPrefix: [join(dir, 'stub-ffmpeg.cjs')], pollMs: 10, backoffBaseMs: 5, backoffMaxMs: 20, killAfterMs: 500 },
        });
        h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1' });
        const res = await s.start({ kuliahId: h.kuliahId, source: 'android', outputs: { kiosk: false, youtube: false, recording: true }, youtubeVia: 'device' }, 'user:t', 'dev1', '127.0.0.1');
        await settle(200);
        expect(s.kioskPath()).toBe('surau');
        expect(existsSync(join(dir, 'argv.log'))).toBe(false);
        expect(events.at(-1)).toMatchObject({ live: false });
        const id = res.session.id;
        s.setOutputs({ sessionId: id, kiosk: true }, 'user:t', 'dev1');
        await until(() => s.kioskPath() === 'surau-kiosk');
        expect(events.at(-1)).toMatchObject({ live: true });
        expect(existsSync(join(dir, 'argv.log'))).toBe(true);
        s.setOutputs({ sessionId: id, kiosk: false }, 'user:t', 'dev1');
        expect(s.kioskPath()).toBe('surau');
        expect(events.at(-1)).toMatchObject({ live: false });
        await s.shutdown();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('pre-merge audit fixes', () => {
  const feed = async (r: Rig, kbps: number, seconds: number, tickMs = 2000): Promise<void> => {
    for (let i = 0; i < seconds / (tickMs / 1000); i++) {
      r.api.bytes['surau-cam'] = (r.api.bytes['surau-cam'] ?? 0) + (kbps * 1000 * (tickMs / 1000)) / 8;
      await r.tick(tickMs);
    }
  };

  it('1: a live that started box-pulled never ends by itself, also after the switch to the iPad camera that never publishes', async () => {
    const r = await rig();
    const id = (await r.start({ audio: MIX_MIC })).session.id;
    cameraUp(r, true);
    await r.tick();
    r.api.ready.delete('surau-cam');
    r.api.ready.delete('surau');
    await r.tick(12 * 60_000);
    expect(r.s.current()?.id).toBe(id);
    await r.s.changeAudio('dev-ipad', { audio: MIX_MIC, video: 'phone' });
    expect(r.s.current()?.boxPulled).toBe(true); // B1: the "never ends" predicate follows the start, not the picture
    expect(r.s.status('dev-ipad').session).toMatchObject({ boxPulled: false, startedBoxPulled: true });
    for (let i = 0; i < 3; i++) {
      r.s.heartbeat('dev-ipad');
      await r.tick(10 * 60_000);
    }
    expect(r.s.current()?.id).toBe(id);
    await r.s.stop(id, 'user:starter');
    expect(lastReason(r, id)).toBe('stopped');
  });

  it('2: a run that first outputs at 30 s is never kicked; a stuck run is kicked once at about 35 s, then once per 35 s', async () => {
    const ok = await rig();
    await ok.start();
    ok.api.ready.add('surau-cam');
    ok.api.tracks['surau-cam'] = ['H264', 'MPEG-4 Audio'];
    await ok.tick();
    await ok.tick(sec(14));
    await ok.tick(sec(14)); // 28 s, no output yet
    ok.api.ready.add('surau');
    ok.api.bytes.surau = 0;
    for (let i = 0; i < 40; i++) {
      ok.api.bytes.surau += 40_000;
      await ok.tick(sec(2));
    }
    expect(ok.mixers[0]!.kicks).toEqual([]);

    const stuck = await rig();
    await stuck.start();
    stuck.api.ready.add('surau-cam');
    stuck.api.tracks['surau-cam'] = ['H264', 'MPEG-4 Audio'];
    await stuck.tick();
    for (let i = 0; i < 17; i++) await stuck.tick(sec(2)); // 34 s
    expect(stuck.mixers[0]!.kicks).toEqual([]);
    await stuck.tick(sec(2));
    expect(stuck.mixers[0]!.kicks).toEqual(['no_output']);
    for (let i = 0; i < 16; i++) await stuck.tick(sec(2)); // 32 s later
    expect(stuck.mixers[0]!.kicks).toHaveLength(1);
    for (let i = 0; i < 2; i++) await stuck.tick(sec(2));
    expect(stuck.mixers[0]!.kicks).toHaveLength(2);
  });

  it('2: a relaunch the combiner did by itself gets its own grace', async () => {
    const r = await rig();
    await r.start();
    r.api.ready.add('surau-cam');
    r.api.tracks['surau-cam'] = ['H264', 'MPEG-4 Audio'];
    await r.tick();
    await r.tick(sec(30));
    r.mixers[0]!.restarts = 1; // relaunched at about 30 s
    await r.tick(sec(2));
    await r.tick(sec(20)); // 52 s since the build, 22 s since the relaunch
    expect(r.mixers[0]!.kicks).toEqual([]);
    await r.tick(sec(16)); // 38 s since the relaunch
    expect(r.mixers[0]!.kicks).toEqual(['no_output']);
  });

  it('5: camera_slow does not latch: 4000 then a steady 900 kbps clears within 5 minutes; a drop from 1100 to 200 still warns within 60 s', async () => {
    const r = await rig();
    await r.start();
    cameraUp(r);
    r.api.bytes['surau-cam'] = 0;
    await r.tick();
    await feed(r, 4000, 240);
    expect(r.s.status().warnings).not.toContain('camera_slow');
    await feed(r, 900, 60);
    expect(r.s.status().warnings).toContain('camera_slow');
    await feed(r, 900, 300);
    expect(r.s.status().warnings).not.toContain('camera_slow');

    const drop = await rig();
    await drop.start();
    cameraUp(drop);
    drop.api.bytes['surau-cam'] = 0;
    await drop.tick();
    await feed(drop, 1100, 240);
    await feed(drop, 200, 60);
    expect(drop.s.status().warnings).toContain('camera_slow');
  });

  it('5: a reconnect (the counter goes backwards) resets the warning and the level', async () => {
    const r = await rig();
    await r.start();
    cameraUp(r);
    r.api.bytes['surau-cam'] = 0;
    await r.tick();
    await feed(r, 1100, 240);
    await feed(r, 150, 60);
    expect(r.s.status().warnings).toContain('camera_slow');
    r.api.bytes['surau-cam'] = 0;
    await r.tick(2000);
    expect(r.s.status().warnings).not.toContain('camera_slow');
  });

  it('6 (build 6): two microphones asked: one is kept (the box microphone by priority), with its own delay and no aligner', async () => {
    const r = await rig({ cameraSettings: { avOffsetMs: { boxInput: 250, deviceMic: 700 } } });
    r.inputAvailable.v = JACK;
    await r.start({ audio: { camera: { enabled: false, volume: 100 }, deviceMic: { enabled: true, volume: 80 }, boxInput: { enabled: true, volume: 100 } } });
    cameraUp(r, true);
    await r.tick();
    const cfg = r.mixers[0]!.cfg!;
    expect(cfg.added).toEqual([{ id: 'boxInput', initialDelayMs: 250, volume: 100, held: false }]);
    expect(r.aligners).toHaveLength(0);
  });

  it('7: avOffsetMs without avOffsetId keeps its old meaning (the device microphone): the box microphone is not moved', async () => {
    const r = await rig();
    r.inputAvailable.v = JACK;
    await r.start({ audio: MIX_BOX });
    cameraUp(r);
    await r.tick();
    const st = await r.s.changeAudio('dev-ipad', { audio: MIX_BOX, avOffsetMs: 300 });
    expect(r.mixers[0]!.delays).toEqual([]);
    expect(st.audio!.sources.find((x) => x.id === 'boxInput')!.align).toEqual({ state: 'manual', delayMs: 400 });
  });

  it('8: Merakam is taken only from the starting device; the stored record follows a mid-live change', async () => {
    const r = await rig();
    (r.s as unknown as { d: { store: unknown } }).d.store = createLiveSessionStore(r.h.app.surau.db);
    await r.start({ outputs: { kiosk: true, youtube: false, recording: false } });
    const id = r.s.current()!.id;
    // another device cannot flip the flag: the stored value stays, so Skrin off is the last destination
    expect(() => r.s.setOutputs({ sessionId: id, kiosk: false, recording: true }, 'user:other', 'dev-other')).toThrowError(expect.objectContaining({ code: 'last_output' }));
    expect(r.s.status().session?.outputs.recording).toBe(false);
    r.s.setOutputs({ sessionId: id, kiosk: true, recording: true }, 'user:starter', 'dev-ipad');
    expect(r.s.status().session?.outputs.recording).toBe(true);
    r.s.setOutputs({ sessionId: id, kiosk: false, recording: false }, 'user:other', 'dev-other'); // recording stays true, so it is allowed
    expect(r.s.status().session?.outputs).toMatchObject({ kiosk: false, recording: true });
    const row = r.h.app.surau.db.prepare('SELECT outputs_json FROM live_sessions WHERE id = ?').get(id) as { outputs_json: string };
    expect(JSON.parse(row.outputs_json)).toMatchObject({ kiosk: false, recording: true });
  });

  it('B1: after the switch to the iPad camera a non-starter live:control holder can still stop, and the quiet notice still appears after 10 minutes', async () => {
    const r = await rig();
    const id = (await r.start({ audio: MIX_MIC })).session.id;
    cameraUp(r, true);
    await r.tick();
    await r.s.changeAudio('dev-ipad', { audio: MIX_MIC, video: 'phone' });
    expect(r.s.status('dev-ipad').session).toMatchObject({ boxPulled: false, startedBoxPulled: true });
    const app = await routeApp(r);
    r.h.clock.t += 601_000;
    const other = (await app.inject({ method: 'GET', url: '/api/live/status', headers: asDevice('dev-other') })).json();
    expect(other.warnings).toContain('controller_quiet');
    expect(other.controllerQuietSeconds).toBeGreaterThanOrEqual(600);
    const res = await app.inject({ method: 'POST', url: '/api/live/stop', headers: asDevice('dev-other'), payload: { sessionId: id } });
    expect(res.statusCode).toBe(200);
    expect(r.s.current()).toBeNull();
  });

  it('B5: camHigh, camSlow and the running level are reset when the samples are cleared (unit not ready, unit switch)', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    cameraUp(r, true);
    r.api.bytes['surau-cam'] = 0;
    await r.tick();
    await feed(r, 5000, 40);
    const sess = (): { camHigh: boolean; camSlow: boolean; camLevelKbps: number | null } => (r.s as unknown as { session: { camHigh: boolean; camSlow: boolean; camLevelKbps: number | null } }).session;
    expect(sess().camHigh).toBe(true);
    expect(sess().camLevelKbps).not.toBeNull();
    r.api.ready.delete('surau-cam');
    await r.tick(2000);
    expect(sess()).toMatchObject({ camHigh: false, camSlow: false, camLevelKbps: null });
    cameraUp(r, true);
    await feed(r, 5000, 40);
    expect(sess().camHigh).toBe(true);
    await r.s.changeAudio('dev-ipad', { audio: MIX_MIC, video: 'phone' });
    expect(sess()).toMatchObject({ camHigh: false, camSlow: false, camLevelKbps: null });
  });

  it('11: the status session carries the current boxPulled (true on the camera, false on the iPad camera) and cameraKbps stays top-level', async () => {
    const r = await rig();
    await r.start({ audio: MIX_MIC });
    cameraUp(r, true);
    r.api.bytes['surau-cam'] = 0;
    await r.tick();
    expect(r.s.status('dev-ipad').session?.boxPulled).toBe(true);
    await feed(r, 1100, 40);
    expect(r.s.status('dev-ipad').cameraKbps).toBe(1100);
    await r.s.changeAudio('dev-ipad', { audio: MIX_MIC, video: 'phone' });
    expect(r.s.status('dev-ipad').session?.boxPulled).toBe(false);
    const phone = await rig();
    await phone.start({ source: 'android', youtubeVia: 'device' }, 'dev-phone');
    expect(phone.s.status('dev-phone').session?.boxPulled).toBe(false);
  });
});
