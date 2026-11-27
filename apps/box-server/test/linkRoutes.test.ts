import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, ROLES, parseBoxQr } from '@surau/core';
import type { Permission } from '@surau/core';
import { ROUTE_PERMISSIONS } from '../src/auth/authz.ts';
import { buildApp } from '../src/app.ts';
import { verifyLink } from '../src/link/sign.ts';
import type { PeerTransport } from '../src/link/session.ts';
import { loginAs } from './authHelpers.ts';
import { PIN, WRONG_PIN, createWorld, linkNewBox, until } from './support/twoBoxes.ts';
import type { TestBox, World } from './support/twoBoxes.ts';

vi.mock('../src/productVersion.ts', async (orig) => {
  const real = await orig<typeof import('../src/productVersion.ts')>();
  return { ...real, boxVersion: vi.fn(() => real.boxVersion()) };
});
import { boxVersion } from '../src/productVersion.ts';

let w: World;
beforeEach(() => {
  w = createWorld();
});
afterEach(async () => {
  await w.close();
});

const sessionOf = async (b: TestBox): Promise<Record<string, any> | null> =>
  // a box that was never set up has no admin: read its session directly
  b.admin === null ? (b.app.link!.sessions.view() as unknown as Record<string, any> | null) : ((await b.call('GET', '/api/link/status')).body.session as Record<string, any> | null);
const outcomeOf = (b: TestBox): string | null =>
  (b.app.surau.db.prepare("SELECT outcome FROM link_sessions WHERE kind = 'link' ORDER BY started_at DESC LIMIT 1").get()?.outcome as string | null | undefined) ?? null;
const rows = (b: TestBox, sql: string): Record<string, unknown>[] => b.app.surau.db.prepare(sql).all();

/** The world's box `n` (a box built by `makeBoxWith` is registered there like any other). */
const boxOf = (world: World, n: number): TestBox => [...world.boxes.values()].find((b) => b.n === n)!;

/**
 * A set-up box like `w.make(n)` but with extra `link` seams (the shared helper does not take any). It talks to the
 * other boxes through the same world: one box-to-box call is an `app.inject` from this box's own LAN address.
 */
async function makeBoxWith(world: World, n: number, extra: { planSetAside?: (linkId: string) => void }): Promise<TestBox> {
  const addr = `10.168.50.${10 + n}`;
  const origin = `https://${addr}:8443`;
  const ca = String(n % 10).repeat(64);
  const box = { n, origin, ca, addr, dir: null, restarts: 0, admin: null } as unknown as TestBox;
  const peer: PeerTransport = {
    async post(to, toCa, path, body) {
      world.calls.push({ from: origin, to, path, body: structuredClone(body) as Record<string, unknown> });
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
  box.app = buildApp(':memory:', { now: world.clock.now, link: { peer, origin, caSha256: ca, restart: () => { box.restarts += 1; }, ...extra } });
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

/** Case S, both boxes set up: `a` shows, `b` scans, `a` approves, both agree. */
async function runCaseS(a: TestBox, b: TestBox): Promise<void> {
  expect((await a.call('POST', '/api/link/show', { pin: PIN })).status).toBe(200);
  const payload = String((await a.tv()).body.qr.payload);
  expect((await b.call('POST', '/api/link/scan', { pin: PIN, qr: payload })).status).toBe(200);
  const ap = await a.call('POST', '/api/link/approve', { ok: true });
  expect(ap.status).toBe(200);
  const rev = ap.body.session.answers.rev;
  expect((await a.call('POST', '/api/link/agree', { rev })).status).toBe(200);
  expect((await b.call('POST', '/api/link/agree', { rev })).status).toBe(200);
}

describe('case S through the routes (both boxes set up)', () => {
  it('shows, scans, shows the same code, approves, agrees; today the commit fails because planSetAside is not wired', async () => {
    const a = await w.make(1);
    const b = await w.make(2);

    const show = await a.call('POST', '/api/link/show', { pin: PIN });
    expect(show.status).toBe(200);
    expect(show.body.shown.id).toMatch(/^[0-9a-f]{32}$/);
    // the QR text never goes to the phone
    expect(JSON.stringify(show.body)).not.toContain('maxcom1:');

    const tv = await a.tv();
    expect(tv.status).toBe(200);
    expect(tv.body.mode).toBe('main');
    const payload = String(tv.body.qr.payload);
    expect(parseBoxQr(payload).type).toBe('link');

    const scan = await b.call('POST', '/api/link/scan', { pin: PIN, qr: payload });
    expect(scan.status).toBe(200);
    const sb = scan.body.session;
    expect(sb.step).toBe('code');
    expect(sb.code).toMatch(/^\d{6}$/);
    expect((await sessionOf(a))!.code).toBe(sb.code);
    // the QR left the TV once it was used
    expect((await a.tv()).body.qr).toBeNull();
    expect((await a.tv()).body.code).toBe(sb.code);

    const approve = await a.call('POST', '/api/link/approve', { ok: true });
    expect(approve.status).toBe(200);
    expect(approve.body.session.step).toBe('questions');
    expect(approve.body.session.case).toBe('S');
    expect((await sessionOf(b))!.answers).toEqual(approve.body.session.answers);
    const rev = approve.body.session.answers.rev;

    expect((await a.call('POST', '/api/link/agree', { rev })).status).toBe(200);
    expect((await b.call('POST', '/api/link/agree', { rev })).status).toBe(200);
    await a.app.link!.work.idle();

    // Today: the follower holds a set-up store and `planSetAside` is not wired, so it refuses the commit.
    expect(outcomeOf(a)).toBe('failed');
    expect(rows(a, 'SELECT * FROM linked_boxes')).toHaveLength(0);
    // the device row made for the follower is kept for the log, but revoked: no usable token is left
    expect(rows(a, "SELECT * FROM devices WHERE platform = 'kiosk' AND revoked_at IS NULL")).toHaveLength(0);
    expect(rows(a, 'SELECT * FROM kiosk_cookies')).toHaveLength(0);
    expect(b.app.link!.follow.present()).toBe(false);
    expect(b.app.link!.follow.read()).toBeNull();
    expect(b.restarts).toBe(0);
    expect(a.restarts).toBe(0);
    // the master is free again
    expect(a.app.link!.sessions.writesBlocked()).toBe(false);
    expect((await a.call('PUT', '/api/settings/appLock', { enabled: true })).status).toBe(200);
  });

  it('case S ends linked on both boxes: the follower plans the set-aside of its store first, then writes the follow record and restarts', async () => {
    const a = await w.make(1);
    const planned: { linkId: string; followPresent: boolean }[] = [];
    const b = await makeBoxWith(w, 2, {
      planSetAside: (linkId) => {
        planned.push({ linkId, followPresent: boxOf(w, 2).app.link!.follow.present() });
      },
    });
    await runCaseS(a, b);
    await until(async () => {
      expect(outcomeOf(a)).toBe('linked');
      expect(outcomeOf(b)).toBe('linked');
    });
    await a.app.link!.work.idle();

    // the plan came once, with the link id, while there was still no follow record
    expect(planned).toHaveLength(1);
    expect(planned[0]!.linkId).toMatch(/^[0-9a-f]{32}$/);
    expect(planned[0]!.followPresent).toBe(false);

    const lb = rows(a, 'SELECT * FROM linked_boxes WHERE removed_at IS NULL');
    expect(lb).toHaveLength(1);
    expect(lb[0]!.box_id).toBe(b.app.surau.boxId);
    expect(lb[0]!.link_id).toBe(planned[0]!.linkId);
    const dev = rows(a, `SELECT * FROM devices WHERE id = '${String(lb[0]!.device_id)}'`)[0]!;
    expect(dev.platform).toBe('kiosk');
    expect(dev.revoked_at ?? null).toBeNull();
    expect(rows(a, `SELECT * FROM kiosk_cookies WHERE device_id = '${String(lb[0]!.device_id)}'`)).toHaveLength(1);

    const rec = b.app.link!.follow.read();
    expect(rec).not.toBeNull();
    expect(rec!.linkId).toBe(planned[0]!.linkId);
    expect(rec!.masterBoxId).toBe(a.app.surau.boxId);
    expect(rec!.deviceId).toBe(lb[0]!.device_id);
    expect(rec!.hadStore).toBe(true);
    await until(() => expect(b.restarts).toBe(1));
    expect(a.restarts).toBe(0);
    expect(a.app.link!.sessions.writesBlocked()).toBe(false);
  });

  it('case S: when the follower cannot plan the set-aside it refuses the commit; both end not linked, the master takes its rows back and the follower is free at once', async () => {
    const a = await w.make(1);
    const b = await makeBoxWith(w, 2, {
      planSetAside: () => {
        throw new Error('set-aside: other_volume');
      },
    });
    await runCaseS(a, b);
    await a.app.link!.work.idle();
    await until(() => expect(outcomeOf(a)).toBe('failed'));
    await until(() => expect(outcomeOf(b)).not.toBeNull());
    expect(outcomeOf(b)).not.toBe('linked');

    // the master's rows are gone and no usable token is left
    expect(rows(a, 'SELECT * FROM linked_boxes')).toHaveLength(0);
    expect(rows(a, "SELECT * FROM devices WHERE platform = 'kiosk' AND revoked_at IS NULL")).toHaveLength(0);
    expect(rows(a, 'SELECT * FROM kiosk_cookies')).toHaveLength(0);
    // the follower wrote nothing and did not restart
    expect(b.app.link!.follow.present()).toBe(false);
    expect(b.app.link!.follow.read()).toBeNull();
    await new Promise((r) => setTimeout(r, 900));
    expect(b.restarts).toBe(0);
    expect(a.restarts).toBe(0);
    // both are free again now, with no ten-minute wait
    expect(a.app.link!.sessions.writesBlocked()).toBe(false);
    expect(b.app.link!.sessions.writesBlocked()).toBe(false);
    expect(await sessionOf(b)).toBeNull();
    expect((await a.call('PUT', '/api/settings/appLock', { enabled: true })).status).toBe(200);
    expect((await b.call('PUT', '/api/settings/appLock', { enabled: true })).status).toBe(200);
  });

  it('B (the follower side) is left in step working after the failed commit; it frees itself only by its own timer', async () => {
    const a = await w.make(1);
    const b = await w.make(2);
    await a.call('POST', '/api/link/show', { pin: PIN });
    const payload = String((await a.tv()).body.qr.payload);
    await b.call('POST', '/api/link/scan', { pin: PIN, qr: payload });
    await a.call('POST', '/api/link/approve', { ok: true });
    await a.call('POST', '/api/link/agree', { rev: 1 });
    await b.call('POST', '/api/link/agree', { rev: 1 });
    await a.app.link!.work.idle();
    expect(outcomeOf(a)).toBe('failed');
    // Observed today, reported as a doubt: the follower is not told the commit failed.
    const s = await sessionOf(b);
    expect(s === null || s.outcome !== 'linked').toBe(true);
  });
});

describe('case N-S through the routes (box B never set up)', () => {
  it('the new box shows its own QR on its TV, the admin of A scans, approves, agrees once: linked', async () => {
    const a = await w.make(1);
    const b = await w.make(2, { setUp: false });

    const tv = await b.tv();
    expect(tv.status).toBe(200);
    expect(tv.body.mode).toBe('main');
    expect(tv.body.qr.payload).toMatch(/^maxcom1:/);
    const { qr } = await linkNewBox(a, b);
    expect(qr).toBe(tv.body.qr.payload);

    await until(async () => {
      expect(outcomeOf(a)).toBe('linked');
      expect(outcomeOf(b)).toBe('linked');
    });
    await a.app.link!.work.idle();

    const lb = rows(a, 'SELECT * FROM linked_boxes WHERE removed_at IS NULL');
    expect(lb).toHaveLength(1);
    expect(lb[0]!.box_id).toBe(b.app.surau.boxId);
    const dev = rows(a, `SELECT * FROM devices WHERE id = '${String(lb[0]!.device_id)}'`)[0]!;
    expect(dev.platform).toBe('kiosk');
    expect(dev.revoked_at ?? null).toBeNull();

    const rec = b.app.link!.follow.read();
    expect(rec).not.toBeNull();
    expect(rec!.masterBoxId).toBe(a.app.surau.boxId);
    expect(rec!.deviceId).toBe(lb[0]!.device_id);
    expect(rec!.hadStore).toBe(false);
    await until(() => expect(b.restarts).toBe(1));
    expect(a.restarts).toBe(0);

    const list = await a.call('GET', '/api/boxes');
    expect(list.status).toBe(200);
    expect(list.body.self.mode).toBe('main');
    expect(list.body.boxes).toHaveLength(1);
    expect(list.body.boxes[0].boxId).toBe(b.app.surau.boxId);
  });

  it('the follower token works as the kiosk cookie at the master; removing the box kills it and the order to forget is signed', async () => {
    const a = await w.make(1);
    const b = await w.make(2, { setUp: false });
    await linkNewBox(a, b);
    await until(() => expect(outcomeOf(a)).toBe('linked'));
    const rec = b.app.link!.follow.read()!;
    const cookie = { cookie: `surau_kiosk=${rec.token}` };

    const ok = await a.call('GET', '/api/kiosk/bundle', undefined, { as: null, from: b.addr, headers: cookie });
    expect(ok.status).toBe(200);
    const none = await a.call('GET', '/api/kiosk/bundle', undefined, { as: null, from: b.addr, headers: { cookie: `surau_kiosk=${'A'.repeat(43)}` } });
    expect(none.status).toBe(401);

    const ask = () => a.call('POST', '/api/link/peer/order', { boxId: b.app.surau.boxId, linkId: rec.linkId }, { as: null, from: b.addr });
    const before = await ask();
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ order: null });

    const del = await a.call('DELETE', `/api/boxes/${rec.deviceId}`);
    expect(del.status).toBe(200);
    const dead = await a.call('GET', '/api/kiosk/bundle', undefined, { as: null, from: b.addr, headers: cookie });
    expect([401, 403]).toContain(dead.status);

    const after = await ask();
    expect(after.status).toBe(200);
    expect(after.body.order).toBe('forget');
    expect(after.body.body).toEqual({ boxId: b.app.surau.boxId, linkId: rec.linkId, masterBoxId: a.app.surau.boxId });
    expect(verifyLink(rec.masterPub, 'order-forget', rec.linkId, after.body.body, after.body.sig)).toBe(true);
    // the order is for this link and this box only: another body does not verify
    expect(verifyLink(rec.masterPub, 'order-forget', rec.linkId, { ...after.body.body, boxId: '0'.repeat(16) }, after.body.sig)).toBe(false);
    expect(verifyLink(rec.masterPub, 'order-forget', '0'.repeat(32), after.body.body, after.body.sig)).toBe(false);

    // a second removal of the same box is harmless
    expect((await a.call('DELETE', `/api/boxes/${rec.deviceId}`)).status).toBe(200);
    expect((await a.call('DELETE', '/api/boxes/nosuchbox')).status).toBe(404);
  });

  it('the order route says not_found for an unknown box, a wrong link id, a malformed id and a LIKE trick', async () => {
    const a = await w.make(1);
    const b = await w.make(2, { setUp: false });
    await linkNewBox(a, b);
    await until(() => expect(outcomeOf(a)).toBe('linked'));
    const rec = b.app.link!.follow.read()!;
    const ask = (body: unknown) => a.call('POST', '/api/link/peer/order', body, { as: null, from: b.addr });
    for (const body of [
      { boxId: '1'.repeat(16), linkId: rec.linkId },
      { boxId: b.app.surau.boxId, linkId: 'f'.repeat(32) },
      { boxId: '%', linkId: rec.linkId },
      { boxId: '', linkId: rec.linkId },
      { boxId: b.app.surau.boxId, linkId: '%' },
      {},
    ]) {
      const r = await ask(body);
      expect(r.status, JSON.stringify(body)).toBe(404);
      expect(r.body.code).toBe('not_found');
    }
  });

  it('a follower answers 409 follower with the master name on session and admin routes, and still serves its TV', async () => {
    const a = await w.make(1);
    const b = await w.make(2, { setUp: false });
    await linkNewBox(a, b);
    await until(() => expect(outcomeOf(a)).toBe('linked'));
    const rec = b.app.link!.follow.read()!;
    const masterName = a.app.surau.db.prepare("SELECT value FROM meta WHERE key = 'box_name'").get()?.value ?? rec.masterName;
    expect(rec.masterName).toBe(masterName);

    // a public route reaches the gate even with no session
    const ch = await b.call('POST', '/api/auth/challenge', { deviceId: 'x' }, { as: null });
    expect(ch.status).toBe(409);
    expect(ch.body.code).toBe('follower');
    expect(ch.body.master).toEqual({ name: rec.masterName, boxId: a.app.surau.boxId, addresses: rec.addresses, caSha256: rec.masterCa });

    // a box that already had an admin and a follow record (the shape of a follower with an old store)
    const c = await w.make(3);
    c.app.link!.follow.write({ ...rec });
    for (const [method, url] of [['GET', '/api/settings'], ['GET', '/api/link/status'], ['POST', '/api/auth/challenge'], ['GET', '/api/boxes']] as const) {
      const r = await c.call(method, url, method === 'POST' ? { deviceId: 'x' } : undefined);
      expect(r.status, `${method} ${url}`).toBe(409);
      expect(r.body.code, url).toBe('follower');
      expect(r.body.master.name).toBe(rec.masterName);
    }
    // a write too
    expect((await c.call('PUT', '/api/settings/appLock', { enabled: false })).status).toBe(409);
    // its own TV and the info of the box are still answered
    const tvB = await b.tv();
    expect(tvB.status).toBe(200);
    expect(tvB.body.mode).toBe('follower');
    expect(tvB.body.master).toEqual({ name: rec.masterName });
    const info = await b.call('GET', '/api/box/info', undefined, { as: null });
    expect(info.status).toBe(200);
    const tvC = await c.tv();
    expect(tvC.body.mode).toBe('follower');
    // and a follower starts no session of its own
    const tvQr = await b.tv();
    expect(tvQr.body.qr).toBeNull();
  });
});

const WRITES: readonly { method: 'POST' | 'PUT'; url: string; payload: unknown }[] = [
  { method: 'POST', url: '/api/link/pin', payload: { pin: PIN } },
  { method: 'POST', url: '/api/link/show', payload: { pin: PIN } },
  { method: 'POST', url: '/api/link/scan', payload: { pin: PIN, qr: 'x' } },
  { method: 'POST', url: '/api/link/approve', payload: { ok: true } },
  { method: 'PUT', url: '/api/link/answers', payload: { keep: 'show', master: 'show', roles: {}, financeTick: false } },
  { method: 'POST', url: '/api/link/agree', payload: { rev: 1 } },
];

describe('LAN guard on the link routes', () => {
  it('every write from a public address is 403 lan_only, with and without a session', async () => {
    const a = await w.make(1);
    for (const x of WRITES) {
      const r = await a.call(x.method, x.url, x.payload, { from: '8.8.8.8' });
      expect(r.status, x.url).toBe(403);
      expect(r.body.code, x.url).toBe('lan_only');
      expect(r.body.errors).toEqual(['lan_only']);
    }
    const del = await a.call('DELETE', '/api/boxes/anything', undefined, { from: '8.8.8.8' });
    expect(del.status).toBe(403);
    expect(del.body.code).toBe('lan_only');
    // the box to box routes too
    for (const p of ['hello', 'message', 'order']) {
      const r = await a.call('POST', `/api/link/peer/${p}`, {}, { as: null, from: '8.8.8.8' });
      expect(r.status, p).toBe(403);
      expect(r.body.code).toBe('lan_only');
    }
    expect(rows(a, 'SELECT * FROM link_sessions')).toHaveLength(0);
  });

  it('the same from a private address with a proxy header is 403 lan_only', async () => {
    const a = await w.make(1);
    for (const h of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'via', 'cf-connecting-ip', 'cf-ray', 'true-client-ip']) {
      for (const x of WRITES) {
        const r = await a.call(x.method, x.url, x.payload, { headers: { [h]: '203.0.113.9' } });
        expect(r.status, `${h} ${x.url}`).toBe(403);
        expect(r.body.code).toBe('lan_only');
      }
      const del = await a.call('DELETE', '/api/boxes/anything', undefined, { headers: { [h]: '203.0.113.9' } });
      expect(del.status, h).toBe(403);
      expect(del.body.code).toBe('lan_only');
    }
    expect(rows(a, 'SELECT * FROM link_sessions')).toHaveLength(0);
  });

  it('a LAN address can start a session (the guard is not simply closed)', async () => {
    const a = await w.make(1);
    for (const addr of ['10.168.50.99', '10.1.2.3', '172.20.0.5', '169.254.7.7']) {
      const r = await a.call('POST', '/api/link/show', { pin: PIN }, { from: addr });
      expect(r.status, addr).toBe(200);
      await a.call('POST', '/api/link/cancel');
    }
  });

  it('cancel from a public address is 403 lan_only like every other write route', async () => {
    const a = await w.make(1);
    await a.call('POST', '/api/link/show', { pin: PIN });
    const r = await a.call('POST', '/api/link/cancel', {}, { from: '8.8.8.8' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('lan_only');
  });

  it('cancel from a private address with a proxy header is 403 lan_only', async () => {
    const a = await w.make(1);
    await a.call('POST', '/api/link/show', { pin: PIN });
    const r = await a.call('POST', '/api/link/cancel', {}, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('lan_only');
  });
});

describe('PIN and role', () => {
  it('show without a pin is 400 pin_required; a wrong pin is 401 wrong_pin; the right pin starts the session', async () => {
    const a = await w.make(1);
    const none = await a.call('POST', '/api/link/show', {});
    expect(none.status).toBe(400);
    expect(none.body.code).toBe('pin_required');
    const empty = await a.call('POST', '/api/link/show', { pin: '' });
    expect(empty.body.code).toBe('pin_required');
    const num = await a.call('POST', '/api/link/show', { pin: 482916 });
    expect(num.body.code).toBe('pin_required');
    const bad = await a.call('POST', '/api/link/show', { pin: WRONG_PIN });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('wrong_pin');
    expect(rows(a, 'SELECT * FROM link_sessions')).toHaveLength(0);
    expect((await a.call('POST', '/api/link/show', { pin: PIN })).status).toBe(200);
  });

  it('scan needs the pin too', async () => {
    const a = await w.make(1);
    const b = await w.make(2);
    await a.call('POST', '/api/link/show', { pin: PIN });
    const payload = String((await a.tv()).body.qr.payload);
    expect((await b.call('POST', '/api/link/scan', { qr: payload })).body.code).toBe('pin_required');
    expect((await b.call('POST', '/api/link/scan', { pin: WRONG_PIN, qr: payload })).body.code).toBe('wrong_pin');
    expect(rows(b, 'SELECT * FROM link_sessions')).toHaveLength(0);
    // the QR was not spent by the refused tries
    expect((await b.call('POST', '/api/link/scan', { pin: PIN, qr: payload })).status).toBe(200);
  });

  it('five wrong tries are counted and the next one meets the limiter (429), even with the right pin', async () => {
    const a = await w.make(1);
    const got: number[] = [];
    for (let i = 0; i < 5; i++) got.push((await a.call('POST', '/api/link/show', { pin: WRONG_PIN })).status);
    expect(got).toEqual([401, 401, 401, 401, 401]);
    const sixth = await a.call('POST', '/api/link/show', { pin: PIN });
    expect(sixth.status).toBe(429);
    expect(rows(a, 'SELECT * FROM link_sessions')).toHaveLength(0);
    // the limiter reads the wall clock (createLimiters() has no injected clock), so its window cannot be moved here
  });

  it('with the app lock off the signed-in admin on the LAN is the proof (no pin asked)', async () => {
    const a = await w.make(1, { appLock: false });
    const r = await a.call('POST', '/api/link/show', {});
    expect(r.status).toBe(200);
  });

  it('a role without devices:manage is refused 403 on every app route of the link and of the box list', async () => {
    const a = await w.make(1);
    const routes = ROUTE_PERMISSIONS.filter((r) => (r.sample.startsWith('/api/link/') || r.sample.startsWith('/api/boxes')) && r.permission !== 'public');
    expect(routes.length).toBeGreaterThanOrEqual(5);
    for (const r of routes) expect(r.permission, r.sample).toBe('devices:manage');
    const denied = ROLES.filter((r) => !(PERMISSIONS[r] as readonly Permission[]).includes('devices:manage'));
    expect(denied.length).toBeGreaterThan(0);
    for (const role of denied) {
      const login = await loginAs(a.app, role);
      for (const r of routes) {
        const res = await a.call(r.method as 'GET', r.sample, r.method === 'GET' || r.method === 'DELETE' ? undefined : {}, { as: login });
        expect(res.status, `${role} ${r.method} ${r.sample}`).toBe(403);
      }
    }
    // and an anonymous caller gets 401
    for (const r of routes) {
      const res = await a.call(r.method as 'GET', r.sample, undefined, { as: null });
      expect(res.status, `anon ${r.method} ${r.sample}`).toBe(401);
    }
    expect(rows(a, 'SELECT * FROM link_sessions')).toHaveLength(0);
  });

  it('agree with a PIN proof older than 15 minutes is refused pin_required; POST /api/link/pin renews it', async () => {
    const a = await w.make(1);
    const b = await w.make(2);
    await a.call('POST', '/api/link/show', { pin: PIN });
    const payload = String((await a.tv()).body.qr.payload);
    await b.call('POST', '/api/link/scan', { pin: PIN, qr: payload });
    const ap = await a.call('POST', '/api/link/approve', { ok: true });
    expect(ap.body.session.pinFresh).toBe(true);

    w.clock.tick(16 * 60_000);
    expect((await sessionOf(a))!.pinFresh).toBe(false);
    const stale = await a.call('POST', '/api/link/agree', { rev: 1 });
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('pin_required');
    expect((await sessionOf(a))!.ownAgreed).toBe(false);

    // renewing needs the right pin
    expect((await a.call('POST', '/api/link/pin', { pin: WRONG_PIN })).body.code).toBe('wrong_pin');
    expect((await a.call('POST', '/api/link/pin', {})).body.code).toBe('pin_required');
    const renew = await a.call('POST', '/api/link/pin', { pin: PIN });
    expect(renew.status).toBe(200);
    expect(renew.body.session.pinFresh).toBe(true);
    const ok = await a.call('POST', '/api/link/agree', { rev: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body.session.ownAgreed).toBe(true);
  });

  it('POST /api/link/pin without a session is 409 no_session', async () => {
    const a = await w.make(1);
    const r = await a.call('POST', '/api/link/pin', { pin: PIN });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('no_session');
  });
});

describe('writes are refused while the boxes link (409 linking)', () => {
  it('between the agreement and the end: other writes and cancel are refused, reads still work', async () => {
    const a = await w.make(1);
    const b = await w.make(2, { setUp: false });
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    w.hold = (c) => (c.path === '/api/link/peer/message' && c.body.step === 'commit' ? gate : undefined);

    await linkNewBox(a, b);
    await until(async () => expect((await sessionOf(a))!.step).toBe('working'));

    const put = await a.call('PUT', '/api/settings/appLock', { enabled: false });
    expect(put.status).toBe(409);
    expect(put.body.code).toBe('linking');
    const del = await a.call('DELETE', '/api/boxes/someone');
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('linking');
    expect((await a.call('GET', '/api/settings')).status).toBe(200);
    expect((await a.call('GET', '/api/link/status')).status).toBe(200);
    const cancel = await a.call('POST', '/api/link/cancel');
    expect(cancel.status).toBe(409);
    expect(cancel.body.code).toBe('linking');
    // the TV still answers
    expect((await a.tv()).status).toBe(200);
    expect(a.app.link!.sessions.writesBlocked()).toBe(true);

    release();
    await a.app.link!.work.idle();
    await until(() => expect(outcomeOf(a)).toBe('linked'));
    expect(a.app.link!.sessions.writesBlocked()).toBe(false);
    expect((await a.call('PUT', '/api/settings/appLock', { enabled: true })).status).toBe(200);
  });

  it('the follower side also refuses writes while it waits for the commit', async () => {
    const a = await w.make(1);
    const b = await w.make(2);
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    w.hold = (c) => (c.path === '/api/link/peer/message' && c.body.step === 'commit' ? gate : undefined);
    await a.call('POST', '/api/link/show', { pin: PIN });
    const payload = String((await a.tv()).body.qr.payload);
    await b.call('POST', '/api/link/scan', { pin: PIN, qr: payload });
    await a.call('POST', '/api/link/approve', { ok: true });
    await a.call('POST', '/api/link/agree', { rev: 1 });
    await b.call('POST', '/api/link/agree', { rev: 1 });
    await until(async () => expect((await sessionOf(b))!.step).toBe('working'));
    const put = await b.call('PUT', '/api/settings/appLock', { enabled: false });
    expect(put.status).toBe(409);
    expect(put.body.code).toBe('linking');
    expect((await b.call('POST', '/api/link/cancel')).body.code).toBe('linking');
    release();
    await a.app.link!.work.idle();
  });
});

describe('case X answers (phase 2B)', () => {
  it('PUT /api/link/answers with keep different from master is taken (case X), as a new revision on both boxes', async () => {
    const a = await w.make(1);
    const b = await w.make(2);
    await a.call('POST', '/api/link/show', { pin: PIN });
    const payload = String((await a.tv()).body.qr.payload);
    await b.call('POST', '/api/link/scan', { pin: PIN, qr: payload });
    await a.call('POST', '/api/link/approve', { ok: true });
    const r = await a.call('PUT', '/api/link/answers', { keep: 'scan', master: 'show', roles: {}, financeTick: false });
    expect(r.status).toBe(200);
    expect(r.body.session.case).toBe('X');
    expect(r.body.session.answers.rev).toBe(2);
    expect((await sessionOf(b))!.answers.keep).toBe('scan');
  });

  it('an answer that keeps and masters the same side is accepted and makes revision 2, which must be agreed again', async () => {
    const a = await w.make(1);
    const b = await w.make(2);
    await a.call('POST', '/api/link/show', { pin: PIN });
    const payload = String((await a.tv()).body.qr.payload);
    await b.call('POST', '/api/link/scan', { pin: PIN, qr: payload });
    await a.call('POST', '/api/link/approve', { ok: true });
    expect((await a.call('POST', '/api/link/agree', { rev: 1 })).status).toBe(200);
    const put = await a.call('PUT', '/api/link/answers', { keep: 'show', master: 'show', roles: {}, financeTick: false });
    expect(put.status).toBe(200);
    expect(put.body.session.answers.rev).toBe(2);
    expect(put.body.session.ownAgreed).toBe(false);
    // the old revision cannot be agreed any more
    expect((await a.call('POST', '/api/link/agree', { rev: 1 })).body.code).toBe('stale_revision');
    expect((await b.call('POST', '/api/link/agree', { rev: 1 })).body.code).toBe('stale_revision');
  });
});

describe('the box own TV', () => {
  it('a paired browser TV (cookie, not loopback) gets no QR and no code while the box shows one', async () => {
    const { pairTv } = await import('./support/pairTv.ts');
    const a = await w.make(1);
    await a.call('POST', '/api/link/show', { pin: PIN });
    const own = await a.tv();
    expect(own.body.qr.payload).toMatch(/^maxcom1:/);
    const tv = await pairTv(a.app, a.admin!);
    const r = await a.call('GET', '/api/kiosk/link', undefined, { as: null, from: '10.168.1.77', headers: { cookie: tv.cookie } });
    expect(r.status).toBe(200);
    expect(r.body.qr).toBeNull();
    expect(r.body.code).toBeNull();
    expect(r.body.step).toBeNull();
    expect(r.body.peer ?? null).toBeNull();
    expect(JSON.stringify(r.body)).not.toContain('maxcom1:');
    // a loopback request that carries a proxy header is not the box's own TV either
    const viaProxy = await a.app.inject({ method: 'GET', url: '/api/kiosk/link', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(JSON.stringify(viaProxy.json())).not.toContain('maxcom1:');
  });

  it('a set-up box shows no QR of its own until the admin asks; a never set up box shows one by itself and keeps it', async () => {
    const a = await w.make(1);
    expect((await a.tv()).body.qr).toBeNull();
    const n = await w.make(2, { setUp: false });
    const first = await n.tv();
    const again = await n.tv();
    expect(first.body.qr.payload).toBe(again.body.qr.payload);
    expect(first.body.step).toBe('qr');
  });
});

describe('scan failures', () => {
  it('a third box racing the scan: one wins, the other gets code_used; a replay of the spent QR gets code_used', async () => {
    const a = await w.make(1);
    const b = await w.make(2);
    const c = await w.make(3);
    await a.call('POST', '/api/link/show', { pin: PIN });
    const payload = String((await a.tv()).body.qr.payload);
    const [rb, rc] = await Promise.all([
      b.call('POST', '/api/link/scan', { pin: PIN, qr: payload }),
      c.call('POST', '/api/link/scan', { pin: PIN, qr: payload }),
    ]);
    const statuses = [rb.status, rc.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = rb.status === 409 ? rb : rc;
    expect(loser.body.code).toBe('code_used');
    const winner = rb.status === 200 ? b : c;
    expect((await sessionOf(winner))!.step).toBe('code');
    // the loser holds no open session
    const lb = rb.status === 409 ? b : c;
    expect(await sessionOf(lb)).toBeNull();
    // a replay of the same QR by the loser, later
    const replay = await lb.call('POST', '/api/link/scan', { pin: PIN, qr: payload });
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe('code_used');
    expect((await sessionOf(a))!.step).toBe('code');
  });

  it('a replay after the session ended is code_used', async () => {
    const a = await w.make(1);
    const b = await w.make(2);
    const c = await w.make(3);
    await a.call('POST', '/api/link/show', { pin: PIN });
    const payload = String((await a.tv()).body.qr.payload);
    expect((await b.call('POST', '/api/link/scan', { pin: PIN, qr: payload })).status).toBe(200);
    await a.call('POST', '/api/link/cancel');
    const replay = await c.call('POST', '/api/link/scan', { pin: PIN, qr: payload });
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe('code_used');
  });

  it('an expired QR is refused code_expired', async () => {
    const a = await w.make(1);
    const b = await w.make(2);
    await a.call('POST', '/api/link/show', { pin: PIN });
    const payload = String((await a.tv()).body.qr.payload);
    w.clock.tick(6 * 60_000);
    const r = await b.call('POST', '/api/link/scan', { pin: PIN, qr: payload });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('code_expired');
    expect(await sessionOf(b)).toBeNull();
    // and the TV no longer shows it
    expect((await a.tv()).body.qr).toBeNull();
  });

  it('a damaged or foreign QR is bad_qr; the box scanning its own QR is refused', async () => {
    const a = await w.make(1);
    const b = await w.make(2);
    await a.call('POST', '/api/link/show', { pin: PIN });
    const payload = String((await a.tv()).body.qr.payload);
    expect((await b.call('POST', '/api/link/scan', { pin: PIN, qr: 'hello' })).body.code).toBe('bad_qr');
    expect((await b.call('POST', '/api/link/scan', { pin: PIN, qr: payload.slice(0, -4) + 'AAAA' })).body.code).toBe('bad_qr');
    expect((await b.call('POST', '/api/link/scan', { pin: PIN, qr: 12 })).body.code).toBe('bad_qr');
    expect((await a.call('POST', '/api/link/scan', { pin: PIN, qr: payload })).body.code).toMatch(/^(same_box|session_open)$/);
  });

  it('a second show while one is open is session_open', async () => {
    const a = await w.make(1);
    await a.call('POST', '/api/link/show', { pin: PIN });
    const again = await a.call('POST', '/api/link/show', { pin: PIN });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('session_open');
  });

  it('five failed attempts in an hour lock the box: link_locked', async () => {
    const a = await w.make(1);
    for (let i = 0; i < 5; i++) {
      a.app.surau.db.prepare(
        "INSERT INTO link_sessions (id, kind, role, own_hello_json, step, started_at, expires_at, finished_at, outcome) VALUES (?, 'link', 'show', '{}', 'done', ?, ?, ?, 'rejected')",
      ).run(`f${i}`.padEnd(32, '0'), w.clock.now().toISOString(), w.clock.now().toISOString(), w.clock.now().toISOString());
    }
    w.clock.tick(1000);
    const r = await a.call('POST', '/api/link/show', { pin: PIN });
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('link_locked');
  });

  it('rejecting at the box that showed the QR ends both sessions: rejected and rejected_by_peer', async () => {
    const a = await w.make(1);
    const b = await w.make(2);
    await a.call('POST', '/api/link/show', { pin: PIN });
    const payload = String((await a.tv()).body.qr.payload);
    await b.call('POST', '/api/link/scan', { pin: PIN, qr: payload });
    const r = await a.call('POST', '/api/link/approve', { ok: false });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('rejected');
    expect(outcomeOf(a)).toBe('rejected');
    expect(outcomeOf(b)).toBe('rejected_by_peer');
    expect(await sessionOf(a)).toBeNull();
    expect(await sessionOf(b)).toBeNull();
  });

  it('the wrong side cannot approve: the scanning box of two set-up boxes gets wrong_side', async () => {
    const a = await w.make(1);
    const b = await w.make(2);
    await a.call('POST', '/api/link/show', { pin: PIN });
    const payload = String((await a.tv()).body.qr.payload);
    await b.call('POST', '/api/link/scan', { pin: PIN, qr: payload });
    const r = await b.call('POST', '/api/link/approve', { ok: true });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('wrong_side');
  });
});

describe('version of the two boxes', () => {
  it('a box one release behind is refused with code version and says which side is behind', async () => {
    const a = await w.make(1);
    const b = await w.make(2);
    const real = (await vi.importActual<typeof import('../src/productVersion.ts')>('../src/productVersion.ts')).boxVersion();
    const older = real.replace(/\d+$/, (d) => String(Math.max(0, Number(d) - 1)));
    expect(older).not.toBe(real);
    const mock = vi.mocked(boxVersion);
    // ownHelloOf reads the version once per hello: A at show, B at scan
    mock.mockReturnValueOnce(real);
    await a.call('POST', '/api/link/show', { pin: PIN });
    mock.mockReturnValueOnce(older);
    const payload = String((await a.tv()).body.qr.payload);
    const r = await b.call('POST', '/api/link/scan', { pin: PIN, qr: payload });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('version');
    expect(r.body.behind).toBe('scan');
    expect(outcomeOf(a)).toBe('version');
    expect(await sessionOf(b)).toBeNull();
  });
});

describe('restart in the middle of a link', () => {
  it('a follower that reached the agreement without a commit ends the session failed at the next start and its writes are free', async () => {
    const a = await w.make(1);
    const b = await w.make(2, { setUp: false, persist: true });
    w.hold = (c) => (c.path === '/api/link/peer/message' && c.body.step === 'commit' ? new Promise<void>(() => undefined) : undefined);
    await linkNewBox(a, b);
    await until(async () => expect((await sessionOf(b))!.step).toBe('working'));
    expect(b.app.link!.sessions.writesBlocked()).toBe(true);

    await b.app.close();
    const b2 = w.reopen(b);
    expect(b2.app.link!.sessions.writesBlocked()).toBe(false);
    b2.app.link!.sessions.recover();
    const row = b2.app.surau.db.prepare('SELECT step, outcome FROM link_sessions ORDER BY started_at DESC LIMIT 1').get()!;
    expect(row.outcome).toBe('failed');
    expect(row.step).toBe('done');
    expect(b2.app.link!.follow.present()).toBe(false);
    expect(b2.app.link!.sessions.current()).toBeNull();
    // the box shows a fresh QR again (it is still not set up)
    expect((await b2.tv()).body.qr.payload).toMatch(/^maxcom1:/);
  });

  it('a session before the agreement ends as restart', async () => {
    const a = await w.make(1, { persist: true });
    await a.call('POST', '/api/link/show', { pin: PIN });
    expect((await sessionOf(a))!.step).toBe('qr');
    await a.app.close();
    const a2 = w.reopen(a);
    const row = a2.app.surau.db.prepare('SELECT outcome FROM link_sessions ORDER BY started_at DESC LIMIT 1').get()!;
    expect(row.outcome).toBe('restart');
    expect(await sessionOf(a2)).toBeNull();
    expect((await a2.tv()).body.qr).toBeNull();
  });
});
