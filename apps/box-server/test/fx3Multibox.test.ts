import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveLeaveSecret } from '../src/follow/leaveSecret.ts';
import { parseLeaveSecret } from '../src/follow/revert.ts';
import { collectPages, firstPageOf, pageOfList, pagesOf, pullStore, requestedPage, StoreMoveError } from '../src/link/storeMove.ts';
import type { MoveList } from '../src/link/storeMove.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'surau-fx3m-'));
  dirs.push(d);
  return d;
};
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

describe('F19: the leave secret of a Windows box (S9: gone from process.env)', () => {
  const win = (dataDir: string | null, env: NodeJS.ProcessEnv = {}) => resolveLeaveSecret({ env, platform: 'win32', dataDir });

  it('writes a fresh 64 hex secret into data/secret/leave-secret at every start', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'secret'));
    const a = win(dir);
    expect(parseLeaveSecret(a)).not.toBeNull();
    expect(readFileSync(join(dir, 'secret', 'leave-secret'), 'ascii').trim()).toBe(a);
    const b = win(dir);
    expect(b).not.toBe(a);
    expect(readFileSync(join(dir, 'secret', 'leave-secret'), 'ascii').trim()).toBe(b);
  });

  it('never makes the secret folder, and writes nothing without a real data folder', () => {
    const dir = tmp();
    expect(win(dir)).toBeNull();
    expect(existsSync(join(dir, 'secret'))).toBe(false);
    expect(win(null)).toBeNull();
  });

  it('writes through no link or folder in the file position', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'secret', 'leave-secret'), { recursive: true });
    expect(win(dir)).toBeNull();
    rmSync(join(dir, 'secret', 'leave-secret'), { recursive: true });
    const target = join(dir, 'elsewhere.txt');
    writeFileSync(target, 'keep');
    try {
      symlinkSync(target, join(dir, 'secret', 'leave-secret'));
    } catch {
      return; // no symlink right on this PC: the case cannot be made
    }
    expect(win(dir)).toBeNull();
    expect(readFileSync(target, 'utf8')).toBe('keep');
  });

  it('an env secret is used as before and is removed from the environment; other systems make no file', () => {
    const env: NodeJS.ProcessEnv = { SURAU_LEAVE_SECRET: 'ab'.repeat(32) };
    const dir = tmp();
    mkdirSync(join(dir, 'secret'));
    expect(resolveLeaveSecret({ env, platform: 'android', dataDir: dir })).toBe('ab'.repeat(32));
    expect(env.SURAU_LEAVE_SECRET).toBeUndefined();
    expect(resolveLeaveSecret({ env: {}, platform: 'linux', dataDir: dir })).toBeNull();
    expect(existsSync(join(dir, 'secret', 'leave-secret'))).toBe(false);
    // on Windows the env wins over a file, and a configured one wins over both
    const env2: NodeJS.ProcessEnv = { SURAU_LEAVE_SECRET: 'cd'.repeat(32) };
    expect(win(dir, env2)).toBe('cd'.repeat(32));
    expect(env2.SURAU_LEAVE_SECRET).toBeUndefined();
    const env3: NodeJS.ProcessEnv = { SURAU_LEAVE_SECRET: 'cd'.repeat(32) };
    expect(resolveLeaveSecret({ configured: 'ef'.repeat(32), env: env3, platform: 'win32', dataDir: dir })).toBe('ef'.repeat(32));
    expect(env3.SURAU_LEAVE_SECRET).toBeUndefined();
  });
});

describe('S12/I4: the store list between the two releases', () => {
  const LINK = 'link-1';
  const makeList = (n: number): MoveList => {
    const files = [{ path: 'surau.db', size: 1, sha256: sha(Buffer.from('db')) }];
    for (let i = 1; i < n; i++) files.push({ path: `assets/f${i}.jpg`, size: 1, sha256: sha(Buffer.from(String(i))) });
    return { linkId: LINK, dbLevel: 29, release: '2026.11.15', files, bytes: files.length };
  };

  it('a request without page is page 0', () => {
    expect(requestedPage(undefined)).toBe(0);
    expect(requestedPage(0)).toBe(0);
    expect(requestedPage('0')).toBeNull();
    expect(requestedPage(-1)).toBeNull();
  });

  it('page 0 of a list that fits one page also carries the old `list`; a longer list does not', () => {
    const one = makeList(50);
    const p = firstPageOf(one);
    expect(p.list).toEqual(one);
    expect(p.pages).toBe(1);
    const many = makeList(4500);
    expect(pagesOf(many.files.length)).toBeGreaterThan(1);
    expect(firstPageOf(many).list).toBeUndefined();
  });

  it('a receiver reads the old answer (only `list`) and the new one alike', async () => {
    const one = makeList(50);
    const old = await collectPages({ state: 'ready', list: one, token: 't' }, () => Promise.reject(new Error('no more pages')), LINK);
    expect(old.files).toHaveLength(50);
    const nu = await collectPages({ state: 'ready', ...firstPageOf(one) }, () => Promise.reject(new Error('no more pages')), LINK);
    expect(nu.files).toHaveLength(50);
    const big = makeList(4500);
    const paged = await collectPages(pageOfList(big, 0), (n) => Promise.resolve(pageOfList(big, n)), LINK);
    expect(paged.files).toHaveLength(4500);
  });

  it('an old answer that is not a good list stops the receiver once (bad_list), nothing else', async () => {
    await expect(collectPages({ state: 'ready', list: { linkId: 'other' } }, () => Promise.reject(new Error('x')), LINK)).rejects.toBeInstanceOf(StoreMoveError);
    await expect(collectPages({ state: 'ready' }, () => Promise.reject(new Error('x')), LINK)).rejects.toBeInstanceOf(StoreMoveError);
  });
});

describe('F20: a pull that meets the giver limiter waits and goes on', () => {
  it('2,500 small files through a giver that allows 600 a minute all land', async () => {
    const N = 2500;
    const bytes = new Map<string, Buffer>();
    for (let i = 1; i < N; i++) bytes.set(`assets/f${i}.bin`, Buffer.from(`file ${i}`));
    bytes.set('surau.db', Buffer.from('db'));
    const files = [...bytes].map(([path, b]) => ({ path, size: b.length, sha256: sha(b) }));
    const list: MoveList = { linkId: 'link-1', dbLevel: 29, release: '2026.11.15', files, bytes: files.reduce((n, f) => n + f.size, 0) };
    // virtual time: the giver counts requests in a one minute window; a sleep moves the clock
    let clock = 0;
    let windowStart = 0;
    let used = 0;
    let rejected = 0;
    const answer = (status: number, body: Buffer, headers: Record<string, string> = {}): IncomingMessage => {
      const r = Readable.from([body]) as unknown as IncomingMessage & { complete: boolean };
      Object.assign(r, { statusCode: status, headers, complete: true });
      return r;
    };
    const stage = join(tmp(), 'stage');
    await pullStore({
      list, stageDir: stage, freeBytes: () => null, floorBytes: 0,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      fetch: (path) => {
        if (clock - windowStart >= 60_000) {
          windowStart = clock;
          used = 0;
        }
        if (++used > 600) {
          rejected++;
          return Promise.resolve(answer(429, Buffer.from('{}'), { 'retry-after': String(Math.max(1, Math.ceil((windowStart + 60_000 - clock) / 1000))) }));
        }
        return Promise.resolve(answer(200, bytes.get(path)!));
      },
    });
    expect(rejected).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(join(stage, ...f.path.split('/')))).toEqual(bytes.get(f.path));
  }, 60_000);

  it('a giver that never stops saying 429 ends the pull with an error, not a loop', async () => {
    const b = Buffer.from('x');
    const list: MoveList = { linkId: 'link-1', dbLevel: 29, release: '2026.11.15', files: [{ path: 'surau.db', size: 1, sha256: sha(b) }], bytes: 1 };
    let calls = 0;
    await expect(
      pullStore({
        list, stageDir: join(tmp(), 'stage'), freeBytes: () => null, floorBytes: 0, sleep: () => Promise.resolve(),
        fetch: () => {
          calls++;
          const r = Readable.from([Buffer.from('{}')]) as unknown as IncomingMessage;
          Object.assign(r, { statusCode: 429, headers: { 'retry-after': '1' }, complete: true });
          return Promise.resolve(r);
        },
      }),
    ).rejects.toBeInstanceOf(StoreMoveError);
    expect(calls).toBeLessThan(50);
  });
});
