import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { YoutubeOpenBroadcast } from '@surau/core';
import { openDb } from '../src/db.ts';
import { LiveError } from '../src/live/sessions.ts';
import { YoutubeError, failureOf, fetchFailure, googleRequest, youtubeErrorCode, youtubeErrorStatus } from '../src/live/youtube/oauth.ts';
import { applyLinkJournalAtBoot, listBackups, planSetAside } from '../src/link/setAside.ts';
import { META, TEST_CHANNEL, TEST_REFRESH, boxYoutube, googleError, googleJson, scriptedGoogle } from './support/youtubeHarness.ts';
import type { BoxYoutube } from './support/youtubeHarness.ts';

/**
 * 2026.11.15 Siaran langsung revamp, the YouTube lane: a YouTube state that heals itself (Y1, Y8), the box's own gap
 * record (D1), the sign-out guard and full wipe (Y5, Y6, Y7), plain error reasons (Y9) and one live per channel
 * between linked boxes (Y11). The box's own service against a scripted Google; the clock is vitest's.
 */

const open: BoxYoutube[] = [];
const box = (o: Parameters<typeof boxYoutube>[0] = {}): BoxYoutube => {
  const b = boxYoutube(o);
  open.push(b);
  return b;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-23T12:00:00.000Z'));
});
afterEach(() => {
  for (const b of open.splice(0)) b.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const HEALTH = 10_000;

describe('Y1: a past error never blocks the next live', () => {
  it('after a failed health read and a completed broadcast the status is clean and the next start creates a broadcast', async () => {
    const b = box();
    const first = await b.svc.createBroadcastFor({ sessionId: 's1', meta: META });
    // the internet goes away during the live: the health read fails
    b.g.intercept = (c) => (c.path.endsWith('/liveStreams') && c.method === 'GET' ? 'network' : undefined);
    await vi.advanceTimersByTimeAsync(HEALTH);
    expect(b.svc.status().lastError).toBe('network');
    b.g.intercept = null;
    await b.svc.complete(first.broadcastId);
    // the live is closed: nothing of it is left to block the app (it reads `lastError`)
    expect(b.svc.status()).toMatchObject({ state: 'complete', lastError: null });
    expect(b.svc.info().lastError).toBeNull();
    const second = await b.svc.createBroadcastFor({ sessionId: 's2', meta: META });
    expect(second.broadcastId).not.toBe(first.broadcastId);
    expect(b.svc.status()).toMatchObject({ state: 'created', broadcastId: second.broadcastId, lastError: null });
  });

  it('a start that failed leaves its reason only until the next start, which is a fresh attempt', async () => {
    const b = box();
    b.g.intercept = (c) => (c.method === 'POST' && c.path.endsWith('/liveStreams') ? 'network' : undefined);
    await expect(b.svc.createBroadcastFor({ sessionId: 's1', meta: META })).rejects.toMatchObject({ reason: 'network' });
    expect(b.svc.status()).toMatchObject({ state: 'error', lastError: 'network' });
    b.g.intercept = null;
    const made = await b.svc.createBroadcastFor({ sessionId: 's1', meta: META });
    expect(b.svc.status()).toMatchObject({ state: 'created', broadcastId: made.broadcastId, lastError: null });
  });

  it('the start-time probe says what Google says now: reachable clears an old error, unreachable sets it', async () => {
    const b = box();
    b.g.intercept = (c) => (c.method === 'POST' && c.path.endsWith('/liveStreams') ? 'network' : undefined);
    await expect(b.svc.createBroadcastFor({ sessionId: 's1', meta: META })).rejects.toBeInstanceOf(YoutubeError);
    b.g.intercept = null;
    expect(await b.svc.probe()).toBeNull();
    expect(b.svc.status()).toMatchObject({ lastError: null, state: 'none' });
    b.g.intercept = () => 'network';
    expect(await b.svc.probe()).toBe('network');
    expect(b.svc.status().lastError).toBe('network');
    b.g.intercept = null;
    expect(await b.svc.probe()).toBeNull();
  });

  it('the probe learns the channel id a sign-in could not read, and the status carries it', async () => {
    const b = box({ token: { channelId: '' } });
    expect(b.svc.channelId()).toBeNull();
    expect(b.svc.status().channelId).toBeNull();
    expect(await b.svc.probe()).toBeNull();
    expect(b.svc.channelId()).toBe(TEST_CHANNEL);
    expect(b.svc.status().channelId).toBe(TEST_CHANNEL);
    // kept across a restart
    expect(b.reopen().channelId()).toBe(TEST_CHANNEL);
  });
});

describe('D1: the box records when YouTube was not receiving', () => {
  it('noData for 30 s stores one YouTube gap with the broadcast id and the session id', async () => {
    const b = box();
    const made = await b.svc.createBroadcastFor({ sessionId: 'live-1', meta: META });
    await vi.advanceTimersByTimeAsync(HEALTH); // active, good: the broadcast is live
    expect(b.svc.status()).toMatchObject({ state: 'live', health: 'good' });
    b.g.health = 'noData';
    await vi.advanceTimersByTimeAsync(HEALTH);
    const from = new Date().toISOString();
    await vi.advanceTimersByTimeAsync(2 * HEALTH);
    expect(b.gaps).toEqual([]); // still open
    b.g.health = 'good';
    await vi.advanceTimersByTimeAsync(HEALTH);
    const to = new Date().toISOString();
    expect(b.gaps).toEqual([{ sessionId: 'live-1', from, to, kind: 'youtube', broadcastId: made.broadcastId }]);
    expect(Date.parse(to) - Date.parse(from)).toBe(30_000);
    // the state the app reads stays `live`; the gap is the record
    expect(b.svc.status().state).toBe('live');
  });

  it('an active stream stores no gap, and neither does the wait before the first data', async () => {
    const b = box();
    b.g.streamStatus = 'ready';
    b.g.health = 'noData';
    const made = await b.svc.createBroadcastFor({ sessionId: 'live-1', meta: META });
    await vi.advanceTimersByTimeAsync(3 * HEALTH); // not live yet: waiting for the first data is not a gap
    b.g.streamStatus = 'active';
    b.g.health = 'good';
    await vi.advanceTimersByTimeAsync(6 * HEALTH);
    await b.svc.complete(made.broadcastId);
    expect(b.gaps).toEqual([]);
  });

  it('a stream that stops being active, and a box that cannot reach Google, are gaps; an open gap closes with the live', async () => {
    const b = box();
    const made = await b.svc.createBroadcastFor({ sessionId: 'live-1', meta: META });
    await vi.advanceTimersByTimeAsync(HEALTH);
    b.g.streamStatus = 'inactive';
    await vi.advanceTimersByTimeAsync(2 * HEALTH);
    b.g.streamStatus = 'active';
    await vi.advanceTimersByTimeAsync(HEALTH);
    expect(b.gaps).toHaveLength(1);
    expect(Date.parse(b.gaps[0]!.to) - Date.parse(b.gaps[0]!.from)).toBe(20_000);
    // the internet goes: the health read fails, and the gap runs until the live is completed
    b.g.intercept = (c) => (c.path.endsWith('/liveStreams') && c.method === 'GET' ? 'network' : undefined);
    await vi.advanceTimersByTimeAsync(HEALTH);
    b.g.intercept = null;
    vi.setSystemTime(Date.now() + 45_000);
    await b.svc.complete(made.broadcastId);
    expect(b.gaps).toHaveLength(2);
    expect(b.gaps[1]).toMatchObject({ sessionId: 'live-1', kind: 'youtube', broadcastId: made.broadcastId });
    expect(Date.parse(b.gaps[1]!.to) - Date.parse(b.gaps[1]!.from)).toBe(45_000);
  });

  it('the cloud role records nothing (it holds no session record)', async () => {
    const b = box({ deps: { role: 'cloud' } });
    await b.svc.createBroadcastFor({ sessionId: 'boxid/live-1', meta: META });
    await vi.advanceTimersByTimeAsync(HEALTH);
    b.g.health = 'noData';
    await vi.advanceTimersByTimeAsync(3 * HEALTH);
    b.g.health = 'good';
    await vi.advanceTimersByTimeAsync(HEALTH);
    expect(b.gaps).toEqual([]);
  });
});

describe('Y8: a complete that failed is tried again without a box restart', () => {
  it('a network failure at complete is retried a minute later and then the broadcast is closed', async () => {
    const b = box();
    const made = await b.svc.createBroadcastFor({ sessionId: 's1', meta: META });
    b.g.intercept = (c) => (c.path.endsWith('/liveBroadcasts/transition') ? 'network' : undefined);
    await expect(b.svc.complete(made.broadcastId)).rejects.toMatchObject({ reason: 'network' });
    expect(b.svc.hasOpenBroadcast()).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.svc.hasOpenBroadcast()).toBe(true); // still no internet
    b.g.intercept = null;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.svc.hasOpenBroadcast()).toBe(false);
    expect(b.g.count('POST', '/liveBroadcasts/transition')).toBe(3);
    expect(b.svc.status()).toMatchObject({ state: 'complete', lastError: null });
    // nothing keeps running once it is closed
    const calls = b.g.calls.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(b.g.calls.length).toBe(calls);
  });

  it('a grant Google withdrew mid-live: the broadcast is closed right after the next sign-in', async () => {
    const b = box();
    const made = await b.svc.createBroadcastFor({ sessionId: 's1', meta: META });
    // every authorised call is refused and the refresh says invalid_grant: the grant is gone
    b.g.intercept = (c) => (c.path === '/token' ? googleJson(400, { error: 'invalid_grant' }) : c.path.startsWith('/youtube/') ? googleError(401, 'authError') : undefined);
    await expect(b.svc.complete(made.broadcastId)).rejects.toMatchObject({ reason: 'reauthorise' });
    expect(b.svc.signedIn()).toBe(false);
    expect(b.svc.hasOpenBroadcast()).toBe(true);
    // a person signs in again (device code): Google approves at the first look
    b.g.intercept = (c) => {
      if (c.path === '/device/code') return googleJson(200, { device_code: 'device-code-TEST', user_code: 'USER-1', expires_in: 1800, interval: 5 });
      if (c.path === '/token' && c.body.includes('device_code')) return googleJson(200, { access_token: 'access-new', refresh_token: 'refresh-new-TEST', expires_in: 3600 });
      return undefined;
    };
    await b.svc.begin('user:admin');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(b.svc.signedIn()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(b.svc.hasOpenBroadcast()).toBe(false);
  });

  it('a broadcast that is waiting to be closed is never handed to a new start of the same session', async () => {
    const b = box();
    const made = await b.svc.createBroadcastFor({ sessionId: 's1', meta: META });
    b.g.intercept = (c) => (c.path.endsWith('/liveBroadcasts/transition') ? 'network' : undefined);
    await expect(b.svc.complete(made.broadcastId)).rejects.toBeInstanceOf(YoutubeError);
    b.g.intercept = null;
    // the record survives a restart with its mark, and that start closes it
    const again = b.reopen();
    await again.recover();
    expect(again.hasOpenBroadcast()).toBe(false);
  });
});

describe('Y6, Y7, Y5: sign-out', () => {
  it('Y6: is refused with 409 while a broadcast is open (the linger after a stop), and goes through once it is closed', async () => {
    const b = box();
    const made = await b.svc.createBroadcastFor({ sessionId: 's1', meta: META });
    const refused = await b.svc.signout('user:admin').then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(LiveError);
    expect(refused).toMatchObject({ status: 409, code: 'youtube_broadcast_open', message: 'Siaran YouTube belum ditutup. Cuba lagi dalam beberapa minit.' });
    // nothing was dropped or revoked
    expect(b.svc.signedIn()).toBe(true);
    expect(existsSync(b.tokenPath)).toBe(true);
    expect(b.g.count('POST', '/revoke')).toBe(0);
    await b.svc.complete(made.broadcastId);
    await b.svc.signout('user:admin');
    expect(b.svc.signedIn()).toBe(false);
    expect(existsSync(b.tokenPath)).toBe(false);
  });

  it('a normal sign-out succeeds: token gone, Google asked to revoke, change log says revoked', async () => {
    const b = box();
    await b.svc.signout('user:admin');
    expect(b.svc.signedIn()).toBe(false);
    expect(b.svc.info()).toMatchObject({ state: 'signedOut', reason: 'signed_out' });
    expect(existsSync(b.tokenPath)).toBe(false);
    expect(existsSync(`${b.tokenPath}.tmp`)).toBe(false);
    const revoke = b.g.calls.filter((c) => c.path === '/revoke');
    expect(revoke).toHaveLength(1);
    expect(revoke[0]!.body).toContain(encodeURIComponent(TEST_REFRESH));
    expect(b.audit().at(-1)).toEqual({ entityId: 'signout', after: { revoked: true } });
    // the token never reaches the change log
    expect(JSON.stringify(b.db.prepare('SELECT * FROM change_log').all())).not.toContain(TEST_REFRESH);
  });

  it('Y7: a revoke Google did not confirm is written down, not hidden; the local sign-in is dropped all the same', async () => {
    const b = box();
    b.g.intercept = (c) => (c.path === '/revoke' ? 'network' : undefined);
    await b.svc.signout('user:admin');
    expect(existsSync(b.tokenPath)).toBe(false);
    expect(b.audit().at(-1)).toEqual({ entityId: 'signout', after: { revoked: false } });
  });

  it('Y6: a sign-in Google already withdrew can always be signed out, even with a broadcast it could not close', async () => {
    const b = box();
    const made = await b.svc.createBroadcastFor({ sessionId: 's1', meta: META });
    b.g.intercept = (c) => (c.path === '/token' ? googleJson(400, { error: 'invalid_grant' }) : c.path.startsWith('/youtube/') ? googleError(401, 'authError') : undefined);
    await expect(b.svc.complete(made.broadcastId)).rejects.toMatchObject({ reason: 'reauthorise' });
    await b.svc.signout('user:admin');
    expect(b.svc.hasOpenBroadcast()).toBe(false);
    expect(b.svc.info()).toMatchObject({ state: 'signedOut', reason: 'signed_out' });
  });

  it('Y7: after a sign-out no backup folder of any kind holds the token', async () => {
    // a data folder whose store was set aside at a link (kind `set-aside`): the backup carries the YouTube files
    const dir = mkdtempSync(join(tmpdir(), 'maxcom-yt-wipe-'));
    const put = (rel: string, body: string): void => {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), body);
    };
    openDb(join(dir, 'surau.db')).close();
    put('secret/youtube-token.json', 'sealed-old-token');
    put('secret/youtube-state.json', '{}');
    put('live/youtube-open.json', '{}');
    put('secret/follow.json', 'FOLLOW');
    planSetAside(dir, '0123456789abcdef0123456789abcdef', new Date('2026-11-20T01:41:00.000Z'), { release: '2026.11.15', dbLevel: 31 });
    expect(applyLinkJournalAtBoot(dir)).toBe('set-aside');
    const before = listBackups(dir);
    expect(before).toHaveLength(1);
    expect(before[0]!.manifest.kind).toBe('set-aside');
    expect(before[0]!.manifest.files.some((f) => f.path === 'secret/youtube-token.json')).toBe(true);

    const b = box({ dir });
    await b.svc.signout('user:admin');
    const after = listBackups(dir);
    expect(after).toHaveLength(1);
    expect(after[0]!.manifest.files.filter((f) => f.path.includes('youtube'))).toEqual([]);
    expect(b.audit().at(-1)!.after).toMatchObject({ revoked: true, backupFiles: 3 });
  });

  it('Y5: the box whose grant another box revoked at Google shows the re-sign-in state with its date, not a silent failure', async () => {
    // two boxes signed in to the same Google account: a sign-out on the first revokes the grant of both at Google
    const g = scriptedGoogle();
    const one = box({ g });
    const two = box({ g, token: { expiresAt: 0 } });
    await one.svc.signout('user:admin');
    g.intercept = (c) => (c.path === '/token' ? googleJson(400, { error: 'invalid_grant' }) : undefined);
    expect(await two.svc.verifyGrant()).toBe('revoked');
    expect(two.svc.info()).toMatchObject({ state: 'signedOut', reason: 'reauthorise', revokedAt: new Date().toISOString() });
    expect(two.audit().at(-1)).toMatchObject({ entityId: 'revoked' });
  });
});

describe('Y9: each cause a person can act on has its own reason and code', () => {
  it('maps the Google errors', () => {
    expect(failureOf(403, { error: { errors: [{ reason: 'liveStreamingNotEnabled' }] } }).reason).toBe('live_not_enabled');
    expect(failureOf(400, { error: { errors: [{ reason: 'invalidScheduledStartTime' }] } }).reason).toBe('clock_wrong');
    expect(failureOf(401, { error: 'invalid_client' }).reason).toBe('client_refused');
    expect(failureOf(401, { error: 'unauthorized_client' }).reason).toBe('client_refused');
    expect(failureOf(401, { error: 'deleted_client' }).reason).toBe('client_refused');
    // the ones from before are unchanged
    expect(failureOf(401, { error: { errors: [{ reason: 'authError' }] } }).reason).toBe('reauthorise');
    expect(failureOf(403, { error: { errors: [{ reason: 'quotaExceeded' }] } }).reason).toBe('quota');
    expect(failureOf(403, { error: { errors: [{ reason: 'forbidden' }] } }).reason).toBe('forbidden');
    expect(failureOf(503, null).reason).toBe('network');
  });

  it('a certificate that is not valid yet, or expired, is the box clock; any other fetch failure is the network', async () => {
    const tls = (code: string): Error => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('tls'), { code }) });
    expect(fetchFailure(tls('CERT_NOT_YET_VALID')).reason).toBe('clock_wrong');
    expect(fetchFailure(tls('CERT_HAS_EXPIRED')).reason).toBe('clock_wrong');
    expect(fetchFailure(tls('ECONNREFUSED')).reason).toBe('network');
    expect(fetchFailure(new TypeError('fetch failed')).reason).toBe('network');
    const failing = (async () => {
      throw tls('CERT_NOT_YET_VALID');
    }) as unknown as typeof fetch;
    await expect(googleRequest(failing, 'https://www.googleapis.com/youtube/v3/channels', {}, { timeoutMs: 1000 })).rejects.toMatchObject({ reason: 'clock_wrong' });
  });

  it('the wire codes are the frozen ones, each a 409', () => {
    expect(youtubeErrorCode('live_not_enabled')).toBe('youtube_live_not_enabled');
    expect(youtubeErrorCode('clock_wrong')).toBe('box_clock_wrong');
    expect(youtubeErrorCode('busy_other_box')).toBe('youtube_busy_other_box');
    expect(youtubeErrorCode('client_refused')).toBe('youtube_client_refused');
    expect(youtubeErrorCode('quota')).toBe('youtube_quota');
    for (const r of ['live_not_enabled', 'clock_wrong', 'busy_other_box', 'client_refused'] as const) expect(youtubeErrorStatus(r)).toBe(409);
    expect(youtubeErrorStatus('quota')).toBe(429);
    expect(youtubeErrorStatus('network')).toBe(502);
  });

  it('a start on a channel without live streaming fails with that reason, leaves nothing half-made, and the status shows it', async () => {
    const b = box();
    b.g.intercept = (c) => (c.method === 'POST' && c.path.endsWith('/liveBroadcasts') ? googleError(403, 'liveStreamingNotEnabled') : undefined);
    await expect(b.svc.createBroadcastFor({ sessionId: 's1', meta: META })).rejects.toMatchObject({ reason: 'live_not_enabled' });
    expect(b.svc.status()).toMatchObject({ state: 'error', lastError: 'live_not_enabled' });
    expect(b.g.count('DELETE', '/liveStreams')).toBe(1);
    expect(b.svc.hasOpenBroadcast()).toBe(false);
  });

  it('a refused client file at the token refresh reads as client_refused, and the sign-in is kept', async () => {
    const b = box({ token: { expiresAt: 0 } });
    b.g.intercept = (c) => (c.path === '/token' ? googleJson(401, { error: 'invalid_client' }) : undefined);
    expect(await b.svc.probe()).toBe('client_refused');
    expect(b.svc.signedIn()).toBe(true);
    expect(existsSync(b.tokenPath)).toBe(true);
  });
});

describe('Y11: one live per YouTube channel between linked boxes', () => {
  const peer = (channelId: string | null): YoutubeOpenBroadcast => ({ boxId: 'box-two', channelId, broadcastId: 'bc-peer' });

  it('a peer on the SAME channel with a broadcast open refuses the start; when it has ended the start goes through', async () => {
    const b = box();
    let answers: YoutubeOpenBroadcast[] = [peer(TEST_CHANNEL)];
    b.svc.setPeersOpen(async () => answers);
    expect(await b.svc.busyOnPeer()).toBe(true);
    await expect(b.svc.createBroadcastFor({ sessionId: 's1', meta: META })).rejects.toMatchObject({ reason: 'busy_other_box', status: 409 });
    // nothing was made at Google
    expect(b.g.count('POST', '/liveStreams')).toBe(0);
    expect(b.svc.status().lastError).toBe('busy_other_box');
    answers = [];
    expect(await b.svc.busyOnPeer()).toBe(false);
    const made = await b.svc.createBroadcastFor({ sessionId: 's1', meta: META });
    expect(made.broadcastId).toBe('bc-1');
    expect(b.svc.status().lastError).toBeNull();
  });

  it('boxes on DIFFERENT channels never block each other, nor does a peer whose channel is unknown', async () => {
    const b = box();
    b.svc.setPeersOpen(async () => [peer('UC-box-two'), peer(null)]);
    expect(await b.svc.busyOnPeer()).toBe(false);
    await expect(b.svc.createBroadcastFor({ sessionId: 's1', meta: META })).resolves.toMatchObject({ broadcastId: 'bc-1' });
  });

  it('a box that does not know its own channel id, a peer that fails and a peer that never answers do not block', async () => {
    const unknown = box({ token: { channelId: '' } });
    unknown.svc.setPeersOpen(async () => [peer(TEST_CHANNEL), peer('')]);
    expect(await unknown.svc.busyOnPeer()).toBe(false);

    const b = box();
    b.svc.setPeersOpen(async () => {
      throw new Error('peer down');
    });
    expect(await b.svc.busyOnPeer()).toBe(false);
    b.svc.setPeersOpen(() => new Promise(() => undefined));
    const asked = b.svc.busyOnPeer();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await asked).toBe(false);
  });

  it('a retry of a session whose broadcast exists is not asked again, and this box answers a peer with its own open broadcast', async () => {
    const b = box();
    expect(b.svc.openBroadcast()).toBeNull();
    const made = await b.svc.createBroadcastFor({ sessionId: 's1', meta: META });
    expect(b.svc.openBroadcast()).toEqual({ channelId: TEST_CHANNEL, broadcastId: made.broadcastId });
    b.svc.setPeersOpen(async () => [peer(TEST_CHANNEL)]);
    await expect(b.svc.createBroadcastFor({ sessionId: 's1', meta: META })).resolves.toMatchObject({ broadcastId: made.broadcastId });
    await b.svc.complete(made.broadcastId);
    expect(b.svc.openBroadcast()).toBeNull();
  });
});
