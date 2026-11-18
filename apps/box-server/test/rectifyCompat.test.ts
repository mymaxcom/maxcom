// [PP-COMPAT] Data made before the app-wide rectification (release 2026.11.12) still reads and behaves as decided.
// Each fixture is written the way the previous release stored it, then read through the code of this release:
//   - announcements with priority 1 to 3 keep their numbers and meaning (1 Biasa, 2 Penting, 3 Segera);
//   - a month closed before the release keeps its frozen report byte for byte, with no late entries until one arrives;
//   - a box that holds the old youtube-token.json keeps its sign-in, while a cloud clears the one shared token;
//   - a surau above 500 own hadis can still reorder and edit, but not add;
//   - a surau abroad gets the English TV default and no JAKIM actions.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRotation, klInstant, resolveSettings, tvLanguage } from '@surau/core';
import type { KioskContent } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { listItems, putItem } from '../src/content/store.ts';
import { openDb } from '../src/db.ts';
import { ensureSeeded, insertReplicatedEntry, listFunds, listMonths, listPerihal, monthReportJson } from '../src/finance/store.ts';
import { createYoutubeService } from '../src/live/youtube/api.ts';
import { getSettings, putFeature } from '../src/settingsStore.ts';
import { loginAs } from './authHelpers.ts';
import { must } from './helpers/must.ts';
import { buildCloud } from './support/fakeCloud.ts';
import { startFakeGoogle } from './support/fakeGoogle.ts';
import { startLiveHarness } from './support/liveHarness.ts';

const closers: Array<() => Promise<void> | void> = [];
const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0)) await c();
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function makeApp(opts: Parameters<typeof buildApp>[1] = {}): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-rectcompat-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'), { dataDir: dir, ...opts });
  apps.push(app);
  return app;
}

// ---------------------------------------------------------------------------------------------------------------

describe('[PP-COMPAT] announcements saved before the release', () => {
  it('[PP-COMPAT] priority 1, 2 and 3 keep their numbers; the TV shows Segera first and an old Biasa is last, not highlighted', () => {
    const db = openDb(':memory:');
    closers.push(() => db.close());
    const old = (id: string, priority: 1 | 2 | 3, from: string) => putItem(db, 'pengumuman', { id, title: `Pengumuman ${id}`, body: 'Isi contoh', from, to: '2026-11-30', priority }, 'old', undefined, 'sdm');
    old('biasa', 1, '2026-11-01');
    old('penting', 2, '2026-11-02');
    old('segera', 3, '2026-11-03');
    const stored = listItems(db, 'pengumuman', {}, 'sdm').map((i) => [i.id, i.priority]);
    expect(Object.fromEntries(stored)).toEqual({ biasa: 1, penting: 2, segera: 3 });
    const content: KioskContent = {
      date: '2026-11-04', kuliah: [], pengumuman: listItems(db, 'pengumuman', {}, 'sdm').map(({ pictureAssetId: _picture, ...rest }) => rest), ticker: [], posters: [], programKhas: [], takwim: [],
      hadisToday: [], worldTimes: [], tugasan: [], ayat: { today: null, tomorrow: null }, zikir: [], tilawah: { slots: [], available: {} },
      credits: { translation: '', font: '', audio: '' },
    };
    const now = klInstant('2026-11-04', '12:00');
    const order = (settings: ReturnType<typeof resolveSettings>) => buildRotation(content, settings, now).filter((s) => s.feature === 'pengumuman').map((s) => s.itemId);
    expect(order(resolveSettings({}))).toEqual(['segera', 'penting', 'biasa']);
    // past maxItems the ordinary one is the one dropped, never the urgent one
    expect(order(resolveSettings({ pengumuman: { maxItems: 2 } }))).toEqual(['segera', 'penting']);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('[PP-COMPAT] a month closed before the release', () => {
  it('[PP-COMPAT] keeps its frozen report byte for byte and has no late entries until one arrives; the report is still not rewritten after', () => {
    const db = openDb(':memory:');
    closers.push(() => db.close());
    const at = klInstant('2026-11-10', '10:00');
    ensureSeeded(db, 'test', at, 'sdm');
    const fund = must(listFunds(db, undefined, 'sdm')[0], 'a fund').id;
    const perihal = must(listPerihal(db, undefined, 'sdm').find((p) => p.direction === 'in'), 'an income perihal').id;
    // the row as the previous release left it: closed, with a report that has no `lateEntries` key
    const frozen = '{"ym":"2026-10","totals":{"inSen":10000,"outSen":2500},"frozen":true}';
    db.prepare(
      `INSERT INTO finance_months (surau_id, ym, status, closed_at, closed_by, report_json, updated_at, rev, edited_at, origin)
       VALUES ('sdm', '2026-10', 'closed', '2026-11-01T02:00:00.000Z', 'user:old', ?, '2026-11-01T02:00:00.000Z', '2026-11-01T02:00:00.000Z|old', '2026-11-01T02:00:00.000Z', 'local')`,
    ).run(frozen);
    expect(monthReportJson(db, '2026-10', 'sdm')).toBe(frozen);
    const before = must(listMonths(db, 'sdm').find((m) => m.ym === '2026-10'), 'October');
    expect(before.status).toBe('closed');
    expect(before).not.toHaveProperty('lateEntries');

    // an entry from the other side dated in that month: stored, flagged, and the frozen text does not change
    insertReplicatedEntry(db, { kind: 'in', entryDate: '2026-10-20', fundId: fund, perihalId: perihal, amountSen: 7000, method: 'bank', reference: 'FPX1' },
      'late1', 'user:u1', { surauId: 'sdm', now: at, role: 'box' }, { editedAt: '2026-10-20T04:00:00.000Z', origin: 'cloud' });
    expect(monthReportJson(db, '2026-10', 'sdm')).toBe(frozen);
    expect(must(listMonths(db, 'sdm').find((m) => m.ym === '2026-10'), 'October').lateEntries).toEqual(['late1']);
    // other months that were never closed stay without the key
    expect(listMonths(db, 'sdm').filter((m) => m.ym !== '2026-10').every((m) => !('lateEntries' in m))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('[PP-COMPAT] a YouTube sign-in made before the release', () => {
  it('[PP-COMPAT] a box keeps working on its old youtube-token.json, and a cloud clears the same file at start', async () => {
    const g = await startFakeGoogle();
    const h = await startLiveHarness({ app: { fetchImpl: g.fetchImpl } });
    closers.push(h.close, g.close);
    mkdirSync(join(h.dataDir, 'secret'), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(h.dataDir, 'secret', 'youtube-client.json'), JSON.stringify({ client_id: 'cid-123.apps.googleusercontent.com', client_secret: 'csecret-SECRET' }));
    const admin = await loginAs(h.app, 'admin');
    expect((await h.app.inject({ method: 'POST', url: '/api/live/youtube/signin', headers: admin.headers, remoteAddress: '10.168.1.20' })).statusCode).toBe(200);
    g.approve = true;
    h.clock.t += 6000;
    const done = await h.app.inject({ method: 'POST', url: '/api/live/youtube/signin/poll', headers: admin.headers, remoteAddress: '10.168.1.20' });
    expect(done.json()).toMatchObject({ signedIn: true });

    // the file is the one name every earlier release used; a box reads it with no per-surau name
    const tokenPath = join(h.dataDir, 'secret', 'youtube-token.json');
    expect(existsSync(tokenPath)).toBe(true);
    const again = createYoutubeService({ db: h.app.surau.db, dataDir: h.dataDir, fetchImpl: g.fetchImpl, now: h.clock.now });
    expect(again.signedIn()).toBe(true);
    expect(existsSync(join(h.dataDir, 'secret', 'youtube-token-sdm.json'))).toBe(false);

    // the same file on a cloud is the old shared sign-in: removed, never handed to a surau
    const cloudDir = mkdtempSync(join(tmpdir(), 'surau-rectcompat-cloud-'));
    dirs.push(cloudDir);
    mkdirSync(join(cloudDir, 'secret'), { recursive: true });
    copyFileSync(tokenPath, join(cloudDir, 'secret', 'youtube-token.json'));
    expect(readFileSync(join(cloudDir, 'secret', 'youtube-token.json')).length).toBeGreaterThan(0);
    const cloud = buildApp(join(cloudDir, 'cloud.db'), { dataDir: cloudDir, role: 'cloud', boxId: 'boxid0000' });
    apps.push(cloud);
    expect(existsSync(join(cloudDir, 'secret', 'youtube-token.json'))).toBe(false);
    const cloudAdmin = await loginAs(cloud, 'admin');
    expect((await cloud.inject({ method: 'GET', url: '/api/live/youtube/status', headers: cloudAdmin.headers })).json()).toMatchObject({ signedIn: false });
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('[PP-COMPAT] a surau already above 500 own hadis', () => {
  async function above(n: number): Promise<{ app: FastifyInstance; admin: Awaited<ReturnType<typeof loginAs>>; ids: string[] }> {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = `own-${String(i).padStart(4, '0')}`;
      ids.push(id);
      // a replicated write skips the own-save cap: how an older release let a surau grow past it
      putItem(app.surau.db, 'hadis', { id, textMs: `Hadis ${i}`, source: 'Riwayat Muslim', order: (i + 1) * 1000 }, 'old', { rev: `2026-11-09T01:00:00.000Z|seed${i}`, trusted: true }, 'sdm');
    }
    return { app, admin, ids };
  }

  it('[PP-COMPAT] 520 saved hadis open and list; reorder and edit still work; a new one is refused with hadis_full and limit_reached', async () => {
    const { app, admin, ids } = await above(520);
    const list = await app.inject({ method: 'GET', url: '/api/content/hadis', headers: admin.headers });
    expect(list.statusCode).toBe(200);
    expect((list.json().items as unknown[]).length).toBe(520);
    const order = await app.inject({ method: 'PUT', url: '/api/hadis/order', headers: admin.headers, payload: { ids: [...ids].reverse() } });
    expect(order.statusCode, order.body).toBe(200);
    expect(order.json()).toMatchObject({ ok: true, count: 520 });
    const edit = await app.inject({ method: 'PUT', url: `/api/content/hadis/${ids[7]}`, headers: admin.headers, payload: { textMs: 'Ubah', source: 'Riwayat Muslim', order: 8000 } });
    expect(edit.statusCode, edit.body).toBe(200);
    const add = await app.inject({ method: 'PUT', url: '/api/content/hadis/own-baru', headers: admin.headers, payload: { textMs: 'Baru', source: 'Riwayat Muslim', order: 1 } });
    expect(add.statusCode).toBe(409);
    expect(add.json()).toMatchObject({ code: 'hadis_full' });
    const provider = await app.inject({ method: 'POST', url: '/api/hadis/add', headers: admin.headers, payload: { provider: 'hadeethenc', id: '66512' } });
    expect(provider.statusCode).toBe(409);
    expect(provider.json()).toMatchObject({ code: 'limit_reached' });
    expect(listItems(app.surau.db, 'hadis', {}, 'sdm').length).toBe(520);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('[PP-COMPAT] a surau abroad', () => {
  const abroad = (app: FastifyInstance): void => {
    putFeature(app.surau.db, 'location', { country: 'GB', timezone: 'Europe/London', latitude: 51.5, longitude: -0.12, city: 'London' }, 'old', undefined, 'sdm');
  };

  it('[PP-COMPAT] with no TV language ever chosen the TV is English abroad and Malay in Malaysia; a language the surau chose is kept', () => {
    const app = makeApp();
    const settings = () => getSettings(app.surau.db, 'sdm');
    expect(tvLanguage(settings())).toBe('ms');
    abroad(app);
    expect(tvLanguage(settings())).toBe('en');
    putFeature(app.surau.db, 'language', { enabled: true, lang: 'ms' }, 'old', undefined, 'sdm');
    expect(tvLanguage(settings())).toBe('ms');
  });

  it('[PP-COMPAT] the official-source actions are refused with no_official_source and write nothing', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    abroad(app);
    const fetched = await app.inject({ method: 'POST', url: '/api/prayer/import', headers: admin.headers, payload: { zone: 'SGR01', year: 2026, source: 'esolat' } });
    expect(fetched.statusCode).toBe(409);
    expect(fetched.json()).toMatchObject({ code: 'no_official_source' });
    expect(Number(must(app.surau.db.prepare('SELECT COUNT(*) AS n FROM prayer_days').get(), 'count').n)).toBe(0);
  });
});

// a cloud made fresh also has no shared token to clear: starting it must not fail
describe('[PP-COMPAT] a cloud with no old token', () => {
  it('[PP-COMPAT] starts and answers signed out', async () => {
    const cloud = buildCloud('ab'.repeat(8));
    closers.push(cloud.close);
    const admin = await loginAs(cloud.app, 'admin');
    expect((await cloud.app.inject({ method: 'GET', url: '/api/live/youtube/status', headers: admin.headers })).json()).toMatchObject({ signedIn: false });
  });
});
