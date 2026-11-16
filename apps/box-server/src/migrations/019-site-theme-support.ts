import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '019-site-theme-support', up };

/**
 * Which theme contract and which built-in themes each box supports, as the box reported them in its
 * `X-Maxcom-Themes` header (cloud role; a box never reads these). NULL means the box never reported (an older
 * MAXCOM), which the app treats as "not supported".
 */
function up(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE sites ADD COLUMN theme_contract INTEGER;
    ALTER TABLE sites ADD COLUMN theme_builtins TEXT;
  `);
}
