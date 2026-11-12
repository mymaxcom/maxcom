import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Allowlisted SURAU_* keys copied from box-config.json env to the child. */
const ALLOWLIST = new Set([
  'SURAU_PORT',
  'SURAU_HTTPS_PORT',
  'SURAU_ALLOWED_HOSTS',
  'SURAU_ASSETS_MAX_MB',
  'SURAU_FINANCE_PHOTOS_MAX_MB',
  'SURAU_CLOUD_URL',
  'SURAU_WORKER_URL',
]);

/**
 * Base Windows variables copied to the child (matched case-insensitively). Without SystemRoot and
 * friends a Windows Node process cannot start Winsock (DNS fails) or find its temp folders.
 */
const BASE_ENV_KEYS = [
  'SystemRoot', 'SYSTEMROOT', 'windir', 'SystemDrive', 'TEMP', 'TMP', 'ProgramData',
  'ALLUSERSPROFILE', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'COMPUTERNAME', 'USERNAME',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'PATHEXT', 'ComSpec',
];
const BASE_ENV_LOWER = new Set(BASE_ENV_KEYS.map((k) => k.toLowerCase()));

/** Read and validate box-config.json. */
export function readConfig(root) {
  const path = join(root, 'box-config.json');
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${errorMessage(error)}`);
  }
  if (raw.v !== 1) {
    throw new Error(`config v must be 1, got ${raw.v}`);
  }
  if (typeof raw.dataDir !== 'string' || raw.dataDir.trim() === '') {
    throw new Error('dataDir must be a non-empty string');
  }
  if (!isAbsoluteWindowsPath(raw.dataDir)) {
    throw new Error('dataDir must be an absolute path');
  }
  if (typeof raw.env !== 'object' || raw.env === null || Array.isArray(raw.env)) {
    throw new Error('env must be an object');
  }
  for (const key of Object.keys(raw.env)) {
    if (!ALLOWLIST.has(key)) {
      throw new Error(`env key "${key}" is not allowed`);
    }
  }
  return raw;
}

function isAbsoluteWindowsPath(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\/]+[\\/]/.test(p);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Build the child environment from the config and the base env. */
export function childEnv(root, config, baseEnv) {
  const dataDir = config.dataDir;
  const env = {};
  for (const key of Object.keys(baseEnv ?? {})) {
    if (BASE_ENV_LOWER.has(key.toLowerCase()) && typeof baseEnv[key] === 'string') {
      env[key] = baseEnv[key];
    }
  }
  Object.assign(env, {
    SURAU_INSTALL_ROOT: root,
    SURAU_DB: join(dataDir, 'surau.db'),
    SURAU_DATA_DIR: dataDir,
    SURAU_LIVE_TOOLS: join(root, 'tools', 'live'),
  });
  for (const key of Object.keys(config.env ?? {})) {
    if (ALLOWLIST.has(key)) {
      env[key] = config.env[key];
    }
  }
  const systemRoot = baseEnv.SystemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
  env.PATH = `${systemRoot}\\System32;${systemRoot};${systemRoot}\\System32\\WindowsPowerShell\\v1.0`;
  return env;
}

/** How long to wait before restarting after a given exit code. */
export function nextDelayMs(exitCode) {
  return exitCode === 75 ? 0 : 5000;
}

/** Rotate a log file when it exceeds maxBytes, keeping up to keep backups. */
export function rotateLog(path, maxBytes, keep) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size <= maxBytes) return;
  rmSync(`${path}.${keep}`, { force: true });
  for (let i = keep - 1; i >= 1; i--) {
    const src = `${path}.${i}`;
    const dst = `${path}.${i + 1}`;
    if (existsSync(src)) {
      renameSync(src, dst);
    }
  }
  renameSync(path, `${path}.1`);
}

/** 'dead' (no such process), 'alive', or 'unknown' (EPERM: it exists but may not be signalled). */
function processState(pid) {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return error && error.code === 'EPERM' ? 'unknown' : 'dead';
  }
}

function isAlive(pid) {
  return processState(pid) !== 'dead';
}

/** Executable path and command line of a PID via Win32_Process; null when unreadable or gone. */
export function queryProcess(pid) {
  let info = '';
  try {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const ps = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const r = spawnSync(
      ps,
      [
        '-NoProfile', '-NonInteractive', '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { $p.ExecutablePath + '|' + $p.CommandLine }`,
      ],
      { encoding: 'utf8', timeout: 20000, windowsHide: true },
    );
    info = String(r.stdout ?? '').trim();
  } catch {
    info = '';
  }
  const sep = info.indexOf('|');
  if (sep < 0) return null;
  return { exe: info.slice(0, sep), cmd: info.slice(sep + 1) };
}

function normPath(p) {
  return String(p).toLowerCase().replace(/\//g, '\\');
}

/**
 * True only when pid is a live node process running this root's launcher script. A reused PID, a
 * dead PID and a PID we cannot signal (EPERM) are all decided by the process query, never by kill.
 * The query is injectable for tests.
 */
export function isLauncherHolder(pid, launcherScript, execPath = process.execPath, query = queryProcess) {
  if (processState(pid) === 'dead') return false;
  const info = query(pid);
  if (!info) return false;
  return normPath(info.exe) === normPath(execPath) && normPath(info.cmd).includes(normPath(launcherScript));
}

/**
 * Task Scheduler ends the launcher with TerminateProcess (no signal), so the node child can be
 * orphaned. Its PID is kept in box.pid; end it when it is still a node.exe running mainScript.
 * Returns the PID that was ended, or null.
 */
export function reapOrphan(pidFile, mainScript, execPath = process.execPath) {
  let pid;
  try {
    pid = Number(readFileSync(pidFile, 'utf8').trim());
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !isAlive(pid)) {
    rmSync(pidFile, { force: true });
    return null;
  }
  const info = queryProcess(pid);
  const exe = info ? info.exe.toLowerCase() : '';
  const cmd = info ? info.cmd.toLowerCase() : '';
  if (exe === execPath.toLowerCase() && cmd.includes(mainScript.toLowerCase())) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      return null;
    }
    rmSync(pidFile, { force: true });
    return pid;
  }
  // a live process that is not our box (the PID was reused): leave it, drop the stale file
  rmSync(pidFile, { force: true });
  return null;
}

/** Report a launcher error on stderr and, best effort, in %ProgramData%\MAXCOM\launcher-error.log. Never throws. */
export function reportError(msg, env = process.env) {
  const line = `${new Date().toISOString()} ${msg}
`;
  try {
    process.stderr.write(line);
  } catch {
    // nothing to do
  }
  try {
    const programData = env.ProgramData ?? env.PROGRAMDATA;
    if (programData) {
      const dir = join(programData, 'MAXCOM');
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'launcher-error.log'), line);
    }
  } catch {
    // LOCAL SERVICE may not be able to write there either: stderr is enough
  }
}

function makeLinePrefixer(write) {
  let partial = '';
  const stamp = () => `${new Date().toISOString()} `;
  return {
    write(chunk) {
      const text = partial + chunk;
      const lines = text.split('\n');
      partial = lines.pop();
      for (const line of lines) {
        write(stamp() + line + '\n');
      }
    },
    flush() {
      if (partial !== '') {
        write(stamp() + partial + '\n');
        partial = '';
      }
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLoop() {
  const root = dirname(fileURLToPath(import.meta.url));

  let config;
  try {
    config = readConfig(root);
  } catch (error) {
    const msg = `GAGAL config: ${errorMessage(error)}`;
    reportError(msg);
    process.exit(2);
  }

  const dataDir = config.dataDir;
  const logsDir = join(dataDir, 'logs');
  mkdirSync(logsDir, { recursive: true });
  const lockFile = join(logsDir, 'launcher.lock');

  try {
    const text = readFileSync(lockFile, 'utf8').trim();
    const pid = Number(text);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid
      && isLauncherHolder(pid, fileURLToPath(import.meta.url))) {
      console.log(`MAXCOM launcher sudah berjalan (PID ${pid})`);
      process.exit(0);
    }
  } catch {
    // no lock or unreadable: take over
  }
  writeFileSync(lockFile, String(process.pid));

  const pidFile = join(logsDir, 'box.pid');
  const mainScript = join(root, 'current', 'apps', 'box-server', 'src', 'main.ts');
  const reaped = reapOrphan(pidFile, mainScript);
  if (reaped !== null) {
    console.log(`MAXCOM: kotak yatim PID ${reaped} dihentikan`);
  }

  const env = childEnv(root, config, process.env);
  const logPath = join(logsDir, 'box.log');

  let stopping = false;
  let child = null;

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    if (child) {
      child.kill('SIGTERM');
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (!stopping) {
    rotateLog(logPath, 5 * 1024 * 1024, 3);
    const logStream = createWriteStream(logPath, { flags: 'a' });
    const outPrefix = makeLinePrefixer((line) => logStream.write(line));
    const errPrefix = makeLinePrefixer((line) => logStream.write(line));

    let exitCode = 0;
    let exited = false;

    try {
      child = spawn(process.execPath, [mainScript], {
        cwd: join(root, 'current'),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      if (child.pid) {
        try {
          writeFileSync(pidFile, String(child.pid));
        } catch {
          // best effort
        }
      }

      child.stdout.on('data', (chunk) => outPrefix.write(chunk.toString()));
      child.stderr.on('data', (chunk) => errPrefix.write(chunk.toString()));

      exitCode = await new Promise((resolve) => {
        child.on('exit', (code, signal) => {
          exited = true;
          resolve(signal ? 1 : code ?? 0);
        });
        child.on('error', () => {
          if (!exited) {
            exited = true;
            resolve(1);
          }
        });
      });
    } catch (error) {
      logStream.write(`${new Date().toISOString()} GAGAL spawn: ${errorMessage(error)}\n`);
      exitCode = 1;
    }

    outPrefix.flush();
    errPrefix.flush();
    await new Promise((resolve) => logStream.end(resolve));
    child = null;
    rmSync(pidFile, { force: true });

    if (stopping) break;

    const delay = nextDelayMs(exitCode);
    if (delay > 0) {
      await sleep(delay);
    }
  }

  // clean exit: drop the lock (only ours) and the pid file
  rmSync(pidFile, { force: true });
  try {
    if (readFileSync(lockFile, 'utf8').trim() === String(process.pid)) rmSync(lockFile, { force: true });
  } catch {
    // already gone
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLoop().catch((error) => {
    console.error('launcher failed', error);
    process.exit(2);
  });
}