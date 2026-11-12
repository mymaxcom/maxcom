import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { beginEnrolment, completeEnrolment, revokeDevice } from '../src/auth/devices.ts';
import { createUser } from '../src/auth/users.ts';
import { openDb } from '../src/db.ts';
import { activeAdminDeviceCount, boxName, boxState, readBoxJson, setBoxName, writeBoxJson } from '../src/setup/state.ts';

let dir = '';
let db: DatabaseSync;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'surau-state-'));
  db = openDb(join(dir, 'test.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const jwk = (_n: number) => {
  const j = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
  return { kty: j.kty, crv: j.crv, x: j.x, y: j.y };
};

function enrol(userId: string, platform: 'android' | 'kiosk', n: number): string {
  const { code } = beginEnrolment(db, { userId, deviceName: `P${n}` }, 'test');
  return completeEnrolment(db, { code, publicJwk: jwk(n) as never, platform, pin: '482916' } as never, '10.0.0.1').deviceId;
}

describe('box state', () => {
  it('an empty database is setup', () => {
    expect(boxState(db)).toEqual({ state: 'setup', reason: 'none' });
  });

  it('an admin with no device is recovery / no_admin', () => {
    createUser(db, { name: 'Ali', roles: ['admin'] }, 'test');
    expect(boxState(db)).toEqual({ state: 'recovery', reason: 'no_admin' });
  });

  it('an enrolled android admin device is active; revoking it is recovery again', () => {
    const u = createUser(db, { name: 'Ali', roles: ['admin'] }, 'test');
    const d = enrol(u.id, 'android', 1);
    expect(boxState(db).state).toBe('active');
    expect(activeAdminDeviceCount(db)).toBe(1);
    revokeDevice(db, d, 'test');
    expect(boxState(db)).toEqual({ state: 'recovery', reason: 'no_admin' });
  });

  it('a kiosk device alone does not count', () => {
    const u = createUser(db, { name: 'Ali', roles: ['admin'] }, 'test');
    enrol(u.id, 'kiosk', 2);
    expect(activeAdminDeviceCount(db)).toBe(0);
    expect(boxState(db).state).toBe('recovery');
  });

  it('an AJK device does not make the box active; a deactivated admin does not count', () => {
    const ajk = createUser(db, { name: 'Bakar', roles: ['ajk'] }, 'test');
    enrol(ajk.id, 'android', 3);
    expect(boxState(db).state).toBe('recovery');
    const admin = createUser(db, { name: 'Ali', roles: ['admin'] }, 'test');
    enrol(admin.id, 'android', 5);
    expect(boxState(db).state).toBe('active');
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(admin.id);
    expect(boxState(db).state).toBe('recovery');
  });

  it('a superadmin device counts as an active Pentadbir', () => {
    const u = createUser(db, { name: 'Ali', roles: ['admin'] }, 'test');
    enrol(u.id, 'android', 7);
    db.prepare('UPDATE users SET roles_json = ? WHERE id = ?').run(JSON.stringify(['superadmin']), u.id);
    expect(boxState(db).state).toBe('active');
  });

  it('sync_state.suspended = 1 wins as locked, on an empty box too', () => {
    db.prepare("INSERT INTO sync_state (key, value) VALUES ('suspended', '1')").run();
    expect(boxState(db).state).toBe('locked');
    const u = createUser(db, { name: 'Ali', roles: ['admin'] }, 'test');
    enrol(u.id, 'android', 9);
    expect(boxState(db).state).toBe('locked');
    db.prepare("DELETE FROM sync_state WHERE key = 'suspended'").run();
    expect(boxState(db).state).toBe('active');
  });
});

describe('box name', () => {
  it('defaults to MAXCOM XXXX and renames with a change_log row', () => {
    expect(boxName(db, '4f2a9c1e77b0d3a1')).toBe('MAXCOM 4F2A');
    expect(setBoxName(db, '4f2a9c1e77b0d3a1', '  MAXCOM Dewan Utama ', 'user:x')).toBe('MAXCOM Dewan Utama');
    expect(boxName(db, '4f2a9c1e77b0d3a1')).toBe('MAXCOM Dewan Utama');
    const row = db.prepare("SELECT before_json, after_json FROM change_log WHERE entity = 'box'").get();
    expect(JSON.parse(String(row?.before_json))).toEqual({ name: 'MAXCOM 4F2A' });
    expect(JSON.parse(String(row?.after_json))).toEqual({ name: 'MAXCOM Dewan Utama' });
  });

  it('refuses empty, 61 characters and control characters', () => {
    for (const bad of ['', '   ', 'x'.repeat(61), 'a\nb', 5, null]) {
      expect(() => setBoxName(db, '4f2a9c1e77b0d3a1', bad, 'u'), String(bad)).toThrow();
    }
    expect(boxName(db, '4f2a9c1e77b0d3a1')).toBe('MAXCOM 4F2A');
  });
});

describe('box.json', () => {
  it('round trips and is null when missing or broken', () => {
    expect(readBoxJson(dir)).toBeNull();
    writeBoxJson(dir, { boxName: 'MAXCOM X', surauName: 'Surau Al-Hidayah' });
    expect(readBoxJson(dir)).toEqual({ boxName: 'MAXCOM X', surauName: 'Surau Al-Hidayah' });
  });
});
