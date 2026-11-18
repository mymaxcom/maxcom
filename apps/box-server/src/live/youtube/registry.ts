import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SURAU_ID_RE } from '@surau/core';
import { secretDir } from '../../auth/secrets.ts';
import { createYoutubeService } from './api.ts';
import type { YoutubeService, YoutubeServiceDeps } from './api.ts';

/**
 * One YouTube sign-in per surau on the cloud (release 2026.11.12, L1). Each surau has its own service: its own
 * sealed token file (`secret/youtube-token-<surauId>.json`), its own open-broadcast record and its own name on the
 * stream. A surau's sign-in, sign-out, broadcasts and uploads never touch another's.
 */
export interface YoutubeRegistry {
  /** The surau's service, made on first use; null for an id that is not a well-formed surau id. */
  for(surauId: string): YoutubeService | null;
  /** Every service made so far (the daily orphan sweep, the shutdown). */
  all(): YoutubeService[];
}

const TOKEN_PREFIX = 'youtube-token-';
const TOKEN_SUFFIX = '.json';

export const tokenFileFor = (surauId: string): string => `${TOKEN_PREFIX}${surauId}${TOKEN_SUFFIX}`;
export const openFileFor = (surauId: string): string => `youtube-open-${surauId}.json`;

export function createYoutubeRegistry(deps: Omit<YoutubeServiceDeps, 'surauId' | 'tokenFile' | 'openFile' | 'role'>): YoutubeRegistry {
  const services = new Map<string, YoutubeService>();
  const secret = secretDir(deps.dataDir);

  // The one shared sign-in this cloud used before is cleared, not handed to any surau: each signs in again.
  for (const f of [join(secret, 'youtube-token.json'), join(secret, 'youtube-token.json.tmp'), join(deps.dataDir, 'live', 'youtube-open.json')]) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* a file that cannot be removed is never read by the per-surau code anyway */
    }
  }

  const make = (surauId: string): YoutubeService => {
    const svc = createYoutubeService({ ...deps, role: 'cloud', surauId, tokenFile: tokenFileFor(surauId), openFile: openFileFor(surauId) });
    services.set(surauId, svc);
    return svc;
  };

  // surau that already signed in: made now, so the orphan sweep and the open-broadcast records cover them from the start
  if (existsSync(secret)) {
    for (const name of readdirSync(secret)) {
      if (!name.startsWith(TOKEN_PREFIX) || !name.endsWith(TOKEN_SUFFIX)) continue;
      const id = name.slice(TOKEN_PREFIX.length, name.length - TOKEN_SUFFIX.length);
      if (SURAU_ID_RE.test(id)) void make(id).recover();
    }
  }

  return {
    for(surauId: string): YoutubeService | null {
      if (!SURAU_ID_RE.test(surauId)) return null;
      const known = services.get(surauId);
      if (known !== undefined) return known;
      const svc = make(surauId);
      void svc.recover();
      return svc;
    },
    all: () => [...services.values()],
  };
}
