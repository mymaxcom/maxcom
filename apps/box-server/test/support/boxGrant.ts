import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/app.ts';
import type { AppOptions } from '../../src/app.ts';
import { TokenStore } from '../../src/live/youtube/tokenStore.ts';
import type { YoutubeTokens } from '../../src/live/youtube/tokenStore.ts';
import { FAKE_REFRESH } from './fakeGoogle.ts';
import { injectFetch } from './fakeCloud.ts';
import type { TestCloud } from './fakeCloud.ts';

/**
 * A YouTube sign-in held by a BOX (release 2026.11.13; the cloud holds none since 2026.11.15). The sealed token file is
 * the one a box's own sign-in leaves, `secret/youtube-token.json`: the same shape and channel as the fake Google's
 * sign-in gave.
 */
export function seedBoxGrant(dataDir: string, now: () => Date, over: Partial<YoutubeTokens> = {}): void {
  new TokenStore(dataDir).save({
    refreshToken: FAKE_REFRESH,
    accessToken: 'access-token-1',
    expiresAt: now().getTime() + 3_600_000,
    channelId: 'UC-surau',
    channelTitle: 'Surau Contoh',
    scope: 'https://www.googleapis.com/auth/youtube',
    streamId: null,
    ...over,
  });
}

/**
 * A box app (role box) over a temporary data folder; same shape as `buildCloud`, so a test can swap one for the other.
 * `grant` (unless null) is the sign-in the box already holds: written BEFORE the app starts, as the box's service reads
 * its token file when it is made.
 */
export function buildBox(boxId: string, opts: AppOptions = {}, grant: Partial<YoutubeTokens> | null = {}): TestCloud {
  const dir = mkdtempSync(join(tmpdir(), 'surau-box-'));
  if (grant !== null) seedBoxGrant(dir, opts.now ?? (() => new Date()), grant);
  const app = buildApp(join(dir, 'box.db'), { dataDir: dir, role: 'box', boxId, ...opts });
  return {
    app,
    dir,
    fetch: injectFetch(app),
    close: async () => {
      await app.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
