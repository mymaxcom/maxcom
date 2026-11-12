import { afterEach, describe, expect, it } from 'vitest';
import { RemoteYoutubeLeg } from '../src/sync/youtubeRemote.ts';
import { putFeature } from '../src/settingsStore.ts';
import { generateSyncKeyPair, saveSyncKey } from '../src/sync/syncKey.ts';
import { startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';

/** Plan 6 follow-ups 4 and 5: waking an asleep cloud for the broadcast, and a `complete` that survives a restart. */

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

const META = { title: 't', description: '', privacy: 'unlisted' as const };
const SECRET_KEY = 'xxxx-yyyy-zzzz-SECRETKEY';
const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const asleep = (): Response => new Response(JSON.stringify({ state: 'waking' }), { status: 503, headers: { 'retry-after': '5' } });

async function box(): Promise<LiveHarness> {
  const h = await startLiveHarness({});
  closers.push(h.close);
  const keys = generateSyncKeyPair();
  saveSyncKey(h.dataDir, { ...keys, cloudUrl: 'https://cloud.test', siteToken: 'tok-1', wakeSecret: 'wake-secret-1', linkedAt: '2026-11-05T00:00:00.000Z' });
  putFeature(h.app.surau.db, 'cloudSync', { enabled: true }, 'test');
  return h;
}

const pendingRows = (h: LiveHarness) => h.app.surau.db.prepare('SELECT * FROM youtube_pending_complete').all();

describe('follow-up 4: the broadcast call wakes an asleep cloud and retries', () => {
  it('503 then awake: wakes through the agent helper, retries, and gets the broadcast', async () => {
    const h = await box();
    let awake = false;
    let wakes = 0;
    let calls = 0;
    const leg = new RemoteYoutubeLeg({
      db: h.app.surau.db,
      dataDir: h.dataDir,
      now: () => new Date(),
      fetchImpl: (async () => {
        calls++;
        return awake ? ok({ broadcastId: 'bc-9', watchUrl: 'https://youtu.be/bc-9', key: SECRET_KEY }) : asleep();
      }) as typeof fetch,
      wake: async () => {
        wakes++;
        awake = true;
      },
      waitBudgetMs: 5000,
      waitBackoffMs: [5, 5, 5, 5],
    });
    const made = await leg.createBroadcastFor({ sessionId: 's1', meta: META });
    expect(made).toEqual({ broadcastId: 'bc-9', watchUrl: 'https://youtu.be/bc-9', key: SECRET_KEY });
    expect(wakes).toBeGreaterThanOrEqual(1);
    expect(calls).toBeGreaterThanOrEqual(2);
    leg.stop();
  });

  it('unreachable (network error) is woken and retried the same way', async () => {
    const h = await box();
    let tries = 0;
    const leg = new RemoteYoutubeLeg({
      db: h.app.surau.db,
      dataDir: h.dataDir,
      now: () => new Date(),
      fetchImpl: (async () => {
        if (++tries < 3) throw new TypeError('fetch failed');
        return ok({ broadcastId: 'bc-8', watchUrl: 'https://youtu.be/bc-8', key: SECRET_KEY });
      }) as typeof fetch,
      wake: async () => undefined,
      waitBudgetMs: 5000,
      waitBackoffMs: [5, 5, 5],
    });
    await expect(leg.createBroadcastFor({ sessionId: 's1', meta: META })).resolves.toMatchObject({ broadcastId: 'bc-8' });
    leg.stop();
  });

  it('never wakes: gives up with cloud_unreachable after the budget, not before, not far after', async () => {
    const h = await box();
    let wakes = 0;
    const leg = new RemoteYoutubeLeg({
      db: h.app.surau.db,
      dataDir: h.dataDir,
      now: () => new Date(),
      fetchImpl: (async () => asleep()) as typeof fetch,
      wake: async () => {
        wakes++;
      },
      waitBudgetMs: 300,
      waitBackoffMs: [20, 40, 60],
    });
    const t0 = Date.now();
    await expect(leg.createBroadcastFor({ sessionId: 's1', meta: META })).rejects.toMatchObject({ reason: 'cloud_unreachable' });
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(1500);
    expect(wakes).toBeGreaterThanOrEqual(1);
    leg.stop();
  });

  it('the wait budget may be a function, read at each broadcast: a system value changed later applies to the next one', async () => {
    const h = await box();
    let budget = 300;
    const leg = new RemoteYoutubeLeg({
      db: h.app.surau.db,
      dataDir: h.dataDir,
      now: () => new Date(),
      fetchImpl: (async () => asleep()) as typeof fetch,
      wake: async () => undefined,
      waitBudgetMs: () => budget,
      waitBackoffMs: [20, 40, 60],
    });
    const time = async (): Promise<number> => {
      const t0 = Date.now();
      await expect(leg.createBroadcastFor({ sessionId: 's1', meta: META })).rejects.toMatchObject({ reason: 'cloud_unreachable' });
      return Date.now() - t0;
    };
    const first = await time();
    expect(first).toBeGreaterThanOrEqual(250);
    expect(first).toBeLessThan(900);
    budget = 800;
    const second = await time();
    expect(second).toBeGreaterThanOrEqual(750);
    expect(second).toBeLessThan(2500);
    leg.stop();
  });

  it('a refused site key (401) is not woken or retried', async () => {
    const h = await box();
    let calls = 0;
    let wakes = 0;
    const leg = new RemoteYoutubeLeg({
      db: h.app.surau.db,
      dataDir: h.dataDir,
      now: () => new Date(),
      fetchImpl: (async () => {
        calls++;
        return new Response('{}', { status: 401 });
      }) as typeof fetch,
      wake: async () => {
        wakes++;
      },
      waitBudgetMs: 2000,
      waitBackoffMs: [5],
    });
    await expect(leg.createBroadcastFor({ sessionId: 's1', meta: META })).rejects.toMatchObject({ reason: 'cloud_unreachable' });
    expect(calls).toBe(1);
    expect(wakes).toBe(0);
    leg.stop();
  });

  it('quota stays quota (a coded answer is not retried)', async () => {
    const h = await box();
    let calls = 0;
    const leg = new RemoteYoutubeLeg({
      db: h.app.surau.db,
      dataDir: h.dataDir,
      now: () => new Date(),
      fetchImpl: (async () => {
        calls++;
        return new Response(JSON.stringify({ code: 'youtube_quota' }), { status: 429 });
      }) as typeof fetch,
      wake: async () => undefined,
      waitBudgetMs: 2000,
      waitBackoffMs: [5],
    });
    await expect(leg.createBroadcastFor({ sessionId: 's1', meta: META })).rejects.toMatchObject({ reason: 'quota' });
    expect(calls).toBe(1);
    leg.stop();
  });
});

describe('follow-up 5: a complete that failed at stop survives a restart', () => {
  it('is stored (id and attempts only), and a new leg on the same database finishes it', async () => {
    const h = await box();
    const db = h.app.surau.db;
    const down = new RemoteYoutubeLeg({
      db,
      dataDir: h.dataDir,
      now: () => new Date(),
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
      retryMs: [],
    });
    await expect(down.complete('bc-77')).rejects.toMatchObject({ reason: 'cloud_unreachable' });
    down.stop();
    const rows = pendingRows(h);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(['attempts', 'broadcast_id', 'created_at']);
    expect(rows[0]).toMatchObject({ broadcast_id: 'bc-77' });
    expect(JSON.stringify(rows)).not.toContain('tok-1');

    // "restart": a new leg, the cloud is back; the boot retry finishes it
    const bodies: string[] = [];
    const up = new RemoteYoutubeLeg({
      db,
      dataDir: h.dataDir,
      now: () => new Date(),
      fetchImpl: (async (u: unknown, init?: RequestInit) => {
        if (!String(u).endsWith('/complete')) return ok({});
        bodies.push(String(init?.body ?? ''));
        return ok({});
      }) as typeof fetch,
      retryMs: [],
      bootRetryMs: 10,
    });
    const end = Date.now() + 3000;
    while (pendingRows(h).length > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    expect(pendingRows(h)).toHaveLength(0);
    expect(bodies).toEqual([JSON.stringify({ broadcastId: 'bc-77' })]);
    up.stop();
  });

  it('retryPending (the agent cycle) keeps a row while the cloud is down and counts the try', async () => {
    const h = await box();
    const db = h.app.surau.db;
    db.prepare("INSERT INTO youtube_pending_complete (broadcast_id, attempts, created_at) VALUES ('bc-1', 0, '2026-11-05T00:00:00.000Z')").run();
    const leg = new RemoteYoutubeLeg({
      db,
      dataDir: h.dataDir,
      now: () => new Date(),
      fetchImpl: (async () => asleep()) as typeof fetch,
      retryMs: [],
    });
    await leg.retryPending();
    expect(pendingRows(h)).toMatchObject([{ broadcast_id: 'bc-1', attempts: 1 }]);
    leg.stop();
  });

  it('a final 4xx drops the row and is not tried again', async () => {
    const h = await box();
    const db = h.app.surau.db;
    db.prepare("INSERT INTO youtube_pending_complete (broadcast_id, attempts, created_at) VALUES ('bc-2', 0, '2026-11-05T00:00:00.000Z')").run();
    let calls = 0;
    const leg = new RemoteYoutubeLeg({
      db,
      dataDir: h.dataDir,
      now: () => new Date(),
      fetchImpl: (async () => {
        calls++;
        return new Response(JSON.stringify({ errors: ['no such broadcast'] }), { status: 404 });
      }) as typeof fetch,
      retryMs: [],
    });
    await leg.retryPending();
    await leg.retryPending();
    expect(pendingRows(h)).toHaveLength(0);
    expect(calls).toBe(1);
    leg.stop();
  });

  it('a success at stop leaves no row, and retryPending then asks nothing', async () => {
    const h = await box();
    let calls = 0;
    const leg = new RemoteYoutubeLeg({
      db: h.app.surau.db,
      dataDir: h.dataDir,
      now: () => new Date(),
      fetchImpl: (async (u: unknown) => {
        if (String(u).endsWith('/complete')) calls++;
        return ok({});
      }) as typeof fetch,
      retryMs: [],
    });
    await leg.complete('bc-3');
    expect(pendingRows(h)).toHaveLength(0);
    await leg.retryPending();
    expect(calls).toBe(1);
    leg.stop();
  });

  it('gate 2: cloudSync switched off after a live does not strand a stored complete (the box is still linked)', async () => {
    const h = await box();
    const db = h.app.surau.db;
    putFeature(db, 'cloudSync', { enabled: false }, 'test');
    db.prepare("INSERT INTO youtube_pending_complete (broadcast_id, attempts, created_at) VALUES ('bc-9', 0, '2026-11-05T00:00:00.000Z')").run();
    const asked: string[] = [];
    const leg = new RemoteYoutubeLeg({
      db,
      dataDir: h.dataDir,
      now: () => new Date(),
      fetchImpl: (async (u: unknown, init?: RequestInit) => {
        asked.push(`${String(u)} ${String(init?.body ?? '')}`);
        return ok({});
      }) as typeof fetch,
      retryMs: [],
    });
    expect(leg.active()).toBe(false);
    await leg.retryPending();
    expect(asked.filter((x) => x.includes('/complete'))).toEqual(['https://cloud.test/api/cloud/youtube/complete {"broadcastId":"bc-9"}']);
    expect(pendingRows(h)).toHaveLength(0);
    leg.stop();
  });

  it('the sync agent exposes the wake helper and a cycle hook', async () => {
    const h = await box();
    const agent = h.app.syncAgent!;
    agent.setCycleHook(() => undefined);
    expect(await agent.wakeNow()).toBe(true);
  });
});
