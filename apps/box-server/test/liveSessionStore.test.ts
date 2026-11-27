// 2026.11.15, Lane A task A3: the persisted record of the box's lives (table `live_sessions`), the gaps the monitor
// writes into it, `GET /api/live/sessions/recent`, and the clean end of a live a box restart cut short (S3, D3).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveSessionSummary, LiveStatus } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { createLiveSessionStore } from '../src/live/sessionStore.ts';
import type { LiveSessionStart } from '../src/live/sessionStore.ts';
import type { YoutubeLeg } from '../src/live/sessions.ts';
import { loginAs } from './authHelpers.ts';
import { startBody, startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';

const LAN = '10.168.1.40';
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0).reverse()) await c();
});

async function make(o: Parameters<typeof startLiveHarness>[0] = {}): Promise<LiveHarness> {
  const h = await startLiveHarness({ ...o, live: { monitorMs: 3_600_000, ...(o.live ?? {}) } });
  closers.push(h.close);
  return h;
}

const row = (id: string, over: Partial<LiveSessionStart> = {}): LiveSessionStart => ({
  id,
  surauId: 'sdm',
  boxId: 'a1b2c3d4e5f60718',
  ownerDeviceId: 'D1',
  startedBy: 'Pentadbir Ujian',
  kuliahId: null,
  source: 'android',
  video: 'external',
  videoPath: 'device',
  outputs: { kiosk: true, youtube: true },
  youtubeVia: 'device',
  youtubeChannelId: 'UC-ujian',
  startedAt: '2026-11-22T12:00:00.000Z',
  ...over,
});

const leg = (): YoutubeLeg & { completed: string[] } => {
  const completed: string[] = [];
  return {
    completed,
    signedIn: () => true,
    createBroadcastFor: async () => ({ broadcastId: 'bc1', watchUrl: 'https://youtu.be/bc1', key: 'abcd-efgh-ijkl-mnop-qrst' }),
    complete: async (id) => {
      completed.push(id);
    },
    status: (): LiveStatus['youtube'] => ({ signedIn: true, channelTitle: 'Surau', broadcastId: 'bc1', state: 'created', health: null, watchUrl: 'https://youtu.be/bc1', lastError: null, channelId: 'UC-ujian' }),
  };
};

const get = (h: LiveHarness, url: string, headers: Record<string, string>) => h.app.inject({ method: 'GET', url, headers, remoteAddress: LAN });
const post = (h: LiveHarness, url: string, headers: Record<string, string>, payload: unknown) =>
  h.app.inject({ method: 'POST', url, headers, payload: payload as object, remoteAddress: LAN });

describe('S3: the store over live_sessions', () => {
  it('begin, broadcasts, gaps, end and the reads keep the shape of LiveSessionRecord', () => {
    const db = openDb(':memory:');
    closers.push(() => db.close());
    const store = createLiveSessionStore(db);
    store.begin(row('S1'));
    expect(store.get('S1')).toMatchObject({ id: 'S1', videoPath: 'device', outputs: { kiosk: true, youtube: true }, youtubeChannelId: 'UC-ujian', stoppedAt: null, reason: null, broadcastIds: [], gaps: [], gapSeconds: 0 });
    expect(store.open().map((r) => r.id)).toEqual(['S1']);

    store.addBroadcast('S1', 'bcA');
    store.addBroadcast('S1', 'bcA'); // listed once
    store.addBroadcast('S1', 'bcB');
    store.appendGap('S1', { from: '2026-11-22T12:10:00.000Z', to: '2026-11-22T12:10:20.000Z', kind: 'ingest' });
    store.appendGap('S1', { from: '2026-11-22T12:20:00.000Z', to: '2026-11-22T12:20:30.400Z', kind: 'youtube', broadcastId: 'bcB' });
    store.appendGap('nope', { from: '2026-11-22T12:20:00.000Z', to: '2026-11-22T12:20:30.000Z', kind: 'ingest' }); // unknown session: a no-op
    const rec = store.get('S1')!;
    expect(rec.broadcastIds).toEqual(['bcA', 'bcB']);
    expect(rec.gaps).toHaveLength(2);
    expect(rec.gaps[1]).toEqual({ from: '2026-11-22T12:20:00.000Z', to: '2026-11-22T12:20:30.400Z', kind: 'youtube', broadcastId: 'bcB' });
    expect(rec.gapSeconds).toBe(50);

    store.end('S1', '2026-11-22T13:00:00.000Z', 'stopped');
    store.end('S1', '2026-11-22T14:00:00.000Z', 'shutdown'); // a closed row keeps its first stop
    expect(store.get('S1')).toMatchObject({ stoppedAt: '2026-11-22T13:00:00.000Z', reason: 'stopped' });
    expect(store.open()).toEqual([]);
    expect(store.get('nope')).toBeNull();
  });

  it('setOutputs: a destination switched during the live shows in the record; a row from before reads Skrin on', () => {
    const db = openDb(':memory:');
    closers.push(() => db.close());
    const store = createLiveSessionStore(db);
    store.begin(row('S1'));
    store.setOutputs('S1', { kiosk: false, youtube: true, recording: true });
    expect(store.get('S1')!.outputs).toEqual({ kiosk: false, youtube: true, recording: true });
    expect(store.recent('surau-1' as never).length).toBeGreaterThanOrEqual(0);
    store.setOutputs('nope', { kiosk: false, youtube: false }); // unknown session: a no-op
    // YouTube turned on mid-live keeps the other flags
    store.markYoutube('S1', 'UC-ujian');
    expect(store.get('S1')!.outputs).toEqual({ kiosk: false, youtube: true, recording: true });
    // a row with no outputs_json (before this release)
    db.prepare('UPDATE live_sessions SET outputs_json = NULL WHERE id = ?').run('S1');
    expect(store.get('S1')!.outputs).toEqual({ kiosk: true, youtube: true });
  });

  it('O7: overlapping gaps are merged (counted once), separate gaps add, in either order', () => {
    const db = openDb(':memory:');
    closers.push(() => db.close());
    const store = createLiveSessionStore(db);
    const at = (sec: number): string => new Date(Date.parse('2026-11-22T12:00:00.000Z') + sec * 1000).toISOString();
    store.begin(row('A'));
    store.appendGap('A', { from: at(0), to: at(60), kind: 'ingest' });
    store.appendGap('A', { from: at(30), to: at(90), kind: 'youtube', broadcastId: 'bc' }); // overlaps 30 s
    expect(store.get('A')!.gapSeconds).toBe(90);
    store.appendGap('A', { from: at(10), to: at(20), kind: 'youtube', broadcastId: 'bc' }); // fully inside
    expect(store.get('A')!.gapSeconds).toBe(90);
    store.appendGap('A', { from: at(200), to: at(210), kind: 'ingest' }); // separate
    expect(store.get('A')!.gapSeconds).toBe(100);
    expect(store.get('A')!.gaps).toHaveLength(4); // every gap stays listed

    store.begin(row('B'));
    store.appendGap('B', { from: at(30), to: at(90), kind: 'youtube', broadcastId: 'bc' });
    store.appendGap('B', { from: at(0), to: at(60), kind: 'ingest' });
    expect(store.get('B')!.gapSeconds).toBe(90);
    // a gap that runs backwards adds nothing
    store.appendGap('B', { from: at(500), to: at(400), kind: 'ingest' });
    expect(store.get('B')!.gapSeconds).toBe(90);
  });

  it('Q12: begin keeps the first row of a repeated id quietly, and says so (the code only) when the table refuses a row', () => {
    const db = openDb(':memory:');
    closers.push(() => db.close());
    const store = createLiveSessionStore(db);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    store.begin(row('S1'));
    store.begin(row('S1', { startedBy: 'Orang Lain' })); // the same id again: tolerated, the first row stands
    expect(store.get('S1')).toMatchObject({ startedBy: 'Pentadbir Ujian' });
    expect(warn).not.toHaveBeenCalled();

    // a value the CHECK refuses, and a missing NOT NULL value: no throw (the live goes on), no row, a warning with the code
    expect(() => store.begin(row('S2', { source: 'ios' as never }))).not.toThrow();
    expect(() => store.begin(row('S3', { startedAt: null as never }))).not.toThrow();
    expect(store.get('S2')).toBeNull();
    expect(store.get('S3')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    for (const call of warn.mock.calls) {
      expect(call).toHaveLength(1);
      expect(String(call[0])).toMatch(/^live: the record of this live was refused by the table \(code: [A-Za-z0-9_]+\)$/);
      // never the row's values
      expect(String(call[0])).not.toContain('ios');
      expect(String(call[0])).not.toContain('Pentadbir');
    }
    // the store still works
    store.begin(row('S4'));
    expect(store.get('S4')).not.toBeNull();
  });

  it('recent answers the newest rows of one surau, newest first, bounded by the limit', () => {
    const db = openDb(':memory:');
    closers.push(() => db.close());
    const store = createLiveSessionStore(db);
    for (let i = 0; i < 14; i++) store.begin(row(`S${i}`, { startedAt: new Date(Date.UTC(2026, 10, 1 + i)).toISOString() }));
    store.begin(row('other', { surauId: 'lain', startedAt: '2026-12-01T00:00:00.000Z' }));
    const recent = store.recent('sdm');
    expect(recent).toHaveLength(10);
    expect(recent[0]!.id).toBe('S13');
    expect(recent.at(-1)!.id).toBe('S4');
    expect(store.recent('sdm', 3).map((r) => r.id)).toEqual(['S13', 'S12', 'S11']);
    expect(store.recent('lain').map((r) => r.id)).toEqual(['other']);
  });
});

describe('A3: the sessions write the record', () => {
  it('a live is written at the start and closed at the stop with its reason and broadcast (success path)', async () => {
    const yt = leg();
    const h = await make({ live: { youtube: yt } });
    const user = await loginAs(h.app, 'live');
    const start = await post(h, '/api/live/start', user.headers, startBody(h, { outputs: { kiosk: true, youtube: true } }));
    const id = start.json().session.id as string;
    const store = createLiveSessionStore(h.app.surau.db);
    for (let i = 0; i < 200 && store.get(id)?.broadcastIds.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(store.get(id)).toMatchObject({
      id,
      boxId: h.app.surau.boxId,
      ownerDeviceId: user.deviceId,
      kuliahId: h.kuliahId,
      source: 'android',
      video: 'phone',
      videoPath: 'device',
      outputs: { kiosk: true, youtube: true },
      youtubeChannelId: 'UC-ujian',
      stoppedAt: null,
      broadcastIds: ['bc1'],
    });
    expect((await get(h, '/api/live/status', user.headers)).json().broadcastIds).toEqual(['bc1']);
    await post(h, '/api/live/stop', user.headers, {});
    await h.app.liveSessions!.settled();
    const done = store.get(id)!;
    expect(done.reason).toBe('stopped');
    expect(done.stoppedAt).toBe(new Date(h.clock.t).toISOString());
    // no secret in the row: the stream key and the publisher password are not there
    const text = JSON.stringify(h.app.surau.db.prepare('SELECT * FROM live_sessions').all());
    expect(text).not.toContain('abcd-efgh');
    expect(text).not.toContain(start.json().ingest.srt.passphrase);
  });

  it('D3: a live with one 20 s ingest gap stores one gap, and the status counts it while it is still open', async () => {
    const h = await make();
    const user = await loginAs(h.app, 'live');
    const id = (await post(h, '/api/live/start', user.headers, startBody(h))).json().session.id as string;
    const sessions = h.app.liveSessions!;
    const store = createLiveSessionStore(h.app.surau.db);
    // no picture yet: the time before the first picture is not a gap
    h.clock.t += 30_000;
    sessions.heartbeat(user.deviceId);
    await sessions.tick();
    h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1' });
    await sessions.tick();
    h.clock.t += 60_000;
    await sessions.tick();
    const lost = h.clock.t;
    h.fake.setReady(false);
    h.clock.t += 12_000;
    await sessions.tick();
    expect(store.get(id)!.gaps).toEqual([]);
    expect((await get(h, '/api/live/status', user.headers)).json().gapSeconds).toBe(12);
    h.clock.t += 8_000;
    h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c2' });
    await sessions.tick();
    const rec = store.get(id)!;
    expect(rec.gaps).toEqual([{ from: new Date(lost).toISOString(), to: new Date(lost + 20_000).toISOString(), kind: 'ingest' }]);
    expect(rec.gapSeconds).toBe(20);
    // O7: a YouTube gap inside the very span the ingest gap covers is counted once
    store.appendGap(id, { from: new Date(lost).toISOString(), to: new Date(lost + 5_000).toISOString(), kind: 'youtube', broadcastId: 'bc1' });
    expect((await get(h, '/api/live/status', user.headers)).json().gapSeconds).toBe(20);
    // a gap another writer adds (the YouTube health poll) at a separate time is in the status sum too
    store.appendGap(id, { from: new Date(lost + 30_000).toISOString(), to: new Date(lost + 35_000).toISOString(), kind: 'youtube', broadcastId: 'bc1' });
    expect((await get(h, '/api/live/status', user.headers)).json().gapSeconds).toBe(25);
    // a steady picture adds nothing
    h.clock.t += 60_000;
    await sessions.tick();
    expect(store.get(id)!.gaps).toHaveLength(3);
  });

  it('Q5: the open ingest gap still counts in the status when the stored gap list is full', async () => {
    const h = await make();
    const user = await loginAs(h.app, 'live');
    const id = (await post(h, '/api/live/start', user.headers, startBody(h))).json().session.id as string;
    const sessions = h.app.liveSessions!;
    const store = createLiveSessionStore(h.app.surau.db);
    h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1' });
    await sessions.tick();
    h.clock.t += 60_000;
    await sessions.tick();
    // 520 closed one-second gaps, apart from each other: the list keeps 500, the count keeps all 520
    const base = h.clock.t - 3_000_000;
    for (let i = 0; i < 520; i++) store.appendGap(id, { from: new Date(base + i * 2000).toISOString(), to: new Date(base + i * 2000 + 1000).toISOString(), kind: 'youtube', broadcastId: 'bc1' });
    expect(store.get(id)!.gaps).toHaveLength(500);
    expect(store.get(id)!.gapSeconds).toBe(520);
    h.fake.setReady(false);
    h.clock.t += 12_000;
    await sessions.tick();
    expect((await get(h, '/api/live/status', user.headers)).json().gapSeconds).toBe(532);
  });

  it('O7: a YouTube gap that overlaps the ingest gap still open is counted once in the status, and once more it closes', async () => {
    const h = await make();
    const user = await loginAs(h.app, 'live');
    const id = (await post(h, '/api/live/start', user.headers, startBody(h))).json().session.id as string;
    const sessions = h.app.liveSessions!;
    const store = createLiveSessionStore(h.app.surau.db);
    h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1' });
    await sessions.tick();
    h.clock.t += 60_000;
    await sessions.tick();
    const lost = h.clock.t;
    h.fake.setReady(false);
    h.clock.t += 12_000;
    await sessions.tick();
    store.appendGap(id, { from: new Date(lost + 4_000).toISOString(), to: new Date(lost + 9_000).toISOString(), kind: 'youtube', broadcastId: 'bc1' });
    // 5 s closed YouTube gap inside the 12 s open ingest gap: 12, not 17
    expect((await get(h, '/api/live/status', user.headers)).json().gapSeconds).toBe(12);
    h.clock.t += 8_000;
    h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c2' });
    await sessions.tick();
    expect(store.get(id)!.gapSeconds).toBe(20);
    expect((await get(h, '/api/live/status', user.headers)).json().gapSeconds).toBe(20);
  });

  it('D3: a gap still open when the live ends is closed at the stop', async () => {
    const h = await make();
    const user = await loginAs(h.app, 'live');
    const id = (await post(h, '/api/live/start', user.headers, startBody(h))).json().session.id as string;
    const sessions = h.app.liveSessions!;
    h.fake.setReady(true, { sourceType: 'srtConn', sourceId: 'c1' });
    await sessions.tick();
    h.fake.setReady(false);
    h.clock.t += 15_000;
    await sessions.tick();
    await post(h, '/api/live/stop', user.headers, {});
    const rec = createLiveSessionStore(h.app.surau.db).get(id)!;
    expect(rec.gaps).toHaveLength(1);
    expect(rec.gapSeconds).toBe(15);
    expect(rec.reason).toBe('stopped');
  });
});

describe('A3: GET /api/live/sessions/recent', () => {
  it('needs live:control; answers at most 10 rows, newest first, with mine and without any device id or secret', async () => {
    const h = await make();
    const owner = await loginAs(h.app, 'live');
    const other = await loginAs(h.app, 'live');
    const media = await loginAs(h.app, 'media');
    expect((await h.app.inject({ method: 'GET', url: '/api/live/sessions/recent', remoteAddress: LAN })).statusCode).toBe(401);
    expect((await get(h, '/api/live/sessions/recent', media.headers)).statusCode).toBe(403);
    expect((await get(h, '/api/live/sessions/recent', owner.headers)).json()).toEqual({ sessions: [] });

    const ids: string[] = [];
    const passes: string[] = [];
    // starts without a picture are not counted by the hourly limit; the ceiling is 30 requests
    for (let i = 0; i < 12; i++) {
      h.clock.t += 60_000;
      const s = await post(h, '/api/live/start', owner.headers, startBody(h));
      expect(s.statusCode).toBe(200);
      ids.push(s.json().session.id as string);
      passes.push(s.json().ingest.srt.passphrase as string, s.json().ingest.srt.streamId as string);
      if (i < 11) await post(h, '/api/live/stop', owner.headers, {});
    }
    const mine = await get(h, '/api/live/sessions/recent', owner.headers);
    expect(mine.statusCode).toBe(200);
    expect(mine.headers['cache-control']).toBe('no-store');
    const list = mine.json().sessions as LiveSessionSummary[];
    expect(list.map((s) => s.id)).toEqual(ids.slice(2).reverse());
    expect(list[0]).toMatchObject({ mine: true, stoppedAt: null, reason: null, kuliahId: h.kuliahId, videoPath: 'device', gaps: [], gapSeconds: 0, broadcastIds: [] });
    expect(list[1]).toMatchObject({ mine: true, reason: 'stopped' });
    expect(Object.keys(list[0]!)).not.toContain('ownerDeviceId');
    const theirs = await get(h, '/api/live/sessions/recent', other.headers);
    expect((theirs.json().sessions as LiveSessionSummary[]).every((s) => s.mine === false)).toBe(true);
    for (const body of [mine.body, theirs.body]) {
      expect(body).not.toContain(owner.deviceId);
      for (const secret of passes) expect(body).not.toContain(secret);
    }
  });
});

describe('S3: a box restart with an open row', () => {
  it('recoverOpen ends the row with reason shutdown and completes its last broadcast; the running live is left alone', async () => {
    const yt = leg();
    const h = await make({ live: { youtube: yt } });
    const store = createLiveSessionStore(h.app.surau.db);
    store.begin(row('crashed', { surauId: 'sdm' }));
    store.addBroadcast('crashed', 'bcOld');
    store.addBroadcast('crashed', 'bcNew');
    const user = await loginAs(h.app, 'live');
    const running = (await post(h, '/api/live/start', user.headers, startBody(h))).json().session.id as string;
    expect(await h.app.liveSessions!.recoverOpen()).toBe(1);
    expect(store.get('crashed')).toMatchObject({ reason: 'shutdown', stoppedAt: new Date(h.clock.t).toISOString() });
    expect(yt.completed).toEqual(['bcNew']);
    expect(store.get(running)!.stoppedAt).toBeNull();
    expect(h.app.liveSessions!.current()?.id).toBe(running);
    // nothing left to do the second time
    expect(await h.app.liveSessions!.recoverOpen()).toBe(0);
  });

  it('a box that starts with an open row closes it by itself', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-rec-'));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'box.db');
    const first = buildApp(file, {});
    await first.ready();
    createLiveSessionStore(first.surau.db).begin(row('crashed'));
    // the process dies here: nothing closes the row (a clean close has no session to stop)
    await first.close();
    const second = buildApp(file, {});
    closers.push(() => second.close());
    await second.ready();
    const store = createLiveSessionStore(second.surau.db);
    for (let i = 0; i < 300 && store.get('crashed')?.stoppedAt === null; i++) await new Promise((r) => setTimeout(r, 10));
    expect(store.get('crashed')).toMatchObject({ reason: 'shutdown' });
    expect(store.open()).toEqual([]);
  });
});
