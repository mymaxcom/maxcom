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

let cachedBuild: number | undefined;

/** The internal build (0 to 9) of this release from `release.json`; 0 for a checkout or an archive that has none. */
export function boxBuild(): number {
  if (cachedBuild !== undefined) return cachedBuild;
  try {
    const b = (JSON.parse(readFileSync(resolve(import.meta.dirname, '..', '..', '..', 'release.json'), 'utf8')) as { build?: unknown }).build;
    cachedBuild = typeof b === 'number' && Number.isInteger(b) && b >= 0 && b <= 9 ? b : 0;
  } catch {
    cachedBuild = 0;
  }
  return cachedBuild;
}

/** `<version>;b<build>`: what this process says about itself to its peer (header `X-Maxcom-Server`) and keys re-tries on. */
export function softwareToken(): string {
  return `${boxVersion()};b${boxBuild()}`;
}
