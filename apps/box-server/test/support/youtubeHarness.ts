import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { LiveGap } from '@surau/core';
import { openDb } from '../../src/db.ts';
import { createYoutubeService } from '../../src/live/youtube/api.ts';
import type { YoutubeService, YoutubeServiceDeps } from '../../src/live/youtube/api.ts';
import { TokenStore } from '../../src/live/youtube/tokenStore.ts';
import type { YoutubeTokens } from '../../src/live/youtube/tokenStore.ts';

/**
 * Test helpers of the YouTube lane (2026.11.15 Siaran langsung revamp): a scripted Google that lives in the test
 * process (no socket), and a box YouTube service over a real database and a real data folder. `liveHarness.ts`
 * belongs to the box live core lane; nothing here changes it.
 *
 * Neutral names only: the channel ids, keys and tokens below are test values.
 */

export const TEST_REFRESH = 'refresh-token-TEST-SECRET';
export const TEST_CHANNEL = 'UC-box-one';

export interface ScriptedCall {
  method: string;
  host: string;
  path: string;
  query: URLSearchParams;
  body: string;
}

export interface ScriptedGoogle {
  fetchImpl: typeof fetch;
  calls: ScriptedCall[];
  /** What `liveStreams?part=status` answers. */
  streamStatus: 'active' | 'inactive' | 'ready';
  health: 'good' | 'ok' | 'bad' | 'noData';
  /** `lifeCycleStatus` of every broadcast. */
  lifeCycle: string;
  /** The channel id `channels?mine=true` answers. */
  channelId: string;
  /** Status of the revoke endpoint (200 = Google confirmed). */
  revokeStatus: number;
  /**
   * Looked at before every default answer: return a `Response` to answer with it, the text `network` for a dead
   * network, an `Error` to throw that very error, or nothing to let the default answer.
   */
  intercept: ((c: ScriptedCall) => Response | Error | 'network' | undefined) | null;
  count(method: string, pathEnd: string): number;
  broadcasts: string[];
}

export const googleJson = (status: number, body: unknown): Response =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A Google error body as the Data API sends it (`error.errors[0].reason`). */
export const googleError = (status: number, reason: string): Response => googleJson(status, { error: { code: status, errors: [{ reason }] } });

export function scriptedGoogle(): ScriptedGoogle {
  let streamN = 0;
  let bcN = 0;
  let accessN = 0;
  const g: ScriptedGoogle = {
    calls: [],
    streamStatus: 'active',
    health: 'good',
    lifeCycle: 'live',
    channelId: TEST_CHANNEL,
    revokeStatus: 200,
    intercept: null,
    broadcasts: [],
    count: (method, pathEnd) => g.calls.filter((c) => c.method === method && c.path.endsWith(pathEnd)).length,
    fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const call: ScriptedCall = { method: (init?.method ?? 'GET').toUpperCase(), host: u.hostname, path: u.pathname, query: u.searchParams, body: typeof init?.body === 'string' ? init.body : '' };
      g.calls.push(call);
      const forced = g.intercept?.(call);
      if (forced === 'network') throw new TypeError('fetch failed');
      if (forced instanceof Error) throw forced;
      if (forced !== undefined) return forced;
      const p = call.path;
      if (p === '/token') return googleJson(200, { access_token: `access-${++accessN}`, expires_in: 3600 });
      if (p === '/revoke') return googleJson(g.revokeStatus, g.revokeStatus === 200 ? {} : { error: 'invalid_token' });
      if (p.endsWith('/channels')) return googleJson(200, { items: [{ id: g.channelId, snippet: { title: 'Surau Contoh' } }] });
      if (p.endsWith('/liveStreams')) {
        if (call.method === 'POST') {
          const id = `st-${++streamN}`;
          return googleJson(200, { id, cdn: { ingestionInfo: { streamName: `key-${streamN}` } } });
        }
        if (call.method === 'DELETE') return googleJson(204, null);
        if (call.query.get('part') === 'cdn') return googleJson(200, { items: [{ cdn: { ingestionInfo: { streamName: 'key-again' } } }] });
        return googleJson(200, { items: [{ status: { streamStatus: g.streamStatus, healthStatus: { status: g.health } } }] });
      }
      if (p.endsWith('/liveBroadcasts/bind') || p.endsWith('/liveBroadcasts/transition')) return googleJson(200, {});
      if (p.endsWith('/liveBroadcasts')) {
        if (call.method === 'POST') {
          const id = `bc-${++bcN}`;
          g.broadcasts.push(id);
          return googleJson(200, { id });
        }
        if (call.method === 'DELETE') return googleJson(204, null);
        return googleJson(200, { items: [{ status: { lifeCycleStatus: g.lifeCycle } }] });
      }
      return googleJson(404, {});
    }) as typeof fetch,
  };
  return g;
}

export interface BoxYoutube {
  svc: YoutubeService;
  g: ScriptedGoogle;
  dir: string;
  db: DatabaseSync;
  /** The service's clock is `Date`: a test moves it with vitest's fake timers, and the timers move with it. */
  now: () => Date;
  /** Every gap the service wrote, with its session id. */
  gaps: Array<{ sessionId: string } & LiveGap>;
  tokenPath: string;
  /** The `youtube` rows of the change log, oldest first. */
  audit(): Array<{ entityId: string; after: Record<string, unknown> }>;
  /** The same data folder with a new service (a box restart). */
  reopen(over?: Partial<YoutubeServiceDeps>): YoutubeService;
  close(): void;
}

const tokens = (now: Date, over: Partial<YoutubeTokens>): YoutubeTokens => ({
  refreshToken: TEST_REFRESH,
  accessToken: 'access-0',
  expiresAt: now.getTime() + 3_600_000,
  channelId: TEST_CHANNEL,
  channelTitle: 'Surau Contoh',
  scope: 'https://www.googleapis.com/auth/youtube',
  streamId: null,
  ...over,
});

/**
 * A box's own YouTube service, signed in (unless `signedIn: false`), with the daily grant look switched off. The
 * health look runs every 10 s and a failed complete is retried every 60 s, on vitest's fake timers. Gaps land in `gaps`.
 */
export function boxYoutube(o: { signedIn?: boolean; token?: Partial<YoutubeTokens>; deps?: Partial<YoutubeServiceDeps>; dir?: string; g?: ScriptedGoogle } = {}): BoxYoutube {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'maxcom-yt-box-'));
  mkdirSync(join(dir, 'secret'), { recursive: true });
  writeFileSync(join(dir, 'secret', 'youtube-client.json'), JSON.stringify({ client_id: 'cid-test.apps.googleusercontent.com', client_secret: 'csecret-TEST' }));
  const now = (): Date => new Date();
  if (o.signedIn !== false) new TokenStore(dir).save(tokens(now(), o.token ?? {}));
  const db = openDb(join(dir, 'surau.db'));
  const g = o.g ?? scriptedGoogle();
  const gaps: BoxYoutube['gaps'] = [];
  const made: YoutubeService[] = [];
  const make = (over: Partial<YoutubeServiceDeps> = {}): YoutubeService => {
    const svc = createYoutubeService({
      db,
      dataDir: dir,
      fetchImpl: g.fetchImpl,
      now,
      role: 'box',
      grantCheck: { off: true },
      sessionStore: { appendGap: (sessionId, gap) => void gaps.push({ sessionId, ...gap }) },
      ...o.deps,
      ...over,
    });
    made.push(svc);
    return svc;
  };
  return {
    svc: make(),
    g,
    dir,
    db,
    now,
    gaps,
    tokenPath: join(dir, 'secret', 'youtube-token.json'),
    audit: () =>
      db
        .prepare("SELECT entity_id, after_json FROM change_log WHERE entity = 'youtube' ORDER BY id")
        .all()
        .map((r) => ({ entityId: String(r.entity_id), after: JSON.parse(String(r.after_json)) as Record<string, unknown> })),
    reopen: (over) => make(over),
    close: () => {
      for (const s of made) s.shutdown();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const META = { title: 'Kuliah Maghrib', description: 'Bab Solat', privacy: 'unlisted' as const };
