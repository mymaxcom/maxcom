import { createHash } from 'node:crypto';
import { assertSourceUrl } from '../net/safeFetch.ts';
import { readCapped } from '../net/readCapped.ts';

/** HadeethEnc (https://hadeethenc.com) client. Every request goes through the `fetchImpl` it is given: production passes `guardedFetch()`. */

export interface HeCategory {
  id: string;
  parentId: string | null;
  titleEn: string;
  count: number;
}
export interface HeListPage {
  items: { id: string; title: string }[];
  lastPage: number;
  total: number;
}
export interface HeHadith {
  id: string;
  title: string;
  textMs: string;
  introMs: string | null;
  textAr: string;
  introAr: string | null;
  attributionAr: string;
  gradeAr: string;
  categories: string[];
  digest: string;
}

export type HadeethEncErrorCode = 'source_unavailable' | 'source_bad_response';

export class HadeethEncError extends Error {
  readonly code: HadeethEncErrorCode;
  readonly status: number | undefined;
  constructor(code: HadeethEncErrorCode, status?: number, message?: string) {
    super(message ?? (status !== undefined ? `${code} (HTTP ${status})` : code));
    this.name = 'HadeethEncError';
    this.code = code;
    this.status = status;
  }
}

const TIMEOUT_MS = 20_000;
const MAX_BYTES = 1_048_576;
const MAX_TEXT_MS = 8_000;
const ID_RE = /^\d{1,8}$/;

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);

const bad = (what: string): HadeethEncError => new HadeethEncError('source_bad_response', undefined, `source_bad_response: ${what}`);

/** Line ends to \n and trimmed; the text is otherwise exactly as served. */
const clean = (s: string): string => s.replace(/\r\n?/g, '\n').trim();

function str(o: Plain, k: string, what: string): string {
  const v = o[k];
  if (typeof v !== 'string') throw bad(`${what}.${k}`);
  return clean(v);
}

function optStr(o: Plain, k: string): string | null {
  const v = o[k];
  if (typeof v !== 'string') return null;
  const c = clean(v);
  return c === '' ? null : c;
}

/** A number the API sends as a number or as a string of digits. */
function count(v: unknown, what: string): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 0) throw bad(what);
  return n;
}

export function digestOf(h: { textMs: string; textAr: string; attributionAr: string; gradeAr: string }): string {
  return createHash('sha256').update(`${h.textMs}\n${h.textAr}\n${h.attributionAr}\n${h.gradeAr}`, 'utf8').digest('hex');
}

export interface HadeethEncClient {
  categories(): Promise<HeCategory[]>;
  list(categoryId: string, page: number, perPage: number): Promise<HeListPage>;
  one(id: string): Promise<HeHadith>;
  /** One cheap request: true when HadeethEnc answers. Never throws. */
  probe(): Promise<boolean>;
}

/**
 * `baseUrl` must pass `assertSourceUrl` (https, public); `language=ms` is added here and is never a parameter.
 * Ids and page numbers are validated before they reach a URL. A redirect is refused (`redirect: 'error'`),
 * a body over 1 MB is cut off, and any non-2xx or odd shape is a typed error.
 */
export function createHadeethEnc(fetchImpl: typeof fetch, baseUrl: string): HadeethEncClient {
  assertSourceUrl(baseUrl, 'HadeethEnc');
  const base = baseUrl.replace(/\/+$/, '');

  async function getJson(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
    } catch (err) {
      throw new HadeethEncError('source_unavailable', undefined, err instanceof Error ? err.message.slice(0, 200) : 'request failed');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new HadeethEncError('source_unavailable', res.status);
    }
    let bytes: Uint8Array;
    try {
      bytes = await readCapped(res, MAX_BYTES, 'HadeethEnc response');
    } catch (err) {
      throw new HadeethEncError('source_bad_response', undefined, err instanceof Error ? err.message : 'bad response');
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw bad('not JSON');
    }
  }

  return {
    async categories() {
      const json = await getJson('/categories/list/?language=ms');
      if (!Array.isArray(json)) throw bad('categories is not a list');
      return json.map((row): HeCategory => {
        if (!isPlain(row)) throw bad('category');
        const id = typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id) : '';
        if (!ID_RE.test(id)) throw bad('category id');
        const parent = row.parent_id;
        const parentId = parent === null || parent === undefined ? null : String(parent);
        if (parentId !== null && !ID_RE.test(parentId)) throw bad('category parent');
        return { id, parentId, titleEn: str(row, 'title', 'category'), count: count(row.hadeeths_count ?? 0, 'category count') };
      });
    },

    async list(categoryId, page, perPage) {
      if (!ID_RE.test(categoryId)) throw new RangeError('invalid category id');
      if (!Number.isInteger(page) || page < 1 || page > 999) throw new RangeError('invalid page');
      if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) throw new RangeError('invalid page size');
      const json = await getJson(`/hadeeths/list/?language=ms&category_id=${categoryId}&page=${page}&per_page=${perPage}`);
      if (!isPlain(json) || !Array.isArray(json.data) || !isPlain(json.meta)) throw bad('list shape');
      const items = json.data.map((row) => {
        if (!isPlain(row)) throw bad('list row');
        const id = typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id) : '';
        if (!ID_RE.test(id)) throw bad('list id');
        return { id, title: str(row, 'title', 'list row') };
      });
      return { items, lastPage: count(json.meta.last_page, 'last_page'), total: count(json.meta.total_items, 'total_items') };
    },

    async one(id) {
      if (typeof id !== 'string' || !ID_RE.test(id)) throw new RangeError('invalid hadith id');
      const json = await getJson(`/hadeeths/one/?language=ms&id=${id}`);
      if (!isPlain(json)) throw bad('hadith');
      const gotId = typeof json.id === 'string' || typeof json.id === 'number' ? String(json.id) : '';
      if (gotId !== id) throw bad('hadith id mismatch');
      const textMs = str(json, 'hadeeth', 'hadith');
      const textAr = str(json, 'hadeeth_ar', 'hadith');
      const attributionAr = str(json, 'attribution', 'hadith');
      const gradeAr = str(json, 'grade', 'hadith');
      const title = str(json, 'title', 'hadith');
      if (textMs === '' || textAr === '') throw bad('empty text');
      const cats = Array.isArray(json.categories)
        ? json.categories.map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : '')).filter((c) => ID_RE.test(c))
        : [];
      const cut = textMs.slice(0, MAX_TEXT_MS);
      return {
        id,
        title,
        textMs: cut,
        introMs: optStr(json, 'hadeeth_intro'),
        textAr,
        introAr: optStr(json, 'hadeeth_intro_ar'),
        attributionAr,
        gradeAr,
        categories: cats,
        digest: digestOf({ textMs: cut, textAr, attributionAr, gradeAr }),
      };
    },

    async probe() {
      try {
        return Array.isArray(await getJson('/languages'));
      } catch {
        return false;
      }
    },
  };
}

/** A client that builds the real one on each call, so a changed `dataSources.hadeethenc` address applies at once. */
export function lazyHadeethEnc(get: () => HadeethEncClient): HadeethEncClient {
  return {
    categories: () => get().categories(),
    list: (c, p, n) => get().list(c, p, n),
    one: (id) => get().one(id),
    probe: async () => {
      try {
        return await get().probe();
      } catch {
        return false;
      }
    },
  };
}
