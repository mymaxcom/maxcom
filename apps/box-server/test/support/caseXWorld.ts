import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';

import { boxId as boxIdOf } from '../../src/auth/secrets.ts';
import { runAdopt, sweepAdoptLeftovers } from '../../src/link/adopt.ts';
import type { PeerTransport } from '../../src/link/session.ts';
import { runReduce } from '../../src/link/reduce.ts';
import { applyLinkJournalAtBoot } from '../../src/link/setAside.ts';
import { dropMoveOut } from '../../src/link/storeMove.ts';
import { loginAs, TEST_PIN } from '../authHelpers.ts';
import type { Login } from '../authHelpers.ts';

/** The per-start leave secret every test box is built with (O20). */
export const TEST_LEAVE_SECRET = 'c3'.repeat(32);

/**
 * Two (or more) real boxes in one process for the case X / N-X end-to-end tests: real data folders, real `buildApp`,
 * the box-to-box calls carried to the other app with `app.inject`, the master's file pulls carried the same way
 * through the `link.storeClient` seam, and a real "restart": both apps are closed, the start-up journal step of
 * `main.ts` runs on each folder, the apps are built again on the same folders.
 */

export const PIN = TEST_PIN;

export interface WireCall {
  from: string;
  to: string;
  path: string;
  body: Record<string, unknown>;
  status: number;
  json: unknown;
}
export interface FileCall {
  /** The master (the caller) and the path it asked the giver for. */
  from: string;
  path: string;
  status: number;
  /** The master's own progress at the time of the request. */
  progress: { step: string; percent: number | null } | null;
}

export interface XBox {
  n: number;
  app: FastifyInstance;
  origin: string;
  ca: string;
  addr: string;
  dir: string;
  boxId: string;
  restarts: number;
  admin: Login | null;
  tv: () => Promise<{ status: number; body: Record<string, any> }>;
  call: (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, o?: { headers?: Record<string, string>; from?: string; as?: Login | null }) => Promise<{ status: number; body: Record<string, any> }>;
}

export interface XWorld {
  clock: { now: () => Date; tick: (ms: number) => void };
  boxes: Map<string, XBox>;
  calls: WireCall[];
  files: FileCall[];
  /** Answers a box-to-box call itself (a refusal, a dead peer); undefined lets it through. */
  respond: ((c: Pick<WireCall, 'from' | 'to' | 'path' | 'body'>) => { status: number; json: unknown } | undefined) | null;
  make: (n: number, o?: { setUp?: boolean }) => Promise<XBox>;
  /** Closes every box, runs the start-up journal of each folder, builds each again on the same folder. */
  restartAll: () => Promise<void>;
  /** One box only (the other keeps running, with what it holds in memory). */
  restartOne: (b: XBox) => Promise<void>;
  close: () => Promise<void>;
}

const hex64 = (n: number): string => String(n % 10).repeat(64);
const neverSleep = (_ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });
const offline = (): Promise<never> => Promise.reject(new Error('offline'));

function safeJson(r: { json: () => unknown }): Record<string, any> {
  try {
    const j = r.json();
    return typeof j === 'object' && j !== null ? (j as Record<string, any>) : { value: j };
  } catch {
    return {};
  }
}

export function createXWorld(): XWorld {
  // the real time: the enrolment of a phone (a ticket) judges its expiry by the machine clock
  let time = new Date();
  const clock = {
    now: (): Date => time,
    tick: (ms: number): void => {
      time = new Date(time.getTime() + ms);
    },
  };
  const boxes = new Map<string, XBox>();
  const calls: WireCall[] = [];
  const files: FileCall[] = [];
  const dirs: string[] = [];

  const build = (n: number, dir: string, prev?: XBox): XBox => {
    const addr = `10.168.50.${10 + n}`;
    const origin = `https://${addr}:8443`;
    const ca = hex64(n);
    const box = (prev ?? { n, origin, ca, addr, dir, boxId: '', restarts: 0, admin: null }) as XBox;
    const peer: PeerTransport = {
      async post(to, toCa, path, body) {
        const target = boxes.get(to);
        const meta = { from: origin, to, path, body: structuredClone(body) as Record<string, unknown> };
        const forced = world.respond?.(meta);
        if (forced !== undefined) {
          calls.push({ ...meta, status: forced.status, json: forced.json });
          return forced;
        }
        if (target === undefined || target.ca !== toCa) throw new Error('unreachable');
        const r = await target.app.inject({ method: 'POST', url: path, payload: body as object, remoteAddress: addr });
        let json: unknown = null;
        try {
          json = r.json();
        } catch {
          json = null;
        }
        calls.push({ ...meta, status: r.statusCode, json });
        return { status: r.statusCode, json };
      },
    };
    // the master's pull of the giver's files: the giver's real route, answered as a readable with the headers
    const storeClient = {
      async request(to: string, toCa: string, req: { method?: string; path: string; headers?: Record<string, string> }): Promise<IncomingMessage> {
        const target = boxes.get(to);
        if (target === undefined || target.ca !== toCa) throw new Error('unreachable');
        const p = box.app.link?.work.progress() ?? null;
        const r = await target.app.inject({ method: (req.method ?? 'GET') as 'GET', url: req.path, headers: req.headers ?? {}, remoteAddress: addr });
        files.push({ from: origin, path: decodeURIComponent(new URL(req.path, 'http://x').searchParams.get('path') ?? ''), status: r.statusCode, progress: p === null ? null : { step: p.step, percent: p.percent } });
        const buf = r.rawPayload;
        return Object.assign(Readable.from(buf.length > 0 ? [buf] : []), { statusCode: r.statusCode, headers: r.headers, complete: true }) as unknown as IncomingMessage;
      },
    };
    // a follower's pull of its reduced copy (D3): the master's real routes, JSON and file answers
    const copyClient = {
      async json(to: string, toCa: string, req: { method?: string; path: string; body?: string | Uint8Array }): Promise<{ status: number; json: unknown }> {
        const target = boxes.get(to);
        if (target === undefined || target.ca !== toCa) throw new Error('unreachable');
        const r = await target.app.inject({ method: (req.method ?? 'GET') as 'POST', url: req.path, remoteAddress: addr, ...(req.body !== undefined ? { payload: JSON.parse(String(req.body)) as object } : {}) });
        let json: unknown = null;
        try {
          json = r.json();
        } catch {
          json = null;
        }
        return { status: r.statusCode, json };
      },
      request: storeClient.request,
    };
    box.dir = dir;
    box.boxId = boxIdOf(dir);
    box.app = buildApp(join(dir, 'surau.db'), {
      now: clock.now,
      leaveSecret: TEST_LEAVE_SECRET,
      dataDir: dir,
      link: {
        peer, origin, caSha256: ca, restart: () => { box.restarts += 1; },
        storeClient, storeSleep: () => Promise.resolve(), copyClient,
        // a follower must not reach for a real master
        mirrorClient: { request: offline, json: offline },
        mirror: { sleep: neverSleep, refreshMs: 3_600_000, retryMs: 3_600_000, idleMs: 3_600_000 },
      },
    });
    box.tv = async () => {
      const r = await box.app.inject({ method: 'GET', url: '/api/kiosk/link', remoteAddress: '127.0.0.1' });
      return { status: r.statusCode, body: safeJson(r) };
    };
    box.call = async (method, url, payload, x = {}) => {
      const who = x.as === undefined ? box.admin : x.as;
      const r = await box.app.inject({
        method, url, remoteAddress: x.from ?? addr,
        headers: { ...(who !== null ? who.headers : {}), ...(x.headers ?? {}) },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
      return { status: r.statusCode, body: safeJson(r) };
    };
    boxes.set(origin, box);
    return box;
  };

  const world: XWorld = {
    clock, boxes, calls, files, respond: null,
    async make(n, o = {}) {
      const dir = mkdtempSync(join(tmpdir(), `maxcom-casex-${n}-`));
      dirs.push(dir);
      const box = build(n, dir);
      if (o.setUp !== false) {
        box.admin = await loginAs(box.app, 'admin');
        const r = await box.app.inject({ method: 'PUT', url: '/api/settings/appLock', headers: box.admin.headers, payload: { enabled: true } });
        if (r.statusCode !== 200) throw new Error(`app lock: ${r.statusCode} ${r.body}`);
      }
      return box;
    },
    async restartOne(one) {
      await one.app.close();
      applyLinkJournalAtBoot(one.dir, {
        adopt: (d, j, h) => runAdopt(d, j, h, { boxId: () => boxIdOf(one.dir), now: clock.now }),
        reduce: (d, j, h) => runReduce(d, j, h, { boxId: () => boxIdOf(one.dir), now: clock.now }),
      });
      dropMoveOut(one.dir);
      sweepAdoptLeftovers(one.dir);
      build(one.n, one.dir, one);
    },
    async restartAll() {
      const all = [...boxes.values()];
      for (const b of all) await b.app.close();
      for (const b of all) {
        // what `main.ts` does before anything opens the database
        applyLinkJournalAtBoot(b.dir, {
          adopt: (d, j, h) => runAdopt(d, j, h, { boxId: () => boxIdOf(b.dir), now: clock.now }),
          reduce: (d, j, h) => runReduce(d, j, h, { boxId: () => boxIdOf(b.dir), now: clock.now }),
        });
        dropMoveOut(b.dir);
        sweepAdoptLeftovers(b.dir);
      }
      for (const b of all) build(b.n, b.dir, b);
    },
    async close() {
      for (const b of boxes.values()) await b.app.close().catch(() => undefined);
      boxes.clear();
      for (const d of dirs.splice(0)) {
        try {
          rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } catch {
          // a folder that is still held is left to the system
        }
      }
    },
  };
  return world;
}

/** Polls until `fn` stops throwing. */
export async function until(fn: () => void | Promise<void>, ms = 8000): Promise<void> {
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

/** The phone signs in again at a box that was restarted: a fresh challenge, signed with the phone's own key. */
export async function unlockAgain(box: XBox, login: Login): Promise<Login> {
  const ch = await box.app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress: box.addr, payload: { deviceId: login.deviceId } });
  if (ch.statusCode !== 200) throw new Error(`challenge ${ch.statusCode} ${ch.body}`);
  const nonce = String(ch.json().nonce);
  const sig = await login.sign(new TextEncoder().encode(`surau-unlock\n${box.boxId}\n${login.deviceId}\n${nonce}`));
  const un = await box.app.inject({ method: 'POST', url: '/api/auth/unlock', remoteAddress: box.addr, payload: { deviceId: login.deviceId, nonce, signature: sig, pin: PIN } });
  if (un.statusCode !== 200) throw new Error(`unlock ${un.statusCode} ${un.body}`);
  const token = String(un.json().token);
  return { ...login, token, headers: { authorization: `Bearer ${token}` } };
}

export const outcomeOf = (box: XBox): string | null => {
  const r = box.app.surau.db.prepare("SELECT outcome FROM link_sessions WHERE kind = 'link' AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1").get();
  return r === undefined ? null : (r.outcome as string | null);
};
