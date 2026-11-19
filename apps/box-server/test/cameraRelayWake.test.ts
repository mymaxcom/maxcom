import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { runCloudLink } from '../src/cli/cloudLink.ts';
import { CameraStore } from '../src/live/camera.ts';
import { relayAad, sealToBox } from '../src/sync/cameraRelayCrypto.ts';
import { issueLinkCode } from '../src/sync/sites.ts';
import { loadSyncKey } from '../src/sync/syncKey.ts';
import { loginAs } from './authHelpers.ts';
import { buildCloud, CLOUD_URL } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FakeWorker } from './support/fakeWorker.ts';
import { ensureSurau } from './support/surauRow.ts';

/**
 * A camera change sent from 4G reaches the box even when the cloud has gone to sleep (2026-11-19): the cloud marks
 * the box at the Worker when it stores the change, the box's signed dirty check sees `camera: true`, runs a waking
 * cycle and fetches the change; the box's answer clears the mark.
 */

const PASSWORD = 'jauhDari4G';
const ADDRESS = 'rtsp://10.168.1.20:554/main';

interface Pair {
  box: FastifyInstance;
  boxDir: string;
  boxId: string;
  cloud: TestCloud;
  worker: FakeWorker;
  sleeps: number[];
}

const pairs: Pair[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const p of pairs.splice(0)) {
    p.box.syncAgent?.stop();
    await p.box.close().catch(() => undefined);
    await p.cloud.close();
    rmSync(p.boxDir, { recursive: true, force: true });
  }
});

async function makePair(): Promise<Pair> {
  const boxDir = mkdtempSync(join(tmpdir(), 'surau-camwake-'));
  const hook = { fetch: undefined as unknown as typeof fetch };
  const sleeps: number[] = [];
  const worker: { w: FakeWorker | null } = { w: null };
  const box = buildApp(join(boxDir, 'box.db'), {
    dataDir: boxDir,
    sync: {
      fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => hook.fetch(i, n)) as typeof fetch,
      // the cloud boots while the box waits after its wake
      sleep: async (ms) => {
        sleeps.push(ms);
        if (worker.w !== null) worker.w.vm = 'up';
      },
    },
  });
  const boxId = box.surau.boxId;
  const adminHook = { fetch: undefined as unknown as typeof fetch };
  const cloud = buildCloud(boxId, {
    workerAdmin: { url: 'https://worker.test', token: 'test-admin-token', fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => adminHook.fetch(i, n)) as typeof fetch },
    workerOutbox: { auto: false },
  });
  const w = new FakeWorker(cloud.fetch);
  worker.w = w;
  hook.fetch = w.fetch;
  adminHook.fetch = w.fetch;
  const { code } = issueLinkCode({ db: cloud.app.surau.db, now: () => new Date() }, { boxId, name: 'Surau Contoh', target: { surauId: ensureSurau(cloud.app.surau.db) } });
  const exit = await runCloudLink(['--data', boxDir, '--db', join(boxDir, 'box.db'), 'link', CLOUD_URL, code], { out: () => undefined, err: () => undefined }, w.fetch);
  expect(exit).toBe(0);
  w.setSecret(boxId, loadSyncKey(boxDir)!.wakeSecret);
  // the YouTube handover is settled here: an unsettled one asks the cloud to wake (F1), which these tests count on their own
  box.surau.db.prepare("INSERT INTO sync_state (key, value) VALUES ('youtube_handover', '{\"state\":\"done\"}')").run();
  const pair = { box, boxDir, boxId, cloud, worker: w, sleeps };
  pairs.push(pair);
  await cloud.app.workerOutbox!.drain();
  w.adminCalls.length = 0;
  return pair;
}

const outbox = (p: Pair, where = '1=1') => p.cloud.app.surau.db.prepare(`SELECT kind, key, body FROM worker_outbox WHERE ${where} ORDER BY id`).all();

/** The phone away from the surau: reads the number and the box key, seals, sends to the cloud. */
async function phoneSave(p: Pair, record: Record<string, unknown>) {
  const live = await loginAs(p.cloud.app, 'live');
  const view = (await p.cloud.app.inject({ method: 'GET', url: '/api/live/camera', headers: live.headers })).json() as { relay: { boxId: string; key: Record<string, string>; seq: number } };
  const { boxId, key, seq } = view.relay;
  const sealed = sealToBox(key, JSON.stringify({ seq, boxId, ...record }), relayAad(boxId, seq));
  return p.cloud.app.inject({ method: 'PUT', url: '/api/live/camera', headers: live.headers, payload: { boxId, seq, sealed } });
}

describe('a camera change from 4G wakes a sleeping cloud', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  it('the cloud marks the box at the Worker; the box sees camera: true, wakes the cloud, applies the change, and its answer clears the mark', async () => {
    const p = await makePair();
    const res = await phoneSave(p, { url: ADDRESS, username: 'viewer', password: PASSWORD });
    expect(res.statusCode).toBe(200);
    // queued in the same write as the change, naming the box only
    expect(outbox(p, "kind LIKE 'camera%'")).toEqual([{ kind: 'camera_put', key: `camera/${p.boxId}`, body: '{}' }]);
    await p.cloud.app.workerOutbox!.drain();
    expect(p.worker.camera.has(p.boxId)).toBe(true);
    expect(p.worker.adminCalls.filter((c) => c.path.startsWith('/_admin/camera/')).map((c) => `${c.method} ${c.path}`)).toEqual([`PUT /_admin/camera/${p.boxId}`]);
    // nothing about the camera reached the Worker
    expect(JSON.stringify(p.worker.adminCalls)).not.toContain(PASSWORD);

    // the cloud goes to sleep; nothing else is dirty for this box
    p.worker.dirty.delete(p.boxId);
    p.worker.vm = 'down';
    const agent = p.box.syncAgent!;
    agent.start();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(new CameraStore(p.boxDir).get()).toEqual({ url: ADDRESS, username: 'viewer', password: PASSWORD }));
    expect(p.worker.wakes).toBeGreaterThanOrEqual(1);
    // the box answered: the cloud shows it applied and queues the clear
    await vi.waitFor(() => expect(outbox(p, "kind LIKE 'camera%'")).toEqual([{ kind: 'camera_delete', key: `camera/${p.boxId}`, body: '{}' }]));
    const live = await loginAs(p.cloud.app, 'live');
    expect((await p.cloud.app.inject({ method: 'GET', url: '/api/live/camera', headers: live.headers })).json()).toMatchObject({ pending: false, failure: null, configured: true });
    await p.cloud.app.workerOutbox!.drain();
    expect(p.worker.camera.has(p.boxId)).toBe(false);
    agent.stop();
  });

  it('S9: a mark that never clears forces at most 3 waking cycles an hour; the flag is dropped after one cycle', async () => {
    const p = await makePair();
    p.worker.dirty.delete(p.boxId);
    p.worker.camera.add(p.boxId); // a stale mark: nothing waits for this box and the clear never lands
    const agent = p.box.syncAgent!;
    const guarded = vi.spyOn(agent as unknown as { guarded: () => Promise<void> }, 'guarded');
    agent.start();
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    expect(p.worker.dirtyChecks).toBeGreaterThan(10);
    expect(guarded).toHaveBeenCalledTimes(3);
    agent.stop();
  });

  it('without the mark a clean dirty check does not cycle (the sleeping cloud is left asleep)', async () => {
    const p = await makePair();
    p.worker.dirty.delete(p.boxId);
    p.worker.vm = 'down';
    const agent = p.box.syncAgent!;
    agent.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(p.worker.dirtyChecks).toBe(1);
    expect(p.worker.wakes).toBe(0);
    agent.stop();
  });

  it('a mark with nothing waiting for the box is cleared when the box asks; a box that never had a mark costs no Worker call', async () => {
    const p = await makePair();
    const site = p.cloud.app.surau.db.prepare('SELECT box_id FROM sites WHERE box_id = ?').get(p.boxId);
    expect(site).toBeDefined();
    const key = loadSyncKey(p.boxDir)!;
    const ask = () => p.cloud.app.inject({ method: 'GET', url: '/api/sync/camera-relay', headers: { authorization: `Bearer ${key.siteToken}` } });
    expect((await ask()).statusCode).toBe(404);
    expect(outbox(p, "kind LIKE 'camera%'")).toEqual([]);
    // a phone change, then the change is taken away by a newer clear the box applies, then the mark is stale
    expect((await phoneSave(p, { url: ADDRESS })).statusCode).toBe(200);
    await p.cloud.app.workerOutbox!.drain();
    expect(p.worker.camera.has(p.boxId)).toBe(true);
    p.cloud.app.surau.db.prepare("UPDATE camera_relay SET state = 'applied'").run();
    expect((await ask()).statusCode).toBe(404);
    expect(outbox(p, "kind LIKE 'camera%'")).toEqual([{ kind: 'camera_delete', key: `camera/${p.boxId}`, body: '{}' }]);
    await p.cloud.app.workerOutbox!.drain();
    expect(p.worker.camera.has(p.boxId)).toBe(false);
    // asked again: nothing more is queued
    expect((await ask()).statusCode).toBe(404);
    expect(outbox(p, "kind LIKE 'camera%'")).toEqual([]);
  });
});
