import type { DatabaseSync } from 'node:sqlite';
import type { JsonWebKey } from '../auth/crypto.ts';
import { getSettings, putFeature } from '../settingsStore.ts';
import { removeClaim, saveSyncKey } from './syncKey.ts';

/** What the cloud answers to a good `POST /api/sync/link` or `POST /api/sync/claim` (the same body for both). */
export interface LinkAnswer {
  siteToken: string;
  wakeSecret: string;
  name: string;
  wakeRegistered: boolean;
}

/** The answer's fields, or null when it is not a link answer. */
export function parseLinkAnswer(j: unknown): LinkAnswer | null {
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  if (typeof o.siteToken !== 'string' || typeof o.wakeSecret !== 'string' || typeof o.name !== 'string') return null;
  return { siteToken: o.siteToken, wakeSecret: o.wakeSecret, name: o.name, wakeRegistered: o.wakeRegistered === true };
}

/**
 * Store a link the cloud granted (SECURITY code), the one way both the `cloudLink.ts link` command and the automatic
 * link use: the site key, wake secret and key pair sealed in `secret/sync.key`, then `sync_state.linked = 1` and
 * `cloud_url`, the old cursors and error cleared, and `cloudSync` switched on. Nothing is logged.
 */
export function storeLink(
  db: DatabaseSync,
  dataDir: string,
  o: { privateJwk: JsonWebKey; publicJwk: JsonWebKey; cloudUrl: string; answer: LinkAnswer; now?: Date; /** The link command always writes the setting (as it always did); the automatic link only when it is off. */ enable?: 'always' | 'if_off' },
): void {
  saveSyncKey(dataDir, {
    privateJwk: o.privateJwk,
    publicJwk: o.publicJwk,
    cloudUrl: o.cloudUrl,
    siteToken: o.answer.siteToken,
    wakeSecret: o.answer.wakeSecret,
    siteName: o.answer.name,
    linkedAt: (o.now ?? new Date()).toISOString(),
  });
  db.prepare("INSERT INTO sync_state (key, value) VALUES ('linked', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  db.prepare("INSERT INTO sync_state (key, value) VALUES ('cloud_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(o.cloudUrl);
  db.prepare("DELETE FROM sync_state WHERE key IN ('last_error', 'last_push_seq', 'last_pull_seq')").run();
  // the automatic link's own state (register.ts: cadence stamps, claim code)
  db.prepare("DELETE FROM sync_state WHERE key LIKE 'autolink\\_%' ESCAPE '\\'").run();
  if (o.enable === 'always' || getSettings(db).cloudSync.enabled !== true) putFeature(db, 'cloudSync', { enabled: true }, 'local');
  // an automatic link's claim secret has done its job (a manual link makes it moot too)
  removeClaim(dataDir);
}
