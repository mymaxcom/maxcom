import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.ts';
import { MIGRATIONS, runMigrations } from '../src/migrations/index.ts';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });

const NAMES = MIGRATIONS.map((m) => m.name);

describe('migration order', () => {
  it('lists the released 012 first, then box codes, hadis sources, prayer sources and finance, each name once', () => {
    expect(NAMES.slice(-7)).toEqual(['012-youtube-pending-complete', '013-box-codes', '014-hadis-sources', '015-prayer-sources', '016-finance', '017-site-approvals', '018-user-feed-repair']);
    expect(new Set(NAMES).size).toBe(NAMES.length);
    expect(NAMES).toEqual([...NAMES].sort());
  });

  it('a fresh database records every migration, in order, and a second run applies nothing', () => {
    const db = openDb(':memory:');
    dbs.push(db);
    const applied = db.prepare('SELECT name FROM schema_migrations ORDER BY applied_at, name').all().map((r) => String(r.name));
    expect(applied.filter((n) => n !== '001-baseline')).toEqual(expect.arrayContaining(NAMES));
    expect(runMigrations(db)).toEqual([]);
    for (const t of ['box_codes', 'hadis_catalog', 'hadis_source_updates', 'jakim_zones', 'prayer_imports', 'prayer_corrections']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()!.n, t).toBeDefined();
    }
  });

  it('upgrades a database left at 012 through 013, 014 and 015 and keeps its data', () => {
    const db = openDb(':memory:');
    dbs.push(db);
    db.prepare('INSERT INTO prayer_days (zone, date, json) VALUES (?, ?, ?)').run('SGR01', '2026-02-01', '{"date":"2026-02-01"}');
    // Put the database back to the last released state (012), then upgrade it.
    db.exec(`DROP TABLE box_codes;
             DROP TABLE hadis_categories; DROP TABLE hadis_catalog_cat; DROP TABLE hadis_catalog; DROP TABLE hadis_catalog_state; DROP TABLE hadis_source_updates;
             DROP TABLE jakim_zones; DROP TABLE prayer_file_days; DROP TABLE prayer_imports; DROP TABLE prayer_corrections; DROP TABLE location_cache;
             DROP TABLE finance_counters; DROP TABLE finance_photos; DROP TABLE finance_months; DROP TABLE finance_entries; DROP TABLE finance_perihal; DROP TABLE finance_funds;
             ALTER TABLE prayer_days DROP COLUMN fetched_at;
             DELETE FROM schema_migrations WHERE name IN ('013-box-codes', '014-hadis-sources', '015-prayer-sources', '016-finance');`);
    expect(runMigrations(db)).toEqual(['013-box-codes', '014-hadis-sources', '015-prayer-sources', '016-finance']);
    expect(runMigrations(db)).toEqual([]);
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM prayer_days').get()!.n)).toBe(1);
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM jakim_zones').get()!.n)).toBeGreaterThanOrEqual(50);
  });
});
