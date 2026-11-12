import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { sha256hex } from './crypto.ts';

const KEY_BYTES = 32;

export function secretDir(dataDir: string): string {
  return join(dataDir, 'secret');
}

function keyPath(dataDir: string): string {
  return join(secretDir(dataDir), 'box.key');
}

function restrict(path: string, mode: number): void {
  try {
    chmodSync(path, mode); // best effort; on Windows the ACL is set by scripts/box-ca.ps1
  } catch {
    /* unsupported filesystem */
  }
}

/**
 * The box's master key (32 random bytes). Created on first call with exclusive create and mode
 * 0600. An existing file of the wrong size is an error, never silently replaced: replacing it
 * would orphan every sealed secret and change the box id.
 */
export function loadBoxKey(dataDir: string): Buffer {
  const dir = secretDir(dataDir);
  const path = keyPath(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrict(dir, 0o700);
  if (!existsSync(path)) {
    const key = randomBytes(KEY_BYTES);
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeSync(fd, key);
      } finally {
        closeSync(fd);
      }
      restrict(path, 0o600);
      return key;
    } catch (e) {
      // lost a creation race: fall through and read the winner's file
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('box key: cannot create');
    }
  }
  const key = readFileSync(path);
  if (key.length !== KEY_BYTES) throw new Error('box key: file has the wrong size');
  return key;
}

/** Public identifier of this box (first 16 hex of sha256 of the key); safe to put in payloads. */
export function boxId(dataDir: string): string {
  return sha256hex(loadBoxKey(dataDir)).slice(0, 16);
}
