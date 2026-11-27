import { createServer, type Server, type Socket } from 'node:net';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { createLimiters } from '../src/auth/authz.ts';
import { CameraStore } from '../src/live/camera.ts';
import { CameraController, oscAnswerVerdict, parseControlRequest } from '../src/live/cameraControl.ts';
import { registerCameraRoutes } from '../src/live/cameraRoutes.ts';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';
import { loginAs } from './authHelpers.ts';
import { changeLogText, startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';

const CAM = '10.168.1.20';
const BOX = '10.168.1.40';
const ADDRESS = `rtsp://viewer:lihat123@${CAM}:554/main`;

/* The exact packets, written out by hand from the maker's command sheets (see the lane report):
 * OSC over TCP is OSC 1.0 stream framing: a 4-byte length, then address + type tag ",i" + one int32. */
const OSC_EXPOSURE_M27 = '000000382f4f4253424f542f57656243616d2f47656e6572616c2f5365744578706f73757265436f6d70656e73617465000000002c690000ffffffe5';
const OSC_EXPOSURE_P30 = '000000382f4f4253424f542f57656243616d2f47656e6572616c2f5365744578706f73757265436f6d70656e73617465000000002c6900000000001e';
const OSC_PRESET_3 = '000000302f4f4253424f542f43616d6572612f5461696c4169722f54726967676572507265736574000000002c69000000000002';
const OSC_RESET = '0000002c2f4f4253424f542f57656243616d2f47656e6572616c2f526573657447696d62616c00002c69000000000000';
const OSC_AI_ON = '0000002c2f4f4253424f542f43616d6572612f5461696c4169722f53657441694d6f6465000000002c69000000000001';
const OSC_AI_OFF = '0000002c2f4f4253424f542f43616d6572612f5461696c4169722f53657441694d6f6465000000002c69000000000000';
/* VISCA over IP: header 01 00 (command), payload length, 4-byte sequence, then the VISCA bytes. */
const visca = (seq: number, payloadHex: string): string => `0100${(payloadHex.length / 2).toString(16).padStart(4, '0')}${seq.toString(16).padStart(8, '0')}${payloadHex}`;
const VISCA_HOME = visca(1, '81010604ff');

interface FakeOsc {
  server: Server;
  port: number;
  frames: Buffer[];
  connections: number;
  reply: boolean;
  dialled: string[];
}
async function fakeOsc(reply = false): Promise<FakeOsc> {
  const f: FakeOsc = { server: createServer(), port: 0, frames: [], connections: 0, reply, dialled: [] };
  f.server.on('connection', (s: Socket) => {
    f.connections++;
    s.on('data', (d) => {
      f.frames.push(Buffer.from(d));
      if (f.reply) {
        const addr = Buffer.from('/OBSBOT/WebCam/General/ZoomInfo\0,ii\0\0\0\0\0\0\0\0\0\0\0\0\0', 'latin1');
        const len = Buffer.alloc(4);
        len.writeUInt32BE(addr.length);
        s.write(Buffer.concat([len, addr]));
      }
    });
    s.on('error', () => undefined);
  });
  await new Promise<void>((r) => f.server.listen(0, '127.0.0.1', r));
  f.port = (f.server.address() as { port: number }).port;
  return f;
}

interface FakeVisca {
  sock: UdpSocket;
  port: number;
  got: Buffer[];
  reply: 'ack' | 'error' | 'none';
}
async function fakeVisca(reply: FakeVisca['reply'] = 'none'): Promise<FakeVisca> {
  const sock = createSocket('udp4');
  const f: FakeVisca = { sock, port: 0, got: [], reply };
  sock.on('message', (m, r) => {
    f.got.push(m);
    if (f.reply === 'none') return;
    const body = f.reply === 'ack' ? Buffer.from([0x90, 0x41, 0xff]) : Buffer.from([0x90, 0x60, 0x02, 0xff]);
    const head = Buffer.from([0x01, 0x11, 0x00, body.length, m[4] ?? 0, m[5] ?? 0, m[6] ?? 0, m[7] ?? 0]);
    sock.send(Buffer.concat([head, body]), r.port, r.address);
  });
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', r));
  f.port = sock.address().port;
  return f;
}

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});
async function oscFake(reply = false): Promise<FakeOsc> {
  const f = await fakeOsc(reply);
  closers.push(() => new Promise<void>((r) => f.server.close(() => r())));
  return f;
}
async function viscaFake(reply: FakeVisca['reply'] = 'none'): Promise<FakeVisca> {
  const f = await fakeVisca(reply);
  closers.push(() => new Promise<void>((r) => f.sock.close(() => r())));
  return f;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await wait(5);
  }
}

/** The controller points the validated saved host at the local fake; the test records which host it was asked for. */
function controller(ports: { osc: number; visca: number }, o: { waitMs?: number; boxIps?: string[]; asked?: string[] } = {}): CameraController {
  return new CameraController({
    ports,
    waitMs: o.waitMs ?? 300,
    boxIps: o.boxIps ?? [BOX],
    dial: (host) => {
      o.asked?.push(host);
      return '127.0.0.1';
    },
  });
}

describe('the exact packet of each action', () => {
  it('OSC: exposure, preset, reset, tracking on and off, each one framed message to the saved host and the fixed port', async () => {
    const osc = await oscFake(true);
    const asked: string[] = [];
    const c = controller({ osc: osc.port, visca: 1 }, { asked });
    const cases: Array<[Parameters<CameraController['send']>[2], string]> = [
      [{ action: 'exposure', ev: -2.7 }, OSC_EXPOSURE_M27],
      [{ action: 'exposure', ev: 3 }, OSC_EXPOSURE_P30],
      [{ action: 'preset', preset: 3 }, OSC_PRESET_3],
      [{ action: 'resetPosition' }, OSC_RESET],
      [{ action: 'aiTracking', on: true }, OSC_AI_ON],
      [{ action: 'aiTracking', on: false }, OSC_AI_OFF],
    ];
    for (const [action, hex] of cases) {
      osc.frames.length = 0;
      const r = await c.send(CAM, 'osc', action);
      expect(r).toEqual({ sent: true, confirmed: true });
      expect(Buffer.concat(osc.frames).toString('hex'), JSON.stringify(action)).toBe(hex);
    }
    // one connection per call: nothing is kept open between calls
    expect(osc.connections).toBe(cases.length);
    expect(asked).toEqual(Array(cases.length).fill(CAM));
  });

  it('OSC: an exposure between two steps goes to the nearest step the camera accepts', async () => {
    const osc = await oscFake();
    const c = controller({ osc: osc.port, visca: 1 }, { waitMs: 40 });
    await c.send(CAM, 'osc', { action: 'exposure', ev: -2.6 });
    expect(Buffer.concat(osc.frames).toString('hex')).toBe(OSC_EXPOSURE_M27);
  });

  it('VISCA: preset, home and tracking, each one datagram with the IP header and a rising sequence number', async () => {
    const v = await viscaFake('ack');
    const c = controller({ osc: 1, visca: v.port });
    expect(await c.send(CAM, 'visca', { action: 'preset', preset: 3 })).toEqual({ sent: true, confirmed: true });
    expect(await c.send(CAM, 'visca', { action: 'resetPosition' })).toEqual({ sent: true, confirmed: true });
    expect(await c.send(CAM, 'visca', { action: 'aiTracking', on: true })).toEqual({ sent: true, confirmed: true });
    expect(await c.send(CAM, 'visca', { action: 'aiTracking', on: false })).toEqual({ sent: true, confirmed: true });
    expect(v.got.map((b) => b.toString('hex'))).toEqual([visca(1, '8101043f0202ff'), visca(2, '81010604ff'), visca(3, '81018e0101ff'), visca(4, '81018e0100ff')]);
  });

  it('VISCA: exposure has no documented command, so it is refused and nothing is sent', async () => {
    const v = await viscaFake('ack');
    const c = controller({ osc: 1, visca: v.port });
    await expect(c.send(CAM, 'visca', { action: 'exposure', ev: 1 })).rejects.toMatchObject({ status: 400, code: 'not_supported' });
    await wait(30);
    expect(v.got).toEqual([]);
  });
});

describe('what the camera answers', () => {
  it('a silent OSC camera: sent, confirmed false, within the wait, no exception', async () => {
    const osc = await oscFake(false);
    const c = controller({ osc: osc.port, visca: 1 }, { waitMs: 120 });
    const t0 = Date.now();
    expect(await c.send(CAM, 'osc', { action: 'resetPosition' })).toEqual({ sent: true, confirmed: false });
    expect(Date.now() - t0).toBeLessThan(900);
    expect(Buffer.concat(osc.frames).toString('hex')).toBe(OSC_RESET);
  });

  /** A fake OSC camera that answers every message with one framed OSC message (address, type tags, optional string argument). */
  async function oscAnswering(address: string, tags: string, strArg?: string): Promise<FakeOsc> {
    const f = await oscFake(false);
    const pad = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4 || 0)]);
    const str = (t: string): Buffer => pad(Buffer.concat([Buffer.from(t, 'ascii'), Buffer.from([0])]));
    const msg = Buffer.concat([str(address), str(tags), ...(strArg === undefined ? [] : [str(strArg)])]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(msg.length);
    f.server.removeAllListeners('connection');
    f.server.on('connection', (s: Socket) => {
      s.on('data', (d) => {
        f.frames.push(Buffer.from(d));
        // answer in two pieces: the reader has to join them
        const whole = Buffer.concat([len, msg]);
        s.write(whole.subarray(0, 5));
        setTimeout(() => s.write(whole.subarray(5)), 10);
      });
      s.on('error', () => undefined);
    });
    return f;
  }

  it('an OSC success answer is confirmed; an OSC error answer is answered, not confirmed', async () => {
    const ok = await oscAnswering('/OBSBOT/WebCam/General/ResetGimbal', ',i');
    const okR = await controller({ osc: ok.port, visca: 1 }, { waitMs: 400 }).send(CAM, 'osc', { action: 'resetPosition' });
    expect(okR).toEqual({ sent: true, confirmed: true });
    const bad = await oscAnswering('/OBSBOT/Error', ',s', 'unknown command');
    const t0 = Date.now();
    const badR = await controller({ osc: bad.port, visca: 1 }, { waitMs: 400 }).send(CAM, 'osc', { action: 'resetPosition' });
    expect(badR).toEqual({ sent: true, confirmed: false });
    expect(Date.now() - t0).toBeLessThan(380); // answered at once, not by the timeout
    // an answer the parser cannot read still shows the camera replied: confirmed, as before the verdict existed
    const junk = await oscAnswering('not-an-address', ',i');
    expect(await controller({ osc: junk.port, visca: 1 }, { waitMs: 200 }).send(CAM, 'osc', { action: 'resetPosition' })).toEqual({ sent: true, confirmed: true });
  });

  describe('oscAnswerVerdict', () => {
    const pad = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
    const str = (t: string): Buffer => pad(Buffer.concat([Buffer.from(t, 'ascii'), Buffer.from([0])]));
    const frame = (...parts: Buffer[]): Buffer => {
      const msg = Buffer.concat(parts);
      const len = Buffer.alloc(4);
      len.writeUInt32BE(msg.length);
      return Buffer.concat([len, msg]);
    };

    it('the error words count on the last address segment only', () => {
      expect(oscAnswerVerdict(frame(str('/OBSBOT/Error'), str(',s'), str('x')))).toBe('error');
      expect(oscAnswerVerdict(frame(str('/OBSBOT/WebCam/Failed'), str(',i')))).toBe('error');
      expect(oscAnswerVerdict(frame(str('/OBSBOT/failover/state'), str(',i')))).toBe('ok');
      expect(oscAnswerVerdict(frame(str('/OBSBOT/WebCam/General/ResetGimbal'), str(',i')))).toBe('ok');
    });

    it('a reply without a type tag string is ok when the address is not an error', () => {
      expect(oscAnswerVerdict(frame(str('/OBSBOT/WebCam/General/ResetGimbal')))).toBe('ok');
      expect(oscAnswerVerdict(frame(str('/OBSBOT/Error')))).toBe('error');
    });

    it('an answer it cannot read (no length prefix, a bundle) is unreadable, not an error; a short one is incomplete', () => {
      expect(oscAnswerVerdict(Buffer.concat([str('/OBSBOT/Ok'), str(',i')]))).toBe('unreadable');
      expect(oscAnswerVerdict(frame(str('#bundle'), Buffer.alloc(8)))).toBe('unreadable');
      expect(oscAnswerVerdict(Buffer.from([0, 0]))).toBe('incomplete');
    });
  });

  it('a silent VISCA camera: confirmed false; a VISCA error reply is not a confirmation', async () => {
    const quiet = await viscaFake('none');
    const t0 = Date.now();
    expect(await controller({ osc: 1, visca: quiet.port }, { waitMs: 120 }).send(CAM, 'visca', { action: 'resetPosition' })).toEqual({ sent: true, confirmed: false });
    expect(Date.now() - t0).toBeLessThan(900);
    const bad = await viscaFake('error');
    expect(await controller({ osc: 1, visca: bad.port }, { waitMs: 200 }).send(CAM, 'visca', { action: 'resetPosition' })).toEqual({ sent: true, confirmed: false });
  });

  it('an OSC camera that refuses the connection: nothing left the box, answered as data, never thrown, no retry', async () => {
    const osc = await oscFake();
    const dead = osc.port;
    await new Promise<void>((r) => osc.server.close(() => r()));
    closers.push(() => undefined);
    const c = controller({ osc: dead, visca: 1 }, { waitMs: 100 });
    expect(await c.send(CAM, 'osc', { action: 'resetPosition' })).toEqual({ sent: false, confirmed: false });
  });
});

describe('where the packet may go', () => {
  it('a public address and the box itself are refused before anything is dialled', async () => {
    const osc = await oscFake();
    const asked: string[] = [];
    const c = controller({ osc: osc.port, visca: 1 }, { asked, boxIps: [BOX] });
    for (const host of ['8.8.8.8', BOX, '127.0.0.1', '169.254.1.1', 'camera.local', '10.168.1.20:80', '']) {
      await expect(c.send(host, 'osc', { action: 'resetPosition' }), host).rejects.toMatchObject({ status: 400, code: 'bad_address' });
    }
    expect(asked).toEqual([]);
    expect(osc.connections).toBe(0);
  });
});

describe('parseControlRequest', () => {
  it('accepts only the fixed list, with values in range; a host in the body is not part of the result', () => {
    expect(parseControlRequest({ action: 'exposure', ev: -3 })).toEqual({ action: 'exposure', ev: -3 });
    expect(parseControlRequest({ action: 'preset', preset: 2, host: '8.8.8.8' })).toEqual({ action: 'preset', preset: 2 });
    expect(parseControlRequest({ action: 'resetPosition', port: 80 })).toEqual({ action: 'resetPosition' });
    expect(parseControlRequest({ action: 'aiTracking', on: false })).toEqual({ action: 'aiTracking', on: false });
    for (const bad of [null, [], 'x', {}, { action: 'zoom' }, { action: 'exposure' }, { action: 'exposure', ev: 3.1 }, { action: 'exposure', ev: Number.NaN }, { action: 'exposure', ev: '1' }, { action: 'preset', preset: 0 }, { action: 'preset', preset: 4 }, { action: 'preset', preset: 1.5 }, { action: 'aiTracking' }, { action: 'aiTracking', on: 1 }]) {
      expect(parseControlRequest(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

/* ---------------------------------------------------------------- the routes */

const harnesses: LiveHarness[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  for (const a of apps.splice(0)) await a.close();
});

async function mini(o: { ports: { osc: number; visca: number }; roles?: string[]; device?: string; waitMs?: number }) {
  const h = await startLiveHarness();
  harnesses.push(h);
  const store = new CameraStore(h.dataDir, { boxIps: [BOX] });
  const asked: string[] = [];
  const app = Fastify();
  apps.push(app);
  app.addHook('onRequest', async (request) => {
    (request as { auth: unknown }).auth = { kind: 'user', userId: 'u1', deviceId: o.device ?? 'd1', roles: o.roles ?? ['live'], sessionId: 's1', ops: false };
    (request as { tenant: unknown }).tenant = { surauId: LOCAL_SURAU_ID };
  });
  registerCameraRoutes(app, {
    db: h.app.surau.db,
    store,
    tester: null,
    sessions: { current: () => null },
    limiters: createLimiters(),
    boxIps: [BOX],
    control: controller(o.ports, { waitMs: o.waitMs ?? 80, asked }),
  });
  await app.ready();
  return { app, h, store, asked };
}
const control = (m: { app: FastifyInstance }, payload: object) => m.app.inject({ method: 'POST', url: '/api/live/camera/control', payload });
const enable = (m: { app: FastifyInstance }, protocol: 'osc' | 'visca') => m.app.inject({ method: 'PUT', url: '/api/live/camera/control', payload: { enabled: true, protocol } });

describe('POST /api/live/camera/control', () => {
  it('opt-in off (the default): 404 and nothing is sent; no camera saved: also 404', async () => {
    const osc = await oscFake();
    const v = await viscaFake();
    const m = await mini({ ports: { osc: osc.port, visca: v.port } });
    expect((await control(m, { action: 'resetPosition' })).statusCode).toBe(404); // no camera
    m.store.save({ url: ADDRESS });
    const r = await control(m, { action: 'resetPosition' });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ code: 'control_off' });
    await wait(40);
    expect(osc.connections).toBe(0);
    expect(v.got).toEqual([]);
    expect(m.store.getMasked().control).toEqual({ enabled: false, protocol: 'http', profile: { preset: 1, focus: 'continuous', tracking: 'off', exposureEv: 0 }, applyOnLive: false });
  });

  it('with the opt-in on (osc): one framed message to the saved host; a host named in the request is ignored; the change log has a row without the address', async () => {
    const osc = await oscFake(true);
    const m = await mini({ ports: { osc: osc.port, visca: 1 } });
    m.store.save({ url: ADDRESS });
    expect((await enable(m, 'osc')).statusCode).toBe(200);
    const r = await control(m, { action: 'preset', preset: 3, host: '8.8.8.8', address: '10.0.0.9', port: 80 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ sent: true, confirmed: true });
    expect(r.headers['cache-control']).toBe('no-store');
    expect(Buffer.concat(osc.frames).toString('hex')).toBe(OSC_PRESET_3);
    expect(m.asked).toEqual([CAM]);
    const log = changeLogText(m.h.app);
    expect(log).toContain('live-camera');
    expect(log).toContain('control');
    expect(log).toContain('preset');
    expect(log).not.toMatch(/lihat123|192\.168|8\.8\.8\.8/);
  });

  it('with the opt-in on (visca): one datagram to the saved host; exposure is refused 400 not_supported and sends nothing', async () => {
    const v = await viscaFake('ack');
    const m = await mini({ ports: { osc: 1, visca: v.port } });
    m.store.save({ url: ADDRESS });
    await enable(m, 'visca');
    expect((await control(m, { action: 'resetPosition' })).json()).toEqual({ sent: true, confirmed: true });
    expect(v.got.map((b) => b.toString('hex'))).toEqual([VISCA_HOME]);
    const e = await control(m, { action: 'exposure', ev: 1 });
    expect(e.statusCode).toBe(400);
    expect(e.json()).toMatchObject({ code: 'not_supported' });
    expect(v.got).toHaveLength(1);
  });

  it('a silent camera is answered 200 with confirmed false', async () => {
    const osc = await oscFake(false);
    const m = await mini({ ports: { osc: osc.port, visca: 1 }, waitMs: 60 });
    m.store.save({ url: ADDRESS });
    await enable(m, 'osc');
    const r = await control(m, { action: 'aiTracking', on: true });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ sent: true, confirmed: false });
  });

  it('a body outside the fixed list is 400 and sends nothing', async () => {
    const osc = await oscFake();
    const m = await mini({ ports: { osc: osc.port, visca: 1 } });
    m.store.save({ url: ADDRESS });
    await enable(m, 'osc');
    for (const bad of [{}, { action: 'zoom' }, { action: 'exposure', ev: 9 }, { action: 'preset', preset: 7 }]) {
      const r = await control(m, bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
      expect(r.json()).toMatchObject({ code: 'bad_action' });
    }
    expect(osc.connections).toBe(0);
  });

  it('a saved address that is now the box itself is refused and nothing is dialled', async () => {
    const osc = await oscFake();
    const h = await startLiveHarness();
    harnesses.push(h);
    // the box learned its own address after the camera was saved
    const store = new CameraStore(h.dataDir, { boxIps: [] });
    store.save({ url: `rtsp://${BOX}:554/main` });
    store.setControl({ enabled: true, protocol: 'osc', profile: { preset: 1, focus: 'continuous', tracking: 'off', exposureEv: 0 }, applyOnLive: false });
    const asked: string[] = [];
    const app = Fastify();
    apps.push(app);
    app.addHook('onRequest', async (request) => {
      (request as { auth: unknown }).auth = { kind: 'user', userId: 'u1', deviceId: 'd1', roles: ['live'], sessionId: 's1', ops: false };
      (request as { tenant: unknown }).tenant = { surauId: LOCAL_SURAU_ID };
    });
    registerCameraRoutes(app, { db: h.app.surau.db, store, tester: null, sessions: { current: () => null }, limiters: createLimiters(), boxIps: [BOX], control: controller({ osc: osc.port, visca: 1 }, { asked }) });
    await app.ready();
    const r = await control({ app }, { action: 'resetPosition' });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'bad_address' });
    expect(asked).toEqual([]);
    expect(osc.connections).toBe(0);
  });

  it('is limited to 10 a minute per device; another device has its own allowance', async () => {
    const osc = await oscFake();
    const m = await mini({ ports: { osc: osc.port, visca: 1 }, waitMs: 5 });
    m.store.save({ url: ADDRESS });
    await enable(m, 'osc');
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await control(m, { action: 'aiTracking', on: i % 2 === 0 })).statusCode);
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(codes.slice(10)).toEqual([429, 429]);
    await until(() => osc.connections === 10);
    expect(osc.connections).toBe(10);
  });

  it('turning the opt-in on needs a saved camera and a known protocol', async () => {
    const m = await mini({ ports: { osc: 1, visca: 1 } });
    expect((await enable(m, 'osc')).statusCode).toBe(404); // no camera yet
    m.store.save({ url: ADDRESS });
    expect((await m.app.inject({ method: 'PUT', url: '/api/live/camera/control', payload: { enabled: true, protocol: 'onvif' } })).statusCode).toBe(400);
    expect((await m.app.inject({ method: 'PUT', url: '/api/live/camera/control', payload: { enabled: 'yes' } })).statusCode).toBe(400);
    const ok = await enable(m, 'visca');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ configured: true, control: { enabled: true, protocol: 'visca' } });
    // a later save of the address keeps the choice
    m.store.save({ url: `rtsp://viewer:lihat123@${CAM}:554/sub` });
    expect(m.store.getMasked().control).toMatchObject({ enabled: true, protocol: 'visca' });
    // the change log says the opt-in changed
    expect(changeLogText(m.h.app)).toContain('control-setting');
    // removing the camera removes the opt-in with it
    m.store.clear();
    m.store.save({ url: ADDRESS });
    expect(m.store.getMasked().control).toEqual({ enabled: false, protocol: 'http', profile: { preset: 1, focus: 'continuous', tracking: 'off', exposureEv: 0 }, applyOnLive: false });
  });
});

describe('roles on a real box app', () => {
  it('the live role passes the role check on both control routes (404 with the opt-in off); Media and a reader are refused', async () => {
    const h = await startLiveHarness();
    harnesses.push(h);
    const live = await loginAs(h.app, 'live');
    const media = await loginAs(h.app, 'media');
    const call = (headers: Record<string, string>, method: 'POST' | 'PUT') =>
      h.app.inject({ method, url: '/api/live/camera/control', headers, remoteAddress: '10.168.1.41', payload: method === 'POST' ? { action: 'resetPosition' } : { enabled: true, protocol: 'osc' } });
    for (const method of ['POST', 'PUT'] as const) {
      expect((await call(media.headers, method)).statusCode, `media ${method}`).toBe(403);
      const r = await call(live.headers, method);
      expect([401, 403], `live ${method} ${r.body}`).not.toContain(r.statusCode);
      expect(r.statusCode).toBe(404);
    }
  });
});
