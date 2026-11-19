import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSecret, sealSecret } from '../../auth/crypto.ts';
import { loadBoxKey, secretDir } from '../../auth/secrets.ts';
import { deriveYoutubeTokenKey } from './tokenStore.ts';

/**
 * `secret/youtube-client.json`, the operator's OAuth client, kept SEALED at rest with the same key derivation the token
 * file uses (S3). A plaintext file (placed by an operator, or written by an earlier release) is read once and sealed in
 * place. Never logs the content.
 */

const fileOf = (dataDir: string): string => join(secretDir(dataDir), 'youtube-client.json');

function put(dataDir: string, text: string): void {
  const path = fileOf(dataDir);
  mkdirSync(secretDir(dataDir), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, sealSecret(deriveYoutubeTokenKey(loadBoxKey(dataDir)), text), { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* on Windows the folder ACL protects it */
  }
  renameSync(tmp, path);
}

/** The client file as text, or null when there is none or it cannot be read. A plaintext file is re-sealed once. */
export function readClientText(dataDir: string): string | null {
  const path = fileOf(dataDir);
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    try {
      const v: unknown = JSON.parse(raw);
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        try {
          put(dataDir, raw);
        } catch {
          /* kept as it was; sealed on the next read */
        }
        return raw;
      }
    } catch {
      /* not plain JSON: a sealed file */
    }
    return openSecret(deriveYoutubeTokenKey(loadBoxKey(dataDir)), raw.trim());
  } catch {
    return null;
  }
}

/** Seals and keeps the client file. */
export function writeClientText(dataDir: string, text: string): void {
  put(dataDir, text);
}
