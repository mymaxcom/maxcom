import { createServer as createHttp, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { createServer as createTcp, type Server as TcpServer } from 'node:net';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { CAMERA_PROFILE_DEFAULT, parseCameraProfile } from '@surau/core';
import { createLimiters } from '../src/auth/authz.ts';
import { CameraStore } from '../src/live/camera.ts';
import { CameraController, parseControlRequest } from '../src/live/cameraControl.ts';
import { registerCameraRoutes } from '../src/live/cameraRoutes.ts';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';
import { changeLogText, startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';

const CAM = '10.168.1.20';
const BOX = '10.168.1.40';
const ADDRESS = `rtsp://viewer:lihat123@${CAM}:554/main`;
const OSC_EXPOSURE_P10 = '000000382f4f4253424f542f57656243616d2f47656e6572616c2f5365744578706f73757265436f6d70656e73617465000000002c690000 0000000a'.replace(' ', '');

/* A fake camera: the HTTP interface (POST /camera/sdk/<action>) and the state socket (ws /ws/, first message is JSON). */
interface Req {
  path: string;
  body: string;
  headers: IncomingMessage['headers'];
}
interface FakeCam {
  server: HttpServer;
  port: number;
  reqs: Req[];
  state: { target: number; af_mode: number; ratio: number };
  /** Per action: how the fake answers (default: apply and 200). */
  mode: Record<string, 'ok' | 'ignore' | '500' | '302' | 'huge' | 'hang'>;
  wsReads: number;
  wsPad: number;
}
async function fakeCam(): Promise<FakeCam> {
  const f: FakeCam = { server: createHttp(), port: 0, reqs: [], state: { target: 0, af_mode: 3, ratio: 1 }, mode: {}, wsReads: 0, wsPad: 0 };
  f.server.on('request', (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = req.url ?? '';
      const body = Buffer.concat(chunks).toString('utf8');
      f.reqs.push({ path, body, headers: req.headers });
      const action = path.replace('/camera/sdk/', '');
      const how = f.mode[action] ?? 'ok';
      if (how === '500') return void res.writeHead(500).end('{}');
      if (how === '302') return void res.writeHead(302, { Location: '/elsewhere' }).end();
      if (how === 'huge') return void res.writeHead(200).end('x'.repeat(5_000_000));
      if (how === 'hang') return;
      const j = JSON.parse(body) as Record<string, number>;
      if (how === 'ok') {
        if (action === 'af' && typeof j.mode === 'number') f.state.af_mode = j.mode;
        if (action === 'ai_trace' && typeof j.target === 'number') f.state.target = j.target;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"code":0}');
    });
  });
  f.server.on('upgrade', (req, socket) => {
    const key = String(req.headers['sec-websocket-key'] ?? '');
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    f.wsReads++;
    const text = JSON.stringify({ ...f.state, pad: 'p'.repeat(f.wsPad), device_status: { battery_cap: 80, is_charge: false } });
    const data = Buffer.from(text);
    const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
    socket.write(Buffer.concat([head, data]));
    socket.on('error', () => undefined);
    socket.on('data', () => undefined);
    // an upgraded socket is half-open by default: end it when the camera's client goes away
    socket.on('end', () => socket.destroy());
  });
  await new Promise<void>((r) => f.server.listen(0, '127.0.0.1', r));
  f.port = (f.server.address() as { port: number }).port;
  return f;
}

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});
async function cam(): Promise<FakeCam> {
  const f = await fakeCam();
  closers.push(() => new Promise<void>((r) => (f.server.closeAllConnections(), f.server.close(() => r()))));
  return f;
}
/** A fake OSC listener that never answers (the camera does not reply to OSC commands). */
async function silentOsc(): Promise<{ port: number; frames: Buffer[] }> {
  const frames: Buffer[] = [];
  const server: TcpServer = createTcp((s) => {
    s.on('data', (d) => frames.push(Buffer.from(d)));
    s.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise<void>((r) => (server.close(() => r()), void 0)));
  return { port: (server.address() as { port: number }).port, frames };
}

function controller(ports: { osc?: number; http: number }, o: { httpMs?: number; settleMs?: number; asked?: string[]; boxIps?: string[]; wait?: number } = {}): CameraController {
  return new CameraController({
    ports: { osc: ports.osc ?? 1, visca: 1, http: ports.http },
    waitMs: o.wait ?? 100,
    httpMs: o.httpMs ?? 500,
    settleMs: o.settleMs ?? 0,
    boxIps: o.boxIps ?? [BOX],
    dial: (host) => {
      o.asked?.push(host);
      return '127.0.0.1';
    },
  });
}
const bodies = (c: FakeCam): string[] => c.reqs.map((r) => `${r.path} ${r.body}`);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('http: the request of each step', () => {
  it('preset, tracking on and off: one fixed POST each to /camera/sdk/<action>, JSON body, no login, confirmed on 2xx and the state read back', async () => {
    const c = await cam();
    const ctl = controller({ http: c.port });
    expect(await ctl.send(CAM, 'http', { action: 'preset', preset: 3 })).toEqual({ sent: true, confirmed: true });
    expect(await ctl.send(CAM, 'http', { action: 'aiTracking', on: true })).toEqual({ sent: true, confirmed: true });
    expect(c.state.target).toBe(1);
    expect(await ctl.send(CAM, 'http', { action: 'aiTracking', on: false })).toEqual({ sent: true, confirmed: true });
    expect(c.state.target).toBe(0);
    expect(bodies(c)).toEqual(['/camera/sdk/trigger_preset {"id":2}', '/camera/sdk/ai_trace {"target":1}', '/camera/sdk/ai_trace {"target":0}']);
    for (const r of c.reqs) {
      expect(r.headers['content-type']).toBe('application/json');
      expect(r.headers.authorization).toBeUndefined();
      expect(r.headers.cookie).toBeUndefined();
    }
  });

  it('what the http interface has no command for (exposure, back to the start position) goes by OSC, the documented way', async () => {
    const c = await cam();
    const osc = await silentOsc();
    const ctl = controller({ http: c.port, osc: osc.port });
    const r = await ctl.send(CAM, 'http', { action: 'exposure', ev: 1 });
    expect(r).toEqual({ sent: true, confirmed: false });
    await wait(20);
    expect(Buffer.concat(osc.frames).toString('hex')).toBe(OSC_EXPOSURE_P10);
    expect(c.reqs).toEqual([]);
  });

  it('a refusal of the host: public, box, loopback, names and host:port are refused and nothing is dialled', async () => {
    const c = await cam();
    const asked: string[] = [];
    const ctl = controller({ http: c.port }, { asked });
    for (const host of ['8.8.8.8', BOX, '127.0.0.1', '169.254.1.1', 'camera.local', '10.168.1.20:80', '']) {
      await expect(ctl.send(host, 'http', { action: 'preset', preset: 1 }), host).rejects.toMatchObject({ status: 400, code: 'bad_address' });
    }
    expect(asked).toEqual([]);
    expect(c.reqs).toEqual([]);
  });

  it('a 500 is sent but not confirmed; a redirect is not followed; a state that did not change is not confirmed', async () => {
    const c = await cam();
    const ctl = controller({ http: c.port });
    c.mode.trigger_preset = '500';
    expect(await ctl.send(CAM, 'http', { action: 'preset', preset: 1 })).toEqual({ sent: true, confirmed: false });
    c.mode.trigger_preset = '302';
    expect(await ctl.send(CAM, 'http', { action: 'preset', preset: 1 })).toEqual({ sent: true, confirmed: false });
    expect(c.reqs.map((r) => r.path)).toEqual(['/camera/sdk/trigger_preset', '/camera/sdk/trigger_preset']);
    c.mode.ai_trace = 'ignore';
    expect(await ctl.send(CAM, 'http', { action: 'aiTracking', on: true })).toEqual({ sent: true, confirmed: false });
  });

  it('a camera that never answers: the call ends within the timeout; a huge answer is cut off; a closed port is not sent', async () => {
    const c = await cam();
    c.mode.trigger_preset = 'hang';
    const ctl = controller({ http: c.port }, { httpMs: 150 });
    const t0 = Date.now();
    expect((await ctl.send(CAM, 'http', { action: 'preset', preset: 1 })).confirmed).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
    c.mode.trigger_preset = 'huge';
    expect((await ctl.send(CAM, 'http', { action: 'preset', preset: 1 })).confirmed).toBe(true); // 2xx; the body is never kept
    const dead = await cam();
    const port = dead.port;
    await new Promise<void>((r) => (dead.server.closeAllConnections(), dead.server.close(() => r())));
    expect(await controller({ http: port }).send(CAM, 'http', { action: 'preset', preset: 1 })).toEqual({ sent: false, confirmed: false });
  });
});

describe('applyProfile', () => {
  it('sends preset, focus, tracking, then exposure, in that order, and answers every step', async () => {
    const c = await cam();
    const osc = await silentOsc();
    const ctl = controller({ http: c.port, osc: osc.port });
    const r = await ctl.applyProfile(CAM, 'http', { preset: 2, focus: 'single', tracking: 'human', exposureEv: 1 });
    expect(bodies(c)).toEqual(['/camera/sdk/trigger_preset {"id":1}', '/camera/sdk/af {"mode":2}', '/camera/sdk/ai_trace {"target":1}']);
    expect(c.state).toMatchObject({ af_mode: 2, target: 1 });
    expect(Buffer.concat(osc.frames).toString('hex')).toBe(OSC_EXPOSURE_P10);
    expect(r.steps).toEqual([
      { step: 'preset', sent: true, confirmed: true },
      { step: 'focus', sent: true, confirmed: true },
      { step: 'tracking', sent: true, confirmed: true },
      { step: 'exposure', sent: true, confirmed: false }, // the camera does not answer OSC commands
    ]);
    expect(r).toMatchObject({ sent: true, confirmed: false });
  });

  it('the default profile: preset 1, continuous focus, tracking off, brightness 0', async () => {
    const c = await cam();
    const osc = await silentOsc();
    await controller({ http: c.port, osc: osc.port }).applyProfile(CAM, 'http', CAMERA_PROFILE_DEFAULT);
    expect(bodies(c)).toEqual(['/camera/sdk/trigger_preset {"id":0}', '/camera/sdk/af {"mode":1}', '/camera/sdk/ai_trace {"target":0}']);
  });

  it('manual focus is mode 3', async () => {
    const c = await cam();
    c.state.af_mode = 1;
    await controller({ http: c.port }).applyProfile(CAM, 'http', { ...CAMERA_PROFILE_DEFAULT, focus: 'manual' });
    expect(bodies(c)[1]).toBe('/camera/sdk/af {"mode":3}');
  });

  it('a step that fails does not stop the next one', async () => {
    const c = await cam();
    const osc = await silentOsc();
    c.mode.af = '500';
    const r = await controller({ http: c.port, osc: osc.port }).applyProfile(CAM, 'http', CAMERA_PROFILE_DEFAULT);
    expect(c.reqs.map((q) => q.path)).toEqual(['/camera/sdk/trigger_preset', '/camera/sdk/af', '/camera/sdk/ai_trace']);
    expect(r.steps?.map((s) => [s.step, s.sent, s.confirmed])).toEqual([['preset', true, true], ['focus', true, false], ['tracking', true, true], ['exposure', true, false]]);
    expect(r.confirmed).toBe(false);
  });

  it('a camera that cannot be reached: every step answered sent:false, nothing thrown', async () => {
    const dead = await cam();
    const port = dead.port;
    await new Promise<void>((r) => (dead.server.closeAllConnections(), dead.server.close(() => r())));
    const closedOsc = await silentOsc();
    const r = await controller({ http: port, osc: closedOsc.port + 0 }).applyProfile(CAM, 'http', CAMERA_PROFILE_DEFAULT);
    expect(r.steps?.slice(0, 3).every((s) => !s.sent && !s.confirmed)).toBe(true);
    expect(r.confirmed).toBe(false);
  });

  it('a state that reads back right with a larger first message still confirms', async () => {
    const c = await cam();
    c.wsPad = 5000;
    const r = await controller({ http: c.port }).send(CAM, 'http', { action: 'aiTracking', on: true });
    expect(r.confirmed).toBe(true);
  });

  it('osc: only the steps with a documented command are sent (no focus command exists), in order', async () => {
    const osc = await silentOsc();
    const ctl = new CameraController({ ports: { osc: osc.port, visca: 1, http: 1 }, waitMs: 60, boxIps: [BOX], dial: () => '127.0.0.1', settleMs: 0 });
    const r = await ctl.applyProfile(CAM, 'osc', { preset: 1, focus: 'continuous', tracking: 'off', exposureEv: 0 });
    expect(r.steps?.map((s) => s.step)).toEqual(['preset', 'tracking', 'exposure']);
  });
});

describe('profile validation', () => {
  it('defaults and the allowed values', () => {
    expect(CAMERA_PROFILE_DEFAULT).toEqual({ preset: 1, focus: 'continuous', tracking: 'off', exposureEv: 0 });
    expect(parseCameraProfile({ preset: 3, focus: 'manual', tracking: 'human', exposureEv: -2.5 })).toEqual({ preset: 3, focus: 'manual', tracking: 'human', exposureEv: -2.5 });
    expect(parseCameraProfile({}, true)).toEqual(CAMERA_PROFILE_DEFAULT);
    expect(parseCameraProfile({ exposureEv: 3 }, true)?.exposureEv).toBe(3);
    for (const bad of [null, [], 'x', {}, { preset: 0, focus: 'continuous', tracking: 'off', exposureEv: 0 }, { preset: 1, focus: 'auto', tracking: 'off', exposureEv: 0 }, { preset: 1, focus: 'single', tracking: 'animal', exposureEv: 0 }, { preset: 1, focus: 'single', tracking: 'off', exposureEv: 3.5 }, { preset: 1, focus: 'single', tracking: 'off', exposureEv: 0.3 }, { preset: 1, focus: 'single', tracking: 'off', exposureEv: Number.NaN }]) {
      expect(parseCameraProfile(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(parseControlRequest({ action: 'applyProfile', profile: { preset: 3 }, host: '8.8.8.8' })).toEqual({ action: 'applyProfile' });
  });
});

/* ---------------------------------------------------------------- the routes */

const harnesses: LiveHarness[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  for (const a of apps.splice(0)) await a.close();
});
async function mini(o: { http: number; osc?: number }) {
  const h = await startLiveHarness();
  harnesses.push(h);
  const store = new CameraStore(h.dataDir, { boxIps: [BOX] });
  const app = Fastify();
  apps.push(app);
  app.addHook('onRequest', async (request) => {
    (request as { auth: unknown }).auth = { kind: 'user', userId: 'u1', deviceId: 'd1', roles: ['live'], sessionId: 's1', ops: false };
    (request as { tenant: unknown }).tenant = { surauId: LOCAL_SURAU_ID };
  });
  const handle = registerCameraRoutes(app, { db: h.app.surau.db, store, tester: null, sessions: { current: () => null }, limiters: createLimiters(), boxIps: [BOX], control: controller(o) });
  await app.ready();
  store.save({ url: ADDRESS });
  return { app, h, store, handle };
}
const put = (m: { app: FastifyInstance }, payload: object) => m.app.inject({ method: 'PUT', url: '/api/live/camera/control', payload });
const post = (m: { app: FastifyInstance }, payload: object) => m.app.inject({ method: 'POST', url: '/api/live/camera/control', payload });

describe('routes', () => {
  it('a new opt-in defaults to http with the default profile; the profile is saved and read back; a bad profile is 400 and changes nothing', async () => {
    const c = await cam();
    const m = await mini({ http: c.port });
    expect(m.store.getMasked().control).toEqual({ enabled: false, protocol: 'http', profile: CAMERA_PROFILE_DEFAULT, applyOnLive: false });
    const on = await put(m, { enabled: true });
    expect(on.json().control).toEqual({ enabled: true, protocol: 'http', profile: CAMERA_PROFILE_DEFAULT, applyOnLive: false });
    const saved = await put(m, { enabled: true, profile: { preset: 2, focus: 'single', tracking: 'human', exposureEv: -1.5 }, applyOnLive: true });
    expect(saved.statusCode).toBe(200);
    expect(m.store.getMasked().control).toMatchObject({ profile: { preset: 2, focus: 'single', tracking: 'human', exposureEv: -1.5 }, applyOnLive: true, protocol: 'http' });
    for (const bad of [{ enabled: true, profile: { preset: 9, focus: 'single', tracking: 'off', exposureEv: 0 } }, { enabled: true, profile: { preset: 1, focus: 'single', tracking: 'off', exposureEv: 0.2 } }, { enabled: true, applyOnLive: 'yes' }]) {
      expect((await put(m, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(m.store.getMasked().control.profile.preset).toBe(2);
  });

  it('applyProfile: the saved profile goes out, the body is ignored, the answer has the steps, the change log has a row without the address', async () => {
    const c = await cam();
    const osc = await silentOsc();
    const m = await mini({ http: c.port, osc: osc.port });
    await put(m, { enabled: true, profile: { preset: 3, focus: 'continuous', tracking: 'off', exposureEv: 0 } });
    const r = await post(m, { action: 'applyProfile', profile: { preset: 1 }, host: '8.8.8.8' });
    expect(r.statusCode).toBe(200);
    const j = r.json() as { sent: boolean; confirmed: boolean; steps: Array<{ step: string }> };
    expect(j.sent).toBe(true);
    expect(j.steps.map((s) => s.step)).toEqual(['preset', 'focus', 'tracking', 'exposure']);
    expect(bodies(c)[0]).toBe('/camera/sdk/trigger_preset {"id":2}');
    const log = changeLogText(m.h.app);
    expect(log).toContain('applyProfile');
    expect(log).not.toMatch(/lihat123|192\.168|8\.8\.8\.8/);
  });

  it('applyProfile counts as one call for the limit of 10 a minute', async () => {
    const c = await cam();
    const osc = await silentOsc();
    const m = await mini({ http: c.port, osc: osc.port });
    await put(m, { enabled: true });
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await post(m, { action: 'applyProfile' })).statusCode);
    expect(codes).toEqual([...Array(10).fill(200), 429]);
    // 10 calls of 3 http steps each, not 30 limiter hits
    expect(c.reqs).toHaveLength(30);
  });

  it('opt-in off: applyProfile is 404 and nothing is sent', async () => {
    const c = await cam();
    const m = await mini({ http: c.port });
    const r = await post(m, { action: 'applyProfile' });
    expect(r.statusCode).toBe(404);
    expect(c.reqs).toEqual([]);
  });

  it('the on-live hook: sends the profile once when the switch is on; sends nothing when off or the opt-in is off; never throws', async () => {
    const c = await cam();
    const osc = await silentOsc();
    const m = await mini({ http: c.port, osc: osc.port });
    await m.handle.applyOnLive();
    expect(c.reqs).toEqual([]); // opt-in off
    await put(m, { enabled: true });
    await m.handle.applyOnLive();
    expect(c.reqs).toEqual([]); // switch off
    await put(m, { enabled: true, applyOnLive: true });
    await m.handle.applyOnLive();
    expect(c.reqs).toHaveLength(3);
    expect(changeLogText(m.h.app)).toContain('applyProfile');
    // a camera that cannot be reached: still no throw
    await new Promise<void>((r) => (c.server.closeAllConnections(), c.server.close(() => r())));
    await expect(m.handle.applyOnLive()).resolves.toBeUndefined();
  });
});
