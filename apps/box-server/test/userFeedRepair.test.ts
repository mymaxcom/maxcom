import { generateKeyPairSync } from 'node:crypto';
import type { webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { beginEnrolment, completeEnrolment } from '../src/auth/devices.ts';
import { createUser, logChange } from '../src/auth/users.ts';
import { openDb } from '../src/db.ts';
import { migration } from '../src/migrations/018-user-feed-repair.ts';

type JsonWebKey = webcrypto.JsonWebKey;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'surau-userfeed-'));
  dirs.push(dir);
  return openDb(join(dir, 'box.db'));
}

function jwk(): JsonWebKey {
  const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return kp.publicKey.export({ format: 'jwk' }) as JsonWebKey;
}

/** The record a feed reader ends up with: readers replace their copy with the latest `after`. */
function readerCopy(db: DatabaseSync, userId: string): Record<string, unknown> {
  const row = db
    .prepare("SELECT after_json FROM change_log WHERE entity IN ('users', 'user') AND entity_id = ? ORDER BY id DESC LIMIT 1")
    .get(userId);
  return JSON.parse(String(row?.after_json)) as Record<string, unknown>;
}

describe('user records in the change feed', () => {
  it('an enrolment that sets a PIN logs the full user, not a nameless fragment', () => {
    const db = freshDb();
    const u = createUser(db, { name: 'Demo Kandungan', roles: ['admin'] }, 'local');
    const { code } = beginEnrolment(db, { userId: u.id, deviceName: 'Telefon' }, 'local');
    completeEnrolment(db, { code, publicJwk: jwk(), platform: 'android', pin: '482915' }, '10.0.0.5');

    const copy = readerCopy(db, u.id);
    expect(copy).toMatchObject({ id: u.id, name: 'Demo Kandungan', roles: ['admin'], active: true, hasPin: true });
    db.close();
  });

  it('migration 018 re-logs the full record for a user whose latest entry lacks a name, once', () => {
    const db = freshDb();
    const broken = createUser(db, { name: 'Pentadbir Surau', roles: ['admin'] }, 'local');
    const fine = createUser(db, { name: 'Bendahari', roles: ['treasurer'] }, 'local');
    // what boxes before 2026.11.5 logged at a PIN-setting enrolment
    logChange(db, `user:${broken.id}`, 'users', broken.id, { id: broken.id, hasPin: false }, { id: broken.id, hasPin: true, pinChanged: true });
    const countFine = () =>
      Number(db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity_id = ?").get(fine.id)?.n);
    const before = countFine();

    migration.up(db);

    expect(readerCopy(db, broken.id)).toMatchObject({ id: broken.id, name: 'Pentadbir Surau', roles: ['admin'], active: true });
    expect(countFine()).toBe(before); // a healthy user is not touched
    // stamped with the user's own last edit, so it never wins a merge against a newer edit elsewhere
    const rowStamp = db.prepare('SELECT edited_at FROM users WHERE id = ?').get(broken.id)?.edited_at;
    const repairStamp = db
      .prepare("SELECT edited_at, actor FROM change_log WHERE entity_id = ? ORDER BY id DESC LIMIT 1")
      .get(broken.id);
    expect(repairStamp).toMatchObject({ edited_at: rowStamp, actor: 'system:repair' });

    const total = Number(db.prepare('SELECT COUNT(*) AS n FROM change_log').get()?.n);
    migration.up(db); // nothing left to repair
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM change_log').get()?.n)).toBe(total);
    db.close();
  });
});
