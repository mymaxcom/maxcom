import { tokenFileFor } from '../../src/live/youtube/registry.ts';
import { TokenStore } from '../../src/live/youtube/tokenStore.ts';
import type { YoutubeTokens } from '../../src/live/youtube/tokenStore.ts';
import { FAKE_REFRESH } from './fakeGoogle.ts';

/**
 * A grant the cloud holds from before release 2026.11.13 (when the cloud itself signed in). The cloud makes no new
 * grant now, so a test of the old cloud paths (an old box's live leg, an old app's upload, the handover) writes the
 * sealed token file the old sign-in left: the same shape and channel as the fake Google's sign-in gave.
 */
export function seedCloudGrant(cloudDir: string, now: () => Date, surauId = 'sdm', over: Partial<YoutubeTokens> = {}): void {
  new TokenStore(cloudDir, tokenFileFor(surauId)).save({
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
