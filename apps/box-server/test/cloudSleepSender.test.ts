import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { cloudSleepOwed, createCloudSleepSender, markCloudSleep } from '../src/sync/resetFromBox.ts';
import { generateSyncKeyPair, loadSyncKey, saveSyncKey } from '../src/sync/syncKey.ts';
import { closeAllPairs, makeLinkedPair, until } from './support/linkedPair.ts';
import type { LinkedPair } from './support/linkedPair.ts';
import { sleepOf } from '../src/sync/surauSleep.ts';
import { createWorld, linkNewBox } from './support/twoBoxes.ts';
import type { World } from './support/twoBoxes.ts';

/*
 * Multi-box 2B, block B4: a box that becomes a follower keeps a sealed note and tells the cloud, once, that its surau
 * sleeps. Real cloud app, real link steps; only the network is a function.
 */

const MARK = join('secret', 'link-cloud-sleep.json');
const SURAU = 'sdm';
const LINK = 'L2026112301';

let world: World | null = null;
afterEach(async () => {
  await closeAllPairs();
  await world?.close();
  world = null;
});

const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function senderOf(p: LinkedPair): { sender: ReturnType<typeof createCloudSleepSender>; waits: number[]; logs: string[] } {
  const waits: number[] = [];
  const logs: string[] = [];
  const sender = createCloudSleepSender({
    dataDir: p.boxDir, now: () => new Date(), fetchImpl: p.wire, initialDelayMs: 0, log: (l) => void logs.push(l),
    sleep: (ms) => {
      waits.push(ms);
      return new Promise((r) => setTimeout(r, 1));
    },
  });
  return { sender, waits, logs };
}

const sleepCalls = (p: LinkedPair): number => p.calls.filter((c) => c.path === '/api/sync/sleep').length;

describe('the sealed note', () => {
  it('is written sealed: its plain text never holds the token, the key or the link id', async () => {
    const p = await makeLinkedPair();
    const key = loadSyncKey(p.boxDir)!;
    expect(markCloudSleep(p.boxDir, LINK, p.boxId)).toBe(true);
    const raw = readFileSync(join(p.boxDir, MARK), 'utf8');
    expect(raw.startsWith('v1.')).toBe(true);
    expect(raw).not.toContain(key.siteToken);
    expect(raw).not.toContain(String((key.privateJwk as Record<string, unknown>).d));
    expect(raw).not.toContain(LINK);
    expect(cloudSleepOwed(p.boxDir)).toBe(true);
  });

  it('a box with no sync key writes no note', async () => {
    const p = await makeLinkedPair();
    rmSync(join(p.boxDir, 'secret', 'sync.key'));
    expect(markCloudSleep(p.boxDir, LINK, p.boxId)).toBe(false);
    expect(existsSync(join(p.boxDir, MARK))).toBe(false);
    // a link id that is not one is refused too
    expect(markCloudSleep(p.boxDir, '../x', p.boxId)).toBe(false);
  });
});

describe('the sleep sender', () => {
  it('sleeps the surau on the cloud even after the box set its sync key aside, then removes the note', async () => {
    const p = await makeLinkedPair();
    markCloudSleep(p.boxDir, LINK, p.boxId);
    // what a follower's set-aside does at its next start
    rmSync(join(p.boxDir, 'secret', 'sync.key'));
    const { sender } = senderOf(p);
    sender.start();
    await sender.finished();
    expect(sleepCalls(p)).toBe(1);
    expect(p.calls.find((c) => c.path === '/api/sync/sleep')?.status).toBe(200);
    expect(sleepOf(p.cloud.app.surau.db, SURAU)?.asleepBox).toBe(p.boxId);
    expect(existsSync(join(p.boxDir, MARK))).toBe(false);
  });

  it('a surau already put to sleep by this box answers 200 and the note goes', async () => {
    const p = await makeLinkedPair();
    p.cloud.app.surau.db.prepare('UPDATE suraus SET asleep_at = ?, asleep_box = ? WHERE id = ?').run('2026-11-20T01:00:00.000Z', p.boxId, SURAU);
    markCloudSleep(p.boxDir, LINK, p.boxId);
    const { sender } = senderOf(p);
    sender.start();
    await sender.finished();
    expect(existsSync(join(p.boxDir, MARK))).toBe(false);
  });

  it('409 surau_asleep from another box: logged, the note is removed, no retry', async () => {
    const p = await makeLinkedPair();
    p.cloud.app.surau.db.prepare('UPDATE suraus SET asleep_at = ?, asleep_box = ? WHERE id = ?').run('2026-11-20T01:00:00.000Z', 'bbbbbbbbbbbbbbbb', SURAU);
    markCloudSleep(p.boxDir, LINK, p.boxId);
    const { sender, logs, waits } = senderOf(p);
    sender.start();
    await sender.finished();
    expect(sleepCalls(p)).toBe(1);
    expect(existsSync(join(p.boxDir, MARK))).toBe(false);
    expect(logs.length).toBe(1);
    expect(waits).toEqual([]);
    expect(sleepOf(p.cloud.app.surau.db, SURAU)?.asleepBox).toBe('bbbbbbbbbbbbbbbb');
  });

  it('401 or 403: logged, the note is kept, nothing more is sent until the next start', async () => {
    const p = await makeLinkedPair();
    markCloudSleep(p.boxDir, LINK, p.boxId);
    p.cloud.app.surau.db.prepare('UPDATE sites SET revoked_at = ? WHERE box_id = ?').run('2026-11-21T00:00:00.000Z', p.boxId);
    const { sender, logs, waits } = senderOf(p);
    sender.start();
    await sender.finished();
    expect(sleepCalls(p)).toBe(1);
    expect([401, 403]).toContain(p.calls.find((c) => c.path === '/api/sync/sleep')?.status);
    expect(existsSync(join(p.boxDir, MARK))).toBe(true);
    expect(logs.length).toBe(1);
    expect(waits).toEqual([]);
    expect(sleepOf(p.cloud.app.surau.db, SURAU)).toBeNull();
  });

  it('5xx and a dead network back off 1, 5, 15, 60 minutes, then it goes through', async () => {
    const p = await makeLinkedPair();
    markCloudSleep(p.boxDir, LINK, p.boxId);
    let tries = 0;
    p.intercept.fn = (_m, path) => {
      if (path !== '/api/sync/sleep' || tries >= 5) return undefined;
      tries += 1;
      if (tries === 1) throw new Error('down');
      return json(502, { errors: ['x'] });
    };
    const { sender, waits } = senderOf(p);
    sender.start();
    await sender.finished();
    expect(waits).toEqual([60_000, 300_000, 900_000, 3_600_000, 3_600_000]);
    expect(existsSync(join(p.boxDir, MARK))).toBe(false);
    expect(sleepOf(p.cloud.app.surau.db, SURAU)?.asleepBox).toBe(p.boxId);
  });

  it('a note that cannot be opened (another box key) is kept and nothing is sent', async () => {
    const p = await makeLinkedPair();
    markCloudSleep(p.boxDir, LINK, p.boxId);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(p.boxDir, MARK), 'v1.AAAA.AAAA.AAAA');
    const { sender, logs } = senderOf(p);
    sender.start();
    await sender.finished();
    expect(sleepCalls(p)).toBe(0);
    expect(existsSync(join(p.boxDir, MARK))).toBe(true);
    expect(logs.length).toBe(1);
  });

  it('a running FOLLOWER starts the sender at boot when a note exists, and stops it on close', async () => {
    const p = await makeLinkedPair();
    markCloudSleep(p.boxDir, LINK, p.boxId);
    rmSync(join(p.boxDir, 'secret', 'sync.key'));
    // only a box that still follows sends the note (a box that left drops it: gateCloudWake.test.ts)
    writeFileSync(join(p.boxDir, 'secret', 'follow.json'), '{}');
    const box = await p.reopen();
    await box.ready();
    await until(() => expect(existsSync(join(p.boxDir, MARK))).toBe(false));
    expect(sleepOf(p.cloud.app.surau.db, SURAU)?.asleepBox).toBe(p.boxId);
    // no note, no sender
    const before = sleepCalls(p);
    await box.close();
    const again = buildApp(join(p.boxDir, 'box.db'), { dataDir: p.boxDir, cloud: { url: 'https://cloud.test' }, sync: { fetchImpl: p.wire, initialDelayMs: 600_000 } });
    await again.ready();
    await again.close();
    expect(sleepCalls(p)).toBe(before);
  });
});

describe('followerSleepsAtCommit', () => {
  it('a cloud-linked box that becomes a follower keeps the note at the commit; one with no sync key does not', async () => {
    world = createWorld();
    const master = await world.make(1, { persist: true });
    const linked = await world.make(2, { setUp: false, persist: true });
    const plain = await world.make(3, { setUp: false, persist: true });
    const pair = generateSyncKeyPair();
    saveSyncKey(linked.dir!, {
      privateJwk: pair.privateJwk, publicJwk: pair.publicJwk, cloudUrl: 'https://cloud.test', siteToken: 'tok-ujian-surau-al-hidayah', wakeSecret: 'wake-ujian-surau-al-hidayah', linkedAt: '2026-11-01T00:00:00.000Z',
    });
    expect(existsSync(join(linked.dir!, MARK))).toBe(false);

    await linkNewBox(master, linked);
    await until(() => expect(existsSync(join(linked.dir!, MARK))).toBe(true));
    const raw = readFileSync(join(linked.dir!, MARK), 'utf8');
    expect(raw.startsWith('v1.')).toBe(true);
    expect(raw).not.toContain('tok-ujian-surau-al-hidayah');
    // the follower did take the commit
    await until(() => expect(linked.restarts).toBeGreaterThan(0));

    // a box with no sync key links the same way and writes no note
    await linkNewBox(master, plain);
    await until(() => expect(plain.restarts).toBeGreaterThan(0));
    expect(existsSync(join(plain.dir!, MARK))).toBe(false);
  });
});
