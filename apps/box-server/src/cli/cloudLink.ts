import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boxId as boxIdOf } from '../auth/secrets.ts';
import { openDb } from '../db.ts';
import { cloudFetch } from '../sync/agent.ts';
import { parseLinkAnswer, storeLink } from '../sync/linkStore.ts';
import { syncStatus } from '../sync/routes.ts';
import { generateSyncKeyPair, loadSyncKey, normaliseCloudUrl, removeSyncKey } from '../sync/syncKey.ts';
import { parseArgs } from './bootstrap.ts';

const USAGE = [
  'Guna: node apps/box-server/src/cli/cloudLink.ts --data <folder data> [--db <laluan surau.db>] <arahan>',
  '  link <https://alamat-awan> <kod>   pautkan kotak ini ke awan dengan kod sekali guna',
  '  status                              tunjukkan keadaan penyelarasan',
  '  unlink                              buang pautan (kunci tapak dipadam dari kotak ini)',
].join('\n');

export interface CloudLinkIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/**
 * The box side of linking (SECURITY code): make a key pair, redeem the one-time code against the cloud, and
 * seal the answer (site key, wake secret, key pair, address) under `<dataDir>/secret/`. Nothing secret is
 * printed. Returns the process exit code.
 */
export async function runCloudLink(argv: string[], io: CloudLinkIo, fetchImpl?: typeof fetch): Promise<number> {
  const flagArgs: string[] = [];
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      flagArgs.push(a);
      if (argv[i + 1] !== undefined) flagArgs.push(argv[++i]!);
    } else words.push(a);
  }
  let args: Record<string, string>;
  try {
    args = parseArgs(flagArgs);
  } catch (e) {
    io.err(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const [command, urlArg, codeArg] = words;
  if (args.data === undefined || command === undefined) {
    io.err(USAGE);
    return 2;
  }
  const dataDir = resolve(args.data);
  const dbPath = args.db !== undefined ? resolve(args.db) : join(dataDir, 'surau.db');
  try {
    switch (command) {
      case 'link': {
        const url = urlArg === undefined ? null : normaliseCloudUrl(urlArg);
        if (url === null || codeArg === undefined) {
          io.err(`Alamat awan (https) dan kod diperlukan\n${USAGE}`);
          return 2;
        }
        const id = boxIdOf(dataDir);
        const { privateJwk, publicJwk } = generateSyncKeyPair();
        const f = fetchImpl ?? cloudFetch(dataDir);
        let res: Response;
        try {
          res = await f(`${url}/api/sync/link`, {
            method: 'POST',
            redirect: 'manual',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ boxId: id, code: codeArg, publicJwk, name: 'kotak' }),
            signal: AbortSignal.timeout(30_000),
          });
        } catch {
          io.err('Tidak dapat menghubungi awan');
          return 1;
        }
        if (res.status === 401) {
          io.err('Kod tidak sah atau sudah tamat');
          return 1;
        }
        if (res.status === 429) {
          io.err('Terlalu banyak percubaan; cuba lagi sebentar lagi');
          return 1;
        }
        if (res.status !== 200) {
          io.err(`Awan menolak pautan (${res.status})`);
          return 1;
        }
        const j = parseLinkAnswer(await res.json().catch(() => null));
        if (j === null) {
          io.err('Jawapan awan tidak sah');
          return 1;
        }
        const db = openDb(dbPath);
        try {
          storeLink(db, dataDir, { privateJwk, publicJwk, cloudUrl: url, answer: j, enable: 'always' });
        } finally {
          db.close();
        }
        io.out(`Dipautkan ke awan: ${j.name}`);
        if (!j.wakeRegistered) io.out('Nota: awan belum mendaftarkan rahsia bangun pada Worker; penyelarasan berjalan bila awan sedang hidup.');
        return 0;
      }
      case 'status': {
        const key = loadSyncKey(dataDir);
        const db = openDb(dbPath);
        try {
          const s = syncStatus(db, 'box');
          io.out(JSON.stringify({ ...s, linked: key !== null, cloudUrl: key?.cloudUrl ?? s.cloudUrl, siteName: key?.siteName ?? null }));
        } finally {
          db.close();
        }
        return 0;
      }
      case 'unlink': {
        const had = removeSyncKey(dataDir);
        const db = openDb(dbPath);
        try {
          db.prepare("DELETE FROM sync_state WHERE key IN ('linked', 'cloud_url', 'last_error', 'last_push', 'last_pull', 'last_push_seq', 'last_pull_seq', 'pending_out')").run();
        } finally {
          db.close();
        }
        io.out(had ? 'Pautan ke awan dibuang' : 'Kotak ini tidak dipautkan');
        return 0;
      }
      default:
        io.err(`Arahan tidak dikenali: ${command}\n${USAGE}`);
        return 2;
    }
  } catch {
    io.err('Arahan gagal');
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCloudLink(
    process.argv.slice(2),
    { out: (l) => process.stdout.write(l + '\n'), err: (l) => process.stderr.write(l + '\n') },
  ).then((code) => {
    process.exitCode = code;
  });
}
