import { webcrypto } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ROLES } from '@surau/core';
import type { Role } from '@surau/core';
import { beginEnrolment } from '../src/auth/devices.ts';
import { getVersion } from '../src/settingsStore.ts';
import { createUser, serverRoleOf } from '../src/auth/users.ts';
import { holdsOpsRole, issueOpsEnrolment } from '../src/auth/opsDevice.ts';
import { LOCAL_SURAU_ID, SURAU_HEADER } from '../src/tenant.ts';

export const TEST_PIN = '482916';

export interface Login {
  token: string;
  userId: string;
  deviceId: string;
  roles: Role[];
  /**
   * `{ authorization: 'Bearer <token>' }` for `app.inject`. An ops login on a cloud-role app also carries the
   * acting-surau header for the local surau (Plan 14 Task 3), so the existing tests act in one surau as before.
   */
  headers: { authorization: string; 'x-maxcom-surau'?: string };
  /** Settings version right after set-up (creating users bumps it). */
  baseVersion: number;
  /** Signs a fresh challenge and unlocks again (a new session for the same device). */
  relogin: () => Promise<string>;
  /** Signs bytes with the device key (base64url, IEEE P1363), as the app signs a sync op. */
  sign: (message: Uint8Array) => Promise<string>;
}

let counter = 0;

/**
 * Creates a user with the role, enrols a device with a fresh WebCrypto P-256 key through the real
 * HTTP routes, then performs the challenge/unlock handshake in the exact format sessions.ts
 * verifies. Each login uses its own fake client address so the per-IP rate limits of one app are
 * never consumed by test set-up.
 */
export async function loginAs(app: FastifyInstance, role: Role | Role[], pin: string = TEST_PIN, surauId: string = LOCAL_SURAU_ID): Promise<Login> {
  const roles = Array.isArray(role) ? role : [role];
  const n = ++counter;
  const remoteAddress = `10.${(n >> 8) & 255}.${n & 255}.7`;
  const { db, boxId } = app.surau;

  // The Pentadbir MAXCOM is cloud-made; a test database gets one the way the operator does (the promote step).
  const plain = roles.filter((r) => r !== 'superadmin');
  const user = createUser(db, { name: `Test ${roles.join('+')} ${n}`, roles: plain.length > 0 ? plain : ['ajk'] }, 'test', surauId);
  if (roles.includes('superadmin')) {
    db.prepare('UPDATE users SET roles_json = ? WHERE id = ?').run(JSON.stringify(ROLES.filter((r) => roles.includes(r))), user.id);
  }
  // As migration 019 does: an ops-role account is a `*` user.
  if (holdsOpsRole(roles)) db.prepare("UPDATE users SET surau_id = '*', no = NULL, no_src = NULL WHERE id = ?").run(user.id);
  // On a cloud-role app an ops-role person gets no ordinary code (Plan 14 Task 23): it enrols an OPS device the
  // CLI way, so the existing superadmin tests keep their powers there. A box-role app is unchanged.
  const opsLogin = serverRoleOf(db) === 'cloud' && holdsOpsRole(roles);
  if (opsLogin) {
    db.prepare('INSERT OR IGNORE INTO suraus (id, name, created_at, created_by) VALUES (?, ?, ?, ?)').run(
      LOCAL_SURAU_ID,
      'Surau ujian',
      new Date().toISOString(),
      'test',
    );
  }
  const { code } = opsLogin
    ? issueOpsEnrolment(db, { userId: user.id, deviceName: `Peranti ${n}` }, 'test')
    : beginEnrolment(db, { userId: user.id, deviceName: `Peranti ${n}` }, 'test', { canManageSuperadmin: true });

  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
  const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };

  const enrol = await app.inject({
    method: 'POST',
    url: '/api/enrol/complete',
    remoteAddress,
    payload: { code, publicJwk, platform: 'web', pin, ...(opsLogin ? { client: 'ops' } : {}) },
  });
  if (enrol.statusCode !== 200) throw new Error(`enrol failed: ${enrol.statusCode} ${enrol.body}`);
  const deviceId = String(enrol.json().deviceId);

  const unlockOnce = async (): Promise<string> => {
    const ch = await app.inject({ method: 'POST', url: '/api/auth/challenge', remoteAddress, payload: { deviceId } });
    if (ch.statusCode !== 200) throw new Error(`challenge failed: ${ch.statusCode} ${ch.body}`);
    const nonce = String(ch.json().nonce);
    const message = new TextEncoder().encode(`surau-unlock\n${boxId}\n${deviceId}\n${nonce}`);
    const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, message);
    const un = await app.inject({
      method: 'POST',
      url: '/api/auth/unlock',
      remoteAddress,
      payload: { deviceId, nonce, signature: Buffer.from(sig).toString('base64url'), pin },
    });
    if (un.statusCode !== 200) throw new Error(`unlock failed: ${un.statusCode} ${un.body}`);
    return String(un.json().token);
  };

  const token = await unlockOnce();
  return {
    token,
    userId: user.id,
    deviceId,
    roles,
    headers: opsLogin ? { authorization: `Bearer ${token}`, [SURAU_HEADER]: LOCAL_SURAU_ID } : { authorization: `Bearer ${token}` },
    baseVersion: getVersion(db, surauId),
    relogin: unlockOnce,
    sign: async (message: Uint8Array): Promise<string> =>
      Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, Buffer.from(message))).toString('base64url'),
  };
}

export const loginAsAdmin = (app: FastifyInstance): Promise<Login> => loginAs(app, 'admin');

export type AdminApp = FastifyInstance & { admin: () => Promise<Login> };

/**
 * Wraps an app so `inject` carries an admin Bearer token (logged in lazily on first use, through
 * the real routes). A request that sets its own `authorization` header is sent as given. The
 * wrapper is for the Plan 1 and Plan 2 route tests, which exercise route behaviour, not access.
 */
export function withAdmin(app: FastifyInstance): AdminApp {
  let login: Promise<Login> | null = null;
  const admin = (): Promise<Login> => (login ??= loginAsAdmin(app));
  return new Proxy(app, {
    get(target, prop) {
      if (prop === 'admin') return admin;
      if (prop === 'inject') {
        return async (opts: Record<string, unknown>) => {
          const headers = (opts.headers ?? {}) as Record<string, string>;
          const has = Object.keys(headers).some((h) => h.toLowerCase() === 'authorization');
          const who = has ? null : await admin();
          return (target.inject as (o: unknown) => Promise<unknown>).call(target, {
            ...opts,
            headers: who === null ? headers : { ...who.headers, ...headers },
          });
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as AdminApp;
}
