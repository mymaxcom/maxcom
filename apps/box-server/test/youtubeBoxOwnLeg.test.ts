import { afterEach, describe, expect, it, vi } from 'vitest';
import { putFeature } from '../src/settingsStore.ts';
import { generateSyncKeyPair, saveSyncKey } from '../src/sync/syncKey.ts';
import { loginAs } from './authHelpers.ts';
import { buildCloud, CLOUD_URL } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { startFakeGoogle } from './support/fakeGoogle.ts';
import type { FakeGoogle } from './support/fakeGoogle.ts';
import { withUploadApi } from './support/fakeGoogleUpload.ts';
import { startBody, startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';
import { insertSite } from './support/sites.ts';

/**
 * Release 2026.11.13, kept after phase 4 (2026.11.15, the cloud's YouTube leg is gone): a box's live uses only the
 * box's own YouTube service. It never asks the cloud for a broadcast, whatever the link to the cloud is.
 */

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0)) await c();
});

interface Rig {
  h: LiveHarness;
  cloud: TestCloud;
  g: FakeGoogle;
  /** Every path the box asked of the cloud. */
  asked: string[];
}

/** A box (live harness) linked to an in-process cloud; neither holds a YouTube sign-in. */
async function rig(o: { linked?: boolean } = {}): Promise<Rig> {
  const g = await startFakeGoogle();
  const up = withUploadApi(g);
  const cloud = buildCloud('boxid0001', { fetchImpl: up.fetchImpl });
  const asked: string[] = [];
  const viaCloud = ((i: Parameters<typeof fetch>[0], n?: RequestInit) => {
    asked.push(new URL(typeof i === 'string' ? i : i instanceof URL ? i.href : i.url).pathname);
    return cloud.fetch(i, n);
  }) as typeof fetch;
  const h = await startLiveHarness({ app: { cloud: { url: CLOUD_URL }, sync: { auto: false, fetchImpl: viaCloud } } });
  closers.push(h.close, cloud.close, g.close);
  if (o.linked !== false) {
    const site = insertSite(cloud.app.surau.db, { boxId: h.app.surau.boxId });
    const keys = generateSyncKeyPair();
    saveSyncKey(h.dataDir, { ...keys, cloudUrl: CLOUD_URL, siteToken: site.token, wakeSecret: 'wake-secret-1', linkedAt: '2026-11-05T00:00:00.000Z' });
  }
  putFeature(h.app.surau.db, 'liveYoutube', { enabled: true, privacy: 'unlisted' }, 'test', undefined, 'sdm');
  return { h, cloud, g, asked };
}

const start = (r: Rig, headers: Record<string, string>) =>
  r.h.app.inject({ method: 'POST', url: '/api/live/start', headers, payload: startBody(r.h, { outputs: { kiosk: true, youtube: true } }), remoteAddress: '10.168.1.40' });

describe('the box never uses a cloud leg for a live', () => {
  it('a linked box with no YouTube sign-in: the live skips YouTube plainly and asks the cloud for no broadcast', async () => {
    const r = await rig();
    const liveUser = await loginAs(r.h.app, 'live');
    const res = await start(r, liveUser.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings).toEqual(['youtube_not_signed_in']);
    expect(r.asked.filter((p) => p.startsWith('/api/cloud/youtube'))).toEqual([]);
    expect(r.cloud.app.surau.db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'youtube/broadcast'").get()!.n).toBe(0);
    expect(r.g.calls.some((c) => c.path === '/youtube/v3/liveBroadcasts')).toBe(false);
    expect(r.h.app.liveSessions!.status().warnings).not.toContain('cloud_unreachable');
  });

  it('cloudSync switched off, or a box never linked: the same, and the cloud is not asked', async () => {
    const off = await rig();
    putFeature(off.h.app.surau.db, 'cloudSync', { enabled: false }, 'test', undefined, 'sdm');
    const m1 = await loginAs(off.h.app, 'live');
    expect((await start(off, m1.headers)).json().warnings).toEqual(['youtube_not_signed_in']);
    expect(off.asked.filter((p) => p.startsWith('/api/cloud/youtube'))).toEqual([]);

    const unlinked = await rig({ linked: false });
    const m2 = await loginAs(unlinked.h.app, 'live');
    expect((await start(unlinked, m2.headers)).json().warnings).toEqual(['youtube_not_signed_in']);
    expect(unlinked.asked).toEqual([]);
  });
});
