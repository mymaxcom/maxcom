import { createHash } from 'node:crypto';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { THEME_BUNDLE_FORMAT } from '@surau/core';
import { afterEach, describe, expect, it } from 'vitest';
import { themeOfferable } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { putAsset } from '../src/assets/store.ts';
import { runCloudLink } from '../src/cli/cloudLink.ts';
import { getSettings, putFeature } from '../src/settingsStore.ts';
import { THEMES_HEADER_VALUE } from '../src/sync/agent.ts';
import { issueLinkCode, noteThemeSupport } from '../src/sync/sites.ts';
import { loadSyncKey } from '../src/sync/syncKey.ts';
import { PACK_MIME } from '../src/themes/packFormat.ts';
import { loginAs } from './authHelpers.ts';
import { buildCloud, CLOUD_URL } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FakeWorker } from './support/fakeWorker.ts';
import { insertSite } from './support/sites.ts';
import { ensureSurau } from './support/surauRow.ts';
import { jpeg, manifestJson as json, woff2, zip } from './support/themePacks.ts';

interface Box { app: FastifyInstance; dir: string; boxId: string }
interface World { cloud: TestCloud; worker: FakeWorker; a: Box; b: Box; seen: Array<{ url: string; headers: Record<string, string> }> }
const worlds: World[] = [];
const extra: Box[] = [];

afterEach(async () => {
  for (const w of worlds.splice(0)) {
    for (const x of [w.a, w.b]) { await x.app.close().catch(() => undefined); rmSync(x.dir, { recursive: true, force: true }); }
    await w.cloud.close();
  }
  for (const x of extra.splice(0)) { await x.app.close().catch(() => undefined); rmSync(x.dir, { recursive: true, force: true }); }
});

/** Two boxes of one surau, both linked to one in-process cloud through a fake Worker. */
async function makeWorld(): Promise<World> {
  const seen: World['seen'] = [];
  let worker!: FakeWorker;
  const mk = async (cloud: TestCloud | null, name: string, preId?: string): Promise<{ box: Box; cloud: TestCloud }> => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-themesync-'));
    const app = buildApp(join(dir, 'box.db'), {
      dataDir: dir,
      sync: {
        fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => {
          const h: Record<string, string> = {};
          new Headers(n?.headers).forEach((v, k) => { h[k] = v; });
          seen.push({ url: String(i), headers: h });
          return worker.fetch(i, n);
        }) as typeof fetch,
        sleep: async () => undefined,
      },
    });
    const c = cloud ?? buildCloud(app.surau.boxId);
    if (cloud === null) worker = new FakeWorker(c.fetch);
    const { code } = issueLinkCode({ db: c.app.surau.db, now: () => new Date() }, { boxId: app.surau.boxId, name, target: { surauId: ensureSurau(c.app.surau.db, cloud === null ? 'sdm' : 'sdm-b') } });
    const lines: string[] = [];
    const exit = await runCloudLink(['--data', dir, '--db', join(dir, 'box.db'), 'link', CLOUD_URL, code], { out: (l) => lines.push(l), err: (l) => lines.push(l) }, worker.fetch);
    expect(exit, lines.join('\n')).toBe(0);
    worker.setSecret(app.surau.boxId, loadSyncKey(dir)!.wakeSecret);
    // Plan 14 allows one live box per surau for now, so the second box links into its own surau and is then moved
    // into the first one: the theme sync between sibling boxes of one surau is what these tests are about.
    if (cloud !== null) c.app.surau.db.prepare("UPDATE sites SET surau_id = 'sdm' WHERE box_id = ?").run(app.surau.boxId);
    void preId;
    return { box: { app, dir, boxId: app.surau.boxId }, cloud: c };
  };
  const first = await mk(null, 'Kotak A');
  const second = await mk(first.cloud, 'Kotak B');
  const w: World = { cloud: first.cloud, worker, a: first.box, b: second.box, seen };
  worlds.push(w);
  return w;
}

const run = (b: Box): Promise<void> => b.app.syncAgent!.runOnce();
const pack = (over: Record<string, unknown> = {}, more: Record<string, string | Buffer> = {}): Buffer => zip({
  'theme.json': json(over),
  'theme.css': '.stage{background:url(images/kuliah.jpg)} /* theme-marker */',
  'images/kuliah.jpg': jpeg(64, 36),
  ...more,
});
/** The address segment of an installed pack: the first 16 hex of the sha-256 of its file. */
const hashOfZip = (z: Buffer): string => createHash('sha256').update(z).digest('hex').slice(0, 16) + '-' + THEME_BUNDLE_FORMAT;
const H3 = hashOfZip(pack());
const H1 = hashOfZip(pack({ version: 1 }));

async function install(b: Box, z: Buffer): Promise<void> {
  const login = await loginAs(b.app, 'admin');
  const c = await b.app.inject({ method: 'POST', url: '/api/themes/check', headers: { ...login.headers, 'content-type': PACK_MIME }, payload: z });
  expect(c.json().report.ok, JSON.stringify(c.json().report.errors)).toBe(true);
  const i = await b.app.inject({ method: 'POST', url: '/api/themes/install', headers: login.headers, payload: { stagedId: c.json().stagedId } });
  expect(i.statusCode, i.body).toBe(201);
}
const get = (b: Box, url: string) => b.app.inject({ method: 'GET', url });

describe('theme packs through the cloud', () => {
  it('a pack installed on box A reaches the cloud and box B: record, asset, then files on first request', async () => {
    const w = await makeWorld();
    await install(w.a, pack());
    await run(w.a);
    expect(getSettings(w.cloud.app.surau.db, LOCAL_SURAU_ID).themeStyle.packs['hijau-siti']).toMatchObject({ version: 3 });
    await run(w.b);
    const rec = getSettings(w.b.app.surau.db, LOCAL_SURAU_ID).themeStyle.packs['hijau-siti']!;
    expect(rec).toMatchObject({ version: 3, base: 'creative' });
    const onA = await get(w.a, `/themes/hijau-siti/${H3}/bundle.css`);
    const onB = await get(w.b, `/themes/hijau-siti/${H3}/bundle.css`);
    expect(onA.statusCode).toBe(200);
    expect(onB.statusCode).toBe(200);
    expect(onB.body).toBe(onA.body);
    const imgA = await get(w.a, `/themes/hijau-siti/${H3}/images/kuliah.jpg`);
    const imgB = await get(w.b, `/themes/hijau-siti/${H3}/images/kuliah.jpg`);
    expect(imgB.rawPayload.equals(imgA.rawPayload)).toBe(true);
    // the cloud serves it too (the away preview)
    expect((await get({ app: w.cloud.app, dir: w.cloud.dir, boxId: '' }, `/themes/hijau-siti/${H3}/bundle.css`)).statusCode).toBe(200);
  });

  it('before the asset arrives the box answers 404 and the record is still there', async () => {
    const w = await makeWorld();
    const z = pack();
    // the record alone (the settings entry arrives before the file in a slow cycle)
    const meta = putAsset(w.a.app.surau.db, w.a.dir, z, PACK_MIME, 'u');
    putFeature(w.b.app.surau.db, 'themeStyle', { packs: { 'hijau-siti': { assetId: meta.id, version: 3, title: 'Hijau Siti', base: 'creative', contract: 1, bytes: z.length, fonts: [], screens: [], images: { kuliah: 'jpg' }, defaults: {} } } }, 'sync', undefined, LOCAL_SURAU_ID);
    expect((await get(w.b, `/themes/hijau-siti/${H3}/bundle.css`)).statusCode).toBe(404);
    expect(getSettings(w.b.app.surau.db, LOCAL_SURAU_ID).themeStyle.packs['hijau-siti']).toBeDefined();
    putAsset(w.b.app.surau.db, w.b.dir, z, PACK_MIME, 'sync');
    expect((await get(w.b, `/themes/hijau-siti/${H3}/bundle.css`)).statusCode).toBe(200);
  });

  it('a synced pack this box finds invalid is not served and names its problem', async () => {
    const w = await makeWorld();
    const bad = zip({ 'theme.json': json(), 'theme.css': '@import "https://x.example/a.css";' });
    const meta = putAsset(w.cloud.app.surau.db, w.cloud.dir, bad, PACK_MIME, 'cloud');
    putFeature(w.cloud.app.surau.db, 'themeStyle', { packs: { 'hijau-siti': { assetId: meta.id, version: 3, title: 'Hijau Siti', base: 'creative', contract: 1, bytes: bad.length, fonts: [], screens: [], images: {}, defaults: {} } } }, 'cloud', undefined, LOCAL_SURAU_ID);
    await run(w.b);
    expect(getSettings(w.b.app.surau.db, LOCAL_SURAU_ID).themeStyle.packs['hijau-siti']).toBeDefined();
    expect((await get(w.b, `/themes/hijau-siti/${H3}/bundle.css`)).statusCode).toBe(404);
    expect((await get(w.b, `/themes/hijau-siti/${H3}/images/kuliah.jpg`)).statusCode).toBe(404);
    expect(readFileSync(join(w.b.dir, 'assets', `${meta.id}.maxtheme`)).length).toBe(bad.length);
  });

  it('a delete on A removes the record on B; B stops serving the files', async () => {
    const w = await makeWorld();
    await install(w.a, pack());
    await run(w.a);
    await run(w.b);
    expect((await get(w.b, `/themes/hijau-siti/${H3}/bundle.css`)).statusCode).toBe(200);
    const login = await loginAs(w.a.app, 'admin');
    expect((await w.a.app.inject({ method: 'DELETE', url: '/api/themes/hijau-siti', headers: login.headers })).statusCode).toBe(204);
    await run(w.a);
    await run(w.b);
    expect(getSettings(w.cloud.app.surau.db, LOCAL_SURAU_ID).themeStyle.packs['hijau-siti']).toBeUndefined();
    expect(getSettings(w.b.app.surau.db, LOCAL_SURAU_ID).themeStyle.packs['hijau-siti']).toBeUndefined();
    expect((await get(w.b, `/themes/hijau-siti/${H3}/bundle.css`)).statusCode).toBe(404);
    // and the same name can be installed again, at any version
    await install(w.a, pack({ version: 1 }));
    await run(w.a);
    await run(w.b);
    expect(getSettings(w.b.app.surau.db, LOCAL_SURAU_ID).themeStyle.packs['hijau-siti']).toMatchObject({ version: 1 });
    expect((await get(w.b, `/themes/hijau-siti/${H1}/bundle.css`)).statusCode).toBe(200);
  });

  it('on the cloud role the theme routes of a box are 404 for an admin: check, install, delete, pack download, health report', async () => {
    const w = await makeWorld();
    const admin = await loginAs(w.cloud.app, 'admin');
    const z = pack();
    for (const [method, url, extra] of [
      ['POST', '/api/themes/check', { 'content-type': PACK_MIME }],
      ['POST', '/api/themes/install', {}],
      ['DELETE', '/api/themes/hijau-siti', {}],
      ['GET', '/api/themes/creative/pack?as=a-b', {}],
      ['GET', `/api/themes/staged/${'a'.repeat(32)}/bundle.css`, {}],
      ['POST', '/api/kiosk/theme-health', {}],
      // S6: the same routes written with a percent-encoded letter or a doubled slash
      ['POST', '/api/%74hemes/check', { 'content-type': PACK_MIME }],
      ['POST', '/api/%74hemes/install', {}],
      ['DELETE', '/api/%74hemes/hijau-siti', {}],
      ['GET', '/api/%74hemes/creative/pack?as=a-b', {}],
      ['POST', '/api/kiosk/%74heme-health', {}],
      ['POST', '//api/themes/check', { 'content-type': PACK_MIME }],
    ] as const) {
      const r = await w.cloud.app.inject({ method, url, headers: { ...admin.headers, ...extra }, payload: method === 'POST' ? (extra['content-type'] === undefined ? { stagedId: 'a'.repeat(32) } : z) : undefined });
      expect(r.statusCode, `${method} ${url}`).toBe(404);
    }
    // nothing was staged or stored by those calls, and the cloud still relays what a box syncs
    await install(w.a, z);
    await run(w.a);
    expect(getSettings(w.cloud.app.surau.db, LOCAL_SURAU_ID).themeStyle.packs['hijau-siti']).toMatchObject({ version: 3 });
    // support stays available (the app asks the cloud which contract each box supports)
    expect((await w.cloud.app.inject({ method: 'GET', url: '/api/themes/support', headers: admin.headers })).statusCode).toBe(200);
    // and a box still answers these (it is where themes are made)
    const onBox = await loginAs(w.a.app, 'admin');
    expect((await w.a.app.inject({ method: 'POST', url: '/api/themes/check', headers: { ...onBox.headers, 'content-type': PACK_MIME }, payload: pack({ version: 9 }) })).statusCode).toBe(200);
  });

  it('every request the agent sends carries the themes header', async () => {
    const w = await makeWorld();
    await run(w.a);
    const toCloud = w.seen.filter((s) => s.url.startsWith(CLOUD_URL) && s.headers.authorization !== undefined);
    expect(toCloud.length).toBeGreaterThanOrEqual(3);
    expect(toCloud.some((s) => s.url.endsWith('/api/sync/theme-support'))).toBe(true);
    for (const s of toCloud) expect(s.headers['x-maxcom-themes'], s.url).toBe(THEMES_HEADER_VALUE);
    expect(THEMES_HEADER_VALUE).toBe('1;default,colourful,creative,oldschool,minimal,arabic');
  });
});

describe('which boxes support which contract', () => {
  it('the cloud records each box contract from the header and lists it', async () => {
    const w = await makeWorld();
    await run(w.a);
    await run(w.b);
    const admin = await loginAs(w.cloud.app, 'admin');
    const r = await w.cloud.app.inject({ method: 'GET', url: '/api/themes/support', headers: admin.headers });
    expect(r.statusCode).toBe(200);
    const s = r.json();
    expect(s).toMatchObject({ contract: 1, complete: true });
    expect(s.boxes).toHaveLength(2);
    for (const b of s.boxes) expect(b).toMatchObject({ contract: 1, builtIn: ['default', 'colourful', 'creative', 'oldschool', 'minimal', 'arabic'] });
    expect(s.boxes.map((b: { name: string }) => b.name).sort()).toEqual(['Kotak A', 'Kotak B']);
  });

  it('a box that never sent the header is listed with contract null; a malformed header is ignored', async () => {
    const w = await makeWorld();
    const old = insertSite(w.cloud.app.surau.db, { boxId: 'ab'.repeat(8), surauId: 'sdm' });
    noteThemeSupport(w.cloud.app.surau.db, old.boxId, 'not a header');
    noteThemeSupport(w.cloud.app.surau.db, old.boxId, '1;DEFAULT');
    noteThemeSupport(w.cloud.app.surau.db, old.boxId, `1;${'a'.repeat(300)}`);
    noteThemeSupport(w.cloud.app.surau.db, old.boxId, 12);
    await run(w.a);
    const admin = await loginAs(w.cloud.app, 'admin');
    const s = (await w.cloud.app.inject({ method: 'GET', url: '/api/themes/support', headers: admin.headers })).json();
    const o = s.boxes.find((b: { boxId: string }) => b.boxId === old.boxId);
    expect(o).toMatchObject({ contract: null, builtIn: [] });
    expect(themeOfferable(s, { contract: 1 })).toBe(false);
    // when it reports, it counts
    noteThemeSupport(w.cloud.app.surau.db, old.boxId, '1;default,creative');
    const s2 = (await w.cloud.app.inject({ method: 'GET', url: '/api/themes/support', headers: admin.headers })).json();
    expect(s2.boxes.find((b: { boxId: string }) => b.boxId === old.boxId)).toMatchObject({ contract: 1, builtIn: ['default', 'creative'] });
  });

  it('a linked box answers complete:false until it has a fresh sibling list, then true; then false again when it is a day old', async () => {
    const w = await makeWorld();
    const admin = await loginAs(w.a.app, 'admin');
    const ask = async (): Promise<{ complete: boolean; boxes: Array<{ boxId: string; contract: number | null; builtIn: string[] }> }> =>
      (await w.a.app.inject({ method: 'GET', url: '/api/themes/support', headers: admin.headers })).json();
    const before = await ask();
    expect(before.complete).toBe(false);
    expect(before.boxes).toHaveLength(1);
    await run(w.a);
    const after = await ask();
    expect(after.complete).toBe(true);
    expect(after.boxes.map((b) => b.boxId).sort()).toEqual([w.a.boxId, w.b.boxId].sort());
    // B has not reported a contract yet: its entry is null here, so nothing is offered
    expect(after.boxes.find((b) => b.boxId === w.b.boxId)!.contract).toBeNull();
    expect(themeOfferable(after, { contract: 1 })).toBe(false);
    await run(w.b);
    await run(w.a);
    expect(themeOfferable(await ask(), { contract: 1 })).toBe(true);
    // a stale list is not complete
    w.a.app.surau.db.prepare("UPDATE sync_state SET value = ? WHERE key = 'theme_support_at'").run(new Date(Date.now() - 25 * 3600_000).toISOString());
    expect((await ask()).complete).toBe(false);
  });

  it('a box that is not linked lists itself and is complete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-themesolo-'));
    const app = buildApp(join(dir, 'box.db'), { dataDir: dir });
    extra.push({ app, dir, boxId: app.surau.boxId });
    const admin = await loginAs(app, 'admin');
    const s = (await app.inject({ method: 'GET', url: '/api/themes/support', headers: admin.headers })).json();
    expect(s).toMatchObject({ complete: true, contract: 1 });
    expect(s.boxes).toEqual([{ boxId: app.surau.boxId, name: expect.any(String), contract: 1, builtIn: ['default', 'colourful', 'creative', 'oldschool', 'minimal', 'arabic'] }]);
  });

  it('a site token may call theme-support and nothing new besides; a device session and a box get 404', async () => {
    const w = await makeWorld();
    const site = insertSite(w.cloud.app.surau.db, { boxId: 'cd'.repeat(8) });
    const ok = await w.cloud.app.inject({ method: 'GET', url: '/api/sync/theme-support', headers: site.headers });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().boxes.length).toBeGreaterThanOrEqual(3);
    for (const [method, url] of [['GET', '/api/themes/support'], ['POST', '/api/themes/check'], ['POST', '/api/themes/install'], ['DELETE', '/api/themes/x-y'], ['GET', '/api/themes/creative/pack?as=a-b'], ['GET', `/themes/x/${H1}/bundle.css`], ['GET', '/api/settings']] as const) {
      expect((await w.cloud.app.inject({ method, url, headers: site.headers })).statusCode, `${method} ${url}`).toBe(403);
    }
    const admin = await loginAs(w.cloud.app, 'admin');
    expect((await w.cloud.app.inject({ method: 'GET', url: '/api/sync/theme-support', headers: admin.headers })).statusCode).toBe(404);
    expect((await w.a.app.inject({ method: 'GET', url: '/api/sync/theme-support', headers: (await loginAs(w.a.app, 'admin')).headers })).statusCode).toBe(404);
    expect((await w.cloud.app.inject({ method: 'GET', url: '/api/sync/theme-support', remoteAddress: '10.4.4.4' })).statusCode).toBe(401);
  });

  it('the cloud accepts a pack asset from a linked box and refuses a lie about the type', async () => {
    const w = await makeWorld();
    const site = insertSite(w.cloud.app.surau.db, { boxId: 'ef'.repeat(8) });
    const z = pack();
    const id = putAsset(w.a.app.surau.db, w.a.dir, z, PACK_MIME, 'u').id;
    const put = (body: Buffer, type: string, asset = id) => w.cloud.app.inject({ method: 'PUT', url: `/api/sync/assets/${asset}`, headers: { ...site.headers, 'content-type': type }, payload: body });
    expect((await put(z, PACK_MIME)).statusCode).toBe(201);
    expect((await put(z, PACK_MIME)).statusCode).toBe(200);
    expect((await put(Buffer.from('not a zip at all, not a zip at all'), PACK_MIME, 'b'.repeat(64))).statusCode).toBe(400);
    expect((await put(woff2(300), 'font/woff2', 'c'.repeat(64))).statusCode).toBe(415); // a font is no asset type any more
    expect((await put(z, 'application/zip')).statusCode).toBeGreaterThanOrEqual(400);
  });
});
