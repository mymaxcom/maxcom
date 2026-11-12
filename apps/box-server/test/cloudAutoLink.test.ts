import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { sha256hex } from '../src/auth/crypto.ts';
import { run as usersCli } from '../src/cli/users.ts';
import { putItem } from '../src/content/store.ts';
import { putFeature } from '../src/settingsStore.ts';
import { BACKOFF_MS } from '../src/sync/agent.ts';
import { autoLinkCloud, CLAIM_BACKOFF_MS, CLAIM_EVERY_MS, DEFAULT_CLOUD_URL, REG_BAD_RETRY_MS, REG_RETRY_MS, REGISTER_EVERY_MS, UNAPPROVED_WARN_MS } from '../src/sync/register.ts';
import { approveSite, CLAIM_FLUSH_WAIT_MS, createClaimHandler, revokeSite } from '../src/sync/sites.ts';
import type { WorkerOutboxSender } from '../src/sync/workerOutbox.ts';
import { CLAIM_FILE, generateSyncKeyPair, loadOrCreateClaim, loadSyncKey } from '../src/sync/syncKey.ts';
import { buildCloud, CLOUD_URL } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FakeWorker } from './support/fakeWorker.ts';
import { loginAs } from './authHelpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  vi.restoreAllMocks();
});

interface Rig {
  box: FastifyInstance;
  boxDir: string;
  boxId: string;
  cloud: TestCloud;
  worker: FakeWorker;
  /** Build the box again on the same data folder (a restart). */
  restart: () => Promise<FastifyInstance>;
  approve: (name?: string) => Promise<{ code: number; lines: string[] }>;
}

let clock = Date.parse('2026-11-12T08:00:00.000Z');
/** Move the box's clock on (by default to the next allowed claim). */
const later = (ms: number = CLAIM_EVERY_MS): void => {
  clock += ms;
};

/** An unlinked box (cloudSync on by default) whose cloud is reached only through the fake Worker. */
async function rig(): Promise<Rig> {
  const boxDir = mkdtempSync(join(tmpdir(), 'surau-autolink-'));
  let worker!: FakeWorker;
  const viaWorker = ((i: Parameters<typeof fetch>[0], n?: RequestInit) => worker.fetch(i, n)) as typeof fetch;
  const make = (): FastifyInstance =>
    buildApp(join(boxDir, 'box.db'), {
      dataDir: boxDir,
      now: () => new Date(clock),
      cloud: { url: CLOUD_URL },
      sync: { auto: false, fetchImpl: viaWorker, sleep: async () => undefined },
    });
  let box = make();
  const boxId = box.surau.boxId;
  const cloud = buildCloud(boxId, {
    workerAdmin: { url: 'https://worker.test', token: 'test-admin-token', fetchImpl: viaWorker },
    workerOutbox: { auto: false },
  });
  worker = new FakeWorker(cloud.fetch, () => clock);
  cleanups.push(async () => {
    await box.close().catch(() => undefined);
    await cloud.close();
    rmSync(boxDir, { recursive: true, force: true });
  });
  return {
    get box() {
      return box;
    },
    boxDir,
    boxId,
    cloud,
    worker,
    restart: async () => {
      await box.close();
      box = make();
      return box;
    },
    approve: async (name?: string) => {
      const lines: string[] = [];
      const code = await usersCli(
        ['--db', join(cloud.dir, 'cloud.db'), 'cloud-approve', '--box-id', boxId, ...(name ? ['--name', name] : [])],
        { workerAdmin: { url: 'https://worker.test', token: 'test-admin-token', fetchImpl: viaWorker }, out: (l) => lines.push(l), err: (l) => lines.push(l) },
      );
      return { code, lines };
    },
  } as Rig;
}

const status = async (box: FastifyInstance): Promise<Record<string, unknown>> => {
  const admin = await loginAs(box, 'admin');
  return (await box.inject({ method: 'GET', url: '/api/sync/status', headers: admin.headers })).json() as Record<string, unknown>;
};

const linkOf = (box: FastifyInstance): string => {
  const r = box.surau.db.prepare("SELECT value FROM sync_state WHERE key = 'linked'").get();
  return r?.value === '1' ? 'linked' : 'unlinked';
};

describe('automatic cloud link (T3b)', () => {
  it('an unlinked box registers, waits, is approved, claims its link and then pushes normally', async () => {
    const r = await rig();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await r.box.syncAgent!.runOnce();
    // registered with the hash of its claim secret only
    const reg = r.worker.regs.get(r.boxId);
    expect(reg).toBeDefined();
    expect(reg!.claimHash).toMatch(/^[0-9a-f]{64}$/);
    expect(reg!.name).toBe('Surau');
    expect(existsSync(join(r.boxDir, 'secret', CLAIM_FILE))).toBe(true);
    expect(linkOf(r.box)).toBe('unlinked');
    // not approved yet: the claim is refused and the box stays pending, quietly
    await r.box.syncAgent!.runOnce();
    await r.box.syncAgent!.runOnce();
    expect(r.worker.registerCalls.length, 'register at most every 6 h').toBe(1);
    expect(log.mock.calls.length, 'one line per state change').toBe(2);
    expect(r.worker.wakes).toBe(0);

    // MAXCOM sees it pending and approves it
    const pending: string[] = [];
    const cfg = { url: 'https://worker.test', token: 'test-admin-token', fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => r.worker.fetch(i, n)) as typeof fetch };
    expect(await usersCli(['--db', join(r.cloud.dir, 'cloud.db'), 'cloud-pending'], { workerAdmin: cfg, out: (l) => pending.push(l) })).toBe(0);
    expect(pending.join('\n')).toContain(r.boxId);
    expect(pending.join('\n')).toContain('Surau');
    const ok = await r.approve('Surau Al-Ikhlas');
    expect(ok.code, ok.lines.join('\n')).toBe(0);

    // the next check (claims go at most every 5 minutes) claims the link and syncs in the same go
    later();
    putItem(r.box.surau.db, 'penceramah', { id: 'p-auto', name: 'Ustaz Auto' }, 'local');
    await r.box.syncAgent!.runOnce();
    expect(linkOf(r.box)).toBe('linked');
    const key = loadSyncKey(r.boxDir)!;
    expect(key.cloudUrl).toBe(CLOUD_URL);
    expect(key.siteName).toBe('Surau Al-Ikhlas');
    expect(existsSync(join(r.boxDir, 'secret', CLAIM_FILE)), 'claim secret deleted').toBe(false);
    expect(r.worker.secrets.get(r.boxId), 'wake secret reached the Worker').toBe(key.wakeSecret);
    expect(r.worker.regs.has(r.boxId), 'pending registration removed').toBe(false);
    const row = r.cloud.app.surau.db.prepare("SELECT json FROM content_items WHERE kind = 'penceramah' AND id = 'p-auto'").get();
    expect(row, 'a normal push reached the cloud').toBeDefined();
    expect((await status(r.box)).link).toBe('linked');
    const site = r.cloud.app.surau.db.prepare('SELECT token_hash, revoked_at FROM sites WHERE box_id = ?').get(r.boxId);
    expect(site?.token_hash).toBe(sha256hex(key.siteToken));
    // the secret never reached a log line
    const claimed = r.worker.registerCalls.length;
    expect(claimed).toBe(1);
    for (const call of log.mock.calls) expect(String(call[0])).not.toMatch(/[0-9a-f]{64}/);
  });

  it('every refusal is the same 401: unapproved, wrong claim, replay; a box has no claim route', async () => {
    const r = await rig();
    await r.box.syncAgent!.runOnce();
    const claimAt = (body: unknown, ip: string) =>
      r.cloud.app.inject({ method: 'POST', url: '/api/sync/claim', remoteAddress: ip, payload: body as Record<string, unknown> });
    const pair = generateSyncKeyPair();
    const claim = loadOrCreateClaim(r.boxDir, CLOUD_URL);
    // unapproved
    const un = await claimAt({ boxId: r.boxId, claim, publicJwk: pair.publicJwk }, '10.1.0.1');
    expect(un.statusCode).toBe(401);
    expect(un.json().code).toBe('bad_claim');
    expect((await r.approve()).code).toBe(0);
    // wrong claim, malformed bodies: the same 401
    const wrong = await claimAt({ boxId: r.boxId, claim: 'f'.repeat(64), publicJwk: pair.publicJwk }, '10.1.0.2');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual(un.json());
    expect((await claimAt({ boxId: r.boxId, claim }, '10.1.0.3')).statusCode).toBe(401);
    expect((await claimAt({ boxId: 'nothex', claim, publicJwk: pair.publicJwk }, '10.1.0.4')).statusCode).toBe(401);
    // the right one works (a replay within 24 hours is the lost-answer recovery, see F9 below)
    const good = await claimAt({ boxId: r.boxId, claim, publicJwk: pair.publicJwk }, '10.1.0.5');
    expect(good.statusCode).toBe(200);
    expect(typeof good.json().siteToken).toBe('string');
    r.cloud.app.surau.db.prepare('UPDATE site_approvals SET claimed_at = ? WHERE box_id = ?').run(new Date(Date.now() - 25 * 3_600_000).toISOString(), r.boxId);
    const replay = await claimAt({ boxId: r.boxId, claim, publicJwk: pair.publicJwk }, '10.1.0.6');
    expect(replay.statusCode).toBe(401);
    // a re-approval of a live site is refused: re-linking needs a revoke first
    const again = await r.approve();
    expect(again.code).toBe(1);
    // bounded body
    expect((await claimAt({ boxId: r.boxId, claim, publicJwk: pair.publicJwk, pad: 'x'.repeat(3000) }, '10.1.0.7')).statusCode).toBe(413);
    // the box has no such route
    expect((await r.box.inject({ method: 'POST', url: '/api/sync/claim', payload: { boxId: r.boxId, claim } })).statusCode).toBe(404);
  });

  it('the claim route is rate limited per address', async () => {
    const r = await rig();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await r.cloud.app.inject({ method: 'POST', url: '/api/sync/claim', remoteAddress: '10.2.0.1', payload: { boxId: r.boxId, claim: 'a'.repeat(64) } })).statusCode);
    }
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it('cloud-revoke-site withdraws a pending approval', async () => {
    const r = await rig();
    await r.box.syncAgent!.runOnce();
    expect((await r.approve()).code).toBe(0);
    const lines: string[] = [];
    expect(await usersCli(['--db', join(r.cloud.dir, 'cloud.db'), 'cloud-revoke-site', r.boxId], { out: (l) => lines.push(l) })).toBe(0);
    expect(lines[0]).toContain('dibatalkan');
    later();
    await r.box.syncAgent!.runOnce();
    expect(linkOf(r.box)).toBe('unlinked');
    expect((await status(r.box)).link).toBe('pending');
  });

  it('a sleeping VM: the claim gets 503, nothing is woken, the agent backs off, and links once the VM is up', async () => {
    const r = await rig();
    await r.box.syncAgent!.runOnce();
    expect((await r.approve()).code).toBe(0);
    r.worker.vm = 'down';
    r.box.syncAgent!.start();
    later();
    await r.box.syncAgent!.runOnce();
    expect(linkOf(r.box)).toBe('unlinked');
    expect(r.worker.wakes).toBe(0);
    expect(r.box.syncAgent!.nextDelayMs).toBe(BACKOFF_MS[0]);
    expect(r.box.syncAgent!.status().lastError, 'a sleeping cloud is not an error').toBeNull();
    r.worker.vm = 'up';
    later();
    await r.box.syncAgent!.runOnce();
    expect(linkOf(r.box)).toBe('linked');
    r.box.syncAgent!.stop();
  });

  it('a restart keeps the claim secret: the second run does not re-register and its claim matches', async () => {
    const r = await rig();
    await r.box.syncAgent!.runOnce();
    const first = r.worker.regs.get(r.boxId)!.claimHash;
    const box2 = await r.restart();
    await box2.syncAgent!.runOnce();
    expect(r.worker.registerCalls.length).toBe(1);
    expect(sha256hex(loadOrCreateClaim(r.boxDir, CLOUD_URL))).toBe(first);
    expect((await r.approve()).code).toBe(0);
    later();
    await box2.syncAgent!.runOnce();
    expect(linkOf(box2)).toBe('linked');
  });

  it('registers again after 6 hours while still unlinked; a squatted id is reported once, retried every 15 minutes and left to MAXCOM', async () => {
    const r = await rig();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    r.worker.regs.set(r.boxId, { claimHash: 'c'.repeat(64), name: 'squatter', at: 'x' });
    await r.box.syncAgent!.runOnce();
    const squatLines = (): number => log.mock.calls.filter((c) => String(c[0]).includes('another registration')).length;
    expect(squatLines()).toBe(1);
    expect(r.box.surau.db.prepare("SELECT value FROM sync_state WHERE key = 'autolink_reg_at'").get(), 'a 409 is not a registration').toBeUndefined();
    later(REG_RETRY_MS - 1);
    await r.box.syncAgent!.runOnce();
    expect(r.worker.registerCalls.length).toBe(1);
    later(1);
    await r.box.syncAgent!.runOnce();
    expect(r.worker.registerCalls.length, 'a 409 is retried after 15 minutes').toBe(2);
    expect(squatLines(), 'logged once, not on every try').toBe(1);
    // the operator deletes the bad entry; the real box registers itself at its next try
    r.worker.regs.delete(r.boxId);
    later(REG_RETRY_MS);
    await r.box.syncAgent!.runOnce();
    expect(r.worker.registerCalls.length).toBe(3);
    expect(r.worker.regs.get(r.boxId)!.claimHash).toBe(sha256hex(loadOrCreateClaim(r.boxDir, CLOUD_URL)));
    // then every 6 hours while still unlinked
    later(REGISTER_EVERY_MS - 1);
    await r.box.syncAgent!.runOnce();
    expect(r.worker.registerCalls.length).toBe(3);
    later(1);
    await r.box.syncAgent!.runOnce();
    expect(r.worker.registerCalls.length).toBe(4);
  });

  it('cloudSync off: no registration, link off', async () => {
    const r = await rig();
    putFeature(r.box.surau.db, 'cloudSync', { enabled: false }, 'local');
    await r.box.syncAgent!.runOnce();
    expect(r.worker.registerCalls.length).toBe(0);
    expect((await status(r.box)).link).toBe('off');
  });

  it('cloud-approve needs a registration and a name; approveSite binds to the hash', async () => {
    const r = await rig();
    const missing = await r.approve('X');
    expect(missing.code).toBe(1);
    expect(missing.lines.join(' ')).toContain('belum mendaftar');
    expect(() => approveSite({ db: r.cloud.app.surau.db, now: () => new Date() }, { boxId: r.boxId, name: 'x', claimHash: 'nothex' })).toThrow();
    expect(revokeSite({ db: r.cloud.app.surau.db, now: () => new Date() }, r.boxId)).toBe(false);
  });

  it('the cloud address: override, else the setting, else MAXCOM; https only; a new origin gets a new claim secret', () => {
    expect(autoLinkCloud('https://a.example/', 'https://b.example')).toBe('https://a.example');
    expect(autoLinkCloud(null, 'https://b.example')).toBe('https://b.example');
    expect(autoLinkCloud(null, 'http://b.example', {})).toBe(DEFAULT_CLOUD_URL);
    expect(autoLinkCloud('', '', {})).toBe(DEFAULT_CLOUD_URL);
    const dir = mkdtempSync(join(tmpdir(), 'surau-claim-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const a = loadOrCreateClaim(dir, 'https://a.example');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(loadOrCreateClaim(dir, 'https://a.example')).toBe(a);
    expect(loadOrCreateClaim(dir, 'https://b.example')).not.toBe(a);
  });

  it('health names the linked cloud origin as `cloud`, in the public and the full answer; the sync block is `sync`', async () => {
    const r = await rig();
    const admin = await loginAs(r.box, 'admin');
    const pub0 = (await r.box.inject({ method: 'GET', url: '/api/health' })).json();
    expect(pub0.cloud).toBeUndefined();
    const full0 = (await r.box.inject({ method: 'GET', url: '/api/health', headers: admin.headers })).json();
    expect(full0.cloud).toBeUndefined();
    expect(full0.sync).toMatchObject({ linked: false, state: 'idle' });
    await r.box.syncAgent!.runOnce();
    expect((await r.approve()).code).toBe(0);
    later();
    await r.box.syncAgent!.runOnce();
    const pub = (await r.box.inject({ method: 'GET', url: '/api/health' })).json();
    expect(pub).toEqual({ ok: true, version: pub.version, cloud: CLOUD_URL });
    const full = (await r.box.inject({ method: 'GET', url: '/api/health', headers: admin.headers })).json();
    expect(full.cloud).toBe(CLOUD_URL);
    expect(full.sync).toMatchObject({ linked: true });
  });
});

describe('automatic cloud link: gate fixes', () => {
  const lines = (log: { mock: { calls: unknown[][] } }): string[] => log.mock.calls.map((c) => String(c[0]));
  const cli = (r: Rig, args: string[]) => {
    const out: string[] = [];
    const cfg = { url: 'https://worker.test', token: 'test-admin-token', fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => r.worker.fetch(i, n)) as typeof fetch };
    return usersCli(['--db', join(r.cloud.dir, 'cloud.db'), ...args], { workerAdmin: cfg, out: (l) => out.push(l), err: (l) => out.push(l) }).then((code) => ({ code, out }));
  };
  const approvals = (r: Rig): number => Number(r.cloud.app.surau.db.prepare('SELECT COUNT(*) AS n FROM site_approvals').get()?.n ?? 0);

  it('F1: an unapproved box claims at most every 5 minutes, also across a restart', async () => {
    const r = await rig();
    await r.box.syncAgent!.runOnce();
    await r.box.syncAgent!.runOnce();
    await r.box.syncAgent!.runOnce();
    expect(r.worker.claimCalls.length).toBe(1);
    later(CLAIM_EVERY_MS - 1);
    await r.box.syncAgent!.runOnce();
    expect(r.worker.claimCalls.length).toBe(1);
    later(1);
    await r.box.syncAgent!.runOnce();
    expect(r.worker.claimCalls.length).toBe(2);
    const box2 = await r.restart();
    await box2.syncAgent!.runOnce();
    expect(r.worker.claimCalls.length, 'the last try is kept across a restart').toBe(2);
    later();
    expect((await r.approve()).code).toBe(0);
    await box2.syncAgent!.runOnce();
    expect(linkOf(box2)).toBe('linked');
  });

  it('F1: a 429 on the claim backs off 15 minutes and is not read as "waiting for approval"', async () => {
    const r = await rig();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    r.worker.claimStatus = 429;
    await r.box.syncAgent!.runOnce();
    expect(r.worker.claimCalls.length).toBe(1);
    expect(lines(log).some((l) => l.includes('waiting for MAXCOM'))).toBe(false);
    later(CLAIM_EVERY_MS);
    await r.box.syncAgent!.runOnce();
    later(CLAIM_BACKOFF_MS - CLAIM_EVERY_MS - 1);
    await r.box.syncAgent!.runOnce();
    expect(r.worker.claimCalls.length).toBe(1);
    later(1);
    r.worker.claimStatus = null;
    await r.box.syncAgent!.runOnce();
    expect(r.worker.claimCalls.length, 'tried again after 15 minutes').toBe(2);
    expect(lines(log).some((l) => l.includes('waiting for MAXCOM')), 'a 401 is pending').toBe(true);
  });

  it('F1: the cloud claim limiter is per box id and address; a bad box id falls back to the address', async () => {
    const r = await rig();
    const at = (boxId: string, ip: string) =>
      r.cloud.app.inject({ method: 'POST', url: '/api/sync/claim', remoteAddress: ip, payload: { boxId, claim: 'a'.repeat(64) } }).then((x) => x.statusCode);
    const a = '0123456789abcdef';
    const b = 'fedcba9876543210';
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push(await at(a, '10.3.0.1'));
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
    expect(await at(b, '10.3.0.1'), 'another box behind the same address has its own bucket').toBe(401);
    expect(await at(a, '10.3.0.2'), 'the same box id from another address too').toBe(401);
    const bad: number[] = [];
    for (let i = 0; i < 6; i++) bad.push(await at(`bad${i}`, '10.3.0.3'));
    expect(bad).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it('F2: a registration is stamped only on 200; 429 retries after 15 minutes, 400 after 6 hours; each logged once', async () => {
    const r = await rig();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const regAt = () => r.box.surau.db.prepare("SELECT value FROM sync_state WHERE key = 'autolink_reg_at'").get();
    r.worker.registerStatus = 429;
    await r.box.syncAgent!.runOnce();
    expect(regAt()).toBeUndefined();
    later(REG_RETRY_MS - 1);
    await r.box.syncAgent!.runOnce();
    expect(r.worker.registerCalls.length).toBe(1);
    later(1);
    await r.box.syncAgent!.runOnce();
    expect(r.worker.registerCalls.length).toBe(2);
    expect(lines(log).filter((l) => l.includes('too many')).length).toBe(1);
    r.worker.registerStatus = 400;
    later(REG_RETRY_MS);
    await r.box.syncAgent!.runOnce();
    expect(r.worker.registerCalls.length).toBe(3);
    later(REG_BAD_RETRY_MS - 1);
    await r.box.syncAgent!.runOnce();
    expect(r.worker.registerCalls.length).toBe(3);
    later(1);
    await r.box.syncAgent!.runOnce();
    expect(r.worker.registerCalls.length).toBe(4);
    expect(lines(log).filter((l) => l.includes('invalid')).length).toBe(1);
    expect(regAt()).toBeUndefined();
    r.worker.registerStatus = null;
    later(REG_BAD_RETRY_MS);
    await r.box.syncAgent!.runOnce();
    expect(regAt(), 'a 200 is stamped').toBeDefined();
  });

  it('F3: the claim code (first 8 of the claimHash) shows on the box; cloud-pending prints the full hash; cloud-approve checks --code', async () => {
    const r = await rig();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect((await status(r.box)).claimCode, 'not registered yet').toBeUndefined();
    await r.box.syncAgent!.runOnce();
    const hash = sha256hex(loadOrCreateClaim(r.boxDir, CLOUD_URL));
    const code = hash.slice(0, 8);
    const st = await status(r.box);
    expect(st.link).toBe('pending');
    expect(st.claimCode).toBe(code);
    expect((await r.box.inject({ method: 'GET', url: '/api/sync/status' })).statusCode, 'status needs a login').not.toBe(200);
    expect(lines(log).filter((l) => l.includes('registered')).length).toBe(1);
    expect(lines(log).find((l) => l.includes('registered'))).toContain(code);
    const pending = await cli(r, ['cloud-pending']);
    expect(pending.out.join('\n')).toContain(hash);
    const wrong = await cli(r, ['cloud-approve', '--box-id', r.boxId, '--code', code === '00000000' ? '11111111' : '00000000']);
    expect(wrong.code).toBe(1);
    expect(wrong.out.join(' ')).toContain('Kod tuntutan tidak sepadan');
    expect(approvals(r), 'nothing stored on a wrong code').toBe(0);
    const malformed = await cli(r, ['cloud-approve', '--box-id', r.boxId, '--code', 'xyz']);
    expect(malformed.code).toBe(1);
    expect(approvals(r)).toBe(0);
    const right = await cli(r, ['cloud-approve', '--box-id', r.boxId, '--code', code.toUpperCase()]);
    expect(right.code, right.out.join('\n')).toBe(0);
    expect(approvals(r)).toBe(1);
    later();
    await r.box.syncAgent!.runOnce();
    expect(linkOf(r.box)).toBe('linked');
    expect((await status(r.box)).claimCode, 'no code once linked').toBeUndefined();
  });

  it('F5: control and format characters are stripped from the box name and from what cloud-pending shows; approve uses the cleaned name', async () => {
    const r = await rig();
    putFeature(r.box.surau.db, 'surauInfo', { name: 'Surau‮ Al​-Ikhlas⁦' }, 'test');
    await r.box.syncAgent!.runOnce();
    expect(r.worker.regs.get(r.boxId)!.name).toBe('Surau Al-Ikhlas');
    // a registration carrying such characters (an older Worker) is cleaned on the cloud side
    r.worker.regs.set(r.boxId, { ...r.worker.regs.get(r.boxId)!, name: 'Evil‮gnp.exe\u0085‍' });
    const pending = await cli(r, ['cloud-pending']);
    expect(pending.out.join('\n')).toContain('Evilgnp.exe');
    expect(pending.out.join('\n')).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect((await cli(r, ['cloud-approve', '--box-id', r.boxId])).code).toBe(0);
    expect(r.cloud.app.surau.db.prepare('SELECT name FROM site_approvals WHERE box_id = ?').get(r.boxId)?.name).toBe('Evilgnp.exe');
  });

  it('F6: one key pair per pending claim; the stored public key is the one that was sent', async () => {
    const r = await rig();
    await r.box.syncAgent!.runOnce();
    later();
    await r.box.syncAgent!.runOnce();
    expect(r.worker.claimCalls.length).toBe(2);
    expect(r.worker.claimCalls[1]!.publicJwk, 'the same pair until the claim resolves').toEqual(r.worker.claimCalls[0]!.publicJwk);
    expect((await r.approve()).code).toBe(0);
    later();
    await r.box.syncAgent!.runOnce();
    expect(linkOf(r.box)).toBe('linked');
    const sent = r.worker.claimCalls.at(-1)!.publicJwk;
    expect(sent).toEqual(r.worker.claimCalls[0]!.publicJwk);
    expect(loadSyncKey(r.boxDir)!.publicJwk).toEqual(sent);
    const site = r.cloud.app.surau.db.prepare('SELECT public_jwk FROM sites WHERE box_id = ?').get(r.boxId);
    expect(JSON.parse(String(site?.public_jwk))).toMatchObject(sent as Record<string, unknown>);
  });

  it('F7: after 24 hours of 401 the box says once how to recover, then keeps trying quietly', async () => {
    const r = await rig();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stale = () => lines(log).filter((l) => l.includes('Belum diluluskan selepas 24 jam')).length;
    await r.box.syncAgent!.runOnce();
    later(UNAPPROVED_WARN_MS - CLAIM_EVERY_MS);
    await r.box.syncAgent!.runOnce();
    expect(stale()).toBe(0);
    later(CLAIM_EVERY_MS);
    await r.box.syncAgent!.runOnce();
    expect(stale()).toBe(1);
    const line = lines(log).find((l) => l.includes('Belum diluluskan selepas 24 jam'))!;
    expect(line).toContain('Jika sudah diluluskan, jalankan cloud-revoke-site kemudian cloud-approve semula.');
    expect(line).toContain('Not approved after 24 hours');
    const before = log.mock.calls.length;
    const claims = r.worker.claimCalls.length;
    later();
    await r.box.syncAgent!.runOnce();
    later();
    await r.box.syncAgent!.runOnce();
    expect(r.worker.claimCalls.length, 'still trying').toBe(claims + 2);
    expect(log.mock.calls.length, 'quietly').toBe(before);
  });

  it('F9: a lost claim answer can be claimed again within 24 hours (the old key dies); after 24 hours or with a wrong secret it is 401', async () => {
    const r = await rig();
    await r.box.syncAgent!.runOnce();
    expect((await r.approve()).code).toBe(0);
    const claim = loadOrCreateClaim(r.boxDir, CLOUD_URL);
    const claimAt = (body: unknown, ip: string) =>
      r.cloud.app.inject({ method: 'POST', url: '/api/sync/claim', remoteAddress: ip, payload: body as Record<string, unknown> });
    const first = await claimAt({ boxId: r.boxId, claim, publicJwk: generateSyncKeyPair().publicJwk }, '10.4.0.1');
    expect(first.statusCode).toBe(200);
    const token1 = first.json().siteToken as string;
    // the answer never reached the box: it presents the same secret again
    const again = await claimAt({ boxId: r.boxId, claim, publicJwk: generateSyncKeyPair().publicJwk }, '10.4.0.2');
    expect(again.statusCode).toBe(200);
    const token2 = again.json().siteToken as string;
    expect(token2).not.toBe(token1);
    expect(again.json().wakeSecret).not.toBe(first.json().wakeSecret);
    const snap = (token: string) => r.cloud.app.inject({ method: 'GET', url: '/api/sync/snapshot', headers: { authorization: `Bearer ${token}` } }).then((x) => x.statusCode);
    expect(await snap(token2)).toBe(200);
    expect(await snap(token1), 'the previous key stops working').not.toBe(200);
    expect((await claimAt({ boxId: r.boxId, claim: 'f'.repeat(64), publicJwk: generateSyncKeyPair().publicJwk }, '10.4.0.3')).statusCode, 'wrong secret').toBe(401);
    // after 24 hours the approval is spent for good
    r.cloud.app.surau.db.prepare('UPDATE site_approvals SET claimed_at = ? WHERE box_id = ?').run(new Date(Date.now() - 24 * 3_600_000 - 1000).toISOString(), r.boxId);
    expect((await claimAt({ boxId: r.boxId, claim, publicJwk: generateSyncKeyPair().publicJwk }, '10.4.0.4')).statusCode).toBe(401);
    expect(await snap(token2), 'a refused late claim changes nothing').toBe(200);
  });

  it('F9: a revoked site cannot be claimed again with the old secret', async () => {
    const r = await rig();
    await r.box.syncAgent!.runOnce();
    expect((await r.approve()).code).toBe(0);
    const claim = loadOrCreateClaim(r.boxDir, CLOUD_URL);
    const claimAt = (ip: string) =>
      r.cloud.app.inject({ method: 'POST', url: '/api/sync/claim', remoteAddress: ip, payload: { boxId: r.boxId, claim, publicJwk: generateSyncKeyPair().publicJwk } });
    expect((await claimAt('10.5.0.1')).statusCode).toBe(200);
    expect(revokeSite({ db: r.cloud.app.surau.db, now: () => new Date() }, r.boxId)).toBe(true);
    expect((await claimAt('10.5.0.2')).statusCode).toBe(401);
  });

  it('F9: the claim answer is not held back by a slow Worker outbox', async () => {
    expect(CLAIM_FLUSH_WAIT_MS).toBeLessThanOrEqual(5_000);
    const r = await rig();
    await r.box.syncAgent!.runOnce();
    expect((await r.approve()).code).toBe(0);
    const hung = { flushKey: () => new Promise<boolean>(() => undefined) } as unknown as WorkerOutboxSender;
    const handler = createClaimHandler({ db: r.cloud.app.surau.db, now: () => new Date(), outbox: hung, flushWaitMs: 50 });
    const t0 = Date.now();
    const out = await handler({ boxId: r.boxId, claim: loadOrCreateClaim(r.boxDir, CLOUD_URL), publicJwk: generateSyncKeyPair().publicJwk });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(out.status).toBe(200);
    expect((out.body as { wakeRegistered: boolean }).wakeRegistered).toBe(false);
  });
});
