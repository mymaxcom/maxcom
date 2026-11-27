import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { canonicalJwk } from '../auth/devices.ts';
import { randomToken, verifyP256 } from '../auth/crypto.ts';
import type { JsonWebKey } from '../auth/crypto.ts';
import { createRateLimiter } from '../auth/ratelimit.ts';
import { secretDir } from '../auth/secrets.ts';
import { signLink } from '../link/sign.ts';
import { isLanDirect } from '../net/lan.ts';
import type { BoxIdentity } from '../setup/identity.ts';
import { openWithBoxKey, sealToBoxKey, sealedRe } from '../sync/boxSeal.ts';
import type { FollowStore } from './store.ts';

/**
 * Phone move (phase 2C, plan L8): a phone that was enrolled at this box before it became a follower is told where its
 * surau is managed now, with a one-time join ticket the master made for that person. SECURITY code.
 *
 * - The list is made at the commit, from this box's own database while it is still open (it is set aside at the next
 *   start): only live, keyed, non-kiosk devices of people the master gave a ticket (non-admins only). Sealed to this
 *   box's identity key, outside the store (`secret/follow-moves.json`), removed with the follow record.
 * - A phone proves it holds its device key: a nonce from `POST /api/follow/move/challenge` (memory, 2 minutes, single
 *   use), then a P-256 signature over `maxcom-link-move\n<thisBoxId>\n<deviceId>\n<nonce>`.
 * - The answer is a pointer signed with this box's identity key: the master's name, box id, key fingerprint, root CA
 *   hash and addresses, and the ticket. The ticket is an ordinary enrolment code at the master (30 days, single use,
 *   stored there only as a hash); the phone enrols there with a new PIN.
 */
export const MOVES_REL = 'secret/follow-moves.json';
const FILE = 'follow-moves.json';
const LABEL = 'maxcom-follow-moves-v1';
const SEALED = sealedRe(512 * 1024);
const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const MAX_CHALLENGES = 200;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** `expiresAt` (ISO): when THIS ticket dies, when it is shorter than the file's (a linking admin's lives 30 minutes). */
export interface MoveEntry { deviceId: string; jwk: JsonWebKey; userId: string; ticket: string; expiresAt?: string }
export interface MovesFile { v: 1; linkId: string; expiresAt: string; entries: MoveEntry[] }

/** The phones of this box that may move: called in `onCommit`, while this box's store is still the open one. */
export function movesFromDb(db: DatabaseSync, m: { linkId: string; tickets: Record<string, string>; expiresAt: string; expiries?: Record<string, string> }): MovesFile {
  const entries: MoveEntry[] = [];
  const rows = db.prepare(
    "SELECT id, user_id, public_jwk FROM devices WHERE revoked_at IS NULL AND public_jwk IS NOT NULL AND platform <> 'kiosk' ORDER BY id",
  ).all();
  for (const r of rows) {
    const ticket = m.tickets[String(r.user_id)];
    if (ticket === undefined) continue;
    let jwk: JsonWebKey;
    try {
      jwk = canonicalJwk(JSON.parse(String(r.public_jwk)));
    } catch {
      continue;
    }
    const own = m.expiries?.[String(r.user_id)];
    entries.push({ deviceId: String(r.id), jwk, userId: String(r.user_id), ticket, ...(own === undefined ? {} : { expiresAt: own }) });
  }
  return { v: 1, linkId: m.linkId, expiresAt: m.expiresAt, entries };
}

export interface MovesStore {
  read(): MovesFile | null;
  write(f: MovesFile): void;
  clear(): void;
}

/** `dataDir` null: kept in memory (tests). */
export function createMovesStore(dataDir: string | null, identity: BoxIdentity, boxId: string): MovesStore {
  const aad = `follow-moves|${boxId}`;
  let mem: MovesFile | null = null;
  const path = dataDir === null ? null : join(secretDir(dataDir), FILE);
  return {
    read() {
      if (path === null) return mem;
      try {
        const sealed = (JSON.parse(readFileSync(path, 'utf8')) as { sealed?: unknown }).sealed;
        const f = JSON.parse(openWithBoxKey(identity.privateJwk, String(sealed), LABEL, aad, SEALED)) as MovesFile;
        return f !== null && f.v === 1 && Array.isArray(f.entries) && typeof f.expiresAt === 'string' ? f : null;
      } catch {
        return null;
      }
    },
    write(f) {
      if (path === null) {
        mem = f;
        return;
      }
      mkdirSync(secretDir(dataDir!), { recursive: true });
      const body = JSON.stringify({ v: 1, sealed: sealToBoxKey(identity.publicJwk, JSON.stringify(f), LABEL, aad) });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, body, { mode: 0o600 });
      renameSync(tmp, path);
    },
    clear() {
      mem = null;
      if (path !== null) rmSync(path, { force: true });
    },
  };
}

export interface MoveRoutesDeps {
  boxId: string;
  identity: BoxIdentity;
  follow: FollowStore;
  moves: MovesStore;
  now: () => Date;
}

export const moveMessage = (boxId: string, deviceId: string, nonce: string): Buffer =>
  Buffer.from(`maxcom-link-move\n${boxId}\n${deviceId}\n${nonce}`, 'utf8');

export function registerMoveRoutes(app: FastifyInstance, d: MoveRoutesDeps): void {
  const challenges = new Map<string, { deviceId: string; expiresAt: number }>();
  const limiter = createRateLimiter({ windowMs: 5 * 60_000, max: 30 });
  const small = { bodyLimit: 4 * 1024 } as const;

  const refuse = (reply: FastifyReply, status: number, code: string): FastifyReply => reply.code(status).send({ code, errors: [code] });
  const guard = (request: FastifyRequest, reply: FastifyReply): FastifyReply | null => {
    reply.header('Cache-Control', 'no-store');
    if (!isLanDirect(request)) return refuse(reply, 403, 'lan_only');
    if (!limiter.hit(request.ip).ok) return refuse(reply, 429, 'too_many');
    // only a follower answers; on any other box the routes do not exist in effect
    if (d.follow.read() === null) return refuse(reply, 404, 'not_found');
    return null;
  };
  const bodyOf = (request: FastifyRequest): Record<string, unknown> =>
    typeof request.body === 'object' && request.body !== null && !Array.isArray(request.body) ? (request.body as Record<string, unknown>) : {};

  app.post('/api/follow/move/challenge', small, async (request, reply) => {
    const stop = guard(request, reply);
    if (stop !== null) return stop;
    const deviceId = bodyOf(request).deviceId;
    if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) return refuse(reply, 400, 'bad_message');
    const now = d.now().getTime();
    for (const [k, v] of challenges) if (v.expiresAt <= now) challenges.delete(k);
    if (challenges.size >= MAX_CHALLENGES) return refuse(reply, 429, 'too_many');
    // Every device id gets a nonce, known or not: the answer says nothing about which phones this box knew.
    const nonce = randomToken(32);
    challenges.set(nonce, { deviceId, expiresAt: now + CHALLENGE_TTL_MS });
    return { nonce, expiresAt: new Date(now + CHALLENGE_TTL_MS).toISOString() };
  });

  app.post('/api/follow/move', small, async (request, reply) => {
    const stop = guard(request, reply);
    if (stop !== null) return stop;
    const b = bodyOf(request);
    const deviceId = typeof b.deviceId === 'string' ? b.deviceId : '';
    const nonce = typeof b.nonce === 'string' ? b.nonce : '';
    const sigText = typeof b.signature === 'string' ? b.signature : '';
    const ch = challenges.get(nonce);
    // single use: spent whatever happens next
    challenges.delete(nonce);
    const now = d.now();
    if (ch === undefined || ch.deviceId !== deviceId || ch.expiresAt <= now.getTime()) return refuse(reply, 401, 'bad_signature');
    const file = d.moves.read();
    const rec = d.follow.read();
    const entry = file?.entries.find((e) => e.deviceId === deviceId);
    const sig = /^[A-Za-z0-9_-]{86}$/.test(sigText) ? Buffer.from(sigText, 'base64url') : Buffer.alloc(0);
    if (entry === undefined || !verifyP256(entry.jwk, moveMessage(d.boxId, deviceId, nonce), sig)) return refuse(reply, 401, 'bad_signature');
    if (file === null || rec === null || file.linkId !== rec.linkId || Date.parse(file.expiresAt) <= now.getTime()) return refuse(reply, 404, 'no_ticket');
    // the ticket's own end (a linking admin's lives 30 minutes); the file's end is the longest any ticket lives
    // never later than the file's end, so a pointer cannot show a longer life than the file allows
    const own = typeof entry.expiresAt === 'string' ? Date.parse(entry.expiresAt) : Number.NaN;
    const ends = Number.isNaN(own) || own > Date.parse(file.expiresAt) ? file.expiresAt : entry.expiresAt!;
    if (Date.parse(ends) <= now.getTime()) return refuse(reply, 404, 'no_ticket');
    const pointer = {
      v: 1, linkId: rec.linkId, fromBoxId: d.boxId,
      master: { name: rec.masterName, boxId: rec.masterBoxId, keyFp: rec.masterKeyFp, caSha256: rec.masterCa, addresses: rec.addresses },
      ticket: entry.ticket, expiresAt: ends,
    };
    return { pointer, sig: signLink(d.identity, 'move', rec.linkId, pointer) };
  });
}
