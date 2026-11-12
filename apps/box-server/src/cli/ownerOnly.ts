import { chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Restricts a file or folder to the current user: mode 0600 / 0700 on POSIX, an icacls ACL with
 * inheritance removed on Windows (chmod is a no-op there). Returns false when it could not be
 * applied; callers print a warning rather than fail the whole command.
 */
export function restrictToOwner(path: string, isDir = false): boolean {
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, isDir ? 0o700 : 0o600);
      return true;
    } catch {
      return false;
    }
  }
  const user = process.env.USERNAME;
  if (user === undefined || user === '') return false;
  const domain = process.env.USERDOMAIN;
  const account = domain !== undefined && domain !== '' ? `${domain}\\${user}` : user;
  const grant = isDir ? `${account}:(OI)(CI)F` : `${account}:F`;
  const r = spawnSync('icacls', [path, '/inheritance:r', '/grant:r', grant], { windowsHide: true, encoding: 'utf8' });
  return r.status === 0;
}
