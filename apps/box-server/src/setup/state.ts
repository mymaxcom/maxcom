import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { defaultBoxName } from '@surau/core';
import type { BoxState, BoxStateReason } from '@surau/core';
import { AuthError, logChange, tx } from '../auth/users.ts';
import { bumpVersion } from '../settingsStore.ts';

/** Active users holding `admin` (or `superadmin`) with at least one unrevoked device that is not a TV screen. */
export function activeAdminDeviceCount(db: DatabaseSync): number {
  const rows = db
    .prepare(
      `SELECT u.roles_json AS roles FROM users u
       WHERE u.active = 1
         AND EXISTS (SELECT 1 FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL AND d.platform <> 'kiosk')`,
    )
    .all();
  let n = 0;
  for (const r of rows) {
    try {
      const roles = JSON.parse(String(r.roles)) as unknown;
      if (Array.isArray(roles) && (roles.includes('admin') || roles.includes('superadmin'))) n++;
    } catch {
      /* unreadable roles never count */
    }
  }
  return n;
}

function syncStateValue(db: DatabaseSync, key: string): string | null {
  const r = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
  return typeof r?.value === 'string' ? r.value : null;
}

/** The box state of the database (a database that cannot be opened is decided by main.ts, not here). */
export function boxState(db: DatabaseSync): { state: BoxState; reason: BoxStateReason } {
  if (syncStateValue(db, 'suspended') === '1') return { state: 'locked', reason: 'none' };
  const users = Number(db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n ?? 0);
  if (users === 0) return { state: 'setup', reason: 'none' };
  if (activeAdminDeviceCount(db) > 0) return { state: 'active', reason: 'none' };
  return { state: 'recovery', reason: 'no_admin' };
}

export const BOX_NAME_MAX = 60;

/** `meta.box_name`, or `MAXCOM XXXX` until the setup form (or Tetapan) renames the box. */
export function boxName(db: DatabaseSync, boxId: string): string {
  const r = db.prepare("SELECT value FROM meta WHERE key = 'box_name'").get();
  return typeof r?.value === 'string' && r.value.trim() !== '' ? r.value : defaultBoxName(boxId);
}

/** 1..60 characters after trimming, no control characters. */
export function checkBoxName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  // eslint-disable-next-line no-control-regex
  if (name.length < 1 || name.length > BOX_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new AuthError(400, 'bad_box_name', 'Nama MAXCOM mesti 1 hingga 60 aksara');
  }
  return name;
}

/** Writes `meta.box_name` and a change_log row. The caller owns the transaction when `inTx` is true. */
export function setBoxNameIn(db: DatabaseSync, boxId: string, name: string, actor: string): void {
  const before = boxName(db, boxId);
  db.prepare("INSERT INTO meta (key, value) VALUES ('box_name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(name);
  logChange(db, actor, 'box', boxId, { name: before }, { name });
  bumpVersion(db);
}

export function setBoxName(db: DatabaseSync, boxId: string, rawName: unknown, actor: string): string {
  const name = checkBoxName(rawName);
  tx(db, () => setBoxNameIn(db, boxId, name, actor));
  return name;
}

export interface BoxJson {
  boxName: string;
  surauName: string | null;
}

const boxJsonPath = (dataDir: string): string => join(dataDir, 'box.json');

/** Plain file read only when the database cannot be opened (the damaged-database screen). Never holds a secret. */
export function writeBoxJson(dataDir: string, data: BoxJson): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    const tmp = `${boxJsonPath(dataDir)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ boxName: data.boxName, surauName: data.surauName }), 'utf8');
    renameSync(tmp, boxJsonPath(dataDir));
  } catch {
    /* best effort: the file is only a hint for a broken database */
  }
}

export function readBoxJson(dataDir: string): BoxJson | null {
  try {
    const j = JSON.parse(readFileSync(boxJsonPath(dataDir), 'utf8')) as Record<string, unknown>;
    return {
      boxName: typeof j.boxName === 'string' ? j.boxName.slice(0, BOX_NAME_MAX) : '',
      surauName: typeof j.surauName === 'string' ? j.surauName.slice(0, 120) : null,
    };
  } catch {
    return null;
  }
}
