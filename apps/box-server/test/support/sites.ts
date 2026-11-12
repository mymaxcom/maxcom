import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { sha256hex } from '../../src/auth/crypto.ts';

export interface TestSite {
  boxId: string;
  surauId: string;
  token: string;
  headers: { authorization: string };
}

/** A linked site as Task 4's link-by-code will leave it: a row holding only the hash of the site key. */
export function insertSite(
  db: DatabaseSync,
  o: { boxId?: string; surauId?: string; linked?: boolean; revoked?: boolean } = {},
): TestSite {
  const boxId = o.boxId ?? randomBytes(8).toString('hex');
  const surauId = o.surauId ?? 'sdm';
  const token = randomBytes(32).toString('base64url');
  db.prepare(
    `INSERT INTO sites (surau_id, box_id, name, token_hash, linked_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    surauId,
    boxId,
    'Kotak ujian',
    sha256hex(token),
    o.linked === false ? null : '2026-11-05T00:00:00.000Z',
    o.revoked === true ? '2026-11-05T01:00:00.000Z' : null,
  );
  return { boxId, surauId, token, headers: { authorization: `Bearer ${token}` } };
}
