/**
 * Plan 14 Task 8 (operator decisions 23 and 24): a box links itself into a NEW surau at its first claim; the 20 a day
 * cap; the CLI approve into a new or an existing surau; re-link; the pilot `sdm` untouched.
 *
 * Assumptions for the implementer:
 *  1. The cloud learns the box's name and claim hash from the Worker registration, read with the cloud's Worker admin
 *     settings (`buildCloud(..., { workerAdmin })`, the fake Worker's `/_admin/reg/<id>`), exactly as `cloud-approve`
 *     does today. A claim with no registration, a registration with another hash, or an unreachable Worker is
 *     refused (never 200, nothing written).
 *  2. A claim that is not linked yet because of the cap answers a non-200 status with body `{ code: 'pending' }`, no
 *     `siteToken`. Every other refusal stays the plain 401 `bad_claim`. The Worker registration is kept when pending
 *     and removed (best effort, a few ms later) after a good claim.
 *  3. The cap counts automatic creations per UTC day with the app's injected clock (`now` option), cloud wide; its
 *     default is 20. Re-link of a known box, CLI `--new-surau` and CLI `--surau` do not count and are not limited.
 *  4. Every automatic creation writes ONE `auth_log` row with `event = 'surau_auto_create'`.
 *  5. A good claim answers `surauId` and `role: 'primary'`; the `suraus` row has `name` = the registration name,
 *     `linked_at` set, `created_by` not empty; the site row has `role = 'primary'` under that surau.
 *  6. The 24 hour lost-answer re-claim keeps working for an automatic link (same claim within 24 h while the site is
 *     live: fresh key, same surau, old key dead); after 24 h it is refused. A claim for a box whose site is live and
 *     whose first claim is older than that never creates anything.
 *  7. CLI refusals exit 1 and print the refusal code on stderr as a word (`surau_required`, `surau_has_box`,
 *     `foreign_surau`, `surau_not_found`, `linked`); a refusal writes no `site_approvals` and no `suraus` row. A
 *     `foreign_surau` refusal leaves a trace containing that word in `auth_log` or `change_log`.
 *  8. `cloud-approve` takes exactly one target: `--new-surau [--name "<nama>"]` or `--surau <id>`; none or both is
 *     refused (`surau_required` / exit non zero). `--code <8 hex>` keeps its meaning (409 `code_mismatch`).
 *  9. `cloud-pending` still lists the Worker registrations (id, name, hash); a box leaves it once it has claimed.
 * 10. The cloud CLI command `cloud-revoke-site <boxId>` is unchanged (revoke key, withdraw approval). Controller
 *     decision: revoke is final; a revoked box re-links by itself only after `cloud-unrevoke --box-id <id>`.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { SURAU_ID_RE } from '@surau/core';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256hex } from '../src/auth/crypto.ts';
import { run as usersCli } from '../src/cli/users.ts';
import { putItem } from '../src/content/store.ts';
import { generateSyncKeyPair } from '../src/sync/syncKey.ts';
import { buildCloud } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FakeWorker } from './support/fakeWorker.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  delete process.env.SURAU_ROLE;
  delete process.env.MAXCOM_AUTO_SURAU_DAILY_CAP;
});

const CLOUD_BOX = '0c10ad000000000b';
const PILOT_BOX = 'a1b2c3d4e5f60718';
const START = Date.parse('2026-11-12T08:00:00.000Z');
const HOUR = 3_600_000;
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

interface Rig {
  cloud: TestCloud;
  db: DatabaseSync;
  worker: FakeWorker;
  clock: number;
}
interface Box {
  boxId: string;
  claim: string;
  publicJwk: unknown;
}

function rig(): Rig {
  const state = { clock: START } as Rig;
  const viaWorker = ((i: Parameters<typeof fetch>[0], n?: RequestInit) => state.worker.fetch(i, n)) as typeof fetch;
  const cloud = buildCloud(CLOUD_BOX, {
    workerAdmin: { url: 'https://worker.test', token: 'test-admin-token', fetchImpl: viaWorker },
    workerOutbox: { auto: false },
    now: () => new Date(state.clock),
  });
  state.cloud = cloud;
  state.db = cloud.app.surau.db;
  state.worker = new FakeWorker(cloud.fetch, () => state.clock);
  cleanups.push(() => cloud.close());
  return state;
}

/** The pilot: surau `sdm` with its live box and a row of content. */
function seedPilot(db: DatabaseSync): void {
  const at = new Date(START - 30 * 24 * HOUR).toISOString();
  db.prepare("INSERT OR IGNORE INTO suraus (id, name, created_at, created_by, linked_at) VALUES ('sdm', 'Surau Perintis Contoh', ?, 'migration', ?)").run(at, at);
  db.prepare("INSERT OR IGNORE INTO sites (surau_id, box_id, name, public_jwk, token_hash, linked_at) VALUES ('sdm', ?, 'Surau Perintis Contoh', ?, ?, ?)").run(
    PILOT_BOX,
    JSON.stringify(generateSyncKeyPair().publicJwk),
    sha256hex('pilot-token'),
    at,
  );
  putItem(db, 'penceramah', { id: 'p-pilot', name: 'Ustaz Pilot' }, 'local', undefined, 'sdm');
}

/** Everything that belongs to the pilot surau, as one comparable string. */
function pilotRows(db: DatabaseSync): string {
  return JSON.stringify([
    db.prepare("SELECT * FROM suraus WHERE id = 'sdm'").all(),
    db.prepare("SELECT * FROM sites WHERE surau_id = 'sdm' ORDER BY box_id").all(),
    db.prepare("SELECT * FROM content_items WHERE surau_id = 'sdm' ORDER BY kind, id").all(),
    db.prepare("SELECT * FROM change_log WHERE surau_id = 'sdm' ORDER BY id").all(),
  ]);
}

let boxN = 0;
function newBox(): Box {
  boxN += 1;
  return { boxId: String(boxN).padStart(16, '0'), claim: randomBytes(32).toString('hex'), publicJwk: generateSyncKeyPair().publicJwk };
}

/** The box registers at the Worker with the hash of its claim secret. */
function register(r: Rig, b: Box, name = 'Surau Al-Hidayah'): void {
  r.worker.regs.set(b.boxId, { claimHash: sha256hex(b.claim), name, at: new Date(r.clock).toISOString() });
}

let ipN = 0;
function claim(r: Rig, b: Box, over: Record<string, unknown> = {}) {
  ipN += 1;
  return r.cloud.app.inject({
    method: 'POST',
    url: '/api/sync/claim',
    remoteAddress: `10.7.${(ipN >> 8) & 255}.${ipN & 255}`,
    payload: { boxId: b.boxId, claim: b.claim, publicJwk: b.publicJwk, ...over } as Record<string, unknown>,
  });
}

const snapshot = (r: Rig, token: string) => r.cloud.app.inject({ method: 'GET', url: '/api/sync/snapshot', headers: { authorization: `Bearer ${token}` } });

async function cli(r: Rig, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const viaWorker = ((i: Parameters<typeof fetch>[0], n?: RequestInit) => r.worker.fetch(i, n)) as typeof fetch;
  process.env.SURAU_ROLE = 'cloud';
  const code = await usersCli(['--db', join(r.cloud.dir, 'cloud.db'), ...args], {
    workerAdmin: { url: 'https://worker.test', token: 'test-admin-token', fetchImpl: viaWorker },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const count = (db: DatabaseSync, sql: string, ...p: string[]): number => Number((db.prepare(sql).get(...p) as { n: number }).n);
const surauCount = (db: DatabaseSync): number => count(db, 'SELECT COUNT(*) AS n FROM suraus');
const autoCreates = (db: DatabaseSync): number => count(db, "SELECT COUNT(*) AS n FROM auth_log WHERE event = 'surau_auto_create'");
const approvals = (db: DatabaseSync): number => count(db, 'SELECT COUNT(*) AS n FROM site_approvals');
const siteOf = (db: DatabaseSync, boxId: string): Record<string, unknown> | undefined => db.prepare('SELECT * FROM sites WHERE box_id = ?').get(boxId);

/** A box registers and claims: the surau it got. */
async function autoLink(r: Rig, name = 'Surau Al-Hidayah'): Promise<{ box: Box; surauId: string; siteToken: string }> {
  const box = newBox();
  register(r, box, name);
  const res = await claim(r, box);
  expect(res.statusCode, res.body).toBe(200);
  const j = res.json() as { surauId: string; siteToken: string };
  return { box, surauId: j.surauId, siteToken: j.siteToken };
}

describe('automatic surau on the first claim (decision 23)', () => {
  it('creates a NEW surau named from the registration, links the box as primary, logs it, and leaves the pilot untouched', async () => {
    const r = rig();
    seedPilot(r.db);
    const pilotBefore = pilotRows(r.db);
    const before = surauCount(r.db);
    const box = newBox();
    register(r, box, 'Surau Al-Hidayah');

    const res = await claim(r, box);
    expect(res.statusCode, res.body).toBe(200);
    const j = res.json() as { surauId: string; role: string; siteToken: string; name: string };
    expect(j.surauId).toMatch(SURAU_ID_RE);
    expect(j.surauId).not.toBe('sdm');
    expect(j.role).toBe('primary');
    expect(typeof j.siteToken).toBe('string');

    expect(surauCount(r.db)).toBe(before + 1);
    const s = r.db.prepare('SELECT * FROM suraus WHERE id = ?').get(j.surauId) as Record<string, unknown>;
    expect(s.name).toBe('Surau Al-Hidayah');
    expect(typeof s.linked_at).toBe('string');
    expect(String(s.created_by)).not.toBe('');
    expect(s.suspended_at ?? null).toBeNull();
    const site = siteOf(r.db, box.boxId)!;
    expect(site).toMatchObject({ surau_id: j.surauId, role: 'primary', revoked_at: null });
    expect(site.token_hash).toBe(sha256hex(j.siteToken));
    expect(autoCreates(r.db)).toBe(1);

    // the new key works and reads only its own surau
    expect((await snapshot(r, j.siteToken)).statusCode).toBe(200);
    // the registration leaves the Worker after a good claim
    await settle();
    expect(r.worker.regs.has(box.boxId)).toBe(false);
    // the pilot: every row byte equal
    expect(pilotRows(r.db)).toBe(pilotBefore);
  });

  it('two boxes get two different suraus', async () => {
    const r = rig();
    const a = await autoLink(r, 'Surau A');
    const b = await autoLink(r, 'Surau B');
    expect(a.surauId).not.toBe(b.surauId);
    expect(siteOf(r.db, a.box.boxId)!.surau_id).toBe(a.surauId);
    expect(siteOf(r.db, b.box.boxId)!.surau_id).toBe(b.surauId);
    expect(autoCreates(r.db)).toBe(2);
  });

  it('refuses a claim with no registration, a wrong secret, a malformed body or an unreachable Worker; nothing is created', async () => {
    const r = rig();
    seedPilot(r.db);
    const before = surauCount(r.db);
    const sitesBefore = count(r.db, 'SELECT COUNT(*) AS n FROM sites');

    const unregistered = newBox();
    expect((await claim(r, unregistered)).statusCode).toBe(401);

    const wrong = newBox();
    register(r, wrong);
    const w = await claim(r, wrong, { claim: 'f'.repeat(64) });
    expect(w.statusCode).toBe(401);
    expect(w.json().code).toBe('bad_claim');
    expect((await claim(r, wrong, { publicJwk: undefined })).statusCode).toBe(401);
    expect((await claim(r, wrong, { boxId: 'nothex' })).statusCode).toBe(401);

    const down = newBox();
    register(r, down);
    r.worker.adminDown = true;
    const d = await claim(r, down);
    r.worker.adminDown = false;
    expect(d.statusCode).not.toBe(200);
    expect(d.json().siteToken).toBeUndefined();

    expect(surauCount(r.db)).toBe(before);
    expect(count(r.db, 'SELECT COUNT(*) AS n FROM sites')).toBe(sitesBefore);
    expect(autoCreates(r.db)).toBe(0);
    // the box that did nothing wrong is not damaged: its right claim still works once the Worker is back
    expect((await claim(r, down)).statusCode).toBe(200);
  });

  it('a registration squatting the pilot box id never takes over the pilot', async () => {
    const r = rig();
    seedPilot(r.db);
    const pilotBefore = pilotRows(r.db);
    const squatter: Box = { boxId: PILOT_BOX, claim: randomBytes(32).toString('hex'), publicJwk: generateSyncKeyPair().publicJwk };
    register(r, squatter, 'Penyamar');
    const res = await claim(r, squatter);
    expect(res.statusCode).not.toBe(200);
    expect(res.json().siteToken).toBeUndefined();
    expect(pilotRows(r.db)).toBe(pilotBefore);
    expect(count(r.db, "SELECT COUNT(*) AS n FROM suraus WHERE name = 'Penyamar'")).toBe(0);
    // and the pilot's own key still works
    expect((await snapshot(r, 'pilot-token')).statusCode).toBe(200);
  });

  it('revoke is final: the revoked box is refused (403 box_revoked, registration kept, logged) until cloud-unrevoke; then it re-links once into its own surau', async () => {
    const r = rig();
    const a = await autoLink(r);
    const created = surauCount(r.db);
    await settle();
    const lines = await cli(r, ['cloud-revoke-site', a.box.boxId]);
    expect(lines.code, lines.err).toBe(0);
    expect((await snapshot(r, a.siteToken)).statusCode).toBe(401);

    // the box registers again with the same secret and claims: refused, nothing written
    register(r, a.box);
    const sitesBefore = JSON.stringify(siteOf(r.db, a.box.boxId));
    const refused = await claim(r, a.box);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'box_revoked' });
    expect(refused.json().siteToken).toBeUndefined();
    expect(JSON.stringify(siteOf(r.db, a.box.boxId))).toBe(sitesBefore);
    expect(count(r.db, "SELECT COUNT(*) AS n FROM auth_log WHERE detail = 'box_revoked'")).toBe(1);
    await settle();
    expect(r.worker.regs.has(a.box.boxId), 'registration kept').toBe(true);
    // a wrong secret stays the plain 401 (the answer tells nothing about the box)
    expect((await claim(r, a.box, { claim: 'e'.repeat(64) })).statusCode).toBe(401);

    // cloud-unrevoke: refused for an unknown and a live box, then lets this one back in, once
    const unknown = await cli(r, ['cloud-unrevoke', '--box-id', 'ffffffffffffffff']);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('not_found');
    const none = await cli(r, ['cloud-unrevoke']);
    expect(none.code).toBe(1);
    expect(none.err).toContain('bad_args');
    const un = await cli(r, ['cloud-unrevoke', '--box-id', a.box.boxId]);
    expect(un.code, un.err).toBe(0);
    const again = await claim(r, a.box);
    expect(again.statusCode, again.body).toBe(200);
    const j = again.json() as { surauId: string; siteToken: string; role: string };
    expect(j.surauId).toBe(a.surauId);
    expect(j.role).toBe('primary');
    expect(j.siteToken).not.toBe(a.siteToken);
    expect(surauCount(r.db)).toBe(created);
    expect(autoCreates(r.db), 'a re-link creates no surau').toBe(1);
    expect(siteOf(r.db, a.box.boxId)).toMatchObject({ surau_id: a.surauId, revoked_at: null });
    expect((await snapshot(r, a.siteToken)).statusCode).toBe(401);
    expect((await snapshot(r, j.siteToken)).statusCode).toBe(200);
    // a live box cannot be unrevoked; a second revoke is final again (the unrevoke was spent)
    const live = await cli(r, ['cloud-unrevoke', '--box-id', a.box.boxId]);
    expect(live.code).toBe(1);
    expect(live.err).toContain('not_revoked');
    expect((await cli(r, ['cloud-revoke', '--box-id', a.box.boxId])).code).toBe(0);
    register(r, a.box);
    expect((await claim(r, a.box)).statusCode).toBe(403);
    // the unrevoke CLI is cloud only
    process.env.SURAU_ROLE = 'box';
    const boxRole = await usersCli(['--db', join(r.cloud.dir, 'cloud.db'), 'cloud-unrevoke', '--box-id', a.box.boxId], { out: () => undefined, err: () => undefined });
    expect(boxRole).toBe(1);
  });

  it('a lost answer: the same claim within 24 hours gets a fresh key in the same surau, after 24 hours it is refused', async () => {
    const r = rig();
    const a = await autoLink(r);
    const created = surauCount(r.db);
    r.clock += HOUR;
    const again = await claim(r, a.box);
    expect(again.statusCode, again.body).toBe(200);
    const j = again.json() as { surauId: string; siteToken: string };
    expect(j.surauId).toBe(a.surauId);
    expect((await snapshot(r, a.siteToken)).statusCode).toBe(401);
    expect((await snapshot(r, j.siteToken)).statusCode).toBe(200);

    r.clock += 25 * HOUR;
    const late = await claim(r, a.box);
    expect(late.statusCode).not.toBe(200);
    expect(late.json().siteToken).toBeUndefined();
    expect(surauCount(r.db)).toBe(created);
    expect((await snapshot(r, j.siteToken)).statusCode, 'the live key is not harmed by the refused claim').toBe(200);
    expect(autoCreates(r.db)).toBe(1);
  });
});

describe('the daily cap on automatic suraus (decision 23)', () => {
  /** 20 boxes link themselves. */
  async function fill(r: Rig): Promise<Awaited<ReturnType<typeof autoLink>>[]> {
    const done: Awaited<ReturnType<typeof autoLink>>[] = [];
    for (let i = 0; i < 20; i++) done.push(await autoLink(r, `Surau ${i + 1}`));
    return done;
  }

  it('the 21st box of the day stays pending: registration kept, no surau, no site; the next UTC day it links by itself', async () => {
    process.env.MAXCOM_AUTO_SURAU_DAILY_CAP = '20'; // the default is 100 since 2026-11-14
    const r = rig();
    seedPilot(r.db);
    r.clock = Date.parse('2026-11-12T23:00:00.000Z');
    await fill(r);
    expect(autoCreates(r.db)).toBe(20);
    const before = surauCount(r.db);

    const late = newBox();
    register(r, late, 'Surau Kedua Puluh Satu');
    const res = await claim(r, late);
    expect(res.statusCode).not.toBe(200);
    expect(res.json()).toMatchObject({ code: 'pending' });
    expect(res.json().siteToken).toBeUndefined();
    await settle();
    expect(surauCount(r.db)).toBe(before);
    expect(siteOf(r.db, late.boxId)).toBeUndefined();
    expect(r.worker.regs.has(late.boxId), 'registration kept').toBe(true);
    expect(autoCreates(r.db)).toBe(20);

    // still pending later the same UTC day
    r.clock = Date.parse('2026-11-12T23:59:30.000Z');
    expect((await claim(r, late)).json()).toMatchObject({ code: 'pending' });

    // next UTC day: the count starts again
    r.clock = Date.parse('2026-11-13T00:00:30.000Z');
    const next = await claim(r, late);
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json().surauId).toMatch(SURAU_ID_RE);
    expect(surauCount(r.db)).toBe(before + 1);
    expect(autoCreates(r.db)).toBe(21);
    expect(r.db.prepare('SELECT name FROM suraus WHERE id = ?').get(next.json().surauId)).toMatchObject({ name: 'Surau Kedua Puluh Satu' });
  });

  it('at the cap a known box still re-links, and the CLI creates a surau by hand (the cap does not apply to it)', async () => {
    process.env.MAXCOM_AUTO_SURAU_DAILY_CAP = '20'; // the default is 100 since 2026-11-14
    const r = rig();
    seedPilot(r.db);
    const linked = await fill(r);
    const first = linked[0]!;
    const late = newBox();
    register(r, late, 'Surau Menunggu');
    expect((await claim(r, late)).json()).toMatchObject({ code: 'pending' });
    await settle();

    // cloud-pending lists the waiting box
    const pending = await cli(r, ['cloud-pending']);
    expect(pending.code, pending.err).toBe(0);
    expect(pending.out).toContain(late.boxId);
    expect(pending.out).toContain('Surau Menunggu');

    // re-link of the first box is not a new surau, so the cap does not stop it
    expect((await cli(r, ['cloud-revoke-site', first.box.boxId])).code).toBe(0);
    // revoke is final until MAXCOM lets the box back in
    expect((await cli(r, ['cloud-unrevoke', '--box-id', first.box.boxId])).code).toBe(0);
    register(r, first.box);
    const relink = await claim(r, first.box);
    expect(relink.statusCode, relink.body).toBe(200);
    expect(relink.json().surauId).toBe(first.surauId);

    // by hand
    const before = surauCount(r.db);
    const made = await cli(r, ['cloud-approve', '--box-id', late.boxId, '--new-surau']);
    expect(made.code, made.err).toBe(0);
    const got = await claim(r, late);
    expect(got.statusCode, got.body).toBe(200);
    expect(got.json().surauId).toMatch(SURAU_ID_RE);
    expect(count(r.db, 'SELECT COUNT(*) AS n FROM suraus')).toBe(before + 1);
    expect(r.db.prepare('SELECT name FROM suraus WHERE id = ?').get(got.json().surauId)).toMatchObject({ name: 'Surau Menunggu' });
    expect(autoCreates(r.db), 'the CLI creation is not an automatic one').toBe(20);
    expect(count(r.db, "SELECT COUNT(*) AS n FROM sites WHERE role = 'primary'") >= 21).toBe(true);
  });
});

describe('cloud-approve: the CLI target rule (decisions 23, 24)', () => {
  it('no target, or both targets, is refused and writes nothing', async () => {
    const r = rig();
    seedPilot(r.db);
    const box = newBox();
    register(r, box);
    const nSuraus = surauCount(r.db);
    const none = await cli(r, ['cloud-approve', '--box-id', box.boxId]);
    expect(none.code).toBe(1);
    expect(none.err).toContain('surau_required');
    const both = await cli(r, ['cloud-approve', '--box-id', box.boxId, '--new-surau', '--surau', 'sdm']);
    expect(both.code).toBe(1);
    expect(both.err).toContain('bad_args');
    expect(surauCount(r.db)).toBe(nSuraus);
    expect(approvals(r.db)).toBe(0);
    expect(siteOf(r.db, box.boxId)).toBeUndefined();
  });

  it('--new-surau [--name]: creates the surau waiting, the claim links the box under it and sets linked_at; --code must match', async () => {
    const r = rig();
    const box = newBox();
    register(r, box, 'Nama Pendaftaran');
    const before = surauCount(r.db);

    const wrongCode = await cli(r, ['cloud-approve', '--box-id', box.boxId, '--new-surau', '--code', (sha256hex(box.claim).slice(0, 8) === '00000000' ? 'ffffffff' : '00000000')]);
    expect(wrongCode.code).toBe(1);
    expect(wrongCode.err).toContain('code_mismatch');
    expect(surauCount(r.db)).toBe(before);
    expect(approvals(r.db)).toBe(0);

    const ok = await cli(r, ['cloud-approve', '--box-id', box.boxId, '--new-surau', '--name', 'Nama Pilihan', '--code', sha256hex(box.claim).slice(0, 8)]);
    expect(ok.code, ok.err).toBe(0);
    const res = await claim(r, box);
    expect(res.statusCode, res.body).toBe(200);
    const j = res.json() as { surauId: string; role: string };
    expect(j.surauId).toMatch(SURAU_ID_RE);
    expect(j.role).toBe('primary');
    expect(surauCount(r.db)).toBe(before + 1);
    const s = r.db.prepare('SELECT name, linked_at FROM suraus WHERE id = ?').get(j.surauId) as Record<string, unknown>;
    expect(s.name).toBe('Nama Pilihan');
    expect(typeof s.linked_at).toBe('string');
    expect(siteOf(r.db, box.boxId)).toMatchObject({ surau_id: j.surauId, role: 'primary' });
    // a CLI approval writes a change_log row with the actor
    expect(count(r.db, "SELECT COUNT(*) AS n FROM change_log WHERE entity = 'site' AND entity_id = ? AND actor = 'local'", box.boxId) >= 1).toBe(true);
  });

  it('--surau <id> with no live box links as primary (a surau made first), and the surau keeps its id', async () => {
    const r = rig();
    const first = await autoLink(r);
    // free the surau: its box is revoked, so it has no live box
    expect((await cli(r, ['cloud-revoke-site', first.box.boxId])).code).toBe(0);
    const other = newBox();
    register(r, other, 'Kotak Ganti');
    const before = surauCount(r.db);
    const ok = await cli(r, ['cloud-approve', '--box-id', other.boxId, '--surau', first.surauId]);
    expect(ok.code, ok.err).toBe(0);
    const res = await claim(r, other);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ surauId: first.surauId, role: 'primary' });
    expect(surauCount(r.db), 'no new surau').toBe(before);
    expect(siteOf(r.db, other.boxId)).toMatchObject({ surau_id: first.surauId, role: 'primary', revoked_at: null });
    expect(autoCreates(r.db)).toBe(1);
  });

  it('--surau <id> while that surau has a live primary box: surau_has_box, nothing written (the pilot included)', async () => {
    const r = rig();
    seedPilot(r.db);
    const pilotBefore = pilotRows(r.db);
    const a = await autoLink(r);
    for (const target of [a.surauId, 'sdm']) {
      const box = newBox();
      register(r, box);
      const nSuraus = surauCount(r.db);
      const nSites = count(r.db, 'SELECT COUNT(*) AS n FROM sites');
      const nApprovals = approvals(r.db);
      const res = await cli(r, ['cloud-approve', '--box-id', box.boxId, '--surau', target]);
      expect(res.code).toBe(1);
      expect(res.err).toContain('surau_has_box');
      expect(surauCount(r.db)).toBe(nSuraus);
      expect(count(r.db, 'SELECT COUNT(*) AS n FROM sites')).toBe(nSites);
      expect(approvals(r.db)).toBe(nApprovals);
      // the claim does not slip in either: the box becomes its own new surau only through the automatic rule, never the target
      const got = await claim(r, box);
      if (got.statusCode === 200) expect(got.json().surauId).not.toBe(target);
    }
    expect(siteOf(r.db, a.box.boxId)).toMatchObject({ surau_id: a.surauId, revoked_at: null });
    expect(pilotRows(r.db)).toBe(pilotBefore);
  });

  it('an unknown --surau is refused; a box already under surau A is refused into surau B (foreign_surau, logged)', async () => {
    const r = rig();
    const a = await autoLink(r, 'Surau A');
    const b = await autoLink(r, 'Surau B');
    // B's box goes away so B is free
    expect((await cli(r, ['cloud-revoke-site', b.box.boxId])).code).toBe(0);
    const nApprovals = approvals(r.db);

    const unknown = await cli(r, ['cloud-approve', '--box-id', a.box.boxId, '--surau', 'tiada-surau-ini']);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('surau_not_found');

    // A's box, revoked first, may not move to B
    expect((await cli(r, ['cloud-revoke-site', a.box.boxId])).code).toBe(0);
    register(r, a.box);
    // counted after A's revoke, which withdraws A's own approval
    const approvalsBefore = approvals(r.db);
    expect(approvalsBefore).toBe(nApprovals - 1);
    const foreign = await cli(r, ['cloud-approve', '--box-id', a.box.boxId, '--surau', b.surauId]);
    expect(foreign.code).toBe(1);
    expect(foreign.err).toContain('foreign_surau');
    expect(approvals(r.db)).toBe(approvalsBefore);
    const trace = JSON.stringify([r.db.prepare('SELECT * FROM auth_log').all(), r.db.prepare('SELECT * FROM change_log').all()]);
    expect(trace).toContain('foreign_surau');
    // the box is still A's: once MAXCOM unrevokes it, its own claim re-links it into A
    expect((await cli(r, ['cloud-unrevoke', '--box-id', a.box.boxId])).code).toBe(0);
    const back = await claim(r, a.box);
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().surauId).toBe(a.surauId);
  });

  it('a box with a live site cannot be approved again (revoke first)', async () => {
    const r = rig();
    const a = await autoLink(r);
    const nSuraus = surauCount(r.db);
    register(r, a.box);
    const nApprovals = approvals(r.db);
    const again = await cli(r, ['cloud-approve', '--box-id', a.box.boxId, '--new-surau']);
    expect(again.code).toBe(1);
    expect(again.err).toContain('linked');
    expect(approvals(r.db)).toBe(nApprovals);
    expect(surauCount(r.db)).toBe(nSuraus);
    expect(siteOf(r.db, a.box.boxId)).toMatchObject({ surau_id: a.surauId, revoked_at: null });
  });
});

describe('controller additions: the cap setting, races, cloud-pending fields', () => {
  it('MAXCOM_AUTO_SURAU_DAILY_CAP=0: no automatic surau at all, every new box pending; a known box still re-links; the CLI still creates', async () => {
    const r = rig();
    const a = await autoLink(r, 'Surau Sebelum');
    process.env.MAXCOM_AUTO_SURAU_DAILY_CAP = '0';
    const before = surauCount(r.db);
    const box = newBox();
    register(r, box, 'Surau Tertahan');
    const res = await claim(r, box);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ code: 'pending' });
    expect(res.json().siteToken).toBeUndefined();
    expect(surauCount(r.db)).toBe(before);
    expect(siteOf(r.db, box.boxId)).toBeUndefined();
    expect(approvals(r.db)).toBe(1);
    // a known box is not a new surau: it re-links whatever the cap
    expect((await cli(r, ['cloud-revoke-site', a.box.boxId])).code).toBe(0);
    // revoke is final until MAXCOM lets the box back in
    expect((await cli(r, ['cloud-unrevoke', '--box-id', a.box.boxId])).code).toBe(0);
    register(r, a.box);
    const relink = await claim(r, a.box);
    expect(relink.statusCode, relink.body).toBe(200);
    expect(relink.json().surauId).toBe(a.surauId);
    // by hand
    expect((await cli(r, ['cloud-approve', '--box-id', box.boxId, '--new-surau'])).code).toBe(0);
    const got = await claim(r, box);
    expect(got.statusCode, got.body).toBe(200);
    expect(surauCount(r.db)).toBe(before + 1);
    expect(autoCreates(r.db)).toBe(1);
  });

  it('a small cap (2): the third new box of the day waits; a bad value falls back to 20', async () => {
    const r = rig();
    process.env.MAXCOM_AUTO_SURAU_DAILY_CAP = '2';
    await autoLink(r, 'Satu');
    await autoLink(r, 'Dua');
    const third = newBox();
    register(r, third, 'Tiga');
    expect((await claim(r, third)).json()).toMatchObject({ code: 'pending' });
    expect(autoCreates(r.db)).toBe(2);
    for (const bad of ['-1', 'banyak', '2.5', '']) {
      process.env.MAXCOM_AUTO_SURAU_DAILY_CAP = bad;
      const x = newBox();
      register(r, x, `Kotak ${bad}`);
      expect((await claim(r, x)).statusCode, `cap ${JSON.stringify(bad)} means the default 20`).toBe(200);
    }
  });

  it('race at the cap boundary: two new boxes claiming at once never create more than the cap', async () => {
    const r = rig();
    process.env.MAXCOM_AUTO_SURAU_DAILY_CAP = '3';
    await autoLink(r, 'Satu');
    await autoLink(r, 'Dua');
    const x = newBox();
    const y = newBox();
    register(r, x, 'X');
    register(r, y, 'Y');
    const [rx, ry] = await Promise.all([claim(r, x), claim(r, y)]);
    expect([rx.statusCode, ry.statusCode].sort()).toEqual([200, 202]);
    expect(autoCreates(r.db)).toBe(3);
    expect(count(r.db, "SELECT COUNT(*) AS n FROM suraus WHERE created_by = 'auto'")).toBe(3);
    // and a wider burst: five at once against two free places
    process.env.MAXCOM_AUTO_SURAU_DAILY_CAP = '5';
    const burst = Array.from({ length: 5 }, () => newBox());
    for (const b of burst) register(r, b, `Burst ${b.boxId}`);
    const answers = await Promise.all(burst.map((b) => claim(r, b)));
    expect(answers.filter((a) => a.statusCode === 200)).toHaveLength(2);
    expect(answers.filter((a) => a.statusCode === 202)).toHaveLength(3);
    expect(autoCreates(r.db)).toBe(5);
  });

  it('race of one box with itself: two claims at once make ONE surau, and the key that lives is the one stored last', async () => {
    const r = rig();
    const box = newBox();
    register(r, box, 'Surau Kembar');
    const before = surauCount(r.db);
    const [a, b] = await Promise.all([claim(r, box), claim(r, box)]);
    const ok = [a, b].filter((x) => x.statusCode === 200);
    expect(ok.length >= 1).toBe(true);
    expect(surauCount(r.db)).toBe(before + 1);
    expect(autoCreates(r.db)).toBe(1);
    const ids = new Set(ok.map((x) => x.json().surauId as string));
    expect(ids.size).toBe(1);
    const site = siteOf(r.db, box.boxId)!;
    expect(site.surau_id).toBe([...ids][0]);
    expect(ok.map((x) => sha256hex(x.json().siteToken as string))).toContain(site.token_hash);
  });

  it('cloud-pending prints the box name, platform and version of a registration, with control characters removed', async () => {
    const r = rig();
    const box = newBox();
    r.worker.regs.set(box.boxId, {
      claimHash: sha256hex(box.claim),
      name: 'Surau \u202EJahat',
      at: new Date(r.clock).toISOString(),
      boxName: 'Kotak\u200B Dewan\u0007',
      platform: 'android',
      version: '2026.11.6',
    } as { claimHash: string; name: string; at: string });
    const plain = newBox();
    register(r, plain, 'Surau Biasa');
    const res = await cli(r, ['cloud-pending']);
    expect(res.code, res.err).toBe(0);
    const line = res.out.split('\n').find((l) => l.includes(box.boxId))!;
    expect(line).toContain('Surau Jahat');
    expect(line).toContain('Kotak Dewan');
    expect(line).toContain('android');
    expect(line).toContain('2026.11.6');
    expect(line).not.toMatch(/[\u202E\u200B\u0007]/u);
    // a registration without the optional fields prints as before
    const other = res.out.split('\n').find((l) => l.includes(plain.boxId))!;
    expect(other).toContain('Surau Biasa');
    expect(other).not.toContain('versi');
  });
});

describe('link codes name their surau (controller decision)', () => {
  const link = (r: Rig, boxId: string, code: string) =>
    r.cloud.app.inject({
      method: 'POST',
      url: '/api/sync/link',
      remoteAddress: `10.9.${(++ipN >> 8) & 255}.${ipN & 255}`,
      payload: { boxId, code, publicJwk: generateSyncKeyPair().publicJwk },
    });
  const codeOf = (out: string): string => /Kod pautan: (\S+)/.exec(out)![1]!;

  it('cloud-code needs exactly one target; --new-surau links into a new surau, --surau into that one, never sdm', async () => {
    const r = rig();
    seedPilot(r.db);
    const pilotBefore = pilotRows(r.db);
    const box = newBox();
    const nSuraus = surauCount(r.db);
    const none = await cli(r, ['cloud-code', '--box-id', box.boxId, '--name', 'Surau Kod']);
    expect(none.code).toBe(1);
    expect(none.err).toContain('surau_required');
    const both = await cli(r, ['cloud-code', '--box-id', box.boxId, '--name', 'Surau Kod', '--new-surau', '--surau', 'sdm']);
    expect(both.code).toBe(1);
    expect(both.err).toContain('bad_args');
    const unknown = await cli(r, ['cloud-code', '--box-id', box.boxId, '--name', 'Surau Kod', '--surau', 'tiada-surau-ini']);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('surau_not_found');
    expect(surauCount(r.db)).toBe(nSuraus);
    expect(count(r.db, "SELECT COUNT(*) AS n FROM sync_state WHERE key LIKE 'link_code:%'")).toBe(0);

    const made = await cli(r, ['cloud-code', '--box-id', box.boxId, '--name', 'Surau Kod', '--new-surau']);
    expect(made.code, made.err).toBe(0);
    expect(surauCount(r.db)).toBe(nSuraus + 1);
    const res = await link(r, box.boxId, codeOf(made.out));
    expect(res.statusCode, res.body).toBe(200);
    const surauId = res.json().surauId as string;
    expect(surauId).toMatch(SURAU_ID_RE);
    expect(surauId).not.toBe('sdm');
    expect(siteOf(r.db, box.boxId)).toMatchObject({ surau_id: surauId, role: 'primary' });
    expect(r.db.prepare('SELECT name, linked_at FROM suraus WHERE id = ?').get(surauId)).toMatchObject({ name: 'Surau Kod' });
    expect(typeof (r.db.prepare('SELECT linked_at FROM suraus WHERE id = ?').get(surauId) as { linked_at: unknown }).linked_at).toBe('string');

    // into an existing surau with no live box
    expect((await cli(r, ['cloud-revoke', '--box-id', box.boxId])).code).toBe(0);
    const other = newBox();
    const into = await cli(r, ['cloud-code', '--box-id', other.boxId, '--name', 'Kotak Ganti', '--surau', surauId]);
    expect(into.code, into.err).toBe(0);
    const res2 = await link(r, other.boxId, codeOf(into.out));
    expect(res2.statusCode, res2.body).toBe(200);
    expect(res2.json().surauId).toBe(surauId);
    expect(pilotRows(r.db)).toBe(pilotBefore);
  });

  it('a code into a surau with a live primary box is refused surau_has_box (the pilot included); a box of another surau is foreign_surau', async () => {
    const r = rig();
    seedPilot(r.db);
    const a = await autoLink(r, 'Surau A');
    const nSuraus = surauCount(r.db);
    const logBefore = count(r.db, 'SELECT COUNT(*) AS n FROM change_log');
    for (const target of ['sdm', a.surauId]) {
      const res = await cli(r, ['cloud-code', '--box-id', newBox().boxId, '--name', 'Penyusup', '--surau', target]);
      expect(res.code).toBe(1);
      expect(res.err).toContain('surau_has_box');
    }
    const foreign = await cli(r, ['cloud-code', '--box-id', a.box.boxId, '--name', 'Pindah', '--surau', 'sdm']);
    expect(foreign.code).toBe(1);
    expect(foreign.err).toContain('foreign_surau');
    expect(count(r.db, "SELECT COUNT(*) AS n FROM auth_log WHERE detail = 'foreign_surau'")).toBe(1);
    expect(surauCount(r.db)).toBe(nSuraus);
    expect(count(r.db, 'SELECT COUNT(*) AS n FROM change_log')).toBe(logBefore);
    expect(count(r.db, "SELECT COUNT(*) AS n FROM sync_state WHERE key LIKE 'link_code:%'")).toBe(0);
    // a live box re-linked by a code stays in its own surau (its key is replaced)
    const own = await cli(r, ['cloud-code', '--box-id', a.box.boxId, '--name', 'Surau A', '--surau', a.surauId]);
    expect(own.code, own.err).toBe(0);
    const res = await link(r, a.box.boxId, codeOf(own.out));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().surauId).toBe(a.surauId);
    expect((await snapshot(r, a.siteToken)).statusCode).toBe(401);
  });

  it('a code whose surau gained another live box after it was issued, or a code with no surau (made before Task 8), is the plain 401', async () => {
    const r = rig();
    const empty = await cli(r, ['cloud-code', '--box-id', newBox().boxId, '--name', 'Kosong', '--new-surau']);
    expect(empty.code, empty.err).toBe(0);
    const surauId = String((r.db.prepare("SELECT id FROM suraus WHERE name = 'Kosong'").get() as { id: string }).id);
    // two codes into the same empty surau can both be issued; the first redeemed wins, the second is then 401
    const y = newBox();
    const z = newBox();
    const codeY = await cli(r, ['cloud-code', '--box-id', y.boxId, '--name', 'Y', '--surau', surauId]);
    const codeZ = await cli(r, ['cloud-code', '--box-id', z.boxId, '--name', 'Z', '--surau', surauId]);
    expect(codeY.code, codeY.err).toBe(0);
    expect(codeZ.code, codeZ.err).toBe(0);
    expect((await link(r, z.boxId, codeOf(codeZ.out))).statusCode).toBe(200);
    const late = await link(r, y.boxId, codeOf(codeY.out));
    expect(late.statusCode).toBe(401);
    expect(siteOf(r.db, y.boxId)).toBeUndefined();

    // legacy entry: no surauId
    const legacy = newBox();
    const raw = 'ABCDEFGHJKLM';
    r.db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run(
      `link_code:${sha256hex(raw)}`,
      JSON.stringify({ boxId: legacy.boxId, name: 'Lama', expiresAt: new Date(Date.now() + 600_000).toISOString() }),
    );
    const res = await link(r, legacy.boxId, raw);
    expect(res.statusCode).toBe(401);
    expect(siteOf(r.db, legacy.boxId)).toBeUndefined();
  });
});

describe('qs-gate N1: a known box re-links by its stored key, not by its first secret', () => {
  it('unrevoked same box re-links with a fresh claim secret (the box makes a new one after every link)', async () => {
    const r = rig();
    const a = await autoLink(r);
    expect((await cli(r, ['cloud-revoke-site', a.box.boxId])).code).toBe(0);
    expect((await cli(r, ['cloud-unrevoke', '--box-id', a.box.boxId])).code).toBe(0);
    const fresh: Box = { ...a.box, claim: randomBytes(32).toString('hex') };
    register(r, fresh);
    const res = await claim(r, fresh);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().surauId).toBe(a.surauId);
    expect(siteOf(r.db, a.box.boxId)).toMatchObject({ surau_id: a.surauId, revoked_at: null });
    expect((await snapshot(r, res.json().siteToken)).statusCode).toBe(200);
  });

  it('a reset box (new key) is refused even after cloud-unrevoke and stays registered; cloud-approve --surau then links it', async () => {
    const r = rig();
    const a = await autoLink(r);
    expect((await cli(r, ['cloud-revoke-site', a.box.boxId])).code).toBe(0);
    expect((await cli(r, ['cloud-unrevoke', '--box-id', a.box.boxId])).code).toBe(0);
    const reset: Box = { boxId: a.box.boxId, claim: randomBytes(32).toString('hex'), publicJwk: generateSyncKeyPair().publicJwk };
    register(r, reset);
    const before = JSON.stringify(siteOf(r.db, a.box.boxId));
    const res = await claim(r, reset);
    expect(res.statusCode).toBe(401);
    expect(res.json().siteToken).toBeUndefined();
    expect(JSON.stringify(siteOf(r.db, a.box.boxId))).toBe(before);
    await settle();
    expect(r.worker.regs.has(a.box.boxId), 'registration kept for the operator').toBe(true);
    const ok = await cli(r, ['cloud-approve', '--box-id', a.box.boxId, '--surau', a.surauId]);
    expect(ok.code, ok.err).toBe(0);
    const linked = await claim(r, reset);
    expect(linked.statusCode, linked.body).toBe(200);
    expect(linked.json().surauId).toBe(a.surauId);
  });

  it('a squatter registering a known id with another key never links (revoked, unrevoked, or live)', async () => {
    const r = rig();
    const a = await autoLink(r);
    const squat: Box = { boxId: a.box.boxId, claim: randomBytes(32).toString('hex'), publicJwk: generateSyncKeyPair().publicJwk };
    // live site
    register(r, squat);
    expect((await claim(r, squat)).statusCode).toBe(401);
    // revoked, then unrevoked: the squatter still gets nothing and does not spend the unrevoke
    expect((await cli(r, ['cloud-revoke-site', a.box.boxId])).code).toBe(0);
    expect((await claim(r, squat)).statusCode).toBe(401);
    expect((await cli(r, ['cloud-unrevoke', '--box-id', a.box.boxId])).code).toBe(0);
    expect((await claim(r, squat)).statusCode).toBe(401);
    expect(siteOf(r.db, a.box.boxId)).toMatchObject({ surau_id: a.surauId });
    expect(siteOf(r.db, a.box.boxId)!.revoked_at).not.toBeNull();
    // the real box (its own key) still gets back in afterwards
    const real: Box = { ...a.box, claim: randomBytes(32).toString('hex') };
    register(r, real);
    expect((await claim(r, real)).statusCode).toBe(200);
  });
});

describe('qs-gate S2: the claim has a second bucket on the address alone', () => {
  it('60 claims from one address with 60 box ids pass the limiter; the 61st is 429 and never reaches the Worker', async () => {
    const state = { clock: START, lookups: 0 } as Rig & { lookups: number };
    const viaWorker = ((i: Parameters<typeof fetch>[0], n?: RequestInit) => {
      if (String(i).includes('/_admin/reg/')) state.lookups += 1;
      return state.worker.fetch(i, n);
    }) as typeof fetch;
    const cloud = buildCloud(CLOUD_BOX, { workerAdmin: { url: 'https://worker.test', token: 'test-admin-token', fetchImpl: viaWorker }, workerOutbox: { auto: false }, now: () => new Date(state.clock) });
    cleanups.push(() => cloud.close());
    state.worker = new FakeWorker(cloud.fetch, () => state.clock);
    const at = (b: Box) => cloud.app.inject({ method: 'POST', url: '/api/sync/claim', remoteAddress: '10.99.0.1', payload: { boxId: b.boxId, claim: b.claim, publicJwk: b.publicJwk } as Record<string, unknown> });
    for (let i = 0; i < 60; i += 1) {
      const res = await at(newBox());
      expect(res.statusCode, `claim ${i}`).not.toBe(429);
    }
    const asked = state.lookups;
    expect(asked).toBe(60);
    const over = await at(newBox());
    expect(over.statusCode).toBe(429);
    expect(state.lookups, 'the Worker is not asked past the limit').toBe(asked);
    // another address is not affected (the success path of the per-address bucket)
    const other = newBox();
    state.worker.regs.set(other.boxId, { claimHash: sha256hex(other.claim), name: 'Surau Lain', at: new Date(state.clock).toISOString() });
    const ok = await cloud.app.inject({ method: 'POST', url: '/api/sync/claim', remoteAddress: '10.99.0.2', payload: { boxId: other.boxId, claim: other.claim, publicJwk: other.publicJwk } as Record<string, unknown> });
    expect(ok.statusCode, ok.body).toBe(200);
  });
});
