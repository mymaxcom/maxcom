import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './migrations/index.ts';

const SQLITE_WARNING = /sqlite/i;

function suppressSqliteExperimentalWarning(): void {
  const original = process.emitWarning;
  const filtered = function (warning: string | Error, ...args: unknown[]): void {
    const options = typeof args[0] === 'object' && args[0] !== null ? (args[0] as { type?: string }) : undefined;
    const type =
      typeof warning === 'string'
        ? options?.type ?? (typeof args[0] === 'string' ? args[0] : undefined)
        : warning.name;
    const message = typeof warning === 'string' ? warning : warning.message;
    if (type === 'ExperimentalWarning' && SQLITE_WARNING.test(message)) return;
    (original as (...a: unknown[]) => void).apply(process, [warning, ...args]);
  };
  process.emitWarning = filtered as typeof process.emitWarning;
}

suppressSqliteExperimentalWarning();

const { DatabaseSync: DatabaseSyncCtor } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite');

const SCHEMA_VERSION = '1';

const TABLES = `
  CREATE TABLE IF NOT EXISTS prayer_days (
    surau_id TEXT NOT NULL DEFAULT 'sdm',
    zone TEXT NOT NULL,
    date TEXT NOT NULL,
    json TEXT NOT NULL,
    PRIMARY KEY (zone, date)
  );

  CREATE TABLE IF NOT EXISTS settings (
    surau_id TEXT NOT NULL DEFAULT 'sdm',
    feature TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS change_log (
    surau_id TEXT NOT NULL DEFAULT 'sdm',
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    before_json TEXT,
    after_json TEXT
  );

  CREATE TABLE IF NOT EXISTS meta (
    surau_id TEXT NOT NULL DEFAULT 'sdm',
    key TEXT PRIMARY KEY,
    value TEXT
  );
`;

/** Open (or create) the box database and apply migrations. */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSyncCtor(path);
  try {
    return initDb(db);
  } catch (error) {
    // a damaged file must not stay open: the recovery-screen server (and a repair) need the file free
    try {
      db.close();
    } catch {
      /* already closed */
    }
    throw error;
  }
}

function initDb(db: DatabaseSync): DatabaseSync {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(TABLES);
    const current = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    if (current === undefined) {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  runMigrations(db);
  return db;
}
