import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
// The box-server auth modules are imported by relative path: the client and the verifier must
// agree byte for byte, so the test runs the real server-side code (no copied vectors).
import { verifyP256 } from '../../../apps/box-server/src/auth/crypto.ts';
import { beginEnrolment, completeEnrolment, getDeviceWithKey, revokeDevice } from '../../../apps/box-server/src/auth/devices.ts';
import { issueChallenge, resolveSession, unlock as serverUnlock } from '../../../apps/box-server/src/auth/sessions.ts';
import { AuthError, createUser } from '../../../apps/box-server/src/auth/users.ts';
import { openDb } from '../../../apps/box-server/src/db.ts';
import { putFeature } from '../../../apps/box-server/src/settingsStore.ts';
import {
  ClientError,
  PinRequiredError,
  SessionExpiredError,
  authedFetch,
  enrol,
  memoryKeyStore,
  parseEnrolPayload,
  toBase64Url,
  unlock,
} from '../src/index.ts';
import type { EnrolPayload, FetchLike } from '../src/index.ts';

const BOX = 'https://10.168.0.154:8443';
const BOX_ID = '0123456789abcdef';
const PIN = '280419';

function payloadString(over: Partial<EnrolPayload> & { code: string }): string {
  const body = { v: 1, mode: 'ip', box: BOX, boxId: BOX_ID, caSha256: null, user: 'Admin', exp: Date.now() + 600_000, ...over };
  return 'surau1:' + Buffer.from(JSON.stringify(body)).toString('base64url');
}

/** A tiny in-process box: the real auth functions behind the HTTP paths the client uses. */
function fakeBox(db: DatabaseSync, seen: { signatures: string[]; auth: (string | null)[] } = { signatures: [], auth: [] }): FetchLike {
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return async (input, init) => {
    const url = new URL(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    try {
      if (url.pathname === '/api/enrol/complete') {
        return json(200, completeEnrolment(db, body as never, '127.0.0.1'));
      }
      if (url.pathname === '/api/auth/challenge') {
        return json(200, issueChallenge(db, String(body.deviceId), new Date()));
      }
      if (url.pathname === '/api/auth/unlock') {
        seen.signatures.push(String(body.signature));
        return json(200, await serverUnlock(db, BOX_ID, body as never, '127.0.0.1', new Date()));
      }
      if (url.pathname === '/api/auth/me') {
        const h = new Headers(init?.headers).get('authorization');
        seen.auth.push(h);
        const ctx = resolveSession(db, (h ?? '').replace(/^Bearer /, ''), new Date());
        return ctx === null ? json(401, { message: 'Sesi tamat' }) : json(200, { roles: ctx.roles });
      }
      return json(404, { message: 'tiada' });
    } catch (e) {
      if (e instanceof AuthError) {
        return json(e.status, e.code === 'pin_required' ? { message: e.message, pinRequired: true } : { message: e.message });
      }
      throw e;
    }
  };
}

/** `lock`: switch the app lock on first (it is off by default since Plan 5, and then the PIN step is skipped). */
function setup(lock = false) {
  const db = openDb(':memory:');
  if (lock) putFeature(db, 'appLock', { enabled: true }, 'local');
  const admin = createUser(db, { name: 'Admin', roles: ['admin'] }, 'local');
  const code = beginEnrolment(db, { userId: admin.id, deviceName: 'Telefon' }, 'local').code;
  const seen = { signatures: [] as string[], auth: [] as (string | null)[] };
  return { db, admin, code, fetchImpl: fakeBox(db, seen), keys: memoryKeyStore(), seen };
}

describe('device client against the real box auth code', () => {
  it('enrol -> unlock -> authedFetch /api/auth/me gives the admin role', async () => {
    const { code, fetchImpl, keys, seen } = setup();
    const payload = parseEnrolPayload(payloadString({ code }));
    const enrolled = await enrol(payload, { deviceName: 'Telefon', platform: 'android', pin: PIN, fetchImpl, keys });
    expect(enrolled.roles).toEqual(['admin']);
    expect(enrolled.pinRequired).toBe(false);

    const session = await unlock(payload.box, enrolled.deviceId, PIN, { boxId: payload.boxId, fetchImpl, keys });
    expect(session.user.roles).toEqual(['admin']);
    const me = await authedFetch(session, '/api/auth/me');
    expect((await me.json()) as { roles: string[] }).toEqual({ roles: ['admin'] });
    expect(seen.auth[0]).toBe(`Bearer ${session.token}`);
  });

  it('the client signature is exactly what verifyP256 accepts (P1363, base64url, message layout)', async () => {
    const { db, code, fetchImpl, keys } = setup();
    const payload = parseEnrolPayload(payloadString({ code }));
    const { deviceId } = await enrol(payload, { deviceName: 'T', platform: 'web', pin: PIN, fetchImpl, keys });

    // Drive the handshake by hand with the client's key so the nonce and signature are visible.
    const pair = (await keys.get())!;
    const { nonce } = issueChallenge(db, deviceId, new Date());
    const message = Buffer.from(`surau-unlock\n${BOX_ID}\n${deviceId}\n${nonce}`, 'utf8');
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, message));
    expect(sig.length).toBe(64);
    const encoded = toBase64Url(sig);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]{86}$/);

    const jwk = getDeviceWithKey(db, deviceId)!.publicJwk!;
    expect(verifyP256(jwk, message, Buffer.from(encoded, 'base64url'))).toBe(true);
    // A different box id, device or nonce must not verify.
    const other = Buffer.from(`surau-unlock\nffffffffffffffff\n${deviceId}\n${nonce}`, 'utf8');
    expect(verifyP256(jwk, other, Buffer.from(encoded, 'base64url'))).toBe(false);
  });

  it('unlock() output verifies on the server for the signature it actually sent', async () => {
    const { db, code, fetchImpl, keys, seen } = setup();
    const payload = parseEnrolPayload(payloadString({ code }));
    const { deviceId } = await enrol(payload, { deviceName: 'T', platform: 'web', pin: PIN, fetchImpl, keys });
    await unlock(payload.box, deviceId, PIN, { boxId: BOX_ID, fetchImpl, keys });
    expect(seen.signatures).toHaveLength(1);
    expect(seen.signatures[0]).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()?.n).toBe(1);
  });

  it('with the app lock off a wrong PIN still signs in by the device key', async () => {
    const { code, fetchImpl, keys } = setup();
    const payload = parseEnrolPayload(payloadString({ code }));
    const { deviceId } = await enrol(payload, { deviceName: 'T', platform: 'web', pin: PIN, fetchImpl, keys });
    const session = await unlock(payload.box, deviceId, '135790', { boxId: BOX_ID, fetchImpl, keys });
    expect((await authedFetch(session, '/api/auth/me')).status).toBe(200);
  });

  it('a wrong PIN rejects with the BM message', async () => {
    const { code, fetchImpl, keys } = setup(true);
    const payload = parseEnrolPayload(payloadString({ code }));
    const { deviceId } = await enrol(payload, { deviceName: 'T', platform: 'web', pin: PIN, fetchImpl, keys });
    const attempt = unlock(payload.box, deviceId, '135790', { boxId: BOX_ID, fetchImpl, keys });
    await expect(attempt).rejects.toThrow('PIN salah');
    await expect(attempt).rejects.toBeInstanceOf(ClientError);
  });

  it('after an admin PIN reset: unlock with a PIN says pinRequired, unlock with newPin signs in', async () => {
    const { db, admin, code, fetchImpl, keys } = setup(true);
    const payload = parseEnrolPayload(payloadString({ code }));
    const { deviceId } = await enrol(payload, { deviceName: 'T', platform: 'web', pin: PIN, fetchImpl, keys });
    const old = await unlock(payload.box, deviceId, PIN, { boxId: BOX_ID, fetchImpl, keys });
    db.prepare('UPDATE users SET pin_hash = NULL WHERE id = ?').run(admin.id);
    db.prepare('UPDATE sessions SET revoked_at = ?').run(new Date().toISOString());
    const need = unlock(payload.box, deviceId, PIN, { boxId: BOX_ID, fetchImpl, keys });
    await expect(need).rejects.toBeInstanceOf(PinRequiredError);
    await expect(need).rejects.toMatchObject({ status: 409 });
    const fresh = await unlock(payload.box, deviceId, '', { boxId: BOX_ID, fetchImpl, keys, newPin: '739204' });
    expect((await authedFetch(fresh, '/api/auth/me')).status).toBe(200);
    await expect(authedFetch(old, '/api/auth/me')).rejects.toBeInstanceOf(SessionExpiredError);
    // The new PIN now works the ordinary way.
    await unlock(payload.box, deviceId, '739204', { boxId: BOX_ID, fetchImpl, keys });
  });

  it('a revoked device is refused with the revoked message', async () => {
    const { db, code, fetchImpl, keys } = setup();
    const payload = parseEnrolPayload(payloadString({ code }));
    const { deviceId } = await enrol(payload, { deviceName: 'T', platform: 'web', pin: PIN, fetchImpl, keys });
    revokeDevice(db, deviceId, 'local');
    await expect(unlock(payload.box, deviceId, PIN, { boxId: BOX_ID, fetchImpl, keys })).rejects.toThrow(/dibatalkan/);
  });

  it('a 401 from the box surfaces as SessionExpiredError', async () => {
    const { db, code, fetchImpl, keys } = setup();
    const payload = parseEnrolPayload(payloadString({ code }));
    const { deviceId } = await enrol(payload, { deviceName: 'T', platform: 'web', pin: PIN, fetchImpl, keys });
    const session = await unlock(payload.box, deviceId, PIN, { boxId: BOX_ID, fetchImpl, keys });
    revokeDevice(db, deviceId, 'local');
    await expect(authedFetch(session, '/api/auth/me')).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('the private key is non-extractable and the public JWK sent carries no private part', async () => {
    const { code, fetchImpl, keys, db } = setup();
    const payload = parseEnrolPayload(payloadString({ code }));
    const { deviceId } = await enrol(payload, { deviceName: 'T', platform: 'web', pin: PIN, fetchImpl, keys });
    const pair = (await keys.get())!;
    expect(pair.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('jwk', pair.privateKey)).rejects.toThrow();
    const stored = getDeviceWithKey(db, deviceId)!.publicJwk!;
    expect(Object.keys(stored).sort()).toEqual(['crv', 'kty', 'x', 'y']);
  });

  it('keeps no key when the box refuses the enrolment', async () => {
    const { fetchImpl, keys } = setup();
    const payload = parseEnrolPayload(payloadString({ code: 'AAAA-BBBB-CCCC' }));
    await expect(enrol(payload, { deviceName: 'T', platform: 'web', fetchImpl, keys })).rejects.toThrow(/Kod pendaftaran/);
    expect(await keys.get()).toBeNull();
  });

  it('refuses an expired payload without contacting the box', async () => {
    const { fetchImpl, keys } = setup();
    const payload = parseEnrolPayload(payloadString({ code: 'AAAA-BBBB-CCCC', exp: Date.now() - 1000 }));
    await expect(enrol(payload, { deviceName: 'T', platform: 'web', fetchImpl, keys })).rejects.toThrow(/tamat/);
  });
});

describe('parseEnrolPayload', () => {
  const good = payloadString({ code: 'ABCD-2345-WXYZ' });

  it('accepts a valid payload and normalises the box origin', () => {
    const p = parseEnrolPayload(good);
    expect(p).toMatchObject({ v: 1, mode: 'ip', box: BOX, boxId: BOX_ID, code: 'ABCD-2345-WXYZ' });
  });

  it('rejects plain http on a LAN address but allows loopback', () => {
    expect(() => parseEnrolPayload(payloadString({ code: 'ABCD-2345-WXYZ', box: 'http://10.168.0.154' }))).toThrow();
    expect(() => parseEnrolPayload(payloadString({ code: 'ABCD-2345-WXYZ', box: 'http://127.0.0.1:8787' }))).not.toThrow();
    expect(() => parseEnrolPayload(payloadString({ code: 'ABCD-2345-WXYZ', box: 'http://localhost:8787' }))).not.toThrow();
  });

  it('rejects other schemes, credentials, paths and queries in box', () => {
    for (const box of ['ftp://10.168.0.154', 'https://u:p@10.168.0.154:8443', 'https://10.168.0.154:8443/x', 'https://10.168.0.154:8443/?a=1']) {
      expect(() => parseEnrolPayload(payloadString({ code: 'ABCD-2345-WXYZ', box }))).toThrow();
    }
  });

  it('rejects a tampered base64, wrong prefix and bad fields', () => {
    expect(() => parseEnrolPayload(good.slice(0, -3) + '!!!')).toThrow();
    expect(() => parseEnrolPayload(good.slice(0, -1))).toThrow();
    expect(() => parseEnrolPayload(good.replace('surau1:', 'surau2:'))).toThrow();
    expect(() => parseEnrolPayload('surau1:' + Buffer.from('not json').toString('base64url'))).toThrow();
    expect(() => parseEnrolPayload('surau1:' + Buffer.from('[]').toString('base64url'))).toThrow();
    expect(() => parseEnrolPayload(payloadString({ code: 'short' }))).toThrow();
    expect(() => parseEnrolPayload(payloadString({ code: 'ABCD-2345-WXYZ', boxId: 'XYZ' }))).toThrow();
    expect(() => parseEnrolPayload(payloadString({ code: 'ABCD-2345-WXYZ', caSha256: 'abc' }))).toThrow();
  });

  it('lowercases a valid CA fingerprint', () => {
    const fp = createHash('sha256').update('x').digest('hex').toUpperCase();
    expect(parseEnrolPayload(payloadString({ code: 'ABCD-2345-WXYZ', caSha256: fp })).caSha256).toBe(fp.toLowerCase());
  });
});

describe('W13 S5: the token only goes to the session box', () => {
  async function session() {
    const { code, fetchImpl, keys, seen } = setup();
    const calls: string[] = [];
    const spy: FetchLike = (input, init) => {
      calls.push(input);
      return fetchImpl(input, init);
    };
    const payload = parseEnrolPayload(payloadString({ code }));
    const enrolled = await enrol(payload, { deviceName: 'T', platform: 'web', pin: PIN, fetchImpl: spy, keys });
    const s = await unlock(payload.box, enrolled.deviceId, PIN, { boxId: BOX_ID, fetchImpl: spy, keys });
    calls.length = 0;
    seen.auth.length = 0;
    return { s, calls, seen, payload, keys, spy, enrolled };
  }

  it('refuses any absolute URL on another origin before a request is made', async () => {
    const { s, calls, seen } = await session();
    for (const url of [
      'https://evil.example/api/auth/me',
      'http://10.168.0.154:8443/api/auth/me', // same host, other scheme
      'https://10.168.0.154:9999/api/auth/me', // same host, other port
      'https://10.168.0.154:8443@evil.example/api/auth/me', // userinfo trick
      'https://10.168.0.154:8443.evil.example/api/auth/me', // look-alike host
      'api/auth/me',
      'javascript:alert(1)',
      '',
    ]) {
      await expect(authedFetch(s, url), url).rejects.toThrow(/peti/);
    }
    expect(calls).toEqual([]);
    expect(seen.auth).toEqual([]);
  });

  it('still sends the token to paths and to absolute URLs on the box origin', async () => {
    const { s, calls, seen } = await session();
    expect((await authedFetch(s, '/api/auth/me')).status).toBe(200);
    expect((await authedFetch(s, `${BOX}/api/auth/me`)).status).toBe(200);
    expect(calls).toEqual([`${BOX}/api/auth/me`, `${BOX}/api/auth/me`]);
    expect(seen.auth.every((h) => h === `Bearer ${s.token}`)).toBe(true);
    // a path that looks like a protocol-relative URL is appended to the box origin, never read as a host
    calls.length = 0;
    await authedFetch(s, '//evil.example/x');
    expect(calls).toEqual([`${BOX}//evil.example/x`]);
  });

  it('unlock checks the box against the enrolment payload when one is given', async () => {
    const { payload, keys, spy, enrolled, calls } = await session();
    const ok = await unlock(payload.box, enrolled.deviceId, PIN, { boxId: BOX_ID, payload, fetchImpl: spy, keys });
    expect(ok.box).toBe(BOX);
    calls.length = 0;
    await expect(
      unlock('https://evil.example:8443', enrolled.deviceId, PIN, { boxId: BOX_ID, payload, fetchImpl: spy, keys }),
    ).rejects.toThrow(/peti/);
    await expect(
      unlock(payload.box, enrolled.deviceId, PIN, { boxId: 'ffffffffffffffff', payload, fetchImpl: spy, keys }),
    ).rejects.toThrow(/peti/);
    expect(calls).toEqual([]);
    // a trailing slash on the stored box is the same origin
    expect((await unlock(`${BOX}/`, enrolled.deviceId, PIN, { boxId: BOX_ID, payload, fetchImpl: spy, keys })).token.length).toBeGreaterThan(10);
  });
});
