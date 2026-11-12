import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { webcrypto } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { actorOf } from '../src/actor.ts';
import { buildApp } from '../src/app.ts';
import { loginAs, loginAsAdmin } from './authHelpers.ts';
import {
  AuthError,
  createUser,
  deactivateUser,
  getAuthUser,
  listUsers,
  setPin,
  setRoles,
} from '../src/auth/users.ts';
import {
  beginEnrolment,
  completeEnrolment,
  completeEnrolmentAsync,
  listDevices,
  revokeDevice,
} from '../src/auth/devices.ts';
import { openDb } from '../src/db.ts';
import { putFeature } from '../src/settingsStore.ts';
import { MIGRATIONS, runMigrations } from '../src/migrations/index.ts';
import type { Migration } from '../src/migrations/index.ts';
import {
  derivePinPepper,
  hashPin,
  isValidPin,
  openSecret,
  randomToken,
  sealSecret,
  sha256hex,
  verifyP256,
  verifyPin,
} from '../src/auth/crypto.ts';
import { boxId, loadBoxKey, secretDir } from '../src/auth/secrets.ts';
import {
  issueChallenge,
  purgeExpired,
  resolveSession,
  revokeSession,
  revokeUserSessions,
  unlock,
} from '../src/auth/sessions.ts';

// Counts PIN-hash calls (pass-through) so a test can prove WHEN and HOW a PIN is hashed.
const hashCalls = vi.hoisted(() => ({ async: 0, sync: 0 }));
vi.mock('../src/auth/crypto.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/auth/crypto.ts')>();
  return {
    ...real,
    hashPin: (...a: Parameters<typeof real.hashPin>) => {
      hashCalls.async++;
      return real.hashPin(...a);
    },
    hashPinSyncWith: (...a: Parameters<typeof real.hashPinSyncWith>) => {
      hashCalls.sync++;
      return real.hashPinSyncWith(...a);
    },
  };
});

type JsonWebKey = webcrypto.JsonWebKey;
const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'surau-auth-'));
  tempDirs.push(d);
  return d;
}

const PEPPER = Buffer.alloc(32, 7);

describe('crypto: PIN hashing', () => {
  it('verifies the right PIN and rejects a wrong one', async () => {
    const stored = await hashPin('246813', PEPPER);
    expect(stored.startsWith('scrypt2$N=32768,r=8,p=1$')).toBe(true);
    expect(stored.split('$')).toHaveLength(4);
    expect(await verifyPin('246813', stored, PEPPER)).toBe(true);
    expect(await verifyPin('246814', stored, PEPPER)).toBe(false);
  });

  it('S4: the hash depends on the pepper, so a stolen database alone cannot test PIN guesses', async () => {
    const stored = await hashPin('246813', PEPPER);
    expect(await verifyPin('246813', stored, Buffer.alloc(32, 8))).toBe(false);
    // the pepper comes from box.key: different keys, different peppers; same key, same pepper
    expect(derivePinPepper(Buffer.alloc(32, 1)).equals(derivePinPepper(Buffer.alloc(32, 1)))).toBe(true);
    expect(derivePinPepper(Buffer.alloc(32, 1)).equals(derivePinPepper(Buffer.alloc(32, 2)))).toBe(false);
    expect(derivePinPepper(Buffer.alloc(32, 1)).equals(Buffer.alloc(32, 1))).toBe(false);
  });

  it('S4: the old unpeppered format is not accepted', async () => {
    // Same cost parameters, prefix "scrypt" (the pre-pepper format): always refused.
    const stored = await hashPin('246813', PEPPER);
    const legacy = stored.replace(/^scrypt2/, 'scrypt');
    expect(await verifyPin('246813', legacy, PEPPER)).toBe(false);
  });

  it('S4: an app database hashes with the pepper derived from its box.key', async () => {
    const dir = tmp();
    const app = buildApp(join(dir, 'p.db'), { dataDir: dir });
    await app.ready();
    const { db } = app.surau;
    const u = createUser(db, { name: 'Pepper', roles: ['admin'] }, 'test');
    await setPin(db, u.id, '280419', 'test');
    const stored = String(db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(u.id)?.pin_hash);
    expect(stored.startsWith('scrypt2$')).toBe(true);
    expect(await verifyPin('280419', stored, derivePinPepper(loadBoxKey(dir)))).toBe(true);
    expect(await verifyPin('280419', stored, Buffer.alloc(32, 9))).toBe(false);
    await app.close();
  });

  it('never throws on malformed stored values', async () => {
    expect(await verifyPin('x', 'garbage', PEPPER)).toBe(false);
    expect(await verifyPin('246813', '', PEPPER)).toBe(false);
    expect(await verifyPin('246813', 'scrypt2$N=32768,r=8,p=1$$', PEPPER)).toBe(false);
    expect(await verifyPin('246813', 'scrypt2$N=32768,r=8,p=1$AAAA$AAAA', PEPPER)).toBe(false);
    expect(await verifyPin('246813', 'bcrypt$N=32768,r=8,p=1$AAAA$AAAA', PEPPER)).toBe(false);
    // hostile cost parameters must not be honoured (memory/CPU DoS)
    expect(await verifyPin('246813', 'scrypt2$N=4294967296,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAA', PEPPER)).toBe(false);
  });

  it('salts: two hashes of the same PIN differ', async () => {
    expect(await hashPin('246813', PEPPER)).not.toBe(await hashPin('246813', PEPPER));
  });

  it('applies the PIN policy', () => {
    for (const bad of ['111111', '123456', '654321', '12345', '1234567', 'abcdef', '', '12 456', '０１２３４５'])
      expect(isValidPin(bad), bad).toBe(false);
    expect(isValidPin('280419')).toBe(true);
    expect(isValidPin(123456 as unknown as string)).toBe(false);
  });
});

describe('crypto: tokens and hashes', () => {
  it('randomToken is base64url of the requested size and unique', () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(randomToken()).not.toBe(t);
  });

  it('sha256hex hashes strings and buffers identically', () => {
    expect(sha256hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256hex(Buffer.from('abc'))).toBe(sha256hex('abc'));
  });
});

describe('crypto: ECDSA P-256', () => {
  const msg = Buffer.from('nonce|device|box');

  it('accepts a good signature and rejects tampering', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const sig = sign('sha256', msg, { key: privateKey, dsaEncoding: 'ieee-p1363' });
    expect(verifyP256(jwk, msg, sig)).toBe(true);
    const bad = Buffer.from(sig);
    bad[10] = bad[10]! ^ 0xff;
    expect(verifyP256(jwk, msg, bad)).toBe(false);
    expect(verifyP256(jwk, Buffer.from('other'), sig)).toBe(false);
    expect(verifyP256(jwk, msg, sig.subarray(0, 63))).toBe(false);
    expect(verifyP256(jwk, msg, Buffer.alloc(0))).toBe(false);
  });

  it('rejects P-384 keys, private material, extra fields and junk', () => {
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' });
    const sig384 = sign('sha256', msg, { key: p384.privateKey, dsaEncoding: 'ieee-p1363' });
    expect(verifyP256(p384.publicKey.export({ format: 'jwk' }), msg, sig384)).toBe(false);

    const p256 = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const sig = sign('sha256', msg, { key: p256.privateKey, dsaEncoding: 'ieee-p1363' });
    const jwk = p256.publicKey.export({ format: 'jwk' });
    expect(verifyP256({ ...jwk, d: 'AAAA' }, msg, sig)).toBe(false);
    expect(verifyP256({ ...jwk, extra: 'x' } as JsonWebKey, msg, sig)).toBe(false);
    expect(verifyP256({ ...jwk, kty: 'RSA' }, msg, sig)).toBe(false);
    expect(verifyP256({} as JsonWebKey, msg, sig)).toBe(false);
    expect(verifyP256(null as unknown as JsonWebKey, msg, sig)).toBe(false);
    expect(verifyP256({ ...jwk, x: 'not-a-point' }, msg, sig)).toBe(false);
  });
});

describe('crypto: sealed secrets', () => {
  const key = randomBytes(32);

  it('round-trips and uses a fresh IV each time', () => {
    const a = sealSecret(key, 'plain-secret-value-for-iv-test');
    const b = sealSecret(key, 'plain-secret-value-for-iv-test');
    expect(openSecret(key, a)).toBe('plain-secret-value-for-iv-test');
    expect(a).not.toBe(b);
    const parts = a.split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    expect(Buffer.from(parts[1]!, 'base64url')).toHaveLength(12);
    expect(Buffer.from(parts[3]!, 'base64url')).toHaveLength(16);
    expect(a).not.toContain('plain-secret-value-for-iv-test');
  });

  it('throws an auth error on tampering, wrong key, bad format', () => {
    const sealed = sealSecret(key, 'top secret value');
    const [v, iv, ct, tag] = sealed.split('.') as [string, string, string, string];
    const ctBuf = Buffer.from(ct, 'base64url');
    ctBuf[0] = ctBuf[0]! ^ 1;
    expect(() => openSecret(key, [v, iv, ctBuf.toString('base64url'), tag].join('.'))).toThrow(/auth/);
    const tagBuf = Buffer.from(tag, 'base64url');
    tagBuf[0] = tagBuf[0]! ^ 1;
    expect(() => openSecret(key, [v, iv, ct, tagBuf.toString('base64url')].join('.'))).toThrow(/auth/);
    expect(() => openSecret(key, [v, iv, ct, tag.slice(0, 4)].join('.'))).toThrow(/auth/);
    expect(() => openSecret(randomBytes(32), sealed)).toThrow(/auth/);
    expect(() => openSecret(key, 'garbage')).toThrow(/auth/);
    expect(() => openSecret(key, ['v2', iv, ct, tag].join('.'))).toThrow(/auth/);
    expect(() => sealSecret(Buffer.alloc(16), 'x')).toThrow(/auth/);
    try {
      openSecret(key, sealed.replace(ct, 'AAAA'));
    } catch (e) {
      expect(String(e)).not.toContain('top secret value');
    }
  });
});

describe('secrets: box key', () => {
  it('creates a 32-byte key once and returns the same bytes afterwards', () => {
    const dir = tmp();
    expect(secretDir(dir)).toBe(join(dir, 'secret'));
    const k1 = loadBoxKey(dir);
    expect(k1).toHaveLength(32);
    expect(existsSync(join(dir, 'secret', 'box.key'))).toBe(true);
    expect(readFileSync(join(dir, 'secret', 'box.key'))).toHaveLength(32);
    const k2 = loadBoxKey(dir);
    expect(k2.equals(k1)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'secret', 'box.key')).mode & 0o777).toBe(0o600);
  });

  it('refuses a key file of the wrong size instead of regenerating it', () => {
    const dir = tmp();
    loadBoxKey(dir);
    const p = join(dir, 'secret', 'box.key');
    rmSync(p);
    // truncated file
    writeFileSync(p, Buffer.alloc(5));
    expect(() => loadBoxKey(dir)).toThrow(/box key/);
    expect(readFileSync(p)).toHaveLength(5);
  });

  it('boxId is 16 hex chars, stable, and not the key', () => {
    const dir = tmp();
    const id = boxId(dir);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(boxId(dir)).toBe(id);
    expect(id).not.toBe(boxId(tmp()));
    expect(loadBoxKey(dir).toString('hex')).not.toContain(id);
  });
});

const PLAN1_DDL = `
  CREATE TABLE IF NOT EXISTS prayer_days (
    surau_id TEXT NOT NULL DEFAULT 'sdm',
    zone TEXT NOT NULL,
    date TEXT NOT NULL,
    json TEXT NOT NULL,
    PRIMARY KEY (zone, date)
  );
  CREATE TABLE IF NOT EXISTS settings (
    surau_id TEXT NOT NULL DEFAULT 'sdm',
    feature TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS change_log (
    surau_id TEXT NOT NULL DEFAULT 'sdm',
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    before_json TEXT,
    after_json TEXT
  );
  CREATE TABLE IF NOT EXISTS meta (
    surau_id TEXT NOT NULL DEFAULT 'sdm',
    key TEXT PRIMARY KEY,
    value TEXT
  );
`;

function plan1Db(): DatabaseSync {
  const db = new DatabaseSync(join(tmp(), 'plan1.db'));
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(PLAN1_DDL);
  return db;
}

function freshDb(): DatabaseSync {
  return openDb(join(tmp(), 'box.db'));
}

function p256Jwk(): JsonWebKey {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }) as JsonWebKey;
}

function rsaJwk(): JsonWebKey {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' }) as JsonWebKey;
}

function thrown(fn: () => unknown): AuthError {
  try {
    fn();
  } catch (e) {
    if (e instanceof AuthError) return e;
    throw e;
  }
  throw new Error('expected an AuthError');
}

async function thrownAsync(fn: () => Promise<unknown>): Promise<AuthError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof AuthError) return e;
    throw e;
  }
  throw new Error('expected an AuthError');
}

function tableNames(db: DatabaseSync): string[] {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String(r.name));
}

describe('migrations: auth schema', () => {
  it('applies the auth migration on a Plan 1 DB and is idempotent', () => {
    const db = plan1Db();
    try {
      const first = runMigrations(db);
      expect(first).toContain('003-auth');
      expect(first).toEqual([...first].sort());
      expect(runMigrations(db)).toEqual([]);
      const tables = tableNames(db);
      for (const name of [
        'users',
        'devices',
        'enrolments',
        'sessions',
        'challenges',
        'auth_log',
        'kiosk_pairings',
        'schema_migrations',
      ])
        expect(tables, name).toContain(name);
      const columns = db.prepare('PRAGMA table_info(change_log)').all().map((r) => String(r.name));
      expect(columns).toContain('device_id');
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '003-auth'").get(),
      ).toMatchObject({ n: 1 });
    } finally {
      db.close();
    }
  });

  it('applies 003-auth on a DB that already has 002-content', () => {
    const db = plan1Db();
    try {
      db.exec(
        'CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT);' +
          "INSERT INTO schema_migrations (name, applied_at) VALUES ('002-content', '2026-11-03T00:00:00.000Z');" +
          'CREATE TABLE content_items (id TEXT PRIMARY KEY, updated_at TEXT);',
      );
      expect(runMigrations(db)).toEqual(['003-auth', '004-kiosk-cookies', '005-poster-titles', '006-asset-derivatives', '007-asset-derivative-failures', '008-sync', '009-worker-outbox', '010-gate-fixes', '011-upload-replace', '012-youtube-pending-complete', '013-box-codes', '014-hadis-sources', '015-prayer-sources', '016-finance', '017-site-approvals', '018-user-feed-repair']);
      expect(runMigrations(db)).toEqual([]);
      expect(tableNames(db)).toContain('content_items');
    } finally {
      db.close();
    }
  });

  it('applies a migration added later with a lower name after 003 is recorded', () => {
    const db = plan1Db();
    try {
      expect(runMigrations(db)).toContain('003-auth');
      const earlier: Migration = {
        name: '001-backfill',
        up: (d) => d.exec('CREATE TABLE backfill (id TEXT)'),
      };
      expect(runMigrations(db, [earlier])).toEqual(['001-backfill']);
      expect(tableNames(db)).toContain('backfill');
    } finally {
      db.close();
    }
  });

  it('openDb runs the migrations after the Plan 1 tables', () => {
    const db = freshDb();
    try {
      const names = db
        .prepare('SELECT name FROM schema_migrations')
        .all()
        .map((r) => String(r.name));
      expect(names).toContain('003-auth');
      expect(names).toEqual([...names].sort());
      expect(MIGRATIONS.some((m) => m.name === '003-auth')).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('actor helper', () => {
  it('names the user or falls back to local', () => {
    expect(actorOf({})).toBe('local');
    expect(actorOf({ auth: { kind: 'user', userId: 'u1', deviceId: 'd1', roles: ['admin'], sessionId: 's1' } })).toBe('user:u1');
  });
});

describe('users', () => {
  it('creates a user and lists it without pin_hash', () => {
    const db = freshDb();
    const created = createUser(db, { name: 'Ustaz Ahmad', roles: ['admin'] }, 'local');
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    const users = listUsers(db);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      id: created.id,
      name: 'Ustaz Ahmad',
      roles: ['admin'],
      active: true,
      pinRequired: true,
    });
    expect(Object.keys(users[0]!)).not.toContain('pin_hash');
    expect(JSON.stringify(users)).not.toContain('pin_hash');
    db.close();
  });

  it('validates roles and names', () => {
    const db = freshDb();
    expect(thrown(() => createUser(db, { name: '', roles: ['admin'] }, 'local')).status).toBe(400);
    expect(thrown(() => createUser(db, { name: 'X', roles: [] }, 'local')).status).toBe(400);
    expect(
      thrown(() => createUser(db, { name: 'X', roles: ['root' as never] }, 'local')).status,
    ).toBe(400);
    expect(listUsers(db)).toHaveLength(0);
    db.close();
  });

  it('sets roles and deactivates', () => {
    const db = freshDb();
    const u = createUser(db, { name: 'Aminah', roles: ['ajk'] }, 'local');
    setRoles(db, u.id, ['treasurer', 'media'], 'local');
    expect(listUsers(db)[0]!.roles).toEqual(['treasurer', 'media']);
    deactivateUser(db, u.id, 'local');
    expect(listUsers(db)[0]!.active).toBe(false);
    expect(thrown(() => setRoles(db, 'nope', ['admin'], 'local')).status).toBe(404);
    db.close();
  });

  it('sets a PIN with the policy and resets a lockout', async () => {
    const db = freshDb();
    const u = createUser(db, { name: 'Aminah', roles: ['admin'] }, 'local');
    const weak = await thrownAsync(() => setPin(db, u.id, '123456', 'local'));
    expect(weak.status).toBe(400);
    expect(weak.message).toMatch(/PIN/);
    await setPin(db, u.id, '280419', 'local');
    expect(listUsers(db)[0]!.pinRequired).toBe(false);
    expect(getAuthUser(db, u.id)!.pinHash).toMatch(/^scrypt2[$]/);
    db.prepare('UPDATE users SET pin_fail_count = 5, pin_locked_until = ?, lock_round = 2 WHERE id = ?').run(
      new Date(Date.now() + 600_000).toISOString(),
      u.id,
    );
    await setPin(db, u.id, '280490', 'local');
    const row = db.prepare('SELECT pin_fail_count, pin_locked_until, lock_round FROM users WHERE id = ?').get(u.id)!;
    expect(row).toMatchObject({ pin_fail_count: 0, pin_locked_until: null, lock_round: 0 });
    db.close();
  });
});

describe('enrolment and devices', () => {
  it('caps live enrolment codes at three per user', () => {
    const db = freshDb();
    const u = createUser(db, { name: 'Ustaz Ahmad', roles: ['admin'] }, 'local');
    for (let i = 0; i < 3; i++) beginEnrolment(db, { userId: u.id, deviceName: `iPad ${i}` }, 'local');
    const fourth = thrown(() => beginEnrolment(db, { userId: u.id, deviceName: 'iPad 4' }, 'local'));
    expect(fourth.status).toBe(429);
    db.close();
  });

  it('completes an enrolment once with a canonical P-256 key', () => {
    const db = freshDb();
    putFeature(db, 'appLock', { enabled: true }, 'test');
    const u = createUser(db, { name: 'Ustaz Ahmad', roles: ['admin'] }, 'local');
    const { code, expiresAt } = beginEnrolment(db, { userId: u.id, deviceName: 'Telefon' }, 'local');
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    const result = completeEnrolment(
      db,
      { code, publicJwk: p256Jwk(), deviceName: 'Telefon Aminah', platform: 'android' },
      '10.168.0.10',
    );
    expect(result).toMatchObject({ userId: u.id, roles: ['admin'], pinRequired: true });
    const devices = listDevices(db);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ id: result.deviceId, name: 'Telefon Aminah', platform: 'android' });
    const stored = JSON.parse(String(db.prepare('SELECT public_jwk FROM devices WHERE id = ?').get(result.deviceId)!.public_jwk)) as JsonWebKey;
    expect(Object.keys(stored).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(stored).toMatchObject({ kty: 'EC', crv: 'P-256' });

    const replay = thrown(() =>
      completeEnrolment(db, { code, publicJwk: p256Jwk(), platform: 'android' }, '10.168.0.10'),
    );
    expect(replay.status).toBe(401);
    expect(replay.message).toMatch(/tamat|tidak sah/);
    db.close();
  });

  it('rejects an RSA key and sets the PIN only when the user has none', async () => {
    const db = freshDb();
    const u = createUser(db, { name: 'Ustaz Ahmad', roles: ['admin'] }, 'local');
    const { code } = beginEnrolment(db, { userId: u.id, deviceName: 'Telefon' }, 'local');
    const rsa = thrown(() =>
      completeEnrolment(db, { code, publicJwk: rsaJwk(), platform: 'android' }, '10.0.0.2'),
    );
    expect(rsa.status).toBe(400);
    expect(listDevices(db)).toHaveLength(0);

    const ok = completeEnrolment(
      db,
      { code, publicJwk: p256Jwk(), platform: 'ios-web', pin: '280419' },
      '10.0.0.2',
    );
    expect(ok.pinRequired).toBe(false);
    expect(getAuthUser(db, u.id)!.pinHash).toMatch(/^scrypt2[$]/);

    const second = beginEnrolment(db, { userId: u.id, deviceName: 'Laptop' }, 'local');
    const withPin = thrown(() =>
      completeEnrolment(
        db,
        { code: second.code, publicJwk: p256Jwk(), platform: 'web', pin: '280490' },
        '10.0.0.3',
      ),
    );
    expect(withPin.status).toBe(400);
    expect(withPin.message).toMatch(/PIN/);
    db.close();
  });

  it('revokes a device and hides it from the default list', () => {
    const db = freshDb();
    const u = createUser(db, { name: 'Ustaz Ahmad', roles: ['admin'] }, 'local');
    const { code } = beginEnrolment(db, { userId: u.id, deviceName: 'Telefon' }, 'local');
    const { deviceId } = completeEnrolment(
      db,
      { code, publicJwk: p256Jwk(), platform: 'android' },
      '10.0.0.2',
    );
    db.prepare(
      `INSERT INTO sessions (id, token_hash, device_id, user_id, created_at, expires_at, last_used_at)
       VALUES ('s1', 'th1', ?, ?, '2026-11-03T00:00:00.000Z', '2026-11-04T00:00:00.000Z', '2026-11-03T00:00:00.000Z')`,
    ).run(deviceId, u.id);

    revokeDevice(db, deviceId, 'local');
    expect(listDevices(db)).toHaveLength(0);
    const all = listDevices(db, undefined, { includeRevoked: true });
    expect(all).toHaveLength(1);
    expect(all[0]!.revokedAt).toMatch(/^\d{4}-/);
    expect(db.prepare('SELECT revoked_at FROM sessions WHERE id = ?').get('s1')!.revoked_at).not.toBeNull();
    db.close();
  });

  it('deactivating a user revokes its devices and sessions', () => {
    const db = freshDb();
    const u = createUser(db, { name: 'Ustaz Ahmad', roles: ['admin'] }, 'local');
    const { code } = beginEnrolment(db, { userId: u.id, deviceName: 'Telefon' }, 'local');
    const { deviceId } = completeEnrolment(
      db,
      { code, publicJwk: p256Jwk(), platform: 'android' },
      '10.0.0.2',
    );
    deactivateUser(db, u.id, 'local');
    const device = db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(deviceId)!;
    expect(device.revoked_at).not.toBeNull();
    expect(listUsers(db)[0]!.active).toBe(false);
    db.close();
  });

  it('never logs PIN hashes, enrolment codes or private key material', async () => {
    const db = freshDb();
    const u = createUser(db, { name: 'Ustaz Ahmad', roles: ['admin'] }, 'local');
    const { code } = beginEnrolment(db, { userId: u.id, deviceName: 'Telefon' }, 'local');
    const { deviceId } = completeEnrolment(
      db,
      { code, publicJwk: p256Jwk(), platform: 'android' },
      '10.0.0.2',
    );
    await setPin(db, u.id, '280419', 'local');
    revokeDevice(db, deviceId, 'local');
    const rows = db.prepare('SELECT entity, before_json, after_json FROM change_log').all();
    const text = JSON.stringify(rows);
    expect(text).not.toContain('pin_hash');
    expect(text).not.toContain('scrypt$');
    expect(text).not.toContain('scrypt2$');
    expect(text).not.toContain(code);
    expect(text).not.toContain('"d":');
    const userRows = rows.filter((r) => r.entity === 'users');
    expect(userRows.length).toBeGreaterThan(0);
    expect(JSON.stringify(userRows)).not.toContain('280419');
    const authRows = db.prepare('SELECT event, detail FROM auth_log').all();
    expect(authRows.map((r) => String(r.event))).toContain('enrol');
    expect(JSON.stringify(authRows)).not.toContain('280419');
    db.close();
  });
});

// ---- Plan 3 Task 4: challenge, unlock, sessions, lockout ----
const BOX = 'box-test-1';
const T0 = new Date('2026-11-10T08:00:00.000Z');
const at = (base: Date, ms: number): Date => new Date(base.getTime() + ms);
const MIN = 60_000;
const HOUR = 3_600_000;

async function sessionFixture() {
  const db = freshDb();
  // These tests cover the PIN path, which only exists while the app lock is on (it is off by default).
  putFeature(db, 'appLock', { enabled: true }, 'test');
  const user = createUser(db, { name: 'Ustaz Ahmad', roles: ['admin'] }, 'local');
  await setPin(db, user.id, '482915', 'local');
  const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = kp.publicKey.export({ format: 'jwk' }) as JsonWebKey;
  const { code } = beginEnrolment(db, { userId: user.id, deviceName: 'Telefon' }, 'local');
  const dev = completeEnrolment(db, { code, publicJwk: jwk, platform: 'android' }, '10.0.0.5');
  const signFor = (nonce: string, deviceId = dev.deviceId, boxId = BOX): string =>
    sign('sha256', Buffer.from(`surau-unlock\n${boxId}\n${deviceId}\n${nonce}`, 'utf8'), {
      key: kp.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
  const attempt = async (pin: string, now: Date, o: { boxId?: string } = {}) => {
    const { nonce } = issueChallenge(db, dev.deviceId, now);
    return unlock(
      db,
      BOX,
      { deviceId: dev.deviceId, nonce, signature: signFor(nonce, dev.deviceId, o.boxId ?? BOX), pin },
      '10.0.0.5',
      now,
    );
  };
  return { db, user, kp, dev, signFor, attempt };
}

async function rejection(p: Promise<unknown>): Promise<AuthError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AuthError) return e;
    throw e;
  }
  throw new Error('expected a rejection');
}

function enrolSecondDevice(db: DatabaseSync, userId: string) {
  const kp2 = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { code } = beginEnrolment(db, { userId, deviceName: 'Tablet' }, 'local');
  const dev2 = completeEnrolment(
    db,
    { code, publicJwk: kp2.publicKey.export({ format: 'jwk' }) as JsonWebKey, platform: 'web' },
    '10.0.0.6',
  );
  const sig = (nonce: string): string =>
    sign('sha256', Buffer.from(`surau-unlock\n${BOX}\n${dev2.deviceId}\n${nonce}`), {
      key: kp2.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
  return { dev2, sig };
}

describe('sessions: challenge and unlock', () => {
  it('unlocks with signature + PIN and the token resolves to the user roles', async () => {
    const { db, user, dev, attempt } = await sessionFixture();
    const r = await attempt('482915', T0);
    expect(r.user).toMatchObject({ id: user.id, roles: ['admin'] });
    expect(new Date(r.expiresAt).getTime()).toBe(T0.getTime() + 12 * HOUR);
    const ctx = resolveSession(db, r.token, at(T0, MIN));
    expect(ctx).toMatchObject({ kind: 'user', userId: user.id, deviceId: dev.deviceId, roles: ['admin'] });
    // Only the hash of the token is stored.
    const stored = db.prepare('SELECT token_hash FROM sessions').all().map((x) => String(x.token_hash));
    expect(stored).toEqual([sha256hex(r.token)]);
    db.close();
  });

  it('rejects a reused nonce, and a nonce issued for another device', async () => {
    const { db, dev, user, signFor } = await sessionFixture();
    const { nonce } = issueChallenge(db, dev.deviceId, T0);
    const input = { deviceId: dev.deviceId, nonce, signature: signFor(nonce), pin: '482915' };
    await unlock(db, BOX, input, '10.0.0.5', T0);
    const again = await rejection(unlock(db, BOX, input, '10.0.0.5', T0));
    expect(again.status).toBe(401);
    expect(again.message).toMatch(/nonce/);

    // A second device (same user) cannot spend the first device's nonce.
    const { dev2, sig } = enrolSecondDevice(db, user.id);
    const { nonce: n1 } = issueChallenge(db, dev.deviceId, T0);
    const cross = await rejection(
      unlock(db, BOX, { deviceId: dev2.deviceId, nonce: n1, signature: sig(n1), pin: '482915' }, '10.0.0.6', T0),
    );
    expect(cross.status).toBe(401);
    expect(cross.message).toMatch(/nonce/);
    // ...and that did not burn the real owner's nonce.
    const ok = await unlock(
      db,
      BOX,
      { deviceId: dev.deviceId, nonce: n1, signature: signFor(n1), pin: '482915' },
      '10.0.0.5',
      T0,
    );
    expect(ok.token.length).toBeGreaterThan(20);
    db.close();
  });

  it('expires a nonce after 60 s and caps live nonces at five per device', async () => {
    const { db, dev, signFor } = await sessionFixture();
    const { nonce, expiresAt } = issueChallenge(db, dev.deviceId, T0);
    expect(new Date(expiresAt).getTime()).toBe(T0.getTime() + 60_000);
    const late = await rejection(
      unlock(db, BOX, { deviceId: dev.deviceId, nonce, signature: signFor(nonce), pin: '482915' }, 'ip', at(T0, 60_001)),
    );
    expect(late.message).toMatch(/nonce/);

    const nonces: string[] = [];
    for (let i = 0; i < 7; i++) nonces.push(issueChallenge(db, dev.deviceId, at(T0, 100_000 + i)).nonce);
    const live = db
      .prepare('SELECT COUNT(*) AS n FROM challenges WHERE device_id = ? AND used_at IS NULL AND expires_at > ?')
      .get(dev.deviceId, at(T0, 100_100).toISOString())!;
    expect(Number(live.n)).toBe(5);
    // The oldest were replaced.
    const first = await rejection(
      unlock(db, BOX, { deviceId: dev.deviceId, nonce: nonces[0]!, signature: signFor(nonces[0]!), pin: '482915' }, 'ip', at(T0, 100_100)),
    );
    expect(first.message).toMatch(/nonce/);
    db.close();
  });

  it('rejects a signature over another box id or a junk signature, leaves the nonce spent, and does not count against the PIN', async () => {
    const { db, dev, signFor, attempt } = await sessionFixture();
    const wrongBox = await rejection(attempt('482915', T0, { boxId: 'other-box' }));
    expect(wrongBox.status).toBe(401);
    const { nonce } = issueChallenge(db, dev.deviceId, T0);
    const badSig = await rejection(
      unlock(db, BOX, { deviceId: dev.deviceId, nonce, signature: 'A'.repeat(86), pin: '482915' }, 'ip', T0),
    );
    expect(badSig.status).toBe(401);
    const spent = await rejection(
      unlock(db, BOX, { deviceId: dev.deviceId, nonce, signature: signFor(nonce), pin: '482915' }, 'ip', T0),
    );
    expect(spent.message).toMatch(/nonce/);
    expect(getAuthUser(db, dev.userId)!.pinFailCount).toBe(0);
    db.close();
  });

  it('refuses an unknown or revoked device the same way', async () => {
    const { db, dev } = await sessionFixture();
    const unknown = thrown(() => issueChallenge(db, 'nope', T0));
    revokeDevice(db, dev.deviceId, 'local');
    const revoked = thrown(() => issueChallenge(db, dev.deviceId, T0));
    expect(unknown.status).toBe(401);
    expect(revoked.status).toBe(401);
    expect(revoked.message).toBe(unknown.message);
    db.close();
  });
});

describe('sessions: lockout', () => {
  it('locks for 15 min on the 5th wrong PIN; the right PIN still fails; ok after the lock', async () => {
    const { db, user, attempt } = await sessionFixture();
    for (let i = 0; i < 4; i++) {
      const e = await rejection(attempt('111222', at(T0, i * 1000)));
      expect(e.status).toBe(401);
    }
    const fifth = await rejection(attempt('111222', at(T0, 5000)));
    expect(fifth.status).toBe(423);
    expect(fifth.message).toMatch(/15 minit/);
    const during = await rejection(attempt('482915', at(T0, MIN)));
    expect(during.status).toBe(423);
    // Persisted in SQLite, not memory.
    expect(getAuthUser(db, user.id)!.pinLockedUntil).not.toBeNull();

    const r = await attempt('482915', at(T0, 16 * MIN));
    expect(r.token.length).toBeGreaterThan(20);
    expect(getAuthUser(db, user.id)!.pinFailCount).toBe(0);
    db.close();
  });

  it('a second round of failures locks for 30 min', async () => {
    const { db, attempt } = await sessionFixture();
    for (let i = 0; i < 5; i++) await rejection(attempt('111222', at(T0, i)));
    const t2 = at(T0, 16 * MIN);
    let last: AuthError | undefined;
    for (let i = 0; i < 5; i++) last = await rejection(attempt('111222', at(t2, i)));
    expect(last!.status).toBe(423);
    expect(last!.message).toMatch(/30 minit/);
    db.close();
  });

  it('lock is per user across devices, and capped at 24 h', async () => {
    const { db, user, attempt } = await sessionFixture();
    for (let i = 0; i < 5; i++) await rejection(attempt('111222', at(T0, i)));
    const { dev2, sig } = enrolSecondDevice(db, user.id);
    const { nonce } = issueChallenge(db, dev2.deviceId, at(T0, 1000));
    const e = await rejection(
      unlock(db, BOX, { deviceId: dev2.deviceId, nonce, signature: sig(nonce), pin: '482915' }, 'ip', at(T0, 1000)),
    );
    expect(e.status).toBe(423);

    db.prepare('UPDATE users SET lock_round = 30, pin_locked_until = NULL, pin_fail_count = 4 WHERE id = ?').run(user.id);
    const capped = await rejection(attempt('111222', at(T0, 2 * HOUR)));
    expect(capped.status).toBe(423);
    expect(capped.message).toMatch(/1440 minit/);
    db.close();
  });

  it('checks the lock before the slow PIN hash (a locked user costs no scrypt)', async () => {
    const { db, user, attempt } = await sessionFixture();
    for (let i = 0; i < 5; i++) await rejection(attempt('111222', at(T0, i)));
    const e = await rejection(attempt('482915', at(T0, MIN)));
    expect(e.status).toBe(423);
    // Only the 5 counted attempts reached PIN verification: the locked one did not add a fail.
    expect(getAuthUser(db, user.id)!.pinFailCount).toBe(0);
    const rows = db.prepare("SELECT detail FROM auth_log WHERE event = 'unlock' ORDER BY id").all().map((r) => String(r.detail));
    expect(rows.filter((d) => d === 'wrong_pin')).toHaveLength(4);
    expect(rows.filter((d) => d === 'locked')).toHaveLength(2);
    db.close();
  });

  it('parallel wrong guesses cannot exceed the limit', async () => {
    const { db, user, dev, signFor } = await sessionFixture();
    const inputs = Array.from({ length: 12 }, () => {
      const { nonce } = issueChallenge(db, dev.deviceId, T0);
      return { deviceId: dev.deviceId, nonce, signature: signFor(nonce), pin: '111222' };
    });
    const results = await Promise.allSettled(inputs.map((i) => unlock(db, BOX, i, 'ip', T0)));
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(getAuthUser(db, user.id)!.pinLockedUntil).not.toBeNull();
    const wrong = db.prepare("SELECT COUNT(*) AS n FROM auth_log WHERE detail = 'wrong_pin'").get()!;
    expect(Number(wrong.n)).toBeLessThanOrEqual(4);
    db.close();
  });

  it('auth_log has no PIN digits for failed unlocks', async () => {
    const { db, attempt } = await sessionFixture();
    await rejection(attempt('739204', T0));
    const rows = db.prepare('SELECT * FROM auth_log WHERE event = ?').all('unlock');
    expect(rows.length).toBeGreaterThan(0);
    const text = JSON.stringify(rows);
    expect(text).not.toContain('739204');
    expect(text).not.toContain('482915');
    db.close();
  });
});

describe('sessions: resolve, expiry, revoke', () => {
  it('idle expiry after 2 h; use within 2 h keeps it alive', async () => {
    const { db, attempt } = await sessionFixture();
    const a = await attempt('482915', T0);
    expect(resolveSession(db, a.token, at(T0, 2 * HOUR + MIN))).toBeNull();
    const b = await attempt('482915', at(T0, 3 * HOUR));
    expect(resolveSession(db, b.token, at(T0, 4 * HOUR))).not.toBeNull();
    expect(resolveSession(db, b.token, at(T0, 5 * HOUR + 30 * MIN))).not.toBeNull();
    db.close();
  });

  it('absolute expiry at 12 h even with hourly use', async () => {
    const { db, attempt } = await sessionFixture();
    const a = await attempt('482915', T0);
    for (let h = 1; h <= 11; h++) expect(resolveSession(db, a.token, at(T0, h * HOUR))).not.toBeNull();
    expect(resolveSession(db, a.token, at(T0, 12 * HOUR + 1))).toBeNull();
    db.close();
  });

  it('a clock that steps back neither extends a session nor moves last_used_at back', async () => {
    const { db, attempt } = await sessionFixture();
    const a = await attempt('482915', T0);
    expect(resolveSession(db, a.token, at(T0, 30 * MIN))).not.toBeNull();
    expect(resolveSession(db, a.token, at(T0, -HOUR))).toBeNull();
    const before = String(db.prepare('SELECT last_used_at FROM sessions').get()!.last_used_at);
    expect(resolveSession(db, a.token, at(T0, 10 * MIN))).not.toBeNull();
    expect(String(db.prepare('SELECT last_used_at FROM sessions').get()!.last_used_at)).toBe(before);
    db.close();
  });

  it('revoking a session, all of a user, or the device kills tokens at once', async () => {
    const { db, user, dev, attempt } = await sessionFixture();
    const a = await attempt('482915', T0);
    const ctx = resolveSession(db, a.token, T0)!;
    revokeSession(db, ctx.sessionId);
    expect(resolveSession(db, a.token, T0)).toBeNull();

    const b = await attempt('482915', T0);
    revokeUserSessions(db, user.id);
    expect(resolveSession(db, b.token, T0)).toBeNull();

    const c = await attempt('482915', T0);
    expect(resolveSession(db, c.token, T0)).not.toBeNull();
    revokeDevice(db, dev.deviceId, 'local');
    expect(resolveSession(db, c.token, T0)).toBeNull();
    db.close();
  });

  it('a deactivated user or a garbage token resolves to null', async () => {
    const { db, user, attempt } = await sessionFixture();
    const a = await attempt('482915', T0);
    expect(resolveSession(db, '', T0)).toBeNull();
    expect(resolveSession(db, 'x'.repeat(500), T0)).toBeNull();
    expect(resolveSession(db, a.token + 'x', T0)).toBeNull();
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(user.id);
    expect(resolveSession(db, a.token, T0)).toBeNull();
    db.close();
  });

  it('purgeExpired removes dead challenges and sessions but keeps live ones', async () => {
    const { db, dev, attempt } = await sessionFixture();
    const old = await attempt('482915', T0);
    const live = await attempt('482915', at(T0, 10 * HOUR));
    issueChallenge(db, dev.deviceId, T0);
    const purgeAt = at(T0, 11 * HOUR);
    purgeExpired(db, purgeAt);
    expect(resolveSession(db, old.token, purgeAt)).toBeNull();
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n)).toBe(1);
    expect(resolveSession(db, live.token, purgeAt)).not.toBeNull();
    expect(
      Number(db.prepare('SELECT COUNT(*) AS n FROM challenges WHERE expires_at <= ?').get(purgeAt.toISOString())!.n),
    ).toBe(0);
    db.close();
  });
});

// ---- 2026-11-03: set a new PIN at next unlock after an admin reset ----
describe('sessions: new PIN at next unlock after a reset', () => {
  const NEW = '739204';
  async function reset() {
    const f = await sessionFixture();
    const first = await f.attempt('482915', T0);
    // The same statements as PUT /api/users/:id/pin and cli reset-pin.
    f.db
      .prepare('UPDATE users SET pin_hash = NULL, pin_fail_count = 0, pin_locked_until = NULL, lock_round = 0 WHERE id = ?')
      .run(f.user.id);
    f.db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ?').run(T0.toISOString(), f.user.id);
    const withNew = async (newPin: string, now: Date, o: { sig?: string } = {}) => {
      const { nonce } = issueChallenge(f.db, f.dev.deviceId, now);
      return unlock(
        f.db,
        BOX,
        { deviceId: f.dev.deviceId, nonce, signature: o.sig ?? f.signFor(nonce), newPin },
        '10.0.0.5',
        now,
      );
    };
    return { ...f, first, withNew };
  }
  const pinHashOf = (db: DatabaseSync, id: string): unknown =>
    db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(id)!.pin_hash;

  it('the old PIN fails; a valid signature gets pin_required (409), a bad one the generic 401', async () => {
    const { db, user, attempt, withNew } = await reset();
    const need = await rejection(attempt('482915', at(T0, MIN)));
    expect(need.status).toBe(409);
    expect(need.code).toBe('pin_required');
    // Not counted: nothing was guessed.
    expect(getAuthUser(db, user.id)!.pinFailCount).toBe(0);
    // No device key proof: indistinguishable from any other bad signature.
    const bad = await rejection(withNew(NEW, at(T0, MIN), { sig: 'A'.repeat(86) }));
    expect(bad.status).toBe(401);
    expect(bad.code).toBe('bad_signature');
    db.close();
  });

  it('sets the new PIN with a valid device signature; old sessions stay revoked', async () => {
    const { db, user, first, withNew, attempt } = await reset();
    const r = await withNew(NEW, at(T0, MIN));
    expect(r.user).toMatchObject({ id: user.id });
    expect(resolveSession(db, r.token, at(T0, 2 * MIN))).not.toBeNull();
    expect(resolveSession(db, first.token, at(T0, 2 * MIN))).toBeNull();
    expect(pinHashOf(db, user.id)).toMatch(/^scrypt2[$]/);
    expect(listUsers(db)[0]!.pinRequired).toBe(false);
    // The new PIN works the ordinary way; the old one does not.
    await attempt(NEW, at(T0, 3 * MIN));
    expect((await rejection(attempt('482915', at(T0, 4 * MIN)))).status).toBe(401);
    // change_log: who and that it changed, never the PIN or its hash.
    const rows = db.prepare("SELECT actor, after_json FROM change_log WHERE entity = 'users' ORDER BY id DESC").all();
    const row = rows.find((x) => String(x.after_json).includes('pinChanged'))!;
    expect(row.actor).toBe(`user:${user.id}`);
    const text =
      JSON.stringify(db.prepare('SELECT * FROM change_log').all()) + JSON.stringify(db.prepare('SELECT * FROM auth_log').all());
    expect(text).not.toContain(NEW);
    expect(text).not.toMatch(/scrypt2?[$]/);
    db.close();
  });

  it('newPin without a valid signature stores nothing', async () => {
    const { db, user, withNew } = await reset();
    expect((await rejection(withNew(NEW, at(T0, MIN), { sig: 'A'.repeat(86) }))).status).toBe(401);
    expect(pinHashOf(db, user.id)).toBeNull();
    db.close();
  });

  it('newPin when a PIN exists is 400 and changes nothing', async () => {
    const f = await sessionFixture();
    const before = pinHashOf(f.db, f.user.id);
    const { nonce } = issueChallenge(f.db, f.dev.deviceId, T0);
    const e = await rejection(
      unlock(f.db, BOX, { deviceId: f.dev.deviceId, nonce, signature: f.signFor(nonce), newPin: NEW }, 'ip', T0),
    );
    expect(e.status).toBe(400);
    expect(pinHashOf(f.db, f.user.id)).toBe(before);
    expect(getAuthUser(f.db, f.user.id)!.pinFailCount).toBe(0);
    await f.attempt('482915', at(T0, MIN)); // the old PIN still works
    f.db.close();
  });

  it('a weak new PIN is 400 and does not touch the lockout counters', async () => {
    const { db, user, withNew } = await reset();
    for (const weak of ['123456', '111111', '12ab56', '12345', '']) {
      const e = await rejection(withNew(weak, at(T0, MIN)));
      expect(e.status, weak).toBe(400);
    }
    expect(getAuthUser(db, user.id)).toMatchObject({ pinFailCount: 0, pinLockedUntil: null, lockRound: 0, pinHash: null });
    db.close();
  });

  it('a revoked device cannot set a new PIN', async () => {
    const { db, user, dev, withNew } = await reset();
    revokeDevice(db, dev.deviceId, 'local');
    expect((await rejection(withNew(NEW, at(T0, MIN)))).status).toBe(401);
    expect(pinHashOf(db, user.id)).toBeNull();
    db.close();
  });

  it('a locked user cannot set a new PIN, and two parallel requests set it once', async () => {
    const f = await reset();
    f.db.prepare('UPDATE users SET pin_locked_until = ? WHERE id = ?').run(at(T0, HOUR).toISOString(), f.user.id);
    expect((await rejection(f.withNew(NEW, at(T0, MIN)))).status).toBe(423);
    expect(pinHashOf(f.db, f.user.id)).toBeNull();
    f.db.prepare('UPDATE users SET pin_locked_until = NULL WHERE id = ?').run(f.user.id);
    const results = await Promise.allSettled([f.withNew(NEW, at(T0, 2 * MIN)), f.withNew('846201', at(T0, 2 * MIN))]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as AuthError).status).toBe(400);
    f.db.close();
  });
});

// ---- Gate fix round W13, lane A2 ----

describe('W13 S3/Q8: enrolment checks the code before any PIN hashing, and logs refusals', () => {
  it('a wrong code with a PIN refuses without hashing (async and sync paths)', async () => {
    const db = freshDb();
    hashCalls.async = 0;
    hashCalls.sync = 0;
    const bad = { code: 'AAAA-BBBB-CCCC', publicJwk: p256Jwk(), platform: 'android', pin: '280419' };
    expect((await rejection(completeEnrolmentAsync(db, bad, '10.0.0.9'))).status).toBe(401);
    expect(thrown(() => completeEnrolment(db, bad, '10.0.0.9')).status).toBe(401);
    expect(hashCalls.async + hashCalls.sync).toBe(0);
    db.close();
  });

  it('the request-path enrolment hashes asynchronously (never the sync hash) and sets the PIN', async () => {
    const db = freshDb();
    const u = createUser(db, { name: 'Ustaz', roles: ['admin'] }, 'local');
    const { code } = beginEnrolment(db, { userId: u.id, deviceName: 'T' }, 'local');
    hashCalls.async = 0;
    hashCalls.sync = 0;
    const out = await completeEnrolmentAsync(db, { code, publicJwk: p256Jwk(), platform: 'android', pin: '280419' }, '10.0.0.9');
    expect(out.pinRequired).toBe(false);
    expect(hashCalls).toEqual({ async: 1, sync: 0 });
    expect(getAuthUser(db, u.id)!.pinHash).toMatch(/^scrypt2[$]/);
    db.close();
  });

  it('a PIN for a user who already has one is refused before hashing', async () => {
    const db = freshDb();
    const u = createUser(db, { name: 'Ustaz', roles: ['admin'] }, 'local');
    await setPin(db, u.id, '280419', 'local');
    const { code } = beginEnrolment(db, { userId: u.id, deviceName: 'T' }, 'local');
    hashCalls.async = 0;
    const e = await rejection(completeEnrolmentAsync(db, { code, publicJwk: p256Jwk(), platform: 'android', pin: '482915' }, '10.0.0.9'));
    expect(e.code).toBe('pin_exists');
    expect(hashCalls.async).toBe(0);
    db.close();
  });

  it('Q8: failed enrolments leave auth_log rows (not rolled back with the refusal)', () => {
    const db = freshDb();
    thrown(() => completeEnrolment(db, { code: 'AAAA-BBBB-CCCC', publicJwk: p256Jwk(), platform: 'android' }, '10.0.0.9'));
    const u = createUser(db, { name: 'Ustaz', roles: ['admin'] }, 'local');
    const { code } = beginEnrolment(db, { userId: u.id, deviceName: 'T' }, 'local');
    completeEnrolment(db, { code, publicJwk: p256Jwk(), platform: 'android' }, '10.0.0.9');
    thrown(() => completeEnrolment(db, { code, publicJwk: p256Jwk(), platform: 'android' }, '10.0.0.10')); // replay
    const { code: c2 } = beginEnrolment(db, { userId: u.id, deviceName: 'T2' }, 'local');
    deactivateUser(db, u.id, 'local');
    thrown(() => completeEnrolment(db, { code: c2, publicJwk: p256Jwk(), platform: 'android' }, '10.0.0.11'));
    const rows = db.prepare("SELECT ip, ok FROM auth_log WHERE event = 'enrol' AND ok = 0 ORDER BY id").all();
    expect(rows.map((r) => String(r.ip))).toEqual(['10.0.0.9', '10.0.0.10', '10.0.0.11']);
    db.close();
  });

  it('a refusal found inside the transaction (code claimed in between) is logged too', async () => {
    const db = freshDb();
    const u = createUser(db, { name: 'Ustaz', roles: ['admin'] }, 'local');
    const { code } = beginEnrolment(db, { userId: u.id, deviceName: 'T' }, 'local');
    const input = { code, publicJwk: p256Jwk(), platform: 'android', pin: '280419' };
    // Two parallel redemptions of one code: exactly one wins, the loser leaves a failed-enrol row.
    const results = await Promise.allSettled([completeEnrolmentAsync(db, input, '10.0.0.20'), completeEnrolmentAsync(db, input, '10.0.0.21')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = db.prepare("SELECT ip FROM auth_log WHERE event = 'enrol' AND ok = 0").all();
    expect(failed).toHaveLength(1);
    db.close();
  });
});

describe('W13 Q9: a stuck PIN count gets a real lock', () => {
  it('count at the limit with no lock imposes the lock instead of "locked 1 minute" forever', async () => {
    const { db, user, attempt } = await sessionFixture();
    db.prepare('UPDATE users SET pin_fail_count = 5, pin_locked_until = NULL WHERE id = ?').run(user.id);
    const e = await rejection(attempt('482915', T0));
    expect(e.status).toBe(423);
    const row = db.prepare('SELECT pin_fail_count, pin_locked_until, lock_round FROM users WHERE id = ?').get(user.id)!;
    expect(String(row.pin_locked_until) > T0.toISOString()).toBe(true);
    expect(row.lock_round).toBe(1);
    expect(row.pin_fail_count).toBe(0);
    // Still locked a minute later, and the account recovers once the lock has passed.
    expect((await rejection(attempt('482915', at(T0, 2 * MIN)))).status).toBe(423);
    const ok = await attempt('482915', at(T0, 40 * MIN));
    expect(ok.token.length).toBeGreaterThan(20);
    db.close();
  });
});

describe('W13 S12: purgeExpired trims old rows', () => {
  it('drops auth_log older than 180 days, dead kiosk cookies and orphan kiosk devices', () => {
    const db = freshDb();
    const u = createUser(db, { name: 'Ustaz', roles: ['admin'] }, 'local');
    const mk = (id: string, revoked: string | null) =>
      db.prepare("INSERT INTO devices (id, user_id, name, platform, enrolled_at, revoked_at) VALUES (?, ?, 'TV', 'kiosk', ?, ?)").run(id, u.id, T0.toISOString(), revoked);
    mk('live', null);
    mk('dead', T0.toISOString());
    mk('orphan', null);
    const ck = (hash: string, dev: string, exp: Date) =>
      db.prepare('INSERT INTO kiosk_cookies (token_hash, device_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(hash, dev, T0.toISOString(), exp.toISOString());
    ck('c-live', 'live', at(T0, 400 * 24 * HOUR));
    ck('c-dead', 'dead', at(T0, 400 * 24 * HOUR));
    ck('c-expired', 'live', at(T0, -MIN));
    db.prepare(
      "INSERT INTO kiosk_pairings (code_hash, poll_token_hash, ip, created_at, expires_at, approved_by, device_id) VALUES ('p1', 'pt1', '1.2.3.4', ?, ?, ?, 'orphan')",
    ).run(at(T0, -20 * MIN).toISOString(), at(T0, -10 * MIN).toISOString(), u.id);
    const log = (days: number) =>
      db.prepare("INSERT INTO auth_log (at, event, ok) VALUES (?, 'unlock', 1)").run(new Date(T0.getTime() - days * 24 * HOUR).toISOString());
    log(181);
    log(179);
    purgeExpired(db, T0);
    expect(db.prepare('SELECT token_hash FROM kiosk_cookies').all().map((r) => String(r.token_hash))).toEqual(['c-live']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM auth_log').get()!.n).toBe(1);
    // the approved-but-never-claimed pairing's device is revoked (Q14)
    expect(db.prepare("SELECT revoked_at FROM devices WHERE id = 'orphan'").get()!.revoked_at).not.toBeNull();
    expect(db.prepare("SELECT revoked_at FROM devices WHERE id = 'live'").get()!.revoked_at).toBeNull();
    db.close();
  });
});

describe("W13 M2: admin PIN reset lists the user's devices and can revoke chosen ones", () => {
  async function setup() {
    const dir = tmp();
    const app = buildApp(join(dir, 'm2.db'), { dataDir: dir });
    await app.ready();
    const admin = await loginAsAdmin(app);
    const target = await loginAs(app, 'media');
    return { app, admin, target };
  }

  it('returns the active devices by default and revokes none', async () => {
    const { app, admin, target } = await setup();
    const r = await app.inject({ method: 'PUT', url: `/api/users/${target.userId}/pin`, headers: admin.headers, payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, pinRequired: true, revoked: [] });
    expect((r.json().devices as { id: string }[]).map((d) => d.id)).toEqual([target.deviceId]);
    // no body at all still works
    const r2 = await app.inject({ method: 'PUT', url: `/api/users/${target.userId}/pin`, headers: admin.headers });
    expect(r2.statusCode).toBe(200);
    await app.close();
  });

  it('revokeDeviceIds revokes those devices in the same step and drops them from the list', async () => {
    const { app, admin, target } = await setup();
    const r = await app.inject({
      method: 'PUT',
      url: `/api/users/${target.userId}/pin`,
      headers: admin.headers,
      payload: { revokeDeviceIds: [target.deviceId] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, revoked: [target.deviceId], devices: [] });
    const ch = await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { deviceId: target.deviceId } });
    expect(ch.statusCode).toBe(401);
    await app.close();
  });

  it("refuses another user's device id and changes nothing", async () => {
    const { app, admin, target } = await setup();
    const r = await app.inject({
      method: 'PUT',
      url: `/api/users/${target.userId}/pin`,
      headers: admin.headers,
      payload: { revokeDeviceIds: [admin.deviceId] },
    });
    expect(r.statusCode).toBe(400);
    expect(getAuthUser(app.surau.db, target.userId)!.pinHash).not.toBeNull();
    expect(listDevices(app.surau.db, admin.userId)).toHaveLength(1);
    const bad = await app.inject({ method: 'PUT', url: `/api/users/${target.userId}/pin`, headers: admin.headers, payload: { revokeDeviceIds: 'x' } });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});
