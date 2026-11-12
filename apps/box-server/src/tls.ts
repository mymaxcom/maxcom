import { X509Certificate, createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { createSecureContext } from 'node:tls';
import type { SecureContextOptions } from 'node:tls';
import { dirname, join, resolve } from 'node:path';

export interface TlsMaterial {
  mode: 'ip' | 'domain';
  /** IP mode: the PFX bytes. Domain mode: empty (use cert and key). */
  pfx: Buffer;
  /** IP mode: the PFX passphrase. Domain mode: empty string. Never log this. */
  passphrase: string;
  /** Domain mode only: PEM certificate chain and private key. */
  cert?: Buffer;
  key?: Buffer;
  notAfter: Date;
  ipSan: string[];
  dnsSan: string[];
}

export interface CertInfo {
  mode: 'ip' | 'domain';
  notAfter: string;
  daysLeft: number;
  ipSan: string[];
}

const DAY_MS = 86_400_000;

function parseSan(san: string | undefined): { ipSan: string[]; dnsSan: string[] } {
  const ipSan: string[] = [];
  const dnsSan: string[] = [];
  for (const part of (san ?? '').split(/,\s*/)) {
    if (part.startsWith('IP Address:')) ipSan.push(part.slice('IP Address:'.length).trim());
    else if (part.startsWith('DNS:')) dnsSan.push(part.slice('DNS:'.length).trim());
  }
  return { ipSan, dnsSan };
}

function readIfExists(path: string): Buffer | null {
  return existsSync(path) ? readFileSync(path) : null;
}

function checkExpiry(notAfter: Date, now: Date): void {
  if (notAfter.getTime() < now.getTime()) {
    throw new Error(`TLS certificate expired on ${notAfter.toISOString()}; run scripts/box-ca.ps1 -Renew`);
  }
}

/**
 * Loads the box TLS material from `<dataDir>/secret` and `<dataDir>/pki`.
 * Returns null when nothing is configured (the caller must then serve loopback only,
 * never LAN HTTP). Throws when the material is present but unusable.
 */
export function loadTls(dataDir: string, now: Date = new Date()): TlsMaterial | null {
  const secretDir = join(dataDir, 'secret');

  const modeFile = readIfExists(join(secretDir, 'tls.json'));
  if (modeFile) {
    let cfg: unknown;
    try {
      cfg = JSON.parse(modeFile.toString('utf8'));
    } catch {
      throw new Error('tls.json is not valid JSON');
    }
    const c = cfg as { mode?: unknown; certFile?: unknown; keyFile?: unknown };
    if (c && c.mode === 'domain') {
      if (typeof c.certFile !== 'string' || typeof c.keyFile !== 'string') {
        throw new Error('tls.json domain mode needs certFile and keyFile');
      }
      const cert = readIfExists(c.certFile);
      const key = readIfExists(c.keyFile);
      if (!cert || !key) return null;
      const x509 = new X509Certificate(cert);
      const notAfter = new Date(x509.validTo);
      checkExpiry(notAfter, now);
      return { mode: 'domain', pfx: Buffer.alloc(0), passphrase: '', cert, key, notAfter, ...parseSan(x509.subjectAltName) };
    }
  }

  const pfx = readIfExists(join(secretDir, 'box.pfx'));
  const passRaw = readIfExists(join(secretDir, 'pfx.pass'));
  const leaf = readIfExists(join(dataDir, 'pki', 'box-leaf.cer'));
  if (!pfx && leaf) {
    // Boxes without a PFX (Android): the leaf key is a PKCS#8 PEM next to the leaf certificate.
    const keyPem = readIfExists(join(secretDir, 'box-key.pem'));
    if (keyPem) {
      // box-leaf.cer may be DER (as on Windows) or PEM; the TLS stack wants PEM.
      const x509 = new X509Certificate(leaf);
      const certPem = Buffer.from(x509.toString(), 'utf8');
      try {
        createSecureContext({ cert: certPem, key: keyPem });
      } catch {
        // Never include the underlying message: it can carry key material details.
        throw new Error('TLS key does not match the certificate');
      }
      const notAfter = new Date(x509.validTo);
      checkExpiry(notAfter, now);
      return { mode: 'ip', pfx: Buffer.alloc(0), passphrase: '', cert: certPem, key: keyPem, notAfter, ...parseSan(x509.subjectAltName) };
    }
  }
  if (!pfx || !passRaw || !leaf) return null;
  const passphrase = passRaw.toString('utf8').trim();

  try {
    createSecureContext({ pfx, passphrase });
  } catch {
    // Do not include the underlying message: it must never echo the passphrase.
    throw new Error('TLS PFX could not be opened: wrong passphrase or corrupt file');
  }

  const x509 = new X509Certificate(leaf);
  const notAfter = new Date(x509.validTo);
  checkExpiry(notAfter, now);
  return { mode: 'ip', pfx, passphrase, notAfter, ...parseSan(x509.subjectAltName) };
}

export function certInfo(t: TlsMaterial, now: Date = new Date()): CertInfo {
  return {
    mode: t.mode,
    notAfter: t.notAfter.toISOString(),
    daysLeft: Math.floor((t.notAfter.getTime() - now.getTime()) / DAY_MS),
    ipSan: t.ipSan,
  };
}

/** A warning line for startup logs when the certificate is close to expiry, else null. */
export function expiryWarning(t: TlsMaterial, now: Date = new Date()): string | null {
  const { daysLeft } = certInfo(t, now);
  return daysLeft < 30 ? `TLS certificate expires in ${daysLeft} days: run scripts/box-ca.ps1 -Renew` : null;
}

/** What `setSecureContext` needs from the HTTPS server (an https.Server satisfies it). */
export interface ReloadableServer {
  setSecureContext(options: SecureContextOptions): void;
}

export type ReloadResult = 'unchanged' | 'reloaded' | 'invalid';

export interface CertReloader {
  /** Re-reads the certificate files now; a changed, valid set replaces the serving context. */
  check(): ReloadResult;
  /** The material the server is serving right now. */
  current(): TlsMaterial;
  stop(): void;
}

export interface CertReloadOptions {
  server: ReloadableServer;
  dataDir: string;
  /** What the server started with. */
  current: TlsMaterial;
  /** Protocol and cipher settings applied again with every new context. */
  baseOptions: SecureContextOptions;
  /** Default one hour. */
  intervalMs?: number;
  now?: () => Date;
  warn?: (message: string) => void;
  onReload?: (next: TlsMaterial) => void;
}

function materialKey(t: TlsMaterial): string {
  const h = createHash('sha256');
  for (const part of [t.pfx, t.cert ?? Buffer.alloc(0), t.key ?? Buffer.alloc(0)]) {
    h.update(String(part.length)).update(':').update(part);
  }
  return h.digest('hex');
}

/**
 * Keeps the HTTPS server on the newest valid certificate: every `intervalMs` the files are loaded
 * again (same checks as at start-up: PFX opens, not expired); a changed set replaces the serving
 * context for new connections, an unusable one is ignored with a warning (once per distinct
 * problem) and the old context stays. The renewal job (scripts/box-cert-renew.ps1) writes the files;
 * no restart is needed. The warnings never contain the passphrase.
 */
export function startCertReload(o: CertReloadOptions): CertReloader {
  const now = o.now ?? ((): Date => new Date());
  const warn = o.warn ?? ((m: string): void => console.warn(m));
  let current = o.current;
  let currentKey = materialKey(current);
  let lastProblem = '';

  const problem = (message: string): ReloadResult => {
    if (message !== lastProblem) warn(`WARNING: the renewed TLS certificate was not used (${message}); the box keeps serving the previous one`);
    lastProblem = message;
    return 'invalid';
  };

  const check = (): ReloadResult => {
    let next: TlsMaterial | null;
    try {
      next = loadTls(o.dataDir, now());
    } catch (error) {
      return problem(error instanceof Error ? error.message : 'unreadable');
    }
    if (next === null) return problem('certificate files are missing');
    if (next.mode !== current.mode) return problem('the TLS mode changed; restart the box');
    const nextKey = materialKey(next);
    if (nextKey === currentKey) {
      lastProblem = '';
      return 'unchanged';
    }
    try {
      o.server.setSecureContext(
        next.pfx.length > 0
          ? { ...o.baseOptions, pfx: next.pfx, passphrase: next.passphrase }
          : { ...o.baseOptions, cert: next.cert, key: next.key },
      );
    } catch {
      return problem('the new certificate could not be loaded');
    }
    current = next;
    currentKey = nextKey;
    lastProblem = '';
    // a callback can never kill the process: this runs from a timer, outside any request
    try {
      o.onReload?.(next);
    } catch (error) {
      warn(`WARNING: the TLS reload callback failed (${error instanceof Error ? error.message : 'error'}); the new certificate is in use`);
    }
    return 'reloaded';
  };

  const timer = setInterval(check, o.intervalMs ?? 3_600_000);
  timer.unref();
  return { check, current: () => current, stop: () => clearInterval(timer) };
}

export interface PkiStatus {
  leafNotAfter: string | null;
  leafDaysLeft: number | null;
  rootNotAfter: string | null;
  lastRenewAttempt?: string;
  lastRenewOk?: boolean;
}

function certNotAfter(path: string): Date | null {
  try {
    const d = new Date(new X509Certificate(readFileSync(path)).validTo);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/** mtime of a regular file at exactly `path`; null if missing, unreadable or a symlink (never followed). */
function plainFileMtime(path: string): number | null {
  try {
    const st = lstatSync(path);
    return st.isFile() && !st.isSymbolicLink() ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

/** The renewal log to read: the newer of the two candidate paths that exist; the parent one wins a tie. */
function certRenewLogPath(dataDir: string): string | null {
  const parentLog = join(dirname(resolve(dataDir)), 'logs', 'cert-renew.log');
  const oldLog = join(dataDir, 'logs', 'cert-renew.log');
  const parentTime = plainFileMtime(parentLog);
  const oldTime = plainFileMtime(oldLog);
  if (parentTime === null && oldTime === null) return null;
  if (oldTime === null) return parentLog;
  if (parentTime === null) return oldLog;
  return parentTime >= oldTime ? parentLog : oldLog;
}

/**
 * Certificate health for the admin warning in the app: the leaf and root expiry read from the files
 * on disk (so a renewal shows at once) and the outcome of the last renewal that did something,
 * taken from the newer of `<dataDir>/logs/cert-renew.log` and `<parent of dataDir>/logs/cert-renew.log`
 * (installed Windows boxes log to the latter; lines `<ISO time> SKIP|RENEWED|FAIL <message>`).
 * Every part tolerates a missing or unreadable file.
 */
export function pkiStatus(dataDir: string, now: Date = new Date()): PkiStatus {
  const leaf = certNotAfter(join(dataDir, 'pki', 'box-leaf.cer'));
  const root = certNotAfter(join(dataDir, 'pki', 'root-ca.cer'));
  const status: PkiStatus = {
    leafNotAfter: leaf ? leaf.toISOString() : null,
    leafDaysLeft: leaf ? Math.floor((leaf.getTime() - now.getTime()) / DAY_MS) : null,
    rootNotAfter: root ? root.toISOString() : null,
  };
  try {
    const logPath = certRenewLogPath(dataDir);
    if (!logPath) return status;
    const lines = readFileSync(logPath, 'utf8').split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /^(\S+) (RENEWED|FAIL)\b/.exec(lines[i]!);
      if (!m) continue;
      const at = new Date(m[1]!);
      if (Number.isNaN(at.getTime())) continue;
      status.lastRenewAttempt = at.toISOString();
      status.lastRenewOk = m[2] === 'RENEWED';
      break;
    }
  } catch {
    // No log yet.
  }
  return status;
}
