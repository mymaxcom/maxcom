import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { YoutubeLastGood } from '@surau/core';
import { secretDir } from '../../auth/secrets.ts';

/**
 * What the box remembers about the YouTube sign-in across restarts (not a secret: a channel name and dates, no token).
 *  - `lastGood`: the last time the sign-in was seen working, so a status that cannot be sure still names the channel.
 *  - `out`: why and when the sign-in ended (`invalid_grant` = Google withdrew the grant; `signed_out` = a person
 *    signed out). Only these two end a sign-in; a network error or a 5xx never writes here.
 */
export interface YoutubeState {
  lastGood: YoutubeLastGood | null;
  out: { at: string; reason: 'invalid_grant' | 'signed_out' } | null;
}

const EMPTY: YoutubeState = { lastGood: null, out: null };

const iso = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

function parse(text: string): YoutubeState {
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== 'object' || v === null) return { ...EMPTY };
    const o = v as Record<string, unknown>;
    let lastGood: YoutubeLastGood | null = null;
    const g = o.lastGood;
    if (typeof g === 'object' && g !== null && iso((g as { at?: unknown }).at)) {
      const t = (g as { channelTitle?: unknown }).channelTitle;
      lastGood = { signedIn: true, channelTitle: typeof t === 'string' && t !== '' ? t.slice(0, 100) : null, at: (g as { at: string }).at };
    }
    let out: YoutubeState['out'] = null;
    const x = o.out;
    if (typeof x === 'object' && x !== null && iso((x as { at?: unknown }).at)) {
      const r = (x as { reason?: unknown }).reason;
      if (r === 'invalid_grant' || r === 'signed_out') out = { at: (x as { at: string }).at, reason: r };
    }
    return { lastGood, out };
  } catch {
    return { ...EMPTY };
  }
}

/** `<dataDir>/secret/youtube-state.json` (the cloud keeps one per surau). Writes never throw: a full disk must not break a live. */
export class YoutubeStateStore {
  private readonly path: string;
  private readonly dir: string;

  constructor(dataDir: string, fileName = 'youtube-state.json') {
    this.dir = secretDir(dataDir);
    this.path = join(this.dir, fileName);
  }

  load(): YoutubeState {
    try {
      if (!existsSync(this.path)) return { ...EMPTY };
      return parse(readFileSync(this.path, 'utf8'));
    } catch {
      return { ...EMPTY };
    }
  }

  save(state: YoutubeState): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch {
      /* the memory of a sign-in is a convenience; the live goes on */
    }
  }

  clear(): void {
    try {
      rmSync(this.path, { force: true });
      rmSync(`${this.path}.tmp`, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** The state file name that goes with a token file name (`youtube-token-x.json` to `youtube-state-x.json`). */
export function stateFileFor(tokenFile: string | undefined): string {
  if (tokenFile === undefined) return 'youtube-state.json';
  return tokenFile.replace(/^youtube-token/, 'youtube-state');
}
