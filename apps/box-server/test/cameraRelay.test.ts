import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { klInstant } from '@surau/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CameraStore } from '../src/live/camera.ts';
import { openFromCloud, relayAad, sealToBox } from '../src/sync/cameraRelayCrypto.ts';
import { CameraSecretSync } from '../src/sync/cameraSecretBox.ts';
import { generateSyncKeyPair, loadSyncKey, saveSyncKey } from '../src/sync/syncKey.ts';
import { loginAs } from './authHelpers.ts';
import { buildCloud, CLOUD_URL } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';
import { insertSite } from './support/sites.ts';
import type { TestSite } from './support/sites.ts';

const PASSWORD = 'jauh123Rahsia';
const BOX_ID = 'aaaa000000000001';
const ROUTE = '/api/live/camera';
const RELAY = '/api/sync/camera-relay';
const ADDRESS = 'rtsp://10.168.1.20:554/main';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0)) await c();
});

interface Rig {
  cloud: TestCloud;
  h: LiveHarness;
  site: TestSite;
  sync: CameraSecretSync;
  publicJwk: Record<string, unknown>;
  logs: string[];
  admin: { authorization: string };
}

async function rig(): Promise<Rig> {
  const clock = { t: klInstant('2026-11-19', '10:00').getTime(), now: (): Date => new Date(clock.t) };
  const cloud = buildCloud('boxid0001', { now: clock.now });
  closers.push(cloud.close);
  const logs: string[] = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
  }
  const h = await startLiveHarness({ app: { cloud: { url: CLOUD_URL }, sync: { auto: false, fetchImpl: cloud.fetch } } });
  closers.push(h.close);
  const site = insertSite(cloud.app.surau.db, { boxId: BOX_ID, surauId: 'sdm' });
  const pair = generateSyncKeyPair();
  saveSyncKey(h.dataDir, { ...pair, cloudUrl: CLOUD_URL, siteToken: site.token, wakeSecret: 'wake-secret-1', linkedAt: '2026-11-05T00:00:00.000Z' });
  cloud.app.surau.db.prepare('UPDATE sites SET public_jwk = ? WHERE box_id = ?').run(JSON.stringify(pair.publicJwk), BOX_ID);
  const sync = new CameraSecretSync({ db: h.app.surau.db, dataDir: h.dataDir, now: clock.now, boxIps: ['10.168.1.40'], fetchImpl: cloud.fetch, boxId: BOX_ID, auto: false });
  const admin = await loginAs(cloud.app, 'live');
  return { cloud, h, site, sync, publicJwk: pair.publicJwk as Record<string, unknown>, logs, admin: admin.headers };
}

const cloudDb = (r: Rig) => r.cloud.app.surau.db;
const get = (r: Rig) => r.cloud.app.inject({ method: 'GET', url: ROUTE, headers: r.admin });
const put = (r: Rig, payload: object) => r.cloud.app.inject({ method: 'PUT', url: ROUTE, headers: r.admin, payload });
const storeOf = (r: Rig) => new CameraStore(r.h.dataDir).get();

/** What the phone does: reads the number and the box key, seals, sends. */
async function phoneSave(r: Rig, record: Record<string, unknown>, over: { boxId?: string; seq?: number } = {}) {
  const view = (await get(r)).json() as { relay: { boxId: string; key: Record<string, string>; seq: number } };
  const seq = over.seq ?? view.relay.seq;
  const boxId = over.boxId ?? view.relay.boxId;
  const sealed = sealToBox(view.relay.key, JSON.stringify({ seq, boxId, ...record }), relayAad(boxId, seq));
  return { res: await put(r, { boxId, seq, sealed }), sealed, seq };
}

describe('the phone and the box agree on the seal', () => {
  it('opens a value the phone (Dart) sealed', () => {
    // made by apps/surau-app/test/sync/camera_relay_seal_test.dart with the fixed box key below
    const priv = { kty: 'EC', crv: 'P-256', x: '_3cj-DakG4KtizzNP0ZmsiA6N2jVMtLgLYY9iZNxEUg', y: 'RsoTz1uetxQljH94us22AGtsGHfpQERE_jECHeqtlN0', d: 'Mgiv-LvGFamfSh93EKF5BuhllvQSDIO-GKY9TTdPZ98' };
    const sealed =
      'e1.BA1LxddiyBKjCXzDI2sJh8taYb4Mm7-jKLkg5phE0QksLS83wcPaAoovMnnGim-b_kQfgzD-YPFdglxNekwjttE.CvgZ11Jd2LDRPgVm.JqNz8pA7gSH5XfgnSuS80-brT1K-_8gvirrCg6yJuNHH09QzU7lqAVqy95SIL0Q_zpg57SuWM1d213SogL4MKolA7pxoPQkDwc7IwjwSE9E3PByFICQFrv8rGkpcvl2j3vZF5leLZWPj8Ty-PrmdD95VTFw.jkPR9WjgZ-KbBgJvhv3zJw';
    const plain = '{"seq":7,"boxId":"aaaa000000000001","url":"rtsp://10.168.1.20:554/main","username":"viewer","password":"p@ss w0rd"}';
    expect(openFromCloud(priv, sealed, relayAad('aaaa000000000001', 7))).toBe(plain);
  });
});

describe('camera set from anywhere (sealed relay)', () => {
  it('saves through the cloud: the cloud cannot read it, the box applies it, the acknowledgement clears pending', async () => {
    const r = await rig();
    const first = (await get(r)).json();
    expect(first).toMatchObject({ configured: false, pending: false, relay: { boxId: BOX_ID, seq: 1 } });

    const { res, sealed } = await phoneSave(r, { url: ADDRESS, username: 'viewer', password: PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pending: true });
    // nothing the cloud sent or kept shows the login
    for (const text of [res.body, (await get(r)).body, JSON.stringify(cloudDb(r).prepare('SELECT * FROM camera_relay').all()), JSON.stringify(cloudDb(r).prepare('SELECT * FROM change_log').all())]) {
      for (const secret of [PASSWORD, 'viewer', '10.168.1.20']) expect(text).not.toContain(secret);
    }
    cloudDb(r).exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const file = readFileSync(join(r.cloud.dir, 'cloud.db')).toString('latin1');
    expect(file).not.toContain(PASSWORD);
    // a key that is not the box's does not open it
    expect(() => openFromCloud(generateSyncKeyPair().privateJwk, sealed, relayAad(BOX_ID, 1))).toThrow();
    // and the box's key opens it only under the right box and number
    const mine = loadSyncKey(r.h.dataDir)!.privateJwk;
    expect(() => openFromCloud(mine, sealed, relayAad(BOX_ID, 2))).toThrow();
    expect(() => openFromCloud(mine, sealed, relayAad('bbbb000000000002', 1))).toThrow();

    expect(storeOf(r)).toBeNull();
    expect(await r.sync.relayPoll()).toBe('applied');
    expect(storeOf(r)).toEqual({ url: ADDRESS, username: 'viewer', password: PASSWORD });

    const after = (await get(r)).json() as Record<string, unknown>;
    expect(after).toMatchObject({ configured: true, pending: false, failure: null, username: 'viewer', hasPassword: true, url: ADDRESS, relay: { seq: 2 } });
    expect(JSON.stringify(after)).not.toContain(PASSWORD);
    // never in a log line of either side
    expect(r.logs.join('\n')).not.toContain(PASSWORD);
    // nothing waits any more
    expect(await r.sync.relayPoll()).toBe('none');
  });

  it('GET over the cloud shows the masked address of a camera set at the surau, never the password', async () => {
    const r = await rig();
    new CameraStore(r.h.dataDir, { boxIps: [] }).save({ url: `rtsp://viewer:${PASSWORD}@10.168.1.20:554/main` });
    expect(await r.sync.push()).toBe('stored');
    const v = (await get(r)).json() as Record<string, unknown>;
    expect(v).toMatchObject({ configured: true, username: 'viewer', hasPassword: true, url: 'rtsp://10.168.1.20:554/main' });
    expect(JSON.stringify(v)).not.toContain(PASSWORD);
  });

  it('a stale number or another box is refused, so an old value cannot be played again', async () => {
    const r = await rig();
    const one = await phoneSave(r, { url: ADDRESS });
    expect(one.res.statusCode).toBe(200);
    // the same sealed value again (number 1 is no longer the next one)
    const again = await put(r, { boxId: BOX_ID, seq: 1, sealed: one.sealed });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('stale');
    // a value for another box id
    const other = await phoneSave(r, { url: ADDRESS }, { boxId: 'bbbb000000000002', seq: 2 });
    expect(other.res.statusCode).toBe(409);
    // malformed bodies
    for (const bad of [{}, { boxId: BOX_ID, seq: 2, sealed: 'x' }, { boxId: BOX_ID, seq: 2, sealed: one.sealed, extra: 1 }, { boxId: BOX_ID, seq: '2', sealed: one.sealed }]) {
      expect((await put(r, bad)).statusCode).toBe(400);
    }
    expect(await r.sync.relayPoll()).toBe('applied');
  });

  it('the box never applies a number it already applied, even if the cloud plays an old value back', async () => {
    const r = await rig();
    const one = await phoneSave(r, { url: 'rtsp://10.168.1.20:554/one' });
    expect(await r.sync.relayPoll()).toBe('applied');
    const two = await phoneSave(r, { url: 'rtsp://10.168.1.20:554/two' });
    expect(two.seq).toBe(2);
    expect(await r.sync.relayPoll()).toBe('applied');
    expect(storeOf(r)?.url).toBe('rtsp://10.168.1.20:554/two');

    // a hostile or faulty cloud puts value 1 back as pending, under number 1 and then under number 3
    const db = cloudDb(r);
    db.prepare("UPDATE camera_relay SET seq = 1, sealed = ?, state = 'pending'").run(one.sealed);
    // refused and answered as stale, so the phone sees a refusal instead of waiting for ever; nothing applied
    expect(await r.sync.relayPoll()).toBe('refused');
    expect(db.prepare('SELECT state, code FROM camera_relay').get()).toMatchObject({ state: 'failed', code: 'stale' });
    expect(storeOf(r)?.url).toBe('rtsp://10.168.1.20:554/two');
    // the number already applied is answered again but changes nothing
    db.prepare("UPDATE camera_relay SET seq = 2, sealed = ?, state = 'pending'").run(one.sealed);
    expect(await r.sync.relayPoll()).toBe('applied');
    expect(storeOf(r)?.url).toBe('rtsp://10.168.1.20:554/two');
    // a higher number whose seal is bound to number 1 does not open
    db.prepare("UPDATE camera_relay SET seq = 3, sealed = ?, state = 'pending'").run(one.sealed);
    expect(await r.sync.relayPoll()).toBe('refused');
    expect(storeOf(r)?.url).toBe('rtsp://10.168.1.20:554/two');
  });

  it('another surau cannot reach it: no site, no queue; its site cannot read or acknowledge this one', async () => {
    const r = await rig();
    const db = cloudDb(r);
    db.prepare("INSERT OR IGNORE INTO suraus (id, name, created_at, created_by) VALUES ('kolej', 'Kolej', '2026-11-01T00:00:00.000Z', 'test')").run();
    const k = insertSite(db, { boxId: 'bbbb000000000002', surauId: 'kolej' });
    await phoneSave(r, { url: ADDRESS });
    // the other surau's box sees nothing and its acknowledgement changes nothing
    expect((await r.cloud.app.inject({ method: 'GET', url: RELAY, headers: k.headers })).statusCode).toBe(404);
    const ack = await r.cloud.app.inject({ method: 'POST', url: `${RELAY}/ack`, headers: k.headers, payload: { seq: 1, ok: false, code: 'error' } });
    expect(ack.json()).toEqual({ acknowledged: false });
    expect(((await get(r)).json() as { pending: boolean }).pending).toBe(true);
    // a person of the other surau has no box there (nothing linked, no key to seal to)
    const other = await loginAs(r.cloud.app, 'live', undefined, 'kolej');
    const view = await r.cloud.app.inject({ method: 'GET', url: ROUTE, headers: other.headers });
    expect(view.json()).toMatchObject({ configured: false, pending: false, relay: null });
    const sealed = sealToBox(r.publicJwk as never, '{}', relayAad(BOX_ID, 1));
    const sent = await r.cloud.app.inject({ method: 'PUT', url: ROUTE, headers: other.headers, payload: { boxId: BOX_ID, seq: 1, sealed } });
    expect(sent.statusCode).toBe(409);
    expect(sent.json().code).toBe('no_box');
    // a person and a kiosk-less call to the box routes: 404 / refused
    expect((await r.cloud.app.inject({ method: 'GET', url: RELAY, headers: r.admin })).statusCode).toBe(404);
    expect([401, 403]).toContain((await r.cloud.app.inject({ method: 'GET', url: RELAY })).statusCode);
    // the box this value is not for gets none either
    const second = insertSite(db, { boxId: 'cccc000000000003', surauId: 'sdm' });
    expect((await r.cloud.app.inject({ method: 'GET', url: RELAY, headers: second.headers })).statusCode).toBe(404);
  });

  it('a box refusal comes back as a short fixed code and the value is not applied', async () => {
    const r = await rig();
    await phoneSave(r, { url: 'rtsp://8.8.8.8:554/x', username: 'viewer', password: PASSWORD });
    expect(await r.sync.relayPoll()).toBe('refused');
    expect(storeOf(r)).toBeNull();
    const v = (await get(r)).json() as Record<string, unknown>;
    expect(v).toMatchObject({ pending: false, failure: 'bad_address' });
    expect(JSON.stringify(v)).not.toContain(PASSWORD);
    // the next change is numbered after the refused one
    expect((v.relay as { seq: number }).seq).toBe(2);
    expect((await phoneSave(r, { url: ADDRESS })).res.statusCode).toBe(200);
    expect(await r.sync.relayPoll()).toBe('applied');
  });

  it('clearing over the cloud queues a removal the box applies', async () => {
    const r = await rig();
    await phoneSave(r, { url: ADDRESS, username: 'viewer', password: PASSWORD });
    await r.sync.relayPoll();
    const del = await r.cloud.app.inject({ method: 'DELETE', url: ROUTE, headers: r.admin });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ pending: true });
    expect(await r.sync.relayPoll()).toBe('applied');
    expect(storeOf(r)).toBeNull();
    expect(await r.sync.push()).toBe('removed');
    expect((await get(r)).json()).toMatchObject({ configured: false, pending: false });
  });

  it('keeps the stored password when the phone sends the dots, and the test says it is at the surau only', async () => {
    const r = await rig();
    await phoneSave(r, { url: `rtsp://viewer:${PASSWORD}@10.168.1.20:554/main` });
    await r.sync.relayPoll();
    await phoneSave(r, { url: 'rtsp://viewer:••••••@10.168.1.20:554/main' });
    expect(await r.sync.relayPoll()).toBe('applied');
    expect(storeOf(r)?.url).toBe(`rtsp://viewer:${PASSWORD}@10.168.1.20:554/main`);

    const test = await r.cloud.app.inject({ method: 'POST', url: `${ROUTE}/test`, headers: r.admin, payload: {} });
    expect(test.statusCode).toBe(409);
    expect(test.json()).toMatchObject({ code: 'at_surau_only', errors: ['Uji kamera hanya di Wi-Fi surau.'] });
  });

  it('a person who may not change settings cannot queue a change; writes are rate limited', async () => {
    const r = await rig();
    const ajk = await loginAs(r.cloud.app, 'ajk');
    const denied = await r.cloud.app.inject({ method: 'PUT', url: ROUTE, headers: ajk.headers, payload: { boxId: BOX_ID, seq: 1, sealed: 'x' } });
    expect(denied.statusCode).toBe(403);
    const view = (await get(r)).json() as { relay: { key: Record<string, string> } };
    let limited = false;
    for (let i = 0; i < 14 && !limited; i++) {
      const sealed = sealToBox(view.relay.key, '{}', relayAad(BOX_ID, 1));
      limited = (await put(r, { boxId: BOX_ID, seq: 1, sealed: i === 0 ? sealed : sealed })).statusCode === 429;
    }
    expect(limited).toBe(true);
  });
});
