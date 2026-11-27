import { randomBytes } from 'node:crypto';
import { lstatSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { parseLeaveSecret } from './revert.ts';

/** `<data>/secret/leave-secret`: the per-start secret of a Windows follower box, for scripts\leave-surau.ps1. */
export const LEAVE_SECRET_REL = ['secret', 'leave-secret'];

export interface LeaveSecretInput {
  /** The secret given in code (a test or the Android service through the options); wins over everything. */
  configured?: string | undefined;
  /** The process environment: `SURAU_LEAVE_SECRET` is read and then DELETED from it. */
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** The data folder, or null when the box has no real one (a test database in memory). */
  dataDir: string | null;
  log?: (message: string) => void;
}

/**
 * The leave secret of this start (64 hex), or null (both leave routes then refuse, fail closed). SECURITY.
 *
 * - A secret handed in by the Android service (env `SURAU_LEAVE_SECRET`) is used as before. It is removed from
 *   `process.env` the moment it is read, so a child process this box starts (the media server, a tool) never inherits it.
 * - On Windows there is no such service. When the env is absent, the box makes a FRESH secret at every start and writes
 *   it to `<data>/secret/leave-secret`. The `secret` folder carries the installed ACL contract (SYSTEM, Administrators
 *   and the box account only; no Users entry), and the file inherits it, so only an Administrator (or the box itself)
 *   can read it. scripts\leave-surau.ps1, run as Administrator, reads it and calls the loopback route. Nothing is
 *   written when the folder does not exist (this code never creates the folder: a new folder would not carry the
 *   contract) or when the file position holds a link or a folder.
 * - The secret is never logged.
 */
export function resolveLeaveSecret(i: LeaveSecretInput): string | null {
  const log = i.log ?? (() => undefined);
  const fromEnv = i.env.SURAU_LEAVE_SECRET;
  delete i.env.SURAU_LEAVE_SECRET;
  if (i.configured !== undefined) return i.configured;
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
  if (i.platform !== 'win32' || i.dataDir === null) return null;
  try {
    const dir = join(i.dataDir, LEAVE_SECRET_REL[0]!);
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    const file = join(dir, LEAVE_SECRET_REL[1]!);
    const old = lstatOrNull(file);
    if (old !== null) {
      // an old file of a previous start is replaced; a link or a folder in its place is never written through
      if (!old.isFile() || old.isSymbolicLink()) return null;
      unlinkSync(file);
    }
    const secret = randomBytes(32).toString('hex');
    if (parseLeaveSecret(secret) === null) return null;
    writeFileSync(file, `${secret}\n`, { encoding: 'ascii', mode: 0o600, flag: 'wx' });
    return secret;
  } catch (error) {
    log(`leave secret: not written (${(error as Error).name}); a follower cannot leave by itself on this PC`);
    return null;
  }
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}
