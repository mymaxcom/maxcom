import type { DatabaseSync } from 'node:sqlite';
import { JAKIM_ZONES, JAKIM_ZONES_FETCHED_AT } from '@surau/core';

export const migration = { name: '015-prayer-sources', up };

/**
 * Plan 13. Prayer data becomes a stack of per-day sources: the existing official store (`prayer_days`, only a
 * `fetched_at` column added), the surau's own timetable file rows with their import records, manual
 * per-day corrections, the JAKIM zone list and a cache for place searches. Every table carries `surau_id`
 * like the older ones. Nothing in `prayer_days` is rewritten.
 */
function up(db: DatabaseSync): void {
  // prayer_days is created by openDb; a bare test database that lacks it simply has nothing to extend.
  const cols = db.prepare('PRAGMA table_info(prayer_days)').all();
  if (cols.length > 0 && !cols.some((c) => c.name === 'fetched_at')) db.exec('ALTER TABLE prayer_days ADD COLUMN fetched_at TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS jakim_zones (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      code TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      name TEXT NOT NULL,
      lat REAL,
      lon REAL,
      fetched_at TEXT NOT NULL,
      removed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS prayer_imports (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('csv','xlsx')),
      file_name TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      rows INTEGER NOT NULL,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      overlap TEXT NOT NULL,
      inserted INTEGER NOT NULL,
      replaced INTEGER NOT NULL,
      skipped INTEGER NOT NULL,
      actor TEXT NOT NULL,
      device_id TEXT,
      created_at TEXT NOT NULL,
      undone_at TEXT,
      undone_by TEXT,
      rev TEXT,
      edited_at TEXT,
      origin TEXT NOT NULL DEFAULT 'local',
      arrived_at TEXT
    );
    CREATE TABLE IF NOT EXISTS prayer_file_days (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      date TEXT PRIMARY KEY,
      import_id TEXT NOT NULL REFERENCES prayer_imports(id),
      json TEXT NOT NULL,
      prev_import_id TEXT,
      prev_json TEXT
    );
    CREATE TABLE IF NOT EXISTS prayer_corrections (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      date TEXT NOT NULL,
      prayer TEXT NOT NULL,
      time TEXT NOT NULL,
      reason TEXT NOT NULL,
      official_at_correction TEXT,
      actor TEXT NOT NULL,
      device_id TEXT,
      created_at TEXT NOT NULL,
      rev TEXT,
      edited_at TEXT,
      origin TEXT NOT NULL DEFAULT 'local',
      arrived_at TEXT,
      PRIMARY KEY (date, prayer)
    );
    CREATE TABLE IF NOT EXISTS location_cache (
      query_hash TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prayer_file_days_import ON prayer_file_days (import_id);
  `);
  const seed = db.prepare(
    'INSERT OR IGNORE INTO jakim_zones (code, state, name, lat, lon, fetched_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const z of JAKIM_ZONES) seed.run(z.code, z.state, z.name, z.lat, z.lon, JAKIM_ZONES_FETCHED_AT);
}
