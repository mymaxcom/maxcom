import type { DatabaseSync } from 'node:sqlite';
import { gradeOf } from '@surau/core';
import { listItems, putProviderItem } from '../content/store.ts';
import { stateGet, stateSet, upsertHadith } from './catalog.ts';
import { createUnknownNoter, isDeterministic, shouldRefresh } from './catalogJob.ts';
import type { CatalogJob } from './catalogJob.ts';
import type { HadeethEncClient, HeHadith } from './hadeethenc.ts';
import { buildProviderItem, gradeSavable } from './providerItem.ts';

/** Weekly check of the saved HadeethEnc hadis: a changed text is flagged and waits for the Pentadbir (never applied by itself). */

const MAX_CONSECUTIVE_FAILURES = 8;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FIRST_RUN_MS = 10 * 60 * 1000;
const EVERY_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;

export interface PendingUpdate {
  title: string;
  textMs: string;
  intro: string | null;
  textAr: string;
  attributionAr: string;
  gradeAr: string;
  categories: string[];
  digest: string;
  fetchedAt: string;
}

export function pendingFrom(h: HeHadith, fetchedAt: string): PendingUpdate {
  return {
    title: h.title, textMs: h.textMs, intro: h.introMs, textAr: h.textAr, attributionAr: h.attributionAr,
    gradeAr: h.gradeAr, categories: h.categories, digest: h.digest, fetchedAt,
  };
}

/** A stored `new_json` as a PendingUpdate, or null when it is not the shape this box wrote. */
export function parsePending(json: unknown): PendingUpdate | null {
  if (typeof json !== 'string') return null;
  try {
    const p = JSON.parse(json) as Record<string, unknown>;
    const s = (k: string): string | null => (typeof p[k] === 'string' ? (p[k] as string) : null);
    const title = s('title');
    const textMs = s('textMs');
    const textAr = s('textAr');
    const attributionAr = s('attributionAr');
    const gradeAr = s('gradeAr');
    const digest = s('digest');
    const fetchedAt = s('fetchedAt');
    const intro = p.intro === null || typeof p.intro === 'string' ? (p.intro as string | null) : undefined;
    const categories = Array.isArray(p.categories) && p.categories.every((c) => typeof c === 'string') ? (p.categories as string[]) : null;
    if (title === null || textMs === null || textAr === null || attributionAr === null || gradeAr === null || digest === null ||
        fetchedAt === null || intro === undefined || categories === null) return null;
    return { title, textMs, intro, textAr, attributionAr, gradeAr, categories, digest, fetchedAt };
  } catch {
    return null;
  }
}

export interface UpdateCheckDeps {
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called after the check changed what the TV shows (a hadis hidden or shown again), so the kiosk reloads. */
  onChange?: () => void;
  /** Logs an unmapped grade or attribution once per text; pass the job's so the crawl and the check share one memory. */
  noteUnknown?: (h: { gradeAr: string; attributionAr: string }) => void;
}

const BLOCK_ACTOR = 'system:hadis-update';

/**
 * Sets or clears `ext.blocked` on a saved provider hadis through the box's own provider write path.
 * `shown` stays the person's choice. True when the row changed.
 */
function setBlocked(db: DatabaseSync, id: string, blocked: boolean): boolean {
  const item = listItems(db, 'hadis').find((h) => h.id === id);
  if (!item?.ext || (item.ext.blocked === true) === blocked) return false;
  const { updatedAt: _a, updatedBy: _b, ...rest } = item as unknown as Record<string, unknown>;
  const { blocked: _old, ...ext } = item.ext;
  putProviderItem(db, { ...rest, ext: blocked ? { ...ext, blocked: true } : ext }, BLOCK_ACTOR);
  return true;
}

/**
 * For every live hadis saved from HadeethEnc, reads it again (300 ms apart; stops after 8 failures in a row)
 * and compares the digest: a change is stored in `hadis_source_updates`, an unchanged text clears any flag.
 */
export async function checkProviderUpdates(
  db: DatabaseSync,
  client: HadeethEncClient,
  now: () => Date,
  onLog?: (action: string, detail: string) => void,
  opts: UpdateCheckDeps = {},
): Promise<{ checked: number; changed: number; aborted?: true }> {
  const pauseMs = opts.pauseMs ?? 300;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const saved = listItems(db, 'hadis').filter((h) => h.ext?.provider === 'hadeethenc');
  let checked = 0;
  let changed = 0;
  const noteUnknown = opts.noteUnknown ?? createUnknownNoter(onLog);
  let streak = 0;
  let first = true;
  let aborted = false;
  for (const item of saved) {
    const ext = item.ext!;
    if (!first && pauseMs > 0) await sleep(pauseMs);
    first = false;
    let h: HeHadith;
    try {
      h = await client.one(ext.id);
      streak = 0;
    } catch (err) {
      // HadeethEnc answered and will answer the same again (gone, odd reply): skip it, it does not count as an outage
      if (isDeterministic(err)) {
        streak = 0;
        continue;
      }
      streak++;
      if (streak >= MAX_CONSECUTIVE_FAILURES) {
        aborted = true;
        break;
      }
      continue;
    }
    checked++;
    const at = now().toISOString();
    try {
      upsertHadith(db, h, at);
    } catch {
      // the catalog is a convenience; the comparison below is what matters
    }
    // A grade that is blocked or unknown takes the item off the TV at once; text-only changes wait for the Pentadbir.
    const savable = gradeSavable(gradeOf(h.gradeAr));
    let visibilityChanged = false;
    if (h.digest !== ext.digest) {
      if (buildProviderItem(h, at).ok) {
        changed++;
        db.prepare(
          `INSERT INTO hadis_source_updates (item_id, provider, provider_id, new_json, found_at) VALUES (?, 'hadeethenc', ?, ?, ?)
           ON CONFLICT(item_id) DO UPDATE SET new_json = excluded.new_json, found_at = excluded.found_at`,
        ).run(item.id, ext.id, JSON.stringify(pendingFrom(h, at)), at);
      } else {
        // a new text MAXCOM cannot keep would sit pending for ever: say so once and leave the saved one
        db.prepare('DELETE FROM hadis_source_updates WHERE item_id = ?').run(item.id);
        onLog?.('hadis.updateTooLong', ext.id);
      }
      visibilityChanged = setBlocked(db, item.id, !savable);
    } else {
      db.prepare('DELETE FROM hadis_source_updates WHERE item_id = ?').run(item.id);
      visibilityChanged = setBlocked(db, item.id, false);
    }
    if (visibilityChanged) opts.onChange?.();
    noteUnknown(h);
  }
  // Stamped only when the check ran to the end: an aborted one is tried again soon, not in a week.
  if (aborted) return { checked, changed, aborted: true };
  stateSet(db, 'hadeethenc.lastUpdateCheck', now().toISOString());
  return { checked, changed };
}

export interface HadisTimerDeps {
  db: DatabaseSync;
  role: 'box' | 'cloud';
  client: HadeethEncClient;
  job: CatalogJob;
  now: () => Date;
  onLog?: (action: string, detail: string) => void;
  /** First run after this long (default 10 minutes), then every `everyMs` (default 6 hours). */
  firstMs?: number;
  everyMs?: number;
  /** Next run after a weekly check that gave up on an outage (default 1 hour). */
  retryMs?: number;
  /** Passed on to the weekly check. */
  check?: UpdateCheckDeps;
  /** Called when a check hid or showed a hadis again (the kiosk version is already bumped). */
  onChange?: () => void;
}

/**
 * Box role only: the monthly catalog refresh and the weekly update check, both skipped when HadeethEnc does
 * not answer. A `setTimeout` chain, so a slow run never overlaps the next one. Returns a stop function
 * (null on a cloud, which runs no timers).
 */
export function startHadisTimers(deps: HadisTimerDeps): (() => void) | null {
  if (deps.role !== 'box') return null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let running = false;

  const tick = async (): Promise<boolean> => {
    if (running || stopped) return false;
    running = true;
    let retrySoon = false;
    try {
      if (!(await deps.client.probe())) return false;
      const at = deps.now();
      stateSet(deps.db, 'hadeethenc.lastOnline', at.toISOString());
      if (shouldRefresh(deps.db, at)) deps.job.start();
      const last = stateGet(deps.db, 'hadeethenc.lastUpdateCheck');
      const lastMs = last === null ? NaN : Date.parse(last);
      if (Number.isNaN(lastMs) || at.getTime() - lastMs >= WEEK_MS) {
        // one shared flag: the check and a manual or monthly refresh never run together
        const release = deps.job.hold();
        if (release !== null) {
          try {
            const res = await checkProviderUpdates(deps.db, deps.client, deps.now, deps.onLog, {
              ...(deps.onChange ? { onChange: deps.onChange } : {}),
              noteUnknown: deps.job.noteUnknown,
              ...deps.check,
            });
            retrySoon = res.aborted === true;
          } finally {
            release();
          }
        }
      }
    } catch {
      // a failed run is tried again at the next tick
    } finally {
      running = false;
    }
    return retrySoon;
  };
  const schedule = (ms: number): void => {
    timer = setTimeout(() => {
      void tick().then((retrySoon) => {
        if (!stopped) schedule(retrySoon ? (deps.retryMs ?? RETRY_MS) : (deps.everyMs ?? EVERY_MS));
      });
    }, ms);
    timer.unref?.();
  };
  schedule(deps.firstMs ?? FIRST_RUN_MS);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
