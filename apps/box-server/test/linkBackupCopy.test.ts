import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { keepInBackupBeforeDelete, takeMasterBackup } from '../src/link/backupCopy.ts';
import { readJournal } from '../src/link/journal.ts';
import { applyLinkJournalAtBoot, backupOf, listBackups, planRestore, walkFiles } from '../src/link/setAside.ts';

const LINK = 'c0ffee00c0ffee00c0ffee00c0ffee00';
const T0 = new Date('2026-11-20T01:41:00.000Z');
const BIG = 10 * 1024 * 1024 * 1024;

let dir: string;
let db: DatabaseSync;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'maxcom-backup-copy-'));
  db = openDb(join(dir, 'surau.db'));
  db.exec('CREATE TABLE probe (x TEXT)');
  db.prepare('INSERT INTO probe (x) VALUES (?)').run('old');
  put('assets/a.png', 'old-picture');
  put('assets/video/v.mp4', 'old-video');
  put('assets/gone.png', 'old-gone');
  put('assets/swap.png', 'old-swap');
  put('finance/photos/p1.jpg', 'old-receipt');
  put('themes/hijau/bundle.css', 'old-css');
  put('secret/sync.key', 'old-cloud');
  put('secret/youtube-token.json', 'old-yt');
  put('secret/live-camera.json', 'old-cam');
  put('secret/box.key', 'BOXKEY');
  put('box.json', '{"state":"ready"}');
});
afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true });
});

function put(rel: string, body: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}
const read = (rel: string): string => readFileSync(join(dir, rel), 'utf8');
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const ample = (): number => BIG;

/** What the stores do to a file: write a temp file next to it, then rename over it. */
function replace(rel: string, body: string): void {
  writeFileSync(join(dir, `${rel}.tmp`), body);
  renameSync(join(dir, `${rel}.tmp`), join(dir, rel));
}

function rowsOf(path: string): string[] {
  const d = openDb(path);
  try {
    return (d.prepare('SELECT x FROM probe ORDER BY rowid').all() as Array<{ x: string }>).map((r) => r.x);
  } finally {
    d.close();
  }
}

/** The link ended with the box serving: database closed, as the real server does before a restart. */
function afterLink(): void {
  db.prepare('INSERT INTO probe (x) VALUES (?)').run('after-link');
  rmSync(join(dir, 'assets/gone.png'));
  replace('assets/swap.png', 'new-swap');
  put('assets/added.png', 'new-added');
  put('secret/follow.json', 'FOLLOW');
  db.close();
}

describe('takeMasterBackup (hard links)', () => {
  it('copies the database consistently, copies the secrets and links every media file', async () => {
    const r = await takeMasterBackup({ db, dataDir: dir, linkId: LINK, now: T0, free: ample, release: '2026.11.15', dbLevel: 29 });
    expect(r.taken).toBe(true);
    const base = join(dir, 'linkundo', LINK);
    expect(rowsOf(join(base, 'surau.db'))).toEqual(['old']);
    expect(readFileSync(join(base, 'secret/sync.key'), 'utf8')).toBe('old-cloud');
    expect(readFileSync(join(base, 'secret/live-camera.json'), 'utf8')).toBe('old-cam');
    expect(existsSync(join(base, 'secret/box.key'))).toBe(false);
    // a second name for the same file: the link count of the live file is 2
    expect(statSync(join(dir, 'assets/a.png')).nlink).toBe(2);
    expect(statSync(join(base, 'assets/a.png')).ino).toBe(statSync(join(dir, 'assets/a.png')).ino);
    expect(readFileSync(join(base, 'finance/photos/p1.jpg'), 'utf8')).toBe('old-receipt');
    expect(readFileSync(join(base, 'themes/hijau/bundle.css'), 'utf8')).toBe('old-css');
    // nothing left of the partial folder
    expect(existsSync(`${base}.partial`)).toBe(false);
  });

  it('writes a manifest of kind copy with exact sizes and hashes', async () => {
    await takeMasterBackup({ db, dataDir: dir, linkId: LINK, now: T0, free: ample, release: '2026.11.15', dbLevel: 29 });
    const m = backupOf(dir, LINK)!;
    expect(m).toMatchObject({ v: 1, kind: 'copy', linkId: LINK, at: T0.toISOString(), release: '2026.11.15', dbLevel: 29, mode: 'hardlink' });
    expect(m.files.find((f) => f.path === 'assets/a.png')).toEqual({ path: 'assets/a.png', size: 11, sha256: sha('old-picture') });
    for (const f of m.files) {
      const body = readFileSync(join(dir, 'linkundo', LINK, f.path));
      expect(f.size).toBe(body.length);
      expect(f.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    }
    expect(m.bytes).toBe(m.files.reduce((n, f) => n + f.size, 0));
    expect(m.files.map((f) => f.path)).toContain('surau.db');
  });

  it('is taken once: a box that already has a backup skips it', async () => {
    await takeMasterBackup({ db, dataDir: dir, linkId: LINK, now: T0, free: ample });
    const again = await takeMasterBackup({ db, dataDir: dir, linkId: 'd'.repeat(32), now: T0, free: ample });
    expect(again).toEqual({ taken: false, reason: 'exists' });
    expect(listBackups(dir).map((b) => b.folder)).toEqual([LINK]);
  });

  it('refuses before any change when free space is under the database plus 100 MB above the floor', async () => {
    const floor = 500 * 1024 * 1024;
    await expect(takeMasterBackup({ db, dataDir: dir, linkId: LINK, now: T0, free: () => floor + 100 * 1024 * 1024 - 1 })).rejects.toThrow('backup: no_space');
    expect(existsSync(join(dir, 'linkundo'))).toBe(false);
    const ok = await takeMasterBackup({ db, dataDir: dir, linkId: LINK, now: T0, free: () => floor + 101 * 1024 * 1024 + 1024 * 1024 });
    expect(ok.taken).toBe(true);
  });

  it('applies no space rule when free space cannot be read', async () => {
    const r = await takeMasterBackup({ db, dataDir: dir, linkId: LINK, now: T0, free: () => null });
    expect(r.taken).toBe(true);
  });

  it('leaves nothing behind when it fails half way, and refuses while a journal is open', async () => {
    await expect(takeMasterBackup({ db, dataDir: dir, linkId: LINK, now: T0, free: ample, link: () => { throw Object.assign(new Error('disk'), { code: 'EIO' }); } })).rejects.toThrow('disk');
    expect(existsSync(join(dir, 'linkundo', LINK))).toBe(false);
    expect(existsSync(join(dir, 'linkundo', `${LINK}.partial`))).toBe(false);
    writeFileSync(join(dir, 'link.json'), JSON.stringify({ v: 1, op: 'restore', linkId: 'e'.repeat(32), step: 'planned', at: T0.toISOString() }));
    await expect(takeMasterBackup({ db, dataDir: dir, linkId: LINK, now: T0, free: ample })).rejects.toThrow('backup: journal_open');
  });
});

describe('restore of a copy backup', () => {
  it('a file deleted after the link is still in the backup and comes back; a replaced file comes back as the old one', async () => {
    await takeMasterBackup({ db, dataDir: dir, linkId: LINK, now: T0, free: ample });
    afterLink();
    // the backup kept the deleted and the replaced file
    expect(readFileSync(join(dir, 'linkundo', LINK, 'assets/gone.png'), 'utf8')).toBe('old-gone');
    expect(readFileSync(join(dir, 'linkundo', LINK, 'assets/swap.png'), 'utf8')).toBe('old-swap');

    planRestore(dir, LINK, new Date(T0.getTime() + 200 * 86_400_000));
    expect(applyLinkJournalAtBoot(dir)).toBe('restore');
    expect(read('assets/gone.png')).toBe('old-gone');
    expect(read('assets/swap.png')).toBe('old-swap');
    expect(read('assets/a.png')).toBe('old-picture');
    expect(read('secret/youtube-token.json')).toBe('old-yt');
    expect(existsSync(join(dir, 'assets/added.png'))).toBe(false);
    expect(rowsOf(join(dir, 'surau.db'))).toEqual(['old']);
    expect(existsSync(join(dir, 'secret/follow.json'))).toBe(false);
    expect(read('secret/box.key')).toBe('BOXKEY');
    // what the box held at the unlink is kept aside, with the file added after the link and the newer rows
    const aside = join(dir, 'linkundo', `${LINK}-at-unlink`);
    expect(readFileSync(join(aside, 'assets/added.png'), 'utf8')).toBe('new-added');
    expect(readFileSync(join(aside, 'assets/swap.png'), 'utf8')).toBe('new-swap');
    expect(rowsOf(join(aside, 'surau.db'))).toEqual(['old', 'after-link']);
    expect(existsSync(join(dir, 'linkundo', LINK))).toBe(false);
  });

  it('a power cut at every step of the restore, then another start: always fully new', async () => {
    const setup = async (): Promise<void> => {
      try {
        db.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), 'maxcom-backup-copy-'));
      db = openDb(join(dir, 'surau.db'));
      db.exec('CREATE TABLE probe (x TEXT)');
      db.prepare('INSERT INTO probe (x) VALUES (?)').run('old');
      put('assets/a.png', 'old-picture');
      put('assets/gone.png', 'old-gone');
      put('assets/swap.png', 'old-swap');
      put('secret/youtube-token.json', 'old-yt');
      put('secret/box.key', 'BOXKEY');
      await takeMasterBackup({ db, dataDir: dir, linkId: LINK, now: T0, free: ample });
      afterLink();
      planRestore(dir, LINK, T0);
    };
    const shape = (): string[] =>
      walkFiles(dir)
        .filter((p) => !p.includes('surau.db') && !p.endsWith('manifest.json'))
        .map((p) => `${p}:${sha(readFileSync(join(dir, p), 'utf8'))}`);

    await setup();
    const names: string[] = [];
    applyLinkJournalAtBoot(dir, { afterStep: (n) => names.push(n) });
    const golden = shape();
    expect(names.length).toBeGreaterThan(6);

    for (const name of names) {
      await setup();
      expect(() =>
        applyLinkJournalAtBoot(dir, {
          afterStep: (n) => {
            if (n === name) throw new Error('cut');
          },
        }),
      ).toThrow('cut');
      expect(applyLinkJournalAtBoot(dir)).toBe(name === 'restore:cleared' ? 'none' : 'restore');
      expect(readJournal(dir)).toBeNull();
      expect(shape(), `after a cut at ${name}`).toEqual(golden);
      expect(rowsOf(join(dir, 'surau.db'))).toEqual(['old']);
    }
  });
});

describe('keep-on-delete (no hard links on this file system)', () => {
  const noLinks = (): void => {
    throw Object.assign(new Error('not supported'), { code: 'EPERM' });
  };

  it('records the mode, links nothing, and still names every media file', async () => {
    const r = await takeMasterBackup({ db, dataDir: dir, linkId: LINK, now: T0, free: ample, link: noLinks });
    expect(r.taken).toBe(true);
    const m = backupOf(dir, LINK)!;
    expect(m.mode).toBe('keep-on-delete');
    expect(existsSync(join(dir, 'linkundo', LINK, 'assets'))).toBe(false);
    expect(readFileSync(join(dir, 'linkundo', LINK, 'secret/sync.key'), 'utf8')).toBe('old-cloud');
    expect(m.files.find((f) => f.path === 'assets/a.png')).toEqual({ path: 'assets/a.png', size: 11, sha256: sha('old-picture') });
    expect(m.files.map((f) => f.path)).toContain('themes/hijau/bundle.css');
    expect(statSync(join(dir, 'assets/a.png')).nlink).toBe(1);
  });

  it('keepInBackupBeforeDelete moves the file into the backup; restore puts back kept and untouched files only', async () => {
    await takeMasterBackup({ db, dataDir: dir, linkId: LINK, now: T0, free: ample, link: noLinks });
    // a delete and a replace, each going through the helper first
    expect(keepInBackupBeforeDelete(dir, 'assets/gone.png')).toBe('moved');
    expect(existsSync(join(dir, 'assets/gone.png'))).toBe(false);
    expect(readFileSync(join(dir, 'linkundo', LINK, 'assets/gone.png'), 'utf8')).toBe('old-gone');
    expect(keepInBackupBeforeDelete(dir, 'assets/swap.png')).toBe('moved');
    writeFileSync(join(dir, 'assets/swap.png'), 'new-swap');
    // a second replace keeps the first (oldest) version
    expect(keepInBackupBeforeDelete(dir, 'assets/swap.png')).toBe('already-kept');
    expect(existsSync(join(dir, 'assets/swap.png'))).toBe(false);
    writeFileSync(join(dir, 'assets/swap.png'), 'newer-swap');
    // a file the backup does not name is the caller's to delete
    put('assets/added.png', 'new-added');
    expect(keepInBackupBeforeDelete(dir, 'assets/added.png')).toBe('not-needed');
    expect(existsSync(join(dir, 'assets/added.png'))).toBe(true);
    expect(() => keepInBackupBeforeDelete(dir, '../box.json')).toThrow('keep: bad_path');
    db.prepare('INSERT INTO probe (x) VALUES (?)').run('after-link');
    db.close();

    planRestore(dir, LINK, T0);
    expect(applyLinkJournalAtBoot(dir)).toBe('restore');
    expect(read('assets/gone.png')).toBe('old-gone');
    expect(read('assets/swap.png')).toBe('old-swap');
    expect(read('assets/a.png')).toBe('old-picture');
    expect(read('assets/video/v.mp4')).toBe('old-video');
    expect(read('finance/photos/p1.jpg')).toBe('old-receipt');
    expect(read('themes/hijau/bundle.css')).toBe('old-css');
    expect(existsSync(join(dir, 'assets/added.png'))).toBe(false);
    expect(rowsOf(join(dir, 'surau.db'))).toEqual(['old']);
    expect(readFileSync(join(dir, 'linkundo', `${LINK}-at-unlink`, 'assets/added.png'), 'utf8')).toBe('new-added');
  });

  it('a power cut at every step of the keep-on-delete restore ends fully new', async () => {
    const setup = async (): Promise<void> => {
      try {
        db.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), 'maxcom-backup-copy-'));
      db = openDb(join(dir, 'surau.db'));
      db.exec('CREATE TABLE probe (x TEXT)');
      db.prepare('INSERT INTO probe (x) VALUES (?)').run('old');
      put('assets/a.png', 'old-picture');
      put('assets/gone.png', 'old-gone');
      put('themes/hijau/bundle.css', 'old-css');
      await takeMasterBackup({ db, dataDir: dir, linkId: LINK, now: T0, free: ample, link: noLinks });
      keepInBackupBeforeDelete(dir, 'assets/gone.png');
      put('assets/added.png', 'new-added');
      db.close();
      planRestore(dir, LINK, T0);
    };
    const shape = (): string[] =>
      walkFiles(dir)
        .filter((p) => !p.includes('surau.db') && !p.endsWith('manifest.json'))
        .map((p) => `${p}:${sha(readFileSync(join(dir, p), 'utf8'))}`);
    await setup();
    const names: string[] = [];
    applyLinkJournalAtBoot(dir, { afterStep: (n) => names.push(n) });
    const golden = shape();
    expect(golden).toContain(`assets/gone.png:${sha('old-gone')}`);
    expect(golden).toContain(`themes/hijau/bundle.css:${sha('old-css')}`);
    for (const name of names) {
      await setup();
      expect(() =>
        applyLinkJournalAtBoot(dir, {
          afterStep: (n) => {
            if (n === name) throw new Error('cut');
          },
        }),
      ).toThrow('cut');
      applyLinkJournalAtBoot(dir);
      expect(shape(), `after a cut at ${name}`).toEqual(golden);
    }
  });

  it('is a no-op for a box whose backup uses hard links', async () => {
    await takeMasterBackup({ db, dataDir: dir, linkId: LINK, now: T0, free: ample });
    expect(keepInBackupBeforeDelete(dir, 'assets/a.png')).toBe('not-needed');
    expect(existsSync(join(dir, 'assets/a.png'))).toBe(true);
  });

  it('is a no-op for a box with no backup', () => {
    expect(keepInBackupBeforeDelete(dir, 'assets/a.png')).toBe('not-needed');
  });
});
