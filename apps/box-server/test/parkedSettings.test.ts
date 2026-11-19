import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { runCloudLink } from '../src/cli/cloudLink.ts';
import { getSettings, putFeature } from '../src/settingsStore.ts';
import { issueLinkCode } from '../src/sync/sites.ts';
import { loadSyncKey } from '../src/sync/syncKey.ts';
import { buildCloud, CLOUD_URL } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FakeWorker } from './support/fakeWorker.ts';
import { ensureSurau } from './support/surauRow.ts';

/**
 * A mixed rollout: a settings entry one side refuses as `invalid` (the TV language `ar` sent to an older cloud, or an
 * entry from a newer cloud that an older box refuses) is parked, and tried again once either side's software version
 * changes. A newer edit still wins; a re-refusal stays parked; old rows are dropped; the cloud lists `tvLangAr` for a
 * surau only when its box has reported it.
 */

const tok = vi.hoisted(() => ({ v: '2026.11.12;b0' }));
vi.mock('../src/productVersion.ts', async (orig) => ({ ...(await orig<typeof import('../src/productVersion.ts')>()), softwareToken: () => tok.v }));

interface Rig {
  box: FastifyInstance;
  cloud: TestCloud;
  boxId: string;
  /** The cloud acts as the older build: it refuses `lang: ar`, and says nothing about its version. */
  oldCloud: { on: boolean };
  /** What the cloud's answers say about its version (X-Maxcom-Server); null leaves the answer as it is. */
  peer: { v: string | null };
  /** The box acts as the older build: it cannot read the `language` entry the cloud sends (its `lang` is changed to xx). */
  oldBox: { on: boolean; original: unknown };
  /** Request bodies of every push that carried a language entry. */
  arPushes: string[];
  /** Reports the box sends in the features header, per request (null = header stripped, an older box). */
  stripFeatures: { on: boolean };
}

const rigs: Array<{ box: FastifyInstance; cloud: TestCloud; dir: string }> = [];
afterEach(async () => {
  tok.v = '2026.11.12;b0';
  for (const r of rigs.splice(0)) {
    await r.box.close().catch(() => undefined);
    await r.cloud.close();
    rmSync(r.dir, { recursive: true, force: true });
  }
});

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

async function rig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'surau-parked-'));
  const hook = { fetch: undefined as unknown as typeof fetch };
  const box = buildApp(join(dir, 'box.db'), { dataDir: dir, sync: { fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => hook.fetch(i, n)) as typeof fetch, sleep: async () => undefined } });
  const boxId = box.surau.boxId;
  const cloud = buildCloud(boxId);
  const worker = new FakeWorker(cloud.fetch);
  const r: Rig = { box, cloud, boxId, oldCloud: { on: false }, peer: { v: null }, oldBox: { on: false, original: null }, arPushes: [], stripFeatures: { on: false } };
  rigs.push({ box, cloud, dir });
  hook.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    let init2 = init;
    let refusedHere = 0;
    if (r.stripFeatures.on && init?.headers !== undefined) {
      const h = new Headers(init.headers);
      h.delete('x-maxcom-features');
      init2 = { ...init, headers: h };
    }
    if (init?.method === 'POST' && url.pathname === '/api/sync/ops' && typeof init.body === 'string') {
      const body = JSON.parse(init.body) as { entries: Array<{ entity: string; after: { lang?: string } | null }> };
      const isAr = (e: { entity: string; after: { lang?: string } | null }): boolean => e.entity === 'settings' && e.after?.lang === 'ar';
      if (body.entries.some((e) => e.entity === 'settings' && e.after !== null && 'lang' in e.after)) r.arPushes.push(init.body);
      if (r.oldCloud.on && body.entries.some(isAr)) {
        refusedHere = body.entries.filter(isAr).length;
        init2 = { ...(init2 ?? {}), body: JSON.stringify({ entries: body.entries.filter((e) => !isAr(e)) }) };
      }
    }
    const res = await worker.fetch(input, init2);
    const headers = new Headers(res.headers);
    if (r.oldCloud.on) headers.delete('x-maxcom-server');
    if (r.peer.v !== null) headers.set('x-maxcom-server', r.peer.v);
    let text: string | null = res.status === 204 ? null : await res.text();
    if (text !== null && refusedHere > 0) {
      const j = JSON.parse(text) as { refused: number; reasons: string[] };
      j.refused += refusedHere;
      for (let i = 0; i < refusedHere; i++) j.reasons.push('invalid');
      text = JSON.stringify(j);
    }
    if (text !== null && r.oldBox.on && url.pathname === '/api/sync/changes') {
      const j = JSON.parse(text) as { entries: Array<{ entity: string; entityId: string; after: { lang?: string } }> };
      for (const e of j.entries) {
        if (e.entity === 'settings' && e.entityId === 'language' && e.after.lang === 'ar') {
          r.oldBox.original = JSON.parse(JSON.stringify(e));
          e.after.lang = 'xx';
        }
      }
      text = JSON.stringify(j);
    }
    return new Response(text, { status: res.status, headers });
  }) as typeof fetch;
  const { code } = issueLinkCode({ db: cloud.app.surau.db, now: () => new Date() }, { boxId, name: 'Surau Contoh', target: { surauId: ensureSurau(cloud.app.surau.db) } });
  const lines: string[] = [];
  expect(await runCloudLink(['--data', dir, '--db', join(dir, 'box.db'), 'link', CLOUD_URL, code], { out: (l) => lines.push(l), err: (l) => lines.push(l) }, worker.fetch)).toBe(0);
  worker.setSecret(boxId, loadSyncKey(dir)!.wakeSecret);
  box.surau.db.prepare("INSERT INTO sync_state (key, value) VALUES ('youtube_handover', '{\"state\":\"done\"}')").run();
  return r;
}

const langOf = (app: FastifyInstance): string | undefined => (getSettings(app.surau.db, 'sdm').language as { lang?: string }).lang;
const parked = (app: FastifyInstance): number => Number(app.surau.db.prepare('SELECT COUNT(*) AS n FROM parked_settings').get()?.n ?? 0);
const setLang = (app: FastifyInstance, lang: string): void => void putFeature(app.surau.db, 'language', { enabled: true, lang }, 'local', undefined, 'sdm');

describe('a settings entry the cloud refuses as invalid is parked on the box (Q2)', () => {
  it('Arabic sent to an older cloud is parked, not sent again until a version changes, then taken once the cloud is upgraded', async () => {
    const r = await rig();
    r.oldCloud.on = true;
    setLang(r.box, 'ar');
    await r.box.syncAgent!.runOnce();
    // refused once, parked with its stamp, counted in the sync status, and the cloud still has the old language
    expect(parked(r.box)).toBe(1);
    expect(r.box.syncAgent!.status().parked).toBe(1);
    expect(langOf(r.cloud.app)).not.toBe('ar');
    expect(langOf(r.box)).toBe('ar');
    const sent = r.arPushes.length;
    // nothing changed on either side: no new try, still parked
    await r.box.syncAgent!.runOnce();
    await r.box.syncAgent!.runOnce();
    expect(r.arPushes.length).toBe(sent);
    expect(parked(r.box)).toBe(1);
    // the cloud is upgraded (its answers now carry a new version): the entry goes again and is taken
    r.oldCloud.on = false;
    r.peer.v = '2026.11.13;b0';
    await r.box.syncAgent!.runOnce();
    expect(langOf(r.cloud.app)).toBe('ar');
    expect(parked(r.box)).toBe(0);
    expect(r.box.syncAgent!.status().parked).toBe(0);
    // and it is not sent again
    const after = r.arPushes.length;
    await r.box.syncAgent!.runOnce();
    expect(r.arPushes.length).toBe(after);
  });

  it('the cloud still refusing after a version change keeps the entry parked (a re-refusal stays)', async () => {
    const r = await rig();
    r.oldCloud.on = true;
    setLang(r.box, 'ar');
    await r.box.syncAgent!.runOnce();
    expect(parked(r.box)).toBe(1);
    r.peer.v = '2026.11.12;b1';
    await r.box.syncAgent!.runOnce();
    expect(parked(r.box)).toBe(1);
    expect(langOf(r.cloud.app)).not.toBe('ar');
  });

  it('a newer local edit wins over the parked one when the cloud is upgraded', async () => {
    const r = await rig();
    r.oldCloud.on = true;
    setLang(r.box, 'ar');
    await r.box.syncAgent!.runOnce();
    expect(parked(r.box)).toBe(1);
    await sleep(15);
    setLang(r.box, 'ms');
    await r.box.syncAgent!.runOnce();
    expect(langOf(r.cloud.app)).toBe('ms');
    r.oldCloud.on = false;
    r.peer.v = '2026.11.13;b0';
    await r.box.syncAgent!.runOnce();
    // the parked Arabic is older than the Malay edit: the cloud keeps Malay and the box too
    expect(langOf(r.cloud.app)).toBe('ms');
    expect(langOf(r.box)).toBe('ms');
    expect(parked(r.box)).toBe(0);
  });

  it('parked entries older than 60 days are dropped', async () => {
    const r = await rig();
    r.oldCloud.on = true;
    setLang(r.box, 'ar');
    await r.box.syncAgent!.runOnce();
    expect(parked(r.box)).toBe(1);
    r.box.surau.db.prepare('UPDATE parked_settings SET parked_at = ?').run(new Date(Date.now() - 61 * 86_400_000).toISOString());
    await r.box.syncAgent!.runOnce();
    expect(parked(r.box)).toBe(0);
  });
});

describe('a settings entry this box refuses from a newer cloud is parked and applied after the box is upgraded (M1)', () => {
  it('parks the pulled entry, keeps it through a re-refusal, applies it once this box can read it', async () => {
    const r = await rig();
    await r.box.syncAgent!.runOnce();
    // the cloud (new build) holds Arabic; the older box cannot read it
    r.oldBox.on = true;
    setLang(r.cloud.app, 'ar');
    await r.box.syncAgent!.runOnce();
    expect(parked(r.box)).toBe(1);
    expect(langOf(r.box)).not.toBe('ar');
    // this box changes build but still cannot read it: it stays parked
    tok.v = '2026.11.12;b1';
    await r.box.syncAgent!.runOnce();
    expect(parked(r.box)).toBe(1);
    // the box is upgraded: the parked entry is the cloud's real one (the older build had only mangled the copy it read)
    r.oldBox.on = false;
    r.box.surau.db.prepare("UPDATE parked_settings SET entry_json = ? WHERE direction = 'pull'").run(JSON.stringify(r.oldBox.original));
    tok.v = '2026.11.13;b0';
    await r.box.syncAgent!.runOnce();
    expect(langOf(r.box)).toBe('ar');
    expect(parked(r.box)).toBe(0);
  });
});

describe('the cloud lists tvLangAr for a surau only when its box reported it (Q2b)', () => {
  const featuresOf = async (r: Rig): Promise<string[]> =>
    (await r.cloud.app.inject({ method: 'GET', url: '/api/health', headers: { 'x-maxcom-box': r.boxId } })).json().features as string[];

  it('not before the box reported, not for a box that never sends the header, yes once it does', async () => {
    const r = await rig();
    expect(await featuresOf(r)).toEqual(['video', 'posterStretch']);
    r.stripFeatures.on = true;
    await r.box.syncAgent!.runOnce();
    expect(await featuresOf(r)).toEqual(['video', 'posterStretch']);
    r.stripFeatures.on = false;
    await r.box.syncAgent!.runOnce();
    expect(await featuresOf(r)).toEqual(['video', 'posterStretch', 'tvLangAr']);
    // a caller that names no box gets the neutral answer: no Arabic
    expect(((await r.cloud.app.inject({ method: 'GET', url: '/api/health' })).json().features as string[])).toEqual(['video', 'posterStretch']);
    // a box always lists its own features
    expect(((await r.box.inject({ method: 'GET', url: '/api/health' })).json().features as string[])).toEqual(['video', 'posterStretch', 'tvLangAr']);
  });
});
