import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.ts';
import { MIGRATIONS, runMigrations } from '../src/migrations/index.ts';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });

describe('migration 015-prayer-sources', () => {
  it('keeps every prayer_days row of an older database, adds fetched_at, the new tables and the zone list', () => {
    const db = openDb(':memory:');
    dbs.push(db);
    const ins = db.prepare('INSERT INTO prayer_days (zone, date, json) VALUES (?, ?, ?)');
    for (let i = 1; i <= 28; i++) ins.run('SGR01', `2026-02-${String(i).padStart(2, '0')}`, `{"date":"2026-02-${String(i).padStart(2, '0')}"}`);
    // Put the database back the way Plan 6 left it, then upgrade it.
    db.exec(`DROP TABLE jakim_zones; DROP TABLE prayer_file_days; DROP TABLE prayer_imports; DROP TABLE prayer_corrections;
             DROP TABLE location_cache; ALTER TABLE prayer_days DROP COLUMN fetched_at;
             DELETE FROM schema_migrations WHERE name = '015-prayer-sources';`);
    expect(db.prepare('PRAGMA table_info(prayer_days)').all().some((c) => c.name === 'fetched_at')).toBe(false);

    expect(runMigrations(db)).toEqual(['015-prayer-sources']);
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM prayer_days').get()!.n)).toBe(28);
    expect(db.prepare('SELECT fetched_at FROM prayer_days LIMIT 1').get()).toEqual({ fetched_at: null });
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM jakim_zones').get()!.n)).toBeGreaterThanOrEqual(50);
    expect(db.prepare("SELECT state, name FROM jakim_zones WHERE code = 'SGR01'").get()).toMatchObject({ state: 'Selangor' });
    for (const t of ['prayer_imports', 'prayer_file_days', 'prayer_corrections', 'location_cache']) {
      expect(db.prepare('SELECT COUNT(*) AS n FROM ' + t).get()!.n, t).toBe(0);
    }
  });

  it('is applied once and does not repeat, and the tables carry surau_id like the older ones', () => {
    const db = openDb(':memory:');
    dbs.push(db);
    expect(runMigrations(db)).toEqual([]);
    for (const t of ['jakim_zones', 'prayer_imports', 'prayer_file_days', 'prayer_corrections']) {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all();
      const sid = cols.find((c) => c.name === 'surau_id');
      expect(sid, t).toBeDefined();
      expect(sid!.dflt_value, t).toBe("'sdm'");
    }
    expect(MIGRATIONS.map((m) => m.name)).toContain('015-prayer-sources');
  });

  it('refuses an import kind outside csv and xlsx', () => {
    const db = openDb(':memory:');
    dbs.push(db);
    const bad = (): unknown => db.prepare(
      `INSERT INTO prayer_imports (id, kind, file_name, sha256, rows, date_from, date_to, overlap, inserted, replaced, skipped, actor, created_at)
       VALUES ('a', 'zip', 'f', 'x', 1, '2026-01-01', '2026-01-01', 'replace', 1, 0, 0, 't', 'now')`,
    ).run();
    expect(bad).toThrow();
  });
});
