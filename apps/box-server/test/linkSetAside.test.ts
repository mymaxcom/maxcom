import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { clearJournal, readJournal, writeJournal } from '../src/link/journal.ts';
import { applyLinkJournalAtBoot, backupOf, listBackups, planForget, planRestore, planSetAside, walkFiles } from '../src/link/setAside.ts';

const LINK = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const T0 = new Date('2026-11-20T01:41:00.000Z');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'maxcom-set-aside-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function put(rel: string, body: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/** A small real store: a database with one row, media, secrets, and the files that must never move. */
function makeStore(tag: string): void {
  const db = openDb(join(dir, 'surau.db'));
  db.exec('CREATE TABLE IF NOT EXISTS probe (x TEXT)');
  db.prepare('INSERT INTO probe (x) VALUES (?)').run(tag);
  db.close();
  put('assets/a.png', `${tag}-picture`);
  put('assets/video/v.mp4', `${tag}-video`);
  put('finance/photos/p1.jpg', `${tag}-receipt`);
  put('themes/hijau/bundle.css', `${tag}-css`);
  put('secret/sync.key', `${tag}-cloud`);
  put('secret/youtube-token.json', `${tag}-yt`);
  put('secret/live-camera.json', `${tag}-cam`);
  put('secret/box.key', 'BOXKEY');
  put('secret/identity.key', 'IDKEY');
  put('secret/follow.json', 'FOLLOW');
  put('box.json', '{"state":"ready"}');
  put('pki/root-ca.cer', 'CA');
  put('logs/x.log', 'log');
}

function rows(): string[] {
  const db = openDb(join(dir, 'surau.db'));
  try {
    db.exec('CREATE TABLE IF NOT EXISTS probe (x TEXT)');
    return (db.prepare('SELECT x FROM probe ORDER BY rowid').all() as Array<{ x: string }>).map((r) => r.x);
  } finally {
    db.close();
  }
}

/** Every file with its hash: two trees are the same store when these lists are equal. */
function tree(): string[] {
  // a database file and a manifest carry run-specific bytes (SQLite salts, the hashes of those files): by name only
  return walkFiles(dir).map((p) => (/surau.db|manifest.json$/.test(p) ? p : `${p}:${createHash('sha256').update(readFileSync(join(dir, p))).digest('hex')}`));
}

const STAYS = ['secret/box.key', 'secret/identity.key', 'secret/follow.json', 'box.json', 'pki/root-ca.cer', 'logs/x.log'];

/** The step names of one uninterrupted run, so a test can stand a power cut at each of them. */
function stepsOf(run: (afterStep: (n: string) => void) => void): string[] {
  const names: string[] = [];
  run((n) => names.push(n));
  return names;
}

function killAt(name: string, hooks: (afterStep: (n: string) => void) => void): void {
  expect(() =>
    hooks((n) => {
      if (n === name) throw new Error(`killed at ${name}`);
    }),
  ).toThrow(`killed at ${name}`);
}

describe('set-aside: the plan', () => {
  it('writes the journal and moves nothing', () => {
    makeStore('old');
    const before = tree();
    planSetAside(dir, LINK, T0, { release: '2026.11.15', dbLevel: 29 });
    const j = readJournal(dir);
    expect(j).toMatchObject({ v: 1, op: 'set-aside', linkId: LINK, step: 'planned', at: T0.toISOString(), needsFollow: true });
    expect(tree().filter((t) => !t.startsWith('link.json'))).toEqual(before.filter((t) => !t.startsWith('link.json')));
  });

  it('refuses a second plan while a journal is open', () => {
    makeStore('old');
    planSetAside(dir, LINK, T0);
    expect(() => planSetAside(dir, 'b'.repeat(32), T0)).toThrow('set-aside: journal_open');
    expect(() => planRestore(dir, LINK, T0)).toThrow('restore: journal_open');
  });

  it('refuses when linkundo/<linkId> exists', () => {
    makeStore('old');
    mkdirSync(join(dir, 'linkundo', LINK), { recursive: true });
    expect(() => planSetAside(dir, LINK, T0)).toThrow('set-aside: backup_exists');
    expect(readJournal(dir)).toBeNull();
  });

  it('refuses a link id that is not a plain name', () => {
    makeStore('old');
    expect(() => planSetAside(dir, '../x', T0)).toThrow('set-aside: bad_link_id');
  });

  it('refuses when linkundo or an item would be on another volume (a move must never become a copy)', () => {
    makeStore('old');
    const other = (p: string): number => (p.includes('assets') ? 2 : 1);
    expect(() => planSetAside(dir, LINK, T0, { devOf: other })).toThrow('set-aside: other_volume');
    const otherUndo = (p: string): number => (p.endsWith('linkundo') ? 2 : 1);
    mkdirSync(join(dir, 'linkundo'));
    expect(() => planSetAside(dir, LINK, T0, { devOf: otherUndo })).toThrow('set-aside: other_volume');
    expect(readJournal(dir)).toBeNull();
    planSetAside(dir, LINK, T0, { devOf: () => 7 });
    expect(readJournal(dir)?.linkId).toBe(LINK);
  });
});

describe('set-aside: at the next start', () => {
  it('moves the store into linkundo/<linkId> and leaves what must stay; a fresh store opens empty', () => {
    makeStore('old');
    planSetAside(dir, LINK, T0, { release: '2026.11.15', dbLevel: 29 });
    expect(applyLinkJournalAtBoot(dir)).toBe('set-aside');
    expect(readJournal(dir)).toBeNull();
    for (const rel of ['surau.db', 'assets', 'finance/photos', 'themes', 'secret/sync.key', 'secret/youtube-token.json', 'secret/live-camera.json']) {
      expect(existsSync(join(dir, rel))).toBe(false);
      expect(existsSync(join(dir, 'linkundo', LINK, rel))).toBe(true);
    }
    for (const rel of STAYS) expect(existsSync(join(dir, rel))).toBe(true);
    expect(rows()).toEqual([]);
  });

  it('writes a manifest with the exact sizes, hashes, release, database level and the commit point', () => {
    makeStore('old');
    planSetAside(dir, LINK, T0, { release: '2026.11.15', dbLevel: 29 });
    applyLinkJournalAtBoot(dir);
    const m = backupOf(dir, LINK);
    expect(m).not.toBeNull();
    expect(m).toMatchObject({ v: 1, kind: 'set-aside', linkId: LINK, at: T0.toISOString(), release: '2026.11.15', dbLevel: 29 });
    const png = m!.files.find((f) => f.path === 'assets/a.png');
    expect(png).toEqual({ path: 'assets/a.png', size: Buffer.byteLength('old-picture'), sha256: createHash('sha256').update('old-picture').digest('hex') });
    for (const f of m!.files) {
      const body = readFileSync(join(dir, 'linkundo', LINK, f.path));
      expect(f.size).toBe(body.length);
      expect(f.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    }
    expect(m!.bytes).toBe(m!.files.reduce((n, f) => n + f.size, 0));
    expect(m!.files.map((f) => f.path)).not.toContain('manifest.json');
    expect(listBackups(dir).map((b) => b.folder)).toEqual([LINK]);
  });

  it('lists a file above the hash cap with sha256 null (start-up on a T95 is not held for minutes)', () => {
    makeStore('old');
    planSetAside(dir, LINK, T0);
    applyLinkJournalAtBoot(dir, { hashFileCap: 8 });
    const m = backupOf(dir, LINK)!;
    const big = m.files.find((f) => f.path === 'assets/video/v.mp4')!;
    expect(big.size).toBe(Buffer.byteLength('old-video'));
    expect(big.sha256).toBeNull();
    expect(m.files.find((f) => f.path === 'secret/box.key')).toBeUndefined();
    const small = m.files.find((f) => f.path === 'secret/youtube-token.json')!;
    expect(small.sha256).toBe(createHash('sha256').update('old-yt').digest('hex'));
  });

  it('drops the plan when there is no follow record: nothing moves', () => {
    makeStore('old');
    rmSync(join(dir, 'secret/follow.json'));
    const before = tree();
    planSetAside(dir, LINK, T0);
    expect(applyLinkJournalAtBoot(dir)).toBe('dropped');
    expect(readJournal(dir)).toBeNull();
    expect(tree()).toEqual(before);
    expect(existsSync(join(dir, 'linkundo'))).toBe(false);
  });

  it('does nothing without a journal', () => {
    makeStore('old');
    const before = tree();
    expect(applyLinkJournalAtBoot(dir)).toBe('none');
    expect(tree()).toEqual(before);
  });

  it('keeps an unreadable journal aside and starts with the store as it is', () => {
    makeStore('old');
    writeFileSync(join(dir, 'link.json'), '{not json');
    expect(applyLinkJournalAtBoot(dir)).toBe('unreadable');
    expect(existsSync(join(dir, 'link.json'))).toBe(false);
    expect(existsSync(join(dir, 'link.json.bad'))).toBe(true);
    expect(rows()).toEqual(['old']);
  });

  it('a power cut at every step, then another start: always fully new, never between', () => {
    makeStore('old');
    planSetAside(dir, LINK, T0, { release: '2026.11.15', dbLevel: 29 });
    applyLinkJournalAtBoot(dir);
    const golden = tree();
    rmSync(dir, { recursive: true, force: true });

    dir = mkdtempSync(join(tmpdir(), 'maxcom-set-aside-'));
    makeStore('old');
    const start = tree();
    planSetAside(dir, LINK, T0, { release: '2026.11.15', dbLevel: 29 });
    const names = stepsOf((afterStep) => applyLinkJournalAtBoot(dir, { afterStep }));
    expect(names.length).toBeGreaterThan(8);
    expect(names).toContain('set-aside:moved:surau.db');
    expect(names).toContain('set-aside:manifest');
    expect(tree()).toEqual(golden);

    for (const name of names) {
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), 'maxcom-set-aside-'));
      makeStore('old');
      expect(tree()).toEqual(start);
      planSetAside(dir, LINK, T0, { release: '2026.11.15', dbLevel: 29 });
      killAt(name, (afterStep) => applyLinkJournalAtBoot(dir, { afterStep }));
      expect(applyLinkJournalAtBoot(dir)).toBe(name === 'set-aside:cleared' ? 'none' : 'set-aside');
      expect(readJournal(dir)).toBeNull();
      expect(tree(), `after a cut at ${name}`).toEqual(golden);
    }
  });

  it('a start after the move finished does nothing more', () => {
    makeStore('old');
    planSetAside(dir, LINK, T0);
    applyLinkJournalAtBoot(dir);
    const done = tree();
    expect(applyLinkJournalAtBoot(dir)).toBe('none');
    expect(tree()).toEqual(done);
  });
});

describe('restore of a set-aside backup', () => {
  /** link day: old store set aside, a fresh store opened and used for a while */
  function linked(): void {
    makeStore('old');
    planSetAside(dir, LINK, T0, { release: '2026.11.15', dbLevel: 29 });
    applyLinkJournalAtBoot(dir);
    const db = openDb(join(dir, 'surau.db'));
    db.exec('CREATE TABLE probe (x TEXT)');
    db.prepare('INSERT INTO probe (x) VALUES (?)').run('mirror');
    db.close();
    put('assets/new.png', 'mirror-picture');
    put('secret/follow.json', 'FOLLOW');
  }

  it('refuses without a backup for that link', () => {
    makeStore('old');
    expect(() => planRestore(dir, LINK, T0)).toThrow('restore: no_backup');
    expect(readJournal(dir)).toBeNull();
  });

  it('refuses when the data kept at an earlier unlink is still there', () => {
    linked();
    mkdirSync(join(dir, 'linkundo', `${LINK}-at-unlink`), { recursive: true });
    expect(() => planRestore(dir, LINK, T0)).toThrow('restore: at_unlink_exists');
  });

  it('brings back the database with its rows, the media and the secrets; the current store is kept for 7 days', () => {
    linked();
    planRestore(dir, LINK, new Date('2026-12-01T00:00:00.000Z'), { release: '2026.12.2', dbLevel: 30 });
    expect(applyLinkJournalAtBoot(dir)).toBe('restore');
    expect(readJournal(dir)).toBeNull();
    expect(rows()).toEqual(['old']);
    expect(readFileSync(join(dir, 'assets/a.png'), 'utf8')).toBe('old-picture');
    expect(existsSync(join(dir, 'assets/new.png'))).toBe(false);
    expect(readFileSync(join(dir, 'secret/youtube-token.json'), 'utf8')).toBe('old-yt');
    // the box runs alone again
    expect(existsSync(join(dir, 'secret/follow.json'))).toBe(false);
    for (const rel of STAYS.filter((s) => s !== 'secret/follow.json')) expect(existsSync(join(dir, rel))).toBe(true);
    // the backup is used up; the mirror store is kept aside with its own manifest
    expect(existsSync(join(dir, 'linkundo', LINK))).toBe(false);
    const kept = listBackups(dir);
    expect(kept.map((b) => b.folder)).toEqual([`${LINK}-at-unlink`]);
    expect(kept[0]!.atUnlink).toBe(true);
    expect(kept[0]!.manifest).toMatchObject({ kind: 'at-unlink', linkId: LINK, at: '2026-12-01T00:00:00.000Z', release: '2026.12.2', dbLevel: 30 });
    expect(readFileSync(join(dir, 'linkundo', `${LINK}-at-unlink`, 'assets/new.png'), 'utf8')).toBe('mirror-picture');
    const db = openDb(join(dir, 'linkundo', `${LINK}-at-unlink`, 'surau.db'));
    expect((db.prepare('SELECT x FROM probe').all() as Array<{ x: string }>).map((r) => r.x)).toEqual(['mirror']);
    db.close();
  });

  it('works after the clock moved 200 days: nothing in a restore depends on the date', () => {
    linked();
    planRestore(dir, LINK, new Date(T0.getTime() + 200 * 86_400_000));
    expect(applyLinkJournalAtBoot(dir)).toBe('restore');
    expect(rows()).toEqual(['old']);
    expect(listBackups(dir)[0]!.manifest.at).toBe(new Date(T0.getTime() + 200 * 86_400_000).toISOString());
  });

  it('drops the plan when the backup vanished before the start', () => {
    linked();
    planRestore(dir, LINK, T0);
    rmSync(join(dir, 'linkundo', LINK), { recursive: true });
    const before = tree().filter((t) => !t.startsWith('link.json'));
    expect(applyLinkJournalAtBoot(dir)).toBe('dropped');
    expect(tree()).toEqual(before);
  });

  it('a power cut at every step, then another start: always fully new, never between', () => {
    linked();
    const start = tree();
    planRestore(dir, LINK, new Date('2026-12-01T00:00:00.000Z'), { release: '2026.12.2', dbLevel: 30 });
    applyLinkJournalAtBoot(dir);
    const golden = tree();
    expect(golden).not.toEqual(start);

    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'maxcom-set-aside-'));
    linked();
    // the database files of the mirror differ by run, so compare the shape and the rows, not raw bytes of surau.db
    const shape = (): string[] => tree().filter((t) => !t.includes('surau.db'));
    const goldenShape = golden.filter((t) => !t.includes('surau.db'));
    planRestore(dir, LINK, new Date('2026-12-01T00:00:00.000Z'), { release: '2026.12.2', dbLevel: 30 });
    const names = stepsOf((afterStep) => applyLinkJournalAtBoot(dir, { afterStep }));
    expect(names).toContain('restore:aside:surau.db');
    expect(names).toContain('restore:back:surau.db');
    expect(names).toContain('restore:follow-removed');
    expect(shape()).toEqual(goldenShape);

    for (const name of names) {
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), 'maxcom-set-aside-'));
      linked();
      planRestore(dir, LINK, new Date('2026-12-01T00:00:00.000Z'), { release: '2026.12.2', dbLevel: 30 });
      killAt(name, (afterStep) => applyLinkJournalAtBoot(dir, { afterStep }));
      expect(applyLinkJournalAtBoot(dir)).toBe(name === 'restore:cleared' ? 'none' : 'restore');
      expect(readJournal(dir)).toBeNull();
      expect(shape(), `after a cut at ${name}`).toEqual(goldenShape);
      expect(rows(), `after a cut at ${name}`).toEqual(['old']);
      expect(existsSync(join(dir, 'secret/follow.json'))).toBe(false);
    }
  });

  it('a plan for a drop-at-unlink removes the kept data and ends', () => {
    linked();
    planRestore(dir, LINK, T0);
    applyLinkJournalAtBoot(dir);
    expect(existsSync(join(dir, 'linkundo', `${LINK}-at-unlink`))).toBe(true);
    writeJournal(dir, { v: 1, op: 'drop-at-unlink', linkId: LINK, step: 'planned', at: T0.toISOString() });
    expect(applyLinkJournalAtBoot(dir)).toBe('drop-at-unlink');
    expect(existsSync(join(dir, 'linkundo', `${LINK}-at-unlink`))).toBe(false);
    expect(readJournal(dir)).toBeNull();
  });
});

describe('forget', () => {
  /** A follower box: a store, backups, the mirror's copy and a staging area, plus the follow record. */
  function follower(): void {
    makeStore('mirror');
    put('live/youtube-open.json', '{}');
    put('secret/sync.claim', 'claim');
    put('secret/youtube-state.json', '{}');
    put('import/sheet.xlsx', 'sheet');
    put('linkundo/old-link/manifest.json', '{}');
    put('linkundo/old-link/assets/a.png', 'old');
    put('follow/bundle.json', '{}');
    put('follow/files/x.bin', 'x');
    put('linkstage/s.bin', 's');
  }

  const GONE = [
    'surau.db', 'assets', 'finance/photos', 'themes', 'import', 'secret/sync.key', 'secret/sync.claim', 'secret/youtube-token.json',
    'secret/youtube-state.json', 'live/youtube-open.json', 'secret/live-camera.json', 'linkundo', 'follow', 'linkstage', 'secret/follow.json', 'link.json',
  ];
  const KEPT = ['secret/box.key', 'secret/identity.key', 'box.json', 'pki/root-ca.cer', 'logs/x.log'];

  it('writes a journal with op forget and moves nothing', () => {
    follower();
    const before = tree();
    planForget(dir, LINK, T0);
    expect(readJournal(dir)).toMatchObject({ v: 1, op: 'forget', linkId: LINK, step: 'planned', at: T0.toISOString() });
    expect(tree().filter((t) => !t.startsWith('link.json'))).toEqual(before.filter((t) => !t.startsWith('link.json')));
  });

  it('at the next start wipes the store, the backups, the mirror and the follow record, and keeps the keys, pki and box.json', () => {
    follower();
    planForget(dir, LINK, T0);
    expect(applyLinkJournalAtBoot(dir)).toBe('forget');
    for (const rel of GONE) expect(existsSync(join(dir, rel)), rel).toBe(false);
    for (const rel of KEPT) expect(existsSync(join(dir, rel)), rel).toBe(true);
    expect(readFileSync(join(dir, 'secret/box.key'), 'utf8')).toBe('BOXKEY');
    expect(readFileSync(join(dir, 'secret/identity.key'), 'utf8')).toBe('IDKEY');
    expect(readJournal(dir)).toBeNull();
    // a second start has nothing left to do
    expect(applyLinkJournalAtBoot(dir)).toBe('none');
  });

  it('no follow record at the start: the plan is dropped and every file is still there', () => {
    follower();
    rmSync(join(dir, 'secret/follow.json'));
    const before = tree();
    planForget(dir, LINK, T0);
    expect(applyLinkJournalAtBoot(dir)).toBe('dropped');
    expect(readJournal(dir)).toBeNull();
    expect(tree()).toEqual(before);
    expect(rows()).toEqual(['mirror']);
  });

  it('a power cut at every step, then another start: the same tree as an uninterrupted run', () => {
    follower();
    planForget(dir, LINK, T0);
    applyLinkJournalAtBoot(dir);
    const golden = tree();
    rmSync(dir, { recursive: true, force: true });

    dir = mkdtempSync(join(tmpdir(), 'maxcom-set-aside-'));
    follower();
    planForget(dir, LINK, T0);
    const names = stepsOf((afterStep) => applyLinkJournalAtBoot(dir, { afterStep }));
    expect(names).toEqual([
      'forget:start',
      ...['surau.db', 'surau.db-wal', 'surau.db-shm', 'assets', 'finance/photos', 'themes', 'import', 'secret/sync.key', 'secret/sync.claim', 'secret/youtube-token.json', 'secret/youtube-state.json', 'live/youtube-open.json', 'secret/live-camera.json'].map((r) => `forget:${r}`),
      'forget:backups', 'forget:mirror', 'forget:follow-removed', 'forget:cleared',
    ]);
    expect(tree()).toEqual(golden);

    for (const name of names) {
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), 'maxcom-set-aside-'));
      follower();
      planForget(dir, LINK, T0);
      killAt(name, (afterStep) => applyLinkJournalAtBoot(dir, { afterStep }));
      // after the follow record is gone the leftover journal is dropped; after the clear there is none
      const expected = name === 'forget:cleared' ? 'none' : name === 'forget:follow-removed' ? 'dropped' : 'forget';
      expect(applyLinkJournalAtBoot(dir), `second start after a cut at ${name}`).toBe(expected);
      expect(readJournal(dir)).toBeNull();
      expect(tree(), `after a cut at ${name}`).toEqual(golden);
    }
  });

  it('refuses a link id that is not a plain name, and an open journal', () => {
    follower();
    expect(() => planForget(dir, '../x', T0)).toThrow('forget: bad_link_id');
    expect(() => planForget(dir, '', T0)).toThrow('forget: bad_link_id');
    expect(readJournal(dir)).toBeNull();
    planSetAside(dir, 'b'.repeat(32), T0);
    expect(() => planForget(dir, LINK, T0)).toThrow('forget: journal_open');
    expect(readJournal(dir)?.op).toBe('set-aside');
  });

  it('an unknown op in link.json is still unreadable: kept aside, nothing deleted', () => {
    follower();
    const before = tree();
    writeFileSync(join(dir, 'link.json'), JSON.stringify({ v: 1, op: 'wipe', linkId: LINK, step: 'planned', at: T0.toISOString() }));
    expect(applyLinkJournalAtBoot(dir)).toBe('unreadable');
    expect(existsSync(join(dir, 'link.json.bad'))).toBe(true);
    expect(existsSync(join(dir, 'link.json'))).toBe(false);
    expect(tree().filter((t) => !t.startsWith('link.json'))).toEqual(before);
  });
});

describe('journal', () => {
  it('writes atomically and reads back; a clear removes it', () => {
    writeJournal(dir, { v: 1, op: 'restore', linkId: LINK, step: 'planned', at: T0.toISOString(), done: ['a'] });
    expect(readJournal(dir)).toEqual({ v: 1, op: 'restore', linkId: LINK, step: 'planned', at: T0.toISOString(), done: ['a'] });
    expect(existsSync(join(dir, 'link.json.tmp'))).toBe(false);
    clearJournal(dir);
    expect(readJournal(dir)).toBeNull();
  });

  it('refuses a file that is not a journal', () => {
    writeFileSync(join(dir, 'link.json'), JSON.stringify({ v: 1, op: 'format', linkId: LINK, step: 'x', at: 'y' }));
    expect(() => readJournal(dir)).toThrow('journal: unreadable');
    writeFileSync(join(dir, 'link.json'), JSON.stringify({ v: 1, op: 'restore', linkId: '../..', step: 'x', at: 'y' }));
    expect(() => readJournal(dir)).toThrow('journal: unreadable');
  });
});
