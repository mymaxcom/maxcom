import type { DatabaseSync } from 'node:sqlite';
import { tx } from '../auth/users.ts';
import { BOX_NAME_RE } from '../boxName.ts';
import { LOCAL_SURAU_ID } from '../tenant.ts';
import { BOX_NAME_MAX, setBoxNameIn } from './state.ts';

/**
 * The box's display name (`meta.box_name`) follows the surau (2026.11.14): `box<N>-<surau short name or name>` where N is
 * the number of its local name (`box1-surau.local` gives 1; a box with no numbered name gets no prefix: just the surau
 * name), for example `box1-Surau Contoh`. The user may rename it. When the surau name changes, a box name that still
 * equals the default for the OLD surau name, or starts with the `box<N>-` prefix and contains the old surau name, is rewritten
 * with the new one; any other custom name (even one that happens to contain the old surau name) is left alone. The hidden unique box id never changes (devices and the cloud key on it).
 */

/** The old default a box carried until the surau name was known: `MAXCOM 4F2A`. */
const OLD_DEFAULT = /^MAXCOM [0-9A-F]{4}$/;

/** What the box name was last derived from (`meta.box_name_basis`), so a later change of surau name or local name can be followed. */
interface Basis {
  name: string;
  label: string;
  local: string | null;
}

/** N of `box<N>-surau.local`, or null for no numbered name. */
export function localBoxNumber(localName: string | null): number | null {
  if (localName === null) return null;
  const m = BOX_NAME_RE.exec(localName.toLowerCase());
  return m === null ? null : Number(m[1]);
}

/** The name the surau goes by in the box name: the home-screen short name when it has one, else the name. */
export function surauLabelOf(info: { name?: unknown; shortName?: unknown }): string {
  const short = typeof info.shortName === 'string' ? info.shortName.trim() : '';
  const name = typeof info.name === 'string' ? info.name.trim() : '';
  return short !== '' ? short : name;
}

const fit = (s: string): string => (s.length > BOX_NAME_MAX ? s.slice(0, BOX_NAME_MAX).trimEnd() : s);

/** `box1-Surau Contoh`, or just the label when the box has no numbered local name. Empty when the surau has no name. */
export function defaultBoxNameFor(localName: string | null, label: string): string {
  if (label === '') return '';
  const n = localBoxNumber(localName);
  return fit(n === null ? label : `box${n}-${label}`);
}

function metaValue(db: DatabaseSync, key: string): string | null {
  const r = db.prepare('SELECT value FROM meta WHERE surau_id = ? AND key = ?').get(LOCAL_SURAU_ID, key);
  return typeof r?.value === 'string' ? r.value : null;
}

function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO meta (surau_id, key, value) VALUES (?, ?, ?) ON CONFLICT(surau_id, key) DO UPDATE SET value = excluded.value').run(LOCAL_SURAU_ID, key, value);
}

function readBasis(db: DatabaseSync): Basis | null {
  const raw = metaValue(db, 'box_name_basis');
  if (raw === null) return null;
  try {
    const b = JSON.parse(raw) as Record<string, unknown>;
    if (typeof b.name !== 'string' || typeof b.label !== 'string') return null;
    return { name: b.name, label: b.label, local: typeof b.local === 'string' ? b.local : null };
  } catch {
    return null;
  }
}

/** The surau's stored name and short name, or null while the surau has none (before the setup form: nothing to follow). */
export function storedSurauInfo(db: DatabaseSync): { name: string; label: string } | null {
  const row = db.prepare("SELECT json FROM settings WHERE surau_id = ? AND feature = 'surauInfo'").get(LOCAL_SURAU_ID);
  if (typeof row?.json !== 'string') return null;
  try {
    const j = JSON.parse(row.json) as Record<string, unknown>;
    const name = typeof j.name === 'string' ? j.name.trim() : '';
    if (name === '') return null;
    return { name, label: surauLabelOf(j) };
  } catch {
    return null;
  }
}

/**
 * Brings the box name in line with the surau name and the local name. Safe to call at any time and as often as wanted: it
 * writes only when the name has to change (or when what it is derived from moved). Returns true when the box name changed
 * (the caller announces the new version). A name the user chose that does not hold the surau name is never touched.
 */
export function followSurauName(db: DatabaseSync, boxId: string, localName: string | null, actor = 'system:box-name'): boolean {
  const info = storedSurauInfo(db);
  if (info === null) return false;
  const basis = readBasis(db);
  const local = localBoxNumber(localName) === null ? null : (localName as string).toLowerCase();
  const next: Basis = { name: info.name, label: info.label, local };
  if (basis !== null && basis.name === next.name && basis.label === next.label && basis.local === next.local) return false;

  const currentRaw = metaValue(db, 'box_name');
  const current = currentRaw === null ? '' : currentRaw.trim();
  const target = defaultBoxNameFor(localName, info.label);
  let value: string | null = null;
  if (current === '' || OLD_DEFAULT.test(current)) {
    value = target;
  } else if (basis !== null) {
    const was = [defaultBoxNameFor(basis.local, basis.label), defaultBoxNameFor(basis.local, basis.name)];
    // the old surau name is replaced inside the name only when it is a `box<N>-` name (the box's own scheme); never inside unrelated custom text
    const ownScheme = /^box\d+-/i.test(current);
    if (was.includes(current)) value = target;
    else if (!ownScheme) value = null;
    else if (basis.name !== info.name && basis.name !== '' && current.includes(basis.name)) value = fit(current.split(basis.name).join(info.name));
    else if (basis.label !== info.label && basis.label !== '' && current.includes(basis.label)) value = fit(current.split(basis.label).join(info.label));
  }
  let changed = false;
  tx(db, () => {
    if (value !== null && value !== '' && value !== current) {
      setBoxNameIn(db, boxId, value, actor);
      changed = true;
    }
    setMeta(db, 'box_name_basis', JSON.stringify(next));
  });
  return changed;
}
