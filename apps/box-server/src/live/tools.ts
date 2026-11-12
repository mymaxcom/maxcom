import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type LiveToolName = 'mediamtx' | 'ffmpeg';

export interface LiveToolVersion {
  version: string;
  url: string;
  sha256: string;
  licence: string;
  date: string;
}

export interface LiveTools {
  /** Absolute path of mediamtx.exe, or null when it is not installed. */
  mediamtx: string | null;
  /** Absolute path of ffmpeg.exe, or null when it is not installed. */
  ffmpeg: string | null;
  /** From VERSIONS.md (written by scripts/install-live-tools.ps1); null when absent or unreadable. */
  versions: Partial<Record<LiveToolName, LiveToolVersion>> | null;
  missing: LiveToolName[];
  /** The MediaMTX version VERSIONS.md records when it is older than MIN_MEDIAMTX_VERSION; null when fine or unknown. */
  mediamtxTooOld: string | null;
}

/** The oldest MediaMTX the config template works with (it uses v1.21 keys such as `moq`). */
export const MIN_MEDIAMTX_VERSION = 'v1.21.0';

function versionParts(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `recorded` parses and is older than MIN_MEDIAMTX_VERSION. An unreadable version is not blocked here. */
export function mediamtxVersionTooOld(recorded: string): boolean {
  const a = versionParts(recorded);
  const b = versionParts(MIN_MEDIAMTX_VERSION);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  }
  return false;
}

const EXE_SUFFIX = process.platform === 'win32' ? '.exe' : '';

function parseVersions(text: string): LiveTools['versions'] {
  const out: Partial<Record<LiveToolName, LiveToolVersion>> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 6) continue;
    const [name, version, url, sha256, licence, date] = cells as [string, string, string, string, string, string];
    if ((name !== 'mediamtx' && name !== 'ffmpeg') || !/^[0-9a-fA-F]{64}$/.test(sha256)) continue;
    out[name] = { version, url, sha256: sha256.toLowerCase(), licence, date };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Finds the live tools under `dir` (default layout: mediamtx/mediamtx.exe, ffmpeg/ffmpeg.exe). Never throws. */
export function liveTools(dir: string): LiveTools {
  const find = (name: LiveToolName): string | null => {
    const path = join(dir, name, `${name}${EXE_SUFFIX}`);
    // the install script always writes .exe; a stub with that name is accepted on any platform (tests)
    if (existsSync(path)) return path;
    const exe = join(dir, name, `${name}.exe`);
    return existsSync(exe) ? exe : null;
  };
  const mediamtx = find('mediamtx');
  const ffmpeg = find('ffmpeg');
  let versions: LiveTools['versions'] = null;
  try {
    versions = parseVersions(readFileSync(join(dir, 'VERSIONS.md'), 'utf8'));
  } catch {
    versions = null;
  }
  const missing: LiveToolName[] = [];
  if (mediamtx === null) missing.push('mediamtx');
  if (ffmpeg === null) missing.push('ffmpeg');
  const recorded = versions?.mediamtx?.version;
  const mediamtxTooOld = recorded !== undefined && mediamtxVersionTooOld(recorded) ? recorded : null;
  return { mediamtx, ffmpeg, versions, missing, mediamtxTooOld };
}
