// qs-gate round 1, security scope: the YouTube sign-in code only for live:settings callers (S6), Google's own device
// address only (S8), and a camera password in the address query never reaches the cloud backup, a masked view or the
// history (S7).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CAMERA_PASSWORD_MASK, GOOGLE_DEVICE_URL, maskCameraUrl, restoreMaskedCameraQuery, stripCameraQuerySecrets } from '@surau/core';
import type { YoutubeSignInState } from '@surau/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthIdentity } from '../src/auth/authz.ts';
import { CameraStore, cameraBackupOf, cameraSecrets } from '../src/live/camera.ts';
import { signInForCaller } from '../src/live/routes.ts';
import { cleanCameraRecord } from '../src/sync/cameraSecretCloud.ts';
import { generateSyncKeyPair, saveSyncKey } from '../src/sync/syncKey.ts';
import { RemoteYoutubeLeg } from '../src/sync/youtubeRemote.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'surau-gater1-'));
  dirs.push(d);
  return d;
};

const user = (roles: string[]): AuthIdentity => ({ kind: 'user', userId: 'u', deviceId: 'd', roles, sessionId: 's', ops: false }) as AuthIdentity;
const pending: YoutubeSignInState = { state: 'pending', userCode: 'ABCD-EFGH', verificationUrl: GOOGLE_DEVICE_URL, expiresAt: '2026-11-19T10:00:00.000Z' };

describe('S6: the pending sign-in code goes only to callers holding live:settings', () => {
  it('live:settings sees the code; a caller without it sees only that a sign-in is waiting', () => {
    expect(signInForCaller(user(['live']), pending)).toEqual(pending);
    expect(signInForCaller(user(['admin']), pending)).toEqual(pending);
    expect(signInForCaller(user(['ajk']), pending)).toEqual({ state: 'pending' });
    expect(signInForCaller(null, pending)).toEqual({ state: 'pending' });
    // outcomes and nothing are shown as they are
    expect(signInForCaller(user(['ajk']), { state: 'expired' })).toEqual({ state: 'expired' });
    expect(signInForCaller(user(['ajk']), null)).toBeNull();
  });
});

describe('S8: the device address is always Google\'s own', () => {
  it('a cloud status naming another address is passed on with https://www.google.com/device', async () => {
    const dataDir = tempDir();
    const pair = generateSyncKeyPair();
    saveSyncKey(dataDir, { ...pair, cloudUrl: 'https://cloud.example.test', siteToken: 'site-token', wakeSecret: 'w', linkedAt: '2026-11-05T00:00:00.000Z' });
    const db = new DatabaseSync(':memory:');
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ signedIn: false, state: 'none', signIn: { state: 'pending', userCode: 'WXYZ-1234', verificationUrl: 'https://evil.example/device', expiresAt: '2026-11-19T10:00:00.000Z' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const leg = new RemoteYoutubeLeg({ db, dataDir, now: () => new Date(), fetchImpl, bootRetryMs: 3_600_000 });
    try {
      await leg.refresh();
      expect(leg.status().signIn).toEqual({ state: 'pending', userCode: 'WXYZ-1234', verificationUrl: 'https://www.google.com/device', expiresAt: '2026-11-19T10:00:00.000Z' });
    } finally {
      leg.stop();
      db.close();
    }
  });
});

describe('S7: a password in the camera address query', () => {
  const URL_Q = 'rtsp://10.168.1.20:554/cam/realmonitor?channel=1&user=admin&Password=Rahsia99&subtype=0';

  it('core: masked for display, removed for the backup, put back only for the same address', () => {
    expect(maskCameraUrl(URL_Q)).toBe(`rtsp://10.168.1.20:554/cam/realmonitor?channel=1&user=admin&Password=${CAMERA_PASSWORD_MASK}&subtype=0`);
    expect(maskCameraUrl('rtsp://a:b@10.168.1.20/x?pwd=1&PASS=2&passwd=3&pass=')).toBe(`rtsp://a:${CAMERA_PASSWORD_MASK}@10.168.1.20/x?pwd=${CAMERA_PASSWORD_MASK}&PASS=${CAMERA_PASSWORD_MASK}&passwd=${CAMERA_PASSWORD_MASK}&pass=`);
    expect(stripCameraQuerySecrets(URL_Q)).toEqual({ url: 'rtsp://10.168.1.20:554/cam/realmonitor?channel=1&user=admin&subtype=0', had: true });
    expect(stripCameraQuerySecrets('rtsp://10.168.1.20/x?password=')).toEqual({ url: 'rtsp://10.168.1.20/x', had: false });
    expect(stripCameraQuerySecrets('rtsp://10.168.1.20/x')).toEqual({ url: 'rtsp://10.168.1.20/x', had: false });
    const masked = maskCameraUrl(URL_Q);
    expect(restoreMaskedCameraQuery(masked, URL_Q)).toBe(URL_Q);
    // another host, path or other parameter: not put back
    expect(restoreMaskedCameraQuery(masked.replace('10.168.1.20', '10.168.1.21'), URL_Q)).toBeNull();
    expect(restoreMaskedCameraQuery(masked.replace('channel=1', 'channel=2'), URL_Q)).toBeNull();
  });

  it('the box: backup, masked view and history never hold it; re-saving the masked address keeps it; the redactor knows it', async () => {
    const dataDir = tempDir();
    const store = new CameraStore(dataDir);
    const shown = store.save({ url: URL_Q });
    expect(shown.url).not.toContain('Rahsia99');
    expect(JSON.stringify(store.getMasked())).not.toContain('Rahsia99');
    const b = store.backup()!;
    expect(b.url).toBe('rtsp://10.168.1.20:554/cam/realmonitor?channel=1&user=admin&subtype=0');
    expect(b.hasPassword).toBe(true);
    expect(JSON.stringify(cameraBackupOf({ url: URL_Q }))).not.toContain('Rahsia99');
    expect(cameraSecrets({ url: URL_Q })).toContain('Rahsia99');
    // the box keeps the full address
    expect(store.get()?.url).toBe(URL_Q);
    // saving back what the app showed keeps the stored password
    store.save({ url: shown.url });
    expect(store.get()?.url).toBe(URL_Q);
    // dots for another address are not filled in
    expect(() => store.save({ url: shown.url.replace('/cam/', '/other/') })).toThrow(expect.objectContaining({ code: 'password_again' }));
  });

  it('the cloud: a record sent with a query password is stored without it', () => {
    const rec = cleanCameraRecord({ url: URL_Q });
    expect(rec).toEqual({ url: 'rtsp://10.168.1.20:554/cam/realmonitor?channel=1&user=admin&subtype=0', hasPassword: true });
  });
});
