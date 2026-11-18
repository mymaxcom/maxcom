/**
 * Plan 14 Task 8 (decisions 23, 24): the surau registry, suspend / unsuspend / revoke, the per surau storage limit,
 * the CLI that drives them. The automatic link itself is in `approveSurau.test.ts`.
 *
 * Assumptions for the implementer:
 *  1. Module `src/surau/registry.ts` exports `createSurau(db, { name, kind?, location?, zone? }, actor)` returning
 *     `{ id, name, kind, status, ... }`, `listSuraus(db)` returning the same shape for every surau (pilot included),
 *     and `getSurau(db, id)` returning that shape plus `boxes: { boxId, name, role, lastSeenAt, revoked }[]` and
 *     `storageLimitBytes` (the EFFECTIVE limit: 2 GiB when `suraus.storage_limit_bytes` is null); null for an unknown id.
 *  2. `status` is the string `'Menunggu MAXCOM'` while the surau has never been linked (`linked_at` null); once a box
 *     has linked it is another non empty string; a suspended surau has a third distinct string.
 *  3. `createSurau` mints an id matching SURAU_ID_RE (never `sdm`, never an existing id), trims the name, refuses an
 *     empty name by throwing, and writes a `change_log` row `entity = 'surau'`, `entity_id = <id>`, `actor` = the actor
 *     argument, `surau_id = <id>`.
 *  4. CLI: `cloud-suraus` lists every surau (id, name, status) with its boxes (box id, role, and the word `dibatalkan`
 *     for a revoked box). `surau-suspend --surau <id> --reason "<text>"` (reason required), `surau-unsuspend --surau
 *     <id>`, `cloud-revoke --box-id <id>` (same effect as `cloud-revoke-site`), `surau-limit --surau <id> --gb <n>`
 *     (n a positive number; stored as bytes = n * 1024^3). Refusals exit 1 (or 2 for a missing argument) with the
 *     reason on stderr, and change nothing. All of them write a `change_log` row with actor `local`.
 *  5. A suspended surau: every site call answers 403 with body `{ code: 'surau_suspended' }` and every phone (device
 *     session of that surau) cloud call too. Other suraus, the pilot included, are untouched. Suspending sets
 *     `suspended_at` and `suspended_reason`; unsuspending clears both. Revoking the box leaves the surau, its data and
 *     its phones' access in place.
 *  6. Storage limit: an asset PUT by a site (`PUT /api/sync/assets/:id`) that would take the surau past its limit is
 *     413 with `code: 'storage_full'` and the BM text `Storan awan surau penuh`. Usage is counted per surau (assets a
 *     site of that surau put). An asset already stored for the surau is still a plain 200. Finance photos: `putPhoto`
 *     throws `PhotoError` (status 413, text `Storan awan surau penuh`) for a surau past its limit. A database with
 *     no `suraus` row for the id (a box) keeps its old quotas.
 *  7. The tests set a tiny limit with `UPDATE suraus SET storage_limit_bytes = <n> WHERE id = <id>` (the column named
 *     by the brief); the clock is the app's injected `now`.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { SURAU_ID_RE } from '@surau/core';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256hex } from '../src/auth/crypto.ts';
import { run as usersCli } from '../src/cli/users.ts';
import { putItem } from '../src/content/store.ts';
import { PhotoError, putPhoto } from '../src/finance/photos.ts';
import { createSurau, getSurau, listSuraus } from '../src/surau/registry.ts';
import { DISK_CHECK_TTL_MS, disableCloudDiskGuard, enableCloudDiskGuard } from '../src/surau/storage.ts';
import { generateSyncKeyPair } from '../src/sync/syncKey.ts';
import { loginAs, TEST_PIN } from './authHelpers.ts';
import { buildCloud } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FakeWorker } from './support/fakeWorker.ts';
import { jpeg } from './support/jpeg.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { applyOp } from '../src/sync/apply.ts';
import type { VerifiedOp } from '../src/sync/apply.ts';
import { startFakeGoogle } from './support/fakeGoogle.ts';
import { withUploadApi } from './support/fakeGoogleUpload.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  delete process.env.SURAU_ROLE;
});

const CLOUD_BOX = '0c10ad000000000c';
const PILOT_BOX = 'a1b2c3d4e5f60718';
const START = Date.parse('2026-11-12T08:00:00.000Z');
const GIB = 1024 * 1024 * 1024;

interface Rig {
  cloud: TestCloud;
  db: DatabaseSync;
  worker: FakeWorker;
  clock: number;
}
interface Linked {
  boxId: string;
  surauId: string;
  siteToken: string;
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

function seedPilot(db: DatabaseSync): void {
  const at = new Date(START - 30 * 24 * 3_600_000).toISOString();
  db.prepare("INSERT OR IGNORE INTO suraus (id, name, created_at, created_by, linked_at) VALUES ('sdm', 'Surau Perintis Contoh', ?, 'migration', ?)").run(at, at);
  db.prepare("INSERT OR IGNORE INTO sites (surau_id, box_id, name, public_jwk, token_hash, linked_at) VALUES ('sdm', ?, 'Surau Perintis Contoh', ?, ?, ?)").run(
    PILOT_BOX,
    JSON.stringify(generateSyncKeyPair().publicJwk),
    sha256hex('pilot-token'),
    at,
  );
  putItem(db, 'penceramah', { id: 'p-pilot', name: 'Ustaz Pilot' }, 'local', undefined, 'sdm');
}

function pilotRows(db: DatabaseSync): string {
  return JSON.stringify([
    db.prepare("SELECT * FROM suraus WHERE id = 'sdm'").all(),
    db.prepare("SELECT * FROM sites WHERE surau_id = 'sdm' ORDER BY box_id").all(),
    db.prepare("SELECT * FROM content_items WHERE surau_id = 'sdm' ORDER BY kind, id").all(),
    db.prepare("SELECT * FROM change_log WHERE surau_id = 'sdm' ORDER BY id").all(),
  ]);
}

let boxN = 100;
let ipN = 0;
/** A box registers at the Worker and claims: it gets its own surau. */
async function autoLink(r: Rig, name = 'Surau Al-Hidayah'): Promise<Linked> {
  boxN += 1;
  ipN += 1;
  const boxId = String(boxN).padStart(16, '0');
  const claim = randomBytes(32).toString('hex');
  r.worker.regs.set(boxId, { claimHash: sha256hex(claim), name, at: new Date(r.clock).toISOString() });
  const res = await r.cloud.app.inject({
    method: 'POST',
    url: '/api/sync/claim',
    remoteAddress: `10.8.${(ipN >> 8) & 255}.${ipN & 255}`,
    payload: { boxId, claim, publicJwk: generateSyncKeyPair().publicJwk } as Record<string, unknown>,
  });
  expect(res.statusCode, res.body).toBe(200);
  const j = res.json() as { surauId: string; siteToken: string };
  return { boxId, surauId: j.surauId, siteToken: j.siteToken };
}

const snapshot = (r: Rig, token: string) => r.cloud.app.inject({ method: 'GET', url: '/api/sync/snapshot', headers: { authorization: `Bearer ${token}` } });
const phone = (r: Rig, headers: Record<string, string>) => r.cloud.app.inject({ method: 'GET', url: '/api/settings', headers });

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
const row = (db: DatabaseSync, id: string): Record<string, unknown> => db.prepare('SELECT * FROM suraus WHERE id = ?').get(id) as Record<string, unknown>;

describe('surau registry', () => {
  it('createSurau mints an id, trims the name, starts as Menunggu MAXCOM and logs the actor; getSurau and listSuraus show it', () => {
    const r = rig();
    seedPilot(r.db);
    const a = createSurau(r.db, { name: '  Surau Nur  ', kind: 'surau', location: 'Kajang', zone: 'SGR01' }, 'tester');
    const b = createSurau(r.db, { name: 'Surau Nur' }, 'tester');
    expect(a.id).toMatch(SURAU_ID_RE);
    expect(b.id).toMatch(SURAU_ID_RE);
    expect(new Set(['sdm', a.id, b.id]).size, 'ids are distinct and never the pilot').toBe(3);
    expect(a.name).toBe('Surau Nur');
    expect(a.status).toBe('Menunggu MAXCOM');
    expect(row(r.db, a.id)).toMatchObject({ name: 'Surau Nur', location: 'Kajang', zone: 'SGR01', linked_at: null, created_by: 'tester' });
    expect(r.db.prepare("SELECT surau_id, actor FROM change_log WHERE entity = 'surau' AND entity_id = ?").get(a.id)).toMatchObject({ surau_id: a.id, actor: 'tester' });

    const got = getSurau(r.db, a.id)!;
    expect(got).toMatchObject({ id: a.id, name: 'Surau Nur', status: 'Menunggu MAXCOM', boxes: [] });
    expect(getSurau(r.db, 'sdm')!.boxes).toMatchObject([{ boxId: PILOT_BOX, name: 'Surau Perintis Contoh', role: 'primary', revoked: false }]);
    expect(getSurau(r.db, 'sdm')!.status).not.toBe('Menunggu MAXCOM');
    const ids = listSuraus(r.db).map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['sdm', a.id, b.id]));
    expect(getSurau(r.db, 'tiada-surau-ini')).toBeNull();
  });

  it('createSurau refuses an empty name and writes nothing', () => {
    const r = rig();
    const n = count(r.db, 'SELECT COUNT(*) AS n FROM suraus');
    expect(() => createSurau(r.db, { name: '   ' }, 'tester')).toThrow();
    expect(() => createSurau(r.db, { name: '' }, 'tester')).toThrow();
    expect(count(r.db, 'SELECT COUNT(*) AS n FROM suraus')).toBe(n);
  });

  it('a linked surau leaves Menunggu MAXCOM and shows its box; a revoked box shows as revoked and the surau stays', async () => {
    const r = rig();
    const a = await autoLink(r, 'Surau Bukit');
    const s = getSurau(r.db, a.surauId)!;
    expect(s.status).not.toBe('Menunggu MAXCOM');
    expect(s.name).toBe('Surau Bukit');
    expect(s.boxes).toMatchObject([{ boxId: a.boxId, role: 'primary', revoked: false }]);

    const gone = await cli(r, ['cloud-revoke', '--box-id', a.boxId]);
    expect(gone.code, gone.err).toBe(0);
    expect((await snapshot(r, a.siteToken)).statusCode).toBe(401);
    const after = getSurau(r.db, a.surauId)!;
    expect(after.boxes).toMatchObject([{ boxId: a.boxId, revoked: true }]);
    expect(row(r.db, a.surauId).name, 'the surau is not deleted').toBe('Surau Bukit');
    expect(count(r.db, "SELECT COUNT(*) AS n FROM change_log WHERE entity = 'site' AND entity_id = ? AND actor = 'local'", a.boxId) >= 1).toBe(true);
  });

  it('cloud-revoke refuses an unknown box and a missing id, and changes nothing', async () => {
    const r = rig();
    const a = await autoLink(r);
    const logBefore = count(r.db, 'SELECT COUNT(*) AS n FROM change_log');
    const bad = await cli(r, ['cloud-revoke', '--box-id', 'ffffffffffffffff']);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('not_found');
    const none = await cli(r, ['cloud-revoke']);
    expect(none.code).toBe(1);
    expect(none.err).toContain('bad_args');
    expect((await snapshot(r, a.siteToken)).statusCode).toBe(200);
    expect(count(r.db, 'SELECT COUNT(*) AS n FROM change_log')).toBe(logBefore);
    // a second revoke of the same box is refused too, and the first one is the only change
    expect((await cli(r, ['cloud-revoke', '--box-id', a.boxId])).code).toBe(0);
    const twice = await cli(r, ['cloud-revoke', '--box-id', a.boxId]);
    expect(twice.code).toBe(1);
    expect(twice.err).toContain('not_linked');
    expect(count(r.db, "SELECT COUNT(*) AS n FROM change_log WHERE entity = 'site' AND entity_id = ?", a.boxId)).toBeGreaterThan(0);
    expect(count(r.db, 'SELECT COUNT(*) AS n FROM change_log')).toBe(logBefore + 1);
  });

  it('cloud-suraus lists every surau with its status and its boxes', async () => {
    const r = rig();
    seedPilot(r.db);
    const a = await autoLink(r, 'Surau Lembah');
    const waiting = createSurau(r.db, { name: 'Surau Menunggu Kotak' }, 'tester');
    const b = await autoLink(r, 'Surau Tebing');
    expect((await cli(r, ['cloud-revoke', '--box-id', b.boxId])).code).toBe(0);
    const res = await cli(r, ['cloud-suraus']);
    expect(res.code, res.err).toBe(0);
    for (const s of ['sdm', 'Surau Perintis Contoh', PILOT_BOX, a.surauId, 'Surau Lembah', a.boxId, waiting.id, 'Surau Menunggu Kotak', 'Menunggu MAXCOM', b.surauId, b.boxId]) {
      expect(res.out).toContain(s);
    }
    const bLine = res.out.split('\n').filter((l) => l.includes(b.boxId)).join('\n');
    expect(bLine).toContain('dibatalkan');
    expect(res.out.split('\n').filter((l) => l.includes(a.boxId)).join('\n')).not.toContain('dibatalkan');
  });
});

describe('suspend, unsuspend (a suspended surau is shut out of the cloud)', () => {
  it('surau-suspend answers 403 surau_suspended to its site and its phones, spares every other surau, and surau-unsuspend lifts it', async () => {
    const r = rig();
    seedPilot(r.db);
    const a = await autoLink(r, 'Surau Satu');
    const b = await autoLink(r, 'Surau Dua');
    const phoneA = await loginAs(r.cloud.app, 'admin', TEST_PIN, a.surauId);
    const phoneB = await loginAs(r.cloud.app, 'admin', TEST_PIN, b.surauId);
    const pilotBefore = pilotRows(r.db);
    // baseline: everyone is in
    expect((await snapshot(r, a.siteToken)).statusCode).toBe(200);
    expect((await phone(r, phoneA.headers)).statusCode).toBe(200);

    const sus = await cli(r, ['surau-suspend', '--surau', a.surauId, '--reason', 'Penyalahgunaan awan']);
    expect(sus.code, sus.err).toBe(0);
    expect(row(r.db, a.surauId)).toMatchObject({ suspended_reason: 'Penyalahgunaan awan' });
    expect(typeof row(r.db, a.surauId).suspended_at).toBe('string');
    expect(getSurau(r.db, a.surauId)!.status).not.toBe(getSurau(r.db, b.surauId)!.status);
    expect(r.db.prepare("SELECT actor FROM change_log WHERE entity = 'surau' AND entity_id = ? ORDER BY id DESC").get(a.surauId)).toMatchObject({ actor: 'local' });

    const site = await snapshot(r, a.siteToken);
    expect(site.statusCode).toBe(403);
    expect(site.json().code).toBe('surau_suspended');
    const ph = await phone(r, phoneA.headers);
    expect(ph.statusCode).toBe(403);
    expect(ph.json().code).toBe('surau_suspended');
    // the others do not notice
    expect((await snapshot(r, b.siteToken)).statusCode).toBe(200);
    expect((await phone(r, phoneB.headers)).statusCode).toBe(200);
    // compared before the pilot's own call, which stamps its `last_seen_at`
    expect(pilotRows(r.db)).toBe(pilotBefore);
    expect((await snapshot(r, 'pilot-token')).statusCode).toBe(200);

    const lift = await cli(r, ['surau-unsuspend', '--surau', a.surauId]);
    expect(lift.code, lift.err).toBe(0);
    expect(row(r.db, a.surauId)).toMatchObject({ suspended_at: null, suspended_reason: null });
    expect((await snapshot(r, a.siteToken)).statusCode).toBe(200);
    expect((await phone(r, phoneA.headers)).statusCode).toBe(200);
  });

  it('surau-suspend needs a reason and a real surau; surau-unsuspend needs a real surau; nothing changes on refusal', async () => {
    const r = rig();
    const a = await autoLink(r);
    const before = JSON.stringify(row(r.db, a.surauId));
    const logBefore = count(r.db, "SELECT COUNT(*) AS n FROM change_log WHERE entity = 'surau'");
    for (const [args, word] of [
      [['surau-suspend', '--surau', a.surauId], 'bad_args'],
      [['surau-suspend', '--surau', a.surauId, '--reason', '   '], 'bad_args'],
      [['surau-suspend', '--surau', 'tiada-surau-ini', '--reason', 'x'], 'surau_not_found'],
      [['surau-unsuspend', '--surau', 'tiada-surau-ini'], 'surau_not_found'],
      [['surau-suspend', '--reason', 'x'], 'bad_args'],
      [['surau-unsuspend'], 'bad_args'],
    ] as [string[], string][]) {
      const res = await cli(r, args);
      expect(res.code, args.join(' ')).toBe(1);
      expect(res.err, args.join(' ')).toContain(word);
    }
    expect(JSON.stringify(row(r.db, a.surauId))).toBe(before);
    expect(count(r.db, "SELECT COUNT(*) AS n FROM change_log WHERE entity = 'surau'")).toBe(logBefore);
    expect(row(r.db, a.surauId).suspended_at ?? null).toBeNull();
    expect((await snapshot(r, a.siteToken)).statusCode).toBe(200);
  });

  it('revoking the box of a surau leaves its phones working, and the surau can take another box afterwards', async () => {
    const r = rig();
    const a = await autoLink(r, 'Surau Tiga');
    const ph = await loginAs(r.cloud.app, 'admin', TEST_PIN, a.surauId);
    expect((await cli(r, ['cloud-revoke', '--box-id', a.boxId])).code).toBe(0);
    expect((await snapshot(r, a.siteToken)).statusCode).toBe(401);
    expect((await phone(r, ph.headers)).statusCode, 'phones keep their access').toBe(200);

    // the surau is free again: a new box can be put into it by hand
    boxN += 1;
    const next = String(boxN).padStart(16, '0');
    const claim = randomBytes(32).toString('hex');
    r.worker.regs.set(next, { claimHash: sha256hex(claim), name: 'Kotak Baharu', at: new Date(r.clock).toISOString() });
    const ok = await cli(r, ['cloud-approve', '--box-id', next, '--surau', a.surauId]);
    expect(ok.code, ok.err).toBe(0);
    const res = await r.cloud.app.inject({
      method: 'POST',
      url: '/api/sync/claim',
      remoteAddress: '10.8.250.1',
      payload: { boxId: next, claim, publicJwk: generateSyncKeyPair().publicJwk } as Record<string, unknown>,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().surauId).toBe(a.surauId);
  });
});

describe('storage limit per surau (decision 24)', () => {
  /** A header-valid MP3 of the given size, distinct per `seed`. */
  const mp3 = (bytes: number, seed: number): Buffer => {
    const b = Buffer.alloc(bytes);
    b.write('ID3', 0, 'ascii');
    b.writeUInt32BE(seed, 16);
    return b;
  };
  const put = (r: Rig, token: string, buf: Buffer) =>
    r.cloud.app.inject({
      method: 'PUT',
      url: `/api/sync/assets/${sha256hex(buf)}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/mpeg' },
      payload: buf,
    });
  const setLimit = (r: Rig, id: string, bytes: number | null): void => {
    r.db.prepare('UPDATE suraus SET storage_limit_bytes = ? WHERE id = ?').run(bytes, id);
  };

  it('the default limit is 2 GB; an upload past a surau\'s limit is storage_full, counted per surau, and an asset already stored is still 200', async () => {
    const r = rig();
    const a = await autoLink(r, 'Surau Satu');
    const b = await autoLink(r, 'Surau Dua');
    expect(getSurau(r.db, a.surauId)!.storageLimitBytes).toBe(2 * GIB);
    setLimit(r, a.surauId, 10_000);
    setLimit(r, b.surauId, 10_000);
    expect(getSurau(r.db, a.surauId)!.storageLimitBytes).toBe(10_000);

    const first = mp3(6_000, 1);
    expect((await put(r, a.siteToken, first)).statusCode).toBe(201);
    const over = await put(r, a.siteToken, mp3(6_000, 2));
    expect(over.statusCode).toBe(413);
    expect(over.json().code).toBe('storage_full');
    expect(JSON.stringify(over.json())).toContain('Storan awan surau penuh');
    expect(count(r.db, 'SELECT COUNT(*) AS n FROM assets WHERE id = ?', sha256hex(mp3(6_000, 2))), 'nothing stored on refusal').toBe(0);
    // what a surau already holds is a plain 200 even when it is full
    expect((await put(r, a.siteToken, first)).statusCode).toBe(200);
    // a smaller one that fits is accepted
    expect((await put(r, a.siteToken, mp3(3_000, 3))).statusCode).toBe(201);
    // counted per surau: B is empty, the same sized asset goes in
    expect((await put(r, b.siteToken, mp3(6_000, 4))).statusCode).toBe(201);
  });

  it('a surau at the default limit (null) is not stopped by a small upload', async () => {
    const r = rig();
    const a = await autoLink(r);
    setLimit(r, a.surauId, null);
    expect((await put(r, a.siteToken, mp3(6_000, 9))).statusCode).toBe(201);
  });

  it('surau-limit --gb raises one surau\'s limit (bytes = n * 1024^3) and the refused upload then fits; bad values change nothing', async () => {
    const r = rig();
    const a = await autoLink(r, 'Surau Satu');
    const b = await autoLink(r, 'Surau Dua');
    setLimit(r, a.surauId, 10_000);
    const big = mp3(12_000, 5);
    expect((await put(r, a.siteToken, big)).statusCode).toBe(413);

    const ok = await cli(r, ['surau-limit', '--surau', a.surauId, '--gb', '3']);
    expect(ok.code, ok.err).toBe(0);
    expect(row(r.db, a.surauId).storage_limit_bytes).toBe(3 * GIB);
    expect(row(r.db, b.surauId).storage_limit_bytes ?? null, 'only that surau').toBeNull();
    expect(getSurau(r.db, a.surauId)!.storageLimitBytes).toBe(3 * GIB);
    expect((await put(r, a.siteToken, big)).statusCode).toBe(201);
    expect(r.db.prepare("SELECT actor FROM change_log WHERE entity = 'surau' AND entity_id = ? ORDER BY id DESC").get(a.surauId)).toMatchObject({ actor: 'local' });

    const logBefore = count(r.db, "SELECT COUNT(*) AS n FROM change_log WHERE entity = 'surau'");
    for (const bad of ['0', '-1', 'abc', '', '1e3', '0.0']) {
      const res = await cli(r, ['surau-limit', '--surau', a.surauId, '--gb', bad]);
      expect(res.code, `--gb ${JSON.stringify(bad)}`).toBe(1);
      expect(res.err, `--gb ${JSON.stringify(bad)}`).toContain('bad_args');
    }
    const unknown = await cli(r, ['surau-limit', '--surau', 'tiada-surau-ini', '--gb', '1']);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('surau_not_found');
    const noSurau = await cli(r, ['surau-limit', '--gb', '1']);
    expect(noSurau.code).toBe(1);
    expect(noSurau.err).toContain('bad_args');
    expect(row(r.db, a.surauId).storage_limit_bytes).toBe(3 * GIB);
    expect(row(r.db, b.surauId).storage_limit_bytes ?? null).toBeNull();
    expect(count(r.db, "SELECT COUNT(*) AS n FROM change_log WHERE entity = 'surau'")).toBe(logBefore);
  });

  it('finance photos are refused past the surau\'s limit with the same text, and another surau is not affected', () => {
    const r = rig();
    seedPilot(r.db);
    const x = createSurau(r.db, { name: 'Surau Foto X' }, 'tester');
    const y = createSurau(r.db, { name: 'Surau Foto Y' }, 'tester');
    setLimit(r, x.id, 10_000);
    setLimit(r, y.id, 10_000);
    const at = new Date(r.clock);
    const dir = r.cloud.dir;
    const first = jpeg(6_000, 640, 480);
    expect(putPhoto(r.db, dir, first, 'e1', 'tester', at, undefined, x.id).present).toBe(true);
    let caught: unknown;
    try {
      putPhoto(r.db, dir, jpeg(6_001, 640, 480), 'e2', 'tester', at, undefined, x.id);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PhotoError);
    expect((caught as PhotoError).status).toBe(413);
    expect((caught as PhotoError).errors.join(' ')).toContain('Storan awan surau penuh');
    expect(count(r.db, 'SELECT COUNT(*) AS n FROM finance_photos WHERE surau_id = ?', x.id)).toBe(1);
    // the same bytes already held are returned, not refused
    expect(putPhoto(r.db, dir, first, 'e1', 'tester', at, undefined, x.id).present).toBe(true);
    // per surau: Y and the pilot take their own
    expect(putPhoto(r.db, dir, jpeg(6_002, 640, 480), 'e3', 'tester', at, undefined, y.id).present).toBe(true);
    expect(putPhoto(r.db, dir, jpeg(6_003, 640, 480), 'e4', 'tester', at, undefined, 'sdm').present).toBe(true);
  });
});

describe('the pilot surau is untouched by all of this', () => {
  it('registry, automatic links, suspend, limit and revoke on other suraus leave every pilot row equal', async () => {
    const r = rig();
    seedPilot(r.db);
    const before = pilotRows(r.db);
    const a = await autoLink(r, 'Surau Lain');
    createSurau(r.db, { name: 'Surau Dicipta' }, 'tester');
    expect((await cli(r, ['surau-suspend', '--surau', a.surauId, '--reason', 'ujian'])).code).toBe(0);
    expect((await cli(r, ['surau-unsuspend', '--surau', a.surauId])).code).toBe(0);
    expect((await cli(r, ['surau-limit', '--surau', a.surauId, '--gb', '1'])).code).toBe(0);
    expect((await cli(r, ['cloud-revoke', '--box-id', a.boxId])).code).toBe(0);
    expect((await cli(r, ['cloud-suraus'])).code).toBe(0);
    expect(pilotRows(r.db)).toBe(before);
    expect((await snapshot(r, 'pilot-token')).statusCode).toBe(200);
    expect(getSurau(r.db, 'sdm')!.boxes).toMatchObject([{ boxId: PILOT_BOX, revoked: false }]);
  });
});

describe('controller additions: the storage limit on the device asset op; catch-up uploads outside it', () => {
  const mp3b = (bytes: number, seed: number): Buffer => {
    const b = Buffer.alloc(bytes);
    b.write('ID3', 0, 'ascii');
    b.writeUInt32BE(seed, 16);
    return b;
  };
  let opN = 0;
  const assetOp = (buf: Buffer): VerifiedOp => {
    opN += 1;
    return {
      v: 1,
      opId: `OPSTOR${String(opN).padStart(20, '0')}`,
      surauId: 'sdm',
      boxId: 'box1',
      deviceId: 'dev-a',
      userId: 'u1',
      kind: 'asset.put',
      entity: 'asset',
      entityId: `a${opN}`,
      baseRev: null,
      editedAt: '2026-11-12T08:00:00.000Z',
      payload: { mime: 'audio/mpeg', bytesBase64: buf.toString('base64') },
      sig: 'x',
      userName: 'Ali',
    } as VerifiedOp;
  };

  it('a phone asset.put op is counted per surau and refused (too_large on the wire, nothing stored) past the limit', () => {
    const r = rig();
    const x = createSurau(r.db, { name: 'Surau Op X' }, 'tester');
    const y = createSurau(r.db, { name: 'Surau Op Y' }, 'tester');
    r.db.prepare('UPDATE suraus SET storage_limit_bytes = 10000 WHERE id IN (?, ?)').run(x.id, y.id);
    const ctx = (surauId: string) => ({ surauId, now: new Date(r.clock), origin: 'app' as const, actor: 'user:u1', dataDir: r.cloud.dir, role: 'cloud' as const });
    const first = mp3b(6_000, 11);
    expect(applyOp(r.db, assetOp(first), ctx(x.id))).toMatchObject({ status: 'applied' });
    const over = mp3b(6_000, 12);
    expect(applyOp(r.db, assetOp(over), ctx(x.id))).toMatchObject({ status: 'refused', reason: 'too_large' });
    expect(count(r.db, 'SELECT COUNT(*) AS n FROM assets WHERE id = ?', sha256hex(over)), 'nothing stored').toBe(0);
    expect(count(r.db, 'SELECT COUNT(*) AS n FROM surau_assets WHERE surau_id = ?', x.id)).toBe(1);
    // what X holds is still a plain repeat; Y has its own room, the same bytes go in
    expect(applyOp(r.db, assetOp(first), ctx(x.id)).status).toBe('duplicate');
    expect(applyOp(r.db, assetOp(over), ctx(y.id))).toMatchObject({ status: 'applied' });
    // the bytes X was refused are now on the cloud (Y's), but they are still not X's: X stays full
    expect(applyOp(r.db, assetOp(over), ctx(x.id))).toMatchObject({ status: 'refused', reason: 'too_large' });
    expect(getSurau(r.db, x.id)!.storageUsedBytes).toBe(6_000);
    expect(getSurau(r.db, y.id)!.storageUsedBytes).toBe(6_000);
    // a database with no suraus row for the id (a box) keeps its old behaviour
    expect(applyOp(r.db, assetOp(mp3b(6_000, 13)), ctx('tiada-surau-ini'))).toMatchObject({ status: 'applied' });
  });

  it('qs-gate S1: a low cloud data disk refuses new uploads storage_full (asset op, site asset, finance photo); held repeats pass; read once a minute', async () => {
    const r = rig();
    const a = await autoLink(r, 'Surau Cakera');
    const x = createSurau(r.db, { name: 'Surau Cakera X' }, 'tester');
    const GB = 1024 ** 3;
    const sitePut = (token: string, buf: Buffer) =>
      r.cloud.app.inject({ method: 'PUT', url: `/api/sync/assets/${sha256hex(buf)}`, headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/mpeg' }, payload: buf });
    let free = 100 * GB;
    let reads = 0;
    let t = 0;
    enableCloudDiskGuard(r.cloud.dir, () => {
      reads += 1;
      return { freeBytes: free, totalBytes: 200 * GB };
    }, () => t);
    cleanups.push(() => disableCloudDiskGuard());
    const ctx = (surauId: string) => ({ surauId, now: new Date(r.clock), origin: 'app' as const, actor: 'user:u1', dataDir: r.cloud.dir, role: 'cloud' as const });
    const held = mp3b(5_000, 21);
    // plenty of room: everything goes in (success path)
    expect(applyOp(r.db, assetOp(held), ctx(x.id))).toMatchObject({ status: 'applied' });
    expect((await sitePut(a.siteToken, mp3b(5_000, 22))).statusCode).toBe(201);
    expect(putPhoto(r.db, r.cloud.dir, jpeg(5_000, 640, 480), 'd1', 'tester', new Date(r.clock), undefined, x.id).present).toBe(true);
    expect(reads).toBe(1);
    // 15 GB free of 200 GB is under 10%: refused, but only once the cached reading is a minute old
    free = 15 * GB;
    expect(applyOp(r.db, assetOp(mp3b(5_000, 23)), ctx(x.id))).toMatchObject({ status: 'applied' });
    t += DISK_CHECK_TTL_MS;
    expect(applyOp(r.db, assetOp(mp3b(5_000, 24)), ctx(x.id))).toMatchObject({ status: 'refused', reason: 'too_large' });
    const site = await sitePut(a.siteToken, mp3b(5_000, 25));
    expect(site.statusCode).toBe(413);
    expect(site.json().code).toBe('storage_full');
    expect(() => putPhoto(r.db, r.cloud.dir, jpeg(5_001, 640, 480), 'd2', 'tester', new Date(r.clock), undefined, x.id)).toThrow(PhotoError);
    expect(count(r.db, 'SELECT COUNT(*) AS n FROM assets WHERE id = ?', sha256hex(mp3b(5_000, 24))), 'nothing stored').toBe(0);
    // what a surau already holds is still a plain repeat
    expect(applyOp(r.db, assetOp(held), ctx(x.id)).status).toBe('duplicate');
    expect(reads).toBe(2);
    // a 40 GB disk: the 5 GB floor is the larger; 6 GB free is allowed, 4.5 GB refused
    free = 6 * GB;
    enableCloudDiskGuard(r.cloud.dir, () => ({ freeBytes: free, totalBytes: 40 * GB }), () => t);
    expect(applyOp(r.db, assetOp(mp3b(5_000, 26)), ctx(x.id))).toMatchObject({ status: 'applied' });
    free = 4.5 * GB;
    enableCloudDiskGuard(r.cloud.dir, () => ({ freeBytes: free, totalBytes: 40 * GB }), () => t);
    expect(applyOp(r.db, assetOp(mp3b(5_000, 27)), ctx(x.id))).toMatchObject({ status: 'refused', reason: 'too_large' });
    // an unreadable disk refuses nothing
    enableCloudDiskGuard(r.cloud.dir, () => null, () => t);
    expect(applyOp(r.db, assetOp(mp3b(5_000, 28)), ctx(x.id))).toMatchObject({ status: 'applied' });
  });

  it('catch-up uploads never count (decision 25): a large begin succeeds for a surau already at its limit', async () => {
    const g = await startFakeGoogle();
    cleanups.push(() => g.close());
    const up = withUploadApi(g);
    let t = Date.parse('2026-11-05T11:00:00.000Z');
    up.snippet = () => ({ publishedAt: new Date(t + 1000).toISOString(), channelId: 'UC-surau' });
    const cloud = buildCloud('0c10ad00000000cc', { now: () => new Date(t), fetchImpl: up.fetchImpl });
    cleanups.push(() => cloud.close());
    const app = cloud.app;
    const db = app.surau.db;
    mkdirSync(join(cloud.dir, 'secret'), { recursive: true });
    writeFileSync(join(cloud.dir, 'secret', 'youtube-client.json'), JSON.stringify({ client_id: 'cid-123.apps.googleusercontent.com', client_secret: 'csecret-SECRET' }));
    const admin = await loginAs(app, 'admin');
    expect((await app.inject({ method: 'POST', url: '/api/live/youtube/signin', headers: admin.headers })).statusCode).toBe(200);
    g.approve = true;
    t += 6000;
    expect((await app.inject({ method: 'POST', url: '/api/live/youtube/signin/poll', headers: admin.headers })).json()).toMatchObject({ signedIn: true });
    const pen = putItem(db, 'penceramah', { name: 'Ustaz Ahmad' }, 'test', undefined, 'sdm');
    const kuliah = putItem(db, 'kuliah', { date: '2026-11-05', slot: 'maghrib', time: '19:15', label: 'Kuliah Maghrib', penceramahId: pen.item.id, topic: 'Bab Solat', status: 'aktif' }, 'test', undefined, 'sdm');
    // the cloud's surau `sdm` has a row (as on the pilot cloud), a tiny limit, and is already full of assets
    const MIB = 1024 * 1024;
    db.prepare("INSERT INTO suraus (id, name, created_at, created_by, linked_at, storage_limit_bytes) VALUES ('sdm', 'Surau Perintis Contoh', ?, 'migration', ?, 10000)").run(
      new Date(t).toISOString(),
      new Date(t).toISOString(),
    );
    db.prepare("INSERT INTO surau_assets (surau_id, asset_id, bytes, created_at) VALUES ('sdm', ?, 9999, ?)").run('f'.repeat(64), new Date(t).toISOString());
    db.prepare("INSERT INTO sites (surau_id, box_id, name, public_jwk, token_hash, linked_at) VALUES ('sdm', 'a1b2c3d4e5f60799', 'Pilot', ?, ?, ?)").run(
      JSON.stringify(generateSyncKeyPair().publicJwk),
      sha256hex('sdm-site-token'),
      new Date(t).toISOString(),
    );
    const small = mp3b(6_000, 77);
    const putSmall = () =>
      app.inject({
        method: 'PUT',
        url: `/api/sync/assets/${sha256hex(small)}`,
        headers: { authorization: 'Bearer sdm-site-token', 'content-type': 'audio/mpeg' },
        payload: small,
      });
    // the control: the surau really is full for what the cloud stores
    const full = await putSmall();
    expect(full.statusCode).toBe(413);
    expect(full.json().code).toBe('storage_full');

    const media = await loginAs(app, 'live');
    const begin = (bytes: number) =>
      app.inject({ method: 'POST', url: '/api/youtube/upload/begin', headers: media.headers, payload: { kuliahId: kuliah.item.id, part: null, bytes, replaceLiveVideoId: null } });
    const sessions = up.sessions.length;
    const one = await begin(3 * 1024 * MIB);
    expect(one.statusCode, one.body).toBe(200);
    const two = await begin(3 * 1024 * MIB);
    expect(two.statusCode, two.body).toBe(200);
    expect(up.sessions.length).toBe(sessions + 2);
    // and the open sessions do not take the surau's room: usage is the assets only
    expect(getSurau(db, 'sdm')!.storageUsedBytes).toBe(9999);
    db.prepare("DELETE FROM surau_assets WHERE surau_id = 'sdm'").run();
    expect((await putSmall()).statusCode).toBe(201);
  });
});
