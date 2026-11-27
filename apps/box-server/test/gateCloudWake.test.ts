import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLOUD_SLEEP_REL, createCloudResetLoop } from '../src/sync/resetFromBox.ts';
import { sleepOf } from '../src/sync/surauSleep.ts';
import { closeAllPairs, makeLinkedPair, until } from './support/linkedPair.ts';
import type { LinkedPair } from './support/linkedPair.ts';

/*
 * Gate fixes (multi-box I2): a box that left a link wakes the cloud copy it put to sleep before it resets it (Q2), a
 * follower that carried on alone resets with reason `reduce` (Q1), and a box that no longer follows never sends a sleep
 * note left from its link (A1).
 */

const MARK = 'link-cloud-reset.json';
const LINK = 'L2026112301';
const SURAU = 'sdm';
const T0 = '2026-11-23T01:00:00.000Z';

let savedPlain: string | undefined;
beforeEach(() => {
  savedPlain = process.env.MAXCOM_PRUNE_PLAIN_BACKUP;
  process.env.MAXCOM_PRUNE_PLAIN_BACKUP = '1';
});
afterEach(async () => {
  await closeAllPairs();
  if (savedPlain === undefined) delete process.env.MAXCOM_PRUNE_PLAIN_BACKUP;
  else process.env.MAXCOM_PRUNE_PLAIN_BACKUP = savedPlain;
});

const writeMark = (dir: string, reason: 'restore' | 'adopt' | 'reduce'): void =>
  writeFileSync(join(dir, MARK), JSON.stringify({ v: 1, linkId: LINK, at: T0, reason }));

const sleepSurau = (p: LinkedPair, byBox: string): void => {
  p.cloud.app.surau.db.prepare('UPDATE suraus SET asleep_at = ?, asleep_box = ? WHERE id = ?').run(T0, byBox, SURAU);
};

function loopOf(p: LinkedPair): { loop: ReturnType<typeof createCloudResetLoop>; done: { n: number } } {
  const done = { n: 0 };
  const loop = createCloudResetLoop({
    db: p.box.surau.db, dataDir: p.boxDir, boxId: p.boxId, now: () => new Date(), fetchImpl: p.wire,
    sleep: () => new Promise((r) => setTimeout(r, 1)), initialDelayMs: 0, onDone: () => void (done.n += 1),
  });
  return { loop, done };
}

describe('a box that left a link wakes its own sleeping cloud copy, then resets it', () => {
  for (const reason of ['reduce', 'restore'] as const) {
    it(`${reason}: the wake goes first, the surau is awake, the reset is taken and the mark is gone`, async () => {
      const p = await makeLinkedPair();
      sleepSurau(p, p.boxId);
      writeMark(p.boxDir, reason);
      const { loop, done } = loopOf(p);
      loop.start();
      await until(() => expect(done.n).toBe(1));
      await loop.finished();
      const paths = p.calls.map((c) => c.path);
      const wake = paths.indexOf('/api/sync/wake');
      const reset = paths.indexOf('/api/sync/reset-from-box');
      expect(wake).toBeGreaterThanOrEqual(0);
      expect(reset).toBeGreaterThan(wake);
      expect(sleepOf(p.cloud.app.surau.db, SURAU)).toBeNull();
      expect(existsSync(join(p.boxDir, MARK))).toBe(false);
      expect(Number(p.cloud.app.surau.db.prepare('SELECT COUNT(*) AS n FROM surau_resets WHERE surau_id = ? AND ok = 1').get(SURAU)?.n)).toBe(1);
    });
  }

  it('a surau another box put to sleep is not woken: the reset stops and the mark stays', async () => {
    const p = await makeLinkedPair();
    sleepSurau(p, 'ffffffffffffffff');
    writeMark(p.boxDir, 'restore');
    const { loop, done } = loopOf(p);
    loop.start();
    await until(() => expect(p.calls.some((c) => c.path === '/api/sync/reset-from-box')).toBe(true));
    await loop.finished();
    expect(done.n).toBe(0);
    expect(sleepOf(p.cloud.app.surau.db, SURAU)?.asleepBox).toBe('ffffffffffffffff');
    expect(existsSync(join(p.boxDir, MARK))).toBe(true);
  });

  it('adopt never sends a wake (the new master never slept its surau)', async () => {
    const p = await makeLinkedPair();
    writeMark(p.boxDir, 'adopt');
    const { loop, done } = loopOf(p);
    loop.start();
    await until(() => expect(done.n).toBe(1));
    expect(p.calls.some((c) => c.path === '/api/sync/wake')).toBe(false);
  });
});

describe('a sleep note left from a link is dropped by a box that no longer follows', () => {
  it('no follow record at start: the note goes and no sleep is sent', async () => {
    const p = await makeLinkedPair();
    writeFileSync(join(p.boxDir, CLOUD_SLEEP_REL), JSON.stringify({ v: 1, sealed: 'x' }));
    const box = await p.reopen();
    await box.ready();
    expect(existsSync(join(p.boxDir, CLOUD_SLEEP_REL))).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(p.calls.some((c) => c.path === '/api/sync/sleep')).toBe(false);
    expect(sleepOf(p.cloud.app.surau.db, SURAU)).toBeNull();
  });
});
