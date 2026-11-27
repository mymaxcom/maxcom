import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assetKey, createFollowCache, themeKey } from '../src/follow/cache.ts';
import type { FollowCache } from '../src/follow/cache.ts';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'follow-cache-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const bytes = (n: number, fill = 7): Buffer => Buffer.alloc(n, fill);
const stream = (b: Buffer, size = 64): Readable => Readable.from((function* () {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size);
})());

/** A disk of `cap` bytes: what the cache holds counts against it. */
function diskOf(cap: number, floor: number): { cache: FollowCache; tick: () => void } {
  let t = 1_000;
  let cache: FollowCache;
  cache = createFollowCache({
    dir, floorBytes: floor, freeBytes: () => cap - cache.stats().bytes,
    now: () => new Date(t),
  });
  return { cache, tick: () => { t += 1000; } };
}

describe('follow cache: JSON', () => {
  it('writes atomically and leaves no temporary file behind', () => {
    const cache = createFollowCache({ dir, freeBytes: () => 10 ** 12 });
    expect(cache.putJson('bundle', { version: 3, days: [] })).toBe(true);
    expect(cache.putJson('bundle', { version: 4, days: [] })).toBe(true);
    expect(cache.getJson('bundle')).toEqual({ version: 4, days: [] });
    expect(readdirSync(join(dir, 'json'))).toEqual(['bundle.json']);
    expect(cache.getJson('content')).toBeNull();
  });

  it('refuses a name that is not a plain lower-case word', () => {
    const cache = createFollowCache({ dir, freeBytes: () => 10 ** 12 });
    expect(cache.putJson('../escape', {})).toBe(false);
    expect(cache.putJson('Bundle', {})).toBe(false);
    expect(cache.getJson('../escape')).toBeNull();
  });

  it('a damaged JSON file reads as absent, never as a half value', () => {
    const cache = createFollowCache({ dir, freeBytes: () => 10 ** 12 });
    writeFileSync(join(dir, 'json', 'bundle.json'), '{"version":');
    expect(cache.getJson('bundle')).toBeNull();
  });
});

describe('follow cache: files are verified before they take their name', () => {
  it('a file that hashes to its id is stored and marked hash-checked', async () => {
    const cache = createFollowCache({ dir, freeBytes: () => 10 ** 12 });
    const b = bytes(1000, 1);
    const id = sha(b);
    expect(await cache.putFile(assetKey(id), { kind: 'image', mime: 'image/png', sha256: id, length: 1000 }, stream(b))).toBe('stored');
    const f = cache.info(assetKey(id));
    expect(f?.size).toBe(1000);
    expect(f?.hashChecked).toBe(true);
    expect(readFileSync(f!.path).equals(b)).toBe(true);
  });

  it('a picture whose bytes do not hash to its id is refused and nothing is left', async () => {
    const cache = createFollowCache({ dir, freeBytes: () => 10 ** 12 });
    const good = bytes(500, 1);
    const id = sha(good);
    const bad = bytes(500, 2);
    expect(await cache.putFile(assetKey(id), { kind: 'image', mime: 'image/png', sha256: id, length: 500 }, stream(bad))).toBe('corrupt');
    expect(cache.info(assetKey(id))).toBeNull();
    expect(readdirSync(join(dir, 'files'))).toEqual([]);
    expect(cache.stats()).toEqual({ bytes: 0, files: 0 });
  });

  it('a file shorter or longer than announced is refused', async () => {
    const cache = createFollowCache({ dir, freeBytes: () => 10 ** 12 });
    const k = themeKey('/themes/x/0123456789abcdef-2/bundle.css');
    expect(await cache.putFile(k, { kind: 'theme', mime: 'text/css', length: 100 }, stream(bytes(60)))).toBe('corrupt');
    expect(await cache.putFile(k, { kind: 'theme', mime: 'text/css', length: 100 }, stream(bytes(160)))).toBe('corrupt');
    expect(cache.info(k)).toBeNull();
    expect(readdirSync(join(dir, 'files'))).toEqual([]);
  });

  it('a theme file with no hash to check keeps its length and etag, and is not marked hash-checked', async () => {
    const cache = createFollowCache({ dir, freeBytes: () => 10 ** 12 });
    const k = themeKey('/themes/x/0123456789abcdef-2/bundle.css');
    expect(await cache.putFile(k, { kind: 'theme', mime: 'text/css', length: 120, etag: 'W/"abc"' }, stream(bytes(120)))).toBe('stored');
    const f = cache.info(k);
    expect(f).toMatchObject({ size: 120, etag: 'W/"abc"', hashChecked: false, kind: 'theme' });
  });

  it('an empty body and a bad key are refused', async () => {
    const cache = createFollowCache({ dir, freeBytes: () => 10 ** 12 });
    expect(await cache.putFile('a-1', { kind: 'image', mime: 'image/png' }, stream(Buffer.alloc(0)))).toBe('corrupt');
    expect(await cache.putFile('../x', { kind: 'image', mime: 'image/png' }, stream(bytes(10)))).toBe('failed');
    expect(await cache.putFile('a-2', { kind: 'image', mime: 'not a mime' }, stream(bytes(10)))).toBe('failed');
  });

  it('a stream that breaks half way leaves no file', async () => {
    const cache = createFollowCache({ dir, freeBytes: () => 10 ** 12 });
    const broken = new Readable({ read() {} });
    broken.push(bytes(100));
    setImmediate(() => broken.destroy(new Error('reset')));
    expect(await cache.putFile('a-broken', { kind: 'image', mime: 'image/png' }, broken)).toBe('failed');
    expect(readdirSync(join(dir, 'files'))).toEqual([]);
  });
});

describe('follow cache: disk space', () => {
  it('disk nearly full: a video is not written, the JSON still is', async () => {
    // 600 bytes free, floor 500: a 1000 byte video does not fit and there is nothing to evict.
    const cache = createFollowCache({ dir, floorBytes: 500, freeBytes: () => 600 });
    const b = bytes(1000);
    expect(await cache.putFile(assetKey(sha(b)), { kind: 'video', mime: 'video/mp4', sha256: sha(b), length: 1000 }, stream(b))).toBe('no_space');
    expect(cache.stats().files).toBe(0);
    expect(readdirSync(join(dir, 'files'))).toEqual([]);
    expect(cache.putJson('bundle', { version: 1 })).toBe(true);
    expect(cache.getJson('bundle')).toEqual({ version: 1 });
  });

  it('a video of unknown length that grows past the floor is cut off and removed', async () => {
    let free = 10 * 1024 * 1024;
    const cache = createFollowCache({ dir, floorBytes: 1024 * 1024, freeBytes: () => free });
    const chunks = (function* () {
      for (let i = 0; i < 12; i++) {
        free -= 1024 * 1024;
        yield bytes(1024 * 1024);
      }
    })();
    expect(await cache.putFile('a-big', { kind: 'video', mime: 'video/mp4' }, Readable.from(chunks))).toBe('no_space');
    expect(readdirSync(join(dir, 'files'))).toEqual([]);
  });

  it('evicts the least recently shown video first, then pictures, and never the JSON', async () => {
    // A disk of 1000 bytes with 100 held back.
    const { cache, tick } = diskOf(1000, 100);
    const put = async (key: string, kind: 'video' | 'image', n: number): Promise<string> => {
      tick();
      return cache.putFile(key, { kind, mime: kind === 'video' ? 'video/mp4' : 'image/png', length: n }, stream(bytes(n)));
    };
    cache.putJson('bundle', { version: 1 });
    expect(await put('v1', 'video', 300)).toBe('stored');
    expect(await put('v2', 'video', 300)).toBe('stored');
    expect(await put('p1', 'image', 200)).toBe('stored');
    // v2 is shown after v1: v1 is the least recently shown.
    tick();
    cache.open('v2');
    // A picture of 300 needs 400 free: one video must go, the older one.
    expect(await put('p2', 'image', 300)).toBe('stored');
    expect(cache.info('v1')).toBeNull();
    expect(cache.info('v2')).not.toBeNull();
    expect(cache.info('p1')).not.toBeNull();
    // Another picture: the last video goes before any picture.
    expect(await put('p3', 'image', 300)).toBe('stored');
    expect(cache.info('v2')).toBeNull();
    expect(cache.info('p1')).not.toBeNull();
    expect(cache.info('p2')).not.toBeNull();
    // No video is left: pictures go, least recently shown first (p1, then p2).
    expect(await put('p4', 'image', 400)).toBe('stored');
    expect(cache.info('p1')).toBeNull();
    expect(cache.info('p2')).toBeNull();
    expect(cache.info('p3')).not.toBeNull();
    expect(cache.info('p4')).not.toBeNull();
    expect(cache.getJson('bundle')).toEqual({ version: 1 });
  });

  it('a new video never costs a picture', async () => {
    const { cache, tick } = diskOf(1000, 100);
    tick();
    await cache.putFile('p1', { kind: 'image', mime: 'image/png', length: 500 }, stream(bytes(500)));
    tick();
    expect(await cache.putFile('v1', { kind: 'video', mime: 'video/mp4', length: 600 }, stream(bytes(600)))).toBe('no_space');
    expect(cache.info('p1')).not.toBeNull();
    expect(cache.info('v1')).toBeNull();
  });

  it('stats counts the bytes and the files', async () => {
    const cache = createFollowCache({ dir, freeBytes: () => 10 ** 12 });
    await cache.putFile('a', { kind: 'image', mime: 'image/png', length: 10 }, stream(bytes(10)));
    await cache.putFile('b', { kind: 'video', mime: 'video/mp4', length: 25 }, stream(bytes(25)));
    expect(cache.stats()).toEqual({ bytes: 35, files: 2 });
    cache.remove('a');
    expect(cache.stats()).toEqual({ bytes: 25, files: 1 });
  });
});

describe('follow cache: start-up', () => {
  it('a new cache over the same folder sees what was stored; leftovers of a crash are removed', async () => {
    const first = createFollowCache({ dir, freeBytes: () => 10 ** 12 });
    await first.putFile('keep', { kind: 'image', mime: 'image/png', length: 40, etag: '"e"' }, stream(bytes(40)));
    first.putJson('content', { version: 2 });
    writeFileSync(join(dir, 'files', 'half.123.1.tmp'), 'xx');
    writeFileSync(join(dir, 'files', 'orphan'), 'no sidecar');
    mkdirSync(join(dir, 'files'), { recursive: true });
    const second = createFollowCache({ dir, freeBytes: () => 10 ** 12 });
    expect(second.info('keep')).toMatchObject({ size: 40, etag: '"e"', mime: 'image/png' });
    expect(second.getJson('content')).toEqual({ version: 2 });
    expect(existsSync(join(dir, 'files', 'half.123.1.tmp'))).toBe(false);
    expect(existsSync(join(dir, 'files', 'orphan'))).toBe(false);
  });

  it('a file whose size no longer matches its sidecar is dropped', async () => {
    const first = createFollowCache({ dir, freeBytes: () => 10 ** 12 });
    await first.putFile('cut', { kind: 'image', mime: 'image/png', length: 40 }, stream(bytes(40)));
    writeFileSync(join(dir, 'files', 'cut'), bytes(10));
    const second = createFollowCache({ dir, freeBytes: () => 10 ** 12 });
    expect(second.info('cut')).toBeNull();
    expect(existsSync(join(dir, 'files', 'cut'))).toBe(false);
  });
});
