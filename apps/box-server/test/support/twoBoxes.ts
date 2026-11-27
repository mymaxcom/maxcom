import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';
import type { PeerTransport } from '../../src/link/session.ts';
import { loginAs, TEST_PIN } from '../authHelpers.ts';
import type { Login } from '../authHelpers.ts';

/**
 * Several boxes of one surau in one process, for the link route tests. Every box is a real `buildApp` with its own
 * database and a `PeerTransport` that carries a box-to-box call to the other app with `app.inject`, from the
 * calling box's own LAN address (so the LAN guard sees a private peer).
 */

export const PIN = TEST_PIN;
export const WRONG_PIN = '135790';

export interface WireCall {
  from: string;
  to: string;
  path: string;
  body: Record<string, unknown>;
}

export interface TestBox {
  n: number;
  app: FastifyInstance;
  origin: string;
  ca: string;
  /** The box's own LAN address (what the other boxes see as the caller). */
  addr: string;
  dir: string | null;
  restarts: number;
  /** Signed-in admin (null for a box that was never set up). */
  admin: Login | null;
  /** The box's own TV: loopback, no cookie. */
  tv: () => Promise<{ status: number; body: Record<string, any> }>;
  /** An app call from this box's LAN with the admin token. */
  call: (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, o?: { headers?: Record<string, string>; from?: string; as?: Login | null }) => Promise<{ status: number; body: Record<string, any> }>;
}

export interface World {
  /** The clock both boxes use. */
  clock: { now: () => Date; tick: (ms: number) => void; set: (d: Date) => void };
  boxes: Map<string, TestBox>;
  calls: WireCall[];
  /** When set, a call is awaited before it is sent on; return a promise to hold it, or undefined to let it pass. */
  hold: ((c: WireCall) => Promise<void> | undefined) | null;
  /** When set and it returns true, the call fails like a dead network. */
  drop: ((c: WireCall) => boolean) | null;
  make: (n: number, o?: MakeOptions) => Promise<TestBox>;
  /** Builds the box `n` again on the same data folder (a restart of the process). */
  reopen: (box: TestBox) => TestBox;
  close: () => Promise<void>;
}

export interface MakeOptions {
  /** `false`: a box never set up (no admin). Default true. */
  setUp?: boolean;
  /** Keep the database and the identity in a temp folder (needed to restart the box). */
  persist?: boolean;
  /** Turn the app lock on, so the PIN is asked (default true when set up). */
  appLock?: boolean;
}

const hex64 = (n: number): string => String(n % 10).repeat(64);

export function createWorld(): World {
  let time = new Date('2026-11-22T10:00:00.000Z');
  const clock = {
    now: (): Date => time,
    tick: (ms: number): void => {
      time = new Date(time.getTime() + ms);
    },
    set: (d: Date): void => {
      time = d;
    },
  };
  const boxes = new Map<string, TestBox>();
  const calls: WireCall[] = [];
  const dirs: string[] = [];

  const peerFor = (from: { addr: string; origin: string }): PeerTransport => ({
    async post(origin, ca, path, body) {
      const call: WireCall = { from: from.origin, to: origin, path, body: structuredClone(body) as Record<string, unknown> };
      calls.push(call);
      if (world.drop?.(call) === true) throw new Error('down');
      const to = boxes.get(origin);
      if (to === undefined || to.ca !== ca) throw new Error('unreachable');
      const held = world.hold?.(call);
      if (held !== undefined) await held;
      const r = await to.app.inject({ method: 'POST', url: path, payload: body as object, remoteAddress: from.addr });
      let json: unknown = null;
      try {
        json = r.json();
      } catch {
        json = null;
      }
      return { status: r.statusCode, json };
    },
  });

  const build = (n: number, dir: string | null, o: MakeOptions, prev?: TestBox): TestBox => {
    const addr = `10.168.50.${10 + n}`;
    const origin = `https://${addr}:8443`;
    const ca = hex64(n);
    const box = (prev ?? { n, origin, ca, addr, dir, restarts: 0, admin: null }) as TestBox;
    const app = buildApp(dir === null ? ':memory:' : join(dir, 'surau.db'), {
      now: clock.now,
      ...(dir === null ? {} : { dataDir: dir }),
      link: { peer: peerFor({ addr, origin }), origin, caSha256: ca, restart: () => { box.restarts += 1; } },
    });
    box.app = app;
    box.dir = dir;
    box.tv = async () => {
      const r = await app.inject({ method: 'GET', url: '/api/kiosk/link', remoteAddress: '127.0.0.1' });
      return { status: r.statusCode, body: safeJson(r) };
    };
    box.call = async (method, url, payload, x = {}) => {
      const who = x.as === undefined ? box.admin : x.as;
      const r = await app.inject({
        method, url, remoteAddress: x.from ?? addr,
        headers: { ...(who !== null ? who.headers : {}), ...(x.headers ?? {}) },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
      return { status: r.statusCode, body: safeJson(r) };
    };
    boxes.set(origin, box);
    return box;
  };

  const world: World = {
    clock, boxes, calls, hold: null, drop: null,
    async make(n, o = {}) {
      let dir: string | null = null;
      if (o.persist === true) {
        dir = mkdtempSync(join(tmpdir(), 'surau-link-'));
        dirs.push(dir);
      }
      const box = build(n, dir, o);
      if (o.setUp !== false) {
        box.admin = await loginAs(box.app, 'admin');
        if (o.appLock !== false) {
          const r = await box.app.inject({ method: 'PUT', url: '/api/settings/appLock', headers: box.admin.headers, payload: { enabled: true } });
          if (r.statusCode !== 200) throw new Error(`app lock: ${r.statusCode} ${r.body}`);
        }
      }
      return box;
    },
    reopen(box) {
      return build(box.n, box.dir, {}, box);
    },
    async close() {
      for (const b of boxes.values()) await b.app.close().catch(() => undefined);
      boxes.clear();
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
  return world;
}

function safeJson(r: { json: () => unknown }): Record<string, any> {
  try {
    const j = r.json();
    return typeof j === 'object' && j !== null ? (j as Record<string, any>) : { value: j };
  } catch {
    return {};
  }
}

/** Polls until `fn` stops throwing (the boxes finish their own work in the background). */
export async function until(fn: () => void | Promise<void>, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      await fn();
      return;
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 15));
    }
  }
}

/** The master's side of case N-S: the new box shows its QR, the set-up box scans, approves and agrees. */
export async function linkNewBox(a: TestBox, b: TestBox): Promise<{ qr: string }> {
  const tv = await b.tv();
  const qr = String(tv.body.qr?.payload ?? '');
  const scan = await a.call('POST', '/api/link/scan', { pin: PIN, qr });
  if (scan.status !== 200) throw new Error(`scan ${scan.status} ${JSON.stringify(scan.body)}`);
  const ap = await a.call('POST', '/api/link/approve', { ok: true });
  if (ap.status !== 200) throw new Error(`approve ${ap.status} ${JSON.stringify(ap.body)}`);
  const ag = await a.call('POST', '/api/link/agree', { rev: 1 });
  if (ag.status !== 200) throw new Error(`agree ${ag.status} ${JSON.stringify(ag.body)}`);
  return { qr };
}
