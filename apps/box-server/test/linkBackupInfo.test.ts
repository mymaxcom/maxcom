import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { takeMasterBackup } from '../src/link/backupCopy.ts';
import { backupInfo, dropBackup, removeSecretFromBackups, sweepKeptAtUnlink } from '../src/link/backupInfo.ts';
import { writeJournal } from '../src/link/journal.ts';
import { applyLinkJournalAtBoot, backupOf, listBackups, planRestore, planSetAside } from '../src/link/setAside.ts';

const LINK = '0123456789abcdef0123456789abcdef';
const T0 = new Date('2026-11-20T01:41:00.000Z');
const DAY = 86_400_000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'maxcom-backup-info-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function put(rel: string, body: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function makeStore(): void {
  const db = openDb(join(dir, 'surau.db'));
  db.exec('CREATE TABLE probe (x TEXT)');
  db.prepare('INSERT INTO probe (x) VALUES (?)').run('old');
  db.close();
  put('assets/a.png', 'old-picture');
  put('secret/youtube-token.json', 'old-yt');
  put('secret/youtube-state.json', 'old-ytstate');
  put('live/youtube-open.json', 'old-ytopen');
  put('secret/live-camera.json', 'old-cam');
  put('secret/sync.key', 'old-cloud');
  put('secret/follow.json', 'FOLLOW');
}

function setAside(id: string = LINK, at: Date = T0): void {
  planSetAside(dir, id, at, { release: '2026.11.15', dbLevel: 29 });
  applyLinkJournalAtBoot(dir);
}

describe('backupInfo', () => {
  it('is null with no backup', () => {
    makeStore();
    expect(backupInfo(dir)).toBeNull();
  });

  it('gives the link, kind, date, size and file count of the backup', () => {
    makeStore();
    setAside();
    const m = backupOf(dir, LINK)!;
    expect(backupInfo(dir)).toEqual({ linkId: LINK, kind: 'set-aside', at: T0.toISOString(), bytes: m.bytes, files: m.files.length });
    expect(m.bytes).toBeGreaterThan(0);
  });

  it('describes a copy backup the same way', async () => {
    makeStore();
    const db = openDb(join(dir, 'surau.db'));
    await takeMasterBackup({ db, dataDir: dir, linkId: LINK, now: T0, free: () => null });
    db.close();
    expect(backupInfo(dir)).toMatchObject({ linkId: LINK, kind: 'copy', at: T0.toISOString() });
  });

  it('does not count the data kept at an unlink as the backup of a link', () => {
    makeStore();
    mkdirSync(join(dir, 'linkundo', `${LINK}-at-unlink`), { recursive: true });
    writeFileSync(
      join(dir, 'linkundo', `${LINK}-at-unlink`, 'manifest.json'),
      JSON.stringify({ v: 1, kind: 'at-unlink', linkId: LINK, at: T0.toISOString(), release: 'x', dbLevel: 1, files: [], bytes: 0 }),
    );
    expect(listBackups(dir)).toHaveLength(1);
    expect(backupInfo(dir)).toBeNull();
  });
});

describe('dropBackup', () => {
  it('frees the folder and the info is null after', () => {
    makeStore();
    setAside();
    expect(existsSync(join(dir, 'linkundo', LINK, 'assets/a.png'))).toBe(true);
    dropBackup(dir, LINK);
    expect(existsSync(join(dir, 'linkundo', LINK))).toBe(false);
    expect(existsSync(join(dir, 'linkundo', `${LINK}.dropping`))).toBe(false);
    expect(backupInfo(dir)).toBeNull();
    expect(() => planRestore(dir, LINK, T0)).toThrow('restore: no_backup');
  });

  it('refuses while a journal is open, and for a backup that is not there', () => {
    makeStore();
    setAside();
    writeJournal(dir, { v: 1, op: 'restore', linkId: LINK, step: 'planned', at: T0.toISOString() });
    expect(() => dropBackup(dir, LINK)).toThrow('backup: journal_open');
    expect(existsSync(join(dir, 'linkundo', LINK, 'manifest.json'))).toBe(true);
    rmSync(join(dir, 'link.json'));
    expect(() => dropBackup(dir, 'f'.repeat(32))).toThrow('backup: no_backup');
    expect(() => dropBackup(dir, '../x')).toThrow('backup: bad_link_id');
  });
});

describe('removeSecretFromBackups', () => {
  it('removes the YouTube files from a backup and rewrites the manifest', () => {
    makeStore();
    setAside();
    const before = backupOf(dir, LINK)!;
    expect(before.files.map((f) => f.path)).toContain('secret/youtube-token.json');
    expect(removeSecretFromBackups(dir, 'youtube')).toBe(3);
    for (const rel of ['secret/youtube-token.json', 'secret/youtube-state.json', 'live/youtube-open.json']) {
      expect(existsSync(join(dir, 'linkundo', LINK, rel))).toBe(false);
    }
    expect(existsSync(join(dir, 'linkundo', LINK, 'secret/live-camera.json'))).toBe(true);
    const after = backupOf(dir, LINK)!;
    expect(after.files.map((f) => f.path).filter((p) => p.includes('youtube'))).toEqual([]);
    expect(after.files).toHaveLength(before.files.length - 3);
    expect(after.bytes).toBe(after.files.reduce((n, f) => n + f.size, 0));
    expect(after.bytes).toBeLessThan(before.bytes);
    expect(removeSecretFromBackups(dir, 'youtube')).toBe(0);
  });

  it('removes the camera record from every backup, the data kept at an unlink included', () => {
    makeStore();
    setAside();
    // the restored box and the kept data of the unlink
    planRestore(dir, LINK, T0);
    applyLinkJournalAtBoot(dir);
    put('secret/live-camera.json', 'mirror-cam');
    expect(existsSync(join(dir, 'linkundo', `${LINK}-at-unlink`))).toBe(true);
    // a second backup folder holding a camera file too
    mkdirSync(join(dir, 'linkundo', `${LINK}-at-unlink`, 'secret'), { recursive: true });
    writeFileSync(join(dir, 'linkundo', `${LINK}-at-unlink`, 'secret/live-camera.json'), 'kept-cam');
    expect(removeSecretFromBackups(dir, 'camera')).toBe(1);
    expect(existsSync(join(dir, 'linkundo', `${LINK}-at-unlink`, 'secret/live-camera.json'))).toBe(false);
    // the live store's own file is not a backup and stays
    expect(readFileSync(join(dir, 'secret/live-camera.json'), 'utf8')).toBe('mirror-cam');
  });

  it('leaves the live file of a box whose backup holds copies', async () => {
    makeStore();
    const db = openDb(join(dir, 'surau.db'));
    await takeMasterBackup({ db, dataDir: dir, linkId: LINK, now: T0, free: () => null });
    db.close();
    expect(removeSecretFromBackups(dir, 'camera')).toBe(1);
    expect(readFileSync(join(dir, 'secret/live-camera.json'), 'utf8')).toBe('old-cam');
    expect(backupOf(dir, LINK)!.files.map((f) => f.path)).not.toContain('secret/live-camera.json');
  });
});

describe('sweepKeptAtUnlink', () => {
  function unlinked(): void {
    makeStore();
    setAside();
    // the unlink happened on T0 (the date written into the kept data's manifest)
    planRestore(dir, LINK, T0);
    applyLinkJournalAtBoot(dir);
  }

  it('keeps the data at day 6 and deletes it at day 8', () => {
    unlinked();
    const folder = join(dir, 'linkundo', `${LINK}-at-unlink`);
    expect(existsSync(folder)).toBe(true);
    expect(sweepKeptAtUnlink(dir, new Date(T0.getTime() + 6 * DAY))).toEqual([]);
    expect(existsSync(folder)).toBe(true);
    expect(sweepKeptAtUnlink(dir, new Date(T0.getTime() + 8 * DAY))).toEqual([`${LINK}-at-unlink`]);
    expect(existsSync(folder)).toBe(false);
  });

  it('never deletes the backup of a linked box by time', () => {
    makeStore();
    setAside();
    expect(sweepKeptAtUnlink(dir, new Date(T0.getTime() + 400 * DAY))).toEqual([]);
    expect(backupOf(dir, LINK)).not.toBeNull();
    expect(existsSync(join(dir, 'linkundo', LINK, 'assets/a.png'))).toBe(true);
  });

  it('leaves the folder of a restore that is still running', () => {
    unlinked();
    writeJournal(dir, { v: 1, op: 'restore', linkId: LINK, step: 'back', at: T0.toISOString() });
    expect(sweepKeptAtUnlink(dir, new Date(T0.getTime() + 30 * DAY))).toEqual([]);
    expect(existsSync(join(dir, 'linkundo', `${LINK}-at-unlink`))).toBe(true);
  });

  it('removes what a killed drop left behind', () => {
    makeStore();
    mkdirSync(join(dir, 'linkundo', `${LINK}.dropping`, 'assets'), { recursive: true });
    expect(sweepKeptAtUnlink(dir, T0)).toEqual([`${LINK}.dropping`]);
    expect(existsSync(join(dir, 'linkundo', `${LINK}.dropping`))).toBe(false);
  });

  it('does nothing without a linkundo folder', () => {
    makeStore();
    expect(sweepKeptAtUnlink(dir, T0)).toEqual([]);
  });
});
