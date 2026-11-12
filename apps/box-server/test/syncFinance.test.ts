import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { klDateOf, klInstant } from '@surau/core';
import type { FeedEntry } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { runCloudLink } from '../src/cli/cloudLink.ts';
import { putFeature } from '../src/settingsStore.ts';
import { readFeed, snapshot } from '../src/sync/feed.ts';
import { applyFeedEntry } from '../src/sync/apply.ts';
import { insertReplicatedEntry, putMonthIn } from '../src/finance/store.ts';
import { issueLinkCode } from '../src/sync/sites.ts';
import { loadSyncKey } from '../src/sync/syncKey.ts';
import { verifySiteEntry } from '../src/sync/verify.ts';
import { freezeReport, reportFor } from '../src/finance/report.ts';
import { renderReportPdf } from '../src/finance/pdf.ts';
import { loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { jpeg } from './support/jpeg.ts';
import { buildCloud, CLOUD_URL } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FakeWorker } from './support/fakeWorker.ts';
import { signOp } from './support/signOp.ts';

const AT = klInstant('2026-11-10', '10:00');
const TODAY = '2026-11-10';
const apps: FastifyInstance[] = [];
const dirs: string[] = [];
const clouds: TestCloud[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const c of clouds.splice(0)) await c.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'surau-sfin-'));
  dirs.push(d);
  return d;
}

interface Rig { app: FastifyInstance; dir: string; admin: Login; treasurer: Login; ajk: Login; media: Login; fundA: string; fundB: string; perIn: string; perOut: string }

async function rig(): Promise<Rig> {
  const dir = tmp();
  const app = buildApp(join(dir, 'box.db'), { dataDir: dir, now: () => AT });
  apps.push(app);
  const admin = await loginAs(app, 'admin');
  const treasurer = await loginAs(app, 'treasurer');
  const ajk = await loginAs(app, 'ajk');
  const media = await loginAs(app, 'media');
  putFeature(app.surau.db, 'finance', { enabled: true }, 'test');
  const funds = (await app.inject({ method: 'GET', url: '/api/finance/funds', headers: treasurer.headers })).json().funds as { id: string }[];
  const per = (await app.inject({ method: 'GET', url: '/api/finance/perihal', headers: treasurer.headers })).json().perihal as { id: string; direction: string; label: string }[];
  return {
    app, dir, admin, treasurer, ajk, media, fundA: funds[0]!.id, fundB: funds[1]!.id,
    perIn: per.find((p) => p.direction === 'in')!.id, perOut: per.find((p) => p.label === 'Utiliti')!.id,
  };
}

const cash = (r: Rig, amountSen: number, extra: Record<string, unknown> = {}) => ({
  kind: 'in', entryDate: '2026-11-06', fundId: r.fundA, perihalId: r.perIn, amountSen, method: 'tunai',
  counters: [{ userId: r.treasurer.userId }, { name: 'Tuan Haji Ali' }], ...extra,
});

async function send(r: Rig, login: Login, input: Parameters<typeof signOp>[2]) {
  const op = await signOp(login, r.app.surau.boxId, input);
  const res = await r.app.inject({ method: 'POST', url: '/api/sync/ops', headers: login.headers, payload: { ops: [op] } });
  return { op, status: res.statusCode, result: (res.json().results?.[0] ?? {}) as { status: string; reason: string | null; winner: { userName: string | null } | null } };
}

const refusals = (app: FastifyInstance, like: string): number =>
  Number(app.surau.db.prepare("SELECT COUNT(*) AS n FROM auth_log WHERE event = 'sync_refused' AND detail = ?").get(like)!.n);
const rows = (app: FastifyInstance): number => Number(app.surau.db.prepare('SELECT COUNT(*) AS n FROM finance_entries').get()!.n);

describe('finance ops: who may send what', () => {
  it('a treasurer appends; an AJK, and a treasurer lookup edit, are forbidden; the admin may edit lookups; media may not send a photo', async () => {
    const r = await rig();
    const ok = await send(r, r.treasurer, { kind: 'finance.append', entity: 'finance:entry', entityId: 'e1', payload: cash(r, 135680) });
    expect(ok.result.status).toBe('applied');
    expect(r.app.surau.db.prepare("SELECT ref_no, origin, op_id, amount_sen FROM finance_entries WHERE id = 'e1'").get()).toMatchObject({ ref_no: 'K-0001', origin: 'app', op_id: ok.op.opId, amount_sen: 135680 });
    expect(Number(r.app.surau.db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'finance:entry'").get()!.n)).toBe(1);

    const ajk = await send(r, r.ajk, { kind: 'finance.append', entity: 'finance:entry', entityId: 'e2', payload: cash(r, 100) });
    expect(ajk.result).toMatchObject({ status: 'refused', reason: 'forbidden' });
    const lookup = await send(r, r.treasurer, { kind: 'finance.lookup.put', entity: 'finance:fund', entityId: 'f9', payload: { name: 'Baharu' } });
    expect(lookup.result).toMatchObject({ status: 'refused', reason: 'forbidden' });
    const adm = await send(r, r.admin, { kind: 'finance.lookup.put', entity: 'finance:fund', entityId: 'f9', payload: { name: 'Baharu', public: false } });
    expect(adm.result.status).toBe('applied');
    const photo = await send(r, r.media, { kind: 'finance.photo.put', entity: 'finance:photo', entityId: 'a'.repeat(64), payload: { bytesBase64: 'AAAA', entryId: 'e1' } });
    expect(photo.result).toMatchObject({ status: 'refused', reason: 'forbidden' });
    expect(rows(r.app)).toBe(1);
  });

  it('a new op that re-sends an entry already stored with the same body is a duplicate, not a refusal, and writes nothing', async () => {
    const r = await rig();
    expect((await send(r, r.treasurer, { kind: 'finance.append', entity: 'finance:entry', entityId: 'e1', payload: cash(r, 5000) })).result.status).toBe('applied');
    const logBefore = Number(r.app.surau.db.prepare('SELECT COUNT(*) AS n FROM change_log').get()!.n);
    const again = await send(r, r.treasurer, { kind: 'finance.append', entity: 'finance:entry', entityId: 'e1', payload: cash(r, 5000) });
    expect(again.status).toBe(200);
    expect(again.result).toMatchObject({ status: 'duplicate', reason: null });
    expect(refusals(r.app, 'apply_finance_entry_exists')).toBe(0);
    expect(Number(r.app.surau.db.prepare('SELECT COUNT(*) AS n FROM change_log').get()!.n)).toBe(logBefore);
    expect(rows(r.app)).toBe(1);
    const other = await send(r, r.treasurer, { kind: 'finance.append', entity: 'finance:entry', entityId: 'e1', payload: cash(r, 5001) });
    expect(other.result).toMatchObject({ status: 'refused', reason: 'invalid' });
  });

  it('the same op twice is applied then duplicate; another op for the same entry id is refused and the row is unchanged', async () => {
    const r = await rig();
    const first = await send(r, r.treasurer, { kind: 'finance.append', entity: 'finance:entry', entityId: 'e1', payload: cash(r, 5000) });
    expect(first.result.status).toBe('applied');
    const op = first.op;
    const again = await r.app.inject({ method: 'POST', url: '/api/sync/ops', headers: r.treasurer.headers, payload: { ops: [op] } });
    expect(again.json().results[0].status).toBe('duplicate');
    const other = await send(r, r.treasurer, { kind: 'finance.append', entity: 'finance:entry', entityId: 'e1', payload: cash(r, 9999) });
    expect(other.result).toMatchObject({ status: 'refused', reason: 'invalid' });
    expect(refusals(r.app, 'apply_finance_entry_exists')).toBe(1);
    expect(r.app.surau.db.prepare("SELECT amount_sen FROM finance_entries WHERE id = 'e1'").get()!.amount_sen).toBe(5000);
    expect(rows(r.app)).toBe(1);
  });

  it('an entry in a closed month is refused month_closed with a fixed log code; a correction dated today is accepted', async () => {
    const r = await rig();
    await send(r, r.treasurer, { kind: 'finance.append', entity: 'finance:entry', entityId: 'e1', payload: cash(r, 100, { entryDate: '2026-10-30' }) });
    expect((await send(r, r.admin, { kind: 'finance.month.put', entity: 'finance:month', entityId: '2026-10', payload: { status: 'closed' } })).result.status).toBe('applied');
    const late = await send(r, r.treasurer, { kind: 'finance.append', entity: 'finance:entry', entityId: 'e2', payload: cash(r, 100, { entryDate: '2026-10-31' }) });
    expect(late.result).toMatchObject({ status: 'refused', reason: 'month_closed' });
    expect(refusals(r.app, 'apply_finance_month_closed')).toBe(1);
    const fix = await send(r, r.treasurer, {
      kind: 'finance.append', entity: 'finance:entry', entityId: 'c1',
      payload: { kind: 'adjust', entryDate: TODAY, fundId: r.fundA, correctsId: 'e1', correctionKind: 'amount', amountSen: 90, reason: 'Salah taip jumlah: 90' },
    });
    expect(fix.result.status).toBe('applied');
    // a treasurer cannot reopen (month ops need settings:write too)
    expect((await send(r, r.treasurer, { kind: 'finance.month.put', entity: 'finance:month', entityId: '2026-10', payload: { status: 'open' } })).result).toMatchObject({ status: 'refused', reason: 'forbidden' });
  });

  it('a lookup rename from two devices: the later edit wins and the loser is superseded with the winner named', async () => {
    const r = await rig();
    const admin2 = await loginAs(r.app, 'admin');
    const early = '2026-11-09T01:00:00.000Z';
    const late = '2026-11-09T02:00:00.000Z';
    const w = await send(r, r.admin, { kind: 'finance.lookup.put', entity: 'finance:fund', entityId: 'f-two', editedAt: late, payload: { name: 'Tabung Baru Lewat', public: true, sortOrder: 2 } });
    expect(w.result.status).toBe('applied');
    const l = await send(r, admin2, { kind: 'finance.lookup.put', entity: 'finance:fund', entityId: 'f-two', editedAt: early, payload: { name: 'Tabung Baru Awal', public: true, sortOrder: 2 } });
    expect(l.result.status).toBe('superseded');
    expect(l.result.winner?.userName).toContain('admin');
    expect(r.app.surau.db.prepare('SELECT name FROM finance_funds WHERE id = ?').get('f-two')!.name).toBe('Tabung Baru Lewat');
  });

  it('a month: an older open is superseded by the close, a later open reopens', async () => {
    const r = await rig();
    const close = await send(r, r.admin, { kind: 'finance.month.put', entity: 'finance:month', entityId: '2026-10', editedAt: '2026-11-02T02:00:00.000Z', payload: { status: 'closed' } });
    expect(close.result.status).toBe('applied');
    const oldOpen = await send(r, r.admin, { kind: 'finance.month.put', entity: 'finance:month', entityId: '2026-10', editedAt: '2026-11-02T01:00:00.000Z', payload: { status: 'open' } });
    expect(oldOpen.result.status).toBe('superseded');
    expect(r.app.surau.db.prepare("SELECT status FROM finance_months WHERE ym = '2026-10'").get()!.status).toBe('closed');
    const reopen = await send(r, r.admin, { kind: 'finance.month.put', entity: 'finance:month', entityId: '2026-10', editedAt: '2026-11-03T02:00:00.000Z', payload: { status: 'open' } });
    expect(reopen.result.status).toBe('applied');
    expect(r.app.surau.db.prepare("SELECT status FROM finance_months WHERE ym = '2026-10'").get()!.status).toBe('open');
  });

  it('a photo op: a 2.1 MB payload is too_large, a PNG is invalid, a wrong hash is invalid, a JPEG writes the file and a meta-only log row', async () => {
    const r = await rig();
    const big = jpeg(2_200_000);
    const bigId = createHash('sha256').update(big).digest('hex');
    expect((await send(r, r.treasurer, { kind: 'finance.photo.put', entity: 'finance:photo', entityId: bigId, payload: { bytesBase64: big.toString('base64'), entryId: 'e1' } })).result).toMatchObject({ status: 'refused', reason: 'too_large' });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
    const pngId = createHash('sha256').update(png).digest('hex');
    expect((await send(r, r.treasurer, { kind: 'finance.photo.put', entity: 'finance:photo', entityId: pngId, payload: { bytesBase64: png.toString('base64'), entryId: 'e1' } })).result).toMatchObject({ status: 'refused', reason: 'invalid' });
    const small = jpeg(30_000);
    expect((await send(r, r.treasurer, { kind: 'finance.photo.put', entity: 'finance:photo', entityId: 'b'.repeat(64), payload: { bytesBase64: small.toString('base64'), entryId: 'e1' } })).result).toMatchObject({ status: 'refused', reason: 'invalid' });
    const id = createHash('sha256').update(small).digest('hex');
    expect((await send(r, r.treasurer, { kind: 'finance.photo.put', entity: 'finance:photo', entityId: id, payload: { bytesBase64: small.toString('base64'), entryId: 'e1' } })).result.status).toBe('applied');
    expect(existsSync(join(r.dir, 'finance', 'photos', `${id}.jpg`))).toBe(true);
    const log = r.app.surau.db.prepare("SELECT after_json FROM change_log WHERE entity = 'finance:photo'").get()!;
    expect(JSON.parse(String(log.after_json))).toEqual({ entryId: 'e1', mime: 'image/jpeg', bytes: 30_000 });
  });
});

describe('finance feed entries (replication)', () => {
  const entry = (r: Rig, over: Record<string, unknown> = {}): FeedEntry => ({
    seq: 1, entity: 'finance:entry', entityId: 'x1', rev: '2026-11-09T01:00:00.000Z|dev1', editedAt: '2026-11-09T01:00:00.000Z',
    syncedAt: '2026-11-09T01:00:01.000Z', actor: 'user:u1', deviceId: 'dev1', origin: 'app', opId: null,
    after: {
      id: 'x1', kind: 'in', entryDate: '2026-11-08', fundId: r.fundA, perihalId: r.perIn, amountSen: 50000, method: 'bank', reference: 'FPX99',
      refNo: null, createdBy: 'u1', editedAt: '2026-11-09T01:00:00.000Z', ...over,
    },
  });

  it('a cloud entry with no reference number is numbered by the box; a replay fills only a missing number and changes nothing else', async () => {
    const r = await rig();
    const ctxBox = { now: AT, origin: 'cloud', actor: 'user:u1', dataDir: r.dir, role: 'box' as const };
    expect(applyFeedEntry(r.app.surau.db, entry(r), ctxBox).status).toBe('applied');
    const row = r.app.surau.db.prepare("SELECT ref_no, amount_sen FROM finance_entries WHERE id = 'x1'").get()!;
    expect(row).toMatchObject({ ref_no: 'K-0001', amount_sen: 50000 });
    // the box's own history row for it carries the number (that is what the cloud is told)
    const logged = r.app.surau.db.prepare("SELECT after_json FROM change_log WHERE entity = 'finance:entry' AND entity_id = 'x1'").get()!;
    expect(JSON.parse(String(logged.after_json)).refNo).toBe('K-0001');
    // a replay with a DIFFERENT amount is a duplicate and the row is unchanged
    expect(applyFeedEntry(r.app.surau.db, entry(r, { amountSen: 99999, refNo: 'K-0042' }), ctxBox).status).toBe('duplicate');
    expect(r.app.surau.db.prepare("SELECT ref_no, amount_sen FROM finance_entries WHERE id = 'x1'").get()).toMatchObject({ ref_no: 'K-0001', amount_sen: 50000 });
  });

  it('on a cloud the entry is stored with no number until the box tells it; the fill changes nothing else', async () => {
    const r = await rig();
    const cloudDir = tmp();
    const cloud = buildApp(join(cloudDir, 'c.db'), { dataDir: cloudDir, role: 'cloud', now: () => AT });
    apps.push(cloud);
    const fundSql = r.app.surau.db.prepare('SELECT * FROM finance_funds').all();
    expect(fundSql.length).toBeGreaterThan(1);
    for (const f of readFeed(r.app.surau.db, 0, 500, { users: true, devices: true, keys: true, finance: true, financeWrite: true }).entries.filter((e) => e.entity === 'finance:fund' || e.entity === 'finance:perihal')) {
      expect(applyFeedEntry(cloud.surau.db, f, { now: AT, origin: `box:${r.app.surau.boxId}`, actor: f.actor, dataDir: cloudDir, role: 'cloud' }).status).toBe('applied');
    }
    const ctx = { now: AT, origin: `box:${r.app.surau.boxId}`, actor: 'user:u1', dataDir: cloudDir, role: 'cloud' as const };
    expect(applyFeedEntry(cloud.surau.db, entry(r), ctx).status).toBe('applied');
    const before = cloud.surau.db.prepare("SELECT * FROM finance_entries WHERE id = 'x1'").get()!;
    expect(before.ref_no).toBeNull();
    expect(applyFeedEntry(cloud.surau.db, entry(r, { refNo: 'K-0003' }), ctx).status).toBe('applied');
    const after = cloud.surau.db.prepare("SELECT * FROM finance_entries WHERE id = 'x1'").get()!;
    expect(after.ref_no).toBe('K-0003');
    expect({ ...after, ref_no: null }).toEqual({ ...before, ref_no: null });
    expect(applyFeedEntry(cloud.surau.db, entry(r, { refNo: 'K-0004' }), ctx).status).toBe('duplicate');
  });

  it('a malformed entry (a string amount, an unknown fund) is refused and nothing is written', async () => {
    const r = await rig();
    const ctx = { now: AT, origin: 'cloud', actor: 'user:u1', dataDir: r.dir, role: 'box' as const };
    expect(applyFeedEntry(r.app.surau.db, entry(r, { amountSen: '500' }), ctx).status).toBe('refused');
    expect(applyFeedEntry(r.app.surau.db, entry(r, { fundId: 'nope' }), ctx).status).toBe('refused');
    expect(applyFeedEntry(r.app.surau.db, { ...entry(r), after: { ...(entry(r).after as object), id: 'other' } }, ctx).status).toBe('refused');
    expect(rows(r.app)).toBe(0);
  });

  it('a replicated month report must have the report shape: a wrong one is refused, a right one is stored and the PDF renders from it', async () => {
    const r = await rig();
    const ctx = { now: AT, origin: 'cloud', actor: 'user:u1', dataDir: r.dir, role: 'box' as const };
    expect(applyFeedEntry(r.app.surau.db, entry(r), ctx).status).toBe('applied');
    const month = (report: unknown): FeedEntry => ({
      seq: 2, entity: 'finance:month', entityId: '2026-11', rev: '2026-11-09T02:00:00.000Z|dev1', editedAt: '2026-11-09T02:00:00.000Z',
      syncedAt: '2026-11-09T02:00:01.000Z', actor: 'user:u1', deviceId: 'dev1', origin: 'app', opId: null,
      after: { ym: '2026-11', status: 'closed', report },
    });
    const state = () => r.app.surau.db.prepare("SELECT status, report_json FROM finance_months WHERE ym = '2026-11'").get();
    for (const bad of [{ funds: 'x' }, { ...JSON.parse(freezeReport(r.app.surau.db, '2026-11', AT)), totals: null }, { ...JSON.parse(freezeReport(r.app.surau.db, '2026-11', AT)), ym: '2026-10' }]) {
      expect(applyFeedEntry(r.app.surau.db, month(bad), ctx).status).toBe('refused');
      expect(state()).toBeUndefined();
    }
    const good = JSON.parse(freezeReport(r.app.surau.db, '2026-11', AT));
    expect(applyFeedEntry(r.app.surau.db, month(good), ctx).status).toBe('applied');
    expect(state()).toMatchObject({ status: 'closed' });
    const served = reportFor(r.app.surau.db, '2026-11', AT, 'box');
    expect(served).toEqual(good);
    expect(renderReportPdf(served, { name: 'Surau Test', kind: 'surau' }).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('verifySiteEntry accepts finance:entry and refuses the audit-only entities', async () => {
    const r = await rig();
    const site = { boxId: 'b1', surauId: 'sdm' };
    expect(verifySiteEntry(site, {}, entry(r)).ok).toBe(true);
    for (const name of ['finance:report', 'finance:view', 'finance:export']) {
      expect(verifySiteEntry(site, {}, { ...entry(r), entity: name }).ok, name).toBe(false);
    }
    expect(verifySiteEntry(site, {}, { ...entry(r), after: null }).ok).toBe(false);
    expect(verifySiteEntry(site, {}, { ...entry(r), entityId: 'x2' }).ok).toBe(false);
  });
});

describe('finance feed scope', () => {
  it('an AJK scope sees finance rows without the photo; the audit-only rows and a media scope see nothing', async () => {
    const r = await rig();
    const ph = jpeg(20_000);
    const pid = createHash('sha256').update(ph).digest('hex');
    await r.app.inject({ method: 'POST', url: '/api/finance/photos', payload: ph, headers: { ...r.treasurer.headers, 'content-type': 'image/jpeg', 'x-entry-id': 'e1' } });
    await r.app.inject({ method: 'PUT', url: '/api/finance/entries/e1', headers: r.treasurer.headers, payload: cash(r, 700, { photoId: pid }) });
    // a superadmin read leaves an audit-only row
    const sup = await loginAs(r.app, ['superadmin', 'treasurer']);
    await r.app.inject({ method: 'GET', url: '/api/finance/summary', headers: sup.headers });
    const db = r.app.surau.db;
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'finance:view'").get()!.n)).toBe(1);

    const ajkFeed = readFeed(db, 0, 5000, { users: false, devices: false, finance: true, financeWrite: false });
    const names = new Set(ajkFeed.entries.map((e) => e.entity));
    expect(names.has('finance:entry')).toBe(true);
    expect(names.has('finance:fund')).toBe(true);
    expect(names.has('finance:view')).toBe(false);
    expect(names.has('finance:photo')).toBe(false);
    const e1 = ajkFeed.entries.find((e) => e.entity === 'finance:entry')!;
    expect('photoId' in (e1.after as object)).toBe(false);
    const writerFeed = readFeed(db, 0, 5000, { users: false, devices: false, finance: true, financeWrite: true });
    expect(writerFeed.entries.some((e) => e.entity === 'finance:photo')).toBe(true);
    expect((writerFeed.entries.find((e) => e.entity === 'finance:entry')!.after as { photoId: string }).photoId).toBe(pid);
    expect(writerFeed.entries.some((e) => e.entity === 'finance:view')).toBe(false);

    const mediaFeed = readFeed(db, 0, 5000, { users: false, devices: false });
    expect(mediaFeed.entries.some((e) => e.entity.startsWith('finance:'))).toBe(false);
    expect(mediaFeed.head).toBeLessThan(ajkFeed.head);

    const opts = { boxId: db ? r.app.surau.boxId : '' };
    const snapAjk = snapshot(db, { users: false, devices: false, finance: true, financeWrite: false }, opts);
    expect(snapAjk.finance!.entries[0]!.photoId).toBeNull();
    expect(snapAjk.finance!.photos).toEqual([]);
    const snapW = snapshot(db, { users: false, devices: false, finance: true, financeWrite: true }, opts);
    expect(snapW.finance!.entries[0]!.photoId).toBe(pid);
    expect(snapW.finance!.photos).toHaveLength(1);
    expect(JSON.stringify(snapW)).not.toContain(ph.subarray(30, 80).toString('base64'));
    expect(snapshot(db, { users: false, devices: false }, opts).finance).toBeUndefined();
  });

  it('the sync snapshot route follows the caller: media gets no finance key, the treasurer gets it', async () => {
    const r = await rig();
    await r.app.inject({ method: 'PUT', url: '/api/finance/entries/e1', headers: r.treasurer.headers, payload: cash(r, 700) });
    const asMedia = (await r.app.inject({ method: 'GET', url: '/api/sync/snapshot', headers: r.media.headers })).json();
    expect('finance' in asMedia).toBe(false);
    const asTreasurer = (await r.app.inject({ method: 'GET', url: '/api/sync/snapshot', headers: r.treasurer.headers })).json();
    expect(asTreasurer.finance.entries).toHaveLength(1);
    expect(asTreasurer.finance.funds.length).toBeGreaterThan(1);
  });
});

describe('replicated photo bytes', () => {
  const photoRow = (id: string, bytes: number): FeedEntry => ({
    seq: 1, entity: 'finance:photo', entityId: id, rev: '2026-11-09T01:00:00.000Z|dev1', editedAt: '2026-11-09T01:00:00.000Z',
    syncedAt: '2026-11-09T01:00:01.000Z', actor: 'user:u1', deviceId: 'dev1', origin: 'app', opId: null,
    after: { id, entryId: 'e1', mime: 'image/jpeg', bytes },
  });
  const put = (r: Rig, id: string, body: Buffer) => r.app.inject({
    method: 'PUT', url: `/api/sync/finance-photos/${id}`, headers: { ...r.treasurer.headers, 'content-type': 'image/jpeg' }, payload: body,
  });
  const present = (r: Rig, id: string): number => Number(r.app.surau.db.prepare('SELECT present FROM finance_photos WHERE id = ?').get(id)!.present);

  it('bytes whose length differs from the row are refused; the right length is taken', async () => {
    const r = await rig();
    const ph = jpeg(40_000);
    const id = createHash('sha256').update(ph).digest('hex');
    const ctx = { now: AT, origin: 'cloud', actor: 'user:u1', dataDir: r.dir, role: 'box' as const };
    expect(applyFeedEntry(r.app.surau.db, photoRow(id, ph.length - 1), ctx).status).toBe('applied');
    expect((await put(r, id, ph)).statusCode).toBe(400);
    expect(present(r, id)).toBe(0);
    r.app.surau.db.prepare('UPDATE finance_photos SET bytes = ? WHERE id = ?').run(ph.length, id);
    expect((await put(r, id, ph)).statusCode).toBe(200);
    expect(present(r, id)).toBe(1);
  });

  it('the folder quota applies to replicated bytes too', async () => {
    const r = await rig();
    const ph = jpeg(40_000);
    const id = createHash('sha256').update(ph).digest('hex');
    const ctx = { now: AT, origin: 'cloud', actor: 'user:u1', dataDir: r.dir, role: 'box' as const };
    expect(applyFeedEntry(r.app.surau.db, photoRow(id, ph.length), ctx).status).toBe('applied');
    const old = process.env.SURAU_FINANCE_PHOTOS_MAX_MB;
    process.env.SURAU_FINANCE_PHOTOS_MAX_MB = '0.01';
    try {
      expect((await put(r, id, ph)).statusCode).toBe(413);
      expect(present(r, id)).toBe(0);
    } finally {
      if (old === undefined) delete process.env.SURAU_FINANCE_PHOTOS_MAX_MB; else process.env.SURAU_FINANCE_PHOTOS_MAX_MB = old;
    }
    expect((await put(r, id, ph)).statusCode).toBe(200);
    expect(present(r, id)).toBe(1);
  });
});

describe('finance by sync follows the finance controls', () => {
  const viewCount = (r: Rig): number => Number(r.app.surau.db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'finance:view'").get()!.n);
  const financeIn = (rows: { entity: string }[]): number => rows.filter((e) => e.entity.startsWith('finance:')).length;

  it('with the module off neither the changes feed nor the snapshot carries finance rows, for anyone', async () => {
    const r = await rig();
    await r.app.inject({ method: 'PUT', url: '/api/finance/entries/e1', headers: r.treasurer.headers, payload: cash(r, 700) });
    const feed = async (l: Login) => (await r.app.inject({ method: 'GET', url: '/api/sync/changes?since=0', headers: l.headers })).json();
    const snap = async (l: Login) => (await r.app.inject({ method: 'GET', url: '/api/sync/snapshot', headers: l.headers })).json();
    expect(financeIn((await feed(r.treasurer)).entries)).toBeGreaterThan(0);
    expect((await snap(r.treasurer)).finance.entries).toHaveLength(1);
    putFeature(r.app.surau.db, 'finance', { enabled: false }, 'test');
    expect(financeIn((await feed(r.treasurer)).entries)).toBe(0);
    expect('finance' in (await snap(r.treasurer))).toBe(false);
    const sup = await loginAs(r.app, ['superadmin', 'treasurer']);
    expect(financeIn((await feed(sup)).entries)).toBe(0);
    expect('finance' in (await snap(sup))).toBe(false);
    expect(viewCount(r)).toBe(0);
  });

  it('a Pentadbir MAXCOM pull logs one finance:view per route per ten minutes; an ordinary treasurer logs nothing', async () => {
    const r = await rig();
    await r.app.inject({ method: 'PUT', url: '/api/finance/entries/e1', headers: r.treasurer.headers, payload: cash(r, 700) });
    await r.app.inject({ method: 'GET', url: '/api/sync/changes?since=0', headers: r.treasurer.headers });
    await r.app.inject({ method: 'GET', url: '/api/sync/snapshot', headers: r.treasurer.headers });
    expect(viewCount(r)).toBe(0);
    const sup = await loginAs(r.app, ['superadmin', 'treasurer']);
    await r.app.inject({ method: 'GET', url: '/api/sync/changes?since=0', headers: sup.headers });
    expect(viewCount(r)).toBe(1);
    await r.app.inject({ method: 'GET', url: '/api/sync/changes?since=0', headers: sup.headers });
    expect(viewCount(r)).toBe(1);
    await r.app.inject({ method: 'GET', url: '/api/sync/snapshot', headers: sup.headers });
    expect(viewCount(r)).toBe(2);
    // a pull that carries no finance row logs nothing
    const head = (await r.app.inject({ method: 'GET', url: '/api/sync/changes?since=0', headers: sup.headers })).json().head as number;
    await r.app.inject({ method: 'GET', url: `/api/sync/changes?since=${head}`, headers: (await loginAs(r.app, ['superadmin'])).headers });
    expect(viewCount(r)).toBe(2);
  });
});

describe('box and cloud end to end', () => {
  interface Pair { box: FastifyInstance; boxDir: string; boxId: string; cloud: TestCloud; run: () => Promise<void> }

  async function pair(): Promise<Pair> {
    const boxDir = tmp();
    const hook = { fetch: (undefined as unknown) as typeof fetch };
    const box = buildApp(join(boxDir, 'box.db'), {
      dataDir: boxDir,
      sync: { fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => hook.fetch(i, n)) as typeof fetch, sleep: async () => undefined },
    });
    apps.push(box);
    const boxId = box.surau.boxId;
    const cloud = buildCloud(boxId);
    clouds.push(cloud);
    const worker = new FakeWorker(cloud.fetch);
    hook.fetch = worker.fetch;
    const { code } = issueLinkCode({ db: cloud.app.surau.db, now: () => new Date() }, { boxId, name: 'Surau D\'Waqaf' });
    const lines: string[] = [];
    await runCloudLink(['--data', boxDir, '--db', join(boxDir, 'box.db'), 'link', CLOUD_URL, code], { out: (l) => lines.push(l), err: (l) => lines.push(l) }, worker.fetch);
    worker.setSecret(boxId, loadSyncKey(boxDir)!.wakeSecret);
    return { box, boxDir, boxId, cloud, run: async () => { await box.syncAgent!.runOnce(); } };
  }

  it('the box pushes two entries and a photo; the cloud holds them, the bytes came by their own route, and the box learns the cloud receipt time', async () => {
    const p = await pair();
    const treasurer = await loginAs(p.box, 'treasurer');
    putFeature(p.box.surau.db, 'finance', { enabled: true }, 'test');
    const funds = (await p.box.inject({ method: 'GET', url: '/api/finance/funds', headers: treasurer.headers })).json().funds as { id: string }[];
    const perIn = ((await p.box.inject({ method: 'GET', url: '/api/finance/perihal', headers: treasurer.headers })).json().perihal as { id: string; direction: string }[]).find((x) => x.direction === 'in')!.id;
    const today = klDateOf(new Date());
    const body = (extra: Record<string, unknown> = {}) => ({ kind: 'in', entryDate: today, fundId: funds[0]!.id, perihalId: perIn, amountSen: 12345, method: 'bank', reference: 'FPX1', ...extra });
    const ph = jpeg(40_000);
    const pid = createHash('sha256').update(ph).digest('hex');
    expect((await p.box.inject({ method: 'POST', url: '/api/finance/photos', payload: ph, headers: { ...treasurer.headers, 'content-type': 'image/jpeg', 'x-entry-id': 'e1' } })).statusCode).toBe(200);
    expect((await p.box.inject({ method: 'PUT', url: '/api/finance/entries/e1', headers: treasurer.headers, payload: body({ photoId: pid }) })).statusCode).toBe(200);
    expect((await p.box.inject({ method: 'PUT', url: '/api/finance/entries/e2', headers: treasurer.headers, payload: body({ amountSen: 700 }) })).statusCode).toBe(200);

    await p.run();
    const cdb = p.cloud.app.surau.db;
    expect(cdb.prepare('SELECT id, amount_sen, ref_no, received_at FROM finance_entries ORDER BY id').all().map((x) => [x.id, x.amount_sen, x.ref_no])).toEqual([['e1', 12345, 'K-0001'], ['e2', 700, 'K-0002']]);
    expect(cdb.prepare('SELECT present FROM finance_photos WHERE id = ?').get(pid)!.present).toBe(1);
    expect(existsSync(join(p.cloud.dir, 'finance', 'photos', `${pid}.jpg`))).toBe(true);
    const boxRows = p.box.surau.db.prepare('SELECT id, cloud_received_at FROM finance_entries ORDER BY id').all();
    expect(boxRows.every((x) => typeof x.cloud_received_at === 'string')).toBe(true);
    // nothing of the audit-only kind travelled, and a second cycle changes nothing
    expect(Number(cdb.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'finance:view'").get()!.n)).toBe(0);
    const n = Number(cdb.prepare('SELECT COUNT(*) AS n FROM change_log').get()!.n);
    await p.run();
    expect(Number(cdb.prepare('SELECT COUNT(*) AS n FROM change_log').get()!.n)).toBe(n);
    // the photo is not served to the public store on the cloud either
    expect((await p.cloud.app.inject({ method: 'GET', url: `/assets/${pid}`, remoteAddress: '127.0.0.1' })).statusCode).toBe(404);
  });

  it('a phone entry made on the cloud has no number there; the box numbers it and the cloud learns the number', async () => {
    const p = await pair();
    const treasurer = await loginAs(p.box, 'treasurer');
    putFeature(p.box.surau.db, 'finance', { enabled: true }, 'test');
    const funds = (await p.box.inject({ method: 'GET', url: '/api/finance/funds', headers: treasurer.headers })).json().funds as { id: string }[];
    const perIn = ((await p.box.inject({ method: 'GET', url: '/api/finance/perihal', headers: treasurer.headers })).json().perihal as { id: string; direction: string }[]).find((x) => x.direction === 'in')!.id;
    await p.run(); // lookups reach the cloud first
    const phone = await loginAs(p.cloud.app, 'treasurer');
    const op = await signOp(phone, p.boxId, {
      kind: 'finance.append', entity: 'finance:entry', entityId: 'ph1', editedAt: new Date().toISOString(),
      payload: { kind: 'in', entryDate: klDateOf(new Date()), fundId: funds[0]!.id, perihalId: perIn, amountSen: 4500, method: 'bank', reference: 'DUITNOW1' },
    });
    const res = await p.cloud.app.inject({ method: 'POST', url: '/api/sync/ops', headers: phone.headers, payload: { ops: [op] } });
    expect(res.json().results[0].status).toBe('applied');
    expect(p.cloud.app.surau.db.prepare("SELECT ref_no FROM finance_entries WHERE id = 'ph1'").get()!.ref_no).toBeNull();
    await p.run();
    expect(p.box.surau.db.prepare("SELECT ref_no, origin FROM finance_entries WHERE id = 'ph1'").get()).toMatchObject({ ref_no: 'K-0001', origin: 'app' });
    await p.run();
    expect(p.cloud.app.surau.db.prepare("SELECT ref_no, amount_sen FROM finance_entries WHERE id = 'ph1'").get()).toMatchObject({ ref_no: 'K-0001', amount_sen: 4500 });
  });

  it('a snapshot applies originals before corrections, even when the correction was edited earlier', async () => {
    const p = await pair();
    const treasurer = await loginAs(p.box, 'treasurer');
    putFeature(p.box.surau.db, 'finance', { enabled: true }, 'test');
    const funds = (await p.box.inject({ method: 'GET', url: '/api/finance/funds', headers: treasurer.headers })).json().funds as { id: string }[];
    const perIn = ((await p.box.inject({ method: 'GET', url: '/api/finance/perihal', headers: treasurer.headers })).json().perihal as { id: string; direction: string }[]).find((x) => x.direction === 'in')!.id;
    await p.run(); // lookups reach the cloud
    const cdb = p.cloud.app.surau.db;
    const cloudCtx = { now: new Date(), role: 'cloud' as const };
    const meta = (editedAt: string) => ({ editedAt, origin: 'local' });
    insertReplicatedEntry(cdb, {
      kind: 'in', entryDate: '2026-11-05', fundId: funds[0]!.id, perihalId: perIn, amountSen: 10000, method: 'bank', reference: 'FPX1',
    }, 'orig1', 'user:u1', cloudCtx, meta('2026-11-05T09:00:00.000Z'));
    insertReplicatedEntry(cdb, {
      kind: 'adjust', entryDate: '2026-11-05', fundId: funds[0]!.id, correctsId: 'orig1', correctionKind: 'amount', amountSen: 9000, reason: 'Salah taip jumlah: 90',
    }, 'corr1', 'user:u1', cloudCtx, meta('2026-11-05T08:00:00.000Z'));
    cdb.prepare("INSERT INTO sync_state (key, value) VALUES ('log_floor', '100000')").run();
    await p.run();
    const got = p.box.surau.db.prepare('SELECT id FROM finance_entries ORDER BY id').all().map((x) => x.id);
    expect(got).toEqual(['corr1', 'orig1']);
  });

  it('an entry the box numbers after a snapshot is pushed back so the cloud learns its number', async () => {
    const p = await pair();
    const treasurer = await loginAs(p.box, 'treasurer');
    putFeature(p.box.surau.db, 'finance', { enabled: true }, 'test');
    const funds = (await p.box.inject({ method: 'GET', url: '/api/finance/funds', headers: treasurer.headers })).json().funds as { id: string }[];
    const perIn = ((await p.box.inject({ method: 'GET', url: '/api/finance/perihal', headers: treasurer.headers })).json().perihal as { id: string; direction: string }[]).find((x) => x.direction === 'in')!.id;
    await p.run();
    const cdb = p.cloud.app.surau.db;
    insertReplicatedEntry(cdb, {
      kind: 'in', entryDate: '2026-11-05', fundId: funds[0]!.id, perihalId: perIn, amountSen: 10000, method: 'bank', reference: 'FPX1',
    }, 'ph1', 'user:u1', { now: new Date(), role: 'cloud' }, { editedAt: '2026-11-05T09:00:00.000Z', origin: 'local' });
    expect(cdb.prepare("SELECT ref_no FROM finance_entries WHERE id = 'ph1'").get()!.ref_no).toBeNull();
    cdb.prepare("INSERT INTO sync_state (key, value) VALUES ('log_floor', '100000')").run();
    await p.run();
    const boxRef = p.box.surau.db.prepare("SELECT ref_no FROM finance_entries WHERE id = 'ph1'").get()!.ref_no;
    expect(boxRef).toBe('K-0001');
    await p.run();
    expect(cdb.prepare("SELECT ref_no FROM finance_entries WHERE id = 'ph1'").get()!.ref_no).toBe('K-0001');
  });

  it('a snapshot month row carries its real edit time: a stale open row cannot reopen a month the box closed later', async () => {
    const p = await pair();
    putFeature(p.box.surau.db, 'finance', { enabled: true }, 'test');
    await p.run();
    const freeze = () => '{}';
    const at = new Date('2026-11-10T02:00:00.000Z');
    // the cloud closed October on 1 Nov and reopened it on 2 Nov; the box closed it again on 5 Nov
    putMonthIn(p.cloud.app.surau.db, '2026-10', { status: 'closed' }, 'test', { now: at, role: 'cloud', freeze }, { editedAt: '2026-11-01T02:00:00.000Z', trusted: true });
    putMonthIn(p.cloud.app.surau.db, '2026-10', { status: 'open' }, 'test', { now: at, role: 'cloud' }, { editedAt: '2026-11-02T02:00:00.000Z', trusted: true });
    putMonthIn(p.box.surau.db, '2026-10', { status: 'closed' }, 'test', { now: at, role: 'box', freeze }, { editedAt: '2026-11-05T02:00:00.000Z', trusted: true });
    p.cloud.app.surau.db.prepare("INSERT INTO sync_state (key, value) VALUES ('log_floor', '100000')").run();
    await p.run();
    expect(p.box.surau.db.prepare("SELECT status FROM finance_months WHERE ym = '2026-10'").get()!.status).toBe('closed');
    // and a genuinely newer open on the cloud still reopens it
    putMonthIn(p.cloud.app.surau.db, '2026-10', { status: 'closed' }, 'test', { now: at, role: 'cloud', freeze }, { editedAt: '2026-11-06T02:00:00.000Z', trusted: true });
    putMonthIn(p.cloud.app.surau.db, '2026-10', { status: 'open' }, 'test', { now: at, role: 'cloud' }, { editedAt: '2026-11-07T02:00:00.000Z', trusted: true });
    p.cloud.app.surau.db.prepare("UPDATE sync_state SET value = '200000' WHERE key = 'log_floor'").run();
    await p.run();
    expect(p.box.surau.db.prepare("SELECT status FROM finance_months WHERE ym = '2026-10'").get()!.status).toBe('open');
  });

  it('a site token cannot read the finance routes on a server it is linked to', async () => {
    const p = await pair();
    const key = loadSyncKey(p.boxDir)!;
    const r = await p.cloud.app.inject({ method: 'GET', url: '/api/finance/entries', headers: { authorization: `Bearer ${key.siteToken}` } });
    expect(r.statusCode).toBe(403);
    const photos = await p.cloud.app.inject({ method: 'GET', url: `/api/finance/photos/${'a'.repeat(64)}`, headers: { authorization: `Bearer ${key.siteToken}` } });
    expect(photos.statusCode).toBe(403);
  });
});
