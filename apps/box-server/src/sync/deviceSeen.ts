import type { DatabaseSync } from 'node:sqlite';

/** Most devices one answer lists. */
export const MAX_SEEN_ROWS = 2_000;

export interface DeviceSeenAnswer {
  /** The highest ID number of the box's own series (`U-0001`, `D-0001`) the cloud already holds for the surau, 0 when none. */
  maxNo: { user: number; device: number };
  /** The role the cloud has on file for this box (`primary`, `secondary`). */
  role: string;
  seen: Array<{ id: string; lastSeenAt: string }>;
  /** The cloud-series IDs it holds for the surau's people and devices (a box never gets them in a feed entry). */
  ids: { users: IdRow[]; devices: IdRow[] };
}

export interface IdRow {
  id: string;
  no: number;
}

const MAX_ID_ROWS = 5_000;

const highest = (db: DatabaseSync, table: 'users' | 'devices', surauId: string): number => {
  const r = db.prepare(`SELECT MAX(no) AS n FROM ${table} WHERE surau_id = ? AND no_src = 'b' AND no IS NOT NULL`).get(surauId);
  return Number.isInteger(r?.n) && Number(r?.n) > 0 ? Number(r?.n) : 0;
};

export const maxNoFor = (db: DatabaseSync, surauId: string): { user: number; device: number } => ({
  user: highest(db, 'users', surauId),
  device: highest(db, 'devices', surauId),
});

/**
 * What the cloud knows about the phones of one surau, for the box of that surau: when each was last used through
 * the cloud. Unrevoked phones, tablets and computers only (a TV screen never unlocks through the cloud), never a
 * Pentadbir MAXCOM's device, at most 2,000 rows (the newest first).
 */
export function deviceSeenFor(db: DatabaseSync, surauId: string, boxId: string): DeviceSeenAnswer {
  const rows = db
    .prepare(
      `SELECT id, last_seen_at FROM devices
       WHERE surau_id = ? AND revoked_at IS NULL AND platform <> 'kiosk' AND last_seen_at IS NOT NULL
         AND user_id NOT IN (SELECT id FROM users WHERE surau_id = '*')
       ORDER BY last_seen_at DESC, id LIMIT ?`,
    )
    .all(surauId, MAX_SEEN_ROWS);
  const site = db.prepare('SELECT role FROM sites WHERE box_id = ?').get(boxId);
  const cloudIds = (table: 'users' | 'devices'): IdRow[] =>
    db
      .prepare(`SELECT id, no FROM ${table} WHERE surau_id = ? AND no_src = 'c' AND no IS NOT NULL ORDER BY no LIMIT ?`)
      .all(surauId, MAX_ID_ROWS)
      .map((r) => ({ id: String(r.id), no: Number(r.no) }));
  return {
    maxNo: maxNoFor(db, surauId),
    role: typeof site?.role === 'string' ? site.role : 'primary',
    seen: rows.map((r) => ({ id: String(r.id), lastSeenAt: String(r.last_seen_at) })),
    ids: { users: cloudIds('users'), devices: cloudIds('devices') },
  };
}

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const FUTURE_SLACK_MS = 5 * 60_000;

/**
 * The box takes the cloud's last-used times: each phone's `last_seen_at` moves forward only, never backward, never
 * for a revoked device or a TV screen, never to a time more than 5 minutes ahead of `now`. A malformed row or an
 * unknown id changes nothing. No change_log row and no version bump (a last-used time is never replicated).
 * Returns how many rows changed.
 */
export function mergeDeviceSeen(db: DatabaseSync, rows: unknown, now: Date): number {
  if (!Array.isArray(rows)) return 0;
  const update = db.prepare(
    `UPDATE devices SET last_seen_at = ?
     WHERE id = ? AND revoked_at IS NULL AND platform <> 'kiosk' AND (last_seen_at IS NULL OR last_seen_at < ?)`,
  );
  let changed = 0;
  for (const row of rows.slice(0, MAX_SEEN_ROWS)) {
    if (typeof row !== 'object' || row === null) continue;
    const { id, lastSeenAt } = row as Record<string, unknown>;
    if (typeof id !== 'string' || !ID_RE.test(id)) continue;
    if (typeof lastSeenAt !== 'string' || !ISO_RE.test(lastSeenAt)) continue;
    const t = Date.parse(lastSeenAt);
    if (!Number.isFinite(t) || t > now.getTime() + FUTURE_SLACK_MS) continue;
    const iso = new Date(t).toISOString();
    changed += Number(update.run(iso, id, iso).changes);
  }
  return changed;
}
