import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { FeedEntry } from '@surau/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { logChange } from '../src/auth/users.ts';
import { getItem, putItem } from '../src/content/store.ts';
import { putFeature } from '../src/settingsStore.ts';
import { runCloudLink } from '../src/cli/cloudLink.ts';
import { applyFeedEntry } from '../src/sync/apply.ts';
import { issueLinkCode } from '../src/sync/sites.ts';
import { loadSyncKey } from '../src/sync/syncKey.ts';
import { loginAs } from './authHelpers.ts';
import { buildCloud, CLOUD_URL } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FakeWorker } from './support/fakeWorker.ts';

/** Gate fixes, box side of the sync agent (Plan 6 gate: Q3, Q6, Q7, S2). */

interface Pair {
  box: FastifyInstance;
  boxDir: string;
  boxId: string;
  cloud: TestCloud;
  worker: FakeWorker;
  hook: { fetch: typeof fetch };
}

const pairs: Pair[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const p of pairs.splice(0)) {
    await p.box.close().catch(() => undefined);
    await p.cloud.close();
    rmSync(p.boxDir, { recursive: true, force: true });
  }
});

async function makePair(limits?: { small?: number; page?: number; snapshot?: number }): Promise<Pair> {
  const boxDir = mkdtempSync(join(tmpdir(), 'surau-gfagent-'));
  const hook = { fetch: undefined as unknown as typeof fetch };
  const box = buildApp(join(boxDir, 'box.db'), {
    dataDir: boxDir,
    sync: {
      fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => hook.fetch(i, n)) as typeof fetch,
      sleep: async () => undefined,
      ...(limits ? { limits } : {}),
    },
  });
  const boxId = box.surau.boxId;
  const cloud = buildCloud(boxId);
  const worker = new FakeWorker(cloud.fetch);
  hook.fetch = worker.fetch;
  const pair: Pair = { box, boxDir, boxId, cloud, worker, hook };
  pairs.push(pair);
  const { code } = issueLinkCode({ db: cloud.app.surau.db, now: () => new Date() }, { boxId, name: 'Surau Ujian' });
  const exit = await runCloudLink(['--data', boxDir, '--db', join(boxDir, 'box.db'), 'link', CLOUD_URL, code], { out: () => undefined, err: () => undefined }, worker.fetch);
  expect(exit).toBe(0);
  worker.setSecret(boxId, loadSyncKey(boxDir)!.wakeSecret);
  return pair;
}

const agentOf = (p: Pair) => p.box.syncAgent!;
const state = (p: Pair, key: string): string | null => {
  const r = p.box.surau.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
  return typeof r?.value === 'string' ? r.value : null;
};
const urlOf = (i: Parameters<typeof fetch>[0]): string => (typeof i === 'string' ? i : i instanceof URL ? i.href : i.url);
const jsonRes = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const T1 = '2026-11-05T08:00:00.000Z';
const T2 = '2026-11-05T09:00:00.000Z';

const entry = (over: Partial<FeedEntry> & Pick<FeedEntry, 'entity' | 'entityId' | 'after'>): FeedEntry => ({
  seq: 1, rev: `${T2}|cloud`, editedAt: T2, syncedAt: T2, actor: 'user:x', deviceId: null, origin: 'local', opId: null, ...over,
});

describe('Q3: a refused push is recorded, not silent', () => {
  it('advances the cursor but counts refusals, keeps the reason code and sets lastError=refused', async () => {
    const p = await makePair();
    await agentOf(p).runOnce(); // push the link's own settings change
    const before = Number(state(p, 'last_push_seq'));
    logChange(p.box.surau.db, 'local', 'content:penceramah', 'bad1', undefined, { name: 5 }); // a row the cloud cannot accept
    await agentOf(p).runOnce();
    expect(Number(state(p, 'last_push_seq'))).toBeGreaterThan(before);
    const st = agentOf(p).status();
    expect(st.refused).toBe(1);
    expect(st.lastRefusal).toBe('invalid');
    expect(st.lastError).toBe('refused');
    expect(JSON.stringify(st)).not.toContain('"name":5');
    // the health report carries it
    const ajk = await loginAs(p.box, 'ajk');
    expect((await p.box.inject({ method: 'GET', url: '/api/health', headers: ajk.headers })).json().sync).toMatchObject({ refused: 1, lastRefusal: 'invalid', lastError: 'refused' });
    // a clean cycle afterwards clears lastError but keeps the running total
    await agentOf(p).runOnce();
    expect(agentOf(p).status()).toMatchObject({ lastError: null, refused: 1 });
  });

  it('a benign live_only refusal does not set lastError', async () => {
    const p = await makePair();
    putItem(p.box.surau.db, 'penceramah', { id: 'p1', name: 'A' }, 'local');
    const real = p.hook.fetch;
    p.hook.fetch = (async (i: Parameters<typeof fetch>[0], n?: RequestInit) => {
      if (urlOf(i).endsWith('/api/sync/ops')) return jsonRes(200, { applied: 0, duplicate: 0, superseded: 0, refused: 1, reasons: ['live_only'], seq: 1 });
      return real(i, n);
    }) as typeof fetch;
    await agentOf(p).runOnce();
    expect(agentOf(p).status()).toMatchObject({ lastError: null, refused: 0, lastRefusal: null });
  });

  it('a refusal count with no reasons (older cloud) is not benign', async () => {
    const p = await makePair();
    putItem(p.box.surau.db, 'penceramah', { id: 'p1', name: 'A' }, 'local');
    const real = p.hook.fetch;
    p.hook.fetch = (async (i: Parameters<typeof fetch>[0], n?: RequestInit) => {
      if (urlOf(i).endsWith('/api/sync/ops')) return jsonRes(200, { applied: 0, duplicate: 0, superseded: 0, refused: 2, seq: 1 });
      return real(i, n);
    }) as typeof fetch;
    await agentOf(p).runOnce();
    expect(agentOf(p).status()).toMatchObject({ lastError: 'refused', refused: 2, lastRefusal: 'unknown' });
  });

  it('never pushes the app lock setting', async () => {
    const p = await makePair();
    putFeature(p.box.surau.db, 'appLock', { enabled: true }, 'local');
    putItem(p.box.surau.db, 'penceramah', { id: 'p1', name: 'A' }, 'local');
    const sent: string[] = [];
    const real = p.hook.fetch;
    p.hook.fetch = (async (i: Parameters<typeof fetch>[0], n?: RequestInit) => {
      if (urlOf(i).endsWith('/api/sync/ops')) sent.push(String(n?.body));
      return real(i, n);
    }) as typeof fetch;
    await agentOf(p).runOnce();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.join('')).not.toContain('"entityId":"appLock"');
    expect(agentOf(p).status()).toMatchObject({ lastError: null, refused: 0 });
    expect(getItem(p.cloud.app.surau.db, 'penceramah', 'p1')).toMatchObject({ name: 'A' });
  });
});

describe('Q3: rows the cloud can never take are not sent', () => {
  it('a PIN set at enrolment travels as a full user record (2026.11.5); a device enrolment travels with its key (Plan 6 device keys travel), a revocation is sent', async () => {
    const p = await makePair();
    const login = await loginAs(p.box, 'ajk'); // writes users, devices and a pin-change row on the box
    const sent: { entity: string; entityId: string }[] = [];
    const real = p.hook.fetch;
    p.hook.fetch = (async (i: Parameters<typeof fetch>[0], n?: RequestInit) => {
      if (urlOf(i).endsWith('/api/sync/ops')) sent.push(...(JSON.parse(String(n?.body)) as { entries: { entity: string; entityId: string }[] }).entries);
      return real(i, n);
    }) as typeof fetch;
    await agentOf(p).runOnce();
    expect(sent.filter((e) => e.entity === 'device').length).toBe(1); // the enrolment, with its public key
    // the creation, and the PIN set at enrolment: since 2026.11.5 that is a full record (it was a nameless
    // fragment the cloud could not take, which also broke the app's user list), so the cloud takes it too
    expect(sent.filter((e) => e.entity === 'user').length).toBe(2);
    expect(login.userId).toBeTruthy();
    expect(agentOf(p).status()).toMatchObject({ lastError: null, refused: 0 });
  });
});

describe('Q7: the tick chain survives a disable', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  it('disabled during an in-flight dirty check, then re-enabled: the agent ticks again', async () => {
    const p = await makePair();
    p.worker.dirty.set(p.boxId, 999_999);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gated = true;
    p.hook.fetch = (async (i: Parameters<typeof fetch>[0], n?: RequestInit) => {
      if (gated && urlOf(i).includes('/dirty?')) await gate;
      return p.worker.fetch(i, n);
    }) as typeof fetch;
    const a = agentOf(p);
    a.start();
    await vi.advanceTimersByTimeAsync(10_000);
    // the dirty check is now in flight; the operator switches sync off, then the answer arrives
    putFeature(p.box.surau.db, 'cloudSync', { enabled: false }, 'local');
    gated = false;
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(a.nextDelayMs).not.toBeNull(); // the chain was re-armed, not dropped
    const checks = p.worker.dirtyChecks;
    putFeature(p.box.surau.db, 'cloudSync', { enabled: true }, 'local');
    await vi.advanceTimersByTimeAsync(130_000);
    expect(p.worker.dirtyChecks).toBeGreaterThan(checks);
    a.stop();
  });
});

describe('S2: what the cloud sends is checked and capped', () => {
  it('a malformed pulled entry is refused and counted; a good one in the same page still lands', async () => {
    const p = await makePair();
    const real = p.hook.fetch;
    const good = entry({ entity: 'content:penceramah', entityId: 'g1', after: { id: 'g1', name: 'Ustaz Baik', updatedAt: T2 } });
    const bad = [
      entry({ entity: 'auth', entityId: 'x', after: {} }), // an entity that never travels
      { ...entry({ entity: 'user', entityId: 'u9', after: { name: 'Jahat', roles: ['admin'], active: true } }), extra: 1 }, // unknown key
      entry({ entity: 'content:penceramah', entityId: 'e1', after: null, origin: 'cloud' }), // an echo the cloud never emits
    ];
    p.hook.fetch = (async (i: Parameters<typeof fetch>[0], n?: RequestInit) => {
      if (urlOf(i).includes('/api/sync/changes')) return jsonRes(200, { entries: [...bad, good], next: null, head: 7, seq: 7 });
      return real(i, n);
    }) as typeof fetch;
    await agentOf(p).runOnce();
    expect(getItem(p.box.surau.db, 'penceramah', 'g1')).toMatchObject({ name: 'Ustaz Baik' });
    expect(p.box.surau.db.prepare("SELECT COUNT(*) AS n FROM users WHERE name = 'Jahat'").get()?.n).toBe(0);
    expect(agentOf(p).status()).toMatchObject({ refused: 3, lastRefusal: 'pull_bad_shape', lastError: 'refused' });
  });

  it('an oversized changes page is refused (bad_answer) and nothing from it is applied', async () => {
    const p = await makePair({ page: 2_000 });
    for (let i = 0; i < 30; i++) putItem(p.cloud.app.surau.db, 'penceramah', { id: `c${i}`, name: `Ustaz nombor ${i}` }, 'local');
    await agentOf(p).runOnce();
    expect(agentOf(p).status().lastError).toBe('bad_answer');
    expect(getItem(p.box.surau.db, 'penceramah', 'c0')).toBeNull();
  });

  it('a streamed answer with no content-length is cut at the cap', async () => {
    const p = await makePair({ small: 500 });
    let pulled = 0;
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(enc.encode(' '.repeat(400)));
        if (pulled > 50) c.close();
      },
    });
    const agent = agentOf(p) as unknown as { okJson: (r: Response) => Promise<unknown> };
    await expect(agent.okJson(new Response(body, { status: 200 }))).rejects.toMatchObject({ reason: 'bad_answer' });
    expect(pulled).toBeLessThan(10); // it stopped reading
  });

  it('an oversized snapshot is refused', async () => {
    const p = await makePair({ snapshot: 1_000 });
    for (let i = 0; i < 20; i++) putItem(p.cloud.app.surau.db, 'penceramah', { id: `s${i}`, name: `Ustaz nombor ${i}` }, 'local');
    p.cloud.app.surau.db.prepare("INSERT INTO sync_state (key, value) VALUES ('log_floor', '100000')").run();
    await agentOf(p).runOnce();
    expect(agentOf(p).status().lastError).toBe('bad_answer');
    expect(getItem(p.box.surau.db, 'penceramah', 's0')).toBeNull();
  });
});

describe('Q6: a 410 snapshot mirrors the cloud', () => {
  const floor = (p: Pair): void => {
    p.cloud.app.surau.db.prepare("INSERT INTO sync_state (key, value) VALUES ('log_floor', '100000') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  };
  const markPushed = async (p: Pair): Promise<void> => {
    await agentOf(p).runOnce();
    const head = Number(p.box.surau.db.prepare('SELECT MAX(id) AS m FROM change_log').get()?.m);
    p.box.surau.db.prepare("INSERT INTO sync_state (key, value) VALUES ('last_push_seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(head));
  };

  it('a cloud settings edit newer than the box lands after a 410 (it was stamped at the epoch before)', async () => {
    const p = await makePair();
    const ctx = (db: FastifyInstance) => ({ now: new Date(), origin: 'local', actor: 'user:x', dataDir: db === p.box ? p.boxDir : p.cloud.dir });
    applyFeedEntry(p.box.surau.db, entry({ entity: 'settings', entityId: 'ticker', after: { speed: 'slow' }, editedAt: T1, rev: `${T1}|dev-a` }), ctx(p.box));
    await markPushed(p);
    applyFeedEntry(p.cloud.app.surau.db, entry({ entity: 'settings', entityId: 'ticker', after: { speed: 'fast' }, editedAt: T2, rev: `${T2}|dev-b` }), ctx(p.cloud.app));
    floor(p);
    await agentOf(p).runOnce();
    expect(agentOf(p).status().lastError).toBeNull();
    const row = p.box.surau.db.prepare("SELECT json FROM settings WHERE feature = 'ticker'").get();
    expect(JSON.parse(String(row?.json))).toMatchObject({ speed: 'fast' });
  });

  it('a snapshot without any stamps (older cloud) still lets the cloud win: settings and users take the snapshot time', async () => {
    const p = await makePair();
    const ctx = (dir: string) => ({ now: new Date(), origin: 'local', actor: 'user:x', dataDir: dir });
    applyFeedEntry(p.box.surau.db, entry({ entity: 'settings', entityId: 'ticker', after: { speed: 'slow' }, editedAt: T1, rev: `${T1}|dev-a` }), ctx(p.boxDir));
    applyFeedEntry(p.box.surau.db, entry({ entity: 'user', entityId: 'u-old', after: { name: 'Lama', roles: ['ajk'], active: true }, editedAt: T1, rev: `${T1}|dev-a` }), ctx(p.boxDir));
    await markPushed(p);
    applyFeedEntry(p.cloud.app.surau.db, entry({ entity: 'settings', entityId: 'ticker', after: { speed: 'fast' }, editedAt: T2, rev: `${T2}|dev-b` }), ctx(p.cloud.dir));
    applyFeedEntry(p.cloud.app.surau.db, entry({ entity: 'user', entityId: 'u-old', after: { name: 'Baharu', roles: ['ajk'], active: true }, editedAt: T2, rev: `${T2}|dev-b` }), ctx(p.cloud.dir));
    floor(p);
    const real = p.hook.fetch;
    p.hook.fetch = (async (i: Parameters<typeof fetch>[0], n?: RequestInit) => {
      const res = await real(i, n);
      if (!urlOf(i).includes('/api/sync/snapshot')) return res;
      const snap = (await res.json()) as Record<string, unknown>;
      delete snap.settingsMeta;
      snap.users = ((snap.users as Record<string, unknown>[]) ?? []).map(({ editedAt: _e, rev: _r, ...rest }) => rest);
      return jsonRes(200, snap);
    }) as typeof fetch;
    await agentOf(p).runOnce();
    expect(agentOf(p).status().lastError).toBeNull();
    expect(JSON.parse(String(p.box.surau.db.prepare("SELECT json FROM settings WHERE feature = 'ticker'").get()?.json))).toMatchObject({ speed: 'fast' });
    expect(p.box.surau.db.prepare("SELECT name FROM users WHERE id = 'u-old'").get()?.name).toBe('Baharu');
  });

  it('a cloud user rename newer than the box lands after a 410', async () => {
    const p = await makePair();
    const row = p.box.surau.db.prepare("SELECT * FROM users LIMIT 1").get() as Record<string, unknown> | undefined;
    // use a fresh user known to both sides
    const mk = (db: FastifyInstance, name: string, at: string): void =>
      void applyFeedEntry(db.surau.db, entry({ entity: 'user', entityId: 'u-shared', after: { name, roles: ['ajk'], active: true }, editedAt: at, rev: `${at}|dev-a` }), {
        now: new Date(), origin: 'local', actor: 'user:x', dataDir: db === p.box ? p.boxDir : p.cloud.dir,
      });
    void row;
    mk(p.box, 'Nama lama', T1);
    await markPushed(p);
    mk(p.cloud.app, 'Nama baharu', T2);
    floor(p);
    await agentOf(p).runOnce();
    expect(p.box.surau.db.prepare("SELECT name FROM users WHERE id = 'u-shared'").get()?.name).toBe('Nama baharu');
  });

  it('an item the cloud no longer has is removed on the box, unless the box edited it after the snapshot', async () => {
    const p = await makePair();
    putItem(p.box.surau.db, 'penceramah', { id: 'gone', name: 'Dibuang di awan' }, 'local', { editedAt: T1 });
    putItem(p.box.surau.db, 'penceramah', { id: 'newer', name: 'Baharu di kotak' }, 'local', { editedAt: '2099-01-01T00:00:00.000Z' });
    await markPushed(p); // both marked pushed, though the cloud lacks them
    p.cloud.app.surau.db.prepare("DELETE FROM content_items WHERE id IN ('gone', 'newer')").run();
    floor(p);
    await agentOf(p).runOnce();
    expect(agentOf(p).status().lastError).toBeNull();
    expect(getItem(p.box.surau.db, 'penceramah', 'gone')).toBeNull();
    expect(getItem(p.box.surau.db, 'penceramah', 'newer')).toMatchObject({ name: 'Baharu di kotak' });
  });

  it('a tombstone on the cloud deletes an older live box item', async () => {
    const p = await makePair();
    putItem(p.box.surau.db, 'penceramah', { id: 't1', name: 'Hidup di kotak' }, 'local', { editedAt: T1 });
    await agentOf(p).runOnce();
    applyFeedEntry(p.cloud.app.surau.db, entry({ entity: 'content:penceramah', entityId: 't1', after: null, editedAt: T2, rev: `${T2}|dev-b` }), {
      now: new Date(), origin: 'local', actor: 'user:x', dataDir: p.cloud.dir,
    });
    floor(p);
    await agentOf(p).runOnce();
    expect(getItem(p.box.surau.db, 'penceramah', 't1')).toBeNull();
  });

  it('pending box changes are pushed before the snapshot; if that push fails the snapshot is not applied', async () => {
    const p = await makePair();
    await agentOf(p).runOnce();
    floor(p);
    const real = p.hook.fetch;
    let injected = false;
    let snapshots = 0;
    let failOps = false;
    p.hook.fetch = (async (i: Parameters<typeof fetch>[0], n?: RequestInit) => {
      const u = urlOf(i);
      if (u.includes('/api/sync/changes') && !injected) {
        injected = true; // a local edit made after the cycle's push, before the pull answers 410
        putItem(p.box.surau.db, 'penceramah', { id: 'late', name: 'Lewat' }, 'local');
        failOps = true;
      }
      if (u.endsWith('/api/sync/ops') && failOps) return new Response('boom', { status: 502 });
      if (u.includes('/api/sync/snapshot')) snapshots += 1;
      return real(i, n);
    }) as typeof fetch;
    await agentOf(p).runOnce();
    expect(agentOf(p).status().lastError).toBe('http_5xx');
    expect(snapshots).toBe(0);
    expect(getItem(p.box.surau.db, 'penceramah', 'late')).toMatchObject({ name: 'Lewat' });
    // the push works again: the late edit reaches the cloud and survives the mirror
    failOps = false;
    await agentOf(p).runOnce();
    expect(getItem(p.cloud.app.surau.db, 'penceramah', 'late')).toMatchObject({ name: 'Lewat' });
    expect(getItem(p.box.surau.db, 'penceramah', 'late')).toMatchObject({ name: 'Lewat' });
  });
});
