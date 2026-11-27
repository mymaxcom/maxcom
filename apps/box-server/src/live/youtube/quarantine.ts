import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SURAU_ID_RE } from '@surau/core';
import { secretDir } from '../../auth/secrets.ts';

/**
 * Before release 2026.11.13 the cloud held each surau's YouTube sign-in and, when a box took it over, kept a sealed copy
 * of the file for 7 days in `secret/quarantine/`. The cloud makes no such copy any more; this only lets a copy that is
 * still there expire on its own, or go at once when a person signs out at the box (Y7). Nothing here reads a token.
 */
export const QUARANTINE_MS = 7 * 24 * 3_600_000;

/**
 * Cloud start only: removes the old SHARED sign-in an early release kept on the cloud (`youtube-token.json`, its
 * `.tmp` and the open-broadcast record; never handed to any surau), then deletes quarantine copies older than 7 days.
 * Never throws.
 */
export function sweepQuarantine(dataDir: string, nowMs: number = Date.now()): void {
  for (const f of [join(secretDir(dataDir), 'youtube-token.json'), join(secretDir(dataDir), 'youtube-token.json.tmp'), join(dataDir, 'live', 'youtube-open.json')]) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* a file that cannot be removed is never read by anything on the cloud */
    }
  }
  try {
    const dir = join(secretDir(dataDir), 'quarantine');
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
 * Y7: a person signed out of YouTube at the surau's box. Whatever an earlier release left of that surau's grant on the
 * cloud goes for good: a token file, its open-broadcast record and every quarantine copy. Files only: Google is never
 * asked to revoke anything from here (the box's own sign-out asked for that). Never throws.
 */
export function wipeOldGrantCopies(dataDir: string, surauId: string): void {
  if (!SURAU_ID_RE.test(surauId)) return;
  const token = join(secretDir(dataDir), `youtube-token-${surauId}.json`);
  try {
    const dir = join(secretDir(dataDir), 'quarantine');
    const prefix = `youtube-token-${surauId}.json.`;
    if (existsSync(dir)) for (const name of readdirSync(dir)) if (name.startsWith(prefix)) rmSync(join(dir, name), { force: true });
  } catch {
    /* the sweep removes what is left after 7 days */
  }
  for (const f of [token, `${token}.tmp`, join(dataDir, 'live', `youtube-open-${surauId}.json`)]) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* a file that cannot be removed is never read by anything */
    }
  }
}
