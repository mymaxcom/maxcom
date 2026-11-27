import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { takeMasterBackup } from '../src/link/backupCopy.ts';
import { readJournal } from '../src/link/journal.ts';
import { applyLinkJournalAtBoot, planRestore } from '../src/link/setAside.ts';
import { issueRecoveryCode, recoveryCodeExists, RECOVERY_META_KEY, verifyRecoveryCode } from '../src/setup/codes.ts';

/**
 * The recovery code an admin was shown must survive a restore. The restored store brings back the hash of link day;
 * the hash in use before the swap is carried into it before anything is served.
 */

const LINK = 'c2'.repeat(16);
const T0 = new Date('2026-11-24T01:00:00.000Z');

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function boot(dir: string): Promise<FastifyInstance> {
  const app = buildApp(join(dir, 'surau.db'), { dataDir: dir, link: { restart: vi.fn(), origin: 'https://10.168.50.11:8443', caSha256: '1'.repeat(64) } });
  apps.push(app);
  await app.ready();
  return app;
}

async function site(): Promise<{ dir: string; app: FastifyInstance }> {
  const dir = mkdtempSync(join(tmpdir(), 'maxcom-recovery-carry-'));
  dirs.push(dir);
  return { dir, app: await boot(dir) };
}

/** Back up, change the code in use, plan the restore, close, carry it out at the "next start", open the store again. */
async function restoreAfter(s: { dir: string; app: FastifyInstance }, change: () => void): Promise<FastifyInstance> {
  expect((await takeMasterBackup({ db: s.app.surau.db, dataDir: s.dir, linkId: LINK, now: T0, free: () => null })).taken).toBe(true);
  change();
  planRestore(s.dir, LINK, T0);
  await s.app.close();
  expect(applyLinkJournalAtBoot(s.dir)).toBe('restore');
  return boot(s.dir);
}

describe('the recovery code across a restore', () => {
  it('a code rotated after link day completes recovery after the restore; the old one does not', async () => {
    const s = await site();
    const oldCode = issueRecoveryCode(s.app.surau.db);
    let newCode = '';
    const again = await restoreAfter(s, () => {
      newCode = issueRecoveryCode(s.app.surau.db);
    });
    expect(newCode).not.toBe(oldCode);
    expect(verifyRecoveryCode(again.surau.db, newCode)).toBe(true);
    expect(verifyRecoveryCode(again.surau.db, oldCode)).toBe(false);
  });

  it('a code issued only after link day (none in the backup) works after the restore', async () => {
    const s = await site();
    let code = '';
    const again = await restoreAfter(s, () => {
      code = issueRecoveryCode(s.app.surau.db);
    });
    expect(verifyRecoveryCode(again.surau.db, code)).toBe(true);
  });

  it('no code in use before the swap: the restored store loses the old hash (an explicit none is carried)', async () => {
    const s = await site();
    const oldCode = issueRecoveryCode(s.app.surau.db);
    const again = await restoreAfter(s, () => {
      s.app.surau.db.prepare('DELETE FROM meta WHERE key = ?').run(RECOVERY_META_KEY);
      expect(recoveryCodeExists(s.app.surau.db)).toBe(false);
    });
    expect(recoveryCodeExists(again.surau.db)).toBe(false);
    expect(verifyRecoveryCode(again.surau.db, oldCode)).toBe(false);
  });

  it('a code rotated between the plan and the swap is the one that is carried', async () => {
    const s = await site();
    issueRecoveryCode(s.app.surau.db);
    expect((await takeMasterBackup({ db: s.app.surau.db, dataDir: s.dir, linkId: LINK, now: T0, free: () => null })).taken).toBe(true);
    const planned = issueRecoveryCode(s.app.surau.db);
    planRestore(s.dir, LINK, T0);
    const rotated = issueRecoveryCode(s.app.surau.db);
    expect(rotated).not.toBe(planned);
    await s.app.close();
    expect(applyLinkJournalAtBoot(s.dir)).toBe('restore');
    const again = await boot(s.dir);
    expect(verifyRecoveryCode(again.surau.db, rotated)).toBe(true);
    expect(verifyRecoveryCode(again.surau.db, planned)).toBe(false);
  });

  it('a follower store carries nothing: the restored store keeps the hash the typed code was checked against', async () => {
    const s = await site();
    const backedUp = issueRecoveryCode(s.app.surau.db);
    const again = await restoreAfter(s, () => {
      // the store in use is a follower's (its follow record is there) and holds some other hash, or none
      mkdirSync(join(s.dir, 'secret'), { recursive: true });
      writeFileSync(join(s.dir, 'secret', 'follow.json'), '{}');
      issueRecoveryCode(s.app.surau.db);
    });
    expect(verifyRecoveryCode(again.surau.db, backedUp)).toBe(true);
    // and a follower store with no hash at all does not strip the restored one
    const t = await site();
    const code = issueRecoveryCode(t.app.surau.db);
    const back = await restoreAfter(t, () => {
      mkdirSync(join(t.dir, 'secret'), { recursive: true });
      writeFileSync(join(t.dir, 'secret', 'follow.json'), '{}');
      t.app.surau.db.prepare('DELETE FROM meta WHERE key = ?').run(RECOVERY_META_KEY);
    });
    expect(verifyRecoveryCode(back.surau.db, code)).toBe(true);
  });

  it('a read that fails is logged (no hash in the log) and the restored store keeps its own hash', async () => {
    const s = await site();
    const code = issueRecoveryCode(s.app.surau.db);
    expect((await takeMasterBackup({ db: s.app.surau.db, dataDir: s.dir, linkId: LINK, now: T0, free: () => null })).taken).toBe(true);
    // an unreadable live database file: a plan still stands, and says why nothing is carried
    await s.app.close();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const live = join(s.dir, 'surau.db');
    const good = readFileSync(live);
    writeFileSync(live, Buffer.from('not a database file at all'));
    try {
      planRestore(s.dir, LINK, T0);
    } finally {
      writeFileSync(live, good);
    }
    // one line for the recovery code, one for the Pentadbir phones: each says why nothing is carried
    expect(err).toHaveBeenCalledTimes(2);
    const line = String(err.mock.calls.map((c) => String(c[0])).find((l) => l.includes('recovery code')));
    expect(line).toContain('recovery code');
    expect(line).not.toMatch(/[0-9a-f]{64}/);
    err.mockRestore();
    expect(readJournal(s.dir)?.recoveryHash).toBeUndefined();
    expect(code).toBeTruthy();
  });

  it('no code anywhere: nothing is invented', async () => {
    const s = await site();
    const again = await restoreAfter(s, () => undefined);
    expect(recoveryCodeExists(again.surau.db)).toBe(false);
  });

  it('the carry is written once and again on a repeated start; a second start changes nothing', async () => {
    const s = await site();
    issueRecoveryCode(s.app.surau.db);
    let newCode = '';
    const again = await restoreAfter(s, () => {
      newCode = issueRecoveryCode(s.app.surau.db);
    });
    await again.close();
    const third = await boot(s.dir);
    expect(verifyRecoveryCode(third.surau.db, newCode)).toBe(true);
    expect(readJournal(s.dir)).toBeNull();
  });

  it('a store folder without a database plans a restore that carries nothing (no crash)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'maxcom-recovery-carry-'));
    dirs.push(dir);
    const db = openDb(join(dir, 'surau.db'));
    db.close();
    // no backup: the plan is refused as before, not by the carry
    expect(() => planRestore(dir, LINK, T0)).toThrow('restore: no_backup');
  });
});
