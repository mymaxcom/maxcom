import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const VERSION_RE = /^20[0-9]{2}\.(0[1-9]|1[0-2])\.([1-9]|[1-9][0-9])$/;

function readVersion(file: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' && VERSION_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

let cached: string | undefined;

/**
 * The version of the MAX Kiosk Server this process runs (YYYY.MM.N).
 *
 * A release archive carries `release.json` at its root (written by scripts/build-release.ps1 from versions.json,
 * a different version for the Windows and the Android server); this file sits at `<root>/apps/box-server/src`.
 * A development checkout has no release.json, so it falls back to this package's own version, and to
 * `0.0.0` when neither is readable.
 */
export function boxVersion(): string {
  if (cached !== undefined) return cached;
  const root = resolve(import.meta.dirname, '..', '..', '..');
  cached = readVersion(resolve(root, 'release.json')) ?? readVersion(resolve(import.meta.dirname, '..', 'package.json')) ?? '0.0.0';
  return cached;
}
