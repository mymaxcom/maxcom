import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '005-poster-titles', up };

const ACTOR = 'system:migration-005';
const MAX_TITLE = 80;

type Row = { id: string; json: string };

/**
 * Every poster now has a name. A live poster stored without a usable title is named by its
 * current position among the live (not deleted) posters sorted by order, then id: `Poster 1`,
 * `Poster 2`, ... with no gaps. Posters that already have a title keep it, so running this again
 * changes nothing. Soft-deleted posters are skipped and not renamed.
 */
function up(db: DatabaseSync): void {
  // A database that still has an older content_items shape (tests of earlier migrations) has no posters.
  const columns = new Set((db.prepare('PRAGMA table_info(content_items)').all() as { name: string }[]).map((c) => c.name));
  if (!['kind', 'id', 'json', 'deleted_at'].every((c) => columns.has(c))) return;
  const rows = db
    .prepare("SELECT id, json FROM content_items WHERE kind = 'poster' AND deleted_at IS NULL ORDER BY id")
    .all() as unknown as Row[];

  const parsed = rows.flatMap((row) => {
    try {
      const value: unknown = JSON.parse(row.json);
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? [{ row, item: value as Record<string, unknown> }]
        : [];
    } catch {
      return [];
    }
  });
  const hasTitle = (item: Record<string, unknown>): boolean =>
    typeof item.title === 'string' && item.title.trim() !== '' && item.title.trim().length <= MAX_TITLE;

  const live = parsed.sort((a, b) => {
    const oa = typeof a.item.order === 'number' ? a.item.order : Number.MAX_SAFE_INTEGER;
    const ob = typeof b.item.order === 'number' ? b.item.order : Number.MAX_SAFE_INTEGER;
    return oa - ob || a.row.id.localeCompare(b.row.id);
  });
  const todo = live
    .map((p, i) => ({ ...p, position: i + 1 }))
    .filter((p) => !hasTitle(p.item));
  if (todo.length === 0) return;

  const now = new Date().toISOString();
  for (const { row, item, position } of todo) {
    const title = `Poster ${position}`;
    const after = JSON.stringify({ ...item, title });
    db.prepare("UPDATE content_items SET json = ?, updated_at = ?, updated_by = ? WHERE kind = 'poster' AND id = ?").run(
      after,
      now,
      ACTOR,
      row.id,
    );
    db.prepare(
      'INSERT INTO change_log (at, actor, entity, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(now, ACTOR, 'content:poster', row.id, row.json, after);
  }

  // Let open screens (kiosk, app) reload the content once.
  const current = db.prepare("SELECT value FROM meta WHERE key = 'version'").get();
  const next = (current !== undefined && typeof current.value === 'string' ? Number(current.value) || 0 : 0) + 1;
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    'version',
    String(next),
  );
}
