/**
 * Plan 14 Task 23: the ops commands of `src/cli/users.ts` (`ops-enrol`, `ops-devices`, `ops-unmark`).
 * (The brief names this file as existing; it did not, the older CLI cases live in `test/cli.test.ts` and stay there.)
 *
 * Assumptions for the implementer (see also the block in test/opsDevice.test.ts):
 *  1. The server role for the CLI is `process.env.SURAU_ROLE` (`cloud` or anything else = box), the switch `main.ts`
 *     already reads. The tests call `run(argv, { out, err })` in-process and set that variable around each call.
 *  2. `ops-enrol --name "<exact name>" [--device-name "<name>"]` prints the code as `XXXX-XXXX-XXXX` (base32, hyphens) on
 *     stdout; `ops-devices` prints every device id (ops ones and public ones of ops-role users) and no other device;
 *     `ops-unmark --device <id>` prints nothing secret and exits 0.
 *  3. On a box role all three print `Hanya di awan MAXCOM` on stderr and exit 1 and change nothing.
 *  4. Any refusal (unknown or ambiguous name, `not_ops_user`, `ops_device_limit`, a device that is not an ops device)
 *     exits 1 with a message on stderr and writes no `enrolments` row.
 */
import { webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { completeEnrolment } from '../src/auth/devices.ts';
import { issueOpsEnrolment } from '../src/auth/opsDevice.ts';
import { createUser } from '../src/auth/users.ts';
import { run } from '../src/cli/users.ts';
import { openDb } from '../src/db.ts';

const dirs: string[] = [];
const savedRole = process.env.SURAU_ROLE;
beforeEach(() => {
  delete process.env.SURAU_ROLE;
});
afterEach(() => {
  if (savedRole === undefined) delete process.env.SURAU_ROLE;
  else process.env.SURAU_ROLE = savedRole;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CODE_RE = /[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}/;

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'surau-cliu-'));
  dirs.push(dir);
  return join(dir, 'surau.db');
}

async function cli(role: 'cloud' | 'box', dbPath: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  process.env.SURAU_ROLE = role;
  try {
    const code = await run(['--db', dbPath, ...args], { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    delete process.env.SURAU_ROLE;
  }
}

async function publicJwk(): Promise<Record<string, string>> {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const j = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
  return { kty: j.kty!, crv: j.crv!, x: j.x!, y: j.y! };
}

function userWith(db: DatabaseSync, name: string, roles: string[]): string {
  const plain = roles.filter((r) => r !== 'superadmin' && r !== 'support');
  const u = createUser(db, { name, roles: (plain.length > 0 ? plain : ['ajk']) as never }, 'test', 'sdm');
  db.prepare('UPDATE users SET roles_json = ? WHERE id = ?').run(JSON.stringify(roles), u.id);
  return u.id;
}

/** An ops device made the real library way (CLI-issued code, client 'ops'). */
async function enrolOps(db: DatabaseSync, userId: string): Promise<string> {
  const { code } = issueOpsEnrolment(db, { userId, deviceName: 'Ops' }, 'cli');
  return completeEnrolment(db, { code, publicJwk: await publicJwk() as never, platform: 'android', client: 'ops' } as never, '127.0.0.1').deviceId;
}

/** A public device of an ops-role user: enrolled while the user was still ordinary, roles restored after. */
async function enrolPublic(db: DatabaseSync, userId: string, roles: string[]): Promise<string> {
  db.prepare('UPDATE users SET roles_json = ? WHERE id = ?').run(JSON.stringify(['ajk']), userId);
  const { beginEnrolment } = await import('../src/auth/devices.ts');
  const { code } = beginEnrolment(db, { userId, deviceName: 'Awam' }, 'test', { canManageSuperadmin: true });
  const id = completeEnrolment(db, { code, publicJwk: await publicJwk() as never, platform: 'android' }, '127.0.0.1').deviceId;
  db.prepare('UPDATE users SET roles_json = ? WHERE id = ?').run(JSON.stringify(roles), userId);
  return id;
}

const n = (db: DatabaseSync, sql: string, ...p: string[]): number => Number((db.prepare(sql).get(...p) as { n: number }).n);

describe('ops-enrol (cloud role)', () => {
  it('issues a single-use ops code for an ops-role user: prints it once, stores the hash and the device name, ops = 1', async () => {
    const path = tempDb();
    const db = openDb(path);
    const uid = userWith(db, 'Pentadbir Satu', ['superadmin', 'admin']);
    db.close();
    const r = await cli('cloud', path, ['ops-enrol', '--name', 'Pentadbir Satu', '--device-name', 'Telefon Ops']);
    expect(r.code, r.err).toBe(0);
    const code = CODE_RE.exec(r.out)?.[0];
    expect(code).toBeDefined();
    expect(r.err).toBe('');
    const check = openDb(path);
    try {
      const e = check.prepare('SELECT user_id, device_name, ops, used_at, created_by, code_hash FROM enrolments').get() as Record<string, unknown>;
      expect(e).toMatchObject({ user_id: uid, device_name: 'Telefon Ops', ops: 1, used_at: null, created_by: 'cli' });
      expect(JSON.stringify(check.prepare('SELECT * FROM enrolments').all())).not.toContain(code!.replace(/-/g, ''));
      // the code does not leak into the audit or change rows either
      const dump = JSON.stringify([check.prepare('SELECT * FROM auth_log').all(), check.prepare('SELECT * FROM change_log').all()]);
      expect(dump).not.toContain(code!.replace(/-/g, ''));
      expect(dump).not.toContain(code!);
      // and it redeems as an ops device
      const dev = completeEnrolment(check, { code: code!, publicJwk: await publicJwk() as never, platform: 'android', client: 'ops' } as never, '127.0.0.1');
      expect(check.prepare('SELECT ops, surau_id, box_id FROM devices WHERE id = ?').get(dev.deviceId)).toMatchObject({ ops: 1, surau_id: '*', box_id: null });
    } finally {
      check.close();
    }
  });

  it('works for a support user too; a default device name is used without --device-name', async () => {
    const path = tempDb();
    const db = openDb(path);
    userWith(db, 'Sokongan', ['support']);
    db.close();
    const r = await cli('cloud', path, ['ops-enrol', '--name', 'Sokongan']);
    expect(r.code, r.err).toBe(0);
    const check = openDb(path);
    try {
      expect(n(check, 'SELECT COUNT(*) AS n FROM enrolments WHERE ops = 1')).toBe(1);
      expect(String((check.prepare('SELECT device_name FROM enrolments').get() as { device_name: string }).device_name).length).toBeGreaterThan(0);
    } finally {
      check.close();
    }
  });

  it('refuses a user without an ops role (not_ops_user), an unknown name and a missing --name: exit 1, nothing issued', async () => {
    const path = tempDb();
    const db = openDb(path);
    userWith(db, 'Orang Biasa', ['admin']);
    db.close();
    for (const args of [['ops-enrol', '--name', 'Orang Biasa'], ['ops-enrol', '--name', 'Tiada Nama'], ['ops-enrol']]) {
      const r = await cli('cloud', path, args);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.err.length).toBeGreaterThan(0);
      expect(r.out).not.toMatch(CODE_RE);
    }
    const check = openDb(path);
    try {
      expect(n(check, 'SELECT COUNT(*) AS n FROM enrolments')).toBe(0);
    } finally {
      check.close();
    }
  });

  it('the 4th live ops device is refused (exit 1, no new code); the first three codes were issued', async () => {
    const path = tempDb();
    const db = openDb(path);
    userWith(db, 'Pentadbir Satu', ['superadmin', 'admin']);
    const uid = (db.prepare("SELECT id FROM users WHERE name = 'Pentadbir Satu'").get() as { id: string }).id;
    for (let i = 0; i < 3; i++) await enrolOps(db, uid);
    db.close();
    const r = await cli('cloud', path, ['ops-enrol', '--name', 'Pentadbir Satu']);
    expect(r.code).toBe(1);
    expect(r.out).not.toMatch(CODE_RE);
    const check = openDb(path);
    try {
      expect(n(check, 'SELECT COUNT(*) AS n FROM enrolments WHERE used_at IS NULL')).toBe(0);
      expect(n(check, 'SELECT COUNT(*) AS n FROM devices WHERE ops = 1')).toBe(3);
    } finally {
      check.close();
    }
  });
});

describe('ops-enrol, ops-devices and ops-unmark on a box role', () => {
  it('print "Hanya di awan MAXCOM", exit 1 and change nothing', async () => {
    const path = tempDb();
    const db = openDb(path);
    const uid = userWith(db, 'Pentadbir Satu', ['superadmin', 'admin']);
    const dev = await enrolOps(db, uid);
    db.close();
    for (const args of [['ops-enrol', '--name', 'Pentadbir Satu'], ['ops-devices'], ['ops-unmark', '--device', dev]]) {
      const r = await cli('box', path, args);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.err).toContain('Hanya di awan MAXCOM');
      expect(r.out).not.toMatch(CODE_RE);
    }
    const check = openDb(path);
    try {
      expect(n(check, 'SELECT COUNT(*) AS n FROM enrolments WHERE used_at IS NULL')).toBe(0);
      expect(n(check, 'SELECT COUNT(*) AS n FROM devices WHERE ops = 1')).toBe(1);
    } finally {
      check.close();
    }
  });

  it('the existing commands behave as before on a box (list, enrol <userId>)', async () => {
    const path = tempDb();
    const db = openDb(path);
    const uid = userWith(db, 'Pentadbir Surau', ['admin']);
    db.close();
    const list = await cli('box', path, ['list']);
    expect(list.code, list.err).toBe(0);
    expect(list.out).toContain('Pentadbir Surau');
    const enrol = await cli('box', path, ['enrol', uid]);
    expect(enrol.code, enrol.err).toBe(0);
    expect(enrol.out).toMatch(CODE_RE);
  });
});

describe('ops-devices (cloud role)', () => {
  it('lists every ops device and, separately, the public devices of ops-role users; no other device', async () => {
    const path = tempDb();
    const db = openDb(path);
    const uid = userWith(db, 'Pentadbir Satu', ['superadmin', 'admin']);
    const ops = await enrolOps(db, uid);
    const pub = await enrolPublic(db, uid, ['superadmin', 'admin']);
    const otherUid = userWith(db, 'Orang Biasa', ['admin']);
    const other = await enrolPublic(db, otherUid, ['admin']);
    db.close();
    const r = await cli('cloud', path, ['ops-devices']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(ops);
    expect(r.out).toContain(pub);
    expect(r.out).not.toContain(other);
    // the two groups are told apart: the ops device and the public one are on different lines
    const lineOf = (id: string): string => r.out.split('\n').find((l) => l.includes(id))!;
    expect(lineOf(ops)).not.toBe(lineOf(pub));
    // the output never carries a key or a code
    expect(r.out).not.toMatch(CODE_RE);
    expect(r.out).not.toContain('publicJwk');
  });
});

describe('ops-unmark (cloud role)', () => {
  it('clears the flag, ends the sessions, logs it; the device is still listed as a public device of an ops user', async () => {
    const path = tempDb();
    const db = openDb(path);
    const uid = userWith(db, 'Pentadbir Satu', ['superadmin', 'admin']);
    const dev = await enrolOps(db, uid);
    const at = new Date().toISOString();
    db.prepare('INSERT INTO sessions (id, token_hash, device_id, user_id, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      's-1', 'hash-1', dev, uid, at, new Date(Date.now() + 3_600_000).toISOString(), at,
    );
    db.close();
    const r = await cli('cloud', path, ['ops-unmark', '--device', dev]);
    expect(r.code, r.err).toBe(0);
    const check = openDb(path);
    try {
      expect(check.prepare('SELECT ops FROM devices WHERE id = ?').get(dev)).toMatchObject({ ops: 0 });
      expect(n(check, 'SELECT COUNT(*) AS n FROM sessions WHERE device_id = ? AND revoked_at IS NULL', dev)).toBe(0);
      expect(n(check, "SELECT COUNT(*) AS n FROM auth_log WHERE event = 'ops_unmark' AND device_id = ?", dev)).toBe(1);
      expect(n(check, "SELECT COUNT(*) AS n FROM devices WHERE id = ? AND revoked_at IS NULL", dev)).toBe(1);
    } finally {
      check.close();
    }
    const list = await cli('cloud', path, ['ops-devices']);
    expect(list.out).toContain(dev);
  });

  it('refuses an unknown device, a device that is not ops, and a missing --device (exit 1, nothing changed)', async () => {
    const path = tempDb();
    const db = openDb(path);
    const uid = userWith(db, 'Orang Biasa', ['admin']);
    const pub = await enrolPublic(db, uid, ['admin']);
    const before = n(db, 'SELECT COUNT(*) AS n FROM auth_log');
    db.close();
    for (const args of [['ops-unmark', '--device', 'tiada-peranti'], ['ops-unmark', '--device', pub], ['ops-unmark']]) {
      const r = await cli('cloud', path, args);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.err.length).toBeGreaterThan(0);
    }
    const check = openDb(path);
    try {
      expect(n(check, "SELECT COUNT(*) AS n FROM auth_log WHERE event = 'ops_unmark'")).toBe(0);
      expect(n(check, 'SELECT COUNT(*) AS n FROM auth_log')).toBe(before);
    } finally {
      check.close();
    }
  });
});

describe('support-add and support-remove (cloud role)', () => {
  it('support-add creates a support-only user filed under *, prints the code once, logs it nowhere', async () => {
    const path = tempDb();
    openDb(path).close();
    const r = await cli('cloud', path, ['support-add', '--name', 'Sokongan Satu', '--device-name', 'Telefon Sokongan']);
    expect(r.code, r.err).toBe(0);
    const code = CODE_RE.exec(r.out)![0];
    const check = openDb(path);
    try {
      const u = check.prepare("SELECT id, roles_json, surau_id, active FROM users WHERE name = 'Sokongan Satu'").get() as Record<string, unknown>;
      expect(JSON.parse(String(u.roles_json))).toEqual(['support']);
      expect(u.surau_id).toBe('*');
      expect(u.active).toBe(1);
      expect(n(check, "SELECT COUNT(*) AS n FROM auth_log WHERE event = 'support_add' AND ok = 1")).toBe(1);
      expect(n(check, "SELECT COUNT(*) AS n FROM enrolments WHERE ops = 1 AND used_at IS NULL AND user_id = ?", String(u.id))).toBe(1);
      const rows = JSON.stringify([
        check.prepare('SELECT * FROM auth_log').all(),
        check.prepare('SELECT * FROM change_log').all(),
        check.prepare('SELECT code_hash FROM enrolments').all().length === 1 ? [] : ['x'],
      ]);
      expect(rows).not.toContain(code);
      expect(rows).not.toContain(code.replace(/-/g, ''));
    } finally {
      check.close();
    }
    // a second support-add with the same name is allowed; the ids differ
    const again = await cli('cloud', path, ['support-add', '--name', 'Sokongan Satu']);
    expect(again.code, again.err).toBe(0);
    const c2 = openDb(path);
    try {
      expect(n(c2, "SELECT COUNT(DISTINCT id) AS n FROM users WHERE name = 'Sokongan Satu'")).toBe(2);
    } finally {
      c2.close();
    }
  });

  it('support-remove: a support-only user is switched off and its ops device ends; an auth_log row is written', async () => {
    const path = tempDb();
    const db = openDb(path);
    const uid = userWith(db, 'Sokongan Dua', ['support']);
    db.prepare("UPDATE users SET surau_id = '*', no = NULL, no_src = NULL WHERE id = ?").run(uid);
    const dev = await enrolOps(db, uid);
    db.close();
    const r = await cli('cloud', path, ['support-remove', '--user', uid]);
    expect(r.code, r.err).toBe(0);
    const check = openDb(path);
    try {
      expect(n(check, 'SELECT active AS n FROM users WHERE id = ?', uid)).toBe(0);
      expect(n(check, 'SELECT COUNT(*) AS n FROM devices WHERE id = ? AND revoked_at IS NOT NULL', dev)).toBe(1);
      expect(n(check, "SELECT COUNT(*) AS n FROM auth_log WHERE event = 'support_remove' AND ok = 1")).toBe(1);
    } finally {
      check.close();
    }
    const bad = await cli('cloud', path, ['support-remove', '--user', uid]);
    expect(bad.code).toBe(1);
  });

  it('support-remove keeps a user with another role and makes its ops device public', async () => {
    const path = tempDb();
    const db = openDb(path);
    const uid = userWith(db, 'Sokongan Tiga', ['support', 'admin']);
    const dev = await enrolOps(db, uid);
    db.close();
    const r = await cli('cloud', path, ['support-remove', '--user', uid]);
    expect(r.code, r.err).toBe(0);
    const check = openDb(path);
    try {
      expect(n(check, 'SELECT active AS n FROM users WHERE id = ?', uid)).toBe(1);
      expect(JSON.parse(String((check.prepare('SELECT roles_json FROM users WHERE id = ?').get(uid) as Record<string, unknown>).roles_json))).toEqual(['admin']);
      expect(n(check, 'SELECT ops AS n FROM devices WHERE id = ?', dev)).toBe(0);
    } finally {
      check.close();
    }
  });

  it('both refuse on a box role and change nothing', async () => {
    const path = tempDb();
    openDb(path).close();
    for (const args of [['support-add', '--name', 'X'], ['support-remove', '--user', 'abc']]) {
      const r = await cli('box', path, args);
      expect(r.code).toBe(1);
      expect(r.err).toContain('Hanya di awan MAXCOM');
    }
    const check = openDb(path);
    try {
      expect(n(check, 'SELECT COUNT(*) AS n FROM users')).toBe(0);
    } finally {
      check.close();
    }
  });
});

/**
 * Plan 14 Task 8: the surau registry commands of `src/cli/users.ts` (`cloud-suraus`, `surau-suspend`,
 * `surau-unsuspend`, `surau-limit`, `cloud-revoke`) on a database with no Worker. The automatic link, `cloud-approve`
 * targets and the storage refusals are in `approveSurau.test.ts` and `suraus.test.ts`.
 *
 * Assumptions for the implementer:
 *  5. Like the ops commands, these five are cloud-only: on a box role each prints `Hanya di awan MAXCOM` on stderr,
 *     exits 1 and changes nothing.
 *  6. `surau-suspend --surau <id> --reason "<text>"` sets `suspended_at` and `suspended_reason`; `surau-unsuspend
 *     --surau <id>` clears both; `surau-limit --surau <id> --gb <n>` stores `n * 1024^3` in
 *     `suraus.storage_limit_bytes`; `cloud-suraus` prints id, name and status of every surau, one line each at least.
 *     A missing flag exits 2 or 1; an unknown surau, an empty reason, a non positive or non numeric `--gb` exit 1 and
 *     change nothing. The usage text lists the new commands and `--new-surau`.
 */
describe('surau registry commands (cloud role)', () => {
  const GIB = 1024 * 1024 * 1024;
  function withSurau(path: string, id: string, name: string): void {
    const db = openDb(path);
    db.prepare('INSERT INTO suraus (id, name, created_at, created_by) VALUES (?, ?, ?, ?)').run(id, name, '2026-11-12T08:00:00.000Z', 'test');
    db.close();
  }
  const suraus = (path: string): Record<string, unknown>[] => {
    const db = openDb(path);
    try {
      // insertion order (the tests destructure [first made, second made])
      return db.prepare('SELECT * FROM suraus ORDER BY rowid').all();
    } finally {
      db.close();
    }
  };

  it('surau-suspend and surau-unsuspend set and clear the suspension; cloud-suraus lists the surau and its status', async () => {
    const path = tempDb();
    withSurau(path, 'surau-satu', 'Surau Satu');
    withSurau(path, 'surau-dua', 'Surau Dua');
    const sus = await cli('cloud', path, ['surau-suspend', '--surau', 'surau-satu', '--reason', 'Penyalahgunaan']);
    expect(sus.code, sus.err).toBe(0);
    const [one, two] = suraus(path);
    expect(one).toMatchObject({ id: 'surau-satu', suspended_reason: 'Penyalahgunaan' });
    expect(typeof one!.suspended_at).toBe('string');
    expect(two).toMatchObject({ id: 'surau-dua', suspended_at: null, suspended_reason: null });
    const listed = await cli('cloud', path, ['cloud-suraus']);
    expect(listed.code, listed.err).toBe(0);
    for (const s of ['surau-satu', 'Surau Satu', 'surau-dua', 'Surau Dua']) expect(listed.out).toContain(s);
    const lift = await cli('cloud', path, ['surau-unsuspend', '--surau', 'surau-satu']);
    expect(lift.code, lift.err).toBe(0);
    expect(suraus(path)[0]).toMatchObject({ suspended_at: null, suspended_reason: null });
  });

  it('surau-limit stores n GB as bytes for that surau only', async () => {
    const path = tempDb();
    withSurau(path, 'surau-satu', 'Surau Satu');
    withSurau(path, 'surau-dua', 'Surau Dua');
    const r = await cli('cloud', path, ['surau-limit', '--surau', 'surau-satu', '--gb', '5']);
    expect(r.code, r.err).toBe(0);
    const [one, two] = suraus(path);
    expect(one!.storage_limit_bytes).toBe(5 * GIB);
    expect(two!.storage_limit_bytes ?? null).toBeNull();
  });

  it('refusals change nothing: unknown surau, empty reason, bad --gb, missing flags', async () => {
    const path = tempDb();
    withSurau(path, 'surau-satu', 'Surau Satu');
    const before = JSON.stringify(suraus(path));
    const logRows = (): number => {
      const db = openDb(path);
      try {
        return Number((db.prepare('SELECT COUNT(*) AS n FROM change_log').get() as { n: number }).n);
      } finally {
        db.close();
      }
    };
    const logBefore = logRows();
    const cases: [string[], string][] = [
      [['surau-suspend', '--surau', 'tiada', '--reason', 'x'], 'surau_not_found'],
      [['surau-suspend', '--surau', 'surau-satu', '--reason', '  '], 'bad_args'],
      [['surau-suspend', '--surau', 'surau-satu'], 'bad_args'],
      [['surau-suspend', '--reason', 'x'], 'bad_args'],
      [['surau-unsuspend', '--surau', 'tiada'], 'surau_not_found'],
      [['surau-unsuspend'], 'bad_args'],
      [['surau-limit', '--surau', 'tiada', '--gb', '1'], 'surau_not_found'],
      [['surau-limit', '--surau', 'surau-satu', '--gb', '0'], 'bad_args'],
      [['surau-limit', '--surau', 'surau-satu', '--gb', '-2'], 'bad_args'],
      [['surau-limit', '--surau', 'surau-satu', '--gb', 'banyak'], 'bad_args'],
      [['surau-limit', '--surau', 'surau-satu'], 'bad_args'],
      [['surau-limit', '--gb', '1'], 'bad_args'],
    ];
    for (const [args, word] of cases) {
      const r = await cli('cloud', path, args);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.err, args.join(' ')).toContain(word);
      expect(JSON.stringify(suraus(path)), args.join(' ')).toBe(before);
    }
    expect(logRows(), 'no change_log row for a refusal').toBe(logBefore);
  });

  it('cloud-revoke needs --box-id and refuses an unknown box', async () => {
    const path = tempDb();
    openDb(path).close();
    const none = await cli('cloud', path, ['cloud-revoke']);
    expect(none.code).toBe(1);
    expect(none.err).toContain('bad_args');
    const unknown = await cli('cloud', path, ['cloud-revoke', '--box-id', 'ffffffffffffffff']);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('not_found');
    const malformed = await cli('cloud', path, ['cloud-revoke', '--box-id', 'NOT-A-BOX']);
    expect(malformed.code).toBe(1);
    expect(malformed.err).toContain('not_found');
  });

  it('all of them refuse on a box role and change nothing', async () => {
    const path = tempDb();
    openDb(path).close();
    for (const args of [
      ['cloud-suraus'],
      ['surau-suspend', '--surau', 'x', '--reason', 'y'],
      ['surau-unsuspend', '--surau', 'x'],
      ['surau-limit', '--surau', 'x', '--gb', '1'],
      ['cloud-revoke', '--box-id', 'ffffffffffffffff'],
    ]) {
      const r = await cli('box', path, args);
      expect(r.code, args[0]).toBe(1);
      expect(r.err, args[0]).toContain('Hanya di awan MAXCOM');
    }
    expect(suraus(path)).toEqual([]);
  });

  it('the usage text names the new commands and the approve targets', async () => {
    const path = tempDb();
    const err: string[] = [];
    expect(await run(['--db', path], { err: (l) => err.push(l), out: () => undefined })).toBe(2);
    for (const word of ['cloud-suraus', 'surau-suspend', 'surau-unsuspend', 'surau-limit', 'cloud-revoke', '--new-surau', '--surau']) {
      expect(err.join('\n')).toContain(word);
    }
  });
});
