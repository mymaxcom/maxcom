/**
 * The persisted record of the box's live sessions (table `live_sessions`, migration 031). The interface was frozen in
 * Lane 0 of the 2026.11.15 Siaran langsung revamp; `createLiveSessionStore` below is the store over the database.
 * `live/sessions.ts` writes through it, and the YouTube and upload routes read through it.
 *
 * Everything here is PER BOX: a box records its own lives and its own YouTube channel id. Nothing here is a secret
 * (no stream key, token or camera address), and `ownerDeviceId` never leaves the box.
 */
import type { DatabaseSync } from 'node:sqlite';
import { LIVE_SESSIONS_RECENT_MAX, isLiveGap } from '@surau/core';
import type { LiveGap, LiveSessionRecord } from '@surau/core';

/** What is known when a live starts. The rest of `LiveSessionRecord` starts empty: no stop, no broadcast, no gap. */
export type LiveSessionStart = Omit<LiveSessionRecord, 'stoppedAt' | 'reason' | 'broadcastIds' | 'gaps' | 'gapSeconds'>;

export interface LiveSessionStore {
  /** Writes the row of a live that just started. */
  begin(row: LiveSessionStart): void;
  /** Adds a YouTube broadcast to the live (a no-op when it is already listed). */
  addBroadcast(sessionId: string, broadcastId: string): void;
  /** Appends one closed gap and adds the whole seconds it adds to `gapSeconds` (a span another gap already covers counts once). Unknown session: a no-op. */
  appendGap(sessionId: string, gap: LiveGap): void;
  /** O34: YouTube was turned on for a live that started without it: the row says so and keeps the channel id. */
  markYoutube(sessionId: string, channelId: string | null): void;
  /** A destination was switched during the live: the row carries the outputs as they stand now. Unknown session: a no-op. */
  setOutputs(sessionId: string, outputs: LiveSessionRecord['outputs']): void;
  /** Closes the row: when it stopped (ISO time) and why. A row already closed keeps its first stop. */
  end(sessionId: string, stoppedAt: string, reason: string): void;
  /** One row, or null. */
  get(sessionId: string): LiveSessionRecord | null;
  /** Rows with no stop: the running live, or lives a box restart cut short (ended with `shutdown` at start-up). */
  open(): LiveSessionRecord[];
  /** The newest rows of a surau, newest first; `limit` defaults to `LIVE_SESSIONS_RECENT_MAX`. */
  recent(surauId: string, limit?: number): LiveSessionRecord[];
}

/* ------------------------------------------------------------------ the store over the database */


interface Row {
  id: string;
  surau_id: string;
  box_id: string;
  owner_device_id: string;
  started_by: string;
  kuliah_id: string | null;
  source: string;
  video: string;
  video_path: string;
  youtube: number | bigint;
  youtube_via: string;
  youtube_channel_id: string | null;
  started_at: string;
  stopped_at: string | null;
  reason: string | null;
  broadcast_ids_json: string;
  gaps_json: string;
  gap_seconds: number | bigint;
  outputs_json: string | null;
}

/** A JSON array from a column, or an empty one when the text is not an array (a damaged row never breaks a read). */
function listOf(text: string): unknown[] {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** The destinations of the row: the stored JSON when it is well formed, else Skrin on with the `youtube` column. */
function outputsOf(r: Row): LiveSessionRecord['outputs'] {
  const fallback = { kiosk: true, youtube: Number(r.youtube) === 1 };
  if (r.outputs_json === null || r.outputs_json === undefined) return fallback;
  try {
    const v: unknown = JSON.parse(r.outputs_json);
    if (typeof v !== 'object' || v === null) return fallback;
    const o = v as Record<string, unknown>;
    if (typeof o.kiosk !== 'boolean' || typeof o.youtube !== 'boolean') return fallback;
    return { kiosk: o.kiosk, youtube: o.youtube, ...(typeof o.recording === 'boolean' ? { recording: o.recording } : {}) };
  } catch {
    return fallback;
  }
}

function recordOf(r: Row): LiveSessionRecord {
  return {
    id: r.id,
    surauId: r.surau_id,
    boxId: r.box_id,
    ownerDeviceId: r.owner_device_id,
    startedBy: r.started_by,
    kuliahId: r.kuliah_id,
    source: r.source === 'web' ? 'web' : 'android',
    video: r.video === 'external' ? 'external' : 'phone',
    videoPath: r.video_path === 'box' ? 'box' : 'device',
    outputs: outputsOf(r),
    youtubeVia: r.youtube_via === 'box' ? 'box' : 'device',
    youtubeChannelId: r.youtube_channel_id,
    startedAt: r.started_at,
    stoppedAt: r.stopped_at,
    reason: r.reason,
    broadcastIds: listOf(r.broadcast_ids_json).filter((x): x is string => typeof x === 'string'),
    gaps: listOf(r.gaps_json).filter(isLiveGap),
    gapSeconds: Number(r.gap_seconds),
  };
}

/** Rows kept per surau: the newest ones (the route shows 10; the upload side looks a live up by id for a while). */
const KEEP_ROWS = 200;
/** A live with more gaps than this keeps the first ones and still counts the seconds of the rest. */
const MAX_GAPS = 500;

/** Whole seconds of a gap; 0 for times that do not parse or run backwards. */
export function gapSecondsOf(gap: LiveGap): number {
  const ms = Date.parse(gap.to) - Date.parse(gap.from);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
}

/**
 * O7: the milliseconds covered by a set of spans, each time counted once. An ingest gap and the YouTube gap of the
 * same stretch overlap; the live lost that stretch once, not twice. Spans that do not parse or run backwards count 0.
 */
export function unionSpanMs(spans: ReadonlyArray<{ from: string; to: string }>): number {
  const list = spans
    .map((g) => [Date.parse(g.from), Date.parse(g.to)] as const)
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curFrom = 0;
  let curTo = 0;
  let open = false;
  for (const [a, b] of list) {
    if (!open) {
      curFrom = a;
      curTo = b;
      open = true;
    } else if (a <= curTo) {
      if (b > curTo) curTo = b;
    } else {
      total += curTo - curFrom;
      curFrom = a;
      curTo = b;
    }
  }
  return open ? total + (curTo - curFrom) : total;
}

/** Whole seconds covered by the spans, overlaps merged (see `unionSpanMs`). */
export function mergedGapSeconds(spans: ReadonlyArray<{ from: string; to: string }>): number {
  return Math.round(unionSpanMs(spans) / 1000);
}

/** The `live_sessions` store of this box (migration 031). Every statement is one row and synchronous. */
export function createLiveSessionStore(db: DatabaseSync): LiveSessionStore {
  const get = (sessionId: string): LiveSessionRecord | null => {
    const r = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(sessionId) as unknown as Row | undefined;
    return r === undefined ? null : recordOf(r);
  };
  return {
    begin(row): void {
      // Q12: the same id twice is tolerated (the first row stands). Anything else the table refuses (a CHECK, a
      // NOT NULL) is not swallowed with it: it is said, by its code only, and the live goes on without its record.
      if (get(row.id) === null) {
        try {
          db.prepare(
            `INSERT INTO live_sessions (id, surau_id, box_id, owner_device_id, started_by, kuliah_id, source, video, video_path, youtube, youtube_via, youtube_channel_id, started_at, outputs_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(row.id, row.surauId, row.boxId, row.ownerDeviceId, row.startedBy, row.kuliahId, row.source, row.video, row.videoPath, row.outputs.youtube ? 1 : 0, row.youtubeVia, row.youtubeChannelId, row.startedAt, JSON.stringify(row.outputs));
        } catch (error) {
          const errcode = (error as { errcode?: unknown } | null)?.errcode;
          console.warn(`live: the record of this live was refused by the table (code: ${typeof errcode === 'number' ? `sqlite_${errcode}` : 'store_error'})`);
        }
      }
      // bounded: the oldest closed rows of the surau go
      db.prepare(
        `DELETE FROM live_sessions WHERE surau_id = ? AND stopped_at IS NOT NULL AND id NOT IN
           (SELECT id FROM live_sessions WHERE surau_id = ? ORDER BY started_at DESC LIMIT ?)`,
      ).run(row.surauId, row.surauId, KEEP_ROWS);
    },
    addBroadcast(sessionId, broadcastId): void {
      const rec = get(sessionId);
      if (rec === null || broadcastId === '' || rec.broadcastIds.includes(broadcastId)) return;
      db.prepare('UPDATE live_sessions SET broadcast_ids_json = ? WHERE id = ?').run(JSON.stringify([...rec.broadcastIds, broadcastId]), sessionId);
    },
    appendGap(sessionId, gap): void {
      const rec = get(sessionId);
      if (rec === null || !isLiveGap(gap)) return;
      const clean: LiveGap = { from: gap.from, to: gap.to, kind: gap.kind, ...(gap.broadcastId !== undefined ? { broadcastId: gap.broadcastId } : {}) };
      const gaps = rec.gaps.length < MAX_GAPS ? [...rec.gaps, clean] : rec.gaps;
      // O7: only the seconds this gap adds beyond the gaps already on record (an overlap is counted once)
      const added = Math.max(0, mergedGapSeconds([...rec.gaps, clean]) - mergedGapSeconds(rec.gaps));
      db.prepare('UPDATE live_sessions SET gaps_json = ?, gap_seconds = ? WHERE id = ?').run(JSON.stringify(gaps), rec.gapSeconds + added, sessionId);
    },
    setOutputs(sessionId, outputs): void {
      db.prepare('UPDATE live_sessions SET outputs_json = ?, youtube = ? WHERE id = ?').run(JSON.stringify(outputs), outputs.youtube ? 1 : 0, sessionId);
    },
    markYoutube(sessionId, channelId): void {
      db.prepare(
        "UPDATE live_sessions SET youtube = 1, youtube_channel_id = ?, outputs_json = CASE WHEN outputs_json IS NULL THEN NULL ELSE json_set(outputs_json, '$.youtube', json('true')) END WHERE id = ?",
      ).run(channelId, sessionId);
    },
    end(sessionId, stoppedAt, reason): void {
      db.prepare('UPDATE live_sessions SET stopped_at = ?, reason = ? WHERE id = ? AND stopped_at IS NULL').run(stoppedAt, reason, sessionId);
    },
    get,
    open(): LiveSessionRecord[] {
      return (db.prepare('SELECT * FROM live_sessions WHERE stopped_at IS NULL ORDER BY started_at').all() as unknown as Row[]).map(recordOf);
    },
    recent(surauId, limit = LIVE_SESSIONS_RECENT_MAX): LiveSessionRecord[] {
      const n = Math.max(1, Math.min(KEEP_ROWS, Math.floor(limit)));
      return (db.prepare('SELECT * FROM live_sessions WHERE surau_id = ? ORDER BY started_at DESC, id DESC LIMIT ?').all(surauId, n) as unknown as Row[]).map(recordOf);
    },
  };
}
