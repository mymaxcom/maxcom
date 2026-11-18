import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_SURAU_ID } from '../sync/verify.ts';

export const migration = { name: '019-multi-surau', up };

/**
 * Plan 14 section 4: one cloud, many suraus. Same code on box and cloud, one transaction (runMigrations), one-way
 * (restore a backup to undo). A box stays single-tenant: its `surau_id` columns keep the local constant.
 *
 * 1. `suraus`: one row per distinct `sites.surau_id` (the cloud); a box (no sites rows) gets none. Task 8 adds
 *    `suraus.storage_limit_bytes` (null = the 2 GiB default) and `surau_assets` (which surau holds which asset, for
 *    the per-surau storage count); a cloud with exactly one surau (the pilot) has every existing asset counted for it.
 * 2. `sites.role`; `site_approvals.surau_id` (NULL: an approval with no target can never be claimed) and `mode`.
 * 3. `devices.box_id` (stamped only where the device's surau has exactly one site), `devices.ops/ops_at/ops_by`,
 *    `enrolments.ops`: every existing device and code starts public. `youtube_pending_complete.surau_id`.
 * 4. `surau_id` joins the primary key of every table whose id is a natural key or chosen by a client. A table that
 *    already has the new key (a fresh database: db.ts TABLES) is left alone. Foreign keys into a rebuilt table are
 *    re-pointed at its composite key, so they stay valid under `foreign_keys = ON`; triggers and indexes are
 *    recreated. `change_log` keeps its rowid key; its op id is unique per surau instead of globally.
 * 6. Every user holding `superadmin` gets `surau_id = '*'` (cloud and box). Their devices keep their surau.
 * 7. Indexes for the per-surau reads.
 * 8. The dirty trigger of 009 marks only the boxes of the changed surau (`*` user and device changes: every box).
 */
function up(db: DatabaseSync): void {
  // A rebuild drops and recreates parent tables; the checks run at COMMIT, when every row is back. Resets itself
  // at the end of the transaction.
  db.exec('PRAGMA defer_foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS suraus (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'surau',
      location TEXT NOT NULL DEFAULT '',
      zone TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      linked_at TEXT,
      reviewed_at TEXT,
      suspended_at TEXT,
      suspended_reason TEXT,
      storage_limit_bytes INTEGER
    );
    CREATE TABLE IF NOT EXISTS surau_assets (
      surau_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (surau_id, asset_id)
    );
  `);
  addColumn(db, 'suraus', 'storage_limit_bytes', 'INTEGER');

  addColumn(db, 'sites', 'role', "TEXT NOT NULL DEFAULT 'primary'");
  addColumn(db, 'site_approvals', 'surau_id', 'TEXT');
  addColumn(db, 'site_approvals', 'mode', "TEXT NOT NULL DEFAULT 'primary'");
  addColumn(db, 'devices', 'box_id', 'TEXT');
  addColumn(db, 'devices', 'ops', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'devices', 'ops_at', 'TEXT');
  addColumn(db, 'devices', 'ops_by', 'TEXT');
  addColumn(db, 'enrolments', 'ops', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'youtube_pending_complete', 'surau_id', `TEXT NOT NULL DEFAULT '${DEFAULT_SURAU_ID}'`);

  rebuildKeys(db);

  db.exec(`
    DROP INDEX IF EXISTS idx_change_log_op;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_change_log_surau_op ON change_log (surau_id, op_id) WHERE op_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_change_log_surau_id ON change_log (surau_id, id);
    CREATE INDEX IF NOT EXISTS idx_content_items_surau_kind_deleted ON content_items (surau_id, kind, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_users_surau ON users (surau_id);
    CREATE INDEX IF NOT EXISTS idx_devices_surau ON devices (surau_id);
    CREATE INDEX IF NOT EXISTS idx_sites_surau ON sites (surau_id);
  `);

  seedSuraus(db);
  // Task 8 storage limit: on a cloud with exactly one surau (the pilot), every asset it already holds counts for it.
  if (Number(db.prepare('SELECT COUNT(*) AS n FROM suraus').get()!.n) === 1) {
    db.exec('INSERT OR IGNORE INTO surau_assets (surau_id, asset_id, bytes, created_at) SELECT s.id, a.id, a.bytes, a.created_at FROM assets a, suraus s');
  }

  // The device's home box: only where its surau has exactly one site (no guess for two). A box has no sites rows.
  db.exec(`
    UPDATE devices
       SET box_id = (SELECT s.box_id FROM sites s WHERE s.surau_id = devices.surau_id)
     WHERE box_id IS NULL
       AND (SELECT COUNT(*) FROM sites s WHERE s.surau_id = devices.surau_id) = 1
  `);

  db.exec(`UPDATE users SET surau_id = '*' WHERE roles_json LIKE '%"superadmin"%' AND surau_id <> '*'`);

  redefineDirtyTrigger(db);
}

/**
 * 009's dirty trigger, per surau (Plan 14 Task 6): a change marks only the boxes of the surau it is filed under; a
 * Pentadbir MAXCOM user or device change (filed under `'*'`) marks every box, since it is in every site's feed.
 * Unchanged otherwise: the outbox switch, the entities, the sender's own box skipped, the seq never lowered.
 */
function redefineDirtyTrigger(db: DatabaseSync): void {
  const on = "(SELECT value FROM sync_state WHERE key = 'worker_outbox') = '1'";
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
  db.exec(`
    DROP TRIGGER IF EXISTS worker_outbox_dirty;
    CREATE TRIGGER worker_outbox_dirty AFTER INSERT ON change_log
    WHEN ${on} AND (NEW.entity LIKE 'content:%' OR NEW.entity IN ('settings', 'users', 'user', 'devices', 'device'))
    BEGIN
      INSERT INTO worker_outbox (kind, key, body, created_at)
        SELECT 'dirty', 'dirty/' || box_id, json_object('seq', NEW.id), ${now}
          FROM sites
         WHERE linked_at IS NOT NULL AND revoked_at IS NULL AND token_hash IS NOT NULL AND NEW.origin <> 'box:' || box_id
           AND (sites.surau_id = NEW.surau_id OR (NEW.surau_id = '*' AND NEW.entity IN ('users', 'user', 'devices', 'device')))
      ON CONFLICT(key) DO UPDATE SET
        kind = 'dirty',
        body = json_object('seq', max(NEW.id, COALESCE(json_extract(worker_outbox.body, '$.seq'), 0))),
        attempts = CASE WHEN worker_outbox.state = 'failed' THEN 0 ELSE worker_outbox.attempts END,
        next_at = CASE WHEN worker_outbox.state = 'failed' THEN '' ELSE worker_outbox.next_at END,
        state = 'pending',
        rev = worker_outbox.rev + 1;
    END;
  `);
}

function columnsOf(db: DatabaseSync, table: string): { name: string; pk: number }[] {
  return db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .map((c) => ({ name: String(c.name), pk: Number(c.pk) }));
}

function addColumn(db: DatabaseSync, table: string, column: string, decl: string): void {
  if (columnsOf(db, table).some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${decl}`);
}

function primaryKey(db: DatabaseSync, table: string): string[] {
  return columnsOf(db, table)
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
}

interface Rebuild {
  table: string;
  key: string[];
  /** The full table as it is after 019 (every column the released migrations gave it, the new key). */
  ddl: string;
}

/** Parents before children: the create order. Drops run in reverse. */
const REBUILDS: readonly Rebuild[] = [
  {
    table: 'settings',
    key: ['surau_id', 'feature'],
    ddl: `CREATE TABLE settings (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      feature TEXT NOT NULL,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      rev TEXT, edited_at TEXT, origin TEXT NOT NULL DEFAULT 'local', field_stamps TEXT,
      PRIMARY KEY (surau_id, feature)
    )`,
  },
  {
    table: 'meta',
    key: ['surau_id', 'key'],
    ddl: `CREATE TABLE meta (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (surau_id, key)
    )`,
  },
  {
    table: 'prayer_days',
    key: ['surau_id', 'zone', 'date'],
    ddl: `CREATE TABLE prayer_days (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      zone TEXT NOT NULL,
      date TEXT NOT NULL,
      json TEXT NOT NULL,
      fetched_at TEXT,
      PRIMARY KEY (surau_id, zone, date)
    )`,
  },
  {
    table: 'prayer_imports',
    key: ['surau_id', 'id'],
    ddl: `CREATE TABLE prayer_imports (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      id TEXT NOT NULL,
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
      arrived_at TEXT,
      PRIMARY KEY (surau_id, id)
    )`,
  },
  {
    table: 'prayer_file_days',
    key: ['surau_id', 'date'],
    ddl: `CREATE TABLE prayer_file_days (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      date TEXT NOT NULL,
      import_id TEXT NOT NULL,
      json TEXT NOT NULL,
      prev_import_id TEXT,
      prev_json TEXT,
      PRIMARY KEY (surau_id, date),
      FOREIGN KEY (surau_id, import_id) REFERENCES prayer_imports (surau_id, id)
    )`,
  },
  {
    table: 'prayer_corrections',
    key: ['surau_id', 'date', 'prayer'],
    ddl: `CREATE TABLE prayer_corrections (
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
      PRIMARY KEY (surau_id, date, prayer)
    )`,
  },
  {
    table: 'content_items',
    key: ['surau_id', 'kind', 'id'],
    ddl: `CREATE TABLE content_items (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      deleted_at TEXT, rev TEXT, edited_at TEXT, origin TEXT NOT NULL DEFAULT 'local',
      PRIMARY KEY (surau_id, kind, id)
    )`,
  },
  {
    table: 'hadis_source_updates',
    key: ['surau_id', 'item_id'],
    ddl: `CREATE TABLE hadis_source_updates (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      item_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      new_json TEXT NOT NULL,
      found_at TEXT NOT NULL,
      PRIMARY KEY (surau_id, item_id)
    )`,
  },
  {
    table: 'applied_ops',
    key: ['surau_id', 'op_id'],
    ddl: `CREATE TABLE applied_ops (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      op_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      status TEXT NOT NULL,
      rev TEXT,
      applied_at TEXT NOT NULL,
      result_status TEXT NOT NULL DEFAULT 'applied',
      winner_json TEXT,
      PRIMARY KEY (surau_id, op_id)
    )`,
  },
  {
    table: 'uploads',
    key: ['surau_id', 'id'],
    ddl: `CREATE TABLE uploads (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      id TEXT NOT NULL,
      kuliah_id TEXT,
      device_id TEXT NOT NULL,
      video_id TEXT,
      state TEXT NOT NULL,
      bytes INTEGER,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      replace_video_id TEXT,
      replaced_at TEXT,
      PRIMARY KEY (surau_id, id)
    )`,
  },
  {
    table: 'finance_funds',
    key: ['surau_id', 'id'],
    ddl: `CREATE TABLE finance_funds (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      public INTEGER NOT NULL DEFAULT 0,
      target_sen INTEGER,
      jumaat INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
      rev TEXT NOT NULL, edited_at TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'local',
      PRIMARY KEY (surau_id, id)
    )`,
  },
  {
    table: 'finance_perihal',
    key: ['surau_id', 'id'],
    ddl: `CREATE TABLE finance_perihal (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      label TEXT NOT NULL,
      system TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
      rev TEXT NOT NULL, edited_at TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'local',
      PRIMARY KEY (surau_id, id)
    )`,
  },
  {
    // Append-only: the triggers of 016 are recreated after the copy.
    table: 'finance_entries',
    key: ['surau_id', 'id'],
    ddl: `CREATE TABLE finance_entries (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('in','out','opening','adjust')),
      entry_date TEXT NOT NULL,
      fund_id TEXT NOT NULL,
      perihal_id TEXT,
      amount_sen INTEGER NOT NULL CHECK (typeof(amount_sen) = 'integer' AND amount_sen >= 0),
      method TEXT CHECK (method IN ('tunai','bank','duitnow','cek')),
      reference TEXT,
      note TEXT,
      payee TEXT,
      counters_json TEXT,
      denominations_json TEXT,
      photo_id TEXT,
      kuliah_id TEXT, penceramah_id TEXT, penceramah_name TEXT,
      corrects_id TEXT,
      correction_kind TEXT CHECK (correction_kind IN ('amount','void','fund')),
      to_fund_id TEXT,
      reason TEXT,
      ref_no TEXT,
      created_by TEXT NOT NULL,
      device_id TEXT,
      edited_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      cloud_received_at TEXT,
      origin TEXT NOT NULL DEFAULT 'local', op_id TEXT, rev TEXT NOT NULL,
      PRIMARY KEY (surau_id, id),
      FOREIGN KEY (surau_id, fund_id) REFERENCES finance_funds (surau_id, id),
      FOREIGN KEY (surau_id, perihal_id) REFERENCES finance_perihal (surau_id, id),
      FOREIGN KEY (surau_id, corrects_id) REFERENCES finance_entries (surau_id, id),
      FOREIGN KEY (surau_id, to_fund_id) REFERENCES finance_funds (surau_id, id)
    )`,
  },
  {
    table: 'finance_photos',
    key: ['surau_id', 'id'],
    ddl: `CREATE TABLE finance_photos (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      mime TEXT NOT NULL,
      bytes INTEGER NOT NULL, width INTEGER, height INTEGER,
      created_at TEXT NOT NULL, created_by TEXT NOT NULL,
      present INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (surau_id, id)
    )`,
  },
];

const STAGE = '_m019_';

function rebuildKeys(db: DatabaseSync): void {
  const todo = REBUILDS.filter((r) => primaryKey(db, r.table).join(',') !== r.key.join(','));
  if (todo.length === 0) return;

  // Stage every row, the indexes and the triggers of each table to rebuild.
  const saved = new Map<string, { columns: string[]; objects: string[] }>();
  for (const r of todo) {
    const old = columnsOf(db, r.table).map((c) => c.name);
    const objects = db
      .prepare("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name")
      .all(r.table)
      .map((o) => String(o.sql));
    saved.set(r.table, { columns: old, objects });
    db.exec(`DROP TABLE IF EXISTS "${STAGE}${r.table}"`);
    db.exec(`CREATE TABLE "${STAGE}${r.table}" AS SELECT * FROM "${r.table}"`);
  }

  // Children before parents, so no drop leaves a dangling reference behind it.
  for (const r of [...todo].reverse()) db.exec(`DROP TABLE "${r.table}"`);

  for (const r of todo) {
    db.exec(r.ddl);
    const fresh = new Set(columnsOf(db, r.table).map((c) => c.name));
    const { columns, objects } = saved.get(r.table)!;
    const lost = columns.filter((c) => !fresh.has(c));
    // One-way, but never lossy: a column this migration does not know aborts the whole transaction.
    if (lost.length > 0) throw new Error(`019-multi-surau: ${r.table} has unknown columns ${lost.join(', ')}`);
    const list = columns.map((c) => `"${c}"`).join(', ');
    db.exec(`INSERT INTO "${r.table}" (${list}) SELECT ${list} FROM "${STAGE}${r.table}"`);
    db.exec(`DROP TABLE "${STAGE}${r.table}"`);
    for (const sql of objects) db.exec(sql);
  }
}

/** One `suraus` row per distinct `sites.surau_id` (revoked sites count). A box has no sites rows: no row. */
function seedSuraus(db: DatabaseSync): void {
  const ids = db.prepare('SELECT DISTINCT surau_id FROM sites ORDER BY surau_id').all().map((r) => String(r.surau_id));
  if (ids.length === 0) return;
  const info = db.prepare("SELECT json FROM settings WHERE surau_id = ? AND feature = 'surauInfo'");
  const firstSite = db.prepare(
    'SELECT name FROM sites WHERE surau_id = ? ORDER BY linked_at IS NULL, linked_at, box_id LIMIT 1',
  );
  const linked = db.prepare('SELECT MIN(linked_at) AS at FROM sites WHERE surau_id = ?');
  const insert = db.prepare(
    "INSERT OR IGNORE INTO suraus (id, name, created_at, created_by, linked_at) VALUES (?, ?, ?, 'migration', ?)",
  );
  const now = new Date().toISOString();
  for (const id of ids) {
    if (id === '*') continue; // the Pentadbir MAXCOM marker is not a surau
    let name = '';
    const row = info.get(id);
    if (row !== undefined && typeof row.json === 'string') {
      try {
        const v = JSON.parse(row.json) as { name?: unknown };
        if (typeof v?.name === 'string') name = v.name.trim();
      } catch {
        /* unreadable settings: fall back */
      }
    }
    if (name === '') {
      const site = firstSite.get(id);
      if (site !== undefined && typeof site.name === 'string') name = site.name.trim();
    }
    if (name === '') name = id;
    const at = linked.get(id)?.at;
    insert.run(id, name, now, typeof at === 'string' ? at : null);
  }
}
