import { describe, expect, it } from 'vitest';
import { boxQrMessage, keyFingerprint, parseBoxQr } from '../src/index.ts';
import type { BoxQrPub } from '../src/index.ts';
import {
  LINK_MESSAGE_PREFIX, adviseMaster, answersHash, checkAnswers, checkVersions, compareReleases, consentMatches, defaultAnswers,
  linkCase, linkIdFromNonce, linkMessage, linkRules, matchingCode, matchingCodeGroups, parseLinkAnswers, parseLinkConsent,
  parseLinkHello, replacedNumbers,
} from '../src/link/protocol.ts';
import type { LinkAnswers, LinkHello } from '../src/link/protocol.ts';

const b64 = (c: string): string => c.repeat(43);
const pubOf = (c: string): BoxQrPub => ({ kty: 'EC', crv: 'P-256', x: b64(c), y: b64(c.toLowerCase() === c ? c.toUpperCase() : c.toLowerCase()) });
const text = (b: Uint8Array): string => new TextDecoder().decode(b);
const NONCE = b64('n');

function hello(over: Partial<LinkHello> & { key?: string } = {}): LinkHello {
  const { key = 'a', ...rest } = over;
  const pub = pubOf(key);
  return {
    v: 1, proto: 1, boxId: key.repeat(16).replace(/[^0-9a-f]/g, '0').slice(0, 16).padEnd(16, '1'), keyFp: keyFingerprint(pub), pub,
    caSha256: '0'.repeat(64), name: 'Dewan Utama', addresses: ['https://10.168.0.10:8443'], release: '2026.11.15', dbLevel: 29,
    rand: b64(key), setUp: true, isFollower: false, followers: 0,
    facts: { content: 9, posters: 3, videos: 1, finance: 148, people: 6, lastEditAt: '2026-11-20T13:41:00.000Z', device: 'windows', wired: true, freeBytes: 5e9, youtube: true, cloud: true },
    ...rest,
  };
}
const show = (o: Partial<LinkHello> = {}): LinkHello => hello({ key: 'a', ...o });
const scan = (o: Partial<LinkHello> = {}): LinkHello =>
  hello({ key: 'b', name: 'Ruang Muslimat', facts: { ...hello().facts, content: 14, posters: 2, videos: 0, finance: 0, people: 5, device: 'android', wired: false, freeBytes: 1.7e9, youtube: false }, ...o });

describe('link message', () => {
  it('has its own first part and names the step and the session', () => {
    const id = linkIdFromNonce(NONCE);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const m = text(linkMessage('hello', id, { a: 1 }));
    expect(m.startsWith(`${LINK_MESSAGE_PREFIX}|hello|${id}|`)).toBe(true);
    expect(m.split('|')).toHaveLength(4);
    expect(m.split('|')[3]).toMatch(/^[0-9a-f]{64}$/);
  });
  it('differs by step, by session and by body; key order does not matter', () => {
    const id = linkIdFromNonce(NONCE);
    const other = linkIdFromNonce(b64('m'));
    const m = text(linkMessage('consent', id, { a: 1, b: 2 }));
    expect(text(linkMessage('consent', id, { b: 2, a: 1 }))).toBe(m);
    expect(text(linkMessage('commit', id, { a: 1, b: 2 }))).not.toBe(m);
    expect(text(linkMessage('consent', other, { a: 1, b: 2 }))).not.toBe(m);
    expect(text(linkMessage('consent', id, { a: 1, b: 3 }))).not.toBe(m);
  });
  it('can never equal a box QR message', () => {
    const id = linkIdFromNonce(NONCE);
    const qr = text(boxQrMessage({ v: 1, type: 'link', boxId: 'a'.repeat(16), keyFp: 'b'.repeat(16), name: 'x', box: '', caSha256: null, linked: false, nonce: NONCE, iat: 1, exp: 2, pub: pubOf('a') }));
    expect(qr.startsWith('maxcom-qr\n')).toBe(true);
    for (const step of ['hello', 'answers', 'consent', 'commit', 'order-forget', 'order-revert', 'order-standalone'] as const) {
      expect(text(linkMessage(step, id, {})).startsWith('maxcom-qr')).toBe(false);
    }
  });
  it('refuses an unknown step, a bad session id and a bad nonce', () => {
    const id = linkIdFromNonce(NONCE);
    expect(() => linkMessage('hello|x' as never, id, {})).toThrow();
    expect(() => linkMessage('hello', 'ABC', {})).toThrow();
    expect(() => linkMessage('hello', `${id}|`, {})).toThrow();
    expect(() => linkIdFromNonce('short')).toThrow();
  });
});

describe('link QR type', () => {
  it('parses a payload of type link and still refuses an unknown type', () => {
    const pub = pubOf('a');
    const p = { v: 1, type: 'link', boxId: 'a'.repeat(16), keyFp: keyFingerprint(pub), name: 'Dewan', box: 'https://10.168.0.10:8443', caSha256: '0'.repeat(64), linked: true, nonce: NONCE, iat: 10, exp: 310, pub, sig: 's'.repeat(86) };
    const enc = (o: unknown): string => `maxcom1:${Buffer.from(JSON.stringify(o)).toString('base64url')}`;
    expect(parseBoxQr(enc(p)).type).toBe('link');
    expect(() => parseBoxQr(enc({ ...p, type: 'unlink' }))).toThrow();
  });
});

describe('hello', () => {
  it('accepts a full hello and refuses extra, missing and malformed fields', () => {
    expect(parseLinkHello(show())).not.toBeNull();
    expect(parseLinkHello({ ...show(), extra: 1 })).toBeNull();
    const { rand: _r, ...noRand } = show();
    expect(parseLinkHello(noRand)).toBeNull();
    expect(parseLinkHello({ ...show(), keyFp: 'f'.repeat(16) })).toBeNull();
    expect(parseLinkHello({ ...show(), addresses: [] })).toBeNull();
    expect(parseLinkHello({ ...show(), addresses: ['http://10.168.0.10'] })).toBeNull();
    expect(parseLinkHello({ ...show(), addresses: ['https://u:p@10.168.0.10'] })).toBeNull();
    expect(parseLinkHello({ ...show(), release: '2026.11.15; rm' })).toBeNull();
    expect(parseLinkHello({ ...show(), followers: -1 })).toBeNull();
    expect(parseLinkHello({ ...show(), facts: { ...show().facts, people: 1.5 } })).toBeNull();
    expect(parseLinkHello({ ...show(), facts: { ...show().facts, names: ['Razak'] } })).toBeNull();
    expect(parseLinkHello({ ...show(), pub: { ...show().pub, d: 'secret' } })).toBeNull();
    expect(parseLinkHello(null)).toBeNull();
    expect(parseLinkHello([])).toBeNull();
  });
});

describe('matching code', () => {
  const base = { showPub: pubOf('a'), scanPub: pubOf('b'), showRand: b64('a'), scanRand: b64('b'), nonce: NONCE };
  it('is six digits, stable, and grouped left to right', () => {
    const c = matchingCode(base);
    expect(c).toMatch(/^\d{6}$/);
    expect(matchingCode({ ...base })).toBe(c);
    expect(matchingCodeGroups('482193')).toBe('482 193');
  });
  it('changes when any input changes, so a third box that calls first shows another number', () => {
    const c = matchingCode(base);
    const others = [
      matchingCode({ ...base, scanPub: pubOf('c') }),
      matchingCode({ ...base, showPub: pubOf('c') }),
      matchingCode({ ...base, scanRand: b64('c') }),
      matchingCode({ ...base, showRand: b64('c') }),
      matchingCode({ ...base, nonce: b64('m') }),
      matchingCode({ ...base, showPub: base.scanPub, scanPub: base.showPub }),
    ];
    // six independent six-digit numbers all equal to c would be a broken derivation
    expect(others.filter((x) => x === c).length).toBeLessThan(2);
    expect(new Set(others).size).toBeGreaterThan(3);
  });
  it('refuses malformed inputs', () => {
    expect(() => matchingCode({ ...base, nonce: 'x' })).toThrow();
    expect(() => matchingCode({ ...base, showRand: '' })).toThrow();
  });
});

describe('version check (L1)', () => {
  it('passes only when release, protocol and database level are equal', () => {
    expect(checkVersions(show(), scan())).toEqual({ ok: true });
    expect(checkVersions(show(), scan({ release: '2026.11.14' }))).toEqual({ ok: false, code: 'version', behind: 'scan' });
    expect(checkVersions(show({ release: '2026.9.30' }), scan({ release: '2026.11.2' }))).toEqual({ ok: false, code: 'version', behind: 'show' });
    expect(checkVersions(show({ proto: 2 }), scan())).toEqual({ ok: false, code: 'protocol', behind: 'scan' });
    expect(checkVersions(show({ dbLevel: 28 }), scan())).toEqual({ ok: false, code: 'db_level', behind: 'show' });
  });
  it('compares releases by number, not by text', () => {
    expect(compareReleases('2026.11.9', '2026.11.10')).toBeLessThan(0);
    expect(compareReleases('2026.12.1', '2026.11.30')).toBeGreaterThan(0);
    expect(compareReleases('2026.11.15', '2026.11.15')).toBe(0);
  });
});

describe('rules and cases', () => {
  it('refuses a follower, two new boxes, two masters with followers and a box linking to itself', () => {
    expect(linkRules(show({ isFollower: true }), scan())).toEqual({ ok: false, code: 'follower' });
    expect(linkRules(show(), scan({ isFollower: true }))).toEqual({ ok: false, code: 'follower' });
    expect(linkRules(show({ setUp: false }), scan({ setUp: false }))).toEqual({ ok: false, code: 'both_new' });
    expect(linkRules(show({ followers: 1 }), scan({ followers: 2 }))).toEqual({ ok: false, code: 'both_have_followers' });
    expect(linkRules(show(), show())).toEqual({ ok: false, code: 'same_box' });
  });
  it('fixes the answers for a box with followers and for a new box', () => {
    expect(linkRules(show(), scan())).toEqual({ ok: true, fixed: {} });
    expect(linkRules(show({ followers: 2 }), scan())).toEqual({ ok: true, fixed: { keep: 'show', master: 'show' } });
    expect(linkRules(show(), scan({ setUp: false }))).toEqual({ ok: true, fixed: { keep: 'show' } });
    expect(linkRules(show({ setUp: false }), scan())).toEqual({ ok: true, fixed: { keep: 'scan' } });
  });
  it('names the four cases', () => {
    expect(linkCase({ keep: 'show', master: 'show' }, show(), scan())).toBe('S');
    expect(linkCase({ keep: 'scan', master: 'show' }, show(), scan())).toBe('X');
    expect(linkCase({ keep: 'show', master: 'show' }, show(), scan({ setUp: false }))).toBe('N-S');
    expect(linkCase({ keep: 'show', master: 'scan' }, show(), scan({ setUp: false }))).toBe('N-X');
  });
  it('advises the Windows PC on a cable, then the larger disk, and a set-up box over a new one', () => {
    expect(adviseMaster(show(), scan())).toBe('show');
    expect(adviseMaster(scan(), show())).toBe('scan');
    const twin = (free: number): LinkHello => scan({ facts: { ...scan().facts, freeBytes: free } });
    expect(adviseMaster(hello({ key: 'c', facts: twin(1e9).facts }), twin(2e9))).toBe('scan');
    expect(adviseMaster(show({ setUp: false }), scan())).toBe('scan');
  });
  it('defaults to the same box for both answers and carries the replaced numbers', () => {
    const d = defaultAnswers(show(), scan());
    expect(d).toEqual({ rev: 1, keep: 'show', master: 'show', roles: {}, same: [], phones: 'direct', financeTick: false, replaced: { content: 14, posters: 2, videos: 0, finance: 0 } });
    expect(defaultAnswers(show({ isFollower: true }), scan())).toBeNull();
    expect(replacedNumbers('show', show(), scan({ setUp: false }))).toEqual({ content: 0, posters: 0, videos: 0, finance: 0 });
  });
});

describe('answers', () => {
  const ok = (o: Partial<LinkAnswers> = {}): LinkAnswers => ({ ...defaultAnswers(show(), scan())!, ...o });
  const keepScan = (o: Partial<LinkAnswers> = {}): LinkAnswers => ok({ keep: 'scan', replaced: replacedNumbers('scan', show(), scan()), ...o });

  it('parses strictly', () => {
    expect(parseLinkAnswers(ok())).not.toBeNull();
    expect(parseLinkAnswers({ ...ok(), extra: true })).toBeNull();
    expect(parseLinkAnswers({ ...ok(), rev: 0 })).toBeNull();
    expect(parseLinkAnswers({ ...ok(), phones: 'code' })).toMatchObject({ phones: 'code' });
    expect(parseLinkAnswers({ ...ok(), phones: 'direct' })).toMatchObject({ phones: 'direct' });
    expect(parseLinkAnswers({ ...ok(), phones: 'everyone' })).toBeNull();
    expect(parseLinkAnswers({ ...ok(), phones: true })).toBeNull();
    expect(parseLinkAnswers({ ...ok(), keep: 'both' })).toBeNull();
    expect(parseLinkAnswers({ ...ok(), roles: { '+60120000001': 'pentadbir' } })).not.toBeNull();
    expect(parseLinkAnswers({ ...ok(), roles: { razak: 'pentadbir' } })).toBeNull();
    expect(parseLinkAnswers({ ...ok(), roles: { '+60120000001': 'Admin; DROP' } })).toBeNull();
    expect(parseLinkAnswers({ ...ok(), replaced: { content: 1, posters: 1, videos: 1 } })).toBeNull();
  });
  it('accepts the default and case X, and names the case', () => {
    expect(checkAnswers(ok(), show(), scan())).toEqual({ ok: true, case: 'S' });
    expect(checkAnswers(ok({ master: 'scan' }), show(), scan())).toEqual({ ok: true, case: 'X' });
  });
  it('needs the finance tick when the replaced box has finance records', () => {
    expect(checkAnswers(keepScan(), show(), scan())).toEqual({ ok: false, code: 'finance_tick' });
    expect(checkAnswers(keepScan({ financeTick: true }), show(), scan())).toEqual({ ok: true, case: 'X' });
  });
  it('refuses numbers other than the ones the replaced box reported', () => {
    expect(checkAnswers(ok({ replaced: { content: 0, posters: 0, videos: 0, finance: 0 } }), show(), scan())).toEqual({ ok: false, code: 'bad_message' });
  });
  it('refuses a fixed answer overridden and a new box kept', () => {
    const lead = show({ followers: 1 });
    expect(checkAnswers(keepScan({ financeTick: true }), lead, scan())).toEqual({ ok: false, code: 'fixed_answer' });
    expect(checkAnswers(ok({ master: 'scan' }), lead, scan())).toEqual({ ok: false, code: 'fixed_answer' });
    const fresh = scan({ setUp: false });
    expect(checkAnswers({ ...ok(), keep: 'scan', replaced: replacedNumbers('scan', show(), fresh), financeTick: true }, show(), fresh)).toEqual({ ok: false, code: 'keep_new_box' });
    expect(checkAnswers({ ...ok(), master: 'scan', replaced: replacedNumbers('show', show(), fresh) }, show(), fresh)).toEqual({ ok: true, case: 'N-X' });
  });
  const PD = { show: 'a'.repeat(64), scan: 'b'.repeat(64) };
  it('defaults to "direct" and reads a missing field (an older peer) as the strict "code"', () => {
    expect(defaultAnswers(show(), scan())!.phones).toBe('direct');
    const { phones: _p, ...old } = ok();
    expect(parseLinkAnswers(old)).toMatchObject({ phones: 'code' });
    // the strict choice hashes as an older peer hashes it (no phones part), so the two still agree
    const id = linkIdFromNonce(NONCE);
    expect(answersHash(id, ok({ phones: 'code' }), show(), scan(), PD)).not.toBe(answersHash(id, ok({ phones: 'direct' }), show(), scan(), PD));
  });
  it('hashes every part of what is agreed', () => {
    const id = linkIdFromNonce(NONCE);
    const h = answersHash(id, ok(), show(), scan(), PD);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    const variants: LinkAnswers[] = [
      ok({ rev: 2 }), ok({ master: 'scan' }), ok({ phones: 'code' }), keepScan(), ok({ financeTick: true }),
      ok({ roles: { '+60120000001': 'pentadbir' } }), ok({ replaced: { content: 15, posters: 2, videos: 0, finance: 0 } }),
    ];
    variants.push(ok({ same: ['person-0001'] }));
    for (const v of variants) expect(answersHash(id, v, show(), scan(), PD)).not.toBe(h);
    // the people both admins were shown are part of the agreement
    expect(answersHash(id, ok(), show(), scan(), { show: PD.show, scan: 'e'.repeat(64) })).not.toBe(h);
    expect(answersHash(id, ok(), show(), scan(), { show: PD.scan, scan: PD.show })).not.toBe(h);
    expect(() => answersHash(id, ok(), show(), scan(), { show: 'x', scan: PD.scan })).toThrow();
    expect(answersHash(linkIdFromNonce(b64('m')), ok(), show(), scan(), PD)).not.toBe(h);
    expect(answersHash(id, ok(), scan(), show(), PD)).not.toBe(h);
    expect(answersHash(id, ok(), show(), hello({ key: 'c' }), PD)).not.toBe(h);
    expect(answersHash(id, { ...ok(), roles: {} }, show(), scan(), PD)).toBe(h);
  });
  it('counts a consent only from the other box, for this revision and this hash', () => {
    const id = linkIdFromNonce(NONCE);
    const a = ok();
    const hash = answersHash(id, a, show(), scan(), PD);
    const expectIt = { peerBoxId: scan().boxId, rev: a.rev, hash };
    expect(consentMatches({ boxId: scan().boxId, rev: 1, hash }, expectIt)).toEqual({ ok: true });
    expect(consentMatches({ boxId: show().boxId, rev: 1, hash }, expectIt)).toEqual({ ok: false, code: 'bad_message' });
    expect(consentMatches({ boxId: scan().boxId, rev: 2, hash }, expectIt)).toEqual({ ok: false, code: 'stale_revision' });
    expect(consentMatches({ boxId: scan().boxId, rev: 1, hash: 'f'.repeat(64) }, expectIt)).toEqual({ ok: false, code: 'bad_message' });
    expect(parseLinkConsent({ boxId: scan().boxId, rev: 1, hash })).not.toBeNull();
    expect(parseLinkConsent({ boxId: scan().boxId, rev: 1, hash, sig: 'x' })).toBeNull();
    expect(parseLinkConsent({ boxId: 'nope', rev: 1, hash })).toBeNull();
  });
});
