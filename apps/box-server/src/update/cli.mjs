import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The installed copy lives in <root>/bin; the box files (box-config.json, current/) are one level up.
const here = dirname(fileURLToPath(import.meta.url));
const root = basename(here).toLowerCase() === 'bin' ? dirname(here) : here;

function readConfig() {
  return JSON.parse(readFileSync(join(root, 'box-config.json'), 'utf8'));
}

function main() {
  console.log("Nota: fail CLI 'owner only' adalah milik pentadbir yang menjalankannya.");
  const name = process.argv[2];
  if (!name || !/^[A-Za-z]+$/.test(name)) {
    console.error('GAGAL: nama CLI tidak sah');
    process.exit(1);
  }
  const cliPath = join(root, 'current', 'apps', 'box-server', 'src', 'cli', `${name}.ts`);
  if (!existsSync(cliPath)) {
    console.error(`GAGAL: CLI ${name} tidak wujud`);
    process.exit(1);
  }
  const config = readConfig();
  const dataDir = config.dataDir;
  const result = spawnSync(process.execPath, [cliPath, ...process.argv.slice(3)], {
    cwd: join(root, 'current'),
    env: {
      ...process.env,
      SURAU_DB: join(dataDir, 'surau.db'),
      SURAU_DATA_DIR: dataDir,
    },
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
