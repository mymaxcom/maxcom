import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { completeEnrolment, listDevices } from '../src/auth/devices.ts';
import { boxId } from '../src/auth/secrets.ts';
import { getAuthUser, listUsers } from '../src/auth/users.ts';
import { openDb } from '../src/db.ts';
import { getVersion } from '../src/settingsStore.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BOOTSTRAP = join(import.meta.dirname, '../src/cli/bootstrap.ts');
const USERS = join(import.meta.dirname, '../src/cli/users.ts');

function tempDb(): { dir: string; db: string } {
  const dir = mkdtempSync(join(tmpdir(), 'surau-cli-'));
  dirs.push(dir);
  return { dir, db: join(dir, 'surau.db') };
}

function cli(script: string, args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function publicJwk(): Record<string, string> {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const j = publicKey.export({ format: 'jwk' });
  return { kty: j.kty!, crv: j.crv!, x: j.x!, y: j.y! };
}

const NL = String.fromCharCode(10);

function codeOf(stdout: string): string {
  return /: ([A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4})\n/.exec(stdout)![1]!;
}

function enrolFrom(db: string, stdout: string): void {
  const d = openDb(db);
  try {
    completeEnrolment(d, { code: codeOf(stdout), publicJwk: publicJwk(), platform: 'android' }, '127.0.0.1');
  } finally {
    d.close();
  }
}

describe('bootstrap CLI', () => {
  it('creates the first admin and prints the one-time code and QR payload', () => {
    const { dir, db } = tempDb();
    const r = cli(BOOTSTRAP, ['--db', db, '--name', 'Nama Pentadbir', '--box', 'https://10.168.0.154:8443']);
    expect(r.code).toBe(0);
    const code = /: ([A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4})\n/.exec(r.stdout)?.[1];
    expect(code).toBeDefined();
    const payload = /Teks kod QR: (surau1:\S+)/.exec(r.stdout)?.[1];
    expect(payload).toBeDefined();
    const body = JSON.parse(Buffer.from(payload!.slice(7), 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(body).toMatchObject({
      v: 1,
      mode: 'ip',
      box: 'https://10.168.0.154:8443',
      boxId: boxId(dir),
      caSha256: null,
      code,
      user: 'Nama Pentadbir',
    });
    expect(Object.keys(body).sort()).toEqual([
      'appLock', 'box', 'boxId', 'caSha256', 'code', 'exp', 'invitedBy', 'mode', 'pinSet', 'roles', 'surau', 'user', 'v',
    ]);
    expect(body.surau).toEqual({ name: 'Surau', kind: 'surau' });
    expect(body.roles).toEqual(['admin']);
    expect(body.pinSet).toBe(false);
    expect(body.appLock).toBe(false);
    expect(r.stderr).toBe('');

    const d = openDb(db);
    try {
      const users = listUsers(d);
      expect(users).toHaveLength(1);
      expect(users[0]!.roles).toEqual(['admin']);
      expect(users[0]!.createdBy).toBe('local');
      // The printed code redeems exactly once.
      const done = completeEnrolment(d, { code: code!, publicJwk: publicJwk(), platform: 'android' }, '127.0.0.1');
      expect(done.roles).toEqual(['admin']);
      expect(() => completeEnrolment(d, { code: code!, publicJwk: publicJwk(), platform: 'android' }, '127.0.0.1')).toThrow();
    } finally {
      d.close();
    }
  });

  it('refuses a second bootstrap once the admin has an active device: exit 1, nothing printed or created', () => {
    const { db } = tempDb();
    const first = cli(BOOTSTRAP, ['--db', db, '--name', 'Satu']);
    expect(first.code).toBe(0);
    enrolFrom(db, first.stdout);
    const again = cli(BOOTSTRAP, ['--db', db, '--name', 'Dua']);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/sudah wujud/);
    expect(again.stdout).toBe('');
    const d = openDb(db);
    try {
      expect(listUsers(d)).toHaveLength(1);
    } finally {
      d.close();
    }
  });

  it('issues a NEW code for an existing admin with no device (expired code), never a second admin', () => {
    const { db } = tempDb();
    const first = cli(BOOTSTRAP, ['--db', db, '--name', 'Satu']);
    const code1 = codeOf(first.stdout);
    const d0 = openDb(db);
    try {
      d0.prepare("UPDATE enrolments SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    } finally {
      d0.close();
    }
    const again = cli(BOOTSTRAP, ['--db', db, '--name', 'Satu']);
    expect(again.code).toBe(0);
    const code2 = codeOf(again.stdout);
    expect(code2).not.toBe(code1);
    expect(again.stdout).toContain('Satu');
    const d = openDb(db);
    try {
      expect(listUsers(d)).toHaveLength(1);
      const done = completeEnrolment(d, { code: code2, publicJwk: publicJwk(), platform: 'android' }, '127.0.0.1');
      expect(done.roles).toEqual(['admin']);
      const log = d.prepare("SELECT actor, after_json FROM change_log WHERE entity = 'users' ORDER BY id DESC LIMIT 1").get();
      expect(log?.actor).toBe('local');
      expect(String(log?.after_json)).toContain('enrolCodeIssued');
    } finally {
      d.close();
    }
  });

  it('--name must match the one device-less admin, else refuse and print nothing (M3)', () => {
    const { db } = tempDb();
    expect(cli(BOOTSTRAP, ['--db', db, '--name', 'Satu']).code).toBe(0);
    const wrong = cli(BOOTSTRAP, ['--db', db, '--name', 'Orang Lain']);
    expect(wrong.code).toBe(1);
    expect(wrong.stdout).toBe('');
    expect(wrong.stderr).toMatch(/--name/);
    const d = openDb(db);
    try {
      expect(listUsers(d)).toHaveLength(1);
    } finally {
      d.close();
    }
  });

  it('--force-new-code issues a code for an admin that has a device, and removes nothing', () => {
    const { db } = tempDb();
    const first = cli(BOOTSTRAP, ['--db', db, '--name', 'Satu']);
    enrolFrom(db, first.stdout);
    const forced = cli(BOOTSTRAP, ['--db', db, '--name', 'Satu', '--force-new-code']);
    expect(forced.code).toBe(0);
    const code = codeOf(forced.stdout);
    const d = openDb(db);
    try {
      expect(listUsers(d)).toHaveLength(1);
      expect(listDevices(d)).toHaveLength(1);
      expect(listDevices(d)[0]!.revokedAt).toBeNull();
      const done = completeEnrolment(d, { code, publicJwk: publicJwk(), platform: 'android' }, '127.0.0.1');
      expect(done.roles).toEqual(['admin']);
      expect(listDevices(d)).toHaveLength(2);
    } finally {
      d.close();
    }
  });

  it('fails with usage when required flags are missing', () => {
    const { db } = tempDb();
    const r = cli(BOOTSTRAP, ['--db', db]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Guna:/);
  });
});

describe('users CLI', () => {
  function seeded(): { db: string; userId: string; deviceId: string } {
    const { db } = tempDb();
    const boot = cli(BOOTSTRAP, ['--db', db, '--name', 'Admin']);
    const code = /: ([A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4})\n/.exec(boot.stdout)![1]!;
    const d = openDb(db);
    try {
      const done = completeEnrolment(d, { code, publicJwk: publicJwk(), platform: 'web', pin: '280419' }, '127.0.0.1');
      return { db, userId: done.userId, deviceId: done.deviceId };
    } finally {
      d.close();
    }
  }

  it('list shows users and devices and never a PIN hash or key', () => {
    const { db, userId, deviceId } = seeded();
    const r = cli(USERS, ['--db', db, 'list']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(userId);
    expect(r.stdout).toContain(deviceId);
    expect(r.stdout).toContain('PIN ditetapkan');
    expect(r.stdout).not.toMatch(/scrypt|280419|"x"|"y"/);
  });

  it('app-lock on|off writes the setting as local, list shows it, bad args are refused', () => {
    const { db } = seeded();
    expect(cli(USERS, ['--db', db, 'list']).stdout.split(NL)[0]).toBe('Kunci aplikasi: dimatikan');
    const on = cli(USERS, ['--db', db, 'app-lock', 'on']);
    expect(on.code).toBe(0);
    expect(on.stdout).toContain('dihidupkan');
    expect(cli(USERS, ['--db', db, 'list']).stdout.split(NL)[0]).toBe('Kunci aplikasi: dihidupkan');
    const d = openDb(db);
    try {
      const row = d.prepare("SELECT actor FROM change_log WHERE entity = 'settings' AND entity_id = 'appLock'").get() as { actor: string };
      expect(row.actor).toBe('local');
    } finally {
      d.close();
    }
    expect(cli(USERS, ['--db', db, 'app-lock', 'off']).stdout).toContain('dimatikan');
    expect(cli(USERS, ['--db', db, 'app-lock', 'maybe']).code).toBe(1);
    expect(cli(USERS, ['--db', db, 'app-lock']).code).toBe(1);
  });

  it('every CLI write that kiosks can see bumps the settings version (Q6)', () => {
    const { db, userId, deviceId } = seeded();
    const version = (): number => {
      const d = openDb(db);
      try {
        return getVersion(d);
      } finally {
        d.close();
      }
    };
    let v = version();
    expect(cli(USERS, ['--db', db, 'unlock-user', userId]).code).toBe(0);
    expect(version()).toBeGreaterThan(v);
    v = version();
    expect(cli(USERS, ['--db', db, 'reset-pin', userId]).code).toBe(0);
    expect(version()).toBeGreaterThan(v);
    v = version();
    expect(cli(USERS, ['--db', db, 'revoke-device', deviceId]).code).toBe(0);
    expect(version()).toBeGreaterThan(v);
  });

  it('bootstrap creating the first admin bumps the settings version (Q6)', () => {
    const { db } = tempDb();
    expect(cli(BOOTSTRAP, ['--db', db, '--name', 'Admin']).code).toBe(0);
    const d = openDb(db);
    try {
      expect(getVersion(d)).toBeGreaterThan(0);
    } finally {
      d.close();
    }
  });

  it('revoke-device revokes the device and logs actor local', () => {
    const { db, deviceId } = seeded();
    const r = cli(USERS, ['--db', db, 'revoke-device', deviceId]);
    expect(r.code).toBe(0);
    const d = openDb(db);
    try {
      expect(listDevices(d, undefined, { includeRevoked: true })[0]!.revokedAt).not.toBeNull();
      const row = d.prepare("SELECT actor FROM change_log WHERE entity = 'devices' ORDER BY id DESC LIMIT 1").get();
      expect(row?.actor).toBe('local');
    } finally {
      d.close();
    }
    expect(cli(USERS, ['--db', db, 'revoke-device', 'nosuchdevice']).code).toBe(1);
  });

  it('reset-pin clears the PIN requirement state and unlock-user clears a lockout', () => {
    const { db, userId } = seeded();
    const d0 = openDb(db);
    try {
      d0.prepare("UPDATE users SET pin_locked_until = '2999-01-01T00:00:00.000Z', pin_fail_count = 3, lock_round = 2 WHERE id = ?").run(userId);
    } finally {
      d0.close();
    }
    const unlock = cli(USERS, ['--db', db, 'unlock-user', userId]);
    expect(unlock.code).toBe(0);
    const reset = cli(USERS, ['--db', db, 'reset-pin', userId]);
    expect(reset.code).toBe(0);
    expect(reset.stdout + reset.stderr).not.toMatch(/scrypt/);
    const d = openDb(db);
    try {
      const u = getAuthUser(d, userId)!;
      expect(u.pinHash).toBeNull();
      expect(u.pinRequired).toBe(true);
      expect(u.pinLockedUntil).toBeNull();
      expect(u.pinFailCount).toBe(0);
      const logs = d.prepare("SELECT actor, before_json, after_json FROM change_log WHERE entity = 'users' ORDER BY id DESC LIMIT 2").all();
      expect(logs.every((l) => l.actor === 'local')).toBe(true);
      expect(JSON.stringify(logs)).not.toMatch(/scrypt/);
    } finally {
      d.close();
    }
    expect(cli(USERS, ['--db', db, 'reset-pin', 'nosuchuser']).code).toBe(1);
  });

  it('reset-pin lists active non-kiosk devices and --revoke-device revokes owned devices atomically (M2)', () => {
    const { db, userId, deviceId } = seeded();
    const en = cli(USERS, ['--db', db, 'enrol', userId]);
    const d0 = openDb(db);
    let second = '';
    try {
      second = completeEnrolment(d0, { code: codeOf(en.stdout), publicJwk: publicJwk(), platform: 'android' }, '127.0.0.1').deviceId;
    } finally {
      d0.close();
    }
    const listed = cli(USERS, ['--db', db, 'reset-pin', userId]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(deviceId);
    expect(listed.stdout).toContain(second);
    expect(listed.stdout + listed.stderr).not.toMatch(/scrypt|280419|token/i);

    // An id that is not the user's: exit 1, nothing changed (PIN kept, devices active).
    const { db: db2, userId: u2 } = seeded();
    const bad = cli(USERS, ['--db', db2, 'reset-pin', u2, '--revoke-device', deviceId]);
    expect(bad.code).toBe(1);
    const dChk = openDb(db2);
    try {
      expect(getAuthUser(dChk, u2)!.pinHash).not.toBeNull();
      expect(listDevices(dChk, u2)).toHaveLength(1);
    } finally {
      dChk.close();
    }

    const r = cli(USERS, ['--db', db, 'reset-pin', userId, '--revoke-device', second]);
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(/scrypt|280419|token/i);
    const d = openDb(db);
    try {
      expect(getAuthUser(d, userId)!.pinHash).toBeNull();
      const active = listDevices(d, userId).map((x) => x.id);
      expect(active).toEqual([deviceId]);
    } finally {
      d.close();
    }
  });

  it('enrol issues a one-time code for an existing active user, logged as local, no PIN or token printed', () => {
    const { db, userId } = seeded();
    const r = cli(USERS, ['--db', db, 'enrol', userId, '--box', 'https://10.168.0.154:8443']);
    expect(r.code).toBe(0);
    const code = codeOf(r.stdout);
    const payload = /Teks kod QR: (surau1:\S+)/.exec(r.stdout)![1]!;
    const body = JSON.parse(Buffer.from(payload.slice(7), 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(body).toMatchObject({ v: 1, box: 'https://10.168.0.154:8443', code, user: 'Admin', roles: ['admin'] });
    expect(r.stdout + r.stderr).not.toMatch(/scrypt|280419|token/i);
    const d = openDb(db);
    try {
      const log = d.prepare("SELECT actor, after_json FROM change_log WHERE entity = 'users' ORDER BY id DESC LIMIT 1").get();
      expect(log?.actor).toBe('local');
      expect(String(log?.after_json)).toContain('enrolCodeIssued');
      expect(JSON.stringify(log)).not.toMatch(/scrypt|280419/);
      const done = completeEnrolment(d, { code, publicJwk: publicJwk(), platform: 'android' }, '127.0.0.1');
      expect(done.userId).toBe(userId);
      expect(listDevices(d)).toHaveLength(2);
    } finally {
      d.close();
    }
  });

  it('enrol refuses an unknown or inactive user and a missing id', () => {
    const { db, userId } = seeded();
    expect(cli(USERS, ['--db', db, 'enrol', 'nosuchuser']).code).toBe(1);
    expect(cli(USERS, ['--db', db, 'enrol']).code).toBe(1);
    const d = openDb(db);
    try {
      d.prepare('UPDATE users SET active = 0 WHERE id = ?').run(userId);
    } finally {
      d.close();
    }
    const r = cli(USERS, ['--db', db, 'enrol', userId]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
  });

  it('rejects an unknown command and a missing --db', () => {
    const { db } = tempDb();
    expect(cli(USERS, ['--db', db, 'frobnicate']).code).toBe(2);
    expect(cli(USERS, ['list']).code).toBe(2);
  });
});

describe('bootstrap on the setup core and the Plan 14 dev commands', () => {
  const recoveryOf = (stdout: string): string =>
    /Kod pemulihan \(tulis di atas kertas, ditunjukkan sekali\): ([A-Z2-9]{4}(?:-[A-Z2-9]{4}){3})/.exec(stdout)![1]!;

  it('on an empty database prints the enrol code and a recovery code, and sets the surau and box names when given', async () => {
    const { dir, db } = tempDb();
    const r = cli(BOOTSTRAP, ['--db', db, '--name', 'Haji Ali', '--surau-name', 'Surau Al-Hidayah', '--box-name', 'MAXCOM Dewan Utama']);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(codeOf(r.stdout)).toMatch(/^[A-Z2-7]{4}-/);
    const recovery = recoveryOf(r.stdout);
    const { verifyRecoveryCode } = await import('../src/setup/codes.ts');
    const { getSettings } = await import('../src/settingsStore.ts');
    const { readBoxJson } = await import('../src/setup/state.ts');
    const d = openDb(db);
    try {
      expect(verifyRecoveryCode(d, recovery)).toBe(true);
      expect(getSettings(d).surauInfo.name).toBe('Surau Al-Hidayah');
      expect(d.prepare("SELECT value FROM meta WHERE key = 'box_name'").get()?.value).toBe('MAXCOM Dewan Utama');
      expect(String(d.prepare("SELECT value FROM meta WHERE key = 'surau_id'").get()?.value)).toMatch(/^[a-z2-7]{12}$/);
      expect(listUsers(d)).toHaveLength(1);
    } finally {
      d.close();
    }
    expect(readBoxJson(dir)).toEqual({ boxName: 'MAXCOM Dewan Utama', surauName: 'Surau Al-Hidayah' });
    // the usage line says it is for development
    expect(cli(BOOTSTRAP, []).stderr).toContain('Untuk pembangunan');
  });

  it('without the new flags it keeps the default surau name and box name, and the recovery code still exists', () => {
    const { db } = tempDb();
    const r = cli(BOOTSTRAP, ['--db', db, '--name', 'Satu']);
    expect(r.code).toBe(0);
    expect(recoveryOf(r.stdout)).toBeDefined();
    const d = openDb(db);
    try {
      expect(d.prepare("SELECT value FROM meta WHERE key = 'box_name'").get()).toBeUndefined();
    } finally {
      d.close();
    }
  });

  it('a bad surau name is refused and creates nothing', () => {
    const { db } = tempDb();
    const r = cli(BOOTSTRAP, ['--db', db, '--name', 'Satu', '--surau-name', '   ']);
    expect(r.code).toBe(1);
    const d = openDb(db);
    try {
      expect(listUsers(d)).toHaveLength(0);
    } finally {
      d.close();
    }
  });

  it('users state prints setup, recovery, then active after an in-process enrolment', () => {
    const { db } = tempDb();
    expect(cli(USERS, ['--db', db, 'state']).stdout).toMatch(/^setup\n/);
    const first = cli(BOOTSTRAP, ['--db', db, '--name', 'Satu']);
    expect(cli(USERS, ['--db', db, 'state']).stdout).toMatch(/^recovery \(no_admin\)\n/);
    enrolFrom(db, first.stdout);
    expect(cli(USERS, ['--db', db, 'state']).stdout).toMatch(/^active\n/);
  });

  it('box-name sets the name; recovery-code prints a code that verifies once and replaces the old one', async () => {
    const { db } = tempDb();
    const first = cli(BOOTSTRAP, ['--db', db, '--name', 'Satu']);
    const r = cli(USERS, ['--db', db, 'box-name', 'MAXCOM Baru']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('MAXCOM Baru');
    expect(cli(USERS, ['--db', db, 'box-name', 'x'.repeat(61)]).code).toBe(1);
    const rc = cli(USERS, ['--db', db, 'recovery-code']);
    expect(rc.code).toBe(0);
    const fresh = recoveryOf(rc.stdout);
    const { verifyRecoveryCode } = await import('../src/setup/codes.ts');
    const d = openDb(db);
    try {
      expect(verifyRecoveryCode(d, fresh)).toBe(true);
      expect(verifyRecoveryCode(d, recoveryOf(first.stdout))).toBe(false);
    } finally {
      d.close();
    }
  });
});
