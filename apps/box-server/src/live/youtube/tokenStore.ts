import { hkdfSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSecret, sealSecret } from '../../auth/crypto.ts';
import { loadBoxKey, secretDir } from '../../auth/secrets.ts';

/** What is kept for the box's YouTube sign-in. Sealed on disk, never logged, never sent to a client. */
export interface YoutubeTokens {
  refreshToken: string;
  accessToken: string;
  /** Epoch milliseconds at which the access token stops working. */
  expiresAt: number;
  channelId: string;
  channelTitle: string;
  scope: string;
  /** The reusable liveStream id (the stream KEY is never stored). */
  streamId: string | null;
}

/** Key for the token file: HKDF of the box master key, a separate domain from every other use of it. */
export function deriveYoutubeTokenKey(boxKey: Buffer): Buffer {
  if (!Buffer.isBuffer(boxKey) || boxKey.length !== 32) throw new Error('youtube: bad key');
  return Buffer.from(hkdfSync('sha256', boxKey, Buffer.alloc(0), 'youtube-token', 32));
}

const isStr = (v: unknown): v is string => typeof v === 'string';

function parseTokens(text: string): YoutubeTokens | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isStr(o.refreshToken) || o.refreshToken === '' || !isStr(o.accessToken) || typeof o.expiresAt !== 'number' || !Number.isFinite(o.expiresAt)) return null;
  return {
    refreshToken: o.refreshToken,
    accessToken: o.accessToken,
    expiresAt: o.expiresAt,
    channelId: isStr(o.channelId) ? o.channelId : '',
    channelTitle: isStr(o.channelTitle) ? o.channelTitle : '',
    scope: isStr(o.scope) ? o.scope : '',
    streamId: isStr(o.streamId) && o.streamId !== '' ? o.streamId : null,
  };
}

/** `<dataDir>/secret/youtube-token.json`, AES-256-GCM sealed. A file that does not open reads as signed out. */
export class TokenStore {
  private readonly path: string;
  private readonly dir: string;
  private readonly key: Buffer;

  constructor(dataDir: string) {
    this.dir = secretDir(dataDir);
    this.path = join(this.dir, 'youtube-token.json');
    this.key = deriveYoutubeTokenKey(loadBoxKey(dataDir));
  }

  load(): YoutubeTokens | null {
    if (!existsSync(this.path)) return null;
    try {
      return parseTokens(openSecret(this.key, readFileSync(this.path, 'utf8').trim()));
    } catch {
      console.warn('youtube: token file cannot be opened, treated as signed out (reason: token_unreadable)');
      return null;
    }
  }

  save(tokens: YoutubeTokens): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, sealSecret(this.key, JSON.stringify(tokens)), { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* unsupported filesystem; on Windows the folder ACL protects it */
    }
    renameSync(tmp, this.path);
  }

  clear(): void {
    rmSync(this.path, { force: true });
    rmSync(`${this.path}.tmp`, { force: true });
  }
}
