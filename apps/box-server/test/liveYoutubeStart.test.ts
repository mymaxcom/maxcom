// 2026.11.15, Lane B task O34 (box half): POST /api/live/youtube/start turns YouTube on for a running live that
// started without it, without restarting the mixer, the ingest or the TV leg.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveStatus } from '@surau/core';
import type { YoutubeLeg } from '../src/live/sessions.ts';
import { registerLiveRoutes } from '../src/live/routes.ts';
import { putFeature } from '../src/settingsStore.ts';
import { loginAs } from './authHelpers.ts';
import { startBody, startLiveHarness, changeLogText } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';
import { boxYoutube } from './support/youtubeHarness.ts';
import type { BoxYoutube } from './support/youtubeHarness.ts';

const LAN = '10.168.1.40';
const STUB = `
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(path.join(__dirname, 'argv.log'), JSON.stringify(process.argv.slice(2)) + '\\n');
const tick = () => process.stdout.write('bitrate=1234.5kbits/s\\ntotal_size=1000\\nspeed=1.01x\\nprogress=continue\\n');
tick();
setInterval(tick, 30);
process.on('SIGTERM', () => process.exit(0));
`;

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0).reverse()) await c();
});

interface Rig {
  h: LiveHarness;
  yt: BoxYoutube | null;
  runs: () => string[][];
}

async function rig(o: { leg?: YoutubeLeg; signedIn?: boolean } = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'surau-ytstart-'));
  const script = join(dir, 'stub-ffmpeg.cjs');
  writeFileSync(script, STUB);
  const yt = o.leg === undefined ? boxYoutube({ signedIn: o.signedIn !== false }) : null;
  const h = await startLiveHarness({
    live: {
      youtube: (o.leg ?? (yt!.svc as unknown as YoutubeLeg)),
      encoderProbe: async () => true,
      relay: { ffmpegPath: process.execPath, argsPrefix: [script], pollMs: 10, backoffBaseMs: 5, backoffMaxMs: 20, killAfterMs: 500 },
    },
  });
  closers.push(async () => {
    await h.close();
    yt?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { h, yt, runs: () => (existsSync(join(dir, 'argv.log')) ? readFileSync(join(dir, 'argv.log'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as string[]) : []) };
}

const post = (h: LiveHarness, url: string, headers: Record<string, string>, payload: unknown = {}) =>
  h.app.inject({ method: 'POST', url, headers, payload: payload as object, remoteAddress: LAN });
const get = (h: LiveHarness, url: string, headers: Record<string, string>) => h.app.inject({ method: 'GET', url, headers, remoteAddress: LAN });
const noYoutube = (h: LiveHarness, over: Record<string, unknown> = {}) => startBody(h, { source: 'web', outputs: { kiosk: true, youtube: false }, youtubeVia: 'box', ...over });
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('O34: POST /api/live/youtube/start', () => {
  it('a box leg: the broadcast is made, the relay starts against the running ingest, the record says YouTube is on, nothing else restarts', async () => {
    const { h, yt, runs } = await rig();
    const owner = await loginAs(h.app, 'live');
    const start = await post(h, '/api/live/start', owner.headers, noYoutube(h));
    expect(start.statusCode).toBe(200);
    const id = start.json().session.id as string;
    expect(start.json().session.outputs.youtube).toBe(false);
    h.fake.setReady(true, { sourceType: 'webRTCSession', sourceId: 'w1' });
    expect(runs()).toHaveLength(0);
    const pathPatches = h.fake.requests.filter((q) => q.method === 'PATCH' && q.url.includes('/config/paths/')).length;

    const r = await post(h, '/api/live/youtube/start', owner.headers, { sessionId: id, title: 'Kuliah Subuh', privacy: 'unlisted' });
    expect(r.statusCode).toBe(200);
    expect(r.json().session).toMatchObject({ id, mine: true, outputs: { kiosk: true, youtube: true } });
    expect(r.json().youtube).toMatchObject({ via: 'box', ingest: null, key: null, legState: 'ready' });
    // I2/F3: the answer is the live status (its youtube block with the sign-in, the watch link and the state) plus the leg fields
    expect(r.json().youtube).toMatchObject({ signedIn: true, state: 'created', watchUrl: expect.stringMatching(/^https:\/\/youtu\.be\//) });
    expect(r.json()).toMatchObject({ nextLiveOn: expect.any(Boolean), warnings: expect.any(Array), mediamtx: expect.any(Object), ingest: expect.any(Object), relayReencode: true });
    expect(r.headers['cache-control']).toBe('no-store');
    // the Google call carried the caller's title and visibility
    const insert = yt!.g.calls.find((c) => c.method === 'POST' && c.path.endsWith('/liveBroadcasts'))!;
    expect(insert.body).toContain('Kuliah Subuh');
    expect(insert.body).toContain('unlisted');

    await until(() => runs().length === 1);
    expect(runs()[0]!.join(' ')).toContain('-c:v copy');
    const st = (await get(h, '/api/live/status', owner.headers)).json() as LiveStatus & { relay: { state: string } };
    expect(st.session).toMatchObject({ id, outputs: { youtube: true } });
    expect(st.youtube.watchUrl).toMatch(/^https:\/\/youtu\.be\//);
    expect(st.broadcastIds).toHaveLength(1);
    expect(st.relay.state === 'starting' || st.relay.state === 'running').toBe(true);
    // the record of the live keeps it
    const rec = h.app.surau.db.prepare('SELECT youtube, broadcast_ids_json FROM live_sessions WHERE id = ?').get(id) as { youtube: number; broadcast_ids_json: string };
    expect(Number(rec.youtube)).toBe(1);
    expect(JSON.parse(rec.broadcast_ids_json)).toHaveLength(1);
    // the ingest and the TV leg were not touched: no path was patched, no second session was made
    expect(h.fake.requests.filter((q) => q.method === 'PATCH' && q.url.includes('/config/paths/')).length).toBe(pathPatches);
    expect((await get(h, '/api/live/status', owner.headers)).json().session.id).toBe(id);
    // no stream key in the history
    expect(changeLogText(h.app)).not.toMatch(/live2\//);

    // a second call: it is on already
    const again = await post(h, '/api/live/youtube/start', owner.headers, { sessionId: id });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('already_on');
    // the stop completes the broadcast like any other live
    await post(h, '/api/live/stop', owner.headers, {});
    await h.app.liveSessions!.settled();
    expect(yt!.g.calls.some((c) => c.path.endsWith('/liveBroadcasts/transition') && c.query.get('broadcastStatus') === 'complete')).toBe(true);
  });

  it('a phone leg: the owner gets the ingest and key now; an administrator on another device does not, and the phone reads it from /youtube/ingest', async () => {
    const { h } = await rig();
    const owner = await loginAs(h.app, 'live');
    const admin = await loginAs(h.app, 'admin');
    const id = (await post(h, '/api/live/start', owner.headers, startBody(h))).json().session.id as string;
    const viaAdmin = await post(h, '/api/live/youtube/start', admin.headers, { sessionId: id });
    expect(viaAdmin.statusCode).toBe(200);
    expect(viaAdmin.json().youtube).toMatchObject({ via: 'device', ingest: null, key: null, legState: 'starting' });
    expect(viaAdmin.body).not.toMatch(/"key":"[^"]/);
    // the owning phone asks for its leg
    const ingest = (await get(h, '/api/live/youtube/ingest', owner.headers)).json() as { state: string; ingest: string | null; key: string | null };
    expect(ingest.state).toBe('ready');
    expect(ingest.ingest).toMatch(/^rtmps:\/\//);
    expect(typeof ingest.key).toBe('string');
    expect((await get(h, '/api/live/youtube/ingest', admin.headers)).statusCode).toBe(403);
  });

  it('a phone leg started by the owner answers with the ingest and the key', async () => {
    const { h } = await rig();
    const owner = await loginAs(h.app, 'live');
    const id = (await post(h, '/api/live/start', owner.headers, startBody(h))).json().session.id as string;
    const r = await post(h, '/api/live/youtube/start', owner.headers, { sessionId: id });
    expect(r.statusCode).toBe(200);
    expect(r.json().youtube).toMatchObject({ via: 'device', legState: 'ready', ingest: expect.stringMatching(/^rtmps:\/\//) });
    expect(typeof r.json().youtube.key).toBe('string');
    // the key is not in the history
    expect(changeLogText(h.app)).not.toContain(r.json().youtube.key as string);
  });

  it('refusals are codes: no_session, not_owner, already_on, not_signed_in, bad_request', async () => {
    const { h } = await rig();
    const owner = await loginAs(h.app, 'live');
    const other = await loginAs(h.app, 'live');
    const media = await loginAs(h.app, 'media');
    const none = await post(h, '/api/live/youtube/start', owner.headers, { sessionId: 'nope' });
    expect(none.statusCode).toBe(409);
    expect(none.json().code).toBe('no_session');
    const id = (await post(h, '/api/live/start', owner.headers, noYoutube(h))).json().session.id as string;
    expect((await post(h, '/api/live/youtube/start', owner.headers, { sessionId: 'wrong' })).json().code).toBe('no_session');
    const notOwner = await post(h, '/api/live/youtube/start', other.headers, { sessionId: id });
    expect(notOwner.statusCode).toBe(403);
    expect(notOwner.json().code).toBe('not_owner');
    expect((await post(h, '/api/live/youtube/start', media.headers, { sessionId: id })).statusCode).toBe(403);
    for (const bad of [{}, { sessionId: 5 }, { sessionId: id, title: 5 }, { sessionId: id, privacy: 'secret' }, { sessionId: id, title: '   ' }]) {
      expect((await post(h, '/api/live/youtube/start', owner.headers, bad)).json().code, JSON.stringify(bad)).toBe('bad_request');
    }
    // nothing was made by the refusals
    expect(h.app.surau.db.prepare('SELECT youtube FROM live_sessions WHERE id = ?').get(id)).toMatchObject({ youtube: 0 });
    // a live that started with YouTube
    const live2 = await rig();
    const o2 = await loginAs(live2.h.app, 'live');
    const s2 = (await post(live2.h, '/api/live/start', o2.headers, noYoutube(live2.h, { outputs: { kiosk: true, youtube: true } }))).json().session.id as string;
    expect((await post(live2.h, '/api/live/youtube/start', o2.headers, { sessionId: s2 })).json().code).toBe('already_on');
  });

  it('not signed in to YouTube: not_signed_in, and no broadcast is made', async () => {
    const { h, yt } = await rig({ signedIn: false });
    const owner = await loginAs(h.app, 'live');
    const id = (await post(h, '/api/live/start', owner.headers, noYoutube(h))).json().session.id as string;
    const r = await post(h, '/api/live/youtube/start', owner.headers, { sessionId: id });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('not_signed_in');
    expect(yt!.g.calls.filter((c) => c.path.endsWith('/liveBroadcasts'))).toHaveLength(0);
  });

  it('two calls at once: one makes the broadcast, the other is told busy; a Google failure frees the live to try again', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let made = 0;
    let failNext = false;
    const leg: YoutubeLeg = {
      signedIn: () => true,
      createBroadcastFor: async () => {
        made++;
        await gate;
        if (failNext) throw Object.assign(new Error('x'), { reason: 'quota' });
        return { broadcastId: 'bcX', watchUrl: 'https://www.youtube.com/watch?v=bcX', key: 'abcd-efgh-ijkl-mnop-qrst' };
      },
      complete: async () => undefined,
      status: () => ({ signedIn: true, channelTitle: 'Surau', broadcastId: null, state: 'none', health: null, watchUrl: null, lastError: null }),
    };
    const { h } = await rig({ leg });
    const owner = await loginAs(h.app, 'live');
    const id = (await post(h, '/api/live/start', owner.headers, noYoutube(h))).json().session.id as string;
    failNext = true;
    const first = post(h, '/api/live/youtube/start', owner.headers, { sessionId: id });
    await until(() => made === 1);
    const second = await post(h, '/api/live/youtube/start', owner.headers, { sessionId: id });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('busy');
    release!();
    const failed = await first;
    expect(failed.statusCode).toBe(502);
    expect(failed.json().code).toBe('youtube_quota');
    expect(h.app.surau.db.prepare('SELECT youtube FROM live_sessions WHERE id = ?').get(id)).toMatchObject({ youtube: 0 });
    // the warning shows in the status, and the next try works
    expect(((await get(h, '/api/live/status', owner.headers)).json() as LiveStatus).warnings).toContain('youtube_quota');
    failNext = false;
    const ok = await post(h, '/api/live/youtube/start', owner.headers, { sessionId: id });
    expect(ok.statusCode).toBe(200);
    expect(made).toBe(2);
  });

  it('S1: a caller without settings:write may not make the live more open than the surau setting; an administrator may', async () => {
    const { h } = await rig();
    putFeature(h.app.surau.db, 'liveYoutube', { enabled: true, privacy: 'unlisted' }, 'test', undefined, 'sdm');
    const owner = await loginAs(h.app, 'live');
    const admin = await loginAs(h.app, 'admin');
    const id = (await post(h, '/api/live/start', owner.headers, noYoutube(h))).json().session.id as string;
    const open = await post(h, '/api/live/youtube/start', owner.headers, { sessionId: id, privacy: 'public' });
    expect(open.statusCode).toBe(403);
    expect(open.json().code).toBe('privacy_not_allowed');
    expect(h.app.surau.db.prepare('SELECT youtube FROM live_sessions WHERE id = ?').get(id)).toMatchObject({ youtube: 0 });
    // not more open is fine for the owner (success path); an administrator may go further
    expect((await post(h, '/api/live/youtube/start', owner.headers, { sessionId: id, privacy: 'private' })).statusCode).toBe(200);
    const id2 = (await post(h, '/api/live/stop', owner.headers, {}), await post(h, '/api/live/start', owner.headers, noYoutube(h))).json().session.id as string;
    expect((await post(h, '/api/live/youtube/start', admin.headers, { sessionId: id2, privacy: 'public' })).statusCode).toBe(200);
  });

  it('S8: attempts of one device are limited per hour even when Google refuses each one, and the limit frees after the hour', async () => {
    let made = 0;
    const leg: YoutubeLeg = {
      signedIn: () => true,
      createBroadcastFor: async () => {
        made++;
        throw Object.assign(new Error('x'), { reason: 'quota' });
      },
      complete: async () => undefined,
      status: () => ({ signedIn: true, channelTitle: 'Surau', broadcastId: null, state: 'none', health: null, watchUrl: null, lastError: null }),
    };
    const { h } = await rig({ leg });
    const owner = await loginAs(h.app, 'live');
    const id = (await post(h, '/api/live/start', owner.headers, noYoutube(h))).json().session.id as string;
    for (let i = 0; i < 6; i++) expect((await post(h, '/api/live/youtube/start', owner.headers, { sessionId: id })).statusCode).toBe(502);
    const limited = await post(h, '/api/live/youtube/start', owner.headers, { sessionId: id });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('live_rate');
    expect(made).toBe(6);
    h.clock.t += 61 * 60_000;
    // an hour with no picture may have ended the live by the orphan rule (when a monitor tick ran first): start it
    // again, which gives the same session back if it is still there
    const again = (await post(h, '/api/live/start', owner.headers, noYoutube(h))).json().session.id as string;
    expect((await post(h, '/api/live/youtube/start', owner.headers, { sessionId: again })).statusCode).toBe(502);
    expect(made).toBe(7);
  }, 30_000);

  it('F26: a live whose YouTube output was asked at start but never came up (no broadcast) can still turn YouTube on', async () => {
    const { h } = await rig();
    const owner = await loginAs(h.app, 'live');
    const id = (await post(h, '/api/live/start', owner.headers, noYoutube(h))).json().session.id as string;
    const live = (h.app.liveSessions as unknown as { session: { outputs: { kiosk: boolean; youtube: boolean }; broadcastId: string | null } }).session;
    live.outputs = { ...live.outputs, youtube: true };
    expect(live.broadcastId).toBeNull();
    const r = await post(h, '/api/live/youtube/start', owner.headers, { sessionId: id });
    expect(r.statusCode).toBe(200);
    expect(live.broadcastId).not.toBeNull();
    expect((await post(h, '/api/live/youtube/start', owner.headers, { sessionId: id })).json().code).toBe('already_on');
  });

  it('on the cloud the route answers youtube_at_box', async () => {
    const app = Fastify();
    registerLiveRoutes(app, { sessions: {} as never, proxy: {} as never, lanIps: [], cloud: true });
    await app.ready();
    closers.push(() => app.close());
    const r = await app.inject({ method: 'POST', url: '/api/live/youtube/start', payload: { sessionId: 'x' } });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('youtube_at_box');
  });
});
