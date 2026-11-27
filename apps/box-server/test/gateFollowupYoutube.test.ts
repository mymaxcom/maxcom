import { afterEach, describe, expect, it } from 'vitest';
import { putFeature } from '../src/settingsStore.ts';
import { generateSyncKeyPair, saveSyncKey } from '../src/sync/syncKey.ts';
import { startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';

/**
 * Plan 6 follow-up 4 (the sync agent's wake helper, which the camera and YouTube links still use). The YouTube
 * broadcast call that woke an asleep cloud and the stored `complete` of a cloud broadcast went with the cloud's
 * YouTube sign-in (2026.11.15, phase 4).
 */

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function box(): Promise<LiveHarness> {
  const h = await startLiveHarness({});
  closers.push(h.close);
  const keys = generateSyncKeyPair();
  saveSyncKey(h.dataDir, { ...keys, cloudUrl: 'https://cloud.test', siteToken: 'tok-1', wakeSecret: 'wake-secret-1', linkedAt: '2026-11-05T00:00:00.000Z' });
  putFeature(h.app.surau.db, 'cloudSync', { enabled: true }, 'test', undefined, 'sdm');
  return h;
}

describe('follow-up 4: the sync agent', () => {
  it('the sync agent exposes the wake helper and a cycle hook', async () => {
    const h = await box();
    const agent = h.app.syncAgent!;
    agent.setCycleHook(() => undefined);
    expect(await agent.wakeNow()).toBe(true);
  });
});
