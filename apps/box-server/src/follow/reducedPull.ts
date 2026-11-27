import type { IncomingMessage } from 'node:http';
import { MIGRATIONS } from '../migrations/index.ts';
import type { PinnedClient } from '../link/peerClient.ts';
import { planReduce } from '../link/reduce.ts';
import { signLink } from '../link/sign.ts';
import { collectPages, pullStore, stageDirOf, StoreMoveError, STORE_TOKEN_HEADER, sweepStage } from '../link/storeMove.ts';
import type { MoveList } from '../link/storeMove.ts';
import type { BoxIdentity } from '../setup/identity.ts';
import { DEFAULT_FLOOR_BYTES } from './cache.ts';
import type { FollowRecord } from './store.ts';

/**
 * "Teruskan dengan data sekarang" at a FOLLOWER (multi-box phase 2D, D3), after the master's signed `standalone`
 * order was taken: the box asks its master for its reduced copy (a request signed `store-list` by this box's identity
 * key, with its free bytes so videos that do not fit are left out at the master), pulls every listed file over the
 * pinned channel into `linkstage/<unlinkId>/` (each accepted only when its size and hash match the list), then plans
 * the `reduce` op that runs on it at the next start (`link/reduce.ts`). SECURITY code.
 *
 * Nothing in this box's store changes here. A failure removes the stage; the master's session ends `failed` at its
 * deadline and this box keeps its local way back (`/api/follow/revert`).
 */

const POLL_MS = 2000;
/** The master makes the copy: how long the list may stay `preparing`. */
const LIST_TIMEOUT_MS = 10 * 60_000;
/** A dropped pull is tried again within the master's work window. */
const TRIES = 4;

export interface ReducedPullDeps {
  dataDir: string;
  identity: BoxIdentity;
  boxId: string;
  rec: FollowRecord;
  unlinkId: string;
  /** The master's addresses (the order's and the follow record's). */
  addresses: string[];
  client: Pick<PinnedClient, 'json' | 'request'>;
  freeBytes: () => number | null;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (percent: number) => void;
  /** This box's own name and its master's (kept with the data of link day). */
  followerName: string;
  log?: (event: string) => void;
}

/** True when the copy landed and the reduce op is planned for the next start. */
export async function pullReducedCopy(d: ReducedPullDeps): Promise<boolean> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = d.log ?? (() => undefined);
  for (let attempt = 0; attempt < TRIES; attempt++) {
    if (attempt > 0) await sleep(Math.min(5 * 60_000, 30_000 * 2 ** (attempt - 1)));
    const r = await once(d, sleep, log);
    if (r === 'ok') return true;
    if (r === 'refused') break;
  }
  sweepStage(d.dataDir, null);
  return false;
}

async function once(d: ReducedPullDeps, sleep: (ms: number) => Promise<void>, log: (e: string) => void): Promise<'ok' | 'refused' | 'again'> {
  const free = d.freeBytes();
  const freeBytes = free !== null && Number.isSafeInteger(Math.floor(free)) && free >= 0 ? Math.floor(free) : null;
  /** The signed request for one page of the list (the list is built once at the master and read in pages). */
  let oldForm = false;
  const request = (page: number): string => {
    // `oldForm`: the form of the previous release (no `page`), used once when the master refuses the new form
    const body = { unlinkId: d.unlinkId, boxId: d.boxId, freeBytes, ...(oldForm ? {} : { page }) };
    return JSON.stringify({ body, sig: signLink(d.identity, 'store-list', d.rec.linkId, body) });
  };
  let origin: string | null = null;
  let ready: { first: unknown; token: string } | null = null;
  const deadline = d.now().getTime() + LIST_TIMEOUT_MS;
  for (const o of d.addresses) {
    try {
      for (;;) {
        const r = await d.client.json(o, d.rec.masterCa, {
          method: 'POST', path: '/api/unlink/peer/store/list', headers: { 'content-type': 'application/json' }, body: request(0),
        });
        const j = (typeof r.json === 'object' && r.json !== null ? r.json : {}) as Record<string, unknown>;
        // the master no longer gives a copy (the session ended, or this box already reported)
        // a master of the previous release knows no `page` and answers the new form with 400: ask once the old way
        if (r.status === 400 && !oldForm) {
          oldForm = true;
          continue;
        }
        if (r.status === 400 || r.status === 409) {
          log(j.code === 'version' ? 'reduce_copy_version' : 'reduce_copy_refused');
          return 'refused';
        }
        if (r.status !== 200) break;
        if (j.state === 'ready') {
          if (typeof j.token !== 'string') return 'again';
          ready = { first: j, token: j.token };
          origin = o;
          break;
        }
        if (j.state !== 'preparing' || d.now().getTime() > deadline) return 'again';
        await sleep(POLL_MS);
      }
    } catch {
      // the next address
    }
    if (ready !== null) break;
  }
  if (ready === null || origin === null) return 'again';
  const { token } = ready;
  const from = origin;
  let list: MoveList;
  try {
    list = await collectPages(ready.first, async (page) => {
      const r = await d.client.json(from, d.rec.masterCa, {
        method: 'POST', path: '/api/unlink/peer/store/list', headers: { 'content-type': 'application/json' }, body: request(page),
      });
      if (r.status !== 200 || typeof r.json !== 'object' || r.json === null || (r.json as Record<string, unknown>).state !== 'ready') throw new StoreMoveError('peer');
      return r.json;
    }, d.unlinkId);
  } catch {
    log('reduce_copy_list_bad');
    return 'again';
  }
  // the received database is opened as it is: both boxes run one level
  if (list.dbLevel !== MIGRATIONS.length) {
    log('reduce_copy_level');
    return 'refused';
  }
  try {
    await pullStore({
      list, stageDir: stageDirOf(d.dataDir, d.unlinkId),
      fetch: (path, start): Promise<IncomingMessage> => {
        const q = new URLSearchParams({ unlinkId: d.unlinkId, path }).toString();
        return d.client.request(from, d.rec.masterCa, {
          method: 'GET', path: `/api/unlink/peer/store/file?${q}`,
          headers: { [STORE_TOKEN_HEADER]: token, ...(start > 0 ? { range: `bytes=${start}-` } : {}) },
          timeoutMs: 60_000,
        });
      },
      freeBytes: d.freeBytes,
      floorBytes: DEFAULT_FLOOR_BYTES,
      sleep,
      onProgress: (done, total) => d.onProgress?.(total <= 0 ? 99 : Math.min(99, Math.floor((done * 100) / total))),
    });
  } catch {
    log('reduce_copy_pull_failed');
    return 'again';
  }
  try {
    planReduce(d.dataDir, { v: 1, linkId: d.rec.linkId, unlinkId: d.unlinkId, list, followerName: d.followerName, masterName: d.rec.masterName }, d.now());
  } catch {
    log('reduce_plan_failed');
    return 'refused';
  }
  return 'ok';
}
