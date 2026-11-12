import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { APP_DOWNLOAD_URL } from '@surau/core';
import type { BoxInfo, BoxQrType, BoxStateView, NetCheckView } from '@surau/core';
import { kioskTokenAccepts } from '../auth/authz.ts';
import { AuthError } from '../auth/users.ts';
import { rootCaFingerprint } from '../auth/routes.ts';
import { sha256hex } from '../auth/crypto.ts';
import { getSettings, surauPublicInfo } from '../settingsStore.ts';
import { enrolCloudOrigin } from '../sync/sites.ts';
import type { TlsMaterial } from '../tls.ts';
import { boxVersion } from '../productVersion.ts';
import { issueNonce, recoveryCodeExists } from './codes.ts';
import { buildBoxQr } from './identity.ts';
import type { BoxIdentity } from './identity.ts';
import { boxName, boxState, readBoxJson, setBoxName, writeBoxJson } from './state.ts';

export interface StateRouteDeps {
  db: DatabaseSync;
  dataDir: string;
  boxId: string;
  identity: BoxIdentity;
  now: () => Date;
  tls: TlsMaterial | null;
  httpsPort: number;
  /** False for an in-memory database with no data folder: no box.json is kept. */
  realDataDir: boolean;
}

const SMALL_BODY = { bodyLimit: 8 * 1024 } as const;
/** A cached QR is replaced when fewer than this many ms remain, so the TV never shows a code about to die. */
const REISSUE_MS = 15_000;

function stateValue(db: DatabaseSync, key: string): string | null {
  const r = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
  return typeof r?.value === 'string' ? r.value : null;
}

/**
 * Only the box's own loopback kiosk gets setup, recovery and probe payloads; a paired display never does.
 * This one reads the identity the auth hook decided (it differs from authz.ts's request check), and
 * applies the same kiosk-token rule again so the two can never disagree.
 */
function isLoopbackKiosk(request: FastifyRequest): boolean {
  const a = request.auth;
  return a !== null && a.kind === 'kiosk' && a.via === 'loopback' && kioskTokenAccepts(request);
}

/** `https://<lan address>:<port>` from the certificate names, or '' when the box has no HTTPS. */
export function boxOrigin(tls: TlsMaterial | null, httpsPort: number): string {
  if (tls === null) return '';
  const ip = tls.ipSan.find((a) => a !== '127.0.0.1' && a !== '::1');
  const host = ip ?? tls.dnsSan.find((h) => h !== 'localhost');
  if (host === undefined) return '';
  // the default HTTPS port is not written: `https://host:443` is not the origin a phone or the QR check expects
  return `https://${isIP(host) === 6 ? `[${host}]` : host}${httpsPort === 443 ? '' : `:${httpsPort}`}`;
}

export function registerStateRoutes(app: FastifyInstance, deps: StateRouteDeps): void {
  const { db, dataDir, boxId, identity, tls, httpsPort } = deps;
  const caSha256 = (): string | null => (tls === null ? null : rootCaFingerprint(dataDir));
  const linked = (): boolean => stateValue(db, 'linked') === '1';
  const hasSurauInfo = (): boolean => db.prepare("SELECT 1 AS ok FROM settings WHERE feature = 'surauInfo'").get() !== undefined;

  const info = (): BoxInfo => {
    const { state, reason } = boxState(db);
    return {
      boxId,
      keyFp: identity.keyFp,
      pub: { kty: 'EC', crv: 'P-256', x: identity.publicJwk.x!, y: identity.publicJwk.y! },
      name: boxName(db, boxId),
      state,
      reason,
      linked: linked(),
      https: tls !== null,
      caSha256: caSha256(),
      serverTime: deps.now().toISOString(),
      version: boxVersion(),
    };
  };

  // One live QR per type, kept in memory (the nonce is stored only as a hash). It is replaced when it is
  // near expiry or when its nonce was spent (a wrong attempt burns it).
  const live = new Map<BoxQrType, { payload: string; expiresAt: string; expMs: number; hash: string; nonce: string }>();
  const liveQr = (type: BoxQrType): { payload: string; expiresAt: string } => {
    const now = deps.now();
    const cur = live.get(type);
    if (cur !== undefined && cur.expMs - now.getTime() > REISSUE_MS) {
      const row = db.prepare('SELECT used_at, expires_at FROM box_codes WHERE nonce_hash = ?').get(cur.hash);
      if (row !== undefined && row.used_at === null && String(row.expires_at) > now.toISOString()) {
        return { payload: cur.payload, expiresAt: cur.expiresAt };
      }
    }
    const { nonce, expiresAt } = issueNonce(db, type, now);
    const cloud = enrolCloudOrigin(db);
    const payload = buildBoxQr(identity, {
      type,
      boxId,
      name: boxName(db, boxId),
      box: boxOrigin(tls, httpsPort),
      caSha256: caSha256(),
      linked: linked(),
      ...(cloud !== undefined ? { cloud } : {}),
      nonce,
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(new Date(expiresAt).getTime() / 1000),
    });
    const expMs = new Date(expiresAt).getTime();
    live.set(type, { payload, expiresAt, expMs, hash: sha256hex(nonce), nonce });
    return { payload, expiresAt };
  };

  app.get('/api/box/info', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return info();
  });

  app.get('/api/box/state', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const i = info();
    const view: BoxStateView = {
      ...i,
      surauName: hasSurauInfo() ? surauPublicInfo(db).name : null,
      appDownloadUrl: APP_DOWNLOAD_URL,
    };
    if (isLoopbackKiosk(request) && i.state === 'setup') view.qr = liveQr('setup');
    if (isLoopbackKiosk(request) && i.state === 'recovery' && i.reason === 'no_admin') {
      // an upgraded box may have no recovery code at all: a QR would lead nowhere, so the screen says so instead
      view.recoveryCodeSet = recoveryCodeExists(db);
      if (view.recoveryCodeSet) view.qr = liveQr('recovery');
    }
    return view;
  });

  app.get('/api/box/netcheck', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    // anything but the box's own loopback kiosk (a signed-in phone, a paired display) gets a plain 404
    if (!isLoopbackKiosk(request)) return reply.code(404).send({ errors: ['not found'] });
    const interfaces: NetCheckView['interfaces'] = [];
    for (const [name, list] of Object.entries(networkInterfaces())) {
      for (const a of list ?? []) {
        if (a.family === 'IPv4' && !a.internal) interfaces.push({ name, address: a.address, up: true });
      }
    }
    const cutoff = new Date(deps.now().getTime() - 10 * 60_000).toISOString();
    const seen = db
      .prepare(
        `SELECT MAX(at) AS at FROM auth_log
         WHERE event IN ('enrol', 'challenge', 'net_probe') AND at >= ?
           AND ip IS NOT NULL AND ip NOT IN ('127.0.0.1', '::1', '::ffff:127.0.0.1')`,
      )
      .get(cutoff);
    const view: NetCheckView = {
      interfaces,
      https: { listening: tls !== null, port: tls !== null ? httpsPort : null },
      linked: linked(),
      lastPull: stateValue(db, 'last_pull'),
      lastPhoneSeenAt: typeof seen?.at === 'string' ? seen.at : null,
      probe: liveQr('probe'),
    };
    return view;
  });

  app.get('/api/kiosk/cloud', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return {
      linked: linked(),
      lastOkAt: stateValue(db, 'last_pull'),
      cloudSyncEnabled: getSettings(db).cloudSync.enabled === true,
    };
  });

  app.put('/api/box/name', SMALL_BODY, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const b = request.body;
    if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new AuthError(400, 'bad_body', 'Permintaan tidak sah');
    const a = request.auth;
    if (a === null || a.kind !== 'user') throw new AuthError(401, 'no_session', 'Sila buka kunci semula');
    const name = setBoxName(db, boxId, (b as Record<string, unknown>).name, `user:${a.userId}`);
    syncBoxJson();
    return { name };
  });

  // box.json keeps the box and surau name for the damaged-database screen. Rewritten at start and whenever a
  // name changed (checked on a slow timer: no hook into settingsStore).
  let lastJson = '';
  const syncBoxJson = (): void => {
    if (!deps.realDataDir) return;
    try {
      const next = { boxName: boxName(db, boxId), surauName: hasSurauInfo() ? surauPublicInfo(db).name : null };
      const text = JSON.stringify(next);
      if (text === lastJson) return;
      const cur = readBoxJson(dataDir);
      if (cur === null || cur.boxName !== next.boxName || cur.surauName !== next.surauName) writeBoxJson(dataDir, next);
      lastJson = text;
    } catch {
      /* the database may be closing */
    }
  };
  syncBoxJson();
  const timer = setInterval(syncBoxJson, 5_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}
