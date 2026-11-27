import { randomBytes, hkdfSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CONTENT_KINDS, OPS_ROLES, VIDEO_MIME, isFeatureKey, isoInstantMs } from '@surau/core';
import type { FeedEntry } from '@surau/core';
import { getAssetPath } from '../assets/store.ts';
import { openSecret, sealSecret } from '../auth/crypto.ts';
import { boxId as boxIdOf, loadBoxKey, secretDir } from '../auth/secrets.ts';
import { listPhotoMeta } from '../finance/photos.ts';
import { allEntries, listFunds, listMonths, listPerihal } from '../finance/store.ts';
import { LINK_ID_RE } from '../link/journal.ts';
import { CLOUD_RESET_REL } from '../link/setAside.ts';
import { snapshotCorrections } from '../prayer/corrections.ts';
import { snapshotImports } from '../prayer/importFile.ts';
import { readFieldStamps, sanitizeStamps } from '../settingsStore.ts';
import { LOCAL_SURAU_ID } from '../tenant.ts';
import { BOX_REPORT_HEADERS, assetIdsIn, cloudFetch, hmacSig, wakeMessage } from './agent.ts';
import { signBoxCall } from './boxCall.ts';
import { headSeq } from './routes.ts';
import { loadSyncKey, normaliseCloudUrl } from './syncKey.ts';
import type { SyncKeyData } from './syncKey.ts';
import { LAST_PUSH_SEQ_KEY } from './trim.ts';

/**
 * The box side of reset-from-box and of the follower's sleep (multi-box 2B, B4; contract
 * `docs/design/plans/2026-11-23-cloud-sleep-reset-contract.md`, section "Box side").
 *
 * - `buildResetState`: the box's own rows as the feed shape the cloud's `parseResetBody` takes (one entry per row).
 * - `createCloudResetLoop`: while `link-cloud-reset.json` exists, sends that state (signed, `boxCall.ts`), uploads the
 *   assets the cloud says it lacks, moves the sync cursors over what is now equal, removes the mark, and tells the
 *   caller so it can start the sync agent without a restart.
 * - `markCloudSleep` / `createCloudSleepSender`: a box that became a follower keeps (sealed) what it needs to tell the
 *   cloud, once, that its surau now sleeps; its own `secret/sync.key` is set aside at its next start.
 *
 * Nothing here logs a token, a key or a body: only fixed codes and counts.
 */

export const CLOUD_SLEEP_REL = 'secret/link-cloud-sleep.json';
export const RESET_PATH = '/api/sync/reset-from-box';
export const SLEEP_PATH = '/api/sync/sleep';
export const WAKE_PATH = '/api/sync/wake';
/** Backoff between tries: 1, 5, 15 minutes, then every 60. */
export const RESET_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
const DAY_MS = 24 * 3_600_000;
const RESET_TIMEOUT_MS = 10 * 60_000;
const CALL_TIMEOUT_MS = 30_000;
const ASSET_TIMEOUT_MS = 120_000;
const WAKE_TRIES = 5;
const WAKE_WAIT_MS = 15_000;
/** The cloud refuses these for good: sending the same state again cannot change the answer. */
const STOP_CODES: ReadonlySet<string> = new Set(['bad_state', 'foreign_id', 'surau_asleep', 'forbidden', 'last_admin']);
const ACTOR_RE = /^[A-Za-z0-9:_@.|-]{1,120}$/;
const DEVICE_PLATFORMS: readonly string[] = ['android', 'ios-web', 'web'];
const SCOPE_ALL = { users: true, devices: true, keys: true, finance: true, financeWrite: true, contentWrite: true } as const;

type Row = Record<string, unknown>;
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export interface ResetState {
  entries: FeedEntry[];
  assets: string[];
}

// ---- the state --------------------------------------------------------------------------------------------------------

/**
 * The box's own surau as a reset state. Rows come from the tables (not from the change log, which is trimmed and holds
 * history): live content, settings (never `appLock`), prayer imports and corrections, finance lookups, months, entries
 * and photo records, the surau's own people (never a `'*'` person, never a role of the operator) and the phones that
 * hold a key. Every entry is `origin: 'local'` with the row's real `rev` and edit time; `opId` is always null.
 * The asset list is every asset id the content, settings and people point to, minus the ones the box knows to be videos.
 */
export function buildResetState(db: DatabaseSync, _boxId: string, now: Date = new Date()): ResetState {
  const surauId = LOCAL_SURAU_ID;
  const nowIso = now.toISOString();
  const entries: FeedEntry[] = [];
  let n = 0;
  const instant = (v: unknown, fallback: string): string => (typeof v === 'string' && isoInstantMs(v) !== null ? v : fallback);
  const actorOf = (v: unknown): string => (typeof v === 'string' && ACTOR_RE.test(v) ? v : 'local');
  const add = (entity: string, entityId: string, editedAt: string, after: unknown, rev: unknown, actor: unknown, stamps?: unknown): void => {
    const at = instant(editedAt, nowIso);
    const e: FeedEntry = {
      seq: ++n, entity, entityId, rev: text(rev) !== null && String(rev).length <= 200 ? String(rev) : `${at}|local`, editedAt: at, syncedAt: at,
      actor: actorOf(actor), deviceId: null, origin: 'local', opId: null, after,
    };
    if (stamps !== undefined) e.stamps = stamps as FeedEntry['stamps'];
    entries.push(e);
  };

  // content: live items only (a delete is the absence of the row; the cloud replaces the surau's items)
  for (const r of db.prepare('SELECT kind, id, json, updated_at, updated_by, rev, edited_at FROM content_items WHERE surau_id = ? AND deleted_at IS NULL ORDER BY kind, id').all(surauId)) {
    const kind = String(r.kind);
    if (!(CONTENT_KINDS as readonly string[]).includes(kind)) continue;
    const item = parseJson(r.json);
    if (!isPlain(item)) continue;
    add(`content:${kind}`, String(r.id), String(r.edited_at ?? r.updated_at), item, r.rev, r.updated_by);
  }

  // settings: not the app lock (a live, per-box decision), only features this build knows
  for (const r of db.prepare('SELECT feature, json, updated_at, updated_by, rev, edited_at FROM settings WHERE surau_id = ? ORDER BY feature').all(surauId)) {
    const feature = String(r.feature);
    if (feature === 'appLock' || !isFeatureKey(feature)) continue;
    const value = parseJson(r.json);
    if (!isPlain(value)) continue;
    const stamps = readFieldStamps(db, feature, surauId);
    add('settings', feature, String(r.edited_at ?? r.updated_at), value, r.rev, r.updated_by, Object.keys(stamps).length > 0 && sanitizeStamps(stamps, (t) => t) !== null ? stamps : undefined);
  }

  // prayer: file imports and corrections (the official days are the cloud's own fetch)
  for (const it of snapshotImports(db, surauId)) {
    add('prayer:import', it.record.id, it.editedAt, { record: it.record, days: it.days }, it.rev, it.record.actor);
  }
  for (const c of snapshotCorrections(db, surauId)) {
    add('prayer:correction', `${c.date}|${c.prayer}`, c.editedAt, { date: c.date, prayer: c.prayer, time: c.time, reason: c.reason, officialAtCorrection: c.officialAtCorrection }, c.rev, c.actor);
  }

  // finance: lookups, months, the ledger and the photo records (the cloud keeps every entry it already has)
  const stamp = (table: string, keyCol: string): Map<string, Row> => {
    const m = new Map<string, Row>();
    for (const r of db.prepare(`SELECT ${keyCol} AS k, rev, edited_at FROM ${table} WHERE surau_id = ?`).all(surauId)) m.set(String(r.k), r);
    return m;
  };
  const funds = stamp('finance_funds', 'id');
  for (const f of listFunds(db, { includeArchived: true }, surauId)) {
    const s = funds.get(f.id);
    add('finance:fund', f.id, String(s?.edited_at ?? f.updatedAt), f, s?.rev, f.updatedBy);
  }
  const perihal = stamp('finance_perihal', 'id');
  for (const p of listPerihal(db, { includeArchived: true }, surauId)) {
    const s = perihal.get(p.id);
    add('finance:perihal', p.id, String(s?.edited_at ?? p.updatedAt), p, s?.rev, p.updatedBy);
  }
  const months = new Map<string, Row>();
  for (const r of db.prepare('SELECT ym, rev, edited_at, closed_by FROM finance_months WHERE surau_id = ?').all(surauId)) months.set(String(r.ym), r);
  for (const m of listMonths(db, surauId)) {
    const s = months.get(m.ym);
    add('finance:month', m.ym, String(s?.edited_at ?? m.closedAt ?? nowIso), m, s?.rev, s?.closed_by);
  }
  const ledger = stamp('finance_entries', 'id');
  for (const e of allEntries(db, surauId)) {
    const s = ledger.get(e.id);
    add('finance:entry', e.id, String(s?.edited_at ?? e.editedAt), e, s?.rev, e.createdBy);
  }
  for (const ph of listPhotoMeta(db, surauId)) add('finance:photo', ph.id, nowIso, ph, undefined, 'local');

  // people: the surau's own, live, with no operator role
  const people = new Set<string>();
  for (const r of db.prepare('SELECT id, name, roles_json, active, created_at, rev, edited_at, no, no_src, phone FROM users WHERE surau_id = ? AND deleted_at IS NULL ORDER BY created_at, id').all(surauId)) {
    const roles = parseJson(r.roles_json);
    if (!Array.isArray(roles) || roles.some((x) => typeof x !== 'string' || (OPS_ROLES as readonly string[]).includes(x))) continue;
    const at = String(r.edited_at ?? r.created_at);
    const after: Record<string, unknown> = { name: String(r.name), roles, active: Number(r.active) === 1 };
    if (typeof r.phone === 'string') after.phone = r.phone;
    const no = Number(r.no);
    if (Number.isInteger(no) && no >= 1 && no < 1_000_000_000 && (r.no_src === 'b' || r.no_src === 'c')) {
      after.no = no;
      after.noSrc = r.no_src;
    }
    people.add(String(r.id));
    add('user', String(r.id), at, after, r.rev, 'local');
  }

  // phones: live, with a key, of a person that is in the state
  for (const r of db.prepare('SELECT id, user_id, name, platform, enrolled_at, public_jwk, no, no_src FROM devices WHERE surau_id = ? AND revoked_at IS NULL AND public_jwk IS NOT NULL ORDER BY enrolled_at, id').all(surauId)) {
    const platform = String(r.platform);
    const jwk = parseJson(r.public_jwk);
    if (!DEVICE_PLATFORMS.includes(platform) || !people.has(String(r.user_id)) || !isPlain(jwk)) continue;
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') continue;
    const after: Record<string, unknown> = {
      id: String(r.id), userId: String(r.user_id), name: String(r.name), platform, revoked: false,
      publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, enrolledAt: instant(r.enrolled_at, nowIso),
    };
    const no = Number(r.no);
    if (Number.isInteger(no) && no >= 1 && no < 1_000_000_000 && (r.no_src === 'b' || r.no_src === 'c')) {
      after.no = no;
      after.noSrc = r.no_src;
    }
    add('device', String(r.id), String(after.enrolledAt), after, undefined, 'local');
  }

  // assets: what the content, the settings and the people point to (a video file never goes to the cloud)
  const found = new Set<string>();
  for (const e of entries) if (e.entity.startsWith('content:') || e.entity === 'settings' || e.entity === 'user') assetIdsIn(e.after, found);
  const assets: string[] = [];
  for (const id of found) {
    const row = db.prepare('SELECT mime FROM assets WHERE id = ?').get(id);
    if (row !== undefined && row.mime === VIDEO_MIME) continue;
    assets.push(id);
  }
  assets.sort();
  return { entries, assets };
}

function parseJson(v: unknown): unknown {
  if (typeof v !== 'string') return null;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return null;
  }
}

// ---- shared pieces ---------------------------------------------------------------------------------------------------

interface Wait {
  sleep: (ms: number) => Promise<void>;
  /** Wakes a sleeping wait (stop). */
  cancel: () => void;
}

/** A sleep that `stop()` can cut short (the real one is a timer that never holds the process open). */
function makeWait(custom?: (ms: number) => Promise<void>): Wait {
  let wake: (() => void) | null = null;
  return {
    sleep: (ms) => {
      if (custom !== undefined) return custom(ms);
      return new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          wake = null;
          resolve();
        }, ms);
        t.unref();
        wake = () => {
          clearTimeout(t);
          wake = null;
          resolve();
        };
      });
    },
    cancel: () => wake?.(),
  };
}

const nonce = (): string => randomBytes(16).toString('base64url');

function baseUrlOf(key: SyncKeyData | { cloudUrl: string }, override: string | null | undefined): string {
  const o = override ? normaliseCloudUrl(override) : null;
  return o ?? key.cloudUrl;
}

interface Answer {
  status: number;
  code: string | null;
  json: Row | null;
  retryAfterMs: number | null;
}

async function readAnswer(res: Response): Promise<Answer> {
  let json: Row | null = null;
  try {
    const j = (await res.json()) as unknown;
    json = isPlain(j) ? j : null;
  } catch {
    json = null;
  }
  const ra = Number(res.headers.get('retry-after'));
  return { status: res.status, code: typeof json?.code === 'string' ? json.code : null, json, retryAfterMs: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 120) * 1000 : null };
}

/** A signed JSON POST to the cloud (sign the exact bytes sent). Throws on a transport fault. */
async function signedPost(
  fetchImpl: typeof fetch, base: string, path: string, key: { siteToken: string; privateJwk: SyncKeyData['privateJwk'] }, boxId: string, body: string, now: Date, timeoutMs: number,
): Promise<Answer> {
  const sig = signBoxCall(key.privateJwk, { method: 'POST', path, boxId, body, now, nonce: nonce() });
  const res = await fetchImpl(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.siteToken}`, ...BOX_REPORT_HEADERS, ...sig },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  return readAnswer(res);
}

// ---- the reset loop ---------------------------------------------------------------------------------------------------

export interface CloudResetLoopOptions {
  db: DatabaseSync;
  dataDir: string;
  boxId: string;
  now: () => Date;
  fetchImpl?: typeof fetch;
  /** Operator override of the cloud address (as the sync agent's). */
  cloudUrl?: string | null;
  workerUrl?: string | null;
  sleep?: (ms: number) => Promise<void>;
  /** Wait before the first try (default 5 s: the box is still starting). */
  initialDelayMs?: number;
  /** Called once, after the mark was removed. */
  onDone: () => void;
  log?: (line: string) => void;
}

export interface CloudLoop {
  start(): void;
  stop(): void;
  /** Resolves when the loop has ended (done, stopped for good, or `stop()`); for tests. */
  finished(): Promise<void>;
}

interface ResetMark {
  linkId: string;
  /** `restore`: a restore (an unlink "back", a follower's own revert); `adopt`: cases X / N-X; `reduce`: a follower carrying on alone. */
  reason: 'restore' | 'adopt' | 'reduce';
}

function readResetMark(dataDir: string): ResetMark | null {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, CLOUD_RESET_REL), 'utf8')) as Row;
    if (typeof j.linkId !== 'string' || !LINK_ID_RE.test(j.linkId) || (j.reason !== 'restore' && j.reason !== 'adopt' && j.reason !== 'reduce')) return null;
    return { linkId: j.linkId, reason: j.reason };
  } catch {
    return null;
  }
}

export function createCloudResetLoop(o: CloudResetLoopOptions): CloudLoop {
  const log = o.log ?? ((): void => undefined);
  const fetchImpl = o.fetchImpl ?? cloudFetch(o.dataDir);
  const wait = makeWait(o.sleep);
  let stopped = true;
  let run: Promise<void> = Promise.resolve();

  const setState = (key: string, value: string | null): void => {
    if (value === null) o.db.prepare('DELETE FROM sync_state WHERE key = ?').run(key);
    else o.db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  };

  /** Best effort: the Worker starts the cloud's machine on a signed `/wake` (the sync agent's own call). */
  const wakeCloud = async (key: SyncKeyData): Promise<void> => {
    try {
      const ts = o.now().getTime();
      const base = (o.workerUrl ? normaliseCloudUrl(o.workerUrl) : null) ?? key.workerUrl ?? baseUrlOf(key, o.cloudUrl);
      const res = await fetchImpl(`${base}/wake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Maxcom-Site': o.boxId, 'X-Maxcom-Ts': String(ts), 'X-Maxcom-Sig': hmacSig(key.wakeSecret, wakeMessage(o.boxId, ts)) },
        body: '{}',
        redirect: 'manual',
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      await res.arrayBuffer().catch(() => undefined);
    } catch {
      /* the retry decides */
    }
  };

  /** One call; a 503 `waking` wakes the cloud and tries again a few times (the answer says how long to wait). */
  const callCloud = async (key: SyncKeyData, send: () => Promise<Answer>): Promise<Answer> => {
    for (let attempt = 1; ; attempt++) {
      const a = await send();
      if (a.status !== 503 || (a.retryAfterMs === null && a.json?.state !== 'waking') || attempt >= WAKE_TRIES || stopped) return a;
      await wakeCloud(key);
      await wait.sleep(a.retryAfterMs ?? WAKE_WAIT_MS);
      if (stopped) return a;
    }
  };

  type Step = { kind: 'done' } | { kind: 'stop'; code: string } | { kind: 'retry'; waitMs?: number; why?: string };
  let sent: { seq: number; pending: string[]; head: number } | null = null;
  /** A box that left a link put its own surau to sleep then: it wakes it before the reset (only the sleeper may). */
  let woke = false;

  const attempt = async (): Promise<Step> => {
    const mark = readResetMark(o.dataDir);
    if (mark === null) return { kind: 'stop', code: 'bad_mark' };
    let key: SyncKeyData | null;
    try {
      key = loadSyncKey(o.dataDir);
    } catch {
      return { kind: 'stop', code: 'bad_key' };
    }
    if (key === null) return { kind: 'stop', code: 'no_key' };
    const base = baseUrlOf(key, o.cloudUrl);

    if (sent === null && !woke && (mark.reason === 'restore' || mark.reason === 'reduce')) {
      let w: Answer;
      try {
        const body = JSON.stringify({ linkId: mark.linkId, reason: mark.reason === 'reduce' ? 'unlink-on' : 'unlink-back' });
        w = await callCloud(key, () => signedPost(fetchImpl, base, WAKE_PATH, key!, o.boxId, body, o.now(), CALL_TIMEOUT_MS));
      } catch {
        return { kind: 'retry' };
      }
      // 200: awake now, or it was not asleep; 403 `not_sleeper`: another box's sleep, the reset below says so for good
      if (w.status === 200 || (w.status === 403 && w.code === 'not_sleeper')) woke = true;
      else if (w.status === 401 || w.status === 403) return { kind: 'stop', code: w.code ?? `http_${w.status}` };
      else return { kind: 'retry', why: w.code ?? `http_${w.status}` };
    }

    if (sent === null) {
      // the change-log head is read in the same turn as the state, so nothing written after it is skipped later
      const head = headSeq(o.db, SCOPE_ALL);
      const state = buildResetState(o.db, o.boxId, o.now());
      const payload = JSON.stringify({ linkId: mark.linkId, reason: mark.reason, state });
      let a: Answer;
      try {
        a = await callCloud(key, () => signedPost(fetchImpl, base, RESET_PATH, key!, o.boxId, payload, o.now(), RESET_TIMEOUT_MS));
      } catch {
        return { kind: 'retry' };
      }
      if (a.status === 200 && a.json?.ok === true && typeof a.json.seq === 'number' && Number.isSafeInteger(a.json.seq)) {
        const missing = Array.isArray(a.json.missing) ? (a.json.missing as unknown[]).filter((x): x is string => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)) : [];
        sent = { seq: a.json.seq, pending: missing, head };
        log(`Link: the cloud copy now equals this box (${state.entries.length} rows, ${missing.length} files to send)`);
      } else if (a.status === 429 && a.code === 'reset_limit') {
        return { kind: 'retry', waitMs: DAY_MS };
      } else if (a.status === 400 || a.status === 413 || (a.code !== null && STOP_CODES.has(a.code))) {
        return { kind: 'stop', code: a.code ?? `http_${a.status}` };
      } else {
        // 5xx, `waking`, `backup_unavailable`, `live_open`, a clock or replay refusal, no answer: try again later
        return { kind: 'retry', why: a.code ?? `http_${a.status}` };
      }
    }

    // the reset is done on the cloud: the files it lacks, then the cursors
    while (sent.pending.length > 0) {
      if (stopped) return { kind: 'retry' };
      const id = sent.pending[0]!;
      const local = getAssetPath(o.db, o.dataDir, id);
      if (local === null || local.mime === VIDEO_MIME) {
        sent.pending.shift();
        continue;
      }
      try {
        const res = await callCloud(key, async () => readAnswer(await fetchImpl(`${base}/api/sync/assets/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': local.mime, Authorization: `Bearer ${key!.siteToken}`, ...BOX_REPORT_HEADERS },
          body: readFileSync(local.path),
          redirect: 'manual',
          signal: AbortSignal.timeout(ASSET_TIMEOUT_MS),
        })));
        // a file the cloud refuses (4xx) must not hold the rest back; transport and 5xx try again
        if (res.status >= 500) return { kind: 'retry' };
      } catch {
        return { kind: 'retry' };
      }
      sent.pending.shift();
    }
    setState('last_pull_seq', String(sent.seq));
    setState(LAST_PUSH_SEQ_KEY, String(sent.head));
    setState('last_error', null);
    rmSync(join(o.dataDir, CLOUD_RESET_REL), { force: true });
    return { kind: 'done' };
  };

  const loop = async (): Promise<void> => {
    if ((o.initialDelayMs ?? 5_000) > 0) await wait.sleep(o.initialDelayMs ?? 5_000);
    let failures = 0;
    while (!stopped) {
      let step: Step;
      try {
        step = await attempt();
      } catch {
        step = { kind: 'retry' };
      }
      if (stopped) return;
      if (step.kind === 'done') {
        o.onDone();
        return;
      }
      if (step.kind === 'stop') {
        log(`Link: the cloud copy could not be made equal to this box (${step.code}); sync stays held`);
        if (step.code !== 'bad_mark' && step.code !== 'bad_key' && step.code !== 'no_key') setState('last_error', `cloud_not_equal:${step.code}`.slice(0, 80));
        return;
      }
      log(`Link: the cloud copy is not equal yet (${step.why ?? 'retry'}); trying again later`);
      let ms: number;
      if (step.waitMs !== undefined) ms = step.waitMs;
      else {
        failures += 1;
        ms = RESET_BACKOFF_MS[Math.min(failures, RESET_BACKOFF_MS.length) - 1]!;
      }
      await wait.sleep(ms);
    }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      sent = null;
      run = loop().catch(() => undefined);
    },
    stop() {
      stopped = true;
      wait.cancel();
    },
    finished: () => run,
  };
}

// ---- the follower's sleep ---------------------------------------------------------------------------------------------

/** Key for the sleep mark: HKDF of the box master key, its own domain. */
function sleepMarkKey(boxKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', boxKey, Buffer.alloc(0), 'cloud-sleep-mark', 32));
}

interface SleepMark {
  v: 1;
  linkId: string;
  siteToken: string;
  privateJwk: SyncKeyData['privateJwk'];
  boxId: string;
  cloudUrl: string;
}

/**
 * Keep what a follower needs to put its surau to sleep on the cloud, sealed with the box key, in
 * `secret/link-cloud-sleep.json` (mode 0600, atomic). Only a box that has a sync key writes one. Returns whether a mark
 * was written. Never throws for "no sync key"; a damaged key or a write fault throws (the caller logs one line).
 */
export function markCloudSleep(dataDir: string, linkId: string, boxId?: string): boolean {
  if (!LINK_ID_RE.test(linkId)) return false;
  const key = loadSyncKey(dataDir);
  if (key === null) return false;
  const mark: SleepMark = { v: 1, linkId, siteToken: key.siteToken, privateJwk: key.privateJwk, boxId: boxId ?? boxIdOf(dataDir), cloudUrl: key.cloudUrl };
  const path = join(dataDir, CLOUD_SLEEP_REL);
  mkdirSync(secretDir(dataDir), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, sealSecret(sleepMarkKey(loadBoxKey(dataDir)), JSON.stringify(mark)), { mode: 0o600 });
  renameSync(tmp, path);
  return true;
}

export const cloudSleepOwed = (dataDir: string): boolean => existsSync(join(dataDir, CLOUD_SLEEP_REL));

function readSleepMark(dataDir: string): SleepMark | null {
  try {
    const j = JSON.parse(openSecret(sleepMarkKey(loadBoxKey(dataDir)), readFileSync(join(dataDir, CLOUD_SLEEP_REL), 'utf8').trim())) as Row;
    const cloudUrl = typeof j.cloudUrl === 'string' ? normaliseCloudUrl(j.cloudUrl) : null;
    if (j.v !== 1 || typeof j.linkId !== 'string' || !LINK_ID_RE.test(j.linkId) || typeof j.siteToken !== 'string' || j.siteToken === '' || !isPlain(j.privateJwk)
      || typeof j.boxId !== 'string' || !/^[0-9a-f]{16}$/.test(j.boxId) || cloudUrl === null) return null;
    return { v: 1, linkId: j.linkId, siteToken: j.siteToken, privateJwk: j.privateJwk as SleepMark['privateJwk'], boxId: j.boxId, cloudUrl };
  } catch {
    return null;
  }
}

export interface CloudSleepSenderOptions {
  dataDir: string;
  now: () => Date;
  fetchImpl?: typeof fetch;
  cloudUrl?: string | null;
  sleep?: (ms: number) => Promise<void>;
  initialDelayMs?: number;
  log?: (line: string) => void;
}

/**
 * While `secret/link-cloud-sleep.json` exists, tells the cloud once that this box's surau sleeps (signed
 * `POST /api/sync/sleep {linkId, reason:'link'}`). 200 removes the mark. 409 `surau_asleep` (another box put it to sleep
 * first) is logged and the mark removed. 401 or 403 is logged and the mark kept: it stops until the next start. Anything
 * else is tried again after 1, 5, 15, then every 60 minutes.
 */
export function createCloudSleepSender(o: CloudSleepSenderOptions): CloudLoop {
  const log = o.log ?? ((): void => undefined);
  const fetchImpl = o.fetchImpl ?? cloudFetch(o.dataDir);
  const wait = makeWait(o.sleep);
  let stopped = true;
  let run: Promise<void> = Promise.resolve();
  const remove = (): void => rmSync(join(o.dataDir, CLOUD_SLEEP_REL), { force: true });

  const loop = async (): Promise<void> => {
    if ((o.initialDelayMs ?? 5_000) > 0) await wait.sleep(o.initialDelayMs ?? 5_000);
    let failures = 0;
    while (!stopped) {
      if (!cloudSleepOwed(o.dataDir)) return;
      const mark = readSleepMark(o.dataDir);
      if (mark === null) {
        log('Link: the note to put the cloud copy to sleep cannot be read; it is kept');
        return;
      }
      let a: Answer | null = null;
      try {
        a = await signedPost(fetchImpl, baseUrlOf(mark, o.cloudUrl), SLEEP_PATH, mark, mark.boxId, JSON.stringify({ linkId: mark.linkId, reason: 'link' }), o.now(), CALL_TIMEOUT_MS);
      } catch {
        a = null;
      }
      if (stopped) return;
      if (a !== null && a.status === 200) {
        remove();
        log('Link: the cloud copy of this surau was put to sleep');
        return;
      }
      if (a !== null && a.status === 409 && a.code === 'surau_asleep') {
        remove();
        log('Link: the cloud copy of this surau was already put to sleep by another box');
        return;
      }
      if (a !== null && (a.status === 401 || a.status === 403)) {
        log(`Link: the cloud refused to put this surau to sleep (${a.code ?? `http_${a.status}`}); it is tried again at the next start`);
        return;
      }
      failures += 1;
      await wait.sleep(RESET_BACKOFF_MS[Math.min(failures, RESET_BACKOFF_MS.length) - 1]!);
    }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      run = loop().catch(() => undefined);
    },
    stop() {
      stopped = true;
      wait.cancel();
    },
    finished: () => run,
  };
}
