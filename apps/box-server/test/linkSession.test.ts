import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkIdFromNonce, parseBoxQr } from '@surau/core';
import type { LinkFacts } from '@surau/core';
import { randomToken } from '../src/auth/crypto.ts';
import { openDb } from '../src/db.ts';
import { LinkError, createLinkSessions } from '../src/link/session.ts';
import type { LinkSessions, LinkSessionRow, PeerTransport } from '../src/link/session.ts';
import { identityPub, signLink } from '../src/link/sign.ts';
import { ephemeralIdentity } from '../src/setup/identity.ts';
import type { BoxIdentity } from '../src/setup/identity.ts';

interface Box {
  id: string;
  origin: string;
  ca: string;
  db: DatabaseSync;
  identity: BoxIdentity;
  link: LinkSessions;
  agreed: LinkSessionRow[];
  over: { release?: string; followers?: number; isFollower?: boolean; setUp?: boolean; finance?: number; busy?: string | null };
}

let clock = new Date('2026-11-22T10:00:00Z');
const now = (): Date => clock;
const tick = (ms: number): void => {
  clock = new Date(clock.getTime() + ms);
};
const boxes = new Map<string, Box>();
/** What crossed the wire, for the tests that replay or change a message. */
let wire: { origin: string; path: string; body: unknown }[] = [];
let drop: ((path: string) => boolean) | null = null;

const transport: PeerTransport = {
  async post(origin, ca, path, body) {
    wire.push({ origin, path, body: structuredClone(body) });
    if (drop?.(path)) throw new Error('down');
    const b = boxes.get(origin);
    if (b === undefined || b.ca !== ca) throw new Error('unreachable');
    try {
      if (path === '/api/link/peer/hello') return { status: 200, json: structuredClone(b.link.peerHello(body, '10.168.0.9')) };
      const r = b.link.peerMessage(body);
      return r.ok ? { status: 200, json: structuredClone({ ok: true, ...(r.reply ?? {}) }) } : { status: r.status, json: structuredClone(r) };
    } catch (e) {
      if (e instanceof LinkError) return { status: e.status, json: { code: e.code, ...e.extra } };
      throw e;
    }
  },
};

const facts = (finance: number): LinkFacts => ({
  content: 9, posters: 3, videos: 1, finance, people: 6, lastEditAt: '2026-11-20T13:41:00.000Z', device: 'windows', wired: null, freeBytes: 5e9, youtube: false, cloud: false,
});

function box(n: number): Box {
  const identity = ephemeralIdentity();
  const b: Box = {
    id: String(n).repeat(16), origin: `https://10.168.0.${n}:8443`, ca: String(n).repeat(64), db: openDb(':memory:'), identity,
    link: undefined as never, agreed: [], over: {},
  };
  b.link = createLinkSessions({
    db: b.db, boxId: b.id, identity, now, peer: transport, random: () => randomToken(32),
    origin: () => b.origin, caSha256: () => b.ca, linked: () => false,
    busy: () => b.over.busy ?? null,
    onAgreed: (s) => b.agreed.push(s),
    ownHello: () => ({
      v: 1, proto: 1, boxId: b.id, keyFp: identity.keyFp, pub: identityPub(identity), caSha256: b.ca, name: `Kotak ${n}`,
      addresses: [b.origin], release: b.over.release ?? '2026.11.15', dbLevel: 29, setUp: b.over.setUp ?? true,
      isFollower: b.over.isFollower ?? false, followers: b.over.followers ?? 0, facts: facts(b.over.finance ?? 0),
    }),
  });
  boxes.set(b.origin, b);
  return b;
}

let A: Box;
let B: Box;
beforeEach(() => {
  clock = new Date('2026-11-22T10:00:00Z');
  boxes.clear();
  wire = [];
  drop = null;
  A = box(1);
  B = box(2);
});
afterEach(() => {
  for (const b of boxes.values()) b.db.close();
});

const fails = async (p: Promise<unknown> | (() => unknown), code: string): Promise<LinkError> => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(LinkError);
    expect((e as LinkError).code).toBe(code);
    return e as LinkError;
  }
  throw new Error(`expected ${code}`);
};

/** Show at A, scan at B, approve at A: both at the questions screen. */
async function toQuestions(): Promise<string> {
  const qr = A.link.show('razak');
  await B.link.scan('aminah', qr.payload);
  await A.link.approve(true);
  return qr.payload;
}

describe('link session: the happy path (case S)', () => {
  it('goes from the QR to both agreements, with one code on both boxes', async () => {
    const qr = A.link.show('razak');
    expect(parseBoxQr(qr.payload).type).toBe('link');
    expect(A.link.qrForTv()?.payload).toBe(qr.payload);
    expect(A.link.view()?.step).toBe('qr');

    const vb = await B.link.scan('aminah', qr.payload);
    expect(vb.step).toBe('code');
    expect(vb.code).toMatch(/^\d{6}$/);
    expect(A.link.view()?.code).toBe(vb.code);
    // the QR leaves the TV when used
    expect(A.link.qrForTv()).toBeNull();

    const va = await A.link.approve(true);
    expect(va.step).toBe('questions');
    expect(va.answers).toEqual({ rev: 1, keep: 'show', master: 'show', roles: {}, same: [], phones: 'direct', financeTick: false, replaced: { content: 9, posters: 3, videos: 1, finance: 0 } });
    expect(B.link.view()?.answers).toEqual(va.answers);
    expect(va.code).toBeNull();
    expect(va.case).toBe('S');

    const a1 = await A.link.agree(1);
    expect(a1.ownAgreed).toBe(true);
    expect(a1.step).toBe('questions');
    expect(B.link.view()?.peerAgreed).toBe(true);
    expect(A.agreed).toHaveLength(0);
    // nothing blocks writes before both agreed
    expect(A.link.writesBlocked()).toBe(false);

    const b1 = await B.link.agree(1);
    expect(b1.step).toBe('agreed');
    expect(A.link.view()?.step).toBe('agreed');
    expect(A.agreed).toHaveLength(1);
    expect(B.agreed).toHaveLength(1);
    expect(A.agreed[0]!.ownSig).not.toBeNull();
    expect(A.agreed[0]!.peerSig).toBe(B.agreed[0]!.ownSig);
    expect(A.agreed[0]!.answersHash).toBe(B.agreed[0]!.answersHash);
    expect(A.link.writesBlocked()).toBe(true);
    expect(B.link.writesBlocked()).toBe(true);
    await fails(A.link.cancel(), 'linking');
    A.link.finish('done');
    expect(A.link.writesBlocked()).toBe(false);
    expect(A.link.view()).toBeNull();
  });

  it('never puts a signature, a random or the one-time code in a view', async () => {
    const qr = await toQuestions();
    const nonce = parseBoxQr(qr).nonce;
    await A.link.agree(1);
    const text = JSON.stringify([A.link.view(), B.link.view()]);
    expect(text).not.toContain(nonce);
    expect(text).not.toContain('"rand"');
    expect(text).not.toContain('"sig"');
    expect(text).not.toContain(A.link.current()!.ownSig!);
  });
});

describe('link session: the QR and the hello', () => {
  it('a second caller on a spent code is refused, and the first one keeps its session', async () => {
    const qr = A.link.show('razak');
    await B.link.scan('aminah', qr.payload);
    const C = box(3);
    await fails(C.link.scan('orang', qr.payload), 'code_used');
    expect(A.link.view()?.peer?.boxId).toBe(B.id);
    expect(C.link.view()).toBeNull();
  });

  it('a third box that calls first shows another code than the honest admin could ever show', async () => {
    const qr = A.link.show('razak');
    const C = box(3);
    const vc = await C.link.scan('orang', qr.payload);
    // the honest admin's phone shows no code at all
    await fails(B.link.scan('aminah', qr.payload), 'code_used');
    expect(A.link.view()?.code).toBe(vc.code);
    expect(A.link.view()?.peer?.name).toBe('Kotak 3');
    // admin A, comparing with the phone of admin B, rejects
    await fails(A.link.approve(false), 'rejected');
    expect(A.link.view()).toBeNull();
    expect(C.link.view()).toBeNull();
  });

  it('an expired code is refused by the box that issued it', async () => {
    const qr = A.link.show('razak');
    tick(5 * 60 * 1000 + 1);
    await fails(B.link.scan('aminah', qr.payload), 'code_expired');
    expect(A.link.view()).toBeNull();
  });

  it('refuses a QR of another type, a changed QR and its own QR', async () => {
    const qr = A.link.show('razak');
    await fails(B.link.scan('aminah', 'maxcom1:AAAA'), 'bad_qr');
    await fails(B.link.scan('aminah', 12), 'bad_qr');
    const p = parseBoxQr(qr.payload);
    const forged = `maxcom1:${Buffer.from(JSON.stringify({ ...p, box: 'https://10.168.0.66:8443' })).toString('base64url')}`;
    await fails(B.link.scan('aminah', forged), 'bad_qr');
    await A.link.cancel();
    const mine = B.link.show('aminah');
    await B.link.cancel();
    await fails(B.link.scan('aminah', mine.payload), 'same_box');
  });

  it('a hello signed by another key, or for another box id, ends the session and spends the code', async () => {
    const qr = A.link.show('razak');
    const nonce = parseBoxQr(qr.payload).nonce;
    const id = linkIdFromNonce(nonce);
    const C = box(3);
    const hello = { ...C.link.show('x') && JSON.parse(String(C.db.prepare('SELECT own_hello_json FROM link_sessions').get()!.own_hello_json)) };
    const stranger = ephemeralIdentity();
    await fails(() => A.link.peerHello({ nonce, hello, sig: signLink(stranger, 'hello', id, hello) }, '10.168.0.9'), 'bad_message');
    expect(A.link.view()).toBeNull();
    await fails(B.link.scan('aminah', qr.payload), 'code_used');
  });

  it('stops on a version difference and names the box that is behind', async () => {
    B.over.release = '2026.11.14';
    const qr = A.link.show('razak');
    const e = await fails(B.link.scan('aminah', qr.payload), 'version');
    expect(e.extra).toEqual({ behind: 'scan' });
    expect(A.link.view()).toBeNull();
    expect(B.link.view()).toBeNull();
    expect(String(A.db.prepare('SELECT outcome FROM link_sessions').get()!.outcome)).toBe('version');
  });

  it('refuses a follower, and a box that is busy never shows a code', async () => {
    B.over.isFollower = true;
    const qr = A.link.show('razak');
    await fails(B.link.scan('aminah', qr.payload), 'follower');
    A.over.busy = 'live_on';
    await fails(() => A.link.show('razak'), 'live_on');
  });

  it('one session at a time, and five failed sessions lock the link screen for an hour', async () => {
    A.link.show('razak');
    await fails(() => A.link.show('razak'), 'session_open');
    await A.link.cancel();
    for (let i = 0; i < 5; i++) {
      const qr = A.link.show('razak');
      await B.link.scan('aminah', qr.payload);
      await fails(A.link.approve(false), 'rejected');
      tick(1000);
    }
    await fails(() => A.link.show('razak'), 'link_locked');
    tick(60 * 60 * 1000 + 1);
    expect(A.link.show('razak').payload).toMatch(/^maxcom1:/);
  });

  it('approval has two minutes; silence ends the session on both boxes', async () => {
    const qr = A.link.show('razak');
    await B.link.scan('aminah', qr.payload);
    tick(2 * 60 * 1000 + 1);
    await fails(A.link.approve(true), 'no_session');
    expect(B.link.view()).toBeNull();
  });

  it('only the box that showed the code may approve', async () => {
    const qr = A.link.show('razak');
    await B.link.scan('aminah', qr.payload);
    await fails(B.link.approve(true), 'wrong_side');
    // a forged approve from the scanning side to the showing side is refused by the step rule
    const s = B.link.current()!;
    const r = A.link.peerMessage({ linkId: s.id, step: 'approve', body: {}, sig: signLink(B.identity, 'approve', s.id, {}) });
    expect(r).toMatchObject({ ok: false, code: 'wrong_step' });
  });
});

describe('link session: answers and agreement', () => {
  it('a change of answers clears both agreements and needs a new agreement on the new revision', async () => {
    await toQuestions();
    await A.link.agree(1);
    const v = await B.link.setAnswers({ keep: 'show', master: 'scan', financeTick: false });
    expect(v.answers?.rev).toBe(2);
    expect(v.case).toBe('X');
    expect(A.link.view()).toMatchObject({ ownAgreed: false, peerAgreed: false });
    expect(A.link.view()?.answers?.master).toBe('scan');
    // an agreement to the revision the admin saw before the change is refused
    const e = await fails(A.link.agree(1), 'stale_revision');
    expect(e.extra).toEqual({ rev: 2 });
    await A.link.agree(2);
    await B.link.agree(2);
    expect(A.agreed).toHaveLength(1);
    expect(A.agreed[0]!.answers?.master).toBe('scan');
  });

  it('a PUT without phones keeps the current answer (direct stays direct, code stays code)', async () => {
    await toQuestions();
    expect(A.link.view()?.answers?.phones).toBe('direct');
    const v1 = await A.link.setAnswers({ keep: 'show', master: 'show', financeTick: false });
    expect(v1.answers?.phones).toBe('direct');
    const v2 = await A.link.setAnswers({ keep: 'show', master: 'show', phones: 'code', financeTick: false });
    expect(v2.answers?.phones).toBe('code');
    const v3 = await A.link.setAnswers({ keep: 'show', master: 'show', financeTick: false });
    expect(v3.answers?.phones).toBe('code');
    expect(B.link.view()?.answers?.phones).toBe('code');
  });

  it('needs the finance tick when the replaced box has finance records', async () => {
    B.over.finance = 148;
    await toQuestions();
    await fails(A.link.agree(1), 'finance_tick');
    await A.link.setAnswers({ keep: 'show', master: 'show', financeTick: true });
    await A.link.agree(2);
    await B.link.agree(2);
    expect(B.agreed).toHaveLength(1);
  });

  it('a box with followers gets the fixed answers', async () => {
    A.over.followers = 2;
    await toQuestions();
    expect(A.link.view()?.fixed).toEqual({ keep: 'show', master: 'show' });
    await fails(B.link.setAnswers({ keep: 'scan', master: 'scan', financeTick: true }), 'fixed_answer');
    await fails(B.link.setAnswers({ keep: 'show', master: 'scan', financeTick: false }), 'fixed_answer');
  });

  it('a new box cannot be the kept data, but may become the master (case N-X)', async () => {
    B.over.setUp = false;
    await toQuestions();
    await fails(A.link.setAnswers({ keep: 'scan', master: 'scan', financeTick: true }), 'keep_new_box');
    const v = await A.link.setAnswers({ keep: 'show', master: 'scan', financeTick: false });
    expect(v.case).toBe('N-X');
    expect(v.answers?.replaced).toEqual({ content: 0, posters: 0, videos: 0, finance: 0 });
  });

  it('an agreement needs a PIN typed within 15 minutes; proving it again is enough', async () => {
    await toQuestions();
    tick(15 * 60 * 1000 + 1);
    // keep the session itself alive: the idle limit is 20 minutes from the last change
    await fails(A.link.agree(1), 'pin_required');
    expect(A.link.view()?.pinFresh).toBe(false);
    A.link.provePin('razak');
    expect((await A.link.agree(1)).ownAgreed).toBe(true);
  });

  it('twenty minutes without a change end the session with nothing agreed', async () => {
    await toQuestions();
    tick(20 * 60 * 1000 + 1);
    expect(A.link.view()).toBeNull();
    expect(B.link.view()).toBeNull();
    expect(A.agreed).toHaveLength(0);
  });

  it('two admins changing at the same moment end with one set of answers on both boxes', async () => {
    await toQuestions();
    // B's change reaches A only after A stored its own revision 2: A (the box that showed the code) keeps its own
    const s = B.link.current()!;
    await A.link.setAnswers({ keep: 'show', master: 'scan', financeTick: false });
    const racing = { rev: 2, keep: 'show', master: 'show', roles: {}, same: [], financeTick: true, replaced: s.answers!.replaced };
    const r = A.link.peerMessage({ linkId: s.id, step: 'answers', body: { answers: racing }, sig: signLink(B.identity, 'answers', s.id, { answers: racing }) });
    expect(r).toMatchObject({ ok: false, code: 'stale_revision' });
    expect(A.link.view()?.answers).toEqual(B.link.view()?.answers);
    expect(B.link.view()?.answers?.master).toBe('scan');
  });

  it('cancel before the agreement ends both sides and changes nothing', async () => {
    await toQuestions();
    await A.link.agree(1);
    await B.link.cancel();
    expect(A.link.view()).toBeNull();
    expect(B.link.view()).toBeNull();
    expect(A.agreed).toHaveLength(0);
    expect(String(A.db.prepare('SELECT outcome FROM link_sessions').get()!.outcome)).toBe('cancelled_by_peer');
  });

  it('the peer going away during an agreement leaves this box not agreed', async () => {
    await toQuestions();
    drop = () => true;
    await fails(A.link.agree(1), 'peer_unreachable');
    drop = null;
    expect(A.agreed).toHaveLength(0);
    expect(A.link.view()?.step).toBe('questions');
  });
});

describe('link session: forged and replayed box-to-box messages', () => {
  it('refuses a message with no signature, a wrong signature, another session id or an unknown step', async () => {
    await toQuestions();
    const s = A.link.current()!;
    const consent = { boxId: B.id, rev: 1, hash: s.answersHash };
    const stranger = ephemeralIdentity();
    expect(A.link.peerMessage({ linkId: s.id, step: 'consent', body: consent })).toMatchObject({ ok: false, code: 'bad_message' });
    expect(A.link.peerMessage({ linkId: s.id, step: 'consent', body: consent, sig: signLink(stranger, 'consent', s.id, consent) })).toMatchObject({ ok: false, code: 'bad_message' });
    // box A's own signature is not the peer's
    expect(A.link.peerMessage({ linkId: s.id, step: 'consent', body: consent, sig: signLink(A.identity, 'consent', s.id, consent) })).toMatchObject({ ok: false, code: 'bad_message' });
    expect(A.link.peerMessage({ linkId: 'f'.repeat(32), step: 'consent', body: consent, sig: signLink(B.identity, 'consent', s.id, consent) })).toMatchObject({ ok: false, code: 'no_session' });
    expect(A.link.peerMessage({ linkId: s.id, step: 'order-forget', body: {}, sig: signLink(B.identity, 'order-forget', s.id, {}) })).toMatchObject({ ok: false, code: 'bad_message' });
    // a commit before both agreements is refused, whoever signed it
    expect(A.link.peerMessage({ linkId: s.id, step: 'commit', body: {}, sig: signLink(B.identity, 'commit', s.id, {}) })).toMatchObject({ ok: false, code: 'wrong_step' });
    expect(A.link.peerMessage(null)).toMatchObject({ ok: false });
    expect(A.link.view()?.peerAgreed).toBe(false);
  });

  it('a consent for another revision, another hash or in the name of the wrong box does not count', async () => {
    await toQuestions();
    const s = A.link.current()!;
    const sendConsent = (c: unknown): unknown => A.link.peerMessage({ linkId: s.id, step: 'consent', body: c, sig: signLink(B.identity, 'consent', s.id, c) });
    expect(sendConsent({ boxId: B.id, rev: 2, hash: s.answersHash })).toMatchObject({ ok: false, code: 'stale_revision' });
    expect(sendConsent({ boxId: B.id, rev: 1, hash: 'f'.repeat(64) })).toMatchObject({ ok: false, code: 'bad_message' });
    expect(sendConsent({ boxId: A.id, rev: 1, hash: s.answersHash })).toMatchObject({ ok: false, code: 'bad_message' });
    expect(A.link.view()?.peerAgreed).toBe(false);
  });

  it('a consent replayed after the answers changed does not count for the new answers', async () => {
    await toQuestions();
    await B.link.agree(1);
    const old = wire.filter((w) => w.path === '/api/link/peer/message' && (w.body as { step: string }).step === 'consent').at(-1)!;
    await A.link.setAnswers({ keep: 'show', master: 'scan', financeTick: false });
    expect(A.link.peerMessage(old.body)).toMatchObject({ ok: false, code: 'stale_revision' });
    await A.link.agree(2);
    expect(A.agreed).toHaveLength(0);
    expect(A.link.view()?.peerAgreed).toBe(false);
  });

  it('answers that break a rule are refused even when signed by the peer', async () => {
    A.over.followers = 1;
    await toQuestions();
    const s = A.link.current()!;
    const bad = { rev: 2, keep: 'scan', master: 'scan', roles: {}, same: [], financeTick: true, replaced: { content: 9, posters: 3, videos: 1, finance: 0 } };
    expect(A.link.peerMessage({ linkId: s.id, step: 'answers', body: { answers: bad }, sig: signLink(B.identity, 'answers', s.id, { answers: bad }) })).toMatchObject({ ok: false, code: 'bad_message' });
    const lying = { rev: 2, keep: 'show', master: 'show', roles: {}, same: [], financeTick: false, replaced: { content: 0, posters: 0, videos: 0, finance: 0 } };
    expect(A.link.peerMessage({ linkId: s.id, step: 'answers', body: { answers: lying }, sig: signLink(B.identity, 'answers', s.id, { answers: lying }) })).toMatchObject({ ok: false, code: 'bad_message' });
    expect(A.link.view()?.answers?.rev).toBe(1);
  });

  it('a cancel cannot undo an agreement, and a restart ends only a session that was not agreed', async () => {
    await toQuestions();
    A.link.recover();
    expect(A.link.view()).toBeNull();
    expect(String(A.db.prepare('SELECT outcome FROM link_sessions').get()!.outcome)).toBe('restart');
    await B.link.cancel();

    tick(1000);
    await toQuestions();
    await A.link.agree(1);
    await B.link.agree(1);
    const s = A.link.current()!;
    expect(A.link.peerMessage({ linkId: s.id, step: 'cancel', body: { reason: 'cancelled' }, sig: signLink(B.identity, 'cancel', s.id, { reason: 'cancelled' }) })).toMatchObject({ ok: false, code: 'linking' });
    // an agreed session does not run out by time
    tick(24 * 60 * 60 * 1000);
    expect(A.link.view()?.step).toBe('agreed');
    expect(A.link.writesBlocked()).toBe(true);
    // after a restart the disk decides: this box holds no follower row and no follow record, so the link failed
    A.link.recover();
    expect(A.link.view()).toBeNull();
    expect(A.link.writesBlocked()).toBe(false);
    expect(String(A.db.prepare('SELECT outcome FROM link_sessions WHERE id = ?').get(s.id)!.outcome)).toBe('failed');
  });
});
