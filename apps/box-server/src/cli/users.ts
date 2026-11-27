import { LOCAL_SURAU_ID } from '../tenant.ts';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { appLockEnabled } from '../auth/appLock.ts';
import { AuthError, activeAdminCount, createUserIn, deactivateUser, getAuthUser, getUserRow, isStarUser, listUsers, logChange, promoteSuperadmin, restoreUser, revokeDeviceRow, setRoles, setUserPhone, setUsersRole, superadminRowCount, tx, userSurau } from '../auth/users.ts';
import { deleteUserGuarded, listDevices, revokeDevice } from '../auth/devices.ts';
import { formatPhone } from '@surau/core';
import { backfillIds, checkIds, globalRefMap, userIdByRef } from '../auth/ids.ts';
import { issueOpsEnrolment, listOpsDevices, unmarkOps } from '../auth/opsDevice.ts';
import { authLog } from '../auth/sessions.ts';
import { openDb } from '../db.ts';
import { bumpVersion, putFeature } from '../settingsStore.ts';
import { ApprovalError, approveSite, formatCode, issueLinkCode, revokeSite, unrevokeSite } from '../sync/sites.ts';
import { wakeSurau } from '../sync/surauSleep.ts';
import { cleanText, deleteEmptySurau, getSurau, listSuraus, setStorageLimit, SurauError, suspendSurau, unsuspendSurau } from '../surau/registry.ts';
import { PruneBackupError, pruneEmptySuraus } from '../surau/prune.ts';
import { workerAdminFrom } from '../sync/workerOutbox.ts';
import type { WorkerAdminConfig } from '../sync/workerOutbox.ts';
import { getRegistration, isStaleRegistration, listRegistrations, RegError } from '../sync/workerRegs.ts';
import { issueEnrolmentLines, parseArgs } from './bootstrap.ts';
import { boxId as boxIdOf } from '../auth/secrets.ts';
import { issueRecoveryCode } from '../setup/codes.ts';
import { boxName, boxState, setBoxName } from '../setup/state.ts';

const USAGE = [
  'Guna: node apps/box-server/src/cli/users.ts --db <laluan surau.db> <arahan> [id]',
  '  list                   senarai pengguna dan peranti (dengan ID: <surau>/U-0001)',
  '  set-phone --ref <ID> --phone "<nombor>"   tetapkan nombor telefon pengguna (disimpan sebagai E.164; list --phones menunjukkannya)',
  '  delete --ref <ID>      padam (lembut) pengguna: tidak boleh log masuk lagi, sejarah kekal; restore --ref <ID> memulihkannya (tidak aktif); list --deleted menyenaraikan yang dipadam',
  '  check-ids              semak ID: tiada dua rekod berkongsi nombor dan pembilang melebihi nombor tertinggi (keluar 1 jika ada masalah)',
  '  revoke-device <id>     batalkan peranti dan sesinya',
  '  reset-pin <userId>     padam PIN (PIN baharu diperlukan) dan semua sesi pengguna; senaraikan peranti aktif [--revoke-device <id>] (boleh diulang)',
  '  unlock-user <userId>   buka kunci pengguna yang dikunci kerana PIN salah',
  '  cloud-code --box-id <id> --name "<nama surau>" (--new-surau | --surau <id>)   (awan) kod sekali guna 15 minit untuk memautkan kotak ke surau itu',
  '  cloud-revoke-site <boxId>   (awan) batalkan kunci tapak kotak (dan kelulusan pautan automatiknya)',
  '  cloud-pending          (awan) senarai kotak yang mendaftar sendiri dan belum dipautkan (termasuk yang tertahan oleh had harian)',
  '  cloud-approve --box-id <id> (--new-surau [--name "<nama surau>"] | --surau <id>) [--code <8 heks>]   (awan) masukkan kotak itu ke surau baharu atau surau sedia ada (tanpa kotak aktif); ia memautkan dirinya sendiri (--code: kod tuntutan pada kotak, mesti sepadan)',
  '  cloud-revoke --box-id <id>   (awan) batalkan kotak: kuncinya mati serta-merta; surau, datanya dan telefonnya kekal; kotak itu tidak boleh memaut semula sendiri',
  '  cloud-unrevoke --box-id <id>   (awan) benarkan kotak yang dibatalkan memaut semula sendiri (sekali) ke suraunya',
  '  cloud-suraus           (awan) senarai surau dengan status, had storan dan kotaknya',
  '  surau-suspend --surau <id> --reason "<sebab>"   (awan) gantung surau: tapak dan telefonnya ditolak oleh awan (kotak terus berfungsi setempat)',
  '  surau-unsuspend --surau <id>   (awan) tamatkan penggantungan surau',
  '  surau-wake --surau <id>   (awan) bangunkan surau yang dibekukan kerana kotaknya dipautkan kepada kotak lain',
  '  surau-limit --surau <id> --gb <n>   (awan) tetapkan had storan awan surau itu (lalai 2 GB)',
  '  surau-delete --surau <id>   (awan) padam surau yang kosong (tiada kandungan, pengguna, peranti atau kotak aktif); yang tidak kosong ditolak',
  '  surau-prune [--older-hours <n>] [--apply]   (awan) senarai surau kosong yang lebih tua daripada n jam (lalai 24); tanpa --apply hanya senarai, dengan --apply sandaran pangkalan data ditulis dahulu (disulitkan dengan kunci awam age: backups/pre-prune-<UTC>.db.age; tanpa kunci yang sah ia ditolak dan tiada apa dipadam, kecuali MAXCOM_PRUNE_PLAIN_BACKUP=1 membenarkan salinan biasa) kemudian ia dipadam',
  '  promote-superadmin --name "<nama tepat>" [--rename "MAXCOM SuperAdmin"]   (awan) jadikan pengguna Pentadbir MAXCOM pertama (kekal Pentadbir); pengguna mesti sudah diselaraskan ke awan',
  '  enrol <userId>         keluarkan kod pendaftaran sekali guna baharu [--box https://<ip>:8443] [--data <folder>]',
  '  box-name "<nama>"      tetapkan nama MAXCOM ini (untuk pembangunan) [--data <folder>]',
  '  recovery-code          jana kod pemulihan baharu (ditunjukkan sekali; yang lama tamat)',
  '  state                  papar keadaan kotak: setup, active, recovery atau locked',
  '  ops-enrol --name "<nama tepat>" [--device-name "<nama>"]   (awan) kod sekali guna 10 minit untuk peranti MAXCOM Ops',
  '  ops-devices            (awan) senarai peranti MAXCOM Ops, dan peranti awam pengguna Ops',
  '  support-add --name "<nama>" [--device-name "<nama>"]   (awan) cipta pengguna Sokongan MAXCOM dan keluarkan kod peranti Ops (ditunjukkan sekali)',
  '  support-remove --user <id>   (awan) tarik balik peranan Sokongan; peranti Ops dan sesinya ditamatkan',
  '  ops-unmark --device <id>   (awan) jadikan peranti MAXCOM Ops peranti awam dan tamatkan sesinya',
].join('\n');

const OPS_COMMANDS: readonly string[] = ['ops-enrol', 'ops-devices', 'ops-unmark', 'support-add', 'support-remove'];
/** The surau registry commands (Plan 14 Task 8): cloud only, like the ops commands. */
const REGISTRY_COMMANDS: readonly string[] = ['cloud-suraus', 'surau-suspend', 'surau-unsuspend', 'surau-wake', 'surau-limit', 'surau-delete', 'surau-prune', 'cloud-revoke', 'cloud-unrevoke'];
const GIB = 1024 * 1024 * 1024;
/** `--gb`: up to 4 digits, optionally 1 to 3 decimals. */
const GB_RE = /^\d{1,4}(\.\d{1,3})?$/;
/** A shown value: no control or format characters (a name could carry a bidi override). */
const shown = (v: unknown, max = 120): string => cleanText(v, max);

/** `support-add`: a new user holding only `support`, filed under `'*'`. Names need not be unique. */
function createUserTx(db: DatabaseSync, name: string): { id: string; name: string } {
  const u = createUserIn(db, { name, roles: ['support'] }, 'cli', LOCAL_SURAU_ID);
  return { id: u.id, name: u.name };
}

/** The server role, read the way `main.ts` reads it (SURAU_ROLE); anything but `cloud` is a box. */
function cliRole(): 'box' | 'cloud' {
  return (process.env.SURAU_ROLE ?? '').trim().toLowerCase() === 'cloud' ? 'cloud' : 'box';
}

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
  let newSurau = false;
  let applyFlag = false;
  let deletedFlag = false;
  let phonesFlag = false;
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
    } else if (a === '--new-surau') {
      newSurau = true;
    } else if (a === '--apply') {
      applyFlag = true;
    } else if (a === '--deleted') {
      deletedFlag = true;
    } else if (a === '--phones') {
      phonesFlag = true;
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
  const role = cliRole();
  if ((OPS_COMMANDS.includes(command) || REGISTRY_COMMANDS.includes(command)) && role !== 'cloud') {
    errOut('Hanya di awan MAXCOM');
    return 1;
  }
  const db = openDb(args.db);
  setUsersRole(db, role);
  backfillIds(db, role);
  try {
    switch (command) {
      case 'list': {
        out(`Kunci aplikasi: ${appLockEnabled(db, LOCAL_SURAU_ID) ? 'dihidupkan' : 'dimatikan'}`);
        const devices = listDevices(db, undefined, { includeRevoked: true, includeStar: true }, LOCAL_SURAU_ID);
        const userRefs = globalRefMap(db, 'user');
        const deviceRefs = globalRefMap(db, 'device');
        for (const u of listUsers(db, LOCAL_SURAU_ID, true).filter((x) => x.deleted === deletedFlag)) {
          const state = [u.deleted ? `dipadam ${u.deletedAt ?? ''} oleh ${u.deletedBy ?? ''}`.trim() : u.active ? 'aktif' : 'tidak aktif', u.pinRequired ? 'PIN diperlukan' : 'PIN ditetapkan'];
          if (u.pinLockedUntil !== null && u.pinLockedUntil > new Date().toISOString()) {
            state.push(`dikunci hingga ${u.pinLockedUntil}`);
          }
          out(`${userRefs.get(u.id) ?? 'ID belum ada'}  ${u.id}  ${u.name}  [${u.roles.join(',')}]  ${state.join(', ')}${phonesFlag ? `  ${u.phone === null ? 'tiada telefon' : formatPhone(u.phone)}` : ''}`);
          for (const d of devices.filter((x) => x.userId === u.id)) {
            out(`  peranti ${deviceRefs.get(d.id) ?? 'ID belum ada'}  ${d.id}  ${d.name}  ${d.platform}  ${d.revokedAt === null ? 'aktif' : 'dibatalkan'}`);
          }
        }
        return 0;
      }
      case 'check-ids': {
        const problems = checkIds(db, role);
        for (const p of problems) out(p);
        out(problems.length === 0 ? 'ID: semua unik dan pembilang betul' : `ID: ${problems.length} masalah`);
        return problems.length === 0 ? 0 : 1;
      }
      case 'set-phone': {
        if (args.ref === undefined || args.phone === undefined) throw new AuthError(400, 'bad_args', 'Guna: set-phone --ref <ID> --phone "<nombor>"');
        const userId = userIdByRef(db, args.ref, role, LOCAL_SURAU_ID);
        const target = getUserRow(db, userId);
        if (target === undefined || target.deleted) throw new AuthError(404, 'user_not_found', 'Pengguna tidak dijumpai');
        setUserPhone(db, userId, args.phone, ACTOR);
        out(`Nombor telefon ${target.name} dikemas kini`);
        return 0;
      }
      case 'delete':
      case 'restore': {
        if (args.ref === undefined) throw new AuthError(400, 'bad_args', `Guna: ${command} --ref <ID>`);
        const userId = userIdByRef(db, args.ref, role, LOCAL_SURAU_ID);
        const row = getUserRow(db, userId);
        if (row === undefined || isStarUser(db, userId)) throw new AuthError(404, 'user_not_found', 'Pengguna tidak dijumpai');
        if (command === 'restore') {
          const back = restoreUser(db, userId, ACTOR);
          out(`${back.name} dipulihkan (tidak aktif, tanpa peranti); guna Aktifkan semula dan kod baharu`);
          return 0;
        }
        if (row.deleted) throw new AuthError(404, 'user_not_found', 'Pengguna tidak dijumpai');
        if (row.active && (row.roles.includes('admin') && activeAdminCount(db, LOCAL_SURAU_ID) <= 1)) {
          throw new AuthError(409, 'last_admin', 'Mesti ada sekurang-kurangnya seorang pentadbir aktif');
        }
        deleteUserGuarded(db, userId, ACTOR, userSurau(db, userId));
        out(`${row.name} dipadam; sejarah kekal`);
        return 0;
      }
      case 'app-lock': {
        if (id !== 'on' && id !== 'off') throw new AuthError(400, 'bad_args', 'Guna: app-lock on atau app-lock off');
        putFeature(db, 'appLock', { enabled: id === 'on' }, ACTOR, undefined, LOCAL_SURAU_ID);
        out(`Kunci aplikasi: ${appLockEnabled(db, LOCAL_SURAU_ID) ? 'dihidupkan' : 'dimatikan'}`);
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
        if (nameArg === undefined && args.ref === undefined) throw new AuthError(400, 'bad_args', 'Guna: promote-superadmin (--name "<nama tepat>" | --ref <ID>) [--rename "<nama baharu>"]');
        if (superadminRowCount(db) > 0) {
          throw new AuthError(409, 'superadmin_exists', 'Pentadbir MAXCOM sudah wujud');
        }
        const refId = args.ref === undefined ? null : userIdByRef(db, args.ref, role, LOCAL_SURAU_ID);
        const hits = listUsers(db, LOCAL_SURAU_ID, true).filter((u) => u.active && (refId !== null ? u.id === refId : u.name === nameArg));
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
        const codeUsage = 'Guna: cloud-code --box-id <id> --name "<nama>" (--new-surau | --surau <id>)';
        if (boxArg === undefined || nameArg === undefined) throw new AuthError(400, 'bad_args', codeUsage);
        // a code names its surau, never a default
        if (newSurau && args.surau !== undefined) throw new AuthError(400, 'bad_args', `Pilih satu sasaran sahaja. ${codeUsage}`);
        if (!newSurau && args.surau === undefined) throw new AuthError(400, 'surau_required', `Sasaran diperlukan. ${codeUsage}`);
        let issued;
        try {
          const target = newSurau ? { newSurau: { name: nameArg } } : { surauId: args.surau! };
          issued = issueLinkCode({ db, now: () => new Date() }, { boxId: boxArg, name: nameArg, target }, ACTOR);
        } catch (e) {
          if (e instanceof ApprovalError) throw new AuthError(e.code === 'surau_not_found' ? 404 : e.code === 'bad_args' || e.code === 'surau_required' ? 400 : 409, e.code, e.message);
          throw e;
        }
        out(`Surau: ${issued.surauId}${issued.created ? ' (baharu)' : ''}`);
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
              const extra = [
                r.boxName !== undefined && shown(r.boxName, 60) !== '' ? `kotak "${shown(r.boxName, 60)}"` : '',
                r.platform !== undefined ? shown(r.platform, 10) : '',
                r.version !== undefined ? `versi ${shown(r.version, 16)}` : '',
              ].filter((x) => x !== '');
              const name = shown(r.name, 80);
              const stale = isStaleRegistration(r, new Date()) ? '  [stale: tidak kelihatan lebih sehari]' : '';
              out(`${r.boxId}  ${shown(r.at, 40)}${stale}  ${name === '' ? '(tiada nama)' : name}  cincangan ${r.claimHash}${extra.length > 0 ? `  [${extra.join(', ')}]` : ''}`);
            }
            return 0;
          }
          const boxArg = args['box-id'];
          const approveUsage = 'Guna: cloud-approve --box-id <id> (--new-surau [--name "<nama>"] | --surau <id>) [--code <8 hex>]';
          if (boxArg === undefined) throw new AuthError(400, 'bad_args', approveUsage);
          // exactly one target, never a default (the guard against putting a box in the wrong surau)
          if (newSurau && args.surau !== undefined) throw new AuthError(400, 'bad_args', `Pilih satu sasaran sahaja. ${approveUsage}`);
          if (!newSurau && args.surau === undefined) throw new AuthError(400, 'surau_required', `Sasaran diperlukan. ${approveUsage}`);
          if (args.surau !== undefined && args.name !== undefined) throw new AuthError(400, 'bad_args', '--name hanya dengan --new-surau');
          // an unknown target is refused before the Worker is asked (approveSite checks it again in its transaction)
          if (args.surau !== undefined && getSurau(db, args.surau) === null) throw new AuthError(404, 'surau_not_found', 'Surau tidak dijumpai');
          const codeArg = args.code;
          if (codeArg !== undefined && !/^[0-9a-fA-F]{8}$/.test(codeArg)) throw new AuthError(400, 'bad_args', 'Kod tuntutan mesti 8 aksara heks (seperti yang ditunjukkan kotak)');
          const reg = await getRegistration(config, boxArg);
          if (reg === null) throw new AuthError(404, 'not_registered', 'Kotak ini belum mendaftar (atau pendaftarannya sudah tamat)');
          // the code the surau reads off its box must match this registration, else it is someone else's: store nothing
          if (codeArg !== undefined && codeArg.toLowerCase() !== reg.claimHash.slice(0, 8)) {
            throw new AuthError(409, 'code_mismatch', 'Kod tuntutan tidak sepadan dengan pendaftaran kotak ini; tiada apa-apa diluluskan');
          }
          const name = shown(args.name ?? reg.name);
          if (name === '') throw new AuthError(400, 'bad_args', 'Nama diperlukan: --name "<nama surau>"');
          const target = newSurau ? { newSurau: { name } } : { surauId: args.surau! };
          const done = approveSite({ db, now: () => new Date() }, { boxId: reg.boxId, name, claimHash: reg.claimHash, target }, ACTOR);
          out(`Kotak ${reg.boxId} diluluskan ke surau ${done.surauId}${done.created ? ' (baharu)' : ''} (${name}); ia akan dipautkan sendiri bila awan hidup`);
          return 0;
        } catch (e) {
          if (e instanceof RegError) throw new AuthError(409, 'worker', `Worker tidak dapat dihubungi atau menolak (${e.reason})`);
          if (e instanceof ApprovalError) {
            const status = e.code === 'surau_not_found' ? 404 : e.code === 'bad_args' || e.code === 'surau_required' ? 400 : 409;
            throw new AuthError(status, e.code, e.message);
          }
          throw e;
        }
      }
      case 'cloud-revoke': {
        const boxArg = args['box-id'];
        if (boxArg === undefined) throw new AuthError(400, 'bad_args', 'Guna: cloud-revoke --box-id <id>');
        if (!/^[0-9a-f]{16}$/.test(boxArg) || db.prepare('SELECT 1 AS x FROM sites WHERE box_id = ?').get(boxArg) === undefined) {
          throw new AuthError(404, 'not_found', 'Kotak tidak dijumpai');
        }
        if (!revokeSite({ db, now: () => new Date() }, boxArg, ACTOR)) throw new AuthError(409, 'not_linked', `Kotak ${boxArg} sudah dibatalkan`);
        out(`Kotak ${boxArg} dibatalkan; surau, datanya dan telefonnya kekal`);
        return 0;
      }
      case 'cloud-unrevoke': {
        const boxArg = args['box-id'];
        if (boxArg === undefined) throw new AuthError(400, 'bad_args', 'Guna: cloud-unrevoke --box-id <id>');
        try {
          const done = unrevokeSite({ db, now: () => new Date() }, boxArg, ACTOR);
          out(`Kotak ${boxArg} boleh dipautkan semula ke surau ${done.surauId} (sekali, oleh kotak itu sendiri)`);
        } catch (e) {
          if (e instanceof ApprovalError) throw new AuthError(e.code === 'not_found' ? 404 : 409, e.code, e.message);
          throw e;
        }
        return 0;
      }
      case 'cloud-suraus': {
        const all = listSuraus(db);
        if (all.length === 0) out('Tiada surau');
        const gb = (n: number): string => `${(n / GIB).toFixed(2)} GB`;
        for (const s of all) {
          const d = getSurau(db, s.id)!;
          const why = d.suspendedReason !== null ? ` (${shown(d.suspendedReason, 200)})` : '';
          out(`${d.id}  ${shown(d.name)}  ${d.status}${why}  storan ${gb(d.storageUsedBytes)} / ${gb(d.storageLimitBytes)}`);
          for (const b of d.boxes) {
            out(`  kotak ${b.boxId}  ${shown(b.name)}  ${shown(b.role, 20)}  ${b.revoked ? 'dibatalkan' : 'aktif'}  kali terakhir ${b.lastSeenAt ?? '-'}`);
          }
        }
        return 0;
      }
      case 'surau-wake': {
        const surauArg = args.surau;
        if (surauArg === undefined) throw new AuthError(400, 'bad_args', 'Guna: surau-wake --surau <id>');
        const s = getSurau(db, surauArg);
        if (s === null || s === undefined) throw new AuthError(404, 'surau_not_found', 'Surau tidak dijumpai');
        const woke = wakeSurau(db, s.id, ACTOR, 'operator', new Date());
        out(woke ? `Surau ${s.id} (${shown(s.name)}) dibangunkan` : `Surau ${s.id} (${shown(s.name)}) tidak dibekukan`);
        return 0;
      }
      case 'surau-suspend':
      case 'surau-unsuspend':
      case 'surau-limit': {
        const surauArg = args.surau;
        try {
          if (command === 'surau-suspend') {
            if (surauArg === undefined || args.reason === undefined) throw new AuthError(400, 'bad_args', 'Guna: surau-suspend --surau <id> --reason "<sebab>"');
            const s = suspendSurau(db, surauArg, args.reason, ACTOR);
            out(`Surau ${s.id} (${shown(s.name)}) digantung`);
          } else if (command === 'surau-unsuspend') {
            if (surauArg === undefined) throw new AuthError(400, 'bad_args', 'Guna: surau-unsuspend --surau <id>');
            const s = unsuspendSurau(db, surauArg, ACTOR);
            out(`Surau ${s.id} (${shown(s.name)}) tidak lagi digantung`);
          } else {
            const raw = args.gb;
            if (surauArg === undefined || raw === undefined) throw new AuthError(400, 'bad_args', 'Guna: surau-limit --surau <id> --gb <n>');
            const n = GB_RE.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
            if (!(n > 0)) throw new AuthError(400, 'bad_args', 'Had mesti nombor GB yang positif (contoh --gb 5)');
            const s = setStorageLimit(db, surauArg, Math.round(n * GIB), ACTOR);
            out(`Had storan surau ${s.id} (${shown(s.name)}): ${n} GB`);
          }
          return 0;
        } catch (e) {
          if (e instanceof SurauError) throw new AuthError(e.code === 'surau_not_found' ? 404 : 400, e.code, e.message);
          throw e;
        }
      }
      case 'surau-delete': {
        const surauArg = args.surau;
        if (surauArg === undefined) throw new AuthError(400, 'bad_args', 'Guna: surau-delete --surau <id>');
        try {
          const done = deleteEmptySurau(db, surauArg, ACTOR);
          out(`Surau ${done.id} (${shown(done.name)}) dipadam`);
          return 0;
        } catch (e) {
          if (e instanceof SurauError) throw new AuthError(e.code === 'surau_not_found' ? 404 : e.code === 'not_empty' ? 409 : 400, e.code, e.message);
          throw e;
        }
      }
      case 'surau-prune': {
        const rawHours = args['older-hours'];
        if (rawHours !== undefined && !/^\d{1,5}$/.test(rawHours.trim())) throw new AuthError(400, 'bad_args', 'Guna: surau-prune [--older-hours <n>] [--apply] (n ialah nombor bulat jam)');
        const hours = rawHours === undefined ? 24 : Number(rawHours.trim());
        const done = pruneEmptySuraus(db, {
          now: new Date(),
          olderThanMs: hours * 3_600_000,
          apply: applyFlag,
          backupDir: join(dirname(resolve(args.db)), 'backups'),
          actor: ACTOR,
        });
        if (done.candidates.length === 0) out(`Tiada surau kosong yang lebih tua daripada ${hours} jam`);
        for (const c of done.candidates) {
          const gone = done.deleted.some((d) => d.id === c.id);
          out(`${c.id}  ${shown(c.name)}  dicipta ${c.createdAt}  ${applyFlag ? (gone ? 'dipadam' : 'dilangkau (tidak lagi kosong)') : 'kosong'}`);
        }
        if (!applyFlag && done.candidates.length > 0) out('Hanya senarai (larian kering); guna --apply untuk memadam (sandaran ditulis dahulu)');
        if (done.backup !== null) out(`Sandaran: ${done.backup}`);
        return 0;
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
          bumpVersion(db, LOCAL_SURAU_ID);
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
        const user = listUsers(db, LOCAL_SURAU_ID, true).find((u) => u.id === id);
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
            const mine = listDevices(db, id, { includeStar: true }, LOCAL_SURAU_ID);
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
            logChange(db, ACTOR, 'users', id, { ...snap, hasPin: before.pinHash !== null }, { ...snap, hasPin: false, pinReset: true }, undefined, LOCAL_SURAU_ID);
          } else {
            db.prepare(
              'UPDATE users SET pin_fail_count = 0, pin_locked_until = NULL, lock_round = 0 WHERE id = ?',
            ).run(id);
            logChange(db, ACTOR, 'users', id, { ...snap, locked: before.pinLockedUntil !== null }, { ...snap, locked: false }, undefined, LOCAL_SURAU_ID);
          }
          bumpVersion(db, LOCAL_SURAU_ID);
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
      case 'ops-enrol': {
        const nameArg = args.name;
        if (nameArg === undefined && args.ref === undefined) throw new AuthError(400, 'bad_args', 'Guna: ops-enrol (--name "<nama tepat>" | --ref <ID>) [--device-name "<nama>"]');
        const refId = args.ref === undefined ? null : userIdByRef(db, args.ref, role, LOCAL_SURAU_ID);
        const hits = listUsers(db, LOCAL_SURAU_ID, true).filter((u) => u.active && (refId !== null ? u.id === refId : u.name === nameArg));
        if (hits.length !== 1) {
          throw new AuthError(404, 'user_not_found', hits.length === 0 ? 'Pengguna tidak dijumpai (nama mesti tepat)' : 'Lebih daripada seorang pengguna dengan nama itu');
        }
        const user = hits[0]!;
        // the CLI is the only issuer: ops_by of the device it makes is 'cli'
        const issued = issueOpsEnrolment(db, { userId: user.id, deviceName: args['device-name'] ?? 'Telefon MAXCOM Ops' }, 'cli');
        out(`Kod pendaftaran MAXCOM Ops untuk ${user.name} (ditunjukkan sekali; taip dalam aplikasi MAXCOM Ops):`);
        out(issued.code);
        out(`Sah sehingga ${issued.expiresAt} (10 minit, sekali guna)`);
        return 0;
      }
      case 'support-add': {
        const nameArg = args.name;
        if (nameArg === undefined) throw new AuthError(400, 'bad_args', 'Guna: support-add --name "<nama>" [--device-name "<nama>"]');
        // a brand-new user holds no ops device or open code, so the 3-device limit cannot refuse the first code
        const created = createUserTx(db, nameArg);
        const issued = issueOpsEnrolment(db, { userId: created.id, deviceName: args['device-name'] ?? 'Telefon MAXCOM Ops' }, 'cli');
        authLog(db, new Date(), 'support_add', true, { userId: created.id, detail: 'support_add' });
        out(`Pengguna Sokongan MAXCOM ${created.name} dicipta (id ${created.id}). Kod pendaftaran MAXCOM Ops (ditunjukkan sekali; taip dalam aplikasi MAXCOM Ops):`);
        out(issued.code);
        out(`Sah sehingga ${issued.expiresAt} (10 minit, sekali guna)`);
        return 0;
      }
      case 'support-remove': {
        const userId = args.user;
        if (userId === undefined) throw new AuthError(400, 'bad_args', 'Guna: support-remove --user <id>');
        const user = getUserRow(db, userId);
        if (user === undefined) throw new AuthError(404, 'user_not_found', 'Pengguna tidak dijumpai');
        if (!user.active || !user.roles.includes('support')) throw new AuthError(409, 'not_support', 'Pengguna ini bukan Sokongan MAXCOM');
        const remaining = user.roles.filter((r) => r !== 'support');
        const keepsOps = remaining.includes('superadmin');
        if (remaining.length === 0) {
          deactivateUser(db, userId, 'cli'); // no other role: the user is switched off, every device and session revoked
        } else {
          setRoles(db, userId, remaining, 'cli');
          if (!keepsOps) {
            for (const d of listOpsDevices(db).ops.filter((x) => x.userId === userId)) unmarkOps(db, d.id, 'cli');
          }
        }
        db.prepare('UPDATE enrolments SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(new Date().toISOString(), userId);
        authLog(db, new Date(), 'support_remove', true, { userId, detail: 'support_remove' });
        out(`Peranan Sokongan ${user.name} ditarik balik${remaining.length === 0 ? '; pengguna dinyahaktifkan' : ''}`);
        return 0;
      }
      case 'ops-devices': {
        const { ops, publicOfOpsUsers } = listOpsDevices(db);
        const names = new Map(listUsers(db, LOCAL_SURAU_ID, true).map((u) => [u.id, u.name] as const));
        const line = (d: { id: string; userId: string; name: string; platform: string; lastSeenAt: string | null }): string =>
          `  ${d.id}  ${d.name}  ${d.platform}  pengguna ${names.get(d.userId) ?? d.userId}  kali terakhir ${d.lastSeenAt ?? '-'}`;
        out(`Peranti MAXCOM Ops (${ops.length}):`);
        for (const d of ops) out(line(d));
        out(`Peranti awam pengguna Ops (${publicOfOpsUsers.length}) (batalkan dengan revoke-device <id>):`);
        for (const d of publicOfOpsUsers) out(line(d));
        return 0;
      }
      case 'ops-unmark': {
        const dev = args.device;
        if (dev === undefined) throw new AuthError(400, 'bad_args', 'Guna: ops-unmark --device <id>');
        unmarkOps(db, dev, 'cli');
        out(`Peranti ${dev} kini peranti awam; sesinya ditamatkan`);
        return 0;
      }
      default:
        errOut(`Arahan tidak dikenali: ${command}\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    // the message, then the refusal code as a word a script can match
    errOut(e instanceof AuthError ? `${e.message} (${e.code})` : e instanceof PruneBackupError ? e.message : 'Arahan gagal');
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
