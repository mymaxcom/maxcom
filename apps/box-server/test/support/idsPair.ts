import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';
import { runCloudLink } from '../../src/cli/cloudLink.ts';
import { issueLinkCode } from '../../src/sync/sites.ts';
import { loadSyncKey } from '../../src/sync/syncKey.ts';
import { buildCloud, CLOUD_URL } from './fakeCloud.ts';
import type { TestCloud } from './fakeCloud.ts';
import { FakeWorker } from './fakeWorker.ts';
import { ensureSurau } from './surauRow.ts';

export interface IdsPair {
  box: FastifyInstance;
  boxDir: string;
  cloud: TestCloud;
  /** Runs one full sync round of the box agent. */
  round: () => Promise<void>;
  close: () => Promise<void>;
}

/** A linked box and cloud in one process (surau `sdm`), the way the sync agent tests build them. */
export async function makeIdsPair(): Promise<IdsPair> {
  const boxDir = mkdtempSync(join(tmpdir(), 'surau-ids-'));
  let worker!: FakeWorker;
  const box = buildApp(join(boxDir, 'box.db'), {
    dataDir: boxDir,
    sync: { fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => worker.fetch(i, n)) as typeof fetch, sleep: async () => undefined },
  });
  const cloud = buildCloud(box.surau.boxId);
  worker = new FakeWorker(cloud.fetch);
  const { code } = issueLinkCode(
    { db: cloud.app.surau.db, now: () => new Date() },
    { boxId: box.surau.boxId, name: 'Surau Perintis Contoh', target: { surauId: ensureSurau(cloud.app.surau.db) } },
  );
  const lines: string[] = [];
  const exit = await runCloudLink(['--data', boxDir, '--db', join(boxDir, 'box.db'), 'link', CLOUD_URL, code], { out: (l) => lines.push(l), err: (l) => lines.push(l) }, worker.fetch);
  if (exit !== 0) throw new Error(`link failed: ${lines.join(' ')}`);
  worker.setSecret(box.surau.boxId, loadSyncKey(boxDir)!.wakeSecret);
  return {
    box,
    boxDir,
    cloud,
    round: () => box.syncAgent!.runOnce(),
    close: async () => {
      await box.close().catch(() => undefined);
      await cloud.close();
      rmSync(boxDir, { recursive: true, force: true });
    },
  };
}
