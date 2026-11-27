import { describe, expect, it } from 'vitest';
import { collectPages, MAX_FILES, PAGE_FILES, pageOfList, pagesOf, parseMoveList, requestedPage, StoreMoveError } from '../src/link/storeMove.ts';
import type { MoveFile, MoveList } from '../src/link/storeMove.ts';

/** The paging of the store list (O24): the giver slices one built list, the receiver rebuilds it and trusts nothing. */
const LINK = 'ab'.repeat(16);
const sha = (i: number): string => i.toString(16).padStart(64, '0');

function makeList(n: number): MoveList {
  const files: MoveFile[] = [{ path: 'surau.db', size: 4096, sha256: sha(0) }];
  for (let i = 1; i < n; i++) files.push({ path: `assets/f${i}.jpg`, size: i, sha256: sha(i) });
  return { linkId: LINK, dbLevel: 7, release: '2026.11.15', files, bytes: files.reduce((a, f) => a + f.size, 0) };
}

type Tamper = (page: number, p: Record<string, unknown>) => Record<string, unknown>;

/** The giver as the routes use it, the receiver as work.ts uses it. */
const pull = (list: MoveList, tamper: Tamper = (_, p) => p): Promise<MoveList> => {
  const get = (n: number): Record<string, unknown> => tamper(n, { state: 'ready', ...pageOfList(list, n)! });
  return collectPages(get(0), (n) => Promise.resolve(get(n)), LINK);
};

describe('paging the store list', () => {
  it('constants: 2,000 per page, 100,000 files at most, the page count follows', () => {
    expect([PAGE_FILES, MAX_FILES]).toEqual([2000, 100_000]);
    expect([pagesOf(1), pagesOf(2000), pagesOf(2001), pagesOf(12_000), pagesOf(100_000)]).toEqual([1, 1, 2, 6, 50]);
  });

  it('12,000 files: six pages, the receiver gets the same list back, in order, with the sum of the sizes', async () => {
    const list = makeList(12_000);
    expect(pagesOf(list.files.length)).toBe(6);
    const sizes = Array.from({ length: 6 }, (_, n) => pageOfList(list, n)!.files.length);
    expect(sizes).toEqual([2000, 2000, 2000, 2000, 2000, 2000]);
    const got = await pull(list);
    expect(got.files).toEqual(list.files);
    expect(got.bytes).toBe(list.bytes);
    expect([got.linkId, got.dbLevel, got.release]).toEqual([LINK, 7, '2026.11.15']);
    // and the plan that is written from it reads back through the strict parser
    expect(parseMoveList(got, LINK).files).toHaveLength(12_000);
  });

  it('a last page that is short, and lists of exactly one page', async () => {
    expect((await pull(makeList(4001))).files).toHaveLength(4001);
    expect(pageOfList(makeList(4001), 2)!.files).toHaveLength(1);
    expect((await pull(makeList(1))).files).toHaveLength(1);
    expect((await pull(makeList(2000))).files).toHaveLength(2000);
  });

  it('the largest list (100,000) is read; one more is refused', async () => {
    expect((await pull(makeList(100_000))).files).toHaveLength(100_000);
    const big = makeList(100_001);
    await expect(pull(big)).rejects.toThrow(StoreMoveError);
    expect(() => parseMoveList(big, LINK)).toThrow(StoreMoveError);
  });

  it('a path repeated on a later page is refused, also in another letter case', async () => {
    const list = makeList(5000);
    for (const dup of ['assets/f10.jpg', 'ASSETS/F10.JPG']) {
      const bad = list.files.slice();
      bad[2500] = { path: dup, size: 1, sha256: sha(9) };
      await expect(pull({ ...list, files: bad }), dup).rejects.toThrow(StoreMoveError);
    }
    // the control: all different
    expect((await pull(list)).files).toHaveLength(5000);
  });

  it('refuses a total that does not match, a page out of order, a page of another list and a page of the wrong size', async () => {
    const list = makeList(6000);
    const rows = (p: Record<string, unknown>): unknown[] => p.files as unknown[];
    const cases: [string, Tamper][] = [
      ['total larger on page 1', (n, p) => (n === 1 ? { ...p, total: 6001 } : p)],
      ['total smaller on page 2', (n, p) => (n === 2 ? { ...p, total: 5999 } : p)],
      ['pages changed', (n, p) => (n === 1 ? { ...p, pages: 4 } : p)],
      ['page 1 answered with page 2', (n, p) => (n === 1 ? { ...p, page: 2 } : p)],
      ['page 1 answered with the content of page 0', (n, p) => (n === 1 ? { ...p, ...pageOfList(list, 0)!, page: 1 } : p)],
      ['another dbLevel', (n, p) => (n === 2 ? { ...p, dbLevel: 8 } : p)],
      ['another release', (n, p) => (n === 2 ? { ...p, release: '2026.11.16' } : p)],
      ['another link', (n, p) => (n === 1 ? { ...p, linkId: 'cd'.repeat(16) } : p)],
      ['a short page 1', (n, p) => (n === 1 ? { ...p, files: rows(p).slice(1) } : p)],
      ['a long last page', (n, p) => (n === 2 ? { ...p, files: [...rows(p), { path: 'assets/extra.jpg', size: 1, sha256: sha(7) }] } : p)],
      ['not a list', (n, p) => (n === 1 ? { ...p, files: 'x' } : p)],
      ['total zero', (_, p) => ({ ...p, total: 0 })],
      ['a path with ..', (n, p) => (n === 1 ? { ...p, files: [{ path: 'assets/../x', size: 1, sha256: sha(5) }, ...rows(p).slice(1)] } : p)],
      ['a path outside the moved folders', (n, p) => (n === 2 ? { ...p, files: [{ path: 'secret/sync.key', size: 1, sha256: sha(5) }, ...rows(p).slice(1)] } : p)],
    ];
    for (const [name, tamper] of cases) await expect(pull(list, tamper), name).rejects.toThrow(StoreMoveError);
    // the control
    expect((await pull(list)).files).toHaveLength(6000);
  });

  it('page 0 must hold the database file', async () => {
    const list = makeList(3000);
    // the database file moved to the second page: refused
    const files = list.files.slice();
    const db = files.shift()!;
    files.splice(2500, 0, db);
    await expect(pull({ ...list, files })).rejects.toThrow(StoreMoveError);
    expect((await pull(list)).files[0]!.path).toBe('surau.db');
  });

  it('the giver gives no page that does not exist, and the asker names a whole page', () => {
    const list = makeList(4500);
    expect(pageOfList(list, 3)).toBeNull();
    for (const bad of [-1, 1.5, '0', null, undefined, Number.NaN, 2 ** 60]) expect(pageOfList(list, bad)).toBeNull();
    expect(pageOfList(list, 2)!.files).toHaveLength(500);
    expect([requestedPage(0), requestedPage(49), requestedPage(50)]).toEqual([0, 49, null]);
    for (const bad of [-1, 0.5, '1', null, {}, Number.POSITIVE_INFINITY]) expect(requestedPage(bad)).toBeNull();
  });
});
