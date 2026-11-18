/*
 * Cloud asset holding (fix of 28592fd): on the cloud an asset is usable by a surau only when `surau_assets` has a row
 * for it. Two linked boxes (surau A and B) that carry the same picture must both end up holding it through the REAL
 * agent flow (HEAD, then `PUT /api/sync/assets/:id` when the cloud does not hold it FOR THAT SURAU).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { putAsset } from '../src/assets/store.ts';
import { putItem } from '../src/content/store.ts';
import { runCloudLink } from '../src/cli/cloudLink.ts';
import { storageUsedBytes } from '../src/surau/storage.ts';
import { issueLinkCode } from '../src/sync/sites.ts';
import { loadSyncKey } from '../src/sync/syncKey.ts';
import { loginAs, TEST_PIN } from './authHelpers.ts';
import { buildCloud, CLOUD_URL } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FakeWorker } from './support/fakeWorker.ts';
import { ensureSurau } from './support/surauRow.ts';

const A = 'surau-a';
const B = 'surau-b';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PNG_ID = createHash('sha256').update(PNG).digest('hex');


const apps: FastifyInstance[] = [];
const dirs: string[] = [];
const clouds: TestCloud[] = [];
afterEach(async () => {
  for (const c of clouds.splice(0)) await c.close();
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface LinkedBox { box: FastifyInstance; boxDir: string; boxId: string }

/** A real box linked to the cloud as the site of `surauId`, its agent talking to the cloud app through the worker. */
async function linkBox(cloud: TestCloud, worker: FakeWorker, surauId: string, name: string): Promise<LinkedBox> {
  const boxDir = mkdtempSync(join(tmpdir(), 'surau-holdbox-'));
  dirs.push(boxDir);
  const box = buildApp(join(boxDir, 'box.db'), {
    dataDir: boxDir,
    sync: { fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => worker.fetch(i, n)) as typeof fetch, sleep: async () => undefined },
  });
  apps.push(box);
  const boxId = box.surau.boxId;
  const { code } = issueLinkCode({ db: cloud.app.surau.db, now: () => new Date() }, { boxId, name, target: { surauId } });
  const lines: string[] = [];
  const exit = await runCloudLink(['--data', boxDir, '--db', join(boxDir, 'box.db'), 'link', CLOUD_URL, code], { out: (l) => lines.push(l), err: (l) => lines.push(l) }, worker.fetch);
  expect(exit, lines.join('\n')).toBe(0);
  worker.setSecret(boxId, loadSyncKey(boxDir)!.wakeSecret);
  return { box, boxDir, boxId };
}

const held = (cloud: TestCloud, assetId: string): string[] =>
  cloud.app.surau.db.prepare('SELECT surau_id FROM surau_assets WHERE asset_id = ? ORDER BY surau_id').all(assetId).map((r) => String(r.surau_id));

async function twoBoxes(): Promise<{ cloud: TestCloud; a: LinkedBox; b: LinkedBox }> {
  const cloud = buildCloud('c0c0c0c0c0c0c0c0');
  clouds.push(cloud);
  ensureSurau(cloud.app.surau.db, A, 'Surau A');
  ensureSurau(cloud.app.surau.db, B, 'Surau B');
  const worker = new FakeWorker(cloud.fetch);
  const a = await linkBox(cloud, worker, A, 'Surau A');
  const b = await linkBox(cloud, worker, B, 'Surau B');
  return { cloud, a, b };
}

/** A box keeps a speaker photo; its local surau is `sdm`, the cloud files it under the site's surau. */
function boxHoldsPhoto(l: LinkedBox, itemId: string): void {
  const id = putAsset(l.box.surau.db, l.boxDir, PNG, 'image/png', 'local').id;
  expect(id).toBe(PNG_ID);
  putItem(l.box.surau.db, 'penceramah', { id: itemId, name: `Ustaz ${itemId}`, photoAssetId: id }, 'local', undefined, 'sdm');
}

describe('two linked boxes carry the same picture through the real agent flow', () => {
  it('both surau end up holding it, both can edit their item on the cloud, B is charged, reads by id still work', async () => {
    const { cloud, a, b } = await twoBoxes();
    boxHoldsPhoto(a, 'pa');
    boxHoldsPhoto(b, 'pb');
    await a.box.syncAgent!.runOnce();
    expect(held(cloud, PNG_ID)).toEqual([A]);
    // B's box asks the cloud for the same hash: the bytes exist (A's), but B does not hold them, so B must upload
    await b.box.syncAgent!.runOnce();
    expect(held(cloud, PNG_ID)).toEqual([A, B]);
    expect(storageUsedBytes(cloud.app.surau.db, B)).toBe(PNG.length);
    expect(storageUsedBytes(cloud.app.surau.db, A)).toBe(PNG.length);

    // each surau's admin can still edit its own item on the cloud (checkReferences needs the hold)
    for (const [surau, itemId] of [[A, 'pa'], [B, 'pb']] as const) {
      const admin = await loginAs(cloud.app, 'admin', TEST_PIN, surau);
      const put = await cloud.app.inject({ method: 'PUT', url: `/api/content/penceramah/${itemId}`, headers: admin.headers, payload: { name: 'Ustaz disunting', photoAssetId: PNG_ID } });
      expect(put.statusCode, put.body).toBeLessThan(300);
      // a device read by id keeps working (the picture URL the kiosk loads), held or not
      const read = await cloud.app.inject({ method: 'GET', url: `/assets/${PNG_ID}`, headers: admin.headers });
      expect(read.statusCode).toBe(200);
      expect(read.rawPayload.length).toBe(PNG.length);
    }
  });

  it('HEAD by a site answers 404 until its surau holds the bytes; a user session is unchanged', async () => {
    const { cloud, a, b } = await twoBoxes();
    boxHoldsPhoto(a, 'pa');
    await a.box.syncAgent!.runOnce();
    // the box's own authenticated call, as the agent makes it
    const headAs = async (l: LinkedBox): Promise<number> => {
      const key = loadSyncKey(l.boxDir)!;
      const res = await (l.box.syncAgent as unknown as { call: (k: unknown, p: string, i: () => RequestInit) => Promise<Response> }).call(key, `/assets/${PNG_ID}`, () => ({ method: 'HEAD' }));
      return res.status;
    };
    expect(await headAs(a)).toBe(200);
    expect(await headAs(b)).toBe(404);
    const admin = await loginAs(cloud.app, 'admin', TEST_PIN, B);
    expect((await cloud.app.inject({ method: 'HEAD', url: `/assets/${PNG_ID}`, headers: admin.headers })).statusCode).toBe(200);
  });

  it('the 409 says "this surau does not hold" when the bytes exist, "does not exist" when they do not', async () => {
    const { cloud, a } = await twoBoxes();
    boxHoldsPhoto(a, 'pa');
    await a.box.syncAgent!.runOnce();
    const adminB = await loginAs(cloud.app, 'admin', TEST_PIN, B);
    const notHeld = await cloud.app.inject({ method: 'PUT', url: '/api/content/penceramah/pz', headers: adminB.headers, payload: { name: 'Z', photoAssetId: PNG_ID } });
    expect(notHeld.statusCode).toBe(409);
    expect(notHeld.body).toContain('refers to an asset this surau does not hold');
    const unknown = await cloud.app.inject({ method: 'PUT', url: '/api/content/penceramah/pz', headers: adminB.headers, payload: { name: 'Z', photoAssetId: 'f'.repeat(64) } });
    expect(unknown.statusCode).toBe(409);
    expect(unknown.body).toContain('refers to an asset that does not exist');
  });
});
