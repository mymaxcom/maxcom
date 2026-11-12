import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { klInstant } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { putFeature } from '../src/settingsStore.ts';
import { logSyncRefusal } from '../src/sync/verify.ts';
import { loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';

const AT = klInstant('2026-11-10', '10:00');
const apps: FastifyInstance[] = [];
const dirs: string[] = [];

function makeApp(): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-fin-'));
  dirs.push(dir);
  const noNetwork = (async () => { throw new TypeError('network disabled in tests'); }) as unknown as typeof fetch;
  const app = buildApp(join(dir, 'test.db'), { now: () => AT, fetchImpl: noNetwork });
  apps.push(app);
  return app;
}

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Rig { app: FastifyInstance; admin: Login; treasurer: Login; ajk: Login; media: Login; fundA: string; fundB: string; perIn: string; perOut: string }

async function rig(on = true): Promise<Rig> {
  const app = makeApp();
  const { db } = app.surau;
  const admin = await loginAs(app, 'admin');
  const treasurer = await loginAs(app, 'treasurer');
  const ajk = await loginAs(app, 'ajk');
  const media = await loginAs(app, 'media');
  if (on) putFeature(db, 'finance', { enabled: true }, 'test');
  const funds = (await app.inject({ method: 'GET', url: '/api/finance/funds', headers: treasurer.headers })).json().funds as { id: string }[];
  const per = (await app.inject({ method: 'GET', url: '/api/finance/perihal', headers: treasurer.headers })).json().perihal as { id: string; direction: string; label: string }[];
  return {
    app, admin, treasurer, ajk, media, fundA: funds[0]?.id ?? '', fundB: funds[1]?.id ?? '',
    perIn: per.find((p) => p.direction === 'in')?.id ?? '', perOut: per.find((p) => p.label === 'Utiliti')?.id ?? '',
  };
}

const cash = (r: Rig, amountSen: number, extra: Record<string, unknown> = {}) => ({
  kind: 'in', entryDate: '2026-11-06', fundId: r.fundA, perihalId: r.perIn, amountSen, method: 'tunai',
  counters: [{ userId: r.treasurer.userId }, { name: 'Tuan Haji Ali' }], ...extra,
});

describe('finance routes: permissions', () => {
  it('AJK cannot write, media cannot read, treasurer cannot edit a lookup, admin can', async () => {
    const r = await rig();
    const put = (login: Login, url: string, payload: unknown) => r.app.inject({ method: 'PUT', url, headers: login.headers, payload: payload as object });
    expect((await put(r.ajk, '/api/finance/entries/x', cash(r, 100))).statusCode).toBe(403);
    expect((await r.app.inject({ method: 'GET', url: '/api/finance/summary', headers: r.media.headers })).statusCode).toBe(403);
    expect((await r.app.inject({ method: 'GET', url: '/api/finance/summary', remoteAddress: '10.168.1.70' })).statusCode).toBe(401);
    expect((await put(r.treasurer, `/api/finance/funds/f-new`, { name: 'Baharu', public: false })).statusCode).toBe(403);
    expect((await put(r.admin, `/api/finance/funds/f-new`, { name: 'Baharu', public: false })).statusCode).toBe(200);
    expect((await put(r.ajk, '/api/finance/funds/f-new2', { name: 'X' })).statusCode).toBe(403);
  });
  it('the kiosk identity cannot read finance', async () => {
    const r = await rig();
    const res = await r.app.inject({ method: 'GET', url: '/api/finance/summary', remoteAddress: '127.0.0.1' });
    expect(res.statusCode).toBe(403);
  });
});

describe('finance routes: the ledger', () => {
  it('the treasurer appends a cash collection; it is K-0001, the balance moves, a repeat is idempotent', async () => {
    const r = await rig();
    const send = (payload: unknown) => r.app.inject({ method: 'PUT', url: '/api/finance/entries/e1', headers: r.treasurer.headers, payload: payload as object });
    const first = await send(cash(r, 135680));
    expect(first.statusCode).toBe(200);
    expect(first.json().entry.refNo).toBe('K-0001');
    expect(first.json().entry.amountSen).toBe(135680);
    const sum = await r.app.inject({ method: 'GET', url: '/api/finance/summary', headers: r.treasurer.headers });
    const jum = (sum.json().funds as { id: string; balanceSen: number }[]).find((f) => f.id === r.fundA)!;
    expect(jum.balanceSen).toBe(135680);
    expect(sum.json().month).toMatchObject({ ym: '2026-11', inSen: 135680, outSen: 0, status: 'open' });
    expect((await send(cash(r, 135680))).statusCode).toBe(200);
    const different = await send(cash(r, 135681));
    expect(different.statusCode).toBe(409);
    expect(different.json().code).toBe('entry_exists');
    const list = await r.app.inject({ method: 'GET', url: '/api/finance/entries?ym=2026-11', headers: r.treasurer.headers });
    expect(list.json().entries).toHaveLength(1);
  });

  it('the home month totals use effective amounts: a void drops out and a corrected amount counts', async () => {
    const r = await rig();
    const put = (id: string, payload: unknown) => r.app.inject({ method: 'PUT', url: `/api/finance/entries/${id}`, headers: r.treasurer.headers, payload: payload as object });
    const out = (amountSen: number) => ({ kind: 'out', entryDate: '2026-11-06', fundId: r.fundA, perihalId: r.perOut, amountSen, method: 'bank', reference: 'FPX9', payee: 'TNB' });
    expect((await put('i1', cash(r, 100000))).statusCode).toBe(200);
    expect((await put('i2', cash(r, 50000))).statusCode).toBe(200);
    expect((await put('o1', out(30000))).statusCode).toBe(200);
    const sum = async () => (await r.app.inject({ method: 'GET', url: '/api/finance/summary', headers: r.treasurer.headers })).json().month;
    expect(await sum()).toMatchObject({ inSen: 150000, outSen: 30000 });
    const adj = (id: string, correctsId: string, correctionKind: string, amountSen: number) => ({ kind: 'adjust', entryDate: '2026-11-10', fundId: r.fundA, correctsId, correctionKind, amountSen, reason: 'Pembetulan kiraan semula' });
    const c1 = await put('c1', adj('c1', 'i2', 'void', 0)); expect(c1.statusCode).toBe(200);
    expect((await put('c2', adj('c2', 'o1', 'amount', 28000))).statusCode).toBe(200);
    expect(await sum()).toMatchObject({ inSen: 100000, outSen: 28000 });
  });

  it('refuses a body with an unknown key, forged amounts and a wrong counter count, and writes no row', async () => {
    const r = await rig();
    const send = (payload: unknown) => r.app.inject({ method: 'PUT', url: '/api/finance/entries/e2', headers: r.treasurer.headers, payload: payload as object });
    const bad: unknown[] = [
      { ...cash(r, 100), refNo: 'K-9999' }, cash(r, '100' as unknown as number), cash(r, -5), cash(r, 2.5), cash(r, 1e5 + 0.5),
      cash(r, 100, { counters: [{ userId: r.treasurer.userId }] }),
      cash(r, 100, { counters: [{ userId: r.treasurer.userId }, { name: 'a' }, { name: 'b' }] }),
      cash(r, 100, { amountSen: Number.MAX_SAFE_INTEGER }), cash(r, 100, { photoId: 'a'.repeat(63) }),
    ];
    for (const b of bad) expect((await send(b)).statusCode, JSON.stringify(b).slice(0, 80)).toBe(400);
    expect((await r.app.inject({ method: 'PUT', url: '/api/finance/entries/..%2Fx', headers: r.treasurer.headers, payload: cash(r, 100) })).statusCode).toBe(400);
    expect((await r.app.inject({ method: 'PUT', url: '/api/finance/entries/e2', headers: r.treasurer.headers, payload: { ...cash(r, 100), id: 'other' } })).statusCode).toBe(400);
    expect(Number(r.app.surau.db.prepare('SELECT COUNT(*) AS n FROM finance_entries').get()!.n)).toBe(0);
  });

  it('AJK sees entries without a photoId, the treasurer sees it', async () => {
    const r = await rig();
    const photo = 'a'.repeat(64);
    const res = await r.app.inject({ method: 'PUT', url: '/api/finance/entries/e3', headers: r.treasurer.headers, payload: cash(r, 500, { photoId: photo }) as object });
    expect(res.statusCode).toBe(200);
    const asAjk = (await r.app.inject({ method: 'GET', url: '/api/finance/entries', headers: r.ajk.headers })).json().entries[0];
    expect('photoId' in asAjk).toBe(false);
    expect(asAjk.amountSen).toBe(500);
    const asTreasurer = (await r.app.inject({ method: 'GET', url: '/api/finance/entries', headers: r.treasurer.headers })).json().entries[0];
    expect(asTreasurer.photoId).toBe(photo);
    const one = (await r.app.inject({ method: 'GET', url: '/api/finance/entries/e3', headers: r.ajk.headers })).json();
    expect('photoId' in one.entry).toBe(false);
    expect('photoId' in one.effective).toBe(false);
  });

  it('a correction chain is served with the effective state', async () => {
    const r = await rig();
    await r.app.inject({ method: 'PUT', url: '/api/finance/entries/e4', headers: r.treasurer.headers, payload: cash(r, 100000) as object });
    const adj = await r.app.inject({
      method: 'PUT', url: '/api/finance/entries/c4', headers: r.treasurer.headers,
      payload: { kind: 'adjust', entryDate: '2026-11-10', fundId: r.fundA, correctsId: 'e4', correctionKind: 'amount', amountSen: 90000, reason: 'Salah taip jumlah: 900' },
    });
    expect(adj.statusCode).toBe(200);
    expect(adj.json().entry.refNo).toBe('P-0001');
    const got = (await r.app.inject({ method: 'GET', url: '/api/finance/entries/e4', headers: r.ajk.headers })).json();
    expect(got.effective.effAmountSen).toBe(90000);
    expect(got.corrections).toHaveLength(1);
  });
});

describe('finance routes: lookups and months', () => {
  it('admin renames a tabung; a duplicate name is 409; archiving a tabung with a balance is 409', async () => {
    const r = await rig();
    await r.app.inject({ method: 'PUT', url: '/api/finance/entries/e5', headers: r.treasurer.headers, payload: cash(r, 100) as object });
    const put = (id: string, p: unknown) => r.app.inject({ method: 'PUT', url: `/api/finance/funds/${id}`, headers: r.admin.headers, payload: p as object });
    expect((await put(r.fundA, { name: 'Tabung Jumaat Utama', public: true, jumaat: true, sortOrder: 1 })).statusCode).toBe(200);
    expect((await put('another', { name: 'Tabung Am' })).json().code).toBe('name_taken');
    const arch = await put(r.fundA, { name: 'Tabung Jumaat Utama', archivedAt: '2026-11-10T02:00:00.000Z' });
    expect(arch.statusCode).toBe(409);
    expect(arch.json().code).toBe('balance_not_zero');
  });
  it('the admin closes October and a collection dated in it is refused', async () => {
    const r = await rig();
    await r.app.inject({ method: 'PUT', url: '/api/finance/entries/e6', headers: r.treasurer.headers, payload: cash(r, 100, { entryDate: '2026-10-30' }) as object });
    const close = await r.app.inject({ method: 'PUT', url: '/api/finance/months/2026-10', headers: r.admin.headers, payload: { status: 'closed' } });
    expect(close.statusCode).toBe(200);
    expect((await r.app.inject({ method: 'GET', url: '/api/finance/months', headers: r.ajk.headers })).json().months[0]).toMatchObject({ ym: '2026-10', status: 'closed' });
    const late = await r.app.inject({ method: 'PUT', url: '/api/finance/entries/e7', headers: r.treasurer.headers, payload: cash(r, 100, { entryDate: '2026-10-31' }) as object });
    expect(late.statusCode).toBe(409);
    expect(late.json().code).toBe('month_closed');
    expect((await r.app.inject({ method: 'PUT', url: '/api/finance/months/2026-10', headers: r.treasurer.headers, payload: { status: 'open' } })).statusCode).toBe(403);
  });
});

describe('finance routes: seeding', () => {
  it('a reader (AJK) GET writes nothing on an unseeded box; the treasurer GET seeds it once', async () => {
    const app = makeApp();
    const { db } = app.surau;
    const ajk = await loginAs(app, 'ajk');
    const treasurer = await loginAs(app, 'treasurer');
    putFeature(db, 'finance', { enabled: true }, 'test');
    const funds = () => Number(db.prepare('SELECT COUNT(*) AS n FROM finance_funds').get()!.n);
    const log = () => Number(db.prepare('SELECT COUNT(*) AS n FROM change_log').get()!.n);
    const before = log();
    for (const url of ['/api/finance/summary', '/api/finance/funds', '/api/finance/perihal']) {
      const res = await app.inject({ method: 'GET', url, headers: ajk.headers });
      expect(res.statusCode, url).toBe(200);
    }
    expect(funds()).toBe(0);
    expect(log()).toBe(before);
    expect((await app.inject({ method: 'GET', url: '/api/finance/funds', headers: treasurer.headers })).json().funds.length).toBeGreaterThan(1);
    expect(funds()).toBeGreaterThan(1);
  });
});

describe('finance routes: module off and the superadmin view log', () => {
  it('with finance off AJK gets 404 module_off and the treasurer still works', async () => {
    const r = await rig(false);
    const ajk = await r.app.inject({ method: 'GET', url: '/api/finance/summary', headers: r.ajk.headers });
    expect(ajk.statusCode).toBe(404);
    expect(ajk.json().code).toBe('module_off');
    expect((await r.app.inject({ method: 'GET', url: '/api/finance/summary', headers: r.treasurer.headers })).statusCode).toBe(200);
  });
  it('a superadmin read writes one finance:view row, and no second within ten minutes', async () => {
    const r = await rig();
    const sup = await loginAs(r.app, ['superadmin', 'treasurer']);
    const count = () => Number(r.app.surau.db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'finance:view'").get()!.n);
    expect(count()).toBe(0);
    await r.app.inject({ method: 'GET', url: '/api/finance/summary', headers: sup.headers });
    expect(count()).toBe(1);
    await r.app.inject({ method: 'GET', url: '/api/finance/summary', headers: sup.headers });
    expect(count()).toBe(1);
    await r.app.inject({ method: 'GET', url: '/api/finance/entries', headers: sup.headers });
    expect(count()).toBe(2);
    // an ordinary treasurer's read writes nothing
    await r.app.inject({ method: 'GET', url: '/api/finance/entries', headers: r.treasurer.headers });
    expect(count()).toBe(2);
  });
});

describe('finance routes: audit', () => {
  it('lists the append and a forced refusal row, and a normal user without finance:write cannot read it', async () => {
    const r = await rig();
    await r.app.inject({ method: 'PUT', url: '/api/finance/entries/e8', headers: r.treasurer.headers, payload: cash(r, 100) as object });
    logSyncRefusal(r.app.surau.db, AT, { userId: r.treasurer.userId, deviceId: r.treasurer.deviceId }, 'apply_finance_month_closed');
    const res = await r.app.inject({ method: 'GET', url: '/api/finance/audit', headers: r.treasurer.headers });
    expect(res.statusCode).toBe(200);
    const rows = res.json().entries as { entity: string; entityId: string | null; refused: { detail: string } | null; userName: string | null }[];
    expect(rows.some((e) => e.entity === 'finance:entry' && e.entityId === 'e8' && e.userName !== null)).toBe(true);
    expect(rows.some((e) => e.refused?.detail === 'apply_finance_month_closed')).toBe(true);
    expect((await r.app.inject({ method: 'GET', url: '/api/finance/audit', headers: r.ajk.headers })).statusCode).toBe(403);
  });
});

describe('finance routes: audit paging and refusals', () => {
  type Row = { id: string; entity: string; entityId: string | null; refused: { detail: string } | null };
  const get = async (r: Rig, qs: string) => (await r.app.inject({ method: 'GET', url: `/api/finance/audit${qs}`, headers: r.treasurer.headers })).json() as { entries: Row[]; next?: number | null };

  it('only finance refusals are listed, never a plain device_revoked', async () => {
    const r = await rig();
    const who = { userId: r.treasurer.userId, deviceId: r.treasurer.deviceId };
    logSyncRefusal(r.app.surau.db, AT, who, 'device_revoked');
    logSyncRefusal(r.app.surau.db, AT, who, 'apply_finance_fund_archived');
    const details = (await get(r, '')).entries.filter((e) => e.refused !== null).map((e) => e.refused!.detail);
    expect(details).toEqual(['apply_finance_fund_archived']);
  });

  it('with since the rows after it come oldest first, page by page with a next cursor, and refusals follow since', async () => {
    const r = await rig();
    for (let i = 1; i <= 5; i++) {
      await r.app.inject({ method: 'PUT', url: `/api/finance/entries/p${i}`, headers: r.treasurer.headers, payload: cash(r, 100 * i) as object });
    }
    const all = (await get(r, '?limit=1000')).entries.filter((e) => e.entity === 'finance:entry').map((e) => e.entityId!);
    expect(all).toHaveLength(5);
    const seen: string[] = [];
    let since = 0;
    for (let page = 0; page < 200; page++) {
      const out = await get(r, `?since=${since}&limit=2`);
      seen.push(...out.entries.filter((e) => e.entity === 'finance:entry').map((e) => e.entityId!));
      if (out.next === null || out.next === undefined) break;
      since = out.next;
    }
    expect(seen.slice().sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(new Set(seen).size).toBe(5);
    // a refusal logged before the cursor is not repeated after it; one logged after it is
    const who = { userId: r.treasurer.userId, deviceId: r.treasurer.deviceId };
    const headRow = r.app.surau.db.prepare('SELECT id, at FROM change_log ORDER BY id DESC LIMIT 1').get()!;
    const head = Number(headRow.id);
    const headAt = Date.parse(String(headRow.at));
    logSyncRefusal(r.app.surau.db, new Date(headAt - 3_600_000), who, 'apply_finance_month_closed');
    expect((await get(r, `?since=${head}`)).entries.filter((e) => e.refused !== null)).toHaveLength(0);
    logSyncRefusal(r.app.surau.db, new Date(headAt + 3_600_000), who, 'apply_finance_month_closed');
    expect((await get(r, `?since=${head}`)).entries.filter((e) => e.refused !== null)).toHaveLength(1);
  });
});

describe('finance routes: caching', () => {
  it('answers are no-store', async () => {
    const r = await rig();
    const res = await r.app.inject({ method: 'GET', url: '/api/finance/summary', headers: r.treasurer.headers });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
