import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createYoutubeService } from '../src/live/youtube/api.ts';
import { OUTCOME_TTL_MS, YoutubeAuth } from '../src/live/youtube/oauth.ts';
import type { YoutubeAuthDeps } from '../src/live/youtube/oauth.ts';

/**
 * The server carries the YouTube device-code sign-in itself (release 2026.11.13): Google is polled on a timer, no
 * app has to call `/signin/poll`, and a grant that was stored is kept for good.
 * A fake Google answers by script; the clock is vitest's (timers and Date move together).
 */

const DEVICE = 'device-code-SECRET-xyz';
const REFRESH = 'refresh-SECRET-xyz';

interface Script {
  /** Answers of `/token` for the device-code grant, in order; the last one repeats. */
  deviceAnswers: Array<{ status: number; body: Record<string, unknown> }>;
  /** Answer for the refresh grant. */
  refresh: { status: number; body: Record<string, unknown> };
  /** Status codes the videos endpoint answers with, in order (then 200). */
  videos: number[];
  deviceCodes: string[];
  calls: Array<{ path: string; form: URLSearchParams }>;
}

function fakeGoogle(): { script: Script; fetchImpl: typeof fetch } {
  const script: Script = {
    deviceAnswers: [{ status: 428, body: { error: 'authorization_pending' } }],
    refresh: { status: 200, body: { access_token: 'access-2', expires_in: 3600 } },
    videos: [],
    deviceCodes: [DEVICE],
    calls: [],
  };
  let deviceIdx = 0;
  let deviceN = 0;
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    script.calls.push({ path: u.pathname, form });
    if (u.pathname === '/device/code') {
      deviceN++;
      const code = script.deviceCodes[deviceN - 1] ?? `${DEVICE}-${deviceN}`;
      return json(200, { device_code: code, user_code: `USER-${deviceN}`, verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 });
    }
    if (u.pathname === '/token') {
      if (form.get('grant_type') === 'refresh_token') return json(script.refresh.status, script.refresh.body);
      const a = script.deviceAnswers[Math.min(deviceIdx, script.deviceAnswers.length - 1)]!;
      deviceIdx++;
      return json(a.status, a.body);
    }
    if (u.pathname === '/youtube/v3/channels') return json(200, { items: [{ id: 'UC-1', snippet: { title: 'Surau Satu' } }] });
    if (u.pathname === '/youtube/v3/videos') {
      const s = script.videos.shift() ?? 200;
      return s === 200 ? json(200, { items: [{ id: 'v1', status: { privacyStatus: 'public', uploadStatus: 'processed' } }] }) : json(s, { error: { errors: [{ reason: 'authError' }] } });
    }
    return json(404, {});
  }) as typeof fetch;
  return { script, fetchImpl };
}

const APPROVED = { status: 200, body: { access_token: 'access-1', refresh_token: REFRESH, expires_in: 3600, scope: 'https://www.googleapis.com/auth/youtube' } };
const PENDING = { status: 428, body: { error: 'authorization_pending' } };

let dir = '';
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-19T08:00:00Z'));
  dir = mkdtempSync(join(tmpdir(), 'yt-signin-'));
  mkdirSync(join(dir, 'secret'), { recursive: true });
  writeFileSync(join(dir, 'secret', 'youtube-client.json'), JSON.stringify({ client_id: 'cid.apps.googleusercontent.com', client_secret: 'csecret-SECRET' }));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function auth(g: ReturnType<typeof fakeGoogle>, extra: Partial<YoutubeAuthDeps> = {}): YoutubeAuth {
  return new YoutubeAuth({ dataDir: dir, fetchImpl: g.fetchImpl, now: () => new Date(), ...extra });
}
const tokenCalls = (g: ReturnType<typeof fakeGoogle>): number => g.script.calls.filter((c) => c.path === '/token' && c.form.get('grant_type') !== 'refresh_token').length;

describe('the server completes the sign-in itself', () => {
  it('an approval is picked up with no app poll: signed in, token stored, the change-log hook fires once', async () => {
    const g = fakeGoogle();
    g.script.deviceAnswers = [PENDING, PENDING, APPROVED];
    const signedIn = vi.fn();
    const a = auth(g, { onSignedIn: signedIn });
    await a.begin();
    expect(a.signInState()).toMatchObject({ state: 'pending', userCode: 'USER-1', verificationUrl: 'https://www.google.com/device' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(a.signedIn()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(a.signedIn()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(a.signedIn()).toBe(true);
    expect(a.channelTitle()).toBe('Surau Satu');
    expect(a.signInState()).toBeNull();
    expect(signedIn).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, 'secret', 'youtube-token.json'))).toBe(true);
    // nothing runs once it is done
    expect(vi.getTimerCount()).toBe(0);
    const before = tokenCalls(g);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tokenCalls(g)).toBe(before);
    a.shutdown();
  });

  it('the poll route does not exchange twice: it reports what the server holds', async () => {
    const g = fakeGoogle();
    g.script.deviceAnswers = [APPROVED];
    const a = auth(g);
    await a.begin();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tokenCalls(g)).toBe(1);
    expect(await a.poll()).toMatchObject({ state: 'signed_in', signedIn: true, channelTitle: 'Surau Satu' });
    expect(tokenCalls(g)).toBe(1);
    a.shutdown();
  });

  it('slow_down widens the interval by 5 s', async () => {
    const g = fakeGoogle();
    g.script.deviceAnswers = [{ status: 400, body: { error: 'slow_down' } }, PENDING];
    const a = auth(g);
    await a.begin();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tokenCalls(g)).toBe(1);
    // the next look is 10 s after the slow_down, not 5
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tokenCalls(g)).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tokenCalls(g)).toBe(2);
    a.shutdown();
  });

  it('denied ends the pending state, is reported, stops polling, and is forgotten after a while', async () => {
    const g = fakeGoogle();
    g.script.deviceAnswers = [{ status: 403, body: { error: 'access_denied' } }];
    const a = auth(g);
    await a.begin();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(a.signInState()).toEqual({ state: 'denied' });
    expect(a.signedIn()).toBe(false);
    expect(await a.poll()).toMatchObject({ state: 'denied', signedIn: false });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(OUTCOME_TTL_MS - 10_000);
    expect(tokenCalls(g)).toBe(1);
    expect(a.signInState()).toEqual({ state: 'denied' });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(a.signInState()).toBeNull();
    a.shutdown();
  });

  it('expired_token and running out of time both end it as expired', async () => {
    const g = fakeGoogle();
    g.script.deviceAnswers = [{ status: 400, body: { error: 'expired_token' } }];
    const a = auth(g);
    await a.begin();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(a.signInState()).toEqual({ state: 'expired' });
    const g2 = fakeGoogle();
    g2.script.deviceAnswers = [PENDING];
    const b = auth(g2);
    await b.begin();
    await vi.advanceTimersByTimeAsync(1_805_000);
    expect(b.signInState()).toEqual({ state: 'expired' });
    expect(b.signedIn()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    a.shutdown();
    b.shutdown();
  });

  it('a second start replaces the first: the old code is never polled again', async () => {
    const g = fakeGoogle();
    g.script.deviceAnswers = [PENDING];
    const a = auth(g);
    await a.begin();
    await vi.advanceTimersByTimeAsync(5_000);
    await a.begin();
    expect(a.signInState()).toMatchObject({ state: 'pending', userCode: 'USER-2' });
    await vi.advanceTimersByTimeAsync(10_000);
    const tokens = g.script.calls.filter((c) => c.path === '/token');
    expect(tokens[0]!.form.get('device_code')).toBe(DEVICE);
    expect(tokens.slice(1).every((c) => c.form.get('device_code') === `${DEVICE}-2`)).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    a.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shutdown clears the timer, and a pending sign-in leaves no handle behind', async () => {
    const g = fakeGoogle();
    const a = auth(g);
    await a.begin();
    expect(vi.getTimerCount()).toBe(1);
    a.shutdown();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tokenCalls(g)).toBe(0);
  });

  it('what a status read shows never holds the device code, a token or the client secret', async () => {
    const g = fakeGoogle();
    g.script.deviceAnswers = [PENDING, APPROVED];
    const a = auth(g);
    await a.begin();
    const seen = [JSON.stringify(a.signInState()), JSON.stringify(await a.poll())];
    await vi.advanceTimersByTimeAsync(10_000);
    seen.push(JSON.stringify(a.signInState()), JSON.stringify(await a.poll()));
    const all = seen.join('\n');
    for (const secret of [DEVICE, REFRESH, 'access-1', 'csecret-SECRET']) expect(all).not.toContain(secret);
    a.shutdown();
  });
});

describe('a stored grant is kept for good', () => {
  async function signedInDir(): Promise<void> {
    const g = fakeGoogle();
    g.script.deviceAnswers = [APPROVED];
    const a = auth(g);
    await a.begin();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(a.signedIn()).toBe(true);
    a.shutdown();
  }

  it('a restart with a stored grant is signed in at once, with no call to Google and no user action', async () => {
    await signedInDir();
    const g = fakeGoogle();
    const again = auth(g);
    expect(again.signedIn()).toBe(true);
    expect(again.channelTitle()).toBe('Surau Satu');
    expect(g.script.calls).toHaveLength(0);
    again.shutdown();
  });

  it('an expired access token is refreshed silently and the sign-in stays', async () => {
    await signedInDir();
    const g = fakeGoogle();
    const a = auth(g);
    await vi.advanceTimersByTimeAsync(3_700_000);
    expect(await a.accessToken()).toBe('access-2');
    expect(a.signedIn()).toBe(true);
    expect(g.script.calls.filter((c) => c.form.get('grant_type') === 'refresh_token')).toHaveLength(1);
    // and the refreshed token is used until it nears its end
    expect(await a.accessToken()).toBe('access-2');
    expect(g.script.calls.filter((c) => c.form.get('grant_type') === 'refresh_token')).toHaveLength(1);
    a.shutdown();
  });

  it('invalid_grant marks the sign-in revoked once and the box stops asking Google', async () => {
    await signedInDir();
    const g = fakeGoogle();
    g.script.refresh = { status: 400, body: { error: 'invalid_grant' } };
    const a = auth(g);
    await vi.advanceTimersByTimeAsync(3_700_000);
    await expect(a.accessToken()).rejects.toMatchObject({ reason: 'reauthorise' });
    expect(a.signedIn()).toBe(false);
    expect(a.lastError()).toBe('reauthorise');
    const asked = g.script.calls.length;
    for (let i = 0; i < 3; i++) await expect(a.accessToken()).rejects.toMatchObject({ reason: 'reauthorise' });
    expect(g.script.calls.length).toBe(asked);
    // the stored grant is not deleted by it: only a new sign-in or an explicit sign-out replaces it
    expect(existsSync(join(dir, 'secret', 'youtube-token.json'))).toBe(true);
    a.shutdown();
  });

  it('a network failure on refresh keeps the sign-in and is tried again later', async () => {
    await signedInDir();
    const g = fakeGoogle();
    g.script.refresh = { status: 503, body: {} };
    const a = auth(g);
    await vi.advanceTimersByTimeAsync(3_700_000);
    await expect(a.accessToken()).rejects.toMatchObject({ reason: 'network' });
    expect(a.signedIn()).toBe(true);
    g.script.refresh = { status: 200, body: { access_token: 'access-3', expires_in: 3600 } };
    expect(await a.accessToken()).toBe('access-3');
    a.shutdown();
  });

  it('a 401 from YouTube refreshes the access token once and repeats the call; no sign-out', async () => {
    await signedInDir();
    const g = fakeGoogle();
    g.script.videos = [401];
    const svc = createYoutubeService({ db: new DatabaseSync(':memory:'), dataDir: dir, fetchImpl: g.fetchImpl, now: () => new Date() });
    const v = await svc.videoStatus('v1');
    expect(v).toMatchObject({ privacyStatus: 'public' });
    expect(svc.signedIn()).toBe(true);
    expect(g.script.calls.filter((c) => c.form.get('grant_type') === 'refresh_token')).toHaveLength(1);
    expect(g.script.calls.filter((c) => c.path === '/youtube/v3/videos')).toHaveLength(2);
    svc.shutdown();
  });

  it('a second 401 in a row is reported, not looped on', async () => {
    await signedInDir();
    const g = fakeGoogle();
    g.script.videos = [401, 401];
    const svc = createYoutubeService({ db: new DatabaseSync(':memory:'), dataDir: dir, fetchImpl: g.fetchImpl, now: () => new Date() });
    await expect(svc.videoStatus('v1')).rejects.toMatchObject({ reason: 'reauthorise' });
    expect(g.script.calls.filter((c) => c.path === '/youtube/v3/videos')).toHaveLength(2);
    svc.shutdown();
  });

  it('only an explicit sign-out removes the grant', async () => {
    await signedInDir();
    const g = fakeGoogle();
    const a = auth(g);
    await a.signout();
    expect(existsSync(join(dir, 'secret', 'youtube-token.json'))).toBe(false);
    expect(a.signedIn()).toBe(false);
    a.shutdown();
  });
});
