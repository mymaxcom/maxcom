import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createRateLimiter } from '../auth/ratelimit.ts';
import type { RateLimiter } from '../auth/ratelimit.ts';
import { readClientText } from '../live/youtube/clientFile.ts';
import { wipeOldGrantCopies } from '../live/youtube/quarantine.ts';
import { reqSurau } from '../reqSurau.ts';
import { CLIENT_FILE_MAX, sealClient } from './youtubeSeal.ts';

/**
 * The cloud's half of "YouTube held by the box only" (release 2026.11.13). SECURITY scope: OAuth refresh tokens.
 *
 *  - The cloud holds no YouTube sign-in at all and makes none (its sign-in routes answer `youtube_at_box`,
 *    `live/routes.ts`). What it keeps is a NON-SECRET flag per surau, pushed by the box that holds the grant: signed in
 *    or not, the channel name, whether Google withdrew it, which box said so, when (`PUT /api/sync/youtube/flag`).
 *  - The operator's OAuth client file (D2) is delivered to a linked box, sealed to it (`GET /api/sync/youtube/client`);
 *    installers stay clean and an unlinked box keeps a file the operator placed.
 *  - A sign-out at the box (`signedOut` on the flag) removes what an earlier release left of that surau's old grant
 *    here: a token file, a quarantine copy (`wipeOldGrantCopies`). Never a revoke at Google.
 *  - The one-time handover of a grant the cloud used to hold is over (2026.11.15, phase 4): the cloud has no token file
 *    to hand over. `POST /api/sync/youtube/handover` stays only as the answer an updated box of 2026.11.13 or 2026.11.14
 *    still asks for ("nothing to move", which settles it), and the acknowledgement only closes a row an earlier cloud
 *    wrote. This file reads no `youtube-token-*.json` and seals no grant.
 *  - Every route here is for a linked site of the asking surau only (a device session gets 404). The change history
 *    keeps who and which handover, never a token, a code or the client secret.
 */

/** The sentence an older app shows as it is (BM); a newer app words `youtube_at_box` itself.
 * The server has no per-request language pick for its messages, so this stays BM. For the app team, if one is added:
 *   EN: YouTube sign-in is now done at the surau box. Update the app and try on the surau Wi-Fi.
 *   AR: تسجيل الدخول إلى YouTube يتم الآن على جهاز السوراو. حدّث التطبيق وجرّب على شبكة الواي فاي في السوراو.
 */
export const YOUTUBE_AT_BOX_MSG = 'Log masuk YouTube kini dibuat pada MAXCOM di surau. Kemas kini aplikasi dan cuba di Wi-Fi surau.';

export interface YoutubeFlag {
  signedIn: boolean;
  channelTitle: string | null;
  revoked: boolean;
  boxId: string;
  updatedAt: string;
}

const BOX_ID_RE = /^[0-9a-f]{16}$/;
const HANDOVER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const NO_CTRL = /^[^\u0000-\u001f\u007f]*$/;
const TITLE_MAX = 100;
/** An offer nobody acknowledged stops blocking the other boxes of the surau after this long (Q6). */
const OFFER_TTL_MS = 6 * 3_600_000;
/** An acknowledged holder box not seen by the cloud for this long no longer blocks another box's flag (F10). */
const HOLDER_SILENT_MS = 30 * 86_400_000;
const MSG = { notFound: 'not found', badRequest: 'Permintaan tidak sah', tooMany: 'Terlalu banyak percubaan. Cuba sebentar lagi.', claimed: 'MAXCOM lain di surau ini memegang log masuk YouTube.' } as const;

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A channel name as the flag may carry it: a short line of text, or null. */
export function cleanTitle(v: unknown): string | null | 'bad' {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || !NO_CTRL.test(v)) return 'bad';
  // format characters (bidi overrides and isolates, zero-width) are removed like in a worker's registration text
  const t = Array.from(v.replace(/\p{Cf}/gu, '').trim()).slice(0, TITLE_MAX).join('');
  return t === '' ? null : t;
}

/** The surau's flag, or null when no box has pushed one. Never holds a token: the columns cannot. */
export function readYoutubeFlag(db: DatabaseSync, surauId: string): YoutubeFlag | null {
  let r: Record<string, unknown> | undefined;
  try {
    r = db.prepare('SELECT signed_in, channel_title, revoked, box_id, updated_at FROM youtube_flag WHERE surau_id = ?').get(surauId);
  } catch {
    return null; // a database from before 023 (tests that skip migrations)
  }
  if (r === undefined) return null;
  return {
    signedIn: Number(r.signed_in) === 1,
    channelTitle: typeof r.channel_title === 'string' ? r.channel_title : null,
    revoked: Number(r.revoked) === 1,
    boxId: String(r.box_id),
    updatedAt: String(r.updated_at),
  };
}

function writeFlag(db: DatabaseSync, surauId: string, f: Omit<YoutubeFlag, 'updatedAt'>, at: string): void {
  db.prepare(
    `INSERT INTO youtube_flag (surau_id, signed_in, channel_title, revoked, box_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(surau_id) DO UPDATE SET signed_in = excluded.signed_in, channel_title = excluded.channel_title, revoked = excluded.revoked,
       box_id = excluded.box_id, updated_at = excluded.updated_at`,
  ).run(surauId, f.signedIn ? 1 : 0, f.channelTitle, f.revoked ? 1 : 0, f.boxId, at);
}

interface HandoverRow {
  boxId: string;
  handoverId: string;
  state: 'offered' | 'acked';
  offeredAt: number;
}

function readHandover(db: DatabaseSync, surauId: string): HandoverRow | null {
  const r = db.prepare('SELECT box_id, handover_id, state, offered_at FROM youtube_handover WHERE surau_id = ?').get(surauId);
  if (r === undefined) return null;
  const at = Date.parse(String(r.offered_at));
  return { boxId: String(r.box_id), handoverId: String(r.handover_id), state: r.state === 'acked' ? 'acked' : 'offered', offeredAt: Number.isFinite(at) ? at : 0 };
}

/** The asking site's own row, only while it is linked, not revoked and has a public key: the box a value is sealed to. */
function liveSite(db: DatabaseSync, surauId: string, boxId: string): { jwk: Record<string, string> } | null {
  if (!BOX_ID_RE.test(boxId)) return null;
  const r = db
    .prepare('SELECT public_jwk FROM sites WHERE box_id = ? AND surau_id = ? AND linked_at IS NOT NULL AND revoked_at IS NULL AND public_jwk IS NOT NULL')
    .get(boxId, surauId);
  if (r === undefined) return null;
  try {
    const j = JSON.parse(String(r.public_jwk)) as Record<string, unknown>;
    if (j.kty === 'EC' && j.crv === 'P-256' && typeof j.x === 'string' && typeof j.y === 'string') return { jwk: { kty: 'EC', crv: 'P-256', x: j.x, y: j.y } };
  } catch {
    /* not a usable key */
  }
  return null;
}

export interface YoutubeBoxCloudDeps {
  role: 'box' | 'cloud';
  db: DatabaseSync;
  now: () => Date;
  /** The cloud's data folder (its secret folder holds the operator's client file); null in unit tests. */
  dataDir: string | null;
  clock?: () => number;
}

export function registerYoutubeBoxCloudRoutes(app: FastifyInstance, deps: YoutubeBoxCloudDeps): void {
  const { db, now } = deps;
  const clock = deps.clock === undefined ? {} : { now: deps.clock };
  const limits: RateLimiter = createRateLimiter({ windowMs: 60_000, max: 30, ...clock });

  const send = (reply: FastifyReply, code: number, body: unknown): FastifyReply => reply.code(code).header('Cache-Control', 'no-store').send(body);
  // the route table is one for both roles; on a box these routes exist but answer 404 (they are the cloud's)
  const gate = {
    preHandler: async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> =>
      deps.role === 'cloud' ? undefined : send(reply, 404, { errors: [MSG.notFound] }),
  };

  /** A linked site of the asking surau; anything else (a device session, a revoked or foreign site) gets 404. */
  const siteOf = (request: FastifyRequest, reply: FastifyReply): { surauId: string; boxId: string; jwk: Record<string, string> } | null => {
    const a = request.auth;
    const surauId = reqSurau(request);
    const site = a != null && a.kind === 'site' ? liveSite(db, surauId, a.boxId) : null;
    if (a == null || a.kind !== 'site' || site === null) {
      send(reply, 404, { errors: [MSG.notFound] });
      return null;
    }
    const hit = limits.hit(`${surauId}:${a.boxId}`);
    if (!hit.ok) {
      reply.header('Retry-After', String(hit.retryAfterSec));
      send(reply, 429, { errors: [MSG.tooMany], code: 'too_many' });
      return null;
    }
    return { surauId, boxId: a.boxId, jwk: site.jwk };
  };

  const audit = (surauId: string, boxId: string, entityId: string, after: Record<string, unknown>): void => {
    // who, which handover and its state: never a token, a code or the client secret
    db.prepare('INSERT INTO change_log (surau_id, at, actor, entity, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      surauId,
      now().toISOString(),
      `site:${boxId}`,
      'youtube/handover',
      entityId,
      null,
      JSON.stringify(after),
    );
  };

  /** True when the holder's site has not been seen for 30 days (never seen: counted from when it was linked). */
  const holderSilent = (surauId: string, holderId: string): boolean => {
    const r = db.prepare('SELECT last_seen_at, linked_at FROM sites WHERE box_id = ? AND surau_id = ?').get(holderId, surauId);
    if (r === undefined) return false;
    const at = Date.parse(String(r.last_seen_at ?? r.linked_at ?? ''));
    return Number.isFinite(at) && now().getTime() - at > HOLDER_SILENT_MS;
  };

  /**
   * True while another linked box of the surau holds the handover. An offer older than 6 hours no longer does; an
   * acknowledged one stops once its site is revoked or has not been seen for 30 days (F10).
   */
  const heldByOther = (row: HandoverRow | null, surauId: string, boxId: string): boolean =>
    row !== null &&
    row.boxId !== boxId &&
    liveSite(db, surauId, row.boxId) !== null &&
    !(row.state === 'offered' && now().getTime() - row.offeredAt > OFFER_TTL_MS) &&
    !(row.state === 'acked' && holderSilent(surauId, row.boxId));

  // ---- the old handover: nothing left to move ---------------------------------------------------------------------

  // The cloud holds no grant any more. An updated box of 2026.11.13 or 2026.11.14 still asks once; "nothing to move"
  // (404 with `code: none`) is the answer that settles it on the box.
  app.post('/api/sync/youtube/handover', gate, async (request, reply) => {
    const site = siteOf(request, reply);
    if (site === null) return reply;
    return send(reply, 404, { code: 'none' });
  });

  // Closes a handover an earlier cloud offered (the box proved its copy before the cloud held no grant, or Google
  // withdrew it). No token file is read or deleted here.
  app.post('/api/sync/youtube/handover/ack', gate, async (request, reply) => {
    const site = siteOf(request, reply);
    if (site === null) return reply;
    const { surauId, boxId } = site;
    const b = request.body;
    if (!isRec(b) || typeof b.handoverId !== 'string' || !HANDOVER_ID_RE.test(b.handoverId) || typeof b.ok !== 'boolean') return send(reply, 400, { errors: [MSG.badRequest], code: 'invalid' });
    const title = cleanTitle(b.channelTitle);
    if (title === 'bad') return send(reply, 400, { errors: [MSG.badRequest], code: 'invalid' });
    const row = readHandover(db, surauId);
    if (row === null || row.boxId !== boxId || row.handoverId !== b.handoverId) return send(reply, 404, { code: 'none' });
    // said before, the answer was lost: the same answer again, nothing changes
    if (row.state === 'acked') return send(reply, 200, { acknowledged: true });
    const failed = b.ok !== true;
    // the box could not prove it for another reason (network, no client): the box asks again later
    if (failed && b.code !== 'invalid_grant') return send(reply, 200, { acknowledged: false });
    const at = now().toISOString();
    db.prepare("UPDATE youtube_handover SET state = 'acked', acked_at = ? WHERE surau_id = ? AND handover_id = ?").run(at, surauId, b.handoverId);
    writeFlag(db, surauId, { signedIn: !failed, channelTitle: title, revoked: failed, boxId }, at);
    audit(surauId, boxId, b.handoverId, { boxId, state: failed ? 'revoked' : 'acked' });
    return send(reply, 200, { acknowledged: true });
  });

  // ---- the flag the box pushes ------------------------------------------------------------------------------------

  app.put('/api/sync/youtube/flag', gate, async (request, reply) => {
    const site = siteOf(request, reply);
    if (site === null) return reply;
    const { surauId, boxId } = site;
    const b = request.body;
    // exactly these keys: nothing else (a token, a code) can be stored through this route
    if (!isRec(b) || Object.keys(b).some((k) => k !== 'signedIn' && k !== 'channelTitle' && k !== 'revoked' && k !== 'signedOut')) return send(reply, 400, { errors: [MSG.badRequest], code: 'invalid' });
    if (typeof b.signedIn !== 'boolean' || (b.revoked !== undefined && typeof b.revoked !== 'boolean')) return send(reply, 400, { errors: [MSG.badRequest], code: 'invalid' });
    // `signedOut` (2026.11.15, Y7): a person signed out at the box. Only with `signedIn false`; a boolean, nothing else.
    if (b.signedOut !== undefined && (typeof b.signedOut !== 'boolean' || (b.signedOut && b.signedIn))) return send(reply, 400, { errors: [MSG.badRequest], code: 'invalid' });
    const title = cleanTitle(b.channelTitle);
    if (title === 'bad') return send(reply, 400, { errors: [MSG.badRequest], code: 'invalid' });
    // D4: the flag is the holding box's (the box of the handover); with no handover any linked box may push it
    if (heldByOther(readHandover(db, surauId), surauId, boxId)) return send(reply, 409, { errors: [MSG.claimed], code: 'claimed' });
    writeFlag(db, surauId, { signedIn: b.signedIn, channelTitle: b.signedIn ? title : null, revoked: b.signedIn ? false : b.revoked === true, boxId }, now().toISOString());
    // Y7: a sign-out at the box leaves no copy of the surau's old grant on the cloud either (none is held now; this
    // removes what an earlier release may have left: a token file, a quarantine copy). No revoke from here.
    let wiped = false;
    if (b.signedOut === true && deps.dataDir !== null) {
      wipeOldGrantCopies(deps.dataDir, surauId);
      wiped = true;
      audit(surauId, boxId, 'signout', { boxId, state: 'wiped' });
    }
    return send(reply, 200, { stored: true, ...(b.signedOut === true ? { wiped } : {}) });
  });

  // ---- D2: the operator's OAuth client, sealed to a linked box ------------------------------------------------------

  app.get('/api/sync/youtube/client', gate, async (request, reply) => {
    const site = siteOf(request, reply);
    if (site === null) return reply;
    if (deps.dataDir === null) return send(reply, 404, { code: 'none' });
    let text: string;
    try {
      const read = readClientText(deps.dataDir);
      if (read === null || Buffer.byteLength(read, 'utf8') > CLIENT_FILE_MAX) return send(reply, 404, { code: 'none' });
      text = read;
      const v: unknown = JSON.parse(text);
      if (!isRec(v)) return send(reply, 404, { code: 'none' });
    } catch {
      return send(reply, 404, { code: 'none' });
    }
    return send(reply, 200, { boxId: site.boxId, sealed: sealClient(site.jwk, text, site.boxId) });
  });
}
