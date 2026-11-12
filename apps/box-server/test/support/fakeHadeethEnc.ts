import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** A fake HadeethEnc API over the recorded fixtures. Tests never touch the real service. */

const dir = new URL('../fixtures/hadeethenc/', import.meta.url);
export function fixture(name: string): Record<string, unknown> & unknown[] {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`${name}.json`, dir)), 'utf8')) as never;
}

export interface FakeHadeethEnc {
  fetch: typeof fetch;
  /** Every URL requested, in order. */
  calls: string[];
  /** Hadis answered by `/hadeeths/one`, by id; a number answers that HTTP status instead. */
  one: Map<string, Record<string, unknown> | number>;
  /** `/hadeeths/list` by category id: hadis ids to list, or a number for an HTTP status. */
  lists: Map<string, string[] | number>;
  /** When set, every request fails like a dead network. */
  offline: boolean;
  /** Status of `/languages` (200 = fine). */
  languagesStatus: number;
  /** While set, every request waits for it before answering. */
  hold: Promise<void> | null;
}

export function fakeHadeethEnc(): FakeHadeethEnc {
  const one = new Map<string, Record<string, unknown> | number>([
    ['66512', fixture('one-66512')],
    ['66513', fixture('one-66513')],
    ['66599', fixture('one-dhaif')],
  ]);
  const lists = new Map<string, string[] | number>([['59', ['66512']], ['63', ['66513']]]);
  const state: FakeHadeethEnc = {
    calls: [], one, lists, offline: false, languagesStatus: 200, hold: null,
    fetch: (async (input: Parameters<typeof fetch>[0]) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      state.calls.push(raw);
      if (state.hold) await state.hold;
      if (state.offline) throw new TypeError('fetch failed');
      const u = new URL(raw);
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (u.searchParams.get('language') !== null && u.searchParams.get('language') !== 'ms') return json({}, 400);
      if (u.pathname.endsWith('/languages')) return state.languagesStatus === 200 ? json(fixture('languages')) : json({}, state.languagesStatus);
      if (u.pathname.endsWith('/categories/list/')) return json(fixture('categories-list'));
      if (u.pathname.endsWith('/hadeeths/list/')) {
        const cat = u.searchParams.get('category_id') ?? '';
        const l = lists.get(cat);
        if (l === undefined) return json(fixture('list-500'), 500); // the real API answers 500 for an unknown category
        if (typeof l === 'number') return json({}, l);
        const data = l.map((id) => ({ id, title: `Hadis ${id}`, translations: ['ms'] }));
        return json({ data, meta: { current_page: '1', last_page: 1, total_items: data.length, per_page: '100' } });
      }
      if (u.pathname.endsWith('/hadeeths/one/')) {
        const id = u.searchParams.get('id') ?? '';
        const h = one.get(id);
        if (h === undefined) return json({}, 404);
        if (typeof h === 'number') return json({}, h);
        return json(h);
      }
      return json({}, 404);
    }) as typeof fetch,
  };
  return state;
}
