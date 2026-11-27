import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { runCloudLink } from '../src/cli/cloudLink.ts';
import { getSettings, putFeature } from '../src/settingsStore.ts';
import { readFeed } from '../src/sync/feed.ts';
import { issueLinkCode } from '../src/sync/sites.ts';
import { loadSyncKey } from '../src/sync/syncKey.ts';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';
import { loginAs } from './authHelpers.ts';
import { buildCloud, CLOUD_URL } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FakeWorker } from './support/fakeWorker.ts';
import { ensureSurau } from './support/surauRow.ts';

/**
 * Phase 1 leftover: the per-TV profiles (`tvProfiles.tvs`) travel through the sync feed like the other settings:
 * a box pushes, the cloud applies and answers them in its feed and its settings read, and two edits to two different
 * TVs from two boxes merge entry by entry.
 */
interface Box { app: FastifyInstance; dir: string }
interface World { cloud: TestCloud; worker: FakeWorker; a: Box; b: Box }
const worlds: World[] = [];

afterEach(async () => {
  for (const w of worlds.splice(0)) {
    for (const x of [w.a, w.b]) {
      await x.app.close().catch(() => undefined);
      rmSync(x.dir, { recursive: true, force: true });
    }
    await w.cloud.close();
  }
});

/** Two boxes of one surau, both linked to one in-process cloud through a fake Worker (the pattern of themeSync.test.ts). */
async function makeWorld(): Promise<World> {
  let worker!: FakeWorker;
  const mk = async (cloud: TestCloud | null, name: string): Promise<{ box: Box; cloud: TestCloud }> => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-tvcloud-'));
    const app = buildApp(join(dir, 'box.db'), {
      dataDir: dir,
      sync: { fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => worker.fetch(i, n)) as typeof fetch, sleep: async () => undefined },
    });
    const c = cloud ?? buildCloud(app.surau.boxId);
    if (cloud === null) worker = new FakeWorker(c.fetch);
    const { code } = issueLinkCode({ db: c.app.surau.db, now: () => new Date() }, { boxId: app.surau.boxId, name, target: { surauId: ensureSurau(c.app.surau.db, cloud === null ? 'sdm' : 'sdm-b') } });
    const lines: string[] = [];
    const exit = await runCloudLink(['--data', dir, '--db', join(dir, 'box.db'), 'link', CLOUD_URL, code], { out: (l) => lines.push(l), err: (l) => lines.push(l) }, worker.fetch);
    expect(exit, lines.join('\n')).toBe(0);
    worker.setSecret(app.surau.boxId, loadSyncKey(dir)!.wakeSecret);
    // one live box per surau for now: the second box links into its own surau and is then moved into the first one
    if (cloud !== null) c.app.surau.db.prepare("UPDATE sites SET surau_id = 'sdm' WHERE box_id = ?").run(app.surau.boxId);
    return { box: { app, dir }, cloud: c };
  };
  const first = await mk(null, 'Kotak A');
  const second = await mk(first.cloud, 'Kotak B');
  const w: World = { cloud: first.cloud, worker, a: first.box, b: second.box };
  worlds.push(w);
  return w;
}

const run = (b: Box): Promise<void> => b.app.syncAgent!.runOnce();
const tvsOf = (app: FastifyInstance): Record<string, unknown> => getSettings(app.surau.db, LOCAL_SURAU_ID).tvProfiles.tvs as Record<string, unknown>;
const put = (b: Box, tvs: Record<string, unknown>): void => {
  putFeature(b.app.surau.db, 'tvProfiles', { tvs }, 'test', undefined, LOCAL_SURAU_ID);
};

const DEWAN = { name: 'Dewan Utama', lang: 'ms', orientation: 'landscape' };
const MUSLIMAT = { name: 'Ruang Muslimat', lang: 'ar', hideKinds: ['video'] };

describe('tvProfiles through the cloud', () => {
  it('a box pushes a change; the cloud applies it and returns it in its settings read and in its own feed; the other box pulls it', async () => {
    const w = await makeWorld();
    put(w.a, { self: DEWAN });
    await run(w.a);

    expect(tvsOf(w.cloud.app)).toEqual({ self: DEWAN });
    // the cloud's feed (what the other box reads) carries a settings entry with the TV map
    const feed = readFeed(w.cloud.app.surau.db, 0, 500, { users: false, devices: false });
    const entry = feed.entries.filter((e) => e.entity === 'settings' && e.entityId === 'tvProfiles').pop();
    expect(entry, JSON.stringify(feed.entries.map((e) => [e.entity, e.entityId]))).toBeDefined();
    expect(JSON.stringify(entry!.after)).toContain('Dewan Utama');

    await run(w.b);
    expect(tvsOf(w.b.app)).toEqual({ self: DEWAN });
  });

  it('the cloud answers the profile on its own settings route too', async () => {
    const w = await makeWorld();
    put(w.a, { self: DEWAN });
    await run(w.a);
    const ops = await loginAs(w.cloud.app, 'superadmin');
    const r = await w.cloud.app.inject({ method: 'GET', url: '/api/settings', headers: ops.headers });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().tvProfiles.tvs.self).toEqual(DEWAN);
  });

  it('two edits to two different TVs from two sides merge per TV entry, on the cloud and on both boxes', async () => {
    const w = await makeWorld();
    put(w.a, { self: DEWAN });
    put(w.b, { tvDewan2: MUSLIMAT });
    await run(w.a);
    await run(w.b);
    await run(w.a);
    await run(w.b);
    for (const [label, app] of [['cloud', w.cloud.app], ['A', w.a.app], ['B', w.b.app]] as const) {
      expect(tvsOf(app), label).toEqual({ self: DEWAN, tvDewan2: MUSLIMAT });
    }
  });

  it('two edits to the same TV: the later edit stands everywhere, and the TV next to it is untouched', async () => {
    const w = await makeWorld();
    put(w.a, { self: DEWAN, tvDewan2: MUSLIMAT });
    await run(w.a);
    await run(w.b);
    expect(tvsOf(w.b.app)).toEqual({ self: DEWAN, tvDewan2: MUSLIMAT });
    put(w.a, { self: { ...DEWAN, name: 'Dewan Besar' } });
    await new Promise((r) => setTimeout(r, 20));
    put(w.b, { self: { ...DEWAN, name: 'Dewan Solat' } });
    await run(w.a);
    await run(w.b);
    await run(w.a);
    await run(w.b);
    const want = tvsOf(w.cloud.app);
    expect((want.self as { name: string }).name).toBe('Dewan Solat');
    expect(want.tvDewan2).toEqual(MUSLIMAT);
    expect(tvsOf(w.a.app)).toEqual(want);
    expect(tvsOf(w.b.app)).toEqual(want);
  });

  it('a removal of one TV (null) syncs and leaves the other', async () => {
    const w = await makeWorld();
    put(w.a, { self: DEWAN, tvDewan2: MUSLIMAT });
    await run(w.a);
    await run(w.b);
    put(w.b, { tvDewan2: null });
    await run(w.b);
    await run(w.a);
    for (const [label, app] of [['cloud', w.cloud.app], ['A', w.a.app], ['B', w.b.app]] as const) {
      const t = tvsOf(app);
      expect(t.self, label).toEqual(DEWAN);
      expect(t.tvDewan2 ?? null, label).toBeNull();
    }
  });
});
