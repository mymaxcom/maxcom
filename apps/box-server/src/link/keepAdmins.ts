import type { DatabaseSync } from 'node:sqlite';
import { sha256hex } from '../auth/crypto.ts';

/**
 * SECURITY code. The Pentadbir phones a restore keeps (operator decision 24 Nov 2026).
 *
 * A device row of the restored store stays unrevoked only when the same device id, with the same public key, was an
 * unrevoked phone of an active Pentadbir (or superadmin) in the store in use just before the swap, and is still one
 * in the restored store. The list is read from the live store when the restore is planned and again at the swap, is
 * carried in the journal and the restore mark, and is checked strictly at apply.
 */
export interface KeptDevice {
  /** The device id. */
  id: string;
  /** SHA-256 of the stored public key text. */
  key: string;
}

export const KEEP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_RE = /^[0-9a-f]{64}$/;
/** More than this is not a surau; a longer list is refused as unreadable. */
export const KEEP_MAX = 500;

/** True for a well-formed list of kept devices. */
export function isKeptList(v: unknown): v is KeptDevice[] {
  return (
    Array.isArray(v) &&
    v.length <= KEEP_MAX &&
    v.every((e) => e !== null && typeof e === 'object' && typeof (e as KeptDevice).id === 'string' && KEEP_ID_RE.test((e as KeptDevice).id) && typeof (e as KeptDevice).key === 'string' && KEY_RE.test((e as KeptDevice).key))
  );
}

function holdsAdmin(rolesJson: unknown): boolean {
  try {
    const roles = JSON.parse(String(rolesJson)) as unknown;
    return Array.isArray(roles) && (roles.includes('admin') || roles.includes('superadmin'));
  } catch {
    return false;
  }
}

/**
 * Unrevoked phone and app devices of active, not deleted people who hold admin or superadmin, with a public key, that
 * are no follower box row. Throws when the store cannot be read (the caller decides what that means).
 */
export function adminDevices(db: DatabaseSync): KeptDevice[] {
  const hasBoxes = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'linked_boxes'").get() !== undefined;
  const boxIds = new Set<string>();
  if (hasBoxes) for (const r of db.prepare('SELECT device_id FROM linked_boxes').all()) boxIds.add(String(r.device_id));
  const rows = db
    .prepare(
      `SELECT d.id AS id, d.public_jwk AS jwk, u.roles_json AS roles FROM devices d JOIN users u ON u.id = d.user_id
       WHERE d.revoked_at IS NULL AND d.platform <> 'kiosk' AND d.public_jwk IS NOT NULL AND u.active = 1 AND u.deleted_at IS NULL`,
    )
    .all();
  const out: KeptDevice[] = [];
  for (const r of rows) {
    const id = String(r.id);
    if (boxIds.has(id) || !KEEP_ID_RE.test(id) || !holdsAdmin(r.roles)) continue;
    out.push({ id, key: sha256hex(String(r.jwk)) });
  }
  return out.slice(0, KEEP_MAX);
}
