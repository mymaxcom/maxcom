/** Linking two boxes of one surau: the pure rules both boxes and the app share. No I/O, no crypto API: a box signs
 *  and checks the messages built here with its identity key (`setup/identity.ts`). Security code: every signed link
 *  message has its own first line, so a link signature can never stand in for a box QR, a sync op or an unlock. */

import { canonicalJson, sha256Hex } from '../sync/canonical.ts';
import { keyFingerprint } from '../setup/boxQr.ts';
import type { BoxQrPub } from '../setup/boxQr.ts';

/** Raised when the box-to-box messages change shape. Two boxes link only on the same number. */
export const LINK_PROTOCOL = 1;
/** First part of every signed link message. Never shared with `maxcom-qr`, `surau-op` or `surau-unlock`. */
export const LINK_MESSAGE_PREFIX = 'maxcom-link-v1';

/** The signed steps. `order-*` are the three orders a follower accepts from its master. */
// `people` (the list a box answers with at approve) and `move` (the pointer a follower gives a phone) are signing
// domains only: they are never sent as a step of `/api/link/peer/message`.
export const LINK_STEPS = ['hello', 'approve', 'answers', 'consent', 'cancel', 'commit', 'order-forget', 'order-revert', 'order-standalone', 'people', 'move', 'store-list', 'unlink-report'] as const;
export type LinkStep = (typeof LINK_STEPS)[number];

/** The box that showed the QR, and the box whose admin scanned it. */
export type LinkSide = 'show' | 'scan';
export const otherSide = (s: LinkSide): LinkSide => (s === 'show' ? 'scan' : 'show');

/** Refusals are codes; the app and the TV page word them in the viewer's language. */
export type LinkRefusal =
  | 'bad_message' | 'version' | 'protocol' | 'db_level' | 'follower' | 'both_have_followers' | 'both_new'
  | 'fixed_answer' | 'keep_new_box' | 'finance_tick' | 'stale_revision' | 'same_box' | 'people_answer';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const LINK_ID_RE = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const B64URL43 = /^[A-Za-z0-9_-]{43}$/;
/** A development checkout reports 0.0.0. */
const RELEASE_RE = /^\d{1,4}\.\d{1,2}\.\d{1,3}$/;

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const count = (n: unknown, max = 10_000_000): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= max;

/** The id of a link session: both boxes derive it from the one-time code of the QR, so it names exactly one QR. */
export function linkIdFromNonce(nonce: string): string {
  if (!B64URL43.test(nonce)) throw new Error('link: bad nonce');
  return sha256Hex(utf8(`maxcom-link-id\n${nonce}`)).slice(0, 32);
}

/** UTF-8 of `maxcom-link-v1|<step>|<linkId>|<sha256 hex of canonicalJson(body)>`: what a box identity key signs. */
export function linkMessage(step: LinkStep, linkId: string, body: unknown): Uint8Array {
  if (!LINK_STEPS.includes(step)) throw new Error('link: unknown step');
  if (!LINK_ID_RE.test(linkId)) throw new Error('link: bad link id');
  return utf8(`${LINK_MESSAGE_PREFIX}|${step}|${linkId}|${sha256Hex(utf8(canonicalJson(body)))}`);
}

/** What a box says about itself for the two questions. Numbers only: no names of people, no content. */
export interface LinkFacts {
  content: number;
  posters: number;
  videos: number;
  finance: number;
  people: number;
  /** ISO time of the last edit, or null for a box with no data. */
  lastEditAt: string | null;
  device: 'windows' | 'android' | 'other';
  /** Cable (true), Wi-Fi (false) or not known (null). */
  wired: boolean | null;
  freeBytes: number;
  youtube: boolean;
  cloud: boolean;
}

/** The first box-to-box message, signed by the sender (step `hello`). */
export interface LinkHello {
  v: 1;
  proto: number;
  boxId: string;
  keyFp: string;
  pub: BoxQrPub;
  caSha256: string;
  name: string;
  /** https origins on the LAN, at most 4. */
  addresses: string[];
  release: string;
  dbLevel: number;
  /** Fresh 32 random bytes, base64url. Feeds the matching code. */
  rand: string;
  /** False for a box that was never set up (case N). */
  setUp: boolean;
  /** This box already follows another box: it cannot link. */
  isFollower: boolean;
  /** Followers this box already has: it stays the master and its data is kept. */
  followers: number;
  facts: LinkFacts;
}

const HELLO_KEYS = ['v', 'proto', 'boxId', 'keyFp', 'pub', 'caSha256', 'name', 'addresses', 'release', 'dbLevel', 'rand', 'setUp', 'isFollower', 'followers', 'facts'];
const FACT_KEYS = ['content', 'posters', 'videos', 'finance', 'people', 'lastEditAt', 'device', 'wired', 'freeBytes', 'youtube', 'cloud'];
const sameKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(o).sort().join() === [...keys].sort().join();

function isLanOrigin(s: unknown): s is string {
  if (typeof s !== 'string' || s.length > 200) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && u.origin === s && !u.username && !u.password && u.hostname !== '';
  } catch {
    return false;
  }
}

function parseFacts(v: unknown): LinkFacts | null {
  if (!isPlain(v) || !sameKeys(v, FACT_KEYS)) return null;
  if (!count(v.content) || !count(v.posters) || !count(v.videos) || !count(v.finance) || !count(v.people)) return null;
  if (!(v.lastEditAt === null || (typeof v.lastEditAt === 'string' && v.lastEditAt.length <= 40 && !Number.isNaN(Date.parse(v.lastEditAt))))) return null;
  if (v.device !== 'windows' && v.device !== 'android' && v.device !== 'other') return null;
  if (!(v.wired === null || typeof v.wired === 'boolean')) return null;
  if (!count(v.freeBytes, Number.MAX_SAFE_INTEGER)) return null;
  if (typeof v.youtube !== 'boolean' || typeof v.cloud !== 'boolean') return null;
  return v as unknown as LinkFacts;
}

/** Strict parse: only the listed keys and sizes. The signature is checked by the caller, against `pub` in here. */
export function parseLinkHello(v: unknown): LinkHello | null {
  if (!isPlain(v) || !sameKeys(v, HELLO_KEYS)) return null;
  const pub = v.pub;
  if (
    v.v !== 1 ||
    !count(v.proto, 1000) || v.proto < 1 ||
    typeof v.boxId !== 'string' || !HEX16.test(v.boxId) ||
    typeof v.keyFp !== 'string' || !HEX16.test(v.keyFp) ||
    !isPlain(pub) || !sameKeys(pub, ['crv', 'kty', 'x', 'y']) || pub.kty !== 'EC' || pub.crv !== 'P-256' ||
    typeof pub.x !== 'string' || !B64URL43.test(pub.x) || typeof pub.y !== 'string' || !B64URL43.test(pub.y) ||
    typeof v.caSha256 !== 'string' || !HEX64.test(v.caSha256) ||
    typeof v.name !== 'string' || v.name.length < 1 || v.name.length > 60 ||
    !Array.isArray(v.addresses) || v.addresses.length < 1 || v.addresses.length > 4 || !v.addresses.every(isLanOrigin) ||
    typeof v.release !== 'string' || !RELEASE_RE.test(v.release) ||
    !count(v.dbLevel, 100_000) ||
    typeof v.rand !== 'string' || !B64URL43.test(v.rand) ||
    typeof v.setUp !== 'boolean' || typeof v.isFollower !== 'boolean' ||
    !count(v.followers, 64) ||
    parseFacts(v.facts) === null
  ) return null;
  const h = v as unknown as LinkHello;
  if (h.keyFp !== keyFingerprint(h.pub)) return null;
  return h;
}

/**
 * The 6-digit matching code. Each box computes it by itself from BOTH identity keys, both randoms and the one-time
 * code of the QR, so a third box that calls first gives the honest admin's phone another number (or none).
 * The admin of the showing box compares it with the PHONE of the other admin, never with the TV.
 */
export function matchingCode(i: { showPub: BoxQrPub; scanPub: BoxQrPub; showRand: string; scanRand: string; nonce: string }): string {
  if (!B64URL43.test(i.showRand) || !B64URL43.test(i.scanRand) || !B64URL43.test(i.nonce)) throw new Error('link: bad code input');
  const pub = (p: BoxQrPub): BoxQrPub => ({ kty: p.kty, crv: p.crv, x: p.x, y: p.y });
  const digest = sha256Hex(utf8(canonicalJson({
    p: 'maxcom-link-code-v1', show: pub(i.showPub), scan: pub(i.scanPub), showRand: i.showRand, scanRand: i.scanRand, nonce: i.nonce,
  })));
  // 48 bits of the digest reduced to six digits: the bias is far below one in a million.
  return String(Number.parseInt(digest.slice(0, 12), 16) % 1_000_000).padStart(6, '0');
}

/** `'482 193'` from `'482193'`, always read left to right. */
export function matchingCodeGroups(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

function releaseParts(r: string): number[] {
  return r.split('.').map((x) => Number.parseInt(x, 10));
}
/** Negative when `a` is the older release. */
export function compareReleases(a: string, b: string): number {
  const x = releaseParts(a);
  const y = releaseParts(b);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export type VersionCheck =
  | { ok: true }
  | { ok: false; code: 'version' | 'protocol' | 'db_level'; /** The box that must be updated; null when it cannot be told. */ behind: LinkSide | null };

/** L1: a hard stop unless release, database level and link protocol are all the same. No "continue anyway". */
export function checkVersions(show: LinkHello, scan: LinkHello): VersionCheck {
  const rel = compareReleases(show.release, scan.release);
  if (rel !== 0) return { ok: false, code: 'version', behind: rel < 0 ? 'show' : 'scan' };
  if (show.proto !== scan.proto) return { ok: false, code: 'protocol', behind: show.proto < scan.proto ? 'show' : 'scan' };
  if (show.dbLevel !== scan.dbLevel) return { ok: false, code: 'db_level', behind: show.dbLevel < scan.dbLevel ? 'show' : 'scan' };
  return { ok: true };
}

/** S: kept data is the master's own. X: kept data moves once to the master. N-*: one box was never set up. */
export type LinkCase = 'S' | 'X' | 'N-S' | 'N-X';

export type LinkPhones = 'direct' | 'code';

/** The answers of the questions screen, with what each admin was shown. One set per session, with a revision. */
export interface LinkAnswers {
  /** Starts at 1; any change to an answer, a role or the tick makes the next number and clears both agreements. */
  rev: number;
  /** Q1: whose data is kept. */
  keep: LinkSide;
  /** Q2: which box is the master (kotak utama). */
  master: LinkSide;
  /** Role chosen for a person whose role differs between the boxes: person key (E.164 phone) to role id. */
  roles: Record<string, string>;
  /** Ids of people of the box whose data is not kept whom the admins marked "orang yang sama" (same name, no number). */
  same: string[];
  /**
   * Q3: the phones of the people of the box whose data is replaced or moved. 'direct': every one of them with a phone,
   * admins included, gets a phone-move ticket and reconnects to the master by itself. 'code': only non-admins do; an
   * admin asks an admin of the master for a join code (the agreeing admin still gets the short ticket).
   */
  phones: LinkPhones;
  /** L7: "I understand the finance records of the replaced box are not merged". */
  financeTick: boolean;
  /** The numbers shown under "Yang akan diganti": part of what is agreed to. */
  replaced: { content: number; posters: number; videos: number; finance: number };
}

export type LinkRules =
  | { ok: false; code: 'follower' | 'both_have_followers' | 'both_new' | 'same_box' }
  | { ok: true; /** Set when the answers are not a choice: a box with followers, or a new box. */ fixed: { keep?: LinkSide; master?: LinkSide } };

/** What the two hellos allow before any question is asked. */
export function linkRules(show: LinkHello, scan: LinkHello): LinkRules {
  if (show.boxId === scan.boxId || show.keyFp === scan.keyFp) return { ok: false, code: 'same_box' };
  if (show.isFollower || scan.isFollower) return { ok: false, code: 'follower' };
  if (!show.setUp && !scan.setUp) return { ok: false, code: 'both_new' };
  if (show.followers > 0 && scan.followers > 0) return { ok: false, code: 'both_have_followers' };
  const fixed: { keep?: LinkSide; master?: LinkSide } = {};
  // A box that already leads followers stays the master and keeps its data: undo of a chain cannot be made exact.
  if (show.followers > 0) { fixed.keep = 'show'; fixed.master = 'show'; }
  if (scan.followers > 0) { fixed.keep = 'scan'; fixed.master = 'scan'; }
  // A box that was never set up has nothing to keep.
  if (!show.setUp) fixed.keep = 'scan';
  if (!scan.setUp) fixed.keep = 'show';
  return { ok: true, fixed };
}

export function linkCase(a: Pick<LinkAnswers, 'keep' | 'master'>, show: Pick<LinkHello, 'setUp'>, scan: Pick<LinkHello, 'setUp'>): LinkCase {
  const oneNew = !show.setUp || !scan.setUp;
  const same = a.keep === a.master;
  if (oneNew) return same ? 'N-S' : 'N-X';
  return same ? 'S' : 'X';
}

/** The numbers of the box whose data is replaced; all zero when that box is new. */
export function replacedNumbers(keep: LinkSide, show: LinkHello, scan: LinkHello): LinkAnswers['replaced'] {
  const gone = keep === 'show' ? scan : show;
  if (!gone.setUp) return { content: 0, posters: 0, videos: 0, finance: 0 };
  const f = gone.facts;
  return { content: f.content, posters: f.posters, videos: f.videos, finance: f.finance };
}

/** The default answers: the master is the box whose data is kept (case S or N-S), following what is fixed. */
export function defaultAnswers(show: LinkHello, scan: LinkHello): LinkAnswers | null {
  const rules = linkRules(show, scan);
  if (!rules.ok) return null;
  const keep = rules.fixed.keep ?? adviseMaster(show, scan);
  const master = rules.fixed.master ?? keep;
  return { rev: 1, keep, master, roles: {}, same: [], phones: 'direct', financeTick: false, replaced: replacedNumbers(keep, show, scan) };
}

/** The advice line under Q2: a Windows PC before an Android box, a cable before Wi-Fi, then the larger free storage. */
export function adviseMaster(show: LinkHello, scan: LinkHello): LinkSide {
  if (show.setUp !== scan.setUp) return show.setUp ? 'show' : 'scan';
  const score = (h: LinkHello): number => (h.facts.device === 'windows' ? 4 : 0) + (h.facts.wired === true ? 2 : 0);
  const d = score(show) - score(scan);
  if (d !== 0) return d > 0 ? 'show' : 'scan';
  return scan.facts.freeBytes > show.facts.freeBytes ? 'scan' : 'show';
}

const ROLE_KEY_RE = /^\+[1-9]\d{6,14}$/;
const ROLE_ID_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const ANSWER_KEYS = ['rev', 'keep', 'master', 'roles', 'same', 'financeTick', 'replaced'];
const PERSON_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Strict shape check of answers that arrive from an app or from the other box. */
export function parseLinkAnswers(v: unknown): LinkAnswers | null {
  if (!isPlain(v)) return null;
  // `phones` is newer than the other keys: an older peer or a stored session without it means the strict "code"
  let rest = v;
  if ('phones' in v) {
    if (v.phones !== 'direct' && v.phones !== 'code') return null;
    rest = Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'phones'));
  }
  if (!sameKeys(rest, ANSWER_KEYS)) return null;
  if (!count(v.rev, 100_000) || v.rev < 1) return null;
  if ((v.keep !== 'show' && v.keep !== 'scan') || (v.master !== 'show' && v.master !== 'scan')) return null;
  if (typeof v.financeTick !== 'boolean') return null;
  const roles = v.roles;
  if (!isPlain(roles) || Object.keys(roles).length > 200) return null;
  for (const [k, r] of Object.entries(roles)) if (!ROLE_KEY_RE.test(k) || typeof r !== 'string' || !ROLE_ID_RE.test(r)) return null;
  const same = v.same;
  if (!Array.isArray(same) || same.length > 500 || !same.every((x) => typeof x === 'string' && PERSON_ID_RE.test(x))) return null;
  const rep = v.replaced;
  if (!isPlain(rep) || !sameKeys(rep, ['content', 'posters', 'videos', 'finance'])) return null;
  if (!count(rep.content) || !count(rep.posters) || !count(rep.videos) || !count(rep.finance)) return null;
  return { ...v, phones: v.phones === 'direct' ? 'direct' : 'code' } as unknown as LinkAnswers;
}

/**
 * Whether these answers may be agreed to. Each box runs this on its own copy of the two hellos before it signs:
 * one admin cannot make the other box accept a fixed answer overridden, a new box "kept", numbers other than the
 * ones the replaced box reported, or a replaced ledger without the tick.
 */
export function checkAnswers(a: LinkAnswers, show: LinkHello, scan: LinkHello): { ok: true; case: LinkCase } | { ok: false; code: LinkRefusal } {
  const rules = linkRules(show, scan);
  if (!rules.ok) return { ok: false, code: rules.code };
  if (rules.fixed.keep !== undefined && a.keep !== rules.fixed.keep) {
    return { ok: false, code: (a.keep === 'show' ? show : scan).setUp ? 'fixed_answer' : 'keep_new_box' };
  }
  if (rules.fixed.master !== undefined && a.master !== rules.fixed.master) return { ok: false, code: 'fixed_answer' };
  const rep = replacedNumbers(a.keep, show, scan);
  if (rep.content !== a.replaced.content || rep.posters !== a.replaced.posters || rep.videos !== a.replaced.videos || rep.finance !== a.replaced.finance) {
    return { ok: false, code: 'bad_message' };
  }
  if (rep.finance > 0 && !a.financeTick) return { ok: false, code: 'finance_tick' };
  return { ok: true, case: linkCase(a, show, scan) };
}

/**
 * The hash each box signs for its admin's "Setuju": it covers the session, both boxes, every part of the answers and
 * the two people lists (`peopleDigest` of each side), so a consent is for exactly the people both admins were shown.
 */
export function answersHash(
  linkId: string, a: LinkAnswers, show: Pick<LinkHello, 'boxId' | 'keyFp'>, scan: Pick<LinkHello, 'boxId' | 'keyFp'>,
  people: { show: string; scan: string },
): string {
  if (!LINK_ID_RE.test(linkId)) throw new Error('link: bad link id');
  if (!HEX64.test(people.show) || !HEX64.test(people.scan)) throw new Error('link: bad people digest');
  return sha256Hex(utf8(canonicalJson({
    p: 'maxcom-link-answers-v2', linkId,
    show: { boxId: show.boxId, keyFp: show.keyFp }, scan: { boxId: scan.boxId, keyFp: scan.keyFp },
    rev: a.rev, keep: a.keep, master: a.master, roles: a.roles, same: [...a.same].sort(), financeTick: a.financeTick, replaced: a.replaced,
    // the strict choice leaves the part out, so it hashes exactly as before this choice existed
    ...(a.phones === 'direct' ? { phones: 'direct' } : {}),
    people,
  })));
}

/** The body of a consent: which box agreed, to which revision and hash. Signed with step `consent`. */
export interface LinkConsent { boxId: string; rev: number; hash: string }

export function parseLinkConsent(v: unknown): LinkConsent | null {
  if (!isPlain(v) || !sameKeys(v, ['boxId', 'rev', 'hash'])) return null;
  if (typeof v.boxId !== 'string' || !HEX16.test(v.boxId) || !count(v.rev, 100_000) || v.rev < 1) return null;
  if (typeof v.hash !== 'string' || !HEX64.test(v.hash)) return null;
  return v as unknown as LinkConsent;
}

/** An agreement counts only for the exact revision and hash this box holds now, and only from the other box. */
export function consentMatches(c: LinkConsent, expect: { peerBoxId: string; rev: number; hash: string }): { ok: true } | { ok: false; code: 'stale_revision' | 'bad_message' } {
  if (c.boxId !== expect.peerBoxId) return { ok: false, code: 'bad_message' };
  if (c.rev !== expect.rev) return { ok: false, code: 'stale_revision' };
  if (c.hash !== expect.hash) return { ok: false, code: 'bad_message' };
  return { ok: true };
}

/** Time limits of a link session, in milliseconds. Expiry is judged by the box that issued it, never by a phone's clock. */
export const LINK_QR_TTL_MS = 5 * 60 * 1000;
export const LINK_APPROVE_TTL_MS = 2 * 60 * 1000;
export const LINK_IDLE_TTL_MS = 20 * 60 * 1000;
export const LINK_PIN_PROOF_TTL_MS = 15 * 60 * 1000;
