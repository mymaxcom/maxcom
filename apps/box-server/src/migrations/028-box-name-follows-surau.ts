import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '028-box-name-follows-surau', up };

/** The old default a box carried until now: `MAXCOM 4F2A`. */
const OLD_DEFAULT = /^MAXCOM [0-9A-F]{4}$/;
const BOX_NAME_MAX = 60;

/**
 * The box's display name follows the surau (2026.11.14): a box still named by the old default (`MAXCOM XXXX`) gets the
 * new default once, the surau name (its short name when it has one). The `box<N>-` prefix needs the numbered local name,
 * which only the running box knows (its certificate): it is added at start (`followSurauName`), which also remembers what the
 * name was derived from (`meta.box_name_basis`) so a later rename of the surau is followed. A name the user chose is never
 * touched; a box whose surau has no name yet keeps its old default. The hidden box id is not involved. Nothing is logged or
 * stamped (the box name is a local label). Safe to run twice: the second run finds no old default.
 */
function up(db: DatabaseSync): void {
  const have = new Set(db.prepare('PRAGMA table_info(meta)').all().map((r) => String(r.name)));
  if (!have.has('surau_id') || !have.has('key') || !have.has('value')) return;
  const rows = db.prepare("SELECT surau_id, value FROM meta WHERE key = 'box_name'").all();
  for (const r of rows) {
    const current = typeof r.value === 'string' ? r.value.trim() : '';
    if (!OLD_DEFAULT.test(current)) continue;
    const s = db.prepare("SELECT json FROM settings WHERE surau_id = ? AND feature = 'surauInfo'").get(String(r.surau_id));
    if (typeof s?.json !== 'string') continue;
    let info: Record<string, unknown>;
    try {
      info = JSON.parse(s.json) as Record<string, unknown>;
    } catch {
      continue;
    }
    const name = typeof info.name === 'string' ? info.name.trim() : '';
    if (name === '') continue;
    const short = typeof info.shortName === 'string' ? info.shortName.trim() : '';
    const label = short !== '' ? short : name;
    const value = label.length > BOX_NAME_MAX ? label.slice(0, BOX_NAME_MAX).trimEnd() : label;
    db.prepare("UPDATE meta SET value = ? WHERE surau_id = ? AND key = 'box_name'").run(value, String(r.surau_id));
    db.prepare("INSERT INTO meta (surau_id, key, value) VALUES (?, 'box_name_basis', ?) ON CONFLICT(surau_id, key) DO UPDATE SET value = excluded.value")
      .run(String(r.surau_id), JSON.stringify({ name, label, local: null }));
  }
}
