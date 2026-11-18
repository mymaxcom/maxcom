import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '022-people-relook', up };

const hasColumn = (db: DatabaseSync, table: string, column: string): boolean =>
  db.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === column);

function addColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/** The append-only trigger of 016, with one more clause: `names_json` is set once (NULL to a value), like `ref_no`. */
const IMMUTABLE_TRIGGER = `
  CREATE TRIGGER trg_fin_entries_immutable BEFORE UPDATE ON finance_entries FOR EACH ROW
  WHEN NEW.surau_id IS NOT OLD.surau_id OR NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind
    OR NEW.entry_date IS NOT OLD.entry_date OR NEW.fund_id IS NOT OLD.fund_id OR NEW.perihal_id IS NOT OLD.perihal_id
    OR NEW.amount_sen IS NOT OLD.amount_sen OR NEW.method IS NOT OLD.method OR NEW.reference IS NOT OLD.reference
    OR NEW.note IS NOT OLD.note OR NEW.payee IS NOT OLD.payee OR NEW.counters_json IS NOT OLD.counters_json
    OR NEW.denominations_json IS NOT OLD.denominations_json OR NEW.photo_id IS NOT OLD.photo_id
    OR NEW.kuliah_id IS NOT OLD.kuliah_id OR NEW.penceramah_id IS NOT OLD.penceramah_id
    OR NEW.penceramah_name IS NOT OLD.penceramah_name OR NEW.corrects_id IS NOT OLD.corrects_id
    OR NEW.correction_kind IS NOT OLD.correction_kind OR NEW.to_fund_id IS NOT OLD.to_fund_id
    OR NEW.reason IS NOT OLD.reason OR NEW.created_by IS NOT OLD.created_by OR NEW.device_id IS NOT OLD.device_id
    OR NEW.edited_at IS NOT OLD.edited_at OR NEW.received_at IS NOT OLD.received_at OR NEW.origin IS NOT OLD.origin
    OR NEW.op_id IS NOT OLD.op_id OR NEW.rev IS NOT OLD.rev
    OR (OLD.ref_no IS NOT NULL AND NEW.ref_no IS NOT OLD.ref_no)
    OR (OLD.names_json IS NOT NULL AND NEW.names_json IS NOT OLD.names_json)
  BEGIN
    SELECT RAISE(ABORT, 'finance_entries is append-only');
  END`;

/**
 * Peranti and Pengguna plan, Task S1. Every schema change of the plan in one migration so no later task needs another:
 * name snapshots (audit log, finance), enrolment bookkeeping (S5), soft delete and deactivation time (S9), phone (S10)
 * and the allocated ID columns, counters and unique indexes (S8). Only the two snapshot columns and `deactivated_at`
 * are backfilled here; the IDs are numbered by S8's `backfillIds`. Safe to run twice.
 */
function up(db: DatabaseSync): void {
  const now = new Date().toISOString();
  addColumn(db, 'change_log', 'actor_name', 'TEXT');
  addColumn(db, 'finance_entries', 'names_json', 'TEXT');
  addColumn(db, 'enrolments', 'cancelled_at', 'TEXT');
  addColumn(db, 'enrolments', 'device_id', 'TEXT');
  for (const c of ['deleted_at', 'deleted_by', 'deactivated_at', 'phone', 'no_src']) addColumn(db, 'users', c, 'TEXT');
  addColumn(db, 'users', 'no', 'INTEGER');
  addColumn(db, 'devices', 'no', 'INTEGER');
  addColumn(db, 'devices', 'no_src', 'TEXT');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_users_no ON users (surau_id, no_src, no) WHERE no IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_devices_no ON devices (surau_id, no_src, no) WHERE no IS NOT NULL;
    CREATE TABLE IF NOT EXISTS id_counters (
      surau_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      next INTEGER NOT NULL,
      PRIMARY KEY (surau_id, kind)
    );
  `);
  const flag = db.prepare("INSERT OR IGNORE INTO sync_state (key, value) VALUES (?, '1')");
  flag.run('people_resync');
  flag.run('ids_push');

  // The name used at the time, for every history row written before this migration.
  db.exec(`
    UPDATE change_log SET actor_name = (SELECT u.name FROM users u WHERE 'user:' || u.id = change_log.actor)
     WHERE actor_name IS NULL AND actor LIKE 'user:%'
  `);

  // Deactivated users: since their newest deactivation in the change log, else since now.
  const lastOff = db.prepare(
    "SELECT at, after_json FROM change_log WHERE entity = 'users' AND entity_id = ? ORDER BY id DESC",
  );
  const setOff = db.prepare('UPDATE users SET deactivated_at = ? WHERE id = ?');
  for (const u of db.prepare('SELECT id FROM users WHERE active = 0 AND deactivated_at IS NULL').all()) {
    let at = now;
    for (const r of lastOff.all(String(u.id))) {
      try {
        const after = JSON.parse(String(r.after_json)) as { active?: unknown } | null;
        if (after !== null && after.active === false) { at = String(r.at); break; }
      } catch { /* a row that does not parse says nothing */ }
    }
    setOff.run(at, String(u.id));
  }

  // Finance names, frozen once. The trigger is dropped only for this backfill and put back with the new clause.
  db.exec('DROP TRIGGER IF EXISTS trg_fin_entries_immutable');
  const userName = db.prepare('SELECT name FROM users WHERE id = ?');
  const deviceName = db.prepare('SELECT name FROM devices WHERE id = ?');
  const nameOf = (stmt: ReturnType<DatabaseSync['prepare']>, id: unknown): string | null => {
    if (typeof id !== 'string') return null;
    const r = stmt.get(id);
    return r !== undefined && typeof r.name === 'string' ? r.name : null;
  };
  const setNames = db.prepare('UPDATE finance_entries SET names_json = ? WHERE surau_id = ? AND id = ? AND names_json IS NULL');
  for (const e of db.prepare('SELECT surau_id, id, created_by, device_id, counters_json FROM finance_entries WHERE names_json IS NULL').all()) {
    const counters: Record<string, string> = {};
    if (typeof e.counters_json === 'string') {
      try {
        const list = JSON.parse(e.counters_json) as unknown;
        if (Array.isArray(list)) {
          for (const c of list) {
            const uid = typeof c === 'object' && c !== null ? (c as { userId?: unknown }).userId : undefined;
            const n = nameOf(userName, uid);
            if (typeof uid === 'string' && n !== null) counters[uid] = n;
          }
        }
      } catch { /* an unreadable list has no names to keep */ }
    }
    const names = { createdBy: nameOf(userName, e.created_by), device: nameOf(deviceName, e.device_id), counters };
    setNames.run(JSON.stringify(names), String(e.surau_id), String(e.id));
  }
  db.exec(IMMUTABLE_TRIGGER);
}
