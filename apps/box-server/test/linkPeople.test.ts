import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { sha256hex } from '../src/auth/crypto.ts';
import { normaliseCode } from '../src/auth/devices.ts';
import { createUser, deleteUserRows, tx } from '../src/auth/users.ts';
import { createMovesStore, movesFromDb } from '../src/follow/moves.ts';
import { TICKET_TTL_MS, applyMerge, keptPeople, ownPeople, undoMerge } from '../src/link/people.ts';
import type { PeerTransport } from '../src/link/session.ts';
import { signLink } from '../src/link/sign.ts';
import { loadIdentity } from '../src/setup/identity.ts';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';
import { loginAs } from './authHelpers.ts';
import { PIN, createWorld, until } from './support/twoBoxes.ts';
import type { TestBox, World } from './support/twoBoxes.ts';

/**
 * The people part of linking two boxes (phase 2C), through the real link flow of two boxes: what the follower's people
 * become on the master, the answers that may be given, the consent that covers the lists, the phone-move tickets, and
 * a failed commit that takes the merge back. Plus direct calls of `applyMerge`, `undoMerge` and `ownPeople` on one
 * database. The two-box builder is copied from `linkRoutes.test.ts` (with a data folder and a failing set-aside
 * seam), because the shared helper takes neither.
 */

// phones only from the range the existing tests use (see publicNames.test.ts)
const P1 = '+60120000001';
const P2 = '+60120000002';
const P3 = '+60120000003';
const P4 = '+60120000004';
const P5 = '+60120000005';
const NEW_PIN = '482916';

let w: World;
const dirs: string[] = [];
const extraApps: { close: () => Promise<unknown> }[] = [];
beforeEach(() => {
  w = createWorld();
});
afterEach(async () => {
  vi.useRealTimers();
  w.drop = null;
  await w.close();
  for (const a of extraApps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

type Row = Record<string, unknown>;
const rows = (b: TestBox, sql: string, ...params: string[]): Row[] => b.app.surau.db.prepare(sql).all(...params);
const outcomeOf = (b: TestBox): string | null =>
  (b.app.surau.db.prepare("SELECT outcome FROM link_sessions WHERE kind = 'link' ORDER BY started_at DESC LIMIT 1").get()?.outcome as string | null | undefined) ?? null;
const rolesOf = (b: TestBox, id: string): string[] => JSON.parse(String(b.app.surau.db.prepare('SELECT roles_json FROM users WHERE id = ?').get(id)!.roles_json)) as string[];
const userNamed = (b: TestBox, name: string): Row | undefined => b.app.surau.db.prepare('SELECT * FROM users WHERE name = ?').get(name);
const countNamed = (b: TestBox, name: string): number => rows(b, 'SELECT id FROM users WHERE name = ? AND deleted_at IS NULL', name).length;

interface BoxOptions {
  /** Keep the database and the identity in a folder (the follower's phone-move file and its identity key are read there). */
  withDir?: boolean;
  planSetAside?: (linkId: string) => void;
}

/** A set-up box like `w.make(n)` with a data folder and a set-aside seam (the follower is a set-up box). */
async function makeBox(world: World, n: number, o: BoxOptions = {}): Promise<TestBox> {
  const addr = `10.168.50.${10 + n}`;
  const origin = `https://${addr}:8443`;
  const ca = String(n % 10).repeat(64);
  const dir = o.withDir === true ? mkdtempSync(join(tmpdir(), 'surau-people-')) : null;
  if (dir !== null) dirs.push(dir);
  const box = { n, origin, ca, addr, dir, restarts: 0, admin: null } as unknown as TestBox;
  const peer: PeerTransport = {
    async post(to, toCa, path, body) {
      const call = { from: origin, to, path, body: structuredClone(body) as Record<string, unknown> };
      world.calls.push(call);
      if (world.drop?.(call) === true) throw new Error('down');
      const other = world.boxes.get(to);
      if (other === undefined || other.ca !== toCa) throw new Error('unreachable');
      const r = await other.app.inject({ method: 'POST', url: path, payload: body as object, remoteAddress: addr });
      let json: unknown = null;
      try {
        json = r.json();
      } catch {
        json = null;
      }
      return { status: r.statusCode, json };
    },
  };
  box.app = buildApp(dir === null ? ':memory:' : join(dir, 'surau.db'), {
    now: world.clock.now,
    ...(dir === null ? {} : { dataDir: dir }),
    link: {
      peer, origin, caSha256: ca, restart: () => { box.restarts += 1; },
      ...(o.planSetAside !== undefined ? { planSetAside: o.planSetAside } : { planSetAside: () => undefined }),
    },
  });
  box.tv = async () => {
    const r = await box.app.inject({ method: 'GET', url: '/api/kiosk/link', remoteAddress: '127.0.0.1' });
    return { status: r.statusCode, body: r.json() as Record<string, any> };
  };
  box.call = async (method, url, payload, x = {}) => {
    const who = x.as === undefined ? box.admin : x.as;
    const r = await box.app.inject({
      method, url, remoteAddress: x.from ?? addr,
      headers: { ...(who !== null ? who.headers : {}), ...(x.headers ?? {}) },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    let body: Record<string, any> = {};
    try {
      const j = r.json();
      body = typeof j === 'object' && j !== null ? (j as Record<string, any>) : { value: j };
    } catch {
      body = {};
    }
    return { status: r.statusCode, body };
  };
  world.boxes.set(origin, box);
  box.admin = await loginAs(box.app, 'admin');
  const lock = await box.app.inject({ method: 'PUT', url: '/api/settings/appLock', headers: box.admin.headers, payload: { enabled: true } });
  if (lock.statusCode !== 200) throw new Error(`app lock: ${lock.statusCode}`);
  return box;
}

interface Phone { id: string; jwk: { kty: string; crv: string; x: string; y: string } }
interface Made { id: string; name: string; phones: Phone[] }

const newJwk = (): Phone['jwk'] => {
  const j = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' }) as Record<string, string>;
  return { kty: j.kty!, crv: j.crv!, x: j.x!, y: j.y! };
};
let deviceSeq = 0;
const addDevice = (b: TestBox, userId: string, o: { platform?: string; keyed?: boolean; revoked?: boolean } = {}): Phone => {
  const jwk = newJwk();
  const id = `dev-${String(++deviceSeq).padStart(5, '0')}-${b.n}`;
  b.app.surau.db
    .prepare('INSERT INTO devices (surau_id, id, user_id, name, platform, public_jwk, enrolled_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(LOCAL_SURAU_ID, id, userId, `Telefon ${id}`, o.platform ?? 'web', o.keyed === false ? null : JSON.stringify(jwk), '2026-11-01T00:00:00.000Z', o.revoked === true ? '2026-11-10T00:00:00.000Z' : null);
  return { id, jwk };
};
/** A person of the box with `live` enrolled phones. */
function addPerson(b: TestBox, o: { name: string; phone?: string | null; roles: Role[]; live?: number }): Made {
  const u = createUser(b.app.surau.db, { name: o.name, roles: o.roles, phone: o.phone ?? null }, 'test', LOCAL_SURAU_ID);
  const phones: Phone[] = [];
  for (let i = 0; i < (o.live ?? 0); i++) phones.push(addDevice(b, u.id));
  return { id: u.id, name: o.name, phones };
}

interface Cast { k1: Made; k2: Made; f1: Made; f2: Made; f3: Made; f4: Made; f5: Made; extra: Made[] }
interface Pair { a: TestBox; b: TestBox; cast: Cast; bAdmin: { id: string }; bAdminName: string; aAdminName: string }

/**
 * Master `a` (the box that shows, so it keeps its data) and follower `b`.
 * a: admin, K1 Aminah (P1, ajk), K2 Rahim (no phone, media).
 * b: admin (one phone), F1 same phone as K1 with one more role, F2 Hassan (P2, two phones, plus a revoked, a kiosk and
 *    a keyless one that do not count), F3 Rahim with no phone (the same name as K2), F4 deleted, F5 inactive, and the
 *    hidden Pentadbir MAXCOM and support.
 */
async function pair(o: { followerPlanFails?: boolean; seed?: (a: TestBox, b: TestBox, cast: Cast) => void } = {}): Promise<Pair> {
  const a = await makeBox(w, 1);
  const b = await makeBox(w, 2, {
    withDir: true,
    ...(o.followerPlanFails === true ? { planSetAside: () => { throw new Error('set-aside: other_volume'); } } : {}),
  });
  const k1 = addPerson(a, { name: 'Aminah Binti Ali', phone: P1, roles: ['ajk'] });
  const k2 = addPerson(a, { name: 'Rahim Bin Ahmad', roles: ['media'] });
  const f1 = addPerson(b, { name: 'Aminah A', phone: P1, roles: ['ajk', 'treasurer'], live: 1 });
  const f2 = addPerson(b, { name: 'Hassan Bin Omar', phone: P2, roles: ['ajk'], live: 2 });
  addDevice(b, f2.id, { revoked: true });
  addDevice(b, f2.id, { platform: 'kiosk' });
  addDevice(b, f2.id, { keyed: false });
  const f3 = addPerson(b, { name: 'Rahim Bin Ahmad', roles: ['media'], live: 1 });
  const f4 = addPerson(b, { name: 'Halim Dihapus', phone: P4, roles: ['ajk'], live: 1 });
  tx(b.app.surau.db, () => deleteUserRows(b.app.surau.db, f4.id, 'test', '2026-11-20T00:00:00.000Z'));
  const f5 = addPerson(b, { name: 'Salmah Tidak Aktif', phone: P5, roles: ['ajk'], live: 1 });
  b.app.surau.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(f5.id);
  await loginAs(b.app, 'superadmin');
  await loginAs(b.app, 'support');
  const cast: Cast = { k1, k2, f1, f2, f3, f4, f5, extra: [] };
  o.seed?.(a, b, cast);
  const nameOf = (x: TestBox, id: string): string => String(x.app.surau.db.prepare('SELECT name FROM users WHERE id = ?').get(id)!.name);
  return { a, b, cast, bAdmin: { id: b.admin!.userId }, bAdminName: nameOf(b, b.admin!.userId), aAdminName: nameOf(a, a.admin!.userId) };
}

/**
 * `a` shows, `b` scans, `a` approves, then `a` sets the answers: keep and master are the box that shows. The default
 * master is the box with more free disk, which here is the follower (it has a data folder), so the answers are always
 * set; the revision they make is in `session.answers.rev`.
 */
async function toQuestions(a: TestBox, b: TestBox, o: { roles?: Record<string, string>; same?: string[]; phones?: 'direct' | 'code' } = {}): Promise<{ linkId: string; session: Record<string, any> }> {
  expect((await a.call('POST', '/api/link/show', { pin: PIN })).status).toBe(200);
  const qr = String((await a.tv()).body.qr.payload);
  expect((await b.call('POST', '/api/link/scan', { pin: PIN, qr })).status).toBe(200);
  const ap = await a.call('POST', '/api/link/approve', { ok: true });
  expect(ap.status).toBe(200);
  expect(ap.body.session.step).toBe('questions');
  const put = await a.call('PUT', '/api/link/answers', answerBody(o));
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  return { linkId: String(ap.body.session.id), session: put.body.session as Record<string, any> };
}
const agreeBoth = async (a: TestBox, b: TestBox, rev: number): Promise<void> => {
  expect((await a.call('POST', '/api/link/agree', { rev })).status).toBe(200);
  expect((await b.call('POST', '/api/link/agree', { rev })).status).toBe(200);
};
const answerBody = (o: { roles?: Record<string, string>; same?: string[]; phones?: 'direct' | 'code' } = {}) => ({ keep: 'show', master: 'show', roles: o.roles ?? {}, same: o.same ?? [], phones: o.phones ?? 'code', financeTick: false });

/** The whole flow to the end, with optional answers. */
async function link(p: Pair, o: { roles?: Record<string, string>; same?: string[]; phones?: 'direct' | 'code' } = {}): Promise<string> {
  const { linkId, session } = await toQuestions(p.a, p.b, o);
  await agreeBoth(p.a, p.b, session.answers.rev);
  await until(() => {
    expect(outcomeOf(p.a)).toBe('linked');
    expect(outcomeOf(p.b)).toBe('linked');
  });
  await p.a.app.link!.work.idle();
  return linkId;
}

const movesOf = (b: TestBox) => createMovesStore(b.dir, loadIdentity(b.dir!), b.app.surau.boxId).read();

describe('the follower people on the master (case S, no answers)', () => {
  it('creates the follower people with the master numbers, no PIN and no phone; one row each in link_people', async () => {
    const p = await pair();
    const linkId = await link(p);
    const { a, b, cast } = p;

    for (const [made, phone, roles] of [[cast.f2, P2, ['ajk']], [cast.f3, null, ['media']]] as const) {
      // F3 has the name of a kept person but no phone: with no answer it is added as another person
      const mine = rows(a, 'SELECT * FROM users WHERE name = ? ORDER BY created_at', made.name).filter((r) => r.created_by === `user:${a.admin!.userId}`);
      expect(mine, made.name).toHaveLength(1);
      const u = mine[0]!;
      expect(u.phone ?? null).toBe(phone);
      expect(JSON.parse(String(u.roles_json))).toEqual(roles);
      expect(u.active).toBe(1);
      expect(u.pin_hash ?? null).toBeNull();
      expect(rows(a, 'SELECT id FROM devices WHERE user_id = ?', String(u.id))).toHaveLength(0);
      expect(u.id).not.toBe(made.id);
      expect(Number.isInteger(u.no)).toBe(true);
    }

    // seen through the admin list: a number (ref) and a PIN still to be made
    const list = (await a.call('GET', '/api/users')).body.users as Record<string, any>[];
    const hassan = list.find((u) => u.name === 'Hassan Bin Omar')!;
    expect(hassan.ref).toEqual(expect.anything());
    expect(hassan.pinRequired).toBe(true);
    expect(hassan.phone).toBe(P2);

    // the follower admin comes as an administrator of the master too (an explicit part of the merge)
    expect(rows(a, 'SELECT roles_json FROM users WHERE name = ?', p.bAdminName).map((r) => JSON.parse(String(r.roles_json)))).toEqual([['admin']]);

    const lp = rows(a, 'SELECT * FROM link_people WHERE link_id = ? ORDER BY peer_user_id', linkId);
    expect(lp.map((r) => [r.peer_user_id, r.action]).sort()).toEqual(
      [[p.bAdmin.id, 'created'], [cast.f1.id, 'same'], [cast.f2.id, 'created'], [cast.f3.id, 'created']].sort(),
    );
    for (const r of lp) expect(r.from_box_id).toBe(b.app.surau.boxId);
  });

  it('does not copy the hidden Pentadbir MAXCOM or support, nor a deleted or an inactive person', async () => {
    const p = await pair();
    await link(p);
    const sent = JSON.parse(String(rows(p.a, 'SELECT peer_people_json FROM link_sessions')[0]!.peer_people_json)) as { name: string; roles: string[] }[];
    const names = sent.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(['Aminah A', 'Hassan Bin Omar', 'Rahim Bin Ahmad', p.bAdminName]));
    expect(names.some((n) => n.startsWith('Test superadmin') || n.startsWith('Test support'))).toBe(false);
    expect(names).not.toContain('Halim Dihapus');
    expect(names).not.toContain('Salmah Tidak Aktif');
    for (const x of sent) expect(x.roles.some((r) => r === 'superadmin' || r === 'support')).toBe(false);

    for (const n of ['Halim Dihapus', 'Salmah Tidak Aktif']) expect(rows(p.a, 'SELECT id FROM users WHERE name = ?', n), n).toHaveLength(0);
    expect(rows(p.a, "SELECT id FROM users WHERE name LIKE 'Test superadmin%' OR name LIKE 'Test support%'")).toHaveLength(0);
    expect(rows(p.a, "SELECT id FROM users WHERE roles_json LIKE '%superadmin%' OR roles_json LIKE '%support%'")).toHaveLength(0);
    expect(rows(p.a, 'SELECT phone FROM users WHERE phone IN (?, ?)', P4, P5)).toHaveLength(0);
  });

  it('a duplicate by phone is one person: the kept name and roles stay, no second account', async () => {
    const p = await pair();
    await link(p);
    expect(rows(p.a, 'SELECT * FROM users WHERE phone = ?', P1)).toHaveLength(1);
    expect(countNamed(p.a, 'Aminah A')).toBe(0);
    expect(countNamed(p.a, 'Aminah Binti Ali')).toBe(1);
    // roles the other box gave are not taken without an answer
    expect(rolesOf(p.a, p.cast.k1.id)).toEqual(['ajk']);
  });

  it('the master keeps its own administrator and nobody is deactivated', async () => {
    const p = await pair();
    await link(p);
    expect(rolesOf(p.a, p.a.admin!.userId)).toEqual(['admin']);
    expect(rows(p.a, 'SELECT id FROM users WHERE active = 0 OR deleted_at IS NOT NULL')).toHaveLength(0);
  });

  it('the preview before the agreement has the right numbers and no full phone number outside roleDiffs', async () => {
    const p = await pair();
    const { session } = await toQuestions(p.a, p.b);
    const v = session.people as Record<string, any>;
    expect(v.add.map((x: any) => x.name).sort()).toEqual([p.bAdminName, 'Hassan Bin Omar', 'Rahim Bin Ahmad'].sort());
    expect(v.same.map((x: any) => x.keptName)).toEqual(['Aminah Binti Ali']);
    expect(v.roleDiffs).toHaveLength(1);
    expect(v.roleDiffs[0]).toMatchObject({ phone4: P1.slice(-4), chosen: null, keptRoles: ['ajk'] });
    expect([...v.roleDiffs[0].otherRoles].sort()).toEqual(['ajk', 'treasurer']);
    expect(v.nameAsk).toEqual([expect.objectContaining({ id: p.cast.f3.id, keptName: 'Rahim Bin Ahmad', same: false })]);
    expect(v.adminsAfter).toEqual([p.aAdminName, p.bAdminName].sort());
    // F1 (same phone, non-admin), F2 and F3 each have a phone to move; the follower admin does not
    expect(v.tickets).toBe(3);
    const stripped = JSON.stringify({ ...v, roleDiffs: v.roleDiffs.map((d: any) => ({ ...d, phone: '' })) });
    for (const ph of [P1, P2, P3, P4, P5]) expect(stripped).not.toContain(ph);
    // both boxes show the same preview
    const other = (await p.b.call('GET', '/api/link/status')).body.session.people;
    expect(other.roleDiffs).toBeTruthy();
  });
});

describe('role answers', () => {
  it('an answer agreed by both admins adds that one role to the kept person, logged in change_log and auth_log', async () => {
    const p = await pair();
    const linkId = await link(p, { roles: { [P1]: 'treasurer' } });
    expect(rolesOf(p.a, p.cast.k1.id)).toEqual(['ajk', 'treasurer']);

    const lp = rows(p.a, "SELECT * FROM link_people WHERE link_id = ? AND action = 'role'", linkId);
    expect(lp).toHaveLength(1);
    expect(JSON.parse(String(lp[0]!.roles_before_json))).toEqual(['ajk']);

    const changes = rows(p.a, "SELECT * FROM change_log WHERE entity = 'users' AND entity_id = ? AND actor = ?", p.cast.k1.id, `user:${p.a.admin!.userId}`);
    expect(changes.some((c) => String(c.after_json).includes('treasurer') && !String(c.before_json).includes('treasurer'))).toBe(true);

    const logs = rows(p.a, "SELECT * FROM auth_log WHERE event = 'link-merge' AND user_id = ?", p.cast.k1.id);
    expect(logs).toHaveLength(1);
    expect(String(logs[0]!.detail)).toBe(`role treasurer ${linkId.slice(0, 8)}`);
    expect(logs[0]!.ok).toBe(1);
    // the created people are in the auth log too
    expect(rows(p.a, "SELECT id FROM auth_log WHERE event = 'link-merge' AND detail LIKE 'created %'")).toHaveLength(3);
  });

  it('an answer for a role the kept person would get is not given to anybody else', async () => {
    const p = await pair();
    await link(p, { roles: { [P1]: 'treasurer' } });
    expect(rolesOf(p.a, p.a.admin!.userId)).toEqual(['admin']);
    const hassan = rows(p.a, 'SELECT roles_json FROM users WHERE name = ?', 'Hassan Bin Omar');
    expect(JSON.parse(String(hassan[0]!.roles_json))).toEqual(['ajk']);
  });

  it('PUT /api/link/answers refuses a role key that is not a real difference with 409 people_answer, and changes nothing', async () => {
    const p = await pair();
    const { session } = await toQuestions(p.a, p.b);
    const before = session.answers;
    const bad: { roles?: Record<string, string>; same?: string[] }[] = [
      { roles: { [P2]: 'ajk' } }, // not a duplicate
      { roles: { [P3]: 'admin' } }, // nobody has this phone
      { roles: { [P1]: 'media' } }, // the other box does not give this role
      { roles: { [P1]: 'ajk' } }, // the kept person already holds it
      { roles: { [P1]: 'superadmin' } },
      { roles: { [P1]: 'support' } },
      { same: [p.cast.f1.id] }, // not a name question
      { same: [p.cast.f3.id, p.cast.f3.id] }, // repeated
      { same: ['00000000-0000-4000-8000-000000000000'] }, // nobody
    ];
    for (const b of bad) {
      const r = await p.a.call('PUT', '/api/link/answers', answerBody(b));
      expect(r.status, JSON.stringify(b)).toBe(409);
      expect(r.body.code, JSON.stringify(b)).toBe('people_answer');
    }
    const short = await p.a.call('PUT', '/api/link/answers', answerBody({ same: ['x'] }));
    expect(short.status).toBe(400);
    expect((await p.a.call('GET', '/api/link/status')).body.session.answers).toEqual(before);
    expect((await p.b.call('GET', '/api/link/status')).body.session.answers).toEqual(before);
  });

  it('a signed answers message from the other box with a role key that is not a difference is refused', async () => {
    const p = await pair();
    const { linkId, session } = await toQuestions(p.a, p.b);
    const identity = loadIdentity(p.b.dir!);
    const forged = [
      { ...session.answers, rev: session.answers.rev + 1, roles: { [P2]: 'admin' } },
      { ...session.answers, rev: session.answers.rev + 1, roles: { [P1]: 'media' } },
      { ...session.answers, rev: session.answers.rev + 1, same: [p.cast.f1.id] },
    ];
    for (const answers of forged) {
      const body = { answers };
      const r = await p.a.call('POST', '/api/link/peer/message', { linkId, step: 'answers', body, sig: signLink(identity, 'answers', linkId, body) }, { as: null, from: p.b.addr });
      expect(r.status, JSON.stringify(answers)).toBe(400);
      expect(r.body.code).toBe('bad_message');
    }
    expect((await p.a.call('GET', '/api/link/status')).body.session.answers).toEqual(session.answers);

    // the same message with a real difference is taken: the refusal above is about the content, not the channel
    const good = { answers: { ...session.answers, rev: session.answers.rev + 1, roles: { [P1]: 'treasurer' } } };
    const ok = await p.a.call('POST', '/api/link/peer/message', { linkId, step: 'answers', body: good, sig: signLink(identity, 'answers', linkId, good) }, { as: null, from: p.b.addr });
    expect(ok.status).toBe(200);
    expect((await p.a.call('GET', '/api/link/status')).body.session.answers.roles).toEqual({ [P1]: 'treasurer' });
  });

  it('the same message signed with another key is refused', async () => {
    const p = await pair();
    const { linkId, session } = await toQuestions(p.a, p.b);
    const body = { answers: { ...session.answers, rev: session.answers.rev + 1, roles: { [P1]: 'treasurer' } } };
    const other = loadIdentity(p.a.dir ?? mkdtempFor());
    const r = await p.a.call('POST', '/api/link/peer/message', { linkId, step: 'answers', body, sig: signLink(other, 'answers', linkId, body) }, { as: null, from: p.b.addr });
    expect(r.status).toBe(403);
    expect((await p.a.call('GET', '/api/link/status')).body.session.answers).toEqual(session.answers);
  });

  it('a name question answered "same" makes no new person and no ticket for that person', async () => {
    const p = await pair();
    const linkId = await link(p, { same: [p.cast.f3.id] });
    expect(countNamed(p.a, 'Rahim Bin Ahmad')).toBe(1);
    expect(rows(p.a, "SELECT * FROM link_people WHERE link_id = ? AND peer_user_id = ?", linkId, p.cast.f3.id).map((r) => [r.action, r.user_id])).toEqual([['same', p.cast.k2.id]]);
    expect(rolesOf(p.a, p.cast.k2.id)).toEqual(['media']);
    expect(rows(p.a, 'SELECT * FROM enrolments WHERE user_id = ?', p.cast.k2.id)).toHaveLength(0);
  });
});

/** A throw-away folder for a second identity. */
function mkdtempFor(): string {
  const d = mkdtempSync(join(tmpdir(), 'surau-people-key-'));
  dirs.push(d);
  return d;
}

describe('the consent covers the people', () => {
  const swap = (b: TestBox, column: 'own_people_json' | 'peer_people_json', f: (list: any[]) => any[]): void => {
    const cur = JSON.parse(String(b.app.surau.db.prepare(`SELECT ${column} AS x FROM link_sessions`).get()!.x)) as any[];
    b.app.surau.db.prepare(`UPDATE link_sessions SET ${column} = ?`).run(JSON.stringify(f(cur)));
  };
  const extra = { id: 'person-extra-0001', name: 'Orang Tambahan', phone: P3, roles: ['admin'], devices: 0 };

  it('a peer list changed after the questions step: this box cannot agree (hash mismatch) and the link never completes', async () => {
    const p = await pair();
    const { session } = await toQuestions(p.a, p.b);
    const rev: number = session.answers.rev;
    // the other box agrees first, so its consent is on the way to the box whose list was changed
    expect((await p.b.call('POST', '/api/link/agree', { rev })).status).toBe(200);
    swap(p.a, 'peer_people_json', (l) => [...l, extra]);
    const r = await p.a.call('POST', '/api/link/agree', { rev });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('bad_message');
    await p.a.app.link!.work.idle();
    expect(outcomeOf(p.a)).toBeNull();
    expect(outcomeOf(p.b)).toBeNull();
    expect(rows(p.a, 'SELECT * FROM link_people')).toHaveLength(0);
    expect(rows(p.a, "SELECT id FROM users WHERE name = 'Orang Tambahan'")).toHaveLength(0);
  });

  it('an own list changed after the questions step is refused the same way', async () => {
    const p = await pair();
    const { session } = await toQuestions(p.a, p.b);
    const rev: number = session.answers.rev;
    swap(p.b, 'own_people_json', (l) => l.slice(1));
    const r = await p.b.call('POST', '/api/link/agree', { rev });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('bad_message');
  });

  it('a list changed AND the answers stored again: the two boxes hold different hashes, so neither consent is taken', async () => {
    const p = await pair();
    const { session } = await toQuestions(p.a, p.b);
    const rev: number = session.answers.rev;
    swap(p.a, 'peer_people_json', (l) => [...l, extra]);
    // a new revision recomputes the hash from the changed list at this box only
    const put = await p.a.call('PUT', '/api/link/answers', answerBody());
    expect(put.status).toBe(200);
    const rev2 = put.body.session.answers.rev;
    const mine = await p.a.call('POST', '/api/link/agree', { rev: rev2 });
    expect(mine.status).toBe(409);
    const theirs = await p.b.call('POST', '/api/link/agree', { rev: rev2 });
    expect(theirs.status).toBe(409);
    await p.a.app.link!.work.idle();
    expect(outcomeOf(p.a)).toBeNull();
    expect(rows(p.a, 'SELECT * FROM link_people')).toHaveLength(0);
    expect(rows(p.b, 'SELECT * FROM linked_boxes')).toHaveLength(0);
    expect(p.b.app.link!.follow.present()).toBe(false);
  });

  it('an answer change clears both agreements: the new revision is agreed again on both boxes', async () => {
    const p = await pair();
    const { session } = await toQuestions(p.a, p.b);
    const rev: number = session.answers.rev;
    expect((await p.b.call('POST', '/api/link/agree', { rev })).status).toBe(200);
    const put = await p.a.call('PUT', '/api/link/answers', answerBody({ roles: { [P1]: 'treasurer' } }));
    expect(put.body.session.answers.rev).toBe(rev + 1);
    expect(put.body.session.peerAgreed).toBe(false);
    expect((await p.b.call('POST', '/api/link/agree', { rev })).body.code).toBe('stale_revision');
    await agreeBoth(p.a, p.b, rev + 1);
    await until(() => expect(outcomeOf(p.a)).toBe('linked'));
  });
});

describe('phone-move tickets', () => {
  it('one enrolment per non-admin merged person with a phone: created_by link, 30 days, only a hash stored', async () => {
    const p = await pair();
    const linkId = await link(p);
    const tickets = rows(p.a, 'SELECT * FROM enrolments WHERE created_by = ?', `link:${linkId}`);
    expect(tickets).toHaveLength(3);

    const aUsers = (name: string): string => String(userNamed(p.a, name)!.id);
    const owners = tickets.map((t) => String(t.user_id)).sort();
    expect(owners).toEqual([p.cast.k1.id, aUsers('Hassan Bin Omar'), rows(p.a, "SELECT id FROM users WHERE name = 'Rahim Bin Ahmad' AND created_by LIKE 'user:%'")[0]!.id as string].sort());
    const expected = new Date(w.clock.now().getTime() + TICKET_TTL_MS).toISOString();
    expect(expected).toBe('2026-12-22T10:00:00.000Z');
    for (const t of tickets) {
      expect(t.expires_at).toBe(expected);
      expect(t.used_at ?? null).toBeNull();
      expect(String(t.code_hash)).toMatch(/^[0-9a-f]{64}$/);
      expect(String(t.device_name)).toMatch(/^Telefon dari /);
    }
    // the follower admin is a Pentadbir at the master after the merge: no ticket
    expect(rows(p.a, 'SELECT * FROM enrolments WHERE user_id = ?', aUsers(p.bAdminName))).toHaveLength(0);

    // the plain code is on the follower only; the master has the hash and nothing else of it
    const moves = movesOf(p.b)!;
    expect(moves).not.toBeNull();
    for (const e of moves.entries) {
      const hash = sha256hex(normaliseCode(e.ticket));
      expect(tickets.some((t) => t.code_hash === hash), e.deviceId).toBe(true);
      expect(JSON.stringify(rows(p.a, 'SELECT * FROM enrolments'))).not.toContain(e.ticket);
    }
  });

  it('with the choice "direct" the follower admin gets a ticket too, with the same 30 days', async () => {
    const p = await pair();
    const linkId = await link(p, { phones: 'direct' });
    const tickets = rows(p.a, 'SELECT * FROM enrolments WHERE created_by = ?', `link:${linkId}`);
    expect(tickets).toHaveLength(4);
    const adminId = String(userNamed(p.a, p.bAdminName)!.id);
    const mine = tickets.filter((t) => t.user_id === adminId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.expires_at).toBe(new Date(w.clock.now().getTime() + TICKET_TTL_MS).toISOString());
    expect(movesOf(p.b)!.entries).toHaveLength(5); // one per phone: Hassan has two
  });

  it('with the choice "code" the follower admin gets no ticket (an older app that sends no choice means the same)', async () => {
    const p = await pair();
    const linkId = await link(p, { phones: 'code' });
    expect(rows(p.a, 'SELECT * FROM enrolments WHERE created_by = ?', `link:${linkId}`)).toHaveLength(3);
    expect(rows(p.a, 'SELECT * FROM enrolments WHERE user_id = ?', String(userNamed(p.a, p.bAdminName)!.id))).toHaveLength(0);
  });

  it('none for a person who is Pentadbir after the merge, whether the role came from the kept side or from an answer', async () => {
    const p = await pair({
      seed: (a, b) => {
        // kept side admin, other side plain
        addPerson(a, { name: 'Salleh Bin Din', phone: P3, roles: ['admin'] });
        addPerson(b, { name: 'Salleh Lain', phone: P3, roles: ['ajk'], live: 1 });
        // admin only by the answer
        addPerson(a, { name: 'Mariam Binti Said', phone: P4, roles: ['ajk'] });
        addPerson(b, { name: 'Mariam M', phone: P4, roles: ['ajk', 'admin'], live: 1 });
      },
    });
    const linkId = await link(p, { roles: { [P4]: 'admin' } });
    const idOf = (name: string): string => String(userNamed(p.a, name)!.id);
    expect(rolesOf(p.a, idOf('Mariam Binti Said'))).toEqual(['ajk', 'admin']);
    expect(rolesOf(p.a, idOf('Salleh Bin Din'))).toEqual(['admin']);
    expect(rows(p.a, 'SELECT * FROM enrolments WHERE user_id IN (?, ?)', idOf('Salleh Bin Din'), idOf('Mariam Binti Said'))).toHaveLength(0);
    // the other three still have one
    expect(rows(p.a, 'SELECT * FROM enrolments WHERE created_by = ?', `link:${linkId}`)).toHaveLength(3);
  });

  it('a ticket enrols a new device at the master once; a second use fails', async () => {
    const p = await pair();
    await link(p);
    const entry = movesOf(p.b)!.entries.find((e) => e.deviceId === p.cast.f2.phones[0]!.id)!;
    expect(entry).toBeDefined();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(w.clock.now());
    const jwk = newJwk();
    const enrol = (code: string, from: string) => p.a.app.inject({ method: 'POST', url: '/api/enrol/complete', remoteAddress: from, payload: { code, publicJwk: jwk, platform: 'web', pin: NEW_PIN } });
    const first = await enrol(entry.ticket, '10.9.9.1');
    expect(first.statusCode, first.body).toBe(200);
    const userId = String(userNamed(p.a, 'Hassan Bin Omar')!.id);
    expect(rows(p.a, "SELECT * FROM devices WHERE user_id = ? AND platform = 'web' AND revoked_at IS NULL", userId)).toHaveLength(1);
    expect(rows(p.a, 'SELECT used_at FROM enrolments WHERE user_id = ?', userId)[0]!.used_at).not.toBeNull();
    const second = await enrol(entry.ticket, '10.9.9.2');
    expect(second.statusCode).toBe(401);
    expect(second.json().code ?? second.json().errors?.[0]).toBeTruthy();
    expect(rows(p.a, "SELECT * FROM devices WHERE user_id = ? AND platform = 'web' AND revoked_at IS NULL", userId)).toHaveLength(1);
  });

  it('a ticket does not work after 30 days (the clock moved)', async () => {
    const p = await pair();
    await link(p);
    const entry = movesOf(p.b)!.entries.find((e) => e.deviceId === p.cast.f3.phones[0]!.id)!;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(w.clock.now().getTime() + TICKET_TTL_MS + 1000));
    const r = await p.a.app.inject({ method: 'POST', url: '/api/enrol/complete', remoteAddress: '10.9.9.3', payload: { code: entry.ticket, publicJwk: newJwk(), platform: 'web', pin: NEW_PIN } });
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe('enrol_code_expired');
    const userId = String(rows(p.a, "SELECT id FROM users WHERE name = 'Rahim Bin Ahmad' AND created_by LIKE 'user:%'")[0]!.id);
    expect(rows(p.a, "SELECT * FROM devices WHERE user_id = ? AND platform = 'web'", userId)).toHaveLength(0);
  });

  it('the follower keeps secret/follow-moves.json only for live, keyed, non-kiosk phones of ticketed people', async () => {
    const p = await pair();
    await link(p);
    const moves = movesOf(p.b)!;
    expect(moves.v).toBe(1);
    expect(moves.linkId).toBe(p.b.app.link!.follow.read()!.linkId);
    expect(moves.expiresAt).toBe('2026-12-22T10:00:00.000Z');
    const ids = moves.entries.map((e) => e.deviceId).sort();
    // F1 one phone, F2 two live phones (not its revoked, kiosk and keyless ones), F3 one phone;
    // not the follower admin, not the inactive person
    expect(ids).toEqual([p.cast.f1.phones[0]!.id, ...p.cast.f2.phones.map((x) => x.id), p.cast.f3.phones[0]!.id].sort());
    expect(moves.entries.every((e) => typeof e.ticket === 'string' && e.ticket.length > 0)).toBe(true);
    expect(moves.entries.find((e) => e.deviceId === p.cast.f1.phones[0]!.id)!.userId).toBe(p.cast.f1.id);
    expect(moves.entries.find((e) => e.deviceId === p.cast.f1.phones[0]!.id)!.jwk).toMatchObject({ x: p.cast.f1.phones[0]!.jwk.x });
    // the same person's phones share one ticket
    const f2t = moves.entries.filter((e) => p.cast.f2.phones.some((x) => x.id === e.deviceId)).map((e) => e.ticket);
    expect(new Set(f2t).size).toBe(1);
    // sealed on disk: the plain ticket is not in the file
    const raw = readFileSync(join(p.b.dir!, 'secret', 'follow-moves.json'), 'utf8');
    expect(raw).not.toContain(f2t[0]!);
  });

  it('a follower with no phone to move writes no moves file', async () => {
    const a = await makeBox(w, 1);
    const b = await makeBox(w, 2, { withDir: true });
    addPerson(a, { name: 'Aminah Binti Ali', phone: P1, roles: ['ajk'] });
    // the only people of b: its admin (a Pentadbir at the master) and one with no phone enrolled
    addPerson(b, { name: 'Hassan Bin Omar', phone: P2, roles: ['ajk'], live: 0 });
    await link({ a, b } as Pair);
    expect(movesOf(b)).toBeNull();
    expect(rows(a, "SELECT * FROM enrolments WHERE created_by LIKE 'link:%'")).toHaveLength(0);
  });
});

describe('a failed commit takes the merge back', () => {
  const nothingLeft = (p: Pair, linkId: string): void => {
    // no created person is left alive (they are soft-deleted)
    const mine = rows(p.a, "SELECT * FROM users WHERE created_by = ?", `user:${p.a.admin!.userId}`);
    expect(mine.length).toBeGreaterThan(0);
    for (const u of mine) {
      expect(u.deleted_at, String(u.name)).not.toBeNull();
      expect(u.active).toBe(0);
    }
    expect(countNamed(p.a, 'Hassan Bin Omar')).toBe(0);
    expect(countNamed(p.a, p.bAdminName)).toBe(0);
    // roles put back, the kept people as they were
    expect(rolesOf(p.a, p.cast.k1.id)).toEqual(['ajk']);
    expect(rows(p.a, 'SELECT id FROM users WHERE id = ? AND active = 1 AND deleted_at IS NULL', p.cast.k1.id)).toHaveLength(1);
    expect(rows(p.a, 'SELECT id FROM users WHERE id = ? AND active = 1 AND deleted_at IS NULL', p.cast.k2.id)).toHaveLength(1);
    // no ticket and no link_people row
    // no usable ticket (a ticket row that is burned is checked in its own test below)
    expect(rows(p.a, 'SELECT * FROM enrolments WHERE created_by = ? AND used_at IS NULL', `link:${linkId}`)).toHaveLength(0);
    expect(rows(p.a, 'SELECT * FROM link_people')).toHaveLength(0);
    expect(rows(p.a, 'SELECT * FROM linked_boxes')).toHaveLength(0);
    expect(rows(p.a, "SELECT * FROM devices WHERE platform = 'kiosk' AND revoked_at IS NULL")).toHaveLength(0);
  };

  it('the follower never answers the commit: the master has no created people, roles back, no ticket, no link_people', async () => {
    const p = await pair();
    w.drop = (c) => c.body.step === 'commit';
    const { linkId } = await toQuestions(p.a, p.b);
    const put = await p.a.call('PUT', '/api/link/answers', answerBody({ roles: { [P1]: 'treasurer' } }));
    expect(put.status).toBe(200);
    await agreeBoth(p.a, p.b, put.body.session.answers.rev);
    await p.a.app.link!.work.idle();
    await until(() => expect(outcomeOf(p.a)).toBe('failed'));
    nothingLeft(p, linkId);
    expect(p.b.app.link!.follow.present()).toBe(false);
    expect(movesOf(p.b)).toBeNull();
  });

  it('the follower refuses the commit: the same, and the master is free again', async () => {
    const p = await pair({ followerPlanFails: true });
    const { linkId } = await toQuestions(p.a, p.b);
    const put = await p.a.call('PUT', '/api/link/answers', answerBody({ roles: { [P1]: 'treasurer' } }));
    await agreeBoth(p.a, p.b, put.body.session.answers.rev);
    await p.a.app.link!.work.idle();
    await until(() => expect(outcomeOf(p.a)).toBe('failed'));
    nothingLeft(p, linkId);
    expect(p.a.app.link!.sessions.writesBlocked()).toBe(false);
    expect(p.b.app.link!.follow.present()).toBe(false);
    // the people the failed link made are not people of the surau any more: a later link makes them again, not twice
    expect((await p.a.call('GET', '/api/users')).body.users.filter((u: any) => u.name === 'Hassan Bin Omar')).toHaveLength(0);
  });

  // Regression test (bug found by this test, fixed in undoMerge): `undoMerge` (apps/box-server/src/link/people.ts:113-125) soft-deletes the created
  // people FIRST; `deactivateUserRows` (apps/box-server/src/auth/users.ts:660) then sets `used_at` on their pending
  // enrolments, so the later `DELETE FROM enrolments ... AND used_at IS NULL` (people.ts:123) skips exactly the tickets of
  // the created people. The rows stay, burned (not usable), but "no link tickets left" is not true.
  it('a failed commit leaves no link ticket row at all', async () => {
    const p = await pair();
    w.drop = (c) => c.body.step === 'commit';
    const { session } = await toQuestions(p.a, p.b);
    await agreeBoth(p.a, p.b, session.answers.rev);
    await p.a.app.link!.work.idle();
    await until(() => expect(outcomeOf(p.a)).toBe('failed'));
    expect(rows(p.a, "SELECT * FROM enrolments WHERE created_by LIKE 'link:%'")).toHaveLength(0);
  });

  // Regression test (bug found by this test, fixed in onCommit with dropMoves): `onCommit` (apps/box-server/src/link/work.ts:222) writes `secret/follow-moves.json` BEFORE the
  // set-aside plan (work.ts:223-226) and nothing removes it when the plan throws and the commit is refused (work.ts:228-229).
  // The box is not a follower, yet it keeps a sealed file with plain tickets the master has already taken back.
  it('a refused commit leaves no phone-move file on the follower', async () => {
    const p = await pair({ followerPlanFails: true });
    const { session } = await toQuestions(p.a, p.b);
    await agreeBoth(p.a, p.b, session.answers.rev);
    await p.a.app.link!.work.idle();
    await until(() => expect(outcomeOf(p.a)).toBe('failed'));
    expect(p.b.app.link!.follow.present()).toBe(false);
    // onCommit writes the phone-move file BEFORE the set-aside plan; when the plan throws the file stays
    expect(movesOf(p.b)).toBeNull();
  });
});

describe('applyMerge and undoMerge on one database', () => {
  const surau = LOCAL_SURAU_ID;
  const now = new Date('2026-11-22T10:00:00.000Z');
  const input = (other: any[], answers: { roles: Record<string, string>; same: string[] } = { roles: {}, same: [] }) => ({
    linkId: 'l'.repeat(32), surauId: surau, fromBoxId: 'f'.repeat(16), fromName: 'Ruang Muslimat', other, answers, owner: 'owner-1', now,
  });
  const lp = (id: string, o: Record<string, unknown> = {}) => ({ id, name: 'Orang Baru', phone: null, roles: ['ajk'], devices: 0, ...o });

  it('creates, adds a role, marks "same", hands out tickets to non-admins with a phone and undoes all of it', async () => {
    const app = buildApp(':memory:', { now: () => now });
    extraApps.push(app);
    const admin = await loginAs(app, 'admin');
    const db = app.surau.db;
    const k = createUser(db, { name: 'Aminah Binti Ali', roles: ['ajk'], phone: P1 }, 'test', surau);
    const k2 = createUser(db, { name: 'Rahim Bin Ahmad', roles: ['media'] }, 'test', surau);
    const other = [
      lp('person-0001', { name: 'Aminah A', phone: P1, roles: ['ajk', 'treasurer'], devices: 1 }),
      lp('person-0002', { name: 'Hassan Bin Omar', phone: P2, devices: 2 }),
      lp('person-0003', { name: 'Rahim Bin Ahmad', roles: ['media'], devices: 1 }),
      lp('person-0004', { name: 'Salleh', roles: ['admin'], devices: 1 }),
    ];
    const res = tx(db, () => applyMerge(db, input(other, { roles: { [P1]: 'treasurer' }, same: ['person-0003'] })));

    // a ticket for the same-phone person and the created non-admin with phones; none for "same by name" or the admin
    expect(Object.keys(res.tickets).sort()).toEqual(['person-0001', 'person-0002']);
    expect(res.ticketsExpireAt).toBe(new Date(now.getTime() + TICKET_TTL_MS).toISOString());
    expect(rolesOfDb(db, k.id)).toEqual(['ajk', 'treasurer']);
    expect(rolesOfDb(db, k2.id)).toEqual(['media']);
    const created = db.prepare("SELECT * FROM users WHERE created_by = 'user:owner-1' AND deleted_at IS NULL ORDER BY name").all();
    expect(created.map((u) => u.name)).toEqual(['Hassan Bin Omar', 'Salleh']);
    expect(db.prepare('SELECT action FROM link_people ORDER BY peer_user_id').all().map((r) => r.action)).toEqual(['role', 'created', 'same', 'created']);
    const enrol = db.prepare("SELECT * FROM enrolments WHERE created_by LIKE 'link:%'").all();
    expect(enrol).toHaveLength(2);
    for (const e of enrol) {
      expect(e.created_by).toBe(`link:${'l'.repeat(32)}`);
      expect(String(e.device_name)).toBe('Telefon dari Ruang Muslimat');
    }
    // ticket code hashes match the plain codes handed out
    const hashes = Object.values(res.tickets).map((c) => sha256hex(normaliseCode(c))).sort();
    expect(enrol.map((e) => String(e.code_hash)).sort()).toEqual(hashes);

    tx(db, () => undoMerge(db, 'l'.repeat(32), 'system:link', now));
    expect(rolesOfDb(db, k.id)).toEqual(['ajk']);
    expect(db.prepare("SELECT * FROM users WHERE created_by = 'user:owner-1' AND deleted_at IS NULL").all()).toHaveLength(0);
    expect(db.prepare("SELECT * FROM users WHERE created_by = 'user:owner-1' AND deleted_at IS NOT NULL").all()).toHaveLength(2);
    // no usable ticket is left (the burned rows of the created people are the bug named in the commit tests above)
    expect(db.prepare("SELECT * FROM enrolments WHERE created_by LIKE 'link:%' AND used_at IS NULL").all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM link_people').all()).toHaveLength(0);
    // the kept people were not touched and the admin is still here
    expect(db.prepare('SELECT * FROM users WHERE id = ? AND active = 1 AND deleted_at IS NULL').get(k2.id)).toBeDefined();
    expect(db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(admin.userId)).toBeDefined();
    // undoing twice is harmless
    tx(db, () => undoMerge(db, 'l'.repeat(32), 'system:link', now));
  });

  it('a merge that would leave the surau with no administrator throws and, in the caller transaction, writes nothing', () => {
    const app = buildApp(':memory:', { now: () => now });
    extraApps.push(app);
    const db = app.surau.db;
    expect(() => tx(db, () => applyMerge(db, input([lp('person-0001', { name: 'Hassan Bin Omar', devices: 1 })])))).toThrow(/no administrator/);
    expect(db.prepare("SELECT * FROM users WHERE name = 'Hassan Bin Omar'").all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM link_people').all()).toHaveLength(0);
    expect(db.prepare("SELECT * FROM enrolments WHERE created_by LIKE 'link:%'").all()).toHaveLength(0);
    // an administrator in the other list is enough
    tx(db, () => applyMerge(db, input([lp('person-0001', { name: 'Hassan Bin Omar', roles: ['admin'] })])));
    expect(db.prepare("SELECT * FROM users WHERE name = 'Hassan Bin Omar'").all()).toHaveLength(1);
  });

  it('an ops account of the kept side is never changed by a role answer', async () => {
    const app = buildApp(':memory:', { now: () => now });
    extraApps.push(app);
    await loginAs(app, 'admin');
    const db = app.surau.db;
    const k = createUser(db, { name: 'Aminah Binti Ali', roles: ['ajk'], phone: P1 }, 'test', surau);
    db.prepare('UPDATE users SET roles_json = ? WHERE id = ?').run(JSON.stringify(['ajk', 'support']), k.id);
    expect(() => tx(db, () => applyMerge(db, input([lp('person-0001', { phone: P1, roles: ['ajk', 'treasurer'] })], { roles: { [P1]: 'treasurer' }, same: [] })))).toThrow(/ops account/);
    expect(rolesOfDb(db, k.id)).toEqual(['ajk', 'support']);
  });

  it('ownPeople sends active, not deleted people with no ops role and counts only live keyed non-kiosk phones', async () => {
    const app = buildApp(':memory:', { now: () => now });
    extraApps.push(app);
    await loginAs(app, 'admin');
    await loginAs(app, 'superadmin');
    const box = { app, n: 9 } as unknown as TestBox;
    const x = addPerson(box, { name: 'Hassan Bin Omar', phone: P2, roles: ['ajk'], live: 2 });
    addDevice(box, x.id, { revoked: true });
    addDevice(box, x.id, { platform: 'kiosk' });
    addDevice(box, x.id, { keyed: false });
    const y = addPerson(box, { name: 'Halim Dihapus', roles: ['ajk'] });
    tx(app.surau.db, () => deleteUserRows(app.surau.db, y.id, 'test', now.toISOString()));
    const z = addPerson(box, { name: 'Salmah Tidak Aktif', roles: ['ajk'] });
    app.surau.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(z.id);
    const list = ownPeople(app.surau.db, surau);
    expect(list).toHaveLength(2);
    expect(list.filter((q) => q.name.startsWith('Test admin'))).toHaveLength(1);
    expect(list.find((q) => q.name === 'Hassan Bin Omar')).toMatchObject({ phone: P2, roles: ['ajk'], devices: 2 });
    expect(JSON.stringify(list)).not.toMatch(/pin|hash|jwk/i);
    expect(keptPeople(app.surau.db, surau).map((q) => q.name)).toContain('Hassan Bin Omar');
  });

  it('movesFromDb leaves out a revoked, a kiosk and a keyless device and a person without a ticket', async () => {
    const app = buildApp(':memory:', { now: () => now });
    extraApps.push(app);
    const box = { app, n: 8 } as unknown as TestBox;
    const x = addPerson(box, { name: 'Hassan Bin Omar', phone: P2, roles: ['ajk'], live: 1 });
    addDevice(box, x.id, { revoked: true });
    addDevice(box, x.id, { platform: 'kiosk' });
    addDevice(box, x.id, { keyed: false });
    const y = addPerson(box, { name: 'Salleh', roles: ['ajk'], live: 1 });
    const file = movesFromDb(app.surau.db, { linkId: 'l'.repeat(32), tickets: { [x.id]: 'AAAA-BBBB' }, expiresAt: '2026-12-22T10:00:00.000Z' });
    expect(file.entries.map((e) => e.deviceId)).toEqual([x.phones[0]!.id]);
    expect(file.entries[0]).toMatchObject({ userId: x.id, ticket: 'AAAA-BBBB' });
    expect(file.entries.some((e) => e.userId === y.id)).toBe(false);
  });

  it('movesFromDb gives an entry its own end when the person has one, and the top-level end stays', async () => {
    const app = buildApp(':memory:', { now: () => now });
    extraApps.push(app);
    const box = { app, n: 9 } as unknown as TestBox;
    const x = addPerson(box, { name: 'Hassan Bin Omar', phone: P2, roles: ['admin'], live: 1 });
    const y = addPerson(box, { name: 'Salleh', roles: ['ajk'], live: 1 });
    const file = movesFromDb(app.surau.db, {
      linkId: 'l'.repeat(32), tickets: { [x.id]: 'AAAA-BBBB', [y.id]: 'CCCC-DDDD' }, expiresAt: '2026-12-22T10:00:00.000Z',
      expiries: { [x.id]: '2026-11-22T10:30:00.000Z' },
    });
    expect(file.expiresAt).toBe('2026-12-22T10:00:00.000Z');
    expect(file.entries.find((e) => e.userId === x.id)!.expiresAt).toBe('2026-11-22T10:30:00.000Z');
    expect(file.entries.find((e) => e.userId === y.id)!.expiresAt).toBeUndefined();
  });
});

function rolesOfDb(db: { prepare: (s: string) => { get: (...a: string[]) => Record<string, unknown> | undefined } }, id: string): string[] {
  return JSON.parse(String(db.prepare('SELECT roles_json FROM users WHERE id = ?').get(id)!.roles_json)) as string[];
}
