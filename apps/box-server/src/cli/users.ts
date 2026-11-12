import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appLockEnabled } from '../auth/appLock.ts';
import { AuthError, getAuthUser, listUsers, logChange, promoteSuperadmin, revokeDeviceRow, superadminRowCount, tx } from '../auth/users.ts';
import { listDevices, revokeDevice } from '../auth/devices.ts';
import { openDb } from '../db.ts';
import { bumpVersion, putFeature } from '../settingsStore.ts';
import { ApprovalError, approveSite, formatCode, issueLinkCode, revokeSite } from '../sync/sites.ts';
import { workerAdminFrom } from '../sync/workerOutbox.ts';
import type { WorkerAdminConfig } from '../sync/workerOutbox.ts';
import { getRegistration, listRegistrations, RegError } from '../sync/workerRegs.ts';
import { issueEnrolmentLines, parseArgs } from './bootstrap.ts';
import { boxId as boxIdOf } from '../auth/secrets.ts';
import { issueRecoveryCode } from '../setup/codes.ts';
import { boxName, boxState, setBoxName } from '../setup/state.ts';

const USAGE = [
  'Guna: node apps/box-server/src/cli/users.ts --db <laluan surau.db> <arahan> [id]',
  '  list                   senarai pengguna dan peranti',
  '  revoke-device <id>     batalkan peranti dan sesinya',
  '  reset-pin <userId>     padam PIN (PIN baharu diperlukan) dan semua sesi pengguna; senaraikan peranti aktif [--revoke-device <id>] (boleh diulang)',
  '  unlock-user <userId>   buka kunci pengguna yang dikunci kerana PIN salah',
  '  cloud-code --box-id <id> --name "<nama surau>"   (awan) kod sekali guna 15 minit untuk memautkan kotak',
  '  cloud-revoke-site <boxId>   (awan) batalkan kunci tapak kotak (dan kelulusan pautan automatiknya)',
  '  cloud-pending          (awan) senarai kotak yang mendaftar sendiri dan menunggu kelulusan',
  '  cloud-approve --box-id <id> [--name "<nama surau>"] [--code <8 heks>]   (awan) luluskan kotak itu; ia memautkan dirinya sendiri (--code: kod tuntutan pada kotak, mesti sepadan)',
  '  promote-superadmin --name "<nama tepat>" [--rename "MAXCOM SuperAdmin"]   (awan) jadikan pengguna Pentadbir MAXCOM pertama (kekal Pentadbir); pengguna mesti sudah diselaraskan ke awan',
  '  enrol <userId>         keluarkan kod pendaftaran sekali guna baharu [--box https://<ip>:8443] [--data <folder>]',
  '  box-name "<nama>"      tetapkan nama MAXCOM ini (untuk pembangunan) [--data <folder>]',
  '  recovery-code          jana kod pemulihan baharu (ditunjukkan sekali; yang lama tamat)',
  '  state                  papar keadaan kotak: setup, active, recovery atau locked',
].join('\n');

const ACTOR = 'local';

function stdoutLine(line: string): void {
  process.stdout.write(line + '\n');
}

export interface UsersCliOptions {
  /** The Worker admin settings (default: SURAU_WORKER_URL + SURAU_WORKER_ADMIN_TOKEN from the environment). */
  workerAdmin?: WorkerAdminConfig | null;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export async function run(argv: string[], cli: UsersCliOptions = {}): Promise<number> {
  const out = cli.out ?? stdoutLine;
  const errOut = cli.err ?? ((l: string): void => void process.stderr.write(`${l}\n`));
  // The command words are positional; the flags are --db <path>.
  const flagArgs: string[] = [];
  const words: string[] = [];
  const revokeIds: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--revoke-device') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        errOut(`Nilai diperlukan untuk ${a}
${USAGE}`);
        return 2;
      }
      revokeIds.push(v);
      i++;
    } else if (a.startsWith('--')) {
      flagArgs.push(a);
      const v = argv[i + 1];
      if (v !== undefined) flagArgs.push(v);
      i++;
    } else words.push(a);
  }
  let args: Record<string, string>;
  try {
    args = parseArgs(flagArgs);
  } catch (e) {
    errOut(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const [command, id] = words;
  if (args.db === undefined || command === undefined) {
    errOut(USAGE);
    return 2;
  }
  const db = openDb(args.db);
  try {
    switch (command) {
      case 'list': {
        out(`Kunci aplikasi: ${appLockEnabled(db) ? 'dihidupkan' : 'dimatikan'}`);
        const devices = listDevices(db, undefined, { includeRevoked: true });
        for (const u of listUsers(db)) {
          const state = [u.active ? 'aktif' : 'tidak aktif', u.pinRequired ? 'PIN diperlukan' : 'PIN ditetapkan'];
          if (u.pinLockedUntil !== null && u.pinLockedUntil > new Date().toISOString()) {
            state.push(`dikunci hingga ${u.pinLockedUntil}`);
          }
          out(`${u.id}  ${u.name}  [${u.roles.join(',')}]  ${state.join(', ')}`);
          for (const d of devices.filter((x) => x.userId === u.id)) {
            out(`  peranti ${d.id}  ${d.name}  ${d.platform}  ${d.revokedAt === null ? 'aktif' : 'dibatalkan'}`);
          }
        }
        return 0;
      }
      case 'app-lock': {
        if (id !== 'on' && id !== 'off') throw new AuthError(400, 'bad_args', 'Guna: app-lock on atau app-lock off');
        putFeature(db, 'appLock', { enabled: id === 'on' }, ACTOR);
        out(`Kunci aplikasi: ${appLockEnabled(db) ? 'dihidupkan' : 'dimatikan'}`);
        return 0;
      }
      case 'revoke-device': {
        if (id === undefined) throw new AuthError(400, 'bad_args', 'ID peranti diperlukan');
        revokeDevice(db, id, ACTOR);
        out(`Peranti ${id} dibatalkan`);
        return 0;
      }
      case 'promote-superadmin': {
        const nameArg = args.name;
        if (nameArg === undefined) throw new AuthError(400, 'bad_args', 'Guna: promote-superadmin --name "<nama tepat>" [--rename "<nama baharu>"]');
        if (superadminRowCount(db) > 0) {
          throw new AuthError(409, 'superadmin_exists', 'Pentadbir MAXCOM sudah wujud');
        }
        const hits = listUsers(db).filter((u) => u.active && u.name === nameArg);
        if (hits.length !== 1) {
          throw new AuthError(404, 'user_not_found', hits.length === 0 ? 'Pengguna tidak dijumpai (nama mesti tepat)' : 'Lebih daripada seorang pengguna dengan nama itu');
        }
        const promoted = promoteSuperadmin(db, hits[0]!.id, ACTOR, args.rename);
        out(`${promoted.name} kini Pentadbir MAXCOM (id ${promoted.id}), peranan: ${promoted.roles.join(', ')}`);
        return 0;
      }
      case 'cloud-code': {
        const boxArg = args['box-id'];
        const nameArg = args.name;
        if (boxArg === undefined || nameArg === undefined) throw new AuthError(400, 'bad_args', 'Guna: cloud-code --box-id <id> --name "<nama>"');
        let issued;
        try {
          issued = issueLinkCode({ db, now: () => new Date() }, { boxId: boxArg, name: nameArg });
        } catch {
          throw new AuthError(400, 'bad_args', 'ID kotak atau nama tidak sah');
        }
        out(`Kod pautan: ${formatCode(issued.code)}`);
        out(`Sah sehingga ${issued.expiresAt} (15 minit, sekali guna)`);
        return 0;
      }
      case 'cloud-revoke-site': {
        if (id === undefined) throw new AuthError(400, 'bad_args', 'ID kotak diperlukan');
        out(revokeSite({ db, now: () => new Date() }, id, ACTOR) ? `Tapak ${id} dibatalkan` : `Tapak ${id} tiada atau sudah dibatalkan`);
        return 0;
      }
      case 'cloud-pending':
      case 'cloud-approve': {
        // the registrations wait at the Worker; the cloud reads them with its admin token (the outbox's settings)
        const config = cli.workerAdmin !== undefined ? cli.workerAdmin : workerAdminFrom(process.env);
        if (config === null) throw new AuthError(400, 'no_worker', 'Worker tidak ditetapkan (SURAU_WORKER_URL dan SURAU_WORKER_ADMIN_TOKEN)');
        try {
          if (command === 'cloud-pending') {
            const regs = await listRegistrations(config);
            if (regs.length === 0) out('Tiada kotak menunggu kelulusan');
            for (const r of regs.sort((a, b) => a.at.localeCompare(b.at))) {
              // the full claimHash: its first 8 characters are the claim code the box shows
              out(`${r.boxId}  ${r.at}  ${r.name === '' ? '(tiada nama)' : r.name}  cincangan ${r.claimHash}`);
            }
            return 0;
          }
          const boxArg = args['box-id'];
          if (boxArg === undefined) throw new AuthError(400, 'bad_args', 'Guna: cloud-approve --box-id <id> [--name "<nama>"] [--code <8 hex>]');
          const codeArg = args.code;
          if (codeArg !== undefined && !/^[0-9a-fA-F]{8}$/.test(codeArg)) throw new AuthError(400, 'bad_args', 'Kod tuntutan mesti 8 aksara heks (seperti yang ditunjukkan kotak)');
          const reg = await getRegistration(config, boxArg);
          if (reg === null) throw new AuthError(404, 'not_registered', 'Kotak ini belum mendaftar (atau pendaftarannya sudah tamat)');
          // the code the surau reads off its box must match this registration, else it is someone else's: store nothing
          if (codeArg !== undefined && codeArg.toLowerCase() !== reg.claimHash.slice(0, 8)) {
            throw new AuthError(409, 'code_mismatch', 'Kod tuntutan tidak sepadan dengan pendaftaran kotak ini; tiada apa-apa diluluskan');
          }
          const name = (args.name ?? reg.name).trim();
          if (name === '') throw new AuthError(400, 'bad_args', 'Nama diperlukan: --name "<nama surau>"');
          approveSite({ db, now: () => new Date() }, { boxId: reg.boxId, name, claimHash: reg.claimHash }, ACTOR);
          out(`Kotak ${reg.boxId} diluluskan (${name}); ia akan dipautkan sendiri bila awan hidup`);
          return 0;
        } catch (e) {
          if (e instanceof RegError) throw new AuthError(409, 'worker', `Worker tidak dapat dihubungi atau menolak (${e.reason})`);
          if (e instanceof ApprovalError) throw new AuthError(e.code === 'linked' ? 409 : 400, e.code, e.message);
          throw e;
        }
      }
      case 'box-name': {
        if (id === undefined) throw new AuthError(400, 'bad_args', 'Nama diperlukan');
        const bid = boxIdOf(resolve(args.data ?? dirname(resolve(args.db))));
        out(`Nama MAXCOM: ${setBoxName(db, bid, id, ACTOR)}`);
        return 0;
      }
      case 'recovery-code': {
        const code = tx(db, () => {
          const c = issueRecoveryCode(db);
          bumpVersion(db);
          return c;
        });
        out(`Kod pemulihan (tulis di atas kertas, ditunjukkan sekali): ${code}`);
        return 0;
      }
      case 'state': {
        const st = boxState(db);
        out(`${st.state}${st.reason !== 'none' ? ` (${st.reason})` : ''}`);
        out(`Nama MAXCOM: ${boxName(db, boxIdOf(resolve(args.data ?? dirname(resolve(args.db)))))}`);
        return 0;
      }
      case 'enrol': {
        if (id === undefined) throw new AuthError(400, 'bad_args', 'ID pengguna diperlukan');
        const user = listUsers(db).find((u) => u.id === id);
        if (user === undefined || !user.active) throw new AuthError(404, 'user_not_found', 'Pengguna tidak dijumpai');
        const dataDir = resolve(args.data ?? dirname(resolve(args.db)));
        const lines = issueEnrolmentLines(
          db, user, args.box ?? 'https://127.0.0.1:8443', dataDir, `Kod pendaftaran baharu untuk: ${user.name}`,
        );
        for (const l of lines) out(l);
        return 0;
      }
      case 'reset-pin':
      case 'unlock-user': {
        if (id === undefined) throw new AuthError(400, 'bad_args', 'ID pengguna diperlukan');
        const reset = command === 'reset-pin';
        if (!reset && revokeIds.length > 0) throw new AuthError(400, 'bad_args', '--revoke-device hanya untuk reset-pin');
        const activeDevices: { id: string; name: string; platform: string }[] = [];
        tx(db, () => {
          const before = getAuthUser(db, id);
          if (before === undefined) throw new AuthError(404, 'user_not_found', 'Pengguna tidak dijumpai');
          if (reset) {
            const mine = listDevices(db, id);
            const owned = new Set(mine.map((d) => d.id));
            if (!revokeIds.every((d) => owned.has(d))) {
              throw new AuthError(400, 'bad_device', 'Peranti tidak sah untuk pengguna ini');
            }
            const nowIso = new Date().toISOString();
            for (const d of new Set(revokeIds)) revokeDeviceRow(db, d, ACTOR, nowIso);
            for (const d of mine) {
              if (d.platform !== 'kiosk' && !revokeIds.includes(d.id)) activeDevices.push(d);
            }
          }
          const snap = { id: before.id, name: before.name, roles: before.roles, active: before.active };
          if (reset) {
            db.prepare(
              'UPDATE users SET pin_hash = NULL, pin_fail_count = 0, pin_locked_until = NULL, lock_round = 0 WHERE id = ?',
            ).run(id);
            db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(
              new Date().toISOString(),
              id,
            );
            logChange(db, ACTOR, 'users', id, { ...snap, hasPin: before.pinHash !== null }, { ...snap, hasPin: false, pinReset: true });
          } else {
            db.prepare(
              'UPDATE users SET pin_fail_count = 0, pin_locked_until = NULL, lock_round = 0 WHERE id = ?',
            ).run(id);
            logChange(db, ACTOR, 'users', id, { ...snap, locked: before.pinLockedUntil !== null }, { ...snap, locked: false });
          }
          bumpVersion(db);
        });
        out(reset ? `PIN pengguna ${id} dipadam; PIN baharu diperlukan` : `Pengguna ${id} dibuka kuncinya`);
        if (reset) {
          for (const d of new Set(revokeIds)) out(`Peranti ${d} dibatalkan`);
          if (activeDevices.length > 0) {
            out('Peranti aktif (jika telefon hilang, batalkan dengan: reset-pin <userId> --revoke-device <id>):');
            for (const d of activeDevices) out(`  peranti ${d.id}  ${d.name}  ${d.platform}`);
          }
        }
        return 0;
      }
      default:
        errOut(`Arahan tidak dikenali: ${command}\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    errOut(e instanceof AuthError ? e.message : 'Arahan gagal');
    return 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
