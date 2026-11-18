import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '020-site-theme-support', up };

/**
 * Which theme contract and which built-in themes each box supports, as the box reported them in its
 * `X-Maxcom-Themes` header (cloud role; a box never reads these). NULL means the box never reported (an older
 * MAXCOM), which the app treats as "not supported".
 */
function up(db: DatabaseSync): void {
  // Renumbered from 019 when merged with 019-multi-surau: a box that already ran the old name has the columns.
  const have = new Set(db.prepare('PRAGMA table_info(sites)').all().map((r) => String(r.name)));
  if (!have.has('theme_contract')) db.exec('ALTER TABLE sites ADD COLUMN theme_contract INTEGER');
  if (!have.has('theme_builtins')) db.exec('ALTER TABLE sites ADD COLUMN theme_builtins TEXT');
}
