import type { DatabaseSync } from 'node:sqlite';
import { attributionOf, gradeOf } from '@surau/core';
import {
  CatalogCapError, catalogIndex, catalogStats, leafCategoryIds, stateDelete, stateGet, stateSet, upsertCategories, upsertHadith,
} from './catalog.ts';
import { HadeethEncError } from './hadeethenc.ts';
import type { HadeethEncClient } from './hadeethenc.ts';

/** Throttled, resumable crawl of HadeethEnc into the local catalog. One job at a time, never blocks a request. */

export interface Job {
  id: string;
  state: 'running' | 'done' | 'failed';
  progress: number;
  done: number;
  total: number;
  /** Categories that answered an error and were skipped, plus hadis that could not be read. */
  skipped?: number;
  /** Ids and categories given up after failing the same way on 3 runs; they no longer hold back `lastFullRefresh`. */
  abandoned?: number;
  error?: string;
}

export interface CatalogJobDeps {
  db: DatabaseSync;
  client: HadeethEncClient;
  now: () => Date;
  /** `hadis.gradeUnknown` / `hadis.attributionUnknown`, once per distinct Arabic text. */
  onLog?: (action: string, detail: string) => void;
  /** Pause between two requests (ms). Tests pass a no-op. Default 300. */
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CatalogJob {
  start(): Job | 'busy';
  status(id: string): Job | null;
  current(): Job | null;
  /** The newest job, running or finished (its `skipped` stays readable after it ends). */
  last(): Job | null;
  /** Takes the one shared slot for another long task (the weekly check): `start()` answers busy until released. Null when taken. */
  hold(): (() => void) | null;
  /** Logs an unmapped grade or attribution once per distinct text for this process. */
  noteUnknown(h: { gradeAr: string; attributionAr: string }): void;
  stop(): void;
}

/** `onLog` once per distinct unmapped grade / attribution text, however many hadis carry it. */
export function createUnknownNoter(onLog?: (action: string, detail: string) => void): (h: { gradeAr: string; attributionAr: string }) => void {
  const logged = new Set<string>();
  return (h) => {
    if (gradeOf(h.gradeAr) === null && !logged.has(`g:${h.gradeAr}`)) {
      logged.add(`g:${h.gradeAr}`);
      onLog?.('hadis.gradeUnknown', h.gradeAr.slice(0, 60));
    }
    if (attributionOf(h.attributionAr) === null && !logged.has(`a:${h.attributionAr}`)) {
      logged.add(`a:${h.attributionAr}`);
      onLog?.('hadis.attributionUnknown', h.attributionAr.slice(0, 200));
    }
  };
}

/**
 * True when asking again would give the same answer: a 4xx (except the two that mean "later"), a reply that is not
 * what the API promises, a bad id or a field over its cap. False for a dead network, a timeout and 5xx.
 */
export function isDeterministic(err: unknown): boolean {
  if (err instanceof RangeError || err instanceof CatalogCapError) return true;
  if (!(err instanceof HadeethEncError)) return false;
  if (err.code === 'source_bad_response') return true;
  const s = err.status;
  return s !== undefined && s >= 400 && s < 500 && s !== 408 && s !== 429;
}

const STALE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 8;
const PER_PAGE = 100;
const MAX_PAGES = 50;
const MAX_JOBS = 20;
const CURSOR_KEY = 'hadeethenc.cursor';
const FULL_KEY = 'hadeethenc.lastFullRefresh';
const FAIL_KEY = 'hadeethenc.failures';
/** Smallest category list taken as real (HadeethEnc serves over a hundred). */
const MIN_CATEGORIES = 20;
const MAX_CATEGORIES = 2000;
const MAX_IDS = 20000;
/** The crawl cursor is written every this many categories (and when the job stops or fails), not after each. */
const CURSOR_EVERY = 25;
/** A deterministic failure on this many runs gives the id or category up. */
const MAX_ATTEMPTS = 3;

interface Failures {
  cats: Record<string, number>;
  ids: Record<string, number>;
}

function readFailures(db: DatabaseSync): Failures {
  const out: Failures = { cats: {}, ids: {} };
  const raw = stateGet(db, FAIL_KEY);
  if (raw === null) return out;
  try {
    const p = JSON.parse(raw) as Partial<Failures>;
    for (const k of ['cats', 'ids'] as const) {
      const m = p[k];
      if (m && typeof m === 'object') for (const [id, n] of Object.entries(m)) if (typeof n === 'number' && n > 0) out[k][id] = n;
    }
  } catch {
    // start again
  }
  return out;
}

function writeFailures(db: DatabaseSync, f: Failures): void {
  if (Object.keys(f.cats).length === 0 && Object.keys(f.ids).length === 0) stateDelete(db, FAIL_KEY);
  else stateSet(db, FAIL_KEY, JSON.stringify(f));
}

type Cursor =
  | { phase: 'ids'; doneCats: string[]; ids: string[] }
  | { phase: 'one'; ids: string[]; next: number };

/** True when no full refresh has completed, or the last one is older than 30 days. */
export function shouldRefresh(db: DatabaseSync, now: Date): boolean {
  const last = stateGet(db, FULL_KEY);
  if (last === null) return true;
  const t = Date.parse(last);
  return Number.isNaN(t) || now.getTime() - t > STALE_MS;
}

function readCursor(db: DatabaseSync): Cursor | null {
  const raw = stateGet(db, CURSOR_KEY);
  if (raw === null) return null;
  try {
    const c = JSON.parse(raw) as Cursor;
    if (c.phase === 'ids' && Array.isArray(c.doneCats) && Array.isArray(c.ids)) return c;
    if (c.phase === 'one' && Array.isArray(c.ids) && Number.isInteger(c.next) && c.next >= 0) return c;
  } catch {
    // fall through
  }
  return null;
}

export function createCatalogJob(deps: CatalogJobDeps): CatalogJob {
  const { db, client } = deps;
  const pauseMs = deps.pauseMs ?? 300;
  const jobs = new Map<string, Job>();
  const noteUnknown = createUnknownNoter(deps.onLog);
  let seq = 0;
  let running: Job | null = null;
  let held = false;
  let latest: Job | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;

  const sleep =
    deps.sleep ??
    ((ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(() => {
          timer = null;
          wake = null;
          resolve();
        }, ms);
        timer.unref?.();
      }));

  const pause = (): Promise<void> => (pauseMs > 0 ? sleep(pauseMs) : Promise.resolve());

  async function run(job: Job): Promise<void> {
    let streak = 0;
    let first = true;
    const fails = readFailures(db);
    let abandoned = 0;
    const call = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (!first) await pause();
      first = false;
      if (stopped) throw new Error('stopped');
      return fn();
    };
    const update = (): void => {
      job.progress = job.total > 0 ? Math.min(1, job.done / job.total) : 0;
    };
    const skip = (): void => {
      job.skipped = (job.skipped ?? 0) + 1;
    };
    const saveCursor = (c: Cursor): void => stateSet(db, CURSOR_KEY, JSON.stringify(c));

    let cursor = readCursor(db);
    const haveCategories = leafCategoryIds(db).length > 0;
    if (cursor === null || !haveCategories) {
      const cats = await call(() => client.categories());
      // A broken answer must not wipe the tree the surau browses: refuse an empty, tiny, shrunken or huge list.
      const stored = catalogStats(db).categories;
      if (cats.length > MAX_CATEGORIES) throw new Error(`category list refused: ${cats.length} categories is over the ${MAX_CATEGORIES} cap`);
      if (cats.length < MIN_CATEGORIES || (stored >= MIN_CATEGORIES && cats.length * 2 < stored)) {
        throw new Error(`category list refused: ${cats.length} categories is not plausible (${stored} stored)`);
      }
      upsertCategories(db, cats, deps.now().toISOString());
      cursor = { phase: 'ids', doneCats: [], ids: [] };
      saveCursor(cursor);
    }

    if (cursor.phase === 'ids') {
      const leaves = leafCategoryIds(db);
      const ids = new Set(cursor.ids);
      const doneCats = new Set(cursor.doneCats);
      job.total = leaves.length;
      job.done = doneCats.size;
      update();
      const persist = (): void => saveCursor({ phase: 'ids', doneCats: [...doneCats], ids: [...ids] });
      let sinceSave = 0;
      try {
        for (const cat of leaves) {
          if (doneCats.has(cat)) continue;
          if ((fails.cats[cat] ?? 0) >= MAX_ATTEMPTS) {
            abandoned++;
            doneCats.add(cat);
            continue;
          }
          try {
            let more = false;
            for (let page = 1; page <= MAX_PAGES; page++) {
              const r = await call(() => client.list(cat, page, PER_PAGE));
              for (const it of r.items) ids.add(it.id);
              if (ids.size > MAX_IDS) throw new IdCapError();
              more = !(page >= r.lastPage || r.items.length === 0);
              if (!more) break;
            }
            if (more) {
              // MAX_PAGES reached with pages left: the category is incomplete, so the refresh is not complete
              skip();
            } else {
              delete fails.cats[cat];
            }
            streak = 0;
          } catch (err) {
            if (stopped || err instanceof IdCapError) throw err;
            // A category the API answers an error for (it sends 500 for an odd id) is skipped, never retried in a loop.
            skip();
            if (isDeterministic(err)) {
              fails.cats[cat] = (fails.cats[cat] ?? 0) + 1;
              streak = 0;
            } else {
              streak++;
              if (streak >= MAX_CONSECUTIVE_FAILURES) throw err;
            }
          }
          doneCats.add(cat);
          job.done = doneCats.size;
          update();
          if (++sinceSave >= CURSOR_EVERY) {
            persist();
            sinceSave = 0;
          }
        }
      } catch (err) {
        if (err instanceof IdCapError) {
          // a runaway list is not resumed into: the next start lists the categories again
          stateDelete(db, CURSOR_KEY);
        } else {
          persist();
        }
        writeFailures(db, fails);
        throw err;
      }
      const known = catalogIndex(db);
      const cutoff = deps.now().getTime() - STALE_MS;
      const todo = [...ids]
        .filter((id) => {
          const at = known.get(id);
          return at === undefined || Number.isNaN(Date.parse(at)) || Date.parse(at) < cutoff;
        })
        .sort((a, b) => Number(a) - Number(b));
      cursor = { phase: 'one', ids: todo, next: 0 };
      saveCursor(cursor);
      job.total = leaves.length + todo.length;
      job.done = leaves.length;
      update();
    } else {
      const leaves = leafCategoryIds(db).length;
      job.total = leaves + cursor.ids.length;
      job.done = leaves + cursor.next;
      update();
    }

    const ids = cursor.ids;
    const base = job.done - cursor.next;
    let streakStart = cursor.next;
    streak = 0;
    for (let i = cursor.next; i < ids.length; i++) {
      const id = ids[i]!;
      if ((fails.ids[id] ?? 0) >= MAX_ATTEMPTS) {
        abandoned++;
      } else {
        try {
          const h = await call(() => client.one(id));
          upsertHadith(db, h, deps.now().toISOString());
          noteUnknown(h);
          delete fails.ids[id];
          streak = 0;
        } catch (err) {
          if (stopped) {
            saveCursor({ phase: 'one', ids, next: i });
            writeFailures(db, fails);
            throw err;
          }
          skip();
          if (isDeterministic(err)) {
            // HadeethEnc answered and will answer the same again: count it, step past it, do not stall the run
            fails.ids[id] = (fails.ids[id] ?? 0) + 1;
            streak = 0;
          } else {
            if (streak === 0) streakStart = i;
            streak++;
            if (streak >= MAX_CONSECUTIVE_FAILURES) {
              saveCursor({ phase: 'one', ids, next: streakStart });
              writeFailures(db, fails);
              throw err;
            }
          }
        }
      }
      job.done = base + i + 1;
      update();
      if ((i + 1) % 10 === 0) saveCursor({ phase: 'one', ids, next: i + 1 });
    }
    writeFailures(db, fails);
    stateDelete(db, CURSOR_KEY);
    if (abandoned > 0) job.abandoned = abandoned;
    // Anything skipped (and not given up) means the refresh is incomplete: it stays due and the failed ones get another pass.
    if ((job.skipped ?? 0) === 0) stateSet(db, FULL_KEY, deps.now().toISOString());
    job.progress = 1;
  }

  return {
    start() {
      if (running || held) return 'busy';
      stopped = false;
      seq += 1;
      const job: Job = { id: `j${seq}`, state: 'running', progress: 0, done: 0, total: 0 };
      jobs.set(job.id, job);
      latest = job;
      while (jobs.size > MAX_JOBS) {
        const oldest = jobs.keys().next().value;
        if (oldest === undefined) break;
        jobs.delete(oldest);
      }
      running = job;
      void run(job)
        .then(() => {
          job.state = 'done';
        })
        .catch((err: unknown) => {
          job.state = 'failed';
          job.error = err instanceof HadeethEncError || err instanceof Error ? err.message.slice(0, 300) : 'crawl failed';
        })
        .finally(() => {
          if (running === job) running = null;
        });
      return job;
    },
    status: (id) => jobs.get(id) ?? null,
    current: () => running,
    last: () => latest,
    hold() {
      if (running || held) return null;
      held = true;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          held = false;
        }
      };
    },
    noteUnknown,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      const w = wake;
      wake = null;
      w?.();
    },
  };
}

/** More ids than the cap: the answer is not a hadis list. */
class IdCapError extends Error {
  constructor() {
    super(`too many hadis ids: over the ${MAX_IDS} cap`);
    this.name = 'IdCapError';
  }
}
