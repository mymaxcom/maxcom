import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '017-site-approvals', up };

/**
 * Cloud role: MAXCOM's approvals of boxes that registered themselves with the Worker (automatic link, T3b).
 * One row per box id, bound to the sha256 of the claim secret the box registered (`claim_hash`, 64 hex). The box
 * proves the secret once at `POST /api/sync/claim`; `claimed_at` then spends the approval. Revoking the site
 * deletes the row. A box never writes this table.
 */
function up(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE site_approvals (
      box_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      claim_hash TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      claimed_at TEXT
    );
  `);
}
