import { generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { boxId as boxIdOf } from '../src/auth/secrets.ts';
import { createFollowStore } from '../src/follow/store.ts';
import type { FollowRecord } from '../src/follow/store.ts';
import { createMovesStore, moveMessage } from '../src/follow/moves.ts';
import type { MoveEntry } from '../src/follow/moves.ts';
import { identityPub, signLink, verifyLink } from '../src/link/sign.ts';
import { ephemeralIdentity, loadIdentity } from '../src/setup/identity.ts';

/**
 * The follower side of the phone move (phase 2C): `POST /api/follow/move/challenge` and `POST /api/follow/move` on a
 * real `buildApp` on a real data folder that holds a follow record and a sealed `secret/follow-moves.json`, with the
 * master replaced by a dead channel. The phone is a P-256 key here; the follower knows only its public half.
 */

const MASTER_ORIGIN = 'https://10.168.50.10:8443';
const MASTER_CA = 'ab'.repeat(32);
const MASTER_BOX = 'b'.repeat(16);
const LINK = 'a'.repeat(32);
const TOKEN = `Zq9X${'a1'.repeat(19)}b`;
const LAN = '10.168.50.20';
const CHALLENGE = '/api/follow/move/challenge';
const MOVE = '/api/follow/move';
const START = new Date('2026-11-22T10:00:00.000Z');
const TICKET_END = '2026-12-22T10:00:00.000Z';

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'maxcom-move-'));
  dirs.push(d);
  return d;
};

/** The master is not reachable: the mirror of the follower asks and gets 404, which is all these routes need. */
const deadMaster = {
  async request(): Promise<IncomingMessage> {
    return Object.assign(Readable.from([Buffer.from('{}')]), { statusCode: 404, headers: { 'content-type': 'application/json', 'content-length': '2' } }) as unknown as IncomingMessage;
  },
  async json() {
    return { status: 404, json: null };
  },
  post: async () => ({ status: 500, json: null }),
};
const sleep = (_ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });

interface Phone { deviceId: string; key: KeyObject; entry: MoveEntry }
const phone = (deviceId: string, userId: string, ticket: string): Phone => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = pair.publicKey.export({ format: 'jwk' }) as Record<string, string>;
  return { deviceId, key: pair.privateKey, entry: { deviceId, jwk: { kty: j.kty!, crv: j.crv!, x: j.x!, y: j.y! }, userId, ticket } };
};
/** The phone's answer to a challenge: P-256 over `maxcom-link-move\n<box>\n<device>\n<nonce>`, 64 bytes, base64url. */
const signMove = (key: KeyObject, boxId: string, deviceId: string, nonce: string): string =>
  sign('sha256', moveMessage(boxId, deviceId, nonce), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');

interface Follower {
  app: FastifyInstance;
  boxId: string;
  dir: string;
  identity: ReturnType<typeof loadIdentity>;
  masterId: ReturnType<typeof ephemeralIdentity>;
  ana: Phone;
  budi: Phone;
  clock: { set: (d: Date) => void; tick: (ms: number) => void; now: () => Date };
}

/** A follower with two phones in its move list (two people, each with a ticket). `moves: false` writes no list. */
async function startFollower(o: { moves?: boolean; follower?: boolean } = {}): Promise<Follower> {
  const dir = tempDir();
  const identity = loadIdentity(dir);
  const boxId = boxIdOf(dir);
  const masterId = ephemeralIdentity();
  let time = new Date(START);
  const clock = { set: (d: Date): void => { time = d; }, tick: (ms: number): void => { time = new Date(time.getTime() + ms); }, now: (): Date => time };
  const ana = phone('phone-ana-0001', 'user-ana-0001', 'AAAA-1111');
  const budi = phone('phone-budi-0001', 'user-budi-0001', 'BBBB-2222');
  if (o.follower !== false) {
    const rec: FollowRecord = {
      v: 1, linkId: LINK, masterBoxId: MASTER_BOX, masterKeyFp: masterId.keyFp, masterPub: identityPub(masterId), masterCa: MASTER_CA,
      masterName: 'Surau Al-Hidayah', addresses: [MASTER_ORIGIN], token: TOKEN, deviceId: 'device-ruang-muslimat', linkedAt: '2026-11-20T10:00:00.000Z', hadStore: false,
    };
    createFollowStore(dir, identity, boxId).write(rec);
    if (o.moves !== false) createMovesStore(dir, identity, boxId).write({ v: 1, linkId: LINK, expiresAt: TICKET_END, entries: [ana.entry, budi.entry] });
  }
  const app = buildApp(join(dir, 'surau.db'), {
    dataDir: dir, now: clock.now,
    liveTools: { dir: join(dir, 'tools'), spawn: { exe: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }, apiPort: 1, webrtcPort: 1 },
    link: { mirrorClient: deadMaster, restart: () => undefined, mirror: { sleep, refreshMs: 3_600_000, retryMs: 3_600_000, idleMs: 3_600_000 } },
  });
  apps.push(app);
  await app.ready();
  return { app, boxId, dir, identity, masterId, ana, budi, clock };
}

type Res = { status: number; body: Record<string, any>; headers: Record<string, any> };
const post = async (f: Follower, url: string, payload: unknown, o: { from?: string; headers?: Record<string, string> } = {}): Promise<Res> => {
  const r = await f.app.inject({ method: 'POST', url, payload: payload as object, remoteAddress: o.from ?? LAN, headers: o.headers ?? {} });
  let body: Record<string, any> = {};
  try {
    body = r.json() as Record<string, any>;
  } catch {
    body = {};
  }
  return { status: r.statusCode, body, headers: r.headers };
};
const challenge = async (f: Follower, deviceId: string, o: { from?: string } = {}): Promise<string> => {
  const r = await post(f, CHALLENGE, { deviceId }, o);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return String(r.body.nonce);
};
const move = (f: Follower, p: Phone, nonce: string, o: { key?: KeyObject; deviceId?: string; from?: string } = {}): Promise<Res> => {
  const deviceId = o.deviceId ?? p.deviceId;
  return post(f, MOVE, { deviceId, nonce, signature: signMove(o.key ?? p.key, f.boxId, deviceId, nonce) }, o.from === undefined ? {} : { from: o.from });
};

describe('phone move: a phone that proves its key gets the master pointer', () => {
  it('challenge then move with the right device signature answers { pointer, sig }', async () => {
    const f = await startFollower();
    const nonce = await challenge(f, f.ana.deviceId);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const r = await move(f, f.ana, nonce);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['pointer', 'sig']);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('sig verifies with the follower identity key over step move; any change to the pointer or the step breaks it', async () => {
    const f = await startFollower();
    const r = await move(f, f.ana, await challenge(f, f.ana.deviceId));
    const { pointer, sig } = r.body;
    expect(verifyLink(identityPub(f.identity), 'move', LINK, pointer, sig)).toBe(true);
    expect(verifyLink(identityPub(f.identity), 'move', LINK, { ...pointer, ticket: 'BBBB-2222' }, sig)).toBe(false);
    expect(verifyLink(identityPub(f.identity), 'order-forget', LINK, pointer, sig)).toBe(false);
    expect(verifyLink(identityPub(f.identity), 'move', 'f'.repeat(32), pointer, sig)).toBe(false);
    // it is the follower's key, not the master's
    expect(verifyLink(identityPub(f.masterId), 'move', LINK, pointer, sig)).toBe(false);
    // a signature made here over the same pointer verifies the same way (the check is the one the phone runs)
    expect(verifyLink(identityPub(f.identity), 'move', LINK, pointer, signLink(f.identity, 'move', LINK, pointer))).toBe(true);
  });

  it('the pointer names the master (name, boxId, keyFp, caSha256, addresses) and the phone own ticket', async () => {
    const f = await startFollower();
    const ana = (await move(f, f.ana, await challenge(f, f.ana.deviceId))).body.pointer;
    expect(ana).toEqual({
      v: 1, linkId: LINK, fromBoxId: f.boxId,
      master: { name: 'Surau Al-Hidayah', boxId: MASTER_BOX, keyFp: f.masterId.keyFp, caSha256: MASTER_CA, addresses: [MASTER_ORIGIN] },
      ticket: 'AAAA-1111', expiresAt: TICKET_END,
    });
    const budi = (await move(f, f.budi, await challenge(f, f.budi.deviceId))).body.pointer;
    expect(budi.ticket).toBe('BBBB-2222');
    expect(budi.master).toEqual(ana.master);
  });

  it('the answer holds nothing of the follower own people or its token', async () => {
    const f = await startFollower();
    const text = JSON.stringify((await move(f, f.ana, await challenge(f, f.ana.deviceId))).body);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('user-ana-0001');
    expect(text).not.toContain('device-ruang-muslimat');
  });
});

describe('phone move: a ticket with its own end', () => {
  const SHORT_END = '2026-11-22T10:30:00.000Z';
  const withEnds = (f: Follower): void => {
    createMovesStore(f.dir, f.identity, f.boxId).write({ v: 1, linkId: LINK, expiresAt: TICKET_END, entries: [{ ...f.ana.entry, expiresAt: SHORT_END }, f.budi.entry] });
  };

  it('the pointer tells the end of the phone own ticket when the entry has one, the file end when it has none', async () => {
    const f = await startFollower();
    withEnds(f);
    const ana = (await move(f, f.ana, await challenge(f, f.ana.deviceId))).body.pointer;
    expect(ana.expiresAt).toBe(SHORT_END);
    const budi = (await move(f, f.budi, await challenge(f, f.budi.deviceId))).body.pointer;
    expect(budi.expiresAt).toBe(TICKET_END);
  });

  it('404 no_ticket after the entry end although the file end is far away; the other phone still moves', async () => {
    const f = await startFollower();
    withEnds(f);
    f.clock.tick(31 * 60_000);
    const ana = await move(f, f.ana, await challenge(f, f.ana.deviceId));
    expect(ana.status).toBe(404);
    expect(ana.body.code).toBe('no_ticket');
    const budi = await move(f, f.budi, await challenge(f, f.budi.deviceId));
    expect(budi.status).toBe(200);
    expect(budi.body.pointer.expiresAt).toBe(TICKET_END);
  });

  it('a damaged entry end is ignored (the file end holds)', async () => {
    const f = await startFollower();
    createMovesStore(f.dir, f.identity, f.boxId).write({ v: 1, linkId: LINK, expiresAt: TICKET_END, entries: [{ ...f.ana.entry, expiresAt: 'not a date' }, f.budi.entry] });
    const r = await move(f, f.ana, await challenge(f, f.ana.deviceId));
    expect(r.status).toBe(200);
    expect(r.body.pointer.expiresAt).toBe(TICKET_END);
  });

  it('an entry end later than the file end is clamped to the file end', async () => {
    const f = await startFollower();
    createMovesStore(f.dir, f.identity, f.boxId).write({ v: 1, linkId: LINK, expiresAt: TICKET_END, entries: [{ ...f.ana.entry, expiresAt: '2099-01-01T00:00:00.000Z' }, f.budi.entry] });
    const r = await move(f, f.ana, await challenge(f, f.ana.deviceId));
    expect(r.status).toBe(200);
    expect(r.body.pointer.expiresAt).toBe(TICKET_END);
  });
});

describe('phone move: refusals', () => {
  it('401 bad_signature for a wrong key', async () => {
    const f = await startFollower();
    const nonce = await challenge(f, f.ana.deviceId);
    const r = await move(f, f.ana, nonce, { key: f.budi.key });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('bad_signature');
    expect(r.body.pointer).toBeUndefined();
  });

  it('401 bad_signature for a damaged or badly formed signature', async () => {
    const f = await startFollower();
    for (const sig of ['', 'x', 'A'.repeat(86), 'A'.repeat(100), 12345]) {
      const nonce = await challenge(f, f.ana.deviceId);
      const r = await post(f, MOVE, { deviceId: f.ana.deviceId, nonce, signature: sig });
      expect(r.status, String(sig)).toBe(401);
      expect(r.body.code).toBe('bad_signature');
    }
    // a signature over another box id or another nonce
    const nonce = await challenge(f, f.ana.deviceId);
    const other = await post(f, MOVE, { deviceId: f.ana.deviceId, nonce, signature: signMove(f.ana.key, 'c'.repeat(16), f.ana.deviceId, nonce) });
    expect(other.status).toBe(401);
    const nonce2 = await challenge(f, f.ana.deviceId);
    const stale = await post(f, MOVE, { deviceId: f.ana.deviceId, nonce: nonce2, signature: signMove(f.ana.key, f.boxId, f.ana.deviceId, nonce) });
    expect(stale.status).toBe(401);
  });

  it('401 bad_signature when the nonce is reused, even by the same phone with a good signature', async () => {
    const f = await startFollower();
    const nonce = await challenge(f, f.ana.deviceId);
    expect((await move(f, f.ana, nonce)).status).toBe(200);
    const again = await move(f, f.ana, nonce);
    expect(again.status).toBe(401);
    expect(again.body.code).toBe('bad_signature');
  });

  it('a nonce is spent by a failed try: the right signature right after a wrong one is refused too', async () => {
    const f = await startFollower();
    const nonce = await challenge(f, f.ana.deviceId);
    expect((await move(f, f.ana, nonce, { key: f.budi.key })).status).toBe(401);
    expect((await move(f, f.ana, nonce)).status).toBe(401);
  });

  it('401 bad_signature for a nonce that was made for another device id', async () => {
    const f = await startFollower();
    const nonceOfBudi = await challenge(f, f.budi.deviceId);
    // Ana signs the nonce Budi was given, as her own device
    const r = await move(f, f.ana, nonceOfBudi);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('bad_signature');
    // and it was spent by that try
    expect((await move(f, f.budi, nonceOfBudi)).status).toBe(401);
  });

  it('401 bad_signature for a nonce that was never given', async () => {
    const f = await startFollower();
    const r = await move(f, f.ana, 'N'.repeat(43));
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('bad_signature');
  });

  it('401 bad_signature for an expired nonce (2 minutes)', async () => {
    const f = await startFollower();
    const late = await challenge(f, f.ana.deviceId);
    f.clock.tick(2 * 60 * 1000);
    const r = await move(f, f.ana, late);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('bad_signature');

    // one second short of two minutes still works
    const fresh = await challenge(f, f.ana.deviceId);
    f.clock.tick(119 * 1000);
    expect((await move(f, f.ana, fresh)).status).toBe(200);
  });

  it('401 bad_signature for an unknown device, with a good signature by a key the follower never saw', async () => {
    const f = await startFollower();
    const stranger = phone('phone-stranger-1', 'user-x', 'CCCC-3333');
    const nonce = await challenge(f, stranger.deviceId);
    const r = await move(f, stranger, nonce);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('bad_signature');
    // the refusal is the same word as for a wrong key: it does not tell which phones this box knew
    const wrongKey = await move(f, f.ana, await challenge(f, f.ana.deviceId), { key: stranger.key });
    expect(wrongKey.body).toEqual(r.body);
  });

  it('404 no_ticket once the tickets have expired (a known device with a good signature)', async () => {
    const f = await startFollower();
    f.clock.set(new Date(TICKET_END));
    const r = await move(f, f.ana, await challenge(f, f.ana.deviceId));
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('no_ticket');
    expect(r.body.pointer).toBeUndefined();
    // an unknown device is still the same 401 as before: expiry does not reveal who was known
    const stranger = phone('phone-stranger-1', 'user-x', 'CCCC-3333');
    expect((await move(f, stranger, await challenge(f, stranger.deviceId))).status).toBe(401);
  });

  it('works up to the last second of the ticket', async () => {
    const f = await startFollower();
    f.clock.set(new Date(Date.parse(TICKET_END) - 1000));
    expect((await move(f, f.ana, await challenge(f, f.ana.deviceId))).status).toBe(200);
  });

  it('404 no_ticket when the move list is for another link', async () => {
    const f = await startFollower({ moves: false });
    createMovesStore(f.dir, f.identity, f.boxId).write({ v: 1, linkId: 'c'.repeat(32), expiresAt: TICKET_END, entries: [f.ana.entry] });
    const r = await move(f, f.ana, await challenge(f, f.ana.deviceId));
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('no_ticket');
  });

  it('a follower with no move list at all treats every phone as unknown (401, the same answer)', async () => {
    const f = await startFollower({ moves: false });
    const r = await move(f, f.ana, await challenge(f, f.ana.deviceId));
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('bad_signature');
  });
});

describe('phone move: where it is allowed', () => {
  it('403 lan_only from a public address, for the challenge and for the move', async () => {
    const f = await startFollower();
    const nonce = await challenge(f, f.ana.deviceId);
    const c = await post(f, CHALLENGE, { deviceId: f.ana.deviceId }, { from: '203.0.113.9' });
    expect(c.status).toBe(403);
    expect(c.body.code).toBe('lan_only');
    const m = await move(f, f.ana, nonce, { from: '203.0.113.9' });
    expect(m.status).toBe(403);
    expect(m.body.code).toBe('lan_only');
    // the public try did not spend the nonce
    expect((await move(f, f.ana, nonce)).status).toBe(200);
  });

  it('403 lan_only from a private address that carries a proxy header', async () => {
    const f = await startFollower();
    for (const h of ['x-forwarded-for', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'via']) {
      const c = await post(f, CHALLENGE, { deviceId: f.ana.deviceId }, { headers: { [h]: '10.168.50.77' } });
      expect(c.status, h).toBe(403);
      expect(c.body.code).toBe('lan_only');
      const m = await post(f, MOVE, { deviceId: f.ana.deviceId, nonce: 'n', signature: 's' }, { headers: { [h]: '10.168.50.77' } });
      expect(m.status, h).toBe(403);
    }
  });

  it('404 not_found on a box that is not a follower, for both routes, and nothing is made', async () => {
    const f = await startFollower({ follower: false });
    const c = await post(f, CHALLENGE, { deviceId: f.ana.deviceId });
    expect(c.status).toBe(404);
    expect(c.body.code).toBe('not_found');
    expect(c.body.nonce).toBeUndefined();
    const m = await move(f, f.ana, 'N'.repeat(43));
    expect(m.status).toBe(404);
    expect(m.body.code).toBe('not_found');
  });

  it('429 after the limit (30 tries from one address), and another address is not affected', async () => {
    const f = await startFollower();
    for (let i = 0; i < 30; i++) expect((await post(f, CHALLENGE, { deviceId: f.ana.deviceId })).status, String(i)).toBe(200);
    const over = await post(f, CHALLENGE, { deviceId: f.ana.deviceId });
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('too_many');
    // the move route shares the limit
    const m = await move(f, f.ana, 'N'.repeat(43));
    expect(m.status).toBe(429);
    const other = await post(f, CHALLENGE, { deviceId: f.ana.deviceId }, { from: '10.168.50.99' });
    expect(other.status).toBe(200);
  });

  it('a malformed device id or body is 400 bad_message and makes no nonce', async () => {
    const f = await startFollower();
    for (const body of [{}, { deviceId: 5 }, { deviceId: '' }, { deviceId: 'a b' }, { deviceId: 'x'.repeat(101) }, { deviceId: '../etc' }]) {
      const r = await post(f, CHALLENGE, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.code).toBe('bad_message');
      expect(r.body.nonce).toBeUndefined();
    }
  });
});

describe('phone move: the challenge', () => {
  it('answers the same shape for a known and an unknown device id', async () => {
    const f = await startFollower();
    const known = await post(f, CHALLENGE, { deviceId: f.ana.deviceId });
    const unknown = await post(f, CHALLENGE, { deviceId: 'phone-never-seen-9' });
    for (const r of [known, unknown]) {
      expect(r.status).toBe(200);
      expect(Object.keys(r.body).sort()).toEqual(['expiresAt', 'nonce']);
      expect(r.body.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(r.body.expiresAt).toBe(new Date(START.getTime() + 2 * 60 * 1000).toISOString());
    }
    expect(known.body.nonce).not.toBe(unknown.body.nonce);
  });

  it('every challenge is a new nonce, and a nonce of an unknown id can never verify', async () => {
    const f = await startFollower();
    const stranger = phone('phone-never-seen-9', 'user-x', 'CCCC-3333');
    const a = await challenge(f, stranger.deviceId);
    const b = await challenge(f, stranger.deviceId);
    expect(a).not.toBe(b);
    expect((await move(f, stranger, a)).status).toBe(401);
  });

  it('refuses more than 200 open nonces at once (memory is bounded)', async () => {
    const f = await startFollower();
    // the per-address limit is 30, so the open nonces are made from many addresses
    let refused = 0;
    for (let i = 0; i < 230; i++) {
      const r = await post(f, CHALLENGE, { deviceId: `phone-flood-${i}` }, { from: `10.168.${60 + Math.floor(i / 200)}.${(i % 200) + 1}` });
      if (r.status === 429) refused += 1;
    }
    expect(refused).toBeGreaterThanOrEqual(30);
    // after two minutes they are gone and a new one is given
    f.clock.tick(2 * 60 * 1000 + 1);
    expect((await post(f, CHALLENGE, { deviceId: f.ana.deviceId }, { from: '10.168.70.1' })).status).toBe(200);
  });
});
