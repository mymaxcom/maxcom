import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SURAU_ID_RE } from '@surau/core';
import { secretDir } from '../../auth/secrets.ts';
import { createYoutubeService } from './api.ts';
import type { YoutubeService, YoutubeServiceDeps } from './api.ts';

/**
 * One YouTube sign-in per surau on the cloud (release 2026.11.12, L1). Each surau has its own service: its own
 * sealed token file (`secret/youtube-token-<surauId>.json`), its own open-broadcast record and its own name on the
 * stream. A surau's sign-in, sign-out, broadcasts and uploads never touch another's.
 *
 * Release 2026.11.13: the grant is held by the surau's BOX. The cloud no longer signs in (its sign-in routes answer
 * `youtube_at_box`), so a service exists only for a surau whose grant the cloud still holds from before: it serves an
 * old box's live and an old app's upload until the box takes the grant over (`youtubeBoxCloud.ts`), then it is
 * dropped and its files deleted WITHOUT a revoke at Google. Phase 4 removes this file.
 */
export interface YoutubeRegistry {
  /**
   * The surau's service while the cloud still holds that surau's grant from before (its token file is there); null
   * otherwise, and for an id that is not a well-formed surau id. No new grant can be made through it.
   */
  for(surauId: string): YoutubeService | null;
  /** Every service made so far (the daily orphan sweep, the shutdown). */
  all(): YoutubeService[];
  /**
   * The grant moved to the box (or Google had already withdrawn it): the service stops and is forgotten, and the
   * token file and the open-broadcast record are DELETED. Never a revoke at Google: that would end the box's copy too.
   */
  retire(surauId: string): void;
}

const TOKEN_PREFIX = 'youtube-token-';
const TOKEN_SUFFIX = '.json';

export const tokenFileFor = (surauId: string): string => `${TOKEN_PREFIX}${surauId}${TOKEN_SUFFIX}`;
export const openFileFor = (surauId: string): string => `youtube-open-${surauId}.json`;

/** True while the cloud still holds that surau's grant from before release 2026.11.13 (the file exists; it is not read). */
export function cloudHoldsGrant(dataDir: string, surauId: string): boolean {
  return SURAU_ID_RE.test(surauId) && existsSync(join(secretDir(dataDir), tokenFileFor(surauId)));
}

/** How long a retired grant's sealed copy is kept (S2), in case the box's word was wrong. */
export const QUARANTINE_MS = 7 * 24 * 3_600_000;
const quarantineDir = (dataDir: string): string => join(secretDir(dataDir), 'quarantine');

/** Deletes quarantine copies older than 7 days. Never throws. */
export function sweepQuarantine(dataDir: string, nowMs: number = Date.now()): void {
  try {
    const dir = quarantineDir(dataDir);
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const f = join(dir, name);
      try {
        if (nowMs - statSync(f).mtimeMs > QUARANTINE_MS) rmSync(f, { force: true });
      } catch {
        /* a file that cannot be looked at stays for the next sweep */
      }
    }
  } catch {
    /* nothing to sweep */
  }
}

/**
 * Deletes a surau's cloud grant and open-broadcast record. Files only: Google is never asked to revoke anything.
 * The sealed token file (only that, never an opened token) is first copied to `secret/quarantine/` for 7 days (S2).
 */
export function deleteCloudGrant(dataDir: string, surauId: string): void {
  if (!SURAU_ID_RE.test(surauId)) return;
  const token = join(secretDir(dataDir), tokenFileFor(surauId));
  try {
    if (existsSync(token)) {
      const dir = quarantineDir(dataDir);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      copyFileSync(token, join(dir, `${tokenFileFor(surauId)}.${Date.now()}`));
    }
  } catch {
    /* a copy that cannot be made never blocks the retirement */
  }
  sweepQuarantine(dataDir);
  for (const f of [token, `${token}.tmp`, join(dataDir, 'live', openFileFor(surauId))]) rmSync(f, { force: true });
}

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

  sweepQuarantine(deps.dataDir);

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
      // no grant from before: nothing to serve (the cloud makes no new grant)
      if (!cloudHoldsGrant(deps.dataDir, surauId)) return null;
      const svc = make(surauId);
      void svc.recover();
      return svc;
    },
    all: () => [...services.values()],
    retire(surauId: string): void {
      const svc = services.get(surauId);
      if (svc !== undefined) {
        // stops the timers only: `shutdown` never calls Google (sign-out, which revokes, is never called here)
        svc.shutdown();
        services.delete(surauId);
      }
      deleteCloudGrant(deps.dataDir, surauId);
    },
  };
}
