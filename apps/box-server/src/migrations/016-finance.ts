import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '016-finance', up };

/**
 * Plan 7. Finance: configurable tabung and perihal lookups, an append-only ledger, month states, photo metadata
 * (the bytes live under <dataDir>/finance/photos, never in /assets) and the box's reference-number counters.
 * Every table carries `surau_id` like the older ones. `finance_entries` is append-only: the triggers refuse
 * every update except filling `ref_no` once (NULL to a value) and `cloud_received_at`, and every delete.
 */
function up(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE finance_funds (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      public INTEGER NOT NULL DEFAULT 0,
      target_sen INTEGER,
      jumaat INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
      rev TEXT NOT NULL, edited_at TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'local'
    );
    CREATE TABLE finance_perihal (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      id TEXT PRIMARY KEY,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      label TEXT NOT NULL,
      system TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
      rev TEXT NOT NULL, edited_at TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'local'
    );
    CREATE TABLE finance_entries (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('in','out','opening','adjust')),
      entry_date TEXT NOT NULL,
      fund_id TEXT NOT NULL REFERENCES finance_funds(id),
      perihal_id TEXT REFERENCES finance_perihal(id),
      amount_sen INTEGER NOT NULL CHECK (typeof(amount_sen) = 'integer' AND amount_sen >= 0),
      method TEXT CHECK (method IN ('tunai','bank','duitnow','cek')),
      reference TEXT,
      note TEXT,
      payee TEXT,
      counters_json TEXT,
      denominations_json TEXT,
      photo_id TEXT,
      kuliah_id TEXT, penceramah_id TEXT, penceramah_name TEXT,
      corrects_id TEXT REFERENCES finance_entries(id),
      correction_kind TEXT CHECK (correction_kind IN ('amount','void','fund')),
      to_fund_id TEXT REFERENCES finance_funds(id),
      reason TEXT,
      ref_no TEXT,
      created_by TEXT NOT NULL,
      device_id TEXT,
      edited_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      cloud_received_at TEXT,
      origin TEXT NOT NULL DEFAULT 'local', op_id TEXT, rev TEXT NOT NULL
    );
    CREATE INDEX idx_fin_entries_month ON finance_entries (surau_id, entry_date);
    CREATE INDEX idx_fin_entries_fund ON finance_entries (fund_id, entry_date);
    CREATE INDEX idx_fin_entries_corrects ON finance_entries (corrects_id) WHERE corrects_id IS NOT NULL;
    CREATE UNIQUE INDEX idx_fin_entries_ref ON finance_entries (surau_id, ref_no) WHERE ref_no IS NOT NULL;
    CREATE TABLE finance_months (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      ym TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open','closed')),
      closed_at TEXT, closed_by TEXT,
      report_json TEXT,
      updated_at TEXT NOT NULL, rev TEXT NOT NULL, edited_at TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'local',
      PRIMARY KEY (surau_id, ym)
    );
    CREATE TABLE finance_photos (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      mime TEXT NOT NULL,
      bytes INTEGER NOT NULL, width INTEGER, height INTEGER,
      created_at TEXT NOT NULL, created_by TEXT NOT NULL,
      present INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE finance_counters (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      letter TEXT NOT NULL,
      next INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (surau_id, letter)
    );

    -- Append-only: only ref_no (NULL -> value, once) and cloud_received_at may change; nothing is ever deleted.
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
    BEGIN
      SELECT RAISE(ABORT, 'finance_entries is append-only');
    END;
    CREATE TRIGGER trg_fin_entries_no_delete BEFORE DELETE ON finance_entries
    BEGIN
      SELECT RAISE(ABORT, 'finance_entries is append-only');
    END;
  `);
}
