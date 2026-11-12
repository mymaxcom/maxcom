import { createHash, X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { AuthError, createUser, listUsers, logChange } from '../auth/users.ts';
import type { User } from '../auth/users.ts';
import { appLockEnabled } from '../auth/appLock.ts';
import { beginEnrolment, listDevices } from '../auth/devices.ts';
import { surauPublicInfo } from '../settingsStore.ts';
import { boxId } from '../auth/secrets.ts';
import { openDb } from '../db.ts';
import { setupFromCli } from '../setup/complete.ts';
import { enrolCloudOrigin } from '../sync/sites.ts';

const USAGE =
  'Guna: node apps/box-server/src/cli/bootstrap.ts --db <laluan surau.db> --name "Nama Pentadbir" [--box https://<ip>:8443] [--data <folder data>] [--surau-name "Nama Surau"] [--box-name "MAXCOM Dewan Utama"] [--force-new-code]' + String.fromCharCode(10) +
  'Untuk pembangunan; pengguna akhir guna kod QR di skrin.';

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`Hujah tidak dikenali: ${a}`);
    if (a === '--force-new-code') {
      out['force-new-code'] = 'true';
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`Nilai diperlukan untuk ${a}`);
    out[a.slice(2)] = v;
    i++;
  }
  return out;
}

/** SHA-256 (hex) of the root CA certificate, DER or PEM, if the file exists. */
export function rootCaSha256(dataDir: string): string | null {
  const path = join(dataDir, 'pki', 'root-ca.cer');
  if (!existsSync(path)) return null;
  try {
    const bytes = readFileSync(path);
    const der = bytes.includes('BEGIN CERTIFICATE') ? new X509Certificate(bytes).raw : bytes;
    return createHash('sha256').update(der).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Issues a NEW one-time enrolment code for an existing user and returns the printable lines
 * (code, `surau1:` payload, CA fingerprint). Logged in change_log as the local actor.
 * Never removes devices; never prints PINs or tokens.
 */
export function issueEnrolmentLines(db: DatabaseSync, user: User, box: string, dataDir: string, heading: string): string[] {
  // The operator at the database itself may enrol anyone (the first Pentadbir MAXCOM included).
  const enrolment = beginEnrolment(db, { userId: user.id, deviceName: 'Telefon pentadbir' }, 'local', { canManageSuperadmin: true });
  logChange(
    db, 'local', 'users', user.id,
    { id: user.id, name: user.name, roles: user.roles, active: user.active },
    { id: user.id, name: user.name, roles: user.roles, active: user.active, enrolCodeIssued: true },
  );
  const ca = rootCaSha256(dataDir);
  const info = surauPublicInfo(db);
  const cloudOrigin = enrolCloudOrigin(db);
  const payload =
    'surau1:' +
    Buffer.from(
      JSON.stringify({
        v: 1,
        mode: 'ip',
        box,
        boxId: boxId(dataDir),
        ...(cloudOrigin !== undefined ? { cloud: cloudOrigin } : {}),
        caSha256: ca,
        code: enrolment.code,
        user: user.name,
        pinSet: !user.pinRequired,
        appLock: appLockEnabled(db),
        exp: new Date(enrolment.expiresAt).getTime(),
        surau: { name: info.name, kind: info.kind },
        ...(info.help ? { help: info.help } : {}),
        roles: user.roles,
        invitedBy: 'MAXCOM',
      }),
    ).toString('base64url');
  return [
    heading,
    `Kod pendaftaran (sekali guna, tamat ${enrolment.expiresAt}): ${enrolment.code}`,
    `Teks kod QR: ${payload}`,
    ca === null ? 'Cap jari CA akar: tiada (jalankan scripts/box-ca.ps1)' : `Cap jari CA akar (SHA-256): ${ca}`,
  ];
}

function run(argv: string[]): number {
  let args: Record<string, string>;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n${USAGE}\n`);
    return 2;
  }
  const dbPath = args.db;
  const name = args.name;
  if (dbPath === undefined || name === undefined) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const box = args.box ?? 'https://127.0.0.1:8443';
  const dataDir = resolve(args.data ?? dirname(resolve(dbPath)));
  const db = openDb(dbPath);
  try {
    const admins = listUsers(db).filter((u) => u.active && u.roles.includes('admin'));
    if (admins.length > 0) {
      // Recovery: never a second admin. A NEW code only for an admin with no active device,
      // or for any admin when --force-new-code is given (devices are never removed).
      const force = args['force-new-code'] === 'true';
      const candidates = force ? admins : admins.filter((a) => listDevices(db, a.id).length === 0);
      // --name is required and must match: a typo or a different person never gets someone else's code.
      const pool = candidates.filter((a) => a.name === name);
      if (pool.length === 0) {
        process.stderr.write(
          candidates.length > 0
            ? 'Pentadbir sudah wujud tetapi --name tidak sepadan; nyatakan nama yang tepat, atau guna cli/users.ts enrol <id>\n'
            : force
              ? 'Pentadbir sudah wujud dan lebih daripada satu padanan; nyatakan --name yang tepat, atau guna cli/users.ts enrol <id>\n'
              : 'Pentadbir sudah wujud dan sudah mempunyai peranti; guna --force-new-code atau cli/users.ts enrol <id>\n',
        );
        return 1;
      }
      if (pool.length > 1) {
        process.stderr.write('Pentadbir sudah wujud dan lebih daripada satu padanan; guna cli/users.ts enrol <id>\n');
        return 1;
      }
      const lines = issueEnrolmentLines(db, pool[0]!, box, dataDir, `Kod pendaftaran baharu untuk pentadbir sedia ada: ${pool[0]!.name}`);
      process.stdout.write(lines.join('\n') + '\n');
      return 0;
    }
    // An empty box runs the same setup core as the QR on the TV; a box with only non-admin users just gets its first admin.
    if (listUsers(db).length === 0) {
      const done = setupFromCli(db, dataDir, boxId(dataDir), {
        adminName: name,
        ...(args['surau-name'] !== undefined ? { surauName: args['surau-name'] } : {}),
        ...(args['box-name'] !== undefined ? { boxName: args['box-name'] } : {}),
      });
      const setupLines = issueEnrolmentLines(db, done.user, box, dataDir, `Pentadbir dicipta: ${done.user.name}`);
      setupLines.push(`Kod pemulihan (tulis di atas kertas, ditunjukkan sekali): ${done.recoveryCode}`);
      process.stdout.write(setupLines.join('\n') + '\n');
      return 0;
    }
    const admin = createUser(db, { name, roles: ['admin'] }, 'local');
    const lines = issueEnrolmentLines(db, admin, box, dataDir, `Pentadbir dicipta: ${admin.name}`);
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  } catch (e) {
    process.stderr.write(`${e instanceof AuthError ? e.message : 'Gagal mencipta pentadbir'}\n`);
    return 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(process.argv.slice(2));
}
