import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTENT_KINDS, klInstant } from '@surau/core';
import type { Role } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { revokeDevice } from '../src/auth/devices.ts';
import { OP_PERMISSIONS, verifyDeviceOp, verifySiteEntry } from '../src/sync/verify.ts';
import { loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { signOp } from './support/signOp.ts';
import type { OpInput } from './support/signOp.ts';

const AT = klInstant('2026-11-03', '12:00');
const apps: FastifyInstance[] = [];
const dirs: string[] = [];

function makeApp(): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-syncverify-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'), { now: () => AT });
  apps.push(app);
  return app;
}

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CONTENT: OpInput = { kind: 'content.put', entity: 'content:penceramah', entityId: 'p1', payload: { name: 'Ustaz A' } };

function logRows(app: FastifyInstance): Record<string, unknown>[] {
  return app.surau.db.prepare("SELECT * FROM auth_log WHERE event = 'sync_refused' ORDER BY id").all();
}

async function setup(role: Role | Role[] = 'admin'): Promise<{ app: FastifyInstance; login: Login }> {
  const app = makeApp();
  return { app, login: await loginAs(app, role) };
}

describe('verifyDeviceOp', () => {
  it('accepts a correctly signed op from a live device whose user holds the permission now', async () => {
    const { app, login } = await setup('admin');
    const op = await signOp(login, app.surau.boxId, CONTENT);
    const r = verifyDeviceOp(app.surau.db, op, AT, { boxId: app.surau.boxId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.permissions).toEqual(['content:write', 'assets:write']);
      expect(r.op.userName).toMatch(/^Test admin/);
    }
    expect(logRows(app)).toHaveLength(0);
  });

  it('a flipped signature byte is bad_signature and writes one log row without the signature', async () => {
    const { app, login } = await setup();
    const op = await signOp(login, app.surau.boxId, CONTENT);
    const raw = Buffer.from(op.sig, 'base64url');
    raw[10]! ^= 1;
    const bad = { ...op, sig: raw.toString('base64url') };
    const r = verifyDeviceOp(app.surau.db, bad, AT, { boxId: app.surau.boxId }, '10.0.0.9');
    expect(r).toMatchObject({ ok: false, reason: 'bad_signature' });
    const rows = logRows(app);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: 0, detail: 'bad_signature', device_id: login.deviceId, user_id: login.userId, ip: '10.0.0.9' });
    expect(JSON.stringify(rows)).not.toContain(bad.sig);
  });

  it('a signature made over other content (tampered payload), by another device, or by a malformed string is refused', async () => {
    const { app, login } = await setup();
    const other = await loginAs(app, 'admin');
    const op = await signOp(login, app.surau.boxId, CONTENT);
    const server = { boxId: app.surau.boxId };
    expect(verifyDeviceOp(app.surau.db, { ...op, payload: { name: 'Ustaz B' } }, AT, server)).toMatchObject({ reason: 'bad_signature' });
    const foreign = await signOp(other, app.surau.boxId, { ...CONTENT, deviceId: login.deviceId, userId: login.userId });
    expect(verifyDeviceOp(app.surau.db, foreign, AT, server)).toMatchObject({ reason: 'bad_signature' });
    expect(verifyDeviceOp(app.surau.db, { ...op, sig: 'AAAA' }, AT, server)).toMatchObject({ reason: 'bad_signature' });
    expect(logRows(app)).toHaveLength(3);
  });

  it('refuses a foreign box id or surau id (a replay from another box), a malformed shape, and unknown fields', async () => {
    const { app, login } = await setup();
    const server = { boxId: app.surau.boxId };
    const wrongBox = await signOp(login, app.surau.boxId, { ...CONTENT, boxId: 'deadbeefdeadbeef' });
    expect(verifyDeviceOp(app.surau.db, wrongBox, AT, server)).toMatchObject({ ok: false, reason: 'invalid', detail: 'box_mismatch' });
    const wrongSurau = await signOp(login, app.surau.boxId, { ...CONTENT, surauId: 'lain' });
    expect(verifyDeviceOp(app.surau.db, wrongSurau, AT, server)).toMatchObject({ ok: false, reason: 'invalid', detail: 'surau_mismatch' });
    const good = await signOp(login, app.surau.boxId, CONTENT);
    expect(verifyDeviceOp(app.surau.db, { ...good, extra: 1 }, AT, server)).toMatchObject({ reason: 'invalid' });
    expect(verifyDeviceOp(app.surau.db, { ...good, opId: 'short' }, AT, server)).toMatchObject({ reason: 'invalid' });
    expect(verifyDeviceOp(app.surau.db, { ...good, v: 2 }, AT, server)).toMatchObject({ reason: 'invalid' });
    expect(verifyDeviceOp(app.surau.db, { ...good, kind: 'nuke' }, AT, server)).toMatchObject({ reason: 'invalid' });
    expect(verifyDeviceOp(app.surau.db, 'text', AT, server)).toMatchObject({ reason: 'invalid' });
    expect(verifyDeviceOp(app.surau.db, null, AT, server)).toMatchObject({ reason: 'invalid' });
    expect(logRows(app)).toHaveLength(8);
  });

  it('an unknown device is device_unknown; a device of another user is device_unknown', async () => {
    const { app, login } = await setup();
    const other = await loginAs(app, 'admin');
    const server = { boxId: app.surau.boxId };
    const ghost = await signOp(login, app.surau.boxId, { ...CONTENT, deviceId: 'no-such-device' });
    expect(verifyDeviceOp(app.surau.db, ghost, AT, server)).toMatchObject({ reason: 'device_unknown' });
    const swapped = await signOp(login, app.surau.boxId, { ...CONTENT, userId: other.userId });
    expect(verifyDeviceOp(app.surau.db, swapped, AT, server)).toMatchObject({ reason: 'device_unknown', detail: 'user_mismatch' });
  });

  it('a revoked device is device_revoked even with a valid signature; one log row per op', async () => {
    const { app, login } = await setup();
    const ops = await Promise.all([1, 2, 3].map((i) => signOp(login, app.surau.boxId, { ...CONTENT, entityId: `p${i}` })));
    revokeDevice(app.surau.db, login.deviceId, 'test');
    for (const op of ops) {
      expect(verifyDeviceOp(app.surau.db, op, AT, { boxId: app.surau.boxId })).toMatchObject({ ok: false, reason: 'device_revoked' });
    }
    const rows = logRows(app);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toMatchObject({ detail: 'device_revoked', device_id: login.deviceId, ok: 0 });
  });

  it('an inactive user is user_inactive', async () => {
    const { app, login } = await setup();
    const op = await signOp(login, app.surau.boxId, CONTENT);
    app.surau.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(login.userId);
    expect(verifyDeviceOp(app.surau.db, op, AT, { boxId: app.surau.boxId })).toMatchObject({ reason: 'user_inactive' });
  });

  it('the permission is read from the role tables now, never from the op: every kind against every role', async () => {
    const app = makeApp();
    const server = { boxId: app.surau.boxId };
    const who: Record<string, Login> = {};
    for (const r of ['admin', 'treasurer', 'media', 'ajk'] as Role[]) who[r] = await loginAs(app, r);
    const kinds: Record<string, OpInput> = {
      'content.put': CONTENT,
      'content.delete': { kind: 'content.delete', entity: 'content:penceramah', entityId: 'p1', payload: null },
      'asset.put': { kind: 'asset.put', entity: 'asset', entityId: 'a', payload: { mime: 'image/png', bytesBase64: 'AA==' } },
      'settings.put': { kind: 'settings.put', entity: 'settings', entityId: 'clock', payload: { show24h: true } },
      'user.put': { kind: 'user.put', entity: 'user', entityId: 'u9', payload: { name: 'X', roles: ['ajk'] } },
      'device.revoke': { kind: 'device.revoke', entity: 'device', entityId: 'd9', payload: null },
      'audit.put': { kind: 'audit.put', entity: 'audit', entityId: 's1', payload: { event: 'recording/deleted', sessionId: 's1', videoIds: [], bytes: 0 } },
    };
    const holds: Record<string, string[]> = {
      'content.put': ['admin', 'media'],
      'content.delete': ['admin', 'media'],
      'asset.put': ['admin', 'media'],
      'settings.put': ['admin'],
      'user.put': ['admin'],
      'device.revoke': ['admin'],
      'audit.put': ['admin', 'media'],
    };
    for (const [kind, input] of Object.entries(kinds)) {
      expect(OP_PERMISSIONS[kind as keyof typeof OP_PERMISSIONS].length).toBeGreaterThan(0);
      for (const [role, login] of Object.entries(who)) {
        const op = await signOp(login, app.surau.boxId, input);
        const r = verifyDeviceOp(app.surau.db, op, AT, server);
        if (holds[kind]!.includes(role)) expect(r.ok, `${kind} as ${role}`).toBe(true);
        else expect(r, `${kind} as ${role}`).toMatchObject({ ok: false, reason: 'forbidden' });
      }
    }
  });
});

describe('verifySiteEntry', () => {
  const site = { boxId: 'boxaaaaaaaaaaaa', surauId: 'sdm' };
  const entry = {
    seq: 1,
    entity: 'content:penceramah',
    entityId: 'p1',
    rev: '2026-11-03T03:00:00.000Z|local',
    editedAt: '2026-11-03T03:00:00.000Z',
    syncedAt: '2026-11-03T03:00:00.000Z',
    actor: 'user:u1',
    deviceId: null,
    origin: 'local',
    opId: null,
    after: { id: 'p1', name: 'A' },
  };

  it('accepts a plain entry and the site own origin', () => {
    expect(verifySiteEntry(site, {}, entry).ok).toBe(true);
    expect(verifySiteEntry(site, {}, { ...entry, origin: 'box:boxaaaaaaaaaaaa' }).ok).toBe(true);
    expect(verifySiteEntry(site, {}, { ...entry, origin: 'app' }).ok).toBe(true);
  });

  it('accepts every content kind, including the camelCase ones', () => {
    for (const kind of CONTENT_KINDS) {
      expect(verifySiteEntry(site, {}, { ...entry, entity: `content:${kind}` }).ok, kind).toBe(true);
    }
  });

  it('still refuses a content entity outside the token shape', () => {
    for (const entity of ['content:', 'content:a b', 'content:a/b', 'content:a.b', `content:${'a'.repeat(41)}`, 'Content:worldTime']) {
      expect(verifySiteEntry(site, {}, { ...entry, entity }), entity).toMatchObject({ ok: false, detail: 'bad_entity' });
    }
  });

  it('refuses another surau, a foreign box origin, an echo of the cloud, a bad entity, extra fields and bad ids', () => {
    expect(verifySiteEntry({ ...site, surauId: 'lain' }, {}, entry)).toMatchObject({ ok: false, detail: 'surau_mismatch' });
    expect(verifySiteEntry(site, {}, { ...entry, origin: 'box:other' })).toMatchObject({ ok: false, detail: 'foreign_origin' });
    expect(verifySiteEntry(site, {}, { ...entry, origin: 'cloud' })).toMatchObject({ ok: false, detail: 'echo' });
    expect(verifySiteEntry(site, {}, { ...entry, entity: 'auth' })).toMatchObject({ ok: false, detail: 'bad_entity' });
    expect(verifySiteEntry(site, {}, { ...entry, entity: 'live' })).toMatchObject({ ok: false });
    expect(verifySiteEntry(site, {}, { ...entry, extra: 1 })).toMatchObject({ ok: false, detail: 'bad_shape' });
    expect(verifySiteEntry(site, {}, { ...entry, actor: 'x y\n' })).toMatchObject({ ok: false, detail: 'bad_shape' });
    expect(verifySiteEntry(site, {}, { ...entry, opId: 'nope' })).toMatchObject({ ok: false, detail: 'bad_shape' });
    expect(verifySiteEntry(site, {}, null)).toMatchObject({ ok: false });
  });
});
