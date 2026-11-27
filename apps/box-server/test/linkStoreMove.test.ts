import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMoveList, createStoreGrant, hashFile, pageOfList, pagesOf, parseMoveList, pullStore, rangeStart, stageDirOf, StoreMoveError, sweepStage,
} from '../src/link/storeMove.ts';
import type { MoveList } from '../src/link/storeMove.ts';
import { startGiver } from './support/storeGiver.ts';
import type { Giver } from './support/storeGiver.ts';

/**
 * The store move (`link/storeMove.ts`): the giver's list and read grant, the receiver's resumable pull. Real temp
 * folders, a real database, a real local http server for the pull.
 */

const LINK = 'a1'.repeat(16);
const OTHER = 'b2'.repeat(16);
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

const dirs: string[] = [];
const givers: Giver[] = [];
afterEach(async () => {
  for (const g of givers.splice(0)) await g.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'maxcom-store-move-'));
  dirs.push(d);
  return d;
};
const put = (root: string, rel: string, data: Buffer | string): void => {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
};

function openRealDb(dir: string): DatabaseSync {
  const db = new DatabaseSync(join(dir, 'surau.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  db.prepare('INSERT INTO people (name) VALUES (?)').run('Ruang Muslimat');
  db.prepare('INSERT INTO people (name) VALUES (?)').run('Dewan Utama');
  return db;
}

/** A giver data folder with every kind of file: moved media, scratch, secrets, live state. */
function giverFolder(): { dir: string; db: DatabaseSync } {
  const dir = tempDir();
  const db = openRealDb(dir);
  put(dir, 'assets/poster-1.jpg', Buffer.from('poster one bytes'));
  put(dir, 'assets/sub/video-1.mp4', Buffer.alloc(5000, 7));
  put(dir, 'finance/photos/receipt-1.jpg', Buffer.from('receipt'));
  put(dir, 'themes/hijau/theme.json', '{"name":"Hijau"}');
  put(dir, 'import/scratch.zip', Buffer.from('scratch'));
  put(dir, 'secret/sync.key', Buffer.from('cloud key'));
  put(dir, 'secret/box.key', Buffer.from('box key'));
  put(dir, 'secret/live-camera.json', Buffer.from('{}'));
  put(dir, 'live/youtube-open.json', Buffer.from('{}'));
  put(dir, 'linkundo/old/file.txt', Buffer.from('old'));
  return { dir, db };
}

const build = (dir: string, db: DatabaseSync, linkId = LINK): Promise<MoveList> => buildMoveList({ dataDir: dir, db, linkId, dbLevel: 29, release: '2026.11.15' });

describe('buildMoveList', () => {
  it('lists a consistent database copy plus the files of the moved media folders, with right size and sha256', async () => {
    const { dir, db } = giverFolder();
    const list = await build(dir, db);
    expect(list.linkId).toBe(LINK);
    expect(list.dbLevel).toBe(29);
    expect(list.release).toBe('2026.11.15');
    expect(list.files.map((f) => f.path).sort()).toEqual([
      'assets/poster-1.jpg', 'assets/sub/video-1.mp4', 'finance/photos/receipt-1.jpg', 'surau.db', 'themes/hijau/theme.json',
    ]);
    const poster = list.files.find((f) => f.path === 'assets/poster-1.jpg')!;
    expect(poster.size).toBe(16);
    expect(poster.sha256).toBe(sha('poster one bytes'));
    const video = list.files.find((f) => f.path === 'assets/sub/video-1.mp4')!;
    expect(video).toEqual({ path: 'assets/sub/video-1.mp4', size: 5000, sha256: sha(Buffer.alloc(5000, 7)) });
    expect(list.bytes).toBe(list.files.reduce((n, f) => n + f.size, 0));

    // the database entry is a VACUUM copy in the out folder: it opens and holds the same rows, and it is what was hashed
    const copy = join(dir, 'linkstage-out', LINK, 'surau.db');
    const dbEntry = list.files.find((f) => f.path === 'surau.db')!;
    expect(dbEntry.sha256).toBe((await hashFile(copy)).sha256);
    expect(dbEntry.size).toBe(readFileSync(copy).length);
    const open = new DatabaseSync(copy, { readOnly: true });
    expect(open.prepare('SELECT name FROM people ORDER BY id').all().map((r) => r.name)).toEqual(['Ruang Muslimat', 'Dewan Utama']);
    open.close();
    db.close();
  });

  it('never lists import/, secret/*, live/* or anything else outside the moved folders', async () => {
    const { dir, db } = giverFolder();
    const list = await build(dir, db);
    for (const f of list.files) {
      expect(f.path).not.toMatch(/^(import|secret|live|linkundo|linkstage|linkstage-out)\//);
      expect(f.path === 'surau.db' || /^(assets|finance\/photos|themes)\//.test(f.path)).toBe(true);
    }
    expect(list.files.some((f) => f.path.includes('box.key') || f.path.includes('sync.key') || f.path.includes('camera'))).toBe(false);
    db.close();
  });

  it('a second call replaces the old copy (and a stale file in the out folder does not stay)', async () => {
    const { dir, db } = giverFolder();
    const first = await build(dir, db);
    put(dir, `linkstage-out/${LINK}/leftover.txt`, 'x');
    db.prepare('INSERT INTO people (name) VALUES (?)').run('Tambahan');
    const second = await build(dir, db);
    expect(readdirSync(join(dir, 'linkstage-out', LINK))).toEqual(['surau.db']);
    expect(second.files.find((f) => f.path === 'surau.db')!.sha256).not.toBe(first.files.find((f) => f.path === 'surau.db')!.sha256);
    const open = new DatabaseSync(join(dir, 'linkstage-out', LINK, 'surau.db'), { readOnly: true });
    expect(Number(open.prepare('SELECT COUNT(*) AS n FROM people').get()!.n)).toBe(3);
    open.close();
    db.close();
  });

  it('a bad link id is refused before anything is written', async () => {
    const { dir, db } = giverFolder();
    await expect(build(dir, db, '../x')).rejects.toMatchObject({ code: 'bad_list' });
    await expect(build(dir, db, 'A'.repeat(32))).rejects.toMatchObject({ code: 'bad_list' });
    expect(existsSync(join(dir, 'linkstage-out'))).toBe(false);
    db.close();
  });

  it('10,001 entries (past the old limit of one answer) are listed whole; the pages are cut from that one list', async () => {
    const { dir, db } = giverFolder();
    const base = join(dir, 'assets', 'many');
    mkdirSync(base, { recursive: true });
    for (let i = 0; i < 10_000; i++) writeFileSync(join(base, `f${i}.bin`), '');
    // the 10,000 files, the folder's own few and the database copy: six pages of at most 2,000
    const l = await build(dir, db);
    expect(l.files.length).toBeGreaterThan(10_000);
    expect(pagesOf(l.files.length)).toBe(6);
    expect(pageOfList(l, 5)!.files).toHaveLength(l.files.length - 10_000);
    db.close();
  }, 120_000);
});

describe('parseMoveList', () => {
  const entry = (path: string, over: Record<string, unknown> = {}) => ({ path, size: 10, sha256: 'a'.repeat(64), ...over });
  const list = (files: unknown[], over: Record<string, unknown> = {}) => ({ linkId: LINK, dbLevel: 29, release: '2026.11.15', files, ...over });
  const base = (): unknown[] => [entry('surau.db'), entry('assets/a.jpg')];
  const refuses = (v: unknown): void => {
    expect(() => parseMoveList(v, LINK)).toThrowError(StoreMoveError);
    try {
      parseMoveList(v, LINK);
    } catch (e) {
      expect((e as StoreMoveError).code).toBe('bad_list');
    }
  };

  it('accepts a good list and sums the bytes', () => {
    const l = parseMoveList(list([entry('surau.db', { size: 5 }), entry('assets/a.jpg'), entry('finance/photos/x.jpg', { size: 0 }), entry('themes/t/theme.json')]), LINK);
    expect(l.bytes).toBe(25);
    expect(l.files.map((f) => f.path)).toEqual(['surau.db', 'assets/a.jpg', 'finance/photos/x.jpg', 'themes/t/theme.json']);
  });

  it('refuses a wrong link id, a non-object, no files, no database, a bad level or release', () => {
    refuses(list(base(), { linkId: OTHER }));
    refuses(null);
    refuses('x');
    refuses(list([]));
    refuses(list([entry('assets/a.jpg')]));
    refuses(list(base(), { dbLevel: 1.5 }));
    refuses(list(base(), { dbLevel: '29' }));
    refuses(list(base(), { release: 5 }));
    refuses({ linkId: LINK, dbLevel: 29, release: 'r', files: 'nope' });
  });

  it('refuses a path outside the moved folders', () => {
    for (const p of ['import/scratch.zip', 'secret/box.key', 'secret/sync.key', 'live/youtube-open.json', 'surau.db-wal', 'surau.db-shm', 'SURAU.DB', 'identity.key', 'assets', 'assetsx/a.jpg', 'finance/receipt.jpg', 'linkstage/x/surau.db', 'follow.json']) {
      refuses(list([entry('surau.db'), entry(p)]));
    }
  });

  it('refuses .. segments, absolute paths, backslashes, drive letters, NUL and over-long paths', () => {
    for (const p of [
      'assets/../secret/box.key', '../assets/a.jpg', 'assets/..', 'assets/./a.jpg', '/assets/a.jpg', '/etc/passwd', 'assets\\a.jpg',
      'assets/..\\..\\x', 'C:/assets/a.jpg', 'C:\\Windows\\x', 'assets/C:/x', 'assets/a.jpg:stream', 'assets/a\0.jpg', `assets/${'x'.repeat(400)}`, '',
    ]) {
      refuses(list([entry('surau.db'), entry(p)]));
    }
    expect(() => parseMoveList(list([entry('surau.db'), entry('..')]), LINK)).toThrowError(StoreMoveError);
  });

  it('refuses a non-string path and a non-object entry', () => {
    refuses(list([entry('surau.db'), { size: 1, sha256: 'a'.repeat(64) }]));
    refuses(list([entry('surau.db'), entry('assets/a.jpg', { path: 5 })]));
    refuses(list([entry('surau.db'), 'assets/a.jpg']));
    refuses(list([entry('surau.db'), null]));
  });

  it('refuses duplicate paths, also differing only by case', () => {
    refuses(list([entry('surau.db'), entry('assets/a.jpg'), entry('assets/a.jpg')]));
    refuses(list([entry('surau.db'), entry('assets/a.jpg'), entry('assets/A.JPG')]));
    refuses(list([entry('surau.db'), entry('surau.db')]));
  });

  it('refuses a bad sha256 and a negative, fractional, huge or non-number size', () => {
    for (const sha256 of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), '', 5, null]) refuses(list([entry('surau.db'), entry('assets/a.jpg', { sha256 })]));
    for (const size of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, '10', null]) refuses(list([entry('surau.db'), entry('assets/a.jpg', { size })]));
  });

  it('refuses more than 100,000 entries', () => {
    const many = [entry('surau.db'), ...Array.from({ length: 100_000 }, (_, i) => entry(`assets/f${i}.bin`))];
    refuses(list(many));
    // exactly 100,000 is allowed
    expect(parseMoveList(list(many.slice(0, 100_000)), LINK).files).toHaveLength(100_000);
  });

  it('refuses an empty path segment (assets//a.jpg)', () => {
    refuses(list([entry('surau.db'), entry('assets//a.jpg')]));
  });
  it('refuses a trailing slash (assets/a/)', () => {
    refuses(list([entry('surau.db'), entry('assets/a/')]));
  });
});

// ---------------------------------------------------------------- the pull

interface Receiver {
  dir: string;
  stage: string;
  list: MoveList;
  files: Map<string, Buffer>;
}

/** A list over some files; the first is the database entry (any bytes: the pull does not open it). */
function receiverFor(files: Record<string, Buffer>): Receiver {
  const dir = tempDir();
  const map = new Map(Object.entries(files));
  const list: MoveList = {
    linkId: LINK, dbLevel: 29, release: '2026.11.15',
    files: [...map].map(([path, b]) => ({ path, size: b.length, sha256: sha(b) })),
    bytes: [...map.values()].reduce((n, b) => n + b.length, 0),
  };
  return { dir, stage: stageDirOf(dir, LINK), list, files: map };
}

const noSleep = (): Promise<void> => Promise.resolve();
const payload = (n: number, seed: number): Buffer => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251));
const left = (stage: string): string[] => {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(stage, '');
  return out.sort();
};

async function setup(files: Record<string, Buffer>): Promise<{ rx: Receiver; giver: Giver }> {
  const rx = receiverFor(files);
  const giver = await startGiver(rx.files);
  givers.push(giver);
  return { rx, giver };
}

const pull = (rx: Receiver, giver: Giver, over: Partial<Parameters<typeof pullStore>[0]> = {}): Promise<void> =>
  pullStore({ list: rx.list, stageDir: rx.stage, fetch: (p, s) => giver.fetch(p, s), freeBytes: () => null, floorBytes: 0, sleep: noSleep, ...over });

describe('pullStore', () => {
  it('pulls every file into the stage with the right bytes; progress ends at the total', async () => {
    const { rx, giver } = await setup({ 'surau.db': payload(3000, 1), 'assets/a.jpg': payload(200_000, 2), 'themes/t/theme.json': Buffer.from('{}') });
    const seen: [number, number][] = [];
    await pull(rx, giver, { onProgress: (d, t) => seen.push([d, t]) });
    for (const [p, b] of rx.files) expect(readFileSync(join(rx.stage, ...p.split('/'))).equals(b)).toBe(true);
    expect(left(rx.stage).some((p) => p.endsWith('.part'))).toBe(false);
    expect(seen[0]).toEqual([0, rx.list.bytes]);
    expect(seen[seen.length - 1]).toEqual([rx.list.bytes, rx.list.bytes]);
    for (const [d, t] of seen) {
      expect(d).toBeLessThanOrEqual(t);
      expect(t).toBe(rx.list.bytes);
    }
  });

  it('lands a zero-byte listed file (an empty asset must not stop the move)', async () => {
    const { rx, giver } = await setup({ 'surau.db': payload(100, 1), 'assets/empty.bin': Buffer.alloc(0) });
    await pull(rx, giver);
    expect(readFileSync(join(rx.stage, 'assets', 'empty.bin')).length).toBe(0);
  });

  it('pullResumesAfterDrop: cut mid-file twice, resumes with Range from the right byte and ends with the right hash', async () => {
    const { rx, giver } = await setup({ 'surau.db': payload(100, 1), 'assets/big.mp4': payload(400_000, 9) });
    giver.behave = (r, n) => (r.path === 'assets/big.mp4' && n < 2 ? { kind: 'cut', after: 150_000 } : undefined);
    await pull(rx, giver);
    const mine = giver.requests.filter((r) => r.path === 'assets/big.mp4');
    expect(mine).toHaveLength(3);
    expect(mine[0]!.range).toBeNull();
    // each retry asks from where the stored part ends: after a cut that is more than zero and no more than what was sent
    const starts = mine.slice(1).map((r) => Number(/^bytes=(\d+)-$/.exec(r.range ?? '')![1]));
    expect(starts[0]).toBeGreaterThan(0);
    expect(starts[0]).toBeLessThanOrEqual(150_000);
    expect(starts[1]).toBeGreaterThanOrEqual(starts[0]!);
    expect(starts[1]).toBeLessThanOrEqual(300_000);
    const got = readFileSync(join(rx.stage, 'assets', 'big.mp4'));
    expect(got.equals(rx.files.get('assets/big.mp4')!)).toBe(true);
    expect(sha(got)).toBe(rx.list.files[1]!.sha256);
    expect(existsSync(join(rx.stage, 'assets', 'big.mp4.part'))).toBe(false);
  });

  it('resumes from a .part left by an earlier run, asking only for the rest', async () => {
    const { rx, giver } = await setup({ 'surau.db': payload(100, 1), 'assets/a.bin': payload(50_000, 3) });
    const whole = rx.files.get('assets/a.bin')!;
    put(rx.stage, 'assets/a.bin.part', whole.subarray(0, 20_000));
    await pull(rx, giver);
    expect(giver.requests.find((r) => r.path === 'assets/a.bin')!.range).toBe('bytes=20000-');
    expect(readFileSync(join(rx.stage, 'assets', 'a.bin')).equals(whole)).toBe(true);
  });

  it('pullRefusesHashMismatch: wrong bytes give hash, no file in place, no .part left', async () => {
    const { rx, giver } = await setup({ 'surau.db': payload(100, 1), 'assets/a.jpg': payload(5000, 4) });
    giver.behave = (r) => (r.path === 'assets/a.jpg' ? { kind: 'bytes', body: payload(5000, 99) } : undefined);
    await expect(pull(rx, giver)).rejects.toMatchObject({ code: 'hash', detail: { path: 'assets/a.jpg' } });
    expect(existsSync(join(rx.stage, 'assets', 'a.jpg'))).toBe(false);
    expect(existsSync(join(rx.stage, 'assets', 'a.jpg.part'))).toBe(false);
  });

  it('a file shorter than listed (the giver ended early with a clean answer) gives hash, nothing left', async () => {
    const { rx, giver } = await setup({ 'surau.db': payload(100, 1), 'assets/a.jpg': payload(5000, 4) });
    giver.behave = (r) => (r.path === 'assets/a.jpg' ? { kind: 'bytes', body: payload(4000, 4) } : undefined);
    await expect(pull(rx, giver)).rejects.toBeInstanceOf(StoreMoveError);
    expect(existsSync(join(rx.stage, 'assets', 'a.jpg'))).toBe(false);
  });

  it('pullRefusesTooSmallBeforeAnyByte: no_space with needBytes, and the giver saw no request', async () => {
    const { rx, giver } = await setup({ 'surau.db': payload(1000, 1), 'assets/a.jpg': payload(9000, 4) });
    const err = await pull(rx, giver, { freeBytes: () => 5000, floorBytes: 2000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreMoveError);
    expect((err as StoreMoveError).code).toBe('no_space');
    expect((err as StoreMoveError).detail).toEqual({ needBytes: 12_000, freeBytes: 5000 });
    expect(giver.requests).toHaveLength(0);
    expect(left(rx.stage)).toEqual([]);
  });

  it('the space check counts bytes already staged and parts already stored; exactly enough passes', async () => {
    const { rx, giver } = await setup({ 'surau.db': payload(1000, 1), 'assets/a.bin': payload(9000, 4) });
    put(rx.stage, 'assets/a.bin.part', rx.files.get('assets/a.bin')!.subarray(0, 4000));
    // still to come: 1000 + 5000 = 6000; with a floor of 500, 6500 free is exactly enough
    await pull(rx, giver, { freeBytes: () => 6500, floorBytes: 500 });
    expect(readFileSync(join(rx.stage, 'assets', 'a.bin')).equals(rx.files.get('assets/a.bin')!)).toBe(true);
    const { rx: rx2, giver: g2 } = await setup({ 'surau.db': payload(1000, 1), 'assets/a.bin': payload(9000, 4) });
    await expect(pull(rx2, g2, { freeBytes: () => 10_499, floorBytes: 500 })).rejects.toMatchObject({ code: 'no_space' });
    expect(g2.requests).toHaveLength(0);
  });

  it('an unknown free space (null) does not stop the pull', async () => {
    const { rx, giver } = await setup({ 'surau.db': payload(100, 1) });
    await pull(rx, giver, { freeBytes: () => null, floorBytes: 10 ** 12 });
    expect(existsSync(join(rx.stage, 'surau.db'))).toBe(true);
  });

  it('pullRejectsWrongContentRange: a 206 from another offset is not appended; the part stays as it was', async () => {
    const { rx, giver } = await setup({ 'surau.db': payload(100, 1), 'assets/a.bin': payload(30_000, 5) });
    const whole = rx.files.get('assets/a.bin')!;
    put(rx.stage, 'assets/a.bin.part', whole.subarray(0, 10_000));
    giver.behave = (r) => (r.path === 'assets/a.bin' ? { kind: 'range', start: 0 } : undefined);
    await expect(pull(rx, giver, { retries: 2 })).rejects.toMatchObject({ code: 'peer', detail: { path: 'assets/a.bin' } });
    expect(readFileSync(join(rx.stage, 'assets', 'a.bin.part')).length).toBe(10_000);
    expect(existsSync(join(rx.stage, 'assets', 'a.bin'))).toBe(false);
    expect(giver.requests.filter((r) => r.path === 'assets/a.bin')).toHaveLength(3);
  });

  it('a 200 (whole file) answer to a Range request is refused, not appended', async () => {
    const { rx, giver } = await setup({ 'surau.db': payload(100, 1), 'assets/a.bin': payload(30_000, 5) });
    put(rx.stage, 'assets/a.bin.part', rx.files.get('assets/a.bin')!.subarray(0, 10_000));
    // a giver that ignores Range: serve the file from the start with status 200
    const plain = await startGiver(new Map([['assets/a.bin', rx.files.get('assets/a.bin')!], ['surau.db', rx.files.get('surau.db')!]]));
    givers.push(plain);
    plain.fetch = (p) => giver.fetch(p, 0);
    await expect(pull(rx, plain, { retries: 1 })).rejects.toMatchObject({ code: 'peer' });
    expect(readFileSync(join(rx.stage, 'assets', 'a.bin.part')).length).toBe(10_000);
  });

  it('pullRefusesOversizedAnswer: more bytes than the size gives hash and no file in place', async () => {
    const { rx, giver } = await setup({ 'surau.db': payload(100, 1), 'assets/a.jpg': payload(5000, 4) });
    giver.behave = (r) => (r.path === 'assets/a.jpg' ? { kind: 'extra', extra: 700 } : undefined);
    await expect(pull(rx, giver)).rejects.toMatchObject({ code: 'hash' });
    expect(existsSync(join(rx.stage, 'assets', 'a.jpg'))).toBe(false);
    // the giver was asked once: an oversized answer is not retried
    expect(giver.requests.filter((r) => r.path === 'assets/a.jpg')).toHaveLength(1);
  });

  it('pullRechecksLandedFile: a staged file with the right size but wrong bytes is fetched again', async () => {
    const { rx, giver } = await setup({ 'surau.db': payload(100, 1), 'assets/a.jpg': payload(5000, 4) });
    put(rx.stage, 'assets/a.jpg', payload(5000, 77));
    put(rx.stage, 'surau.db', rx.files.get('surau.db')!);
    const seen: [number, number][] = [];
    await pull(rx, giver, { onProgress: (d, t) => seen.push([d, t]) });
    expect(giver.requests.map((r) => r.path)).toEqual(['assets/a.jpg']);
    expect(readFileSync(join(rx.stage, 'assets', 'a.jpg')).equals(rx.files.get('assets/a.jpg')!)).toBe(true);
    expect(seen[seen.length - 1]).toEqual([rx.list.bytes, rx.list.bytes]);
  });

  it('a staged file with the right size and bytes is kept without a request', async () => {
    const { rx, giver } = await setup({ 'surau.db': payload(100, 1), 'assets/a.jpg': payload(5000, 4) });
    for (const [p, b] of rx.files) put(rx.stage, p, b);
    await pull(rx, giver);
    expect(giver.requests).toHaveLength(0);
  });

  it('a .part longer than the listed size is thrown away and the file fetched from the start', async () => {
    const { rx, giver } = await setup({ 'surau.db': payload(100, 1), 'assets/a.jpg': payload(5000, 4) });
    put(rx.stage, 'assets/a.jpg.part', payload(9000, 3));
    await pull(rx, giver);
    expect(giver.requests.find((r) => r.path === 'assets/a.jpg')!.range).toBeNull();
    expect(readFileSync(join(rx.stage, 'assets', 'a.jpg')).equals(rx.files.get('assets/a.jpg')!)).toBe(true);
  });

  it('retries exhausted gives peer, naming the file', async () => {
    const { rx, giver } = await setup({ 'surau.db': payload(100, 1), 'assets/a.jpg': payload(20_000, 4) });
    giver.behave = (r) => (r.path === 'assets/a.jpg' ? { kind: 'cut', after: 1000 } : undefined);
    const slept: number[] = [];
    await expect(pull(rx, giver, { retries: 2, sleep: async (ms) => void slept.push(ms) })).rejects.toMatchObject({ code: 'peer', detail: { path: 'assets/a.jpg' } });
    expect(giver.requests.filter((r) => r.path === 'assets/a.jpg')).toHaveLength(3);
    expect(slept).toEqual([1000, 2000]);
    expect(existsSync(join(rx.stage, 'assets', 'a.jpg'))).toBe(false);
  });

  it('a giver that is not reachable at all gives peer', async () => {
    const rx = receiverFor({ 'surau.db': payload(100, 1) });
    await expect(pullStore({
      list: rx.list, stageDir: rx.stage, freeBytes: () => null, floorBytes: 0, sleep: noSleep, retries: 1,
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    })).rejects.toMatchObject({ code: 'peer' });
  });

  it('a 404 from the giver gives peer, not a file', async () => {
    const { rx, giver } = await setup({ 'surau.db': payload(100, 1) });
    rx.list.files.push({ path: 'assets/missing.jpg', size: 10, sha256: 'c'.repeat(64) });
    rx.list.bytes += 10;
    await expect(pull(rx, giver, { retries: 1 })).rejects.toMatchObject({ code: 'peer' });
    expect(existsSync(join(rx.stage, 'assets', 'missing.jpg'))).toBe(false);
  });
});

describe('createStoreGrant', () => {
  const aList = (linkId = LINK): MoveList => ({
    linkId, dbLevel: 29, release: '2026.11.15', bytes: 30,
    files: [{ path: 'surau.db', size: 10, sha256: 'a'.repeat(64) }, { path: 'assets/a.jpg', size: 20, sha256: 'b'.repeat(64) }],
  });

  it('gives the file for the right link, token and listed path; a database path points at the out folder, media at the data folder', () => {
    const dir = tempDir();
    const g = createStoreGrant(dir);
    const t = g.issue(aList());
    expect(t.length).toBeGreaterThanOrEqual(40);
    expect(g.fileFor(LINK, t, 'assets/a.jpg')).toEqual({ abs: join(dir, 'assets', 'a.jpg'), size: 20 });
    expect(g.fileFor(LINK, t, 'surau.db')).toEqual({ abs: join(dir, 'linkstage-out', LINK, 'surau.db'), size: 10 });
  });

  it('wrong token, short token, no token, other link id, unlisted path: all null', () => {
    const g = createStoreGrant(tempDir());
    const t = g.issue(aList());
    const wrong = `${t.slice(0, -1)}${t.endsWith('A') ? 'B' : 'A'}`;
    expect(g.fileFor(LINK, wrong, 'assets/a.jpg')).toBeNull();
    expect(g.fileFor(LINK, t.slice(0, 20), 'assets/a.jpg')).toBeNull();
    expect(g.fileFor(LINK, 'x'.repeat(39), 'assets/a.jpg')).toBeNull();
    expect(g.fileFor(LINK, 'x'.repeat(65), 'assets/a.jpg')).toBeNull();
    expect(g.fileFor(LINK, '', 'assets/a.jpg')).toBeNull();
    expect(g.fileFor(LINK, undefined, 'assets/a.jpg')).toBeNull();
    expect(g.fileFor(OTHER, t, 'assets/a.jpg')).toBeNull();
    for (const p of ['assets/b.jpg', '../secret/box.key', 'secret/box.key', 'import/x', 'assets\\a.jpg', '/assets/a.jpg', 'assets/../assets/a.jpg', 'ASSETS/A.JPG', '', 'surau.db-wal']) {
      expect(g.fileFor(LINK, t, p)).toBeNull();
    }
  });

  it('nothing is given before the first issue', () => {
    const g = createStoreGrant(tempDir());
    expect(g.fileFor(LINK, 'x'.repeat(43), 'assets/a.jpg')).toBeNull();
  });

  it('a second issue makes the first token useless; the new one works', () => {
    const g = createStoreGrant(tempDir());
    const t1 = g.issue(aList());
    const t2 = g.issue(aList());
    expect(t2).not.toBe(t1);
    expect(g.fileFor(LINK, t1, 'assets/a.jpg')).toBeNull();
    expect(g.fileFor(LINK, t2, 'assets/a.jpg')).not.toBeNull();
  });

  it('a list for another link replaces the grant: the old link and its token are refused', () => {
    const g = createStoreGrant(tempDir());
    const t1 = g.issue(aList());
    const t2 = g.issue(aList(OTHER));
    expect(g.fileFor(LINK, t1, 'assets/a.jpg')).toBeNull();
    expect(g.fileFor(LINK, t2, 'assets/a.jpg')).toBeNull();
    expect(g.fileFor(OTHER, t2, 'assets/a.jpg')).not.toBeNull();
  });

  it('after end() everything is null, and the database copy is gone', async () => {
    const { dir, db } = giverFolder();
    const g = createStoreGrant(dir);
    const list = await build(dir, db);
    const t = g.issue(list);
    expect(existsSync(join(dir, 'linkstage-out', LINK, 'surau.db'))).toBe(true);
    expect(g.fileFor(LINK, t, 'assets/poster-1.jpg')).not.toBeNull();
    g.end();
    expect(g.fileFor(LINK, t, 'assets/poster-1.jpg')).toBeNull();
    expect(g.fileFor(LINK, t, 'surau.db')).toBeNull();
    expect(existsSync(join(dir, 'linkstage-out'))).toBe(false);
    // the media files themselves are never touched
    expect(existsSync(join(dir, 'assets', 'poster-1.jpg'))).toBe(true);
    db.close();
  });
});

describe('rangeStart', () => {
  it('reads only bytes=N-', () => {
    expect(rangeStart('bytes=0-', 100)).toBe(0);
    expect(rangeStart('bytes=40-', 100)).toBe(40);
    expect(rangeStart(' bytes=40- ', 100)).toBe(40);
    expect(rangeStart('bytes=100-', 100)).toBe(100);
  });
  it('null when absent, another form, or beyond the size', () => {
    expect(rangeStart(undefined, 100)).toBeNull();
    expect(rangeStart('bytes=101-', 100)).toBeNull();
    expect(rangeStart('bytes=0-50', 100)).toBeNull();
    expect(rangeStart('bytes=-50', 100)).toBeNull();
    expect(rangeStart('bytes=1-,5-', 100)).toBeNull();
    expect(rangeStart('bytes=a-', 100)).toBeNull();
    expect(rangeStart('items=1-', 100)).toBeNull();
    expect(rangeStart('', 100)).toBeNull();
    expect(rangeStart(`bytes=${'9'.repeat(16)}-`, 100)).toBeNull();
  });
});

describe('sweepStage', () => {
  it('keeps only the named link folder', () => {
    const dir = tempDir();
    put(dir, `linkstage/${LINK}/surau.db`, 'keep');
    put(dir, `linkstage/${LINK}/assets/a.jpg`, 'keep');
    put(dir, `linkstage/${OTHER}/surau.db`, 'drop');
    put(dir, 'linkstage/stray.txt', 'drop');
    sweepStage(dir, LINK);
    expect(left(join(dir, 'linkstage'))).toEqual([`${LINK}/assets/a.jpg`, `${LINK}/surau.db`]);
    expect(readFileSync(join(dir, 'linkstage', LINK, 'surau.db'), 'utf8')).toBe('keep');
  });
  it('null removes the whole stage; no stage folder is fine', () => {
    const dir = tempDir();
    sweepStage(dir, null);
    sweepStage(dir, LINK);
    put(dir, `linkstage/${LINK}/surau.db`, 'x');
    sweepStage(dir, null);
    expect(existsSync(join(dir, 'linkstage'))).toBe(false);
  });
  it('does not touch anything outside the stage folder', () => {
    const dir = tempDir();
    put(dir, 'assets/a.jpg', 'media');
    put(dir, `linkstage/${OTHER}/surau.db`, 'drop');
    sweepStage(dir, LINK);
    expect(existsSync(join(dir, 'assets', 'a.jpg'))).toBe(true);
  });
});
