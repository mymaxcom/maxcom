import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { tooMany } from '../auth/authz.ts';
import type { Limiters } from '../auth/authz.ts';
import { createRateLimiter } from '../auth/ratelimit.ts';
import { AuthError } from '../auth/users.ts';
import { inRecovery, recordProbe, recoveryComplete, refuseDeadNonce, setupComplete } from './complete.ts';
import { peekNonce, resumableNonce } from './codes.ts';
import type { BoxIdentity } from './identity.ts';

export interface JoinRouteDeps {
  db: DatabaseSync;
  dataDir: string;
  boxId: string;
  identity: BoxIdentity;
  now: () => Date;
  limiters: Limiters;
}

const SMALL_BODY = { bodyLimit: 8 * 1024 } as const;
const MIN = 60_000;

function body(request: FastifyRequest): Record<string, unknown> {
  const b = request.body;
  if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new AuthError(400, 'bad_body', 'Permintaan tidak sah');
  return b as Record<string, unknown>;
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The three public routes of the box screen: first setup, recovery, and the phone's network probe. All are
 * rate limited per address and for the whole box, and all answer `no-store`. Nothing here needs a session: none
 * can exist yet. The answers hold the recovery code once and never a PIN or a nonce.
 */
export function registerJoinRoutes(app: FastifyInstance, deps: JoinRouteDeps): void {
  const { db, dataDir, boxId, limiters } = deps;
  // limits that only these routes use
  const recoveryDay = createRateLimiter({ windowMs: 24 * 60 * MIN, max: 10 });
  const probeIp = createRateLimiter({ windowMs: 10 * MIN, max: 10 });

  const guard =
    (...checks: ((request: FastifyRequest) => { ok: boolean; retryAfterSec: number })[]) =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      for (const c of checks) {
        const hit = c(request);
        if (!hit.ok) return tooMany(reply, hit.retryAfterSec);
      }
      return undefined;
    };

  // The shared limits (box-wide, per day) are charged only by a request that holds a live nonce, so anonymous junk
  // from the LAN can never use them up. The per-address limits stay in the first preHandler.
  const liveNonce =
    (type: 'setup' | 'recovery', ...shared: (() => { ok: boolean; retryAfterSec: number })[]) =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      const b = request.body;
      if (typeof b !== 'object' || b === null || Array.isArray(b)) return undefined; // the handler answers 400
      const now = deps.now();
      const nonce = (b as Record<string, unknown>).nonce;
      // a lost reply can be resumed with the spent nonce; it counts like a live one
      const resumable = resumableNonce(db, type, nonce, now) !== null;
      // recovery is state first: an active box answers 409 without spending or charging anything
      if (type === 'recovery' && !resumable && !inRecovery(db)) return undefined;
      const st = peekNonce(db, type, nonce, now);
      if (st !== 'live' && !resumable) refuseDeadNonce(db, type, st, request.ip, now);
      for (const c of shared) {
        const hit = c();
        if (!hit.ok) return tooMany(reply, hit.retryAfterSec);
      }
      return undefined;
    };

  app.post(
    '/api/setup/complete',
    {
      ...SMALL_BODY,
      preHandler: [guard((r) => limiters.enrolIp.hit(r.ip)), liveNonce('setup', () => limiters.joinGlobal.hit('global'))],
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const b = body(request);
      const out = await setupComplete(
        db,
        dataDir,
        boxId,
        {
          nonce: str(b.nonce),
          surauName: str(b.surauName),
          boxName: str(b.boxName),
          adminName: str(b.adminName),
          deviceName: str(b.deviceName),
          publicJwk: b.publicJwk,
          platform: str(b.platform),
          pin: str(b.pin),
        },
        request.ip,
        deps.now(),
      );
      return reply.code(201).send(out);
    },
  );

  app.post(
    '/api/recovery/complete',
    {
      ...SMALL_BODY,
      preHandler: [
        guard((r) => limiters.recoveryIp.hit(r.ip)),
        liveNonce('recovery', () => recoveryDay.hit(boxId), () => limiters.joinGlobal.hit('global')),
      ],
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const b = body(request);
      const out = await recoveryComplete(
        db,
        dataDir,
        boxId,
        {
          nonce: str(b.nonce),
          recoveryCode: str(b.recoveryCode),
          adminName: str(b.adminName),
          deviceName: str(b.deviceName),
          publicJwk: b.publicJwk,
          platform: str(b.platform),
          pin: str(b.pin),
        },
        request.ip,
        deps.now(),
      );
      return reply.code(201).send(out);
    },
  );

  app.post('/api/setup/probe', { ...SMALL_BODY, preHandler: guard((r) => probeIp.hit(r.ip)) }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const b = body(request);
    if (!recordProbe(db, str(b.nonce), request.ip, deps.now())) return reply.code(404).send({ errors: ['not found'] });
    return { ok: true };
  });
}
