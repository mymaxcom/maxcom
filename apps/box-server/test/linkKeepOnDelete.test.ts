import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deletePackAsset, putAsset } from '../src/assets/store.ts';
import { dropFreshVideo, keepMediaBeforeDelete, receiveVideo, removeVideoIfUnused, sweepVideoOrphans } from '../src/assets/video.ts';
import { openDb } from '../src/db.ts';
import { sha256Of, writePhotoFile } from '../src/finance/photos.ts';
import { keepFolderInBackupBeforeDelete, keepInBackupBeforeDelete, takeMasterBackup } from '../src/link/backupCopy.ts';
import { applyLinkJournalAtBoot, backupDirOf, backupOf, planRestore, walkFiles } from '../src/link/setAside.ts';
import { PACK_MIME } from '../src/themes/packFormat.ts';
import { createThemeStore, hashOf } from '../src/themes/store.ts';
import { mp4 } from './support/mp4.ts';
import { jpeg, manifestJson as json, png, zip } from './support/themePacks.ts';

const LINK = 'c0ffee00c0ffee00c0ffee00c0ffee00';
const T0 = new Date('2026-11-20T01:41:00.000Z');
const BIG = 10 * 1024 * 1024 * 1024;
const noLinks = (): never => {
  throw Object.assign(new Error('no hard links here'), { code: 'EPERM' });
};
const MEDIA_ROOTS = ['assets', 'finance/photos', 'themes'] as const;

let dir: string;
let db: DatabaseSync;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'maxcom-keep-delete-'));
  db = openDb(join(dir, 'surau.db'));
});
afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true });
});

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const noCheck = { free: () => null };
const upload = (buf: Buffer) => receiveVideo(db, dir, Readable.from([buf]), buf.length, 'u1', noCheck);
const themeStore = () => createThemeStore({ db, dataDir: dir, now: () => new Date() });
const pack = (version: number): Buffer =>
  zip({
    'theme.json': json({ version }),
    'theme.css': `.stage{--accent:#0a0} /* v${version} */`,
    'images/kuliah.jpg': jpeg(64, 36),
  });
const installV = async (store: ReturnType<typeof themeStore>, version: number): Promise<void> => {
  await store.install((await store.stage(pack(version))).stagedId!, 'u1');
};
const backupFile = (rel: string): string => join(backupDirOf(dir, LINK), rel);
const bytesOf = (path: string): string => sha(readFileSync(path));

/** Every media file of the store now: relative path to hash. */
function snapshot(): Map<string, string> {
  const out = new Map<string, string>();
  for (const root of MEDIA_ROOTS) {
    // the theme store's transient staging and temp folders are not store content (they are not kept on delete)
    for (const f of walkFiles(join(dir, root))) if (!/^\.(staged|tmp-)/.test(f.replace(/^themes\//, ''))) out.set(`${root}/${f}`, bytesOf(join(dir, root, f)));
  }
  return out;
}

/** A store with one of everything, as it is on link day. */
async function linkDayStore(): Promise<{ videoA: string; videoB: string; pic: string; photo: string; pk: string; themeV3: string }> {
  const a = await upload(mp4({ seconds: 10, salt: 1 }));
  const b = await upload(mp4({ seconds: 11, salt: 2 }));
  const pic = putAsset(db, dir, png(32, 32), 'image/png', 'u1').id;
  const pk = putAsset(db, dir, zip({ 'theme.json': json({}), 'theme.css': '.stage{}' }), PACK_MIME, 'u1').id;
  const photoBuf = jpeg(20, 20);
  const photo = sha256Of(photoBuf);
  writePhotoFile(dir, photo, photoBuf);
  await installV(themeStore(), 3);
  const themeV3 = join('themes', 'hijau-siti', hashOf(sha(pack(3))));
  return { videoA: a.id, videoB: b.id, pic, photo, pk, themeV3 };
}

const keeper = (rel: string): boolean => keepMediaBeforeDelete(dir, rel);
const keepOnDelete = (): Promise<unknown> => takeMasterBackup({ db, dataDir: dir, linkId: LINK, now: T0, free: () => BIG, link: noLinks });

describe('keep-on-delete: the media sites move a link-day file into the backup', () => {
  let day: Awaited<ReturnType<typeof linkDayStore>>;
  let before: Map<string, string>;
  beforeEach(async () => {
    day = await linkDayStore();
    before = snapshot();
    await keepOnDelete();
  });

  it('the backup is in keep-on-delete mode and holds no media file', () => {
    expect(backupOf(dir, LINK)?.mode).toBe('keep-on-delete');
    expect(existsSync(backupFile(`assets/${day.videoA}.mp4`))).toBe(false);
  });

  it('a video named by the backup that is deleted ends up in the backup, not in the store', () => {
    const was = bytesOf(join(dir, 'assets', `${day.videoA}.mp4`));
    expect(dropFreshVideo(db, dir, day.videoA)).toEqual({ found: true, removed: true });
    expect(existsSync(join(dir, 'assets', `${day.videoA}.mp4`))).toBe(false);
    expect(bytesOf(backupFile(`assets/${day.videoA}.mp4`))).toBe(was);
    // the second video was not touched
    expect(existsSync(join(dir, 'assets', `${day.videoB}.mp4`))).toBe(true);
  });

  it('removeVideoIfUnused and the orphan sweep keep a link-day video too', () => {
    dropFreshVideo(db, dir, day.videoA); // ends the hold only for the first; use the second through the sweep
    const old = new Date(Date.now() + 3 * 86_400_000);
    expect(sweepVideoOrphans(db, dir, 0, old)).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(dir, 'assets', `${day.videoB}.mp4`))).toBe(false);
    expect(bytesOf(backupFile(`assets/${day.videoB}.mp4`))).toBe(before.get(`assets/${day.videoB}.mp4`));
    expect(removeVideoIfUnused(db, dir, day.videoB)).toBe(false);
  });

  it('a video file with no row (an orphan from link day) is moved by the sweep, not deleted', () => {
    db.prepare('DELETE FROM assets WHERE id = ?').run(day.videoB);
    const old = new Date(Date.now() + 3 * 86_400_000);
    // the file is young on disk, so push its age with the clock
    sweepVideoOrphans(db, dir, 0, old);
    expect(existsSync(join(dir, 'assets', `${day.videoB}.mp4`))).toBe(false);
    expect(bytesOf(backupFile(`assets/${day.videoB}.mp4`))).toBe(before.get(`assets/${day.videoB}.mp4`));
  });

  it('a replace: the same video comes in again over a leftover file, the old one is kept and the new one is stored', async () => {
    db.prepare('DELETE FROM assets WHERE id = ?').run(day.videoB); // a file with no row is what a replace meets
    const again = await upload(mp4({ seconds: 11, salt: 2 }));
    expect(again).toMatchObject({ id: day.videoB, created: true });
    expect(bytesOf(backupFile(`assets/${day.videoB}.mp4`))).toBe(before.get(`assets/${day.videoB}.mp4`));
    expect(bytesOf(join(dir, 'assets', `${day.videoB}.mp4`))).toBe(before.get(`assets/${day.videoB}.mp4`));
  });

  it('a stored theme file (.maxtheme) named by the backup is moved when its row goes', () => {
    expect(deletePackAsset(db, dir, day.pk, keeper)).toBe(true);
    expect(existsSync(join(dir, 'assets', `${day.pk}.maxtheme`))).toBe(false);
    expect(bytesOf(backupFile(`assets/${day.pk}.maxtheme`))).toBe(before.get(`assets/${day.pk}.maxtheme`));
  });

  it('a file added AFTER the backup is deleted plainly and never lands in the backup', async () => {
    const late = await upload(mp4({ seconds: 12, salt: 3 }));
    expect(dropFreshVideo(db, dir, late.id)).toEqual({ found: true, removed: true });
    expect(existsSync(join(dir, 'assets', `${late.id}.mp4`))).toBe(false);
    expect(existsSync(backupFile(`assets/${late.id}.mp4`))).toBe(false);
    const latePack = putAsset(db, dir, zip({ 'theme.json': json({ name: 'late' }), 'theme.css': '.stage{}' }), PACK_MIME, 'u1').id;
    deletePackAsset(db, dir, latePack, keeper);
    expect(existsSync(backupFile(`assets/${latePack}.maxtheme`))).toBe(false);
  });

  it('themes: an update prunes the old folder into the backup; removing the theme keeps nothing of the new versions', async () => {
    const store = themeStore();
    await installV(store, 4);
    await installV(store, 5); // prunes v3 (the folder that was there on link day)
    const v3 = day.themeV3.replace(/\\/g, '/');
    expect(existsSync(join(dir, v3))).toBe(false);
    const kept = [...before.keys()].filter((p) => p.startsWith(`${v3}/`));
    expect(kept.length).toBeGreaterThan(0);
    for (const p of kept) expect(bytesOf(backupFile(p))).toBe(before.get(p));
    // later versions were never in the backup
    store.remove('hijau-siti', 'u1');
    expect(existsSync(join(dir, 'themes', 'hijau-siti'))).toBe(false);
    expect(walkFiles(backupFile('themes')).every((p) => p.startsWith(`hijau-siti/${hashOf(sha(pack(3)))}/`))).toBe(true);
  });

  it('keepFolderInBackupBeforeDelete counts the files it moved and leaves the rest of the folder', () => {
    mkdirSync(join(dir, 'themes', 'extra'), { recursive: true });
    writeFileSync(join(dir, 'themes', 'extra', 'new.css'), 'added later');
    const folder = join('themes', 'hijau-siti', hashOf(sha(pack(3)))).replace(/\\/g, '/');
    const n = keepFolderInBackupBeforeDelete(dir, folder);
    expect(n).toBe([...before.keys()].filter((p) => p.startsWith(`${folder}/`)).length);
    expect(keepFolderInBackupBeforeDelete(dir, 'themes/extra')).toBe(0);
    expect(existsSync(join(dir, 'themes', 'extra', 'new.css'))).toBe(true);
    expect(() => keepFolderInBackupBeforeDelete(dir, '../x')).toThrow('keep: bad_path');
  });

  it('a failing keep step deletes nothing: the error surfaces and the file stays', () => {
    const path = join(dir, 'assets', `${day.videoA}.mp4`);
    // a file where the backup wants a folder makes the move fail
    mkdirSync(dirname(backupFile('assets/x')), { recursive: true });
    rmSync(join(backupDirOf(dir, LINK), 'assets'), { recursive: true, force: true });
    writeFileSync(join(backupDirOf(dir, LINK), 'assets'), 'in the way');
    expect(() => keepInBackupBeforeDelete(dir, `assets/${day.videoA}.mp4`)).toThrow();
    expect(() => dropFreshVideo(db, dir, day.videoA)).toThrow();
    expect(existsSync(path)).toBe(true);
  });

  it('a restore brings every link-day file back with its link-day bytes', async () => {
    dropFreshVideo(db, dir, day.videoA);
    deletePackAsset(db, dir, day.pk, keeper);
    const store = themeStore();
    await installV(store, 4);
    await installV(store, 5);
    store.remove('hijau-siti', 'u1');
    const late = await upload(mp4({ seconds: 12, salt: 3 }));
    expect(late.created).toBe(true);
    db.close();
    planRestore(dir, LINK, new Date(T0.getTime() + 86_400_000));
    expect(applyLinkJournalAtBoot(dir)).toBe('restore');
    const after = snapshot();
    for (const [path, hash] of before) expect(after.get(path), path).toBe(hash);
    // and what came after the link is gone from the store
    expect(existsSync(join(dir, 'assets', `${late.id}.mp4`))).toBe(false);
  });
});

describe('without a keep-on-delete backup the sites behave as before', () => {
  it('with a hard-link backup: the file is deleted, the backup keeps its own link and is not touched', async () => {
    const day = await linkDayStore();
    await takeMasterBackup({ db, dataDir: dir, linkId: LINK, now: T0, free: () => BIG });
    expect(backupOf(dir, LINK)?.mode).toBe('hardlink');
    const was = bytesOf(backupFile(`assets/${day.videoA}.mp4`));
    expect(dropFreshVideo(db, dir, day.videoA).removed).toBe(true);
    expect(existsSync(join(dir, 'assets', `${day.videoA}.mp4`))).toBe(false);
    expect(bytesOf(backupFile(`assets/${day.videoA}.mp4`))).toBe(was);
    expect(keepInBackupBeforeDelete(dir, `assets/${day.videoB}.mp4`)).toBe('not-needed');
    expect(existsSync(join(dir, 'assets', `${day.videoB}.mp4`))).toBe(true);
    const store = themeStore();
    await installV(store, 4);
    await installV(store, 5);
    expect(existsSync(join(dir, day.themeV3))).toBe(false);
    expect(bytesOf(backupFile(`${day.themeV3.replace(/\\/g, '/')}/bundle.css`))).toBeTypeOf('string');
  });

  it('with no backup at all (no linkundo folder): plain deletes, and nothing is created', async () => {
    const day = await linkDayStore();
    expect(existsSync(join(dir, 'linkundo'))).toBe(false);
    expect(dropFreshVideo(db, dir, day.videoA).removed).toBe(true);
    expect(deletePackAsset(db, dir, day.pk, keeper)).toBe(true);
    const store = themeStore();
    await installV(store, 4);
    await installV(store, 5);
    store.remove('hijau-siti', 'u1');
    expect(existsSync(join(dir, 'assets', `${day.videoA}.mp4`))).toBe(false);
    expect(existsSync(join(dir, 'themes', 'hijau-siti'))).toBe(false);
    expect(existsSync(join(dir, 'linkundo'))).toBe(false);
  });
});
