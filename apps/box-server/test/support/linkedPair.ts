import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';
import type { AppOptions } from '../../src/app.ts';
import { runCloudLink } from '../../src/cli/cloudLink.ts';
import { issueLinkCode } from '../../src/sync/sites.ts';
import { loadSyncKey } from '../../src/sync/syncKey.ts';
import { buildCloud, CLOUD_URL } from './fakeCloud.ts';
import type { TestCloud } from './fakeCloud.ts';
import { FakeWorker } from './fakeWorker.ts';
import { ensureSurau } from './surauRow.ts';

/**
 * A box linked to a real in-process cloud through the real link steps (`runCloudLink`), for the tests of the box side
 * of reset-from-box and of the follower's sleep. The cloud's surau is `sdm`, the box's own. `wire` is the `fetch` both
 * the box and the loops under test use: it counts every call and lets a test answer one itself.
 */

export interface WireCall {
  method: string;
  path: string;
  status: number;
}

export interface LinkedPair {
  boxDir: string;
  boxId: string;
  box: FastifyInstance;
  cloud: TestCloud;
  worker: FakeWorker;
  calls: WireCall[];
  /** Called for each request first; return a Response to answer it, or undefined to let it through. */
  intercept: { fn: ((method: string, path: string, n: number) => Response | undefined) | null };
  sleeps: number[];
  wire: typeof fetch;
  /** Closes the box app and builds it again on the same folder with `extra` options (a restart). */
  reopen: (extra?: AppOptions) => Promise<FastifyInstance>;
  close: () => Promise<void>;
}

const open: LinkedPair[] = [];

export async function closeAllPairs(): Promise<void> {
  for (const p of open.splice(0)) await p.close();
}

export async function makeLinkedPair(): Promise<LinkedPair> {
  const boxDir = mkdtempSync(join(tmpdir(), 'surau-resetbox-'));
  const sleeps: number[] = [];
  const calls: WireCall[] = [];
  const intercept: LinkedPair['intercept'] = { fn: null };
  const hook = { fetch: (undefined as unknown) as typeof fetch };
  const wire = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const n = calls.filter((c) => c.method === method && c.path === u.pathname).length + 1;
    const early = intercept.fn?.(method, u.pathname, n);
    const res = early ?? (await hook.fetch(input, init));
    calls.push({ method, path: u.pathname, status: res.status });
    return res;
  }) as typeof fetch;
  const box = buildApp(join(boxDir, 'box.db'), { dataDir: boxDir, sync: { fetchImpl: wire, sleep: (ms) => { sleeps.push(ms); return new Promise((r) => setTimeout(r, 1)); } } });
  const boxId = box.surau.boxId;
  const cloud = buildCloud(boxId);
  const worker = new FakeWorker(cloud.fetch);
  hook.fetch = worker.fetch;
  const { code } = issueLinkCode({ db: cloud.app.surau.db, now: () => new Date() }, { boxId, name: 'Surau Al-Hidayah', target: { surauId: ensureSurau(cloud.app.surau.db) } });
  const lines: string[] = [];
  const exit = await runCloudLink(['--data', boxDir, '--db', join(boxDir, 'box.db'), 'link', CLOUD_URL, code], { out: (l) => lines.push(l), err: (l) => lines.push(l) }, worker.fetch);
  if (exit !== 0) throw new Error(`link failed: ${lines.join(' | ')}`);
  worker.setSecret(boxId, loadSyncKey(boxDir)!.wakeSecret);
  // the YouTube handover is settled here: an unsettled one asks the cloud to wake, which these tests count on their own
  box.surau.db.prepare("INSERT INTO sync_state (key, value) VALUES ('youtube_handover', '{\"state\":\"done\"}')").run();
  const pair: LinkedPair = {
    boxDir, boxId, box, cloud, worker, calls, intercept, sleeps, wire,
    async reopen(extra = {}) {
      await pair.box.close().catch(() => undefined);
      pair.box = buildApp(join(boxDir, 'box.db'), {
        dataDir: boxDir,
        cloud: { url: CLOUD_URL },
        sync: { fetchImpl: wire, sleep: (ms) => { sleeps.push(ms); return new Promise((r) => setTimeout(r, 1)); }, initialDelayMs: 600_000 },
        ...extra,
      });
      return pair.box;
    },
    async close() {
      await pair.box.close().catch(() => undefined);
      await cloud.close();
      rmSync(boxDir, { recursive: true, force: true });
    },
  };
  open.push(pair);
  return pair;
}

/** Polls until `fn` stops throwing. */
export async function until(fn: () => void | Promise<void>, ms = 5000): Promise<void> {
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
