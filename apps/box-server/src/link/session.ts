import { createPublicKey, verify } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  LINK_APPROVE_TTL_MS, LINK_IDLE_TTL_MS, LINK_PIN_PROOF_TTL_MS, LINK_QR_TTL_MS, answersHash, boxQrMessage, checkAnswers,
  checkVersions, consentMatches, defaultAnswers, linkCase, linkIdFromNonce, linkRules, matchingCode, parseBoxQr,
  parseLinkAnswers, parseLinkConsent, parseLinkHello, replacedNumbers,
  checkPeopleAnswers, parseLinkPeople, peopleDigest, peopleView, planMerge,
} from '@surau/core';
import type { BoxQrPayload, LinkAnswers, LinkCase, LinkConsent, LinkHello, LinkPeopleView, LinkPerson, LinkSide, LinkStep, MergePlan } from '@surau/core';
import { buildBoxQr } from '../setup/identity.ts';
import type { BoxIdentity } from '../setup/identity.ts';
import { consumeNonce, issueNonce } from '../setup/codes.ts';
import { identityPub, signLink, verifyLink } from './sign.ts';

/**
 * The link session of one box: the handshake of two boxes of one surau, from the QR to the moment both admins have
 * agreed to the same answers and both boxes hold each other's signature over them. SECURITY code.
 *
 * Rules kept here:
 * - every step is one durable write of `link_sessions.step`; a restart finds the row and ends a session that was
 *   still before the agreement (its QR or its peer connection is gone);
 * - a box-to-box message counts only with the other box's identity signature over its step, the session id and its
 *   body; the first message (hello) also needs the one-time code of the QR, which is spent right or wrong;
 * - the matching code is computed here from both hellos, never received;
 * - nothing outside this table is changed by this file. When both agreements exist the step becomes `agreed` and
 *   `onAgreed` hands over to the work that moves data (backup, commit point, mirror).
 */

/** How this box reaches the other one. The real one pins the root CA hash; tests pass messages in process. */
export interface PeerTransport {
  post(origin: string, caSha256: string, path: string, body: unknown): Promise<{ status: number; json: unknown }>;
}

export type LinkStepName = 'qr' | 'calling' | 'code' | 'questions' | 'agreed' | 'working' | 'done';

export class LinkError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown> | undefined;
  constructor(status: number, code: string, extra?: Record<string, unknown>) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** What this box says about itself, without the per-session random. */
export type OwnHello = Omit<LinkHello, 'rand'>;

export interface LinkDeps {
  db: DatabaseSync;
  boxId: string;
  identity: BoxIdentity;
  now: () => Date;
  /** This box's part of a hello, read fresh at the start of a session. */
  ownHello: () => OwnHello;
  /** Phase 2C: this box's people as sent to the other box at the questions step (`link/people.ts` `ownPeople`). */
  ownPeople?: () => LinkPerson[];
  /** `https://<lan address>:<port>`, or '' when the box has no HTTPS listener. */
  origin: () => string;
  caSha256: () => string | null;
  linked: () => boolean;
  peer: PeerTransport;
  random: () => string;
  /** A reason this box cannot link now (a live broadcast is on, ...), or null. */
  busy?: () => string | null;
  /** Extra fields of a busy refusal (`kept_data` carries `until`, the end of the 7-day window). */
  busyExtra?: (code: string) => Record<string, unknown> | undefined;
  /** Both boxes agreed and hold both signatures. */
  onAgreed?: (s: LinkSessionRow) => void;
  /**
   * The master's signed `commit` arrived at the box that becomes the follower. Returns true when this box has taken
   * it (its follow record is on disk). Called only for a session past the agreement, with a checked signature.
   */
  onCommit?: (s: LinkSessionRow, body: Record<string, unknown>) => boolean;
  /** At start, for a session that was past the agreement: the outcome the disk shows (`linked`, `failed`, ...). */
  recoverAgreed?: (s: LinkSessionRow) => string;
}

export interface LinkSessionRow {
  id: string;
  kind: 'link' | 'unlink';
  role: LinkSide;
  peerBoxId: string | null;
  peerOrigin: string | null;
  peerCa: string | null;
  code: string | null;
  ownHello: LinkHello;
  peerHello: LinkHello | null;
  /** The people lists stored when the session entered `questions` (null before). */
  ownPeople: LinkPerson[] | null;
  peerPeople: LinkPerson[] | null;
  step: LinkStepName;
  answers: LinkAnswers | null;
  answersHash: string | null;
  ownSig: string | null;
  peerSig: string | null;
  ownAgreedRev: number | null;
  peerAgreedRev: number | null;
  pinProofAt: string | null;
  pinProofUser: string | null;
  startedAt: string;
  expiresAt: string;
  finishedAt: string | null;
  outcome: string | null;
}

/** What the app and the TV page see. No signature, no random, no one-time code. */
export interface LinkView {
  id: string;
  role: LinkSide;
  step: LinkStepName;
  expiresAt: string;
  finished: boolean;
  outcome: string | null;
  code: string | null;
  own: { boxId: string; name: string; keyFp: string; setUp: boolean; followers: number; facts: LinkHello['facts'] };
  peer: { boxId: string; name: string; keyFp: string; setUp: boolean; followers: number; facts: LinkHello['facts'] } | null;
  answers: LinkAnswers | null;
  fixed: { keep?: LinkSide; master?: LinkSide };
  case: LinkCase | null;
  ownAgreed: boolean;
  peerAgreed: boolean;
  pinFresh: boolean;
  /** The people merge as it stands with these answers; null until both lists are stored. */
  people: LinkPeopleView | null;
}

const FAILED_PER_HOUR = 5;
const LOCK_MS = 60 * 60 * 1000;
/** Outcomes that count as a failed attempt at the box that showed the QR. */
const FAILED_OUTCOMES = ['rejected', 'bad_hello', 'approve_timeout'];

const iso = (d: Date): string => d.toISOString();
const parseJson = (s: unknown): unknown => {
  if (typeof s !== 'string') return null;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
};

function verifyBoxQrSignature(p: BoxQrPayload): boolean {
  try {
    const { sig, ...rest } = p;
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: p.pub.x, y: p.pub.y }, format: 'jwk' });
    return verify('sha256', Buffer.from(boxQrMessage(rest)), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
  } catch {
    return false;
  }
}

export interface LinkSessions {
  /** The open session of this box, after expiry was applied; null when there is none. */
  current(): LinkSessionRow | null;
  view(): LinkView | null;
  /** The QR text for this box's own TV while a shown QR waits; null otherwise. */
  qrForTv(): { payload: string; expiresAt: string } | null;
  /** True from the agreement until the work is finished: every other write on this box is refused meanwhile. */
  writesBlocked(): boolean;
  provePin(userId: string): void;
  show(userId: string): { id: string; payload: string; expiresAt: string };
  /** A box that was never set up shows a link QR by itself (case N): no admin, no PIN. Null when it cannot now. */
  showAsNewBox(): { payload: string; expiresAt: string } | null;
  /** Signs and sends one message of an agreed session to the other box (the data work uses it). */
  sendSigned(id: string, step: LinkStep, body: unknown): Promise<{ status: number; json: unknown }>;
  /** `agreed` to `working`, once. */
  markWorking(id: string): boolean;
  scan(userId: string, qrText: unknown): Promise<LinkView>;
  approve(ok: boolean): Promise<LinkView>;
  setAnswers(input: unknown): Promise<LinkView>;
  agree(rev: unknown): Promise<LinkView>;
  cancel(): Promise<void>;
  /** Box-to-box entry points. */
  peerHello(body: unknown, ip: string): { hello: LinkHello; sig: string };
  peerMessage(body: unknown): { ok: true; reply?: Record<string, unknown> } | { ok: false; status: number; code: string; answers?: LinkAnswers };
  /**
   * A signed message of the OPEN session's peer for one of the steps a separate route handles (`store-list`), checked
   * the same way as `peerMessage`: the session id, the peer's key, the step in the signature. Null when any fails.
   */
  verifiedPeer(body: unknown, step: 'store-list'): { s: LinkSessionRow; payload: Record<string, unknown> } | null;
  /** Called once at start: a session that was before the agreement cannot go on after a restart. */
  recover(): void;
  /** Marks the agreed session finished (the data work reports here). */
  finish(outcome: string): void;
}

export function createLinkSessions(d: LinkDeps): LinkSessions {
  const { db } = d;
  /** The QR text is kept in memory only: it holds the one-time code. */
  let shownQr: { id: string; payload: string; expiresAt: string } | null = null;

  const rowOf = (r: Record<string, unknown> | undefined): LinkSessionRow | null => {
    if (r === undefined) return null;
    const own = parseLinkHello(parseJson(r.own_hello_json));
    if (own === null) return null;
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
    return {
      id: String(r.id), kind: r.kind === 'unlink' ? 'unlink' : 'link', role: r.role === 'scan' ? 'scan' : 'show',
      peerBoxId: str(r.peer_box_id), peerOrigin: str(r.peer_origin), peerCa: str(r.peer_ca), code: str(r.code),
      ownHello: own, peerHello: parseLinkHello(parseJson(r.peer_hello_json)),
      ownPeople: parseLinkPeople(parseJson(r.own_people_json)), peerPeople: parseLinkPeople(parseJson(r.peer_people_json)),
      step: String(r.step) as LinkStepName,
      answers: parseLinkAnswers(parseJson(r.answers_json)), answersHash: str(r.answers_hash),
      ownSig: str(r.own_sig), peerSig: str(r.peer_sig), ownAgreedRev: num(r.own_agreed_rev), peerAgreedRev: num(r.peer_agreed_rev),
      pinProofAt: str(r.pin_proof_at), pinProofUser: str(r.pin_proof_user),
      startedAt: String(r.started_at), expiresAt: String(r.expires_at), finishedAt: str(r.finished_at), outcome: str(r.outcome),
    };
  };

  const openRow = (): LinkSessionRow | null =>
    rowOf(db.prepare("SELECT * FROM link_sessions WHERE kind = 'link' AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1").get());
  const byId = (id: string): LinkSessionRow | null => rowOf(db.prepare('SELECT * FROM link_sessions WHERE id = ?').get(id));

  const end = (id: string, outcome: string): void => {
    db.prepare('UPDATE link_sessions SET finished_at = ?, outcome = ? WHERE id = ? AND finished_at IS NULL').run(iso(d.now()), outcome, id);
    if (shownQr?.id === id) shownQr = null;
  };

  /** The open session with expiry applied. An agreed session never expires here: the data work owns it. */
  const current = (): LinkSessionRow | null => {
    const s = openRow();
    if (s === null) return null;
    if (s.step !== 'agreed' && s.step !== 'working' && s.expiresAt <= iso(d.now())) {
      end(s.id, s.step === 'code' && s.role === 'show' ? 'approve_timeout' : 'expired');
      return null;
    }
    return s;
  };

  const sides = (s: LinkSessionRow): { show: LinkHello; scan: LinkHello } | null => {
    if (s.peerHello === null) return null;
    return s.role === 'show' ? { show: s.ownHello, scan: s.peerHello } : { show: s.peerHello, scan: s.ownHello };
  };

  /** The two people lists by side. A list not stored counts as empty: a hash over it then matches no other box's. */
  const peopleSides = (s: LinkSessionRow): { show: LinkPerson[]; scan: LinkPerson[] } => {
    const own = s.ownPeople ?? [];
    const peer = s.peerPeople ?? [];
    return s.role === 'show' ? { show: own, scan: peer } : { show: peer, scan: own };
  };

  const hashOf = (s: LinkSessionRow, a: LinkAnswers): string => {
    const b = sides(s)!;
    const p = peopleSides(s);
    return answersHash(s.id, a, b.show, b.scan, { show: peopleDigest(p.show), scan: peopleDigest(p.scan) });
  };

  /** The merge both boxes compute alike: from the two lists both admins were shown, never from a live database. */
  const keptOf = (s: LinkSessionRow, a: LinkAnswers): { kept: LinkPerson[]; other: LinkPerson[] } => {
    const p = peopleSides(s);
    return a.keep === 'show' ? { kept: p.show, other: p.scan } : { kept: p.scan, other: p.show };
  };
  const mergeOf = (s: LinkSessionRow, a: LinkAnswers): MergePlan => {
    const k = keptOf(s, a);
    return planMerge(k.kept.map((x) => ({ id: x.id, name: x.name, phone: x.phone, roles: x.roles })), k.other, a);
  };

  const touch = (id: string, ttlMs: number): string => {
    const until = iso(new Date(d.now().getTime() + ttlMs));
    db.prepare('UPDATE link_sessions SET expires_at = ? WHERE id = ?').run(until, id);
    return until;
  };

  /** Stores a new set of answers and clears both agreements: an agreement counts only for the revision it was made on. */
  const storeAnswers = (s: LinkSessionRow, a: LinkAnswers): void => {
    db.prepare(
      `UPDATE link_sessions SET answers_json = ?, answers_rev = ?, answers_hash = ?, own_sig = NULL, peer_sig = NULL,
         own_agreed_rev = NULL, peer_agreed_rev = NULL WHERE id = ? AND step = 'questions'`,
    ).run(JSON.stringify(a), a.rev, hashOf(s, a), s.id);
    touch(s.id, LINK_IDLE_TTL_MS);
  };

  /** Answers that may be on the screen: the finance tick may still be missing, everything else must hold. */
  const editable = (a: LinkAnswers, s: LinkSessionRow): boolean => {
    const b = sides(s)!;
    const c = checkAnswers(a, b.show, b.scan);
    return (c.ok || c.code === 'finance_tick') && checkPeopleAnswers(mergeOf(s, a), a);
  };

  /** `madeSig`: a signature this box already stored for exactly this step and body (the consent), sent as it is. */
  const send = async (s: LinkSessionRow, step: LinkStep, body: unknown, madeSig?: string): Promise<{ status: number; json: unknown }> => {
    if (s.peerOrigin === null || s.peerCa === null) throw new LinkError(502, 'peer_unreachable');
    const sig = madeSig ?? signLink(d.identity, step, s.id, body);
    try {
      // `store-list` has its own route: its answer is built while the request waits (database copy, hashes).
      const path = step === 'store-list' ? '/api/link/peer/store/list' : '/api/link/peer/message';
      return await d.peer.post(s.peerOrigin, s.peerCa, path, { linkId: s.id, step, body, sig });
    } catch {
      throw new LinkError(502, 'peer_unreachable');
    }
  };

  const maybeAgreed = (id: string): void => {
    const s = byId(id);
    if (s === null || s.step !== 'questions' || s.answers === null) return;
    if (s.ownSig === null || s.peerSig === null) return;
    if (s.ownAgreedRev !== s.answers.rev || s.peerAgreedRev !== s.answers.rev) return;
    const r = db.prepare("UPDATE link_sessions SET step = 'agreed' WHERE id = ? AND step = 'questions' AND answers_rev = ?").run(id, s.answers.rev);
    if (Number(r.changes) !== 1) return;
    const agreed = byId(id);
    if (agreed !== null) d.onAgreed?.(agreed);
  };

  const pinFresh = (s: LinkSessionRow): boolean =>
    s.pinProofAt !== null && d.now().getTime() - Date.parse(s.pinProofAt) <= LINK_PIN_PROOF_TTL_MS;

  const viewOf = (s: LinkSessionRow): LinkView => {
    const b = sides(s);
    const rules = b === null ? null : linkRules(b.show, b.scan);
    const face = (h: LinkHello): LinkView['own'] => ({ boxId: h.boxId, name: h.name, keyFp: h.keyFp, setUp: h.setUp, followers: h.followers, facts: h.facts });
    return {
      id: s.id, role: s.role, step: s.step, expiresAt: s.expiresAt, finished: s.finishedAt !== null, outcome: s.outcome,
      code: s.step === 'code' ? s.code : null,
      own: face(s.ownHello), peer: s.peerHello === null ? null : face(s.peerHello),
      answers: s.answers, fixed: rules !== null && rules.ok ? rules.fixed : {},
      case: b !== null && s.answers !== null ? linkCase(s.answers, b.show, b.scan) : null,
      ownAgreed: s.answers !== null && s.ownAgreedRev === s.answers.rev,
      peerAgreed: s.answers !== null && s.peerAgreedRev === s.answers.rev,
      pinFresh: pinFresh(s),
      people: s.answers === null || s.ownPeople === null || s.peerPeople === null
        ? null
        : peopleView(keptOf(s, s.answers).kept.map((x) => ({ id: x.id, name: x.name, phone: x.phone, roles: x.roles })), mergeOf(s, s.answers), s.answers.same, s.answers.phones),
    };
  };

  const need = (step: LinkStepName): LinkSessionRow => {
    const s = current();
    if (s === null) throw new LinkError(409, 'no_session');
    if (s.step !== step) throw new LinkError(409, 'wrong_step', { step: s.step });
    return s;
  };

  const startChecks = (): void => {
    if (current() !== null) throw new LinkError(409, 'session_open');
    const busy = d.busy?.() ?? null;
    if (busy !== null) throw new LinkError(409, busy, d.busyExtra?.(busy));
    if (d.origin() === '' || d.caSha256() === null) throw new LinkError(409, 'no_https');
  };

  const newHello = (): LinkHello => {
    const h = parseLinkHello({ ...d.ownHello(), rand: d.random() });
    if (h === null) throw new LinkError(500, 'own_hello');
    return h;
  };

  const insert = (id: string, role: LinkSide, step: LinkStepName, own: LinkHello, userId: string | null, ttlMs: number, peer?: { boxId: string; origin: string; ca: string }): void => {
    const at = d.now();
    db.prepare(
      `INSERT INTO link_sessions (id, kind, role, peer_box_id, peer_origin, peer_ca, own_hello_json, step, pin_proof_at, pin_proof_user, started_at, expires_at)
       VALUES (?, 'link', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, role, peer?.boxId ?? null, peer?.origin ?? null, peer?.ca ?? null, JSON.stringify(own), step, userId === null ? null : iso(at), userId, iso(at), iso(new Date(at.getTime() + ttlMs)));
  };

  const issueQr = (userId: string | null): { id: string; payload: string; expiresAt: string } => {
    const own = newHello();
    const { nonce, expiresAt } = issueNonce(db, 'link', d.now(), LINK_QR_TTL_MS);
    const id = linkIdFromNonce(nonce);
    insert(id, 'show', 'qr', own, userId, LINK_QR_TTL_MS);
    const at = Math.floor(d.now().getTime() / 1000);
    const payload = buildBoxQr(d.identity, {
      type: 'link', boxId: d.boxId, name: own.name, box: d.origin(), caSha256: d.caSha256(), linked: d.linked(),
      nonce, iat: at, exp: at + Math.floor(LINK_QR_TTL_MS / 1000),
    });
    shownQr = { id, payload, expiresAt };
    return { id, payload, expiresAt };
  };

  /**
   * Case N: a box that was never set up has no admin. When the other box's consent arrives it signs the same
   * revision by itself and sends it; it counts its own agreement only after the other box has taken it.
   */
  const autoConsent = (id: string): void => {
    void (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const s = byId(id);
        if (s === null || s.finishedAt !== null || s.step !== 'questions' || s.ownHello.setUp || s.answers === null || s.answersHash === null) return;
        if (s.peerAgreedRev !== s.answers.rev) return;
        const b = sides(s)!;
        if (!checkAnswers(s.answers, b.show, b.scan).ok) return;
        const rev = s.answers.rev;
        const consent: LinkConsent = { boxId: d.boxId, rev, hash: s.answersHash };
        const sig = signLink(d.identity, 'consent', id, consent);
        try {
          const res = await send(s, 'consent', consent, sig);
          if (res.status === 200) {
            db.prepare("UPDATE link_sessions SET own_sig = ?, own_agreed_rev = ? WHERE id = ? AND step = 'questions' AND answers_rev = ?").run(sig, rev, id, rev);
            maybeAgreed(id);
          }
          return;
        } catch {
          // try again: the other box takes the same consent twice without harm
        }
      }
    })();
  };

  return {
    current,
    view: () => {
      const s = current();
      return s === null ? null : viewOf(s);
    },
    qrForTv: () => {
      const s = current();
      if (s === null || s.step !== 'qr' || shownQr === null || shownQr.id !== s.id) return null;
      return { payload: shownQr.payload, expiresAt: shownQr.expiresAt };
    },
    writesBlocked: () => {
      const s = openRow();
      return s !== null && (s.step === 'agreed' || s.step === 'working');
    },

    provePin(userId) {
      const s = current();
      if (s === null) throw new LinkError(409, 'no_session');
      db.prepare('UPDATE link_sessions SET pin_proof_at = ?, pin_proof_user = ? WHERE id = ?').run(iso(d.now()), userId, s.id);
    },

    show(userId) {
      startChecks();
      const since = iso(new Date(d.now().getTime() - LOCK_MS));
      const failed = db
        .prepare(`SELECT COUNT(*) AS n FROM link_sessions WHERE role = 'show' AND finished_at > ? AND outcome IN (${FAILED_OUTCOMES.map(() => '?').join(',')})`)
        .get(since, ...FAILED_OUTCOMES);
      if (Number(failed?.n ?? 0) >= FAILED_PER_HOUR) throw new LinkError(429, 'link_locked');
      return issueQr(userId);
    },

    showAsNewBox() {
      const s = current();
      if (s !== null) {
        if (s.step === 'qr' && shownQr !== null && shownQr.id === s.id) return { payload: shownQr.payload, expiresAt: shownQr.expiresAt };
        // A QR whose text was lost (a restart of the page's server) is of no use: end it and show a new one.
        if (s.step !== 'qr') return null;
        end(s.id, 'restart');
      }
      if (d.ownHello().setUp || (d.busy?.() ?? null) !== null || d.origin() === '' || d.caSha256() === null) return null;
      const q = issueQr(null);
      return { payload: q.payload, expiresAt: q.expiresAt };
    },

    async sendSigned(id, step, body) {
      const s = byId(id);
      if (s === null || (s.step !== 'agreed' && s.step !== 'working')) throw new LinkError(409, 'wrong_step');
      return send(s, step, body);
    },

    markWorking(id) {
      return Number(db.prepare("UPDATE link_sessions SET step = 'working' WHERE id = ? AND step = 'agreed'").run(id).changes) === 1;
    },

    async scan(userId, qrText) {
      startChecks();
      let qr: BoxQrPayload;
      try {
        qr = parseBoxQr(typeof qrText === 'string' ? qrText : '');
      } catch {
        throw new LinkError(400, 'bad_qr');
      }
      // The expiry is judged by the box that issued the code, never by this box's clock.
      if (qr.type !== 'link' || !verifyBoxQrSignature(qr) || qr.box === '' || qr.caSha256 === null) throw new LinkError(400, 'bad_qr');
      if (qr.boxId === d.boxId || qr.keyFp === d.identity.keyFp) throw new LinkError(400, 'same_box');
      const own = newHello();
      const id = linkIdFromNonce(qr.nonce);
      if (byId(id) !== null) throw new LinkError(409, 'code_used');
      insert(id, 'scan', 'calling', own, userId, LINK_APPROVE_TTL_MS, { boxId: qr.boxId, origin: qr.box, ca: qr.caSha256 });
      let res: { status: number; json: unknown };
      try {
        res = await d.peer.post(qr.box, qr.caSha256, '/api/link/peer/hello', { nonce: qr.nonce, hello: own, sig: signLink(d.identity, 'hello', id, own) });
      } catch {
        end(id, 'peer_unreachable');
        throw new LinkError(502, 'peer_unreachable');
      }
      const j = (typeof res.json === 'object' && res.json !== null ? res.json : {}) as Record<string, unknown>;
      if (res.status !== 200) {
        const code = typeof j.code === 'string' && /^[a-z_]{1,40}$/.test(j.code) ? j.code : 'peer_refused';
        end(id, code);
        throw new LinkError(409, code, j.behind === 'show' || j.behind === 'scan' ? { behind: j.behind } : undefined);
      }
      const theirs = parseLinkHello(j.hello);
      // The answer must come from the box of the QR: same id, same key, signed by that key for this session.
      if (
        theirs === null || theirs.boxId !== qr.boxId || theirs.keyFp !== qr.keyFp ||
        theirs.pub.x !== qr.pub.x || theirs.pub.y !== qr.pub.y || !verifyLink(theirs.pub, 'hello', id, theirs, j.sig)
      ) {
        end(id, 'bad_hello');
        throw new LinkError(502, 'bad_hello');
      }
      const v = checkVersions(theirs, own);
      if (!v.ok) {
        end(id, v.code);
        throw new LinkError(409, v.code, { behind: v.behind });
      }
      const rules = linkRules(theirs, own);
      if (!rules.ok) {
        end(id, rules.code);
        throw new LinkError(409, rules.code);
      }
      const code = matchingCode({ showPub: theirs.pub, scanPub: own.pub, showRand: theirs.rand, scanRand: own.rand, nonce: qr.nonce });
      db.prepare("UPDATE link_sessions SET peer_jwk = ?, peer_hello_json = ?, code = ?, step = 'code' WHERE id = ? AND step = 'calling'")
        .run(JSON.stringify(theirs.pub), JSON.stringify(theirs), code, id);
      return viewOf(byId(id)!);
    },

    peerHello(body, ip) {
      const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
      const nonce = typeof b.nonce === 'string' ? b.nonce : '';
      let id: string;
      try {
        id = linkIdFromNonce(nonce);
      } catch {
        throw new LinkError(400, 'bad_message');
      }
      // Spent right or wrong: whoever uses the code first takes it, a second caller gets `code_used`.
      const spent = consumeNonce(db, 'link', nonce, ip, d.now());
      if (spent !== 'ok') throw new LinkError(spent === 'expired' ? 410 : 409, spent === 'expired' ? 'code_expired' : 'code_used');
      const s = current();
      if (s === null || s.id !== id || s.role !== 'show' || s.step !== 'qr') throw new LinkError(409, 'code_used');
      shownQr = null;
      const theirs = parseLinkHello(b.hello);
      if (theirs === null || theirs.boxId === d.boxId || theirs.keyFp === d.identity.keyFp || !verifyLink(theirs.pub, 'hello', id, theirs, b.sig)) {
        end(id, 'bad_hello');
        throw new LinkError(400, 'bad_message');
      }
      const v = checkVersions(s.ownHello, theirs);
      if (!v.ok) {
        end(id, v.code);
        throw new LinkError(409, v.code, { behind: v.behind });
      }
      const rules = linkRules(s.ownHello, theirs);
      if (!rules.ok) {
        end(id, rules.code);
        throw new LinkError(409, rules.code);
      }
      const code = matchingCode({ showPub: s.ownHello.pub, scanPub: theirs.pub, showRand: s.ownHello.rand, scanRand: theirs.rand, nonce });
      db.prepare(
        `UPDATE link_sessions SET peer_box_id = ?, peer_jwk = ?, peer_origin = ?, peer_ca = ?, peer_hello_json = ?, code = ?, step = 'code', expires_at = ?
         WHERE id = ? AND step = 'qr'`,
      ).run(theirs.boxId, JSON.stringify(theirs.pub), theirs.addresses[0]!, theirs.caSha256, JSON.stringify(theirs), code, iso(new Date(d.now().getTime() + LINK_APPROVE_TTL_MS)), id);
      return { hello: s.ownHello, sig: signLink(d.identity, 'hello', id, s.ownHello) };
    },

    async approve(ok) {
      const s = need('code');
      // The admin of the box that showed the QR approves. A box that was never set up has no admin: there the
      // scanning admin does, comparing the phone with the new box's TV.
      const showIsNew = !(s.role === 'show' ? s.ownHello : s.peerHello!).setUp;
      if (s.role !== (showIsNew ? 'scan' : 'show')) throw new LinkError(409, 'wrong_side');
      if (!ok) {
        end(s.id, 'rejected');
        await send(s, 'cancel', { reason: 'rejected' }).catch(() => undefined);
        throw new LinkError(409, 'rejected');
      }
      const b = sides(s)!;
      const a = defaultAnswers(b.show, b.scan);
      if (a === null) {
        end(s.id, 'bad_hello');
        throw new LinkError(409, 'bad_message');
      }
      // The people lists cross here: after the matching code was approved, inside the pinned channel, each signed.
      const mine = d.ownPeople?.() ?? [];
      const res = await send(s, 'approve', { people: mine }).catch((e: unknown) => {
        end(s.id, 'peer_unreachable');
        throw e;
      });
      if (res.status !== 200) {
        end(s.id, 'peer_refused');
        throw new LinkError(409, 'peer_refused');
      }
      const j = (typeof res.json === 'object' && res.json !== null ? res.json : {}) as Record<string, unknown>;
      const theirs = parseLinkPeople(j.people);
      if (theirs === null || !verifyLink(s.peerHello!.pub, 'people', s.id, theirs, j.sig)) {
        end(s.id, 'bad_hello');
        await send(s, 'cancel', { reason: 'cancelled' }).catch(() => undefined);
        throw new LinkError(502, 'bad_hello');
      }
      db.prepare("UPDATE link_sessions SET own_people_json = ?, peer_people_json = ?, step = 'questions' WHERE id = ? AND step = 'code'")
        .run(JSON.stringify(mine), JSON.stringify(theirs), s.id);
      storeAnswers(byId(s.id)!, a);
      return viewOf(byId(s.id)!);
    },

    async setAnswers(input) {
      const s = need('questions');
      const cur = s.answers;
      const i = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
      const b = sides(s)!;
      const keep = i.keep === 'show' || i.keep === 'scan' ? i.keep : null;
      if (cur === null || keep === null) throw new LinkError(400, 'bad_message');
      const next = parseLinkAnswers({ rev: cur.rev + 1, keep, master: i.master, roles: i.roles ?? {}, same: i.same ?? [], phones: i.phones ?? cur.phones ?? 'code', financeTick: i.financeTick, replaced: replacedNumbers(keep, b.show, b.scan) });
      if (next === null) throw new LinkError(400, 'bad_message');
      const c = checkAnswers(next, b.show, b.scan);
      if (!c.ok && c.code !== 'finance_tick') throw new LinkError(409, c.code);
      if (!checkPeopleAnswers(mergeOf(s, next), next)) throw new LinkError(409, 'people_answer');
      const res = await send(s, 'answers', { answers: next });
      const j = (typeof res.json === 'object' && res.json !== null ? res.json : {}) as Record<string, unknown>;
      if (res.status === 200) storeAnswers(s, next);
      else {
        // The other admin changed the answers at the same moment: theirs stand, this admin looks again.
        const theirs = parseLinkAnswers(j.answers);
        if (theirs === null || theirs.rev < next.rev || !editable(theirs, s)) throw new LinkError(409, 'peer_refused');
        storeAnswers(s, theirs);
        throw new LinkError(409, 'stale_revision');
      }
      return viewOf(byId(s.id)!);
    },

    async agree(rev) {
      const s = need('questions');
      const a = s.answers;
      if (a === null || s.answersHash === null) throw new LinkError(409, 'wrong_step');
      // An agreement counts only for the exact revision this admin saw.
      if (rev !== a.rev) throw new LinkError(409, 'stale_revision', { rev: a.rev });
      const b = sides(s)!;
      const c = checkAnswers(a, b.show, b.scan);
      if (!c.ok) throw new LinkError(409, c.code);
      if (!checkPeopleAnswers(mergeOf(s, a), a)) throw new LinkError(409, 'people_answer');
      if (hashOf(s, a) !== s.answersHash) throw new LinkError(409, 'bad_message');
      if (!pinFresh(s)) throw new LinkError(401, 'pin_required');
      const consent: LinkConsent = { boxId: d.boxId, rev: a.rev, hash: s.answersHash };
      const sig = signLink(d.identity, 'consent', s.id, consent);
      const r = db.prepare("UPDATE link_sessions SET own_sig = ?, own_agreed_rev = ? WHERE id = ? AND step = 'questions' AND answers_rev = ?").run(sig, a.rev, s.id, a.rev);
      if (Number(r.changes) !== 1) throw new LinkError(409, 'stale_revision');
      const res = await send(s, 'consent', consent, sig).catch((e: unknown) => {
        db.prepare('UPDATE link_sessions SET own_sig = NULL, own_agreed_rev = NULL WHERE id = ? AND answers_rev = ?').run(s.id, a.rev);
        throw e;
      });
      if (res.status !== 200) {
        db.prepare('UPDATE link_sessions SET own_sig = NULL, own_agreed_rev = NULL WHERE id = ? AND answers_rev = ?').run(s.id, a.rev);
        throw new LinkError(409, 'stale_revision');
      }
      maybeAgreed(s.id);
      return viewOf(byId(s.id)!);
    },

    async cancel() {
      const s = current();
      if (s === null) return;
      if (s.step === 'agreed' || s.step === 'working') throw new LinkError(409, 'linking');
      end(s.id, 'cancelled');
      if (s.peerHello !== null) await send(s, 'cancel', { reason: 'cancelled' }).catch(() => undefined);
    },

    verifiedPeer(body, step) {
      const m = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
      const id = typeof m.linkId === 'string' ? m.linkId : '';
      const s = current();
      if (s === null || s.id !== id || m.step !== step) return null;
      const key = s.peerHello?.pub ?? null;
      if (key === null || typeof key.x !== 'string' || typeof key.y !== 'string') return null;
      if (!verifyLink({ kty: 'EC', crv: 'P-256', x: key.x, y: key.y }, step, id, m.body, m.sig)) return null;
      return { s, payload: (typeof m.body === 'object' && m.body !== null ? m.body : {}) as Record<string, unknown> };
    },

    peerMessage(body) {
      const m = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
      const id = typeof m.linkId === 'string' ? m.linkId : '';
      const s = current();
      if (s === null || s.id !== id) return { ok: false, status: 404, code: 'no_session' };
      const step = m.step;
      const key = s.peerHello?.pub ?? (parseJson(db.prepare('SELECT peer_jwk FROM link_sessions WHERE id = ?').get(id)?.peer_jwk) as { x?: unknown; y?: unknown } | null);
      if (
        key === null || typeof key.x !== 'string' || typeof key.y !== 'string' ||
        (step !== 'approve' && step !== 'answers' && step !== 'consent' && step !== 'cancel' && step !== 'commit') ||
        !verifyLink({ kty: 'EC', crv: 'P-256', x: key.x, y: key.y }, step, id, m.body, m.sig)
      ) return { ok: false, status: 403, code: 'bad_message' };
      const payload = (typeof m.body === 'object' && m.body !== null ? m.body : {}) as Record<string, unknown>;

      if (step === 'commit') {
        // Only the master commits, only after both agreements, and only to the box that becomes the follower.
        if ((s.step !== 'agreed' && s.step !== 'working') || s.answers === null || s.answers.master === s.role) return { ok: false, status: 409, code: 'wrong_step' };
        if (d.onCommit === undefined || !d.onCommit(s, payload)) {
          // A signed commit this box cannot take ends the link here at once; nothing was changed.
          db.prepare("UPDATE link_sessions SET step = 'done', finished_at = ?, outcome = 'failed' WHERE id = ? AND finished_at IS NULL").run(iso(d.now()), id);
          return { ok: false, status: 409, code: 'bad_message' };
        }
        return { ok: true };
      }
      if (step === 'cancel') {
        // After the agreement only the master may call the work off, and only at the box that becomes the follower:
        // that box has changed nothing before it takes the commit. Nobody can call off a master's work.
        const masterGaveUp = payload.reason === 'failed' && s.answers !== null && s.answers.master !== s.role;
        if ((s.step === 'agreed' || s.step === 'working') && masterGaveUp) {
          db.prepare("UPDATE link_sessions SET step = 'done', finished_at = ?, outcome = 'failed' WHERE id = ? AND finished_at IS NULL").run(iso(d.now()), id);
          return { ok: true };
        }
        if (s.step === 'agreed' || s.step === 'working') return { ok: false, status: 409, code: 'linking' };
        end(id, payload.reason === 'rejected' ? 'rejected_by_peer' : 'cancelled_by_peer');
        return { ok: true };
      }
      if (step === 'approve') {
        // Only the box that showed the QR approves, and only once. A box that was never set up cannot approve:
        // there the scanning admin's box does, and this (new) box takes it.
        const fromShow = s.role === 'scan' && s.peerHello !== null && s.peerHello.setUp;
        const fromScanToNew = s.role === 'show' && !s.ownHello.setUp;
        if ((!fromShow && !fromScanToNew) || s.step !== 'code') return { ok: false, status: 409, code: 'wrong_step' };
        const b = sides(s)!;
        const a = defaultAnswers(b.show, b.scan);
        const theirs = parseLinkPeople(payload.people);
        if (a === null || theirs === null) return { ok: false, status: 409, code: 'bad_message' };
        const mine = d.ownPeople?.() ?? [];
        db.prepare("UPDATE link_sessions SET own_people_json = ?, peer_people_json = ?, step = 'questions' WHERE id = ? AND step = 'code'")
          .run(JSON.stringify(mine), JSON.stringify(theirs), id);
        storeAnswers(byId(id)!, a);
        return { ok: true, reply: { people: mine, sig: signLink(d.identity, 'people', id, mine) } };
      }
      if (s.step !== 'questions' || s.answers === null || s.answersHash === null) return { ok: false, status: 409, code: 'wrong_step' };
      if (step === 'answers') {
        const a = parseLinkAnswers(payload.answers);
        if (a === null || !editable(a, s)) return { ok: false, status: 400, code: 'bad_message' };
        const mine = s.answers;
        if (a.rev === mine.rev && hashOf(s, a) === s.answersHash) return { ok: true };
        // Same revision, different content: the box that showed the QR keeps its own, the other box takes it.
        if (a.rev < mine.rev || (a.rev === mine.rev && s.role === 'show')) return { ok: false, status: 409, code: 'stale_revision', answers: mine };
        storeAnswers(s, a);
        return { ok: true };
      }
      const consent = parseLinkConsent(m.body);
      if (consent === null) return { ok: false, status: 400, code: 'bad_message' };
      const fit = consentMatches(consent, { peerBoxId: s.peerBoxId ?? '', rev: s.answers.rev, hash: s.answersHash });
      if (!fit.ok) return { ok: false, status: 409, code: fit.code };
      const r = db.prepare("UPDATE link_sessions SET peer_sig = ?, peer_agreed_rev = ? WHERE id = ? AND step = 'questions' AND answers_rev = ?")
        .run(String(m.sig), consent.rev, id, consent.rev);
      if (Number(r.changes) !== 1) return { ok: false, status: 409, code: 'stale_revision' };
      maybeAgreed(id);
      if (!s.ownHello.setUp) autoConsent(id);
      return { ok: true };
    },

    recover() {
      db.prepare(
        "UPDATE link_sessions SET finished_at = ?, outcome = 'restart' WHERE finished_at IS NULL AND step IN ('qr', 'calling', 'code', 'questions')",
      ).run(iso(d.now()));
      shownQr = null;
      // Past the agreement the disk decides: the follow record or the follower's row is there, or it is not.
      const s = openRow();
      if (s !== null && (s.step === 'agreed' || s.step === 'working')) {
        const outcome = d.recoverAgreed?.(s) ?? 'failed';
        db.prepare("UPDATE link_sessions SET step = 'done', finished_at = ?, outcome = ? WHERE id = ?").run(iso(d.now()), outcome, s.id);
      }
    },

    finish(outcome) {
      const s = openRow();
      if (s !== null && (s.step === 'agreed' || s.step === 'working')) {
        db.prepare("UPDATE link_sessions SET step = 'done', finished_at = ?, outcome = ?, committed_at = CASE WHEN ? = 'linked' THEN ? ELSE committed_at END WHERE id = ?")
          .run(iso(d.now()), outcome, outcome, iso(d.now()), s.id);
      }
    },
  };
}
