import type { DatabaseSync } from 'node:sqlite';
import { decide, isFeatureKey, isoInstantMs, offsetMinutes, resolveSettings, tzOf, validateFeatureSettings } from '@surau/core';
import type { FeatureKey, FeatureSettings, FieldStamp, Settings } from '@surau/core';
import { deviceOfRev, revOf } from './sync/meta.ts';
import type { ChangeMeta } from './sync/meta.ts';

export class SettingsError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.length > 0 ? errors.join('; ') : 'invalid settings');
    this.name = 'SettingsError';
    this.errors = errors;
  }
}

type Plain = Record<string, unknown>;
type Stored = Partial<Record<string, Partial<FeatureSettings>>>;

const isPlain = (v: unknown): v is Plain =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Settings whose object value is one thing (an adjusted image) and replaces the old value whole. */
const ATOMIC_KEYS: ReadonlySet<string> = new Set(['logo']);

function deepMerge(base: Plain, patch: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] = isPlain(value) && isPlain(current) && !ATOMIC_KEYS.has(key) ? deepMerge(current, value) : clone(value);
  }
  return out;
}

function readStored(db: DatabaseSync): Stored {
  const out: Stored = {};
  const rows = db.prepare('SELECT feature, json FROM settings').all();
  for (const row of rows) {
    const feature = row.feature;
    const json = row.json;
    if (typeof feature !== 'string' || typeof json !== 'string') continue;
    try {
      const parsed: unknown = JSON.parse(json);
      if (isPlain(parsed)) out[feature] = parsed as Partial<FeatureSettings>;
    } catch {
      // A corrupt row is skipped, not thrown.
    }
  }
  return out;
}

function readFeatureRow(db: DatabaseSync, key: FeatureKey): Plain | undefined {
  const row = db.prepare('SELECT json FROM settings WHERE feature = ?').get(key);
  if (row === undefined || typeof row.json !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(row.json);
    return isPlain(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function getSettings(db: DatabaseSync): Settings {
  return resolveSettings(readStored(db));
}

export function getVersion(db: DatabaseSync): number {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('version');
  const value = row !== undefined && typeof row.value === 'string' ? Number(row.value) : 0;
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

export function bumpVersion(db: DatabaseSync): number {
  const next = getVersion(db) + 1;
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('version', String(next));
  return next;
}

export type FieldStamps = Record<string, FieldStamp>;

/** Dot-joined paths of every field of a settings value; an atomic key (the logo) and any non-object value is one field. */
export function leafPaths(value: Plain, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, v] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isPlain(v) && !ATOMIC_KEYS.has(key) && Object.keys(v).length > 0) out.push(...leafPaths(v, path));
    else out.push(path);
  }
  return out;
}

function getPath(value: Plain, path: string): unknown {
  let cur: unknown = value;
  for (const k of path.split('.')) {
    if (!isPlain(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function setPath(target: Plain, path: string, v: unknown): void {
  const keys = path.split('.');
  let cur = target;
  for (const k of keys.slice(0, -1)) {
    const next = cur[k];
    if (isPlain(next)) cur = next;
    else {
      const made: Plain = {};
      cur[k] = made;
      cur = made;
    }
  }
  cur[keys[keys.length - 1]!] = clone(v);
}

const beats = (a: FieldStamp, b: FieldStamp): boolean =>
  decide({ kind: 'settings.put', current: { rev: '', editedAt: b.editedAt, deviceId: b.deviceId, deletedAt: null }, op: a }).apply;

/** The stamps of a stored row, with every field the row holds covered (a field without a stamp takes the row's own). */
export function readFieldStamps(db: DatabaseSync, key: string): FieldStamps {
  const row = db.prepare('SELECT json, rev, edited_at, updated_at, field_stamps FROM settings WHERE feature = ?').get(key);
  if (row === undefined) return {};
  const fallback: FieldStamp = {
    editedAt: typeof row.edited_at === 'string' ? row.edited_at : String(row.updated_at),
    deviceId: deviceOfRev(typeof row.rev === 'string' ? row.rev : null) ?? 'local',
  };
  const out: FieldStamps = {};
  try {
    const parsed: unknown = JSON.parse(String(row.json));
    if (isPlain(parsed)) for (const p of leafPaths(parsed)) out[p] = fallback;
  } catch {
    return {};
  }
  if (typeof row.field_stamps === 'string') {
    try {
      const st: unknown = JSON.parse(row.field_stamps);
      if (isPlain(st)) {
        for (const [p, v] of Object.entries(st)) {
          if (p in out && isPlain(v) && typeof v.editedAt === 'string' && typeof v.deviceId === 'string') {
            out[p] = { editedAt: v.editedAt, deviceId: v.deviceId };
          }
        }
      }
    } catch {
      // corrupt stamps fall back to the row's own
    }
  }
  return out;
}

const STAMP_PATH = /^[A-Za-z0-9_.-]{1,200}$/;
const STAMP_DEVICE = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Check field stamps that arrived from outside: at most 500, plain paths, an ISO time (normalized through
 * `normalise`, which clamps the future) and a plain device id each. Null when anything is off.
 */
export function sanitizeStamps(raw: unknown, normalise: (t: string) => string): FieldStamps | null {
  if (!isPlain(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length > 500) return null;
  const out: FieldStamps = {};
  for (const [path, v] of entries) {
    if (!STAMP_PATH.test(path) || !isPlain(v)) return null;
    if (Object.keys(v).some((k) => k !== 'editedAt' && k !== 'deviceId')) return null;
    if (typeof v.editedAt !== 'string' || isoInstantMs(v.editedAt) === null) return null;
    if (typeof v.deviceId !== 'string' || !STAMP_DEVICE.test(v.deviceId)) return null;
    out[path] = { editedAt: normalise(v.editedAt), deviceId: v.deviceId };
  }
  return out;
}

/** The patch without the fields that already hold exactly that value in the stored row. A non-object patch is returned as it is. */
function withoutUnchanged(patch: unknown, stored: Plain | undefined): unknown {
  if (!isPlain(patch) || stored === undefined) return patch;
  const out: Plain = {};
  for (const path of leafPaths(patch)) {
    const mine = getPath(patch, path);
    if (JSON.stringify(mine) === JSON.stringify(getPath(stored, path))) continue;
    setPath(out, path, mine);
  }
  return out;
}

export interface PutFeatureResult {
  /** False only when a synced edit had fields and none of them was newer than what the row holds. */
  applied: boolean;
}

/**
 * Write a feature patch, field by field; the caller owns the transaction. A local write (no `meta.rev`) always
 * lands and stamps its fields at least a millisecond after what they replace. A synced edit takes each field
 * only when its stamp (`opts.fieldStamps[path]`, else the edit's own) is newer than the field's stored stamp
 * (a same-instant tie goes to the greater device id), so edits to different fields both survive in any order.
 * A patch that changes nothing does not write, log or bump the version, except that stamps that moved are kept.
 */
export function putFeatureIn(
  db: DatabaseSync,
  key: FeatureKey,
  patch: unknown,
  actor: string,
  deviceId?: string,
  meta?: ChangeMeta,
  opts?: { fieldStamps?: FieldStamps },
): PutFeatureResult {
  if (!isFeatureKey(key)) throw new SettingsError([`unknown feature ${String(key)}`]);

  const before = readFeatureRow(db, key);
  // Only what the edit CHANGES is held to the rules: an old stored value (a longer template, a wider range than the
  // rules allow today) must not block a save or a replicated full row that leaves it as it is. Unknown keys and
  // wrong types are never "unchanged", so the shape is still checked. The cross-field rule needs the stored row and
  // is run for local routes and signed ops, not for replicated entries (those carry values already accepted elsewhere).
  const result = validateFeatureSettings(
    key,
    withoutUnchanged(patch, before),
    meta?.trusted === true ? undefined : before ?? {},
  );
  if (!result.ok) throw new SettingsError(result.errors);

  const now = new Date().toISOString();
  const editedAt = meta?.editedAt ?? now;
  const device = meta?.deviceId ?? deviceId;
  const origin = meta?.origin ?? 'local';
  const synced = meta?.rev !== undefined;
  const mine: FieldStamp = { editedAt, deviceId: device ?? 'local' };

  const stamps = readFieldStamps(db, key);
  const incoming = patch as Plain;
  const leaves = leafPaths(incoming);

  const taken: Plain = {};
  const next: FieldStamps = { ...stamps };
  let landed = 0;
  for (const path of leaves) {
    const cur = stamps[path];
    let stamp = opts?.fieldStamps?.[path] ?? mine;
    if (cur !== undefined && !beats(stamp, cur)) {
      if (synced) continue;
      // A local write must beat the stamp it replaces, or the other side would later refuse it.
      stamp = { editedAt: new Date(Math.max(Date.parse(cur.editedAt), Date.parse(editedAt)) + 1).toISOString(), deviceId: stamp.deviceId };
    }
    setPath(taken, path, getPath(incoming, path));
    next[path] = stamp;
    landed += 1;
  }
  if (landed === 0) return { applied: leaves.length === 0 };

  // The row's own edit stamp is the newest of its fields; the rev is the caller's when the caller's edit is it.
  let top: FieldStamp = Object.values(next)[0]!;
  for (const st of Object.values(next)) if (beats(st, top)) top = st;
  const isMine = top.editedAt === mine.editedAt && top.deviceId === mine.deviceId;
  const rev = meta?.rev !== undefined && isMine ? meta.rev : revOf(top.editedAt, { deviceId: top.deviceId });

  const merged = deepMerge(before ?? {}, taken);
  const afterJson = JSON.stringify(merged);
  const stampsJson = JSON.stringify(next);

  // A patch that changes nothing (or is empty) must not write, log or bump the version.
  const unchanged = before === undefined ? Object.keys(merged).length === 0 : JSON.stringify(before) === afterJson;
  if (unchanged) {
    if (before !== undefined && synced) {
      db.prepare('UPDATE settings SET rev = ?, edited_at = ?, origin = ?, field_stamps = ? WHERE feature = ?').run(rev, top.editedAt, origin, stampsJson, key);
    }
    return { applied: true };
  }

  db.prepare(
    `INSERT INTO settings (feature, json, updated_at, updated_by, rev, edited_at, origin, field_stamps) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(feature) DO UPDATE SET
       json = excluded.json,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by,
       rev = excluded.rev,
       edited_at = excluded.edited_at,
       origin = excluded.origin,
       field_stamps = excluded.field_stamps`,
  ).run(key, afterJson, now, actor, rev, top.editedAt, origin, stampsJson);

  db.prepare(
    `INSERT INTO change_log (at, actor, entity, entity_id, before_json, after_json, device_id, origin, op_id, edited_at, synced_at, rev, stamps_json)
     VALUES (?, ?, 'settings', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    now,
    actor,
    key,
    before === undefined ? null : JSON.stringify(before),
    afterJson,
    device ?? null,
    origin,
    meta?.opId ?? null,
    top.editedAt,
    meta?.syncedAt ?? null,
    rev,
    stampsJson,
  );

  bumpVersion(db);
  return { applied: true };
}

export function putFeature(db: DatabaseSync, key: FeatureKey, patch: unknown, actor: string, deviceId?: string): Settings {
  db.exec('BEGIN IMMEDIATE');
  try {
    putFeatureIn(db, key, patch, actor, deviceId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getSettings(db);
}

export interface SurauPublicInfo {
  name: string;
  kind: 'surau' | 'masjid';
  shortAddress?: string;
  /** False when the logo already carries the name (the kiosk and app then leave the text name out). */
  showName: boolean;
  help?: { name?: string; phone?: string; email?: string };
  /** Relative URL of the logo (`/surau-logo?v=...`); omitted when none is set. Added by the route. */
  logo?: string;
  /** Where the surau is (no coordinates): ISO country, city text, IANA zone and its UTC offset now, in minutes. */
  country: string;
  city?: string;
  timezone: string;
  utcOffsetMinutes: number;
}

/** The public identity + help contact: only these fields, empty ones omitted, `help` omitted when all empty. */
export function surauPublicInfo(db: DatabaseSync, at: Date = new Date()): SurauPublicInfo {
  const settings = getSettings(db);
  const i = settings.surauInfo;
  const tz = tzOf(settings);
  const out: SurauPublicInfo = {
    name: i.name.trim(), kind: i.kind, showName: i.showName,
    country: settings.location.country, timezone: tz, utcOffsetMinutes: offsetMinutes(at, tz),
  };
  const city = settings.location.city.trim();
  if (city !== '') out.city = city;
  const addr = i.shortAddress.trim();
  if (addr !== '') out.shortAddress = addr;
  const help: NonNullable<SurauPublicInfo['help']> = {};
  if (i.helpName.trim() !== '') help.name = i.helpName.trim();
  if (i.helpPhone.trim() !== '') help.phone = i.helpPhone.trim();
  if (i.helpEmail.trim() !== '') help.email = i.helpEmail.trim();
  if (Object.keys(help).length > 0) out.help = help;
  return out;
}
