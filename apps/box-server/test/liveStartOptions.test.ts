import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { LiveError, parseStartRequest } from '../src/live/sessions.ts';
import type { LiveSessionStore } from '../src/live/sessionStore.ts';
import { registerYoutubeRoutes } from '../src/live/youtube/routes.ts';

const BASE = { kuliahId: null, source: 'android', outputs: { kiosk: true, youtube: false }, youtubeVia: 'device', video: 'external' };

function refusal(body: unknown): LiveError {
  try {
    parseStartRequest(body);
  } catch (e) {
    if (e instanceof LiveError) return e;
    throw e;
  }
  throw new Error('the body was accepted');
}

describe('POST /api/live/start: the frozen resume and videoPath fields', () => {
  it('carries a resume request through', () => {
    expect(parseStartRequest({ ...BASE, resume: true })).toEqual({ ...BASE, resume: true });
  });

  it('carries each video path through', () => {
    expect(parseStartRequest({ ...BASE, videoPath: 'box' }).videoPath).toBe('box');
    expect(parseStartRequest({ ...BASE, videoPath: 'device' }).videoPath).toBe('device');
  });

  it('an older app body gives exactly what it gave before: neither field appears', () => {
    const req = parseStartRequest(BASE);
    expect(req).toEqual(BASE);
    expect('resume' in req).toBe(false);
    expect('videoPath' in req).toBe(false);
  });

  it('refuses an unknown videoPath and a resume that is not a boolean with 400 bad_request', () => {
    for (const body of [{ ...BASE, videoPath: 'cloud' }, { ...BASE, videoPath: null }, { ...BASE, resume: 'yes' }]) {
      const e = refusal(body);
      expect(e.status).toBe(400);
      expect(e.code).toBe('bad_request');
    }
  });
});

describe('the Lane 0 stubs', () => {
  it('the YouTube route file registers its two routes; without a database only the linked-box question', async () => {
    const routesOf = async (deps: Parameters<typeof registerYoutubeRoutes>[1]): Promise<string[]> => {
      const app = Fastify();
      const seen: string[] = [];
      app.addHook('onRoute', (r) => {
        if (String(r.method) !== 'HEAD') seen.push(`${String(r.method)} ${r.url}`);
      });
      registerYoutubeRoutes(app, deps);
      await app.ready();
      await app.close();
      return seen.sort();
    };
    expect(await routesOf({})).toEqual(['GET /api/youtube/open-broadcast']);
    const db = openDb(':memory:');
    expect(await routesOf({ db })).toEqual(['GET /api/youtube/open-broadcast', 'POST /api/youtube/upload/abandon']);
    db.close();
  });

  it('the session store interface can be satisfied by a plain object (what a lane fake will be)', () => {
    const rows = new Map<string, { id: string }>();
    const store: Pick<LiveSessionStore, 'get'> = { get: (id) => (rows.get(id) as never) ?? null };
    expect(store.get('none')).toBeNull();
  });
});
