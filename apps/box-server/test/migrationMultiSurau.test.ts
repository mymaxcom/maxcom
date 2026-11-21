import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { MIGRATIONS, runMigrations } from '../src/migrations/index.ts';
import { migration } from '../src/migrations/019-multi-surau.ts';

/*
 * Plan 14 Task 2: migration 019-multi-surau.
 *
 * Assumptions for the implementer (choices the plan implies but does not spell out; change a test only with the
 * plan owner, otherwise change the migration):
 *  1. The module exports `migration = { name: '019-multi-surau', up }` and it is the LAST entry of MIGRATIONS.
 *  2. A database is "cloud" when `sites` has rows; there is no other switch. One `suraus` row per distinct
 *     `sites.surau_id` (revoked sites count). A box (no `sites` rows) gets no `suraus` row.
 *  3. suraus columns of a migrated row: kind 'surau', location '' and zone '' (the plan defaults), `created_at`
 *     a non-empty ISO string, `created_by` a non-empty string (tests do not fix the value; suggest 'migration'),
 *     `linked_at` = the earliest non-null `sites.linked_at` of that surau, reviewed_at / suspended_at /
 *     suspended_reason NULL.
 *  4. suraus.name = `settings` row (surau_id = X, feature 'surauInfo') json field `name`; if absent, the `name` of
 *     the earliest-linked site of X (ties: smallest box_id); if still absent, X itself.
 *  5. `sites.role` = 'primary' for every existing row (the column default).
 *  6. Every pre-existing `site_approvals` row (claimed or not) gets `surau_id` NULL and `mode` 'primary'. Only the
 *     pending row is asserted for NULL; a claimed row is not asserted.
 *  7. `devices.box_id` is set only for devices whose own `surau_id` has exactly ONE `sites` row (revoked rows
 *     count); a surau with two sites or none leaves it NULL. This includes the superadmin's devices (they keep
 *     surau 'sdm'). On a box (no sites rows) every `box_id` stays NULL.
 *  8. `devices.ops`, `enrolments.ops` = 0 and `devices.ops_at`, `devices.ops_by` = NULL for all existing rows.
 *  9. Users whose `roles_json` contains "superadmin" (LIKE '%"superadmin"%') get `surau_id = '*'` on cloud and
 *     box alike; nobody else changes. Their devices keep the surau they had.
 * 10. Keys are checked by `PRAGMA table_info` pk order, exactly as section 4 lists them (surau_id first). Indexes
 *     are checked by their column list (and uniqueness / partial), never by index NAME, so the implementer is
 *     free to rename them. A partial unique index `change_log (surau_id, op_id) WHERE op_id IS NOT NULL` is
 *     expected (the old one was partial; op_id is NULL for local rows). The old `idx_change_log_op (op_id)` must
 *     be gone (a unique index on op_id alone would block two suraus).
 * 11. Section 4 item 7 indexes are required as plain (non-unique) column lists: content_items
 *     (surau_id, kind, deleted_at), users (surau_id), devices (surau_id), change_log (surau_id, id),
 *     sites (surau_id).
 * 12. Rebuilding finance_* must not leave a foreign key to a parent column that is no longer unique (SQLite then
 *     fails every insert with "foreign key mismatch" when foreign_keys = ON). The tests insert a finance entry
 *     under foreign_keys = ON after the migration and require PRAGMA foreign_key_check to be empty. Either point
 *     the FKs at (surau_id, id) or drop them; a finance_entries trigger test then still proves append-only.
 * 13. Tables that keep their key (section 4 item 5 and the shared tables): users, devices, sessions, enrolments,
 *     challenges, assets, hadis_catalog, hadis_categories, jakim_zones. finance_months and finance_counters
 *     already key on surau_id and stay as they are.
 * 14. "Fresh db.ts schema equals the migrated schema" compares, per table: columns (name, type, notnull,
 *     default, pk position, order-insensitive because ALTER ADD COLUMN appends), index shapes, trigger names, and
 *     the (type, name, tbl_name) set of sqlite_master. It does not compare the raw CREATE text. `db.ts` TABLES
 *     keep the pre-019 shapes (released 005 upserts on meta's old key), so a fresh database is legacy + 019;
 *     019 still skips a table that already has its new key.
 * 15. The migration runs through runMigrations (its own transaction, foreign_keys pragma set by the opener to ON).
 *     The migration must work with foreign_keys = ON (the opener turns it on and PRAGMA foreign_keys cannot change
 *     inside a transaction), e.g. by using PRAGMA defer_foreign_keys or dropping dependants in order.
 *
 * Plan vs code notes found while writing this: youtube_pending_complete has no surau_id (Task 9 says "add in 018
 * if absent"; 018 is already released, so any column for it belongs in 019 or Task 9, not asserted here);
 * migrationsOrder.test.ts pins NAMES.slice(-7) to end at 018 and must be updated when 019 is registered.
 */

const require_ = createRequire(import.meta.url);
const { DatabaseSync: Sqlite } = require_('node:sqlite') as typeof import('node:sqlite');

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) {
    try {
      d.close();
    } catch {
      /* closed */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'surau-multi-'));
  dirs.push(d);
  return d;
}

const NAME_019 = '019-multi-surau';
/** Migrations numbered after 019 (themes 2026.11.9, renumbered from 019): they run in the same call. */
const AFTER_019 = ['020-site-theme-support', '021-camera-secret', '022-people-relook', '023-youtube-box', '024-outbox-camera-mark', '025-poster-stretch-keep', '026-parked-settings', '027-deleted-people-phone', '028-box-name-follows-surau'];

/** The four tables db.ts created BEFORE migration 019 (old keys). */
const LEGACY_TABLES = `
  CREATE TABLE IF NOT EXISTS prayer_days (surau_id TEXT NOT NULL DEFAULT 'sdm', zone TEXT NOT NULL, date TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (zone, date));
  CREATE TABLE IF NOT EXISTS settings (surau_id TEXT NOT NULL DEFAULT 'sdm', feature TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS change_log (surau_id TEXT NOT NULL DEFAULT 'sdm', id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT, before_json TEXT, after_json TEXT);
  CREATE TABLE IF NOT EXISTS meta (surau_id TEXT NOT NULL DEFAULT 'sdm', key TEXT PRIMARY KEY, value TEXT);
`;

/** A database exactly as a released build (migrations 001-018, db.ts of 2026.11.6) leaves it. */
function openLegacy(path: string): DatabaseSync {
  const db = new Sqlite(path);
  dbs.push(db);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(LEGACY_TABLES);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1');
  const upTo018 = MIGRATIONS.filter((m) => m.name < NAME_019);
  expect(upTo018.length).toBeGreaterThan(10);
  runMigrations(db, upTo018);
  return db;
}

function run(db: DatabaseSync, sql: string, ...p: any[]): void { // eslint-disable-line @typescript-eslint/no-explicit-any
  db.prepare(sql).run(...p);
}
function all(db: DatabaseSync, sql: string, ...p: any[]): Row[] { // eslint-disable-line @typescript-eslint/no-explicit-any
  return db.prepare(sql).all(...p) as Row[];
}
function one(db: DatabaseSync, sql: string, ...p: any[]): Row { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = db.prepare(sql).get(...p) as Row | undefined;
  expect(r, sql).toBeDefined();
  return r!;
}

const T = '2026-11-01T08:00:00.000Z';
const BOX_A = 'a'.repeat(16);
const BOX_B = 'b'.repeat(16);
const BOX_C1 = 'c'.repeat(16);
const BOX_C2 = 'd'.repeat(16);

interface SeedOpts {
  /** Insert `sites` rows (the cloud) and two more suraus. */
  cloud?: boolean;
  /** Add a second and third surau on the cloud (kolej: one site; masjid: two sites). */
  moreSuraus?: boolean;
}

/** Realistic rows in every table the migration touches, all in the default surau 'sdm'. */
function seed(db: DatabaseSync, o: SeedOpts = {}): void {
  run(db, "INSERT INTO settings (feature, json, updated_at, updated_by) VALUES ('surauInfo', ?, ?, 'u-admin')", JSON.stringify({ name: 'Surau Darul Makmur', logo: '' }), T);
  run(db, "INSERT INTO settings (feature, json, updated_at, updated_by, rev, origin) VALUES ('solatScreen', '{\"theme\":\"emas\"}', ?, 'u-admin', 'r1', 'local')", T);
  run(db, "INSERT INTO meta (key, value) VALUES ('boxName', 'Kotak Utama')");
  run(db, "INSERT INTO prayer_days (zone, date, json) VALUES ('SGR01', '2026-11-01', '{\"subuh\":\"05:40\"}'), ('SGR01', '2026-11-02', '{\"subuh\":\"05:41\"}'), ('SGR02', '2026-11-01', '{\"subuh\":\"05:42\"}')");
  run(db, "INSERT INTO prayer_imports (id, kind, file_name, sha256, rows, date_from, date_to, overlap, inserted, replaced, skipped, actor, created_at) VALUES ('imp1', 'csv', 'waktu.csv', ?, 30, '2026-11-01', '2026-11-30', 'none', 30, 0, 0, 'u-admin', ?)", 'f'.repeat(64), T);
  run(db, "INSERT INTO prayer_file_days (date, import_id, json) VALUES ('2026-11-01', 'imp1', '{}'), ('2026-11-02', 'imp1', '{}')");
  run(db, "INSERT INTO prayer_corrections (date, prayer, time, reason, actor, created_at) VALUES ('2026-11-01', 'subuh', '05:45', 'ukur sendiri', 'u-admin', ?)", T);
  run(db, "INSERT INTO content_items (kind, id, json, updated_at, updated_by) VALUES ('kuliah', 'k1', '{}', ?, 'u-admin'), ('poster', 'k1', '{}', ?, 'u-admin'), ('poster', 'p2', '{}', ?, 'u-admin')", T, T, T);
  run(db, "INSERT INTO hadis_source_updates (item_id, provider, provider_id, new_json, found_at) VALUES ('h1', 'hadeethenc', '77', '{}', ?)", T);
  run(db, "INSERT INTO uploads (id, device_id, state, created_at) VALUES ('up1', 'd-admin', 'done', ?)", T);
  run(db, "INSERT INTO applied_ops (op_id, device_id, status, applied_at) VALUES ('op-1', 'd-admin', 'applied', ?), ('op-2', 'd-admin', 'applied', ?)", T, T);
  run(db, "INSERT INTO change_log (at, actor, entity, entity_id, op_id, origin) VALUES (?, 'u-admin', 'settings', 'surauInfo', 'op-1', 'local'), (?, 'u-admin', 'settings', 'solatScreen', 'op-2', 'local'), (?, 'u-admin', 'users', 'u-admin', NULL, 'local')", T, T, T);

  run(db, "INSERT INTO finance_funds (id, name, updated_at, updated_by, rev, edited_at) VALUES ('f-tabung', 'Tabung Am', ?, 'u-admin', 'r', ?), ('f-bina', 'Tabung Pembinaan', ?, 'u-admin', 'r', ?)", T, T, T, T);
  run(db, "INSERT INTO finance_perihal (id, direction, label, updated_at, updated_by, rev, edited_at) VALUES ('p-derma', 'in', 'Derma', ?, 'u-admin', 'r', ?)", T, T);
  run(db, "INSERT INTO finance_entries (id, kind, entry_date, fund_id, perihal_id, amount_sen, created_by, edited_at, received_at, rev, ref_no) VALUES ('e1', 'in', '2026-11-01', 'f-tabung', 'p-derma', 5000, 'u-admin', ?, ?, 'r', 'A-1'), ('e2', 'in', '2026-11-02', 'f-bina', 'p-derma', 12000, 'u-admin', ?, ?, 'r', NULL)", T, T, T, T);
  run(db, "INSERT INTO finance_photos (id, entry_id, mime, bytes, created_at, created_by) VALUES ('ph1', 'e1', 'image/jpeg', 1234, ?, 'u-admin')", T);
  run(db, "INSERT INTO finance_months (ym, status, updated_at, rev, edited_at) VALUES ('2026-10', 'closed', ?, 'r', ?)", T, T);
  run(db, "INSERT INTO finance_counters (letter, next) VALUES ('A', 3)");

  run(db, "INSERT INTO users (id, name, roles_json, created_at, created_by) VALUES ('u-admin', 'Ustaz Admin', '[\"admin\"]', ?, 'cli'), ('u-super', 'Pentadbir MAXCOM', '[\"superadmin\",\"admin\"]', ?, 'cli'), ('u-root', 'Akaun Akar', '[\"superadmin\"]', ?, 'cli'), ('u-imam', 'Imam', '[\"imam\"]', ?, 'u-admin')", T, T, T, T);
  run(db, "INSERT INTO devices (id, user_id, name, platform, enrolled_at) VALUES ('d-admin', 'u-admin', 'Telefon Ustaz', 'android', ?), ('d-super', 'u-super', 'Telefon MAXCOM', 'android', ?), ('d-root', 'u-root', 'Telefon Akar', 'android', ?), ('d-imam', 'u-imam', 'Telefon Imam', 'ios', ?)", T, T, T, T);
  run(db, "INSERT INTO enrolments (code_hash, user_id, device_name, expires_at, created_by) VALUES ('ec1', 'u-imam', 'Tab', ?, 'u-admin'), ('ec2', 'u-admin', 'Tab2', ?, 'u-admin')", T, T);
  run(db, "INSERT INTO sessions (id, token_hash, device_id, user_id, created_at, expires_at, last_used_at) VALUES ('s1', 'th1', 'd-admin', 'u-admin', ?, ?, ?)", T, T, T);

  run(db, "INSERT INTO site_approvals (box_id, name, claim_hash, approved_at, claimed_at) VALUES (?, 'Surau Darul Makmur', ?, ?, NULL)", BOX_A, 'c'.repeat(64), T);

  if (o.cloud) {
    run(db, "INSERT INTO sites (surau_id, box_id, name, linked_at, last_seen_at) VALUES ('sdm', ?, 'Kotak Surau Darul Makmur', ?, ?)", BOX_A, T, T);
    if (o.moreSuraus) {
      run(db, "INSERT INTO sites (surau_id, box_id, name, linked_at, last_seen_at) VALUES ('kolej', ?, 'Kotak Kolej', ?, ?)", BOX_B, '2026-11-03T08:00:00.000Z', T);
      run(db, "INSERT INTO sites (surau_id, box_id, name, linked_at, last_seen_at) VALUES ('masjid', ?, 'Kotak Masjid Utama', ?, ?), ('masjid', ?, 'Kotak Masjid Sayap', ?, ?)", BOX_C1, '2026-11-04T08:00:00.000Z', T, BOX_C2, '2026-11-05T08:00:00.000Z', T);
      run(db, "INSERT INTO users (surau_id, id, name, roles_json, created_at, created_by) VALUES ('kolej', 'u-kolej', 'Admin Kolej', '[\"admin\"]', ?, 'cli'), ('masjid', 'u-masjid', 'Admin Masjid', '[\"admin\"]', ?, 'cli')", T, T);
      run(db, "INSERT INTO devices (surau_id, id, user_id, name, platform, enrolled_at) VALUES ('kolej', 'd-kolej', 'u-kolej', 'Telefon Kolej', 'android', ?), ('masjid', 'd-masjid', 'u-masjid', 'Telefon Masjid', 'android', ?)", T, T);
      // No settings row for kolej or masjid: before 019 `settings` is keyed by feature alone, so only one surau can
      // hold 'surauInfo' (sdm's). Their names come from their sites.
    }
  }
}

// ---- inspection helpers ----------------------------------------------------------------------------------------

function userTables(db: DatabaseSync): string[] {
  return all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => String(r.name));
}

function counts(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of userTables(db)) {
    // tables 019 creates (Task 8 added surau_assets, the per-surau storage count)
    if (t === 'schema_migrations' || t === 'suraus' || t === 'surau_assets' || t === 'camera_secrets' || t === 'id_counters') continue;
    // 023 makes the two YouTube tables (empty)
    if (t === 'youtube_flag' || t === 'youtube_handover' || t === 'parked_settings') continue;
    // 022 sets two one-time flags in sync_state; they are not data
    const where = t === 'sync_state' ? " WHERE key NOT IN ('people_resync', 'ids_push', 'poster_stretch_keep')" : '';
    out[t] = Number(one(db, `SELECT COUNT(*) AS n FROM "${t}"${where}`).n);
  }
  return out;
}

function pk(db: DatabaseSync, table: string): string[] {
  return all(db, `PRAGMA table_info("${table}")`)
    .filter((c) => Number(c.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((c) => String(c.name));
}

function cols(db: DatabaseSync, table: string): string[] {
  return all(db, `PRAGMA table_info("${table}")`).map((c) => String(c.name));
}

interface IndexShape { unique: boolean; partial: boolean; columns: string[] }
function indexes(db: DatabaseSync, table: string): IndexShape[] {
  return all(db, `PRAGMA index_list("${table}")`)
    .filter((i) => String(i.origin) !== 'pk')
    .map((i) => ({
      unique: Number(i.unique) === 1,
      partial: Number(i.partial) === 1,
      columns: all(db, `PRAGMA index_info("${String(i.name)}")`).sort((a, b) => Number(a.seqno) - Number(b.seqno)).map((c) => String(c.name)),
    }));
}
function hasIndex(db: DatabaseSync, table: string, columns: string[], flags: Partial<Pick<IndexShape, 'unique' | 'partial'>> = {}): boolean {
  return indexes(db, table).some((i) => i.columns.join(',') === columns.join(',') && (flags.unique === undefined || i.unique === flags.unique) && (flags.partial === undefined || i.partial === flags.partial));
}

function triggerNames(db: DatabaseSync): string[] {
  return all(db, "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").map((r) => String(r.name));
}

/** Everything about the shape that must match between a fresh and a migrated database. */
function shape(db: DatabaseSync): Record<string, unknown> {
  const tables: Record<string, unknown> = {};
  for (const t of userTables(db)) {
    if (t === 'schema_migrations') continue;
    tables[t] = {
      columns: all(db, `PRAGMA table_info("${t}")`)
        .map((c) => `${String(c.name)}|${String(c.type).toUpperCase()}|nn${Number(c.notnull)}|${c.dflt_value === null ? '-' : String(c.dflt_value)}|pk${Number(c.pk)}`)
        .sort(),
      indexes: indexes(db, t).map((i) => `${i.unique ? 'U' : ''}${i.partial ? 'P' : ''}(${i.columns.join(',')})`).sort(),
    };
  }
  return {
    tables,
    triggers: triggerNames(db),
    master: all(db, "SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY type, name").map((r) => `${String(r.type)}:${String(r.name)}:${String(r.tbl_name)}`),
  };
}

/** Values of the given columns of every row, order-insensitive, JSON per row. */
function dump(db: DatabaseSync, table: string, columns: string[]): string[] {
  const list = columns.map((c) => `"${c}"`).join(', ');
  // 022 and 025 set one-time flags in sync_state; they are not data
  const where = table === 'sync_state' ? " WHERE key NOT IN ('people_resync', 'ids_push', 'poster_stretch_keep')" : '';
  return all(db, `SELECT ${list} FROM "${table}"${where}`).map((r) => JSON.stringify(columns.map((c) => r[c]))).sort();
}

/** The legacy db after `seed`, snapshotted, then migrated through runMigrations. */
function migrated(o: SeedOpts): { db: DatabaseSync; before: Record<string, number>; beforeRows: Record<string, { cols: string[]; rows: string[] }>; beforeTriggers: string[]; applied: string[] } {
  const db = openLegacy(join(tmp(), 'box.db'));
  seed(db, o);
  const before = counts(db);
  const beforeRows: Record<string, { cols: string[]; rows: string[] }> = {};
  for (const t of Object.keys(before)) {
    const c = cols(db, t);
    beforeRows[t] = { cols: c, rows: dump(db, t, c) };
  }
  const beforeTriggers = triggerNames(db);
  const applied = runMigrations(db);
  return { db, before, beforeRows, beforeTriggers, applied };
}

const KEYS: Record<string, string[]> = {
  settings: ['surau_id', 'feature'],
  meta: ['surau_id', 'key'],
  prayer_days: ['surau_id', 'zone', 'date'],
  prayer_file_days: ['surau_id', 'date'],
  prayer_corrections: ['surau_id', 'date', 'prayer'],
  content_items: ['surau_id', 'kind', 'id'],
  hadis_source_updates: ['surau_id', 'item_id'],
  applied_ops: ['surau_id', 'op_id'],
  finance_funds: ['surau_id', 'id'],
  finance_perihal: ['surau_id', 'id'],
  finance_entries: ['surau_id', 'id'],
  finance_photos: ['surau_id', 'id'],
  uploads: ['surau_id', 'id'],
  prayer_imports: ['surau_id', 'id'],
};

const UNCHANGED_KEYS: Record<string, string[]> = {
  users: ['id'],
  devices: ['id'],
  sessions: ['id'],
  enrolments: ['code_hash'],
  challenges: ['nonce'],
  assets: ['id'],
  hadis_catalog: ['provider', 'id'],
  hadis_categories: ['provider', 'id'],
  jakim_zones: ['code'],
  finance_months: ['surau_id', 'ym'],
  finance_counters: ['surau_id', 'letter'],
};

function expectNewKeys(db: DatabaseSync): void {
  for (const [t, key] of Object.entries(KEYS)) expect(pk(db, t), `primary key of ${t}`).toEqual(key);
  for (const [t, key] of Object.entries(UNCHANGED_KEYS)) expect(pk(db, t), `primary key of ${t} stays`).toEqual(key);
  // change_log keeps its rowid id; the op id is unique per surau, no longer globally
  expect(pk(db, 'change_log')).toEqual(['id']);
  expect(hasIndex(db, 'change_log', ['surau_id', 'op_id'], { unique: true }), 'unique (surau_id, op_id) on change_log').toBe(true);
  expect(hasIndex(db, 'change_log', ['op_id'], { unique: true }), 'old unique (op_id) is gone').toBe(false);
}

function expectNewIndexes(db: DatabaseSync): void {
  expect(hasIndex(db, 'content_items', ['surau_id', 'kind', 'deleted_at'])).toBe(true);
  expect(hasIndex(db, 'users', ['surau_id'])).toBe(true);
  expect(hasIndex(db, 'devices', ['surau_id'])).toBe(true);
  expect(hasIndex(db, 'change_log', ['surau_id', 'id'])).toBe(true);
  expect(hasIndex(db, 'sites', ['surau_id'])).toBe(true);
  // finance indexes of 016 survive the rebuild
  expect(hasIndex(db, 'finance_entries', ['surau_id', 'ref_no'], { unique: true, partial: true })).toBe(true);
  expect(hasIndex(db, 'finance_entries', ['surau_id', 'entry_date'])).toBe(true);
  expect(hasIndex(db, 'finance_entries', ['fund_id', 'entry_date'])).toBe(true);
  expect(hasIndex(db, 'finance_entries', ['corrects_id'], { partial: true })).toBe(true);
  expect(hasIndex(db, 'prayer_file_days', ['import_id'])).toBe(true);
}

// ---- tests -----------------------------------------------------------------------------------------------------

describe('migration 019-multi-surau: registration', () => {
  it('is named 019-multi-surau and is the last migration before the later ones', () => {
    expect(migration.name).toBe(NAME_019);
    expect(MIGRATIONS[MIGRATIONS.length - 1 - AFTER_019.length]!.name).toBe(NAME_019);
    expect(MIGRATIONS.filter((m) => m.name === NAME_019)).toHaveLength(1);
  });

  it('applies exactly 019 to a database left at 018', () => {
    const { applied } = migrated({ cloud: true });
    expect(applied).toEqual([NAME_019, ...AFTER_019]);
  });
});

describe('migration 019 on a cloud-shaped database (one surau, sdm)', () => {
  it('keeps the row count of every table, and every pre-existing column value', () => {
    const { db, before, beforeRows } = migrated({ cloud: true });
    expect(counts(db)).toEqual(before);
    for (const [t, snap] of Object.entries(beforeRows)) {
      // users.surau_id is rewritten for superadmin rows on purpose (own test); everything else must be identical
      const columns = t === 'users' ? snap.cols.filter((c) => c !== 'surau_id') : snap.cols;
      const expected = snap.rows.map((r) => {
        const arr = JSON.parse(r) as unknown[];
        return JSON.stringify(columns.map((c) => arr[snap.cols.indexOf(c)]));
      }).sort();
      expect(dump(db, t, columns), `rows of ${t}`).toEqual(expected);
    }
  });

  it('adds a suraus row for sdm with the pilot name and the site linked time', () => {
    const { db } = migrated({ cloud: true });
    expect(cols(db, 'suraus').sort()).toEqual(['created_at', 'created_by', 'id', 'kind', 'linked_at', 'location', 'name', 'reviewed_at', 'storage_limit_bytes', 'suspended_at', 'suspended_reason', 'zone'].sort());
    expect(pk(db, 'suraus')).toEqual(['id']);
    const rows = all(db, 'SELECT * FROM suraus');
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.id).toBe('sdm');
    expect(r.name).toBe('Surau Darul Makmur');
    expect(r.kind).toBe('surau');
    expect(r.location).toBe('');
    expect(r.zone).toBe('');
    expect(r.linked_at).toBe(T);
    expect(r.reviewed_at).toBeNull();
    expect(r.suspended_at).toBeNull();
    expect(r.suspended_reason).toBeNull();
    // Task 8: the default limit (null)
    expect(r.storage_limit_bytes).toBeNull();
    expect(String(r.created_by).length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(String(r.created_at)))).toBe(false);
  });

  it('Task 8: on a cloud with one surau, every asset it already holds counts for it; a box counts nothing', () => {
    for (const cloud of [true, false]) {
      const db = openLegacy(join(tmp(), 'box.db'));
      seed(db, { cloud });
      db.prepare("INSERT INTO assets (id, mime, bytes, width, height, created_at, created_by) VALUES (?, 'audio/mpeg', 1234, NULL, NULL, ?, 'test')").run('a'.repeat(64), T);
      db.prepare("INSERT INTO assets (id, mime, bytes, width, height, created_at, created_by) VALUES (?, 'audio/mpeg', 4321, NULL, NULL, ?, 'test')").run('b'.repeat(64), T);
      runMigrations(db);
      const held = all(db, 'SELECT surau_id, asset_id, bytes FROM surau_assets ORDER BY asset_id');
      expect(held, cloud ? 'cloud' : 'box').toEqual(cloud ? [{ surau_id: 'sdm', asset_id: 'a'.repeat(64), bytes: 1234 }, { surau_id: 'sdm', asset_id: 'b'.repeat(64), bytes: 4321 }] : []);
    }
  });

  it('suraus.id and name are NOT NULL; kind defaults to surau', () => {
    const { db } = migrated({ cloud: true });
    expect(() => run(db, "INSERT INTO suraus (id, name, created_at, created_by) VALUES (NULL, 'x', ?, 'cli')", T)).toThrow();
    expect(() => run(db, "INSERT INTO suraus (id, name, created_at, created_by) VALUES ('zz', NULL, ?, 'cli')", T)).toThrow();
    run(db, "INSERT INTO suraus (id, name, created_at, created_by) VALUES ('abc', 'Surau ABC', ?, 'cli')", T);
    const r = one(db, "SELECT * FROM suraus WHERE id = 'abc'");
    expect(r.kind).toBe('surau');
    expect(r.location).toBe('');
    expect(r.zone).toBe('');
    expect(r.linked_at).toBeNull();
    expect(() => run(db, "INSERT INTO suraus (id, name, created_at, created_by) VALUES ('abc', 'Dup', ?, 'cli')", T)).toThrow();
  });

  it('rebuilt tables carry the new keys, the new indexes exist, the new columns exist', () => {
    const { db } = migrated({ cloud: true });
    expectNewKeys(db);
    expectNewIndexes(db);
    expect(cols(db, 'sites')).toContain('role');
    expect(cols(db, 'site_approvals')).toEqual(expect.arrayContaining(['surau_id', 'mode']));
    expect(cols(db, 'devices')).toEqual(expect.arrayContaining(['box_id', 'ops', 'ops_at', 'ops_by']));
    expect(cols(db, 'enrolments')).toContain('ops');
  });

  it('two suraus can now hold the same natural key; the same surau still cannot (success and failure)', () => {
    const { db } = migrated({ cloud: true });
    // success: same feature / zone+date / kind+id / op id under another surau
    run(db, "INSERT INTO suraus (id, name, created_at, created_by) VALUES ('kolej', 'Kolej', ?, 'cli')", T);
    run(db, "INSERT INTO settings (surau_id, feature, json, updated_at, updated_by) VALUES ('kolej', 'surauInfo', '{}', ?, 'x')", T);
    run(db, "INSERT INTO meta (surau_id, key, value) VALUES ('kolej', 'boxName', 'Lain')");
    run(db, "INSERT INTO prayer_days (surau_id, zone, date, json) VALUES ('kolej', 'SGR01', '2026-11-01', '{}')");
    run(db, "INSERT INTO prayer_corrections (surau_id, date, prayer, time, reason, actor, created_at) VALUES ('kolej', '2026-11-01', 'subuh', '05:50', 'r', 'x', ?)", T);
    run(db, "INSERT INTO content_items (surau_id, kind, id, json, updated_at, updated_by) VALUES ('kolej', 'kuliah', 'k1', '{}', ?, 'x')", T);
    run(db, "INSERT INTO hadis_source_updates (surau_id, item_id, provider, provider_id, new_json, found_at) VALUES ('kolej', 'h1', 'hadeethenc', '77', '{}', ?)", T);
    run(db, "INSERT INTO applied_ops (surau_id, op_id, device_id, status, applied_at) VALUES ('kolej', 'op-1', 'dk', 'applied', ?)", T);
    run(db, "INSERT INTO change_log (surau_id, at, actor, entity, op_id, origin) VALUES ('kolej', ?, 'x', 'settings', 'op-1', 'local')", T);
    run(db, "INSERT INTO finance_funds (surau_id, id, name, updated_at, updated_by, rev, edited_at) VALUES ('kolej', 'f-tabung', 'Tabung Am', ?, 'x', 'r', ?)", T, T);
    run(db, "INSERT INTO uploads (surau_id, id, device_id, state, created_at) VALUES ('kolej', 'up1', 'dk', 'done', ?)", T);
    run(db, "INSERT INTO prayer_imports (surau_id, id, kind, file_name, sha256, rows, date_from, date_to, overlap, inserted, replaced, skipped, actor, created_at) VALUES ('kolej', 'imp1', 'csv', 'a.csv', ?, 1, '2026-11-01', '2026-11-01', 'none', 1, 0, 0, 'x', ?)", 'f'.repeat(64), T);
    run(db, "INSERT INTO prayer_file_days (surau_id, date, import_id, json) VALUES ('kolej', '2026-11-01', 'imp1', '{}')");
    expect(Number(one(db, "SELECT COUNT(*) AS n FROM settings WHERE feature = 'surauInfo'").n)).toBe(2);
    // failure: duplicates inside one surau
    expect(() => run(db, "INSERT INTO settings (surau_id, feature, json, updated_at, updated_by) VALUES ('sdm', 'surauInfo', '{}', ?, 'x')", T)).toThrow();
    expect(() => run(db, "INSERT INTO content_items (surau_id, kind, id, json, updated_at, updated_by) VALUES ('sdm', 'poster', 'p2', '{}', ?, 'x')", T)).toThrow();
    expect(() => run(db, "INSERT INTO change_log (surau_id, at, actor, entity, op_id, origin) VALUES ('sdm', ?, 'x', 'settings', 'op-1', 'local')", T)).toThrow();
    // many local rows without an op id are still fine in one surau
    run(db, "INSERT INTO change_log (surau_id, at, actor, entity, op_id, origin) VALUES ('sdm', ?, 'x', 'settings', NULL, 'local'), ('sdm', ?, 'x', 'settings', NULL, 'local')", T, T);
  });

  it('finance_entries is still append-only after the rebuild (triggers refuse update and delete; the allowed fill works)', () => {
    const { db } = migrated({ cloud: true });
    expect(triggerNames(db)).toEqual(expect.arrayContaining(['trg_fin_entries_immutable', 'trg_fin_entries_no_delete']));
    expect(() => run(db, "UPDATE finance_entries SET amount_sen = 1 WHERE id = 'e1'")).toThrow(/append-only/);
    expect(() => run(db, "UPDATE finance_entries SET surau_id = 'kolej' WHERE id = 'e1'")).toThrow(/append-only/);
    expect(() => run(db, "UPDATE finance_entries SET ref_no = 'A-9' WHERE id = 'e1'")).toThrow(/append-only/); // ref_no already set
    expect(() => run(db, "DELETE FROM finance_entries WHERE id = 'e1'")).toThrow(/append-only/);
    // success path: filling ref_no once, and cloud_received_at, are the permitted updates
    run(db, "UPDATE finance_entries SET ref_no = 'A-2' WHERE id = 'e2'");
    run(db, "UPDATE finance_entries SET cloud_received_at = ? WHERE id = 'e2'", T);
    const e2 = one(db, "SELECT ref_no, cloud_received_at FROM finance_entries WHERE id = 'e2'");
    expect(e2.ref_no).toBe('A-2');
    expect(e2.cloud_received_at).toBe(T);
    expect(Number(one(db, 'SELECT COUNT(*) AS n FROM finance_entries').n)).toBe(2);
  });

  it('the finance foreign keys still work with foreign_keys = ON after the rebuild', () => {
    const { db } = migrated({ cloud: true });
    expect(Number(one(db, 'PRAGMA foreign_keys').foreign_keys)).toBe(1);
    expect(all(db, 'PRAGMA foreign_key_check')).toEqual([]);
    run(db, "INSERT INTO finance_entries (id, kind, entry_date, fund_id, perihal_id, amount_sen, created_by, edited_at, received_at, rev) VALUES ('e3', 'out', '2026-11-03', 'f-tabung', 'p-derma', 700, 'u-admin', ?, ?, 'r')", T, T);
    run(db, "INSERT INTO finance_entries (id, kind, entry_date, fund_id, amount_sen, corrects_id, correction_kind, created_by, edited_at, received_at, rev) VALUES ('e4', 'adjust', '2026-11-03', 'f-tabung', 700, 'e3', 'void', 'u-admin', ?, ?, 'r')", T, T);
    expect(() => run(db, "INSERT INTO finance_entries (id, kind, entry_date, fund_id, amount_sen, created_by, edited_at, received_at, rev) VALUES ('e5', 'in', '2026-11-03', 'no-such-fund', 1, 'u-admin', ?, ?, 'r')", T, T)).toThrow();
  });

  it('keeps every trigger (finance append-only, worker outbox) and the other tables untouched', () => {
    const { db, beforeTriggers } = migrated({ cloud: true });
    expect(triggerNames(db)).toEqual(beforeTriggers);
    expect(beforeTriggers).toEqual(expect.arrayContaining(['trg_fin_entries_immutable', 'trg_fin_entries_no_delete', 'worker_outbox_dirty']));
  });

  it('the superadmin user is * and its devices keep sdm; nobody else changes', () => {
    const { db } = migrated({ cloud: true });
    expect(one(db, "SELECT surau_id FROM users WHERE id = 'u-super'").surau_id).toBe('*');
    expect(one(db, "SELECT surau_id FROM users WHERE id = 'u-root'").surau_id).toBe('*');
    expect(one(db, "SELECT surau_id FROM users WHERE id = 'u-admin'").surau_id).toBe('sdm');
    expect(one(db, "SELECT surau_id FROM users WHERE id = 'u-imam'").surau_id).toBe('sdm');
    const devs = all(db, "SELECT id, surau_id FROM devices ORDER BY id");
    expect(devs.length).toBeGreaterThan(0);
    for (const d of devs) expect(d.surau_id, `device ${String(d.id)}`).toBe('sdm');
    expect(one(db, "SELECT user_id FROM devices WHERE id = 'd-super'").user_id).toBe('u-super');
    // no surau row is created for the '*' marker
    expect(all(db, "SELECT id FROM suraus WHERE id = '*'")).toEqual([]);
  });

  it('every device and enrolment starts public: ops = 0, ops_at and ops_by NULL', () => {
    const { db } = migrated({ cloud: true });
    const devs = all(db, 'SELECT id, ops, ops_at, ops_by FROM devices');
    expect(devs).toHaveLength(4);
    for (const d of devs) {
      expect(Number(d.ops), String(d.id)).toBe(0);
      expect(d.ops_at).toBeNull();
      expect(d.ops_by).toBeNull();
    }
    const encs = all(db, 'SELECT code_hash, ops FROM enrolments');
    expect(encs).toHaveLength(2);
    for (const e of encs) expect(Number(e.ops)).toBe(0);
    // the superadmin's device is not an ops device either
    expect(Number(one(db, "SELECT ops FROM devices WHERE id = 'd-super'").ops)).toBe(0);
    // new column rules: ops is NOT NULL with default 0
    run(db, "INSERT INTO devices (id, user_id, name, platform, enrolled_at) VALUES ('d-new', 'u-admin', 'Baru', 'android', ?)", T);
    expect(Number(one(db, "SELECT ops FROM devices WHERE id = 'd-new'").ops)).toBe(0);
    expect(() => run(db, "UPDATE devices SET ops = NULL WHERE id = 'd-new'")).toThrow();
  });

  it('devices of sdm get box_id = the one site', () => {
    const { db } = migrated({ cloud: true });
    for (const d of all(db, 'SELECT id, box_id FROM devices')) expect(d.box_id, `device ${String(d.id)}`).toBe(BOX_A);
    // the nullable column accepts NULL for a later cloud-only device
    run(db, "INSERT INTO devices (id, user_id, name, platform, enrolled_at, box_id) VALUES ('d-nobox', 'u-admin', 'Tanpa kotak', 'android', ?, NULL)", T);
  });

  it('sites get role primary; site_approvals gain surau_id and mode', () => {
    const { db } = migrated({ cloud: true });
    expect(one(db, 'SELECT role FROM sites').role).toBe('primary');
    const a = one(db, 'SELECT surau_id, mode FROM site_approvals WHERE box_id = ?', BOX_A);
    expect(a.surau_id).toBeNull(); // a pending approval has no target: it can never be claimed
    expect(a.mode).toBe('primary');
    // an approval that names its target is storable (success path of the new columns)
    run(db, "INSERT INTO site_approvals (box_id, name, claim_hash, approved_at, surau_id, mode) VALUES (?, 'Lain', ?, ?, 'sdm', 'extra')", 'e'.repeat(16), 'd'.repeat(64), T);
    expect(one(db, 'SELECT mode FROM site_approvals WHERE box_id = ?', 'e'.repeat(16)).mode).toBe('extra');
  });

  it('a second run is a no-op: nothing applied, schema and rows identical', () => {
    const { db } = migrated({ cloud: true });
    const s1 = JSON.stringify(shape(db));
    const c1 = counts(db);
    const su1 = JSON.stringify(all(db, 'SELECT * FROM suraus ORDER BY id'));
    const dev1 = JSON.stringify(all(db, 'SELECT * FROM devices ORDER BY id'));
    expect(runMigrations(db)).toEqual([]);
    expect(JSON.stringify(shape(db))).toBe(s1);
    expect(counts(db)).toEqual(c1);
    expect(JSON.stringify(all(db, 'SELECT * FROM suraus ORDER BY id'))).toBe(su1);
    expect(JSON.stringify(all(db, 'SELECT * FROM devices ORDER BY id'))).toBe(dev1);
    expect(Number(one(db, `SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '${NAME_019}'`).n)).toBe(1);
  });

  it('upgrades a legacy FILE through openDb (the real start-up path) and keeps the data', () => {
    const dir = tmp();
    const file = join(dir, 'box.db');
    const legacy = openLegacy(file);
    seed(legacy, { cloud: true });
    const before = counts(legacy);
    legacy.close();
    const db = openDb(file);
    dbs.push(db);
    expect(counts(db)).toEqual(before);
    expectNewKeys(db);
    expect(one(db, "SELECT id FROM suraus").id).toBe('sdm');
    expect(Number(one(db, 'PRAGMA foreign_keys').foreign_keys)).toBe(1);
    expect(all(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });
});

describe('migration 019 on a box-shaped database (no sites rows)', () => {
  it('keeps every row count, adds no suraus row, still marks the superadmin *', () => {
    const { db, before } = migrated({ cloud: false });
    expect(counts(db)).toEqual(before);
    expect(all(db, 'SELECT * FROM suraus')).toEqual([]);
    expect(one(db, "SELECT surau_id FROM users WHERE id = 'u-super'").surau_id).toBe('*');
    expect(one(db, "SELECT surau_id FROM users WHERE id = 'u-admin'").surau_id).toBe('sdm');
    for (const d of all(db, 'SELECT id, surau_id, ops, box_id FROM devices')) {
      expect(d.surau_id).toBe('sdm');
      expect(Number(d.ops)).toBe(0);
      expect(d.box_id, 'a box leaves box_id null').toBeNull();
    }
    for (const e of all(db, 'SELECT ops FROM enrolments')) expect(Number(e.ops)).toBe(0);
  });

  it('has the new keys and the finance triggers too', () => {
    const { db } = migrated({ cloud: false });
    expectNewKeys(db);
    expectNewIndexes(db);
    expect(() => run(db, "UPDATE finance_entries SET amount_sen = 2 WHERE id = 'e1'")).toThrow(/append-only/);
    expect(one(db, "SELECT value FROM meta WHERE surau_id = 'sdm' AND key = 'boxName'").value).toBe('Kotak Utama');
  });

  it('youtube_pending_complete gains surau_id NOT NULL with the local surau as default; existing rows keep sdm', () => {
    const db = openLegacy(join(tmp(), 'yt.db'));
    seed(db, {});
    run(db, "INSERT INTO youtube_pending_complete (broadcast_id, attempts, created_at) VALUES ('bc-1', 2, ?)", T);
    expect(runMigrations(db)).toEqual([NAME_019, ...AFTER_019]);
    const c = all(db, 'PRAGMA table_info(youtube_pending_complete)').find((x) => x.name === 'surau_id');
    expect(c, 'surau_id column').toBeDefined();
    expect(Number(c!.notnull)).toBe(1);
    expect(String(c!.dflt_value)).toBe("'sdm'");
    expect(one(db, "SELECT surau_id, attempts FROM youtube_pending_complete WHERE broadcast_id = 'bc-1'")).toEqual({ surau_id: 'sdm', attempts: 2 });
    // the existing writer (no surau named) still works; NULL is refused
    run(db, "INSERT OR IGNORE INTO youtube_pending_complete (broadcast_id, attempts, created_at) VALUES ('bc-2', 0, ?)", T);
    expect(one(db, "SELECT surau_id FROM youtube_pending_complete WHERE broadcast_id = 'bc-2'").surau_id).toBe('sdm');
    expect(() => run(db, "INSERT INTO youtube_pending_complete (surau_id, broadcast_id, attempts, created_at) VALUES (NULL, 'bc-3', 0, ?)", T)).toThrow();
  });

  it('a second run is a no-op', () => {
    const { db } = migrated({ cloud: false });
    expect(runMigrations(db)).toEqual([]);
    expect(all(db, 'SELECT * FROM suraus')).toEqual([]);
  });

  it('an empty legacy database (no rows at all) migrates cleanly', () => {
    const db = openLegacy(join(tmp(), 'empty.db'));
    expect(runMigrations(db)).toEqual([NAME_019, ...AFTER_019]);
    expect(all(db, 'SELECT * FROM suraus')).toEqual([]);
    expectNewKeys(db);
  });
});

describe('migration 019 with several suraus on the cloud', () => {
  it('two (three) sites suraus give one suraus row each, names from settings or from the site', () => {
    const { db } = migrated({ cloud: true, moreSuraus: true });
    const rows = all(db, 'SELECT id, name, kind, linked_at FROM suraus ORDER BY id');
    expect(rows.map((r) => String(r.id))).toEqual(['kolej', 'masjid', 'sdm']);
    const by = Object.fromEntries(rows.map((r) => [String(r.id), r]));
    expect(by.sdm!.name).toBe('Surau Darul Makmur');
    expect(by.kolej!.name).toBe('Kotak Kolej'); // no settings of its own: its site, never sdm's settings name
    expect(by.masjid!.name).toBe('Kotak Masjid Utama'); // no settings: the earliest-linked site's name
    expect(by.sdm!.linked_at).toBe(T);
    expect(by.kolej!.linked_at).toBe('2026-11-03T08:00:00.000Z');
    expect(by.masjid!.linked_at).toBe('2026-11-04T08:00:00.000Z'); // earliest of the two sites
    for (const r of rows) expect(r.kind).toBe('surau');
  });

  it('box_id is stamped only where the surau has exactly one site', () => {
    const { db } = migrated({ cloud: true, moreSuraus: true });
    expect(one(db, "SELECT box_id FROM devices WHERE id = 'd-admin'").box_id).toBe(BOX_A);
    expect(one(db, "SELECT box_id FROM devices WHERE id = 'd-super'").box_id).toBe(BOX_A);
    expect(one(db, "SELECT box_id FROM devices WHERE id = 'd-kolej'").box_id).toBe(BOX_B);
    expect(one(db, "SELECT box_id FROM devices WHERE id = 'd-masjid'").box_id).toBeNull(); // two sites: ambiguous
  });

  it('every site keeps its surau and gets role primary; no row is lost', () => {
    const { db, before } = migrated({ cloud: true, moreSuraus: true });
    expect(counts(db)).toEqual(before);
    const sites = all(db, 'SELECT box_id, surau_id, role FROM sites ORDER BY box_id');
    expect(sites.map((s) => `${String(s.box_id)}:${String(s.surau_id)}:${String(s.role)}`)).toEqual([
      `${BOX_A}:sdm:primary`,
      `${BOX_B}:kolej:primary`,
      `${BOX_C1}:masjid:primary`,
      `${BOX_C2}:masjid:primary`,
    ]);
  });

  it('users of other suraus are not made * and keep their surau', () => {
    const { db } = migrated({ cloud: true, moreSuraus: true });
    expect(one(db, "SELECT surau_id FROM users WHERE id = 'u-kolej'").surau_id).toBe('kolej');
    expect(one(db, "SELECT surau_id FROM users WHERE id = 'u-masjid'").surau_id).toBe('masjid');
    expect(one(db, "SELECT surau_id FROM users WHERE id = 'u-super'").surau_id).toBe('*');
    expect(one(db, "SELECT surau_id FROM devices WHERE id = 'd-kolej'").surau_id).toBe('kolej');
  });

  it('the sdm approval stays pending with no target; a second run changes nothing', () => {
    const { db } = migrated({ cloud: true, moreSuraus: true });
    expect(one(db, 'SELECT surau_id FROM site_approvals WHERE box_id = ?', BOX_A).surau_id).toBeNull();
    const su = JSON.stringify(all(db, 'SELECT * FROM suraus ORDER BY id'));
    expect(runMigrations(db)).toEqual([]);
    expect(JSON.stringify(all(db, 'SELECT * FROM suraus ORDER BY id'))).toBe(su);
  });
});

describe('fresh db.ts schema equals the migrated schema', () => {
  it('a fresh database has the new keys, indexes and columns', () => {
    const db = openDb(':memory:');
    dbs.push(db);
    expectNewKeys(db);
    expectNewIndexes(db);
    expect(cols(db, 'sites')).toContain('role');
    expect(cols(db, 'devices')).toEqual(expect.arrayContaining(['box_id', 'ops', 'ops_at', 'ops_by']));
    expect(all(db, 'SELECT * FROM suraus')).toEqual([]);
    expect(runMigrations(db)).toEqual([]);
  });

  it('compares equal to a legacy database after 019 (sqlite_master and table shapes)', () => {
    const fresh = openDb(':memory:');
    dbs.push(fresh);
    const old = openLegacy(join(tmp(), 'legacy.db'));
    expect(runMigrations(old)).toEqual([NAME_019, ...AFTER_019]);
    const a = shape(fresh) as { tables: Record<string, unknown>; triggers: string[]; master: string[] };
    const b = shape(old) as typeof a;
    expect(Object.keys(a.tables).sort()).toEqual(Object.keys(b.tables).sort());
    for (const t of Object.keys(a.tables)) expect(a.tables[t], `shape of ${t}`).toEqual(b.tables[t]);
    expect(a.triggers).toEqual(b.triggers);
    expect(a.master).toEqual(b.master);
  });
});

// ---- optional: copies of the real pilot box and cloud databases (never committed, skipped when absent) ------------

const WORK = process.env.MAXCOM_WORK ?? join(homedir(), 'maxcom-work').replaceAll('\\', '/');
const PILOT_BOX = `${WORK}/e2e-data/surau.db`;

function newestDb(root: string, depth = 3): { path: string; mtime: number } | undefined {
  let best: { path: string; mtime: number } | undefined;
  const walk = (dir: string, d: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (n === 'node_modules' || n === '.git' || n === 'secret') continue;
      const p = join(dir, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (d > 0) walk(p, d - 1);
      } else if (/\.db$/i.test(n) && !p.replace(/\\/g, '/').includes('/e2e-data/') && (!best || st.mtimeMs > best.mtime)) {
        best = { path: p, mtime: st.mtimeMs };
      }
    }
  };
  walk(root, depth);
  return best;
}

function copyOf(src: string): DatabaseSync {
  const dir = tmp();
  const dest = join(dir, 'copy.db');
  copyFileSync(src, dest);
  for (const ext of ['-wal', '-shm']) if (existsSync(src + ext)) copyFileSync(src + ext, dest + ext);
  const db = new Sqlite(dest);
  dbs.push(db);
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

describe('migration 019 on copies of real databases (skipped when the files are absent)', () => {
  const cloudBackup = newestDb(WORK)?.path;

  it.skipIf(!existsSync(PILOT_BOX))('pilot box copy: counts equal, no suraus row, new keys, superadmin *', () => {
    const db = copyOf(PILOT_BOX);
    runMigrations(db, MIGRATIONS.filter((m) => m.name < NAME_019)); // bring an older copy to 018 first
    const before = counts(db);
    const sites = Number(one(db, 'SELECT COUNT(*) AS n FROM sites').n);
    runMigrations(db);
    expect(counts(db)).toEqual(before);
    if (sites === 0) expect(all(db, 'SELECT * FROM suraus')).toEqual([]);
    expectNewKeys(db);
    expect(all(db, "SELECT id FROM users WHERE roles_json LIKE '%\"superadmin\"%' AND surau_id <> '*'")).toEqual([]);
    for (const d of all(db, 'SELECT ops FROM devices')) expect(Number(d.ops)).toBe(0);
    expect(runMigrations(db)).toEqual([]);
  });

  it.skipIf(!cloudBackup)('cloud backup copy: counts equal, one suraus per sites surau, devices stamped, finance still append-only', () => {
    const db = copyOf(cloudBackup!);
    runMigrations(db, MIGRATIONS.filter((m) => m.name < NAME_019));
    const before = counts(db);
    const distinct = all(db, 'SELECT DISTINCT surau_id FROM sites').map((r) => String(r.surau_id)).sort();
    runMigrations(db);
    expect(counts(db)).toEqual(before);
    expect(all(db, 'SELECT id FROM suraus ORDER BY id').map((r) => String(r.id))).toEqual(distinct);
    expectNewKeys(db);
    for (const s of distinct) {
      const n = Number(one(db, 'SELECT COUNT(*) AS n FROM sites WHERE surau_id = ?', s).n);
      if (n === 1) {
        const box = String(one(db, 'SELECT box_id FROM sites WHERE surau_id = ?', s).box_id);
        for (const d of all(db, 'SELECT box_id FROM devices WHERE surau_id = ?', s)) expect(d.box_id).toBe(box);
      }
    }
    for (const d of all(db, 'SELECT ops FROM devices')) expect(Number(d.ops)).toBe(0);
    if (Number(one(db, 'SELECT COUNT(*) AS n FROM finance_entries').n) > 0) {
      expect(() => run(db, 'UPDATE finance_entries SET amount_sen = amount_sen + 1')).toThrow(/append-only/);
    }
    expect(all(db, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(runMigrations(db)).toEqual([]);
  });
});
