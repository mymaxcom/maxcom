import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { CAMERA_EXPOSURE_STEPS, cameraUrlError } from '@surau/core';
import type { CameraControlProtocol, CameraControlRequest, CameraControlResult, CameraProfile, CameraProfileStepResult } from '@surau/core';
import { CAMERA_MSG, CameraError } from './camera.ts';

/**
 * Network control of the mimbar camera (Lane X): a short fixed list of actions, each one message to the saved camera.
 *
 * The box sends packets to a device on the LAN, so everything here is fixed: the target host is always the host of the
 * saved camera address (the caller passes it, never a request), the port is fixed per protocol, the host must be a
 * private IPv4 address that is not the box itself, and the action is one of a fixed list. One message per call, a
 * short wait for the camera's reply, no retry, and no connection kept open between calls.
 *
 * Packets (maker command sheets for this camera, see the lane report):
 * - The camera's own HTTP interface, fixed port 80 (default protocol): POST /camera/sdk/<action> with a fixed JSON body,
 *   no login sent (the interface has none), no redirect followed, answer body never kept (cut at 16 KB), 2 s timeout.
 *   preset     trigger_preset {"id":n-1}
 *   focus      af {"mode":1|2|3}          (1 continuous, 2 single, 3 manual); only for the profile
 *   tracking   ai_trace {"target":0|1}    (0 none, 1 human)
 *   Confirmed = HTTP 2xx and, for focus and tracking, the state socket (ws /ws/, first message) shows the new value.
 *   The interface documents no exposure and no reset command: with this protocol those two go by OSC as below.
 * - OSC over TCP port 57110, OSC 1.0 stream framing (4-byte big-endian length, then the message), one int32 argument.
 *   exposure   /OBSBOT/WebCam/General/SetExposureCompensate  i = EV * 10 (one of the camera's 19 steps)
 *   preset     /OBSBOT/Camera/TailAir/TriggerPreset          i = preset number - 1
 *   reset      /OBSBOT/WebCam/General/ResetGimbal            i = 0
 *   tracking   /OBSBOT/Camera/TailAir/SetAiMode              i = 1 (normal tracking) or 0 (none)
 * - VISCA over IP on UDP port 52381: 8-byte header (type 0x0100 command, payload length, sequence) + the VISCA command.
 *   preset     81 01 04 3F 02 pp FF   (pp = preset number - 1)
 *   reset      81 01 06 04 FF         (HOME)
 *   tracking   81 01 8E 01 pp FF      (pp = 01 normal tracking, 00 none)
 *   exposure   none: the VISCA sheet has no exposure compensation command, so it is refused with `not_supported`.
 */

export const OSC_PORT = 57110;
export const VISCA_PORT = 52381;
export const HTTP_PORT = 80;

/** A single action: everything except the profile, which is a list of these. */
export type SingleControlAction = Exclude<CameraControlRequest, { action: 'applyProfile' }>;
/** The steps the profile is made of; `focus` exists only here (no route takes it). */
type StepAction = SingleControlAction | { action: 'focus'; mode: 1 | 2 | 3 };

const NOT_SUPPORTED = 'Tindakan ini tidak disokong oleh kaedah kawalan yang dipilih.';
const BAD_ACTION = 'Tindakan kamera tidak sah.';
export const CONTROL_MSG = { badAction: BAD_ACTION, notSupported: NOT_SUPPORTED } as const;

/**
 * The body of the control route, checked for shape and range. Null = refuse (400 `bad_action`). Only the fields of the
 * fixed list are read: a host, address or port in the body is not part of the result.
 */
export function parseControlRequest(body: unknown): CameraControlRequest | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  switch (b.action) {
    case 'exposure': {
      const ev = b.ev;
      if (typeof ev !== 'number' || !Number.isFinite(ev) || ev < -3 || ev > 3) return null;
      return { action: 'exposure', ev };
    }
    case 'preset': {
      const p = b.preset;
      if (p !== 1 && p !== 2 && p !== 3) return null;
      return { action: 'preset', preset: p };
    }
    case 'resetPosition':
      return { action: 'resetPosition' };
    case 'aiTracking':
      return typeof b.on === 'boolean' ? { action: 'aiTracking', on: b.on } : null;
    // the profile is never taken from the request: the box sends the one it saved
    case 'applyProfile':
      return { action: 'applyProfile' };
    default:
      return null;
  }
}

/** The exposure step (tenths of an EV) the camera accepts that is nearest to `ev`. */
export function nearestExposureStep(ev: number): number {
  const tenths = ev * 10;
  let best = CAMERA_EXPOSURE_STEPS[0] ?? 0;
  for (const s of CAMERA_EXPOSURE_STEPS) if (Math.abs(s - tenths) < Math.abs(best - tenths)) best = s;
  return best;
}

/* ---------------------------------------------------------------- packets */

const pad4 = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
const oscString = (s: string): Buffer => pad4(Buffer.concat([Buffer.from(s, 'ascii'), Buffer.from([0])]));

/** One OSC message with a single int32 argument, in OSC 1.0 stream framing (length prefix). */
function oscFrame(address: string, value: number): Buffer {
  const arg = Buffer.alloc(4);
  arg.writeInt32BE(value);
  const msg = Buffer.concat([oscString(address), oscString(',i'), arg]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(msg.length);
  return Buffer.concat([len, msg]);
}

export function oscPacket(a: SingleControlAction): Buffer {
  switch (a.action) {
    case 'exposure':
      return oscFrame('/OBSBOT/WebCam/General/SetExposureCompensate', nearestExposureStep(a.ev));
    case 'preset':
      return oscFrame('/OBSBOT/Camera/TailAir/TriggerPreset', a.preset - 1);
    case 'resetPosition':
      return oscFrame('/OBSBOT/WebCam/General/ResetGimbal', 0);
    case 'aiTracking':
      return oscFrame('/OBSBOT/Camera/TailAir/SetAiMode', a.on ? 1 : 0);
  }
}

/** The VISCA command bytes of an action, or null when the sheet has no command for it. */
function viscaCommand(a: SingleControlAction): Buffer | null {
  switch (a.action) {
    case 'exposure':
      return null;
    case 'preset':
      return Buffer.from([0x81, 0x01, 0x04, 0x3f, 0x02, a.preset - 1, 0xff]);
    case 'resetPosition':
      return Buffer.from([0x81, 0x01, 0x06, 0x04, 0xff]);
    case 'aiTracking':
      return Buffer.from([0x81, 0x01, 0x8e, 0x01, a.on ? 0x01 : 0x00, 0xff]);
  }
}

/** A VISCA over IP command datagram: header (type 0x0100, payload length, sequence) + the command. */
export function viscaPacket(a: SingleControlAction, seq: number): Buffer | null {
  const cmd = viscaCommand(a);
  if (cmd === null) return null;
  const head = Buffer.alloc(8);
  head.writeUInt16BE(0x0100, 0);
  head.writeUInt16BE(cmd.length, 2);
  head.writeUInt32BE(seq >>> 0, 4);
  return Buffer.concat([head, cmd]);
}

const OSC_ANSWER_CAP = 16 * 1024;
/** An OSC address that names a refusal (`/OBSBOT/Error`, `.../Failed`). */
const OSC_ERROR_ADDRESS = /error|fail|nack|invalid|unsupported|denied|refus/i;

/** Reads a NUL-terminated, 4-byte padded OSC string at `at`: the text and the offset after it, or null when malformed. */
function readOscString(b: Buffer, at: number): { text: string; next: number } | null {
  const end = b.indexOf(0, at);
  if (end === -1) return null;
  const next = at + Math.ceil((end - at + 1) / 4) * 4;
  if (next > b.length) return null;
  return { text: b.subarray(at, end).toString('latin1'), next };
}

/**
 * The verdict on the camera's answer to one OSC message (stream framing: 4-byte length, then address pattern, optional
 * type tag string and arguments): `ok` for a well-formed answer whose address is not an error (a missing tag string is
 * legal in older OSC), `error` for a well-formed answer whose LAST address segment names a refusal, `incomplete` while
 * the frame has not fully arrived, and `unreadable` for anything this parser cannot read (no length prefix, a bundle):
 * such an answer still shows the camera replied and is counted as confirmed, as it was before the verdict existed.
 */
export function oscAnswerVerdict(answer: Buffer): 'ok' | 'error' | 'incomplete' | 'unreadable' {
  if (answer.length < 4) return 'incomplete';
  const len = answer.readUInt32BE(0);
  if (len < 4 || len > OSC_ANSWER_CAP || len % 4 !== 0) return 'unreadable';
  if (answer.length < 4 + len) return 'incomplete';
  const msg = answer.subarray(4, 4 + len);
  const addr = readOscString(msg, 0);
  if (addr === null || !addr.text.startsWith('/')) return 'unreadable';
  // only the last segment names the outcome: a status path such as `/x/failover/state` is no refusal
  const last = addr.text.slice(addr.text.lastIndexOf('/') + 1);
  return OSC_ERROR_ADDRESS.test(last) ? 'error' : 'ok';
}

const HTTP_ANSWER_CAP = 16 * 1024;
const WS_CAP = 128 * 1024;

interface HttpCall {
  path: string;
  body: string;
  /** The state value that shows the camera took it (key of the state JSON, wanted value); none = HTTP status only. */
  expect?: { key: string; value: number };
}

/** The fixed HTTP request of a step, or null when the HTTP interface has no command for it. */
function httpCall(a: StepAction): HttpCall | null {
  switch (a.action) {
    case 'preset':
      return { path: '/camera/sdk/trigger_preset', body: JSON.stringify({ id: a.preset - 1 }) };
    case 'focus':
      return { path: '/camera/sdk/af', body: JSON.stringify({ mode: a.mode }), expect: { key: 'af_mode', value: a.mode } };
    case 'aiTracking':
      return { path: '/camera/sdk/ai_trace', body: JSON.stringify({ target: a.on ? 1 : 0 }), expect: { key: 'target', value: a.on ? 1 : 0 } };
    default:
      return null;
  }
}

const stepOf = (a: StepAction): CameraProfileStepResult['step'] => (a.action === 'aiTracking' ? 'tracking' : a.action === 'focus' ? 'focus' : a.action === 'exposure' ? 'exposure' : 'preset');

/* ---------------------------------------------------------------- sending */

export interface CameraControllerOptions {
  /** Fixed ports per protocol; tests point them at a local fake. */
  ports?: { osc: number; visca: number; http?: number };
  /** Longest wait for the camera's reply, and for a TCP connection (default 1000 ms). */
  waitMs?: number;
  /** Longest time of one HTTP request, and of the state read-back after it (default 2000 ms). */
  httpMs?: number;
  /** Pause after the preset step of the profile over HTTP, before the next step: the camera is still moving (default 3000 ms). */
  settleMs?: number;
  /** The box's own LAN addresses: an address pointing at the box itself is refused. */
  boxIps?: readonly string[];
  /** The address actually dialled for a validated host (the host itself unless a test redirects it to a local fake). */
  dial?: (host: string) => string;
}

const DOTTED = /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/;

export class CameraController {
  private readonly ports: { osc: number; visca: number; http: number };
  private readonly waitMs: number;
  private readonly httpMs: number;
  private readonly settleMs: number;
  private readonly boxIps: readonly string[];
  private readonly dial: (host: string) => string;
  private seq = 0;

  constructor(o: CameraControllerOptions = {}) {
    this.ports = { osc: OSC_PORT, visca: VISCA_PORT, http: HTTP_PORT, ...o.ports };
    this.waitMs = o.waitMs ?? 1000;
    this.httpMs = o.httpMs ?? 2000;
    this.settleMs = o.settleMs ?? 3000;
    this.boxIps = o.boxIps ?? [];
    this.dial = o.dial ?? ((h) => h);
  }

  /** Throws a 400 `bad_address` unless `host` is a plain private IPv4 address that is not the box itself. */
  assertHost(host: string): void {
    const ok = typeof host === 'string' && DOTTED.test(host) && cameraUrlError(`rtsp://${host}/`, this.boxIps) === null;
    if (!ok) throw new CameraError(400, 'bad_address', CAMERA_MSG.badAddress);
  }

  /**
   * Sends one message. Throws `CameraError` only for a refused host or an action the protocol has no command for
   * (nothing is sent then). A camera that is silent, or a connection that fails, is an answer, never an exception.
   */
  async send(host: string, protocol: CameraControlProtocol, action: SingleControlAction): Promise<CameraControlResult> {
    this.assertHost(host);
    if (protocol === 'visca') {
      this.seq = (this.seq % 0xffffffff) + 1;
      const packet = viscaPacket(action, this.seq);
      if (packet === null) throw new CameraError(400, 'not_supported', NOT_SUPPORTED);
      return this.sendUdp(this.dial(host), packet);
    }
    if (protocol === 'http') {
      const call = httpCall(action);
      // the HTTP interface has no exposure or reset command: those two go by OSC
      if (call === null) return this.sendTcp(this.dial(host), oscPacket(action));
      return this.sendHttp(this.dial(host), call);
    }
    return this.sendTcp(this.dial(host), oscPacket(action));
  }

  /**
   * The one-tap profile: preset, focus, tracking, exposure, in that order. A step that fails does not stop the next; a
   * step the protocol has no documented command for is left out of the answer. Never throws for what the camera does.
   */
  async applyProfile(host: string, protocol: CameraControlProtocol, profile: CameraProfile): Promise<CameraControlResult> {
    this.assertHost(host);
    const plan: StepAction[] = [
      { action: 'preset', preset: profile.preset },
      { action: 'focus', mode: profile.focus === 'continuous' ? 1 : profile.focus === 'single' ? 2 : 3 },
      { action: 'aiTracking', on: profile.tracking === 'human' },
      { action: 'exposure', ev: profile.exposureEv },
    ];
    const steps: CameraProfileStepResult[] = [];
    for (const a of plan) {
      const step = stepOf(a);
      let r: CameraControlResult;
      try {
        if (a.action === 'focus') {
          const call = httpCall(a);
          if (protocol !== 'http' || call === null) continue; // no documented focus command over OSC or VISCA
          r = await this.sendHttp(this.dial(host), call);
        } else {
          r = await this.send(host, protocol, a);
        }
      } catch (e) {
        if (e instanceof CameraError && e.code === 'not_supported') continue;
        r = { sent: false, confirmed: false };
      }
      steps.push({ step, sent: r.sent, confirmed: r.confirmed });
      if (step === 'preset' && r.sent && protocol === 'http' && this.settleMs > 0) await new Promise((res) => setTimeout(res, this.settleMs));
    }
    return { sent: steps.some((x) => x.sent), confirmed: steps.length > 0 && steps.every((x) => x.confirmed), steps };
  }

  /** HTTP: one POST, no redirect, bounded time and answer size; then, where the interface shows it, the state read back. */
  private async sendHttp(address: string, call: HttpCall): Promise<CameraControlResult> {
    const deadline = Date.now() + this.httpMs;
    const r = await this.post(address, call.path, call.body, this.httpMs);
    const ok = r.status >= 200 && r.status < 300;
    if (!ok || call.expect === undefined) return { sent: r.sent, confirmed: ok };
    return { sent: r.sent, confirmed: await this.stateIs(address, call.expect.key, call.expect.value, deadline) };
  }

  private post(address: string, path: string, body: string, ms: number): Promise<{ sent: boolean; status: number }> {
    return new Promise((resolve) => {
      let done = false;
      let sent = false;
      let status = 0;
      const req = httpRequest({
        host: address,
        port: this.ports.http,
        method: 'POST',
        path,
        agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Connection: 'close' },
      });
      const timer = setTimeout(() => finish(), ms);
      function finish(): void {
        if (done) return;
        done = true;
        clearTimeout(timer);
        req.destroy();
        resolve({ sent, status });
      }
      req.on('error', finish);
      req.on('finish', () => {
        sent = true;
      });
      req.on('response', (res) => {
        status = res.statusCode ?? 0;
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > HTTP_ANSWER_CAP) finish(); // the answer is never kept; a runaway one is cut off
        });
        res.on('end', finish);
        res.on('error', finish);
        res.on('close', finish);
      });
      req.end(body);
    });
  }

  /** The state socket of the camera: true when its state shows `key` = `value` (a few reads, until the deadline). */
  private async stateIs(address: string, key: string, value: number, deadline: number): Promise<boolean> {
    for (let i = 0; i < 4 && Date.now() < deadline; i++) {
      const state = await this.readState(address, Math.max(50, deadline - Date.now()));
      if (state !== null && state[key] === value) return true;
      await new Promise((res) => setTimeout(res, 150));
    }
    return false;
  }

  /** First message of ws://<camera>/ws/ as JSON, read with a minimal client (text frames, no mask, size capped); null on anything odd. */
  private readState(address: string, ms: number): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      let done = false;
      let buf: Buffer = Buffer.alloc(0);
      let headed = false;
      const payload: Buffer[] = [];
      let size = 0;
      const socket = connect({ host: address, port: this.ports.http });
      const timer = setTimeout(() => finish(null), ms);
      function finish(v: Record<string, unknown> | null): void {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(v);
      }
      socket.on('error', () => finish(null));
      socket.on('close', () => finish(null));
      socket.on('connect', () => {
        socket.write(`GET /ws/ HTTP/1.1\r\nHost: ${address}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      socket.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        if (buf.length > WS_CAP + 4096) return finish(null);
        if (!headed) {
          const end = buf.indexOf('\r\n\r\n');
          if (end === -1) return;
          if (!/^HTTP\/1\.1 101 /.test(buf.subarray(0, end).toString('latin1'))) return finish(null);
          buf = buf.subarray(end + 4);
          headed = true;
        }
        for (;;) {
          if (buf.length < 2) return;
          const b0 = buf[0] ?? 0;
          const b1 = buf[1] ?? 0;
          if ((b1 & 0x80) !== 0) return finish(null); // a server never masks
          let len = b1 & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            off = 4;
          } else if (len === 127) {
            return finish(null); // far above the cap
          }
          if (size + len > WS_CAP) return finish(null);
          if (buf.length < off + len) return;
          const op = b0 & 0x0f;
          const chunk = buf.subarray(off, off + len);
          buf = buf.subarray(off + len);
          if (op === 0x8) return finish(null);
          if (op === 0x9 || op === 0xa) continue;
          if (op !== 0x1 && op !== 0x0) return finish(null);
          payload.push(Buffer.from(chunk));
          size += len;
          if ((b0 & 0x80) !== 0) {
            try {
              const j: unknown = JSON.parse(Buffer.concat(payload).toString('utf8'));
              return finish(typeof j === 'object' && j !== null && !Array.isArray(j) ? (j as Record<string, unknown>) : null);
            } catch {
              return finish(null);
            }
          }
        }
      });
    });
  }

  /** OSC: connect, write the one framed message, read until a full answer or the wait ends, close. */
  private sendTcp(address: string, packet: Buffer): Promise<CameraControlResult> {
    return new Promise((resolve) => {
      let done = false;
      let sent = false;
      let timer: NodeJS.Timeout | null = null;
      let answer: Buffer = Buffer.alloc(0);
      const socket = connect({ host: address, port: this.ports.osc });
      const finish = (confirmed: boolean): void => {
        if (done) return;
        done = true;
        if (timer !== null) clearTimeout(timer);
        socket.destroy();
        resolve({ sent, confirmed });
      };
      // a connection that does not come up within the wait counts as "not sent"
      timer = setTimeout(() => finish(false), this.waitMs);
      socket.setNoDelay(true);
      socket.on('error', () => finish(false));
      // a cut-off answer still shows the camera replied (as before the verdict existed)
      socket.on('close', () => finish(answer.length > 0));
      // the answer is one OSC message in stream framing (it may arrive in pieces): confirmed unless it is a well-formed refusal
      socket.on('data', (d: Buffer) => {
        answer = Buffer.concat([answer, d]);
        if (answer.length > OSC_ANSWER_CAP) return finish(true);
        const verdict = oscAnswerVerdict(answer);
        if (verdict !== 'incomplete') finish(verdict !== 'error');
      });
      socket.on('connect', () => {
        socket.write(packet, (err) => {
          if (err) return finish(false);
          sent = true;
          // the reply wait starts when the message has left
          if (timer !== null) clearTimeout(timer);
          timer = setTimeout(() => finish(answer.length > 0), this.waitMs);
        });
      });
    });
  }

  /** VISCA over IP: one datagram, then wait for an acknowledge or completion from the same host and port. */
  private sendUdp(address: string, packet: Buffer): Promise<CameraControlResult> {
    return new Promise((resolve) => {
      let done = false;
      let sent = false;
      let timer: NodeJS.Timeout | null = null;
      const socket = createSocket('udp4');
      const finish = (confirmed: boolean): void => {
        if (done) return;
        done = true;
        if (timer !== null) clearTimeout(timer);
        try {
          socket.close();
        } catch {
          /* already closed */
        }
        resolve({ sent, confirmed });
      };
      socket.on('error', () => finish(false));
      socket.on('message', (m, from) => {
        if (from.address !== address || from.port !== this.ports.visca) return;
        // a reply is the IP header (type 0x0111) and a VISCA answer: 4x acknowledge, 5x completion, 6x error
        if (m.length < 10 || m.readUInt16BE(0) !== 0x0111) return;
        const kind = (m[9] ?? 0) >> 4;
        if (kind === 4 || kind === 5) finish(true);
        else if (kind === 6) finish(false);
      });
      timer = setTimeout(() => finish(false), this.waitMs);
      socket.send(packet, this.ports.visca, address, (err) => {
        if (err) return finish(false);
        sent = true;
      });
    });
  }
}
